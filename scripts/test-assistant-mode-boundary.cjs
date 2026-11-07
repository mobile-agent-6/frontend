/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");

// native 렌더러 대신 실제 화면 함수의 Hook·이벤트·effect를 메모리에서 구동한다.
// 레이아웃 검증이 아니라 모드 전환과 지연 callback의 상태 경계를 검사한다.
function harness(initialMode = "mock") {
  const slots = [], effects = [], timers = new Map(), cache = new Map();
  let cursor = 0, dirty = false, tree, timerId = 0, uuidFailure = false, onUUID = null;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (next) => {
        const value = typeof next === "function" ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useCallback(fn, deps) {
      const index = cursor++; if (!same(slots[index]?.deps, deps)) slots[index] = { deps, fn };
      return slots[index].fn;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) effects.push(() => {
        slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: fn() };
      });
    },
  };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: file,
    }).outputText;
    const resolve = (name) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === "react-native") return { KeyboardAvoidingView: "KeyboardAvoidingView", Platform: { OS: "ios" }, StyleSheet: { create: (s) => s } };
      if (name === "zustand" || name === "zustand/vanilla") return require(name);
      if (name === "expo/fetch") return { fetch: () => { throw new Error("실제 네트워크 요청 금지"); } };
      if (name === "expo-crypto") return { randomUUID: () => {
        if (uuidFailure) throw new Error("UUID 생성 실패");
        onUUID?.();
        return require("node:crypto").randomUUID();
      } };
      if (name.startsWith("@/components/")) {
        const component = name.split("/").at(-1).split("-").map((s) => s[0].toUpperCase() + s.slice(1)).join("");
        return { [component]: component };
      }
      if (name === "@/hooks/use-color-scheme") return { useColorScheme: () => "light" };
      if (name === "@/hooks/use-theme") return { useTheme: () => ({ background: "white" }) };
      assert.ok(name.startsWith("@/"), name);
      return load(path.join(root, "src", `${name.slice(2)}.ts`));
    };
    new Function("require", "module", "exports", "fetch", "setTimeout", "clearTimeout", "process", code)(
      resolve, module, module.exports, () => { throw new Error("실제 네트워크 요청 금지"); },
      (fn) => { timers.set(++timerId, fn); return timerId; }, (id) => timers.delete(id), { env: { EXPO_PUBLIC_SCHEDULE_DATA_MODE: initialMode } });
    return module.exports;
  }
  const source = (file) => load(path.join(root, file));
  const mode = source("src/stores/scheduleDataModeStore.ts");
  const mock = source("src/stores/scheduleStore.ts").useScheduleStore;
  const service = source("src/services/mock/assistant.ts");
  const Screen = source("src/app/(tabs)/assistant.tsx").default;
  function render() {
    let limit = 30;
    do { dirty = false; cursor = 0; tree = Screen(); while (effects.length) effects.shift()(); } while (dirty && --limit);
    assert.ok(limit, "렌더 반복이 종료되어야 한다");
  }
  function find(type, node = tree) {
    if (!node) return null;
    if (Array.isArray(node)) return node.map((n) => find(type, n)).find(Boolean);
    if (node.type === type) return node.props;
    return node.props?.children === undefined ? null : find(type, node.props.children);
  }
  render();
  return { source, mode, mock, service, timers, render, find,
    switchMode(value) { mode.scheduleDataModeStore.getState().setMode(value); render(); },
    failUUID(value) { uuidFailure = value; },
    beforeUUID(fn) { onUUID = fn; },
    send(text) { find("MessageInput").onChangeText(text); render(); find("MessageInput").onSend(); render(); },
    fire() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((fn) => fn()); render(); },
    close() { slots.forEach((s) => s?.cleanup?.()); mode.scheduleDataModeStore.getState().setMode("mock"); },
  };
}
const id = (last) => `10000000-0000-4000-8000-${String(last).padStart(12, "0")}`;
const messages = (h) => h.find("ConversationList").messages;

