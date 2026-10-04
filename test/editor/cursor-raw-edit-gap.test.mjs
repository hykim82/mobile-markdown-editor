// coder-task.md §3-ⓖ (PRD §5.2 수용 기준③): "렌더링된 서식 영역에 커서
// 진입 시 그 줄의 마크다운 원문을 그대로 복원해 편집 가능"해야 한다.
//
// 이력(HYK-304-cursor-raw-restore-1, 2026-10-04 닫힘): 예전 이 파일은 "한계"
// 를 고정했다 -- registerMarkdownShortcuts 가 트리거 완성 순간 "#"·"**"·"~~"
// 를 노드 트리에서 지우므로 커서 진입만으로는 원문을 되살릴 데이터가 없다는
// 것. 그 한계 자체는 여전히 참이다(아래 첫 시험이 그대로 지킨다). 닫힌 방법은
// cursor-raw.mjs 다 -- 커서가 들어오면 그 줄을 원문으로 펼치고(원문은
// serialize.mjs 가 제품 안에서 다시 조립한다), 나가면 restore.mjs 로 다시
// 접는다. 아래 "닫힘" 시험들이 그 동작을 단정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "../support/jsdom-env.mjs";
import { $getRoot, $getSelection } from "lexical";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { PRODUCT_TRANSFORMERS } from "../../src/editor/transformers.mjs";
import { restoreMarkdownIntoEditor } from "../../src/editor/restore.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";
import { makeProductEditor } from "../support/make-editor.mjs";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// 화면 갱신(등록된 update 리스너의 중첩 update)은 다음 태스크에 반영된다.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 최상위 블록 index 번째 끝으로 커서를 옮긴다 -- 실제 탭과 같은 선택 변화.
async function placeCaretInBlock(editor, index) {
  editor.update(
    () => {
      $getRoot().getChildren()[index].selectEnd();
    },
    { discrete: true },
  );
  await settle();
}

function topLevelTexts(editor) {
  return editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map((node) => node.getTextContent()),
  );
}

function topLevelTypes(editor) {
  return editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map((node) => node.getType()),
  );
}

test('알려진 한계(여전히 참): 트리거 완성 후 헤딩 노드 텍스트에는 "#"가 전혀 남아 있지 않다 -- 단축키 자체는 원문을 보관하지 않는다', () => {
  const { editor } = makeProductEditor();
  editor.update(
    () => {
      $convertFromMarkdownString("# 제목", PRODUCT_TRANSFORMERS);
    },
    { discrete: true },
  );
  const headingText = editor
    .getEditorState()
    .read(() => $getRoot().getFirstChild().getTextContent());
  assert.equal(headingText, "제목");
  assert.ok(
    !headingText.includes("#"),
    "헤딩 노드가 원본 '#' 프리픽스를 어딘가에 보관하고 있다면 이 한계 기록은 갱신이 필요하다",
  );
});

// 닫힘 ⓐ -- PRD §5.1⑤·§5.2③: 다섯 트리거 각각에 커서가 들어오면 그 줄이 원문
// 으로 펼쳐지고(화면 원문 = 저장 원문), 나가면 다시 서식으로 접히며, 그 왕복에서
// 저장 원문 바이트가 한 글자도 안 바뀐다(sha256 전후 동일).
const TRIGGER_CASES = [
  ["헤딩1", "# 제목"],
  ["헤딩2", "## 둘"],
  ["헤딩3", "### 셋"],
  ["목록", "- 항목"],
  ["체크박스(미완료)", "- [ ] 할일"],
  ["체크박스(완료)", "- [x] 끝"],
  ["굵게", "**굵게**"],
  ["취소선", "~~취소~~"],
];

for (const [label, line] of TRIGGER_CASES) {
  test(`닫힘: ${label} -- 커서 진입 시 "${line}" 원문이 펼쳐지고, 나가면 서식으로 접히며 저장 원문은 바이트 동일`, async () => {
    const body = `${line}\n\n끝`;
    const { editor } = makeProductEditor();
    restoreMarkdownIntoEditor(editor, body);
    const before = sha256(serializeEditorToMarkdown(editor));

    await placeCaretInBlock(editor, 0);
    assert.equal(
      topLevelTexts(editor)[0],
      line,
      "펼친 줄 화면은 원문이어야 한다",
    );
    assert.equal(serializeEditorToMarkdown(editor), body);
    assert.equal(sha256(serializeEditorToMarkdown(editor)), before);

    await placeCaretInBlock(editor, 1);
    assert.notEqual(
      topLevelTexts(editor)[0],
      line,
      "커서가 나가면 원문이 아니라 서식 화면으로 접혀야 한다",
    );
    assert.equal(serializeEditorToMarkdown(editor), body);
    assert.equal(sha256(serializeEditorToMarkdown(editor)), before);
  });
}

// 닫힘 ⓑ -- 펼친 원문 안에서 실제로 글자를 치면 그 글자가 저장 원문에 남고, 나갈 때
// 서식으로 접힌다(편집 가능). 한 글자도 잃지 않는다.
test("닫힘: 펼친 원문에 글자를 치면 그 글자가 저장되고, 접을 때 서식 안에 남는다", async () => {
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "# 제목\n\n끝");
  await placeCaretInBlock(editor, 0);

  editor.update(
    () => {
      const selection = $getRoot().getFirstChild().selectEnd();
      selection.insertText("x");
    },
    { discrete: true },
  );
  await settle();
  assert.equal(topLevelTexts(editor)[0], "# 제목x");
  assert.equal(serializeEditorToMarkdown(editor), "# 제목x\n\n끝");

  await placeCaretInBlock(editor, 1);
  assert.equal(serializeEditorToMarkdown(editor), "# 제목x\n\n끝");
  assert.equal(topLevelTypes(editor)[0], "heading");
});

