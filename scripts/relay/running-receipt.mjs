import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireArmMutex, releaseArmMutex } from "./arm-state.mjs";

// HYK-171 사이클3B (coder-task.md §1/§2): RUNNING receipt(launch
// acceptance) 원장 -- "이 stable intent에 대해 지금 워커를 띄우기로
// 수락했다"는 사실만 담는다. 이 receipt는 **worker completion을 주장하지
// 않는다** -- 완료 판정은 여전히 scripts/check/relay-handshake.mjs가
// 정본이고, 이 파일은 그 권위를 전혀 다루지 않는다(읽지도, import하지도
// 않는다).
//
// 재사용(재구현 금지, coder-task.md 지침): grant-issuer.mjs의
// writeSubGrantEnvelope(create-new-only `wx` + read-back-and-compare)
// 패턴을 그대로 이식한다. mutex는 arm-state.mjs의
// acquireArmMutex/releaseArmMutex를 그대로 재사용한다(원자저장 자체는
// saveStoreAtomic이 아니라 wx-쓰기 -- 이 store는 tmp->rename 갱신이
// 아니라 "존재하면 절대 안 씀"이 계약이라 saveStoreAtomic의 덮어쓰기
// 의미와 안 맞는다, 그래서 grant-issuer의 wx 패턴을 이식한다). 유일성
// 키는 오직 `stable_intent_id` 하나다 -- 그래서 같은 stableIntentId에
// 대해 이 receipt는 create-new-only로 원자 유일이고, 이미 있으면
// 재수락 자체가 거부된다(중복 sink 원천 차단, §4/§6 mutation #4).

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

export const REASON = Object.freeze({
  ALREADY_RUNNING: "RUNNING_RECEIPT_ALREADY_EXISTS",
  WRITE_FAILED: "RUNNING_RECEIPT_WRITE_FAILED",
  INVALID_INPUT: "RUNNING_RECEIPT_INVALID_INPUT",
});

function receiptPathFor(receiptDir, stableIntentId) {
  return join(receiptDir, `running-receipt-${stableIntentId}.json`);
}
export function runningReceiptPath(receiptDir, stableIntentId) {
  return receiptPathFor(receiptDir, stableIntentId);
}

function defaultExclusiveWrite(path, content) {
  writeFileSync(path, content, { flag: "wx" });
}
function normalizeDeps(deps) {
  const d = isPlainObject(deps) ? deps : {};
  return {
    existsFn: typeof d.existsFn === "function" ? d.existsFn : existsSync,
    readFileFn:
      typeof d.readFileFn === "function"
        ? d.readFileFn
        : (p) => readFileSync(p, "utf8"),
    writeFn:
      typeof d.writeFn === "function" ? d.writeFn : defaultExclusiveWrite,
  };
}

// hasRunningReceipt: 순수 존재 확인(부작용 없음) -- 호출자가 사전 조회에
// 쓸 수 있다. existsFn이 죽으면 fail-closed로 "있다"고 보수적으로 본다
// (없다고 잘못 보고해 중복 수락을 허용하는 쪽보다 안전).
export function hasRunningReceipt(receiptDir, stableIntentId, opts) {
  const deps = normalizeDeps(opts);
  if (!isNonEmptyString(receiptDir) || !isNonEmptyString(stableIntentId)) {
    return true;
  }
  try {
    return deps.existsFn(receiptPathFor(receiptDir, stableIntentId));
  } catch {
    return true;
  }
}

function underReceiptMutex(path, stableIntentId, subGrantEnvelope, at, deps) {
  let exists;
  try {
    exists = deps.existsFn(path);
  } catch (err) {
    return {
      ok: false,
      reason: `running-receipt: existsFn threw (${errText(err)})`,
    };
  }
  if (exists) {
    return {
      ok: false,
      alreadyRunning: true,
      reason: REASON.ALREADY_RUNNING,
      path,
    };
  }
  const record = {
    schema_version: 1,
    stable_intent_id: stableIntentId,
    sub_grant_task_hash: isPlainObject(subGrantEnvelope)
      ? (subGrantEnvelope.task_hash ?? null)
      : null,
    sub_grant_role: isPlainObject(subGrantEnvelope)
      ? (subGrantEnvelope.role ?? null)
      : null,
    event: "launch_acceptance",
    accepted_at: at ?? null,
  };
  const content = JSON.stringify(record, null, 2) + "\n";
  try {
    deps.writeFn(path, content);
  } catch (err) {
    return {
      ok: false,
      reason: `running-receipt: ${REASON.WRITE_FAILED} -- could not create '${path}' (${errText(err)})`,
    };
  }
  let reread;
  try {
    reread = deps.readFileFn(path);
  } catch (err) {
    return {
      ok: false,
      reason: `running-receipt: ${REASON.WRITE_FAILED} -- re-read after write failed (${errText(err)})`,
    };
  }
  if (reread !== content) {
    return {
      ok: false,
      reason: `running-receipt: ${REASON.WRITE_FAILED} -- re-read mismatch after write -- refusing to report accepted`,
    };
  }
  return { ok: true, path, record };
}

// acceptRunningReceipt({ receiptDir, stableIntentId, subGrantEnvelope, at },
// opts) -> exactly-once launch-acceptance record. receiptDir은 호출자
// trusted config(grant/authorization 등 unverified 입력에서 유도 금지 --
// stable-intent.mjs의 intentDir 계약과 동일 원리).
export function acceptRunningReceipt(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  const { receiptDir, stableIntentId, subGrantEnvelope, at } = inp;
  if (!isNonEmptyString(receiptDir) || !isNonEmptyString(stableIntentId)) {
    return {
      ok: false,
      reason: `running-receipt: ${REASON.INVALID_INPUT} -- receiptDir/stableIntentId must be non-empty strings`,
    };
  }
  const deps = normalizeDeps(opts);
  const path = receiptPathFor(receiptDir, stableIntentId);

  const mtx = acquireArmMutex(receiptDir, stableIntentId, deps);
  if (!mtx.ok) {
    return { ok: false, reason: mtx.reason, paused: mtx.paused === true };
  }

  let result;
  try {
    result = underReceiptMutex(
      path,
      stableIntentId,
      subGrantEnvelope,
      at,
      deps,
    );
  } catch (err) {
    const rel = releaseArmMutex(mtx, deps);
    return {
      ok: false,
      reason: `running-receipt: transaction body threw (${errText(err)})`,
      mutex_release_failed: rel.released === false,
    };
  }
  const rel = releaseArmMutex(mtx, deps);
  if (rel.released === false) {
    return {
      ...result,
      mutex_release_failed: true,
      mutex_release_reason: rel.reason,
    };
  }
  return result;
}
