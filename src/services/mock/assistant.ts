import type { Schedule } from "@/types/schedule";

// 결과 카드 UI 확인용 fixture이며 실제 일정 저장소에는 추가하지 않는다.
const PREVIEW_SCHEDULE: Schedule = {
  id: "assistant-card-preview",
  title: "팀 회의",
  date: "2026-10-06",
  time: "15:00",
  category: "회의",
  completed: false,
  notificationEnabled: false,
};

export function getMockAssistantText(): string {
  return "메시지를 받았어요. 아래는 화면 확인용 예시 일정이에요.";
}

export function getMockAssistantSchedules(): Schedule[] {
  return [{ ...PREVIEW_SCHEDULE }];
}
