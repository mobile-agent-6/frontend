const assert = require("node:assert/strict");
const { test } = require("node:test");
const { harness, settle, trace, health, sync, jsonStep, problemStep } = require("./helpers/system-api.cjs");
const consent = { consent: "confirmed" };
const currentTime = "2026-11-15T10:00:00.123456+09:00";
function setup(steps, path = "/health", method = "GET") {
  const h = harness(), target = h.config.createPiCandidate("192.0.2.10", "mock");
  const { api, transport } = h.service([{ method, url: `${target.baseUrl}${path}`, steps }]);
  return { h, api, transport, target };
}
const syncSetup = steps => setup(steps, "/api/v1/system/time-sync", "POST");

test("system import·factory·snapshot 생성에는 HTTP·storage·timer·자동 sync 없음", () => {
  const h = harness(); h.service([]); h.config.createPiCandidate("192.0.2.10");
  assert.equal(h.liveCalls, 0); assert.equal(h.pending.size, 0); assert.deepEqual(h.storageCalls, []);
});

test("Health 정상 DTO·소수초 보존·canonical path·추적 ID·독립 clock 측정", async () => {
  const f = setup([{ ...jsonStep(health), delayMs: 30 }]);
  const pending = f.api.checkHealth(f.target); await f.h.advance(30); const result = await pending;
  assert.equal(result.ok, true); assert.deepEqual(result.data, health); assert.equal(result.requestId, trace);
  assert.equal(result.serverId, f.target.serverId); assert.equal(result.attempts, 1);
  assert.deepEqual(result.timings, [{ attempt: 1, wallStartedAt: Date.parse("2026-11-15T01:00:00Z"), monotonicStartedAt: 100, monotonicReceivedAt: 130 }]);
  assert.ok(Object.isFrozen(result.timings)); assert.ok(Object.isFrozen(result.timings[0]));
  assert.equal(f.h.pending.size, 0); assert.equal(f.h.liveCalls, 0);
  const [call] = f.transport.getRequests(); assert.equal(call.url, `${f.target.baseUrl}/health`);
  assert.equal(call.method, "GET"); assert.equal(call.body, null); assert.equal(call.headers["content-type"], undefined);
});

const invalidHealth = [
  { ...health, status: "OK" }, { ...health, apiVersion: "v2" }, { ...health, status: 1 },
  { ...health, apiVersion: null }, { status: "ok", apiVersion: "v1" }, { serverTime: health.serverTime },
  { ...health, serverTime: null }, { ...health, serverTime: 0 }, { ...health, serverTime: "2026-02-30T00:00:00Z" },
  { ...health, serverTime: "2026-13-01T00:00:00Z" }, { ...health, serverTime: "2026-11-15T24:00:00Z" },
  { ...health, serverTime: "2026-11-15T00:00:60Z" }, { ...health, serverTime: "2026-11-15T00:00:00+09:00" },
  { ...health, serverTime: "2026-11-15T00:00:00" }, { ...health, serverTime: "2026-11-15T00:00:00.1234567Z" },
  { ...health, serverTime: "2026-11-15T00:00:00z" }, { ...health, serverTime: "0000-01-01T00:00:00Z" },
  { ...health, trusted: true }, null, [], "ok",
];
for (const [index, value] of invalidHealth.entries()) test(`Health 잘못된 runtime DTO ${index}: 실패·자동 retry 없음`, async () => {
  const f = setup([jsonStep(value), jsonStep(health)]), result = await f.api.checkHealth(f.target);
  assert.equal(result.ok, false); assert.equal(result.error.kind, "response"); assert.equal(result.attempts, 1);
  assert.equal(f.transport.getRequests().length, 1); assert.equal(f.h.pending.size, 0); assert.equal(f.h.liveCalls, 0);
});

for (const step of [
  { kind: "text", body: "not json", headers: { "X-Request-ID": trace } },
  { kind: "text", body: "{", headers: { "Content-Type": "application/json", "X-Request-ID": trace } },
  jsonStep(health, 201), jsonStep(health, 200, "application/problem+json"),
  { ...jsonStep(health), headers: { "Content-Type": "application/json" } },
]) test(`Health 비정상 HTTP·media·header ${JSON.stringify(step)}: retry 없음`, async () => {
  const f = setup([step]), result = await f.api.checkHealth(f.target);
  assert.equal(result.ok, false); assert.equal(result.error.kind, "response"); assert.equal(result.attempts, 1);
});

