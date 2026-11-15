const assert = require("node:assert/strict");
const { test } = require("node:test");
const { harness, jsonStep, trace } = require("./helpers/system-api.cjs");

for (const [value, normalized] of [
  ["192.0.2.10", "192.0.2.10"], [" 192.0.2.10 \n", "192.0.2.10"], ["0.0.0.0", "0.0.0.0"],
  ["255.255.255.255", "255.255.255.255"], ["100.100.10.20", "100.100.10.20"], ["8.8.8.8", "8.8.8.8"],
]) test(`IPv4 허용·정규화·정확한 URL: ${JSON.stringify(value)}`, () => {
  const h = harness(), target = h.config.createPiCandidate(value);
  assert.equal(h.config.parseCanonicalIpv4(value), normalized);
  assert.equal(target.baseUrl, `http://${normalized}:8000`);
  assert.equal(target.apiBaseUrl, `http://${normalized}:8000/api/v1`);
  assert.equal(target.serverId, `pi:http://${normalized}:8000`);
  assert.ok(Object.isFrozen(target)); assert.equal(h.liveCalls, 0);
});
for (const value of ["", " ", "192.0.2.256", "256.0.0.1", "192.168.001.100", "00.0.0.0", "192.168.1", "127.1",
  "0xc0.0.2.1", "3221225985", "192.0.2.10:8000", "http://192.0.2.10", "https://192.0.2.10", "192.0.2.10/",
  "192.0.2.10?x=1", "192.0.2.10#x", "user@192.0.2.10", "orangepi.local", "::1", "[::1]", "192.0. 2.1", "1.2.3.-1",
  "1.2.3.+1", "1.2.3.4\n5", "１.2.3.4", null, 123, undefined]) test(`IPv4 거절·후보 생성 없음: ${JSON.stringify(value)}`, () => {
  const h = harness(); assert.equal(h.config.parseCanonicalIpv4(value), null); assert.equal(h.config.createPiCandidate(value), null);
  assert.equal(h.liveCalls, 0);
});

for (const [value, expected] of [[undefined, "development"], ["development", "development"], ["pi", "pi"],
  ["", "invalid"], ["other", "invalid"], ["PI", "invalid"]]) test(`연결 출처 해석: ${String(value)}`, () => {
  assert.equal(harness().config.parseServerTargetSource(value), expected);
});

test("기존 development 식별값·정규화와 Pi·Mock namespace를 혼용하지 않음", () => {
  const { config: c } = harness();
  const dev = c.createDevelopmentTarget("http://192.0.2.10:8000/");
  const pi = c.createPiCandidate("192.0.2.10");
  const mockDev = c.createDevelopmentTarget(dev.baseUrl, "mock"), mockPi = c.createPiCandidate("192.0.2.10", "mock");
  assert.equal(dev.serverId, c.parseDevelopmentServerConfig(dev.baseUrl).config.serverId);
  assert.equal(new Set([dev, pi, mockDev, mockPi].map(value => value.serverId)).size, 4);
  assert.equal(mockPi.serverId, `mock:pi:${pi.baseUrl}`);
  assert.deepEqual(pi, c.createPiCandidate("192.0.2.10"));
  assert.notEqual(pi.serverId, c.createPiCandidate("192.0.2.11").serverId);
  for (const value of [dev, pi, mockDev, mockPi]) assert.ok(c.isServerTarget(value));
  for (const value of [{ ...pi, serverId: dev.serverId }, { ...pi, apiBaseUrl: `${pi.baseUrl}/else` },
    { ...pi, baseUrl: `${pi.baseUrl}/` }, { ...mockPi, transport: "http" }, null, {}, { ...pi, transport: "other" }]) assert.equal(c.isServerTarget(value), false);
});

test("snapshot은 후보·저장값으로 Pi 권한을 만들지 않고 불변 scope를 표현", () => {
  const { config: c } = harness();
  for (const transport of ["http", "mock"]) {
    const candidate = c.createPiCandidate("192.0.2.10", transport);
    const snapshot = c.createConnectionSnapshot({ mode: "server", source: "pi", generation: 1, target: candidate });
    const roles = { input: "192.0.2.11", candidate, saved: candidate, active: snapshot };
    assert.equal(roles.active.active, false); assert.equal(snapshot.businessAccess, "blocked");
    assert.equal(snapshot.environment, transport === "mock" ? "verification" : "pi");
    assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.target));
  }
  const dev = c.createDevelopmentTarget("https://example.invalid");
  assert.equal(c.createConnectionSnapshot({ mode: "server", source: "development", generation: 0, target: dev }).active, true);
  assert.equal(c.createConnectionSnapshot({ mode: "mock", source: "development", generation: 0, target: dev }).active, false);
  assert.equal(c.createConnectionSnapshot({ mode: "server", source: "pi", generation: 0, target: dev }).environment, "invalid");
  for (const generation of [-1, NaN, Infinity, 1.5]) assert.throws(() => c.createConnectionSnapshot({ mode: "server", source: "pi", generation }));
});

