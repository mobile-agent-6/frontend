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
      // Expo native 모듈을 로드하지 않고 기존 UUID API만 Node 구현으로 대체한다.
      if (name === "expo-crypto") return { randomUUID: require("node:crypto").randomUUID };
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
const createService = (client, options) =>
  loadSource("src/services/api/schedules.ts").createScheduleService(client, options);
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

const createInput = { title: "  test  ", scheduledAt: "2026-11-07T00:00:00+09:00", category: "INVENTORY" };
function prepared(service, input = createInput) {
  const result = service.prepareScheduleCreation(input);
  assert.equal(result.ok, true);
  return result.operation;
}
function createdResponse(replayed = false, body = dto) {
  const response = json(body, 201);
  response.headers.set("Location", `/api/v1/schedules/${dto.id}`);
  if (replayed) response.headers.set("Idempotent-Replayed", "true");
  return response;
}

test("POST: 허용 필드만 전송·서버 ID·201·응답 메타데이터·mapper 연결", async () => {
  const h = harness(async () => createdResponse());
  const input = { ...createInput, id: "local", completed: true, createdAt: "bad", updatedAt: "bad",
    reminderAt: "bad", reminderMinutesBefore: 10, notificationEnabled: true };
  const op = prepared(createService(h.client), input);
  assert.match(op.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const result = await op.submit();
  assert.equal(result.outcome, "created");
  assert.equal(result.response.status, 201);
  assert.equal(result.response.data.id, dto.id);
  assert.equal(result.response.data.date, "2026-11-08");
  assert.equal(result.response.location, `/api/v1/schedules/${dto.id}`);
  assert.equal(result.response.idempotentReplayed, null);
  assert.equal(result.response.requestId, "header-request-id");
  assert.equal(h.state.calls.length, 1);
  const [url, init] = h.state.calls[0];
  assert.equal(url, "https://example.invalid/api/v1/schedules");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.get("Content-Type"), "application/json");
  assert.equal(init.headers.get("Idempotency-Key"), op.idempotencyKey);
  assert.deepEqual(JSON.parse(init.body), { ...createInput, title: "test" });
  assert.deepEqual(await op.submit(), result);
  assert.equal(h.state.calls.length, 1, "성공한 생성 작업을 다시 실행하지 않는다.");
});

test("POST: 새 작업은 새 key·동일 작업의 변경 불가 snapshot·동시 submit 중복 방지", async () => {
  let resolve;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  const service = createService(h.client);
  const input = { ...createInput };
  const first = prepared(service, input);
  const second = prepared(service);
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
  input.title = "edited";
  input.scheduledAt = "2027-01-01T00:00:00Z";
  assert.equal(Reflect.set(first.payload, "title", "other"), false);
  assert.equal(Reflect.set(first, "idempotencyKey", second.idempotencyKey), false);
  const pending = first.submit();
  assert.equal(first.submit(), pending);
  assert.equal(h.state.calls.length, 1);
  resolve(createdResponse());
  assert.equal((await pending).outcome, "created");
  assert.deepEqual(JSON.parse(h.state.calls[0][1].body), { ...createInput, title: "test" });
});

test("POST: 네트워크 자동 retry와 미확인 작업 수동 retry에서 key·body 유지", async () => {
  let count = 0;
  let keyCalls = 0;
  const h = harness(async () => {
    if (++count <= 2) throw new TypeError("유실");
    return createdResponse(true);
  });
  const op = prepared(createService(h.client, {
    createIdempotencyKey: () => { keyCalls++; return require("node:crypto").randomUUID(); },
  }));
  const first = await op.submit();
  assert.equal(first.outcome, "uncertain");
  assert.equal(first.error.kind, "network");
  assert.equal(first.requiresReconciliation, true);
  assert.equal(first.attempts, 2);
  const second = await op.submit();
  assert.equal(second.outcome, "replayed");
  assert.equal(second.response.idempotentReplayed, "true");
  assert.equal(keyCalls, 1);
  assert.equal(h.state.calls.length, 3);
  for (const [, init] of h.state.calls) {
    assert.equal(init.headers.get("Idempotency-Key"), op.idempotencyKey);
    assert.equal(init.body, h.state.calls[0][1].body);
  }
});

