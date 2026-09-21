import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// HYK-135 사이클1(coder-6 구조 전환): go-wait 무인 릴레이의 공통 arm/claim/receipt
// 상태기계 (설계확정-v1.md §1~§3 = 유일 정본, 재설계 금지).
//
// coder-1~5는 "사용 지점마다 검증"하는 구조라 매 라운드 새 fail-open 계열이 나왔고,
// per-task lock이 arm 공유 예산을 원자화하지 못했다(review-5 실측: 다른 task 2개가
// max_starts_total=1에서 둘 다 spawn). PM 수렴진단(pm-3)의 구조 전환을 그대로 구현:
//   I1 원자성  : 같은 arm_id의 모든 task claim은 단일 arm mutex + 최신 디스크 store 안에서
//                직렬화된다(다른 task도 예외 없음). => claimTx/startTx.
//   I2 선저장  : 원자 저장 성공 전 기동 권한 0.
//   I3 canonical-only: 권한·예산 판단은 decodeStore가 만든 immutable canonical 값만 사용.
//                외부 객체의 prototype/getter/iterator/.includes/.every/callback return 불신뢰.
//   I4 never-fail-open: raw 입력·의존 함수·오류 객체가 무엇을 내도 public 진입점은
//                uncaught throw 0 · spawn 0 · 필요 시 persisted disarm.
//   I5 안전 산술: 모든 상한·카운터는 Number.isSafeInteger && >=0, 증가 후에도 재확인.
//   I6 영속 분리: accepted(요청 수락)와 persist_required(안전 상태 저장)를 분리, commit은 후자를 따름.
//   I7 무자동복구: arm mutex/claim/store의 미완료·손상 흔적은 자동 삭제·재소비 금지 → PAUSED/사람.
//
// 신뢰 경계 표기: JSON-reachable malformed(null/배열·객체·문자열·숫자 범위)는 decodeStore가
// 거부한다. JS test-seam(getter throw·Symbol·상속 객체·own method 변조·null callback)은
// 생산 진입(claimTx/startTx=디스크 JSON)로는 도달 불가하고, pure 함수 진입 시에도 decode의
// try/catch + deps 정규화가 uncaught throw 없이 거부한다.
//
// supervisor·엔진 어댑터·실 agent 기동은 사이클 2 몫(손대지 않음). 기동은 spawnFn 스텁.
// Tier: 로컬 스크립트 강제 -- 이 모듈을 안 거치고 직접 파일을 쓰면 막을 수 없다(HYK-89).

// ---- 상수 (단일 선언 C.7) ----
export const SCHEMA_VERSION = 1;

export const STATE = Object.freeze({
  ARMED: "ARMED",
  CLAIMED: "CLAIMED",
  RUNNING: "RUNNING",
  DONE: "DONE",
  QUESTION_PAUSED: "QUESTION_PAUSED",
  ERROR_PAUSED: "ERROR_PAUSED",
  DISARMED: "DISARMED",
});

export const DISARM_CAUSE = Object.freeze({
  COMPLETE: "complete",
  QUESTION: "question",
  ERROR: "error",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  ID_MISMATCH: "id_mismatch",
  STATE_CORRUPT: "state_corrupt",
  INCOMPLETE_CLAIM_RESTART: "incomplete_claim_restart",
  BUDGET_EXHAUSTED: "budget_exhausted",
});

const VALID_STATES = new Set(Object.values(STATE));

const ALLOWED_TRANSITIONS = {
  [STATE.ARMED]: [STATE.CLAIMED],
  [STATE.CLAIMED]: [STATE.RUNNING],
  [STATE.RUNNING]: [STATE.DONE, STATE.QUESTION_PAUSED, STATE.ERROR_PAUSED],
  [STATE.DONE]: [STATE.DISARMED],
  [STATE.QUESTION_PAUSED]: [STATE.DISARMED],
  [STATE.ERROR_PAUSED]: [STATE.DISARMED],
  [STATE.DISARMED]: [],
};

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

