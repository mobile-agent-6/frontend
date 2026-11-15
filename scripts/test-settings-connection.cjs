const assert = require("node:assert/strict");
const { test } = require("node:test");
const { harness, settle, jsonStep, problemStep, sync } = require("./helpers/system-api.cjs");
const A = "192.0.2.10", B = "192.0.2.20";
function fixture({ offset = 0, healthSteps, syncSteps, adapter, business = false } = {}) {
  const h = harness({ EXPO_PUBLIC_SCHEDULE_DATA_MODE: "server", EXPO_PUBLIC_SERVER_TARGET: "pi" });
  const target = h.config.createPiCandidate(A, "mock"), base = h.clockState.wall;
  const healthy = () => jsonStep({ status: "ok", apiVersion: "v1", serverTime: new Date(base + offset).toISOString() });
  const transport = h.mock.createMockTransport([
    { method: "GET", url: `${target.baseUrl}/health`, steps: healthSteps ?? Array.from({ length: 8 }, healthy) },
    { method: "POST", url: `${target.baseUrl}/api/v1/system/time-sync`, steps: syncSteps ?? [jsonStep(sync), jsonStep(sync)] },
  ], h.timers);
  const storageModule = h.load("src/services/storage/verified-settings.ts");
  const storage = adapter ? storageModule.createVerifiedSettingsStorage("mock:test", adapter) : storageModule.createVerifiedSettingsStorage("mock:test");
  const activations = [];
  const connection = h.load("src/services/settings-connection.ts").createSettingsConnection({ transport, storage, clock: h.clock,
    business: () => business, activate: (...args) => activations.push(args), legacy: async () => null });
  connection.input(A);
  const state = () => connection.store.getState();
  const approve = async () => { connection.openConsent(); await connection.confirmConsent(connection.consentToken()); };
  return { h, connection, state, approve, transport, storage, storageModule, activations, healthy };
}
for (const offset of [0, 59999, 60000, 60001, -59999, -60000, -60001]) {
  test(`RTT boundary ${offset}: Health alone never saves or activates`, async () => {
    const f = fixture({ offset, business: true }); await f.connection.check();
    assert.equal(f.state().timing.differenceMs, Math.abs(offset));
    assert.equal(f.state().timing.within, Math.abs(offset) <= 60000);
    assert.equal(f.state().phase, "consent"); assert.equal(f.activations.length, 0);
    await f.connection.save(); assert.equal(await f.storage.read(), null);
    f.connection.openConsent(); assert.equal(f.state().modal, Math.abs(offset) <= 60000);
    assert.equal(f.transport.getRequests().filter(x => x.method === "POST").length, 0);
    assert.equal(f.h.liveCalls, 0);
  });
}
test("midpoint uses monotonic elapsed, fractional boundary and latest successful retry", () => {
  const h = harness(), midpoint = h.load("src/services/settings-connection.ts").healthMidpoint;
  const start = Date.parse("2026-11-15T01:00:00Z");
  const result = (server, end) => ({ ok: true, data: { serverTime: server }, timings: [
    { wallStartedAt: 0, monotonicStartedAt: 0, monotonicReceivedAt: null },
    { wallStartedAt: start, monotonicStartedAt: 100, monotonicReceivedAt: end }] });
  assert.equal(midpoint(result("2026-11-15T01:01:01Z", 2100)).differenceMs, 60000);
  assert.equal(midpoint(result("2026-11-15T01:01:01.000001Z", 2100)).within, false);
  assert.equal(midpoint(result("2026-11-15T01:00:00Z", 99)), null);
  assert.equal(midpoint(result("2026-11-15T01:00:00Z", NaN)), null);
});
for (const adjusted of [true, false]) test(`consent latest clock, adjusted ${adjusted}, final Health then explicit durable save`, async () => {
  const f = fixture({ syncSteps: [jsonStep({ ...sync, adjusted })], business: true });
  await f.connection.check(); f.connection.openConsent(); const token = f.connection.consentToken();
  f.h.clockState.wall += 123;
  await f.connection.confirmConsent(token);
  assert.equal(f.state().phase, "ready"); assert.equal(f.state().adjusted, adjusted);
  assert.equal(f.activations.length, 0);
  const posts = f.transport.getRequests().filter(x => x.method === "POST");
  assert.equal(posts.length, 1); assert.equal(JSON.parse(posts[0].body).currentTime, new Date(f.h.clockState.wall).toISOString());
  assert.equal(posts[0].headers["idempotency-key"], undefined);
  await f.connection.save(); assert.equal(f.state().phase, "saved"); assert.equal(f.activations.length, 1);
  assert.equal((await f.storage.read()).ip, A); assert.equal(f.h.liveCalls, 0);
});
test("cancel and obsolete consent cannot POST, including A-B-A", async () => {
  const f = fixture(); await f.connection.check(); f.connection.openConsent(); const old = f.connection.consentToken();
  f.connection.dismissConsent(old); await f.connection.confirmConsent(old);
  f.connection.input(B); f.connection.input(A); await f.connection.check(); f.connection.openConsent();
  f.connection.dismissConsent(old); assert.equal(f.state().modal, true);
  await f.connection.confirmConsent(old); assert.equal(f.transport.getRequests().filter(x => x.method === "POST").length, 0);
});
test("late Health ignores abort without updating changed candidate; repeated check makes one request", async () => {
  const f = fixture({ healthSteps: [{ ...jsonStep({ status: "ok", apiVersion: "v1", serverTime: "2026-11-15T01:00:00Z" }), delayMs: 50, ignoreAbort: true }] });
  const first = f.connection.check(); await settle(); await f.connection.check();
  f.connection.input(B); f.connection.input(A); await f.h.advance(50); await first;
  assert.equal(f.state().phase, "idle"); assert.equal(f.state().timing, null); assert.equal(f.transport.getRequests().length, 1);
});
test("sync lost: automatic Health cannot certify success, new consent required, no POST retry", async () => {
  const f = fixture({ syncSteps: [{ kind: "pending" }, jsonStep(sync)] }); await f.connection.check();
  f.connection.openConsent(); const first = f.connection.confirmConsent(f.connection.consentToken());
  await f.h.advance(15000); await first;
  assert.equal(f.state().phase, "consent"); assert.ok(f.state().error); await f.connection.save();
  assert.equal(f.state().error, "시간 맞추기 결과를 확인하지 못했어요. 연결 상태를 다시 확인해 주세요.");
  assert.equal(await f.storage.read(), null);
  assert.equal(f.transport.getRequests().filter(x => x.method === "POST").length, 1);
  await f.approve(); assert.equal(f.state().phase, "ready"); assert.equal(f.transport.getRequests().filter(x => x.method === "POST").length, 2);
});
test("successful sync followed by invalid final Health retains evidence for Health-only retry", async () => {
  const good = jsonStep({ status: "ok", apiVersion: "v1", serverTime: "2026-11-15T01:00:00Z" });
  const f = fixture({ healthSteps: [good, jsonStep({ status: "bad" }), good] });
  await f.connection.check(); await f.approve(); assert.equal(f.state().phase, "error"); await f.connection.save();
  assert.equal(f.state().error, "시간을 맞춘 후 연결 상태를 확인하지 못했어요. 다시 연결 확인을 눌러 주세요.");
  assert.equal(await f.storage.read(), null); await f.connection.check(); assert.equal(f.state().phase, "ready");
  assert.equal(f.transport.getRequests().filter(x => x.method === "POST").length, 1);
});
test("sync Problem Details remains unsuccessful and cannot activate", async () => {
  const f = fixture({ syncSteps: [problemStep(503, "TIME_SYNC_UNAVAILABLE")], business: true });
  await f.connection.check(); await f.approve(); await f.connection.save();
  assert.equal(f.state().phase, "consent"); assert.equal(f.activations.length, 0);
  assert.equal(f.transport.getRequests().filter(x => x.method === "POST").length, 1);
});

