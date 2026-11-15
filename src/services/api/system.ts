import { isServerTarget, type ServerTarget } from "@/services/api/config";
import { parseProblemDetails, type ProblemDetails } from "@/services/api/http";
import type { ApiTimers, ApiTransport } from "@/services/api/transport";
import { parseScheduleApiDateTime } from "@/utils/schedule-mapper";

export type HealthResponse = Readonly<{ status: "ok"; apiVersion: "v1"; serverTime: string }>;
export type TimeSyncRequest = Readonly<{ currentTime: string }>;
export type TimeSyncResponse = Readonly<{ adjusted: boolean; previousServerTime: string; serverTime: string }>;
export type SystemClock = { now: () => number; monotonicNow: () => number };
export type SystemAttemptTiming = Readonly<{
  attempt: number;
  wallStartedAt: number;
  monotonicStartedAt: number;
  // 응답 본문 수신까지 완료한 시각. timeout/네트워크 실패에는 null이며 다른 시도와 합치지 않는다.
  monotonicReceivedAt: number | null;
}>;
export type SystemApiError = {
  kind: "request" | "policy" | "clock" | "aborted" | "context-changed" | "network" | "timeout" | "response" | "http";
  requestState: "not-sent" | "unconfirmed" | "response-received";
  status?: number;
  requestId?: string | null;
  problem?: ProblemDetails;
};
export type SystemApiResult<T> = {
  attempts: number;
  timings: readonly SystemAttemptTiming[];
} & ({ ok: true; data: T; serverId: string; status: 200; requestId: string }
  | { ok: false; error: SystemApiError });
export type SystemRequestOptions = { signal?: AbortSignal; isCurrent?: () => boolean };
type SystemExchange<T> = { ok: true; data: T; serverId: string; status: 200; requestId: string }
  | { ok: false; error: SystemApiError };

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    keys.length === Object.keys(value).length && keys.every(key => Object.hasOwn(value, key));
}

function validDateTime(value: unknown, utcOnly = false): value is string {
  if (typeof value !== "string" || (utcOnly && !value.endsWith("Z"))) return false;
  try { parseScheduleApiDateTime(value); return true; } catch { return false; }
}

export function parseHealthResponse(value: unknown): HealthResponse | null {
  if (!exactObject(value, ["status", "apiVersion", "serverTime"]) || value.status !== "ok" ||
    value.apiVersion !== "v1" || !validDateTime(value.serverTime, true)) return null;
  return Object.freeze({ status: "ok", apiVersion: "v1", serverTime: value.serverTime });
}

export function parseTimeSyncRequest(value: unknown): TimeSyncRequest | null {
  if (!exactObject(value, ["currentTime"]) || !validDateTime(value.currentTime)) return null;
  // 허용 연도 범위는 서버가 CLOCK_TIME_OUT_OF_RANGE로 판정한다. 공개 datetime 문법만 검사한다.
  return Object.freeze({ currentTime: value.currentTime });
}

