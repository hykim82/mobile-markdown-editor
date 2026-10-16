// PRD §5.5/§8 삭제(soft): 스와이프 soft delete + 되돌리기 토스트, 7초
// 뒤 hard delete. 이 조각은 데이터 계층만 다룬다 -- 스와이프 UI·토스트는
// 메모 목록(홈) 화면 몫이라 이 이슈 범위 밖이다(coder-task.md §2-3).
import { expiredDeletedMemoIds } from "./list-query.mjs";

// HYK-304-lifecycle-orphans-1: cleanupExpiredDeletes(아래)도 이 상수를
// "기본값"으로 그대로 쓴다 -- memo-list-mount.mjs 의 UNDO_TOAST_MS 와
// 같은 "한 원천"(이 파일 자신의 7000)을 가리킨다. export 하는 이유는
// app.mjs 시작 결선이 이 숫자를 새로 박지 않고 cleanupExpiredDeletes 의
// 기본 인자 그대로(옵션 생략) 쓰기 때문이다.
export const GRACE_MS = 7000;

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
      // HYK-304-lifecycle-orphans-1 ⓒ: remove() 가 거부해도 삼키지 않고
      // "다음 시작 정리에 맡김" 쪽으로 처리한다 -- deletedAt 은 이미 put
      // 으로 저장돼 있으므로(위 softDelete), 지금 실패해도 레코드는
      // deletedAt 이 찍힌 채 남아 cleanupExpiredDeletes(아래)가 다음
      // 시작 때 같은 id 를 다시 집어내 재시도한다(ⓐ와 연결). 여기서
      // 그냥 두면 타이머 콜백이라 try/catch 로 못 잡고 unhandledRejection
      // 으로 샌다.
      Promise.resolve(adapter.remove(id)).catch(() => {});
    }, graceMs);
    pendingHardDeletes.set(id, timer);
    return updated;
  }

  // 되돌리기: 삭제시각을 null로 되돌리고, 아직 안 지난 7초 하드 삭제
  // 예약이 있으면 취소한다 -- 안 그러면 "되돌렸는데 몇 초 뒤 사라짐"이
  // 된다. HYK-304-lifecycle-orphans-1 ⓑ: 예약 취소는 put 성공 "뒤"에만
  // 한다(순서 교정) -- put 이 실패하면 restore 는 거부를 그대로 호출자에
  // 전파하고, 하드 삭제 예약은 살아있어야 한다(원래는 cancelPending 을
  // put 전에 불러 put 실패 시에도 예약이 사라져 버리는 고아가 생겼다).
  async function restore(id) {
    const memo = await adapter.get(id);
    if (!memo) return null;
    const updated = { ...memo, deletedAt: null };
    await adapter.put(updated);
    cancelPending(id);
    return updated;
  }

  return { softDelete, restore };
}

// HYK-304-lifecycle-orphans-1 ⓐ: 앱 시작 시(저장소를 연 직후) 불러
// "유예가 이미 지난" soft-delete 고아를 저장소에서 지운다 -- softDelete
// 의 hard-delete 예약이 메모리 setTimeout 뿐이라 유예 안에 앱이 닫히면
// 그 예약은 사라지고 레코드는 deletedAt 이 찍힌 채 저장소에 영구히
// 남는다(목록에서만 숨음, list-query.mjs 의 visibleMemosSortedByUpdatedAt).
// graceMs 기본값은 이 파일 자신의 GRACE_MS -- 호출부(app.mjs)가 숫자를
// 새로 박지 않고 옵션을 생략해도 softDelete/restore 와 "같은" 유예를
// 쓴다. 유예가 아직 안 지난 레코드는 그대로 둔다(책임자 판정 §2 요구
// 1-ⓐ: "지우지 마라" -- 재예약·되돌리기 토스트 재표시는 하지 않는다,
// 결과 파일 §한계에 그 이유와 트레이드오프를 적는다).
// 정리 중 개별 레코드가 실패해도(아래 catch) 나머지 레코드 정리를 막지
// 않고, cleanupExpiredDeletes 자신도 예외를 던지지 않는다 -- 호출부가
// fire-and-forget 으로 불러도(§2 요구 1 "정리 실패여도 앱은 뜨고 입력을
// 막지 않는다") 입력을 막지 않게 하기 위해서다(app.mjs 쪽은 추가로
// .catch(()=>{}) 까지 둔다, 이중 방어).
export async function cleanupExpiredDeletes(adapter, options = {}) {
  const graceMs = options.graceMs ?? GRACE_MS;
  const now = (options.now ?? (() => Date.now()))();
  const records = await adapter.list();
  const expiredIds = expiredDeletedMemoIds(records, { now, graceMs });
  for (const id of expiredIds) {
    try {
      await adapter.remove(id);
    } catch {
      // ⓒ 와 같은 처리: 이번 정리에서 실패해도 deletedAt 은 그대로
      // 남아 다음 시작에 이 함수가 같은 id 를 다시 집어낸다.
    }
  }
}
