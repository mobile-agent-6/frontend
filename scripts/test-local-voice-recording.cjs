const assert = require("node:assert/strict");
const { test } = require("node:test");
const { voiceSource, voiceFixture, wavBytes } = require("./helpers/local-voice.cjs");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fixture = setup => voiceFixture(setup ?? (() => {}));

test("로컬 녹음: import/초기화는 권한·오디오·파일 작업을 시작하지 않음", () => {
  const f = fixture(); assert.equal(f.state.permissionReads, 0); assert.equal(f.state.requests, 0); assert.equal(f.state.activations, 0);
  assert.equal(f.state.creates, 0); assert.equal(f.controller.isBusy(), false);
});

test("로컬 녹음: 권한 승인·실제 시작 확인·정지·파일 검증·정리 후 recorded", async () => {
  const f = fixture(); await f.controller.start();
  assert.deepEqual(f.controller.getSnapshot().input, { source: "voice", phase: "recording" });
  assert.equal(f.state.starts, 1); assert.equal(f.state.requests, 0);
  await f.controller.stop();
  assert.deepEqual(f.controller.getSnapshot().input, { source: "voice", phase: "recorded" });
  assert.deepEqual(f.controller.getSnapshot().file, f.info); assert.equal(f.controller.isBusy(), false);
  assert.equal(f.state.stops, 1); assert.equal(f.state.releases, 1); assert.equal(f.state.resets, 1); assert.equal(f.state.files.size, 1);
  assert.equal(f.timers.size, 0); f.controller.discard(); assert.equal(f.state.files.size, 0);
});

for (const canAskAgain of [true, false]) test(`로컬 녹음: 권한 거절·재요청 가능 ${canAskAgain}·native 미실행·입력 복구`, async () => {
  const f = fixture((deps, state) => { state.granted = false; state.canAskAgain = canAskAgain;
    deps.requestPermission = async () => { state.requests++; return { granted: false, canAskAgain: false }; }; });
  await f.controller.start(); assert.equal(f.controller.getSnapshot().input.phase, "permission-error");
  assert.equal(f.controller.getSnapshot().issue, "permission-denied"); assert.equal(f.state.requests, canAskAgain ? 1 : 0);
  assert.equal(f.state.creates, 0); assert.equal(f.controller.isBusy(), false);
  f.state.canAskAgain = false; await f.controller.start(); assert.equal(f.state.requests, canAskAgain ? 1 : 0);
});

for (const api of ["permission", "requestPermission"]) test(`로컬 녹음: ${api} 자체 실패는 권한 오류·잠금 복구`, async () => {
  const f = fixture((deps, state) => { state.granted = false; deps[api] = async () => { throw Error("native permission"); }; });
  await f.controller.start(); assert.equal(f.controller.getSnapshot().input.phase, "permission-error");
  assert.equal(f.controller.isBusy(), false); assert.equal(f.state.activations, 0);
});

test("로컬 녹음: 권한 팝업 inactive는 허용하고 active 복귀 전에는 시작하지 않음", async () => {
  const gate = deferred(), f = fixture((deps, state) => { state.granted = false; deps.requestPermission = () => gate.promise; });
  const start = f.controller.start(); await f.settle(); f.app("inactive"); gate.resolve({ granted: true }); await f.settle();
  assert.equal(f.state.creates, 0); assert.equal(f.controller.isBusy(), true);
  f.app("active"); await start; assert.equal(f.state.starts, 1); await f.controller.cancel();
});

for (const exit of ["blur", "background", "unmount", "settings", "tab"]) test(`로컬 녹음: 권한 팝업 중 ${exit} 이후 지연 승인은 시작하지 않음`, async () => {
  const gate = deferred(), f = fixture((deps, state) => { state.granted = false; deps.requestPermission = () => gate.promise; });
  const start = f.controller.start(); await f.settle(); f.app("inactive");
  if (exit === "background") f.app("background"); else f.controller.focus(false);
  gate.resolve({ granted: true }); await start; f.controller.focus(true); f.app("active"); await f.settle();
  assert.equal(f.state.starts, 0); assert.equal(f.state.activations, 0); assert.equal(f.controller.isBusy(), false);
  assert.deepEqual(f.controller.getSnapshot().input, { source: "text" });
});

for (const api of ["activate", "configure", "prepare"]) test(`로컬 녹음: ${api} 지연 중 이탈·늦은 완료는 시작 금지·native 정리`, async () => {
  const gate = deferred(), f = fixture((deps) => {
    if (api === "prepare") { const create = deps.create; deps.create = (...args) => ({ ...create(...args), prepare: () => gate.promise }); }
    else deps[api] = () => gate.promise;
  });
  const start = f.controller.start(); await f.settle(); assert.ok(f.state.snapshots.every(s => s.input.phase !== "recording"));
  f.controller.focus(false); f.controller.focus(true); const repeat = f.controller.start();
  gate.resolve(); await start; await repeat; assert.equal(f.state.starts, 0); assert.equal(f.controller.isBusy(), false);
  assert.equal(f.state.files.size, 0); assert.equal(f.state.resets, 1);
});

