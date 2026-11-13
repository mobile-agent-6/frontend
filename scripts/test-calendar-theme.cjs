/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const library = path.join(root, "node_modules/react-native-calendars/src");
const flat = (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

// 앱의 실제 wrapper와 설치된 라이브러리의 스타일 생성자를 실행한다. native 렌더링 검증은 아니다.
function harness(initialScheme = "light") {
  const modules = new Map();
  let scheme = initialScheme;
  const native = { StyleSheet: { create: (styles) => styles, hairlineWidth: 0.5 },
    Platform: { OS: "ios", select: (options) => options.ios ?? options.default },
    I18nManager: { isRTL: false }, Dimensions: { get: () => ({ width: 390, height: 844 }) } };
  const locale = { locales: { "": {} } };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [2026, 10, 13, 12])); } }
  function load(name, parent = root) {
    if (name === "react") return { useMemo: (fn) => fn() };
    if (name === "react/jsx-runtime") return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
    if (name === "react-native") return native;
    if (name === "react-native-calendars") return { Calendar: "Calendar", LocaleConfig: locale };
    if (name === "expo-symbols") return { SymbolView: "SymbolView" };
    if (name === "@/global.css") return {};
    if (name === "@/hooks/use-color-scheme") return { useColorScheme: () => scheme };
    if (name === "@/components/ui/themed-text") return { ThemedText: "ThemedText" };
    assert.doesNotMatch(name, /services|stores|storage|fetch/);
    const base = name.startsWith("@/") ? path.join(root, "src", name.slice(2)) : path.resolve(parent, name);
    const file = [base, base + ".ts", base + ".tsx", base + ".js"].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    assert.ok(file, name);
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    }, fileName: file }).outputText;
    new Function("require", "module", "exports", "Date", code)((request) => load(request, path.dirname(file)), module, module.exports, FixedDate);
    return module.exports;
  }
  const render = (props) => load("@/components/calendar/month-calendar").MonthCalendar(props);
  const styles = (element) => ({
    calendar: load(path.join(library, "calendar/style.js")).default(element.props.theme),
    header: load(path.join(library, "calendar/header/style.js")).default(element.props.theme),
    day: load(path.join(library, "calendar/day/basic/style.js")).default(element.props.theme),
  });
  return { render, styles, locale, colors: load("@/constants/theme").Colors, scheme: (value) => { scheme = value; } };
}
const noop = () => {};
const props = { visibleMonth: "2026-11-01", selectedDate: "2026-11-16", scheduleDates: ["2026-11-13", "2026-11-14", "2026-11-16"], onSelectDate: noop, onMonthChange: noop };

test("다크 달력의 날짜 영역·월 제목·요일·날짜·화살표에 실제 테마 토큰 적용", () => {
  const h = harness("dark"), element = h.render(props), { calendar, header, day } = h.styles(element), colors = h.colors.dark;
  assert.equal(calendar.container.backgroundColor, colors.background);
  assert.equal(calendar.monthView.backgroundColor, colors.background);
  assert.equal(header.monthText.color, colors.text); assert.equal(day.text.color, colors.text);
  assert.equal(header.dayHeader.color, colors.textSecondary);
  assert.equal(flat(element.props.style).backgroundColor, colors.background);
  for (const direction of ["left", "right"]) {
    const arrow = element.props.renderArrow(direction);
    assert.equal(arrow.props.tintColor, colors.textSecondary);
    assert.equal(arrow.props.fallback.props.themeColor, "textSecondary");
    assert.equal(arrow.props.size, 16);
  }
});

test("다크 이전·다음 달 및 비활성 날짜는 투명도를 낮추지 않은 보조 글자색으로 구분", () => {
  const h = harness("dark"), { day } = h.styles(h.render(props));
  assert.equal(day.disabledText.color, h.colors.dark.textSecondary);
  assert.equal(day.inactiveText.color, h.colors.dark.textSecondary);
  assert.notEqual(day.disabledText.color, day.text.color);
});

