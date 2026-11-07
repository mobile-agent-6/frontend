/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");

// 실제 화면·Hook·서비스를 실행하되 native 컴포넌트와 React 실행기만 메모리 대역으로 둔다.
// native 렌더링·레이아웃·아이폰 통신을 검증하는 테스트는 아니다.
function harness() {
  const modules = new Map(), screens = [], calls = [], navigations = [];
  let current;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const owner = current, index = owner.cursor++;
      owner.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [owner.slots[index].value, (next) => {
        const value = typeof next === "function" ? next(owner.slots[index].value) : next;
        if (!Object.is(value, owner.slots[index].value)) { owner.slots[index].value = value; owner.dirty = true; }
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
    react.useEffect(() => store.subscribe(() => { owner.dirty = true; }), [store]);
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
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === "zustand/vanilla") return require(name);
      if (name === "zustand") return { useStore, create: (initializer) => {
        const store = require("zustand/vanilla").createStore(initializer);
        return Object.assign((select) => useStore(store, select), store);
      } };
      if (name === "expo-router") return { useRouter: () => ({ push: (route) => navigations.push(route) }) };
      if (name === "expo-symbols") return { SymbolView: "SymbolView" };
      if (name === "expo-crypto") return { randomUUID: require("node:crypto").randomUUID };
      if (name === "@/constants/theme") return { Spacing: {}, BottomTabInset: 0 };
      if (name === "react-native") return { ...Object.fromEntries(["FlatList", "Pressable", "View", "ScrollView"].map((s) => [s, s])), StyleSheet: { create: (s) => s } };
      if (name.startsWith("@/components/")) {
        const component = name.split("/").at(-1).split("-").map((s) => s[0].toUpperCase() + s.slice(1)).join("");
        return { [component]: component };
      }
      if (name === "@/hooks/use-theme") return { useTheme: () => ({ background: "white" }) };
      if (name === "@/hooks/use-color-scheme") return { useColorScheme: () => "light" };
      assert.ok(name.startsWith("@/")); return source(`src/${name.slice(2)}.ts`);
    };
    new Function("require", "module", "exports", "fetch", "Date", code)(resolve, module, module.exports,
      () => { throw new Error("실제 네트워크 요청 금지"); }, FixedDate);
    return module.exports;
  }
  const configModule = source("src/services/api/config.ts");
  let config = configModule.parseDevelopmentServerConfig("https://example.invalid");
  configModule.getDevelopmentServerConfig = () => config;
  const http = source("src/services/api/http.ts");
  http.scheduleHttpClient = http.createScheduleHttpClient({ readConfig: () => config, fetchImpl: (url, options) =>
    new Promise((resolve) => calls.push({ url, ...options, resolve })) });
  const mode = source("src/stores/scheduleDataModeStore.ts").scheduleDataModeStore;
  const mock = source("src/stores/scheduleStore.ts").useScheduleStore;
  const server = source("src/stores/serverScheduleStore.ts").serverScheduleStore;
  function flush() {
    let limit = 40;
    do {
      for (const s of screens.filter((s) => s.dirty && !s.closed)) {
        current = s; s.dirty = false; s.cursor = 0; s.tree = s.Screen();
        while (s.effects.length) s.effects.shift()();
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
  function mount(kind) {
    const s = { slots: [], effects: [], dirty: true, Screen: source(`src/app/(tabs)/${kind}.tsx`).default };
    screens.push(s); flush();
    return { all: (type) => nodes(s.tree, type), one: (type) => nodes(s.tree, type)[0],
      close() { s.closed = true; s.slots.forEach((slot) => slot?.cleanup?.()); } };
  }
  return { mount, calls, mock, server, flush, source, navigations,
    mode(value) { mode.getState().setMode(value); flush(); },
    config(value) { config = configModule.parseDevelopmentServerConfig(value); screens.forEach((s) => { s.dirty = true; }); flush(); },
    async settle() { for (let i = 0; i < 4; i++) { await new Promise(setImmediate); flush(); } },
    respond(index, items, status = 200) { calls[index].resolve(new Response(JSON.stringify({ items }), { status,
      headers: { "Content-Type": "application/json" } })); },
    close() { for (const s of screens) { s.closed = true; s.slots.forEach((slot) => slot?.cleanup?.()); } mode.getState().setMode("mock"); },
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
