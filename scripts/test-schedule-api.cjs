/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");

// 설치된 TypeScript로 소스를 메모리에서만 변환한다. 기본 fetch는 실제 통신을 금지한다.
function loadSource(file, timers = { setTimeout, clearTimeout }) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: filename,
    }).outputText;
    const resolve = (name) => {
      assert.ok(name.startsWith("@/"), "앱 내부 순수 모듈만 로드한다.");
      return load(path.join(root, "src", `${name.slice(2)}.ts`));
    };
    new Function(
      "require",
      "module",
      "exports",
      "fetch",
      "setTimeout",
      "clearTimeout",
      code,
    )(
      resolve,
      module,
      module.exports,
      () => {
        throw new Error("실제 네트워크 요청은 금지되어 있습니다.");
      },
      timers.setTimeout,
      timers.clearTimeout,
    );
    return module.exports;
  }
  return load(path.join(root, file));
}

const configModule = loadSource("src/services/api/config.ts");
const queryModule = loadSource("src/utils/schedule-query.ts");
const ready = configModule.parseDevelopmentServerConfig(
  "https://example.invalid",
);
const baseQuery = {
  from: "2026-11-01T00:00:00+09:00",
  to: "2026-12-01T00:00:00+09:00",
};
const dto = {
  id: "11111111-1111-5111-8111-111111111111",
  title: "test",
  category: "INVENTORY",
  scheduledAt: "2026-11-07T15:00:00Z",
  completed: false,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
};
const problem = (status, code) => ({
  type: "https://example.invalid/problem",
  title: "test",
  status,
  code,
  detail: "test",
  instance: "/api/v1/schedules",
  requestId: "body-request-id",
});
const json = (body, status = 200, mediaType = "application/json") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": mediaType, "X-Request-ID": "header-request-id" },
  });
function harness(fetchImpl, timers) {
  const http = loadSource("src/services/api/http.ts", timers);
  const state = { config: ready, calls: [] };
  const client = http.createScheduleHttpClient({
    readConfig: () => state.config,
    fetchImpl: (...args) => {
      state.calls.push(args);
      return fetchImpl(...args);
    },
  });
  return { ...http, state, client };
}
const createService = (client) =>
  loadSource("src/services/api/schedules.ts").createScheduleService(client);
const flush = () => new Promise(setImmediate);
function fakeTimers() {
  let sequence = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, ms) {
      assert.equal(ms, 10_000);
      const id = ++sequence;
      pending.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire() {
      const [id, fn] = pending.entries().next().value;
      pending.delete(id);
      fn();
    },
  };
}

test("query: UTC 정규화·category·completed·offset 인코딩·소수초 보존", () => {
  const params = queryModule.buildScheduleListQuery({
    ...baseQuery,
    category: "INBOUND",
    completed: false,
  });
  assert.equal(params.get("from"), "2026-10-31T15:00:00.000Z");
  assert.equal(params.get("to"), "2026-11-30T15:00:00.000Z");
  assert.equal(params.get("category"), "INBOUND");
  assert.equal(params.get("completed"), "false");
  assert.equal(
    queryModule
      .buildScheduleListQuery({ ...baseQuery, completed: true })
      .get("completed"),
    "true",
  );
  assert.deepEqual(
    [...queryModule.buildScheduleListQuery(baseQuery).keys()],
    ["from", "to"],
  );
  for (const category of [
    "INBOUND",
    "INVENTORY",
    "OUTBOUND",
    "RETURN",
    "OTHER",
  ]) {
    assert.equal(
      queryModule
        .buildScheduleListQuery({ ...baseQuery, category })
        .get("category"),
      category,
    );
  }
  const small = queryModule.buildScheduleListQuery({
    from: "2026-11-01T00:00:00.123456Z",
    to: "2026-11-01T00:00:00.123457Z",
  });
  assert.equal(small.get("from"), "2026-11-01T00:00:00.123456Z");
  assert.equal(small.get("to"), "2026-11-01T00:00:00.123457Z");
  assert.match(new URLSearchParams(baseQuery).toString(), /%2B09%3A00/);
});

