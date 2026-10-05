// HYK-304-home-list-updatedat-1 칸 ⓑ -- 글을 고치지 않았는데 updatedAt 이
// 바뀌어 목록 최신 수정순에서 메모가 맨 위로 올라가던 결함(1R 검토 §5
// 2순위). 원인: 에디터 update 는 커서만 움직여도 온다. storage-mount.mjs
// 리스너는 그 update 마다 원문을 넘기고, memo-store.mjs 는 같은 원문이어도
// updatedAt 을 새로 찍었다.
//
// 재현(수정 전 base b89773c 에서 실측): updatedAt 1000 -> 현재 시각,
// 원문은 그대로. 이 파일은 그 재현을 값으로 고정한다 -- 커서만 움직이면
// updatedAt 이 그대로여야 하고, 실제로 글자를 치면 바뀌어야 한다(양성 대조).
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { $getRoot, $createTextNode } from "lexical";
import { makeProductEditor } from "../support/make-editor.mjs";
import {
  mountStorage,
  openMemoInEditor,
} from "../../src/editor/storage-mount.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";
import { LEGACY_FIXTURES } from "./legacy-fixtures.mjs";

// memo-store 의 자동저장 디바운스는 1초다 -- 저장이 걸렸다면 그 뒤에
// 반드시 adapter 에 닿도록 그보다 넉넉히 기다린다.
const SETTLE_MS = 1300;

function settle() {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

async function openSavedMemo(adapter, id, body, updatedAt) {
  await adapter.put({
    id,
    title: body,
    body,
    bodyFormat: "escaped-v1",
    createdAt: 1,
    updatedAt,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = mountStorage(editor, { hidden: true }, adapter);
  await store.initialRestoreReady;
  await openMemoInEditor(editor, store, adapter, store.restoreState, id);
  return editor;
}

test("커서만 움직이면 updatedAt 이 바뀌지 않는다(목록 순서가 흔들리지 않는다)", async () => {
  const adapter = createFakeAdapter();
  const OLD = 1000;
  const editor = await openSavedMemo(
    adapter,
    "m-cursor",
    "첫 줄\n\n둘째 문단",
    OLD,
  );

  editor.update(() => $getRoot().selectStart(), {});
  await settle();
  editor.update(() => $getRoot().selectEnd(), {});
  await settle();

  const after = await adapter.get("m-cursor");
  assert.equal(
    after.updatedAt,
    OLD,
    "커서 이동만으로 updatedAt 이 바뀌면 안 된다",
  );
  assert.equal(after.body, "첫 줄\n\n둘째 문단", "원문도 그대로여야 한다");
});

// 옛 형식 메모(bodyFormat 필드 없음)도 같다 -- 커서만 움직였는데 새 규칙
// 으로 다시 쓴 원문이 저장 원문을 덮으면 "조용한 본문 변경"이 된다. 8개
// 표본(legacy-fixtures.mjs) 전부에서 updatedAt·원문·형식 표지가 그대로
// 여야 한다(수정 전 실측: 8개 모두 updatedAt 이 바뀌고 원문이 달라졌다).
test("옛 형식 메모 8개 표본: 커서만 움직이면 updatedAt·원문·형식 표지가 그대로다", async () => {
  for (const [key, body] of Object.entries(LEGACY_FIXTURES)) {
    const adapter = createFakeAdapter();
    const OLD = 1000;
    await adapter.put({
      id: `legacy-${key}`,
      title: body,
      body,
      createdAt: 1,
      updatedAt: OLD,
      deletedAt: null,
    });
    const { editor } = makeProductEditor();
    const store = mountStorage(editor, { hidden: true }, adapter);
    await store.initialRestoreReady;
    await openMemoInEditor(
      editor,
      store,
      adapter,
      store.restoreState,
      `legacy-${key}`,
    );

    editor.update(() => $getRoot().selectEnd(), {});
    await settle();

    const after = await adapter.get(`legacy-${key}`);
    assert.equal(
      after.updatedAt,
      OLD,
      `${key}: 커서 이동만으로 updatedAt 이 바뀌면 안 된다`,
    );
    assert.equal(after.body, body, `${key}: 원문이 조용히 바뀌면 안 된다`);
    assert.equal(
      after.bodyFormat,
      undefined,
      `${key}: 형식 표지가 저절로 올라가면 안 된다`,
    );
  }
});

test("양성 대조: 실제로 글자를 치면 updatedAt 이 새로 찍힌다", async () => {
  const adapter = createFakeAdapter();
  const OLD = 1000;
  const editor = await openSavedMemo(adapter, "m-type", "첫 줄", OLD);

  editor.update(() => {
    $getRoot().getFirstChild().append($createTextNode("!"));
  }, {});
  await settle();

  const after = await adapter.get("m-type");
  assert.ok(
    after.updatedAt > OLD,
    "글을 고쳤으면 updatedAt 이 지금 시각으로 바뀌어야 한다",
  );
  assert.equal(after.body, "첫 줄!");
});
