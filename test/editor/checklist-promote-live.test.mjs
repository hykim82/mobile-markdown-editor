// HYK-304 checkbox-in-list (.harness/coder-task.md §1): 점 목록(`- `)을 먼저
// 만든 뒤 그 줄에 `[ ] ` 를 치면 체크박스가 되어야 한다(PRD §5.2 트리거 +
// §6 "마크다운 기호 비노출"). 원인은 checklist-live-typing-gap.test.mjs 의
// 주석에 적힌 대로다: `- ` 가 먼저 불릿을 만들면 엘리먼트 트리거는 그 뒤로
// 다시 검사되지 않는다. 이 시험은 그 한계가 닫혔음을 실제 입력(insertText)
// 으로 고정한다(src/editor/checklist-promote.mjs 가 그 자리를 메운다).
//
// 경계 (coder-task.md §1-2):
//  1) 다른 트리거 판정은 그대로 -- triggers/ime 시험이 따로 지킨다.
//  2) "- [y] 이상한값" 은 여전히 불릿(체크박스 모양이 아니다).
//  3) "[ ]" 처럼 뒤 공백이 없으면 전환하지 않는다(PRD 문면 "[ ] ").
//  4) 한글 조합 중에는 전환되지 않고, 조합 종료 뒤에는 정상 전환된다.
//  5) 전환 뒤 커서가 텍스트 안에 그대로 남는다(이어 치기가 맞게 들어간다).
import { test } from "node:test";
import assert from "node:assert/strict";
import "../support/jsdom-env.mjs";
import { setNativeSelection, getTextDomNode } from "../support/jsdom-env.mjs";
import * as lexical from "lexical";
import { $convertFromMarkdownString } from "@lexical/markdown";
import {
  $createListNode,
  $createListItemNode,
  $isListNode,
  $isListItemNode,
} from "@lexical/list";
import { PRODUCT_TRANSFORMERS } from "../../src/editor/transformers.mjs";
import { makeProductEditor } from "../support/make-editor.mjs";
import { restoreMarkdownIntoEditor } from "../../src/editor/restore.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";

const { window } = globalThis;

// 중첩 update(마크다운 단축키가 listener 안에서 거는 것)가 끝날 시간을 준다.
// 트랜스폼이 nested update 를 안 거는 경우도 있어 waitForNextUpdate 는 쓰지
// 않는다(없을 때 영원히 기다린다).
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 커서 위치에 글자를 하나씩 넣는다 -- 실제 키 입력과 같은 경로(insertText)
// 이므로 트리거 판정 시점이 타이핑과 같다.
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

// "- " 를 실제로 쳐서 불릿 줄을 만들고, 커서를 그 줄 안에 둔다.
function startBulletLine(editor) {
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
}

// 최상위 블록을 [종류, 항목 텍스트, 체크여부] 로 요약한다.
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

test('ⓐ 재현: 불릿 줄(- )에서 "[ ] 할일" 을 순차 입력하면 체크박스(미완료)가 된다', async () => {
  const { editor, root } = makeProductEditor();
  startBulletLine(editor);
  await settle();
  assert.equal(
    summarize(editor)[0].kind,
    "bullet",
    '전제: "- " 뒤에는 불릿이다',
  );

  typeText(editor, "[ ] 할일");
  await settle();

  assert.deepEqual(summarize(editor), [
    { kind: "check", items: [{ text: "할일", checked: false }] },
  ]);
  assert.ok(
    !root.textContent.includes("["),
    `화면에 '[' 기호가 남으면 안 된다: ${root.textContent}`,
  );
  assert.ok(
    root.querySelector('li[aria-checked="false"]'),
    "화면 DOM 에 미완료 체크 항목(li[aria-checked=false])이 있어야 한다",
  );
});

test('ⓐ 완료형: 불릿 줄에서 "[x] 끝" 을 치면 체크된 체크박스가 된다', async () => {
  const { editor, root } = makeProductEditor();
  startBulletLine(editor);
  await settle();
  typeText(editor, "[x] 끝");
  await settle();

  assert.deepEqual(summarize(editor), [
    { kind: "check", items: [{ text: "끝", checked: true }] },
  ]);
  assert.ok(
    root.querySelector('li[aria-checked="true"]'),
    "화면 DOM 에 완료 체크 항목(li[aria-checked=true])이 있어야 한다",
  );
});

test('경계 2: 불릿 줄에서 "[y] 이상한값" 은 체크박스가 아니라 여전히 불릿이다', async () => {
  const { editor } = makeProductEditor();
  startBulletLine(editor);
  await settle();
  typeText(editor, "[y] 이상한값");
  await settle();

  assert.deepEqual(summarize(editor), [
    { kind: "bullet", items: [{ text: "[y] 이상한값", checked: undefined }] },
  ]);
});

test('경계 3: 불릿 줄에서 "[ ]" 까지만(뒤 공백 없음) 치면 전환하지 않는다', async () => {
  const { editor } = makeProductEditor();
  startBulletLine(editor);
  await settle();
  typeText(editor, "[ ]");
  await settle();

  assert.deepEqual(summarize(editor), [
    { kind: "bullet", items: [{ text: "[ ]", checked: undefined }] },
  ]);
});

