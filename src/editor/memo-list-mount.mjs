// storage-mount.mjs 와 같은 자리(app.mjs 배선 vs fake adapter 로 직접
// 재는 시험 대상)의 목록 화면 쪽 짝(coder-task.md §0-1). adapter.list()
// -> list-query.mjs 의 정렬·필터 -> memo-list-view.mjs 의 DOM 렌더까지
// 한 호출로 잇는다.
import { visibleMemosSortedByUpdatedAt } from "../storage/list-query.mjs";
import {
  renderMemoList,
  renderMemoListError,
  SAVE_ERROR_MESSAGE,
} from "./memo-list-view.mjs";
import { createSoftDeleteLifecycle } from "../storage/memo-lifecycle.mjs";

// PRD §5.5 수용 기준③ "7초 경과 시 hard delete" -- memo-lifecycle.mjs
// 자신의 GRACE_MS(7000, 그 파일 내부 상수라 export 되지 않음 -- 데이터
// 계층은 호출만 하고 고치지 말라는 범위 제약, coder-task.md §0)와 같은
// 길이로 되돌리기 토스트를 띄워 둔다. 두 숫자가 같은 값을 "따로" 들고
// 있는 것이라 memo-lifecycle.mjs 의 기본값이 바뀌면 이 숫자도 같이
// 바꿔야 한다(결과 파일 §한계에 기록). export 하는 이유: 검토 2R
// P3-3 -- 이 값을 그대로 아래 createLifecycle(adapter, { graceMs }) 로
// "명시로" 넘기는 줄이 지워져도(데이터 계층 기본값과 우연히 같은 7000
// 이라) 시험이 타이밍만으로는 못 가른다. 시험은 이 상수를 import 해
// createLifecycle 스파이에 실제로 전달된 값과 직접 비교한다(결과 파일
// §2-3 참고, test/editor/memo-list-delete-undo.test.mjs).
export const UNDO_TOAST_MS = 7000;

// 책임자 판정 §2(위치 요구): 되돌리기 토스트와 저장 실패 표시가 같은
// 고정 영역(toast)을 나눠 쓴다 -- 그 상태 기계를 mountMemoList 밖으로
// 뽑아낸 것뿐이다(그 함수 하나가 80줄 제한을 넘기지 않도록, ESLint
// max-lines-per-function). active = 지금 토스트가 책임지는 되돌리기
// { id, handler } · errorState = 지금 떠 있는 저장 실패 재시도
// { id, onClick }. errorState 가 id 를 들고 있어야 "A 의 되돌리기가
// 성공했다고 B 의 아직 안 풀린 실패 표시까지 같이 지워지는" 교차
// 오염을 막는다(두 상태가 같은 영역을 나눠 쓸 때의 설계 선택 · 결과
// 파일 §한계에 교차 사례 1건 기록).
function createToastController(toast) {
  let active = null;
  let errorState = null;

  // 이 영역 하나로 "되돌리기 토스트"와 "저장 실패 표시"를 둘 다
  // 그린다(책임자 결정: 같은 고정 위치 · 같은 사용자 모델). 가시성은
  // 상태 두 가지(undo 활성·error 활성)의 조합으로만 정해진다 -- 상태가
  // 바뀌는 모든 자리(아래 각 함수)가 끝에 이 함수를 불러 DOM 을 그
  // 상태에 맞춘다. 되돌리기 쪽 실패 중에도 "되돌리기" 버튼 자체는
  // active 가 쥐고 있으니 그대로 눌러 재시도할 수 있다(요구 ⓒ) -- 반면
  // "토스트가 이미 떠 있는 동안 다른 메모의 저장이 실패"하면(요구 ⓑ)
  // errorState 가 별도로 켜져 두 버튼이 한 영역에 나란히 뜬다. 텍스트
  // 슬롯(textEl)은 실패 표시가 있는 동안엔 숨긴다 -- "실패 표시가 그
  // 자리를 대신한다"(책임자 결정 원문)를 그대로 옮긴 것.
  function syncToastVisibility() {
    if (!toast) return;
    const hasUndo = active !== null;
    const hasError = errorState !== null;
    toast.element.hidden = !(hasUndo || hasError);
    if (toast.textEl) toast.textEl.hidden = hasError;
    if (toast.undoButton) toast.undoButton.hidden = !hasUndo;
    if (toast.errorButton) {
      toast.errorButton.hidden = !hasError;
      if (hasError) toast.errorButton.textContent = SAVE_ERROR_MESSAGE;
    }
  }

  function detachActiveUndo() {
    if (!active || !toast) return;
    toast.undoButton.removeEventListener("click", active.handler);
    active = null;
    syncToastVisibility();
  }

  function clearSaveErrorFor(id) {
    if (!errorState || errorState.id !== id) return;
    if (toast?.errorButton) {
      toast.errorButton.removeEventListener("click", errorState.onClick);
    }
    errorState = null;
    syncToastVisibility();
  }

  function showSaveError(id, retry) {
    if (!toast || !toast.errorButton) return;
    if (errorState) {
      toast.errorButton.removeEventListener("click", errorState.onClick);
    }
    const onClick = () => retry();
    errorState = { id, onClick };
    toast.errorButton.addEventListener("click", onClick);
    syncToastVisibility();
  }

  // 연속 삭제(ⓕ)에서 새 토스트가 뜰 때 이전 되돌리기 리스너가 남아
  // 엉뚱한 id 를 복원하지 않도록, 호출부(showUndoToast)가 이 함수
  // 전에 반드시 detachActiveUndo() 를 불러 떼어낸다.
  function setActiveUndo(id, handler) {
    active = { id, handler };
    if (toast) {
      toast.undoButton.addEventListener("click", handler);
      toast.element.dataset.memoId = id;
    }
    syncToastVisibility();
  }

  return { detachActiveUndo, clearSaveErrorFor, showSaveError, setActiveUndo };
}

