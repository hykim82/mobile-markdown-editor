// coder-task.md §3 (P2-4): E3(PR #7) 검토가 변이 M5 로 기계 증명한 것 --
// `showScreen` 의 hidden 토글을 뒤집고 `list.refresh()` 를 주석 처리해
// 제품을 완전히 망가뜨려도 `node --test` 는 522건 전량 초록이었다. 이
// 파일은 app.mjs(브라우저 엔트리, main() 부수효과 있음)를 test/support/
// app-harness.mjs 로 실제 부팅해 그 배선 자체를 잰다 -- "함수를 불렀다"가
// 아니라 "화면이 실제로 바뀌는가"를 DOM 값으로 본다.
//
// 계약(coder-task.md §3-4, 책임자 확정) = 검토자가 꼽은 6개 구멍 중 5개
// (번호 1·2·3·4·6). 번호 5(부팅 시 첫 화면 선택)도 덮여 있다(권장이라
// 필수는 아니지만 app-harness.mjs 의 seed 훅으로 어렵지 않게 됐다).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootApp, waitFor } from "../support/app-harness.mjs";
import { createIndexedDbAdapter } from "../../src/storage/indexeddb-adapter.mjs";
import {
  readCurrentMemoId,
  writeCurrentMemoId,
} from "../../src/storage/current-memo-pointer.mjs";
import { IDBObjectStore } from "fake-indexeddb";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = join(here, "..", "..", "public", "index.html");

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

// memo-list-delete-undo.test.mjs 의 dispatchPointer/swipe 와 같은 모양
// (SWIPE_THRESHOLD_PX=40 을 넘기는 왼쪽 이동) -- 여긴 jsdom 합성 DOM이
// 아니라 bootApp() 이 실제로 부팅한 app.mjs 번들 결선을 통과한다.
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

// 번호 1 -- showScreen() 의 hidden 토글 자체. 부팅 직후 기본 화면은
// 목록(list-screen 이 안 보이면 안 됨 · editor-screen 은 보이면 안 됨)
// 이어야 한다 -- 이 값 자체가 M5 변이(hidden 토글 반전)의 정반대 방향을
// 직접 잰다.
test("배선 1: 부팅 직후 목록 화면이 보이고 에디터 화면은 숨겨져 있다(showScreen hidden 토글)", async () => {
  const dom = await bootApp();
  const { document } = dom.window;
  await waitFor(
    () => document.querySelector("#list-root .memo-list-empty") !== null,
  );
  assert.equal(document.getElementById("list-screen").hidden, false);
  assert.equal(document.getElementById("editor-screen").hidden, true);
});

// 번호 2 -- 카드 클릭 -> openMemoInEditor -> .then(() => showScreen(...))
// 의 마지막 고리. 카드를 누르면 실제로 에디터 화면으로 넘어가고, 그
// 메모의 본문이 raw-panel 에 뜬다(엉뚱한 메모가 아니라 «그» 메모).
test("배선 2: 목록 카드를 클릭하면 그 메모가 열리며 에디터 화면으로 전환된다", async () => {
  const dom = await bootApp({
    seed: () => seedMemo("card-open-1", "카드 열기 확인용 메모"),
  });
  const { document } = dom.window;
  await waitFor(
    () => document.querySelector('[data-memo-id="card-open-1"]') !== null,
  );

  document.querySelector('[data-memo-id="card-open-1"]').click();

  await waitFor(
    () => document.getElementById("editor-screen").hidden === false,
  );
  assert.equal(document.getElementById("list-screen").hidden, true);
  await waitFor(
    () =>
      document.getElementById("raw-panel").textContent ===
      "카드 열기 확인용 메모",
  );
});

