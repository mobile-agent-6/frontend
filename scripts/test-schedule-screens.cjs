/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const { randomUUID } = require("node:crypto");
const root = path.resolve(__dirname, "..");

// 실제 화면·Hook·서비스를 실행하되 native 컴포넌트와 React 실행기만 메모리 대역으로 둔다.
// native 렌더링·레이아웃·아이폰 통신을 검증하는 테스트는 아니다.
function harness(initialMode, { readOnly = false } = {}) {
  const modules = new Map(), screens = [], calls = [], navigations = [];
  let current;
  const router = { push: (route) => navigations.push(route), back: () => navigations.push("back") };
  const navigationRef = { isReady: () => true, addListener: () => () => {} };
  const mark = (owner) => { owner.dirty = true; if (owner.root) owner.root.dirty = true; };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const owner = current, index = owner.cursor++;
      owner.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [owner.slots[index].value, (next) => {
        const value = typeof next === "function" ? next(owner.slots[index].value) : next;
        if (!Object.is(value, owner.slots[index].value)) { owner.slots[index].value = value; mark(owner); }
      }];
    },
    useRef(initial) { return current.slots[current.cursor++] ??= { current: initial }; },
    useMemo(fn, deps) {
      const index = current.cursor++;
      if (!same(current.slots[index]?.deps, deps)) current.slots[index] = { deps, value: fn() };
      return current.slots[index].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const owner = current, index = owner.cursor++;
      if (!same(owner.slots[index]?.deps, deps)) owner.effects.push(() => {
        owner.slots[index]?.cleanup?.(); owner.slots[index] = { deps, cleanup: fn() };
      });
    },
  };
  const useStore = (store, select = (s) => s) => {
    const owner = current;
    react.useEffect(() => store.subscribe(() => mark(owner)), [store]);
    return select(store.getState());
  };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ["2026-11-07T03:00:00Z"])); } }
  function source(file) {
    const filename = path.join(root, file);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    }, fileName: filename }).outputText;
    const resolve = (name) => {
      // Assistant의 서버 통신 검증은 전용 화면 테스트에서 실행한다.
      if (name === "@/services/api/assistant") return { assistantHttpClient: { getServerId: () => null } };
      if (name === "@/services/api/assistant-orchestrator") return { assistantOrchestrator: { startRequest: () => { throw new Error("Schedule 화면 검증에서 Assistant 전송 금지"); } } };
      // Schedule 화면 검증은 앱 복구와 분리하고 실제 root 연결은 lifecycle 테스트에서 검증한다.
      if (name === "@/services/api/assistant-lifecycle") return { assistantLifecycle: { attach: () => () => {}, getSnapshot: () => ({ phase: "idle", initialCheck: "pending", serverId: null, results: [] }), subscribe: () => () => {} } };
      if (name === "@/services/storage/assistant-recovery") return { assistantRecoveryStorage: { readAll: async () => [] } };
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
      if (name === "zustand/vanilla") return require(name);
      if (name === "zustand") return { useStore, create: (initializer) => {
        const store = require("zustand/vanilla").createStore(initializer);
        return Object.assign((select) => useStore(store, select), store);
      } };
      if (name === "expo-router") return { Stack: { Screen: "Stack.Screen" }, ThemeProvider: "ThemeProvider", DarkTheme: {}, DefaultTheme: {},
        useNavigationContainerRef: () => navigationRef, usePathname: () => "/assistant",
        useFocusEffect(effect) {
          const owner = current.root ?? current;
          react.useEffect(() => {
            const subscription = { effect, cleanup: owner.focused ? effect() : undefined };
            owner.focusEffects.add(subscription);
            return () => { subscription.cleanup?.(); owner.focusEffects.delete(subscription); };
          }, [effect]);
        },
        useLocalSearchParams: () => ({ id: (current.root ?? current).routeId }),
        useRouter: () => router };
      if (name === "expo-symbols") return { SymbolView: "SymbolView" };
      if (name === "expo-crypto") return { randomUUID: require("node:crypto").randomUUID };
      if (name === "expo/fetch") return { fetch: (url, options) => new Promise((resolve, reject) =>
        calls.push({ url, ...options, resolve, reject, transport: "expo" })) };
      if (name === "@/constants/theme") return { Spacing: { half: 2, one: 4, two: 8, three: 16, four: 24, five: 32, six: 64 }, BottomTabInset: 0 };
      if (name === "react-native") return { ...Object.fromEntries(["FlatList", "Pressable", "View", "ScrollView", "TextInput", "KeyboardAvoidingView", "ActivityIndicator"].map((s) => [s, s])),
        Platform: { OS: "ios" }, useColorScheme: () => "light", Keyboard: { dismiss() {} }, StyleSheet: { create: (s) => s, hairlineWidth: 0.5 } };
      if (name === "@expo/ui/community/datetime-picker") return { DateTimePicker: "DateTimePicker" };
      if (name === "react-native-safe-area-context") return { SafeAreaView: "SafeAreaView" };
      if (name === "@/components/schedule-edit/schedule-edit-form") return source("src/components/schedule-edit/schedule-edit-form.tsx");
      if (name === "@/components/schedule-create/schedule-create-form") return source("src/components/schedule-create/schedule-create-form.tsx");
      if (name.startsWith("@/components/")) {
        const component = name.split("/").at(-1).split("-").map((s) => s[0].toUpperCase() + s.slice(1)).join("");
        return { [component]: component };
      }
      if (name === "@/hooks/use-theme") return { useTheme: () => ({ background: "white", primary: "#FB6C2D", destructive: "red" }) };
      if (name === "@/hooks/use-color-scheme") return { useColorScheme: () => "light" };
      assert.ok(name.startsWith("@/")); return source(`src/${name.slice(2)}.ts`);
    };
    new Function("require", "module", "exports", "fetch", "Date", "process", code)(resolve, module, module.exports,
      (url, options) => new Promise((resolve, reject) => calls.push({ url, ...options, resolve, reject, transport: "global" })), FixedDate,
      { env: { EXPO_PUBLIC_SCHEDULE_DATA_MODE: initialMode,
        EXPO_PUBLIC_SCHEDULE_READ_ONLY: String(readOnly) } });
    return module.exports;
  }
  const configModule = source("src/services/api/config.ts");
  let config = configModule.parseDevelopmentServerConfig("https://example.invalid");
  configModule.getDevelopmentServerConfig = () => config;
  const http = source("src/services/api/http.ts");
  http.scheduleHttpClient = http.createScheduleHttpClient({ readConfig: () => config, fetchImpl: (url, options) =>
    new Promise((resolve, reject) => calls.push({ url, ...options, resolve, reject })) });
  const modeModule = source("src/stores/scheduleDataModeStore.ts");
  // 테스트 전용 환경값으로 실제 정책을 사용한다. 네트워크는 항상 메모리 fetch다.
  const mode = modeModule.scheduleDataModeStore;
  const mock = source("src/stores/scheduleStore.ts").useScheduleStore;
  const server = source("src/stores/serverScheduleStore.ts").serverScheduleStore;
  function expand(node, rootScreen, trail, seen) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((n, i) => expand(n, rootScreen, `${trail}/${i}`, seen));
    if (typeof node.type === "function") {
      const key = `${trail}/${node.type.name}/${node.key ?? ""}`; seen.add(key);
      let child = rootScreen.children.get(key);
      if (!child) { child = { slots: [], effects: [], root: rootScreen }; rootScreen.children.set(key, child); }
      current = child; child.cursor = 0; child.dirty = false;
      const result = node.type(node.props); while (child.effects.length) child.effects.shift()();
      return expand(result, rootScreen, key, seen);
    }
    return { ...node, props: { ...node.props, children: expand(node.props?.children, rootScreen, `${trail}/children`, seen) } };
  }
  function flush() {
    let limit = 40;
    do {
      for (const s of screens.filter((s) => s.dirty && !s.closed)) {
        current = s; s.dirty = false; s.cursor = 0; const raw = s.Screen();
        while (s.effects.length) s.effects.shift()();
        const seen = new Set(); s.tree = expand(raw, s, "root", seen);
        for (const [key, child] of s.children) {
          if (!seen.has(key)) { child.slots.forEach((slot) => slot?.cleanup?.()); s.children.delete(key); }
        }
      }
    } while (screens.some((s) => s.dirty && !s.closed) && --limit);
    assert.ok(limit, "렌더 반복이 종료되어야 한다");
  }
  function nodes(tree, type) {
    if (!tree) return [];
    if (Array.isArray(tree)) return tree.flatMap((t) => nodes(t, type));
    return [...(tree.type === type ? [tree.props] : []), ...nodes(tree.props?.children, type),
      ...nodes(tree.props?.ListEmptyComponent, type), ...nodes(tree.props?.ListHeaderComponent, type)];
  }
  function mount(kind, routeId) {
    const s = { slots: [], effects: [], children: new Map(), dirty: true, routeId, focused: true, focusEffects: new Set(),
      Screen: source(kind === "detail" ? "src/app/schedule/[id].tsx" : kind === "create" ? "src/app/schedule/create.tsx" : kind === "layout" ? "src/app/_layout.tsx" : `src/app/(tabs)/${kind}.tsx`).default };
    screens.push(s); flush();
    return { all: (type) => nodes(s.tree, type), one: (type) => nodes(s.tree, type)[0],
      instance: (name) => [...s.children].find(([key]) => key.includes(`/${name}/`))?.[1],
      focus(value) {
        if (s.focused === value) return;
        s.focused = value;
        for (const subscription of s.focusEffects) {
          subscription.cleanup?.(); subscription.cleanup = value ? subscription.effect() : undefined;
        }
        flush();
      },
      route(id) { s.routeId = id; s.dirty = true; flush(); },
      close() { s.closed = true; s.slots.forEach((slot) => slot?.cleanup?.());
        s.children.forEach((child) => child.slots.forEach((slot) => slot?.cleanup?.())); } };
  }
  return { mount, calls, mock, server, flush, source, navigations,
    back() { router.back(); }, // native 뒤로 가기 동작은 메모리 navigation으로만 모사한다.
    mode(value) { mode.getState().setMode(value); flush(); },
    config(value) { config = configModule.parseDevelopmentServerConfig(value); screens.forEach((s) => { s.dirty = true; }); flush(); },
    async settle() { for (let i = 0; i < 4; i++) { await new Promise(setImmediate); flush(); } },
    respond(index, items, status = 200) { calls[index].resolve(new Response(JSON.stringify({ items }), { status,
      headers: { "Content-Type": "application/json" } })); },
    detail(index, value, status = 200, media = "application/json", headers = {}) { calls[index].resolve(new Response(JSON.stringify(value), {
      status, headers: { "Content-Type": media, ...headers } })); },
    close() { for (const s of screens) { s.closed = true; s.slots.forEach((slot) => slot?.cleanup?.());
      s.children.forEach((child) => child.slots.forEach((slot) => slot?.cleanup?.())); } mode.getState().setMode("mock"); },
  };
}
const dto = (id, category = "INVENTORY", completed = false) => ({ id, title: id, category, completed,
  scheduledAt: "2026-11-07T03:00:00Z", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" });
const states = (screen) => screen.all("ScheduleListState").map((s) => s.state);

const syncRequestId = "80000001-abcd-4abc-8abc-abcdef123456", syncScheduleId = "80000002-abcd-4abc-8abc-abcdef123456";
const syncOutcome = (operation = "update") => ({ requestId: syncRequestId, conversationId: "80000003-abcd-4abc-8abc-abcdef123456", status: "completed",
  result: { kind: "outcome", text: "Assistant 서버 변경 성공", outcome: "success", operation, schedulesChanged: true, affectedScheduleIds: [syncScheduleId] } });

for (const operation of ["create", "update", "delete", "completed"]) test(`8-A 실제 목록·캘린더 ${operation}: 정식 GET의 카드·날짜·dot와 기존 필터 유지`, async () => {
  const h = harness("server"); try {
    const list = h.mount("index"), calendar = h.mount("calendar"); await h.settle();
    const original = dto(syncScheduleId, "OTHER");
    for (let n = 0; n < h.calls.length; n++) h.respond(n, operation === "create" ? [] : [original]); await h.settle();
    list.one("CategoryFilter").onSelectCategory("기타"); h.flush();
    const month = calendar.one("MonthCalendar").visibleMonth, selected = calendar.one("MonthCalendar").selectedDate;
    const start = h.calls.length, sync = h.source("src/services/api/assistant-schedule-sync.ts").assistantScheduleSync;
    const result = syncOutcome(operation === "completed" ? "update" : operation);
    const pending = sync.observe({ serverId: "development:https://example.invalid", requestId: syncRequestId }, result); await h.settle();
    const updated = { ...original, title: "Schedule GET으로 확인한 제목", completed: operation === "completed",
      ...(operation === "update" ? { scheduledAt: "2026-11-08T03:00:00Z" } : {}) };
    for (let n = start; n < h.calls.length; n++) { assert.equal(h.calls[n].method, "GET"); h.respond(n, operation === "delete" ? [] : [updated]); }
    assert.equal((await pending).phase, "synchronized"); await h.settle();
    assert.equal(list.one("CategoryFilter").selectedCategory, "기타");
    assert.equal(calendar.one("MonthCalendar").visibleMonth, month); assert.equal(calendar.one("MonthCalendar").selectedDate, selected);
    const items = list.one("FlatList").data;
    if (operation === "delete") { assert.deepEqual(items, []); assert.deepEqual(calendar.one("MonthCalendar").scheduleDates, []); assert.equal(calendar.all("ScheduleCard").length, 0); }
    else {
      assert.equal(items[0].title, updated.title); assert.equal(items[0].completed, updated.completed);
      assert.ok(calendar.one("MonthCalendar").scheduleDates.includes(operation === "update" ? "2026-11-08" : "2026-11-07"));
      if (operation === "update") { assert.equal(calendar.all("ScheduleCard").length, 0); assert.equal(items[0].date, "2026-11-08"); }
      else assert.strictEqual(calendar.all("ScheduleCard")[0].schedule, items[0]);
    }
    const count = h.calls.length; for (let n = 0; n < 3; n++) { await sync.observe({ serverId: "development:https://example.invalid", requestId: syncRequestId }, result); list.focus(false); list.focus(true); calendar.focus(false); calendar.focus(true); }
    await h.settle(); assert.equal(h.calls.length, count); assert.ok(h.calls.every(call => call.method === "GET"));
  } finally { h.close(); }
});

test("8-A 사용자가 고른 다른 캘린더 월·날짜는 동기화 뒤에도 유지", async () => {
  const h = harness("server"); try {
    const list = h.mount("index"), calendar = h.mount("calendar"); await h.settle();
    for (let n = 0; n < h.calls.length; n++) h.respond(n, []); await h.settle();
    calendar.one("MonthCalendar").onMonthChange({ dateString: "2026-12-01" }); calendar.one("MonthCalendar").onSelectDate({ dateString: "2026-12-05" }); h.flush(); await h.settle();
    for (let n = 2; n < h.calls.length; n++) h.respond(n, []); await h.settle();
    const start = h.calls.length, sync = h.source("src/services/api/assistant-schedule-sync.ts").assistantScheduleSync;
    const pending = sync.observe({ serverId: "development:https://example.invalid", requestId: syncRequestId }, syncOutcome("create")); await h.settle();
    const item = { ...dto(syncScheduleId), scheduledAt: "2026-12-05T03:00:00Z" };
    for (let n = start; n < h.calls.length; n++) h.respond(n, [item]); await pending; await h.settle();
    assert.equal(calendar.one("MonthCalendar").visibleMonth, "2026-12-01"); assert.equal(calendar.one("MonthCalendar").selectedDate, "2026-12-05");
    assert.ok(calendar.one("MonthCalendar").scheduleDates.includes("2026-12-05")); assert.equal(calendar.all("ScheduleCard")[0].schedule.id, syncScheduleId);
    assert.equal(list.one("FlatList").data[0].id, syncScheduleId);
  } finally { h.close(); }
});

test("8-A 화면 해제 중 성공은 기존 조건을 무효화하고 재진입 GET으로 갱신·무한 조회 없음", async () => {
  const h = harness("server"); try {
    let list = h.mount("index"), calendar = h.mount("calendar"); await h.settle();
    for (let n = 0; n < h.calls.length; n++) h.respond(n, [dto(syncScheduleId)]); await h.settle(); list.close(); calendar.close();
    const start = h.calls.length, sync = h.source("src/services/api/assistant-schedule-sync.ts").assistantScheduleSync;
    const pending = sync.observe({ serverId: "development:https://example.invalid", requestId: syncRequestId }, syncOutcome("delete")); await h.settle();
    for (let n = start; n < h.calls.length; n++) h.respond(n, []); await pending;
    list = h.mount("index"); calendar = h.mount("calendar"); await h.settle();
    for (let n = start + 1; n < h.calls.length; n++) h.respond(n, []); await h.settle();
    assert.deepEqual(list.one("FlatList").data, []); assert.deepEqual(calendar.one("MonthCalendar").scheduleDates, []);
    const count = h.calls.length; list.focus(false); list.focus(true); calendar.focus(false); calendar.focus(true); await h.settle(); assert.equal(h.calls.length, count);
  } finally { h.close(); }
});

test("기본 Mock 두 화면·CRUD·완료 변경과 서버 요청 0회", async () => {
  const h = harness("mock"); try {
    const list = h.mount("index"), cal = h.mount("calendar"); await h.settle();
    assert.equal(list.one("FlatList").data.length, 10); assert.equal(h.calls.length, 0);
    cal.one("MonthCalendar").onSelectDate({ dateString: "2026-09-30" }); h.flush();
    assert.equal(cal.all("ScheduleCard").length, 10);
    const first = list.one("FlatList").renderItem({ item: list.one("FlatList").data[0] });
    first.props.onToggleCompleted(); h.flush(); assert.equal(h.mock.getState().schedules[0].completed, true);
    h.mock.getState().addSchedule({ id: "local", title: "로컬", date: "2026-09-30", time: "23:00", category: "기타", completed: false });
    h.mock.getState().updateSchedule("local", { title: "수정" }); h.flush(); assert.equal(list.one("FlatList").data.length, 11);
    h.mock.getState().deleteSchedule("local"); h.flush(); assert.equal(cal.all("ScheduleCard").length, 10);
    assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});

test("Assistant Mock 등록·수정·완료·삭제는 실제 목록/캘린더에 같은 store로 반영", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness("mock"); try {
    const list = h.mount("index"), calendar = h.mount("calendar"), assistant = h.mount("assistant");
    const send = text => {
      assistant.one("MessageInput").onChangeText(text); h.flush();
      assistant.one("MessageInput").onSend(); h.flush();
      t.mock.timers.tick(700); h.flush();
    };
    const showDate = date => { calendar.one("MonthCalendar").onSelectDate({ dateString: date }); h.flush(); };
    const listItem = id => list.one("FlatList").data.find(item => item.id === id);
    const calendarItem = id => calendar.all("ScheduleCard").find(item => item.schedule.id === id)?.schedule;
    const originalIds = new Set(h.mock.getState().schedules.map(item => item.id));
    send("내일 오후 3시 팀 회의 추가해 줘");
    const created = h.mock.getState().schedules.find(item => !originalIds.has(item.id)); assert.ok(created);
    showDate(created.date); assert.strictEqual(listItem(created.id), created); assert.strictEqual(calendarItem(created.id), created);
    assert.ok(calendar.one("MonthCalendar").scheduleDates.includes(created.date));
    send("팀 주간 회의를 오후 4시로 바꿔 줘");
    const changed = h.mock.getState().schedules.find(item => item.id === "10000000-0000-4000-8000-000000000002");
    showDate(changed.date); assert.equal(changed.time, "16:00"); assert.strictEqual(listItem(changed.id), changed); assert.strictEqual(calendarItem(changed.id), changed);
    send("A구역 재고 실사 완료 처리해 줘");
    const completed = h.mock.getState().schedules.find(item => item.id === "10000000-0000-4000-8000-000000000001");
    showDate(completed.date); assert.equal(completed.completed, true); assert.strictEqual(listItem(completed.id), completed); assert.strictEqual(calendarItem(completed.id), completed);
    send("작업장 안전 점검 삭제해 줘");
    const confirmation = assistant.one("ConversationList").messages.at(-1), targetId = confirmation.interaction.scheduleId;
    showDate(h.mock.getState().schedules.find(item => item.id === targetId).date);
    assistant.one("ConversationList").onDeleteConfirmation(confirmation.id, true); h.flush();
    assert.equal(listItem(targetId), undefined); assert.equal(calendarItem(targetId), undefined);
    assert.equal(assistant.one("MessageInput").disabled, false); assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});
test("서버 메인 3개월·서버 순서·로컬 카테고리 필터·완료 차단", async () => {
  const h = harness("mock", { readOnly: true }); try {
    h.mode("server"); const list = h.mount("index"); await h.settle();
    assert.ok(states(list).includes("loading")); assert.ok(!states(list).includes("empty"));
    const params = new URL(h.calls[0].url).searchParams;
    assert.equal(params.get("from"), "2026-09-30T15:00:00.000Z"); assert.equal(params.get("to"), "2026-12-31T15:00:00.000Z");
    assert.equal(params.has("category"), false); assert.equal(params.has("completed"), false);
    h.respond(0, [dto("z"), dto("a", "OTHER")]); await h.settle();
    assert.deepEqual(list.one("FlatList").data.map((s) => s.id), ["z", "a"]);
    list.one("CategoryFilter").onSelectCategory("기타"); h.flush(); assert.deepEqual(list.one("FlatList").data.map((s) => s.id), ["a"]);
    await h.settle(); assert.equal(h.calls.length, 1);
    const before = h.mock.getState().schedules;
    const card = list.one("FlatList").renderItem({ item: list.one("FlatList").data[0] });
    assert.equal(card.props.completionDisabled, true); card.props.onToggleCompleted(); assert.strictEqual(h.mock.getState().schedules, before);
    card.props.onPress(); assert.equal(h.navigations.at(-1).params.id, "a");
  } finally { h.close(); }
});
test("최초 실패는 empty가 아니며 GET Retry 후 정상 0건", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const list = h.mount("index"); await h.settle(); h.respond(0, [], 500); await h.settle();
    assert.ok(states(list).includes("error")); assert.ok(!states(list).includes("empty"));
    list.all("ScheduleListState").find((s) => s.state === "error").onRetry(); await h.settle();
    h.respond(1, []); await h.settle(); assert.ok(states(list).includes("empty")); assert.ok(h.calls.every((c) => c.method === "GET"));
  } finally { h.close(); }
});
test("재조회는 스피너 없이 마지막 성공 카드를 유지하고 실제 오류와 GET Retry 보존", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const list = h.mount("index"); await h.settle(); h.respond(0, [dto("kept")]); await h.settle();
    const q = h.source("src/utils/schedule-query.ts").getMainScheduleRange(new Date("2026-11-07T03:00:00Z"));
    const retry = h.server.retry(q); await h.settle(); assert.equal(list.one("FlatList").data[0].id, "kept");
    assert.equal(states(list).includes("loading"), false); h.respond(1, [], 500); await retry; await h.settle();
    assert.equal(list.one("FlatList").data[0].id, "kept"); assert.ok(states(list).includes("error"));
  } finally { h.close(); }
});
test("캘린더 표시 월·완료 dot·선택 카드 순서 및 월 이동 시 선택 날짜 유지", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const cal = h.mount("calendar"); await h.settle(); assert.equal(h.calls.length, 1);
    assert.equal(new URL(h.calls[0].url).searchParams.get("from"), "2026-10-31T15:00:00.000Z");
    h.respond(0, [dto("z", "INVENTORY", true), dto("a")]); await h.settle();
    assert.ok(cal.one("MonthCalendar").scheduleDates.includes("2026-11-07"));
    assert.deepEqual(cal.all("ScheduleCard").map((s) => s.schedule.id), ["z", "a"]);
    cal.one("MonthCalendar").onMonthChange({ dateString: "2027-04-01" }); h.flush(); await h.settle();
    assert.equal(cal.one("MonthCalendar").selectedDate, "2026-11-07"); assert.equal(h.calls.length, 2);
    assert.deepEqual(cal.all("ScheduleCard").map((s) => s.schedule.id), ["z", "a"]);
    h.respond(1, []); await h.settle(); assert.deepEqual(cal.one("MonthCalendar").scheduleDates, []);
  } finally { h.close(); }
});
test("선택 날짜 coverage가 없으면 별도 월 조회하고 미조회·실패를 empty로 표시하지 않음", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const cal = h.mount("calendar"); await h.settle(); h.respond(0, []); await h.settle();
    cal.one("MonthCalendar").onSelectDate({ dateString: "2027-03-12" }); h.flush(); await h.settle();
    assert.equal(h.calls.length, 2); assert.ok(states(cal).includes("loading"));
    h.respond(1, [], 500); await h.settle(); assert.ok(states(cal).includes("error"));
    assert.equal(cal.one("MonthCalendar").selectedDate, "2027-03-12");
  } finally { h.close(); }
});
test("메인 성공 coverage를 선택 날짜에 재사용하며 표시 월만 별도 조회", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const list = h.mount("index"); await h.settle(); h.respond(0, [dto("shared")]); await h.settle();
    const cal = h.mount("calendar"); await h.settle(); assert.equal(h.calls.length, 2);
    assert.equal(cal.all("ScheduleCard")[0].schedule.id, "shared");
    assert.strictEqual(cal.all("ScheduleCard")[0].schedule, list.one("FlatList").data[0]);
    h.respond(1, [dto("shared")]); await h.settle();
  } finally { h.close(); }
});
test("같은 월의 두 소비자는 요청 공유하며 한 화면 해제 후 유지", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const first = h.mount("calendar"), second = h.mount("calendar"); await h.settle();
    assert.equal(h.calls.length, 1); first.close(); assert.equal(h.calls[0].signal.aborted, false);
    second.close(); assert.equal(h.calls[0].signal.aborted, true);
  } finally { h.close(); }
});
test("월 이동의 늦은 응답·서버 전환·Mock 복귀 데이터 혼합 차단", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const cal = h.mount("calendar"); await h.settle();
    cal.one("MonthCalendar").onMonthChange({ dateString: "2027-02-01" }); h.flush(); await h.settle();
    h.respond(1, []); h.respond(0, [dto("old")]); await h.settle();
    assert.deepEqual(cal.one("MonthCalendar").scheduleDates, []);
    h.config("https://other.example.invalid"); await h.settle(); assert.deepEqual(cal.all("ScheduleCard"), []);
    h.mode("mock"); await h.settle(); assert.ok(cal.one("MonthCalendar").scheduleDates.includes("2026-09-30"));
    assert.ok(h.calls.slice(2).every((c) => c.signal.aborted));
  } finally { h.close(); }
});
test("서버 설정 누락·오류는 Mock fallback 없이 오류 표시", async () => {
  for (const value of [undefined, "invalid"]) {
    const h = harness("mock"); try {
      h.config(value); h.mode("server"); const list = h.mount("index"); await h.settle();
      assert.equal(h.calls.length, 0); assert.deepEqual(list.one("FlatList").data, []);
      assert.ok(states(list).includes("error")); assert.ok(!states(list).includes("empty"));
    } finally { h.close(); }
  }
});

