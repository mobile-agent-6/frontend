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
