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
// «그리고» 하드 삭제는 결국 "원래 예정됐던 7초"에 그대로 돈다(1R 요구
// 그대로 — 되돌리기 실패에도 7초 축은 유지된다). r2(P2-1) 부터는
// cancelPending 이 put "전"(맨 처음)에 돌므로, 이 7000ms 라는 값은
// 옛 타이머가 "안 취소된" 결과가 아니라 restore 실패 분기가 "남은
// 유예"(= 삭제시각 + graceMs - now)로 다시 예약한 새 타이머다 — 이
// 시험(now 가 상수 42, 중간에 시간이 흐르지 않음)에서는 남은 유예가
// 곧 7000 전체라 최종 결과가 1R 과 같다. 시간이 실제로 흘러도 같은
// "원래 예정 시각"을 지키는지는 아래 P-race/P2-2 시험이 값으로 잰다.
test("ⓑ 되돌리기 순서 교정: restore 중 put 이 실패해도 하드 삭제는 원래 예정된 7초에 그대로 돈다(r2: 남은 유예 재예약)", async (t) => {
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

// HYK-304-lifecycle-orphans-1-r2(책임자 판정 §2 요구 1, P2-1): 검토 2R
// P-race 재현 -- restore 가 "put 성공 뒤"에만 예약을 취소하던 1R 순서
// (W1 변이와 같은 모양)로는, put 이 저장소에 반영되고 완료 콜백만
// 늦게 오는 사이 7초 하드 삭제 타이머가 발화할 수 있었다("되돌리기
// 성공"으로 끝났는데 저장소는 지워짐). cancelPending 을 restore 의
// "맨 처음"(첫 await 전, 동기 구간)으로 옮기면 그 창이 생기지 않는다
// -- adapter.get 자체가 늦게 끝나도(이 시험은 get 을 게이트로 묶어
// "7초 경계를 넘긴 뒤" 풀어준다) 타이머는 이미 restore 호출 시점에
// 취소돼 있어야 한다.
test("P-race(검토 1R 탐침 재현, P2-1): restore 호출 즉시 하드 삭제 예약을 취소하므로, get/put 이 늦게 끝나는 사이 7초가 지나도 메모가 지워지지 않는다", async (t) => {
  // ⚠️아래 ⓒ 시험에서 드러난 함정(1차 작성 때 now() 를 상수로 둬 RED
  // 로 걸렸다): remaining-grace 계산(restore 실패 분기)이 "실제 지난
  // 시간"을 알아야 하므로, now() 는 반드시 mock 시계와 "같은" 시계를
  // 봐야 한다 -- Date 도 함께 모킹하고 now 를 Date.now 로 둔다(검토
  // 1R 탐침의 T0 패턴과 같음). 이 시험 자체는 put 성공 경로만 쓰므로
  // now 상수로도 통과했지만, 아래 두 시험과 패턴을 통일해 둔다.
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, {
    now: () => Date.now(),
  });

  await lifecycle.softDelete("m1"); // 7000 에 하드 삭제 예약
  t.mock.timers.tick(6990); // 타이머 발화 10ms 전

  const realGet = adapter.get.bind(adapter);
  let releaseGet;
  const gate = new Promise((resolve) => {
    releaseGet = resolve;
  });
  adapter.get = async (id) => {
    await gate;
    return realGet(id);
  };

  const restorePromise = lifecycle.restore("m1");
  // restore 는 아직 adapter.get 안(gate)에 멈춰 있다 -- 그 사이 7000ms
  // 경계를 넘긴다. cancelPending 이 restore 의 "맨 처음"(이 get 호출보다
  // 먼저)에 이미 돌았다면 이 tick 은 아무 타이머도 못 건드린다.
  t.mock.timers.tick(20);
  await Promise.resolve();
  releaseGet();
  const restored = await restorePromise;

  assert.equal(
    restored.deletedAt,
    null,
    "put 이 끝나기 전부터 cancelPending 이 먼저 돌아 되돌리기가 그대로 성공해야 한다",
  );
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.ok(
    await adapter.get("m1"),
    "7초 경계를 지나는 동안 get/put 이 늦게 끝나도 메모는 지워지지 않아야 한다(P-race, W1 이 이 칸을 RED 로 만든다)",
  );
});

// HYK-304-lifecycle-orphans-1-r2(책임자 판정 §2 요구 2, P2-2 ⓐⓑ): 실패
// 표시가 떠 있는 동안(mount 쪽이 holdPending 을 부르는 신호)은 7초가
// 지나도 하드 삭제가 돌면 안 되고(ⓐ), 그 상태에서 재시도가 성공하면
// 복원돼야 한다(ⓑ). holdPending/releasePending 은 mount.mjs 의
// showSaveError/clearSaveErrorFor 호출 지점과 짝지어 불린다(결과 파일
// §2 참고) -- 여기서는 그 신호를 lifecycle 수준에서 직접 흉내낸다.
test("P2-2 ⓐⓑ: 저장 실패 표시가 떠 있는 동안(holdPending) 7초가 지나도 메모는 살아있고, 재시도 성공(releasePending) 으로 복원된다", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, {
    now: () => Date.now(),
  });

  await lifecycle.softDelete("m1"); // 0+7000 에 하드 삭제 예약

  adapter.forceNextPutFailures(1);
  await assert.rejects(
    lifecycle.restore("m1"),
    "put 실패를 그대로 전파해야 한다",
  ); // t=0: 남은 유예(7000) 로 재예약(여전히 7000 에 돈다)
  lifecycle.holdPending("m1"); // mount.mjs 의 showSaveError 지점과 같은 신호

  t.mock.timers.tick(7000); // 실패 표시가 떠 있는 동안 7초 이상 지남
  await Promise.resolve();
  assert.ok(
    await adapter.get("m1"),
    "실패 표시 중엔 hard delete 가 held 돼 메모가 살아있어야 한다(ⓐ, W3 이 이 칸을 RED 로 만든다)",
  );

  const restored = await lifecycle.restore("m1"); // 재시도 성공
  await lifecycle.releasePending("m1"); // mount.mjs 의 clearSaveErrorFor 지점과 같은 신호
  assert.equal(restored.deletedAt, null, "재시도 성공으로 복원돼야 한다(ⓑ)");

  t.mock.timers.tick(100000);
  await Promise.resolve();
  assert.ok(
    await adapter.get("m1"),
    "복원됐으니 그 뒤로는 하드 삭제 예약이 남아있지 않아야 한다",
  );
});

