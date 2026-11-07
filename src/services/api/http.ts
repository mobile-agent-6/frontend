import { getDevelopmentServerConfig } from "@/services/api/config";
import { isScheduleRequestAllowed } from "@/stores/scheduleDataModeStore";

export type ValidationErrorItem = {
  location: "body" | "query" | "header" | "path";
  pointer?: string;
  parameter?: string;
  code: string;
  detail: string;
};

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId: string;
  errors?: ValidationErrorItem[];
};

export type HttpError = {
  kind: "configuration" | "request" | "network" | "timeout" | "aborted" | "response" | "http";
  // 응답 수신 여부이며 서버 write의 성공·실패 판정이 아니다.
  requestState: "not-sent" | "unconfirmed" | "response-received";
  configurationStatus?: "missing" | "invalid";
  status?: number;
  requestId?: string | null;
  problem?: ProblemDetails;
  location?: string | null;
  idempotentReplayed?: string | null;
  // 이전 자동 시도에서 처리 결과를 확인하지 못했는지 보존한다.
  unconfirmedAttempt?: boolean;
  // 서버 Problem Details code와 별개인 로컬 요청 차단 사유다.
  policyReason?: "read-only";
};

export type HttpResult<T> =
  | { ok: true; data: T; status: number; requestId: string | null; serverId: string; attempts: number;
      location: string | null; idempotentReplayed: string | null }
  | { ok: false; error: HttpError; attempts: number };

export type ScheduleHttpRequest = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  // /api/v1을 제외한 경로와 별도의 query를 받는다.
  path: string;
  query?: URLSearchParams;
  headers?: HeadersInit;
  body?: unknown;
  signal?: AbortSignal;
  // 수동 재시도에서도 원래 서버에만 요청하도록 하는 선택적 경계다.
  expectedServerId?: string;
};

const SCHEDULE_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseProblemDetails(value: unknown): ProblemDetails | null {
  if (!isRecord(value) ||
    !["type", "title", "detail", "instance", "code", "requestId"].every((key) => typeof value[key] === "string") ||
    !Number.isInteger(value.status) || Number(value.status) < 400 || Number(value.status) > 599) return null;

  if (value.errors !== undefined) {
    if (!Array.isArray(value.errors) || !value.errors.every((item: unknown) => {
      if (!isRecord(item) || typeof item.code !== "string" || typeof item.detail !== "string") return false;
      if (item.location === "body") return typeof item.pointer === "string";
      return ["query", "header", "path"].includes(String(item.location)) && typeof item.parameter === "string";
    })) return null;
  }
  if (value.code === "VALIDATION_ERROR" && (!Array.isArray(value.errors) || value.errors.length === 0)) return null;
  return value as ProblemDetails;
}

