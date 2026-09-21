import { readFileSync } from "node:fs";
import {
  loadStore,
  armStorePath,
  isExpired,
  hashContent,
} from "./arm-state.mjs";
import { checkPacketGate } from "../check/packet-gate.mjs";
import { extractTaskId } from "../check/worker-status-onstart.mjs";

// HYK-162 사이클 1 (C 절충 스파이크, PKT-20260719-HYK162-ORCA-HYBRID-SPIKE): Orca
// task/dispatch/check는 운반 몸통일 뿐이고, 시작 자격은 arm-state(서명 참조·만료·예산) +
// 서명된 패킷(packet-gate)에서만 나온다 -- 이 파일은 그 "시작 자격" 판정과 spec 계약을
// 코드+테스트로 동결한다. Orca runtime 호출은 이 사이클에서 전면 금지(사이클 2 몫, S7
// REVIEW 선행) -- 이 파일 어디에도 `orca` CLI/runtime 호출이 없다(문서 주석 제외).
//
// honesty (패킷 §7 인용): "이 계약이 Orca CLI 직접 호출을 실역 밖에서 기계 차단한다는
// 주장은 아니다" -- 이 판정기는 "Orca 주입 *전* 하네스 쪽 관문"이며, dispatch --inject의
// 실제 prompt가 이 판정을 실제로 거치는지, runtime이 이 판정을 우회해 직접 호출됐는지는
// 이 모듈의 관찰 범위 밖이다(사이클 2 REVIEW 몫).
//
// S6 선언: 기반=B(런처/supervisor 층 Node 스크립트, 엔진 무관 -- Claude 훅 아님). 이
// 모듈은 어떤 AI 엔진에서도(claude/codex/기타) 동일한 pure 판정으로 호출 가능하다.

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function errText(err) {
  try {
    if (err && typeof err === "object") {
      const m = err.message;
      if (typeof m === "string") return m;
    }
    return String(err);
  } catch {
    return "unknown error (message accessor threw)";
  }
}

// ---- 판정 reason 상수 (고정, deny 경로마다 구분된 값 -- G1/G3/G4 계약) ----
export const REASON = Object.freeze({
  PACKET_UNSIGNED: "PACKET_UNSIGNED",
  APPROVAL_REF_MISMATCH: "APPROVAL_REF_MISMATCH",
  ARM_ID_MISMATCH: "ARM_ID_MISMATCH",
  CYCLE_ID_MISMATCH: "CYCLE_ID_MISMATCH",
  TASK_ID_MISMATCH: "TASK_ID_MISMATCH",
  EXPIRED: "EXPIRED",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  CONTENT_HASH_MISMATCH: "CONTENT_HASH_MISMATCH",
  TARGET_UNSPECIFIED: "TARGET_UNSPECIFIED",
  TARGET_MISMATCH: "TARGET_MISMATCH",
  ROLE_UNDETERMINED: "ROLE_UNDETERMINED",
  STORE_UNAVAILABLE: "STORE_UNAVAILABLE",
  ALLOW: "ALLOW",
});

function deny(reason, detail) {
  return { ok: false, allow: false, reason, detail: detail ?? null };
}

// ---- pre-dispatch 자격 판정기 (전부 fail-closed) ----
// input: {
//   armDir, arm_id            -- 대상 arm store 위치(기존 arm-state 전용 파일 재사용)
//   packetPath                -- 서명된 위임 패킷 경로(packet-gate 재사용)
//   request: {
//     human_approval_ref, cycle_id, task_id, content_hash, target, role
//   }
//   expected: { target, role } -- 고정 구성값(문자열 결속만, 실 Orca 조회 금지)
//   nowMs                      -- 만료 판정 시각(테스트 결정성)
// }
function loadArmStoreForPreDispatch(inp, opts) {
  if (!isNonEmptyString(inp.armDir) || !isNonEmptyString(inp.arm_id)) {
    return deny(
      REASON.STORE_UNAVAILABLE,
      "orca-predispatch: armDir/arm_id must be non-empty strings",
    );
  }
  const storePath = armStorePath(inp.armDir, inp.arm_id);
  let loaded;
  try {
    loaded = loadStore(storePath, opts);
  } catch (err) {
    return deny(
      REASON.STORE_UNAVAILABLE,
      `orca-predispatch: loadStore threw (${errText(err)})`,
    );
  }
  if (!loaded.ok) return deny(REASON.STORE_UNAVAILABLE, loaded.reason);
  if (!loaded.existed || !isPlainObject(loaded.store)) {
    return deny(
      REASON.STORE_UNAVAILABLE,
      `orca-predispatch: no arm store at '${storePath}'`,
    );
  }
  const grant = isPlainObject(loaded.store.grant) ? loaded.store.grant : null;
  if (!grant) {
    return deny(
      REASON.STORE_UNAVAILABLE,
      "orca-predispatch: arm store has no grant",
    );
  }
  return { ok: true, store: loaded.store, grant };
}