for (const api of ["activate", "configure", "create", "prepare", "record"]) test(`로컬 녹음: ${api} 실패 시 로컬 오류·파일 및 세션 정리`, async () => {
  const f = fixture(deps => {
    if (["prepare", "record"].includes(api)) { const create = deps.create; deps.create = (...args) => ({ ...create(...args), [api]: () => { throw Error("native error"); } }); }
    else deps[api] = () => { throw Error("native error"); };
  });
  await f.controller.start(); assert.equal(f.controller.getSnapshot().input.phase, "recording-error");
  assert.equal(f.controller.isBusy(), false); assert.equal(f.state.files.size, 0); assert.equal(f.state.resets, 1);
});

test("로컬 녹음: 시작 API가 실제 recording 상태를 만들지 않으면 성공 UI 금지", async () => {
  const f = fixture(deps => { const create = deps.create; deps.create = (...args) => ({ ...create(...args), record() {} }); });
  await f.controller.start(); assert.equal(f.controller.getSnapshot().issue, "start"); assert.equal(f.controller.getSnapshot().input.phase, "recording-error");
  assert.equal(f.state.files.size, 0); assert.equal(f.controller.isBusy(), false);
});

test("로컬 녹음: 마이크 연타·준비 중 stop·텍스트 가드에 사용할 동기 잠금", async () => {
  const gate = deferred(), f = fixture(deps => { deps.permission = () => gate.promise; });
  const start = f.controller.start(); assert.equal(f.controller.isBusy(), true);
  await Promise.all([f.controller.start(), f.controller.start(), f.controller.stop()]); assert.equal(f.state.starts, 0);
  gate.resolve({ granted: true }); await start; assert.equal(f.state.creates, 1); assert.equal(f.state.starts, 1); await f.controller.cancel();
});

test("로컬 녹음: 사용자·자동 종료·native 완료가 겹쳐도 stop/검증/release 각 1회", async () => {
  const gate = deferred(), f = fixture((deps, state) => { const create = deps.create;
    deps.create = (...args) => ({ ...create(...args), async stop() { state.stops++; await gate.promise; state.isRecording = false; state.canRecord = false; } }); });
  await f.controller.start(); const stop = f.controller.stop(); await f.settle();
  f.controller.stop(); f.emit({ isFinished: true, hasError: false }); await f.advance(15000);
  assert.equal(f.controller.getSnapshot().input.phase, "stopping"); assert.equal(f.state.stops, 1);
  gate.resolve(); await stop; assert.equal(f.state.inspections, 1); assert.equal(f.state.releases, 1); assert.equal(f.timers.size, 0);
});

test("로컬 녹음: 15초 자동 종료와 1,048,576바이트 제안 제한", async () => {
  const f = fixture(); await f.controller.start(); await f.advance(15000);
  assert.equal(f.state.stops, 1); assert.equal(f.controller.getSnapshot().input.phase, "recorded");
  await f.controller.start(); f.state.fileSize = 1048577; await f.advance(250);
  assert.equal(f.controller.getSnapshot().issue, "file-too-large"); assert.equal(f.state.files.size, 0); assert.equal(f.controller.isBusy(), false);
});

for (const error of ["missing-file", "invalid-file", "file-too-large", "file-too-long"]) test(`로컬 녹음: ${error} 검증 실패는 recorded 금지·소유 파일 정리`, async () => {
  const f = fixture(deps => { deps.files.inspect = async () => { throw Error(error); }; });
  await f.controller.start(); await f.controller.stop(); assert.equal(f.controller.getSnapshot().issue, error);
  assert.equal(f.controller.getSnapshot().input.phase, "recording-error"); assert.equal(f.state.files.size, 0); assert.equal(f.controller.isBusy(), false);
});

test("로컬 녹음: 너무 빠른 stop/native 종료 오류도 release·파일 삭제·입력 복구", async () => {
  const f = fixture((deps, state) => { const create = deps.create; deps.create = (...args) => ({ ...create(...args), stop() { state.stops++; throw Error("E_AUDIO_NODATA"); } }); });
  await f.controller.start(); await f.controller.stop(); assert.equal(f.state.stops, 1); assert.equal(f.state.releases, 1);
  assert.equal(f.controller.getSnapshot().issue, "stop"); assert.equal(f.state.files.size, 0); assert.equal(f.controller.isBusy(), false);
});

for (const exit of ["blur", "tab", "settings", "background", "inactive", "unmount"]) test(`로컬 녹음: recording 중 ${exit} 취소·파일 삭제·복귀 후 자동 재개 없음`, async () => {
  const f = fixture(); await f.controller.start();
  if (["background", "inactive"].includes(exit)) f.app(exit); else f.controller.focus(false);
  await f.settle(); f.emit({ isFinished: true, hasError: false }); f.controller.focus(true); f.app("active"); await f.settle();
  assert.deepEqual(f.controller.getSnapshot().input, { source: "text" }); assert.equal(f.state.starts, 1);
  assert.equal(f.state.files.size, 0); assert.equal(f.state.releases, 1); assert.equal(f.timers.size, 0);
});