test("POST: 단일 자동 retry 뒤 replay 201이면 성공 확정", async () => {
  let count = 0;
  const h = harness(async () => {
    if (++count === 1) throw new TypeError();
    return createdResponse(true);
  });
  const result = await prepared(createService(h.client)).submit();
  assert.equal(result.outcome, "replayed");
  assert.equal(result.response.attempts, 2);
  assert.equal(result.response.data.id, dto.id);
});

test("POST: 409·422·그 외 4xx 거절 뒤 새 key 발급·POST 재실행 금지", async () => {
  for (const [status, code] of [[409, "IDEMPOTENCY_KEY_CONFLICT"], [422, "SCHEDULE_IN_THE_PAST"],
    [422, "VALIDATION_ERROR"], [400, "MALFORMED_REQUEST"], [404, "ROUTE_NOT_FOUND"]]) {
    let keys = 0;
    const body = problem(status, code);
    if (code === "VALIDATION_ERROR") body.errors = [{ location: "body", pointer: "/title", code: "UNKNOWN_FIELD", detail: "test" }];
    const h = harness(async () => json(body, status, "application/problem+json"));
    const op = prepared(createService(h.client, { createIdempotencyKey: () => {
      keys++; return require("node:crypto").randomUUID();
    } }));
    const result = await op.submit();
    assert.equal(result.outcome, "rejected");
    assert.equal(result.error.problem.code, code);
    assert.equal(result.requiresReconciliation, status === 409 || status === 422);
    assert.deepEqual(await op.submit(), result);
    assert.equal(h.state.calls.length, 1);
    assert.equal(keys, 1);
  }
});

test("POST: 앞선 유실 뒤 4xx가 와도 이전 write 미실행으로 단정하지 않음", async () => {
  let count = 0;
  const h = harness(async () => {
    if (++count === 1) throw new TypeError();
    return json(problem(422, "SCHEDULE_IN_THE_PAST"), 422, "application/problem+json");
  });
  const op = prepared(createService(h.client));
  const result = await op.submit();
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.error.unconfirmedAttempt, true);
  assert.equal(result.error.problem.code, "SCHEDULE_IN_THE_PAST");
  await op.submit();
  assert.equal(h.state.calls.length, 2);
});

test("POST: timeout 및 503은 최대 2회 뒤에도 결과 불확실", async () => {
  const clock = fakeTimers();
  const h = harness(() => new Promise(() => {}), clock);
  const pending = prepared(createService(h.client)).submit();
  clock.fire(); await flush(); clock.fire();
  const result = await pending;
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.error.kind, "timeout");
  assert.equal(result.attempts, 2);
  const down = harness(async () => json(problem(503, "DATABASE_UNAVAILABLE"), 503, "application/problem+json"));
  const unavailable = await prepared(createService(down.client)).submit();
  assert.equal(unavailable.outcome, "uncertain");
  assert.equal(unavailable.attempts, 2);
  const serverError = harness(async () => json(problem(500, "INTERNAL_ERROR"), 500, "application/problem+json"));
  assert.equal((await prepared(createService(serverError.client)).submit()).outcome, "uncertain");
  assert.equal(serverError.state.calls.length, 1);
});

test("POST: 전송 전 Abort는 미전송, 전송 후 Abort는 미확인", async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness(() => new Promise(() => {}));
  const op = prepared(createService(h.client));
  assert.equal((await op.submit(controller.signal)).outcome, "not-sent");
  assert.equal(op.firstAttemptAt, null);
  assert.equal(h.state.calls.length, 0);
  const running = new AbortController();
  const pending = op.submit(running.signal);
  running.abort();
  assert.equal((await pending).outcome, "uncertain");
  assert.equal(h.state.calls.length, 1);
});

test("POST: 원래 서버에 묶인 수동 retry와 설정 누락 구분", async () => {
  const h = harness(async () => { throw new TypeError(); });
  const op = prepared(createService(h.client));
  assert.equal((await op.submit()).outcome, "uncertain");
  const count = h.state.calls.length;
  h.state.config = configModule.parseDevelopmentServerConfig("https://other.invalid");
  const retry = await op.submit();
  assert.equal(retry.outcome, "uncertain");
  assert.equal(retry.error.kind, "aborted");
  assert.equal(retry.attempts, 0);
  assert.equal(h.state.calls.length, count);
  const missing = harness(async () => createdResponse());
  missing.state.config = { status: "missing" };
  const unsent = prepared(createService(missing.client));
  const result = await unsent.submit();
  assert.equal(result.outcome, "not-sent");
  assert.equal(result.error.kind, "configuration");
  assert.equal(unsent.firstAttemptAt, null);
});

