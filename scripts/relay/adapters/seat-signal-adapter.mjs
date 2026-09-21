// HYK-171-cycle2b-1: 원시 좌석 신호(raw orca/codex 문자열류) -> 정규화
// 스냅샷 + 관측품질 메타. observer-only(coder-task.md §경계): 이 파일은
// dispatch/teardown/worker input/task 상태 write를 절대 호출하지 않는다 --
// 읽기 전용 조회(orchestration dispatch-show, terminal show, orchestration
// check --peek)만 한다.
//
// S6 봉인(coder-task.md §어댑터 계약): raw orca/codex 문자열(terminal
// handle·pane key·worktree selector·dispatch-show status·`.harness/<role>.md`
// 경로·codex prompt 원문·worker_done/escalation 벤더 이벤트명)은 이 파일
// 안에만 머문다. stall-core.mjs로 넘기는 스냅샷은 문서화된 정규화 필드
// (mtimeAgeS·processAlive·handshake·lastOutputAgeS·lastOutputChanged·
// pushSeen·lease·seatId)만 담는다 -- raw 문자열 자체를 스냅샷에 실어
// 코어로 흘리지 않는다.
//
// G9(orca-cli-boundary): 이 파일은 `orca` 프로세스를 직접 spawn하지 않는다
// -- orca-adapter.mjs가 내보내는 `createOrcaExecFn`(유일한 spawn 지점)을
// opts.execFn 기본값으로 재사용한다. 실측 명령 빌더(terminal show/list)도
// orca-adapter.mjs의 것을 재사용(재구현 금지, coder-task.md §재사용).

import { createHash } from "node:crypto";
import { checkRelayHandshake } from "../../check/relay-handshake.mjs";
import {
  buildSeatShowCommand,
  parseSeatPreview,
  normalizePreview,
  buildTerminalListCommand,
  parseTerminalList,
  isOrphanSeat,
  createOrcaExecFn,
} from "./orca-adapter.mjs";

export const SCHEMA_VERSION = 1;

export const SOURCE_FAILURE_DOMAIN = Object.freeze({
  FILE: "file",
  CONTROL_PLANE: "control-plane",
  DELIVERY: "delivery",
});

// PM §8 capability 선언 -- 엔진별 prompt(update/confirm/rate-limit) 탐지기가
// 아직 없다(정직 요구: 없는 것을 지어내지 않는다). 이 상수는 그 없음을
// 명시적으로 낸다 -- 값을 만들어 HEALTHY/PAUSE로 위장하지 않는다는 계약을
// 코드로 고정한 것.
export const CAPABILITY_STATUS = Object.freeze({
  UNKNOWN: "UNKNOWN",
});

// 이 어댑터의 raw dispatch-show 명령(이 태스크의 관측 전용 조회 -- orca
// 문자열은 이 파일 안에만).
export function buildDispatchShowCommand(taskId) {
  return ["orchestration", "dispatch-show", "--task", taskId, "--json"];
}
export function parseDispatchShow(response) {
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    response.ok !== true
  ) {
    return null;
  }
  const dispatch = response.result?.dispatch;
  if (!dispatch || typeof dispatch !== "object") return null;
  return {
    status: typeof dispatch.status === "string" ? dispatch.status : null,
    assigneePaneKey:
      typeof dispatch.assignee_pane_key === "string"
        ? dispatch.assignee_pane_key
        : null,
    taskId: typeof dispatch.task_id === "string" ? dispatch.task_id : null,
    dispatchId: typeof dispatch.id === "string" ? dispatch.id : null,
  };
}

// 좌석 push(heartbeat/worker_done) 비권위 관측 -- 코디네이터 좌석 기준
// non-blocking peek. --peek이라 읽음 처리(다른 소비자 것을 태우는 일)가
// 없다(orca-adapter.mjs buildNonBlockingCheckCommand 전례와 동형이나,
// 이 관측은 heartbeat도 필요해 --types를 확장한 별도 빌더로 둔다 -- raw
// 이벤트명 문자열은 여기 안에만).
export function buildPushPeekCommand(coordinatorHandle) {
  return [
    "orchestration",
    "check",
    "--terminal",
    coordinatorHandle,
    "--types",
    "heartbeat,worker_done",
    "--peek",
    "--json",
  ];
}
export function parsePushPeek(response) {
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    response.ok !== true
  ) {
    return null;
  }
  const messages = Array.isArray(response.result?.messages)
    ? response.result.messages
    : [];
  return messages
    .filter((m) => m && typeof m === "object")
    .map((m) => ({
      type: typeof m.type === "string" ? m.type : null,
      taskId: typeof m.taskId === "string" ? m.taskId : null,
      dispatchId: typeof m.dispatchId === "string" ? m.dispatchId : null,
    }));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// mutation 8(clock rollback/큰 jump): now가 이전 관측 시각보다 과거이거나