// G1-b: 자격 4필드(human_approval_ref·arm_id·cycle_id·task_id) 각각 구분된 reason.
function checkQualificationFields(req, inp, grant) {
  if (
    !isNonEmptyString(req.human_approval_ref) ||
    req.human_approval_ref !== grant.human_approval_ref
  ) {
    return deny(
      REASON.APPROVAL_REF_MISMATCH,
      `orca-predispatch: request human_approval_ref ${JSON.stringify(req.human_approval_ref)} != grant ${JSON.stringify(grant.human_approval_ref)}`,
    );
  }
  if (
    !isNonEmptyString(req.arm_id) ||
    req.arm_id !== inp.arm_id ||
    req.arm_id !== grant.arm_id
  ) {
    return deny(
      REASON.ARM_ID_MISMATCH,
      `orca-predispatch: request arm_id ${JSON.stringify(req.arm_id)} does not match target arm '${inp.arm_id}' / grant arm_id ${JSON.stringify(grant.arm_id)}`,
    );
  }
  if (!isNonEmptyString(req.cycle_id) || req.cycle_id !== grant.cycle_id) {
    return deny(
      REASON.CYCLE_ID_MISMATCH,
      `orca-predispatch: request cycle_id ${JSON.stringify(req.cycle_id)} != grant ${JSON.stringify(grant.cycle_id)}`,
    );
  }
  const allowedTaskIds = Array.isArray(grant.allowed_task_ids)
    ? grant.allowed_task_ids
    : [];
  if (!isNonEmptyString(req.task_id) || !allowedTaskIds.includes(req.task_id)) {
    return deny(
      REASON.TASK_ID_MISMATCH,
      `orca-predispatch: request task_id ${JSON.stringify(req.task_id)} not in grant.allowed_task_ids`,
    );
  }
  return null;
}

// 만료(기존 isExpired 재사용) + 예산(claim 판정과 동일한 부등호 -- arm-state 재구현 금지, 판독만).
function checkExpiryAndBudget(store, grant, nowMs) {
  if (isExpired(grant, nowMs)) {
    return deny(
      REASON.EXPIRED,
      `orca-predispatch: grant expired_at=${grant.expires_at} now=${nowMs}`,
    );
  }
  const attemptsTotal = Number.isSafeInteger(store.attempts_total)
    ? store.attempts_total
    : Number.POSITIVE_INFINITY;
  const maxStartsTotal = Number.isSafeInteger(grant.max_starts_total)
    ? grant.max_starts_total
    : 0;
  if (attemptsTotal >= maxStartsTotal) {
    return deny(
      REASON.BUDGET_EXHAUSTED,
      `orca-predispatch: attempts_total=${attemptsTotal} >= max_starts_total=${maxStartsTotal}`,
    );
  }
  return null;
}

// G3: task 내용 해시 결속 -- request.content_hash가 task 파일 실제 내용과 일치해야 한다.
function checkContentHash(req, taskFilePath, opts) {
  if (!isNonEmptyString(taskFilePath)) {
    if (!isNonEmptyString(req.content_hash)) {
      return deny(
        REASON.CONTENT_HASH_MISMATCH,
        "orca-predispatch: request.content_hash is required (no taskFilePath given to derive it)",
      );
    }
    return null;
  }
  const specCheck = verifySpec(`go ${req.task_id}`, taskFilePath, opts);
  if (!specCheck.ok) {
    return deny(REASON.TASK_ID_MISMATCH, specCheck.reason);
  }
  if (
    !isNonEmptyString(req.content_hash) ||
    req.content_hash !== specCheck.content_hash
  ) {
    return deny(
      REASON.CONTENT_HASH_MISMATCH,
      `orca-predispatch: request content_hash ${JSON.stringify(req.content_hash)} != computed ${specCheck.content_hash}`,
    );
  }
  return null;
}

// G4: 대상 terminal 고정(문자열 결속만 -- 실 Orca 조회 금지).
function checkTarget(req, exp) {
  if (!isNonEmptyString(exp.target)) {
    return deny(
      REASON.TARGET_UNSPECIFIED,
      "orca-predispatch: expected.target is not configured",
    );
  }
  if (!isNonEmptyString(req.target) || req.target !== exp.target) {
    return deny(
      REASON.TARGET_MISMATCH,
      `orca-predispatch: request target ${JSON.stringify(req.target)} != expected ${JSON.stringify(exp.target)}`,
    );
  }
  return null;
}

function checkRole(req, exp) {
  if (
    !isNonEmptyString(exp.role) ||
    !isNonEmptyString(req.role) ||
    req.role !== exp.role
  ) {
    return deny(
      REASON.ROLE_UNDETERMINED,
      `orca-predispatch: request role ${JSON.stringify(req.role)} does not match expected ${JSON.stringify(exp.role)}`,
    );
  }
  return null;
}

