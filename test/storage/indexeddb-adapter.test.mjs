// coder-task.md §0-2-⑹ 증거물 2/2: 실제 어댑터(IndexedDB, fake-indexeddb
// 로 헤드리스 구동)가 같은 계약을 만족한다 -- fake-adapter-contract.test.mjs
// 와 이 파일이 «같은» 시험을 두 구현에 돌리는 것 자체가 "인터페이스를
// 갈아끼울 수 있다"의 증거다.
import "../support/fake-indexeddb-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAdapterContractTests } from "../support/adapter-contract.mjs";
import { createIndexedDbAdapter } from "../../src/storage/indexeddb-adapter.mjs";

let dbCounter = 0;
function freshDbName() {
  dbCounter += 1;
  return `test-db-${Date.now()}-${dbCounter}`;
}

runAdapterContractTests("IndexedDB 어댑터", () =>
  createIndexedDbAdapter({ dbName: freshDbName() }),
);

test("IndexedDB 어댑터: 새 어댑터 인스턴스(재접속)로 열어도 이전에 저장한 값이 그대로 있다 -- 탭을 닫았다 다시 여는 것의 데이터 계층 등가물", async () => {
  const dbName = freshDbName();
  const first = createIndexedDbAdapter({ dbName });
  await first.put({
    id: "m1",
    title: "제목",
    body: "닫았다 다시 열어도 남는 본문",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });

  const second = createIndexedDbAdapter({ dbName });
  const restored = await second.get("m1");
  assert.equal(restored.body, "닫았다 다시 열어도 남는 본문");
});

// 검토 2R P2-C: 실패한 연결을 캐시하면 "다시"를 여러 번 눌러도(=connect()
// 를 다시 불러도) 같은 실패를 영원히 돌려준다 -- 아래 두 시험은 그 수리를
// 값으로 잰다. indexedDB.open 을 일시적으로 가로채 첫 시도만 실패시키고
// (fake-indexeddb 는 진짜 실패를 재현할 손잡이가 없어 이 방식으로 대신
// 한다), 시험이 끝나면 반드시 원래 함수로 되돌린다.
function withFailingOpenOnce(dbName, fn) {
  const realOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB);
  let callCount = 0;
  globalThis.indexedDB.open = (...openArgs) => {
    callCount += 1;
    if (callCount === 1) {
      const request = {};
      globalThis.queueMicrotask(() => {
        request.error = new Error("simulated open failure");
        if (request.onerror) request.onerror();
      });
      return request;
    }
    return realOpen(...openArgs);
  };
  return fn(() => callCount).finally(() => {
    globalThis.indexedDB.open = realOpen;
  });
}

function withAlwaysFailingOpen(fn) {
  const realOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB);
  let callCount = 0;
  globalThis.indexedDB.open = () => {
    callCount += 1;
    const request = {};
    globalThis.queueMicrotask(() => {
      request.error = new Error("simulated open failure");
      if (request.onerror) request.onerror();
    });
    return request;
  };
  return fn(() => callCount).finally(() => {
    globalThis.indexedDB.open = realOpen;
  });
}

test("IndexedDB 어댑터: 첫 연결 시도가 실패해도 dbPromise 를 캐시하지 않아 두 번째 시도는 새로 연결해 성공한다 (P2-C, 변이 RED 대상)", async () => {
  const dbName = freshDbName();
  await withFailingOpenOnce(dbName, async (getCallCount) => {
    const adapter = createIndexedDbAdapter({ dbName });
    await assert.rejects(
      () =>
        adapter.put({
          id: "m2",
          title: "제목",
          body: "첫 시도",
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        }),
      /simulated open failure/,
    );

    // 두 번째 시도(같은 adapter 인스턴스, 같은 connect() 경로) -- 캐시된
    // 거부 Promise 를 그대로 돌려받는 버그가 있었다면 여기서도 reject된다.
    await adapter.put({
      id: "m2",
      title: "제목",
      body: "두 번째 시도에서 성공",
      createdAt: 2,
      updatedAt: 2,
      deletedAt: null,
    });
    const restored = await adapter.get("m2");
    assert.equal(restored.body, "두 번째 시도에서 성공");
    assert.equal(
      getCallCount(),
      2,
      "connect() 재시도는 indexedDB.open() 을 한 번 더 불러야 한다",
    );
  });
});

test("IndexedDB 어댑터: 연속 실패에서도 동시 호출은 같은 실패 시도 하나를 공유한다 -- 재시도 폭주 금지 (P2-C)", async () => {
  const dbName = freshDbName();
  await withAlwaysFailingOpen(async (getCallCount) => {
    const adapter = createIndexedDbAdapter({ dbName });
    const memo = {
      id: "m3",
      title: "제목",
      body: "본문",
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    };
    const outcomes = await Promise.allSettled([
      adapter.put(memo),
      adapter.get("m3"),
      adapter.list(),
    ]);
    for (const outcome of outcomes) {
      assert.equal(outcome.status, "rejected");
    }
    assert.equal(
      getCallCount(),
      1,
      "동시에 들어온 세 호출이 같은 실패한 연결 시도를 공유해야 한다(폭주 금지)",
    );
  });
});
