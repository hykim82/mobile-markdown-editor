// 커서 진입 원문 복원의 접기 안전판(HYK-304-cursor-raw-restore-2 · 1R 검토
// P1-1 · P2-1 · P2-2). 1R 시험은 목록을 빈 줄로 갈라 "펼친 원문에서 목록 종류를
// 섞는 경우"를 피했다 -- 이 파일이 그 경로를 한 글자씩 실제 타자로 잰다.
//
// 판정 기준은 글자(화면 텍스트)와 저장 원문 바이트다. 펼친 줄을 떠나는 순간
// 사용자 글자가 사라지거나 저장 원문이 블록을 쪼개면 실패다.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../support/jsdom-env.mjs";
import { $getRoot, $getSelection } from "lexical";
import { restoreMarkdownIntoEditor } from "../../src/editor/restore.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";
import { makeProductEditor } from "../support/make-editor.mjs";

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

// 첫 블록의 마지막 텍스트 조각 안에서 [start, end) 를 고른다 -- 펼친 줄의 마지막
// 항목 글자 위치를 가리키는 실제 커서 이동과 같다.
async function selectInLastText(editor, start, end) {
  editor.update(
    () => {
      $getRoot().getFirstChild().getLastChild().select(start, end);
    },
    { discrete: true },
  );
  await settle();
}

async function typeText(editor, text) {
  editor.update(
    () => {
      $getSelection().insertText(text);
    },
    { discrete: true },
  );
  await settle();
}

async function removeSelected(editor) {
  editor.update(
    () => {
      $getSelection().removeText();
    },
    { discrete: true },
  );
  await settle();
}

function firstBlockText(editor) {
  return editor
    .getEditorState()
    .read(() => $getRoot().getFirstChild().getTextContent());
}

function topLevelTypes(editor) {
  return editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map((node) => node.getType()),
  );
}

// P1-1 -- "- 목록" 아래에 체크 표식을 타자로 넣으면 커서를 빼는 순간 그 글자가
// 사라지던 경로(검토자 재현 그대로: "[", " ", "]", " " 를 항목 2 앞에 친다).
test("P1-1: 펼친 목록에 '[ ] ' 를 쳐 항목 종류를 섞으면 커서를 빼도 글자가 남고 저장 원문이 그대로다", async () => {
  const body = "- 목록\n- 둘\n\n끝";
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, body);

  await placeCaretInBlock(editor, 0);
  await selectInLastText(editor, 2, 2);
  for (const ch of ["[", " ", "]", " "]) {
    await typeText(editor, ch);
  }
  assert.equal(firstBlockText(editor), "- 목록\n- [ ] 둘");

  await placeCaretInBlock(editor, 1);
  assert.equal(
    firstBlockText(editor),
    "- 목록\n- [ ] 둘",
    "커서를 빼면 치던 글자가 사라지면 안 된다 -- 접지 않고 원문으로 둔다",
  );
  assert.equal(
    serializeEditorToMarkdown(editor),
    "- 목록\n- [ ] 둘\n\n끝",
    "저장 원문은 사용자가 친 그대로여야 한다(화면과 디스크가 갈리면 안 된다)",
  );

  await placeCaretInBlock(editor, 1);
  await typeText(editor, "x");
  assert.equal(
    serializeEditorToMarkdown(editor),
    "- 목록\n- [ ] 둘\n\n끝x",
    "다른 블록에 글자를 쳐도 앞 블록 글자가 사라지지 않는다(손실 확정 경로)",
  );
});

// P1-1 거울 -- 체크목록에서 "[ ] " 를 지우면(평범한 불릿으로 바꾸려는 편집) 커서를
// 뺄 때 체크 상자가 되살아나던 경로. 이제 사용자가 지운 그대로 남는다.
test("P1-1 거울: 펼친 체크목록에서 '[ ] ' 를 지워 종류를 섞으면 커서를 빼도 지운 그대로 남는다", async () => {
  const body = "- [ ] 하나\n- [ ] 둘\n\n끝";
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, body);

  await placeCaretInBlock(editor, 0);
  await selectInLastText(editor, 2, 6);
  await removeSelected(editor);
  assert.equal(firstBlockText(editor), "- [ ] 하나\n- 둘");

  await placeCaretInBlock(editor, 1);
  assert.equal(firstBlockText(editor), "- [ ] 하나\n- 둘");
  assert.equal(
    serializeEditorToMarkdown(editor),
    "- [ ] 하나\n- 둘\n\n끝",
    "지운 '[ ] ' 가 되살아나면 사용자 편집이 조용히 되돌려진 것이다",
  );
});

