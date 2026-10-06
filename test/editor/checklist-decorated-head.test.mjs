// HYK-304 checkbox-decorated-head (.harness/coder-task.md §0): 글자를 굵게·취소선으로
// 먼저 꾸민 목록 줄의 맨 앞에서 "[ ] " 를 치면 체크 칸이 생겨야 한다(PRD §5.2 · §5.3 ⑤).
// 이 시험은 A 축(승격)만 단정한다. B 축(저장본 복원 바이트 보존)은
// checklist-promote-roundtrip.test.mjs 가 그대로 지킨다.
//
// 입력은 실제 타이핑과 같은 경로(insertText)다. 꾸민 줄은 "- " → "**b**" 를
// 쳐서 만들고, 커서를 그 굵은 글자 머리로 옮겨 "[ ] " 를 친다.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../support/jsdom-env.mjs";
import * as lexical from "lexical";
import { $isListNode, $isListItemNode } from "@lexical/list";
import { makeProductEditor } from "../support/make-editor.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";
import { restoreMarkdownIntoEditor } from "../../src/editor/restore.mjs";

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function typeText(editor, text) {
  for (const ch of text) {
    editor.update(
      () => {
        const sel = lexical.$getSelection();
        if (!lexical.$isRangeSelection(sel)) {
          throw new Error("typeText: 커서(RangeSelection)가 없다");
        }
        sel.insertText(ch);
      },
      { discrete: true },
    );
  }
}

function summarize(editor) {
  return editor.getEditorState().read(() =>
    lexical
      .$getRoot()
      .getChildren()
      .map((block) => {
        if (!$isListNode(block)) {
          return { kind: block.getType(), text: block.getTextContent() };
        }
        return {
          kind: block.getListType(),
          items: block
            .getChildren()
            .filter($isListItemNode)
            .map((item) => ({
              text: item.getTextContent(),
              checked: item.getChecked(),
            })),
        };
      }),
  );
}

// 꾸민 글자 노드를 만든다: "- " 뒤에 "**b**" 를 치면 굵은 "b" 노드가 생긴다.
// 커서는 그 굵은 글자 머리(오프셋 0)로 옮긴다 -- 줄 안 이동이라 펼침이 없다.
// 줄바꿈(Enter)은 실제 키 입력 경로인 insertParagraph 로 친다.
// 굵은 글자 뒤의 Enter 는 굵은 서식을 이어받으므로 서식을 0 으로 되돌린다.
function enter(editor) {
  editor.update(
    () => {
      lexical.$getSelection().insertParagraph();
      lexical.$getSelection().format = 0;
    },
    { discrete: true },
  );
}

async function startDecoratedHead(editor, marker, text) {
  editor.update(
    () => {
      const paragraph = lexical.$createParagraphNode();
      lexical.$getRoot().clear();
      lexical.$getRoot().append(paragraph);
      paragraph.select(0, 0);
    },
    { discrete: true },
  );
  typeText(editor, "- ");
  await settle();
  typeText(editor, `${marker}${text}${marker}`);
  await settle();
  editor.update(
    () => {
      const list = lexical.$getRoot().getFirstChild();
      const decorated = list.getFirstChild().getFirstChild();
      decorated.select(0, 0);
    },
    { discrete: true },
  );
  await settle();
}

test("A 굵게 머리: 굵은 글자 머리에서 「[ ] 」를 치면 체크 칸(미완료)이 된다", async () => {
  const { editor, root } = makeProductEditor();
  await startDecoratedHead(editor, "**", "b");
  assert.equal(summarize(editor)[0].kind, "bullet", "전제: 굵은 불릿 줄이다");

  typeText(editor, "[ ] ");
  await settle();

  assert.deepEqual(summarize(editor), [
    { kind: "check", items: [{ text: "b", checked: false }] },
  ]);
  assert.ok(
    root.querySelector('li[aria-checked="false"]'),
    "화면 DOM 에 미완료 체크 항목이 있어야 한다",
  );
  assert.equal(
    serializeEditorToMarkdown(editor),
    "- [ ] **b**",
    "저장 원문은 체크 접두어 뒤에 굵은 글자가 온다",
  );
});

