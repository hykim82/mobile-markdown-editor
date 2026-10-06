// HYK-304-checkbox-tap-toggle-1 (coder-task §3-1): 렌더된 체크칸을 탭하면
// [ ]↔[x] 가 바뀌고, 그 상태가 저장 원문에 반영되며, 다시 열어도 그대로여야 한다.
//
// 탭은 실제 브라우저 좌표 대신 jsdom 이벤트로 흉내 낸다 -- 라이브러리 판정이 읽는
// 값(li 의 getBoundingClientRect, ::before 의 px 너비)을 고정하고, pointerdown →
// pointerup(touch) 두 이벤트를 보낸다. 실기기 확인은 브라우저 구동으로 따로 잰다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { makeProductEditor } from "../support/make-editor.mjs";
import { restoreMarkdownIntoEditor } from "../../src/editor/restore.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";
import {
  mountStorage,
  restoreCurrentMemo,
} from "../../src/editor/storage-mount.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";
import { writeCurrentMemoId } from "../../src/storage/current-memo-pointer.mjs";

const { window } = globalThis;

// 라이브러리 탭 판정은 ::before 의 px 너비를 읽는다(인라인 'auto' 면 NaN 으로 빗나간다).
// 실제 CSS(public/index.html)가 1.2em 을 주므로 그 값에 맞춘 px 를 준다.
// 또 jsdom 은 레이아웃이 없어 needsManualZoom 이 켜지고, zoom 을 빈 문자열로 읽어
// 0 으로 나눈다 -- 그 경로만 zoom 1 로 고정한다(실브라우저에서는 해당 없음).
const realGetComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (el, pseudo) => {
  const real = realGetComputedStyle(el, pseudo);
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "getPropertyValue") {
        return (name) =>
          name === "zoom" ? "1" : target.getPropertyValue(name);
      }
      if (pseudo === "::before" && prop === "width") return "20px";
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

const ROW = {
  left: 100,
  top: 0,
  right: 300,
  bottom: 27,
  width: 200,
  height: 27,
};

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkItems(root) {
  return [...root.querySelectorAll("li[aria-checked]")];
}

// 체크칸 탭 = 손가락이 닿음(pointerdown) → 뗌(pointerup, touch). 좌표는 줄 왼쪽
// 글리프 안(clientX 105, 줄 left 100 + 20px 글리프).
function tap(li) {
  li.getBoundingClientRect = () => ({
    ...ROW,
    x: ROW.left,
    y: ROW.top,
    toJSON() {},
  });
  for (const type of ["pointerdown", "pointerup"]) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      pointerType: { value: "touch" },
      clientX: { value: 105 },
    });
    li.dispatchEvent(event);
  }
}

test("렌더된 체크칸을 탭하면 [ ] 가 [x] 로 바뀌고 저장 원문에 반영된다", async () => {
  const { editor, root } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "- [ ] 할일");
  await settle();
  const [li] = checkItems(root);
  assert.equal(li.getAttribute("aria-checked"), "false");

  tap(li);
  await settle();

  assert.equal(checkItems(root)[0].getAttribute("aria-checked"), "true");
  assert.equal(serializeEditorToMarkdown(editor), "- [x] 할일");
});

test("한 번 더 탭하면 [x] 가 다시 [ ] 로 돌아간다(빠른 연속 탭 포함)", async () => {
  const { editor, root } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "- [ ] 할일");
  await settle();
  tap(checkItems(root)[0]);
  await settle();
  // 라이브러리 touch 중복 방지(500ms)가 이 두 번째 탭을 버리면 여기서 빨개진다.
  // 줄 원소는 토글 뒤 다시 그려질 수 있어 매번 새로 찾는다.
  tap(checkItems(root)[0]);
  await settle();

  assert.equal(checkItems(root)[0].getAttribute("aria-checked"), "false");
  assert.equal(serializeEditorToMarkdown(editor), "- [ ] 할일");
});

