import { markIntentRunning } from "./stable-intent.mjs";
import { acceptRunningReceipt } from "./running-receipt.mjs";
import { judgeAdmission } from "./admission-core.mjs";
import { validateGrant, isExpired } from "./arm-state.mjs";

// HYK-171 사이클3B (coder-task.md 한 줄 목표/§1/§4): 실 워커를 띄우는
// 지점을 단 하나의 side-effect seam으로 세운다. 이 파일은 엔진별 실행
// 어댑터를 import하지 않는다(S6 -- core는 raw vendor 값·엔진별 CLI를 전혀
// 모른다). `sink`는 호출자가 주입하는 함수일 뿐이고, 이 파일의 어떤
// 기본값도 실 sink를 가리키지 않는다(default armed=false와 함께 이
// 사이클의 비타협 경계: 실 process spawn 0건 · 실 원격 dispatch 0건).
//
// launch acceptance != worker completion(§1): 이 모듈이 새로 만드는 권위는
// "지금 워커를 띄우기로 수락했다"는 RUNNING receipt뿐이다. 완료 판정은
// scripts/check/relay-handshake.mjs가 정본이며, 이 파일은 그 함수를
// import조차 하지 않는다(재발명 금지, coder-task.md 비범위 ❌).

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

export const REASON = Object.freeze({
  // launch acceptance(§3) 실패 사유 -- armed 값과 무관하게 이 단계에서
  // 거부되면 sink는 절대 호출되지 않는다.
  ENVELOPE_MISSING_INTENT_ID: "LAUNCH_ENVELOPE_MISSING_INTENT_ID",
  RECEIPT_DIR_REQUIRED: "LAUNCH_RECEIPT_DIR_REQUIRED",
  INTENT_DIR_REQUIRED: "LAUNCH_INTENT_DIR_REQUIRED",
  INTENT_TRANSITION_DENIED: "LAUNCH_INTENT_TRANSITION_DENIED",
  ALREADY_RUNNING: "LAUNCH_ALREADY_RUNNING",
  RECEIPT_WRITE_FAILED: "LAUNCH_RECEIPT_WRITE_FAILED",
  // §4 fail-closed 6검(순서는 헤더 주석 하단 acceptLaunch 참고) -- sink
  // 직전 게이트. 각각 독립 guard clause라 하나씩 단독으로 지워도(=
  // mutation) 그 게이트의 REASON만 사라지고 sink 호출이 나타난다
  // (hyk171-cycle3b-mutation.test.mjs가 이 독립성을 하나씩 증명한다).
  ENVELOPE_INVALID: "SINK_ENVELOPE_INVALID",
  ENVELOPE_BINDING_MISMATCH: "SINK_ENVELOPE_BINDING_MISMATCH",
  ARM_INVALID: "SINK_ARM_INVALID",
  ARM_EXPIRED: "SINK_ARM_EXPIRED",
  ARM_GENERATION_MISMATCH: "SINK_ARM_GENERATION_MISMATCH",
  HUMAN_RECEIPT_MISSING: "SINK_HUMAN_RECEIPT_MISSING",
  ADMISSION_DENIED: "SINK_ADMISSION_DENIED",
  SINK_MISSING: "SINK_FUNCTION_MISSING",
  ACCEPTED_RUNNING: "LAUNCH_ACCEPTED_RUNNING",
  SINK_INVOKED: "SINK_INVOKED",
});

