import { LOCAL_VOICE_LIMITS } from "@/constants/voice-recording";
import type { AssistantInputUi } from "@/utils/assistant-voice-ui";
import type { LocalVoiceFileInfo } from "@/utils/voice-recording-metadata";

export type LocalVoiceIssue = "permission-denied" | "permission-request" | "prepare" | "start" | "native" |
  "stop" | "missing-file" | "invalid-file" | "file-too-large" | "file-too-long" | "cleanup";
export type LocalVoiceSnapshot = { busy: boolean; input: AssistantInputUi; issue?: LocalVoiceIssue; file?: LocalVoiceFileInfo };
export type LocalVoiceFileCleanup = { existedBeforeDelete: boolean; deletedCount: number; existsAfterDelete: false };
export type LocalVoiceDiagnostic = Record<string, boolean | number | null>;
export type LocalRecorder = {
  prepare(): Promise<void>;
  record(): void;
  status(): { isRecording: boolean; canRecord: boolean; durationMillis: number; fileSize: number };
  stop(): Promise<void>;
  uri(): string | null;
  release(): void;
};
export type LocalVoiceDependencies = {
  beforeStart?(): Promise<void>;
  afterEnd?(safe: boolean): void;
  canStart(): boolean;
  readAppState(): string | null;
  permission(): Promise<{ granted: boolean; canAskAgain: boolean }>;
  requestPermission(): Promise<{ granted: boolean; canAskAgain: boolean }>;
  activate(): Promise<void>;
  configure(): Promise<void>;
  reset(): Promise<void>;
  create(name: string, listener: (event: { isFinished: boolean; hasError: boolean }) => void): LocalRecorder;
  newName(): string;
  files: { sweep(): void; inspect(name: string, uri: string | null): Promise<LocalVoiceFileInfo>; remove(name: string): void | LocalVoiceFileCleanup };
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  observe?(event: string, detail?: LocalVoiceFileInfo | { issue: LocalVoiceIssue } | LocalVoiceDiagnostic): void;
};

type Job = {
  phase: "permission" | "preparing" | "recording" | "stopping";
  cancelled: boolean; permissionDialog: boolean; session: boolean; stopAttempted: boolean;
  name?: string; recorder?: LocalRecorder; timer?: unknown; monitor?: unknown; nativeIssue?: boolean;
  startTask?: Promise<void>; stopTask?: Promise<void>; waitActive?: (active: boolean) => void;
};
const cancelled = Symbol("cancelled-local-recording");

