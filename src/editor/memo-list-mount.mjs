// storage-mount.mjs 와 같은 자리(app.mjs 배선 vs fake adapter 로 직접
// 재는 시험 대상)의 목록 화면 쪽 짝(coder-task.md §0-1). adapter.list()
// -> list-query.mjs 의 정렬·필터 -> memo-list-view.mjs 의 DOM 렌더까지
// 한 호출로 잇는다.
import { visibleMemosSortedByUpdatedAt } from "../storage/list-query.mjs";
import { renderMemoList, renderMemoListError } from "./memo-list-view.mjs";
import { createSoftDeleteLifecycle } from "../storage/memo-lifecycle.mjs";

// PRD §5.5 수용 기준③ "7초 경과 시 hard delete" -- memo-lifecycle.mjs
// 자신의 GRACE_MS(7000, 그 파일 내부 상수라 export 되지 않음 -- 데이터
// 계층은 호출만 하고 고치지 말라는 범위 제약, coder-task.md §0)와 같은
// 길이로 되돌리기 토스트를 띄워 둔다. 두 숫자가 같은 값을 "따로" 들고
// 있는 것이라 memo-lifecycle.mjs 의 기본값이 바뀌면 이 숫자도 같이
// 바꿔야 한다(결과 파일 §한계에 기록).
const UNDO_TOAST_MS = 7000;

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
// toast(옵션) = { element, undoButton } -- 실제 DOM 엘리먼트 둘. 생략하면
// (기존 호출부·시험과 그대로 호환) 삭제/되돌리기는 데이터 계층까지는
// 동작하되 토스트만 뜨지 않는다. now/setTimeoutFn/clearTimeoutFn 은
// memo-lifecycle.mjs 의 createSoftDeleteLifecycle 과 이 모듈 자신의
// 토스트 타이머가 "같은" 가짜 시계를 쓰도록 그대로 넘겨준다(시험에서
// 7초를 결정적으로 재는 통로).
export function mountMemoList(
  container,
  adapter,
  { onOpen, toast, now, setTimeoutFn, clearTimeoutFn } = {},
) {
  const lifecycle = createSoftDeleteLifecycle(adapter, {
    now,
    setTimeoutFn,
    clearTimeoutFn,
  });
  const scheduleFn = setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelFn = clearTimeoutFn ?? ((id) => clearTimeout(id));

  let hideTimer = null;
  // 토스트가 "지금 누구의 되돌리기를 책임지는지" -- 연속 삭제(ⓕ)에서 새
  // 토스트가 뜰 때 이전 되돌리기 리스너가 남아 엉뚱한 id를 복원하지
  // 않도록 교체 시점에 반드시 떼어낸다.
  let active = null;

  function detachActiveUndo() {
    if (!active || !toast) return;
    toast.undoButton.removeEventListener("click", active.handler);
    active = null;
  }

  function showUndoToast(id) {
    if (!toast) return;
    cancelFn(hideTimer);
    detachActiveUndo();

    const handler = async () => {
      detachActiveUndo();
      cancelFn(hideTimer);
      toast.element.hidden = true;
      await lifecycle.restore(id);
      await refresh();
    };
    active = { id, handler };
    toast.undoButton.addEventListener("click", handler);
    toast.element.hidden = false;
    toast.element.dataset.memoId = id;

    hideTimer = scheduleFn(() => {
      toast.element.hidden = true;
      detachActiveUndo();
    }, UNDO_TOAST_MS);
  }

  async function handleSwipeDelete(id) {
    await lifecycle.softDelete(id);
    await refresh();
    showUndoToast(id);
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
