// HYK-171 사이클4b-2b-1 (coder-task.md §2-A) -- 좌석 대장(registry).
//
// 기록 시점 = 좌석 "생성 응답"을 받은 그 자리 -- 사후에 terminal list를
// 훑어 "그 워크트리에 있으니 우리 것"이라고 등록하지 않는다(PM Q4 반례:
// 사람이 직접 연 탭도 무해 참조로 잡혀 지워지는 사고를 막는다). 이 파일은
// 순수 상태 변환(normalizeSeatRecord/recordSeatCreation)과 fs 조회/쓰기
// 주입(loadRegistry/saveRegistry)만 갖는다 -- observer-store.mjs 전례를
// 따르되 재사용이 아니라 별도 store다(그 store는 advisory outbox 전용).
//
// 이 모듈은 orca/dispatch/teardown/worker input 호출을 절대 하지 않는다.
// teardownSeat/relayStep/dispatch 어느 프로덕션 진입점도 이 파일을
// import하지 않는다(coder-task.md §1 "결선 0" -- 판정·기록만, 프로덕션
// 호출자 0).

export const SCHEMA_VERSION = 1;

// 권위 응답 스키마가 경로마다 다르다(coder-task.md §2-A 실측: `terminal
// create`(--focus 없음)는 ptyId+paneKey를 주지만 --focus를 준 응답에는
// 둘 다 없었다. `worktree create` 응답에는 터미널 정보가 아예 없다). 결손
// 필드는 null로 정직하게 기록한다 -- 있는 척 채우지 않는다.
const RECORD_FIELDS = [
  "ptyId",
  "handle",
  "tabId",
  "leafId",
  "paneKey",
  "worktreeId",
  "worktreePath",
  "role",
  "taskId",
  "dispatchId",
  "capturedAt",
];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

export function createEmptyRegistry() {
  return { schemaVersion: SCHEMA_VERSION, seats: [] };
}

// REVIEW review-1 P1-2 (재확인, 2026-07-26): "생성 응답 객체 하나"라는
// 시그니처 모양만으로는 출처를 구분하지 못한다 -- terminal-list 행 하나를
// 그대로 넘겨도(예: `{ptyId, worktreeId, capturedAt}`) plain object라서
// 그냥 통과했다. 그래서 생성 경로에만 존재하는 구조적 표지를 요구한다:
// 2026-07-26 ORCH 실측(영수증 부록 F3)상 `terminal create`(--focus 없음)
// 응답에는 `paneKey`가 non-empty string으로 있고, `terminal list` 행에는
// 그 키 자체가 없다.
//
// REVIEW review-2 P1 (재확인, 2026-07-26): 키 존재만 보면(`hasOwnProperty`,
// 값은 안 봄) `{...terminalListRow, paneKey: undefined}` 같은 입력이 통과한다
// -- 의도적 위조가 아니라, 어댑터가 terminal-list 항목에서 필드를 뽑아
// `{ptyId: t.ptyId, worktreeId: t.worktreeId, paneKey: t.paneKey}`처럼
// 조립하면 `t.paneKey`가 undefined인 채로 **키만** 살아남는 현실적 오사용
// 경로다. 그러면 사람이 직접 연 탭이 우리 소유로 등록된다(PM Q4 반례
// 재현 -- 이 사이클이 막으려던 바로 그것). 그래서 마커는 이제 "키가
// 존재하는가"가 아니라 **"paneKey가 non-empty string 값을 가지는가"**로
// 판정한다 -- `--focus` create 응답(paneKey 키 자체 없음)과 terminal-list
// 행(키 없음 또는 undefined 값)은 여전히 등록 불가로 접히고, 정상
// `terminal create` 응답(paneKey가 실 문자열)만 통과한다.
function hasCreationProvenanceMarker(src) {
  return isPlainObject(src) && isNonEmptyString(src.paneKey);
}

