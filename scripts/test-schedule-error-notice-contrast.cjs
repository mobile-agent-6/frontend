/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const flat = (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

// 실제 테마 토큰·공통 오류 카드·Button을 실행한다. native 렌더링과 실제 터치는 검증하지 않는다.
function render(scheme, props) {
  const cache = new Map();
  function load(name) {
    if (name === "@/global.css") return {};
    if (name === "react-native") return { View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator",
      StyleSheet: { create: (styles) => styles, hairlineWidth: 0.5 }, Platform: { OS: "ios", select: (options) => options.ios ?? options.default } };
    if (name === "react/jsx-runtime") return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
    if (name === "expo-symbols") return { SymbolView: "SymbolView" };
    if (name === "@/hooks/use-color-scheme") return { useColorScheme: () => scheme };
    if (name === "@/hooks/use-theme") return { useTheme: () => load("@/constants/theme").Colors[scheme] };
    assert.ok(name.startsWith("@/"));
    assert.doesNotMatch(name, /services|stores|storage|fetch/);
    const base = path.join(root, "src", name.slice(2));
    const file = [base + ".tsx", base + ".ts"].find(fs.existsSync);
    assert.ok(file, name);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    }, fileName: file }).outputText;
    new Function("require", "module", "exports", code)(load, module, module.exports);
    return module.exports;
  }
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  }
  function nodes(node, type) {
    if (Array.isArray(node)) return node.flatMap((child) => nodes(child, type));
    if (!node || typeof node !== "object") return [];
    return [...(node.type === type ? [node.props] : []), ...nodes(node.props?.children, type)];
  }
  const tree = expand(load("@/components/schedule-list/schedule-error-notice").ScheduleErrorNotice(props));
  return { card: tree.props, buttons: nodes(tree, "Pressable"), spinners: nodes(tree, "ActivityIndicator"), texts: nodes(tree, "Text"),
    text: (button) => nodes(button.children, "Text")[0], theme: load("@/constants/theme").Colors[scheme] };
}

