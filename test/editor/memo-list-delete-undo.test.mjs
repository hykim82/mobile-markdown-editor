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
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mountMemoList,
  UNDO_TOAST_MS,
} from "../../src/editor/memo-list-mount.mjs";
import { SAVE_ERROR_MESSAGE } from "../../src/editor/memo-list-view.mjs";
import { createMemoStore } from "../../src/storage/memo-store.mjs";
import { createSoftDeleteLifecycle } from "../../src/storage/memo-lifecycle.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";

const { window } = globalThis;
const here = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = join(here, "..", "..", "public", "index.html");

async function createMemoAt(adapter, body, updatedAt) {
  const store = createMemoStore(adapter, { now: () => updatedAt });
  await store.onContentChange(body);
  return store.getMemoId();
}

// HYK-304-delete-undo-ui-2(책임자 판정 §2): 저장 실패 표시가 이제 이
// 되돌리기 토스트와 같은 고정 영역을 나눠 쓴다 -- textEl(평소 "메모를
// 삭제했어요" 자리) · undoButton(기존) · errorButton(신규, 책임자
// 결정④ 문구 전용) 셋을 실제 출하 public/index.html 과 같은 모양으로
// 만든다(memo-list-mount.mjs 의 syncToastVisibility 가 이 셋의 hidden
// 을 가른다).
function makeToastElements() {
  const element = document.createElement("div");
  element.hidden = true;
  const textEl = document.createElement("span");
  const undoButton = document.createElement("button");
  const errorButton = document.createElement("button");
  errorButton.hidden = true;
  element.append(textEl, undoButton, errorButton);
  return { element, textEl, undoButton, errorButton };
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

// 검토 1R P1-1 ⓐ · 2R P3-1: jsdom 은 touch-action 을 흉내 내지 않으므로,
// 출하 public/index.html 실물의 카드 규칙 문자열을 직접 대조한다(배선 6
// 선례, app-wiring.test.mjs). 2R 에서 이 시험의 "첫 블록만 본다" 약점이
// 드러났다(C2 주석·C4/C5 뒤쪽 재선언이 전부 GREEN으로 샜다 -- 검토 2R
// §6 P3-1). 지금은 ⑴ 주석을 먼저 벗기고 ⑵ 같은 선택자의 "모든" 규칙
// 블록을 순서대로 훑어 ⑶ 그중 "마지막" touch-action 값만 본다 --
// 브라우저의 캐스케이드(나중 선언이 이긴다)와 같은 규칙이다.
test('출하 CSS: #list-root .memo-card 선택자의 모든 규칙을 통틀어 "마지막" touch-action 값이 pan-y 다(P1-1 ⓐ · P3-1 닫힘)', async () => {
  const html = await readFile(indexHtmlPath, "utf8");
  const withoutComments = html.replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleRe = /#list-root \.memo-card\s*\{([^}]*)\}/gs;
  let match;
  let sawAny = false;
  let lastValue = null;
  while ((match = ruleRe.exec(withoutComments)) !== null) {
    const decls = match[1].match(/touch-action\s*:\s*([a-z-]+)/g);
    if (!decls) continue;
    sawAny = true;
    lastValue = decls[decls.length - 1].split(":")[1].trim();
  }
  assert.ok(
    sawAny,
    "주석을 벗긴 뒤에도 #list-root .memo-card 규칙(들) 안에 touch-action 선언이 있어야 한다",
  );
  assert.equal(
    lastValue,
    "pan-y",
    '같은 선택자의 모든 규칙(주석 속 선언 제외)을 통틀어 "마지막" touch-action 값이 pan-y 여야 한다 -- 뒤쪽 재선언·추가 규칙이 이를 덮으면 안 된다',
  );
});

// 검토 1R P1-1 ⓑ · P3-1: 브라우저가 가로 스와이프를 팬 제스처로 가져가면
// pointerup 대신 pointercancel 이 온다. 그 뒤 swiped 상태가 안 풀리면,
// 이어지는(새 pointerdown 없는) click 하나를 click 가드가 삼켜 "한 번
// 열기"가 사라진다.
test("pointercancel 뒤엔 삭제가 안 되고, 이어지는 click 은 onOpen 을 정상적으로 부른다(P1-1 ⓑ · P3-1 닫힘)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "취소된 스와이프 메모", 100);
  const clock = makeFakeClock();
  const opened = [];
  const { list } = makeList(container, adapter, clock, {
    onOpen: (openedId) => opened.push(openedId),
  });
  await list.refresh();
  const card = container.querySelector(`[data-memo-id="${id}"]`);

  dispatchPointer(card, "pointerdown", 100);
  dispatchPointer(card, "pointermove", 20); // 문턱(40px) 넘김
  card.dispatchEvent(
    new window.Event("pointercancel", { bubbles: true, cancelable: true }),
  );
  // 키보드 활성화 모양: 새 pointerdown 없이 곧장 click 만 온다.
  card.dispatchEvent(
    new window.Event("click", { bubbles: true, cancelable: true }),
  );
  await settle();

  assert.deepEqual(
    cardIds(container),
    [id],
    "pointercancel 뒤엔 삭제가 일어나면 안 된다",
  );
  assert.deepEqual(
    opened,
    [id],
    "pointercancel 뒤의 click 은 onOpen 을 불러야 한다(삼켜지면 안 된다)",
  );
});