export function checkPreDispatch(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  const req = isPlainObject(inp.request) ? inp.request : {};
  const exp = isPlainObject(inp.expected) ? inp.expected : {};

  // G1-a: 패킷 서명 여부(packet-gate 재사용, 재구현 금지).
  const packetResult = checkPacketGate({ packetPath: inp.packetPath });
  if (!packetResult.ok) {
    return deny(REASON.PACKET_UNSIGNED, packetResult.reason);
  }

  const loaded = loadArmStoreForPreDispatch(inp, opts);
  if (!loaded.ok) return loaded;
  const { store, grant } = loaded;

  const nowMs = Number.isSafeInteger(inp.nowMs) ? inp.nowMs : Date.now();

  const denied =
    checkQualificationFields(req, inp, grant) ??
    checkExpiryAndBudget(store, grant, nowMs) ??
    checkContentHash(req, inp.taskFilePath, opts) ??
    checkTarget(req, exp) ??
    checkRole(req, exp);
  if (denied) return denied;

  return { ok: true, allow: true, reason: REASON.ALLOW, detail: null };
}

// ---- spec 계약: buildSpec/verifySpec (G3/G5 사이클 2 준비) ----
// 정확히 `go <task_id>` 한 줄(트레일링 공백·개행 0).
export function buildSpec(task_id) {
  if (!isNonEmptyString(task_id) || /\s/.test(task_id)) {
    return {
      ok: false,
      reason:
        "orca-predispatch: buildSpec refused -- task_id must be a non-empty string with no whitespace",
    };
  }
  return { ok: true, spec: `go ${task_id}` };
}

const SPEC_LINE_RE = /^go (\S+)$/;

// 형식만: 정확히 한 줄 `go <task_id>`(트레일링 공백·개행 0). taskFilePath는 손대지 않는다.
function checkSpecFormat(spec) {
  if (typeof spec !== "string") {
    return {
      ok: false,
      reason: "orca-predispatch: SPEC_FORMAT_INVALID -- spec must be a string",
    };
  }
  if (spec !== spec.trim() || spec.includes("\n")) {
    return {
      ok: false,
      reason: `orca-predispatch: SPEC_FORMAT_INVALID -- spec has leading/trailing whitespace or multiple lines: ${JSON.stringify(spec)}`,
    };
  }
  const m = spec.match(SPEC_LINE_RE);
  if (!m) {
    return {
      ok: false,
      reason: `orca-predispatch: SPEC_FORMAT_INVALID -- spec is not exactly 'go <task_id>': ${JSON.stringify(spec)}`,
    };
  }
  return { ok: true, specTaskId: m[1] };
}

// spec 형식 + task 파일 top task_id 일치 + (옵션) 내용 해시 스냅샷 일치.
// 기존 go-task-id-gate.mjs의 checkGoTaskId와 계약 일치(불일치 발견 시 이 판정기
// 호출부가 question_packet으로 정지 -- 여기서는 재구현하지 않고 동일 extractTaskId를 재사용).
export function verifySpec(spec, taskFilePath, opts) {
  const o = isPlainObject(opts) ? opts : {};
  const readFileFn =
    typeof o.readFileFn === "function"
      ? o.readFileFn
      : (p) => readFileSync(p, "utf8");

  const formatCheck = checkSpecFormat(spec);
  if (!formatCheck.ok) return formatCheck;
  const specTaskId = formatCheck.specTaskId;

  if (!isNonEmptyString(taskFilePath)) {
    return {
      ok: false,
      reason:
        "orca-predispatch: SPEC_FORMAT_INVALID -- taskFilePath is required",
    };
  }
  let content;
  try {
    content = readFileFn(taskFilePath);
  } catch (err) {
    return {
      ok: false,
      reason: `orca-predispatch: SPEC_TASK_ID_MISMATCH -- cannot read task file '${taskFilePath}' (${errText(err)})`,
    };
  }
  const fileTaskId = extractTaskId(content);
  if (!fileTaskId) {
    return {
      ok: false,
      reason: `orca-predispatch: SPEC_TASK_ID_MISMATCH -- task file '${taskFilePath}' has no task_id header`,
    };
  }
  if (fileTaskId !== specTaskId) {
    return {
      ok: false,
      reason: `orca-predispatch: SPEC_TASK_ID_MISMATCH -- spec task_id '${specTaskId}' != task file task_id '${fileTaskId}'`,
    };
  }

  const content_hash = hashContent(content);
  if (
    isNonEmptyString(o.expectedContentHash) &&
    o.expectedContentHash !== content_hash
  ) {
    return {
      ok: false,
      reason: `orca-predispatch: SPEC_CONTENT_HASH_MISMATCH -- expected ${o.expectedContentHash} != computed ${content_hash}`,
    };
  }
  return { ok: true, task_id: specTaskId, content_hash };
}

// ---- CLI (Orca 호출 없음 -- 판정 결과 출력만) ----
const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/orca-predispatch.mjs");
if (invokedDirectly) {
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(
      `orca-predispatch: stdin is not valid JSON (${errText(err)})`,
    );
    process.exit(1);
  }
  const result = checkPreDispatch(payload);
  console.log(JSON.stringify(result));
  process.exit(result.allow ? 0 : 1);
}
