const { voiceSource } = require("./local-voice.cjs");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

function playbackFixture(setup = () => {}, session = voiceSource("src/services/local-audio-session.ts").createLocalAudioSession()) {
  const owner = Symbol("test-player"), state = { available: true, creates: 0, starts: 0, pauses: 0, releases: 0, resets: 0,
    operations: [], callbacks: [], snapshots: [], events: [], files: new Set(["file:///cache/test.wav"]), playing: false, loaded: true, finished: false, failed: false };
  const deps = {
    canPlay: () => state.available, readAppState: () => "active",
    reserve: stop => session.beginPlayback(owner, stop), relinquish: safe => session.endPlayback(owner, safe),
    async validate(source) { state.operations.push("validate"); if (source.kind === "file" && !state.files.has(source.uri)) throw Error("missing"); },
    activate: () => session.activate(owner, async () => { state.operations.push("activate"); }),
    async configure() { state.operations.push("configure"); },
    reset: () => session.reset(owner, async () => { state.resets++; state.operations.push("reset"); }),
    create(source, listener) {
      state.creates++; state.operations.push("create"); state.callbacks.push(listener);
      return {
        play() { state.starts++; state.operations.push("play"); if (!state.delayPlaying) state.playing = true; },
        pause() { state.pauses++; state.operations.push("pause"); state.playing = false; },
        status: () => ({ playing: state.playing, isLoaded: state.loaded, didJustFinish: state.finished, failed: state.failed }),
        release() { state.releases++; state.operations.push("release"); },
      };
    },
    observe(phase, issue) { state.events.push({ phase, issue }); },
  };
  setup(deps, state);
  const controller = voiceSource("src/services/local-audio-playback.ts").createLocalAudioPlayback(deps);
  controller.focus(true); controller.subscribe(value => state.snapshots.push(value));
  return { controller, deps, state, session, settle,
    source: { kind: "file", uri: "file:///cache/test.wav", format: "wav" },
    emit(partial = {}, index = state.callbacks.length - 1) {
      state.callbacks[index]?.({ playing: state.playing, isLoaded: state.loaded, didJustFinish: state.finished, failed: state.failed, ...partial });
    } };
}

module.exports = { playbackFixture, deferred, settle };
