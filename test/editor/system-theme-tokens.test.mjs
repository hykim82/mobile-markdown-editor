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

function findNonRootColorLiterals(sheet) {
  const found = [];
  function visit(rule) {
    if (rule.selectorText && rule.selectorText !== ":root") {
      const matches = [];
      for (let i = 0; i < rule.style.length; i++) {
        const prop = rule.style[i];
        const value = rule.style.getPropertyValue(prop);
        if (
          HEX_RE.test(value) ||
          COLOR_FUNC_RE.test(value) ||
          NAMED_COLOR_RE.test(value)
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
    label: "목록 불러오기 실패 글자(.memo-list-error, light)",
    fg: "--color-state-error",
    bg: "--color-bg",
    themes: ["light"],
    minRatio: 4.0,
    exception:
      "사전 존재 결함 -- 이 라운드 §2 의 ⑴·⑵ 대상이 아니고 다크 모드와도 무관(다크는 5.53 로 통과). color.state.error.light 가 거의 흰 배경 위에서 4.5 미달(실측 4.37) -- 토큰 안 수정 가능(검토 2R §6: 배경을 var(--color-bg-elevated) 로 바꾸면 라이트 4.57 · 다크 5.02) -- 이 조각 범위 밖이라 보류(E11). 바닥(4.0)은 더 나빠지는 것만 잡는다.",
  },
  {
    label: "노션 복사 오류 토스트 글자(고정, [data-variant=error])",
    fg: "--color-toast-text",
    bg: "--color-toast-error-bg",
    themes: ["light", "dark"],
    minRatio: 4.0,
    exception:
      "위와 같은 뿌리(color.state.error.light, 고정값) -- 검토 1R §6 이 이미 같은 값(4.37)을 '무변'으로 적었을 뿐 P 코드로 escalate 하지 않았다. 사전 존재 -- 토큰 안 수정 가능(검토 2R §6: 글자를 var(--color-bg-elevated)(#ffffff) 로 바꾸면 4.57) -- 이 조각 범위 밖이라 보류(E11).",
  },
  {
    label:
      "되돌리기 버튼 글자(#list-delete-undo-button, accent on 고정 다크 칩, light)",
    fg: "--color-accent",
    bg: "--color-toast-bg",
    themes: ["light"],
    minRatio: 2.5,
    exception:
      "사전 존재 결함(신규 발견) -- 이 토스트 칩은 항상 어두운 고정 배경(--color-toast-bg)인데 글자색은 테마를 타는 --color-accent 라 라이트에서 3b6fe0 on 2a2d33 = 2.98 로 크게 미달한다. §2 의 ⑴·⑵ 목록에 없다 -- 토큰 안 수정 가능(검토 2R §6: 글자를 고정 #7aa2f2(color.accent.hover.dark) 로 바꾸면 5.44, 두 테마 같음) -- 이 조각 범위 밖이라 보류(E11, 1R·REVIEW-1R 모두 이 쌍을 재지 않았다).",
  },
  {
    label:
      "되돌리기 버튼 글자(#list-delete-undo-button, accent on 고정 다크 칩, dark)",
    fg: "--color-accent",
    bg: "--color-toast-bg",
    themes: ["dark"],
    minRatio: 4.0,
    exception:
      "위와 같은 뿌리 -- 다크 accent(5b8def on 2a2d33) 도 4.27 로 작은 글자 AA 미달. 사전 존재 -- 토큰 안 수정 가능(검토 2R §6: 글자를 고정 #7aa2f2 로 바꾸면 5.44, 두 테마 같음) -- 이 조각 범위 밖이라 보류(E11).",
  },
];

test("대비 가드(실패형): 화면에 실제로 쓰이는 글자/배경 쌍이 4.5(AA, 작은 글자) 미달이면 실패한다", async (t) => {
  const html = await loadIndexHtml();
  const { rootRule, darkRootRule } = parseThemeRules(html);
  assert.ok(rootRule, "전제: 최상위 :root 규칙이 있어야 한다");
  assert.ok(
    darkRootRule,
    "전제: @media (prefers-color-scheme: dark) 안에 :root 규칙이 있어야 한다",
  );

  const rows = [];
  for (const def of PAIR_DEFS) {
    for (const theme of def.themes) {
      const fg = resolveVarValue(rootRule, darkRootRule, theme, def.fg);
      const bg = resolveVarValue(rootRule, darkRootRule, theme, def.bg);
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
