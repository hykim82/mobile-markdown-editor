// HYK-298-abort-record-1 (coder-task.md) -- «중단 기록»(abort record) 판정
// 코어.
//
// §1 왜 이걸 만드는가 (coder-task.md §1 원문 그대로 요약): 2026-08-18
// 오전, 검토 좌석이 배달 직후 재부팅으로 죽었다. 그 좌석이 남긴 결과
// 파일에는 `task_id:` 이름표 줄이 없었다(쓰기 전에 죽었다). 소비 판정
// (consumption-receipt-core.mjs)의 결속 주 열쇠는 결과 파일의 `task_id:`
// 줄에서 harnessTaskLabel을 뽑는 것에서 시작하는데, 그 줄 자체가 없으면
// dispatchId 조회조차 할 수 없어(무엇을 조회할지 모른다) 결속이 영원히
// 미확정 상태로 거부된다. 그런데 이 상태에서 빠져나가는 «설계된 문»이
// 없었다 -- 유일한 기계 통과법은 결과 파일을 치우는 것뿐이었고, 그건
// 검사를 «만족»시키는 게 아니라 «볼 대상을 없애 건너뛰게» 하는 것이다.
//
// 이 모듈이 만드는 문: ORCH(또는 그 대리인)가 «이 라운드는 중단됐다»를
// 증거와 함께 기록(abort record)하면, 그 기록이 아래 3개 독립 검증을
// 전부 통과할 때만 «소비된 것으로 인정»한다. 하나라도 실패하면 여전히
// 거부한다 -- 검사를 건너뛰게 만드는 것이 아니라, 검사를 통과할 새로운
// (그러나 여전히 엄격한) 경로를 추가하는 것뿐이다(coder-task.md ★공통
// 문장).
//
// §2 S8 원칙: consumption-receipt-core.mjs와 동일하게 이 코어는 파일을
// 스스로 읽지 않는다(zero-import 코어 계약, 아래 zero-import 시험 참조).
// 호출자(dispatch-gate-decision.mjs의 어댑터)가 이미 실제 파일(중단 기록
// JSON · dispatch-receipts.jsonl · admission ledger)을 읽어 구조적으로
// 추출한 사실만 인자로 받는다 -- 그 세 개별 검증(지문 대조·dispatchId
// 실재 확인·회수 표식 확인) 자체는 이 코어 밖(어댑터)에서 이뤄지고, 이
// 코어는 그 결과(불리언)만 판정에 쓴다. 이 설계는 consumption-receipt-
// core.checkConsumptionReceipt이 candidates를 이미 구조화된 형태로만
// 받는 것과 같은 선례를 따른다.
//
// §3 3개 독립 검증 (coder-task.md §2-1/§3 요구 그대로, 각각 따로 실행해
// 보일 것):
//   1. fingerprintMatches -- 중단 기록이 «남았다»고 주장하는 결과 파일의
//      SHA-256 지문이, 실제 지금 남아 있는(live) 결과 파일의 SHA-256
//      지문과 정확히 같은가. 다르면(=지문 위조, 또는 애초에 이 기록이
//      가리키는 라운드가 아님) 이 후보는 «이 라운드의 것»으로 인정하지
//      않는다 -- 그래서 «내용 있는 미소비 결과 파일»에 아무 중단 기록을
//      갖다 붙여도(그 기록의 지문이 실제 내용물과 다르면) 이 필터에서
//      아예 매치되지 않아 NO_RECORD로 떨어진다(§4-3 요구: "중단 기록을
//      붙이든 말든 REJECT 유지").
//   2. dispatchIdVerified -- 기록이 주장하는 dispatchId가 실제 배달
//      영수증(dispatch-receipts.jsonl)의 role+harnessTaskLabel 조합과
//      정확히 일치하는 항목에서 나온 것인가(어댑터가 기존
//      lookupDispatchId와 동일한 방식으로 확인). 위조 dispatchId(영수증에
//      없는 값)는 여기서 걸린다.
//   3. recoveryMarkerVerified -- admission 원장(admission-ledger-core.mjs
//      의 sweepAndRecover)이 실제로 이 예약을 `SUSPECT_TIMEOUT_RECOVERED`
//      로 회수했다는 기계 표식이 있는가(어댑터가 ledger.reservations
//      [harnessTaskLabel].completion_reason을 직접 대조). "ORCH가
//      그렇다고 했다"만으로는 통과하지 못한다 -- 원장 자신의 기계 표식이
//      있어야 한다(coder-task.md §2-1 점3 요구).
//
// §4 닫힌 상태 집합(이 집합 밖은 없다, consumption-receipt-core.mjs §4의
// 선례와 동일한 형태):
//
// | 상태 | 뜻 |
// |---|---|
// | VERIFIED | 정확히 하나의 후보가 지문·dispatchId·회수표식 셋 다 통과 |
// | NO_RECORD | liveFingerprint와 일치하는(role도 일치하는) 후보가 0개 |
// | AMBIGUOUS | liveFingerprint와 일치하는 후보가 2개 이상(조용히 하나를 고르지 않는다) |
// | DISPATCH_ID_UNVERIFIED | 유일 후보는 있으나 dispatchId가 배달 영수증과 대조되지 않음(위조/불명) |
// | RECOVERY_MARKER_MISSING | 유일 후보는 있고 dispatchId도 검증됐으나 admission 원장에 SUSPECT_TIMEOUT_RECOVERED 표식이 없음 |
//
// VERIFIED는 이 표의 단 하나의 행에서만 나온다(consumption-receipt-
// core.mjs와 동일 원칙 -- "판정 불가를 정상으로 접지 않는다").
//
// §5 정직 한계(coder-task §4-5 요구): 이 코어는 "abort record 후보들이
// 주어졌을 때 그것을 VERIFIED/거부로 정확히 매핑한다"는 판정 로직 하나만
// 증명한다. (a) 후보를 실제 파일(`.harness/aborts/*.json`)에서 읽어내는
// 일, dispatch-receipts.jsonl을 조회해 dispatchIdVerified를 만드는 일,
// admission 원장을 읽어 recoveryMarkerVerified를 만드는 일은 이 코어의
// 범위 밖이며 dispatch-gate-decision.mjs 쪽 어댑터의 몫이다(아래 그
// 파일의 evaluateAbortRecordDecision 참조). (b) 이 판정이 사람이 실제로
// 위조하려 시도하는 모든 방법(예: 어댑터 자체를 몰래 패치)까지 막지는
// 못한다 -- 이 코어가 보장하는 것은 "주어진 사실이 정직하게 구조화됐다면
// 판정이 안전측"이라는 것뿐이다.