// 검토 1R P2-1(M5 생존): 문턱(40px)을 못 넘는 작은 이동은 스와이프가
// 아니다 -- 탭(및 약간의 손 떨림)으로 열기가 정상 동작해야 한다.
test("문턱 미만 이동은 스와이프가 아니다 -- 탭으로 열리고 삭제되지 않는다(P2-1)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "살짝 흔들린 메모", 100);
  const clock = makeFakeClock();
  const opened = [];
  const { list } = makeList(container, adapter, clock, {
    onOpen: (openedId) => opened.push(openedId),
  });
  await list.refresh();
  const card = container.querySelector(`[data-memo-id="${id}"]`);

  dispatchPointer(card, "pointerdown", 100);
  dispatchPointer(card, "pointermove", 95); // 5px, 문턱 미만
  dispatchPointer(card, "pointerup", 95);
  card.dispatchEvent(
    new window.Event("click", { bubbles: true, cancelable: true }),
  );
  await settle();

  assert.deepEqual(
    cardIds(container),
    [id],
    "문턱 미만 이동으로 삭제되면 안 된다",
  );
  assert.deepEqual(
    opened,
    [id],
    "탭으로는 열려야 한다(onOpen 1회, mount 경유)",
  );
  const record = await adapter.get(id);
  assert.equal(record.deletedAt, null, "삭제시각은 null 그대로여야 한다");
});

// 검토 1R P2-2(M6·M7 생존): 되돌리기 토스트 자체의 자동 숨김이 7초
// 경계에서 고정돼 있는지(하드 삭제와는 별개의 축 -- 위 ③ 시험은 저장소
// 쪽만 본다). UNDO_TOAST_MS 를 바꾸거나(M6) 숨김 타이머를 없애면(M7)
// 이 시험이 빨개진다.
test("되돌리기 토스트는 6999ms 에는 보이고 7000ms 에는 자동으로 숨는다(P2-2 경계)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "토스트 경계 메모", 100);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  swipe(container.querySelector(`[data-memo-id="${id}"]`));
  await settle();
  assert.equal(
    toast.element.hidden,
    false,
    "스와이프 직후 토스트가 보여야 한다",
  );

  clock.advance(6999);
  assert.equal(
    toast.element.hidden,
    false,
    "6999ms 에는 아직 토스트가 보여야 한다",
  );

  clock.advance(1);
  assert.equal(
    toast.element.hidden,
    true,
    "7000ms 에는 토스트가 자동으로 숨겨져야 한다",
  );
});

