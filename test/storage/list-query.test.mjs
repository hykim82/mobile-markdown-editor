// coder-task.md §2 "표제 축" 중 개수·가시성·순서 축을 저장 계층
// (adapter.list() 이후, DOM 이전)에서 잰다. DOM 까지 이어지는 값은
// test/editor/memo-list-view.test.mjs·test/editor/memo-list-mount.test.mjs
// 가 잇는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleMemosSortedByUpdatedAt } from "../../src/storage/list-query.mjs";
import { createMemoStore } from "../../src/storage/memo-store.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";

function memo(id, overrides = {}) {
  return {
    id,
    title: id,
    body: "본문",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

// 개수 축
test("개수 축: 메모 0개면 빈 배열", () => {
  assert.deepEqual(visibleMemosSortedByUpdatedAt([]), []);
});

test("개수 축: 메모 1개면 그 1개", () => {
  const result = visibleMemosSortedByUpdatedAt([memo("a")]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "a");
});

test("개수 축: 메모 여러 개면 전부 나온다(가시성 조건을 만족하는 한)", () => {
  const result = visibleMemosSortedByUpdatedAt([
    memo("a"),
    memo("b"),
    memo("c"),
  ]);
  assert.equal(result.length, 3);
});

// 가시성 축 -- 불변식 (1) "빈 메모도, 삭제된 메모도 안 보인다"
test("가시성 축: 본문 있는 메모는 보인다", () => {
  const result = visibleMemosSortedByUpdatedAt([memo("a", { body: "글" })]);
  assert.deepEqual(
    result.map((m) => m.id),
    ["a"],
  );
});

test("가시성 축: 빈 메모(body 길이 0)는 안 보인다", () => {
  const result = visibleMemosSortedByUpdatedAt([
    memo("a", { body: "" }),
    memo("b", { body: "글" }),
  ]);
  assert.deepEqual(
    result.map((m) => m.id),
    ["b"],
  );
});

test("가시성 축: 삭제시각이 있는 메모는 안 보인다", () => {
  const result = visibleMemosSortedByUpdatedAt([
    memo("a", { deletedAt: 999 }),
    memo("b"),
  ]);
  assert.deepEqual(
    result.map((m) => m.id),
    ["b"],
  );
});

// 순서 축 -- 불변식 (2) "순서는 언제나 최신 수정순이다"
test("순서 축: 수정시각이 최신인 메모가 맨 위다", () => {
  const result = visibleMemosSortedByUpdatedAt([
    memo("older", { updatedAt: 100 }),
    memo("newest", { updatedAt: 300 }),
    memo("middle", { updatedAt: 200 }),
  ]);
  assert.deepEqual(
    result.map((m) => m.id),
    ["newest", "middle", "older"],
  );
});

// 순서 축 -- "수정하면 순서가 바뀐다"를 저장 계층 전체(memo-store 의 실제
// 저장 경로 + fake adapter + list-query)로 통합해서 잰다: 함수 호출로
// 멈추지 말고 "저장 후 다시 목록을 그리면 그 메모가 올라온다"까지.
test("순서 축: 오래된 메모를 다시 수정해 저장하면 목록 맨 위로 올라온다(전/후 차례)", async () => {
  // 실제 Date.now() 타이밍에 기대면 같은 밀리초에 두 메모가 만들어져
  // 순서가 우연히 맞아떨어질 수 있다(불안정) -- now() 를 주입해 시각을
  // 결정적으로 고정한다.
  let clock = 1000;
  const now = () => clock;
  const adapter = createFakeAdapter();
  const store = createMemoStore(adapter, { now });

  clock = 100;
  await store.onContentChange("먼저 쓴 메모"); // A, updatedAt = 100
  const idA = store.getMemoId();

  const storeB = createMemoStore(adapter, { now });
  clock = 200;
  await storeB.onContentChange("나중에 쓴 메모"); // B, updatedAt = 200
  const idB = storeB.getMemoId();

  const before = visibleMemosSortedByUpdatedAt(await adapter.list()).map(
    (m) => m.id,
  );
  assert.deepEqual(before, [idB, idA], "전: 나중에 쓴 B 가 위");

  // A 를 다시 열어(loadMemo) 고치고 뒤로가기(flushImmediate)로 저장한다.
  const recordA = await adapter.get(idA);
  const reopenedStoreA = createMemoStore(adapter, { now });
  reopenedStoreA.loadMemo(recordA);
  clock = 300;
  reopenedStoreA.onContentChange("먼저 쓴 메모, 방금 다시 고침");
  await reopenedStoreA.flushImmediate();

  const after = visibleMemosSortedByUpdatedAt(await adapter.list()).map(
    (m) => m.id,
  );
  assert.deepEqual(after, [idA, idB], "후: 방금 고친 A 가 위로 올라온다");
});
