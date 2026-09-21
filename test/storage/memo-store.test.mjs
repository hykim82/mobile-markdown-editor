// PRD §8 정책 표 중 생성/자동저장/자동저장 실패/저장공간 부족을 시험한다.
// coder-task.md §3-①②③: 각 줄이 어느 시험으로 재지는지는 결과 파일에
// 표로 옮긴다.
//
// ⚠️순서 주의: createMemoStore() 는 호출 시점에 기본 파라미터
// (`options.setTimeoutFn ?? setTimeout`)로 그 시점의 전역 setTimeout을
// 캡처한다. t.mock.timers.enable()보다 먼저 store를 만들면 진짜(mock 아닌)
// setTimeout이 캡처돼 tick()이 아무 효과가 없다(실측: 이 순서를 뒤집었더니
// 디바운스 시험이 조용히 "진짜 1000ms를 못 기다려서" 실패했다) -- 그래서
// 아래 모든 시험은 enable() 을 store 생성보다 먼저 부른다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoStore } from "../../src/storage/memo-store.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";

test("생성: 첫 글자 입력 순간 메모가 생기고 디바운스 없이 즉시 저장된다", async () => {
  const adapter = createFakeAdapter();
  const store = createMemoStore(adapter);
  await store.onContentChange("a");
  const id = store.getMemoId();
  assert.ok(id, "id 가 발급돼야 한다");
  assert.equal((await adapter.get(id)).body, "a");
  assert.equal(store.getStatus(), "ok");
});

test("생성: 빈 문자열로는 메모를 만들지도 저장하지도 않는다", async () => {
  const adapter = createFakeAdapter();
  const store = createMemoStore(adapter);
  await store.onContentChange("");
  assert.equal(store.getMemoId(), null);
  assert.deepEqual(await adapter.list(), []);
});

test("자동저장: 입력이 멈추고 1초 지나야 저장된다(그 전엔 이전 값 그대로)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = createFakeAdapter();
  const store = createMemoStore(adapter);
  await store.onContentChange("a"); // 생성은 즉시 저장(위 시험)

  const id = store.getMemoId();
  store.onContentChange("ab"); // 디바운스 대기, await 안 함(캐럿이 저장을 안 기다리는 모양 그대로)

  t.mock.timers.tick(999);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal((await adapter.get(id)).body, "a", "999ms 에는 아직 이전 값");

  t.mock.timers.tick(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal((await adapter.get(id)).body, "ab", "1000ms 에는 새 값");
});

test("자동저장: flushImmediate 는 디바운스를 기다리지 않고 즉시 저장한다(뒤로가기·백그라운드 전환)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = createFakeAdapter();
  const store = createMemoStore(adapter);
  await store.onContentChange("a");

  const id = store.getMemoId();
  store.onContentChange("ab");
  await store.flushImmediate();

  assert.equal((await adapter.get(id)).body, "ab");
});

test("자동저장 실패: 1회 재시도 후에도 실패하면 메모리 값은 유지하고 상태만 failed 로 남긴다 -- 내용을 안 버린다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = createFakeAdapter();
  const store = createMemoStore(adapter);
  await store.onContentChange("a");
  const id = store.getMemoId();

  adapter.forceNextPutFailures(2); // 첫 시도 + 재시도 1회 모두 실패
  store.onContentChange("ab");
  t.mock.timers.tick(1000);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(store.getStatus(), "failed");
  assert.equal(
    (await adapter.get(id)).body,
    "a",
    "저장 자체는 실패했지만 이전 저장값은 훼손되지 않는다",
  );
});

test("자동저장 실패: 다음 입력이 오면(입력마다 재시도) 다시 저장을 시도해 이번엔 성공한다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = createFakeAdapter();
  const store = createMemoStore(adapter);
  await store.onContentChange("a");
  const id = store.getMemoId();

  adapter.forceNextPutFailures(2);
  store.onContentChange("ab");
  t.mock.timers.tick(1000);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.getStatus(), "failed");

  store.onContentChange("abc"); // 다음 입력 -- 새 시도 사이클(실패 이력을 안 들고 감)
  t.mock.timers.tick(1000);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(store.getStatus(), "ok");
  assert.equal((await adapter.get(id)).body, "abc");
});