// HYK-304-lifecycle-orphans-1-r2(책임자 판정 §2 요구 2, P2-2 ⓒ): 실패
// 표시가 "성공 없이" 닫히면(releasePending, 예: 같은 메모를 다시
// 스와이프로 지우는 다른 경로가 clearSaveErrorFor 를 부르는 경우)
// 유예가 재개돼 "남은 시간"만큼만 더 기다린 뒤 hard delete 돼야 한다 --
// hold 가 떠 있던 동안의 시간은 공짜로 늘어난 유예가 아니다.
test("P2-2 ⓒ: 실패 표시가 성공 없이 닫히면(releasePending) 유예가 재개돼 남은 시간 뒤 hard delete 된다", async (t) => {
  // ⚠️함정 기록(1차 작성 때 now() 를 상수(0)로 둬 RED 로 걸렸던 자리):
  // restore 실패 분기의 "남은 유예" 계산은 실패가 "언제" 일어났는지를
  // now() 로 알아내는데, now() 가 mock 시계와 분리된 상수면 tick 으로
  // 흘려보낸 3000ms 가 계산에 반영되지 않아 남은 유예가 7000(전체)으로
  // 잘못 커진다 -- 재예약이 원래 예정(7000)보다 3000ms 늦은 10000 에
  // 돌아 이 시험이 깨졌다(원인 확인 후 Date 모킹으로 교체).
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, {
    now: () => Date.now(),
  });

  await lifecycle.softDelete("m1"); // 0+7000 에 하드 삭제 예약
  t.mock.timers.tick(3000); // t=3000

  adapter.forceNextPutFailures(1);
  await assert.rejects(lifecycle.restore("m1")); // t=3000 실패, 남은 유예(4000) 로 재예약(=7000 에 돈다)
  lifecycle.holdPending("m1"); // 실패 표시 뜸

  t.mock.timers.tick(2000); // t=5000, hold 중이라 여전히 안 지워짐
  await Promise.resolve();
  assert.ok(await adapter.get("m1"), "hold 중엔 지워지지 않는다");

  await lifecycle.releasePending("m1"); // t=5000: 성공 없이 닫힘 -- 남은 유예 = 0+7000-5000 = 2000

  t.mock.timers.tick(1999); // t=6999
  await Promise.resolve();
  assert.ok(await adapter.get("m1"), "남은 유예가 아직 안 끝났다(6999)");

  t.mock.timers.tick(1); // t=7000
  await Promise.resolve();
  assert.equal(
    await adapter.get("m1"),
    undefined,
    "닫힘 뒤 유예가 재개돼 남은 시간(2000ms) 뒤 hard delete 된다(ⓒ, W4 가 이 칸을 RED 로 만든다)",
  );
});

