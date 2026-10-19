// HYK-304-system-theme-1 §2 요구 6(정적 대조 칸) + §2 요구 7(되돌림 변이가
// 어느 칸을 RED 로 만드는지의 정본). public/index.html 의 <style> 를
// jsdom 으로 파싱해(regex 로 중괄호를 손수 세지 않는다 -- jsdom 의
// CSSOM 이 @media 중첩까지 정확히 읽는다, app-harness.mjs 와 같은
// 신뢰 근거) spec/design-tokens.json 의 색 11개와 CSS 변수(:root 라이트 ·
// @media (prefers-color-scheme: dark) 안 :root 다크)가 1:1 로 맞는지,
// 그 밖의 모든 선택자에 변수 밖 색 리터럴이 0 인지, 다크 블록과
// `color-scheme` 이 존재하는지를 잰다. 제품 코드 변경은 이 파일에 없다
// (coder-task.md product_scope ⓒ: 새 시험 파일).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const indexHtmlPath = join(repoRoot, "public", "index.html");
const tokensPath = join(repoRoot, "spec", "design-tokens.json");

// spec/design-tokens.json 의 색 11개 ↔ public/index.html CSS 변수 이름.
// (토큰 키는 읽기만 -- 값은 아래에서 파일을 직접 읽어 대조하고, 여기
// 손으로 베껴 적지 않는다. §2 요구 6 "값 손복사 금지".)
const COLOR_TOKEN_TO_VAR = {
  "color.bg": "--color-bg",
  "color.bg.elevated": "--color-bg-elevated",
  "color.text.primary": "--color-text-primary",
  "color.text.muted": "--color-text-muted",
  "color.accent": "--color-accent",
  "color.border": "--color-border",
  "color.state.error": "--color-state-error",
  "color.state.success": "--color-state-success",
  "color.accent.hover": "--color-accent-hover",
  "color.disabled": "--color-disabled",
  "color.focus.ring": "--color-focus-ring",
};

async function loadTokens() {
  return JSON.parse(await readFile(tokensPath, "utf8"));
}

async function loadIndexHtml() {
  return readFile(indexHtmlPath, "utf8");
}

// html 문자열을 jsdom 으로 올리고 첫 스타일시트에서 ⑴ 최상위 :root 규칙
// ⑵ @media (prefers-color-scheme: dark) 안의 :root 규칙 ⑶ 최상위 :root 의
// color-scheme 값을 뽑는다. 둘 다 못 찾으면 null 로 둬 호출부가 판단한다
// (예: 다크 블록을 지우는 변이 뒤에는 darkRootRule 이 null 이어야 "RED"다).
function parseThemeRules(html) {
  const dom = new JSDOM(html);
  const sheet = dom.window.document.styleSheets[0];
  let rootRule = null;
  let darkRootRule = null;
  for (const rule of sheet.cssRules) {
    if (rule.selectorText === ":root") {
      rootRule = rule;
    } else if (
      rule.media &&
      /prefers-color-scheme:\s*dark/.test(rule.media.mediaText)
    ) {
      for (const inner of rule.cssRules) {
        if (inner.selectorText === ":root") darkRootRule = inner;
      }
    }
  }
  const colorSchemeValue = rootRule
    ? rootRule.style.getPropertyValue("color-scheme").trim()
    : "";
  return { rootRule, darkRootRule, colorSchemeValue, sheet };
}