test("명시적 Mock 모드의 기존 등록·조회·수정·완료·삭제/취소 유지", () => {
  const h = harness();
  try {
    assert.equal(h.mode.scheduleDataModeStore.getState().mode, "mock");
    h.service.runMockAssistantScenario("내일 오후 3시 팀 회의 추가해 줘"); assert.equal(h.mock.getState().schedules.length, 11);
    assert.equal(h.service.runMockAssistantScenario("일정 보여줘").schedules.length, 11);
    h.service.runMockAssistantScenario("팀 주간 회의를 오후 4시로 바꿔 줘");
    assert.equal(h.mock.getState().schedules.find((s) => s.id === id(2)).time, "16:00");
    h.service.runMockAssistantScenario("A구역 재고 실사 완료 처리해 줘");
    assert.equal(h.mock.getState().schedules.find((s) => s.id === id(1)).completed, true);
    h.service.resolveMockDeleteConfirmation(id(5), false); assert.equal(h.mock.getState().schedules.length, 11);
    h.service.resolveMockDeleteConfirmation(id(5), true); assert.equal(h.mock.getState().schedules.length, 10);
  } finally { h.close(); }
});
test("질문 대기·제목/시간/날짜 후속 답변과 독립 요청 pending 종료 유지", () => {
  const h = harness();
  try {
    for (const [input, followups] of [
      ["내일 일정 추가해 줘", ["팀 회의", "오후 3시"]],
      ["내일 오후 3시에 일정 추가해 줘", ["팀 회의"]],
      ["오후 3시 팀 회의 추가해 줘", ["내일"]],
    ]) {
      let result = h.service.runMockAssistantScenario(input);
      assert.equal(result.status, "need-more-info");
      for (const followup of followups) result = h.service.runMockAssistantScenario(followup, result.pending);
      assert.equal(result.pending, null);
    }
    const waiting = h.service.runMockAssistantScenario("내일 팀 회의 추가해 줘");
    assert.equal(h.service.runMockAssistantScenario("일정 보여줘", waiting.pending).pending, null);
  } finally { h.close(); }
});
test("Mock 화면의 처리 중 중복 전송·후속 질문·기존 대화 보존", () => {
  const h = harness();
  try {
    h.send("내일 팀 회의 추가해 줘"); h.find("MessageInput").onSend(); h.render(); h.fire();
    assert.equal(messages(h).length, 2); assert.equal(h.find("MessageInput").disabled, false);
    h.send("오후 3시"); h.fire(); assert.equal(h.mock.getState().schedules.length, 11);
    assert.equal(messages(h).length, 4);
  } finally { h.close(); }
});
test("Mock 화면 후보 선택·삭제 확인·완료 interaction 재실행 차단", () => {
  const h = harness();
  try {
    h.send("재고 일정 삭제해 줘"); h.fire(); const candidates = messages(h).at(-1);
    h.find("ConversationList").onCandidateSelection(candidates.id, id(1)); h.render();
    const confirmation = messages(h).at(-1); assert.equal(confirmation.interaction.type, "delete-confirmation");
    const callback = h.find("ConversationList").onDeleteConfirmation;
    callback(confirmation.id, true); h.render(); const count = messages(h).length;
    callback(confirmation.id, true); h.render(); assert.equal(messages(h).length, count);
    assert.equal(h.mock.getState().schedules.some((s) => s.id === id(1)), false);
  } finally { h.close(); }
});
test("서버 초기 진입에서도 Assistant Mock write·HTTP 쓰기 허용 없이 미연동 안내", () => {
  const h = harness("server"); try {
    const before = h.mock.getState().schedules;
    assert.equal(h.mode.scheduleDataModeStore.getState().mode, "server");
    const result = h.service.runMockAssistantScenario("내일 오후 3시 팀 회의 추가해 줘");
    assert.equal(result.text, h.mode.ASSISTANT_NOT_CONNECTED_MESSAGE);
    h.send("재고 일정 삭제해 줘"); assert.equal(messages(h).at(-1).text, h.mode.ASSISTANT_NOT_CONNECTED_MESSAGE);
    assert.equal(h.mode.isScheduleRequestAllowed("POST", "/assistant/requests"), false);
    assert.equal(h.mode.isScheduleRequestAllowed("POST", "/system/time-sync"), false);
    assert.strictEqual(h.mock.getState().schedules, before); assert.equal(h.timers.size, 0);
  } finally { h.close(); }
});