test("마지막 성공이 빈 배열이어도 재조회 실패를 empty로 숨기지 않음", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const list = h.mount("index"); await h.settle(); h.respond(0, []); await h.settle();
    assert.ok(states(list).includes("empty"));
    const q = h.source("src/utils/schedule-query.ts").getMainScheduleRange(new Date("2026-11-07T03:00:00Z"));
    const retry = h.server.retry(q); await h.settle(); h.respond(1, [], 500); await retry; await h.settle();
    assert.ok(states(list).includes("error")); assert.ok(!states(list).includes("empty"));
    assert.match(list.all("ScheduleListState").find((s) => s.state === "error").errorTitle, /이전 정보/);
  } finally { h.close(); }
});
test("선택 월 조회 실패 Retry는 실패 query만 재실행하고 성공 후 날짜 empty 표시", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const cal = h.mount("calendar"); await h.settle(); h.respond(0, []); await h.settle();
    cal.one("MonthCalendar").onSelectDate({ dateString: "2027-03-12" }); h.flush(); await h.settle();
    h.respond(1, [], 500); await h.settle();
    assert.equal(cal.all("ThemedText").some((p) => p.children === "일정 없음"), false);
    cal.all("ScheduleListState").find((s) => s.state === "error").onRetry(); await h.settle();
    assert.equal(h.calls[2].url, h.calls[1].url); h.respond(2, []); await h.settle();
    assert.equal(cal.all("ThemedText").some((p) => p.children === "일정 없음"), true);
    assert.equal(cal.one("MonthCalendar").selectedDate, "2027-03-12");
  } finally { h.close(); }
});

const mockId = "10000000-0000-4000-8000-000000000001";
const notFoundProblem = (code = "SCHEDULE_NOT_FOUND") => ({ type: "test", title: "test", status: 404,
  detail: "test", instance: "/schedules", code, requestId: "test" });
const validationProblem = () => ({ ...notFoundProblem("VALIDATION_ERROR"), status: 422,
  errors: [{ location: "body", pointer: "/completed", code: "INVALID_TYPE", detail: "test" }] });
const saveButton = (screen) => screen.all("Button").find((p) => p.label === "수정 완료");

test("상세 Mock 수정·삭제와 모달/navigation 유지, 서버 요청 0회", async () => {
  for (const kind of ["update", "delete"]) {
    const h = harness("mock"); try {
      const screen = h.mount("detail", mockId); await h.settle();
      if (kind === "update") {
        screen.one("TextInput").onChangeText("수정된 제목"); h.flush(); saveButton(screen).onPress(); h.flush();
        assert.equal(h.mock.getState().schedules.find((s) => s.id === mockId).title, "수정된 제목");
      } else {
        deleteButton(screen).onPress(); h.flush();
        assert.equal(screen.one("ConfirmationModal").visible, true);
        screen.one("ConfirmationModal").onConfirm(); h.flush(); screen.one("ConfirmationModal").onDismiss(); h.flush();
        assert.equal(h.mock.getState().schedules.some((s) => s.id === mockId), false);
      }
      assert.deepEqual(h.navigations, ["back"]); assert.equal(h.calls.length, 0);
    } finally { h.close(); }
  }
});
test("cache 밖 상세 직접 진입·최초 loading·단건 성공은 월 coverage가 아님", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const screen = h.mount("detail", "opaque/id-v5"); await h.settle();
    assert.ok(screen.one("ActivityIndicator")); assert.equal(screen.one("TextInput"), undefined);
    assert.ok(h.calls[0].url.endsWith("/schedules/opaque%2Fid-v5"));
    h.detail(0, dto("opaque/id-v5")); await h.settle(); assert.equal(screen.one("TextInput").value, "opaque/id-v5");
    const cache = Object.values(h.server.store.getState().servers)[0];
    assert.deepEqual(cache.queries, {}); assert.ok(cache.entities["opaque/id-v5"]);
  } finally { h.close(); }
});
test("SCHEDULE_NOT_FOUND와 다른 404·통신/응답 오류를 구분하고 GET-only Retry", async () => {
  for (const code of ["SCHEDULE_NOT_FOUND", "ROUTE_NOT_FOUND", "invalid-response"]) {
    const h = harness("mock"); try {
      h.mode("server"); const screen = h.mount("detail", "target"); await h.settle();
      h.detail(0, code === "invalid-response" ? {} : notFoundProblem(code), code === "invalid-response" ? 500 : 404,
        code === "invalid-response" ? "application/json" : "application/problem+json"); await h.settle();
      const error = screen.all("ScheduleListState").find((p) => p.state === "error");
      assert.equal(error.errorTitle, code === "SCHEDULE_NOT_FOUND" ? "일정을 찾을 수 없어요." : "일정을 불러오지 못했어요.");
      assert.equal(screen.one("TextInput"), undefined); error.onRetry(); await h.settle();
      h.detail(1, dto("target")); await h.settle(); assert.equal(screen.one("TextInput").value, "target");
      assert.ok(h.calls.every((c) => c.method === "GET"));
    } finally { h.close(); }
  }
});
test("상세 재조회 실패와 늦은 성공에도 사용자 입력·dirty-check 보존", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const screen = h.mount("detail", "target"); await h.settle();
    h.detail(0, dto("target")); await h.settle();
    screen.one("TextInput").onChangeText("사용자 입력"); h.flush();
    let retry = h.server.retryDetail("target"); await h.settle(); h.detail(1, {}, 500); await retry; await h.settle();
    assert.equal(screen.one("TextInput").value, "사용자 입력"); assert.ok(states(screen).includes("error"));
    retry = h.server.retryDetail("target"); await h.settle(); h.detail(2, { ...dto("target"), title: "다른 서버 제목" }); await retry; await h.settle();
    assert.equal(screen.one("TextInput").value, "사용자 입력");
    assert.equal(Object.values(h.server.store.getState().servers)[0].entities.target.title, "다른 서버 제목");
  } finally { h.close(); }
});
test("목록 cache를 상세에 재사용하며 단건 결과도 같은 entity를 갱신", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const list = h.mount("index"); await h.settle(); h.respond(0, [dto("target")]); await h.settle();
    const screen = h.mount("detail", "target"); assert.equal(screen.one("TextInput").value, "target"); await h.settle();
    assert.equal(h.calls.length, 2); h.detail(1, { ...dto("target"), title: "최신 제목" }); await h.settle();
    assert.equal(list.one("FlatList").data[0].title, "최신 제목");
    // cache를 표시한 시점에 폼 원본은 이미 고정되어 재조회로 덮어쓰지 않는다.
    assert.equal(screen.one("TextInput").value, "target");
  } finally { h.close(); }
});
test("같은 ID 상세 요청 공유와 마지막 소비자 해제 취소", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const a = h.mount("detail", "target"), b = h.mount("detail", "target"); await h.settle();
    assert.equal(h.calls.length, 1); a.close(); assert.equal(h.calls[0].signal.aborted, false);
    b.close(); assert.equal(h.calls[0].signal.aborted, true);
  } finally { h.close(); }
});
test("상세 route ID 변경 시 데이터·폼 입력과 늦은 응답 분리", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const screen = h.mount("detail", "first"); await h.settle(); h.detail(0, dto("first")); await h.settle();
    screen.one("TextInput").onChangeText("이전 입력"); h.flush();
    const retry = h.server.retryDetail("first"); await h.settle(); screen.route("second"); await h.settle();
    assert.equal(screen.one("TextInput"), undefined); assert.equal(h.calls[1].signal.aborted, true);
    h.detail(2, dto("second")); h.detail(1, dto("first")); await retry; await h.settle();
    assert.equal(screen.one("TextInput").value, "second");
  } finally { h.close(); }
});
test("상세 서버 변경·Mock 복귀 시 이전 응답·입력 차단", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const screen = h.mount("detail", mockId); await h.settle(); h.detail(0, dto(mockId)); await h.settle();
    screen.one("TextInput").onChangeText("다른 서버 입력"); h.flush();
    h.config("https://other.example.invalid"); await h.settle(); assert.equal(screen.one("TextInput"), undefined);
    h.mode("mock"); await h.settle(); assert.equal(h.calls[1].signal.aborted, true);
    h.detail(1, dto(mockId)); await h.settle(); assert.equal(screen.one("TextInput").value, "A구역 재고 실사");
  } finally { h.close(); }
});
test("서버 상세의 Mock 저장·삭제·가짜 성공/navigation은 UI와 handler 양쪽에서 차단", async () => {
  const h = harness("mock", { readOnly: true }); try {
    h.mode("server"); const before = h.mock.getState().schedules; const screen = h.mount("detail", mockId);
    await h.settle(); h.detail(0, dto(mockId)); await h.settle();
    screen.one("TextInput").onChangeText("저장 금지"); h.flush(); assert.equal(saveButton(screen).disabled, true);
    saveButton(screen).onPress();
    assert.equal(deleteButton(screen).disabled, true);
    deleteButton(screen).onPress(); screen.one("ConfirmationModal").onConfirm(); screen.one("ConfirmationModal").onDismiss(); h.flush();
    assert.strictEqual(h.mock.getState().schedules, before); assert.deepEqual(h.navigations, []);
    assert.equal(screen.one("ConfirmationModal").visible, false); assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});
test("늦은 단건 응답이 더 최신 목록 객체를 덮지 않음", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const screen = h.mount("detail", "target"); await h.settle(); const list = h.mount("index"); await h.settle();
    h.respond(1, [{ ...dto("target"), title: "최신" }]); await h.settle(); h.detail(0, { ...dto("target"), title: "과거" }); await h.settle();
    assert.equal(list.one("FlatList").data[0].title, "최신"); assert.equal(screen.one("TextInput").value, "최신");
  } finally { h.close(); }
});
test("mutation 조회 장벽 이후 이전 단건 응답을 반영하지 않음", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const screen = h.mount("detail", "target"); await h.settle(); h.server.invalidate();
    assert.equal(h.calls[0].signal.aborted, true); h.detail(0, dto("target")); await h.settle();
    assert.equal(screen.one("TextInput"), undefined);
    assert.equal(Object.values(h.server.store.getState().servers)[0].entities.target, undefined);
  } finally { h.close(); }
});
test("상세 설정 오류·잘못된 route와 응답 ID 불일치를 성공으로 처리하지 않음", async () => {
  const h = harness("mock"); try {
    h.config(undefined); h.mode("server"); const screen = h.mount("detail", "target"); await h.settle();
    assert.ok(states(screen).includes("error")); assert.equal(h.calls.length, 0);
    h.config("https://example.invalid"); await h.settle(); h.detail(0, dto("wrong")); await h.settle();
    assert.equal(screen.one("TextInput"), undefined); assert.ok(states(screen).includes("error"));
    screen.route(["target", "other"]); await h.settle(); assert.equal(h.calls.length, 1); assert.ok(states(screen).includes("error"));
  } finally { h.close(); }
});