// 번호 3 -- 뒤로가기 버튼 -> flushImmediate -> list.refresh() -> 목록
// 화면 복귀. "+"로 새 메모를 시작해 타이핑 없이 곧장 뒤로가면(빈 메모라
// 아무것도 안 남아야 정상) 목록 화면으로 돌아오고, 그 화면은 다시
// «비어있지 않은» 상태(씨앗 메모)를 정확히 보여줘야 한다 -- list.refresh()
// 가 실제로 다시 불렸다는 증거다(주석 처리됐다면 화면 전환은 되어도
// 목록 내용이 갱신되지 않는다는 차이가 다른 시험에서 드러나지만, 여기서는
// "화면이 list-screen 으로 돌아온다" 자체를 값으로 잰다).
test("배선 3: 에디터에서 뒤로가기를 누르면 목록 화면으로 돌아온다(flushImmediate -> refresh -> showScreen)", async () => {
  const dom = await bootApp({
    seed: () => seedMemo("back-nav-1", "뒤로가기 확인용 메모"),
  });
  const { document } = dom.window;
  await waitFor(
    () => document.querySelector('[data-memo-id="back-nav-1"]') !== null,
  );
  document.querySelector('[data-memo-id="back-nav-1"]').click();
  await waitFor(
    () => document.getElementById("editor-screen").hidden === false,
  );

  // 에디터 화면에 있는 동안(=목록 DOM 이 그 사이 갱신될 방법이 없는
  // 시점) 저장 계층에 «다른» 메모를 직접 하나 더 심는다. list.refresh()
  // 가 실제로 다시 불려야만 뒤로가기 후 이 메모가 목록에 나타난다 --
  // list.refresh() 호출 자체가 없어져도(예: 화면 전환 로직만 남기고
  // 지워도) 이전에 그려둔 DOM 이 그대로 남아있어 화면 전환만으로는 이
  // 구멍을 못 잡는다. 이 메모가 «새로» 나타나는 것이야말로 refresh() 가
  // 진짜로 다시 돌았다는 증거다.
  await seedMemo("back-nav-2", "뒤로가기 후에만 보여야 하는 메모");

  document.getElementById("back-to-list-button").click();

  await waitFor(() => document.getElementById("list-screen").hidden === false);
  assert.equal(document.getElementById("editor-screen").hidden, true);
  await waitFor(
    () => document.querySelector('[data-memo-id="back-nav-2"]') !== null,
    { timeout: 3000 },
  );
  assert.ok(
    document.querySelector('[data-memo-id="back-nav-1"]'),
    "이전 메모도 여전히 목록에 있어야 한다",
  );
});

// 번호 4 -- "+"(새 메모) 버튼 배선. 누르면 빈 에디터로 전환된다(엉뚱한
// 메모가 아니라 진짜 새 메모 -- raw-panel 이 비어 있어야 한다).
test("배선 4: '+' 버튼을 누르면 빈 에디터로 전환된다", async () => {
  const dom = await bootApp({
    seed: () => seedMemo("existing-1", "이미 있던 메모"),
  });
  const { document } = dom.window;
  await waitFor(
    () => document.querySelector('[data-memo-id="existing-1"]') !== null,
  );

  document.getElementById("new-memo-button").click();

  await waitFor(
    () => document.getElementById("editor-screen").hidden === false,
  );
  assert.equal(document.getElementById("list-screen").hidden, true);
  assert.equal(document.getElementById("raw-panel").textContent, "");
});

// 번호 5 -- 부팅 시 첫 화면은 포인터와 무관하게 목록이다(한용 확정 ㄱ,
// HYK-304-home-list-updatedat-1). 포인터가 가리키던 메모는 부팅 때 비워져
// 에디터에도 올라오지 않는다(app.mjs main 의 writeCurrentMemoId(null)).
test("배선 5: 포인터가 메모를 가리키고 있어도 부팅 직후 첫 화면은 목록이고, 포인터는 비워진다", async () => {
  const dom = await bootApp({
    seed: async () => {
      await seedMemo("pointed-1", "가리켜진 메모");
      writeCurrentMemoId("pointed-1");
    },
  });
  const { document } = dom.window;

  await waitFor(() => document.getElementById("list-screen").hidden === false);
  assert.equal(document.getElementById("editor-screen").hidden, true);
  assert.equal(document.getElementById("raw-panel").textContent, "");
  assert.equal(readCurrentMemoId(), null);
});

