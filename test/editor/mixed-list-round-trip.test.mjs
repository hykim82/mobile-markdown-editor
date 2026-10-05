// HYK-304-mixed-list-fix-1 -- 불릿과 체크박스가 섞인 목록의 왕복(선재 결함).
//
// 결함: restore.mjs 의 buildListNode 는 첫 줄 하나로 목록 종류를 정해 모든
// 항목을 그 종류로 만든다. 그래서 "- 목록" 아래 "- [ ] 체크"는 체크 표식이
// 사라지고(소멸), "- [ ] 체크" 아래 "- 목록"은 없던 체크 상자가 생긴다(날조).
// 1R·2R 검토가 base 에서 같은 계측기로 값을 냈다(review 원문 · 9케이스).
//
// 이 파일은 그 아홉 케이스를 바이트 왕복 시험으로 옮긴다. 기대값은 원문
// 그대로다 -- 수리 전에는 3건이 빨갛고(소멸·날조) 6건은 초록이어야 한다
// (그 6건은 과차단 금지 축이다: 순수 목록·헤딩·굵게·공백·"- [y] 이상").
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { $getRoot } from "lexical";
import { makeProductEditor } from "../support/make-editor.mjs";
import { restoreMarkdownIntoEditor } from "../../src/editor/restore.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";

function roundTrip(body) {
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, body);
  return serializeEditorToMarkdown(editor);
}

// 소멸 방향: 첫 줄이 불릿인데 뒤에 체크가 온다.
const VANISH = ["- 목록\n- [ ] 체크", "- 목록\n- [x] 완료\n- 셋"];
// 날조 방향: 첫 줄이 체크인데 뒤에 불릿이 온다.
const FABRICATE = ["- [ ] 체크\n- 목록"];
// 섞임 셋: 체크 하나 뒤 불릿 둘, 끝에 체크 완료.
const MIXED_RUNS = ["- [ ] 하나\n- 둘\n- [x] 셋"];
// 과차단 금지(초록 유지): 종류가 섞이지 않은 목록·헤딩·굵게·공백·무효 체크 모양.
const GUARD = [
  "- 사과\n- 바나나\n- 포도",
  "- [ ] 할일\n- [x] 완료",
  "# 제목",
  "- **굵게** 항목",
  "#  두칸 공백",
  "- [y] 이상",
];

for (const body of [...VANISH, ...FABRICATE, ...MIXED_RUNS]) {
  test(`혼합 목록 왕복 바이트 불변(선재 결함 · 수리 전 빨강): ${JSON.stringify(body)}`, () => {
    assert.equal(roundTrip(body), body);
  });
}

for (const body of GUARD) {
  test(`과차단 금지 왕복 바이트 불변: ${JSON.stringify(body)}`, () => {
    assert.equal(roundTrip(body), body);
  });
}

// 커서 왕복(HYK-304-mixed-list-fix-1): 혼합 목록의 묶음에 커서가 들어갔다
// 나와도 저장 원문은 바이트가 그대로여야 한다 -- 펼친 묶음을 접을 때 이어
// 붙는 표지(softJoin)가 새 노드로 옮겨지는지를 잰다.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function placeCaretInBlock(editor, index) {
  editor.update(
    () => {
      $getRoot().getChildren()[index].selectEnd();
    },
    { discrete: true },
  );
  await settle();
}

function lastBlockIndex(editor) {
  return editor.getEditorState().read(() => $getRoot().getChildrenSize() - 1);
}

const CURSOR_CASES = [
  ["- 목록\n- [ ] 체크\n\n끝", 1],
  ["- 목록\n- [ ] 체크\n\n끝", 0],
  ["- [ ] 하나\n- 둘\n- [x] 셋\n\n끝", 1],
  ["- [ ] 하나\n- 둘\n- [x] 셋\n\n끝", 2],
];

for (const [body, enterIndex] of CURSOR_CASES) {
  test(`혼합 목록 커서 왕복 바이트 불변: ${JSON.stringify(body)} · 블록 ${enterIndex} 진입`, async () => {
    const { editor } = makeProductEditor();
    restoreMarkdownIntoEditor(editor, body);
    await placeCaretInBlock(editor, enterIndex);
    await placeCaretInBlock(editor, lastBlockIndex(editor));
    assert.equal(serializeEditorToMarkdown(editor), body);
    await placeCaretInBlock(editor, enterIndex);
    assert.equal(serializeEditorToMarkdown(editor), body);
    await placeCaretInBlock(editor, lastBlockIndex(editor));
    assert.equal(serializeEditorToMarkdown(editor), body);
  });
}
