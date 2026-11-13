import { parseDevelopmentServerConfig } from "@/services/api/config";
import type {
  AssistantRecoveryCleanupEvidence,
  AssistantRecoveryCleanupFacts,
  AssistantRecoveryMetadata,
} from "@/types/assistant-recovery";
import {
  isAssistantUuidV4,
  parseAssistantRequestCreate,
  parseAssistantRequestStatusResponse,
} from "@/utils/assistant-validation";

// 현재 설정과 같은 origin 기반 식별값이다. DB 초기화·서버 세대를 구분하는 증거는 아니다.
export function isAssistantRecoveryServerId(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("development:")) return false;
  const parsed = parseDevelopmentServerConfig(value.slice("development:".length));
  return parsed.status === "ready" && parsed.config.serverId === value;
}

export function isAssistantRecoveryTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseAssistantRecoveryMetadata(value: unknown): AssistantRecoveryMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const required = ["serverId", "requestId", "firstPostAttemptAt", "lastPostAttemptAt", "acceptConfirmed"];
  const optional = ["conversationId", "lastStatus", "lastResultKind"];
  if (!required.every((key) => Object.hasOwn(entry, key)) ||
    !Object.keys(entry).every((key) => required.includes(key) || optional.includes(key)) ||
    !isAssistantRecoveryServerId(entry.serverId) || !isAssistantUuidV4(entry.requestId) ||
    !isAssistantRecoveryTimestamp(entry.firstPostAttemptAt) || !isAssistantRecoveryTimestamp(entry.lastPostAttemptAt)) return null;
  const base = { serverId: entry.serverId, requestId: entry.requestId.toLowerCase(),
    firstPostAttemptAt: entry.firstPostAttemptAt, lastPostAttemptAt: entry.lastPostAttemptAt };
  if (entry.acceptConfirmed === false) {
    return optional.every((key) => !Object.hasOwn(entry, key)) ? { ...base, acceptConfirmed: false } : null;
  }
  if (entry.acceptConfirmed !== true || !Object.hasOwn(entry, "conversationId") ||
    !Object.hasOwn(entry, "lastStatus") || !isAssistantUuidV4(entry.conversationId)) return null;
  const confirmed = { ...base, acceptConfirmed: true as const, conversationId: entry.conversationId.toLowerCase() };
  if (entry.lastStatus === "accepted" || entry.lastStatus === "processing") {
    return !Object.hasOwn(entry, "lastResultKind") ? { ...confirmed, lastStatus: entry.lastStatus } : null;
  }
  if (entry.lastStatus === "completed" && Object.hasOwn(entry, "lastResultKind") &&
    typeof entry.lastResultKind === "string" &&
    ["need_more_info", "candidate_selection", "confirmation", "outcome", "failure", "uncertain"].includes(entry.lastResultKind)) {
    return { ...confirmed, lastStatus: "completed", lastResultKind: entry.lastResultKind as Extract<AssistantRecoveryMetadata, { lastStatus: "completed" }>["lastResultKind"] };
  }
  return null;
}

// 늦은 응답으로 완료 상태를 되돌리지 않는다. uncertain의 확정 전환만 예외로 허용한다.
export function mergeAssistantRecoveryMetadata(metadata: AssistantRecoveryMetadata, observation: AssistantRecoveryMetadata): AssistantRecoveryMetadata | null {
  const previous = parseAssistantRecoveryMetadata(metadata);
  const received = parseAssistantRecoveryMetadata(observation);
  if (!previous || !received?.acceptConfirmed || previous.serverId !== received.serverId || previous.requestId !== received.requestId ||
    (previous.acceptConfirmed && previous.conversationId !== received.conversationId)) return null;
  if (previous.acceptConfirmed) {
    if (previous.lastStatus === "completed") {
      if (received.lastStatus !== "completed") return previous;
      if (previous.lastResultKind !== received.lastResultKind && !(previous.lastResultKind === "uncertain" &&
        (received.lastResultKind === "outcome" || received.lastResultKind === "failure"))) return null;
    } else if (previous.lastStatus === "processing" && received.lastStatus === "accepted") return previous;
  }
  return { ...received, firstPostAttemptAt: previous.firstPostAttemptAt, lastPostAttemptAt: previous.lastPostAttemptAt };
}