// (rollback) 비정상적으로 큰 폭으로 튀면(jump) 그 관측시각 자체를 신뢰하지
// 않는다 -- config.maxClockJumpS로 "큰 폭"의 기준을 조정 가능하게 둔다
// (하드코딩 금지, PM §5 원칙 계승).
function detectClockAnomaly({ now, prevObservedAtMs, maxClockJumpS }) {
  if (!isFiniteNumber(now)) return "missing-clock";
  if (!isFiniteNumber(prevObservedAtMs)) return null;
  if (now < prevObservedAtMs) return "rollback";
  const jumpS = (now - prevObservedAtMs) / 1000;
  const limit = isFiniteNumber(maxClockJumpS) ? maxClockJumpS : 86400 * 7;
  if (jumpS > limit) return "jump";
  return null;
}

// mutation 3(부분파일/읽는 중 변경/손상): 두 stat 샘플(읽기 전/후) 또는
// 크기·mtime 불일치를 caller가 넘겨주면(raw.resultStatRace) 그 자체를
// 신뢰하지 않는다. caller(수집측)가 실제 두 번 stat하는 책임을 지고, 이
// 함수는 그 결과만 순수 판정한다(파일시스템 호출 0 -- 이 함수는 순수).
function looksLikePartialRead(raw) {
  if (raw.resultReadError === true) return true;
  const race = raw.resultStatRace;
  if (!isPlainObject(race)) return false;
  if (!isPlainObject(race.before) || !isPlainObject(race.after)) return false;
  return (
    race.before.mtimeMs !== race.after.mtimeMs ||
    race.before.size !== race.after.size
  );
}

// mutation 5/7 근거: dispatch-show/terminal show/terminal list 자체가
// 실패(ok:false/응답 파싱 실패)면 "워커가 정체됐다"가 아니라 "관측 경로
// (어댑터/control-plane)가 죽었다"이다 -- 이 둘을 섞으면 어댑터 장애를
// 워커 stall로 오분류한다. previewText/parsedTerminalList는 각각
// terminalShow/terminalListResponse의 파싱 결과다(서로 다른 조회, 혼동 금지).
function resolveSourceFailureDomain(
  raw,
  parsedDispatch,
  previewText,
  parsedTerminalList,
) {
  if (looksLikePartialRead(raw)) return SOURCE_FAILURE_DOMAIN.FILE;
  if (raw.dispatchShow != null && parsedDispatch === null) {
    return SOURCE_FAILURE_DOMAIN.CONTROL_PLANE;
  }
  if (raw.terminalShow != null && previewText === null) {
    return SOURCE_FAILURE_DOMAIN.CONTROL_PLANE;
  }
  if (raw.terminalListResponse != null && parsedTerminalList === null) {
    return SOURCE_FAILURE_DOMAIN.CONTROL_PLANE;
  }
  if (raw.pushPeekFailed === true) return SOURCE_FAILURE_DOMAIN.DELIVERY;
  return null;
}

// mutation 3(incarnation 결속): dispatch-show가 알려주는 현재 assignee pane
// key/taskId/dispatchId가 caller가 기대한 incarnation과 다르면 -- 다른
// 세대의 관측을 이 세대 것처럼 섞은 것이다(새 dispatch로 재실행됐는데 과거
// 관측/ack가 새 episode를 억제하는 사고의 근본 원인). 그 경우 이 tick은
// "관측 불가"로 접는다(수치를 만들어내지 않는다) -- 새 incarnation 자체는
// 상류(store)가 별도로 인지해 새 episode를 연다.
function detectIncarnationMismatch(expected, parsedDispatch) {
  if (!isPlainObject(expected) || parsedDispatch === null) return false;
  if (
    typeof expected.taskId === "string" &&
    typeof parsedDispatch.taskId === "string" &&
    expected.taskId !== parsedDispatch.taskId
  ) {
    return true;
  }
  if (
    typeof expected.dispatchId === "string" &&
    typeof parsedDispatch.dispatchId === "string" &&
    expected.dispatchId !== parsedDispatch.dispatchId
  ) {
    return true;
  }
  if (
    typeof expected.seatPaneKey === "string" &&
    typeof parsedDispatch.assigneePaneKey === "string" &&
    expected.seatPaneKey !== parsedDispatch.assigneePaneKey
  ) {
    return true;
  }
  return false;
}

