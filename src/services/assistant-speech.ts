import type { AssistantRequestStatusResponse } from "@/types/assistant-api";
import type { AssistantRecoveryReference } from "@/types/assistant-recovery";
import type { createVoiceHttpClient } from "@/services/api/voice";
import type { createLocalAudioPlayback } from "@/services/local-audio-playback";
import type { createSpeechFileStore, SpeechFile } from "@/services/speech-file";
import { inspectSpeechWav } from "@/utils/speech-wav";

type Ref = AssistantRecoveryReference;
type Entry = { ref: Ref; generation: number; epoch: number; voiceStart: boolean; followup: boolean; conversationId?: string; accepted: boolean; eligible: boolean; mayAccept?: () => boolean };
type Job = { entry: Entry; controller: AbortController; file?: SpeechFile; deadline: ReturnType<typeof setTimeout>; ending?: Promise<void> };
type Scope = { serverId: string | null; generation: number; allowed: boolean };
const keyOf = (ref: Ref, generation: number) => JSON.stringify([ref.serverId, generation, ref.requestId.toLowerCase()]);
const conversationKey = (entry: Entry, id: string) => JSON.stringify([entry.ref.serverId, entry.generation, id.toLowerCase()]);
// Runtime facts survive component recreation, never process restart. Generation is part of every key.
const voiceOrigins = new Set<string>(), speechReservations = new Set<string>();

