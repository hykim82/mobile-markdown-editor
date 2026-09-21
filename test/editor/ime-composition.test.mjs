// coder-task.md §3-ⓑ (PRD §5.2 수용 기준②): 한글 조합 중에는 트리거
// 판정이 «안 선다», 조합이 끝나면 «선다». 조합 이벤트는 실제 손질하지
// 않은 @lexical/markdown 의 registerMarkdownShortcuts 를 진짜 jsdom
// contenteditable 위에서 native CompositionEvent 로 구동해 검증한다 --
// 우리가 게이트 로직을 다시 구현한 게 아니라 실제 라이브러리 동작을
// 확인하는 것이다. 기법은 POC(poc-lexical 브랜치
// poc/lexical/ime-composition.test.mjs)와 동일하되, 우리 제품
// 트랜스포머(src/editor/transformers.mjs)를 대상으로 다시 짰다.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../support/jsdom-env.mjs";
import { setNativeSelection, getTextDomNode } from "../support/jsdom-env.mjs";
import * as lexical from "lexical";
import {
  makeProductEditor,
  waitForNextUpdate,
} from "../support/make-editor.mjs";

const { window } = globalThis;

function firstNodeType(editor) {
  return editor.getEditorState().read(() => {
    const first = lexical.$getRoot().getFirstChild();
    return first ? first.getType() : null;
  });
}

test("조합 중에는 트리거가 정확히 일치해도 판정이 0회다(적대적 dirty update)", async () => {
  const { editor, root } = makeProductEditor();
  let anchorKey;

  editor.update(
    () => {
      const paragraph = lexical.$createParagraphNode();
      const textNode = lexical.$createTextNode("#");
      paragraph.append(textNode);
      lexical.$getRoot().append(paragraph);
      textNode.select(1, 1);
      anchorKey = textNode.getKey();
    },
    { discrete: true },
  );
  assert.equal(firstNodeType(editor), "paragraph");

  setNativeSelection(getTextDomNode(root), 1);
  root.dispatchEvent(
    new window.CompositionEvent("compositionstart", {
      data: "",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(
    editor.isComposing(),
    true,
    "compositionstart 는 isComposing()을 true로 바꿔야 한다",
  );

  // 최악의 경우: 조합 중(isComposing()===true)에 "# " 트리거와 정확히
  // 일치하는 dirty update 가 들어온다. 게이트가 없다면 이것만으로
  // 문단이 헤딩으로 바뀐다.
  editor.update(
    () => {
      const textNode = lexical.$getNodeByKey(anchorKey);
      textNode.setTextContent("# ");
      textNode.select(2, 2);
    },
    { discrete: true },
  );

  assert.equal(
    editor.isComposing(),
    true,
    "적대적 dirty update 이후에도 여전히 조합 중이어야 한다",
  );
  assert.equal(
    firstNodeType(editor),
    "paragraph",
    "isComposing()===true 인 동안 트리거 판정 횟수는 0이어야 한다 -- 문단이 헤딩으로 바뀌면 안 된다",
  );

  await Promise.race([
    waitForNextUpdate(editor),
    new Promise((resolve) => setTimeout(resolve, 50)),
  ]);
  assert.equal(
    firstNodeType(editor),
    "paragraph",
    "조합 중에는 지연된 변환도 나중에 몰래 들어오면 안 된다",
  );
});

test("조합 종료 후에는 같은 조건에서 트리거 판정이 정상 재개된다", async () => {
  const { editor, root } = makeProductEditor();

  editor.update(
    () => {
      const paragraph = lexical.$createParagraphNode();
      const textNode = lexical.$createTextNode("#");
      paragraph.append(textNode);
      lexical.$getRoot().append(paragraph);
      textNode.select(1, 1);
    },
    { discrete: true },
  );

  setNativeSelection(getTextDomNode(root), 1);
  root.dispatchEvent(
    new window.CompositionEvent("compositionstart", {
      data: "",
      bubbles: true,
      cancelable: true,
    }),
  );
  root.dispatchEvent(
    new window.CompositionEvent("compositionend", {
      data: "",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(
    editor.isComposing(),
    false,
    "compositionend 는 isComposing()을 다시 false로 바꿔야 한다",
  );

  // 방금 조합했던 노드가 아니라 새 문단으로 확인한다 -- 실제 IME 가 만들
  // DOM 텍스트를 같은 노드에 그대로 재현하는 것은 별개의(DOM 재조정
  // 의존적인) 관심사라 여기서 같이 재지 않는다(§6 정직 한계에 기록).
  let secondNodeKey;
  editor.update(
    () => {
      const paragraph = lexical.$createParagraphNode();
      const textNode = lexical.$createTextNode("#");
      paragraph.append(textNode);
      lexical.$getRoot().append(paragraph);
      textNode.select(1, 1);
      secondNodeKey = textNode.getKey();
    },
    { discrete: true },
  );
  editor.update(
    () => {
      const textNode = lexical.$getNodeByKey(secondNodeKey);
      textNode.setTextContent("# ");
      textNode.select(2, 2);
    },
    { discrete: true },
  );
  await waitForNextUpdate(editor);

  const secondNodeType = editor.getEditorState().read(() => {
    const second = lexical.$getRoot().getChildAtIndex(1);
    return second ? second.getType() : null;
  });
  assert.equal(
    secondNodeType,
    "heading",
    "조합이 끝난 뒤에 일어난 타이핑에는 트리거가 정상적으로 걸려야 한다",
  );
});