// HYK-304-lifecycle-orphans-1-r3(검토 2R F2 재현 · 책임자 판정 §2 요구 1
// "남은 유예 ≤0 이라도 held 중엔 동기 삭제 금지"): r2 는 restore 실패를
// "남은 유예"로 재예약했지만, 그 남은 유예가 이미 0 이하면 scheduleHardDelete
// 가 그 자리에서 "동기로" 레코드를 지웠다(F2 5단계: cancelPending 이
// held 를 지움 → put 실패 → 남은 유예 ≤0 → 동기 삭제 → 그 뒤에야 mount
// 가 holdPending 을 부름 -- 이미 늦음). 여기서는 그 held 재진입 경로를
// 직접 흉내낸다: 1차 실패(남은 유예 > 0) 뒤 holdPending 으로 held 진입 →
// 유예를 한참 넘겨보냄(held 중이므로 안 지워짐, 전제 확인) → 2차 실패
// (cancelPending 이 held 를 지운 뒤, 이번엔 남은 유예가 이미 음수) 때
// 동기로 지워지면 안 된다.
test("P1-1 r3(F2 재현): held 상태에서 재시도해 남은 유예가 이미 0 이하로 떨어져도 동기로 지우지 않는다(Z1 이 이 칸을 RED 로 만든다)", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, {
    now: () => Date.now(),
  });

  await lifecycle.softDelete("m1"); // t=0, 하드 삭제 예약 0+7000=7000

  t.mock.timers.tick(3000); // t=3000
  adapter.forceNextPutFailures(1);
  await assert.rejects(lifecycle.restore("m1")); // 1차 실패, 남은 유예(4000)로 재예약
  lifecycle.holdPending("m1"); // mount 의 showSaveError 지점과 같은 신호 -- held 진입

  t.mock.timers.tick(7000); // t=10000: held 중이라 지워지지 않았어야 한다(전제)
  await Promise.resolve();
  assert.ok(
    await adapter.get("m1"),
    "held 중엔 7초가 넘어도 지워지지 않는다(전제 확인)",
  );

  adapter.forceNextPutFailures(1);
  await assert.rejects(
    lifecycle.restore("m1"),
    "검토 2R F2: cancelPending 이 held 를 지운 뒤 put 이 다시 실패한다",
  ); // 2차 실패 -- 이 시점(t=10000)의 남은 유예 = 0+7000-10000 = -3000(이미 0 이하)

  assert.ok(
    await adapter.get("m1"),
    "남은 유예가 0 이하로 떨어진 채 실패해도 restore 가 동기로 지우면 안 된다(P1-1, Z1 이 이 칸을 RED 로 만든다)",
  );
});

// HYK-304-lifecycle-orphans-1-r3(책임자 판정 §2 요구 1 "변형"): held 재진입
// 없이도 같은 창이 생길 수 있다 -- 이번이 "첫" 실패인데 adapter.put 자체가
// 남은 유예보다 오래 걸려, put 이 거부로 풀렸을 땐 이미 유예가 다 지난
// 뒤인 경우(표시가 뜨기도 전에). put 을 게이트로 묶어 그 사이 시간을
// 흘려보낸다(P-race 시험의 게이트 기법과 같음).
test("P1-1 변형: 첫 되돌리기의 put 이 남은 유예보다 오래 걸려 실패해도(표시가 뜨기 전) 동기로 지우지 않는다(Z1 이 이 칸을 RED 로 만든다)", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, {
    now: () => Date.now(),
  });

  await lifecycle.softDelete("m1"); // t=0, 하드 삭제 예약 7000
  t.mock.timers.tick(6990); // t=6990, 남은 유예 10ms

  const realPut = adapter.put.bind(adapter);
  let releasePut;
  const gate = new Promise((resolve) => {
    releasePut = resolve;
  });
  adapter.forceNextPutFailures(1);
  adapter.put = async (memo) => {
    await gate;
    return realPut(memo);
  };

  const restorePromise = lifecycle.restore("m1");
  // restore 는 adapter.put(게이트) 안에 멈춰 있다 -- cancelPending 은
  // 이미 restore 맨 앞(동기 구간)에서 돌았으므로 이 tick 이 "복구 전"
  // 타이머를 건드리지는 못한다. 문제는 put 이 거부로 풀렸을 때 남은
  // 유예 재계산이 이미 음수가 되는 것이다.
  t.mock.timers.tick(20); // t=7010, 남은 유예(= 0+7000-7010 = -10) 음수
  await Promise.resolve();
  releasePut();

  await assert.rejects(restorePromise, "put 거부를 그대로 전파해야 한다");

  assert.ok(
    await adapter.get("m1"),
    "put 이 남은 유예보다 오래 걸려 실패해도, 표시가 뜨기 전에 동기로 지워지면 안 된다(P1-1 변형, Z1 이 이 칸을 RED 로 만든다)",
  );
});

