/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const origin = "https://example.invalid";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const tick = async () => { for (let n = 0; n < 60; n++) await Promise.resolve(); };

// Expo가 .env.local에서 주입한 실행 환경을 대체한다. 실제 환경 파일·주소·사용자 저장소는 읽지 않는다.
function harness(env = {}) {
  const modules = new Map(), data = new Map(), calls = [], reads = [];
  const state = { send: async () => json({ items: [] }) };
  const send = async (url, options) => { calls.push({ url, ...options }); return state.send(url, options); };
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    }, fileName: file }).outputText;
    function resolve(name) {
      if (name === "zustand/vanilla") return require(name);
      if (name === "expo/fetch") return { fetch: send };
      if (name === "expo-crypto") return { randomUUID };
      if (name === "@react-native-async-storage/async-storage") return {
        getItem: async key => { reads.push(key); return data.get(key) ?? null; },
        setItem: async (key, value) => { data.set(key, value); },
      };
      assert.ok(name.startsWith("@/"), name);
      return load(`src/${name.slice(2)}.ts`);
    }
    new Function("require", "module", "exports", "process", "fetch", code)(resolve, module, module.exports, { env }, send);
    return module.exports;
  }
  return { load, env, data, calls, reads, state };
}

test("환경 미설정은 기본 server/readOnly=false이며 주소 없음·Mock fallback·자동 요청 없음", () => {
  const h = harness(), mode = h.load("src/stores/scheduleDataModeStore.ts");
  assert.equal(mode.scheduleDataModeStore.getState().mode, "server");
  assert.equal(mode.isScheduleRequestAllowed("POST", "/schedules"), true);
  assert.equal(h.load("src/services/api/config.ts").getDevelopmentServerConfig().status, "missing");
  assert.equal(h.calls.length, 0);
});

test("Assistant·Schedule은 같은 환경 origin·서버 식별값을 사용하고 저장 주소를 읽지 않음", () => {
  const h = harness({ EXPO_PUBLIC_DEV_SERVER_BASE_URL: `${origin}/`, EXPO_PUBLIC_SCHEDULE_DATA_MODE: "server", EXPO_PUBLIC_SCHEDULE_READ_ONLY: "false" });
  h.data.set("settings.verifiedServer.v1", JSON.stringify({ kind: "development", baseUrl: "https://old.example.invalid" }));
  h.data.set("settings.savedPiIp", "192.0.2.10");
  const config = h.load("src/services/api/config.ts").getDevelopmentServerConfig();
  assert.equal(config.config.baseUrl, origin); assert.equal(config.config.apiBaseUrl, `${origin}/api/v1`);
  assert.equal(h.load("src/services/api/http.ts").scheduleHttpClient.getServerId(), config.config.serverId);
  assert.equal(h.load("src/services/api/assistant.ts").assistantHttpClient.getServerId(), config.config.serverId);
  assert.deepEqual(h.reads, []); assert.equal(h.calls.length, 0); assert.equal(h.data.size, 2);
});

test("환경 주소가 없으면 이전 Settings 저장 주소가 있어도 사용하거나 삭제하지 않음", async () => {
  const h = harness(); h.data.set("settings.verifiedServer.v1", JSON.stringify({ kind: "development", baseUrl: origin }));
  const result = await h.load("src/services/api/http.ts").scheduleHttpClient.request({ path: "/schedules" });
  assert.equal(result.ok, false); assert.equal(result.error.kind, "configuration"); assert.equal(result.error.requestState, "not-sent");
  assert.equal(h.calls.length, 0); assert.deepEqual(h.reads, []); assert.equal(h.data.size, 1);
});

for (const address of ["example.invalid", `${origin}/api/v1`, `${origin}/health`, `${origin}?token=x`, "https://user:password@example.invalid", "ftp://example.invalid"]) {
  test(`잘못된 환경 origin은 저장값 fallback·실제 전송 없이 거절: ${address}`, async () => {
    const h = harness({ EXPO_PUBLIC_DEV_SERVER_BASE_URL: address });
    h.data.set("settings.verifiedServer.v1", JSON.stringify({ kind: "development", baseUrl: origin }));
    const result = await h.load("src/services/api/http.ts").scheduleHttpClient.request({ path: "/schedules" });
    assert.equal(result.ok, false); assert.equal(result.error.kind, "configuration"); assert.equal(h.calls.length, 0); assert.equal(h.data.size, 1);
  });
}

