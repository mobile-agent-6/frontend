/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const origin = "https://example.invalid", otherOrigin = "https://other.example.invalid", serverId = `development:${origin}`;
const id = n => `${n.toString(16).padStart(8, "0")}-abcd-4abc-8abc-abcdef123456`;
const ref = (n = 1, server = serverId) => ({ serverId: server, requestId: id(n) });
const query = { from: "2026-10-31T15:00:00Z", to: "2026-11-30T15:00:00Z" };
const december = { from: "2026-11-30T15:00:00Z", to: "2026-12-31T15:00:00Z" };
const dto = (n = 200, extra = {}) => ({ id: id(n), title: "정식 Schedule DTO", category: "INVENTORY", completed: false,
  scheduledAt: "2026-11-07T03:00:00Z", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z", ...extra });
const success = (operation = "create", n = 1) => ({ requestId: id(n), conversationId: id(100), status: "completed",
  result: { kind: "outcome", text: "문구는 성공 판단에 사용하지 않음", outcome: "success", operation, schedulesChanged: true, affectedScheduleIds: [id(200)] } });
const json = (value, status = 200, media = "application/json") => new Response(JSON.stringify(value), { status, headers: { "Content-Type": media, "X-Request-ID": id(900) } });
const problem = (status = 404) => json({ type: "https://example.invalid/problem", title: "조회 실패", detail: "내부 오류를 표시하지 않음",
  instance: "/api/v1/schedules", requestId: id(900), status, code: status === 503 ? "DATABASE_UNAVAILABLE" : "ROUTE_NOT_FOUND" }, status, "application/problem+json");
const tick = async () => { for (let n = 0; n < 150; n++) await Promise.resolve(); };

// 실제 Schedule HTTP·DTO mapper·공유 캐시·Assistant orchestration을 실행하며 외부 I/O만 메모리 대역으로 둔다.
function harness() {
  const modules = new Map(), calls = [], data = new Map(); let config;
  const state = { refreshes: [], assistant: success(), scheduleHandle: null };
  const send = (url, options) => {
    calls.push({ url, ...options });
    if (url.includes("/assistant/")) return Promise.resolve(options.method === "POST"
      ? json({ requestId: JSON.parse(options.body).requestId, conversationId: id(100), status: "accepted" }, 202)
      : json({ ...state.assistant, requestId: url.split("/").pop() }));
    if (state.scheduleHandle) return state.scheduleHandle(url, options);
    return new Promise(resolve => { calls.at(-1).resolve = resolve; });
  };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ["2026-11-07T03:00:00Z"])); } static now() { return Date.parse("2026-11-07T03:00:00Z"); } }
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file }).outputText;
    function resolve(name) {
      if (name === "zustand/vanilla" || name === "zustand") return require(name);
      if (name === "expo-crypto") return { randomUUID };
      if (name === "expo/fetch") return { fetch: send };
      if (name === "react-native") return { AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } };
      if (name === "@react-native-async-storage/async-storage") return { getItem: async key => data.get(key) ?? null, setItem: async (key, value) => { data.set(key, value); } };
      assert.ok(name.startsWith("@/"), name); return load(`src/${name.slice(2)}.ts`);
    }
    new Function("require", "module", "exports", "fetch", "process", "Date", code)(resolve, module, module.exports,
      () => { throw Error("실제 네트워크 금지"); }, { env: { EXPO_PUBLIC_SCHEDULE_DATA_MODE: "server", EXPO_PUBLIC_DEV_SERVER_BASE_URL: origin } }, FixedDate);
    return module.exports;
  }
  const configModule = load("src/services/api/config.ts"); config = configModule.parseDevelopmentServerConfig(origin);
  configModule.getDevelopmentServerConfig = () => config;
  const http = load("src/services/api/http.ts"); http.scheduleHttpClient = http.createScheduleHttpClient({ readConfig: () => config, fetchImpl: send });
  const cacheModule = load("src/stores/serverScheduleStore.ts"), cache = cacheModule.serverScheduleStore;
  const refresh = cache.refreshAfterExternalChange;
  cache.refreshAfterExternalChange = (...args) => { state.refreshes.push(args); return refresh(...args); };
  const sync = load("src/services/api/assistant-schedule-sync.ts").assistantScheduleSync;
  const mode = load("src/stores/scheduleDataModeStore.ts").scheduleDataModeStore;
  const entry = (q = query, server = serverId) => cache.store.getState().servers[server]?.queries[cacheModule.scheduleQueryKey(server, q)];
  return { load, sync, cache, cacheModule, mode, calls, state, data, entry,
    server(value) { config = configModule.parseDevelopmentServerConfig(value); cache.syncServer(); },
    reply(index, items) { calls[index].resolve(json({ items })); },
    getCalls: () => calls.filter(call => !call.url.includes("/assistant/")),
    cacheData: () => cache.store.getState().servers[serverId] };
}

