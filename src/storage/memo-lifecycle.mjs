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
  // HYK-304-lifecycle-orphans-1-r2 P2-2 ⓐ: "저장 실패 표시가 떠 있는
  // 동안" hard delete 를 미루라는 요구를 이 모듈이 알아채려면, mount
  // 쪽(어느 버튼이 떠 있는지 아는 쪽)이 그 사실을 신호로 넘겨야 한다 --
  // holdPending/releasePending 이 그 통로다. heldHardDeletes 는 "지금
  // 유예가 멈춰 있는 id" 집합일 뿐, 복원 시각 계산은 releasePending 이
  // adapter.get 으로 다시 읽은 deletedAt 으로 한다(이 Map 에 시각을
  // 들고 다니면 그 시각이 실제 레코드의 deletedAt 과 어긋날 길이
  // 생긴다).
  const heldHardDeletes = new Set();

  function cancelPending(id) {
    heldHardDeletes.delete(id);
    const pending = pendingHardDeletes.get(id);
    if (pending) {
      clearTimeoutFn(pending);
      pendingHardDeletes.delete(id);
    }
  }

  function runHardDelete(id) {
    pendingHardDeletes.delete(id);
    // HYK-304-lifecycle-orphans-1 ⓒ: remove() 가 거부해도 삼키지 않고
    // "다음 시작 정리에 맡김" 쪽으로 처리한다 -- deletedAt 은 이미 put
    // 으로 저장돼 있으므로, 지금 실패해도 레코드는 deletedAt 이 찍힌
    // 채 남아 cleanupExpiredDeletes(아래)가 다음 시작 때 같은 id 를
    // 다시 집어내 재시도한다(ⓐ와 연결). 여기서 그냥 두면 타이머
    // 콜백이라 try/catch 로 못 잡고 unhandledRejection 으로 샌다.
    Promise.resolve(adapter.remove(id)).catch(() => {});
  }

  // P2-1/P2-2 r2 공용 예약 통로: softDelete(신규 전체 유예) · restore
  // 실패 시 재예약(남은 유예) · releasePending(남은 유예 재개) 셋이
  // 전부 이 함수를 거친다. delay<=0 이면 "이미 유예가 다 지났다"는
  // 뜻이라 기다려 줄 이유가 없다 -- 공짜로 유예를 늘려주지 않기 위해
  // 바로 hard delete 한다(책임자 판정 §2 요구 1 "0 이하이면" 근거).
  function scheduleHardDelete(id, delay) {
    if (delay <= 0) {
      runHardDelete(id);
      return;
    }
    const timer = setTimeoutFn(() => runHardDelete(id), delay);
    pendingHardDeletes.set(id, timer);
  }

  async function softDelete(id) {
    const memo = await adapter.get(id);
    if (!memo) return null;
    const updated = { ...memo, deletedAt: now() };
    await adapter.put(updated);
    cancelPending(id);
    scheduleHardDelete(id, graceMs);
    return updated;
  }

  // 되돌리기: 검토 2R P2-1 수리(책임자 판정 §2 요구 1) -- cancelPending
  // 을 "맨 처음"(어떤 await 보다도 먼저, 동기 구간) 부른다. 1R 은
  // put "성공 뒤"에만 취소해, put 이 저장소에 반영된 뒤 완료 콜백이
  // 늦게 오는 사이 7초 타이머가 발화할 수 있었다(P-race, 결과 파일
  // §1 참고) -- restore 가 이미 "성공"으로 끝났는데 저장소는 지워진
  // 뒤였다. 지금은 restore 가 불리는 순간 즉시 취소하므로 그 창이
  // 생기지 않는다. put 이 그래도 실패하면(cancelPending 은 이미
  // 끝났다) "남은 유예"(= 삭제시각 + graceMs - now, 즉 원래 예정됐던
  // 시각 그대로)만큼 다시 예약한다 -- put 실패 전까지 하드 삭제가
  // 전혀 안 미뤄진 것처럼 취급해, 실패해도 "원래 7초" 축은 그대로
  // 유지된다(남은 유예가 0 이하면 scheduleHardDelete 가 바로 지운다).
  // 그 뒤 실패를 그대로 호출자에 전파한다(기존 동작 유지).
  async function restore(id) {
    cancelPending(id);
    const memo = await adapter.get(id);
    if (!memo) return null;
    const updated = { ...memo, deletedAt: null };
    try {
      await adapter.put(updated);
    } catch (err) {
      if (memo.deletedAt != null) {
        scheduleHardDelete(id, memo.deletedAt + graceMs - now());
      }
      throw err;
    }
    return updated;
  }

  // P2-2 ⓐ(책임자 판정 §2 요구 2): mount 쪽이 "이 메모의 저장 실패
  // 표시가 지금 떠 있다"를 알게 되는 순간(showSaveError 호출 지점)
  // 부르는 신호다 -- 지금 예약돼 있는 하드 삭제 타이머(있다면)를
  // 지우고 "들고 있는 중"으로만 표시한다. 타이머가 아직 없어도(예:
  // 이번이 softDelete 자체의 최초 실패라 애초에 예약이 없는 경우)
  // 안전하게 no-op 이다 -- heldHardDeletes 에 id 를 추가해 두면 나중에
  // releasePending 이 "복원할 유예가 있었는지"를 판단할 뿐, 레코드가
  // 실제로 지워지는 효과는 없다.
  function holdPending(id) {
    const pending = pendingHardDeletes.get(id);
    if (pending) {
      clearTimeoutFn(pending);
      pendingHardDeletes.delete(id);
    }
    heldHardDeletes.add(id);
  }

  // P2-2 ⓒ(책임자 판정 §2 요구 2): "실패 표시가 닫혔다"(성공이든 아니든)
  // 신호다 -- held 가 아니면 조용히 반환한다(hold 없이 불려도, 이미
  // 복원/하드삭제돼 레코드가 없거나 deletedAt 이 null 이어도 안전).
  // held 였다면 adapter.get 으로 "지금" deletedAt 을 다시 읽어 남은
  // 유예(= deletedAt + graceMs - now)만큼 재예약한다 -- hold 가 떠 있던
  // 동안 시간은 계속 흘렀으므로, "원래 예정 시각"을 그대로 복원하는
  // 것이지 유예를 통째로 다시 주는 게 아니다(0 이하면 즉시 지운다).
  async function releasePending(id) {
    if (!heldHardDeletes.has(id)) return;
    heldHardDeletes.delete(id);
    const memo = await adapter.get(id);
    if (!memo || memo.deletedAt == null) return;
    scheduleHardDelete(id, memo.deletedAt + graceMs - now());
  }

  return { softDelete, restore, holdPending, releasePending };
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
