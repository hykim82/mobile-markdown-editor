// HYK-304 checkbox-in-list 2R (1R 검토 P1-1 · P1-2 · P2-1 · P3-4 수리 고정).
//
// 1R 의 실패: 승격(checklist-promote.mjs)이 복원 중에도 돌아서, 저장 원문이
// 대문자 "[X] " 이거나 굵게·취소선 안에 "[ ] " 인 줄이 복원 뒤 다른 바이트로
// 바뀌었다. 그 자리에서 restore round-trip mismatch 가 서서 자동저장이 막혔다
// (storage-mount.mjs 안전판은 정상 작동했다 -- 안전판을 약화시키지 않고 승격을
// 좁혔다).
//
// 이 파일의 판정 기준은 "바이트 동일"과 "화면 구조"다. 카드(coder.md §6)의 각
// 줄은 아래 시험 중 하나로 고정돼 있다 -- 줄 번호를 적어 대응을 남긴다.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../support/jsdom-env.mjs";
import * as lexical from "lexical";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { $isListNode, $isListItemNode } from "@lexical/list";
import { PRODUCT_TRANSFORMERS } from "../../src/editor/transformers.mjs";
import { makeProductEditor } from "../support/make-editor.mjs";
import { setNativeSelection, getTextDomNode } from "../support/jsdom-env.mjs";
import { restoreMarkdownIntoEditor } from "../../src/editor/restore.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";
import { mountStorage } from "../../src/editor/storage-mount.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";
import { writeCurrentMemoId } from "../../src/storage/current-memo-pointer.mjs";

const { window } = globalThis;

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 커서를 최상위 블록 끝으로 옮긴다 -- 바깥에서 들어오면 cursor-raw 가 그 블록을
// 원문으로 펼치고, 나가면 접는다(cursor-raw-fold-safety.test.mjs 와 같은 방식).
async function placeCaretInBlock(editor, index) {
  editor.update(
    () => {
      lexical.$getRoot().getChildren()[index].selectEnd();
    },
    { discrete: true },
  );
  await settle();
}

// 최상위 블록을 [종류, 항목 텍스트, 체크여부] 로 요약한다(checklist-promote-live 와 같은 모양).
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

// ─── 1. P1-1: 저장된 11형태가 복원 뒤 바이트 그대로 나온다 ───────────────────

const STORED_FORMS = [
  "- [X] 할일",
  "- **[ ] b**",
  "- **[x] b**",
  "- ~~[ ] b~~",
  "- **[X] b**",
  "- a\n- **[ ] b**\n- c",
  "- [ ] **b**",
  "- [y] x",
  "- [ ]x",
  "# [ ] 제목",
  "[ ] 문단",
];

for (const body of STORED_FORMS) {
  test(`P1-1 복원 왕복(현재 형식): ${JSON.stringify(body)} 는 바이트 그대로 나온다`, async () => {
    const { editor } = makeProductEditor();
    restoreMarkdownIntoEditor(editor, body);
    await settle();
    assert.equal(serializeEditorToMarkdown(editor), body);
  });

  test(`P1-1 복원 왕복(옛 형식 legacy): ${JSON.stringify(body)} 는 바이트 그대로 나온다`, async () => {
    const { editor } = makeProductEditor();
    restoreMarkdownIntoEditor(editor, body, { legacy: true });
    await settle();
    assert.equal(serializeEditorToMarkdown(editor, { legacy: true }), body);
  });
}

// 실제 저장 경로(mountStorage → restoreCurrentMemo → 사용자 입력 → 저장)로 통과시킨다.
// 1R 검토가 "자동저장이 세션 내내 막히고 그 세션의 입력이 저장되지 않는다"고 잰
// 바로 그 경로다(P1-1 ⓐ~ⓓ). 레코드에 bodyFormat 마커가 없으면 옛 형식이다.
for (const body of STORED_FORMS.filter(
  (b) => b.includes("[") && b !== "[ ] 문단",
)) {
  test(`P1-1 저장 경로: ${JSON.stringify(body)} 를 열어도 안전판이 서지 않고 입력이 저장된다`, async () => {
    writeCurrentMemoId("roundtrip-storage-1");
    const adapter = createFakeAdapter();
    await adapter.put({
      id: "roundtrip-storage-1",
      title: "제목",
      body,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    });
    const { editor } = makeProductEditor();
    const notice = document.createElement("div");
    notice.hidden = true;
    const store = mountStorage(editor, notice, adapter);
    await settle();

    assert.equal(
      store.restoreState.autosaveBlocked,
      false,
      "복원 왕복이 맞으면 안전판이 서면 안 된다",
    );
    assert.equal(notice.hidden, true, "안내 문구가 떠서는 안 된다");

    // 사용자가 맨 끝에 한 글자를 친다(일반 입력 = 태그 없는 갱신).
    editor.update(
      () => {
        lexical.$getRoot().getLastChild().selectEnd();
        lexical.$getSelection().insertText("끝");
      },
      { discrete: true },
    );
    await settle();
    await store.flushImmediate();

    const saved = await adapter.get("roundtrip-storage-1");
    assert.equal(
      saved.body,
      serializeEditorToMarkdown(editor),
      "입력한 글자가 저장 원문에 들어가야 한다",
    );
    assert.notEqual(saved.body, body, "저장이 실제로 일어나야 한다");
  });
}