for (const operation of ["create", "update", "delete"]) test(`8-A ${operation} 성공: 목록 GET만 실행·ID로 객체/삭제 상태를 만들지 않음`, async () => {
  const h = harness(), result = success(operation), original = JSON.stringify(result);
  const pending = h.sync.observe(ref(), result); await tick();
  assert.equal(h.getCalls().length, 1); assert.equal(h.getCalls()[0].method, "GET"); assert.equal(new URL(h.getCalls()[0].url).pathname, "/api/v1/schedules");
  assert.deepEqual(h.cacheData().entities, {}); assert.deepEqual(h.cacheData().deletedIds, {});
  h.reply(0, operation === "delete" ? [] : [dto()]); assert.equal((await pending).phase, "synchronized");
  assert.equal(JSON.stringify(result), original); assert.ok(h.calls.every(call => call.method === "GET"));
});

for (const kind of ["accepted", "processing", "need_more_info", "candidate_selection", "confirmation", "cancelled", "no_match", "list", "failure", "uncertain"]) test(`8-A ${kind}는 Schedule 동기화·write 0회`, async () => {
  const h = harness(), data = success();
  if (["accepted", "processing"].includes(kind)) { data.status = kind; delete data.result; }
  else if (kind === "list") data.result = { kind: "outcome", text: "조회", outcome: "success", operation: "list", schedulesChanged: false, items: [] };
  else if (["cancelled", "no_match"].includes(kind)) data.result = { kind: "outcome", text: "거절", outcome: kind, schedulesChanged: false };
  else if (kind === "need_more_info") data.result = { kind, text: "질문", questionId: id(300) };
  else if (kind === "candidate_selection") data.result = { kind, text: "후보", questionId: id(300), expiresAt: "2026-11-07T04:00:00Z", candidates: [1, 2].map(n => ({ candidateId: `opaque/${n}`, title: "후보", scheduledAt: dto().scheduledAt, category: "OTHER" })) };
  else if (kind === "confirmation") { const item = dto(); delete item.createdAt; data.result = { kind, text: "확인", questionId: id(300), expiresAt: "2026-11-07T04:00:00Z", operation: "update", target: item, changes: { completed: true } }; }
  else if (kind === "failure") data.result = { kind, text: "실패", code: "MODEL_TIMEOUT", nextAction: "retry_later" };
  else data.result = { kind, text: "미확인", code: "EXECUTION_RESULT_UNKNOWN", nextAction: "check_status" };
  assert.ok(h.load("src/utils/assistant-validation.ts").parseAssistantRequestStatusResponse(data));
  assert.equal(await h.sync.observe(ref(), data), null); assert.equal(h.calls.length, 0); assert.deepEqual(h.sync.getSnapshot(), []);
});

for (const invalid of ["missing-id", "bad-id", "two-ids", "false-changed", "wrong-request"]) test(`8-A 계약 위반 ${invalid}는 GET 0회`, async () => {
  const h = harness(), data = success();
  if (invalid === "missing-id") delete data.result.affectedScheduleIds;
  if (invalid === "bad-id") data.result.affectedScheduleIds = ["opaque"];
  if (invalid === "two-ids") data.result.affectedScheduleIds = [id(200), id(201)];
  if (invalid === "false-changed") data.result.schedulesChanged = false;
  if (invalid === "wrong-request") data.requestId = id(2);
  assert.equal(await h.sync.observe(ref(), data), null); assert.equal(h.calls.length, 0);
});

