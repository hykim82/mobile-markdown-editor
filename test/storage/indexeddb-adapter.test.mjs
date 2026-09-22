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
