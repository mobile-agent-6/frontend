export type AssistantStatus =
  | "idle"
  | "listening"
  | "processing"
  | "stt-error"
  | "need-more-info";

// 화면 내부 삭제 확인용 데이터이며 실제 Assistant API 계약과는 별개다.
export type AssistantDeleteConfirmation = {
  type: "delete-confirmation";
  scheduleId: string;
  resolved: boolean;
};

// 고정 후보를 표시하는 화면용 데이터이며 실제 AI 후보 판단 계약과는 별개다.
export type AssistantCandidateSelection = {
  type: "candidate-selection";
  candidates: readonly { scheduleId: string; label: string }[];
  resolved: boolean;
};

export type AssistantInteraction =
  | AssistantDeleteConfirmation
  | AssistantCandidateSelection;