test("8-A uncertain 원래 GET → 확정 success에서 처음으로 동기화", async () => {
  const h = harness(), orches = h.load("src/services/api/assistant-orchestrator.ts").assistantOrchestrator;
  h.state.assistant = { ...success(), result: { kind: "uncertain", text: "미확인", code: "EXECUTION_RESULT_UNKNOWN", nextAction: "check_status" } };
  const first = await orches.queryRequestOnce(ref()).completion; assert.equal(first.kind, "completed", JSON.stringify(first)); assert.equal(first.response.data.result.kind, "uncertain"); assert.equal(h.getCalls().length, 0);
  h.state.assistant = success("update"); const second = await orches.queryRequestOnce(ref()).completion; await tick();
  assert.equal(second.response.data.result.kind, "outcome"); assert.equal(h.getCalls().length, 1);
  h.reply(h.calls.length - 1, [dto(200, { completed: true })]); await h.sync.observe(ref(), success("update"));
  assert.equal(h.cacheData().entities[id(200)].completed, true); assert.ok(h.calls.every(call => call.method === "GET"));
});

test("8-A 현재 from/to/category/completed와 비활성 query stale·affected 단건만 무효화", async () => {
  const h = harness(), filtered = { ...query, category: "INVENTORY", completed: false };
  const a = h.cache.acquire(filtered), b = h.cache.acquire(december), detail = h.cache.acquireDetail(id(200)); await tick();
  h.reply(0, [dto()]); h.reply(1, []); h.calls[2].resolve(json(dto())); await Promise.all([a.promise, b.promise, detail.promise]); b.release();
  const pending = h.sync.observe(ref(), success("update")); await tick();
  const next = new URL(h.calls[3].url); assert.equal(next.searchParams.get("from"), new Date(filtered.from).toISOString()); assert.equal(next.searchParams.get("to"), new Date(filtered.to).toISOString());
  assert.equal(next.searchParams.get("category"), "INVENTORY"); assert.equal(next.searchParams.get("completed"), "false");
  assert.equal(h.cacheData().details[id(200)].stale, true); assert.equal(h.entry(december).stale, true);
  assert.deepEqual(h.entry(filtered).ids, [id(200)]); h.reply(3, []); await pending; assert.deepEqual(h.entry(filtered).ids, []);
  a.release(); detail.release();
});

test("8-A 같은 서버/requestId 중복·대소문자·구독 재진입은 같은 GET 1회", async () => {
  const h = harness(); let reentered = false;
  const off = h.sync.subscribe(() => { if (!reentered) { reentered = true; void h.sync.observe(ref(), success()); } });
  const a = h.sync.observe(ref(), success()), b = h.sync.observe({ ...ref(), requestId: id(1).toUpperCase() }, success()); assert.strictEqual(a, b); await tick();
  h.reply(0, []); await a; for (let n = 0; n < 4; n++) await h.sync.observe(ref(), success());
  assert.equal(h.getCalls().length, 1); assert.equal(h.state.refreshes.length, 1); off();
});

test("8-A GET 실패는 Assistant 성공·이전 데이터 유지, 중복 관측 자동 retry 없이 명시적 GET-only 재시도", async () => {
  const h = harness(), owner = h.cache.acquire(query); await tick(); h.reply(0, [dto()]); await owner.promise;
  const result = success("update"), pending = h.sync.observe(ref(), result); await tick(); h.calls[1].resolve(problem());
  const failed = await pending; assert.equal(failed.phase, "refresh-error"); assert.equal(failed.failedQueries.length, 1);
  assert.equal(failed.errors[0].error.problem.code, "ROUTE_NOT_FOUND"); assert.deepEqual(h.entry().ids, [id(200)]); assert.equal(h.entry().status, "error");
  await h.sync.observe(ref(), result); assert.equal(h.calls.length, 2); assert.equal(result.result.outcome, "success");
  const retry = h.sync.retry(ref()); await tick(); h.reply(2, [dto(200, { title: "새 GET 제목" })]); assert.equal((await retry).phase, "synchronized");
  assert.equal(h.cacheData().entities[id(200)].title, "새 GET 제목"); assert.ok(h.calls.every(call => call.method === "GET")); owner.release();
});

