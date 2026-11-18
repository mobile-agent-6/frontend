const assert = require("node:assert/strict");
const { test } = require("node:test");
const { voiceSource } = require("./helpers/local-voice.cjs");
const { playbackFixture, settle, deferred } = require("./helpers/local-playback.cjs");
const { speechFiles, speechWav } = require("./helpers/speech.cjs");
const id = n => `${n.toString(16).padStart(8,"0")}-abcd-4abc-8abc-abcdef123456`;
const serverId = "development:https://example.invalid", ref = n => ({ serverId, requestId: id(n) });
const accepted = (n = 1, conversationId = id(100)) => ({ requestId: id(n), conversationId, status: "accepted" });
const completed = (n = 1, kind = "outcome", conversationId = id(100)) => ({ ...accepted(n, conversationId), status: "completed", result: { kind } });
const constants = { SPEECH_MAX_BYTES: 8388608 };
const inspect = voiceSource("src/utils/speech-wav.ts", { "@/services/api/voice": constants }).inspectSpeechWav;
function fixture(setup = () => {}, dev = true) {
  const diagnostics = [], fs = speechFiles(), fileApi = voiceSource("src/services/speech-file.ts", { "expo-file-system": fs.fs, "expo-crypto": fs.crypto, __DEV__: dev,
    console: { info(prefix, event, detail) { if (fs.state.throwDiagnostic) throw Error("diagnostic"); diagnostics.push({ prefix, event, detail }); fs.state.onDiagnostic?.(event, detail); } } });
  const files = fileApi.createSpeechFileStore(), p = playbackFixture((deps) => { deps.validate = async source => { assert.ok(fs.entries.has(source.uri)); }; });
  const timers = new Map(); let now = 0, timerId = 0;
  const state = { scope: { serverId, generation: 1, allowed: true }, calls: [], checks: [], events: [], details: [], handler: async () => ({ ok: true, data: speechWav() }) };
  setup(state, p, fs);
  const api = voiceSource("src/services/assistant-speech.ts", { "@/services/api/voice": constants, __DEV__: dev });
  const dependencies = { scope: () => state.scope, files, playback: p.controller,
    http: { getSpeech(reference, options) { state.calls.push({ reference, options, at: now }); return state.handler(reference, options); } },
    check: async (...args) => { state.checks.push(args); }, observe: (event, detail) => { if (state.throwDiagnostic) throw Error("diagnostic"); state.events.push(event); state.details.push({ event, detail }); },
    setTimer(fn, ms) { const key = ++timerId; timers.set(key, { fn, at: now + ms }); return key; }, clearTimer(key) { timers.delete(key); } };
  const service = api.createAssistantSpeech(dependencies);
  service.focus(true);
  const start = (n = 1, voice = true, conversationId) => { service.begin(ref(n), 1, voice, conversationId); service.accept(ref(n), 1, accepted(n, conversationId)); };
  return { service, start, p, fs, files, fileApi, state, timers, api, dependencies, diagnostics,
    async advance(ms) { const target = now + ms; for (;;) { const at = Math.min(...[...timers.values()].map(t => t.at)); if (at > target) break;
      now = at; for (const [key,t] of [...timers]) if (t.at <= now) { timers.delete(key); t.fn(); } await settle(); } now = target; await settle(); },
    async close() { await service.dispose(); } };
}

