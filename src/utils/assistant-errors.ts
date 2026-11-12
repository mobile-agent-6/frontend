import type { AssistantHttpError } from "@/services/api/assistant";
import type { AssistantExecutionResult } from "@/services/api/assistant-orchestrator";

export type AssistantErrorRecoveryNotice = { targetRequestId: string; kind: "question" | "blocking" | "uncertain";
  status: "checking" | "restored" | "observed" | "mismatch" | "unconfirmed" | "busy" | "context-changed";
  result?: AssistantExecutionResult };
export const assistantErrorRecoveryNotice = (notice: AssistantErrorRecoveryNotice): string => ({
  checking: "기존 요청을 한 번 조회하고 있어요.",
  restored: "현재 질문을 확인했어요. 복구된 질문에서 다시 답해 주세요.",
  observed: "기존 요청의 상태를 확인했어요. 표시된 상태와 결과를 확인해 주세요.",
  mismatch: "현재 활성 질문을 확인하지 못했어요. 이전 선택이나 승인을 다시 보내지 말고 질문 확인이 필요해요.",
  unconfirmed: "기존 요청을 조회하지 못했어요. 처리 실패로 확정하지 않았으며 결과 확인이 필요해요.",
  busy: "기존 조회가 진행 중이에요. 중복 조회하지 않았으며 현재 결과 확인이 필요해요.",
  "context-changed": "질문 상태가 바뀌어 이전 복구 결과를 적용하지 않았어요. 현재 질문을 확인해 주세요.",
})[notice.status];

// 사용자 안내는 구조화된 code만 사용한다. detail·내부 JSON·모델 출력은 해석하거나 노출하지 않는다.
export function getAssistantExecutionError(execution: AssistantExecutionResult): AssistantHttpError | undefined {
  if (execution.kind !== "needs-attention" || execution.recoveryResult?.kind !== "unconfirmed") return;
  const { getResult, postResult } = execution.recoveryResult;
  if (getResult && !getResult.ok) return getResult.error;
  if (postResult && !postResult.ok) return postResult.error;
}