// ---- launch acceptance (armed 무관, §3: "수락 자체는 armed=false에서도
// 일어난다") ----
// 순서: ISSUED->RUNNING 전이(stable-intent.mjs 재사용)를 RUNNING receipt
// 쓰기보다 먼저 시도한다 -- updateIntentStatusTx의 expectedFrom=ISSUED
// 엄격 대조가 이미 "같은 stableIntentId에 대해 이 전이는 정확히 한 번만
// 성공한다"를 보장하므로(동시 supervisor/재시작 모두), 그 성공 위에만
// receipt를 쌓는다. 전이가 막히면(이미 RUNNING/PAUSED/CLAIMED든) receipt
// 시도 자체를 하지 않는다 -- crash 뒤 재시작에서 자동 재발사가 생길 수
// 있는 창을 만들지 않는다(§3 no-respawn, §6 mutation #5).
function recordLaunchAcceptance(inp, opts) {
  const { subGrantEnvelope, runningReceiptDir, intentDir, at } = inp;
  if (
    !isPlainObject(subGrantEnvelope) ||
    !isNonEmptyString(subGrantEnvelope.stable_intent_id)
  ) {
    return {
      ok: false,
      reason: REASON.ENVELOPE_MISSING_INTENT_ID,
    };
  }
  if (!isNonEmptyString(runningReceiptDir)) {
    return { ok: false, reason: REASON.RECEIPT_DIR_REQUIRED };
  }
  if (!isNonEmptyString(intentDir)) {
    return { ok: false, reason: REASON.INTENT_DIR_REQUIRED };
  }
  const stableIntentId = subGrantEnvelope.stable_intent_id;

  const transitioned = markIntentRunning(
    { intentDir, stableIntentId, at },
    opts,
  );
  if (!transitioned.ok) {
    return {
      ok: false,
      reason: REASON.INTENT_TRANSITION_DENIED,
      detail: transitioned.reason,
    };
  }

  const receipted = acceptRunningReceipt(
    { receiptDir: runningReceiptDir, stableIntentId, subGrantEnvelope, at },
    opts,
  );
  if (!receipted.ok) {
    return {
      ok: false,
      reason: receipted.alreadyRunning
        ? REASON.ALREADY_RUNNING
        : REASON.RECEIPT_WRITE_FAILED,
      detail: receipted.reason,
      receiptPath: receipted.path ?? null,
    };
  }

  return { ok: true, receiptPath: receipted.path };
}

// ---- §4 gate 2: subGrant envelope 재검(존재·schema·결속) ----
function checkSubGrantBinding(inp) {
  const env = inp.subGrantEnvelope;
  const rb = isPlainObject(inp.requiredBindings) ? inp.requiredBindings : {};
  if (
    !isPlainObject(env) ||
    !isNonEmptyString(env.stable_intent_id) ||
    !isNonEmptyString(env.task_hash) ||
    !isNonEmptyString(env.role)
  ) {
    return {
      reason: REASON.ENVELOPE_INVALID,
      detail:
        "subGrantEnvelope must be a plain object with non-empty stable_intent_id/task_hash/role",
    };
  }
  if (
    !isNonEmptyString(rb.taskHash) ||
    !isNonEmptyString(rb.role) ||
    env.task_hash !== rb.taskHash ||
    env.role !== rb.role
  ) {
    return {
      reason: REASON.ENVELOPE_BINDING_MISMATCH,
      detail: `subGrantEnvelope.task_hash/role (${env.task_hash}/${env.role}) does not match requiredBindings (${rb.taskHash}/${rb.role})`,
    };
  }
  return null;
}

// ---- §4 gate 3: arm/cycle/expiry 유효(만료·세대 대조) ----
// arm-state.mjs의 validateGrant/isExpired를 그대로 재사용(재구현 금지) --
// armGrant는 arm-state.mjs의 grant shape 그대로다.
function checkArmCycleExpiry(inp) {
  const armGrant = inp.armGrant;
  const problems = validateGrant(armGrant);
  if (problems.length > 0) {
    return {
      reason: REASON.ARM_INVALID,
      detail: `armGrant invalid -- ${problems.join("; ")}`,
    };
  }
  const nowMs = Number.isSafeInteger(inp.nowMs) ? inp.nowMs : Date.now();
  if (isExpired(armGrant, nowMs)) {
    return {
      reason: REASON.ARM_EXPIRED,
      detail: `armGrant expires_at=${armGrant.expires_at}, now=${nowMs}`,
    };
  }
  if (
    !isNonEmptyString(inp.expectedCycleId) ||
    armGrant.cycle_id !== inp.expectedCycleId
  ) {
    return {
      reason: REASON.ARM_GENERATION_MISMATCH,
      detail: `armGrant.cycle_id=${JSON.stringify(armGrant.cycle_id)} != expectedCycleId=${JSON.stringify(inp.expectedCycleId)}`,
    };
  }
  return null;
}