// creationResponse: 좌석 생성 CLI 응답(권위 응답) 그 자체에서 뽑아낸 필드만
// 받는다 -- 조회를 하지 않는 순수 함수. 구조적 표지(paneKey가 non-empty
// string)가 없으면 출처를 신뢰할 수 없으므로 모든 필드가 null로 접힌다
// (배열이든 단일 plain object든, 값 없는 paneKey 키만 있는 위조든 동일하게
// 거부된다 -- 사후 수집 금지를 시그니처 모양이 아니라 이 표지로 강제한다).
export function normalizeSeatRecord(creationResponse = {}) {
  const src = hasCreationProvenanceMarker(creationResponse)
    ? creationResponse
    : {};
  const record = { schemaVersion: SCHEMA_VERSION };
  for (const field of RECORD_FIELDS) {
    const v = src[field];
    record[field] = typeof v === "string" && v.length > 0 ? v : null;
  }
  return record;
}

// 순수 append -- 이미 존재하는 ptyId라도 막지 않는다(중복 등록 감지/차단은
// seat-identity-core.mjs의 SEAT_REGISTRY_CONFLICT 판정 몫이다 -- 이 대장은
// "생성 응답을 있는 그대로 적재"만 하고, 정합성 판단은 판정 코어 층위에서
// 한다). 입력 registry는 변형하지 않는다(새 객체 반환).
export function recordSeatCreation(registry, creationResponse) {
  const base = isPlainObject(registry) ? registry : createEmptyRegistry();
  const record = normalizeSeatRecord(creationResponse);
  return {
    registry: {
      schemaVersion: SCHEMA_VERSION,
      seats: [...(Array.isArray(base.seats) ? base.seats : []), record],
    },
    record,
  };
}

// HYK-213-seat-ledger (coder-task.md §2, 두 번째 함정 회피): "판별 불가"를
// 없애는 유일하게 안전한 길은 추측이 아니라 기록이다. 이 함수는 좌석
// "생성" 응답이 아니라 "관측"(우리가 만들지 않았지만 이미 존재하는 것을
// terminal list에서 발견) 시점의 provenance를 기록한다 -- recordSeatCreation
// 과는 출처 자체가 다르므로 재사용하지 않는다(그 함수의
// hasCreationProvenanceMarker 게이트는 paneKey가 있는 "생성 응답"만
// 통과시키도록 의도적으로 설계돼 있다 -- 이 함수를 거기 억지로 태우면 그
// 게이트의 의미가 깨진다).
//
// 멱등: 같은 ptyId가 이미 정확히 1개 기록돼 있으면(role 무관) no-op으로
// 그 레코드를 그대로 반환한다 -- 재실행(재기동/재시도)이 같은 관측을
// 중복 기입해 findByPtyId를 "2개+ 매치"로 무너뜨리는 것을 막는다(그러면
// 이미 확정됐던 "워커 아님"이 다시 undetermined로 퇴행한다 -- 이 역시
// §2 두 번째 함정의 한 형태다). 이미 2개+로 오염돼 있으면 그 오염을
// 건드리지 않고 그대로 둔다(추가로 손대 상태를 더 애매하게 만들지
// 않는다).
export const NOT_WORKER_SEAT_ROLE = "NOT_WORKER_SEAT";

