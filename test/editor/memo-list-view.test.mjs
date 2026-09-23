// coder-task.md §2: "목록 함수를 불렀다"로 멈추지 말고 "화면에 무엇이
// 몇 개 어떤 순서로 나오는가"까지 잰다 -- DOM 에 실제로 몇 개의 항목이
// 어떤 차례로 있는지를 값으로 확인한다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderMemoList,
  renderMemoListError,
  EMPTY_LIST_MESSAGE,
  LIST_ERROR_MESSAGE,
} from "../../src/editor/memo-list-view.mjs";

function memo(id, overrides = {}) {
  return {
    id,
    title: id,
    body: "본문",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

function cardIds(container) {
  return [...container.querySelectorAll(".memo-card")].map(
    (el) => el.dataset.memoId,
  );
}

// 개수 축(DOM)
test("개수 축: 메모 0개면 DOM 카드 0개, 빈 상태 문구 1개", () => {
  const container = document.createElement("div");
  renderMemoList(container, []);
  assert.equal(container.querySelectorAll(".memo-card").length, 0);
  const empty = container.querySelector(".memo-list-empty");
  assert.ok(empty, "빈 상태 요소가 있어야 한다");
  assert.equal(empty.textContent, EMPTY_LIST_MESSAGE);
});

test("개수 축: 메모 1개면 DOM 카드 정확히 1개", () => {
  const container = document.createElement("div");
  renderMemoList(container, [memo("only")], { onOpen: () => {} });
  assert.equal(container.querySelectorAll(".memo-card").length, 1);
  assert.equal(container.querySelector(".memo-list-empty"), null);
});

test("개수 축: 메모 여러 개면 그 수만큼 DOM 카드가 생긴다", () => {
  const container = document.createElement("div");
  renderMemoList(container, [memo("a"), memo("b"), memo("c")], {
    onOpen: () => {},
  });
  assert.equal(container.querySelectorAll(".memo-card").length, 3);
});

// 순서 축(DOM) -- renderMemoList 는 입력 배열 순서를 그대로 DOM 순서로
// 옮긴다는 것을 값(차례)으로 잰다.
test("순서 축: 입력 배열 순서가 DOM 차례에 그대로 반영된다", () => {
  const container = document.createElement("div");
  renderMemoList(container, [memo("newest"), memo("middle"), memo("older")], {
    onOpen: () => {},
  });
  assert.deepEqual(cardIds(container), ["newest", "middle", "older"]);
});

// 다시 그리면(재렌더) 이전 카드가 남지 않는다 -- "목록에 보이는 것은
// «그것뿐»"이 재호출 사이에도 성립해야 한다(누적 렌더 금지).
test("재렌더: renderMemoList 를 다시 부르면 이전 카드가 남지 않는다", () => {
  const container = document.createElement("div");
  renderMemoList(container, [memo("a"), memo("b")], { onOpen: () => {} });
  renderMemoList(container, [memo("c")], { onOpen: () => {} });
  assert.deepEqual(cardIds(container), ["c"]);
});

// 카드를 고르면 onOpen(id) 가 그 메모 id 로 불린다 -- "목록에서 메모를
// 고르면 에디터로"(PRD §6)의 목록 쪽 절반.
test("카드를 클릭하면 onOpen 이 그 메모 id 로 정확히 한 번 불린다", () => {
  const container = document.createElement("div");
  const opened = [];
  renderMemoList(container, [memo("a"), memo("b")], {
    onOpen: (id) => opened.push(id),
  });
  container.querySelector('[data-memo-id="b"]').click();
  assert.deepEqual(opened, ["b"]);
});

// coder-task.md §2 (P2-1): renderMemoListError 는 renderMemoList 와
// 별개 함수다 -- adapter -> mount 쪽의 catch 배선은 memo-list-mount.test.mjs
// 가 재고, 여기서는 순수 DOM 모양(문구·재시도 요소·구별 축)만 잰다.
test("실패 문구가 GLOSSARY 고정 문구 그대로 뜨고, 그 요소 자체가 재시도 가능한 버튼이다", () => {
  const container = document.createElement("div");
  let retried = 0;
  renderMemoListError(container, { onRetry: () => retried++ });

  const errorEl = container.querySelector(".memo-list-error");
  assert.ok(errorEl, "실패 요소가 있어야 한다");
  assert.equal(errorEl.tagName, "BUTTON");
  assert.equal(errorEl.textContent, LIST_ERROR_MESSAGE);
  assert.equal(container.querySelector(".memo-list-empty"), null);

  errorEl.click();
  assert.equal(retried, 1, "재시도 요소를 누르면 onRetry 가 불려야 한다");
});

test("재렌더: renderMemoListError 를 부르면 이전 카드/빈 상태가 남지 않는다", () => {
  const container = document.createElement("div");
  renderMemoList(container, [memo("a")], { onOpen: () => {} });
  renderMemoListError(container, { onRetry: () => {} });
  assert.equal(container.querySelectorAll(".memo-card").length, 0);
  assert.ok(container.querySelector(".memo-list-error"));
});

// 제목 축(coder-task.md §4) -- 목록 화면은 memo.title 필드를 그대로
// 보여준다(body 로부터 다시 파생하지 않는다). 이 시험은 "오늘 초록인
// 것"이 목적이 아니라, deriveTitleFromBody 호출 지점이 늘 하나(memo-
// store.mjs)로 유지되는지를 구조로 고정하는 것이다: memo.title 에
// 역슬래시가 든 글자(윈도우 경로 모양)를 넣어도 화면은 그 글자를 «그대로»
// 보여줘야 한다(변형·재해석 없음).
test("제목 축: 카드 제목은 memo.title 을 변형 없이 그대로 보여준다(역슬래시 포함)", () => {
  const container = document.createElement("div");
  const title = "C:\\Users\\한용\\메모.md 옮기기";
  renderMemoList(container, [memo("a", { title })], { onOpen: () => {} });
  const titleEl = container.querySelector(".memo-card-title");
  assert.equal(titleEl.textContent, title);
});
