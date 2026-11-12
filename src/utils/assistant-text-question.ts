import type { AssistantExecutionResult } from "@/services/api/assistant-orchestrator";
import type { AssistantRequestStatusResponse, AssistantResult } from "@/types/assistant-api";

type Source = "request" | "recovery";
type Observation = {
  requestId: string;
  conversationId: string;
  status: AssistantRequestStatusResponse["status"];
  questionId?: string;
  resultKind?: AssistantResult["kind"];
  expiresAt?: string;
  candidateIds?: readonly string[];
  source: Source;
};
export type AssistantTextQuestion = Pick<Observation, "requestId" | "conversationId"> & { questionId: string };
export type AssistantConfirmationQuestion = AssistantTextQuestion & { serverId: string; expiresAt: string };
export type AssistantCandidateQuestion = AssistantConfirmationQuestion & { candidateIds: readonly string[] };

// 화면 실행 세션의 질문 식별값만 관리한다. 요청 본문·채팅·영속 복구 정보는 저장하지 않는다.
export function createAssistantTextQuestionContext(serverId: string, generation: number) {
  const observations = new Map<string, Observation>();
  const replaced = new Set<string>();
  const invalidQuestions = new Set<string>();
  const startedRequests = new Set<string>();
  const blockedQuestions = new Set<string>();
  const selections = new Map<string, string>();
  const confirmations = new Map<string, boolean>();
  const activeProofs = new Set<string>();
  const expiredConversations = new Set<string>();
  let currentRequestId: string | undefined;
  let pending: { requestId: string; question?: AssistantTextQuestion; candidateId?: string; approved?: boolean } | undefined;

  function beginRequest(requestId: string, question?: AssistantTextQuestion, candidateId?: string, approved?: boolean) {
    pending = { requestId: requestId.toLowerCase(), question, candidateId, approved };
    startedRequests.add(pending.requestId);
    if (question && candidateId !== undefined) selections.set(question.requestId.toLowerCase(), candidateId);
    if (question && approved !== undefined) confirmations.set(question.requestId.toLowerCase(), approved);
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
      ...(data.status === "completed" && (data.result.kind === "need_more_info" || data.result.kind === "candidate_selection" || data.result.kind === "confirmation")
        ? { questionId: data.result.questionId } : {}),
      ...(data.status === "completed" && (data.result.kind === "candidate_selection" || data.result.kind === "confirmation") ? {
        // 같은 질문을 GET으로 다시 받아도 최초 만료 시각보다 늘리지 않는다.
        expiresAt: previous?.questionId?.toLowerCase() === data.result.questionId.toLowerCase() && previous.expiresAt &&
          Date.parse(previous.expiresAt) < Date.parse(data.result.expiresAt) ? previous.expiresAt : data.result.expiresAt,
        ...(data.result.kind === "candidate_selection" ? { candidateIds: data.result.candidates.map(candidate => candidate.candidateId) } : {}),
      } : {}),
    });
  }

  function observeExecution(execution: AssistantExecutionResult, source: Source, answering?: AssistantTextQuestion) {
    if (execution.reference.serverId !== serverId) return;
    if (execution.kind === "needs-attention") {
      const recovery = execution.recoveryResult;
      const post = recovery?.kind === "unconfirmed" ? recovery.postResult : undefined;
      const problem = post && !post.ok ? post.error.problem : undefined;
      const code = problem?.code;
      const conversationId = answering?.conversationId ?? (post && !post.ok ? post.error.conversationId : undefined);
      if (conversationId && (code === "CONVERSATION_EXPIRED" || code === "CONVERSATION_BUSY" ||
        code === "STALE_QUESTION" && !problem?.activeQuestionId && !problem?.activeQuestionRequestId)) {
        // 활성 질문 없음·대화 만료·진행 중 작업에서 과거 GET 질문을 다시 활성화하지 않는다.
        if (code === "CONVERSATION_EXPIRED") expiredConversations.add(conversationId.toLowerCase());
        for (const [key, value] of observations) if (value.conversationId.toLowerCase() === conversationId.toLowerCase()) {
          replaced.add(key); invalidQuestions.delete(key);
          if (currentRequestId === key) currentRequestId = undefined;
        }
      }
      if (pending?.requestId === execution.reference.requestId.toLowerCase() &&
        (pending.candidateId !== undefined || pending.approved !== undefined) && answering) {
        // 접수 여부가 미확인인 선택·확인을 새 ID로 다시 보내지 않는다. 미전송·확정 거절만 명시적 재시도 가능하다.
        const rejected = post && !post.ok && (post.error.requestState === "not-sent" || post.error.kind === "http");
        if (!rejected) blockedQuestions.add(answering.requestId.toLowerCase());
      }
      if (source === "recovery" && recovery?.kind === "unconfirmed" && recovery.getResult) {
        blockedQuestions.add(execution.reference.requestId.toLowerCase());
      }
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
      : [...observations.entries()].filter(([key, value]) => !replaced.has(key) &&
        !expiredConversations.has(value.conversationId.toLowerCase())).map(([, value]) => value);
    const questions = candidates.filter((value): value is Observation & { questionId: string } =>
      value?.resultKind === "need_more_info" && value.questionId !== undefined && !invalidQuestions.has(value.requestId.toLowerCase()) &&
      !expiredConversations.has(value.conversationId.toLowerCase()));
    const interactions = candidates.filter(value => value && !expiredConversations.has(value.conversationId.toLowerCase()) &&
      (value.resultKind === "candidate_selection" || value.resultKind === "confirmation"));
    // 여러 과거 GET 결과의 순서로 활성 질문을 추측하지 않는다. 상세 질문 복구는 후속 작업에서 처리한다.
    if (questions.length + interactions.length > 1) return "ambiguous";
    // 후보·확인에 일반 text를 보내거나 새 대화로 우회하지 않는다.
    if (interactions.length > 0) return "unsupported";
    if (!currentRequestId && questions.length === 0 && invalidQuestions.size > 0) return "unavailable";
    const question = questions[0];
    // GET에 남아 있는 질문의 현재 유효성은 후속 POST에서 서버가 최종 검사한다.
    return question && { requestId: question.requestId, conversationId: question.conversationId, questionId: question.questionId };
  }

  function getTimedQuestion(now: number, kind: "candidate_selection" | "confirmation"): Observation | undefined {
    if (!currentRequestId || !(startedRequests.has(currentRequestId) || activeProofs.has(currentRequestId)) || replaced.has(currentRequestId) ||
      invalidQuestions.has(currentRequestId) || blockedQuestions.has(currentRequestId)) return;
    const value = observations.get(currentRequestId);
    // 과거 GET 질문만으로는 서버 재시작 이후의 활성 여부를 증명할 수 없다.
    if (!value || expiredConversations.has(value.conversationId.toLowerCase()) || value.resultKind !== kind || !value.questionId || !value.expiresAt ||
      !Number.isFinite(now) || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now) return;
    return value;
  }

  function getConfirmationQuestion(now: number): AssistantConfirmationQuestion | undefined {
    const value = getTimedQuestion(now, "confirmation");
    return value?.questionId && value.expiresAt ? { serverId, requestId: value.requestId, conversationId: value.conversationId,
      questionId: value.questionId, expiresAt: value.expiresAt } : undefined;
  }

  function getCandidateQuestion(now: number): AssistantCandidateQuestion | undefined {
    const value = getTimedQuestion(now, "candidate_selection");
    return value?.questionId && value.expiresAt && value.candidateIds ? { serverId, requestId: value.requestId,
      conversationId: value.conversationId, questionId: value.questionId, expiresAt: value.expiresAt, candidateIds: value.candidateIds } : undefined;
  }

  function getRecoveryToken(): string {
    return JSON.stringify([currentRequestId, pending?.requestId, [...replaced], [...invalidQuestions], [...blockedQuestions],
      [...expiredConversations], [...activeProofs], [...observations].map(([key, value]) => [key, { ...value, source: undefined }])]);
  }

  function restoreActiveQuestion(execution: AssistantExecutionResult, proof: { requestId: string; questionId: string;
    conversationId: string }, token: string, now: number): boolean {
    if (token !== getRecoveryToken() || execution.kind !== "completed" || execution.reference.serverId !== serverId ||
      execution.response.serverId !== serverId || execution.reference.requestId.toLowerCase() !== proof.requestId.toLowerCase()) return false;
    const data = execution.response.data, result = data.result, key = data.requestId.toLowerCase();
    if (key !== proof.requestId.toLowerCase() || replaced.has(key) || expiredConversations.has(data.conversationId.toLowerCase()) ||
      data.conversationId.toLowerCase() !== proof.conversationId.toLowerCase() ||
      !["need_more_info", "candidate_selection", "confirmation"].includes(result.kind) || !("questionId" in result) ||
      result.questionId.toLowerCase() !== proof.questionId.toLowerCase() ||
      "expiresAt" in result && Date.parse(result.expiresAt) <= now) return false;
    const previous = observations.get(key);
    if (previous?.questionId?.toLowerCase() === result.questionId.toLowerCase() && previous.expiresAt &&
      Date.parse(previous.expiresAt) <= now) return false;
    // 오류의 활성 ID와 같은 대화의 검증된 GET을 함께 확인한 경우에만 명시적 답변을 허용한다.
    currentRequestId = key; activeProofs.add(key); invalidQuestions.delete(key); blockedQuestions.delete(key);
    observeResponse(data, "recovery");
    return true;
  }

  return { serverId, generation, beginRequest, observeResponse, observeExecution, getQuestion, getCandidateQuestion,
    getConfirmationQuestion, getRecoveryToken, restoreActiveQuestion,
    getSelections: (): Readonly<Record<string, string>> => Object.fromEntries(selections),
    getConfirmations: (): Readonly<Record<string, boolean>> => Object.fromEntries(confirmations),
    getExpiredConfirmations: (now: number): readonly string[] => [...observations.entries()]
      .filter(([, value]) => value.resultKind === "confirmation" && value.expiresAt && Date.parse(value.expiresAt) <= now)
      .map(([key]) => key) };
}
