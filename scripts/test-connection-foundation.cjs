const assert = require("node:assert/strict");
const { test } = require("node:test");
const { harness, jsonStep, problemStep, trace } = require("./helpers/system-api.cjs");

function assistantIntegration(routes, withSchedule = false) {
  const h = harness({ EXPO_PUBLIC_SCHEDULE_DATA_MODE: "server" });
  const a = h.config.createDevelopmentTarget("https://a.example.invalid", "mock");
  const b = h.config.createDevelopmentTarget("https://b.example.invalid", "mock");
  let target = a;
  const transport = h.mock.createMockTransport(routes(a, b), h.timers);
  const storage = h.load("src/services/storage/assistant-recovery.ts").assistantRecoveryStorage;
  const apiModule = h.load("src/services/api/assistant.ts");
  const readConfig = () => ({ status: "ready", config: target });
  const api = apiModule.createAssistantHttpClient({ readConfig, recovery: storage, fetchImpl: transport.fetchImpl, now: h.clock.now });
  const requests = h.load("src/services/api/assistant-request-recovery.ts").createAssistantRequestRecovery({ http: api, recovery: storage, now: h.clock.now });
  const mode = h.load("src/stores/scheduleDataModeStore.ts").scheduleDataModeStore;
  let scheduleCache, sync;
  if (withSchedule) {
    const client = h.load("src/services/api/http.ts").createScheduleHttpClient({ readConfig, fetchImpl: transport.fetchImpl });
    const service = h.load("src/services/api/schedules.ts").createScheduleService(client);
    scheduleCache = h.load("src/stores/serverScheduleStore.ts").createServerScheduleStore({ readServerId: client.getServerId,
      list: service.listSchedules, get: service.getSchedule, prepareUpdate: service.prepareScheduleUpdate, prepareDeletion: service.prepareScheduleDeletion });
    sync = h.load("src/services/api/assistant-schedule-sync.ts").createAssistantScheduleSync({ cache: scheduleCache,
      mode, readServerId: api.getServerId, readSchedule: service.getSchedule });
  }
  const orchestrator = h.load("src/services/api/assistant-orchestrator.ts").createAssistantOrchestrator({ http: api, requests,
    storage, clock: h.clock, mode, scheduleSync: sync ?? { observe: async () => {} } });
  return { ...h, a, b, transport, storage, api, requests, mode, orchestrator, readConfig, scheduleCache, sync,
    change(next) { target = next; mode.getState().resetConnectionAuthority(); },
    assertNoNetwork() { assert.equal(h.liveCalls, 0); } };
}
const assistantId = "77777777-7777-4777-8777-777777777777";
const assistantAccepted = { requestId: assistantId, conversationId: "88888888-8888-4888-8888-888888888888", status: "accepted" };

