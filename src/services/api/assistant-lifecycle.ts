import { AppState } from "react-native";

import { assistantHttpClient } from "@/services/api/assistant";
import {
  assistantOrchestrator,
  type AssistantExecutionEvent,
  type AssistantExecutionResult,
  type AssistantRecoveryInitialization,
} from "@/services/api/assistant-orchestrator";
import { scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import type { AssistantRecoveryReference } from "@/types/assistant-recovery";

export type AssistantLifecycleEntry = Readonly<{
  reference: AssistantRecoveryReference;
  phase?: AssistantExecutionEvent["phase"];
  lastResponse?: Extract<AssistantExecutionEvent, { phase: "status" }>["response"];
  latestResult?: AssistantExecutionResult;
}>;
export type AssistantLifecycleSnapshot = Readonly<{
  // 로컬 복구 실행 상태이며 일정 변경 성공이나 uncertain 해소를 뜻하지 않는다.
  phase: "idle" | "recovering" | "observing" | "settled" | "paused" | "unavailable" | "needs-attention" | "stopped";
  serverId: string | null;
  results: readonly AssistantLifecycleEntry[];
  initialization?: Exclude<AssistantRecoveryInitialization, { kind: "initialized" }>;
  issue?: "server-not-ready" | "server-mismatch" | "policy" | "unexpected";
}>;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const copy = <T,>(value: T): T => freeze(JSON.parse(JSON.stringify(value)));
const keyOf = (ref: AssistantRecoveryReference) => JSON.stringify([ref.serverId, ref.requestId.toLowerCase()]);

export function createAssistantLifecycle({
  orchestrator = assistantOrchestrator,
  http = assistantHttpClient,
  mode = scheduleDataModeStore,
  lifecycle = {
    getState: () => AppState.currentState ?? null,
    subscribe: (listener: (state: string) => void) => {
      const subscription = AppState.addEventListener("change", listener);
      return () => subscription.remove();
    },
  },
}: {
  orchestrator?: Pick<typeof assistantOrchestrator, "initializeRecovery">;
  http?: Pick<typeof assistantHttpClient, "getServerId">;
  mode?: { getState: () => { mode: "server" | "mock"; generation: number }; subscribe: (listener: () => void) => () => void };
  lifecycle?: { getState: () => string | null; subscribe: (listener: (state: string) => void) => () => void };
} = {}) {
  // 기존 복구 metadata와 구분되는 실행 세션 내 최신 결과만 보관하며 영속 저장하지 않는다.
  const entries = new Map<string, AssistantLifecycleEntry>();
  const owners = new Set<symbol>(), subscribers = new Set<() => void>();
  let snapshot: AssistantLifecycleSnapshot = freeze({ phase: "idle", serverId: null, results: [] });
  let epoch = 0, active = false, listening = false;
  let controller: AbortController | null = null;
  let unsubscribeApp: (() => void) | undefined, unsubscribeMode: (() => void) | undefined;
  let tail: Promise<void> = Promise.resolve();

  function publish(update: Omit<AssistantLifecycleSnapshot, "results">) {
    snapshot = freeze({ ...update, results: [...entries.values()] });
    for (const subscriber of [...subscribers]) {
      // 화면 구독자 예외로 앱 초기화·다른 구독자·요청 제어를 중단하지 않는다.
      try { subscriber(); } catch {}
    }
  }
  function stopCycle() { epoch++; controller?.abort(); controller = null; }
  function context() {
    try { return { serverId: http.getServerId(), ...mode.getState() }; }
    catch { return { serverId: null, mode: "server" as const, generation: -1 }; }
  }
  function scheduleRecovery() {
    const scope = context();
    if (!owners.size || !active) return;
    if (!scope.serverId || scope.mode !== "server") {
      publish({ phase: "unavailable", serverId: scope.serverId, issue: scope.mode === "mock" ? "policy" : "server-not-ready" });
      return;
    }
    if (snapshot.serverId !== scope.serverId) entries.clear();
    const serverId = scope.serverId, current = ++epoch, signalController = new AbortController();
    controller = signalController;
    publish({ phase: "recovering", serverId });
    function valid() {
      if (!owners.size || !active || current !== epoch || signalController.signal.aborted) return false;
      const next = context();
      if (next.serverId === serverId && next.generation === scope.generation && next.mode === "server") return true;
      stopCycle(); entries.clear();
      publish({ phase: "unavailable", serverId: next.serverId, issue: next.mode === "mock" ? "policy" : "server-mismatch" });
      return false;
    }
    function capture(result: AssistantExecutionResult) {
      if (!valid() || result.reference.serverId !== serverId) return;
      const key = keyOf(result.reference), previous = entries.get(key);
      entries.set(key, copy({ ...previous, reference: result.reference, latestResult: result,
        lastResponse: result.kind === "needs-attention" ? result.lastResponse ?? previous?.lastResponse : result.response }));
    }
    const previous = tail;
    tail = (async () => {
      await previous;
      if (!valid()) return;
      let tasks: Extract<AssistantRecoveryInitialization, { kind: "initialized" }>["requests"] = [];
      try {
        const initialized = await orchestrator.initializeRecovery({ signal: signalController.signal, onUpdate: event => {
          if (!valid() || event.reference.serverId !== serverId) return;
          const key = keyOf(event.reference), previous = entries.get(key);
          entries.set(key, copy({ ...previous, reference: event.reference, phase: event.phase,
            latestResult: undefined, lastResponse: event.phase === "status" ? event.response : previous?.lastResponse }));
          publish({ phase: "observing", serverId });
        } });
        if (initialized.kind === "initialized") tasks = initialized.requests;
        if (!valid()) return;
        if (initialized.kind === "needs-attention") {
          publish({ phase: "needs-attention", serverId, initialization: copy(initialized) });
          return;
        }
        const keys = new Set(tasks.map(item => keyOf(item.reference)));
        for (const key of entries.keys()) if (!keys.has(key)) entries.delete(key);
        tasks.forEach(item => capture(item.initial));
        publish({ phase: "observing", serverId });
        await Promise.all(tasks.map(async item => {
          capture(await item.task.completion);
          if (valid()) publish({ phase: "observing", serverId });
        }));
        if (valid()) publish({ phase: [...entries.values()].some(item => item.latestResult?.kind === "needs-attention") ? "needs-attention" : "settled", serverId });
      } catch {
        if (valid()) publish({ phase: "needs-attention", serverId, issue: "unexpected" });
      } finally {
        // 다음 active 복구는 이전 처리의 중단·예약 해제를 기다린다. cancel은 로컬 중단만 수행한다.
        if (!valid()) tasks.forEach(item => item.task.cancel());
        await Promise.allSettled(tasks.map(item => item.task.completion));
        if (controller === signalController) controller = null;
      }
    })();
  }

  function onAppState(state: string | null) {
    if (!owners.size) return;
    const next = state === "active";
    if (active === next) return;
    active = next;
    if (active) scheduleRecovery();
    else { stopCycle(); publish({ phase: "paused", serverId: snapshot.serverId, initialization: snapshot.initialization }); }
  }
  function detachRuntime() {
    stopCycle(); active = false; listening = false;
    unsubscribeApp?.(); unsubscribeMode?.(); unsubscribeApp = undefined; unsubscribeMode = undefined;
    publish({ phase: "stopped", serverId: snapshot.serverId, initialization: snapshot.initialization });
  }
  function attach({ signal }: { signal?: AbortSignal } = {}) {
    if (signal?.aborted) return () => {};
    const owner = Symbol(); owners.add(owner);
    if (!listening) {
      listening = true;
      try {
        unsubscribeApp = lifecycle.subscribe(onAppState);
        unsubscribeMode = mode.subscribe(() => {
          if (!owners.size) return;
          stopCycle(); entries.clear();
          if (active) scheduleRecovery();
          else publish({ phase: "paused", serverId: context().serverId });
        });
      } catch { detachRuntime(); publish({ phase: "unavailable", serverId: null, issue: "unexpected" }); }
    }
    try { if (listening) onAppState(lifecycle.getState()); }
    catch { detachRuntime(); publish({ phase: "unavailable", serverId: null, issue: "unexpected" }); }
    const detach = () => {
      signal?.removeEventListener("abort", detach);
      if (!owners.delete(owner) || owners.size) return;
      // StrictMode의 같은 commit 내 해제→재연결은 기존 작업을 재사용한다. 해제 중 결과는 valid가 거부한다.
      void Promise.resolve().then(() => { if (!owners.size && listening) detachRuntime(); });
    };
    signal?.addEventListener("abort", detach, { once: true });
    if (signal?.aborted) detach();
    return detach;
  }
  return {
    attach,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
  };
}

// root layout은 이 단일 인스턴스에 연결한다. 생성만으로 native 구독·저장소·HTTP에 접근하지 않는다.
export const assistantLifecycle = createAssistantLifecycle();
