// coder-task.md §0-2-⑹ "저장 기술을 어댑터 한 곳에 가둬라": 이 함수가
// 검사하는 4개 메서드(put/get/list/remove)만이 memo-store.mjs 가 어댑터에
// 기대하는 전부다. IndexedDB 구현(src/storage/indexeddb-adapter.mjs)과
// 메모리 구현(fake-adapter.mjs) 양쪽에 이 «같은» 시험을 돌려 인터페이스가
// 실제로 갈아끼워짐을 증명한다.
import { test } from "node:test";
import assert from "node:assert/strict";

export function runAdapterContractTests(label, createAdapter) {
  test(`${label}: put 한 메모를 get 으로 그대로 돌려받는다`, async () => {
    const adapter = await createAdapter();
    const memo = {
      id: "m1",
      title: "제목",
      body: "본문",
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    };
    await adapter.put(memo);
    assert.deepEqual(await adapter.get("m1"), memo);
  });

  test(`${label}: 없는 id 는 get 에서 undefined 다`, async () => {
    const adapter = await createAdapter();
    assert.equal(await adapter.get("nope"), undefined);
  });

  test(`${label}: 같은 id 로 put 을 두 번 하면 덮어쓴다(개수가 안 늘어난다)`, async () => {
    const adapter = await createAdapter();
    await adapter.put({
      id: "m1",
      title: "a",
      body: "a",
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    });
    await adapter.put({
      id: "m1",
      title: "b",
      body: "b",
      createdAt: 1,
      updatedAt: 2,
      deletedAt: null,
    });
    const all = await adapter.list();
    assert.equal(all.length, 1);
    assert.equal((await adapter.get("m1")).body, "b");
  });

  test(`${label}: remove 후에는 get 에서도 list 에서도 사라진다`, async () => {
    const adapter = await createAdapter();
    await adapter.put({
      id: "m1",
      title: "a",
      body: "a",
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    });
    await adapter.remove("m1");
    assert.equal(await adapter.get("m1"), undefined);
    assert.deepEqual(await adapter.list(), []);
  });

  test(`${label}: deletedAt 을 null 로 되돌리면(복원) 그 값 그대로 읽힌다`, async () => {
    const adapter = await createAdapter();
    await adapter.put({
      id: "m1",
      title: "a",
      body: "a",
      createdAt: 1,
      updatedAt: 1,
      deletedAt: 5,
    });
    const memo = await adapter.get("m1");
    await adapter.put({ ...memo, deletedAt: null });
    assert.equal((await adapter.get("m1")).deletedAt, null);
  });
}