test("A 취소선 머리: 취소선 글자 머리에서 「[x] 」를 치면 체크된 체크 칸이 된다", async () => {
  const { editor, root } = makeProductEditor();
  await startDecoratedHead(editor, "~~", "b");
  typeText(editor, "[x] ");
  await settle();

  assert.deepEqual(summarize(editor), [
    { kind: "check", items: [{ text: "b", checked: true }] },
  ]);
  assert.ok(root.querySelector('li[aria-checked="true"]'));
  assert.equal(serializeEditorToMarkdown(editor), "- [x] ~~b~~");
});

test("A 여러 줄: 가운데 꾸민 줄 머리에서 「[ ] 」를 치면 그 줄만 체크 칸이 되고 앞뒤 줄은 불릿으로 남는다", async () => {
  const { editor } = makeProductEditor();
  editor.update(
    () => {
      const paragraph = lexical.$createParagraphNode();
      lexical.$getRoot().clear();
      lexical.$getRoot().append(paragraph);
      paragraph.select(0, 0);
    },
    { discrete: true },
  );
  typeText(editor, "- a");
  await settle();
  enter(editor);
  typeText(editor, "**b**");
  await settle();
  enter(editor);
  typeText(editor, "c");
  await settle();
  editor.update(
    () => {
      const list = lexical.$getRoot().getFirstChild();
      const second = list.getChildren()[1];
      second.getFirstChild().select(0, 0);
    },
    { discrete: true },
  );
  await settle();

  typeText(editor, "[ ] ");
  await settle();

  assert.equal(serializeEditorToMarkdown(editor), "- a\n- [ ] **b**\n- c");
});

test("A 경계: 굵은 머리에서 대문자 「[X] 」는 체크 칸이 되지 않는다(소문자 기준 · 직전 라운드 확정)", async () => {
  const { editor } = makeProductEditor();
  await startDecoratedHead(editor, "**", "b");
  typeText(editor, "[X] ");
  await settle();

  assert.deepEqual(summarize(editor), [
    { kind: "bullet", items: [{ text: "[X] b", checked: undefined }] },
  ]);
});

// B 축 교차 시험(A 를 얻으면서 B 가 깨지지 않는 조건): 사람이 굵은 글자 안에 커서를
// 둔 채로도 저장 원문 복원은 바이트를 바꾸지 않는다. 복원 뒤 커서가 복원된 글자
// 안으로 옮겨 가지 않는다는 것을 시작·끝 두 자리에서 본다(checklist-promote-roundtrip
// 의 B 단언은 그대로 두고, 이 시험은 그 교차 자리만 더한다).
const RESTORE_BODIES = [
  "- **[ ] b**",
  "- ~~[ ] b~~",
  "- **[x] b**",
  "- a\n- **[ ] b**\n- c",
];
for (const body of RESTORE_BODIES) {
  for (const where of ["start", "end"]) {
    test(`B 교차: 커서가 굵은 글자 ${where} 에 있는 채로 ${JSON.stringify(body)} 를 복원해도 바이트가 그대로다`, async () => {
      const { editor } = makeProductEditor();
      editor.update(
        () => {
          const paragraph = lexical.$createParagraphNode();
          lexical.$getRoot().clear();
          lexical.$getRoot().append(paragraph);
          paragraph.select(0, 0);
        },
        { discrete: true },
      );
      typeText(editor, "- ");
      await settle();
      typeText(editor, "**x**");
      await settle();
      editor.update(
        () => {
          const text = lexical
            .$getRoot()
            .getFirstChild()
            .getFirstChild()
            .getFirstChild();
          if (where === "start") text.select(0, 0);
          else text.select(1, 1);
        },
        { discrete: true },
      );
      await settle();

      restoreMarkdownIntoEditor(editor, body);
      await settle();

      assert.equal(serializeEditorToMarkdown(editor), body);
    });
  }
}