export function assistantHttpErrorNotice(error: AssistantHttpError): string {
  if (error.kind !== "http") {
    switch (error.kind) {
      case "timeout": return "응답 대기 시간이 끝났어요. 서버 처리 여부는 아직 확인이 필요해요.";
      case "network": return "서버에 연결하지 못했어요. 원래 요청의 결과 확인이 필요해요.";
      case "response": return "서버 응답 형식을 확인하지 못했어요. 원래 요청의 결과 확인이 필요해요.";
      case "storage": return error.requestState === "not-sent" && error.operation === "post"
        ? "복구 정보를 저장하지 못해 요청을 전송하지 않았어요. 저장 상태를 확인해 주세요."
        : "복구 정보를 읽거나 갱신하지 못했어요. 원래 요청의 확인이 필요해요.";
      case "server-mismatch": case "context-changed": return "서버 설정이 바뀌어 요청을 확인하지 못했어요. 원래 서버 설정을 확인해 주세요.";
      case "aborted": return "앱에서 확인을 중단했어요. 서버 취소가 아니며 원래 요청의 결과 확인이 필요해요.";
      case "policy": return "현재 실행 모드에서는 요청을 보낼 수 없어요. 설정을 확인해 주세요.";
      case "configuration": return "Assistant 서버 설정을 확인해 주세요. 설정에서 주소를 연결 확인하고 저장해 주세요.";
      default: return "요청을 보내지 못했어요. 입력 형식을 확인해 주세요.";
    }
  }
  switch (error.problem?.code) {
    case "MALFORMED_REQUEST": return "요청 형식이 올바르지 않아요. 입력을 확인하고 다시 작성해 주세요.";
    case "REQUEST_BODY_TOO_LARGE": return "요청 크기는 UTF-8 기준 16 KiB 이하여야 해요. 입력을 줄여 주세요.";
    case "VALIDATION_ERROR": return "입력 값이나 형식이 올바르지 않아요. 입력 내용을 수정해 주세요.";
    case "REQUEST_ID_CONFLICT": return "같은 요청 ID에 다른 내용이 연결돼 있어요. 원래 요청의 상태 확인이 필요해요.";
    case "CONVERSATION_BUSY": return "이미 처리 중인 작업이 있어요. 기존 요청의 상태 확인이 필요해요.";
    case "STALE_QUESTION": return error.problem.activeQuestionId || error.problem.activeQuestionRequestId
      ? "현재 질문이 바뀌었어요. 현재 질문을 확인한 뒤 다시 답해 주세요."
      : "이전 질문은 더 이상 유효하지 않아요. 새 요청을 입력해 주세요.";
    case "QUESTION_EXPIRED": return "질문의 응답 기한이 지났어요. 이전 질문 대신 새 요청을 입력해 주세요.";
    case "CONVERSATION_EXPIRED": return "대화가 만료됐어요. 이전 대화에 답하지 않고 새 요청을 입력해 주세요.";
    case "REQUEST_EXPIRED": return error.operation === "get"
      ? "요청 결과의 상세 보관 기간이 지났어요. 이전 성공·실패는 알 수 없어요. 일정 목록에서 확인해 주세요."
      : "이 요청 ID는 다시 접수할 수 없어요. 결과 상세 보관 기간이 지났으며 이전 성공·실패는 알 수 없어요. 일정 목록에서 확인해 주세요.";
    case "ASSISTANT_REQUEST_NOT_FOUND": return "요청 기록을 찾지 못했어요. 미실행을 뜻하지 않으며 원래 요청의 결과 확인이 필요해요.";
    case "ASSISTANT_CONVERSATION_NOT_FOUND": return "대화 기록을 찾지 못했어요. 대화와 서버 설정을 확인해 주세요.";
    case "ASSISTANT_TARGET_NOT_FOUND": return "취소 대상 기록을 찾지 못했어요. 대상 ID와 대화 소속을 확인해 주세요.";
    case "ROUTE_NOT_FOUND": return "Assistant API 경로를 찾지 못했어요. 서버 설정과 API 지원 여부를 확인해 주세요.";
    case "ASSISTANT_UNAVAILABLE": return "일정 비서 서비스를 지금 사용할 수 없어요. 나중에 다시 확인해 주세요. 수동 일정 관리는 계속 사용할 수 있어요.";
    case "DATABASE_UNAVAILABLE": return "데이터베이스에 일시적인 문제가 있어요. 나중에 원래 요청의 상태를 확인해 주세요.";
    case "INTERNAL_ERROR": return "서버 오류가 발생했어요. 원래 요청의 결과 확인이 필요해요.";
    case "UNRESOLVED_UNCERTAIN": return "결과가 확인되지 않은 작업 때문에 새 작업이 보류됐어요. 원래 요청의 확인과 명시적 위험 인지가 필요해요.";
    case "ACKNOWLEDGEMENT_NOT_APPLICABLE": return "지정한 요청을 불확실 결과 인지 대상으로 사용할 수 없어요. 보류 해제는 확인되지 않았어요.";
    default: return "요청 결과를 확인하지 못했어요. 원래 요청의 확인이 필요해요.";
  }
}

export const assistantFailureAdvice = (action: "revise_input" | "retry_later" | "none"): string => ({
  revise_input: "입력 내용을 수정한 뒤 다시 요청해 주세요.",
  retry_later: "나중에 다시 요청해 주세요. 이전 작업을 자동으로 다시 실행하지 않아요.",
  none: "오류가 발생했어요. 요청 결과를 확인해 주세요.",
})[action];

export function getAssistantErrorRecoveryTarget(execution: AssistantExecutionResult, acknowledgedId?: string) {
  const error = getAssistantExecutionError(execution);
  if (error?.kind !== "http" || error.operation !== "post" || error.status !== 409) return;
  const problem = error.problem;
  if (problem?.code === "STALE_QUESTION" && problem.activeQuestionRequestId) {
    return { kind: "question" as const, requestId: problem.activeQuestionRequestId, questionId: problem.activeQuestionId ?? undefined };
  }
  if (problem?.code === "CONVERSATION_BUSY" && problem.blockingRequestId) {
    return { kind: "blocking" as const, requestId: problem.blockingRequestId };
  }
  if (problem?.code === "UNRESOLVED_UNCERTAIN" && problem.blockingRequestId) {
    return { kind: "uncertain" as const, requestId: problem.blockingRequestId };
  }
  if (problem?.code === "ACKNOWLEDGEMENT_NOT_APPLICABLE" && (problem.blockingRequestId || acknowledgedId)) {
    return { kind: "uncertain" as const, requestId: problem.blockingRequestId ?? acknowledgedId! };
  }
}