// HYK-304-lifecycle-orphans-1-r3(책임자 판정 §2 요구 5, P3-2): "남은 유예"
// 재예약(releasePending, restore 와 공유하는 remaining-grace 공식)이
// "원래 마감"을 그대로 지키는지 경계값(±1ms)으로 고정한다 -- 전체
// graceMs 로 되돌리는 변이(Z3)가 이 칸을 RED 로 만든다.
test("P3-2: 남은 유예 재예약(releasePending) 은 '원래 마감'을 그대로 지킨다 -- 6999ms 생존/7000ms 소거(경계 ±1ms, Z3 이 이 칸을 RED 로 만든다)", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, {
    now: () => Date.now(),
  });

  await lifecycle.softDelete("m1"); // t=0, 하드 삭제 예약 0+7000=7000
  t.mock.timers.tick(3000); // t=3000

  adapter.forceNextPutFailures(1);
  await assert.rejects(lifecycle.restore("m1")); // t=3000 실패, 남은 유예(4000)로 재예약(여전히 7000 에 돈다)
  lifecycle.holdPending("m1"); // 실패 표시 뜸 -- 아래 releasePending 으로 "남은 유예" 공식을 직접 잰다

  await lifecycle.releasePending("m1"); // t=3000: 바로 해제 -- 남은 유예 = 0+7000-3000 = 4000

  t.mock.timers.tick(3999); // t=6999
  await Promise.resolve();
  assert.ok(
    await adapter.get("m1"),
    "남은 유예(4000ms)가 아직 안 끝났다(6999, 경계 -1ms)",
  );

  t.mock.timers.tick(1); // t=7000
  await Promise.resolve();
  assert.equal(
    await adapter.get("m1"),
    undefined,
    "남은 유예가 정확히 원래 마감(7000)에 소거된다(P3-2, Z3 이 이 칸을 RED 로 만든다)",
  );
});

// HYK-304-notice-polish-1(§2-2, E3 P3-1 · 검토 3R §3 지적): restore catch
// 의 "남은 유예" 재예약(이 파일의 118-119행 근방)은 r2 부터 있었지만
// 어느 lifecycle 칸도 이를 "holdPending 없이" 직접 고정하지 않았다 --
// M7(restore catch 재예약을 전체 graceMs 로 바꾼 변이)이 저장소 64/64
// 초록으로 생존했다(검토 3R §2-ⓗ). mount 의 holdPending 이 곧바로
// 덮어써 UI 경로에서는 관찰되지 않지만(§한계), lifecycle API 자체의
// 의미로는 이 재예약이 "원래 마감"을 지켜야 한다 -- holdPending 을 전혀
// 부르지 않고 이 경계를 직접 잰다.
test("E3 P3-1: restore catch 의 '남은 유예' 재예약은 holdPending 없이도 원래 마감을 지킨다 -- 6999ms 생존/7000ms 소거(M7 이 이 칸을 RED 로 만든다)", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, {
    now: () => Date.now(),
  });

  await lifecycle.softDelete("m1"); // t=0, 하드 삭제 예약 0+7000=7000
  t.mock.timers.tick(3000); // t=3000

  adapter.forceNextPutFailures(1);
  await assert.rejects(lifecycle.restore("m1")); // t=3000 실패, 남은 유예(4000)로 재예약 -- holdPending 호출 없음

  t.mock.timers.tick(3999); // t=6999
  await Promise.resolve();
  assert.ok(
    await adapter.get("m1"),
    "holdPending 없이도 남은 유예(4000ms)가 아직 안 끝났다(6999)",
  );

  t.mock.timers.tick(1); // t=7000
  await Promise.resolve();
  assert.equal(
    await adapter.get("m1"),
    undefined,
    "holdPending 없이도 restore catch 의 재예약이 원래 마감(7000)에 그대로 소거한다(E3 P3-1, M7 이 이 칸을 RED 로 만든다)",
  );
});

