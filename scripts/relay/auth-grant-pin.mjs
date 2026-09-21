import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// HYK-163 사이클 1 (G3): 사전배포 공개키 pin 로더.
//
// 규칙 확정(패킷 §4): workspace(`.harness/` 포함)에는 **공개 자료만**
// 허용한다 -- 공개키(PEM)·key id·상태(active/revoked)뿐인 signed manifest.
// 개인키·대칭 비밀·bearer nonce는 절대 이 파일이 다루는 형식에 담기지
// 않는다(아래 containsPrivateKeyMaterial이 로드 자체를 거부한다).
//
// auto trust-on-first-use 금지: 이 로더는 "처음 보는 키를 등록"하는 기능이
// 없다 -- pin manifest에 이미 있는 key_id만 찾아 돌려주고, 없으면 게이트가
// KEY_UNKNOWN으로 deny한다(auth-grant-gate.mjs).

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

export function sha256Pem(pem) {
  if (typeof pem !== "string") {
    throw new TypeError("auth-grant-pin: sha256Pem requires a string");
  }
  return createHash("sha256").update(pem, "utf8").digest("hex");
}

// PEM 블록의 헤더로 개인키류를 판별한다(PRIVATE KEY / EC PRIVATE KEY 등).
// "PUBLIC KEY"만 포함하고 "PRIVATE KEY" 부분 문자열이 전혀 없어야 통과.
function containsPrivateKeyMaterial(pem) {
  return typeof pem !== "string" || /PRIVATE KEY/.test(pem);
}

function normalizeDeps(deps) {
  const d = isPlainObject(deps) ? deps : {};
  return {
    readFileFn:
      typeof d.readFileFn === "function"
        ? d.readFileFn
        : (p) => readFileSync(p, "utf8"),
  };
}

// pinPath -> { ok, reason? } | { ok:true, keys: [{key_id, public_key_pem, status, fingerprint}] }
export function loadPinnedPublicKeys(pinPath, deps) {
  if (!isNonEmptyString(pinPath)) {
    return {
      ok: false,
      reason: "auth-grant-pin: pinPath must be a non-empty string",
    };
  }
  const d = normalizeDeps(deps);
  let raw;
  try {
    raw = d.readFileFn(pinPath);
  } catch (err) {
    return {
      ok: false,
      reason: `auth-grant-pin: cannot read pin manifest '${pinPath}' (${errText(err)})`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `auth-grant-pin: pin manifest is not valid JSON (${errText(err)})`,
    };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.trusted_keys)) {
    return {
      ok: false,
      reason: "auth-grant-pin: pin manifest missing 'trusted_keys' array",
    };
  }
  const keys = [];
  for (let i = 0; i < parsed.trusted_keys.length; i++) {
    const entry = parsed.trusted_keys[i];
    if (
      !isPlainObject(entry) ||
      !isNonEmptyString(entry.key_id) ||
      !isNonEmptyString(entry.public_key_pem)
    ) {
      return {
        ok: false,
        reason: `auth-grant-pin: trusted_keys[${i}] malformed -- key_id/public_key_pem required`,
      };
    }
    if (containsPrivateKeyMaterial(entry.public_key_pem)) {
      return {
        ok: false,
        reason: `auth-grant-pin: trusted_keys[${i}] ('${entry.key_id}') public_key_pem contains 'PRIVATE KEY' -- refusing to load (G3)`,
      };
    }
    keys.push({
      key_id: entry.key_id,
      public_key_pem: entry.public_key_pem,
      status: entry.status === "revoked" ? "revoked" : "active",
      fingerprint: sha256Pem(entry.public_key_pem),
    });
  }
  return { ok: true, keys };
}

export function findKeyById(keys, keyId) {
  if (!Array.isArray(keys) || !isNonEmptyString(keyId)) return null;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i]?.key_id === keyId) return keys[i];
  }
  return null;
}