test("탭한 체크 상태는 저장 원문으로 나갔다가 다시 열어도 그대로 복원된다", async () => {
  const first = makeProductEditor();
  restoreMarkdownIntoEditor(first.editor, "- [ ] 할일\n\n다음 문단");
  await settle();
  tap(checkItems(first.root)[0]);
  await settle();
  const saved = serializeEditorToMarkdown(first.editor);
  assert.equal(saved, "- [x] 할일\n\n다음 문단");

  const reopened = makeProductEditor();
  restoreMarkdownIntoEditor(reopened.editor, saved);
  await settle();
  assert.equal(
    checkItems(reopened.root)[0].getAttribute("aria-checked"),
    "true",
  );
  assert.equal(serializeEditorToMarkdown(reopened.editor), saved);
});

test("자동 저장이 실제로 [x] 를 IndexedDB 행에 쓰고, 재시작 뒤 그대로 복원된다", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "tap-save-1",
    title: "탭 저장",
    body: "- [ ] 할일",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  writeCurrentMemoId("tap-save-1");

  const notice = document.createElement("div");
  const first = makeProductEditor();
  const store = mountStorage(first.editor, notice, adapter);
  await restoreCurrentMemo(first.editor, store, adapter, store.restoreState);
  await settle();
  tap(checkItems(first.root)[0]);
  await sleep(1200); // 자동 저장 debounce(1000ms) 이후

  const saved = await adapter.get("tap-save-1");
  assert.equal(saved.body, "- [x] 할일", "탭 뒤 자동 저장이 [x] 를 써야 한다");

  // 재시작: 새 에디터 + 같은 저장소로 다시 연다
  const reopened = makeProductEditor();
  const store2 = mountStorage(reopened.editor, notice, adapter);
  await restoreCurrentMemo(
    reopened.editor,
    store2,
    adapter,
    store2.restoreState,
  );
  await settle();
  assert.equal(
    checkItems(reopened.root)[0].getAttribute("aria-checked"),
    "true",
  );
  assert.equal(serializeEditorToMarkdown(reopened.editor), "- [x] 할일");
});

test("탭은 커서·선택을 옮기지 않는다 -- 줄이 날글로 펼쳐지지 않는다(cursor-raw 교집합)", async () => {
  const { editor, root } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "- [ ] 할일\n\n다음 문단");
  await settle();
  editor.update(() => {
    $getRoot().getLastChild().selectEnd();
  });
  await settle();
  const anchorBefore = editor.getEditorState().read(() => {
    const sel = $getSelection();
    return $isRangeSelection(sel) ? sel.anchor.key : null;
  });

  tap(checkItems(root)[0]);
  await settle();

  const anchorAfter = editor.getEditorState().read(() => {
    const sel = $getSelection();
    return $isRangeSelection(sel) ? sel.anchor.key : null;
  });
  assert.equal(anchorAfter, anchorBefore, "탭 뒤 커서는 그대로여야 한다");
  assert.equal(
    checkItems(root).length,
    1,
    "탭한 줄은 체크칸으로 남아야 한다(펼쳐지면 사라진다)",
  );
  assert.equal(checkItems(root)[0].getAttribute("aria-checked"), "true");
});

test("한글 조합(IME) 중의 탭은 무시한다 -- 체크 상태도 글자도 바뀌지 않는다", async () => {
  const { editor, root } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "- [ ] 할일");
  await settle();
  const original = editor.isComposing;
  editor.isComposing = () => true;
  try {
    tap(checkItems(root)[0]);
    await settle();
  } finally {
    editor.isComposing = original;
  }
  assert.equal(checkItems(root)[0].getAttribute("aria-checked"), "false");
  assert.equal(serializeEditorToMarkdown(editor), "- [ ] 할일");
});

test("체크칸이 아닌 목록 줄을 탭해도 아무것도 바뀌지 않는다", async () => {
  const { editor, root } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "- 목록");
  await settle();
  const li = root.querySelector("li");
  assert.equal(li.hasAttribute("aria-checked"), false);

  tap(li);
  await settle();

  assert.equal(serializeEditorToMarkdown(editor), "- 목록");
});
