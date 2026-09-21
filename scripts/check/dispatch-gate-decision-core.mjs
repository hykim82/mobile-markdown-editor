// HYK-217-dispatch-gate-1/2R/3R (coder-task.md) -- «배달 도구가 스스로
// 게이트를 확인하고, 불통과면 배달을 거부한다」의 판단(코어).
//
// ★3R 설계 전환(게이트 2 판정 「가」, 한용 확정 2026-08-10 14:02): 1R/2R의
// checkGatePreconditions는 "나쁜 입력을 하나씩 찾아 막고, 못 찾으면 통과"
// (열거식)였다 -- 그 형태가 두 라운드 연속 같은 근본 결함(입력이 애매하면
// 통과시킨다)의 새 변종을 냈다(1R: task_id 삭제, 2R: task_id 중복/streak
// null). 3R은 방향을 뒤집는다: 기본값은 거부이고, 아래 checkGatePreconditions
// 가 정의하는 "확인된 사실 전부"가 명시적으로 성립했을 때만 통과를 허용한다
// (HYK-212 선례의 닫힌 상태 집합 방식). 새 애매함이 나오면 이제는 "허용
// 조건을 만족 못 함"으로 자동으로 거부 쪽에 떨어진다 -- 매 라운드 새
// 예외를 하나씩 추가하는 대신, 애초에 예외가 거부의 기본 상태다.
//
// 실사고(1R coder-task.md §0): 연속 반려 진단 게이트가 exit 2(불통과)를
// 냈는데 배달 도구(관제실 `dispatch-worker.ps1`, CI 없음)가 게이트 검사와
// 배달을 한 명령에 묶어 실행해 불통과인데도 배달이 나갔다. 방어는 "ORCH가
// 검사 결과를 보고 나서 배달한다"는 사람의 약속뿐이었다 -- 기계 앵커가
// 0이었다. 이 모듈은 그 앵커다: `reject-streak.mjs gate|diagnostic-gate`의
// 종료코드 + 배달 도구 자신이 미리 확인한 전제조건(2R §2)을 받아 배달
// 허용/거부를 판정하는 순수 함수. I/O, 자식 프로세스 실행, 다른 모듈 참조
// 0(dispatch-postcheck-core.mjs와 동일 계약) -- 호출부
// (dispatch-gate-decision.mjs)가 실제로 게이트를 실행/파일을 읽어 얻은 값만
// 구조화된 형태로 넘긴다.
//
// ★S11 헤더 3항(2R §4-1 지적 대응):
// ①**주장 범위**: 이 모듈이 증명하는 것은 "주어진 exitCode/전제조건 사실을
//   ALLOW/REJECT로 정확히 매핑한다"는 판정 로직 하나뿐이다. `reject-streak.mjs`
//   자신의 판정(무엇이 BLOCK/PASS인지)이 옳은지는 이 모듈의 증명 범위 밖 --
//   그 로직은 이 트랙이 건드리지 않는다(2R §1/§6). 또한 이 모듈이 실제로
//   *호출됐는지*는 이 파일 밖(dispatch-gate-decision.mjs의 CLI 배선,
//   그리고 그걸 부르는 배달 도구 자신)의 책임이다 -- gap#96이 이미 기록한
//   대로, 호출되지 않으면 이 판정은 아예 일어나지 않는다.
// ②**표본 수와 조건**: 아래 decideFromGateExit/checkGatePreconditions 각각의
//   유닛 시험 + dispatch-gate-decision.test.mjs의 CLI 종단 시험 참조(2R §4-2
//   대조군 표: 정상 오탐 0/N, 거부-기대 표본 별도 M건, N·M과 각 조건
//   .harness/coder.md에 병기). 이 헤더 자체는 표를 반복하지 않는다 --
//   근거가 코드 밖(결과 파일)에서 갱신될 때 이 헤더가 거짓이 되는 것을
//   막기 위해서다.
// ③**이 검사가 통과해도 여전히 열려 있는 구멍**(정직 한계, "보장하지
//   않는 것: 없음"으로 도망가지 않는다): (a) `reject-streak.mjs`를 거치지
//   않는 직접 `orca dispatch --inject` 호출은 이 모듈 자체가 관측조차
//   못한다(gap#96). (b) 3R이 방향을 뒤집었어도(기본 거부 + 확인된 사실만
//   허용) 확인 대상 "사실 목록" 자체는 여전히 이 코어가 유한하게 나열한
//   것이다(task_id 유일성/형식 · 원장 가독성 · 원장 항목 형태 · 게이트
//   명시 PASS) -- `reject-streak.mjs`가 내부적으로 다루는 입력 차원이
//   미래에 늘어나면(예: 오늘 없는 새 필드가 판정에 관여하게 되면) 이
//   목록이 그 차원을 모를 수 있다. 다만 방향이 바뀐 덕에 그 경우의
//   결과는 1R/2R과 다르다 -- "모르는 차원"은 이제 조용히 통과가 아니라
//   그 차원을 다루는 명시적 확인이 없으므로 **최종 게이트 실행 결과
//   자체**(exit 0/2/1 그 외)에 의해서만 걸러진다. 즉 이 코어가 놓친
//   새 차원이 있어도 실제 게이트가 그것 때문에 BLOCK/오류를 낸다면 여전히
//   거부된다 -- 완전히 열린 구멍이 아니라 "우리 사전 검사가 이유를
//   설명 못 하는 채로 게이트의 최종 판정에만 의존하게 되는" 축소된 위험이다.
//   (c) 원장 파일 부재를 거부로 처리하는 선택은 `reject-streak.mjs` 자신의
//   계약(원장 없음=streak 0, 정상)보다 엄격하다 -- 그 자체가 전이
//   비용이다(아래 checkGatePreconditions 헤더 참조). ★**절대주장 금지**:
//   이 방향 전환이 "모든 애매함"을 덮는다고 주장하지 않는다 -- 보장하는
//   것은 "기본값이 거부 쪽으로 이동했다"는 사실 하나다.
//
// §2 실측 계약(1R coder-task.md): `reject-streak.mjs gate|diagnostic-gate`의
// 종료코드는 세 가지뿐이다 -- 0(통과)/2(차단)/1(운영 오류, 실측된 유일한
// 발생원은 "task file not found"). 이 세 값 밖(예: 시그널로 죽어 exitCode가
// null인 경우)도 실제로 벌어질 수 있으므로 네 번째 상태로 명시한다.
//
// §2 요구된 판단(운영 오류를 어떻게 다룰 것인가):
// - "조회 실패 = 신호 없음 = 정상"으로 접지 않는다 -- exit 1은 ALLOW로 가지
//   않는다(그러면 이 트랙이 막으려는 침묵을 스스로 재생산한다).
// - "운영 오류 = 차단"으로 단순 뭉뚱그리면 거짓 경보가 된다는 경고도
//   있었으나, 이 게이트는 *배달을 막을지 말지*를 결정하는 사전 게이트다
//   (HYK-212 postcheck처럼 이미 벌어진 일을 사후 관찰하는 게 아니다 --
//   배달은 되돌릴 수 없다). "판정할 수 없다"를 "허용"으로 처리하면 원본
//   사고가 막으려던 바로 그 실패모드(불통과인데 배달됨)를 정확히
//   재현하므로, 안전측(fail-closed)이 유일하게 방어 가능한 기본값이다.
//   대신 거짓 경보 우려는 (a) REJECT_BLOCKED와 다른 상태 코드로 구분해
//   "내용이 나빠서"가 아니라 "판정 자체가 안 됐다"는 것을 사람이 즉시
//   구분하게 하고, (b) 이유 문자열에 원인(대개 task-path 오배선)과 조치를
//   함께 실어 오탐이 방치되지 않게 한다 -- 로 완화한다(코드 4-51-4).
// 3R §2 상태 표 -- 이 집합 밖은 없다(닫힌 집합). 각 상태의 뜻·근거:
//
// | 상태 | 뜻 | 무엇이 이 상태로 가는가 | 배달 |
// |---|---|---|---|
// | ALLOW | 게이트 서브프로세스 자신이 exit 0으로 명시 통과 | reject-streak.mjs gate/diagnostic-gate가 정확히 exit 0 | 허용 |
// | REJECT_BLOCKED | 게이트가 명시적으로 내용 문제로 차단 | 정확히 exit 2 | 거부 |
// | REJECT_OPERATIONAL_ERROR | 게이트를 실행할 순 있었지만 운영 오류 | 정확히 exit 1 | 거부 |
// | REJECT_UNKNOWN_EXIT | 위 세 값 밖의 모든 것(시그널 종료 포함) | exitCode가 0/1/2 중 어느 것도 아님 | 거부 |
// | REJECT_TASK_ID_NOT_UNIQUE | 이슈 식별자를 "유일하게" 읽어내지 못함 | task_id 줄이 0개 또는 2개 이상 | 거부 |
// | REJECT_TASK_ID_MALFORMED | 유일하지만 형식이 무효 | task_id 줄이 정확히 1개이나 HYK-<digits> 아님 | 거부 |
// | REJECT_LEDGER_MISSING | 원장을 읽을 대상 파일이 없음 | existsSync(ledgerPath) === false | 거부 |
// | REJECT_LEDGER_CORRUPT | 원장 파일은 있으나 읽기/파싱 실패 | loadLedger().ok === false | 거부 |
// | REJECT_LEDGER_ENTRY_MALFORMED | 원장은 읽었으나 해당 이슈 항목의 값이 해석 불가 | streak가 유한 음이 아닌 number가 아니거나 history가 배열이 아님(존재할 때) | 거부 |
// | REJECT_LEDGER_PATH_UNRESOLVABLE | 원장이 어느 저장소 소속인지 자체를 식별 못 함(원장 "부재"와 다른 원인) | taskPath(또는 --expect-repo-root)의 git 저장소 식별(`git rev-parse --git-common-dir`/`--is-bare-repository`) 실패 | 거부 |
// | REJECT_REPO_MISMATCH | taskPath가 실제로 속한 저장소가 호출자가 기대한 저장소와 다름 | `--expect-repo-root`가 주어졌고 그 저장소 루트가 taskPath의 저장소 루트와 불일치 | 거부 |
//
// ALLOW는 이 표의 단 하나의 행에서만 나온다 -- 그 행에 도달하려면 먼저
// checkLedgerPathResolution(HYK-220 2R 신설 -- 원장이 어느 저장소의 것인지
// 확정하는 축, checkGatePreconditions 이전 단계)이 통과(반환값 null)하고,
// 그 다음 checkGatePreconditions의 다섯 확인(유일성/형식/원장존재/원장읽기/
// 항목형태)이 *전부* 통과(반환값 null)해야 하고, 그 다음 실제 게이트
// 두 개가 각각 exit 0을 내야 한다(decideFromGateExit + combineGateDecisions).
// 그 외 모든 조합은 이 표의 REJECT_* 행 중 하나로 떨어진다 -- "그 외 전부"를
// 담는 자리가 REJECT_UNKNOWN_EXIT(게이트 실행 결과 축),
// checkLedgerPathResolution 자신의 실패 축, checkGatePreconditions 자신의
// 마지막 실패 검사(전제조건 축) 셋으로 삼중으로 닫혀 있다.
export const DISPATCH_GATE_STATE = Object.freeze({
  ALLOW: "ALLOW",
  REJECT_BLOCKED: "REJECT_BLOCKED",
  REJECT_OPERATIONAL_ERROR: "REJECT_OPERATIONAL_ERROR",
  REJECT_UNKNOWN_EXIT: "REJECT_UNKNOWN_EXIT",
  REJECT_TASK_ID_NOT_UNIQUE: "REJECT_TASK_ID_NOT_UNIQUE",
  REJECT_TASK_ID_MALFORMED: "REJECT_TASK_ID_MALFORMED",
  REJECT_LEDGER_MISSING: "REJECT_LEDGER_MISSING",
  REJECT_LEDGER_PATH_UNRESOLVABLE: "REJECT_LEDGER_PATH_UNRESOLVABLE",
  REJECT_REPO_MISMATCH: "REJECT_REPO_MISMATCH",
  REJECT_LEDGER_CORRUPT: "REJECT_LEDGER_CORRUPT",
  REJECT_LEDGER_ENTRY_MALFORMED: "REJECT_LEDGER_ENTRY_MALFORMED",
  REJECT_LEDGER_RESOLUTION_UNJUDGABLE: "REJECT_LEDGER_RESOLUTION_UNJUDGABLE",
  // HYK-239: reject-streak-chain.mjs wiring (dispatch-gate-decision.mjs's
  // evaluateChainDecision). Kept distinct from REJECT_BLOCKED (which means
  // "the gate SUBPROCESS itself said BLOCK") because these two originate
  // from a different check entirely (checkAppendOnly, not a gate exit
  // code) and from each other (판정 불가 vs. 판정됨-그리고-나쁨, §2 requirement
  // 2 -- see evaluateChainDecision's header comment for the fail-closed
  // rationale on the UNJUDGABLE branch specifically).
  REJECT_CHAIN_TAMPER_DETECTED: "REJECT_CHAIN_TAMPER_DETECTED",
  REJECT_CHAIN_UNJUDGABLE: "REJECT_CHAIN_UNJUDGABLE",
  // HYK-241 §2 조각2: dispatch-gate-decision.mjs's own 1-B precondition axis
  // (checkOneBPrecondition below) -- distinct from every REJECT_* above
  // because it originates from the task packet's OWN text (does it declare
  // 북극성 1-B 세 요건 or a prerequisite-work declaration), never from a
  // spawned gate subprocess or the reject-streak ledger.
  REJECT_ONE_B_MISSING: "REJECT_ONE_B_MISSING",
  // HYK-342 §4 요구6 (옆문 R4): evaluateConsumptionDecision's own bootstrap
  // check (dispatch-gate-decision.mjs) -- distinct from every REJECT_* above
  // because it originates from comparing "no live result file" against
  // "does .harness/rounds/ hold any archived round for this role", never
  // from a spawned gate subprocess, the reject-streak ledger, or the task
  // packet's own 1-B declaration.
  REJECT_RESULT_EVIDENCE_MISSING: "REJECT_RESULT_EVIDENCE_MISSING",
  // HYK-383 2R §2: dispatch-gate-decision.mjs's own head_commit precondition
  // axis (checkHeadCommitPrecondition below) -- distinct from every REJECT_*
  // above because it originates from the ABOUT-TO-BE-DELIVERED review task
  // packet's OWN text (does it declare an independent `head_commit:` cover
  // line naming the target commit), never from a spawned gate subprocess,
  // the reject-streak ledger, or the 1-B precondition. Four closed states,
  // matching relay-handshake.mjs's own consumption-side head_commit axis's
  // fail-closed shape (표지 부재/형식 위반/다중/조회 실패) at delivery time
  // instead of consumption time -- "대상 커밋을 지정하지 않은 REVIEW 배달은
  // 애초에 나가지 않는다" (coder-task.md §2 원문).
  REJECT_HEAD_COMMIT_MISSING: "REJECT_HEAD_COMMIT_MISSING",
  REJECT_HEAD_COMMIT_MALFORMED: "REJECT_HEAD_COMMIT_MALFORMED",
  REJECT_HEAD_COMMIT_AMBIGUOUS: "REJECT_HEAD_COMMIT_AMBIGUOUS",
  REJECT_HEAD_COMMIT_UNREADABLE: "REJECT_HEAD_COMMIT_UNREADABLE",
  // HYK-396 §2: dispatch-gate-decision.mjs's delivery-time dispatch_id stamp
  // axis (checkArchivedDispatchIdBinding below) -- distinct from every
  // REJECT_* above because it fires only when the normal 6-field binding
  // (consumption-receipt-core.mjs's bindingEqual) has ALREADY matched
  // (decision === null, would-be ALLOW) and the archived round-task
  // snapshot (.harness/rounds/<role>-task-r<N>.md header, envelope-
  // archive.mjs) carries a dispatch_id stamped at delivery time that
  // actively DISAGREES with the dispatch_id resolved for this same round
  // from the ledger (dispatch-receipts.jsonl) -- a forged/tampered stamp,
  // never a missing one (missing/unknown stamps skip this axis entirely,
  // coder-task.md §3 Q2 "값이 없으면 없다고 기록").
  REJECT_ARCHIVED_DISPATCH_ID_MISMATCH: "REJECT_ARCHIVED_DISPATCH_ID_MISMATCH",
});

