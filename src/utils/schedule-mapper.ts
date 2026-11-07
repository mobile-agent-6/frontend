import type {
  Schedule,
  ScheduleApiCategory,
  ScheduleCategory,
  ScheduleDto,
} from "@/types/schedule";

const API_CATEGORIES: Record<ScheduleCategory, ScheduleApiCategory> = {
  입고: "INBOUND",
  재고: "INVENTORY",
  출고: "OUTBOUND",
  반품: "RETURN",
  기타: "OTHER",
};

const UI_CATEGORIES: Record<ScheduleApiCategory, ScheduleCategory> = {
  INBOUND: "입고",
  INVENTORY: "재고",
  OUTBOUND: "출고",
  RETURN: "반품",
  OTHER: "기타",
};

const seoulFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul",
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function toApiCategory(category: ScheduleCategory): ScheduleApiCategory {
  if (!Object.prototype.hasOwnProperty.call(API_CATEGORIES, category)) {
    throw new RangeError("Unsupported UI schedule category.");
  }
  return API_CATEGORIES[category];
}

export function toUiCategory(category: ScheduleApiCategory): ScheduleCategory {
  if (!Object.prototype.hasOwnProperty.call(UI_CATEGORIES, category)) {
    throw new RangeError("Unsupported API schedule category.");
  }
  return UI_CATEGORIES[category];
}

function validateDate(date: string): void {
  if (date.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000")) {
    throw new RangeError("Expected a valid YYYY-MM-DD date.");
  }
  const value = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) {
    throw new RangeError("Expected a valid YYYY-MM-DD date.");
  }
}

/** 기기 시간대와 무관하게 API의 UTC Z 시각을 Asia/Seoul 날짜·시간으로 변환한다. */
export function scheduledAtToUiDateTime(
  scheduledAt: string,
): Pick<Schedule, "date" | "time"> {
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,6})?Z$/.exec(scheduledAt);
  if (!match || match[0] !== scheduledAt) {
    throw new RangeError("Expected a valid UTC Z scheduledAt.");
  }
  const [, utcDate, hour, minute, second] = match;
  validateDate(utcDate);

  // UI는 분 단위이므로 마이크로초를 제외해 플랫폼별 파싱 차이를 피한다.
  const instant = new Date(`${utcDate}T${hour}:${minute}:${second}Z`);
  const parts = Object.fromEntries(
    seoulFormatter.formatToParts(instant).map(({ type, value }) => [type, value]),
  );
  const date = `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
  validateDate(date);
  return { date, time: `${parts.hour}:${parts.minute}` };
}

/** 생성 또는 실제 날짜·시간 변경 때만 호출하며 제목·카테고리만 수정할 때는 호출하지 않는다. */
export function uiDateTimeToScheduledAt(date: string, time: string): string {
  validateDate(date);
  if (time.length !== 5 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new RangeError("Expected a valid HH:mm time.");
  }
  // MVP 요청 계약에 따라 Asia/Seoul의 +09:00을 사용하고 초·밀리초를 0으로 맞춘다.
  return `${date}T${time}:00+09:00`;
}

export function scheduleDtoToSchedule(dto: ScheduleDto): Schedule {
  return {
    id: dto.id,
    title: dto.title,
    ...scheduledAtToUiDateTime(dto.scheduledAt),
    category: toUiCategory(dto.category),
    completed: dto.completed,
  };
}
