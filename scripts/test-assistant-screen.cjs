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
function harness({ initialMode = "server", readOnly = false, data = new Map(), initialSnapshot, actualLifecycle = false, snapshotAtSubscribe, notifyOnSubscribe = false } = {}) {
  const cache = new Map(), slots = [], effects = [], timers = new Map(), listeners = new Set();
  let cursor = 0, dirty = false, tree, wall = 1000, mono = 0, timerId = 0, closed = false, displaying = false;
  const state = { app: "active", calls: [], starts: [], uuidCalls: 0, failUuid: false, failStorage: false, throwMessage: false,
    cleanup: 0, lateUpdates: 0, mockRuns: 0, beforeUuid: null, config: null, failRead: false, beforeRead: null,
    recoveryListeners: new Set(), lastRecoveryListener: null, beforeSubscribe: null, initializations: 0, unsubscribed: 0,
    snapshot: initialSnapshot ?? { phase: "settled", initialCheck: "checked", serverId, results: [] },
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
    useRef(initial) { if (displaying) return { current: initial }; return slots[cursor++] ??= { current: initial }; },
    useCallback(fn, deps) { if (displaying) return fn; const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: fn }; return slots[i].value; },
    useEffect(fn, deps) { if (displaying) return; const i = cursor++; if (!same(slots[i]?.deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
    useImperativeHandle() {},
  };
  const setTimer = (fn, ms) => { const token = ++timerId; timers.set(token, { fn, at: mono + ms, ms }); return token; };
  const clearTimer = token => timers.delete(token);
  const send = (url, init) => { state.calls.push({ url, init }); return state.handle(url, init); };
  const adapter = { async getItem(key) { if (state.beforeRead) await state.beforeRead(); if (state.failRead) throw Error("조회 실패"); return data.get(key) ?? null; }, async setItem(key, value) { if (state.failStorage) throw Error("저장 실패"); data.set(key, value); } };
  const native = { AppState: { get currentState() { return state.app; }, addEventListener(event, listener) { assert.equal(event, "change"); listeners.add(listener); return { remove: () => listeners.delete(listener) }; } },
    KeyboardAvoidingView: "KeyboardAvoidingView", FlatList: "FlatList", Keyboard: { isVisible: () => false }, Platform: { OS: "ios" }, StyleSheet: { create: s => s }, Text: "Text", View: "View", Pressable: "Pressable" };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: file }).outputText;
    function resolve(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { Fragment: "Fragment", jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
      if (name === "react-native") return native;
      if (name === "zustand" || name === "zustand/vanilla") return require(name);
      if (name === "expo/fetch") return { fetch: send };
      if (name === "@react-native-async-storage/async-storage") return adapter;
      if (name === "expo-crypto") return { randomUUID: () => { state.uuidCalls++; state.beforeUuid?.(); if (state.failUuid) throw Error("UUID 실패"); return randomUUID(); } };
      if (["@/components/assistant/assistant-message", "@/components/assistant/assistant-schedule-card"].includes(name)) return load(path.join(root, "src", `${name.slice(2)}.tsx`));
      if (name.startsWith("@/components/")) { const component = name.split("/").at(-1).split("-").map(s => s[0].toUpperCase() + s.slice(1)).join(""); return { [component]: component }; }
      if (name === "@/constants/theme") return { Spacing: { one: 4, two: 8, three: 16 } };
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
  const lifecycleModule = source("src/services/api/assistant-lifecycle.ts");
  const realLifecycle = lifecycleModule.createAssistantLifecycle({ http, orchestrator: { initializeRecovery: options => { state.initializations++; return orchestrator.initializeRecovery(options); } } });
  const lifecycle = actualLifecycle ? realLifecycle : { getSnapshot: () => state.snapshot, subscribe(listener) {
    state.recoveryListeners.add(listener); state.lastRecoveryListener = listener;
    if (snapshotAtSubscribe) state.snapshot = snapshotAtSubscribe;
    state.beforeSubscribe?.(); if (notifyOnSubscribe) listener();
    return () => { state.recoveryListeners.delete(listener); state.unsubscribed++; };
  } };
  lifecycleModule.assistantLifecycle = lifecycle;
  const mockService = source("src/services/mock/assistant.ts"), originalMock = mockService.runMockAssistantScenario;
  mockService.runMockAssistantScenario = (...args) => { state.mockRuns++; return originalMock(...args); };
  const Screen = source("src/app/(tabs)/assistant.tsx").default;
  function render() { let limit = 30; do { dirty = false; cursor = 0; tree = Screen(); while (effects.length) effects.shift()(); } while (dirty && --limit); assert.ok(limit); }
  function find(type, node = tree) { if (!node) return null; if (Array.isArray(node)) return node.map(n => find(type, n)).find(Boolean); if (node.type === type) return node.props; return node.props?.children === undefined ? null : find(type, node.props.children); }
  async function settle() { for (let n = 0; n < 350; n++) await Promise.resolve(); if (!closed) render(); }
  async function advance(ms) { const target = mono + ms; let count = 0; while (true) { const next = Math.min(...[...timers.values()].map(t => t.at)); if (next > target) break; if (++count > 500) throw Error("타이머 반복"); wall += next - mono; mono = next;
      for (const [key, timer] of [...timers]) if (timer.at <= mono) { timers.delete(key); timer.fn(); } await settle(); } wall += target - mono; mono = target; await settle(); }
  function renderConversation(messages = find("ConversationList").messages) {
    // FlatList의 실제 renderItem과 표시 컴포넌트를 실행한다. 스크롤/native effect는 실행하지 않는다.
    let list; displaying = true;
    try { list = source("src/components/assistant/conversation-list.tsx").ConversationList({ ...find("ConversationList"), messages }); }
    finally { displaying = false; }
    assert.equal(list.type, "FlatList");
    const components = [];
    function expand(node) {
      if (!node || typeof node !== "object") return node;
      if (Array.isArray(node)) return node.map(expand);
      if (typeof node.type === "function") { components.push({ name: node.type.name, props: node.props, key: node.key }); return expand(node.type(node.props)); }
      return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
    }
    return { list, components, rows: messages.map(item => expand(list.props.renderItem({ item }))) };
  }
  render();
  return { state, source, storage, data, mock, mode, delegate, lifecycle, render, renderConversation, find, settle, advance, timers, listeners,
    get wall() { return wall; }, set wall(value) { wall = value; },
    messages: () => find("ConversationList").messages,
    edit(text) { find("MessageInput").onChangeText(text); render(); },
    send(text) { this.edit(text); find("MessageInput").onSend(); render(); },
    switchMode(value) { mode.scheduleDataModeStore.getState().setMode(value); render(); },
    publishSnapshot(snapshot) { state.snapshot = snapshot; for (const listener of [...state.recoveryListeners]) listener(); render(); },
    attachLifecycle: () => realLifecycle.attach(),
    app(value) { state.app = value; for (const listener of [...listeners]) listener(value); },
    close() { if (closed) return; closed = true; slots.forEach(slot => slot?.cleanup?.()); },
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

for (const kind of Object.keys(results)) test(`완료 결과 ${kind}: 서버 text·kind·전체 식별 정보 보존, Mock interaction 없음`, async () => {
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

function nodes(node, type) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(item => nodes(item, type));
  return [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
}
function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  return Array.isArray(node) ? node.map(textOf).join("\n") : textOf(node.props?.children);
}
const cards = view => view.components.filter(item => item.name === "AssistantScheduleCard");
function responseWith(result) {
  return async (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202)
    : json({ ...status(url.split("/").pop(), "completed"), result });
}
async function showResult(result, verify) {
  const h = harness(), mockBefore = h.mock.getState().schedules;
  h.state.handle = responseWith(result);
  try {
    h.send("표시 시험"); await h.settle(); const original = h.messages().at(-1).apiExecution, serialized = JSON.stringify(original);
    assert.equal(original.kind, "completed"); const calls = h.state.calls.length, persisted = [...h.data.values()].join("");
    const view = h.renderConversation(); await verify(h, view, original);
    assert.equal(JSON.stringify(original), serialized); assert.equal(h.messages().at(-1).apiExecution, original);
    assert.equal(h.state.calls.length, calls); assert.equal(h.state.starts.length, 1); assert.equal(h.state.cleanup, 0);
    assert.equal([...h.data.values()].join(""), persisted); assert.strictEqual(h.mock.getState().schedules, mockBefore); assert.equal(h.state.mockRuns, 0);
    assert.ok(h.state.calls.every(c => c.url.startsWith(`${origin}/api/v1/assistant/requests`)));
  } finally { h.close(); }
}

for (const kind of Object.keys(results)) test(`실제 목록→메시지→카드: ${kind} 분기·text 원문·식별값과 부수 효과 0회`, async () => {
  const result = { ...results[kind], text: "  서버 원문\n일정을 삭제했어요? 문구로 판단하지 않음  " };
  await showResult(result, (h, view, original) => {
    assert.equal(nodes(view.rows[1], "Text")[0].props.children, result.text);
    const props = view.components.find(item => item.name === "AssistantMessage").props;
    assert.equal(props.apiResult.kind, kind); assert.equal(props.onCandidateSelection, undefined); assert.equal(props.onDeleteConfirmation, undefined);
    assert.deepEqual(original.response.data.result, result); assert.equal(original.reference.requestId, original.response.data.requestId); assert.equal(original.response.data.conversationId, id(100));
    if ("questionId" in result) assert.equal(props.apiResult.questionId, result.questionId);
    if ("expiresAt" in result) assert.equal(props.apiResult.expiresAt, result.expiresAt);
    if (kind === "failure" || kind === "uncertain") {
      assert.equal(props.apiResult.code, result.code); assert.equal(props.apiResult.nextAction, result.nextAction); assert.equal(cards(view).length, 0);
      assert.ok(textOf(view.rows).includes(kind === "failure" ? "처리 실패" : "결과 미확인")); assert.equal(Object.hasOwn(props.apiResult, "schedulesChanged"), false);
    }
    for (const button of nodes(view.rows, "Pressable")) { assert.equal(button.props.disabled, true); assert.deepEqual(button.props.accessibilityState, { disabled: true }); assert.equal(button.props.onPress, undefined); button.props.onPress?.(); }
    h.render(); assert.equal(h.state.starts.length, 1);
  });
});

for (const count of [2, 10]) test(`후보 ${count}건 전체·opaque key·5종 category·KST 날짜 경계 표시`, async () => {
  const categories = ["INBOUND", "INVENTORY", "OUTBOUND", "RETURN", "OTHER"], labels = ["입고", "재고", "출고", "반품", "기타"];
  const candidates = Array.from({ length: count }, (_, n) => ({ candidateId: `opaque:/선택 값 ${n}`, title: `후보 ${n}`, scheduledAt: "2026-11-12T15:05:32.123456Z", category: categories[n % 5] }));
  await showResult({ ...results.candidate_selection, candidates }, (h, view) => {
    const buttons = nodes(view.rows, "Pressable"); assert.equal(buttons.length, count); assert.equal(cards(view).length, count);
    for (let n = 0; n < count; n++) {
      assert.equal(buttons[n].key, candidates[n].candidateId); const display = cards(view)[n].props.schedule;
      assert.equal(display.candidateId, candidates[n].candidateId); assert.equal(display.title, candidates[n].title); assert.equal(display.category, labels[n % 5]);
      assert.equal(display.date, "2026-11-13"); assert.equal(display.time, "00:05"); assert.equal(display.scheduledAt, candidates[n].scheduledAt);
      for (const field of ["id", "scheduleId", "completed"]) assert.equal(Object.hasOwn(display, field), false);
    }
    assert.match(textOf(view.rows), /11월 13일 \(금\) 오전 12:05/);
  });
});

test("update 확인의 실제 target·제목/일시/category/completed 변경 전후 표시", async () => {
  const result = { ...results.confirmation, target: { ...summary, scheduledAt: "2026-11-12T15:05:00Z", category: "RETURN" }, changes: { title: "변경 제목", scheduledAt: "2026-11-13T04:10:00Z", category: "OUTBOUND", completed: true } };
  await showResult(result, (h, view) => {
    const body = textOf(view.rows); assert.match(body, /수정 대상/); assert.match(body, /제목: 원본 일정 → 변경 제목/);
    assert.match(body, /일시: 11월 13일 \(금\) 오전 12:05 → 11월 13일 \(금\) 오후 1:10/); assert.match(body, /분류: 반품 → 출고/); assert.match(body, /완료 상태: 미완료 → 완료/);
    assert.equal(cards(view).length, 1); assert.equal(cards(view)[0].props.schedule.id, summary.id); assert.equal(cards(view)[0].props.schedule.title, summary.title);
    assert.equal(nodes(view.rows, "Pressable").length, 2);
  });
});

test("delete 확인에는 target과 비활성 예/아니요만 있고 changes 합성 없음", async () => {
  const { changes, ...base } = results.confirmation; assert.ok(changes);
  await showResult({ ...base, operation: "delete" }, (h, view) => {
    const props = view.components.find(item => item.name === "AssistantMessage").props;
    assert.equal(props.apiResult.operation, "delete"); assert.equal(Object.hasOwn(props.apiResult, "changes"), false);
    assert.match(textOf(view.rows), /삭제 대상/); assert.doesNotMatch(textOf(view.rows), /완료 상태:|제목:|일시:|분류:/); assert.equal(cards(view).length, 1);
    assert.deepEqual(nodes(view.rows, "Pressable").map(button => textOf(button)), ["아니요", "예"]);
  });
});

for (const completed of [true, false]) test(`완료 변경 ${completed}는 update changes.completed로 표시`, async () => {
  await showResult({ ...results.confirmation, target: { ...summary, completed: !completed }, changes: { completed } }, (h, view) => {
    const body = textOf(view.rows); assert.ok(body.includes(completed ? "완료 상태: 미완료 → 완료" : "완료 상태: 완료 → 미완료"));
    assert.equal(cards(view).length, 1); assert.doesNotMatch(body, /분류:|제목:|일시:/);
  });
});

for (const count of [0, 3]) test(`조회 items ${count}건: 정상 조회·실제 일정 ID/card key·선택/전송 없음`, async () => {
  const items = Array.from({ length: count }, (_, n) => ({ ...summary, id: id(400 + n), title: `조회 일정 ${n}`, completed: n % 2 === 0 }));
  await showResult({ ...results.outcome, items }, (h, view) => {
    assert.equal(cards(view).length, count); assert.match(textOf(view.rows), /조회 완료/); assert.equal(nodes(view.rows, "Pressable").length, 0);
    cards(view).forEach((card, n) => { assert.equal(card.key, items[n].id); assert.equal(card.props.schedule.id, items[n].id); assert.equal(card.props.schedule.completed, items[n].completed); assert.equal(card.props.showCompleted, true); });
  });
});

for (const [operation, label] of [["create", "등록"], ["update", "수정"], ["delete", "삭제"]]) test(`outcome success/${operation}: 변경 ID 보존·추측 카드와 Schedule write 없음`, async () => {
  const result = { kind: "outcome", text: "서버 완료 문구", outcome: "success", operation, schedulesChanged: true, affectedScheduleIds: [summary.id] };
  await showResult(result, (h, view) => {
    assert.ok(textOf(view.rows).includes(`${label} 완료`)); assert.equal(cards(view).length, 0);
    const mapped = view.components.find(item => item.name === "AssistantMessage").props.apiResult; assert.equal(mapped.schedulesChanged, true); assert.deepEqual(mapped.affectedScheduleIds, [summary.id]); assert.equal(Object.hasOwn(mapped, "items"), false);
  });
});

for (const outcome of ["cancelled", "no_match"]) test(`outcome ${outcome}: 성공과 분리·optional operation 보존`, async () => {
  const result = { kind: "outcome", text: "서버 원문", outcome, schedulesChanged: false, ...(outcome === "no_match" ? { operation: "list" } : {}) };
  await showResult(result, (h, view) => {
    assert.ok(textOf(view.rows).includes(outcome === "cancelled" ? "취소됨" : "대상 없음")); assert.doesNotMatch(textOf(view.rows), /완료/); assert.equal(cards(view).length, 0);
    const mapped = view.components.find(item => item.name === "AssistantMessage").props.apiResult; assert.equal(mapped.outcome, outcome); assert.equal(mapped.schedulesChanged, false); assert.equal(Object.hasOwn(mapped, "operation"), outcome === "no_match");
  });
});

test("API 메시지에 Mock 필드를 섞어도 목록이 Mock 카드·interaction·callback을 전달하지 않음", async () => {
  await showResult(results.candidate_selection, (h) => {
    const message = h.messages().at(-1), mixed = { ...message, schedules: h.mock.getState().schedules, interaction: { type: "delete-confirmation", scheduleId: h.mock.getState().schedules[0].id, resolved: false } };
    const view = h.renderConversation([mixed]), props = view.components.find(item => item.name === "AssistantMessage").props;
    assert.equal(props.interaction, undefined); assert.equal(props.schedules, undefined); assert.equal(props.onDeleteConfirmation, undefined); assert.equal(props.onCandidateSelection, undefined); assert.equal(cards(view).length, 2);
  });
});

test("취소 결과에 operation이 있으면 해당 작업만 표시하고 없던 작업을 생성하지 않음", async () => {
  await showResult({ kind: "outcome", text: "취소 문구", outcome: "cancelled", operation: "delete", schedulesChanged: false }, (h, view) => {
    assert.match(textOf(view.rows), /삭제 취소됨/); assert.equal(cards(view).length, 0);
    assert.equal(view.components.find(item => item.name === "AssistantMessage").props.apiResult.operation, "delete");
  });
});

test("실제 Mock 후보·예/아니요는 활성 상태와 기존 삭제 동작 유지", async () => {
  const h = harness({ initialMode: "mock" }); try {
    h.send("재고 일정 삭제해 줘"); await h.advance(700); let view = h.renderConversation(), buttons = nodes(view.rows, "Pressable");
    assert.ok(buttons.length >= 2); assert.equal(buttons[0].props.disabled, false); buttons[0].props.onPress(); h.render();
    view = h.renderConversation(); buttons = nodes(view.rows.at(-1), "Pressable"); assert.deepEqual(buttons.map(textOf), ["아니요", "예"]); assert.ok(buttons.every(button => !button.props.disabled));
    const before = h.mock.getState().schedules.length; buttons[1].props.onPress(); h.render(); assert.equal(h.mock.getState().schedules.length, before - 1); assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("실제 Mock 삭제 거절 버튼은 데이터 유지·이전 승인 무효화·HTTP 0회", async () => {
  const h = harness({ initialMode: "mock" }); try {
    h.send("작업장 안전 점검 삭제해 줘"); await h.advance(700);
    const before = h.mock.getState().schedules, message = h.messages().at(-1);
    const buttons = nodes(h.renderConversation().rows.at(-1), "Pressable");
    assert.deepEqual(buttons.map(textOf), ["아니요", "예"]); assert.ok(buttons.every(button => !button.props.disabled));
    const lateApproval = buttons[1].props.onPress; buttons[0].props.onPress(); h.render();
    assert.strictEqual(h.mock.getState().schedules, before);
    assert.equal(h.messages().find(item => item.id === message.id).interaction.resolved, true);
    const count = h.messages().length; lateApproval(); h.render();
    assert.equal(h.messages().length, count); assert.strictEqual(h.mock.getState().schedules, before);
    assert.equal(h.find("MessageInput").disabled, false); assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("표시 반복·키 추출은 원본 메시지와 API metadata를 변경하거나 정리하지 않음", async () => {
  await showResult(results.outcome, (h, view) => {
    const messages = h.messages(), ids = messages.map(view.list.props.keyExtractor), raw = JSON.stringify(messages);
    for (let n = 0; n < 4; n++) { const repeated = h.renderConversation(); assert.deepEqual(messages.map(repeated.list.props.keyExtractor), ids); }
    assert.equal(JSON.stringify(messages), raw); assert.strictEqual(h.messages(), messages); assert.equal(h.state.cleanup, 0);
  });
});

test("완료되지 않은 API 오류 메시지는 과거 응답으로 상세 성공 카드를 만들지 않음", async () => {
  const h = harness(); try {
    h.state.handle = async () => { throw Error("네트워크 실패"); }; h.send("조회"); await h.settle();
    const view = h.renderConversation(); assert.equal(cards(view).length, 0); assert.equal(nodes(view.rows, "Pressable").length, 0);
    assert.equal(h.messages().at(-1).apiExecution.kind, "needs-attention"); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

const recoveryRef = (requestId = id(600), server = serverId) => ({ requestId, serverId: server });
const recovered = (kind = "outcome", requestId = id(600), server = serverId) => ({ kind: "completed", reference: recoveryRef(requestId, server),
  response: { ok: true, data: done(requestId, kind), status: 200, serverId: server, httpRequestId: id(900), metadata: { status: "updated" } } });
const observedRecovery = (value = "processing", requestId = id(600)) => ({ kind: "observed", reference: recoveryRef(requestId),
  response: { ok: true, data: status(requestId, value), status: 200, serverId, httpRequestId: id(900), metadata: { status: "updated" } } });
function snapshotOf(executions = [], extra = {}) {
  return { phase: "settled", initialCheck: "checked", serverId, results: executions.map(execution => ({ reference: execution.reference,
    latestResult: execution, lastResponse: execution.kind === "needs-attention" ? execution.lastResponse : execution.response })), ...extra };
}
const recoveredError = (kind, httpStatus, code) => ({ kind: "needs-attention", reason: "unconfirmed", reference: recoveryRef(),
  recoveryResult: { kind: "unconfirmed", reason: "http-error", reference: recoveryRef(), retransmitted: false,
    getResult: { ok: false, error: { kind, operation: "get", requestState: "response-received", status: httpStatus, serverId, assistantRequestId: id(600),
      ...(code ? { problem: { type: "https://example.invalid/problem", title: "오류", status: httpStatus, detail: "문구 파싱 금지", instance: "/api/v1/assistant/requests", requestId: id(900), code, assistantRequestId: id(600), blockingRequestId: id(601), activeQuestionId: id(602), activeQuestionRequestId: id(603) } } : {}) } } } });

for (const kind of Object.keys(results)) test(`초기 복구 ${kind}: 실제 상세 표시·원본 context 유지·UserMessage/POST/정리 0회`, async () => {
  const execution = recovered(kind), snapshot = snapshotOf([execution]);
  const h = harness({ initialSnapshot: snapshot }); try {
    await h.settle(); assert.equal(h.messages().length, 1); assert.equal(h.messages()[0].role, "assistant");
    assert.deepEqual(h.messages()[0].apiExecution, execution); const view = h.renderConversation();
    assert.equal(nodes(view.rows, "Text")[0].props.children, results[kind].text); assert.equal(h.state.calls.length, 0); assert.equal(h.state.uuidCalls, 0); assert.equal(h.state.cleanup, 0);
    for (const button of nodes(view.rows, "Pressable")) { assert.equal(button.props.disabled, true); assert.equal(button.props.onPress, undefined); }
    assert.equal(h.state.initializations, 0); assert.equal(h.state.recoveryListeners.size, 1);
  } finally { h.close(); }
});

for (const notifyOnSubscribe of [false, true]) test(`구독 경계 ${notifyOnSubscribe ? "동기 알림" : "알림 누락"}도 최신 snapshot을 다시 읽어 표시`, async () => {
  const h = harness({ initialSnapshot: snapshotOf(), snapshotAtSubscribe: snapshotOf([recovered()]), notifyOnSubscribe });
  try { await h.settle(); assert.equal(h.messages().length, 1); assert.equal(h.messages()[0].text, results.outcome.text); assert.equal(h.state.calls.length, 0); }
  finally { h.close(); }
});

test("구독 결과 갱신·반복 snapshot·UUID 대소문자는 같은 메시지 ID/위치 유지", async () => {
  const h = harness(); try {
    h.publishSnapshot(snapshotOf([observedRecovery("accepted")])); const messageId = h.messages()[0].id;
    h.publishSnapshot(snapshotOf([observedRecovery("processing")])); assert.equal(h.messages()[0].id, messageId);
    h.publishSnapshot(snapshotOf([recovered("uncertain", id(600).toUpperCase())]));
    for (let n = 0; n < 4; n++) h.publishSnapshot(snapshotOf([recovered("uncertain")]));
    assert.equal(h.messages().length, 1); assert.equal(h.messages()[0].id, messageId); assert.equal(h.messages()[0].apiExecution.response.data.result.kind, "uncertain");
    h.publishSnapshot(snapshotOf([recovered("outcome")])); assert.equal(h.messages().length, 1); assert.equal(h.messages()[0].id, messageId); assert.equal(h.messages()[0].apiExecution.response.data.result.kind, "outcome");
    assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("5-A 완료 후 복구 완료도 기존 사용자/응답 ID·순서를 유지하며 중복 추가 없음", async () => {
  const h = harness(); try {
    h.send("원래 입력"); await h.settle(); const ids = h.messages().map(m => m.id), execution = h.messages().at(-1).apiExecution;
    h.publishSnapshot(snapshotOf([execution])); h.publishSnapshot(snapshotOf([execution]));
    assert.deepEqual(h.messages().map(m => m.id), ids); assert.equal(h.messages().filter(m => m.role === "user").length, 1); assert.equal(h.state.starts.length, 1);
  } finally { h.close(); }
});

test("복구 완료 뒤 늦은 최초 완료·중단 callback은 최신 outcome을 되돌리지 않음", async () => {
  for (const lateKind of ["completed", "needs-attention"]) {
    const h = harness(), gate = deferred(); h.delegate.startRequest = (body, options) => { h.state.starts.push([body, options]); return { initial: gate.promise, completion: gate.promise, cancel() {} }; };
    try {
      h.send("원래 입력"); const requestId = h.state.starts[0][0].requestId;
      h.publishSnapshot(snapshotOf([recovered("outcome", requestId)])); const ids = h.messages().map(m => m.id);
      gate.resolve(lateKind === "completed" ? recovered("uncertain", requestId) : { kind: "needs-attention", reason: "paused", reference: recoveryRef(requestId) }); await h.settle();
      assert.deepEqual(h.messages().map(m => m.id), ids); assert.equal(h.messages().at(-1).apiExecution.response.data.result.kind, "outcome"); assert.equal(h.state.starts.length, 1);
    } finally { h.close(); }
  }
});

test("accepted/processing 복구는 processing 표시만 사용하며 completed 카드로 변환하지 않음", async () => {
  const h = harness(); try {
    for (const value of ["accepted", "processing"]) {
      h.publishSnapshot(snapshotOf([observedRecovery(value)], { phase: "observing" }));
      assert.equal(h.find("ConversationList").isProcessing, true); assert.equal(cards(h.renderConversation()).length, 0);
      assert.equal(h.messages()[0].apiExecution.kind, "observed"); assert.equal(Object.hasOwn(h.messages()[0].apiExecution.response.data, "result"), false);
    }
    h.publishSnapshot(snapshotOf([recovered()])); assert.equal(h.find("ConversationList").isProcessing, false); assert.equal(h.messages().length, 1);
  } finally { h.close(); }
});

test("과거 완료 응답을 포함한 조회 실패는 최신 오류로 보존하고 성공 카드 재표시 없음", async () => {
  const h = harness({ initialSnapshot: snapshotOf([recovered()]) }); try {
    const failure = recoveredError("http", 503, "ASSISTANT_UNAVAILABLE"), lastResponse = recovered().response;
    h.publishSnapshot({ ...snapshotOf([failure], { phase: "needs-attention" }), results: [{ reference: failure.reference, latestResult: failure, lastResponse }] });
    const message = h.messages()[0]; assert.equal(message.apiExecution.kind, "needs-attention"); assert.deepEqual(message.apiExecution.lastResponse, lastResponse); assert.equal(cards(h.renderConversation()).length, 0);
    assert.equal(message.apiExecution.recoveryResult.getResult.error.problem.code, "ASSISTANT_UNAVAILABLE"); assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

for (const [kind, code, errorCode] of [["http", 404, "ASSISTANT_REQUEST_NOT_FOUND"], ["http", 404, "ROUTE_NOT_FOUND"], ["http", 410, "REQUEST_EXPIRED"], ["http", 503, "ASSISTANT_UNAVAILABLE"], ["timeout"], ["network"], ["response"]]) test(`복구 오류 ${errorCode ?? kind}: 빈 대화와 구분·원인/복구 필드 보존·POST 없음`, async () => {
  const failure = recoveredError(kind, code, errorCode), h = harness({ initialSnapshot: snapshotOf([failure], { phase: "needs-attention" }) });
  try { assert.equal(h.messages().length, 1); assert.equal(h.messages()[0].apiExecution.kind, "needs-attention");
    assert.deepEqual(h.messages()[0].apiExecution.recoveryResult.getResult.error, failure.recoveryResult.getResult.error);
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.cleanup, 0); assert.equal(cards(h.renderConversation()).length, 0);
  } finally { h.close(); }
});

test("빈 복구와 저장소 초기화 실패를 구분하고 실패 중 신규 POST는 차단", async () => {
  const h = harness(); try {
    assert.deepEqual(h.messages(), []); const snapshot = snapshotOf([], { phase: "needs-attention", initialCheck: "failed", initialization: { kind: "needs-attention", reason: "storage", storageCode: "unknown" } });
    h.publishSnapshot(snapshot); assert.equal(h.messages().length, 1); assert.deepEqual(h.messages()[0].recoveryIssue.initialization, snapshot.initialization);
    h.send("새 입력"); assert.equal(h.state.starts.length, 0); assert.equal(h.state.uuidCalls, 0); assert.equal(h.find("MessageInput").value, "새 입력"); assert.equal(h.messages().length, 1);
    h.publishSnapshot(snapshotOf()); assert.deepEqual(h.messages(), []); h.find("MessageInput").onSend(); await h.settle(); assert.equal(h.state.starts.length, 1);
  } finally { h.close(); }
});

test("최초 snapshot 확인 전 잠금·UUID 생성 중 새 복구 시작도 POST 이전 재검사", async () => {
  const pendingSnapshot = snapshotOf([], { phase: "recovering", initialCheck: "pending" }), h = harness({ initialSnapshot: pendingSnapshot });
  try {
    h.send("새 입력"); assert.equal(h.state.starts.length, 0); assert.equal(h.state.uuidCalls, 0); assert.equal(h.find("MessageInput").disabled, true);
    h.publishSnapshot(snapshotOf()); h.state.beforeUuid = () => h.publishSnapshot(pendingSnapshot);
    h.find("MessageInput").onSend(); await h.settle(); assert.equal(h.state.starts.length, 0); assert.equal(h.find("MessageInput").value, "새 입력"); assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("Mock에서 복구 결과 숨김·서버 복귀 구독 표시·Mock 후보 기능 유지", async () => {
  const h = harness({ initialMode: "mock", initialSnapshot: snapshotOf([recovered()]) }); try {
    assert.deepEqual(h.messages(), []); h.send("재고 일정 삭제해 줘"); await h.advance(700); const mockId = h.messages().at(-1).id;
    h.publishSnapshot(snapshotOf([recovered("confirmation")])); assert.equal(h.messages().some(m => m.apiExecution), false);
    h.switchMode("server"); h.publishSnapshot(snapshotOf([recovered("confirmation")])); assert.equal(h.messages().some(m => m.id === mockId), false); assert.equal(h.messages().filter(m => m.apiExecution).length, 1);
    h.switchMode("mock"); assert.equal(h.messages().some(m => m.apiExecution), false); assert.ok(h.messages().some(m => m.id === mockId)); assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("서버 변경 뒤 이전 서버·같은 ID의 늦은 결과는 숨기고 새 서버 결과만 표시", async () => {
  const h = harness({ initialSnapshot: snapshotOf([recovered()]) }), other = "development:https://other.example.invalid";
  try {
    h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid");
    h.publishSnapshot(snapshotOf([recovered("uncertain")])); assert.equal(h.messages().some(m => m.apiExecution), false);
    h.publishSnapshot(snapshotOf([recovered("failure", id(600), other)], { serverId: other })); assert.equal(h.messages().filter(m => m.apiExecution).length, 1); assert.equal(h.messages().at(-1).apiExecution.reference.serverId, other);
    assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("화면 재렌더는 구독 1개·세션 유지, unmount 후 늦은 구독 callback 갱신 0회", async () => {
  const h = harness({ initialSnapshot: snapshotOf([recovered()]) }); const messages = h.messages();
  for (let n = 0; n < 5; n++) h.render(); assert.equal(h.state.recoveryListeners.size, 1); assert.strictEqual(h.messages(), messages);
  h.close(); assert.equal(h.state.recoveryListeners.size, 0); assert.equal(h.state.unsubscribed, 1);
  h.state.snapshot = snapshotOf([recovered("failure")]); h.state.lastRecoveryListener(); await h.settle(); assert.equal(h.state.lateUpdates, 0); assert.strictEqual(h.messages(), messages);
});

test("실제 lifecycle cold start: GET-only 복구·과거 UserMessage/채팅/body 저장 0회", async () => {
  const h = harness({ actualLifecycle: true }); await h.storage.saveBeforePost(recoveryRef(), 1000); const detach = h.attachLifecycle();
  try {
    await h.settle(); assert.deepEqual(h.state.calls.map(c => c.init.method), ["GET"]); assert.equal(h.messages().length, 1); assert.equal(h.messages()[0].role, "assistant");
    assert.equal(h.messages()[0].apiExecution.reference.requestId, id(600)); assert.equal(h.lifecycle.getSnapshot().initialCheck, "checked"); assert.equal(h.state.initializations, 1); assert.equal(h.state.cleanup, 0);
    const persisted = [...h.data.values()].join(""); assert.equal(persisted.includes('"messages"'), false); assert.equal(persisted.includes('"input"'), false);
    const restarted = harness({ actualLifecycle: true, data: h.data }); try { assert.deepEqual(restarted.messages(), []); assert.equal(restarted.state.calls.length, 0); } finally { restarted.close(); }
  } finally { h.close(); detach(); await h.settle(); }
});

test("실제 lifecycle의 모든 최초 GET 완료 전 POST 차단·pending 기록 존재만으로 영구 차단 안 함", async () => {
  const h = harness({ actualLifecycle: true }), gate = deferred();
  await h.storage.saveBeforePost(recoveryRef(), 1000); await h.storage.saveBeforePost(recoveryRef(id(601)), 1000);
  h.state.handle = async (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202)
    : url.endsWith(id(601)) ? gate.promise : json(url.endsWith(id(600)) ? status(id(600), "processing") : done(url.split("/").pop()));
  const detach = h.attachLifecycle();
  try {
    await h.settle(); assert.equal(h.state.calls.length, 2); assert.equal(h.lifecycle.getSnapshot().initialCheck, "pending"); h.send("새 독립 작업"); assert.equal(h.state.starts.length, 0);
    gate.resolve(json(done(id(601)))); await h.settle(); assert.equal(h.lifecycle.getSnapshot().initialCheck, "checked"); assert.equal(h.lifecycle.getSnapshot().phase, "observing");
    assert.equal(h.find("MessageInput").disabled, false); h.find("MessageInput").onSend(); await h.settle(); assert.equal(h.state.starts.length, 1);
    assert.equal(h.state.calls.filter(c => c.init.method === "POST").length, 1); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); detach(); await h.settle(); }
});

test("실제 lifecycle 저장소 읽기 실패는 원인 보존·데이터 삭제/POST 0회", async () => {
  const h = harness({ actualLifecycle: true }); await h.storage.saveBeforePost(recoveryRef(), 1000); const before = [...h.data.values()].join(""); h.state.failRead = true; const detach = h.attachLifecycle();
  try {
    await h.settle(); assert.equal(h.lifecycle.getSnapshot().initialCheck, "failed"); assert.equal(h.messages()[0].recoveryIssue.initialization.reason, "storage");
    h.send("새 입력"); assert.equal(h.state.starts.length, 0); assert.equal(h.state.calls.length, 0); assert.equal([...h.data.values()].join(""), before); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); detach(); await h.settle(); }
});

test("실제 foreground의 120초 경과 단발 GET·deadline 안내·중복 메시지/POST 없음", async () => {
  const h = harness({ actualLifecycle: true }); await h.storage.saveBeforePost(recoveryRef(), 1000); h.wall = 121000;
  h.state.handle = async url => json(status(url.split("/").pop(), "processing")); const detach = h.attachLifecycle();
  try {
    await h.settle(); assert.equal(h.state.calls.length, 1); assert.equal(h.messages()[0].apiExecution.reason, "deadline"); assert.equal(h.find("ConversationList").isProcessing, false); const messageId = h.messages()[0].id;
    h.app("background"); await h.settle(); h.app("active"); await h.settle(); assert.equal(h.state.calls.length, 2); assert.equal(h.messages().length, 1); assert.equal(h.messages()[0].id, messageId); assert.equal(h.state.cleanup, 0);
    assert.ok(h.state.calls.every(c => c.init.method === "GET"));
  } finally { h.close(); detach(); await h.settle(); }
});

test("uncertain 복구 수신은 위험 인지가 아니며 새 text에도 acknowledgement 자동 추가 없음", async () => {
  const h = harness({ initialSnapshot: snapshotOf([recovered("uncertain")]) });
  h.state.handle = async () => ({ status: 409, headers: new Headers({ "Content-Type": "application/problem+json", "X-Request-ID": id(900) }), text: async () => JSON.stringify({ type: "https://example.invalid/problem", title: "보류", status: 409, detail: "문구 파싱 금지", instance: "/api/v1/assistant/requests", requestId: id(900), code: "UNRESOLVED_UNCERTAIN", blockingRequestId: id(600) }) });
  try {
    assert.equal(h.messages()[0].apiExecution.response.data.result.kind, "uncertain"); assert.equal(h.state.calls.length, 0); h.send("새 독립 작업"); await h.settle();
    assert.equal(h.state.calls.length, 1); const body = JSON.parse(h.state.calls[0].init.body); assert.equal(Object.hasOwn(body, "acknowledgedUncertainRequestId"), false); assert.equal(Object.hasOwn(body, "conversationId"), false);
    assert.equal(h.messages().at(-1).apiExecution.recoveryResult.postResult.error.problem.code, "UNRESOLVED_UNCERTAIN"); assert.equal(h.find("MessageInput").value, "새 독립 작업"); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});
