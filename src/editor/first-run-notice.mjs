// PRD §5b NFR 접근성·프라이버시: "최초 실행 1회 고지 '메모는 이 기기에만
// 저장됩니다'" / §8 보존 "최초 실행 1회 조용한 고지"(coder-task.md §1).
// "조용한" = 모달 대화상자(입력을 막는 것)가 아니라, 입력을 막지 않는
// 작은 안내다(§6 "없는 듯한 모션"·"크롬 숨김", 실행→입력 1초 NFR을
// 지킨다 -- coder-task.md §1 이 ORCH 해석으로 남겨 둔 자리, 근거는 결과
// 파일 §선택 근거). "봤다" 기록은 current-memo-pointer.mjs 와 같은
// localStorage try/catch 관례를 따른다(coder-task.md product_scope) --
// 메모 저장소(IndexedDB)와는 별개 저장소라 이 기록이 실패해도 메모
// 데이터는 안전하다. window.localStorage 로 접근한다(bare localStorage
// 가 아님) -- eslint.config.mjs 의 전역 허용 목록이 src/editor/**
// 에는 document/window/navigator 만 열어 뒀고(src/storage/** 와 다른
// 경계, HYK-304-storage-1 주석 참고), window 를 거치면 그 경계를 넓히지
// 않고도 같은 전역을 쓸 수 있다.
const KEY = "mobile-markdown-editor:first-run-notice-seen";

// PRD §5b 문구 원문 그대로(바꾸지 않는다) -- 시험은 이 상수를 import 해
// 비교하지 않고 문자열 리터럴로 재확인한다(coder-task.md §2 요구
// 3-ⓐ: 상수를 import 해 비교하면 문구가 바뀌어도 초록이라는 E1 검토
// P3-5 지적을 피한다).
export const FIRST_RUN_NOTICE_TEXT = "메모는 이 기기에만 저장됩니다";

// 기록 읽기가 실패하면(사생활 모드 등) "본 적 없음"으로 본다 -- 침묵
// 처리(읽기 실패 = 이미 봤다고 치고 안 보여줌)보다, 프라이버시 고지라는
// 내용 특성상 "보여주는 쪽"을 기본값으로 삼았다(coder-task.md §2 요구 2
// "고지가 매번 뜨는지/안 뜨는지는 네가 정하고 근거를 적어라" -- 제품
// 결정, 결과 파일 §선택 근거에 "상신 후보"로 남긴다).
function hasSeenNotice() {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function recordSeen() {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // 기록 자체가 막힌 환경 -- "다시 안 뜸" 보장만 포기한다(current-memo
    // -pointer.mjs 와 같은 삼킴 선례). 앱 동작·입력은 이 실패와 무관하게
    // 계속된다.
  }
}

// elements = { element, textEl, closeButton } -- 전부 실제 DOM(app.mjs
// grabElements 결선 전용). element 가 없으면(옛 index.html·시험 사본)
// 아무 일도 하지 않는다 -- app-wiring 배선 6/7 과 같은 결손 허용 선례.
export function mountFirstRunNotice({ element, textEl, closeButton } = {}) {
  if (!element) return;
  if (hasSeenNotice()) {
    element.hidden = true;
    return;
  }
  if (textEl) textEl.textContent = FIRST_RUN_NOTICE_TEXT;
  element.hidden = false;
  const onClose = () => {
    element.hidden = true;
    recordSeen();
  };
  closeButton?.addEventListener("click", onClose);
}
