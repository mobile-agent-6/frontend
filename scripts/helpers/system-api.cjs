/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const trace = "12345678-1234-4234-8234-123456789abc";
const health = { status: "ok", apiVersion: "v1", serverTime: "2026-11-15T01:00:00.123456Z" };
const sync = { adjusted: false, previousServerTime: health.serverTime, serverTime: health.serverTime };
const jsonStep = (body, status = 200, media = "application/json") => ({ kind: "json", body, status,
  headers: { "Content-Type": media, "X-Request-ID": trace } });
const problemStep = (status, code) => jsonStep({ type: "https://example.invalid/problems/system", title: "fixture",
  status, detail: "fixture", instance: "/health", code, requestId: trace }, status, "application/problem+json");

// 기존 회귀 suite와 같은 메모리 TS loader·가짜 fetch/storage 패턴. 환경 파일은 읽지 않는다.
function harness(initialEnv = {}) {
  const env = { ...initialEnv }, modules = new Map(), data = new Map(), storageCalls = [];
  let liveCalls = 0, time = 0, token = 0;
  const pending = new Map(), delays = [];
  const clockState = { wall: Date.parse("2026-11-15T01:00:00Z"), monotonic: 100 };
  const timers = {
    setTimeout(callback, ms) { const id = ++token; pending.set(id, { callback, at: time + ms }); delays.push(ms); return id; },
    clearTimeout(id) { pending.delete(id); },
  };
  const denied = () => { liveCalls++; throw Error("실제 fetch 호출 금지"); };
  const storage = {
    async getItem(key) { storageCalls.push(["get", key]); return data.get(key) ?? null; },
    async setItem(key, value) { storageCalls.push(["set", key]); data.set(key, value); },
    async removeItem(key) { storageCalls.push(["remove", key]); data.delete(key); },
  };
  function load(relative) {
    if (modules.has(relative)) return modules.get(relative).exports;
    const module = { exports: {} }; modules.set(relative, module);
    const code = ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    }, fileName: relative }).outputText;
    const resolve = name => {
      if (name === "react-native") return { AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } };
      if (name === "expo-crypto") return { randomUUID: require("node:crypto").randomUUID };
      if (name === "expo/fetch") return { fetch: denied };
      if (name === "zustand/vanilla") return require(name);
      if (name === "@react-native-async-storage/async-storage") return storage;
      assert.ok(name.startsWith("@/"), name);
      return load(`src/${name.slice(2)}.ts`);
    };
    new Function("require", "module", "exports", "fetch", "process", "setTimeout", "clearTimeout", "__DEV__", code)(
      resolve, module, module.exports, denied, { env }, timers.setTimeout, timers.clearTimeout, env.NODE_ENV !== "production");
    return module.exports;
  }
  const config = load("src/services/api/config.ts");
  const system = load("src/services/api/system.ts");
  const mock = load("src/services/mock/transport.ts");
  const clock = { now: () => clockState.wall, monotonicNow: () => clockState.monotonic };
  function service(routes) {
    const transport = mock.createMockTransport(routes, timers);
    return { transport, api: system.createSystemApiService({ transport, timers, clock }) };
  }
  async function advance(ms) {
    await settle();
    const end = time + ms;
    for (;;) {
      const next = [...pending].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const delta = next[1].at - time;
      time = next[1].at; clockState.wall += delta; clockState.monotonic += delta;
      pending.delete(next[0]); next[1].callback(); await settle();
    }
    const delta = end - time;
    time = end; clockState.wall += delta; clockState.monotonic += delta;
    await settle();
  }
  return { env, data, storageCalls, load, config, system, mock, service, timers, pending, delays, clock, clockState,
    advance, get liveCalls() { return liveCalls; } };
}
module.exports = { harness, settle, trace, health, sync, jsonStep, problemStep };
