// HYK-171 사이클4b-2c (coder-task.md §2-B) -- 배정 결속 좌석 증명
// (dispatch-bound seat proof) 순수 판정.
//
// ★ 증명 범위(§0 비타협, 설계게이트 결선): 이것은 "우리가 이 좌석을
// 만들었다"의 증명이 **아니다**. 증명하는 것은 "Orca가 이 task/dispatch를
// 이 좌석에 배정했고, 그 좌석의 pty/worktree가 이것이다"뿐이다. 이 파일과
// 관련 산출물에 "생성 영수증(creation receipt)"이라는 이름을 쓰지 않는다.
// 기존 `creationResponse`/`recordSeatCreation` 레코드에 끼워넣지 않는다.
//
// 결속점(§1 실측, ORCH가 착수 전 직접 포획): `dispatch-show`의
// `assignee_pane_key`가 `terminal show`의 `${tabId}:${leafId}`
// (paneKeyFromShow)와 문자 완전 일치한다. 이 파일은 그 일치와, 대상
// task/dispatch/worktree가 호출자가 기대한 것과 같은지를 대조할 뿐이다.
//
// 비타협:
// - `policy` 완화 입력을 받지 않는다(`minCorroboration` 류의 안전장치를
//   끄는 매개변수 금지 -- 4b-2b-1 사고 재발 방지).
// - `terminal list` 행을 입력으로 받지 않는다 -- terminalShow는 반드시
//   terminal-show-adapter.mjs의 `normalizeTerminalShow` 출력(ok:true)이어야
//   한다(list 폴백 형태는 그 어댑터에서 이미 거부된다).
// - 시간 비교 판정 0(§1 UTC 함정 -- `dispatched_at`은 로컬 시계와 비교하지
//   않는다. 이 함수는 시각 필드를 아예 읽지 않는다).
// - `expected.*`가 하나라도 결손이면 판정 불가(`UNPROVEN`) -- 기본값으로
//   통과시키지 않는다.
//
// 순수 함수: I/O 없음, `orca` CLI를 실행하지 않는다, 전역 상태를 읽지
// 않는다.
//
// ★HYK-294 (2026-08-17) -- handle 축을 판정에서 뺐다.
// ⓵ 무엇을 뺐나: `assigneeHandle`과 `terminalShow.handle`을 대조하던
//   비교(구 HANDLE_MISMATCH 분기, buildMismatchChecks 표의 그 행)를
//   findMismatchReason의 판정 경로에서 제거했다. `SEAT_PROOF_REASON.
//   HANDLE_MISMATCH` 상수 자체는 계약 표면(seat-proof-contract-v1.mjs)의
//   동결 키 집합을 건드리지 않기 위해 남겨두지만, 이 판정 함수는 더 이상
//   그 값을 반환하지 않는다(도달 불가 -- 진단 필드로도 쓰지 않는다).
// ⓶ 왜: handle은 회전한다 -- ⓐ벤더 규정(재접속 시 handle 재발급) ⓑ워커
//   기동 규칙 §0("handle 비교는 쓰지 않는다 -- 재시작 시 회전되는 값이라
//   신뢰할 수 없다") ⓒ2026-08-17 이 사이클 안 실측 재현(주입
//   `term_75dd220d…` vs 현재 `term_9e5524d9…`, 같은 `tabId:leafId`) --
//   세 겹으로 확인된 값을 PROVEN의 필수 조건으로 두면, 정당하게 회전한
//   좌석의 정당한 배달을 거짓 UNPROVEN으로 반려한다(강제가 아니라
//   「거짓 안전」).
// ⓷ 남는 축이 보장하는 것과 보장하지 않는 것: 남는 축(pane key 완전 일치
//   + terminalShow의 퇴화 형태 거부 + task/dispatch/worktree exact match)
//   은 "Orca가 이 task/dispatch를 배정한 좌석의 pty/worktree가 지금 이
//   응답과 같다"만 보증한다. handle 값 자체가 그 좌석을 가리키는지는 더
//   이상 이 함수가 대조하지 않는다 -- handle은 여전히 호출자가 진단·로그
//   목적으로 원시 응답에서 읽을 수 있지만(어댑터가 값 자체를 지우지는
//   않는다), 이 판정의 PROVEN/UNPROVEN에는 관여하지 않는다.

export const SEAT_PROOF = Object.freeze({
  PROVEN: "PROVEN",
  UNPROVEN: "UNPROVEN",
});

