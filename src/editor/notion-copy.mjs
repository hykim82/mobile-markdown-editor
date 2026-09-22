// PRD §5.4 "노션 복사" -- coder-task.md §1.
//
// ⭐구조 보장(§1-⑴): 이 파일의 어떤 함수도 editor 를 인자로 받아 그 상태를
// 다시 직렬화하지 않는다. getNotionCopyBody/performNotionCopy 는 store 만
// 받는다 -- 함수 시그니처 자체가 "렌더링 레이어를 거칠 방법이 없다"는
// 것을 강제한다. store.getBody() 는 memo-store.mjs 의 state.memo.body,
// 즉 PRD §7 "본문(마크다운 원문)" 필드 그 자체다.
export function getNotionCopyBody(store) {
  return store.getBody();
}

// §1-⑷ "빈 본문일 때 버튼 비활성" -- 원문 길이 0에만(트림 안 함, 공백·
// 마커만인 본문은 비어 있지 않다).
export function isNotionCopyDisabled(store) {
  return getNotionCopyBody(store).length === 0;
}

// 실패 경로(§1-⑸)를 실제로 재기 위해 clipboard 를 주입받는다 -- 프로덕션
// 기본값은 mountNotionCopy 에서 navigator.clipboard 로 채운다.
export async function performNotionCopy(store, clipboard) {
  const body = getNotionCopyBody(store);
  await clipboard.writeText(body);
  return body;
}

const SUCCESS_TEXT = "노션에 복사됐어요 ✓"; // GLOSSARY 확정 문구(placeholder 아님)
const ERROR_TEXT = "복사가 안 됐어요. 다시"; // GLOSSARY 확정 문구(placeholder 아님)
const SUCCESS_TOAST_MS = 2000;

function refreshDisabled(store, button) {
  button.disabled = isNotionCopyDisabled(store);
}

function showToast(toast, text, variant) {
  toast.textContent = text;
  toast.hidden = false;
  toast.dataset.variant = variant;
}

// elements = { button, toast } -- 둘 다 실제 DOM 엘리먼트.
// deps 는 시험 전용 주입 통로다(프로덕션은 항상 기본값):
//   clipboard: { writeText(text) } 계약만 만족하면 됨(navigator.clipboard 기본)
//   vibrate: 햅틱(navigator.vibrate 기본)
//   setTimeoutFn/clearTimeoutFn: 토스트 자동 숨김 타이머
export function mountNotionCopy(editor, store, elements, deps = {}) {
  const { button, toast } = elements;
  const {
    clipboard = navigator.clipboard,
    vibrate = (ms) => navigator.vibrate?.(ms),
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (id) => clearTimeout(id),
  } = deps;

  let hideTimer = null;

  refreshDisabled(store, button);
  editor.registerUpdateListener(() => {
    refreshDisabled(store, button);
  });

  button.addEventListener("click", async () => {
    if (button.disabled) return;
    clearTimeoutFn(hideTimer);
    hideTimer = null;
    try {
      await performNotionCopy(store, clipboard);
      vibrate(10);
      showToast(toast, SUCCESS_TEXT, "success");
      // 정책(PRD §5.4 수용 기준②): 성공 토스트는 2초. 복사 후 에디터는
      // 그대로 유지된다(이 핸들러는 editor.update 를 한 번도 부르지
      // 않는다 -- 그래서 커서·스크롤이 날아갈 방법이 구조적으로 없다).
      hideTimer = setTimeoutFn(() => {
        toast.hidden = true;
      }, SUCCESS_TOAST_MS);
    } catch {
      // §1-⑸ 실패 경로: 클립보드 쓰기가 실패해도 store 의 원문은 이
      // 핸들러가 손댄 적이 없으므로(store.getBody() 는 읽기 전용 조회)
      // 원문은 그대로 로컬에 남아 있다. 재시도 = 버튼을 다시 탭하는 것.
      showToast(toast, ERROR_TEXT, "error");
    }
  });
}