// 검토 1R P2-3(M10 생존) + 2R P2-1(위치 수정): 스와이프 삭제 저장
// (adapter.put)이 거부되면 unhandledRejection 으로 새면 안 되고, 책임자
// 결정④ 문구를 "토스트 고정 영역"에서 보여주되(목록 끝 append 아님 --
// 2R 이 여기서 닫은 자리) 카드는 그대로 남아야 한다. 재시도를 누르면
// (같은 동작을 다시 시도) 저장 계층이 되살아 있으니 정상 스와이프 삭제
// 경로(숨김+토스트)로 끝난다.
test("저장 실패: adapter.put 거부 시 unhandledRejection 없이 토스트 고정 영역에 표시되고 카드가 남으며, 재시도하면 성공한다(P2-3 · P2-1 닫힘)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "저장 실패 메모", 100);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();
  assert.deepEqual(cardIds(container), [id]);

  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on("unhandledRejection", onRejection);

  try {
    adapter.forceNextPutFailures(1);
    swipe(container.querySelector(`[data-memo-id="${id}"]`));
    await settle();
    await settle();

    assert.deepEqual(
      rejections,
      [],
      "unhandledRejection 이 0이어야 한다(P2-3)",
    );
    assert.deepEqual(
      cardIds(container),
      [id],
      "저장 실패 뒤에도 카드는 남아있어야 한다",
    );
    assert.equal(
      container.querySelector(".memo-list-error"),
      null,
      "목록 컨테이너(스크롤 영역)에는 더 이상 오류가 붙지 않는다(P2-1)",
    );
    assert.equal(
      toast.element.hidden,
      false,
      "저장 실패 표시는 토스트 고정 영역에서 보여야 한다(P2-1 위치 수정)",
    );
    assert.equal(
      toast.errorButton.hidden,
      false,
      "오류 재시도 버튼이 보여야 한다",
    );
    assert.equal(toast.errorButton.textContent, SAVE_ERROR_MESSAGE);
    assert.equal(
      toast.undoButton.hidden,
      true,
      "되돌릴 대상이 없으니 되돌리기 버튼은 안 보여야 한다",
    );

    toast.errorButton.click();
    await settle();
    await settle();

    assert.deepEqual(
      cardIds(container),
      [],
      "재시도가 성공하면 정상 스와이프 삭제 경로로 카드가 숨겨져야 한다",
    );
    assert.equal(
      toast.element.hidden,
      false,
      "재시도 성공 뒤엔 되돌리기 토스트가 떠야 한다",
    );
    assert.equal(
      toast.undoButton.hidden,
      false,
      "재시도 성공 뒤 되돌리기 버튼이 보여야 한다",
    );
    assert.equal(toast.errorButton.hidden, true, "오류 표시는 사라져야 한다");
    const record = await adapter.get(id);
    assert.ok(record.deletedAt !== null, "저장소에도 삭제가 반영돼야 한다");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

// 책임자 판정 §2 풀어 쓴 요구 1-ⓐ(검토 2R P2-1 후속): 긴 목록(한 화면을
// 넘는 카드 수, 2R §6 P2-1 표본 31장과 같은 자릿수)에서도 저장 실패
// 표시는 카드 수와 무관하게 "고정 영역"(토스트 자리)에서 보여야 한다 --
// jsdom 은 레이아웃을 재지 않으므로 "화면 밖"은 DOM 위치(목록 컨테이너
// 안이냐 밖이냐)로 잰다: 목록 끝에 붙으면 스크롤해야 보이고, 토스트
// 영역(별도 고정 엘리먼트)에 있으면 카드 수와 무관하게 항상 보인다.
test("저장 실패 표시는 목록 길이와 무관하게 항상 토스트 고정 영역에서 보인다(위치 요구 ⓐ · P2-1 닫힘)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const ids = [];
  for (let i = 0; i < 31; i += 1) {
    ids.push(await createMemoAt(adapter, `메모 ${i}`, 100 + i));
  }
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();
  assert.equal(cardIds(container).length, 31, "31장 전부 그려져야 한다");

  const targetId = ids[3];
  adapter.forceNextPutFailures(1);
  swipe(container.querySelector(`[data-memo-id="${targetId}"]`));
  await settle();
  await settle();

  assert.equal(
    container.querySelector(".memo-list-error"),
    null,
    "목록(스크롤) 컨테이너에는 오류가 붙지 않는다",
  );
  assert.equal(
    toast.element.hidden,
    false,
    "오류는 카드 수와 무관하게 고정 토스트 영역에서 보여야 한다",
  );
  assert.equal(toast.errorButton.hidden, false);
  assert.equal(toast.errorButton.textContent, SAVE_ERROR_MESSAGE);
});

// 책임자 판정 §2 풀어 쓴 요구 1-ⓑ: 되돌리기 토스트(메모 A)가 이미 떠
// 있는 동안 다른 메모(B)의 스와이프 저장이 실패하면, 실패 표시가 그
// 자리를 대신하되(텍스트 숨김) "되돌리기" 버튼은 유지된다 -- 두 버튼이
// 한 영역에 함께 뜨는 배치(결과 파일 §선택 근거 참고). A 의 되돌리기가
// 여전히 정상 동작하는지(공존), 그리고 A 가 복원돼도 B 의(별개 id) 저장
// 실패 표시는 교차로 사라지지 않는지(설계 §한계)까지 잰다.
test("토스트가 떠 있을 때 다른 메모의 저장이 실패하면 실패 표시가 그 자리를 대신하고 되돌리기 버튼은 유지된다(위치 요구 ⓑ)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const idA = await createMemoAt(adapter, "메모 A(되돌리기 대상)", 100);
  const idB = await createMemoAt(adapter, "메모 B(저장 실패)", 200);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  swipe(container.querySelector(`[data-memo-id="${idA}"]`));
  await settle();
  assert.equal(
    toast.undoButton.hidden,
    false,
    "A 삭제 뒤 되돌리기 토스트가 떠야 한다",
  );
  assert.equal(toast.element.dataset.memoId, idA);

  adapter.forceNextPutFailures(1);
  swipe(container.querySelector(`[data-memo-id="${idB}"]`));
  await settle();
  await settle();

  assert.equal(
    toast.errorButton.hidden,
    false,
    "B 의 저장 실패 표시가 토스트 자리에 떠야 한다",
  );
  assert.equal(
    toast.undoButton.hidden,
    false,
    "A 의 되돌리기 버튼은 유지돼야 한다(제품 결정)",
  );
  assert.equal(
    toast.textEl.hidden,
    true,
    "실패 표시가 평소 삭제 안내 문구 자리를 대신한다",
  );

  toast.undoButton.click();
  await settle();

  assert.deepEqual(
    cardIds(container).includes(idA),
    true,
    "되돌리기 버튼이 살아있으니 A 는 정상 복원돼야 한다",
  );
  assert.equal(
    toast.errorButton.hidden,
    false,
    "B 의 실패 표시는 A 복원과 무관하게 남아있어야 한다(아이디별 분리, §한계)",
  );
});