function firstNonEmpty(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "(no output)";
}

// The one function this module exists to provide. Never throws, never
// returns a silent-allow state without a human-readable `reason` (coder-task
// §5-2 비타협: 허용이면 그 이유가 사람이 읽는 한 줄로 출력돼야 한다).
export function decideFromGateExit({ exitCode, stdout, stderr, label } = {}) {
  const tag = typeof label === "string" && label ? label : "dispatch gate";

  if (exitCode === 0) {
    return {
      state: DISPATCH_GATE_STATE.ALLOW,
      allow: true,
      reason: `${tag}: PASS(exit 0) -> 배달 허용 -- ${firstNonEmpty(stdout, stderr)}`,
    };
  }

  if (exitCode === 2) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_BLOCKED,
      allow: false,
      reason: `${tag}: BLOCK(exit 2) -> 배달 거부 -- ${firstNonEmpty(stderr, stdout)}`,
    };
  }

  if (exitCode === 1) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_OPERATIONAL_ERROR,
      allow: false,
      reason: `${tag}: 운영 오류(exit 1, 판정 불가) -> 배달 거부(안전측 기본값) -- 원인: ${firstNonEmpty(stderr, stdout)} -- 조치: task-path/ledger 배선을 확인하고 재시도하라`,
    };
  }

  return {
    state: DISPATCH_GATE_STATE.REJECT_UNKNOWN_EXIT,
    allow: false,
    reason: `${tag}: 알 수 없는 종료코드(${String(exitCode)}, 닫힌 상태 집합 {0,1,2} 밖) -> 배달 거부(안전측 기본값) -- stdout: ${firstNonEmpty(stdout)} / stderr: ${firstNonEmpty(stderr)}`,
  };
}