// 접기가 일어나는 정상 경로는 그대로다 -- 종류가 한 가지로 남은 목록은 평소처럼
// 서식으로 접힌다(P1-1 판정이 과하게 막지 않는다).
test("P1-1 정상 경로: 펼친 목록에서 글자만 고쳐도 종류가 같으면 평소처럼 서식으로 접힌다", async () => {
  const body = "- 목록\n- 둘\n\n끝";
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, body);

  await placeCaretInBlock(editor, 0);
  await selectInLastText(editor, 3, 3);
  await typeText(editor, "!");
  assert.equal(firstBlockText(editor), "- 목록\n- 둘!");

  await placeCaretInBlock(editor, 1);
  assert.equal(topLevelTypes(editor)[0], "list");
  assert.equal(serializeEditorToMarkdown(editor), "- 목록\n- 둘!\n\n끝");
});

// P2-1 -- 펼친 제목 안에서 Shift+Enter 로 친 줄바꿈이 맨 "\n" 으로 저장되어
// 블록이 쪼개지던 경로. 이제 하드 줄바꿈 escape 로 나가 저장 원문이 다시 열어도
// 같은 블록 하나로 돌아온다.
test("P2-1: 펼친 제목에서 Shift+Enter 로 친 줄바꿈은 저장 원문이 블록을 쪼개지 않고, 다시 열어도 같다", async () => {
  const body = "# 제목\n\n끝";
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, body);

  await placeCaretInBlock(editor, 0);
  editor.update(
    () => {
      const selection = $getRoot().getFirstChild().selectEnd();
      selection.insertLineBreak();
    },
    { discrete: true },
  );
  await settle();
  await typeText(editor, "뒤");

  const typed = "# 제목\\\n뒤\n\n끝";
  assert.equal(
    serializeEditorToMarkdown(editor),
    typed,
    "펼친 중 저장 원문은 하드 줄바꿈 escape 로 나가야 한다",
  );

  await placeCaretInBlock(editor, 1);
  assert.deepEqual(
    topLevelTypes(editor),
    ["heading", "paragraph"],
    "접은 뒤에도 제목 한 블록이어야 한다(블록이 쪼개지면 안 된다)",
  );
  assert.equal(serializeEditorToMarkdown(editor), typed);

  const { editor: reopened } = makeProductEditor();
  restoreMarkdownIntoEditor(reopened, typed);
  assert.equal(
    serializeEditorToMarkdown(reopened),
    typed,
    "저장된 바이트를 다시 열어도 같은 원문이어야 한다",
  );
});

// P2-2 -- 육안 카드 1~3단계의 실제 동작 대조. 카드는 "방금 타이핑으로 만든 제목은
// 커서가 그 줄 안에 있는 동안 펼쳐지지 않고, 다른 줄을 거쳐 다시 들어와야 펼쳐진다"
// 고 적는다. 그 두 문장이 실제 동작과 같은지 여기서 잰다.
test("P2-2 카드 대조: 타이핑으로 만든 제목은 줄 넘김 뒤 다른 줄에서 들어올 때 펼쳐지고, 나가면 접힌다", async () => {
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "#");
  editor.update(
    () => {
      $getRoot().getLastChild().selectEnd();
    },
    { discrete: true },
  );
  await typeText(editor, " ");
  await typeText(editor, "제목");
  await settle();
  assert.equal(
    topLevelTypes(editor)[0],
    "heading",
    "타이핑으로 제목이 만들어진다",
  );

  // 카드 1단계: 줄을 넘긴다 -- 새 단락으로 커서가 옮겨간다.
  editor.update(
    () => {
      $getSelection().insertParagraph();
    },
    { discrete: true },
  );
  await settle();
  assert.equal(topLevelTypes(editor)[0], "heading");

  // 카드 1단계 탭: 다른 줄에서 제목 줄로 들어온다 -> "# 제목" 이 보인다.
  await placeCaretInBlock(editor, 0);
  assert.equal(
    firstBlockText(editor),
    "# 제목",
    "카드 2단계: 샵과 띄어쓰기가 보인다",
  );

  // 카드 1단계 마지막 탭: 다른 줄을 누르면 다시 큰 글씨 제목으로 돌아간다.
  await placeCaretInBlock(editor, 1);
  assert.equal(
    topLevelTypes(editor)[0],
    "heading",
    "카드 2단계: 다시 제목으로 돌아간다",
  );
});

test("P2-2 카드 대조: 제목 줄 안에 커서가 있는 채 타이핑으로 만든 제목은 펼쳐지지 않는다(설계상 정상)", async () => {
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "#");
  editor.update(
    () => {
      $getRoot().getLastChild().selectEnd();
    },
    { discrete: true },
  );
  await typeText(editor, " ");
  await typeText(editor, "제목");
  assert.equal(topLevelTypes(editor)[0], "heading");
  assert.equal(
    firstBlockText(editor),
    "제목",
    "줄을 넘기지 않고 같은 줄에 머문 것은 '진입'이 아니므로 펼치지 않는다 -- 카드 3단계의 실패 기준에서 제외된다",
  );
});
