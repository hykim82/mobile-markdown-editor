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
function findNonRootHexLiterals(sheet) {
  const found = [];
  const HEX_RE = /#[0-9a-fA-F]{3,8}/g;
  function visit(rule) {
    if (rule.selectorText && rule.selectorText !== ":root") {
      const matches = rule.style.cssText.match(HEX_RE);
      if (matches) found.push({ selector: rule.selectorText, matches });
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

test("리터럴 0: :root/다크 :root 가 아닌 모든 선택자에 색 리터럴(hex)이 없다", async () => {
  const html = await loadIndexHtml();
  const { sheet } = parseThemeRules(html);
  const offenders = findNonRootHexLiterals(sheet);
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

test("대비 계산(토큰 값, 실측 아님) -- 콘솔에 표로 남긴다(4.5 미달은 표시만, 토큰은 안 바꾼다)", async (t) => {
  const tokens = await loadTokens();
  const pairs = [
    [
      "본문 글자(light)",
      tokens["color.text.primary"].light,
      tokens["color.bg"].light,
    ],
    [
      "본문 글자(dark)",
      tokens["color.text.primary"].dark,
      tokens["color.bg"].dark,
    ],
    [
      "흐린 글자(light)",
      tokens["color.text.muted"].light,
      tokens["color.bg"].light,
    ],
    [
      "흐린 글자(dark)",
      tokens["color.text.muted"].dark,
      tokens["color.bg"].dark,
    ],
    [
      "토큰 이탈 대체 1: 저장 실패 버튼 글자(고정, color.state.error.dark) on 고정 토스트(color.border.dark)",
      tokens["color.state.error"].dark,
      tokens["color.border"].dark,
    ],
    [
      "토큰 이탈 대체 2·3: #save-notice 글자(color.text.primary) on 배경(color.bg.elevated) -- light",
      tokens["color.text.primary"].light,
      tokens["color.bg.elevated"].light,
    ],
    [
      "토큰 이탈 대체 2·3: #save-notice 글자(color.text.primary) on 배경(color.bg.elevated) -- dark",
      tokens["color.text.primary"].dark,
      tokens["color.bg.elevated"].dark,
    ],
  ];
  const rows = pairs.map(([label, fg, bg]) => {
    const ratio = contrastRatio(fg, bg);
    return {
      label,
      fg,
      bg,
      ratio: Number(ratio.toFixed(2)),
      passesAA: ratio >= 4.5,
    };
  });
  // 전건 npm test(node --test, 동시 워커)에서 console.log 로 큰 들여쓴
  // JSON 을 찍으면 테스트 러너 IPC 가 간헐적으로 "Unable to deserialize
  // cloned data" 로 깨진다(이 파일에서 직접 재현 -- 단독 실행 3회는
  // 6/6 그린, 전건 동시 실행에서만 재현). t.diagnostic + 한 줄 압축
  // JSON 이 TAP 주석 경로로 안전하게 나간다(node:test 설계 용도).
  t.diagnostic(`대비 계산 표(§2 요구 4): ${JSON.stringify(rows)}`);
  assert.ok(rows.every((r) => Number.isFinite(r.ratio) && r.ratio >= 1));
});
