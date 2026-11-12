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
    new Function("require", "module", "exports", "fetch", "setTimeout", "clearTimeout", "performance", "process", "Date", code)(resolve, module, module.exports,
      () => { throw Error("실제 네트워크 금지"); }, setTimer, clearTimer, { now: () => mono }, { env: { EXPO_PUBLIC_DEV_SERVER_BASE_URL: origin, EXPO_PUBLIC_SCHEDULE_DATA_MODE: initialMode, EXPO_PUBLIC_SCHEDULE_READ_ONLY: String(readOnly) } },
      ["assistant.tsx", "assistant-text-question.ts", "assistant-message.tsx"].some(name => file.endsWith(name)) ? class extends Date { static now() { return wall; } } : Date);
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
    for (const button of nodes(view.rows, "Pressable")) {
      const candidate = kind === "candidate_selection", interactive = candidate || kind === "confirmation";
      assert.equal(button.props.disabled, !interactive); assert.equal(button.props.accessibilityState.disabled, !interactive);
      if (interactive) { if (candidate) assert.equal(button.props.accessibilityState.selected, false); assert.equal(typeof button.props.onPress, "function"); }
      else { assert.equal(button.props.onPress, undefined); }
    }
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

test("delete 확인에는 target과 예/아니요만 있고 changes 합성 없음", async () => {
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

// 정보 보충 후속 text도 실제 화면·저장 장벽·HTTP·polling 경계를 통과시킨다.
const postedBodies = h => h.state.calls.filter(call => call.init.method === "POST").map(call => JSON.parse(call.init.body));
const problemResponse = (code, statusCode = 409, activeQuestion = true) => ({ status: statusCode,
  headers: new Headers({ "Content-Type": "application/problem+json", "X-Request-ID": id(900) }),
  text: async () => JSON.stringify({ type: "https://example.invalid/problem", title: "접수 거절", status: statusCode,
    detail: "질문이나 작업은 문구에서 추측하지 않음", instance: "/api/v1/assistant/requests", requestId: id(900), code,
    ...(code === "STALE_QUESTION" && activeQuestion ? { activeQuestionId: id(305), activeQuestionRequestId: id(605) } : {}) }) });

test("정보 보충: 최초 ID 생략·후속마다 새 UUID·원래 conversation/question 및 원문 보존", async () => {
  const h = harness(); h.state.handle = responseWith(results.need_more_info);
  try {
    h.send("내일 회의 등록해 줘"); await h.settle(); const questionMessage = h.messages().at(-1);
    h.state.handle = responseWith(results.outcome); h.send("  오후 3시  "); await h.settle();
    const [first, follow] = postedBodies(h);
    assert.equal(Object.hasOwn(first, "conversationId"), false); assert.equal(Object.hasOwn(first.input, "questionId"), false);
    assert.notEqual(first.requestId, follow.requestId); assert.match(follow.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(follow, { requestId: follow.requestId, conversationId: id(100), input: { type: "text", text: "  오후 3시  ", questionId: id(300) } });
    assert.equal(questionMessage.text, results.need_more_info.text); assert.equal(h.messages().at(-1).text, results.outcome.text);
    assert.deepEqual(h.messages().map(message => message.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(h.state.uuidCalls, 2); assert.equal(h.state.starts.length, 2); assert.equal(h.state.cleanup, 0);
    assert.equal(h.state.mockRuns, 0); assert.ok(h.state.calls.every(call => call.url.includes("/assistant/requests")));
    const saved = [...h.data.values()].join(""); assert.equal(saved.includes("오후 3시"), false); assert.equal(saved.includes('"input"'), false);
  } finally { h.close(); }
});

test("연속 정보 보충은 최신 questionId·서버 conversationId만 사용하고 자연어로 새 작업을 판별하지 않음", async () => {
  const h = harness(); let question = 300;
  h.state.handle = (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202)
    : json({ ...done(url.split("/").pop()), result: { ...results.need_more_info, text: "등록을 완료했어요.", questionId: id(question++) } });
  try {
    for (const text of ["회의 등록", "오후 3시", "다른 일정을 새로 등록해 줘"]) { h.send(text); await h.settle(); }
    const bodies = postedBodies(h); assert.equal(new Set(bodies.map(body => body.requestId)).size, 3);
    assert.deepEqual(bodies.slice(1).map(body => body.input.questionId), [id(300), id(301)]);
    assert.ok(bodies.slice(1).every(body => body.conversationId === id(100))); assert.equal(h.messages().at(-1).apiExecution.response.data.result.questionId, id(302));
  } finally { h.close(); }
});

for (const kind of ["candidate_selection", "confirmation"]) test(`후속 응답 ${kind}: 상세 표시·식별값 보존·현재 질문 버튼만 활성·추가 write 없음`, async () => {
  const h = harness(); h.state.handle = responseWith(results.need_more_info);
  try {
    h.send("회의 수정"); await h.settle(); h.state.handle = responseWith(results[kind]); h.send("오후 3시"); await h.settle();
    const message = h.messages().at(-1); assert.deepEqual(message.apiExecution.response.data.result, results[kind]);
    const view = h.renderConversation(); assert.ok(cards(view).length > 0);
    assert.ok(nodes(view.rows, "Pressable").every(button => button.props.disabled === false));
    const count = h.state.calls.length; h.find("ConversationList").onCandidateSelection(message.id, "opaque/1");
    h.find("ConversationList").onDeleteConfirmation(message.id, true); await h.settle();
    assert.equal(h.state.calls.length, count); assert.equal(postedBodies(h).length, 2); assert.equal(h.state.mockRuns, 0); assert.equal(h.state.cleanup, 0);
    h.send("네, 다른 일정 등록해 줘"); await h.settle(); assert.equal(h.state.calls.length, count);
    assert.equal(h.find("MessageInput").value, "네, 다른 일정 등록해 줘");
  } finally { h.close(); }
});

for (const kind of ["outcome", "failure", "uncertain"]) test(`후속 완료 ${kind}를 질문으로 오인하지 않고 이전 ID를 재사용하지 않음`, async () => {
  const h = harness(); h.state.handle = responseWith(results.need_more_info);
  try {
    h.send("회의 등록"); await h.settle(); h.state.handle = responseWith({ ...results[kind], text: "몇 시로 등록할까요?" });
    h.send("오후 3시"); await h.settle(); h.send("다음 작업"); await h.settle();
    const body = postedBodies(h).at(-1); assert.equal(Object.hasOwn(body, "conversationId"), false); assert.equal(Object.hasOwn(body.input, "questionId"), false);
    assert.equal(Object.hasOwn(body, "acknowledgedUncertainRequestId"), false); assert.equal(h.messages().at(-1).apiExecution.response.data.result.kind, kind);
  } finally { h.close(); }
});

test("후속 accepted/processing 동안 ref 잠금으로 text 및 interaction 중복 실행 차단", async () => {
  const h = harness(); h.state.handle = responseWith(results.need_more_info); let gets = 0;
  try {
    h.send("회의 등록"); await h.settle();
    h.state.handle = (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202)
      : json(++gets === 1 ? status(url.split("/").pop()) : gets === 2 ? status(url.split("/").pop(), "processing") : done(url.split("/").pop()));
    h.edit("오후 3시"); const send = h.find("MessageInput").onSend; send(); send(); h.render(); await h.settle();
    assert.equal(postedBodies(h).length, 2); assert.equal(h.messages().filter(message => message.role === "assistant").length, 1);
    assert.equal(h.find("MessageInput").disabled, true); assert.equal(h.find("ConversationList").isProcessing, true);
    h.find("ConversationList").onDeleteConfirmation(h.messages()[1].id, true); h.find("MessageInput").onSend();
    await h.advance(1999); assert.equal(gets, 1); await h.advance(1); assert.equal(gets, 2); assert.equal(postedBodies(h).length, 2);
    await h.advance(2000); assert.equal(gets, 3); assert.equal(h.find("MessageInput").disabled, false); assert.equal(h.messages().length, 4);
  } finally { h.close(); }
});

for (const [name, text] of [["공백", " \t\u3000"], ["길이 초과", "가".repeat(501)], ["제어문자", "답\u0001"], ["surrogate", "\ud800"]]) test(`후속 ${name}: POST·UUID 0회, 원래 질문 유지`, async () => {
  const h = harness(); h.state.handle = responseWith(results.need_more_info);
  try {
    h.send("회의 등록"); await h.settle(); h.send(text); await h.settle(); assert.equal(postedBodies(h).length, 1); assert.equal(h.state.uuidCalls, 1);
    assert.equal(h.find("MessageInput").value, text); assert.equal(h.find("MessageInput").disabled, false);
    h.state.handle = responseWith(results.outcome); h.send("오후 3시"); await h.settle(); assert.equal(postedBodies(h).at(-1).input.questionId, id(300));
  } finally { h.close(); }
});

for (const reason of ["storage", "503"]) test(`후속 접수 전 ${reason} 실패: 입력·질문·구조화 오류 보존, 자동 재전송 없음`, async () => {
  const h = harness(); h.state.handle = responseWith(results.need_more_info);
  try {
    h.send("회의 등록"); await h.settle(); const initialCalls = h.state.calls.length;
    if (reason === "storage") h.state.failStorage = true;
    else h.state.handle = () => problemResponse(reason === "503" ? "ASSISTANT_UNAVAILABLE" : reason, reason === "503" ? 503 : 409);
    h.send("오후 3시"); await h.settle();
    assert.equal(h.state.calls.length - initialCalls, reason === "storage" ? 0 : 1); assert.equal(h.find("MessageInput").value, "오후 3시");
    assert.equal(h.find("MessageInput").disabled, false); assert.equal(h.state.starts.length, 2); assert.equal(h.state.cleanup, 0);
    const execution = h.messages().at(-1).apiExecution; assert.equal(execution.kind, "needs-attention");
    h.state.failStorage = false; h.state.handle = responseWith(results.outcome); h.find("MessageInput").onSend(); await h.settle();
    assert.equal(postedBodies(h).at(-1).input.questionId, id(300)); assert.equal(postedBodies(h).at(-1).conversationId, id(100));
  } finally { h.close(); }
});

for (const code of ["STALE_QUESTION", "QUESTION_EXPIRED", "CONVERSATION_EXPIRED"]) test(`후속 ${code}: 오류 보존·과거 질문 재전송 없음·계약상 새 입력 경계`, async () => {
  const h = harness(); h.state.handle = responseWith(results.need_more_info);
  try {
    h.send("회의 등록"); await h.settle(); const firstId = postedBodies(h)[0].requestId;
    h.state.handle = () => problemResponse(code); h.send("오후 3시"); await h.settle();
    const problem = h.messages().at(-1).apiExecution.recoveryResult.postResult.error.problem; assert.equal(problem.code, code);
    if (code === "STALE_QUESTION") { assert.equal(problem.activeQuestionId, id(305)); assert.equal(problem.activeQuestionRequestId, id(605)); }
    h.publishSnapshot(snapshotOf([recovered("need_more_info", firstId)]));
    assert.equal(postedBodies(h).length, 2); assert.equal(h.find("MessageInput").value, "오후 3시");
    h.state.handle = responseWith(results.outcome); h.find("MessageInput").onSend(); await h.settle();
    if (code === "STALE_QUESTION") { assert.equal(postedBodies(h).length, 2); assert.equal(h.find("MessageInput").value, "오후 3시"); }
    else { assert.equal(postedBodies(h).length, 3); assert.equal(Object.hasOwn(postedBodies(h).at(-1), "conversationId"), false);
      assert.equal(Object.hasOwn(postedBodies(h).at(-1).input, "questionId"), false); }
    assert.equal(h.find("MessageInput").disabled, false); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("STALE_QUESTION에 활성 질문이 없으면 자동 POST 없이 지난 질문을 닫고 명시적 새 입력 허용", async () => {
  const h = harness(); h.state.handle = responseWith(results.need_more_info);
  try {
    h.send("회의 등록"); await h.settle(); h.state.handle = () => problemResponse("STALE_QUESTION", 409, false);
    h.send("오후 3시"); await h.settle(); assert.equal(postedBodies(h).length, 2);
    h.state.handle = responseWith(results.outcome); h.send("새 일정 조회"); await h.settle();
    assert.equal(Object.hasOwn(postedBodies(h).at(-1), "conversationId"), false); assert.equal(Object.hasOwn(postedBodies(h).at(-1).input, "questionId"), false);
  } finally { h.close(); }
});

test("STALE_QUESTION 뒤 실제 새 질문 결과를 확인하면 그 questionId로만 명시적 후속 입력 가능", async () => {
  const h = harness(); h.state.handle = responseWith(results.need_more_info);
  try {
    h.send("회의 등록"); await h.settle(); h.state.handle = () => problemResponse("STALE_QUESTION"); h.send("오후 3시"); await h.settle();
    const latest = recovered("need_more_info", id(605)); latest.response.data.result = { ...results.need_more_info, questionId: id(305) };
    h.publishSnapshot(snapshotOf([latest])); assert.equal(postedBodies(h).length, 2);
    h.state.handle = responseWith(results.outcome); h.find("MessageInput").onSend(); await h.settle();
    assert.equal(postedBodies(h).at(-1).input.questionId, id(305)); assert.equal(postedBodies(h).at(-1).conversationId, id(100));
  } finally { h.close(); }
});

test("후속 접수 거절의 늦은 실패가 이후 작성·삭제한 새 초안을 덮어쓰지 않음", async () => {
  const h = harness(), gate = deferred(); h.state.handle = responseWith(results.need_more_info);
  try {
    h.send("회의 등록"); await h.settle(); h.state.handle = () => gate.promise; h.send("오후 3시"); await h.settle();
    h.edit("새 초안"); h.edit(""); gate.resolve(problemResponse("ASSISTANT_UNAVAILABLE", 503)); await h.settle();
    assert.equal(h.find("MessageInput").value, ""); assert.equal(h.find("MessageInput").disabled, false);
    h.state.handle = responseWith(results.outcome); h.send("오후 4시"); await h.settle(); assert.equal(postedBodies(h).at(-1).input.questionId, id(300));
  } finally { h.close(); }
});

for (const failMetadata of [false, true]) test(`후속 접수 확인 후 GET 실패${failMetadata ? "·metadata 갱신 실패" : ""}: 이전 질문 재활성화·자동 POST 없음`, async () => {
  const h = harness(); h.state.handle = responseWith(results.need_more_info);
  try {
    h.send("회의 등록"); await h.settle(); const first = postedBodies(h)[0].requestId;
    h.state.handle = (url, init) => { if (init.method !== "POST") return problemResponse("ASSISTANT_UNAVAILABLE", 503);
      if (failMetadata) h.state.failStorage = true; return json(status(JSON.parse(init.body).requestId), 202); };
    h.send("오후 3시"); await h.settle(); assert.equal(postedBodies(h).length, 2); assert.equal(h.messages().at(-1).apiExecution.lastResponse.data.status, "accepted");
    h.publishSnapshot(snapshotOf([recovered("need_more_info", first)])); h.state.failStorage = false;
    h.state.handle = responseWith(results.outcome); h.send("명시적 새 작업"); await h.settle();
    assert.equal(Object.hasOwn(postedBodies(h).at(-1).input, "questionId"), false); assert.equal(Object.hasOwn(postedBodies(h).at(-1), "conversationId"), false);
    assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("복구 질문 답변은 원래 서버 conversation/question 사용·반복 snapshot 후에도 중복 표시 없음", async () => {
  const execution = recovered("need_more_info"), h = harness({ initialSnapshot: snapshotOf([execution]) });
  try {
    h.publishSnapshot(snapshotOf([execution])); h.publishSnapshot(snapshotOf([execution])); assert.equal(h.messages().length, 1);
    h.send("오후 3시"); await h.settle(); const body = postedBodies(h)[0];
    assert.equal(body.conversationId, execution.response.data.conversationId); assert.equal(body.input.questionId, execution.response.data.result.questionId);
    assert.equal(h.messages().filter(message => message.role === "user").length, 1); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("여러 과거 복구 질문의 활성 순서를 추측하지 않고 POST 없이 입력 보존", async () => {
  const h = harness({ initialSnapshot: snapshotOf([recovered("need_more_info", id(600)), recovered("need_more_info", id(601))]) });
  try { h.send("오후 3시"); await h.settle(); assert.equal(h.state.starts.length, 0); assert.equal(h.state.calls.length, 0);
    assert.equal(h.find("MessageInput").value, "오후 3시"); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("후속 최신 복구 질문이 늦은 정상 완료 callback보다 우선·교체된 과거 질문 부활 없음", async () => {
  const h = harness(), gate = deferred(); h.state.handle = responseWith(results.need_more_info);
  try {
    h.send("회의 등록"); await h.settle(); const old = postedBodies(h)[0].requestId;
    h.delegate.startRequest = (body, options) => { h.state.starts.push([body, options]); return { initial: gate.promise, completion: gate.promise, cancel() {} }; };
    h.send("오후 3시"); const requestId = h.state.starts.at(-1)[0].requestId;
    const latest = recovered("need_more_info", requestId); latest.response.data.result = { ...results.need_more_info, questionId: id(301) };
    h.publishSnapshot(snapshotOf([recovered("need_more_info", old), latest]));
    gate.resolve(recovered("outcome", requestId)); await h.settle(); h.publishSnapshot(snapshotOf([recovered("need_more_info", old), latest]));
    h.send("회의실 A"); const body = h.state.starts.at(-1)[0]; assert.equal(body.input.questionId, id(301)); assert.equal(body.conversationId, id(100));
    assert.equal(h.messages().filter(message => message.apiExecution?.reference.requestId === requestId).length, 1);
  } finally { h.close(); }
});

test("UUID 생성 중 최신 질문 수신: 생성 직후 최신 구조화 ID로 본문 구성", async () => {
  const h = harness({ initialSnapshot: snapshotOf([recovered("need_more_info")]) });
  try {
    h.state.beforeUuid = () => { const latest = recovered("need_more_info"); latest.response.data.result = { ...results.need_more_info, questionId: id(301) }; h.publishSnapshot(snapshotOf([latest])); };
    h.send("오후 3시"); await h.settle(); assert.equal(postedBodies(h)[0].input.questionId, id(301));
  } finally { h.close(); }
});

for (const change of ["server", "mode"]) test(`${change} 전환 뒤 과거 정보 보충 질문을 새 요청에 혼합하지 않음`, async () => {
  const h = harness(); h.state.handle = responseWith(results.need_more_info);
  try {
    h.send("회의 등록"); await h.settle();
    if (change === "mode") { h.switchMode("mock"); h.switchMode("server"); }
    else { h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid");
      h.publishSnapshot(snapshotOf([], { serverId: "development:https://other.example.invalid" })); }
    h.state.handle = responseWith(results.outcome); h.send("새 일정 조회"); await h.settle();
    const body = postedBodies(h).at(-1); assert.equal(Object.hasOwn(body, "conversationId"), false); assert.equal(Object.hasOwn(body.input, "questionId"), false); assert.equal(h.state.mockRuns, 0);
  } finally { h.close(); }
});

test("정보 보충 전송 중 서버 변경·해제 뒤 늦은 응답은 질문 상태나 UI를 갱신하지 않음", async () => {
  const h = harness(), gate = deferred(); h.state.handle = responseWith(results.need_more_info);
  try {
    h.send("회의 등록"); await h.settle(); h.state.handle = () => gate.promise; h.send("오후 3시"); await h.settle();
    h.close(); const count = h.state.calls.length; gate.resolve(json(status(postedBodies(h).at(-1).requestId), 202)); await h.settle();
    assert.equal(h.state.lateUpdates, 0); assert.equal(h.state.calls.length, count); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

// 서버 후보는 실제 카드 callback부터 검증하고 HTTP·저장소·시계만 대체한다.
async function liveCandidates(h, { count = 2, expiresAt = new Date(h.wall + 600000).toISOString(), questionId = id(310) } = {}) {
  const result = { ...results.candidate_selection, questionId, expiresAt,
    candidates: Array.from({ length: count }, (_, n) => ({ candidateId: `opaque:/후보 ?#% ${n}`, title: `일정 후보 ${n}`,
      scheduledAt: "2026-11-12T15:05:00Z", category: ["INBOUND", "INVENTORY", "OUTBOUND", "RETURN", "OTHER"][n % 5] })) };
  h.state.handle = responseWith(result); h.send("수정할 일정 찾아 줘"); await h.settle();
  return h.messages().at(-1);
}
function candidateButtons(h, messageId) {
  const index = h.messages().findIndex(message => message.id === messageId);
  return nodes(h.renderConversation().rows[index], "Pressable");
}
function selectApi(h, messageId, candidateId) { h.find("ConversationList").onApiCandidateSelection(messageId, candidateId); h.render(); }

for (const count of [2, 10]) test(`6-B 서버 후보 ${count}건: 기존 카드·label/KST/category·opaque key와 버튼 활성`, async () => {
  const h = harness(); try {
    const message = await liveCandidates(h, { count }), buttons = candidateButtons(h, message.id), view = h.renderConversation();
    assert.equal(buttons.length, count); assert.ok(buttons.every(button => !button.props.disabled && typeof button.props.onPress === "function"));
    assert.deepEqual(buttons.map(button => button.key), message.apiExecution.response.data.result.candidates.map(candidate => candidate.candidateId));
    assert.deepEqual(cards(view).map(card => card.props.schedule.title), Array.from({ length: count }, (_, n) => `일정 후보 ${n}`));
    assert.ok(cards(view).every(card => card.props.schedule.date === "2026-11-13" && card.props.schedule.time === "00:05"));
    assert.deepEqual(cards(view).map(card => card.props.schedule.category), Array.from({ length: count }, (_, n) => ["입고", "재고", "출고", "반품", "기타"][n % 5]));
    assert.ok(buttons.every(button => button.props.accessibilityState.selected === false)); assert.equal(postedBodies(h).length, 1);
  } finally { h.close(); }
});

test("6-B 실제 카드 선택: 새 UUID·서버 conversation/question·opaque candidateId만 전송·선택 식별 유지", async () => {
  const h = harness(), before = h.mock.getState().schedules;
  try {
    const message = await liveCandidates(h), original = message.apiExecution.response.data.result, choose = candidateButtons(h, message.id)[1].props.onPress;
    h.state.handle = responseWith(results.confirmation); h.edit("보존할 초안"); choose(); h.render(); await h.settle();
    const [first, selection] = postedBodies(h); assert.notEqual(selection.requestId, first.requestId);
    assert.match(selection.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(selection, { requestId: selection.requestId, conversationId: id(100), input: { type: "selection", questionId: id(310), candidateId: original.candidates[1].candidateId } });
    assert.notEqual(selection.input.candidateId, summary.id); assert.notEqual(selection.input.candidateId, "1"); assert.equal(h.state.uuidCalls, 2);
    const user = h.messages().find(item => item.id === selection.requestId); assert.equal(user.role, "user");
    assert.ok(user.text.includes("일정 후보 1")); assert.ok(user.text.includes("오전 12:05")); assert.ok(user.text.includes("재고"));
    assert.equal(candidateButtons(h, message.id)[1].props.accessibilityState.selected, true);
    assert.ok(textOf(h.renderConversation().rows).includes("선택됨")); assert.equal(h.find("MessageInput").value, "보존할 초안");
    const confirmation = h.messages().at(-1); assert.equal(confirmation.apiExecution.response.data.result.kind, "confirmation");
    assert.ok(candidateButtons(h, confirmation.id).every(button => !button.props.disabled && typeof button.props.onPress === "function"));
    assert.strictEqual(h.mock.getState().schedules, before); assert.equal(h.state.mockRuns, 0); assert.equal(h.state.cleanup, 0);
    assert.ok(h.state.calls.every(call => call.url.includes("/assistant/requests"))); assert.ok([...h.data.values()].every(value => !value.includes("보존할 초안") && !value.includes("일정 후보")));
  } finally { h.close(); }
});

test("6-B 후보 연타·다른 후보·text/confirmation: 접수와 polling 동안 ref 잠금으로 논리 요청 1개", async () => {
  const h = harness(); let gets = 0;
  try {
    const message = await liveCandidates(h), buttons = candidateButtons(h, message.id);
    h.state.handle = (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202)
      : json(++gets < 3 ? status(url.split("/").pop(), gets === 1 ? "accepted" : "processing") : done(url.split("/").pop(), "confirmation"));
    const choose = buttons[0].props.onPress; choose(); choose(); buttons[1].props.onPress(); h.find("MessageInput").onSend();
    h.find("ConversationList").onDeleteConfirmation(message.id, true); h.render(); await h.settle();
    assert.equal(postedBodies(h).length, 2); assert.ok(candidateButtons(h, message.id).every(button => button.props.disabled));
    assert.equal(h.find("MessageInput").disabled, true); assert.equal(h.find("ConversationList").isProcessing, true);
    await h.advance(1999); assert.equal(gets, 1); await h.advance(1); assert.equal(gets, 2);
    await h.advance(2000); assert.equal(gets, 3); assert.equal(postedBodies(h).length, 2); assert.equal(h.find("MessageInput").disabled, false);
  } finally { h.close(); }
});

test("6-B 연속 후보 질문: 이전 버튼 실행 금지·최신 questionId와 원형 candidateId 사용", async () => {
  const h = harness(); try {
    const old = await liveCandidates(h), late = candidateButtons(h, old.id)[0].props.onPress;
    const next = { ...old.apiExecution.response.data.result, questionId: id(311), candidates: old.apiExecution.response.data.result.candidates.slice().reverse() };
    h.state.handle = responseWith(next); late(); h.render(); await h.settle(); const latest = h.messages().at(-1);
    assert.ok(candidateButtons(h, old.id).every(button => button.props.disabled)); const count = postedBodies(h).length;
    late(); selectApi(h, old.id, next.candidates[0].candidateId); await h.settle(); assert.equal(postedBodies(h).length, count);
    h.state.handle = responseWith(results.confirmation); candidateButtons(h, latest.id)[0].props.onPress(); h.render(); await h.settle();
    assert.equal(postedBodies(h).at(-1).input.questionId, id(311)); assert.equal(postedBodies(h).at(-1).input.candidateId, next.candidates[0].candidateId);
  } finally { h.close(); }
});

test("6-B 만료 경계: expiresAt 직전만 활성·정확한 경계에 버튼 비활성/타이머 정리·늦은 터치 POST 0회", async () => {
  const h = harness(); try {
    const message = await liveCandidates(h, { expiresAt: new Date(h.wall + 2000).toISOString() }), late = candidateButtons(h, message.id)[0].props.onPress;
    await h.advance(1999); assert.equal(candidateButtons(h, message.id)[0].props.disabled, false);
    await h.advance(1); assert.equal(candidateButtons(h, message.id)[0].props.disabled, true); assert.equal(h.timers.size, 0);
    late(); selectApi(h, message.id, message.apiExecution.response.data.result.candidates[0].candidateId); await h.settle();
    assert.equal(postedBodies(h).length, 1); assert.equal(h.state.uuidCalls, 1); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("6-B UUID 생성 사이 만료: fetch 전 재검사로 selection POST 0회", async () => {
  const h = harness(); try {
    const message = await liveCandidates(h, { expiresAt: new Date(h.wall + 1000).toISOString() });
    h.state.beforeUuid = () => { h.wall += 1000; }; candidateButtons(h, message.id)[0].props.onPress(); h.render(); await h.settle();
    assert.equal(postedBodies(h).length, 1); assert.equal(h.find("MessageInput").disabled, false);
  } finally { h.close(); }
});

test("6-B POST 전 저장 대기 중 만료: 늦게 저장이 완료돼도 fetch 0회", async () => {
  const h = harness(), gate = deferred(); try {
    const message = await liveCandidates(h, { expiresAt: new Date(h.wall + 2000).toISOString() });
    h.state.beforeRead = () => gate.promise; candidateButtons(h, message.id)[0].props.onPress(); h.render(); await h.settle();
    await h.advance(2000); h.state.beforeRead = null; gate.resolve(); await h.settle();
    assert.equal(postedBodies(h).length, 1); assert.ok(candidateButtons(h, message.id).every(button => button.props.disabled)); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("6-B HTTP 접수 증거가 있으면 metadata 저장 대기 중 질문 만료로 접수 사실을 버리지 않음", async () => {
  const h = harness(), gate = deferred(); try {
    const message = await liveCandidates(h, { expiresAt: new Date(h.wall + 2000).toISOString() });
    h.state.handle = (url, init) => {
      if (init.method === "POST") { h.state.beforeRead = () => gate.promise; return json(status(JSON.parse(init.body).requestId), 202); }
      return json(done(url.split("/").pop(), "confirmation"));
    };
    candidateButtons(h, message.id)[0].props.onPress(); h.render(); await h.settle();
    await h.advance(2000); assert.equal(h.find("ConversationList").isProcessing, true);
    h.state.beforeRead = null; gate.resolve(); await h.settle();
    assert.equal(h.messages().at(-1).apiExecution.kind, "completed"); assert.equal(h.messages().at(-1).apiExecution.response.data.result.kind, "confirmation");
    assert.equal(postedBodies(h).length, 2); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("6-B 반복 GET·rerender는 후보 만료 연장·중복 활성화·메시지 추가를 하지 않음", async () => {
  const h = harness(); try {
    const message = await liveCandidates(h, { expiresAt: new Date(h.wall + 2000).toISOString() }), requestId = message.apiExecution.reference.requestId;
    const execution = recovered("candidate_selection", requestId); execution.response.data.result = { ...message.apiExecution.response.data.result, expiresAt: new Date(h.wall + 9000).toISOString() };
    for (let n = 0; n < 3; n++) { h.publishSnapshot(snapshotOf([execution])); h.render(); }
    assert.equal(h.messages().filter(item => item.apiExecution?.reference.requestId === requestId).length, 1); assert.equal(candidateButtons(h, message.id).length, 2);
    await h.advance(2000); assert.ok(candidateButtons(h, message.id).every(button => button.props.disabled));
    selectApi(h, message.id, execution.response.data.result.candidates[0].candidateId); await h.settle(); assert.equal(postedBodies(h).length, 1);
  } finally { h.close(); }
});

for (const reason of ["storage", "503"]) test(`6-B 접수 전 ${reason} 실패: 자동 재전송 없음·유효 후보의 명시적 재선택만 허용`, async () => {
  const h = harness(); try {
    const message = await liveCandidates(h); h.edit("선택과 무관한 초안");
    if (reason === "storage") h.state.failStorage = true; else h.state.handle = () => problemResponse("ASSISTANT_UNAVAILABLE", 503);
    candidateButtons(h, message.id)[0].props.onPress(); h.render(); await h.settle();
    assert.equal(postedBodies(h).length, reason === "storage" ? 1 : 2); assert.equal(h.state.starts.length, 2);
    assert.equal(h.messages().at(-1).apiExecution.kind, "needs-attention"); assert.ok(candidateButtons(h, message.id).every(button => !button.props.disabled));
    assert.equal(h.find("MessageInput").value, "선택과 무관한 초안"); h.state.failStorage = false; h.state.handle = responseWith(results.confirmation);
    candidateButtons(h, message.id)[1].props.onPress(); h.render(); await h.settle(); assert.equal(postedBodies(h).at(-1).input.candidateId, message.apiExecution.response.data.result.candidates[1].candidateId);
  } finally { h.close(); }
});

for (const code of ["STALE_QUESTION", "QUESTION_EXPIRED", "CONVERSATION_EXPIRED"]) test(`6-B ${code} 거절: 과거 후보 재활성/재전송 없음·복구 필드 유지`, async () => {
  const h = harness(); try {
    const message = await liveCandidates(h), late = candidateButtons(h, message.id)[0].props.onPress;
    h.state.handle = () => problemResponse(code); late(); h.render(); await h.settle();
    assert.equal(h.messages().at(-1).apiExecution.recoveryResult.postResult.error.problem.code, code);
    h.publishSnapshot(snapshotOf([message.apiExecution])); assert.ok(candidateButtons(h, message.id).every(button => button.props.disabled));
    late(); await h.settle(); assert.equal(postedBodies(h).length, 2); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const failure of ["network", "timeout", "response"]) test(`6-B POST ${failure} 미확인: GET-first 뒤에도 미확인이면 새 ID 선택 재전송 차단`, async () => {
  const h = harness(); try {
    const message = await liveCandidates(h), late = candidateButtons(h, message.id)[0].props.onPress;
    h.state.handle = (url, init) => { if (init.method !== "POST") return problemResponse("ASSISTANT_UNAVAILABLE", 503);
      if (failure === "network") throw Error("연결 실패"); if (failure === "timeout") return deferred().promise;
      return { status: 202, headers: new Headers({ "Content-Type": "application/json", "X-Request-ID": id(900) }), text: async () => "{잘못된 JSON" }; };
    late(); h.render(); await h.settle(); if (failure === "timeout") await h.advance(5000);
    assert.equal(h.messages().at(-1).apiExecution.kind, "needs-attention"); assert.ok(candidateButtons(h, message.id).every(button => button.props.disabled));
    const calls = h.state.calls.length; late(); selectApi(h, message.id, message.apiExecution.response.data.result.candidates[1].candidateId); await h.settle();
    assert.equal(h.state.calls.length, calls); assert.equal(postedBodies(h).length, 2); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const metadataFailure of [false, true]) test(`6-B 접수 후 조회 실패${metadataFailure ? "·접수 metadata 저장 실패" : ""}: 선택 재실행 0회`, async () => {
  const h = harness(); try {
    const message = await liveCandidates(h), late = candidateButtons(h, message.id)[0].props.onPress;
    h.state.handle = (url, init) => { if (init.method !== "POST") return problemResponse("ASSISTANT_UNAVAILABLE", 503);
      if (metadataFailure) h.state.failStorage = true; return json(status(JSON.parse(init.body).requestId), 202); };
    late(); h.render(); await h.settle(); h.state.failStorage = false; h.publishSnapshot(snapshotOf([message.apiExecution]));
    assert.equal(h.messages().at(-1).apiExecution.kind, "needs-attention"); assert.ok(candidateButtons(h, message.id).every(button => button.props.disabled));
    const calls = h.state.calls.length; late(); await h.settle(); assert.equal(h.state.calls.length, calls); assert.equal(postedBodies(h).length, 2);
  } finally { h.close(); }
});

for (const change of ["server", "mode"]) test(`6-B ${change} 변경: 이전 후보·늦은 카드 callback 전송 0회`, async () => {
  const h = harness(); try {
    const message = await liveCandidates(h), late = candidateButtons(h, message.id)[0].props.onPress;
    if (change === "mode") h.switchMode("mock");
    else { h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid"); h.publishSnapshot(snapshotOf([], { serverId: "development:https://other.example.invalid" })); }
    late(); selectApi(h, message.id, message.apiExecution.response.data.result.candidates[0].candidateId); await h.settle();
    assert.equal(postedBodies(h).length, 1); assert.equal(h.state.mockRuns, 0);
  } finally { h.close(); }
});

test("6-B cold start 과거 후보 GET만으로 활성 추측 금지·서버 재실행 선택 POST 0회", async () => {
  const execution = recovered("candidate_selection"), h = harness({ initialSnapshot: snapshotOf([execution]) });
  try {
    assert.ok(candidateButtons(h, h.messages()[0].id).every(button => button.props.disabled));
    selectApi(h, h.messages()[0].id, execution.response.data.result.candidates[0].candidateId); await h.settle();
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.uuidCalls, 0); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("6-B 동일 live 복구 snapshot·완료 callback 경합: 최신 confirmation 유지·이전 후보 부활 없음", async () => {
  const h = harness(), gate = deferred(); try {
    const message = await liveCandidates(h), late = candidateButtons(h, message.id)[0].props.onPress;
    h.publishSnapshot(snapshotOf([message.apiExecution])); h.publishSnapshot(snapshotOf([message.apiExecution]));
    assert.equal(candidateButtons(h, message.id).length, 2);
    h.delegate.startRequest = (body, options) => { h.state.starts.push([body, options]); return { initial: gate.promise, completion: gate.promise, cancel() {} }; };
    late(); h.render(); const requestId = h.state.starts.at(-1)[0].requestId;
    h.publishSnapshot(snapshotOf([message.apiExecution, recovered("confirmation", requestId)]));
    gate.resolve(recovered("candidate_selection", requestId)); await h.settle(); h.publishSnapshot(snapshotOf([message.apiExecution, recovered("confirmation", requestId)]));
    assert.equal(h.messages().at(-1).apiExecution.response.data.result.kind, "confirmation"); assert.ok(candidateButtons(h, message.id).every(button => button.props.disabled));
    assert.equal(h.messages().filter(item => item.apiExecution?.reference.requestId === requestId).length, 1);
    const count = h.state.starts.length; late(); await h.settle(); assert.equal(h.state.starts.length, count);
  } finally { h.close(); }
});

test("6-B 없는 candidateId·Schedule ID·배열 순번·과거 메시지 조합은 UUID/POST 0회", async () => {
  const h = harness(); try {
    const message = await liveCandidates(h);
    for (const candidateId of [summary.id, "0", "없는 후보"]) selectApi(h, message.id, candidateId);
    selectApi(h, "이전 메시지", message.apiExecution.response.data.result.candidates[0].candidateId); await h.settle();
    assert.equal(h.state.uuidCalls, 1); assert.equal(postedBodies(h).length, 1); assert.equal(h.find("MessageInput").disabled, false);
  } finally { h.close(); }
});

test("6-B unmount: 후보 만료 타이머·진행 작업 정리·늦은 응답의 UI 반영/추가 GET 없음", async () => {
  const h = harness(), gate = deferred(); try {
    const message = await liveCandidates(h); h.state.handle = () => gate.promise;
    candidateButtons(h, message.id)[0].props.onPress(); h.render(); await h.settle(); const requestId = postedBodies(h).at(-1).requestId;
    h.close(); gate.resolve(json(status(requestId), 202)); await h.settle();
    assert.equal(h.timers.size, 0); assert.equal(h.state.lateUpdates, 0); assert.equal(postedBodies(h).length, 2);
    assert.equal(h.state.calls.filter(call => call.init.method === "GET").length, 1); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

// 확인 입력도 실제 버튼·공통 전송 경로·기존 HTTP/polling을 통과시킨다.
async function liveConfirmation(h, overrides = {}) {
  const result = { ...results.confirmation, questionId: id(330), expiresAt: new Date(h.wall + 600000).toISOString(), ...overrides };
  if (result.operation === "delete") delete result.changes;
  h.state.handle = responseWith(result); h.send("일정 변경해 줘"); await h.settle(); return h.messages().at(-1);
}
const confirmationButtons = (h, messageId) => candidateButtons(h, messageId);
function confirmApi(h, messageId, approved) { h.find("ConversationList").onApiConfirmation(messageId, approved); h.render(); }
const confirmationOutcome = approved => approved
  ? { kind: "outcome", text: "변경을 완료했어요.", outcome: "success", operation: "update", schedulesChanged: true, affectedScheduleIds: [summary.id] }
  : { kind: "outcome", text: "이번 변경안을 거절했어요.", outcome: "cancelled", operation: "update", schedulesChanged: false };

for (const approved of [true, false]) test(`6-C 실제 ${approved ? "예" : "아니요"}: boolean confirmation·새 UUID·서버 ID만 전송, 직접 write/cancel 없음`, async () => {
  const h = harness(), before = h.mock.getState().schedules;
  try {
    const message = await liveConfirmation(h), buttons = confirmationButtons(h, message.id);
    assert.deepEqual(buttons.map(textOf), ["아니요", "예"]); assert.ok(buttons.every(button => !button.props.disabled));
    h.edit("사용자 초안 유지"); h.state.handle = responseWith(confirmationOutcome(approved)); buttons[approved ? 1 : 0].props.onPress(); h.render(); await h.settle();
    const [first, answer] = postedBodies(h); assert.notEqual(answer.requestId, first.requestId);
    assert.match(answer.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(answer, { requestId: answer.requestId, conversationId: id(100), input: { type: "confirmation", questionId: id(330), approved } });
    assert.equal(typeof answer.input.approved, "boolean"); assert.equal(h.messages().find(item => item.id === answer.requestId).text, approved ? "예" : "아니요");
    assert.equal(confirmationButtons(h, message.id)[approved ? 1 : 0].props.accessibilityState.selected, true);
    assert.ok(confirmationButtons(h, message.id).every(button => button.props.disabled));
    assert.deepEqual(h.messages().at(-1).apiExecution.response.data.result, confirmationOutcome(approved));
    assert.ok(textOf(h.renderConversation().rows).includes(approved ? "수정 완료" : "수정 취소됨"));
    assert.equal(h.find("MessageInput").value, "사용자 초안 유지"); assert.equal(h.state.uuidCalls, 2);
    assert.ok(h.state.calls.every(call => call.url.startsWith(`${origin}/api/v1/assistant/requests`)));
    assert.strictEqual(h.mock.getState().schedules, before); assert.equal(h.state.mockRuns, 0); assert.equal(h.state.cleanup, 0);
    assert.ok([...h.data.values()].every(value => !value.includes("사용자 초안 유지") && !value.includes('"approved"') && !value.includes('"messages"')));
  } finally { h.close(); }
});

for (const [name, overrides, expected] of [
  ["제목", { changes: { title: "변경된 일정 제목" } }, "제목: 원본 일정 → 변경된 일정 제목"],
  ["날짜·시간·category", { changes: { scheduledAt: "2026-11-13T04:10:00Z", category: "OUTBOUND" } }, "오후 1:10"],
  ["완료", { target: { ...summary, completed: false }, changes: { completed: true } }, "완료 상태: 미완료 → 완료"],
  ["미완료", { target: { ...summary, completed: true }, changes: { completed: false } }, "완료 상태: 완료 → 미완료"],
  ["삭제", { operation: "delete" }, "삭제 대상"],
]) test(`6-C ${name} 확인: target 원형·실제 변경값·기존 카드 표시 보존`, async () => {
  const h = harness(); try {
    const message = await liveConfirmation(h, overrides), result = message.apiExecution.response.data.result, view = h.renderConversation();
    assert.ok(textOf(view.rows).includes(expected)); assert.ok(confirmationButtons(h, message.id).every(button => !button.props.disabled));
    const target = cards(view)[0].props.schedule; assert.equal(target.id, result.target.id); assert.equal(target.title, result.target.title);
    assert.equal(target.date, "2026-11-12"); assert.equal(target.time, "09:00"); assert.equal(target.category, "기타"); assert.equal(target.completed, result.target.completed);
    if (result.operation === "delete") assert.equal(Object.hasOwn(result, "changes"), false);
    if (name === "날짜·시간·category") { assert.ok(textOf(view.rows).includes("11월 13일")); assert.ok(textOf(view.rows).includes("분류: 기타 → 출고")); }
    h.state.handle = responseWith(confirmationOutcome(false)); confirmationButtons(h, message.id)[0].props.onPress(); h.render(); await h.settle();
    assert.deepEqual(Object.keys(postedBodies(h).at(-1).input).sort(), ["approved", "questionId", "type"]);
  } finally { h.close(); }
});

for (const [first, second] of [[true, true], [false, false], [true, false], [false, true]]) test(`6-C ${first}/${second} 연타: 처리 중 text·selection·반대 버튼 중복 실행 0회`, async () => {
  const h = harness(), gate = deferred(); let gets = 0;
  try {
    const message = await liveConfirmation(h), buttons = confirmationButtons(h, message.id);
    h.state.handle = (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202)
      : ++gets === 1 ? json(status(url.split("/").pop(), "processing")) : gate.promise;
    buttons[first ? 1 : 0].props.onPress(); buttons[second ? 1 : 0].props.onPress();
    h.find("MessageInput").onSend(); selectApi(h, message.id, "없는 후보"); h.render(); await h.settle();
    assert.equal(postedBodies(h).length, 2); assert.equal(postedBodies(h).at(-1).input.approved, first);
    assert.equal(h.find("MessageInput").disabled, true); assert.equal(h.find("ConversationList").isProcessing, true);
    assert.ok(confirmationButtons(h, message.id).every(button => button.props.disabled)); assert.equal(h.messages().filter(item => item.role === "assistant").length, 1);
    await h.advance(1999); assert.equal(gets, 1); await h.advance(1); assert.equal(gets, 2);
    gate.resolve(json({ ...done(postedBodies(h).at(-1).requestId), result: confirmationOutcome(first) })); await h.settle();
    assert.equal(postedBodies(h).length, 2); assert.equal(h.find("MessageInput").disabled, false);
  } finally { h.close(); }
});

for (const text of ["예", "아니요"]) test(`6-C 정보 보충에서 ${text} 답변은 기존 6-A text·questionId 유지`, async () => {
  const h = harness(); try {
    h.state.handle = responseWith({ ...results.need_more_info, text: "이 일정으로 등록할까요?" }); h.send("회의 등록"); await h.settle();
    assert.equal(nodes(h.renderConversation().rows, "Pressable").length, 0); h.state.handle = responseWith(results.outcome); h.send(text); await h.settle();
    assert.deepEqual(postedBodies(h).at(-1).input, { type: "text", text, questionId: id(300) });
  } finally { h.close(); }
});

for (const approved of [true, false]) test(`6-C ${approved} 확인 만료: 정확한 경계·만료 안내·과거 callback POST 0회`, async () => {
  const h = harness(); try {
    const message = await liveConfirmation(h, { expiresAt: new Date(h.wall + 2000).toISOString() }), late = confirmationButtons(h, message.id)[approved ? 1 : 0].props.onPress;
    await h.advance(1999); assert.ok(confirmationButtons(h, message.id).every(button => !button.props.disabled));
    await h.advance(1); assert.ok(confirmationButtons(h, message.id).every(button => button.props.disabled));
    assert.ok(textOf(h.renderConversation().rows).includes("확인 기한이 지났어요.")); assert.equal(h.timers.size, 0);
    late(); confirmApi(h, message.id, approved); await h.settle(); assert.equal(postedBodies(h).length, 1); assert.equal(h.state.uuidCalls, 1);
  } finally { h.close(); }
});

test("6-C GET 재수신·리렌더·UUID 대기에서 확인 만료 시각을 연장하지 않음", async () => {
  const h = harness(); try {
    const message = await liveConfirmation(h, { expiresAt: new Date(h.wall + 2000).toISOString() }), late = confirmationButtons(h, message.id)[1].props.onPress;
    const execution = recovered("confirmation", message.apiExecution.reference.requestId);
    execution.response.data.result = { ...message.apiExecution.response.data.result, expiresAt: new Date(h.wall + 9000).toISOString() };
    h.publishSnapshot(snapshotOf([execution])); h.render(); h.state.beforeUuid = () => { h.wall += 2000; };
    late(); h.render(); await h.settle(); assert.equal(postedBodies(h).length, 1);
    h.publishSnapshot(snapshotOf([execution])); assert.ok(textOf(h.renderConversation().rows).includes("확인 기한이 지났어요."));
    assert.ok(confirmationButtons(h, message.id).every(button => button.props.disabled));
  } finally { h.close(); }
});

for (const approved of [true, false]) test(`6-C ${approved} 확인 저장 장벽 대기 중 만료: 늦은 저장 뒤 POST 0회`, async () => {
  const h = harness(), gate = deferred(); try {
    const message = await liveConfirmation(h, { expiresAt: new Date(h.wall + 2000).toISOString() });
    h.state.beforeRead = () => gate.promise; confirmationButtons(h, message.id)[approved ? 1 : 0].props.onPress(); h.render(); await h.settle();
    await h.advance(2000); h.state.beforeRead = null; gate.resolve(); await h.settle();
    assert.equal(postedBodies(h).length, 1); assert.equal(h.state.cleanup, 0); assert.equal(h.find("MessageInput").disabled, false);
  } finally { h.close(); }
});

test("6-C 접수 후 metadata 저장 대기에서 만료돼도 접수 증거 유지·POST 재실행 없음", async () => {
  const h = harness(), gate = deferred(); try {
    const message = await liveConfirmation(h, { expiresAt: new Date(h.wall + 2000).toISOString() });
    h.state.handle = (url, init) => { if (init.method === "POST") { h.state.beforeRead = () => gate.promise; return json(status(JSON.parse(init.body).requestId), 202); }
      return json({ ...done(url.split("/").pop()), result: confirmationOutcome(true) }); };
    confirmationButtons(h, message.id)[1].props.onPress(); h.render(); await h.settle(); await h.advance(2000);
    assert.equal(h.find("ConversationList").isProcessing, true); h.state.beforeRead = null; gate.resolve(); await h.settle();
    assert.equal(h.messages().at(-1).apiExecution.kind, "completed"); assert.equal(postedBodies(h).length, 2);
  } finally { h.close(); }
});

for (const reason of ["storage", "503"]) test(`6-C 접수 전 ${reason} 확정 실패: 원래 질문·초안 보존, 명시적 재시도만 허용`, async () => {
  const h = harness(); try {
    const message = await liveConfirmation(h); h.edit("새 초안");
    if (reason === "storage") h.state.failStorage = true; else h.state.handle = () => problemResponse("ASSISTANT_UNAVAILABLE", 503);
    confirmationButtons(h, message.id)[0].props.onPress(); h.render(); await h.settle();
    assert.equal(postedBodies(h).length, reason === "storage" ? 1 : 2); assert.equal(h.state.starts.length, 2);
    assert.equal(h.find("MessageInput").value, "새 초안"); assert.ok(confirmationButtons(h, message.id).every(button => !button.props.disabled));
    h.state.failStorage = false; h.state.handle = responseWith(confirmationOutcome(true)); confirmationButtons(h, message.id)[1].props.onPress(); h.render(); await h.settle();
    assert.equal(postedBodies(h).at(-1).input.approved, true); assert.equal(postedBodies(h).at(-1).input.questionId, id(330));
  } finally { h.close(); }
});

for (const failure of ["network", "timeout", "response"]) test(`6-C 거절 POST ${failure} 미확인: GET-first 후 새 ID 승인/거절 재전송 0회`, async () => {
  const h = harness(); try {
    const message = await liveConfirmation(h), buttons = confirmationButtons(h, message.id);
    h.state.handle = (url, init) => { if (init.method !== "POST") return problemResponse("ASSISTANT_UNAVAILABLE", 503);
      if (failure === "network") throw Error("연결 실패"); if (failure === "timeout") return deferred().promise;
      return { status: 202, headers: new Headers({ "Content-Type": "application/json", "X-Request-ID": id(900) }), text: async () => "{잘못된 JSON" }; };
    buttons[0].props.onPress(); h.render(); await h.settle(); if (failure === "timeout") await h.advance(5000);
    assert.equal(h.messages().at(-1).apiExecution.kind, "needs-attention"); const calls = h.state.calls.length;
    buttons[1].props.onPress(); confirmApi(h, message.id, false); await h.settle();
    assert.equal(h.state.calls.length, calls); assert.equal(postedBodies(h).length, 2); assert.ok(confirmationButtons(h, message.id).every(button => button.props.disabled));
  } finally { h.close(); }
});

for (const metadataFailure of [false, true]) test(`6-C 접수 후 GET 실패${metadataFailure ? "·metadata 갱신 실패" : ""}: 과거 확인 재실행 0회`, async () => {
  const h = harness(); try {
    const message = await liveConfirmation(h), late = confirmationButtons(h, message.id)[1].props.onPress;
    h.state.handle = (url, init) => { if (init.method !== "POST") return problemResponse("ASSISTANT_UNAVAILABLE", 503);
      if (metadataFailure) h.state.failStorage = true; return json(status(JSON.parse(init.body).requestId), 202); };
    late(); h.render(); await h.settle(); h.state.failStorage = false; h.publishSnapshot(snapshotOf([message.apiExecution]));
    assert.equal(h.messages().at(-1).apiExecution.lastResponse.data.status, "accepted"); const count = h.state.calls.length;
    late(); confirmApi(h, message.id, false); await h.settle(); assert.equal(h.state.calls.length, count); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const code of ["STALE_QUESTION", "QUESTION_EXPIRED", "CONVERSATION_EXPIRED"]) test(`6-C ${code}: 구조화 오류와 활성 질문 필드 보존·과거 확인 자동 재전송 없음`, async () => {
  const h = harness(); try {
    const message = await liveConfirmation(h), late = confirmationButtons(h, message.id)[1].props.onPress;
    h.state.handle = () => problemResponse(code); late(); h.render(); await h.settle();
    const problem = h.messages().at(-1).apiExecution.recoveryResult.postResult.error.problem; assert.equal(problem.code, code);
    if (code === "STALE_QUESTION") { assert.equal(problem.activeQuestionId, id(305)); assert.equal(problem.activeQuestionRequestId, id(605)); }
    h.publishSnapshot(snapshotOf([message.apiExecution])); late(); await h.settle();
    assert.equal(postedBodies(h).length, 2); assert.ok(confirmationButtons(h, message.id).every(button => button.props.disabled));
  } finally { h.close(); }
});

for (const kind of Object.keys(results)) test(`6-C 후속 ${kind}: 6종 원형 표시·이전 확인 버튼 비활성·성공 추측/write 없음`, async () => {
  const h = harness(), before = h.mock.getState().schedules;
  try {
    const message = await liveConfirmation(h); h.state.handle = responseWith(results[kind]); confirmationButtons(h, message.id)[1].props.onPress(); h.render(); await h.settle();
    const latest = h.messages().at(-1); assert.deepEqual(latest.apiExecution.response.data.result, results[kind]);
    assert.ok(textOf(h.renderConversation().rows).includes(results[kind].text)); assert.ok(confirmationButtons(h, message.id).every(button => button.props.disabled));
    if (kind === "failure" || kind === "uncertain") { assert.ok(textOf(h.renderConversation().rows).includes(kind === "failure" ? "처리 실패" : "결과 미확인")); assert.equal(latest.apiExecution.response.data.result.schedulesChanged, undefined); }
    assert.strictEqual(h.mock.getState().schedules, before); assert.equal(h.state.mockRuns, 0); assert.equal(h.state.cleanup, 0);
    assert.ok(h.state.calls.every(call => call.url.includes("/assistant/requests")));
  } finally { h.close(); }
});

for (const change of ["server", "mode"]) test(`6-C ${change} 변경 후 과거 확인·늦은 callback 전송 0회`, async () => {
  const h = harness(); try {
    const message = await liveConfirmation(h), late = confirmationButtons(h, message.id)[1].props.onPress;
    if (change === "mode") { h.switchMode("mock"); h.switchMode("server"); h.publishSnapshot(snapshotOf([message.apiExecution])); }
    else { h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid"); h.publishSnapshot(snapshotOf([], { serverId: "development:https://other.example.invalid" })); }
    late(); confirmApi(h, message.id, false); await h.settle(); assert.equal(postedBodies(h).length, 1); assert.equal(h.state.mockRuns, 0);
  } finally { h.close(); }
});

test("6-C cold start 과거 GET confirmation은 활성 추측 없이 읽기 전용·승인/거절 POST 0회", async () => {
  const execution = recovered("confirmation"), h = harness({ initialSnapshot: snapshotOf([execution]) });
  try {
    const message = h.messages()[0]; assert.ok(confirmationButtons(h, message.id).every(button => button.props.disabled));
    confirmApi(h, message.id, true); confirmApi(h, message.id, false); await h.settle(); assert.equal(h.state.calls.length, 0); assert.equal(h.state.uuidCalls, 0);
  } finally { h.close(); }
});

test("6-C 최신 확인 결과 우선·이전 callback 재활성 금지·동일 요청 메시지 하나 유지", async () => {
  const h = harness(), gate = deferred(); try {
    const message = await liveConfirmation(h), oldButton = confirmationButtons(h, message.id)[1].props.onPress;
    h.delegate.startRequest = (body, options) => { h.state.starts.push([body, options]); return { initial: gate.promise, completion: gate.promise, cancel() {} }; };
    oldButton(); h.render(); const requestId = h.state.starts.at(-1)[0].requestId;
    const latest = recovered("confirmation", requestId); latest.response.data.result = { ...results.confirmation, questionId: id(331), expiresAt: new Date(h.wall + 600000).toISOString() };
    h.publishSnapshot(snapshotOf([message.apiExecution, latest])); gate.resolve(recovered("outcome", requestId)); await h.settle();
    assert.equal(h.messages().at(-1).apiExecution.response.data.result.questionId, id(331)); assert.equal(h.messages().filter(item => item.apiExecution?.reference.requestId === requestId).length, 1);
    const count = h.state.starts.length; oldButton(); await h.settle(); assert.equal(h.state.starts.length, count);
    confirmationButtons(h, h.messages().at(-1).id)[0].props.onPress(); h.render(); assert.equal(h.state.starts.at(-1)[0].input.questionId, id(331));
  } finally { h.close(); }
});

test("6-C boolean 이외의 approved·과거 메시지 ID는 UUID/POST 이전 차단", async () => {
  const h = harness(); try {
    const message = await liveConfirmation(h); for (const value of ["true", "false", 0, 1, null, undefined]) confirmApi(h, message.id, value);
    confirmApi(h, "없는 메시지", true); await h.settle(); assert.equal(postedBodies(h).length, 1); assert.equal(h.state.uuidCalls, 1);
    assert.ok(confirmationButtons(h, message.id).every(button => !button.props.disabled));
  } finally { h.close(); }
});

test("6-C unmount 시 만료 타이머·진행 작업 정리, 늦은 응답 UI 반영·서버 cancel 없음", async () => {
  const h = harness(), gate = deferred(); try {
    const message = await liveConfirmation(h); h.state.handle = () => gate.promise;
    confirmationButtons(h, message.id)[0].props.onPress(); h.render(); await h.settle(); const requestId = postedBodies(h).at(-1).requestId;
    h.close(); gate.resolve(json(status(requestId), 202)); await h.settle();
    assert.equal(h.timers.size, 0); assert.equal(h.state.lateUpdates, 0); assert.ok(h.state.calls.every(call => call.url.includes("/assistant/requests"))); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const approved of [true, false]) test(`작업 6 통합: 첫 text → 정보 보충 → selection → confirmation ${approved} → outcome`, async () => {
  const h = harness(), before = h.mock.getState().schedules;
  try {
    h.state.handle = responseWith(results.need_more_info); h.send("순찰 일정 바꿔 줘"); await h.settle();
    h.state.handle = responseWith(results.candidate_selection); h.send("이번 주 일정"); await h.settle();
    const candidate = h.messages().at(-1), oldChoice = candidateButtons(h, candidate.id)[1].props.onPress;
    h.state.handle = responseWith({ ...results.confirmation, questionId: id(331), expiresAt: new Date(h.wall + 600000).toISOString() });
    oldChoice(); h.render(); await h.settle(); const confirmation = h.messages().at(-1);
    h.state.handle = responseWith(confirmationOutcome(approved)); confirmationButtons(h, confirmation.id)[approved ? 1 : 0].props.onPress(); h.render(); await h.settle();
    const bodies = postedBodies(h); assert.equal(bodies.length, 4); assert.equal(new Set(bodies.map(body => body.requestId)).size, 4);
    assert.deepEqual(bodies.map(body => body.input.type), ["text", "text", "selection", "confirmation"]); assert.equal(Object.hasOwn(bodies[0], "conversationId"), false);
    assert.ok(bodies.slice(1).every(body => body.conversationId === id(100))); assert.equal(bodies[1].input.questionId, id(300));
    assert.equal(bodies[2].input.candidateId, results.candidate_selection.candidates[1].candidateId); assert.equal(bodies[3].input.questionId, id(331)); assert.equal(bodies[3].input.approved, approved);
    assert.equal(h.messages().length, 8); assert.deepEqual(h.messages().map(message => message.role), ["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
    assert.deepEqual(h.messages().at(-1).apiExecution.response.data.result, confirmationOutcome(approved)); oldChoice(); await h.settle(); assert.equal(postedBodies(h).length, 4);
    assert.strictEqual(h.mock.getState().schedules, before); assert.equal(h.state.mockRuns, 0); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});