for (const kind of ["need_more_info", "candidate_selection", "confirmation", "outcome", "failure", "uncertain"]) test(`TTS qualification: voice origin ${kind}, reserve once before await`, async () => {
  const f = fixture(); f.start(); const response = completed(1, kind);
  f.service.observe(ref(1), 1, response); f.service.observe(ref(1), 1, response); await settle();
  assert.equal(f.state.calls.length, 1); assert.equal(f.p.state.starts, 1); assert.equal(f.fs.entries.size, 1);
  assert.equal(f.p.controller.getSnapshot().phase, "playing");
  f.p.emit({ didJustFinish: true }); await settle(); assert.equal(f.fs.entries.size, 0);
  f.service.observe(ref(1), 1, completed()); await settle(); assert.equal(f.state.calls.length, 1); await f.close();
});
for (const source of ["voice", "text", "selection", "confirmation"]) test(`TTS qualification: voice-origin ${source} follow-up`, async () => {
  const f = fixture(); f.start(); f.service.focus(false); f.service.focus(true);
  f.start(2, source === "voice", id(100)); f.service.observe(ref(2), 1, completed(2)); await settle();
  assert.equal(f.state.calls.length, 1); await f.close();
});
test("TTS text origin cannot be promoted by a voice follow-up", async () => {
  const f = fixture(); f.start(1, false); f.service.observe(ref(1), 1, completed()); await settle();
  f.start(2, true, id(100)); f.service.observe(ref(2), 1, completed(2)); await settle();
  assert.equal(f.state.calls.length, 0); await f.close();
});
test("TTS new text root cannot inherit an earlier voice conversation merely from a response ID", async () => {
  const f = fixture(); f.start(); f.service.begin(ref(2), 1, false);
  f.service.observe(ref(2), 1, completed(2)); await settle();
  assert.equal(f.state.calls.length, 0); await f.close();
});
test("TTS runtime reservation spans two service instances for the same request", async () => {
  const f = fixture(), other = f.api.createAssistantSpeech(f.dependencies); other.focus(true);
  f.start(); other.begin(ref(1), 1, true); other.accept(ref(1), 1, accepted());
  f.service.observe(ref(1), 1, completed()); other.observe(ref(1), 1, completed()); await settle();
  assert.equal(f.state.calls.length, 1); await other.dispose(); await f.close();
});
for (const exit of ["blur", "inactive", "background", "server", "generation", "restart", "mock", "new-input"]) test(`TTS qualification: ${exit} invalidates old request permanently`, async () => {
  const f = fixture(); f.start();
  if (exit === "blur") { f.service.focus(false); f.service.focus(true); }
  else if (["inactive", "background"].includes(exit)) { f.service.appState(exit); f.service.appState("active"); }
  else if (["server", "generation", "restart"].includes(exit)) { f.service.reset(); }
  else if (exit === "mock") f.state.scope.allowed = false;
  else await f.service.interrupt();
  f.service.observe(ref(1), 1, completed()); await settle(); assert.equal(f.state.calls.length, 0); await f.close();
});
for (const cause of ["not-sent", "rejected"]) test(`TTS temporary origin discarded on ${cause}`, async () => {
  const f = fixture(); f.service.begin(ref(1), 1, true); f.service.reject(ref(1), 1);
  f.service.observe(ref(1), 1, completed()); f.start(2, false, id(100)); f.service.observe(ref(2), 1, completed(2));
  await settle(); assert.equal(f.state.calls.length, 0); await f.close();
});
test("TTS replay/GET without transcript uses known origin, never reconstructs input", async () => {
  const f = fixture(); f.service.begin(ref(1), 1, true); f.service.observe(ref(1), 1, completed()); await settle();
  assert.equal(f.state.calls.length, 1); assert.deepEqual(f.state.calls[0].reference, ref(1)); await f.close();
});
for (const kind of ["network", "timeout", "response", "aborted", "TTS_UNAVAILABLE", "SPEECH_NOT_READY", "VOICE_BUSY"]) test(`TTS download ${kind} retry policy`, async () => {
  const f = fixture(state => { state.handler = async () => ({ ok: false, error: ["TTS_UNAVAILABLE", "SPEECH_NOT_READY", "VOICE_BUSY"].includes(kind) ?
    { kind: "http", problem: { status: kind === "TTS_UNAVAILABLE" ? 503 : 409, code: kind } } : { kind } }); });
  f.start(); f.service.observe(ref(1), 1, completed()); await settle();
  assert.equal(f.state.calls.length, 1); await f.advance(1999); assert.equal(f.state.calls.length, 1); await f.advance(1);
  assert.equal(f.state.calls.length, kind === "VOICE_BUSY" ? 2 : 1);
  assert.equal(f.state.checks.length, kind === "SPEECH_NOT_READY" ? 1 : 0);
  f.service.observe(ref(1), 1, completed()); await f.advance(10000); assert.ok(f.state.calls.length <= 2);
  assert.equal(f.p.state.starts, 0); assert.equal(f.fs.entries.size, 0); await f.close();
});
test("TTS VOICE_BUSY succeeds after exactly 2 seconds, independently of Assistant retry", async () => {
  const f = fixture(state => { let calls = 0; state.handler = async () => ++calls === 1 ? { ok: false, error: { kind: "http", problem: { status: 409, code: "VOICE_BUSY" } } } : { ok: true, data: speechWav() }; });
  f.start(); f.service.observe(ref(1), 1, completed()); await settle(); await f.advance(2000);
  assert.deepEqual(f.state.calls.map(c => c.at), [0, 2000]); assert.equal(f.p.state.starts, 1); await f.close();
});
for (const exit of ["interrupt", "blur", "background", "deadline", "reset"]) test(`TTS pending download ${exit}: late bytes never create a file/player`, async () => {
  const gate = deferred(), f = fixture(state => { state.handler = () => gate.promise; });
  f.start(); f.service.observe(ref(1), 1, completed()); await settle();
  if (exit === "deadline") { await f.advance(71999); assert.equal(f.state.calls[0].options.signal.aborted, false); await f.advance(1); }
  else if (exit === "interrupt") await f.service.interrupt(); else if (exit === "blur") f.service.focus(false);
  else if (exit === "background") f.service.appState("background"); else f.service.reset();
  await settle(); assert.equal(f.state.calls[0].options.signal.aborted, true);
  gate.resolve({ ok: true, data: speechWav() }); await settle(); assert.equal(f.fs.entries.size, 0); assert.equal(f.p.state.starts, 0); await f.close();
});
test("TTS old release callback cannot delete the next request file", async () => {
  const f = fixture(); f.start(); f.service.observe(ref(1), 1, completed()); await settle(); const oldUri = [...f.fs.entries.keys()][0];
  f.start(2, false, id(100)); f.service.observe(ref(2), 1, completed(2)); await settle();
  assert.equal(f.p.state.starts, 2); assert.equal(f.fs.entries.has(oldUri), false); const next = [...f.fs.entries.keys()][0];
  f.p.emit({ didJustFinish: true }, 0); await settle(); assert.equal(f.fs.entries.has(next), true); await f.close();
});
test("TTS next result waits for previous native cleanup, without blocking Assistant UI", async () => {
  const gate = deferred(), f = fixture(); f.start(); f.service.observe(ref(1), 1, completed()); await settle();
  const reset = f.p.deps.reset; f.p.deps.reset = async () => { await gate.promise; await reset(); };
  f.start(2, false, id(100)); f.service.observe(ref(2), 1, completed(2)); await settle(); assert.equal(f.p.state.starts, 1);
  gate.resolve(); await settle(); assert.equal(f.p.state.starts, 2); await f.close();
});
for (const failure of ["release", "reset"]) test(`TTS player ${failure} failure keeps file protected and session blocked`, async () => {
  const f = fixture((state,p) => { if (failure === "reset") p.deps.reset = async () => { throw Error("reset"); };
    else { const create = p.deps.create; p.deps.create = (...args) => ({ ...create(...args), release() { throw Error("release"); } }); } });
  f.start(); f.service.observe(ref(1), 1, completed()); await settle(); await f.service.interrupt(); f.files.sweep();
  assert.equal(f.fs.entries.size, 1); assert.equal(f.p.controller.getSnapshot().blocked, true); assert.ok(f.state.events.includes("cleanup-failed"));
  await assert.rejects(f.p.session.beginRecording(Symbol())); await f.close();
});
for (const noop of [false, true]) test(`TTS deletion failure/no-op ${noop} retains cleanup across stores`, async () => {
  const f = fixture(); f.start(); f.service.observe(ref(1), 1, completed()); await settle();
  f.fs.state.failDelete = !noop; f.fs.state.noopDelete = noop; f.p.emit({ didJustFinish: true }); await settle();
  assert.equal(f.fs.entries.size, 1); f.fs.state.failDelete = false; f.fs.state.noopDelete = false;
  f.fileApi.createSpeechFileStore().sweep(); assert.equal(f.fs.entries.size, 0); await f.close();
});
test("TTS sweep preserves active player, recorder, asset, nested path and arbitrary external files", async () => {
  const f = fixture(); f.start(); f.service.observe(ref(1), 1, completed()); await settle();
  for (const uri of ["file:///cache/ExpoAudio/assistant-voice.wav", "asset:///speech.wav", "file:///cache/AssistantSpeech/foreign.wav", `file:///cache/AssistantSpeech/nested/assistant-speech-${id(50)}.wav`]) f.fs.entries.set(uri, speechWav());
  const size = f.fs.entries.size; f.files.sweep(); assert.equal(f.fs.entries.size, size);
  await f.close(); assert.equal(f.fs.entries.size, size - 1);
});
test("TTS orphan cleanup only claims own namespace and failed partial write", async () => {
  const f = fixture(); const uri = `file:///cache/AssistantSpeech/assistant-speech-${id(70)}.wav`; f.fs.entries.set(uri, speechWav());
  f.files.sweep(); assert.equal(f.fs.entries.size, 0); f.fs.state.failWrite = true;
  await assert.rejects(async () => f.files.create(speechWav())); assert.equal(f.fs.entries.size, 0); await f.close();
});
test("TTS native asynchronous file write stays owned until completion, sweep cannot delete it", async () => {
  const gate = deferred(), f = fixture(); f.fs.state.writeGate = gate.promise;
  const writing = Promise.resolve().then(() => f.files.create(speechWav()));
  // Observe rejection immediately; a failed production implementation must not leak a test rejection.
  const result = writing.then(file => ({ file }), error => ({ error }));
  await settle(); f.files.sweep(); assert.equal(f.fs.entries.size, 1);
  gate.resolve(); const value = await result; assert.equal(value.error, undefined);
  assert.equal(value.file.release(true), true); assert.equal(f.fs.entries.size, 0); await f.close();
});
test("TTS invalidation during asynchronous write cleans the late file without creating a player", async () => {
  const gate = deferred(), f = fixture(); f.fs.state.writeGate = gate.promise;
  f.start(); f.service.observe(ref(1), 1, completed()); await settle();
  await f.service.interrupt(); assert.equal(f.fs.entries.size, 1);
  gate.resolve(); await settle(); assert.equal(f.fs.entries.size, 0); assert.equal(f.p.state.starts, 0); await f.close();
});

