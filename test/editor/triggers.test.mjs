// coder-task.md §3-ⓐ/ⓕ: 5종 서식(제목·목록·굵게·체크박스·취소선) 각각
// «입력 즉시» 실제 서식으로 서고(PRD §5.2 트리거 규칙), 전환 후 화면
// 텍스트에 마크다운 기호(#, -, [ ], **, ~~)가 남지 않는다(PRD §6).
//
// "트리거가 타이핑 도중에도 정확히(그리고 한글 조합 중엔 절대) 판정되는가"
// 는 test/editor/ime-composition.test.mjs 가 실제 dirty-update 시뮬레이션
// (POC 와 같은 기법)으로 이미 별도로 검증한다. 이 파일은 그것과 다른
// 축을 본다 -- "트리거가 완성됐을 때 (a) 노드 타입이 맞는가 (b) 화면
// DOM 텍스트에 마크다운 기호가 안 남는가"이며, 두 경로(실제 타이핑 vs
// $convertFromMarkdownString 임포트) 모두 같은 PRODUCT_TRANSFORMERS 로
// 같은 노드(HeadingNode/ListNode/ListItemNode/포맷있는 TextNode)를
// 만들므로 임포트 경로로 구성해도 이 축의 검증 가치는 동일하다 --
// registerRichText 로 실제 root DOM 에 실제로 반영된 결과를 읽는다.
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

test('ⓐⓕ 제목: "# 제목" → 헤딩1로 전환, 화면에 "#" 안 남음', () => {
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
  assert.ok(root.textContent.includes("제목"));
});

test('ⓐⓕ 목록: "- 사과" → 목록으로 전환, 화면에 선행 "-" 안 남음', () => {
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
  assert.ok(root.textContent.includes("사과"));
});

test('ⓐⓕ 체크박스: "- [ ] 할일" → 체크박스(미완료)로 전환, 화면에 "[ ]" 안 남음', () => {
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
  assert.ok(root.textContent.includes("할일"));
});

test('ⓐⓕ 굵게: "**굵게**" 닫힘 → 굵게 서식, 화면에 "**" 안 남음', () => {
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
  assert.ok(root.textContent.includes("굵게"));
});

test('ⓐⓕ 취소선: "~~취소~~" 닫힘 → 취소선 서식, 화면에 "~~" 안 남음', () => {
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
  assert.ok(root.textContent.includes("취소"));
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
