/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { test } = require("node:test");
const { voiceSource, voiceFixture } = require("./helpers/local-voice.cjs");
const { playbackFixture, deferred, settle } = require("./helpers/local-playback.cjs");

test("로컬 재생: 초기화는 native·권한·파일·네트워크 작업 없음", () => {
  const f = playbackFixture(); assert.equal(f.state.creates, 0); assert.deepEqual(f.state.operations, []);
  assert.equal(f.controller.getSnapshot().phase, "idle"); assert.equal(f.controller.isBusy(), false);
});
test("로컬 재생: local source 시작→실제 playing→완료→session/player 정리", async () => {
  const f = playbackFixture(); await f.controller.play(f.source); assert.equal(f.controller.getSnapshot().phase, "playing");
  f.emit({ didJustFinish: true, playing: false }); await f.settle();
  assert.equal(f.controller.getSnapshot().phase, "completed"); assert.equal(f.controller.isBusy(), false);
  assert.deepEqual(f.state.operations.slice(-3), ["pause", "reset", "release"]);
  assert.equal(f.state.releases, 1); assert.equal(f.state.files.size, 1);
});
test("로컬 재생: play 호출만으로 성공 표시하지 않고 native 시작까지 loading", async () => {
  const f = playbackFixture((deps, state) => { state.delayPlaying = true; state.loaded = false; });
  await f.controller.play(f.source); assert.equal(f.controller.getSnapshot().phase, "loading");
  f.emit({ isLoaded: true, playing: false }); assert.equal(f.controller.getSnapshot().phase, "loading");
  f.emit({ isLoaded: true, playing: true }); assert.equal(f.controller.getSnapshot().phase, "playing");
  await f.controller.stop();
});
test("로컬 재생: 완료 후 새 player로 처음부터 반복·연타는 중복 생성 없음", async () => {
  const f = playbackFixture(); await Promise.all([f.controller.play(f.source), f.controller.play(f.source), f.controller.play(f.source)]);
  assert.equal(f.state.creates, 1); f.emit({ didJustFinish: true }); await f.settle();
  await f.controller.play(f.source); assert.equal(f.state.creates, 2); assert.equal(f.state.starts, 2);
  await Promise.all([f.controller.stop(), f.controller.stop()]); assert.equal(f.state.releases, 2);
});
for (const stage of ["validate", "activate", "configure"]) test(`로컬 재생: ${stage} 대기 중 중단·지연 준비 무효화`, async () => {
  const gate = deferred(), f = playbackFixture(deps => { const original = deps[stage]; deps[stage] = async (...args) => { await gate.promise; return original(...args); }; });
  const play = f.controller.play(f.source); await f.settle(); const stop = f.controller.stop();
  gate.resolve(); await play; await stop;
  assert.equal(f.state.creates, 0); assert.equal(f.controller.getSnapshot().phase, "idle"); assert.equal(f.controller.isBusy(), false);
});
for (const stage of ["validate", "activate", "configure", "create"]) test(`로컬 재생: ${stage} 오류는 결과 변경 없이 정리·다음 재생 가능`, async () => {
  const f = playbackFixture(deps => { deps[stage] = () => { throw Error("native/private/path"); }; });
  await f.controller.play(f.source); await f.settle(); assert.equal(f.controller.getSnapshot().phase, "error");
  assert.equal(f.controller.isBusy(), false); assert.equal(f.state.files.size, 1);
  assert.ok(!JSON.stringify(f.state.events).includes("private/path"));
});
test("로컬 재생: 파일 누락은 native 생성 전에 오류", async () => {
  const f = playbackFixture(); await f.controller.play({ ...f.source, uri: "file:///missing.wav" }); await f.settle();
  assert.equal(f.controller.getSnapshot().issue, "source"); assert.equal(f.state.creates, 0); assert.equal(f.controller.isBusy(), false);
});
test("로컬 재생: native 오류·늦은 완료 callback은 새 재생 상태를 바꾸지 않음", async () => {
  const f = playbackFixture(); await f.controller.play(f.source); f.emit({ failed: true }); await f.settle();
  assert.equal(f.controller.getSnapshot().issue, "native"); await f.controller.play(f.source);
  f.emit({ didJustFinish: true, failed: true }, 0); assert.equal(f.controller.getSnapshot().phase, "playing");
  await f.controller.stop(); assert.equal(f.state.releases, 2);
});
for (const exit of ["blur", "tab", "settings", "background", "inactive", "unmount"]) test(`로컬 재생: ${exit} 중단·복귀 자동 재개 없음`, async () => {
  const f = playbackFixture(); await f.controller.play(f.source);
  if (["background", "inactive"].includes(exit)) f.controller.appState(exit); else f.controller.focus(false);
  await f.settle(); f.controller.focus(true); f.controller.appState("active"); f.emit({ playing: true });
  assert.equal(f.controller.getSnapshot().phase, "idle"); assert.equal(f.state.starts, 1); assert.equal(f.state.releases, 1);
});
for (const failure of ["pause", "release", "reset"]) test(`로컬 재생: ${failure} 정리 실패는 중첩 오디오 시작을 fail-closed`, async () => {
  const f = playbackFixture(deps => {
    if (failure === "reset") deps.reset = async () => { throw Error("reset"); };
    else { const create = deps.create; deps.create = (...args) => ({ ...create(...args), [failure]() { throw Error(failure); } }); }
  });
  await f.controller.play(f.source); const safe = await f.controller.stop();
  // pause 실패도 session 비활성화와 player 해제가 모두 성공하면 안전하게 종료할 수 있다.
  if (failure === "pause") { assert.equal(safe, true); assert.equal(f.controller.isBusy(), false); }
  else {
    assert.equal(safe, false); assert.equal(f.controller.getSnapshot().blocked, true); assert.equal(f.controller.isBusy(), true);
    await f.controller.play(f.source); assert.equal(f.state.creates, 1);
    await assert.rejects(f.session.beginRecording(Symbol("blocked"))); assert.equal(f.state.starts, 1);
  }
});