// 책임자 판정 §2 풀어 쓴 요구 2(되돌리기 쪽 고정 칸): 스와이프 →
// (되돌리기 시점의) put 1회 거부 → 되돌리기 → unhandledRejection 0 ·
// 표시 · 재시도 → 복원(mount 경유). 검토 2R P2-2 가 지적한 "되돌리기
// 쪽을 잡는 고정 칸이 없다"를 닫는다(F1·F4 생존 대상).
test("되돌리기 쪽 저장 실패: put 1회 거부 → unhandledRejection 0 · 표시 · 재시도 → 복원(P2-2 닫힘)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "되돌리기 저장 실패 메모", 100);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  swipe(container.querySelector(`[data-memo-id="${id}"]`));
  await settle();
  assert.deepEqual(cardIds(container), [], "스와이프 직후 숨겨져야 한다");

  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on("unhandledRejection", onRejection);

  try {
    adapter.forceNextPutFailures(1);
    toast.undoButton.click();
    await settle();
    await settle();

    assert.deepEqual(
      rejections,
      [],
      "되돌리기 저장 실패가 unhandledRejection 으로 새면 안 된다(P2-2)",
    );
    assert.deepEqual(
      cardIds(container),
      [],
      "복원이 실패했으니 카드는 아직 안 보여야 한다",
    );
    assert.equal(toast.errorButton.hidden, false, "저장 실패 표시가 떠야 한다");
    assert.equal(toast.errorButton.textContent, SAVE_ERROR_MESSAGE);

    toast.errorButton.click();
    await settle();
    await settle();

    assert.deepEqual(
      cardIds(container),
      [id],
      "재시도가 성공하면 복원돼야 한다",
    );
    const record = await adapter.get(id);
    assert.equal(record.deletedAt, null, "삭제시각이 null 로 복원돼야 한다");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

// 책임자 판정 §2 풀어 쓴 요구 2(P2-2 교차오염 닫힘): A 되돌리기 put 1회
// 거부(A 실패 표시) → B 스와이프 성공(B 토스트 뜸) → A 실패 버튼(재시도)
// → A 는 복원되지만 B 의 되돌리기는 끊기면 안 된다 -- handler 가 "자기
// 것이 아닌" active 를 떼어내면(변이 H1, memo-list-mount.mjs 의 id 조건
// 제거) B 의 되돌리기 버튼이 사라지고 7초 뒤 B 가 하드 삭제된다.
test("되돌리기 재시도가 다른 메모(B)의 살아있는 되돌리기를 끊지 않는다(P2-2 교차오염 닫힘, H1 생존 대상)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const idA = await createMemoAt(
    adapter,
    "메모 A(되돌리기 실패 후 재시도)",
    100,
  );
  const idB = await createMemoAt(adapter, "메모 B(독립 되돌리기)", 200);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  // A 스와이프 → A 되돌리기 put 1회 거부(A 실패 표시, 요구 3: A 자신의
  // 실패 중엔 되돌리기 버튼 숨김 · 실패 버튼만).
  swipe(container.querySelector(`[data-memo-id="${idA}"]`));
  await settle();
  adapter.forceNextPutFailures(1);
  toast.undoButton.click();
  await settle();
  await settle();
  assert.equal(
    toast.errorButton.hidden,
    false,
    "A 되돌리기 실패 표시가 떠야 한다",
  );
  assert.equal(
    toast.undoButton.hidden,
    true,
    "A 자신의 되돌리기 실패 중엔 되돌리기 버튼은 숨겨진다(요구 3)",
  );

  // B 스와이프 성공(B 토스트 -- 되돌리기 버튼과 A 의 실패 버튼이 함께
  // 보임).
  swipe(container.querySelector(`[data-memo-id="${idB}"]`));
  await settle();
  assert.equal(
    toast.undoButton.hidden,
    false,
    "B 삭제 뒤 되돌리기 버튼이 보여야 한다",
  );
  assert.equal(
    toast.errorButton.hidden,
    false,
    "A 의 실패 버튼은 B 삭제와 무관하게 남아야 한다",
  );
  assert.equal(toast.element.dataset.memoId, idB);

  // A 실패 버튼(재시도) -> A 는 복원되지만 B 의 되돌리기는 살아있어야
  // 한다(핵심 단언, 변이 H1 이 이 블록을 RED 로 만든다).
  toast.errorButton.click();
  await settle();
  await settle();

  assert.deepEqual(
    cardIds(container).includes(idA),
    true,
    "A 는 재시도로 복원돼야 한다",
  );
  assert.equal(
    toast.undoButton.hidden,
    false,
    "B 의 되돌리기 버튼은 A 재시도 뒤에도 살아있어야 한다(P2-2 교차오염 닫힘)",
  );
  assert.equal(
    toast.element.dataset.memoId,
    idB,
    "토스트는 A 재시도 뒤에도 여전히 B 를 가리켜야 한다",
  );

  // B 되돌리기가 실제로 아직 동작하는지(살아있는 버튼이 "진짜" 되돌릴
  // 수 있는지)까지 값으로 잰다.
  toast.undoButton.click();
  await settle();
  assert.deepEqual(
    cardIds(container).includes(idB),
    true,
    "B 되돌리기 버튼이 눌리면 B 도 복원돼야 한다",
  );
});