test("상세 네트워크 오류는 404가 아니며 제한된 retry 후 오류 표시", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const screen = h.mount("detail", "target"); await h.settle();
    h.calls[0].reject(new Error("메모리 네트워크 오류")); await h.settle();
    h.calls[1].reject(new Error("메모리 네트워크 오류")); await h.settle();
    assert.equal(h.calls.length, 2); assert.equal(screen.one("TextInput"), undefined);
    assert.equal(screen.all("ScheduleListState").find((p) => p.state === "error").errorTitle, "일정을 불러오지 못했어요.");
    assert.equal(Object.values(h.server.store.getState().servers)[0].details.target.error.kind, "network");
  } finally { h.close(); }
});
test("상세 timeout은 loading을 종료하고 404와 구분", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness("mock"); try {
    h.mode("server"); const screen = h.mount("detail", "target"); await h.settle();
    t.mock.timers.tick(10_000); await h.settle(); t.mock.timers.tick(10_000); await h.settle();
    assert.equal(h.calls.length, 2); assert.equal(states(screen).includes("loading"), false);
    assert.equal(screen.all("ScheduleListState").find((p) => p.state === "error").errorTitle, "일정을 불러오지 못했어요.");
    assert.equal(Object.values(h.server.store.getState().servers)[0].details.target.error.kind, "timeout");
  } finally { h.close(); }
});
test("더 최신 단건 이후 늦은 목록은 공유 객체를 되돌리지 않음", async () => {
  const h = harness("mock"); try {
    h.mode("server"); const list = h.mount("index"); await h.settle(); const screen = h.mount("detail", "target"); await h.settle();
    h.detail(1, { ...dto("target"), title: "최신 단건" }); await h.settle();
    h.respond(0, [{ ...dto("target"), title: "과거 목록" }]); await h.settle();
    assert.equal(list.one("FlatList").data[0].title, "최신 단건"); assert.equal(screen.one("TextInput").value, "최신 단건");
  } finally { h.close(); }
});

test("명시적인 mock 환경변수만 최초 렌더부터 Mock", async () => {
  for (const value of ["mock"]) {
    const h = harness(value); try {
      const list = h.mount("index"); assert.equal(list.one("FlatList").data.length, 10);
      await h.settle(); assert.equal(h.calls.length, 0);
    } finally { h.close(); }
  }
});
test("server 환경변수는 최초 렌더부터 목록·캘린더·상세 GET 사용", async () => {
  const h = harness("server"); try {
    const list = h.mount("index"), calendar = h.mount("calendar"), detail = h.mount("detail", "target");
    assert.deepEqual(list.one("FlatList").data, []); assert.equal(detail.one("TextInput"), undefined);
    assert.deepEqual(calendar.one("MonthCalendar").scheduleDates, []); await h.settle();
    assert.equal(h.calls.length, 3); assert.ok(h.calls.every((c) => c.method === "GET"));
    h.respond(0, [dto("target")]); h.respond(1, [dto("target")]); h.detail(2, dto("target")); await h.settle();
    assert.equal(list.one("FlatList").data.length, 1); assert.equal(detail.one("TextInput").value, "target");
    assert.equal(calendar.all("ScheduleCard")[0].schedule.id, "target");
    const modeCode = fs.readFileSync(path.join(root, "src/stores/scheduleDataModeStore.ts"), "utf8");
    assert.doesNotMatch(modeCode, /__DEV__/); assert.match(modeCode, /process\.env\.EXPO_PUBLIC_SCHEDULE_DATA_MODE/);
  } finally { h.close(); }
});
test("읽기 전용 추가 화면 직접 진입은 저장 버튼·handler·가짜 navigation 차단", async () => {
  const h = harness("server", { readOnly: true }); try {
    const screen = h.mount("create"); const before = h.mock.getState().schedules;
    screen.one("TextInput").onChangeText("차단 검증");
    screen.one("ScheduleCategorySelector").onSelectCategory("재고");
    screen.one("ScheduleDateField").onPress(); h.flush();
    screen.one("DateTimePicker").onValueChange(null, new Date("2026-11-10T03:00:00Z")); h.flush();
    screen.one("ScheduleTimeField").onPress(); h.flush();
    screen.one("DateTimePicker").onValueChange(null, new Date("2026-11-10T03:00:00Z")); h.flush();
    const button = screen.all("Button").find((p) => p.label === "저장"); assert.equal(button.disabled, true);
    button.onPress(); h.flush(); await h.settle();
    assert.strictEqual(h.mock.getState().schedules, before); assert.equal(h.calls.length, 0); assert.deepEqual(h.navigations, []);
    assert.ok(screen.all("ThemedText").some((p) => String(p.children).includes("읽기 전용")));
  } finally { h.close(); }
});
test("Mock 추가 폼은 기존 저장 및 navigation 유지", async () => {
  const h = harness("mock"); try {
    const screen = h.mount("create"); screen.one("TextInput").onChangeText("추가 회귀");
    screen.one("ScheduleCategorySelector").onSelectCategory("재고"); screen.one("ScheduleDateField").onPress(); h.flush();
    screen.one("DateTimePicker").onValueChange(null, new Date("2026-11-10T03:00:00Z")); h.flush();
    screen.one("ScheduleTimeField").onPress(); h.flush();
    screen.one("DateTimePicker").onValueChange(null, new Date("2026-11-10T03:00:00Z")); h.flush();
    const button = screen.all("Button").find((p) => p.label === "저장"); assert.equal(button.disabled, false);
    button.onPress(); h.flush(); await h.settle();
    assert.equal(h.mock.getState().schedules.length, 11); assert.deepEqual(h.navigations, ["back"]); assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});
test("읽기 전용 Schedule 서비스 직접 POST·PATCH·DELETE는 미전송으로 차단", async () => {
  const h = harness("server", { readOnly: true }); try {
    const service = h.source("src/services/api/schedules.ts");
    const operations = [
      service.prepareScheduleCreation({ title: "검증", category: "INVENTORY", scheduledAt: "2026-11-10T03:00:00Z" }),
      service.prepareScheduleUpdate("target", { title: "검증" }),
      service.prepareScheduleUpdate("target", { completed: true }),
      service.prepareScheduleDeletion("target"),
    ];
    for (const prepared of operations) {
      assert.equal(prepared.ok, true); const result = await prepared.operation.submit();
      assert.equal(result.outcome, "not-sent"); assert.equal(result.attempts, 0);
      assert.equal(result.requiresReconciliation, false); assert.equal(result.error.policyReason, "read-only");
    }
    assert.equal(h.calls.length, 0);
    const http = h.source("src/services/api/http.ts").scheduleHttpClient;
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const result = await http.request({ method, path: "/system/time-sync" });
      assert.equal(result.error.policyReason, "read-only");
    }
    assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});
test("쓰기 첫 시도 후 Mock 모드로 변경되면 자동 retry 차단 및 불확실 결과 보존", async () => {
  const h = harness("server"); try {
    const prepared = h.source("src/services/api/schedules.ts").prepareScheduleUpdate("target", { title: "검증" });
    const pending = prepared.operation.submit(); await h.settle(); assert.equal(h.calls.length, 1);
    h.mode("mock"); h.calls[0].reject(new Error("메모리 네트워크 오류")); await pending;
    const result = await pending; assert.equal(result.outcome, "uncertain"); assert.equal(result.requiresReconciliation, true);
    assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});

function fillCreation(h, screen, title = "새 일정") {
  screen.one("TextInput").onChangeText(title);
  screen.one("ScheduleCategorySelector").onSelectCategory("재고");
  screen.one("ScheduleDateField").onPress(); h.flush();
  screen.one("DateTimePicker").onValueChange(null, new Date(2026, 10, 10, 12, 30)); h.flush();
  screen.one("ScheduleTimeField").onPress(); h.flush();
  screen.one("DateTimePicker").onValueChange(null, new Date(2026, 10, 10, 12, 30)); h.flush();
}
const createButton = (screen) => screen.all("Button").find((p) => p.label === "저장");
const formText = (screen) => screen.all("ThemedText").map((p) => p.children).filter((s) => typeof s === "string").join(" ");

test("생성 폼 POST DTO·key·중복 제출 방지·성공 후 현재 목록 GET과 navigation", async () => {
  const h = harness("server"); try {
    const list = h.mount("index"); await h.settle(); h.respond(0, []); await h.settle();
    const screen = h.mount("create"); fillCreation(h, screen, " 새 일정 ");
    const before = h.mock.getState().schedules;
    const first = createButton(screen).onPress(); createButton(screen).onPress(); await h.settle();
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].method, "POST");
    assert.deepEqual(JSON.parse(h.calls[1].body), { title: "새 일정", scheduledAt: "2026-11-10T12:30:00+09:00", category: "INVENTORY" });
    assert.match(h.calls[1].headers.get("Idempotency-Key"), /^[0-9a-f-]{36}$/);
    assert.deepEqual(h.navigations, []); h.detail(1, dto("created"), 201); await h.settle();
    assert.equal(h.calls[2].method, "GET"); assert.equal(h.calls[2].url, h.calls[0].url);
    h.respond(2, [dto("created")]); await first; await h.settle();
    assert.deepEqual(h.navigations, ["back"]); assert.equal(list.one("FlatList").data[0].id, "created");
    assert.strictEqual(h.mock.getState().schedules, before);
  } finally { h.close(); }
});
test("생성 성공 후 GET 실패는 POST 재실행 없이 실패 GET만 retry", async () => {
  const h = harness("server"); try {
    h.mount("index"); await h.settle(); h.respond(0, []); await h.settle();
    const screen = h.mount("create"); fillCreation(h, screen); const pending = createButton(screen).onPress(); await h.settle();
    h.detail(1, dto("created"), 201); await h.settle(); h.respond(2, [], 500); await pending; await h.settle();
    assert.match(formText(screen), /저장되었지만/); assert.equal(createButton(screen).disabled, true);
    createButton(screen).onPress(); await h.settle(); assert.equal(h.calls.length, 3);
    const retry = screen.all("Button").find((p) => p.label === "목록 다시 불러오기").onPress(); await h.settle();
    assert.equal(h.calls[3].method, "GET"); h.respond(3, [dto("created")]); await retry; await h.settle();
    assert.equal(h.calls.filter((c) => c.method === "POST").length, 1); assert.deepEqual(h.navigations, ["back"]);
  } finally { h.close(); }
});
test("생성 503 자동 retry·불확실 후 수동 retry는 같은 key/body 유지", async () => {
  const h = harness("server"); try {
    const screen = h.mount("create"); fillCreation(h, screen); const pending = createButton(screen).onPress(); await h.settle();
    const failure = { type: "test", title: "test", detail: "test", instance: "/schedules", requestId: "r", status: 503, code: "DATABASE_UNAVAILABLE" };
    h.detail(0, failure, 503, "application/problem+json"); await h.settle();
    h.detail(1, failure, 503, "application/problem+json"); await pending; await h.settle();
    assert.match(formText(screen), /등록 결과/); assert.equal(screen.one("TextInput").value, "새 일정");
    const retry = createButton(screen).onPress(); await h.settle();
    for (const call of h.calls) { assert.equal(call.body, h.calls[0].body); assert.equal(call.headers.get("Idempotency-Key"), h.calls[0].headers.get("Idempotency-Key")); }
    h.detail(2, dto("created"), 201); await h.settle(); h.respond(3, [dto("created")]); await retry; await h.settle();
    assert.deepEqual(h.navigations, ["back"]);
  } finally { h.close(); }
});
test("불확실 작업의 입력 변경은 새 key 생성·재등록을 하지 않음", async () => {
  const h = harness("server"); try {
    const screen = h.mount("create"); fillCreation(h, screen); const pending = createButton(screen).onPress(); await h.settle();
    h.calls[0].reject(new Error("메모리 연결 오류")); await h.settle(); h.calls[1].reject(new Error("메모리 연결 오류")); await pending; await h.settle();
    screen.one("TextInput").onChangeText("다른 입력"); h.flush(); await createButton(screen).onPress(); await h.settle();
    assert.equal(h.calls.length, 2); assert.match(formText(screen), /이전 등록 결과/); assert.deepEqual(h.navigations, []);
  } finally { h.close(); }
});
test("과거 일정·validation·멱등성 충돌은 code로 안내하고 입력/key 보존", async () => {
  for (const [status, code, message] of [[422, "SCHEDULE_IN_THE_PAST", /과거 시각/], [422, "VALIDATION_ERROR", /입력값/], [409, "IDEMPOTENCY_KEY_CONFLICT", /충돌/]]) {
    const h = harness("server"); try {
      const screen = h.mount("create"); fillCreation(h, screen); const pending = createButton(screen).onPress(); await h.settle();
      h.detail(0, { type: "test", title: "test", detail: "변경 가능한 상세", instance: "/schedules", requestId: "r", status, code,
        ...(code === "VALIDATION_ERROR" ? { errors: [{ location: "body", pointer: "/title", code: "TOO_LONG", detail: "test" }] } : {}) }, status, "application/problem+json");
      await pending; await h.settle(); assert.match(formText(screen), message); assert.equal(screen.one("TextInput").value, "새 일정");
      await createButton(screen).onPress(); await h.settle(); assert.equal(h.calls.length, 1);
      assert.deepEqual(h.navigations, []); assert.equal(h.mock.getState().schedules.length, 10);
    } finally { h.close(); }
  }
});
test("서버 폼 제목 검증·불완전 입력은 전송 없이 값을 유지", async () => {
  const h = harness("server"); try {
    const screen = h.mount("create"); await createButton(screen).onPress(); h.flush(); assert.equal(h.calls.length, 0);
    fillCreation(h, screen, "가".repeat(101)); await createButton(screen).onPress(); h.flush();
    assert.equal(h.calls.length, 0); assert.match(formText(screen), /1~100/); assert.equal(screen.one("TextInput").value.length, 101);
  } finally { h.close(); }
});

test("확정 거절 후 변경된 새 논리 입력은 새 key 사용하고 replay 성공도 동기화", async () => {
  const h = harness("server"); try {
    const screen = h.mount("create"); fillCreation(h, screen); let pending = createButton(screen).onPress(); await h.settle();
    h.detail(0, { type: "test", title: "test", detail: "test", instance: "/schedules", requestId: "r", status: 400, code: "MALFORMED_REQUEST" },
      400, "application/problem+json"); await pending; await h.settle();
    screen.one("TextInput").onChangeText("새 논리 작업"); h.flush(); pending = createButton(screen).onPress(); await h.settle();
    assert.notEqual(h.calls[0].headers.get("Idempotency-Key"), h.calls[1].headers.get("Idempotency-Key"));
    assert.equal(JSON.parse(h.calls[1].body).title, "새 논리 작업");
    h.detail(1, dto("replayed"), 201, "application/json", { "Idempotent-Replayed": "true" }); await h.settle();
    h.respond(2, [dto("replayed")]); await pending; await h.settle(); assert.deepEqual(h.navigations, ["back"]);
  } finally { h.close(); }
});
test("생성 timeout 뒤에도 입력과 원래 key를 유지하며 가짜 성공 없음", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness("server"); try {
    const screen = h.mount("create"); fillCreation(h, screen); const pending = createButton(screen).onPress(); await h.settle();
    t.mock.timers.tick(10_000); await h.settle(); t.mock.timers.tick(10_000); await pending; await h.settle();
    assert.match(formText(screen), /등록 결과/); assert.equal(screen.one("TextInput").value, "새 일정");
    assert.equal(h.calls[0].body, h.calls[1].body); assert.equal(h.calls[0].headers.get("Idempotency-Key"), h.calls[1].headers.get("Idempotency-Key"));
    assert.deepEqual(h.navigations, []); assert.equal(h.mock.getState().schedules.length, 10);
  } finally { h.close(); }
});
test("생성 중 모드 변경은 요청 대기를 취소하고 가짜 navigation을 하지 않음", async () => {
  const h = harness("server"); try {
    const screen = h.mount("create"); fillCreation(h, screen); const pending = createButton(screen).onPress(); await h.settle();
    h.mode("mock"); await pending; await h.settle(); assert.equal(h.calls[0].signal.aborted, true);
    assert.deepEqual(h.navigations, []); assert.equal(h.mock.getState().schedules.length, 10);
  } finally { h.close(); }
});

