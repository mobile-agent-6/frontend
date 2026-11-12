/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const { randomUUID } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const origin = "https://example.invalid";
const json = (value, status = 200, type = "application/json") => new Response(JSON.stringify(value), { status, headers: { "Content-Type": type } });
const health = () => json({ status: "ok", apiVersion: "v1", serverTime: new Date().toISOString() });
const tick = async () => { for (let n = 0; n < 90; n++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// 실제 설정·HTTP·저장·화면 handler를 실행하며 native와 외부 I/O만 대체한다.
function harness(env = {}) {
  const modules = new Map(), data = new Map(), calls = [], effects = [], slots = [];
  const state = { fetch: async () => health(), failRead: false, failWrite: false };
  const send = async (url, options) => { calls.push({ url, ...options }); return state.fetch(url, options); };
  let cursor = 0, tree, screen;
  const react = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; }]; },
    useRef(value) { return slots[cursor++] ??= { current: value }; },
    useEffect(fn, deps) { const index = cursor++; if (!slots[index]) { slots[index] = {}; effects.push(() => { slots[index].cleanup = fn(); }); } },
  };
  const storage = { getItem: async key => { if (state.failRead) throw Error("메모리 읽기 실패"); return data.get(key) ?? null; },
    setItem: async (key, value) => { if (state.failWrite) throw Error("메모리 저장 실패"); data.set(key, value); } };
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    }, fileName: file }).outputText;
    function resolve(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
      if (name === "react-native") return { Platform: { OS: "ios" }, StyleSheet: { create: value => value },
        KeyboardAvoidingView: "KeyboardAvoidingView", ScrollView: "ScrollView", View: "View", Pressable: "Pressable" };
      if (name === "zustand/vanilla") return require(name);
      if (name === "zustand") return { useStore: (store, select) => select(store.getState()) };
      if (name === "@react-native-async-storage/async-storage") return storage;
      if (name === "expo/fetch") return { fetch: send };
      if (name === "expo-crypto") return { randomUUID };
      if (name === "@/hooks/use-theme") return { useTheme: () => ({ background: "white", backgroundElement: "grey" }) };
      if (name === "@/hooks/use-color-scheme") return { useColorScheme: () => "light" };
      if (name === "@/constants/theme") return { Spacing: { two: 8, three: 12, four: 16, five: 20 } };
      if (name.startsWith("@/components/") && !name.endsWith("server-settings-screen")) {
        const label = name.split("/").at(-1).split("-").map(part => part[0].toUpperCase() + part.slice(1)).join("");
        return { [label]: label };
      }
      assert.ok(name.startsWith("@/"), name);
      const base = `src/${name.slice(2)}`;
      return load(`${base}${fs.existsSync(path.join(root, `${base}.ts`)) ? ".ts" : ".tsx"}`);
    }
    new Function("require", "module", "exports", "process", "fetch", code)(resolve, module, module.exports, { env }, send);
    return module.exports;
  }
  function render() { cursor = 0; tree = screen(); while (effects.length) effects.shift()(); }
  function all(type, node = tree) {
    if (Array.isArray(node)) return node.flatMap(value => all(type, value));
    if (!node || typeof node !== "object") return [];
    return [...(node.type === type ? [node.props] : []), ...all(type, node.props?.children ?? null)];
  }
  return { load, calls, data, state, storage, all, render,
    mount() { screen = load("src/components/settings/server-settings-screen.tsx").ServerSettingsScreen; render(); },
    async settle() { await tick(); if (screen) render(); },
    close() { for (const slot of slots) slot?.cleanup?.(); },
    connection: () => load("src/services/api/server-connection.ts").serverConnection,
    config: () => load("src/services/api/config.ts"),
  };
}

test("저장 주소 없음: server/readOnly=false 기본값·Mock fallback·자동 health 없음", async () => {
  const h = harness(); const mode = h.load("src/stores/scheduleDataModeStore.ts");
  await h.connection().initialize();
  assert.equal(mode.scheduleDataModeStore.getState().mode, "server");
  assert.equal(mode.isScheduleRequestAllowed("POST", "/schedules"), true);
  assert.equal(h.config().getDevelopmentServerConfig().status, "missing"); assert.equal(h.calls.length, 0);
});