// 3R §2 -- 확증식(default-reject) precondition check: 이 함수는 이제
// "나쁜 입력 목록"이 아니라 "허용에 필요한 확인된 사실 목록"으로 읽어야
// 한다. 다섯 확인이 이 정확한 순서로 실행되고, ANY 하나라도 엄격하게
// (strict `!==`) 통과하지 못하면 그 즉시 REJECT_* 상태로 거부한다 -- 통과
// 여부가 애매하거나(값이 boolean이 아니거나, undefined이거나) 예상 밖
// 타입이면 전부 이 엄격 비교에서 자동으로 실패한다(예: `1`이나 `"true"`는
// `!== true`라 거부된다) -- 이게 "예상 밖 입력이 기본적으로 거부 쪽으로
// 떨어진다"는 요구(3R §2-2)를 지키는 방식이다. 마지막 확인까지 전부
// 통과했을 때만 null을 반환한다(caller가 이제 실제 게이트 두 개를 부를
// 차례라는 뜻 -- 그 실행 결과 자체도 decideFromGateExit이 exit===0만
// ALLOW로 매핑하므로 이중으로 안전측이다).
//
// 다섯 확인:
// 1. taskIdMatchCount === 1 -- task_id 줄이 "정확히 하나"일 때만 유일하게
//    읽어냈다고 확증한다(2R 검토 신규 반례 6: 줄이 2개면 reject-streak.mjs
//    자신의 정규식이 첫 match만 보고 뒤 줄의 streak을 무시한다 -- 그 관용을
//    고치지 않고, 애초에 "1개가 아니면" 이 사전 게이트가 통과시키지 않는다).
// 2. taskIdFormatValid === true -- 유일한 그 값이 HYK-<digits> 형식.
// 3. ledgerExists === true -- 원장 파일이 존재.
// 4. ledgerLoadOk === true -- reject-streak.mjs 자신의 loadLedger()가
//    성공(.ok).
// 5. ledgerEntryShapeValid === true -- 해당 이슈의 원장 항목이 "해석
//    가능한 형태"(아래 checkLedgerEntryShape 참조 -- 2R 검토 신규 반례 7:
//    streak가 null이면 reject-streak.mjs의 `?? 0`이 조용히 0으로 접는다 --
//    그 관용을 고치지 않고, 애초에 streak가 유효 number가 아니면 이
//    사전 게이트가 통과시키지 않는다).
//
// 6번째 확인(둘 다 게이트 exit 0)은 이 함수 밖, combineGateDecisions에서
// 이뤄진다 -- checkGatePreconditions는 "게이트를 부를 자격이 있는가"만
// 확증하고, "게이트가 실제로 뭐라 했는가"는 건드리지 않는다(단일 책임 유지,
// 2R의 기존 구조 그대로).
//
// REJECT_LEDGER_MISSING을 원장 부재에 선택한 이유는 2R 그대로(전이 비용
// 문서화, 아래 참고). 이 함수 자체는 `reject-streak.mjs`를 고치지 않고
// import도 하지 않는다(zero-import 코어 계약) -- 모든 입력은 caller가
// 이미 구조적으로 추출한 값이다(S8: 게이트의 화면 출력 문자열을 여기서
// 파싱하지 않는다).
export function checkGatePreconditions({
  taskIdMatchCount,
  taskIdFormatValid,
  ledgerExists,
  ledgerLoadOk,
  ledgerLoadReason,
  ledgerEntryShapeValid,
  ledgerEntryShapeReason,
} = {}) {
  if (taskIdMatchCount !== 1) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_TASK_ID_NOT_UNIQUE,
      allow: false,
      reason: `dispatch-gate-decision precondition: task_id 줄이 정확히 1개가 아님(실제 ${JSON.stringify(taskIdMatchCount)}개) -> 배달 거부(안전측 기본값 -- 확증식: 이슈 식별자를 유일하게 읽어내지 못하면 거부한다). 조치: task 파일에 'task_id: HYK-<n>...' 줄이 정확히 하나만 있는지 확인하라`,
    };
  }
  if (taskIdFormatValid !== true) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_TASK_ID_MALFORMED,
      allow: false,
      reason:
        "dispatch-gate-decision precondition: task_id 값이 'HYK-<digits>' 형식으로 해석되지 않음 -> 배달 거부(안전측 기본값). 조치: task_id 값을 'HYK-<숫자>...' 형식으로 고쳐라",
    };
  }
  if (ledgerExists !== true) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_LEDGER_MISSING,
      allow: false,
      reason:
        "dispatch-gate-decision precondition: reject-streak 원장 파일이 존재하지 않음 -> 배달 거부(안전측 기본값 -- reject-streak.mjs 자신은 원장 부재를 streak=0으로 허용하지만 이 사전 게이트는 더 엄격하다: 원장이 사라지면 모든 이슈의 반려 이력 기억도 함께 사라져 envelope 요구가 조용히 무력화될 수 있다). 조치: 원장 경로(--ledger 또는 기본 .harness/reject-streak.json)를 확인하라",
    };
  }
  if (ledgerLoadOk !== true) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_LEDGER_CORRUPT,
      allow: false,
      reason: `dispatch-gate-decision precondition: reject-streak 원장을 읽거나 파싱할 수 없음 -> 배달 거부(안전측 기본값) -- 원인: ${ledgerLoadReason ?? "(no detail)"}. 조치: 원장 파일을 복구하거나 백업에서 되살린 뒤 재시도하라`,
    };
  }
  if (ledgerEntryShapeValid !== true) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_LEDGER_ENTRY_MALFORMED,
      allow: false,
      reason: `dispatch-gate-decision precondition: 원장의 해당 이슈 항목이 해석 가능한 형태가 아님 -> 배달 거부(안전측 기본값 -- reject-streak.mjs 자신은 streak이 null이면 '?? 0'으로 조용히 접지만 이 사전 게이트는 그것을 확증 실패로 본다) -- 원인: ${ledgerEntryShapeReason ?? "(no detail)"}. 조치: 원장의 해당 항목을 복구하라`,
    };
  }
  return null;
}