export const ABORT_RECORD_STATE = Object.freeze({
  VERIFIED: "VERIFIED",
  NO_RECORD: "NO_RECORD",
  AMBIGUOUS: "AMBIGUOUS",
  DISPATCH_ID_UNVERIFIED: "DISPATCH_ID_UNVERIFIED",
  RECOVERY_MARKER_MISSING: "RECOVERY_MARKER_MISSING",
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function describeRecord(record) {
  return JSON.stringify({
    role: record?.role ?? null,
    harnessTaskLabel: record?.harnessTaskLabel ?? null,
    dispatchId: record?.dispatchId ?? null,
    droppedAt: record?.droppedAt ?? null,
    leftoverFingerprint: record?.leftoverFingerprint ?? null,
  });
}

// §3 검증1 -- role도 같고(어댑터가 파일명 패턴으로 이미 좁혔더라도 이
// 코어 스스로 다시 대조한다, "어댑터가 실수로 다른 role 후보를 섞어
// 넣어도 이 코어가 스스로 막는다"는 이중 방어) leftoverFingerprint도
// liveFingerprint와 정확히 같은 후보만 "이 라운드를 가리키는 것"으로
// 인정한다. 구조적으로 무효한 레코드(role/harnessTaskLabel/dispatchId/
// leftoverFingerprint 중 하나라도 비어 있음)는 애초에 매치 대상에서
// 제외한다 -- 위조자가 필드를 통째로 비워 "일치하지 않으므로 후보 0건
// -> NO_RECORD"보다 더 유리한 경로를 찾지 못하게 한다(빈 값끼리
// undefined===undefined로 새는 구멍을 원천 차단, consumption-receipt-
// core.mjs §3-c 신규 결함 수리와 동일한 경계 조건 방어).
function isStructurallyValid(record) {
  return (
    isNonEmptyString(record?.role) &&
    isNonEmptyString(record?.harnessTaskLabel) &&
    isNonEmptyString(record?.dispatchId) &&
    isNonEmptyString(record?.leftoverFingerprint)
  );
}

function resolveMatchingAbortCandidate(candidates, role, liveFingerprint) {
  const list = Array.isArray(candidates) ? candidates : [];
  const matches = list.filter(
    (c) =>
      isStructurallyValid(c?.record) &&
      c.record.role === role &&
      c.record.leftoverFingerprint === liveFingerprint,
  );
  if (matches.length === 0) {
    const seen = list
      .filter((c) => isStructurallyValid(c?.record))
      .map((c) => describeRecord(c.record))
      .join(" / ");
    return {
      ok: false,
      result: {
        state: ABORT_RECORD_STATE.NO_RECORD,
        ok: false,
        reason: `abort-record: role=${role} live 지문(${liveFingerprint})과 일치하는 중단 기록 후보가 하나도 없음 -> 중단 기록으로 인정하지 않음, 거부(안전측 기본값). 발견된 후보: ${seen || "(없음)"}`,
      },
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      result: {
        state: ABORT_RECORD_STATE.AMBIGUOUS,
        ok: false,
        reason: `abort-record: role=${role} live 지문(${liveFingerprint})과 일치하는 중단 기록 후보가 ${matches.length}개 -- 어느 것이 이 라운드의 것인지 결정할 수 없다(ambiguous) -> 조용히 하나를 고르지 않고 거부(안전측 기본값)`,
      },
    };
  }
  return { ok: true, candidate: matches[0] };
}

// The one function this module exists to provide (mirrors consumption-
// receipt-core.mjs's checkConsumptionReceipt contract). Never throws, never
// returns VERIFIED without every required fact checked, never returns a
// non-VERIFIED state without a human-readable `reason`.
//
// facts:
//   role            -- 이 축을 적용하는 라운드의 role(대문자 정규화는
//                      호출자 책임, dispatch-gate-decision.mjs가 이미
//                      consumption 축에서 하는 것과 동일).
//   liveFingerprint -- 지금 실제로 남아 있는(live) 결과 파일 내용의
//                      SHA-256(hex, 호출자 계산).
//   candidates      -- 호출자가 이미 구조적으로 추출한 중단 기록 후보
//                      배열. 각 원소:
//                      { record: { role, harnessTaskLabel, dispatchId,
//                                  droppedAt, leftoverFingerprint,
//                                  leftoverPath },
//                        dispatchIdVerified: boolean,
//                        recoveryMarkerVerified: boolean }
export function checkAbortRecord({ role, liveFingerprint, candidates } = {}) {
  if (!isNonEmptyString(role) || !isNonEmptyString(liveFingerprint)) {
    return {
      state: ABORT_RECORD_STATE.NO_RECORD,
      ok: false,
      reason:
        "abort-record: role 또는 liveFingerprint가 없음 -> 이 축을 적용할 대상을 확정할 수 없음, 거부(안전측 기본값)",
    };
  }

  const resolved = resolveMatchingAbortCandidate(
    candidates,
    role,
    liveFingerprint,
  );
  if (!resolved.ok) return resolved.result;
  const { candidate } = resolved;

  if (candidate.dispatchIdVerified !== true) {
    return {
      state: ABORT_RECORD_STATE.DISPATCH_ID_UNVERIFIED,
      ok: false,
      reason: `abort-record: 중단 기록(${describeRecord(candidate.record)})의 dispatchId가 배달 영수증(dispatch-receipts.jsonl)에서 확인되지 않음(위조 또는 불명) -> 거부(안전측 기본값)`,
    };
  }

  if (candidate.recoveryMarkerVerified !== true) {
    return {
      state: ABORT_RECORD_STATE.RECOVERY_MARKER_MISSING,
      ok: false,
      reason: `abort-record: 중단 기록(${describeRecord(candidate.record)})에 대응하는 admission 원장 회수 표식(SUSPECT_TIMEOUT_RECOVERED)이 없음 -> "ORCH가 그렇다고 했다"만으로는 인정하지 않음, 거부(안전측 기본값)`,
    };
  }

  return {
    state: ABORT_RECORD_STATE.VERIFIED,
    ok: true,
    reason: `abort-record: 중단 기록(${describeRecord(candidate.record)}) 지문 일치 + dispatchId 실재 확인 + admission 원장 SUSPECT_TIMEOUT_RECOVERED 표식 확인 -> 이름표 없이 죽은 라운드를 소비 완료로 인정, 허용`,
  };
}

// §2-B 게이트 축 어댑터: dispatch-gate-decision-core.mjs의
// combineGateDecisions가 받는 개별 decision 모양(통과면 null, 아니면
// { state, allow:false, reason })으로 그대로 내놓는다 -- consumption-
// receipt-core.mjs의 toConsumptionGateDecision과 동일한 관례.
export function toAbortRecordGateDecision(facts) {
  const verdict = checkAbortRecord(facts);
  if (verdict.state === ABORT_RECORD_STATE.VERIFIED) return null;
  return {
    state: verdict.state,
    allow: false,
    reason: verdict.reason,
  };
}