test("로컬 녹음: stop/파일 검증 대기 중 취소는 지연 파일을 유효 결과로 등록하지 않음", async () => {
  const gate = deferred(), f = fixture(deps => { deps.files.inspect = () => gate.promise; });
  await f.controller.start(); const stop = f.controller.stop(); await f.settle(); const cancel = f.controller.cancel();
  gate.resolve(f.info); await Promise.all([stop, cancel]); assert.equal(f.state.files.size, 0);
  assert.ok(f.state.snapshots.every(s => s.input.phase !== "recorded")); assert.equal(f.controller.isBusy(), false);
});

test("로컬 녹음: native 오류·중단은 STT 오류가 아닌 로컬 오류", async () => {
  const f = fixture(); await f.controller.start(); f.emit({ isFinished: true, hasError: true }); await f.settle();
  assert.equal(f.controller.getSnapshot().issue, "native"); assert.equal(f.controller.getSnapshot().input.phase, "recording-error");
  assert.equal(f.state.files.size, 0); assert.equal(f.controller.isBusy(), false);
});

test("로컬 녹음: native 자동 종료는 중복 stop 없이 파일 검증", async () => {
  const f = fixture(); await f.controller.start(); f.state.isRecording = false; f.state.canRecord = false;
  f.emit({ isFinished: true, hasError: false }); await f.settle();
  assert.equal(f.state.stops, 0); assert.equal(f.controller.getSnapshot().input.phase, "recorded");
});

for (const failure of ["reset", "release", "remove", "sweep"]) test(`로컬 녹음: ${failure} 정리 실패도 잠금 해제·성공 위장 없음`, async () => {
  const f = fixture(deps => {
    if (failure === "release") { const create = deps.create; deps.create = (...args) => ({ ...create(...args), release() { throw Error("release"); } }); }
    else if (failure === "reset") deps.reset = async () => { throw Error("reset"); };
    else deps.files[failure] = () => { throw Error("file cleanup"); };
  });
  await f.controller.start(); if (failure === "remove") await f.controller.cancel(); else await f.controller.stop();
  assert.equal(f.controller.isBusy(), false); assert.ok(f.state.snapshots.every(s => s.input.phase !== "recorded"));
  assert.equal(f.controller.getSnapshot().issue, "cleanup");
});

test("로컬 녹음: 재녹음·텍스트 전송에 준하는 discard·화면 이탈은 최신 결과 삭제", async () => {
  const f = fixture(); await f.controller.start(); await f.controller.stop(); const previous = [...f.state.files][0];
  await f.controller.start(); assert.ok(f.state.removed.includes(previous)); assert.equal(f.state.files.size, 1);
  await f.controller.stop(); f.controller.discard(); assert.equal(f.state.files.size, 0);
  await f.controller.start(); await f.controller.stop(); await f.controller.cancel(); assert.equal(f.state.files.size, 0);
});

test("로컬 녹음: 입력 불가·focus 없음·background 및 작업 중 정책 변경 보호", async () => {
  const f = fixture(); f.state.available = false; await f.controller.start(); assert.equal(f.state.creates, 0);
  f.state.available = true; f.controller.focus(false); await f.controller.start(); assert.equal(f.state.creates, 0);
  f.controller.focus(true); f.app("background"); await f.controller.start(); assert.equal(f.state.creates, 0);
  f.app("active"); await f.controller.start(); f.state.available = false; f.controller.checkAvailability(); await f.settle();
  assert.equal(f.state.files.size, 0); assert.equal(f.controller.isBusy(), false);
});

const metadata = voiceSource("src/utils/voice-recording-metadata.ts"), config = voiceSource("src/constants/voice-recording.ts");
test("녹음 파일: WAV 헤더에서 PCM·16kHz·mono·16-bit·길이·크기 확인", () => {
  const bytes = wavBytes(); const info = metadata.inspectVoiceBytes(bytes, config.VOICE_RECORDING_PROFILES.wav);
  assert.deepEqual(info, { container: "wav", codec: "PCM_S16LE", sampleRate: 16000, channels: 1, bitDepth: 16, durationMillis: 10, size: 364 });
  assert.equal(config.LOCAL_VOICE_LIMITS.maxBytes, 1048576); assert.equal(config.LOCAL_VOICE_LIMITS.durationSeconds, 15);
  assert.equal(config.localVoiceProfile("ios").container, "wav"); assert.equal(config.localVoiceProfile("android").container, "m4a");
});
for (const [name, options] of Object.entries({ wrongRate: { rate: 44100 }, stereo: { channels: 2 }, wrongBits: { bits: 8 }, float: { code: 3 }, empty: { frames: 0 } })) {
  test(`녹음 파일: ${name} WAV를 요청 옵션 일치로 위장하지 않음`, () => {
    assert.throws(() => metadata.inspectVoiceBytes(wavBytes(options), config.VOICE_RECORDING_PROFILES.wav));
  });
}
test("녹음 파일: 확장자와 무관하게 잘린 헤더·data 초과·비 WAV 파일 거부", () => {
  const bytes = wavBytes(); assert.throws(() => metadata.inspectVoiceBytes(bytes.slice(0, 30), config.VOICE_RECORDING_PROFILES.wav));
  new DataView(bytes.buffer).setUint32(40, 100000, true); assert.throws(() => metadata.inspectVoiceBytes(bytes, config.VOICE_RECORDING_PROFILES.wav));
  assert.throws(() => metadata.inspectVoiceBytes(new Uint8Array(100), config.VOICE_RECORDING_PROFILES.wav));
});

