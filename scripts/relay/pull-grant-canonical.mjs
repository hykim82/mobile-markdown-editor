import { canonicalStringify } from "./auth-grant-canonical.mjs";

// HYK-165 사이클 1 (P1): `harness-signed-pull-v1` 채널 전용 signed grant
// canonical v2 -- HYK-163 G2(auth-grant-canonical.mjs)를 재구현하지 않고 그
// canonicalStringify(결정적 stable-key JSON)만 재사용해, pull 채널이 새로
// 요구하는 두 결속을 더한 상위 스킴을 만든다(보고서-pm1.md §1.3 공백 2건):
//   (ㄱ) `issued_at`을 서명 대상에 포함 -- v1엔 `expires_at`만 있고 발급 시각이
//       서명 밖이라 "최근에 발급됐다"는 freshness를 증명하지 못했다.
//   (ㄴ) `target.launch_profile_sha256` -- "supervisor target/launch profile"
//       결속. 이 필드는 authorization manifest(pull-authorization.mjs)의
//       launch_profile_sha256과 대조되어(pull-admission.mjs) 어느 worker
//       실행 프로필로 기동할지를 서명에 고정한다.
//
// 이 모듈은 순수 함수만 담는다(파일 I/O·시각 조회 없음 -- I3 원칙 재적용).
// "지금이 만료 전인가"(issued_at ≤ now ≤ expires_at)는 여기서 판단하지 않는다
// -- 그건 nowMs가 필요한 pull-admission.mjs 몫이다(auth-grant-gate.mjs의
// checkExpiry와 동일 경계). 이 모듈이 구조적으로 고정하는 것은 "grant 자체가
// 내부적으로 앞뒤가 맞는가"(issued_at < expires_at, 수명 ≤ 30분)뿐이다 -- v1의
// budget.max_starts_total===1 고정과 동일한 종류의 정책 상수를 canonical에
// 얹은 것(재발명이 아니라 그 패턴의 연장).

const MAX_LIFETIME_MS = 30 * 60 * 1000; // 패킷 §3 정본: expires_at-issued_at <= 30분

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

export const CANONICAL_FIELD_NAMES = Object.freeze([
  "schema_version",
  "policy_version",
  "packet_sha256",
  "addendum_sha256",
  "authorization_sha256",
  "task_sha256",
  "task_id",
  "target",
  "audience",
  "channel",
  "arm_id",
  "cycle_id",
  "issued_at",
  "expires_at",
  "budget",
  "jti",
]);

function validateTarget(t) {
  if (!isPlainObject(t)) return false;
  return (
    isNonEmptyString(t.handle) &&
    isNonEmptyString(t.fingerprint) &&
    isNonEmptyString(t.agent_instance) &&
    isNonEmptyString(t.launch_profile_sha256) &&
    SHA256_HEX_RE.test(t.launch_profile_sha256)
  );
}

function validateBudget(b) {
  return isPlainObject(b) && b.max_starts_total === 1;
}

function collectHashProblems(fields) {
  const problems = [];
  for (const f of [
    "packet_sha256",
    "addendum_sha256",
    "authorization_sha256",
    "task_sha256",
  ]) {
    if (!isNonEmptyString(fields[f]) || !SHA256_HEX_RE.test(fields[f])) {
      problems.push(`'${f}' must be a 64-hex-char sha256 string`);
    }
  }
  return problems;
}

function collectScalarProblems(fields) {
  const problems = [];
  if (!isSafeCount(fields.schema_version) || fields.schema_version < 1) {
    problems.push("'schema_version' must be a positive safe integer");
  }
  if (!isSafeCount(fields.policy_version) || fields.policy_version < 1) {
    problems.push("'policy_version' must be a positive safe integer");
  }
  if (!isNonEmptyString(fields.task_id)) {
    problems.push("'task_id' must be a non-empty string");
  }
  if (!isNonEmptyString(fields.audience)) {
    problems.push("'audience' must be a non-empty string");
  }
  if (!isNonEmptyString(fields.channel)) {
    problems.push("'channel' must be a non-empty string");
  }
  if (!isNonEmptyString(fields.arm_id)) {
    problems.push("'arm_id' must be a non-empty string");
  }
  if (!isNonEmptyString(fields.cycle_id)) {
    problems.push("'cycle_id' must be a non-empty string");
  }
  if (!isNonEmptyString(fields.jti)) {
    problems.push("'jti' must be a non-empty string (one-time claim id)");
  }
  return problems;
}

