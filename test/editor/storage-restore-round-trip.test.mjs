// restore.mjs 는 serialize.mjs 의 역함수다(coder-task.md §0-2-⑸ "치고 ->
// 닫고 -> 다시 열면 그대로"). 대표 원문을 direct 로 에디터에 넣고
// serialize 한 뒤, 그 결과를 restore 로 새 에디터에 되넣고 다시
// serialize 했을 때 원문과 같아야 한다 -- 저장했다가 새로 여는 것의
// 데이터 계층 등가물.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
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

// review.md §3-4/§3-6 -- 붙여넣기 0, "그냥 타이핑"만으로도 serialize.mjs
// 는 짝 없는 "**"/"~~" 를 그대로 원문에 내보낸다(닫는 짝을 못 친 굵게·
// 취소선 단축키, 지우다 만 서식 등). restore 는 이런 짝 없는 마커를
// 서식 토글이 아니라 "글자 그대로" 살려야 한다(§3-2 의 훼손·소실
// 재현을 막는 최소 대표 입력 -- B=별표 두 개, T=물결 두 개).
const UNPAIRED_MARKER_BODIES = [
  "**미완성", // B미완성
  "메모 **", // 메모 B -- 마커 뒤 버퍼가 비어 마커 글자 자체가 사라지던 사례
  "a ** b", // a B b
  "~~미완성", // T미완성
  "메모 ~~", // 메모 T
  "**", // 마커만 있는 줄
  "**세 번**은 남고 마지막 **은 홀로",
  "줄끝에마커**", // 마커가 줄 끝에 오는 경우
];

for (const body of UNPAIRED_MARKER_BODIES) {
  test(`restore -> serialize 왕복이 짝 없는 마커를 글자 그대로 보존한다: ${JSON.stringify(body)}`, () => {
    const { editor } = makeProductEditor();
    restoreMarkdownIntoEditor(editor, body);
    assert.equal(serializeEditorToMarkdown(editor), body);
  });
}

// 화면에 실제로 남는 문단(포맷 토글 없이 문자 그대로)을 만든다 -- 사용자가
// "**"/"~~" 를 키보드로 직접 쳤을 때 에디터 상태가 되는 모양과 같다.
function makeTypedPlainTextEditor(text) {
  const { editor } = makeProductEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(text));
      root.append(paragraph);
    },
    { discrete: true },
  );
  return editor;
}

// coder-task.md §2-2 -- "저장 → 복원 → 재저장" 3단 왕복이 바이트 동일해야
// 한다(예전 시험은 restore -> serialize 한 번만 봤다). 타이핑 그대로의
// 편집기 상태에서 저장(1) -> 복원 -> 재저장(2) -> 다시 복원 -> 재저장(3)
// 까지 세 단계 모두 바이트가 같아야 재접속을 반복해도 안정적이다.
for (const body of UNPAIRED_MARKER_BODIES) {
  test(`3단 왕복(저장→복원→재저장)이 바이트 동일: ${JSON.stringify(body)}`, () => {
    const typedEditor = makeTypedPlainTextEditor(body);
    const saved1 = serializeEditorToMarkdown(typedEditor);
    assert.equal(
      saved1,
      body,
      "타이핑 직후 저장(서식 없음)은 원문과 같아야 한다",
    );

    const { editor: restoredEditor } = makeProductEditor();
    restoreMarkdownIntoEditor(restoredEditor, saved1);
    const saved2 = serializeEditorToMarkdown(restoredEditor);
    assert.equal(
      saved2,
      saved1,
      "복원 후 재저장이 저장 원문과 바이트 동일해야 한다",
    );

    const { editor: reRestoredEditor } = makeProductEditor();
    restoreMarkdownIntoEditor(reRestoredEditor, saved2);
    const saved3 = serializeEditorToMarkdown(reRestoredEditor);
    assert.equal(
      saved3,
      saved2,
      "두 번째 복원 뒤 재저장도 바이트 동일해야 한다(반복 재접속 안정성)",
    );
  });
}