// P1-4 재작업(REVIEW hyk171-cycle2b-review-1 결함 4 수리): S6 계약상
// pane key(raw orca 문자열)는 이 어댑터 파일 안에만 머물러야 한다
// (파일 상단 헤더 주석). 그런데 이 어댑터가 낸 `quality.incarnation`을
// stall-observer.mjs가 그대로 durable store(observer-store.mjs)로 넘겨
// `incarnationKey` 직렬화 문자열에 raw pane key가 그대로 박혔다(REVIEW의
// S6_RAW_PANE_PROBE 재현). detectIncarnationMismatch(위)는 내부 비교용이라
// 원시 pane key를 계속 써도 되지만(파일 밖으로 안 나간다), 밖으로 나가는
// `quality.incarnation` 필드는 pane key를 비가역 해시 토큰으로 바꾼다 --
// taskId/dispatchId는 Orca 자신의 태스크/dispatch 식별자라 이미 다른
// 곳(예: 로그·STATUS)에도 노출되는 값이라 그대로 두되(별도 유출 우려
// 없음), pane key만 대상이다.
export function tokenizeIncarnation(expected) {
  if (!isPlainObject(expected)) return null;
  const seatPaneKey =
    typeof expected.seatPaneKey === "string"
      ? createHash("sha256")
          .update(expected.seatPaneKey)
          .digest("hex")
          .slice(0, 32)
      : undefined;
  return {
    taskId: expected.taskId,
    dispatchId: expected.dispatchId,
    seatPaneKey,
  };
}

// false-activity 방어(cycle2a 재사용 원칙 계승): terminal preview의 "변화"는
// 이 함수가 직접 비교해 판정한다 -- raw가 주장하는 "changed" 불리언을
// 그대로 믿지 않는다(raw 소스가 노이즈일 수 있다는 게 PM §3의 요점). 이전
// 정규화 preview와 정확히 다를 때만 changed로 본다.
function computeOutputChange({
  now,
  previewText,
  prevPreviewNormalized,
  prevOutputChangedAtMs,
}) {
  const currentNormalized =
    typeof previewText === "string" ? normalizePreview(previewText) : null;
  const hadPrev = typeof prevPreviewNormalized === "string";
  const changedThisTick =
    currentNormalized !== null &&
    hadPrev &&
    currentNormalized !== prevPreviewNormalized;
  const outputChangedAtMs = changedThisTick
    ? now
    : isFiniteNumber(prevOutputChangedAtMs)
      ? prevOutputChangedAtMs
      : null;
  return {
    previewNormalized: currentNormalized,
    outputChangedAtMs,
    lastOutputChanged: outputChangedAtMs !== null,
    lastOutputAgeS:
      outputChangedAtMs !== null ? (now - outputChangedAtMs) / 1000 : undefined,
  };
}

// processAlive 판정: 좌석(pane) 연결 여부만 본다(orca-adapter.mjs isOrphanSeat
// 재사용 -- 정직 한계: 이건 터미널 칸 수준 신호다, 에이전트 프로세스 수준
// liveness는 이 어댑터 범위 밖 -- orca-adapter.mjs 상단 주석과 동일 한계를
// 승계한다). worktreePath를 아예 못 구하면(조회 자체 실패) undefined를
// 반환해 상류가 hasRequiredFields로 UNOBSERVABLE 처리하게 둔다.
function deriveProcessAlive(raw, parsedTerminal) {
  if (typeof raw.terminalConnectedOverride === "boolean") {
    return raw.terminalConnectedOverride;
  }
  if (!Array.isArray(parsedTerminal) || !isPlainObject(raw.seatSelector)) {
    return undefined;
  }
  const target = raw.seatSelector.handle;
  const entry = parsedTerminal.find(
    (t) => isPlainObject(t) && t.handle === target,
  );
  if (!entry) return undefined;
  return !isOrphanSeat({ worktreePath: entry.worktreePath });
}

