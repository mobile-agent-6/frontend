import { fetch as expoFetch } from "expo/fetch";

import { getDevelopmentServerConfig, parseDevelopmentServerConfig, type DevelopmentServerConfig } from "@/services/api/config";
import { assistantRecoveryStorage, AssistantRecoveryStorageError } from "@/services/storage/assistant-recovery";
import { scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import type {
  AssistantCancelRequest,
  AssistantCancelResponse,
  AssistantProblemDetails,
  AssistantRequestCreate,
  AssistantRequestStatusResponse,
} from "@/types/assistant-api";
import type { AssistantRecoveryReference } from "@/types/assistant-recovery";
import {
  isAssistantUuidV4,
  parseAssistantCancelRequest,
  parseAssistantCancelResponse,
  parseAssistantProblemDetails,
  parseAssistantRequestAcceptedResponse,
  parseAssistantRequestCreate,
  parseAssistantRequestStatusResponse,
  validateAssistantJsonBodySize,
} from "@/utils/assistant-validation";

type StorageCode = AssistantRecoveryStorageError["code"] | "unknown";
export type AssistantMetadataUpdate =
  | { status: "updated" | "not-tracked" | "not-applicable" }
  | { status: "failed"; code: StorageCode };

export type AssistantHttpError = {
  kind: "configuration" | "request" | "storage" | "policy" | "server-mismatch" | "context-changed" |
    "network" | "timeout" | "aborted" | "http" | "response";
  // 전송/응답 수신 상태이며 서버 write 성공·실패 또는 취소 확정 판정이 아니다.
  requestState: "not-sent" | "unconfirmed" | "response-received";
  operation: "post" | "get" | "cancel";
  serverId?: string;
  assistantRequestId?: string;
  conversationId?: string;
  httpRequestId?: string | null;
  status?: number;
  problem?: AssistantProblemDetails;
  configurationStatus?: "missing" | "invalid";
  storageStage?: "before-post" | "before-get";
  storageCode?: StorageCode;
};
type ResponseResult<T> =
  | { ok: true; data: T; status: number; serverId: string; httpRequestId: string | null }
  | { ok: false; error: AssistantHttpError };
export type AssistantHttpResult<T> =
  | (Extract<ResponseResult<T>, { ok: true }> & { metadata: AssistantMetadataUpdate })
  | Extract<ResponseResult<T>, { ok: false }>;

export type AssistantRequestOptions = { expectedServerId: string; signal?: AbortSignal };
// cancel 전용 timeout 수치는 미합의다. 호출자 취소 신호를 필수로 받고 임의 기본값은 두지 않는다.
export type AssistantCancelOptions = { expectedServerId: string; signal: AbortSignal };
type RecoveryStorage = Pick<typeof assistantRecoveryStorage, "saveBeforePost" | "read" | "recordResponse">;
type Context = Pick<AssistantHttpError, "operation" | "serverId" | "assistantRequestId" | "conversationId">;
type BoundServer = DevelopmentServerConfig & { modeGeneration: number };

const RESPONSE_TIMEOUT_MS = 5_000;
const sameUuid = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const storageCode = (error: unknown): StorageCode => error instanceof AssistantRecoveryStorageError ? error.code : "unknown";
function validSignal(signal: AbortSignal | undefined) {
  return signal === undefined || (signal !== null && typeof signal.aborted === "boolean" &&
    typeof signal.addEventListener === "function" && typeof signal.removeEventListener === "function");
}

// 실제 전송할 문자열을 첫 await 전에 고정한다. 원문/필드를 정규화하거나 영속 저장하지 않는다.
function snapshotBody<T>(value: unknown, validate: (value: unknown) => T | null): { body: string; data: T } | null {
  try {
    if (!validate(value)) return null;
    const body = JSON.stringify(value);
    if (typeof body !== "string" || !validateAssistantJsonBodySize(body).ok) return null;
    const data = validate(JSON.parse(body));
    return data ? { body, data } : null;
  } catch { return null; }
}

export function createAssistantHttpClient({
  fetchImpl,
  recovery = assistantRecoveryStorage,
  readConfig = getDevelopmentServerConfig,
  readMode = () => scheduleDataModeStore.getState(),
  now = Date.now,
}: {
  fetchImpl?: typeof fetch;
  recovery?: RecoveryStorage;
  readConfig?: typeof getDevelopmentServerConfig;
  readMode?: () => { mode: "server" | "mock"; generation: number };
  now?: () => number;
} = {}) {
  function config() {
    try {
      const current = readConfig();
      if (current.status !== "ready") return current;
      const canonical = parseDevelopmentServerConfig(current.config.baseUrl);
      if (canonical.status !== "ready" || canonical.config.baseUrl !== current.config.baseUrl ||
        canonical.config.apiBaseUrl !== current.config.apiBaseUrl || canonical.config.serverId !== current.config.serverId) {
        return { status: "invalid" as const };
      }
      return canonical;
    } catch { return { status: "invalid" as const }; }
  }

  function failure(context: Context, kind: AssistantHttpError["kind"], details: Partial<AssistantHttpError> = {}): Extract<ResponseResult<never>, { ok: false }> {
    return { ok: false, error: { ...context, kind, requestState: "not-sent", ...details } };
  }
  function bind(context: Context, expectedServerId: string): BoundServer | Extract<ResponseResult<never>, { ok: false }> {
    const current = config();
    if (current.status !== "ready") return failure(context, "configuration", { configurationStatus: current.status });
    if (current.config.serverId !== expectedServerId) return failure(context, "server-mismatch");
    const mode = readMode();
    if (mode.mode !== "server") return failure(context, "policy");
    return { ...current.config, modeGeneration: mode.generation };
  }
  function isCurrent(server: BoundServer) {
    const current = config(), mode = readMode();
    return current.status === "ready" && current.config.serverId === server.serverId &&
      current.config.apiBaseUrl === server.apiBaseUrl && mode.mode === "server" && mode.generation === server.modeGeneration;
  }

  // 한 번의 HTTP 교환만 수행한다. retry·GET-first 복구·polling·복구 항목 정리는 호출자 책임이다.
  async function send<T>(server: BoundServer, context: Context, path: string, method: "POST" | "GET", body: string | undefined,
    signal: AbortSignal | undefined, timeoutMs: number | null, parse: (data: unknown, status: number) => T | null): Promise<ResponseResult<T>> {
    if (signal?.aborted) return failure(context, "aborted");
    if (!isCurrent(server)) return failure(context, "context-changed");
    const controller = new AbortController();
    let status: number | undefined, httpRequestId: string | null = null;
    let timedOut = false;
    const error = (kind: AssistantHttpError["kind"], problem?: AssistantProblemDetails) => failure(context, kind, {
      requestState: status === undefined ? "unconfirmed" : "response-received", status, httpRequestId, problem,
    });
    let interrupt!: (result: ResponseResult<T>) => void;
    const interrupted = new Promise<ResponseResult<T>>(resolve=>{ interrupt = resolve; });
    const onAbort = () => { interrupt(error("aborted")); controller.abort(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = timeoutMs === null ? null : setTimeout(() => {
      timedOut = true;
      interrupt(error("timeout"));
      controller.abort();
    }, timeoutMs);
    const receive = async (): Promise<ResponseResult<T>> => {
      try {
        const headers = new Headers({ Accept: "application/json, application/problem+json" });
        if (body !== undefined) headers.set("Content-Type", "application/json");
        // Expo fetch는 RN의 기본 fetch와 달리 redirect:error를 지원한다. GET도 원래 origin 밖으로 보내지 않는다.
        const response = await (fetchImpl ?? expoFetch)(`${server.apiBaseUrl}${path}`, {
          method, headers, body, signal: controller.signal, redirect: "error",
        });
        status = response.status;
        httpRequestId = response.headers.get("X-Request-ID");
        const mediaType = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
        if (mediaType !== "application/json" && mediaType !== "application/problem+json") return error("response");
        let data: unknown;
        try { data = JSON.parse(await response.text()); }
        catch { return error(timedOut ? "timeout" : signal?.aborted ? "aborted" : "response"); }
        if (status >= 200 && status < 300) {
          if (mediaType !== "application/json" || !httpRequestId) return error("response");
          const parsed = parse(data, status);
          return parsed ? { ok: true, data: parsed, status, serverId: server.serverId, httpRequestId } : error("response");
        }
        const problem = mediaType === "application/problem+json" ? parseAssistantProblemDetails(data) : null;
        if (!problem) return error("response");
        if (problem.status !== status || !httpRequestId || !sameUuid(problem.requestId, httpRequestId) ||
          (context.assistantRequestId !== undefined && problem.assistantRequestId != null &&
            !sameUuid(context.assistantRequestId, problem.assistantRequestId))) return error("response", problem);
        return error("http", problem);
      } catch { return error(timedOut ? "timeout" : signal?.aborted ? "aborted" : "network"); }
    };
    try {
      // 호출자 취소·timeout 이후 도착한 receive에는 storage 등의 부수 효과를 두지 않는다.
      const result = await Promise.race([receive(), interrupted]);
      if (!isCurrent(server)) return result.ok
        ? failure(context, "context-changed", { requestState: "response-received", status: result.status, httpRequestId: result.httpRequestId })
        : { ok: false, error: { ...result.error, kind: "context-changed" } };
      return result;
    } finally {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function record<T extends AssistantRequestStatusResponse>(result: ResponseResult<T>, ref: AssistantRecoveryReference,
    server: BoundServer, context: Context, tracked: boolean): Promise<AssistantHttpResult<T>> {
    if (!result.ok) return result;
    let metadata: AssistantMetadataUpdate = { status: "not-tracked" };
    if (tracked) {
      try { await recovery.recordResponse(ref, result.data); metadata = { status: "updated" }; }
      catch (error) { metadata = { status: "failed", code: storageCode(error) }; }
    }
    if (!isCurrent(server)) return failure(context, "context-changed", {
      requestState: "response-received", status: result.status, httpRequestId: result.httpRequestId,
    });
    // 확인한 HTTP 성공을 storage 실패로 미전송 처리하거나 같은 POST를 재실행하지 않는다.
    return { ...result, metadata };
  }

  async function postAssistantRequest(input: AssistantRequestCreate, options: AssistantRequestOptions): Promise<AssistantHttpResult<AssistantRequestStatusResponse>> {
    const payload = snapshotBody(input, parseAssistantRequestCreate);
    const context: Context = { operation: "post", assistantRequestId: payload?.data.requestId, serverId: options?.expectedServerId };
    if (!payload || typeof options?.expectedServerId !== "string" || !validSignal(options.signal)) return failure(context, "request");
    const signal = options.signal;
    const server = bind(context, options.expectedServerId);
    if ("ok" in server) return server;
    if (signal?.aborted) return failure(context, "aborted");
    const ref = { serverId: server.serverId, requestId: payload.data.requestId };
    let saved;
    try { saved = await recovery.saveBeforePost(ref, now()); }
    catch (error) { return failure(context, "storage", { storageStage: "before-post", storageCode: storageCode(error) }); }
    const result = await send(server, context, "/assistant/requests", "POST", payload.body, signal, RESPONSE_TIMEOUT_MS, (data, status) => {
      const parsed = status === 202 ? parseAssistantRequestAcceptedResponse(data) : status === 200 ? parseAssistantRequestStatusResponse(data) : null;
      if (!parsed || !sameUuid(parsed.requestId, ref.requestId) ||
        (payload.data.conversationId !== undefined && !sameUuid(payload.data.conversationId, parsed.conversationId)) ||
        (saved.acceptConfirmed && !sameUuid(saved.conversationId, parsed.conversationId))) return null;
      return parsed;
    });
    return record(result, ref, server, context, true);
  }

  async function getAssistantRequest(reference: AssistantRecoveryReference, options: { signal?: AbortSignal } = {}): Promise<AssistantHttpResult<AssistantRequestStatusResponse>> {
    const ref = { serverId: reference?.serverId, requestId: reference?.requestId };
    const context: Context = { operation: "get", serverId: ref.serverId, assistantRequestId: ref.requestId };
    if (!isAssistantUuidV4(ref.requestId) || typeof ref.serverId !== "string" || !validSignal(options.signal)) return failure(context, "request");
    const signal = options.signal;
    const server = bind(context, ref.serverId);
    if ("ok" in server) return server;
    if (signal?.aborted) return failure(context, "aborted");
    let saved;
    try { saved = await recovery.read(ref); }
    catch (error) { return failure(context, "storage", { storageStage: "before-get", storageCode: storageCode(error) }); }
    const result = await send(server, context, `/assistant/requests/${ref.requestId}`, "GET", undefined, signal, RESPONSE_TIMEOUT_MS, (data, status) => {
      const parsed = status === 200 ? parseAssistantRequestStatusResponse(data) : null;
      return parsed && sameUuid(parsed.requestId, ref.requestId) &&
        (!saved?.acceptConfirmed || sameUuid(saved.conversationId, parsed.conversationId)) ? parsed : null;
    });
    // blockingRequestId/activeQuestionRequestId 등 미저장 ID의 GET에서는 모르는 POST 시각을 만들지 않는다.
    return record(result, ref, server, context, saved !== null);
  }

  async function cancelAssistantConversation(conversationId: string, input: AssistantCancelRequest,
    options: AssistantCancelOptions): Promise<AssistantHttpResult<AssistantCancelResponse>> {
    const payload = snapshotBody(input, parseAssistantCancelRequest);
    const context: Context = { operation: "cancel", conversationId, serverId: options?.expectedServerId,
      assistantRequestId: payload?.data.target.type === "request" ? payload.data.target.id : undefined };
    if (!isAssistantUuidV4(conversationId) || !payload || typeof options?.expectedServerId !== "string" ||
      !options.signal || !validSignal(options.signal)) return failure(context, "request");
    const signal = options.signal;
    const server = bind(context, options.expectedServerId);
    if ("ok" in server) return server;
    const result = await send(server, context, `/assistant/conversations/${conversationId}/cancel`, "POST", payload.body, signal, null, (data, status) => {
      const parsed = status === 200 ? parseAssistantCancelResponse(data) : null;
      return parsed && parsed.target.type === payload.data.target.type && sameUuid(parsed.target.id, payload.data.target.id) ? parsed : null;
    });
    return result.ok ? { ...result, metadata: { status: "not-applicable" } } : result;
  }

  function getServerId(): string | null {
    const current = config();
    return current.status === "ready" ? current.config.serverId : null;
  }
  return { postAssistantRequest, getAssistantRequest, cancelAssistantConversation, getServerId };
}

// import만으로 storage나 서버에 접근하지 않는다.
export const assistantHttpClient = createAssistantHttpClient();