function fileAdapter(platform = "ios") {
  const entries = new Map(), deleted = [], native = { options: [], starts: [], listeners: new Set(), released: 0, active: [], modes: [], diagnostics: [], operations: [] };
  const join = parts => parts.map(part => typeof part === "string" ? part.replace(/\/$/, "") : part.uri).join("/");
  class File {
    constructor(...parts) { this.uri = join(parts); }
    get name() { return this.uri.split("/").at(-1); }
    get exists() { return entries.has(this.uri); }
    get size() { return entries.get(this.uri)?.size ?? entries.get(this.uri)?.bytes.length ?? 0; }
    async bytes() { native.reads = (native.reads ?? 0) + 1; if (native.readFails) throw Error("read"); return entries.get(this.uri).bytes; }
    async move(destination) {
      native.operations.push("move"); if (native.moveGate) await native.moveGate;
      if (native.moveFails) { if (native.partialMove) entries.set(destination.uri, entries.get(this.uri)); throw Error("move"); }
      if (!native.moveDropsFile) entries.set(destination.uri, entries.get(this.uri));
      entries.delete(this.uri); this.uri = destination.uri;
    }
    delete() { deleted.push(this.uri); entries.delete(this.uri); }
  }
  class Directory {
    constructor(...parts) { this.uri = join(parts); }
    get exists() { return true; }
    create() { native.operations.push("create-directory"); }
    list() { return [...entries.keys()].filter(uri => uri.startsWith(this.uri + "/")).map(uri => new File(uri)); }
  }
  class Recorder {
    constructor(options) { native.options.push(options); this.id = "native-recorder"; this.uri = Object.hasOwn(native, "createdUri") ? native.createdUri : "file:///cache/owned.wav"; native.recorder = this;
      if (native.initialFile) entries.set(this.uri, { bytes: new Uint8Array(0) }); }
    get isRecording() { return native.started === true && !native.stopped && native.actuallyRecording !== false; }
    addListener(event, listener) { assert.equal(event, "recordingStatusUpdate"); native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) }; }
    async prepareToRecordAsync(options) { native.prepared = options; if (Object.hasOwn(native, "preparedUri")) this.uri = native.preparedUri; }
    record(options) { native.starts.push(options); native.started = true; }
    getStatus() { return { isRecording: !native.stopped, canRecord: !native.stopped, durationMillis: 1000, fileSize: 32044 }; }
    async stop() { native.operations.push("stop-start"); if (native.stopGate) await native.stopGate;
      if (Object.hasOwn(native, "stoppedUri")) this.uri = native.stoppedUri;
      if (!native.noFile && this.uri) entries.set(this.uri, { bytes: native.recordedBytes ?? wavBytes() });
      native.stopped = true; native.operations.push("stop-completed"); }
    release() { native.released++; }
  }
  const api = voiceSource("src/services/expo-voice-recording.ts", {
    "expo-audio": { AudioModule: { AudioRecorder: Recorder }, AudioQuality: { HIGH: 96 }, IOSOutputFormat: { LINEARPCM: "lpcm", MPEG4AAC: "aac " },
      getRecordingPermissionsAsync: async () => ({ granted: true }), requestRecordingPermissionsAsync: async () => ({ granted: true }),
      setAudioModeAsync: async mode => { native.modes.push(mode); }, setIsAudioActiveAsync: async value => { native.active.push(value); } },
    "expo-crypto": { randomUUID: () => "12345678-1234-4123-8123-123456789abc" },
    "expo-file-system": { Directory, File, Paths: { cache: new Directory("file:///cache") } },
    "react-native": { AppState: { currentState: "active" }, Platform: { OS: platform } },
    console: { info(prefix, event, detail) { native.diagnostics.push({ event, detail }); } },
  });
  const name = "assistant-voice-12345678-1234-4123-8123-123456789abc", profile = config.localVoiceProfile(platform);
  const uri = `file:///cache/${platform === "ios" ? "ExpoAudio" : "Audio"}/${name}${profile.extension}`;
  const managedUri = uri.replace(profile.extension, "-result" + profile.extension);
  return { api, entries, deleted, native, name, uri, managedUri, profile };
}