// HYK-220 2R (P1-1/P1-2): a NEW, EARLIER precondition axis -- "which repo's
// ledger even IS this" -- kept as its OWN pure function rather than folded
// into checkGatePreconditions' five-field object, specifically so
// checkGatePreconditions' existing contract (ALL_GOOD fixture, five strict
// `=== true` checks) stays byte-for-byte unchanged; this is additive, not a
// rewrite of the already-reviewed 3R confirmative core (coder-task §1
// scope: "P1 3건만, 새 축 금지" -- this IS one of the three, not a fourth).
// Caller contract: `resolution` is whatever dispatch-gate-decision.mjs's
// resolveLedgerPath() produced -- `{ state: null, path }` on success (this
// function returns null, meaning "proceed to checkGatePreconditions"), or
// `{ state: <a REJECT_* string>, reason }` on failure (this function turns
// that into the same `{state, allow, reason}` shape every other decision in
// this module produces). P1-2: REJECT_LEDGER_PATH_UNRESOLVABLE (git itself
// could not identify a repo for taskPath, or for --expect-repo-root) is
// kept a DISTINCT state from REJECT_LEDGER_MISSING (a repo WAS identified,
// its .harness/reject-streak.json simply isn't there) -- the reviewer's P1-2
// finding was exactly that these two, operationally very different causes
// (git/environment failure vs. an ordinary missing file), were colliding
// into the same "원장 파일이 존재하지 않음" text. REJECT_REPO_MISMATCH
// (P1-1) is kept distinct from both -- a repo WAS identified for taskPath,
// a ledger MAY even exist there, but it is not the repo the caller said it
// expected (--expect-repo-root), which is a caller-wiring problem, not a
// filesystem-state problem.
// HYK-221 축2: `resolution?.state ?? null` used to collapse EVERY nullish
// shape -- a genuine successful resolution (`{path, state: null}`) AND a
// missing/malformed resolution object (`undefined`, `null`, `{}`,
// `{state: undefined}`) -- onto the exact same `null` return, which this
// function's caller reads as "proceed, all clear." That is indistinguishable
// from HYK-212's QUERY_FAILED precedent: "판정 불가" was being read as
// "정상 통과" purely because both happened to produce the same nullish
// value. A well-formed success from resolveLedgerPath() always ALSO carries
// a non-empty string `path` (its only two return shapes are
// `{path: <string>, state: null}` or `{path: null, state: <REJECT_*>}`) --
// so "state is nullish AND path is a non-empty string" is what actually
// means "resolved successfully," and a nullish state WITHOUT that path is
// reclassified as its own distinct reject state rather than silently folded
// into "proceed."
function isResolvedSuccessPath(resolution) {
  return (
    typeof resolution?.path === "string" && resolution.path.trim().length > 0
  );
}