test("저장공간 부족: QuotaExceededError 는 상태를 quota-exceeded 로 표시하고 캐시 정리를 시도한다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = createFakeAdapter();
  let cleanupCalls = 0;
  const store = createMemoStore(adapter, {
    cacheCleanup: async () => {
      cleanupCalls += 1;
    },
  });
  await store.onContentChange("a");

  const quotaError = Object.assign(new Error("no space"), {
    name: "QuotaExceededError",
  });
  adapter.forceNextPutFailures(2, quotaError);
  store.onContentChange("ab");
  t.mock.timers.tick(1000);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(store.getStatus(), "quota-exceeded");
  assert.equal(
    cleanupCalls,
    1,
    "캐시 정리는 저장공간 부족일 때만, 정확히 1번 시도한다",
  );
});

test("저장공간 부족이 아닌 일반 실패에는 캐시 정리를 시도하지 않는다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = createFakeAdapter();
  let cleanupCalls = 0;
  const store = createMemoStore(adapter, {
    cacheCleanup: async () => {
      cleanupCalls += 1;
    },
  });
  await store.onContentChange("a");

  adapter.forceNextPutFailures(2, new Error("network-ish failure"));
  store.onContentChange("ab");
  t.mock.timers.tick(1000);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(store.getStatus(), "failed");
  assert.equal(cleanupCalls, 0);
});

test("이미 있는 메모를 전부 지워 빈 문자열이 되면 하드 삭제하고, 다음 입력에서 새 메모로 다시 생긴다", async () => {
  const adapter = createFakeAdapter();
  const store = createMemoStore(adapter);
  await store.onContentChange("a");
  const firstId = store.getMemoId();

  await store.onContentChange("");
  assert.equal(store.getMemoId(), null);
  assert.equal(await adapter.get(firstId), undefined);

  await store.onContentChange("b");
  const secondId = store.getMemoId();
  assert.notEqual(secondId, firstId);
  assert.equal((await adapter.get(secondId)).body, "b");
});

// 회귀 시험(HYK-304-storage-1 실기기 확인 중 실측): Node 의 네이티브
// setTimeout/clearTimeout 은 `obj.setTimeout(...)` 처럼 다른 객체의
// 메서드로 불려도 상관하지 않지만, 실제 브라우저의 네이티브 구현은
// "receiver 가 window 가 아니면" TypeError: Illegal invocation 을 던진다.
// buildConfig() 의 기본값이 한때 네이티브 참조를 그대로 넘겼었는데(레퍼런스
// 자체를 config.setTimeoutFn 자리에 대입), 그러면 config.setTimeoutFn(...)
// 호출 시 this 가 config 로 바뀌어 실브라우저에서만 죽었다 -- node:test 는
// 이 receiver 제약이 없어 이 버그를 못 잡았다(claude-in-chrome 으로 실제
// 타이핑해서야 드러남). 여기서는 전역 setTimeout/clearTimeout 을 그
// receiver 제약을 흉내 낸 가짜로 잠깐 바꿔치기해 같은 조건을 Node 에서
// 재현한다 -- 이 시험이 다시 RED 가 되면 같은 버그가 재발한 것이다.
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
  const store = createMemoStore(adapter); // 옵션 없음 -- 기본값 경로 자체를 시험
  await store.onContentChange("a"); // 생성(즉시 저장) 경로
  assert.doesNotThrow(() => store.onContentChange("ab")); // 디바운스 예약 경로
  await store.flushImmediate(); // 즉시 플러시(clearTimeoutFn 경로)
  assert.equal((await adapter.get(store.getMemoId())).body, "ab");
});