for (const options of [{}, { rate: 44100, channels: 2 }, { rate: 48000, bits: 24 }, { frames: 600000 }, { ancillary: 3 }, { extensible: true }]) test(`TTS output WAV supports actual header ${JSON.stringify(options)}`, () => {
  const wav = speechWav(options), info = inspect(wav); assert.equal(info.size, wav.length); assert.equal(info.sampleRate, options.rate ?? 22050);
});
for (const [label, edit] of [
  ["RIFF", b => b[0] = 0], ["WAVE", b => b[8] = 0], ["declared size", b => b[4]++], ["chunk overflow", b => new DataView(b.buffer).setUint32(16, 0xffffffff, true)],
  ["format", b => b[20] = 3], ["rate", b => new DataView(b.buffer).setUint32(24, 0, true)], ["channels", b => b[22] = 0],
  ["bits", b => b[34] = 7], ["byteRate", b => b[28]++], ["blockAlign", b => b[32]++], ["empty data", b => new DataView(b.buffer).setUint32(40, 0, true)],
  ["frame", b => { b[40]--; b[b.length-1] = 0; }],
]) test(`TTS invalid WAV ${label} fails before file/native creation`, async () => {
  const b = speechWav(); edit(b); assert.throws(() => inspect(b));
  const f = fixture(state => { state.handler = async () => ({ ok: true, data: b }); });
  f.start(); f.service.observe(ref(1), 1, completed()); await settle(); assert.equal(f.fs.entries.size, 0); assert.equal(f.p.state.starts, 0); await f.close();
});
for (const offset of [36, 38, 44, 59]) test(`TTS EXTENSIBLE extension corruption ${offset}`, () => { const b = speechWav({ extensible: true }); b[offset]++; assert.throws(() => inspect(b)); });
for (const bytes of [new Uint8Array(), speechWav().slice(0, 43), speechWav().slice(0, -1), new Uint8Array(8388609)]) test(`TTS truncated/oversized output ${bytes.length}`, () => assert.throws(() => inspect(bytes)));
test("TTS exactly 8 MiB valid PCM output accepted", () => { const b = speechWav({ frames: (8388608 - 44) / 2 }); assert.equal(b.length, 8388608); assert.equal(inspect(b).size, 8388608); });

