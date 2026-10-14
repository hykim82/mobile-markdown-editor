// HYK-304-delete-undo-ui-1 (coder-task.md §2): PRD §5.5 삭제(+되돌리기)
// 결선 -- 실제 목록 화면 결선(memo-list-mount.mjs 경유, 데이터 계층만
// 부르는 시험이 아니다)을 스와이프해 softDelete/restore 가 실제로 돌게
// 하고, 그 결과를 DOM(카드 존재·토스트)과 저장 계층(adapter.get) 양쪽
// 값으로 잰다. 가짜 시계(수동 주입)로 7초 경계를 결정적으로 잰다 --
// test/storage/memo-lifecycle.test.mjs 와 같은 경계(6999ms/7000ms)를
// 이 화면 결선 위에서 다시 잰다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountMemoList } from "../../src/editor/memo-list-mount.mjs";
import { createMemoStore } from "../../src/storage/memo-store.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";

const { window } = globalThis;

async function createMemoAt(adapter, body, updatedAt) {
  const store = createMemoStore(adapter, { now: () => updatedAt });
  await store.onContentChange(body);
  return store.getMemoId();
}

function makeToastElements() {
  const element = document.createElement("div");
  element.hidden = true;
  const undoButton = document.createElement("button");
  element.append(undoButton);
  return { element, undoButton };
}

// 수동 가짜 시계 -- memo-lifecycle.mjs(hard delete 예약) 와 memo-list-
// mount.mjs(토스트 자동 숨김)가 "같은" 시계를 공유하도록 둘 다 이
// setTimeoutFn/clearTimeoutFn 을 주입받는다. node:test 의 t.mock.timers
// 대신 직접 짠다 -- 전역 setTimeout 을 바꿔치기하지 않아 settle()(진짜
// 0ms 타이머로 마이크로태스크를 흘려보내는 헬퍼)과 서로 간섭하지 않는다.
function makeFakeClock() {
  let now = 0;
  let nextId = 1;
  const scheduled = [];
  return {
    now: () => now,
    setTimeoutFn(fn, ms) {
      const id = nextId++;
      scheduled.push({ id, time: now + ms, fn });
      return id;
    },
    clearTimeoutFn(id) {
      const idx = scheduled.findIndex((t) => t.id === id);
      if (idx !== -1) scheduled.splice(idx, 1);
    },
    advance(ms) {
      now += ms;
      const due = scheduled.filter((t) => t.time <= now);
      due.sort((a, b) => a.time - b.time);
      for (const t of due) {
        const idx = scheduled.indexOf(t);
        if (idx !== -1) scheduled.splice(idx, 1);
        t.fn();
      }
    },
  };
}

function dispatchPointer(el, type, clientX) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: clientX });
  el.dispatchEvent(event);
}

// 스와이프 = pointerdown → (임계값 40px 을 넘는) pointermove → pointerup
// (memo-list-view.mjs 의 SWIPE_THRESHOLD_PX). 실기기 좌표 대신 jsdom
// 이벤트로 흉내 낸다 -- checkbox-tap-toggle.test.mjs 의 tap() 과 같은
// 선례.
function swipe(card) {
  dispatchPointer(card, "pointerdown", 100);
  dispatchPointer(card, "pointermove", 20);
  dispatchPointer(card, "pointerup", 20);
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function cardIds(container) {
  return [...container.querySelectorAll(".memo-card")].map(
    (el) => el.dataset.memoId,
  );
}

function makeList(container, adapter, clock, extra = {}) {
  const toast = makeToastElements();
  const list = mountMemoList(container, adapter, {
    onOpen: () => {},
    toast,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    ...extra,
  });
  return { list, toast };
}

test("①스와이프 → 목록에서 즉시 숨김 + 되돌리기 토스트가 뜬다", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "지울 메모", 100);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();
  assert.deepEqual(cardIds(container), [id]);

  swipe(container.querySelector(`[data-memo-id="${id}"]`));
  await settle();

  assert.deepEqual(
    cardIds(container),
    [],
    "스와이프 직후 목록에서 숨겨져야 한다(수용 기준①)",
  );
  assert.equal(toast.element.hidden, false, "되돌리기 토스트가 떠야 한다");
  assert.equal(toast.element.dataset.memoId, id);
});

test("②되돌리기를 누르면 복원되고 목록에 다시 나타난다", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "되돌릴 메모", 100);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  swipe(container.querySelector(`[data-memo-id="${id}"]`));
  await settle();
  assert.deepEqual(cardIds(container), []);

  toast.undoButton.click();
  await settle();

  assert.deepEqual(
    cardIds(container),
    [id],
    "되돌리기 뒤 목록에 다시 나타나야 한다(수용 기준②)",
  );
  assert.equal(
    toast.element.hidden,
    true,
    "되돌리기 뒤 토스트는 숨겨져야 한다",
  );
  const record = await adapter.get(id);
  assert.equal(record.deletedAt, null, "삭제시각이 null 로 복원돼야 한다");
});

