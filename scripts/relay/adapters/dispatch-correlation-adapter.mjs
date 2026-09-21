// HYK-171 사이클4b-2b-3 (coder-task.md §2) -- dispatch-correlation-core.mjs
// 가 요구하는 정규화 입력을 만드는 어댑터 층. 4b-2b-2가 REVIEW P2로 남긴
// 결함(fixture가 손으로 만든 camelCase 평평 구조라 실 CLI 응답 모양과
// 다르다는 사실을 아무도 검사하지 않았다)을 이 파일이 메운다.
//
// 세 함수 전부 fail-closed: 입력이 기대 모양이 아니면 "모른다"(ok:false /
// adoptionObservable:false)를 반환하지, 추측한 값을 지어내지 않는다.
//
// S6 경계: 이 파일은 raw JSON을 파싱하는 유일한 층이다(코어는 이미 정규화된
// 입력만 받는다 -- dispatch-correlation-core.mjs 헤더 참조). vendor 명령을
// spawn하지 않는다(호출자가 이미 얻은 응답 객체만 받는다).

export const DISPATCH_SHOW_REASON = Object.freeze({
  NOT_OK: "NOT_OK",
  // coder-task.md §1-B 실측: 미배정 태스크와 오타 난(존재하지 않는) 태스크
  // id가 완전히 같은 응답을 낸다(exit code도 0). 응답에 둘을 구별할 근거가
  // 없으므로 하나의 사유 코드로 접는다 -- 있는 척 구별하지 않는다.
  NO_DISPATCH: "NO_DISPATCH",
  FIELDS_INCOMPLETE: "FIELDS_INCOMPLETE",
  VALID: "VALID",
});