// 책임자 판정 §2 풀어 쓴 요구 3-⑵(P3-2 닫힘, G1 생존): 39px 는 좌우 모두
// 스와이프가 아니고(탭으로 처리), 40px 은 좌우 모두 스와이프(삭제)다 --
// SWIPE_THRESHOLD_PX(40)의 ">=" 비교가 ">" 로 바뀌면(G1) 40px 왼쪽 삭제가
// 깨진다.
test("스와이프 문턱 39px(경계 미만): 좌우 모두 삭제되지 않고 탭으로 열린다(P3-2)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const idLeft = await createMemoAt(adapter, "39px 왼쪽", 100);
  const idRight = await createMemoAt(adapter, "39px 오른쪽", 200);
  const clock = makeFakeClock();
  const opened = [];
  const { list } = makeList(container, adapter, clock, {
    onOpen: (openedId) => opened.push(openedId),
  });
  await list.refresh();

  const cardLeft = container.querySelector(`[data-memo-id="${idLeft}"]`);
  dispatchPointer(cardLeft, "pointerdown", 100);
  dispatchPointer(cardLeft, "pointermove", 61); // |61-100| = 39
  dispatchPointer(cardLeft, "pointerup", 61);
  cardLeft.dispatchEvent(
    new window.Event("click", { bubbles: true, cancelable: true }),
  );
  await settle();

  const cardRight = container.querySelector(`[data-memo-id="${idRight}"]`);
  dispatchPointer(cardRight, "pointerdown", 100);
  dispatchPointer(cardRight, "pointermove", 139); // |139-100| = 39
  dispatchPointer(cardRight, "pointerup", 139);
  cardRight.dispatchEvent(
    new window.Event("click", { bubbles: true, cancelable: true }),
  );
  await settle();

  assert.deepEqual(
    cardIds(container).sort(),
    [idLeft, idRight].sort(),
    "39px 는 좌우 모두 스와이프가 아니라 둘 다 남아있어야 한다",
  );
  assert.deepEqual(
    opened.sort(),
    [idLeft, idRight].sort(),
    "39px 뒤의 click 은 둘 다 onOpen 을 불러야 한다(탭으로 처리)",
  );
});

