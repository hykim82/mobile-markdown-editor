import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizePullGrant } from "./pull-grant-canonical.mjs";
import { canonicalizeAuthorization } from "./pull-authorization.mjs";
import { verify as ed25519Verify } from "./auth-grant-ed25519.mjs";
import { loadPinnedPublicKeys, findKeyById } from "./auth-grant-pin.mjs";

// HYK-165 사이클 1 (P1/P2/P10): `harness-signed-pull-v1` admission 판정 --
// sealed 5파일 bundle(signed-grant/authorization/arm-state/ledger/receipt 중
// 앞 3개를 이 판정이 직접 대조한다. ledger claim·receipt 기록은 supervisor
// 배선 몫이라 이 사이클 범위 밖 -- 여기서는 "ALLOW/DENY를 순수하게 판정"만
// 한다)을 소비해 ALLOW/DENY를 반환하는 fail-closed 판정기다.
//
// auth-grant-gate.mjs(HYK-163 G1/G2/G4)의 구조를 그대로 승계한다(재발명
// 금지): distinct REASON 상수 + `checkA(...) ?? checkB(...) ?? ...` 체이닝 +
// ALLOW는 전 조건 통과 시에만. 개인키는 이 파일 어디에도 인자로 등장하지
// 않는다(P2 -- ed25519Verify가 공개키만 받는 타입 계약을 그대로 재사용).
//
// P10 불변부 대조 3중 결속:
//  (a) signed-grant의 `authorization_sha256`이 authorization manifest의
//      canonical 해시와 정확히 같아야 한다(내용 위조 탐지).
//  (b) authorization/arm-state 파일명이 인코딩하는 arm_id/jti가 파일 내용의
//      arm_id/jti와 같아야 한다(파일 복사/overwrite로 다른 arm 콘텐츠를
//      엉뚱한 파일명 자리에 놓는 시나리오 탐지 -- "bundle 파일 overwrite/copy
//      -> 불변부 불일치" 반사실).
//  (c) authorization/arm-state의 arm/cycle/task/lane/expiry/예산 불변부가
//      signed-grant의 canonical 필드와 정확히 일치해야 한다(replay-into-
//      wrong-context 방지, auth-grant-gate.mjs의 expected 결속과 동일 원리를
//      "다른 bundle 파일" 축으로 확장).
//
// HYK-165 사이클2 REVIEW-A 반려 수리(coder-3): (c)의 expected 대조 목록에
// worker_config_sha256이 빠져 있었고, packet_sha256은 형식(64-hex)만 보고
// expected와 전혀 대조하지 않았다(공격자가 worker config/packet을 바꿔치기해도
// 못 잡는 실제 구멍). checkAuthorizationContext()의 expected 결속 목록에
// worker_config_sha256을 추가하고, checkFieldBindings()에 packet_sha256
// expected 대조를 추가해 닫았다 -- 기존 계약 완화 0, 결속만 추가.

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isSafeCount(v) {
  return Number.isSafeInteger(v) && v >= 0;
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

export const REASON = Object.freeze({
  BUNDLE_READ_ERROR: "BUNDLE_READ_ERROR",
  BUNDLE_IDENTITY_MISMATCH: "BUNDLE_IDENTITY_MISMATCH",
  CANONICAL_INVALID: "CANONICAL_INVALID",
  SCHEMA_VERSION_MISMATCH: "SCHEMA_VERSION_MISMATCH",
  POLICY_VERSION_MISMATCH: "POLICY_VERSION_MISMATCH",
  KEY_ID_MISSING: "KEY_ID_MISSING",
  PIN_UNAVAILABLE: "PIN_UNAVAILABLE",
  KEY_UNKNOWN: "KEY_UNKNOWN",
  KEY_REVOKED: "KEY_REVOKED",
  PINNED_FINGERPRINT_REQUIRED: "PINNED_FINGERPRINT_REQUIRED",
  PIN_MISMATCH: "PIN_MISMATCH",
  SIGNATURE_MISSING: "SIGNATURE_MISSING",
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  TASK_ID_MISMATCH: "TASK_ID_MISMATCH",
  ARM_ID_MISMATCH: "ARM_ID_MISMATCH",
  CYCLE_ID_MISMATCH: "CYCLE_ID_MISMATCH",
  TARGET_MISMATCH: "TARGET_MISMATCH",
  AGENT_INSTANCE_MISMATCH: "AGENT_INSTANCE_MISMATCH",
  LAUNCH_PROFILE_MISMATCH: "LAUNCH_PROFILE_MISMATCH",
  AUDIENCE_MISMATCH: "AUDIENCE_MISMATCH",
  CHANNEL_MISMATCH: "CHANNEL_MISMATCH",
  PACKET_HASH_MISMATCH: "PACKET_HASH_MISMATCH",
  ISSUED_AT_FUTURE: "ISSUED_AT_FUTURE",
  EXPIRED: "EXPIRED",
  AUTHORIZATION_INVALID: "AUTHORIZATION_INVALID",
  AUTHORIZATION_HASH_MISMATCH: "AUTHORIZATION_HASH_MISMATCH",
  AUTHORIZATION_CONTEXT_MISMATCH: "AUTHORIZATION_CONTEXT_MISMATCH",
  ARM_STATE_INVALID: "ARM_STATE_INVALID",
  ARM_STATE_MISMATCH: "ARM_STATE_MISMATCH",
  ALLOW: "ALLOW",
});

function deny(reason, detail) {
  return { ok: false, reason, detail: detail ?? null };
}

function normalizeDeps(deps) {
  const d = isPlainObject(deps) ? deps : {};
  return {
    readFileFn:
      typeof d.readFileFn === "function"
        ? d.readFileFn
        : (p) => readFileSync(p, "utf8"),
    pinDeps: d.pinDeps,
  };
}

function bundlePaths(bundleDir, armId, jti) {
  return {
    grantPath: join(bundleDir, `signed-grant-${armId}-${jti}.json`),
    authorizationPath: join(bundleDir, `authorization-${armId}.json`),
    armStatePath: join(bundleDir, `arm-${armId}.json`),
  };
}

function readJsonFile(path, readFileFn) {
  let raw;
  try {
    raw = readFileFn(path);
  } catch (err) {
    return { ok: false, reason: `cannot read '${path}' (${errText(err)})` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      reason: `'${path}' is not valid JSON (${errText(err)})`,
    };
  }
}

function checkVersions(fields, expected) {
  if (
    !isSafeCount(expected.schema_version) ||
    fields.schema_version !== expected.schema_version
  ) {
    return deny(
      REASON.SCHEMA_VERSION_MISMATCH,
      `expected schema_version=${JSON.stringify(expected.schema_version)}, grant has ${fields.schema_version}`,
    );
  }
  if (
    !isSafeCount(expected.policy_version) ||
    fields.policy_version !== expected.policy_version
  ) {
    return deny(
      REASON.POLICY_VERSION_MISMATCH,
      `expected policy_version=${JSON.stringify(expected.policy_version)}, grant has ${fields.policy_version}`,
    );
  }
  return null;
}

function checkKey(grantRaw, expected, pinnedPublicKeyPath, pinDeps) {
  const keyId = isPlainObject(grantRaw) ? grantRaw.key_id : undefined;
  if (!isNonEmptyString(keyId)) {
    return {
      denied: deny(REASON.KEY_ID_MISSING, "grantRaw.key_id is missing/empty"),
    };
  }
  let loaded;
  try {
    loaded = loadPinnedPublicKeys(pinnedPublicKeyPath, pinDeps);
  } catch (err) {
    return {
      denied: deny(
        REASON.PIN_UNAVAILABLE,
        `loadPinnedPublicKeys threw: ${errText(err)}`,
      ),
    };
  }
  if (!loaded.ok)
    return { denied: deny(REASON.PIN_UNAVAILABLE, loaded.reason) };

  const key = findKeyById(loaded.keys, keyId);
  if (!key) {
    return {
      denied: deny(
        REASON.KEY_UNKNOWN,
        `key_id ${JSON.stringify(keyId)} not found in pin manifest`,
      ),
    };
  }
  if (key.status === "revoked") {
    return {
      denied: deny(
        REASON.KEY_REVOKED,
        `key_id ${JSON.stringify(keyId)} is revoked`,
      ),
    };
  }
  if (!isNonEmptyString(expected.pinned_key_fingerprint)) {
    return {
      denied: deny(
        REASON.PINNED_FINGERPRINT_REQUIRED,
        "expected.pinned_key_fingerprint is required (workspace manifest alone is never a trust anchor)",
      ),
    };
  }
  if (expected.pinned_key_fingerprint !== key.fingerprint) {
    return {
      denied: deny(
        REASON.PIN_MISMATCH,
        `pin manifest resolved key_id ${JSON.stringify(keyId)} to fingerprint ${key.fingerprint}, but expected anchor is ${expected.pinned_key_fingerprint}`,
      ),
    };
  }
  return { key };
}

function checkSignature(signature, canonicalBytes, publicKeyPem) {
  if (!isNonEmptyString(signature)) {
    return deny(REASON.SIGNATURE_MISSING, "signature is missing/empty");
  }
  let signatureBuf;
  try {
    signatureBuf = Buffer.from(signature, "base64");
  } catch (err) {
    return deny(
      REASON.SIGNATURE_INVALID,
      `signature is not valid base64 (${errText(err)})`,
    );
  }
  if (signatureBuf.length === 0) {
    return deny(
      REASON.SIGNATURE_MISSING,
      "signature decodes to an empty buffer",
    );
  }
  const verified = ed25519Verify(canonicalBytes, signatureBuf, publicKeyPem);
  if (!verified) {
    return deny(
      REASON.SIGNATURE_INVALID,
      "Ed25519 signature does not verify against the pinned public key for this canonical payload",
    );
  }
  return null;
}

function checkTargetBinding(fields, expected) {
  const et = isPlainObject(expected.target) ? expected.target : {};
  if (!isNonEmptyString(et.handle) || fields.target.handle !== et.handle) {
    return deny(
      REASON.TARGET_MISMATCH,
      `expected target.handle=${JSON.stringify(et.handle)}, grant has ${JSON.stringify(fields.target.handle)}`,
    );
  }
  if (
    !isNonEmptyString(et.fingerprint) ||
    fields.target.fingerprint !== et.fingerprint
  ) {
    return deny(
      REASON.TARGET_MISMATCH,
      `expected target.fingerprint=${JSON.stringify(et.fingerprint)}, grant has ${JSON.stringify(fields.target.fingerprint)}`,
    );
  }
  if (
    !isNonEmptyString(et.agent_instance) ||
    fields.target.agent_instance !== et.agent_instance
  ) {
    return deny(
      REASON.AGENT_INSTANCE_MISMATCH,
      `expected target.agent_instance=${JSON.stringify(et.agent_instance)}, grant has ${JSON.stringify(fields.target.agent_instance)}`,
    );
  }
  if (
    !isNonEmptyString(et.launch_profile_sha256) ||
    fields.target.launch_profile_sha256 !== et.launch_profile_sha256
  ) {
    return deny(
      REASON.LAUNCH_PROFILE_MISMATCH,
      `expected target.launch_profile_sha256=${JSON.stringify(et.launch_profile_sha256)}, grant has ${JSON.stringify(fields.target.launch_profile_sha256)}`,
    );
  }
  return null;
}

// 단일 필드 exact-match 결속 헬퍼(coder-3 국소 리팩터): checkFieldBindings가
// 반복하던 "isNonEmptyString(expected) && fields===expected 아니면 deny"
// 패턴 하나를 함수로 뽑아, 아래 checkFieldBindings는 이 파일 머리 주석이
// 이미 선언한 `checkA(...) ?? checkB(...) ?? ...` 체이닝 스타일로 조합만
// 한다(quality-check 함수당 복잡도 상한 준수 -- 판정 내용은 그대로).
function checkExpectedStringMatch(actual, expectedValue, reason, label) {
  if (!isNonEmptyString(expectedValue) || actual !== expectedValue) {
    return deny(
      reason,
      `expected ${label}=${JSON.stringify(expectedValue)}, grant has ${JSON.stringify(actual)}`,
    );
  }
  return null;
}

// HYK-165 사이클2 REVIEW-A 반려 수리(coder-3): packet_sha256 결속을
// 추가했다 -- pull-grant-canonical.mjs는 packet_sha256을 형식(64-hex)만
// 검증하고 expected와 대조하지 않았다. auth-grant-gate.mjs의 expected 결속
// 원리를 여기도 적용해, 서명된 grant가 trusted config가 기대하는 정확히 그
// packet을 가리키는지 확인한다.
function checkFieldBindings(fields, expected) {
  return (
    checkExpectedStringMatch(
      fields.task_id,
      expected.task_id,
      REASON.TASK_ID_MISMATCH,
      "task_id",
    ) ??
    checkExpectedStringMatch(
      fields.arm_id,
      expected.arm_id,
      REASON.ARM_ID_MISMATCH,
      "arm_id",
    ) ??
    checkExpectedStringMatch(
      fields.cycle_id,
      expected.cycle_id,
      REASON.CYCLE_ID_MISMATCH,
      "cycle_id",
    ) ??
    checkTargetBinding(fields, expected) ??
    checkExpectedStringMatch(
      fields.audience,
      expected.audience,
      REASON.AUDIENCE_MISMATCH,
      "audience",
    ) ??
    checkExpectedStringMatch(
      fields.channel,
      expected.channel,
      REASON.CHANNEL_MISMATCH,
      "channel",
    ) ??
    checkExpectedStringMatch(
      fields.packet_sha256,
      expected.packet_sha256,
      REASON.PACKET_HASH_MISMATCH,
      "packet_sha256",
    ) ??
    null
  );
}

// freshness: issued_at <= now <= expires_at. TTL<=30분은 이미 canonical
// 구조 검증에서 고정됐다(pull-grant-canonical.mjs) -- 여기서는 "지금"이
// 필요한 두 비교만 한다(auth-grant-gate.mjs checkExpiry와 동일 경계 분리).
function checkFreshness(fields, nowMs) {
  const issuedMs = Date.parse(fields.issued_at);
  const expiresMs = Date.parse(fields.expires_at);
  if (!Number.isSafeInteger(nowMs)) {
    return deny(
      REASON.EXPIRED,
      `nowMs is not a safe integer: ${JSON.stringify(nowMs)}`,
    );
  }
  if (nowMs < issuedMs) {
    return deny(
      REASON.ISSUED_AT_FUTURE,
      `grant issued_at=${fields.issued_at} is after now=${new Date(nowMs).toISOString()}`,
    );
  }
  if (nowMs > expiresMs) {
    return deny(
      REASON.EXPIRED,
      `grant expires_at=${fields.expires_at}, now=${new Date(nowMs).toISOString()}`,
    );
  }
  return null;
}

function checkAuthorizationContext(authFields, fields, expected) {
  if (
    authFields.arm_id !== fields.arm_id ||
    authFields.cycle_id !== fields.cycle_id ||
    authFields.task_id !== fields.task_id
  ) {
    return deny(
      REASON.AUTHORIZATION_CONTEXT_MISMATCH,
      `authorization arm/cycle/task ${JSON.stringify({ arm_id: authFields.arm_id, cycle_id: authFields.cycle_id, task_id: authFields.task_id })} does not match signed grant ${JSON.stringify({ arm_id: fields.arm_id, cycle_id: fields.cycle_id, task_id: fields.task_id })}`,
    );
  }
  if (authFields.task_header_sha256 !== fields.task_sha256) {
    return deny(
      REASON.AUTHORIZATION_CONTEXT_MISMATCH,
      `authorization task_header_sha256=${authFields.task_header_sha256} does not match signed grant task_sha256=${fields.task_sha256}`,
    );
  }
  if (
    authFields.launch_profile_sha256 !== fields.target.launch_profile_sha256
  ) {
    return deny(
      REASON.AUTHORIZATION_CONTEXT_MISMATCH,
      `authorization launch_profile_sha256=${authFields.launch_profile_sha256} does not match signed grant target.launch_profile_sha256=${fields.target.launch_profile_sha256}`,
    );
  }
  const et = isPlainObject(expected) ? expected : {};
  for (const f of [
    "resolved_task_path",
    "task_header_id",
    "lane",
    "cwd",
    "worktree",
    "worker_config_sha256",
  ]) {
    if (!isNonEmptyString(et[f]) || authFields[f] !== et[f]) {
      return deny(
        REASON.AUTHORIZATION_CONTEXT_MISMATCH,
        `expected authorization.${f}=${JSON.stringify(et[f])}, authorization has ${JSON.stringify(authFields[f])}`,
      );
    }
  }
  return null;
}

function loadAndCheckAuthorization(
  authorizationPath,
  readFileFn,
  fields,
  expected,
) {
  const read = readJsonFile(authorizationPath, readFileFn);
  if (!read.ok) return { denied: deny(REASON.BUNDLE_READ_ERROR, read.reason) };
  const authRaw = read.value;
  if (!isPlainObject(authRaw) || authRaw.arm_id !== expected.arm_id) {
    return {
      denied: deny(
        REASON.BUNDLE_IDENTITY_MISMATCH,
        `authorization file at '${authorizationPath}' does not carry arm_id ${JSON.stringify(expected.arm_id)} (filename/content mismatch -- overwrite or copy?)`,
      ),
    };
  }
  const canon = canonicalizeAuthorization(authRaw);
  if (!canon.ok) {
    return { denied: deny(REASON.AUTHORIZATION_INVALID, canon.reason) };
  }
  if (canon.sha256 !== fields.authorization_sha256) {
    return {
      denied: deny(
        REASON.AUTHORIZATION_HASH_MISMATCH,
        `authorization canonical sha256=${canon.sha256} does not match signed grant authorization_sha256=${fields.authorization_sha256}`,
      ),
    };
  }
  const contextDenied = checkAuthorizationContext(
    canon.fields,
    fields,
    expected,
  );
  if (contextDenied) return { denied: contextDenied };
  return { authFields: canon.fields };
}

function isValidArmStateShape(armState) {
  return (
    isPlainObject(armState) &&
    isNonEmptyString(armState.arm_id) &&
    isNonEmptyString(armState.cycle_id) &&
    isNonEmptyString(armState.task_id) &&
    isNonEmptyString(armState.lane) &&
    isNonEmptyString(armState.expires_at) &&
    isPlainObject(armState.budget)
  );
}

function armStateMatchesImmutableSubset(armState, fields, authFields) {
  return (
    armState.arm_id === fields.arm_id &&
    armState.cycle_id === fields.cycle_id &&
    armState.task_id === fields.task_id &&
    armState.lane === authFields.lane &&
    armState.expires_at === fields.expires_at &&
    armState.budget.max_starts_total === fields.budget.max_starts_total
  );
}

function checkArmStateSnapshot(armState, fields, authFields) {
  if (!isValidArmStateShape(armState)) {
    return deny(
      REASON.ARM_STATE_INVALID,
      "arm-state snapshot must have {arm_id, cycle_id, task_id, lane, expires_at, budget} non-empty",
    );
  }
  if (!armStateMatchesImmutableSubset(armState, fields, authFields)) {
    return deny(
      REASON.ARM_STATE_MISMATCH,
      `arm-state snapshot ${JSON.stringify(armState)} does not exactly match signed grant/authorization immutable subset`,
    );
  }
  return null;
}

function loadAndCheckArmState(
  armStatePath,
  readFileFn,
  fields,
  authFields,
  expectedArmId,
) {
  const read = readJsonFile(armStatePath, readFileFn);
  if (!read.ok) return { denied: deny(REASON.BUNDLE_READ_ERROR, read.reason) };
  const armState = read.value;
  if (!isPlainObject(armState) || armState.arm_id !== expectedArmId) {
    return {
      denied: deny(
        REASON.BUNDLE_IDENTITY_MISMATCH,
        `arm-state file at '${armStatePath}' does not carry arm_id ${JSON.stringify(expectedArmId)} (filename/content mismatch -- overwrite or copy?)`,
      ),
    };
  }
  const denied = checkArmStateSnapshot(armState, fields, authFields);
  if (denied) return { denied };
  return { armState };
}

function loadAndCheckGrant(grantPath, readFileFn, armId, jti) {
  const read = readJsonFile(grantPath, readFileFn);
  if (!read.ok) return { denied: deny(REASON.BUNDLE_READ_ERROR, read.reason) };
  const envelope = read.value;
  if (!isPlainObject(envelope) || !isPlainObject(envelope.grantRaw)) {
    return {
      denied: deny(
        REASON.CANONICAL_INVALID,
        `'${grantPath}' does not contain a {grantRaw, signature} envelope`,
      ),
    };
  }
  if (envelope.grantRaw.arm_id !== armId || envelope.grantRaw.jti !== jti) {
    return {
      denied: deny(
        REASON.BUNDLE_IDENTITY_MISMATCH,
        `signed-grant file at '${grantPath}' does not carry arm_id/jti ${JSON.stringify({ armId, jti })} (filename/content mismatch -- overwrite or copy?)`,
      ),
    };
  }
  const canon = canonicalizePullGrant(envelope.grantRaw);
  if (!canon.ok)
    return { denied: deny(REASON.CANONICAL_INVALID, canon.reason) };
  return { envelope, canon };
}

// judgePullAdmission({ bundleDir, armId, jti, pinnedPublicKeyPath, expected, nowMs }, opts)
// opts.deps.readFileFn -- 파일 읽기 주입(테스트 전용, 기본은 실 fs 읽기).
// opts.pinDeps -- loadPinnedPublicKeys용 의존 함수 주입.
// 반환: { ok, reason, detail } -- ok===true일 때만 reason===REASON.ALLOW.
export function judgePullAdmission(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  const expected = isPlainObject(inp.expected) ? inp.expected : {};
  const nowMs = Number.isSafeInteger(inp.nowMs) ? inp.nowMs : Date.now();
  const deps = normalizeDeps(opts);

  if (
    !isNonEmptyString(inp.bundleDir) ||
    !isNonEmptyString(inp.armId) ||
    !isNonEmptyString(inp.jti)
  ) {
    return deny(
      REASON.BUNDLE_READ_ERROR,
      "bundleDir/armId/jti must be non-empty strings",
    );
  }
  const paths = bundlePaths(inp.bundleDir, inp.armId, inp.jti);

  const grantResult = loadAndCheckGrant(
    paths.grantPath,
    deps.readFileFn,
    inp.armId,
    inp.jti,
  );
  if (grantResult.denied) return grantResult.denied;
  const { envelope, canon } = grantResult;
  const { fields, canonicalBytes } = canon;

  const denied =
    checkVersions(fields, expected) ??
    (() => {
      const keyResult = checkKey(
        envelope.grantRaw,
        expected,
        inp.pinnedPublicKeyPath,
        deps.pinDeps,
      );
      if (keyResult.denied) return keyResult.denied;
      return (
        checkSignature(
          envelope.signature,
          canonicalBytes,
          keyResult.key.public_key_pem,
        ) ??
        checkFieldBindings(fields, expected) ??
        checkFreshness(fields, nowMs)
      );
    })();
  if (denied) return denied;

  const authResult = loadAndCheckAuthorization(
    paths.authorizationPath,
    deps.readFileFn,
    fields,
    expected,
  );
  if (authResult.denied) return authResult.denied;

  const armResult = loadAndCheckArmState(
    paths.armStatePath,
    deps.readFileFn,
    fields,
    authResult.authFields,
    fields.arm_id,
  );
  if (armResult.denied) return armResult.denied;

  return {
    ok: true,
    reason: REASON.ALLOW,
    detail: null,
    fields,
    authorization: authResult.authFields,
    armState: armResult.armState,
  };
}