// 순수 정규화 함수: 부작용 0. raw는 이미 수집된(호출측이 execFn으로 가져온)
// 원시 응답들의 집합이다 -- 이 함수 자체는 execFn을 부르지 않는다.
//
// raw = {
//   now, seatId, expectedIncarnation: {taskId, dispatchId, seatPaneKey},
//   resultStat: {mtimeMs, size} | null, resultReadError, resultStatRace,
//   handshakeResult: {ok, reason} | null,
//   dispatchShow: <raw orca response> | null,
//   terminalShow: <raw orca response> | null,
//   pushPeekFailed, pushEvents: [{type, taskId, dispatchId}],
//   seatSelector: {handle}, terminalConnectedOverride,
//   prevPreviewNormalized, prevOutputChangedAtMs, prevObservedAtMs,
//   lease, capabilities: {promptDetector, rateLimitDetector}, maxClockJumpS,
// }
// normalizeSeatObservation에서 분리(quality-check 복잡도 상한 준수 --
// raw로부터 세 원시 파서 결과(dispatch-show/terminal show/terminal list)를
// 한 번에 뽑는다).
function parseRawInputs(r) {
  return {
    parsedDispatch:
      r.dispatchShow != null ? parseDispatchShow(r.dispatchShow) : undefined,
    parsedTerminalList:
      r.terminalListResponse != null
        ? parseTerminalList(r.terminalListResponse)
        : undefined,
    previewText:
      r.terminalShow != null ? parseSeatPreview(r.terminalShow) : null,
  };
}

// normalizeSeatObservation에서 분리 -- 관측품질 판정(clock/부분읽기/
// incarnation/제어면 장애)을 한곳에 모은다.
function assessQuality(r, now, parsed) {
  const { parsedDispatch, parsedTerminalList, previewText } = parsed;
  const clockAnomaly = detectClockAnomaly({
    now,
    prevObservedAtMs: r.prevObservedAtMs,
    maxClockJumpS: r.maxClockJumpS,
  });
  const partialRead = looksLikePartialRead(r);
  const incarnationMismatch =
    parsedDispatch !== null &&
    parsedDispatch !== undefined &&
    detectIncarnationMismatch(r.expectedIncarnation, parsedDispatch);
  const sourceFailureDomain = resolveSourceFailureDomain(
    r,
    parsedDispatch === undefined ? null : parsedDispatch,
    previewText,
    parsedTerminalList === undefined ? null : parsedTerminalList,
  );

  const degradedReasons = [];
  if (clockAnomaly) degradedReasons.push(`clock-${clockAnomaly}`);
  if (partialRead) degradedReasons.push("partial-read");
  if (incarnationMismatch) degradedReasons.push("incarnation-mismatch");
  if (sourceFailureDomain === SOURCE_FAILURE_DOMAIN.CONTROL_PLANE) {
    degradedReasons.push("control-plane-query-failed");
  }
  if (sourceFailureDomain === SOURCE_FAILURE_DOMAIN.DELIVERY) {
    degradedReasons.push("push-peek-failed");
  }

  return {
    sourceFailureDomain,
    degradedReasons,
    observable: degradedReasons.length === 0,
  };
}

function resolveCapabilityStatus(r) {
  const capabilities = isPlainObject(r.capabilities) ? r.capabilities : {};
  return {
    promptDetector:
      capabilities.promptDetector === true
        ? "PRESENT"
        : CAPABILITY_STATUS.UNKNOWN,
    rateLimitDetector:
      capabilities.rateLimitDetector === true
        ? "PRESENT"
        : CAPABILITY_STATUS.UNKNOWN,
  };
}