// 번호 6 -- grabElements() 가 찾는 DOM id 와 public/index.html 실물의
// 일치. 검토자 원문: "어떤 시험도 public/index.html 을 읽지 않는다(id
// 오타 하나면 null.hidden 으로 런타임이 죽는데 그걸 잡을 것이 CI 에
// 없다)". 위 배선 1~5 는 모두 이 파일의 bootApp() 을 거쳐 «실물»
// public/index.html 로 부팅한다 -- 그래서 이 id 들(list-root/list-screen/
// editor-screen/new-memo-button/back-to-list-button/editor-root/
// raw-panel) 중 하나라도 실물에서 사라지면 위 시험들이 (grabElements 가
// null 을 돌려줘 그 다음 단계가 TypeError 로 죽으면서) 그 자리에서 이미
// 실패한다 -- 그것 자체가 결과 파일 §정직 한계에 값으로 남긴 변이 RED
// 증거다(반증: `list-root` id 를 임시로 어긋나게 하고 이 파일을 다시
// 돌리면 배선 1·2·3·6 이 즉시 빨개진다 · 복원 후 되돌림).
// 아래는 그 6개(save-notice/notion-copy-* 제외 -- 이 조각 범위 밖)를
// 명시로 한 번 더 값으로 박아, "실물 파일을 읽는 시험이 하나도 없다"는
// 검토자의 원래 지적 자체를 직접 반증한다.
//
// 검토 2R P2-1(최소 배선, 요구 1-ⓑ): list-save-error-button ·
// list-delete-toast-text 두 id 를 이 목록에 추가한다 -- app.mjs 의
// grabElements/toast 결선이 이 둘을 쓴다(coder-task.md §2). 아래 배선 7
// 이 "실제로 동작하는가"(ⓐ)까지 값으로 재므로, 이 추가는 최소 보강
// (ⓑ)에 해당한다.
test("배선 6: public/index.html 실물 -- grabElements 가 찾는 DOM id 가 전부 있다", async () => {
  const html = await readFile(indexHtmlPath, "utf8");
  const dom = await bootApp();
  const { document } = dom.window;
  await waitFor(
    () => document.querySelector("#list-root .memo-list-empty") !== null,
  );
  for (const id of [
    "editor-root",
    "raw-panel",
    "save-notice",
    "notion-copy-button",
    "notion-copy-toast",
    "list-root",
    "new-memo-button",
    "back-to-list-button",
    "list-screen",
    "editor-screen",
    "list-save-error-button",
    "list-delete-toast-text",
  ]) {
    assert.ok(
      html.includes(`id="${id}"`),
      `public/index.html 원문에 id="${id}" 가 있어야 한다(grabElements 계약)`,
    );
    assert.ok(
      document.getElementById(id),
      `부팅한 DOM 에서도 #${id} 를 찾을 수 있어야 한다`,
    );
  }
});

// 번호 7 (검토 2R P2-1, coder-task.md §2 요구 1-ⓐ): 배선 6 은 id 가
// "있다"만 잰다 -- app.mjs 의 errorButton/textEl 결선이 끊기면(변이
// S4·S6, index.html 의 id 자체가 사라지는 S5 는 배선 6 이 이미 잡는다)
// id 는 그대로 있어도 showSaveError 가 아무것도 그리지 않는다
// (memo-list-mount.mjs:79 "if (!toast || !toast.errorButton) return;").
// 실물 부팅(public/index.html + 실제 app.mjs 결선) 위에서 adapter.put
// 을 1회 강제 실패시켜(검토 2R ⓑ 헤드리스 표본과 같은 몽키패치 방식,
// IDBObjectStore.prototype.put 1회 throw) #list-save-error-button 이
// 실제로 보이고 문구가 리터럴과 같은지를 값으로 잰다.
test("배선 7: 메모 스와이프 삭제 저장이 실패하면 #list-save-error-button 이 보이고 고정 문구가 뜬다(P2-1 결선 고정)", async () => {
  const dom = await bootApp({
    seed: () => seedMemo("save-error-wiring-1", "저장 실패 결선 확인용 메모"),
  });
  const { document } = dom.window;
  await waitFor(
    () =>
      document.querySelector('[data-memo-id="save-error-wiring-1"]') !== null,
  );

  const originalPut = IDBObjectStore.prototype.put;
  let failuresLeft = 1;
  IDBObjectStore.prototype.put = function patchedPut(...args) {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("app-wiring 배선 7: 강제 저장 실패");
    }
    return originalPut.apply(this, args);
  };

  try {
    const card = document.querySelector('[data-memo-id="save-error-wiring-1"]');
    swipeCard(dom, card);

    await waitFor(
      () => document.getElementById("list-save-error-button").hidden === false,
    );
    assert.equal(
      document.getElementById("list-save-error-button").textContent,
      "저장에 실패했어요. 다시 시도해 주세요",
      "실물 결선에서도 책임자 결정④ 문구가 그대로 보여야 한다",
    );
    assert.equal(
      document.getElementById("list-delete-toast").hidden,
      false,
      "토스트 고정 영역이 보여야 한다",
    );
    assert.equal(
      document.getElementById("list-delete-toast-text").hidden,
      true,
      "실패 표시가 평소 삭제 안내 문구 자리를 대신해야 한다(textEl 결선, 변이 S6 생존 대상)",
    );
    assert.deepEqual(
      [...document.querySelectorAll(".memo-card")].map(
        (el) => el.dataset.memoId,
      ),
      ["save-error-wiring-1"],
      "저장 실패 뒤에도 카드는 목록에 남아있어야 한다",
    );
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
});
