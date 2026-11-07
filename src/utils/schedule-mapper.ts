import type {
  Schedule,
  ScheduleApiCategory,
  ScheduleCategory,
  ScheduleDto,
  ScheduleUpdateInput,
} from "@/types/schedule";

/** API 요청 datetime을 검증하고 소수초 최대 6자리 정밀도를 보존해 UTC로 정규화한다. */
export function parseScheduleApiDateTime(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || match[0] !== value) throw new RangeError("시간대가 포함된 날짜·시간이 필요합니다.");
  const [, date, hour, minute, second, fraction = "", zone] = match;
  validateDate(date);
  const milliseconds = Date.parse(`${date}T${hour}:${minute}:${second}.${fraction.padEnd(3, "0").slice(0, 3)}${zone}`);
  if (!Number.isFinite(milliseconds)) throw new RangeError("유효한 날짜·시간이 필요합니다.");
  const utc = new Date(milliseconds).toISOString();
  if (!/^\d{4}-/.test(utc) || utc.startsWith("0000")) throw new RangeError("날짜·시간이 처리 가능한 범위를 벗어났습니다.");
  const microseconds = Number(fraction.padEnd(6, "0").slice(3));
  return { milliseconds, microseconds, utc: `${utc.slice(0, -1)}${fraction.length > 3 ? fraction.padEnd(6, "0").slice(3) : ""}Z` };
}

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

/** 기존 폼의 변경값을 원본과 비교한다. HTTP 필드 검증·전송은 서비스가 담당한다. */
export function buildScheduleUpdate(
  original: Schedule,
  updates: Partial<Pick<Schedule, "title" | "date" | "time" | "category" | "completed">>,
): ScheduleUpdateInput {
  const result: ScheduleUpdateInput = {};
  if (updates.title !== undefined && updates.title.trim() !== original.title.trim()) {
    result.title = updates.title.trim();
  }
  if (updates.category !== undefined && updates.category !== original.category) {
    result.category = toApiCategory(updates.category);
  }
  const date = updates.date === undefined ? original.date : updates.date;
  const time = updates.time === undefined ? original.time : updates.time;
  // 분 단위 UI 값이 그대로라면 서버의 기존 초·소수초를 재생성하지 않는다.
  if (date !== original.date || time !== original.time) result.scheduledAt = uiDateTimeToScheduledAt(date, time);
  if (updates.completed !== undefined && updates.completed !== original.completed) result.completed = updates.completed;
  return result;
}