test("스와이프 문턱 40px(경계): 좌우 모두 스와이프로 삭제된다(P3-2 닫힘, G1 생존)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const idLeft = await createMemoAt(adapter, "40px 왼쪽", 100);
  const idRight = await createMemoAt(adapter, "40px 오른쪽", 200);
  const clock = makeFakeClock();
  const { list } = makeList(container, adapter, clock);
  await list.refresh();

  const cardLeft = container.querySelector(`[data-memo-id="${idLeft}"]`);
  dispatchPointer(cardLeft, "pointerdown", 100);
  dispatchPointer(cardLeft, "pointermove", 60); // |60-100| = 40
  dispatchPointer(cardLeft, "pointerup", 60);
  await settle();
  assert.deepEqual(
    cardIds(container),
    [idRight],
    "40px 왼쪽 이동은 삭제돼야 한다",
  );

  const cardRight = container.querySelector(`[data-memo-id="${idRight}"]`);
  dispatchPointer(cardRight, "pointerdown", 100);
  dispatchPointer(cardRight, "pointermove", 140); // |140-100| = 40
  dispatchPointer(cardRight, "pointerup", 140);
  await settle();
  assert.deepEqual(cardIds(container), [], "40px 오른쪽 이동도 삭제돼야 한다");
});

// 책임자 판정 §2 풀어 쓴 요구 3-⑶(P3-3 닫힘, E2 생존 대상): graceMs 전달
// 줄이 지워지면(lifecycle 이 자신의 내부 기본값으로 떨어짐) 데이터 계층
// 기본값과 "우연히 같은 숫자"라 타이밍만으로는 못 가른다(검토 2R §6
// P3-3). createLifecycle 주입 지점에 스파이를 꽂아 "실제로 전달된 값" 을
// 직접 관찰한다 -- 이 전달 줄이 지워지면 options.graceMs 가 undefined
// 가 되어 UNDO_TOAST_MS 와 달라진다(데이터 계층 기본값이 몇이든 무관).
test("graceMs 전달 고정: createLifecycle 에 UNDO_TOAST_MS 가 명시로 전달된다(P3-3 닫힘)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  await createMemoAt(adapter, "graceMs 관찰용 메모", 100);
  const clock = makeFakeClock();
  let capturedOptions = null;
  const spyCreateLifecycle = (innerAdapter, options) => {
    capturedOptions = options;
    return createSoftDeleteLifecycle(innerAdapter, options);
  };
  const { list } = makeList(container, adapter, clock, {
    createLifecycle: spyCreateLifecycle,
  });
  await list.refresh();

  assert.ok(capturedOptions, "createLifecycle 이 호출돼야 한다");
  assert.equal(
    capturedOptions.graceMs,
    UNDO_TOAST_MS,
    "graceMs 는 UNDO_TOAST_MS 와 명시로 같은 값이 전달돼야 한다(이 줄이 지워지면 undefined 가 되어 실패한다)",
  );
});