test("Expo adapter: iOS WAV/PCM은 확장자만 변경하지 않고 native 코덱·채널·비트 설정 전달", async () => {
  const f = fileAdapter(), deps = f.api.createExpoVoiceDependencies(() => true);
  const recorder = deps.create(f.name, () => {}); await recorder.prepare(); recorder.record();
  assert.equal(f.native.options[0].outputFormat, "lpcm"); assert.equal(f.native.options[0].extension, ".wav");
  assert.equal(f.native.options[0].sampleRate, 16000); assert.equal(f.native.options[0].numberOfChannels, 1);
  assert.equal(f.native.options[0].linearPCMBitDepth, 16); assert.equal(f.native.options[0].linearPCMIsBigEndian, false);
  assert.equal(f.native.options[0].linearPCMIsFloat, false); assert.equal(f.native.options[0].isMeteringEnabled, false);
  assert.equal(f.native.options[0].directory, "cache"); assert.equal(f.native.options[0].fileName, f.name);
  assert.deepEqual(f.native.starts, [{ forDuration: 15 }]); await recorder.stop(); recorder.release();
  assert.equal(f.native.listeners.size, 0); assert.equal(f.native.released, 1);
});

test("Expo adapter: SDK status가 recording이어도 실제 native isRecording=false이면 시작 성공으로 보지 않음", () => {
  const f = fileAdapter(), deps = f.api.createExpoVoiceDependencies(() => true), recorder = deps.create(f.name, () => {});
  recorder.record();
  assert.equal(recorder.status().isRecording, true); f.native.actuallyRecording = false;
  assert.equal(recorder.status().isRecording, false); recorder.release();
});

test("Expo adapter: Android는 공개 MediaRecorder의 M4A/AAC 대체 설정·동일 mono", () => {
  const f = fileAdapter("android"), deps = f.api.createExpoVoiceDependencies(() => true); const recorder = deps.create(f.name, () => {});
  assert.equal(f.native.options[0].extension, ".m4a"); assert.equal(f.native.options[0].outputFormat, "mpeg4");
  assert.equal(f.native.options[0].audioEncoder, "aac"); assert.equal(f.native.options[0].numberOfChannels, 1); recorder.release();
});

test("Expo adapter: native 오디오 세션 소유권·백그라운드 비활성·독립 owner의 reset 격리", async () => {
  const f = fileAdapter(), a = f.api.createExpoVoiceDependencies(() => true), b = f.api.createExpoVoiceDependencies(() => true);
  await a.activate(); await a.configure(); await assert.rejects(b.activate()); await b.reset();
  assert.deepEqual(f.native.active, [true]); assert.equal(f.native.modes[0].shouldPlayInBackground, false);
  assert.equal(f.native.modes[0].allowsBackgroundRecording, false);
  await a.reset(); assert.deepEqual(f.native.active, [true, false]); await b.activate(); await b.reset();
});

test("녹음 파일 소유권: SDK cache의 자체 prefix만 sweep하고 다른 파일은 보존", () => {
  const f = fileAdapter(), store = f.api.createVoiceFileStore(f.profile, "ios");
  f.entries.set(f.uri, { bytes: wavBytes() }); f.entries.set("file:///cache/ExpoAudio/other.wav", { bytes: wavBytes() });
  f.entries.set("file:///cache/schedule-cache.json", { bytes: new Uint8Array(1) }); store.sweep();
  assert.deepEqual(f.deleted, [f.uri]); assert.equal(f.entries.size, 2);
  for (const name of ["../other", "assistant-voice-../a", "other", f.name + "/../other"]) assert.throws(() => store.remove(name));
});

test("녹음 파일 소유권: URI 검증·실제 헤더·크기 제한·빈 파일·삭제 후 존재 확인", async () => {
  const f = fileAdapter(), store = f.api.createVoiceFileStore(f.profile, "ios");
  store.captureNativeFile(f.name, f.uri);
  await assert.rejects(store.inspect(f.name, f.uri), /missing-file/);
  f.entries.set(f.uri, { bytes: wavBytes() }); await assert.rejects(store.inspect(f.name, "file:///other.wav"), /unowned-recording-file/);
  const info = await store.inspect(f.name, f.uri); assert.equal(info.codec, "PCM_S16LE"); assert.equal(info.sampleRate, 16000);
  assert.equal(f.entries.has(f.managedUri), true); assert.equal(f.entries.has(f.uri), false);
  store.remove(f.name); store.captureNativeFile(f.name, f.uri);
  const reads = f.native.reads; f.entries.set(f.uri, { bytes: wavBytes(), size: 1048577 });
  await assert.rejects(store.inspect(f.name, f.uri), /file-too-large/); assert.equal(f.native.reads, reads);
  f.entries.set(f.uri, { bytes: new Uint8Array(0) }); await assert.rejects(store.inspect(f.name, f.uri), /invalid-file/);
  store.remove(f.name); assert.equal(f.entries.has(f.uri), false); store.remove(f.name);
});