test("명시적 읽기 전용 옵션은 저장 버튼 및 직접 handler 차단", async () => {
  for (const readOnly of [true, "true"]) {
    const h = harness("server", { readOnly }); try {
      const screen = h.mount("create"); fillCreation(h, screen);
      assert.equal(createButton(screen).disabled, true); await createButton(screen).onPress(); await h.settle();
      assert.equal(h.calls.length, 0); assert.deepEqual(h.navigations, []);
    } finally { h.close(); }
  }
});
test("일반 CRUD에서도 Schedule 외 POST와 잘못된 생성 경로는 차단", async () => {
  const h = harness("server"); try {
    const screen = h.mount("create"); fillCreation(h, screen); assert.equal(createButton(screen).disabled, false);
    const http = h.source("src/services/api/http.ts").scheduleHttpClient;
    for (const [method, path] of [
      ["POST", "/system/time-sync"], ["POST", "/assistant/requests"],
      ["POST", "/schedules/target"], ["POST", "/schedules/"], ["POST", "/schedules-extra"],
      ["POST", "/other/schedules"], ["POST", "/api/v1/schedules"], ["POST", "/%73chedules"],
      ["POST", "/schedules?other=1"], ["POST", "/schedules#fragment"],
      ["POST", "/other/../schedules"], ["POST", "//schedules"],
    ]) {
      const result = await http.request({ method, path });
      assert.equal(result.ok, false); assert.equal(result.attempts, 0); assert.equal(result.error.policyReason, "read-only");
    }
    assert.equal(h.calls.length, 0);
    const policy = fs.readFileSync(path.join(root, "src/stores/scheduleDataModeStore.ts"), "utf8");
    assert.match(policy, /process\.env\.EXPO_PUBLIC_SCHEDULE_READ_ONLY/); assert.doesNotMatch(policy, /__DEV__/);
  } finally { h.close(); }
});
test("Mock 모드에서는 읽기 전용 옵션과 무관하게 로컬 CRUD를 유지하고 HTTP 쓰기는 차단", async () => {
  const h = harness("mock", { readOnly: true }); try {
    const policy = h.source("src/stores/scheduleDataModeStore.ts");
    assert.equal(policy.isScheduleRequestAllowed("PATCH", "/schedules/target"), false);
    const screen = h.mount("create"); fillCreation(h, screen); await createButton(screen).onPress(); h.flush();
    const added = h.mock.getState().schedules.at(-1);
    h.mock.getState().updateSchedule(added.id, { title: "수정" }); h.mock.getState().toggleCompleted(added.id);
    assert.equal(h.mock.getState().schedules.at(-1).completed, true);
    h.mock.getState().deleteSchedule(added.id); assert.equal(h.mock.getState().schedules.length, 10);
    assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});
test("일반 CRUD의 최초 201·메모리 replay 전송·409 메타데이터를 검사할 수 있음", async () => {
  const h = harness("server"); try {
    const service = h.source("src/services/api/schedules.ts");
    const op = service.prepareScheduleCreation({ title: "검증용 입력", scheduledAt: "2026-11-10T03:00:00Z", category: "INVENTORY" }).operation;
    assert.match(op.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const first = op.submit(); await h.settle();
    assert.equal(h.calls[0].redirect, "error"); h.detail(0, dto("created"), 201, "application/json", { "Location": "/api/v1/schedules/created" });
    const initial = await first; assert.equal(initial.response.status, 201); assert.equal(initial.response.location, "/api/v1/schedules/created");
    assert.equal(initial.response.idempotentReplayed, null);
    // submit의 성공 캐시는 HTTP replay 검증과 다르다. 새 전송 없이 같은 결과를 반환한다.
    await op.submit(); assert.equal(h.calls.length, 1);
    const client = h.source("src/services/api/http.ts").scheduleHttpClient;
    const replay = client.request({ method: "POST", path: "/schedules", headers: { "Idempotency-Key": op.idempotencyKey }, body: op.payload });
    await h.settle(); assert.equal(h.calls[1].body, h.calls[0].body);
    h.detail(1, dto("created"), 201, "application/json", { "Idempotent-Replayed": "true" });
    const replayed = await replay; assert.equal(replayed.status, 201); assert.equal(replayed.idempotentReplayed, "true");
    assert.equal(replayed.data.id, initial.response.data.id);
    const conflict = client.request({ method: "POST", path: "/schedules", headers: { "Idempotency-Key": op.idempotencyKey }, body: { ...op.payload, title: "다른 검증용 입력" } });
    await h.settle(); h.detail(2, { type: "test", title: "test", detail: "test", instance: "/schedules", requestId: "r", status: 409,
      code: "IDEMPOTENCY_KEY_CONFLICT" }, 409, "application/problem+json");
    const rejected = await conflict; assert.equal(rejected.error.status, 409); assert.equal(rejected.error.problem.code, "IDEMPOTENCY_KEY_CONFLICT");
    assert.equal(h.calls.length, 3);
  } finally { h.close(); }
});
test("읽기 전용 모드의 수정·삭제·완료 차단과 서버 Assistant Mock 차단 유지", async () => {
  const h = harness("server", { readOnly: true }); try {
    const screen = h.mount("detail", "target"); await h.settle(); h.detail(0, dto("target")); await h.settle();
    assert.equal(saveButton(screen).disabled, true); assert.equal(deleteButton(screen).disabled, true);
    const before = h.mock.getState().schedules;
    h.source("src/services/mock/assistant.ts").runMockAssistantScenario("내일 오후 3시 팀 회의 추가해 줘");
    assert.strictEqual(h.mock.getState().schedules, before);
    const list = h.mount("index"); await h.settle(); h.respond(1, [dto("target")]); await h.settle();
    assert.equal(list.one("FlatList").renderItem({ item: list.one("FlatList").data[0] }).props.completionDisabled, true);
  } finally { h.close(); }
});

async function editableDetail(h, id = "target") {
  const screen = h.mount("detail", id); await h.settle();
  h.detail(h.calls.length - 1, dto(id)); await h.settle(); return screen;
}
function editTitle(h, screen, title = "수정 입력") { screen.one("TextInput").onChangeText(title); h.flush(); }

test("PATCH 제목만 전송·중복 저장 방지·동일 ID와 공유 entity 및 목록/캘린더 동기화", async () => {
  const h = harness("server"); try {
    const list = h.mount("index"), calendar = h.mount("calendar"); await h.settle();
    h.respond(0, [dto("target")]); h.respond(1, [dto("target")]); await h.settle();
    const screen = await editableDetail(h); editTitle(h, screen);
    saveButton(screen).onPress(); saveButton(screen).onPress(); await h.settle();
    assert.equal(h.calls.length, 4); assert.equal(h.calls[3].method, "PATCH");
    assert.deepEqual(JSON.parse(h.calls[3].body), { title: "수정 입력" }); assert.equal(h.calls[3].headers.has("Idempotency-Key"), false);
    assert.deepEqual(h.navigations, []);
    const updated = { ...dto("target"), title: "수정 입력" }; h.detail(3, updated); await h.settle();
    assert.equal(list.one("FlatList").data[0].title, "수정 입력"); assert.equal(calendar.all("ScheduleCard")[0].schedule.title, "수정 입력");
    assert.equal(h.calls.length, 6); h.respond(4, [updated]); h.respond(5, [updated]); await h.settle();
    assert.deepEqual(h.navigations, ["back"]); assert.equal(h.calls.filter((c) => c.method === "PATCH").length, 1);
  } finally { h.close(); }
});
test("변경 없음 PATCH 금지·카테고리만 변경하면 scheduledAt 제외", async () => {
  const h = harness("server"); try {
    const screen = await editableDetail(h); assert.equal(saveButton(screen).disabled, true);
    saveButton(screen).onPress(); await h.settle(); assert.equal(h.calls.length, 1);
    screen.one("ScheduleCategorySelector").onSelectCategory("출고"); h.flush(); saveButton(screen).onPress(); await h.settle();
    assert.deepEqual(JSON.parse(h.calls[1].body), { category: "OUTBOUND" });
    h.detail(1, { ...dto("target"), category: "OUTBOUND" }); await h.settle(); h.respond(2, []); await h.settle();
  } finally { h.close(); }
});
test("날짜·시간 변경 시 mapper로 scheduledAt만 직렬화", async () => {
  const h = harness("server"); try {
    const screen = await editableDetail(h);
    screen.one("ScheduleDateField").onPress(); h.flush();
    screen.one("DateTimePicker").onValueChange(null, new Date(2026, 10, 20, 15, 40)); h.flush();
    screen.one("ScheduleTimeField").onPress(); h.flush();
    screen.one("DateTimePicker").onValueChange(null, new Date(2026, 10, 20, 15, 40)); h.flush();
    saveButton(screen).onPress(); await h.settle(); assert.deepEqual(JSON.parse(h.calls[1].body), { scheduledAt: "2026-11-20T15:40:00+09:00" });
  } finally { h.close(); }
});
test("PATCH 성공 후 GET 실패는 성공 유지·GET만 재시도", async () => {
  const h = harness("server"); try {
    const screen = await editableDetail(h); editTitle(h, screen); saveButton(screen).onPress(); await h.settle();
    h.detail(1, { ...dto("target"), title: "수정 입력" }); await h.settle(); h.respond(2, [], 500); await h.settle();
    assert.match(formText(screen), /수정되었지만/); assert.equal(saveButton(screen).disabled, true);
    saveButton(screen).onPress(); await h.settle(); assert.equal(h.calls.length, 3);
    screen.all("Button").find((p) => p.label === "서버 상태 다시 불러오기").onPress(); await h.settle();
    assert.equal(h.calls[3].method, "GET"); h.respond(3, [dto("target")]); await h.settle();
    assert.deepEqual(h.navigations, ["back"]); assert.equal(h.calls.filter((c) => c.method === "PATCH").length, 1);
  } finally { h.close(); }
});
test("PATCH 확정 404·422 오류는 입력과 원래 공유 데이터를 보존", async () => {
  for (const [status, code, message] of [[404, "SCHEDULE_NOT_FOUND", /수정할 일정/], [422, "SCHEDULE_IN_THE_PAST", /과거 시각/],
    [422, "VALIDATION_ERROR", /입력값/]]) {
    const h = harness("server"); try {
      const screen = await editableDetail(h); editTitle(h, screen); saveButton(screen).onPress(); await h.settle();
      h.detail(1, { type: "test", title: "test", detail: "변경 가능한 상세", instance: "/schedules", requestId: "r", status, code,
        ...(code === "VALIDATION_ERROR" ? { errors: [{ location: "body", pointer: "/title", code: "TOO_LONG", detail: "test" }] } : {}) }, status, "application/problem+json");
      await h.settle(); assert.match(formText(screen), message); assert.equal(screen.one("TextInput").value, "수정 입력");
      assert.equal(Object.values(h.server.store.getState().servers)[0].entities.target.title, "target"); assert.deepEqual(h.navigations, []);
    } finally { h.close(); }
  }
});
test("PATCH 불확실 결과는 재저장 차단·고정 body 제한 retry·단건 GET 확인", async () => {
  const h = harness("server"); try {
    const screen = await editableDetail(h); editTitle(h, screen); saveButton(screen).onPress(); await h.settle();
    h.calls[1].reject(new Error("메모리 네트워크 오류")); await h.settle(); h.calls[2].reject(new Error("메모리 네트워크 오류")); await h.settle();
    assert.equal(h.calls[1].body, h.calls[2].body); assert.equal(h.calls[1].url, h.calls[2].url);
    assert.match(formText(screen), /수정 결과/); assert.equal(screen.one("TextInput").value, "수정 입력");
    saveButton(screen).onPress(); await h.settle(); assert.equal(h.calls.length, 3);
    screen.all("Button").find((p) => p.label === "서버 상태 다시 불러오기").onPress(); await h.settle();
    assert.equal(h.calls[3].method, "GET"); h.detail(3, dto("target")); await h.settle();
    assert.equal(screen.one("TextInput").value, "수정 입력"); assert.equal(h.calls.filter((c) => c.method === "PATCH").length, 2);
    assert.deepEqual(h.navigations, []);
  } finally { h.close(); }
});
test("PATCH 응답의 ID 불일치는 cache 반영·성공 navigation 금지", async () => {
  const h = harness("server"); try {
    const screen = await editableDetail(h); editTitle(h, screen); saveButton(screen).onPress(); await h.settle();
    h.detail(1, dto("wrong")); await h.settle(); assert.match(formText(screen), /ID가 일치하지/);
    assert.equal(Object.values(h.server.store.getState().servers)[0].entities.wrong, undefined); assert.deepEqual(h.navigations, []);
  } finally { h.close(); }
});
test("수정 중 GET 재조회는 입력·dirty-check 원본을 바꾸지 않음", async () => {
  const h = harness("server"); try {
    const screen = await editableDetail(h); editTitle(h, screen); const refresh = h.server.retryDetail("target"); await h.settle();
    h.detail(1, { ...dto("target"), title: "서버 새 제목" }); await refresh; await h.settle();
    assert.equal(screen.one("TextInput").value, "수정 입력"); saveButton(screen).onPress(); await h.settle();
    assert.deepEqual(JSON.parse(h.calls[2].body), { title: "수정 입력" });
  } finally { h.close(); }
});
test("PATCH 중 route ID·모드·서버 변경·unmount는 이전 응답과 navigation 차단", async () => {
  for (const change of ["route", "mode", "server", "unmount"]) {
    const h = harness("server"); try {
      const screen = await editableDetail(h); editTitle(h, screen); saveButton(screen).onPress(); await h.settle();
      if (change === "route") screen.route("other");
      if (change === "mode") h.mode("mock");
      if (change === "server") h.config("https://other.example.invalid");
      if (change === "unmount") screen.close();
      await h.settle(); assert.equal(h.calls[1].signal.aborted, true);
      h.detail(1, { ...dto("target"), title: "늦은 수정" }); await h.settle(); assert.deepEqual(h.navigations, []);
      if (change === "route" || change === "server") { h.detail(2, dto(change === "route" ? "other" : "target")); await h.settle(); }
    } finally { h.close(); }
  }
});
test("PATCH 이전 GET의 늦은 응답은 성공한 공유 객체를 덮지 않음", async () => {
  const h = harness("server"); try {
    const screen = await editableDetail(h); const list = h.mount("index"); await h.settle();
    h.respond(1, [dto("target")]); await h.settle();
    const old = h.server.retry(h.source("src/utils/schedule-query.ts").getMainScheduleRange(new Date("2026-11-07T03:00:00Z"))); await h.settle();
    editTitle(h, screen); saveButton(screen).onPress(); await h.settle(); assert.equal(h.calls[2].signal.aborted, true);
    const updated = { ...dto("target"), title: "수정 입력" }; h.detail(3, updated); await h.settle();
    h.respond(2, [{ ...dto("target"), title: "오래된 값" }]); await old; await h.settle();
    assert.equal(list.one("FlatList").data[0].title, "수정 입력"); h.respond(4, [updated]); await h.settle();
    assert.equal(list.one("FlatList").data[0].title, "수정 입력");
  } finally { h.close(); }
});

test("PATCH 결과 확인 GET이 404여도 입력을 보존하고 조회 성공으로 안내하지 않음", async () => {
  const h = harness("server"); try {
    const screen = await editableDetail(h); editTitle(h, screen); saveButton(screen).onPress(); await h.settle();
    h.calls[1].reject(new Error("메모리 네트워크 오류")); await h.settle(); h.calls[2].reject(new Error("메모리 네트워크 오류")); await h.settle();
    screen.all("Button").find((p) => p.label === "서버 상태 다시 불러오기").onPress(); await h.settle();
    h.detail(3, notFoundProblem(), 404, "application/problem+json"); await h.settle();
    assert.equal(screen.one("TextInput").value, "수정 입력"); assert.match(formText(screen), /서버 상태를 확인하지 못했/);
    assert.equal(saveButton(screen).disabled, true); assert.deepEqual(h.navigations, []);
  } finally { h.close(); }
});
test("PATCH timeout은 결과 불확실·입력 유지·새 PATCH 차단", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness("server"); try {
    const screen = await editableDetail(h); editTitle(h, screen); saveButton(screen).onPress(); await h.settle();
    t.mock.timers.tick(10_000); await h.settle(); t.mock.timers.tick(10_000); await h.settle();
    assert.match(formText(screen), /수정 결과/); assert.equal(screen.one("TextInput").value, "수정 입력");
    saveButton(screen).onPress(); await h.settle(); assert.equal(h.calls.length, 3); assert.deepEqual(h.navigations, []);
  } finally { h.close(); }
});

const listCard = (screen, index = 0) => screen.one("FlatList").renderItem({ item: screen.one("FlatList").data[index] }).props;
const completionNotice = (screen) => screen.all("ScheduleListState").find((p) => /완료|변경할 일정|서버의 현재 상태|목록을 갱신/.test(p.errorTitle ?? ""));
const patches = (h) => h.calls.filter((c) => c.method === "PATCH");
async function completionScreens(h, items = [dto("target")]) {
  const list = h.mount("index"), calendar = h.mount("calendar"); await h.settle();
  h.respond(0, items); h.respond(1, items); await h.settle();
  return { list, calendar };
}
async function respondLists(h, start, items, status = 200) {
  for (let i = start; i < h.calls.length; i++) if (h.calls[i].method === "GET") h.respond(i, items, status);
  await h.settle();
}

test("H Mock 완료 true/false는 두 화면에 반영되며 HTTP 요청 0회", async () => {
  const h = harness("mock"); try {
    const list = h.mount("index"), calendar = h.mount("calendar");
    const original = listCard(list).schedule;
    listCard(list).onToggleCompleted(); h.flush();
    assert.equal(h.mock.getState().schedules.find((s) => s.id === original.id).completed, !original.completed);
    listCard(list).onToggleCompleted(); h.flush();
    assert.equal(listCard(list).schedule.completed, original.completed);
    calendar.all("ScheduleCard")[0]?.onToggleCompleted(); h.flush();
    assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});

test("H completed만 true/false PATCH·key 없음·낙관적 공유 표시·현재 목록과 월 재조회", async () => {
  const h = harness("server"); try {
    const { list, calendar } = await completionScreens(h); const before = h.mock.getState().schedules;
    for (const target of [true, false]) {
      const start = h.calls.length;
      listCard(list).onToggleCompleted(); h.flush();
      assert.equal(listCard(list).schedule.completed, target);
      assert.equal(calendar.all("ScheduleCard")[0].schedule.completed, target);
      assert.equal(listCard(list).completionDisabled, true);
      await h.settle(); assert.deepEqual(JSON.parse(h.calls[start].body), { completed: target });
      assert.equal(h.calls[start].headers.has("Idempotency-Key"), false);
      h.detail(start, dto("target", "INVENTORY", target)); await h.settle();
      assert.equal(Object.values(h.server.store.getState().servers)[0].entities.target.completed, target);
      assert.equal(h.calls.length, start + 3);
      assert.deepEqual(h.calls.slice(start + 1).map((c) => new URL(c.url).search), h.calls.slice(0, 2).map((c) => new URL(c.url).search));
      await respondLists(h, start + 1, [dto("target", "INVENTORY", target)]);
      assert.equal(listCard(list).completionDisabled, false);
    }
    assert.equal(patches(h).length, 2); assert.strictEqual(h.mock.getState().schedules, before);
  } finally { h.close(); }
});

test("H 두 화면의 빠른 연속 입력은 동일 일정 PATCH 1회, 다른 일정은 독립 처리", async () => {
  const h = harness("server"); try {
    const { list, calendar } = await completionScreens(h, [dto("target"), dto("other")]);
    const stale = listCard(list).onToggleCompleted;
    stale(); stale(); calendar.all("ScheduleCard")[0].onToggleCompleted(); h.flush();
    listCard(list, 1).onToggleCompleted(); await h.settle();
    assert.equal(patches(h).length, 2); assert.notEqual(patches(h)[0].url, patches(h)[1].url);
    h.detail(2, dto("target", "INVENTORY", true)); h.detail(3, dto("other", "INVENTORY", true)); await h.settle();
    await respondLists(h, 4, [dto("target", "INVENTORY", true), dto("other", "INVENTORY", true)]);
    assert.ok(list.one("FlatList").data.every((s) => s.completed));
  } finally { h.close(); }
});

test("H 확정 404·422는 completed rollback과 안내, 재시도 버튼은 GET만 실행", async () => {
  for (const [status, code] of [[404, "SCHEDULE_NOT_FOUND"], [422, "VALIDATION_ERROR"]]) {
    const h = harness("server"); try {
      const { list, calendar } = await completionScreens(h);
      listCard(list).onToggleCompleted(); await h.settle();
      h.detail(2, status === 422 ? validationProblem() : { ...notFoundProblem(), status, code }, status, "application/problem+json"); await h.settle();
      assert.equal(listCard(list).schedule.completed, false); assert.equal(calendar.all("ScheduleCard")[0].schedule.completed, false);
      assert.ok(completionNotice(list)); completionNotice(list).onRetry(); await h.settle();
      assert.ok(h.calls.slice(3).every((c) => c.method === "GET")); await respondLists(h, 3, [dto("target")]);
      assert.equal(patches(h).length, 1);
    } finally { h.close(); }
  }
});

test("H 네트워크 결과 불확실은 두 화면 잠금·GET 확인 후 현재값 표시", async () => {
  const h = harness("server"); try {
    const { list, calendar } = await completionScreens(h);
    listCard(list).onToggleCompleted(); await h.settle();
    h.calls[2].reject(new Error("memory")); await h.settle(); h.calls[3].reject(new Error("memory")); await h.settle();
    assert.equal(h.calls[2].body, h.calls[3].body); assert.equal(listCard(list).completionDisabled, true);
    assert.equal(calendar.all("ScheduleCard")[0].completionDisabled, true);
    assert.match(completionNotice(list).errorTitle, /확인/);
    listCard(list).onToggleCompleted(); calendar.all("ScheduleCard")[0].onToggleCompleted(); await h.settle();
    assert.equal(patches(h).length, 2);
    completionNotice(list).onRetry(); completionNotice(calendar).onRetry(); await h.settle();
    assert.equal(h.calls.length, 5); assert.equal(h.calls[4].method, "GET");
    h.detail(4, dto("target", "INVENTORY", true)); await h.settle();
    await respondLists(h, 5, [dto("target", "INVENTORY", true)]);
    assert.equal(listCard(list).schedule.completed, true); assert.equal(listCard(list).completionDisabled, false);
    assert.match(completionNotice(list).errorTitle, /이전 PATCH의 성공 여부를 뜻하지/); assert.equal(patches(h).length, 2);
  } finally { h.close(); }
});

test("H timeout 불확실 뒤 GET 실패는 원래 잠금과 안내 유지", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness("server"); try {
    const { list } = await completionScreens(h);
    listCard(list).onToggleCompleted(); await h.settle();
    t.mock.timers.tick(10_000); await h.settle(); t.mock.timers.tick(10_000); await h.settle();
    assert.equal(patches(h).length, 2); assert.equal(listCard(list).completionDisabled, true);
    assert.match(completionNotice(list).errorTitle, /결과를 확인/);
    completionNotice(list).onRetry(); await h.settle(); h.respond(4, [], 500); await h.settle();
    assert.equal(listCard(list).completionDisabled, true); listCard(list).onToggleCompleted(); await h.settle();
    assert.equal(patches(h).length, 2);
  } finally { h.close(); }
});

test("H 응답 ID 불일치는 불확실 처리하며 다른 entity 삽입 금지", async () => {
  const h = harness("server"); try {
    const { list } = await completionScreens(h); listCard(list).onToggleCompleted(); await h.settle();
    h.detail(2, dto("wrong", "INVENTORY", true)); await h.settle();
    const cache = Object.values(h.server.store.getState().servers)[0];
    assert.equal(cache.entities.wrong, undefined); assert.equal(cache.entities.target.completed, false);
    assert.equal(listCard(list).completionDisabled, true); assert.match(completionNotice(list).errorTitle, /결과를 확인/);
  } finally { h.close(); }
});

test("H PATCH 성공 후 목록 GET 실패는 성공 유지하고 GET-only 재시도", async () => {
  const h = harness("server"); try {
    const { list, calendar } = await completionScreens(h);
    listCard(list).onToggleCompleted(); await h.settle(); h.detail(2, dto("target", "INVENTORY", true)); await h.settle();
    h.respond(3, [], 500); h.respond(4, [dto("target", "INVENTORY", true)]); await h.settle();
    assert.equal(listCard(list).schedule.completed, true); assert.match(completionNotice(list).errorTitle, /변경되었지만/);
    listCard(list).onToggleCompleted(); completionNotice(calendar).onRetry(); await h.settle();
    assert.equal(h.calls.length, 6); assert.equal(h.calls[5].url, h.calls[3].url); assert.equal(h.calls[5].method, "GET");
    h.respond(5, [dto("target", "INVENTORY", true)]); await h.settle(); assert.equal(patches(h).length, 1);
  } finally { h.close(); }
});

test("H 일반 수정과 완료 토글은 양방향으로 공유 잠금 적용", async () => {
  for (const first of ["edit", "completion"]) {
    const h = harness("server"); try {
      const { list } = await completionScreens(h); const screen = await editableDetail(h); editTitle(h, screen);
      if (first === "edit") { saveButton(screen).onPress(); h.flush(); listCard(list).onToggleCompleted(); }
      else { listCard(list).onToggleCompleted(); h.flush(); saveButton(screen).onPress(); }
      await h.settle(); assert.equal(patches(h).length, 1);
      assert.deepEqual(JSON.parse(patches(h)[0].body), first === "edit" ? { title: "수정 입력" } : { completed: true });
      assert.equal(listCard(list).completionDisabled, true); assert.equal(saveButton(screen).disabled, true);
    } finally { h.close(); }
  }
});

test("H 불확실 일반 수정·완료 변경은 화면 재진입 후에도 상대 PATCH 차단", async () => {
  for (const first of ["edit", "completion"]) {
    const h = harness("server"); try {
      const { list } = await completionScreens(h); const screen = await editableDetail(h); editTitle(h, screen);
      if (first === "edit") saveButton(screen).onPress(); else listCard(list).onToggleCompleted(); await h.settle();
      h.calls[3].reject(new Error("memory")); await h.settle(); h.calls[4].reject(new Error("memory")); await h.settle();
      screen.close(); const reopened = h.mount("detail", "target"); await h.settle();
      // 재진입의 단건 GET만으로 이전 write 잠금을 해제하지 않는다.
      if (h.calls[5]) { h.detail(5, dto("target")); await h.settle(); }
      editTitle(h, reopened); saveButton(reopened).onPress(); listCard(list).onToggleCompleted(); await h.settle();
      assert.equal(patches(h).length, 2); assert.equal(listCard(list).completionDisabled, true);
    } finally { h.close(); }
  }
});

test("H 토글 중 화면 해제 후에도 PATCH 결과를 공유하고 재진입 중복 요청 차단", async () => {
  const h = harness("server"); try {
    const { list, calendar } = await completionScreens(h); listCard(list).onToggleCompleted(); await h.settle(); list.close();
    calendar.all("ScheduleCard")[0].onToggleCompleted(); await h.settle(); assert.equal(patches(h).length, 1);
    h.detail(2, dto("target", "INVENTORY", true)); await h.settle();
    await respondLists(h, 3, [dto("target", "INVENTORY", true)]);
    assert.equal(calendar.all("ScheduleCard")[0].schedule.completed, true);
    const reopened = h.mount("index"); await h.settle(); await respondLists(h, h.calls.length - 1, [dto("target", "INVENTORY", true)]);
    assert.equal(listCard(reopened).schedule.completed, true); assert.equal(patches(h).length, 1);
  } finally { h.close(); }
});

test("H 서버·모드 변경은 이전 PATCH와 늦은 응답을 무효화하고 Mock 데이터 보존", async () => {
  for (const change of ["mode", "server"]) {
    const h = harness("server"); try {
      const { list } = await completionScreens(h); const before = h.mock.getState().schedules;
      listCard(list).onToggleCompleted(); await h.settle();
      if (change === "mode") h.mode("mock"); else h.config("https://other.example.invalid"); await h.settle();
      assert.equal(h.calls[2].signal.aborted, true); h.detail(2, dto("target", "INVENTORY", true)); await h.settle();
      assert.strictEqual(h.mock.getState().schedules, before);
      const caches = Object.values(h.server.store.getState().servers);
      assert.ok(caches.every((c) => c.entities.target?.completed !== true)); assert.equal(patches(h).length, 1);
    } finally { h.close(); }
  }
});

test("H 토글 전·처리 중 시작한 늦은 GET은 성공 PATCH를 덮지 않음", async () => {
  const h = harness("server"); try {
    const { list } = await completionScreens(h);
    const query = h.source("src/utils/schedule-query.ts").getMainScheduleRange(new Date("2026-11-07T03:00:00Z"));
    const old = h.server.retry(query); await h.settle(); listCard(list).onToggleCompleted(); await h.settle();
    assert.equal(h.calls[2].signal.aborted, true);
    const during = h.server.retry(query); await h.settle();
    assert.equal(listCard(list).schedule.completed, true);
    h.detail(3, dto("target", "INVENTORY", true)); await h.settle(); assert.equal(h.calls[4].signal.aborted, true);
    h.respond(2, [dto("target")]); h.respond(4, [dto("target")]); await Promise.all([old, during]); await h.settle();
    assert.equal(listCard(list).schedule.completed, true); await respondLists(h, 5, [dto("target", "INVENTORY", true)]);
  } finally { h.close(); }
});

test("H 읽기 전용에서 카드·직접 handler·Store 호출·HTTP 경계 모두 PATCH 차단", async () => {
  const h = harness("server", { readOnly: true }); try {
    const { list, calendar } = await completionScreens(h);
    const id = h.source("src/services/api/http.ts").scheduleHttpClient.getServerId();
    assert.equal(listCard(list).completionDisabled, true); assert.equal(calendar.all("ScheduleCard")[0].completionDisabled, true);
    listCard(list).onToggleCompleted(); calendar.all("ScheduleCard")[0].onToggleCompleted();
    await h.server.toggleCompleted(id, "target");
    const result = await h.source("src/services/api/schedules.ts").prepareScheduleUpdate("target", { completed: true }).operation.submit();
    assert.equal(result.outcome, "not-sent"); assert.equal(result.error.policyReason, "read-only");
    await h.settle(); assert.equal(h.calls.length, 2); assert.equal(listCard(list).schedule.completed, false);
  } finally { h.close(); }
});

test("H 일반 CRUD에서 모든 일정 토글 활성화와 카테고리 선택 유지", async () => {
  const h = harness("server"); try {
    const { list, calendar } = await completionScreens(h, [dto("target"), dto("other", "OUTBOUND")]);
    assert.equal(listCard(list, 1).completionDisabled, false);
    list.one("CategoryFilter").onSelectCategory("재고"); h.flush();
    listCard(list).onToggleCompleted(); await h.settle(); assert.equal(patches(h).length, 1);
    assert.match(patches(h)[0].url, /\/target$/);
    h.detail(2, dto("target", "INVENTORY", true)); await h.settle();
    await respondLists(h, 3, [dto("target", "INVENTORY", true), dto("other", "OUTBOUND")]);
    assert.equal(list.one("CategoryFilter").selectedCategory, "재고");
    assert.equal(list.one("FlatList").data.length, 1); assert.equal(calendar.all("ScheduleCard")[0].schedule.completed, true);
  } finally { h.close(); }
});

test("H completed·category 조건의 활성 GET도 그대로 재조회하며 부분 결과를 전체로 대체하지 않음", async () => {
  const h = harness("server"); let consumer;
  try {
    const { list } = await completionScreens(h);
    const query = { ...h.source("src/utils/schedule-query.ts").getMainScheduleRange(new Date("2026-11-07T03:00:00Z")),
      category: "INVENTORY", completed: false };
    consumer = h.server.acquire(query); await h.settle(); h.respond(2, [dto("target")]); await h.settle();
    listCard(list).onToggleCompleted(); await h.settle(); h.detail(3, dto("target", "INVENTORY", true)); await h.settle();
    const filtered = h.calls.slice(4).find((c) => new URL(c.url).searchParams.get("completed") === "false");
    assert.ok(filtered); assert.equal(new URL(filtered.url).searchParams.get("category"), "INVENTORY");
    for (let i = 4; i < h.calls.length; i++) h.respond(i, h.calls[i] === filtered ? [] : [dto("target", "INVENTORY", true)]);
    await h.settle(); assert.equal(list.one("FlatList").data.length, 1); assert.equal(listCard(list).schedule.completed, true);
    const key = h.source("src/stores/serverScheduleStore.ts").scheduleQueryKey(h.server.store.getState().serverId, query);
    assert.deepEqual(Object.values(h.server.store.getState().servers)[0].queries[key].ids, []);
  } finally { consumer?.release(); h.close(); }
});

test("H 한 일정의 확정 실패 rollback은 다른 일정의 성공 상태를 보존", async () => {
  const h = harness("server"); try {
    const { list } = await completionScreens(h, [dto("target"), dto("other")]);
    listCard(list).onToggleCompleted(); h.flush(); listCard(list, 1).onToggleCompleted(); await h.settle();
    h.detail(3, dto("other", "INVENTORY", true)); await h.settle();
    h.detail(2, validationProblem(), 422, "application/problem+json"); await h.settle();
    assert.equal(listCard(list).schedule.completed, false); assert.equal(listCard(list, 1).schedule.completed, true);
    await respondLists(h, 4, [dto("target"), dto("other", "INVENTORY", true)]);
    assert.equal(listCard(list, 1).schedule.completed, true);
  } finally { h.close(); }
});

test("H 불확실 GET의 원래 값도 현재 상태 확인으로만 처리하며 PATCH 재전송 없음", async () => {
  const h = harness("server"); try {
    const { list } = await completionScreens(h);
    listCard(list).onToggleCompleted(); await h.settle();
    // 잘못된 성공 DTO는 재전송 없이 결과 확인 대상으로 전환한다.
    h.detail(2, { invalid: true }); await h.settle(); completionNotice(list).onRetry(); await h.settle();
    h.detail(3, dto("target")); await h.settle(); await respondLists(h, 4, [dto("target")]);
    assert.equal(listCard(list).schedule.completed, false); assert.equal(listCard(list).completionDisabled, false);
    assert.match(completionNotice(list).errorTitle, /이전 PATCH의 성공 여부를 뜻하지/); assert.equal(patches(h).length, 1);
  } finally { h.close(); }
});

test("H 서버·모드 왕복 전환 전의 토글 callback은 재사용 불가", async () => {
  for (const change of ["mode", "server"]) {
    const h = harness("server"); try {
      const { list } = await completionScreens(h); const stale = listCard(list).onToggleCompleted;
      if (change === "mode") { h.mode("mock"); h.mode("server"); }
      else { h.config("https://other.example.invalid"); h.config("https://example.invalid"); }
      stale(); await h.settle(); assert.equal(patches(h).length, 0);
    } finally { h.close(); }
  }
});

const deleteButton = (screen) => screen.one("Stack.Screen").options.headerRight()?.props;
const deleteCalls = (h) => h.calls.filter((c) => c.method === "DELETE");
const retryDeletion = (screen) => screen.all("Button").find((p) => p.label === "서버 상태 다시 불러오기")?.onPress ?? screen.one("ScheduleListState")?.onRetry;
function confirmDelete(h, screen) {
  deleteButton(screen).onPress(); h.flush();
  assert.equal(screen.one("ConfirmationModal").visible, true);
  screen.one("ConfirmationModal").onConfirm(); h.flush();
}
function noContent(h, index) {
  h.calls[index].resolve({ status: 204, ok: true, headers: new Headers(),
    text() { throw new Error("204 본문 파싱 금지"); }, json() { throw new Error("204 JSON 파싱 금지"); } });
}

test("I Mock 삭제 모달 취소·재확인·중복 확인·dismiss navigation 회귀와 HTTP 0회", async () => {
  const h = harness("mock"); try {
    const screen = h.mount("detail", mockId), before = h.mock.getState().schedules;
    deleteButton(screen).onPress(); deleteButton(screen).onPress(); h.flush();
    assert.equal(screen.one("ConfirmationModal").visible, true); screen.one("ConfirmationModal").onCancel(); h.flush();
    screen.one("ConfirmationModal").onConfirm(); h.flush(); assert.strictEqual(h.mock.getState().schedules, before);
    screen.one("ConfirmationModal").onDismiss(); h.flush();
    deleteButton(screen).onPress(); h.flush(); const stale = screen.one("ConfirmationModal").onConfirm;
    stale(); stale(); h.flush(); assert.equal(h.mock.getState().schedules.some((s) => s.id === mockId), false);
    assert.deepEqual(h.navigations, []); screen.one("ConfirmationModal").onDismiss(); screen.one("ConfirmationModal").onDismiss(); h.flush();
    assert.deepEqual(h.navigations, ["back"]); assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});

test("I 서버 삭제 모달 표시·취소와 확인 전 DELETE 0회", async () => {
  const h = harness("server"); try {
    const screen = await editableDetail(h);
    screen.one("ConfirmationModal").onConfirm(); await h.settle(); assert.equal(h.calls.length, 1);
    deleteButton(screen).onPress(); deleteButton(screen).onPress(); h.flush();
    assert.equal(screen.one("ConfirmationModal").visible, true); assert.equal(h.calls.length, 1);
    screen.one("ConfirmationModal").onCancel(); h.flush(); screen.one("ConfirmationModal").onConfirm(); await h.settle();
    assert.equal(screen.one("ConfirmationModal").visible, false); assert.equal(h.calls.length, 1); assert.deepEqual(h.navigations, []);
  } finally { h.close(); }
});

test("I DELETE 원래 ID·body와 key 없음·204 본문 미파싱·성공 후 iOS 모달 dismiss 뒤 navigation", async () => {
  const h = harness("server"); try {
    const id = randomUUID(), screen = await editableDetail(h, id), before = h.mock.getState().schedules;
    confirmDelete(h, screen); const duplicate = screen.one("ConfirmationModal").onConfirm;
    duplicate(); duplicate(); await h.settle(); assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].method, "DELETE"); assert.equal(new URL(h.calls[1].url).pathname, `/api/v1/schedules/${id}`);
    assert.equal(h.calls[1].body, undefined); assert.equal(h.calls[1].headers.has("Idempotency-Key"), false);
    assert.deepEqual(h.navigations, []); noContent(h, 1); await h.settle(); assert.deepEqual(h.navigations, []);
    assert.equal(Object.values(h.server.store.getState().servers)[0].entities[id], undefined);
    h.respond(2, []); await h.settle(); assert.deepEqual(h.navigations, []);
    screen.one("ConfirmationModal").onDismiss(); screen.one("ConfirmationModal").onDismiss(); h.flush();
    assert.deepEqual(h.navigations, ["back"]); assert.strictEqual(h.mock.getState().schedules, before); assert.equal(deleteCalls(h).length, 1);
  } finally { h.close(); }
});

