import type { AssistantExecutionEvent, AssistantExecutionResult } from "@/services/api/assistant-orchestrator";
import type { AssistantRecoveryCleanupEvidence, AssistantRecoveryReference } from "@/types/assistant-recovery";
import type { AssistantRequestCreate } from "@/types/assistant-api";
import type { AssistantTextQuestion } from "@/utils/assistant-text-question";
import { getAssistantExecutionError } from "@/utils/assistant-errors";
import { prepareAssistantRecoveryCleanupEvidence } from "@/utils/assistant-recovery";
import { parseAssistantCancelResponse } from "@/utils/assistant-validation";

export const assistantRecoveryKey = (reference: AssistantRecoveryReference) =>
  JSON.stringify([reference.serverId, reference.requestId.toLowerCase()]);

export type AssistantRecoveryCleanupPhase = "confirming" | "working" | "removed" | "not-found" | "retained" | "failed";
export type AssistantRecoveryControl = {
  reference: AssistantRecoveryReference;
  phase?: AssistantRecoveryCleanupPhase;
  resultConfirmable: boolean;
  expiryConfirmable: boolean;
  executionToken?: string;
};
export type AssistantRecoveryControlAction = "result" | "expiry" | "manual" | "confirm-manual" | "keep";

// GET 접수 증거와 실제 POST 응답을 구별한다. 원래 질문 ID도 일치해야 교체 정리를 제안한다.
export function assistantAcceptedCleanup(request: AssistantRequestCreate, event: AssistantExecutionEvent,
  question?: AssistantTextQuestion): { reference: AssistantRecoveryReference; evidence: AssistantRecoveryCleanupEvidence }[] {
  if (event.phase !== "status" || !["initial-post", "resend"].includes(event.via ?? "") ||
    event.response.serverId !== event.reference.serverId ||
    event.reference.requestId.toLowerCase() !== request.requestId.toLowerCase() ||
    (event.response.status !== 200 && event.response.status !== 202)) return [];
  const evidence: AssistantRecoveryCleanupEvidence = { type: "next-input-accepted", httpStatus: event.response.status,
    request, response: event.response.data };
  if (!prepareAssistantRecoveryCleanupEvidence(evidence)) return [];
  const targets: string[] = [];
  if (question && request.conversationId?.toLowerCase() === question.conversationId.toLowerCase() &&
    request.input.questionId?.toLowerCase() === question.questionId.toLowerCase()) targets.push(question.requestId);
  if (request.input.type === "text" && !request.input.questionId && request.acknowledgedUncertainRequestId)
    targets.push(request.acknowledgedUncertainRequestId);
  return [...new Set(targets.map(id => id.toLowerCase()))].map(requestId => ({
    reference: { serverId: event.reference.serverId, requestId }, evidence,
  }));
}

export function assistantRequestExpiryEvidence(execution: AssistantExecutionResult): AssistantRecoveryCleanupEvidence | undefined {
  const error = getAssistantExecutionError(execution);
  if (error?.kind !== "http" || error.problem?.code !== "REQUEST_EXPIRED" ||
    error.serverId !== execution.reference.serverId ||
    (error.assistantRequestId && error.assistantRequestId.toLowerCase() !== execution.reference.requestId.toLowerCase())) return;
  if (error.operation === "get" && error.status === 410)
    return { type: "request-expired", method: "GET", httpStatus: 410, code: "REQUEST_EXPIRED" };
  if (error.operation === "post" && error.status === 409)
    return { type: "request-expired", method: "POST", httpStatus: 409, code: "REQUEST_EXPIRED" };
}

// 취소 응답의 의미만 반환한다. question ID를 request ID로 바꾸거나 GET·정리·취소를 실행하지 않는다.
export function interpretAssistantCancelResponse(value: unknown) {
  const response = parseAssistantCancelResponse(value);
  if (!response) return null;
  return { ...response,
    requestCancelled: response.target.type === "request" && response.targetState === "cancelled",
    questionInactive: response.target.type === "question" && ["cancelled", "not_active"].includes(response.targetState),
    requiresRequestLookup: ["not_guaranteed", "uncertain"].includes(response.targetState),
    targetAlreadyCompleted: response.targetState === "already_completed",
  };
}
