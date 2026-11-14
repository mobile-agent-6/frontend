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
const json = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, headers: new Headers({ "Content-Type": "application/json", "X-Request-ID": id(900) }), text: async () => JSON.stringify(body) });
const status = (requestId, value = "accepted") => ({ requestId, conversationId: id(100), status: value });
const done = (requestId, kind = "outcome") => ({ ...status(requestId, "completed"), result: results[kind] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// 실제 화면 Hook·HTTP·복구·polling을 실행하고 native·시계·storage·fetch만 프로세스 대역으로 둔다.
// 실제 단말 렌더링·키보드·네트워크 시험은 아니다.
function harness({ initialMode = "server", readOnly = false, data = new Map(), initialSnapshot, actualLifecycle = false, snapshotAtSubscribe, notifyOnSubscribe = false,
  actualScheduleSync = false, actualScheduleDetails = false, initialSyncSnapshot = [], syncSnapshotAtSubscribe } = {}) {
  const cache = new Map(), slots = [], effects = [], timers = new Map(), listeners = new Set();
  const displayStates = new Map();
  const displayFocusCleanups = new Set();
  let displayOwner = null, displayCursor = 0;
  let inputUiIndex, statusIndex;
  let cursor = 0, dirty = false, tree, wall = 1000, mono = 0, timerId = 0, closed = false, displaying = false;
  const state = { app: "active", calls: [], starts: [], uuidCalls: 0, failUuid: false, failStorage: false, throwMessage: false,
    cleanup: 0, storageCleanupCalls: [], manualCleanupCalls: [], lateUpdates: 0, mockRuns: 0, beforeUuid: null, config: null, failRead: false, beforeRead: null,
    recoveryListeners: new Set(), lastRecoveryListener: null, beforeSubscribe: null, initializations: 0, unsubscribed: 0,
    syncSnapshot: initialSyncSnapshot, syncListeners: new Set(), syncRetries: [], lastSyncListener: null, syncUnsubscribed: 0,
    snapshot: initialSnapshot ?? { phase: "settled", initialCheck: "checked", serverId, results: [] },
    handle: async (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202) : json(done(url.split("/").pop())) };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      if (displayOwner) {
        const owner = displayOwner, index = displayCursor++;
        owner[index] ??= { value: typeof initial === "function" ? initial() : initial };
        return [owner[index].value, next => { owner[index].value = typeof next === "function" ? next(owner[index].value) : next; }];
      }
      const i = cursor++; slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      // 제품용 주입 API 없이 화면 Hook의 표시 값만 바꾸는 독립 UI fixture다.
      if (initial?.source === "text") inputUiIndex = i;
      if (initial === "idle") statusIndex = i;
      return [slots[i].value, next => {
        if (closed) state.lateUpdates++;
        const value = typeof next === "function" ? next(slots[i].value) : next;
        if (state.throwMessage && Array.isArray(value) && value.at(-1)?.role === "assistant" && value.at(-1).apiExecution?.kind === "completed") { state.throwMessage = false; throw Error("응답 게시 실패"); }
        if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; }
      }]; },
    useRef(initial) { if (displayOwner) return displayOwner[displayCursor++] ??= { current: initial };
      if (displaying) return { current: initial }; return slots[cursor++] ??= { current: initial }; },
    useCallback(fn, deps) { if (displaying) return fn; const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: fn }; return slots[i].value; },
    useEffect(fn, deps) { if (displaying) return; const i = cursor++; if (!same(slots[i]?.deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
    useLayoutEffect(fn) { if (displaying) fn(); },
    useMemo(factory) { return factory(); },
    useImperativeHandle() {},
  };
  const setTimer = (fn, ms) => { const token = ++timerId; timers.set(token, { fn, at: mono + ms, ms }); return token; };
  const clearTimer = token => timers.delete(token);
  const send = (url, init) => { state.calls.push({ url, init }); return state.handle(url, init); };
  const adapter = { async getItem(key) { if (state.beforeRead) await state.beforeRead(); if (state.failRead) throw Error("조회 실패"); return data.get(key) ?? null; }, async setItem(key, value) { if (state.failStorage) throw Error("저장 실패"); data.set(key, value); } };
  const syncDouble = { observe: async () => null, getSnapshot: () => state.syncSnapshot,
    retry: async reference => { state.syncRetries.push(reference); return state.syncSnapshot.find(entry => entry.reference.requestId === reference.requestId) ?? null; },
    subscribe(listener) { state.syncListeners.add(listener); state.lastSyncListener = listener;
      if (syncSnapshotAtSubscribe) state.syncSnapshot = syncSnapshotAtSubscribe;
      return () => { state.syncListeners.delete(listener); state.syncUnsubscribed++; }; } };
  const native = { AppState: { get currentState() { return state.app; }, addEventListener(event, listener) { assert.equal(event, "change"); listeners.add(listener); return { remove: () => listeners.delete(listener) }; } },
    Dimensions: { get: () => ({ width: 400, height: 800 }) },
    KeyboardAvoidingView: "KeyboardAvoidingView", FlatList: "FlatList", Keyboard: { isVisible: () => false }, Platform: { OS: "ios" }, StyleSheet: { create: s => s }, Text: "Text", View: "View", Pressable: "Pressable" };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: file }).outputText;
    function resolve(name) {
      if (name === "expo-router") return { useFocusEffect: callback => { displayFocusCleanups.add(callback()); } };
      if (name === "expo-symbols") return { SymbolView: "SymbolView" };
      // Schedule GET 통합은 전용 동기화·화면 회귀에서 검증하고 기존 Assistant 시험은 독립시킨다.
      if (name === "@/services/api/assistant-schedule-sync" && !actualScheduleSync) return { assistantScheduleSync: syncDouble };
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
      assert.ok(name.startsWith("@/"), name); if (!actualScheduleSync) assert.notEqual(name, "@/services/api/http");
      return load(path.join(root, "src", `${name.slice(2)}.ts`));
    }
    new Function("require", "module", "exports", "fetch", "setTimeout", "clearTimeout", "performance", "process", "Date", code)(resolve, module, module.exports,
      () => { throw Error("실제 네트워크 금지"); }, setTimer, clearTimer, { now: () => mono }, { env: { EXPO_PUBLIC_DEV_SERVER_BASE_URL: origin, EXPO_PUBLIC_SCHEDULE_DATA_MODE: initialMode, EXPO_PUBLIC_SCHEDULE_READ_ONLY: String(readOnly) } },
      ["assistant.tsx", "assistant-text-question.ts", "assistant-message.tsx"].some(name => file.endsWith(name)) ? class extends Date { static now() { return wall; } } : Date);
    // 기존 목록 동기화 회귀에서는 카드 조회를 분리하며 신규 통합 사례에서 실제 단건 GET도 실행한다.
    if (file.endsWith(path.join("src", "services", "api", "assistant-schedule-sync.ts")) && !actualScheduleDetails) {
      module.exports.assistantScheduleSync = module.exports.createAssistantScheduleSync();
    }
    return module.exports;
  }
  const source = file => load(path.join(root, file));
  const config = source("src/services/api/config.ts"); state.config = config.parseDevelopmentServerConfig(origin);
  config.getDevelopmentServerConfig = () => state.config;
  if (actualScheduleSync) {
    const scheduleHttp = source("src/services/api/http.ts");
    scheduleHttp.scheduleHttpClient = scheduleHttp.createScheduleHttpClient({ readConfig: () => state.config, fetchImpl: send });
  }
  const storage = source("src/services/storage/assistant-recovery.ts").assistantRecoveryStorage;
  const httpModule = source("src/services/api/assistant.ts");
  const http = httpModule.createAssistantHttpClient({ recovery: storage, fetchImpl: send, readConfig: () => state.config, now: () => wall }); httpModule.assistantHttpClient = http;
  const recovery = source("src/services/api/assistant-request-recovery.ts").createAssistantRequestRecovery({ http, recovery: storage, now: () => wall });
  const api = source("src/services/api/assistant-orchestrator.ts");
  const sync = actualScheduleSync ? source("src/services/api/assistant-schedule-sync.ts").assistantScheduleSync : syncDouble;
  const orchestrator = api.createAssistantOrchestrator({ http, requests: recovery, storage: { ...storage, cleanup: async (...args) => { state.cleanup++; return storage.cleanup(...args); } }, clock: { now: () => wall, monotonicNow: () => mono } });
  const originalCleanup = storage.cleanup, originalManualCleanup = storage.removeManually;
  storage.cleanup = (...args) => { state.storageCleanupCalls.push(args); return originalCleanup(...args); };
  storage.removeManually = (...args) => { state.manualCleanupCalls.push(args); return originalManualCleanup(...args); };
  const delegate = { startRequest: (...args) => { state.starts.push(args); return orchestrator.startRequest(...args); },
    confirmResultDisplayed: (...args) => orchestrator.confirmResultDisplayed(...args),
    queryRequestOnce: (...args) => orchestrator.queryRequestOnce(...args) }; api.assistantOrchestrator = delegate;
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
  function renderConversation(messages = find("ConversationList").messages, props = {}) {
    // FlatList의 실제 renderItem과 표시 컴포넌트를 실행한다. 스크롤/native effect는 실행하지 않는다.
    let list; displaying = true;
    const previousDisplayOwner = displayOwner, previousDisplayCursor = displayCursor;
    if (!displayStates.has("ConversationList")) displayStates.set("ConversationList", []);
    displayOwner = displayStates.get("ConversationList"); displayCursor = 0;
    try { list = source("src/components/assistant/conversation-list.tsx").ConversationList({ ...find("ConversationList"), ...props, messages }); }
    finally { displaying = false; displayOwner = previousDisplayOwner; displayCursor = previousDisplayCursor; }
    assert.equal(list.type, "FlatList");
    const components = [];
    function expand(node) {
      if (!node || typeof node !== "object") return node;
      if (Array.isArray(node)) return node.map(expand);
      if (typeof node.type === "function") {
        components.push({ name: node.type.name, props: node.props, key: node.key });
        const key = `${node.type.name}:${JSON.stringify(node.props?.value?.reference ?? node.props?.recoveryControl?.reference ?? node.key ?? "")}`;
        if (!displayStates.has(key)) displayStates.set(key, []);
        const previousOwner = displayOwner, previousCursor = displayCursor;
        displayOwner = displayStates.get(key); displayCursor = 0;
        try { return expand(node.type(node.props)); } finally { displayOwner = previousOwner; displayCursor = previousCursor; }
      }
      return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
    }
    return { list, components, rows: messages.map(item => expand(list.props.renderItem({ item }))), footer: expand(list.props.ListFooterComponent) };
  }
  render();
  return { state, source, storage, data, mock, mode, delegate, lifecycle, sync, render, renderConversation, find, settle, advance, timers, listeners,
    get wall() { return wall; }, set wall(value) { wall = value; },
    messages: () => find("ConversationList").messages,
    fixtureInputUi(input) { assert.notEqual(inputUiIndex, undefined); slots[inputUiIndex].value = input; render(); },
    fixtureStatus(value) { assert.notEqual(statusIndex, undefined); slots[statusIndex].value = value; render(); },
    edit(text) { find("MessageInput").onChangeText(text); render(); },
    send(text) { this.edit(text); find("MessageInput").onSend(); render(); },
    switchMode(value) { mode.scheduleDataModeStore.getState().setMode(value); render(); },
    publishSnapshot(snapshot) { state.snapshot = snapshot; for (const listener of [...state.recoveryListeners]) listener(); render(); },
    publishSync(snapshot) { state.syncSnapshot = snapshot; for (const listener of [...state.syncListeners]) listener(); render(); },
    attachLifecycle: () => realLifecycle.attach(),
    app(value) { state.app = value; for (const listener of [...listeners]) listener(value); },
    blurResults() { for (const cleanup of displayFocusCleanups) cleanup?.(); displayFocusCleanups.clear(); },
    close() { if (closed) return; closed = true; this.blurResults(); slots.forEach(slot => slot?.cleanup?.()); },
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
    const card = cards(h.renderConversation()).at(-1);
    assert.ok(card); assert.equal(Boolean(card.props.showCompleted), false);
    assert.equal(textOf(h.source("src/components/assistant/assistant-schedule-card.tsx").AssistantScheduleCard(card.props)).includes("미완료"), false);
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
function interactionButtons(node) {
  return nodes(node, "Pressable").filter(button => !button.props.testID?.startsWith("assistant-recovery-"));
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
    for (const button of interactionButtons(view.rows)) {
      const candidate = kind === "candidate_selection", interactive = candidate || kind === "confirmation" || kind === "uncertain";
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
    const buttons = interactionButtons(view.rows); assert.equal(buttons.length, count); assert.equal(cards(view).length, count);
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
    assert.equal(interactionButtons(view.rows).length, 2);
  });
});

test("delete 확인에는 target과 예/아니요만 있고 changes 합성 없음", async () => {
  const { changes, ...base } = results.confirmation; assert.ok(changes);
  await showResult({ ...base, operation: "delete" }, (h, view) => {
    const props = view.components.find(item => item.name === "AssistantMessage").props;
    assert.equal(props.apiResult.operation, "delete"); assert.equal(Object.hasOwn(props.apiResult, "changes"), false);
    assert.match(textOf(view.rows), /삭제 대상/); assert.doesNotMatch(textOf(view.rows), /완료 상태:|제목:|일시:|분류:/); assert.equal(cards(view).length, 1);
    assert.deepEqual(interactionButtons(view.rows).map(button => textOf(button)), ["아니요", "예"]);
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
    assert.equal(cards(view).length, count); assert.doesNotMatch(textOf(view.rows), /조회 완료/); assert.equal(interactionButtons(view.rows).length, 0);
    cards(view).forEach((card, n) => { assert.equal(card.key, items[n].id); assert.equal(card.props.schedule.id, items[n].id); assert.equal(card.props.schedule.completed, items[n].completed); assert.equal(card.props.showCompleted, true); });
  });
});