test("중간 줄: 여러 항목 목록의 둘째 줄을 체크박스로 바꾸면 앞·뒤 불릿은 그대로 남는다", async () => {
  const { editor } = makeProductEditor();
  // 불릿 목록(사과·배·감)을 직접 만든다 -- 제품은 Enter 로 목록 항목을
  // 잇는 경로가 아직 결선돼 있지 않아(registerList 없음), 여기서는 목록
  // 구조만 고정하고 그 둘째 항목에 실제 입력을 친다.
  // 둘째 항목이 이미 "[ ] 배" 인 목록을 한 갱신에 만든다 -- 트랜스폼은 그 갱신의
  // 커밋에서 돈다. 커서를 바깥에서 목록 안으로 «들여보내는» 것은 cursor-raw 가
  // 목록을 원문으로 펼치는 설계라(그 경로는 cursor-raw 시험의 일) 여기서는
  // 펼치기가 끼어들기 전 커밋 직후 상태만 본다(그래서 settle 을 쓰지 않는다).
  editor.update(
    () => {
      const root = lexical.$getRoot();
      root.clear();
      const list = $createListNode("bullet");
      for (const label of ["사과", "[ ] 배", "감"]) {
        const item = $createListItemNode();
        item.append(lexical.$createTextNode(label));
        list.append(item);
      }
      root.append(list);
    },
    { discrete: true },
  );

  assert.deepEqual(summarize(editor), [
    { kind: "bullet", items: [{ text: "사과", checked: undefined }] },
    { kind: "check", items: [{ text: "배", checked: false }] },
    { kind: "bullet", items: [{ text: "감", checked: undefined }] },
  ]);
});

test("조합 중에는 전환되지 않고, 조합 종료 뒤 같은 줄을 건드리면 전환된다", async () => {
  const { editor, root } = makeProductEditor();
  editor.update(
    () => {
      $convertFromMarkdownString("- 배", PRODUCT_TRANSFORMERS);
    },
    { discrete: true },
  );
  await settle();

  const textNode = editor
    .getEditorState()
    .read(() =>
      lexical.$getRoot().getFirstChild().getFirstChild().getFirstChild(),
    );
  const key = textNode.getKey();
  setNativeSelection(getTextDomNode(root), 0);
  root.dispatchEvent(
    new window.CompositionEvent("compositionstart", {
      data: "",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(editor.isComposing(), true);

  // 조합 중(= 트리거 판정 금지 구간)에 "[ ] 배" 가 완성된 상태를 만든다.
  editor.update(
    () => {
      const node = lexical.$getNodeByKey(key);
      node.setTextContent("[ ] 배");
      node.select(4, 4);
    },
    { discrete: true },
  );
  await settle();
  assert.equal(
    summarize(editor)[0].kind,
    "bullet",
    "조합 중에는 체크박스 판정이 0회여야 한다",
  );

  root.dispatchEvent(
    new window.CompositionEvent("compositionend", {
      data: "",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(editor.isComposing(), false);

  // 조합이 끝난 뒤 같은 줄을 다시 건드리면(다음 입력) 판정이 선다.
  editor.update(
    () => {
      const node = lexical.$getNodeByKey(key);
      node.setTextContent(node.getTextContent());
    },
    { discrete: true },
  );
  await settle();

  assert.deepEqual(summarize(editor), [
    { kind: "check", items: [{ text: "배", checked: false }] },
  ]);
});

// 왕복(coder-task.md §1-3): 전환된 체크박스가 저장 원문으로 "- [ ] " 로 돌아오고,
// 같은 원문을 다시 복원해도 바이트가 같다.
test('왕복: 타이핑으로 만든 체크박스는 저장 원문 "- [ ] 할일" 로 나간다', async () => {
  const { editor } = makeProductEditor();
  startBulletLine(editor);
  await settle();
  typeText(editor, "[ ] 할일");
  await settle();

  // 변별력(P3-1): 원문만 보면 결선을 떼도 "- [ ] 할일" 이 같아 초록이다 --
  // 화면 구조가 체크 목록이어야 전환이 실제로 일어났다고 판정한다.
  assert.deepEqual(summarize(editor), [
    { kind: "check", items: [{ text: "할일", checked: false }] },
  ]);
  assert.equal(serializeEditorToMarkdown(editor), "- [ ] 할일");
});

test("왕복: 가운데 줄 체크 전환 뒤 저장 원문이 그 한 줄만 바뀐 원문과 같다", () => {
  const { editor } = makeProductEditor();
  editor.update(
    () => {
      const root = lexical.$getRoot();
      root.clear();
      const list = $createListNode("bullet");
      for (const label of ["사과", "배", "감"]) {
        const item = $createListItemNode();
        item.append(lexical.$createTextNode(label));
        list.append(item);
      }
      root.append(list);
    },
    { discrete: true },
  );
  // 둘째 항목 글자를 "[ ] 배" 로 바꿔 승격을 실제로 태운다(P3-1 변별력: 구조 단언).
  editor.update(
    () => {
      const list = lexical.$getRoot().getFirstChild();
      list.getChildren()[1].getFirstChild().setTextContent("[ ] 배");
    },
    { discrete: true },
  );
  assert.deepEqual(summarize(editor), [
    { kind: "bullet", items: [{ text: "사과", checked: undefined }] },
    { kind: "check", items: [{ text: "배", checked: false }] },
    { kind: "bullet", items: [{ text: "감", checked: undefined }] },
  ]);

  const body = "- 사과\n- [ ] 배\n- 감";
  assert.equal(serializeEditorToMarkdown(editor), body);

  const again = makeProductEditor().editor;
  restoreMarkdownIntoEditor(again, body);
  assert.equal(serializeEditorToMarkdown(again), body);
});