test("I DELETE 204는 모든 query에서 대상만 제거하고 목록·캘린더 GET 및 dot 동기화", async () => {
  const h = harness("server"); try {
    const { list, calendar } = await completionScreens(h, [dto("target"), { ...dto("other"), scheduledAt: "2026-11-08T03:00:00Z" }]);
    const screen = await editableDetail(h); confirmDelete(h, screen); screen.one("ConfirmationModal").onDismiss(); await h.settle();
    assert.equal(list.one("FlatList").data.length, 2); // 응답 전 삭제 표시 금지
    noContent(h, 3); await h.settle();
    assert.deepEqual(list.one("FlatList").data.map((s) => s.id), ["other"]); assert.equal(calendar.all("ScheduleCard").length, 0);
    assert.deepEqual(calendar.one("MonthCalendar").scheduleDates, ["2026-11-08"]);
    const cache = Object.values(h.server.store.getState().servers)[0];
    assert.equal(cache.entities.target, undefined); assert.ok(Object.values(cache.queries).every((q) => !q.ids.includes("target")));
    assert.equal(h.calls.length, 6); assert.deepEqual(h.calls.slice(4).map((c) => c.url), h.calls.slice(0, 2).map((c) => c.url));
    await respondLists(h, 4, [{ ...dto("other"), scheduledAt: "2026-11-08T03:00:00Z" }]); assert.deepEqual(h.navigations, ["back"]);
    const reopened = h.mount("detail", "target"); await h.settle(); h.detail(6, notFoundProblem(), 404, "application/problem+json"); await h.settle();
    assert.equal(reopened.one("TextInput"), undefined); assert.match(reopened.one("ScheduleListState").errorTitle, /찾을 수 없/);
  } finally { h.close(); }
});