export function checkLedgerPathResolution(resolution) {
  const state = resolution?.state ?? null;
  if (state === null) {
    if (isResolvedSuccessPath(resolution)) return null;
    return {
      state: DISPATCH_GATE_STATE.REJECT_LEDGER_RESOLUTION_UNJUDGABLE,
      allow: false,
      reason: `dispatch-gate-decision precondition: 원장 경로 판정 결과가 없거나 형태가 결손됨(${JSON.stringify(resolution)}) -> 배달 거부(안전측 기본값 -- "정상 통과"와 "판정 불가"를 같은 null로 접지 않는다)`,
    };
  }
  if (
    state !== DISPATCH_GATE_STATE.REJECT_LEDGER_PATH_UNRESOLVABLE &&
    state !== DISPATCH_GATE_STATE.REJECT_REPO_MISMATCH
  ) {
    // Closed-set defense (3R §2-2 pattern reused here): an unrecognized
    // state value from the caller is never silently treated as "proceed" --
    // it falls to the more general of the two new states rather than being
    // ignored.
    return {
      state: DISPATCH_GATE_STATE.REJECT_LEDGER_PATH_UNRESOLVABLE,
      allow: false,
      reason: `dispatch-gate-decision precondition: 원장 경로 판정이 인식되지 않는 상태를 반환함(${JSON.stringify(state)}) -> 배달 거부(안전측 기본값)`,
    };
  }
  return {
    state,
    allow: false,
    reason:
      typeof resolution?.reason === "string" && resolution.reason.trim()
        ? resolution.reason
        : `dispatch-gate-decision precondition: 원장 경로를 확정하지 못함(${state}) -> 배달 거부(안전측 기본값)`,
  };
}