// mutation 2(stale/replayed/out-of-order push · 중복 worker_done): 이전
// incarnation에서 남아 재관측되는(peek은 읽음 처리를 안 하므로 여러 tick에
// 걸쳐 같은 오래된 메시지가 계속 보일 수 있다) push 이벤트가 현재
// incarnation의 진전 증거로 둔갑하면 안 된다 -- 이벤트가 taskId/dispatchId를
// 담고 있으면 기대 incarnation과 일치할 때만 pushSeen에 반영한다(이벤트에
// 그 필드가 아예 없으면 판단 근거가 없으므로 보수적으로 그대로 인정한다).
function isCurrentIncarnationPush(e, expected) {
  if (!isPlainObject(e)) return false;
  if (e.type !== "heartbeat" && e.type !== "worker_done") return false;
  if (!expected) return true;
  if (
    typeof e.taskId === "string" &&
    typeof expected.taskId === "string" &&
    e.taskId !== expected.taskId
  ) {
    return false;
  }
  if (
    typeof e.dispatchId === "string" &&
    typeof expected.dispatchId === "string" &&
    e.dispatchId !== expected.dispatchId
  ) {
    return false;
  }
  return true;
}

function computePushSeen(r) {
  const expected = isPlainObject(r.expectedIncarnation)
    ? r.expectedIncarnation
    : null;
  return (
    Array.isArray(r.pushEvents) &&
    r.pushEvents.some((e) => isCurrentIncarnationPush(e, expected))
  );
}

export function normalizeSeatObservation(raw = {}) {
  const r = isPlainObject(raw) ? raw : {};
  const now = r.now;
  const parsed = parseRawInputs(r);
  const { parsedTerminalList, previewText } = parsed;

  const { sourceFailureDomain, degradedReasons, observable } = assessQuality(
    r,
    now,
    parsed,
  );
  const capabilityStatus = resolveCapabilityStatus(r);

  const outputChange = computeOutputChange({
    now,
    previewText,
    prevPreviewNormalized: r.prevPreviewNormalized,
    prevOutputChangedAtMs: r.prevOutputChangedAtMs,
  });

  const mtimeAgeS =
    isPlainObject(r.resultStat) &&
    isFiniteNumber(r.resultStat.mtimeMs) &&
    isFiniteNumber(now)
      ? (now - r.resultStat.mtimeMs) / 1000
      : undefined;

  const handshake = r.handshakeResult?.ok === true ? "done" : "pending";
  const pushSeen = computePushSeen(r);

  const processAlive = deriveProcessAlive(
    r,
    parsedTerminalList === undefined ? null : parsedTerminalList,
  );

  const snapshot = {
    seatId: r.seatId,
    handshake,
    mtimeAgeS,
    processAlive,
    lastOutputAgeS: outputChange.lastOutputAgeS,
    lastOutputChanged: outputChange.lastOutputChanged,
    pushSeen,
    lease: isPlainObject(r.lease) ? r.lease : undefined,
  };

  const quality = {
    schemaVersion: SCHEMA_VERSION,
    adapterFresh: { collectedAtMs: now },
    sourceFailureDomain,
    incarnation: tokenizeIncarnation(r.expectedIncarnation),
    observable,
    degradedReasons,
    capabilityStatus,
  };

  // 다음 tick을 위해 store가 들고 갈 최소 bookkeeping(advisory state가
  // 아니라 관측 자체의 연속성 근거 -- coder-task.md §durable 목록의
  // "sample 세대"에 해당).
  const persist = {
    previewNormalized: outputChange.previewNormalized,
    outputChangedAtMs: outputChange.outputChangedAtMs,
    observedAtMs: now,
  };

  return { snapshot, quality, persist };
}

// ---- 수집(impure) 경로: opts.execFn을 통해 실제 조회를 수행하고
// normalizeSeatObservation에 넘길 raw를 조립한다. 여기서도 dispatch/teardown/
// worker input/task 상태 write는 절대 호출하지 않는다 -- 아래 호출은 전부
// 읽기 전용(dispatch-show, terminal show, terminal list, orchestration
// check --peek)이다.
function safeExec(execFn, argv) {
  try {
    const response = execFn(argv);
    return { ok: true, response };
  } catch {
    return { ok: false, response: null };
  }
}

// ctx: { seatId, harnessRole, harnessDir, taskId, coordinatorHandle,
//   seatSelector: {handle}, expectedIncarnation, lease, capabilities,
//   maxClockJumpS }
// opts: { execFn, statFn, nowFn, checkHandshakeFn, prevObservation }
function resolveCollectDeps(opts) {
  return {
    execFn:
      typeof opts.execFn === "function" ? opts.execFn : createOrcaExecFn(),
    nowFn: typeof opts.nowFn === "function" ? opts.nowFn : () => Date.now(),
    statFn: typeof opts.statFn === "function" ? opts.statFn : null,
    checkHandshakeFn:
      typeof opts.checkHandshakeFn === "function"
        ? opts.checkHandshakeFn
        : checkRelayHandshake,
  };
}