/** Schedule 전용 10초/최대 1회 retry 정책. health·time-sync·Assistant에 재사용하지 않는다. */
export function createScheduleHttpClient({
  fetchImpl = fetch,
  readConfig = getDevelopmentServerConfig,
}: {
  fetchImpl?: typeof fetch;
  readConfig?: typeof getDevelopmentServerConfig;
} = {}) {
  async function request(options: ScheduleHttpRequest): Promise<HttpResult<unknown>> {
    const method = options.method ?? "GET";
    const blocked = (attempts: number): HttpResult<never> => ({ ok: false, attempts, error: {
      kind: "request", policyReason: "read-only", requestState: attempts ? "unconfirmed" : "not-sent",
      unconfirmedAttempt: attempts > 0,
    } });
    if (!isScheduleRequestAllowed(method, options.path)) return blocked(0);
    const initial = readConfig();
    if (initial.status !== "ready") {
      return { ok: false, attempts: 0, error: {
        kind: "configuration", configurationStatus: initial.status, requestState: "not-sent",
      } };
    }
    const config = { ...initial.config };
    if (options.expectedServerId !== undefined && options.expectedServerId !== config.serverId) {
      return { ok: false, attempts: 0, error: { kind: "aborted", requestState: "not-sent" } };
    }
    const isCurrentServer = () => {
      const current = readConfig();
      return current.status === "ready" && current.config.serverId === config.serverId &&
        current.config.apiBaseUrl === config.apiBaseUrl;
    };
    let headers: Headers;
    let body: string | undefined;
    let url: string;
    try {
      if (!options.path.startsWith("/") || /[?#\s\\]/.test(options.path) || options.path.startsWith("//") ||
        /^\/api\/v1(?:\/|$)/.test(options.path) ||
        options.path.split("/").some((part) => [".", ".."].includes(decodeURIComponent(part)))) {
        throw new Error();
      }
      headers = new Headers(options.headers);
      headers.set("Accept", "application/json, application/problem+json");
      if (options.body !== undefined) {
        if (method === "GET") throw new Error();
        body = JSON.stringify(options.body);
        if (body === undefined) throw new Error();
        headers.set("Content-Type", "application/json");
      }
      const query = options.query?.toString();
      url = `${config.apiBaseUrl}${options.path}${query ? `?${query}` : ""}`;
    } catch {
      return { ok: false, attempts: 0, error: { kind: "request", requestState: "not-sent" } };
    }

    // URL·header·JSON body는 논리 요청마다 한 번만 확정하고 retry에서 재생성하지 않는다.
    let attempts = 0;
    let unconfirmedAttempt = false;
    async function attempt(): Promise<HttpResult<unknown>> {
      const controller = new AbortController();
      let status: number | undefined;
      let requestId: string | null = null;
      let location: string | null = null;
      let idempotentReplayed: string | null = null;
      const failure = (kind: HttpError["kind"], problem?: ProblemDetails): HttpResult<never> => ({
        ok: false, attempts, error: {
          kind, status, requestId, problem, location, idempotentReplayed,
          requestState: status === undefined ? "unconfirmed" : "response-received",
        },
      });
      let interrupt!: (result: HttpResult<unknown>) => void;
      const interrupted = new Promise<HttpResult<unknown>>((resolve) => { interrupt = resolve; });
      let timedOut = false;
      const onAbort = () => {
        interrupt(failure("aborted"));
        controller.abort();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        interrupt(failure("timeout"));
        controller.abort();
      }, SCHEDULE_TIMEOUT_MS);

      const receive = async (): Promise<HttpResult<unknown>> => {
        try {
          const response = await fetchImpl(url, { method, headers: new Headers(headers), body, signal: controller.signal,
            // 쓰기 요청의 redirect로 허용되지 않은 endpoint에 재전송되는 것을 방지한다.
            redirect: method === "GET" ? "follow" : "error" });
          status = response.status;
          requestId = response.headers.get("X-Request-ID");
          location = response.headers.get("Location");
          idempotentReplayed = response.headers.get("Idempotent-Replayed");
          const success = (data: unknown): HttpResult<unknown> => ({
            ok: true, data, status: response.status, requestId, serverId: config.serverId, attempts,
            location, idempotentReplayed,
          });
          // 204는 Content-Type과 관계없이 본문을 읽지 않는다.
          if (status === 204) return success(undefined);
          const mediaType = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
          if (mediaType !== "application/json" && mediaType !== "application/problem+json") return failure("response");
          const text = await response.text();
          let data: unknown;
          try { data = JSON.parse(text); } catch { return failure("response"); }
          if (response.ok) return mediaType === "application/json" ? success(data) : failure("response");
          const problem = mediaType === "application/problem+json" ? parseProblemDetails(data) : null;
          if (!problem) return failure("response");
          // HTTP status와 body.status를 별도로 보존하고 불일치는 응답 형식 오류로 처리한다.
          return failure(problem.status === status ? "http" : "response", problem);
        } catch {
          return failure(options.signal?.aborted ? "aborted" : timedOut ? "timeout" : "network");
        }
      };

      try {
        if (options.signal?.aborted) return failure("aborted");
        // fetch가 Abort를 무시해도 timeout이나 호출자 취소로 대기를 종료한다.
        return await Promise.race([receive(), interrupted]);
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      }
    }

    for (let index = 0; index < 2; index++) {
      if (!isScheduleRequestAllowed(method, options.path)) return blocked(attempts);
      if (options.signal?.aborted || !isCurrentServer()) {
        return { ok: false, attempts, error: { kind: "aborted", requestState: attempts ? "unconfirmed" : "not-sent" } };
      }
      attempts++;
      const result = await attempt();
      if (options.signal?.aborted || !isCurrentServer()) {
        return { ok: false, attempts, error: result.ok
          ? { kind: "aborted", status: result.status, requestId: result.requestId, location: result.location,
              idempotentReplayed: result.idempotentReplayed, requestState: "response-received", unconfirmedAttempt: true }
          : { ...result.error, kind: "aborted", unconfirmedAttempt: true } };
      }
      if (result.ok) return result;
      if (result.error.kind !== "http" || (result.error.status ?? 0) >= 500) unconfirmedAttempt = true;
      result.error.unconfirmedAttempt = unconfirmedAttempt;
      if (result.error.kind === "aborted") return result;
      const { kind, status } = result.error;
      // 4xx·500 등 이미 받은 HTTP 응답은 본문 수신 timeout이 있어도 자동 재전송하지 않는다.
      const retryable = status !== undefined && status >= 400
        ? status === 503
        : kind === "network" || kind === "timeout";
      if (!retryable || index === 1) return result;
      // retry 간격은 미합의다. 이번에는 추가 대기 없이 재시도하며 최종 운영값으로 고정하지 않는다.
    }
    throw new Error("도달할 수 없는 요청 상태입니다.");
  }
  function getServerId(): string | null {
    const current = readConfig();
    return current.status === "ready" ? current.config.serverId : null;
  }
  return { request, getServerId };
}

export type ScheduleHttpClient = ReturnType<typeof createScheduleHttpClient>;
export const scheduleHttpClient = createScheduleHttpClient();