test("녹음 파일: M4A 후보는 실제 코덱·sampleRate·channels를 검증 완료로 주장하지 않음", () => {
  const bytes = new Uint8Array(40), view = new DataView(bytes.buffer);
  for (const [at, size, type] of [[0, 16, "ftyp"], [16, 12, "moov"], [28, 12, "mdat"]]) {
    view.setUint32(at, size); [...type].forEach((char, i) => { bytes[at + 4 + i] = char.charCodeAt(0); });
  }
  const info = metadata.inspectVoiceBytes(bytes, config.VOICE_RECORDING_PROFILES.aac);
  assert.deepEqual(info, { container: "m4a", codec: "unverified", size: 40 });
  assert.throws(() => metadata.inspectVoiceBytes(bytes, config.VOICE_RECORDING_PROFILES.wav));
});

test("녹음 파일: 실제 WAV data 길이 기준 15초는 허용하고 1 sample 초과부터 거부", () => {
  const exact = metadata.inspectVoiceBytes(wavBytes({ frames: 16000 * 15 }), config.VOICE_RECORDING_PROFILES.wav);
  assert.equal(exact.durationMillis, 15000); assert.equal(exact.size, 480044);
  assert.throws(() => metadata.inspectVoiceBytes(wavBytes({ frames: 16000 * 15 + 1 }), config.VOICE_RECORDING_PROFILES.wav), /file-too-long/);
});

test("로컬 녹음: native stop 대기 중 background 취소는 늦은 recorded와 중복 종료 없음", async () => {
  const gate = deferred(), f = fixture((deps, state) => { const create = deps.create;
    deps.create = (...args) => ({ ...create(...args), async stop() { state.stops++; await gate.promise; state.isRecording = false; state.canRecord = false; } }); });
  await f.controller.start(); const stop = f.controller.stop(); await f.settle(); f.app("background");
  gate.resolve(); await stop; f.app("active");
  assert.equal(f.state.stops, 1); assert.equal(f.state.inspections, 0); assert.equal(f.state.files.size, 0);
  assert.equal(f.controller.isBusy(), false); assert.deepEqual(f.controller.getSnapshot().input, { source: "text" });
});

test("로컬 녹음: prepare 대기 중 native 오류는 준비 완료 후 정리하며 recording UI 없음", async () => {
  const gate = deferred(), f = fixture(deps => { const create = deps.create;
    deps.create = (...args) => ({ ...create(...args), prepare: () => gate.promise }); });
  const start = f.controller.start(); await f.settle(); f.emit({ isFinished: true, hasError: true }); gate.resolve(); await start;
  assert.equal(f.controller.getSnapshot().issue, "native"); assert.equal(f.state.starts, 0); assert.equal(f.state.files.size, 0);
  assert.equal(f.state.releases, 1); assert.ok(f.state.snapshots.every(s => s.input.phase !== "recording"));
});

test("로컬 녹음: native 중단은 status 감시에서 감지하고 자동 재개 없이 종료", async () => {
  const f = fixture(); await f.controller.start(); f.state.isRecording = false; f.state.canRecord = true; await f.advance(250);
  assert.equal(f.controller.getSnapshot().issue, "native"); assert.equal(f.controller.isBusy(), false); assert.equal(f.state.files.size, 0);
});

test("로컬 녹음: 이전 결과 삭제 실패 시 새 recorder 생성 금지·입력 잠금 해제", async () => {
  const f = fixture(); await f.controller.start(); await f.controller.stop(); f.deps.files.remove = () => { throw Error("delete failed"); };
  await f.controller.start(); assert.equal(f.state.creates, 1); assert.equal(f.controller.getSnapshot().issue, "cleanup");
  assert.equal(f.controller.isBusy(), false); assert.equal(f.state.files.size, 1);
});

test("녹음 파일: RIFF 크기 불일치와 byteRate 불일치는 확장자로 신뢰하지 않음", () => {
  const bytes = wavBytes(), view = new DataView(bytes.buffer); view.setUint32(4, bytes.length - 10, true);
  assert.throws(() => metadata.inspectVoiceBytes(bytes, config.VOICE_RECORDING_PROFILES.wav));
  view.setUint32(4, bytes.length - 8, true); view.setUint32(28, 44100, true);
  assert.throws(() => metadata.inspectVoiceBytes(bytes, config.VOICE_RECORDING_PROFILES.wav));
});

// Controller와 Expo adapter/FileStore를 함께 실행하고 native·파일 시스템만 대체한다.
function nativeRecordingFixture(setup = () => {}) {
  const f = fileAdapter(); setup(f);
  const clock = fixture(), deps = f.api.createExpoVoiceDependencies(() => true);
  deps.setTimer = clock.deps.setTimer; deps.clearTimer = clock.deps.clearTimer;
  const controller = voiceSource("src/services/local-voice-recording.ts").createLocalVoiceRecording(deps), snapshots = [];
  controller.focus(true); controller.subscribe(value => snapshots.push(value));
  return { ...f, controller, snapshots, settle: clock.settle, timers: clock.timers,
    emit(event) { for (const listener of [...f.native.listeners]) listener({ id: "native-recorder", ...event }); } };
}

