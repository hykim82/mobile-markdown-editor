// HYK-304-gone-held-priority-1-r2(§2 요구 4, P3-2 한계 문단 정정):
// 1R 결과 파일은 "fake-indexeddb 에 put 실패 훅이 없어 번들(app.mjs)
// 위에서는 진짜 held(저장 실패) 표시를 재는 길이 없다"고 적었다
// (〔못쟀다〕) -- 검토 1R §2 ⓔ 가 그 정정을 지적한다: app-wiring.
// test.mjs 배선 7 이 이미 같은 방식(IDBObjectStore.prototype.put 을
// 1회 throw 하도록 몽키패치)으로 번들 위에서 진짜 저장 실패를 재고
// 있으므로, 이 조각도 같은 방법을 그대로 쓰면 된다. 이 파일은 그
// 정정을 값으로 증명한다 -- 실제 app.mjs 번들(test/support/
// app-harness.mjs 의 bootApp)과 실물 public/index.html 위에서 ⑴ held
// 우선(§2 요구 1, 다른 id 의 끼어듦은 막는다)과 ⑵ 같은 id 의
// held→gone 전환(§2 요구 2, r2 신규)이 둘 다 유지되는지를 잰다.
//
// 제품 코드 변경은 이 파일에 없다(coder-task.md §2 product_scope:
// "번들 경로 칸은 새 시험 파일 1 허용") -- memo-list-delete-undo.
// test.mjs 의 jsdom 합성 시험과 같은 사실을 "실제 번들 결선" 위에서
// 한 번 더 값으로 잰다(배선 7 과 같은 이유, app-wiring.test.mjs 머리
// 주석 참고).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootApp, waitFor } from "../support/app-harness.mjs";
import { createIndexedDbAdapter } from "../../src/storage/indexeddb-adapter.mjs";
import { IDBObjectStore } from "fake-indexeddb";

const SAVE_ERROR_MESSAGE_LITERAL = "저장에 실패했어요. 다시 시도해 주세요";