test("I 삭제 전·처리 중 GET의 늦은 응답과 이후 상충 GET도 삭제 entity를 복원하지 않음", async () => {
  const h = harness("server"); try {
    const { list } = await completionScreens(h); const screen = await editableDetail(h);
    const query = h.source("src/utils/schedule-query.ts").getMainScheduleRange(new Date("2026-11-07T03:00:00Z"));
    const old = h.server.retry(query); await h.settle(); confirmDelete(h, screen); await h.settle();
    assert.equal(h.calls[3].signal.aborted, true);
    const during = h.server.retry(query); await h.settle(); noContent(h, 4); await h.settle();
    assert.equal(h.calls[5].signal.aborted, true);
    h.respond(3, [dto("target")]); h.respond(5, [dto("target")]); await Promise.all([old, during]); await h.settle();
    await respondLists(h, 6, []); assert.equal(list.one("FlatList").data.length, 0);
    const inconsistent = h.server.retry(query); await h.settle(); h.respond(h.calls.length - 1, [dto("target")]); await inconsistent; await h.settle();
    assert.equal(list.one("FlatList").data.length, 0); assert.equal(Object.values(h.server.store.getState().servers)[0].entities.target, undefined);
  } finally { h.close(); }
});

test("I DELETE 성공 후 GET 실패는 폼·성공 상태 보존, 실패 목록 GET만 재시도", async () => {
  const h = harness("server"); try {
    const { list } = await completionScreens(h); const screen = await editableDetail(h); editTitle(h, screen, "보존할 입력");
    confirmDelete(h, screen); screen.one("ConfirmationModal").onDismiss(); await h.settle(); noContent(h, 3); await h.settle();
    h.respond(4, [], 500); h.respond(5, []); await h.settle();
    assert.match(formText(screen), /삭제되었지만/); assert.equal(screen.one("TextInput").value, "보존할 입력");
    assert.equal(list.one("FlatList").data.length, 0); assert.deepEqual(h.navigations, []);
    deleteButton(screen).onPress(); screen.one("ConfirmationModal").onConfirm(); retryDeletion(screen)(); retryDeletion(screen)(); await h.settle();
    assert.equal(h.calls.length, 7); assert.equal(h.calls[6].url, h.calls[4].url); assert.equal(h.calls[6].method, "GET");
    h.respond(6, []); await h.settle(); assert.deepEqual(h.navigations, ["back"]); assert.equal(deleteCalls(h).length, 1);
  } finally { h.close(); }
});

test("I DELETE 확정 404·422는 삭제 성공/navigation 없이 입력과 entity 유지", async () => {
  for (const [status, code] of [[404, "SCHEDULE_NOT_FOUND"], [422, "VALIDATION_ERROR"]]) {
    const h = harness("server"); try {
      const screen = await editableDetail(h); editTitle(h, screen); confirmDelete(h, screen); await h.settle();
      h.detail(1, { ...notFoundProblem(), status, code,
        ...(code === "VALIDATION_ERROR" ? { errors: [{ location: "path", parameter: "scheduleId", code: "INVALID_UUID", detail: "test" }] } : {}) },
        status, "application/problem+json"); await h.settle();
      assert.equal(h.calls.length, 2); assert.equal(screen.one("TextInput").value, "수정 입력"); assert.deepEqual(h.navigations, []);
      assert.match(formText(screen), code === "SCHEDULE_NOT_FOUND" ? /삭제할 일정/ : /삭제 요청이 거절/);
      assert.ok(Object.values(h.server.store.getState().servers)[0].entities.target);
    } finally { h.close(); }
  }
});

test("I 네트워크 불확실은 기존 제한 retry만 적용하고 GET 404 확인은 삭제 성공으로 안내하지 않음", async () => {
  const h = harness("server"); try {
    const { list, calendar } = await completionScreens(h); const screen = await editableDetail(h); confirmDelete(h, screen); await h.settle();
    h.calls[3].reject(new Error("memory")); await h.settle(); h.calls[4].reject(new Error("memory")); await h.settle();
    assert.equal(deleteCalls(h).length, 2); assert.equal(h.calls[3].url, h.calls[4].url); assert.match(formText(screen), /삭제 결과를 확인/);
    deleteButton(screen).onPress(); screen.one("ConfirmationModal").onConfirm(); await h.settle(); assert.equal(h.calls.length, 5);
    retryDeletion(screen)(); await h.settle(); h.detail(5, notFoundProblem(), 404, "application/problem+json"); await h.settle();
    await respondLists(h, 6, []);
    assert.equal(list.one("FlatList").data.length, 0); assert.equal(calendar.all("ScheduleCard").length, 0);
    assert.match(formText(screen), /이전 삭제 요청의 성공 여부를 뜻하지/); assert.deepEqual(h.navigations, []); assert.equal(deleteCalls(h).length, 2);
  } finally { h.close(); }
});

test("I 불확실 결과 확인 GET 200·다른 404·통신 실패는 자동 재삭제 및 성공 처리 금지", async () => {
  for (const read of ["found", "other404", "network"]) {
    const h = harness("server"); try {
      const screen = await editableDetail(h); confirmDelete(h, screen); await h.settle();
      h.detail(1, {}, 200); await h.settle(); assert.match(formText(screen), /삭제 결과를 확인/);
      screen.one("ConfirmationModal").onDismiss(); h.flush(); retryDeletion(screen)(); await h.settle();
      if (read === "found") h.detail(2, dto("target"));
      if (read === "other404") h.detail(2, notFoundProblem("ROUTE_NOT_FOUND"), 404, "application/problem+json");
      if (read === "network") { h.calls[2].reject(new Error("memory")); await h.settle(); h.calls[3].reject(new Error("memory")); }
      await h.settle(); assert.match(formText(screen), read === "found" ? /현재 일정이 조회/ : /존재 여부를 확인하지 못/);
      assert.equal(deleteButton(screen).disabled, true); deleteButton(screen).onPress(); screen.one("ConfirmationModal").onConfirm(); await h.settle();
      assert.equal(deleteCalls(h).length, 1); assert.deepEqual(h.navigations, []);
    } finally { h.close(); }
  }
});

test("I DELETE timeout과 500·503은 서비스의 불확실 판정을 유지하며 수동 DELETE 재전송 금지", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const kind of ["timeout", "500", "503"]) {
    const h = harness("server"); try {
      const screen = await editableDetail(h); confirmDelete(h, screen); await h.settle();
      if (kind === "timeout") { t.mock.timers.tick(10_000); await h.settle(); t.mock.timers.tick(10_000); }
      else {
        const status = Number(kind), problem = { ...notFoundProblem(), status, code: "INTERNAL_ERROR" };
        h.detail(1, problem, status, "application/problem+json"); await h.settle();
        if (kind === "503") h.detail(2, problem, status, "application/problem+json");
      }
      await h.settle(); assert.match(formText(screen), /삭제 결과를 확인/); assert.deepEqual(h.navigations, []);
      assert.equal(deleteCalls(h).length, kind === "500" ? 1 : 2);
      deleteButton(screen).onPress(); screen.one("ConfirmationModal").onConfirm(); await h.settle();
      assert.equal(deleteCalls(h).length, kind === "500" ? 1 : 2);
    } finally { h.close(); }
  }
});

test("I 수정·완료 PATCH와 DELETE는 양방향으로 같은 공유 잠금 사용", async () => {
  for (const patch of ["edit", "completion"]) for (const first of ["patch", "delete"]) {
    const h = harness("server"); try {
      const { list } = await completionScreens(h); const screen = await editableDetail(h); editTitle(h, screen);
      if (first === "delete") { confirmDelete(h, screen); saveButton(screen).onPress(); listCard(list).onToggleCompleted(); }
      else {
        // 모달의 과거 callback도 Store 잠금을 우회하지 못한다.
        deleteButton(screen).onPress(); h.flush(); const confirm = screen.one("ConfirmationModal").onConfirm;
        if (patch === "edit") {
          screen.one("ConfirmationModal").onCancel(); screen.one("ConfirmationModal").onDismiss(); h.flush(); saveButton(screen).onPress();
        } else listCard(list).onToggleCompleted();
        confirm();
      }
      await h.settle(); assert.equal(deleteCalls(h).length + patches(h).length, 1);
      assert.equal(deleteCalls(h).length, first === "delete" ? 1 : 0);
      assert.equal(deleteButton(screen).disabled, true); assert.equal(listCard(list).completionDisabled, true);
    } finally { h.close(); }
  }
});

test("I DELETE 중 route·모드·서버·unmount 변경은 이전 응답과 navigation 무효화", async () => {
  for (const change of ["route", "mode", "server", "unmount"]) {
    const h = harness("server"); try {
      const screen = await editableDetail(h); confirmDelete(h, screen); await h.settle();
      if (change === "route") screen.route("other");
      if (change === "mode") h.mode("mock");
      if (change === "server") h.config("https://other.example.invalid");
      if (change === "unmount") screen.close();
      await h.settle(); assert.equal(h.calls[1].signal.aborted, true); noContent(h, 1); await h.settle();
      assert.deepEqual(h.navigations, []);
      assert.ok(Object.values(h.server.store.getState().servers).every((c) => !c.deletedIds.target));
      if (change === "route" || change === "server") { h.detail(2, dto(change === "route" ? "other" : "target")); await h.settle(); }
    } finally { h.close(); }
  }
});

test("I 불확실 삭제는 재진입에도 공유 잠금 유지하며 복구 버튼에서 GET만 실행", async () => {
  const h = harness("server"); try {
    const screen = await editableDetail(h); confirmDelete(h, screen); await h.settle(); screen.close(); await h.settle();
    const reopened = h.mount("detail", "target"); await h.settle(); h.detail(2, dto("target")); await h.settle();
    assert.equal(deleteButton(reopened).disabled, true); assert.ok(retryDeletion(reopened));
    editTitle(h, reopened); saveButton(reopened).onPress(); deleteButton(reopened).onPress(); await h.settle(); assert.equal(h.calls.length, 3);
    retryDeletion(reopened)(); await h.settle(); assert.equal(h.calls[3].method, "GET"); h.detail(3, notFoundProblem(), 404, "application/problem+json"); await h.settle();
    await respondLists(h, 4, []); assert.deepEqual(h.navigations, []); assert.equal(deleteCalls(h).length, 1);
  } finally { h.close(); }
});

test("I 읽기 전용은 삭제 버튼·모달 handler·Store·직접 서비스 DELETE 모두 차단", async () => {
  const h = harness("server", { readOnly: true }); try {
    const screen = await editableDetail(h); assert.equal(deleteButton(screen).disabled, true);
    deleteButton(screen).onPress(); h.flush(); assert.equal(screen.one("ConfirmationModal").visible, false);
    screen.one("ConfirmationModal").onConfirm();
    const id = h.source("src/services/api/http.ts").scheduleHttpClient.getServerId();
    assert.equal(await h.server.deleteSchedule(id, "target"), false);
    const result = await h.source("src/services/api/schedules.ts").prepareScheduleDeletion("target").operation.submit();
    assert.equal(result.outcome, "not-sent"); assert.equal(result.error.policyReason, "read-only");
    await h.settle(); assert.equal(h.calls.length, 1); assert.deepEqual(h.navigations, []);
  } finally { h.close(); }
});

test("I 일반 CRUD에서 서로 다른 일정의 삭제와 수정 버튼 활성화", async () => {
  const h = harness("server"); try {
    const other = await editableDetail(h, "other"), screen = await editableDetail(h);
    assert.equal(deleteButton(other).disabled, false); assert.equal(deleteButton(screen).disabled, false);
    editTitle(h, other); editTitle(h, screen); assert.equal(saveButton(other).disabled, false); assert.equal(saveButton(screen).disabled, false);
    confirmDelete(h, screen); await h.settle();
    assert.equal(deleteCalls(h).length, 1); assert.match(deleteCalls(h)[0].url, /\/target$/); assert.equal(patches(h).length, 0);
  } finally { h.close(); }
});

test("I 두 상세 화면의 동시 확인은 DELETE 1회이며 다른 일정 삭제는 독립 실행", async () => {
  const h = harness("server"); try {
    const first = await editableDetail(h), second = h.mount("detail", "target"), other = await editableDetail(h, "other");
    deleteButton(first).onPress(); deleteButton(second).onPress(); h.flush();
    const staleConfirm = second.one("ConfirmationModal").onConfirm;
    first.one("ConfirmationModal").onConfirm(); staleConfirm(); confirmDelete(h, other); await h.settle();
    assert.equal(deleteCalls(h).length, 2); assert.notEqual(deleteCalls(h)[0].url, deleteCalls(h)[1].url);
    noContent(h, 2); noContent(h, 3); await h.settle(); await respondLists(h, 4, []);
    assert.equal(Object.values(h.server.store.getState().servers)[0].entities.target, undefined);
    assert.equal(Object.values(h.server.store.getState().servers)[0].entities.other, undefined);
  } finally { h.close(); }
});

test("I 204 후 목록 실패 상태로 재진입해도 GET-only 복구와 삭제 상태 유지", async () => {
  const h = harness("server"); try {
    const screen = await editableDetail(h); confirmDelete(h, screen); await h.settle(); noContent(h, 1); await h.settle();
    h.respond(2, [], 500); await h.settle(); screen.close();
    const reopened = h.mount("detail", "target"); await h.settle(); h.detail(3, notFoundProblem(), 404, "application/problem+json"); await h.settle();
    assert.equal(reopened.one("TextInput"), undefined); assert.match(reopened.one("ScheduleListState").errorTitle, /삭제되었지만/);
    retryDeletion(reopened)(); await h.settle(); assert.equal(h.calls[4].method, "GET");
    h.respond(4, []); await h.settle(); assert.deepEqual(h.navigations, ["back"]); assert.equal(deleteCalls(h).length, 1);
  } finally { h.close(); }
});

test("I 삭제 복구 GET 도중 route·모드·서버 변경은 이전 404와 navigation 차단", async () => {
  for (const change of ["route", "mode", "server"]) {
    const h = harness("server"); try {
      const screen = await editableDetail(h); confirmDelete(h, screen); await h.settle(); h.detail(1, {}, 200); await h.settle();
      screen.one("ConfirmationModal").onDismiss(); h.flush(); retryDeletion(screen)(); await h.settle();
      if (change === "route") screen.route("other");
      if (change === "mode") h.mode("mock");
      if (change === "server") h.config("https://other.example.invalid");
      await h.settle(); h.detail(2, notFoundProblem(), 404, "application/problem+json"); await h.settle();
      assert.deepEqual(h.navigations, []); assert.ok(Object.values(h.server.store.getState().servers).every((c) => !c.deletedIds.target));
      if (change === "route" || change === "server") { h.detail(3, dto(change === "route" ? "other" : "target")); await h.settle(); }
      assert.equal(deleteCalls(h).length, 1);
    } finally { h.close(); }
  }
});

test("I 앞선 응답 유실 뒤 DELETE 404는 확정 거절로 단정하지 않고 GET-only 확인", async () => {
  const h = harness("server"); try {
    const screen = await editableDetail(h); confirmDelete(h, screen); await h.settle(); h.calls[1].reject(new Error("memory")); await h.settle();
    h.detail(2, notFoundProblem(), 404, "application/problem+json"); await h.settle();
    assert.match(formText(screen), /삭제 결과를 확인/); assert.equal(deleteButton(screen).disabled, true);
    retryDeletion(screen)(); await h.settle(); assert.equal(h.calls[3].method, "GET");
    h.detail(3, notFoundProblem(), 404, "application/problem+json"); await h.settle(); await respondLists(h, 4, []);
    assert.match(formText(screen), /이전 삭제 요청의 성공 여부를 뜻하지/); assert.deepEqual(h.navigations, []); assert.equal(deleteCalls(h).length, 2);
  } finally { h.close(); }
});

test("K 환경 미설정·잘못된 모드는 첫 렌더부터 server, 명시적 mock만 로컬 데이터", async () => {
  for (const value of [undefined, "", "invalid", "SERVER", "server"]) {
    const h = harness(value); try {
      assert.equal(h.source("src/stores/scheduleDataModeStore.ts").scheduleDataModeStore.getState().mode, "server");
      const list = h.mount("index"); assert.deepEqual(list.one("FlatList").data, []);
      await h.settle(); assert.equal(h.calls.length, 1); h.respond(0, []); await h.settle(); assert.deepEqual(list.one("FlatList").data, []);
    } finally { h.close(); }
  }
});

test("K 정책은 모든 일정 ID의 Schedule CRUD만 허용하고 명시적 읽기 전용은 GET만 허용", () => {
  for (const readOnly of [false, true]) {
    const h = harness("server", { readOnly }); try {
      const policy = h.source("src/stores/scheduleDataModeStore.ts");
      for (const id of [randomUUID(), randomUUID().toUpperCase()]) for (const method of ["GET", "POST", "PATCH", "DELETE", "PUT"]) for (const path of [
        "/schedules", `/schedules/${id}`, "/assistant/requests", "/system/time-sync", "/health",
      ]) {
        const expected = method === "GET" || (!readOnly && ((method === "POST" && path === "/schedules") ||
          (["PATCH", "DELETE"].includes(method) && path === `/schedules/${id}`)));
        assert.equal(policy.isScheduleRequestAllowed(method, path), expected);
      }
      assert.equal(h.calls.length, 0);
    } finally { h.close(); }
  }
});

test("K 읽기 전용은 정확한 true만 적용하고 기본·false는 일반 CRUD", () => {
  for (const value of [false, "false", "", "TRUE", "invalid"]) {
    const h = harness("server", { readOnly: value }); try {
      const policy = h.source("src/stores/scheduleDataModeStore.ts");
      assert.equal(policy.isScheduleRequestAllowed("POST", "/schedules"), true);
      assert.equal(policy.isScheduleRequestAllowed("DELETE", `/schedules/${randomUUID()}`), true);
    } finally { h.close(); }
  }
});

test("K 임시 scope·대상 ID 환경변수와 __DEV__ 의존 제거 및 Expo 정적 참조 유지", () => {
  const source = fs.readFileSync(path.join(root, "src/stores/scheduleDataModeStore.ts"), "utf8");
  assert.doesNotMatch(source, /WRITE_SCOPE|WRITE_TARGET_ID|target-patch|target-delete|resolveScheduleWrite|__DEV__|console\./);
  assert.match(source, /process\.env\.EXPO_PUBLIC_SCHEDULE_DATA_MODE/); assert.match(source, /process\.env\.EXPO_PUBLIC_SCHEDULE_READ_ONLY/);
});

