// 소수리 B(coder-task.md §1-⑻ · 2R·3R 검토 모두 P2): "복원 조회 중 입력이
// 소실되지 않는다"는 수리와 서술은 storage-mount.mjs 에 이미 있다(리스너를
// adapter.get 을 "기다리지 않고" 등록 -- 그 파일 §0-2-⑸ 주석 참고). 그러나
// 그 축만 겨냥한 자동 시험이 없어 회귀가 조용히 열릴 수 있다.
//
// ⭐표제 축(coder-task.md 파일 머리 불변식 그대로, §1-⑻): "플래그가 섰다"를
// 재지 않는다 -- "친 글자가 저장 원문에 살아남았는가"를 잰다. 그래서 모든
// assert 는 restoreState 의 내부 플래그가 아니라, 실제로 adapter 에 쓰인
// 레코드의 body 와 화면 직렬화 결과를 본다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { makeProductEditor } from "../support/make-editor.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";
import {
  mountStorage,
  restoreCurrentMemo,
} from "../../src/editor/storage-mount.mjs";
import { createMemoStore } from "../../src/storage/memo-store.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";
import { writeCurrentMemoId } from "../../src/storage/current-memo-pointer.mjs";

// adapter.get 만 "지연"시킨다(다른 계약 메서드는 그대로) -- release() 를
// 부르기 전까지 get() 은 끝나지 않는다. 실제 IndexedDB 조회가 몇 틱 걸리는
// 동안 사용자가 이미 타이핑하는 상황을 결정적으로(setTimeout 경합 없이)
// 재현하는 통로다.
function makeGatedGetAdapter(inner) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    adapter: {
      ...inner,
      get: async (id) => {
        await gate;
        return inner.get(id);
      },
    },
    release: () => release(),
  };
}

function typeIntoEditor(editor, text) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(text));
      root.append(paragraph);
    },
    { discrete: true },
  );
}

test("복원 조회(adapter.get)가 지연되는 동안 친 글자가 저장 원문에 그대로 남는다(coder-task.md §1-⑻)", async () => {
  writeCurrentMemoId("inflight-1");
  const inner = createFakeAdapter();
  await inner.put({
    id: "inflight-1",
    title: "제목",
    body: "예전 저장된 원문",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { adapter, release } = makeGatedGetAdapter(inner);
  const { editor } = makeProductEditor();
  const notice = document.createElement("div");

  const store = mountStorage(editor, notice, adapter);
  // adapter.get("inflight-1") 은 아직 release() 전이라 끝나지 않는다 --
  // 바로 이 틈에 실제 사용자처럼 타이핑한다.
  typeIntoEditor(editor, "사용자가 조회 도중 친 글자");
  // 타이핑이 촉발한 store.onContentChange(비동기)가 새 메모를 만들
  // 시간을 준다.
  await new Promise((resolve) => setTimeout(resolve, 0));

  release();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const currentId = store.getMemoId();
  assert.ok(
    currentId,
    "지연 중 타이핑이 store.onContentChange 로 이어져 새 메모가 만들어졌어야 한다",
  );
  assert.notEqual(
    currentId,
    "inflight-1",
    "복원 대상이던 옛 메모 id 로 덮이면 안 된다(userEdited 가 restoreCurrentMemo 를 중단시켰어야 함)",
  );
  const record = await inner.get(currentId);
  assert.equal(
    record.body,
    "사용자가 조회 도중 친 글자",
    "플래그가 아니라 실제 저장된 원문으로 잰다 -- 친 글자가 그대로 남아야 한다",
  );
  assert.equal(
    serializeEditorToMarkdown(editor),
    "사용자가 조회 도중 친 글자",
    "화면도 사용자가 친 대로여야 한다(옛 저장 원문으로 덮이지 않음)",
  );
});

// ⭐되돌림(변이) RED(coder-task.md §3-⑥): 위 수리를 "리스너를 조회가 끝난
// 뒤에만 등록"하던 옛 방식으로 되돌리면, 같은 시나리오에서 친 글자가
// 사라진다는 것을 이 파일 안에서 직접 재현한다(review.md §4-4 가 실측한
// 그 회귀). storage-mount.mjs 자체는 건드리지 않고, 그 파일이 고친 "순서"
// 하나만 로컬로 되돌려 재현한다 -- 프로덕션 코드가 실제로 이 순서를
// 지키고 있다는 것은 위 시험이 이미 확인했다.
async function mountStorageWithOldBuggyOrder(editor, adapter) {
  const store = createMemoStore(adapter, { onStatusChange: () => {} });
  const restoreState = {
    applying: false,
    userEdited: false,
    done: false,
    autosaveBlocked: false,
  };
  // 옛 버그(review.md §4-4 이전): 조회가 "끝난 뒤"에만 리스너를 단다.
  await restoreCurrentMemo(editor, store, adapter, restoreState);
  editor.registerUpdateListener(() => {
    if (restoreState.applying) return;
    store.onContentChange(serializeEditorToMarkdown(editor));
  });
  return store;
}

test("되돌림(변이) RED: 리스너를 '조회 완료 뒤'에만 다는 옛 순서로 되돌리면 지연 중 타이핑이 사라진다(회귀 재현)", async () => {
  writeCurrentMemoId("inflight-2");
  const inner = createFakeAdapter();
  await inner.put({
    id: "inflight-2",
    title: "제목",
    body: "예전 저장된 원문",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { adapter, release } = makeGatedGetAdapter(inner);
  const { editor } = makeProductEditor();

  const mountPromise = mountStorageWithOldBuggyOrder(editor, adapter);
  // 옛 버그 버전은 아직 리스너를 안 달았다 -- 이 타이핑은 어디에도
  // 기록되지 않는다.
  typeIntoEditor(editor, "사용자가 조회 도중 친 글자(버그 재현)");

  release();
  await mountPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    serializeEditorToMarkdown(editor),
    "예전 저장된 원문",
    "옛 버그: restoreFn 의 root.clear() 가 타이핑을 덮어써 옛 저장 원문만 남는다(데이터 소실 재현)",
  );
});
