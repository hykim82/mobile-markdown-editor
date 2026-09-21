// HYK-212-postcheck-1 (coder-task.md) -- «배달 직후 사후검증» 판정 코어.
//
// 실사고(coder-task.md §1): 배달 도구가 `injected=true`로 성공을
// 자기신고했는데, 그 직후 `orca orchestration dispatch-show --task <id>`를
// 다시 조회하면 `result.dispatch === null`(레코드가 아예 없음)인 경우가
// 있었다. 기존 감시(dispatch-start-core.mjs)는 이런 malformed dispatch를
// 전부 `UNDECIDABLE`(조용한 판정불가)로 접는다 -- 이 코어는 그 대신
// «레코드가 없다»는 사실 자체를 하나의 뚜렷한 verdict로 승격한다.
//
// ★zero-import 순수 함수(dispatch-start-core.mjs와 동일 계약) -- I/O,
// orca 호출, 다른 모듈 참조 0. 호출부(orca-adapter.mjs -- 배달 직후 실제
// 재조회, orch-stall-detect.mjs -- 감시 시점 수집)가 이미 얻은 값만
// 정규화해 넘긴다.
//
// 입력 계약:
// - injected: 배달 도구 자신이 낸 self-report(boolean). true가 아니면
//   (false/null/undefined -- codex 엔진처럼 애초에 --inject를 안 쓰는
//   경로 포함) 이 축은 판단 대상이 아니다(NOT_APPLICABLE) -- ★자기신고를
//   근거로 삼는다는 한계를 여기서 명시한다: 이 값이 거짓으로 self-report돼도
//   이 코어는 그것을 검증할 수단이 없다(정직 한계, coder-task.md §7 보고
//   요구사항).
// - normalized: dispatch-correlation-adapter.mjs의 normalizeDispatchShow(...)
//   반환값 그대로(재구현 금지) -- {ok:true,...} 또는
//   {ok:false, reasonCode: NOT_OK|NO_DISPATCH|FIELDS_INCOMPLETE}. 조회
//   자체가 throw했다면 호출부가 {ok:false, reasonCode:"QUERY_THREW"}를
//   합성해 넘긴다(§3-3: 조회 실패는 레코드 없음과 다른 사유 코드로 들어와야
//   한다 -- 이 함수는 둘을 같은 값으로 접지 않는다).

export const DISPATCH_POSTCHECK_VERDICT = Object.freeze({
  CONFIRMED: "CONFIRMED",
  RECORD_MISSING: "RECORD_MISSING",
});

export const DISPATCH_POSTCHECK_STATUS = Object.freeze({
  OK: "OK",
  QUERY_FAILED: "QUERY_FAILED",
});

export const DISPATCH_POSTCHECK_REASON = Object.freeze({
  NOT_APPLICABLE: "NOT_APPLICABLE",
  VALID: "VALID",
  NO_DISPATCH: "NO_DISPATCH",
  NOT_OK: "NOT_OK",
  FIELDS_INCOMPLETE: "FIELDS_INCOMPLETE",
  QUERY_THREW: "QUERY_THREW",
  MALFORMED_INPUT: "MALFORMED_INPUT",
});

// §3 비타협3(조회 실패 != 레코드 없음, 조회 실패 != 정상)을 이 함수 하나가
// 3중 분기로 지킨다:
//   ① injected !== true                       -> OK/NOT_APPLICABLE(판단 대상 아님)
//   ② normalized.ok === true                   -> OK/CONFIRMED(정상 -- 오탐 0)
//   ③ normalized.reasonCode === "NO_DISPATCH"   -> OK/RECORD_MISSING(★경보 -- 조회는 성공했고, 그 결과가 "없다"였다)
//   ④ 그 외(NOT_OK/FIELDS_INCOMPLETE/QUERY_THREW/malformed 입력)
//                                                -> QUERY_FAILED/null(제3의 상태 -- ②도 ③도 아니다)
export function judgeDispatchPostcheck({ injected, normalized } = {}) {
  if (injected !== true) {
    return {
      status: DISPATCH_POSTCHECK_STATUS.OK,
      verdict: null,
      reasonCode: DISPATCH_POSTCHECK_REASON.NOT_APPLICABLE,
    };
  }

  if (normalized === null || typeof normalized !== "object") {
    return {
      status: DISPATCH_POSTCHECK_STATUS.QUERY_FAILED,
      verdict: null,
      reasonCode: DISPATCH_POSTCHECK_REASON.MALFORMED_INPUT,
    };
  }

  if (normalized.ok === true) {
    return {
      status: DISPATCH_POSTCHECK_STATUS.OK,
      verdict: DISPATCH_POSTCHECK_VERDICT.CONFIRMED,
      reasonCode: DISPATCH_POSTCHECK_REASON.VALID,
    };
  }

  if (normalized.reasonCode === DISPATCH_POSTCHECK_REASON.NO_DISPATCH) {
    return {
      status: DISPATCH_POSTCHECK_STATUS.OK,
      verdict: DISPATCH_POSTCHECK_VERDICT.RECORD_MISSING,
      reasonCode: DISPATCH_POSTCHECK_REASON.NO_DISPATCH,
    };
  }

  const reasonCode =
    normalized.reasonCode === DISPATCH_POSTCHECK_REASON.NOT_OK ||
    normalized.reasonCode === DISPATCH_POSTCHECK_REASON.FIELDS_INCOMPLETE
      ? normalized.reasonCode
      : DISPATCH_POSTCHECK_REASON.QUERY_THREW;
  return {
    status: DISPATCH_POSTCHECK_STATUS.QUERY_FAILED,
    verdict: null,
    reasonCode,
  };
}
