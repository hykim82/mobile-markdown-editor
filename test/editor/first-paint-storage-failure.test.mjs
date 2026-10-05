// coder-task.md HYK-304-firstpaint-2 §1(P1-1, review-1R-원문.md §8): 저장
// 읽기가 거부되면(예: 재방문 사용자의 adapter.get 실패) 초기 복원 프라미스
// (store.initialRestoreReady)가 거부됐다 -- 그 거부가 처리되지 않으면
// showScreen() 이 막혀 list-screen/editor-screen 이 둘 다 hidden 인 채
// (백지)로 남았다(검토자 전/후 실측: f9120ac 이전엔 "메모 불러오기 실패 · 다시 +",
// 이후엔 ""). first-paint.test.mjs 는 두 행복 분기만 재서 이 회귀를 볼 수 없었다.
//
// ⭐HYK-304 vacuous-guard-fix-1 정정: 지금 app.mjs 는 initialRestoreReady 를
// 소비하지 않는다(부팅 시 포인터를 먼저 비워, 복원이 저장을 읽지 않는다). 그
// 거부를 받는 것은 storage-mount.mjs 의 .catch 다. 그래서 첫 칸("포인터 있음 +
// 저장 읽기 거부")은 포인터가 비워진 뒤라 거부를 일으키지 못하고, 이 칸이 실제로
// 잡는 것은 「부팅 시 포인터를 비우는 한 줄」이다(그 줄을 빼면 단정이 빨갛다).
// 거부 자체를 재는 것은 세 번째 시험이다. 대조 칸("포인터 없음 + 저장 읽기
// 거부")은 회귀가 없어야 한다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootApp, waitFor } from "../support/app-harness.mjs";
import { makeProductEditor } from "../support/make-editor.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";
import { mountStorage } from "../../src/editor/storage-mount.mjs";
import {
  writeCurrentMemoId,
  readCurrentMemoId,
} from "../../src/storage/current-memo-pointer.mjs";
import { LIST_ERROR_MESSAGE } from "../../src/editor/memo-list-view.mjs";

// indexedDB.open 이 항상 onerror 로 떨어지게 만들어 "저장 읽기 거부"를
// 재현한다 -- indexeddb-adapter.mjs 의 connect()/openDatabase() 가 이
// 실패를 그대로 Promise 거부로 옮기므로, list.refresh()(adapter.list())와
// restoreCurrentMemo(adapter.get())가 공유하는 단 하나의 DB 연결이 함께
// 죽는다(실제 "IndexedDB 자체가 막힌 환경" -- 사생활 모드 저장공간
// 제한 등 -- 과 같은 모양).
function installFailingIndexedDbOpen() {
  globalThis.indexedDB.open = () => {
    const request = {};
    globalThis.queueMicrotask(() => {
      request.error = new Error(
        "first-paint-storage-failure.test.mjs: simulated indexedDB.open failure",
      );
      if (typeof request.onerror === "function") request.onerror();
    });
    return request;
  };
}