export function recordNonWorkerSeatObservation(registry, observation = {}) {
  const base = isPlainObject(registry) ? registry : createEmptyRegistry();
  const seats = Array.isArray(base.seats) ? base.seats : [];
  const obs = isPlainObject(observation) ? observation : {};
  if (!isNonEmptyString(obs.ptyId)) {
    return {
      ok: false,
      reason: "recordNonWorkerSeatObservation: observation.ptyId is required",
    };
  }
  const existing = seats.filter(
    (r) => isPlainObject(r) && r.ptyId === obs.ptyId,
  );
  if (existing.length > 0) {
    return { ok: true, registry: base, record: existing[0], skipped: true };
  }
  const record = {
    schemaVersion: SCHEMA_VERSION,
    ptyId: obs.ptyId,
    handle: isNonEmptyString(obs.handle) ? obs.handle : null,
    tabId: null,
    leafId: null,
    paneKey: null,
    worktreeId: null,
    worktreePath: isNonEmptyString(obs.worktreePath) ? obs.worktreePath : null,
    role: NOT_WORKER_SEAT_ROLE,
    taskId: null,
    dispatchId: null,
    capturedAt: isNonEmptyString(obs.capturedAt) ? obs.capturedAt : null,
    observationReason: isNonEmptyString(obs.observationReason)
      ? obs.observationReason
      : null,
  };
  return {
    ok: true,
    registry: {
      schemaVersion: SCHEMA_VERSION,
      seats: [...seats, record],
    },
    record,
    skipped: false,
  };
}

export function findByPtyId(registry, ptyId) {
  const base = isPlainObject(registry) ? registry : createEmptyRegistry();
  if (typeof ptyId !== "string" || ptyId.length === 0) return [];
  return (Array.isArray(base.seats) ? base.seats : []).filter(
    (r) => isPlainObject(r) && r.ptyId === ptyId,
  );
}

// HYK-171 사이클4b-2b-4 (coder-task.md §1-B) -- 배정(dispatch) 결속 기록.
//
// PM 4상태 전이(coder-task.md §1-B, ORCH-소비결론.md §3-2 그대로 구현):
//   1) 빈 배정 레코드 -> 새 runtime task/dispatch 결속 허용 (BOUND)
//   2) 같은 task/dispatch 재수신 -> 멱등 no-op (IDEMPOTENT_NOOP, 레코드/버전 불변)
//   3) 다른 task/dispatch + 이전 배정이 active 또는 상태 불명 -> INCARNATION_CONFLICT, 무기록
//   4) 다른 task/dispatch + 이전 종료 증명 + 권위 조회가 이전 두 ID와 exact
//      일치 + CAS 버전 일치 -> NEW_GENERATION(새 세대로 갱신)
//
// 대상 지정은 pane key로 하지 않는다(PM 지적4/coder-task.md §1-B 비타협) --
// worktreePath로 "이미 고정된 안정 레코드"를 정확히 1개 선택한 뒤에야
// assignee_pane_key를 그 레코드의 저장된 paneKey와 **대조값**으로만 쓴다.
// 0건/2건+/불일치는 전부 무기록 fail-closed(PM 지적3 반례 -- 사람이 직접 연
// 탭이나 다른 좌석을 잘못 갱신하지 않는다).
//
// 이 함수도 recordSeatCreation과 같은 순수 상태 변환이다 -- orca/fs 호출은
// 호출자(orca-adapter.mjs의 기록 seam) 몫이다.
export const SEAT_DISPATCH_REASON = Object.freeze({
  NO_TARGET: "SEAT_DISPATCH_NO_TARGET",
  AMBIGUOUS_TARGET: "SEAT_DISPATCH_AMBIGUOUS_TARGET",
  PANE_KEY_MISMATCH: "SEAT_DISPATCH_PANE_KEY_MISMATCH",
  INCARNATION_CONFLICT: "SEAT_DISPATCH_INCARNATION_CONFLICT",
  PRIOR_GENERATION_UNVERIFIED: "SEAT_DISPATCH_PRIOR_GENERATION_UNVERIFIED",
  CAS_VERSION_MISMATCH: "SEAT_DISPATCH_CAS_VERSION_MISMATCH",
});

export const SEAT_DISPATCH_TRANSITION = Object.freeze({
  BOUND: "BOUND",
  IDEMPOTENT_NOOP: "IDEMPOTENT_NOOP",
  NEW_GENERATION: "NEW_GENERATION",
});

function denySeatDispatch(reason) {
  return { ok: false, reason };
}