for (const chunk of ["fmt ", "data"]) test(`TTS duplicate ${chunk} chunk rejected`, () => {
  const base = speechWav(), extra = chunk === "fmt " ? base.slice(12, 36) : base.slice(36), b = new Uint8Array(base.length + extra.length);
  b.set(base); b.set(extra, base.length); new DataView(b.buffer).setUint32(4, b.length - 8, true); assert.throws(() => inspect(b));
});
test("TTS ancillary chunk missing odd padding rejected without boundary exception", () => {
  const b = speechWav({ ancillary: 3 }).slice(0, 47); new DataView(b.buffer).setUint32(4, b.length - 8, true); assert.throws(() => inspect(b));
});
test("TTS safe deletion is idempotent and cannot delete a newly claimed same path", async () => {
  const f = fixture(); f.fs.state.uuid = id(500); const old = await f.files.create(speechWav());
  assert.equal(old.release(true), true); const next = await f.files.create(speechWav()); next.handoff();
  assert.equal(old.release(true), true); f.files.sweep(); assert.equal(f.fs.entries.size, 1);
  assert.equal(next.release(true), true); assert.equal(f.fs.entries.size, 0); await f.close();
});
test("TTS completed download stays protected before playback handoff", async () => {
  const f = fixture(), file = await f.files.create(speechWav());
  f.fileApi.createSpeechFileStore().sweep(); assert.equal(f.fs.entries.has(file.uri), true);
  file.handoff(); assert.equal(file.release(true), true); await f.close();
});
test("TTS pending write failure preserves cleanup responsibility until safe retry", async () => {
  const f = fixture(); f.fs.state.failWrite = true; f.fs.state.failDelete = true;
  await assert.rejects(f.files.create(speechWav())); assert.equal(f.fs.entries.size, 1);
  f.fs.state.failDelete = false; f.fileApi.createSpeechFileStore().sweep(); assert.equal(f.fs.entries.size, 0); await f.close();
});
test("TTS stale acceptance cannot change a pinned conversation or cross generation", async () => {
  const f = fixture(); f.service.begin(ref(1), 1, true, id(300));
  f.service.observe(ref(1), 1, completed()); await settle(); assert.equal(f.state.calls.length, 0);
  f.service.begin(ref(2), 1, true); f.state.scope.generation = 2;
  f.service.observe(ref(2), 1, completed(2)); await settle(); assert.equal(f.state.calls.length, 0); await f.close();
});
for (const mismatch of ["request", "conversation"]) test(`TTS already accepted entry cannot qualify a mismatched ${mismatch} result`, async () => {
  const f = fixture(); f.start(1);
  if (mismatch === "request") f.service.observe(ref(1), 1, completed(2));
  else { f.service.begin(ref(2), 1, true); f.service.accept(ref(2), 1, accepted(2, id(200))); f.service.observe(ref(2), 1, completed(2, "outcome", id(100))); }
  await settle(); assert.equal(f.state.calls.length, 0); await f.close();
});
test("TTS rejected response does not require transcript as origin evidence", async () => {
  const f = fixture(); f.service.begin(ref(1), 1, true); f.service.accept(ref(1), 1, accepted()); f.service.reject(ref(1), 1);
  f.service.observe(ref(1), 1, completed()); await settle(); assert.equal(f.state.calls.length, 1); await f.close();
});
test("TTS busy wait cancellation prevents delayed retry", async () => {
  const f = fixture(state => { state.handler = async () => ({ ok: false, error: { kind: "http", problem: { status: 409, code: "VOICE_BUSY" } } }); });
  f.start(); f.service.observe(ref(1), 1, completed()); await settle(); await f.advance(1999); await f.service.interrupt(); await f.advance(10000);
  assert.equal(f.state.calls.length, 1); assert.equal(f.timers.size, 0); await f.close();
});
test("TTS listening is not stopped by the 72 second download deadline", async () => {
  const f = fixture(); f.start(); f.service.observe(ref(1), 1, completed()); await settle(); await f.advance(80000);
  assert.equal(f.fs.entries.size, 1); assert.equal(f.p.state.starts, 1); assert.equal(f.p.controller.getSnapshot().phase, "playing"); await f.close();
});

