import { createStore } from "zustand/vanilla";
import { createPiCandidate, getServerTargetSource, parseCanonicalIpv4, type ServerTarget } from "@/services/api/config";
import { createSystemApiService, type SystemApiResult, type HealthResponse, type SystemClock } from "@/services/api/system";
import type { ApiTransport } from "@/services/api/transport";
import { commitVerifiedConnection, scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import { createVerifiedSettingsStorage } from "@/services/storage/verified-settings";
import { readSavedPiIp } from "@/services/storage/settings";
import { parseScheduleApiDateTime } from "@/utils/schedule-mapper";

export function healthMidpoint(result: SystemApiResult<HealthResponse>) {
  if (!result.ok) return null;
  const timing = result.timings.at(-1); if (!timing || timing.monotonicReceivedAt === null) return null;
  const rtt = timing.monotonicReceivedAt - timing.monotonicStartedAt;
  const parsed = parseScheduleApiDateTime(result.data.serverTime);
  const midpoint = timing.wallStartedAt + rtt / 2, server = parsed.milliseconds + parsed.microseconds / 1000;
  if (![rtt, midpoint, server].every(Number.isFinite) || rtt < 0) return null;
  const differenceMs = Math.abs(server - midpoint);
  return { differenceMs, phoneTime: midpoint, piTime: server, within: differenceMs <= 60_000 };
}
export type SettingsConnectionState = {
  input: string; savedIp: string | null; phase: "restoring" | "idle" | "checking" | "consent" | "syncing" | "rechecking" | "ready" | "saving" | "saved" | "error";
  timing: ReturnType<typeof healthMidpoint>; error: string | null; adjusted: boolean | null; modal: boolean;
  consentToken: number;
};
export function createSettingsConnection({ transport, storage, clock = { now: Date.now, monotonicNow: () => performance.now() },
  activate = commitVerifiedConnection, business = () => getServerTargetSource() === "pi", legacy = readSavedPiIp }: {
  transport: ApiTransport; storage: ReturnType<typeof createVerifiedSettingsStorage>; clock?: SystemClock;
  activate?: typeof commitVerifiedConnection; business?: () => boolean; legacy?: typeof readSavedPiIp;
}) {
  const api = createSystemApiService({ transport, clock });
  const store = createStore<SettingsConnectionState>(() => ({ input: "", savedIp: null, phase: "idle", timing: null, error: null, adjusted: null, modal: false, consentToken: 0 }));
  let sequence = 0, controller: AbortController | null = null, candidate: ServerTarget | null = null;
  let synced = false, consent = 0, restoreTask: Promise<void> | null = null;
  let editSession = 0, legacyInput = "";
  let committing = false;
  const set = store.setState;
  function invalidate() { sequence++; controller?.abort(); controller = null; consent = 0; set({ modal: false, consentToken: 0 }); }
  function cancel() { invalidate(); synced = false; candidate = null; set({ phase: "idle", timing: null, adjusted: null, error: null }); }
  const unsubscribe = scheduleDataModeStore.subscribe((next, previous) => {
    if (next.generation !== previous.generation && !committing) cancel();
  });
  function publish(target: ServerTarget) {
    if (!business()) return;
    committing = true;
    try { activate(target, transport); } finally { committing = false; }
  }
  function input(value: string) { if (value === store.getState().input) return; cancel(); set({ input: value, error: null }); }
  function scope() {
    controller?.abort(); const abort = new AbortController(); controller = abort; const id = ++sequence;
    const ip = parseCanonicalIpv4(store.getState().input);
    const current = () => id === sequence && !abort.signal.aborted && parseCanonicalIpv4(store.getState().input) === ip;
    return { ip, current, options: { signal: abort.signal, isCurrent: current } };
  }
  async function health(target: ServerTarget, work: ReturnType<typeof scope>) {
    const result = await api.checkHealth(target, work.options); if (!work.current()) return null;
    const timing = healthMidpoint(result);
    if (!timing) { set({ phase: "error", error: synced
      ? "시간을 맞춘 후 연결 상태를 확인하지 못했어요. 다시 연결 확인을 눌러 주세요."
      : "연결 확인에 실패했습니다. 다시 시도하세요.", timing: null }); return null; }
    set({ timing, error: timing.within ? null : "시간 차이가 60초를 초과합니다. Orange Pi 시각을 수동 조정한 뒤 다시 확인해 주세요." });
    return timing;
  }
  async function check() {
    if (["checking", "syncing", "rechecking", "saving"].includes(store.getState().phase)) return;
    consent = 0; set({ modal: false, consentToken: 0 }); const work = scope();
    if (!work.ip) { set({ phase: "error", error: "올바른 IP 주소를 입력해 주세요.", timing: null }); return; }
    if (!candidate || candidate.baseUrl !== `http://${work.ip}:8000`) { candidate = createPiCandidate(work.ip, transport.kind); synced = false; }
    if (!candidate) return;
    set({ phase: synced ? "rechecking" : "checking", error: null, adjusted: synced ? store.getState().adjusted : null });
    const timing = await health(candidate, work); if (!work.current() || !timing) return;
    set({ phase: timing.within && synced ? "ready" : "consent" });
  }
  function openConsent() {
    if (store.getState().modal) return;
    if (!["consent", "ready", "saved"].includes(store.getState().phase) || !store.getState().timing?.within || !candidate) return;
    // Publish ownership with visibility so React/Compiler observe the same consent session.
    consent = ++sequence; set({ modal: true, consentToken: consent });
  }
  function dismissConsent(expected = consent) { if (expected !== consent) return; consent = 0; set({ modal: false, consentToken: 0 }); }
  async function confirmConsent(expected: number) {
    if (!consent || expected !== consent || expected !== sequence || !candidate || !store.getState().timing?.within) return;
    consent = 0; synced = false; set({ modal: false, consentToken: 0, phase: "syncing", adjusted: null, error: null });
    const work = scope(), target = candidate;
    let currentTime: string;
    try { currentTime = new Date(clock.now()).toISOString(); }
    catch { set({ phase: "error", error: "휴대폰 시각을 확인하지 못했습니다. 다시 연결을 확인해 주세요." }); return; }
    const result = await api.syncTimeAfterConsent(target, { currentTime }, { ...work.options, consent: "confirmed" });
    if (!work.current()) return;
    if (!result.ok) {
      set({ phase: "rechecking", error: null }); await health(target, work);
      if (work.current()) set({ phase: "consent", error: result.error.kind === "http"
        ? "Pi 시간을 맞추지 못했어요. 다시 시간 맞추기를 눌러 주세요."
        : "시간 맞추기 결과를 확인하지 못했어요. 연결 상태를 다시 확인해 주세요." });
      return;
    }
    synced = true; set({ adjusted: result.data.adjusted, phase: "rechecking" });
    const timing = await health(target, work); if (work.current() && timing) set({ phase: timing.within ? "ready" : "consent" });
  }
  async function save() {
    if (store.getState().phase !== "ready" || !synced || !candidate || !store.getState().timing?.within) return;
    const target = candidate, work = scope(); if (!work.ip) return;
    set({ phase: "saving", error: null });
    try {
      await storage.save(work.ip, work.current, () => {
        publish(target);
        // The durable/active value is committed before asynchronous journal cleanup.
        set({ savedIp: work.ip });
      });
      if (work.current()) set({ phase: "saved", savedIp: work.ip });
    } catch { if (work.current()) set({ phase: "ready", error: "설정을 저장하지 못했습니다. 다시 저장해 주세요." }); }
  }
  function restore() {
    if (restoreTask) return restoreTask;
    restoreTask = (async () => {
      const work = scope(); set({ phase: "restoring", error: null });
      try {
        const saved = await storage.read(); if (!work.current()) return;
        if (!saved) { const old = await legacy(); if (work.current()) { legacyInput = old ?? ""; set({ input: legacyInput, phase: "idle" }); } return; }
        set({ input: saved.ip, savedIp: saved.ip });
        const restored = scope(); candidate = createPiCandidate(saved.ip, transport.kind); synced = false;
        if (!candidate) return;
        const timing = await health(candidate, restored);
        if (!restored.current() || !timing) return;
        if (timing.within) { publish(candidate); set({ phase: "consent" }); }
        else set({ phase: "consent" });
      } catch { if (work.current()) set({ phase: "error", error: "저장된 연결을 확인하지 못했습니다. 다시 연결을 확인해 주세요." }); }
    })(); return restoreTask;
  }
  function beginEditing() {
    const session = ++editSession;
    if (!restoreTask) void restore();
    else if (store.getState().phase !== "restoring") {
      cancel(); set({ input: store.getState().savedIp ?? legacyInput });
    }
    return () => {
      if (session !== editSession) return;
      editSession++;
      // Initial app restoration is not owned by a Settings route's focus lifetime.
      if (store.getState().phase === "restoring") return;
      cancel(); set({ input: store.getState().savedIp ?? legacyInput });
    };
  }
  return { store, input, check, openConsent, dismissConsent, confirmConsent, consentToken: () => consent, save, restore, cancel, beginEditing,
    dispose() { unsubscribe(); cancel(); } };
}