for (const [name, first] of [["network", { kind: "network-error" }], ["timeout", { kind: "pending" }],
  ["503", problemStep(503, "DATABASE_UNAVAILABLE")]]) test(`Health ${name}: 5초 제한·1초 대기·최대 1회 retry`, async () => {
  const f = setup([first, jsonStep(health)]), pending = f.api.checkHealth(f.target);
  await settle();
  if (name === "timeout") { await f.h.advance(4_999); assert.equal(f.transport.getRequests().length, 1); await f.h.advance(1); }
  assert.equal(f.transport.getRequests().length, 1);
  await f.h.advance(999); assert.equal(f.transport.getRequests().length, 1);
  await f.h.advance(1); const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.attempts, 2);
  assert.deepEqual(f.h.delays.filter(ms => [5_000, 1_000].includes(ms)), [5_000, 1_000, 5_000]);
  assert.equal(result.timings.length, 2); assert.equal(f.h.pending.size, 0); assert.equal(f.h.liveCalls, 0);
});

test("Health 두 번 timeout 이후 조회 종료·자동 반복 없음", async () => {
  const f = setup([{ kind: "pending" }, { kind: "pending" }, jsonStep(health)]), pending = f.api.checkHealth(f.target);
  await f.h.advance(11_000); const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.error.kind, "timeout"); assert.equal(result.attempts, 2);
  assert.equal(f.transport.getRequests().length, 2); assert.equal(f.h.pending.size, 0);
  assert.ok(result.timings.every(sample => sample.monotonicReceivedAt === null));
});

test("Health retry clock은 새 wall/monotonic 시작값을 사용하고 wall 변경으로 RTT를 만들지 않음", async () => {
  const f = setup([{ kind: "network-error" }, { ...jsonStep(health), delayMs: 20 }]);
  const pending = f.api.checkHealth(f.target); await settle();
  f.h.clockState.wall += 3_600_000; await f.h.advance(1_020); const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.timings[1].wallStartedAt - result.timings[0].wallStartedAt, 3_601_000);
  assert.equal(result.timings[1].monotonicReceivedAt - result.timings[1].monotonicStartedAt, 20);
});

for (const status of [400, 404, 409, 422, 500]) test(`Health HTTP ${status}: Problem code·status 보존·retry 없음`, async () => {
  const step = problemStep(status, "FIXTURE_ERROR"); if (status === 422) step.body.errors = null;
  const f = setup([step]), result = await f.api.checkHealth(f.target);
  assert.equal(result.ok, false); assert.equal(result.error.kind, "http"); assert.equal(result.error.status, status);
  assert.equal(result.error.problem.code, "FIXTURE_ERROR"); assert.equal(result.attempts, 1);
});
for (const changes of [{ status: 500 }, { requestId: "wrong" }, { code: null }]) test(`Health 손상 503 Problem ${JSON.stringify(changes)}는 retry 없음`, async () => {
  const step = problemStep(503, "DATABASE_UNAVAILABLE"); Object.assign(step.body, changes);
  const f = setup([step]), result = await f.api.checkHealth(f.target);
  assert.equal(result.error.kind, "response"); assert.equal(result.attempts, 1);
});

for (const phase of ["before", "during", "retry-wait"]) test(`Health 취소 ${phase}: timeout과 구분·retry 금지·timer 정리`, async () => {
  const f = setup([phase === "retry-wait" ? { kind: "network-error" } : { kind: "pending" }, jsonStep(health)]);
  const controller = new AbortController(); if (phase === "before") controller.abort();
  const pending = f.api.checkHealth(f.target, { signal: controller.signal }); await settle(); controller.abort();
  const result = await pending; assert.equal(result.ok, false); assert.equal(result.error.kind, "aborted");
  await f.h.advance(20_000); assert.equal(f.transport.getRequests().length, phase === "before" ? 0 : 1);
  assert.equal(f.h.pending.size, 0);
});

