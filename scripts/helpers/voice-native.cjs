const assert = require("node:assert/strict");
const { voiceSource, wavBytes } = require("./local-voice.cjs");
const config = voiceSource("src/constants/voice-recording.ts");
function fileAdapter(platform = "ios") {
  const entries = new Map(), deleted = [], native = { options: [], starts: [], listeners: new Set(), released: 0, active: [], modes: [], diagnostics: [], operations: [] };
  const join = parts => {
    const uri=parts.map(part => typeof part === "string" ? part.replace(/\/$/, "") : part.uri).join("/");
    return native.physicalAliases ? decodeURIComponent(uri).replace(/^file:\/\/\/private\/var\//,"file:///var/") : uri;
  };
  class File {
    constructor(...parts) { this.uri = join(parts); }
    get name() { return this.uri.split("/").at(-1); }
    get exists() { return entries.has(this.uri); }
    get size() { return entries.get(this.uri)?.size ?? entries.get(this.uri)?.bytes.length ?? 0; }
    async bytes() { native.reads = (native.reads ?? 0) + 1; if (native.beforeRead) await native.beforeRead(native.reads); if (native.readGate) await native.readGate; if (native.readFails) throw Error("read"); return entries.get(this.uri).bytes; }
    async move(destination) {
      native.operations.push("move"); if (native.moveGate) await native.moveGate;
      if (native.moveFails) { if (native.partialMove) entries.set(destination.uri, entries.get(this.uri)); throw Error("move"); }
      if (!native.moveDropsFile) entries.set(destination.uri, entries.get(this.uri));
      entries.delete(this.uri); this.uri = destination.uri;
    }
    delete() { deleted.push(this.uri); if (native.deleteFails) throw Error("delete"); if (!native.deleteNoop) entries.delete(this.uri); }
  }
  class Directory {
    constructor(...parts) { this.uri = join(parts); }
    get exists() { return true; }
    create() { native.operations.push("create-directory"); }
    list() { const result = [...entries.keys()].filter(uri => uri.startsWith(this.uri + "/")).map(uri => new File(uri)); native.onList?.(); return result; }
  }
  class Recorder {
    constructor(options) { native.stopped = false; native.started = false; native.options.push(options); this.id = "native-recorder"; this.uri = Object.hasOwn(native, "createdUri") ? native.createdUri : "file:///cache/owned.wav"; native.recorder = this;
      if (native.initialFile) entries.set(join([this.uri]), { bytes: new Uint8Array(0) }); }
    get isRecording() { return native.started === true && !native.stopped && native.actuallyRecording !== false; }
    addListener(event, listener) { assert.equal(event, "recordingStatusUpdate"); (native.callbacks ??= []).push(listener); native.listeners.add(listener); if (native.listenFails) throw Error("listener"); return { remove: () => native.listeners.delete(listener) }; }
    async prepareToRecordAsync(options) { native.prepared = options; if (Object.hasOwn(native, "preparedUri")) this.uri = native.preparedUri; }
    record(options) { native.starts.push(options); native.started = true; }
    getStatus() { return { isRecording: !native.stopped, canRecord: !native.stopped, durationMillis: 1000, fileSize: 32044 }; }
    async stop() { native.operations.push("stop-start"); if (native.stopGate) await native.stopGate;
      if (Object.hasOwn(native, "stoppedUri")) this.uri = native.stoppedUri;
      if (!native.noFile && this.uri) entries.set(join([this.uri]), { bytes: native.recordedBytes ?? wavBytes() });
      native.stopped = true; native.operations.push("stop-completed"); }
    release() { native.released++; }
  }
  const api = voiceSource("src/services/expo-voice-recording.ts", {
    "expo-audio": { AudioModule: { AudioRecorder: Recorder }, AudioQuality: { HIGH: 96 }, IOSOutputFormat: { LINEARPCM: "lpcm", MPEG4AAC: "aac " },
      getRecordingPermissionsAsync: async () => ({ granted: true }), requestRecordingPermissionsAsync: async () => ({ granted: true }),
      setAudioModeAsync: async mode => { native.modes.push(mode); }, setIsAudioActiveAsync: async value => { native.active.push(value); } },
    "expo-crypto": { randomUUID: () => native.uuid ?? "12345678-1234-4123-8123-123456789abc" },
    "expo-file-system": { Directory, File, Paths: { cache: new Directory("file:///cache") } },
    "react-native": { AppState: { currentState: "active" }, Platform: { OS: platform } },
    console: { info(prefix, event, detail) { native.diagnostics.push({ event, detail }); } },
  });
  const name = "assistant-voice-12345678-1234-4123-8123-123456789abc", profile = config.localVoiceProfile(platform);
  const uri = `file:///cache/${platform === "ios" ? "ExpoAudio" : "Audio"}/${name}${profile.extension}`;
  const managedUri = uri.replace(profile.extension, "-result" + profile.extension);
  return { api, entries, deleted, native, name, uri, managedUri, profile };
}

module.exports = { fileAdapter };
