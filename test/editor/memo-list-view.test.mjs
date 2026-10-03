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
  UNTITLED_MEMO_PLACEHOLDER,
} from "../../src/editor/memo-list-view.mjs";
import { deriveTitleFromBody } from "../../src/storage/title.mjs";

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

// 이름 없는 카드 축(coder-task.md §2, E3 검토 P2-9) -- 첫 줄이 공백뿐인
// 메모는 title.mjs 의 deriveTitleFromBody 가 이미 trim() 해 저장 시점에
// memo.title === "" 이 된다(그 사실 자체는 memo-store.test.mjs/title.mjs
// 의 책임이라 여기서 다시 재지 않는다). 이 파일은 그 "빈 제목"이 목록
// 화면에 "시각만 있는 이름 없는 카드"로 남지 않고 임시 문구를 보이는지를
// 잰다 -- 그래서 아래 4종은 전부 memo.title 을 이미 "" 로 심는다(실제
// deriveTitleFromBody 가 공백류를 어떻게 접든, 렌더러 입장에선 "빈
// 문자열을 받았을 때"만 안다).

// 공백 축: 스페이스만 / 탭만 / 개행만 / 전각 공백(보이지 않는 글자)만인
// 첫 줄 -- title.mjs 의 trim() 이 전부 "" 로 접으므로(경계 축: 아래
// 참고) 렌더러가 보는 입력은 네 경우 모두 동일하게 memo.title === "" 다.
for (const [label, rawFirstLine] of [
  ["스페이스만", "   "],
  ["탭만", "\t\t"],
  ["개행만", "\n"],
  ["전각 공백만(보이지 않는 글자)", "\u3000\u3000"],
]) {
  test(`공백 축(${label}): 첫 줄이 공백뿐이라 title이 ""인 메모는 카드에 임시 문구를 보인다`, () => {
    // 렌더러가 실제로 받는 값은 항상 deriveTitleFromBody(rawFirstLine + ...) 의
    // 결과인 "" 다 -- 아래는 그 파생이 실제로 ""로 접히는지를 같은 자리에서
    // 값으로 재확인해 둔다(경계 축과 겹치는 목적).
    assert.equal(
      deriveTitleFromBody(rawFirstLine),
      "",
      `deriveTitleFromBody(${JSON.stringify(rawFirstLine)}) 는 "" 여야 한다(경계 축 전제)`,
    );

    const container = document.createElement("div");
    renderMemoList(container, [memo("blank-1", { title: "" })], {
      onOpen: () => {},
    });
    const titleEl = container.querySelector(".memo-card-title");
    assert.ok(
      titleEl,
      "카드 자체는 여전히 있어야 한다(빈 줄이 아니라 카드 하나)",
    );
    assert.equal(
      titleEl.textContent,
      UNTITLED_MEMO_PLACEHOLDER,
      "제목이 빈 카드는 임시 문구를 보여야 한다(시각만 있는 이름 없는 카드 금지)",
    );
    assert.notEqual(
      titleEl.textContent,
      "",
      "카드 제목 자리가 빈 문자열로 남아 있으면 안 된다",
    );
  });
}

// 경계 축: title.mjs 의 deriveTitleFromBody 관점에서 "빈 문자열"과
// "공백뿐"이 같은 길로 가는지를 값으로 잰다 -- 둘 다 trim() 을 거쳐
// 똑같이 "" 가 된다(같은 길, 갈리지 않음). coder-task.md §2-1 "둘이
// 갈리면 그 사실을 적어라"의 반대 증거: 갈리지 않는다는 것 자체가 값이다.
test('경계 축: 빈 문자열 첫 줄과 공백뿐 첫 줄은 title 파생에서 같은 길(둘 다 "")로 간다', () => {
  assert.equal(deriveTitleFromBody(""), "");
  assert.equal(deriveTitleFromBody("   "), "");
  assert.equal(deriveTitleFromBody("\t"), "");
  assert.equal(deriveTitleFromBody("\u3000"), "");
  // 그래서 렌더러 쪽에서도 두 경우가 같은 카드 모양(임시 문구)으로 나온다.
  const container = document.createElement("div");
  renderMemoList(
    container,
    [memo("empty-title", { title: "" }), memo("blank-title", { title: "" })],
    { onOpen: () => {} },
  );
  const titles = [...container.querySelectorAll(".memo-card-title")].map(
    (el) => el.textContent,
  );
  assert.deepEqual(titles, [
    UNTITLED_MEMO_PLACEHOLDER,
    UNTITLED_MEMO_PLACEHOLDER,
  ]);
});

// 경계 축(검토 1R P2-1): "제목이 있는데 앞에 공백이 붙은 경우"는 위 공백
// 축(첫 줄이 공백뿐)과 다른 길이다 -- trim() 이 앞뒤 공백만 걷어내고
// 제목 글자는 그대로 남기므로 "" 가 아니다. 동작은 이미 옳다(검토자
// 실측값과 동일), 이 시험은 그 덮개 구멍만 메운다.
for (const [label, rawFirstLine] of [
  ["스페이스", "   제목이 있다"],
  ["탭", "\t제목이 있다"],
  ["전각 공백(보이지 않는 글자)", "　제목이 있다"],
]) {
  test(`경계 축(${label} 뒤 제목): 첫 줄 앞에 공백이 있어도 title 은 공백만 걷어낸 제목 글자다("" 로 접히지 않는다)`, () => {
    assert.equal(
      deriveTitleFromBody(rawFirstLine),
      "제목이 있다",
      `deriveTitleFromBody(${JSON.stringify(rawFirstLine)}) 는 앞 공백만 걷어낸 "제목이 있다" 여야 한다`,
    );

    const container = document.createElement("div");
    renderMemoList(
      container,
      [memo("leading-ws-title", { title: "제목이 있다" })],
      {
        onOpen: () => {},
      },
    );
    const titleEl = container.querySelector(".memo-card-title");
    assert.equal(
      titleEl.textContent,
      "제목이 있다",
      "제목이 있는 카드는 임시 문구가 아니라 그 제목 글자를 그대로 보여야 한다",
    );
    assert.notEqual(
      titleEl.textContent,
      UNTITLED_MEMO_PLACEHOLDER,
      "앞에 공백만 있을 뿐 제목이 있으므로 임시 문구(이름 없는 카드)로 보이면 안 된다",
    );
  });
}

// 무해 축: 제목이 있는 메모는 이 수리로 하나도 안 바뀐다 -- 위 "제목 축"
// 시험(줄 120)이 이미 이걸 재고 있지만, 여기서도 명시로 한 번 더 값으로
// 박아 둔다(전/후 비교가 이 결과 파일 §4-6 의 요구다).
test("무해 축: 제목이 있는 메모는 그대로다(임시 문구로 바뀌지 않음)", () => {
  const container = document.createElement("div");
  renderMemoList(
    container,
    [memo("has-title", { title: "평범한 메모 제목" })],
    {
      onOpen: () => {},
    },
  );
  const titleEl = container.querySelector(".memo-card-title");
  assert.equal(titleEl.textContent, "평범한 메모 제목");
  assert.notEqual(titleEl.textContent, UNTITLED_MEMO_PLACEHOLDER);
});
