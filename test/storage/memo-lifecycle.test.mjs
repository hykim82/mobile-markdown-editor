// PRD §5.5/§8 삭제(soft) 데이터 계층: coder-task.md §0-2-⑸ "삭제시각
// null 복원이 되는가(7초 되돌리기 축)". UI(스와이프·토스트)는 범위 밖 --
// 여기서는 adapter 위 lifecycle 함수만 시험한다.
//
// ⚠️순서 주의(memo-store.test.mjs 머리 주석과 같은 이유): createSoftDeleteLifecycle()
// 은 호출 시점의 전역 setTimeout 을 캡처하므로 t.mock.timers.enable() 을
// lifecycle 생성보다 먼저 부른다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSoftDeleteLifecycle,
  cleanupExpiredDeletes,
} from "../../src/storage/memo-lifecycle.mjs";
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

// HYK-304-lifecycle-orphans-1 ⓑ(책임자 판정 §2 요구 2 "restore 순서"):
// put 이 실패하면 restore 는 거부를 그대로 전파해야 하고(기존 동작),
// «그리고» 하드 삭제 예약은 취소되지 않고 살아있어야 한다(순서 교정 전엔
// cancelPending 이 put 보다 먼저라 put 실패와 무관하게 예약이 사라졌다 --
// 그러면 restore 가 실패했는데도 7초 뒤 메모가 그대로 하드 삭제돼
// 사용자가 "되돌리기 실패"를 다시 시도할 길이 막힌다).
test("ⓑ 되돌리기 순서 교정: restore 중 put 이 실패해도 예약된 hard delete 는 취소되지 않고 그대로 7초에 돈다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, { now: () => 42 });

  await lifecycle.softDelete("m1");
  adapter.forceNextPutFailures(1);
  await assert.rejects(
    lifecycle.restore("m1"),
    "restore 는 put 실패를 그대로 호출자에 전파해야 한다",
  );

  t.mock.timers.tick(7000);
  await Promise.resolve();
  assert.equal(
    await adapter.get("m1"),
    undefined,
    "put 실패로 restore 가 거부됐어도 하드 삭제 예약은 살아있어, 7초가 지나면 그대로 하드 삭제돼야 한다(ⓑ)",
  );
});

