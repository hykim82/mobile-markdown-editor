// coder-task.md §2: adapter -> list-query -> memo-list-view 전 사슬을
// 한 번에 잰다("목록 함수를 불렀다"가 아니라 "화면에 몇 개 어떤 순서로
// 나오는가"). fake adapter(어댑터 계약 준수, test/support/fake-adapter.mjs)
// 를 실제 memo-store.mjs 경유로 채워 실제 쓰기 경로와 같은 데이터 모양을
// 만든다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountMemoList } from "../../src/editor/memo-list-mount.mjs";
import { LIST_ERROR_MESSAGE } from "../../src/editor/memo-list-view.mjs";
import { createMemoStore } from "../../src/storage/memo-store.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";

function cardIds(container) {
  return [...container.querySelectorAll(".memo-card")].map(
    (el) => el.dataset.memoId,
  );
}

async function createMemoAt(adapter, body, updatedAt) {
  const store = createMemoStore(adapter, { now: () => updatedAt });
  await store.onContentChange(body);
  return store.getMemoId();
}

test("개수·가시성 축(전 사슬): 0개 -> refresh 후 DOM 빈 상태", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const list = mountMemoList(container, adapter, { onOpen: () => {} });
  await list.refresh();
  assert.equal(container.querySelectorAll(".memo-card").length, 0);
  assert.ok(container.querySelector(".memo-list-empty"));
});

test("개수·가시성 축(전 사슬): 본문 있는 메모 1개는 보이고, 삭제된 메모는 안 보인다", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const visibleId = await createMemoAt(adapter, "보이는 메모", 100);
  const deletedId = await createMemoAt(adapter, "삭제된 메모", 200);
  const deletedRecord = await adapter.get(deletedId);
  await adapter.put({ ...deletedRecord, deletedAt: 250 });

  const list = mountMemoList(container, adapter, { onOpen: () => {} });
  await list.refresh();

  assert.deepEqual(cardIds(container), [visibleId]);
});

test("순서 축(전 사슬): 최신 수정순으로 DOM 에 그려진다", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const idOld = await createMemoAt(adapter, "옛 메모", 100);
  const idNew = await createMemoAt(adapter, "새 메모", 300);
  const idMid = await createMemoAt(adapter, "중간 메모", 200);

  const list = mountMemoList(container, adapter, { onOpen: () => {} });
  await list.refresh();

  assert.deepEqual(cardIds(container), [idNew, idMid, idOld]);
});

// 순서 축 -- "수정하면 순서가 바뀐다"를 DOM 재렌더까지 값으로 잰다
// (test/storage/list-query.test.mjs 는 같은 불변식을 어댑터 레벨에서
// 잰다 -- 여기는 그 위의 DOM 레벨).
test("순서 축(전 사슬): 오래된 메모를 고쳐 저장하면 DOM 에서도 맨 위로 올라온다(전/후)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const idA = await createMemoAt(adapter, "A 메모", 100);
  const idB = await createMemoAt(adapter, "B 메모", 200);
  const list = mountMemoList(container, adapter, { onOpen: () => {} });

  await list.refresh();
  assert.deepEqual(cardIds(container), [idB, idA], "전: B 가 위");

  const recordA = await adapter.get(idA);
  const reopened = createMemoStore(adapter, { now: () => 300 });
  reopened.loadMemo(recordA);
  reopened.onContentChange("A 메모, 방금 고침");
  await reopened.flushImmediate();

  await list.refresh();
  assert.deepEqual(cardIds(container), [idA, idB], "후: 방금 고친 A 가 위");
});

// 제목 축(coder-task.md §4) -- memo-store.mjs 의 실제 저장 경로(즉
// deriveTitleFromBody)를 거쳐 만들어진 title 이 화면까지 변형 없이
// 그대로 온다. ⚠️이 시험이 "오늘" 초록인 것 자체가 목적이 아니다 --
// PR #6(역슬래시 escape, 아직 병합 전) 병합·리베이스 뒤 이 시험이 계속
// 초록이어야 "화면에 보이는 제목 == 사용자가 편집기에서 본 글자"
// 불변식이 안 깨졌다는 뜻이다. 지금 이 base 에는 escape 가 없어
// «저절로» 통과한다(coder-task.md §4-2).
test("제목 축(전 사슬): 역슬래시가 든 본문을 저장하면 목록 제목이 그 글자 그대로 보인다", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const body = "C:\\Users\\한용\\일감.md 정리\n둘째 줄";
  const id = await createMemoAt(adapter, body, 100);

  const list = mountMemoList(container, adapter, { onOpen: () => {} });
  await list.refresh();

  const titleEl = container.querySelector(
    `[data-memo-id="${id}"] .memo-card-title`,
  );
  assert.equal(
    titleEl.textContent,
    "C:\\Users\\한용\\일감.md 정리",
    "제목은 본문 첫 줄과 바이트가 같아야 한다(사용자가 친 글자 그대로)",
  );
});

