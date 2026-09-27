// 메모 목록(홈) 화면의 순수 DOM 렌더러(coder-task.md §0-1). adapter 를
// 모르는 채 "이미 정렬·필터된 메모 배열을 받아 그 순서 그대로 그린다"만
// 한다 -- 순서·가시성 자체는 src/storage/list-query.mjs 가 이미 보장한
// 값이라 여기서 다시 판단하지 않는다(memo-list-mount.mjs 가 둘을 잇는다).
//
// 제목은 memo.title 필드(이미 memo-store.mjs 의 deriveTitleFromBody 가
// 한 번 계산해 저장해 둔 값)를 그대로 쓴다 -- 여기서 body 로부터 다시
// 파생하지 않는다. coder-task.md §4: deriveTitleFromBody 호출 지점을
// 하나로 유지해야, 나중(PR #6 병합 후) 그 함수가 "해독된 글자"를
// 받도록 고칠 때 고칠 자리가 한 곳뿐이다(여기서 또 계산하면 같은 버그를
// 두 곳에 심게 된다).
function pad2(n) {
  return String(n).padStart(2, "0");
}

// 수정시각 표시 -- PRD §6 "목록 최신 수정순", coder-task.md §0-1-①"제목 +
// 수정시각 정도"(정확한 문구 요구 없음). 목업(spec/mockups/list.html)의
// "방금"/"어제" 같은 상대 시각 라벨은 만들지 않는다 -- 그러려면 "지금"
// 기준이 필요해 시험이 시각에 의존하게 된다(비결정적). 대신 절대
// 타임스탬프를 그대로 보여준다 -- 결과 파일 §정직 한계에 기록.
function formatModifiedAt(updatedAt) {
  const d = new Date(updatedAt);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// coder-task.md §2-2 -- 후보 문구다(확정 아님, 한용 확정 대기). GLOSSARY
// 마이크로카피 7줄에 "제목 없음" 계열이 없어(내가 확인) 기존 문구의
// 존대·구어체 말투("아직 메모가 없어요. +로 시작" 등)를 따라 지었다.
export const UNTITLED_MEMO_PLACEHOLDER = "아직 제목이 없어요";

// 이름 없는 카드 축(§2, E3 검토 P2-9): memo.title 은 이미 저장 시점에
// deriveTitleFromBody(title.mjs) 가 trim() 해 둔 값이라, 여기서 다시
// trim() 해도 "빈 문자열"과 "공백뿐"을 가를 일이 없다(둘 다 이미 "").
// 그래도 이 화면(렌더 층)만 보고 판단하도록 방어적으로 한 번 더 trim()
// 한다 -- 저장 데이터(title 필드 자체)는 바꾸지 않고 "보이는 것"만
// 대체하는 쪽을 골랐다: title.mjs 의 파생 규칙을 바꾸면 그 값이 그대로
// DB 에 다시 쓰여 "저장 데이터를 바꾸지 마라"(§2-1)와 충돌할 여지가
// 생기지만, 렌더 층 대체는 body 바이트·updatedAt 은 물론 title 필드
// 자체도 건드리지 않는다.
function displayTitle(title) {
  return title.trim() === "" ? UNTITLED_MEMO_PLACEHOLDER : title;
}

function buildMemoCard(memo, onOpen) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "memo-card";
  card.dataset.memoId = memo.id;

  const title = document.createElement("div");
  title.className = "memo-card-title";
  title.textContent = displayTitle(memo.title);

  const meta = document.createElement("div");
  meta.className = "memo-card-meta";
  meta.textContent = formatModifiedAt(memo.updatedAt);

  card.append(title, meta);
  card.addEventListener("click", () => onOpen(memo.id));
  return card;
}

function buildEmptyState(message) {
  const empty = document.createElement("div");
  empty.className = "memo-list-empty";
  empty.textContent = message;
  return empty;
}

// coder-task.md §0-1-③ 빈 목록 상태: 문구는 spec/GLOSSARY.md "마이크로카피
// -- 목록 빈 상태" 고정 문구를 그대로 쓴다.
export const EMPTY_LIST_MESSAGE = "아직 메모가 없어요. +로 시작";

// coder-task.md §2-2 정본 문면: spec/GLOSSARY.md "마이크로카피 -- 목록
// 오류" 고정 문구. "다시" 는 그 자리에서 누를 수 있어야 하므로(§2-2)
// 문구 전체를 버튼으로 만든다 -- 클래스명을 EMPTY_LIST_MESSAGE 쪽
// (.memo-list-empty)과 다르게 둬 "메모 0개 정상"과 "조회 실패"가 항상
// 서로 다른 화면으로 구별된다(§2-3 구별 축).
export const LIST_ERROR_MESSAGE = "불러오기 실패 · 다시";

function buildErrorState(message, onRetry) {
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "memo-list-error";
  retry.textContent = message;
  retry.addEventListener("click", () => onRetry());
  return retry;
}

// PRD §8 정책 "목록 불러오기 실패 = 재시도, 저장 파일 훼손 없음(읽기
// 전용 실패)": 이 함수는 DOM 만 그린다 -- 저장 계층을 다시 조회하는
// 실제 재시도는 onRetry 콜백(memo-list-mount.mjs 의 refresh)이 한다.
export function renderMemoListError(container, { onRetry }) {
  container.textContent = "";
  container.append(buildErrorState(LIST_ERROR_MESSAGE, onRetry));
}

// memos 는 이미 src/storage/list-query.mjs 가 정렬·필터해 둔 배열이어야
// 한다 -- 이 함수는 그 순서를 그대로 DOM 순서로 옮길 뿐이다.
export function renderMemoList(
  container,
  memos,
  { onOpen, emptyMessage = EMPTY_LIST_MESSAGE } = {},
) {
  container.textContent = "";
  if (memos.length === 0) {
    container.append(buildEmptyState(emptyMessage));
    return;
  }
  for (const memo of memos) {
    container.append(buildMemoCard(memo, onOpen));
  }
}
