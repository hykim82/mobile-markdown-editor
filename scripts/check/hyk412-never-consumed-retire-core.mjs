// HYK-412-stuck-retire-2 (coder-task.md) -- "never-consumed round" retirement
// eligibility core. zero-import, pure decision function (S8 원칙, retirement-
// record-core.mjs와 동일한 계약: 파일을 스스로 읽지 않는다, 호출자가 이미
// 읽어 구조적으로 추출한 사실만 인자로 받는다).
//
// §0 이 모듈이 왜 새로 생겼나 (1R의 축이 왜 죽었는지, 요약이 아니라 정정):
// 1R은 "task 보존 사본(`.harness/rounds/<role>-task-r<N>.md`) 개수가 0건이면
// 다음 라운드가 드롭된 적 없다"는 문장을 "이 라운드 자신의 task 보존 사본이
// 0건"으로 잘못 조작했다. 검토가 코드를 직접 읽어 반증했다: 그 파일은 이
// 라운드 «자신»이 배달(dispatch)되는 순간 게이트가 스냅숏하는 것이지,
// 다음 라운드가 드롭될 때 생기는 게 아니다(dispatch-gate-decision.mjs의
// bestEffortSnapshotRoundTaskFile -> envelope-archive.mjs의
// archiveRoundTaskFileIfNew). 즉 배달된 모든 라운드는 항상 자기 자신의
// task-r<N>.md를 최소 1건 갖는다 -- "0건"은 실제 배달 경로에서 결코 참이
//될 수 없다(vacuous).
//
// 정정: "이 라운드가 소비 시도된 적이 있는가"를 알려주는 신호는 이 라운드
// 자신의 task-r<N>.md가 아니라, 그 다음 순번의 task-r<N+1>.md가 존재하는가
// 이다 -- 그 파일은 ORCH가 다음 라운드를 드롭했을 때만 생긴다(같은 archive
// 메커니즘, 순번만 하나 밀려서). N+1이 없으면 "이 role에 대해 이 라운드
// 이후로 아무도 새 라운드를 드롭한 적이 없다"는 것이 readdir 한 번으로
// 검증 가능한 긍정 사실이다 -- 이건 실제로 참/거짓이 갈리는 조건이다
// (evidence-3에는 task-r2.md/evidence-3b가 있어 이 축이 SUCCESSOR_ROUND_EXISTS
// 로 닫히고, 가상의 "정말 한 번도 안 건드려진" 라운드에는 그게 없어 이
// 축이 OPEN으로 갈린다 -- coder-task.md §2⑵ 요구: "실제 배달 라운드 모양
// 에서 참이 될 수 있는" 축).
//
// §1 A(앞으로)/B(이미 갇힌 것) 분리 -- 이 코어가 여는 문은 오직 A다:
// "다음 라운드가 단 한 번도 드롭된 적 없는, 완전히 방치된 라운드"만 연다.
// evidence-3처럼 이미 재시도(evidence-3b)가 있었던 표본은 이 축으로
// 영원히 못 연다 -- SUCCESSOR_ROUND_EXISTS로 닫히고, B(사람 서명 경로,
// docs/HYK-412-stuck-retire-design.md §3-B)로 넘어간다. 이 코어는 B를
// 열지 않는다 -- B는 이 코어를 아예 호출하지 않고 별도 사람 승인 절차를
// 탄다.
//
// §2 위조 표면 (열거, 미열거 기본값 닫힘):
//   1. ledgerReservation/dispatchReceiptMatchCount -- admission-ledger.json과
//      dispatch-receipts.jsonl은 어떤 워크트리의 harnessDir 안에도 없다
//      (제어실 전역 경로, coder-task.md §0 정책상 워커 쓰기 금지 대상) --
//      이 두 사실은 워커가 forge할 수 있는 표면이 «아니다»(구조적 격리).
//   2. hasLaterRoundArchive/ownRoundArchiveExists/resultArchiveExists --
//      이 셋은 `.harness/rounds/`(harnessDir 하위, 즉 워크트리 내부)에서
//      읽는다 -- 워크트리에 쓰기 권한을 가진 주체는 이 디렉터리를 조작해
//      "성공적으로 다음 라운드가 드롭된 적 없다"고 위장할 수 있다(1R §2-4
//      가 이미 밝힌 caveat, 이 라운드가 새로 발견한 게 아니다 -- 그대로
//      물려받는다). 이 코어는 이 위조를 막지 못한다(§4 정직 한계).
//   3. staleEnoughSinceAdmission -- admitted_at(제어실)과 "지금" 시각의
//      비교, 호출자가 계산해 넘긴다. 호출자가 시각을 지어내면(가짜로 "충분히
//      지났다"고 우김) 이 코어는 그 계산 자체를 재현하지 않는다 -- 어댑터의
//      몫(§4 정직 한계).
//   4. 위 넷 외의 다른 어떤 필드 조작도 이 코어의 상태 전이 표(§3)에
//      나열되지 않은 경로로는 절대 OPEN에 도달할 수 없다 -- 아래
//      evaluateNeverConsumedRetirement은 각 관문을 순서대로 통과해야만
//      OPEN을 반환하고, 마지막 return 외에는 전부 거부(fail-closed)다.
//
// §3 닫힌 상태 집합 (표, retirement-record-core.mjs §4 선례와 동일 형태):
//
// | 상태 | 뜻 |
// |---|---|
// | LABEL_MISSING | role 또는 harnessTaskLabel이 없음 |
// | LEDGER_RECORD_MISSING | admission-ledger에 이 라벨 예약 자체가 없음 |
// | LEDGER_RECORD_LABEL_MISMATCH | 예약은 있으나 그 예약이 기록한 라벨이 요청한 라벨과 다름(라벨↔admission 불일치, §2⑶) |
// | LEDGER_NOT_ACTIVE | 예약이 ACTIVE가 아니거나 completedAt이 이미 찍혀 있음(이미 끝난 걸 "미소비"로 재주장하는 위조 방지) |
// | DISPATCH_RECEIPT_NOT_EXACTLY_ONE | dispatch-receipts 매칭이 0건 또는 2건 이상 |
// | RESULT_ARCHIVE_ALREADY_EXISTS | 결과 아카이브가 이미 있음(resultArchiveExists === true) -- 애초에 이 축을 적용할 대상(never-consumed)이 아니다 |
// | RESULT_ARCHIVE_UNJUDGABLE | resultArchiveExists가 true도 false도 아님(3R 수리, 검토 P1) -- "없다"로 조용히 접지 않고 판정 불능으로 거부 |
// | OWN_TASK_ARCHIVE_MISSING | 이 라운드 자신의 task-r<N>.md조차 없음 -- 실제로 배달된 라운드라면 구조적으로 불가능(§0), 안전측 거부 |
// | SUCCESSOR_ROUND_EXISTS | task-r<N+1>.md가 존재(hasLaterRoundArchive === true) -- 다음 라운드가 실제로 드롭됐다(재시도 흔적), 이 축은 case B로 넘긴다 |
// | SUCCESSOR_ROUND_ARCHIVE_UNJUDGABLE | hasLaterRoundArchive가 true도 false도 아님(3R 수리, 검토 P1) -- "없다"로 조용히 접지 않고 판정 불능으로 거부 |
// | TOO_RECENT | 아직 stall-watch 임계치를 넘기지 않음(진행 중인 정상 라운드를 성급히 은퇴시키지 않는다) |
// | SUCCESSOR_LABEL_MISSING | 은퇴 기록에 쓸 후속 이름표가 없음 |
// | OPEN | 위 전부 통과 -- "다음 라운드가 한 번도 드롭된 적 없는, 완전히 방치된 라운드"로 기계 판정, 은퇴 기록 «작성 절차»(사람이 retirement-record-writer.mjs를 실행)로 넘어갈 수 있다. 이 함수 자신은 파일을 쓰지 않는다. |
//
// §4 정직 한계 (coder-task.md §3 요구 그대로):
//   (a) §2 항목 2(rounds/ 디렉터리 위조)는 이 코어가 막지 못한다 -- 1R의
//       기존 caveat을 그대로 물려받는다, 새로 생긴 구멍이 아니다.
//   (b) OPEN은 "은퇴 기록을 «작성할 수 있는» 자격"이지 은퇴 자체가 아니다
//       -- 실제 자리 반납은 여전히 retirement-record-writer.mjs로 사람이
//       기록을 쓰고, 그 기록을 별도 소비 경로가 검증해야 한다(이 라운드는
//       그 소비-경로 결선까지는 하지 않는다, docs/HYK-412-stuck-retire-
//       design.md §5 범위 판단 참조).
//   (c) SUCCESSOR_ROUND_EXISTS로 닫힌 case(B)는 이 코어가 «영원히» 못 연다
//       -- 그게 설계 의도다(§1). B를 열려면 사람 서명 경로가 필요하고,
//       이 코어는 그 경로에 관여하지 않는다.
//   (d) HYK-412-stuck-retire-3(§2ⓐ 요구): 이 코어는 boolean 필드의 «타입»
//       위조(문자열/숫자/undefined를 넣어 truthy-fold를 유발하는 것)는
//       막지만, 사실 «수집기»(어댑터, 이 라운드 범위 밖) 자체가 진짜
//       boolean 값 `true`/`false`를 정확한 타입으로 넣으면서도 그 값
//       자체가 거짓인 경우(예: 파일이 실제로는 있는데 수집기가 버그로
//       `false`를 넘김)는 이 코어가 원리적으로 탐지할 수 없다 -- 이 코어는
//       "받은 사실이 정직하게 구조화됐다면 판정이 안전측"이라는 것만
//       보장한다(retirement-record-core.mjs §5-d와 동일한 한계, S8
//       zero-import 코어의 근본적 범위). 수집기 자체의 정확성은 그
//       어댑터의 시험(이 라운드 범위 밖, docs/HYK-412-stuck-retire-
//       design.md §6 참조)이 별도로 증명해야 한다.