test("저장 읽기 거부 + 포인터 있음: 두 화면이 계속 숨어 있지 않고(백지 아님), 목록 화면의 실패 UI 로 떨어진다", async () => {
  const unhandled = [];
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const dom = await bootApp({
      seed: async () => {
        installFailingIndexedDbOpen();
        // 실제 메모를 심지 않는다 -- indexedDB 자체가 막혀 있으므로
        // adapter.get 이 그 전에 이미 거부된다. pointer 만 있으면 된다.
        writeCurrentMemoId("points-to-a-memo-but-db-is-down");
      },
    });
    const { document } = dom.window;
    const listScreen = document.getElementById("list-screen");
    const editorScreen = document.getElementById("editor-screen");
    const listRoot = document.getElementById("list-root");

    await waitFor(() => listScreen.hidden === false);

    // 부팅 시 포인터는 app.mjs main 이 비운다. 이 줄이 빠지면 restoreCurrentMemo 가
    // 저장 읽기를 시작해 거부가 생기므로, 여기서 포인터가 남았는지로 그 줄을 잡는다.
    assert.equal(
      readCurrentMemoId(),
      null,
      "부팅 시 마지막 메모 포인터는 비워져야 한다 -- 비우지 않으면 restoreCurrentMemo 가 저장 읽기를 시작해 거부가 생긴다(app.mjs main 의 writeCurrentMemoId(null))",
    );
    assert.equal(
      editorScreen.hidden,
      true,
      "editor-screen 은 계속 숨겨져 있어야 한다(복원 실패했으니 에디터를 보여줄 근거가 없다)",
    );
    assert.equal(
      listScreen.hidden,
      false,
      "list-screen 은 보여야 한다 -- P1-1: 예전엔 여기서 두 화면이 다 hidden 인 채(백지)로 멈췄다",
    );

    const visibleText = listRoot.textContent.trim();
    assert.notEqual(
      visibleText.length,
      0,
      "사용자가 보는 글자가 0이면 안 된다(백지 회귀 재현 시 여기서 실패한다)",
    );
    assert.equal(
      visibleText,
      LIST_ERROR_MESSAGE,
      "list.refresh() 도 같은 DB 연결로 실패하므로 목록 화면은 고정 실패 문구(불러오기 실패 · 다시)를 보여줘야 한다",
    );

    // 거부가 unhandledRejection 으로 새지 않는지 보려면 마이크로태스크 큐가
    // 완전히 비워질 시간을 한 틱 줘야 한다. 다만 이 칸은 포인터가 비워져 거부가
    // 일어나지 않으므로 이 단정은 거부 누수를 잡는 장치가 아니다(그 몫은 세 번째 시험).
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      unhandled,
      [],
      "initialRestoreReady 의 거부는 storage-mount.mjs 의 .catch() 가 처리해야 한다 -- 처리하지 않으면(1R 코드) 여기서 unhandledRejection 이 잡힌다",
    );
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

test("저장 읽기 거부 + 포인터 없음: 회귀가 이 칸에는 없다 -- 목록 화면(실패 UI)만 정확히 보인다", async () => {
  const dom = await bootApp({
    seed: async () => {
      installFailingIndexedDbOpen();
      // pointer 를 아예 안 심는다 -- restoreCurrentMemo 는 existingId 가
      // 없으면 adapter 를 건드리지 않고 즉시 return 하므로(storage-mount.mjs)
      // initialRestoreReady 자체는 이 칸에서 "성공"으로 끝난다. 검토자가
      // 실측한 대로 회귀가 이 칸에 없음을 시험으로 고정한다.
    },
  });
  const { document } = dom.window;
  const listScreen = document.getElementById("list-screen");
  const editorScreen = document.getElementById("editor-screen");
  const listRoot = document.getElementById("list-root");

  await waitFor(() => listScreen.hidden === false);

  assert.equal(
    editorScreen.hidden,
    true,
    "editor-screen 은 계속 숨어 있어야 한다",
  );
  assert.equal(listScreen.hidden, false, "list-screen 만 보여야 한다");

  const visibleText = listRoot.textContent.trim();
  assert.notEqual(visibleText.length, 0, "사용자가 보는 글자가 0이면 안 된다");
  assert.equal(
    visibleText,
    LIST_ERROR_MESSAGE,
    "list.refresh() 자체는 여전히 실패하므로(DB 가 막혀 있다) 목록 화면은 실패 UI 를 보여준다 -- 다만 첫 화면 선택(showScreen) 로직 자체는 정상 분기(then)를 탄다",
  );
});

// 거부를 실제로 일으키는 칸: 포인터를 심고 저장 읽기(get)만 거부시킨 채
// mountStorage 를 직접 부른다. app.mjs 의 포인터 비우기를 거치지 않으므로,
// storage-mount.mjs 의 .catch 가 사라지면 initialRestoreReady 가 거부로 새어
// 이 시험이 빨갛게 된다. 거부는 logFn 으로 한 번 남아야 한다(조용히 삼키지 않는다).
test("저장 읽기 거부(직접): mountStorage 의 초기 복원 프라미스는 거부로 새지 않고, 실패는 한 번 기록된다", async () => {
  writeCurrentMemoId("read-rejects-direct-1");
  const { editor } = makeProductEditor();
  const notice = { hidden: true, textContent: "" };
  const adapter = {
    ...createFakeAdapter(),
    get: () =>
      Promise.reject(
        new Error("first-paint-storage-failure.test.mjs: direct get rejection"),
      ),
  };
  const logged = [];
  const store = mountStorage(editor, notice, adapter, {
    logFn: (...args) => logged.push(args),
  });

  await store.initialRestoreReady;
  assert.equal(
    logged.length,
    1,
    "저장 읽기 거부는 logFn 으로 정확히 한 번 기록돼야 한다 -- 0회면 조용히 삼킨 것이다",
  );
});