// Extracted from checkLedgerEntryShape (quality-check: keep that function's
// own complexity under the repo's ESLint ceiling, same reason
// reject-streak.mjs extracts its own helpers). 4R §2 (검토 실측): streak는
// "몇 번 연속 반려됐는가"라는 정수 카운트다 -- `reject-streak.mjs`의 유일한
// 정상 생산 경로(`applyOutcome`)는 항상 `(prev.streak ?? 0) + 1` 형태의
// 정수 연산만 하므로, 정수가 아닌 streak(예: 1.5)은 정상 생산 경로가 만들
// 수 없는 값이다 -- 손상/직접 조작의 증거로 취급해 거부한다.
function isValidStreakValue(streak) {
  return (
    typeof streak === "number" &&
    Number.isFinite(streak) &&
    Number.isInteger(streak) &&
    streak >= 0
  );
}

// 3R §2/§3 반례 7: reject-streak.mjs의 checkGate/checkDiagnosticGate는
// `ledger?.issues?.[issueId]?.streak ?? 0`으로 읽는다 -- `??`는 null과
// undefined만 nullish로 접는다는 JS 자체 의미론이라, streak가 실제로는
// (예컨대 파일 손상으로) `null`인데 "streak 0(반려 이력 없음)"으로 조용히
// 오독된다. 이 순수 함수는 그 오독이 일어나기 전에, 원장에 적힌 값
// 그대로를 검사해 "해석 가능한 형태"인지 확증한다 -- entry가 아예 없으면
// (그 이슈가 한 번도 반려된 적 없다는 정상 상태) valid:true, 있는데
// streak이 유한 음이 아닌 number가 아니면 invalid, history가 존재하는데
// 배열이 아니어도 invalid(오늘 reject-streak.mjs의 읽기 경로는 history를
// 안 쓰지만, "해석 가능한 형태"라는 확증 대상에 함께 넣어 방어한다 -- S11
// 헤더 ③ 참고).
export function checkLedgerEntryShape(ledger, issueId) {
  const entry = ledger?.issues?.[issueId];
  if (entry === undefined) {
    return {
      valid: true,
      reason: `이슈 '${issueId}' 원장 항목 없음(반려 이력 없음, 정상)`,
    };
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return {
      valid: false,
      reason: `이슈 '${issueId}' 원장 항목이 일반 객체가 아님(${JSON.stringify(entry)})`,
    };
  }
  const { streak, history } = entry;
  // ⛔개별 값(예: 1.5)을 열거하지 않는다 -- isValidStreakValue라는 형태
  // 조건 하나로 판단한다(위 헤더 참고).
  if (!isValidStreakValue(streak)) {
    return {
      valid: false,
      reason: `이슈 '${issueId}'.streak이 유효한 음이 아닌 유한 정수가 아님(${JSON.stringify(streak)})`,
    };
  }
  if (history !== undefined && !Array.isArray(history)) {
    return {
      valid: false,
      reason: `이슈 '${issueId}'.history가 존재하지만 배열이 아님(${JSON.stringify(history)})`,
    };
  }
  return { valid: true, reason: `streak=${streak} 해석 가능` };
}