export function parseTimeSyncResponse(value: unknown): TimeSyncResponse | null {
  if (!exactObject(value, ["adjusted", "previousServerTime", "serverTime"]) || typeof value.adjusted !== "boolean" ||
    !validDateTime(value.previousServerTime, true) || !validDateTime(value.serverTime, true)) return null;
  return Object.freeze({ adjusted: value.adjusted, previousServerTime: value.previousServerTime, serverTime: value.serverTime });
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 시스템 API 전용 정책. 생성은 I/O가 없고 transport를 반드시 명시적으로 주입한다. */
export function createSystemApiService({ transport, clock = { now: Date.now, monotonicNow: () => performance.now() },
  timers = { setTimeout, clearTimeout } }: { transport: ApiTransport; clock?: SystemClock; timers?: ApiTimers }) {
  // 호출 중 주입 객체를 바꿔도 Mock에서 HTTP로 전환하거나 다른 fetch로 retry하지 않는다.
  const { kind: transportKind, fetchImpl } = transport;
  function invalid<T>(kind: SystemApiError["kind"]): SystemApiResult<T> {
    return { ok: false, attempts: 0, timings: [], error: { kind, requestState: "not-sent" } };
  }
  function boundary(options: SystemRequestOptions): "aborted" | "context-changed" | null {
    if (options.signal?.aborted) return "aborted";
    try { return options.isCurrent?.() === false ? "context-changed" : null; }
    catch { return "context-changed"; }
  }
  function waitForRetry(options: SystemRequestOptions): Promise<void> {
    return new Promise(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true; timers.clearTimeout(timer); options.signal?.removeEventListener("abort", finish); resolve();
      };
      const timer = timers.setTimeout(finish, 1_000);
      options.signal?.addEventListener("abort", finish, { once: true });
      if (boundary(options)) finish();
    });
  }
  async function exchange<T>(input: ServerTarget, method: "GET" | "POST", path: string, body: string | undefined,
    parse: (value: unknown) => T | null, options: SystemRequestOptions): Promise<SystemApiResult<T>> {
    if (!isServerTarget(input) || input.transport !== transportKind) return invalid("policy");
    options = { signal: options.signal, isCurrent: options.isCurrent };
    const target = Object.freeze({ ...input }); // 호출자의 변경으로 retry 대상이 바뀌지 않는다.
    const url = `${target.baseUrl}${path}`, timings: SystemAttemptTiming[] = [];
    const wrap = (result: SystemExchange<T>, attempts: number): SystemApiResult<T> =>
      ({ ...result, attempts, timings: Object.freeze([...timings]) });
    const stopped = (kind: "aborted" | "context-changed", attempts: number): SystemApiResult<T> =>
      ({ ok: false, attempts, timings: Object.freeze([...timings]), error: { kind,
        requestState: attempts ? "unconfirmed" : "not-sent" } });
    const limit = method === "GET" ? 2 : 1;
    for (let attempt = 1; attempt <= limit; attempt++) {
      const blocked = boundary(options);
      if (blocked) return stopped(blocked, attempt - 1);
      const clockFailure = (): SystemApiResult<T> => ({ ...invalid<T>("clock"), attempts: attempt - 1,
        timings: Object.freeze([...timings]) });
      let wallStartedAt: number, monotonicStartedAt: number;
      try {
        wallStartedAt = clock.now(); monotonicStartedAt = clock.monotonicNow();
        if (!Number.isFinite(wallStartedAt) || !Number.isFinite(monotonicStartedAt)) return clockFailure();
      } catch { return clockFailure(); }
      let monotonicReceivedAt: number | null = null;
      let status: number | undefined, requestId: string | null = null, timedOut = false, settled = false, sent = false;
      const controller = new AbortController();
      type Exchange = SystemExchange<T>;
      const fail = (kind: SystemApiError["kind"], problem?: ProblemDetails): Exchange => ({ ok: false, error: {
        kind, status, requestId, problem, requestState: status !== undefined ? "response-received" : sent ? "unconfirmed" : "not-sent",
      } });
      let interrupt!: (value: Exchange) => void;
      const interrupted = new Promise<Exchange>(resolve => { interrupt = resolve; });
      const abort = () => { interrupt(fail("aborted")); controller.abort(); };
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = timers.setTimeout(() => {
        timedOut = true; interrupt(fail("timeout")); controller.abort();
      }, method === "GET" ? 5_000 : 15_000);
      const receive = async (): Promise<Exchange> => {
        try {
          const changed = boundary(options);
          if (changed) return fail(changed);
          const headers = new Headers({ Accept: "application/json, application/problem+json" });
          if (body !== undefined) headers.set("Content-Type", "application/json");
          sent = true;
          const response = await fetchImpl(url, { method, headers, body, signal: controller.signal, redirect: "error" });
          if (settled) return fail("aborted");
          status = response.status; requestId = response.headers.get("X-Request-ID");
          const text = await response.text();
          if (settled) return fail("aborted");
          try {
            monotonicReceivedAt = clock.monotonicNow();
            if (!Number.isFinite(monotonicReceivedAt) || monotonicReceivedAt < monotonicStartedAt) return fail("clock");
          } catch { return fail("clock"); }
          const media = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
          let data: unknown;
          try { data = JSON.parse(text); } catch { return fail("response"); }
          if (!requestId || !uuid.test(requestId)) return fail("response");
          if (status === 200 && media === "application/json") {
            const parsed = parse(data);
            return parsed === null ? fail("response") : { ok: true, data: parsed, status: 200, requestId, serverId: target.serverId };
          }
          // 공개 Problem의 nullable errors를 기존 공통 parser가 받을 수 있도록 투영한다.
          const problemValue = typeof data === "object" && data !== null && "errors" in data && data.errors === null
            ? { ...data, errors: undefined } : data;
          const problem = media === "application/problem+json" ? parseProblemDetails(problemValue) : null;
          return status >= 400 && problem?.status === status && problem.requestId.toLowerCase() === requestId.toLowerCase()
            ? fail("http", problem) : fail("response");
        } catch { return fail(timedOut ? "timeout" : options.signal?.aborted ? "aborted" : "network"); }
      };
      let result: Exchange;
      try {
        const beforeSend = boundary(options);
        result = beforeSend ? fail(beforeSend) : await Promise.race([receive(), interrupted]);
      } finally {
        settled = true; timers.clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      }
      timings.push(Object.freeze({ attempt, wallStartedAt, monotonicStartedAt, monotonicReceivedAt }));
      const changed = boundary(options);
      if (changed) return wrap({ ok: false, error: { ...(result.ok ? { status: result.status, requestId: result.requestId,
        requestState: "response-received" as const } : result.error), kind: changed } }, attempt);
      if (result.ok) return wrap(result, attempt);
      // 잘못된 DTO/Problem은 retry하지 않는다. 이미 받은 다른 HTTP 오류의 body timeout도 반복하지 않는다.
      const retry = (result.error.kind === "http" && status === 503) ||
        ((status === undefined || status === 200) && ["network", "timeout"].includes(result.error.kind));
      if (attempt === limit || !retry) return wrap(result, attempt);
      await waitForRetry(options);
    }
    return invalid("request");
  }
  return {
    checkHealth: (target: ServerTarget, options: SystemRequestOptions = {}) =>
      exchange(target, "GET", "/health", undefined, parseHealthResponse, options),
    // Settings 확인 조작 전용 입구다. 1단계에서는 live POST 자체를 닫는다.
    syncTimeAfterConsent: (target: ServerTarget, input: TimeSyncRequest,
      options: SystemRequestOptions & { consent: "confirmed" }): Promise<SystemApiResult<TimeSyncResponse>> => {
      if (!options || options.consent !== "confirmed" || target?.source !== "pi" || transportKind !== "mock") {
        return Promise.resolve(invalid("policy"));
      }
      const payload = parseTimeSyncRequest(input);
      return payload ? exchange(target, "POST", "/api/v1/system/time-sync", JSON.stringify(payload), parseTimeSyncResponse, options)
        : Promise.resolve(invalid("request"));
    },
  };
}