test("8-A 오래된 목록·단건 GET 응답은 성공 뒤 새 목록을 덮지 못함", async () => {
  const h = harness(), list = h.cache.acquire(query), detail = h.cache.acquireDetail(id(200)); await tick();
  const pending = h.sync.observe(ref(), success("delete")); await tick(); assert.ok(h.calls[0].signal.aborted); assert.ok(h.calls[1].signal.aborted);
  h.reply(2, []); await pending; h.reply(0, [dto()]); h.calls[1].resolve(json(dto())); await tick();
  assert.deepEqual(h.entry().ids, []); assert.equal(h.cacheData().entities[id(200)], undefined); list.release(); detail.release();
});

for (const change of ["server", "mode"]) test(`8-A ${change} 변경 뒤 늦은 GET 결과는 현재 캐시에 반영 안 함`, async () => {
  const h = harness(), pending = h.sync.observe(ref(), success()); await tick();
  if (change === "server") h.server(otherOrigin); else h.mode.getState().setMode("mock");
  h.reply(0, [dto()]); assert.equal((await pending).phase, "interrupted"); assert.equal(h.cacheData().entities[id(200)], undefined);
  assert.equal(await h.sync.observe(ref(), success()), change === "server" || change === "mode" ? null : undefined);
});

test("8-A 다른 서버·Mock 성공 결과는 캐시·GET·Mock 원본 변경 없음", async () => {
  const h = harness(), mock = h.load("src/stores/scheduleStore.ts").useScheduleStore, before = mock.getState().schedules;
  assert.equal(await h.sync.observe(ref(1, `development:${otherOrigin}`), success()), null);
  h.mode.getState().setMode("mock"); assert.equal(await h.sync.observe(ref(), success()), null);
  assert.equal(h.calls.length, 0); assert.strictEqual(mock.getState().schedules, before);
});

test("8-A 수동 mutation 진행 중 동기화 대기·mutation controller와 기존 GET 취소 없음", async () => {
  const h = harness(), owner = h.cache.acquire(query); await tick(); h.reply(0, [dto()]); await owner.promise;
  const lease = h.cache.beginMutation(serverId, id(200), "edit"), pending = h.sync.observe(ref(), success("update")); await tick();
  assert.equal(h.calls.length, 1); assert.equal(lease.controller.signal.aborted, false);
  h.cache.applyScheduleResult(serverId, h.load("src/utils/schedule-mapper.ts").scheduleDtoToSchedule(dto(200, { title: "수동 수정 성공" })));
  const manual = h.cache.refreshLists(serverId); await tick(); assert.equal(h.calls[1].signal.aborted, false);
  h.reply(1, [dto(200, { title: "수동 수정 성공" })]); await manual; lease.finish(); await tick();
  assert.equal(lease.controller.signal.aborted, false); h.reply(2, [dto(200, { title: "최신 GET" })]); await pending;
  assert.equal(h.cacheData().entities[id(200)].title, "최신 GET"); owner.release();
});

test("8-A 동기화 중 수동 mutation 성공은 오래된 동기화 GET보다 우선하며 PATCH 재실행 없음", async () => {
  const h = harness(), owner = h.cache.acquire(query); await tick(); h.reply(0, [dto()]); await owner.promise;
  const pending = h.sync.observe(ref(), success("update")); await tick();
  const lease = h.cache.beginMutation(serverId, id(200), "edit"); h.cache.invalidate();
  h.cache.applyScheduleResult(serverId, h.load("src/utils/schedule-mapper.ts").scheduleDtoToSchedule(dto(200, { title: "나중 수동 성공" })));
  const manual = h.cache.refreshLists(serverId); await tick(); h.reply(2, [dto(200, { title: "나중 수동 성공" })]); await manual; lease.finish();
  h.reply(1, [dto(200, { title: "이전 응답" })]); await pending; assert.equal(h.cacheData().entities[id(200)].title, "나중 수동 성공");
  assert.ok(h.calls.every(call => call.method === "GET")); owner.release();
});

