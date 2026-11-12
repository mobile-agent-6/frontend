/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const origin = "https://example.invalid", serverId = `development:${origin}`;
const id = n => `${n.toString(16).padStart(8, "0")}-abcd-4abc-8abc-abcdef123456`;
const summary = { id: id(200), title: "원본 일정", scheduledAt: "2026-11-12T00:00:00Z", category: "OTHER", completed: false, updatedAt: "2026-11-11T00:00:00Z" };
const results = {
  need_more_info: { kind: "need_more_info", text: "몇 시인가요?", questionId: id(300) },
  candidate_selection: { kind: "candidate_selection", text: "후보를 선택해 주세요.", questionId: id(300), expiresAt: "2026-11-12T01:00:00Z", candidates: [1, 2].map(n => ({ candidateId: `opaque/${n}`, title: "후보", scheduledAt: summary.scheduledAt, category: "OTHER" })) },
  confirmation: { kind: "confirmation", text: "변경할까요?", questionId: id(300), expiresAt: "2026-11-12T01:00:00Z", operation: "update", target: summary, changes: { completed: true } },
  outcome: { kind: "outcome", text: "서버의 조회 결과", outcome: "success", operation: "list", schedulesChanged: false, items: [summary] },
  failure: { kind: "failure", text: "서버에서 처리를 완료하지 못했어요.", code: "MODEL_TIMEOUT", nextAction: "retry_later" },
  uncertain: { kind: "uncertain", text: "실행 결과를 확인해야 해요.", code: "EXECUTION_RESULT_UNKNOWN", nextAction: "check_status" },
};
const json = (body, status = 200) => ({ status, headers: new Headers({ "Content-Type": "application/json", "X-Request-ID": id(900) }), text: async () => JSON.stringify(body) });
const status = (requestId, value = "accepted") => ({ requestId, conversationId: id(100), status: value });
const done = (requestId, kind = "outcome") => ({ ...status(requestId, "completed"), result: results[kind] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// 실제 화면 Hook·HTTP·복구·polling을 실행하고 native·시계·storage·fetch만 프로세스 대역으로 둔다.
// 실제 단말 렌더링·키보드·네트워크 시험은 아니다.
function harness({ initialMode = "server", readOnly = false, data = new Map() } = {}) {
  const cache = new Map(), slots = [], effects = [], timers = new Map(), listeners = new Set();
  let cursor = 0, dirty = false, tree, wall = 1000, mono = 0, timerId = 0, closed = false;
  const state = { app: "active", calls: [], starts: [], uuidCalls: 0, failUuid: false, failStorage: false, throwMessage: false,
    cleanup: 0, lateUpdates: 0, mockRuns: 0, beforeUuid: null, config: null,
    handle: async (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202) : json(done(url.split("/").pop())) };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, next => {
        if (closed) state.lateUpdates++;
        const value = typeof next === "function" ? next(slots[i].value) : next;
        if (state.throwMessage && Array.isArray(value) && value.at(-1)?.role === "assistant" && value.at(-1).apiExecution?.kind === "completed") { state.throwMessage = false; throw Error("응답 게시 실패"); }
        if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; }
      }]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useCallback(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: fn }; return slots[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  const setTimer = (fn, ms) => { const token = ++timerId; timers.set(token, { fn, at: mono + ms, ms }); return token; };
  const clearTimer = token => timers.delete(token);
  const send = (url, init) => { state.calls.push({ url, init }); return state.handle(url, init); };
  const adapter = { async getItem(key) { return data.get(key) ?? null; }, async setItem(key, value) { if (state.failStorage) throw Error("저장 실패"); data.set(key, value); } };
  const native = { AppState: { get currentState() { return state.app; }, addEventListener(event, listener) { assert.equal(event, "change"); listeners.add(listener); return { remove: () => listeners.delete(listener) }; } },
    KeyboardAvoidingView: "KeyboardAvoidingView", Platform: { OS: "ios" }, StyleSheet: { create: s => s }, Text: "Text", View: "View", Pressable: "Pressable" };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: file }).outputText;
    function resolve(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === "react-native") return native;
      if (name === "zustand" || name === "zustand/vanilla") return require(name);
      if (name === "expo/fetch") return { fetch: send };
      if (name === "@react-native-async-storage/async-storage") return adapter;
      if (name === "expo-crypto") return { randomUUID: () => { state.uuidCalls++; state.beforeUuid?.(); if (state.failUuid) throw Error("UUID 실패"); return randomUUID(); } };
      if (name.startsWith("@/components/")) { const component = name.split("/").at(-1).split("-").map(s => s[0].toUpperCase() + s.slice(1)).join(""); return { [component]: component }; }
      if (name === "@/constants/theme") return { Spacing: { two: 8, three: 16 } };
      if (name === "@/hooks/use-color-scheme") return { useColorScheme: () => "light" };
      if (name === "@/hooks/use-theme") return { useTheme: () => ({ background: "white", primaryForeground: "white" }) };
      assert.ok(name.startsWith("@/"), name); assert.notEqual(name, "@/services/api/http");
      return load(path.join(root, "src", `${name.slice(2)}.ts`));
    }
    new Function("require", "module", "exports", "fetch", "setTimeout", "clearTimeout", "performance", "process", code)(resolve, module, module.exports,
      () => { throw Error("실제 네트워크 금지"); }, setTimer, clearTimer, { now: () => mono }, { env: { EXPO_PUBLIC_DEV_SERVER_BASE_URL: origin, EXPO_PUBLIC_SCHEDULE_DATA_MODE: initialMode, EXPO_PUBLIC_SCHEDULE_READ_ONLY: String(readOnly) } });
    return module.exports;
  }
  const source = file => load(path.join(root, file));
  const config = source("src/services/api/config.ts"); state.config = config.parseDevelopmentServerConfig(origin);
  const storage = source("src/services/storage/assistant-recovery.ts").assistantRecoveryStorage;
  const httpModule = source("src/services/api/assistant.ts");
  const http = httpModule.createAssistantHttpClient({ recovery: storage, fetchImpl: send, readConfig: () => state.config, now: () => wall }); httpModule.assistantHttpClient = http;
  const recovery = source("src/services/api/assistant-request-recovery.ts").createAssistantRequestRecovery({ http, recovery: storage, now: () => wall });
  const api = source("src/services/api/assistant-orchestrator.ts");
  const orchestrator = api.createAssistantOrchestrator({ http, requests: recovery, storage: { ...storage, cleanup: async (...args) => { state.cleanup++; return storage.cleanup(...args); } }, clock: { now: () => wall, monotonicNow: () => mono } });
  const delegate = { startRequest: (...args) => { state.starts.push(args); return orchestrator.startRequest(...args); } }; api.assistantOrchestrator = delegate;
  const mode = source("src/stores/scheduleDataModeStore.ts"), mock = source("src/stores/scheduleStore.ts").useScheduleStore;
  const mockService = source("src/services/mock/assistant.ts"), originalMock = mockService.runMockAssistantScenario;
  mockService.runMockAssistantScenario = (...args) => { state.mockRuns++; return originalMock(...args); };
  const Screen = source("src/app/(tabs)/assistant.tsx").default;
  function render() { let limit = 30; do { dirty = false; cursor = 0; tree = Screen(); while (effects.length) effects.shift()(); } while (dirty && --limit); assert.ok(limit); }
  function find(type, node = tree) { if (!node) return null; if (Array.isArray(node)) return node.map(n => find(type, n)).find(Boolean); if (node.type === type) return node.props; return node.props?.children === undefined ? null : find(type, node.props.children); }
  async function settle() { for (let n = 0; n < 350; n++) await Promise.resolve(); if (!closed) render(); }
  async function advance(ms) { const target = mono + ms; let count = 0; while (true) { const next = Math.min(...[...timers.values()].map(t => t.at)); if (next > target) break; if (++count > 500) throw Error("타이머 반복"); wall += next - mono; mono = next;
      for (const [key, timer] of [...timers]) if (timer.at <= mono) { timers.delete(key); timer.fn(); } await settle(); } wall += target - mono; mono = target; await settle(); }
  render();
  return { state, source, storage, data, mock, mode, delegate, render, find, settle, advance, timers, listeners,
    messages: () => find("ConversationList").messages,
    edit(text) { find("MessageInput").onChangeText(text); render(); },
    send(text) { this.edit(text); find("MessageInput").onSend(); render(); },
    switchMode(value) { mode.scheduleDataModeStore.getState().setMode(value); render(); },
    app(value) { state.app = value; for (const listener of [...listeners]) listener(value); },
    close() { closed = true; slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test("첫 서버 text: UUID v4·conversationId 생략·원문·UserMessage·기존 bubble", async () => {
  const h = harness(); try {
    h.send("  일정 조회해 줘  "); assert.equal(h.find("ConversationList").isProcessing, true); await h.settle();
    const body = JSON.parse(h.state.calls[0].init.body); assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(body).sort(), ["input", "requestId"]); assert.deepEqual(body.input, { type: "text", text: "  일정 조회해 줘  " });
    assert.equal(h.messages()[0].id, body.requestId); assert.equal(h.messages()[0].role, "user"); assert.equal(h.messages()[0].text, body.input.text);
    assert.equal(h.state.starts[0][1].expectedServerId, serverId); assert.equal(h.messages().at(-1).text, results.outcome.text);
    const bubble = h.source("src/components/assistant/assistant-message.tsx").AssistantMessage({ text: h.messages().at(-1).text });
    assert.equal(bubble.props.children[0].props.children, results.outcome.text); assert.equal(h.find("Header").title, "일정 비서");
    assert.equal(h.find("ConversationList").isProcessing, false); assert.equal(h.find("MessageInput").disabled, false); assert.equal(h.state.mockRuns, 0);
  } finally { h.close(); }
});

test("accepted/processing은 최종 응답 없이 processing 유지·기존 2초 polling 사용", async () => {
  const h = harness(); let gets = 0;
  h.state.handle = async (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202) : json(++gets === 1 ? status(url.split("/").pop()) : gets === 2 ? status(url.split("/").pop(), "processing") : done(url.split("/").pop()));
  try { h.send("조회"); await h.settle(); assert.equal(h.messages().length, 1); assert.equal(h.find("MessageInput").disabled, true);
    await h.advance(1999); assert.equal(gets, 1); await h.advance(1); assert.equal(gets, 2); assert.equal(h.messages().length, 1);
    await h.advance(2000); assert.equal(h.messages().length, 2); assert.equal(h.find("ConversationList").isProcessing, false); assert.equal(h.state.starts.length, 1);
  } finally { h.close(); }
});

for (const kind of Object.keys(results)) test(`완료 결과 ${kind}: 서버 text·kind·전체 식별 정보 보존, 상세 카드/Mock interaction 없음`, async () => {
  const h = harness(); h.state.handle = async (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202) : json(done(url.split("/").pop(), kind));
  try { h.send("독립 요청"); await h.settle(); const message = h.messages().at(-1); assert.equal(message.text, results[kind].text);
    assert.equal(message.apiExecution.kind, "completed"); assert.equal(message.apiExecution.response.data.conversationId, id(100)); assert.deepEqual(message.apiExecution.response.data.result, results[kind]);
    assert.equal(message.interaction, undefined); assert.equal(message.schedules, undefined); assert.equal(h.state.cleanup, 0); assert.equal(h.state.mockRuns, 0);
    h.find("ConversationList").onCandidateSelection(message.id, id(200)); h.find("ConversationList").onDeleteConfirmation(message.id, true); await h.settle(); assert.equal(h.state.starts.length, 1);
  } finally { h.close(); }
});

test("연타와 UUID 생성 중 동기 재진입에서도 논리 요청·UUID 1개", async () => {
  const h = harness(), gate = deferred(); h.state.handle = () => gate.promise;
  try { h.edit("조회"); const send = h.find("MessageInput").onSend; h.state.beforeUuid = send; send(); send(); h.render(); await h.settle();
    assert.equal(h.state.starts.length, 1); assert.equal(h.state.uuidCalls, 1); assert.equal(h.state.calls.length, 1); assert.equal(h.messages().length, 1);
  } finally { h.close(); await h.settle(); }
});

for (const [name, text] of [["공백", " \t\n\u3000"], ["501 코드 포인트", "가".repeat(501)], ["trim 전 501자", ` ${"가".repeat(499)} `], ["surrogate", "\ud800"], ["제어문자", "문자\u0001"]]) test(`${name} 입력은 UUID·startRequest·POST 0회 및 잠금 해제`, async () => {
  const h = harness(); try { h.send(text); await h.settle(); assert.equal(h.state.starts.length, 0); assert.equal(h.state.calls.length, 0); assert.equal(h.state.uuidCalls, 0);
    assert.equal(h.find("MessageInput").value, text); assert.equal(h.find("MessageInput").disabled, false); assert.equal(h.find("ConversationList").isProcessing, false);
  } finally { h.close(); }
});

test("500개 astral 코드 포인트와 UTF-8 16 KiB 직렬화 제한", async () => {
  const h = harness(); try { h.send("😀".repeat(500)); await h.settle(); assert.equal(h.state.starts.length, 1);
    const body = h.state.calls[0].init.body; assert.equal([...JSON.parse(body).input.text].length, 500); assert.ok(new TextEncoder().encode(body).length <= 16 * 1024);
  } finally { h.close(); }
});

for (const reason of ["storage", "network"]) test(`${reason} 실패는 원문 보존·잠금 해제·자동 새 ID/POST 없음`, async () => {
  const h = harness(); if (reason === "storage") h.state.failStorage = true; else h.state.handle = async () => { throw Error("네트워크 실패"); };
  try { h.send("  실패 원문  "); await h.settle(); assert.equal(h.find("MessageInput").value, "  실패 원문  "); assert.equal(h.find("MessageInput").disabled, false);
    assert.equal(h.state.starts.length, 1); assert.equal(h.state.uuidCalls, 1); assert.equal(h.state.calls.filter(c => c.init.method === "POST").length, reason === "storage" ? 0 : 1);
    assert.equal(h.messages().at(-1).apiExecution.kind, "needs-attention"); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const draft of ["새 초안", ""]) test(`늦은 실패는 사용자가 ${draft ? "작성한" : "작성 후 지운"} 새 초안을 덮어쓰지 않음`, async () => {
  const h = harness(), gate = deferred(); h.state.handle = () => gate.promise;
  try { h.send("이전 입력"); await h.settle(); h.edit("새 초안"); if (!draft) h.edit("");
    h.app("background"); await h.settle(); assert.equal(h.find("MessageInput").value, draft); assert.equal(h.find("MessageInput").disabled, false);
  } finally { h.close(); await h.settle(); }
});

test("120초 자동 조회 종료는 성공 아님·원래 metadata·입력 유지", async () => {
  const h = harness(); h.state.handle = async (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202) : json(status(url.split("/").pop(), "processing"));
  try { h.send("오래 걸리는 요청"); await h.settle(); await h.advance(120000); const message = h.messages().at(-1);
    assert.equal(message.apiExecution.kind, "needs-attention"); assert.equal(message.apiExecution.reason, "deadline"); assert.equal(h.find("MessageInput").value, "오래 걸리는 요청");
    assert.equal(h.state.starts.length, 1); assert.equal(h.state.cleanup, 0); assert.notEqual(await h.storage.read(message.apiExecution.reference), null);
  } finally { h.close(); }
});

test("응답 표시 예외는 성공한 POST를 재실행하지 않고 metadata 유지", async () => {
  const h = harness(); h.state.throwMessage = true;
  try { h.send("조회"); await h.settle(); assert.equal(h.state.starts.length, 1); assert.equal(h.state.calls.filter(c => c.init.method === "POST").length, 1);
    assert.equal(h.state.uuidCalls, 1); assert.equal(h.state.cleanup, 0); assert.equal(h.find("MessageInput").disabled, false); assert.equal(h.find("MessageInput").value, "");
  } finally { h.close(); }
});

test("UUID 예외는 전송 없이 입력·잠금 복구 후 명시적 새 전송 가능", async () => {
  const h = harness(); try { h.state.failUuid = true; h.send("조회"); await h.settle(); assert.equal(h.state.starts.length, 0); assert.equal(h.find("MessageInput").value, "조회");
    h.state.failUuid = false; h.find("MessageInput").onSend(); h.render(); await h.settle(); assert.equal(h.state.starts.length, 1);
  } finally { h.close(); }
});

test("mode 전환·unmount·서버 변경의 늦은 응답은 UI와 Mock write에 반영하지 않음", async () => {
  for (const action of ["mode", "unmount", "server"]) {
    const h = harness(), gate = deferred(); h.state.handle = async (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202) : gate.promise;
    try { h.send("조회"); await h.settle(); const requestId = h.state.starts[0][0].requestId;
      if (action === "mode") h.switchMode("mock"); else if (action === "unmount") h.close(); else h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid");
      gate.resolve(json(done(requestId))); await h.settle(); assert.equal(h.messages().some(m => m.apiExecution?.kind === "completed"), false);
      assert.equal(h.state.mockRuns, 0); assert.equal(h.state.lateUpdates, 0); assert.equal(h.state.cleanup, 0); assert.equal(h.mock.getState().schedules.length, 10);
    } finally { h.close(); await h.settle(); }
  }
});

test("Mock 질문·후속 입력·등록은 기존 시나리오 유지하고 HTTP 0회", async () => {
  const h = harness({ initialMode: "mock" }); try { h.send("내일 팀 회의 추가해 줘"); await h.advance(700); assert.equal(h.messages().at(-1).text, "몇 시로 할까요?");
    h.send("오후 3시"); await h.advance(700); assert.equal(h.mock.getState().schedules.length, 11); assert.equal(h.state.starts.length, 0); assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("탭 왕복에 준하는 재렌더는 세션 대화 유지·새 실행은 과거 채팅 복원 없음", async () => {
  const h = harness(); try { h.send("조회"); await h.settle(); const messages = h.messages(); h.render(); h.render(); assert.strictEqual(h.messages(), messages);
    const persisted = [...h.data.values()].join(""); assert.equal(persisted.includes("서버의 조회 결과"), false); assert.equal(persisted.includes('"input"'), false); assert.equal(persisted.includes('"messages"'), false);
    const restarted = harness({ data: h.data }); try { assert.deepEqual(restarted.messages(), []); assert.equal(restarted.state.calls.length, 0); } finally { restarted.close(); }
  } finally { h.close(); }
});

test("기존 Schedule read-only 정책은 유지하고 Assistant 전용 client 경계 재사용", async () => {
  const h = harness({ readOnly: true }); try { assert.equal(h.mode.isScheduleRequestAllowed("POST", "/schedules"), false); h.send("조회"); await h.settle();
    assert.equal(h.state.calls[0].init.method, "POST"); assert.equal(h.state.calls[0].url, `${origin}/api/v1/assistant/requests`); assert.equal(h.mode.isScheduleRequestAllowed("POST", "/schedules"), false);
  } finally { h.close(); }
});