function combinedFixture(setupPlayback = () => {}, setupRecording = () => {}) {
  const session = voiceSource("src/services/local-audio-session.ts").createLocalAudioSession();
  const p = playbackFixture(setupPlayback, session), owner = Symbol("record-session"); let reservation;
  const r = voiceFixture((deps, state) => {
    deps.beforeStart = () => { const next = Symbol("record-job"), pending = session.beginRecording(next); reservation = next; return pending; };
    deps.afterEnd = safe => { if (reservation) session.endRecording(reservation, safe); reservation = null; };
    deps.activate = () => session.activate(owner, async () => { state.activations++; });
    deps.reset = () => session.reset(owner, async () => { state.resets++; });
    setupRecording(deps, state);
  });
  return { p, r, session };
}
test("녹음/재생: 재생 정리 완료 이후에만 권한 확인·녹음 시작", async () => {
  const gate = deferred(), { p, r } = combinedFixture(deps => { const reset = deps.reset; deps.reset = async () => { await gate.promise; await reset(); }; });
  await p.controller.play(p.source); const start = r.controller.start(); await settle();
  assert.equal(r.state.permissionReads, 0); assert.equal(r.state.starts, 0); assert.equal(p.controller.getSnapshot().phase, "stopping");
  await p.controller.play(p.source); assert.equal(p.state.creates, 1);
  gate.resolve(); await start; assert.equal(p.state.releases, 1); assert.equal(r.state.starts, 1);
  p.emit({ playing: true, didJustFinish: true }, 0); assert.equal(r.controller.getSnapshot().input.phase, "recording");
  await r.controller.cancel(); assert.equal(r.state.files.size, 0);
});
for (const stage of ["permission", "prepare", "recording", "stop"]) test(`녹음/재생: ${stage} 동안 새 player 생성 금지`, async () => {
  const gate = deferred(), { p, r } = combinedFixture(() => {}, deps => {
    if (stage === "permission") deps.permission = () => gate.promise;
    if (stage === "prepare" || stage === "stop") { const create = deps.create; deps.create = (...args) => {
      const recorder = create(...args); return { ...recorder, [stage === "prepare" ? "prepare" : "stop"]: async () => { await gate.promise; await recorder[stage === "prepare" ? "prepare" : "stop"](); } };
    }; }
  });
  const start = r.controller.start(); await settle(); let stop;
  if (stage === "stop") stop = r.controller.stop();
  await p.controller.play(p.source); assert.equal(p.state.creates, 0);
  gate.resolve({ granted: true, canAskAgain: true }); await start; if (stop) await stop;
  await r.controller.cancel(); await p.controller.play(p.source); assert.equal(p.state.creates, 1); await p.controller.stop();
});
test("녹음/재생: 이전 player 정리 실패면 권한·새 녹음 시작 금지", async () => {
  const { p, r } = combinedFixture(deps => { deps.reset = async () => { throw Error("session"); }; });
  await p.controller.play(p.source); await r.controller.start();
  assert.equal(r.state.permissionReads, 0); assert.equal(r.state.starts, 0); assert.equal(p.controller.getSnapshot().blocked, true);
  await r.controller.start(); assert.equal(r.state.starts, 0);
});
test("녹음/재생: recorder 해제 실패 후 재생 시작 금지·녹음 UI 잠금 해제만으로 안전 판정 안 함", async () => {
  const { p, r } = combinedFixture(() => {}, deps => { const create = deps.create; deps.create = (...args) => ({ ...create(...args), release() { throw Error("release"); } }); });
  await r.controller.start(); await r.controller.stop(); assert.equal(r.controller.getSnapshot().issue, "cleanup");
  await p.controller.play(p.source); assert.equal(p.state.creates, 0);
  await r.controller.start(); await p.controller.play(p.source); assert.equal(p.state.creates, 0);
});
test("오디오 소유권: 이전 owner의 늦은 reset이 새 세션을 변경하지 않음", async () => {
  const session = voiceSource("src/services/local-audio-session.ts").createLocalAudioSession(), a = Symbol(), b = Symbol();
  let late = 0; await session.activate(a, async () => {}); await session.reset(a, async () => {});
  await session.activate(b, async () => {}); await session.reset(a, async () => { late++; });
  assert.equal(late, 0); await assert.rejects(session.activate(a, async () => {}));
});
test("재생 WAV fixture: 실제 RIFF/PCM 헤더·stereo 44.1kHz·6초·1MiB 초과, 녹음 제한과 독립", () => {
  const b = fs.readFileSync(path.join(__dirname, "fixtures/audio/playback-stereo-pcm.wav"));
  assert.equal(b.toString("ascii", 0, 4), "RIFF"); assert.equal(b.readUInt32LE(4), b.length - 8);
  assert.equal(b.toString("ascii", 8, 12), "WAVE"); assert.equal(b.readUInt16LE(20), 1); assert.equal(b.readUInt16LE(22), 2);
  assert.equal(b.readUInt32LE(24), 44100); assert.equal(b.readUInt16LE(34), 16);
  assert.equal(b.readUInt32LE(40) / b.readUInt32LE(28), 6); assert.equal(b.length, 1058444); assert.ok(b.length > 1048576);
  assert.ok(b.some((value, index) => index >= 44 && value !== 0));
});