test("Health 무효화는 이전 대상 retry 금지, 후보 객체 변경은 원래 URL 고정", async () => {
  const f = setup([{ kind: "network-error" }, jsonStep(health)]), target = { ...f.target };
  const pending = f.api.checkHealth(target); await settle(); Object.assign(target, f.h.config.createPiCandidate("192.0.2.11", "mock"));
  await f.h.advance(1_000); assert.equal((await pending).ok, true);
  assert.ok(f.transport.getRequests().every(call => call.url === `${f.target.baseUrl}/health`));
  const g = setup([{ kind: "network-error" }, jsonStep(health)]); let current = true;
  const stopped = g.api.checkHealth(g.target, { isCurrent: () => current }); await settle(); current = false;
  await g.h.advance(1_000); assert.equal((await stopped).error.kind, "context-changed"); assert.equal(g.transport.getRequests().length, 1);
});

test("Health abort를 무시하는 늦은 성공도 timeout 결과·timing을 바꾸지 않음", async () => {
  const f = setup([{ ...jsonStep(health), delayMs: 8_000, ignoreAbort: true }, { kind: "network-error" }]);
  const pending = f.api.checkHealth(f.target); await f.h.advance(6_000); const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.attempts, 2); assert.equal(result.timings[0].monotonicReceivedAt, null);
  const before = JSON.stringify(result); await f.h.advance(2_000); assert.equal(JSON.stringify(result), before); assert.equal(f.h.pending.size, 0);
});

test("Health 응답 본문 대기도 timeout 대상이며 이미 받은 500은 재전송 없음", async () => {
  const h = harness(), target = h.config.createPiCandidate("192.0.2.10", "mock"); let sends = 0;
  const api = h.system.createSystemApiService({ timers: h.timers, clock: h.clock, transport: { kind: "mock", fetchImpl: async () => {
    sends++; return { status: 500, headers: new Headers({ "Content-Type": "application/problem+json", "X-Request-ID": trace }), text: () => new Promise(() => {}) };
  } } });
  const pending = api.checkHealth(target); await h.advance(5_000); const result = await pending;
  assert.equal(result.error.kind, "timeout"); assert.equal(result.error.status, 500); assert.equal(sends, 1);
});

for (const bad of [NaN, Infinity]) test(`Health 비유한 clock ${String(bad)}: 전송 금지`, async () => {
  const f = setup([jsonStep(health)]); f.h.clockState.wall = bad;
  const result = await f.api.checkHealth(f.target); assert.equal(result.error.kind, "clock"); assert.equal(f.transport.getRequests().length, 0);
});
test("Health monotonic 역행은 정상 측정으로 반환·retry하지 않음", async () => {
  const f = setup([{ ...jsonStep(health), delayMs: 20 }]), pending = f.api.checkHealth(f.target);
  await settle(); f.h.clockState.monotonic = -100; await f.h.advance(20);
  const result = await pending; assert.equal(result.error.kind, "clock"); assert.equal(result.attempts, 1);
});

for (const adjusted of [true, false]) test(`time-sync adjusted:${adjusted} 성공·정확한 DTO·key 없음·POST 1회`, async () => {
  const f = syncSetup([jsonStep({ ...sync, adjusted })]);
  const result = await f.api.syncTimeAfterConsent(f.target, { currentTime }, consent);
  assert.equal(result.ok, true); assert.equal(result.data.adjusted, adjusted); assert.equal(result.attempts, 1);
  const [call] = f.transport.getRequests(); assert.equal(call.method, "POST"); assert.equal(call.headers["content-type"], "application/json");
  assert.equal(call.headers["idempotency-key"], undefined); assert.deepEqual(JSON.parse(call.body), { currentTime });
  assert.deepEqual(f.h.delays, [15_000]); assert.equal(f.h.liveCalls, 0);
});

for (const value of [null, {}, { currentTime: 1 }, { currentTime: "2026-02-30T00:00:00Z" },
  { currentTime: "2026-11-15 00:00:00Z" }, { currentTime: "2026-11-15T00:00:00+0900" },
  { currentTime: "2026-11-15T00:00:00.1234567Z" }, { currentTime, extra: 1 }]) test(`time-sync 요청 검증 ${JSON.stringify(value)}`, async () => {
  const f = syncSetup([jsonStep(sync)]), result = await f.api.syncTimeAfterConsent(f.target, value, consent);
  assert.equal(result.error.kind, "request"); assert.equal(result.error.requestState, "not-sent"); assert.equal(f.transport.getRequests().length, 0);
});