function collectStructuralProblems(fields) {
  const problems = [];
  if (!validateTarget(fields.target)) {
    problems.push(
      "'target' must be {handle, fingerprint, agent_instance, launch_profile_sha256(sha256 hex)} non-empty strings",
    );
  }
  if (
    !isNonEmptyString(fields.issued_at) ||
    Number.isNaN(Date.parse(fields.issued_at))
  ) {
    problems.push("'issued_at' must be an ISO-8601 date string");
  }
  if (
    !isNonEmptyString(fields.expires_at) ||
    Number.isNaN(Date.parse(fields.expires_at))
  ) {
    problems.push("'expires_at' must be an ISO-8601 date string");
  }
  if (!validateBudget(fields.budget)) {
    problems.push("'budget' must be exactly {max_starts_total: 1}");
  }
  return problems;
}

// issued_at/expires_at은 각각 유효한 날짜여야 collectLifetimeProblems가 도달할
// 의미가 있다 -- 파싱 실패 케이스는 collectStructuralProblems가 이미 잡으므로
// 여기서는 "둘 다 파싱 가능할 때"만 순서/수명을 추가로 검사한다(중복 reason
// 방지, 원인 특정).
function collectLifetimeProblems(fields) {
  const issuedMs = Date.parse(fields.issued_at);
  const expiresMs = Date.parse(fields.expires_at);
  if (Number.isNaN(issuedMs) || Number.isNaN(expiresMs)) return [];
  const problems = [];
  if (issuedMs >= expiresMs) {
    problems.push("'issued_at' must be strictly before 'expires_at'");
  } else if (expiresMs - issuedMs > MAX_LIFETIME_MS) {
    problems.push(
      `'expires_at' - 'issued_at' must be <= ${MAX_LIFETIME_MS}ms (30 minutes)`,
    );
  }
  return problems;
}

function collectFieldProblems(fields) {
  return [
    ...collectHashProblems(fields),
    ...collectScalarProblems(fields),
    ...collectStructuralProblems(fields),
    ...collectLifetimeProblems(fields),
  ];
}

function buildCanonicalFields(fields) {
  return {
    schema_version: fields.schema_version,
    policy_version: fields.policy_version,
    packet_sha256: fields.packet_sha256.toLowerCase(),
    addendum_sha256: fields.addendum_sha256.toLowerCase(),
    authorization_sha256: fields.authorization_sha256.toLowerCase(),
    task_sha256: fields.task_sha256.toLowerCase(),
    task_id: fields.task_id,
    target: {
      handle: fields.target.handle,
      fingerprint: fields.target.fingerprint,
      agent_instance: fields.target.agent_instance,
      launch_profile_sha256: fields.target.launch_profile_sha256.toLowerCase(),
    },
    audience: fields.audience,
    channel: fields.channel,
    arm_id: fields.arm_id,
    cycle_id: fields.cycle_id,
    issued_at: fields.issued_at,
    expires_at: fields.expires_at,
    budget: { max_starts_total: fields.budget.max_starts_total },
    jti: fields.jti,
  };
}

// fields -> { ok, reason? } | { ok:true, fields, canonicalJson, canonicalBytes }
export function canonicalizePullGrant(fields) {
  if (!isPlainObject(fields)) {
    return {
      ok: false,
      reason: "pull-grant-canonical: fields is not a plain object",
    };
  }
  const problems = collectFieldProblems(fields);
  if (problems.length > 0) {
    return {
      ok: false,
      reason: `pull-grant-canonical: ${problems.join("; ")}`,
    };
  }

  const canonicalFields = buildCanonicalFields(fields);
  const canonicalJson = canonicalStringify(canonicalFields);
  return {
    ok: true,
    fields: canonicalFields,
    canonicalJson,
    canonicalBytes: Buffer.from(canonicalJson, "utf8"),
  };
}

export const MAX_PULL_GRANT_LIFETIME_MS = MAX_LIFETIME_MS;
