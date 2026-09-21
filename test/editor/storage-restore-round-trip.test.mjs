// restore.mjs 는 serialize.mjs 의 역함수다(coder-task.md §0-2-⑸ "치고 ->
// 닫고 -> 다시 열면 그대로"). 대표 원문을 direct 로 에디터에 넣고
// serialize 한 뒤, 그 결과를 restore 로 새 에디터에 되넣고 다시
// serialize 했을 때 원문과 같아야 한다 -- 저장했다가 새로 여는 것의
// 데이터 계층 등가물.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProductEditor } from "../support/make-editor.mjs";
import { restoreMarkdownIntoEditor } from "../../src/editor/restore.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";

const REPRESENTATIVE_BODIES = [
  "그냥 문단",
  "# 헤딩1",
  "## 헤딩2",
  "### 헤딩3",
  "- 첫줄\n- 둘째줄",
  "- [ ] 할일\n- [x] 다한일",
  "**굵게**",
  "~~취소선~~",
  "**굵고 ~~취소도~~ 같이**",
  "# 하나\n\n## 둘\n\n### 셋",
  "문단 하나\n\n- 목록 하나\n- 목록 둘\n\n**굵은** 문단",
];

for (const body of REPRESENTATIVE_BODIES) {
  test(`restore -> serialize 왕복이 원문을 보존한다: ${JSON.stringify(body)}`, () => {
    const { editor } = makeProductEditor();
    restoreMarkdownIntoEditor(editor, body);
    assert.equal(serializeEditorToMarkdown(editor), body);
  });
}

test("빈 본문을 restore 하면 에디터가 비어있다(빈 문단만)", () => {
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "");
  assert.equal(serializeEditorToMarkdown(editor), "");
});