for (const value of [null, {}, { ...sync, adjusted: "false" }, { adjusted: true, serverTime: sync.serverTime },
  { ...sync, previousServerTime: "2026-02-30T00:00:00Z" }, { ...sync, serverTime: "2026-11-15T00:00:00+09:00" },
  { ...sync, trusted: true }]) test(`time-sync 응답 검증 ${JSON.stringify(value)}: 실패·재전송 없음`, async () => {
  const f = syncSetup([jsonStep(value)]), result = await f.api.syncTimeAfterConsent(f.target, { currentTime }, consent);
  assert.equal(result.error.kind, "response"); assert.equal(result.attempts, 1); assert.equal(f.transport.getRequests().length, 1);
});

for (const [status, code] of [[422, "VALIDATION_ERROR"], [422, "CLOCK_TIME_OUT_OF_RANGE"],
  [409, "CLOCK_AUTO_SYNC_ACTIVE"], [503, "TIME_SYNC_UNAVAILABLE"]]) test(`time-sync ${code}: 계약 오류 보존·retry 없음`, async () => {
  const step = problemStep(status, code);
  if (code === "VALIDATION_ERROR") step.body.errors = [{ location: "body", pointer: "/currentTime", code: "INVALID_VALUE", detail: "fixture" }];
  const f = syncSetup([step]), result = await f.api.syncTimeAfterConsent(f.target, { currentTime }, consent);
  assert.equal(result.error.kind, "http"); assert.equal(result.error.problem.code, code);
  assert.equal(result.error.status, status); assert.equal(result.attempts, 1);
});

test("time-sync 유실: 15초 이전 대기·timeout 뒤 자동 POST/Health 없음", async () => {
  const f = syncSetup([{ kind: "pending" }, jsonStep(sync)]), pending = f.api.syncTimeAfterConsent(f.target, { currentTime }, consent);
  let done = false; pending.then(() => { done = true; });
  await f.h.advance(14_999); assert.equal(done, false); await f.h.advance(1); const result = await pending;
  assert.equal(result.error.kind, "timeout"); assert.equal(result.attempts, 1); assert.equal(f.h.pending.size, 0);
  await f.h.advance(20_000); assert.equal(f.transport.getRequests().length, 1);
});
test("time-sync network 오류도 자동 POST retry·Health 성공 추정 없음", async () => {
  const f = syncSetup([{ kind: "network-error" }]);
  const result = await f.api.syncTimeAfterConsent(f.target, { currentTime }, consent);
  assert.equal(result.error.kind, "network"); assert.equal(result.attempts, 1);
});

for (const options of [undefined, {}, { consent: false }, { consent: "cancelled" }]) test(`time-sync 명시적 동의 누락 ${JSON.stringify(options)}: 호출 금지`, async () => {
  const f = syncSetup([jsonStep(sync)]), result = await f.api.syncTimeAfterConsent(f.target, { currentTime }, options);
  assert.equal(result.error.kind, "policy"); assert.equal(f.transport.getRequests().length, 0);
});
test("개발 서버·live Pi time-sync는 명시적 동의가 있어도 1단계에서 차단", async () => {
  const h = harness(); const live = h.load("src/services/api/transport.ts").createHttpTransport();
  const api = h.system.createSystemApiService({ transport: live, timers: h.timers, clock: h.clock });
  for (const target of [h.config.createDevelopmentTarget("https://example.invalid"), h.config.createPiCandidate("192.0.2.10")]) {
    assert.equal((await api.syncTimeAfterConsent(target, { currentTime }, consent)).error.kind, "policy");
  }
  assert.equal(h.liveCalls, 0);
});
test("Mock 후보를 live transport로 보내거나 target 식별값을 바꾸는 우회 차단", async () => {
  const h = harness(), target = h.config.createPiCandidate("192.0.2.10", "mock");
  const api = h.system.createSystemApiService({ transport: h.load("src/services/api/transport.ts").createHttpTransport() });
  assert.equal((await api.checkHealth(target)).error.kind, "policy");
  const f = setup([jsonStep(health)]);
  assert.equal((await f.api.checkHealth({ ...f.target, serverId: "pi:other" })).error.kind, "policy");
  assert.equal(h.liveCalls, 0); assert.equal(f.transport.getRequests().length, 0);
});