// ─── 2. P1-2 카드 줄: 체크 칸 확인 ──────────────────────────────────────────

test("카드 줄 ③: 한글 조합 중에는 바뀌지 않고, 글자가 확정되면 따로 누르지 않아도 체크 칸이 된다", async () => {
  const { editor, root } = makeProductEditor();
  editor.update(
    () => {
      $convertFromMarkdownString("- 배", PRODUCT_TRANSFORMERS);
    },
    { discrete: true },
  );
  await settle();
  const key = editor
    .getEditorState()
    .read(() =>
      lexical.$getRoot().getFirstChild().getFirstChild().getFirstChild(),
    )
    .getKey();
  setNativeSelection(getTextDomNode(root), 0);
  root.dispatchEvent(
    new window.CompositionEvent("compositionstart", {
      data: "",
      bubbles: true,
      cancelable: true,
    }),
  );
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
    "조합 중에는 전환되지 않는다",
  );

  // 확정(compositionend)만 온다 -- 같은 줄을 한 번 더 건드리지 않는다.
  root.dispatchEvent(
    new window.CompositionEvent("compositionend", {
      data: "",
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle();
  assert.deepEqual(summarize(editor), [
    { kind: "check", items: [{ text: "배", checked: false }] },
  ]);
});

// ─── 3. P1-2 카드 줄: 체크 줄 커서 진입·이탈 왕복 ───────────────────────────

test("카드 줄 ⑤: 체크 줄에 커서를 넣으면 원문으로 펼쳐지고, 다른 줄로 옮기면 체크 칸과 체크 상태로 돌아온다", async () => {
  const body = "- [x] 끝\n\n메모";
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, body);
  await settle();

  await placeCaretInBlock(editor, 0);
  const expanded = summarize(editor)[0];
  assert.equal(expanded.kind, "paragraph", "진입하면 원문 문단으로 펼쳐진다");
  assert.equal(expanded.text, "- [x] 끝");
  assert.equal(
    serializeEditorToMarkdown(editor),
    body,
    "펼친 상태도 저장 원문은 그대로",
  );

  await placeCaretInBlock(editor, 1);
  assert.deepEqual(summarize(editor)[0], {
    kind: "check",
    items: [{ text: "끝", checked: true }],
  });
  assert.equal(serializeEditorToMarkdown(editor), body);
});

// ─── 4. P1-2 카드 줄: 가운데 줄 (정상 동작을 실패로 가르치지 않는 문장) ─────

test("카드 줄 ④: 여러 줄 목록 가운데 줄에 「[ ] 」를 치면 목록이 원문으로 펼쳐져 그 자리에서는 체크 칸이 안 생기고, 저장과 다시 열기에서는 체크 칸이 된다", async () => {
  const body = "- 사과\n- 배\n- 감\n\n메모";
  const { editor, root } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, body);
  await settle();

  // 가운데 줄("- 배")에 커서를 넣는다 -- 목록 전체가 원문 문단으로 펼쳐진다.
  await placeCaretInBlock(editor, 0);
  assert.equal(summarize(editor)[0].kind, "paragraph");

  // 펼친 문단 안 둘째 줄("- 배") 글자 앞, "- " 바로 뒤에 "[ ] " 를 친다.
  editor.update(
    () => {
      const paragraph = lexical.$getRoot().getFirstChild();
      const secondLine = paragraph.getChildren()[2];
      secondLine.select(2, 2);
      lexical.$getSelection().insertText("[ ] ");
    },
    { discrete: true },
  );
  await settle();
  assert.equal(
    summarize(editor)[0].kind,
    "paragraph",
    "펼친 상태에서는 체크 칸이 생기지 않는다(원문 문단)",
  );
  assert.equal(
    root.querySelector('li[aria-checked="false"]'),
    null,
    "화면에 체크 칸 요소가 없다",
  );

  // 커서를 뺀다 -- 종류가 섞인 원문은 접히지 않고 원문 그대로 남는다.
  await placeCaretInBlock(editor, 1);
  assert.equal(
    serializeEditorToMarkdown(editor),
    "- 사과\n- [ ] 배\n- 감\n\n메모",
    "저장 원문은 한 줄만 바뀐 그대로다",
  );

  // 앱을 다시 열면(저장 원문 복원) 가운데 줄이 체크 칸으로 보인다.
  const reopened = makeProductEditor();
  restoreMarkdownIntoEditor(reopened.editor, serializeEditorToMarkdown(editor));
  await settle();
  assert.deepEqual(summarize(reopened.editor), [
    { kind: "bullet", items: [{ text: "사과", checked: undefined }] },
    { kind: "check", items: [{ text: "배", checked: false }] },
    { kind: "bullet", items: [{ text: "감", checked: undefined }] },
    { kind: "paragraph", text: "메모" },
  ]);
  assert.ok(reopened.root.querySelector('li[aria-checked="false"]'));
});