test("서버 모드의 모든 공개 Mock 진입점은 조회·생성·수정·삭제 0회", () => {
  const h = harness();
  try {
    h.switchMode("server"); const before = h.mock.getState().schedules; let writes = 0;
    const unsubscribe = h.mock.subscribe(() => writes++);
    for (const input of ["내일 오후 3시 팀 회의 추가해 줘", "일정 보여줘", "팀 주간 회의를 오후 4시로 바꿔 줘",
      "A구역 재고 실사 완료 처리해 줘", "재고 일정 삭제해 줘", "작업장 안전 점검 삭제해 줘", "내일 팀 회의 추가해 줘"]) {
      const result = h.service.runMockAssistantScenario(input);
      assert.equal(result.text, h.mode.ASSISTANT_NOT_CONNECTED_MESSAGE); assert.deepEqual(result.schedules, []);
      assert.equal(result.pending, null);
    }
    assert.equal(h.service.createMockDeleteConfirmation(id(1)).interaction, undefined);
    assert.equal(h.service.resolveMockDeleteConfirmation(id(1), true).text, h.mode.ASSISTANT_NOT_CONNECTED_MESSAGE);
    assert.equal(h.service.resolveMockDeleteConfirmation(id(1), false).text, h.mode.ASSISTANT_NOT_CONNECTED_MESSAGE);
    assert.equal(h.service.runMockAssistantScenario("오후 3시", "awaiting-team-meeting-time").pending, null);
    assert.equal(writes, 0); assert.strictEqual(h.mock.getState().schedules, before); unsubscribe();
  } finally { h.close(); }
});
test("서버 모드 화면은 사용자 기록을 남기고 미연동 안내·잠금 복구", () => {
  const h = harness();
  try {
    h.switchMode("server"); h.send("내일 오후 3시 팀 회의 추가해 줘");
    assert.ok(messages(h).some((m) => m.role === "user"));
    assert.equal(messages(h).at(-1).text, h.mode.ASSISTANT_NOT_CONNECTED_MESSAGE);
    assert.equal(h.find("MessageInput").disabled, false); assert.equal(h.find("ConversationList").isProcessing, false);
    assert.equal(h.timers.size, 0); assert.equal(h.mock.getState().schedules.length, 10);
  } finally { h.close(); }
});
test("타이머 대기 중 모드 전환과 이전 callback 강제 실행도 쓰기 0회", () => {
  const h = harness();
  try {
    h.send("내일 오후 3시 팀 회의 추가해 줘"); const late = [...h.timers.values()][0];
    h.switchMode("server"); assert.equal(h.timers.size, 0);
    late(); h.render(); assert.equal(h.mock.getState().schedules.length, 10);
    assert.equal(h.find("MessageInput").disabled, false);
    h.switchMode("mock"); late(); h.render(); assert.equal(h.mock.getState().schedules.length, 10);
  } finally { h.close(); }
});
test("질문 대기 중 모드 변경은 과거 pending을 제거하고 복귀 후에도 재사용하지 않음", () => {
  const h = harness();
  try {
    h.send("내일 팀 회의 추가해 줘"); h.fire(); h.switchMode("server"); h.switchMode("mock");
    h.send("오후 3시"); h.fire(); assert.equal(h.mock.getState().schedules.length, 10);
    assert.ok(messages(h).some((m) => m.text === "몇 시로 할까요?"));
  } finally { h.close(); }
});
test("모드 변경 전 후보·확인 callback은 서버 및 Mock 복귀 후 실행 불가", () => {
  for (const input of ["재고 일정 삭제해 줘", "작업장 안전 점검 삭제해 줘"]) {
    const h = harness();
    try {
      h.send(input); h.fire(); const interaction = messages(h).at(-1), callbacks = h.find("ConversationList");
      h.switchMode("server");
      callbacks.onCandidateSelection(interaction.id, id(1)); callbacks.onDeleteConfirmation(interaction.id, true); h.render();
      assert.equal(messages(h).find((m) => m.id === interaction.id).interaction.resolved, true);
      h.switchMode("mock"); callbacks.onDeleteConfirmation(interaction.id, true); h.render();
      assert.equal(h.mock.getState().schedules.length, 10); assert.equal(h.find("MessageInput").disabled, false);
    } finally { h.close(); }
  }
});
test("unmount 이후 타이머 callback은 데이터·대화 변경 없음", () => {
  const h = harness(); h.send("내일 오후 3시 팀 회의 추가해 줘"); const late = [...h.timers.values()][0];
  const before = messages(h); h.close(); late(); assert.strictEqual(messages(h), before);
  assert.equal(h.mock.getState().schedules.length, 10);
});
test("예외 후 입력 복원과 재전송 유지", () => {
  const h = harness();
  try {
    h.failUUID(true); h.send("일정 보여줘"); assert.equal(h.find("MessageInput").value, "일정 보여줘");
    assert.equal(h.find("MessageInput").disabled, false);
    h.failUUID(false); h.send("일정 보여줘"); h.fire(); assert.equal(messages(h).at(-1).schedules.length, 10);
  } finally { h.close(); }
});
test("서버 cache와 모드 경계는 Mock 시나리오로 변경되지 않음", () => {
  const h = harness();
  try {
    const server = h.source("src/stores/serverScheduleStore.ts").serverScheduleStore.store;
    const before = server.getState(); h.switchMode("server"); h.service.runMockAssistantScenario("일정 보여줘");
    h.service.resolveMockDeleteConfirmation(id(1), true); assert.strictEqual(server.getState(), before);
  } finally { h.close(); }
});