test("③7초 경과 시 hard delete 로 저장소에서 실제로 사라진다(6999ms/7000ms 경계)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "7초 뒤 사라질 메모", 100);
  const clock = makeFakeClock();
  const { list } = makeList(container, adapter, clock);
  await list.refresh();

  swipe(container.querySelector(`[data-memo-id="${id}"]`));
  await settle();
  assert.ok(await adapter.get(id), "7초 전에는 아직 저장소에 남아 있어야 한다");

  clock.advance(6999);
  assert.ok(await adapter.get(id), "6999ms 에는 아직 있어야 한다");

  clock.advance(1);
  await settle();
  assert.equal(
    await adapter.get(id),
    undefined,
    "7000ms 에 hard delete 돼야 한다(수용 기준③)",
  );
});

test("④확인 단계 없음 -- 스와이프 한 번으로 곧장 삭제되고, 뒤따르는 합성 click 은 메모를 다시 열지 않는다", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "확인창 없이 지울 메모", 100);
  const clock = makeFakeClock();
  const opened = [];
  const { list, toast } = makeList(container, adapter, clock, {
    onOpen: (openedId) => opened.push(openedId),
  });
  await list.refresh();
  const card = container.querySelector(`[data-memo-id="${id}"]`);

  swipe(card);
  // 스와이프와 삭제 사이에 그 어떤 추가 입력(확인 버튼 클릭 등)도 없다 --
  // "별도 확인 단계 없음"(수용 기준④)을 "swipe() 한 번 + settle() 뿐"으로 잰다.
  await settle();
  assert.deepEqual(cardIds(container), [], "추가 확인 없이 바로 숨겨져야 한다");
  assert.equal(toast.element.hidden, false);

  // 실기기에서 손가락을 떼면 브라우저가 스와이프에 이어 합성 click 을
  // 보낸다(카드가 button 이므로) -- 그 click 이 "메모 열기"로 오판되면
  // 안 된다(memo-list-view.mjs attachSwipeToDelete 의 click 가드).
  card.dispatchEvent(
    new window.Event("click", { bubbles: true, cancelable: true }),
  );
  await settle();
  assert.deepEqual(
    opened,
    [],
    "스와이프 뒤 합성 click 이 메모를 다시 열면 안 된다",
  );
});

test("ⓔ되돌리기 뒤 7초가 지나도 메모는 남아있다(예약된 하드 삭제 취소)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "되돌린 뒤 살아있어야 하는 메모", 100);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  swipe(container.querySelector(`[data-memo-id="${id}"]`));
  await settle();

  clock.advance(3000);
  toast.undoButton.click();
  await settle();
  assert.deepEqual(
    cardIds(container),
    [id],
    "복원 즉시 목록에 다시 보여야 한다",
  );

  clock.advance(10000); // 원래 하드 삭제 예약이 살아있었다면 이 사이에 지워졌을 것
  await settle();
  const record = await adapter.get(id);
  assert.ok(record, "복원 뒤 예약된 하드 삭제가 취소돼 살아있어야 한다");
  assert.equal(record.deletedAt, null);
});

test("ⓕ두 메모를 연속으로 삭제해도 각각 독립적으로 되돌리기/하드 삭제된다", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const idA = await createMemoAt(adapter, "메모 A", 100);
  const idB = await createMemoAt(adapter, "메모 B", 200);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();
  assert.deepEqual(cardIds(container), [idB, idA], "전: 최신 수정순");

  // A 를 지웠다가 되돌린다.
  swipe(container.querySelector(`[data-memo-id="${idA}"]`));
  await settle();
  assert.deepEqual(cardIds(container), [idB]);
  toast.undoButton.click();
  await settle();
  assert.deepEqual(cardIds(container), [idB, idA], "A 는 되돌려져 다시 보인다");

  // B 를 지우고 되돌리지 않은 채 7초를 보낸다 -- A 의 되돌리기가 B 의
  // 삭제·하드 삭제 예약에 영향을 주면 안 된다(독립).
  swipe(container.querySelector(`[data-memo-id="${idB}"]`));
  await settle();
  assert.deepEqual(cardIds(container), [idA], "B 를 지우면 A 만 남아야 한다");

  clock.advance(7000);
  await settle();
  assert.equal(await adapter.get(idB), undefined, "B 는 하드 삭제돼야 한다");
  const recordA = await adapter.get(idA);
  assert.ok(recordA, "A 는 되돌려졌으니 그대로 남아있어야 한다");
  assert.equal(recordA.deletedAt, null);
  assert.deepEqual(cardIds(container), [idA], "최종 목록엔 A 만 남는다");
});
