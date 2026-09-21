import { judgePullAdmission } from "./pull-admission.mjs";

// HYK-171 사이클3A (PM 보고서 §3): admission 6게이트 → ALLOW/DENY 순수
// 판정. 자연어 해석 0 -- 전부 boolean/문자열 flag를 기계적으로 대조한다.
//
// 재사용(재구현 금지, coder-task.md 지침): pull-admission.mjs의
// `judgePullAdmission`(서명/pin/freshness/context 검증)을 서브체크로 그대로
// 호출한다. 이 파일은 그 위에 "언제 이 후보가 애당초 grant 발급 자격이
// 있는가"를 얹는다 -- 서명이 유효해도(judgePullAdmission이 ALLOW해도) 아래
// 게이트 중 하나라도 막히면 이 판정 전체는 DENY다.
//
// auth-grant-gate.mjs/pull-admission.mjs와 동일한 구조 계승: distinct
// REASON 상수 + `checkA(...) ?? checkB(...) ?? ...` 체이닝 + deny() 헬퍼 +
// ALLOW는 전 조건 통과 시에만.
//
// §3 매핑(원문 표):
//   허용(무인 후보 ALLOWED) -- 같은 이슈 첫 재작업 · 승인 범위/예산 안 ·
//     hard-stop/위험실행 없음. 이건 "기존 서명 재사용"이 아니라 사람이
//     서명한 bounded delegation을 원자적으로 1회 소비하는 것 -- 그 소비
//     자체는 이 파일이 하지 않는다(grant-issuer.mjs 몫). 이 파일은 "지금
//     이 후보가 그 소비를 시도해도 되는 자격이 있는가"만 판정한다.
//   거부(발급·dispatch 0, 사람 정지) -- 새 이슈 경계 / 2연속 반려 /
//     북극성 승인 없음(receipt 없음) / 패킷 범위 변경 / hard-stop ·
//     권한 불명 · store 손상.
//   PR 승인/병합 또는 Linear Done -- 이 판정이 대신하지 않는 별도
//     downstream 사람 게이트다. 이 모듈이 ALLOW를 반환해도 그 사람 게이트를
//     통과했다는 뜻이 아니다(우회 주장 금지 -- 정직 한계로 문서화만 한다).

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isSafeCount(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

export const REASON = Object.freeze({
  MALFORMED_INPUT: "MALFORMED_INPUT",
  STORE_CORRUPT: "STORE_CORRUPT",
  UNKNOWN_AUTHORITY: "UNKNOWN_AUTHORITY",
  HARD_STOP: "HARD_STOP",
  DANGEROUS_EXECUTION: "DANGEROUS_EXECUTION",
  NEW_ISSUE_BOUNDARY: "NEW_ISSUE_BOUNDARY",
  REJECT_STREAK: "REJECT_STREAK",
  NO_NORTH_STAR_APPROVAL: "NO_NORTH_STAR_APPROVAL",
  PACKET_SCOPE_CHANGED: "PACKET_SCOPE_CHANGED",
  NOT_FIRST_REWORK: "NOT_FIRST_REWORK",
  OUT_OF_SCOPE_BUDGET: "OUT_OF_SCOPE_BUDGET",
  PULL_ADMISSION_DENIED: "PULL_ADMISSION_DENIED",
  ALLOW: "ALLOW",
});

function deny(reason, detail) {
  return { ok: false, reason, detail: detail ?? null };
}

// fail-closed 기본값: gates가 plain object가 아니거나 필드가 비어 있으면
// 전부 "허용 아님" 쪽으로 기운다(허용 플래그는 명시적 true만 통과, 거부
// 플래그는 명시적 true만 거부 -- 그 외 누락/오형식은 REASON.MALFORMED_INPUT
// 이나 자격 미달 쪽으로 fail-closed).
function normalizeGates(gates) {
  return isPlainObject(gates) ? gates : {};
}

function checkStoreCorrupt(gates) {
  if (gates.storeCorrupt === true) {
    return deny(REASON.STORE_CORRUPT, "store corruption flag is set");
  }
  return null;
}

function checkUnknownAuthority(gates) {
  if (gates.authorityKnown !== true) {
    return deny(
      REASON.UNKNOWN_AUTHORITY,
      "authorityKnown must be explicitly true -- unknown/unverified authority fails closed",
    );
  }
  return null;
}

function checkHardStop(gates) {
  if (gates.hardStop === true) {
    return deny(REASON.HARD_STOP, "hard-stop flag is set");
  }
  return null;
}

function checkDangerousExecution(gates) {
  if (gates.dangerousExecution === true) {
    return deny(REASON.DANGEROUS_EXECUTION, "dangerous-execution flag is set");
  }
  return null;
}

function checkNewIssueBoundary(gates) {
  if (gates.newIssueBoundary === true) {
    return deny(
      REASON.NEW_ISSUE_BOUNDARY,
      "candidate crosses into a new issue boundary -- requires a human, not unattended admission",
    );
  }
  return null;
}

// P1-2 (review-1 반려): consecutiveRejections는 명시적 non-negative safe
// integer여야 한다 -- 문자열("2")·음수·누락은 "2 미만이니 통과"가 아니라
// fail-closed MALFORMED_INPUT이다(그 값 자체를 신뢰할 수 없다는 뜻이지,
// "반려 0회"라는 뜻이 아니다).
function checkRejectStreak(gates) {
  if (!isSafeCount(gates.consecutiveRejections)) {
    return deny(
      REASON.MALFORMED_INPUT,
      `gates.consecutiveRejections must be a non-negative safe integer, got ${JSON.stringify(gates.consecutiveRejections)}`,
    );
  }
  if (gates.consecutiveRejections >= 2) {
    return deny(
      REASON.REJECT_STREAK,
      `consecutiveRejections=${gates.consecutiveRejections} >= 2`,
    );
  }
  return null;
}

function checkNorthStar(gates) {
  if (!isNonEmptyString(gates.northStarApprovalReceipt)) {
    return deny(
      REASON.NO_NORTH_STAR_APPROVAL,
      "northStarApprovalReceipt is missing/empty -- no receipt means no approval",
    );
  }
  return null;
}

function checkPacketScope(gates) {
  if (gates.packetScopeChanged === true) {
    return deny(
      REASON.PACKET_SCOPE_CHANGED,
      "packet scope changed since the human-approved baseline",
    );
  }
  return null;
}

function checkFirstRework(gates) {
  if (gates.sameIssueFirstRework !== true) {
    return deny(
      REASON.NOT_FIRST_REWORK,
      "sameIssueFirstRework must be explicitly true -- unmanned eligibility is limited to the first rework on the same issue",
    );
  }
  return null;
}

function checkScopeBudget(gates) {
  if (gates.withinApprovedScopeBudget !== true) {
    return deny(
      REASON.OUT_OF_SCOPE_BUDGET,
      "withinApprovedScopeBudget must be explicitly true",
    );
  }
  return null;
}

// 거부(정지) 게이트 6종을 한 곳에서 체이닝 -- §3 표의 "거부" 행 그대로.
function checkDenyGates(gates) {
  return (
    checkStoreCorrupt(gates) ??
    checkUnknownAuthority(gates) ??
    checkHardStop(gates) ??
    checkDangerousExecution(gates) ??
    checkNewIssueBoundary(gates) ??
    checkRejectStreak(gates) ??
    checkNorthStar(gates) ??
    checkPacketScope(gates)
  );
}

// 자격(무인 후보 ALLOWED 조건) 게이트 -- §3 표의 "허용" 행. 이 두 조건이
// 명시적으로 참이어야만 아래로 내려간다("첫 재작업"·"승인 범위/예산 안"은
// 누락 시 기본 거부).
function checkEligibilityGates(gates) {
  return checkFirstRework(gates) ?? checkScopeBudget(gates);
}

// judgeAdmission({ pullAdmission: {...judgePullAdmission input}, gates: {...} }, opts)
// opts는 judgePullAdmission으로 그대로 전달(readFileFn/pinDeps 주입 -- 테스트용).
// 반환: { ok, reason, detail } -- ok===true일 때만 reason===REASON.ALLOW.
//
// 순서(의도적): 이 모듈의 자체 게이트(거부 6종 + 자격 2종)를 먼저 보고,
// 그 다음에야 judgePullAdmission(서명/pin/freshness/context)을 부른다 --
// 서명 계산·pin 파일 읽기 같은 비싼 I/O를 hard-stop/새 이슈 경계 같은 값싼
// boolean 체크보다 먼저 하지 않는다(judgePullAdmission 자체의 판정 결과는
// 바뀌지 않는다 -- 순서는 순수 최적화이지 판정 완화가 아니다).
export function judgeAdmission(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  if (!isPlainObject(inp.pullAdmission)) {
    return deny(
      REASON.MALFORMED_INPUT,
      "input.pullAdmission must be a plain object (judgePullAdmission input)",
    );
  }
  const gates = normalizeGates(inp.gates);

  const denied = checkDenyGates(gates) ?? checkEligibilityGates(gates);
  if (denied) return denied;

  const pullResult = judgePullAdmission(inp.pullAdmission, opts);
  if (!pullResult.ok) {
    return deny(REASON.PULL_ADMISSION_DENIED, {
      pull_admission_reason: pullResult.reason,
      pull_admission_detail: pullResult.detail,
    });
  }

  return {
    ok: true,
    reason: REASON.ALLOW,
    detail: null,
    pullAdmission: pullResult,
  };
}
