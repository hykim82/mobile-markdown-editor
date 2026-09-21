import { createHash } from "node:crypto";
import { canonicalStringify } from "./auth-grant-canonical.mjs";

// HYK-165 사이클 1 (P10): `authorization-<arm_id>.json` -- 불변·create-new-only
// manifest의 구조 검증·canonical 해시. 보고서-pm1.md §3.2 표 그대로:
// resolved task path·task header id/hash·lane·cwd/worktree·worker config/
// launch profile hash·person approval ref·publish/retry=false·question/
// error=pause.
//
// 이 manifest 자체는 Ed25519로 직접 서명되지 않는다 -- signed-grant의
// `authorization_sha256` 필드가 이 manifest의 canonical 해시를 서명 대상에
// 결속한다(auth-grant-canonical.mjs의 기존 authorization_sha256 필드 재사용,
// pull-grant-canonical.mjs가 그대로 승계). 즉 이 파일이 한 글자라도 바뀌면
// 해시가 바뀌고, grant의 authorization_sha256과 더 이상 일치하지 않아
// pull-admission.mjs가 AUTHORIZATION_HASH_MISMATCH로 deny한다 -- "authorization
// 불변 필드 불일치면 claim 0"의 실제 메커니즘.
//
// HYK-165 사이클2 REVIEW-A 반려 수리(coder-3): §3.2 표의 "worker config/
// launch profile hash"는 **서로 다른 두 해시**다 -- `launch_profile_sha256`
// (어느 worker 실행 프로필로 기동할지)과 `worker_config_sha256`(worker CLI가
// 실제로 읽을 config 파일 내용)은 별개 결속 대상인데, 사이클1/2 구현은
// launch_profile_sha256만 있고 config는 빠져 있었다(REVIEW-A rejected 근거).
// worker_config_sha256을 canonical schema에 추가해 authorization 해시에
// 결속하고(위 메커니즘 그대로), pull-admission.mjs의 expected 대조 목록에도
// 추가한다 -- "config를 바꿔치기해도 admission이 못 잡는다"는 구멍을 닫는다.

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isSafeCount(v) {
  return Number.isSafeInteger(v) && v >= 0;
}
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

export const AUTHORIZATION_FIELD_NAMES = Object.freeze([
  "schema_version",
  "arm_id",
  "cycle_id",
  "task_id",
  "resolved_task_path",
  "task_header_id",
  "task_header_sha256",
  "lane",
  "cwd",
  "worktree",
  "launch_profile_sha256",
  "worker_config_sha256",
  "person_approval_ref",
  "publish_allowed",
  "retry_allowed",
  "on_question",
  "on_error",
]);

function collectIdentityProblems(fields) {
  const problems = [];
  if (!isSafeCount(fields.schema_version) || fields.schema_version < 1) {
    problems.push("'schema_version' must be a positive safe integer");
  }
  for (const f of ["arm_id", "cycle_id", "task_id"]) {
    if (!isNonEmptyString(fields[f])) {
      problems.push(`'${f}' must be a non-empty string`);
    }
  }
  return problems;
}

function collectTaskBindingProblems(fields) {
  const problems = [];
  if (!isNonEmptyString(fields.resolved_task_path)) {
    problems.push("'resolved_task_path' must be a non-empty string");
  }
  if (!isNonEmptyString(fields.task_header_id)) {
    problems.push("'task_header_id' must be a non-empty string");
  }
  if (
    !isNonEmptyString(fields.task_header_sha256) ||
    !SHA256_HEX_RE.test(fields.task_header_sha256)
  ) {
    problems.push("'task_header_sha256' must be a 64-hex-char sha256 string");
  }
  return problems;
}

function collectLaunchProblems(fields) {
  const problems = [];
  for (const f of ["lane", "cwd", "worktree"]) {
    if (!isNonEmptyString(fields[f])) {
      problems.push(`'${f}' must be a non-empty string`);
    }
  }
  if (
    !isNonEmptyString(fields.launch_profile_sha256) ||
    !SHA256_HEX_RE.test(fields.launch_profile_sha256)
  ) {
    problems.push(
      "'launch_profile_sha256' must be a 64-hex-char sha256 string",
    );
  }
  if (
    !isNonEmptyString(fields.worker_config_sha256) ||
    !SHA256_HEX_RE.test(fields.worker_config_sha256)
  ) {
    problems.push("'worker_config_sha256' must be a 64-hex-char sha256 string");
  }
  if (!isNonEmptyString(fields.person_approval_ref)) {
    problems.push("'person_approval_ref' must be a non-empty string");
  }
  return problems;
}

// 불변경계 고정값(패킷 §4/보고서 §3.2): 이번 채널은 publish/retry를 절대
// 허용하지 않고, question/error은 항상 사람 대기(pause)다. "false에 가까운
// 값"(0, "", null)이 아니라 정확히 boolean false·문자열 "pause"만 통과시켜
// 이 불변경계가 값의 느슨한 강제변환으로 새지 않게 한다.
function collectPolicyProblems(fields) {
  const problems = [];
  if (fields.publish_allowed !== false) {
    problems.push("'publish_allowed' must be exactly boolean false");
  }
  if (fields.retry_allowed !== false) {
    problems.push("'retry_allowed' must be exactly boolean false");
  }
  if (fields.on_question !== "pause") {
    problems.push("'on_question' must be exactly 'pause'");
  }
  if (fields.on_error !== "pause") {
    problems.push("'on_error' must be exactly 'pause'");
  }
  return problems;
}

function collectAuthorizationProblems(fields) {
  return [
    ...collectIdentityProblems(fields),
    ...collectTaskBindingProblems(fields),
    ...collectLaunchProblems(fields),
    ...collectPolicyProblems(fields),
  ];
}

function buildCanonicalFields(fields) {
  return {
    schema_version: fields.schema_version,
    arm_id: fields.arm_id,
    cycle_id: fields.cycle_id,
    task_id: fields.task_id,
    resolved_task_path: fields.resolved_task_path,
    task_header_id: fields.task_header_id,
    task_header_sha256: fields.task_header_sha256.toLowerCase(),
    lane: fields.lane,
    cwd: fields.cwd,
    worktree: fields.worktree,
    launch_profile_sha256: fields.launch_profile_sha256.toLowerCase(),
    worker_config_sha256: fields.worker_config_sha256.toLowerCase(),
    person_approval_ref: fields.person_approval_ref,
    publish_allowed: fields.publish_allowed,
    retry_allowed: fields.retry_allowed,
    on_question: fields.on_question,
    on_error: fields.on_error,
  };
}

// fields -> { ok, reason? } | { ok:true, fields, canonicalJson, sha256 }
export function canonicalizeAuthorization(fields) {
  if (!isPlainObject(fields)) {
    return {
      ok: false,
      reason: "pull-authorization: fields is not a plain object",
    };
  }
  const problems = collectAuthorizationProblems(fields);
  if (problems.length > 0) {
    return {
      ok: false,
      reason: `pull-authorization: ${problems.join("; ")}`,
    };
  }
  const canonicalFields = buildCanonicalFields(fields);
  const canonicalJson = canonicalStringify(canonicalFields);
  const sha256 = createHash("sha256")
    .update(canonicalJson, "utf8")
    .digest("hex");
  return { ok: true, fields: canonicalFields, canonicalJson, sha256 };
}
