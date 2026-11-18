import { createAssistantHttpClient, type AssistantHttpError, type AssistantHttpResult, type AssistantPostOptions } from "@/services/api/assistant";
import type { ApiTimers } from "@/services/api/transport";
import type { AssistantRequestStatusResponse } from "@/types/assistant-api";
import type { AssistantRecoveryReference } from "@/types/assistant-recovery";
import type { VoicePostResponse, VoiceRequest } from "@/types/voice-api";
import { isAssistantUuidV4, parseAssistantProblemDetails, parseAssistantRequestAcceptedResponse, parseAssistantRequestStatusResponse } from "@/utils/assistant-validation";
import { parseVoiceRequestAcceptedResponse, validVoiceRequest, validVoiceProblemStatus } from "@/utils/voice-validation";

export const VOICE_TIMEOUT_MS = 35_000;
export const SPEECH_MAX_BYTES = 8_388_608;
type Client = ReturnType<typeof createAssistantHttpClient>;
type Scope = Extract<ReturnType<Client["exchange"]["bind"]>, { modeGeneration: number }>;
type Context = { operation: "post" | "get"; serverId: string; assistantRequestId: string };
// A logical request stays owned until its invocation settles, even across connection generations.
// Identity checking prevents an older finally from releasing a different invocation's reservation.
const activePosts = new Map<string, object>();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Explicitly constructed foundation only. No recorder, screen, retries, files, or player. */
export function createVoiceHttpClient({ assistant = createAssistantHttpClient(), timers = { setTimeout, clearTimeout } }:
  { assistant?: Client; timers?: ApiTimers } = {}) {
  const core = assistant.exchange;
  async function exchange<T>(scope: Scope, context: Context, path: string, signal: AbortSignal | undefined,
    body: Uint8Array<ArrayBuffer> | undefined, consume: (response: Response, current: () => void,
      ownReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void) => Promise<T>, beforeSend?: () => boolean, onStaleResponse?: (value: T) => Promise<void>): Promise<AssistantHttpResult<T>> {
    let status: number | undefined, httpRequestId: string | null = null;
    let stopped = false, sent = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const controller = new AbortController();
    const failure = (kind: AssistantHttpError["kind"]) => core.failure(context, kind, { status, httpRequestId,
      requestState: status !== undefined ? "response-received" : sent ? "unconfirmed" : "not-sent" });
    let readerCancelled = false, readerReleased = false;
    const disposeReader = () => {
      if (!reader) return;
      if (!readerCancelled) {
        readerCancelled = true;
        try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
      }
      if (!readerReleased) {
        readerReleased = true;
        try { reader.releaseLock(); } catch {} // Cleanup must not replace the original result.
      }
    };
    const cancel = () => { disposeReader(); controller.abort(); };
    let interrupt!: (result: AssistantHttpResult<T>) => void;
    const interrupted = new Promise<AssistantHttpResult<T>>(resolve => { interrupt = resolve; });
    const abort = () => { stopped = true; interrupt(failure("aborted")); cancel(); };
    const current = () => {
      if (stopped || signal?.aborted || !core.isCurrent(scope)) throw new Error("inactive-exchange");
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = timers.setTimeout(() => { stopped = true; interrupt(failure("timeout")); cancel(); }, VOICE_TIMEOUT_MS);
    async function receive(): Promise<AssistantHttpResult<T>> {
      try {
        current();
        try { if (beforeSend && !beforeSend()) return failure("policy"); }
        catch { return failure("policy"); }
        current();
        sent = true;
        const response = await scope.send(`${scope.apiBaseUrl}${path}`, { method: body ? "POST" : "GET",
          headers: { Accept: body ? "application/json, application/problem+json" : "audio/wav, application/problem+json",
            ...(body ? { "Content-Type": "audio/wav" } : {}) }, body, signal: controller.signal, redirect: "error" });
        status = response.status;
        httpRequestId = response.headers.get("X-Request-ID");
        if (body === undefined && (stopped || signal?.aborted || !core.isCurrent(scope))) {
          // A response can arrive after the caller has already returned. Never read its chunks.
          try { if (response.body) { reader = response.body.getReader(); disposeReader(); } } catch {}
          current();
        }
        if (response.redirected) return failure("response");
        const media = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
        if (status >= 400) {
          current();
          if (media !== "application/problem+json") return failure("response");
          const problem = parseAssistantProblemDetails(JSON.parse(await response.text()));
          current();
          if (!problem || problem.status !== status || !validVoiceProblemStatus(status, problem.code, body === undefined) || !httpRequestId || !same(problem.requestId, httpRequestId) ||
            problem.assistantRequestId != null && !same(problem.assistantRequestId, context.assistantRequestId)) return failure("response");
          return { ok: false, error: { ...failure("http").error, problem } };
        }
        const data = await consume(response, current, value => { reader = value; });
        // Preserve valid original-server facts only while this HTTP exchange still owns the response.
        // After timeout/Abort, late observation is memory-only, matching the interruption boundary.
        if (!stopped && !signal?.aborted && !core.isCurrent(scope) && httpRequestId && onStaleResponse) await onStaleResponse(data);
        current();
        if (!httpRequestId) return failure("response");
        return { ok: true, data, status, serverId: scope.serverId, httpRequestId, metadata: { status: "not-applicable" } };
      } catch {
        if (!core.isCurrent(scope)) return failure("context-changed");
        if (signal?.aborted) return failure("aborted");
        return failure(status === undefined ? "network" : "response");
      }
    }
    try {
      const result = await Promise.race([receive(), interrupted]);
      return core.isCurrent(scope) ? result : failure("context-changed");
    } finally {
      stopped = true;
      timers.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      cancel();
      // Cancellation is best effort; request completion does not guarantee native resource release.
    }
  }
  function snapshotOptions(options: AssistantPostOptions): AssistantPostOptions | null {
    if (!options || typeof options !== "object" || typeof options.expectedServerId !== "string") return null;
    const { expectedServerId, expectedGeneration, signal, beforeSend } = options;
    if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) return null;
    if (beforeSend !== undefined && typeof beforeSend !== "function") return null;
    if (expectedGeneration !== undefined && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)) return null;
    return { expectedServerId, expectedGeneration, signal, beforeSend };
  }
  function bind(ref: AssistantRecoveryReference, options: AssistantPostOptions, operation: "post" | "get") {
    const context: Context = { operation, serverId: ref?.serverId, assistantRequestId: ref?.requestId };
    if (!ref || !isAssistantUuidV4(ref.requestId) || typeof ref.serverId !== "string") return core.failure(context, "request");
    if (options.expectedServerId !== ref.serverId) return core.failure(context, "server-mismatch");
    const scope = core.bind(context, ref.serverId);
    if ("ok" in scope) return scope;
    if (options.expectedGeneration !== undefined && scope.modeGeneration !== options.expectedGeneration) return core.failure(context, "context-changed");
    if (options.signal?.aborted) return core.failure(context, "aborted");
    return { context, scope };
  }
  async function postVoiceRequest(input: VoiceRequest, options: AssistantPostOptions): Promise<AssistantHttpResult<VoicePostResponse>> {
    const snapshot = snapshotOptions(options);
    if (!validVoiceRequest(input) || !snapshot) return core.failure({ operation: "post" }, "request");
    // Snapshot before await; File.bytes() output is accepted without JSON/base64 conversion.
    const bytes = new Uint8Array(input.bytes), requestId = input.requestId;
    const conversationId = input.conversationId, questionId = input.questionId;
    const { signal, beforeSend } = snapshot;
    const ref = { serverId: snapshot.expectedServerId, requestId };
    const bound = bind(ref, snapshot, "post");
    if ("ok" in bound) return bound;
    const { scope, context } = bound;
    const key = JSON.stringify([ref.serverId, requestId.toLowerCase()]);
    if (process.env.EXPO_PUBLIC_SCHEDULE_READ_ONLY === "true" || activePosts.has(key) || core.hasAcceptanceEvidence(ref)) return core.failure(context, "policy");
    const owner = {};
    activePosts.set(key, owner);
    try {
      let saved;
      try { saved = await core.recovery.saveBeforePost(ref, core.now()); }
      catch { return core.failure(context, "storage", { storageStage: "before-post", storageCode: "unknown" }); }
      const query = new URLSearchParams({ requestId });
      if (conversationId !== undefined) { query.set("conversationId", conversationId); query.set("questionId", questionId!); }
      const result = await exchange(scope, context, `/voice/requests?${query}`, signal, bytes, async response => {
        if (response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("media");
        const data: unknown = JSON.parse(await response.text());
        // Even a malformed 202 can carry trustworthy partial acceptance. Memory only, never UI success.
        const partial = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
        const evidence = parseAssistantRequestAcceptedResponse({ requestId: partial.requestId, conversationId: partial.conversationId, status: partial.status });
        const correlated = (value: AssistantRequestStatusResponse) => same(value.requestId, requestId) &&
          (conversationId === undefined || same(value.conversationId, conversationId)) &&
          (!saved.acceptConfirmed || same(value.conversationId, saved.conversationId!));
        if (response.status === 202 && evidence && correlated(evidence)) core.noteAcceptance(ref);
        const acceptance = response.status === 202 ? parseVoiceRequestAcceptedResponse(data) : null;
        const state = acceptance ? { requestId: acceptance.requestId, conversationId: acceptance.conversationId, status: acceptance.status } :
          response.status === 200 ? parseAssistantRequestStatusResponse(data) : null;
        if (!state || !correlated(state) || acceptance &&
          (questionId === undefined ? acceptance.input.type !== "text" || acceptance.input.questionId !== undefined :
            !same(acceptance.input.questionId ?? "", questionId))) throw new Error("contract");
        core.noteAcceptance(ref);
        return { state, ...(acceptance ? { acceptance } : {}) };
      }, () => {
        if (saved.acceptConfirmed || core.hasAcceptanceEvidence(ref)) return false;
        if (beforeSend?.({ ...saved }) === false) return false;
        return activePosts.get(key) === owner && !core.hasAcceptanceEvidence(ref);
      }, async value => {
        try { await core.recovery.recordResponse(ref, value.state, { expectedFirstPostAttemptAt: saved.firstPostAttemptAt }); } catch {}
      });
      if (!result.ok) return result;
      const recorded = await core.record({ ...result, data: result.data.state }, ref, scope, context, true, saved.firstPostAttemptAt);
      if (signal?.aborted) return core.failure(context, core.isCurrent(scope) ? "aborted" : "context-changed", {
        requestState: "response-received", status: result.status, httpRequestId: result.httpRequestId,
      });
      return recorded.ok ? { ...recorded, data: result.data } : recorded;
    } finally { if (activePosts.get(key) === owner) activePosts.delete(key); }
  }
  async function getSpeech(ref: AssistantRecoveryReference, options: AssistantPostOptions): Promise<AssistantHttpResult<Uint8Array>> {
    const snapshot = snapshotOptions(options);
    if (!snapshot) return core.failure({ operation: "get" }, "request");
    const reference = { serverId: ref?.serverId, requestId: ref?.requestId };
    const bound = bind(reference, snapshot, "get");
    if ("ok" in bound) return bound;
    return exchange(bound.scope, bound.context, `/voice/requests/${reference.requestId}/speech`, snapshot.signal, undefined,
      async (response, current, ownReader) => {
        current();
        if (response.status !== 200 || response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "audio/wav" || !response.body) throw new Error("contract");
        const reader = response.body.getReader(); ownReader(reader);
        const length = response.headers.get("Content-Length");
        const declared = length === null ? null : /^\d+$/.test(length) ? Number(length) : NaN;
        if (declared !== null && (!Number.isSafeInteger(declared) || declared > SPEECH_MAX_BYTES)) throw new Error("length");
        const chunks: Uint8Array[] = []; let total = 0;
        while (true) {
          current(); const chunk = await reader.read(); current();
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > SPEECH_MAX_BYTES - total) throw new Error("size");
          total += chunk.value.byteLength; if (chunk.value.byteLength) chunks.push(new Uint8Array(chunk.value));
        }
        if (declared !== null && total !== declared) throw new Error("truncated");
        const bytes = new Uint8Array(total); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return bytes;
      });
  }
  return { postVoiceRequest, getSpeech, hasAcceptanceEvidence: core.hasAcceptanceEvidence };
}