// PRD §5b "실행→입력 1초 내 -- 입력이 목록 로딩을 안 기다린다": 이 함수는
// adapter.list() 를 기다리는 refresh() 를 리턴만 하고, mountMemoList
// 자신은 그 Promise 를 기다리지 않는다(app.mjs 가 mountMemoList 를 부른
// 뒤 바로 이어서 에디터를 마운트한다 -- 에디터 쪽 registerUpdateListener
// 등록은 이 목록 로딩과 무관한 별개 코드 경로라 이 fetch 가 끝나지
// 않아도 입력을 막지 않는다).
//
// coder-task.md §2 (P2-1): app.mjs 가 이 refresh() 를 fire-and-forget 으로
// 부르므로(main() 이 기다리지 않는다), adapter.list() 가 거부되면 그
// 거부가 여기서 잡히지 않는 한 unhandledRejection 으로 새 나간다 --
// 화면은 "제목 + 빈 본문"뿐이고 사용자는 실패했다는 것 자체를 모른다
// (§2-1 실측). try/catch 로 그 거부를 여기서 끝내고, 실패 화면을
// 그린다. 재시도 = refresh 자기 자신을 다시 부르는 것 -- 저장 계층이
// 되살아 있으면 다음 호출은 정상 경로(renderMemoList)로 되돌아간다.
// toast(옵션) = { element, textEl, undoButton, errorButton } -- 실제 DOM
// 엘리먼트들. 생략하면(기존 호출부·시험과 그대로 호환) 삭제/되돌리기는
// 데이터 계층까지는 동작하되 토스트만 뜨지 않는다. now/setTimeoutFn/
// clearTimeoutFn 은 memo-lifecycle.mjs 의 createSoftDeleteLifecycle 과 이
// 모듈 자신의 토스트 타이머가 "같은" 가짜 시계를 쓰도록 그대로
// 넘겨준다(시험에서 7초를 결정적으로 재는 통로). createLifecycle(옵션) =
// createSoftDeleteLifecycle 자리를 대신할 팩토리 -- 기본은 실제 구현.
// 검토 2R P3-3 전용 주입 통로다: 시험이 이 자리에 스파이를 꽂아
// "graceMs 가 실제로 어떤 값으로 전달됐는지" 를 직접 관찰한다(데이터
// 계층 기본값과 우연히 같은 숫자라 타이밍만으로는 못 가르는 문제,
// §한계 참고). 제품 코드(app.mjs)는 이 옵션을 안 쓴다.
export function mountMemoList(
  container,
  adapter,
  {
    onOpen,
    toast,
    now,
    setTimeoutFn,
    clearTimeoutFn,
    createLifecycle = createSoftDeleteLifecycle,
  } = {},
) {
  // 검토 1R P2-2: graceMs 를 안 넘기면 memo-lifecycle.mjs 자신의 기본값
  // (그 파일 안에서만 보이는 GRACE_MS)을 쓰게 되어, 이 토스트의
  // UNDO_TOAST_MS 와 "우연히 같은 숫자"일 뿐 같은 원천이 아니게 된다 --
  // 데이터 계층 기본값이 바뀌면 토스트는 조용히 다른 길이로 떠 있는다.
  // 여기서 명시로 넘겨 원천을 하나로 묶는다(memo-lifecycle.mjs 자체는
  // 수정하지 않는다 -- coder-task.md §2 범위 제약).
  const lifecycle = createLifecycle(adapter, {
    now,
    setTimeoutFn,
    clearTimeoutFn,
    graceMs: UNDO_TOAST_MS,
  });
  const scheduleFn = setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelFn = clearTimeoutFn ?? ((id) => clearTimeout(id));
  const toastCtrl = createToastController(toast);

  let hideTimer = null;

  function showUndoToast(id) {
    if (!toast) return;
    cancelFn(hideTimer);
    toastCtrl.detachActiveUndo();

    const handler = async () => {
      // 검토 2R §2 ⓒ: 여기서 바로 떼어내고 감춘다(원래(1R)부터의 동작
      // 그대로) -- 실패해도 "되돌리기" 자체는 이미 끝난 일로 치고,
      // 재시도는 아래 showSaveError 가 새로 올리는 전용 표시/버튼이
      // 맡는다(이 메모 id 로 스코프됨).
      toastCtrl.detachActiveUndo();
      cancelFn(hideTimer);
      try {
        await lifecycle.restore(id);
        toastCtrl.clearSaveErrorFor(id);
        await refresh();
      } catch {
        // 검토 1R P2-3 근거 + 2R P2-1 위치 수정: 되돌리기 저장이
        // 거부돼도 unhandledRejection 으로 새면 안 된다 -- 책임자
        // 결정④ 문구를 토스트 고정 영역에 보여주고, 재시도는 이
        // handler 자신을 다시 부른다(restore 를 다시 시도).
        toastCtrl.showSaveError(id, () => handler());
      }
    };
    toastCtrl.setActiveUndo(id, handler);

    hideTimer = scheduleFn(() => {
      toastCtrl.detachActiveUndo();
    }, UNDO_TOAST_MS);
  }

  async function handleSwipeDelete(id) {
    try {
      await lifecycle.softDelete(id);
      toastCtrl.clearSaveErrorFor(id);
      await refresh();
      showUndoToast(id);
    } catch {
      // 검토 1R P2-3 근거: adapter.put 이 거부하면 이 await 가 던지고,
      // 이 함수가 pointerup 리스너(memo-list-view.mjs)에서 await 없이
      // 불리므로 그대로 두면 unhandledRejection 으로 샌다. 여기서 끝내고
      // 책임자 결정④ 문구를 토스트 고정 영역(검토 2R P2-1)에 보여준다 --
      // refresh() 를 안 불렀으니 카드는 그대로 남아 있다(P2-3 "카드
      // 남음" 요구). 이때 다른 메모의 되돌리기 토스트가 떠 있었다면
      // active 는 그대로 둬 되돌리기 버튼이 함께 보인다(요구 ⓑ).
      toastCtrl.showSaveError(id, () => handleSwipeDelete(id));
    }
  }

  async function refresh() {
    let records;
    try {
      records = await adapter.list();
    } catch {
      renderMemoListError(container, { onRetry: refresh });
      return null;
    }
    const visible = visibleMemosSortedByUpdatedAt(records);
    renderMemoList(container, visible, {
      onOpen,
      onSwipeDelete: handleSwipeDelete,
    });
    return visible;
  }

  return { refresh };
}