test("POST: 서버 설정이 전송 중 바뀌면 결과 확인 필요", async () => {
  const h = harness(async () => {
    h.state.config = configModule.parseDevelopmentServerConfig("https://other.invalid");
    return createdResponse();
  });
  const result = await prepared(createService(h.client)).submit();
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.error.kind, "aborted");
  assert.equal(result.error.status, 201);
  assert.equal(result.error.location, `/api/v1/schedules/${dto.id}`);
});

test("POST: 24시간 뒤 무기한 멱등성을 가정해 재전송하지 않음", async () => {
  let timestamp = 100;
  const h = harness(async () => { throw new TypeError(); });
  const op = prepared(createService(h.client, { now: () => timestamp }));
  await op.submit();
  assert.equal(op.firstAttemptAt, 100);
  timestamp += 24 * 60 * 60 * 1000;
  const result = await op.submit();
  assert.equal(result.outcome, "review-required");
  assert.equal(result.error.reason, "retention-window");
  assert.equal(h.state.calls.length, 2);
});

test("POST: 201 DTO·status·replay header 오류는 별도 확인 필요", async () => {
  for (const response of [
    () => createdResponse(false, {}), () => json(dto, 200), () => createdResponse(false, { ...dto, completed: "false" }),
    () => createdResponse(false, { ...dto, scheduledAt: "bad" }),
    () => { const value = createdResponse(); value.headers.set("Idempotent-Replayed", "false"); return value; },
  ]) {
    const h = harness(async () => response());
    const result = await prepared(createService(h.client)).submit();
    assert.equal(result.outcome, "review-required");
    assert.equal(result.error.kind, "response");
    assert.equal(result.requiresReconciliation, true);
    assert.equal(h.state.calls.length, 1);
  }
});

test("POST 입력: Unicode code point·trim·제어문자·날짜·category 검증", () => {
  let keys = 0;
  const h = harness(async () => createdResponse());
  const service = createService(h.client, { createIdempotencyKey: () => {
    keys++; return require("node:crypto").randomUUID();
  } });
  const emoji = String.fromCodePoint(0x1f600);
  assert.equal(prepared(service, { ...createInput, title: emoji.repeat(100) }).payload.title.length, 200);
  for (const title of [" ", "a".repeat(101), emoji.repeat(101), "a\nb", "a\tb", "a\0b", "a\u0085b"]) {
    const result = service.prepareScheduleCreation({ ...createInput, title });
    assert.equal(result.error.kind, "validation");
    assert.ok(result.error.fields.title);
  }
  for (const scheduledAt of ["2026-11-07T00:00:00", "2026-02-30T00:00:00Z", "2026-11-07T00:00:00.1234567Z", "2026-11-07 00:00:00+09:00"]) {
    assert.ok(service.prepareScheduleCreation({ ...createInput, scheduledAt }).error.fields.scheduledAt);
  }
  for (const category of ["PICKING", "MEETING", "PERSONAL", "inbound"]) {
    assert.ok(service.prepareScheduleCreation({ ...createInput, category }).error.fields.category);
  }
  assert.equal(keys, 1, "입력 검증 실패 시 key를 생성하지 않는다.");
  assert.equal(h.state.calls.length, 0);
  // 과거 여부는 서버가 판정한다. 전화기 현재 시각으로 차단하지 않는다.
  assert.equal(service.prepareScheduleCreation({ ...createInput, scheduledAt: "2025-01-01T00:00:00.123456-03:00" }).ok, true);
});

test("POST: key 생성 예외·서버 validation·직렬화 오류를 구분", async () => {
  const h = harness(async () => createdResponse());
  const service = createService(h.client, { createIdempotencyKey: () => { throw new Error(); } });
  assert.equal(service.prepareScheduleCreation(createInput).error.kind, "key-generation");
  const circular = {}; circular.self = circular;
  const serialized = await h.client.request({ method: "POST", path: "/schedules", body: circular });
  assert.equal(serialized.error.kind, "request");
  assert.equal(serialized.error.requestState, "not-sent");
  assert.equal(h.state.calls.length, 0);
});