export const NEVER_CONSUMED_RETIRE_STATE = Object.freeze({
  OPEN: "OPEN",
  LABEL_MISSING: "LABEL_MISSING",
  LEDGER_RECORD_MISSING: "LEDGER_RECORD_MISSING",
  LEDGER_RECORD_LABEL_MISMATCH: "LEDGER_RECORD_LABEL_MISMATCH",
  LEDGER_NOT_ACTIVE: "LEDGER_NOT_ACTIVE",
  DISPATCH_RECEIPT_NOT_EXACTLY_ONE: "DISPATCH_RECEIPT_NOT_EXACTLY_ONE",
  RESULT_ARCHIVE_ALREADY_EXISTS: "RESULT_ARCHIVE_ALREADY_EXISTS",
  RESULT_ARCHIVE_UNJUDGABLE: "RESULT_ARCHIVE_UNJUDGABLE",
  OWN_TASK_ARCHIVE_MISSING: "OWN_TASK_ARCHIVE_MISSING",
  SUCCESSOR_ROUND_EXISTS: "SUCCESSOR_ROUND_EXISTS",
  SUCCESSOR_ROUND_ARCHIVE_UNJUDGABLE: "SUCCESSOR_ROUND_ARCHIVE_UNJUDGABLE",
  TOO_RECENT: "TOO_RECENT",
  SUCCESSOR_LABEL_MISSING: "SUCCESSOR_LABEL_MISSING",
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function reject(state, reason) {
  return { state, ok: false, reason: `hyk412-never-consumed: ${reason}` };
}

// HYK-412-stuck-retire-3 (3R 수리, 게이트 2 판정 A -- 검토 P1): 음성 사실
// (부재 주장) 필드는 이전엔 `=== true`로만 "존재한다"를 판정했다 -- 그
// 말은 즉 `"UNKNOWN_FAILURE_CODE"`나 `1`이나 `undefined`처럼 boolean이
// 아닌 어떤 값이 들어와도 `=== true`가 false가 되어 "존재하지 않는다"로
// 조용히 접혀(truthy-fold) 문이 열렸다 -- 1R/2R과 같은 계열의 결함("부재를
// 확인 없이 가정한다").
//
// 수리 방향(★근거, coder-task.md §2ⓐ의 두 선택지 중 택한 쪽): "그 외 모든
// 값은 UNJUDGABLE로 거부"(⑵)를 골랐다 -- "명시적 false만 인정"(⑴)만으로는
// value가 true인지 단순 garbage인지 판정 근거가 사라져 로그/시험에서
// 구별이 안 된다. 이 코어는 이미 상태를 최대한 세분화해 "판정 불가"가
// 조용히 정상으로 접히지 않게 하는 것을 원칙으로 삼아 왔다
// (retirement-record-core.mjs §4 선례, 이 파일 §3 표) -- ⑴만 골라 두
// 케이스(진짜 true / 알 수 없는 값)를 같은 사유 코드로 뭉개면 그 원칙과
// 어긋난다. 그래서 세 갈래(참/거짓/그 외) 전부를 명시적으로 다룬다: 값이
// 정확히 `true`면 그 사실이 확정적으로 막힌 것으로 기존 사유 코드로 거부,
// 정확히 `false`면(그리고 오직 그때만) "없다"로 인정해 통과, 그 외 어떤
// 값이든(문자열·숫자·`undefined`·`null`·객체 등) 전용 UNJUDGABLE 상태로
// 거부한다 -- 미열거 기본값이 "값 하나 더 열거"가 아니라 이 세 갈래 구조
// 자체로 닫힌다(완료 조건 2).
function describeUnjudgableValue(value) {
  const serialized = JSON.stringify(value);
  return `typeof=${typeof value} value=${serialized === undefined ? String(value) : serialized}`;
}

function checkExplicitNegativeFact({
  value,
  trueState,
  trueReason,
  unjudgableState,
  unjudgableReason,
}) {
  if (value === true) {
    return reject(trueState, trueReason);
  }
  if (value !== false) {
    return reject(
      unjudgableState,
      `${unjudgableReason} (받은 값: ${describeUnjudgableValue(value)})`,
    );
  }
  return null;
}

// eslint complexity 상한 회피(retirement-record-core.mjs의 checkArchiveFacts/
// checkReasonAndSuccessorFacts 선례와 동일한 이유 -- 판정/문구는 조금도
// 바뀌지 않는다, 몸통만 쪼갠다). ledger 세 관문(예약 존재·라벨 일치·ACTIVE)을
// 하나로 묶는다. 통과하면 null, 실패하면 그 사유의 {state, ok:false, reason}.
function checkLedgerFacts(ledgerReservation, role, harnessTaskLabel) {
  if (ledgerReservation?.exists !== true) {
    return reject(
      NEVER_CONSUMED_RETIRE_STATE.LEDGER_RECORD_MISSING,
      `role=${role} label=${harnessTaskLabel}에 대한 admission-ledger 예약이 없음 -> 은퇴시킬 대상 자체가 없음, 거부`,
    );
  }
  if (ledgerReservation.harnessTaskLabel !== harnessTaskLabel) {
    return reject(
      NEVER_CONSUMED_RETIRE_STATE.LEDGER_RECORD_LABEL_MISMATCH,
      `admission-ledger 예약이 기록한 라벨('${ledgerReservation.harnessTaskLabel}')이 요청한 라벨('${harnessTaskLabel}')과 다름 -> 라벨↔admission 1:1 전제가 깨짐, 둘 다 믿지 않고 거부(안전측 기본값)`,
    );
  }
  if (
    ledgerReservation.status !== "ACTIVE" ||
    ledgerReservation.completedAt !== null
  ) {
    return reject(
      NEVER_CONSUMED_RETIRE_STATE.LEDGER_NOT_ACTIVE,
      `예약 status=${ledgerReservation.status} completedAt=${ledgerReservation.completedAt} -> ACTIVE+completedAt:null이 아님(이미 끝난 라운드를 "미소비"로 재주장하는 위조 방지), 거부`,
    );
  }
  return null;
}

// 같은 이유로 뽑았다 -- 아카이브 모양 네 관문(결과 아카이브 부재·자기 task
// 아카이브 존재·다음 라운드 아카이브 부재·staleness)을 하나로 묶는다.
function checkArchiveShapeFacts({
  resultArchiveExists,
  ownTaskArchiveExists,
  hasLaterRoundArchive,
  staleEnoughSinceAdmission,
}) {
  const resultArchiveFailure = checkExplicitNegativeFact({
    value: resultArchiveExists,
    trueState: NEVER_CONSUMED_RETIRE_STATE.RESULT_ARCHIVE_ALREADY_EXISTS,
    trueReason:
      "결과 아카이브가 이미 존재함 -> 이 라운드는 애초에 never-consumed가 아니다(이 축을 적용할 대상이 아님), 거부",
    unjudgableState: NEVER_CONSUMED_RETIRE_STATE.RESULT_ARCHIVE_UNJUDGABLE,
    unjudgableReason:
      "resultArchiveExists가 boolean이 아님 -> '없다'로 조용히 접지 않고 판정 불능으로 거부(검토 P1 재발 방지, 안전측 기본값)",
  });
  if (resultArchiveFailure) return resultArchiveFailure;

  if (ownTaskArchiveExists !== true) {
    return reject(
      NEVER_CONSUMED_RETIRE_STATE.OWN_TASK_ARCHIVE_MISSING,
      "이 라운드 자신의 task 보존 사본(rounds/<role>-task-r<N>.md)조차 없음 -> 실제로 배달된 라운드라면 구조적으로 불가능한 모양(게이트가 배달 직전 항상 스냅숏한다), 거부(안전측 기본값)",
    );
  }

  const successorRoundFailure = checkExplicitNegativeFact({
    value: hasLaterRoundArchive,
    trueState: NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_ROUND_EXISTS,
    trueReason:
      "다음 순번 task 보존 사본(rounds/<role>-task-r<N+1>.md)이 존재함 -> 이후 라운드가 실제로 드롭됐다(재시도 흔적), '한 번도 안 건드려짐'을 이 축으로는 증명 못 함 -> case B(사람 서명 경로)로 넘김, 거부",
    unjudgableState:
      NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_ROUND_ARCHIVE_UNJUDGABLE,
    unjudgableReason:
      "hasLaterRoundArchive가 boolean이 아님 -> '없다'로 조용히 접지 않고 판정 불능으로 거부(검토 P1 재발 방지, 안전측 기본값)",
  });
  if (successorRoundFailure) return successorRoundFailure;

  if (staleEnoughSinceAdmission !== true) {
    return reject(
      NEVER_CONSUMED_RETIRE_STATE.TOO_RECENT,
      "admitted_at으로부터 stall-watch 임계치를 아직 넘기지 않음 -> 아직 진행 중일 수 있는 정상 라운드를 성급히 은퇴시키지 않는다, 거부",
    );
  }
  return null;
}

// facts:
//   role                       -- 대문자 정규화는 호출자 책임(기존 관례).
//   harnessTaskLabel           -- 은퇴 대상으로 지목된 라운드의 라벨.
//   ledgerReservation          -- { exists, harnessTaskLabel, status,
//                                   completedAt } -- 호출자가 admission-
//                                   ledger.json에서 이미 읽어온 사실.
//   dispatchReceiptMatchCount  -- dispatch-receipts.jsonl에서 harnessTaskLabel
//                                 과 정확히 일치하는 라인 수(호출자가 이미
//                                 세어옴).
//   resultArchiveExists        -- `.harness/rounds/<ROLE>-r<N>.md` 존재 여부.
//   ownTaskArchiveExists       -- `.harness/rounds/<role>-task-r<N>.md`
//                                 (이 라운드 자신) 존재 여부.
//   hasLaterRoundArchive       -- `.harness/rounds/<role>-task-r<N+1>.md`
//                                 (그 다음 라운드) 존재 여부.
//   staleEnoughSinceAdmission  -- boolean, 호출자가 admitted_at과 stall-watch
//                                 임계치로 이미 계산.
//   successorLabelForRecord    -- 은퇴 기록에 쓸 후속 이름표(문자열).
export function evaluateNeverConsumedRetirement({
  role,
  harnessTaskLabel,
  ledgerReservation,
  dispatchReceiptMatchCount,
  resultArchiveExists,
  ownTaskArchiveExists,
  hasLaterRoundArchive,
  staleEnoughSinceAdmission,
  successorLabelForRecord,
} = {}) {
  if (!isNonEmptyString(role) || !isNonEmptyString(harnessTaskLabel)) {
    return reject(
      NEVER_CONSUMED_RETIRE_STATE.LABEL_MISSING,
      "role 또는 harnessTaskLabel이 없음 -> 대상을 확정할 수 없음, 거부(안전측 기본값)",
    );
  }

  const ledgerFailure = checkLedgerFacts(
    ledgerReservation,
    role,
    harnessTaskLabel,
  );
  if (ledgerFailure) return ledgerFailure;

  if (dispatchReceiptMatchCount !== 1) {
    return reject(
      NEVER_CONSUMED_RETIRE_STATE.DISPATCH_RECEIPT_NOT_EXACTLY_ONE,
      `dispatch-receipts.jsonl 매칭 ${dispatchReceiptMatchCount}건(정확히 1건이어야 함) -> 0건이면 배달된 적 없는 라벨, 2건 이상이면 라벨 재사용/모호, 거부`,
    );
  }

  const archiveShapeFailure = checkArchiveShapeFacts({
    resultArchiveExists,
    ownTaskArchiveExists,
    hasLaterRoundArchive,
    staleEnoughSinceAdmission,
  });
  if (archiveShapeFailure) return archiveShapeFailure;

  if (!isNonEmptyString(successorLabelForRecord)) {
    return reject(
      NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_LABEL_MISSING,
      "후속 이름표(successorLabelForRecord)가 없음 -> 은퇴는 다음 라벨을 반드시 명시해야 함, 거부",
    );
  }

  return {
    state: NEVER_CONSUMED_RETIRE_STATE.OPEN,
    ok: true,
    reason: `hyk412-never-consumed: role=${role} label=${harnessTaskLabel} -- ledger ACTIVE+라벨 일치 + dispatch-receipt 정확히 1건 + 결과 아카이브 없음 + 자기 task 아카이브 있음 + 다음 라운드 아카이브 없음 + 충분히 오래됨 + 후속 이름표(${successorLabelForRecord}) 확인 -> "다음 라운드가 한 번도 드롭된 적 없는, 완전히 방치된 라운드"로 기계 판정, 은퇴 기록 작성 절차로 진행 가능(허용). 이 함수는 파일을 쓰지 않는다.`,
  };
}