test("2-D 실제 Assistant→Schedule→GET-only 복구: A/B 동일 ID·A/1 sync와 A/3 격리", async () => {
  const query = { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" };
  const params = harness().load("src/utils/schedule-query.ts").buildScheduleListQuery(query);
  const result = { ...assistantAccepted, status: "completed", result: { kind: "outcome", text: "updated", outcome: "success",
    operation: "update", schedulesChanged: true, affectedScheduleIds: [scheduleId] } };
  const h = assistantIntegration((a, b) => [a, b].flatMap((target, i) => [
    { method: "POST", url: `${target.apiBaseUrl}/assistant/requests`, steps: [jsonStep(assistantAccepted, 202)] },
    { method: "GET", url: `${target.apiBaseUrl}/assistant/requests/${assistantId}`, steps: [jsonStep(result), jsonStep(result)] },
    { method: "GET", url: `${target.apiBaseUrl}/schedules?${params}`, steps: [jsonStep({ items: [scheduleFixture(i ? "B" : "A")] }),
      ...(i ? [jsonStep({ items: [scheduleFixture("B changed")] })] : [{ ...jsonStep({ items: [scheduleFixture("A stale")] }), delayMs: 100, ignoreAbort: true },
        jsonStep({ items: [scheduleFixture("A fresh")] }), jsonStep({ items: [scheduleFixture("A recovered")] })])] },
    { method: "GET", url: `${target.apiBaseUrl}/schedules/${scheduleId}`, steps: [jsonStep(scheduleFixture(i ? "B detail" : "A detail")), jsonStep(scheduleFixture("recovered detail"))] },
  ]), true);
  await h.scheduleCache.acquire(query).promise;
  await h.orchestrator.startRequest({ requestId: assistantId, input: { type: "text", text: "update A" } }, { expectedServerId: h.a.serverId }).completion;
  await h.advance(0);
  const oldGeneration = h.mode.getState().generation;
  h.change(h.b); h.scheduleCache.syncServer(); await h.scheduleCache.acquire(query).promise;
  await h.orchestrator.startRequest({ requestId: assistantId, input: { type: "text", text: "update B" } }, { expectedServerId: h.b.serverId }).completion;
  await h.advance(0);
  h.change(h.a); h.scheduleCache.syncServer(); await h.scheduleCache.acquire(query).promise;
  const count = h.transport.getRequests().length;
  assert.equal(await h.sync.observe({ serverId: h.a.serverId, requestId: assistantId }, result, { generation: oldGeneration }), null);
  assert.equal(await h.sync.retry({ serverId: h.a.serverId, requestId: assistantId }, { generation: oldGeneration }), null);
  assert.equal(h.transport.getRequests().length, count);
  const restored = await h.orchestrator.initializeRecovery(); await restored.requests[0].task.completion;
  await h.advance(100);
  assert.equal(h.scheduleCache.store.getState().servers[h.a.serverId].entities[scheduleId].title, "A recovered");
  assert.equal(h.scheduleCache.store.getState().servers[h.b.serverId].entities[scheduleId].title, "B changed");
  assert.equal(h.transport.getRequests().filter(request => request.method === "POST").length, 2);
  assert.ok(h.transport.getRequests().every(request => !["PATCH", "DELETE"].includes(request.method)));
  assert.ok(h.sync.getSnapshot().every(entry => entry.generation === h.mode.getState().generation));
  h.assertNoNetwork();
});

test("2-D route capability는 최종 화면 이탈 뒤 정리하고 StrictMode 즉시 재연결은 유지", async () => {
  const h = harness(), routes = h.load("src/utils/schedule-ownership.ts");
  const route = routes.createScheduleRoute("fixture");
  const release = routes.retainScheduleRoute(route.params.connectionKey); release();
  const retained = routes.retainScheduleRoute(route.params.connectionKey);
  await Promise.resolve(); assert.ok(routes.resolveScheduleRoute(route.params.connectionKey, "fixture"));
  retained(); await Promise.resolve();
  assert.equal(routes.resolveScheduleRoute(route.params.connectionKey, "fixture"), null);
  const abandoned = routes.createScheduleRoute("abandoned"); routes.discardScheduleRoute(abandoned.params.connectionKey);
  assert.equal(routes.resolveScheduleRoute(abandoned.params.connectionKey, "abandoned"), null); assert.equal(h.liveCalls, 0);
});

for (const back of [false, true]) test(`2-C 실제 POST 저장 장벽 중 연결 변경: 복귀=${back}`, async () => {
  const h = assistantIntegration(() => []), original = h.storage.saveBeforePost;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), saved = new Promise(resolve => { entered = resolve; });
  const recovery = { ...h.storage, saveBeforePost: async (...args) => { const value = await original(...args); entered(); await gate; return value; } };
  const api = h.load("src/services/api/assistant.ts").createAssistantHttpClient({ recovery, readConfig: h.readConfig, fetchImpl: h.transport.fetchImpl });
  const pending = api.postAssistantRequest({ requestId: assistantId, input: { type: "text", text: "A private input" } }, { expectedServerId: h.a.serverId });
  await saved; h.change(h.b); if (back) h.change(h.a); release();
  assert.equal((await pending).error.kind, "context-changed");
  assert.equal(h.transport.getRequests().length, 0);
  assert.ok(await h.storage.read({ serverId: h.a.serverId, requestId: assistantId })); h.assertNoNetwork();
});