// coder-task.md §2(P2-1) -- 검토자가 §2-1에서 실측한 "제목 + 빈 본문
// 화면"(실패했다는 사실 자체가 안 보임)을 이 저장소 시험으로 옮겨 심는다
// (§2-3 "실패 주입은 워크트리 안 시험에서 해야 CI 가 돈다"). 저장소
// 어댑터 list() 를 fake-adapter 의 forceNextListFailures 로 거부시켜
// 재현한다.
test("실패 축: 조회가 거부되면 실패 문구·재시도 요소가 뜨고 unhandledRejection 이 없다", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  adapter.forceNextListFailures(1);
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on("unhandledRejection", onRejection);

  const list = mountMemoList(container, adapter, { onOpen: () => {} });
  await list.refresh();
  // refresh() 가 fire-and-forget 으로 불려도(app.mjs 처럼) 거부가 새지
  // 않는지 마이크로태스크 큐를 한 번 더 돌려 확인한다.
  await new Promise((resolve) => setTimeout(resolve, 0));

  try {
    assert.equal(container.querySelectorAll(".memo-card").length, 0);
    const errorEl = container.querySelector(".memo-list-error");
    assert.ok(errorEl, "실패 요소(재시도 겸용)가 DOM 에 있어야 한다");
    assert.equal(errorEl.textContent, LIST_ERROR_MESSAGE);
    assert.equal(container.querySelector(".memo-list-empty"), null);
    assert.deepEqual(
      rejections,
      [],
      "unhandledRejection 이 0이어야 한다(§2-3 실패 축)",
    );
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("복구 축: 재시도를 누르고 저장 계층이 되살아 있으면 목록이 정상으로 그려진다(카드 수 전/후)", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  await createMemoAt(adapter, "복구 후 보일 메모", 100);
  adapter.forceNextListFailures(1);

  const list = mountMemoList(container, adapter, { onOpen: () => {} });
  await list.refresh();
  assert.equal(
    container.querySelectorAll(".memo-card").length,
    0,
    "전: 실패 화면이라 카드 0개",
  );

  container.querySelector(".memo-list-error").click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    container.querySelectorAll(".memo-card").length,
    1,
    "후: 재시도로 저장 계층이 되살아나면 카드가 보인다",
  );
  assert.equal(container.querySelector(".memo-list-error"), null);
});

// 구별 축(§2-3): "메모 0개 정상" 과 "조회 실패" 는 서로 다른 화면이어야
// 한다 -- 같은 클래스로 겹쳐 보이면 사용자가 둘을 구별할 수 없다.
test("구별 축: 메모 0개 정상 화면과 조회 실패 화면은 서로 다른 DOM 이다", async () => {
  const emptyContainer = document.createElement("div");
  const emptyAdapter = createFakeAdapter();
  await mountMemoList(emptyContainer, emptyAdapter, {
    onOpen: () => {},
  }).refresh();

  const errorContainer = document.createElement("div");
  const errorAdapter = createFakeAdapter();
  errorAdapter.forceNextListFailures(1);
  await mountMemoList(errorContainer, errorAdapter, {
    onOpen: () => {},
  }).refresh();

  assert.ok(emptyContainer.querySelector(".memo-list-empty"));
  assert.equal(emptyContainer.querySelector(".memo-list-error"), null);
  assert.ok(errorContainer.querySelector(".memo-list-error"));
  assert.equal(errorContainer.querySelector(".memo-list-empty"), null);
  assert.notEqual(
    emptyContainer.innerHTML,
    errorContainer.innerHTML,
    "두 화면의 DOM 이 달라야 한다",
  );
});

test("카드 클릭이 refresh 로 새로 그려진 뒤에도 정확한 id 로 onOpen 을 부른다", async () => {
  const container = document.createElement("div");
  const adapter = createFakeAdapter();
  const id = await createMemoAt(adapter, "메모", 100);
  const opened = [];
  const list = mountMemoList(container, adapter, {
    onOpen: (openedId) => opened.push(openedId),
  });
  await list.refresh();
  container.querySelector(`[data-memo-id="${id}"]`).click();
  assert.deepEqual(opened, [id]);
});