test("query: 정확히 92일 허용·역전·초과·잘못된 입력 차단", () => {
  assert.doesNotThrow(() =>
    queryModule.buildScheduleListQuery({
      from: "2026-11-07T00:00:00Z",
      to: "2027-02-07T00:00:00Z",
    }),
  );
  for (const query of [
    { from: baseQuery.from, to: baseQuery.from },
    { from: baseQuery.to, to: baseQuery.from },
    { from: "2026-11-07T00:00:00Z", to: "2027-02-07T00:00:00.000001Z" },
    { ...baseQuery, from: "2026-11-01T00:00:00" },
    { ...baseQuery, from: "2026-02-30T00:00:00Z" },
    { ...baseQuery, category: "PICKING" },
    { ...baseQuery, completed: "false" },
    { ...baseQuery, from: "2026-11-01T00:00:00Z\n" },
  ])
    assert.throws(() => queryModule.buildScheduleListQuery(query), RangeError);
});

test("range: 연말·윤년·서울 월 경계와 모든 월의 92일 제한", () => {
  assert.deepEqual(
    queryModule.getMainScheduleRange(new Date("2026-12-31T15:00:00Z")),
    {
      from: "2026-11-30T15:00:00.000Z",
      to: "2027-02-28T15:00:00.000Z",
    },
  );
  assert.deepEqual(queryModule.getCalendarScheduleRange("2024-02-01"), {
    from: "2024-01-31T15:00:00.000Z",
    to: "2024-02-29T15:00:00.000Z",
  });
  for (const month of ["2024-01", "2024-12", "2026-02", "2026-12"]) {
    assert.doesNotThrow(() =>
      queryModule.buildScheduleListQuery(
        queryModule.getCalendarScheduleRange(month),
      ),
    );
  }
  for (const year of [2024, 2026])
    for (let month = 1; month <= 12; month++) {
      const now = new Date(
        `${year}-${String(month).padStart(2, "0")}-15T00:00:00Z`,
      );
      assert.doesNotThrow(() =>
        queryModule.buildScheduleListQuery(
          queryModule.getMainScheduleRange(now),
        ),
      );
    }
  for (const month of ["2026-13", "2026-01-02", "2026-1", "2026-01\n"]) {
    assert.throws(
      () => queryModule.getCalendarScheduleRange(month),
      RangeError,
    );
  }
});