// HYK-241 §2 조각2 (배달 게이트에 «1-B 검문» 추가): a NEW, ADDITIVE precondition
// axis, kept as its OWN pure function rather than folded into
// checkGatePreconditions' existing five-field object -- same reason
// checkLedgerPathResolution (HYK-220 2R) was kept separate: so that function's
// already-reviewed contract (exactly five `=== true` checks, byte-for-byte)
// stays untouched, and every existing caller/test that never supplies these
// new facts is unaffected by this addition.
//
// 태스크 패킷은 다음 둘 중 하나를 갖춰야 한다:
//   ⓐ 북극성 1-B 세 요건 -- 1. 사람이 직접 칠 수 있는 실행 한 줄
//                          2. 그때 무엇이 보여야 하는지
//                          3. 울렸을 때 사람에게 도달하는 경로
//   ⓑ 선행 작업 선언 -- 이 작업이 어느 사람-실측 작업을 «위한» 선행인지 명시
// (2026-08-13 한용 확정: 1-B는 금지 필터가 아니라 우선순위다 -- 선행 작업은
// 허용되지만 목적을 명시해야 한다.) caller(dispatch-gate-decision.mjs의
// extractOneBFacts)가 태스크 텍스트에서 이미 구조적으로 추출한 사실만 받는다
// (S8: 이 코어는 정규식/파일을 스스로 읽지 않는다).
//
// ⛔ⓑ를 "아무 문장이나 있으면 통과"로 만들지 않는다: bValid는 caller가 최소
// 길이(현재 10자) 이상의 서술인지까지 확인한 결과여야 한다 -- 빈 값이나
// 한두 글자짜리 placeholder는 bDeclared:true여도 bValid:false로 떨어진다.
export function checkOneBPrecondition({
  aComplete,
  missingA,
  bDeclared,
  bValid,
} = {}) {
  if (aComplete === true) return null;
  if (bDeclared === true && bValid === true) return null;
  const missingAText =
    Array.isArray(missingA) && missingA.length > 0
      ? `ⓐ 누락 칸: ${missingA.join(", ")}`
      : "ⓐ 요건 미충족";
  const bText =
    bDeclared !== true
      ? "ⓑ 선행 작업 선언 없음('1b_prerequisite_for:' 줄 없음)"
      : "ⓑ 선행 작업 선언이 너무 짧아 근거로 보기 어려움(최소 10자 이상 서술 필요)";
  return {
    state: DISPATCH_GATE_STATE.REJECT_ONE_B_MISSING,
    allow: false,
    reason: `dispatch-gate-decision precondition: 북극성 1-B 세 요건(ⓐ) 또는 선행 작업 선언(ⓑ) 중 하나가 필요하나 둘 다 충족되지 않음 -- ${missingAText} / ${bText} -> 배달 거부(안전측 기본값 -- HYK-241 §2 조각2). 조치: task 패킷에 '1b_exec_line:'/'1b_shown:'/'1b_reach_path:' 세 줄을 모두 채우거나, '1b_prerequisite_for: <이 작업이 준비하는 사람-실측 작업>' 한 줄(10자 이상 서술)을 추가하라`,
  };
}