// worktreePath로 정확히 1개인 안정 레코드를 찾는다(pane key는 여기 관여하지
// 않는다 -- PM 지적4). 양쪽 다 non-empty string이어야 매치 대상이 된다(둘
// 다 null인 레코드끼리 우연히 매치되는 것을 막는다).
function selectStableTarget(seats, worktreePath) {
  if (!isNonEmptyString(worktreePath)) return [];
  return seats.filter(
    (r) => isPlainObject(r) && r.worktreePath === worktreePath,
  );
}

function replaceRecord(base, target, nextRecord) {
  return {
    schemaVersion: SCHEMA_VERSION,
    seats: base.seats.map((r) => (r === target ? nextRecord : r)),
  };
}

function buildDispatchSubRecord(c, version) {
  return {
    harnessTaskId: isNonEmptyString(c.harnessTaskId) ? c.harnessTaskId : null,
    runtimeTaskId: c.runtimeTaskId,
    dispatchId: c.dispatchId,
    status: "active",
    version,
  };
}

function bindResult(transition, base, target, nextRecord) {
  return {
    ok: true,
    transition,
    registry: replaceRecord(base, target, nextRecord),
    record: nextRecord,
  };
}

// 상태2/3/4(기존 배정이 있는 경우)만 분리 -- recordSeatDispatch의 복잡도를
// 낮춘다(대상 선정/pane key 대조는 호출자가 이미 끝냈다).
function transitionExistingDispatch(base, target, existing, c, opts) {
  // 상태2: 같은 task/dispatch 재수신 -> 멱등 no-op(레코드/버전 불변, 새
  // 객체를 만들지 않고 입력 registry를 그대로 반환한다 -- "1회 효과를 넘지
  // 않는다"를 참조 동일성으로도 증명한다).
  if (
    existing.runtimeTaskId === c.runtimeTaskId &&
    existing.dispatchId === c.dispatchId
  ) {
    return {
      ok: true,
      transition: SEAT_DISPATCH_TRANSITION.IDEMPOTENT_NOOP,
      registry: base,
      record: target,
    };
  }

  // 다른 task/dispatch. 이전 배정이 active 또는 상태 불명이면(completed가
  // 아니면) 정상 재배정 왕복(어제 ORCH 5회 연속 재배정 실측)을 위해서라도
  // 무조건 거부가 아니라 "이전 종료가 증명되지 않았다"는 이유로 거부한다 --
  // 상태3.
  if (existing.status !== "completed") {
    return denySeatDispatch(SEAT_DISPATCH_REASON.INCARNATION_CONFLICT);
  }

  // 상태4: 이전 종료 증명(status==="completed") + 권위 조회가 이전 두 ID와
  // exact 일치(호출자가 별도로 확인해 opts.priorGenerationAuthorityMatch로
  // 넘긴다 -- 이 함수는 orca를 조회하지 않는다) + CAS 버전 일치.
  if (opts.priorGenerationAuthorityMatch !== true) {
    return denySeatDispatch(SEAT_DISPATCH_REASON.PRIOR_GENERATION_UNVERIFIED);
  }
  if (opts.expectedVersion !== existing.version) {
    return denySeatDispatch(SEAT_DISPATCH_REASON.CAS_VERSION_MISMATCH);
  }

  const nextRecord = {
    ...target,
    dispatch: buildDispatchSubRecord(c, existing.version + 1),
  };
  return bindResult(
    SEAT_DISPATCH_TRANSITION.NEW_GENERATION,
    base,
    target,
    nextRecord,
  );
}

