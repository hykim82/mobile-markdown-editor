// HYK-304-shortcut-bar-1 (PRD §5.3 · 수용 기준 ①②③⑤, ④는 CSS 시험 아래).
// 칩 5종을 실제 버튼 click 으로 구동해 삽입 결과를 저장 원문(serializeEditorToMarkdown)
// 으로 확인한다. 조합 게이트는 선례(ime-composition.test.mjs)와 같이 native
// CompositionEvent 로 구동한다. 실제 탭·좌표 측정은 헤드리스 Chrome 에서 따로 잰다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as lexical from "lexical";
import {
  makeProductEditor,
  waitForNextUpdate,
} from "../support/make-editor.mjs";
import { setNativeSelection, getTextDomNode } from "../support/jsdom-env.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";
import {
  SHORTCUT_CHIPS,
  mountShortcutBar,
} from "../../src/editor/shortcut-bar.mjs";

const { window, document } = globalThis;

// 본문 한 문단을 만들고 caret 을 offset 에 둔다. 빈 문자열이면 빈 문단이다.
function setupEditor(text, caret = text.length) {
  const { editor, root } = makeProductEditor();
  const container = document.createElement("div");
  document.body.appendChild(container);
  mountShortcutBar(editor, container);
  editor.update(
    () => {
      const paragraph = lexical.$createParagraphNode();
      const textNode = lexical.$createTextNode(text);
      paragraph.append(textNode);
      lexical.$getRoot().append(paragraph);
      textNode.select(caret, caret);
    },
    { discrete: true },
  );
  return { editor, root, container };
}

function chipButton(container, label) {
  const button = [...container.querySelectorAll(".shortcut-chip")].find(
    (b) => b.textContent === label,
  );
  assert.ok(button, `칩 "${label}" 버튼이 있어야 한다`);
  return button;
}

function tap(container, label) {
  chipButton(container, label).dispatchEvent(
    new window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}

function markdownOf(editor) {
  return serializeEditorToMarkdown(editor);
}

function caretOffset(editor) {
  return editor.getEditorState().read(() => {
    const selection = lexical.$getSelection();
    return lexical.$isRangeSelection(selection)
      ? selection.anchor.offset
      : null;
  });
}

test("칩 5종은 PRD §5.3 매핑 그대로다(임의 추가·변경 0)", () => {
  assert.deepEqual(
    SHORTCUT_CHIPS.map(({ label, text }) => [label, text]),
    [
      ["제목", "#"],
      ["목록", "-"],
      ["굵게", "** **"],
      ["체크박스", "- [ ]"],
      ["취소선", "~~ ~~"],
    ],
  );
});

test("칩 5종 각각 탭 → 커서 위치에 정확히 그 문자열이 삽입된다(①)", () => {
  for (const chip of SHORTCUT_CHIPS) {
    const { editor, container } = setupEditor("");
    tap(container, chip.label);
    assert.equal(
      markdownOf(editor),
      chip.text,
      `칩 "${chip.label}" 이 저장 원문으로 "${chip.text}"를 남겨야 한다`,
    );
  }
});

test("칩은 커서 위치에 끼워 넣는다 -- 앞뒤 본문은 그대로다(①)", () => {
  const { editor, container } = setupEditor("abc", 1);
  tap(container, "취소선");
  assert.equal(markdownOf(editor), "a~~ ~~bc");
});

test("굵게 칩은 커서를 삽입 문자열 가운데(오프셋 3)에 둔다(PRD §5.3 '커서 가운데')", () => {
  const { editor, container } = setupEditor("");
  tap(container, "굵게");
  assert.equal(caretOffset(editor), 3);
});

test("삽입이 일어나지 않으면 본문은 불변이다(③) -- 범위 선택이 없을 때", () => {
  const { editor, container } = setupEditor("본문");
  editor.update(() => lexical.$setSelection(null), { discrete: true });
  tap(container, "제목");
  assert.equal(markdownOf(editor), "본문");
});

test("조합 중 칩 탭은 아무것도 넣지 않는다, 조합 확정 뒤에는 넣는다(②)", () => {
  const { editor, root, container } = setupEditor("");
  setNativeSelection(getTextDomNode(root), 0);
  root.dispatchEvent(
    new window.CompositionEvent("compositionstart", {
      data: "",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(editor.isComposing(), true);
  const before = markdownOf(editor);
  tap(container, "목록");
  assert.equal(
    markdownOf(editor),
    before,
    "조합 중에는 칩 삽입이 본문을 바꾸면 안 된다 -- 한글 조합이 깨진다",
  );

  root.dispatchEvent(
    new window.CompositionEvent("compositionend", {
      data: "",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(editor.isComposing(), false);
  tap(container, "목록");
  assert.equal(markdownOf(editor), "-");
});

test("칩으로 넣은 문법은 그 뒤 타이핑한 공백에서 §5.2 트리거가 발화한다(⑤의 실측 부분)", async () => {
  // 실측 사실(결과 파일에 적는다): 칩이 넣은 `#` 자체는 헤딩 트리거가 아니다
  // (HEADING 정규식은 `#` 뒤 공백을 요구한다). 사용자가 공백을 한 글자 더
  // 치면 그때 발화한다. 이 시험은 그 경로를 고정한다.
  const { editor, container } = setupEditor("");
  tap(container, "제목");
  assert.equal(
    editor
      .getEditorState()
      .read(() => lexical.$getRoot().getFirstChild().getType()),
    "paragraph",
    "칩 `#` 한 번으로는 헤딩이 되지 않는다",
  );
  editor.update(
    () => {
      const selection = lexical.$getSelection();
      selection.insertText(" ");
    },
    { discrete: true },
  );
  // 변이로 발화가 끊기면 다음 update 가 영영 안 온다 -- 기다림에 상한을 둔다.
  await Promise.race([
    waitForNextUpdate(editor),
    new Promise((resolve) => setTimeout(resolve, 50)),
  ]);
  assert.equal(
    editor
      .getEditorState()
      .read(() => lexical.$getRoot().getFirstChild().getType()),
    "heading",
  );
});

test("단축키바 칩은 44px 이상이다(④) -- 실제 스타일시트 값을 읽는다", () => {
  const css = readFileSync(
    new URL("../../public/index.html", import.meta.url),
    "utf8",
  );
  const rule = css.match(/\.shortcut-chip \{([^}]*)\}/);
  assert.ok(rule, "칩 규칙이 public/index.html 에 있어야 한다");
  assert.match(rule[1], /min-height:\s*44px/);
});
