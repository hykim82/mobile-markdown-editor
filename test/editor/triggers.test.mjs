// coder-task.md §3-ⓐ/ⓕ: 5종 서식(제목·목록·굵게·체크박스·취소선) 각각
// «입력 즉시» 실제 서식으로 서고(PRD §5.2 트리거 규칙), 전환 후 화면
// 텍스트에 마크다운 기호(#, -, [ ], **, ~~)가 남지 않는다(PRD §6).
//
// "트리거가 타이핑 도중에도 정확히(그리고 한글 조합 중엔 절대) 판정되는가"
// 는 test/editor/ime-composition.test.mjs 가 실제 dirty-update 시뮬레이션
// (POC 와 같은 기법)으로 이미 별도로 검증한다. 이 파일은 그것과 다른
// 축을 본다 -- "트리거가 완성됐을 때 (a) 노드 타입이 맞는가 (b) 화면
// DOM 텍스트에 마크다운 기호가 안 남는가 (c) «그려진 겉모습»이 실제로
// 서식을 갖는가(HYK-304-render-layer-review-1 P1-1: hasFormat 같은 노드
// 내부 상태만 보면 취소선이 class="" 인 맨 <span>으로 나가도 통과해
// 버린다 -- 굵게가 <strong> 의미 태그 덕에 "우연히" 통과하는 것과 같은
// 구멍이 취소선에서는 뚫렸다). (c)는 5종 전부에 같은 모양으로 건다:
// 실제 프로덕션 CSS(public/index.html)가 서식을 그리는 데 쓰는 바로 그
// 선택자(h1 / ul>li / li[aria-checked] / .editor-bold /
// .editor-strikethrough)가 렌더된 DOM에 실재하는지를 본다. 두 경로(실제
// 타이핑 vs $convertFromMarkdownString 임포트) 모두 같은
// PRODUCT_TRANSFORMERS 로 같은 노드를 만들고, 같은 EDITOR_THEME 로
// createEditor 된 root 에 registerRichText 로 실제로 반영된 결과를
// 읽으므로 임포트 경로로 구성해도 이 축의 검증 가치는 동일하다.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../support/jsdom-env.mjs";
import { $getRoot } from "lexical";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { $isHeadingNode } from "@lexical/rich-text";
import { $isListNode, $isListItemNode } from "@lexical/list";
import { PRODUCT_TRANSFORMERS } from "../../src/editor/transformers.mjs";
import { makeProductEditor } from "../support/make-editor.mjs";

function renderMarkdown(editor, markdown) {
  editor.update(
    () => {
      $convertFromMarkdownString(markdown, PRODUCT_TRANSFORMERS);
    },
    { discrete: true },
  );
}

// 프로덕션 CSS(public/index.html)가 그 서식을 «그리는 데» 실제로 쓰는
// 선택자로 렌더된 DOM을 조회한다 -- 통과하면 "노드 내부 상태가 맞다"가
// 아니라 "이 선택자를 겨냥한 CSS 규칙이 실제로 매치할 요소가 화면에
// 있다"는 뜻이다.
function assertRendersVisually(root, selector, expectedText, formatLabel) {
  const el = root.querySelector(selector);
  assert.ok(
    el,
    `${formatLabel}: 화면 DOM에 선택자 "${selector}" 에 매치하는 요소가 없다(= 그려질 CSS 규칙이 겨냥할 대상이 없다). root: ${root.innerHTML}`,
  );
  assert.ok(
    el.textContent.includes(expectedText),
    `${formatLabel}: 렌더된 요소에 "${expectedText}" 텍스트가 없다: ${el.textContent}`,
  );
}

test('ⓐⓕ 제목: "# 제목" → 헤딩1로 전환, 화면에 "#" 안 남음, 실제 <h1> 로 그려짐', () => {
  const { editor, root } = makeProductEditor();
  renderMarkdown(editor, "# 제목");
  const type = editor
    .getEditorState()
    .read(() => $getRoot().getFirstChild().getType());
  assert.equal(type, "heading");
  assert.ok(
    !root.textContent.includes("#"),
    `화면 텍스트에 '#' 기호가 남으면 안 된다: ${root.textContent}`,
  );
  assertRendersVisually(root, "h1", "제목", "제목(h1)");
});

