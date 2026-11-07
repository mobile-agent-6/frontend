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
   * 서버에서 받은 일정 ID를 UUID 버전 검사 없이 string으로 보관한다.
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
};

export type ScheduleDto = {
  id: string;
  title: string;
  scheduledAt: string;
  category: ScheduleApiCategory;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
};
