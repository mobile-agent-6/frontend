export type LocalPlaybackSource = { kind: "asset"; asset: number } | { kind: "file"; uri: string; format: "wav" | "mp3" | "m4a" };
export type LocalPlaybackStatus = { playing: boolean; isLoaded: boolean; didJustFinish: boolean; failed: boolean };
export type LocalPlaybackSnapshot = { phase: "idle" | "loading" | "playing" | "stopping" | "completed" | "error"; issue?: "source" | "prepare" | "native" | "cleanup"; blocked: boolean };
export type LocalPlaybackPlayer = { play(): void; pause(): void; status(): LocalPlaybackStatus; release(): void };
export type LocalPlaybackDependencies = {
  canPlay(): boolean;
  readAppState(): string | null;
  reserve(stop: () => Promise<boolean>): void;
  relinquish(safe: boolean): void;
  validate(source: LocalPlaybackSource): Promise<void>;
  activate(): Promise<void>;
  configure(): Promise<void>;
  reset(): Promise<void>;
  create(source: LocalPlaybackSource, listener: (status: LocalPlaybackStatus) => void): LocalPlaybackPlayer;
  observe?(phase: LocalPlaybackSnapshot["phase"], issue?: LocalPlaybackSnapshot["issue"]): void;
};
type Job = { ending: boolean; session: boolean; player?: LocalPlaybackPlayer; startup?: Promise<void>; endingTask?: Promise<boolean> };

export function createLocalAudioPlayback(deps: LocalPlaybackDependencies) {
  let focused = false, appState = deps.readAppState(), job: Job | null = null;
  let snapshot: LocalPlaybackSnapshot = { phase: "idle", blocked: false };
  const listeners = new Set<(value: LocalPlaybackSnapshot) => void>();
  const publish = (phase: LocalPlaybackSnapshot["phase"], issue?: LocalPlaybackSnapshot["issue"], blocked = false) => {
    snapshot = { phase, issue, blocked };
    try { deps.observe?.(phase, issue); } catch { /* 진단 실패는 재생 근거가 아니다. */ }
    for (const listener of listeners) listener(snapshot);
  };
  const available = () => focused && appState === "active" && deps.canPlay();
  const valid = (active: Job) => job === active && !active.ending && available();
  function finish(active: Job, phase: "idle" | "completed" | "error", issue?: LocalPlaybackSnapshot["issue"]): Promise<boolean> {
    if (active.endingTask) return active.endingTask;
    active.ending = true;
    publish("stopping");
    active.endingTask = Promise.resolve().then(async () => {
      await active.startup;
      let paused = true, reset = true, released = true;
      try { active.player?.pause(); } catch { paused = false; }
      // iOS keepAudioSessionActive의 keeper를 먼저 비운다. remove/release의 지연 자동 비활성화를 만들지 않는다.
      if (active.session) { try { await deps.reset(); } catch { reset = false; } }
      try { active.player?.release(); } catch { released = false; }
      const safe = reset && released && (paused || active.session);
      deps.relinquish(safe);
      if (safe) job = null; // 정리가 불확실하면 job/예약을 유지하여 새 녹음·재생을 막는다.
      publish(safe ? phase : "error", safe ? issue : "cleanup", !safe);
      return safe;
    });
    return active.endingTask;
  }
  function sample(active: Job, status: LocalPlaybackStatus) {
    if (!valid(active)) return;
    if (status.failed) { void finish(active, "error", "native"); return; }
    if (status.didJustFinish) { void finish(active, "completed"); return; }
    if (status.isLoaded && status.playing && snapshot.phase !== "playing") publish("playing");
    else if (!status.playing && snapshot.phase === "playing") publish("loading");
  }
  async function run(active: Job, source: LocalPlaybackSource) {
    let issue: LocalPlaybackSnapshot["issue"] = "source";
    try {
      await deps.validate(source); if (!valid(active)) return;
      issue = "prepare"; active.session = true;
      await deps.activate(); if (!valid(active)) return;
      await deps.configure(); if (!valid(active)) return;
      active.player = deps.create(source, status => sample(active, status));
      if (!valid(active)) return;
      issue = "native";
      active.player.play();
      sample(active, active.player.status());
    } catch { if (!active.ending) void finish(active, "error", issue); }
  }
  function stop() { return job ? finish(job, "idle") : Promise.resolve(true); }
  function play(source: LocalPlaybackSource): Promise<void> {
    if (job || !available()) return Promise.resolve();
    const active: Job = { ending: false, session: false };
    try { deps.reserve(stop); } catch { return Promise.resolve(); }
    job = active; publish("loading");
    active.startup = run(active, source);
    return active.startup;
  }
  return {
    play, stop, getSnapshot: () => snapshot, isBusy: () => job !== null,
    subscribe(listener: (value: LocalPlaybackSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    focus(value: boolean) { focused = value; if (!value) void stop(); },
    appState(value: string) { appState = value; if (value !== "active") void stop(); },
  };
}
