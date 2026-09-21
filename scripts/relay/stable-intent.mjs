import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  acquireArmMutex,
  releaseArmMutex,
  saveStoreAtomic,
} from "./arm-state.mjs";

// HYK-171 사이클3A (PM 보고서 §2/§6-1): "이 stall을 처리하겠다"는 **안정된
// 실행의도**(stable execution intent) 식별자 + 그 의도에 대한 전역 단일승자
// claim.
//
// 정직한 용어 정정(PM leg2 비평, coder-task.md 서두): 이건 grant/jti/arm_id
// 식별자가 **아니다**. jti/arm_id는 grant 발급 시점에 새로 찍히는 값이라
// 같은 stall에 supervisor 두 개가 서로 다른 jti/arm으로 grant 두 개를
// 만들면 auth-grant-ledger.mjs의 `key_id+jti+grant_digest` 키도,
// arm-state.mjs의 `arm_id` 키도 **둘 다 독립 claim으로 허용**한다(그게 그
// 원장/상태기계의 정확한 계약 -- 버그가 아니라 스코프 밖). stable intent
// id는 그 앞 단계에서, grant가 아예 존재하기 전부터 "이 stall을 이 역할이
// 이 세대에서 처리한다"는 의도 자체를 양쪽(두 supervisor 후보)이 grant
// 없이도 동일하게 계산할 수 있는 값이다 -- 그래서 그 의도에 대한 claim을
// grant 식별자보다 먼저·독립적으로 원자화할 수 있다.
//
// 재사용(재구현 금지, coder-task.md 지침): mutex 획득/해제
// (`acquireArmMutex`/`releaseArmMutex`, wx 마커 + O_EXCL 경합) + tmp->rename
// 원자 저장(`saveStoreAtomic`)은 arm-state.mjs에서 그대로 가져다 쓴다.
// 이 파일은 auth-grant-ledger.mjs와 정확히 같은 모양(normalizeDeps,
// JSON.stringify(array)로 recordId 해싱 -- NUL 바이트 구분자 아님,
// underMutex, acquire/try/release)이되, composite key만 다르다:
// auth-grant-ledger는 `key_id+jti+grant_digest`, 이 파일은 **stable intent
// id 하나**(그 자체가 이미 여러 축의 해시)다.
//
// 신뢰 경계(auth-grant-ledger.mjs의 ledgerDir 계약과 동일 원리): 이 claim
// 레코드 디렉터리(`intentDir`)는 **호출자가 trusted config로 고정**해야
// 한다(grant/authorization 등 unverified 입력 필드에서 유도 금지). 그래야
// 같은 grant를 다른 state dir/inbox로 복사해도(§6 mutation #4) intentDir
// 자체가 grant 필드와 무관한 고정 경로라서 같은 stable intent id가 같은
// 파일을 가리켜 두 번째 claim이 막힌다.
//
// crash/liveness(arm-state.mjs I7과 동일 원칙, coder-task.md §2):
//   - stale mutex 자동삭제 0. acquireArmMutex/releaseArmMutex가 이미
//     그렇게 만들어져 있다(재구현 금지로 그대로 재사용하는 이유이기도
//     하다) -- 이 파일이 별도로 강제할 게 없다.
//   - TTL 자동회수 금지: claim 레코드가 오래됐다고 자동으로 지우고
//     재claim을 허용하면, 원래 승자가 실제로는 아직 살아서 처리 중인
//     상황에서 두 번째 프로세스가 같은 의도를 다시 잡는 split-brain
//     재개방 창이 생긴다. fencing(승자가 죽었다는 사실을 제3자가 검증
//     가능하게 증명하는 메커니즘) 없이는 이 창을 안전하게 닫을 수 없다
//     -- 그래서 이 파일은 TTL/자동 재claim을 아예 구현하지 않는다.
//   - 원인 불명 crash 뒤 자동 재실행 금지: claim이 성공한 채로 그 이후
//     단계(grant 발급/실행)가 죽으면, 이 모듈은 그 사실을 스스로 감지해
//     재시도하지 않는다 -- PAUSED로 남기고 사람이 판단해야 한다(§6
//     mutation #6). claimIntentTx 자체에는 retry 루프가 없다(정적으로
//     확인 가능 -- setTimeout/재귀 재시도 없음).
//   - 동기 spawn이 mutex를 worker 생명주기 동안 쥐는 결선(mutex를 잡은
//     채로 실 프로세스를 기동해 그 프로세스가 끝날 때까지 놓지 않는 설계)
//     은 3B 배선 문제다 -- 이 사이클은 실 spawn을 0건 수행하므로(admission
//     -core.mjs/grant-issuer.mjs 어디서도 spawnFn을 호출하지 않는다) 여기
//     들어올 여지가 없다. 3B가 실 어댑터를 결선할 때 이 mutex를 짧게
//     잡고 놓는 원칙을 지키지 않으면 이 파일의 mutex 자체가 병목/장애점이
//     된다는 점을 여기 명시해 둔다.

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