const rgb = (hex) => hex.slice(1).match(/../g).map((value) => parseInt(value, 16));
const composite = (foreground, background, opacity) => foreground.map((value, index) => value * opacity + background[index] * (1 - opacity));
function luminance(color) {
  const channels = color.map((value) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
const contrast = (a, b) => { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + 0.05) / (values[1] + 0.05); };
const first = () => {}, second = () => {};
const props = { title: "일정은 수정됐어요", description: "일정 목록과 상세 정보를 최신 상태로 불러오지 못했어요.", actions: [
  { key: "list", label: "일정 목록 다시 불러오기", onPress: first },
  { key: "detail", label: "일정 정보 다시 불러오기", onPress: second },
] };

test("라이트 복구 버튼은 기존 배경·크기·문구·눌림·비활성 스타일 유지", () => {
  const view = render("light", props);
  assert.equal(flat(view.card.style).backgroundColor, view.theme.background);
  for (const button of view.buttons) {
    const normal = flat(button.style({ pressed: false }));
    assert.equal(normal.backgroundColor, view.theme.backgroundElement); assert.equal(normal.borderWidth, undefined);
    assert.equal(normal.minHeight, 56); assert.equal(normal.borderRadius, 16);
    assert.equal(flat(view.text(button).style).color, view.theme.text);
    assert.equal(flat(button.style({ pressed: true })).opacity, 0.7);
  }
  const disabled = render("light", { ...props, disabled: true });
  assert.ok(disabled.buttons.every((button) => flat(button.style({ pressed: true })).opacity === 0.4));
});

test("다크 두 복구 버튼은 밝은 중립색 배경과 테두리 없이 구분하며 callback·카드 간격 유지", () => {
  const view = render("dark", props), card = flat(view.card.style);
  assert.equal(card.backgroundColor, view.theme.backgroundElement);
  assert.equal(card.backgroundColor, "#212225");
  assert.equal(card.padding, 16); assert.equal(card.gap, 12); assert.equal(card.borderRadius, 12);
  assert.equal(view.buttons.length, 2);
  assert.deepEqual(view.buttons.map((button) => button.onPress), [first, second]);
  assert.deepEqual(view.buttons.map((button) => view.text(button).children), props.actions.map((action) => action.label));
  for (const button of view.buttons) {
    const style = flat(button.style({ pressed: false }));
    assert.equal(style.backgroundColor, "#3A3E44");
    assert.equal(style.borderColor, undefined); assert.equal(style.borderWidth, undefined);
    assert.equal(style.minHeight, 56); assert.equal(style.borderRadius, 16);
    assert.notEqual(style.backgroundColor, card.backgroundColor);
    assert.equal(flat(view.text(button).style).color, "#ffffff");
    assert.ok(contrast(rgb(flat(view.text(button).style).color), rgb(style.backgroundColor)) >= 4.5);
  }
});

test("다크 눌림 상태에도 테두리 없이 텍스트 대비와 기존 눌림 피드백 유지", () => {
  const view = render("dark", props), card = rgb(flat(view.card.style).backgroundColor);
  for (const button of view.buttons) {
    const pressed = flat(button.style({ pressed: true }));
    assert.equal(pressed.opacity, 0.7);
    const text = composite(rgb(flat(view.text(button).style).color), card, pressed.opacity);
    const background = composite(rgb(pressed.backgroundColor), card, pressed.opacity);
    assert.equal(pressed.borderColor, undefined); assert.equal(pressed.borderWidth, undefined);
    assert.ok(contrast(text, background) >= 4.5);
  }
});

test("다크 비활성·로딩은 테두리 없이 기존 잠금·opacity·로딩 표시와 텍스트 대비 유지", () => {
  for (const state of [{ disabled: true }, { loading: true }]) {
    const view = render("dark", { ...props, ...state }), card = rgb(flat(view.card.style).backgroundColor);
    for (const button of view.buttons) {
      assert.equal(button.disabled, true); assert.equal(button.accessibilityState.disabled, true);
      const style = flat(button.style({ pressed: true }));
      assert.equal(style.opacity, 0.4);
      const text = composite(rgb(flat(view.text(button).style).color), card, style.opacity);
      const background = composite(rgb(style.backgroundColor), card, style.opacity);
      assert.ok(contrast(text, background) >= 3);
      assert.equal(style.backgroundColor, "#3A3E44");
      assert.equal(style.borderColor, undefined); assert.equal(style.borderWidth, undefined);
    }
    assert.equal(view.card.accessibilityState.busy, Boolean(state.loading));
    assert.equal(view.spinners.length, state.loading ? 1 : 0);
  }
});

for (const scheme of ["light", "dark"]) test(`중앙 안내형 ${scheme}: 배경 없는 세로 안내·내용 너비 버튼과 기존 글자·상태·callback 유지`, () => {
  const viewProps = { ...props, variant: "centered", title: "일정을 불러오지 못했어요.", description: "잠시 후 다시 시도해 주세요.",
    actions: [{ key: "retry", label: "다시 시도", onPress: first }] };
  const view = render(scheme, viewProps), outer = flat(view.card.style);
  assert.equal(outer.backgroundColor, undefined); assert.equal(outer.borderWidth, undefined); assert.equal(outer.borderColor, undefined);
  assert.equal(outer.alignItems, "center"); assert.equal(outer.gap, 12);
  const messages = view.card.children[0], heading = messages.props.children[0];
  assert.equal(flat(heading.props.style).flexDirection, "column"); assert.equal(flat(heading.props.style).alignItems, "center");
  assert.equal(flat(messages.props.style).gap, 8);
  assert.equal(flat(view.texts[0].style).textAlign, "center"); assert.equal(flat(view.texts[0].style).fontSize, 16);
  assert.equal(flat(view.texts[0].style).fontWeight, "600"); assert.equal(flat(view.texts[0].style).color, view.theme.primary);
  assert.equal(flat(view.texts[1].style).textAlign, "center"); assert.equal(flat(view.texts[1].style).fontSize, 14);
  assert.equal(flat(view.texts[1].style).fontWeight, "500");
  const button = view.buttons[0], style = flat(button.style({ pressed: false }));
  assert.strictEqual(button.onPress, first); assert.equal(style.width, undefined);
  assert.equal(style.alignSelf, "center"); assert.equal(style.minWidth, 128); assert.equal(style.maxWidth, "100%");
  assert.equal(style.paddingHorizontal, 24); assert.equal(style.minHeight, 56); assert.equal(style.borderRadius, 16);
  assert.equal(style.backgroundColor, scheme === "dark" ? "#3A3E44" : view.theme.backgroundElement);
  assert.equal(flat(button.style({ pressed: true })).opacity, 0.7);
  assert.equal(view.card.accessibilityRole, "alert"); assert.equal(view.card.accessibilityLiveRegion, "polite");
  const busy = render(scheme, { ...viewProps, loading: true });
  assert.equal(busy.buttons[0].disabled, true); assert.equal(busy.card.accessibilityState.busy, true);
  assert.equal(busy.spinners.length, 1); assert.equal(flat(busy.buttons[0].style({ pressed: true })).opacity, 0.4);
});

for (const scheme of ["light", "dark"]) test(`목록 소형 재시도 ${scheme}: 120×44·16px/600·12dp와 기존 색상·안내·callback 유지`, () => {
  const viewProps = { ...props, variant: "centered", title: "일정을 불러오지 못했어요.", description: "잠시 후 다시 시도해 주세요.",
    actions: [{ key: "retry", label: "다시 시도", onPress: first }] };
  const original = render(scheme, viewProps), compact = render(scheme, { ...viewProps, compactActions: true });
  assert.deepEqual(compact.card.style, original.card.style);
  assert.deepEqual(compact.texts.slice(0, 2), original.texts.slice(0, 2), "아이콘 아래 제목·설명은 유지한다");
  const button = compact.buttons[0], style = flat(button.style({ pressed: false }));
  assert.equal(style.width, 120); assert.equal(style.minWidth, 120); assert.equal(style.minHeight, 44);
  assert.equal(style.borderRadius, 12); assert.equal(style.alignSelf, "center"); assert.equal(style.paddingHorizontal, 24);
  assert.equal(style.backgroundColor, flat(original.buttons[0].style({ pressed: false })).backgroundColor);
  assert.equal(flat(compact.text(button).style).color, flat(original.text(original.buttons[0]).style).color);
  assert.equal(flat(compact.text(button).style).fontSize, 16); assert.equal(flat(compact.text(button).style).fontWeight, "600");
  assert.strictEqual(button.onPress, first); assert.equal(button.accessibilityRole, "button");
  assert.equal(flat(button.style({ pressed: true })).opacity, 0.7);
  const busy = render(scheme, { ...viewProps, compactActions: true, loading: true });
  assert.equal(busy.buttons[0].disabled, true); assert.equal(busy.card.accessibilityState.busy, true);
  assert.equal(flat(busy.buttons[0].style({ pressed: true })).opacity, 0.4);
  const card = render(scheme, { ...props, compactActions: true });
  for (const action of card.buttons) {
    assert.equal(flat(action.style({ pressed: false })).minHeight, 56);
    assert.equal(flat(action.style({ pressed: false })).borderRadius, 16);
    assert.equal(flat(card.text(action).style).fontWeight, "700");
  }
});