for (const [status, code] of [[503, "TIME_SYNC_UNAVAILABLE"], [409, "CLOCK_AUTO_SYNC_ACTIVE"], [422, "CLOCK_TIME_OUT_OF_RANGE"]]) {
  test(`Settings 안내는 내부 오류 ${code}·HTTP ${status} 대신 사용자 행동을 표시`, async () => {
    const f = fixture({ syncSteps: [problemStep(status, code)], business: true });
    await f.connection.check(); await f.approve();
    const message = f.state().error;
    assert.equal(message, "Pi 시간을 맞추지 못했어요. 다시 시간 맞추기를 눌러 주세요.");
    assert.equal(message.includes(code), false); assert.equal(message.includes(String(status)), false);
    assert.doesNotMatch(message, /api\/v1|DTO|fixture|transport|Error:|stack/i);
    await f.connection.save(); assert.equal(await f.storage.read(), null); assert.equal(f.activations.length, 0);
    assert.equal(f.transport.getRequests().filter(r => r.method === "POST").length, 1);
    f.connection.openConsent(); assert.equal(f.state().modal, true); assert.equal(f.h.liveCalls, 0);
  });
}
test("storage schema namespaces, corrupt and interrupted values fail closed; legacy never activates", async () => {
  const f = fixture(), parse = f.storageModule.parseVerifiedSettings;
  const valid = { version: 1, ip: A, provenance: "pi", verified: true };
  assert.ok(parse(valid, "pi"));
  for (const value of [{ ...valid, version: 2 }, { ...valid, ip: null }, { ...valid, ip: "192.0.2.010" }, { ...valid, provenance: "mock:test" }, { ...valid, extra: true }]) assert.equal(parse(value, "pi"), null);
  const pi = f.storageModule.createVerifiedSettingsStorage("pi");
  await f.storage.save(A, () => true, () => {}); assert.equal(await pi.read(), null);
  f.h.data.set("settings.verifiedConnection.pi.v1", "invalid"); await assert.rejects(pi.read());
  f.h.data.set("settings.verifiedConnection.pi.v1", JSON.stringify(valid)); f.h.data.set("settings.verifiedConnection.pi.v1.pending", "pending"); await assert.rejects(pi.read());
  const c = f.h.load("src/services/settings-connection.ts").createSettingsConnection({ transport: f.transport, storage: f.storageModule.createVerifiedSettingsStorage("mock:legacy"), clock: f.h.clock, legacy: async () => B,
    business: () => true, activate: () => assert.fail("legacy activation") });
  await c.restore(); assert.equal(c.store.getState().input, B); assert.equal(c.store.getState().timing, null);
});
test("late durable write invalidation rolls back, serial next write wins, activation only current", async () => {
  const f = fixture(), data = new Map(); let release, paused = true, current = true;
  const gate = new Promise(resolve => { release = resolve; });
  const adapter = { getItem: async key => data.get(key) ?? null, removeItem: async key => { data.delete(key); },
    setItem: async (key, value) => { if (paused && !key.endsWith("pending")) { paused = false; await gate; } data.set(key, value); } };
  const storage = f.storageModule.createVerifiedSettingsStorage("pi", adapter), activated = [];
  const first = storage.save(A, () => current, () => activated.push(A)); await settle(); current = false;
  const next = storage.save(B, () => true, () => activated.push(B)); release();
  await assert.rejects(first); await next; assert.deepEqual(activated, [B]); assert.equal((await storage.read()).ip, B);
});
test("save failure preserves active connection and valid candidate can be retried", async () => {
  const adapter = { getItem: async () => null, setItem: async () => { throw Error("write"); }, removeItem: async () => {} };
  const f = fixture({ adapter, business: true }); await f.connection.check(); await f.approve();
  await f.connection.save(); assert.equal(f.state().phase, "ready"); assert.ok(f.state().error); assert.equal(f.activations.length, 0);
});
test("restore saved configuration Health-only, no implicit sync, failure blocks activation", async () => {
  for (const offset of [0, 60001]) {
    const f = fixture({ offset, business: true }); await f.storage.save(A, () => true, () => {});
    await f.connection.restore(); assert.equal(f.activations.length, offset === 0 ? 1 : 0);
    assert.equal(f.transport.getRequests().filter(x => x.method === "POST").length, 0);
    assert.equal(f.state().savedIp, A); assert.equal(f.h.liveCalls, 0);
  }
});
test("profile activation uses actual Schedule and Assistant clients with shared generation and no live fetch", async () => {
  const h = harness({ EXPO_PUBLIC_SERVER_TARGET: "pi", EXPO_PUBLIC_SCHEDULE_DATA_MODE: "server" });
  const profile = h.load("src/development/connection-profile.ts").createConnectionProfile("normal");
  const mode = h.load("src/stores/scheduleDataModeStore.ts"), schedule = h.load("src/services/api/schedules.ts");
  const assistant = h.load("src/services/api/assistant.ts").assistantHttpClient;
  const http = h.load("src/services/api/http.ts").scheduleHttpClient;
  const storage = h.load("src/services/storage/verified-settings.ts").createVerifiedSettingsStorage("mock:normal");
  const c = h.load("src/services/settings-connection.ts").createSettingsConnection({ ...profile, storage, legacy: async () => null });
  assert.equal(h.config.getDevelopmentServerConfig().status, "missing");
  assert.equal((await schedule.listSchedules({})).ok, false);
  for (const [ip, label] of [[A, "A"], [B, "B"], [A, "A"]]) {
    const previousScope = http.captureScope();
    c.input(ip); await c.check(); const previous = mode.getConnectionSnapshot(); c.openConsent(); await c.confirmConsent(c.consentToken());
    assert.equal(mode.getConnectionSnapshot().generation, previous.generation);
    await c.save(); assert.equal(c.store.getState().phase, "saved");
    const snapshot = mode.getConnectionSnapshot(); assert.equal(snapshot.active, true);
    if (previousScope) assert.equal((await http.request({ path: "/schedules", scope: previousScope })).ok, false);
    const list = await schedule.listSchedules({ from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }); assert.equal(list.ok, true, JSON.stringify(list)); assert.ok(list.data[0].title.startsWith(label));
    assert.equal(assistant.getServerId(), snapshot.target.serverId);
    const result = await assistant.getAssistantRequest({ serverId: snapshot.target.serverId, requestId: "33333333-3333-4333-8333-333333333333" }, { expectedGeneration: snapshot.generation });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.ok(result.data.result.text.startsWith(label));
  }
  const generation = mode.getConnectionSnapshot().generation;
  await c.check(); c.openConsent(); await c.confirmConsent(c.consentToken()); await c.save();
  assert.equal(mode.getConnectionSnapshot().generation, generation); assert.equal(h.liveCalls, 0);
  await assert.rejects(profile.transport.fetchImpl("http://192.0.2.10:8000/missing")); assert.equal(h.liveCalls, 0);
});

