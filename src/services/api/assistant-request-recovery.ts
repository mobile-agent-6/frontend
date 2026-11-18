import { classifyVoiceProblem } from "@/utils/voice-validation";
import { assistantHttpClient, type AssistantHttpResult } from "@/services/api/assistant";
import { assistantRecoveryStorage, AssistantRecoveryStorageError } from "@/services/storage/assistant-recovery";
import { scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import type { AssistantRequestCreate, AssistantRequestStatusResponse } from "@/types/assistant-api";
import type { AssistantRecoveryMetadata, AssistantRecoveryReference } from "@/types/assistant-recovery";
import { isAssistantRecoveryServerId } from "@/utils/assistant-recovery";
import { isAssistantUuidV4, parseAssistantRequestCreate } from "@/utils/assistant-validation";

import type { AssistantVoicePayload } from "@/services/assistant-voice-payload";
import type { VoiceRequestAcceptedResponse, VoiceTransmission } from "@/types/voice-api";

type HttpResult = AssistantHttpResult<AssistantRequestStatusResponse>;
export type AssistantRequestRecoveryReason =
  | "file" | "invalid-request" | "busy" | "existing-request" | "missing-session-body" | "accept-confirmed"
  | "post-not-unconfirmed" | "retry-used" | "deadline" | "metadata-mismatch"
  | "server-mismatch" | "context-changed" | "policy" | "aborted" | "storage" | "http-error" | "post-unconfirmed";
export type AssistantRequestRecoveryResult = { reference: AssistantRecoveryReference; retransmitted: boolean; voiceTransmission?: VoiceTransmission } & (
  | { kind: "confirmed"; via: "initial-post" | "get" | "resend"; response: Extract<HttpResult, { ok: true }>; acceptance?: VoiceRequestAcceptedResponse }
  | { kind: "unconfirmed"; reason: AssistantRequestRecoveryReason; getResult?: HttpResult; postResult?: HttpResult;
      storageCode?: AssistantRecoveryStorageError["code"] | "unknown"; definitiveRejection?: boolean }
);

type SessionRequest = {
  body: string | null;
  voice?: AssistantVoicePayload;
  voiceIdentity?: object;
  voiceTransmission?: VoiceTransmission;
  existingRecord?: boolean;
  canSend?: () => boolean;
  generation: number;
  firstPostAttemptAt?: number;
  lastPostAttemptAt?: number;
  confirmed: boolean;
  unconfirmed: boolean;
  retryUsed: boolean;
  aborted: boolean;
};

// 같은 JS runtime의 factory·호출자가 같은 서버/논리 ID의 작업을 중복 실행하지 않게 공유한다.
const inFlight = new Map<string, { generation: number; token: symbol }>();
const leases = new Map<string, { generation: number; token: symbol }>();
const sessions = new Map<string, SessionRequest>();
const RETRANSMIT_WINDOW_MS = 120_000;
const keyOf = (ref: AssistantRecoveryReference) => JSON.stringify([ref.serverId, ref.requestId.toLowerCase()]);
const matches = (a: AssistantRecoveryReference, b: AssistantRecoveryReference) =>
  a.serverId === b.serverId && a.requestId.toLowerCase() === b.requestId.toLowerCase();

function validReference(ref: AssistantRecoveryReference) {
  return isAssistantRecoveryServerId(ref.serverId) && isAssistantUuidV4(ref.requestId);
}

const releaseListeners = new Set<() => void>();

function notifyRelease() {
  for (const listener of [...releaseListeners]) listener();
}

export function afterAssistantRelease<T>(ref: AssistantRecoveryReference, generation: number, signal: AbortSignal, start: () => T) {
  const key = keyOf(ref);
  return new Promise<T | undefined>((resolve, reject) => {
    const check = () => {
      if (!signal.aborted && (leases.get(key)?.generation === generation || inFlight.get(key)?.generation === generation)) return;
      releaseListeners.delete(check);
      signal.removeEventListener("abort", check);
      try { resolve(signal.aborted ? undefined : start()); } catch (error) { reject(error); }
    };
    releaseListeners.add(check);
    signal.addEventListener("abort", check);
    check();
  });
}

// polling 전체를 예약하되 내부의 단일 POST/GET 잠금은 그대로 사용한다.
export function acquireAssistantRequestLease(ref: AssistantRecoveryReference, generation = scheduleDataModeStore.getState().generation) {
  if (!validReference(ref)) return null;
  const key = keyOf(ref);
  if (inFlight.get(key)?.generation === generation || leases.get(key)?.generation === generation) return null;
  const token = Symbol();
  leases.set(key, { generation, token });
  return { token, release: () => { if (leases.get(key)?.token === token) { leases.delete(key); notifyRelease(); } } };
}

type RecoveryOptions = { signal?: AbortSignal; lease?: symbol; allowResend?: boolean; canRetransmit?: () => boolean };
const isBusy = (key: string, generation: number, lease?: symbol) => inFlight.get(key)?.generation === generation || (leases.get(key)?.generation === generation && leases.get(key)?.token !== lease);

export function createAssistantRequestRecovery({
  http = assistantHttpClient,
  recovery = assistantRecoveryStorage,
  now = Date.now,
  readMode = () => scheduleDataModeStore.getState(),
}: {
  http?: Pick<typeof assistantHttpClient, "postAssistantRequest" | "getAssistantRequest" | "getServerId" | "hasAcceptanceEvidence">;
  recovery?: Pick<typeof assistantRecoveryStorage, "read"> & Partial<Pick<typeof assistantRecoveryStorage, "cleanup">>;
  now?: () => number;
  readMode?: () => { mode: "server" | "mock"; generation: number };
} = {}) {
  function getVoiceTransmission(ref: AssistantRecoveryReference, identity?: object): VoiceTransmission | undefined {
    if (!validReference(ref)) return;
    const session = sessions.get(keyOf(ref));
    if (!session?.voiceIdentity || identity !== undefined && session.voiceIdentity !== identity) return;
    const evidence = session.voice?.getTransmission() ?? session.voiceTransmission;
    if (!evidence) return;
    if (session.confirmed || http.hasAcceptanceEvidence(ref)) return { ...evidence, state: "accepted" };
    // This payload did not send, but an older stored logical request is not proven unsent.
    return session.existingRecord ? undefined : evidence;
  }
  function unresolved(reference: AssistantRecoveryReference, reason: AssistantRequestRecoveryReason,
    details: { getResult?: HttpResult; postResult?: HttpResult; retransmitted?: boolean;
      storageCode?: AssistantRecoveryStorageError["code"] | "unknown"; definitiveRejection?: boolean } = {}, identity?: object): AssistantRequestRecoveryResult {
    const voiceTransmission = getVoiceTransmission(reference, identity);
    return { kind: "unconfirmed", reference: { ...reference }, reason, retransmitted: false, ...details, ...(voiceTransmission ? { voiceTransmission } : {}) };
  }
  function boundary(ref: AssistantRecoveryReference, generation: number, signal?: AbortSignal): AssistantRequestRecoveryReason | null {
    if (signal?.aborted) return "aborted";
    if (http.getServerId() !== ref.serverId) return "server-mismatch";
    const mode = readMode();
    if (mode.mode !== "server") return "policy";
    return mode.generation === generation ? null : "context-changed";
  }
  function observe(session: SessionRequest | undefined, response: HttpResult, signal?: AbortSignal) {
    if (!session) return;
    if (response.ok) { session.voice?.accepted(); session.confirmed = true; session.unconfirmed = false; session.body = null; }
    if (signal?.aborted || (!response.ok && response.error.kind === "aborted")) {
      session.aborted = true; session.body = null;
    }
    if (!response.ok && ["context-changed", "server-mismatch", "policy"].includes(response.error.kind)) session.body = null;
  }
  function eligible(session: SessionRequest | undefined, metadata: AssistantRecoveryMetadata | null,
    ref: AssistantRecoveryReference): AssistantRequestRecoveryReason | null {
    if (session?.confirmed || metadata?.acceptConfirmed || http.hasAcceptanceEvidence(ref)) return "accept-confirmed";
    if (session?.aborted) return "aborted";
    if (session?.retryUsed) return "retry-used";
    if (!session?.body && !session?.voice) return "missing-session-body";
    if (session?.voice && !session.voice.canSend()) return "context-changed";
    if (!session.unconfirmed) return "post-not-unconfirmed";
    if (!metadata || !matches(metadata, ref) || metadata.firstPostAttemptAt !== session.firstPostAttemptAt) return "metadata-mismatch";
    const elapsed = now() - metadata.firstPostAttemptAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= RETRANSMIT_WINDOW_MS) return "deadline";
    return null;
  }

  // 재전송 가능한 최초 요청은 이 진입점으로 시작해 실제 저장 시각·원본 body·접수 증거를 함께 추적한다.
  // 기존 HTTP를 직접 호출한 요청이나 앱 재실행 후 항목은 recover에서 GET만 가능하다.
  async function startRequest(input: AssistantRequestCreate | Pick<AssistantRequestCreate, "requestId">,
    options: { expectedServerId: string; signal?: AbortSignal; lease?: symbol; canSend?: () => boolean }, voice?: AssistantVoicePayload): Promise<AssistantRequestRecoveryResult> {
    const ref = { serverId: options?.expectedServerId, requestId: input?.requestId };
    const signal = options?.signal;
    const deny = (reason: AssistantRequestRecoveryReason, details: Parameters<typeof unresolved>[2] = {}) =>
      unresolved(ref, reason, details, voice?.identity);
    if (!validReference(ref)) return deny("invalid-request");
    let body: string, snapshot: AssistantRequestCreate | undefined;
    try {
      if (!voice && !parseAssistantRequestCreate(input)) return deny("invalid-request");
      body = voice ? "" : JSON.stringify(input);
      const parsed = voice ? undefined : parseAssistantRequestCreate(JSON.parse(body));
      if (!voice && (!parsed || !matches(ref, { serverId: ref.serverId, requestId: parsed.requestId }))) return deny("invalid-request");
      snapshot = parsed ?? undefined;
    } catch { return deny("invalid-request"); }
    const key = keyOf(ref);
    if (isBusy(key, readMode().generation, options.lease)) return deny("busy");
    if (sessions.has(key)) return deny("existing-request");
    const generation = readMode().generation;
    const blocked = boundary(ref, generation, signal);
    if (blocked) return deny(blocked);
    const workToken = Symbol(); inFlight.set(key, { generation, token: workToken });
    const session: SessionRequest = { body, voice, voiceIdentity: voice?.identity, canSend: options.canSend, generation, confirmed: false, unconfirmed: false, retryUsed: false, aborted: false };
    // Claim only this voice payload before the first await. Reading metadata is not a POST.
    if (voice) sessions.set(key, session);
    try {
      const existing = await recovery.read(ref);
      if (existing) { session.existingRecord = true; session.confirmed = existing.acceptConfirmed; return deny("existing-request"); }
      const changed = boundary(ref, generation, signal);
      if (changed) return deny(changed);
      if (!voice) sessions.set(key, session);
      const startedAt = now();
      let guardReason: AssistantRequestRecoveryReason | null = null;
      let acceptance: VoiceRequestAcceptedResponse | undefined;
      const post = async (args: Parameters<typeof http.postAssistantRequest>[1]): Promise<HttpResult> => {
        if (!session.voice) return http.postAssistantRequest(snapshot!, args);
        const payload = session.voice;
        const result = await payload.post(args);
        if (!result.ok) return result;
        acceptance = result.data.acceptance; payload.accepted();
        return { ...result, data: result.data.state };
      };
      const response = await post({ expectedServerId: ref.serverId, signal, expectedGeneration: generation, beforeSend: saved => {
        guardReason = boundary(ref, generation, signal) ?? (session.canSend?.() === false ? "context-changed" : null);
        if (!guardReason && (saved.acceptConfirmed || http.hasAcceptanceEvidence(ref))) guardReason = "accept-confirmed";
        if (!guardReason && (!matches(saved, ref) ||
          saved.firstPostAttemptAt !== saved.lastPostAttemptAt || saved.firstPostAttemptAt < startedAt)) guardReason = "metadata-mismatch";
        if (guardReason) return false;
        session.firstPostAttemptAt = saved.firstPostAttemptAt;
        session.lastPostAttemptAt = saved.lastPostAttemptAt;
        return true;
      } });
      observe(session, response, signal);
      if (http.hasAcceptanceEvidence(ref)) session.voice?.accepted();
      if (response.ok) return { kind: "confirmed", via: "initial-post", reference: ref, retransmitted: false, response, ...(acceptance ? { acceptance } : {}) };
      if (session.voice && response.error.kind === "http" && response.error.problem?.assistantRequestId?.toLowerCase() === ref.requestId.toLowerCase() &&
        classifyVoiceProblem(response.error.status!, response.error.problem.code) === "rejection-candidate" &&
        session.firstPostAttemptAt !== undefined && session.firstPostAttemptAt === session.lastPostAttemptAt && recovery.cleanup) {
        const removed = await recovery.cleanup(ref, ref.serverId, { type: "voice-rejected", requestId: ref.requestId,
          firstPostAttemptAt: session.firstPostAttemptAt, lastPostAttemptAt: session.lastPostAttemptAt,
          httpStatus: response.error.status!, code: response.error.problem.code }, {
          isCurrent: () => !boundary(ref, generation, signal) && inFlight.get(key)?.token === workToken &&
            session.canSend?.() !== false && !http.hasAcceptanceEvidence(ref),
        });
        if (removed === "removed") { session.voice.rejected(); return deny("post-unconfirmed", { postResult: response, definitiveRejection: true }); }
      }
      session.unconfirmed = response.error.requestState !== "not-sent" && (["network", "timeout", "response"].includes(response.error.kind) || !!session.voice && response.error.kind === "http" && response.error.problem?.code === "VOICE_BUSY");
      if (!session.unconfirmed) session.body = null;
      return deny(guardReason ?? (signal?.aborted ? "aborted" : response.error.kind === "storage" ? "storage" : "post-unconfirmed"), { postResult: response });
    } catch (error) {
      return deny(voice && !(error instanceof AssistantRecoveryStorageError) ? "file" : "storage", { storageCode: error instanceof AssistantRecoveryStorageError ? error.code : "unknown" });
    } finally { if (inFlight.get(key)?.token === workToken) { inFlight.delete(key); notifyRelease(); } }
  }

  async function recoverAssistantRequest(reference: AssistantRecoveryReference,
    options: RecoveryOptions = {}): Promise<AssistantRequestRecoveryResult> {
    const ref = { ...reference };
    const signal = options.signal;
    if (!validReference(ref)) return unresolved(ref, "invalid-request");
    const key = keyOf(ref), session = sessions.get(key);
    if (isBusy(key, readMode().generation, options.lease)) return unresolved(ref, "busy");
    // GET-only 재개는 현재 모드 세대를 사용하되 원래 body 재전송의 세대 검사는 완화하지 않는다.
    const generation = options.allowResend === false ? readMode().generation : session?.generation ?? readMode().generation;
    const blocked = boundary(ref, generation, signal);
    if (blocked) {
      if (blocked === "aborted" && session) { session.aborted = true; session.body = null; }
      return unresolved(ref, blocked);
    }
    const workToken = Symbol(); inFlight.set(key, { generation, token: workToken });
    let getResult: HttpResult | undefined;
    try {
      getResult = await http.getAssistantRequest(ref, { signal, expectedGeneration: generation });
      observe(session, getResult, signal);
      const changed = boundary(ref, generation, signal);
      if (changed) return unresolved(ref, changed, { getResult });
      if (getResult.ok) return { kind: "confirmed", via: "get", reference: ref, retransmitted: false, response: getResult };
      if (getResult.error.kind !== "http" || getResult.error.status !== 404 ||
        getResult.error.problem?.code !== "ASSISTANT_REQUEST_NOT_FOUND") {
        return unresolved(ref, getResult.error.kind === "aborted" ? "aborted" : getResult.error.kind === "storage" ? "storage" : "http-error", { getResult });
      }
      if (options.allowResend === false) return unresolved(ref, "post-not-unconfirmed", { getResult });
      const metadata = await recovery.read(ref);
      if (signal?.aborted && session) { session.aborted = true; session.body = null; }
      const reason = boundary(ref, generation, signal) ?? eligible(session, metadata, ref) ??
        (options.canRetransmit?.() === false ? "deadline" : null);
      if (reason || !session || !session.body && !session.voice) {
        if (session && (reason === "accept-confirmed" || reason === "deadline")) session.body = null;
        return unresolved(ref, reason ?? "missing-session-body", { getResult });
      }
      if (metadata?.lastPostAttemptAt !== session.lastPostAttemptAt) return unresolved(ref, "metadata-mismatch", { getResult });
      let guardReason: AssistantRequestRecoveryReason | null = null;
      let acceptance: VoiceRequestAcceptedResponse | undefined;
      const post = async (args: Parameters<typeof http.postAssistantRequest>[1]): Promise<HttpResult> => {
        if (!session.voice) return http.postAssistantRequest(JSON.parse(session.body!), args);
        const payload = session.voice;
        const result = await payload.post(args);
        if (!result.ok) return result;
        acceptance = result.data.acceptance; payload.accepted();
        return { ...result, data: result.data.state };
      };
      const postResult = await post({
        expectedServerId: ref.serverId, signal, expectedGeneration: generation, beforeSend: saved => {
          guardReason = boundary(ref, generation, signal) ?? eligible(session, saved, ref) ??
            (session.canSend?.() === false ? "context-changed" : null) ??
            (options.canRetransmit?.() === false ? "deadline" : null);
          if (guardReason === "aborted") { session.aborted = true; session.body = null; }
          if (guardReason) return false;
          // 저장 대기 중 바뀐 접수 여부·deadline까지 확인한 뒤 요청당 한 번의 재전송 권한을 소비한다.
          session.retryUsed = true;
          session.lastPostAttemptAt = saved.lastPostAttemptAt;
          return true;
        },
      });
      observe(session, postResult, signal);
      if (session.retryUsed) { session.body = null; session.voiceTransmission = getVoiceTransmission(ref); void session.voice?.dispose(); session.voice = undefined; }
      if (postResult.ok) return { kind: "confirmed", via: "resend", reference: ref, retransmitted: session.retryUsed, response: postResult, ...(acceptance ? { acceptance } : {}) };
      return unresolved(ref, guardReason ?? (signal?.aborted ? "aborted" : postResult.error.kind === "storage" ? "storage" : "post-unconfirmed"),
        { getResult, postResult, retransmitted: session.retryUsed });
    } catch (error) {
      return unresolved(ref, session?.voice && !(error instanceof AssistantRecoveryStorageError) ? "file" : "storage",
        { getResult, storageCode: error instanceof AssistantRecoveryStorageError ? error.code : "unknown" });
    } finally { if (inFlight.get(key)?.token === workToken) { inFlight.delete(key); notifyRelease(); } }
  }
  const queryAssistantRequest = (ref: AssistantRecoveryReference, options: Omit<RecoveryOptions, "allowResend" | "canRetransmit"> = {}) =>
    recoverAssistantRequest(ref, { ...options, allowResend: false });
  const startAssistantRequest = (input: AssistantRequestCreate, options: { expectedServerId: string; signal?: AbortSignal; lease?: symbol }) =>
    startRequest(input, options);
  const startVoiceRequest = (voice: AssistantVoicePayload, options: { expectedServerId: string; signal?: AbortSignal; lease?: symbol; canSend?: () => boolean }) =>
    startRequest({ requestId: voice.requestId }, options, voice);
  const releaseVoiceRequest = (ref: AssistantRecoveryReference) => {
    const session = sessions.get(keyOf(ref));
    if (session?.voice) { session.voiceTransmission = getVoiceTransmission(ref); void session.voice.dispose(); session.voice = undefined; }
    if (session) session.canSend = undefined;
  };
  return { startAssistantRequest, startVoiceRequest, getVoiceTransmission, releaseVoiceRequest, recoverAssistantRequest, queryAssistantRequest };
}

// import와 factory 생성만으로 POST·GET·저장 작업을 시작하지 않는다.
export const assistantRequestRecovery = createAssistantRequestRecovery();
