// PRD §5.5/§8 삭제(soft): 스와이프 soft delete + 되돌리기 토스트, 7초
// 뒤 hard delete. 이 조각은 데이터 계층만 다룬다 -- 스와이프 UI·토스트는
// 메모 목록(홈) 화면 몫이라 이 이슈 범위 밖이다(coder-task.md §2-3).
const GRACE_MS = 7000;

// memo-store.mjs 의 buildConfig 와 같은 이유(실기기 실측 버그, 그 파일
// 머리 주석 참고): setTimeout/clearTimeout 을 레퍼런스 그대로 기본값으로
// 두면 실제 브라우저에서 "Illegal invocation" 이 난다 -- 화살표 함수로
// 감싸 this 문제를 없앤다.
export function createSoftDeleteLifecycle(adapter, options = {}) {
  const graceMs = options.graceMs ?? GRACE_MS;
  const now = options.now ?? (() => Date.now());
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((id) => clearTimeout(id));

  const pendingHardDeletes = new Map();

  function cancelPending(id) {
    const pending = pendingHardDeletes.get(id);
    if (pending) {
      clearTimeoutFn(pending);
      pendingHardDeletes.delete(id);
    }
  }

  async function softDelete(id) {
    const memo = await adapter.get(id);
    if (!memo) return null;
    const updated = { ...memo, deletedAt: now() };
    await adapter.put(updated);
    cancelPending(id);
    const timer = setTimeoutFn(() => {
      pendingHardDeletes.delete(id);
      adapter.remove(id);
    }, graceMs);
    pendingHardDeletes.set(id, timer);
    return updated;
  }

  // 되돌리기: 삭제시각을 null로 되돌리고, 아직 안 지난 7초 하드 삭제
  // 예약이 있으면 취소한다 -- 안 그러면 "되돌렸는데 몇 초 뒤 사라짐"이
  // 된다.
  async function restore(id) {
    cancelPending(id);
    const memo = await adapter.get(id);
    if (!memo) return null;
    const updated = { ...memo, deletedAt: null };
    await adapter.put(updated);
    return updated;
  }

  return { softDelete, restore };
}
