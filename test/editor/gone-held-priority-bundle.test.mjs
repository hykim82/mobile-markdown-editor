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