export const SEAT_CREATION_REASON = Object.freeze({
  // `result.terminal`(단수) 봉투 자체가 없다 -- `--focus` 응답의 봉투
  // 결손이거나, terminal-list 응답(`result.terminals`, 복수)을 잘못
  // 넘긴 경우 둘 다 여기서 걸린다(구조 자체가 다르므로 사후 위장이
  // 통하지 않는다, coder-task.md §2-B 비타협3).
  NO_TERMINAL_ENVELOPE: "NO_TERMINAL_ENVELOPE",
  MISSING_PANE_KEY: "MISSING_PANE_KEY",
  VALID: "VALID",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// ---------------------------------------------------------------------------
// 2-A. normalizeDispatchShow(rawResponse)
// -> judgeDispatchCorrelation의 dispatchShow 인자로 그대로 넘길 수 있는
//    단일 객체(코어가 보지 않는 필드 -- reasonCode/assigneeHandle -- 를
//    얹어도 코어 판정에는 영향 없다, dispatch-correlation-core.mjs가 알려진
//    필드만 읽기 때문).
// ---------------------------------------------------------------------------
export function normalizeDispatchShow(rawResponse) {
  const raw = isPlainObject(rawResponse) ? rawResponse : {};

  // 비타협1: 최상위 ok를 그대로 전달하지 않는다 -- result.dispatch가 plain
  // object이고 세 필드가 전부 non-empty string일 때만 ok:true.
  if (raw.ok !== true) {
    return { ok: false, reasonCode: DISPATCH_SHOW_REASON.NOT_OK };
  }

  const dispatch =
    isPlainObject(raw.result) && isPlainObject(raw.result.dispatch)
      ? raw.result.dispatch
      : null;

  // 비타협2: result.dispatch === null(미배정/오타 id 둘 다 이 모양) -- 구별
  // 근거가 없으므로 단일 사유 코드로 접는다.
  if (dispatch === null) {
    return { ok: false, reasonCode: DISPATCH_SHOW_REASON.NO_DISPATCH };
  }

  const taskId = dispatch.task_id;
  const dispatchId = dispatch.id;
  const assigneePaneKey = dispatch.assignee_pane_key;

  if (
    !isNonEmptyString(taskId) ||
    !isNonEmptyString(dispatchId) ||
    !isNonEmptyString(assigneePaneKey)
  ) {
    return { ok: false, reasonCode: DISPATCH_SHOW_REASON.FIELDS_INCOMPLETE };
  }

  return {
    ok: true,
    taskId,
    dispatchId,
    assigneePaneKey,
    reasonCode: DISPATCH_SHOW_REASON.VALID,
    // 비타협4: assignee_handle은 코어 시그니처에 없다(handle은 회전한다) --
    // 진단용으로만 별도 필드에 싣는다. judgeDispatchCorrelation은 이 필드를
    // 읽지 않는다.
    assigneeHandle: isNonEmptyString(dispatch.assignee_handle)
      ? dispatch.assignee_handle
      : undefined,
    // HYK-464-followup-1 축B: dispatch 자신의 status(예: "dispatched")도
    // assigneeHandle과 같은 원칙으로 진단용 별도 필드에만 싣는다 --
    // judgeDispatchCorrelation 코어 시그니처엔 없다. orca-adapter.mjs의
    // resolveDeliveredSeat이 "이 배달이 이미 퇴역했는가"(반납된 예약의
    // 옛 assignee_pane_key를 좇다 좌석을 못 찾는 것과, 아직 살아있는
    // 배달인데 좌석이 죽은 것을 구별)를 가리는 데 이 값을 쓴다.
    status: isNonEmptyString(dispatch.status) ? dispatch.status : undefined,
  };
}

// ---------------------------------------------------------------------------
// 2-A2 (HYK-171 사이클4b-2b-4, coder-task.md §1-D) -- dispatch/dispatch-show
// raw shape union.
//
// `orca orchestration dispatch --json` -> result.{dispatch(11키), injected(boolean)}
// `orca orchestration dispatch-show --json` -> result.{dispatch(11키)}(injected 없음)
//
// 두 형태를 하나의 느슨한 검사로 뭉개지 않는다(PM 지적7) -- result의 정확한
// 키집합으로 먼저 형태를 판정한 뒤, 그 형태에서만 유효한 필드를 읽는다.
// ---------------------------------------------------------------------------
export const DISPATCH_SHAPE = Object.freeze({
  DISPATCH: "dispatch",
  DISPATCH_SHOW: "dispatch-show",
});

export const DISPATCH_ENVELOPE_REASON = Object.freeze({
  NOT_OK: "NOT_OK",
  UNKNOWN_SHAPE: "UNKNOWN_SHAPE",
  NO_DISPATCH: "NO_DISPATCH",
  FIELDS_INCOMPLETE: "FIELDS_INCOMPLETE",
  VALID: "VALID",
});

// result의 정확한 키집합만으로 형태를 판정한다(느슨한 "키가 있으면" 검사
// 금지 -- 4b-2b-3 schema-4의 exact-key-set 원칙을 그대로 승계).
function detectDispatchEnvelopeShape(result) {
  if (!isPlainObject(result)) return null;
  const keys = Object.keys(result).sort();
  if (keys.length === 2 && keys[0] === "dispatch" && keys[1] === "injected") {
    return DISPATCH_SHAPE.DISPATCH;
  }
  if (keys.length === 1 && keys[0] === "dispatch") {
    return DISPATCH_SHAPE.DISPATCH_SHOW;
  }
  return null;
}

// normalizeDispatchShow와 달리 두 형태(dispatch/dispatch-show) 모두 받고,
// 어느 형태인지(`shape`)와 `injected`(dispatch 형태에서만 boolean, 그 외
// null)를 함께 낸다. 이 함수는 raw dispatch/dispatch-show 응답이라면 어느
// 쪽이든 통과시켜야 하는 "기록 seam"(orca-adapter.mjs dispatchWithStaleRecovery)
// 용이다 -- normalizeDispatchShow는 dispatch-show 전용 기존 계약을 그대로
// 유지한다(호환 파괴 금지).
export function normalizeDispatchRawUnion(rawResponse) {
  const raw = isPlainObject(rawResponse) ? rawResponse : {};
  if (raw.ok !== true) {
    return { ok: false, reasonCode: DISPATCH_ENVELOPE_REASON.NOT_OK };
  }

  const shape = detectDispatchEnvelopeShape(raw.result);
  if (!shape) {
    return { ok: false, reasonCode: DISPATCH_ENVELOPE_REASON.UNKNOWN_SHAPE };
  }

  const dispatch = raw.result.dispatch;
  if (dispatch === null) {
    return {
      ok: false,
      shape,
      reasonCode: DISPATCH_ENVELOPE_REASON.NO_DISPATCH,
    };
  }
  if (!isPlainObject(dispatch)) {
    return {
      ok: false,
      shape,
      reasonCode: DISPATCH_ENVELOPE_REASON.UNKNOWN_SHAPE,
    };
  }

  const runtimeTaskId = dispatch.task_id;
  const dispatchId = dispatch.id;
  const assigneePaneKey = dispatch.assignee_pane_key;
  if (
    !isNonEmptyString(runtimeTaskId) ||
    !isNonEmptyString(dispatchId) ||
    !isNonEmptyString(assigneePaneKey)
  ) {
    return {
      ok: false,
      shape,
      reasonCode: DISPATCH_ENVELOPE_REASON.FIELDS_INCOMPLETE,
    };
  }

  return {
    ok: true,
    shape,
    runtimeTaskId,
    dispatchId,
    assigneePaneKey,
    // dispatch-show 형태에는 애초에 이 필드가 없다 -- true/false로
    // 지어내지 않고 null로 정직하게 남긴다(§2-A 필드 없음=null 원칙 계승).
    // dispatch 형태에서도 result.injected가 boolean이 아니면(결손·다른
    // 타입) 지어내지 않고 null로 접는다.
    injected:
      shape === DISPATCH_SHAPE.DISPATCH &&
      typeof raw.result.injected === "boolean"
        ? raw.result.injected
        : null,
    reasonCode: DISPATCH_ENVELOPE_REASON.VALID,
  };
}

// ---------------------------------------------------------------------------
// 2-A3 -- 프로필별 `injected` 의미 분리(PM M11).
//
// claude 경로는 buildDispatchCommand로 항상 `--inject`를 붙인다 -- 그래서
// `injected:false`는 "배정됨"과 "본문 주입됨"이 갈렸다는 비정상 신호다.
// codex 경로는 buildDispatchCommandNoInject로 `--inject`를 아예 안 붙인다 --
// 그래서 `injected:false`가 정상이다. 두 false를 같은 성공으로 취급하면
// PM M11이 지적한 혼동이 그대로 재현된다.
//
// engine은 orca-adapter.mjs의 ENGINE_BY_ROLE이 정본이다 -- 이 파일이
// orca-adapter.mjs를 import해 순환 의존을 만들지 않도록, 호출자가 이미
// 해석한 engine 문자열("claude"/"codex")을 받는다.
// ---------------------------------------------------------------------------
export const INJECTED_PROFILE_REASON = Object.freeze({
  NOT_APPLICABLE: "NOT_APPLICABLE",
  CLAUDE_INJECT_MISSING: "CLAUDE_INJECT_MISSING",
  UNSUPPORTED_ENGINE: "UNSUPPORTED_ENGINE",
  OK: "OK",
});

export function judgeInjectedProfile({ engine, shape, injected } = {}) {
  // dispatch-show 형태에는 injected 자체가 없다 -- 판정 대상이 아니다.
  if (shape !== DISPATCH_SHAPE.DISPATCH) {
    return { ok: true, reasonCode: INJECTED_PROFILE_REASON.NOT_APPLICABLE };
  }
  if (engine === "claude") {
    if (injected !== true) {
      return {
        ok: false,
        reasonCode: INJECTED_PROFILE_REASON.CLAUDE_INJECT_MISSING,
      };
    }
    return { ok: true, reasonCode: INJECTED_PROFILE_REASON.OK };
  }
  if (engine === "codex") {
    // codex는 injected:false가 정상이다(PM M11 핵심) -- false를 실패로
    // 취급하지 않는다. injected:true 쪽은 이 사이클 범위 밖(추정 금지,
    // 판단 보류만 하고 실패로 만들지 않는다).
    return { ok: true, reasonCode: INJECTED_PROFILE_REASON.OK };
  }
  return { ok: false, reasonCode: INJECTED_PROFILE_REASON.UNSUPPORTED_ENGINE };
}

// ---------------------------------------------------------------------------
// 2-B. normalizeSeatCreation(rawResponse)
// -> seat-registry.mjs의 normalizeSeatRecord/recordSeatCreation이 받아들이는
//    "생성 응답" 모양(출처 표지 = paneKey가 non-empty string). 실패 시
//    호출자는 normalizeSeatRecord를 부르지 않아야 한다 -- 이 함수가 먼저
//    접는다(§2-B 비타협2: "normalizeSeatRecord에 넘겨서 거기서 거르게 하지
//    말 것").
// ---------------------------------------------------------------------------
export function normalizeSeatCreation(rawResponse) {
  const raw = isPlainObject(rawResponse) ? rawResponse : {};

  const terminal =
    isPlainObject(raw.result) && isPlainObject(raw.result.terminal)
      ? raw.result.terminal
      : null;

  // 비타협3: terminal-list 응답은 result.terminals(복수, 배열)이지
  // result.terminal(단수, 객체)이 아니다 -- 구조가 달라 여기서 자연히
  // 걸린다(위장 불가).
  if (terminal === null) {
    return {
      ok: false,
      reasonCode: SEAT_CREATION_REASON.NO_TERMINAL_ENVELOPE,
    };
  }

  if (!isNonEmptyString(terminal.paneKey)) {
    return { ok: false, reasonCode: SEAT_CREATION_REASON.MISSING_PANE_KEY };
  }

  // 비타협1: result.terminal에 실제로 존재하는 필드만 옮긴다. 없는 필드는
  // 키 자체를 만들지 않는다(4b-2b-1 review-2가 잡은 `{...row, x: undefined}`
  // 우회로를 여기서도 열지 않는다).
  //
  // KNOWN_GAP(coder-task.md §1-C/§2-B4): leafId/worktreePath/role/taskId/
  // dispatchId는 생성 응답에 없다 -- 이 함수가 만들지 않고, 이후
  // normalizeSeatRecord가 null로 채운다. taskId/dispatchId를 무엇이 채워야
  // 하는지(=별도 권위 영수증인 배정 응답)는 다음 사이클 몫이다.
  const creationInput = {};
  for (const field of ["ptyId", "handle", "tabId", "paneKey", "worktreeId"]) {
    if (isNonEmptyString(terminal[field])) {
      creationInput[field] = terminal[field];
    }
  }

  return {
    ok: true,
    creationInput,
    reasonCode: SEAT_CREATION_REASON.VALID,
  };
}

// ---------------------------------------------------------------------------
// 2-C. normalizeObservedSeat(rawTerminalListRow)
// -> judgeDispatchCorrelation의 observed 인자가 요구하는
//    { adoptionObservable, tabId, leafId }만 낸다. taskId/dispatchId는
//    terminal-list 행에 없으므로 이 함수가 지어내지 않는다 -- 호출자가
//    명시적으로 병합해 주입해야 한다(§2-C 비타협3, KNOWN_GAP).
// ---------------------------------------------------------------------------

// 미채택 좌석의 폴백 형태(coder-task.md §1-D 실측): "pty:<worktreeId>@@<hash>"
function isUnadoptedFallbackForm(v) {
  return v.startsWith("pty:") || v.includes("@@");
}

function computeAdoptionObservable(tabId, leafId) {
  if (!isNonEmptyString(tabId) || !isNonEmptyString(leafId)) return false;
  if (tabId === leafId) return false;
  if (isUnadoptedFallbackForm(tabId) || isUnadoptedFallbackForm(leafId)) {
    return false;
  }
  return true;
}

export function normalizeObservedSeat(rawTerminalListRow) {
  const row = isPlainObject(rawTerminalListRow) ? rawTerminalListRow : {};

  // 비타협2: title/preview는 절대 참조하지 않는다(게이트 S8 -- 화면
  // 문자열로 판정하지 않는다).
  const tabId = isNonEmptyString(row.tabId) ? row.tabId : null;
  const leafId = isNonEmptyString(row.leafId) ? row.leafId : null;

  return {
    adoptionObservable: computeAdoptionObservable(tabId, leafId),
    tabId,
    leafId,
    // taskId/dispatchId 없음(§2-C 비타협3) -- 호출자가
    // { ...normalizeObservedSeat(row), taskId, dispatchId }로 명시 병합해야
    // 코어가 PROVEN을 낼 수 있다(주입 없으면 SEAT_RECORD_INCOMPLETE 등으로
    // UNPROVEN).
  };
}