// 안정된 실행의도를 구성하는 축(coder-task.md §목표): 이슈 id, 역할, 원
// dispatch/seat 세대, stall episode, task 내용 세대, 재배달 세대. 필드명은
// 재량이지만 여섯 축 전부가 있어야 한다 -- 하나라도 빠지면 다른 stall/세대를
// 같은 의도로 오인할 수 있다(under-specification은 fail-closed 거부).
export const STABLE_INTENT_FIELDS = Object.freeze([
  "issueId",
  "role",
  "dispatchGeneration",
  "stallEpisodeId",
  "taskContentGeneration",
  "redeliveryGeneration",
]);

// computeStableIntentId: grant 생성 前 양쪽(예: 두 supervisor 후보)이 grant
// 없이도 동일하게 계산할 수 있는 순수 함수. auth-grant-ledger.mjs의
// ledgerRecordId와 동일 스타일(JSON.stringify(array) 해싱 -- NUL 바이트
// 구분자 아님, "ab"+"cd" 대 "a"+"bcd" concat 충돌 불가).
export function computeStableIntentId(fields) {
  const f = isPlainObject(fields) ? fields : {};
  const values = [];
  for (const key of STABLE_INTENT_FIELDS) {
    if (!isNonEmptyString(f[key])) {
      throw new TypeError(
        `stable-intent: fields.${key} must be a non-empty string`,
      );
    }
    values.push(f[key]);
  }
  return createHash("sha256")
    .update(JSON.stringify(values), "utf8")
    .digest("hex");
}

function intentRecordPath(intentDir, stableIntentId) {
  return join(intentDir, `intent-${stableIntentId}.claim.json`);
}

// P2-1 (review-1 반려): claim 레코드는 lifecycle 상태를 갖는다 -- claim
// 자체는 CLAIMED로 시작하고, grant-issuer.mjs가 실제 발급 성공/실패에 따라
// ISSUED/PAUSED로 전이시킨다(아래 updateIntentStatusTx). PAUSED는 "claim은
// 커밋됐지만 grant는 아직 발급되지 않았고, 원인 불명 실패가 있었다"는
// durable 표식이다 -- 사람이 확인하기 전엔 아무 것도 이 상태를 자동으로
// 되돌리지 않는다(resumeIntentAfterHumanAck만이 유일한 출구).
// HYK-171 사이클3B (§1/§3): RUNNING은 "launch acceptance"(기동 수락) --
// launch-seam.mjs가 ISSUED -> RUNNING으로만 전이시킨다(armed 값과 무관하게
// 이 전이 자체는 일어난다, 3B coder-task.md §1/§3). RUNNING은 "실 발사
// 됨"도 "완료"도 아니다 -- 완료 판정은 여전히 scripts/check/relay-
// handshake.mjs가 정본이고, 이 상태기계는 그 권위를 흉내내지 않는다.
export const INTENT_STATUS = Object.freeze({
  CLAIMED: "CLAIMED",
  ISSUED: "ISSUED",
  PAUSED: "PAUSED",
  RUNNING: "RUNNING",
});

function defaultMutexWrite(path, content) {
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
    writeFn: typeof d.writeFn === "function" ? d.writeFn : defaultMutexWrite,
  };
}

function underMutex(recordPath, stableIntentId, winner, at, deps, saveDeps) {
  let exists;
  try {
    exists = deps.existsFn(recordPath);
  } catch (err) {
    return {
      ok: false,
      claimed: false,
      reason: `stable-intent: existsFn threw (${errText(err)})`,
    };
  }
  if (exists) {
    let existingRecord = null;
    try {
      existingRecord = JSON.parse(deps.readFileFn(recordPath));
    } catch {
      // 감사 보조 정보일 뿐 -- 읽기 실패해도 duplicate 판정은 그대로 유지.
    }
    return {
      ok: false,
      claimed: false,
      duplicate: true,
      reason: `stable-intent: intent already claimed (record for ${stableIntentId})`,
      record: existingRecord,
    };
  }
  const record = {
    schema_version: 1,
    stable_intent_id: stableIntentId,
    winner: winner ?? null,
    claimed_at: at ?? null,
    status: INTENT_STATUS.CLAIMED,
  };
  const saved = saveStoreAtomic(recordPath, record, saveDeps);
  if (!saved.ok) {
    return {
      ok: false,
      claimed: false,
      reason: `stable-intent: fail-closed -- ${saved.reason}`,
    };
  }
  return { ok: true, claimed: true, record, path: recordPath };
}

