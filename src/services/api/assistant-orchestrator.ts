import { AppState } from "react-native";

import { assistantHttpClient, type AssistantHttpResult } from "@/services/api/assistant";
import {
  acquireAssistantRequestLease,
  assistantRequestRecovery,
  type AssistantRequestRecoveryResult,
} from "@/services/api/assistant-request-recovery";
import { assistantRecoveryStorage, AssistantRecoveryStorageError } from "@/services/storage/assistant-recovery";
import { scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import type { AssistantRequestCreate, AssistantRequestStatusResponse } from "@/types/assistant-api";
import type { AssistantRecoveryMetadata, AssistantRecoveryReference } from "@/types/assistant-recovery";
import { isAssistantRecoveryServerId } from "@/utils/assistant-recovery";
import { isAssistantUuidV4, parseAssistantRequestCreate } from "@/utils/assistant-validation";

type Response = Extract<AssistantHttpResult<AssistantRequestStatusResponse>, { ok: true }>;
export type AssistantExecutionReason = "invalid-request" | "busy" | "initializing" | "aborted" | "paused" |
  "server-mismatch" | "context-changed" | "policy" | "deadline" | "clock" | "metadata-mismatch" |
  "storage" | "unconfirmed" | "observer-error" | "internal";
export type AssistantExecutionResult = { reference: AssistantRecoveryReference } & (
  | { kind: "completed"; response: Response & { data: Extract<AssistantRequestStatusResponse, { status: "completed" }> } }
  | { kind: "observed"; response: Response & { data: Extract<AssistantRequestStatusResponse, { status: "accepted" | "processing" }> } }
  | { kind: "needs-attention"; reason: AssistantExecutionReason; lastResponse?: Response;
      recoveryResult?: AssistantRequestRecoveryResult; storageCode?: AssistantRecoveryStorageError["code"] | "unknown" }
);
export type AssistantExecutionEvent = { reference: AssistantRecoveryReference } & (
  | { phase: "posting" | "recovering" | "querying" | "waiting" }
  | { phase: "status"; response: Response }
);
export type AssistantExecutionOptions = { signal?: AbortSignal; onUpdate?: (event: AssistantExecutionEvent) => void };
export type AssistantRequestTask = {
  // 최초 GET 확인과 루프 완료를 분리해 초기화에서 새 입력을 120초 동안 기다리게 하지 않는다.
  initial: Promise<AssistantExecutionResult>;
  completion: Promise<AssistantExecutionResult>;
  cancel: () => void;
};
export type AssistantRecoveryInitialization =
  | { kind: "initialized"; serverId: string; requests: { reference: AssistantRecoveryReference;
      initial: AssistantExecutionResult; task: AssistantRequestTask }[] }
  | { kind: "needs-attention"; reason: AssistantExecutionReason; storageCode?: AssistantRecoveryStorageError["code"] | "unknown" };

type Clock = { now: () => number; monotonicNow: () => number };
type Lifecycle = { getState: () => string | null; subscribe: (listener: (state: string) => void) => () => void };
type Budget = { first: number; wall: number; monotonic: number; elapsed: number };
const budgets = new Map<string, Budget>();
const anchors = new Map<string, { wall: number; monotonic: number }>();
const initializing = new Set<string>();
const keyOf = (ref: AssistantRecoveryReference) => JSON.stringify([ref.serverId, ref.requestId.toLowerCase()]);
const validReference = (ref: AssistantRecoveryReference) => isAssistantRecoveryServerId(ref.serverId) && isAssistantUuidV4(ref.requestId);

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function immutableResponse(response: Response): Response {
  return freeze({ ...response, metadata: { ...response.metadata }, data: JSON.parse(JSON.stringify(response.data)) });
}

export function createAssistantOrchestrator({
  requests = assistantRequestRecovery,
  http = assistantHttpClient,
  storage = assistantRecoveryStorage,
  clock = { now: Date.now, monotonicNow: () => performance.now() },
  lifecycle = {
    getState: () => AppState.currentState ?? null,
    subscribe: listener => { const subscription = AppState.addEventListener("change", listener); return () => subscription.remove(); },
  },
  mode = scheduleDataModeStore,
  setTimer = (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimer = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
}: {
  requests?: typeof assistantRequestRecovery;
  http?: Pick<typeof assistantHttpClient, "getServerId">;
  storage?: Pick<typeof assistantRecoveryStorage, "read" | "readForServer" | "cleanup">;
  clock?: Clock;
  lifecycle?: Lifecycle;
  mode?: { getState: () => { mode: "server" | "mock"; generation: number }; subscribe: (listener: () => void) => () => void };
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
} = {}) {
  function context(ref: AssistantRecoveryReference, generation: number): AssistantExecutionReason | null {
    if (http.getServerId() !== ref.serverId) return "server-mismatch";
    const current = mode.getState();
    if (current.mode !== "server") return "policy";
    if (current.generation !== generation) return "context-changed";
    return lifecycle.getState() === "active" ? null : "paused";
  }
  function stopped(reference: AssistantRecoveryReference, reason: AssistantExecutionReason): AssistantExecutionResult {
    return { kind: "needs-attention", reference, reason };
  }
  function idleTask(result: AssistantExecutionResult): AssistantRequestTask {
    return { initial: Promise.resolve(result), completion: Promise.resolve(result), cancel: () => {} };
  }

  function launch(reference: AssistantRecoveryReference, action: "start" | "resume" | "once",
    options: AssistantExecutionOptions, input?: AssistantRequestCreate,
    initialAnchor?: { wall: number; monotonic: number }): AssistantRequestTask {
    const ref = freeze({ serverId: reference?.serverId, requestId: reference?.requestId });
    if (!validReference(ref)) return idleTask(stopped(ref, "invalid-request"));
    if (action === "start" && initializing.has(ref.serverId)) return idleTask(stopped(ref, "initializing"));
    const key = keyOf(ref);
    let anchor: { wall: number; monotonic: number };
    try {
      anchor = anchors.get(key) ?? initialAnchor ?? { wall: clock.now(), monotonic: clock.monotonicNow() };
      if (![anchor.wall, anchor.monotonic].every(Number.isFinite)) return idleTask(stopped(ref, "clock"));
    } catch { return idleTask(stopped(ref, "clock")); }
    const lease = acquireAssistantRequestLease(ref);
    if (!lease) return idleTask(stopped(ref, "busy"));
    const token = lease.token;
    const { signal, onUpdate } = options;
    const controller = new AbortController(), generation = mode.getState().generation;
    anchors.set(key, anchor);
    let reason: AssistantExecutionReason | null = null, lastResponse: Response | undefined;
    let lastRecovery: AssistantRequestRecoveryResult | undefined, budget: Budget | undefined;
    let resolveInitial!: (value: AssistantExecutionResult) => void;
    let initialSettled = false;
    const initial = new Promise<AssistantExecutionResult>(resolve => { resolveInitial = resolve; });
    const settleInitial = (value: AssistantExecutionResult) => { if (!initialSettled) { initialSettled = true; resolveInitial(value); } };
    const stop = (next: AssistantExecutionReason) => { if (!reason) { reason = next; controller.abort(); } };
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const unsubscribeMode = mode.subscribe(() => { const changed = context(ref, generation); if (changed) stop(changed); });
    const unsubscribeApp = lifecycle.subscribe(state => { if (state !== "active") stop("paused"); });
    const check = () => { if (!reason) { const changed = context(ref, generation); if (changed) stop(changed); } return reason; };
    if (signal?.aborted) stop("aborted");
    const attention = (next: AssistantExecutionReason): Extract<AssistantExecutionResult, { kind: "needs-attention" }> => ({
      kind: "needs-attention", reference: ref, reason: next, lastResponse, recoveryResult: lastRecovery,
    });
    function emit(event: AssistantExecutionEvent) {
      if (check()) return;
      try { onUpdate?.(freeze(event)); } catch { stop("observer-error"); }
    }
    async function interruptible<T>(promise: Promise<T>): Promise<{ value: T } | null> {
      let abort!: () => void;
      const interrupted = new Promise<null>(resolve => { abort = () => resolve(null); controller.signal.addEventListener("abort", abort, { once: true }); });
      try {
        if (controller.signal.aborted) abort();
        return await Promise.race([promise.then(value => ({ value })), interrupted]);
      } finally { controller.signal.removeEventListener("abort", abort); }
    }
    async function delay(ms: number) {
      if (check()) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort!: () => void;
      try {
        await new Promise<void>(resolve => {
          abort = () => resolve();
          controller.signal.addEventListener("abort", abort, { once: true });
          timer = setTimer(resolve, ms);
        });
      } finally {
        if (timer !== undefined) clearTimer(timer);
        controller.signal.removeEventListener("abort", abort);
      }
    }
    function remaining() {
      if (!budget) return 0;
      const wall = clock.now(), monotonic = clock.monotonicNow();
      if (![wall, monotonic, anchor.wall, anchor.monotonic].every(Number.isFinite) ||
        (wall < budget.first && budget.wall < budget.first)) { stop("clock"); return 0; }
      // 같은 runtime에서는 단조 시계와 최대 경과값도 사용해 시각 보정·재개로 한도를 연장하지 않는다.
      budget.elapsed = Math.max(budget.elapsed, wall - budget.first, budget.wall - budget.first + Math.max(0, monotonic - budget.monotonic));
      return Math.max(0, 120_000 - budget.elapsed);
    }
    async function loadBudget() {
      const read = await interruptible(storage.read(ref));
      if (!read || check()) return false;
      const metadata: AssistantRecoveryMetadata | null = read.value;
      if (!metadata) { stop("metadata-mismatch"); return false; }
      const key = keyOf(ref), previous = budgets.get(key);
      if (previous && previous.first !== metadata.firstPostAttemptAt) { stop("metadata-mismatch"); return false; }
      budget = previous ?? { first: metadata.firstPostAttemptAt, wall: anchor.wall, monotonic: anchor.monotonic, elapsed: 0 };
      budgets.set(key, budget);
      return true;
    }
    function observe(result: AssistantRequestRecoveryResult) {
      lastRecovery = result;
      if (result.kind === "confirmed") {
        lastResponse = immutableResponse(result.response);
        emit({ phase: "status", reference: ref, response: lastResponse });
      }
    }
    function observed(): AssistantExecutionResult {
      const response = lastResponse!, data = response.data;
      return data.status === "completed"
        ? { kind: "completed", reference: ref, response: { ...response, data } }
        : { kind: "observed", reference: ref, response: { ...response, data } };
    }
    async function query(recover: boolean) {
      if (check()) return false;
      emit({ phase: recover ? "recovering" : "querying", reference: ref });
      if (check()) return false;
      const call = recover
        ? requests.recoverAssistantRequest(ref, { signal: controller.signal, lease: token, canRetransmit: () => !check() && remaining() > 0 })
        : requests.queryAssistantRequest(ref, { signal: controller.signal, lease: token });
      const received = await interruptible(call);
      if (!received || check()) return false;
      observe(received.value);
      if (check()) return false;
      if (received.value.kind === "unconfirmed") {
        switch (received.value.reason) {
          case "storage": case "busy": case "server-mismatch": case "context-changed":
          case "policy": case "aborted": case "deadline": case "invalid-request": case "metadata-mismatch":
            stop(received.value.reason); break;
          default: stop("unconfirmed");
        }
        return false;
      }
      return true;
    }
    async function execute(): Promise<AssistantExecutionResult> {
      try {
        if (check()) return attention(reason!);
        let needsFirstGet = true;
        if (action === "start") {
          emit({ phase: "posting", reference: ref });
          if (check()) return attention(reason!);
          const posted = await interruptible(requests.startAssistantRequest(input!, { expectedServerId: ref.serverId, signal: controller.signal, lease: token }));
          if (!posted || check()) return attention(reason ?? "aborted");
          observe(posted.value);
          if (check()) return attention(reason!);
          if (posted.value.kind === "unconfirmed") {
            const error = posted.value.postResult;
            if (!error || error.ok || error.error.requestState === "not-sent" ||
              !["network", "timeout", "response"].includes(error.error.kind)) return attention(posted.value.reason === "storage" ? "storage" : "unconfirmed");
            if (!await loadBudget()) return attention(reason ?? "storage");
            if (remaining() <= 0) return attention(reason ?? "deadline");
            if (!await query(true)) return attention(reason ?? "unconfirmed");
            needsFirstGet = lastRecovery?.kind === "confirmed" && lastRecovery.via === "resend";
            // GET으로 확인한 pending 응답 뒤에는 정상 2초 간격부터 시작한다.
            if (!needsFirstGet) settleInitial(observed());
          }
        }
        // 서버가 알려 준 미저장 복구 ID도 단발 GET할 수 있다. POST 시각을 만들거나 polling을 시작하지 않는다.
        if (action !== "once" && !budget && !await loadBudget()) return attention(reason ?? "storage");
        if (needsFirstGet) {
          // 앱 복구·명시적 재조회는 120초 뒤에도 한 번 허용한다. 자동 POST 후 첫 GET만 deadline 적용.
          if (action === "start" && remaining() <= 0) return attention(reason ?? "deadline");
          if (!await query(false)) return attention(reason ?? "unconfirmed");
          settleInitial(observed());
        }
        while (!check()) {
          if (lastResponse?.data.status === "completed") return observed();
          if (action === "once") return observed();
          const left = remaining();
          if (check()) return attention(reason!);
          if (left <= 0) return attention("deadline");
          emit({ phase: "waiting", reference: ref });
          await delay(Math.min(2000, left));
          if (check()) return attention(reason!);
          if (remaining() <= 0) return attention(reason ?? "deadline");
          // 이미 전송한 GET은 기존 5초 timeout까지 결과를 받되 deadline 뒤 다음 GET은 시작하지 않는다.
          if (!await query(false)) return attention(reason ?? "unconfirmed");
        }
        return attention(reason!);
      } catch (error) {
        return { ...attention(error instanceof AssistantRecoveryStorageError ? "storage" : "internal"),
          storageCode: error instanceof AssistantRecoveryStorageError ? error.code : "unknown" };
      }
    }
    const completion = execute().then(result => { settleInitial(result); return result; }).finally(() => {
      signal?.removeEventListener("abort", onAbort); unsubscribeMode(); unsubscribeApp(); lease.release();
    });
    return { initial, completion, cancel: onAbort };
  }

  function startRequest(input: AssistantRequestCreate, options: AssistantExecutionOptions & { expectedServerId: string }) {
    const ref = { serverId: options?.expectedServerId, requestId: input?.requestId };
    try {
      if (!parseAssistantRequestCreate(input)) return idleTask(stopped(ref, "invalid-request"));
      const snapshot = parseAssistantRequestCreate(JSON.parse(JSON.stringify(input)));
      if (!snapshot || snapshot.requestId !== ref.requestId) return idleTask(stopped(ref, "invalid-request"));
      return launch(ref, "start", options, snapshot);
    } catch { return idleTask(stopped(ref, "invalid-request")); }
  }
  const resumeRequest = (ref: AssistantRecoveryReference, options: AssistantExecutionOptions = {}) => launch(ref, "resume", options);
  const queryRequestOnce = (ref: AssistantRecoveryReference, options: AssistantExecutionOptions = {}) => launch(ref, "once", options);

  async function initializeRecovery(options: AssistantExecutionOptions = {}): Promise<AssistantRecoveryInitialization> {
    const serverId = http.getServerId();
    if (!serverId) return { kind: "needs-attention", reason: "server-mismatch" };
    const generation = mode.getState().generation, ref = { serverId, requestId: "" };
    if (options.signal?.aborted) return { kind: "needs-attention", reason: "aborted" };
    const changed = context(ref, generation);
    if (changed) return { kind: "needs-attention", reason: changed };
    if (initializing.has(serverId)) return { kind: "needs-attention", reason: "busy" };
    let initialAnchor: { wall: number; monotonic: number };
    try {
      initialAnchor = { wall: clock.now(), monotonic: clock.monotonicNow() };
      if (![initialAnchor.wall, initialAnchor.monotonic].every(Number.isFinite)) return { kind: "needs-attention", reason: "clock" };
    } catch { return { kind: "needs-attention", reason: "clock" }; }
    initializing.add(serverId);
    const started: AssistantRequestTask[] = [];
    let initialized = false;
    try {
      const entries = await storage.readForServer(serverId);
      if (options.signal?.aborted) return { kind: "needs-attention", reason: "aborted" };
      const changed = context(ref, generation);
      if (changed) return { kind: "needs-attention", reason: changed };
      const requests: Extract<AssistantRecoveryInitialization, { kind: "initialized" }>["requests"] = [];
      for (const entry of entries) {
        if (options.signal?.aborted) return { kind: "needs-attention", reason: "aborted" };
        const changed = context(ref, generation);
        if (changed) return { kind: "needs-attention", reason: changed };
        const reference = { serverId, requestId: entry.requestId };
        const task = launch(reference, "resume", options, undefined, initialAnchor);
        started.push(task);
        requests.push({ reference, initial: await task.initial, task });
      }
      if (options.signal?.aborted) return { kind: "needs-attention", reason: "aborted" };
      const finalContext = context(ref, generation);
      if (finalContext) return { kind: "needs-attention", reason: finalContext };
      initialized = true;
      return { kind: "initialized", serverId, requests };
    } catch (error) {
      return { kind: "needs-attention", reason: "storage", storageCode: error instanceof AssistantRecoveryStorageError ? error.code : "unknown" };
    } finally {
      if (!initialized) started.forEach(task => task.cancel());
      initializing.delete(serverId);
    }
  }
  // 실제 UI가 결과 표시를 확인했을 때만 호출한다. 반환·callback만으로는 정리하지 않는다.
  const confirmResultDisplayed = (ref: AssistantRecoveryReference) => storage.cleanup(ref, http.getServerId() ?? "", { type: "result-displayed" });
  return { startRequest, resumeRequest, queryRequestOnce, initializeRecovery, confirmResultDisplayed };
}

// 앱 시작 자동 연결은 작업 5의 화면 lifecycle에서 별도로 수행한다.
export const assistantOrchestrator = createAssistantOrchestrator();