// ---- §4 gate 4: 사람 receipt 존재(armed을 정당화하는 사람 근거) ----
// production/default 호출자는 절대 이 필드를 채우지 않는다 -- 오직 합성
// 테스트 fixture만 넘긴다(coder-task.md §4 명시). non-empty string 또는
// plain-object marker 둘 다 인정한다.
function checkHumanReceipt(inp) {
  const hr = inp.humanReceipt;
  const present = isNonEmptyString(hr) || isPlainObject(hr);
  if (!present) {
    return {
      reason: REASON.HUMAN_RECEIPT_MISSING,
      detail:
        "humanReceipt must be a non-empty string or a plain-object marker -- armed=true alone never justifies a sink call",
    };
  }
  return null;
}

// ---- §4 gate 5: 2차 admission 재판정 (grant-issuer.mjs와 동일 shape) ----
function checkSecondAdmission(inp, opts) {
  const judged = judgeAdmission(
    { pullAdmission: inp.pullAdmission, gates: inp.gates },
    opts,
  );
  if (!judged.ok) {
    return {
      reason: REASON.ADMISSION_DENIED,
      detail: {
        admission_reason: judged.reason,
        admission_detail: judged.detail,
      },
    };
  }
  return null;
}

// acceptLaunch({ subGrantEnvelope, armed, sink, runningReceiptDir, intentDir,
//   requiredBindings: {taskHash, role}, armGrant, expectedCycleId, nowMs,
//   humanReceipt, pullAdmission, gates, at }, opts)
//
// armed 강제(비타협, §4): 오직 `=== true`만 armed다 -- truthy 관용 0(문자열
// "true"/1/{} 전부 false로 강제). default(인자 미제공)도 false.
//
// 순서(비타협은 아니지만 의도적, admission-core.mjs의 "값싼 검사 먼저"
// 원칙 계승): recordLaunchAcceptance(RUNNING 유일성 -- §4 gate 6에 해당)를
// armed 분기보다 먼저 평가한다 -- 이 유일성 검사와 ISSUED->RUNNING 전이는
// armed 값과 무관하게 항상 필요하므로(§3), 먼저 처리해 armed=false의 압도
// 다수 호출에서 불필요한 gate 2~5 평가를 하지 않는다. gate 2~5는 armed=true
// 일 때만 순서대로 체이닝한다(§4 문서 순서 그대로) -- 각각 독립 guard
// clause라 하나를 지워도 나머지는 그대로 작동한다(&&로 접지 않음, 태스크
// 지시).
export function acceptLaunch(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  const armed = inp.armed === true;

  const accepted = recordLaunchAcceptance(inp, opts);
  if (!accepted.ok) {
    return {
      ok: false,
      launched: false,
      running: false,
      armed,
      reason: accepted.reason,
      detail: accepted.detail ?? null,
      receiptPath: accepted.receiptPath ?? null,
    };
  }

  if (!armed) {
    return {
      ok: true,
      launched: false,
      running: true,
      armed: false,
      reason: REASON.ACCEPTED_RUNNING,
      receiptPath: accepted.receiptPath,
    };
  }

  const gateDenied =
    checkSubGrantBinding(inp) ??
    checkArmCycleExpiry(inp) ??
    checkHumanReceipt(inp) ??
    checkSecondAdmission(inp, opts);
  if (gateDenied) {
    return {
      ok: false,
      launched: false,
      running: true,
      armed: true,
      reason: gateDenied.reason,
      detail: gateDenied.detail ?? null,
      receiptPath: accepted.receiptPath,
    };
  }

  if (typeof inp.sink !== "function") {
    return {
      ok: false,
      launched: false,
      running: true,
      armed: true,
      reason: REASON.SINK_MISSING,
      receiptPath: accepted.receiptPath,
    };
  }

  // 6검 전부 통과 -- 정확히 1회 호출. sink의 반환값은 이 함수의 계약이
  // 아니다(호출자가 자신의 spy/실 어댑터에서 원하는 대로 정의).
  inp.sink({
    subGrantEnvelope: inp.subGrantEnvelope,
    stableIntentId: inp.subGrantEnvelope.stable_intent_id,
    at: inp.at,
  });

  return {
    ok: true,
    launched: true,
    running: true,
    armed: true,
    reason: REASON.SINK_INVOKED,
    receiptPath: accepted.receiptPath,
  };
}
