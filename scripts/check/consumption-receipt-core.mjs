// HYK-244-receipt-core-1 (coder-task.md) -- «소비 완료 영수증» 판정 코어.
//
// §1 왜 이걸 만드는가(실측, coder-task.md §1 원문 인용): 2026-08-13 오후,
// REVIEW 반려를 소비하지 않아 반려가 원장에 안 적혔고, 그동안 «연속반려
// 정지» 안전장치가 계수 0으로 조용히 무장 해제됐다(약 1시간). 이 사고를
// 파다 보니 더 깊은 사실이 드러났다: `relay-handshake.mjs`의
// `checkRelayHandshake`는 ok:true를 반환하기 직전에 `autoArchiveRoundEnvelope`
// / `autoArchiveRoundTaskFile` / `autoRecordRejectStreak` 세 후속효과를
// 전부 호출하지만(같은 성공 분기), 그 중 하나가 실패해도 console.error로
// 로그만 찍고 checkRelayHandshake 자신의 반환값·CLI exit code는 그대로
// ok:true/exit 0이다(직접 읽어 확인 -- relay-handshake.mjs 480-497행,
// autoArchiveRoundEnvelope/autoArchiveRoundTaskFile/autoRecordRejectStreak가
// 셋 다 outcome.ok를 로그로만 쓰고 반환값에 반영하지 않는다;
// envelope-archive.mjs의 archiveRoundEnvelope/archiveRoundTaskFile도
// "Never throws"를 스스로 계약해 실패를 {ok:false, reason}으로만 돌려준다).
// ⇒ ***«handshake를 불렀다»도 «결과 파일이 있다»도 «소비 완료»와 동의어가
// 아니다.*** 이 모듈이 믿는 것은 그 셋(과 REVIEW 계열은 원장 반영까지)이
// «이 라운드에 대해 전부 성공했다»는 별도 영수증 하나뿐이다.
//
// §2 S8 원칙: 이 코어는 파일을 스스로 읽지 않고 정규식으로 텍스트를 훑지
// 않는다(zero-import 코어 계약, 아래 zero-import 시험 참조). 호출자(2R의
// dispatch-gate-decision.mjs 쪽 어댑터)가 이미 구조적으로 추출한 사실만
// 인자로 받는다 -- 선례: dispatch-gate-decision-core.mjs의
// checkOneBPrecondition이 extractOneBFacts의 결과만 받는 구조.
//
// §3 결속(binding) 설계 -- 왜 taskId 단독이 아닌가(⛔coder-task.md §2 요구
// 그대로): reject-streak.mjs의 computeRecord(262-306행) 자신의 헤더 주석이
// 직접 실측을 남겼다 -- "2026-08-05 원장 표본"에서 ORCH가 같은 이슈의
// 서로 다른 라운드 둘 다에 «반복해» 같은 bare 이슈 id(라운드 접미사 없이)를
// `for:`/`task_id:`에 썼고(예: `HYK-186`이 같은 날 두 번 반려), 그 결과
// task_id+verdict만 보던 옛 dedup 키가 두 번째 진짜 반려를 "첫 번째 호출의
// 재시도"로 오인해 조용히 삼켰다(§1 축 A: "게이트가 안 걸린다"). 그 수리로
// computeRecord는 각 라운드가 스스로 찍는 `>>> DONE: ... @ <time>` 유래
// `doneAt`을 세 번째 키 성분으로 추가했다 -- "진짜로 다른 라운드끼리는
// 다르지만, 같은 확정 파일을 다시 부른 재시도끼리는 똑같이 유지되는" 유일한
// 신호이기 때문이다.
//
// HYK-244-receipt-core-1c(검토 1R 반려 원문 6번 실측 대응): 1R/1R-b는
// `droppedAt`(relay-handshake.mjs가 task 파일에서 파싱하는 필드) 하나만
// computeRecord의 교훈을 흉내내 3성분(taskId/role/droppedAt)으로 썼는데,
// 검토자가 직접 실측했듯 `droppedAt`은 `YYYY-MM-DD HH:MM KST` **분** 단위
// (parseKstTimestamp, relay-handshake.mjs 300-309행)라서 같은 이슈·같은
// 역할의 두 라운드가 같은 분에 드롭되면 세 값이 전부 같을 수 있다 -- 정확히
// computeRecord가 고치려던 "같은 날 두 번" 충돌의 축소판이 "같은 분"으로
// 재발한다. 그래서 이 라운드는 computeRecord 자신이 쓴 바로 그 네 번째
// 성분 -- **`doneAt`**(라운드 자신의 `>>> DONE: ... @ <time>` 원문, 실측
// `.harness/review.md`의 `>>> DONE: REVIEW @ 2026-08-14 06:04:39 KST`처럼
// **초 단위까지 담긴 원문 그대로**) -- 를 결속에 추가한다. droppedAt은
// task 파일(이 라운드에게 «무엇을 하라»고 지시한 문서)에서, doneAt은 결과
// 파일(이 라운드가 «다 됐다»고 스스로 찍은 문서)에서 오므로 두 성분은
// 서로 다른 원본 파일에서 독립적으로 재대조 가능하다(검토자 요구 "영수증과
// 현재 입력 양쪽에서 독립적으로 재대조 가능"). 두 라운드가 진짜로 다르면
// (재시도가 아니라) 완료 시각이 초 단위로까지 우연히 일치할 확률은
// computeRecord가 이미 받아들인 위험과 동급으로 낮다 -- 이 라운드는 그
// 이미 승인된 위험 수준을 그대로 재사용할 뿐, 새 위험을 만들지 않는다.
// 결속은 이제 **(taskId, role, droppedAt, doneAt)** 4성분이며, 넷 다 전부
// 같아야 "같은 라운드"로 본다 -- 어느 하나만 달라도(§2 RED 결속변이
// 요구대로) 결속 불일치다.
//
// §3-b REVIEW 계열 판별 -- 왜 `role === "REVIEW"` 정확 일치가 아닌가
// (검토 1R 반려 원문 5번 실측 대응): `reject-streak.mjs`를 직접 읽으면
// (385-394행) 이 저장소가 이미 쓰는 판별 규칙이 있다 --
// `REVIEW_ROLE_RE = /^review/i`, 즉 "review로 시작하면(대소문자 무관)
// REVIEW 계열"이다. 그 파일 자신의 주석이 이유를 밝힌다: `relay-
// handshake.mjs`가 `role`을 `${role}-task.md`/`${role}.md` 파일 접두사로
// 그대로 쓰고, 실제 호출 관례가 정확히 대문자 "REVIEW"가 아니라 소문자
// "review"이기 때문이다(review-gate.mjs·reject-streak.mjs 둘 다 이
// 정규식으로 판별). 1R/1R-b가 쓴 `role === "REVIEW"` 정확 일치는 이
// 저장소의 실제 호출 관례와 다른 임의의 표기를 새로 만든 것이었다 --
// 검토자가 소문자 `review`를 직접 넣어 `ledgerRecorded` 누락이 조용히
// PASS로 새는 것을 재현했다. 이 모듈은 같은 정규식(`/^review/i`)을
// **그대로 복제**해 쓴다(zero-import 계약상 reject-streak.mjs를 import할
// 수 없으므로 -- 아래 zero-import 시험 참조) -- 새 규칙을 발명하지 않고
// 이미 검증된 저장소 관례를 그대로 재사용한다.
//
// §3-c 결속 «주 열쇠» 재설계(HYK-244-receipt-core-1d, ★한용 확정 문면
// 2026-08-14 06:27 · 지정 사항, 자유 설계 아님): 검토자가 1R-c 재검에서
// `doneAt`을 «주 열쇠»로 쓴 설계 자체의 구멍 둘을 실측했다.
// (a) 반려2: 실제 결과 표본을 `Get-ChildItem .harness\rounds -Filter
//     '*.md' -File | Select-String '^>>> DONE:'`로 세면 DONE 4건 중
//     CODER 3건은 **분 단위**였고 REVIEW 1건만 초 단위였다(검토자 실측
//     원문). 즉 "doneAt이 초 단위라 같은 분 충돌을 막는다"는 1R-c의
//     전제가 실제 생산 관례에서 깨진다 -- 같은 분에 끝난 두 CODER
//     라운드가 같은 분 단위 doneAt을 남길 수 있다.
// (b) 신규 결함: `bindingEqual`이 `a?.doneAt === b?.doneAt`만 검사해서,
//     양쪽 다 `doneAt`이 없으면(둘 다 undefined) 그 비교가 **참**이
//     되어 다른 필수 성분이 멀쩡하면 PASS로 샜다 -- "결속 성분이
//     없으면 거부"가 아니라 "없어도 같으면 통과"였던 것이 결함이다.
//
// ★한용 확정(2026-08-14 06:27, 조정 금지)이 못 박은 재설계:
// - **주 열쇠 = `resultFingerprint`(결과물 지문) + `dispatchId`(배달
//   식별자)** 둘 다 필수. 이 코어는 둘 다 값을 **비교만** 한다 -- 지문을
//   무엇으로 계산할지·dispatchId를 어디서 가져올지는 2R 어댑터(생산
//   배달기 결선)의 몫이며, 이 코어는 여전히 zero-import·파일 미접근
//   (S8)이라 파일을 읽어 지문을 만들 수 없다.
// - **`doneAt`은 보조로 강등** -- 더 이상 "같은 라운드인가"를 가르는
//   주 열쇠가 아니다(주 열쇠는 이제 resultFingerprint+dispatchId가
//   전담). 그러나 **없으면(누락·빈 값) 거부**하고, **분 단위(초 없음)도
//   거부**한다 -- (b)에서 실측된 "없어도 같으면 통과"를 원천적으로
//   막기 위해 currentBinding 자체의 doneAt이 «유효한 형태»(비어 있지
//   않고 초 단위)가 아니면 candidates를 보기도 전에 거부한다
//   (checkBindingPreconditions, 아래).
// - `resultFingerprint`/`dispatchId`도 같은 이유로 누락(빈 값)이면
//   candidates 매칭 전에 거부한다 -- "둘 다 없으면 같다"로 새는 구멍을
//   같은 검사 하나로 세 성분 전부에서 닫는다.
// - 기존 taskId/role/droppedAt은 유지한다(⛔지시서가 제거를 요구하지
//   않았다) -- 여전히 bindingEqual의 비교 대상이지만, 이제 «주 열쇠»는
//   아니다.
//
// §4 닫힌 상태 집합(위 표 그대로, 이 집합 밖은 없다):
//
// | 상태 | 뜻 | 무엇이 이 상태로 가는가 |
// |---|---|---|
// | PASS | 영수증이 현재 라운드와 결속되고 필수 후속효과 전부 성공 | checkBindingPreconditions 통과 && matches.length===1 && (REVIEW 계열이면 verdictLineCount===1) && 모든 필수 effect===true |
// | RECEIPT_MISSING | 결과는 있는데 영수증 후보가 하나도 없음 | candidates 배열이 비어 있음(전제조건은 이미 통과) |
// | BINDING_MISMATCH | currentBinding 자신의 주 열쇠·doneAt이 무효(누락/분단위)이거나, 후보는 있으나 현재 라운드와 결속된 것이 하나도 없음 | checkBindingPreconditions 실패, 또는 matches.length===0 (candidates.length>0) |
// | VERDICT_AMBIGUOUS | 결속 일치 후보가 둘 이상이거나(어느 것이 최종인지 결정 불가), REVIEW 계열(`/^review/i`)에서 판정 줄이 없거나 둘 이상 | matches.length>=2, 또는 isReviewFamilyRole(role) && verdictLineCount!==1 |
// | PARTIAL_SUCCESS | 결속은 유일하게 일치하나 필수 후속효과 중 하나라도 실패·미확인 | matches.length===1, 판정 명확, 그러나 requiredEffectKeys 중 하나 이상 !==true |
//
// currentBinding 자신의 전제조건 실패를 BINDING_MISMATCH로 묶은 이유:
// 새 상태를 만들지 말라는 지시(§5 금지) 아래, "이 라운드 자신의 결속이
// 온전한 형태를 못 갖췄다"는 것도 개념적으로 "결속이 성립하지 않는다"는
// 동일한 판단이다 -- VERDICT_AMBIGUOUS가 "결속 일치 후보 복수"와
// "REVIEW 판정 줄 복수/부재"를 이미 같은 방식으로 묶은 선례(§4 아래
// 문단)와 같은 재사용 논리다.
//
// PASS는 이 표의 단 하나의 행에서만 나온다 -- 그 외 모든 조합은 나머지
// 4개 REJECT 계열 상태 중 하나로 떨어진다("판정 불가"를 "정상"으로 접지
// 않는다 -- HYK-183/HYK-212의 반복된 실사고 패턴과 동일한 이유).
//
// VERDICT_AMBIGUOUS가 "결속 일치 후보 복수"와 "REVIEW 판정 줄 복수/부재"를
// 함께 담는 이유: 개념적으로 둘 다 "이 코어가 하나를 조용히 골라잡지 않고,
// 어느 것이 최종인지 결정할 수 없다는 사실 자체를 거부 사유로 삼는다"는
// 같은 형태의 판단이다(TASK_ID_RE_G/DONE_RE의 "매치 2개 이상 -> 판정 불가"
// 선례와 동일 계열, relay-handshake.mjs 19-22행 주석 참조). §2에 요구된
// 6종 시험 중 "RED 결속변이"(단일 필드만 다른 «단 하나의» 후보)는 항상
// matches.length===0(BINDING_MISMATCH)으로 떨어지므로 VERDICT_AMBIGUOUS의
// "복수 매치" 경로와 절대 겹치지 않는다 -- 두 상태는 서로 다른 candidates
// 형태(0개 vs 2개 이상)에서만 각각 발생한다.
//
// §5 필수 후속효과(coder-task.md §2 PM 판정 그대로):
// - 모든 역할 공통: 결과 봉투 보존(envelopeArchived) · 지시서 보존
//   (taskArchived) · 예약 반납(admissionReturned)
// - REVIEW 계열(`/^review/i`, §3-b) 추가: 반려/승인 원장 반영
//   (ledgerRecorded)
//
// §6 정직 한계(⛔coder-task §4-5 요구): 이 코어는 "영수증이 주어졌을 때
// 그것을 ALLOW/REJECT로 정확히 매핑한다"는 판정 로직 하나만 증명한다.
// (a) 후보(candidates) 자체를 실제 파일에서 뽑아내는 일 -- relay-handshake.mjs
// / envelope-archive.mjs / reject-streak.mjs를 읽어 구조화하는 일 -- 은 이
// 라운드의 범위 밖이며(§3 금지: 생산 배달기 결선 0), 2R이 만들 어댑터의
// 몫이다. (b) 이 판정이 실제로 *호출*되는지, 그 결과가 실제 배달 경로의
// combineGateDecisions에 실제로 합류하는지는 이 모듈 밖 -- 지금은 어떤
// 생산 코드도 이 파일을 import하지 않는다(§3 금지 그대로, 이 라운드는 계약
// 고정+시험까지다). 즉 **이 라운드는 생산 배달 경로에 결선되지 않았다 --
// 지금은 아무 배달도 막지 않는다.**