// ---- 값 프리미티브 (I3/I5) ----
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
// I5: safe integer(>=0)만. Number.isInteger는 MAX_SAFE_INTEGER+1을 허용하므로 부족.
function isSafeCount(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

// I4: err.message getter가 throw해도(오류 객체의 악성 getter) 절대 2차 throw 없이 문자열.
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

// R6-4 (safe I/O seam): fs 오류 객체의 `code` getter가 throw해도(예: marker write가
// 던진 악성 오류 객체) 2차 throw 없이 코드 문자열 또는 undefined를 돌려준다. marker/save
// 등 모든 I/O 분기가 `err.code`를 직접 읽는 대신 이 헬퍼를 쓴다(경로별 복붙 방지).
function safeErrCode(err) {
  try {
    return err && typeof err === "object" ? err.code : undefined;
  } catch {
    return undefined;
  }
}

function deepFreeze(o) {
  if (o && typeof o === "object" && !(o instanceof Set)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

// ---- 의존 함수 bag 정규화 (I3/I4, review-5 #3) ----
// 진입 시 1회. 부재(undefined)면 기본값, 존재하되 함수가 아니면(null 등) 거부.
// honesty (coder-2 §계약6-A, 선행리서치 D:\문서관리\하네스-관제실\PM\산출물\하네스\2026-07-14-hyk138-선행사례\리서치.md):
// 이 `wx`(O_EXCL) 배타 쓰기의 원자성은 **로컬 파일시스템 전제**다. NFS·클라우드 동기화 폴더
// (OneDrive 등)에서는 O_EXCL 원자성이 보장되지 않는다(proper-lockfile이 이 이유로 전 파일시스템에서
// 원자인 mkdir 전략을 쓰는 근거). 우리 배치는 로컬 고정 디스크라 현재 무해 — 원격/동기화 폴더로
// 이전 시 재검토 필요.
function defaultExclusiveWrite(path, content) {
  writeFileSync(path, content, { flag: "wx" });
}
function defaultRead(path) {
  return readFileSync(path, "utf8");
}
function pickDep(o, key, def) {
  return o[key] === undefined ? def : o[key];
}
function normalizeDeps(opts) {
  try {
    const o = isPlainObject(opts) ? opts : {};
    const deps = {
      dir: o.dir,
      nowFn: pickDep(o, "nowFn", () => Date.now()),
      existsFn: pickDep(o, "existsFn", existsSync),
      readFn: pickDep(o, "readFn", defaultRead),
      writeFn: pickDep(o, "writeFn", defaultExclusiveWrite),
      readFileFn: pickDep(o, "readFileFn", (p) => readFileSync(p, "utf8")),
      writeFileFn: pickDep(o, "writeFileFn", writeFileSync),
      renameFn: pickDep(o, "renameFn", renameSync),
      spawnFn: pickDep(o, "spawnFn", () => {}),
      spawnLogFn: pickDep(o, "spawnLogFn", () => {}),
      resultExistsFn: pickDep(o, "resultExistsFn", existsSync),
      readResultFn: pickDep(o, "readFileFn", (p) => readFileSync(p, "utf8")),
    };
    for (const k of ["nowFn", "existsFn", "readFn", "writeFn", "readFileFn", "writeFileFn", "renameFn", "spawnFn", "spawnLogFn", "resultExistsFn"]) {
      if (typeof deps[k] !== "function") return { ok: false, reason: `dependency '${k}' is not a function` };
    }
    return { ok: true, deps };
  } catch (e) {
    return { ok: false, reason: `normalizeDeps threw: ${errText(e)}` };
  }
}
// clock 반환이 finite safe integer가 아니면 fail-closed(만료 fail-open 차단, review-5 #3).
function safeNow(deps) {
  let v;
  try {
    v = deps.nowFn();
  } catch (e) {
    return { ok: false, reason: `nowFn threw: ${errText(e)}` };
  }
  if (!Number.isSafeInteger(v)) return { ok: false, reason: "nowFn returned a non-safe-integer" };
  return { ok: true, ms: v };
}

// ---- grant 검증 (설계 §2) -- createArmStore/계약용 standalone ----
export function validateGrant(grant) {
  if (!isPlainObject(grant)) return ["grant is not a plain object"];
  const problems = [];
  for (const f of ["arm_id", "cycle_id", "human_approval_ref", "issued_at", "expires_at"]) {
    if (!isNonEmptyString(grant[f])) problems.push(`'${f}' must be a non-empty string`);
  }
  for (const f of ["allowed_lanes", "allowed_task_ids"]) {
    if (copyStringArray(grant[f]) === null) problems.push(`'${f}' must be a non-empty array of non-empty strings`);
  }
  for (const f of ["max_starts_total", "max_starts_per_lane", "max_rejections"]) {
    if (!isSafeCount(grant[f])) problems.push(`'${f}' must be a non-negative safe integer`);
  }
  if (grant.publish_allowed !== false) problems.push("publish_allowed must be fixed false");
  if (grant.question_policy !== "pause") problems.push("question_policy must be 'pause'");
  if (grant.error_policy !== "pause") problems.push("error_policy must be 'pause'");
  return problems;
}

// 배열을 인덱스로만 복제(.includes/.every/iterator 불신뢰). 전부 non-empty string이고
// 비어있지 않으면 새 배열, 아니면 null.
function copyStringArray(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (let i = 0; i < v.length; i++) {
    if (!isNonEmptyString(v[i])) return null;
    out.push(v[i]);
  }
  return out.length > 0 ? out : null;
}

// ---- 단일 신뢰 경계: decodeStore (I3) ----
// raw(디스크 JSON 또는 in-memory)를 검증하고 own data field·타입·범위만 새 canonical로
// 복사·deep-freeze한다. 실패 시 corrupt. 전체를 try/catch로 감싸 throwing getter 등
// JS test-seam 값에도 uncaught throw 0(I4). 반환 canon은 결정용 Set/safe-int + 영속용
// JSON-safe persistable을 함께 담는다.
export function decodeStore(raw) {
  try {
    if (!isPlainObject(raw)) return { ok: false, reason: "store is not a plain object" };
    const problems = [];

    // R6-5 (a) root own-data: 핵심 필드가 raw의 own property가 아니면 거부한다.
    // Object.create(validStore)처럼 프로토타입 상속으로만 필드를 가진 객체는 신뢰
    // 경계를 통과하지 못한다(상속 값은 canonical에 복제하지 않는다).
    for (const rootKey of ["state", "grant", "claims", "attempts_total", "attempts_per_lane", "rejections", "receipts"]) {
      if (!Object.hasOwn(raw, rootKey)) problems.push(`root field '${rootKey}' is not an own property`);
    }
    if (problems.length) return { ok: false, reason: problems.join("; ") };

    const state = raw.state;
    if (typeof state !== "string" || !VALID_STATES.has(state)) problems.push(`state '${typeof state === "string" ? state : typeof state}' invalid`);

    let grantSafe = null;
    let lanes = null;
    let taskIds = null;
    const g = raw.grant;
    if (!isPlainObject(g)) {
      problems.push("grant is not a plain object");
    } else {
      const gp = validateGrant(g);
      if (gp.length) {
        for (const x of gp) problems.push(`grant.${x}`);
      } else {
        const lanesArr = copyStringArray(g.allowed_lanes);
        const taskArr = copyStringArray(g.allowed_task_ids);
        lanes = new Set(lanesArr);
        taskIds = new Set(taskArr);
        grantSafe = {
          arm_id: g.arm_id,
          cycle_id: g.cycle_id,
          human_approval_ref: g.human_approval_ref,
          issued_at: g.issued_at,
          expires_at: g.expires_at,
          allowed_lanes: lanesArr,
          allowed_task_ids: taskArr,
          max_starts_total: g.max_starts_total,
          max_starts_per_lane: g.max_starts_per_lane,
          max_rejections: g.max_rejections,
          publish_allowed: false,
          question_policy: "pause",
          error_policy: "pause",
        };
      }
    }

    if (!isSafeCount(raw.attempts_total)) problems.push("attempts_total is not a non-negative safe integer");
    if (!isSafeCount(raw.rejections)) problems.push("rejections is not a non-negative safe integer");

    let claimsSafe = null;
    if (!isPlainObject(raw.claims)) {
      problems.push("claims is not a plain object");
    } else {
      claimsSafe = Object.create(null);
      for (const k of Object.keys(raw.claims)) {
        const r = raw.claims[k];
        if (!isPlainObject(r) || !isNonEmptyString(r.attempt_id) || !isNonEmptyString(r.cycle_id) || !isNonEmptyString(r.content_hash)) {
          problems.push(`claims['${k}'] record is malformed`);
          break;
        }
        claimsSafe[k] = { attempt_id: r.attempt_id, cycle_id: r.cycle_id, content_hash: r.content_hash, claimed_at: typeof r.claimed_at === "string" ? r.claimed_at : null };
      }
    }

    let perLaneSafe = null;
    if (!isPlainObject(raw.attempts_per_lane)) {
      problems.push("attempts_per_lane is not a plain object");
    } else {
      perLaneSafe = Object.create(null);
      for (const k of Object.keys(raw.attempts_per_lane)) {
        const val = raw.attempts_per_lane[k];
        if (!isSafeCount(val)) {
          problems.push(`attempts_per_lane['${k}'] is not a non-negative safe integer`);
          break;
        }
        perLaneSafe[k] = val;
      }
    }

    let receiptsSafe = null;
    if (!Array.isArray(raw.receipts)) {
      problems.push("receipts is not an array");
    } else {
      receiptsSafe = [];
      for (let i = 0; i < raw.receipts.length; i++) receiptsSafe.push(raw.receipts[i]);
    }

    // R6-5 (b) semantic: state와 claims 내용이 모순이면 거부한다. ARMED는 아직 어떤
    // task도 담지 않았어야 하고(claims 비어야 함), CLAIMED/RUNNING은 진행 중인 claim
    // 레코드가 최소 1개 있어야 한다. (attempts_total 등 예산 카운터는 이 규칙과 무관 --
    // "예산은 이미 소진됐지만 claims는 비어있는 ARMED" 같은 합법 상태를 깨지 않는다.)
    if (claimsSafe !== null && (state === STATE.ARMED || state === STATE.CLAIMED || state === STATE.RUNNING)) {
      const claimCount = Object.keys(claimsSafe).length;
      if (state === STATE.ARMED && claimCount > 0) problems.push("ARMED store must not carry claim records");
      if ((state === STATE.CLAIMED || state === STATE.RUNNING) && claimCount === 0) problems.push(`${state} store must carry at least one claim record`);
    }

    if (problems.length) return { ok: false, reason: problems.join("; ") };

    const persistable = {
      schema_version: SCHEMA_VERSION,
      grant: grantSafe,
      state,
      claims: plainFromNullProto(claimsSafe),
      attempts_total: raw.attempts_total,
      attempts_per_lane: plainFromNullProto(perLaneSafe),
      rejections: raw.rejections,
      disarm_cause: typeof raw.disarm_cause === "string" ? raw.disarm_cause : null,
      disarmed_at: typeof raw.disarmed_at === "string" ? raw.disarmed_at : null,
      paused_label: typeof raw.paused_label === "string" ? raw.paused_label : null,
      needs_human_ack: raw.needs_human_ack === true,
      created_at: typeof raw.created_at === "string" ? raw.created_at : null,
      updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
      receipts: receiptsSafe,
    };
    const canon = {
      state,
      grant: { ...grantSafe, lanes, taskIds },
      claims: claimsSafe,
      attempts_total: raw.attempts_total,
      rejections: raw.rejections,
      attempts_per_lane: perLaneSafe,
      receipts: receiptsSafe,
      persistable,
    };
    deepFreeze(canon.persistable);
    Object.freeze(canon);
    return { ok: true, canon };
  } catch (e) {
    return { ok: false, reason: `decodeStore threw: ${errText(e)}` };
  }
}

function plainFromNullProto(m) {
  const out = {};
  for (const k of Object.keys(m)) out[k] = m[k];
  return out;
}

export function createArmStore(grant, opts) {
  const { at } = isPlainObject(opts) ? opts : {};
  const problems = validateGrant(grant);
  if (problems.length) return { ok: false, reason: `arm-state: invalid grant -- ${problems.join("; ")}` };
  return {
    ok: true,
    store: {
      schema_version: SCHEMA_VERSION,
      grant: {
        arm_id: grant.arm_id,
        cycle_id: grant.cycle_id,
        human_approval_ref: grant.human_approval_ref,
        issued_at: grant.issued_at,
        expires_at: grant.expires_at,
        allowed_lanes: copyStringArray(grant.allowed_lanes),
        allowed_task_ids: copyStringArray(grant.allowed_task_ids),
        max_starts_total: grant.max_starts_total,
        max_starts_per_lane: grant.max_starts_per_lane,
        max_rejections: grant.max_rejections,
        publish_allowed: false,
        question_policy: "pause",
        error_policy: "pause",
      },
      state: STATE.ARMED,
      claims: {},
      attempts_total: 0,
      attempts_per_lane: {},
      rejections: 0,
      disarm_cause: null,
      disarmed_at: null,
      paused_label: null,
      needs_human_ack: false,
      created_at: typeof at === "string" ? at : null,
      updated_at: typeof at === "string" ? at : null,
      receipts: [],
    },
  };
}

export function isExpired(grant, nowMs) {
  const exp = Date.parse(grant?.expires_at);
  if (Number.isNaN(exp) || !Number.isSafeInteger(nowMs)) return true; // fail-closed
  return nowMs > exp;
}

export function needsRestartRecovery(store) {
  return store?.state === STATE.CLAIMED || store?.state === STATE.RUNNING;
}

export function hashContent(text) {
  if (typeof text !== "string") throw new TypeError("arm-state: hashContent requires a string");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---- disarm 헬퍼: persistable(JSON-safe)에서 새 DISARMED store ----
function disarmFrom(persistable, at, cause) {
  return {
    ...persistable,
    state: STATE.DISARMED,
    disarm_cause: cause,
    disarmed_at: typeof at === "string" ? at : null,
    receipts: [...persistable.receipts, { at: at ?? null, event: "disarmed", cause }],
  };
}

// grant를 JSON-safe canonical 형태로 방어적 복제(throwing getter 무해화). 개별
// validateGrant를 통과하지 못하면 null(재구성 불가 grant).
function canonicalGrantOrNull(raw) {
  try {
    const g = raw?.grant;
    if (!isPlainObject(g) || validateGrant(g).length) return null;
    const lanes = copyStringArray(g.allowed_lanes);
    const tasks = copyStringArray(g.allowed_task_ids);
    if (!lanes || !tasks) return null;
    return {
      arm_id: g.arm_id,
      cycle_id: g.cycle_id,
      human_approval_ref: g.human_approval_ref,
      issued_at: g.issued_at,
      expires_at: g.expires_at,
      allowed_lanes: lanes,
      allowed_task_ids: tasks,
      max_starts_total: g.max_starts_total,
      max_starts_per_lane: g.max_starts_per_lane,
      max_rejections: g.max_rejections,
      publish_allowed: false,
      question_policy: "pause",
      error_policy: "pause",
    };
  } catch {
    return null;
  }
}
function safeReadCount(raw, key) {
  try {
    const v = raw?.[key];
    return isSafeCount(v) ? v : 0;
  } catch {
    return 0;
  }
}

// corrupt raw로부터 disarm store 구성(receipts가 안전한 배열일 때만 persist; I6·§3).
// HYK-137-review-1 국소 수리: 손상 필드를 **원형 복사하지 않고** decodeStore가 통과하는
// 최소 canonical 정상형으로 정규화한다(claims/per_lane -> {}, counters -> raw-safe-else-0,
// grant -> 방어적 canonical 복제). 손상 사실은 receipt(state_corrupt)에 남고, 상태 파일은
// 다음 트랜잭션이 재독·재사용할 수 있는 DISARMED가 된다("저장 성공=디스크 DISARMED 재독").
function buildCorruptResult(raw, at, reason, extra = {}) {
  let receipts = null;
  try {
    if (raw && typeof raw === "object" && Array.isArray(raw.receipts)) {
      receipts = [];
      for (let i = 0; i < raw.receipts.length; i++) receipts.push(raw.receipts[i]);
    }
  } catch {
    receipts = null;
  }
  const fullReason = `arm-state: STATE_CORRUPT -- ${reason}`;
  if (receipts === null) {
    // receipts 자체가 손상돼 안전 기록이 불가 -> 순수 거부(디스크 미변경).
    return { ok: false, persist_required: false, reloadable: false, reason: `${fullReason} (cannot record disarm; store refused)`, store: raw, ...extra };
  }
  receipts.push({ at: at ?? null, event: "disarmed", cause: DISARM_CAUSE.STATE_CORRUPT });
  const store = {
    schema_version: SCHEMA_VERSION,
    grant: canonicalGrantOrNull(raw),
    state: STATE.DISARMED,
    claims: {},
    attempts_total: safeReadCount(raw, "attempts_total"),
    attempts_per_lane: {},
    rejections: safeReadCount(raw, "rejections"),
    disarm_cause: DISARM_CAUSE.STATE_CORRUPT,
    disarmed_at: at ?? null,
    paused_label: null,
    needs_human_ack: true,
    created_at: null,
    updated_at: at ?? null,
    receipts,
  };
  // grant가 재구성 가능하면(claims:null류) decodeStore를 통과 = 재독 가능. grant 자체가
  // 손상이면 재독 불가(reloadable:false)지만 store는 여전히 JSON-safe(getter 없음)이고
  // receipt가 진실을 담는다 -- 재드롭 시 다시 corrupt-load로 idempotent disarm(fail-closed).
  const reloadable = decodeStore(store).ok;
  return { ok: false, persist_required: true, reloadable, reason: fullReason, store, ...extra };
}

// ---- 입력 경계: task (own-property strings only, I3/I4) ----
const REQUIRED_TASK_FIELDS = ["task_id", "cycle_id", "lane", "attempt_id", "content_hash", "at"];
function taskInputProblems(task) {
  if (!isPlainObject(task)) return ["task is not a plain object"];
  const p = [];
  for (const f of REQUIRED_TASK_FIELDS) {
    if (!Object.hasOwn(task, f) || !isNonEmptyString(task[f])) p.push(`task.${f} must be an own non-empty string`);
  }
  return p;
}

// ---- claim marker (audit + 동일-task 중복 방지 보조; 예산 정본 아님) ----
function markerPath(dir, ident = {}) {
  const { arm_id, task_id } = ident;
  if (!isNonEmptyString(dir) || !isNonEmptyString(arm_id) || !isNonEmptyString(task_id)) return null;
  return join(dir, `claim-${arm_id}__${task_id}.lock.json`);
}
function startMarkerPath(dir, ident = {}) {
  const { arm_id, task_id, attempt_id } = ident;
  if (![dir, arm_id, task_id, attempt_id].every(isNonEmptyString)) return null;
  return join(dir, `start-${arm_id}__${task_id}__${attempt_id}.lock.json`);
}

export const MARKER_FIELDS = ["task_id", "cycle_id", "arm_id", "attempt_id", "content_hash"];
const CONTENT_IDENTITY_FIELDS = MARKER_FIELDS.filter((f) => f !== "attempt_id");

export function acquireClaimMarker(dir, ident, opts) {
  const { arm_id, task_id, cycle_id, attempt_id, content_hash, at } = isPlainObject(ident) ? ident : {};
  const o = isPlainObject(opts) ? opts : {};
  const writeFn = typeof o.writeFn === "function" ? o.writeFn : defaultExclusiveWrite;
  for (const [k, v] of Object.entries({ arm_id, task_id, cycle_id, attempt_id, content_hash })) {
    if (!isNonEmptyString(v)) return { ok: false, won: false, invalid_input: true, reason: `arm-state: acquireClaimMarker input rejected -- ${k}` };
  }
  const path = markerPath(dir, { arm_id, task_id });
  if (path === null) return { ok: false, won: false, invalid_input: true, reason: "arm-state: acquireClaimMarker input rejected -- dir" };
  const payload = JSON.stringify({ arm_id, task_id, cycle_id, attempt_id, content_hash, claimed_at: at });
  try {
    writeFn(path, payload);
    return { ok: true, won: true, path };
  } catch (err) {
    if (safeErrCode(err) !== "EEXIST") return { ok: false, won: false, reason: `arm-state: claim marker write failed (${errText(err)})` };
    const verified = verifyMarkerAgainstExpected(dir, { task_id, cycle_id, arm_id, attempt_id, content_hash }, CONTENT_IDENTITY_FIELDS, o);
    if (verified.ok) return { ok: false, won: false, duplicate: true, existing: verified.marker, reason: `arm-state: ${task_id} already claimed -- duplicate` };
    return { ok: false, won: false, corrupt: verified.corrupt, mismatch: verified.mismatch, reason: verified.reason };
  }
}

function acquireStartMarker(dir, ident, opts) {
  const { arm_id, task_id, attempt_id, at } = isPlainObject(ident) ? ident : {};
  const o = isPlainObject(opts) ? opts : {};
  const writeFn = typeof o.writeFn === "function" ? o.writeFn : defaultExclusiveWrite;
  for (const [k, v] of Object.entries({ arm_id, task_id, attempt_id })) {
    if (!isNonEmptyString(v)) return { ok: false, won: false, invalid_input: true, reason: `arm-state: acquireStartMarker input rejected -- ${k}` };
  }
  const path = startMarkerPath(dir, { arm_id, task_id, attempt_id });
  if (path === null) return { ok: false, won: false, invalid_input: true, reason: "arm-state: acquireStartMarker input rejected -- dir" };
  try {
    writeFn(path, JSON.stringify({ arm_id, task_id, attempt_id, started_at: at }));
    return { ok: true, won: true, path };
  } catch (err) {
    if (safeErrCode(err) !== "EEXIST") return { ok: false, won: false, reason: `arm-state: start marker write failed (${errText(err)})` };
    return { ok: false, won: false, duplicate: true, reason: `arm-state: ${task_id} attempt ${attempt_id} already started -- duplicate` };
  }
}

// marker 값 비교: 구조(5요소 present·string) 후 값. dir/식별자 null이면 corrupt.
function verifyMarkerAgainstExpected(dir, expected, fields, opts) {
  const o = isPlainObject(opts) ? opts : {};
  const existsFn = typeof o.existsFn === "function" ? o.existsFn : existsSync;
  const readFn = typeof o.readFn === "function" ? o.readFn : defaultRead;
  const path = markerPath(dir, { arm_id: expected.arm_id, task_id: expected.task_id });
  if (path === null) return { ok: false, corrupt: true, reason: "arm-state: STATE_CORRUPT -- invalid marker path" };
  if (!existsFn(path)) return { ok: false, corrupt: true, reason: `arm-state: STATE_CORRUPT -- claim marker '${path}' is missing` };
  let marker;
  try {
    marker = JSON.parse(readFn(path));
  } catch (err) {
    return { ok: false, corrupt: true, reason: `arm-state: STATE_CORRUPT -- claim marker unreadable (${errText(err)})` };
  }
  if (!isPlainObject(marker)) return { ok: false, corrupt: true, reason: "arm-state: STATE_CORRUPT -- marker is not a JSON object" };
  for (const f of MARKER_FIELDS) {
    if (!isNonEmptyString(marker[f])) return { ok: false, corrupt: true, reason: `arm-state: STATE_CORRUPT -- marker field '${f}' missing/not-a-string` };
  }
  for (const f of fields) {
    if (marker[f] !== expected[f]) return { ok: false, mismatch: true, marker, reason: `arm-state: ID_MISMATCH -- marker '${f}' ${JSON.stringify(marker[f])} != ${JSON.stringify(expected[f])}` };
  }
  return { ok: true, marker };
}

// verifyClaimBinding: canonical claims(own-property) + marker 5요소 결속.
export function verifyClaimBinding(store, sel, opts) {
  const dn = normalizeDeps(opts);
  if (!dn.ok) return { ok: false, corrupt: true, reason: `arm-state: ${dn.reason}` };
  const dec = decodeStore(store);
  if (!dec.ok) return { ok: false, corrupt: true, reason: `arm-state: STATE_CORRUPT -- ${dec.reason}` };
  const canon = dec.canon;
  const { dir, task_id, attempt_id } = isPlainObject(sel) ? sel : {};
  if (!isNonEmptyString(task_id) || !isNonEmptyString(attempt_id)) {
    return { ok: false, corrupt: true, reason: "arm-state: STATE_CORRUPT -- task_id/attempt_id must be non-empty strings" };
  }
  if (!Object.hasOwn(canon.claims, task_id)) return { ok: false, corrupt: true, reason: `arm-state: STATE_CORRUPT -- no own claim record for '${task_id}'` };
  const rec = canon.claims[task_id];
  if (rec.attempt_id !== attempt_id) return { ok: false, mismatch: true, reason: `arm-state: ID_MISMATCH -- attempt '${attempt_id}' != claimed '${rec.attempt_id}'` };
  const expected = { task_id, cycle_id: rec.cycle_id, arm_id: canon.grant.arm_id, attempt_id: rec.attempt_id, content_hash: rec.content_hash };
  const verified = verifyMarkerAgainstExpected(dir, expected, MARKER_FIELDS, { existsFn: dn.deps.existsFn, readFn: dn.deps.readFn });
  if (!verified.ok) return verified;
  return { ok: true, claimRecord: rec, marker: verified.marker };
}

// ---- pure claim (canonical 결정 + 동일-task marker). arm 공유 예산의 cross-task
// 원자성은 claimTx가 arm mutex+디스크 reload로 제공한다. ----
export function claim(store, task, opts) {
  const dn = normalizeDeps(opts);
  if (!dn.ok) return { ok: false, spawnAllowed: false, persist_required: false, reason: `arm-state: ${dn.reason}`, store };
  const deps = dn.deps;
  const dir = deps.dir;
  const at = isPlainObject(task) ? task.at : undefined;

  const dec = decodeStore(store);
  if (!dec.ok) return buildCorruptResult(store, at, dec.reason, { spawnAllowed: false });
  const canon = dec.canon;

  const tp = taskInputProblems(task);
  if (tp.length) return { ok: false, spawnAllowed: false, persist_required: false, reason: `arm-state: input rejected -- ${tp.join("; ")}`, store: canon.persistable };

  const grant = canon.grant;

  if (canon.state === STATE.DISARMED) {
    return { ok: false, spawnAllowed: false, persist_required: false, reason: `arm-state: claim refused -- already DISARMED (cause=${canon.persistable.disarm_cause})`, store: canon.persistable };
  }
  if (canon.state !== STATE.ARMED) {
    // 이 arm은 단일 트랙(ARMED->CLAIMED->...)이라 한 번에 한 task만 담는다. 진행 중인
    // arm에 **다른** task가 드롭되면 -- arm을 disarm하지 않고 순수 거부한다(진행 중인
    // 정당한 task가 끝날 수 있도록; 다른 task는 §4대로 새 arm이 필요). spawn 0.
    // 이 세분화가 없으면 두 번째 task 드롭이 arm을 죽여 admitted task의 start를 막는
    // liveness 손상 race가 생긴다(그래도 안전측이지만 불필요).
    if (!Object.hasOwn(canon.claims, task.task_id)) {
      return { ok: false, spawnAllowed: false, persist_required: false, reason: `arm-state: arm busy with another claim -- ${task.task_id} refused (single-track; needs a new arm)`, store: canon.persistable };
    }
    // 동일 task 재드롭: 결속 검사 후 same-content duplicate vs changed=disarm.
    const existing = canon.claims[task.task_id];
    const bound = verifyClaimBinding(canon.persistable, { dir, task_id: task.task_id, attempt_id: existing?.attempt_id }, opts);
    if (bound.corrupt) return { ok: false, spawnAllowed: false, persist_required: true, reason: bound.reason, store: disarmFrom(canon.persistable, at, DISARM_CAUSE.STATE_CORRUPT) };
    if (bound.mismatch) return { ok: false, spawnAllowed: false, persist_required: true, reason: bound.reason, store: disarmFrom(canon.persistable, at, DISARM_CAUSE.ID_MISMATCH) };
    if (task.content_hash !== bound.claimRecord.content_hash || task.cycle_id !== bound.claimRecord.cycle_id) {
      return { ok: false, spawnAllowed: false, persist_required: true, reason: `arm-state: identity changed for ${task.task_id} mid-flight`, store: disarmFrom(canon.persistable, at, DISARM_CAUSE.ID_MISMATCH) };
    }
    return { ok: false, spawnAllowed: false, persist_required: false, reason: `arm-state: ${task.task_id} already claimed -- duplicate`, store: canon.persistable };
  }

  const now = safeNow(deps);
  if (!now.ok) return { ok: false, spawnAllowed: false, persist_required: true, reason: `arm-state: clock invalid (${now.reason})`, store: disarmFrom(canon.persistable, at, DISARM_CAUSE.ERROR) };
  if (isExpired(grant, now.ms)) {
    return { ok: false, spawnAllowed: false, persist_required: true, reason: "arm-state: claim refused -- grant expired", store: disarmFrom(canon.persistable, at, DISARM_CAUSE.EXPIRED) };
  }
  // identity: 정확 일치(내부 Set), 부분문자열/tampered .includes 불가.
  if (task.cycle_id !== grant.cycle_id || !grant.lanes.has(task.lane) || !grant.taskIds.has(task.task_id)) {
    return { ok: false, spawnAllowed: false, persist_required: true, reason: `arm-state: claim refused -- cycle/lane/task mismatch`, store: disarmFrom(canon.persistable, at, DISARM_CAUSE.ID_MISMATCH) };
  }
  // budget (I5: safe int, 증가 후 재확인).
  const laneUsed = canon.attempts_per_lane[task.lane] ?? 0;
  const newTotal = canon.attempts_total + 1;
  const newLane = laneUsed + 1;
  if (
    canon.attempts_total >= grant.max_starts_total ||
    laneUsed >= grant.max_starts_per_lane ||
    (canon.attempts_total > 0 && canon.rejections >= grant.max_rejections)
  ) {
    return { ok: false, spawnAllowed: false, persist_required: true, reason: "arm-state: claim refused -- budget exhausted", store: disarmFrom(canon.persistable, at, DISARM_CAUSE.BUDGET_EXHAUSTED) };
  }
  if (!isSafeCount(newTotal) || !isSafeCount(newLane)) {
    return { ok: false, spawnAllowed: false, persist_required: true, reason: "arm-state: claim refused -- counter would exceed safe-integer range", store: disarmFrom(canon.persistable, at, DISARM_CAUSE.STATE_CORRUPT) };
  }

  const marker = acquireClaimMarker(dir, { arm_id: grant.arm_id, task_id: task.task_id, cycle_id: task.cycle_id, attempt_id: task.attempt_id, content_hash: task.content_hash, at }, { writeFn: deps.writeFn, readFn: deps.readFn, existsFn: deps.existsFn });
  if (marker.corrupt) return { ok: false, spawnAllowed: false, persist_required: true, reason: marker.reason, store: disarmFrom(canon.persistable, at, DISARM_CAUSE.STATE_CORRUPT) };
  if (marker.mismatch) return { ok: false, spawnAllowed: false, persist_required: true, reason: marker.reason, store: disarmFrom(canon.persistable, at, DISARM_CAUSE.ID_MISMATCH) };
  if (marker.duplicate) return { ok: false, spawnAllowed: false, persist_required: false, reason: marker.reason, store: canon.persistable };
  if (!marker.won) return { ok: false, spawnAllowed: false, persist_required: false, reason: marker.reason ?? "arm-state: claim marker acquisition failed", store: canon.persistable };

  const next = {
    ...canon.persistable,
    state: STATE.CLAIMED,
    claims: { ...canon.persistable.claims, [task.task_id]: { attempt_id: task.attempt_id, content_hash: task.content_hash, cycle_id: task.cycle_id, claimed_at: at ?? null } },
    attempts_total: newTotal,
    attempts_per_lane: { ...canon.persistable.attempts_per_lane, [task.lane]: newLane },
    receipts: [...canon.persistable.receipts, { at: at ?? null, event: "claimed", task_id: task.task_id, attempt_id: task.attempt_id }],
    updated_at: at ?? null,
  };
  return { ok: true, spawnAllowed: true, persist_required: true, store: next };
}

// ---- pure start (CLAIMED -> RUNNING) ----
const OUTCOME_TARGET_STATE = {
  done: STATE.DONE,
  question: STATE.QUESTION_PAUSED,
  error: STATE.ERROR_PAUSED,
  cli_abnormal_exit: STATE.ERROR_PAUSED,
  startup_failure: STATE.ERROR_PAUSED,
  rejected: STATE.ERROR_PAUSED,
};
const OUTCOME_DISARM_CAUSE = {
  done: DISARM_CAUSE.COMPLETE,
  question: DISARM_CAUSE.QUESTION,
  error: DISARM_CAUSE.ERROR,
  cli_abnormal_exit: DISARM_CAUSE.ERROR,
  startup_failure: DISARM_CAUSE.ERROR,
  rejected: DISARM_CAUSE.ERROR,
};

// coder-1 (HYK-139 G3): CLAIMED->RUNNING 전이까지의 순수 검증·마커획득·TOCTOU 재확인을
// spawnFn 호출과 분리한다. spawnFn은 여기서 절대 호출하지 않는다 -- startTx가 이 결과를
// **디스크에 저장한 후에만** spawn을 호출해 I2("선저장 후 정확 1회")를 만족시킨다
// (review-6 ①/R6-1: 이전엔 pure start()가 spawn까지 동기 수행한 뒤에야 caller가 저장했다 --
// 저장 실패 시에도 실제 spawn은 이미 발생해 있었다). start()는 direct-call(테스트 등, 디스크
// 저장 없이 순수 함수로만 쓰는 경우)을 위해 이 결과에 이어 spawn까지 동기 수행한다.
function beginRunning(store, opts) {
  const dn = normalizeDeps(opts);
  if (!dn.ok) return { ready: false, ok: false, persist_required: false, reason: `arm-state: ${dn.reason}`, store };
  const deps = dn.deps;
  const dir = deps.dir;
  const o = isPlainObject(opts) ? opts : {};
  const { task_id, attempt_id, at } = o;

  const dec = decodeStore(store);
  if (!dec.ok) return { ready: false, ...buildCorruptResult(store, at, dec.reason, { spawned: false }) };
  const canon = dec.canon;

  const bound = verifyClaimBinding(canon.persistable, { dir, task_id, attempt_id }, opts);
  if (!bound.ok) {
    if (bound.corrupt) return { ready: false, ok: false, persist_required: true, reason: bound.reason, store: disarmFrom(canon.persistable, at, DISARM_CAUSE.STATE_CORRUPT) };
    if (bound.mismatch) return { ready: false, ok: false, persist_required: true, reason: bound.reason, store: disarmFrom(canon.persistable, at, DISARM_CAUSE.ID_MISMATCH) };
    return { ready: false, ok: false, persist_required: false, reason: bound.reason, store: canon.persistable };
  }

  if (!canTransition(canon.state, STATE.RUNNING)) {
    return { ready: false, ok: false, persist_required: false, reason: `arm-state: illegal transition ${canon.state} -> RUNNING`, store: canon.persistable };
  }

  const sm = acquireStartMarker(dir, { arm_id: canon.grant.arm_id, task_id, attempt_id, at }, { writeFn: deps.writeFn });
  if (!sm.won) return { ready: false, ok: false, persist_required: false, reason: sm.reason, store: canon.persistable };

  // TOCTOU: spawn 직전 재검증(I3). marker 삭제/변조 시 spawn 0·disarm.
  const reverify = verifyClaimBinding(canon.persistable, { dir, task_id, attempt_id }, opts);
  if (!reverify.ok) {
    const cause = reverify.corrupt ? DISARM_CAUSE.STATE_CORRUPT : DISARM_CAUSE.ID_MISMATCH;
    return { ready: false, ok: false, persist_required: true, reason: `arm-state: TOCTOU -- claim marker changed before spawn (${reverify.reason})`, store: disarmFrom(canon.persistable, at, cause) };
  }

  const running = { ...canon.persistable, state: STATE.RUNNING, updated_at: at ?? null, receipts: [...canon.persistable.receipts, { at: at ?? null, event: "running", task_id, attempt_id }] };
  return { ready: true, persist_required: true, store: running };
}

// spawnFn 호출 + throw 시 startup_failure disarm 구성(저장은 caller 책임 -- start()는 즉시
// 반환값에 담고, startTx는 별도 원자 저장을 한 번 더 수행한다).
function runSpawn(running, deps, { task_id, attempt_id, at, dir }) {
  try {
    deps.spawnFn({ task_id, attempt_id });
  } catch (err) {
    const failed = finishAttempt(running, { task_id, attempt_id, at, outcome: "startup_failure", dir, readFn: deps.readFn, existsFn: deps.existsFn, detail: { error: errText(err) } });
    let finalStore = failed.store;
    if (!isPlainObject(finalStore) || finalStore.state !== STATE.DISARMED) {
      finalStore = disarmFrom(running, at, DISARM_CAUSE.ERROR);
      finalStore = { ...finalStore, receipts: [...finalStore.receipts, { at: at ?? null, event: "fail_closed_fallback", detail: { spawn_error: errText(err), finish_reason: failed?.reason ?? null } }] };
    }
    return { ok: false, spawned: false, persist_required: true, reason: `arm-state: spawnFn threw -- startup_failure (${errText(err)})`, store: finalStore };
  }
  return { ok: true, spawned: true, persist_required: true, store: running };
}

export function start(store, opts) {
  const begun = beginRunning(store, opts);
  if (!begun.ready) return { ok: begun.ok === true, spawned: false, persist_required: begun.persist_required, reason: begun.reason, store: begun.store };
  const dn = normalizeDeps(opts); // already validated by beginRunning
  const deps = dn.deps;
  const dir = deps.dir;
  const o = isPlainObject(opts) ? opts : {};
  const { task_id, attempt_id, at } = o;
  return runSpawn(begun.store, deps, { task_id, attempt_id, at, dir });
}

export function finishAttempt(store, opts) {
  const dn = normalizeDeps(opts);
  if (!dn.ok) return { ok: false, persist_required: false, reason: `arm-state: ${dn.reason}`, store };
  const deps = dn.deps;
  const dir = deps.dir;
  const o = isPlainObject(opts) ? opts : {};
  const { task_id, attempt_id, at, outcome, detail } = o;

  const dec = decodeStore(store);
  if (!dec.ok) return buildCorruptResult(store, at, dec.reason);
  const canon = dec.canon;

  const bound = verifyClaimBinding(canon.persistable, { dir, task_id, attempt_id }, opts);
  if (!bound.ok) {
    if (bound.corrupt) return { ok: false, persist_required: true, reason: bound.reason, store: disarmFrom(canon.persistable, at, DISARM_CAUSE.STATE_CORRUPT) };
    if (bound.mismatch) return { ok: false, persist_required: true, reason: bound.reason, store: disarmFrom(canon.persistable, at, DISARM_CAUSE.ID_MISMATCH) };
    return { ok: false, persist_required: false, reason: bound.reason, store: canon.persistable };
  }

  const target = OUTCOME_TARGET_STATE[outcome];
  if (!target) return { ok: false, persist_required: false, reason: `arm-state: unknown outcome '${outcome}'`, store: canon.persistable };
  if (!canTransition(canon.state, target)) return { ok: false, persist_required: false, reason: `arm-state: illegal transition ${canon.state} -> ${target}`, store: canon.persistable };

  const newRejections = outcome === "rejected" ? canon.rejections + 1 : canon.rejections;
  if (!isSafeCount(newRejections)) return { ok: false, persist_required: true, reason: "arm-state: rejections would exceed safe-integer range", store: disarmFrom(canon.persistable, at, DISARM_CAUSE.STATE_CORRUPT) };

  const cause = OUTCOME_DISARM_CAUSE[outcome];
  const withOutcome = {
    ...canon.persistable,
    state: target,
    rejections: newRejections,
    receipts: [...canon.persistable.receipts, { at: at ?? null, event: outcome, task_id, attempt_id, detail: detail ?? null }],
  };
  const final = {
    ...withOutcome,
    state: STATE.DISARMED,
    disarm_cause: cause,
    disarmed_at: at ?? null,
    paused_label: outcome === "question" ? "QUESTION_PAUSED" : outcome === "error" ? "ERROR_PAUSED" : null,
    updated_at: at ?? null,
    receipts: [...withOutcome.receipts, { at: at ?? null, event: "disarmed", cause }],
  };
  return { ok: true, persist_required: true, store: final };
}

// ---- question answer correlation (HYK-140 4B, 리서치 §2-2: Correlation Identifier +
// idempotency "이미 소비됨"). 3중 키(task_id+attempt_id+question_id) 전부 일치해야
// correlate되고, 일치한 답은 1회만 소비된다(재적용 거부). attempt_id가 키에 포함되므로
// 이전 attempt의 답(stale)은 구조적으로 매칭되는 "question" receipt가 없어 거부된다.
// 계약2(리서치 §2-2): 상관 성공해도 이 함수는 상태를 바꾸지 않는다(여전히 DISARMED) --
// 재개는 새 arm에서만, 이 함수는 "답이 도착·상관됐다"는 사실만 receipt로 남긴다.
function questionAnswerInputProblems(answer) {
  if (!isPlainObject(answer)) return ["answer is not a plain object"];
  const p = [];
  for (const f of ["task_id", "attempt_id", "question_id"]) {
    if (!Object.hasOwn(answer, f) || !isNonEmptyString(answer[f])) p.push(`answer.${f} must be an own non-empty string`);
  }
  return p;
}

// receipts를 뒤에서부터 순회(최신 우선), own-property 값만 비교(I3 -- .find/.some 대신
// 인덱스 루프로 iterator/getter 신뢰 안 함).
function findReceiptMatch(receipts, event, task_id, attempt_id, question_id) {
  if (!Array.isArray(receipts)) return null;
  for (let i = receipts.length - 1; i >= 0; i--) {
    const r = receipts[i];
    if (!isPlainObject(r)) continue;
    if (r.event !== event || r.task_id !== task_id || r.attempt_id !== attempt_id) continue;
    if (event === "question_answered") {
      if (r.question_id === question_id) return r;
    } else if (isPlainObject(r.detail) && r.detail.question_id === question_id) {
      return r;
    }
  }
  return null;
}

export function correlateQuestionAnswer(store, answer, opts) {
  const o = isPlainObject(opts) ? opts : {};
  const { at } = o;
  const dec = decodeStore(store);
  if (!dec.ok) return buildCorruptResult(store, at, dec.reason, { consumed: false });
  const canon = dec.canon;

  const ap = questionAnswerInputProblems(answer);
  if (ap.length) return { ok: false, persist_required: false, consumed: false, reason: `arm-state: correlateQuestionAnswer input rejected -- ${ap.join("; ")}`, store: canon.persistable };

  const { task_id, attempt_id, question_id } = answer;

  // review-2 (HYK-140-coder-3 국소 수리): disarm_cause=QUESTION만으로는 불충분하다 --
  // decodeStore는 state/disarm_cause 조합을 semantic corruption으로 거부하지 않으므로
  // (그룹1 소유, 수정 금지) 위조된 ARMED store에 question cause+일치 receipt만 붙이면
  // 계약3-ⓓ(상관 성공 후에도 DISARMED 유지)를 어기고 답이 소비될 수 있었다(review-2 직접
  // 재현: ARMED+question cause -> ok:true·consumed:true·state:ARMED). state===DISARMED를
  // 소비층(correlate)에서 직접 요구해 이 공격 경로를 닫는다 -- decoder 보강은 표면 밖(관찰).
  if (canon.persistable.state !== STATE.DISARMED || canon.persistable.disarm_cause !== DISARM_CAUSE.QUESTION) {
    return { ok: false, persist_required: false, consumed: false, reason: "arm-state: correlateQuestionAnswer refused -- arm is not in a QUESTION disarm state", store: canon.persistable };
  }

  if (findReceiptMatch(canon.persistable.receipts, "question_answered", task_id, attempt_id, question_id)) {
    return { ok: false, persist_required: false, consumed: false, reason: "arm-state: correlateQuestionAnswer refused -- answer already consumed (one-time correlation)", store: canon.persistable };
  }

  if (!findReceiptMatch(canon.persistable.receipts, "question", task_id, attempt_id, question_id)) {
    return { ok: false, persist_required: false, consumed: false, reason: "arm-state: correlateQuestionAnswer refused -- no matching question receipt for task_id/attempt_id/question_id (stale or unknown answer)", store: canon.persistable };
  }

  const next = {
    ...canon.persistable,
    receipts: [...canon.persistable.receipts, { at: at ?? null, event: "question_answered", task_id, attempt_id, question_id }],
  };
  return { ok: true, persist_required: true, consumed: true, reason: null, store: next };
}

export function cancel(store, opts) {
  const dn = normalizeDeps(opts);
  if (!dn.ok) return { ok: false, persist_required: false, reason: `arm-state: ${dn.reason}`, store };
  const o = isPlainObject(opts) ? opts : {};
  const { at, reason = "cancelled" } = o;
  const dec = decodeStore(store);
  if (!dec.ok) return buildCorruptResult(store, at, dec.reason);
  const canon = dec.canon;
  if (canon.state === STATE.DISARMED) return { ok: false, persist_required: false, reason: "arm-state: already disarmed", store: canon.persistable };
  const store2 = { ...canon.persistable, state: STATE.DISARMED, disarm_cause: DISARM_CAUSE.CANCELLED, disarmed_at: at ?? null, updated_at: at ?? null, receipts: [...canon.persistable.receipts, { at: at ?? null, event: "cancelled", reason }] };
  return { ok: true, persist_required: true, store: store2 };
}

export function checkExpiry(store, nowFn, at) {
  const dn = normalizeDeps({ nowFn });
  if (!dn.ok) return { ok: false, persist_required: false, reason: `arm-state: ${dn.reason}`, store, expired: false };
  const dec = decodeStore(store);
  if (!dec.ok) return buildCorruptResult(store, at, dec.reason, { expired: false });
  const canon = dec.canon;
  if (canon.state === STATE.DISARMED) return { ok: true, persist_required: false, store: canon.persistable, expired: false };
  const now = safeNow(dn.deps);
  if (!now.ok) return { ok: false, persist_required: true, reason: `arm-state: clock invalid (${now.reason})`, store: disarmFrom(canon.persistable, at, DISARM_CAUSE.ERROR), expired: false };
  if (!isExpired(canon.grant, now.ms)) return { ok: true, persist_required: false, store: canon.persistable, expired: false };
  return { ok: true, persist_required: true, store: disarmFrom(canon.persistable, at, DISARM_CAUSE.EXPIRED), expired: true };
}

export function recoverIncompleteClaim(store, opts) {
  const dn = normalizeDeps(opts);
  if (!dn.ok) return { ok: false, persist_required: false, reason: `arm-state: ${dn.reason}`, store };
  const deps = dn.deps;
  const dir = deps.dir;
  const o = isPlainObject(opts) ? opts : {};
  const { at, task_id, attempt_id, resultPath } = o;

  const dec = decodeStore(store);
  if (!dec.ok) return buildCorruptResult(store, at, dec.reason);
  const canon = dec.canon;

  if (!needsRestartRecovery(canon)) return { ok: false, persist_required: false, reason: `arm-state: recover called but state=${canon.state} is not an incomplete claim`, store: canon.persistable };

  const bound = verifyClaimBinding(canon.persistable, { dir, task_id, attempt_id }, opts);
  if (!bound.ok) {
    deps.spawnLogFn({ event: "restart_recovery_no_spawn", state: canon.state, binding_failed: true });
    const cause = bound.corrupt ? DISARM_CAUSE.STATE_CORRUPT : DISARM_CAUSE.ID_MISMATCH;
    return { ok: false, persist_required: true, reason: bound.reason, store: disarmFrom(canon.persistable, at, cause) };
  }

  deps.spawnLogFn({ event: "restart_recovery_no_spawn", state: canon.state });
  let resultHash = null;
  try {
    if (isNonEmptyString(resultPath) && deps.resultExistsFn(resultPath)) resultHash = hashContent(deps.readResultFn(resultPath));
  } catch (e) {
    resultHash = null; // best-effort; recovery still proceeds
  }
  const next = {
    ...canon.persistable,
    state: STATE.DISARMED,
    disarm_cause: DISARM_CAUSE.INCOMPLETE_CLAIM_RESTART,
    disarmed_at: at ?? null,
    paused_label: "PAUSED",
    needs_human_ack: true,
    updated_at: at ?? null,
    receipts: [...canon.persistable.receipts, { at: at ?? null, event: "restart_recovery", from_state: canon.state, needs_human_ack: true, result_hash_at_recovery: resultHash }],
  };
  return { ok: true, persist_required: true, store: next };
}

// ---- 영속화 ----
// honesty (coder-2 §계약6-B): write(tmp)->rename은 이름공간 원자성만 준다 -- fsync 호출이
// 없어 **전원단절급 크래시 내구성은 미보장**(디스크 반영 전 전원 끊기면 rename 이전 상태로
// 되돌아갈 수 있음). 프로세스 크래시(kill -9 등, 파일시스템 자체는 살아있는 경우)까지는
// rename의 이름공간 원자성으로 보장. fsync 추가는 이번 그룹 표면 밖 — 필요성 판단은 리뷰어 몫.
export function saveStoreAtomic(path, store, opts) {
  const o = isPlainObject(opts) ? opts : {};
  const writeFileFn = typeof o.writeFileFn === "function" ? o.writeFileFn : writeFileSync;
  const renameFn = typeof o.renameFn === "function" ? o.renameFn : renameSync;
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileFn(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
    renameFn(tmp, path);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `arm-state: atomic save failed for '${path}' (${errText(err)})` };
  }
}

// loadStore: 파일 읽기 + decodeStore(전체 스키마) → canonical persistable(JSON-safe) 반환.
export function loadStore(path, opts) {
  const o = isPlainObject(opts) ? opts : {};
  const readFileFn = typeof o.readFileFn === "function" ? o.readFileFn : (p) => readFileSync(p, "utf8");
  const existsFn = typeof o.existsFn === "function" ? o.existsFn : existsSync;
  // R6-4 (safe seam): an existsFn that throws must NOT escape loadStore -- a thrown
  // existence probe is fail-closed STATE_CORRUPT, not an uncaught crash out of the seam.
  let exists;
  try {
    exists = existsFn(path);
  } catch (err) {
    return { ok: false, reason: `arm-state: STATE_CORRUPT -- existsFn threw for '${path}' (${errText(err)})` };
  }
  if (!exists) return { ok: true, existed: false, store: null };
  let raw;
  try {
    raw = readFileFn(path);
  } catch (err) {
    return { ok: false, reason: `arm-state: STATE_CORRUPT -- failed to read '${path}' (${errText(err)})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `arm-state: STATE_CORRUPT -- '${path}' is not valid JSON (${errText(err)})` };
  }
  const dec = decodeStore(parsed);
  if (!dec.ok) return { ok: false, reason: `arm-state: STATE_CORRUPT -- '${path}' ${dec.reason}`, raw: parsed };
  return { ok: true, existed: true, store: dec.canon.persistable };
}

// commit: I6 -- accepted가 아니어도 persist_required면 원자 저장. 저장 실패는 fail-closed.
export function commit(path, result, opts) {
  if (!result || (result.ok !== true && result.persist_required !== true)) return result;
  const saved = saveStoreAtomic(path, result.store, opts);
  if (!saved.ok) return { ok: false, persist_required: false, reason: `arm-state: fail-closed -- ${saved.reason} (transition discarded, on-disk unchanged)` };
  return result;
}

// ---- arm 단위 트랜잭션 (I1/I2/I7) ----
function armStorePathFn(dir, arm_id) {
  if (!isNonEmptyString(dir) || !isNonEmptyString(arm_id)) return null;
  return join(dir, `arm-${arm_id}.store.json`);
}
export function armStorePath(dir, arm_id) {
  return armStorePathFn(dir, arm_id);
}
function armMutexPath(dir, arm_id) {
  if (!isNonEmptyString(dir) || !isNonEmptyString(arm_id)) return null;
  return join(dir, `arm-${arm_id}.mutex.lock`);
}
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable: fall back to a bounded busy spin */
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}
// exclusive per-arm mutex. nonce로 자기 것만 해제(I7: 남의/손상 lock 자동 삭제 금지 → PAUSED).
// R6-6: mutex I/O의 오류 코드도 safeErrCode로 읽는다(getter-throw 무해화, 1A와 동일 계층).
export function acquireArmMutex(dir, arm_id, deps, maxWaitMs = 2000) {
  const path = armMutexPath(dir, arm_id);
  if (path === null) return { ok: false, reason: "arm-state: invalid dir/arm_id for mutex" };
  if (!isPlainObject(deps) || typeof deps.writeFn !== "function") return { ok: false, reason: "arm-state: mutex deps.writeFn is not a function" };
  const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const startWall = Date.now();
  for (;;) {
    try {
      deps.writeFn(path, nonce);
      return { ok: true, path, nonce };
    } catch (e) {
      if (safeErrCode(e) !== "EEXIST") return { ok: false, reason: `arm-state: mutex acquire failed (${errText(e)})` };
    }
    if (Date.now() - startWall > maxWaitMs) {
      return { ok: false, paused: true, reason: "arm-state: arm mutex wait timeout -- not force-deleting (I7); PAUSED/human" };
    }
    sleepMs(3);
  }
}
// R6-6 (mutex ownership): "read 후 unlink"의 비원자 창을 제거한다. 그 창에서 다른 프로세스가
// lock을 교체하면 이전 코드는 남의 nonce lock을 지웠다(review-6 ⑥). 대신:
//   ① lock 경로를 고유 tombstone으로 **원자 rename**(그 순간 경로에 있던 것을 배타적으로 확보)
//   ② tombstone의 nonce를 검사 -- 내 것이면 tombstone unlink(해제 완료)
//   ③ 내 것이 아니면(내 lock은 이미 교체된 상태) tombstone을 원래 경로로 **복원** rename,
//      복원마저 실패(다른 acquirer가 선점)하면 tombstone을 남기고 종료(삭제 0).
// unlink는 오직 "내 nonce를 담은 tombstone(내게 고유한 경로)"만 대상 -> 공유 lock 경로의
// 타 nonce lock을 지우는 일이 물리적으로 불가능하다. stale lock 자동 삭제도 0(경로가 없으면 no-op).
//
// coder-4 (review-4 국소): rename/read/unlink는 **주입 함수(deps)**를 실제 사용하고(오류 주입
// 가능), 모든 실패를 삼키지 않고 **관찰 가능한 반환값**(`{released, reason, lock_state}`)으로
// 드러낸다. 성공/실패 불명은 fail-closed(released:false) 쪽으로. 호출자(claimTx/startTx)는
// 이 반환을 보고 release 실패를 결과에 표기한다(조용한 은폐 제거).
export function releaseArmMutex(mtx, deps) {
  if (!mtx || !mtx.ok || !isNonEmptyString(mtx.path)) return { released: false, reason: "arm-state: invalid mutex handle", lock_state: "unknown" };
  const d = isPlainObject(deps) ? deps : {};
  const renameFn = typeof d.renameFn === "function" ? d.renameFn : renameSync;
  const readFn = typeof d.readFn === "function" ? d.readFn : defaultRead;
  const unlinkFn = typeof d.unlinkFn === "function" ? d.unlinkFn : unlinkSync;
  const tomb = `${mtx.path}.releasing-${process.pid}-${Math.random().toString(36).slice(2)}`;
  // ① atomic take
  try {
    renameFn(mtx.path, tomb);
  } catch (e) {
    if (safeErrCode(e) === "ENOENT") return { released: true, reason: "arm-state: lock path already absent", lock_state: "absent" };
    // real rename failure (EPERM/EXDEV/...) -> our lock is still at the canonical path.
    return { released: false, reason: `arm-state: mutex release rename failed (${errText(e)})`, lock_state: "survived" };
  }
  // ② read tombstone
  let content;
  try {
    content = readFn(tomb);
  } catch (e) {
    // couldn't read what we just moved -> ownership unknown. Try to restore, report fail-closed.
    try {
      renameFn(tomb, mtx.path);
    } catch {
      /* leave tombstone rather than lose it */
    }
    return { released: false, reason: `arm-state: mutex release read failed (${errText(e)})`, lock_state: "unknown" };
  }
  if (content === mtx.nonce) {
    try {
      unlinkFn(tomb); // our own lock -> release complete
      return { released: true, reason: "arm-state: released", lock_state: "removed" };
    } catch (e) {
      return { released: false, reason: `arm-state: mutex tombstone unlink failed (${errText(e)})`, lock_state: "orphan_tombstone" };
    }
  }
  // ③ not our nonce -> never delete it; put it back at the canonical path.
  try {
    renameFn(tomb, mtx.path);
    return { released: false, reason: "arm-state: lock replaced by another nonce; restored (not deleted)", lock_state: "foreign_restored" };
  } catch (e) {
    return { released: false, reason: `arm-state: could not restore foreign lock (${errText(e)}); tombstone left`, lock_state: "foreign_tombstone" };
  }
}

// release 결과를 트랜잭션 결과에 결속: 실패면 원 결과에 mutex_release_failed 표식을 얹는다
// (조용한 은폐 제거). 성공이면 원 결과 그대로.
function annotateRelease(result, rel) {
  if (rel && rel.released === false) {
    return { ...result, mutex_release_failed: true, mutex_release_reason: rel.reason, mutex_lock_state: rel.lock_state };
  }
  return result;
}

// claimTx: 같은 arm_id의 모든 task claim을 단일 mutex + 최신 디스크 store로 직렬화(I1).
// 저장 성공 전 spawnAllowed:true 반환 금지(I2). 정본=디스크 store(예산). marker=보조.
export function claimTx(dir, arm_id, rawTask, opts) {
  const dn = normalizeDeps({ ...(isPlainObject(opts) ? opts : {}), dir });
  if (!dn.ok) return { ok: false, spawnAllowed: false, reason: `arm-state: ${dn.reason}` };
  const deps = dn.deps;
  if (!isNonEmptyString(arm_id)) return { ok: false, spawnAllowed: false, reason: "arm-state: arm_id must be a non-empty string" };
  const tp = taskInputProblems(rawTask);
  if (tp.length) return { ok: false, spawnAllowed: false, reason: `arm-state: input rejected -- ${tp.join("; ")}` };
  const storePath = armStorePathFn(dir, arm_id);
  if (storePath === null) return { ok: false, spawnAllowed: false, reason: "arm-state: invalid dir/arm_id" };

  const mtx = acquireArmMutex(dir, arm_id, deps);
  if (!mtx.ok) return { ok: false, spawnAllowed: false, reason: mtx.reason, paused: mtx.paused === true };
  const underLock = () => {
    const loaded = loadStore(storePath, { readFileFn: deps.readFileFn, existsFn: deps.existsFn });
    if (!loaded.ok) {
      // R6-2: a corrupt on-disk store's disarm must be *checked* when persisted -- if the
      // save fails we must NOT report success/persisted; surface a fail-closed error that
      // says the disk remains corrupt (review-6 ②: unchecked saveStoreAtomic result).
      const corrupt = buildCorruptResult(loaded.raw, rawTask?.at, loaded.reason ?? "store corrupt", { spawnAllowed: false });
      if (corrupt.persist_required) {
        const saved = saveStoreAtomic(storePath, corrupt.store, deps);
        if (!saved.ok) {
          return { ok: false, spawnAllowed: false, persist_required: true, reason: `arm-state: fail-closed -- corrupt-load disarm could not be persisted (${saved.reason}); on-disk store remains corrupt`, store: corrupt.store };
        }
      }
      return corrupt;
    }
    if (!loaded.existed) return { ok: false, spawnAllowed: false, reason: "arm-state: no store on disk for this arm" };
    // R6-3 (path binding): the transaction's arm_id determines BOTH the store path
    // (arm-<arm_id>.store.json) and the mutex path. The decoded grant.arm_id must equal it,
    // else the store is mislocated (e.g. the same grant copied into another path to double-
    // spend the budget across paths) -> authority 0. (Full cross-path sum<=cap is group-2's
    // C6-PROP claim oracle; this layer only closes the path<->arm_id<->grant.arm_id binding.)
    if (loaded.store.grant.arm_id !== arm_id) {
      return { ok: false, spawnAllowed: false, reason: `arm-state: path binding mismatch -- store at arm '${arm_id}' carries grant.arm_id '${loaded.store.grant.arm_id}'` };
    }
    const result = claim(loaded.store, rawTask, { ...(isPlainObject(opts) ? opts : {}), dir });
    if (result.persist_required || result.ok) {
      const saved = saveStoreAtomic(storePath, result.store, deps);
      if (!saved.ok) return { ok: false, spawnAllowed: false, reason: `arm-state: fail-closed -- ${saved.reason}` };
    }
    // I2: spawnAllowed는 accepted && 저장 성공일 때만 유지된다(위에서 저장 실패 시 이미 반환).
    return result;
  };
  // coder-4 (review-4 국소): mutex release 실패를 성공 결과에 조용히 숨기지 않는다 --
  // 트랜잭션 본작업 결과에 release 결과를 결속해 실패를 표면화한다(I7 정합; 잔존 lock은
  // 다음 acquire가 timeout->PAUSED로 만난다).
  let result;
  try {
    result = underLock();
  } catch (e) {
    const rel = releaseArmMutex(mtx, deps);
    return annotateRelease({ ok: false, spawnAllowed: false, reason: `arm-state: transaction body threw (${errText(e)})` }, rel);
  }
  return annotateRelease(result, releaseArmMutex(mtx, deps));
}

// startTx: arm mutex + 최신 디스크 store로 RUNNING 전이·spawn을 직렬화(I1/I2).
export function startTx(dir, arm_id, sel, opts) {
  const dn = normalizeDeps({ ...(isPlainObject(opts) ? opts : {}), dir });
  if (!dn.ok) return { ok: false, spawned: false, reason: `arm-state: ${dn.reason}` };
  const deps = dn.deps;
  if (!isNonEmptyString(arm_id)) return { ok: false, spawned: false, reason: "arm-state: arm_id must be a non-empty string" };
  const storePath = armStorePathFn(dir, arm_id);
  if (storePath === null) return { ok: false, spawned: false, reason: "arm-state: invalid dir/arm_id" };
  const s = isPlainObject(sel) ? sel : {};

  const mtx = acquireArmMutex(dir, arm_id, deps);
  if (!mtx.ok) return { ok: false, spawned: false, reason: mtx.reason, paused: mtx.paused === true };
  const underLock = () => {
    const loaded = loadStore(storePath, { readFileFn: deps.readFileFn, existsFn: deps.existsFn });
    if (!loaded.ok) {
      // R6-2 (mirror of claimTx): checked persist of the corrupt-load disarm.
      const corrupt = buildCorruptResult(loaded.raw, s.at, loaded.reason ?? "store corrupt", { spawned: false });
      if (corrupt.persist_required) {
        const saved = saveStoreAtomic(storePath, corrupt.store, deps);
        if (!saved.ok) {
          return { ok: false, spawned: false, persist_required: true, reason: `arm-state: fail-closed -- corrupt-load disarm could not be persisted (${saved.reason}); on-disk store remains corrupt`, store: corrupt.store };
        }
      }
      return corrupt;
    }
    if (!loaded.existed) return { ok: false, spawned: false, reason: "arm-state: no store on disk for this arm" };
    // R6-3 (path binding), mirror of claimTx.
    if (loaded.store.grant.arm_id !== arm_id) {
      return { ok: false, spawned: false, reason: `arm-state: path binding mismatch -- store at arm '${arm_id}' carries grant.arm_id '${loaded.store.grant.arm_id}'` };
    }
    // R6-1 (review-6 ①, HYK-139 §계약1/2): beginRunning()은 spawnFn을 호출하지 않는다 --
    // RUNNING 전이+running receipt를 여기서 먼저 원자 저장하고, 그 저장이 성공한 "후에만"
    // spawn을 호출한다. 저장 실패 시 spawnFn은 호출조차 되지 않는다(위장 성공 0).
    const txOpts = { ...(isPlainObject(opts) ? opts : {}), ...s, dir };
    const begun = beginRunning(loaded.store, txOpts);
    if (!begun.ready) {
      if (begun.persist_required) {
        const saved = saveStoreAtomic(storePath, begun.store, deps);
        if (!saved.ok) return { ok: false, spawned: false, reason: `arm-state: fail-closed -- ${saved.reason}` };
      }
      return { ok: begun.ok === true, spawned: false, reason: begun.reason, store: begun.store };
    }
    const runningSaved = saveStoreAtomic(storePath, begun.store, deps);
    if (!runningSaved.ok) {
      return { ok: false, spawned: false, reason: `arm-state: fail-closed -- ${runningSaved.reason} (RUNNING not persisted, spawn not attempted)` };
    }
    // crash-window honesty (HYK-139 §계약3, 리서치 §3-2): 위 저장 성공과 아래 spawnFn 호출
    // 사이 crash 창이 원리상 존재한다 -- 그때 디스크는 RUNNING인데 실제 spawn은 0(orphan
    // RUNNING). 이 orphan의 복구(heartbeat/timeout 재클레임 등)는 그룹4(restart/복구) 소유 --
    // 여기서는 창의 존재만 정직 표기하고 복구 로직은 구현하지 않는다(표면 밖).
    const spawnResult = runSpawn(begun.store, deps, { task_id: s.task_id, attempt_id: s.attempt_id, at: s.at, dir });
    if (spawnResult.persist_required && !spawnResult.ok) {
      // spawn threw -> persist the startup_failure disarm as a second atomic save.
      const failSaved = saveStoreAtomic(storePath, spawnResult.store, deps);
      if (!failSaved.ok) return { ok: false, spawned: false, reason: `arm-state: fail-closed -- ${failSaved.reason}`, store: spawnResult.store };
    }
    return spawnResult;
  };
  let result;
  try {
    result = underLock();
  } catch (e) {
    const rel = releaseArmMutex(mtx, deps);
    return annotateRelease({ ok: false, spawned: false, reason: `arm-state: transaction body threw (${errText(e)})` }, rel);
  }
  return annotateRelease(result, releaseArmMutex(mtx, deps));
}

// coder-1 (HYK-140 G4A, review-6 ② 재적용): claimTx/startTx는 arm mutex + 최신 디스크
// store 아래에서 pure 함수를 호출하고 persist_required||ok일 때 반드시 saveStoreAtomic으로
// 저장한다. finishAttempt/cancel/checkExpiry에는 이 보장이 없었다 -- 호출자가 직접
// commit()/saveStoreAtomic을 잊지 않고 불러야만 disarm이 디스크에 남았고, 잊으면 반환
// store만 DISARMED이고 디스크엔 무영수증인 **phantom disarm**(그룹3 phantom spawn과 대칭)이
// 가능했다. 아래 세 Tx는 claimTx/startTx와 동일한 패턴(mutex+최신 로드+corrupt/경로 결속
// 재확인+저장 후에만 결과 확정)으로 모든 terminal 경로에 review-6 ②를 재적용한다.

// finishAttemptTx: RUNNING -> DONE/QUESTION_PAUSED/ERROR_PAUSED -> DISARMED 전이를
// arm mutex + 최신 디스크 store로 직렬화하고, disarm 결과를 실제로 저장한다.
export function finishAttemptTx(dir, arm_id, sel, opts) {
  const dn = normalizeDeps({ ...(isPlainObject(opts) ? opts : {}), dir });
  if (!dn.ok) return { ok: false, reason: `arm-state: ${dn.reason}` };
  const deps = dn.deps;
  if (!isNonEmptyString(arm_id)) return { ok: false, reason: "arm-state: arm_id must be a non-empty string" };
  const storePath = armStorePathFn(dir, arm_id);
  if (storePath === null) return { ok: false, reason: "arm-state: invalid dir/arm_id" };
  const s = isPlainObject(sel) ? sel : {};

  const mtx = acquireArmMutex(dir, arm_id, deps);
  if (!mtx.ok) return { ok: false, reason: mtx.reason, paused: mtx.paused === true };
  const underLock = () => {
    const loaded = loadStore(storePath, { readFileFn: deps.readFileFn, existsFn: deps.existsFn });
    if (!loaded.ok) {
      // R6-2 (mirror of claimTx/startTx): checked persist of the corrupt-load disarm.
      const corrupt = buildCorruptResult(loaded.raw, s.at, loaded.reason ?? "store corrupt");
      if (corrupt.persist_required) {
        const saved = saveStoreAtomic(storePath, corrupt.store, deps);
        if (!saved.ok) {
          return { ok: false, persist_required: true, reason: `arm-state: fail-closed -- corrupt-load disarm could not be persisted (${saved.reason}); on-disk store remains corrupt`, store: corrupt.store };
        }
      }
      return corrupt;
    }
    if (!loaded.existed) return { ok: false, reason: "arm-state: no store on disk for this arm" };
    // R6-3 (path binding), mirror of claimTx/startTx.
    if (loaded.store.grant.arm_id !== arm_id) {
      return { ok: false, reason: `arm-state: path binding mismatch -- store at arm '${arm_id}' carries grant.arm_id '${loaded.store.grant.arm_id}'` };
    }
    const result = finishAttempt(loaded.store, { ...(isPlainObject(opts) ? opts : {}), ...s, dir });
    // R6-7 (review-6 ② 재적용): terminal 결과가 disarm(ok:true 또는 persist_required)이면
    // 반드시 디스크에 저장 -- phantom disarm(반환만 DISARMED, 디스크 무영수증) 원천 차단.
    if (result.persist_required || result.ok) {
      const saved = saveStoreAtomic(storePath, result.store, deps);
      if (!saved.ok) return { ok: false, reason: `arm-state: fail-closed -- ${saved.reason}` };
    }
    return result;
  };
  let result;
  try {
    result = underLock();
  } catch (e) {
    const rel = releaseArmMutex(mtx, deps);
    return annotateRelease({ ok: false, reason: `arm-state: transaction body threw (${errText(e)})` }, rel);
  }
  return annotateRelease(result, releaseArmMutex(mtx, deps));
}

// cancelTx: 사람 취소를 arm mutex + 최신 디스크 store로 직렬화하고 실제 저장을 보장한다.
export function cancelTx(dir, arm_id, opts) {
  const dn = normalizeDeps({ ...(isPlainObject(opts) ? opts : {}), dir });
  if (!dn.ok) return { ok: false, reason: `arm-state: ${dn.reason}` };
  const deps = dn.deps;
  if (!isNonEmptyString(arm_id)) return { ok: false, reason: "arm-state: arm_id must be a non-empty string" };
  const storePath = armStorePathFn(dir, arm_id);
  if (storePath === null) return { ok: false, reason: "arm-state: invalid dir/arm_id" };
  const o = isPlainObject(opts) ? opts : {};

  const mtx = acquireArmMutex(dir, arm_id, deps);
  if (!mtx.ok) return { ok: false, reason: mtx.reason, paused: mtx.paused === true };
  const underLock = () => {
    const loaded = loadStore(storePath, { readFileFn: deps.readFileFn, existsFn: deps.existsFn });
    if (!loaded.ok) {
      const corrupt = buildCorruptResult(loaded.raw, o.at, loaded.reason ?? "store corrupt");
      if (corrupt.persist_required) {
        const saved = saveStoreAtomic(storePath, corrupt.store, deps);
        if (!saved.ok) {
          return { ok: false, persist_required: true, reason: `arm-state: fail-closed -- corrupt-load disarm could not be persisted (${saved.reason}); on-disk store remains corrupt`, store: corrupt.store };
        }
      }
      return corrupt;
    }
    if (!loaded.existed) return { ok: false, reason: "arm-state: no store on disk for this arm" };
    if (loaded.store.grant.arm_id !== arm_id) {
      return { ok: false, reason: `arm-state: path binding mismatch -- store at arm '${arm_id}' carries grant.arm_id '${loaded.store.grant.arm_id}'` };
    }
    const result = cancel(loaded.store, o);
    if (result.persist_required || result.ok) {
      const saved = saveStoreAtomic(storePath, result.store, deps);
      if (!saved.ok) return { ok: false, reason: `arm-state: fail-closed -- ${saved.reason}` };
    }
    return result;
  };
  let result;
  try {
    result = underLock();
  } catch (e) {
    const rel = releaseArmMutex(mtx, deps);
    return annotateRelease({ ok: false, reason: `arm-state: transaction body threw (${errText(e)})` }, rel);
  }
  return annotateRelease(result, releaseArmMutex(mtx, deps));
}

// checkExpiryTx: 만료 검사·disarm을 arm mutex + 최신 디스크 store로 직렬화하고 실제 저장을 보장한다.
export function checkExpiryTx(dir, arm_id, nowFn, at, opts) {
  const dn = normalizeDeps({ ...(isPlainObject(opts) ? opts : {}), dir });
  if (!dn.ok) return { ok: false, expired: false, reason: `arm-state: ${dn.reason}` };
  const deps = dn.deps;
  if (!isNonEmptyString(arm_id)) return { ok: false, expired: false, reason: "arm-state: arm_id must be a non-empty string" };
  const storePath = armStorePathFn(dir, arm_id);
  if (storePath === null) return { ok: false, expired: false, reason: "arm-state: invalid dir/arm_id" };

  const mtx = acquireArmMutex(dir, arm_id, deps);
  if (!mtx.ok) return { ok: false, expired: false, reason: mtx.reason, paused: mtx.paused === true };
  const underLock = () => {
    const loaded = loadStore(storePath, { readFileFn: deps.readFileFn, existsFn: deps.existsFn });
    if (!loaded.ok) {
      const corrupt = buildCorruptResult(loaded.raw, at, loaded.reason ?? "store corrupt", { expired: false });
      if (corrupt.persist_required) {
        const saved = saveStoreAtomic(storePath, corrupt.store, deps);
        if (!saved.ok) {
          return { ok: false, expired: false, persist_required: true, reason: `arm-state: fail-closed -- corrupt-load disarm could not be persisted (${saved.reason}); on-disk store remains corrupt`, store: corrupt.store };
        }
      }
      return corrupt;
    }
    if (!loaded.existed) return { ok: false, expired: false, reason: "arm-state: no store on disk for this arm" };
    if (loaded.store.grant.arm_id !== arm_id) {
      return { ok: false, expired: false, reason: `arm-state: path binding mismatch -- store at arm '${arm_id}' carries grant.arm_id '${loaded.store.grant.arm_id}'` };
    }
    const result = checkExpiry(loaded.store, nowFn, at);
    if (result.persist_required || result.ok) {
      const saved = saveStoreAtomic(storePath, result.store, deps);
      if (!saved.ok) return { ok: false, expired: false, reason: `arm-state: fail-closed -- ${saved.reason}` };
    }
    return result;
  };
  let result;
  try {
    result = underLock();
  } catch (e) {
    const rel = releaseArmMutex(mtx, deps);
    return annotateRelease({ ok: false, expired: false, reason: `arm-state: transaction body threw (${errText(e)})` }, rel);
  }
  return annotateRelease(result, releaseArmMutex(mtx, deps));
}

// recoverIncompleteClaimTx (HYK-140 4B): 그룹1 이래 recoverIncompleteClaim은 pure 함수로만
// 존재했고(4A 이전 어떤 그룹도 arm mutex+최신 디스크 reload로 직렬화하지 않음) -- 종결 Tx
// 3종과 동일하게 phantom disarm(반환만 DISARMED, 디스크 무영수증) 가능성이 있는 세 번째
// 후보였다(리서치 §2-4). finishAttemptTx/cancelTx/checkExpiryTx와 동일한 패턴(mutex+최신
// 로드+경로 결속 재확인+저장 후에만 결과 확정)으로 그 공백을 닫는다.
export function recoverIncompleteClaimTx(dir, arm_id, sel, opts) {
  const dn = normalizeDeps({ ...(isPlainObject(opts) ? opts : {}), dir });
  if (!dn.ok) return { ok: false, reason: `arm-state: ${dn.reason}` };
  const deps = dn.deps;
  if (!isNonEmptyString(arm_id)) return { ok: false, reason: "arm-state: arm_id must be a non-empty string" };
  const storePath = armStorePathFn(dir, arm_id);
  if (storePath === null) return { ok: false, reason: "arm-state: invalid dir/arm_id" };
  const s = isPlainObject(sel) ? sel : {};

  const mtx = acquireArmMutex(dir, arm_id, deps);
  if (!mtx.ok) return { ok: false, reason: mtx.reason, paused: mtx.paused === true };
  const underLock = () => {
    const loaded = loadStore(storePath, { readFileFn: deps.readFileFn, existsFn: deps.existsFn });
    if (!loaded.ok) {
      const corrupt = buildCorruptResult(loaded.raw, s.at, loaded.reason ?? "store corrupt");
      if (corrupt.persist_required) {
        const saved = saveStoreAtomic(storePath, corrupt.store, deps);
        if (!saved.ok) {
          return { ok: false, persist_required: true, reason: `arm-state: fail-closed -- corrupt-load disarm could not be persisted (${saved.reason}); on-disk store remains corrupt`, store: corrupt.store };
        }
      }
      return corrupt;
    }
    if (!loaded.existed) return { ok: false, reason: "arm-state: no store on disk for this arm" };
    if (loaded.store.grant.arm_id !== arm_id) {
      return { ok: false, reason: `arm-state: path binding mismatch -- store at arm '${arm_id}' carries grant.arm_id '${loaded.store.grant.arm_id}'` };
    }
    const result = recoverIncompleteClaim(loaded.store, { ...(isPlainObject(opts) ? opts : {}), ...s, dir });
    if (result.persist_required || result.ok) {
      const saved = saveStoreAtomic(storePath, result.store, deps);
      if (!saved.ok) return { ok: false, reason: `arm-state: fail-closed -- ${saved.reason}` };
    }
    return result;
  };
  let result;
  try {
    result = underLock();
  } catch (e) {
    const rel = releaseArmMutex(mtx, deps);
    return annotateRelease({ ok: false, reason: `arm-state: transaction body threw (${errText(e)})` }, rel);
  }
  return annotateRelease(result, releaseArmMutex(mtx, deps));
}

// correlateQuestionAnswerTx (HYK-140 4B): question 상관·1회 소비를 arm mutex + 최신 디스크
// store로 직렬화하고 실제 저장을 보장한다(계약4 -- 새 전이도 반드시 디스크 receipt).
export function correlateQuestionAnswerTx(dir, arm_id, answer, opts) {
  const dn = normalizeDeps({ ...(isPlainObject(opts) ? opts : {}), dir });
  if (!dn.ok) return { ok: false, consumed: false, reason: `arm-state: ${dn.reason}` };
  const deps = dn.deps;
  if (!isNonEmptyString(arm_id)) return { ok: false, consumed: false, reason: "arm-state: arm_id must be a non-empty string" };
  const storePath = armStorePathFn(dir, arm_id);
  if (storePath === null) return { ok: false, consumed: false, reason: "arm-state: invalid dir/arm_id" };
  const o = isPlainObject(opts) ? opts : {};

  const mtx = acquireArmMutex(dir, arm_id, deps);
  if (!mtx.ok) return { ok: false, consumed: false, reason: mtx.reason, paused: mtx.paused === true };
  const underLock = () => {
    const loaded = loadStore(storePath, { readFileFn: deps.readFileFn, existsFn: deps.existsFn });
    if (!loaded.ok) {
      const corrupt = buildCorruptResult(loaded.raw, o.at, loaded.reason ?? "store corrupt", { consumed: false });
      if (corrupt.persist_required) {
        const saved = saveStoreAtomic(storePath, corrupt.store, deps);
        if (!saved.ok) {
          return { ok: false, consumed: false, persist_required: true, reason: `arm-state: fail-closed -- corrupt-load disarm could not be persisted (${saved.reason}); on-disk store remains corrupt`, store: corrupt.store };
        }
      }
      return corrupt;
    }
    if (!loaded.existed) return { ok: false, consumed: false, reason: "arm-state: no store on disk for this arm" };
    if (loaded.store.grant.arm_id !== arm_id) {
      return { ok: false, consumed: false, reason: `arm-state: path binding mismatch -- store at arm '${arm_id}' carries grant.arm_id '${loaded.store.grant.arm_id}'` };
    }
    const result = correlateQuestionAnswer(loaded.store, answer, { at: o.at });
    if (result.persist_required || result.ok) {
      const saved = saveStoreAtomic(storePath, result.store, deps);
      if (!saved.ok) return { ok: false, consumed: false, reason: `arm-state: fail-closed -- ${saved.reason}` };
    }
    return result;
  };
  let result;
  try {
    result = underLock();
  } catch (e) {
    const rel = releaseArmMutex(mtx, deps);
    return annotateRelease({ ok: false, consumed: false, reason: `arm-state: transaction body threw (${errText(e)})` }, rel);
  }
  return annotateRelease(result, releaseArmMutex(mtx, deps));
}