test("공통 generation은 기존 mode 보호를 유지하고 권한 재설정으로 A→B→A를 구분", () => {
  const h = harness({ EXPO_PUBLIC_SCHEDULE_DATA_MODE: "mock" }), c = h.config;
  const m = h.load("src/stores/scheduleDataModeStore.ts"), store = m.scheduleDataModeStore;
  assert.equal(m.getConnectionSnapshot().environment, "mock");
  store.getState().setMode("mock"); assert.equal(store.getState().generation, 0);
  store.getState().setMode("server"); assert.equal(store.getState().generation, 1); assert.equal(m.isMockScheduleMode(0), false);
  const snapshot = ip => c.createConnectionSnapshot({ mode: "server", source: "pi", generation: store.getState().generation,
    target: c.createPiCandidate(ip) });
  const a1 = snapshot("192.0.2.10"); store.getState().resetConnectionAuthority();
  const b2 = snapshot("192.0.2.11"); store.getState().resetConnectionAuthority(); const a3 = snapshot("192.0.2.10");
  assert.equal(a1.target.serverId, a3.target.serverId); assert.notEqual(a1.target.serverId, b2.target.serverId);
  assert.deepEqual([a1.generation, b2.generation, a3.generation], [1, 2, 3]);
  assert.equal(store.getState().mode, "server"); assert.equal(h.liveCalls, 0);
});

for (const source of ["pi", "invalid"]) test(`새 대상 ${source} 선택 시 개발 URL·저장 IP로 업무 fallback·복구 저장 없음`, async () => {
  const h = harness({ EXPO_PUBLIC_SERVER_TARGET: source, EXPO_PUBLIC_DEV_SERVER_BASE_URL: "https://example.invalid" });
  h.data.set("settings.savedPiIp", "192.0.2.10");
  const m = h.load("src/stores/scheduleDataModeStore.ts"); assert.equal(m.getConnectionSnapshot().active, false);
  const schedules = h.load("src/services/api/http.ts").scheduleHttpClient;
  const assistant = h.load("src/services/api/assistant.ts").assistantHttpClient;
  assert.equal(schedules.getServerId(), null); assert.equal(assistant.getServerId(), null);
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) assert.equal((await schedules.request({ method, path: method === "POST" ? "/schedules" : "/schedules/test" })).ok, false);
  const id = "11111111-1111-4111-8111-111111111111", serverId = "development:https://example.invalid";
  assert.equal((await assistant.postAssistantRequest({ requestId: id, input: { type: "text", text: "fixture" } }, { expectedServerId: serverId })).ok, false);
  assert.equal((await assistant.getAssistantRequest({ serverId, requestId: id })).ok, false);
  assert.equal((await assistant.cancelAssistantConversation(id, { target: { type: "request", id } }, { expectedServerId: serverId, signal: new AbortController().signal })).ok, false);
  assert.deepEqual(h.storageCalls, []); assert.equal(h.liveCalls, 0); assert.equal(h.data.size, 1);
});

test("기존 개발 서버 client는 주입 Mock transport로 기존 DTO·URL 처리 유지", async () => {
  const h = harness({ EXPO_PUBLIC_DEV_SERVER_BASE_URL: "https://example.invalid" });
  const transport = h.mock.createMockTransport([{ method: "GET", url: "https://example.invalid/api/v1/schedules", steps: [jsonStep({ items: [] })] }]);
  const client = h.load("src/services/api/http.ts").createScheduleHttpClient({ fetchImpl: transport.fetchImpl });
  const result = await client.request({ path: "/schedules" });
  assert.equal(result.ok, true); assert.equal(result.serverId, "development:https://example.invalid");
  assert.equal(result.requestId, trace); assert.equal(transport.getRequests().length, 1); assert.equal(h.liveCalls, 0);
  const validator = h.load("src/utils/assistant-recovery.ts");
  assert.ok(validator.isAssistantRecoveryServerId(result.serverId));
  assert.equal(validator.isAssistantRecoveryServerId(h.config.createPiCandidate("192.0.2.10").serverId), false);
});

test("동일 Mock fetch는 기존 Assistant client·저장 장벽·GET·cancel 경로에도 주입 가능", async () => {
  const h = harness({ EXPO_PUBLIC_DEV_SERVER_BASE_URL: "https://example.invalid" });
  const id = "11111111-1111-4111-8111-111111111111", conversationId = "22222222-2222-4222-8222-222222222222";
  const serverId = "development:https://example.invalid", accepted = { requestId: id, conversationId, status: "accepted" };
  const transport = h.mock.createMockTransport([
    { method: "POST", url: "https://example.invalid/api/v1/assistant/requests", steps: [jsonStep(accepted, 202)] },
    { method: "GET", url: `https://example.invalid/api/v1/assistant/requests/${id}`, steps: [jsonStep(accepted)] },
    { method: "POST", url: `https://example.invalid/api/v1/assistant/conversations/${conversationId}/cancel`,
      steps: [jsonStep({ target: { type: "request", id }, targetState: "not_guaranteed", text: "fixture" })] },
  ]);
  const api = h.load("src/services/api/assistant.ts").createAssistantHttpClient({ fetchImpl: transport.fetchImpl });
  assert.equal((await api.postAssistantRequest({ requestId: id, input: { type: "text", text: "fixture" } }, { expectedServerId: serverId })).ok, true);
  assert.equal((await api.getAssistantRequest({ serverId, requestId: id })).ok, true);
  assert.equal((await api.cancelAssistantConversation(conversationId, { target: { type: "request", id } },
    { expectedServerId: serverId, signal: new AbortController().signal })).ok, true);
  assert.ok(h.data.has("assistant.requestRecovery.v1")); assert.equal(transport.getRequests().length, 3); assert.equal(h.liveCalls, 0);
});
