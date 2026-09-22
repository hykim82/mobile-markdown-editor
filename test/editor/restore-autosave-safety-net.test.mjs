// coder-task.md §1-⑷ -- "모양 전수를 놓쳐도 데이터가 안 사라지게 하는
// 마지막 문"을 restore.mjs 의 tokenizeInline 이 실제로 맞는지와 무관하게
// 독립적으로 잰다. storage-mount.mjs 의 restoreCurrentMemo/mountStorage 는
// restoreFn/serializeFn/logFn 을 주입받을 수 있어(오직 시험 전용 --
// 프로덕션은 항상 기본값), "미래의 tokenizeInline 버그가 원문을
// 훼손한다"는 상황을 실제 버그 없이도 흉내 낼 수 있다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { makeProductEditor } from "../support/make-editor.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";
import {
  restoreCurrentMemo,
  mountStorage,
} from "../../src/editor/storage-mount.mjs";
import { createMemoStore } from "../../src/storage/memo-store.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";
import {
  writeCurrentMemoId,
  readCurrentMemoId,
} from "../../src/storage/current-memo-pointer.mjs";

// fake-adapter.mjs 의 put 은 계약 시험(runAdapterContractTests) 밖의
// 카운터를 안 갖고 있다 -- 계약을 넓히지 않고 시험에서만 감싸 센다.
function withPutCounter(adapter) {
  let putCalls = 0;
  return {
    counter: () => putCalls,
    adapter: {
      ...adapter,
      put: (memo) => {
        putCalls += 1;
        return adapter.put(memo);
      },
    },
  };
}

function makeRestoreState() {
  return {
    applying: false,
    userEdited: false,
    done: false,
    autosaveBlocked: false,
  };
}

test("복원만으로는 저장이 한 번도 일어나지 않는다(가짜 어댑터 put 0회, coder-task.md §1-⑷-ⓒ)", async () => {
  writeCurrentMemoId("safety-net-1");
  const inner = createFakeAdapter();
  await inner.put({
    id: "safety-net-1",
    title: "제목",
    body: "정상 본문 ** 아직 안 닫힘",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { counter, adapter } = withPutCounter(inner);
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();

  await restoreCurrentMemo(editor, store, adapter, restoreState);

  assert.equal(
    counter(),
    0,
    "restoreCurrentMemo 단독 실행은 put 을 부르면 안 된다",
  );
  assert.equal(
    serializeEditorToMarkdown(editor),
    "정상 본문 ** 아직 안 닫힘",
    "복원된 화면은 저장된 원문과 바이트가 같아야 한다",
  );
  assert.equal(
    restoreState.autosaveBlocked,
    false,
    "정상 복원은 안전판을 걸지 않는다",
  );
});

test("복원 직후 첫 직렬화가 저장 원문과 다르면 autosaveBlocked 를 세우고 콘솔(logFn)에 기록한다, 쓰지 않는다(coder-task.md §1-⑷-ⓑ)", async () => {
  writeCurrentMemoId("safety-net-2");
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "safety-net-2",
    title: "제목",
    body: "BB원본은 이래야 한다",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();

  // 미래의 tokenizeInline 버그를 흉내 낸다: restore.mjs 를 실제로 갈아
  // 끼우지 않고, "복원이 원문과 다른 결과를 냈다"는 상황만 주입한다.
  const brokenRestoreFn = (ed) => {
    ed.update(
      () => {
        $getRoot().clear();
      },
      { discrete: true },
    );
  };
  const logs = [];
  await restoreCurrentMemo(editor, store, adapter, restoreState, {
    restoreFn: brokenRestoreFn,
    logFn: (...args) => logs.push(args),
  });

  assert.equal(restoreState.autosaveBlocked, true);
  assert.equal(logs.length, 1, "정확히 한 번 기록해야 한다");
  assert.equal(logs[0][1].memoId, "safety-net-2");
  assert.equal(logs[0][1].storedBody, "BB원본은 이래야 한다");
  assert.equal(logs[0][1].restoredBody, "");
});

test("autosaveBlocked 가 선 뒤에는 실제 사용자 입력이 와도 자동저장(어댑터 put)이 걸리지 않는다(coder-task.md §1-⑷-ⓐ, 통합)", async () => {
  writeCurrentMemoId("safety-net-3");
  const inner = createFakeAdapter();
  await inner.put({
    id: "safety-net-3",
    title: "제목",
    body: "BB원본은 이래야 한다",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { counter, adapter } = withPutCounter(inner);
  const { editor } = makeProductEditor();
  const notice = document.createElement("div");
  const brokenRestoreFn = (ed) => {
    ed.update(
      () => {
        $getRoot().clear();
      },
      { discrete: true },
    );
  };

  mountStorage(editor, notice, adapter, { restoreFn: brokenRestoreFn });
  // restoreCurrentMemo 안의 유일한 비동기 지점(adapter.get)은 마이크로
  // 태스크 하나만 거친다 -- 매크로태스크(setTimeout) 한 틱이면 그 전체
  // 체인이 확실히 끝나 있다.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    counter(),
    0,
    "훼손 복원 직후, 아무 입력도 없는 상태에서는 put 0회",
  );

  // 이제 실제 사용자처럼 새 글자를 친다 -- registerUpdateListener 가
  // "user edit" 으로 보는 진짜 update.
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("사용자가 방금 친 새 글자"));
      root.append(paragraph);
    },
    { discrete: true },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    counter(),
    0,
    "안전판이 걸린 뒤에는 실제 사용자 입력조차 저장(put)으로 이어지면 안 된다 -- 훼손된 값이 멀쩡한 저장 원문을 덮어쓰는 것을 막는 마지막 문",
  );
});