// HYK-383 2R §2: "대상 커밋을 지정하지 않은 REVIEW 배달은 애초에 나가지
// 않는다" -- 지금까지는 워커가 일을 다 한 뒤에야 relay-handshake.mjs의
// 소비 축(resolveHeadCommitBinding)이 이를 막았다(2026-08-28 23:14 실사고:
// 검토 라운드 하나를 통째로 버렸다). 이 함수는 그 실패를 배달 시점으로
// 앞당긴다 -- ⛔REVIEW 계열 배달에만 건다(caller가 이미 role을 판별해
// isReviewRole로 넘긴다, CODER/VERIFY/PM 배달은 즉시 null=통과). caller
// (dispatch-gate-decision.mjs의 extractHeadCommitFacts)가 태스크 파일
// 텍스트에서 이미 구조적으로 추출한 사실만 받는다(S8: 이 코어는 파일을
// 스스로 읽지 않는다).
//
// 닫힌 4상태(순서대로 확인, 첫 매치가 최종): 읽기 실패 > 부재/형식위반
// (근사매치 유무로 가른다) > 다중(2개 이상, 어느 것이 최종인지 결정할 수
// 없다 -- task_id/head_commit 소비축과 같은 결). 정확히 1개의 엄격 매치
// (줄 시작 독립 줄 + 소문자 `head_commit:` + 40-hex, caller가 이미 확정)
// 일 때만 null(통과).
export function checkHeadCommitPrecondition({
  isReviewRole,
  readOk,
  readErrorReason,
  headCommitMatchCount,
  headCommitNearMissPresent,
} = {}) {
  if (isReviewRole !== true) return null;
  if (readOk !== true) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_HEAD_COMMIT_UNREADABLE,
      allow: false,
      reason: `dispatch-gate-decision precondition: 검토 task 파일을 읽을 수 없음(HYK-383 2R) -- 원인: ${readErrorReason ?? "(no detail)"} -> 배달 거부(안전측 기본값 -- "확인 못하니 통과"는 금지). 조치: task 파일 경로/권한을 확인한 뒤 재시도하라`,
    };
  }
  if (headCommitMatchCount === 1) return null;
  if (headCommitMatchCount > 1) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_HEAD_COMMIT_AMBIGUOUS,
      allow: false,
      reason: `dispatch-gate-decision precondition: 검토 task 파일에 독립 'head_commit:' 표지가 ${headCommitMatchCount}개 있어 어느 것이 최종 대상 커밋인지 결정할 수 없음(HYK-383 2R) -> 배달 거부(안전측 기본값). 조치: task 파일에 'head_commit: <40자리 hex>' 줄을 정확히 하나만 남겨라`,
    };
  }
  if (headCommitNearMissPresent === true) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_HEAD_COMMIT_MALFORMED,
      allow: false,
      reason:
        "dispatch-gate-decision precondition: 검토 task 파일에 'head_commit:'로 보이는 흔적은 있으나 줄 시작 독립 줄이 아니거나(문장 중간·코드펜스 등), 정확히 소문자 'head_commit:'가 아니거나, 값이 40자리 hex가 아님(HYK-383 2R) -> 배달 거부(안전측 기본값 -- 대문자 'HEAD_COMMIT:'는 더 이상 표지로 인정되지 않는다). 조치: 'head_commit: <40자리 hex>' 형식의 독립 줄로 고쳐라",
    };
  }
  return {
    state: DISPATCH_GATE_STATE.REJECT_HEAD_COMMIT_MISSING,
    allow: false,
    reason:
      "dispatch-gate-decision precondition: 검토 task 파일에 대상 커밋을 지정하는 'head_commit:' 표지가 없음(HYK-383 2R) -> 배달 거부(안전측 기본값 -- 대상 커밋 없는 REVIEW 배달은 애초에 나가지 않는다). 조치: task 파일에 'head_commit: <판정 대상 커밋 40자리 hex>' 줄 시작 독립 줄을 추가하라",
  };
}

// Combines N independent gate decisions (e.g. `gate` + `diagnostic-gate`,
// which coder-task.md §2 confirms are independent and both apply) into one
// delivery verdict: ALLOW only if every decision ALLOWs. Reject reasons are
// never dropped -- every non-allow decision's reason is preserved in
// `reasons` so a human reading the CLI output sees exactly which gate(s)
// blocked and why, not just an aggregate boolean.
export function combineGateDecisions(decisions) {
  const list = Array.isArray(decisions) ? decisions : [];
  const allow = list.length > 0 && list.every((d) => d?.allow === true);
  return {
    allow,
    reasons: list.map((d) => d?.reason ?? "(missing decision)"),
    states: list.map((d) => d?.state ?? null),
  };
}