export const CONSUMPTION_RECEIPT_STATE = Object.freeze({
  PASS: "PASS",
  RECEIPT_MISSING: "RECEIPT_MISSING",
  BINDING_MISMATCH: "BINDING_MISMATCH",
  VERDICT_AMBIGUOUS: "VERDICT_AMBIGUOUS",
  PARTIAL_SUCCESS: "PARTIAL_SUCCESS",
});

const BASE_REQUIRED_EFFECTS = Object.freeze([
  "envelopeArchived",
  "taskArchived",
  "admissionReturned",
]);
const REVIEW_ONLY_EFFECT = "ledgerRecorded";

// §3-b -- reject-streak.mjs 385행의 REVIEW_ROLE_RE를 그대로 복제(zero-
// import 계약상 그 파일을 import할 수 없다). "review"로 시작하면(대소문자
// 무관 -- "review"/"REVIEW"/"review2" 전부 포함) REVIEW 계열이다.
const REVIEW_ROLE_RE = /^review/i;

function isReviewFamilyRole(role) {
  return typeof role === "string" && REVIEW_ROLE_RE.test(role);
}

// §5 -- role별 필수 후속효과 키 목록. REVIEW 계열만 원장 반영 축이
// 추가된다(coder-task.md §2 원문, 판별은 §3-b isReviewFamilyRole).
function requiredEffectKeysFor(role) {
  return isReviewFamilyRole(role)
    ? [...BASE_REQUIRED_EFFECTS, REVIEW_ONLY_EFFECT]
    : [...BASE_REQUIRED_EFFECTS];
}