test("실제 adapter 회귀: 예상 UUID 경로와 다른 native URI의 WAV를 이동·헤더 검증·정리", async () => {
  const f = nativeRecordingFixture(); await f.controller.start(); await f.controller.stop();
  assert.equal(f.entries.has(f.uri), false); assert.equal(f.entries.has(f.managedUri), true);
  assert.equal(f.controller.getSnapshot().input.phase, "recorded");
  assert.deepEqual(f.controller.getSnapshot().file, metadata.inspectVoiceBytes(wavBytes(), f.profile));
  assert.deepEqual(f.native.operations, ["stop-start", "stop-completed", "move"]);
  const source = f.native.diagnostics.find(d => d.event === "file-source").detail;
  assert.equal(source.uriMatchesExpected, false); assert.equal(source.sourceExists, true); assert.equal(source.expectedExists, false);
  assert.equal(source.registered, true); assert.equal(f.native.released, 1); assert.equal(f.timers.size, 0);
  f.controller.discard(); assert.equal(f.entries.size, 0);
});

test("실제 adapter 회귀: constructor·prepare·stop의 URI 변경과 다른 iOS cache root 추적", async () => {
  const f = nativeRecordingFixture(({ native }) => {
    native.initialFile = true; native.createdUri = "file:///old/Library/Caches/ExpoAudio/initial.wav";
    native.preparedUri = "file:///old/Library/Caches/ExpoAudio/prepared.wav";
    native.stoppedUri = "file:///old/Library/Caches/ExpoAudio/final.wav";
  });
  await f.controller.start(); f.entries.set(f.native.preparedUri, { bytes: new Uint8Array(0) });
  await f.controller.stop(); assert.equal(f.controller.getSnapshot().input.phase, "recorded");
  assert.deepEqual([...f.entries.keys()], [f.managedUri]);
  assert.ok(f.deleted.includes(f.native.createdUri)); assert.ok(f.deleted.includes(f.native.preparedUri));
  f.controller.focus(false); assert.equal(f.entries.size, 0);
});

test("실제 adapter 회귀: URI가 정지 이후에만 확정되어도 최종 URI 사용", async () => {
  const f = nativeRecordingFixture(({ native }) => { native.createdUri = null; native.stoppedUri = "file:///cache/final.wav"; });
  await f.controller.start(); await f.controller.stop(); assert.equal(f.controller.getSnapshot().input.phase, "recorded");
  assert.equal(f.native.diagnostics.find(d => d.event === "recorder-created").detail.hasUri, false);
  assert.equal(f.native.diagnostics.find(d => d.event === "recorder-final-uri").detail.sourceExists, true);
  f.controller.discard(); assert.equal(f.entries.size, 0);
});

test("실제 adapter 회귀: 기존 예상 경로와 일치하는 파일도 정상 검증", async () => {
  const f = nativeRecordingFixture(f => { f.native.createdUri = f.uri; });
  await f.controller.start(); await f.controller.stop(); assert.equal(f.controller.getSnapshot().input.phase, "recorded");
  assert.equal(f.native.diagnostics.find(d => d.event === "file-source").detail.uriMatchesExpected, true);
  f.controller.discard(); assert.equal(f.entries.size, 0);
});

for (const noUri of [false, true]) test(`실제 adapter 회귀: 실제 파일 없음·URI 없음=${noUri}는 성공 위장 없이 missing-file`, async () => {
  const f = nativeRecordingFixture(({ native }) => { native.noFile = true; if (noUri) native.createdUri = null; });
  await f.controller.start(); await f.controller.stop();
  assert.equal(f.controller.getSnapshot().issue, "missing-file"); assert.equal(f.controller.isBusy(), false);
  assert.equal(f.entries.size, 0); assert.equal(f.native.released, 1);
  assert.ok(!f.native.diagnostics.some(d => d.event === "file-deleted"));
  assert.ok(f.native.diagnostics.some(d => d.event === "file-cleanup" && d.detail.deletedCount === 0));
  assert.equal(f.native.diagnostics.find(d => d.event === "file-source").detail.sourceExists, false);
});

for (const failure of ["move", "partial-move", "move-drops-file", "read"]) test(`실제 adapter 회귀: ${failure} 실패 시 원본·목적 파일 정리와 잠금 복구`, async () => {
  const f = nativeRecordingFixture(({ native }) => {
    if (failure === "read") native.readFails = true;
    else if (failure === "move-drops-file") native.moveDropsFile = true;
    else { native.moveFails = true; native.partialMove = failure === "partial-move"; }
  });
  await f.controller.start(); await f.controller.stop();
  assert.equal(f.controller.getSnapshot().input.phase, "recording-error"); assert.equal(f.controller.isBusy(), false);
  assert.equal(f.entries.size, 0); assert.equal(f.native.released, 1);
  assert.ok(f.snapshots.every(s => s.input.phase !== "recorded"));
  const expected = failure === "read" ? "file-read-failed" : failure === "move-drops-file" ? "file-move-completed" : "file-move-failed";
  assert.ok(f.native.diagnostics.some(d => d.event === expected));
});

