// PRD §2 성공·검증 지표 3개(주간 재사용·세션당 노션 복사·입력취소·재입력
// 빈도) -- coder-task.md §1 책임자 판정 B: 메모 "내용"은 한 글자도 안 쓰고,
// 폰 안 localStorage 숫자 카운터 하나로만 잰다(외부 전송 0 · IndexedDB
// 스키마 무변). 통계 카드 진입은 목록 제목 길게 누르기뿐이다(결선은
// app.mjs 의 mountUsageStatsCard 호출 1줄).
//
// first-run-notice.mjs/current-memo-pointer.mjs 와 같은 try/catch 관례:
// 읽기·쓰기가 막혀도(사생활 모드 등) 던지지 않고 카운터만 0으로 시작한다
// -- 이 파일이 실패해도 메모 저장(IndexedDB)과는 완전히 분리된 저장소라
// 메모 데이터는 영향이 없다. eslint.config.mjs 의 src/editor/** 전역
// 허용 목록(document/window/navigator)을 넘지 않으려고 bare localStorage
// 대신 window.localStorage 로 접근한다(first-run-notice.mjs 머리 주석과
// 같은 경계 근거).
import { UNDO_COMMAND, COMMAND_PRIORITY_LOW } from "lexical";

const KEY = "mobile-markdown-editor:usage-metrics";

// 최근 8주(약 2개월)만 보관한다 -- 통계 카드는 "이번 주·지난주" 두
// 버킷만 보여주므로 그보다 오래된 버킷은 읽히지 않는다. 상한을 두는
// 이유는 localStorage 가 무한정 커지지 않게 막는 것뿐이다(8주 = 주마다
// 한 줄씩 쌓여도 작은 고정 크기).
const MAX_WEEKS = 8;

const METRIC_KEYS = ["opens", "newMemos", "copies", "undos", "retypes"];

function emptyWeekBucket() {
  return { opens: 0, newMemos: 0, copies: 0, undos: 0, retypes: 0 };
}

// 주 경계 = 월요일 0시 «로컬»(폰 시계 기준, PRD §2 "주 단위" 그대로) --
// Date#getDay() 는 일요일=0 이므로 (day+6)%7 로 "월요일부터 며칠 지났는지"
// 를 구해 그만큼 날짜를 당긴다. 반환값은 그 월요일의 로컬 날짜 문자열
// (YYYY-MM-DD)이라 사전식 정렬이 그대로 시간 순서와 같다(문자열 비교로
// 최신/오래된 버킷을 가를 수 있다).
function weekKeyFor(date) {
  const d = new Date(date.getTime());
  const daysSinceMonday = (d.getDay() + 6) % 7;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysSinceMonday);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function isValidBucket(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    METRIC_KEYS.every((key) => typeof value[key] === "number")
  );
}

// 읽기 실패(사생활 모드·값 없음)·JSON 파손·모양이 기대와 다름 -- 전부
// "빈 저장소"로 본다(던지지 않는다, coder-task.md §2 요구 1). 파손된
// 주 버킷은 통째로 버리고 멀쩡한 주만 남긴다(한 주가 깨졌다고 전체를
// 버리면 그만큼 더 잃는다).
function readStore() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { weeks: {} };
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.weeks !== "object" ||
      parsed.weeks === null
    ) {
      return { weeks: {} };
    }
    const weeks = {};
    for (const [week, bucket] of Object.entries(parsed.weeks)) {
      if (isValidBucket(bucket)) weeks[week] = bucket;
    }
    return { weeks };
  } catch {
    return { weeks: {} };
  }
}

// 최근 MAX_WEEKS 주만 남긴다(키가 YYYY-MM-DD 라 문자열 내림차순 = 최신
// 순서). 저장 막힘(쓰기 실패)은 삼킨다 -- "다시 안 쌓임"만 포기한다
// (current-memo-pointer.mjs 와 같은 삼킴 선례).
function writeStore(store) {
  const sortedWeeks = Object.keys(store.weeks).sort().reverse();
  const kept = sortedWeeks.slice(0, MAX_WEEKS);
  const weeks = {};
  for (const week of kept) weeks[week] = store.weeks[week];
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ weeks }));
  } catch {
    // 메모 데이터와는 완전히 별개 저장소라 이 실패가 앱 동작에 새지 않는다.
  }
}

function bumpMetric(metricKey, { now = () => new Date() } = {}) {
  const store = readStore();
  const week = weekKeyFor(now());
  if (!store.weeks[week]) store.weeks[week] = emptyWeekBucket();
  store.weeks[week][metricKey] += 1;
  writeStore(store);
}

export function recordAppOpen(options) {
  bumpMetric("opens", options);
}
export function recordNewMemo(options) {
  bumpMetric("newMemos", options);
}
export function recordCopySuccess(options) {
  bumpMetric("copies", options);
}
export function recordUndo(options) {
  bumpMetric("undos", options);
}
export function recordRetypeEstimate(options) {
  bumpMetric("retypes", options);
}