test("range: 단말 시간대와 무관한 계산", () => {
  const expected = queryModule.getMainScheduleRange(
    new Date("2026-12-31T15:00:00Z"),
  );
  for (const TZ of ["UTC", "America/New_York", "Asia/Seoul"]) {
    const code = `const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),assert=require('node:assert/strict');
      const root=${JSON.stringify(root)};const m=(${loadSource.toString()})('src/utils/schedule-query.ts');
      console.log(JSON.stringify(m.getMainScheduleRange(new Date('2026-12-31T15:00:00Z'))));`;
    const result = spawnSync(process.execPath, ["-e", code], {
      env: { ...process.env, TZ },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});

test("목록·단건: URL·순서·기존 mapper·UUID v5·빈 목록", async () => {
  const h = harness(async () =>
    json({ items: [dto, { ...dto, id: "second", title: "second" }] }),
  );
  const service = createService(h.client);
  const result = await service.listSchedules({
    ...baseQuery,
    completed: false,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.data.map((s) => s.id),
    [dto.id, "second"],
  );
  assert.equal(result.data[0].date, "2026-11-08");
  assert.equal(result.data[0].time, "00:00");
  assert.equal("createdAt" in result.data[0], false);
  assert.equal(result.requestId, "header-request-id");
  const url = new URL(h.state.calls[0][0]);
  assert.equal(url.pathname, "/api/v1/schedules");
  assert.equal(url.searchParams.get("completed"), "false");
  const empty = harness(async () => json({ items: [] }));
  assert.deepEqual(
    (await createService(empty.client).listSchedules(baseQuery)).data,
    [],
  );
  const single = harness(async () => json(dto));
  assert.equal(
    (await createService(single.client).getSchedule(dto.id)).data.id,
    dto.id,
  );
  await createService(single.client).getSchedule("a/b ?#%");
  assert.equal(
    single.state.calls[1][0],
    "https://example.invalid/api/v1/schedules/a%2Fb%20%3F%23%25",
  );
});

test("조회 입력·응답 검증: 실패를 빈 목록으로 대체하지 않음", async () => {
  for (const body of [
    {},
    [],
    { items: null },
    { items: [{}] },
    { items: [{ ...dto, completed: "false" }] },
    { items: [{ ...dto, createdAt: "bad" }] },
    { items: [{ ...dto, category: "PICKING" }] },
  ]) {
    const h = harness(async () => json(body));
    assert.equal(
      (await createService(h.client).listSchedules(baseQuery)).error.kind,
      "response",
    );
  }
  for (const body of [
    null,
    {},
    { ...dto, updatedAt: "bad" },
    { ...dto, scheduledAt: "bad" },
  ]) {
    assert.equal(
      (
        await createService(harness(async () => json(body)).client).getSchedule(
          dto.id,
        )
      ).error.kind,
      "response",
    );
  }
  const h = harness(async () => {
    throw new TypeError();
  });
  const service = createService(h.client);
  assert.equal(
    (await service.listSchedules({ ...baseQuery, completed: "false" })).error
      .kind,
    "request",
  );
  assert.equal((await service.getSchedule("..")).error.kind, "request");
  assert.equal(h.state.calls.length, 0);
  assert.equal((await service.listSchedules(baseQuery)).error.kind, "network");
  assert.equal(h.state.calls.length, 2);
});

test("HTTP: 204는 body를 읽지 않고 조회 서비스는 200만 허용", async () => {
  const h = harness(async () => ({
    status: 204,
    ok: true,
    headers: new Headers(),
    text() {
      throw new Error("본문을 읽으면 안 됨");
    },
  }));
  const result = await h.client.request({ path: "/schedules" });
  assert.equal(result.ok, true);
  assert.equal(result.data, undefined);
  assert.equal(
    (await createService(h.client).listSchedules(baseQuery)).error.kind,
    "response",
  );
  assert.equal(
    (
      await createService(
        harness(async () => json(dto, 201)).client,
      ).getSchedule(dto.id)
    ).error.kind,
    "response",
  );
});

test("HTTP: Problem Details·두 requestId·validation 필드·404 code 구분", async () => {
  for (const code of ["SCHEDULE_NOT_FOUND", "ROUTE_NOT_FOUND"]) {
    const h = harness(async () =>
      json(problem(404, code), 404, "application/problem+json"),
    );
    const result = await createService(h.client).getSchedule(dto.id);
    assert.equal(result.error.kind, "http");
    assert.equal(result.error.status, 404);
    assert.equal(result.error.problem.code, code);
    assert.equal(result.error.problem.requestId, "body-request-id");
    assert.equal(result.error.requestId, "header-request-id");
    assert.equal(h.state.calls.length, 1);
  }
  const errors = [
    { location: "body", pointer: "/title", code: "REQUIRED", detail: "test" },
    {
      location: "query",
      parameter: "from",
      code: "INVALID_FORMAT",
      detail: "test",
    },
    {
      location: "header",
      parameter: "Idempotency-Key",
      code: "REQUIRED",
      detail: "test",
    },
    {
      location: "path",
      parameter: "scheduleId",
      code: "INVALID_FORMAT",
      detail: "test",
    },
  ];
  const h = harness(async () =>
    json(
      { ...problem(422, "VALIDATION_ERROR"), errors },
      422,
      "application/problem+json; charset=utf-8",
    ),
  );
  assert.deepEqual(
    (await h.client.request({ path: "/schedules" })).error.problem.errors,
    errors,
  );
  assert.equal(h.parseProblemDetails(problem(422, "VALIDATION_ERROR")), null);
  const mismatch = harness(async () =>
    json(problem(500, "INTERNAL_ERROR"), 404, "application/problem+json"),
  );
  const result = await mismatch.client.request({ path: "/schedules" });
  assert.equal(result.error.kind, "response");
  assert.equal(result.error.status, 404);
  assert.equal(result.error.problem.status, 500);
});

test("HTTP: 4xx·409·500는 재시도하지 않고 503은 최대 1회", async () => {
  for (const status of [400, 404, 409, 422, 500]) {
    const h = harness(async () =>
      json(problem(status, "test"), status, "application/problem+json"),
    );
    assert.equal((await h.client.request({ path: "/schedules" })).attempts, 1);
  }
  const h = harness(async () =>
    json(problem(503, "DATABASE_UNAVAILABLE"), 503, "application/problem+json"),
  );
  assert.equal((await h.client.request({ path: "/schedules" })).attempts, 2);
  let count = 0;
  const recovery = harness(async () =>
    ++count === 1
      ? json(
          problem(503, "DATABASE_UNAVAILABLE"),
          503,
          "application/problem+json",
        )
      : json({ items: [] }),
  );
  assert.equal(
    (await recovery.client.request({ path: "/schedules" })).ok,
    true,
  );
  assert.equal(recovery.state.calls.length, 2);
});

test("HTTP: 비JSON·깨진 JSON·200 Problem·잘못된 Problem은 형식 오류", async () => {
  for (const response of [
    () => new Response("<html/>", { headers: { "Content-Type": "text/html" } }),
    () =>
      new Response("{", { headers: { "Content-Type": "application/json" } }),
    () => json(problem(500, "INTERNAL_ERROR"), 200, "application/problem+json"),
    () => json({}, 422, "application/problem+json"),
  ]) {
    const h = harness(async () => response());
    assert.equal(
      (await h.client.request({ path: "/schedules" })).error.kind,
      "response",
    );
    assert.equal(h.state.calls.length, 1);
  }
});

test("HTTP: 설정 누락·잘못된 설정·중복 API 경로는 전송 전에 차단", async () => {
  const h = harness(async () => json({}));
  for (const status of ["missing", "invalid"]) {
    h.state.config = { status };
    const result = await h.client.request({ path: "/schedules" });
    assert.equal(result.error.kind, "configuration");
    assert.equal(result.error.configurationStatus, status);
  }
  h.state.config = ready;
  for (const path of [
    "/api/v1/schedules",
    "//other.invalid",
    "/schedules/../health",
    "/schedules\n",
  ]) {
    assert.equal((await h.client.request({ path })).error.kind, "request");
  }
  assert.equal(h.state.calls.length, 0);
});

test("HTTP: future retry에서도 URL·body·전달된 header snapshot을 보존", async () => {
  let count = 0;
  const body = { title: "first" };
  const headers = { "Idempotency-Key": "test-only" };
  const h = harness(async () => {
    if (++count === 1) {
      body.title = "edited";
      headers["Idempotency-Key"] = "edited";
      throw new TypeError();
    }
    return json({});
  });
  assert.equal(
    (
      await h.client.request({
        method: "POST",
        path: "/schedules",
        body,
        headers,
      })
    ).ok,
    true,
  );
  assert.equal(h.state.calls[0][0], h.state.calls[1][0]);
  for (const [, init] of h.state.calls) {
    assert.equal(init.body, '{"title":"first"}');
    assert.equal(init.headers.get("Idempotency-Key"), "test-only");
    assert.equal(init.headers.get("Content-Type"), "application/json");
  }
});

test("HTTP: timeout은 시도별 10초·최대 2회, timer와 listener 정리", async () => {
  const clock = fakeTimers();
  const h = harness(() => new Promise(() => {}), clock);
  const pending = h.client.request({ path: "/schedules" });
  assert.equal(h.state.calls.length, 1);
  clock.fire();
  await flush();
  assert.equal(h.state.calls.length, 2);
  assert.equal(h.state.calls[0][1].signal.aborted, true);
  clock.fire();
  const result = await pending;
  assert.equal(result.error.kind, "timeout");
  assert.equal(result.error.requestState, "unconfirmed");
  assert.equal(result.attempts, 2);
  assert.equal(clock.pending.size, 0);
});

test("HTTP: body 수신에도 timeout을 적용하고 이미 받은 500은 재전송하지 않음", async () => {
  const clock = fakeTimers();
  const h = harness(
    async () => ({
      status: 500,
      ok: false,
      headers: new Headers({ "Content-Type": "application/problem+json" }),
      text: () => new Promise(() => {}),
    }),
    clock,
  );
  const pending = h.client.request({ path: "/schedules" });
  await flush();
  clock.fire();
  assert.equal((await pending).error.kind, "timeout");
  assert.equal(h.state.calls.length, 1);
});

test("HTTP: 시작 전·처리 중·retry 직전의 호출자 Abort는 재시도하지 않음", async () => {
  const controller = new AbortController();
  const h = harness(() => new Promise(() => {}));
  const pending = h.client.request({
    path: "/schedules",
    signal: controller.signal,
  });
  controller.abort();
  assert.equal((await pending).error.kind, "aborted");
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.calls[0][1].signal.aborted, true);
  assert.equal(
    (await h.client.request({ path: "/schedules", signal: controller.signal }))
      .attempts,
    0,
  );
  const other = new AbortController();
  const retry = harness(async () => {
    other.abort();
    throw new TypeError();
  });
  assert.equal(
    (await retry.client.request({ path: "/schedules", signal: other.signal }))
      .error.kind,
    "aborted",
  );
  assert.equal(retry.state.calls.length, 1);
});

test("HTTP: 서버 변경 후 응답 무효화와 retry 중단", async () => {
  for (const fails of [false, true]) {
    const h = harness(async () => {
      h.state.config = configModule.parseDevelopmentServerConfig(
        "https://other.invalid",
      );
      if (fails) throw new TypeError();
      return json({ items: [] });
    });
    assert.equal(
      (await h.client.request({ path: "/schedules" })).error.kind,
      "aborted",
    );
    assert.equal(h.state.calls.length, 1);
  }
});

test("HTTP: 동일 설정 객체가 변경돼도 원래 서버 snapshot과 분리", async () => {
  const original = configModule.parseDevelopmentServerConfig(
    "https://example.invalid",
  );
  const h = harness(async () => {
    h.state.config.config.serverId = "changed";
    h.state.config.config.apiBaseUrl = "https://other.invalid/api/v1";
    return json({ items: [] });
  });
  h.state.config = original;
  const result = await h.client.request({ path: "/schedules" });
  assert.equal(result.error.kind, "aborted");
  assert.equal(result.error.status, 200);
  assert.equal(result.error.requestId, "header-request-id");
  assert.equal(h.state.calls.length, 1);
});

test("HTTP: 비표준 503도 1회만 재시도하고 정상 완료 시 timer 정리", async () => {
  const clock = fakeTimers();
  const h = harness(
    async () => new Response("unavailable", { status: 503 }),
    clock,
  );
  const result = await h.client.request({ path: "/schedules" });
  assert.equal(result.error.kind, "response");
  assert.equal(result.error.status, 503);
  assert.equal(result.attempts, 2);
  assert.equal(clock.pending.size, 0);
});

test("HTTP: 응답 본문 수신 중 호출자 취소와 늦은 응답 무시", async () => {
  const controller = new AbortController();
  let resolveBody;
  const h = harness(async () => ({
    status: 200,
    ok: true,
    headers: new Headers({
      "Content-Type": "application/json",
      "X-Request-ID": "trace",
    }),
    text: () =>
      new Promise((resolve) => {
        resolveBody = resolve;
      }),
  }));
  const pending = h.client.request({
    path: "/schedules",
    signal: controller.signal,
  });
  await flush();
  controller.abort();
  const result = await pending;
  assert.equal(result.error.kind, "aborted");
  assert.equal(result.error.requestId, "trace");
  resolveBody('{"items":[]}');
  await flush();
  assert.equal(result.ok, false);
  assert.equal(h.state.calls.length, 1);
});