test("review02 WAV diagnostics use inspected metadata, play request is not actual playing", async () => {
  const wav = speechWav({ rate: 44100, channels: 2, frames: 400, ancillary: 3 });
  const f = fixture((state, p) => { state.handler = async () => ({ ok: true, data: wav }); p.state.delayPlaying = true; });
  f.start(); f.service.observe(ref(1), 1, completed()); await settle();
  const metadata = inspect(wav), { size, sampleRate, channels, bitDepth, durationMillis } = metadata;
  assert.deepEqual(f.state.details.find(d => d.event === "wav-validated").detail, { size, sampleRate, channels, bitDepth, durationMillis });
  assert.deepEqual(f.state.details.find(d => d.event === "download-complete").detail, { bytes: wav.length });
  assert.ok(f.state.events.indexOf("download-complete") < f.state.events.indexOf("play-requested"));
  assert.equal(f.state.events.includes("playing"), false); assert.equal(f.p.state.events.some(e => e.phase === "playing"), false);
  f.p.emit({ playing: true, isLoaded: true }); assert.equal(f.p.state.events.at(-1).phase, "playing");
  f.p.emit({ didJustFinish: true }); await settle(); assert.equal(f.p.state.events.at(-1).phase, "completed");
  const written = f.diagnostics.find(d => d.event === "file-written"), deleted = f.diagnostics.find(d => d.event === "file-deleted");
  assert.deepEqual(written.detail, { owner: written.detail.owner, size: wav.length, expectedSize: wav.length, sizeMatches: true });
  assert.deepEqual(deleted.detail, { owner: written.detail.owner, existedBeforeDelete: true, existsAfterDelete: false });
  assert.doesNotMatch(JSON.stringify([f.diagnostics, f.state.details]), /file:|example\.invalid|abcdef|transcript|RIFF/);
  await f.close();
});

