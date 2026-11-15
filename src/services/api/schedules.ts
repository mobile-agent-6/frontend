import * as Crypto from "expo-crypto";

import { scheduleHttpClient, type HttpError, type HttpResult, type ScheduleHttpClient } from "@/services/api/http";
import type { Schedule, ScheduleCreateInput, ScheduleDto, ScheduleUpdateInput } from "@/types/schedule";
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

function validateTitle(value: unknown): { title: string; error?: string } {
  const title = typeof value === "string" ? value.trim() : "";
  if (typeof value !== "string" || [...title].length < 1 || [...title].length > 100) {
    return { title, error: "제목은 공백 정리 후 1~100 Unicode code point여야 합니다." };
  }
  if (/\p{Cc}/u.test(title)) return { title, error: "제목에 제어문자를 사용할 수 없습니다." };
  return { title };
}

function validateCreation(input: ScheduleCreateInput) {
  const fields: Partial<Record<keyof ScheduleCreateInput, string>> = {};
  const { title, error } = validateTitle(input?.title);
  if (error) fields.title = error;
  try {
    if (typeof input?.scheduledAt !== "string") throw new Error();
    parseScheduleApiDateTime(input.scheduledAt);
  } catch { fields.scheduledAt = "시간대가 포함된 유효한 날짜·시간이 필요합니다."; }
  try { toUiCategory(input?.category); } catch { fields.category = "허용된 API 카테고리가 필요합니다."; }
  return { title, fields };
}

export type ScheduleMutationResult<T, Outcome extends "updated" | "deleted"> =
  | { outcome: Outcome; response: Extract<HttpResult<T>, { ok: true }> }
  | { outcome: "not-sent" | "rejected" | "uncertain" | "review-required";
      attempts: number; requiresReconciliation: boolean;
      error: HttpError | { kind: "operation"; reason: "schedule-busy" } };

type ScheduleMutationOperation<T, Outcome extends "updated" | "deleted", Payload> = {
  readonly scheduleId: string;
  readonly payload: Payload;
  readonly serverId: string | null;
  submit: (signal?: AbortSignal) => Promise<ScheduleMutationResult<T, Outcome>>;
};
export type ScheduleUpdateOperation = ScheduleMutationOperation<Schedule, "updated", Readonly<ScheduleUpdateInput>>;
export type ScheduleDeleteOperation = ScheduleMutationOperation<undefined, "deleted", undefined>;

type MutationFields = Partial<Record<keyof ScheduleUpdateInput | "scheduleId" | "updates", string>>;
export type ScheduleMutationPreparation<Operation> =
  | { ok: true; operation: Operation }
  | { ok: false; error: { kind: "validation"; fields: MutationFields } };

function schedulePath(scheduleId: string): string {
  if (typeof scheduleId !== "string" || !scheduleId || [".", ".."].includes(scheduleId)) throw new Error();
  return `/schedules/${encodeURIComponent(scheduleId)}`;
}

function validateUpdate(input: ScheduleUpdateInput) {
  const payload: ScheduleUpdateInput = {};
  const fields: MutationFields = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { payload, fields: { updates: "수정할 필드 객체가 필요합니다." } as MutationFields };
  }
  if (input.title !== undefined) {
    const { title, error } = validateTitle(input.title);
    if (error) fields.title = error;
    else payload.title = title;
  }
  if (input.scheduledAt !== undefined) {
    try {
      if (typeof input.scheduledAt !== "string") throw new Error();
      parseScheduleApiDateTime(input.scheduledAt);
      payload.scheduledAt = input.scheduledAt;
    } catch { fields.scheduledAt = "시간대가 포함된 유효한 날짜·시간이 필요합니다."; }
  }
  if (input.category !== undefined) {
    try { toUiCategory(input.category); payload.category = input.category; }
    catch { fields.category = "허용된 API 카테고리가 필요합니다."; }
  }
  if (input.completed !== undefined) {
    if (typeof input.completed !== "boolean") fields.completed = "완료 상태는 boolean이어야 합니다.";
    else payload.completed = input.completed;
  }
  if (!Object.keys(payload).length && !Object.keys(fields).length) fields.updates = "변경할 필드가 없습니다.";
  return { payload, fields };
}

