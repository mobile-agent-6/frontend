import type { AssistantExecutionResult } from "@/services/api/assistant-orchestrator";
import type { AssistantRequestStatusResponse, AssistantResult } from "@/types/assistant-api";

type Source = "request" | "recovery";
type Observation = {
  requestId: string;
  conversationId: string;
  status: AssistantRequestStatusResponse["status"];
  questionId?: string;
  resultKind?: AssistantResult["kind"];
  source: Source;
};
export type AssistantTextQuestion = Pick<Observation, "requestId" | "conversationId"> & { questionId: string };

// 화면 실행 세션의 질문 식별값만 관리한다. 요청 본문·채팅·영속 복구 정보는 저장하지 않는다.
export function createAssistantTextQuestionContext(serverId: string, generation: number) {
  const observations = new Map<string, Observation>();
  const replaced = new Set<string>();
  const invalidQuestions = new Set<string>();
  let currentRequestId: string | undefined;
  let pending: { requestId: string; question?: AssistantTextQuestion } | undefined;

  function beginRequest(requestId: string, question?: AssistantTextQuestion) {
    pending = { requestId: requestId.toLowerCase(), question };
  }

  function observeResponse(data: AssistantRequestStatusResponse, source: Source, answering?: AssistantTextQuestion) {
    const key = data.requestId.toLowerCase();
    if (replaced.has(key)) return;
    if (source === "request" || pending?.requestId === key) {
      // 후속 입력이 실제로 접수된 뒤에만 이전 질문을 교체한다. 조회 실패로 되살리지 않는다.
      const previousQuestion = answering ?? (pending?.requestId === key ? pending.question : undefined);
      if (previousQuestion) replaced.add(previousQuestion.requestId.toLowerCase());
      if (currentRequestId && currentRequestId !== key) replaced.add(currentRequestId);
      currentRequestId = key;
    }
    const previous = observations.get(key);
    if (previous?.status === "completed" && (data.status !== "completed" ||
      previous.source === "recovery" && source === "request")) return;
    if (previous?.status === "processing" && data.status === "accepted") return;
    observations.set(key, {
      requestId: data.requestId, conversationId: data.conversationId, status: data.status, source,
      ...(data.status === "completed" ? { resultKind: data.result.kind } : {}),
      ...(data.status === "completed" && data.result.kind === "need_more_info" ? { questionId: data.result.questionId } : {}),
    });
  }

  function observeExecution(execution: AssistantExecutionResult, source: Source, answering?: AssistantTextQuestion) {
    if (execution.reference.serverId !== serverId) return;
    if (execution.kind === "needs-attention") {
      const recovery = execution.recoveryResult;
      const post = recovery?.kind === "unconfirmed" ? recovery.postResult : undefined;
      const problem = post && !post.ok ? post.error.problem : undefined;
      const code = problem?.code;
      // 거절된 질문을 새 대화로 바꾸거나 오류의 activeQuestionId만으로 답변을 재전송하지 않는다.
      if (answering && code && ["STALE_QUESTION", "QUESTION_EXPIRED", "CONVERSATION_EXPIRED"].includes(code)) {
        const key = answering.requestId.toLowerCase();
        // 현재 질문이 따로 있으면 실제 결과 복구까지 기다린다. 만료·활성 질문 없음은 다음 명시적 새 입력을 허용한다.
        if (code === "STALE_QUESTION" && (problem?.activeQuestionId || problem?.activeQuestionRequestId)) invalidQuestions.add(key);
        else replaced.add(key);
        currentRequestId = undefined;
      }
      return;
    }
    if (execution.response.data.requestId.toLowerCase() !== execution.reference.requestId.toLowerCase()) return;
    observeResponse(execution.response.data, source, answering);
  }

  function getQuestion(): AssistantTextQuestion | "ambiguous" | "unavailable" | "unsupported" | undefined {
    const candidates = currentRequestId ? [observations.get(currentRequestId)]
      : [...observations.entries()].filter(([key]) => !replaced.has(key)).map(([, value]) => value);
    const questions = candidates.filter((value): value is Observation & { questionId: string } =>
      value?.questionId !== undefined && !invalidQuestions.has(value.requestId.toLowerCase()));
    const interactions = candidates.filter(value => value?.resultKind === "candidate_selection" || value?.resultKind === "confirmation");
    // 여러 과거 GET 결과의 순서로 활성 질문을 추측하지 않는다. 상세 질문 복구는 후속 작업에서 처리한다.
    if (questions.length + interactions.length > 1) return "ambiguous";
    // 후보·확인에 일반 text를 보내거나 새 대화로 우회하지 않는다. 실제 전송은 작업 6-B·6-C의 책임이다.
    if (interactions.length > 0) return "unsupported";
    if (!currentRequestId && questions.length === 0 && invalidQuestions.size > 0) return "unavailable";
    const question = questions[0];
    // GET에 남아 있는 질문의 현재 유효성은 후속 POST에서 서버가 최종 검사한다.
    return question && { requestId: question.requestId, conversationId: question.conversationId, questionId: question.questionId };
  }

  return { serverId, generation, beginRequest, observeResponse, observeExecution, getQuestion };
}
