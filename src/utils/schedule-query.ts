import type { ScheduleApiCategory } from "@/types/schedule";
import { parseScheduleApiDateTime, scheduledAtToUiDateTime, toUiCategory, uiDateTimeToScheduledAt } from "@/utils/schedule-mapper";

export type ScheduleDateRange = { from: string; to: string };
export type ScheduleListQuery = ScheduleDateRange & { category?: ScheduleApiCategory; completed?: boolean };

export function buildScheduleListQuery(query: ScheduleListQuery): URLSearchParams {
  const from = parseScheduleApiDateTime(query.from);
  const to = parseScheduleApiDateTime(query.to);
  const difference = to.milliseconds - from.milliseconds;
  const remainder = to.microseconds - from.microseconds;
  const maxRange = 92 * 24 * 60 * 60 * 1000;
  if (difference < 0 || (difference === 0 && remainder <= 0)) throw new RangeError("to는 from보다 뒤여야 합니다.");
  if (difference > maxRange || (difference === maxRange && remainder > 0)) throw new RangeError("조회 범위는 92일 이내여야 합니다.");
  const params = new URLSearchParams({ from: from.utc, to: to.utc });
  if (query.category !== undefined) {
    toUiCategory(query.category);
    params.set("category", query.category);
  }
  if (query.completed !== undefined) {
    if (typeof query.completed !== "boolean") throw new RangeError("completed는 boolean이어야 합니다.");
    params.set("completed", query.completed ? "true" : "false");
  }
  return params;
}

function monthStart(year: number, monthIndex: number): string {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, 1);
  const formatted = date.toISOString().slice(0, 10);
  return new Date(uiDateTimeToScheduledAt(formatted, "00:00")).toISOString();
}

/** 전달받은 instant를 Asia/Seoul 월로 변환해 이전 달부터 다음 달까지의 범위를 반환한다. */
export function getMainScheduleRange(now: Date): ScheduleDateRange {
  const { date } = scheduledAtToUiDateTime(now.toISOString());
  const [year, month] = date.split("-").map(Number);
  return { from: monthStart(year, month - 2), to: monthStart(year, month + 1) };
}

/** YYYY-MM 또는 기존 visibleMonth의 YYYY-MM-01을 받으며 선택 날짜는 변경하지 않는다. */
export function getCalendarScheduleRange(visibleMonth: string): ScheduleDateRange {
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-01)?$/.exec(visibleMonth);
  if (!match || match[0] !== visibleMonth || match[1] === "0000") throw new RangeError("유효한 표시 월이 필요합니다.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  return { from: monthStart(year, month - 1), to: monthStart(year, month) };
}
