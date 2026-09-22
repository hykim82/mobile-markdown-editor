// PRD §5.5/§8 삭제(soft) 데이터 계층: coder-task.md §0-2-⑸ "삭제시각
// null 복원이 되는가(7초 되돌리기 축)". UI(스와이프·토스트)는 범위 밖 --
// 여기서는 adapter 위 lifecycle 함수만 시험한다.
//
// ⚠️순서 주의(memo-store.test.mjs 머리 주석과 같은 이유): createSoftDeleteLifecycle()
// 은 호출 시점의 전역 setTimeout 을 캡처하므로 t.mock.timers.enable() 을
// lifecycle 생성보다 먼저 부른다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSoftDeleteLifecycle } from "../../src/storage/memo-lifecycle.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";

async function seedMemo(adapter, id) {
  await adapter.put({
    id,
    title: "제목",
    body: "본문",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
}

test("삭제(soft): softDelete 는 삭제시각을 채우고, 7초 뒤 hard delete 로 실제 사라진다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, { now: () => 42 });

  const softDeleted = await lifecycle.softDelete("m1");
  assert.equal(softDeleted.deletedAt, 42);
  assert.ok(await adapter.get("m1"), "7초 전에는 아직 있어야 한다");

  t.mock.timers.tick(6999);
  assert.ok(await adapter.get("m1"), "6999ms 에는 아직 있어야 한다");

  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(
    await adapter.get("m1"),
    undefined,
    "7000ms 에 hard delete 된다",
  );
});

test("되돌리기: 7초 안에 restore 하면 삭제시각이 null 로 되돌아가고, 7초가 지나도 살아있다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, { now: () => 42 });

  await lifecycle.softDelete("m1");
  t.mock.timers.tick(3000);

  const restored = await lifecycle.restore("m1");
  assert.equal(restored.deletedAt, null);

  t.mock.timers.tick(10000); // 원래 예약이 살아있었다면 이 사이에 지워졌을 것
  await Promise.resolve();
  const memo = await adapter.get("m1");
  assert.ok(memo, "복원 후에는 예약된 hard delete 가 취소돼 살아있어야 한다");
  assert.equal(memo.deletedAt, null);
});

test("없는 id 에 softDelete/restore 를 걸어도 조용히 null 을 돌려준다(예외 안 던짐)", async () => {
  const adapter = createFakeAdapter();
  const lifecycle = createSoftDeleteLifecycle(adapter);
  assert.equal(await lifecycle.softDelete("nope"), null);
  assert.equal(await lifecycle.restore("nope"), null);
});

// 회귀 시험(memo-store.test.mjs 의 같은 이름 시험과 같은 이유 -- 그 파일
// 머리 주석 참고): 실제 브라우저의 네이티브 setTimeout/clearTimeout 은
// receiver 가 window 가 아니면 Illegal invocation 을 던진다. Node 에서는
// 이 제약이 없어 여기서 receiver 를 엄격히 따지는 가짜로 전역을 잠깐
// 바꿔치기해 같은 조건을 재현한다.
test("회귀: 기본 setTimeoutFn/clearTimeoutFn 은 receiver 가 엄격한 네이티브 타이머(실브라우저 흉내) 아래에서도 Illegal invocation 없이 동작한다", async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  function strictSetTimeout(fn, ms) {
    if (this !== undefined) {
      throw new TypeError("Illegal invocation");
    }
    return realSetTimeout(fn, ms);
  }
  function strictClearTimeout(id) {
    if (this !== undefined) {
      throw new TypeError("Illegal invocation");
    }
    return realClearTimeout(id);
  }
  globalThis.setTimeout = strictSetTimeout;
  globalThis.clearTimeout = strictClearTimeout;
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter); // 옵션 없음 -- 기본값 경로 자체를 시험
  assert.doesNotThrow(() => lifecycle.softDelete("m1"));
  await lifecycle.softDelete("m1");
  assert.doesNotThrow(() => lifecycle.restore("m1"));
});
