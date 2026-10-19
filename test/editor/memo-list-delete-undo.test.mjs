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
import {
  createSoftDeleteLifecycle,
  GRACE_MS,
} from "../../src/storage/memo-lifecycle.mjs";
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

// r3: now 를 넘기지 않으면 lifecycle 의 "남은 유예" 재계산(restore 실패
// 분기 · releasePending)이 실제 벽시계(Date.now)를 본다 -- 이 시험
// 파일의 가짜 시계(clock.advance)는 그 실제 시간엔 영향을 못 주므로,
// 대부분의 시험(바로 holdPending/cancelPending 이 뒤따라 그 계산값을
// 덮어쓰는 경로)에서는 숨겨져 있던 문제였다. "남은 유예"의 정확한 값
// 자체를 재는 고정 칸(P1-1·P2-1 ⓐ)에는 이 간극이 바로 드러나므로,
// memo-lifecycle.test.mjs 의 관례(now: () => Date.now(), Date 도 함께
// 모킹)와 같게 이 화면 결선에서도 now 를 가짜 시계 자신에 묶는다.
function makeList(container, adapter, clock, extra = {}) {
  const toast = makeToastElements();
  const list = mountMemoList(container, adapter, {
    onOpen: () => {},
    toast,
    now: clock.now,
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

// HYK-304-lifecycle-orphans-1-r2(책임자 판정 §2 요구 2, P2-2 ⓐⓑ 결선
// 닫힘): 바로 아래 "되돌리기 쪽 저장 실패" 시험의 재시도는 "시간이
// 지나기 전"에 일어난다 -- holdPending/releasePending 결선이 없어도
// (restore 의 실패 재예약만으로도) 그 시험은 초록이다. 여기서는 실패
// 표시가 "7초 이상" 떠 있는 동안에도 하드 삭제가 held 로 미뤄지는지를
// mount.mjs 결선(showSaveError 지점의 holdPending) 경유로 값으로 잰다 --
// 이 결선이 없으면(혹은 releasePending 결선이 없으면) 재시도를 아무리
// 늦게 눌러도 그 사이 저장소에서 먼저 지워져 재시도가 "복원 실패"로
// 끝난다.
test("되돌리기 쪽 저장 실패 표시가 7초 넘게 떠 있어도 메모는 살아있고, 그 뒤 재시도하면 복원된다(P2-2 ⓐⓑ 결선 닫힘)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(
    adapter,
    "되돌리기 저장 실패 후 오래 대기",
    100,
  );
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  swipe(container.querySelector(`[data-memo-id="${id}"]`));
  await settle();
  assert.deepEqual(cardIds(container), [], "스와이프 직후 숨겨져야 한다");

  adapter.forceNextPutFailures(1);
  toast.undoButton.click();
  await settle();
  await settle();
  assert.equal(toast.errorButton.hidden, false, "저장 실패 표시가 떠야 한다");

  // 실패 표시가 떠 있는 동안 UNDO_TOAST_MS(=GRACE_MS) 를 넘겨 흘려보낸다
  // -- hold 결선이 없으면 이 사이에 저장소에서 하드 삭제된다.
  clock.advance(UNDO_TOAST_MS + 1000);
  await settle();
  assert.ok(
    await adapter.get(id),
    "실패 표시가 떠 있는 동안은 7초가 넘어도 메모가 저장소에서 지워지면 안 된다(ⓐ 결선)",
  );

  toast.errorButton.click();
  await settle();
  await settle();

  assert.deepEqual(
    cardIds(container),
    [id],
    "늦게 재시도해도 성공하면 복원돼야 한다(ⓑ 결선)",
  );
  const record = await adapter.get(id);
  assert.equal(record.deletedAt, null, "삭제시각이 null 로 복원돼야 한다");
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

// HYK-304-first-run-notice-1(coder-task.md §2-5, 책임자 판정 원문
// 2026-10-15 18:0x §3 "함께 1칸 = E1-후속 P3-1" -- 관제실
// 아카이브\2026-10-15-B76-에디터-삭제UI후속\pr38-review\rounds\REVIEW-r2.md
// §3 P3-1): H1 생존 시험(바로 위)은 "B 의 되돌리기 버튼을 눌러서" 살아
// 있는지를 잰다. 이 칸은 다른 축 -- A 재시도 뒤 "누르지 않고" 가짜
// 시계를 UNDO_TOAST_MS 만큼 그대로 흘려보내 B 의 자동 숨김 타이머
// 자체가 살아있는지를 잰다. memo-list-mount.mjs 의 handler 안
// `if (toastCtrl.isActiveUndo(id)) { ...; cancelFn(hideTimer); }` 가드가
// 없어지면(변이 N6, 아래) A 의 재시도(handler 재호출)가 "자기 것이
// 아닌"(지금은 B 소유) hideTimer 까지 무조건 취소해 버린다 -- 그러면
// B 의 토스트는 7초가 지나도 자동으로 숨지 않는다(사용자 관점: 되돌리기
// 창이 설명 없이 계속 열려 있음). 제품 코드는 고치지 않는다(0줄).
test("되돌리기 재시도가 다른 메모(B)의 자동 숨김 타이머를 끊지 않는다(§2-5, N6 생존 대상)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const idA = await createMemoAt(
    adapter,
    "메모 A(되돌리기 실패 후 재시도, §2-5)",
    100,
  );
  const idB = await createMemoAt(adapter, "메모 B(자동 숨김 관찰, §2-5)", 200);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  // A 스와이프 → A 되돌리기 put 1회 거부(A 실패 표시).
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

  // B 스와이프 성공(B 토스트가 떠서 자동 숨김 타이머가 돈다).
  swipe(container.querySelector(`[data-memo-id="${idB}"]`));
  await settle();
  assert.equal(
    toast.undoButton.hidden,
    false,
    "B 삭제 뒤 되돌리기 버튼이 보여야 한다",
  );
  assert.equal(toast.element.dataset.memoId, idB);

  // A 재시도(버튼 클릭 -- A 는 복원되지만, B 의 되돌리기/자동 숨김
  // 타이머는 끊기면 안 된다).
  toast.errorButton.click();
  await settle();
  await settle();
  assert.deepEqual(
    cardIds(container).includes(idA),
    true,
    "A 는 재시도로 복원돼야 한다",
  );

  // B 의 되돌리기 버튼을 누르지 않고, 가짜 시계만 UNDO_TOAST_MS 만큼
  // 그대로 흘려보낸다 -- B 의 자동 숨김 타이머가 살아있다면 정상적으로
  // 토스트·되돌리기 버튼이 숨겨져야 한다.
  clock.advance(UNDO_TOAST_MS);
  assert.equal(
    toast.element.hidden,
    true,
    "B 의 자동 숨김 타이머가 살아있다면 UNDO_TOAST_MS 뒤 토스트는 숨겨져야 한다(A 재시도가 끊으면 안 된다)",
  );
  assert.equal(
    toast.undoButton.hidden,
    true,
    "같은 이유로 되돌리기 버튼도 숨겨져야 한다",
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

// HYK-304-lifecycle-orphans-1-r2(책임자 판정 §2 요구 4, P3-1 ⑵ "한 원천"
// 양방향): 위 memo-list-mount.mjs 머리 주석 정정(§2-4)이 말하는 "GRACE_MS
// 와 UNDO_TOAST_MS 는 같은 값을 따로 든다"를 양방향으로 직접 단언한다 --
// 지금까지의 시험(graceMs 전달 고정·6999/7000 경계)은 "UNDO_TOAST_MS 가
// createLifecycle 에 그대로 전달되는지"만 보고, 데이터 계층의 GRACE_MS
// 리터럴 자체와는 비교하지 않았다(검토 2R P3-1: M2a 처럼 GRACE_MS 만
// 줄이는 변이는 그 시험을 통과한다 -- 한쪽 방향만 걸린다). 이 시험은
// 두 상수를 직접 import 해 비교하므로, 둘 중 하나만 바꾸는 변이(W5:
// UNDO_TOAST_MS 만 7001) 모두 RED 가 된다.
test('"한 원천" 양방향: GRACE_MS(데이터 계층)와 UNDO_TOAST_MS(이 화면)는 같은 값이어야 한다(P3-1 ⑵, W5 가 이 칸을 RED 로 만든다)', () => {
  assert.equal(
    UNDO_TOAST_MS,
    GRACE_MS,
    "둘 중 하나만 바뀌면(기본값 어긋남) 이 칸이 바로 걸려야 한다 -- 한쪽만 보는 간접 시험(graceMs 전달 고정 등)으로는 못 가른다",
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

// HYK-304-lifecycle-orphans-1-r3(§2 요구 1·6, 고정 칸 -- mount 경유 +
// 가짜 시계가 lifecycle 의 now 까지 몲): 검토 2R F2 재현을 실제 화면
// 결선(toast.undoButton/errorButton) 위에서 잰다. 3000 에 되돌리기 put
// 실패(남은 유예(4000)로 정상 재예약 + mount holdPending) → 10000 에
// 재시도 put 재실패(이 시점 남은 유예는 이미 음수 -- r2 는 여기서 동기로
// 지웠다) → 메모는 살아있고 실패 표시가 유지돼야 한다 → 그 뒤 재시도가
// 성공하면 복원되고(목록·deletedAt===null), 그 뒤로 남은 타이머가 없어야
// 한다(한참 더 흘려보내도 안 지워짐).
test("고정 칸: 3000 에 되돌리기 put 실패 → 10000 에 재시도 put 재실패해도 메모 생존·표시 유지 → 재시도 성공으로 복원(P1-1, 기준선 474530e 에서 RED)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "P1-1 고정 칸 메모", 100);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  swipe(container.querySelector(`[data-memo-id="${id}"]`));
  await settle();
  assert.deepEqual(cardIds(container), [], "스와이프 직후 숨겨져야 한다");

  clock.advance(3000); // t=3000
  adapter.forceNextPutFailures(1);
  toast.undoButton.click(); // 1차 되돌리기 시도, put 실패(남은 유예 4000 > 0)
  await settle();
  await settle();
  assert.equal(toast.errorButton.hidden, false, "1차 실패 표시가 떠야 한다");
  assert.ok(await adapter.get(id), "1차 실패 뒤에도 메모는 살아있어야 한다");

  clock.advance(7000); // t=10000(원래 마감 7000 을 이미 지남)
  adapter.forceNextPutFailures(1);
  toast.errorButton.click(); // 2차 재시도, put 재실패(이 시점 남은 유예는 이미 음수)
  await settle();
  await settle();
  assert.ok(
    await adapter.get(id),
    "남은 유예가 이미 음수로 떨어진 채 재시도가 또 실패해도 메모가 동기로 지워지면 안 된다(P1-1)",
  );
  assert.equal(
    toast.errorButton.hidden,
    false,
    "실패 표시가 그대로 유지돼야 한다",
  );
  assert.deepEqual(
    cardIds(container),
    [],
    "아직 복원되지 않았으니 카드는 안 보여야 한다",
  );

  toast.errorButton.click(); // 3차 재시도, 이번엔 성공
  await settle();
  await settle();

  assert.deepEqual(
    cardIds(container),
    [id],
    "재시도 성공으로 목록에 복원돼야 한다",
  );
  const record = await adapter.get(id);
  assert.equal(record.deletedAt, null, "삭제시각이 null 로 복원돼야 한다");

  clock.advance(100000); // 남은 타이머가 없어야 한다 -- 있었다면 이 사이에 지워졌을 것
  await settle();
  const after = await adapter.get(id);
  assert.ok(after, "복원 뒤에는 남아있는 하드 삭제 타이머가 없어야 한다");
  assert.equal(after.deletedAt, null);
});

// HYK-304-lifecycle-orphans-1-r3(§2 요구 1 동반, P1-1 동반): memo-lifecycle.mjs
// 의 restore 는 이미 없는 메모엔 거부가 아니라 "조용히 null"을 돌려준다
// -- 이 null 을 체크하지 않으면 mount 가 "복원됐다"처럼 목록을 갱신하고
// 실패 표시를 지운다. 레코드가 실제로 이미 사라진 상황(예: 동시 정리)을
// 직접 흉내내 재시도가 성공처럼 보이지 않는지를 잰다.
test("P1-1 동반: 이미 사라진 메모의 되돌리기 재시도는 '복원됐다'로 보이지 않고 실패 표시를 유지한다", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "이미 사라진 메모", 100);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  swipe(container.querySelector(`[data-memo-id="${id}"]`));
  await settle();
  assert.deepEqual(cardIds(container), [], "스와이프 직후 숨겨져야 한다");

  // 레코드가 이미 저장소에서 사라진 상황을 직접 흉내낸다(되돌리기 토스트
  // 는 아직 떠 있는 채로).
  await adapter.remove(id);

  toast.undoButton.click();
  await settle();
  await settle();

  assert.deepEqual(
    cardIds(container),
    [],
    "이미 없는 메모를 '복원됐다'처럼 목록에 되살리면 안 된다",
  );
  assert.equal(
    toast.errorButton.hidden,
    false,
    "이미 사라진 메모의 재시도는 성공 처리 대신 실패 표시를 유지해야 한다(P1-1 동반)",
  );
  assert.equal(
    toast.element.hidden,
    false,
    "토스트 영역 자체도 숨겨지면 안 된다(성공으로 위장하면 전체가 숨는다)",
  );
});

// HYK-304-notice-polish-1(§2-1, E3 P2-1 · 검토 3R §3 지적): 바로 위
// "P1-1 동반" 시험이 보인 실패 표시는 재시도로도, 시간이 지나도, 다른
// 메모의 되돌리기 "성공"으로도 닫히지 않았다(검토 3R MP-null `[true,
// true,true,true]` · `afterSwipeOkB=true`) -- 벗어나는 길이 전혀 없으면
// 사용자가 갇힌다. 여기서는 "다른 메모의 스와이프 삭제 성공"에서 그
// 표시가 닫히는지를 mount 경유로 잰다(MP-null 모양: 레코드 삭제 →
// 되돌리기 → 표시 뜸 → 다른 메모 스와이프 성공 → 표시 닫힘). 새 문구는
// 0 이다(기존 SAVE_ERROR_MESSAGE 그대로, 아래 textContent 로 재확인).
// ⚠️"다른 메모의 되돌리기 성공"(계약 §2-1 의 또 다른 예시)도 코드상
// 같은 clearGoneRestoreOnSuccess() 호출(memo-list-mount.mjs 의 handler
// 성공 분기)로 닫히지만, 이 mount 는 되돌리기 토스트 슬롯이 하나뿐이라
// "다른 메모를 되돌릴 수 있는 상태로" 만드는 유일한 길(스와이프)이 그
// 자체로 스와이프 성공 분기를 먼저 태워 이 표시를 닫아버린다 -- 그래서
// "되돌리기 성공만" 분리해 mount 경유로 재현하지 못한다(〔못쟀다〕, 결과
// 파일 §한계). 두 분기가 같은 함수를 부른다는 것은 코드 읽기로 확인했다.
test("E3 P2-1: 이미 없는 메모의 실패 표시는 다른 메모의 스와이프 삭제 성공에서 닫힌다", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const idGone = await createMemoAt(adapter, "이미 사라진 메모(닫힘 칸)", 100);
  const idOther = await createMemoAt(adapter, "다른 메모(스와이프 성공)", 200);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  swipe(container.querySelector(`[data-memo-id="${idGone}"]`));
  await settle();
  await adapter.remove(idGone); // 되돌리기 전에 레코드가 이미 사라진 상황

  toast.undoButton.click();
  await settle();
  await settle();
  assert.equal(
    toast.errorButton.hidden,
    false,
    "전제: 이미 없는 메모의 되돌리기는 실패 표시를 띄워야 한다",
  );
  assert.equal(
    toast.errorButton.textContent,
    SAVE_ERROR_MESSAGE,
    "새 문구 없이 기존 SAVE_ERROR_MESSAGE 를 그대로 재사용해야 한다",
  );

  // 다른 메모(idOther)를 스와이프해 삭제 성공시킨다 -- 이 성공 조작이
  // "이미 없는 메모" 표시를 닫아야 한다.
  swipe(container.querySelector(`[data-memo-id="${idOther}"]`));
  await settle();
  await settle();

  assert.equal(
    toast.errorButton.hidden,
    true,
    "다른 메모의 스와이프 삭제 성공에서 '이미 없는 메모' 표시가 닫혀야 한다(E3 P2-1)",
  );
});

// HYK-304-notice-polish-1(§2-1 경계, E3 P2-1 · 검토 3R 판정 보존): 위
// 칸과 짝을 이루는 경계 칸 -- "진짜" 저장 실패(held, goneRestore 가
// 아님)는 다른 메모의 성공 조작으로 닫히면 안 된다(판정 "실패 표시 중
// hard delete 미룸" 보존). clearGoneRestoreOnSuccess 가 goneRestore 가
// 아닌 errorState 를 건너뛰는지를 직접 잰다.
test("E3 P2-1 경계: 진짜 저장 실패(held) 표시는 다른 메모의 성공 조작에도 닫히지 않는다", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const idHeld = await createMemoAt(adapter, "진짜 저장 실패(held)", 100);
  const idOther = await createMemoAt(adapter, "다른 메모(성공)", 200);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  swipe(container.querySelector(`[data-memo-id="${idHeld}"]`));
  await settle();
  adapter.forceNextPutFailures(1);
  toast.undoButton.click(); // 진짜 put 거부 -- goneRestore 가 아니다
  await settle();
  await settle();
  assert.equal(
    toast.errorButton.hidden,
    false,
    "전제: 진짜 저장 실패 표시가 떠야 한다",
  );

  swipe(container.querySelector(`[data-memo-id="${idOther}"]`));
  await settle();
  await settle();

  assert.equal(
    toast.errorButton.hidden,
    false,
    "진짜 저장 실패(held) 표시는 다른 메모의 성공 조작으로 닫히면 안 된다(E3 P2-1 경계)",
  );
  assert.ok(
    await adapter.get(idHeld),
    "held 중인 메모는 다른 메모의 성공과 무관하게 저장소에서도 살아있어야 한다",
  );
});

// HYK-304-lifecycle-orphans-1-r3(§2 요구 3, P2-1 ⓐ 판정 + P3-1 해제
// 지점): A 의 실패 표시가 떠 있는 동안(held) B 의 저장 실패가 그 표시를
// 덮어쓰면, A 는 "해소"로 보고 유예를 재개한다(원래 마감 기준). A 의
// 레코드는 B 에게 자리를 "내준" 뒤부터는 toastCtrl 밖에서(값으로) 계속
// 추적해야 한다 -- A 는 원래 마감(7000)에 그대로 사라지고, B 는(자기
// 자신의 재시도 실패로 held) 그 사이 지워지지 않아야 한다.
test("P2-1 ⓐ: 다른 메모의 저장 실패가 표시를 덮어쓰면 그 메모의 유예가 재개돼 원래 마감에 사라진다(P3-1 해제 지점)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const idA = await createMemoAt(adapter, "A(덮어써짐)", 100);
  const idB = await createMemoAt(adapter, "B(덮어씀)", 200);
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  // A 스와이프(t=0) → A 되돌리기 put 1회 거부(t=1000) → A 실패 표시(held).
  swipe(container.querySelector(`[data-memo-id="${idA}"]`));
  await settle();
  clock.advance(1000); // t=1000
  adapter.forceNextPutFailures(1);
  toast.undoButton.click();
  await settle();
  await settle();
  assert.equal(toast.errorButton.hidden, false, "A 실패 표시가 떠야 한다");

  // B 스와이프(t=1000) → B 토스트(되돌리기 버튼)가 뜨고, A 의 실패
  // 표시와 공존한다(기존 공존 동작, 요구 ⓑ).
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
    "A 의 실패 표시는 그대로 남아있어야 한다",
  );

  // B 의 되돌리기도 put 1회 거부 → B 실패 표시가 A 의 자리를 "덮어쓴다"
  // (errorState.id 가 A -> B 로 바뀜 -- 여기서 A 가 해소·release 된다).
  clock.advance(2000); // t=3000
  adapter.forceNextPutFailures(1);
  toast.undoButton.click();
  await settle();
  await settle();
  assert.equal(
    toast.errorButton.hidden,
    false,
    "B 의 실패 표시가 떠야 한다(덮어씀)",
  );

  // A 는 "원래 마감"(deletedAt(0)+graceMs(7000)=7000) 기준으로 재개돼야
  // 한다 -- 지금 t=3000, 남은 시간 4000ms.
  clock.advance(3999); // t=6999
  await settle();
  assert.ok(
    await adapter.get(idA),
    "A 는 6999ms 까지는 살아있어야 한다(덮어쓰기로 재개된 유예, 경계 -1ms)",
  );

  clock.advance(1); // t=7000
  await settle();
  assert.equal(
    await adapter.get(idA),
    undefined,
    "A 는 덮어쓰기로 유예가 재개돼 원래 마감(7000ms)에 하드 삭제된다(P2-1 ⓐ · P3-1 해제 지점)",
  );

  // ⚠️검토 3R P3-3(HYK-304-notice-polish-1 §2-6ⓓ) 교정: B 는 자기 마감
  // (deletedAt(1000)+graceMs(7000)=8000)이 t=7000 에는 아직 지나지 않아,
  // 이 시점의 "생존" 은 hold 와 무관하게 참이다(헛단언). hold 가 실제로
  // 효과가 있는지는 B 의 "자기 마감 뒤"(예: 20000)에 재야 값으로 걸린다
  // -- M12(mount catch 의 holdPending 제거)가 이 재측정에서만 RED 다.
  clock.advance(13000); // t=20000(B 자기 마감 8000 을 한참 지남)
  await settle();
  assert.ok(
    await adapter.get(idB),
    "B 는 자기 마감(8000)을 한참 지난 20000ms 에도 held 유지 중이라 A 의 해제와 무관하게 살아있어야 한다(P3-3 교정)",
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

// HYK-304-gone-held-priority-1(§2 요구 1, 관찰 1 닫힘 -- 검토 아카이브
// D:\문서관리\하네스-관제실\아카이브\2026-10-17-B76-에디터-알림다듬기E5\
// pr42-review\review.md §3 "관찰 · 상신 대상" PR-3 모양): 진짜 저장
// 실패(held, B)가 떠 있는 동안 느린 저장소 끼어들기로 "이미 없는 메모"
// (A)의 되돌리기 요청이 끼어들면, 예전에는 A 의 표시가 B 를 덮어
// onErrorOverwritten(B) 로 B 의 유예가 재개됐고(§2-1 ⓐ 와 같은 경로),
// 그 뒤 다른 메모(C) 성공이 A 표시를 닫으며 B 는 재시도 수단 없이
// 원래 마감에 사라질 수 있었다(검토 §3 실측 `heldShown:true,
// afterC:true,bAliveAfter30s:false`). 이 칸은 그 반대 -- B 가 끝까지
// 덮이지 않는지를 값으로 잰다. 변이: showSaveError 의 held 우선 분기
// (위, memo-list-mount.mjs)를 제거하면 이 칸은 RED 다.
test("held 우선: 진짜 저장 실패(held) 표시는 이미 없는 메모의 끼어듦에도 덮이지 않고, 다른 메모 성공 뒤에도·가짜 시계 +30000ms 뒤에도 재시도 수단과 레코드가 살아있다(관찰 1 닫힘)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const idHeld = await createMemoAt(
    adapter,
    "진짜 저장 실패(held, 우선 칸)",
    100,
  );
  const idGone = await createMemoAt(
    adapter,
    "이미 사라진 메모(held 우선 칸)",
    200,
  );
  const idOther = await createMemoAt(
    adapter,
    "다른 메모(성공, held 우선 칸)",
    300,
  );
  const clock = makeFakeClock();
  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  // B(idHeld) 되돌리기 put 거부 -> 진짜 저장 실패(held) 표시.
  swipe(container.querySelector(`[data-memo-id="${idHeld}"]`));
  await settle();
  adapter.forceNextPutFailures(1);
  toast.undoButton.click();
  await settle();
  await settle();
  assert.equal(
    toast.errorButton.hidden,
    false,
    "전제: B 의 held 표시가 떠야 한다",
  );

  // A(idGone) 를 스와이프해 "이미 없는 메모"로 만들고(레코드 직접 제거)
  // 되돌리기를 시도해 B 의 held 표시를 밀어내려 한다(요구 1 · 관찰 1).
  swipe(container.querySelector(`[data-memo-id="${idGone}"]`));
  await settle();
  await adapter.remove(idGone);
  toast.undoButton.click(); // 지금 active undo 는 A(idGone) 를 가리킨다
  await settle();
  await settle();

  assert.equal(
    toast.errorButton.hidden,
    false,
    "A 의 끼어듦 뒤에도 표시는 그대로 떠 있어야 한다(held 우선 -- 덮이지 않는다)",
  );

  // C(idOther) 성공 조작 뒤에도 B 의 held 표시는 유지돼야 한다(E3 P2-1
  // 경계가 지키는 불변이 held 우선 칸이 추가돼도 깨지지 않아야 한다).
  swipe(container.querySelector(`[data-memo-id="${idOther}"]`));
  await settle();
  await settle();
  assert.equal(
    toast.errorButton.hidden,
    false,
    "C 의 성공 조작 뒤에도 B 의 held 표시는 유지돼야 한다",
  );

  // B 의 유예가 "재개되지 않았다"를 가짜 시계로 값으로 잰다: A 의
  // 끼어듦이 onErrorOverwritten(B) 를 그릇되게 불렀다면 B 는 "원래
  // 마감" 기준으로 재예약돼 아래 advance 사이에 하드 삭제된다. held
  // 우선이 지켜지면 B 는 hold 상태 그대로라 삭제되지 않는다.
  clock.advance(30000);
  await settle();
  assert.ok(
    await adapter.get(idHeld),
    "B 의 유예가 재개되지 않았다면(held 우선) 가짜 시계 +30000ms 뒤에도 레코드가 살아있어야 한다",
  );

  // 마지막으로 B 자신의 재시도 수단이 끝까지 B 를 가리키고 있는지(엉뚱한
  // id 로 바뀌어치기되지 않았는지)를 값으로 확인한다 -- A 의 레코드는
  // 영구히 사라졌으므로, 만약 errorState 가 A 로 바뀌어치기됐다면 이
  // 재시도는 영원히 다시 null 만 돌려줄 뿐 복원되지 않는다.
  toast.errorButton.click();
  await settle();
  await settle();
  assert.deepEqual(
    cardIds(container).includes(idHeld),
    true,
    "B 의 재시도 버튼이 끝까지 B 를 가리키고 있어야(held 우선) 재시도로 B 가 복원된다",
  );
});

// HYK-304-gone-held-priority-1(§2 요구 2, P3-1 닫힘 -- 검토 ⓑ PR-1 모양
// 재현): 검토가 지적한 "다른 메모의 되돌리기 성공" 해제 경로(위
// clearOnSuccess 호출부, handler 의 restore 성공 분기)는 mount 단독으로
// 재현 "가능"하다(작성자 1R 자인 〔못쟀다〕를 이 칸으로 정정한다, 결과
// 파일 §기록 정정). get 을 id 별로 잠시 막는 래퍼로 두 되돌리기(restore)
// 의 완료 순서를 뒤바꿔, "스와이프 성공"이 아니라 "되돌리기 성공"만으로
// 이미 없는 메모 표시가 닫히는 경로를 단독으로 태운다.
test("P3-1: 다른 메모의 '되돌리기 성공'만으로도 이미 없는 메모의 표시가 닫힌다(mount 단독, 느린 저장소 끼어들기)", async () => {
  const container = document.createElement("div");
  const baseAdapter = createFakeAdapter();
  const idGone = await createMemoAt(baseAdapter, "이미 사라진 메모(P3-1)", 100);
  const idOther = await createMemoAt(
    baseAdapter,
    "다른 메모(되돌리기 성공, P3-1)",
    200,
  );
  const clock = makeFakeClock();

  // get 을 id 별로 잠시 막는 래퍼 -- 검토 원문 PR-1 모양(실제 저장소가
  // 느릴 때 restore 가 await 하는 중에 다른 메모의 restore 가 먼저
  // 끝나는 상황을 결정적으로 재현한다). put/list/remove 는 그대로
  // baseAdapter 를 쓴다.
  const gates = new Map();
  function holdGet(id) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    gates.set(id, { gate, release });
  }
  function releaseGet(id) {
    gates.get(id)?.release();
  }
  const adapter = {
    ...baseAdapter,
    async get(id) {
      const pending = gates.get(id);
      if (pending) await pending.gate;
      return baseAdapter.get(id);
    },
  };

  const { list, toast } = makeList(container, adapter, clock);
  await list.refresh();

  // A(idGone) 스와이프 -> 레코드 직접 제거(이미 없는 메모). 지금 active
  // undo 는 A 를 가리킨다.
  swipe(container.querySelector(`[data-memo-id="${idGone}"]`));
  await settle();
  await baseAdapter.remove(idGone);

  // A 의 되돌리기를 누른다 -- get(A) 를 먼저 막아 둬서 이 restore 가
  // "아직 안 끝난" 채로 매달려 있게 한다(느린 저장소 끼어들기 흉내).
  holdGet(idGone);
  toast.undoButton.click();
  await settle();

  // B(idOther) 를 스와이프한다 -- A 의 restore 가 아직 안 끝난 사이,
  // B 는 (get 을 막지 않았으므로) 정상적으로 성공해 되돌리기 토스트로
  // 바뀐다. 이 시점엔 A 쪽도 아직 "표시"가 뜨지 않은 채다(get 대기 중).
  swipe(container.querySelector(`[data-memo-id="${idOther}"]`));
  await settle();
  assert.equal(
    toast.errorButton.hidden,
    true,
    "전제: A 의 되돌리기가 아직 안 끝났으므로 표시가 없어야 한다(errHiddenBeforeBUndo)",
  );
  assert.equal(
    toast.undoButton.hidden,
    false,
    "B 삭제 뒤 되돌리기 버튼이 보여야 한다",
  );

  // B 의 되돌리기도 누른다 -- get(B) 도 막아 둬서 A·B 두 restore 가
  // 동시에 매달려 있게 한다.
  holdGet(idOther);
  toast.undoButton.click();
  await settle();

  // A 의 get 을 먼저 풀어준다 -- A 는 이미 없는 메모이므로 restore 가
  // null 을 돌려주고, "이미 없는 메모" 표시(goneRestore:true)가 뜬다.
  releaseGet(idGone);
  await settle();
  await settle();
  assert.equal(
    toast.errorButton.hidden,
    false,
    "A 의 get 이 풀리면 이미 없는 메모 표시가 떠야 한다(goneShown)",
  );
  assert.equal(toast.errorButton.textContent, SAVE_ERROR_MESSAGE);

  // 이제 B 의 get 을 풀어준다 -- B 는 실제로 존재하는 메모라 restore 가
  // 성공하고, 그 "되돌리기 성공" 분기가(스와이프 성공이 아니라) A 의
  // 표시를 닫여야 한다(P3-1 핵심 단언).
  releaseGet(idOther);
  await settle();
  await settle();
  assert.equal(
    toast.errorButton.hidden,
    true,
    "B 의 '되돌리기 성공'(스와이프 성공이 아니다)만으로 A 의 이미 없는 메모 표시가 닫혀야 한다(P3-1, mount 단독 재현)",
  );
  const recordOther = await baseAdapter.get(idOther);
  assert.equal(
    recordOther.deletedAt,
    null,
    "B 는 되돌리기 성공으로 실제 복원돼야 한다",
  );
});