export const SEAT_PROOF_REASON = Object.freeze({
  DISPATCH_SHOW_INVALID: "DISPATCH_SHOW_INVALID",
  TERMINAL_SHOW_INVALID: "TERMINAL_SHOW_INVALID",
  EXPECTED_FIELDS_MISSING: "EXPECTED_FIELDS_MISSING",
  PANE_KEY_MISMATCH: "PANE_KEY_MISMATCH",
  HANDLE_MISMATCH: "HANDLE_MISMATCH",
  TASK_ID_MISMATCH: "TASK_ID_MISMATCH",
  DISPATCH_ID_MISMATCH: "DISPATCH_ID_MISMATCH",
  WORKTREE_MISMATCH: "WORKTREE_MISMATCH",
  PROVEN: "PROVEN",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// HYK-299-casefold-1 -- 경로 동등성 판정.
//
// 배경(실배달 사고): 관제실 `dispatch-worker.ps1`의 `Norm()`은 워크트리
// 경로를 넘길 때 소문자화까지 한다(`\` -> `/`, 끝 `/` 제거, `ToLowerInvariant()`).
// 그런데 `terminal show`가 돌려주는 `worktreePath`/`worktreeId`는 대소문자가
// 살아 있다. 기존 판정은 `!==` 문자 완전 일치라 정상 배달이 WORKTREE_MISMATCH로
// 거부됐다(2026-08-19 실배달, .harness/evidence/hyk299-seatproof-*.json).
//
// ★"윈도우 드라이브문자 절대경로 모양"일 때만 대소문자를 무시한다 --
// 무조건 대소문자 무시로 바꾸면 대소문자를 구별하는 파일시스템(리눅스, CI가
// 도는 곳)에서 `/srv/Foo`와 `/srv/foo`처럼 실제로 다른 두 디렉터리를 같다고
// 판정해 탐지력을 깎는다. `C:/...` 모양은 윈도우 경로 표기이고 윈도우
// 파일시스템에서 대소문자는 정보를 담지 않으므로, 그 모양에 한해 무시하는
// 것은 탐지력을 깎지 않는다. 기준은 "판정하는 쪽의 OS"가 아니라 "경로 자체의
// 모양"이다(관제실=윈도우, CI=리눅스가 같은 입력을 판정할 수 있다).
const WINDOWS_DRIVE_ABSOLUTE_PATH_RE = /^[A-Za-z]:\//;

function normalizePathSlashes(p) {
  if (typeof p !== "string") return p;
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function pathsEqual(a, b) {
  const na = normalizePathSlashes(a);
  const nb = normalizePathSlashes(b);
  if (
    typeof na === "string" &&
    typeof nb === "string" &&
    WINDOWS_DRIVE_ABSOLUTE_PATH_RE.test(na) &&
    WINDOWS_DRIVE_ABSOLUTE_PATH_RE.test(nb)
  ) {
    return na.toLowerCase() === nb.toLowerCase();
  }
  // 윈도우 드라이브문자 모양이 아니면(POSIX 절대경로 등) 정규화도 하지
  // 않는다 -- 기존 그대로 문자 완전 일치.
  return a === b;
}

// worktreeId는 `<repoId>::<path>` 모양이다. `::`로 갈라 repoId(GUID, 대소문자
// 무시)와 path(위 경로 규칙)를 따로 비교한다. `::`가 없으면 전체를 하나의
// 값으로 보고 경로 규칙을 그대로 적용한다.
function splitWorktreeId(id) {
  if (typeof id !== "string") return null;
  const idx = id.indexOf("::");
  if (idx === -1) return null;
  return { repoId: id.slice(0, idx), path: id.slice(idx + 2) };
}

function worktreeIdsEqual(a, b) {
  const pa = splitWorktreeId(a);
  const pb = splitWorktreeId(b);
  if (pa && pb) {
    return (
      pa.repoId.toLowerCase() === pb.repoId.toLowerCase() &&
      pathsEqual(pa.path, pb.path)
    );
  }
  return pathsEqual(a, b);
}

function verdict(kind, reasonCode) {
  return { verdict: kind, reasonCode };
}

// dispatch-correlation-adapter.mjs의 normalizeDispatchShow 출력 계약
// (재사용 -- 그 파일은 수정하지 않는다). assigneeHandle은 그 어댑터에서
// 옵션 필드다(§2-A 주석: "handle은 회전한다") -- ★HYK-294로 이 함수는
// assigneeHandle을 판정에 아예 쓰지 않는다(파일 머리 주석 참조). 있어도
// 없어도 findMismatchReason은 그 값을 보지 않는다.
function hasValidDispatchShow(ds) {
  return (
    ds.ok === true &&
    isNonEmptyString(ds.taskId) &&
    isNonEmptyString(ds.dispatchId) &&
    isNonEmptyString(ds.assigneePaneKey)
  );
}

// terminal-show-adapter.mjs의 normalizeTerminalShow 출력 계약(ok:true인
// 것만 통과 -- fallback-form/필드결손은 그 어댑터가 이미 거른다).
function hasValidTerminalShow(ts) {
  return (
    ts.ok === true &&
    isNonEmptyString(ts.handle) &&
    isNonEmptyString(ts.paneKeyFromShow) &&
    isNonEmptyString(ts.worktreeId) &&
    isNonEmptyString(ts.worktreePath)
  );
}

// §2-B5: harnessTaskId/runtimeTaskId/dispatchId/worktreeId/worktreePath
// 다섯 필드가 전부 non-empty string이어야 판정 대상이 된다. harnessTaskId는
// dispatchShow/terminalShow 어느 쪽에도 대응 필드가 없다(둘 다 Orca 런타임
// task id만 안다) -- 그래도 호출자가 "이 판정이 어느 하네스 작업에 대한
// 것인지" 명시하도록 강제한다(미제공 시 판정 불가), 단 대조 대상이 없으므로
// 값 자체를 다른 무엇과 비교하지는 않는다.
function hasCompleteExpected(expected) {
  return (
    isNonEmptyString(expected.harnessTaskId) &&
    isNonEmptyString(expected.runtimeTaskId) &&
    isNonEmptyString(expected.dispatchId) &&
    isNonEmptyString(expected.worktreeId) &&
    isNonEmptyString(expected.worktreePath)
  );
}

// §2-B3~6의 exact-match 비교를 표로 선언한다(각 행 = [실패조건, 사유코드]).
// 순서가 판정 우선순위다(첫 실패가 그대로 결과 사유가 된다). ★HYK-294로
// handle 비교 행을 이 표에서 뺐다(파일 머리 주석 참조) -- 남은 비교는
// 전부 그대로다(어떤 것도 생략·완화하지 않는다).
function buildMismatchChecks(ds, ts, exp) {
  return [
    // §1 결속점: assignee_pane_key === `${tabId}:${leafId}` 문자 완전 일치.
    [
      ds.assigneePaneKey !== ts.paneKeyFromShow,
      SEAT_PROOF_REASON.PANE_KEY_MISMATCH,
    ],
    [exp.runtimeTaskId !== ds.taskId, SEAT_PROOF_REASON.TASK_ID_MISMATCH],
    [exp.dispatchId !== ds.dispatchId, SEAT_PROOF_REASON.DISPATCH_ID_MISMATCH],
    [
      !worktreeIdsEqual(exp.worktreeId, ts.worktreeId) ||
        !pathsEqual(exp.worktreePath, ts.worktreePath),
      SEAT_PROOF_REASON.WORKTREE_MISMATCH,
    ],
  ];
}

function findMismatchReason(ds, ts, exp) {
  for (const [failed, reasonCode] of buildMismatchChecks(ds, ts, exp)) {
    if (failed) return reasonCode;
  }
  return null;
}

// judgeDispatchBoundSeatProof({ dispatchShow, terminalShow, expected })
// -> { verdict: PROVEN|UNPROVEN, reasonCode }.
//
// PROVEN은 다음 전부가 성립할 때만(★HYK-294로 구 4번 handle 비교는 뺐다):
// 1. dispatchShow 정규화 성공
// 2. terminalShow 정규화 성공(퇴화 형태는 이 단계에서 이미 거부됨)
// 3. assigneePaneKey === paneKeyFromShow(문자 완전 일치)
// 4. expected.harnessTaskId/runtimeTaskId/dispatchId 전부 제공 및
//    runtimeTaskId/dispatchId는 dispatchShow와 exact 일치
// 5. expected.worktreeId/worktreePath가 terminalShow와 exact 일치
export function judgeDispatchBoundSeatProof({
  dispatchShow,
  terminalShow,
  expected,
} = {}) {
  const ds = isPlainObject(dispatchShow) ? dispatchShow : {};
  const ts = isPlainObject(terminalShow) ? terminalShow : {};
  const exp = isPlainObject(expected) ? expected : {};

  if (!hasValidDispatchShow(ds)) {
    return verdict(
      SEAT_PROOF.UNPROVEN,
      SEAT_PROOF_REASON.DISPATCH_SHOW_INVALID,
    );
  }

  if (!hasValidTerminalShow(ts)) {
    return verdict(
      SEAT_PROOF.UNPROVEN,
      SEAT_PROOF_REASON.TERMINAL_SHOW_INVALID,
    );
  }

  if (!hasCompleteExpected(exp)) {
    return verdict(
      SEAT_PROOF.UNPROVEN,
      SEAT_PROOF_REASON.EXPECTED_FIELDS_MISSING,
    );
  }

  const mismatchReason = findMismatchReason(ds, ts, exp);
  if (mismatchReason) {
    return verdict(SEAT_PROOF.UNPROVEN, mismatchReason);
  }

  return verdict(SEAT_PROOF.PROVEN, SEAT_PROOF_REASON.PROVEN);
}