test("2-C 실제 client·복구·orchestrator: A/B 동일 ID 격리와 A 복귀 GET-only", async () => {
  const h = assistantIntegration((a, b) => [a, b].map((target, i) => ({ method: "GET",
    url: `${target.apiBaseUrl}/assistant/requests/${assistantId}`, steps: [0, 1].map(() => jsonStep({ ...assistantAccepted,
      status: "completed", result: { kind: "outcome", text: i ? "B result" : "A result", outcome: "success", operation: "list", schedulesChanged: false, items: [] } })) })));
  for (const target of [h.a, h.b]) await h.storage.saveBeforePost({ serverId: target.serverId, requestId: assistantId }, h.clock.now());
  for (const target of [h.a, h.b, h.a]) {
    if (h.api.getServerId() !== target.serverId) h.change(target);
    const initialized = await h.orchestrator.initializeRecovery();
    assert.equal(initialized.kind, "initialized"); assert.equal(initialized.requests.length, 1);
    const result = await initialized.requests[0].task.completion;
    assert.equal(result.response.data.result.text, target === h.a ? "A result" : "B result");
  }
  assert.equal((await h.storage.readAll()).length, 2);
  assert.ok(h.transport.getRequests().every(request => request.method === "GET")); h.assertNoNetwork();
});

test("2-C abort 무시 POST 지연 응답: A/1 증거만 보존하고 A/3 성공 반환 차단", async () => {
  const h = assistantIntegration(a => [{ method: "POST", url: `${a.apiBaseUrl}/assistant/requests`, steps: [{ ...jsonStep(assistantAccepted, 202), delayMs: 100, ignoreAbort: true }] }]);
  const ref = { serverId: h.a.serverId, requestId: assistantId };
  const pending = h.api.postAssistantRequest({ requestId: assistantId, input: { type: "text", text: "private" } }, { expectedServerId: ref.serverId });
  await h.advance(0); h.change(h.b); h.change(h.a); await h.advance(100);
  assert.equal((await pending).error.kind, "context-changed");
  assert.equal((await h.storage.read(ref)).acceptConfirmed, true);
  assert.equal(await h.storage.read({ ...ref, serverId: h.b.serverId }), null); h.assertNoNetwork();
});

test("2-C 늦은 접수 관측은 삭제 후 재생성된 같은 ID 기록을 덮어쓰지 않음", async () => {
  const h = assistantIntegration(() => []), ref = { serverId: h.a.serverId, requestId: assistantId };
  await h.storage.saveBeforePost(ref, 1000);
  await h.storage.removeManually(ref, { confirmed: true });
  await h.storage.saveBeforePost(ref, 2000);
  await assert.rejects(h.storage.recordResponse(ref, assistantAccepted, { expectedFirstPostAttemptAt: 1000 }), { code: "conflict" });
  assert.equal((await h.storage.read(ref)).acceptConfirmed, false);
  assert.equal((await h.storage.read(ref)).firstPostAttemptAt, 2000); h.assertNoNetwork();
});

test("2-C 이전 initialization 대기·finally가 A/3의 현재 GET-only 복구를 막지 않음", async () => {
  const h = assistantIntegration(a => [{ method: "GET", url: `${a.apiBaseUrl}/assistant/requests/${assistantId}`,
    steps: [jsonStep({ ...assistantAccepted, status: "completed", result: { kind: "failure", text: "fixture", code: "MODEL_TIMEOUT", nextAction: "retry_later" } })] }]);
  await h.storage.saveBeforePost({ serverId: h.a.serverId, requestId: assistantId }, h.clock.now());
  let release, entered; const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; }); let first = true;
  const orchestrator = h.load("src/services/api/assistant-orchestrator.ts").createAssistantOrchestrator({ http: h.api, requests: h.requests,
    storage: { ...h.storage, readForServer: async server => { if (first) { first = false; entered(); await gate; } return h.storage.readForServer(server); } },
    mode: h.mode, clock: h.clock, scheduleSync: { observe: async () => {} } });
  const old = orchestrator.initializeRecovery(); await waiting;
  h.change(h.b); h.change(h.a);
  const current = await orchestrator.initializeRecovery();
  assert.equal(current.kind, "initialized"); assert.equal((await current.requests[0].task.completion).kind, "completed");
  release(); assert.equal((await old).reason, "context-changed");
  assert.ok(h.transport.getRequests().every(value => value.method === "GET")); h.assertNoNetwork();
});