test("review02 safe native cleanup precedes owner deletion; interruption does not claim completion", async () => {
  const f = fixture(), timeline = [];
  f.p.deps.observe = phase => timeline.push(phase); f.fs.state.onDiagnostic = event => timeline.push(event);
  f.start(); f.service.observe(ref(1), 1, completed()); await settle(); await f.service.interrupt();
  assert.ok(f.state.events.includes("interrupted")); assert.equal(timeline.includes("completed"), false);
  assert.ok(timeline.indexOf("idle") < timeline.indexOf("file-deleted")); assert.ok(timeline.includes("idle"));
  assert.deepEqual(f.p.state.operations.slice(-3), ["pause", "reset", "release"]); await f.close();
});

for (const noop of [false, true]) test(`review02 failed/noop deletion diagnostics ${noop} retain exact owner for retry`, async () => {
  const f = fixture(), file = await f.files.create(speechWav());
  f.fs.state.failDelete = !noop; f.fs.state.noopDelete = noop;
  assert.equal(file.release(true), false); assert.equal(f.diagnostics.some(d => d.event === "file-deleted"), false);
  const failed = f.diagnostics.find(d => d.event === "file-delete-failed"); assert.equal(failed.detail.existedBeforeDelete, true);
  if (noop) assert.equal(failed.detail.existsAfterDelete, true);
  f.fs.state.failDelete = false; f.fs.state.noopDelete = false; f.files.sweep();
  const deleted = f.diagnostics.find(d => d.event === "file-deleted"); assert.equal(deleted.detail.owner, failed.detail.owner);
  assert.equal(deleted.detail.existsAfterDelete, false); await f.close();
});

