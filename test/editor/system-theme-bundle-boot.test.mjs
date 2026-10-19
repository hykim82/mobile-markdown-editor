// HYK-304-system-theme-1 §2 요구 5(번들 부팅 칸). 실제 app.mjs 번들(test/
// support/app-harness.mjs 의 bootApp, E7 선례와 같은 경로)과 실물
// public/index.html 을 jsdom 으로 부팅해 ⑴ 부팅 오류 0 ⑵ 이 라운드가
// index.html 의 색 6개(--color-bg 등)를 더 이상 documentElement 인라인
// 스타일로 덮어쓰지 않는다는 것(수리 전 버그의 재발 감지 -- app.mjs 머리
// 주석 참고) ⑶ 폰트 3개는 여전히 인라인으로 남는다는 것(과잉 삭제 아님)
// ⑷ 실제 로드된 문서의 스타일시트에 다크 블록과 색 변수 11개가 있다는
// 것을 "문서 객체"에서 단언한다.
//
// ⚠️정직 한계(결과 파일에도 적는다): jsdom(27.0.0) 은 window.matchMedia
// 를 구현하지 않고(typeof window.matchMedia !== "function", 직접 확인),
// getComputedStyle 도 @media (prefers-color-scheme: dark) 를 평가하지
// 않는다(항상 라이트 분기로 귀결 -- 같은 repo 에서 최소 재현으로 직접
// 확인: :root{--x:light} + @media(dark){:root{--x:dark}} 를 올려도
// getComputedStyle(...).getPropertyValue('--x') 는 "light"다). 그래서
// 이 조각은 순수 CSS 라 JS 쪽에 "가짜로 라이트→다크→라이트 전환"할 대상이
// 없다(매체질의 리스너를 아예 안 쓴다, product_scope 근거) -- "두 테마
// 전환"은 실제 OS 토글에서만(한용 육안) 재진다. 이 시험은 그 대신
// jsdom 이 실제로 할 수 있는 것, 즉 "로드된 스타일시트 자체에 두 분기가
// 모두 존재하는가"를 문서 객체로 단언한다(coder-task.md §2 요구 5의
// "순수 CSS 면" 분기).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootApp } from "../support/app-harness.mjs";

const COLOR_VARS_NO_LONGER_INLINE = [
  "--color-bg",
  "--color-bg-elevated",
  "--color-text-primary",
  "--color-text-muted",
  "--color-accent",
  "--color-border",
];
const FONT_VARS_STILL_INLINE = [
  "--font-family",
  "--font-size-body",
  "--line-height-body",
];

test("번들 부팅: 오류 없이 뜬다 + 색 6개는 인라인 0 + 폰트 3개는 인라인 유지", async () => {
  const dom = await bootApp();
  const { document } = dom.window;
  const inlineStyle = document.documentElement.style;

  for (const name of COLOR_VARS_NO_LONGER_INLINE) {
    assert.equal(
      inlineStyle.getPropertyValue(name).trim(),
      "",
      `${name} 는 더 이상 documentElement 인라인 스타일에 없어야 한다(있으면 ` +
        `@media (prefers-color-scheme: dark) 의 :root 선언을 인라인이 가린다 -- ` +
        `app.mjs applyDesignTokens 머리 주석의 버그가 재발한 것).`,
    );
  }
  for (const name of FONT_VARS_STILL_INLINE) {
    assert.notEqual(
      inlineStyle.getPropertyValue(name).trim(),
      "",
      `${name} 는 테마와 무관하므로 그대로 인라인에 남아있어야 한다(과잉 삭제 감지).`,
    );
  }
});

test("번들 부팅: 실제 로드된 문서의 스타일시트에 다크 블록 + 색 변수 11개가 있다(문서 객체로 단언)", async () => {
  const dom = await bootApp();
  const { document } = dom.window;
  const sheet = document.styleSheets[0];
  assert.ok(sheet, "전제: 로드된 index.html 에 스타일시트가 있어야 한다");

  let rootRule = null;
  let darkRootRule = null;
  for (const rule of sheet.cssRules) {
    if (rule.selectorText === ":root") rootRule = rule;
    if (
      rule.media &&
      /prefers-color-scheme:\s*dark/.test(rule.media.mediaText)
    ) {
      for (const inner of rule.cssRules) {
        if (inner.selectorText === ":root") darkRootRule = inner;
      }
    }
  }
  assert.ok(rootRule, "최상위 :root 규칙이 있어야 한다");
  assert.ok(
    darkRootRule,
    "@media (prefers-color-scheme: dark) 안에 :root 규칙이 있어야 한다",
  );
  assert.equal(
    rootRule.style.getPropertyValue("color-scheme").trim(),
    "light dark",
  );

  const COLOR_VARS = [
    "--color-bg",
    "--color-bg-elevated",
    "--color-text-primary",
    "--color-text-muted",
    "--color-accent",
    "--color-border",
    "--color-state-error",
    "--color-state-success",
    "--color-accent-hover",
    "--color-disabled",
    "--color-focus-ring",
  ];
  for (const name of COLOR_VARS) {
    assert.notEqual(
      rootRule.style.getPropertyValue(name).trim(),
      "",
      `라이트 :root 에 ${name} 가 있어야 한다`,
    );
    assert.notEqual(
      darkRootRule.style.getPropertyValue(name).trim(),
      "",
      `다크 :root 에 ${name} 가 있어야 한다`,
    );
  }

  // 정직 한계(머리 주석): jsdom 은 매체질의를 평가하지 않으므로 getComputedStyle
  // 은 항상 라이트 쪽으로 귀결된다 -- "실제 다크 전환"은 이 시험으로 못 잰다.
  const computedBg = dom.window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--color-bg")
    .trim();
  assert.equal(
    computedBg,
    rootRule.style.getPropertyValue("--color-bg").trim(),
    "jsdom 한계: getComputedStyle 은 매체질의와 무관하게 늘 라이트 :root 값으로 귀결된다(직접 확인된 jsdom 동작, 못쟀다 축)",
  );
});
