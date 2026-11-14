/* global __dirname: readonly */
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");

function voiceSource(entry, external = {}) {
  const cache = new Map();
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative).exports;
    const module = { exports: {} }; cache.set(relative, module);
    const code = ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: relative,
    }).outputText;
    function resolve(name) {
      if (Object.hasOwn(external, name)) return external[name];
      if (name.startsWith("@/")) return load(`src/${name.slice(2)}.ts`);
      throw Error(`허용하지 않은 의존성: ${name}`);
    }
    new Function("require", "module", "exports", "__DEV__", "console", "setTimeout", "clearTimeout", code)(resolve, module, module.exports,
      true, external.console ?? { info() {} }, () => { throw Error("실제 타이머 금지"); }, () => {});
    return module.exports;
  }
  return load(entry);
}

function voiceFixture(overrides = () => {}) {
  const state = { available: true, app: "active", granted: true, canAskAgain: true, permissionReads: 0, requests: 0,
    activations: 0, configurations: 0, resets: 0, creates: 0, prepares: 0, starts: 0, stops: 0, releases: 0, inspections: 0,
    canRecord: false, isRecording: false, fileSize: 100, durationMillis: 1000, removed: [], events: [], snapshots: [], files: new Set() };
  const timers = new Map(); let timerId = 0, now = 0, listener;
  const info = { container: "wav", codec: "PCM_S16LE", sampleRate: 16000, channels: 1, bitDepth: 16, durationMillis: 1000, size: 32044 };
  const deps = {
    canStart: () => state.available, readAppState: () => state.app,
    async permission() { state.permissionReads++; return { granted: state.granted, canAskAgain: state.canAskAgain }; },
    async requestPermission() { state.requests++; return { granted: true, canAskAgain: true }; },
    async activate() { state.activations++; }, async configure() { state.configurations++; }, async reset() { state.resets++; },
    newName: () => `assistant-voice-owned-${state.creates + 1}`,
    create(name, callback) {
      state.creates++; state.files.add(name); listener = callback;
      return {
        async prepare() { state.prepares++; state.canRecord = true; },
        record() { state.starts++; state.isRecording = true; },
        status: () => ({ canRecord: state.canRecord, isRecording: state.isRecording, fileSize: state.fileSize, durationMillis: state.durationMillis }),
        async stop() { state.stops++; state.isRecording = false; state.canRecord = false; },
        uri: () => "file:///cache/owned.wav",
        release() { state.releases++; state.isRecording = false; state.canRecord = false; },
      };
    },
    files: {
      sweep() { state.files.clear(); },
      async inspect() { state.inspections++; return info; },
      remove(name) { state.removed.push(name); state.files.delete(name); },
    },
    setTimer(callback, ms) { const key = ++timerId; timers.set(key, { callback, at: now + ms }); return key; },
    clearTimer(key) { timers.delete(key); },
    observe(event, detail) { state.events.push({ event, detail }); },
  };
  overrides(deps, state);
  const controller = voiceSource("src/services/local-voice-recording.ts").createLocalVoiceRecording(deps);
  controller.focus(true); controller.subscribe(value => state.snapshots.push(value));
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  return { controller, state, deps, timers, info, settle,
    emit: event => listener?.(event),
    app(value) { state.app = value; controller.appState(value); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
      }
      now = target; await settle();
    },
  };
}

function wavBytes({ rate = 16000, channels = 1, bits = 16, frames = 160, code = 1 } = {}) {
  const dataSize = frames * channels * bits / 8, bytes = new Uint8Array(44 + dataSize), view = new DataView(bytes.buffer);
  const tag = (at, text) => [...text].forEach((char, i) => { bytes[at + i] = char.charCodeAt(0); });
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE"); tag(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, code, true); view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * bits / 8, true); view.setUint16(32, channels * bits / 8, true); view.setUint16(34, bits, true);
  tag(36, "data"); view.setUint32(40, dataSize, true); return bytes;
}

module.exports = { voiceSource, voiceFixture, wavBytes };