test("review02 unsafe player cleanup never logs a successful file deletion", async () => {
  const f = fixture((state, p) => { p.deps.reset = async () => { throw Error("reset"); }; });
  f.start(); f.service.observe(ref(1), 1, completed()); await settle(); await f.service.interrupt();
  assert.equal(f.diagnostics.some(d => d.event === "file-deleted"), false); assert.equal(f.fs.entries.size, 1);
  assert.equal(f.p.controller.getSnapshot().issue, "cleanup"); assert.equal(f.p.controller.getSnapshot().blocked, true); await f.close();
});

for (const dev of [true, false]) test(`review02 diagnostic errors and production DEV=${dev} cannot change playback/cleanup`, async () => {
  const f = fixture((state, p, fs) => { state.throwDiagnostic = true; fs.state.throwDiagnostic = true; }, dev);
  f.start(); f.service.observe(ref(1), 1, completed()); await settle(); assert.equal(f.p.state.starts, 1);
  f.p.emit({ didJustFinish: true }); await settle(); assert.equal(f.fs.entries.size, 0); assert.equal(f.diagnostics.length, 0); await f.close();
});
test("review02 production emits no service or file diagnostics", async () => {
  const f = fixture(() => {}, false); f.start(); f.service.observe(ref(1), 1, completed()); await settle();
  f.p.emit({ didJustFinish: true }); await settle(); assert.equal(f.state.events.length, 0); assert.equal(f.diagnostics.length, 0); await f.close();
});
test("review02 no-op native write logs size mismatch, never success", async () => {
  const f = fixture(); f.fs.state.noopWrite = true;
  await assert.rejects(f.files.create(speechWav()));
  assert.equal(f.diagnostics.some(d => d.event === "file-written"), false);
  const failed = f.diagnostics.find(d => d.event === "file-write-failed");
  assert.equal(failed.detail.sizeMatches, false); assert.equal(failed.detail.size, 0);
  assert.equal(failed.detail.expectedSize, speechWav().length); assert.equal(f.fs.entries.size, 0); await f.close();
});

test("review01 provisional admission predicate preserves dispatch-backed GET and exact entry rejection", async () => {
  const f = fixture(); let sent = false;
  f.service.begin(ref(1), 1, true, undefined, () => sent);
  f.service.observe(ref(1), 1, completed()); await settle(); assert.equal(f.state.calls.length, 0);
  sent = true; f.service.observe(ref(1), 1, completed()); await settle(); assert.equal(f.state.calls.length, 1);
  const stale = f.service.begin(ref(2), 1, true); f.service.reject(ref(2), 1, stale);
  const current = f.service.begin(ref(2), 1, true); assert.ok(current); f.service.reject(ref(2), 1, stale);
  f.service.observe(ref(2), 1, completed(2)); await settle(); assert.equal(f.state.calls.length, 2); await f.close();
});