/** Memory-only origin + per-request qualification. No Assistant POST or metadata writes. */
export function createAssistantSpeech(deps: {
  scope(): Scope;
  http: Pick<ReturnType<typeof createVoiceHttpClient>, "getSpeech">;
  check(ref: Ref, generation: number, signal: AbortSignal): Promise<unknown>;
  playback: ReturnType<typeof createLocalAudioPlayback>;
  files: ReturnType<typeof createSpeechFileStore>;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
  observe?(event: "download" | "download-complete" | "wav-validated" | "play-requested" | "interrupted" | "failed" | "cleanup-failed", detail?: Record<string, number | boolean>): void;
}) {
  const entries = new Map<string, Entry>(), origins = voiceOrigins, reserved = speechReservations;
  const setTimer = deps.setTimer ?? setTimeout, clearTimer = deps.clearTimer ?? clearTimeout;
  let epoch = 0, focused = false, appState = "active", active: Job | undefined;
  const notify = (event: Parameters<NonNullable<typeof deps.observe>>[0], detail?: Record<string, number | boolean>) => {
    if (typeof __DEV__ !== "undefined" && __DEV__) { try { deps.observe?.(event, detail); } catch {} }
  };
  const available = (entry: Entry) => {
    const scope = deps.scope();
    return focused && appState === "active" && scope.allowed && scope.serverId === entry.ref.serverId &&
      scope.generation === entry.generation && entry.epoch === epoch && entry.eligible;
  };
  const valid = (job: Job) => active === job && !job.controller.signal.aborted && available(job.entry);
  function end(job: Job): Promise<void> {
    if (job.ending) return job.ending;
    job.controller.abort(); clearTimer(job.deadline);
    // stop() joins startup and actual native cleanup, never play()'s return value.
    job.ending = (async () => {
      let safe = false;
      try { safe = await deps.playback.stop(); } catch {}
      if (job.file && !job.file.release(safe)) notify("cleanup-failed");
      job.file = undefined;
      if (active === job) active = undefined;
    })();
    return job.ending;
  }
  function interrupt() {
    epoch++;
    for (const entry of entries.values()) entry.eligible = false;
    if (active && !active.ending) notify("interrupted");
    return active ? end(active) : Promise.resolve();
  }
  function begin(ref: Ref, generation: number, voice: boolean, conversationId?: string, mayAccept?: () => boolean) {
    // Caller has won the common input lock. Older downloads/players cannot resume.
    void interrupt();
    try { deps.files.sweep(); } catch { /* Keep failed safe cleanup for a later input/mount. */ }
    const key = keyOf(ref, generation);
    if (entries.has(key) || reserved.has(key)) return;
    const entry: Entry = { ref: { ...ref }, generation, epoch, voiceStart: voice && !conversationId,
      followup: !!conversationId, conversationId, accepted: false, eligible: true, mayAccept };
    entries.set(key, entry);
    return entry;
  }
  function accept(ref: Ref, generation: number, response: AssistantRequestStatusResponse) {
    const entry = entries.get(keyOf(ref, generation));
    const scope = deps.scope();
    if (!entry || !scope.allowed || scope.serverId !== ref.serverId || scope.generation !== generation || response.requestId.toLowerCase() !== ref.requestId.toLowerCase() ||
      entry.conversationId && entry.conversationId.toLowerCase() !== response.conversationId.toLowerCase()) return false;
    if (entry.mayAccept && !entry.mayAccept()) return false;
    entry.mayAccept = undefined;
    entry.accepted = true; entry.conversationId = response.conversationId;
    if (entry.voiceStart) origins.add(conversationKey(entry, response.conversationId));
    return true;
  }
  const unsubscribe = deps.playback.subscribe(snapshot => {
    const job = active;
    if (!job) return;
    if (snapshot.phase === "completed" || snapshot.phase === "error") {
      void end(job);
    }
  });
  function wait(ms: number, signal: AbortSignal) {
    return new Promise<void>(resolve => {
      const done = () => { clearTimer(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimer(done, ms);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  async function download(job: Job) {
    try {
      for (let attempt = 0; attempt < 2 && valid(job); attempt++) {
        notify("download");
        const ref = job.entry.ref, generation = job.entry.generation;
        const result = await deps.http.getSpeech(ref, { expectedServerId: ref.serverId, expectedGeneration: generation, signal: job.controller.signal });
        if (!valid(job)) return;
        if (!result.ok) {
          const problem = result.error.kind === "http" ? result.error.problem : undefined;
          if (problem?.status === 409 && problem.code === "VOICE_BUSY" && attempt === 0) {
            await wait(2_000, job.controller.signal); continue;
          }
          if (problem?.status === 409 && problem.code === "SPEECH_NOT_READY") {
            await deps.check(ref, generation, job.controller.signal);
          }
          notify("failed"); return;
        }
        notify("download-complete", { bytes: result.data.byteLength });
        const { size, sampleRate, channels, bitDepth, durationMillis } = inspectSpeechWav(result.data);
        notify("wav-validated", { size, sampleRate, channels, bitDepth, durationMillis });
        if (!valid(job)) return;
        const file = await deps.files.create(result.data);
        if (!valid(job)) { if (!file.release(true)) notify("cleanup-failed"); return; }
        job.file = file;
        job.file.handoff();
        clearTimer(job.deadline); // 72 seconds bounds download, not listening time.
        notify("play-requested"); // Actual playing/EOF/safe native cleanup comes from local-playback.
        await deps.playback.play({ kind: "file", uri: job.file.uri, format: "wav" });
        return;
      }
    } catch { notify("failed"); }
    finally {
      if (active === job && (!valid(job) || !job.file || !deps.playback.isBusy())) await end(job);
    }
  }
  function observe(ref: Ref, generation: number, response: AssistantRequestStatusResponse) {
    if (!accept(ref, generation, response)) return;
    const key = keyOf(ref, generation), entry = entries.get(key);
    if (!entry || !entry.accepted || !available(entry) || response.status !== "completed" ||
      !entry.voiceStart && !entry.followup ||
      !origins.has(conversationKey(entry, response.conversationId)) || reserved.has(key)) return;
    reserved.add(key); // Reserve synchronously before the first download await, including failures.
    const ready = active ? end(active) : Promise.resolve();
    void ready.then(() => {
      if (!available(entry) || deps.playback.isBusy()) return;
      const job: Job = { entry, controller: new AbortController(), deadline: setTimer(() => { void end(job); }, 72_000) };
      active = job;
      void download(job);
    });
  }
  return {
    begin, accept, observe, interrupt,
    reject(ref: Ref, generation: number, identity?: object) { const entry = entries.get(keyOf(ref, generation)); if (entry && (!identity || entry === identity) && !entry.accepted) entries.delete(keyOf(ref, generation)); },
    focus(value: boolean) { focused = value; deps.playback.focus(value); if (!value) void interrupt(); },
    appState(value: string) { appState = value; deps.playback.appState(value); if (value !== "active") void interrupt(); },
    reset() { void interrupt(); entries.clear(); origins.clear(); },
    async dispose() { await interrupt(); unsubscribe(); },
  };
}
