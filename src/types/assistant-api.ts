import type { ProblemDetails, ValidationErrorItem } from "@/services/api/http";
import type { ScheduleApiCategory, ScheduleUpdateInput } from "@/types/schedule";

// 공개 HTTP DTO. 화면/Mock의 AssistantStatus·AssistantInteraction과 별개다.
// UUID·날짜·길이 제약은 순수 runtime validator에서 검사한다.
export type AssistantInputText = { type: "text"; text: string; questionId?: string };
export type AssistantInputSelection = { type: "selection"; questionId: string; candidateId: string };
export type AssistantInputConfirmation = { type: "confirmation"; questionId: string; approved: boolean };
export type AssistantInput = AssistantInputText | AssistantInputSelection | AssistantInputConfirmation;

export type AssistantRequestCreate = {
  requestId: string;
  conversationId?: string;
  input: AssistantInput;
  acknowledgedUncertainRequestId?: string;
};

export type AssistantRequestStatus = "accepted" | "processing" | "completed";
export type AssistantRequestAcceptedResponse = {
  requestId: string;
  conversationId: string;
  status: "accepted";
};

export type AssistantCandidate = {
  candidateId: string;
  title: string;
  scheduledAt: string;
  category: ScheduleApiCategory;
};

export type AssistantScheduleSummary = {
  id: string;
  title: string;
  scheduledAt: string;
  category: ScheduleApiCategory;
  completed: boolean;
  updatedAt: string;
};

export type AssistantConfirmationChanges = ScheduleUpdateInput & (
  | { title: string }
  | { scheduledAt: string }
  | { category: ScheduleApiCategory }
  | { completed: boolean }
);

export type AssistantResultNeedMoreInfo = {
  kind: "need_more_info";
  text: string;
  questionId: string;
};
export type AssistantResultCandidateSelection = {
  kind: "candidate_selection";
  text: string;
  questionId: string;
  expiresAt: string;
  candidates: AssistantCandidate[];
};
export type AssistantConfirmationOperation = "update" | "delete";
export type AssistantResultConfirmation = {
  kind: "confirmation";
  text: string;
  questionId: string;
  expiresAt: string;
  target: AssistantScheduleSummary;
} & (
  | { operation: "update"; changes: AssistantConfirmationChanges }
  | { operation: "delete"; changes?: never }
);

export type AssistantOutcome = "success" | "cancelled" | "no_match";
export type AssistantOutcomeOperation = "create" | "list" | "update" | "delete";
export type AssistantResultOutcome = { kind: "outcome"; text: string } & (
  | { outcome: "success"; operation: "create" | "update" | "delete";
      schedulesChanged: true; affectedScheduleIds: [string]; items?: never }
  | { outcome: "success"; operation: "list"; schedulesChanged: false;
      items: AssistantScheduleSummary[]; affectedScheduleIds?: never }
  | { outcome: "cancelled" | "no_match"; operation?: AssistantOutcomeOperation;
      schedulesChanged: false; items?: never; affectedScheduleIds?: never }
);

export type AssistantResultFailure = { kind: "failure"; text: string } & (
  | { code: "MODEL_OUTPUT_INVALID" | "SCHEDULE_REJECTED" | "TARGET_AMBIGUOUS"; nextAction: "revise_input" }
  | { code: "MODEL_TIMEOUT" | "SCHEDULE_UNAVAILABLE" | "PROCESSING_INTERRUPTED" | "PROCESSING_TIMEOUT"; nextAction: "retry_later" }
  | { code: "INTERNAL_ERROR"; nextAction: "none" }
);
export type AssistantFailureCode = AssistantResultFailure["code"];
export type AssistantFailureNextAction = AssistantResultFailure["nextAction"];
export type AssistantResultUncertain = {
  kind: "uncertain";
  text: string;
  code: "EXECUTION_RESULT_UNKNOWN";
  nextAction: "check_status";
};
export type AssistantResult =
  | AssistantResultNeedMoreInfo
  | AssistantResultCandidateSelection
  | AssistantResultConfirmation
  | AssistantResultOutcome
  | AssistantResultFailure
  | AssistantResultUncertain;

export type AssistantRequestStatusResponse = { requestId: string; conversationId: string } & (
  | { status: "accepted" | "processing"; result?: never }
  | { status: "completed"; result: AssistantResult }
);

export type AssistantCancelTargetType = "request" | "question";
export type AssistantCancelTarget = { type: AssistantCancelTargetType; id: string };
export type AssistantCancelTargetState = "cancelled" | "not_guaranteed" | "already_completed" | "uncertain" | "not_active";
export type AssistantCancelRequest = { target: AssistantCancelTarget };
export type AssistantCancelResponse = { target: AssistantCancelTarget; targetState: AssistantCancelTargetState; text: string };

// OpenAPI Problem의 nullable 필드를 보존하며 Schedule HTTP 동작은 변경하지 않는다.
export type AssistantValidationErrorItem = Omit<ValidationErrorItem, "pointer" | "parameter"> & {
  pointer?: string | null;
  parameter?: string | null;
};
export type AssistantProblemDetails = Omit<ProblemDetails, "errors"> & {
  errors?: AssistantValidationErrorItem[] | null;
  assistantRequestId?: string | null;
  blockingRequestId?: string | null;
  activeQuestionId?: string | null;
  activeQuestionRequestId?: string | null;
};
