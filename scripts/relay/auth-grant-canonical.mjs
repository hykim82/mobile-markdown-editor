// HYK-163 사이클 1 (G2): signed-grant 객체의 결정적(canonical) 직렬화.
//
// 목적: 서명자와 검증자가 필드 순서·공백 차이 없이 **동일 바이트열** 위에서
// sign/verify하도록 강제한다. 이 모듈은 순수 함수만 담는다(파일 I/O·시각
// 조회 없음) -- arm-seal.mjs/arm-state.mjs의 "canonical만 신뢰" 원칙(I3)을
// 새 스킴에 재적용한 것이다(재구현이 아니라 계약 이식).
//
// G2 필드(전부 canonical 바이트에 결속 -- 하나라도 값이 바뀌면 서명이 깨진다):
//   schema_version·policy_version·packet_sha256·addendum_sha256·
//   authorization_sha256·task_sha256·task_id·target{handle,fingerprint,
//   agent_instance}·audience·channel·arm_id·cycle_id·expires_at·
//   budget{max_starts_total=1 고정}·jti
//
// target.agent_instance: 이번 사이클은 "필드가 존재하고 canonical에 결속되는지"만
// 다룬다. 그 값이 실제로 살아있는 agent와 대응하는지(liveness 대조)는 사이클2 몫
// -- 이 필드를 여기서 검증한다고 liveness를 증명한다는 주장은 하지 않는다.

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
  "expires_at",
  "budget",
  "jti",
]);

function validateTarget(t) {
  if (!isPlainObject(t)) return false;
  return (
    isNonEmptyString(t.handle) &&
    isNonEmptyString(t.fingerprint) &&
    isNonEmptyString(t.agent_instance)
  );
}

function validateBudget(b) {
  // max_starts_total=1 고정(패킷 §3 정본) -- 이 사이클의 grant 스킴은 단일 1회용
  // claim만 표현한다. 다른 값은 구조적으로 무효(서명 검증까지 갈 필요도 없다).
  return isPlainObject(b) && b.max_starts_total === 1;
}

// 결정적 stable-key JSON: 객체 키를 재귀적으로 알파벳 정렬한다. 입력 객체의
// 원래 키 순서와 무관하게 동일한 값 집합은 항상 동일한 바이트열을 낸다.
export function canonicalStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}

// 검증을 세 그룹(해시류/스칼라류/구조류)으로 나눠 각 헬퍼의 복잡도를 낮춘다
// (canonicalizeGrant 자체는 오케스트레이션만 -- max-lines-per-function/complexity
// 래칫, quality-check.mjs 재사용).
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
      "'target' must be {handle, fingerprint, agent_instance} non-empty strings",
    );
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

function collectFieldProblems(fields) {
  return [
    ...collectHashProblems(fields),
    ...collectScalarProblems(fields),
    ...collectStructuralProblems(fields),
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
    },
    audience: fields.audience,
    channel: fields.channel,
    arm_id: fields.arm_id,
    cycle_id: fields.cycle_id,
    expires_at: fields.expires_at,
    budget: { max_starts_total: fields.budget.max_starts_total },
    jti: fields.jti,
  };
}

// fields -> { ok, reason? } | { ok:true, fields (canonical 부분집합), canonicalJson, canonicalBytes }
export function canonicalizeGrant(fields) {
  if (!isPlainObject(fields)) {
    return {
      ok: false,
      reason: "auth-grant-canonical: fields is not a plain object",
    };
  }
  const problems = collectFieldProblems(fields);
  if (problems.length > 0) {
    return {
      ok: false,
      reason: `auth-grant-canonical: ${problems.join("; ")}`,
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