// ─── 5. P2-1: 접기가 승격 뒤에 뒤집히지 않는다 ───────────────────────────────

const FOLD_FORMS = [
  ["- **[ ] b**", "bullet"],
  ["- ~~[ ] b~~", "bullet"],
  ["- **[X] b**", "bullet"],
  ["- a\n- **[ ] b**\n- c", null],
];

for (const [list, kind] of FOLD_FORMS) {
  test(`P2-1 접기 불변식: ${JSON.stringify(list)} 를 펼쳤다 접어도 바이트와 종류가 그대로다`, async () => {
    const body = `${list}\n\n메모`;
    const { editor } = makeProductEditor();
    restoreMarkdownIntoEditor(editor, body);
    await settle();

    await placeCaretInBlock(editor, 0);
    await placeCaretInBlock(editor, 1);

    assert.equal(serializeEditorToMarkdown(editor), body);
    if (kind !== null) {
      assert.equal(
        summarize(editor)[0].kind,
        kind,
        "승격이 펼침 뒤에 목록을 체크로 바꾸면 안 된다",
      );
    }
  });
}

// ─── 6. P3-4: 제거된 목록 키가 softJoin 집합에 남지 않는다 ──────────────────

// P3-4(1R 검토): 승격으로 사라지는 목록의 키가 softJoin 집합에 남는다. 이
// 시험은 그 키가 «원문을 바꾸지 않는다»만 고정한다. 남는 키는 Lexical 인접
// 병합으로 합쳐져 사라진 체크 목록의 키다 -- Lexical 은 키를 재사용하지 않으므로
// 다른 노드가 그 키를 물려받아 잘못 이어 붙는 일은 없다(무해 · 이월 기록).
test("P3-4 관측: 승격 뒤 합쳐진 목록의 남은 키가 있어도 저장 원문은 맞다", async () => {
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "- a\n- [ ] b\n- c");
  await settle();

  editor.update(
    () => {
      const list = lexical.$getRoot().getChildren()[2];
      const text = list.getFirstChild().getFirstChild();
      text.setTextContent("[ ] c");
    },
    { discrete: true },
  );
  await settle();

  assert.equal(serializeEditorToMarkdown(editor), "- a\n- [ ] b\n- [ ] c");
});

// 복원 뒤 빈 목록 없이 같은 종류 목록이 합쳐지는 것은 Lexical 의 인접 병합이
// 맡는다 -- 이 시험은 그 경로에서 저장 원문이 줄바꿈 하나로 이어지는지도 본다.
test("P3-2 관측: 둘째 묶음의 유일한 항목이 체크 전환되면 앞 체크 목록과 줄바꿈 하나로 이어진다", async () => {
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "- [ ] 사과\n- 배");
  await settle();
  editor.update(
    () => {
      const list = lexical.$getRoot().getChildren()[1];
      list.getFirstChild().getFirstChild().setTextContent("[ ] 배");
    },
    { discrete: true },
  );
  await settle();
  assert.equal(serializeEditorToMarkdown(editor), "- [ ] 사과\n- [ ] 배");
});