test("실제 health GET만 확인하고 저장 후 공통 config 적용·재실행 복원", async () => {
  const h = harness(), service = h.connection(); const proof = await service.check(origin, "development");
  assert.equal(proof.ok, true); assert.equal(h.config().getDevelopmentServerConfig().status, "missing");
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, `${origin}/health`); assert.equal(h.calls[0].method, "GET");
  assert.equal(h.calls[0].redirect, "error"); assert.equal(h.data.size, 0);
  await service.save(proof); assert.equal(h.config().getDevelopmentServerConfig().config.baseUrl, origin);
  const restarted = harness(); for (const [key, value] of h.data) restarted.data.set(key, value);
  await restarted.connection().initialize(); assert.equal(restarted.calls.length, 0);
  assert.equal(restarted.config().getDevelopmentServerConfig().config.baseUrl, origin);
});

test("Pi는 IP와 8000 계약, 개발 서버는 별도 kind로 저장하며 Mock Pi IP는 자동 승격하지 않음", async () => {
  const h = harness(); h.data.set("settings.savedPiIp", "192.0.2.10"); await h.connection().initialize();
  assert.equal(h.config().getDevelopmentServerConfig().status, "missing");
  const proof = await h.connection().check("192.0.2.10", "pi"); await h.connection().save(proof);
  assert.equal(h.calls[0].url, "http://192.0.2.10:8000/health");
  assert.deepEqual(await h.connection().read(), { kind: "pi", baseUrl: "http://192.0.2.10:8000" });
});

for (const address of ["", "example.invalid", `${origin}/api/v1`, `${origin}/health`, `${origin}?token=x`, "https://user:password@example.invalid"]) {
  test(`잘못된 origin 입력은 실제 GET·저장 0회: ${address}`, async () => {
    const h = harness(); assert.equal((await h.connection().check(address, "development")).ok, false); assert.equal(h.calls.length, 0); assert.equal(h.data.size, 0);
  });
}

for (const [name, response, reason] of [
  ["HTTP 오류", () => json({}, 503), "http"],
  ["status 불일치", () => json({ status: "failed", apiVersion: "v1", serverTime: new Date().toISOString() }), "response"],
  ["version 불일치", () => json({ status: "ok", apiVersion: "v2", serverTime: new Date().toISOString() }), "response"],
  ["UTC Z 누락", () => json({ status: "ok", apiVersion: "v1", serverTime: "2026-11-13T10:00:00+09:00" }), "response"],
  ["잘못된 날짜", () => json({ status: "ok", apiVersion: "v1", serverTime: "2026-02-30T00:00:00Z" }), "response"],
  ["잘못된 JSON", () => new Response("{", { headers: { "Content-Type": "application/json" } }), "response"],
  ["시간 차이 초과", () => json({ status: "ok", apiVersion: "v1", serverTime: "2000-01-01T00:00:00Z" }), "clock"],
]) test(`${name}는 저장·서버 전환·Mock fallback 없이 구분`, async () => {
  const h = harness(); h.state.fetch = response; const result = await h.connection().check(origin, "development");
  assert.equal(result.reason, reason); await assert.rejects(h.connection().save(result)); assert.equal(h.data.size, 0); assert.equal(h.calls.length, 1);
});

test("RTT midpoint와 60초 경계 검증", async () => {
  const h = harness(), wall = Date.parse("2026-11-13T01:00:00Z"); let mono = 0;
  const factory = h.load("src/services/api/server-connection.ts").createServerConnection;
  for (const seconds of [60, 60.001]) {
    const service = factory({ now: () => wall, monotonic: () => { const value = mono; mono += 400; return value; },
      fetchImpl: async () => json({ status: "ok", apiVersion: "v1", serverTime: new Date(wall + 200 + seconds * 1000).toISOString() }) });
    assert.equal((await service.check(origin, "development")).ok, seconds === 60);
  }
});