// 통계 카드가 읽는 통로 -- "이번 주"와 지난주 월요일 키를 각각 구해(7일
// 전 날짜를 weekKeyFor 에 넣으면 같은 주 경계 규칙으로 지난주 월요일이
// 나온다), 버킷이 없으면(그 주에 아무 일도 안 생겼으면) 0 다섯 개를
// 돌려준다.
export function readRecentWeeks({ now = () => new Date() } = {}) {
  const store = readStore();
  const current = now();
  const lastWeekDate = new Date(current.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thisWeekKey = weekKeyFor(current);
  const lastWeekKey = weekKeyFor(lastWeekDate);
  return {
    thisWeek: store.weeks[thisWeekKey] ?? emptyWeekBucket(),
    lastWeek: store.weeks[lastWeekKey] ?? emptyWeekBucket(),
  };
}

// -- 통계 카드: 목록 제목 길게 누르기로만 열린다 -----------------------

const LONG_PRESS_MS = 600; // 네이티브 길게 누르기 관례치(500~600ms) 근방 -- 토큰에 없는 상호작용 시간이라 리터럴(SWIPE_THRESHOLD_PX 와 같은 선례, memo-list-view.mjs).

function renderUsageStatsCard(card, { now = () => new Date() } = {}) {
  const { thisWeek, lastWeek } = readRecentWeeks({ now });
  for (const metric of METRIC_KEYS) {
    const thisCell = card.querySelector(
      `[data-metric="${metric}"][data-period="this"]`,
    );
    const lastCell = card.querySelector(
      `[data-metric="${metric}"][data-period="last"]`,
    );
    if (thisCell) thisCell.textContent = String(thisWeek[metric]);
    if (lastCell) lastCell.textContent = String(lastWeek[metric]);
  }
}

// elements = { trigger, card, closeButton } -- trigger 는 목록 제목(h1),
// card/closeButton 은 평소엔 hidden 인 통계 카드 자신. 셋 중 하나라도
// 없으면(옛 index.html·시험 사본) 아무 일도 하지 않는다(app-wiring 결손
// 허용 선례, first-run-notice.mjs 와 같은 가드).
export function mountUsageStatsCard(
  { trigger, card, closeButton } = {},
  { now = () => new Date(), longPressMs = LONG_PRESS_MS } = {},
) {
  if (!trigger || !card) return;
  let timer = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const openCard = () => {
    renderUsageStatsCard(card, { now });
    card.hidden = false;
  };

  // pointerdown 에서 타이머를 걸고, 그 전에 pointerup/pointercancel/
  // pointerleave 가 오면 "짧은 탭"이라 취소한다(memo-list-view.mjs 의
  // pointerdown/up 패턴과 같은 모양 -- 마우스·터치를 포인터 이벤트
  // 하나로 함께 다룬다).
  trigger.addEventListener("pointerdown", () => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      openCard();
    }, longPressMs);
  });
  trigger.addEventListener("pointerup", clearTimer);
  trigger.addEventListener("pointercancel", clearTimer);
  trigger.addEventListener("pointerleave", clearTimer);

  closeButton?.addEventListener("click", () => {
    card.hidden = true;
  });
}

// -- 편집 입력 리스너: 실행취소·재입력 추정 ------------------------------
//
// §1 ORCH 해석(coder-task.md) + HYK-304-undo-finish-1(E21 검토 1R P2-3
// 상신 수리): 실행취소 횟수 = 편집 실행취소 "명령" 횟수(입력 경로 무관,
// 판정 0845 §1 ⓐ 보충) -- beforeinput inputType==="historyUndo" 만 보면
// 키보드 Ctrl/Meta+Z(lexical 코어가 keydown 에서 바로 UNDO_COMMAND 를
// 디스패치 -- LexicalEvents.ts:1725 prevent('z', CONTROL_OR_META,
// UNDO_COMMAND) -- beforeinput 을 아예 거치지 않는다)가 안 잡힌다. 두
// 경로 모두 결국 UNDO_COMMAND 로 모인다(OS 네이티브 historyUndo 도
// LexicalEvents.ts:1227 dispatchCommand(editor, UNDO_COMMAND) 를 거친다)
// -- 그래서 beforeinput 대신 editor.registerCommand(UNDO_COMMAND, ...)
// 하나로 두 경로를 "명령 1회 = 계수 1회"로 센다(아래 registerCommand 호출).
// 재입력 추정 = 3글자 이상 «연속» 지우기(=연속된 delete* 타입
// beforeinput, 근거: backspace 1회 = beforeinput 1회이므로 3회 연속
// backspace ≈ 3자 지우기) 뒤 5초 안에 다시 입력(insert* 타입)하면 1회로
// 센다.
//
// 2R(검토 1R P1-1 반려 수리, 책임자 판정 2026-10-23 15:45 §1 A): 한글
// 조합 중(editor.isComposing())에는 «delete 계열만» 무시한다(연속 지우기
// 판정에 넣지 않는다 -- 조합 안에서 지우는 것은 "다시 지우기 시작"이
// 아니다). insert 계열(= IME 조합이 글자를 밀어 넣는 insertCompositionText)
// 은 무시하지 않고 그대로 아래 isInsertInputType 분기를 탄다 -- 그래서
// 지우기 3회 뒤 한글로 "다시 입력"하면 그 조합의 첫 insertCompositionText
// 에서 재입력 1회가 잡힌다. 같은 조합 안에서 뒤이어 오는
// insertCompositionText 들은 중복 계수되지 않는다 -- 첫 번째가 이미
// pendingRetypeSince 를 null 로 되돌려 놔서(아래 isInsertInputType 분기
// 공통 로직), 그 뒤 호출은 "참 조건"을 다시 만들 조건(pendingRetypeSince
// !== null)이 거짓이라 자연히 걸러진다(조합별 상태를 따로 두지 않아도
// 된다).
const RETYPE_THRESHOLD = 3;
const RETYPE_WINDOW_MS = 5000;