test("8-A 수동 mutation 대기 중 모드 변경은 GET 없이 종료하고 listener 정리", async () => {
  const h = harness(); h.cache.syncServer(); const lease = h.cache.beginMutation(serverId, id(200), "edit");
  const pending = h.sync.observe(ref(), success()); await tick(); h.mode.getState().setMode("mock"); assert.equal((await pending).phase, "interrupted");
  lease.finish(); await tick(); assert.equal(h.calls.length, 0);
});

test("8-A 서로 다른 성공 결과는 순차 동기화해 앞선 GET을 서로 취소하지 않음", async () => {
  const h = harness(), a = h.sync.observe(ref(1), success("create", 1)), b = h.sync.observe(ref(2), success("delete", 2)); await tick();
  assert.equal(h.calls.length, 1); h.reply(0, [dto()]); await a; await tick(); assert.equal(h.calls[0].signal.aborted, false);
  h.reply(1, []); await b; assert.equal(h.sync.getSnapshot().length, 2); assert.ok(h.sync.getSnapshot().every(entry => entry.phase === "synchronized"));
});

test("8-A 최초 POST 완료는 Schedule GET을 기다리지 않고 성공 유지·복구 재관측도 중복 없음", async () => {
  const h = harness(), orches = h.load("src/services/api/assistant-orchestrator.ts").assistantOrchestrator;
  const task = orches.startRequest({ requestId: id(1), input: { type: "text", text: "일정 추가" } }, { expectedServerId: serverId });
  const result = await task.completion; await tick(); assert.equal(result.kind, "completed", JSON.stringify(result)); assert.equal(result.response.data.result.outcome, "success");
  assert.equal(h.getCalls().length, 1); h.reply(h.calls.length - 1, [dto()]); await h.sync.observe(ref(), success());
  await orches.queryRequestOnce(ref()).completion; await tick(); assert.equal(h.getCalls().length, 1); assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
  assert.ok(h.calls.filter(call => call.method === "POST").every(call => call.url.endsWith("/assistant/requests")));
});

test("8-A 앱 재실행 GET-only 초기 복구의 success도 Schedule GET 동기화·POST 없음", async () => {
  const h = harness(), storage = h.load("src/services/storage/assistant-recovery.ts").assistantRecoveryStorage;
  await storage.saveBeforePost(ref(), Date.parse("2026-11-07T02:50:00Z"));
  const orches = h.load("src/services/api/assistant-orchestrator.ts").assistantOrchestrator, initialized = await orches.initializeRecovery(); await tick();
  assert.equal(initialized.kind, "initialized"); assert.equal(h.getCalls().length, 1, JSON.stringify(initialized)); h.reply(h.calls.length - 1, [dto()]); await h.sync.observe(ref(), success());
  assert.ok(h.calls.every(call => call.method === "GET"));
});

test("8-A 후속 UI snapshot·반환 오류 상태는 불변이며 구독자 예외가 동기화를 중단하지 않음", async () => {
  const h = harness(); let notifications = 0;
  const off = h.sync.subscribe(() => { notifications++; throw Error("표시 구독 실패"); });
  const initial = h.sync.getSnapshot(), pending = h.sync.observe(ref(), success()); await tick(); h.calls[0].resolve(problem());
  const failed = await pending, snapshot = h.sync.getSnapshot();
  assert.ok(notifications >= 2); assert.notStrictEqual(initial, snapshot); assert.equal(snapshot, h.sync.getSnapshot());
  assert.ok(Object.isFrozen(failed)); assert.ok(Object.isFrozen(failed.reference)); assert.ok(Object.isFrozen(failed.failedQueries));
  assert.ok(Object.isFrozen(failed.errors[0].error.problem)); assert.equal(failed.phase, "refresh-error");
  assert.notStrictEqual(failed.errors[0].error, h.entry(failed.failedQueries[0]).error); off();
});