test("명시적 Mock·readOnly=true와 일반 server/false의 기존 쓰기 경계를 유지", () => {
  for (const env of [{}, { EXPO_PUBLIC_SCHEDULE_READ_ONLY: "false" }, { EXPO_PUBLIC_SCHEDULE_READ_ONLY: "true" }, { EXPO_PUBLIC_SCHEDULE_DATA_MODE: "mock" }]) {
    const h = harness(env), mode = h.load("src/stores/scheduleDataModeStore.ts");
    assert.equal(mode.isScheduleRequestAllowed("POST", "/schedules"), env.EXPO_PUBLIC_SCHEDULE_READ_ONLY !== "true" && env.EXPO_PUBLIC_SCHEDULE_DATA_MODE !== "mock");
    assert.equal(mode.isScheduleRequestAllowed("GET", "/schedules"), true);
  }
});

test("환경 주소로 기존 수동 생성·수정·완료/미완료·삭제 서비스의 HTTP handler를 사용", async () => {
  const h = harness({ EXPO_PUBLIC_DEV_SERVER_BASE_URL: origin, EXPO_PUBLIC_SCHEDULE_DATA_MODE: "server", EXPO_PUBLIC_SCHEDULE_READ_ONLY: "false" });
  const dto = { id: randomUUID(), title: "수동 일정", scheduledAt: "2026-11-14T01:00:00Z", category: "INBOUND", completed: false,
    createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z" };
  h.state.send = async (url, options) => options.method === "DELETE" ? new Response(null, { status: 204 })
    : json({ ...dto, ...(options.method === "PATCH" ? JSON.parse(options.body) : {}) }, options.method === "POST" ? 201 : 200);
  const service = h.load("src/services/api/schedules.ts");
  const create = service.prepareScheduleCreation({ title: dto.title, scheduledAt: dto.scheduledAt, category: dto.category });
  assert.equal((await create.operation.submit()).outcome, "created");
  for (const changes of [{ title: "수정된 일정" }, { completed: true }, { completed: false }]) {
    assert.equal((await service.prepareScheduleUpdate(dto.id, changes).operation.submit()).outcome, "updated");
  }
  assert.equal((await service.prepareScheduleDeletion(dto.id).operation.submit()).outcome, "deleted");
  assert.deepEqual(h.calls.map(call => call.method), ["POST", "PATCH", "PATCH", "PATCH", "DELETE"]);
  assert.ok(h.calls.every(call => call.url.startsWith(`${origin}/api/v1/schedules`)));
});

test("이전 서버의 늦은 GET은 현재 서버 성공으로 반영하지 않음", async () => {
  const h = harness({ EXPO_PUBLIC_DEV_SERVER_BASE_URL: origin }); let finish;
  h.state.send = () => new Promise(resolve => { finish = resolve; });
  const http = h.load("src/services/api/http.ts").scheduleHttpClient;
  const pending = http.request({ path: "/schedules" }); await tick();
  h.env.EXPO_PUBLIC_DEV_SERVER_BASE_URL = "https://other.example.invalid"; finish(json({ items: [] }));
  assert.equal((await pending).ok, false); assert.equal(http.getServerId(), "development:https://other.example.invalid");
});

test("원래 Pi IP 저장·복원은 유지하며 개발 서버 환경 주소를 변경하지 않음", async () => {
  const h = harness({ EXPO_PUBLIC_DEV_SERVER_BASE_URL: origin });
  h.data.set("settings.savedPiIp", "192.0.2.10"); h.data.set("settings.verifiedServer.v1", "과거 개발 서버 설정");
  const settings = h.load("src/services/storage/settings.ts");
  assert.equal(await settings.readSavedPiIp(), "192.0.2.10");
  await settings.writeSavedPiIp("192.0.2.11"); assert.equal(await settings.readSavedPiIp(), "192.0.2.11");
  assert.equal(h.load("src/services/api/config.ts").getDevelopmentServerConfig().config.baseUrl, origin);
  assert.equal(h.data.get("settings.verifiedServer.v1"), "과거 개발 서버 설정"); assert.equal(h.calls.length, 0);
});

test("서버 환경을 바꾼 앱도 복구 metadata를 원래 서버별로 분리하고 기존 항목은 유지", async () => {
  const h = harness({ EXPO_PUBLIC_DEV_SERVER_BASE_URL: origin });
  const original = { serverId: `development:${origin}`, requestId: randomUUID(), firstPostAttemptAt: 1000, lastPostAttemptAt: 1000, acceptConfirmed: false };
  const other = { ...original, serverId: "development:https://other.example.invalid", requestId: randomUUID() };
  h.data.set("assistant.requestRecovery.v1", JSON.stringify({ version: 1, entries: [original, other] }));
  const recovery = h.load("src/services/storage/assistant-recovery.ts").assistantRecoveryStorage;
  assert.deepEqual(await recovery.readForServer(original.serverId), [original]);
  assert.deepEqual(await recovery.readForServer(other.serverId), [other]);
  assert.equal(JSON.parse(h.data.get("assistant.requestRecovery.v1")).entries.length, 2); assert.equal(h.calls.length, 0);
});