test("라이트 달력의 기존 색상·글자 크기·레이아웃 유지", () => {
  const h = harness(), element = h.render(props), { calendar, header, day } = h.styles(element), colors = h.colors.light;
  assert.equal(calendar.monthView.backgroundColor, "#ffffff");
  assert.equal(header.monthText.color, "#000000"); assert.equal(day.text.color, "#000000");
  assert.equal(header.dayHeader.color, colors.textSecondary);
  assert.equal(day.disabledText.color, `${colors.textSecondary}80`);
  assert.equal(element.props.theme.textInactiveColor, undefined);
  assert.equal(header.monthText.fontSize, 18); assert.equal(header.monthText.fontWeight, "700");
  assert.equal(day.text.fontSize, 14); assert.equal(day.text.fontWeight, "400");
  assert.equal(flat(element.props.style).borderRadius, 24);
  assert.equal(flat(element.props.style).paddingHorizontal, 16); assert.equal(flat(element.props.style).paddingVertical, 16);
  assert.equal(element.props.headerStyle.marginBottom, 8);
  assert.equal(header.week.marginTop, 15); assert.equal(calendar.week.marginVertical, 8);
});

for (const scheme of ["light", "dark"]) test(`${scheme} 선택 날짜·오늘·일정 dot와 주말 강조 유지`, () => {
  const h = harness(scheme), element = h.render(props), { day, header } = h.styles(element), colors = h.colors[scheme];
  assert.equal(day.selected.backgroundColor, colors.primary); assert.equal(day.selectedText.color, colors.primaryForeground);
  assert.equal(day.today.backgroundColor, colors.primaryMuted); assert.equal(day.todayText.color, colors.primary);
  assert.equal(element.props.theme.dotColor, colors.primary); assert.equal(element.props.theme.selectedDotColor, colors.primaryForeground);
  assert.equal(element.props.markedDates["2026-11-13"].marked, true);
  assert.equal(element.props.markedDates["2026-11-13"].customStyles, undefined);
  assert.deepEqual(element.props.markedDates[props.selectedDate], { marked: true, selected: true });
  assert.equal(header.dayTextAtIndex0.color, colors.destructive); assert.equal(header.dayTextAtIndex6.color, "#0EA5E9");
  assert.equal(element.props.markedDates["2026-11-14"].customStyles.text.color, "#0EA5E9");
});

test("테마 전환에만 캐시 갱신 key 변경, 기존 표시 월·선택·callback·마킹 보존", () => {
  const h = harness();
  let selections = 0, months = 0;
  const current = { ...props, visibleMonth: "2027-04-01", selectedDate: "2027-04-09", onSelectDate: () => { selections++; }, onMonthChange: () => { months++; } };
  const light = h.render(current); h.scheme("dark"); const dark = h.render(current);
  assert.notEqual(dark.key, light.key);
  assert.equal(h.styles(light).calendar.monthView.backgroundColor, h.colors.light.background);
  assert.equal(h.styles(dark).calendar.monthView.backgroundColor, h.colors.dark.background);
  assert.equal(h.styles(dark).header.monthText.color, h.colors.dark.text);
  assert.equal(dark.props.initialDate, current.visibleMonth);
  assert.deepEqual(dark.props.markedDates, light.props.markedDates);
  assert.strictEqual(dark.props.onDayPress, current.onSelectDate); assert.strictEqual(dark.props.onMonthChange, current.onMonthChange);
  assert.equal(h.render({ ...current, visibleMonth: "2027-05-01" }).key, dark.key);
  assert.deepEqual([selections, months], [0, 0]);
  dark.props.onDayPress({ dateString: "2027-04-10" }); dark.props.onMonthChange({ dateString: "2027-05-01" });
  assert.deepEqual([selections, months], [1, 1]);
  h.scheme("light"); assert.equal(h.render(current).key, light.key);
});