function collectResultStat(c, statFn) {
  if (!statFn || typeof c.harnessRole !== "string") {
    return { resultStat: null, resultReadError: false };
  }
  try {
    return { resultStat: statFn(c.harnessRole), resultReadError: false };
  } catch {
    return { resultStat: null, resultReadError: true };
  }
}

function collectHandshake(c, checkHandshakeFn) {
  try {
    return checkHandshakeFn({ role: c.harnessRole, harnessDir: c.harnessDir });
  } catch {
    return { ok: false, reason: "handshake check threw" };
  }
}

// safeExec가 ok:false(실행 자체가 실패 -- 제어면 장애)를 반환해도, raw.*Show
// 필드는 null(=조회 자체를 시도하지 않음)과 구분되는 값이어야 한다 -- 그래야
// normalizeSeatObservation의 resolveSourceFailureDomain이 "조회 시도했으나
// 실패"(control-plane 장애)를 "애초에 조회 안 함"과 혼동하지 않는다(mutation 5).
function execOrFailureSentinel(execFn, argv) {
  const res = safeExec(execFn, argv);
  return res.ok
    ? res.response
    : { ok: false, error: { message: "exec failed" } };
}

function collectSeatQueries(c, execFn) {
  const dispatchShow =
    typeof c.taskId === "string"
      ? execOrFailureSentinel(execFn, buildDispatchShowCommand(c.taskId))
      : null;

  const hasSeatSelector =
    isPlainObject(c.seatSelector) && typeof c.seatSelector.handle === "string";
  const terminalShow = hasSeatSelector
    ? execOrFailureSentinel(execFn, buildSeatShowCommand(c.seatSelector.handle))
    : null;
  const terminalListResponse = hasSeatSelector
    ? execOrFailureSentinel(execFn, buildTerminalListCommand())
    : null;

  return { dispatchShow, terminalShow, terminalListResponse };
}

function collectPushEvents(c, execFn) {
  if (typeof c.coordinatorHandle !== "string") {
    return { pushEvents: [], pushPeekFailed: false };
  }
  const res = safeExec(execFn, buildPushPeekCommand(c.coordinatorHandle));
  if (!res.ok) return { pushEvents: [], pushPeekFailed: true };
  const parsed = parsePushPeek(res.response);
  return parsed === null
    ? { pushEvents: [], pushPeekFailed: true }
    : { pushEvents: parsed, pushPeekFailed: false };
}

// ctx: { seatId, harnessRole, harnessDir, taskId, coordinatorHandle,
//   seatSelector: {handle}, expectedIncarnation, lease, capabilities,
//   maxClockJumpS }
// opts: { execFn, statFn, nowFn, checkHandshakeFn, prevObservation }
export function collectSeatObservation(ctx = {}, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const { execFn, nowFn, statFn, checkHandshakeFn } = resolveCollectDeps(opts);
  const prev = isPlainObject(opts.prevObservation) ? opts.prevObservation : {};

  const now = nowFn();
  const { resultStat, resultReadError } = collectResultStat(c, statFn);
  const handshakeResult = collectHandshake(c, checkHandshakeFn);
  const { dispatchShow, terminalShow, terminalListResponse } =
    collectSeatQueries(c, execFn);
  const { pushEvents, pushPeekFailed } = collectPushEvents(c, execFn);

  return normalizeSeatObservation({
    now,
    seatId: c.seatId,
    expectedIncarnation: c.expectedIncarnation,
    resultStat,
    resultReadError,
    handshakeResult,
    dispatchShow,
    terminalShow,
    terminalListResponse,
    pushEvents,
    pushPeekFailed,
    seatSelector: c.seatSelector,
    prevPreviewNormalized: prev.previewNormalized ?? null,
    prevOutputChangedAtMs: prev.outputChangedAtMs ?? null,
    prevObservedAtMs: prev.observedAtMs ?? null,
    lease: c.lease,
    capabilities: c.capabilities,
    maxClockJumpS: c.maxClockJumpS,
  });
}