// claimIntentTx({ intentDir, stableIntentId, winner, at }, opts) -> 전역
// 단일승자 claim. intentDir은 호출자의 trusted config에서만 온다(grant나
// 다른 unverified 입력에서 유도 금지, 위 헤더 주석 참고). winner는 감사용
// 페이로드(예: 어떤 jti/arm_id/grant_digest 후보가 이겼는지)이지 claim
// 유일성의 일부가 아니다 -- 유일성은 오직 stableIntentId 하나에 결속된다
// (그래서 같은 stableIntentId에 다른 jti/arm_id를 실어 재시도해도 두 번째는
// duplicate다 -- §6 mutation #1/#3의 정확한 계약).
export function claimIntentTx(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  const { intentDir, stableIntentId, winner, at } = inp;
  if (!isNonEmptyString(intentDir)) {
    return {
      ok: false,
      claimed: false,
      reason: "stable-intent: intentDir must be a non-empty string",
    };
  }
  if (!isNonEmptyString(stableIntentId)) {
    return {
      ok: false,
      claimed: false,
      reason: "stable-intent: stableIntentId must be a non-empty string",
    };
  }
  const deps = normalizeDeps(opts);
  const recordPath = intentRecordPath(intentDir, stableIntentId);

  const mtx = acquireArmMutex(intentDir, stableIntentId, deps);
  if (!mtx.ok) {
    return {
      ok: false,
      claimed: false,
      reason: mtx.reason,
      paused: mtx.paused === true,
    };
  }

  let result;
  try {
    result = underMutex(recordPath, stableIntentId, winner, at, deps, opts);
  } catch (err) {
    const rel = releaseArmMutex(mtx, deps);
    return {
      ok: false,
      claimed: false,
      reason: `stable-intent: transaction body threw (${errText(err)})`,
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

// ---- P2-1 lifecycle 전이 (claim 뒤·발급 前 crash를 durable하게 남기기) ----
function loadIntentRecord(recordPath, deps) {
  let exists;
  try {
    exists = deps.existsFn(recordPath);
  } catch (err) {
    return {
      ok: false,
      reason: `stable-intent: existsFn threw while loading record (${errText(err)})`,
    };
  }
  if (!exists) {
    return {
      ok: false,
      reason: `stable-intent: no claim record at '${recordPath}'`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(deps.readFileFn(recordPath));
  } catch (err) {
    return {
      ok: false,
      reason: `stable-intent: claim record unreadable/corrupt (${errText(err)})`,
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      reason: "stable-intent: claim record is not a JSON object",
    };
  }
  return { ok: true, record: parsed };
}

// updateIntentStatusTx: 같은 per-intent mutex 아래에서 read-modify-write로
// status를 전이한다. 현재 status가 expectedFrom과 정확히 일치할 때만
// 전이한다(그 외엔 fail-closed 거부) -- 그래서 임의 상태에서 임의 상태로
// 몰래 건너뛸 수 없다(예: PAUSED를 거치지 않고 CLAIMED->ISSUED를 두 번
// 반복하는 것도 여기서 막힌다).
function updateIntentStatusTx(input, expectedFrom, toStatus, extra, opts) {
  const inp = isPlainObject(input) ? input : {};
  const { intentDir, stableIntentId, at } = inp;
  if (!isNonEmptyString(intentDir) || !isNonEmptyString(stableIntentId)) {
    return {
      ok: false,
      reason:
        "stable-intent: intentDir/stableIntentId must be non-empty strings",
    };
  }
  const deps = normalizeDeps(opts);
  const recordPath = intentRecordPath(intentDir, stableIntentId);

  const mtx = acquireArmMutex(intentDir, stableIntentId, deps);
  if (!mtx.ok) {
    return { ok: false, reason: mtx.reason, paused: mtx.paused === true };
  }

  let result;
  try {
    const loaded = loadIntentRecord(recordPath, deps);
    if (!loaded.ok) {
      result = { ok: false, reason: loaded.reason };
    } else if (loaded.record.status !== expectedFrom) {
      result = {
        ok: false,
        reason: `stable-intent: cannot move ${stableIntentId} from '${loaded.record.status}' to '${toStatus}' (expected '${expectedFrom}')`,
      };
    } else {
      const next = {
        ...loaded.record,
        ...extra,
        status: toStatus,
        updated_at: at ?? null,
      };
      const saved = saveStoreAtomic(recordPath, next, opts);
      result = saved.ok
        ? { ok: true, record: next, path: recordPath }
        : {
            ok: false,
            reason: `stable-intent: fail-closed -- ${saved.reason}`,
          };
    }
  } catch (err) {
    const rel = releaseArmMutex(mtx, deps);
    return {
      ok: false,
      reason: `stable-intent: status transition threw (${errText(err)})`,
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

// markIntentIssued({ intentDir, stableIntentId, at }, opts): 실제 grant가
// 발급된 뒤에만 호출(grant-issuer.mjs). CLAIMED -> ISSUED만 허용.
export function markIntentIssued(input, opts) {
  return updateIntentStatusTx(
    input,
    INTENT_STATUS.CLAIMED,
    INTENT_STATUS.ISSUED,
    {},
    opts,
  );
}

// markIntentPaused({ intentDir, stableIntentId, at, reason }, opts): claim
// 커밋 뒤·발급 전 실패(crash/store 손상 등)에서 grant-issuer.mjs가 호출.
// CLAIMED -> PAUSED만 허용 -- 이미 ISSUED/PAUSED인 레코드는 건드리지 않는다
// (best-effort 감사 표식이지 발급 자체의 fail-closed 판정을 대신하지
// 않는다).
export function markIntentPaused(input, opts) {
  const { reason } = isPlainObject(input) ? input : {};
  return updateIntentStatusTx(
    input,
    INTENT_STATUS.CLAIMED,
    INTENT_STATUS.PAUSED,
    { pause_reason: reason ?? null, needs_human_ack: true },
    opts,
  );
}

// markIntentRunning({ intentDir, stableIntentId, at }, opts): HYK-171
// 사이클3B -- launch-seam.mjs가 launch acceptance(RUNNING receipt)를 성공
// 기록한 뒤(또는 그 직전, 구현 선택은 launch-seam.mjs 몫)에 호출한다.
// ISSUED -> RUNNING만 허용(updateIntentStatusTx 재사용 -- 새 잠금/원자저장
// 없음, markIntentIssued와 동일 패턴). 이미 RUNNING/PAUSED/CLAIMED인 레코드에
// 대한 재호출은 expectedFrom 불일치로 거부된다 -- 그래서 같은
// stableIntentId에 대해 이 전이가 두 번 성공하는 일은 구조적으로 없다
// (동시 supervisor exact-count의 근거 중 하나, coder-task.md §6 mutation #4).
export function markIntentRunning(input, opts) {
  return updateIntentStatusTx(
    input,
    INTENT_STATUS.ISSUED,
    INTENT_STATUS.RUNNING,
    {},
    opts,
  );
}

// resumeIntentAfterHumanAck({ intentDir, stableIntentId, humanResumeRef, at },
// opts): PAUSED 상태에서 나가는 유일한 문. humanResumeRef가 명시적
// non-empty 문자열이어야 하고(사람이 감사용으로 남기는 참조 -- 자동/타이머
// 생성 금지), 현재 status가 정확히 PAUSED일 때만 CLAIMED로 되돌린다. 이
// 함수를 거치지 않고는(즉 정상 issueSubGrant 재호출만으로는) 어떤 경로도
// PAUSED에서 벗어날 수 없다 -- claimIntentTx는 레코드가 이미 존재하면
// status와 무관하게 duplicate로 거부하기 때문이다.
export function resumeIntentAfterHumanAck(input, opts) {
  const { humanResumeRef } = isPlainObject(input) ? input : {};
  if (!isNonEmptyString(humanResumeRef)) {
    return {
      ok: false,
      reason:
        "stable-intent: resumeIntentAfterHumanAck requires a non-empty humanResumeRef",
    };
  }
  return updateIntentStatusTx(
    input,
    INTENT_STATUS.PAUSED,
    INTENT_STATUS.CLAIMED,
    { human_resume_ref: humanResumeRef, resumed_at: input?.at ?? null },
    opts,
  );
}
