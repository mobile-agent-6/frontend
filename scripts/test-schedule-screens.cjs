/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");

// 실제 화면·Hook·서비스를 실행하되 native 컴포넌트와 React 실행기만 메모리 대역으로 둔다.
// native 렌더링·레이아웃·아이폰 통신을 검증하는 테스트는 아니다.
function harness(initialMode) {
  const modules = new Map(), screens = [], calls = [], navigations = [];
  let current;
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
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
      if (name === "zustand/vanilla") return require(name);
      if (name === "zustand") return { useStore, create: (initializer) => {
        const store = require("zustand/vanilla").createStore(initializer);
        return Object.assign((select) => useStore(store, select), store);
      } };
      if (name === "expo-router") return { Stack: { Screen: "Stack.Screen" },
        useLocalSearchParams: () => ({ id: (current.root ?? current).routeId }),
        useRouter: () => ({ push: (route) => navigations.push(route), back: () => navigations.push("back") }) };
      if (name === "expo-symbols") return { SymbolView: "SymbolView" };
      if (name === "expo-crypto") return { randomUUID: require("node:crypto").randomUUID };
      if (name === "@/constants/theme") return { Spacing: {}, BottomTabInset: 0 };
      if (name === "react-native") return { ...Object.fromEntries(["FlatList", "Pressable", "View", "ScrollView", "TextInput", "KeyboardAvoidingView"].map((s) => [s, s])),
        Platform: { OS: "ios" }, Keyboard: { dismiss() {} }, StyleSheet: { create: (s) => s } };
      if (name === "@expo/ui/community/datetime-picker") return { DateTimePicker: "DateTimePicker" };
      if (name === "react-native-safe-area-context") return { SafeAreaView: "SafeAreaView" };
      if (name === "@/components/schedule-edit/schedule-edit-form") return source("src/components/schedule-edit/schedule-edit-form.tsx");
      if (name === "@/components/schedule-create/schedule-create-form") return source("src/components/schedule-create/schedule-create-form.tsx");
      if (name.startsWith("@/components/")) {
        const component = name.split("/").at(-1).split("-").map((s) => s[0].toUpperCase() + s.slice(1)).join("");
        return { [component]: component };
      }
      if (name === "@/hooks/use-theme") return { useTheme: () => ({ background: "white" }) };
      if (name === "@/hooks/use-color-scheme") return { useColorScheme: () => "light" };
      assert.ok(name.startsWith("@/")); return source(`src/${name.slice(2)}.ts`);
    };
    new Function("require", "module", "exports", "fetch", "Date", "process", code)(resolve, module, module.exports,
      () => { throw new Error("실제 네트워크 요청 금지"); }, FixedDate,
      { env: { EXPO_PUBLIC_SCHEDULE_DATA_MODE: initialMode } });
    return module.exports;
  }
  const configModule = source("src/services/api/config.ts");
  let config = configModule.parseDevelopmentServerConfig("https://example.invalid");
  configModule.getDevelopmentServerConfig = () => config;
  const http = source("src/services/api/http.ts");
  http.scheduleHttpClient = http.createScheduleHttpClient({ readConfig: () => config, fetchImpl: (url, options) =>
    new Promise((resolve, reject) => calls.push({ url, ...options, resolve, reject })) });
  const mode = source("src/stores/scheduleDataModeStore.ts").scheduleDataModeStore;
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
    const s = { slots: [], effects: [], children: new Map(), dirty: true, routeId,
      Screen: source(kind === "detail" ? "src/app/schedule/[id].tsx" : kind === "create" ? "src/app/schedule/create.tsx" : `src/app/(tabs)/${kind}.tsx`).default };
    screens.push(s); flush();
    return { all: (type) => nodes(s.tree, type), one: (type) => nodes(s.tree, type)[0],
      route(id) { s.routeId = id; s.dirty = true; flush(); },
      close() { s.closed = true; s.slots.forEach((slot) => slot?.cleanup?.());
        s.children.forEach((child) => child.slots.forEach((slot) => slot?.cleanup?.())); } };
  }
  return { mount, calls, mock, server, flush, source, navigations,
    mode(value) { mode.getState().setMode(value); flush(); },
    config(value) { config = configModule.parseDevelopmentServerConfig(value); screens.forEach((s) => { s.dirty = true; }); flush(); },
    async settle() { for (let i = 0; i < 4; i++) { await new Promise(setImmediate); flush(); } },
    respond(index, items, status = 200) { calls[index].resolve(new Response(JSON.stringify({ items }), { status,
      headers: { "Content-Type": "application/json" } })); },
    detail(index, value, status = 200, media = "application/json") { calls[index].resolve(new Response(JSON.stringify(value), {
      status, headers: { "Content-Type": media } })); },
    close() { for (const s of screens) { s.closed = true; s.slots.forEach((slot) => slot?.cleanup?.());
      s.children.forEach((child) => child.slots.forEach((slot) => slot?.cleanup?.())); } mode.getState().setMode("mock"); },
  };
}
const dto = (id, category = "INVENTORY", completed = false) => ({ id, title: id, category, completed,
  scheduledAt: "2026-11-07T03:00:00Z", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" });
const states = (screen) => screen.all("ScheduleListState").map((s) => s.state);

test("기본 Mock 두 화면·CRUD·완료 변경과 서버 요청 0회", async () => {
  const h = harness(); try {
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
test("서버 메인 3개월·서버 순서·로컬 카테고리 필터·완료 차단", async () => {
  const h = harness(); try {
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
  const h = harness(); try {
    h.mode("server"); const list = h.mount("index"); await h.settle(); h.respond(0, [], 500); await h.settle();
    assert.ok(states(list).includes("error")); assert.ok(!states(list).includes("empty"));
    list.all("ScheduleListState").find((s) => s.state === "error").onRetry(); await h.settle();
    h.respond(1, []); await h.settle(); assert.ok(states(list).includes("empty")); assert.ok(h.calls.every((c) => c.method === "GET"));
  } finally { h.close(); }
});
test("재조회 loading·실패에도 마지막 성공 카드와 오류 보존", async () => {
  const h = harness(); try {
    h.mode("server"); const list = h.mount("index"); await h.settle(); h.respond(0, [dto("kept")]); await h.settle();
    const q = h.source("src/utils/schedule-query.ts").getMainScheduleRange(new Date("2026-11-07T03:00:00Z"));
    const retry = h.server.retry(q); await h.settle(); assert.equal(list.one("FlatList").data[0].id, "kept");
    assert.ok(states(list).includes("loading")); h.respond(1, [], 500); await retry; await h.settle();
    assert.equal(list.one("FlatList").data[0].id, "kept"); assert.ok(states(list).includes("error"));
  } finally { h.close(); }
});
test("캘린더 표시 월·완료 dot·선택 카드 순서 및 월 이동 시 선택 날짜 유지", async () => {
  const h = harness(); try {
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
  const h = harness(); try {
    h.mode("server"); const cal = h.mount("calendar"); await h.settle(); h.respond(0, []); await h.settle();
    cal.one("MonthCalendar").onSelectDate({ dateString: "2027-03-12" }); h.flush(); await h.settle();
    assert.equal(h.calls.length, 2); assert.ok(states(cal).includes("loading"));
    h.respond(1, [], 500); await h.settle(); assert.ok(states(cal).includes("error"));
    assert.equal(cal.one("MonthCalendar").selectedDate, "2027-03-12");
  } finally { h.close(); }
});
test("메인 성공 coverage를 선택 날짜에 재사용하며 표시 월만 별도 조회", async () => {
  const h = harness(); try {
    h.mode("server"); const list = h.mount("index"); await h.settle(); h.respond(0, [dto("shared")]); await h.settle();
    const cal = h.mount("calendar"); await h.settle(); assert.equal(h.calls.length, 2);
    assert.equal(cal.all("ScheduleCard")[0].schedule.id, "shared");
    assert.strictEqual(cal.all("ScheduleCard")[0].schedule, list.one("FlatList").data[0]);
    h.respond(1, [dto("shared")]); await h.settle();
  } finally { h.close(); }
});
test("같은 월의 두 소비자는 요청 공유하며 한 화면 해제 후 유지", async () => {
  const h = harness(); try {
    h.mode("server"); const first = h.mount("calendar"), second = h.mount("calendar"); await h.settle();
    assert.equal(h.calls.length, 1); first.close(); assert.equal(h.calls[0].signal.aborted, false);
    second.close(); assert.equal(h.calls[0].signal.aborted, true);
  } finally { h.close(); }
});
test("월 이동의 늦은 응답·서버 전환·Mock 복귀 데이터 혼합 차단", async () => {
  const h = harness(); try {
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
    const h = harness(); try {
      h.config(value); h.mode("server"); const list = h.mount("index"); await h.settle();
      assert.equal(h.calls.length, 0); assert.deepEqual(list.one("FlatList").data, []);
      assert.ok(states(list).includes("error")); assert.ok(!states(list).includes("empty"));
    } finally { h.close(); }
  }
});

test("마지막 성공이 빈 배열이어도 재조회 실패를 empty로 숨기지 않음", async () => {
  const h = harness(); try {
    h.mode("server"); const list = h.mount("index"); await h.settle(); h.respond(0, []); await h.settle();
    assert.ok(states(list).includes("empty"));
    const q = h.source("src/utils/schedule-query.ts").getMainScheduleRange(new Date("2026-11-07T03:00:00Z"));
    const retry = h.server.retry(q); await h.settle(); h.respond(1, [], 500); await retry; await h.settle();
    assert.ok(states(list).includes("error")); assert.ok(!states(list).includes("empty"));
    assert.match(list.all("ScheduleListState").find((s) => s.state === "error").errorTitle, /이전 정보/);
  } finally { h.close(); }
});
test("선택 월 조회 실패 Retry는 실패 query만 재실행하고 성공 후 날짜 empty 표시", async () => {
  const h = harness(); try {
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
const saveButton = (screen) => screen.all("Button").find((p) => p.label === "수정 완료");

test("상세 Mock 수정·삭제와 모달/navigation 유지, 서버 요청 0회", async () => {
  for (const kind of ["update", "delete"]) {
    const h = harness(); try {
      const screen = h.mount("detail", mockId); await h.settle();
      if (kind === "update") {
        screen.one("TextInput").onChangeText("수정된 제목"); h.flush(); saveButton(screen).onPress(); h.flush();
        assert.equal(h.mock.getState().schedules.find((s) => s.id === mockId).title, "수정된 제목");
      } else {
        screen.one("Stack.Screen").options.headerRight().props.onPress(); h.flush();
        assert.equal(screen.one("ConfirmationModal").visible, true);
        screen.one("ConfirmationModal").onConfirm(); h.flush(); screen.one("ConfirmationModal").onDismiss(); h.flush();
        assert.equal(h.mock.getState().schedules.some((s) => s.id === mockId), false);
      }
      assert.deepEqual(h.navigations, ["back"]); assert.equal(h.calls.length, 0);
    } finally { h.close(); }
  }
});
test("cache 밖 상세 직접 진입·최초 loading·단건 성공은 월 coverage가 아님", async () => {
  const h = harness(); try {
    h.mode("server"); const screen = h.mount("detail", "opaque/id-v5"); await h.settle();
    assert.ok(states(screen).includes("loading")); assert.equal(screen.one("TextInput"), undefined);
    assert.ok(h.calls[0].url.endsWith("/schedules/opaque%2Fid-v5"));
    h.detail(0, dto("opaque/id-v5")); await h.settle(); assert.equal(screen.one("TextInput").value, "opaque/id-v5");
    const cache = Object.values(h.server.store.getState().servers)[0];
    assert.deepEqual(cache.queries, {}); assert.ok(cache.entities["opaque/id-v5"]);
  } finally { h.close(); }
});
test("SCHEDULE_NOT_FOUND와 다른 404·통신/응답 오류를 구분하고 GET-only Retry", async () => {
  for (const code of ["SCHEDULE_NOT_FOUND", "ROUTE_NOT_FOUND", "invalid-response"]) {
    const h = harness(); try {
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
  const h = harness(); try {
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
  const h = harness(); try {
    h.mode("server"); const list = h.mount("index"); await h.settle(); h.respond(0, [dto("target")]); await h.settle();
    const screen = h.mount("detail", "target"); assert.equal(screen.one("TextInput").value, "target"); await h.settle();
    assert.equal(h.calls.length, 2); h.detail(1, { ...dto("target"), title: "최신 제목" }); await h.settle();
    assert.equal(list.one("FlatList").data[0].title, "최신 제목");
    // cache를 표시한 시점에 폼 원본은 이미 고정되어 재조회로 덮어쓰지 않는다.
    assert.equal(screen.one("TextInput").value, "target");
  } finally { h.close(); }
});
test("같은 ID 상세 요청 공유와 마지막 소비자 해제 취소", async () => {
  const h = harness(); try {
    h.mode("server"); const a = h.mount("detail", "target"), b = h.mount("detail", "target"); await h.settle();
    assert.equal(h.calls.length, 1); a.close(); assert.equal(h.calls[0].signal.aborted, false);
    b.close(); assert.equal(h.calls[0].signal.aborted, true);
  } finally { h.close(); }
});
test("상세 route ID 변경 시 데이터·폼 입력과 늦은 응답 분리", async () => {
  const h = harness(); try {
    h.mode("server"); const screen = h.mount("detail", "first"); await h.settle(); h.detail(0, dto("first")); await h.settle();
    screen.one("TextInput").onChangeText("이전 입력"); h.flush();
    const retry = h.server.retryDetail("first"); await h.settle(); screen.route("second"); await h.settle();
    assert.equal(screen.one("TextInput"), undefined); assert.equal(h.calls[1].signal.aborted, true);
    h.detail(2, dto("second")); h.detail(1, dto("first")); await retry; await h.settle();
    assert.equal(screen.one("TextInput").value, "second");
  } finally { h.close(); }
});
test("상세 서버 변경·Mock 복귀 시 이전 응답·입력 차단", async () => {
  const h = harness(); try {
    h.mode("server"); const screen = h.mount("detail", mockId); await h.settle(); h.detail(0, dto(mockId)); await h.settle();
    screen.one("TextInput").onChangeText("다른 서버 입력"); h.flush();
    h.config("https://other.example.invalid"); await h.settle(); assert.equal(screen.one("TextInput"), undefined);
    h.mode("mock"); await h.settle(); assert.equal(h.calls[1].signal.aborted, true);
    h.detail(1, dto(mockId)); await h.settle(); assert.equal(screen.one("TextInput").value, "A구역 재고 실사");
  } finally { h.close(); }
});
test("서버 상세의 Mock 저장·삭제·가짜 성공/navigation은 UI와 handler 양쪽에서 차단", async () => {
  const h = harness(); try {
    h.mode("server"); const before = h.mock.getState().schedules; const screen = h.mount("detail", mockId);
    await h.settle(); h.detail(0, dto(mockId)); await h.settle();
    screen.one("TextInput").onChangeText("저장 금지"); h.flush(); assert.equal(saveButton(screen).disabled, true);
    saveButton(screen).onPress();
    const deletion = screen.one("Stack.Screen").options.headerRight(); assert.equal(deletion.props.disabled, true);
    deletion.props.onPress(); screen.one("ConfirmationModal").onConfirm(); screen.one("ConfirmationModal").onDismiss(); h.flush();
    assert.strictEqual(h.mock.getState().schedules, before); assert.deepEqual(h.navigations, []);
    assert.equal(screen.one("ConfirmationModal").visible, false); assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});
test("늦은 단건 응답이 더 최신 목록 객체를 덮지 않음", async () => {
  const h = harness(); try {
    h.mode("server"); const screen = h.mount("detail", "target"); await h.settle(); const list = h.mount("index"); await h.settle();
    h.respond(1, [{ ...dto("target"), title: "최신" }]); await h.settle(); h.detail(0, { ...dto("target"), title: "과거" }); await h.settle();
    assert.equal(list.one("FlatList").data[0].title, "최신"); assert.equal(screen.one("TextInput").value, "최신");
  } finally { h.close(); }
});
test("mutation 조회 장벽 이후 이전 단건 응답을 반영하지 않음", async () => {
  const h = harness(); try {
    h.mode("server"); const screen = h.mount("detail", "target"); await h.settle(); h.server.invalidate();
    assert.equal(h.calls[0].signal.aborted, true); h.detail(0, dto("target")); await h.settle();
    assert.equal(screen.one("TextInput"), undefined);
    assert.equal(Object.values(h.server.store.getState().servers)[0].entities.target, undefined);
  } finally { h.close(); }
});
test("상세 설정 오류·잘못된 route와 응답 ID 불일치를 성공으로 처리하지 않음", async () => {
  const h = harness(); try {
    h.config(undefined); h.mode("server"); const screen = h.mount("detail", "target"); await h.settle();
    assert.ok(states(screen).includes("error")); assert.equal(h.calls.length, 0);
    h.config("https://example.invalid"); await h.settle(); h.detail(0, dto("wrong")); await h.settle();
    assert.equal(screen.one("TextInput"), undefined); assert.ok(states(screen).includes("error"));
    screen.route(["target", "other"]); await h.settle(); assert.equal(h.calls.length, 1); assert.ok(states(screen).includes("error"));
  } finally { h.close(); }
});

test("상세 네트워크 오류는 404가 아니며 제한된 retry 후 오류 표시", async () => {
  const h = harness(); try {
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
  const h = harness(); try {
    h.mode("server"); const screen = h.mount("detail", "target"); await h.settle();
    t.mock.timers.tick(10_000); await h.settle(); t.mock.timers.tick(10_000); await h.settle();
    assert.equal(h.calls.length, 2); assert.equal(states(screen).includes("loading"), false);
    assert.equal(screen.all("ScheduleListState").find((p) => p.state === "error").errorTitle, "일정을 불러오지 못했어요.");
    assert.equal(Object.values(h.server.store.getState().servers)[0].details.target.error.kind, "timeout");
  } finally { h.close(); }
});
test("더 최신 단건 이후 늦은 목록은 공유 객체를 되돌리지 않음", async () => {
  const h = harness(); try {
    h.mode("server"); const list = h.mount("index"); await h.settle(); const screen = h.mount("detail", "target"); await h.settle();
    h.detail(1, { ...dto("target"), title: "최신 단건" }); await h.settle();
    h.respond(0, [{ ...dto("target"), title: "과거 목록" }]); await h.settle();
    assert.equal(list.one("FlatList").data[0].title, "최신 단건"); assert.equal(screen.one("TextInput").value, "최신 단건");
  } finally { h.close(); }
});

test("모드 환경변수 미설정·mock·잘못된 값은 최초 렌더부터 Mock", async () => {
  for (const value of [undefined, "mock", "invalid", "SERVER", ""]) {
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
test("추가 화면 직접 진입은 서버 모드에서 저장 버튼·handler·가짜 navigation 차단", async () => {
  const h = harness("server"); try {
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
    assert.ok(screen.all("ThemedText").some((p) => String(p.children).includes("서버 조회만")));
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
test("서버 Schedule 서비스 직접 POST·PATCH·DELETE는 미전송으로 차단", async () => {
  const h = harness("server"); try {
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
test("쓰기 첫 시도 후 서버 모드로 변경되면 자동 retry 차단 및 불확실 결과 보존", async () => {
  const h = harness("mock"); try {
    const prepared = h.source("src/services/api/schedules.ts").prepareScheduleUpdate("target", { title: "검증" });
    const pending = prepared.operation.submit(); await h.settle(); assert.equal(h.calls.length, 1);
    h.mode("server"); h.calls[0].reject(new Error("메모리 네트워크 오류")); await pending;
    const result = await pending; assert.equal(result.outcome, "uncertain"); assert.equal(result.requiresReconciliation, true);
    assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});