// :root 가 아닌 모든 선택자(다크 블록 안의 :root 포함 -- selectorText 는
// 중첩 깊이와 무관하게 여전히 ":root" 라 자동으로 빠진다)에서 색 리터럴을
// 찾는다. 토큰이 아닌 값(변수 밖 하드코딩)이 남아 있으면 비어있지 않은
// 배열을 돌려준다.
//
// HYK-304-system-theme-1-r2 §2 요구 4(⑶ 시험 구멍 ⓑ): 1R 의 이 함수는
// hex(`#...`) 만 보았다 -- 검토 1R §5 변이 ⑶b(`#save-notice` 배경을
// `rgb(255, 243, 224)` 로 재도입)가 이 칸을 통과(GREEN)시켜 구멍임을 값으로
// 보였다(P3-2). 이제 ⑴ hex ⑵ rgb()/rgba()/hsl()/hsla()/hwb()/lab()/lch()/
// color() 함수 표기 ⑶ CSS 확장 색 이름 키워드(white·black 등)도 잡는다.
// `rule.style` 을 선언(property/value) 단위로 읽어(cssText 문자열 전체를
// 정규식으로 훑지 않는다) 값 쪽만 검사하므로 속성 이름(border 등)에 우연히
// 섞인 글자는 걸리지 않는다.
const HEX_RE = /#[0-9a-fA-F]{3,8}/;
const COLOR_FUNC_RE = /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|color)\(/i;
// CSS Color Module Level 4 확장 색 이름(147개, X11 계열) -- transparent ·
// currentcolor 는 "고정 색 값"이 아니라 키워드라 뺀다(토큰 이탈 하드코딩이
// 아님).
const NAMED_COLORS = [
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
];
const NAMED_COLOR_RE = new RegExp(`\\b(?:${NAMED_COLORS.join("|")})\\b`, "i");

// HYK-304-contrast-e11-1 §2 요구 2(책임자 판정): 세 선택자 중 둘(⑴ 되돌리기
// 버튼 · ⑵ 노션 오류 토스트)은 "고정값이 두 테마 모두 같아야 한다"는 이유로
// var() 가 아니라 리터럴을 쓴다(⛔새 CSS 변수 0 -- 기존 토큰 값을 그대로
// 재사용, spec/design-tokens.json 무접촉). 이 allowlist 는 "그 선택자의
// 그 속성이 정확히 그 값일 때만" 리터럴-0 검사를 면제한다 -- selector·
// property·value 셋이 모두 맞아야 하므로 다른 선택자의 새 리터럴이나 같은
// 선택자의 다른 값(예: 변이로 바뀐 값)은 여전히 잡힌다. 세 번째(⑶
// .memo-list-error)는 var(--color-bg-elevated) 라 애초에 리터럴이 아니다.
const LITERAL_ALLOWLIST = [
  {
    selector: "#list-delete-undo-button",
    property: "color",
    value: "#7aa2f2",
  },
  {
    selector: '#notion-copy-toast[data-variant="error"]',
    property: "color",
    value: "#ffffff",
  },
];

function isAllowlistedLiteral(selector, prop, value) {
  const normalized = value.trim().toLowerCase();
  return LITERAL_ALLOWLIST.some(
    (entry) =>
      entry.selector === selector &&
      entry.property === prop &&
      entry.value === normalized,
  );
}

function findNonRootColorLiterals(sheet) {
  const found = [];
  function visit(rule) {
    if (rule.selectorText && rule.selectorText !== ":root") {
      const matches = [];
      for (let i = 0; i < rule.style.length; i++) {
        const prop = rule.style[i];
        const value = rule.style.getPropertyValue(prop);
        if (
          (HEX_RE.test(value) ||
            COLOR_FUNC_RE.test(value) ||
            NAMED_COLOR_RE.test(value)) &&
          !isAllowlistedLiteral(rule.selectorText, prop, value)
        ) {
          matches.push(`${prop}: ${value}`);
        }
      }
      if (matches.length) found.push({ selector: rule.selectorText, matches });
    }
    if (rule.cssRules) {
      for (const inner of rule.cssRules) visit(inner);
    }
  }
  for (const rule of sheet.cssRules) visit(rule);
  return found;
}

test("라이트 값: :root 의 색 변수 11개가 토큰 light 값과 1:1", async () => {
  const tokens = await loadTokens();
  const html = await loadIndexHtml();
  const { rootRule } = parseThemeRules(html);
  assert.ok(rootRule, "전제: 최상위 :root 규칙이 있어야 한다");
  for (const [tokenKey, varName] of Object.entries(COLOR_TOKEN_TO_VAR)) {
    const expected = tokens[tokenKey].light.toLowerCase();
    const actual = rootRule.style
      .getPropertyValue(varName)
      .trim()
      .toLowerCase();
    assert.equal(
      actual,
      expected,
      `${varName} (토큰 ${tokenKey}.light) 가 ${expected} 여야 하는데 ${actual || "(없음)"}`,
    );
  }
});

test("다크 값: @media (prefers-color-scheme: dark) 의 :root 색 변수 11개가 토큰 dark 값과 1:1", async () => {
  const tokens = await loadTokens();
  const html = await loadIndexHtml();
  const { darkRootRule } = parseThemeRules(html);
  assert.ok(
    darkRootRule,
    "전제: @media (prefers-color-scheme: dark) 안에 :root 규칙이 있어야 한다",
  );
  for (const [tokenKey, varName] of Object.entries(COLOR_TOKEN_TO_VAR)) {
    const expected = tokens[tokenKey].dark.toLowerCase();
    const actual = darkRootRule.style
      .getPropertyValue(varName)
      .trim()
      .toLowerCase();
    assert.equal(
      actual,
      expected,
      `다크 ${varName} (토큰 ${tokenKey}.dark) 가 ${expected} 여야 하는데 ${actual || "(없음)"}`,
    );
  }
});

test("다크 미디어 블록 존재: @media (prefers-color-scheme: dark) 안에 :root 규칙이 있다", async () => {
  const html = await loadIndexHtml();
  const { darkRootRule } = parseThemeRules(html);
  assert.ok(
    darkRootRule,
    "@media (prefers-color-scheme: dark) { :root { ... } } 블록이 있어야 한다",
  );
});

test("color-scheme: :root 에 'light dark' 가 선언돼 있다", async () => {
  const html = await loadIndexHtml();
  const { colorSchemeValue } = parseThemeRules(html);
  assert.equal(colorSchemeValue, "light dark");
});

test("리터럴 0: :root/다크 :root 가 아닌 모든 선택자에 색 리터럴(hex·rgb/rgba/hsl/hsla·색 이름)이 없다", async () => {
  const html = await loadIndexHtml();
  const { sheet } = parseThemeRules(html);
  const offenders = findNonRootColorLiterals(sheet);
  assert.deepEqual(
    offenders,
    [],
    `변수 밖 색 리터럴이 남아있다: ${JSON.stringify(offenders)}`,
  );
});

// §2 요구 4(대비 계산 칸, 실측 아님 -- 토큰 값으로 계산). WCAG 2 relative
// luminance 공식 그대로(https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
// 과 같은 식 -- 이 파일 안에서만 쓰는 순수 계산, 제품 코드에 새 모듈을
// 만들지 않는다, product_scope ⓒ 범위).
function hexToRgb(hex) {
  const n = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
}
function relLuminance([r, g, b]) {
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [fr, fg, fb] = [f(r), f(g), f(b)];
  return 0.2126 * fr + 0.7152 * fg + 0.0722 * fb;
}
function contrastRatio(hexA, hexB) {
  const la = relLuminance(hexToRgb(hexA));
  const lb = relLuminance(hexToRgb(hexB));
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

// HYK-304-system-theme-1-r2 §2 요구 3(⑷ 대비 칸 = 실패형). 1R 의 "대비
// 계산" 시험은 단언이 `ratio >= 1`뿐이라 대비비는 정의상 항상 ≥1 이므로
// 절대 실패하지 않는 칸이었다(검토 1R §7 P3-4). 이제 화면에 실제로 쓰이는
// 글자/배경 쌍을(이 파일이 이미 읽은 실제 public/index.html 의 :root/다크
// :root 값에서 직접 뽑아 -- 값을 손으로 다시 베끼지 않는다) 라이트·다크·
// 눌림(pressed)/hover 상태까지 모아 4.5(WCAG AA, 작은 글자) 미달이면 실패
//하게 한다. 큰 글자(FAB "+" 28px 등) 예외는 필요하면 minRatio 를 3 으로
// 두고 그 쌍에 note 를 남기는 자리를 마련했다 -- 실측 결과 이 조각이 다루는
// 큰 글자 쌍(FAB)도 4.5 를 이미 넘어 예외를 쓸 필요가 없었다(아래 PAIR_DEFS
// 의 note 에 그대로 적는다). 사전 존재(이 라운드가 손대지 않은) 결함 3곳
// (`.memo-list-error` · 노션 오류 토스트 · `#list-delete-undo-button` --
// 뒤 둘은 아래 PAIR_DEFS 에서 라이트/다크로 나뉘거나 테마를 함께 묶어 정의
// 4개가 된다, product_scope 참고)은 `exception` 사유와 함께 느슨한
// 바닥(minRatio)만 걸어 "더 나빠지면 잡되, 지금 당장 npm test 를 깨지
// 않는다" -- 기존 토큰 안에서 수정 가능하지만(검토 2R §6 계산) 이 조각
// 범위 밖이라 보류한다(E11, 결과 파일에도 따로 적는다). notion-copy-button:disabled
// 쌍의 exception 은 이와 다르다 -- "사전 존재 결함"이 아니라 WCAG 1.4.3
// 비활성 컨트롤 예외이며, 이 라운드(3R)가 직접 고친 쌍이라 바닥을 1 에서
// 실측값(3.05/3.85)으로 올렸다(HYK-304-system-theme-1-r3 §2 요구 1).
function resolveVarValue(rootRule, darkRootRule, theme, name) {
  if (theme === "light") {
    return rootRule.style.getPropertyValue(name).trim().toLowerCase();
  }
  const darkVal = darkRootRule
    ? darkRootRule.style.getPropertyValue(name).trim()
    : "";
  return (
    darkVal || rootRule.style.getPropertyValue(name).trim()
  ).toLowerCase();
}

// HYK-304-contrast-e11-1 §2 요구 2(책임자 판정) 이후: PAIR_DEFS 의 fg/bg 가
// 더 이상 전부 CSS 변수 이름이 아니다 -- ⑴ 되돌리기 버튼 · ⑵ 노션 오류
// 토스트 글자는 production 선택자에 리터럴 고정값을 직접 선언했다(위
// LITERAL_ALLOWLIST 와 같은 값). resolveVarValue 는 :root 변수만 읽을 수
// 있어 리터럴을 못 읽으므로, "#" 로 시작하면 그 값 그대로(테마 무관,
// production 쪽도 테마로 안 갈린다) 돌려주고 아니면 기존 resolveVarValue
// 로 위임한다.
function resolveColorValue(rootRule, darkRootRule, theme, nameOrLiteral) {
  if (nameOrLiteral.startsWith("#")) {
    return nameOrLiteral.toLowerCase();
  }
  return resolveVarValue(rootRule, darkRootRule, theme, nameOrLiteral);
}

// HYK-304-contrast-e11-1 §2 요구 8(변이 M4 가 "대비 칸"을 직접 RED 로
// 만들어야 한다는 요구). def.fg/def.bg 에 문자열(변수 이름·리터럴) 대신
// { selector, property } 를 적으면 "그 선택자의 그 속성이 지금 실제로
// 선언한 값"을 매 시험 실행마다 다시 읽는다(findRulesBySelector 는 아래
// BINDING_DEFS 가 쓰는 것과 같은 함수 -- 함수 선언은 호이스팅되어 여기서도
// 호출 가능하다). 선언이 var(--x) 형태면 변수 이름만 뽑아 resolveColorValue
// 로 넘기고(테마별로 달리 풀린다), 리터럴이면 그대로, 선언이 없으면(변이로
// 지워진 경우) 빈 문자열을 돌려줘 contrastRatio 가 NaN 이 되게 한다(위
// "대비 가드" 루프의 Number.isFinite 체크가 그 자리에서 실패로 잡는다) --
// 이렇게 해야 M1~M4(선언 삭제·값 교체)가 "결선" 칸뿐 아니라 "대비" 칸도
// 직접 RED 로 만든다(이전에는 fg/bg 가 고정 문자열이라 production 변이에
// 반응하지 않는 사각이 있었다 -- 이 사각은 §2 요구 4 결선 칸과 같은 종류다).
// 같은 선택자 규칙이 여러 개면(M6 류) 마지막 것을 쓴다 -- 동일 특이성에서
// 소스 순서가 늦은 규칙이 이기는 CSS 캐스케이드와 같다.
function liveColorToken(sheet, selector, property) {
  const matches = findRulesBySelector(sheet, selector);
  if (!matches.length) return "";
  const raw = matches[matches.length - 1].style
    .getPropertyValue(property)
    .trim();
  const varMatch = /^var\((--[a-zA-Z0-9-]+)\)$/.exec(raw);
  return varMatch ? varMatch[1] : raw;
}

function resolveDefColor(sheet, rootRule, darkRootRule, theme, spec) {
  if (typeof spec === "object" && spec !== null) {
    const token = liveColorToken(sheet, spec.selector, spec.property);
    return resolveColorValue(rootRule, darkRootRule, theme, token || "");
  }
  return resolveColorValue(rootRule, darkRootRule, theme, spec);
}

const PAIR_DEFS = [
  {
    label: "본문 글자(body)",
    fg: "--color-text-primary",
    bg: "--color-bg",
    themes: ["light", "dark"],
    minRatio: 4.5,
  },
  {
    label:
      "흐린 글자(일반 배경 -- h1·memo-list-empty·save-indicator·back-to-list-button)",
    fg: "--color-text-muted",
    bg: "--color-bg",
    themes: ["light", "dark"],
    minRatio: 4.5,
  },
  {
    label:
      "흐린 글자(표면 배경 -- first-run-notice·placeholder·unchecked 글리프·raw-panel)",
    fg: "--color-text-muted",
    bg: "--color-bg-elevated",
    themes: ["light", "dark"],
    minRatio: 4.5,
  },
  {
    label: "표면 글자(memo-card-title·shortcut-chip·save-notice 등)",
    fg: "--color-text-primary",
    bg: "--color-bg-elevated",
    themes: ["light", "dark"],
    minRatio: 4.5,
  },
  {
    label: "체크됨 글리프(li[aria-checked=true]::before)",
    fg: "--color-accent",
    bg: "--color-bg-elevated",
    themes: ["light", "dark"],
    minRatio: 4.5,
  },
  {
    label: "단축키 칩 눌림(shortcut-chip:active) 글자",
    fg: "--color-text-primary",
    bg: "--color-border",
    themes: ["light", "dark"],
    minRatio: 4.5,
  },
  {
    label: "저장 실패 버튼 글자(고정, #list-save-error-button)",
    fg: "--color-toast-error-text",
    bg: "--color-toast-bg",
    themes: ["light", "dark"],
    minRatio: 4.5,
    note: "HYK-304-system-theme-1-r2 §2 요구 2 -- 1R 값 4.29 미달을 이 라운드가 고쳤다(색 변경 + 밑줄로 오류 의미 보강).",
  },
  {
    label: "토스트 기본 글자(고정, #list-delete-toast/#notion-copy-toast)",
    fg: "--color-toast-text",
    bg: "--color-toast-bg",
    themes: ["light", "dark"],
    minRatio: 4.5,
  },
  {
    label:
      "accent 버튼 위 글자(#new-memo-button FAB 28px·#notion-copy-button 15px/600)",
    fg: "--color-on-accent",
    bg: "--color-accent",
    themes: ["light", "dark"],
    minRatio: 4.5,
    note: "HYK-304-system-theme-1-r2 §2 요구 1 -- FAB(28px)는 큰 글자라 3:1 로도 충분하지만 notion-copy-button(15px/600, 큰 글자 기준 미달)이 작은 글자 4.5 를 요구하므로 그 기준으로 잰다. 1R 값(다크 3.23)을 이 라운드가 고쳤다(다크 on-accent 를 color.bg.dark 로).",
  },
  {
    label: "accent 버튼 hover(#notion-copy-button:hover) 글자",
    fg: "--color-on-accent",
    bg: "--color-accent-hover",
    themes: ["light", "dark"],
    minRatio: 4.5,
    note: "1R 값(다크 2.54)을 이 라운드가 고쳤다.",
  },
  {
    label: "notion-copy-button:disabled 글자(비활성, light)",
    fg: "--color-text-muted",
    bg: "--color-disabled",
    themes: ["light"],
    minRatio: 3.05,
    exception:
      "비활성 컨트롤 -- WCAG 2.1 1.4.3 은 inactive user interface component 에 대비 요구를 두지 않는다(표시만, 게이트 아님). HYK-304-system-theme-1-r3 §2 요구 1 -- 1R 1.75 → 2R 1.75(글자가 --color-on-accent 상속이라 라이트는 2R 에서도 안 바뀜) → 3R(이 라운드, --color-text-muted 로) 3.05. 바닥(minRatio)을 1(항상 통과)에서 이 라운드가 실제로 낸 값으로 올려 더 나빠지면 잡는다(4.5 는 여전히 미달 -- 예외 유지).",
  },
  {
    label: "notion-copy-button:disabled 글자(비활성, dark)",
    fg: "--color-text-muted",
    bg: "--color-disabled",
    themes: ["dark"],
    minRatio: 3.85,
    exception:
      "비활성 컨트롤 -- WCAG 2.1 1.4.3 은 inactive user interface component 에 대비 요구를 두지 않는다(표시만, 게이트 아님). HYK-304-system-theme-1-r3 §2 요구 1 -- 1R 10.88(다크 --color-on-accent 미재선언으로 라이트 흰 글자가 그대로 쓰였던 우연한 값) → 2R 1.63(2R 이 다크 --color-on-accent 를 #16181c 로 재선언하면서 이 규칙은 그대로라 생긴 후퇴, 새 메모마다 보임) → 3R(이 라운드, --color-text-muted 로) 3.85. 바닥을 1 에서 이 라운드 값으로 올려 더 나빠지면 잡는다(4.5 는 여전히 미달 -- 예외 유지).",
  },
  {
    // HYK-304-contrast-e11-1 §2 요구 3(책임자 판정): 배경이 --color-bg
    // 에서 --color-bg-elevated 로 바뀌었다(production 쪽 변경과 1:1).
    // 라이트 4.37 → 4.57 · 다크(이번에 행이 추가됐다 · 요구 7) 5.53 →
    // 5.02 -- 둘 다 4.5 이상이라 exception 을 없애고 minRatio 를 4.5 로
    // 올린다.
    label: "목록 불러오기 실패 글자(.memo-list-error, light+dark -- E11 수리)",
    fg: "--color-state-error",
    bg: { selector: "#list-root .memo-list-error", property: "background" },
    themes: ["light", "dark"],
    minRatio: 4.5,
    note: "HYK-304-contrast-e11-1 §2 요구 2 ⑶ -- 사전 존재 결함(라이트 4.37 미달)을 배경 토큰 교체로 고쳤다(라이트 4.57 · 다크는 5.53→5.02, 둘 다 4.5 이상).",
  },
  {
    // HYK-304-contrast-e11-1 §2 요구 2 ⑵: color 가 더 이상 상속된
    // --color-toast-text 가 아니라 production 선택자에 직접 선언한
    // 리터럴 고정 #ffffff 다(LITERAL_ALLOWLIST 와 같은 값 -- resolveColorValue
    // 가 "#" 리터럴을 그대로 읽는다).
    label:
      "노션 복사 오류 토스트 글자(고정 #ffffff, [data-variant=error] -- E11 수리)",
    fg: {
      selector: '#notion-copy-toast[data-variant="error"]',
      property: "color",
    },
    bg: "--color-toast-error-bg",
    themes: ["light", "dark"],
    minRatio: 4.5,
    note: "HYK-304-contrast-e11-1 §2 요구 2 ⑵ -- 사전 존재 결함(두 테마 4.37 미달)을 리터럴 고정 #ffffff(기존 --color-bg-elevated 라이트 값과 같음)로 고쳤다(두 테마 4.57).",
  },
  {
    // HYK-304-contrast-e11-1 §2 요구 2 ⑴: color 가 더 이상 테마를 타는
    // --color-accent 가 아니라 production 선택자에 직접 선언한 리터럴
    // 고정 #7aa2f2 다 -- 배경(--color-toast-bg)도 고정이라 테마 구분이
    // 더는 필요 없어 light/dark 를 한 항목으로 합친다(위 "저장 실패 버튼
    // 글자"·"토스트 기본 글자" 항목과 같은 모양).
    label:
      "되돌리기 버튼 글자(#list-delete-undo-button, 고정 #7aa2f2 on 고정 다크 칩 -- E11 수리)",
    fg: { selector: "#list-delete-undo-button", property: "color" },
    bg: "--color-toast-bg",
    themes: ["light", "dark"],
    minRatio: 4.5,
    note: "HYK-304-contrast-e11-1 §2 요구 2 ⑴ -- 사전 존재 결함(라이트 2.98 · 다크 4.27 미달)을 리터럴 고정 #7aa2f2(기존 color.accent.hover.dark 값)로 고쳤다(두 테마 5.44).",
  },
];

test("대비 가드(실패형): 화면에 실제로 쓰이는 글자/배경 쌍이 4.5(AA, 작은 글자) 미달이면 실패한다", async (t) => {
  const html = await loadIndexHtml();
  const { rootRule, darkRootRule, sheet } = parseThemeRules(html);
  assert.ok(rootRule, "전제: 최상위 :root 규칙이 있어야 한다");
  assert.ok(
    darkRootRule,
    "전제: @media (prefers-color-scheme: dark) 안에 :root 규칙이 있어야 한다",
  );

  const rows = [];
  for (const def of PAIR_DEFS) {
    for (const theme of def.themes) {
      const fg = resolveDefColor(sheet, rootRule, darkRootRule, theme, def.fg);
      const bg = resolveDefColor(sheet, rootRule, darkRootRule, theme, def.bg);
      const ratio = contrastRatio(fg, bg);
      rows.push({
        label: def.label,
        theme,
        fg,
        bg,
        ratio: Number(ratio.toFixed(2)),
        minRatio: def.minRatio,
        exception: def.exception ?? null,
        note: def.note ?? null,
      });
    }
  }
  // 전건 npm test(node --test, 동시 워커)에서 console.log 로 큰 들여쓴 JSON 을
  // 찍으면 테스트 러너 IPC 가 간헐적으로 "Unable to deserialize cloned data" 로
  // 깨진다(1R 이 이 파일에서 직접 재현). t.diagnostic + 한 줄 압축 JSON 이
  // TAP 주석 경로로 안전하게 나간다.
  t.diagnostic(`대비 가드 표(§2 요구 3): ${JSON.stringify(rows)}`);
  for (const row of rows) {
    assert.ok(
      Number.isFinite(row.ratio) && row.ratio >= row.minRatio,
      `${row.label}(${row.theme}) ${row.fg} on ${row.bg} = ${row.ratio} (요구 ≥ ${row.minRatio}${row.exception ? " · " + row.exception : ""})`,
    );
  }
});

// HYK-304-system-theme-1-r4 §2 요구 2(결선 칸 1). 위 대비 가드는 PAIR_DEFS
// 에 손으로 적은 변수 이름(--color-text-muted)이 실제로 그 쌍의 토큰값과
// 같은지만 재고, "#notion-copy-button:disabled 의 color 선언이 그 변수를
// 쓰는가"는 재지 않는다(2R P3-1 · 3R 검토 M1/M2 GREEN 과 같은 구멍).
// 방법 = jsdom CSSOM(parseThemeRules 가 쓰는 신뢰 근거와 같다) -- 소스
// 문자열 정규식이 아니라 실제 파싱된 규칙의 선언 값을 읽는다.
test("결선(selector-binding): #notion-copy-button:disabled 의 color 가 var(--color-text-muted) 이고 그 선택자 규칙은 정확히 1개다", async () => {
  const html = await loadIndexHtml();
  const { sheet } = parseThemeRules(html);
  const matches = [];
  function visit(rule) {
    if (rule.selectorText === "#notion-copy-button:disabled") {
      matches.push(rule);
    }
    if (rule.cssRules) {
      for (const inner of rule.cssRules) visit(inner);
    }
  }
  for (const rule of sheet.cssRules) visit(rule);
  // 한계: jsdom CSSOM 은 소스를 이미 규칙 단위로 파싱해 돌려준다 --
  // "같은 선택자를 공백·대소문자만 다르게 중복 선언했는가" 같은 소스
  // 문자열 수준의 표기 차이는 CSSOM 파싱 단계에서 이미 한 selectorText
  // 로 정규화될 수 있어 이 칸만으로는 못 가른다(소스 정규식 교차검증은
  // 하지 않았다, product_scope 범위 밖). 재는 것은 "파싱된 규칙이 몇
  // 개이고 그 color 선언이 무엇인가"다.
  assert.equal(
    matches.length,
    1,
    `#notion-copy-button:disabled 규칙이 정확히 1개여야 하는데 ${matches.length}개다(뒤에 덮어쓰는 같은 선택자 규칙이 있으면 결선이 조용히 바뀐다)`,
  );
  const colorValue = matches[0].style.getPropertyValue("color").trim();
  assert.equal(
    colorValue,
    "var(--color-text-muted)",
    `#notion-copy-button:disabled 의 color 가 var(--color-text-muted) 여야 하는데 ${colorValue || "(없음, 상속으로 되돌아간다)"}다`,
  );
});

// HYK-304-contrast-e11-1 §2 요구 4(결선 칸, 세 선택자 한정 -- P3-1). 위
// #notion-copy-button:disabled 결선 시험과 같은 방법(jsdom CSSOM, 선택자
// 단위 선언 읽기)을 이 라운드가 고친 세 선택자에 적용한다. 같은 한계가
// 그대로 적용된다(선택자 "목록"(`a, b {}`) · 두 번째 스타일시트 · 인라인
// style 은 이 방법으로 못 본다 -- 이 파일은 <style> 하나만 다루고 index.html
// 에 인라인 style 속성이 없다는 전제, 교차검증은 하지 않았다).
function findRulesBySelector(sheet, selector) {
  const matches = [];
  function visit(rule) {
    if (rule.selectorText === selector) {
      matches.push(rule);
    }
    if (rule.cssRules) {
      for (const inner of rule.cssRules) visit(inner);
    }
  }
  for (const rule of sheet.cssRules) visit(rule);
  return matches;
}

const BINDING_DEFS = [
  {
    selector: "#list-delete-undo-button",
    property: "color",
    expected: "#7aa2f2",
  },
  {
    selector: '#notion-copy-toast[data-variant="error"]',
    property: "color",
    expected: "#ffffff",
  },
  {
    selector: "#list-root .memo-list-error",
    property: "background",
    expected: "var(--color-bg-elevated)",
  },
];

for (const def of BINDING_DEFS) {
  test(`결선(selector-binding, E11): ${def.selector} 의 ${def.property} 가 ${def.expected} 이고 그 선택자 규칙은 정확히 1개다`, async () => {
    const html = await loadIndexHtml();
    const { sheet } = parseThemeRules(html);
    const matches = findRulesBySelector(sheet, def.selector);
    assert.equal(
      matches.length,
      1,
      `${def.selector} 규칙이 정확히 1개여야 하는데 ${matches.length}개다(뒤에 덮어쓰는 같은 선택자 규칙이 있으면 결선이 조용히 바뀐다)`,
    );
    const actual = matches[0].style.getPropertyValue(def.property).trim();
    assert.equal(
      actual.toLowerCase(),
      def.expected.toLowerCase(),
      `${def.selector} 의 ${def.property} 가 ${def.expected} 여야 하는데 ${actual || "(없음)"}다`,
    );
  });
}

// HYK-304-contrast-e11-1 §2 요구 5(밑줄 비색 칸 -- P3-2). #list-save-error-button
// 의 "오류 = 밑줄"(색이 아닌 표시) 관례가 그대로 남아 있는지를 재는 칸은
// 이 라운드 전까지 이 파일에 없었다(public/index.html 의 주석에만 그
// 의도가 적혀 있었다). 색이 아니라 "표시" 를 재므로 PAIR_DEFS 의 대비
// 계산과는 다른 축이다.
test("밑줄(비색 표시, E11): #list-save-error-button 의 text-decoration 이 underline 이다", async () => {
  const html = await loadIndexHtml();
  const { sheet } = parseThemeRules(html);
  const matches = findRulesBySelector(sheet, "#list-save-error-button");
  assert.equal(
    matches.length,
    1,
    `#list-save-error-button 규칙이 정확히 1개여야 하는데 ${matches.length}개다`,
  );
  const decoration = matches[0].style
    .getPropertyValue("text-decoration")
    .trim()
    .toLowerCase();
  assert.ok(
    decoration === "underline" || decoration.startsWith("underline "),
    `#list-save-error-button 의 text-decoration 이 underline 이어야 하는데 ${decoration || "(없음)"}다(색이 사라져도 이 표시가 있으면 오류 의미가 남는다는 전제가 깨진다)`,
  );
});

// HYK-304-contrast-e11-1 §2 요구 6(대비 반올림 경계). 위 "대비 가드" 시험은
// `ratio: Number(ratio.toFixed(2))` 로 소수 2자리까지 반올림한 값을
// minRatio 와 비교한다(line 583 부근, 비교는 "반올림 후" 값으로 한다 --
// 반올림 전 원시 값과 비교하지 않는다). JS 의 toFixed 는 부동소수 표현
// 때문에 4.495 류의 경계값이 "반올림 전 실제로는 4.5 미달"인데도
// "4.50"으로 올라갈 수 있다(아래에서 직접 값으로 보인다) -- 즉 이 게이트는
// 경계에 아주 가까운 쌍(차이가 0.005 이내)에서는 반올림 때문에 거짓
// GREEN 을 낼 수 있는 알려진 한계가 있다. 이 라운드가 고친 세 쌍의
// 실측 마진(4.57 · 4.57 · 5.44 · 5.02, 모두 minRatio 4.5 와 0.02 이상
// 차이)은 이 경계 폭(0.005)보다 훨씬 커서 이 한계의 영향을 받지 않는다 --
// 그 사실을 아래에서 직접 계산해 단언한다(두 자리 반올림 후 값과
// 4.5 사이 거리가 0.005 초과인지를 잰다, 손으로 베낀 숫자가 아니라
// 이 파일의 contrastRatio 로 다시 계산한 값).
test("대비 반올림 경계(E11): toFixed(2) 반올림 방식 확인 + 이 라운드가 고친 세 쌍의 마진이 경계 폭보다 크다", () => {
  // 1) 반올림 방식 자체: JS toFixed 는 IEEE754 표현 오차로 4.495 를
  // 4.50 으로 올린다(사사오입이 아니라 부동소수 표현 아티팩트) -- 이
  // 게이트가 쓰는 비교가 "반올림 후" 값이라는 전제를 직접 값으로 보인다.
  assert.equal(
    (4.495).toFixed(2),
    "4.50",
    "이 JS 런타임의 toFixed(2) 경계 거동이 바뀌면 이 시험의 전제(반올림 후 비교)도 다시 재야 한다",
  );
  assert.equal((4.4949).toFixed(2), "4.49");

  // 2) 이 라운드가 고친 세 쌍의 반올림-후 값(§2 요구 3 표에서 그대로)이
  // 4.5 와 경계 폭(0.005)보다 더 떨어져 있는지 -- hexToRgb/relLuminance/
  // contrastRatio 는 이 파일 위쪽에서 이미 정의된 그 함수를 그대로 쓴다
  // (숫자를 손으로 베끼지 않는다).
  const ROUNDING_MARGIN = 0.005; // toFixed(2) 가 뒤집을 수 있는 최대 거리
  const fixedPairs = [
    { label: "되돌리기(고정 #7aa2f2 on #2a2d33)", a: "#7aa2f2", b: "#2a2d33" },
    {
      label: "노션 오류 토스트(고정 #ffffff on #d14343)",
      a: "#ffffff",
      b: "#d14343",
    },
    {
      label: ".memo-list-error 라이트(#d14343 on #ffffff)",
      a: "#d14343",
      b: "#ffffff",
    },
    {
      label: ".memo-list-error 다크(#e06c6c on #1e2127)",
      a: "#e06c6c",
      b: "#1e2127",
    },
  ];
  for (const { label, a, b } of fixedPairs) {
    const raw = contrastRatio(a, b);
    const rounded = Number(raw.toFixed(2));
    const distanceFrom45 = Math.abs(rounded - 4.5);
    assert.ok(
      distanceFrom45 > ROUNDING_MARGIN,
      `${label} = ${rounded}(반올림 전 ${raw}) 가 4.5 와 ${ROUNDING_MARGIN} 이내로 가까워 반올림 경계 위험이 있다`,
    );
  }
});
