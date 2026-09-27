// coder-task.md §0-1-② "두 화면 오가기 -- 목록에서 메모를 고르면
// 에디터로". storage-mount.mjs 의 openMemoInEditor 가 그 전환의 데이터
// 쪽 절반(목록 카드 클릭 -> 에디터에 그 메모가 뜬다 / "+" -> 빈 에디터)을
// 맡는다. mountStorage 를 통째로 쓰지 않고 openMemoInEditor 를 직접
// 재는 이유는 restore-autosave-safety-net.test.mjs 와 같다 -- fake
// adapter 로 결정적으로, 실제 IndexedDB 없이 잰다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { makeProductEditor } from "../support/make-editor.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";
import {
  openMemoInEditor,
  restoreCurrentMemo,
} from "../../src/editor/storage-mount.mjs";
import { createMemoStore } from "../../src/storage/memo-store.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";
import {
  writeCurrentMemoId,
  readCurrentMemoId,
} from "../../src/storage/current-memo-pointer.mjs";

function makeRestoreState() {
  return {
    applying: false,
    userEdited: false,
    done: true,
    autosaveBlocked: false,
  };
}

test("목록에서 메모 id 를 고르면 그 메모 본문이 에디터에 뜬다", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "memo-1",
    title: "첫 줄",
    body: "첫 줄\n\n둘째 문단",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();

  await openMemoInEditor(editor, store, adapter, restoreState, "memo-1");

  assert.equal(serializeEditorToMarkdown(editor), "첫 줄\n\n둘째 문단");
  assert.equal(store.getMemoId(), "memo-1");
  assert.equal(
    readCurrentMemoId(),
    "memo-1",
    "포인터도 그 메모로 옮겨져야 한다",
  );
});

test('"+"(새 메모)로 열면(id=null) 에디터가 빈 상태가 되고 포인터가 비워진다', async () => {
  writeCurrentMemoId("이전에-열려있던-메모");
  const adapter = createFakeAdapter();
  const { editor } = makeProductEditor();
  // 에디터에 이전 메모 내용이 남아있던 상태를 흉내낸다.
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("이전 메모 내용"));
      root.append(paragraph);
    },
    { discrete: true },
  );
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();

  await openMemoInEditor(editor, store, adapter, restoreState, null);

  assert.equal(serializeEditorToMarkdown(editor), "");
  assert.equal(store.getMemoId(), null);
  assert.equal(readCurrentMemoId(), null);
});

test("다른 메모로 전환하는 순간(applying)은 update 리스너가 사용자 입력으로 안 본다", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "memo-2",
    title: "본문",
    body: "본문",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();
  let userEditSeen = false;
  editor.registerUpdateListener(() => {
    if (!restoreState.applying) userEditSeen = true;
  });

  await openMemoInEditor(editor, store, adapter, restoreState, "memo-2");

  assert.equal(
    userEditSeen,
    false,
    "openMemoInEditor 가 건 update 는 applying=true 동안이어야 한다",
  );
});

test("전환 직후 왕복(restore round-trip)이 어긋나면 그 메모에 한해 autosaveBlocked 가 선다", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "memo-3",
    title: "원본",
    body: "원본이어야 하는 본문",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();
  const brokenRestoreFn = (ed) => {
    ed.update(
      () => {
        $getRoot().clear();
      },
      { discrete: true },
    );
  };

  await openMemoInEditor(editor, store, adapter, restoreState, "memo-3", {
    restoreFn: brokenRestoreFn,
  });

  assert.equal(restoreState.autosaveBlocked, true);
});

test("이전 메모에서 안전판이 걸려있어도, 다른 메모를 새로 열면 그 메모는 안전판이 풀려있다", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "memo-4",
    title: "정상",
    body: "정상 본문",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();
  restoreState.autosaveBlocked = true; // 이전 메모에서 걸려있던 안전판

  await openMemoInEditor(editor, store, adapter, restoreState, "memo-4");

  assert.equal(
    restoreState.autosaveBlocked,
    false,
    "새로 연 메모는 왕복이 정상이므로 안전판이 풀려야 한다",
  );
});

// restoreCurrentMemo(초기 로드 전용 경로)는 openMemoInEditor 와 달리
// pointer 가 가리키는 메모가 삭제돼 있으면 포인터를 비운다 -- app.mjs
// 는 그 뒤 readCurrentMemoId() 로 "복원할 것이 있었는가"를 판단해 처음
// 보여줄 화면(에디터 vs 목록)을 고른다. 이 시험은 그 판단의 전제(삭제된
// 메모를 가리키던 포인터는 비워진다)를 값으로 고정한다.
test("초기 로드: 포인터가 가리키는 메모가 이미 삭제돼 있으면 포인터가 비워진다(앱 부팅 시 목록이 홈으로 보이는 전제)", async () => {
  writeCurrentMemoId("deleted-memo");
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "deleted-memo",
    title: "지워짐",
    body: "지워짐",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: 999,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = {
    applying: false,
    userEdited: false,
    done: false,
    autosaveBlocked: false,
  };

  await restoreCurrentMemo(editor, store, adapter, restoreState);

  assert.equal(readCurrentMemoId(), null);
});