test("2-C 오래된 lease release는 같은 ID의 현재 세대 잠금을 해제하지 않음", () => {
  const h = assistantIntegration(() => []), ref = { serverId: h.a.serverId, requestId: assistantId };
  const acquire = h.load("src/services/api/assistant-request-recovery.ts").acquireAssistantRequestLease;
  const old = acquire(ref, h.mode.getState().generation); h.change(h.b); h.change(h.a);
  const current = acquire(ref, h.mode.getState().generation); assert.ok(current);
  old.release(); assert.equal(acquire(ref, h.mode.getState().generation), null);
  current.release(); const next = acquire(ref, h.mode.getState().generation); assert.ok(next); next.release(); h.assertNoNetwork();
});

function scheduleIntegration(routes) {
  const h = harness({ EXPO_PUBLIC_DEV_SERVER_BASE_URL: "https://a.example.invalid", EXPO_PUBLIC_SCHEDULE_DATA_MODE: "server" });
  const transport = h.mock.createMockTransport(routes, h.timers);
  const client = h.load("src/services/api/http.ts").createScheduleHttpClient({ fetchImpl: transport.fetchImpl });
  const service = h.load("src/services/api/schedules.ts").createScheduleService(client);
  const cache = h.load("src/stores/serverScheduleStore.ts").createServerScheduleStore({ readServerId: client.getServerId,
    list: service.listSchedules, get: service.getSchedule, prepareUpdate: service.prepareScheduleUpdate, prepareDeletion: service.prepareScheduleDeletion });
  return { ...h, client, service, cache, transport, change(origin) {
    h.env.EXPO_PUBLIC_DEV_SERVER_BASE_URL = origin;
    h.load("src/stores/scheduleDataModeStore.ts").scheduleDataModeStore.getState().resetConnectionAuthority();
    cache.syncServer();
  }, assertNoNetwork() { assert.equal(h.liveCalls, 0); } };
}
const scheduleId = "11111111-1111-4111-8111-111111111111";
const scheduleFixture = (title, completed = false) => ({ id: scheduleId, title, completed, category: "OTHER",
  scheduledAt: "2026-11-15T00:00:00Z", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" });
const detailUrl = origin => `${origin}/api/v1/schedules/${scheduleId}`;

for (const deleting of [false, true]) test(`통합: ${deleting ? "DELETE tombstone 서버 격리" : "PATCH 성공 후 목록 실패는 GET-only 재시도"}`, async () => {
  const a = "https://a.example.invalid", b = "https://b.example.invalid";
  const query = { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" };
  // Use the production query serializer, not a parallel fixture serializer.
  const params = harness().load("src/utils/schedule-query.ts").buildScheduleListQuery(query);
  const listUrl = origin => `${origin}/api/v1/schedules?${params}`;
  const h = scheduleIntegration([
    { method: "GET", url: listUrl(a), steps: [jsonStep({ items: [scheduleFixture("A")] }),
      ...(deleting ? [jsonStep({ items: [] })] : [{ kind: "network-error" }, { kind: "network-error" }, jsonStep({ items: [scheduleFixture("A", true)] })])] },
    { method: deleting ? "DELETE" : "PATCH", url: detailUrl(a), steps: [deleting ? jsonStep(null, 204) : jsonStep(scheduleFixture("A", true))] },
    { method: "GET", url: listUrl(b), steps: [jsonStep({ items: [scheduleFixture("B")] })] },
  ]);
  const consumer = h.cache.acquire(query); await consumer.promise;
  const id = h.client.getServerId();
  if (deleting) {
    assert.equal(await h.cache.deleteSchedule(id, scheduleId), true);
    assert.ok(h.cache.store.getState().servers[id].deletedIds[scheduleId]);
    h.change(b); await h.cache.acquire(query).promise;
    assert.equal(h.cache.store.getState().servers[h.client.getServerId()].entities[scheduleId].title, "B");
    assert.equal(h.cache.store.getState().servers[h.client.getServerId()].deletedIds[scheduleId], undefined);
  } else {
    await h.cache.toggleCompleted(id, scheduleId);
    assert.equal(h.cache.store.getState().servers[id].mutations[scheduleId].phase, "refresh-error");
    await h.cache.checkCompletion(id, scheduleId);
    assert.equal(h.cache.store.getState().servers[id].entities[scheduleId].completed, true);
  }
  assert.equal(h.transport.getRequests().filter(r => r.method === (deleting ? "DELETE" : "PATCH")).length, 1);
  h.assertNoNetwork();
});

test("통합: 등록 network retry의 원래 URL·Idempotency-Key·payload 유지, 복귀 후 재전송 차단", async () => {
  const a = "https://a.example.invalid", h = scheduleIntegration([
    { method: "POST", url: `${a}/api/v1/schedules`, steps: [{ kind: "network-error" }, jsonStep(scheduleFixture("create"), 201)] },
  ]);
  const operation = h.service.prepareScheduleCreation({ title: "create", scheduledAt: "2026-11-15T00:00:00Z", category: "OTHER" }).operation;
  assert.equal((await operation.submit()).outcome, "created");
  const requests = h.transport.getRequests();
  assert.equal(requests.length, 2); assert.equal(requests[0].url, requests[1].url);
  assert.equal(requests[0].body, requests[1].body); assert.deepEqual(requests[0].headers, requests[1].headers);
  h.change("https://b.example.invalid"); h.change(a);
  assert.equal((await operation.submit()).outcome, "not-sent");
  assert.equal(h.transport.getRequests().length, 2); h.assertNoNetwork();
});

test("통합: 지연 network 오류 뒤 이전 세대 HTTP retry는 실행하지 않는다", async () => {
  const a = "https://a.example.invalid", h = scheduleIntegration([
    { method: "GET", url: detailUrl(a), steps: [{ kind: "network-error", delayMs: 100, ignoreAbort: true }, jsonStep(scheduleFixture("unused"))] },
  ]);
  const old = h.service.getSchedule(scheduleId); await h.advance(0);
  h.change("https://b.example.invalid"); h.change(a); await h.advance(100);
  assert.equal((await old).error.kind, "aborted");
  assert.equal(h.transport.getRequests().length, 1); h.assertNoNetwork();
});

for (const back of [false, true]) test(`통합: abort 무시 지연 단건 GET, A→B${back ? "→A" : ""}`, async () => {
  const a = "https://a.example.invalid", b = "https://b.example.invalid";
  const h = scheduleIntegration([
    { method: "GET", url: detailUrl(a), steps: [{ ...jsonStep(scheduleFixture("old A")), delayMs: 100, ignoreAbort: true }, jsonStep(scheduleFixture("new A"))] },
    { method: "GET", url: detailUrl(b), steps: [jsonStep(scheduleFixture("B"))] },
  ]);
  const old = h.cache.acquireDetail(scheduleId); await h.advance(0);
  h.change(b); await h.cache.acquireDetail(scheduleId).promise;
  if (back) { h.change(a); await h.cache.acquireDetail(scheduleId).promise; }
  await h.advance(100); await old.promise;
  const current = h.cache.store.getState();
  assert.equal(current.servers[current.serverId].entities[scheduleId].title, back ? "new A" : "B");
  h.assertNoNetwork();
});

test("통합: 이전 PATCH rollback/finally는 복귀 세대의 새 mutation 잠금을 변경하지 않는다", async () => {
  const a = "https://a.example.invalid", b = "https://b.example.invalid";
  const h = scheduleIntegration([
    { method: "GET", url: detailUrl(a), steps: [jsonStep(scheduleFixture("A")), jsonStep(scheduleFixture("A fresh"))] },
    { method: "PATCH", url: detailUrl(a), steps: [{ ...jsonStep(scheduleFixture("late", true)), delayMs: 100, ignoreAbort: true }] },
  ]);
  await h.cache.acquireDetail(scheduleId).promise;
  const id = h.client.getServerId(), old = h.cache.toggleCompleted(id, scheduleId); await h.advance(0);
  h.change(b); h.change(a);
  assert.equal(h.cache.completionAllowed(id, scheduleId), false);
  await h.cache.acquireDetail(scheduleId).promise;
  // An uncertain write keeps its original lock until explicit GET reconciliation.
  assert.equal(h.cache.beginMutation(id, scheduleId, "edit"), null);
  await h.advance(100); await old;
  assert.equal(h.cache.store.getState().servers[id].entities[scheduleId].title, "A fresh");
  assert.equal(h.cache.store.getState().servers[id].mutations[scheduleId].phase, "uncertain");
  assert.equal(h.transport.getRequests().filter(r => r.method === "PATCH").length, 1);
  h.assertNoNetwork();
});

test("통합: 확정 거절 수신 후 지연된 이전 PATCH rollback은 A 복귀 GET 결과를 변경하지 않는다", async () => {
  const a = "https://a.example.invalid", b = "https://b.example.invalid";
  const h = scheduleIntegration([
    { method: "GET", url: detailUrl(a), steps: [jsonStep(scheduleFixture("A")), jsonStep(scheduleFixture("A fresh", true))] },
    { method: "PATCH", url: detailUrl(a), steps: [problemStep(400, "INVALID_REQUEST")] },
  ]);
  let release, received;
  const gate = new Promise(resolve => { release = resolve; });
  const responseReceived = new Promise(resolve => { received = resolve; });
  const cache = h.load("src/stores/serverScheduleStore.ts").createServerScheduleStore({
    readServerId: h.client.getServerId, list: h.service.listSchedules, get: h.service.getSchedule,
    prepareUpdate(id, payload) {
      const prepared = h.service.prepareScheduleUpdate(id, payload);
      assert.equal(prepared.ok, true);
      return { ...prepared, operation: { ...prepared.operation, async submit(signal) {
        const result = await prepared.operation.submit(signal);
        assert.equal(result.outcome, "rejected");
        assert.equal(result.requiresReconciliation, false);
        received(); await gate; return result;
      } } };
    },
  });
  await cache.acquireDetail(scheduleId).promise;
  const id = h.client.getServerId(), old = cache.toggleCompleted(id, scheduleId);
  await responseReceived;
  h.change(b); cache.syncServer(); h.change(a); cache.syncServer();
  await cache.acquireDetail(scheduleId).promise;
  assert.equal(cache.store.getState().servers[id].entities[scheduleId].completed, true);
  release(); await old;
  assert.equal(cache.store.getState().servers[id].entities[scheduleId].completed, true);
  assert.equal(cache.store.getState().servers[id].mutations[scheduleId].phase, "uncertain");
  assert.equal(h.transport.getRequests().filter(request => request.method === "PATCH").length, 1);
  h.assertNoNetwork();
});

test("통합: DELETE 불확실 잠금은 화면 abort 후 보존되고 새 DELETE를 자동 전송하지 않는다", async () => {
  const a = "https://a.example.invalid";
  const h = scheduleIntegration([
    { method: "GET", url: detailUrl(a), steps: [jsonStep(scheduleFixture("A"))] },
    { method: "DELETE", url: detailUrl(a), steps: [{ kind: "pending" }] },
  ]);
  await h.cache.acquireDetail(scheduleId).promise;
  const controller = new AbortController(), id = h.client.getServerId();
  const pending = h.cache.deleteSchedule(id, scheduleId, controller.signal); await h.advance(0);
  controller.abort(); await pending;
  assert.equal(h.cache.store.getState().servers[id].mutations[scheduleId].phase, "uncertain");
  assert.equal(h.cache.beginMutation(id, scheduleId, "delete"), null);
  assert.equal(await h.cache.deleteSchedule(id, scheduleId), false);
  assert.equal(h.transport.getRequests().filter(r => r.method === "DELETE").length, 1);
  h.assertNoNetwork();
});

test("실제 Schedule service/store와 Mock transport: 동일 ID A/B 격리·복귀 GET 장벽", async () => {
  const h = harness({ EXPO_PUBLIC_DEV_SERVER_BASE_URL: "https://a.example.invalid", EXPO_PUBLIC_SCHEDULE_DATA_MODE: "server" });
  const modes = h.load("src/stores/scheduleDataModeStore.ts").scheduleDataModeStore;
  const query = { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" };
  const id = "11111111-1111-4111-8111-111111111111";
  const dto = title => ({ id, title, category: "OTHER", completed: false, scheduledAt: "2026-11-15T00:00:00Z",
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" });
  const url = origin => `${origin}/api/v1/schedules?${h.load("src/utils/schedule-query.ts").buildScheduleListQuery(query)}`;
  const transport = h.mock.createMockTransport([
    { method: "GET", url: url("https://a.example.invalid"), steps: [jsonStep({ items: [dto("A")] }), jsonStep({ items: [dto("A new")] })] },
    { method: "GET", url: url("https://b.example.invalid"), steps: [jsonStep({ items: [dto("B")] })] },
  ]);
  const client = h.load("src/services/api/http.ts").createScheduleHttpClient({ fetchImpl: transport.fetchImpl });
  const service = h.load("src/services/api/schedules.ts").createScheduleService(client);
  const cache = h.load("src/stores/serverScheduleStore.ts").createServerScheduleStore({ readServerId: client.getServerId,
    list: service.listSchedules, get: service.getSchedule, prepareUpdate: service.prepareScheduleUpdate, prepareDeletion: service.prepareScheduleDeletion });
  const a = client.getServerId();
  await cache.acquire(query).promise;
  const staleConsumer = cache.acquire(query);
  const operation = service.prepareScheduleUpdate(id, { completed: true }).operation;
  h.env.EXPO_PUBLIC_DEV_SERVER_BASE_URL = "https://b.example.invalid"; modes.getState().resetConnectionAuthority(); cache.syncServer();
  const b = client.getServerId(); await cache.acquire(query).promise;
  assert.equal(cache.store.getState().servers[a].entities[id].title, "A");
  assert.equal(cache.store.getState().servers[b].entities[id].title, "B");
  h.env.EXPO_PUBLIC_DEV_SERVER_BASE_URL = "https://a.example.invalid"; modes.getState().resetConnectionAuthority(); cache.syncServer();
  assert.equal(cache.completionAllowed(a, id), false);
  await staleConsumer.retry();
  assert.equal(transport.getRequests().length, 2);
  assert.equal((await operation.submit()).outcome, "not-sent");
  await cache.acquire(query).promise;
  assert.equal(cache.completionAllowed(a, id), true);
  assert.equal(cache.store.getState().servers[a].entities[id].title, "A new");
  assert.equal(h.liveCalls, 0);
});

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
  assert.equal(validator.isAssistantRecoveryServerId(h.config.createPiCandidate("192.0.2.10").serverId), true);
});

test("Schedule A/1 → B/2 → A/3 지연 응답은 현재 성공으로 적용하지 않는다", async () => {
  const h = harness({ EXPO_PUBLIC_DEV_SERVER_BASE_URL: "https://a.example.invalid" });
  const modes = h.load("src/stores/scheduleDataModeStore.ts").scheduleDataModeStore;
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  let calls = 0;
  const client = h.load("src/services/api/http.ts").createScheduleHttpClient({ fetchImpl: async () => {
    calls++; await pending;
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  } });
  const request = client.request({ path: "/schedules" });
  h.env.EXPO_PUBLIC_DEV_SERVER_BASE_URL = "https://b.example.invalid";
  modes.getState().resetConnectionAuthority();
  h.env.EXPO_PUBLIC_DEV_SERVER_BASE_URL = "https://a.example.invalid";
  modes.getState().resetConnectionAuthority();
  resolve();
  const result = await request;
  assert.equal(result.ok, false); assert.equal(result.error.kind, "aborted");
  assert.equal(calls, 1); assert.equal(h.liveCalls, 0);
});

test("복구 namespace는 canonical origin만 허용하고 실제 Pi·Mock을 분리한다", () => {
  const h = harness(), validator = h.load("src/utils/assistant-recovery.ts");
  for (const value of ["development:https://a.example.invalid", "mock:development:https://a.example.invalid",
    "pi:http://192.0.2.10:8000", "mock:pi:http://192.0.2.10:8000"]) {
    assert.equal(validator.isAssistantRecoveryServerId(value), true, value);
  }
  for (const value of ["other:https://a.example.invalid", "pi:http://192.0.02.10:8000",
    "pi:https://192.0.2.10:8000", "pi:http://192.0.2.10:8000/", "mock:mock:pi:http://192.0.2.10:8000"]) {
    assert.equal(validator.isAssistantRecoveryServerId(value), false, value);
  }
  assert.equal(h.liveCalls, 0);
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