// 서버·Assistant 상태와 독립적인 화면 세션 한 건. 비동기 작업 전에 job을 확보한다.
export function createLocalVoiceRecording(deps: LocalVoiceDependencies) {
  let job: Job | null = null, retained: string | null = null, focused = false, appState = deps.readAppState();
  let snapshot: LocalVoiceSnapshot = { busy: false, input: { source: "text" } };
  const listeners = new Set<(value: LocalVoiceSnapshot) => void>();
  const observe: NonNullable<LocalVoiceDependencies["observe"]> = (event, detail) => {
    try { deps.observe?.(event, detail); } catch { /* 진단 출력 실패는 녹음의 실행 근거가 아니다. */ }
  };
  const publish = (input: AssistantInputUi, issue?: LocalVoiceIssue, file?: LocalVoiceFileInfo) => {
    snapshot = { busy: job !== null, input, issue, file };
    for (const listener of listeners) listener(snapshot);
  };
  const available = () => focused && appState === "active" && deps.canStart();
  const current = (active: Job) => job === active && !active.cancelled && available();
  const check = (active: Job) => {
    if (!current(active)) throw cancelled;
    if (active.nativeIssue) throw new Error("native-recording-error");
  };
  function remove(name: string) {
    try {
      const result = deps.files.remove(name);
      observe(result?.deletedCount ? "file-deleted" : "file-cleanup", result ?? { existsAfterDelete: false });
      return true;
    }
    catch { observe("cleanup-failed", { issue: "cleanup" }); return false; }
  }
  function discard() {
    if (job) return;
    if (retained && remove(retained)) retained = null;
    publish({ source: "text" });
  }
  async function cleanup(active: Job) {
    let ok = true;
    if (active.timer !== undefined) deps.clearTimer(active.timer);
    if (active.monitor !== undefined) deps.clearTimer(active.monitor);
    if (active.recorder) {
      try {
        const state = active.recorder.status();
        if (!active.stopAttempted && (state.isRecording || state.canRecord)) {
          active.stopAttempted = true;
          await active.recorder.stop();
        }
      } catch { ok = false; }
      try { active.recorder.release(); } catch { ok = false; }
    }
    if (active.session) {
      try { await deps.reset(); } catch { ok = false; }
    }
    return ok;
  }
  async function settle(active: Job, info?: LocalVoiceFileInfo, issue?: LocalVoiceIssue) {
    const cleaned = await cleanup(active);
    deps.afterEnd?.(cleaned);
    if (!cleaned) issue = "cleanup";
    if (!cleaned || !current(active) || issue || !info) {
      if (active.name && !remove(active.name)) issue = "cleanup";
      info = undefined;
    }
    if (job !== active) return;
    job = null;
    if (issue) observe("recording-error", { issue });
    if (active.cancelled || !available()) publish({ source: "text" }, issue);
    else if (info && active.name) {
      retained = active.name;
      observe("file-validated", info);
      publish({ source: "voice", phase: "recorded" }, undefined, info);
    } else publish({ source: "voice", phase: issue?.startsWith("permission") ? "permission-error" : "recording-error" }, issue);
  }
  function finish(active: Job, issue?: LocalVoiceIssue): Promise<void> {
    if (active.stopTask) return active.stopTask;
    active.phase = "stopping";
    active.stopTask = Promise.resolve().then(async () => {
      let info: LocalVoiceFileInfo | undefined;
      try {
        const recorder = active.recorder;
        if (!recorder) throw new Error("missing-recorder");
        if (!active.stopAttempted) {
          const state = recorder.status();
          if (state.isRecording || state.canRecord) {
            active.stopAttempted = true;
            await recorder.stop();
          }
        }
        if (active.cancelled) return;
        check(active);
        if (issue || active.nativeIssue) throw new Error("native-recording-error");
        observe("file-validation-started", { stopCompleted: true });
        try { info = await deps.files.inspect(active.name!, recorder.uri()); }
        catch (error) {
          const code = error instanceof Error ? error.message : "invalid-file";
          issue = code === "missing-file" ? "missing-file" : code === "file-too-large" ? "file-too-large" :
            code === "file-too-long" ? "file-too-long" : code === "cleanup" ? "cleanup" : "invalid-file";
          throw error;
        }
        check(active);
      } catch (error) {
        if (error !== cancelled) issue ??= active.nativeIssue ? "native" : "stop";
      } finally { await settle(active, info, issue); }
    });
    if (!active.cancelled) publish({ source: "voice", phase: "stopping" });
    return active.stopTask;
  }
  async function runStart(active: Job) {
    let handedOff = false, issue: LocalVoiceIssue | undefined = "permission-request";
    try {
      if (deps.beforeStart) { issue = "prepare"; await deps.beforeStart(); check(active); }
      issue = "permission-request";
      if (retained) {
        if (!remove(retained)) { issue = "cleanup"; throw new Error("cleanup"); }
        retained = null;
      }
      let permission = await deps.permission();
      check(active);
      if (!permission.granted && permission.canAskAgain) {
        active.permissionDialog = true;
        permission = await deps.requestPermission();
        if (appState === "inactive" && !active.cancelled) await new Promise<boolean>(resolve => { active.waitActive = resolve; });
        active.permissionDialog = false;
        check(active);
      }
      if (!permission.granted) { issue = "permission-denied"; throw new Error("permission-denied"); }
      active.phase = "preparing";
      issue = "prepare";
      active.session = true;
      await deps.activate(); check(active);
      await deps.configure(); check(active);
      // 세션 소유권 확보 후에만 이전 앱 실행의 파일을 정리한다. 다른 recorder의 활성 파일은 건드리지 않는다.
      try { deps.files.sweep(); } catch { issue = "cleanup"; throw new Error("cleanup"); }
      active.name = deps.newName();
      active.recorder = deps.create(active.name, event => {
        if (job !== active || active.cancelled) return;
        if (event.hasError) active.nativeIssue = true;
        if (active.phase === "recording" && (event.isFinished || event.hasError)) void finish(active, event.hasError ? "native" : undefined);
      });
      await active.recorder.prepare(); check(active);
      issue = "start";
      active.recorder.record(); check(active);
      if (!active.recorder.status().isRecording) throw new Error("not-recording");
      active.phase = "recording";
      active.timer = deps.setTimer(() => { void finish(active); }, LOCAL_VOICE_LIMITS.durationSeconds * 1000);
      const monitor = () => {
        if (job !== active || active.phase !== "recording") return;
        try {
          const state = active.recorder!.status();
          if (state.fileSize > LOCAL_VOICE_LIMITS.maxBytes) { void finish(active, "file-too-large"); return; }
          if (!state.isRecording) { void finish(active, state.canRecord ? "native" : undefined); return; }
          active.monitor = deps.setTimer(monitor, 250);
        } catch { void finish(active, "native"); }
      };
      active.monitor = deps.setTimer(monitor, 250);
      handedOff = true;
      publish({ source: "voice", phase: "recording" });
    } catch (error) {
      if (active.nativeIssue) issue = "native";
      if (error === cancelled) { active.cancelled = true; issue = undefined; }
    } finally {
      if (!handedOff) await settle(active, undefined, issue);
    }
  }
  function start(): Promise<void> {
    if (job || !available()) return Promise.resolve();
    const active: Job = { phase: "permission", cancelled: false, permissionDialog: false, session: false, stopAttempted: false };
    job = active;
    publish({ source: "text" });
    active.startTask = runStart(active);
    return active.startTask;
  }
  function cancel(): Promise<void> {
    const active = job;
    if (!active) { discard(); return Promise.resolve(); }
    active.cancelled = true;
    active.waitActive?.(false);
    publish({ source: "text" });
    return active.phase === "recording" || active.phase === "stopping" ? finish(active) : active.startTask ?? Promise.resolve();
  }
  return {
    start, stop: () => job?.phase === "recording" || job?.phase === "stopping" ? finish(job) : Promise.resolve(), cancel, discard,
    isBusy: () => job !== null,
    getSnapshot: () => snapshot,
    subscribe(listener: (value: LocalVoiceSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    focus(value: boolean) { focused = value; if (!value) void cancel(); },
    appState(value: string) {
      appState = value;
      if (value === "active") job?.waitActive?.(true);
      else if (value === "background" || (value === "inactive" && job && !job.permissionDialog)) void cancel();
    },
    checkAvailability() { if (job && !deps.canStart()) void cancel(); },
  };
}