test("가상 A/B 응답은 주소별 독립·fixture 원본 변경 및 누락에 live fallback 없음", async () => {
  const h = harness(), a = h.config.createPiCandidate("192.0.2.10", "mock"), b = h.config.createPiCandidate("192.0.2.11", "mock");
  const first = jsonStep(health), second = jsonStep({ ...health, serverTime: "2026-11-15T02:00:00Z" });
  const f = h.service([{ method: "GET", url: `${a.baseUrl}/health`, steps: [first] }, { method: "GET", url: `${b.baseUrl}/health`, steps: [second] }]);
  first.body = {}; assert.equal((await f.api.checkHealth(a)).data.serverTime, health.serverTime);
  assert.equal((await f.api.checkHealth(b)).data.serverTime, second.body.serverTime);
  await assert.rejects(f.transport.fetchImpl(`${a.baseUrl}/missing`), { code: "unregistered-route" });
  await assert.rejects(f.transport.fetchImpl(`${a.baseUrl}/health`), { code: "missing-fixture" });
  assert.equal(h.liveCalls, 0); assert.equal(f.transport.getRequests().length, 4);
});

test("Health 확인은 공통 연결 generation이나 저장소를 변경하지 않음", async () => {
  const f = setup([jsonStep(health)]), mode = f.h.load("src/stores/scheduleDataModeStore.ts").scheduleDataModeStore;
  const before = mode.getState().generation; await f.api.checkHealth(f.target);
  assert.equal(mode.getState().generation, before); assert.deepEqual(f.h.storageCalls, []);
});

test("주입 transport·요청 options 변경에도 원래 fetch와 취소 신호를 유지", async () => {
  const h = harness(), target = h.config.createPiCandidate("192.0.2.10", "mock");
  const mock = h.mock.createMockTransport([{ method: "GET", url: `${target.baseUrl}/health`, steps: [{ kind: "network-error" }, jsonStep(health)] }], h.timers);
  const injected = { kind: "mock", fetchImpl: mock.fetchImpl };
  const api = h.system.createSystemApiService({ transport: injected, timers: h.timers, clock: h.clock });
  const original = new AbortController(), options = { signal: original.signal };
  const pending = api.checkHealth(target, options); await settle();
  injected.kind = "http"; injected.fetchImpl = () => { throw Error("교체된 transport 사용 금지"); };
  options.signal = new AbortController().signal; original.abort();
  const result = await pending; assert.equal(result.error.kind, "aborted");
  assert.equal(mock.getRequests().length, 1); assert.equal(h.pending.size, 0); assert.equal(h.liveCalls, 0);
});

test("retry 직전 clock 오류는 이전 실제 시도·측정 기록을 잃지 않음", async () => {
  const f = setup([{ kind: "network-error" }, jsonStep(health)]), pending = f.api.checkHealth(f.target);
  await settle(); f.h.clockState.wall = NaN; await f.h.advance(1_000);
  const result = await pending; assert.equal(result.error.kind, "clock"); assert.equal(result.attempts, 1);
  assert.equal(result.timings.length, 1); assert.equal(f.transport.getRequests().length, 1);
});

test("Mock development 대상도 Pi 동의 동기화 입구에 사용할 수 없음", async () => {
  const h = harness(), f = h.service([]), target = h.config.createDevelopmentTarget("https://example.invalid", "mock");
  assert.equal((await f.api.syncTimeAfterConsent(target, { currentTime }, consent)).error.kind, "policy");
  assert.equal(f.transport.getRequests().length, 0); assert.equal(h.liveCalls, 0);
});

test("Mock transport의 204·소문자 Content-Type도 native Response 계약 준수", async () => {
  const h = harness(); const transport = h.mock.createMockTransport([
    { method: "DELETE", url: "https://example.invalid/api/v1/schedules/fixture", steps: [{ kind: "text", body: "", status: 204 }] },
    { method: "GET", url: "https://example.invalid/health", steps: [{ kind: "json", body: health, headers: { "content-type": "application/json" } }] },
  ]);
  const deleted = await transport.fetchImpl("https://example.invalid/api/v1/schedules/fixture", { method: "DELETE" });
  assert.equal(deleted.status, 204); assert.equal(await deleted.text(), "");
  const response = await transport.fetchImpl("https://example.invalid/health"); assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(h.liveCalls, 0);
});