function nativePlaybackFixture(setup = () => {}) {
  const session = voiceSource("src/services/local-audio-session.ts").createLocalAudioSession();
  const state = { operations: [], players: [], options: [], deletes: 0, active: false, keeper: false, delayedDeactivations: 0,
    files: new Map([["file:///cache/test.wav", 1058444]]), logs: [] };
  setup(state);
  class File {
    constructor(uri) { this.uri = uri; }
    get exists() { if (state.accessFails) throw Error("private/path"); return state.files.has(this.uri); }
    get size() { return state.files.get(this.uri) ?? 0; }
    delete() { state.deletes++; throw Error("borrowed file must not be deleted"); }
  }
  const api = voiceSource("src/services/expo-audio-playback.ts", {
    "@/services/local-audio-session": { localAudioSession: session },
    "react-native": { AppState: { currentState: "active" } }, "expo-file-system": { File },
    "expo-audio": {
      async setIsAudioActiveAsync(active) {
        state.operations.push(active ? "active" : "inactive");
        if (!active && state.resetFails) throw Error("reset");
        state.active = active; if (!active) state.keeper = false;
      },
      async setAudioModeAsync(mode) { state.operations.push(mode); },
      createAudioPlayer(source, options) {
        state.options.push(options); state.operations.push("create");
        if (state.createFails) throw Error("create");
        const p = { id: `player-${state.players.length}`, playing: false, loop: true, source,
          currentStatus: { id: `player-${state.players.length}`, playing: false, isLoaded: false, didJustFinish: false, error: null, playbackState: "idle" },
          listeners: new Set(), lastListener: null,
          addListener(event, listener) { assert.equal(event, "playbackStatusUpdate"); if (state.subscribeFails) throw Error("subscribe");
            p.listeners.add(listener); p.lastListener = listener; return { remove() { state.operations.push("unsubscribe"); p.listeners.delete(listener); if (state.unsubscribeFails) throw Error("unsubscribe"); } }; },
          play() { state.operations.push("play"); state.keeper = true; if (state.playFails) throw Error("play"); },
          pause() { state.operations.push("pause"); p.playing = false; },
          replace(source) { assert.equal(source, null); state.operations.push("detach"); p.source = null; },
          remove() { state.operations.push("remove"); if (state.keeper) state.delayedDeactivations++; if (state.removeFails) throw Error("remove"); },
          release() { state.operations.push("release"); if (state.releaseFails) throw Error("release"); },
        };
        state.players.push(p); return p;
      },
    },
    console: { info(...args) { state.logs.push(args); } },
  });
  const deps = api.createExpoPlaybackDependencies(() => true);
  const controller = voiceSource("src/services/local-audio-playback.ts").createLocalAudioPlayback(deps);
  controller.focus(true);
  return { state, session, deps, controller, source: { kind: "file", uri: "file:///cache/test.wav", format: "wav" },
    emit(partial) {
      const p = state.players.at(-1); p.playing = partial.playing ?? p.playing;
      p.currentStatus = { ...p.currentStatus, ...partial };
      for (const listener of [...p.listeners]) listener(p.currentStatus);
    } };
}
test("재생 native adapter: 실제 player API·외부 재생/백그라운드/loop 비활성·local file은 1MiB 초과 허용", async () => {
  const f = nativePlaybackFixture(); await f.controller.play(f.source);
  assert.equal(f.controller.getSnapshot().phase, "loading"); assert.deepEqual(f.state.players[0].source, { uri: f.source.uri });
  assert.deepEqual(f.state.options[0], { updateInterval: 100, downloadFirst: false, keepAudioSessionActive: true, allowsExternalPlayback: false });
  assert.equal(f.state.players[0].loop, false);
  const mode = f.state.operations.find(value => typeof value === "object");
  assert.equal(mode.allowsRecording, false); assert.equal(mode.shouldPlayInBackground, false); assert.equal(mode.allowsBackgroundRecording, false);
  f.emit({ isLoaded: true, playing: true }); assert.equal(f.controller.getSnapshot().phase, "playing");
  await f.controller.stop(); assert.equal(f.state.deletes, 0);
});
test("재생 native adapter: 상태 playing이어도 native playing=false이면 실제 시작으로 보지 않음", async () => {
  const f = nativePlaybackFixture(), player = f.deps.create(f.source, () => {}); player.play();
  f.state.players[0].currentStatus.playing = true; f.state.players[0].currentStatus.isLoaded = true;
  assert.equal(player.status().playing, false); player.pause(); player.release();
});
test("재생 native adapter: 완료는 keep-active 일시정지→세션 비활성화→remove/release, 늦은 자동 비활성화 없음", async () => {
  const f = nativePlaybackFixture(); await f.controller.play(f.source); f.emit({ isLoaded: true, playing: true });
  f.emit({ didJustFinish: true, playing: false }); await settle();
  assert.equal(f.controller.getSnapshot().phase, "completed"); assert.equal(f.state.players[0].listeners.size, 0);
  const ops = f.state.operations; assert.ok(ops.indexOf("pause") < ops.indexOf("inactive"));
  assert.ok(ops.indexOf("inactive") < ops.indexOf("remove")); assert.ok(ops.indexOf("remove") < ops.indexOf("release"));
  assert.ok(ops.indexOf("detach") < ops.indexOf("inactive")); assert.equal(f.state.players[0].source, null);
  assert.equal(f.state.delayedDeactivations, 0); assert.equal(f.state.active, false); assert.equal(f.state.deletes, 0);
});
test("재생 native adapter: numeric bundle asset은 전달하고 파일 삭제·마이크 권한·샘플 규격 강제 없음", async () => {
  const f = nativePlaybackFixture(); await f.controller.play({ kind: "asset", asset: 42 });
  assert.equal(f.state.players[0].source, 42); await f.controller.stop(); assert.equal(f.state.deletes, 0);
});
for (const source of [
  { kind: "asset", asset: 0 }, { kind: "asset", asset: NaN },
  { kind: "file", uri: "https://example.invalid/speech.wav", format: "wav" },
  { kind: "file", uri: "file:///cache/missing.wav", format: "wav" },
  { kind: "file", uri: "file:///cache/test.wav", format: "unsupported" },
]) test(`재생 native adapter: 잘못된 source ${JSON.stringify(source)}는 player 생성 전 거절`, async () => {
  const f = nativePlaybackFixture(); await f.controller.play(source); await settle();
  assert.equal(f.controller.getSnapshot().issue, "source"); assert.equal(f.state.players.length, 0); assert.equal(f.state.deletes, 0);
});
for (const failure of ["accessFails", "emptyFile"]) test(`재생 native adapter: ${failure}은 파일 오류·주소 로그 없음`, async () => {
  const f = nativePlaybackFixture(state => { if (failure === "emptyFile") state.files.set("file:///cache/test.wav", 0); else state.accessFails = true; });
  await f.controller.play(f.source); await settle(); assert.equal(f.controller.getSnapshot().issue, "source");
  assert.equal(f.state.players.length, 0); assert.ok(!JSON.stringify(f.state.logs).includes("file:///"));
});
for (const failure of ["createFails", "subscribeFails", "playFails"]) test(`재생 native adapter: ${failure} native 시작 오류에도 해제 및 재진입 잠금 복구`, async () => {
  const f = nativePlaybackFixture(state => { state[failure] = true; }); await f.controller.play(f.source); await settle();
  assert.equal(f.controller.getSnapshot().phase, "error"); assert.equal(f.controller.getSnapshot().blocked, false);
  assert.equal(f.controller.isBusy(), false); if (failure !== "createFails") assert.ok(f.state.operations.includes("release"));
});
for (const failure of ["resetFails", "removeFails", "releaseFails", "unsubscribeFails"]) test(`재생 native adapter: ${failure} 정리는 가능한 모든 단계 시도·다음 녹음 차단`, async () => {
  const f = nativePlaybackFixture(); await f.controller.play(f.source); f.state[failure] = true;
  assert.equal(await f.controller.stop(), false); assert.equal(f.controller.getSnapshot().blocked, true);
  assert.ok(f.state.operations.includes("remove")); assert.ok(f.state.operations.includes("release"));
  await assert.rejects(f.session.beginRecording(Symbol("new-record"))); assert.equal(f.state.deletes, 0);
});
test("재생 native adapter: native error와 다른 player 이벤트 구분·완료 뒤 callback 무효화", async () => {
  const f = nativePlaybackFixture(); await f.controller.play(f.source); const p = f.state.players[0];
  p.lastListener({ ...p.currentStatus, id: "other", error: "failed" }); assert.equal(f.controller.getSnapshot().phase, "loading");
  f.emit({ error: "private path audio decode error" }); await settle(); assert.equal(f.controller.getSnapshot().issue, "native");
  await f.controller.play(f.source); p.lastListener({ ...p.currentStatus, didJustFinish: true });
  assert.equal(f.controller.getSnapshot().phase, "loading"); assert.ok(!JSON.stringify(f.state.logs).includes("private path"));
  await f.controller.stop();
});