// HYK-304-notice-polish-1(§2-3, E3 P3-2 · 검토 3R §3 지적): `remaining > 0`
// 경계(memo-lifecycle.mjs 118행)에서 "정확히 0ms" 인 실패가 고정되지
// 않았다(M10: `>= 0` 으로 바꿔도 저장소 64/64 초록). put 을 게이트로
// 묶어(P1-1 변형 시험과 같은 기법) remaining 이 "정확히" 0 이 되는
// 시각에 실패하도록 만든다 -- `>0` 이면 else 분기(held, 재예약 없음)로
// 들어가 동기 삭제가 없어야 하고, `>=0` 으로 바뀌면 delay<=0 분기
// (scheduleHardDelete 의 동기 runHardDelete)를 타 바로 지워진다.
test("E3 P3-2: 남은 유예가 정확히 0 인 실패는 동기 삭제 대신 held 로 들어간다(경계, M10 이 이 칸을 RED 로 만든다)", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const adapter = createFakeAdapter();
  await seedMemo(adapter, "m1");
  const lifecycle = createSoftDeleteLifecycle(adapter, {
    now: () => Date.now(),
  });

  await lifecycle.softDelete("m1"); // t=0, 예약 7000
  t.mock.timers.tick(6980); // t=6980, 남은 유예 20ms(게이트 전에 자연 타이머가 안 돈다)

  const realPut = adapter.put.bind(adapter);
  let releasePut;
  const gate = new Promise((resolve) => {
    releasePut = resolve;
  });
  adapter.forceNextPutFailures(1);
  adapter.put = async (memo) => {
    await gate;
    return realPut(memo);
  };

  const restorePromise = lifecycle.restore("m1");
  // cancelPending 은 restore 맨 앞(동기 구간)에서 이미 돌았다 -- put 을
  // 게이트에 막아 둔 채 시계를 "정확히" 마감(7000)까지 흘려보낸 뒤
  // 풀어준다. now() 는 put 이 거부로 풀린 뒤(catch 안)에 읽히므로,
  // remaining = deletedAt(0)+graceMs(7000)-now(7000) = 0 이 된다.
  t.mock.timers.tick(20); // t=7000, 마감과 정확히 같다
  await Promise.resolve();
  releasePut();

  await assert.rejects(restorePromise, "put 거부를 그대로 전파해야 한다");
  await Promise.resolve(); // M10(>=0) 이면 scheduleHardDelete 가 fire-and-forget remove 를 거는 자리

  assert.ok(
    await adapter.get("m1"),
    "남은 유예가 정확히 0 이어도 동기로 지우면 안 된다(경계, E3 P3-2)",
  );

  // held 로 들어갔다면(재예약 없음) release 없이는 영원히 보존된다 --
  // 한참 더 흘려보내도 그대로 살아있어야 한다(M10 이면 이미 지워져 RED).
  t.mock.timers.tick(1000000);
  await Promise.resolve();
  assert.ok(
    await adapter.get("m1"),
    "남은 유예가 정확히 0 이면 held 로 들어가 release 없이는 계속 살아있어야 한다(M10 이 이 칸을 RED 로 만든다)",
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

// HYK-304-lifecycle-orphans-1-r2(책임자 판정 §2 요구 4, P3-1 ⑴): 위
// "cleanupExpiredDeletes: graceMs 를 생략하면..." 시험은 graceMs 를
// 생략한 "기본값 경로"를 쓰지만 7000 전체가 지난 지점만 잰다(한쪽
// 방향). 여기서는 같은 기본값 경로로 "아직 유예 중"(+6999) 경계도
// 대조한다 -- 위쪽 대조 시험(graceMs: 7000 명시)과 짝이지만, 옵션을
// 생략해도(기본값 자체가) 경계를 지키는지가 다르다(검토 2R P3-1 지적
// "M2a(GRACE_MS=6000) 변이가 명시 경로 시험만으로는 못 걸린다"와 같은
// 이유로, 기본값 자체를 바꾸는 변이에도 이 칸이 걸려야 한다).
test("대조(기본값 경로): graceMs 를 생략해도 삭제시각+6999 는 지우지 않는다(P3-1 ⑴)", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "m1",
    title: "t",
    body: "b",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: 1000,
  });
  await cleanupExpiredDeletes(adapter, { now: () => 1000 + 6999 }); // graceMs 생략

  const memo = await adapter.get("m1");
  assert.ok(
    memo,
    "graceMs 를 생략한 기본값 경로에서도 6999ms(아직 유예 중)인 레코드는 지우면 안 된다",
  );
  assert.equal(memo.deletedAt, 1000);
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