test("timeout·Abort에서 신호 무시 대역의 늦은 응답을 성공/저장으로 처리하지 않음", async () => {
  const h = harness(), factory = h.load("src/services/api/server-connection.ts").createServerConnection;
  const gate = deferred(); const service = factory({ fetchImpl: () => gate.promise, timeoutMs: 1 });
  assert.equal((await service.check(origin, "development")).reason, "timeout"); gate.resolve(health());
  const abort = new AbortController(); abort.abort(); assert.equal((await service.check(origin, "development", abort.signal)).reason, "aborted");
  assert.equal(h.data.size, 0);
});

test("네트워크 실패는 자동 retry 없이 구분", async () => {
  const h = harness(); h.state.fetch = async () => { throw Error("테스트 실패"); };
  assert.equal((await h.connection().check(origin, "development")).reason, "network"); assert.equal(h.calls.length, 1);
});

test("저장 실패·조작된 검증 결과는 현재 서버를 변경하지 않음", async () => {
  const h = harness(), proof = await h.connection().check(origin, "development"); h.state.failWrite = true;
  await assert.rejects(h.connection().save(proof)); assert.equal(h.config().getDevelopmentServerConfig().status, "missing");
  await assert.rejects(h.connection().save({ ...proof })); assert.equal(h.data.size, 0);
});

test("읽기 실패·손상 저장 데이터는 기존 metadata를 삭제하거나 Mock으로 바꾸지 않음", async () => {
  for (const broken of ["{", JSON.stringify({ kind: "development", baseUrl: `${origin}/api/v1` })]) {
    const h = harness(); h.data.set("settings.verifiedServer.v1", broken); h.data.set("assistant.recovery", "원래 기록");
    await assert.rejects(h.connection().initialize()); assert.equal(h.data.size, 2); assert.equal(h.calls.length, 0);
  }
  const h = harness(); h.state.failRead = true; await assert.rejects(h.connection().initialize()); assert.equal(h.calls.length, 0);
});

test("지연된 시작 복원보다 새로 검증·저장한 서버가 우선", async () => {
  const h = harness(), factory = h.load("src/services/api/server-connection.ts").createServerConnection, gate = deferred();
  const service = factory({ read: () => gate.promise }); const initialized = service.initialize();
  const proof = await service.check(origin, "development"); await service.save(proof);
  gate.resolve({ kind: "development", baseUrl: "https://old.example.invalid" }); await initialized;
  assert.equal(h.config().getDevelopmentServerConfig().config.baseUrl, origin);
});

test("서버 변경은 generation을 증가시키며 기존 서버 복구 기록은 유지", async () => {
  const h = harness(), mode = h.load("src/stores/scheduleDataModeStore.ts").scheduleDataModeStore;
  h.data.set("assistant.recovery", "원래 기록");
  for (const address of [origin, "https://other.example.invalid", origin]) await h.connection().save(await h.connection().check(address, "development"));
  assert.equal(mode.getState().generation, 3); assert.equal(h.data.get("assistant.recovery"), "원래 기록");
});