test("공개 진입점은 서버 모드에서 Mock Store 조회 자체도 실행하지 않음", () => {
  const h = harness(); const original = h.mock.getState;
  try {
    h.switchMode("server"); h.mock.getState = () => { throw new Error("Mock 조회 금지"); };
    for (const result of [h.service.runMockAssistantScenario("일정 보여줘"),
      h.service.createMockDeleteConfirmation(id(1)), h.service.resolveMockDeleteConfirmation(id(1), true)]) {
      assert.equal(result.text, h.mode.ASSISTANT_NOT_CONNECTED_MESSAGE);
    }
  } finally { h.mock.getState = original; h.close(); }
});
test("일정 생성 직전 모드 변경 및 왕복 전환도 generation 검사로 쓰기 차단", () => {
  for (const roundTrip of [false, true]) {
    const h = harness();
    try {
      const before = h.mock.getState().schedules;
      h.beforeUUID(() => {
        h.mode.scheduleDataModeStore.getState().setMode("server");
        if (roundTrip) h.mode.scheduleDataModeStore.getState().setMode("mock");
      });
      const result = h.service.runMockAssistantScenario("내일 오후 3시 팀 회의 추가해 줘");
      assert.strictEqual(h.mock.getState().schedules, before);
      assert.equal(result.text, h.mode.ASSISTANT_NOT_CONNECTED_MESSAGE);
    } finally { h.close(); }
  }
});
test("Mock 변경 후 모드 전환이 발생하면 이전 성공 메시지를 서버 결과로 게시하지 않음", () => {
  const h = harness();
  try {
    const unsubscribe = h.mock.subscribe(() => h.mode.scheduleDataModeStore.getState().setMode("server"));
    h.send("내일 오후 3시 팀 회의 추가해 줘"); h.fire(); unsubscribe();
    assert.equal(h.mock.getState().schedules.length, 11);
    assert.equal(messages(h).at(-1).text, h.mode.ASSISTANT_NOT_CONNECTED_MESSAGE);
    assert.equal(messages(h).some((m) => m.text === "네, 일정을 추가했어요."), false);
    assert.equal(h.find("MessageInput").disabled, false);
  } finally { h.close(); }
});