async function seedMemo(id, body) {
  const adapter = createIndexedDbAdapter();
  await adapter.put({
    id,
    title: body,
    body,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
}

// app-wiring.test.mjs 의 swipeCard 와 같은 모양(SWIPE_THRESHOLD_PX=40
// 을 넘기는 왼쪽 이동) -- 그 파일을 import 하지 않고 그대로 옮겨 적는다
// (coder-task.md §2 product_scope: 새 시험 파일 1 안에서 자급).
function swipeCard(dom, card) {
  const { window } = dom;
  const fire = (type, clientX) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clientX", { value: clientX });
    card.dispatchEvent(event);
  };
  fire("pointerdown", 100);
  fire("pointermove", 20);
  fire("pointerup", 20);
}

function settleMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("번들 결선(P3-2 정정): held 우선(다른 id 유지) + 같은 id 의 held→gone 전환이 다른 메모 성공으로 닫힌다", async () => {
  const idHeld = "gone-held-bundle-held";
  const idGone = "gone-held-bundle-gone";
  const idOther = "gone-held-bundle-other";

  const dom = await bootApp({
    seed: async () => {
      await seedMemo(idHeld, "진짜 저장 실패(번들 P3-2)");
      await seedMemo(idGone, "끼어드는 이미 없는 메모(번들 P3-2)");
      await seedMemo(idOther, "다른 메모(성공, 번들 P3-2)");
    },
  });
  const { document } = dom.window;
  await waitFor(() => document.querySelectorAll(".memo-card").length === 3);

  // A(idHeld) 스와이프 -> 정상 되돌리기 토스트(아직 실패 없음).
  const cardHeld = document.querySelector(`[data-memo-id="${idHeld}"]`);
  swipeCard(dom, cardHeld);
  await waitFor(
    () => document.getElementById("list-delete-toast").hidden === false,
  );

  // A 의 되돌리기 저장을 실제로 거부시킨다(IDBObjectStore.prototype.put
  // 1회 throw, app-wiring.test.mjs 배선 7 과 같은 몽키패치 방식) --
  // 진짜 저장 실패(goneRestore:false)를 번들 위에서 만든다(P3-2 정정의
  // 핵심 -- 1R 은 이 방법이 없다고 적었다).
  const originalPut = IDBObjectStore.prototype.put;
  let failuresLeft = 1;
  IDBObjectStore.prototype.put = function patchedPut(...args) {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("gone-held-priority-bundle: A 되돌리기 강제 실패(held)");
    }
    return originalPut.apply(this, args);
  };
  try {
    document.getElementById("list-delete-undo-button").click();
    await waitFor(
      () => document.getElementById("list-save-error-button").hidden === false,
    );
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.equal(
    document.getElementById("list-save-error-button").textContent,
    SAVE_ERROR_MESSAGE_LITERAL,
    "전제: A 의 진짜 저장 실패(held) 표시가 떠야 한다",
  );

  // B(idGone) 를 스와이프해 되돌리기 토스트를 그쪽으로 옮긴 뒤, 레코드를
  // 직접 제거해 "이미 없는 메모"로 만들고 되돌리기를 눌러 A 의 held
  // 표시를 밀어내려 한다(다른 id 의 끼어듦 -- held 우선이 지켜져야
  // 한다, §2 요구 1).
  const cardGone = document.querySelector(`[data-memo-id="${idGone}"]`);
  swipeCard(dom, cardGone);
  await waitFor(
    () => document.getElementById("list-delete-undo-button").hidden === false,
  );

  const sideAdapter = createIndexedDbAdapter();
  await sideAdapter.remove(idGone);
  document.getElementById("list-delete-undo-button").click();
  await settleMs(80);

  assert.equal(
    document.getElementById("list-save-error-button").hidden,
    false,
    "B(다른 id) 의 끼어듦 뒤에도 A 의 held 표시는 그대로 떠 있어야 한다(held 우선, 번들 위에서 재확인)",
  );
  assert.equal(
    document.getElementById("list-save-error-button").textContent,
    SAVE_ERROR_MESSAGE_LITERAL,
    "표시 문구도 바뀌지 않아야 한다",
  );

  // A 자신의 레코드도 저장소에서 직접 사라졌다고 흉내낸다(예: 동시
  // 정리) -- A 자신의 재시도(같은 id)는 held 우선에 막히면 안 되고
  // goneRestore 표시로 전환돼야 한다(§2 요구 2, r2 신규).
  await sideAdapter.remove(idHeld);
  document.getElementById("list-save-error-button").click();
  await settleMs(80);
  assert.equal(
    document.getElementById("list-save-error-button").hidden,
    false,
    "A 자신의 held→gone 전환 뒤에도 표시는 그대로 떠 있어야 한다(아직 안 닫힘, 전환은 내부 상태만 바뀐다)",
  );

  // C(idOther) 를 스와이프해 성공시킨다 -- A 의 표시가 goneRestore 로
  // 정상 전환됐다면 이 성공 조작(clearGoneRestoreOnSuccess)으로
  // 닫혀야 한다(r2 수정의 핵심 관찰을 번들 위에서 값으로 잰다).
  const cardOther = document.querySelector(`[data-memo-id="${idOther}"]`);
  swipeCard(dom, cardOther);
  await waitFor(
    () => document.getElementById("list-save-error-button").hidden === true,
    { timeout: 3000 },
  );
});

// HYK-304-e10-p3-cleanup-1 P3-1(검토 변이 a · r2inv): 위 칸의 "held 우선"
// 단언은 "표시가 떠 있다 · 문구가 같다"뿐이다 -- gone(B)의 표시로 실제로
// 덮어써져도 문구·가시성은 held(A)와 똑같으므로(둘 다 SAVE_ERROR_MESSAGE_
// LITERAL), 그 변이에서도(held 우선 분기를 통째로 지운 변이 a · id 비교를
// 뒤집은 변이 r2inv) 이 칸은 초록으로 남는다. 이 칸은 "표시가 실제로
// 가리키는 메모"가 A 인지를 되돌리기 대상으로 가른다: 재시도(재시도 put
// 패치는 이미 풀려 있다)를 누르면 held(A) 라면 A 자신의 레코드가 복원돼
// 카드가 돌아오고 표시가 닫혀야 하고, gone(B) 로 덮어써졌다면 B 는 이미
// 없는 레코드라 재시도가 다시 null 을 돌려줘 표시가 그대로 B 를 가리킨
// 채 떠 있어야 한다(A 카드는 돌아오지 않는다).
test("번들 결선(held 판별력): B 의 끼어듦 뒤 재시도가 A 를 복원한다(held 우선이 실제로 A 를 추적함을 되돌리기 대상으로 가른다)", async () => {
  const idHeld = "gone-held-bundle-held-id-check";
  const idGone = "gone-held-bundle-gone-id-check";

  const dom = await bootApp({
    seed: async () => {
      await seedMemo(idHeld, "진짜 저장 실패(번들 held 판별력)");
      await seedMemo(idGone, "끼어드는 이미 없는 메모(번들 held 판별력)");
    },
  });
  const { document } = dom.window;
  await waitFor(() => document.querySelectorAll(".memo-card").length === 2);

  // A(idHeld) 스와이프 -> 되돌리기를 실제로 거부시켜(IDBObjectStore.
  // prototype.put 1회 throw) 진짜 저장 실패(held, goneRestore:false)를
  // 만든다.
  const cardHeld = document.querySelector(`[data-memo-id="${idHeld}"]`);
  swipeCard(dom, cardHeld);
  await waitFor(
    () => document.getElementById("list-delete-toast").hidden === false,
  );

  const originalPut = IDBObjectStore.prototype.put;
  let failuresLeft = 1;
  IDBObjectStore.prototype.put = function patchedPut(...args) {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error(
        "gone-held-priority-bundle(판별력): A 되돌리기 강제 실패(held)",
      );
    }
    return originalPut.apply(this, args);
  };
  try {
    document.getElementById("list-delete-undo-button").click();
    await waitFor(
      () => document.getElementById("list-save-error-button").hidden === false,
    );
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }

  // B(idGone) 를 스와이프해 레코드를 직접 제거(이미 없는 메모)하고
  // 되돌리기를 눌러 A 의 held 표시를 밀어내려 한다(다른 id 의 끼어듦).
  const cardGone = document.querySelector(`[data-memo-id="${idGone}"]`);
  swipeCard(dom, cardGone);
  await waitFor(
    () => document.getElementById("list-delete-undo-button").hidden === false,
  );
  const sideAdapter = createIndexedDbAdapter();
  await sideAdapter.remove(idGone);
  document.getElementById("list-delete-undo-button").click();
  await settleMs(80);

  assert.equal(
    document.getElementById("list-save-error-button").hidden,
    false,
    "전제: B 의 끼어듦 뒤에도 표시는 그대로 떠 있어야 한다",
  );

  // 판별 지점: 재시도를 누른다(A 의 put 패치는 이미 풀려 있으므로, 표시가
  // 정말 A 를 가리킨다면 이번엔 성공해 A 카드가 돌아오고 표시가 닫힌다).
  document.getElementById("list-save-error-button").click();
  await waitFor(
    () => document.querySelector(`[data-memo-id="${idHeld}"]`) !== null,
    { timeout: 3000 },
  );
  assert.equal(
    document.getElementById("list-save-error-button").hidden,
    true,
    "재시도가 A(held) 의 복원을 실제로 불러야 표시가 닫힌다 -- held 우선이 깨져 표시가 B(gone) 를 가리키면 재시도가 다시 null 을 돌려줘 표시가 닫히지 않는다(변이 a · r2inv 가 이 칸을 RED 로 만든다)",
  );
});