test("central authority reset invalidates Settings consent without duplicate generation", async () => {
  const f = fixture(); await f.connection.check(); f.connection.openConsent(); const token = f.connection.consentToken();
  const mode = f.h.load("src/stores/scheduleDataModeStore.ts").scheduleDataModeStore;
  const generation = mode.getState().generation; mode.getState().resetConnectionAuthority();
  await f.connection.confirmConsent(token); await f.connection.save();
  assert.equal(mode.getState().generation, generation + 1); assert.equal(f.state().modal, false);
  assert.equal(f.state().timing, null); assert.equal(f.transport.getRequests().filter(x => x.method === "POST").length, 0);
});
test("real HTTP policy accepts only a Health-checked Pi and explicit consent, using injected transport only", async () => {
  const h = harness(), target = h.config.createPiCandidate(A), calls = [];
  const transport = { kind: "http", fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); return new Response(JSON.stringify(options.method === "GET"
      ? { status: "ok", apiVersion: "v1", serverTime: new Date(h.clockState.wall).toISOString() } : sync), { status: 200,
      headers: { "Content-Type": "application/json", "X-Request-ID": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
  } };
  const api = h.system.createSystemApiService({ transport, clock: h.clock, timers: h.timers });
  assert.equal((await api.syncTimeAfterConsent(target, { currentTime: sync.serverTime }, { consent: "confirmed" })).ok, false);
  assert.equal((await api.checkHealth(target)).ok, true);
  assert.equal((await api.syncTimeAfterConsent(target, { currentTime: sync.serverTime }, { consent: "confirmed" })).ok, true);
  assert.equal((await api.syncTimeAfterConsent(target, { currentTime: sync.serverTime }, { consent: "confirmed" })).ok, false);
  assert.equal(calls.length, 2); assert.equal(h.liveCalls, 0);
});
test("production profile cannot initialize fixture or authorize business requests", async () => {
  const h = harness({ NODE_ENV: "production", EXPO_PUBLIC_SERVER_TARGET: "pi", EXPO_PUBLIC_CONNECTION_PROFILE: "normal" });
  const c = h.load("src/services/settings-runtime.ts").settingsConnection;
  c.input(A); const request = c.check(); await h.advance(1000); await request;
  assert.equal(c.store.getState().phase, "error");
  assert.equal(h.config.getDevelopmentServerConfig().status, "missing"); assert.equal(h.liveCalls, 0);
});

test("explicit Mock data plus Pi target never restores HTTP settings or activates business access", async () => {
  const h = harness({ EXPO_PUBLIC_SERVER_TARGET: "pi", EXPO_PUBLIC_SCHEDULE_DATA_MODE: "mock" });
  h.data.set("settings.verifiedConnection.pi.v1", JSON.stringify({ version: 1, verified: true, provenance: "pi", ip: A }));
  await h.load("src/services/connection-initialization.ts").initializeSavedConnection();
  assert.equal(h.storageCalls.length, 0); assert.equal(h.config.getDevelopmentServerConfig().status, "missing");
  const c = h.load("src/services/settings-runtime.ts").settingsConnection;
  c.input(A); await c.check(); c.openConsent(); await c.confirmConsent(c.consentToken()); await c.save();
  assert.equal(c.store.getState().phase, "saved"); assert.equal(h.config.getDevelopmentServerConfig().status, "missing");
  assert.equal(h.load("src/stores/scheduleDataModeStore.ts").scheduleDataModeStore.getState().mode, "mock");
  assert.equal(h.liveCalls, 0);
});
test("root initialization restores only saved Pi through mock transport, no automatic time-sync or development fallback", async () => {
  const h = harness({ EXPO_PUBLIC_SERVER_TARGET: "pi", EXPO_PUBLIC_SCHEDULE_DATA_MODE: "server", EXPO_PUBLIC_CONNECTION_PROFILE: "zero" });
  h.data.set("settings.verifiedConnection.mock:zero.v1", JSON.stringify({ version: 1, verified: true, provenance: "mock:zero", ip: A }));
  const initialize = h.load("src/services/connection-initialization.ts").initializeSavedConnection;
  await Promise.all([initialize(), initialize()]);
  const snapshot = h.load("src/stores/scheduleDataModeStore.ts").getConnectionSnapshot();
  assert.equal(snapshot.active, true); assert.equal(snapshot.target.serverId, `mock:pi:http://${A}:8000`);
  assert.equal(h.load("src/services/settings-runtime.ts").settingsConnection.store.getState().adjusted, null);
  assert.equal(h.liveCalls, 0);
});

test("actual active A survives B validation, delayed invalidated save and failed write", async () => {
  const h = harness({ EXPO_PUBLIC_SERVER_TARGET: "pi", EXPO_PUBLIC_SCHEDULE_DATA_MODE: "server" });
  const profile = h.load("src/development/connection-profile.ts").createConnectionProfile("zero");
  const data = new Map(); let release, wait = false, fail = false;
  const adapter = { getItem: async key => data.get(key) ?? null, removeItem: async key => { data.delete(key); },
    setItem: async (key, value) => {
      if (!key.endsWith("pending") && wait) { wait = false; await new Promise(resolve => { release = resolve; }); }
      if (fail && !key.endsWith("pending")) throw Error("fixture write failure"); data.set(key, value);
    } };
  const storage = h.load("src/services/storage/verified-settings.ts").createVerifiedSettingsStorage("mock:atomic", adapter);
  const c = h.load("src/services/settings-connection.ts").createSettingsConnection({ ...profile, storage, legacy: async () => null });
  const snapshot = h.load("src/stores/scheduleDataModeStore.ts").getConnectionSnapshot;
  const ready = async ip => { c.input(ip); await c.check(); c.openConsent(); await c.confirmConsent(c.consentToken()); };
  await ready(A); await c.save(); const original = snapshot();
  await ready(B); assert.equal(snapshot().generation, original.generation);
  wait = true; const pending = c.save(); await settle(); assert.equal(snapshot().target.serverId, original.target.serverId);
  c.input(A); release(); await pending;
  assert.equal(snapshot().generation, original.generation); assert.equal((await storage.read()).ip, A);
  await ready(B); fail = true; await c.save();
  assert.equal(snapshot().target.serverId, original.target.serverId); assert.ok(c.store.getState().error);
  // The failed adapter cannot certify rollback: the journal blocks future automatic restore.
  await assert.rejects(storage.read()); assert.equal(h.liveCalls, 0);
});

for (const corrupted of [false, true]) test(`편집 세션 초기화는 legacy 후보·손상 저장값을 실제 검증 설정으로 승격하지 않음: ${corrupted}`, async () => {
  const f = fixture();
  if (corrupted) f.h.data.set("settings.verifiedConnection.mock:entry.v1", "broken-json");
  const c = f.h.load("src/services/settings-connection.ts").createSettingsConnection({ transport: f.transport,
    storage: f.storageModule.createVerifiedSettingsStorage("mock:entry"), legacy: async () => B, clock: f.h.clock,
    activate: () => assert.fail("unverified activation") });
  await c.restore(); const end = c.beginEditing(); c.input("192.0.2.999"); c.cancel();
  assert.equal(c.store.getState().input, "192.0.2.999"); end(); const next = c.beginEditing();
  assert.equal(c.store.getState().input, corrupted ? "" : B); assert.equal(c.store.getState().savedIp, null);
  assert.equal(c.store.getState().timing, null); assert.equal(f.transport.getRequests().length, 0);
  next(); c.dispose(); assert.equal(f.h.liveCalls, 0);
});

for (const stage of ["write", "cleanup"]) test(`편집 이탈과 지연 ${stage}: journal 책임·저장 IP·활성 연결 일관성`, async () => {
  const h = harness({ EXPO_PUBLIC_SERVER_TARGET: "pi", EXPO_PUBLIC_SCHEDULE_DATA_MODE: "server" });
  const profile = h.load("src/development/connection-profile.ts").createConnectionProfile("normal");
  const data = new Map(); let enabled = false, reached = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const adapter = { getItem: async key => data.get(key) ?? null,
    setItem: async (key, value) => {
      if (enabled && stage === "write" && !key.endsWith("pending") && JSON.parse(value).ip === B) { reached = true; await gate; }
      data.set(key, value);
    }, removeItem: async key => { if (enabled && stage === "cleanup" && key.endsWith("pending")) { reached = true; await gate; } data.delete(key); } };
  const storage = h.load("src/services/storage/verified-settings.ts").createVerifiedSettingsStorage("mock:entry-race", adapter);
  await storage.save(A, () => true, () => {});
  const c = h.load("src/services/settings-connection.ts").createSettingsConnection({ ...profile, storage, legacy: async () => null });
  await c.restore(); const end = c.beginEditing(); c.input(B); await c.check(); c.openConsent(); await c.confirmConsent(c.consentToken());
  const mode = h.load("src/stores/scheduleDataModeStore.ts"), generation = mode.getConnectionSnapshot().generation;
  enabled = true; const saving = c.save(); await settle(); assert.equal(reached, true);
  end(); const endNext = c.beginEditing(); release(); await saving;
  const expected = stage === "write" ? A : B;
  assert.equal(c.store.getState().input, expected); assert.equal(c.store.getState().savedIp, expected);
  assert.equal((await storage.read()).ip, expected); assert.equal(data.has("settings.verifiedConnection.mock:entry-race.v1.pending"), false);
  assert.equal(mode.getConnectionSnapshot().target.baseUrl, `http://${expected}:8000`);
  assert.equal(mode.getConnectionSnapshot().generation, generation + (stage === "cleanup" ? 1 : 0));
  endNext(); c.dispose(); assert.equal(h.liveCalls, 0);
});

for (const profile of ["zero", "limit", "over", "health-error", "sync-error", "sync-lost", "final-health-error", "save-error", "not-adjusted", "switch-error"]) {
  test(`actual runtime review profile ${profile}: Settings policy and network isolation`, async () => {
    const h = harness({ EXPO_PUBLIC_SERVER_TARGET: "pi", EXPO_PUBLIC_SCHEDULE_DATA_MODE: "server", EXPO_PUBLIC_CONNECTION_PROFILE: profile });
    const c = h.load("src/services/settings-runtime.ts").settingsConnection;
    c.input(A); const checking = c.check(); await h.advance(1000); await checking;
    if (profile === "health-error") assert.equal(c.store.getState().phase, "error");
    else {
      c.openConsent();
      if (profile === "over") assert.equal(c.store.getState().modal, false);
      else {
        assert.equal(c.store.getState().modal, true);
        const approval = c.confirmConsent(c.consentToken()); await h.advance(15000); await approval;
        if (["sync-error", "sync-lost"].includes(profile)) assert.equal(c.store.getState().phase, "consent");
        else if (profile === "final-health-error") {
          assert.equal(c.store.getState().phase, "error"); await c.check(); assert.equal(c.store.getState().phase, "ready");
        } else {
          assert.equal(c.store.getState().phase, "ready");
          await c.save();
          assert.equal(c.store.getState().phase, profile === "save-error" ? "ready" : "saved");
          if (profile === "save-error") assert.ok(c.store.getState().error);
          if (profile === "switch-error") {
            c.input(B); const next = c.check(); await h.advance(1000); await next;
            assert.equal(c.store.getState().phase, "error");
            assert.equal(h.load("src/stores/scheduleDataModeStore.ts").getConnectionSnapshot().target.baseUrl, `http://${A}:8000`);
          }
        }
      }
    }
    assert.equal(h.liveCalls, 0);
  });
}