test("로컬 재생: StrictMode 해제/재생성과 같은 이전 준비 정리 중 새 작업 차단·지연 callback 격리", async () => {
  const session = voiceSource("src/services/local-audio-session.ts").createLocalAudioSession(), gate = deferred();
  const old = playbackFixture(deps => { const configure = deps.configure; deps.configure = async () => { await gate.promise; await configure(); }; }, session);
  const start = old.controller.play(old.source); await settle(); old.controller.focus(false);
  const next = playbackFixture(() => {}, session); await next.controller.play(next.source); assert.equal(next.state.creates, 0);
  gate.resolve(); await start; await settle(); assert.equal(old.state.creates, 0);
  await next.controller.play(next.source); assert.equal(next.state.creates, 1); assert.equal(next.controller.getSnapshot().phase, "playing");
  old.controller.appState("active"); old.controller.focus(true); assert.equal(old.state.starts, 0); await next.controller.stop();
});
for (const exit of ["blur", "background", "unmount"]) test(`로컬 재생: ${exit} 중 지연 configure 완료가 player를 만들거나 자동 재개하지 않음`, async () => {
  const gate = deferred(), f = playbackFixture(deps => { deps.configure = () => gate.promise; });
  const play = f.controller.play(f.source); await f.settle();
  if (exit === "background") f.controller.appState("background"); else f.controller.focus(false);
  gate.resolve(); await play; await f.settle(); f.controller.focus(true); f.controller.appState("active");
  assert.equal(f.state.creates, 0); assert.equal(f.controller.isBusy(), false); assert.equal(f.controller.getSnapshot().phase, "idle");
});
test("로컬 재생: native pause/buffering은 재생 요청을 재실행하지 않고 loading 표시", async () => {
  const f = playbackFixture(); await f.controller.play(f.source); f.emit({ playing: false });
  assert.equal(f.controller.getSnapshot().phase, "loading"); assert.equal(f.state.starts, 1);
  await f.controller.stop();
});