test("K 잘못된 쓰기 경로·인코딩 우회·query·외부 origin·Assistant·time-sync 전송 전 차단", async () => {
  const id = randomUUID(), encoded = `%${id.charCodeAt(0).toString(16)}${id.slice(1)}`, h = harness("server"); try {
    const client = h.source("src/services/api/http.ts").scheduleHttpClient;
    for (const method of ["POST", "PATCH", "DELETE"]) {
      for (const path of ["/assistant/requests", "/system/time-sync", "/health", "/schedules/", "/schedules-extra",
        `/schedules/${id}/`, `/schedules/${id}/extra`, `/schedules/${id}?x=1`, `/schedules/${id}#x`,
        `/schedules/${encoded}`, `/schedules/${encoded.replace("%", "%25")}`, `/schedules/${id.replaceAll("-", "%2D")}`,
        `/schedules%2F${id}`, `/schedules\\${id}`, `/schedules/${id}/../other`, `/api/v1/schedules/${id}`,
        `/SCHEDULES/${id}`, ` /schedules/${id}`, `/schedules/${id}\n`,
        `https://other.example.invalid/api/v1/schedules/${id}`, `//other.example.invalid/schedules/${id}`]) {
        assert.equal(h.source("src/stores/scheduleDataModeStore.ts").isScheduleRequestAllowed(method, path), false);
        const result = await client.request({ method, path }); assert.equal(result.ok, false); assert.equal(result.attempts, 0);
      }
      const result = await client.request({ method, path: method === "POST" ? "/schedules" : `/schedules/${id}`, query: new URLSearchParams({ x: "1" }) });
      assert.equal(result.ok, false); assert.equal(result.attempts, 0);
    }
    assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});

test("K 설정 Base URL과 다른 apiBaseUrl origin은 모든 CRUD에서 fetch 이전 차단", async () => {
  const h = harness("server"); try {
    const config = h.source("src/services/api/config.ts").parseDevelopmentServerConfig("https://example.invalid"); let sends = 0;
    const client = h.source("src/services/api/http.ts").createScheduleHttpClient({ readConfig: () => ({ ...config, config: { ...config.config, apiBaseUrl: "https://other.example.invalid/api/v1" } }), fetchImpl: () => { sends++; throw new Error("전송 금지"); } });
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const result = await client.request({ method, path: method === "POST" ? "/schedules" : `/schedules/${randomUUID()}` });
      assert.equal(result.attempts, 0); assert.equal(result.error.kind, "request");
    }
    assert.equal(sends, 0);
  } finally { h.close(); }
});

test("K 모든 쓰기의 307 redirect는 후속 요청·retry로 연결하지 않음", async () => {
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const h = harness("server"); try {
      const pending = h.source("src/services/api/http.ts").scheduleHttpClient.request({ method, path: method === "POST" ? "/schedules" : `/schedules/${randomUUID()}` });
      await h.settle(); assert.equal(h.calls[0].redirect, "error"); h.detail(0, {}, 307, "application/json", { Location: "https://other.example.invalid" });
      assert.equal((await pending).ok, false); assert.equal(h.calls.length, 1);
    } finally { h.close(); }
  }
});

test("K 최초 전송·retry 직전 같은 정책·path·query 재검사", async () => {
  for (const method of ["POST", "PATCH", "DELETE"]) for (const rejectAt of [2, 3]) {
    const h = harness("server"); try {
      const policy = h.source("src/stores/scheduleDataModeStore.ts"), actual = policy.isScheduleRequestAllowed;
      const checks = [], path = method === "POST" ? "/schedules" : `/schedules/${randomUUID()}`;
      policy.isScheduleRequestAllowed = (...args) => { checks.push(args); return checks.length < rejectAt && actual(...args); };
      const pending = h.source("src/services/api/http.ts").scheduleHttpClient.request({ method, path }); await h.settle();
      if (rejectAt === 3) h.calls[0].reject(new Error("memory"));
      const result = await pending; assert.equal(result.error.policyReason, "read-only"); assert.equal(result.attempts, rejectAt === 2 ? 0 : 1);
      assert.equal(h.calls.length, rejectAt === 2 ? 0 : 1); assert.equal(checks.length, rejectAt);
      assert.ok(checks.every(([m, p, q]) => m === method && p === path && q === undefined));
      if (rejectAt === 3) assert.equal(result.error.unconfirmedAttempt, true);
    } finally { h.close(); }
  }
});

test("K body 직렬화 중 request 변형도 최초 path·query·method로 고정", async () => {
  const id = randomUUID(), h = harness("server"); try {
    const options = { method: "PATCH", path: `/schedules/${id}`, query: new URLSearchParams(), body: { toJSON() { options.path = "/assistant/requests"; options.method = "POST"; options.query.set("x", "1"); return { completed: true }; } } };
    const pending = h.source("src/services/api/http.ts").scheduleHttpClient.request(options); await h.settle();
    assert.equal(h.calls[0].url, `https://example.invalid/api/v1/schedules/${id}`); assert.equal(h.calls[0].method, "PATCH");
    h.detail(0, dto(id, "INVENTORY", true)); assert.equal((await pending).status, 200);
  } finally { h.close(); }
});

test("K GET 목록·단건·query·DTO status/id/updatedAt는 읽기 전용 여부와 무관하게 유지", async () => {
  for (const readOnly of [true, false]) {
    const id = randomUUID(), h = harness("server", { readOnly }); try {
      const client = h.source("src/services/api/http.ts").scheduleHttpClient;
      const list = client.request({ path: "/schedules", query: new URLSearchParams({ completed: "false" }) }); await h.settle();
      assert.equal(new URL(h.calls[0].url).searchParams.get("completed"), "false"); h.respond(0, [dto(id)]); assert.equal((await list).status, 200);
      const detail = client.request({ path: `/schedules/${id}` }); await h.settle(); h.detail(1, dto(id));
      const result = await detail; assert.equal(result.data.id, id); assert.equal(result.data.updatedAt, dto(id).updatedAt);
    } finally { h.close(); }
  }
});

test("K 서로 다른 유효 ID의 POST·PATCH·DELETE 서비스 전송과 POST 전용 멱등성 key", async () => {
  const h = harness("server"); try {
    const service = h.source("src/services/api/schedules.ts");
    for (const id of [randomUUID(), randomUUID()]) {
      const create = service.prepareScheduleCreation({ title: "일반 등록", category: "INVENTORY", scheduledAt: "2026-11-10T03:00:00Z" }).operation;
      let index = h.calls.length, pending = create.submit(); await h.settle();
      assert.equal(h.calls[index].headers.get("Idempotency-Key"), create.idempotencyKey); h.detail(index, dto(id), 201); assert.equal((await pending).response.status, 201);
      index = h.calls.length; pending = service.prepareScheduleUpdate(id, { title: "일반 수정" }).operation.submit(); await h.settle();
      assert.equal(h.calls[index].url, `https://example.invalid/api/v1/schedules/${id}`); assert.deepEqual(JSON.parse(h.calls[index].body), { title: "일반 수정" });
      assert.equal(h.calls[index].headers.has("Idempotency-Key"), false); h.detail(index, { ...dto(id), title: "일반 수정" }); assert.equal((await pending).response.status, 200);
      index = h.calls.length; pending = service.prepareScheduleDeletion(id).operation.submit(); await h.settle();
      assert.equal(h.calls[index].method, "DELETE"); assert.equal(h.calls[index].headers.has("Idempotency-Key"), false);
      noContent(h, index); assert.equal((await pending).response.status, 204);
    }
  } finally { h.close(); }
});

test("K 기본 서버 화면의 일반 일정 두 개 생성·수정·완료·삭제와 공유 cache 동기화", async () => {
  const h = harness(); try {
    const { list, calendar } = await completionScreens(h, []), before = h.mock.getState().schedules;
    for (const id of [randomUUID(), randomUUID()]) {
      const create = h.mount("create"); fillCreation(h, create); assert.equal(createButton(create).disabled, false);
      let start = h.calls.length; createButton(create).onPress(); createButton(create).onPress(); await h.settle();
      assert.equal(h.calls.length, start + 1); h.detail(start, dto(id), 201); await h.settle(); await respondLists(h, start + 1, [dto(id)]); create.close();
      const edit = await editableDetail(h, id); editTitle(h, edit, "일반 일정 수정"); assert.equal(saveButton(edit).disabled, false);
      start = h.calls.length; saveButton(edit).onPress(); saveButton(edit).onPress(); listCard(list).onToggleCompleted(); await h.settle();
      assert.equal(h.calls.length, start + 1); assert.deepEqual(JSON.parse(h.calls[start].body), { title: "일반 일정 수정" });
      const changed = { ...dto(id), title: "일반 일정 수정" }; h.detail(start, changed); await h.settle(); await respondLists(h, start + 1, [changed]); edit.close();
      start = h.calls.length; listCard(list).onToggleCompleted(); calendar.one("ScheduleCard").onToggleCompleted(); await h.settle();
      assert.equal(h.calls.length, start + 1); assert.deepEqual(JSON.parse(h.calls[start].body), { completed: true });
      const completed = { ...changed, completed: true }; h.detail(start, completed); await h.settle(); await respondLists(h, start + 1, [completed]);
      assert.equal(listCard(list).schedule.completed, true); assert.equal(calendar.one("ScheduleCard").schedule.completed, true);
      const deletion = h.mount("detail", id); assert.equal(deleteButton(deletion).disabled, false);
      start = h.calls.length; confirmDelete(h, deletion); deletion.one("ConfirmationModal").onConfirm(); await h.settle();
      assert.equal(h.calls.length, start + 1); assert.equal(h.calls[start].method, "DELETE"); noContent(h, start); await h.settle(); await respondLists(h, start + 1, []);
      deletion.one("ConfirmationModal").onDismiss(); h.flush(); deletion.close();
      assert.deepEqual(list.one("FlatList").data, []); assert.equal(calendar.all("ScheduleCard").length, 0);
      assert.equal(Object.values(h.server.store.getState().servers)[0].entities[id], undefined);
    }
    assert.equal(h.calls.filter((call) => call.method === "POST").length, 2); assert.equal(patches(h).length, 4); assert.equal(deleteCalls(h).length, 2);
    assert.strictEqual(h.mock.getState().schedules, before);
  } finally { h.close(); }
});

test("K Mock 직접 HTTP 쓰기는 차단하고 읽기 전용과 무관하게 로컬 CRUD 유지", async () => {
  for (const readOnly of [true, false]) {
    const h = harness("mock", { readOnly }); try {
      const create = h.mount("create"); fillCreation(h, create); await createButton(create).onPress(); h.flush();
      const id = h.mock.getState().schedules.at(-1).id, edit = h.mount("detail", id); editTitle(h, edit); saveButton(edit).onPress(); h.flush();
      h.mock.getState().toggleCompleted(id); const deletion = h.mount("detail", id); confirmDelete(h, deletion); deletion.one("ConfirmationModal").onDismiss(); h.flush();
      const client = h.source("src/services/api/http.ts").scheduleHttpClient;
      for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await client.request({ method, path: method === "POST" ? "/schedules" : `/schedules/${id}` })).attempts, 0);
      assert.equal(h.calls.length, 0); assert.equal(h.mock.getState().schedules.length, 10);
    } finally { h.close(); }
  }
});

test("K 기본 서버의 설정 누락·오류는 Mock fallback이나 가짜 저장 없이 오류", async () => {
  for (const value of [undefined, "invalid"]) {
    const h = harness(); try {
      h.config(value); const list = h.mount("index"), create = h.mount("create"), before = h.mock.getState().schedules;
      assert.deepEqual(list.one("FlatList").data, []); assert.ok(states(list).includes("error"));
      fillCreation(h, create); await createButton(create).onPress(); await h.settle();
      assert.equal(h.calls.length, 0); assert.strictEqual(h.mock.getState().schedules, before); assert.deepEqual(h.navigations, []);
    } finally { h.close(); }
  }
});