test("저장한 주소를 기존 Schedule 생성·수정·삭제 서비스가 실제 HTTP 경계로 사용", async () => {
  const h = harness(); await h.connection().save(await h.connection().check(origin, "development"));
  const dto = { id: randomUUID(), title: "수동 일정", scheduledAt: "2026-11-14T01:00:00Z", category: "INBOUND", completed: false,
    createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z" };
  h.state.fetch = async (url, options) => options.method === "DELETE" ? new Response(null, { status: 204 })
    : json({ ...dto, ...(options.method === "PATCH" ? JSON.parse(options.body) : {}) }, options.method === "POST" ? 201 : 200);
  const service = h.load("src/services/api/schedules.ts");
  const create = service.prepareScheduleCreation({ title: dto.title, scheduledAt: dto.scheduledAt, category: dto.category });
  assert.equal((await create.operation.submit()).outcome, "created");
  for (const changes of [{ title: "수정된 일정" }, { completed: true }, { completed: false }]) {
    const update = service.prepareScheduleUpdate(dto.id, changes); assert.equal((await update.operation.submit()).outcome, "updated");
  }
  assert.equal((await service.prepareScheduleDeletion(dto.id).operation.submit()).outcome, "deleted");
  assert.deepEqual(h.calls.slice(1).map(call => call.method), ["POST", "PATCH", "PATCH", "PATCH", "DELETE"]);
  assert.ok(h.calls.every(call => call.url.startsWith(origin)));
});

test("서버 저장 전후의 HTTP는 같은 설정을 읽으며 이전 서버 응답은 성공으로 반영하지 않음", async () => {
  const h = harness(); await h.connection().save(await h.connection().check(origin, "development"));
  const http = h.load("src/services/api/http.ts").scheduleHttpClient;
  const gate = deferred(); h.state.fetch = () => gate.promise;
  const pending = http.request({ path: "/schedules" }); await tick();
  assert.equal(h.calls.at(-1).url, `${origin}/api/v1/schedules`);
  h.config().setServerConfiguration("https://other.example.invalid"); gate.resolve(json({ items: [] }));
  assert.equal((await pending).ok, false); assert.equal(http.getServerId(), "development:https://other.example.invalid");
});

test("server+readOnly와 명시적 Mock의 수동 write 경계는 유지", () => {
  for (const env of [{}, { EXPO_PUBLIC_SCHEDULE_READ_ONLY: "true" }, { EXPO_PUBLIC_SCHEDULE_DATA_MODE: "mock" }]) {
    const h = harness(env), mode = h.load("src/stores/scheduleDataModeStore.ts");
    assert.equal(mode.isScheduleRequestAllowed("POST", "/schedules"), Object.keys(env).length === 0);
    assert.equal(mode.isScheduleRequestAllowed("GET", "/schedules"), true);
  }
});

test("Settings 실제 handler: 개발 서버 선택·health 연타 차단·검증 후 저장", async () => {
  const h = harness(); h.mount(); await h.settle();
  h.all("Pressable")[1].onPress(); h.render();
  const edit = h.all("SettingsIpCard")[0].onIpChange; edit("https://exam"); edit(origin); h.render();
  assert.equal(h.all("SettingsIpCard")[0].inputIp, origin);
  const gate = deferred(); h.state.fetch = () => gate.promise;
  const click = h.all("SettingsIpCard")[0].onCheckConnection; click(); click(); h.render(); assert.equal(h.calls.length, 1);
  gate.resolve(health()); await h.settle(); assert.equal(h.all("SettingsSaveFooter")[0].disabled, false);
  h.all("SettingsSaveFooter")[0].onSavePress(); await h.settle();
  assert.equal(h.config().getDevelopmentServerConfig().config.baseUrl, origin);
  assert.equal(h.all("SettingsSaveFooter")[0].feedback.status, "success"); h.close();
});

test("Settings 입력 변경은 검증 무효화·unmount 뒤 늦은 health는 저장 불가", async () => {
  const h = harness(); h.mount(); await h.settle(); h.all("Pressable")[1].onPress(); h.render();
  h.all("SettingsIpCard")[0].onIpChange(origin); h.render(); h.all("SettingsIpCard")[0].onCheckConnection(); await h.settle();
  const staleSave = h.all("SettingsSaveFooter")[0].onSavePress;
  h.all("SettingsIpCard")[0].onIpChange("https://other.example.invalid"); h.render(); assert.equal(h.all("SettingsSaveFooter")[0].disabled, true);
  staleSave(); await h.settle(); assert.equal(h.data.size, 0);
  const gate = deferred(); h.state.fetch = () => gate.promise; h.all("SettingsIpCard")[0].onCheckConnection(); h.close(); gate.resolve(health()); await tick(); assert.equal(h.data.size, 0);
});