// HYK-304-lifecycle-orphans-1 ⓒ(책임자 판정 §2 요구 3): 타이머 콜백 안
// adapter.remove() 가 거부해도 unhandledRejection 으로 새면 안 된다(타이머
// 콜백은 try/catch 로 못 잡는 비동기 경계라 삼키지 않으면 그대로 샌다).
// 삼킨 뒤 레코드는 deletedAt 이 찍힌 채 남아 다음 시작 cleanupExpiredDeletes
// 가 같은 id 를 다시 집어내 재시도한다(ⓐ 와 이어짐, 아래에서 같은 시험
// 안에서 값으로 확인).
test("ⓒ 타이머 안 remove 실패: unhandledRejection 없이 삼키고, 레코드는 남아 다음 시작 정리가 재시도한다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, { now: () => 1000 });

  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on("unhandledRejection", onRejection);

  try {
    adapter.forceNextRemoveFailures(1);
    await lifecycle.softDelete("m1");

    t.mock.timers.tick(7000);
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(
      rejections,
      [],
      "remove 거부가 unhandledRejection 으로 새면 안 된다(ⓒ)",
    );
    const memo = await adapter.get("m1");
    assert.ok(
      memo,
      "remove 가 실패했으니 레코드는 여전히 저장소에 남아있어야 한다",
    );
    assert.equal(memo.deletedAt, 1000, "삭제시각은 그대로다");

    await cleanupExpiredDeletes(adapter, {
      now: () => 1000 + 7000,
      graceMs: 7000,
    });
    assert.equal(
      await adapter.get("m1"),
      undefined,
      "다음 시작 정리가 같은 id 를 다시 집어내 지워야 한다(ⓐ 와 연결)",
    );
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

// HYK-304-lifecycle-orphans-1 ⑤(책임자 판정 §2 요구 5, 수용 기준 — 필수):
// "삭제 → 7초 안 앱 종료(타이머 소멸, 다음 setTimeoutFn 이 다시는 안
// 불림) → 다음 시작(cleanupExpiredDeletes)" 뒤 그 메모가 저장소에서
// 없어진다. setTimeoutFn 을 "절대 fn 을 안 부르는" 가짜로 둬 하드 삭제
// 타이머 자체가 소멸한 상황(실제로 process 가 죽으면 메모리 타이머도
// 함께 사라진다)을 흉내낸다 -- cleanupExpiredDeletes 가 유일한 복구
// 경로임을 값으로 증명한다.
test("⑤수용 기준: 삭제 후 7초 안 타이머가 소멸해도, 다음 시작의 cleanupExpiredDeletes 가 고아를 저장소에서 지운다", async () => {
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, {
    now: () => 1000,
    setTimeoutFn: () => "ignored-timer-id", // 타이머 소멸 흉내 -- fn 은 절대 안 불린다
    clearTimeoutFn: () => {},
  });

  await lifecycle.softDelete("m1");
  assert.ok(
    await adapter.get("m1"),
    "softDelete 직후에는 아직 저장소에 남아있다(deletedAt 만 찍힘, 하드 삭제 타이머는 소멸)",
  );

  // "다음 시작": deletedAt(1000) + graceMs(7000) = 8000 <= now(8000).
  await cleanupExpiredDeletes(adapter, { now: () => 8000, graceMs: 7000 });

  assert.equal(
    await adapter.get("m1"),
    undefined,
    "유예가 지난 고아는 다음 시작 정리로 저장소에서 사라져야 한다(수용 기준, 목록에도 당연히 없다 -- list-query.mjs 는 deletedAt!==null 을 이미 걸러낸다)",
  );
});

// 대조 칸(§2 요구 5): 다음 시작 시계가 "삭제시각+6999"면(아직 유예 중)
// 지우면 안 된다 -- 책임자 판정 §2 요구 1-ⓐ 가 요구하는 "유예 중인
// 레코드는 지우지 마라"를 cleanupExpiredDeletes 경유로 재확인한다.
test("대조: 다음 시작 시계가 삭제시각+6999 면 아직 유예 중이라 지우지 않는다(그대로 둠, §한계)", async () => {
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, {
    now: () => 1000,
    setTimeoutFn: () => "ignored-timer-id",
    clearTimeoutFn: () => {},
  });
  await lifecycle.softDelete("m1");

  await cleanupExpiredDeletes(adapter, {
    now: () => 1000 + 6999,
    graceMs: 7000,
  });

  const memo = await adapter.get("m1");
  assert.ok(memo, "유예 중(6999ms)인 레코드는 지우면 안 된다");
  assert.equal(
    memo.deletedAt,
    1000,
    "유예 중 레코드는 그대로 둔다(재예약·토스트 재표시는 하지 않는다, §한계)",
  );
});

test("cleanupExpiredDeletes: graceMs 를 생략하면 이 파일 자신의 GRACE_MS(한 원천)를 쓴다", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "m1",
    title: "t",
    body: "b",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: 500,
  });
  await cleanupExpiredDeletes(adapter, { now: () => 500 + 7000 }); // graceMs 생략
  assert.equal(
    await adapter.get("m1"),
    undefined,
    "graceMs 생략 시에도 GRACE_MS(7000) 기본값으로 정리돼야 한다",
  );
});

// V5 생존 대상(§2 요구 6 변이표): 정리 중 한 레코드가 실패해도 나머지
// 레코드는 계속 정리돼야 한다 -- cleanupExpiredDeletes 내부 try/catch 를
// 없애면(V5) 첫 실패에서 루프 전체가 멈춰 m2 가 이번 라운드에 정리되지
// 않는다(다음 시작에는 결국 잡히지만, "이번 정리가 한 레코드 실패로
// 통째로 막히면 안 된다"는 요구와 어긋난다).
test("정리 중 한 레코드(m1)가 실패해도 cleanupExpiredDeletes 는 던지지 않고 나머지(m2)는 그대로 정리된다", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "m1",
    title: "t1",
    body: "b1",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: 500,
  });
  await adapter.put({
    id: "m2",
    title: "t2",
    body: "b2",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: 500,
  });

  adapter.forceNextRemoveFailures(1); // m1 의 remove 만 1회 실패
  await assert.doesNotReject(
    cleanupExpiredDeletes(adapter, { now: () => 500 + 7000, graceMs: 7000 }),
  );

  assert.ok(
    await adapter.get("m1"),
    "m1 은 이번 정리에선 실패해 남아있다(다음 시작에 재시도)",
  );
  assert.equal(
    await adapter.get("m2"),
    undefined,
    "m1 실패가 m2 정리를 막으면 안 된다",
  );
});
