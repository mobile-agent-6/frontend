import { scheduleHttpClient, type HttpResult, type ScheduleHttpClient } from "@/services/api/http";
import type { Schedule, ScheduleDto } from "@/types/schedule";
import { scheduleDtoToSchedule, scheduledAtToUiDateTime } from "@/utils/schedule-mapper";
import { buildScheduleListQuery, type ScheduleListQuery } from "@/utils/schedule-query";

function readSchedule(value: unknown): Schedule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
  const dto = value as Record<string, unknown>;
  if (!["id", "title", "scheduledAt", "category", "createdAt", "updatedAt"].every((key) => typeof dto[key] === "string") ||
    dto.id === "" || typeof dto.completed !== "boolean") throw new Error();
  // ID는 UUID 버전을 검사하지 않고 그대로 유지한다.
  scheduledAtToUiDateTime(dto.createdAt as string);
  scheduledAtToUiDateTime(dto.updatedAt as string);
  return scheduleDtoToSchedule(value as ScheduleDto);
}

function mapResponse<T>(result: HttpResult<unknown>, map: (data: unknown) => T): HttpResult<T> {
  if (!result.ok) return result;
  try {
    if (result.status !== 200) throw new Error();
    return { ...result, data: map(result.data) };
  } catch {
    return { ok: false, attempts: result.attempts, error: {
      kind: "response", status: result.status, requestId: result.requestId, requestState: "response-received",
    } };
  }
}

const invalidRequest = (): HttpResult<never> => ({
  ok: false, attempts: 0, error: { kind: "request", requestState: "not-sent" },
});

/** 서버 설정은 HTTP 계층에 맡기며 navigation·form·store를 변경하지 않는 조회 서비스. */
export function createScheduleService(client: ScheduleHttpClient = scheduleHttpClient) {
  async function listSchedules(query: ScheduleListQuery, signal?: AbortSignal): Promise<HttpResult<Schedule[]>> {
    let params: URLSearchParams;
    try { params = buildScheduleListQuery(query); } catch { return invalidRequest(); }
    const result = await client.request({ path: "/schedules", query: params, signal });
    return mapResponse(result, (data) => {
      if (typeof data !== "object" || data === null || !("items" in data) || !Array.isArray(data.items)) throw new Error();
      // 서버 배열 순서를 유지하고 실패를 빈 배열이나 Mock으로 대체하지 않는다.
      return data.items.map(readSchedule);
    });
  }

  async function getSchedule(scheduleId: string, signal?: AbortSignal): Promise<HttpResult<Schedule>> {
    let path: string;
    try {
      if (typeof scheduleId !== "string" || !scheduleId || [".", ".."].includes(scheduleId)) return invalidRequest();
      path = `/schedules/${encodeURIComponent(scheduleId)}`;
    } catch { return invalidRequest(); }
    return mapResponse(await client.request({ path, signal }), readSchedule);
  }
  return { listSchedules, getSchedule };
}

export const { listSchedules, getSchedule } = createScheduleService();
