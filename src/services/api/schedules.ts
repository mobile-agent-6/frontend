import * as Crypto from "expo-crypto";

import { scheduleHttpClient, type HttpError, type HttpResult, type ScheduleHttpClient } from "@/services/api/http";
import type { Schedule, ScheduleCreateInput, ScheduleDto } from "@/types/schedule";
import { parseScheduleApiDateTime, scheduleDtoToSchedule, scheduledAtToUiDateTime, toUiCategory } from "@/utils/schedule-mapper";
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

function mapResponse<T>(result: HttpResult<unknown>, map: (data: unknown) => T, expectedStatus = 200): HttpResult<T> {
  if (!result.ok) return result;
  try {
    if (result.status !== expectedStatus) throw new Error();
    return { ...result, data: map(result.data) };
  } catch {
    return { ok: false, attempts: result.attempts, error: {
      kind: "response", status: result.status, requestId: result.requestId, requestState: "response-received",
      location: result.location, idempotentReplayed: result.idempotentReplayed,
    } };
  }
}

const invalidRequest = (): HttpResult<never> => ({
  ok: false, attempts: 0, error: { kind: "request", requestState: "not-sent" },
});

export type ScheduleCreationResult =
  | { outcome: "created" | "replayed"; response: Extract<HttpResult<Schedule>, { ok: true }> }
  | { outcome: "not-sent" | "rejected" | "uncertain" | "review-required";
      attempts: number; requiresReconciliation: boolean;
      error: HttpError | { kind: "operation"; reason: "retention-window" } };

export type ScheduleCreationOperation = {
  readonly idempotencyKey: string;
  readonly payload: Readonly<ScheduleCreateInput>;
  readonly firstAttemptAt: number | null;
  readonly serverId: string | null;
  submit: (signal?: AbortSignal) => Promise<ScheduleCreationResult>;
};

export type ScheduleCreationPreparation =
  | { ok: true; operation: ScheduleCreationOperation }
  | { ok: false; error: { kind: "validation"; fields: Partial<Record<keyof ScheduleCreateInput, string>> } }
  | { ok: false; error: { kind: "key-generation" } };

function validateCreation(input: ScheduleCreateInput) {
  const fields: Partial<Record<keyof ScheduleCreateInput, string>> = {};
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  if (typeof input?.title !== "string" || [...title].length < 1 || [...title].length > 100) {
    fields.title = "제목은 공백 정리 후 1~100 Unicode code point여야 합니다.";
  } else if (/\p{Cc}/u.test(title)) {
    fields.title = "제목에 제어문자를 사용할 수 없습니다.";
  }
  try {
    if (typeof input?.scheduledAt !== "string") throw new Error();
    parseScheduleApiDateTime(input.scheduledAt);
  } catch { fields.scheduledAt = "시간대가 포함된 유효한 날짜·시간이 필요합니다."; }
  try { toUiCategory(input?.category); } catch { fields.category = "허용된 API 카테고리가 필요합니다."; }
  return { title, fields };
}

/** 서버 설정은 HTTP 계층에 맡기며 navigation·form·store를 변경하지 않는 서비스. */
export function createScheduleService(
  client: ScheduleHttpClient = scheduleHttpClient,
  { createIdempotencyKey = Crypto.randomUUID, now = Date.now }: {
    createIdempotencyKey?: () => string;
    now?: () => number;
  } = {},
) {
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

  function prepareScheduleCreation(input: ScheduleCreateInput): ScheduleCreationPreparation {
    const { title, fields } = validateCreation(input);
    if (Object.keys(fields).length) return { ok: false, error: { kind: "validation", fields } };
    let key: string;
    try { key = createIdempotencyKey(); } catch { return { ok: false, error: { kind: "key-generation" } }; }
    // 허용된 세 필드만 복사한다. 원래 form 변경이나 추가 필드가 재시도 body에 섞이지 않는다.
    const payload = Object.freeze({ title, scheduledAt: input.scheduledAt, category: input.category });
    let firstAttemptAt: number | null = null;
    let serverId: string | null = null;
    let sent = false;
    let uncertain = false;
    let pending: Promise<ScheduleCreationResult> | null = null;
    let terminal: ScheduleCreationResult | null = null;

    async function send(signal?: AbortSignal): Promise<ScheduleCreationResult> {
      // 서버는 성공 기록을 24시간 보관한다. 정확한 성공 시각을 모르는 작업은
      // 최초 시도부터 24시간 뒤 자동/수동 POST 재전송을 보류하고 GET 확인을 요구한다.
      if (firstAttemptAt !== null && now() - firstAttemptAt >= 24 * 60 * 60 * 1000) {
        return { outcome: "review-required", attempts: 0, requiresReconciliation: true,
          error: { kind: "operation", reason: "retention-window" } };
      }
      if (serverId === null) serverId = client.getServerId();
      if (firstAttemptAt === null && serverId !== null && !signal?.aborted) firstAttemptAt = now();
      const result = mapResponse(await client.request({
        method: "POST", path: "/schedules", headers: { "Idempotency-Key": key }, body: payload, signal,
        expectedServerId: serverId ?? undefined,
      }), readSchedule, 201);
      if (result.attempts > 0) sent = true;
      else if (!sent) { firstAttemptAt = null; serverId = null; }

      if (result.ok) {
        if (result.idempotentReplayed !== null && result.idempotentReplayed !== "true") {
          uncertain = true;
          return { outcome: "review-required", attempts: result.attempts, requiresReconciliation: true,
            error: { kind: "response", status: 201, requestId: result.requestId, location: result.location,
              idempotentReplayed: result.idempotentReplayed, requestState: "response-received" } };
        }
        terminal = { outcome: result.idempotentReplayed === "true" ? "replayed" : "created", response: result };
        return terminal;
      }

      const { error, attempts } = result;
      uncertain ||= error.unconfirmedAttempt === true;
      if (error.kind === "http" && error.status !== undefined && error.status >= 400 && error.status < 500) {
        // 이번 전송의 거절과 앞선 미확인 전송의 결과는 다르다. 거절 뒤 새 key를 발급하지 않는다.
        terminal = { outcome: uncertain ? "uncertain" : "rejected", attempts, error,
          requiresReconciliation: uncertain || error.status === 409 || error.status === 422 };
        return terminal;
      }
      if (error.requestState === "not-sent" && !uncertain) {
        return { outcome: "not-sent", attempts, error, requiresReconciliation: false };
      }
      uncertain = true;
      return { outcome: error.kind === "response" ? "review-required" : "uncertain", attempts, error, requiresReconciliation: true };
    }

    function submit(signal?: AbortSignal): Promise<ScheduleCreationResult> {
      if (terminal) return Promise.resolve(terminal);
      if (pending) return pending;
      pending = send(signal).finally(() => { pending = null; });
      return pending;
    }
    // key/body를 바꿔 보내는 인터페이스를 제공하지 않으며 동시 submit은 같은 실행을 공유한다.
    const operation = Object.freeze({
      idempotencyKey: key, payload,
      get firstAttemptAt() { return firstAttemptAt; },
      get serverId() { return serverId; },
      submit,
    });
    return { ok: true, operation };
  }

  return { listSchedules, getSchedule, prepareScheduleCreation };
}

export const { listSchedules, getSchedule, prepareScheduleCreation } = createScheduleService();