// 책임자 판정 §2 풀어 쓴 요구 3-⑷(P3-4 닫힘, F2 생존 대상): 2회 연속
// 저장 실패에도 오류 표시는 토스트 영역 안에서 "하나만"(버튼 중복 생성
// 없음) 유지된다 -- 지금 구조는 errorButton 하나를 계속 재사용하므로
// append 로 중복 생성하던 1R/2R-pre 구조의 회귀를 버튼 개수로 고정한다.
test("저장 실패 2회 연속: 토스트 영역의 오류 표시는 항상 하나만 남는다(P3-4 닫힘)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "연속 실패 메모", 100);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  adapter.forceNextPutFailures(1);
  swipe(container.querySelector(`[data-memo-id="${id}"]`));
  await settle();
  await settle();
  assert.equal(toast.errorButton.hidden, false);

  adapter.forceNextPutFailures(1);
  toast.errorButton.click();
  await settle();
  await settle();

  assert.equal(
    toast.errorButton.hidden,
    false,
    "2회 연속 실패 뒤에도 오류 버튼이 보여야 한다",
  );
  assert.equal(
    toast.element.querySelectorAll("button").length,
    2,
    "토스트 영역의 버튼은 되돌리기 1 + 오류 1 = 2개로 고정이어야 한다(중복 생성 없음)",
  );
});

// 책임자 판정 §2 풀어 쓴 요구 3-⑸(P3-5 닫힘, F6 생존 대상): 책임자 결정
// ④ 문구를 상수 비교가 아니라 "문자열 리터럴"로 고정한다 -- SAVE_ERROR_
// MESSAGE 상수 값 자체가 바뀌는 변이(F6)에도 이 시험은 상수를 다시
// import 해 비교하지 않으므로 그대로 걸린다.
test("저장 실패 문구는 책임자 결정④ 글자 그대로 고정된다(F6 생존·P3-5 닫힘)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "문구 확인 메모", 100);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  adapter.forceNextPutFailures(1);
  swipe(container.querySelector(`[data-memo-id="${id}"]`));
  await settle();
  await settle();

  assert.equal(
    toast.errorButton.textContent,
    "저장에 실패했어요. 다시 시도해 주세요",
    "책임자 결정④ 문구 리터럴과 글자 그대로 같아야 한다",
  );
});