test("실제 adapter 회귀: native 완료 URL과 사용자 stop이 겹쳐도 정지·이동·검증 한 번", async () => {
  const gate = deferred(), f = nativeRecordingFixture(({ native }) => { native.stopGate = gate.promise; });
  await f.controller.start(); const stop = f.controller.stop(); await f.settle();
  const final = "file:///cache/event-final.wav"; f.native.stoppedUri = final;
  f.emit({ isFinished: true, hasError: false, url: final }); f.controller.stop();
  gate.resolve(); await stop;
  assert.equal(f.controller.getSnapshot().input.phase, "recorded");
  assert.equal(f.native.operations.filter(op => op === "stop-start").length, 1);
  assert.equal(f.native.operations.filter(op => op === "move").length, 1); assert.equal(f.native.reads, 1);
  assert.equal(f.native.released, 1); f.controller.discard(); assert.equal(f.entries.size, 0);
});

test("실제 adapter 회귀: 자동 완료 이벤트 URL을 사용하고 다른 recorder 이벤트 무시", async () => {
  const f = nativeRecordingFixture(); await f.controller.start();
  f.emit({ id: "other-recorder", isFinished: true, hasError: true, url: "file:///cache/other.wav" });
  assert.equal(f.controller.getSnapshot().input.phase, "recording");
  const final = "file:///cache/native-final.wav"; f.entries.set(final, { bytes: wavBytes() });
  f.native.stopped = true; f.emit({ isFinished: true, hasError: false, url: final }); await f.settle();
  assert.equal(f.controller.getSnapshot().input.phase, "recorded");
  assert.equal(f.native.operations.includes("stop-start"), false); assert.equal(f.native.reads, 1);
  f.controller.discard(); assert.equal(f.entries.size, 0);
});

test("실제 adapter 회귀: 이동 대기 중 화면 이탈은 늦은 recorded 없이 양쪽 파일 정리", async () => {
  const gate = deferred(), f = nativeRecordingFixture(({ native }) => { native.moveGate = gate.promise; });
  await f.controller.start(); const stop = f.controller.stop(); await f.settle();
  assert.ok(f.native.operations.includes("move")); f.controller.focus(false);
  gate.resolve(); await stop; f.controller.focus(true);
  assert.ok(f.snapshots.every(s => s.input.phase !== "recorded")); assert.equal(f.entries.size, 0);
  assert.equal(f.controller.isBusy(), false); assert.deepEqual(f.controller.getSnapshot().input, { source: "text" });
});

test("실제 adapter 회귀: 잘못된 실제 WAV 헤더는 이동 후에도 거부·정리", async () => {
  const f = nativeRecordingFixture(({ native }) => { native.recordedBytes = wavBytes({ rate: 44100 }); });
  await f.controller.start(); await f.controller.stop();
  assert.equal(f.controller.getSnapshot().issue, "invalid-file"); assert.equal(f.entries.size, 0);
  assert.equal(f.controller.isBusy(), false); assert.equal(f.native.reads, 1);
});

test("녹음 파일 소유권 회귀: 등록하지 않은 URI와 cache 외부 경로는 읽기·삭제 금지", async () => {
  const f = fileAdapter(), store = f.api.createVoiceFileStore(f.profile, "ios");
  for (const uri of ["file:///documents/private.wav", "https://example.invalid/audio.wav", "file:///cache/../private.wav"]) {
    assert.equal(store.captureNativeFile(f.name, uri), false);
  }
  const unrelated = "file:///cache/other.wav"; f.entries.set(unrelated, { bytes: wavBytes() });
  await assert.rejects(store.inspect(f.name, unrelated), /unowned-recording-file/);
  store.remove(f.name); assert.equal(f.entries.has(unrelated), true); assert.equal(f.native.reads, undefined);
});

test("실제 adapter 진단: 경로·파일명·원본을 출력하지 않고 정지→검증→이동→헤더→삭제 순서 표시", async () => {
  const f = nativeRecordingFixture(); await f.controller.start(); await f.controller.stop(); f.controller.discard();
  const events = f.native.diagnostics.map(d => d.event);
  for (const [before, after] of [["recorder-stop-completed", "file-validation-started"], ["file-validation-started", "file-move-started"],
    ["file-move-completed", "file-validated"], ["file-validated", "file-deleted"]]) assert.ok(events.indexOf(before) < events.indexOf(after));
  const serialized = JSON.stringify(f.native.diagnostics);
  assert.ok(!serialized.includes("file://")); assert.ok(!serialized.includes(f.name)); assert.ok(!serialized.includes("Library/Caches"));
  for (const { event, detail } of f.native.diagnostics) {
    if (event !== "file-validated" && event !== "recording-error") assert.ok(Object.values(detail).every(v => typeof v === "number" || typeof v === "boolean" || v === null));
  }
  assert.equal(f.native.diagnostics.find(d => d.event === "file-deleted").detail.existedBeforeDelete, true);
});