test('ⓐⓕ 목록: "- 사과" → 목록으로 전환, 화면에 선행 "-" 안 남음, 실제 <ul><li> 로 그려짐', () => {
  const { editor, root } = makeProductEditor();
  renderMarkdown(editor, "- 사과");
  const type = editor
    .getEditorState()
    .read(() => $getRoot().getFirstChild().getType());
  assert.equal(type, "list");
  assert.ok(
    !root.textContent.startsWith("-"),
    `화면 텍스트 맨 앞에 '-' 기호가 남으면 안 된다: ${root.textContent}`,
  );
  assertRendersVisually(root, "ul > li", "사과", "목록(ul>li)");
});

test('ⓐⓕ 체크박스: "- [ ] 할일" → 체크박스(미완료)로 전환, 화면에 "[ ]" 안 남음, 실제 li[aria-checked="false"] 로 그려짐(public/index.html 의 ::before 네모 글리프가 겨냥하는 바로 그 선택자)', () => {
  const { editor, root } = makeProductEditor();
  renderMarkdown(editor, "- [ ] 할일");
  const [type, checked] = editor.getEditorState().read(() => {
    const first = $getRoot().getFirstChild();
    const item = first.getFirstChild();
    return [
      first.getType(),
      $isListItemNode(item) ? item.getChecked() : undefined,
    ];
  });
  assert.equal(type, "list");
  assert.equal(checked, false);
  assert.ok(
    !root.textContent.includes("["),
    `화면 텍스트에 '[' 기호가 남으면 안 된다: ${root.textContent}`,
  );
  assertRendersVisually(
    root,
    'li[aria-checked="false"]',
    "할일",
    "체크박스(미완료)",
  );
});

test('ⓐⓕ 굵게: "**굵게**" 닫힘 → 굵게 서식, 화면에 "**" 안 남음, 실제 .editor-bold 클래스로 그려짐(HYK-304-render-layer-review-1 P1-1: <strong> 태그만 믿지 않는다 -- theme.text.bold 클래스가 실제로 붙는지까지 본다)', () => {
  const { editor, root } = makeProductEditor();
  renderMarkdown(editor, "**굵게**");
  const hasBold = editor.getEditorState().read(() => {
    const paragraph = $getRoot().getFirstChild();
    return paragraph
      .getChildren()
      .some(
        (child) =>
          typeof child.hasFormat === "function" && child.hasFormat("bold"),
      );
  });
  assert.equal(hasBold, true);
  assert.ok(
    !root.textContent.includes("**"),
    `화면 텍스트에 '**' 기호가 남으면 안 된다: ${root.textContent}`,
  );
  assertRendersVisually(root, ".editor-bold", "굵게", "굵게(class)");
});

test('ⓐⓕ 취소선: "~~취소~~" 닫힘 → 취소선 서식, 화면에 "~~" 안 남음, 실제 .editor-strikethrough 클래스로 그려짐(HYK-304-render-layer-review-1 P1-1 수리 검증 -- theme 가 없으면 class="" 인 맨 <span> 이 되어 이 시험이 RED 가 된다)', () => {
  const { editor, root } = makeProductEditor();
  renderMarkdown(editor, "~~취소~~");
  const hasStrike = editor.getEditorState().read(() => {
    const paragraph = $getRoot().getFirstChild();
    return paragraph
      .getChildren()
      .some(
        (child) =>
          typeof child.hasFormat === "function" &&
          child.hasFormat("strikethrough"),
      );
  });
  assert.equal(hasStrike, true);
  assert.ok(
    !root.textContent.includes("~~"),
    `화면 텍스트에 '~~' 기호가 남으면 안 된다: ${root.textContent}`,
  );
  assertRendersVisually(root, ".editor-strikethrough", "취소", "취소선(class)");
});

test("헤딩 레벨 2·3도 트리거된다(레벨 1만이 아님을 확인)", () => {
  for (const [markdown, level] of [
    ["## 소제목", 2],
    ["### 소제목", 3],
  ]) {
    const { editor } = makeProductEditor();
    renderMarkdown(editor, markdown);
    const tag = editor.getEditorState().read(() => {
      const first = $getRoot().getFirstChild();
      return $isHeadingNode(first) ? first.getTag() : null;
    });
    assert.equal(tag, `h${level}`);
  }
});

test('체크박스 완료("- [x] ")도 트리거된다', () => {
  const { editor } = makeProductEditor();
  renderMarkdown(editor, "- [x] 완료");
  const checked = editor.getEditorState().read(() => {
    const list = $getRoot().getFirstChild();
    return $isListNode(list) ? list.getFirstChild().getChecked() : undefined;
  });
  assert.equal(checked, true);
});
