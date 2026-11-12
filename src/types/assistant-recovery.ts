import type {
  AssistantRequestAcceptedResponse,
  AssistantRequestCreate,
  AssistantInput,
  AssistantRequestStatus,
  AssistantRequestStatusResponse,
  AssistantResult,
} from "@/types/assistant-api";

export type AssistantRecoveryReference = { serverId: string; requestId: string };

// 시간은 epoch milliseconds다. body·채팅·응답 전문·질문 상세는 저장하지 않는다.
export type AssistantRecoveryMetadata = AssistantRecoveryReference & {
  firstPostAttemptAt: number;
  lastPostAttemptAt: number;
} & (
  | { acceptConfirmed: false; conversationId?: never; lastStatus?: never; lastResultKind?: never }
  | ({ acceptConfirmed: true; conversationId: string } & (
      | { lastStatus: "accepted" | "processing"; lastResultKind?: never }
      | { lastStatus: "completed"; lastResultKind: AssistantResult["kind"] }
    ))
);

export type AssistantRecoveryResponse = AssistantRequestAcceptedResponse | AssistantRequestStatusResponse;

// 정리에 필요한 확인 사실을 호출자가 전달한다. GET의 질문 결과만으로 비활성을 추정하지 않는다.
// next-input-accepted는 새 입력 POST의 200/202 확인이며 GET 응답이 아니다.
// 해당 DTO는 메모리에서만 검증하고 저장하지 않는다.
export type AssistantRecoveryCleanupEvidence =
  | { type: "result-displayed" }
  | { type: "question-inactive-confirmed"; reason: "answered" | "cancelled" | "expired" | "not_active" }
  | { type: "next-input-accepted"; httpStatus: 200 | 202;
      request: AssistantRequestCreate; response: AssistantRecoveryResponse }
  | { type: "request-expired"; method: "GET"; httpStatus: 410; code: "REQUEST_EXPIRED" }
  | { type: "request-expired"; method: "POST"; httpStatus: 409; code: "REQUEST_EXPIRED" }
  | { type: "unconfirmed"; reason: "polling-stopped" | "request-not-found" | "network" | "timeout" | "server-mismatch" | "unknown-error" };

export type AssistantRecoveryCleanupResult = "removed" | "retained" | "not-found";

// 정리 작업이 큐를 기다릴 때에는 body·응답 전문 대신 이 확인 사실만 유지한다.
export type AssistantRecoveryCleanupFacts = Exclude<AssistantRecoveryCleanupEvidence, { type: "next-input-accepted" }> |
  { type: "next-input-accepted"; requestId: string; conversationId?: string;
    inputType: AssistantInput["type"]; questionId?: string; acknowledgedUncertainRequestId?: string;
    responseConversationId: string; responseStatus: AssistantRequestStatus; httpStatus: 200 | 202 };