// §3 결속 6성분(taskId/role/droppedAt/resultFingerprint/dispatchId/
// doneAt)이 전부 엄격히(===) 같아야 "같은 라운드"로 본다. 하나라도
// 다르면(undefined 포함) 결속 불일치 -- 예상 밖 입력이 기본적으로 거부
// 쪽으로 떨어지는 3R dispatch-gate-decision-core.mjs 선례와 동일한 엄격
// 비교 방식이다. resultFingerprint/dispatchId가 §3-c의 «주 열쇠»다.
// (품질: 6개 필드를 나열해 매번 `&&`로 잇는 대신 목록+every()로 묶어
// eslint complexity 한도 안에 둔다 -- 성분이 늘어도 새 `&&`를 추가하는
// 대신 이 목록에 이름만 추가하면 된다.)
const BINDING_FIELDS = Object.freeze([
  "taskId",
  "role",
  "droppedAt",
  "resultFingerprint",
  "dispatchId",
  "doneAt",
]);

function bindingEqual(a, b) {
  return BINDING_FIELDS.every((field) => a?.[field] === b?.[field]);
}

function describeBinding(binding) {
  const described = {};
  for (const field of BINDING_FIELDS) {
    described[field] = binding?.[field] ?? null;
  }
  return JSON.stringify(described);
}