function isDeleteInputType(inputType) {
  return typeof inputType === "string" && inputType.startsWith("delete");
}
function isInsertInputType(inputType) {
  return typeof inputType === "string" && inputType.startsWith("insert");
}

// editor = product-editor.mjs 가 만든 lexical 에디터(createProductEditor
// 가 이 함수를 부른다, coder-task.md product_scope "편집 입력 리스너").
// registerRootListener 는 checkbox-tap.mjs 와 같은 선례 -- root(실제
// contenteditable DOM)가 바뀔 때마다 이전 리스너를 떼고 새로 단다.
export function registerUsageInputTracking(editor, options = {}) {
  const { now = () => Date.now() } = options;
  let deleteStreak = 0;
  let pendingRetypeSince = null;
  let detachGuard = null;

  const handleBeforeInput = (event) => {
    const inputType = event.inputType;
    // 조합 중에는 delete 계열만 무시한다(위 §1 ORCH 해석 2R) -- insert
    // 계열(insertCompositionText 포함)·historyUndo 는 그대로 아래로
    // 흘러 평소 판정을 탄다. historyUndo 자체의 계수는 이제 아래
    // registerCommand(UNDO_COMMAND) 가 맡는다(이 함수는 "그 밖의 입력"
    // 분기로 떨어져 연속 지우기 흐름만 끊는다 -- 중복 계수 0).
    if (editor.isComposing() && isDeleteInputType(inputType)) return;
    if (isDeleteInputType(inputType)) {
      deleteStreak += 1;
      if (deleteStreak >= RETYPE_THRESHOLD) pendingRetypeSince = now();
      return;
    }
    if (isInsertInputType(inputType)) {
      if (
        pendingRetypeSince !== null &&
        now() - pendingRetypeSince <= RETYPE_WINDOW_MS
      ) {
        recordRetypeEstimate();
      }
      deleteStreak = 0;
      pendingRetypeSince = null;
      return;
    }
    // 그 밖의 입력(서식 명령 등)은 연속 지우기 흐름을 끊는다.
    deleteStreak = 0;
    pendingRetypeSince = null;
  };

  const unregisterRootListener = editor.registerRootListener((root) => {
    if (detachGuard) detachGuard();
    detachGuard = null;
    if (!root) return;
    root.addEventListener("beforeinput", handleBeforeInput);
    detachGuard = () => {
      root.removeEventListener("beforeinput", handleBeforeInput);
    };
  });

  // UNDO_COMMAND: 키보드(keydown -> 바로 이 커맨드)·OS 네이티브(beforeinput
  // historyUndo -> 이 커맨드로 위임, 위 머리 주석) 두 경로가 여기로 모인다.
  // COMMAND_PRIORITY_LOW(=1)는 registerHistory 의 실제 undo 리스너(등록
  // 우선순위 COMMAND_PRIORITY_EDITOR=0)보다 높아 먼저 불리지만, false 를
  // 돌려줘 전파를 막지 않는다 -- 그래서 같은 커맨드 디스패치 안에서 계수와
  // 실제 실행취소가 둘 다 일어나고(순서 무관, 서로 다른 일), 디스패치 1회
  // = 계수 1회로 고정된다(키보드·OS 두 경로 각각 이 디스패치를 1번씩만
  // 만든다 -- 중복 계수 0).
  const handleUndoCommand = () => {
    recordUndo();
    deleteStreak = 0;
    pendingRetypeSince = null;
    return false;
  };
  const unregisterUndoCommand = editor.registerCommand(
    UNDO_COMMAND,
    handleUndoCommand,
    COMMAND_PRIORITY_LOW,
  );

  return () => {
    if (detachGuard) detachGuard();
    detachGuard = null;
    unregisterRootListener();
    unregisterUndoCommand();
  };
}
