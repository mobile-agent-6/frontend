export type ScheduleCategory = "입고" | "재고" | "출고" | "반품" | "기타";

export type ScheduleApiCategory =
  | "INBOUND"
  | "INVENTORY"
  | "OUTBOUND"
  | "RETURN"
  | "OTHER";

export const SCHEDULE_CATEGORIES: ScheduleCategory[] = [
  "입고",
  "재고",
  "출고",
  "반품",
  "기타",
];

export type Schedule = {
  /**
   * 서버 일정 ID는 UUID v4 문자열이며 프론트에서는 string으로 보관한다.
   */
  id: string;
  title: string;

  /**
   * UI와 Mock에서 사용하는 날짜 형식이다.
   */
  date: string; // YYYY-MM-DD

  /**
   * UI와 Mock에서 사용하는 시간 형식이다.
   */
  time: string; // HH:mm

  category: ScheduleCategory;
  completed: boolean;

  /**
   * 일정 10분 전 로컬 알림 사용 여부다.
   * API 경계에서는 reminderMinutesBefore의 10 또는 null로 변환한다.
   */
  notificationEnabled: boolean;
};

export type ScheduleDto = {
  id: string;
  title: string;
  scheduledAt: string;
  category: ScheduleApiCategory;
  completed: boolean;
  reminderMinutesBefore: 10 | null;
  reminderAt: string | null;
  createdAt: string;
  updatedAt: string;
};