// §3-c -- doneAt이 "초 단위까지 담긴 원문"인지 확인. 실측(검토자 원문):
// `2026-08-14 06:04:39 KST`(초 단위·유효) vs `2026-08-14 06:13 KST`
// (분 단위·무효). 시각을 파싱하지 않고(zero-import·S8) 문자열 안에
// `HH:MM:SS` 형태(콜론 2개로 구분된 두 자리 숫자 세 묶음)가 있는지만
// 정규식으로 확인한다 -- 이 코어가 만들 수 있는 가장 얕은 검사이면서,
// "초가 있는가"라는 딱 필요한 질문에 정확히 답한다.
const SECONDS_PRECISION_RE = /\d{2}:\d{2}:\d{2}/;

function hasSecondsPrecision(doneAt) {
  return typeof doneAt === "string" && SECONDS_PRECISION_RE.test(doneAt);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// §3-c 신규 결함 수리(검토 1R-c 재검 «신규 결함» 원문 대응): candidates를
// 보기도 전에, currentBinding 자신이 «주 열쇠»(resultFingerprint/
// dispatchId)와 doneAt(보조, 하지만 필수+초단위)을 온전히 갖췄는지
// 확인한다. 이 확인이 없으면 currentBinding과 후보 양쪽 다 같은 필드가
// 비어 있을 때 bindingEqual의 `===`가 `undefined === undefined -> true`
// 로 조용히 통과시킨다 -- 검토자가 직접 재현한 그 결함이다. 통과면
// null, 아니면 checkConsumptionReceipt 최종 반환 모양(BINDING_MISMATCH
// -- §3-c 상단 주석에 재사용 근거 기재, 새 상태를 만들지 않는다).
function checkBindingPreconditions(currentBinding) {
  if (!isNonEmptyString(currentBinding?.resultFingerprint)) {
    return {
      state: CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH,
      ok: false,
      reason: `consumption-receipt: 현재 라운드 결속에 결과물 지문(resultFingerprint)이 없거나 비어 있음 -> 주 열쇠 미확정, 거부(안전측 기본값 -- "없으면 막는다", 한용 확정 §3). 기대 결속: ${describeBinding(currentBinding)}`,
    };
  }
  if (!isNonEmptyString(currentBinding?.dispatchId)) {
    return {
      state: CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH,
      ok: false,
      reason: `consumption-receipt: 현재 라운드 결속에 배달 식별자(dispatchId)가 없거나 비어 있음 -> 주 열쇠 미확정, 거부(안전측 기본값 -- "없으면 막는다", 한용 확정 §3). 기대 결속: ${describeBinding(currentBinding)}`,
    };
  }
  if (!isNonEmptyString(currentBinding?.doneAt)) {
    return {
      state: CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH,
      ok: false,
      reason: `consumption-receipt: 현재 라운드 결속에 완료시각(doneAt)이 없거나 비어 있음 -> 거부(안전측 기본값 -- "없으면 막는다", 한용 확정 §3, 신규 fail-open 결함 수리). 기대 결속: ${describeBinding(currentBinding)}`,
    };
  }
  if (!hasSecondsPrecision(currentBinding.doneAt)) {
    return {
      state: CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH,
      ok: false,
      reason: `consumption-receipt: 완료시각(doneAt='${currentBinding.doneAt}')이 초 단위 정밀도가 아님(HH:MM:SS 형태 없음) -> 거부(안전측 기본값 -- 한용 확정 §3, 검토자 실측: 결과 표본 4건 중 CODER 3건 전부가 분 단위였다). 기대 결속: ${describeBinding(currentBinding)}`,
    };
  }
  return null;
}

// HYK-244-receipt-core-1b (품질 보정, ⛔설계·상태집합·사유 문자열 변경
// 0): 아래 세 헬퍼(resolveMatchingCandidate/checkReviewVerdictLine/
// checkRequiredEffects)는 checkConsumptionReceipt 하나였던 몸통을 그대로
// 쪼갠 것뿐이다 -- eslint complexity(13 > 12) 초과를 "판정을 합치거나
// 상태를 줄여서"가 아니라 "각 판정 단계를 작은 순수 함수로 분리해서"
// 낮춘다(1R-b coder-task.md §2 권고 방향 그대로). 각 헬퍼가 반환하는
// state/reason 문자열은 원래 checkConsumptionReceipt 안에 있던 것과
// 바이트 단위로 동일 -- 동작 불변의 증거는 기존 15개 시험이 그대로
// 통과하는 것(coder.md 참조).

// list(후보 배열)를 currentBinding으로 좁혀 정확히 하나의 영수증을 고른다.
// 반환: 성공 시 { ok:true, receipt }, 실패 시(개수 0개 또는 2개 이상)
// { ok:false, result:<checkConsumptionReceipt 최종 반환 모양> }.
function resolveMatchingCandidate(list, currentBinding) {
  if (list.length === 0) {
    return {
      ok: false,
      result: {
        state: CONSUMPTION_RECEIPT_STATE.RECEIPT_MISSING,
        ok: false,
        reason: `consumption-receipt: ${currentBinding?.role ?? "(role 미상)"} 라운드에 소비 완료 영수증 후보가 하나도 없음 -> 미소비로 판정, 거부(안전측 기본값). 기대 결속: ${describeBinding(currentBinding)}`,
      },
    };
  }

  const matches = list.filter((c) => bindingEqual(c?.binding, currentBinding));

  if (matches.length === 0) {
    const seen = list.map((c) => describeBinding(c?.binding)).join(" / ");
    return {
      ok: false,
      result: {
        state: CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH,
        ok: false,
        reason: `consumption-receipt: 영수증 후보 ${list.length}건 중 현재 라운드 결속(${describeBinding(currentBinding)})과 일치하는 것이 없음 -> 다른 라운드/역할의 영수증으로 판정, 미소비 취급(안전측 기본값). 발견된 결속: ${seen}`,
      },
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      result: {
        state: CONSUMPTION_RECEIPT_STATE.VERDICT_AMBIGUOUS,
        ok: false,
        reason: `consumption-receipt: 현재 라운드 결속(${describeBinding(currentBinding)})과 일치하는 영수증 후보가 ${matches.length}개 -- 어느 것이 최종인지 결정할 수 없다(ambiguous) -> 조용히 하나를 고르지 않고 영수증 미발행 상태로 취급, 거부(안전측 기본값)`,
      },
    };
  }

  return { ok: true, receipt: matches[0] };
}

// REVIEW 계열(§3-b isReviewFamilyRole)에서만 의미가 있는 판정 줄 개수
// 확인. 통과면 null, 아니면 checkConsumptionReceipt 최종 반환 모양.
function checkReviewVerdictLine(role, receipt) {
  if (!isReviewFamilyRole(role)) return null;
  const verdictLineCount = receipt?.verdictLineCount;
  if (verdictLineCount === 1) return null;
  return {
    state: CONSUMPTION_RECEIPT_STATE.VERDICT_AMBIGUOUS,
    ok: false,
    reason: `consumption-receipt: REVIEW 판정 줄이 정확히 1개가 아님(실제 ${JSON.stringify(verdictLineCount ?? null)}개) -> 판정을 고르지 않고 영수증 미발행 상태로 취급, 거부(안전측 기본값)`,
  };
}

// 필수 후속효과 전부 성공했는지 확인. 통과면 null, 아니면
// checkConsumptionReceipt 최종 반환 모양.
function checkRequiredEffects(role, receipt) {
  const requiredKeys = requiredEffectKeysFor(role);
  const failedKeys = requiredKeys.filter(
    (key) => receipt?.effects?.[key] !== true,
  );
  if (failedKeys.length === 0) return null;
  return {
    state: CONSUMPTION_RECEIPT_STATE.PARTIAL_SUCCESS,
    ok: false,
    reason: `consumption-receipt: 결속은 일치하나 필수 후속효과 중 ${failedKeys.join(", ")} 이(가) 성공 확인되지 않음 -> 부분 성공, 미소비 취급(안전측 기본값). 필수 목록: ${requiredKeys.join(", ")}`,
  };
}

// The one function this module exists to provide (mirrors
// dispatch-gate-decision-core.mjs's decideFromGateExit/checkGatePreconditions
// contract). Never throws, never returns PASS without every required fact
// checked, never returns a non-PASS state without a human-readable `reason`.
//
// facts:
//   role          -- REVIEW 계열 여부(§3-b isReviewFamilyRole, `/^review/i`)로
//                    필수 후속효과 목록이 갈린다.
//   currentBinding -- { taskId, role, droppedAt, resultFingerprint,
//                    dispatchId, doneAt } 이 라운드 자신의 결속(§3/§3-c,
//                    6성분 -- resultFingerprint+dispatchId가 주 열쇠,
//                    doneAt은 보조지만 필수+초단위).
//   candidates    -- 호출자가 이미 구조적으로 추출한 영수증 후보 배열.
//                    각 원소: { binding: {taskId, role, droppedAt,
//                    resultFingerprint, dispatchId, doneAt},
//                    effects: { envelopeArchived, taskArchived,
//                    admissionReturned, ledgerRecorded? },
//                    verdictLineCount? }. 빈 배열/undefined는 "영수증
//                    없음"으로 취급한다.
export function checkConsumptionReceipt({
  role,
  currentBinding,
  candidates,
} = {}) {
  const preconditionProblem = checkBindingPreconditions(currentBinding);
  if (preconditionProblem) return preconditionProblem;

  const list = Array.isArray(candidates) ? candidates : [];

  const matched = resolveMatchingCandidate(list, currentBinding);
  if (!matched.ok) return matched.result;
  const { receipt } = matched;

  const verdictProblem = checkReviewVerdictLine(role, receipt);
  if (verdictProblem) return verdictProblem;

  const effectsProblem = checkRequiredEffects(role, receipt);
  if (effectsProblem) return effectsProblem;

  const requiredKeys = requiredEffectKeysFor(role);
  return {
    state: CONSUMPTION_RECEIPT_STATE.PASS,
    ok: true,
    reason: `consumption-receipt: ${role ?? "(role 미상)"} 라운드 결속(${describeBinding(currentBinding)}) 일치 + 필수 후속효과(${requiredKeys.join(", ")}) 전부 성공 확인 -> 소비 완료로 판정, 허용`,
  };
}

// §2-B 게이트 축 어댑터: dispatch-gate-decision-core.mjs의 combineGateDecisions
// 가 받는 개별 decision 모양(통과면 null, 아니면 { state, allow:false,
// reason })으로 그대로 내놓는다. ⛔이 라운드는 이 함수를 실제
// combineGateDecisions 호출부에 결선하지 않는다(§3 금지, §6 정직 한계) --
// 2R이 부르기만 하면 되도록 계약만 지금 고정한다.
export function toConsumptionGateDecision(facts) {
  const verdict = checkConsumptionReceipt(facts);
  if (verdict.state === CONSUMPTION_RECEIPT_STATE.PASS) return null;
  return {
    state: verdict.state,
    allow: false,
    reason: verdict.reason,
  };
}
