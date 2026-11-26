/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");

// 기존 테스트와 같이 메모리에서만 컴파일하며 실제 fetch는 허용하지 않는다.
function loader() {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
    }).outputText;
    const resolve = (name) => {
      if (name === "zustand" || name === "zustand/vanilla") return require(name);
      if (name === "react") return require(name);
      if (name === "expo-crypto") return { randomUUID: require("node:crypto").randomUUID };
      if (name === "expo/fetch") return { fetch: () => { throw new Error("실제 네트워크 요청 금지"); } };
      assert.ok(name.startsWith("@/"));
      return load(path.join(root, "src", `${name.slice(2)}.ts`));
    };
    new Function("require", "module", "exports", "fetch", "process", code)(resolve, module, module.exports,
      () => { throw new Error("실제 네트워크 요청 금지"); }, { env: {} });
    return module.exports;
  }
  return (file) => load(path.join(root, file));
}
const query = { from: "2026-11-01T00:00:00+09:00", to: "2026-12-01T00:00:00+09:00" };
const month2 = { from: "2026-12-01T00:00:00+09:00", to: "2027-01-01T00:00:00+09:00" };
const wide = { from: query.from, to: month2.to };
const dto = (id = "shared", title = "서버 일정") => ({ id, title, scheduledAt: "2026-11-15T00:00:00Z",
  category: "INVENTORY", completed: false, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" });
const response = (items) => new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
const tick = () => new Promise(setImmediate);
function harness({ timeout = false } = {}) {
  const load = loader();
  const configModule = load("src/services/api/config.ts");
  let config = configModule.parseDevelopmentServerConfig("https://example.invalid");
  const calls = [];
  const http = load("src/services/api/http.ts");
  const client = http.createScheduleHttpClient({ readConfig: () => config, fetchImpl: (url, options) => {
    if (timeout) throw new Error("메모리 네트워크 오류");
    return new Promise((resolve) => calls.push({ url, ...options, resolve }));
  } });
  const service = load("src/services/api/schedules.ts").createScheduleService(client);
  const mod = load("src/stores/serverScheduleStore.ts");
  const cache = mod.createServerScheduleStore({ readServerId: client.getServerId, list: service.listSchedules });
  const entry = (q = query, id = client.getServerId()) => cache.store.getState().servers[id]?.queries[mod.scheduleQueryKey(id, q)];
  return { load, mod, cache, calls, entry, client, setServer(value) {
    config = configModule.parseDevelopmentServerConfig(value); cache.syncServer();
  }, data: () => cache.store.getState().servers[client.getServerId()] };
}

test("Mock 10개와 CRUD는 서버 cache와 완전히 격리된다", async () => {
  const h = harness();
  const mock = h.load("src/stores/scheduleStore.ts").useScheduleStore;
  assert.equal(mock.getState().schedules.length, 10);
  const before = mock.getState().schedules;
  const a = h.cache.acquire(query); await tick(); h.calls[0].resolve(response([dto()])); await a.promise;
  assert.strictEqual(mock.getState().schedules, before);
  mock.getState().addSchedule({ ...h.data().entities.shared, id: "local" });
  mock.getState().toggleCompleted("local"); mock.getState().updateSchedule("local", { title: "로컬" });
  assert.equal(h.data().entities.local, undefined);
  mock.getState().deleteSchedule("local"); assert.equal(mock.getState().schedules.length, 10); a.release();
});
test("서로 다른 월 결과 보존과 서버 ID 순서 유지", async () => {
  const h = harness(); const a = h.cache.acquire(query), b = h.cache.acquire(month2); await tick();
  h.calls[0].resolve(response([dto("z"), dto("a")])); h.calls[1].resolve(response([dto("b")]));
  await Promise.all([a.promise, b.promise]); assert.deepEqual(h.entry().ids, ["z", "a"]);
  assert.deepEqual(h.entry(month2).ids, ["b"]); a.release(); b.release();
});
test("겹치는 query는 동일 엔터티를 참조하고 한 결과의 누락은 전역 삭제가 아니다", async () => {
  const h = harness(); const a = h.cache.acquire(query), b = h.cache.acquire(wide); await tick();
  h.calls[0].resolve(response([dto()])); h.calls[1].resolve(response([dto()])); await Promise.all([a.promise, b.promise]);
  const cache = h.data(); assert.strictEqual(cache.entities[h.entry().ids[0]], cache.entities[h.entry(wide).ids[0]]);
  const retry = h.cache.retry(query); await tick(); h.calls[2].resolve(response([])); await retry;
  assert.deepEqual(h.entry().ids, []); assert.ok(h.data().entities.shared); assert.deepEqual(h.entry(wide).ids, ["shared"]);
});
test("미조회와 정상 0건, 범위 밖 coverage 구분", async () => {
  const h = harness(); assert.equal(h.entry(), undefined);
  assert.equal(h.mod.getScheduleCoverage(undefined, query.from, query.to), "unknown");
  const a = h.cache.acquire(query); await tick(); assert.equal(h.entry().status, "loading"); assert.equal(h.entry().hasSuccess, false);
  h.calls[0].resolve(response([])); await a.promise;
  assert.equal(h.entry().hasSuccess, true); assert.equal(h.entry().status, "success");
  assert.equal(h.mod.getScheduleCoverage(h.entry(), query.from, query.to), "covered");
  assert.equal(h.mod.getScheduleCoverage(h.entry(), month2.from, month2.to), "unknown");
});
test("query key는 offset·소수초 정규화, category 및 completed 미지정/false 구분", () => {
  const { mod } = harness(); const key = (q) => mod.scheduleQueryKey("서버", q);
  assert.equal(key(query), key({ from: "2026-10-31T15:00:00.000000Z", to: "2026-11-30T15:00:00Z" }));
  assert.notEqual(key(query), key({ ...query, completed: false }));
  assert.notEqual(key({ ...query, completed: false }), key({ ...query, completed: true }));
  assert.notEqual(key(query), key({ ...query, category: "INVENTORY" }));
  assert.notEqual(key(query), mod.scheduleQueryKey("다른 서버", query));
});
test("동일 query 동시 요청 공유, 일부 해제 유지, 마지막 해제 취소", async () => {
  const h = harness(); const a = h.cache.acquire(query), b = h.cache.acquire(query);
  assert.strictEqual(a.promise, b.promise); await tick(); assert.equal(h.calls.length, 1);
  a.release(); assert.equal(h.calls[0].signal.aborted, false);
  b.release(); assert.equal(h.calls[0].signal.aborted, true); await a.promise;
  assert.equal(h.entry().error, null); assert.equal(h.entry().hasSuccess, false); assert.equal(h.entry().status, "idle");
  assert.equal(h.calls.length, 1);
});
test("해제 직전 새 요청의 소유권과 응답 순서 역전", async () => {
  const h = harness(); const old = h.cache.acquire(query); await tick(); old.release();
  const next = h.cache.acquire(query); await tick(); h.calls[1].resolve(response([dto("new")])); await next.promise;
  h.calls[0].resolve(response([dto("old")])); await old.promise; assert.deepEqual(h.entry().ids, ["new"]);
});
test("겹치는 조회의 늦은 응답이 최신 객체를 덮지 않음", async () => {
  const h = harness(); const old = h.cache.acquire(query), next = h.cache.acquire(wide); await tick();
  h.calls[1].resolve(response([dto("shared", "최신")])); await next.promise;
  h.calls[0].resolve(response([dto("shared", "과거")])); await old.promise;
  assert.equal(h.data().entities.shared.title, "최신"); assert.equal(h.entry().stale, true);
});
test("새 객체 상태를 받은 기존 query는 stale이며 성공 ID 순서는 유지", async () => {
  const h = harness(); const a = h.cache.acquire(query); await tick(); h.calls[0].resolve(response([dto()])); await a.promise;
  const b = h.cache.acquire(wide); await tick(); h.calls[1].resolve(response([dto("shared", "변경")])); await b.promise;
  assert.equal(h.entry().stale, true); assert.deepEqual(h.entry().ids, ["shared"]);
  assert.equal(h.mod.getScheduleCoverage(h.entry(), query.from, query.to), "stale");
});
test("서버 전환은 이전 응답과 오류·성공 이력을 새 서버에 혼합하지 않음", async () => {
  const h = harness(); const a = h.cache.acquire(query); await tick(); const previousId = h.client.getServerId();
  h.setServer("https://other.example.invalid"); assert.equal(h.calls[0].signal.aborted, true);
  const b = h.cache.acquire(query); await tick(); h.calls[1].resolve(response([dto("new")])); await b.promise;
  h.calls[0].resolve(response([dto("old")])); await a.promise;
  assert.deepEqual(h.entry().ids, ["new"]); assert.equal(h.entry(query, previousId).hasSuccess, false);
});
test("세대 무효화는 mutation 이전 GET 반영을 차단하고 엔터티를 유지", async () => {
  const h = harness(); const a = h.cache.acquire(query); await tick(); h.calls[0].resolve(response([dto()])); await a.promise;
  const retry = h.cache.retry(query); await tick(); h.cache.invalidate();
  assert.equal(h.calls[1].signal.aborted, true);
  assert.equal(h.entry().status, "success"); assert.equal(h.entry().error, null); assert.equal(h.entry().hasSuccess, true);
  h.calls[1].resolve(response([dto("obsolete")])); await retry;
  assert.ok(h.data().entities.shared); assert.equal(h.data().entities.obsolete, undefined);
  assert.equal(h.entry().stale, true);
});
test("최초 GET의 mutation 무효화는 오류나 빈 성공 없이 idle·stale로 구분", async () => {
  const h = harness(), consumer = h.cache.acquire(query); await tick(); h.cache.invalidate();
  assert.equal(h.entry().status, "idle"); assert.equal(h.entry().hasSuccess, false); assert.equal(h.entry().stale, true); assert.equal(h.entry().error, null);
  h.calls[0].resolve(response([dto("obsolete")])); await consumer.promise;
  assert.equal(h.data().entities.obsolete, undefined); consumer.release();
});

test("최초 HTTP 실패는 빈 성공이 아니며 GET retry만 수행", async () => {
  const h = harness(); const a = h.cache.acquire(query); await tick();
  h.calls[0].resolve(new Response(JSON.stringify({ type: "test", title: "test", detail: "test", instance: "/schedules",
    status: 422, code: "INVALID_DATE_RANGE", requestId: "r" }), { status: 422, headers: { "Content-Type": "application/problem+json" } }));
  await a.promise; assert.equal(h.entry().hasSuccess, false); assert.equal(h.entry().error.problem.code, "INVALID_DATE_RANGE");
  const retry = h.cache.retry(query); await tick(); h.calls[1].resolve(response([])); await retry;
  assert.ok(h.calls.every((c) => c.method === "GET")); assert.equal(h.entry().hasSuccess, true);
});
test("재조회 loading·실패에도 마지막 성공 결과와 성공 이력 유지", async () => {
  const h = harness(); const a = h.cache.acquire(query); await tick(); h.calls[0].resolve(response([dto()])); await a.promise;
  const retry = h.cache.retry(query); await tick(); assert.equal(h.entry().status, "loading"); assert.deepEqual(h.entry().ids, ["shared"]);
  h.calls[1].resolve(new Response("bad", { status: 500 })); await retry;
  assert.equal(h.entry().status, "error"); assert.equal(h.entry().hasSuccess, true); assert.deepEqual(h.entry().ids, ["shared"]);
  assert.equal(h.entry().error.kind, "response");
});
test("성공 cache 재사용, 명시적 stale만 재요청하며 TTL 없음", async () => {
  const h = harness(); const a = h.cache.acquire(query); await tick(); h.calls[0].resolve(response([])); await a.promise; a.release();
  const b = h.cache.acquire(query); await b.promise; assert.equal(h.calls.length, 1);
  h.cache.invalidate(); const c = h.cache.acquire(query); await tick(); h.calls[1].resolve(response([])); await c.promise;
  assert.equal(h.calls.length, 2); b.release(); c.release();
});
test("설정 누락은 조회와 Mock fallback을 실행하지 않음", async () => {
  const h = harness(); h.setServer(undefined); const a = h.cache.acquire(query); await a.promise;
  assert.equal(h.cache.store.getState().serverId, null); assert.equal(h.calls.length, 0);
});
test("네트워크 오류는 Abort와 구분하고 기존 제한 retry만 사용", async () => {
  const h = harness({ timeout: true }); const a = h.cache.acquire(query); await a.promise;
  assert.equal(h.entry().error.kind, "network"); assert.equal(h.entry().hasSuccess, false);
});
test("Mock Hook과 서비스는 서버 cache에 직접 접근하지 않음", () => {
  for (const file of ["src/hooks/use-schedule-data.ts",
    "src/services/mock/assistant.ts", "src/stores/scheduleStore.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), /serverScheduleStore|useServerScheduleData/);
  }
});

test("timeout은 취소와 구분하며 두 시도 후 마지막 성공 결과 유지", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); const a = h.cache.acquire(query); await tick();
  h.calls[0].resolve(response([dto()])); await a.promise;
  const retry = a.retry(); await tick(); t.mock.timers.tick(10_000); await tick();
  t.mock.timers.tick(10_000); await retry;
  assert.equal(h.calls.length, 3); assert.equal(h.entry().error.kind, "timeout");
  assert.equal(h.entry().hasSuccess, true); assert.deepEqual(h.entry().ids, ["shared"]);
  assert.equal(h.entry().stale, true);
});
test("해제된 소비자는 Retry로 요청을 다시 시작하지 않음", async () => {
  const h = harness(); const a = h.cache.acquire(query); a.release(); await a.promise;
  await a.retry(); assert.equal(h.calls.length, 0); assert.equal(h.entry().error, null); assert.equal(h.entry().status, "idle");
});
test("원래 서버로 돌아와도 기존 cache는 stale로 재조회", async () => {
  const h = harness(); const a = h.cache.acquire(query); await tick();
  h.calls[0].resolve(response([dto()])); await a.promise; a.release();
  h.setServer("https://other.example.invalid"); h.setServer("https://example.invalid");
  assert.equal(h.entry().stale, true); const b = h.cache.acquire(query); await tick();
  assert.equal(h.calls.length, 2); h.calls[1].resolve(response([])); await b.promise;
  assert.deepEqual(h.entry().ids, []); assert.equal(h.entry().stale, false);
});
test("소수초 경계 밖은 coverage로 인정하지 않음", async () => {
  const h = harness(); const tiny = { from: "2026-11-01T00:00:00.000001Z", to: "2026-11-01T00:00:01Z" };
  const a = h.cache.acquire(tiny); await tick(); h.calls[0].resolve(response([])); await a.promise;
  assert.equal(h.mod.getScheduleCoverage(h.entry(tiny), "2026-11-01T00:00:00Z", tiny.to), "unknown");
});

test("비활성 Hook의 최초 렌더는 조회·empty·loading을 실행하지 않음", () => {
  const load = loader();
  const { useServerScheduleData } = load("src/hooks/use-server-schedule-data.ts");
  const React = require("react");
  const { renderToString } = require("react-dom/server");
  let result;
  function Probe() { result = useServerScheduleData(query); return null; }
  renderToString(React.createElement(Probe));
  assert.equal(result.initialLoading, false); assert.equal(result.empty, false);
  assert.equal(result.hasSuccessfulRead, false); assert.deepEqual(result.schedules, []);
  assert.equal(result.coverage(query.from, query.to), "unknown");
});
test("소비자의 조회 조건은 외부 객체 변경에도 고정됨", async () => {
  const h = harness(); const input = { ...query }; const a = h.cache.acquire(input); await tick();
  h.calls[0].resolve(response([])); await a.promise;
  input.from = month2.from; input.to = month2.to;
  const retry = a.retry(); await tick(); assert.equal(h.calls[1].url, h.calls[0].url);
  h.calls[1].resolve(response([])); await retry; a.release();
});

for (const scenario of ["equal", "reverse-registration", "missing", "outside", "filtered", "empty", "title", "completed", "category", "date", "mixed", "timestamp-only"]) {
  test(`35 store equality and completeness: ${scenario}`, async () => {
    const h = harness(), owners = [];
    const first = scenario === "reverse-registration" ? wide : query;
    const second = scenario === "reverse-registration" ? query : wide;
    const q = scenario === "filtered" ? { ...first, category: "INVENTORY" } : first;
    let latest = dto("shared"), extra = { ...dto("extra"), scheduledAt: "2026-11-20T00:00:00Z" };
    if (scenario === "outside") extra.scheduledAt = "2026-12-15T00:00:00Z";
    if (scenario === "filtered") extra.category = "OTHER";
    const newer = scenario === "empty" ? [] : [latest, ...(["missing", "outside", "filtered", "mixed"].includes(scenario) ? [extra] : [])];
    let older = scenario === "empty" ? [] : [{ ...latest }];
    if (scenario === "title") older[0].title = "과거";
    if (scenario === "completed") older[0].completed = true;
    if (scenario === "category") older[0].category = "OTHER";
    if (scenario === "date") older[0].scheduledAt = "2026-11-16T00:00:00Z";
    if (scenario === "mixed") older.push({ ...extra, title: "과거 다른 일정" });
    if (scenario === "timestamp-only") older[0].updatedAt = "2026-11-01T00:00:00.000001Z";
    try {
      owners.push(h.cache.acquire(q), h.cache.acquire(second)); await tick();
      h.calls[1].resolve(response(newer)); await owners[1].promise;
      const original = h.data().entities.shared, version = h.data().entityVersions.shared;
      h.calls[0].resolve(response(older)); await owners[0].promise;
      assert.strictEqual(h.data().entities.shared, original);
      assert.equal(h.data().entityVersions.shared, version);
      const stale = ["missing", "title", "completed", "category", "date", "mixed"].includes(scenario);
      assert.equal(h.entry(q).stale, stale);
      assert.equal(h.mod.getScheduleCoverage(h.entry(q), q.from, q.to), stale ? "stale" : "covered");
      assert.equal(h.entry(second).stale, false);
      assert.deepEqual(h.entry(second).ids, newer.map(s => s.id));
    } finally {
      owners.forEach(owner => owner.release());
      h.calls.forEach(call => call.resolve(response([]))); await tick();
    }
  });
}
// A starts first; B confirms S; C supplies newer membership evidence; A arrives last.
for (const scenario of ["absent", "other-id", "present", "outside", "category", "completed-false-excluded", "completed-true-excluded", "completed-false-missing", "completed-true-missing", "from", "to", "partial-from", "partial-to", "one-minute", "microseconds", "loading", "error", "stale", "replacement"]) {
  test(`35 membership evidence ${scenario}`, async () => {
    const h = harness(), owners = [];
    const item = { ...dto("shared"), scheduledAt: "2026-10-31T15:00:30.123456Z" };
    const aQuery = { from: "2026-10-01T00:00:00+09:00", to: "2026-12-01T00:00:00+09:00" };
    const bQuery = { from: "2026-10-15T00:00:00+09:00", to: "2026-12-01T00:00:00+09:00" };
    const cQuery = { ...query };
    if (scenario === "outside") cQuery.from = "2026-11-02T00:00:00+09:00";
    if (scenario === "category") cQuery.category = "OTHER";
    if (scenario.startsWith("completed-")) {
      cQuery.completed = scenario.includes("true");
      item.completed = scenario.endsWith("missing") ? cQuery.completed : !cQuery.completed;
    }
    if (scenario === "to") { cQuery.from = "2026-10-31T14:00:00Z"; cQuery.to = "2026-10-31T15:00:00Z"; }
    if (scenario === "partial-from") cQuery.from = "2026-10-31T15:00:00.000001Z";
    if (scenario === "partial-to") { cQuery.from = "2026-10-31T14:00:00Z"; cQuery.to = "2026-10-31T15:00:59.999999Z"; }
    if (scenario === "one-minute") cQuery.to = "2026-10-31T15:01:00Z";
    const ignored = ["present", "outside", "category", "completed-false-excluded", "completed-true-excluded", "to", "partial-from", "partial-to", "loading", "error", "stale", "replacement"].includes(scenario);
    try {
      owners.push(h.cache.acquire(aQuery)); await tick();
      owners.push(h.cache.acquire(bQuery)); await tick();
      h.calls[1].resolve(response([item])); await owners[1].promise;
      owners.push(h.cache.acquire(cQuery)); await tick();
      assert.deepEqual([h.entry(aQuery).sequence, h.entry(bQuery).sequence, h.entry(cQuery).sequence], [1, 2, 3]);
      if (scenario !== "loading") {
        h.calls[2].resolve(scenario === "error" ? new Response("broken", { status: 200 }) : response(scenario === "present" ? [{ ...item }] : scenario === "other-id" ? [{ ...dto("other"), scheduledAt: item.scheduledAt }] : []));
        await owners[2].promise;
      }
      if (scenario === "stale") {
        // A later actual read changes an entity in C, making C stale without direct state injection.
        // Empty C cannot be invalidated through an entity, so retry it and release the last consumer.
        const retry = owners[2].retry(); await tick(); owners[2].release(); await retry;
      }
      if (scenario === "replacement") { void owners[2].retry(); await tick(); }
      const saved = h.data().entities.shared, version = h.data().entityVersions.shared;
      const cIds = [...h.entry(cQuery).ids];
      h.calls[0].resolve(response([{ ...item }])); await owners[0].promise;
      assert.strictEqual(h.data().entities.shared, saved); assert.equal(h.data().entityVersions.shared, version);
      assert.deepEqual(h.entry(cQuery).ids, cIds);
      assert.equal(h.entry(aQuery).stale, !ignored);
      assert.equal(h.mod.getScheduleCoverage(h.entry(aQuery), aQuery.from, aQuery.to), ignored ? "covered" : "stale");
    } finally {
      owners.forEach(owner => owner.release());
      h.calls.forEach(call => call.resolve(response([]))); await tick();
    }
  });
}
for (const completed of [false, true]) for (const included of [false, true]) {
  test(`35 forward membership completed=${completed} included=${included}`, async () => {
    const h = harness(), q = { ...query, completed }, owners = [];
    try {
      owners.push(h.cache.acquire(q), h.cache.acquire(wide)); await tick();
      h.calls[1].resolve(response([{ ...dto("extra"), completed: included ? completed : !completed }])); await owners[1].promise;
      h.calls[0].resolve(response([])); await owners[0].promise;
      assert.equal(h.entry(q).stale, included);
      assert.equal(h.entry(wide).stale, false);
    } finally { owners.forEach(o => o.release()); h.calls.forEach(c => c.resolve(response([]))); await tick(); }
  });
}

for (const barrier of ["invalidate", "mutation", "connection", "same-query-replacement"]) {
  test(`35 membership evidence barrier ${barrier}`, async () => {
    const h = harness(), owners = [];
    try {
      const a = h.cache.acquire(query); owners.push(a); await tick();
      const b = h.cache.acquire(wide); owners.push(b); await tick();
      h.calls[1].resolve(response([])); await b.promise;
      if (barrier === "connection") {
        h.setServer("https://other.example.invalid"); h.setServer("https://example.invalid");
      } else if (barrier === "mutation") {
        h.cache.applyScheduleResult(h.client.getServerId(), h.load("src/utils/schedule-mapper.ts").scheduleDtoToSchedule(dto()));
      } else if (barrier === "same-query-replacement") {
        a.release();
      } else h.cache.invalidate();
      const fresh = h.cache.acquire(query); owners.push(fresh); await tick();
      const next = h.calls.at(-1); assert.notStrictEqual(next, h.calls[0]);
      next.resolve(response([dto("current")])); await fresh.promise;
      const saved = h.entry(), entity = h.data().entities.current;
      h.calls[0].resolve(response([dto("obsolete")])); await a.promise; await tick();
      assert.strictEqual(h.entry(), saved); assert.strictEqual(h.data().entities.current, entity);
      assert.equal(h.data().entities.obsolete, undefined);
      assert.equal(h.entry().stale, false);
      assert.deepEqual(h.entry().ids, ["current"]);
    } finally { owners.forEach(o => o.release()); h.calls.forEach(c => c.resolve(response([]))); await tick(); }
  });
}