// 소수리 A(coder-task.md §1-⑺ · 3R 검토 P2-4): 예전엔 console.error 만
// 남아 사용자는 자기 입력이 저장되지 않는 것을 몰랐다("save-notice.hidden
// === true" 였던 실측). 이 시험은 mountStorage 를 통째로 태워 안전판이
// 걸린 뒤 notice 가 실제로 화면에 뜨는지(hidden === false)를 잰다.
test("소수리 A: 안전판이 걸리면 notice.hidden === false 로 바뀌고 문구가 뜬다(coder-task.md §1-⑺)", async () => {
  writeCurrentMemoId("safety-net-notice-1");
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "safety-net-notice-1",
    title: "제목",
    body: "저장된 원문",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const notice = document.createElement("div");
  notice.hidden = true;
  const brokenRestoreFn = (ed) => {
    ed.update(
      () => {
        $getRoot().clear();
      },
      { discrete: true },
    );
  };

  mountStorage(editor, notice, adapter, { restoreFn: brokenRestoreFn });
  // restoreCurrentMemo 의 유일한 비동기 지점(adapter.get)이 끝날 시간을
  // 준다(위 통합 시험과 같은 근거 -- 매크로태스크 한 틱).
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    notice.hidden,
    false,
    "안전판이 걸렸으면 사용자에게 보이는 notice 가 hidden=false 여야 한다",
  );
  assert.match(
    notice.textContent,
    /저장이 막혔습니다/,
    "화면에 실제로 보이는 문구가 떠 있어야 한다",
  );
});

test("복원할 현재 메모 포인터가 없으면 조회조차 하지 않는다(readCurrentMemoId 회귀 -- 안전판과 별개로 항상 성립해야 하는 것)", async () => {
  writeCurrentMemoId(null);
  assert.equal(readCurrentMemoId(), null);
  const adapter = createFakeAdapter();
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();
  await restoreCurrentMemo(editor, store, adapter, restoreState);
  assert.equal(serializeEditorToMarkdown(editor), "");
  assert.equal(restoreState.autosaveBlocked, false);
});
