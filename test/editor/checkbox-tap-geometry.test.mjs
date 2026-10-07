// HYK-304-tap-overlay-geometry-1 (coder-task §3): 연속 체크줄에서 윗줄 탭은 윗줄만 바꾸고,
// 탭 덮개의 CSS 를 실제 스타일시트(public/index.html)에서 직접 읽어 M6(글리프 width 제거)·
// M7(덮개 제거)·덮개 재침범 회귀를 빨갛게 만든다.
//
// jsdom 에는 레이아웃이 없으므로 줄 상자는 테스트가 고정한다(줄마다 27px 씩 아래로 쌓인다).
// 실제 히트 구간(덮개가 이웃 줄을 가로채는지)은 헤드리스 Chrome 실측으로 따로 잰다 --
// 결과 파일 참조. 이 파일은 그 기하의 CSS 원인을 시험으로 붙든다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeProductEditor } from "../support/make-editor.mjs";
import { restoreMarkdownIntoEditor } from "../../src/editor/restore.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";

const { window } = globalThis;

// 탭 판정(@lexical/list)이 읽는 ::before 의 px 너비 -- 실제 CSS 가 1.2em 을 준다(시험 아래 CSS 읽기 참고).
// 레이아웃이 없는 jsdom 에서 zoom 을 빈 문자열로 읽어 0 으로 나누는 경로만 1 로 고정한다.
const realGetComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (el, pseudo) => {
  const real = realGetComputedStyle(el, pseudo);
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "getPropertyValue") {
        return (name) =>
          name === "zoom" ? "1" : target.getPropertyValue(name);
      }
      if (pseudo === "::before" && prop === "width") return "20px";
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

const LINE = 27; // 줄 높이(px) -- 연속 줄은 이 간격으로 쌓인다(실측 27.19px)

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function checkItems(root) {
  return [...root.querySelectorAll("li[aria-checked]")];
}

// 줄 한 개를 주어진 세로 위치(top)에 둔 상자로 만들고 그 줄을 탭한다(좌표는 글리프 안).
function tapRowAt(li, index) {
  const top = index * LINE;
  li.getBoundingClientRect = () => ({
    left: 100,
    top,
    right: 300,
    bottom: top + LINE,
    width: 200,
    height: LINE,
    x: 100,
    y: top,
    toJSON() {},
  });
  for (const type of ["pointerdown", "pointerup"]) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      pointerType: { value: "touch" },
      clientX: { value: 105 },
    });
    li.dispatchEvent(event);
  }
}

// 덮개(::after)가 실제 CSS 에서 어떻게 정해졌는지 파일에서 직접 읽는다.
// 가짜 getComputedStyle 이 아니라 배포되는 스타일시트 원문을 묻는다.
const CSS_PATH = new URL("../../public/index.html", import.meta.url);
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : null;
}

test("연속 체크줄에서 윗줄을 탭하면 윗줄만 바뀌고 아랫줄은 [ ] 로 남는다", async () => {
  const { editor, root } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "- [ ] 첫째\n- [ ] 둘째");
  await settle();
  const [upper] = checkItems(root);
  // 윗줄 탭: 줄 상자는 위에서 0px 부터 27px 까지(아랫줄은 27px 부터). 이 시험은 탭을 윗줄에
  // 직접 건다 -- 히트 가로채기 자체는 jsdom 에 없어 못 본다. 가로채기는 아래 덮개 기하 시험과
  // 헤드리스 Chrome 실측(결과 파일)이 붙든다.
  tapRowAt(upper, 0);
  await settle();

  const after = checkItems(root);
  assert.equal(
    after[0].getAttribute("aria-checked"),
    "true",
    "윗줄이 바뀌어야 한다",
  );
  assert.equal(
    after[1].getAttribute("aria-checked"),
    "false",
    "아랫줄은 그대로여야 한다",
  );
  assert.equal(serializeEditorToMarkdown(editor), "- [x] 첫째\n- [ ] 둘째");
});

test("탭 덮개는 자기 줄의 첫 줄 상자 안에만 있다 -- 이웃 줄을 가로채지 않는다", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const after = ruleBody(css, "#editor-root li[aria-checked]::after");
  assert.ok(after, "덮개(::after) 규칙이 있어야 한다(M7 변이: 규칙 제거)");
  assert.match(after, /position:\s*absolute/, "덮개는 줄 기준으로 놓인다");
  assert.match(
    after,
    /top:\s*0\s*;/,
    "덮개 위쪽은 줄 상자 위쪽에 맞춘다(음수 top 이면 윗줄을 침범한다)",
  );
  assert.match(
    after,
    /height:\s*1lh\s*;/,
    "덮개 높이는 첫 줄 높이(1lh)다 -- 줄 높이보다 크면 아랫줄을 침범한다",
  );
});

test("체크칸 글리프의 px 너비는 CSS 원문에 있다 -- 탭 판정이 NaN 으로 빗나가지 않게", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const before = ruleBody(css, "#editor-root li[aria-checked]::before");
  assert.ok(before, "글리프(::before) 규칙이 있어야 한다");
  assert.match(
    before,
    /width:\s*1\.2em\s*;/,
    "글리프 width 는 1.2em 이어야 한다(M6 변이: width 제거 → 탭 판정이 NaN 으로 전부 빗나간다)",
  );
});
