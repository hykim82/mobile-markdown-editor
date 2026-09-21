// HYK-171-cycle4a1-1: 좌석 후보 readiness 판정 코어.
//
// 순수함수(coder-task.md §2 계약): judgeSeatReadiness는 이미 정규화된
// 후보 관측 배열(scripts/relay/adapters/seat-candidate-adapter.mjs가
// 만드는 shape)만 소비한다. raw vendor 문자열(orca preview/terminal
// 응답 등)을 여기서 직접 파싱/분기하지 않는다(S6: grep 대상 -- 이 파일
// 안에 orca 문자열/정규식 리터럴이 없어야 한다). orca CLI를 spawn하지도
// 않는다(G9 -- import 0, execFn 0).
//
// 이 사이클(4a-1)의 경계: 판정만. 이 함수가 반환하는 값을 소비해 실제
// dispatch/게이트를 여닫는 결선은 여기 없다(4a-2 이후).

export const SEAT_READINESS_STATUS = Object.freeze({
  READY: "READY",
  NOT_READY: "NOT_READY",
  AMBIGUOUS: "AMBIGUOUS",
  UNOBSERVABLE: "UNOBSERVABLE",
});

// 후보 정규화 상태 -- seat-candidate-adapter.mjs의 CANDIDATE_STATE와
// 동일한 값 집합을 기대한다(그 파일이 원본 선언 -- 이 파일은 값을
// 재선언하지 않고 문자열 리터럴로만 비교한다, 순환 import 방지).
const IDLE_OR_READY = "idle-or-ready";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function unobservable(reason) {
  return {
    status: SEAT_READINESS_STATUS.UNOBSERVABLE,
    selectedHandle: undefined,
    reason,
  };
}

// 후보 하나가 "관측했으나 분류 불가"(state unknown) 또는 "관측 자체가
// 안 됨"(observable:false)이면 그 즉시 전체 판정을 UNOBSERVABLE로 접는다
// (fail-closed -- coder-task.md §3 "UNOBSERVABLE=fail-closed", §5 mutation
// 5). 다른 후보가 멀쩡해도 이 한 후보의 관측 불가가 판정 전체를 좌우한다
// -- READY로 속단하지 않는다.
function findUnobservableCandidate(candidates) {
  return candidates.find(
    (c) => !isPlainObject(c) || c.observable === false || c.state === "unknown",
  );
}

// 판정 규칙(coder-task.md §2): shell/starting/occupied 후보를 제외한
// "살아있는 agent(입력대기)" 후보 -- 즉 state===idle-or-ready && occupied
// !== true -- 를 dispatchable pool로 본다.
//   pool.length === 1 -> READY(그 handle)
//   pool.length === 0 -> NOT_READY
//   pool.length >= 2  -> AMBIGUOUS(자동선택 0)
//
// candidates: 정규화 후보 관측 배열. 각 원소 shape(seat-candidate-adapter.mjs
// normalizeSeatCandidate 출력):
//   { schemaVersion, handle, state, occupied, observable }
//
// raw 관측 자체가 실패한 경우(terminal list/show 실패 등) 호출자는
// candidates를 아예 만들 수 없다 -- 그 경우 candidates에 null/undefined를
// 넘기면(빈 배열이 아니라) UNOBSERVABLE로 판정한다(mutation 5의 "raw 실패"
// 절반: 후보를 하나도 못 만든 경우).
export function judgeSeatReadiness({ candidates } = {}) {
  if (!Array.isArray(candidates)) {
    return unobservable(
      "seat-readiness: candidates is not an array -- raw observation failed or was never attempted",
    );
  }
  if (candidates.length === 0) {
    return unobservable(
      "seat-readiness: no candidates observed for this worktree",
    );
  }

  const badCandidate = findUnobservableCandidate(candidates);
  if (badCandidate) {
    const handle =
      isPlainObject(badCandidate) && isNonEmptyString(badCandidate.handle)
        ? badCandidate.handle
        : "(unknown handle)";
    return unobservable(
      `seat-readiness: candidate '${handle}' is unobservable/unclassifiable (state=unknown or observable=false) -- fail-closed`,
    );
  }

  const pool = candidates.filter(
    (c) => c.state === IDLE_OR_READY && c.occupied !== true,
  );

  if (pool.length === 1) {
    return {
      status: SEAT_READINESS_STATUS.READY,
      selectedHandle: pool[0].handle,
      reason: `seat-readiness: exactly one dispatchable idle agent candidate ('${pool[0].handle}')`,
    };
  }
  if (pool.length === 0) {
    return {
      status: SEAT_READINESS_STATUS.NOT_READY,
      selectedHandle: undefined,
      reason:
        "seat-readiness: no dispatchable idle agent candidate (all shell/starting/occupied)",
    };
  }
  return {
    status: SEAT_READINESS_STATUS.AMBIGUOUS,
    selectedHandle: undefined,
    reason: `seat-readiness: ${pool.length} dispatchable idle agent candidates -- refusing to auto-select`,
  };
}