test("K 쓰기 도중 서버 식별값 변경은 이전 결과와 retry 차단", async () => {
  const h = harness("server"); try {
    const id = randomUUID(), pending = h.source("src/services/api/http.ts").scheduleHttpClient.request({ method: "PATCH", path: `/schedules/${id}`, body: { completed: true } });
    await h.settle(); h.config("https://other.example.invalid"); h.calls[0].reject(new Error("memory"));
    const result = await pending; assert.equal(result.error.kind, "aborted"); assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});

const flatStyle = (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
const editHeader = (screen) => screen.one("Stack.Screen");
const editContent = (screen) => screen.all("View").find((props) => props.testID === "schedule-edit-content");
const feedbackPanel = (screen) => screen.all("ScrollView").find((props) => props.testID === "schedule-feedback");
function assertStableCards(list, calendar) {
  assert.equal(states(list).includes("loading"), false); assert.equal(states(calendar).includes("loading"), false);
  assert.equal(list.one("FlatList").ListHeaderComponent, undefined);
  assert.equal(flatStyle(calendar.all("View").find((props) => props.testID === "calendar-schedule-list").style).marginTop, 8);
}

test("H 빠른 수정 진입: PATCH가 진행 중 단건 GET을 취소해도 성공 cache와 입력 유지, 재조회 안내 없음", async () => {
  for (const late of ["success", "failure"]) {
    const h = harness("server"); try {
      const id = randomUUID(), { list, calendar } = await completionScreens(h, [dto(id)]);
      listCard(list).onToggleCompleted(); await h.settle();
      const screen = h.mount("detail", id); editTitle(h, screen, "빠른 진입 후 입력"); await h.settle();
      assert.equal(h.calls[3].method, "GET");
      h.detail(2, dto(id, "INVENTORY", true)); await h.settle();
      assert.equal(h.calls[3].signal.aborted, true);
      const cache = Object.values(h.server.store.getState().servers)[0];
      assert.equal(cache.entities[id].completed, true); assert.equal(cache.details[id].stale, false);
      assert.equal(cache.details[id].error, null); assert.equal(h.calls.length, 6);
      if (late === "success") h.detail(3, dto(id)); else h.calls[3].reject(new Error("memory late GET"));
      await respondLists(h, 4, [dto(id, "INVENTORY", true)]);
      assert.deepEqual(screen.all("ScheduleListState"), []);
      assert.equal(screen.one("TextInput").value, "빠른 진입 후 입력"); assert.equal(saveButton(screen).disabled, false);
      assert.equal(listCard(list).schedule.completed, true); assert.equal(calendar.one("ScheduleCard").schedule.completed, true);
      assert.equal(patches(h).length, 1);
    } finally { h.close(); }
  }
});

test("H 빠른 수정 진입: PATCH 성공 후 목록 GET 중 진입은 확인된 단건 cache를 재사용하고 오래된 목록 응답 무시", async () => {
  const h = harness("server"); try {
    const id = randomUUID(), { list, calendar } = await completionScreens(h, [dto(id)]);
    const query = h.source("src/utils/schedule-query.ts").getMainScheduleRange(new Date("2026-11-07T03:00:00Z"));
    const old = h.server.retry(query); await h.settle();
    listCard(list).onToggleCompleted(); await h.settle(); h.detail(3, dto(id, "INVENTORY", true)); await h.settle();
    assert.equal(h.calls[2].signal.aborted, true); assert.equal(h.calls.length, 6);
    const screen = h.mount("detail", id); editTitle(h, screen, "목록 재조회 중 입력"); await h.settle();
    assert.equal(h.calls.length, 6); // PATCH 응답으로 확인된 같은 ID 단건의 불필요한 재조회 없음
    h.respond(2, [dto(id)]); await old; await respondLists(h, 4, [dto(id, "INVENTORY", true)]);
    assert.deepEqual(screen.all("ScheduleListState"), []); assert.equal(screen.one("ActivityIndicator"), undefined);
    assert.equal(screen.one("TextInput").value, "목록 재조회 중 입력"); assert.equal(saveButton(screen).disabled, false);
    assert.equal(listCard(list).schedule.completed, true); assert.equal(calendar.one("ScheduleCard").schedule.completed, true);
    assert.equal(patches(h).length, 1);
  } finally { h.close(); }
});

test("H 빠른 수정 진입: 목록 재조회 중 단건 GET의 정상 구독 해제는 오류·stale을 남기지 않고 재진입 입력 유지", async () => {
  const h = harness("server"); try {
    const id = randomUUID(), { list, calendar } = await completionScreens(h, [dto(id)]);
    listCard(list).onToggleCompleted(); await h.settle(); h.detail(2, dto(id, "INVENTORY", true)); await h.settle();
    const first = h.mount("detail", id); const cancelled = h.server.retryDetail(id); await h.settle();
    first.close(); await cancelled; await h.settle();
    assert.equal(h.calls[5].signal.aborted, true);
    const cache = Object.values(h.server.store.getState().servers)[0];
    assert.equal(cache.details[id].error, null); assert.equal(cache.details[id].stale, false);
    const screen = h.mount("detail", id); editTitle(h, screen, "재진입 후 입력"); await h.settle();
    assert.equal(h.calls.length, 6); h.detail(5, dto(id));
    h.respond(3, [dto(id, "INVENTORY", true)]); h.respond(4, [dto(id, "INVENTORY", true)]); await h.settle();
    assert.deepEqual(screen.all("ScheduleListState"), []); assert.equal(screen.one("TextInput").value, "재진입 후 입력");
    assert.equal(listCard(list).schedule.completed, true); assert.equal(calendar.one("ScheduleCard").schedule.completed, true);
    assert.equal(patches(h).length, 1);
  } finally { h.close(); }
});

test("H 빠른 수정 진입: 실제 단건 네트워크 실패는 cache·입력과 오류를 유지하며 GET-only Retry", async () => {
  const h = harness("server"); try {
    const id = randomUUID(), { list, calendar } = await completionScreens(h, [dto(id)]);
    listCard(list).onToggleCompleted(); await h.settle(); h.detail(2, dto(id, "INVENTORY", true)); await h.settle();
    const screen = h.mount("detail", id); editTitle(h, screen, "통신 실패 중 입력");
    const read = h.server.retryDetail(id); await h.settle();
    h.respond(3, [dto(id, "INVENTORY", true)]); h.respond(4, [dto(id, "INVENTORY", true)]); await h.settle();
    h.calls[5].reject(new Error("memory network")); await h.settle(); h.calls[6].reject(new Error("memory network"));
    await read; await h.settle();
    assert.equal(screen.one("ScheduleListState").state, "error"); assert.match(screen.one("ScheduleListState").errorTitle, /최신 정보를 불러오지 못했어요/);
    assert.equal(screen.one("TextInput").value, "통신 실패 중 입력"); assert.equal(saveButton(screen).disabled, true);
    assert.equal(listCard(list).schedule.completed, true); assert.equal(calendar.one("ScheduleCard").schedule.completed, true);
    screen.one("ScheduleListState").onRetry(); await h.settle();
    assert.equal(h.calls[7].method, "GET"); h.detail(7, dto(id, "INVENTORY", true)); await h.settle();
    assert.deepEqual(screen.all("ScheduleListState"), []); assert.equal(screen.one("TextInput").value, "통신 실패 중 입력");
    assert.equal(saveButton(screen).disabled, false); assert.equal(patches(h).length, 1);
  } finally { h.close(); }
});

test("UI 최초 단건 GET만 중앙 absolute 로딩, native Header 옵션은 폼·로딩 외부에 유지", async () => {
  const h = harness("server"); try {
    const layout = h.mount("layout"), id = randomUUID(), screen = h.mount("detail", id);
    const options = layout.all("Stack.Screen").find((props) => props.name === "schedule/[id]").options;
    assert.equal(options.headerShown, undefined); assert.equal(options.title, "일정 수정");
    assert.equal(options.headerTransparent, false); assert.equal(options.animation, "simple_push");
    assert.equal(options.headerLeft, undefined); assert.equal(editHeader(screen).options.headerLeft, undefined);
    for (const route of ["schedule/create", "settings"]) assert.notEqual(layout.all("Stack.Screen").find((props) => props.name === route).options.headerShown, false);
    assert.equal(typeof editHeader(screen).options.headerRight, "function");
    assert.equal(deleteButton(screen), undefined); assert.equal(screen.one("TextInput"), undefined);
    const overlay = screen.all("View").find((props) => props.testID === "schedule-edit-loading-overlay");
    const style = flatStyle(overlay.style); assert.equal(style.position, "absolute");
    assert.equal(style.alignItems, "center"); assert.equal(style.justifyContent, "center");
    assert.deepEqual([style.top, style.right, style.bottom, style.left], [0, 0, 0, 0]);
    assert.equal(screen.one("ActivityIndicator").color, "#FB6C2D"); assert.equal(states(screen).includes("loading"), false);
    const contentStyle = editContent(screen).style, content = screen.instance("ScheduleEditContent");
    await h.settle(); h.detail(0, dto(id)); await h.settle();
    assert.equal(screen.one("TextInput").value, id); assert.equal(screen.one("ActivityIndicator"), undefined);
    assert.deepEqual(editContent(screen).style, contentStyle); assert.strictEqual(screen.instance("ScheduleEditContent"), content);
    assert.ok(editHeader(screen)); assert.equal(deleteButton(screen).disabled, false);
  } finally { h.close(); }
});

test("UI 목록·캘린더 캐시 수정 진입과 GET 재조회는 스피너 없이 폼·입력·Picker 보존", async () => {
  for (const origin of ["index", "calendar"]) {
    const h = harness("server"); try {
      const id = randomUUID(); h.mount(origin); await h.settle(); h.respond(0, [dto(id)]); await h.settle();
      const screen = h.mount("detail", id), form = screen.instance("ScheduleEditForm"), content = screen.instance("ScheduleEditContent");
      assert.equal(screen.one("TextInput").value, id); assert.equal(screen.one("ActivityIndicator"), undefined);
      editTitle(h, screen, "보존할 입력"); screen.one("ScheduleDateField").onPress(); h.flush();
      const picker = screen.one("DateTimePicker").value, scrollStyle = screen.one("ScrollView").contentContainerStyle;
      await h.settle(); assert.equal(h.calls.length, 2); assert.equal(screen.one("ActivityIndicator"), undefined);
      h.detail(1, { ...dto(id), title: "새 서버 제목" }); await h.settle();
      assert.equal(screen.one("TextInput").value, "보존할 입력"); assert.equal(saveButton(screen).disabled, false);
      assert.strictEqual(screen.instance("ScheduleEditForm"), form); assert.strictEqual(screen.instance("ScheduleEditContent"), content); assert.ok(editHeader(screen));
      assert.strictEqual(screen.one("DateTimePicker").value, picker); assert.strictEqual(screen.one("ScrollView").contentContainerStyle, scrollStyle);
      const retry = h.server.retryDetail(id); await h.settle(); h.respond(2, [], 500); await retry; await h.settle();
      assert.equal(screen.one("TextInput").value, "보존할 입력"); assert.equal(screen.one("ActivityIndicator"), undefined);
      assert.ok(states(screen).includes("error")); screen.one("ScheduleListState").onRetry(); await h.settle();
      h.detail(3, dto(id)); await h.settle(); assert.strictEqual(screen.instance("ScheduleEditForm"), form);
      assert.equal(screen.one("TextInput").value, "보존할 입력"); assert.ok(h.calls.every((call) => call.method === "GET"));
    } finally { h.close(); }
  }
});

test("UI native Header 아래 폼은 기존 하단 Safe Area만 사용하고 별도 Header 높이·inset 보정 없음", () => {
  const h = harness("mock"); try {
    const screen = h.mount("detail", mockId), form = screen.instance("ScheduleEditForm");
    assert.deepEqual(screen.all("SafeAreaView").map((props) => props.edges), [["bottom"]]);
    assert.equal(screen.all("SafeAreaView").some((props) => props.testID === "schedule-edit-header"), false);
    editTitle(h, screen, "키보드 입력");
    assert.equal(screen.one("KeyboardAvoidingView").keyboardVerticalOffset, undefined);
    assert.equal(screen.one("ScrollView").contentInsetAdjustmentBehavior, undefined); assert.equal(screen.one("ScrollView").automaticallyAdjustKeyboardInsets, undefined);
    assert.strictEqual(screen.instance("ScheduleEditForm"), form); assert.equal(screen.one("TextInput").value, "키보드 입력");
    assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});

test("UI 완료 PATCH true/false 처리·후속 GET 동안 스피너와 가짜 오류·상단 레이아웃 삽입 없음", async () => {
  const h = harness("server"); try {
    const id = randomUUID(), { list, calendar } = await completionScreens(h, [dto(id)]);
    for (const completed of [true, false]) {
      const start = h.calls.length;
      listCard(list).onToggleCompleted(); calendar.all("ScheduleCard")[0].onToggleCompleted(); h.flush();
      assertStableCards(list, calendar); assert.deepEqual(states(list), []); assert.deepEqual(states(calendar), []);
      assert.equal(listCard(list).schedule.completed, completed); assert.equal(calendar.all("ScheduleCard")[0].schedule.completed, completed);
      await h.settle(); assert.deepEqual(JSON.parse(h.calls[start].body), { completed });
      h.detail(start, dto(id, "INVENTORY", completed)); await h.settle();
      assertStableCards(list, calendar); assert.deepEqual(states(list), []); assert.deepEqual(states(calendar), []);
      await respondLists(h, start + 1, [dto(id, "INVENTORY", completed)]);
      assert.equal(feedbackPanel(list), undefined); assert.equal(feedbackPanel(calendar), undefined);
    }
    assert.equal(patches(h).length, 2);
  } finally { h.close(); }
});

test("UI mutation이 진행 중 GET을 취소해도 오류를 만들지 않고 늦은 응답은 무시", async () => {
  const h = harness("server"); try {
    const id = randomUUID(), { list, calendar } = await completionScreens(h, [dto(id)]);
    const query = h.source("src/utils/schedule-query.ts").getMainScheduleRange(new Date("2026-11-07T03:00:00Z"));
    const retry = h.server.retry(query); await h.settle();
    assertStableCards(list, calendar); listCard(list).onToggleCompleted(); await h.settle();
    assert.equal(h.calls[2].signal.aborted, true); assert.deepEqual(states(list), []); assertStableCards(list, calendar);
    h.respond(2, [dto(id)]); await retry; await h.settle();
    assert.equal(listCard(list).schedule.completed, true); assert.deepEqual(states(list), []);
    h.detail(3, dto(id, "INVENTORY", true)); await h.settle(); await respondLists(h, 4, [dto(id, "INVENTORY", true)]);
    assert.equal(listCard(list).schedule.completed, true); assert.equal(calendar.all("ScheduleCard")[0].schedule.completed, true);
  } finally { h.close(); }
});

test("UI PATCH 성공 뒤 GET 실패는 중복 오류 없이 하단에서 안내하고 실패한 GET만 재시도", async () => {
  const h = harness("server"); try {
    const id = randomUUID(), { list, calendar } = await completionScreens(h, [dto(id)]);
    listCard(list).onToggleCompleted(); await h.settle(); h.detail(2, dto(id, "INVENTORY", true)); await h.settle();
    h.respond(3, [], 500); h.respond(4, [dto(id, "INVENTORY", true)]); await h.settle();
    assertStableCards(list, calendar); assert.equal(listCard(list).schedule.completed, true);
    assert.equal(list.all("ScheduleListState").length, 1); assert.equal(completionNotice(list).state, "error");
    assert.match(completionNotice(list).errorTitle, /변경되었지만 목록/); assert.ok(feedbackPanel(list)); assert.ok(feedbackPanel(calendar));
    assert.equal(completionNotice(list).retryLabel, "GET 상태 확인");
    completionNotice(list).onRetry(); completionNotice(calendar).onRetry(); await h.settle();
    assert.equal(h.calls.length, 6); assert.equal(h.calls[5].method, "GET"); assert.equal(h.calls[5].url, h.calls[3].url);
    assertStableCards(list, calendar); h.respond(5, [dto(id, "INVENTORY", true)]); await h.settle();
    assert.equal(patches(h).length, 1); assert.equal(feedbackPanel(list), undefined);
  } finally { h.close(); }
});

test("UI PATCH 확정 거절은 rollback과 오류를 유지하며 불확실 GET 확인은 성공 오류로 단정하지 않음", async () => {
  for (const outcome of ["rejected", "uncertain", "malformed-422"]) {
    const h = harness("server"); try {
      const id = randomUUID(), { list, calendar } = await completionScreens(h, [dto(id)]);
      listCard(list).onToggleCompleted(); await h.settle();
      if (outcome === "rejected") h.detail(2, validationProblem(), 422, "application/problem+json");
      else if (outcome === "malformed-422") h.detail(2, { ...notFoundProblem(), status: 422, code: "VALIDATION_ERROR" }, 422, "application/problem+json");
      else h.detail(2, { invalid: true });
      await h.settle(); assertStableCards(list, calendar); assert.equal(listCard(list).schedule.completed, false);
      assert.equal(Object.values(h.server.store.getState().servers)[0].mutations[id].phase, outcome === "rejected" ? "error" : "uncertain");
      assert.equal(completionNotice(list).state, "error"); assert.ok(feedbackPanel(list)); assert.equal(list.all("ScheduleListState").length, 1);
      completionNotice(list).onRetry(); await h.settle();
      if (outcome !== "rejected") { h.detail(3, dto(id, "INVENTORY", true)); await h.settle(); }
      await respondLists(h, outcome !== "rejected" ? 4 : 3, [dto(id, "INVENTORY", outcome !== "rejected")]);
      assert.equal(patches(h).length, 1);
      if (outcome !== "rejected") {
        assert.equal(completionNotice(list).state, "notice"); assert.match(completionNotice(list).errorTitle, /이전 PATCH의 성공 여부를 뜻하지/);
      } else assert.equal(completionNotice(list), undefined);
    } finally { h.close(); }
  }
});

test("UI 독립적인 GET 오류는 카드 위 배치 없이 표시하고 GET Retry만 실행", async () => {
  const h = harness("server"); try {
    const { list, calendar } = await completionScreens(h);
    const query = h.source("src/utils/schedule-query.ts").getMainScheduleRange(new Date("2026-11-07T03:00:00Z"));
    const retry = h.server.retry(query); await h.settle(); assertStableCards(list, calendar);
    h.respond(2, [], 500); await retry; await h.settle();
    assertStableCards(list, calendar); assert.ok(feedbackPanel(list)); assert.match(list.one("ScheduleListState").errorTitle, /최신/);
    list.one("ScheduleListState").onRetry(); await h.settle(); h.respond(3, [dto("target")]); await h.settle();
    assert.equal(feedbackPanel(list), undefined); assert.ok(h.calls.every((call) => call.method === "GET"));
  } finally { h.close(); }
});

test("UI 수정 GET가 mutation으로 취소되면 가짜 오류 대신 GET 확인 제공, Header·입력 유지", async () => {
  const h = harness("server"); try {
    const id = randomUUID(), { list } = await completionScreens(h, [dto(id)]), screen = h.mount("detail", id);
    editTitle(h, screen, "진행 중 입력"); await h.settle();
    listCard(list).onToggleCompleted(); await h.settle(); assert.equal(h.calls[2].signal.aborted, true);
    h.detail(3, validationProblem(), 422, "application/problem+json"); await h.settle();
    assert.equal(screen.one("ScheduleListState").state, "notice"); assert.ok(editHeader(screen));
    assert.equal(screen.one("ActivityIndicator"), undefined); assert.equal(screen.one("TextInput").value, "진행 중 입력");
    screen.one("ScheduleListState").onRetry(); await h.settle(); h.detail(4, dto(id)); await h.settle();
    assert.equal(screen.one("TextInput").value, "진행 중 입력"); assert.equal(saveButton(screen).disabled, false); assert.equal(patches(h).length, 1);
  } finally { h.close(); }
});

test("UI native Header 옵션은 서버 404·네트워크 오류·GET Retry에도 등록되며 본문 수명 유지", async () => {
  for (const outcome of ["404", "network"]) {
    const h = harness("server"); try {
      const id = randomUUID(), screen = h.mount("detail", id), content = screen.instance("ScheduleEditContent"); await h.settle();
      if (outcome === "404") h.detail(0, notFoundProblem(), 404, "application/problem+json");
      else { h.calls[0].reject(new Error("memory")); await h.settle(); h.calls[1].reject(new Error("memory")); }
      await h.settle(); assert.ok(editHeader(screen)); assert.strictEqual(screen.instance("ScheduleEditContent"), content);
      assert.equal(editHeader(screen).options.headerShown, undefined); assert.equal(deleteButton(screen), undefined);
      assert.ok(states(screen).includes("error")); assert.equal(screen.one("ActivityIndicator"), undefined);
      const next = h.calls.length; screen.one("ScheduleListState").onRetry(); await h.settle();
      assert.ok(screen.one("ActivityIndicator")); assert.ok(editHeader(screen)); assert.strictEqual(screen.instance("ScheduleEditContent"), content);
      h.detail(next, dto(id)); await h.settle(); assert.ok(editHeader(screen)); assert.equal(deleteButton(screen).disabled, false);
      h.back(); assert.deepEqual(h.navigations, ["back"]);
    } finally { h.close(); }
  }
});

test("UI Mock/server 목록·캘린더 20회 반복 진입·복귀와 native Header 옵션·중복 push 차단", async () => {
  for (const mode of ["mock", "server"]) for (const origin of ["index", "calendar"]) {
    const h = harness(mode); try {
      const list = h.mount(origin); await h.settle();
      if (mode === "server") { h.respond(0, [dto(randomUUID())]); await h.settle(); }
      else if (origin === "calendar") { list.one("MonthCalendar").onSelectDate({ dateString: "2026-09-30" }); h.flush(); }
      for (let index = 0; index < 20; index++) {
        const card = origin === "index" ? listCard(list) : list.one("ScheduleCard");
        card.onPress(); card.onPress(); list.focus(false); card.onPress();
        assert.equal(h.navigations.filter((nav) => typeof nav === "object").length, index + 1);
        const start = h.calls.length, screen = h.mount("detail", card.schedule.id); await h.settle();
        if (h.calls.length > start) { h.detail(start, dto(card.schedule.id)); await h.settle(); }
        assert.ok(editHeader(screen)); assert.ok(deleteButton(screen)); assert.equal(editHeader(screen).options.headerShown, undefined);
        h.back(); screen.close();
        assert.equal(h.navigations.filter((nav) => nav === "back").length, index + 1); list.focus(true);
      }
      assert.ok(h.calls.every((call) => call.method === "GET"));
    } finally { h.close(); }
  }
});

test("UI 캘린더 별도 월 캐시의 배경 GET 실패도 선택 날짜 카드 위에 상태 UI를 삽입하지 않음", async () => {
  const h = harness("server"); try {
    const id = randomUUID(), calendar = h.mount("calendar"); await h.settle(); h.respond(0, [dto(id)]); await h.settle();
    calendar.one("MonthCalendar").onMonthChange({ dateString: "2026-12-01" }); await h.settle();
    const december = { ...dto(randomUUID()), scheduledAt: "2026-12-07T03:00:00Z" };
    h.respond(1, [december]); await h.settle();
    const dates = calendar.one("MonthCalendar").scheduleDates;
    const query = h.source("src/utils/schedule-query.ts").getCalendarScheduleRange("2026-12-01");
    const retry = h.server.retry(query); await h.settle();
    assert.equal(states(calendar).includes("loading"), false); assert.equal(feedbackPanel(calendar), undefined);
    assert.equal(calendar.one("ScheduleCard").schedule.id, id); h.respond(2, [], 500); await retry; await h.settle();
    assert.ok(feedbackPanel(calendar)); assert.equal(calendar.one("ScheduleCard").schedule.id, id);
    assert.deepEqual(calendar.one("MonthCalendar").scheduleDates, dates);
    const content = calendar.one("ScrollView").children;
    assert.equal(content.some((node) => node?.type === "ScheduleListState"), false);
    calendar.one("ScheduleListState").onRetry(); await h.settle(); h.respond(3, [december]); await h.settle();
    assert.equal(feedbackPanel(calendar), undefined); assert.ok(h.calls.every((call) => call.method === "GET"));
  } finally { h.close(); }
});

test("UI route·서버·모드 변경 시 이전 폼 노출 없이 native Header 옵션 유지와 늦은 GET 무효화", async () => {
  const h = harness("server"); try {
    h.mount("index"); await h.settle(); h.respond(0, [{ ...dto(mockId), title: "이전 서버 데이터" }]); await h.settle();
    const screen = h.mount("detail", mockId); await h.settle();
    assert.equal(screen.one("TextInput").value, "이전 서버 데이터"); const next = randomUUID();
    screen.route(next); await h.settle(); assert.deepEqual(h.navigations, []);
    assert.ok(editHeader(screen)); assert.equal(screen.one("TextInput"), undefined); assert.ok(screen.one("ActivityIndicator"));
    h.detail(1, { ...dto(mockId), title: "늦은 이전 일정" }); await h.settle(); assert.equal(screen.one("TextInput"), undefined);
    const serverStart = h.calls.length; h.config("https://other.example.invalid"); await h.settle();
    h.detail(2, { ...dto(next), title: "늦은 이전 서버" }); await h.settle(); assert.equal(screen.one("TextInput"), undefined);
    for (let index = serverStart; index < h.calls.length; index++) {
      if (new URL(h.calls[index].url).pathname.endsWith(`/${next}`)) h.detail(index, { ...dto(next), title: "현재 서버 데이터" });
      else h.respond(index, []);
    }
    await h.settle();
    assert.ok(editHeader(screen)); assert.equal(screen.one("TextInput").value, "현재 서버 데이터");
    h.mode("mock"); screen.route(mockId); await h.settle();
    assert.ok(editHeader(screen)); assert.equal(screen.one("ActivityIndicator"), undefined);
    assert.equal(screen.one("TextInput").value, h.mock.getState().schedules.find((schedule) => schedule.id === mockId).title);
    assert.ok(h.calls.every((call) => call.method === "GET"));
  } finally { h.close(); }
});

test("K 기본 전송은 GET의 기존 fetch를 유지하고 모든 Schedule 쓰기는 Expo fetch의 redirect error 사용", async () => {
  const target = randomUUID();
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const h = harness("server"); try {
      // fetchImpl을 주입하지 않은 제품 기본 경로를 실행하되 두 transport는 모두 메모리 대역이다.
      const client = h.source("src/services/api/http.ts").createScheduleHttpClient();
      const read = client.request({ path: `/schedules/${target}` }); await h.settle();
      assert.equal(h.calls[0].transport, "global"); assert.equal(h.calls[0].redirect, "follow"); h.detail(0, dto(target)); await read;
      const write = client.request({ method, path: method === "POST" ? "/schedules" : `/schedules/${target}` }); await h.settle();
      assert.equal(h.calls[1].transport, "expo"); assert.equal(h.calls[1].redirect, "error");
      if (method === "DELETE") noContent(h, 1); else h.detail(1, dto(target), method === "POST" ? 201 : 200);
      assert.equal((await write).ok, true);
    } finally { h.close(); }
  }
});