// 대상 선정(0/2+ fail-closed) + pane key 대조를 한곳에 묶는다(복잡도 분산
// -- PM 지적4: pane key는 lookup이 아니라 이미 고른 target에 대한 대조값).
function selectVerifiedTarget(seats, c) {
  const candidates = selectStableTarget(seats, c.worktreePath);
  if (candidates.length === 0) {
    return denySeatDispatch(SEAT_DISPATCH_REASON.NO_TARGET);
  }
  if (candidates.length > 1) {
    return denySeatDispatch(SEAT_DISPATCH_REASON.AMBIGUOUS_TARGET);
  }
  const target = candidates[0];
  if (
    !isNonEmptyString(c.assigneePaneKey) ||
    !isNonEmptyString(target.paneKey) ||
    c.assigneePaneKey !== target.paneKey
  ) {
    return denySeatDispatch(SEAT_DISPATCH_REASON.PANE_KEY_MISMATCH);
  }
  return { ok: true, target };
}

// ctx: { worktreePath, assigneePaneKey, harnessTaskId, runtimeTaskId, dispatchId }
// opts: { priorGenerationAuthorityMatch?: boolean, expectedVersion?: number }
export function recordSeatDispatch(registry, ctx = {}, opts = {}) {
  const base = isPlainObject(registry) ? registry : createEmptyRegistry();
  const seats = Array.isArray(base.seats) ? base.seats : [];
  const c = isPlainObject(ctx) ? ctx : {};

  const selected = selectVerifiedTarget(seats, c);
  if (!selected.ok) return selected;
  const target = selected.target;

  const existing = isPlainObject(target.dispatch) ? target.dispatch : null;

  // 상태1: 빈 배정 레코드 -> 결속 허용.
  if (existing === null) {
    const nextRecord = { ...target, dispatch: buildDispatchSubRecord(c, 1) };
    return bindResult(SEAT_DISPATCH_TRANSITION.BOUND, base, target, nextRecord);
  }

  return transitionExistingDispatch(base, target, existing, c, opts);
}

// ---- fs 결속(observer-store.mjs parseStoreText/loadStore 전례 계승) ----
// 손상(JSON.parse 실패)·스키마 불일치는 항상 ok:false -- 이 경우 호출자는
// 이번 tick에서 어떤 등록도 진행하지 않는다(fail-closed). 파일 부재는
// 손상이 아니라 "첫 실행"이므로 빈 registry로 정상 취급한다.
export function parseRegistryText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "corrupt-json" };
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: "schema-mismatch" };
  }
  if (!Array.isArray(parsed.seats)) {
    return { ok: false, reason: "schema-mismatch" };
  }
  return { ok: true, registry: parsed };
}

// opts: { existsFn, readFn } -- 둘 다 (path) => value 형태.
export function loadRegistry(path, opts = {}) {
  const { existsFn, readFn } = opts;
  if (typeof existsFn !== "function" || typeof readFn !== "function") {
    return { ok: false, reason: "loadRegistry: existsFn/readFn required" };
  }
  if (!existsFn(path)) {
    return { ok: true, registry: createEmptyRegistry(), rawText: null };
  }
  let text;
  try {
    text = readFn(path);
  } catch (err) {
    return {
      ok: false,
      reason: `loadRegistry: read threw (${err?.message})`,
    };
  }
  const parsed = parseRegistryText(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, registry: parsed.registry, rawText: text };
}

// opts: { writeFn, renameFn } -- tmp write + rename로 원자성 근사(둘 다 주입).
export function saveRegistry(path, registry, opts = {}) {
  const { writeFn, renameFn } = opts;
  if (typeof writeFn !== "function" || typeof renameFn !== "function") {
    return { ok: false, reason: "saveRegistry: writeFn/renameFn required" };
  }
  const tmpPath = `${path}.tmp`;
  const text = JSON.stringify(
    isPlainObject(registry) ? registry : createEmptyRegistry(),
    null,
    2,
  );
  try {
    writeFn(tmpPath, text);
    renameFn(tmpPath, path);
  } catch (err) {
    return {
      ok: false,
      reason: `saveRegistry: write threw (${err?.message})`,
    };
  }
  return { ok: true, rawText: text };
}