// 공개 DTO를 검증한 뒤 최소 메타데이터만 투영한다. 응답 전문은 반환하거나 저장하지 않는다.
export function applyAssistantRecoveryResponse(metadata: AssistantRecoveryMetadata, response: unknown): AssistantRecoveryMetadata | null {
  const previous = parseAssistantRecoveryMetadata(metadata);
  const received = parseAssistantRequestStatusResponse(response);
  if (!previous || !received) return null;
  const base = { serverId: previous.serverId, requestId: previous.requestId,
    firstPostAttemptAt: previous.firstPostAttemptAt, lastPostAttemptAt: previous.lastPostAttemptAt,
    acceptConfirmed: true as const, conversationId: received.conversationId.toLowerCase() };
  if (previous.requestId !== received.requestId.toLowerCase()) return null;
  return mergeAssistantRecoveryMetadata(previous, received.status === "completed"
    ? { ...base, lastStatus: "completed", lastResultKind: received.result.kind }
    : { ...base, lastStatus: received.status });
}

export function prepareAssistantRecoveryCleanupEvidence(evidence: AssistantRecoveryCleanupEvidence): AssistantRecoveryCleanupFacts | null {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  switch (evidence.type) {
    case "result-displayed": return { type: evidence.type };
    case "question-inactive-confirmed":
      return ["answered", "cancelled", "expired", "not_active"].includes(evidence.reason) ? { type: evidence.type, reason: evidence.reason } : null;
    case "unconfirmed":
      return ["polling-stopped", "request-not-found", "network", "timeout", "server-mismatch", "unknown-error"].includes(evidence.reason)
        ? { type: evidence.type, reason: evidence.reason } : null;
    case "request-expired":
      if (evidence.code !== "REQUEST_EXPIRED") return null;
      if (evidence.method === "GET" && evidence.httpStatus === 410) return { type: evidence.type, method: "GET", httpStatus: 410, code: evidence.code };
      if (evidence.method === "POST" && evidence.httpStatus === 409) return { type: evidence.type, method: "POST", httpStatus: 409, code: evidence.code };
      return null;
    case "next-input-accepted": {
      if (evidence.httpStatus !== 200 && evidence.httpStatus !== 202) return null;
      const request = parseAssistantRequestCreate(evidence.request);
      const response = parseAssistantRequestStatusResponse(evidence.response);
      if (!request || !response || request.requestId.toLowerCase() !== response.requestId.toLowerCase() ||
        (request.conversationId !== undefined && request.conversationId.toLowerCase() !== response.conversationId.toLowerCase()) ||
        (evidence.httpStatus === 202 && response.status !== "accepted")) return null;
      return { type: evidence.type, requestId: request.requestId.toLowerCase(), conversationId: request.conversationId?.toLowerCase(),
        inputType: request.input.type, questionId: request.input.questionId?.toLowerCase(),
        acknowledgedUncertainRequestId: request.acknowledgedUncertainRequestId?.toLowerCase(),
        responseConversationId: response.conversationId.toLowerCase(), responseStatus: response.status, httpStatus: evidence.httpStatus };
    }
    default: return null;
  }
}

export function canRemoveAssistantRecovery(
  metadata: AssistantRecoveryMetadata,
  currentServerId: string,
  evidence: AssistantRecoveryCleanupFacts,
  replacement?: AssistantRecoveryMetadata,
): boolean {
  const entry = parseAssistantRecoveryMetadata(metadata);
  if (!entry || entry.serverId !== currentServerId || !evidence || typeof evidence !== "object") return false;
  if (evidence.type === "request-expired") {
    return evidence.code === "REQUEST_EXPIRED" &&
      ((evidence.method === "GET" && evidence.httpStatus === 410) || (evidence.method === "POST" && evidence.httpStatus === 409));
  }
  if (!entry.acceptConfirmed || entry.lastStatus !== "completed") return false;
  if (evidence.type === "result-displayed") return entry.lastResultKind === "outcome" || entry.lastResultKind === "failure";
  const question = ["need_more_info", "candidate_selection", "confirmation"].includes(entry.lastResultKind);
  if (evidence.type === "question-inactive-confirmed") {
    return question && ["answered", "cancelled", "expired", "not_active"].includes(evidence.reason);
  }
  if (evidence.type !== "next-input-accepted" || ![200, 202].includes(evidence.httpStatus)) return false;
  const saved = parseAssistantRecoveryMetadata(replacement);
  if (!saved?.acceptConfirmed || saved.serverId !== entry.serverId || saved.requestId === entry.requestId ||
    saved.requestId !== evidence.requestId || saved.conversationId !== evidence.responseConversationId ||
    (evidence.conversationId !== undefined && evidence.conversationId !== evidence.responseConversationId) ||
    (evidence.httpStatus === 202 && evidence.responseStatus !== "accepted")) return false;
  if (question) {
    return evidence.conversationId === entry.conversationId && isAssistantUuidV4(evidence.questionId);
  }
  return entry.lastResultKind === "uncertain" && evidence.inputType === "text" &&
    evidence.questionId === undefined && evidence.acknowledgedUncertainRequestId === entry.requestId;
}