for (const [operation, label] of [["create", "등록"], ["update", "수정"], ["delete", "삭제"]]) test(`outcome success/${operation}: 변경 ID 보존·추측 카드와 Schedule write 없음`, async () => {
  const result = { kind: "outcome", text: "서버 완료 문구", outcome: "success", operation, schedulesChanged: true, affectedScheduleIds: [summary.id] };
  await showResult(result, (h, view) => {
    assert.ok(!textOf(view.rows).includes(`${label} 완료`));
    assert.equal(cards(view).length, 0);
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
    h.send("재고 일정 삭제해 줘"); await h.advance(700); let view = h.renderConversation(), buttons = interactionButtons(view.rows);
    assert.ok(buttons.length >= 2); assert.equal(buttons[0].props.disabled, false); buttons[0].props.onPress(); h.render();
    view = h.renderConversation(); buttons = interactionButtons(view.rows.at(-1)); assert.deepEqual(buttons.map(textOf), ["아니요", "예"]); assert.ok(buttons.every(button => !button.props.disabled));
    const before = h.mock.getState().schedules.length; buttons[1].props.onPress(); h.render(); assert.equal(h.mock.getState().schedules.length, before - 1); assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("실제 Mock 삭제 거절 버튼은 데이터 유지·이전 승인 무효화·HTTP 0회", async () => {
  const h = harness({ initialMode: "mock" }); try {
    h.send("작업장 안전 점검 삭제해 줘"); await h.advance(700);
    const before = h.mock.getState().schedules, message = h.messages().at(-1);
    const buttons = interactionButtons(h.renderConversation().rows.at(-1));
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
    const view = h.renderConversation(); assert.equal(cards(view).length, 0); assert.equal(interactionButtons(view.rows).length, 0);
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
    for (const button of interactionButtons(view.rows)) {
      assert.equal(button.props.disabled, kind !== "uncertain");
      if (kind === "uncertain") assert.equal(typeof button.props.onPress, "function"); else assert.equal(button.props.onPress, undefined);
    }
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
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.starts.length, 0); assert.equal(h.state.uuidCalls, 0);
    assert.equal(h.messages()[0].apiExecution.response.data.result.kind, "uncertain"); assert.equal(h.find("MessageInput").value, "새 독립 작업"); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

// 정보 보충 후속 text도 실제 화면·저장 장벽·HTTP·polling 경계를 통과시킨다.
const postedBodies = h => h.state.calls.filter(call => call.init.method === "POST").map(call => JSON.parse(call.init.body));
const lastPostExecution = h => h.messages().find(message => message.apiExecution?.reference.requestId === postedBodies(h).at(-1).requestId)?.apiExecution;
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

for (const [scenario, reply] of [["V6", "오후 2시로 잡아줘"], ["V7", "제목이 상차 화물 무게 배분 확인인 걸 찾고 있어"]]) for (const acceptedStatus of [200, 202]) {
  test(`Reload ${scenario} 후속 처리 ${acceptedStatus}: 정상 진행 요청에 이전 복구 기록 경고 없음`, async () => {
    const old = recoveryRef(id(980)), gate = deferred(), h = harness({ data: cleanupData(old), actualLifecycle: true });
    let sent;
    h.state.handle = async (url, options) => {
      if (options.method === "POST") { sent = JSON.parse(options.body); return json(status(sent.requestId), acceptedStatus); }
      if (url.endsWith(`/assistant/requests/${old.requestId}`)) return json({ ...done(old.requestId), result: results.need_more_info });
      return gate.promise;
    };
    const detach = h.attachLifecycle();
    try {
      await readyCleanup(h); assert.equal(postedBodies(h).length, 0);
      assert.equal(h.messages()[0].apiExecution.response.data.result.kind, "need_more_info");
      h.send(reply); await readyCleanup(h);
      assert.equal(sent.conversationId, id(100)); assert.deepEqual(sent.input, { type: "text", text: reply, questionId: id(300) });
      assert.notEqual(sent.requestId, old.requestId); assert.equal(await h.storage.read(old), null);
      const active = recoveryRef(sent.requestId); assert.ok(await h.storage.read(active));
      assert.equal(h.find("ConversationList").isProcessing, true);
      assert.ok(!textOf(h.renderConversation().footer).includes("이전 요청의 로컬 복구 기록이 남아 있어요"));
      assert.ok(!textOf(h.renderConversation().footer).includes("로컬 복구 기록 수동 정리"));
      gate.resolve(json({ ...done(sent.requestId), result: scenario === "V6" ? writeOutcome8b() : results.outcome }));
      await readyCleanup(h); assert.equal(h.messages().at(-1).apiExecution.response.data.result.kind, "outcome");
      assert.equal(postedBodies(h).length, 1); assert.equal(h.state.mockRuns, 0);
    } finally { gate.resolve(json(done(sent?.requestId ?? old.requestId))); await h.settle(); detach(); h.close(); }
  });
}

for (const failure of ["404", "network", "timeout"]) test(`Reload 복구 ${failure}: 미확정 요청은 GET-only·기록과 수동 정리 안내 보존`, async () => {
  const reference = recoveryRef(id(981)), h = harness({ data: cleanupData(reference), actualLifecycle: true });
  h.state.handle = () => {
    if (failure === "404") return error7a("ASSISTANT_REQUEST_NOT_FOUND", 404);
    if (failure === "network") throw new Error("대체 네트워크 오류");
    return new Promise(() => {});
  };
  const detach = h.attachLifecycle();
  try {
    await readyCleanup(h); if (failure === "timeout") await h.advance(5000);
    await readyCleanup(h);
    assert.equal(postedBodies(h).length, 0); assert.equal(h.state.calls.length, 1);
    assert.ok(h.state.calls[0].url.endsWith(`/assistant/requests/${reference.requestId}`));
    assert.ok(await h.storage.read(reference)); assert.equal(h.state.cleanup, 0);
    assert.equal(h.messages().at(-1).apiExecution.kind, "needs-attention");
    assert.ok(textOf(h.renderConversation().rows).includes("로컬 복구 기록 수동 정리"));
  } finally { detach(); h.close(); }
});

test("Reload 후속 접수 뒤 GET 실패: 이전 질문만 정리·새 미확정 요청 안내 유지", async () => {
  const old = recoveryRef(id(982)), gate = deferred(), h = harness({ data: cleanupData(old), actualLifecycle: true });
  let sent;
  h.state.handle = (url, options) => {
    if (options.method === "POST") { sent = JSON.parse(options.body); return json(status(sent.requestId), 202); }
    if (url.endsWith(`/assistant/requests/${old.requestId}`)) return json({ ...done(old.requestId), result: results.need_more_info });
    return gate.promise;
  };
  const detach = h.attachLifecycle();
  try {
    await readyCleanup(h); h.send("오후 2시로 잡아줘"); await readyCleanup(h);
    assert.equal(await h.storage.read(old), null);
    gate.resolve(error7a("ASSISTANT_REQUEST_NOT_FOUND", 404)); await readyCleanup(h);
    assert.equal(h.find("ConversationList").isProcessing, false);
    assert.equal(h.messages().at(-1).apiExecution.kind, "needs-attention");
    assert.ok(await h.storage.read(recoveryRef(sent.requestId)));
    assert.ok(textOf(h.renderConversation().rows).includes("로컬 복구 기록 수동 정리"));
    assert.equal(postedBodies(h).length, 1); assert.equal(h.state.mockRuns, 0);
  } finally { gate.resolve(error7a("ASSISTANT_REQUEST_NOT_FOUND", 404)); await h.settle(); detach(); h.close(); }
});

test("처리 중 복구 경고 제외는 현재 사용자 요청의 서버·ID에만 적용", async () => {
  const current = recoveryRef(id(983)), other = recoveryRef(id(984)), foreign = recoveryRef(id(983), "development:https://other.invalid"),
    h = harness({ data: cleanupData(current, other, foreign) });
  try {
    await readyCleanup(h);
    const props = h.find("ConversationList"); props.isProcessing = true;
    assert.equal(props.recoveryControls.length, 3);
    const view = h.renderConversation([{ id: current.requestId, role: "user", text: "후속 답변", serverId }]);
    const warnings = view.components.filter(node => node.name === "AssistantMessage" && node.props.recoveryIssue);
    assert.deepEqual(warnings.map(node => node.props.recoveryControl.reference), [other, foreign]);
    props.isProcessing = false;
    assert.equal(h.renderConversation([{ id: current.requestId, role: "user", text: "후속 답변", serverId }]).components
      .filter(node => node.name === "AssistantMessage" && node.props.recoveryIssue).length, 3);
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
    assert.ok(interactionButtons(view.rows).every(button => button.props.disabled === false));
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
    if (kind === "uncertain") { assert.equal(postedBodies(h).length, 2); assert.equal(lastPostExecution(h).response.data.result.kind, kind); }
    else { const body = postedBodies(h).at(-1); assert.equal(Object.hasOwn(body, "conversationId"), false); assert.equal(Object.hasOwn(body.input, "questionId"), false);
      assert.equal(Object.hasOwn(body, "acknowledgedUncertainRequestId"), false); assert.equal(h.messages().at(-1).apiExecution.response.data.result.kind, kind); }
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
    const problem = lastPostExecution(h).recoveryResult.postResult.error.problem; assert.equal(problem.code, code);
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
  return interactionButtons(h.renderConversation().rows[index]);
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
    assert.ok(!textOf(h.renderConversation().rows).includes("선택됨"));
    assert.equal(nodes(h.renderConversation().rows, "View").filter(node => node.props.testID === "assistant-candidate-check").length, 1);
    assert.equal(h.find("MessageInput").value, "보존할 초안");
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
    assert.equal(lastPostExecution(h).recoveryResult.postResult.error.problem.code, code);
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
    assert.ok(textOf(h.renderConversation().rows).includes(approved ? confirmationOutcome(true).text : "수정 취소됨"));
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
    assert.equal(interactionButtons(h.renderConversation().rows).length, 0); h.state.handle = responseWith(results.outcome); h.send(text); await h.settle();
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
    const problem = lastPostExecution(h).recoveryResult.postResult.error.problem; assert.equal(problem.code, code);
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

// 접수 오류·복구 GET·접수 후 failure를 실제 화면 경로에서 구분한다.
const error7a = (code, statusCode, extra = {}) => ({ status: statusCode,
  headers: new Headers({ "Content-Type": "application/problem+json", "X-Request-ID": id(900) }),
  text: async () => JSON.stringify({ type: "https://example.invalid/problem", title: "INTERNAL_JSON", detail: "STACK_MODEL_RAW_SECRET",
    instance: "/api/v1/assistant/requests", status: statusCode, requestId: id(900), code,
    ...(code === "VALIDATION_ERROR" ? { errors: [{ location: "body", pointer: "/input/text", code: "INVALID_VALUE", detail: "STACK_MODEL_RAW_SECRET" }] } : {}), ...extra }) });
const postMessage = h => h.messages().find(message => message.apiExecution?.reference.requestId === postedBodies(h).at(-1).requestId);
const active7a = (kind = "confirmation", extra = {}) => ({ ...done(id(640), kind), result: {
  ...results[kind], ...(["need_more_info", "candidate_selection", "confirmation"].includes(kind) ? { questionId: id(340) } : {}),
  ...(["candidate_selection", "confirmation"].includes(kind) ? { expiresAt: "2026-11-12T01:00:00Z" } : {}), ...extra } });
const stale7a = (extra = {}) => error7a("STALE_QUESTION", 409, { activeQuestionId: id(340), activeQuestionRequestId: id(640), ...extra });

for (const [code, httpStatus, expected] of [
  ["MALFORMED_REQUEST", 400, "요청 형식"], ["REQUEST_BODY_TOO_LARGE", 413, "16 KiB"], ["VALIDATION_ERROR", 422, "입력 값이나 형식"],
  ["REQUEST_ID_CONFLICT", 409, "같은 요청 ID"], ["CONVERSATION_BUSY", 409, "이미 처리 중인 작업"], ["STALE_QUESTION", 409, "새 요청을 입력"],
  ["QUESTION_EXPIRED", 409, "응답 기한"], ["CONVERSATION_EXPIRED", 409, "대화가 만료"], ["REQUEST_EXPIRED", 409, "다시 접수할 수 없어요"],
  ["ASSISTANT_REQUEST_NOT_FOUND", 404, "미실행을 뜻하지"], ["ASSISTANT_CONVERSATION_NOT_FOUND", 404, "대화 기록"],
  ["ASSISTANT_TARGET_NOT_FOUND", 404, "취소 대상 기록"], ["ROUTE_NOT_FOUND", 404, "API 경로"], ["ASSISTANT_UNAVAILABLE", 503, "수동 일정 관리"],
  ["DATABASE_UNAVAILABLE", 503, "데이터베이스"], ["INTERNAL_ERROR", 500, "서버 오류"],
  ["UNRESOLVED_UNCERTAIN", 409, "새 작업이 보류"], ["ACKNOWLEDGEMENT_NOT_APPLICABLE", 409, "보류 해제는 확인되지"],
]) test(`7-A ${httpStatus} ${code}: code별 안내·원형 보존·내부 출력/자동 POST 없음`, async () => {
  const h = harness(); h.state.handle = () => error7a(code, httpStatus);
  try {
    h.send("입력 원문"); await h.settle(); const message = postMessage(h), error = message.apiExecution.recoveryResult.postResult.error;
    assert.equal(error.status, httpStatus); assert.equal(error.problem.code, code); assert.ok(message.text.includes(expected));
    assert.equal(message.apiExecution.kind, "needs-attention"); assert.equal(error.problem.detail, "STACK_MODEL_RAW_SECRET");
    assert.ok(!textOf(h.renderConversation().rows).includes("STACK_MODEL_RAW_SECRET")); assert.ok(!textOf(h.renderConversation().rows).includes("INTERNAL_JSON"));
    assert.equal(h.find("MessageInput").value, "입력 원문"); assert.equal(postedBodies(h).length, 1); assert.equal(h.state.uuidCalls, 1); assert.equal(h.state.cleanup, 0);
    assert.equal(h.state.calls.length, 1);
  } finally { h.close(); }
});

for (const [code, nextAction, expected] of [["MODEL_OUTPUT_INVALID", "revise_input", "입력 내용을 수정"],
  ["MODEL_TIMEOUT", "retry_later", "나중에 다시 요청"], ["INTERNAL_ERROR", "none", "요청 결과를 확인"]]) test(`7-A completed failure ${nextAction}: HTTP 오류와 분리·서버 text 유지·자동 write 없음`, async () => {
  const h = harness(), result = { kind: "failure", text: "서버가 제공한 사용자 안내 원문", code, nextAction };
  h.state.handle = responseWith(result);
  try { h.send("요청"); await h.settle(); const message = h.messages().at(-1);
    assert.equal(message.text, result.text); assert.equal(message.apiExecution.kind, "completed"); assert.deepEqual(message.apiExecution.response.data.result, result);
    assert.ok(textOf(h.renderConversation().rows).includes(expected)); assert.equal(postedBodies(h).length, 1); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const kind of ["need_more_info", "candidate_selection", "confirmation"]) test(`7-A STALE 현재 ${kind} 복구: 미저장 ID GET·동일 대화/질문 검증 후 명시적 입력만 허용`, async () => {
  const h = harness(), before = h.mock.getState().schedules;
  try {
    const old = await liveConfirmation(h), oldClick = confirmationButtons(h, old.id)[1].props.onPress;
    h.state.handle = (url, init) => init.method === "POST" ? stale7a() : json(active7a(kind));
    oldClick(); h.render(); await h.settle(); assert.equal(postedBodies(h).length, 2);
    assert.ok(h.state.calls.at(-1).url.endsWith(id(640))); assert.equal(h.state.calls.at(-1).init.method, "GET");
    assert.equal(postMessage(h).apiErrorRecovery.status, "restored"); assert.equal(lastPostExecution(h).recoveryResult.postResult.error.problem.activeQuestionId, id(340));
    assert.equal(await h.storage.read(recoveryRef(id(640))), null); assert.ok(confirmationButtons(h, old.id).every(button => button.props.disabled));
    const recoveredMessage = h.messages().find(message => message.apiExecution?.reference.requestId === id(640));
    assert.deepEqual(recoveredMessage.apiExecution.response.data.result, active7a(kind).result); const count = h.state.calls.length; oldClick(); await h.settle(); assert.equal(h.state.calls.length, count);
    h.state.handle = responseWith(results.outcome);
    if (kind === "need_more_info") h.send("복구 질문의 답변");
    else candidateButtons(h, recoveredMessage.id)[0].props.onPress();
    h.render(); await h.settle(); const body = postedBodies(h).at(-1);
    assert.equal(body.conversationId, id(100)); assert.equal(body.input.questionId, id(340));
    assert.equal(body.input.type, kind === "need_more_info" ? "text" : kind === "candidate_selection" ? "selection" : "confirmation");
    if (kind === "confirmation") assert.equal(body.input.approved, false);
    assert.strictEqual(h.mock.getState().schedules, before); assert.equal(h.state.mockRuns, 0); assert.equal(h.state.cleanup, 0);
    assert.ok(h.state.calls.every(call => call.url.startsWith(`${origin}/api/v1/assistant/requests`)));
  } finally { h.close(); }
});

for (const mismatch of ["question", "conversation", "kind", "expired", "missing-question-field"]) test(`7-A STALE ${mismatch} 불일치: 카드 표시와 활성화 분리·과거 승인 POST 0회`, async () => {
  const h = harness(); try {
    const old = await liveConfirmation(h), oldClick = confirmationButtons(h, old.id)[1].props.onPress;
    const data = mismatch === "kind" ? active7a("outcome") : active7a("confirmation", mismatch === "question" ? { questionId: id(341) }
      : mismatch === "expired" ? { expiresAt: "1970-01-01T00:00:00Z" } : {});
    if (mismatch === "conversation") data.conversationId = id(101);
    h.state.handle = (url, init) => init.method === "POST" ? stale7a(mismatch === "missing-question-field" ? { activeQuestionId: null } : {}) : json(data);
    oldClick(); h.render(); await h.settle(); assert.equal(postMessage(h).apiErrorRecovery.status, "mismatch");
    assert.ok(interactionButtons(h.renderConversation().rows).every(button => button.props.disabled));
    oldClick(); confirmApi(h, h.messages().at(-1).id, true); await h.settle(); assert.equal(postedBodies(h).length, 2); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const failure of ["503", "404", "timeout", "storage"]) test(`7-A STALE GET ${failure} 실패: 원인 보존·자동 승인/선택·metadata 삭제 없음`, async () => {
  const h = harness(); try {
    const old = await liveConfirmation(h), late = confirmationButtons(h, old.id)[1].props.onPress;
    h.state.handle = (url, init) => {
      if (init.method === "POST") { if (failure === "storage") h.state.failRead = true; return stale7a(); }
      return failure === "timeout" ? deferred().promise : error7a(failure === "404" ? "ASSISTANT_REQUEST_NOT_FOUND" : "ASSISTANT_UNAVAILABLE", failure === "404" ? 404 : 503);
    };
    late(); h.render(); await h.settle(); if (failure === "timeout") await h.advance(5000);
    assert.equal(postMessage(h).apiErrorRecovery.status, "unconfirmed"); assert.ok(confirmationButtons(h, old.id).every(button => button.props.disabled));
    const count = h.state.calls.length; late(); await h.settle(); assert.equal(h.state.calls.length, count); assert.equal(postedBodies(h).length, 2); assert.equal(h.state.cleanup, 0);
    assert.ok(postMessage(h).apiErrorRecovery.result.recoveryResult.getResult.error.kind);
  } finally { h.state.failRead = false; h.close(); }
});

test("7-A STALE conversation을 확정할 수 없으면 GET 카드만 표시하고 대화 ID를 임의 재사용하지 않음", async () => {
  const h = harness(); h.state.handle = (url, init) => init.method === "POST" ? stale7a() : json(active7a());
  try { h.send("첫 독립 요청"); await h.settle(); assert.equal(postMessage(h).apiErrorRecovery.status, "mismatch");
    assert.ok(interactionButtons(h.renderConversation().rows).every(button => button.props.disabled));
    h.state.handle = responseWith(results.outcome); h.send("명시적 새 요청"); await h.settle(); assert.equal(Object.hasOwn(postedBodies(h).at(-1), "conversationId"), false);
  } finally { h.close(); }
});

test("7-A STALE 복구 중 새 lifecycle 질문 도착: 늦은 GET 적용·이전 승인 부활 없음", async () => {
  const h = harness(), gate = deferred(); try {
    const old = await liveConfirmation(h); h.state.handle = (url, init) => init.method === "POST" ? stale7a() : gate.promise;
    confirmationButtons(h, old.id)[1].props.onPress(); h.render(); await h.settle(); h.edit("최신 초안");
    const latest = recovered("need_more_info", id(650)); h.publishSnapshot(snapshotOf([latest]));
    gate.resolve(json(active7a())); await h.settle(); assert.equal(postMessage(h).apiErrorRecovery.status, "context-changed");
    assert.equal(h.messages().some(message => message.apiExecution?.reference.requestId === id(640)), false);
    assert.equal(h.find("MessageInput").value, "최신 초안"); assert.equal(postedBodies(h).length, 2);
  } finally { h.close(); }
});

test("7-A STALE 복구 중 동일 snapshot 반복은 새 질문으로 취급하지 않고 복구 메시지 중복 없음", async () => {
  const h = harness(), gate = deferred(); try {
    const old = await liveConfirmation(h); h.state.handle = (url, init) => init.method === "POST" ? stale7a() : gate.promise;
    confirmationButtons(h, old.id)[0].props.onPress(); h.render(); await h.settle();
    h.publishSnapshot(snapshotOf([old.apiExecution])); h.publishSnapshot(snapshotOf([old.apiExecution]));
    gate.resolve(json(active7a())); await h.settle(); assert.equal(postMessage(h).apiErrorRecovery.status, "restored");
    h.render(); h.render(); assert.equal(h.messages().filter(message => message.apiExecution?.reference.requestId === id(640)).length, 1);
    assert.equal(h.state.calls.filter(call => call.url.endsWith(id(640))).length, 1); assert.equal(postedBodies(h).length, 2);
  } finally { h.close(); }
});

for (const change of ["server", "mode", "unmount"]) test(`7-A 복구 GET 중 ${change}: 늦은 결과·다른 서버 조회·자동 POST 없음`, async () => {
  const h = harness(), gate = deferred(); try {
    const old = await liveConfirmation(h); h.state.handle = (url, init) => init.method === "POST" ? stale7a() : gate.promise;
    confirmationButtons(h, old.id)[1].props.onPress(); h.render(); await h.settle(); const count = h.state.calls.length;
    if (change === "server") { h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid"); h.publishSnapshot(snapshotOf([], { serverId: "development:https://other.example.invalid" })); }
    else if (change === "mode") h.switchMode("mock"); else h.close();
    gate.resolve(json(active7a())); await h.settle(); assert.equal(h.state.calls.length, count); assert.equal(h.state.lateUpdates, 0); assert.equal(h.state.cleanup, 0);
    if (change !== "unmount") assert.equal(h.messages().some(message => message.apiExecution?.reference.requestId === id(640)), false);
  } finally { h.close(); }
});

for (const value of ["accepted", "processing", "completed"]) test(`7-A BUSY 미저장 blocking ID 단발 GET ${value}: 상태 원형·추가 polling/POST 없음`, async () => {
  const h = harness(); h.state.handle = (url, init) => init.method === "POST" ? error7a("CONVERSATION_BUSY", 409, { blockingRequestId: id(640) })
    : json(value === "completed" ? active7a("uncertain") : status(id(640), value));
  try { h.send("새 요청"); await h.settle(); assert.equal(postMessage(h).apiErrorRecovery.status, "observed");
    const target = h.messages().find(message => message.apiExecution?.reference.requestId === id(640)).apiExecution;
    assert.equal(target.kind, value === "completed" ? "completed" : "observed"); assert.equal(target.response.data.status, value);
    if (value === "completed") assert.equal(target.response.data.result.kind, "uncertain"); else assert.equal(Object.hasOwn(target.response.data, "result"), false);
    const count = h.state.calls.length; await h.advance(4000); assert.equal(h.state.calls.length, count); assert.equal(postedBodies(h).length, 1);
    assert.equal(await h.storage.read(recoveryRef(id(640))), null); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("7-A BUSY GET 실패는 작업 실패 확정이 아니며 새 POST·질문 자동 실행 없음", async () => {
  const h = harness(); h.state.handle = (url, init) => init.method === "POST" ? error7a("CONVERSATION_BUSY", 409, { blockingRequestId: id(640) }) : error7a("DATABASE_UNAVAILABLE", 503);
  try { h.send("입력"); await h.settle(); assert.equal(postMessage(h).apiErrorRecovery.status, "unconfirmed");
    assert.equal(h.messages().at(-1).apiExecution.kind, "needs-attention");
    assert.equal(h.renderConversation().components.some(item => item.name === "AssistantMessage" && item.props.apiResult?.kind === "failure"), false);
    assert.equal(postedBodies(h).length, 1); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("7-A 기존 polling 조회 잠금과 BUSY 복구 경합: 추가 GET·새 polling·기존 작업 취소 없음", async () => {
  const h = harness(), gate = deferred(); let external = false;
  try {
    h.state.handle = (url, init) => init.method === "POST" ? external ? error7a("CONVERSATION_BUSY", 409, { blockingRequestId: id(640) }) : json(status(JSON.parse(init.body).requestId), 202) : gate.promise;
    const running = h.delegate.startRequest({ requestId: id(640), input: { type: "text", text: "기존 작업" } }, { expectedServerId: serverId });
    await h.settle(); external = true; h.send("경합 요청"); await h.settle(); assert.equal(postMessage(h).apiErrorRecovery.status, "busy");
    assert.equal(h.state.calls.filter(call => call.init.method === "GET").length, 1);
    gate.resolve(json(done(id(640)))); await h.settle(); assert.equal((await running.completion).kind, "completed");
    assert.equal(postedBodies(h).length, 2); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("7-A 만료 conversation의 과거·새 GET 질문을 모두 재사용하지 않고 명시적 새 입력만 허용", async () => {
  const h = harness(); h.state.handle = responseWith(results.need_more_info);
  try { h.send("회의 등록"); await h.settle(); const old = h.messages().at(-1); h.state.handle = () => error7a("CONVERSATION_EXPIRED", 409);
    h.send("오후 3시"); await h.settle(); h.publishSnapshot(snapshotOf([old.apiExecution, recovered("need_more_info", id(650))]));
    h.state.handle = responseWith(results.outcome); h.send("명시적 새 일정 조회"); await h.settle();
    assert.equal(postedBodies(h).length, 3); assert.equal(Object.hasOwn(postedBodies(h).at(-1), "conversationId"), false);
    assert.equal(Object.hasOwn(postedBodies(h).at(-1).input, "questionId"), false); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("7-A GET 410 상세 만료와 POST 409 재접수 금지 안내 구분·metadata 정리 없음", async () => {
  const h = harness(); try {
    await h.storage.saveBeforePost(recoveryRef(id(640)), h.wall); const before = [...h.data.values()].join("");
    h.state.handle = () => error7a("REQUEST_EXPIRED", 410); const result = await h.delegate.queryRequestOnce(recoveryRef(id(640))).completion;
    h.publishSnapshot(snapshotOf([result])); assert.ok(h.messages()[0].text.includes("상세 보관 기간")); assert.ok(h.messages()[0].text.includes("이전 성공·실패는 알 수 없어요"));
    assert.ok(!h.messages()[0].text.includes("다시 접수할 수 없어요")); assert.equal([...h.data.values()].join(""), before);
    h.state.handle = () => error7a("REQUEST_EXPIRED", 409); h.send("새 입력"); await h.settle(); assert.ok(postMessage(h).text.includes("다시 접수할 수 없어요"));
    assert.equal(h.state.cleanup, 0); assert.equal(postedBodies(h).length, 1);
  } finally { h.close(); }
});

test("7-A 120초 자동 조회 종료는 결과 확인 필요 상태·metadata 보존·추가 POST 없음", async () => {
  const h = harness(); h.state.handle = (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202) : json(status(url.split("/").pop(), "processing"));
  try { h.send("요청"); await h.settle(); await h.advance(120000); const message = h.messages().at(-1);
    assert.equal(message.apiExecution.reason, "deadline"); assert.ok(message.text.includes("자동 확인 시간이 끝났어요"));
    assert.ok(await h.storage.read(recoveryRef(postedBodies(h)[0].requestId))); assert.equal(h.state.cleanup, 0); assert.equal(postedBodies(h).length, 1);
  } finally { h.close(); }
});

test("7-A 활성 질문 ID가 일치해도 같은 질문의 이전 만료 시각을 GET으로 연장하지 않음", async () => {
  const h = harness(); try {
    const old = await liveConfirmation(h);
    const expired = recovered("confirmation", id(640)); expired.response.data.result = { ...active7a().result, expiresAt: "1970-01-01T00:00:00Z" };
    h.publishSnapshot(snapshotOf([expired])); h.state.handle = (url, init) => init.method === "POST" ? stale7a() : json(active7a());
    confirmationButtons(h, old.id)[1].props.onPress(); h.render(); await h.settle();
    assert.equal(postMessage(h).apiErrorRecovery.status, "mismatch"); assert.ok(interactionButtons(h.renderConversation().rows).every(button => button.props.disabled));
    assert.equal(postedBodies(h).length, 2); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

// 인지 의사와 서버 접수 확인은 별도로 검증한다. 실제 저장소·서버는 사용하지 않는다.
async function liveUncertain(h) { h.state.handle = responseWith(results.uncertain); h.send("일정 변경"); await h.settle(); return h.messages().at(-1).apiExecution.reference.requestId; }
const riskView = (h, id) => h.find("ConversationList").uncertainViews?.find(value => value.requestId.toLowerCase() === id.toLowerCase());
function riskButtons(h, id) {
  const index = h.messages().findIndex(message => message.apiExecution?.reference.requestId.toLowerCase() === id.toLowerCase());
  const buttons = interactionButtons(h.renderConversation().rows[index]);
  return { check: buttons.find(button => textOf(button).includes("결과 확인")), acknowledge: buttons.find(button => textOf(button).includes("위험을 이해")) };
}
function armRisk(h, id) { riskButtons(h, id).acknowledge.props.onPress(); h.render(); }
function checkRisk(h, id) { riskButtons(h, id).check.props.onPress(); h.render(); }
const riskDone = (id, kind = "uncertain") => done(id, kind);

test("7-B uncertain 원문·check_status·write 반영 위험 안내와 인지 전 새 작업 보류", async () => {
  const h = harness(), before = h.mock.getState().schedules;
  try {
    const id = await liveUncertain(h), text = textOf(h.renderConversation().rows);
    assert.equal(h.messages().at(-1).text, results.uncertain.text); assert.equal(h.messages().at(-1).apiExecution.response.data.result.nextAction, "check_status");
    assert.ok(text.includes("반영됐을 수")); assert.ok(text.includes("중복될 위험")); assert.ok(text.includes("취소·성공·실패 판정이 아니")); assert.ok(text.includes("일정 목록"));
    assert.equal(h.messages().at(-1).apiExecution.response.data.result.schedulesChanged, undefined);
    h.send("새 작업"); await h.settle(); assert.equal(postedBodies(h).length, 1); assert.equal(h.state.uuidCalls, 1); assert.equal(riskView(h, id).armed, false);
    assert.equal(h.find("MessageInput").value, "새 작업"); assert.strictEqual(h.mock.getState().schedules, before); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("7-B 인지 버튼·입력·탭 재렌더만으로 POST 없음, 명시적 새 text에만 별도 UUID와 ack ID", async () => {
  const h = harness(); try {
    const id = await liveUncertain(h), button = riskButtons(h, id).acknowledge.props.onPress, count = h.state.calls.length;
    h.edit("새 독립 작업"); h.render(); assert.equal(riskView(h, id).armed, false); button(); button(); h.render();
    assert.equal(h.state.calls.length, count); assert.equal(h.state.uuidCalls, 1); assert.equal(riskView(h, id).armed, true); assert.equal(riskView(h, id).acknowledged, false);
    h.state.handle = responseWith(results.outcome); h.find("MessageInput").onSend(); await h.settle(); const body = postedBodies(h).at(-1);
    assert.notEqual(body.requestId, id);
    assert.deepEqual(body, { requestId: body.requestId, acknowledgedUncertainRequestId: id, input: { type: "text", text: "새 독립 작업" } });
    assert.equal(riskView(h, id).acknowledged, true); assert.equal(h.state.uuidCalls, 2); assert.equal(h.state.cleanup, 0);
    const saved = [...h.data.values()].join(""); assert.equal(saved.includes("acknowledgedUncertainRequestId"), false); assert.equal(saved.includes("새 독립 작업"), false);
  } finally { h.close(); }
});

test("7-B 수동 GET은 120초 이후에도 원래 ID만 사용·연타 GET 1회·여전히 uncertain 유지", async () => {
  const h = harness(), gate = deferred(); try {
    const id = await liveUncertain(h); await h.advance(120000); h.state.handle = () => gate.promise;
    const buttons = riskButtons(h, id), check = buttons.check.props.onPress; check(); check(); buttons.acknowledge.props.onPress(); h.render(); await h.settle();
    assert.equal(riskView(h, id).armed, false);
    assert.equal(h.state.calls.at(-1).init.method, "GET"); assert.ok(h.state.calls.at(-1).url.endsWith(id)); assert.equal(h.state.calls.length, 3);
    gate.resolve(json(riskDone(id))); await h.settle(); assert.equal(riskView(h, id).state, "uncertain"); assert.equal(h.messages().length, 2);
    assert.equal(postedBodies(h).length, 1); assert.equal(h.state.uuidCalls, 1); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const kind of ["outcome", "failure"]) test(`7-B uncertain → ${kind}: 같은 메시지 갱신·위험 인지 대기 무효화·과거 결과로 되돌림 없음`, async () => {
  const h = harness(); try {
    const id = await liveUncertain(h), messageId = h.messages().at(-1).id, oldAcknowledge = riskButtons(h, id).acknowledge.props.onPress; armRisk(h, id);
    h.state.handle = () => json(riskDone(id, kind)); checkRisk(h, id); await h.settle();
    assert.equal(h.messages().at(-1).id, messageId); assert.equal(h.messages().at(-1).apiExecution.response.data.result.kind, kind); assert.equal(riskView(h, id), undefined);
    h.publishSnapshot(snapshotOf([recovered("uncertain", id)])); assert.equal(h.messages().at(-1).apiExecution.response.data.result.kind, kind);
    oldAcknowledge?.(); h.state.handle = responseWith(results.outcome); h.send("명시적 다음 작업"); await h.settle();
    assert.equal(Object.hasOwn(postedBodies(h).at(-1), "acknowledgedUncertainRequestId"), false); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const value of ["accepted", "processing"]) test(`7-B 수동 GET ${value}: 진행 중으로 표시·인지/새 POST/자동 polling 없음`, async () => {
  const h = harness(); try {
    const id = await liveUncertain(h); h.state.handle = () => json(status(id, value)); checkRisk(h, id); await h.settle();
    assert.equal(h.messages().at(-1).apiExecution.kind, "observed"); assert.equal(h.messages().at(-1).apiExecution.response.data.status, value);
    assert.equal(riskView(h, id).state, "pending"); assert.equal(riskButtons(h, id).acknowledge.props.disabled, true);
    const count = h.state.calls.length; await h.advance(4000); h.send("새 작업"); await h.settle(); assert.equal(h.state.calls.length, count); assert.equal(postedBodies(h).length, 1);
    h.publishSnapshot(snapshotOf([recovered("uncertain", id)])); assert.equal(h.messages().find(message => message.apiExecution?.reference.requestId === id).apiExecution.kind, "observed");
  } finally { h.close(); }
});

for (const failure of ["404", "503", "timeout", "network", "storage", "410"]) test(`7-B 수동 GET ${failure}: 원문·구조화 오류·metadata 보존, 실패/미실행으로 단정하지 않음`, async () => {
  const h = harness(); try {
    const id = await liveUncertain(h), before = [...h.data.values()].join("");
    if (failure === "storage") h.state.failRead = true;
    h.state.handle = () => { if (failure === "network") throw Error("연결 실패"); if (failure === "timeout") return deferred().promise;
      return error7a(failure === "410" ? "REQUEST_EXPIRED" : failure === "404" ? "ASSISTANT_REQUEST_NOT_FOUND" : "ASSISTANT_UNAVAILABLE", Number(failure) || 503); };
    checkRisk(h, id); await h.settle(); if (failure === "timeout") await h.advance(5000);
    const message = h.messages().at(-1); assert.equal(message.text, results.uncertain.text); assert.equal(message.apiExecution.kind, "needs-attention");
    assert.equal(riskView(h, id).state, failure === "410" ? "expired" : "unknown"); assert.equal(riskButtons(h, id).acknowledge.props.disabled, true);
    if (failure === "404") assert.ok(textOf(h.renderConversation().rows).includes("미실행을 뜻하지"));
    if (failure === "410") assert.ok(textOf(h.renderConversation().rows).includes("이전 성공·실패는 알 수 없어요"));
    assert.equal([...h.data.values()].join(""), before); assert.equal(h.state.cleanup, 0); assert.equal(postedBodies(h).length, 1);
  } finally { h.state.failRead = false; h.close(); }
});

test("7-B UNRESOLVED_UNCERTAIN은 서버 blocking ID GET 후 실제 uncertain만 인지 대상으로 사용", async () => {
  const h = harness(); h.state.handle = (url, init) => init.method === "POST" ? error7a("UNRESOLVED_UNCERTAIN", 409, { blockingRequestId: id(700) }) : json(done(id(700), "uncertain"));
  try { h.send("새 작업"); await h.settle(); assert.equal(lastPostExecution(h).recoveryResult.postResult.error.problem.blockingRequestId, id(700));
    assert.ok(h.state.calls.at(-1).url.endsWith(id(700))); assert.equal(riskView(h, id(700)).canAcknowledge, true);
    assert.equal(Object.hasOwn(postedBodies(h)[0], "acknowledgedUncertainRequestId"), false); assert.equal(postedBodies(h).length, 1);
  } finally { h.close(); }
});

for (const failure of ["missing", "404", "invalid"]) test(`7-B blocking ID ${failure}: 임의 인지 대상·새 conversation 우회·자동 POST 없음`, async () => {
  const h = harness(); h.state.handle = (url, init) => init.method === "POST" ? error7a("UNRESOLVED_UNCERTAIN", 409, failure === "missing" ? {} : { blockingRequestId: id(700) })
    : failure === "invalid" ? json({ ...done(id(700)), status: "잘못된 상태" }) : error7a("ASSISTANT_REQUEST_NOT_FOUND", 404);
  try { h.send("첫 시도"); await h.settle(); assert.ok(!h.find("ConversationList").uncertainViews.some(view => view.canAcknowledge));
    const count = h.state.calls.length; h.send("다른 새 대화"); await h.settle(); assert.equal(h.state.calls.length, count); assert.equal(postedBodies(h).length, 1);
  } finally { h.close(); }
});

test("7-B 복수 uncertain: 서버 blocking ID 우선·거절된 인지 미반영·한 번의 인지로 모두 해제하지 않음", async () => {
  const h = harness(); try {
    const first = await liveUncertain(h), second = id(701); h.publishSnapshot(snapshotOf([recovered("uncertain", second)])); armRisk(h, first);
    h.state.handle = (url, init) => init.method === "POST" ? error7a("UNRESOLVED_UNCERTAIN", 409, { blockingRequestId: second }) : json(done(second, "uncertain"));
    h.send("새 작업 시도"); await h.settle(); assert.equal(riskView(h, first).acknowledged, false); assert.equal(riskView(h, first).canAcknowledge, false); assert.equal(riskView(h, second).canAcknowledge, true);
    armRisk(h, second); h.state.handle = responseWith(results.outcome); h.send("서버가 지정한 위험 인지 후 새 작업"); await h.settle();
    assert.equal(postedBodies(h).at(-1).acknowledgedUncertainRequestId, second); assert.equal(riskView(h, second).acknowledged, true); assert.equal(riskView(h, first).acknowledged, false);
    const count = postedBodies(h).length; h.send("남은 위험을 건너뛴 작업"); await h.settle(); assert.equal(postedBodies(h).length, count);
  } finally { h.close(); }
});

for (const kind of ["candidate_selection", "confirmation", "need_more_info"]) test(`7-B 활성 ${kind}에는 ack를 붙이지 않고 명시적 인지 다음 새 독립 text만 허용`, async () => {
  const h = harness(); try {
    if (kind === "candidate_selection") await liveCandidates(h); else if (kind === "confirmation") await liveConfirmation(h);
    else { h.state.handle = responseWith(results.need_more_info); h.send("질문"); await h.settle(); }
    const old = h.messages().at(-1), idRisk = id(700); h.publishSnapshot(snapshotOf([recovered("uncertain", idRisk)])); armRisk(h, idRisk);
    h.find("ConversationList").onApiCandidateSelection(old.id, "opaque/1"); h.find("ConversationList").onApiConfirmation(old.id, true); await h.settle();
    assert.equal(postedBodies(h).length, 1); h.state.handle = responseWith(results.outcome); h.send("위험을 인지한 뒤 직접 작성한 새 작업"); await h.settle();
    const body = postedBodies(h).at(-1); assert.equal(body.input.type, "text"); assert.equal(body.acknowledgedUncertainRequestId, idRisk);
    assert.equal(Object.hasOwn(body, "conversationId"), false); assert.equal(Object.hasOwn(body.input, "questionId"), false);
  } finally { h.close(); }
});

for (const reason of ["storage-write", "storage-read", "422", "503"]) test(`7-B ack 새 text 접수 전 ${reason} 실패: 인지 미완료·원문/초안 보존·명시적 재시도만 가능`, async () => {
  const h = harness(); try {
    const id = await liveUncertain(h); armRisk(h, id);
    if (reason === "storage-write") h.state.failStorage = true; else if (reason === "storage-read") h.state.failRead = true;
    else h.state.handle = () => error7a(reason === "422" ? "VALIDATION_ERROR" : "ASSISTANT_UNAVAILABLE", Number(reason));
    h.send("실제 새 입력"); await h.settle(); assert.equal(riskView(h, id).acknowledged, false); assert.equal(riskView(h, id).armed, true);
    assert.equal(h.find("MessageInput").value, "실제 새 입력"); assert.equal(postedBodies(h).length, reason.startsWith("storage") ? 1 : 2);
    h.state.failStorage = false; h.state.failRead = false; h.state.handle = responseWith(results.outcome); h.find("MessageInput").onSend(); await h.settle();
    assert.equal(postedBodies(h).at(-1).acknowledgedUncertainRequestId, id); assert.equal(riskView(h, id).acknowledged, true);
  } finally { h.state.failRead = false; h.close(); }
});

test("7-B ack 접수 2xx 후 metadata/GET 실패: 인지 반영·새 작업 결과 GET만 가능·중복 POST 0회", async () => {
  const h = harness(); try {
    const id = await liveUncertain(h); armRisk(h, id);
    h.state.handle = (url, init) => { if (init.method === "POST") { h.state.failStorage = true; return json(status(JSON.parse(init.body).requestId), 202); }
      return error7a("ASSISTANT_UNAVAILABLE", 503); };
    h.send("새 작업"); await h.settle(); h.state.failStorage = false; const nextId = postedBodies(h).at(-1).requestId;
    assert.equal(riskView(h, id).acknowledged, true); assert.equal(riskView(h, id).pendingRequestId, nextId); assert.equal(h.find("MessageInput").value, "");
    h.send("또 보내기"); await h.settle(); assert.equal(postedBodies(h).length, 2);
    h.state.handle = url => json(done(url.split("/").pop())); checkRisk(h, id); await h.settle(); assert.ok(h.state.calls.at(-1).url.endsWith(nextId));
    assert.equal(riskView(h, id).pendingRequestId, undefined); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const failedGet of ["503", "storage"]) test(`7-B ack POST 응답 유실·GET ${failedGet} 실패: 새 UUID 재전송 금지·원래 새 요청 ID GET으로 접수 확인`, async () => {
  const h = harness(); try {
    const id = await liveUncertain(h); armRisk(h, id);
    h.state.handle = (url, init) => { if (init.method === "POST") { if (failedGet === "storage") h.state.failRead = true; throw Error("POST 응답 유실"); }
      return error7a("ASSISTANT_UNAVAILABLE", 503); };
    h.send("새 작업"); await h.settle(); const nextId = postedBodies(h).at(-1).requestId;
    assert.equal(riskView(h, id).acknowledged, false); assert.equal(riskView(h, id).pendingRequestId, nextId);
    const count = h.state.calls.length; h.find("MessageInput").onSend(); await h.settle(); assert.equal(h.state.calls.length, count); assert.equal(h.state.uuidCalls, 2);
    h.state.failRead = false; h.state.handle = url => json(status(url.split("/").pop(), "processing")); checkRisk(h, id); await h.settle();
    assert.ok(h.state.calls.at(-1).url.endsWith(nextId)); assert.equal(riskView(h, id).acknowledged, true); assert.equal(riskView(h, id).pendingRequestId, nextId);
    h.state.handle = url => json(done(url.split("/").pop())); checkRisk(h, id); await h.settle(); assert.equal(riskView(h, id).pendingRequestId, undefined);
    assert.equal(postedBodies(h).length, 2); assert.equal(h.state.cleanup, 0);
  } finally { h.state.failRead = false; h.close(); }
});

test("7-B ack POST 응답 유실 후 GET-first 제한 재전송은 동일 ID/body·인지 ID를 유지", async () => {
  const h = harness(); let posts = 0, gets = 0; try {
    const id = await liveUncertain(h); armRisk(h, id);
    h.state.handle = (url, init) => { if (init.method === "POST") { if (++posts === 1) throw Error("유실"); return json(status(JSON.parse(init.body).requestId), 202); }
      return ++gets === 1 ? error7a("ASSISTANT_REQUEST_NOT_FOUND", 404) : json(done(url.split("/").pop())); };
    h.send("새 작업 원문"); await h.settle(); const bodies = postedBodies(h);
    assert.equal(bodies.length, 3); assert.deepEqual(bodies[1], bodies[2]); assert.equal(bodies[1].acknowledgedUncertainRequestId, id);
    assert.equal(h.state.uuidCalls, 2); assert.equal(riskView(h, id).acknowledged, true); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const kind of ["outcome", "uncertain"]) test(`7-B ACKNOWLEDGEMENT_NOT_APPLICABLE 후 원래 ID GET ${kind}: 인지 완료로 처리하지 않음`, async () => {
  const h = harness(); try {
    const id = await liveUncertain(h); armRisk(h, id);
    h.state.handle = (url, init) => init.method === "POST" ? error7a("ACKNOWLEDGEMENT_NOT_APPLICABLE", 409) : json(done(url.split("/").pop(), kind));
    h.send("새 작업"); await h.settle(); assert.ok(h.state.calls.at(-1).url.endsWith(id)); assert.equal(postedBodies(h).length, 2);
    if (kind === "outcome") { assert.equal(riskView(h, id), undefined); assert.equal(h.messages().find(message => message.apiExecution?.reference.requestId === id).apiExecution.response.data.result.kind, "outcome"); }
    else { assert.equal(riskView(h, id).acknowledged, false); assert.equal(riskView(h, id).canAcknowledge, false); }
    assert.equal(lastPostExecution(h).recoveryResult.postResult.error.problem.code, "ACKNOWLEDGEMENT_NOT_APPLICABLE"); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const change of ["mode", "server", "restart"]) test(`7-B ${change}: 이전 서버·세션의 인지 의사와 오래된 callback을 재사용하지 않음`, async () => {
  const h = harness(); let restarted; try {
    const id = await liveUncertain(h), oldButton = riskButtons(h, id).acknowledge.props.onPress; armRisk(h, id);
    if (change === "restart") {
      restarted = harness({ data: h.data, initialSnapshot: snapshotOf([recovered("uncertain", id)]) }); restarted.send("새 작업"); await restarted.settle();
      assert.equal(restarted.state.calls.length, 0); assert.equal(riskView(restarted, id).armed, false);
    } else {
      if (change === "mode") { h.switchMode("mock"); h.switchMode("server"); h.publishSnapshot(snapshotOf([recovered("uncertain", id)])); }
      else { const other = "development:https://other.example.invalid"; h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid");
        h.publishSnapshot(snapshotOf([recovered("uncertain", id, other)], { serverId: other })); }
      oldButton(); h.render(); assert.equal(riskView(h, id).armed, false); const count = h.state.calls.length; h.send("새 작업"); await h.settle(); assert.equal(h.state.calls.length, count);
    }
  } finally { restarted?.close(); h.close(); }
});

test("7-B 수동 GET보다 먼저 lifecycle outcome이 오면 늦은 uncertain·인지 callback은 무효", async () => {
  const h = harness(), gate = deferred(); try {
    const id = await liveUncertain(h), oldAcknowledge = riskButtons(h, id).acknowledge.props.onPress;
    h.state.handle = () => gate.promise; checkRisk(h, id); await h.settle(); h.publishSnapshot(snapshotOf([recovered("outcome", id)]));
    gate.resolve(json(done(id, "uncertain"))); await h.settle(); oldAcknowledge(); h.render();
    assert.equal(h.messages().find(message => message.apiExecution?.reference.requestId === id).apiExecution.response.data.result.kind, "outcome"); assert.equal(riskView(h, id), undefined);
    assert.equal(postedBodies(h).length, 1); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("7-B 같은 요청의 기존 GET 잠금과 수동 확인 경합: 중복 GET·POST 없음", async () => {
  const h = harness(), gate = deferred(); try {
    const id = await liveUncertain(h); h.state.handle = () => gate.promise;
    const existing = h.delegate.queryRequestOnce(recoveryRef(id)); await h.settle(); checkRisk(h, id); await h.settle();
    assert.equal(h.state.calls.filter(call => call.init.method === "GET").length, 2); assert.equal(postedBodies(h).length, 1);
    gate.resolve(json(done(id, "uncertain"))); await existing.completion; await h.settle(); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("7-B 새 초안은 오래된 ack 전송 실패로 덮이지 않으며 Schedule/Mock write 0회", async () => {
  const h = harness(), gate = deferred(), before = h.mock.getState().schedules; try {
    const id = await liveUncertain(h); armRisk(h, id); h.state.handle = () => gate.promise; h.send("전송한 새 입력"); await h.settle();
    h.edit("나중에 작성한 새 초안"); gate.resolve(error7a("ASSISTANT_UNAVAILABLE", 503)); await h.settle();
    assert.equal(h.find("MessageInput").value, "나중에 작성한 새 초안"); assert.equal(riskView(h, id).acknowledged, false);
    assert.strictEqual(h.mock.getState().schedules, before); assert.equal(h.state.mockRuns, 0); assert.ok(h.state.calls.every(call => call.url.includes("/assistant/requests")));
  } finally { h.close(); }
});

test("7-B ack POST timeout·GET 실패는 인지 미완료이며 새 ID 재전송 없이 접수 확인만 허용", async () => {
  const h = harness(); try {
    const id = await liveUncertain(h); armRisk(h, id);
    h.state.handle = (url, init) => init.method === "POST" ? deferred().promise : error7a("ASSISTANT_UNAVAILABLE", 503);
    h.send("새 작업"); await h.settle(); await h.advance(5000);
    assert.equal(riskView(h, id).acknowledged, false); assert.equal(riskView(h, id).pendingRequestId, postedBodies(h).at(-1).requestId);
    const count = h.state.calls.length; h.find("MessageInput").onSend(); await h.settle(); assert.equal(h.state.calls.length, count); assert.equal(h.state.uuidCalls, 2);
  } finally { h.close(); }
});

test("7-B ACK_NOT_APPLICABLE에 새 blocking ID가 있으면 그 ID를 확인하고 원래 인지 의사는 무효화", async () => {
  const h = harness(); try {
    const original = await liveUncertain(h), next = id(702); armRisk(h, original);
    h.state.handle = (url, init) => init.method === "POST" ? error7a("ACKNOWLEDGEMENT_NOT_APPLICABLE", 409, { blockingRequestId: next }) : json(done(next, "uncertain"));
    h.send("새 작업"); await h.settle(); assert.ok(h.state.calls.at(-1).url.endsWith(next)); assert.equal(riskView(h, original).acknowledged, false);
    assert.equal(riskView(h, original).canAcknowledge, false); assert.equal(riskView(h, next).canAcknowledge, true); assert.equal(postedBodies(h).length, 2);
  } finally { h.close(); }
});

for (const change of ["server", "unmount"]) test(`7-B 원래 ID 수동 GET 도중 ${change}: 늦은 결과·인지 상태 갱신 무효화`, async () => {
  const h = harness(), gate = deferred(); try {
    const id = await liveUncertain(h); h.state.handle = () => gate.promise; checkRisk(h, id); await h.settle(); const count = h.state.calls.length;
    if (change === "unmount") h.close();
    else { const other = "development:https://other.example.invalid"; h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid");
      h.publishSnapshot(snapshotOf([], { serverId: other })); }
    gate.resolve(json(done(id, "outcome"))); await h.settle(); assert.equal(h.state.calls.length, count); assert.equal(h.state.lateUpdates, 0); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("7-B 인지 반영 뒤 새 질문의 후속 text에는 ack ID를 재사용하지 않음", async () => {
  const h = harness(); try {
    const riskId = await liveUncertain(h); armRisk(h, riskId); h.state.handle = responseWith({ ...results.need_more_info, questionId: id(350) });
    h.send("새로운 일정 등록"); await h.settle(); assert.equal(riskView(h, riskId).acknowledged, true);
    h.state.handle = responseWith(results.outcome); h.send("오후 3시"); await h.settle(); const body = postedBodies(h).at(-1);
    assert.equal(Object.hasOwn(body, "acknowledgedUncertainRequestId"), false); assert.equal(body.conversationId, id(100)); assert.equal(body.input.questionId, id(350));
  } finally { h.close(); }
});

test("7-B 새 작업 확정 뒤 늦은 uncertain 관측은 메시지뿐 아니라 새 작업 보류 상태도 되돌리지 않음", async () => {
  const h = harness(); try {
    const original = await liveUncertain(h); armRisk(h, original); h.state.handle = responseWith(results.outcome);
    h.send("새 작업"); await h.settle(); const latest = postedBodies(h).at(-1).requestId;
    h.publishSnapshot(snapshotOf([recovered("uncertain", latest)]));
    assert.equal(h.messages().find(message => message.apiExecution?.reference.requestId === latest).apiExecution.response.data.result.kind, "outcome");
    assert.equal(riskView(h, latest), undefined); h.send("명시적 다음 작업"); await h.settle();
    assert.equal(postedBodies(h).length, 3); assert.equal(Object.hasOwn(postedBodies(h).at(-1), "acknowledgedUncertainRequestId"), false);
  } finally { h.close(); }
});

// 로컬 기록 정리는 실제 bubble의 명시적 action으로만 확인한다. 서버 cancel·write 대역은 호출하지 않는다.
async function readyCleanup(h) { await h.settle(); await h.settle(); }
const cleanupData = (...references) => new Map([["assistant.requestRecovery.v1", JSON.stringify({ version: 1,
  entries: references.map(reference => ({ ...reference, firstPostAttemptAt: 1000, lastPostAttemptAt: 1000, acceptConfirmed: false })) })]]);
function cleanupButton(h, requestId, action) {
  const view = h.renderConversation(), control = h.find("ConversationList").recoveryControls.find(value => value.reference.requestId === requestId);
  assert.ok(control, "정리 대상 서버·요청이 UI에 있어야 한다");
  const container = nodes([view.rows, view.footer], "View").find(node => node.props.testID ===
    `assistant-recovery-record-${JSON.stringify([control.reference.serverId, requestId.toLowerCase()])}`);
  return nodes(container, "Pressable").find(button => button.props.testID === `assistant-recovery-${action}`);
}
function clickCleanup(h, requestId, action) {
  const button = cleanupButton(h, requestId, action); assert.ok(button && !button.props.disabled, action);
  button.props.onPress(); h.render();
}

for (const kind of ["outcome", "failure"]) test(`7-C ${kind}: 성공 UI에서는 보존·오류 UI에서는 명시적 확인 후 정리`, async () => {
  const h = harness(); h.state.handle = responseWith(results[kind]);
  try {
    h.send("결과 확인"); await readyCleanup(h); const ref = h.messages().at(-1).apiExecution.reference;
    assert.ok(await h.storage.read(ref)); assert.equal(h.state.cleanup, 0); h.renderConversation(); h.render();
    assert.ok(await h.storage.read(ref)); const before = h.state.calls.length;
    if (kind === "outcome") {
      assert.equal(cleanupButton(h, ref.requestId, "result"), undefined);
      assert.equal(h.state.cleanup, 0); assert.ok(await h.storage.read(ref)); return;
    }
    clickCleanup(h, ref.requestId, "result"); await readyCleanup(h);
    assert.equal(await h.storage.read(ref), null); assert.equal(h.state.cleanup, 1); assert.equal(h.state.calls.length, before);
    assert.ok(textOf(h.renderConversation().rows).includes("로컬 복구 기록을 정리했어요"));
    assert.equal(h.messages().at(-1).apiExecution.response.data.result.kind, kind);
  } finally { h.close(); }
});

test("7-C cold start 실패 결과는 원래 사용자 메시지 없이 명시적 확인·정리 가능", async () => {
  const execution = recovered("failure"), h = harness({ data: cleanupData(execution.reference), initialSnapshot: snapshotOf([execution]) });
  try {
    await h.storage.recordResponse(execution.reference, execution.response.data);
    h.publishSnapshot(snapshotOf([execution])); await readyCleanup(h);
    assert.equal(h.messages().filter(message => message.role === "user").length, 0);
    clickCleanup(h, execution.reference.requestId, "result"); await readyCleanup(h);
    assert.equal(await h.storage.read(execution.reference), null); assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("7-C 결과 확인 연타는 같은 ID 정리 1회·완료 후 재확인도 안전", async () => {
  const h = harness(); try {
    h.state.handle = responseWith(results.failure);
    h.send("조회"); await readyCleanup(h); const ref = h.messages().at(-1).apiExecution.reference;
    const press = cleanupButton(h, ref.requestId, "result").props.onPress; press(); press(); await readyCleanup(h);
    assert.equal(h.state.cleanup, 1); assert.equal(await h.storage.read(ref), null);
    press(); await readyCleanup(h); assert.equal(await h.storage.read(ref), null); assert.equal(postedBodies(h).length, 1);
  } finally { h.close(); }
});

test("7-C 응답 UI 게시 실패는 표시 확인·정리 0회", async () => {
  const h = harness(); h.state.throwMessage = true;
  try { h.send("조회"); await readyCleanup(h); assert.equal(h.state.cleanup, 0); assert.equal(h.state.storageCleanupCalls.length, 0);
    assert.equal((await h.storage.readAll()).length, 1); assert.equal(postedBodies(h).length, 1);
  } finally { h.close(); }
});

for (const change of ["server", "mock", "unmount"]) test(`7-C 결과 확인 이전 ${change}: 늦은 사용자 callback 정리 0회`, async () => {
  const h = harness(); try {
    h.state.handle = responseWith(results.failure);
    h.send("조회"); await readyCleanup(h); const ref = h.messages().at(-1).apiExecution.reference;
    const press = cleanupButton(h, ref.requestId, "result").props.onPress;
    if (change === "server") h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid");
    else if (change === "mock") h.switchMode("mock"); else h.close();
    press(); await h.settle(); assert.ok(await h.storage.read(ref)); assert.equal(h.state.cleanup, 0); assert.equal(h.state.lateUpdates, 0);
  } finally { h.close(); }
});

for (const change of ["server", "unmount", "new-result"]) test(`7-C storage 조회 대기 중 ${change}: 이미 클릭한 결과도 삭제 쓰기 차단`, async () => {
  const h = harness(), gate = deferred(); try {
    const requestId = await liveUncertain(h); h.state.handle = () => json(done(requestId, "failure")); checkRisk(h, requestId); await readyCleanup(h);
    h.state.beforeRead = () => gate.promise; clickCleanup(h, requestId, "result"); await h.settle();
    if (change === "server") h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid");
    else if (change === "unmount") h.close();
    else h.publishSnapshot(snapshotOf([recovered("outcome", requestId)]));
    gate.resolve(); h.state.beforeRead = null; await readyCleanup(h);
    assert.ok(await h.storage.read(recoveryRef(requestId))); assert.equal(h.state.lateUpdates, 0); assert.equal(postedBodies(h).length, 1);
  } finally { gate.resolve(); h.state.beforeRead = null; h.close(); }
});

for (const failure of ["read", "write"]) test(`7-C ${failure} 정리 실패를 UI에 노출·재POST 없이 기록 보존`, async () => {
  const h = harness(); try {
    h.state.handle = responseWith(results.failure);
    h.send("조회"); await readyCleanup(h); const ref = h.messages().at(-1).apiExecution.reference;
    if (failure === "read") h.state.failRead = true; else h.state.failStorage = true;
    clickCleanup(h, ref.requestId, "result"); await readyCleanup(h);
    assert.ok(textOf(h.renderConversation().rows).includes("정리하지 못했어요"));
    h.state.failRead = false; h.state.failStorage = false; assert.ok(await h.storage.read(ref)); assert.equal(postedBodies(h).length, 1);
  } finally { h.state.failRead = false; h.close(); }
});

for (const kind of ["need_more_info", "candidate_selection", "confirmation"]) test(`7-C 활성 ${kind} 보존·후속 POST 2xx 뒤 이전 질문만 정리`, async () => {
  const h = harness(); try {
    h.state.handle = responseWith(results[kind]); h.send("질문 요청"); await readyCleanup(h); const old = h.messages().at(-1);
    assert.ok(await h.storage.read(old.apiExecution.reference)); assert.equal(cleanupButton(h, old.apiExecution.reference.requestId, "result"), undefined);
    h.state.handle = responseWith(results.outcome);
    if (kind === "need_more_info") h.send("오후 3시");
    else if (kind === "candidate_selection") selectApi(h, old.id, "opaque/1"); else confirmApi(h, old.id, true);
    await readyCleanup(h); assert.equal(await h.storage.read(old.apiExecution.reference), null);
    const latest = postMessage(h).apiExecution.reference; assert.ok(await h.storage.read(latest));
    assert.equal(h.state.cleanup, 0); assert.equal(h.state.storageCleanupCalls.length, 1);
    assert.equal(h.state.storageCleanupCalls[0][2].type, "next-input-accepted"); assert.equal(postedBodies(h).length, 2);
  } finally { h.close(); }
});

for (const kind of ["need_more_info", "candidate_selection", "confirmation"]) test(`7-C ${kind} 후속 접수 미확인·GET 실패에서는 이전 질문 보존`, async () => {
  const h = harness(); try {
    h.state.handle = responseWith(results[kind]); h.send("질문 요청"); await readyCleanup(h); const old = h.messages().at(-1);
    h.state.handle = (url, init) => init.method === "POST" ? Promise.reject(Error("응답 유실")) : error7a("ASSISTANT_UNAVAILABLE", 503);
    if (kind === "need_more_info") h.send("답변"); else if (kind === "candidate_selection") selectApi(h, old.id, "opaque/1"); else confirmApi(h, old.id, false);
    await readyCleanup(h); assert.ok(await h.storage.read(old.apiExecution.reference)); assert.equal(h.state.storageCleanupCalls.length, 0);
    assert.equal((await h.storage.readAll()).length, 2); assert.equal(postedBodies(h).length, 2);
  } finally { h.close(); }
});

for (const kind of ["outcome", "failure"]) test(`7-C uncertain → ${kind}: 성공 기록 보존·실패 결과는 명시적 확인 뒤 정리`, async () => {
  const h = harness(); try {
    const requestId = await liveUncertain(h); await readyCleanup(h); assert.equal(cleanupButton(h, requestId, "result"), undefined);
    h.state.handle = () => json(done(requestId, kind)); checkRisk(h, requestId); await readyCleanup(h);
    assert.ok(await h.storage.read(recoveryRef(requestId)));
    if (kind === "outcome") {
      assert.equal(cleanupButton(h, requestId, "result"), undefined); assert.equal(h.state.cleanup, 0); return;
    }
    clickCleanup(h, requestId, "result"); await readyCleanup(h);
    assert.equal(await h.storage.read(recoveryRef(requestId)), null); assert.equal(postedBodies(h).length, 1);
  } finally { h.close(); }
});

test("7-C 위험 인지 버튼은 보존·새 독립 text POST 2xx 확인 뒤 해당 uncertain만 정리", async () => {
  const h = harness(); try {
    const requestId = await liveUncertain(h); armRisk(h, requestId); await readyCleanup(h);
    assert.ok(await h.storage.read(recoveryRef(requestId))); assert.equal(h.state.storageCleanupCalls.length, 0);
    const other = recoveryRef(id(799)); await h.storage.saveBeforePost(other, 1000);
    h.state.handle = responseWith(results.outcome); h.send("새 독립 작업"); await readyCleanup(h);
    assert.equal(await h.storage.read(recoveryRef(requestId)), null); assert.ok(await h.storage.read(other)); assert.ok(await h.storage.read(postMessage(h).apiExecution.reference));
    assert.equal(riskView(h, requestId).acknowledged, true); assert.equal(postedBodies(h).length, 2);
  } finally { h.close(); }
});

for (const failure of ["reject", "network", "storage"]) test(`7-C 위험 인지 새 작업 ${failure}: uncertain 기록 유지`, async () => {
  const h = harness(); try {
    const requestId = await liveUncertain(h); armRisk(h, requestId);
    if (failure === "storage") h.state.failStorage = true;
    h.state.handle = failure === "reject" ? () => error7a("ASSISTANT_UNAVAILABLE", 503)
      : (url, init) => init.method === "POST" ? Promise.reject(Error("응답 유실")) : error7a("ASSISTANT_UNAVAILABLE", 503);
    h.send("새 작업"); await readyCleanup(h); h.state.failStorage = false;
    assert.ok(await h.storage.read(recoveryRef(requestId))); assert.equal(h.state.storageCleanupCalls.length, 0); assert.equal(riskView(h, requestId).acknowledged, false);
  } finally { h.close(); }
});

for (const [method, httpStatus] of [["GET", 410], ["POST", 409]]) test(`7-C ${method} ${httpStatus} REQUEST_EXPIRED 안내 확인 뒤 정리·과거 실행 판정 없음`, async () => {
  const execution = recoveredError("http", httpStatus, "REQUEST_EXPIRED");
  const error = execution.recoveryResult.getResult.error; error.operation = method.toLowerCase();
  if (method === "POST") { execution.recoveryResult.postResult = execution.recoveryResult.getResult; delete execution.recoveryResult.getResult; }
  const h = harness({ data: cleanupData(execution.reference), initialSnapshot: snapshotOf([execution]) });
  try {
    h.publishSnapshot(snapshotOf([execution])); await readyCleanup(h);
    assert.ok(await h.storage.read(execution.reference)); assert.ok(textOf(h.renderConversation().rows).includes("성공·실패는 알 수 없어요"));
    clickCleanup(h, execution.reference.requestId, "expiry"); await readyCleanup(h);
    assert.equal(await h.storage.read(execution.reference), null); assert.equal(h.state.calls.length, 0); assert.equal(h.messages()[0].apiExecution.kind, "needs-attention");
  } finally { h.close(); }
});

for (const [kind, httpStatus, code] of [["http", 404, "ASSISTANT_REQUEST_NOT_FOUND"], ["http", 404, "ROUTE_NOT_FOUND"],
  ["http", 503, "ASSISTANT_UNAVAILABLE"], ["timeout"], ["network"], ["response"], ["http", 409, "REQUEST_EXPIRED"]]) test(`7-C 자동 정리 금지 ${code ?? kind}/${httpStatus ?? "없음"}: 원래 기록 보존`, async () => {
  const execution = recoveredError(kind, httpStatus, code), h = harness({ data: cleanupData(execution.reference), initialSnapshot: snapshotOf([execution]) });
  try {
    h.publishSnapshot(snapshotOf([execution])); await readyCleanup(h);
    assert.equal(cleanupButton(h, execution.reference.requestId, "expiry"), undefined); assert.equal(cleanupButton(h, execution.reference.requestId, "result"), undefined);
    assert.equal(h.state.storageCleanupCalls.length, 0); assert.ok(await h.storage.read(execution.reference)); assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

for (const value of ["accepted", "processing"]) test(`7-C ${value}·120초 경과만으로 metadata 정리 없음`, async () => {
  const h = harness(); h.state.handle = (url, init) => init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202) : json(status(url.split("/").pop(), value));
  try {
    h.send("느린 작업"); await h.settle(); await h.advance(120000); await readyCleanup(h);
    const ref = postMessage(h).apiExecution.reference; assert.ok(await h.storage.read(ref)); assert.equal(h.state.storageCleanupCalls.length, 0);
    assert.equal(cleanupButton(h, ref.requestId, "result"), undefined); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const value of ["unconfirmed", "accepted", "processing", "need_more_info", "uncertain", "foreign-server"]) test(`7-C 수동 ${value}: 두 단계 확인·대상 하나만 로컬 정리·서버 상태 유지`, async () => {
  const ref = recoveryRef(id(760), value === "foreign-server" ? "development:https://other.example.invalid" : serverId), other = recoveryRef(id(761));
  const h = harness({ data: cleanupData(ref, other) });
  try {
    if (["accepted", "processing"].includes(value)) await h.storage.recordResponse(ref, status(ref.requestId, value));
    else if (["need_more_info", "uncertain"].includes(value)) await h.storage.recordResponse(ref, done(ref.requestId, value));
    h.publishSnapshot(snapshotOf([])); h.render(); await readyCleanup(h);
    assert.equal(cleanupButton(h, ref.requestId, "confirm-manual"), undefined);
    clickCleanup(h, ref.requestId, "manual"); await readyCleanup(h); assert.ok(await h.storage.read(ref));
    const warning = textOf(h.renderConversation().footer); assert.ok(warning.includes(ref.serverId.replace(/^development:/, ""))); assert.ok(warning.includes(ref.requestId));
    assert.ok(warning.includes("보류 해제가 아니")); assert.equal(h.state.manualCleanupCalls.length, 0);
    const press = cleanupButton(h, ref.requestId, "confirm-manual").props.onPress; press(); press(); await readyCleanup(h);
    assert.equal(await h.storage.read(ref), null); assert.ok(await h.storage.read(other)); assert.equal(h.state.manualCleanupCalls.length, 1);
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.uuidCalls, 0); assert.equal(h.state.mockRuns, 0);
  } finally { h.close(); }
});

test("7-C 수동 정리 취소는 기록 유지·확인되지 않은 직접 confirm 호출 차단", async () => {
  const h = harness(); try {
    h.state.handle = responseWith(results.failure);
    h.send("조회"); await readyCleanup(h); const ref = postMessage(h).apiExecution.reference;
    const props = h.find("ConversationList"), control = props.recoveryControls[0]; props.onRecoveryAction(control, "confirm-manual"); await readyCleanup(h);
    assert.ok(await h.storage.read(ref)); assert.equal(h.state.manualCleanupCalls.length, 0);
    clickCleanup(h, ref.requestId, "manual"); clickCleanup(h, ref.requestId, "keep"); await readyCleanup(h);
    assert.ok(await h.storage.read(ref)); assert.equal(h.state.manualCleanupCalls.length, 0);
  } finally { h.close(); }
});

test("7-C uncertain 수동 정리는 위험 인지·새 작업 보류 해제가 아님", async () => {
  const h = harness(); try {
    const requestId = await liveUncertain(h); await readyCleanup(h); clickCleanup(h, requestId, "manual"); clickCleanup(h, requestId, "confirm-manual"); await readyCleanup(h);
    assert.equal(await h.storage.read(recoveryRef(requestId)), null); assert.equal(riskView(h, requestId).acknowledged, false);
    h.send("새 작업"); await h.settle(); assert.equal(postedBodies(h).length, 1); assert.equal(h.state.uuidCalls, 1);
  } finally { h.close(); }
});

for (const change of ["server", "mock", "unmount"]) test(`7-C 수동 확인 대기 중 ${change}: 이전 확인 action은 삭제하지 않음`, async () => {
  const h = harness(); try {
    h.state.handle = responseWith(results.failure);
    h.send("조회"); await readyCleanup(h); const ref = postMessage(h).apiExecution.reference;
    clickCleanup(h, ref.requestId, "manual"); const press = cleanupButton(h, ref.requestId, "confirm-manual").props.onPress;
    if (change === "server") h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid");
    else if (change === "mock") h.switchMode("mock"); else h.close();
    press(); await h.settle(); assert.ok(await h.storage.read(ref)); assert.equal(h.state.manualCleanupCalls.length, 0);
  } finally { h.close(); }
});

test("7-C 현재 UI 결과와 다른 requestId·오래된 결과 token은 정리하지 않음", async () => {
  const h = harness(); try {
    h.send("조회"); await readyCleanup(h); const props = h.find("ConversationList"), control = props.recoveryControls[0];
    props.onRecoveryAction({ ...control, reference: recoveryRef(id(799)) }, "result");
    props.onRecoveryAction({ ...control, executionToken: "과거 결과" }, "result"); await readyCleanup(h);
    assert.ok(await h.storage.read(control.reference)); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const method of ["cleanup", "removeManually"]) test(`7-C 저장소 ${method}: 공유 큐 대기 중 무효화되면 삭제 쓰기 없음`, async () => {
  const h = harness(), gate = deferred(); try {
    const ref = recoveryRef(); await h.storage.saveBeforePost(ref, 1000); await h.storage.recordResponse(ref, done(ref.requestId));
    h.state.beforeRead = () => gate.promise; const read = h.storage.read(ref); await h.settle(); let current = true;
    const pending = method === "cleanup" ? h.storage.cleanup(ref, serverId, { type: "result-displayed" }, { isCurrent: () => current })
      : h.storage.removeManually(ref, { confirmed: true }, { isCurrent: () => current });
    current = false; h.state.beforeRead = null; gate.resolve(); await read; assert.equal(await pending, "retained"); assert.ok(await h.storage.read(ref));
  } finally { gate.resolve(); h.state.beforeRead = null; h.close(); }
});

for (const via of ["get", undefined]) test(`7-C ${via ?? "출처 없음"} 상태는 POST 2xx 정리 증거로 대체하지 않음`, () => {
  const h = harness(); try {
    const build = h.source("src/utils/assistant-recovery-cleanup.ts").assistantAcceptedCleanup;
    const request = { requestId: id(710), conversationId: id(100), input: { type: "text", text: "답", questionId: id(300) } };
    const response = { ...recovered().response, status: 202, data: status(request.requestId) };
    assert.deepEqual(build(request, { phase: "status", via, reference: recoveryRef(request.requestId), response }, { requestId: id(600), conversationId: id(100), questionId: id(300) }), []);
  } finally { h.close(); }
});

for (const type of ["request", "question"]) for (const targetState of ["cancelled", "not_guaranteed", "already_completed", "uncertain", "not_active"]) test(`7-C cancel ${type}/${targetState}: 의미만 구분·자동 GET/정리/write 없음`, async () => {
  const h = harness(); try {
    const input = { target: { type, id: id(750) }, targetState, text: "서버 취소 응답" };
    const output = h.source("src/utils/assistant-recovery-cleanup.ts").interpretAssistantCancelResponse(input);
    assert.equal(output.requestCancelled, type === "request" && targetState === "cancelled");
    assert.equal(output.questionInactive, type === "question" && ["cancelled", "not_active"].includes(targetState));
    assert.equal(output.requiresRequestLookup, ["not_guaranteed", "uncertain"].includes(targetState));
    assert.equal(output.targetAlreadyCompleted, targetState === "already_completed"); assert.deepEqual(output.target, input.target);
    assert.deepEqual(input, { target: { type, id: id(750) }, targetState, text: "서버 취소 응답" });
    await h.settle(); assert.equal(h.state.calls.length, 0); assert.equal(h.state.storageCleanupCalls.length, 0); assert.equal(h.state.manualCleanupCalls.length, 0);
  } finally { h.close(); }
});

test("7-C cancel 응답 검증은 approved:false를 취소 DTO로 받아들이지 않음", () => {
  const h = harness(); try {
    const interpret = h.source("src/utils/assistant-recovery-cleanup.ts").interpretAssistantCancelResponse;
    assert.equal(interpret({ target: { type: "question", id: id(750) }, targetState: "success", text: "잘못된 상태" }), null);
    assert.equal(interpret({ type: "confirmation", questionId: id(300), approved: false }), null); assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("7-C 후속 POST 성공 후 metadata 갱신 실패는 이전 질문을 정리하지 않음", async () => {
  const h = harness(); try {
    h.state.handle = responseWith(results.need_more_info); h.send("질문"); await readyCleanup(h); const ref = postMessage(h).apiExecution.reference;
    h.state.handle = (url, init) => { if (init.method === "POST") { h.state.failStorage = true; return json(status(JSON.parse(init.body).requestId), 202); }
      return json(done(url.split("/").pop())); };
    h.send("답변"); await readyCleanup(h); h.state.failStorage = false;
    assert.ok(await h.storage.read(ref)); assert.equal(h.find("ConversationList").recoveryControls.find(control => control.reference.requestId === ref.requestId).phase, "retained");
    assert.equal(postedBodies(h).length, 2); assert.equal(h.state.mockRuns, 0);
  } finally { h.close(); }
});

test("7-C 응답 유실 뒤 GET 확인만으로 POST 2xx 정리 사실을 꾸미지 않음", async () => {
  const h = harness(); try {
    h.state.handle = responseWith(results.need_more_info); h.send("질문"); await readyCleanup(h); const ref = postMessage(h).apiExecution.reference;
    h.state.handle = (url, init) => init.method === "POST" ? Promise.reject(Error("응답 유실")) : json(done(url.split("/").pop()));
    h.send("답변"); await readyCleanup(h); assert.ok(await h.storage.read(ref)); assert.equal(h.state.storageCleanupCalls.length, 0); assert.equal(postedBodies(h).length, 2);
  } finally { h.close(); }
});

for (const code of ["QUESTION_EXPIRED", "CONVERSATION_EXPIRED"]) test(`7-C 서버 ${code} 409가 확인된 질문만 만료 정리`, async () => {
  const h = harness(); try {
    const message = await liveConfirmation(h), other = recoveryRef(id(799)); await h.storage.saveBeforePost(other, 1000);
    h.state.handle = () => error7a(code, 409); confirmApi(h, message.id, true); await readyCleanup(h);
    assert.equal(await h.storage.read(message.apiExecution.reference), null); assert.ok(await h.storage.read(other));
    assert.ok(await h.storage.read(postMessage(h).apiExecution.reference)); assert.equal(postedBodies(h).length, 2);
  } finally { h.close(); }
});

test("7-C 수동 정리도 storage 읽기 대기 중 화면 해제되면 삭제 쓰기 없음", async () => {
  const h = harness(), gate = deferred(); try {
    h.state.handle = responseWith(results.failure);
    h.send("조회"); await readyCleanup(h); const ref = postMessage(h).apiExecution.reference;
    clickCleanup(h, ref.requestId, "manual"); h.state.beforeRead = () => gate.promise;
    clickCleanup(h, ref.requestId, "confirm-manual"); await h.settle(); h.close(); gate.resolve(); h.state.beforeRead = null; await h.settle();
    assert.ok(await h.storage.read(ref)); assert.equal(h.state.lateUpdates, 0);
  } finally { gate.resolve(); h.state.beforeRead = null; h.close(); }
});

test("7-C 같은 requestId라도 다른 서버의 수동 정리는 선택한 서버 항목 하나만 삭제", async () => {
  const local = recoveryRef(), foreign = recoveryRef(local.requestId, "development:https://other.example.invalid");
  const h = harness({ data: cleanupData(local, foreign) }); try {
    await readyCleanup(h); const props = h.find("ConversationList"), target = props.recoveryControls.find(control => control.reference.serverId === foreign.serverId);
    assert.ok(target); props.onRecoveryAction(target, "manual"); h.render();
    const view = h.renderConversation(); const bubble = nodes(view.footer, "View").find(node => node.props.testID ===
      `assistant-recovery-record-${JSON.stringify([foreign.serverId, foreign.requestId])}`);
    nodes(bubble, "Pressable").find(button => button.props.testID === "assistant-recovery-confirm-manual").props.onPress(); await readyCleanup(h);
    assert.equal(await h.storage.read(foreign), null); assert.ok(await h.storage.read(local)); assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("7-C 삭제 대기 중 서버 왕복 뒤 이전 working UI를 남기지 않고 명시적 확인 가능", async () => {
  const h = harness(), gate = deferred(); try {
    h.state.handle = responseWith(results.failure);
    h.send("조회"); await readyCleanup(h); const ref = postMessage(h).apiExecution.reference;
    h.state.beforeRead = () => gate.promise; clickCleanup(h, ref.requestId, "result"); await h.settle();
    const config = h.source("src/services/api/config.ts"); h.state.config = config.parseDevelopmentServerConfig("https://other.example.invalid"); h.render();
    h.state.beforeRead = null; gate.resolve(); await readyCleanup(h);
    h.state.config = config.parseDevelopmentServerConfig(origin); h.render(); await readyCleanup(h);
    assert.ok(await h.storage.read(ref)); assert.equal(cleanupButton(h, ref.requestId, "result").props.disabled, false);
    clickCleanup(h, ref.requestId, "result"); await readyCleanup(h); assert.equal(await h.storage.read(ref), null);
  } finally { gate.resolve(); h.state.beforeRead = null; h.close(); }
});

test("7-C 서버 왕복은 이전 수동 정리 확인 의사를 복원하지 않음", async () => {
  const h = harness(); try {
    h.state.handle = responseWith(results.failure);
    h.send("조회"); await readyCleanup(h); const ref = postMessage(h).apiExecution.reference;
    clickCleanup(h, ref.requestId, "manual"); const oldConfirm = cleanupButton(h, ref.requestId, "confirm-manual").props.onPress;
    const config = h.source("src/services/api/config.ts"); h.state.config = config.parseDevelopmentServerConfig("https://other.example.invalid"); h.render(); await readyCleanup(h);
    h.state.config = config.parseDevelopmentServerConfig(origin); h.render(); await readyCleanup(h);
    oldConfirm(); await readyCleanup(h); assert.ok(await h.storage.read(ref)); assert.equal(h.state.manualCleanupCalls.length, 0);
    assert.equal(cleanupButton(h, ref.requestId, "confirm-manual"), undefined);
  } finally { h.close(); }
});

// 동기화 UI는 원래 Assistant 결과와 분리한다. 실제 GET 통합 시험 외에는 snapshot·retry만 대체한다.
const writeOutcome8b = (operation = "update") => ({ kind: "outcome", text: "서버의 원문 변경 성공", outcome: "success", operation,
  schedulesChanged: true, affectedScheduleIds: [id(200)] });
const writeExecution8b = (requestId = id(600), server = serverId) => { const value = recovered("outcome", requestId, server); value.response.data.result = writeOutcome8b(); return value; };
const syncEntry8b = (phase, requestId = id(600), server = serverId) => ({ reference: recoveryRef(requestId, server), phase, failedQueries: [], errors: [] });
const syncStatus8b = (h, requestId) => {
  const index = h.messages().findIndex(message => message.apiExecution?.reference.requestId.toLowerCase() === requestId.toLowerCase());
  return nodes(h.renderConversation().rows[index], "View").find(node => node.props.testID === "assistant-schedule-sync-status");
};
const syncRetry8b = (h, requestId) => nodes(syncStatus8b(h, requestId), "Pressable").find(node => node.props.testID === "assistant-schedule-sync-retry");
const syncCalls8b = h => h.state.calls.filter(call => new URL(call.url).pathname === "/api/v1/schedules");
const scheduleDto8b = (extra = {}) => ({ ...summary, createdAt: "2026-11-01T00:00:00Z", ...extra });

test("등록 화면→실제 orchestrator→Schedule 목록·단건 GET→기존 카드 통합", async () => {
  const h = harness({ actualScheduleSync: true, actualScheduleDetails: true }); try {
    h.state.handle = async (url, options) => {
      const route = new URL(url).pathname;
      if (route === "/api/v1/schedules") return json({ items: [] });
      if (route === `/api/v1/schedules/${summary.id}`) return json(scheduleDto8b({ title: "목록 밖 등록 일정", scheduledAt: "2026-12-14T07:00:00Z" }));
      return options.method === "POST" ? json(status(JSON.parse(options.body).requestId), 202)
        : json({ ...done(route.split("/").pop()), result: writeOutcome8b() });
    };
    h.send("고정 등록 요청"); await readyCleanup(h);
    const view = h.renderConversation(); assert.equal(cards(view).length, 1);
    assert.equal(cards(view)[0].props.schedule.title, "목록 밖 등록 일정");
    assert.equal(cards(view)[0].props.schedule.time, "16:00");
    assert.equal(postedBodies(h).length, 1); assert.equal(h.state.mockRuns, 0);
    const scheduleCalls = h.state.calls.filter(call => new URL(call.url).pathname.startsWith("/api/v1/schedules"));
    assert.equal(scheduleCalls.length, 2); assert.ok(scheduleCalls.every(call => call.init.method === "GET"));
  } finally { h.close(); }
});

for (const [operation, completed] of [["create", false], ["update", true], ["update", false]]) test(`서버 ${operation}/${completed} 성공 카드: 등록 상태 숨김·수정 상태 유지`, async () => {
  const h = harness(); try {
    h.state.handle = responseWith({ ...writeOutcome8b(), operation }); h.send("일정 변경"); await readyCleanup(h);
    const reference = h.messages().at(-1).apiExecution.reference;
    const schedule = { id: summary.id, title: "최신 일정 정보", date: "2026-12-14", time: "16:00", category: "재고", completed };
    h.publishSync([{ reference, phase: "synchronized", failedQueries: [], errors: [], detail: { phase: "ready", schedule } }]);
    const view = h.renderConversation(); assert.equal(cards(view).length, 1); assert.deepEqual(cards(view)[0].props.schedule, schedule);
    const card = cards(view)[0]; assert.equal(card.props.showCompleted, operation === "update");
    const cardTree = h.source("src/components/assistant/assistant-schedule-card.tsx").AssistantScheduleCard(card.props);
    const labels = nodes(cardTree, "ThemedText").map(node => node.props.children).filter(text => text === "완료" || text === "미완료");
    assert.deepEqual(labels, operation === "create" ? [] : [completed ? "완료" : "미완료"]);
    assert.ok(textOf(view.rows).includes("최신 일정 정보")); assert.ok(textOf(view.rows).includes(h.messages().at(-1).text));
    assert.equal(h.state.mockRuns, 0); assert.ok(h.state.calls.every(call => call.url.includes("/assistant/")));
  } finally { h.close(); }
});

const uiStyle = value => Object.assign({}, ...[value].flat(Infinity).filter(item => item && typeof item === "object"));

test("채팅 UI 서버 후보는 compact 카드·체크 오버레이로 선택 전후 크기 유지", async () => {
  const h = harness(); try {
    const message = await liveCandidates(h), before = candidateButtons(h, message.id)[1];
    const initial = h.renderConversation(), candidateCard = cards(initial)[1];
    assert.equal(candidateCard.props.compact, true);
    const compact = h.source("src/components/assistant/assistant-schedule-card.tsx").AssistantScheduleCard(candidateCard.props);
    const compactStyle = uiStyle(compact.props.style);
    assert.equal(compactStyle.paddingVertical, 8); assert.equal(compactStyle.gap, 4); assert.equal(compactStyle.paddingRight, 36);
    const originalStyle = uiStyle(before.props.style); assert.equal(originalStyle.paddingHorizontal, 0); assert.equal(originalStyle.paddingVertical, 0);
    assert.equal(nodes(initial.rows, "View").filter(node => node.props.testID === "assistant-candidate-check").length, 0);
    h.state.handle = responseWith(results.confirmation); before.props.onPress(); h.render(); await h.settle();
    const after = candidateButtons(h, message.id)[1], row = h.renderConversation().rows[h.messages().findIndex(item => item.id === message.id)];
    assert.deepEqual({ ...uiStyle(after.props.style), opacity: undefined }, { ...originalStyle, opacity: undefined });
    const check = nodes(row, "View").find(node => node.props.testID === "assistant-candidate-check");
    assert.deepEqual(uiStyle(check.props.style), { position: "absolute", top: 10, right: 12, width: 20, height: 20 });
    assert.equal(check.props.pointerEvents, "none"); assert.ok(!textOf(row).includes("선택됨"));
    assert.equal(postedBodies(h).length, 2); assert.equal(postedBodies(h)[1].input.candidateId, message.apiExecution.response.data.result.candidates[1].candidateId);
  } finally { h.close(); }
});

test("채팅 UI Mock 후보도 선택 체크를 오버레이로 표시하고 기존 선택·확인 유지", async () => {
  const h = harness({ initialMode: "mock" }); try {
    h.send("재고 일정 삭제해 줘"); await h.advance(700); const message = h.messages().at(-1);
    const before = candidateButtons(h, message.id)[0], geometry = uiStyle(before.props.style);
    before.props.onPress(); h.render();
    const row = h.renderConversation().rows[h.messages().findIndex(item => item.id === message.id)];
    const after = interactionButtons(row)[0];
    assert.deepEqual({ ...uiStyle(after.props.style), opacity: undefined }, { ...geometry, opacity: undefined });
    assert.equal(after.props.accessibilityState.selected, true);
    assert.equal(nodes(row, "View").filter(node => node.props.testID === "assistant-candidate-check").length, 1);
    assert.deepEqual(interactionButtons(h.renderConversation().rows.at(-1)).map(textOf), ["아니요", "예"]);
    assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

for (const mode of ["server", "mock"]) test(`채팅 UI ${mode} 확인 카드는 90% 너비·동일한 44dp 버튼·12dp 간격`, async () => {
  const h = harness({ initialMode: mode }); try {
    if (mode === "server") { h.state.handle = responseWith(results.confirmation); h.send("확인 UI"); await h.settle(); }
    else { h.send("작업장 안전 점검 삭제해 줘"); await h.advance(700); }
    const row = h.renderConversation().rows.at(-1), bubble = uiStyle(row.props.style), buttons = interactionButtons(row);
    assert.equal(bubble.width, "90%"); assert.equal(bubble.maxWidth, "90%"); assert.equal(bubble.gap, 12);
    assert.equal(bubble.paddingHorizontal, 16); assert.equal(bubble.paddingVertical, 16);
    assert.deepEqual(buttons.map(textOf), ["아니요", "예"]);
    for (const button of buttons) { const style = uiStyle(button.props.style); assert.equal(style.height, 44); assert.equal(style.minHeight, 44); assert.equal(style.flex, 1); assert.equal(style.flexBasis, 0); }
    const actions = nodes(row, "View").find(node => uiStyle(node.props.style).flexDirection === "row");
    assert.equal(uiStyle(actions.props.style).gap, 12);
  } finally { h.close(); }
});

for (const mode of ["server", "mock"]) for (const multiline of [false, true]) test(`채팅 UI ${mode} ${multiline ? "여러 줄" : "한 줄"} 결과는 대칭 padding·고정 높이·빈 상태 컨테이너 없음`, () => {
  const h = harness({ initialMode: mode }); try {
    const text = multiline ? "일정을 삭제했어요.\n다른 일정은 유지돼요." : "일정을 삭제했어요.";
    const execution = writeExecution8b(); execution.response.data.result = { ...writeOutcome8b(), operation: "delete", text };
    h.publishSync([syncEntry8b("synchronized", execution.reference.requestId)]);
    const view = h.renderConversation([{ id: "ui-text", role: "assistant", text, ...(mode === "server" ? { apiExecution: execution } : {}) }]);
    const row = view.rows[0], bubble = uiStyle(row.props.style), body = nodes(row, "Text")[0];
    assert.equal(bubble.paddingVertical, bubble.paddingHorizontal); assert.equal(bubble.justifyContent, "center");
    assert.equal(bubble.height, undefined); assert.equal(bubble.minHeight, undefined);
    assert.equal(body.props.children, text); assert.equal(body.props.numberOfLines, undefined);
    assert.equal(uiStyle(body.props.style).fontSize, 16); assert.equal(uiStyle(body.props.style).lineHeight, 24);
    assert.equal(nodes(row, "View").filter(node => node.props.testID === "assistant-schedule-sync-status").length, 0);
    assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("채팅 UI compact 옵션은 일반 일정 요약 카드의 기존 디자인을 변경하지 않음", () => {
  const h = harness(); try {
    const card = h.source("src/components/assistant/assistant-schedule-card.tsx").AssistantScheduleCard({ schedule: { title: "기존 일정", date: "2026-11-13", time: "12:00", category: "재고" } });
    const style = uiStyle(card.props.style); assert.equal(style.padding, 12); assert.equal(style.gap, 8); assert.equal(style.borderRadius, 16);
    assert.equal(style.paddingRight, undefined);
  } finally { h.close(); }
});

test("요약 카드 실패는 원문 성공을 유지하고 retry 연타는 GET 동기화 경계 한 번만 호출", async () => {
  const h = harness(); try {
    h.state.handle = responseWith(writeOutcome8b()); h.send("등록"); await readyCleanup(h);
    const reference = h.messages().at(-1).apiExecution.reference;
    h.publishSync([{ reference, phase: "synchronized", failedQueries: [], errors: [], detail: { phase: "error" } }]);
    const row = h.renderConversation().rows.at(-1); assert.ok(textOf(row).includes("일정 요약을 불러오지 못했어요"));
    const retry = nodes(row, "Pressable").find(button => textOf(button).includes("일정 요약 다시 불러오기"));
    const before = postedBodies(h).length; retry.props.onPress(); retry.props.onPress(); await h.settle();
    assert.equal(h.state.syncRetries.length, 1); assert.equal(postedBodies(h).length, before);
    assert.equal(h.messages().at(-1).apiExecution.response.data.result.outcome, "success");
  } finally { h.close(); }
});

// 실제 native ref와 Text 레이아웃 이벤트만 대체한다. render만으로 노출을 만들어내지 않는다.
function nativeResultExposure(h, position = () => ({ x: 20, y: 120, width: 300, height: 40 })) {
  const view = h.renderConversation(), messages = h.find("ConversationList").messages, texts = [];
  view.list.props.ref.current = { getNativeScrollRef: () => ({ measureInWindow: callback => callback(0, 100, 400, 600) }) };
  for (let index = 0; index < messages.length; index++) {
    const text = nodes(view.rows[index], "Text").find(node => typeof node.props.ref === "function");
    if (!text) continue;
    text.props.ref({ measureInWindow: callback => {
      const rect = position(messages[index]); callback(rect.x, rect.y, rect.width, rect.height);
    } });
    texts.push(text);
  }
  return { view, texts,
    layout() { for (const text of texts) text.props.onTextLayout({ nativeEvent: { lines: [{ width: 300, height: 40 }] } }); },
    scroll() { view.list.props.onScroll({ nativeEvent: { contentSize: { height: 2000 }, layoutMeasurement: { height: 600 }, contentOffset: { y: 0 } } }); },
  };
}

for (const kind of ["outcome", "failure"]) test(`실제 본문 전체 노출 ${kind}: native 레이아웃+1초 후 자동 정리, 현재 메시지는 유지`, async () => {
  const h = harness(); try {
    h.state.handle = responseWith(results[kind]); h.send("결과 표시"); await readyCleanup(h);
    const message = h.messages().at(-1), ref = message.apiExecution.reference, calls = h.state.calls.length;
    const exposure = nativeResultExposure(h); await h.advance(2000);
    assert.ok(await h.storage.read(ref)); assert.equal(h.state.cleanup, 0);
    exposure.layout(); await h.settle(); await h.advance(999); assert.ok(await h.storage.read(ref));
    await h.advance(1); await readyCleanup(h);
    assert.equal(await h.storage.read(ref), null); assert.equal(h.state.cleanup, 1);
    assert.strictEqual(h.messages().at(-1), message); assert.equal(h.state.calls.length, calls);
    exposure.layout(); exposure.scroll(); await h.advance(2000); assert.equal(h.state.cleanup, 1);
  } finally { h.close(); }
});

test("정상 등록 요청 5회의 확인된 성공 기록은 다음 앱 실행에 반복 복구하지 않음", async () => {
  const h = harness(); try {
    for (let index = 0; index < 5; index++) {
      h.state.handle = responseWith({ ...writeOutcome8b(), affectedScheduleIds: [id(870 + index)] });
      h.send(`대역 등록 ${index}`); await readyCleanup(h); const latest = h.messages().at(-1);
      const exposure = nativeResultExposure(h, message => ({ x: 20, y: message.id === latest.id ? 120 : 900, width: 300, height: 40 }));
      exposure.layout(); await h.settle(); await h.advance(1000); await readyCleanup(h);
      assert.equal(await h.storage.read(latest.apiExecution.reference), null);
    }
    assert.equal(postedBodies(h).length, 5); assert.equal(h.messages().length, 10); assert.equal(h.state.mockRuns, 0);
    const restarted = harness({ data: h.data, actualLifecycle: true }); const detach = restarted.attachLifecycle();
    try { await readyCleanup(restarted); assert.equal(restarted.messages().length, 0); assert.equal(restarted.state.calls.length, 0); }
    finally { detach(); restarted.close(); }
  } finally { h.close(); }
});

test("정상 완료 5건을 각각 실제 확인하면 다음 앱 시작에 이전 결과 5건을 재조회·재표시하지 않음", async () => {
  const executions = Array.from({ length: 5 }, (_, index) => recovered("outcome", id(850 + index)));
  const h = harness({ data: cleanupData(...executions.map(item => item.reference)), initialSnapshot: snapshotOf(executions) });
  let visibleId = executions[0].reference.requestId;
  try {
    for (const execution of executions) await h.storage.recordResponse(execution.reference, execution.response.data);
    h.publishSnapshot(snapshotOf(executions)); await readyCleanup(h);
    const exposure = nativeResultExposure(h, message => ({ x: 20,
      y: message.apiExecution.reference.requestId === visibleId ? 120 : 900, width: 300, height: 40 }));
    exposure.layout(); await h.settle();
    for (const execution of executions) {
      visibleId = execution.reference.requestId; exposure.scroll(); await h.settle(); await h.advance(1000); await readyCleanup(h);
      assert.equal(await h.storage.read(execution.reference), null);
    }
    assert.equal(h.messages().length, 5); assert.equal(h.state.cleanup, 5); assert.equal(h.state.calls.length, 0);
    const restarted = harness({ data: h.data, actualLifecycle: true }); const detach = restarted.attachLifecycle();
    try { await readyCleanup(restarted); assert.equal(restarted.messages().length, 0); assert.equal(restarted.state.calls.length, 0); }
    finally { detach(); restarted.close(); }
  } finally { h.close(); }
});

test("재실행의 미확인 요청은 원래 ID GET-only 복구 후 실제 노출 시 정리", async () => {
  const ref = recoveryRef(id(860)), h = harness({ data: cleanupData(ref), actualLifecycle: true });
  const detach = h.attachLifecycle();
  try {
    await readyCleanup(h); assert.equal(postedBodies(h).length, 0);
    assert.ok(h.state.calls.some(call => call.url.endsWith(`/assistant/requests/${ref.requestId}`) && call.init.method === "GET"));
    assert.equal(h.messages().filter(message => message.role === "user").length, 0); assert.ok(await h.storage.read(ref));
    nativeResultExposure(h).layout(); await h.settle(); await h.advance(1000); await readyCleanup(h);
    assert.equal(await h.storage.read(ref), null); assert.equal(postedBodies(h).length, 0); assert.equal(h.messages().length, 1);
  } finally { detach(); h.close(); }
});

for (const state of ["partial", "offscreen", "unknown", "background", "blur", "unmount", "server", "mock"]) test(`노출 확인 ${state}: 자동 정리 없이 원래 기록 보존`, async () => {
  const h = harness(); try {
    h.send("노출 미확인"); await readyCleanup(h); const ref = h.messages().at(-1).apiExecution.reference;
    const exposure = nativeResultExposure(h, () => ({ x: 20, y: state === "partial" ? 690 : state === "offscreen" ? 900 : 120,
      width: state === "unknown" ? 0 : 300, height: 40 }));
    exposure.layout(); await h.settle(); await h.advance(500);
    if (state === "background") h.app("background");
    if (state === "blur") h.blurResults();
    if (state === "unmount") h.close();
    if (state === "server") { h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid"); h.render(); }
    if (state === "mock") h.switchMode("mock");
    await h.advance(1000); assert.ok(await h.storage.read(ref)); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("스크롤은 노출 대기를 초기화하고 현재 위치를 다시 측정", async () => {
  const h = harness(); let visible = true;
  try {
    h.send("스크롤 확인"); await readyCleanup(h); const ref = h.messages().at(-1).apiExecution.reference;
    const exposure = nativeResultExposure(h, () => ({ x: 20, y: visible ? 120 : 900, width: 300, height: 40 }));
    exposure.layout(); await h.settle(); await h.advance(800); visible = false; exposure.scroll(); await h.advance(1500);
    assert.ok(await h.storage.read(ref)); visible = true; exposure.scroll(); await h.settle(); await h.advance(999); assert.ok(await h.storage.read(ref));
    await h.advance(1); assert.equal(await h.storage.read(ref), null);
  } finally { h.close(); }
});

test("네이티브 측정을 지원하지 않으면 추측하지 않고 복구 기록 보존", async () => {
  for (const missing of ["viewport", "text"]) {
    const h = harness(); try {
      h.send("측정 지원 확인"); await readyCleanup(h); const ref = h.messages().at(-1).apiExecution.reference;
      const exposure = nativeResultExposure(h);
      if (missing === "viewport") exposure.view.list.props.ref.current = { getNativeScrollRef: () => ({}) };
      else for (const text of exposure.texts) text.props.ref({});
      exposure.layout(); await h.advance(3000); assert.ok(await h.storage.read(ref)); assert.equal(h.state.cleanup, 0);
    } finally { h.close(); }
  }
});

test("자동 정리 storage 대기 중 화면 이탈은 삭제 쓰기 금지", async () => {
  const h = harness(), gate = deferred(); try {
    h.send("정리 대기"); await readyCleanup(h); const ref = h.messages().at(-1).apiExecution.reference;
    nativeResultExposure(h).layout(); await h.settle(); h.state.beforeRead = () => gate.promise;
    await h.advance(1000); h.blurResults(); gate.resolve(); h.state.beforeRead = null; await readyCleanup(h);
    assert.ok(await h.storage.read(ref)); assert.equal(h.state.calls.length, 2);
  } finally { gate.resolve(); h.state.beforeRead = null; h.close(); }
});

for (const kind of ["need_more_info", "candidate_selection", "confirmation", "uncertain"]) test(`노출돼도 ${kind} 기록은 자동 정리하지 않음`, async () => {
  const execution = recovered(kind), h = harness({ data: cleanupData(execution.reference), initialSnapshot: snapshotOf([execution]) });
  try {
    await h.storage.recordResponse(execution.reference, execution.response.data); await readyCleanup(h);
    const exposure = nativeResultExposure(h); exposure.layout(); await h.advance(3000);
    assert.equal(exposure.texts.length, 0); assert.ok(await h.storage.read(execution.reference)); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

for (const state of ["accepted", "processing", "404", "network", "timeout", "post-unconfirmed"]) test(`결과 본문 노출 대상이 아닌 ${state} 기록 보존`, async () => {
  const execution = ["accepted", "processing"].includes(state) ? observedRecovery(state)
    : recoveredError(state === "404" ? "http" : state === "timeout" ? "timeout" : "network", state === "404" ? 404 : undefined,
      state === "404" ? "ASSISTANT_REQUEST_NOT_FOUND" : undefined);
  if (state === "post-unconfirmed") {
    execution.recoveryResult.postResult = execution.recoveryResult.getResult;
    execution.recoveryResult.postResult.error.operation = "post";
    execution.recoveryResult.postResult.error.requestState = "unconfirmed";
    delete execution.recoveryResult.getResult;
  }
  const h = harness({ data: cleanupData(execution.reference), initialSnapshot: snapshotOf([execution]) });
  try {
    if (execution.kind === "observed") await h.storage.recordResponse(execution.reference, execution.response.data);
    await readyCleanup(h); const exposure = nativeResultExposure(h); exposure.layout(); await h.advance(3000);
    assert.equal(exposure.texts.length, 0); assert.ok(await h.storage.read(execution.reference));
    assert.equal(h.state.cleanup, 0); assert.equal(postedBodies(h).length, 0);
  } finally { h.close(); }
});

test("자동 정리 저장 실패는 성공 결과·현재 메시지·복구 기록을 보존하고 오류 표시", async () => {
  const h = harness(); try {
    h.send("대역 조회"); await readyCleanup(h); const message = h.messages().at(-1);
    nativeResultExposure(h).layout(); await h.settle(); h.state.failStorage = true;
    await h.advance(1000); h.state.failStorage = false; await readyCleanup(h);
    assert.ok(await h.storage.read(message.apiExecution.reference)); assert.strictEqual(h.messages().at(-1), message);
    assert.ok(textOf(h.renderConversation().rows).includes("복구 기록을 정리하지 못했어요")); assert.equal(postedBodies(h).length, 1);
  } finally { h.state.failStorage = false; h.close(); }
});

test("동일 결과의 HTTP 추적 ID 변경은 레이아웃을 보존하고 새 위치·대기 확인 후 정리", async () => {
  const h = harness(), proofs = [];
  try {
    const visibility = h.source("src/utils/assistant-result-visibility.ts").createAssistantResultVisibility({
      measure: async () => true, isActive: () => true,
      onDisplayed: async proof => { proofs.push(proof); return proof.isCurrent(); },
    });
    const first = { messageId: "message", reference: recoveryRef(), executionToken: "trace-first", contentToken: "same-result" };
    visibility.update([first]); visibility.laidOut(first); await h.settle(); await h.advance(500);
    const latest = { ...first, executionToken: "trace-latest" }; visibility.update([latest]); visibility.refresh();
    await h.settle(); await h.advance(999); assert.equal(proofs.length, 0);
    await h.advance(1); assert.equal(proofs.length, 1); assert.equal(proofs[0].executionToken, "trace-latest");
    visibility.invalidate(); assert.equal(proofs[0].isCurrent(), false);
  } finally { h.close(); }
});

test("uncertain이 같은 본문으로 확정돼도 새 native 텍스트 레이아웃을 확인한 뒤 정리", async () => {
  const h = harness(); try {
    h.state.handle = responseWith({ ...results.uncertain, text: "같은 서버 본문" }); h.send("대역 결과 확인"); await readyCleanup(h);
    const requestId = h.messages().at(-1).apiExecution.reference.requestId;
    const before = nodes(h.renderConversation().rows, "Text").find(node => node.props.children === "같은 서버 본문").key;
    h.state.handle = () => json({ ...done(requestId), result: { ...results.outcome, text: "같은 서버 본문" } });
    checkRisk(h, requestId); await readyCleanup(h);
    const exposure = nativeResultExposure(h);
    assert.notEqual(exposure.texts[0].key, before); await h.advance(2000); assert.ok(await h.storage.read(recoveryRef(requestId)));
    exposure.layout(); await h.settle(); await h.advance(1000); assert.equal(await h.storage.read(recoveryRef(requestId)), null);
    assert.equal(postedBodies(h).length, 1);
  } finally { h.close(); }
});

test("복구 정리 실패 상태는 정상 outcome을 바꾸지 않고 필요한 오류 안내만 표시", async () => {
  const h = harness(); try {
    h.send("조회"); await readyCleanup(h);
    const props = h.find("ConversationList");
    props.recoveryControls = props.recoveryControls.map(control => ({ ...control, phase: "failed" }));
    const view = h.renderConversation();
    assert.ok(textOf(view.rows).includes("복구 기록을 정리하지 못했어요"));
    assert.ok(!textOf(view.rows).includes("요청 정보·복구 관리"));
    assert.equal(h.messages().at(-1).apiExecution.response.data.result.outcome, "success");
    assert.equal(h.state.cleanup, 0); assert.equal(postedBodies(h).length, 1);
  } finally { h.close(); }
});

test("일반 성공은 원문·카드만 표시하며 관리 버튼·긴 누름 없이 복구 기록을 보존", async () => {
  const h = harness(); try {
    h.send("조회"); await readyCleanup(h); const reference = h.messages().at(-1).apiExecution.reference;
    const view = h.renderConversation(); assert.ok(!textOf(view.rows).includes(reference.serverId));
    assert.ok(!textOf(view.rows).includes(reference.requestId));
    assert.equal(nodes(view.rows, "Pressable").length, 0);
    assert.ok(nodes(view.rows, "Text").every(node => !node.props.onLongPress));
    assert.ok(!textOf(view.rows).includes("요청 정보·복구 관리"));
    assert.equal(h.state.cleanup, 0); assert.ok(await h.storage.read(reference));
  } finally { h.close(); }
});
function routeSync8b(h, read, result = writeOutcome8b()) {
  h.state.handle = (url, init) => new URL(url).pathname === "/api/v1/schedules" ? read(url, init)
    : init.method === "POST" ? json(status(JSON.parse(init.body).requestId), 202) : json({ ...done(url.split("/").pop()), result });
}
async function liveSync8b(h, read) {
  routeSync8b(h, read); h.send("일정 변경 요청"); await h.settle(); return postMessage(h).apiExecution;
}

for (const [phase, text] of [["refreshing", ""], ["synchronized", ""], ["refresh-error", "목록 갱신에 실패"], ["interrupted", "목록 확인이 중단"]]) test(`8-B 초기 ${phase} snapshot: 정상 동기화 문구는 숨기고 실패 안내 유지`, async () => {
  const execution = writeExecution8b(), h = harness({ initialSnapshot: snapshotOf([execution]), initialSyncSnapshot: [syncEntry8b(phase)] });
  try {
    if (text) assert.ok(textOf(syncStatus8b(h, id(600))).includes(text));
    else assert.equal(textOf(syncStatus8b(h, id(600))).trim(), "");
    assert.equal(h.messages()[0].text, execution.response.data.result.text);
    assert.deepEqual(h.messages()[0].apiExecution, execution); assert.deepEqual(h.messages()[0].apiExecution.response.data.result.affectedScheduleIds, [id(200)]);
    assert.equal(Boolean(syncRetry8b(h, id(600))), ["refresh-error", "interrupted"].includes(phase));
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); }
});

test("8-B 구독 경계 변경을 최신 snapshot 재조회로 소비·중복 메시지/자동 retry 없음", async () => {
  const h = harness({ initialSnapshot: snapshotOf([writeExecution8b()]), initialSyncSnapshot: [syncEntry8b("refresh-error")],
    syncSnapshotAtSubscribe: [syncEntry8b("synchronized")] });
  try {
    assert.equal(textOf(syncStatus8b(h, id(600))).trim(), ""); const message = h.messages()[0];
    for (let n = 0; n < 3; n++) h.publishSync([syncEntry8b("synchronized")]);
    assert.strictEqual(h.messages()[0], message); assert.equal(h.messages().length, 1); assert.equal(h.state.syncRetries.length, 0); assert.equal(h.state.calls.length, 0);
    assert.equal(h.state.syncListeners.size, 1);
  } finally { h.close(); }
});

test("8-B 여러 성공 요청은 서버/requestId별 상태를 각각 표시하고 잘못된 ID retry 차단", async () => {
  const h = harness({ initialSnapshot: snapshotOf([writeExecution8b(id(600)), writeExecution8b(id(601))]),
    initialSyncSnapshot: [syncEntry8b("refresh-error", id(600)), syncEntry8b("synchronized", id(601))] });
  try {
    assert.ok(textOf(syncStatus8b(h, id(600))).includes("실패")); assert.equal(textOf(syncStatus8b(h, id(601))).trim(), "");
    h.find("ConversationList").onScheduleSyncRetry(recoveryRef(id(601))); h.find("ConversationList").onScheduleSyncRetry(recoveryRef(id(799))); await h.settle();
    assert.equal(h.state.syncRetries.length, 0); syncRetry8b(h, id(600)).props.onPress(); await h.settle();
    assert.deepEqual(h.state.syncRetries, [recoveryRef(id(600))]);
  } finally { h.close(); }
});

for (const kind of ["need_more_info", "candidate_selection", "confirmation", "outcome", "failure", "uncertain"]) test(`8-B 변경 success가 아닌 ${kind}에 동기화 안내·retry 혼합 없음`, async () => {
  const h = harness({ initialSnapshot: snapshotOf([recovered(kind)]), initialSyncSnapshot: [syncEntry8b("refresh-error")] });
  try {
    assert.equal(syncStatus8b(h, id(600)), undefined); h.find("ConversationList").onScheduleSyncRetry(recoveryRef()); await h.settle(); assert.equal(h.state.syncRetries.length, 0);
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.mockRuns, 0);
  } finally { h.close(); }
});

test("8-B retry 연타는 실제 Schedule GET 1회·POST/write 0회·성공 후 실패 안내와 버튼 해제", async () => {
  const h = harness({ actualScheduleSync: true }), first = deferred(), retried = deferred();
  try {
    const cache = h.source("src/stores/serverScheduleStore.ts").serverScheduleStore;
    h.state.handle = async () => json({ items: [scheduleDto8b()] });
    const owner = cache.acquire({ from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }); await owner.promise;
    const execution = await liveSync8b(h, () => first.promise), requestId = execution.reference.requestId, original = h.messages().at(-1);
    assert.equal(textOf(syncStatus8b(h, requestId)).trim(), ""); first.resolve(error7a("ROUTE_NOT_FOUND", 404)); await h.settle();
    assert.ok(textOf(syncStatus8b(h, requestId)).includes("목록 갱신에 실패")); assert.ok(cache.store.getState().servers[serverId].entities[id(200)]);
    routeSync8b(h, () => retried.promise); const beforePosts = postedBodies(h).length, beforeGets = syncCalls8b(h).length;
    const press = syncRetry8b(h, requestId).props.onPress; press(); press(); h.render(); await h.settle();
    assert.equal(syncCalls8b(h).length, beforeGets + 1); assert.equal(syncRetry8b(h, requestId)?.props.disabled ?? true, true);
    assert.equal(h.find("MessageInput").disabled, false); h.edit("작성 중인 새 초안");
    retried.resolve(json({ items: [scheduleDto8b({ title: "GET의 최종 제목", category: "RETURN" })] })); await h.settle();
    assert.ok(!textOf(syncStatus8b(h, requestId)).includes("동기화가 완료")); assert.equal(syncRetry8b(h, requestId), undefined);
    assert.equal(h.find("MessageInput").value, "작성 중인 새 초안"); assert.strictEqual(h.messages().find(message => message.apiExecution?.reference.requestId === requestId), original);
    assert.equal(original.apiExecution.response.data.result.outcome, "success"); assert.equal(postedBodies(h).length, beforePosts);
    assert.ok(syncCalls8b(h).every(call => call.init.method === "GET")); assert.equal(cache.store.getState().servers[serverId].entities[id(200)].category, "반품"); owner.release();
  } finally { first.resolve(error7a("ROUTE_NOT_FOUND", 404)); retried.resolve(json({ items: [] })); h.close(); }
});

test("8-B GET 재실패는 success·실패 안내·retry 유지, 반복 snapshot으로 GET 재실행 없음", async () => {
  const h = harness({ actualScheduleSync: true }); try {
    const execution = await liveSync8b(h, async () => error7a("ROUTE_NOT_FOUND", 404)), requestId = execution.reference.requestId;
    assert.equal(execution.response.data.result.outcome, "success"); const before = syncCalls8b(h).length;
    syncRetry8b(h, requestId).props.onPress(); await h.settle(); assert.equal(syncCalls8b(h).length, before + 1);
    assert.ok(syncRetry8b(h, requestId));
    assert.ok(textOf(syncStatus8b(h, requestId)).includes("실패")); const count = h.state.calls.length;
    h.publishSnapshot(snapshotOf([execution])); h.publishSnapshot(snapshotOf([execution])); await h.settle();
    assert.equal(h.state.calls.length, count); assert.equal(h.messages().at(-1).apiExecution.response.data.result.kind, "outcome");
  } finally { h.close(); }
});

for (const change of ["server", "mock"]) test(`8-B ${change} 변경 후 오래된 retry callback·상태 혼합 차단`, async () => {
  const h = harness({ initialSnapshot: snapshotOf([writeExecution8b()]), initialSyncSnapshot: [syncEntry8b("refresh-error")] });
  try {
    const press = syncRetry8b(h, id(600)).props.onPress;
    if (change === "server") { h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid"); h.render(); }
    else h.switchMode("mock");
    press(); h.publishSync([syncEntry8b("synchronized")]); await h.settle();
    assert.equal(h.state.syncRetries.length, 0); assert.equal(nodes(h.renderConversation().rows, "View").some(node => node.props.testID === "assistant-schedule-sync-status"), false);
    assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("8-B 화면 해제는 구독 해제·늦은 callback 무시, retry 완료도 UI 갱신 없음", async () => {
  const h = harness({ initialSnapshot: snapshotOf([writeExecution8b()]), initialSyncSnapshot: [syncEntry8b("refresh-error")] }), gate = deferred();
  h.sync.retry = () => gate.promise;
  try {
    syncRetry8b(h, id(600)).props.onPress(); h.render(); const late = h.state.lastSyncListener; h.close();
    assert.equal(h.state.syncListeners.size, 0); assert.equal(h.state.syncUnsubscribed, 1);
    h.state.syncSnapshot = [syncEntry8b("synchronized")]; late(); gate.resolve(syncEntry8b("synchronized")); await h.settle();
    assert.equal(h.state.lateUpdates, 0); assert.equal(h.state.calls.length, 0);
  } finally { gate.resolve(null); h.close(); }
});

test("8-B retry의 늦은 반환 오류는 최신 성공 snapshot을 덮지 않음", async () => {
  const h = harness({ initialSnapshot: snapshotOf([writeExecution8b()]), initialSyncSnapshot: [syncEntry8b("refresh-error")] }), gate = deferred();
  h.sync.retry = () => gate.promise;
  try {
    syncRetry8b(h, id(600)).props.onPress(); h.render(); h.publishSync([syncEntry8b("synchronized")]); gate.resolve(syncEntry8b("refresh-error")); await h.settle();
    assert.ok(!textOf(syncStatus8b(h, id(600))).includes("동기화가 완료")); assert.equal(syncRetry8b(h, id(600)), undefined);
  } finally { gate.resolve(null); h.close(); }
});

test("8-B retry 예외는 잠금 해제·기존 실패 안내 유지·자동 새 요청 없음", async () => {
  const h = harness({ initialSnapshot: snapshotOf([writeExecution8b()]), initialSyncSnapshot: [syncEntry8b("refresh-error")] });
  h.sync.retry = async () => { throw Error("대체 서비스 예외"); };
  try { syncRetry8b(h, id(600)).props.onPress(); await h.settle(); assert.equal(syncRetry8b(h, id(600)).props.disabled, false);
    assert.ok(textOf(syncStatus8b(h, id(600))).includes("실패")); assert.equal(h.state.calls.length, 0); assert.equal(h.state.uuidCalls, 0);
  } finally { h.close(); }
});

test("8-B 실제 uncertain → GET success는 같은 메시지에서 동기화·이전 위험 상태와 분리", async () => {
  const h = harness({ actualScheduleSync: true }), gate = deferred(); try {
    const requestId = await liveUncertain(h); assert.equal(syncStatus8b(h, requestId), undefined); const messageId = h.messages().at(-1).id;
    routeSync8b(h, () => gate.promise); checkRisk(h, requestId); await h.settle();
    assert.equal(h.messages().at(-1).id, messageId); assert.equal(h.messages().at(-1).apiExecution.response.data.result.outcome, "success");
    assert.equal(textOf(syncStatus8b(h, requestId)).trim(), ""); gate.resolve(json({ items: [] })); await h.settle();
    assert.ok(!textOf(syncStatus8b(h, requestId)).includes("동기화가 완료")); assert.equal(postedBodies(h).length, 1); assert.equal(syncCalls8b(h).length, 1);
  } finally { gate.resolve(json({ items: [] })); h.close(); }
});

test("8-B 실제 앱 시작·foreground 복구 성공 표시도 GET-only·중복 동기화 없음", async () => {
  const h = harness({ actualScheduleSync: true, actualLifecycle: true });
  await h.storage.saveBeforePost(recoveryRef(), 1000); routeSync8b(h, async () => json({ items: [] })); const detach = h.attachLifecycle();
  try {
    await h.settle(); await h.settle(); assert.ok(!textOf(syncStatus8b(h, id(600))).includes("동기화가 완료"));
    h.app("background"); await h.settle(); h.app("active"); await h.settle();
    assert.equal(h.messages().filter(message => message.apiExecution?.reference.requestId === id(600)).length, 1);
    assert.equal(syncCalls8b(h).length, 1); assert.ok(h.state.calls.every(call => call.init.method === "GET")); assert.equal(h.state.cleanup, 0);
  } finally { h.close(); detach(); await h.settle(); }
});

for (const change of ["server", "mock"]) test(`8-B 실제 GET retry 도중 ${change}: 늦은 응답·과거 동기화 성공 표시 차단`, async () => {
  const h = harness({ actualScheduleSync: true }), gate = deferred(); try {
    const execution = await liveSync8b(h, async () => error7a("ROUTE_NOT_FOUND", 404)), requestId = execution.reference.requestId;
    routeSync8b(h, () => gate.promise); syncRetry8b(h, requestId).props.onPress(); h.render(); await h.settle(); const calls = h.state.calls.length;
    if (change === "server") { h.state.config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://other.example.invalid"); h.render(); }
    else h.switchMode("mock");
    gate.resolve(json({ items: [scheduleDto8b()] })); await h.settle();
    assert.equal(nodes(h.renderConversation().rows, "View").some(node => node.props.testID === "assistant-schedule-sync-status"), false);
    assert.equal(h.state.calls.length, calls); assert.equal(h.state.lateUpdates, 0); assert.equal(h.sync.getSnapshot()[0].phase, "interrupted");
    assert.equal(h.state.mockRuns, 0); assert.equal(postedBodies(h).length, 1);
  } finally { gate.resolve(json({ items: [] })); h.close(); }
});

test("8-B 성공 결과 metadata 보존과 Schedule GET-only retry는 독립", async () => {
  const h = harness({ actualScheduleSync: true }); try {
    const execution = await liveSync8b(h, async () => error7a("ROUTE_NOT_FOUND", 404)), requestId = execution.reference.requestId;
    await readyCleanup(h); assert.equal(cleanupButton(h, requestId, "result"), undefined);
    assert.ok(await h.storage.read(execution.reference)); assert.ok(syncRetry8b(h, requestId));
    routeSync8b(h, async () => json({ items: [] })); syncRetry8b(h, requestId).props.onPress(); await h.settle();
    assert.ok(!textOf(syncStatus8b(h, requestId)).includes("동기화가 완료")); assert.ok(await h.storage.read(execution.reference));
    assert.equal(postedBodies(h).length, 1); assert.equal(h.state.cleanup, 0); assert.equal(h.messages().at(-1).apiExecution.response.data.result.outcome, "success");
  } finally { h.close(); }
});

// 단계별 시험 사이의 공백을 실제 카드 버튼→후속 POST→polling→Schedule GET까지 연속 실행한다.
for (const [approved, completed] of [[true, true], [true, false], [false, true]]) test(`9 통합 후보→확인 ${approved ? "승인" : "거절"}·완료 ${completed}: 실제 버튼·최신 ID·GET 동기화·write 분리`, async () => {
  const h = harness({ actualScheduleSync: true }), beforeMock = h.mock.getState().schedules;
  const original = scheduleDto8b({ completed: !completed }), updated = scheduleDto8b({ completed });
  const cache = h.source("src/stores/serverScheduleStore.ts").serverScheduleStore;
  h.state.handle = async () => json({ items: [original] });
  const owner = cache.acquire({ from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }); await owner.promise;
  const opaque = "opaque:/후보 ?#% 원형", requests = new Map(); let nextStage = 0;
  const candidate = { ...results.candidate_selection, questionId: id(380), expiresAt: new Date(h.wall + 600000).toISOString(),
    candidates: [{ ...results.candidate_selection.candidates[0], candidateId: opaque }, results.candidate_selection.candidates[1]] };
  const confirmation = { ...results.confirmation, questionId: id(381), expiresAt: candidate.expiresAt, target: { ...summary, completed: !completed }, changes: { completed } };
  h.state.handle = async (url, init) => {
    if (new URL(url).pathname === "/api/v1/schedules") return json({ items: [updated] });
    if (init.method === "POST") {
      const body = JSON.parse(init.body); requests.set(body.requestId, { stage: nextStage++, gets: 0 }); return json(status(body.requestId), 202);
    }
    const requestId = url.split("/").pop(), entry = requests.get(requestId); entry.gets++;
    if (entry.stage === 2 && entry.gets <= 2) return json(status(requestId, entry.gets === 1 ? "accepted" : "processing"));
    return json({ ...done(requestId), result: entry.stage === 0 ? candidate : entry.stage === 1 ? confirmation : confirmationOutcome(approved) });
  };
  try {
    h.edit("완료 상태를 바꿀 일정 찾아 줘"); const send = h.find("MessageInput").onSend; send(); send(); h.render(); await h.settle();
    const candidateMessage = h.messages().at(-1); assert.equal(candidateMessage.apiExecution.response.data.result.kind, "candidate_selection");
    const select = candidateButtons(h, candidateMessage.id)[0].props.onPress; select(); select(); h.find("MessageInput").onSend(); h.render(); await h.settle();
    const confirmationMessage = h.messages().at(-1); assert.equal(confirmationMessage.apiExecution.response.data.result.questionId, id(381));
    assert.ok(candidateButtons(h, candidateMessage.id).every(button => button.props.disabled));
    const confirmationDisplay = h.renderConversation().components.find(component => component.name === "AssistantMessage" && component.props.apiResult?.kind === "confirmation").props.apiResult;
    assert.equal(confirmationDisplay.operation, "update"); assert.equal(confirmationDisplay.target.completed, !completed);
    assert.deepEqual(confirmationDisplay.changes, { completed });
    const buttons = confirmationButtons(h, confirmationMessage.id); buttons[approved ? 1 : 0].props.onPress(); buttons[approved ? 0 : 1].props.onPress();
    h.render(); await h.settle(); assert.equal(h.find("MessageInput").disabled, true); assert.equal(postedBodies(h).length, 3);
    assert.equal(h.messages().filter(message => message.apiExecution?.kind === "completed").length, 2);
    await h.advance(2000); assert.equal(h.find("ConversationList").isProcessing, true); await h.advance(2000); await h.settle();
    const bodies = postedBodies(h), [first, selection, answer] = bodies;
    assert.equal(new Set(bodies.map(body => body.requestId)).size, 3); assert.equal(h.state.uuidCalls, 3);
    assert.ok(bodies.every(body => h.source("src/utils/assistant-validation.ts").isAssistantUuidV4(body.requestId)));
    assert.deepEqual(first, { requestId: first.requestId, input: { type: "text", text: "완료 상태를 바꿀 일정 찾아 줘" } });
    assert.deepEqual(selection, { requestId: selection.requestId, conversationId: id(100), input: { type: "selection", questionId: id(380), candidateId: opaque } });
    assert.deepEqual(answer, { requestId: answer.requestId, conversationId: id(100), input: { type: "confirmation", questionId: id(381), approved } });
    const execution = postMessage(h).apiExecution; assert.equal(execution.response.data.result.outcome, approved ? "success" : "cancelled");
    assert.equal(h.messages().filter(message => message.apiExecution?.reference.requestId === answer.requestId).length, 1);
    assert.deepEqual(h.messages().map(message => message.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
    assert.ok(confirmationButtons(h, confirmationMessage.id).every(button => button.props.disabled));
    assert.equal(syncCalls8b(h).length, approved ? 2 : 1); assert.equal(cache.store.getState().servers[serverId].entities[id(200)].completed, approved ? completed : !completed);
    if (approved) assert.ok(!textOf(syncStatus8b(h, answer.requestId)).includes("동기화가 완료")); else assert.equal(syncStatus8b(h, answer.requestId), undefined);
    assert.equal(await h.storage.read(candidateMessage.apiExecution.reference), null); assert.equal(await h.storage.read(confirmationMessage.apiExecution.reference), null);
    assert.ok(await h.storage.read(execution.reference)); assert.equal(h.state.cleanup, 0);
    assert.strictEqual(h.mock.getState().schedules, beforeMock); assert.equal(h.state.mockRuns, 0);
    assert.ok(h.state.calls.every(call => call.init.method === "GET" || new URL(call.url).pathname === "/api/v1/assistant/requests"));
  } finally { owner.release(); h.close(); }
});

test("9 통합 연속 정보 보충→등록: 실제 입력창·최신 questionId·정식 Schedule GET과 metadata 경계", async () => {
  const h = harness({ actualScheduleSync: true }), before = h.mock.getState().schedules, requests = new Map(); let stage = 0;
  h.state.handle = async (url, init) => {
    if (new URL(url).pathname === "/api/v1/schedules") return json({ items: [scheduleDto8b({ title: "정식 GET 등록 제목", category: "INBOUND" })] });
    if (init.method === "POST") { const body = JSON.parse(init.body); requests.set(body.requestId, stage++); return json(status(body.requestId), 202); }
    const requestId = url.split("/").pop(), step = requests.get(requestId);
    return json({ ...done(requestId), result: step < 2 ? { kind: "need_more_info", text: step === 0 ? "몇 시인가요?" : "어디인가요?", questionId: id(390 + step) }
      : writeOutcome8b("create") });
  };
  try {
    h.send("회의 등록해 줘"); await h.settle(); const first = postMessage(h).apiExecution;
    h.send("오후 3시"); await h.settle(); const second = postMessage(h).apiExecution;
    h.send("북부 창고"); await h.settle(); await h.settle(); const third = postMessage(h).apiExecution;
    const bodies = postedBodies(h); assert.equal(new Set(bodies.map(body => body.requestId)).size, 3); assert.equal(h.state.uuidCalls, 3);
    assert.deepEqual(bodies[0], { requestId: bodies[0].requestId, input: { type: "text", text: "회의 등록해 줘" } });
    for (let n = 1; n < 3; n++) assert.deepEqual(bodies[n], { requestId: bodies[n].requestId, conversationId: id(100),
      input: { type: "text", text: n === 1 ? "오후 3시" : "북부 창고", questionId: id(389 + n) } });
    assert.equal(third.response.data.result.operation, "create"); assert.equal(syncCalls8b(h).length, 1);
    const cache = h.source("src/stores/serverScheduleStore.ts").serverScheduleStore.store.getState().servers[serverId];
    assert.equal(cache.entities[id(200)].title, "정식 GET 등록 제목"); assert.equal(cache.entities[id(200)].category, "입고");
    assert.ok(!textOf(syncStatus8b(h, third.reference.requestId)).includes("동기화가 완료"));
    assert.equal(await h.storage.read(first.reference), null); assert.equal(await h.storage.read(second.reference), null); assert.ok(await h.storage.read(third.reference));
    assert.equal(h.messages().length, 6); assert.strictEqual(h.mock.getState().schedules, before); assert.equal(h.state.mockRuns, 0); assert.equal(h.state.cleanup, 0);
    assert.ok(h.state.calls.every(call => call.init.method === "GET" || new URL(call.url).pathname === "/api/v1/assistant/requests"));
  } finally { h.close(); }
});

// Phase 11 1단계: native·오디오·네트워크 없이 실제 입력/상태 UI와 프로젝트 테마를 렌더한다.
function voiceUiComponents(scheme = "light", { reduceMotion = false, reduceMotionQuery } = {}) {
  const cache = new Map(), frames = new Map(), effects = [], motionListeners = new Set();
  const motion = { loops: [], timings: [], values: [], lateUpdates: 0, removedListeners: 0 };
  let owner, cursor, visited, dirty = false, tree, rootNode;
  const react = {
    useState(initial) {
      const frame = owner, index = cursor++;
      frame.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      const slot = frame.slots[index];
      return [slot.value, next => {
        if (!frame.mounted) motion.lateUpdates++;
        const value = typeof next === "function" ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; }
      }];
    },
    useEffect(callback, deps) {
      const frame = owner, index = cursor++, previous = frame.slots[index];
      if (!previous || !deps.every((value, i) => Object.is(value, previous.deps[i]))) effects.push(() => {
        previous?.cleanup?.(); frame.slots[index] = { deps, cleanup: callback() };
      });
    },
  };
  class AnimatedValue {
    constructor(value) { this.value = value; this.stops = 0; motion.values.push(this); }
    setValue(value) { this.value = value; }
    stopAnimation() { this.stops++; }
    interpolate(config) { return { value: this, config }; }
  }
  const animated = {
    Value: AnimatedValue, View: "Animated.View",
    timing(value, config) { const animation = { value, config }; motion.timings.push(animation); return animation; },
    loop(animation) {
      const loop = { animation, starts: 0, stops: 0, start() { this.starts++; }, stop() { this.stops++; } };
      motion.loops.push(loop); return loop;
    },
  };
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative).exports;
    const module = { exports: {} }; cache.set(relative, module);
    const code = ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    }, fileName: relative }).outputText;
    function resolve(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === "react-native") return { StyleSheet: { create: value => value, hairlineWidth: 0.5 }, Platform: { OS: "ios", select: values => values.ios ?? values.default },
        Text: "Text", View: "View", TextInput: "TextInput", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator",
        Animated: animated, Easing: { linear: value => value }, AccessibilityInfo: {
          isReduceMotionEnabled: () => reduceMotionQuery ?? Promise.resolve(reduceMotion),
          addEventListener(event, listener) {
            assert.equal(event, "reduceMotionChanged"); motionListeners.add(listener);
            return { remove() { motionListeners.delete(listener); motion.removedListeners++; } };
          },
        } };
      if (name === "expo-symbols") return { SymbolView: "SymbolView" };
      if (name === "@/global.css") return {};
      if (name === "@/hooks/use-color-scheme") return { useColorScheme: () => scheme };
      if (name === "@/hooks/use-theme") return { useTheme: () => load("src/constants/theme.ts").Colors[scheme] };
      assert.ok(name.startsWith("@/components/") || name === "@/constants/theme", `UI 밖 모듈 접근 금지: ${name}`);
      return load(`src/${name.slice(2)}.${name.startsWith("@/components/") ? "tsx" : "ts"}`);
    }
    new Function("require", "module", "exports", "fetch", code)(resolve, module, module.exports, () => { throw Error("실제 네트워크 금지"); });
    return module.exports;
  }
  function expand(node, key = "root") {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${key}.${index}`));
    if (typeof node.type === "function") {
      let frame = frames.get(key);
      if (frame && frame.type !== node.type) { dispose(frame); frames.delete(key); frame = null; }
      if (!frame) { frame = { type: node.type, slots: [], mounted: true }; frames.set(key, frame); }
      visited.add(key); const previousOwner = owner, previousCursor = cursor; owner = frame; cursor = 0;
      let result;
      try { result = node.type(node.props); } finally { owner = previousOwner; cursor = previousCursor; }
      return expand(result, `${key}.render`);
    }
    return { ...node, props: { ...node.props, children: expand(node.props.children, `${key}.children`) } };
  }
  function dispose(frame) { frame.mounted = false; frame.slots.forEach(slot => slot?.cleanup?.()); }
  function render(node = rootNode) {
    rootNode = node; let limit = 20;
    do {
      dirty = false; visited = new Set(); tree = expand(rootNode);
      for (const [key, frame] of frames) if (!visited.has(key)) { dispose(frame); frames.delete(key); }
      while (effects.length) effects.shift()();
    } while (dirty && --limit);
    assert.ok(limit, "UI Hook 재렌더 종료"); return tree;
  }
  return {
    theme: load("src/constants/theme.ts").Colors[scheme],
    input: props => render({ type: load("src/components/assistant/message-input.tsx").MessageInput, props: { value: "", onChangeText() {}, onSend() {}, ...props } }),
    status: props => render({ type: load("src/components/assistant/voice-input-status.tsx").VoiceInputStatus, props }),
    motion,
    setReduceMotion: enabled => [...motionListeners].forEach(listener => listener(enabled)),
    listenerCount: () => motionListeners.size,
    flush: async () => { await Promise.resolve(); return dirty ? render() : tree; },
    unmount() { for (const frame of frames.values()) dispose(frame); frames.clear(); },
  };
}

const voiceNotices = {
  recording: { title: "듣고 있어요", description: "말씀해 주세요.", icon: "mic" },
  stopping: { title: "녹음을 마무리하고 있어요", description: "녹음 종료 후 정리 중이에요.", icon: "stop.circle" },
  recorded: { title: "녹음이 완료됐어요", description: "아직 전송하지 않았어요.", icon: "checkmark.circle" },
  "permission-error": { title: "마이크 권한을 확인해 주세요", description: "권한을 허용한 뒤 다시 시도해 주세요.", icon: "mic.slash" },
  "recording-error": { title: "녹음하지 못했어요", description: "다시 시도해 주세요.", icon: "exclamationmark.circle" },
  recognizing: { title: "처리 중이에요", description: "음성을 인식하고 있어요." },
  processing: { title: "처리 중이에요", description: "일정 내용을 확인하고 있어요." },
  "stt-error": { title: "잘 못 들었어요", description: "다시 말씀해 주세요.", icon: "exclamationmark.circle" },
};

for (const scheme of ["light", "dark"]) {
  test(`음성 UI ${scheme}: 기본 마이크 비활성·빈 공간 없음·기존 전송 버튼/키보드 동작`, () => {
    const ui = voiceUiComponents(scheme); let sends = 0, starts = 0;
    const empty = ui.input({ onSend: () => sends++, onStartVoice: () => starts++ });
    const mic = nodes(empty, "Pressable")[0], field = nodes(empty, "TextInput")[0];
    assert.equal(mic.props.accessibilityLabel, "음성 입력 시작"); assert.equal(mic.props.disabled, true);
    assert.deepEqual(mic.props.accessibilityState, { disabled: true }); assert.equal(mic.props.onPress, undefined);
    assert.match(mic.props.accessibilityHint, /준비 중/); assert.equal(nodes(empty, "SymbolView")[0].props.name.ios, "mic");
    assert.equal(field.props.onSubmitEditing, undefined); assert.equal(field.props.editable, true);
    assert.ok(textOf(empty).includes("메시지를 입력하세요"));
    assert.equal(ui.status({ input: { source: "text" } }), null);
    assert.equal(Object.assign({}, ...field.props.style).backgroundColor, ui.theme.backgroundElement);
    assert.equal(Object.assign({}, ...field.props.style).color, ui.theme.text);
    assert.equal(mic.props.style({ pressed: false })[1].backgroundColor, ui.theme.primary);
    assert.equal(mic.props.style({ pressed: false })[0].width, 52);
    const text = ui.input({ value: "일정 조회", onSend: () => sends++, onStartVoice: () => starts++ });
    const send = nodes(text, "Pressable")[0], input = nodes(text, "TextInput")[0];
    assert.equal(send.props.disabled, false); assert.equal(send.props.accessibilityLabel, "메시지 전송");
    assert.equal(nodes(text, "SymbolView")[0].props.name.ios, "arrow.up");
    send.props.onPress(); input.props.onSubmitEditing(); assert.equal(sends, 2); assert.equal(starts, 0);
    const whitespace = ui.input({ value: " \n " }); assert.equal(nodes(whitespace, "Pressable")[0].props.disabled, true);
  });

  for (const [phase, notice] of Object.entries(voiceNotices)) test(`음성 UI ${scheme}/${phase}: 카드·아이콘·제목/설명·접근성·테마·취소 버튼 없음`, async () => {
    const ui = voiceUiComponents(scheme);
    const view = ui.status({ input: { source: "voice", phase } });
    assert.equal(view.props.testID, "voice-input-status");
    const views = nodes(view, "View"), isError = phase.endsWith("error"), loading = ["recognizing", "processing"].includes(phase);
    const card = views.find(node => node.props.testID === "voice-input-card");
    const cardStyle = Object.assign({}, ...card.props.style);
    assert.equal(view.props.style.paddingHorizontal, 16); assert.equal(view.props.style.paddingVertical, 8);
    assert.equal(cardStyle.backgroundColor, ui.theme[scheme === "dark" ? "backgroundElement" : "background"]);
    assert.equal(cardStyle.borderColor, ui.theme[scheme === "dark" ? "backgroundSelected" : "backgroundElement"]);
    assert.equal(cardStyle.flexDirection, "row"); assert.equal(cardStyle.alignItems, "center");
    assert.equal(cardStyle.borderRadius, 20); assert.equal(cardStyle.paddingHorizontal, 16); assert.equal(cardStyle.paddingVertical, 12);
    assert.ok(cardStyle.shadowOpacity > 0 && cardStyle.shadowOpacity < 0.2); assert.ok(cardStyle.shadowRadius > 0);
    const texts = nodes(view, "Text"), title = texts.find(node => node.props.children === notice.title), description = texts.find(node => node.props.children === notice.description);
    assert.ok(title); assert.ok(description);
    const titleStyle = Object.assign({}, ...title.props.style), descriptionStyle = Object.assign({}, ...description.props.style);
    assert.equal(titleStyle.color, ui.theme.text); assert.equal(titleStyle.fontWeight, "700");
    assert.ok(titleStyle.fontSize > descriptionStyle.fontSize); assert.equal(descriptionStyle.color, ui.theme.textSecondary);
    const announcement = views.find(node => node.props.accessible === true);
    assert.equal(announcement.props.accessibilityLiveRegion, "polite");
    assert.equal(announcement.props.accessibilityRole, isError ? "alert" : "text");
    assert.equal(announcement.props.accessibilityLabel, `${notice.title}. ${notice.description}`);
    const icon = views.find(node => node.props.testID === "voice-input-icon"), iconStyle = Object.assign({}, ...icon.props.style);
    assert.equal(iconStyle.width, 40); assert.equal(iconStyle.height, 40); assert.equal(iconStyle.borderRadius, 20);
    assert.equal(iconStyle.backgroundColor, ui.theme[scheme === "dark" ? "backgroundSelected" : "backgroundElement"]);
    assert.equal(icon.props.accessible, false); assert.equal(icon.props.accessibilityElementsHidden, true);
    const spinners = nodes(view, "ActivityIndicator"), symbols = nodes(view, "SymbolView");
    assert.equal(spinners.length, loading ? 1 : 0); assert.equal(symbols.length, loading ? 0 : 1);
    if (loading) assert.equal(spinners[0].props.color, ui.theme.primary);
    else {
      assert.equal(symbols[0].props.name.ios, notice.icon); assert.equal(symbols[0].props.size, 24);
      assert.equal(symbols[0].props.tintColor, ui.theme[isError ? "destructive" : "primary"]);
    }
    const waveforms = views.filter(node => node.props.testID === "voice-input-waveform");
    assert.equal(waveforms.length, phase === "recording" ? 1 : 0);
    assert.equal(nodes(view, "Pressable").length, 0); assert.ok(!textOf(view).includes("녹음 취소"));
    if (phase === "recording") {
      assert.equal(waveforms[0].props.accessibilityElementsHidden, true);
      assert.equal(waveforms[0].props.style.width, 28); assert.equal(waveforms[0].props.style.height, 24);
      assert.equal(waveforms[0].props.style.alignItems, "center"); assert.equal(waveforms[0].props.style.flexShrink, 0);
      assert.strictEqual(card.props.children.at(-1), waveforms[0]);
      const bars = waveforms[0].props.children;
      assert.equal(bars.length, 4); assert.ok(new Set(bars.map(bar => bar.props.style[1].height)).size > 1);
      assert.ok(bars.every(bar => bar.props.style[1].backgroundColor === ui.theme.primary));
    }
    if (phase === "recorded") assert.ok(!textOf(view).includes("인식"));
    await ui.flush();
    assert.equal(ui.motion.loops.length, phase === "recording" ? 1 : 0);
    assert.equal(ui.listenerCount(), phase === "recording" ? 1 : 0);
    ui.unmount();
    assert.ok(ui.motion.loops.every(loop => loop.stops === 1)); assert.equal(ui.listenerCount(), 0);
  });

  test(`음성 UI ${scheme}: 녹음 중 placeholder·정지 위치·비활성 유지와 기본 입력 복귀`, () => {
    const ui = voiceUiComponents(scheme), recording = ui.input({ isRecording: true, disabled: true });
    const stop = nodes(recording, "Pressable")[0], field = nodes(recording, "TextInput")[0];
    assert.ok(textOf(recording).includes("음성을 듣고 있어요...")); assert.ok(!textOf(recording).includes("메시지를 입력하세요"));
    assert.equal(field.props.editable, false); assert.deepEqual(field.props.accessibilityState, { disabled: true });
    assert.equal(field.props.onSubmitEditing, undefined); assert.equal(stop.props.accessibilityLabel, "녹음 정지");
    assert.equal(stop.props.disabled, true); assert.equal(stop.props.onPress, undefined);
    assert.equal(nodes(recording, "SymbolView")[0].props.name.ios, "stop.fill");
    const normal = nodes(ui.input({}), "Pressable")[0];
    assert.deepEqual(stop.props.style({ pressed: false }), normal.props.style({ pressed: false }));
    assert.ok(textOf(ui.input({})).includes("메시지를 입력하세요"));
  });
}

for (const scheme of ["light", "dark"]) test(`음성 UI ${scheme}: 파형 위상차·고정 영역·Reduce Motion 변경·상태 전환/해제 정리`, async () => {
  const ui = voiceUiComponents(scheme);
  try {
    const initial = ui.status({ input: { source: "voice", phase: "recording" } });
    assert.equal(ui.motion.loops.length, 0); // 기기 설정 확인 전에는 정적으로 표시한다.
    const view = await ui.flush(), loop = ui.motion.loops[0];
    assert.equal(loop.starts, 1); assert.equal(loop.stops, 0);
    assert.equal(loop.animation.config.toValue, 1); assert.equal(loop.animation.config.duration, 1400);
    assert.equal(loop.animation.config.useNativeDriver, true); assert.equal(loop.animation.config.isInteraction, false);
    const wave = nodes(view, "View").find(node => node.props.testID === "voice-input-waveform");
    const bars = nodes(view, "Animated.View"); assert.equal(bars.length, 4);
    const curves = bars.map(bar => bar.props.style[1].transform[0].scaleY.config);
    for (const curve of curves) {
      assert.equal(curve.inputRange.length, 17); assert.equal(curve.outputRange.length, 17);
      assert.equal(curve.inputRange[0], 0); assert.equal(curve.inputRange.at(-1), 1);
      assert.ok(curve.outputRange.every(scale => scale >= 0.45 && scale <= 1));
      assert.ok(Math.max(...curve.outputRange) - Math.min(...curve.outputRange) > 0.5);
      assert.ok(Math.abs(curve.outputRange[0] - curve.outputRange.at(-1)) < 1e-10); // 루프 경계에서도 연속적이다.
    }
    assert.deepEqual(curves.map(curve => curve.outputRange.indexOf(1)), [0, 4, 8, 12]);
    assert.equal(wave.props.style.alignItems, "center"); assert.equal(wave.props.style.width, 28); assert.equal(wave.props.style.height, 24);
    assert.deepEqual(nodes(initial, "View").find(node => node.props.testID === "voice-input-card").props.style,
      nodes(view, "View").find(node => node.props.testID === "voice-input-card").props.style);
    ui.setReduceMotion(true); const reduced = await ui.flush();
    assert.equal(loop.stops, 1); assert.equal(ui.motion.values[0].stops, 1); assert.equal(ui.motion.values[0].value, 0);
    assert.ok(nodes(reduced, "Animated.View").every(bar => bar.props.style[1].transform === undefined));
    assert.equal(nodes(reduced, "Animated.View").length, 4); // 카드와 정적 파형은 유지한다.
    ui.setReduceMotion(false); await ui.flush();
    assert.equal(ui.motion.loops.length, 2); assert.equal(ui.motion.loops[1].starts, 1);
    for (const input of [{ source: "text" }, ...Object.keys(voiceNotices).filter(phase => phase !== "recording").map(phase => ({ source: "voice", phase }))]) {
      const other = ui.status({ input }); await ui.flush();
      assert.equal(nodes(other, "Animated.View").length, 0); assert.equal(ui.listenerCount(), 0);
      assert.equal(ui.motion.loops.length, 2); assert.ok(ui.motion.loops.every(animation => animation.stops === 1));
    }
    ui.status({ input: { source: "voice", phase: "recording" } }); await ui.flush();
    assert.equal(ui.motion.loops.length, 3); assert.equal(ui.motion.loops[2].starts, 1);
  } finally { ui.unmount(); }
  assert.ok(ui.motion.loops.every(loop => loop.stops === 1)); assert.equal(ui.listenerCount(), 0);
  assert.equal(ui.motion.lateUpdates, 0);
});

test("음성 UI: Reduce Motion 초기 활성화 시 반복 없이 정적 파형 유지", async () => {
  const ui = voiceUiComponents("light", { reduceMotion: true });
  try {
    ui.status({ input: { source: "voice", phase: "recording" } }); const view = await ui.flush();
    assert.equal(ui.motion.loops.length, 0); assert.equal(nodes(view, "Animated.View").length, 4);
    assert.ok(nodes(view, "Animated.View").every(bar => bar.props.style[1].transform === undefined));
  } finally { ui.unmount(); }
  assert.equal(ui.listenerCount(), 0);
});

test("음성 UI: 해제 뒤 늦은 Reduce Motion 조회는 상태 변경·애니메이션 시작 없음", async () => {
  const query = deferred(), ui = voiceUiComponents("light", { reduceMotionQuery: query.promise });
  ui.status({ input: { source: "voice", phase: "recording" } }); ui.unmount();
  query.resolve(false); await ui.flush();
  assert.equal(ui.motion.loops.length, 0); assert.equal(ui.motion.lateUpdates, 0); assert.equal(ui.listenerCount(), 0);
  assert.equal(ui.motion.removedListeners, 1);
});

test("음성 UI: Reduce Motion 조회 실패는 정적 유지·최신 변경 이벤트는 오래된 조회보다 우선", async () => {
  const failed = voiceUiComponents("dark", { reduceMotionQuery: Promise.reject(Error("설정 조회 실패")) });
  try {
    failed.status({ input: { source: "voice", phase: "recording" } }); await failed.flush();
    assert.equal(failed.motion.loops.length, 0);
  } finally { failed.unmount(); }
  const query = deferred(), ui = voiceUiComponents("light", { reduceMotionQuery: query.promise });
  try {
    ui.status({ input: { source: "voice", phase: "recording" } }); ui.setReduceMotion(true);
    query.resolve(false); await ui.flush(); assert.equal(ui.motion.loops.length, 0);
    ui.setReduceMotion(false); await ui.flush(); assert.equal(ui.motion.loops[0].starts, 1);
  } finally { ui.unmount(); }
  assert.equal(ui.motion.loops[0].stops, 1); assert.equal(ui.listenerCount(), 0);
});

test("음성 UI: 시작·정지·text callback 분리, 녹음 중 초안이 있어도 정지가 우선", () => {
  const ui = voiceUiComponents(); let sends = 0, starts = 0, stops = 0;
  const callbacks = { onSend: () => sends++, onStartVoice: () => starts++, onStopVoice: () => stops++, voiceDisabled: false };
  const start = nodes(ui.input(callbacks), "Pressable")[0]; start.props.onPress();
  assert.equal(starts, 1); assert.equal(sends, 0); assert.equal(stops, 0);
  const recording = ui.input({ ...callbacks, value: "보존할 초안", isRecording: true, disabled: true });
  const stop = nodes(recording, "Pressable")[0], field = nodes(recording, "TextInput")[0];
  assert.equal(stop.props.accessibilityLabel, "녹음 정지"); assert.equal(stop.props.disabled, false);
  assert.equal(nodes(recording, "SymbolView")[0].props.name.ios, "stop.fill"); stop.props.onPress();
  assert.equal(stops, 1); assert.equal(starts, 1); assert.equal(sends, 0);
  assert.equal(field.props.editable, false); assert.equal(field.props.value, "보존할 초안"); assert.equal(field.props.onSubmitEditing, undefined);
  for (const props of [{}, { isRecording: true }, { onStartVoice() {}, disabled: true }, { onStopVoice() {}, isRecording: true, voiceDisabled: true }]) {
    const button = nodes(ui.input({ voiceDisabled: false, ...props }), "Pressable")[0];
    assert.equal(button.props.disabled, true); assert.equal(button.props.onPress, undefined);
  }
  const blocked = ui.input({ value: "전송 금지", disabled: true, ...callbacks });
  assert.equal(nodes(blocked, "Pressable")[0].props.onPress, undefined); assert.equal(nodes(blocked, "TextInput")[0].props.onSubmitEditing, undefined);
});

for (const initialMode of ["mock", "server"]) test(`음성 UI ${initialMode}: 제품 기본값은 text·마이크 미연결·기존 대화 보존`, async () => {
  const h = harness({ initialMode });
  try {
    assert.deepEqual(h.find("VoiceInputStatus").input, { source: "text" }); assert.equal(h.messages().length, 0);
    assert.equal(h.find("MessageInput").voiceDisabled, true); assert.equal(h.find("MessageInput").onStartVoice, undefined);
    assert.equal(h.find("MessageInput").onStopVoice, undefined);
    h.send("일정 보여줘"); await h.advance(700);
    const previous = h.messages(), schedules = h.mock.getState().schedules, calls = h.state.calls.length, runs = h.state.mockRuns;
    for (const phase of Object.keys(voiceNotices)) {
      h.fixtureInputUi({ source: "voice", phase }); await h.advance(800);
      assert.strictEqual(h.messages(), previous); assert.strictEqual(h.mock.getState().schedules, schedules);
      assert.equal(h.state.calls.length, calls); assert.equal(h.state.mockRuns, runs);
      assert.deepEqual(h.find("VoiceInputStatus").input, { source: "voice", phase });
      assert.equal(h.find("MessageInput").isRecording, phase === "recording");
    }
    if (initialMode === "mock") assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

for (const phase of ["recording", "stopping", "recognizing", "processing"]) {
  for (const initialMode of ["mock", "server"]) test(`음성 UI ${initialMode}/${phase}: 현재·이전 text callback 차단·질문/초안 유지`, async () => {
    const h = harness({ initialMode });
    try {
      h.edit("내일 오후 3시 팀 회의 추가해 줘"); const staleSend = h.find("MessageInput").onSend;
      h.fixtureInputUi({ source: "voice", phase }); const previous = h.messages(), schedules = h.mock.getState().schedules;
      staleSend(); h.find("MessageInput").onSend(); h.render(); await h.advance(1000);
      assert.equal(h.find("MessageInput").disabled, true); assert.equal(h.find("ConversationList").interactionsDisabled, true);
      assert.equal(h.find("ConversationList").showProcessingNotice, false);
      assert.strictEqual(h.messages(), previous); assert.strictEqual(h.mock.getState().schedules, schedules);
      assert.equal(h.find("MessageInput").value, "내일 오후 3시 팀 회의 추가해 줘");
      assert.equal(h.state.calls.length, 0); assert.equal(h.state.starts.length, 0); assert.equal(h.state.mockRuns, 0); assert.equal(h.state.uuidCalls, 0);
    } finally { h.close(); }
  });
}

test("음성 UI: processing 표시만으로 Mock 실행 불가·실제 text 및 정보 보충은 한 번씩 실행", async () => {
  const h = harness({ initialMode: "mock" });
  try {
    const schedules = h.mock.getState().schedules;
    h.fixtureInputUi({ source: "voice", phase: "processing" }); h.fixtureStatus("processing"); await h.advance(1000);
    assert.equal(h.state.mockRuns, 0); assert.strictEqual(h.mock.getState().schedules, schedules); assert.equal(h.messages().length, 0);
    h.fixtureStatus("idle"); h.fixtureInputUi({ source: "text" }); h.send("내일 팀 회의 추가해 줘");
    await h.advance(700); assert.equal(h.state.mockRuns, 1); assert.equal(h.mock.getState().schedules.length, schedules.length);
    h.fixtureInputUi({ source: "voice", phase: "recorded" }); h.send("오후 3시"); await h.advance(700);
    assert.equal(h.state.mockRuns, 2); assert.equal(h.mock.getState().schedules.length, schedules.length + 1);
    assert.deepEqual(h.find("VoiceInputStatus").input, { source: "text" }); assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("음성 UI: 진행 text의 Mock 타이머는 표시 변경으로 취소·중복 실행되지 않음", async () => {
  const h = harness({ initialMode: "mock" });
  try {
    h.send("내일 오후 3시 팀 회의 추가해 줘"); const count = h.mock.getState().schedules.length;
    assert.match(textOf(h.renderConversation().footer), /일정을 확인하고 있어요/);
    h.fixtureInputUi({ source: "voice", phase: "processing" });
    assert.equal(h.find("ConversationList").isProcessing, true); assert.equal(h.find("ConversationList").showProcessingNotice, false);
    assert.doesNotMatch(textOf(h.renderConversation().footer), /일정을 확인하고 있어요/);
    await h.advance(700); await h.advance(700);
    assert.equal(h.state.mockRuns, 1); assert.equal(h.mock.getState().schedules.length, count + 1); assert.equal(h.messages().length, 2);
  } finally { h.close(); }
});

test("음성 UI: 처리 문구를 숨겨도 진행 요청 복구 footer는 숨기고 다른 기록은 유지", async () => {
  const h = harness(), gate = deferred(), orphan = recoveryRef(id(777));
  try {
    await h.storage.saveBeforePost(orphan, 1000); h.state.handle = () => gate.promise;
    h.send("조회"); await h.settle(); const messages = h.messages();
    // POST 전 저장은 비동기이며 화면 readAll보다 늦을 수 있다. 실제 저장 완료 snapshot을 footer fixture로 전달한다.
    const recoveryControls = (await h.storage.readAll()).map(({ serverId, requestId }) => ({ reference: { serverId, requestId } }));
    assert.equal(recoveryControls.length, 2);
    const originalText = textOf(h.renderConversation().footer); assert.match(originalText, /일정을 확인하고 있어요/);
    h.fixtureInputUi({ source: "voice", phase: "processing" });
    const props = h.find("ConversationList"), view = h.renderConversation(messages, { recoveryControls });
    assert.equal(props.isProcessing, true); assert.equal(props.showProcessingNotice, false);
    assert.doesNotMatch(textOf(view.footer), /일정을 확인하고 있어요/);
    const controls = view.components.filter(component => component.name === "AssistantMessage" && component.props.recoveryControl);
    assert.deepEqual(controls.map(component => component.props.recoveryControl.reference), [orphan]);
    assert.strictEqual(h.messages(), messages); assert.equal(h.state.cleanup, 0); assert.equal(h.state.calls.length, 1);
  } finally { h.close(); await h.settle(); }
});

for (const kind of ["candidate_selection", "confirmation"]) test(`음성 UI ${kind}: 기존 카드 유지·현재/오래된 action 차단·해제 후 명시적 입력`, async () => {
  const h = harness();
  try {
    h.state.handle = responseWith(results[kind]); h.send("변경할 일정 찾아 줘"); await h.settle();
    const message = h.messages().at(-1), previousProps = h.find("ConversationList"), messages = h.messages();
    const click = props => kind === "candidate_selection" ? props.onApiCandidateSelection(message.id, results[kind].candidates[0].candidateId)
      : props.onApiConfirmation(message.id, true);
    h.fixtureInputUi({ source: "voice", phase: "recording" });
    click(previousProps); click(h.find("ConversationList")); h.render(); await h.settle();
    const buttons = candidateButtons(h, message.id); assert.ok(buttons.length > 0); assert.ok(buttons.every(button => button.props.disabled));
    assert.strictEqual(h.messages(), messages); assert.equal(postedBodies(h).length, 1);
    h.fixtureInputUi({ source: "text" }); h.state.handle = responseWith(results.outcome);
    click(h.find("ConversationList")); h.render(); await h.settle(); assert.equal(postedBodies(h).length, 2);
    assert.equal(postedBodies(h)[1].input.type, kind === "candidate_selection" ? "selection" : "confirmation");
  } finally { h.close(); }
});

test("음성 UI Mock 후보·삭제 확인은 녹음 fixture 동안 유지·차단하며 수동 Schedule은 독립", async () => {
  const h = harness({ initialMode: "mock" });
  try {
    h.send("재고 일정 삭제해 줘"); await h.advance(700); const candidate = h.messages().at(-1);
    const candidateId = candidate.interaction.candidates[0].scheduleId, previous = h.find("ConversationList");
    h.fixtureInputUi({ source: "voice", phase: "recording" }); const schedules = h.mock.getState().schedules;
    previous.onCandidateSelection(candidate.id, candidateId); h.render(); await h.settle();
    assert.equal(h.messages().length, 2); assert.strictEqual(h.mock.getState().schedules, schedules);
    h.fixtureInputUi({ source: "text" }); h.find("ConversationList").onCandidateSelection(candidate.id, candidateId); h.render();
    const confirmation = h.messages().at(-1), approve = h.find("ConversationList").onDeleteConfirmation;
    h.fixtureInputUi({ source: "voice", phase: "recording" }); approve(confirmation.id, true); h.render(); await h.settle();
    assert.strictEqual(h.mock.getState().schedules, schedules);
    const added = { ...schedules[0], id: id(888), title: "수동 일정" }; h.mock.getState().addSchedule(added);
    assert.ok(h.mock.getState().schedules.some(schedule => schedule.id === added.id)); assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});
