// HYK-304-test-gaps-1(책임자 판정 2026-10-22 17:50 §3): PRD §8 정책
// "자동저장: 뒤로가기·백그라운드 전환 시 즉시 저장" -- storage-mount.mjs
// mountStorage 가 document 의 visibilitychange(hidden)와 window 의
// pagehide 에 flushOnHide 를 거는 결선(254~262행) 자체는 지금까지
// 어떤 시험도 visibilitychange/pagehide 를 쏴 보지 않았다(ORCH 사전
// 측정 §1 · grep 0건 재확인). memo-store.test.mjs 의 flushImmediate 시험은
// store 메서드를 직접 부를 뿐 이 DOM 이벤트 결선을 타지 않는다.
//
// ⭐새 파일(사유, product_scope "최대 1"): save-indicator.test.mjs 등
// 기존 mountStorage 시험 파일들은 전부 같은 프로세스 안에서 전역
// document/window 에 매 mountStorage 호출마다 visibilitychange/pagehide
// 리스너를 쌓아 둔다(이 파일들의 기존 시험은 그 이벤트를 쏘지 않아
// 무해했다). 그 파일에 이 칸을 더하면 여기서 처음 쏘는 이벤트가 그
// 파일의 다른 시험들이 쌓아 둔 모든 과거 리스너(다른 adapter/store를
// 참조)를 한꺼번에 깨운다 -- 결과를 읽기 어렵게 만드는 교차 오염이다.
// node --test 는 파일마다 별도 프로세스로 돈다(실측: 이 파일 혼자
// 돌려도 전역 오염이 없다) -- 새 파일로 분리하면 이 칸이 유일한
// mountStorage 호출원이 되어 리스너가 깨끗하다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProductEditor } from "../support/make-editor.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";
import { mountStorage } from "../../src/editor/storage-mount.mjs";

async function settle() {
  // fake-adapter.mjs 의 put/get 은 실제 타이머 없는 순수 async 함수다 --
  // save-indicator.test.mjs 의 settle() 과 같은 모양(마이크로태스크 몇 틱).
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function setVisibilityState(value) {
  Object.defineProperty(document, "visibilityState", {
    value,
    configurable: true,
  });
}

function resetVisibilityState() {
  // jsdom Document.prototype 의 getter로 되돌린다(own 프로퍼티 제거) --
  // 이 파일의 시험 사이·다음 파일로 상태가 새지 않게 한다.
  delete document.visibilityState;
}

function countingAdapter() {
  const base = createFakeAdapter();
  let putCalls = 0;
  return {
    ...base,
    put: async (memo) => {
      putCalls += 1;
      return base.put(memo);
    },
    getPutCalls: () => putCalls,
  };
}

test("ⓐ visibilitychange(hidden): 1초 디바운스를 기다리지 않고 즉시 저장된다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = createFakeAdapter();
  const { editor } = makeProductEditor();
  const notice = { hidden: true, textContent: "" };
  const store = mountStorage(editor, notice, adapter);

  await store.onContentChange("a"); // 생성(디바운스 없음)
  const id = store.getMemoId();
  assert.ok(id, "사전 조건: 메모가 만들어져 있어야 한다");

  store.onContentChange("ab"); // await 하지 않음 -- 디바운스 대기(아직 1초 안 지남)
  assert.equal(
    (await adapter.get(id)).body,
    "a",
    "사전 조건: 디바운스 타이머를 아직 안 틀었으니 어댑터에는 옛 본문만 있어야 한다",
  );

  try {
    setVisibilityState("hidden");
    document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();

    const record = await adapter.get(id);
    assert.equal(
      record.body,
      "ab",
      "백그라운드 전환(hidden) 즉시 어댑터에 새 본문이 저장돼 있어야 한다 -- 디바운스 타이머(t.mock.timers.tick)를 한 번도 돌리지 않았는데도",
    );
    assert.equal(
      store.getStatus(),
      "ok",
      "즉시 저장도 performSave 경로를 타므로 상태가 ok 로 와야 한다",
    );
  } finally {
    resetVisibilityState();
  }
});

test("ⓑ pagehide: 1초 디바운스를 기다리지 않고 즉시 저장된다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = createFakeAdapter();
  const { editor } = makeProductEditor();
  const notice = { hidden: true, textContent: "" };
  const store = mountStorage(editor, notice, adapter);

  await store.onContentChange("a");
  const id = store.getMemoId();

  store.onContentChange("ab"); // 디바운스 대기 중
  assert.equal(
    (await adapter.get(id)).body,
    "a",
    "사전 조건: pagehide 전에는 아직 옛 본문이어야 한다",
  );

  window.dispatchEvent(new window.Event("pagehide"));
  await settle();

  const record = await adapter.get(id);
  assert.equal(
    record.body,
    "ab",
    "pagehide 즉시 어댑터에 새 본문이 저장돼 있어야 한다(디바운스 타이머 미실행)",
  );
});

test("반대 방향 ⑴: visible 로의 visibilitychange 는 즉시 저장을 걸지 않는다(디바운스만 저장한다)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = createFakeAdapter();
  const { editor } = makeProductEditor();
  const notice = { hidden: true, textContent: "" };
  const store = mountStorage(editor, notice, adapter);

  await store.onContentChange("a");
  const id = store.getMemoId();
  store.onContentChange("ab");

  try {
    setVisibilityState("visible");
    document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();

    assert.equal(
      (await adapter.get(id)).body,
      "a",
      "visible 전환은 flushOnHide 를 걸지 않는다 -- 디바운스 타이머가 아직 안 지났으니 옛 본문 그대로여야 한다",
    );

    t.mock.timers.tick(1000);
    await settle();
    assert.equal(
      (await adapter.get(id)).body,
      "ab",
      "디바운스 타이머가 다 지나면 평소대로 저장된다(사전 조건 확인용)",
    );
  } finally {
    resetVisibilityState();
  }
});

test("반대 방향 ⑵: autosaveBlocked 상태면 백그라운드 전환(hidden)에도 즉시 저장을 걸지 않는다(coder-task.md §1-⑷ 안전판 근거)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = countingAdapter();
  const { editor } = makeProductEditor();
  const notice = { hidden: true, textContent: "" };
  const store = mountStorage(editor, notice, adapter);

  await store.onContentChange("a");
  assert.equal(adapter.getPutCalls(), 1, "사전 조건: 생성 저장 1회");

  store.restoreState.autosaveBlocked = true; // 안전판이 선 상태를 직접 재현
  store.onContentChange("ab"); // 디바운스 대기 중(안전판과 무관하게 걸림)

  try {
    setVisibilityState("hidden");
    document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();

    assert.equal(
      adapter.getPutCalls(),
      1,
      "autosaveBlocked 면 flushOnHide 가 store.flushImmediate() 를 부르지 않아야 한다 -- put 호출 수가 그대로여야 한다",
    );
  } finally {
    resetVisibilityState();
  }
});