// 닫힘 ⓒ -- 한글 조합(IME) 중에는 펼치지 않는다(PRD §8 "한글 조합 깨짐").
test("닫힘: 한글 조합 중에는 펼치지 않는다(조합이 끝난 뒤 판정)", async () => {
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "# 제목\n\n끝");
  editor.isComposing = () => true;
  try {
    await placeCaretInBlock(editor, 0);
    assert.equal(
      topLevelTexts(editor)[0],
      "제목",
      "조합 중에는 원문으로 펼치면 안 된다",
    );
  } finally {
    delete editor.isComposing;
  }
  // 조합 중에 이미 그 블록 안에 있었다면 조합이 끝났다고 펼치지 않는다 -- 펼침은
  // "다른 블록에서 들어옴"만 본다. 그래서 나갔다가 다시 들어와 확인한다.
  await placeCaretInBlock(editor, 1);
  await placeCaretInBlock(editor, 0);
  assert.equal(
    topLevelTexts(editor)[0],
    "# 제목",
    "조합이 끝난 뒤 다시 들어오면 펼친다",
  );
});

// 닫힘 ⓓ -- 다섯 트리거와 평문이 한 문서에 섞여 있어도, 블록마다 커서가 드나들
// 때 저장 원문이 매 단계 같다(왕복 누적 손실 없음).
// 목록 두 개는 "\n\n" 으로 나눈다 -- 불릿과 체크박스가 한 목록에 섞이면 기존
// restore 가 체크 표식을 잃는다(HYK-304-cursor-raw-restore-1 보고 참고).
test("닫힘: 여러 블록을 차례로 드나들어도 저장 원문은 매 단계 바이트 동일하다", async () => {
  const body =
    "# 제목\n\n- 목록 하나\n- 목록 둘\n\n- [ ] 체크\n- [x] 완료\n\n**굵게** 본문\n\n~~취소~~\n\n평문";
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, body);
  const before = sha256(body);
  const count = topLevelTypes(editor).length;
  for (let round = 0; round < 2; round += 1) {
    for (let index = 0; index < count; index += 1) {
      await placeCaretInBlock(editor, index);
      assert.equal(
        sha256(serializeEditorToMarkdown(editor)),
        before,
        `블록 ${index} 진입 후`,
      );
    }
  }
  assert.equal(serializeEditorToMarkdown(editor), body);
});

// 닫힘 ⓔ -- 빈 제목("# ")도 펼친 채 남고, 저장 원문은 그대로다. 펼친 줄이 빈 제목
// 처럼 트리거 공백 바로 뒤에 커서를 두는 경우의 회귀 시험이다.
test('닫힘: 빈 제목("# ")도 펼친 채 남는다 -- 단축키가 되돌리지 않는다', async () => {
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "# \n\n끝");
  await placeCaretInBlock(editor, 0);
  assert.equal(
    topLevelTexts(editor)[0],
    "# ",
    "빈 제목도 원문으로 펼쳐져야 한다",
  );
  assert.equal(serializeEditorToMarkdown(editor), "# \n\n끝");
});

// 닫힘 ⓕ -- 빈 제목("# ")으로 들어올 때 직전 커서 위치가 1글자 자리였으면 단축키의
// 위치 판정이 통과해 펼친 "# " 을 다시 헤딩으로 바꾼다. HISTORIC_TAG 가 그 판정을
// 막는다는 것을 이 시험이 잡는다(태그를 빼면 빨개진다).
test('닫힘: 1글자 자리에서 빈 제목("# ")으로 들어와도 원문으로 남는다', async () => {
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "x\n\n# \n\n끝");
  await placeCaretInBlock(editor, 0);
  await placeCaretInBlock(editor, 1);
  assert.equal(
    topLevelTexts(editor)[1],
    "# ",
    "단축키가 되돌리면 헤딩이 된다 -- HISTORIC_TAG 가 막는 경로",
  );
  assert.equal(serializeEditorToMarkdown(editor), "x\n\n# \n\n끝");
});

// 닫힘 ⓖ -- 펼침은 "다른 블록에서 들어옴"만 본다. 사용자가 평문 단락 끝에 "# " 을
// 쳐서 제목이 방금 만들어졌다면, 커서가 아직 그 제목 안에 있어도 서식으로 남는다
// (바로 원문으로 되돌아가면 라이브 렌더링이 깨진다).
test("닫힘: 타이핑으로 방금 완성한 제목은 커서가 있는 동안 서식으로 남는다(진입이 아님)", async () => {
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "#");
  // 실제 타이핑과 같게 커서를 먼저 두고(이전 선택이 있어야 단축키가 판정한다),
  // 다음 갱신에서 공백을 친다.
  editor.update(
    () => {
      $getRoot().getLastChild().selectEnd();
    },
    { discrete: true },
  );
  editor.update(
    () => {
      $getSelection().insertText(" ");
    },
    { discrete: true },
  );
  await settle();
  await settle();
  assert.equal(topLevelTypes(editor)[0], "heading");
  assert.equal(topLevelTexts(editor)[0], "");
});