/** 서버 설정은 HTTP 계층에 맡기며 navigation·form·store를 변경하지 않는 서비스. */
export function createScheduleService(
  client: ScheduleHttpClient = scheduleHttpClient,
  { createIdempotencyKey = Crypto.randomUUID, now = Date.now }: {
    createIdempotencyKey?: () => string;
    now?: () => number;
  } = {},
) {
  // 기본 서비스 인스턴스를 공유하는 호출자의 동일 일정 PATCH/DELETE 동시 실행을 차단한다.
  const pendingScheduleIds = new Set<string>();
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
      path = schedulePath(scheduleId);
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
    const scope = client.captureScope?.();

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
        expectedServerId: serverId ?? undefined, scope,
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
      if (scope && !client.isScopeCurrent(scope)) return Promise.resolve({ outcome: sent && !terminal ? "uncertain" : "not-sent", attempts: 0,
        requiresReconciliation: sent, error: { kind: "aborted", requestState: "not-sent" } });
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

  function prepareMutation<T, Outcome extends "updated" | "deleted", Payload>(
    scheduleId: string, payload: Payload, method: "PATCH" | "DELETE",
    expectedStatus: number, decode: (data: unknown) => T, outcome: Outcome,
  ): ScheduleMutationPreparation<ScheduleMutationOperation<T, Outcome, Payload>> {
    let path: string;
    try { path = schedulePath(scheduleId); }
    catch { return { ok: false, error: { kind: "validation", fields: { scheduleId: "일정 ID 문자열이 필요합니다." } } }; }
    let serverId: string | null = null;
    let sent = false;
    let uncertain = false;
    let pending: Promise<ScheduleMutationResult<T, Outcome>> | null = null;
    let terminal: ScheduleMutationResult<T, Outcome> | null = null;
    const scope = client.captureScope?.();
    const lockKey = JSON.stringify([scope?.config.serverId ?? client.getServerId(), scope?.generation, scheduleId]);

    async function send(signal?: AbortSignal): Promise<ScheduleMutationResult<T, Outcome>> {
      if (serverId === null) serverId = client.getServerId();
      const result = mapResponse(await client.request({
        method, path, body: payload, signal, expectedServerId: serverId ?? undefined, scope,
      }), decode, expectedStatus);
      if (result.attempts > 0) sent = true;
      else if (!sent) serverId = null;
      if (result.ok) {
        terminal = { outcome, response: result };
        return terminal;
      }
      const { error, attempts } = result;
      uncertain ||= error.unconfirmedAttempt === true;
      if (error.kind === "http" && error.status !== undefined && error.status >= 400 && error.status < 500) {
        terminal = { outcome: uncertain ? "uncertain" : "rejected", error, attempts, requiresReconciliation: uncertain };
        return terminal;
      }
      if (error.requestState === "not-sent" && !uncertain) {
        return { outcome: "not-sent", error, attempts, requiresReconciliation: false };
      }
      uncertain = true;
      return { outcome: error.kind === "response" ? "review-required" : "uncertain",
        error, attempts, requiresReconciliation: true };
    }

    function submit(signal?: AbortSignal): Promise<ScheduleMutationResult<T, Outcome>> {
      if (scope && !client.isScopeCurrent(scope)) return Promise.resolve({ outcome: sent && !terminal ? "uncertain" : "not-sent", attempts: 0,
        requiresReconciliation: sent, error: { kind: "aborted", requestState: "not-sent" } });
      if (terminal) return Promise.resolve(terminal);
      if (pending) return pending;
      if (pendingScheduleIds.has(lockKey)) return Promise.resolve({
        outcome: "not-sent", attempts: 0, requiresReconciliation: false,
        error: { kind: "operation", reason: "schedule-busy" },
      });
      pendingScheduleIds.add(lockKey);
      pending = send(signal).finally(() => { pendingScheduleIds.delete(lockKey); pending = null; });
      return pending;
    }
    // 결과 불확실 시 다음 조작 허용 여부는 호출자가 GET 확인 후 판단한다. 별도 작업을 자동 시작하지 않는다.
    return { ok: true, operation: Object.freeze({ scheduleId, payload, get serverId() { return serverId; }, submit }) };
  }

  /** 변경 감지가 끝난 API 필드를 받아 허용된 필드만 고정한다. */
  function prepareScheduleUpdate(scheduleId: string, input: ScheduleUpdateInput): ScheduleMutationPreparation<ScheduleUpdateOperation> {
    const { payload, fields } = validateUpdate(input);
    if (Object.keys(fields).length) return { ok: false, error: { kind: "validation", fields } };
    return prepareMutation(scheduleId, Object.freeze(payload), "PATCH", 200, readSchedule, "updated");
  }

  function prepareScheduleDeletion(scheduleId: string): ScheduleMutationPreparation<ScheduleDeleteOperation> {
    return prepareMutation(scheduleId, undefined, "DELETE", 204, () => undefined, "deleted");
  }

  return { listSchedules, getSchedule, prepareScheduleCreation, prepareScheduleUpdate, prepareScheduleDeletion };
}

export const { listSchedules, getSchedule, prepareScheduleCreation, prepareScheduleUpdate, prepareScheduleDeletion } = createScheduleService();
