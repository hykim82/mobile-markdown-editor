import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  buildTaskCreateCommand,
  buildDispatchCommand,
  buildDispatchCommandNoInject,
  parseRuntimeTaskId,
  assertAllowedOrcaCommand,
} from "../orca-spike-runner.mjs";
import { buildSpec } from "../orca-predispatch.mjs";
import { normalizeAbsolute } from "../../check/path-normalize.mjs";
import {
  judgeTeardown,
  judgePostConditions,
  EXECUTION as TEARDOWN_EXECUTION,
} from "../teardown-core.mjs";
import { observeTeardownInventory } from "./teardown-inventory-adapter.mjs";
import {
  loadRegistry,
  saveRegistry,
  recordSeatDispatch,
  recordSeatCreation,
  recordNonWorkerSeatObservation,
  findByPtyId,
  NOT_WORKER_SEAT_ROLE,
} from "../seat-registry.mjs";
import {
  normalizeDispatchRawUnion,
  judgeInjectedProfile,
  normalizeDispatchShow,
} from "./dispatch-correlation-adapter.mjs";
import { judgeDispatchPostcheck } from "./dispatch-postcheck-core.mjs";
// HYK-413-seat-binding §2⑴: reuse relay-handshake.mjs's own
// receipt-ledger-path resolution and JSONL reader (HYK-387 3R hardened
// ABSENT-vs-LOOKUP_FAILED, ENOENT-vs-real-error) instead of re-deriving
// them here -- see resolveCandidateFromReceiptLedger below.
import {
  resolveDispatchLedgerPath,
  readDispatchLedgerRecords,
} from "../../check/relay-handshake.mjs";

// HYK-169-coder-1: 어댑터 B v1 -- `orca` CLI를 실제로 부르는(spawn) 코드는
// **이 파일에만** 있다(G9). 코어(relay-core.mjs)·CLI(run-step.mjs)는 이 파일이
// 내보내는 포트 4종만 호출하고, `orca` 문자열을 직접 다루지 않는다.
//
// 포트 이름은 HYK-167 pm-1 §2.1 승계: ensureSeat(실행자리) / deliverTask(배달) /
// collectCompletionSignals(감지, 비권위) / teardownSeat(생애주기).
//
// 검증 수준 (정직 요구): task-create/dispatch/check --wait의 argv 형태는
// orca-spike-runner.mjs가 ORCH의 실측(read-only 프로브 + `--help`)으로 이미
// 검증한 값이라 그대로 import해 재사용한다(재구현 금지). HYK-170 coder-1
// (2026-07-22): v1이 "미검증 가정"으로 남겼던 좌석 생성·제출·비차단 조회·
// 좌석 종료·워크트리 생성/제거 6개 함수는 ORCH의 실 CLI 프로브(`--help` +
// 사람 승인 하 합성 워크트리 1회 프로브, 관제실 산출물
// `2026-07-22-hyk170-어댑터Bv2/`)로 전부 실측 근거를 확보했다 -- 추측 argv
// 0. `--agent` 경로(`result.agentTerminalHandle`)만 이번 프로브 범위 밖이라
// 여전히 미실측이며 구현되지 않았다(정직 경계).
//
// HYK-185-seat-multi (coder-task.md, 한용 확정 "안 1"): 좌석이 2개 이상인
// 워크트리(CODER+REVIEW 동거는 표준 구성이지 예외가 아니다)가
// resolveSeatLivenessCandidate 하나를 세 감시 축(seatLiveness/seatIdle/
// dispatchStart)이 공유해 동시에 눈머는 사고를 고쳤다 -- 관측층만
// 넓혔다(collectSeatObservationsForWorktree, 아래): 이 함수는 후보가
// 2개 이상이어도 거부하지 않고 전부 돌려준다. 판정 축의 재배선은
// "방치(seatIdle)" 축까지만 그 사이클에서 했다(orch-stall-detect.mjs
// judgeSeatIdleForRepo 참조).
//
// HYK-185-seat-corr(coder-task.md §2, 검토자 실측 경로로 재개): "배달과
// 결부된" 두 축(seatLiveness/dispatchStart)의 신원 해석("그 배달이 간
// 좌석은 어디인가")은 위 QUESTION이 막았던 "실행시각 task id를 어디서도
// 모른다"는 전제 자체가 틀렸다는 검토자의 실측(task-list --json의
// `spec` 필드가 하네스 라벨과 워크트리 경로를 **함께** 담고 있다, ORCH
// 라이브 조회로 재확인)으로 다시 열렸다. 새 저장 상태를 신설하지 않고
// (비타협 그대로) 기존 런타임 조회 3단만 이어붙인다(resolveDeliveredSeat,
// 아래): ①`task-list --status dispatched`에서 라벨+워크트리 경로가 spec에
// 함께 있는 후보를 정확히 하나로 좁히고, ②그 후보의 `dispatch-show`로
// `assignee_pane_key`를 얻고, ③그 열쇠를 이 워크트리의 살아 있는 좌석
// 목록과 대조해 정확히 하나가 맞을 때만 지목한다. 후보가 0개/2개+ 이거나
// 대조가 죽은 좌석만 가리키면(ORCH 실측: 표본 6/6이 죽은 좌석) 여전히
// 실패로 드러낸다 -- resolveSeatLivenessCandidate 자체는 손대지 않았고
// (여전히 2개 이상이면 AMBIGUOUS), orch-stall-detect.mjs가 그 AMBIGUOUS
// 실패 하나에 한해서만 이 대조를 시도하는 재시도 경로로 얹는다(다른
// 실패 사유는 "좌석이 여럿이라 못 골랐다"는 문제가 아니므로 재시도하지
// 않는다 -- 회귀 방지).
//
// HYK-413-seat-binding-1 (coder-task.md §1-§2, 위 ①단만 갱신): ①단의 1차
// 경로가 "ORCH가 손으로 쓰는 spec 산문"에서 "배달 시점에 기계가 쓰는
// dispatch-receipts.jsonl"로 옮겨졌다 -- 그 원장은 이미 harness_task_label
// -> runtime_task_id를 자유 텍스트 파싱 없이 직접 잇는다(dispatch-receipt-
// cli.mjs). spec 매칭(옛 ①단)은 원장 조회 "자체"가 인프라 사유로 실패했을
// 때만(경로 미해결/읽기 실패) 물러나 쓰는 보조 경로로 강등됐다 -- 원장이
// 답했는데 이 라벨과 안 맞으면(0건/2건+/손상) 그대로 실패로 드러내고
// spec으로 넘어가지 않는다(fail-open 금지). ②③단은 이 라운드에서 손대지
// 않았다. 상세는 resolveCandidateFromReceiptLedger/
// resolveCandidateDispatchTask 헤더 참조.
//
// ⚠️벤더 형식 의존(코더-task.md "pane key 형식 의존"): `assignee_pane_key`
// (dispatch-show)는 `${tabId}:${leafId}`(terminal show, paneKeyFromShow)와
// 문자 완전 일치하는 것으로 ORCH가 2회 관측했다(dispatch-bound-seat-
// proof.mjs §1) -- 이건 **벤더 형식이며 우리 보증이 아니다**. 그 형식
// 단언은 terminal-show-adapter.test.mjs("정상 경로: ... paneKeyFromShow를
// 그대로 반환한다", `paneKeyFromShow === \`${tabId}:${leafId}\``)가 이미
// 고정하고 있고, resolveDeliveredSeat(아래)의 대조도 정확히 같은 형식을
// 쓴다 -- 이 파일 자신의 별도 단언은
// orca-adapter.test.mjs("resolveDeliveredSeat: live seat pane key is
// `${tabId}:${leafId}` -- breaks red if the vendor format changes")가
// 진다(docs/enforcement-known-gaps.md gap#85).

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function errText(err) {
  try {
    if (err && typeof err === "object" && typeof err.message === "string") {
      return err.message;
    }
    return String(err);
  } catch {
    return "unknown error (message accessor threw)";
  }
}

export const REASON = Object.freeze({
  WORKTREE_SETUP_FAILED: "WORKTREE_SETUP_FAILED",
  SEAT_CREATE_FAILED: "SEAT_CREATE_FAILED",
  TASK_CREATE_FAILED: "TASK_CREATE_FAILED",
  DISPATCH_FAILED: "DISPATCH_FAILED",
  PASTE_UNCONFIRMED: "PASTE_UNCONFIRMED",
  SUBMIT_FAILED: "SUBMIT_FAILED",
  TEARDOWN_FAILED: "TEARDOWN_FAILED",
  // HYK-170 사이클2 ②-b coder-1 (D11-C): codex text/Enter 응답이 불명확한
  // 실패(응답 유실류)일 때 쓴다 -- 이 사유는 자동 재시도를 만들지 않는다
  // (submitWithRetry류 부작용 자동재시도 의미 폐기, at-most-once).
  DELIVERY_UNJUDGABLE: "DELIVERY_UNJUDGABLE",
  UNSUPPORTED_PROFILE: "UNSUPPORTED_PROFILE",
  COMPLETE: "COMPLETE",
});

// ---- B9: 엔진별 좌석 실행 정책(단일 구성 지점 -- 하드코딩 분산 금지) ----
export const ENGINE_BY_ROLE = Object.freeze({
  CODER: "claude",
  REVIEW: "codex",
  VERIFY: "claude",
});

// 현행 런처(관측 A2/A3/A5/B7/B9/B10 소진 지점, 관제실 관리) -- 그대로 호출하는
// 것도 허용됨(태스크 지시). 좌석은 이 스크립트를 실행하는 셸로 뜬다.
export const SEAT_LAUNCHER_PATH =
  "D:\\문서관리\\하네스-관제실\\orca-worker-seat.ps1";

// ---- HYK-169-coder-2: 좌석 위치 정책 (relay-terminal-setup.md §6, 2026-07-22
// 사람 확정) -- 어댑터가 강제한다(문서 규약이 아니라 코드). 근거=HYK-164
// 사고(REVIEW가 관제실 PM/relay 아래에 검증 워크트리를 만들어 경로 판정이
// 깨짐)+HYK-168 첫 실전(REVIEW가 메인 repo에서 실행 = ORCH와 같은 폴더).
export const LOCATION_REASON = Object.freeze({
  ROLE_UNKNOWN: "ROLE_UNKNOWN",
  PATH_REQUIRED: "PATH_REQUIRED",
  MAIN_REPO_FORBIDDEN: "MAIN_REPO_FORBIDDEN",
  CONTROL_ROOM_FORBIDDEN: "CONTROL_ROOM_FORBIDDEN",
  OUTSIDE_WORKSPACES: "OUTSIDE_WORKSPACES",
  WORKSPACES_ROOT_NOT_A_WORKTREE: "WORKSPACES_ROOT_NOT_A_WORKTREE",
  ALLOW: "ALLOW",
});

export const WORKSPACES_ROOT = "C:/Users/Administrator/orca/workspaces";
export const MAIN_REPO_PATH =
  "C:/Users/Administrator/Documents/HARNESSENGINEERING";
export const CONTROL_ROOM_PATH = "D:/문서관리/하네스-관제실";

function denyLocation(reason, detail) {
  return { ok: false, reason, detail };
}

// 대소문자·슬래시 방향·후행 슬래시·`..` 포함까지 정규화한 뒤 비교한다
// (path-normalize.mjs의 normalizeAbsolute 재사용 -- 재구현 금지, HYK-164가
// 이미 겪은 "체크아웃 위치 민감성" 계열 버그를 또 만들지 않는다). 단순
// startsWith 문자열 비교였다면
// `...\orca\workspaces\..\..\Documents\HARNESSENGINEERING`처럼 접두어만
// 맞추고 실제로는 금지 구역을 가리키는 경로가 통과해버린다 -- normalize가
// `..` 세그먼트를 먼저 해소하므로 이 우회가 불가능하다.
//
// ctx: { role, requestedPath } -- 순수 판정, 파일시스템·orca 호출 없음
// (테스트 용이성을 위해 ensureSeat에서 분리).
export function resolveSeatLocation({ role, requestedPath } = {}) {
  if (!isNonEmptyString(role) || !ENGINE_BY_ROLE[role]) {
    return denyLocation(
      LOCATION_REASON.ROLE_UNKNOWN,
      `resolveSeatLocation: unknown role ${JSON.stringify(role)}`,
    );
  }
  if (!isNonEmptyString(requestedPath)) {
    return denyLocation(
      LOCATION_REASON.PATH_REQUIRED,
      "resolveSeatLocation: requestedPath is required",
    );
  }
  const normalized = normalizeAbsolute(requestedPath);
  const lower = normalized.toLowerCase();
  const mainRepoLower = MAIN_REPO_PATH.toLowerCase();
  const controlRoomLower = CONTROL_ROOM_PATH.toLowerCase();
  const workspacesLower = WORKSPACES_ROOT.toLowerCase();

  if (lower === controlRoomLower || lower.startsWith(`${controlRoomLower}/`)) {
    return denyLocation(
      LOCATION_REASON.CONTROL_ROOM_FORBIDDEN,
      `resolveSeatLocation: '${normalized}' is under the control room (${CONTROL_ROOM_PATH}) -- forbidden for all workers`,
    );
  }
  if (lower === mainRepoLower || lower.startsWith(`${mainRepoLower}/`)) {
    return denyLocation(
      LOCATION_REASON.MAIN_REPO_FORBIDDEN,
      `resolveSeatLocation: '${normalized}' is the main repo (${MAIN_REPO_PATH}) -- ORCH-only, workers forbidden`,
    );
  }
  if (!(lower === workspacesLower || lower.startsWith(`${workspacesLower}/`))) {
    return denyLocation(
      LOCATION_REASON.OUTSIDE_WORKSPACES,
      `resolveSeatLocation: '${normalized}' is outside the workspaces root (${WORKSPACES_ROOT})`,
    );
  }
  // review-2 (coder-4): the workspaces root itself is the parent folder, not
  // a worktree -- a seat opened directly there is not tied to any issue
  // checkout at all (B15's actual shape: a seat with no real worktree under
  // it is invisible to Orca's own bookkeeping).
  if (lower === workspacesLower) {
    return denyLocation(
      LOCATION_REASON.WORKSPACES_ROOT_NOT_A_WORKTREE,
      `resolveSeatLocation: '${normalized}' is the workspaces root itself, not a worktree -- a specific issue/verification subfolder is required`,
    );
  }
  return { ok: true, reason: LOCATION_REASON.ALLOW, path: normalized };
}

// ---- HYK-169-coder-4/5 (review-2/review-3 반려 결함 수리): Orca 관리
// 워크트리 확인 ----
// review-2 반려 사유: 위치 정책은 경로 "문자열"만 검사해 `git worktree add`로
// 만든 Orca 미등록 폴더도 조건만 맞으면 통과시켰다(B15 -- Orca가 모르는
// 워크트리에 붙은 좌석은 Orca UI에서 안 보이는 유령 터미널이 된다). 좌석을
// 열기 전에 `worktree list`로 대상 경로가 실제 등록돼 있는지 대조한다.
//
// coder-5 (review-3 반려, 사람 결정 2026-07-22): coder-4가 만든
// `buildWorktreeCreateCommand`(`--path` 옵션)는 **실제 CLI에 없는 옵션을
// 지어낸 것**이었다(실 CLI는 `--name` 기반) -- "실 orca 호출 0" 제약
// 아래서는 argv를 검증할 방법이 없어 추측이 틀렸다. **생성 기능은 v1
// 범위에서 제거한다** -- 워크트리 생성은 당분간 ORCH가 손으로 하고, 실물
// CLI 검증 후 별도 이슈(후속, ORCH가 신설)로 되돌아온다. 이 어댑터는
// "관리 워크트리인지 확인하고, 아니면 거부"까지만 한다(`allowCreate` 옵션·
// `buildWorktreeCreateCommand`·생성 분기 전부 삭제 -- 조용한 삭제 방지를
// 위해 이 주석에 사유를 남긴다).
// HYK-170 coder-1 (§B): 생성 기능 복원 -- v1이 제거했던 CREATE_FAILED류를
// 다시 추가한다(실측 근거로 조용히 되살리는 것이 아니라 이 주석에 사유를
// 남긴다). 생성 후 위치/등록 검증 중 하나라도 실패하면 만든 워크트리를
// 남기지 않고 되돌린다(fail-closed, createManagedWorktree의 rollback()).
// 되돌리기 자체의 성패는 `steps`에 문자열로 기록한다(정직 요구: 삼켜서
// "성공"처럼 보이게 하지 않는다) -- worktreeReason 자체는 원래 실패 사유
// (CREATE_LOCATION_REJECTED/CREATE_NOT_MANAGED_AFTER_CREATE)를 유지한다.
export const WORKTREE_REASON = Object.freeze({
  LIST_QUERY_FAILED: "WORKTREE_LIST_QUERY_FAILED",
  NOT_ORCA_MANAGED: "WORKTREE_NOT_ORCA_MANAGED",
  CREATE_FAILED: "WORKTREE_CREATE_FAILED",
  CREATE_LOCATION_REJECTED: "WORKTREE_CREATE_LOCATION_REJECTED",
  CREATE_NOT_MANAGED_AFTER_CREATE: "WORKTREE_CREATE_NOT_MANAGED_AFTER_CREATE",
});

export function buildWorktreeListCommand() {
  return ["worktree", "list", "--json"];
}

function denyWorktree(reason, detail) {
  return { ok: false, reason, detail };
}

// 응답 파싱만 분리(테스트 용이성 -- parseRuntimeTaskId 전례와 동형).
export function parseWorktreeList(response) {
  if (!isPlainObject(response) || response.ok !== true) return null;
  const list = Array.isArray(response.result?.worktrees)
    ? response.result.worktrees
    : null;
  return list;
}

function queryWorktreeList(opts) {
  if (typeof opts.execFn !== "function") {
    return denyWorktree(
      WORKTREE_REASON.LIST_QUERY_FAILED,
      "checkWorktreeManaged: opts.execFn is required to query worktree list",
    );
  }
  let response;
  try {
    response = opts.execFn(buildWorktreeListCommand());
  } catch (err) {
    return denyWorktree(
      WORKTREE_REASON.LIST_QUERY_FAILED,
      `checkWorktreeManaged: worktree list query threw (${errText(err)})`,
    );
  }
  const list = parseWorktreeList(response);
  if (!list) {
    return denyWorktree(
      WORKTREE_REASON.LIST_QUERY_FAILED,
      "checkWorktreeManaged: worktree list response missing/invalid result.worktrees",
    );
  }
  return { ok: true, list };
}

// coder-5 (review-3 반려 결함 수리): 드라이브 루트("C:/")는 그대로 두고,
// 그 밖의 모든 경로는 후행 `/`(정규화 후 백슬래시는 이미 슬래시로 바뀌어
// 있다)를 제거해 canonical 형태로 맞춘다. 이게 없으면 등록 목록의 경로가
// 후행 슬래시 유무만 다를 때(예: orca가 `.../wt/`로 보고하고 요청은
// `.../wt`) 실제로 등록된 워크트리를 잘못 거부한다(review-3 실제 재현).
function stripTrailingSeparator(normalized) {
  if (/^[a-zA-Z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

// 정규화(normalizeAbsolute 재사용, coder-2와 동일 원칙 -- 대소문자·슬래시·
// `..` 우회를 여기서도 다시 겪지 않는다) + 후행 구분자 제거 후 등록 목록과
// 대조.
function canonicalizeForComparison(rawPath) {
  return stripTrailingSeparator(normalizeAbsolute(rawPath).toLowerCase());
}

function isPathManaged(list, requestedPath) {
  const target = canonicalizeForComparison(requestedPath);
  return list.some(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.path) &&
      canonicalizeForComparison(entry.path) === target,
  );
}

// 순수 조합 함수 -- ctx: { requestedPath }, opts: { execFn }. 미등록 경로는
// **항상 거부**(coder-5: 생성 기능 v1 제거, 위 헤더 주석 참조) -- 호출자가
// 어떤 옵션을 넘겨도(예: 이전 `allowCreate`와 같은 이름의 인자) 무시되고
// 거부된다(생성 유도가 불가능함을 시험으로 고정).
export function checkWorktreeManaged({ requestedPath } = {}, opts = {}) {
  const listResult = queryWorktreeList(opts);
  if (!listResult.ok) return listResult;
  if (isPathManaged(listResult.list, requestedPath)) {
    return { ok: true, managed: true, path: requestedPath };
  }
  return denyWorktree(
    WORKTREE_REASON.NOT_ORCA_MANAGED,
    `checkWorktreeManaged: '${requestedPath}' is not a registered Orca worktree -- this port only checks registration, it does not create (see createManagedWorktree for the HYK-170 §B creation path)`,
  );
}

// ---- HYK-170 사이클2 coder-1 (A-1): 좌석 handle 해석 -- E1/E2/E3 근거
// (ORCH 실측, 이 파일 상단 헤더 주석 참조). handle을 기억·운반하지 않고,
// 매번 {role, worktreePath}로부터 `terminal list`를 조회해 그 자리에서
// 새로 해석한다("handle 회전 면역 좌석 참조"). worktreeId는 절대 쓰지
// 않는다(E2 -- 제거된 워크트리의 죽은 좌석이 worktreeId엔 남아 되살아난다).
// 후보는 worktreePath 정규화 일치(canonicalizeForComparison 재사용, coder-2/5
// 원칙 계승) + 고아 아님(isOrphanSeat 재사용)만으로 추린다.
// lastOutputAt/title/connected/writable/배열 순서로 자동 선택하지 않는다
// (정확히 1개일 때만 통과, 0개/2개+는 거부) -- E1(한 워크트리에 좌석이
// 여럿 붙는 게 통상 형태)이 그 이유다.
export const SEAT_HANDLE_REASON = Object.freeze({
  NOT_FOUND: "SEAT_HANDLE_NOT_FOUND",
  AMBIGUOUS: "SEAT_HANDLE_AMBIGUOUS",
  LIST_QUERY_FAILED: "SEAT_HANDLE_LIST_QUERY_FAILED",
});

export function buildTerminalListCommand() {
  return ["terminal", "list", "--json"];
}

// 응답 파싱만 분리(parseWorktreeList와 동형).
export function parseTerminalList(response) {
  if (!isPlainObject(response) || response.ok !== true) return null;
  const list = Array.isArray(response.result?.terminals)
    ? response.result.terminals
    : null;
  return list;
}

function denySeatHandle(seatHandleReason, detail) {
  return { ok: false, seatHandleReason, reason: detail };
}

// ctx: { role, worktreePath }. opts: { execFn }. 순수 조합 -- execFn 호출은
// terminal list 조회 1건뿐, 부작용(dispatch/send/close 등) 호출은 이
// 함수에서 절대 일어나지 않는다(A5 인수조건: 0개/2개+ 실패에서도 그렇다,
// 애초에 이 함수가 그런 호출을 만들지 않으므로).
export function resolveSeatHandle({ role, worktreePath } = {}, opts = {}) {
  const location = resolveSeatLocation({ role, requestedPath: worktreePath });
  if (!location.ok) {
    return {
      ok: false,
      reason: location.detail,
      locationReason: location.reason,
    };
  }
  const managed = checkWorktreeManaged({ requestedPath: worktreePath }, opts);
  if (!managed.ok) {
    return {
      ok: false,
      reason: managed.detail,
      worktreeReason: managed.reason,
    };
  }
  if (typeof opts.execFn !== "function") {
    return denySeatHandle(
      SEAT_HANDLE_REASON.LIST_QUERY_FAILED,
      "orca-adapter: resolveSeatHandle -- opts.execFn is required to query terminal list",
    );
  }
  let response;
  try {
    response = opts.execFn(buildTerminalListCommand());
  } catch (err) {
    return denySeatHandle(
      SEAT_HANDLE_REASON.LIST_QUERY_FAILED,
      `orca-adapter: resolveSeatHandle -- terminal list query threw (${errText(err)})`,
    );
  }
  const list = parseTerminalList(response);
  if (!list) {
    return denySeatHandle(
      SEAT_HANDLE_REASON.LIST_QUERY_FAILED,
      "orca-adapter: resolveSeatHandle -- terminal list response missing/invalid result.terminals",
    );
  }
  const target = canonicalizeForComparison(worktreePath);
  const candidates = list.filter(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.handle) &&
      !isOrphanSeat({ worktreePath: entry.worktreePath }) &&
      canonicalizeForComparison(entry.worktreePath) === target,
  );
  if (candidates.length === 0) {
    return denySeatHandle(
      SEAT_HANDLE_REASON.NOT_FOUND,
      `orca-adapter: resolveSeatHandle -- no seat found for worktreePath '${worktreePath}'`,
    );
  }
  if (candidates.length > 1) {
    return denySeatHandle(
      SEAT_HANDLE_REASON.AMBIGUOUS,
      `orca-adapter: resolveSeatHandle -- ${candidates.length} seats found for worktreePath '${worktreePath}', refusing to guess (E1)`,
    );
  }
  return { ok: true, handle: candidates[0].handle };
}

// ---- HYK-211-seat-select (coder-task.md §1/§2): 역할 결속 좌석 선별 ----
//
// 사고 원문(coder-task.md §1, HYK-211-seat-select-1 task): 같은 워크트리에
// CODER+REVIEW 두 좌석이 동석한 상태에서 관제실 `dispatch-worker.ps1`이
// "이 좌석이 진짜 에이전트인가"를 화면 preview 문자열로 추측하는 단계에서
// 작업자 좌석을 "에이전트 아님"으로 잘못 분류했다 -- 그 결과 검토자 좌석
// 하나만 남아 "유일 후보"가 됐고, 이미 있던 fail-loud 가드(0개/2개+ 거부)는
// 후보가 하나뿐이라 발동할 조건 자체가 사라졌다. 진짜 결함은 "가드가
// 없다"가 아니라 "가드보다 앞단의 분류가 틀리면 가드가 침묵한다" + "역할을
// 한 번도 대조하지 않는다"는 것이다.
//
// resolveSeatHandle(A-1, 위)은 worktreePath로만 후보를 좁혀 0개/2개+를
// 거부한다 -- 역할은 전혀 보지 않는다. 이 함수는 그 옆에 "역할까지
// 결속"하는 새 진입점을 추가한다(resolveSeatHandle 자체는 기존 호출자
// 회귀 방지를 위해 손대지 않는다, coder-task.md §3-4).
//
// ---- ★역할 신호의 출처 2R 교체(coder-task.md HYK-211-seat-select-2 §1
// P1-1, 검토자·ORCH 독립 확인 -- 1R의 title 앵커는 반려됐다) ----
// 1R은 `terminal list`/`terminal show`의 `title` 필드(좌석 생성 시
// buildSeatCreateCommand의 `--title <role>`로 우리가 심은 값)를 앵커로
// 썼다. **실측으로 깨졌다**: ORCH가 이 좌석 자신을
// `--title "CODER hyk211-seat-select"`로 만들었는데 실제 `orca terminal
// list`가 돌려준 title은 `✳ 동석 시 배달 좌석 오선별 봉인`(에이전트
// 셸/렌더러가 실행 중 title을 덮어썼다) -- 관제실 `dispatch-worker.ps1`
// 자신의 주석에도 이미 "title은 셸이 덮어써서 못 쓴다(E3)"라고 적혀
// 있었다. **`--title`을 심는 것과 `terminal list`가 그 값을 보존하는
// 것은 서로 다른 계약이고, 후자는 깨져 있다** -- 재배선을 해도 이 앵커로는
// 못 고른다("안전하지만 무력").
//
// **2R이 고른 것: `scripts/relay/seat-registry.mjs`(생성 대장).**
//   - 이미 `role`을 기록 필드로 갖고, `recordSeatCreation`/`loadRegistry`/
//     `saveRegistry`/`findByPtyId`를 export한다(재구현 금지, 재사용).
//   - **조인 키 = `ptyId`**. 검토자가 전수 열거한 `terminal list` 필드
//     합집합(branch/connected/handle/lastOutputAt/leafId/preview/ptyId/
//     tabId/title/worktreePath/worktreeId/writable) 중 `ptyId`는 좌석
//     "생성" 시점의 provenance 키다 -- seat-registry의 레코드도 좌석
//     생성 응답에서 뽑은 `ptyId`를 그대로 담는다(normalizeSeatRecord).
//     **버린 후보**: `title`/`preview` -- 둘 다 화면 문자열이고 위 실측대로
//     덮어써진다(정확히 P1-1이 깬 것과 같은 취약). `handle`은 좌석 생애
//     동안 회전할 수 있어(orca-adapter.mjs 상단 헤더 주석 "handle 회전
//     면역 좌석 참조" 원칙) 대장의 안정 키로 부적합하다.
//   - ⚠️★**정직 한계(숨기지 않는다, coder-task.md 명시 요구)**: **대장도
//     지금은 생산 코드가 아무도 안 쓴다**(ORCH 실측: 참조는 시험 fixture
//     1곳뿐 -- `createRealLaunchSink`가 `registryPath`를 받긴 하지만 그
//     유일한 실 호출부 launch-seam.mjs가 그 인자를 아직 넘기지 않는다).
//     즉 **이 조각만으로는 여전히 "거부"만 한다**(대장이 비어 있으면 모든
//     후보가 undetermined로 떨어져 항상 ROLE_UNDETERMINED). ★**그런데
//     title과 결정적으로 다르다**: **대장은 우리가 소유하고 우리가
//     쓴다** -- 좌석 생성 응답을 우리가 기록하면 **벤더가 덮어쓸 수
//     없다.** title은 벤더 UI/셸이 덮어쓰므로 **재배선해도 안 된다.**
//     ⇒ ***"아직 안 이어졌다"와 "이어도 안 된다"는 다르다*** -- 전자는
//     배선 작업(대장을 채우는 관제실 런처 재배선, 병합 후 ORCH가 실물
//     확인)만 남았다는 뜻이고, 후자는 메커니즘 자체가 구조적으로 불가능
//     하다는 뜻이다. 2R은 후자(title)를 버리고 전자(registry)로
//     옮겼다.
//
// ---- 선별 규칙(coder-task.md §3-1/§3-3, 1R에서 통과한 방어 그대로
// 승계 -- 앵커만 title -> registry로 바뀌었다) ----
// worktreePath로 좁힌 후보 전원(orphan 제외, resolveSeatHandle과 동일
// 필터)의 ptyId를 classifySeatRoleFromRegistry로 대장과 조인해 분류한다:
//   - 요청 role과 정확히 같음        -> matched
//   - 다른 KNOWN_SEAT_ROLES 값과 같음 -> (버림, "판별해 보니 아니었다" --
//     undetermined에 넣지 않는다)
//   - 그 외(ptyId 없음/대장에 없음/대장에 ptyId가 2개+ 중복/대장 role이
//     미지 문자열) -> undetermined
//
// ★§3-1 비타협 그대로: undetermined가 1개라도 있으면 matched가 정확히
// 1개여도 "유일 승자"를 선언하지 않는다(ROLE_UNDETERMINED로 거부).
// matched.length===0 && undetermined.length===0 -> NOT_FOUND. matched.length
// >=2 -> AMBIGUOUS(자동 선택 0, resolveSeatHandle의 fail-loud 원칙 계승).
export const KNOWN_SEAT_ROLES = Object.freeze([
  "CODER",
  "REVIEW",
  "VERIFY",
  "PM",
]);

export const ROLE_BOUND_SEAT_REASON = Object.freeze({
  NOT_FOUND: "ROLE_BOUND_SEAT_NOT_FOUND",
  AMBIGUOUS_ROLE_MATCH: "ROLE_BOUND_SEAT_AMBIGUOUS_ROLE_MATCH",
  ROLE_UNDETERMINED: "ROLE_BOUND_SEAT_ROLE_UNDETERMINED",
  LIST_QUERY_FAILED: "ROLE_BOUND_SEAT_LIST_QUERY_FAILED",
  REGISTRY_PATH_REQUIRED: "ROLE_BOUND_SEAT_REGISTRY_PATH_REQUIRED",
  REGISTRY_LOAD_FAILED: "ROLE_BOUND_SEAT_REGISTRY_LOAD_FAILED",
});

function denyRoleBoundSeat(roleBoundSeatReason, detail, extra = {}) {
  return { ok: false, roleBoundSeatReason, reason: detail, ...extra };
}

// 좌석 하나의 ptyId를 대장(seat-registry)과 조인해 역할로 분류한다.
// ptyId가 없거나(타입 아님/빈 문자열), 대장에 정확히 1개로 매치되지
// 않거나(0개=미기록·2개+=대장 데이터 자체가 애매), 매치된 레코드의
// role이 KNOWN_SEAT_ROLES 밖이면 전부 null("판별 불가", 위 헤더 주석의
// undetermined) -- 2개+ 매치를 "그중 하나겠지"로 추측하지 않는다(추측
// 금지 원칙 계승).
// HYK-213-seat-ledger: NOT_WORKER_SEAT_ROLE(observation-fact, "이 좌석은
// 워커가 아님을 우리가 관측해 기록했다")은 KNOWN_SEAT_ROLES 밖의 문자열
// 이지만 "판별 불가"(null)로 접지 않는다 -- 그 외 알려지지 않은 role
// 문자열(예: 데이터 오염)은 여전히 null로 접힌다(구분: "우리가 의도적으로
// 기록한 사실"과 "알 수 없는 값"은 다르다). partitionByRole(아래)에서
// 이 값은 요청 role과 절대 같지 않으므로 matched에도 들어가지 않고,
// null이 아니므로 undetermined에도 들어가지 않는다 -- 두 버킷 모두에서
// 깨끗이 빠진다(§2 두 번째 함정 회피의 핵심 지점).
export function classifySeatRoleFromRegistry(ptyId, registry) {
  if (typeof ptyId !== "string" || ptyId.length === 0) return null;
  const matches = findByPtyId(registry, ptyId);
  if (matches.length !== 1) return null;
  const role = matches[0].role;
  if (role === NOT_WORKER_SEAT_ROLE) return NOT_WORKER_SEAT_ROLE;
  return KNOWN_SEAT_ROLES.includes(role) ? role : null;
}

// worktreePath로 후보를 좁히는 부분만 분리(resolveSeatHandle과 동일 필터
// -- 고아 제외 + canonicalizeForComparison 일치). 여기서는 terminal list
// 조회 실패를 role-bound 전용 사유 코드로 접는다.
function collectRoleBoundCandidates(worktreePath, opts) {
  let response;
  try {
    response = opts.execFn(buildTerminalListCommand());
  } catch (err) {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.LIST_QUERY_FAILED,
      `orca-adapter: resolveRoleBoundSeatHandle -- terminal list query threw (${errText(err)})`,
    );
  }
  const list = parseTerminalList(response);
  if (!list) {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.LIST_QUERY_FAILED,
      "orca-adapter: resolveRoleBoundSeatHandle -- terminal list response missing/invalid result.terminals",
    );
  }
  const target = canonicalizeForComparison(worktreePath);
  const candidates = list.filter(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.handle) &&
      !isOrphanSeat({ worktreePath: entry.worktreePath }) &&
      canonicalizeForComparison(entry.worktreePath) === target,
  );
  return { ok: true, candidates };
}

// 후보 배열을 matched(요청 role과 대장 조인 결과가 정확히 같음)/
// undetermined(대장 조인으로 역할을 판별할 수 없음)로 나눈다. "다른
// 역할로 확정된" 후보는 어느 목록에도 들어가지 않는다(위 헤더 주석 --
// 판별 불가와 판별해서 다름은 다른 경우다).
function partitionByRole(candidates, role, registry) {
  const matched = [];
  const undetermined = [];
  for (const candidate of candidates) {
    const classified = classifySeatRoleFromRegistry(candidate.ptyId, registry);
    if (classified === role) matched.push(candidate);
    else if (classified === null) undetermined.push(candidate);
  }
  return { matched, undetermined };
}

// coder-task.md HYK-211-seat-select-2 §2-3(P2-3): 거부·선택 양쪽에서
// "어느 좌석이 어떤 역할로 판별됐는지"가 사람 눈에 보여야 한다 -- 후보
// 전원의 handle -> 판별된 역할("UNDETERMINED"면 그대로 표기) 매핑을
// 만든다. CLI(role-bound-seat-select-cli.mjs)가 이 배열을 그대로
// stdout에 렌더링한다(요건 2의 "그때 무엇이 보여야 하는가").
export function describeCandidateRoles(candidates, registry) {
  return candidates.map((candidate) => ({
    handle: candidate.handle,
    role:
      classifySeatRoleFromRegistry(candidate.ptyId, registry) ?? "UNDETERMINED",
  }));
}

// registryPath/registryFs 검증 + loadRegistry 호출만 분리(복잡도 분산 --
// resolveRoleBoundSeatHandle 자체의 ESLint complexity 상한 준수, quality-
// check.mjs가 강제).
function loadSeatRegistryForResolve(opts) {
  if (!isNonEmptyString(opts.registryPath)) {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.REGISTRY_PATH_REQUIRED,
      "orca-adapter: resolveRoleBoundSeatHandle -- opts.registryPath is required (seat-registry.mjs is the role anchor, see HYK-211-seat-select-2 §1 P1-1)",
    );
  }
  const registryFs = isPlainObject(opts.registryFs) ? opts.registryFs : {};
  const existsFn =
    typeof registryFs.existsFn === "function"
      ? registryFs.existsFn
      : existsSync;
  const readFn =
    typeof registryFs.readFn === "function"
      ? registryFs.readFn
      : (p) => readFileSync(p, "utf8");
  const loaded = loadRegistry(opts.registryPath, { existsFn, readFn });
  if (!loaded.ok) {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.REGISTRY_LOAD_FAILED,
      `orca-adapter: resolveRoleBoundSeatHandle -- seat registry load failed (${loaded.reason})`,
    );
  }
  return { ok: true, registry: loaded.registry };
}

// matched/undetermined + candidateRoles로부터 최종 판정을 내리는 부분만
// 분리(복잡도 분산). §3-1 비타협: 판별 불가 후보가 하나라도 있으면
// matched가 정확히 1개여도 유일 승자를 선언하지 않는다 -- 이 순서
// (undetermined를 matched.length 분기보다 먼저 본다)가 이번 사고의 형태
// ("앞단 분류가 틀리면 가드가 침묵한다")를 구조적으로 막는 지점이다.
function decideRoleBoundWinner({
  role,
  worktreePath,
  matched,
  undetermined,
  candidateRoles,
}) {
  const rolesText = candidateRoles
    .map((c) => `${c.handle}=${c.role}`)
    .join(",");
  if (undetermined.length > 0) {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.ROLE_UNDETERMINED,
      `orca-adapter: resolveRoleBoundSeatHandle -- ${undetermined.length} candidate(s) in worktree '${worktreePath}' have an undetermined role (no unique seat-registry match with a known role) -- refusing to declare a unique '${role}' winner while any candidate's role is unknown (roles=${rolesText})`,
      {
        matchedCount: matched.length,
        undeterminedCount: undetermined.length,
        candidateRoles,
      },
    );
  }
  if (matched.length > 1) {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.AMBIGUOUS_ROLE_MATCH,
      `orca-adapter: resolveRoleBoundSeatHandle -- ${matched.length} seats in worktree '${worktreePath}' registry-match '${role}', refusing to guess (roles=${rolesText})`,
      { matchedCount: matched.length, candidateRoles },
    );
  }
  if (matched.length === 0) {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.NOT_FOUND,
      `orca-adapter: resolveRoleBoundSeatHandle -- no seat registry-matches '${role}' for worktreePath '${worktreePath}' (roles=${rolesText})`,
      { candidateRoles },
    );
  }
  return { ok: true, handle: matched[0].handle, candidateRoles };
}

// ctx: { role, worktreePath }. opts: { execFn, registryPath, registryFs }.
// 순수 조합 -- execFn 호출은 terminal list 조회 1건뿐(resolveSeatHandle
// A-1과 동일), registryPath 읽기는 fs I/O 1건(부작용 0의 orca 호출과는
// 별개 -- 대장은 orca가 아니라 우리 자신의 로컬 기록이다).
export function resolveRoleBoundSeatHandle(
  { role, worktreePath } = {},
  opts = {},
) {
  const location = resolveSeatLocation({ role, requestedPath: worktreePath });
  if (!location.ok) {
    return {
      ok: false,
      reason: location.detail,
      locationReason: location.reason,
    };
  }
  const managed = checkWorktreeManaged({ requestedPath: worktreePath }, opts);
  if (!managed.ok) {
    return {
      ok: false,
      reason: managed.detail,
      worktreeReason: managed.reason,
    };
  }
  if (typeof opts.execFn !== "function") {
    return denyRoleBoundSeat(
      ROLE_BOUND_SEAT_REASON.LIST_QUERY_FAILED,
      "orca-adapter: resolveRoleBoundSeatHandle -- opts.execFn is required to query terminal list",
    );
  }
  const registryLoad = loadSeatRegistryForResolve(opts);
  if (!registryLoad.ok) return registryLoad;

  const collected = collectRoleBoundCandidates(worktreePath, opts);
  if (!collected.ok) return collected;

  const { matched, undetermined } = partitionByRole(
    collected.candidates,
    role,
    registryLoad.registry,
  );
  const candidateRoles = describeCandidateRoles(
    collected.candidates,
    registryLoad.registry,
  );

  return decideRoleBoundWinner({
    role,
    worktreePath,
    matched,
    undetermined,
    candidateRoles,
  });
}

// ---- HYK-213-seat-ledger (coder-task.md §1~§2): 좌석 생성 시 역할을 대장에
// 기입 + "판별 불가"를 추측이 아니라 기록으로 소멸 ----
//
// 실측(coder-task.md §1): `terminal create --json` 응답에는 role이 없다 --
// 호출자가 합쳐 넣어야 한다(normalizeSeatRecord/recordSeatCreation은 이미
// role 필드를 받지만, 아무도 채워 넣지 않았을 뿐이다). 그리고 대장을
// 완벽히 채워도 그 워크트리에 이미 있던("우리가 만들지 않은") 기본 탭이
// undetermined로 남으면 §3-1 가드(undetermined가 1개라도 있으면 유일
// 승자를 선언하지 않음)가 항상 발동해 항상 거부로 남는다(실측 재현,
// 위 §1 인용 그대로).
//
// 이 함수는 그 둘을 한 자리에서, 순서를 지켜 처리한다:
//   ① 생성 호출 "전"에 이 워크트리의 기존 후보를 관측한다 -- 우리 생성
//      호출이 아직 나가지 않은 시점이므로, 그 시점에 이미 있는 후보는
//      구조적으로(시간 순서상) 우리가 만드는 좌석일 수 없다. **화면
//      문자열(title/preview)은 전혀 보지 않는다** -- 관측하는 값은
//      ptyId/handle/worktreePath뿐이다(§4 비타협1). 각 후보를
//      recordNonWorkerSeatObservation으로 "워커 아님"으로 기록한다 --
//      그 시점에 실제로 관측한 후보만 기록되고, 관측되지 않은(예: 나중에
//      따로 생긴) 후보는 여전히 미기록 상태로 undetermined로 남는다(§4
//      비타협2 -- "대장에 없음=무시"가 되지 않는다).
//   ② `terminal create`를 실행하고, 그 권위 응답에 role을 합쳐
//      recordSeatCreation으로 새 워커 좌석을 기록한다.
// 두 단계 모두 반영한 대장을 마지막에 한 번만 저장한다(saveRegistry의
// tmp+rename로 원자성 근사, 기존 전례 계승).
export const SEAT_CREATE_LEDGER_REASON = Object.freeze({
  INPUT_INVALID: "SEAT_CREATE_LEDGER_INPUT_INVALID",
  REGISTRY_LOAD_FAILED: "SEAT_CREATE_LEDGER_REGISTRY_LOAD_FAILED",
  PRE_EXISTING_LIST_QUERY_FAILED:
    "SEAT_CREATE_LEDGER_PRE_EXISTING_LIST_QUERY_FAILED",
  PRE_EXISTING_RECORD_FAILED: "SEAT_CREATE_LEDGER_PRE_EXISTING_RECORD_FAILED",
  CREATE_FAILED: "SEAT_CREATE_LEDGER_CREATE_FAILED",
  // HYK-213-seat-ledger 2R (검토 P1-1 수리): `terminal create`는 ok:true를
  // 반환했지만 그 응답에 recordSeatCreation이 요구하는 provenance 표지
  // (paneKey가 non-empty string)가 없어 ptyId/role이 전부 null로 접힌
  // 경우 -- §5 1R 실물 왕복 1·2차 시도에서 실제로 겪은 그 상태다. 그때는
  // 그 출력을 "디버깅 관찰"로만 쓰고 넘어갔지만, 벤더 응답 shape이 또
  // 바뀌면 이 상태가 사람 개입 없이 다시 나타날 수 있다 -- 그때
  // ok:true/exit 0으로 접으면 "기입 성공"이라 말하면서 아무것도 기입하지
  // 않는 조용한 실패가 된다. 그래서 이 사유로 반드시 ok:false로 표면화한다.
  CREATION_PROVENANCE_MISSING: "SEAT_CREATE_LEDGER_CREATION_PROVENANCE_MISSING",
  SAVE_FAILED: "SEAT_CREATE_LEDGER_SAVE_FAILED",
});

function denySeatCreateLedger(reasonCode, detail, extra = {}) {
  return {
    ok: false,
    seatCreateLedgerReason: reasonCode,
    reason: detail,
    ...extra,
  };
}

// §2 판정 기준: recordSeatCreation의 provenance 게이트(paneKey가 non-empty
// string)가 실패하면 normalizeSeatRecord는 **입력 전체**(paneKey뿐 아니라
// 우리가 직접 넘긴 role까지)를 버리고 모든 필드를 null로 접는다
// (seat-registry.mjs `hasCreationProvenanceMarker`/`normalizeSeatRecord`
// 참조 -- src를 통째로 `{}`로 바꾼다). 그래서 role은 이 함수의 입력에서는
// 항상 유효한 문자열이었는데도(호출 시점에 이미 검증됨) 그 게이트가
// 막히면 반드시 null로 나온다 -- role/ptyId 둘 다 이 실패의 신뢰할 수
// 있는 신호다(§2 "ptyId·role이 기록되지 않으면" 그대로).
function isSeatCreationRecordValid(record) {
  return isNonEmptyString(record?.ptyId) && isNonEmptyString(record?.role);
}

// createRoleBoundSeat에서 분리(복잡도 분산 -- ESLint complexity/max-lines
// 상한 준수, quality-check.mjs가 강제). §2 부분 성공 결정: "워커 아님"
// 관측은 이 실패와 무관하게 참인 사실이므로 저장하고(preExistingResult.
// registry, 실패한 null 생성 레코드는 제외), 결과는 항상 ok:false로
// "생성 자체는 실패했다"를 표면화한다(observedNotWorkerSeats로 부분 성공
// 내용을 함께 드러낸다 -- 부분 성공 ≠ 성공).
function denyMissingCreationProvenance(preExistingResult, opts, fsDeps) {
  const partialSaved = saveRegistry(
    opts.registryPath,
    preExistingResult.registry,
    fsDeps,
  );
  if (!partialSaved.ok) {
    return denySeatCreateLedger(
      SEAT_CREATE_LEDGER_REASON.SAVE_FAILED,
      `orca-adapter: createRoleBoundSeat -- creation provenance missing AND saving the pre-existing observations also failed (${partialSaved.reason})`,
      { observedNotWorkerSeats: preExistingResult.observed },
    );
  }
  return denySeatCreateLedger(
    SEAT_CREATE_LEDGER_REASON.CREATION_PROVENANCE_MISSING,
    "orca-adapter: createRoleBoundSeat -- terminal create returned ok:true but its response carried no usable creation provenance (paneKey missing/empty) -- refusing to report success; the new seat's role was NOT recorded (pre-existing NOT_WORKER_SEAT observations, if any, were still saved)",
    { observedNotWorkerSeats: preExistingResult.observed },
  );
}

// registryFs 기본값 조립(loadSeatRegistryForResolve와 동일 원칙, write 쪽도
// 포함) -- 복잡도 분산 겸 저장 seam 재사용.
function resolveRegistryFsDeps(registryFs) {
  const rf = isPlainObject(registryFs) ? registryFs : {};
  return {
    existsFn: typeof rf.existsFn === "function" ? rf.existsFn : existsSync,
    readFn:
      typeof rf.readFn === "function"
        ? rf.readFn
        : (p) => readFileSync(p, "utf8"),
    writeFn:
      typeof rf.writeFn === "function"
        ? rf.writeFn
        : (p, text) => writeFileSync(p, text),
    renameFn: typeof rf.renameFn === "function" ? rf.renameFn : renameSync,
  };
}

// HYK-213-seat-ledger 실물 왕복 실측(§5, 2026-08-09, 3회 라이브 호출로
// 확정): `terminal create --json`의 단수 좌석 결과는 `terminal show`와
// 같은 형태로 `result.terminal.*`에 있다(평평한 `result.*`가 아니다 --
// 1·2차 시도는 이 중첩을 놓쳐 provenance가 전부 null로 접혔다). ★단
// `terminal show`와 달리 **`paneKey`는 여기서는 원시 필드로 실제
// 존재한다**(실측 원문: `result.terminal.paneKey`가 `${tabId}:${leafId}`와
// 문자 그대로 일치하는 값으로 왔다, `leafId` 필드 자체는 이 응답에
// 없었다) -- 2차 시도가 시도한 "paneKey를 tabId+leafId로 직접 합성"은
// leafId 부재로 오히려 진짜 paneKey를 `undefined`로 덮어써 버리는
// 퇴행이었다(결과 파일 §5 원문 3회차 raw JSON 참조). 그래서 이 함수는
// terminal 객체를 그대로 펼치기만 하고, paneKey를 별도로 합성/덮어쓰지
// 않는다 -- 있는 필드를 있는 그대로 신뢰한다(추측 0).
function buildCreationRecordInput(response, role) {
  const terminal = isPlainObject(response?.result?.terminal)
    ? response.result.terminal
    : {};
  return { ...terminal, role };
}

// ①: 생성 호출 전 이 워크트리의 기존 후보를 관측 -> 각각 "워커 아님"으로
// 기록. resolveSeatHandle/resolveRoleBoundSeatHandle과 동일한 후보 필터
// (고아 제외 + canonicalizeForComparison 일치)를 쓴다 -- 화면 문자열은
// 필터 조건에도 기록 내용에도 등장하지 않는다.
function recordPreExistingSeatsAsNotWorker(worktreePath, registry, opts) {
  let listResponse;
  try {
    listResponse = opts.execFn(buildTerminalListCommand());
  } catch (err) {
    return denySeatCreateLedger(
      SEAT_CREATE_LEDGER_REASON.PRE_EXISTING_LIST_QUERY_FAILED,
      `orca-adapter: createRoleBoundSeat -- pre-existing terminal list query threw (${errText(err)})`,
    );
  }
  const list = parseTerminalList(listResponse);
  if (!list) {
    return denySeatCreateLedger(
      SEAT_CREATE_LEDGER_REASON.PRE_EXISTING_LIST_QUERY_FAILED,
      "orca-adapter: createRoleBoundSeat -- pre-existing terminal list response missing/invalid result.terminals",
    );
  }
  const target = canonicalizeForComparison(worktreePath);
  const preExisting = list.filter(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.ptyId) &&
      !isOrphanSeat({ worktreePath: entry.worktreePath }) &&
      canonicalizeForComparison(entry.worktreePath) === target,
  );

  let nextRegistry = registry;
  const observed = [];
  for (const entry of preExisting) {
    const recorded = recordNonWorkerSeatObservation(nextRegistry, {
      ptyId: entry.ptyId,
      handle: entry.handle,
      worktreePath: entry.worktreePath,
      observationReason: "pre-existing-before-role-bound-seat-create (HYK-213)",
    });
    if (!recorded.ok) {
      return denySeatCreateLedger(
        SEAT_CREATE_LEDGER_REASON.PRE_EXISTING_RECORD_FAILED,
        `orca-adapter: createRoleBoundSeat -- ${recorded.reason}`,
      );
    }
    nextRegistry = recorded.registry;
    observed.push({
      handle: entry.handle,
      ptyId: entry.ptyId,
      skipped: recorded.skipped === true,
    });
  }
  return { ok: true, registry: nextRegistry, observed };
}

// ctx: { role, worktreePath, assumeFreshWorktree }. opts: { execFn,
// registryPath, registryFs }. 사람이 직접 부를 수 있는 진입점
// (seat-create-cli.mjs)이 그대로 얹힌다.
//
// HYK-214-seat-legacy-1 (§1-①, 레거시·혼재 워크트리 오라벨): 생성 호출
// "전"에 관측된 후보를 NOT_WORKER_SEAT_ROLE로 기록하는 것은 "그 워크트리가
// 방금 막 생성돼 아직 우리 대장에 아무 좌석도 없다"는 전제에서만 참이다
// (그 경우 pre-existing = 우리 자신이 만든 기본 빈 탭뿐임을 시간 순서로
// 구조적으로 보장할 수 있다, 위 ①). 옛 방식(`orca terminal create` +
// 수동 `-Handle`)으로 이미 실제 워커가 떠 있는 혼재 워크트리에서 같은
// 함수를 호출하면, 그 실제 워커도 관측 시점엔 "생성 호출 전"이므로 동일
// 필터에 걸려 NOT_WORKER_SEAT_ROLE로 오기록된다 -- 대장에 영구히 남는
// 거짓 주장이며(실측: B트랙 CODER 좌석 REJECTED), classifySeatRoleFromRegistry
// 가 그 값을 "판별 불가"와 구분해 두 버킷 모두에서 빼버리므로(§ 위
// 주석) 이후 그 실제 워커를 요청하는 모든 resolveRoleBoundSeatHandle
// 호출이 NOT_FOUND로 조용히 실패한다 -- "판별 불가라 거부"가 아니라
// "워커 아님이라 확정"이라는 틀린 근거로.
//
// 화면 문자열을 보지 않는 한(§4 비타협1) "이 후보가 진짜 레거시 워커인지
// 우리 기본 빈 탭인지"는 구조적으로 구별 불가능하다 -- 그래서 이 구별을
// 코드가 추측하지 않고, 호출자가 "나는 이 워크트리를 방금 새로 만들었다"
// 는 사실을 명시적으로 선언하게 한다(assumeFreshWorktree === true, 기본값
// false). 선언이 없으면(레거시/기존 워크트리를 향한 모든 호출이 여기
// 해당 -- 지금 이 저장소에는 이 값을 넘기는 호출자가 없다) pre-existing
// 관측·기록 자체를 건너뛴다: 진짜 레거시 워커가 있어도 그 좌석은 그대로
// "미기록"(=이후 조회 시 undetermined)으로 남을 뿐, NOT_WORKER_SEAT_ROLE
// 로 확정되지 않는다 -- §3-1 가드에 의해 여전히 거부되지만(안전 방향,
// 이슈 §1 원문 "안전 방향 오류(거부)"), 그 거부 사유가 "판별 불가"라는
// 정직한 사실이지 "워커 아님"이라는 틀린 확정이 아니다.
// HYK-214-seat-legacy-5 (§1-1, 순수 추출 -- 조건·순서·반환값 무변경):
// createRoleBoundSeat의 앞단 입력 검증 3건(complexity 14>12의 주된 원인)
// 을 그대로 옮겼을 뿐이다. 각 분기의 조건식·에러 코드·문구·순서 전부
// 동일하고, 반환 지점만 "그 자리에서 return"에서 "여기서 만들어 돌려주고
// 호출부가 return"으로 바뀐다.
function validateCreateRoleBoundSeatInput(role, worktreePath, opts) {
  if (!isNonEmptyString(role) || !ENGINE_BY_ROLE[role]) {
    return denySeatCreateLedger(
      SEAT_CREATE_LEDGER_REASON.INPUT_INVALID,
      `orca-adapter: createRoleBoundSeat -- unknown role ${JSON.stringify(role)}`,
    );
  }
  if (!isNonEmptyString(worktreePath)) {
    return denySeatCreateLedger(
      SEAT_CREATE_LEDGER_REASON.INPUT_INVALID,
      "orca-adapter: createRoleBoundSeat -- worktreePath is required",
    );
  }
  if (typeof opts.execFn !== "function") {
    return denySeatCreateLedger(
      SEAT_CREATE_LEDGER_REASON.INPUT_INVALID,
      "orca-adapter: createRoleBoundSeat -- opts.execFn is required",
    );
  }
  return null;
}

export function createRoleBoundSeat(
  { role, worktreePath, assumeFreshWorktree = false } = {},
  opts = {},
) {
  const inputError = validateCreateRoleBoundSeatInput(role, worktreePath, opts);
  if (inputError) return inputError;
  const registryLoad = loadSeatRegistryForResolve(opts);
  if (!registryLoad.ok) {
    return denySeatCreateLedger(
      SEAT_CREATE_LEDGER_REASON.REGISTRY_LOAD_FAILED,
      registryLoad.reason,
    );
  }

  const preExistingResult =
    assumeFreshWorktree === true
      ? recordPreExistingSeatsAsNotWorker(
          worktreePath,
          registryLoad.registry,
          opts,
        )
      : { ok: true, registry: registryLoad.registry, observed: [] };
  if (!preExistingResult.ok) return preExistingResult;

  const created = guardedExec(
    buildSeatCreateCommand(role, worktreePath),
    opts.execFn,
    SEAT_CREATE_LEDGER_REASON.CREATE_FAILED,
  );
  if (!created.ok) {
    return denySeatCreateLedger(
      SEAT_CREATE_LEDGER_REASON.CREATE_FAILED,
      created.reason,
    );
  }

  const { registry: nextRegistry, record } = recordSeatCreation(
    preExistingResult.registry,
    buildCreationRecordInput(created.response, role),
  );

  const fsDeps = resolveRegistryFsDeps(opts.registryFs);

  // HYK-213-seat-ledger 2R (§2, 검토 P1-1): 생성 응답이 ok:true여도
  // provenance가 없으면(§5 1R에서 실제로 겪은 상태) 성공으로 접지 않는다.
  if (!isSeatCreationRecordValid(record)) {
    return denyMissingCreationProvenance(preExistingResult, opts, fsDeps);
  }

  const saved = saveRegistry(opts.registryPath, nextRegistry, fsDeps);
  if (!saved.ok) {
    return denySeatCreateLedger(
      SEAT_CREATE_LEDGER_REASON.SAVE_FAILED,
      `orca-adapter: createRoleBoundSeat -- ${saved.reason}`,
    );
  }

  return {
    ok: true,
    record,
    observedNotWorkerSeats: preExistingResult.observed,
    response: created.response,
  };
}

// ---- HYK-185 seat-wire: 좌석 무응답(liveness) 관측 (coder-task.md §2-1) ----
// resolveSeatHandle(A-1)과 "같은 형태" -- terminal list 조회로 worktreePath
// 정규화 일치 후보를 추리고, 0개/2개+는 거부한다(자동 선택 금지, A-1과
// 동일 원칙). 정확히 1개일 때만 buildSeatShowCommand(기존 C절, 이미
// C1/D 판정이 재사용 중)로 `terminal show`를 한 번 더 불러
// `result.terminal.lastOutputAt`을 얻는다 -- 이 필드는 seat-proof-
// contract-v1.mjs의 TERMINAL_SHOW_RAW_FIELD_TYPES.lastOutputAt(실측:
// number, epoch ms)로 이미 계약이 잠겨 있다(dispatch-start-core.mjs가
// 같은 계약을 쓴다).
//
// 호출은 `terminal list`/`terminal show` 읽기 전용 2건뿐이다 --
// dispatch·send·close·stop·worktree 계열 호출은 0(coder-task.md §2-1
// 비타협, resolveSeatLocation/checkWorktreeManaged 같은 좌석 생애주기
// 게이트는 의도적으로 재사용하지 않는다 -- 이 함수는 좌석을 만들거나
// 지우지 않고 오직 이미 존재하는 좌석 하나를 읽을 뿐이다).
//
// ★"좌석 0개"(seatCount:0)와 "조회 실패"(ok:false)는 서로 다른 반환
// 형태다 -- 호출부(orch-stall-detect.mjs)가 이 둘을 섞어 판정 불가와
// 정상 침묵을 혼동하지 않게 한다(coder-task.md §2-2/§3-c 비타협).
export const SEAT_LIVENESS_OBSERVATION_REASON = Object.freeze({
  INPUT_INVALID: "SEAT_LIVENESS_OBSERVATION_INPUT_INVALID",
  LIST_QUERY_FAILED: "SEAT_LIVENESS_OBSERVATION_LIST_QUERY_FAILED",
  SHOW_QUERY_FAILED: "SEAT_LIVENESS_OBSERVATION_SHOW_QUERY_FAILED",
  AMBIGUOUS: "SEAT_LIVENESS_OBSERVATION_AMBIGUOUS",
  MALFORMED: "SEAT_LIVENESS_OBSERVATION_MALFORMED",
  // HYK-408-seat-decide 1R (coder-task.md §2(1)/§3-완료조건2): 장부
  // (dispatch 기록) 조회는 성공했지만 이 하네스 라벨+워크트리에 맞는
  // dispatched 항목 자체가 없다 -- "기록이 없다"는 확정 사실이라 화면으로
  // 짐작하지 않고 fail-closed로 멈춘다(orch-stall-detect.mjs의
  // resolveObservationWithDeliveredSeatFallback 참조).
  NO_DELIVERY_RECORD: "SEAT_LIVENESS_OBSERVATION_NO_DELIVERY_RECORD",
  // HYK-408-seat-decide 2R (검토 P1 수리 -- coder-task.md §1/§2⑴): 장부가
  // "기록이 없다"가 아니라 "기록은 있는데 지금 이 배달과 상관이
  // 성립하지 않는다"고 답한 경우(stale pane key -- 그 좌석이 지금 살아
  // 있는 후보 목록에 없음, 실제 후보의 pane key와 불일치, task-list/
  // dispatch-show 응답이 모호함 등 상관 실패 전부) -- 이것도 "장부가
  // 답했다"는 점에서 NO_DELIVERY_RECORD(기록 자체가 없음)와는 구별되는
  // 사유이지만, 결론은 같다: 화면으로 짐작하지 않고 fail-closed로
  // 멈춘다. 1R은 이 갈래를 화면 폴백으로 잘못 흘려보내 stale/불일치
  // pane key가 단일 CODER-seat 후보와 함께 있으면 JUDGED로 새는 fail-open
  // 이었다(검토 P1, coder-task.md §1 원문 인용). 어느 orca-adapter.mjs
  // 상관 실패 사유가 여기로 접히는지는 orch-stall-detect.mjs의
  // LEDGER_QUERY_INFRA_FAILURE_REASONS(허용목록, 그 밖은 전부 이 사유로
  // 기본 닫힘) 정의를 참조 -- 새 상관 실패 사유가 추가돼도 그 목록에
  // 명시로 올리지 않는 한 자동으로 이쪽(닫힘)으로 떨어진다.
  DELIVERY_RECORD_NO_MATCH:
    "SEAT_LIVENESS_OBSERVATION_DELIVERY_RECORD_NO_MATCH",
  // HYK-413-seat-binding-2 (2R 수리, 검토 P2-1): 원장 조회가 인프라 사유로
  // 실패해 spec 폴백까지 갔는데 그 spec 도 못 찾은 경우(orca-adapter.mjs
  // DELIVERED_SEAT_REASON.SPEC_FALLBACK_NO_CANDIDATE_TASK) -- "원장에
  // 기록 자체가 없다"(NO_DELIVERY_RECORD)와는 다른 사유다: 이쪽은 원장에
  // 물어보지도 못했고, 그 대안(spec)도 이 배달을 못 찾았다는 뜻이다.
  // 이 값이 없으면 orch-stall-detect.mjs의 observationReasonForClosedCorrelation
  // 이 두 사유를 다시 하나로(DELIVERY_RECORD_NO_MATCH) 접어 감사에서
  // 구별이 안 된다 -- 그 함수가 이 값을 명시로 골라내야 한다.
  SPEC_FALLBACK_NO_MATCH: "SEAT_LIVENESS_OBSERVATION_SPEC_FALLBACK_NO_MATCH",
});

function denySeatLivenessObservation(observationReason, detail) {
  return { ok: false, observationReason, reason: detail };
}

function validateSeatLivenessObservationInput(worktreePath, now, opts) {
  if (!isNonEmptyString(worktreePath)) {
    return denySeatLivenessObservation(
      SEAT_LIVENESS_OBSERVATION_REASON.INPUT_INVALID,
      "orca-adapter: collectSeatLivenessObservation -- worktreePath is required",
    );
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    return denySeatLivenessObservation(
      SEAT_LIVENESS_OBSERVATION_REASON.INPUT_INVALID,
      "orca-adapter: collectSeatLivenessObservation -- now (epoch ms) is required",
    );
  }
  if (typeof opts.execFn !== "function") {
    return denySeatLivenessObservation(
      SEAT_LIVENESS_OBSERVATION_REASON.LIST_QUERY_FAILED,
      "orca-adapter: collectSeatLivenessObservation -- opts.execFn is required to query terminal list",
    );
  }
  return null;
}

// ---- HYK-345: 「빈 탭 vs 에이전트 좌석」 판별 ----
// `orca worktree create`가 워크트리마다 빈 pwsh 탭을 하나 더 만들어
// 이 아래 resolveSeatLivenessCandidate가 raw 후보 2개를 보고 즉시
// AMBIGUOUS로 거부하던 문제(coder-task.md §0-A)의 수리. 새 판별을
// 발명하지 않는다 -- 관제실 배달기 `D:\문서관리\하네스-관제실\dispatch-worker.ps1`
// 의 `Looks-Like-Agent`(fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt
// 86~93행)가 이미 같은 판별을 한다. 그 PS 정규식 원문을 그대로 포팅한다
// (마커 목록도 그대로: gpt-5.6/Sonnet/Opus/[CODER]/[REVIEW]/bypass
// permissions/MCP startup/weekly \d). D15 비타협: 마지막 비어있지 않은
// 줄이 살아있는 PS 프롬프트로 끝나면 스크롤백에 옛 마커가 남아 있어도
// 무조건 죽은 셸로 접는다(마커 검사보다 먼저 -- 순서를 바꾸면 안 된다).
//
// scripts/relay/adapters/seat-candidate-adapter.mjs에도 비슷한 마커
// 목록(CLAUDE_AGENT_MARKERS/CODEX_AGENT_MARKERS)이 있지만 그 파일 자신의
// 헤더가 "UNVERIFIED, opt-in only, 어떤 운영 판정 경로에도 안 물려 있음"
// 이라고 명시한다 -- 이 축(seatLiveness/dispatchStart)은 실제 운영
// 판정이라 그 실험적 모듈에 기대지 않고, 검증된 원본(PS 스크립트)을
// 직접 이식한다(제3의 마커 목록을 새로 짓지 않는다 -- 이식이지 발명이
// 아니다).
const DEAD_SHELL_PROMPT_RE = /^PS [A-Za-z]:\\.*>\s*$/;
// HYK-408-seat-decide (coder-task.md §1 실측 ⑵): `\[CODER\]`/`\[REVIEW\]`는
// 한 번도 실물과 일치한 적이 없었다 -- 실제 런처
// (`D:\문서관리\하네스-관제실\orca-worker-seat.ps1:19`,
// `Write-Host "[$Role seat] worktree=$Worktree  pane=$env:ORCA_PANE_KEY"`)가
// 찍는 배너는 `[CODER seat]`/`[REVIEW seat]`(역할 뒤에 " seat"가 항상
// 붙는다) -- 원래 이식 대상이던 dispatch-worker.ps1의 Looks-Like-Agent가
// 이 사실과 다른 가정을 담고 있었다(그 스크립트는 관제실 소유라 이
// 조각에서 고치지 않는다, ⛔관제실 라이브 파일 쓰기 0 -- 우리 쪽 사본만
// 실물에 맞춘다). 이 규칙은 CODER/REVIEW 역할의 화면 축 식별에만
// 쓰인다(§2(2) "화면 축은 보조로 남긴다" -- 1차 식별은 이제
// resolveDeliveredSeat/장부다, 아래 resolveObservationWithDeliveredSeatFallback
// 참조).
// HYK-350 §1: exported (was module-private) SOLELY so a contract test
// (scripts/relay/adapters/seat-marker-divergence.contract.test.mjs) can pin
// this -- the canonical, production-verified marker set -- against the
// separate, UNVERIFIED opt-in copy in seat-candidate-adapter.mjs
// (CLAUDE_AGENT_MARKERS/CODEX_AGENT_MARKERS) and fail loudly if either one
// drifts without the other being consciously reviewed. Exporting a regex
// object changes no runtime behavior anywhere this module is already
// imported (classifySeatPreview below is still the only production caller).
export const AGENT_MARKER_RE =
  /gpt-5\.6|Sonnet|Opus|\[CODER seat\]|\[REVIEW seat\]|bypass permissions|MCP startup|weekly \d/;

function lastNonEmptyPreviewLine(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== "") return lines[i].trim();
  }
  return "";
}

// dispatch-worker.ps1 Looks-Like-Agent와 동형(D15 순서 포함) -- preview
// 원문 하나를 받아 "이건 에이전트 좌석으로 보인다"만 판정한다(부작용 0).
// ★HYK-345 2R (검토 P1 반려 수리): 이 함수 하나로는 "아니다"와 "모른다"를
// 구분할 수 없다(둘 다 false) -- 그래서 호출부는 이제 이 함수를 직접
// 쓰지 않고 아래 classifySeatPreview(세 갈래)를 쓴다. 이 함수는 기존
// 시험/외부 소비자를 위해 그대로 남긴다(순수 파생: AGENT 갈래일 때만
// true).
export function previewLooksLikeAgent(preview) {
  return classifySeatPreview(preview) === SEAT_PREVIEW_CLASSIFICATION.AGENT;
}

// ---- HYK-345 2R (coder-task.md §1, 검토 P1 반려 수리) ----
// 검토자 반례: 1R의 filterAgentSeatCandidates는 "빼지 않는다"(조회 실패·
// preview 결손)와 "에이전트로 통과시킨다"(마커 확정)를 같은 `kept` 배열에
// 섞었다 -- 그래서 다른 후보가 확정 빈 셸로 빠지고 미확정 후보 하나만
// `kept`에 남으면, 그 미확정 후보가 "그 워크트리의 유일한 좌석"으로
// 조용히 통과했다(fail-open). §1 요구대로 세 갈래를 코드에서 분명히
// 나눈다 -- "모른다"는 "에이전트다"도 "빈 셸이다"도 아닌 별도 값이다.
//
// 정의(★반드시 이 순서로 읽는다, D15 그대로 -- 마커 검사보다 죽은 셸
// 검사가 항상 먼저):
//   - DEAD_SHELL(빈 셸 확정): 마지막 비어있지 않은 줄이 살아있는 PS
//     프롬프트로 끝난다 -- 이것만이 "확실히 에이전트가 아니다"의 근거다.
//   - AGENT(에이전트 확정): DEAD_SHELL이 아니고, 알려진 에이전트 마커를
//     포함한다.
//   - UNKNOWN(모름): 그 외 전부 -- preview 조회 자체가 실패했거나
//     (execFn throw/ok:false), preview 필드가 없거나 빈 문자열이거나,
//     내용은 있지만 DEAD_SHELL도 AGENT도 아닌 경우(예: 방금 뜬 좌석의
//     초기 화면 -- 아직 마커도 안 보이고 죽은 셸 프롬프트도 아닌 과도기).
//     ★"마커가 없다"는 "빈 셸이다"의 증거가 아니다 -- 오직 살아있는 죽은
//     셸 프롬프트만 그 증거다(1R에서는 이 구분이 없어 "마커 없음"을
//     암묵적으로 "빈 셸"과 동일시했다 -- 그 자체는 이번 사고의 원인이
//     아니었지만, 이 재작업에서 정의를 명시하며 함께 바로잡는다).
export const SEAT_PREVIEW_CLASSIFICATION = Object.freeze({
  AGENT: "AGENT",
  DEAD_SHELL: "DEAD_SHELL",
  UNKNOWN: "UNKNOWN",
});

export function classifySeatPreview(preview) {
  if (!isNonEmptyString(preview)) return SEAT_PREVIEW_CLASSIFICATION.UNKNOWN;
  if (DEAD_SHELL_PROMPT_RE.test(lastNonEmptyPreviewLine(preview))) {
    return SEAT_PREVIEW_CLASSIFICATION.DEAD_SHELL;
  }
  return AGENT_MARKER_RE.test(preview)
    ? SEAT_PREVIEW_CLASSIFICATION.AGENT
    : SEAT_PREVIEW_CLASSIFICATION.UNKNOWN;
}

// raw 후보(2개+)의 `terminal show` preview를 조회해 세 갈래로 분류한다.
// resolveSeatLivenessCandidate에서 분리(복잡도 분산) -- raw
// candidates.length<=1일 때는 호출하지 않는다(예산: 모호할 때만 추가
// terminal show 호출, 1R 설계 노트 그대로 유지).
//
// terminal show 조회 자체가 실패한 후보(throw/ok:false)는 UNKNOWN으로
// 분류한다 -- "조회 실패"와 "preview 결손"을 이 함수 층위에서는 같은
// "모른다"로 접는다(둘 다 이 후보가 에이전트인지 빈 셸인지 판단할 근거가
// 없다는 점에서 동형이다). 이 함수는 항상 {ok:true, agents, unknowns,
// deadShells}만 낸다({ok:false}를 내지 않는다) -- "닫을지 말지"의 결정은
// 호출부(resolveSeatLivenessCandidate)가 세 배열의 개수를 보고 한다.
function classifySeatCandidates(candidates, opts) {
  const agents = [];
  const unknowns = [];
  const deadShells = [];
  for (const candidate of candidates) {
    let showResponse;
    try {
      showResponse = opts.execFn(buildSeatShowCommand(candidate.handle));
    } catch {
      unknowns.push(candidate);
      continue;
    }
    const preview = parseSeatPreview(showResponse);
    const classification = classifySeatPreview(preview);
    if (classification === SEAT_PREVIEW_CLASSIFICATION.AGENT) {
      agents.push(candidate);
    } else if (classification === SEAT_PREVIEW_CLASSIFICATION.DEAD_SHELL) {
      deadShells.push(candidate);
    } else {
      unknowns.push(candidate);
    }
  }
  return { ok: true, agents, unknowns, deadShells };
}

// terminal list 조회 -> worktreePath 정규화 일치 후보 추리기 (resolveSeatHandle,
// A-1과 같은 형태) -- 0개는 {ok:true, seatCount:0}(정상), 2개+는 AMBIGUOUS로
// 거부(자동 선택 금지), 조회 자체 실패는 LIST_QUERY_FAILED. collectSeatLivenessObservation
// 에서 분리(복잡도 분산).
//
// HYK-345: raw 후보가 2개 이상일 때만(모호할 때만) previewLooksLikeAgent로
// 한 번 더 거른다(D15/Looks-Like-Agent 이식, 위 주석) -- 걸러서 정확히
// 1개면 그걸 고른다(빈 탭이 섞여 있던 경우), 0개면 좌석 없음(정상), 2개
// 이상이면(진짜 좌석이 실제로 중복 기동한 경우) 여전히 AMBIGUOUS로
// 거부한다(정당한 거부 무회귀, coder-task.md §2 완료조건2).
function resolveSeatLivenessCandidate(worktreePath, opts) {
  let listResponse;
  try {
    listResponse = opts.execFn(buildTerminalListCommand());
  } catch (err) {
    return denySeatLivenessObservation(
      SEAT_LIVENESS_OBSERVATION_REASON.LIST_QUERY_FAILED,
      `orca-adapter: collectSeatLivenessObservation -- terminal list query threw (${errText(err)})`,
    );
  }
  const list = parseTerminalList(listResponse);
  if (!list) {
    return denySeatLivenessObservation(
      SEAT_LIVENESS_OBSERVATION_REASON.LIST_QUERY_FAILED,
      "orca-adapter: collectSeatLivenessObservation -- terminal list response missing/invalid result.terminals",
    );
  }
  const target = canonicalizeForComparison(worktreePath);
  const candidates = list.filter(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.handle) &&
      !isOrphanSeat({ worktreePath: entry.worktreePath }) &&
      canonicalizeForComparison(entry.worktreePath) === target,
  );
  if (candidates.length === 0) {
    // 정상 -- 이 worktree에 좌석이 없다(조회 실패가 아니다).
    return { ok: true, seatCount: 0 };
  }
  if (candidates.length === 1) {
    return { ok: true, seatCount: 1, handle: candidates[0].handle };
  }
  // raw 후보 2개 이상 -- HYK-345: 즉시 거부하기 전에 에이전트 마커로
  // 세 갈래(agents/unknowns/deadShells)를 나눈다(classifySeatCandidates,
  // 위 주석). ★HYK-345 2R(검토 P1 반려 수리): "미확정(unknowns)" 후보가
  // 하나라도 남으면, 그것이 유일하게 남은 후보여도 "그게 에이전트다"라고
  // 확정할 근거가 없다 -- deadShells를 뺀 나머지(agents+unknowns) 안에
  // unknowns가 하나라도 있으면 고르지 않고 AMBIGUOUS로 닫는다(1R의
  // "빼지 않는다"≠"통과시킨다" 결함 수리 -- §1 요구 그대로).
  const classified = classifySeatCandidates(candidates, opts);
  if (classified.unknowns.length > 0) {
    return denySeatLivenessObservation(
      SEAT_LIVENESS_OBSERVATION_REASON.AMBIGUOUS,
      `orca-adapter: collectSeatLivenessObservation -- ${classified.unknowns.length} candidate(s) for worktreePath '${worktreePath}' could not be confirmed as agent or dead shell (preview query failed/empty/unrecognized), refusing to guess whether the sole remaining candidate is the seat (of ${candidates.length} raw candidates, ${classified.agents.length} confirmed agent, ${classified.deadShells.length} confirmed dead shell)`,
    );
  }
  if (classified.agents.length === 0) {
    // 미확정 0 + 에이전트 0 -- 전부 확정 빈 셸이었다(정상, 좌석 없음).
    return { ok: true, seatCount: 0 };
  }
  if (classified.agents.length > 1) {
    return denySeatLivenessObservation(
      SEAT_LIVENESS_OBSERVATION_REASON.AMBIGUOUS,
      `orca-adapter: collectSeatLivenessObservation -- ${classified.agents.length} agent seats found for worktreePath '${worktreePath}' (of ${candidates.length} raw candidates), refusing to guess (A-1 원칙 계승)`,
    );
  }
  return { ok: true, seatCount: 1, handle: classified.agents[0].handle };
}

// terminal show 조회 -> lastOutputAt(계약: number, epoch ms) + title(reasonHint
// 후보) 추출. collectSeatLivenessObservation에서 분리(복잡도 분산).
// HYK-185-seat-corr: resolveDeliveredSeat로 해석한 handle을 관측(lastOutputAt)
// 으로 이어붙이는 재시도 경로(orch-stall-detect.mjs)도 이 함수를 그대로
// 재사용한다 -- export한다(동작 변경 없음, 가시성만 넓힘).
export function fetchSeatLivenessShow(handle, now, opts) {
  let showResponse;
  try {
    showResponse = opts.execFn(buildSeatShowCommand(handle));
  } catch (err) {
    return denySeatLivenessObservation(
      SEAT_LIVENESS_OBSERVATION_REASON.SHOW_QUERY_FAILED,
      `orca-adapter: collectSeatLivenessObservation -- terminal show query threw (${errText(err)})`,
    );
  }
  if (!isPlainObject(showResponse) || showResponse.ok !== true) {
    return denySeatLivenessObservation(
      SEAT_LIVENESS_OBSERVATION_REASON.SHOW_QUERY_FAILED,
      `orca-adapter: collectSeatLivenessObservation -- ${extractFailureDetail(showResponse)}`,
    );
  }
  const terminal = isPlainObject(showResponse.result)
    ? showResponse.result.terminal
    : null;
  const lastOutputAt = isPlainObject(terminal) ? terminal.lastOutputAt : null;
  if (typeof lastOutputAt !== "number" || !Number.isFinite(lastOutputAt)) {
    return denySeatLivenessObservation(
      SEAT_LIVENESS_OBSERVATION_REASON.MALFORMED,
      "orca-adapter: collectSeatLivenessObservation -- result.terminal.lastOutputAt missing/non-numeric",
    );
  }
  const title =
    isPlainObject(terminal) && typeof terminal.title === "string"
      ? terminal.title
      : null;
  return {
    ok: true,
    seatCount: 1,
    handle,
    observation: { observedAtMs: now, lastOutputAt, reasonHint: title },
  };
}

// ctx: { worktreePath, now(epoch ms) } -- opts: { execFn }. 순수 조합 --
// execFn 호출은 최대 2건(list + show), 부작용 호출은 0(A-1 계약 계승).
export function collectSeatLivenessObservation(ctx = {}, opts = {}) {
  const { worktreePath, now } = isPlainObject(ctx) ? ctx : {};
  const invalid = validateSeatLivenessObservationInput(worktreePath, now, opts);
  if (invalid) return invalid;
  const resolved = resolveSeatLivenessCandidate(worktreePath, opts);
  if (!resolved.ok || resolved.seatCount === 0) return resolved;
  return fetchSeatLivenessShow(resolved.handle, now, opts);
}

// ---- HYK-185-seat-multi (coder-task.md §2 «안 1» step1): 관측층 확장 --
// 워크트리에 좌석이 2개 이상이어도 거부하지 않고 전부 돌려준다.
//
// ★이 함수는 resolveSeatLivenessCandidate/collectSeatLivenessObservation
// (위, A-1 계승)을 대체하지 않는다 -- 그 함수들은 그대로 남아 그대로
// 쓰인다(비타협: "좌석이 둘일 때 추측하지 않고 실패로 드러내는 것은
// 옳은 동작", coder-task.md §2 비타협1). «이 워크트리의 좌석은 정확히
// 하나인가»라는 질문이 실제로 필요한 호출자(배달과 결부된 축 --
// seatLiveness/dispatchStart)는 여전히 그 함수를 쓰고, 2개 이상이면
// 여전히 AMBIGUOUS로 실패한다(코더-task.md §3-c 전수 스캔 표와 보고서의
// QUESTION 참조 -- 그 두 축의 신원 해석 전환은 이번 사이클에서 보류됐다).
//
// 이 함수는 그 질문 자체가 필요 없는 호출자(방치/유휴 축, seatIdle)를
// 위한 것이다 -- «고르지 않는다»(coder-task.md §2 "안 1" 진단: "작업자가
// 둘이면 그 폴더의 좌석은 원래 하나가 아니다"). 후보 필터 조건은
// resolveSeatLivenessCandidate와 완전히 동일하다(고아 제외 +
// canonicalizeForComparison 일치) -- 다른 것은 "2개 이상이면 거부"가
// "2개 이상이면 전부 돌려준다"로 바뀐 것뿐이다.
//
// 좌석 하나의 `terminal show` 실패(SHOW_QUERY_FAILED/MALFORMED)는 그
// 좌석 항목 하나만 `{ok:false, ...}`로 표시하고 나머지 좌석의 관측을
// 막지 않는다 -- 좌석 하나의 실패가 축 전체를 눈멀게 하던 이번 사고의
// 근본 형태(coder-task.md §1)를 관측층에서부터 반복하지 않는다.
// `terminal list` 조회 자체의 실패(LIST_QUERY_FAILED)는 여전히 전체
// 실패다(개별 좌석을 추릴 근거 자체가 없으므로).
export function collectSeatObservationsForWorktree(ctx = {}, opts = {}) {
  const { worktreePath, now } = isPlainObject(ctx) ? ctx : {};
  const invalid = validateSeatLivenessObservationInput(worktreePath, now, opts);
  if (invalid) return invalid;
  let listResponse;
  try {
    listResponse = opts.execFn(buildTerminalListCommand());
  } catch (err) {
    return denySeatLivenessObservation(
      SEAT_LIVENESS_OBSERVATION_REASON.LIST_QUERY_FAILED,
      `orca-adapter: collectSeatObservationsForWorktree -- terminal list query threw (${errText(err)})`,
    );
  }
  const list = parseTerminalList(listResponse);
  if (!list) {
    return denySeatLivenessObservation(
      SEAT_LIVENESS_OBSERVATION_REASON.LIST_QUERY_FAILED,
      "orca-adapter: collectSeatObservationsForWorktree -- terminal list response missing/invalid result.terminals",
    );
  }
  const target = canonicalizeForComparison(worktreePath);
  const candidates = list.filter(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.handle) &&
      !isOrphanSeat({ worktreePath: entry.worktreePath }) &&
      canonicalizeForComparison(entry.worktreePath) === target,
  );
  if (candidates.length === 0) {
    return { ok: true, seatCount: 0, seats: [] };
  }
  const seats = candidates.map((candidate) => {
    const shown = fetchSeatLivenessShow(candidate.handle, now, opts);
    if (!shown.ok) {
      return {
        handle: candidate.handle,
        ok: false,
        observationReason: shown.observationReason,
        reason: shown.reason,
      };
    }
    return {
      handle: candidate.handle,
      ok: true,
      observation: shown.observation,
    };
  });
  return { ok: true, seatCount: seats.length, seats };
}

// ---- HYK-185-seat-corr (coder-task.md §2, 검토자 실측 경로): "그 배달이
// 간 좌석" 식별 -- 읽기 전용 조회 3단만 이어붙인다(새 저장 상태 0):
//   ①`task-list --status dispatched` -> 하네스 라벨 + 워크트리 경로가
//     spec에 함께 있는 후보를 정확히 하나로 좁힌다.
//   ②그 후보의 `dispatch-show` -> `assignee_pane_key`를 얻는다.
//   ③그 열쇠를 이 워크트리의 살아 있는 좌석 목록(terminal show,
//     `${tabId}:${leafId}`)과 대조해 정확히 하나가 맞을 때만 지목한다.
// 대조가 성립하지 않으면(후보 0/2개+ · 배정 응답 결손 · 죽은 좌석만
// 일치) 절대 고르지 않고 실패를 드러낸다(비타협).
//
// argv 두 개(buildTaskListDispatchedCommand/buildDispatchShowCommand)는
// HYK-171 사이클4b-1(재작업3)에서 "증명 불가"로 판단해 지웠던 것과 동일
// 실측 shape(teardown-inventory-adapter.mjs 그 커밋의 §2-C 헤더 주석 --
// `["orchestration","task-list","--status","dispatched","--json"]` /
// `["orchestration","dispatch-show","--task",taskId,"--json"]`)를 그대로
// 되쓴다 -- argv 자체는 그때도 실측이었다(틀린 것은 "기록만 있으면
// 좌석이다"라는 상관 결론이었지, argv가 아니었다). 그 결론이 왜 틀렸는지는
// 위 §2-B 문단 참조 -- 이번 함수는 "기록이 있다"만으로 지목하지 않고
// ③ 살아있는 좌석 대조가 성립할 때만 지목한다(그 사고를 반복하지 않는다).
export const DELIVERED_SEAT_REASON = Object.freeze({
  INPUT_INVALID: "DELIVERED_SEAT_INPUT_INVALID",
  TASK_LIST_QUERY_FAILED: "DELIVERED_SEAT_TASK_LIST_QUERY_FAILED",
  NO_CANDIDATE_TASK: "DELIVERED_SEAT_NO_CANDIDATE_TASK",
  AMBIGUOUS_CANDIDATE_TASK: "DELIVERED_SEAT_AMBIGUOUS_CANDIDATE_TASK",
  DISPATCH_SHOW_QUERY_FAILED: "DELIVERED_SEAT_DISPATCH_SHOW_QUERY_FAILED",
  DISPATCH_SHOW_INVALID: "DELIVERED_SEAT_DISPATCH_SHOW_INVALID",
  LIVE_SEAT_LIST_QUERY_FAILED: "DELIVERED_SEAT_LIVE_SEAT_LIST_QUERY_FAILED",
  // 후보 0(죽은 좌석만 일치하거나 애초에 일치 자체가 없음)와 후보 2개+를
  // 하나로 접지 않는다 -- 합격기준 (d)가 세 상관 실패 경로를 각각
  // 요구한다.
  NO_LIVE_SEAT_MATCH: "DELIVERED_SEAT_NO_LIVE_SEAT_MATCH",
  AMBIGUOUS_LIVE_SEAT_MATCH: "DELIVERED_SEAT_AMBIGUOUS_LIVE_SEAT_MATCH",
  // HYK-413-seat-binding §2⑴ (신규): 배달 영수증 원장(dispatch-receipts.jsonl)
  // 조회 "자체"가 안 됐다(경로 미해결/읽기 실패) -- 이 둘만 spec 매칭
  // 폴백을 허용한다(아래 resolveCandidateFromReceiptLedger의 infra:true,
  // resolveCandidateDispatchTask 참조). 원장이 «답은 했는데 못 찾음»
  // (NO_CANDIDATE_TASK/AMBIGUOUS_CANDIDATE_TASK 재사용/MALFORMED_RECEIPT_RECORD)
  // 은 폴백하지 않는다 -- 그러면 fail-open이 된다(coder-task.md §2⑵).
  RECEIPT_PATH_UNSET: "DELIVERED_SEAT_RECEIPT_PATH_UNSET",
  RECEIPT_READ_FAILED: "DELIVERED_SEAT_RECEIPT_READ_FAILED",
  // 라벨과 일치하는 영수증이 정확히 1건 있지만 그 레코드 자체가 손상됐다
  // (필수 필드 runtime_task_id 결손) -- "기록 없음"과 다른 사유로
  // 구별한다(coder-task.md §2⑶ "손상"도 fail-closed로 명시).
  MALFORMED_RECEIPT_RECORD: "DELIVERED_SEAT_MALFORMED_RECEIPT_RECORD",
  // HYK-413-seat-binding-2 (2R 수리, 검토 P2-1 원문): resolveCandidateFromReceiptLedger
  // 의 "원장이 직접 답했는데 이 라벨 항목이 0건/2건+"(위 NO_CANDIDATE_TASK/
  // AMBIGUOUS_CANDIDATE_TASK, ⓐ)와 resolveCandidateDispatchTaskViaSpec의
  // "원장 조회가 인프라로 실패해 spec으로 물러났는데 spec도 0건/2건+"
  // (ⓑ)는 서로 다른 사유다 -- 전자는 «장부에 이 배달의 기록 자체가
  // 없다», 후자는 «장부는 못 물어봤고 물어본 대안(spec)도 못 찾았다».
  // 옛 코드는 resolveCandidateDispatchTaskViaSpec이 같은 NO_CANDIDATE_TASK/
  // AMBIGUOUS_CANDIDATE_TASK 코드를 재사용해 이 둘이 감사에서 구별되지
  // 않았다(검토 원문: "원장 기록 부재와 같은 코드가 됩니다"). 폴백 정책·
  // fail-closed 판정 자체는 전혀 안 바뀐다 -- 사유 코드만 갈린다.
  SPEC_FALLBACK_NO_CANDIDATE_TASK:
    "DELIVERED_SEAT_SPEC_FALLBACK_NO_CANDIDATE_TASK",
  SPEC_FALLBACK_AMBIGUOUS_CANDIDATE_TASK:
    "DELIVERED_SEAT_SPEC_FALLBACK_AMBIGUOUS_CANDIDATE_TASK",
});

export function buildTaskListDispatchedCommand() {
  return ["orchestration", "task-list", "--status", "dispatched", "--json"];
}
export function buildDispatchShowCommand(taskId) {
  return ["orchestration", "dispatch-show", "--task", taskId, "--json"];
}

function denyDeliveredSeat(reasonCode, detail) {
  return { ok: false, reasonCode, reason: detail };
}

// HYK-185-seat-corr-2 (REVIEW P1 수리, 2026-08-06): 어제 실측한 "go <라벨>"
// 줄 형태는 오늘 재실측하니 이미 폐기돼 있었다 -- ORCH 자신이 "두 형식
// 다 내가 쓴 것이고 어제와 오늘 사이에 형식을 바꿨다"고 자인했다(§R2
// 반려 사유). 그래서 이 함수의 정본은 문서/과거 실측이 아니라 **오늘
// 다시 뽑은 raw**(`.harness/증거/task-list-raw-0806.json`, 이 배달 자신의
// 항목 `task_id:"task_657777c22e40"` 그대로)다:
//   "role: CODER\nharness_label: HYK-185-seat-corr-1\nworktree: C:\...\hyk185-seat-multi (branch hyk185-seat-corr)\ntask_file: .harness/coder-task.md\n요지: ..."
// 라벨은 "go <라벨>" 줄이 아니라 **`harness_label: <라벨>` 줄**(정확
// 일치, 부분 문자열/대소문자 완화 없음 -- 추측 금지)에 있다.
//
// HYK-185-seat-corr-4 (한용 «(가)» 확정, 2026-08-06 -- ★이 이슈의 마지막
// 라운드): `worktree:` 줄은 **"벗겨 내고 비교"(strip-then-compare) 방식을
// 완전히 버렸다.** 그 방식은 3라운드 연속 같은 계열의 구멍(REVIEW가 매번
// 새 반례로 뚫음 -- corr-2는 어제 형식 자체가 틀림, corr-3은 꼬리 앞
// 공백을 0개 이상 허용해 접두어-충돌 경로가 같은 문자열로 축약됨)을
// 냈다 -- 헐거운 정규식으로 "그럴듯한 조각을 어딘가에서 찾아 잘라내는"
// 접근 자체가 매번 새로 뚫릴 여지를 남긴다. 이제는 `worktree:` 줄
// **전체**를 **정확히 두 문법 중 하나로만** 인정한다(그 외는 전부
// 거부, 아래 WORKTREE_LINE_WITH_BRANCH_TAIL/WORKTREE_LINE_BARE_PATH 참조):
//   ① `worktree: <경로>`
//   ② `worktree: <경로> (branch <이름>)`
// 두 정규식 다 `^`/`$`로 **줄 전체**를 앵커링한다 -- 문자열 중간
// 어딘가의 우연한 부분 일치는 애초에 통과할 수 없다. 리터럴 구분자는
// **정확히 ASCII 스페이스 1개(U+0020)만** 쓴다(`\s`를 쓰지 않는다 --
// JS 정규식의 `\s`는 U+00A0/U+2028/U+2029/BOM 등 다수의 유니코드
// 공백류까지 포함해 너무 넓다. 리터럴 `" "` 하나만 쓰면 탭·유니코드
// 공백 변형이 전부 자동으로 문법 밖이 된다).
//
// <이름>(브랜치명) — **두 겹으로 제한한다** (HYK-192-seat-corr-5,
// 2026-08-07: 4R이 반려된 자리가 정확히 여기다 — 아래 "문자 집합만으로는
// 부족한 이유" 참조):
//
// **겹1(문자 집합)**: git이 실제로 허용하는 문자의 보수적 부분집합만
// 받는다: 영문 대소문자·숫자·`.`·`_`·`-`·`/`
// (`BRANCH_NAME_CHARS = [A-Za-z0-9._/-]+`, 1개 이상 필수 -- 빈 이름
// 불허). 이 집합은 화이트리스트(포함될 것만 나열)라 **집합에 안 적힌
// 문자는 무엇이든 정규식 구조 자체가 자동으로 배제**한다(개별 문자마다
// 별도 로직이 있는 게 아니다) -- 공백·탭·유니코드 공백 문자(NBSP 등)
// 그리고 git이 실제로 금지하는 특수문자(`~^:?*[\`)가 여기 해당한다.
// ⚠️**시험 범위 정직 고지**: 이 메커니즘 자체(대표 사례로 `~`·탭·NBSP·
// 공백만인 이름)는 시험으로 직접 확인했지만, `^`·`:`·`?`·`*`·`[`·`\`
// 여섯 문자 하나하나를 각각 시험하지는 않았다 -- 같은 화이트리스트
// 정규식이 배제하는 것이 코드 구조로 자명하기 때문이다(전칭 주장 아님,
// §4 대조표 참조).
//
// ★**문자 집합만으로는 부족한 이유(4R이 실제로 반려된 지점, 역사
// 설명 -- 지금의 주장이 아니라 왜 겹2가 생겼는지의 배경이다)**: `.`와
// `/`는 둘 다 이 집합 "안"에 있다 — 그런데 git refname 규칙은 이 두
// 문자를 특정 **배치**로 쓰면 여전히 금지한다(연속 `..`, 선행/후행
// `/`, 연속 `//`, `.lock`으로 끝나는 구성요소 등). 4R 헤더는 "이것도
// 집합 밖이라 자동 거부된다"고 적었지만 **실제로는 집합 안에 있어
// 통과했다** — 주장과 구현이 어긋난 채 반려됐다(REVIEW 반례:
// `..`/`/main`/`main/`/`main..old` 넷 다 4R 코드에서는 실제로
// 통과했다). 그래서 **겹2**를 별도 함수로 추가했다(5R). ★**그 겹2조차
// 처음엔 불완전했다** -- 5R은 검토자가 지정한 4개만 막았는데, **다른
// 엔진** 독립 검토가 5R이 지정하지 않은 반례 2개(`feature//x`·
// `release.lock`)를 스스로 만들어 뚫었다(6R, 아래 겹2 정의부 주석
// 참조) ⇒ **지정 반례만으로는 이 문법의 완전함을 보증할 수 없다는
// 것이 실측으로 두 번(4R→5R, 5R→6R) 증명됐다.**
//
// **겹2(구조 검사, `isValidBranchNameGrammar`, 정의는 아래
// BRANCH_NAME_CHARS 선언 바로 다음)**: 겹1을 통과한 이름 문자열에
// 대해, git refname이 실제로 금지하는 배치 중 **지금까지 실측으로
// 확인된 6개**(연속 `..`·선행 `/`·후행 `/`·연속 `//`·`.lock`으로
// 끝나는 구성요소, 그리고 그 6개를 막는 5규칙)만 검사한다.
// ⛔**git-check-ref-format의 전체 규칙을 구현하지 않는다**(예: `.`로
// 시작하는 구성요소, 전체 이름이 `.`로 끝나는 것, 제어문자 등 --
// 범위 폭발 금지, 한용 명시). `@{`는 별도 규칙 없이도 겹1(문자
// 집합)이 `{`/`}`를 이미 배제해 막힌다. 이 좁은 범위 밖의 배치는
// 여전히 통과할 수 있다(정직 고지, 아래 §4/§6 대조표 참조 -- 6R에서
// 자체 탐색으로 추가 발견한 홀(선행 `.` 구성요소·후행 `.` 전체이름)도
// **의도적으로 고치지 않고** 거기 적어 둔다). 이것도 **"벗겨서
// 비교"가 아니다** — 이미 앵커 정규식으로 정확히 분리해 낸 캡처
// 그룹 하나를 검사할 뿐, 문자열 어딘가를 찾아 잘라내지 않는다.
//
// **넓히지 않는다는 원칙은 그대로**(한용 지시, 4R에서 이미 확정):
// 겹1/겹2 어느 쪽에도 안 맞는 진짜 브랜치명이 미래에 나타나도 이
// 함수는 "못 고른다"로 떨어질 뿐이고, 그게 이 상관이 가져야 할 옳은
// 실패 방향이다(관대한 확장 금지 -- 필요해지면 그때 다시 실측하고
// 문법을 명시적으로 넓힌다).
//
// ★정직 고지(한용 지시, gap#90에도 동일 문구를 남긴다): 남은 반례들은
// 전부 **합성**이다 -- Orca가 실제로 만드는 꼬리는 진짜 git 브랜치명
// 이라 이 문법 밖으로 벗어날 실무 위험은 낮다. **다만 그 가정에 기대지
// 않는 쪽으로 고쳤다** -- "이 프로젝트에서 그건 일어날 수 없다"는 가정이
// 이 파일 안에서만도 이미 여러 번(§R2/§R3/§R4) 깨졌기 때문이다.
const BRANCH_NAME_CHARS = "[A-Za-z0-9._/-]+";
const WORKTREE_LINE_WITH_BRANCH_TAIL = new RegExp(
  `^worktree: (.+) \\(branch (${BRANCH_NAME_CHARS})\\)$`,
);
const WORKTREE_LINE_BARE_PATH = /^worktree: (.+)$/;

// 겹2 -- 문자 집합(겹1)을 이미 통과한 이름에 대해서만 부른다. 5규칙
// (아래 함수 본문): 연속 `..`(4R/5R) · 선행 `/`(5R) · 후행 `/`(5R) ·
// **연속 `//`(6R, 신규)** · **`.lock`으로 끝나는 구성요소(6R, 신규)**.
//
// 6R에서 추가한 2규칙의 구체 사유:
// - **연속 슬래시(`//`) 금지** -- `name.includes("//")`.
// - **`.lock`으로 끝나는 구성요소 금지** -- `/`로 나눈 각 구성요소
//   중 하나라도 `.lock`으로 끝나면 거부(`endsWith(".lock")`가 아니라
//   `.split('/').some(...)`인 이유: git은 **중간** 구성요소도 막는다
//   -- 직접 실측: `git check-ref-format --branch "a/b.lock/c"` →
//   exit 128. 반대로 `a.lockx`/`a/b.lockx/c`(접미사가 ".lock"이
//   아니라 "lockx")는 git이 통과시킨다(exit 0) -- "포함"이 아니라
//   "그 구성요소 전체가 정확히 `.lock`으로 끝나는가"가 규칙이다.
// HYK-431 5R / HYK-436 (§2-1, coder-task.md): 이 함수의 유일한 호출부
// (parseWorktreeSpecLine, 아래)는 정규식 캡처 그룹만 넘겨 언제나 원시
// 문자열이지만, 원시 문자열이라는 보장을 이 함수 자신은 강제하지
// 않았다 -- 문자열을 흉내 내며 includes/startsWith/endsWith/split을
// 항상 "안전"쪽으로 재정의한 객체가 들어오면(예: 미래의 새 호출부가
// 검증 안 된 값을 넘기는 경우) 모든 검사를 그대로 통과해버린다. 먼저
// `typeof name !== "string"`으로 원시 문자열이 아니면 즉시 거부한다 --
// 원시 문자열은 자기 프로퍼티를 가질 수 없으므로(재정의 불가능) 이
// 가드 하나로 객체 기반 위장 전부가 원천 차단된다. 그 다음
// `String.prototype.<method>.call(name, ...)`로 원형 메서드를 빌려
// 부르는 것은 seat-reclaim-core.mjs/teardown-core.mjs의
// `Array.prototype.<method>.call` 패턴과 동일한 방어 심층화다(원시
// 문자열엔 실질적 차이가 없지만, 호출 규약을 저장소 전체에서
// 통일한다).
export function isValidBranchNameGrammar(name) {
  if (typeof name !== "string") return false;
  if (String.prototype.includes.call(name, "..")) return false;
  if (String.prototype.startsWith.call(name, "/")) return false;
  if (String.prototype.endsWith.call(name, "/")) return false;
  if (String.prototype.includes.call(name, "//")) return false;
  if (
    String.prototype.split
      .call(name, "/")
      .some((component) => String.prototype.endsWith.call(component, ".lock"))
  ) {
    return false;
  }
  return true;
}

// `worktree:` 줄 원문 하나를 위 두 문법 중 하나로만 파싱한다 -- 어느
// 쪽에도 안 맞으면 null(관대한 추측 0, 호출부가 이를 "후보 아님"으로
// 접는다). ①(꼬리 있음)을 **먼저** 시도한다 -- ②(꼬리 없음, `.+`가
// 줄 전체를 삼킨다)가 ①의 상위집합이라 순서가 중요하다: 꼬리가 실제로
// 있는데 ②를 먼저 매치시키면 "(branch ...)" 문자열째로 path에 섞여
// worktreePath와 항상 불일치하게 된다(안전한 실패이긴 하지만 문법
// 의도와 다르다 -- ①을 먼저 시도해 정확히 분리한다). ①이 겹1(문자
// 집합)엔 맞아도 겹2(구조)에서 거부되면(예: 이름이 `main..old`) 이
// 함수는 ①을 쓰지 않고 ②로 넘어간다 -- 그 결과 path에 "(branch
// main..old)"가 그대로 섞여 실제 경로와 항상 불일치하게 된다(다른
// 4R 거부 사례들과 동일한 fail-closed 패턴).
export function parseWorktreeSpecLine(rawLine) {
  if (typeof rawLine !== "string") return null;
  const withTail = WORKTREE_LINE_WITH_BRANCH_TAIL.exec(rawLine);
  if (withTail && isValidBranchNameGrammar(withTail[2])) {
    return { path: withTail[1], branchName: withTail[2] };
  }
  const barePath = WORKTREE_LINE_BARE_PATH.exec(rawLine);
  if (barePath) return { path: barePath[1], branchName: null };
  return null;
}

function specMatchesDeliveryTarget(specText, harnessLabel, worktreePath) {
  if (typeof specText !== "string") return false;
  const lines = specText.split(/\r?\n/);
  const labelLine = lines.find((line) => /^harness_label:\s*\S/.test(line));
  if (!labelLine) return false;
  const specLabel = labelLine.replace(/^harness_label:\s*/, "").trim();
  if (specLabel !== harnessLabel) return false;
  const worktreeLine = lines.find((line) => line.startsWith("worktree:"));
  if (!worktreeLine) return false;
  const parsed = parseWorktreeSpecLine(worktreeLine);
  if (!parsed) return false;
  return (
    canonicalizeForComparison(parsed.path) ===
    canonicalizeForComparison(worktreePath)
  );
}

// HYK-413-seat-binding §2⑴ (1차 경로, 신규): 하네스 라벨로 배달 영수증
// 원장(dispatch-receipts.jsonl, dispatch-receipt-cli.mjs가 배달 시점에
// 기계가 쓰는 append-only 로그)에서 runtime_task_id를 읽는다. spec 자유
// 텍스트는 전혀 보지 않는다 -- ORCH가 그 두 줄(harness_label:/worktree:)을
// 손으로 잊어도 이 경로는 흔들리지 않는다.
//
// 경로 해석: 호출자가 dispatchLedgerPath를 명시로 주면 그 값, 아니면
// harnessDir(=<워크트리>/.harness)의 dispatch-receipt-path.txt 포인터
// 파일(HYK-387 3R -- env DISPATCH_RECEIPT_PATH는 ambient-leak 위험 때문에
// 의도적으로 안 쓴다, resolveDispatchLedgerPath 자신의 헤더 참조). 둘 다
// 없으면 "조회 자체를 시작할 수 없다"는 인프라 실패(RECEIPT_PATH_UNSET)로
// 반환하고, 호출부(resolveCandidateDispatchTask)가 그 경우에만 §2⑵ spec
// 폴백으로 넘어간다.
//
// ⛔fail-open 경계(coder-task.md §2⑵ 비타협): 원장 조회 자체는 성공했는데
// 이 라벨과 일치하는 레코드가 0건/2건 이상이거나, 정확히 1건이지만
// runtime_task_id 필드가 없으면(손상) -- 이 세 경우는 전부 infra:false로
// 반환해 spec 폴백을 절대 시도하지 않는다("장부가 답했는데 못 찾음"을
// 폴백으로 넘기면 그 자체가 fail-open이라는 지적, coder-task.md §2⑵ 원문).
//
// ⚠️정직 한계(coder-task.md §3 완료조건6, HYK-390): 이 함수는 원장 레코드의
// "존재"만 보고 "진위"는 보지 않는다 -- 같은 권한의 프로세스가 영수증
// 파일에 가짜 줄 하나를 추가하면(정상 append와 구별 불가) 이 축은 그
// 위조를 믿는다. 위조 탐지는 별도 이슈(HYK-390)의 몫이며, 이 라운드는
// "사람이 spec에 두 줄을 잊지 않아야 하는" 의존을 없애는 것이지 그
// 이상을 주장하지 않는다.
function resolveCandidateFromReceiptLedger({
  harnessLabel,
  dispatchLedgerPath,
  harnessDir,
}) {
  const ledgerPath = resolveDispatchLedgerPath(dispatchLedgerPath, harnessDir);
  if (!ledgerPath) {
    return {
      ok: false,
      infra: true,
      reasonCode: DELIVERED_SEAT_REASON.RECEIPT_PATH_UNSET,
      reason:
        "orca-adapter: resolveDeliveredSeat -- dispatch receipt ledger path unresolved (no dispatchLedgerPath and no <harnessDir>/dispatch-receipt-path.txt pointer), falling back to spec matching",
    };
  }
  const ledger = readDispatchLedgerRecords(ledgerPath);
  if (!ledger.ok) {
    return {
      ok: false,
      infra: true,
      reasonCode: DELIVERED_SEAT_REASON.RECEIPT_READ_FAILED,
      reason: `orca-adapter: resolveDeliveredSeat -- ${ledger.reason}, falling back to spec matching`,
    };
  }
  const matches = ledger.records.filter(
    (r) => isPlainObject(r) && r.harness_task_label === harnessLabel,
  );
  if (matches.length === 0) {
    return {
      infra: false,
      ...denyDeliveredSeat(
        DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK,
        `orca-adapter: resolveDeliveredSeat -- no dispatch receipt in ledger '${ledgerPath}' matches harness_task_label '${harnessLabel}'`,
      ),
    };
  }
  if (matches.length > 1) {
    return {
      infra: false,
      ...denyDeliveredSeat(
        DELIVERED_SEAT_REASON.AMBIGUOUS_CANDIDATE_TASK,
        `orca-adapter: resolveDeliveredSeat -- ${matches.length} dispatch receipts match harness_task_label '${harnessLabel}' in ledger '${ledgerPath}', refusing to guess`,
      ),
    };
  }
  const record = matches[0];
  if (!isNonEmptyString(record.runtime_task_id)) {
    return {
      infra: false,
      ...denyDeliveredSeat(
        DELIVERED_SEAT_REASON.MALFORMED_RECEIPT_RECORD,
        `orca-adapter: resolveDeliveredSeat -- the matching dispatch receipt for '${harnessLabel}' in ledger '${ledgerPath}' has no runtime_task_id field (damaged/incomplete record)`,
      ),
    };
  }
  return { ok: true, runtimeTaskId: record.runtime_task_id };
}

// §2 step①: 1차는 위 resolveCandidateFromReceiptLedger(원장) -- 그 조회
// 자체가 인프라 사유로 실패했을 때만(infra:true) task-list --status
// dispatched의 spec 자유 텍스트 매칭으로 물러난다(HYK-408 2R이 세운
// "인프라 실패에만 폴백" 경계와 같은 모양, coder-task.md §2⑵). 원장이
// 답했지만 못 찾은 경우(infra:false)는 그대로 실패를 반환한다.
function resolveCandidateDispatchTask(
  { harnessLabel, worktreePath, dispatchLedgerPath, harnessDir },
  opts,
) {
  const viaReceipt = resolveCandidateFromReceiptLedger({
    harnessLabel,
    dispatchLedgerPath,
    harnessDir,
  });
  if (viaReceipt.ok || !viaReceipt.infra) return viaReceipt;
  return resolveCandidateDispatchTaskViaSpec(
    { harnessLabel, worktreePath },
    opts,
  );
}

// §2⑵ 폴백 경로(구 1차, 이제는 보조): task-list --status dispatched에서
// 라벨+워크트리 경로가 spec에 함께 있는 후보를 정확히 하나로 좁힌다.
// 0개/2개+는 고르지 않고 실패. 원장 조회 자체가 실패했을 때만 불린다
// (위 resolveCandidateDispatchTask 참조) -- 로직 자체는 HYK-185-seat-corr
// 이래 바뀌지 않았다.
function resolveCandidateDispatchTaskViaSpec(
  { harnessLabel, worktreePath },
  opts,
) {
  let response;
  try {
    response = opts.execFn(buildTaskListDispatchedCommand());
  } catch (err) {
    return denyDeliveredSeat(
      DELIVERED_SEAT_REASON.TASK_LIST_QUERY_FAILED,
      `orca-adapter: resolveDeliveredSeat -- task-list query threw (${errText(err)})`,
    );
  }
  if (!isPlainObject(response) || response.ok !== true) {
    return denyDeliveredSeat(
      DELIVERED_SEAT_REASON.TASK_LIST_QUERY_FAILED,
      `orca-adapter: resolveDeliveredSeat -- ${extractFailureDetail(response)}`,
    );
  }
  const tasks = Array.isArray(response.result?.tasks)
    ? response.result.tasks
    : null;
  if (!tasks) {
    return denyDeliveredSeat(
      DELIVERED_SEAT_REASON.TASK_LIST_QUERY_FAILED,
      "orca-adapter: resolveDeliveredSeat -- task-list response missing/invalid result.tasks",
    );
  }
  const candidates = tasks.filter(
    (t) =>
      isPlainObject(t) &&
      isNonEmptyString(t.id) &&
      specMatchesDeliveryTarget(t.spec, harnessLabel, worktreePath),
  );
  if (candidates.length === 0) {
    return denyDeliveredSeat(
      DELIVERED_SEAT_REASON.SPEC_FALLBACK_NO_CANDIDATE_TASK,
      `orca-adapter: resolveDeliveredSeat -- ledger query failed for an infra reason and fell back to spec matching, but no dispatched task-list entry's spec matches label '${harnessLabel}' + worktree '${worktreePath}' either`,
    );
  }
  if (candidates.length > 1) {
    return denyDeliveredSeat(
      DELIVERED_SEAT_REASON.SPEC_FALLBACK_AMBIGUOUS_CANDIDATE_TASK,
      `orca-adapter: resolveDeliveredSeat -- ledger query failed for an infra reason and fell back to spec matching, and ${candidates.length} dispatched task-list entries match label '${harnessLabel}' + worktree '${worktreePath}', refusing to guess`,
    );
  }
  return { ok: true, runtimeTaskId: candidates[0].id };
}

// §2 step②: dispatch-show(runtimeTaskId) -> assignee_pane_key.
// normalizeDispatchShow(dispatch-correlation-adapter.mjs, 재사용 -- 재구현
// 금지)로 파싱한다.
function resolveAssigneePaneKey(runtimeTaskId, opts) {
  let response;
  try {
    response = opts.execFn(buildDispatchShowCommand(runtimeTaskId));
  } catch (err) {
    return denyDeliveredSeat(
      DELIVERED_SEAT_REASON.DISPATCH_SHOW_QUERY_FAILED,
      `orca-adapter: resolveDeliveredSeat -- dispatch-show query threw (${errText(err)})`,
    );
  }
  const normalized = normalizeDispatchShow(response);
  if (!normalized.ok) {
    return denyDeliveredSeat(
      DELIVERED_SEAT_REASON.DISPATCH_SHOW_INVALID,
      `orca-adapter: resolveDeliveredSeat -- dispatch-show normalize failed (reasonCode=${normalized.reasonCode})`,
    );
  }
  // HYK-464-followup-1 축B: status도 함께 실어 올린다(resolveLiveSeatByPaneKey
  // 가 "이 배달이 퇴역했는가"를 가리는 데 쓴다, 아래 참조). 값이 없으면
  // (normalizeDispatchShow가 undefined를 낸 경우) null -- "모른다"를
  // "퇴역했다"로 지어내지 않는다.
  return {
    ok: true,
    assigneePaneKey: normalized.assigneePaneKey,
    dispatchStatus: normalized.status ?? null,
  };
}

// HYK-464-followup-2 축B P1-B-1 (REVIEW-r1.md §2-1 반려 수리): 1R은
// "dispatched" 단일 문자열만 활성으로 봤다 -- 그런데 orca 자신은 그렇게
// 보지 않는다. 직접 조회한 근거 둘:
//   ⑴ `%APPDATA%/orca/orchestration.db`의 `dispatch_contexts` 스키마 --
//     `status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending',
//     'dispatched', 'completed', 'failed', 'circuit_broken'))`. 모든
//     배달은 `pending`으로 태어나 `dispatched`로 전이한다.
//   ⑵ orca 번들(app.asar) 자신의 활성 판정문 --
//     `dispatch.status !== "pending" && dispatch.status !== "dispatched"`
//     이면 `OrchestrationError("dispatch_inactive")`. 즉 orca는 `pending`과
//     `dispatched` 둘 다 "활성"으로 본다.
// 1R처럼 "dispatched" 하나만 활성으로 보면, `pending`(살아 있는 예약)이
// 좌석 부재를 "퇴역함"(정상)으로 오접어 진짜 이상(죽은 좌석 + 살아 있는
// 예약)이 무음이 된다. 이제 orca의 판정문을 그대로 옮긴 집합으로 판단한다
// -- 추측으로 어휘를 나열하지 않고 orca 자신이 "활성"이라 답한 값만 담는다.
const ACTIVE_DISPATCH_STATUSES = new Set(["pending", "dispatched"]);

// HYK-464-followup-2 축B P2-B-1 (REVIEW-r1.md §2-2): `completed`는 정상
// 종료(좌석 없음이 당연)지만, `failed`/`circuit_broken`은 배달 자체가
// 깨진 것이다 -- 같은 "해당 없음"으로 접으면 "라운드가 멈췄고 아무도
// 모른다"는 사고가 무음이 된다(이 감시기의 존재 이유 그 자체). 그래서
// 정상 종료(`completed`)와 깨진 종료(`failed`/`circuit_broken`)를
// 구별되는 값으로 가른다 -- 이 저장소가 이미 지키는 "구별되는 이름"
// 원칙(orch-stall-detect.mjs SEAT_LIVENESS_WIRE_STATUS.DISPATCH_RETIRED
// 주석 참조)을 여기에도 적용한다.
const RETIRED_DISPATCH_STATUS = "completed";
const FAILED_DISPATCH_STATUSES = new Set(["failed", "circuit_broken"]);

// §2 step③: 이 워크트리의 살아 있는 좌석(terminal list, 고아 제외 +
// worktreePath 정규화 일치 -- resolveSeatLivenessCandidate와 동일 후보
// 필터) 각각의 terminal show에서 `${tabId}:${leafId}`(paneKeyFromShow,
// terminal-show-adapter.mjs와 동일 형식 -- 벤더 형식, 우리 보증 아님,
// 아래 orca-adapter.test.mjs 형식 단언 참조)를 계산해 assigneePaneKey와
// 대조한다. 정확히 하나만 일치할 때만 지목 -- 0개(죽은 좌석만 일치하는
// 경우 포함)/2개+는 고르지 않는다(ORCH 실측: dispatched 표본 6/6이 죽은
// 좌석을 가리켰다 -- "기록이 있으니 이 좌석"이라고 넘겨짚지 않는다).
// terminal list 조회 -> 이 워크트리의 살아있는 좌석 후보(고아 제외 +
// worktreePath 정규화 일치 -- resolveSeatLivenessCandidate와 동일 필터).
// resolveLiveSeatByPaneKey에서 분리(복잡도 분산).
function resolveLiveSeatCandidatesForCorrelation(worktreePath, opts) {
  let listResponse;
  try {
    listResponse = opts.execFn(buildTerminalListCommand());
  } catch (err) {
    return denyDeliveredSeat(
      DELIVERED_SEAT_REASON.LIVE_SEAT_LIST_QUERY_FAILED,
      `orca-adapter: resolveDeliveredSeat -- terminal list query threw (${errText(err)})`,
    );
  }
  const list = parseTerminalList(listResponse);
  if (!list) {
    return denyDeliveredSeat(
      DELIVERED_SEAT_REASON.LIVE_SEAT_LIST_QUERY_FAILED,
      "orca-adapter: resolveDeliveredSeat -- terminal list response missing/invalid result.terminals",
    );
  }
  const target = canonicalizeForComparison(worktreePath);
  const candidates = list.filter(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.handle) &&
      !isOrphanSeat({ worktreePath: entry.worktreePath }) &&
      canonicalizeForComparison(entry.worktreePath) === target,
  );
  return { ok: true, candidates };
}

// terminal show(candidate.handle) -> `${tabId}:${leafId}`(벤더 형식,
// terminal-show-adapter.mjs와 동일).
//
// HYK-207-multiseat 수리: 예전에는 조회 자체 실패(execFn throw)를
// {ok:false}로 그대로 전파해 resolveLiveSeatByPaneKey가 그 즉시 후보
// 순회를 중단하고 전체 상관을 실패로 끝냈다 -- 좌석이 정확히 하나뿐일
// 때는 그 하나가 곧 답이라 드러나지 않던 결함이, 좌석이 둘 이상이면
// "우리가 실제로 찾는 좌석과 무관한 다른 후보 하나"의 조회 실패가 축
// 전체를 COLLECTION_FAILED로 끌고 내려간다 -- collectSeatObservationsForWorktree
// (위, seatIdle 축)가 이미 피해 간 "좌석 하나의 실패가 축 전체를 눈멀게
// 하는" 그 형태를 이 상관 함수만 되풀이하고 있었다. 이제 조회 자체
// 실패도 다른 실패 모드(malformed/좌석 없음)와 동일하게 "이 후보는
// 일치 안 함"으로만 접는다 -- 다른 후보가 여전히 유효할 수 있으므로
// 전체를 실패로 만들지 않는다. 그 대신 실패한 후보의 사유는 버리지
// 않고 모아서 되돌린다.
//
// ★HYK-207-multiseat 2R(REVIEW-1 반려 수리): 1R은 이 문장이 "전부
// 실패해 매치가 0개일 때"에만 참이었다 -- 매치가 성공하는 (더 흔한)
// 경로에서는 resolveLiveSeatByPaneKey가 모은 queryFailures를 함수
// 지역 변수에만 담아 두고 반환값 어디에도 싣지 않아 조용히 버려졌다
// (검토자 직접 주입 재현: 무관 후보 하나가 throw + 다른 후보가 정상
// 매치되어도 `{ok:true, handle, runtimeTaskId}`뿐이었다). 이제는
// 매치 성공 경로도 `partialFailures`(아래) 필드로 그 사유를 실어
// 되돌린다 -- 이 주석이 이번에는 두 경로 모두에 대해 참이다.
function fetchPaneKeyFromShow(candidateHandle, opts) {
  let showResponse;
  try {
    showResponse = opts.execFn(buildSeatShowCommand(candidateHandle));
  } catch (err) {
    return {
      ok: true,
      paneKeyFromShow: null,
      queryFailed: true,
      queryFailedReason: `orca-adapter: resolveDeliveredSeat -- terminal show query threw for candidate '${candidateHandle}' (${errText(err)})`,
    };
  }
  if (!isPlainObject(showResponse) || showResponse.ok !== true) {
    return { ok: true, paneKeyFromShow: null };
  }
  const terminal = isPlainObject(showResponse.result)
    ? showResponse.result.terminal
    : null;
  const tabId = isPlainObject(terminal) ? terminal.tabId : null;
  const leafId = isPlainObject(terminal) ? terminal.leafId : null;
  if (!isNonEmptyString(tabId) || !isNonEmptyString(leafId)) {
    return { ok: true, paneKeyFromShow: null };
  }
  return { ok: true, paneKeyFromShow: `${tabId}:${leafId}` };
}

// HYK-464-followup-2 축B P1-B-1/P2-B-1 (§3-e max-complexity 상한 준수를
// 위해 resolveLiveSeatByPaneKey에서 분리 -- 로직은 그대로, 자리만
// 옮겼다): dispatchStatus 하나를 세 갈래(활성 / 정상 종료(completed) /
// 깨진 종료(failed·circuit_broken))로 가른다. 판단은 항상
// ACTIVE_DISPATCH_STATUSES.has()(orca의 dispatch_inactive 판정문 그대로)
// 를 먼저 거친다 -- "활성이 아닌 값" 안에서만 completed/failed/
// circuit_broken을 가른다. status를 모르면(null/undefined) 어느 쪽도
// 지어내지 않는다 -- fail-closed 유지.
function classifyClosedDispatchStatus(dispatchStatus) {
  const isKnownInactiveStatus =
    typeof dispatchStatus === "string" &&
    !ACTIVE_DISPATCH_STATUSES.has(dispatchStatus);
  return {
    dispatchRetired:
      isKnownInactiveStatus && dispatchStatus === RETIRED_DISPATCH_STATUS,
    dispatchFailed:
      isKnownInactiveStatus && FAILED_DISPATCH_STATUSES.has(dispatchStatus),
  };
}

function noLiveSeatMatchReason(
  worktreePath,
  dispatchStatus,
  { dispatchRetired, dispatchFailed },
) {
  if (dispatchRetired) {
    return `orca-adapter: resolveDeliveredSeat -- assignee_pane_key matches no live seat in worktree '${worktreePath}' (dispatch status='${dispatchStatus}' -- this dispatch is retired, absence of a live seat is expected)`;
  }
  if (dispatchFailed) {
    return `orca-adapter: resolveDeliveredSeat -- assignee_pane_key matches no live seat in worktree '${worktreePath}' (dispatch status='${dispatchStatus}' -- this dispatch failed, not a normal end)`;
  }
  return `orca-adapter: resolveDeliveredSeat -- assignee_pane_key matches no live seat in worktree '${worktreePath}' (dead seat or rotated -- refusing to guess)`;
}

function resolveLiveSeatByPaneKey(
  { worktreePath, assigneePaneKey, dispatchStatus },
  opts,
) {
  const resolved = resolveLiveSeatCandidatesForCorrelation(worktreePath, opts);
  if (!resolved.ok) return resolved;
  const matches = [];
  const queryFailures = [];
  for (const candidate of resolved.candidates) {
    const shown = fetchPaneKeyFromShow(candidate.handle, opts);
    if (shown.queryFailed) {
      queryFailures.push({
        handle: candidate.handle,
        reason: shown.queryFailedReason,
      });
      continue;
    }
    if (shown.paneKeyFromShow === assigneePaneKey) {
      matches.push({ handle: candidate.handle });
    }
  }
  if (
    matches.length === 0 &&
    resolved.candidates.length > 0 &&
    queryFailures.length === resolved.candidates.length
  ) {
    return denyDeliveredSeat(
      DELIVERED_SEAT_REASON.LIVE_SEAT_LIST_QUERY_FAILED,
      `orca-adapter: resolveDeliveredSeat -- terminal show query failed for all ${queryFailures.length} live seat candidate(s) in worktree '${worktreePath}', refusing to guess`,
    );
  }
  if (matches.length === 0) {
    // HYK-464-followup-1 축B ⓐⓑ (2R P1-B-1/P2-B-1 수리 -- REVIEW-r1.md
    // §2-1/§2-2): 예약이 이미 "정상 종료"됐다면(`completed`) 살아있는
    // 좌석이 없는 게 정상이다 -- «측정 불가»가 아니라 «이 배달은 퇴역함»
    // 으로 구별해 호출부(judgeSeatLivenessForRepo 등)가 그 사실을
    // COLLECTION_FAILED와 다른 값으로 표면화할 수 있게 dispatchRetired를
    // 얹는다. `failed`/`circuit_broken`은 `completed`와 달리 "정상
    // 종료"가 아니므로 dispatchFailed로 구별해 얹는다(classifyClosedDispatchStatus
    // 참조). `pending`/`dispatched`(orca 자신이 "활성"으로 보는 값)에서는
    // 둘 다 서지 않는다 -- 그 값에서 좌석이 안 보이는 것은 진짜 이상이다
    // (1R의 결함이 정확히 이 구간에서 무너졌었다).
    const closedStatus = classifyClosedDispatchStatus(dispatchStatus);
    return {
      ...denyDeliveredSeat(
        DELIVERED_SEAT_REASON.NO_LIVE_SEAT_MATCH,
        noLiveSeatMatchReason(worktreePath, dispatchStatus, closedStatus),
      ),
      ...closedStatus,
    };
  }
  if (matches.length > 1) {
    return denyDeliveredSeat(
      DELIVERED_SEAT_REASON.AMBIGUOUS_LIVE_SEAT_MATCH,
      `orca-adapter: resolveDeliveredSeat -- ${matches.length} live seats share the same pane key, refusing to guess`,
    );
  }
  // HYK-207-multiseat 2R (REVIEW 반려 수리): 매치가 정확히 하나라 성공하는
  // 이 경로에서도 -- 다른(무관한) 후보의 조회 실패는 여전히 실재했던
  // 사실이다. 위 주석이 이미 "실패한 후보의 사유는 버리지 않고 모아서
  // 되돌린다"고 적어 뒀으니 그 말을 참으로 만든다 -- queryFailures를
  // 성공 반환값에도 실어 호출자가 "성공은 했지만 다른 좌석 하나는 조회가
  // 안 됐다"를 볼 수 있게 한다(그 자체로 실패는 아니다 -- fail-loud는
  // 매치 0개/2개+ 판정에만 걸린다, §3 비타협 그대로).
  return {
    ok: true,
    handle: matches[0].handle,
    partialFailures: queryFailures,
  };
}

// ctx: { harnessLabel, worktreePath, dispatchLedgerPath?, harnessDir? } --
// opts: { execFn }. 순수 조합(§2 step①②③ 순서 그대로, HYK-413-seat-binding
// 으로 step①의 1차 경로만 원장 조회로 바뀌었다). dispatchLedgerPath/
// harnessDir 둘 다 선택(옵션) -- 둘 다 생략하면 원장 경로를 해석할 수
// 없어 자동으로 §2⑵ spec 폴백으로 물러난다(호출자가 아직 배선하지 않은
// 구버전 호출부와도 100% 호환, 회귀 없음). execFn 호출은 (원장 폴백이
// 발동했을 때만) task-list 1 + dispatch-show 1 + terminal-list 1 + 이
// 워크트리의 살아있는 좌석 수만큼의 terminal-show -- 전부 읽기 전용,
// dispatch/send/close/worktree 계열 호출 0.
export function resolveDeliveredSeat(ctx = {}, opts = {}) {
  const { harnessLabel, worktreePath, dispatchLedgerPath, harnessDir } =
    isPlainObject(ctx) ? ctx : {};
  if (!isNonEmptyString(harnessLabel) || !isNonEmptyString(worktreePath)) {
    return denyDeliveredSeat(
      DELIVERED_SEAT_REASON.INPUT_INVALID,
      "orca-adapter: resolveDeliveredSeat -- harnessLabel and worktreePath are required",
    );
  }
  if (typeof opts.execFn !== "function") {
    return denyDeliveredSeat(
      DELIVERED_SEAT_REASON.TASK_LIST_QUERY_FAILED,
      "orca-adapter: resolveDeliveredSeat -- opts.execFn is required",
    );
  }
  const candidate = resolveCandidateDispatchTask(
    { harnessLabel, worktreePath, dispatchLedgerPath, harnessDir },
    opts,
  );
  if (!candidate.ok) return candidate;
  const paneKeyResult = resolveAssigneePaneKey(candidate.runtimeTaskId, opts);
  if (!paneKeyResult.ok) return paneKeyResult;
  const seatResult = resolveLiveSeatByPaneKey(
    {
      worktreePath,
      assigneePaneKey: paneKeyResult.assigneePaneKey,
      dispatchStatus: paneKeyResult.dispatchStatus,
    },
    opts,
  );
  if (!seatResult.ok) return seatResult;
  return {
    ok: true,
    handle: seatResult.handle,
    runtimeTaskId: candidate.runtimeTaskId,
    // HYK-207-multiseat 2R: resolveLiveSeatByPaneKey가 모은 partialFailures
    // (매치는 성공했지만 다른 후보 하나 이상의 조회가 실패했던 사실)를
    // 그대로 위로 올린다 -- 여기서 새로 만들지 않는다(단일 출처 유지).
    partialFailures: seatResult.partialFailures,
  };
}

// ---- HYK-170 coder-1: 실측 argv (2단 라이브 프로브, 영수증 §8 대조표
// 그대로) -- v1(HYK-169)이 "미검증 가정"으로 남긴 6개 함수를 전부 실물과
// 대조해 고쳤다. 각 함수 옆 주석의 "실측"은 위 두 영수증 파일의 근거를
// 가리킨다(추측 0).
function buildSeatLauncherCommand(role, worktreePath) {
  return `pwsh -NoExit -File "${SEAT_LAUNCHER_PATH}" -Role ${role} -Worktree "${worktreePath}"`;
}
// A1(실측 §8-1): --shell/--setup 둘 다 존재하지 않는 옵션이었다. 실물은
// `terminal create --worktree <selector> --command "<cmd>" [--title <t>] --json`.
// HYK-170 사이클2 ②-a coder-1 (D12): 이 빌더는 더 이상 createNewSeat에서
// 호출되지 않는다 -- ⓑ(새 좌석 생성 뒤 기본 탭을 close)가 pm-2에서
// 반려됐기 때문이다(D9 close 권한 변수 + D3 `--tab` 함정 + 불필요 side
// effect, 아래 createNewSeat 주석 참조). argv shape 자체는 실측값이라
// 버리지 않고 순수 빌더+단위시험만 남긴다(조용한 삭제 방지, G8).
export function buildSeatCreateCommand(role, worktreePath) {
  return [
    "terminal",
    "create",
    "--worktree",
    `path:${worktreePath}`,
    "--command",
    buildSeatLauncherCommand(role, worktreePath),
    "--title",
    role,
    "--json",
  ];
}
// A2(실측 §8-2): --handle 옵션은 없다 -- 실물은 --terminal.
export function buildSeatSubmitCommand(seatHandle) {
  return ["terminal", "send", "--terminal", seatHandle, "--enter", "--json"];
}
// HYK-170 사이클2 ②-a coder-1 (D12): 새 워크트리의 기본 shell 탭에 런처
// 명령을 붙여넣는 용도 -- buildSeatSubmitCommand(A2, --enter만)의 argv
// shape를 그대로 확장해 --text를 추가한 것이다. **정직 한계**: `--text`
// 옵션 자체는 이번 2단 라이브 프로브 범위 밖이라 실측되지 않았다 -- fake
// execFn PASS 대상이며 라이브 검증 전에는 UNVERIFIED다(pm-2 §QB).
export function buildSeatLaunchTextCommand(seatHandle, commandText) {
  return [
    "terminal",
    "send",
    "--terminal",
    seatHandle,
    "--text",
    commandText,
    "--json",
  ];
}
// A4(실측 §8-4): 옵션명은 유일하게 정확했다. 단 기본 --unread는 메시지를
// 읽음 처리하므로(다른 소비자 것을 태워버림), 비권위 감지 폴링에는 --peek을
// 추가한다(1단-help.md §5).
export function buildNonBlockingCheckCommand(coordinatorHandle) {
  return [
    "orchestration",
    "check",
    "--terminal",
    coordinatorHandle,
    "--types",
    "worker_done,escalation",
    "--peek",
    "--json",
  ];
}
// A3(실측 §8-3): --handle 없음 -- 실물은 --terminal. **--tab을 붙이면
// 안 된다** -- UI 미채택 pane에서 tab_not_found(exit 1)로 실패한다(실측
// 2단 §4). teardownSeat이 이 실패를 "이미 닫힘"으로 흡수한다.
export function buildSeatCloseCommand(seatHandle) {
  return ["terminal", "close", "--terminal", seatHandle, "--json"];
}
// A6(실측 §8-6): `orchestration dispatch-cleanup` 서브커맨드 자체가 없다
// (`orchestration --help` 실측). 대체 = task-update로 실패 상태 마킹.
// 유효 status = pending/ready/dispatched/completed/failed/blocked. 인자도
// --assignee(handle)이 아니라 **task id**로 바뀐다 -- 호출부(teardownSeat)
// 시그니처를 seatHandle 기반에서 taskId 기반으로 함께 고쳤다.
export function buildTaskUpdateFailedCommand(taskId) {
  return [
    "orchestration",
    "task-update",
    "--id",
    taskId,
    "--status",
    "failed",
    "--json",
  ];
}
// D14-A/B (pm-2 §QC): 소비 후 완료 전이·stale 복구 보정 양쪽에서 쓴다.
// "completed"도 실측된 유효 status 중 하나다(위 A6 주석의 유효값 목록).
export function buildTaskUpdateCompletedCommand(taskId) {
  return [
    "orchestration",
    "task-update",
    "--id",
    taskId,
    "--status",
    "completed",
    "--json",
  ];
}
// A5(실측 §8-5): git 명령으로 구성해뒀던 것을 폐기 -- Orca
// `worktree rm --worktree path:<p> --force --json` 한 방이 폴더+git등록+
// 브랜치+탭을 전부 제거한다(2단 §4/§6 실측). 실행은 guardedExec을 통해
// 실제로 나간다(구성만 하고 실행 0이던 v1과 다름 -- 이 명령은 orca 명령이라
// git처럼 실행을 미룰 이유가 없다).
export function buildWorktreeRemoveCommand(worktreePath) {
  return [
    "worktree",
    "rm",
    "--worktree",
    `path:${worktreePath}`,
    "--force",
    "--json",
  ];
}

// ---- B: 워크트리 생성 복원 (2단 §1 실측, v1에서 제거됐던 기능) ----
// 비타협: 경로를 요청에 넣지 않는다(--path 옵션 부재, 실측 1단 §1). 이름만
// 주고 응답의 result.worktree.path/branch를 읽는다(추측 조립 금지).
// coder-2 (review-1 C1 반려 결함 수리): baseBranch가 없으면(undefined/null/
// 빈 문자열 전부) --base-branch 플래그 자체를 argv에서 생략한다 -- 이전엔
// 항상 붙였고, 미제공 시 undefined가 문자열 "undefined"가 아니라 그대로
// JS 값(null/undefined)으로 배열에 들어가 CLI에 깨진 인자가 전달됐다(실측
// §1: 생략 시 repo 기본 base 사용, 이게 정답이다).
// HYK-331-worktree-deps-1 (coder-task.md §1/§2): `--setup skip`이 하드코딩돼
// 있어 하네스가 만드는 모든 워크트리에 node_modules가 없었다 -- 그래서
// 워커마다 quality-check 실패 -> npm ci 왕복이 라운드마다 고정으로
// 발생했다(ORCH 실측, 워커 2명 각각). 왜 skip이었는지는 이 코드베이스
// 어디에도 근거가 남아있지 않다(조용한 원래 결정이었을 가능성) -- ORCH
// 라이브 실측(coder-task.md §1 표)으로 `--setup run`이면 node_modules가
// 실제로 준비됨을 2건 확인했으므로 기본값을 그쪽으로 뒤집는다. 되돌리고
// 싶은 다음 사람은 이 주석과 위 실측을 먼저 봐야 한다(조용한 변경
// 금지). 기본을 안전한 쪽(run)으로 두되, 의도적으로 건너뛰려는 호출자
// (예: 빠른 합성 시험)를 위해 인자로 선택 가능하게 열어둔다 -- 오타가
// 조용히 skip으로 흐르면 이 버그가 재발하므로 허용 값 밖은 거부한다.
export const WORKTREE_SETUP_VALUES = Object.freeze(["run", "skip", "inherit"]);

export function buildWorktreeCreateCommand({
  name,
  repoId,
  baseBranch,
  setup = "run",
} = {}) {
  if (!WORKTREE_SETUP_VALUES.includes(setup)) {
    throw new Error(
      `orca-adapter: buildWorktreeCreateCommand -- invalid setup ${JSON.stringify(setup)} (allowed: ${WORKTREE_SETUP_VALUES.join("|")})`,
    );
  }
  const argv = [
    "worktree",
    "create",
    "--name",
    name,
    "--repo",
    `id:${repoId}`,
    "--setup",
    setup,
    "--no-parent",
  ];
  if (isNonEmptyString(baseBranch)) {
    argv.push("--base-branch", baseBranch);
  }
  argv.push("--json");
  return argv;
}
// 응답 파싱만 분리(parseWorktreeList/parseRuntimeTaskId 전례와 동형).
// 브랜치명은 런타임이 <github-user>/ 접두를 붙이므로(2단 §1 실측) 반드시
// 이 함수로 응답에서 읽어야 한다 -- 요청 name으로 조립하면 안 된다.
export function parseWorktreeCreateResponse(response) {
  if (!isPlainObject(response) || response.ok !== true) return null;
  const wt = isPlainObject(response.result) ? response.result.worktree : null;
  if (
    !isPlainObject(wt) ||
    !isNonEmptyString(wt.path) ||
    !isNonEmptyString(wt.branch)
  ) {
    return null;
  }
  const warnings = Array.isArray(response.result.warnings)
    ? response.result.warnings
    : [];
  return { path: wt.path, branch: wt.branch, warnings };
}

// review-1 C1 반려 결함 수리: parseWorktreeCreateResponse는 path와 branch
// 둘 다 요구하지만, 롤백 대상 경로 판정은 branch 없이 path만 있어도 가능해야
// 한다(branch가 비어 있어도 워크트리는 이미 디스크에 만들어져 있다 -- 실측
// 재현: `branch:''`인데도 worktree create 응답은 ok:true). 응답-only 원칙은
// 유지(요청 name으로 경로를 만들지 않는다).
function extractCreatedWorktreePath(response) {
  if (!isPlainObject(response) || response.ok !== true) return null;
  const wt = isPlainObject(response.result) ? response.result.worktree : null;
  const path = isPlainObject(wt) ? wt.path : null;
  return isNonEmptyString(path) ? path : null;
}

// B 순서(태스크 지시 그대로): 생성 -> 응답 경로로 resolveSeatLocation ->
// checkWorktreeManaged. review-1 C1: `worktree create`가 ok:true를 반환한
// 순간부터는 이후 어느 단계에서 실패하든(응답 파싱 실패 포함) 되돌린다 --
// 이전엔 응답 파싱 실패 시 롤백을 건너뛰어 실제로 만들어진 워크트리가
// 누출됐다(재현: branch:'' 응답에서 rm 호출 0건). 롤백 대상은 항상 응답
// 경로(extractCreatedWorktreePath)이지 요청 name이 아니다(변이 죽이기 요구).
// 경로조차 없으면 롤백을 시도하지 않고 그 사실 자체를 steps에 남긴다(조용히
// 삼키지 않는다) -- 롤백 실패도 원래 실패 사유를 덮지 않고 steps에 별도로
// 남긴다.
export function createManagedWorktree(
  { role, name, repoId, baseBranch } = {},
  opts = {},
) {
  const steps = [];
  if (typeof opts.execFn !== "function") {
    return {
      ok: false,
      reason: "orca-adapter: createManagedWorktree -- opts.execFn is required",
      worktreeReason: WORKTREE_REASON.CREATE_FAILED,
      steps,
    };
  }
  const created = guardedExec(
    buildWorktreeCreateCommand({ name, repoId, baseBranch }),
    opts.execFn,
    "WORKTREE_CREATE_FAILED",
  );
  if (!created.ok) {
    return {
      ok: false,
      reason: created.reason,
      worktreeReason: WORKTREE_REASON.CREATE_FAILED,
      steps,
    };
  }

  // created.ok === true 이후의 모든 실패 경로는 이 함수로 되돌린다.
  function rollback(failReason, worktreeReason, extra = {}) {
    const createdPath = extractCreatedWorktreePath(created.response);
    if (!createdPath) {
      steps.push(
        "worktree-rollback-not-possible:no-path-in-response (manual cleanup may be required)",
      );
      return { ok: false, reason: failReason, worktreeReason, steps, ...extra };
    }
    const removal = guardedExec(
      buildWorktreeRemoveCommand(createdPath),
      opts.execFn,
      "WORKTREE_ROLLBACK_FAILED",
    );
    steps.push(
      removal.ok
        ? "worktree-rollback-ok"
        : `worktree-rollback-failed:${removal.reason}`,
    );
    return { ok: false, reason: failReason, worktreeReason, steps, ...extra };
  }

  const parsed = parseWorktreeCreateResponse(created.response);
  if (!parsed) {
    return rollback(
      "orca-adapter: WORKTREE_CREATE_FAILED -- response.result.worktree.{path,branch} missing/empty",
      WORKTREE_REASON.CREATE_FAILED,
    );
  }
  if (parsed.warnings.length > 0) {
    steps.push(`worktree-create-warnings:${JSON.stringify(parsed.warnings)}`);
  }
  steps.push("worktree-created");

  const location = resolveSeatLocation({ role, requestedPath: parsed.path });
  if (!location.ok) {
    return rollback(location.detail, WORKTREE_REASON.CREATE_LOCATION_REJECTED, {
      locationReason: location.reason,
    });
  }

  const managed = checkWorktreeManaged({ requestedPath: parsed.path }, opts);
  if (!managed.ok) {
    return rollback(
      managed.detail,
      WORKTREE_REASON.CREATE_NOT_MANAGED_AFTER_CREATE,
    );
  }

  return {
    ok: true,
    path: parsed.path,
    branch: parsed.branch,
    warnings: parsed.warnings,
    steps,
  };
}

// ---- D: 좌석 생사 판정 (2단 §5 실측) ----
// 제거된 워크트리에 붙어 있던 좌석은 connected:true/writable:true인 채로
// terminal list에 남는다 -- 단 worktreePath가 빈 문자열이다. 생사는
// connected/writable이 아니라 worktreePath 비어있음으로만 판정한다.
// 정직 경계: 이건 터미널 칸(pane) 수준 신호다. HYK-163 2A가 UNVERIFIED로
// 남긴 에이전트 인스턴스 수준 liveness는 이걸로 닫히지 않는다.
export function isOrphanSeat({ worktreePath } = {}) {
  return worktreePath === "";
}
// 부수 판별식(2단 §7 실측): UI 미채택 좌석("유령 터미널")의 tabId는
// `pty:`로 시작한다(UI 채택 탭은 순수 uuid).
export function isGhostTab(tabId) {
  return typeof tabId === "string" && tabId.startsWith("pty:");
}

// ---- C: 배달 도착 확인 (2단 §3 실측) ----
// preview는 원문이 아니다 -- 셸 예측입력으로 문자 단위 재그림이 섞인다.
// 완전 일치 단언은 금지, 정규화(공백 붕괴) 후 마커 부분 일치만 확인한다.
export function buildSeatShowCommand(seatHandle) {
  return ["terminal", "show", "--terminal", seatHandle, "--json"];
}
export function parseSeatPreview(response) {
  if (!isPlainObject(response) || response.ok !== true) return null;
  const preview = response.result?.terminal?.preview;
  return typeof preview === "string" ? preview : null;
}
export function normalizePreview(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}
export function previewContainsMarker(preview, marker) {
  if (!isNonEmptyString(marker)) return false;
  return normalizePreview(preview).includes(marker);
}

// review-1 C2: 배달 도착의 "거짓 실패" 방지(영수증 §9) -- 마커가 아직 안
// 보여도 좌석이 이미 붙여넣은 내용을 처리 중(codex의 `[Pasted Content`
// 대기 표식)이거나 여러 입력이 큐에 쌓인 상태(`Press up to edit queued
// messages`)라면 붙여넣기 자체는 성공한 것이다 -- 이 경우도 확인으로
// 인정한다.
const BUSY_SIGNALS = Object.freeze([
  "Press up to edit queued messages",
  "[Pasted Content",
]);
export function previewShowsBusySignal(preview) {
  const normalized = normalizePreview(preview);
  return BUSY_SIGNALS.some((signal) => normalized.includes(signal));
}

// 실측 오류 shape(2단 §4): {ok:false, error:{code, message}} -- 기존
// response.reason 우선 확인 뒤, 없으면 error.message도 본다(tab_not_found
// 판별에 필요). guardedExec에서 분리(복잡도 분산).
function extractFailureDetail(response) {
  if (!isPlainObject(response)) return "response.ok !== true";
  if (isNonEmptyString(response.reason)) return response.reason;
  if (
    isPlainObject(response.error) &&
    isNonEmptyString(response.error.message)
  ) {
    return response.error.message;
  }
  return "response.ok !== true";
}

// task-create/dispatch만 §4-2 화이트리스트를 강제한다(그 외 4종은 이
// 어댑터 자신이 유일한 발신처라 guard를 강제하지 않는다). guardedExec에서
// 분리(복잡도 분산).
function shouldEnforceWhitelist(argv) {
  return (
    Array.isArray(argv) && (argv[1] === "task-create" || argv[1] === "dispatch")
  );
}

// 화이트리스트 통과 + execFn 호출을 한곳에 묶는다(orca-spike-runner.runGuardedStep
// 전례와 동형 -- 이 어댑터 자체 receipts는 호출자가 필요 시 감싼다).
function guardedExec(argv, execFn, failReason) {
  const guard = assertAllowedOrcaCommand(argv);
  if (shouldEnforceWhitelist(argv) && !guard.ok) {
    return { ok: false, reason: guard.reason };
  }
  let response;
  try {
    response = execFn(argv);
  } catch (err) {
    return {
      ok: false,
      reason: `orca-adapter: ${failReason} -- execFn threw (${errText(err)})`,
    };
  }
  if (!isPlainObject(response) || response.ok !== true) {
    return {
      ok: false,
      reason: `orca-adapter: ${failReason} -- ${extractFailureDetail(response)}`,
      response,
    };
  }
  return { ok: true, response };
}

function defaultFsDeps(overrides = {}) {
  return {
    existsFn:
      typeof overrides.existsFn === "function"
        ? overrides.existsFn
        : existsSync,
    mkdirFn:
      typeof overrides.mkdirFn === "function" ? overrides.mkdirFn : mkdirSync,
    copyFileFn:
      typeof overrides.copyFileFn === "function"
        ? overrides.copyFileFn
        : copyFileSync,
    copyDirFn:
      typeof overrides.copyDirFn === "function"
        ? overrides.copyDirFn
        : (src, dst) => cpSync(src, dst, { recursive: true }),
  };
}

// A3: 메인 repo의 .claude/settings.local.json을 워크트리에 복사(훅 복원).
// 이미 있으면 건너뜀(멱등).
function ensureSettingsCopied(mainRepoDir, worktreePath, fs, steps) {
  if (!isNonEmptyString(mainRepoDir)) return;
  const src = join(mainRepoDir, ".claude", "settings.local.json");
  const dst = join(worktreePath, ".claude", "settings.local.json");
  if (fs.existsFn(dst) || !fs.existsFn(src)) return;
  fs.mkdirFn(dirname(dst), { recursive: true });
  fs.copyFileFn(src, dst);
  steps.push("settings-copied");
}

// A5: node_modules 준비(네트워크 설치 금지 -- 메인에서 복사만).
function ensureNodeModulesCopied(mainRepoDir, worktreePath, fs, steps) {
  if (!isNonEmptyString(mainRepoDir)) return;
  const src = join(mainRepoDir, "node_modules");
  const dst = join(worktreePath, "node_modules");
  if (fs.existsFn(dst) || !fs.existsFn(src)) return;
  fs.copyDirFn(src, dst);
  steps.push("node_modules-copied");
}

function isValidCreateSpec(create) {
  return (
    isPlainObject(create) &&
    isNonEmptyString(create.name) &&
    isNonEmptyString(create.repoId)
  );
}

// HYK-170 coder-1 (§B): worktreePath(기존 관리 워크트리 재사용)와
// create(신규 생성 -- name/repoId 필수, baseBranch 선택)는 상호 배타적
// 입력 경로다. 정확히 하나만 필요하다 -- 생성은 명시적으로 opt-in해야
// 하고(암묵적 생성 금지, coder-5 원칙 계승), 아무것도 없으면 실패.
function validateEnsureSeatInput(role, worktreePath, create) {
  if (!isNonEmptyString(role) || !ENGINE_BY_ROLE[role]) {
    return `orca-adapter: ensureSeat -- unknown role ${JSON.stringify(role)}`;
  }
  const hasPath = isNonEmptyString(worktreePath);
  const hasCreate = isValidCreateSpec(create);
  if (!hasPath && !hasCreate) {
    return "orca-adapter: ensureSeat -- worktreePath or a valid create{name,repoId} is required";
  }
  return null;
}

// HYK-170 사이클2 ②-a coder-1 (D12, pm-2 §QB 채택안 ⓐ): "새 좌석"이라는
// 이름과 달리 이 경로는 더 이상 `terminal create`를 호출하지 않는다 --
// 새 workspace의 기본 shell 탭이 정확히 1개일 때 그 탭에서 사람 소유
// 런처를 text+Enter로 기동한다. 후보 판정은 A-1(resolveSeatHandle)을 그대로
// 재사용한다 -- 0개/2개+ 실패에서도 이 함수 자신은 어떤 side effect
// 호출도 만들지 않는다(resolveSeatHandle 자체의 순수-조합 계약). marker를
// 후보 선택 근거로 쓰지 않는다는 계약도 그대로 승계된다.
//
// ⓑ(새 좌석 생성 뒤 여분 탭 close)는 pm-2에서 반려됐다 -- D9(`terminal
// close` 권한 변수)·D3(`--tab` 함정) 위에 불필요한 생성/삭제 side effect가
// 겹치고, teardown-매사이클과 결합하면 워크트리 오삭제 위험이 커진다(사유
// 보존, G8).
//
// 정직 한계: 기본 shell 탭에서 런처가 올바른 role/engine/env로 장기 실행된
// 라이브 표본은 0건이다 -- 이 경로는 fake execFn PASS 대상이지 라이브
// 준비 완료 주장이 아니다(UNVERIFIED, 실패해도 ⓑ로 자동 강등하지 않는다).
function createNewSeat(role, worktreePath, mainRepoDir, opts, fs, steps) {
  ensureSettingsCopied(mainRepoDir, worktreePath, fs, steps);
  ensureNodeModulesCopied(mainRepoDir, worktreePath, fs, steps);

  const resolved = resolveSeatHandle({ role, worktreePath }, opts);
  if (!resolved.ok) {
    return {
      ok: false,
      reason: `orca-adapter: ${REASON.SEAT_CREATE_FAILED} -- ${resolved.reason}`,
      seatHandleReason: resolved.seatHandleReason,
    };
  }

  const launched = guardedExec(
    buildSeatLaunchTextCommand(
      resolved.handle,
      buildSeatLauncherCommand(role, worktreePath),
    ),
    opts.execFn,
    REASON.SEAT_CREATE_FAILED,
  );
  if (!launched.ok) return { ok: false, reason: launched.reason };

  const submitted = guardedExec(
    buildSeatSubmitCommand(resolved.handle),
    opts.execFn,
    REASON.SEAT_CREATE_FAILED,
  );
  if (!submitted.ok) return { ok: false, reason: submitted.reason };

  // HYK-170 사이클2 ②-a coder-2 (review-3 실결함 2 수리, pm-2 §S6 postcondition):
  // 런처 기동(text+Enter) 뒤 그 경로 후보가 여전히 정확히 1개인지 다시
  // 확인한다 -- 기동 전 확인만으로는 기동 자체가 후보 수를 바꾸는(또는
  // 경쟁 상태로 다른 좌석이 그 사이 나타나는) 경우를 못 잡는다.
  // resolveSeatHandle(A-1)의 0/1/2+ 계약을 그대로 재사용한다(재구현 금지) --
  // 재조회가 0/2+/고아로 판정하면 이 함수는 실패를 반환하고, 그 결과
  // ensureSeat -> relayStep의 seat 단계가 실패해 deliver는 절대 호출되지
  // 않는다(배달 0).
  const reverified = resolveSeatHandle({ role, worktreePath }, opts);
  if (!reverified.ok) {
    return {
      ok: false,
      reason: `orca-adapter: ${REASON.SEAT_CREATE_FAILED} -- post-launch reverify failed: ${reverified.reason}`,
      seatHandleReason: reverified.seatHandleReason,
    };
  }

  steps.push("seat-launched-in-default-tab");
  return {
    ok: true,
    seatHandle: reverified.handle,
    created: false,
    stepsPerformed: steps,
  };
}

// ---- 포트 1: 실행자리(seat) ----
// 좌석 위치 정책(relay-terminal-setup.md §6) -- 재사용/기존 경로 전용. 생성
// 경로(§B)는 경로가 응답에서만 나오므로 createManagedWorktree 내부에서 같은
// 판정을 응답 경로에 대해 수행한다(요청 시점엔 대상 경로 자체가 없다).
// ensureSeat에서 분리(복잡도 분산).
function checkExistingSeatLocation(role, worktreePath) {
  if (!isNonEmptyString(worktreePath)) return null;
  const location = resolveSeatLocation({ role, requestedPath: worktreePath });
  if (location.ok) return null;
  return {
    ok: false,
    reason: location.detail,
    locationReason: location.reason,
  };
}

// D: worktreePath가 빈 문자열인 좌석은 "고아 좌석"이다(connected/writable만
// 으로 생사를 판단하지 않는다, 2단 §5 실측) -- 호출자가 조회해 넘긴 값을
// 순수 판정만 한다(execFn을 부르지 않는다). ensureSeat에서 분리.
function tryReuseExistingSeat(opts) {
  if (!isNonEmptyString(opts.existingSeatHandle)) return null;
  if (isOrphanSeat({ worktreePath: opts.existingSeatWorktreePath })) {
    return {
      ok: false,
      reason: `orca-adapter: ensureSeat -- existingSeatHandle '${opts.existingSeatHandle}' is an orphan seat (worktreePath is empty, HYK-170 §D)`,
    };
  }
  return {
    ok: true,
    seatHandle: opts.existingSeatHandle,
    created: false,
    stepsPerformed: [],
  };
}

// §B: worktreePath가 없고 create가 주어졌으면 새 워크트리부터 만든다(생성
// -> 위치/등록 검증 -> 실패 시 되돌림은 createManagedWorktree 몫). ensureSeat
// 에서 분리(복잡도 분산).
function ensureSeatViaCreate(c, opts) {
  const createResult = createManagedWorktree(
    {
      role: c.role,
      name: c.create.name,
      repoId: c.create.repoId,
      baseBranch: c.create.baseBranch,
    },
    opts,
  );
  if (!createResult.ok) {
    return {
      ok: false,
      reason: createResult.reason,
      worktreeReason: createResult.worktreeReason,
      locationReason: createResult.locationReason,
      stepsPerformed: createResult.steps,
    };
  }
  return createNewSeat(
    c.role,
    createResult.path,
    c.mainRepoDir,
    opts,
    defaultFsDeps(opts),
    [...createResult.steps],
  );
}

// A-2 (HYK-170 사이클2): ensureSeat의 공개 출력 봉투에는 seatHandle이 없다
// -- 내부 헬퍼(tryReuseExistingSeat/createNewSeat)는 여전히 handle을
// 만들어내지만(좌석을 실제로 만들거나 재사용하려면 그 순간엔 필요하다),
// 그 값을 코어로 반환하거나 다른 포트로 운반하지 않는다. deliverTask/
// teardownSeat은 나중에 {role, worktreePath}로 resolveSeatHandle을 통해
// 스스로 다시 조회한다(A-1) -- 이 함수가 만든 handle을 기억해두지 않는다.
function stripSeatHandle(result) {
  if (!isPlainObject(result) || !("seatHandle" in result)) return result;
  const rest = { ...result };
  delete rest.seatHandle;
  return rest;
}

// ctx: { role, worktreePath?, create?: {name, repoId, baseBranch?}, mainRepoDir? }
// opts: { execFn, existsFn?, mkdirFn?, copyFileFn?, copyDirFn?, existingSeatHandle?,
//         existingSeatWorktreePath? }
// B2: 좌석 handle은 env에서 읽지 않는다 -- existingSeatHandle은 호출자가
// pane key 조회로 이미 확인한 값만 넘기고, 이 함수는 env를 전혀 참조하지 않는다.
export function ensureSeat(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const invalid = validateEnsureSeatInput(c.role, c.worktreePath, c.create);
  if (invalid) return { ok: false, reason: invalid };

  const locationRejection = checkExistingSeatLocation(c.role, c.worktreePath);
  if (locationRejection) return locationRejection;

  const reused = tryReuseExistingSeat(opts);
  if (reused) return stripSeatHandle(reused);

  if (typeof opts.execFn !== "function") {
    return {
      ok: false,
      reason:
        "orca-adapter: ensureSeat -- opts.execFn is required to create a new seat",
    };
  }

  if (!isNonEmptyString(c.worktreePath)) {
    return stripSeatHandle(ensureSeatViaCreate(c, opts));
  }

  // review-2 (coder-4): 재사용/기존 경로에서는 Orca 관리 워크트리 여부를
  // 확인한다. 등록 확인 실패/미등록 시 A3/A5 복사·좌석 생성 호출은 전혀
  // 일어나지 않는다 -- 이 경로에서 미등록이면 (설계상 §B로 자동 전환하지
  // 않고) 그대로 거부한다(암묵적 생성 금지, coder-5 원칙 계승).
  const managed = checkWorktreeManaged({ requestedPath: c.worktreePath }, opts);
  if (!managed.ok) {
    return {
      ok: false,
      reason: managed.detail,
      worktreeReason: managed.reason,
    };
  }

  return stripSeatHandle(
    createNewSeat(
      c.role,
      managed.path,
      c.mainRepoDir,
      opts,
      defaultFsDeps(opts),
      [],
    ),
  );
}

// A-2: deliverTask는 더 이상 seatHandle을 입력으로 받지 않는다 -- worktreePath
// (+role)만 받고, 실제 handle은 이 포트 내부에서 A-1(resolveSeatHandle)로
// 그 자리에서 해석한다. opts.existingSeatHandle은 테스트 전용 override
// 경로로만 남긴다(ensureSeat의 기존 existingSeatHandle 전례와 동형) --
// production 호출부(relay-core.mjs)는 이 옵션을 넘기지 않는다.
function validateDeliverInput(c, opts) {
  if (typeof opts.execFn !== "function") {
    return "orca-adapter: deliverTask -- opts.execFn is required";
  }
  if (
    !isNonEmptyString(opts.existingSeatHandle) &&
    !isNonEmptyString(c.worktreePath)
  ) {
    return "orca-adapter: deliverTask -- worktreePath is required";
  }
  return null;
}

function resolveHandleForPort(c, opts, callerLabel) {
  if (isNonEmptyString(opts.existingSeatHandle)) {
    return { ok: true, handle: opts.existingSeatHandle };
  }
  const resolved = resolveSeatHandle(
    { role: c.role, worktreePath: c.worktreePath },
    opts,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      reason: `orca-adapter: ${callerLabel} -- ${resolved.reason}`,
      seatHandleReason: resolved.seatHandleReason,
    };
  }
  return { ok: true, handle: resolved.handle };
}

// task-create만(§4-2 검증된 argv 재사용). runtimeTaskId까지 확보 못하면 그
// 사유를 그대로 반환한다. HYK-170 사이클2: 좌석 handle 해석보다 먼저
// 실행한다 -- task-create가 실패하는 시나리오에서 불필요한 terminal-list
// 조회를 하지 않기 위함(순서 자체가 계약은 아니다, 부작용 최소화일 뿐).
function createTask(c, opts) {
  const specResult = buildSpec(c.taskId);
  if (!specResult.ok) {
    return {
      ok: false,
      reason: `orca-adapter: ${REASON.TASK_CREATE_FAILED} -- ${specResult.reason}`,
    };
  }
  const created = guardedExec(
    buildTaskCreateCommand(specResult.spec),
    opts.execFn,
    REASON.TASK_CREATE_FAILED,
  );
  if (!created.ok) return created;
  const runtimeTaskId = parseRuntimeTaskId(created.response);
  if (!runtimeTaskId) {
    return {
      ok: false,
      reason: `orca-adapter: ${REASON.TASK_CREATE_FAILED} -- response.result.task.id missing/empty`,
    };
  }
  return { ok: true, runtimeTaskId };
}

// ---- D14 (pm-2 §QC, 소비 후 unlock/재사용): 소비 영수증 결속 판정 ----
// 영수증 자체의 저장/발급은 이 어댑터 책임이 아니다(그건 ORCH의 소비
// 워크플로 몫) -- 여기서는 "주어진 영수증이 기대값과 정확히 결속되는가"만
// 순수 판정한다(orca 호출 0).
export const CONSUME_REASON = Object.freeze({
  HANDSHAKE_BAD: "CONSUME_HANDSHAKE_BAD",
  NO_RECEIPT: "CONSUME_NO_RECEIPT",
  RECEIPT_MISMATCH: "CONSUME_RECEIPT_MISMATCH",
});

// expect = {harnessTaskId, role, worktreePath} -- runtimeTaskId is never part
// of "expect" (there is nothing to compare it against ahead of time; it's
// the receipt's own identity, and D14-B separately confirms it equals the
// stale error's extracted id before ever calling this).
function receiptMatches(receipt, expect) {
  const e = isPlainObject(expect) ? expect : {};
  return (
    isPlainObject(receipt) &&
    isNonEmptyString(receipt.runtimeTaskId) &&
    receipt.harnessTaskId === e.harnessTaskId &&
    receipt.role === e.role &&
    canonicalizeForComparison(receipt.worktreePath ?? "") ===
      canonicalizeForComparison(e.worktreePath ?? "")
  );
}

// D14-A: 정본 handshake가 ok고 소비 영수증이 exact 결속될 때만 completed
// 전이를 허용한다. handshake pending/bad·영수증 부재·불일치는 전부 거부
// (error regex 단독 완료 금지 -- 이 함수는 regex를 아예 보지 않는다).
export function judgeCompletionTransition({ handshake, receipt, expect } = {}) {
  if (!isPlainObject(handshake) || handshake.ok !== true) {
    return { ok: false, reason: CONSUME_REASON.HANDSHAKE_BAD };
  }
  if (!isPlainObject(receipt)) {
    return { ok: false, reason: CONSUME_REASON.NO_RECEIPT };
  }
  if (!receiptMatches(receipt, expect)) {
    return { ok: false, reason: CONSUME_REASON.RECEIPT_MISMATCH };
  }
  return { ok: true };
}

// D14-A 실행: 판정 통과 시에만 task-update completed 1회. 판정 실패는
// orca 호출 0(fail-closed).
export function completeConsumedTask(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const judged = judgeCompletionTransition(c);
  if (!judged.ok) return judged;
  if (typeof opts.execFn !== "function") {
    return {
      ok: false,
      reason: "orca-adapter: completeConsumedTask -- opts.execFn is required",
    };
  }
  return guardedExec(
    buildTaskUpdateCompletedCommand(c.receipt.runtimeTaskId),
    opts.execFn,
    "CONSUME_TASK_UPDATE_FAILED",
  );
}

// D14-B: stale "already has an active dispatch" 오류에서 runtime task id를
// 뽑아, 그 id + role/worktree/harnessTaskId가 소비 영수증과 exact 결속될
// 때만 복구를 허용한다(오류 regex 매치만으로 완료 처리 금지 -- id가 안
// 뽑히거나 영수증과 하나라도 다르면 그대로 거부, 진행 중 task를 안 죽인다).
const STALE_DISPATCH_RE = /already has an active dispatch.*for task (task_\w+)/;
export function extractStaleDispatchTaskId(errorMessage) {
  if (!isNonEmptyString(errorMessage)) return null;
  const m = errorMessage.match(STALE_DISPATCH_RE);
  return m ? m[1] : null;
}
export function resolveStaleDispatchRecovery({
  errorMessage,
  receipt,
  expect,
} = {}) {
  const staleId = extractStaleDispatchTaskId(errorMessage);
  if (!staleId) {
    return { ok: false, reason: CONSUME_REASON.NO_RECEIPT };
  }
  if (!isPlainObject(receipt) || receipt.runtimeTaskId !== staleId) {
    return { ok: false, reason: CONSUME_REASON.RECEIPT_MISMATCH };
  }
  if (!receiptMatches(receipt, expect)) {
    return { ok: false, reason: CONSUME_REASON.RECEIPT_MISMATCH };
  }
  return { ok: true, staleId };
}

// D14-C: 정상 소비 cleanup(위 completeConsumedTask)과 최종 worktree
// teardown(worktree rm/terminal close, teardownSeat)은 분리된 함수다 --
// completeConsumedTask는 task-update 호출 하나뿐이라 worktree rm·terminal
// close를 절대 만들지 않는다(코드 경로 자체에 그 호출이 없다).

// ---- HYK-171 사이클4b-2b-4 §1-A: raw dispatch 응답 보존 + 기록 seam ----
//
// 4b-2b-3까지는 `if (first.ok) return { ok: true, runtimeTaskId };` /
// `if (!retried.ok) return retried; return { ok: true, runtimeTaskId };`가
// 첫 성공·재시도 성공 raw 응답을 둘 다 버렸다(ORCH-소비결론.md §1-2 실코드
// 대조). 이번 사이클은 그 응답을 버리지 않고 기대 runtime task와 결속해
// opts.recordDispatchReceipt(주입형 기록 seam)로 넘긴다.
//
// ⚠️ 배달 성공은 기록 성공에 종속되지 않는다(PM M12) -- dispatch는 이미
// 일어난 side effect이므로, 기록 호출이 없거나 throw하거나 ok:false를
// 반환해도 이 함수의 반환값(ok:true)은 바뀌지 않는다. 기록 결과는
// `recordResult` 필드로만 진단용 첨부된다. 반대로 dispatch 자체가
// 실패하는 두 경로(first 실패 + stale 복구 미해당/재시도 실패)에서는
// recordDispatchReceipt가 아예 호출되지 않는다 -- 대장은 불변이다.
function buildDispatchReceiptContext(rawResponse, phase, c, runtimeTaskId) {
  return {
    rawResponse,
    phase, // "first" | "stale-retry"
    expect: {
      harnessTaskId: isNonEmptyString(c.taskId) ? c.taskId : null,
      runtimeTaskId,
      role: c.role ?? null,
      worktreePath: c.worktreePath ?? null,
    },
  };
}

function safeRecordDispatchReceipt(opts, receiptCtx) {
  if (typeof opts.recordDispatchReceipt !== "function") return null;
  try {
    return opts.recordDispatchReceipt(receiptCtx);
  } catch (err) {
    return {
      ok: false,
      reason: `orca-adapter: recordDispatchReceipt threw (${errText(err)})`,
    };
  }
}

// dispatch(+ --inject 유무)를 실행하고, stale 실패면 D14-B 판정을 거쳐
// completed 보정 + 재시도 최대 1회. 판정 실패/재시도 실패는 원래(또는
// 재시도) 실패를 그대로 반환한다(자동 완화 금지).
function dispatchWithStaleRecovery(
  buildFn,
  runtimeTaskId,
  seatHandle,
  opts,
  c,
) {
  const first = guardedExec(
    buildFn(runtimeTaskId, seatHandle),
    opts.execFn,
    REASON.DISPATCH_FAILED,
  );
  if (first.ok) {
    const recordResult = safeRecordDispatchReceipt(
      opts,
      buildDispatchReceiptContext(first.response, "first", c, runtimeTaskId),
    );
    return {
      ok: true,
      runtimeTaskId,
      recordResult,
      // HYK-212-postcheck-1: injected(자기신고)를 여기서 한 번만 뽑아
      // 배달 포트(deliverToClaudeSeat)에 실어 보낸다 -- 재구현 금지,
      // normalizeDispatchRawUnion 재사용(§2-A2). dispatch-show 형태에는
      // 이 필드가 없으므로(§2-A2 주석) shape가 다르면 null로 정직하게
      // 남는다.
      injected: normalizeDispatchRawUnion(first.response).injected,
    };
  }

  const recovery = resolveStaleDispatchRecovery({
    errorMessage: first.reason,
    receipt: opts.consumedReceipt,
    expect: {
      harnessTaskId: c.taskId,
      role: c.role,
      worktreePath: c.worktreePath,
    },
  });
  if (!recovery.ok) return first;

  const completed = guardedExec(
    buildTaskUpdateCompletedCommand(recovery.staleId),
    opts.execFn,
    REASON.DISPATCH_FAILED,
  );
  if (!completed.ok) return first;

  const retried = guardedExec(
    buildFn(runtimeTaskId, seatHandle),
    opts.execFn,
    REASON.DISPATCH_FAILED,
  );
  if (!retried.ok) return retried;

  const recordResult = safeRecordDispatchReceipt(
    opts,
    buildDispatchReceiptContext(
      retried.response,
      "stale-retry",
      c,
      runtimeTaskId,
    ),
  );
  return {
    ok: true,
    runtimeTaskId,
    recordResult,
    injected: normalizeDispatchRawUnion(retried.response).injected,
  };
}

function dispatchToSeat(runtimeTaskId, seatHandle, opts, c) {
  return dispatchWithStaleRecovery(
    buildDispatchCommand,
    runtimeTaskId,
    seatHandle,
    opts,
    c ?? {},
  );
}

// D11 (codex REVIEW 프로필): --inject 없이 배정 기록만 만든다.
function dispatchToSeatNoInject(runtimeTaskId, seatHandle, opts, c) {
  return dispatchWithStaleRecovery(
    buildDispatchCommandNoInject,
    runtimeTaskId,
    seatHandle,
    opts,
    c ?? {},
  );
}

// HYK-169-coder-3 (review-1 반려 결함 수리, 계승): confirmPastedFn이 주입된
// 경우 그 **반환값을 판정에 쓴다** -- 호출만 하고 결과를 버리지 않는다.
// `true`(엄격 동일 비교, truthy 비 boolean 오반환 방지)만 확인으로 인정한다.
// 훅이 throw해도 미확인으로 처리(제출 없이 안전하게 실패).
function confirmPasteViaInjectedHook(fn) {
  try {
    return fn() === true;
  } catch {
    return false;
  }
}

// HYK-170 사이클2 ②-b coder-1 (D11-B, pm-2 §QA 폐기 사유): 이전
// confirmPasteViaTerminalShow/confirmPaste/submitWithRetry(마커 **또는**
// generic busy를 같은 성공으로 보고, Enter를 최대 1회 자동 재시도)는
// codex REVIEW 배달의 "제출 전 staging 확인"에는 부적합하다는 게 pm-2
// 판정이었다 -- generic busy 단독은 새 텍스트가 실제로 얹혔다는 증거가
// 아니라 이전 세션/이전 작업의 잔여일 수 있다(헛통과 경로). 그 확인
// 의미와 자동 재시도(at-most-once 위반)를 폐기하고, 아래
// confirmCodexStagingViaTerminalShow(marker만 인정)+deliverToCodexSeat
// (text/Enter 각 최대 1회, 실패 시 즉시 DELIVERY_UNJUDGABLE)로 대체한다.
// confirmPasteViaInjectedHook(테스트·특수 상황용 override 훅)만 계승한다.

// HYK-274-stale-screen-1 (coder-task.md §4, 완료 조건 2 -- 화면 단독 판정
// 제거): confirmCodexStagingViaTerminalShow는 `preview`(화면 스냅샷) 문자열
// 하나에만 기대 왔다 -- coder.md 실측(§관측 지연): 화면은 무한정 낡을 수
// 있다(76초+ 미반영 관측). 그래서 이 함수는 **screen 판정을 지우지 않고**
// (완료 조건 2 요구: 단독 의존 제거이지 화면 제거가 아니다) 화면 밖 축을
// 하나 더 얹는다 -- textSendResponse(§포트2 배달에서 기동문을 보낼 때 이미
// 받은 `terminal send --json`의 raw 응답, `result.send.{accepted,
// bytesWritten}`, orca 실측 확인)가 "이번 send 호출 자체가 온전히
// 받아들여졌는가"를 화면과 무관한 채널(IPC 응답, 화면 렌더 경로를 타지
// 않는다)로 증명한다. ⛔이 축은 마커 확인을 «대신»하지 않는다(AND) --
// bytesWritten이 맞아도 preview에 마커가 없으면 여전히 미확인이다. 이유:
// bytesWritten 일치는 "이번 호출이 pty에 그 바이트 수를 썼다"만 증명하고
// "그 내용이 codex TUI 편집 버퍼에 실제로 올라갔다"는 증명하지 않는다
// (예: TUI가 그 사이 화면을 지웠을 수 있다) -- 그래서 여전히 마커도
// 요구한다. 오탐 방향(§6 "새는 게 낫다"와 반대): 여기서는 **놓치는 쪽**이
// 안전하다(D11-B at-most-once Enter 원칙 -- 잘못 제출하면 되돌릴 수
// 없다), 그래서 AND로만 조인한다(OR 금지).
// HYK-274-stale-screen-3 (검토 1R 반려 P1 수리): 이전 판은 `result.send`
// 구조 자체가 없으면 `null`(=신호 없음)을 돌려주고 confirmCodexStaging이
// 그걸 "화면 판정 존중"으로 접었다 -- **fail-open**이었다. `orca`는 하루
// 1회 업데이트되므로 응답 shape가 바뀌는 순간(그 필드가 사라지는 순간)
// 이 수리가 막으려던 "화면 단독 경로"가 조용히 재개된다(검토자 지적,
// coder-task.md §1 그대로). ⇒ **부재도 이제 미확인(fail-closed)이다** --
// "신호가 없으니 통과"가 아니라 "신호가 없으니 거부"로 뒤집는다.
// ★사유 코드를 가른다(검토자 요구) -- "바이트가 안 맞았다"(BYTE_MISMATCH,
// send는 왔는데 내용이 어긋남 -- 통상적 실패)와 "그 필드 자체가 없다"
// (FIELD_ABSENT, orca 응답 shape가 바뀌었다는 신호일 수 있음 -- 운영상
// 훨씬 급한 사건)는 다른 사건이다. 로그·사유 문면에서 사람이 이 둘을
// 구별하지 못하면 "shape가 바뀌었다"는 신호가 "그냥 이번 건 실패"에
// 묻혀 진단이 죽는다.
const OFF_SCREEN_SEND_VERDICT = Object.freeze({
  MATCH: "MATCH",
  BYTE_MISMATCH: "BYTE_MISMATCH",
  NOT_ACCEPTED: "NOT_ACCEPTED",
  FIELD_ABSENT: "FIELD_ABSENT",
});
function classifyOffScreenSend(sendResponse, expectedText) {
  const send =
    isPlainObject(sendResponse) && isPlainObject(sendResponse.result)
      ? sendResponse.result.send
      : null;
  if (!isPlainObject(send)) return OFF_SCREEN_SEND_VERDICT.FIELD_ABSENT;
  if (send.accepted !== true) return OFF_SCREEN_SEND_VERDICT.NOT_ACCEPTED;
  if (typeof expectedText !== "string") {
    return OFF_SCREEN_SEND_VERDICT.BYTE_MISMATCH;
  }
  return send.bytesWritten === Buffer.byteLength(expectedText, "utf8")
    ? OFF_SCREEN_SEND_VERDICT.MATCH
    : OFF_SCREEN_SEND_VERDICT.BYTE_MISMATCH;
}

// D11-B: codex 제출 전 staging 확인은 runtime+harness task에 결속된 exact
// marker(하네스 task_id)만 인정한다 -- previewShowsBusySignal(generic busy)
// 은 여기서 절대 확인 조건으로 쓰지 않는다.
function confirmCodexStagingViaTerminalShow(seatHandle, marker, opts) {
  if (typeof opts.execFn !== "function") return false;
  const maxAttempts = Number.isSafeInteger(opts.confirmMaxAttempts)
    ? opts.confirmMaxAttempts
    : 1;
  const waitFn =
    typeof opts.confirmWaitFn === "function" ? opts.confirmWaitFn : () => {};
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) waitFn(attempt);
    let response;
    try {
      response = opts.execFn(buildSeatShowCommand(seatHandle));
    } catch {
      continue;
    }
    const preview = parseSeatPreview(response);
    if (preview === null) continue;
    if (previewContainsMarker(preview, marker)) return true;
  }
  return false;
}

// HYK-274-stale-screen-3: confirmCodexStaging은 이제 boolean이 아니라
// {ok, reasonCode}를 돌려준다 -- 호출부가 "왜" 미확인인지(화면 마커
// 부재 vs 화면 밖 축의 바이트 불일치 vs 화면 밖 축 자체가 사라짐)를
// 사람이 읽는 사유 문면에 그대로 옮길 수 있어야 하기 때문이다(검토
// 반려 요구: "사람이 그 둘을 못 가르면 진단이 죽는다").
const CONFIRM_CODEX_STAGING_REASON = Object.freeze({
  CONFIRMED: "CONFIRMED",
  SCREEN_MARKER_ABSENT: "SCREEN_MARKER_ABSENT",
  INJECTED_HOOK_REJECTED: "INJECTED_HOOK_REJECTED",
  OFF_SCREEN_BYTE_MISMATCH: "OFF_SCREEN_BYTE_MISMATCH",
  OFF_SCREEN_NOT_ACCEPTED: "OFF_SCREEN_NOT_ACCEPTED",
  // ★가장 급한 사유: `result.send`에 그 필드 자체가 없다 -- orca 응답
  // shape가 바뀌었을 수 있다는 신호(coder-task.md §1 그대로).
  OFF_SCREEN_FIELD_ABSENT: "OFF_SCREEN_FIELD_ABSENT",
});

// opts.offScreenSend: {response, expectedText} -- deliverToCodexSeat이 이미
// 받아 둔 textSent.response(§포트2, 새 orca 호출 0)와 그때 보낸 bootstrapText
// 를 그대로 넘긴다.
// ★HYK-274-stale-screen-4 (게이트 2 · 불변식화): ⛔이 축에는 "opt-out"이
// 없다 -- 3R까지는 `opts.offScreenSend`가 plain object가 아니면(생략·
// `undefined`·`null`·비객체 전부 포함) "이 축을 안 쓴다"로 접어 화면
// 마커 단독으로 통과시켰다. 검토자가 그 자리를 옆문으로 실증했다(가짜
// 실행기: 마커+`offScreenSend: undefined` -> ok:true). 이제 이 함수는
// **호출자가 무엇을 넘기든 결과로 판정한다** -- "넘긴 값의 모양"으로
// 분기하지 않는다: `offScreenSend`가 plain object가 아니면 그냥 빈
// 객체로 접어(`{}`) `classifyOffScreenSend`에 그대로 흘려보낸다. 그러면
// `response`/`expectedText`가 둘 다 `undefined`인 채로 들어가고,
// `classifyOffScreenSend`는 그 입력을 (생략과 완전히 동일하게)
// `FIELD_ABSENT`로 분류해 **fail-closed**로 떨어진다 -- "생략"과
// "undefined"를 다르게 취급하는 코드 경로 자체가 이제 존재하지 않는다.
function confirmCodexStaging(seatHandle, marker, opts) {
  if (typeof opts.confirmPastedFn === "function") {
    const hookOk = confirmPasteViaInjectedHook(opts.confirmPastedFn);
    return {
      ok: hookOk,
      reasonCode: hookOk
        ? CONFIRM_CODEX_STAGING_REASON.CONFIRMED
        : CONFIRM_CODEX_STAGING_REASON.INJECTED_HOOK_REJECTED,
    };
  }
  const screenConfirmed = confirmCodexStagingViaTerminalShow(
    seatHandle,
    marker,
    opts,
  );
  if (!screenConfirmed) {
    return {
      ok: false,
      reasonCode: CONFIRM_CODEX_STAGING_REASON.SCREEN_MARKER_ABSENT,
    };
  }
  const offScreen = isPlainObject(opts.offScreenSend) ? opts.offScreenSend : {};
  const verdict = classifyOffScreenSend(
    offScreen.response,
    offScreen.expectedText,
  );
  if (verdict === OFF_SCREEN_SEND_VERDICT.MATCH) {
    return { ok: true, reasonCode: CONFIRM_CODEX_STAGING_REASON.CONFIRMED };
  }
  const reasonCode =
    verdict === OFF_SCREEN_SEND_VERDICT.FIELD_ABSENT
      ? CONFIRM_CODEX_STAGING_REASON.OFF_SCREEN_FIELD_ABSENT
      : verdict === OFF_SCREEN_SEND_VERDICT.NOT_ACCEPTED
        ? CONFIRM_CODEX_STAGING_REASON.OFF_SCREEN_NOT_ACCEPTED
        : CONFIRM_CODEX_STAGING_REASON.OFF_SCREEN_BYTE_MISMATCH;
  return { ok: false, reasonCode };
}

// 사람이 읽는 사유 문면 -- reasonCode별로 구별되게 쓴다(검토 반려 요구:
// "사람이 그 둘을 못 가르면 진단이 죽는다"). FIELD_ABSENT는 다른 사유와
// 문면이 확실히 갈리게(orca 응답 shape 변경 가능성을 명시) 적는다.
function describeConfirmCodexStagingFailure(reasonCode) {
  switch (reasonCode) {
    case CONFIRM_CODEX_STAGING_REASON.SCREEN_MARKER_ABSENT:
      return "screen preview did not contain the task-specific marker";
    case CONFIRM_CODEX_STAGING_REASON.INJECTED_HOOK_REJECTED:
      return "confirmPastedFn override returned other than true";
    case CONFIRM_CODEX_STAGING_REASON.OFF_SCREEN_BYTE_MISMATCH:
      return "off-screen axis: terminal send bytesWritten did not match the bootstrap text length";
    case CONFIRM_CODEX_STAGING_REASON.OFF_SCREEN_NOT_ACCEPTED:
      return "off-screen axis: terminal send response reported accepted !== true";
    case CONFIRM_CODEX_STAGING_REASON.OFF_SCREEN_FIELD_ABSENT:
      return "off-screen axis: terminal send response has no result.send field -- orca response shape may have changed (fail-closed, not screen-only fallback)";
    default:
      return "unconfirmed";
  }
}

// D13 (pm-2 §QE): codex 최소 기동문 -- runtime task id + 역할별 local task
// 파일 포인터 + "dispatch/pane 대조 후 진행" 요구 + 정확한 `go <harness
// task id>`(tail marker, D11-B 결속 확인 대상)만 담는다. task 본문·추가
// 권한·"기록 없어도 신뢰" 예외는 절대 담지 않는다(고정 템플릿 -- 관제실
// 스톱갭 `dispatch-worker.ps1`의 $goText와 동형, 동적 조합 최소화).
export function buildCodexBootstrapText({
  role,
  runtimeTaskId,
  harnessTaskId,
} = {}) {
  const lower = isNonEmptyString(role) ? role.toLowerCase() : role;
  // 한 개의 템플릿 리터럴로만 조립한다(따옴표 문자열 두 개를 `+`로 잇지
  // 않는다) -- env-ingress-scan.mjs의 COMPUTED_KEY_CONCAT 휴리스틱은 문맥
  // 없이 "따옴표 리터럴 + 따옴표 리터럴"을 전부 계산 키 조합으로 잡는다
  // (A-3 KNOWN_LIMITATIONS급 오탐 -- 이 문자열은 env 계산 키가 아니라
  // 사람이 읽는 기동 지시문일 뿐이다). 스캐너를 완화하는 대신 이 함수의
  // 조립 방식을 스캐너와 충돌하지 않게 고치는 쪽을 택한다(G8: 스캐너
  // 자체는 약화하지 않는다).
  return `너는 하네스 릴레이 [${role}] 워커다. D:\\문서관리\\하네스-관제실\\worker-dispatch-rule.md를 읽고 1절대로 위조확인하라: orca orchestration dispatch-show --task ${runtimeTaskId} --json 실행해 result.dispatch.assignee_pane_key가 이 좌석 환경변수 ORCA_PANE_KEY와 일치하는지 대조하고 결과 파일 맨 위에 3줄(dispatch_verified/task_id_from_dispatch/pane_match) 기록. 그다음 .harness/${lower}-task.md 지침대로 수행(코드 수정은 그 지침 범위 내). 결과는 .harness/${lower}.md에 task_id 에코 + 마지막 줄 '>>> DONE: ${role} @ 실제시각KST' 로 쓰고, STATUS.md 1절 ${role} 행만 갱신. go ${harnessTaskId}`;
}

// ---- 포트 2: 배달(deliver) ----
// ctx: { taskId, role, worktreePath, coordinatorHandle }
// opts: { execFn, existingSeatHandle?(테스트 전용 override), confirmPastedFn?,
//         confirmMaxAttempts?, confirmWaitFn?, consumedReceipt?(D14-B) }
// A-2: seatHandle을 입력으로 받지 않는다 -- {role, worktreePath}로부터
// resolveSeatHandle(A-1)이 그 자리에서 해석한다.
// D11 (pm-2 §QA): 프로필별로 완전히 다른 경로를 탄다 -- claude=dispatch
// --inject 1회(제출 Enter 0회), codex=무-inject dispatch 1회 -> 최소
// 기동문 text 1회 -> exact marker 확인 -> Enter 1회(재시도 0, at-most-once).
// 미지원/불명 엔진은 어느 경로도 추정하지 않고 side effect 0으로 거부한다
// (task-create/handle 해석보다도 먼저 -- 아래 참조).
function deliverTaskInternal(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const invalid = validateDeliverInput(c, opts);
  if (invalid) return { ok: false, reason: invalid };

  const engine = ENGINE_BY_ROLE[c.role];
  if (!isNonEmptyString(engine)) {
    return {
      ok: false,
      reason: `orca-adapter: ${REASON.UNSUPPORTED_PROFILE} -- unknown/unsupported delivery profile for role ${JSON.stringify(c.role)} (D11: no side effects for unknown profiles)`,
    };
  }

  const taskResult = createTask(c, opts);
  if (!taskResult.ok) return taskResult;

  const handleResult = resolveHandleForPort(c, opts, REASON.DISPATCH_FAILED);
  if (!handleResult.ok) return handleResult;
  const seatHandle = handleResult.handle;

  if (engine === "codex") {
    return deliverToCodexSeat(c, seatHandle, taskResult.runtimeTaskId, opts);
  }
  return deliverToClaudeSeat(c, seatHandle, taskResult.runtimeTaskId, opts);
}

// HYK-376-paste-hook-seam-1 (불변식화): `confirmPastedFn`은
// confirmCodexStaging의 화면+화면 밖 두 확인 축을 통째로 건너뛰게 하는
// 시험 전용 훅이다(§HYK-169-coder-3 주석). 이전에는 이 export가 그 opts
// 키를 그대로 deliverToCodexSeat까지 흘려보냈다 -- 즉 "지금은 아무도 안
// 넘긴다"만 사실이었지 "넘길 수 없다"는 아니었다(이슈 지적 그대로).
// ⛔이제 이 export는 **호출자가 무엇을 넘기든** confirmPastedFn을 opts에서
// 물리적으로 제거한 뒤에만 deliverTaskInternal에 넘긴다 -- "넘긴 값을
// 무시한다"가 아니라 "그 키 자체가 이 지점을 넘어 존재하지 않는다"이다.
// createRealLaunchSink/relayStep(runDeliverStage)/runStepCli/run-step.mjs
// CLI는 전부 이 export만 import한다(아래 각 지점 주석 참조) -- 그래서
// 이 한 곳의 제거가 네 프로덕션 진입점 전부에 구조적으로 적용된다.
//
// HYK-376-paste-hook-seam-2 (P1 반려 수리 -- 검토자 실측: 위 1R 판이 먼저
// `"confirmPastedFn" in opts`로 **호출자에게 물어본 뒤**, 그 대답이
// 거짓이면 원본 객체를 그대로 통과시켰다. 호출자를 own `confirmPastedFn`
// 을 가진 객체를 감싼 `Proxy`로 만들고 `has` 트랩만 `false`를 답하게
// 하면, `in` 연산자는 그 거짓말을 그대로 믿는다 -- 검토자가 프로덕션
// `deliverTask`와 `relayStep` 양쪽에서 화면 마커/화면 밖 증거 둘 다 없이
// `ok:true`·Enter 1회로 재현했다.
// ★불변식(coder-task.md §2 2R): "호출자가 준 객체를 절대 그대로
// 흘려보내지 않는다" -- 그래서 이제 **묻지 않는다**. 무엇이 오든 조건
// 없이 새 plain object를 만든다(`{...opts}`). 객체 스프레드는 `in`/`has`
// 트랩을 전혀 쓰지 않는다 -- 내부적으로 `[[OwnPropertyKeys]]`(ownKeys
// 트랩 또는 기본 동작)로 얻은 키 중 `[[GetOwnProperty]]`가 enumerable로
// 보고하는 키만 `[[Get]]`으로 값을 읽어 복사한다. 그래서:
//  - `has`가 무엇을 답하든(1R을 뚫은 그 트랩) 복사 자체에는 영향이 없다.
//  - `ownKeys`가 `confirmPastedFn`을 열거 목록에서 숨기면 애초에
//    복사되지 않는다(=생략과 동일한 안전한 결과).
//  - own 속성으로 실제 존재하고 열거되면 복사된 뒤 아래에서 명시적으로
//    지운다 -- "물어보고 지운다"가 아니라 "일단 내 사본을 만들고, 그
//    사본에서 그 키를 삭제한다"이므로 원본이 무엇을 주장하는지는
//    결과에 관여하지 않는다.
// 정직 한계: `getOwnPropertyDescriptor`/`get` 두 트랩이 서로 다른 값을
// 짜맞춰(예: 다른 이름의 own 속성 뒤에서 get이 그 값을 가로채는 형태)
// 스프레드 자체의 의미론을 깨는 극단적 조합까지는 이 함수 하나로
// 증명하지 않는다 -- §3-2가 요구한 모양 6종(일반·상속·getter·비열거·
// Proxy has·Proxy ownKeys 은닉+get 함수반환) 표 구동 시험이 그 경계를
// 실측으로 고정한다(아래 STRIP_CONFIRM_PASTED_FN_PROBE_SHAPES,
// orca-adapter.test.mjs).
function stripConfirmPastedFn(opts) {
  const rest = isPlainObject(opts) ? { ...opts } : {};
  delete rest.confirmPastedFn;
  return rest;
}

export function deliverTask(ctx, opts = {}) {
  return deliverTaskInternal(ctx, stripConfirmPastedFn(opts));
}

// ⛔시험 전용 진입점(coder-task.md §2 방향 ⓐ): confirmCodexStaging의
// confirmPastedFn 오버라이드 경로 자체를 계속 시험하기 위해서만 존재한다.
// 프로덕션 진입점(createRealLaunchSink/runDeliverStage/runStepCli/CLI) 중
// 어느 것도 이 함수를 import하지 않는다 -- import 그래프에 없으므로 어떤
// opts를 넘겨도 프로덕션 배달에는 도달할 방법이 없다.
export function deliverTaskWithConfirmOverrideForTests(ctx, opts = {}) {
  return deliverTaskInternal(ctx, opts);
}

// ---- HYK-212-postcheck-1: 배달 직후 재조회 사후검증(§2 ⓐ) ----
//
// 실사고(coder-task.md §1): dispatch 도구가 injected:true를 자기신고했는데
// 그 직후 dispatch-show를 다시 조회하면 result.dispatch === null(레코드
// 미생성)인 경우가 있었다. ORCH가 사고 당일 손으로 했던 재조회+대조를
// 여기서 기계로 반복한다 -- 이 시점에만 "이 배달에 실제로 쓰인 orca task
// id"(runtimeTaskId)와 "injected:true 자기신고" 둘 다 함께 있다(watch
// 시점 .harness/*-task.md에는 harness 라벨만 있고 orca task id가 없어
// 재구성 불가 -- ⓐ를 고른 이유, coder.md §7 참조).
//
// ★자기신고 한계: "주입이 확인됐다"의 유일한 근거는 배달 도구 자신이
// 돌려준 injected:true뿐이다 -- 이 값이 거짓으로 자기신고돼도 이 함수는
// 검증할 수단이 없다(정직 한계, 재구현·재검증 없음).
//
// buildDispatchShowCommand/normalizeDispatchShow 재사용(재구현 금지,
// orca-cli-boundary.mjs G9: 이 파일 밖에서 orca를 spawn하지 않는다).
function runDispatchPostcheck(runtimeTaskId, opts) {
  let normalized;
  try {
    const response = opts.execFn(buildDispatchShowCommand(runtimeTaskId));
    normalized = normalizeDispatchShow(response);
  } catch {
    // §3-3: 조회 자체의 실패는 "레코드 없음"과 다른 사유로 들어와야
    // 한다 -- judgeDispatchPostcheck가 QUERY_THREW를 QUERY_FAILED로
    // 접지, RECORD_MISSING으로 접지 않는다.
    normalized = { ok: false, reasonCode: "QUERY_THREW" };
  }
  return judgeDispatchPostcheck({ injected: true, normalized });
}

// 감시(orch-stall-detect.mjs)가 orca를 새로 호출하지 않고도 이 판정을
// 읽을 수 있도록 워크트리에 영수증을 남긴다(§2 설계: 탐지는 ⓐ에서,
// 사람 도달은 이미 만들어져 있는 AXES 등록형 reach-notify 파이프라인을
// 재사용한다 -- 그 파이프라인은 watch.log를 거치므로 감시 시점에
// 다시 읽을 수 있는 durable 흔적이 필요하다). 쓰기 실패는 조용히
// 삼킨다 -- 배달 자체(이미 일어난 부작용)를 이 부가 기록의 성패로
// 되돌리지 않는다(createDispatchReceiptRecorder 주석 "배달 성공은 기록
// 성공에 종속되지 않는다"와 동일 원칙).
function writeDispatchPostcheckReceipt(
  { worktreePath, runtimeTaskId, harnessTaskId, postcheck },
  opts,
) {
  const fs = isPlainObject(opts.postcheckFs) ? opts.postcheckFs : {};
  const existsFn = typeof fs.existsFn === "function" ? fs.existsFn : existsSync;
  const mkdirFn = typeof fs.mkdirFn === "function" ? fs.mkdirFn : mkdirSync;
  const writeFn = typeof fs.writeFn === "function" ? fs.writeFn : writeFileSync;
  const nowFn = typeof opts.nowFn === "function" ? opts.nowFn : Date.now;
  try {
    const harnessDir = join(worktreePath, ".harness");
    if (!existsFn(harnessDir)) mkdirFn(harnessDir, { recursive: true });
    const receiptPath = join(harnessDir, "dispatch-postcheck.json");
    const receipt = {
      runtimeTaskId,
      harnessTaskId: isNonEmptyString(harnessTaskId) ? harnessTaskId : null,
      checkedAtMs: nowFn(),
      status: postcheck.status,
      verdict: postcheck.verdict,
      reasonCode: postcheck.reasonCode,
    };
    writeFn(receiptPath, JSON.stringify(receipt, null, 2));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `orca-adapter: writeDispatchPostcheckReceipt threw (${errText(err)})`,
    };
  }
}

// D11-A claude 프로필: dispatch --inject 1회로 배정+붙여넣기+제출이 전부
// 끝난다(제출 Enter 0회).
function deliverToClaudeSeat(c, seatHandle, runtimeTaskId, opts) {
  const dispatchResult = dispatchToSeat(runtimeTaskId, seatHandle, opts, c);
  if (!dispatchResult.ok) return dispatchResult;
  // HYK-212-postcheck-1: claude만(codex는 --inject를 쓰지 않아 injected가
  // 판단 대상이 아니다, dispatch-postcheck-core.mjs NOT_APPLICABLE) --
  // injected:true를 자기신고했을 때만 재조회한다(§3-2 오탐 0: 정상
  // 배달이면 dispatchResult.injected가 true여도 재조회 결과가 CONFIRMED로
  // 나와 경보로 이어지지 않는다).
  let postcheck = null;
  if (dispatchResult.injected === true) {
    postcheck = runDispatchPostcheck(runtimeTaskId, opts);
    writeDispatchPostcheckReceipt(
      {
        worktreePath: c.worktreePath,
        runtimeTaskId,
        harnessTaskId: c.taskId,
        postcheck,
      },
      opts,
    );
  }
  return {
    ok: true,
    runtimeTaskId: dispatchResult.runtimeTaskId,
    submitted: "auto",
    retries: 0,
    recordResult: dispatchResult.recordResult,
    postcheck,
  };
}

// D11-A/B/C codex 프로필: 무-inject dispatch -> 최소 기동문 text -> exact
// marker 확인 -> Enter. text/Enter는 각각 정확히 1회만 시도한다(D11-C
// at-most-once) -- 실패하면 즉시 DELIVERY_UNJUDGABLE로 정지, 같은 부작용을
// 다시 내지 않는다. `--interrupt`는 어디에도 없다(D15).
function deliverToCodexSeat(c, seatHandle, runtimeTaskId, opts) {
  const dispatchResult = dispatchToSeatNoInject(
    runtimeTaskId,
    seatHandle,
    opts,
    c,
  );
  if (!dispatchResult.ok) return dispatchResult;
  const rtId = dispatchResult.runtimeTaskId;

  const bootstrapText = buildCodexBootstrapText({
    role: c.role,
    runtimeTaskId: rtId,
    harnessTaskId: c.taskId,
  });
  const textSent = guardedExec(
    buildSeatLaunchTextCommand(seatHandle, bootstrapText),
    opts.execFn,
    REASON.DELIVERY_UNJUDGABLE,
  );
  if (!textSent.ok) {
    return { ok: false, reason: textSent.reason, runtimeTaskId: rtId };
  }

  // HYK-274-stale-screen-4 (게이트 2 · 검토 3R 반려 P1 수리 -- 불변식화):
  // 3R까지는 "호출자가 opts.offScreenSend를 이미 명시했으면(hasOwnProperty)
  // 그 값을 존중"했다 -- 검토자가 그 자리에서 옆문을 찾았다: 호출자가
  // 선택값을 전개해(`{...base, offScreenSend: maybeUndefined}`) own
  // property로 `undefined`를 만들면 hasOwnProperty는 true이므로 자동
  // 주입이 건너뛰어지고, confirmCodexStaging은 `opts.offScreenSend`가
  // plain object가 아니라는 이유로 이 축 자체를 "안 쓴다"로 접어 화면
  // 마커 단독으로 Enter를 허용했다(검토자 가짜 실행기로 실증: 마커+
  // `offScreenSend: undefined` -> ok:true, Enter 1회).
  // ★불변식: 이 배달 경로(deliverToCodexSeat)는 codex 좌석에 실제로 보낸
  // 이 호출 자신의 textSent.response + bootstrapText로 **항상** 화면 밖
  // 축을 구성한다 -- opts에 무엇이 들어있든(생략·undefined·null·비객체·
  // 빈 객체·심지어 다른 값) 그 값을 절대 신뢰하지 않는다. "이미 명시된
  // 값을 존중한다"는 예외 자체를 없앤다 -- 그 예외가 옆문이었다.
  const confirmOpts = {
    ...opts,
    offScreenSend: { response: textSent.response, expectedText: bootstrapText },
  };
  const confirmation = confirmCodexStaging(seatHandle, c.taskId, confirmOpts);
  if (!confirmation.ok) {
    return {
      ok: false,
      reason: `orca-adapter: ${REASON.PASTE_UNCONFIRMED} (${confirmation.reasonCode}) -- ${describeConfirmCodexStagingFailure(confirmation.reasonCode)}; submit refused (0 terminal send --enter calls)`,
      runtimeTaskId: rtId,
    };
  }

  const submitted = guardedExec(
    buildSeatSubmitCommand(seatHandle),
    opts.execFn,
    REASON.DELIVERY_UNJUDGABLE,
  );
  if (!submitted.ok) {
    return { ok: false, reason: submitted.reason, runtimeTaskId: rtId };
  }

  return {
    ok: true,
    runtimeTaskId: rtId,
    submitted: "explicit",
    retries: 0,
    recordResult: dispatchResult.recordResult,
  };
}

// ---- 포트 3: 감지(detect) -- 비권위 신호만. 완료를 이 값으로 확정하지 않는다
// (정본은 checkRelayHandshake, relay-core.mjs 몫). 조회 자체가 실패해도 이
// 포트는 fatal로 취급하지 않는다(advisory-only 계약).
export function collectCompletionSignals(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  if (typeof opts.execFn !== "function") {
    return {
      ok: true,
      signals: [],
      note: "no execFn injected -- advisory query skipped",
    };
  }
  let response;
  try {
    response = opts.execFn(buildNonBlockingCheckCommand(c.coordinatorHandle));
  } catch (err) {
    return {
      ok: true,
      signals: [],
      note: `advisory query threw (${errText(err)})`,
    };
  }
  if (!isPlainObject(response) || response.ok !== true) {
    return {
      ok: true,
      signals: [],
      note: "advisory query did not return ok:true",
    };
  }
  const messages = Array.isArray(response.result?.messages)
    ? response.result.messages
    : [];
  return { ok: true, signals: messages, note: null };
}

// ---- D13-G1 (pm-2 §QE): 기동문 자격 판정 -- 결정적 seam ----
// 권위 판정의 입력은 dispatch-show 결과 + 현재 pane key뿐이다. **이 함수는
// 기동문 텍스트 자체를 인자로 받지 않는다** -- 텍스트가 판정값에 영향을
// 줄 수 없음을 시그니처 자체로 증명한다(위조 문구가 같은 dispatch/pane
// 입력에서 자격 결과를 못 바꾼다는 것을 "그 값이 아예 함수에 없다"로
// 구조적으로 보장). goLabel/localTaskId는 자격이 아니라 라벨 결속만
// 본다(자격 통과 후에만 확인 -- 위조 문구라도 dispatch/pane이 자기 것이면
// 다음 단계까지는 가되, local task_id 불일치면 그 자리에서 거부).
export const BOOTSTRAP_AUTH_REASON = Object.freeze({
  NO_DISPATCH_RECORD: "BOOTSTRAP_AUTH_NO_DISPATCH_RECORD",
  PANE_MISMATCH: "BOOTSTRAP_AUTH_PANE_MISMATCH",
  LABEL_MISMATCH: "BOOTSTRAP_AUTH_LABEL_MISMATCH",
});

// ctx: { dispatchShowResponse, currentPaneKey, goLabel?, localTaskId? }
export function judgeBootstrapAuthorization(ctx = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const dispatch =
    isPlainObject(c.dispatchShowResponse) && c.dispatchShowResponse.ok === true
      ? c.dispatchShowResponse.result?.dispatch
      : null;
  if (
    !isPlainObject(dispatch) ||
    !isNonEmptyString(dispatch.assignee_pane_key)
  ) {
    return { ok: false, reason: BOOTSTRAP_AUTH_REASON.NO_DISPATCH_RECORD };
  }
  if (dispatch.assignee_pane_key !== c.currentPaneKey) {
    return { ok: false, reason: BOOTSTRAP_AUTH_REASON.PANE_MISMATCH };
  }
  if (
    isNonEmptyString(c.goLabel) &&
    isNonEmptyString(c.localTaskId) &&
    c.goLabel !== c.localTaskId
  ) {
    return { ok: false, reason: BOOTSTRAP_AUTH_REASON.LABEL_MISMATCH };
  }
  return { ok: true };
}

// 기동문 **끝**의 `go <label>` tail marker만 뽑는다. go-task-id-gate.mjs의
// extractPromptTaskId는 독립 prompt 시작(^)에 anchor된 별개 계약이라(그
// 파일은 "go"로 시작하는 짧은 prompt 전용) 이 어댑터가 만드는 긴 기동문의
// 끝 tail에는 맞지 않는다 -- 같은 걸 재구현하는 게 아니라 다른 위치
// 계약이라 별도 최소 정규식을 둔다. 이 추출값을 judgeBootstrapAuthorization
// 의 goLabel로 넘기는 것은 호출자 몫이다(자격 판정 자체와는 분리).
const BOOTSTRAP_GO_TAIL_RE = /\bgo\s+(\S+)\s*$/i;
export function extractBootstrapGoLabel(text) {
  if (typeof text !== "string") return null;
  const m = text.match(BOOTSTRAP_GO_TAIL_RE);
  return m ? m[1] : null;
}

// ---- D9 (pm-2 §QD): 실행권한 3상태 경계 ----
// CODE_READY(fake fixture PASS)/RUN_READY(사람 권한 로드 세션)/LIVE_PROVEN
// (실제 1회 result+handshake까지 완주)을 합치지 않는다. 부분 권한으로
// LIVE_PROVEN을 자칭할 수 없도록 필요 권한 전부가 갖춰져야만 runReady다.
export const RUN_STATE = Object.freeze({
  CODE_READY: "CODE_READY",
  RUN_READY: "RUN_READY",
  LIVE_PROVEN: "LIVE_PROVEN",
});
const REQUIRED_RUN_PERMISSIONS = Object.freeze(["dispatch", "terminal"]);

// ctx: { runPermissions?: {dispatch?, terminal?}, liveProofReceipt? }
export function classifyRunReadiness(ctx = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const perms = isPlainObject(c.runPermissions) ? c.runPermissions : {};
  const codeReady = true; // 이 함수까지 실행됐다는 것 자체가 fake fixture PASS의 증거
  const runReady = REQUIRED_RUN_PERMISSIONS.every((p) => perms[p] === true);
  const liveProven = runReady && c.liveProofReceipt === true;
  return {
    codeReady,
    runReady,
    liveProven,
    state: liveProven
      ? RUN_STATE.LIVE_PROVEN
      : runReady
        ? RUN_STATE.RUN_READY
        : RUN_STATE.CODE_READY,
  };
}

// ---- 포트 4: 생애주기(lifecycle) ----
// HYK-171 사이클4b-1 (coder-task.md §2-C) -- 기존 동작 변경: teardownSeat은
// 더 이상 무조건 close -> rm -> task-update로 진행하지 않는다. 순서 =
// 관측(before) -> judgeTeardown 판정 -> (armed && allowSink)일 때만
// close -> rm -> 사후 재관측 -> judgePostConditions -> SUCCEEDED일 때만
// task-update. 이 사이클은 armed=true 승격 경로를 만들지 않는다(호출자가
// ctx.armed를 명시 true로 넘겨도 production 결선 어디에도 그런 호출자가
// 없다 -- createRealLaunchSink는 armed를 전혀 취급하지 않고, launch-seam.mjs
// 는 armed=true 강제 하에서도 이 sink 자체를 절대 호출하지 않는다).
export const TEARDOWN_PHASE = Object.freeze({
  GATE: "GATE",
  RESOLVE: "RESOLVE",
  CLOSE: "CLOSE",
  REMOVE: "REMOVE",
  DONE: "DONE",
});

export const TEARDOWN_GATE_REASON = Object.freeze({
  NOT_ARMED: "TEARDOWN_NOT_ARMED",
});

// HYK-171 사이클4b-2a §2-A: close 실패의 두 reason code. 어느 쪽이든
// "원인 미확정 실패"로 정지한다 -- tab_not_found는 "PTY 고아 확정"이
// 아니다(그 관측은 --tab 경로 한정이고 프로덕션 builder는 --tab을 쓰지
// 않는다, PM 오류 적발 3). 구별은 오직 진단 가능성(reason code)을 위한
// 것이고, tab_not_found 쪽을 성공으로 흡수하는 근거가 아니다.
export const TEARDOWN_CLOSE_REASON = Object.freeze({
  TAB_NOT_FOUND: "TEARDOWN_CLOSE_TAB_NOT_FOUND",
  CLOSE_FAILED: "TEARDOWN_CLOSE_FAILED",
});

// tab_not_found(실측 2단 §4 오류 shape: {ok:false, error:{code:"runtime_error",
// message:"tab_not_found"}})는 분류 전용이다. HYK-171 사이클4b-2a: 이
// 함수의 반환값을 "성공"으로 흡수하지 않는다 -- close가 ok:true가 아니면
// 원인이 무엇이든 원인 미확정 실패로 즉시 정지한다(rm·task-update argv 0).
// 이 함수는 오직 reason code를 TAB_NOT_FOUND vs CLOSE_FAILED로 구별하는
// 데만 쓰인다(진단 가능성 -- PM mutation #1 요구).
function isTabNotFoundFailure(guardedResult) {
  return (
    !guardedResult.ok &&
    isNonEmptyString(guardedResult.reason) &&
    guardedResult.reason.includes("tab_not_found")
  );
}

// close 실패를 원인 미확정 실패로 분류만 한다(성공 흡수 금지). raw로
// 정규화된 에러 코드(response.error.code/message)를 결과에 보존해
// 진단 가능성을 유지한다.
function classifyCloseFailure(guardedResult) {
  const rawError =
    isPlainObject(guardedResult.response) &&
    isPlainObject(guardedResult.response.error)
      ? guardedResult.response.error
      : null;
  return {
    reason: isTabNotFoundFailure(guardedResult)
      ? TEARDOWN_CLOSE_REASON.TAB_NOT_FOUND
      : TEARDOWN_CLOSE_REASON.CLOSE_FAILED,
    rawErrorCode:
      rawError && isNonEmptyString(rawError.code) ? rawError.code : null,
    rawErrorMessage:
      rawError && isNonEmptyString(rawError.message)
        ? rawError.message
        : isNonEmptyString(guardedResult.reason)
          ? guardedResult.reason
          : null,
  };
}

// worktreePath는 이제 언제나 필수다(§2-C 재설계: 모든 파괴 판정이 3층
// 증거 관측에 결속되므로, 관측 대상 경로가 없는 teardown 요청은 애초에
// 판정 불능이다 -- 이전(A-2)엔 existingSeatHandle만으로 close-only 경로를
// 허용했지만, 그 경로는 이 사이클의 증거-게이트 모델과 양립하지 않는다).
function validateTeardownInput(c, opts) {
  if (typeof opts.execFn !== "function") {
    return "orca-adapter: teardownSeat -- opts.execFn is required";
  }
  if (!isNonEmptyString(c.worktreePath)) {
    return "orca-adapter: teardownSeat -- worktreePath is required (HYK-171 4b-1: teardown eligibility is always evidence-gated by worktree inventory)";
  }
  return null;
}

// §2-A: 읽기 전용 관측(파괴 argv 0). opts.gitFn/opts.existsFn이 없으면
// 해당 소스는 관측 어댑터 안에서 unobservable로 접지고(빈값으로 접지
// 않음), judgeTeardown이 fail-closed로 막는다.
// HYK-171 사이클4b-1 재작업(streak 1, REVIEW review-1 P1-1): opts.
// existingSeatHandle(있으면)을 관측 단계로도 전달한다 -- 활성참조 판정의
// 자기-좌석 소유권 증거(teardown-inventory-adapter.mjs §P1-1 (B))로 쓰인다.
function observeInventoryForTeardown(c, opts) {
  return observeTeardownInventory(
    { worktreePath: c.worktreePath, repoId: c.repoId },
    {
      execFn: opts.execFn,
      gitFn: opts.gitFn,
      existsFn: opts.existsFn,
      existingSeatHandle: opts.existingSeatHandle,
    },
  );
}

// §2-C 비타협 #4: rm argv에서 --force 기본 제거. force는 opts.force===true
// 일 때만 붙는다(비-force 실패 뒤 force 자동 재호출 0 -- 이 함수도, 호출부
// 도 fallback을 만들지 않는다). buildWorktreeRemoveCommand(기존, A5/rollback
// 전용)와는 별도 빌더다 -- 그 함수의 기본 --force 계약을 이 새 계약으로
// 조용히 바꾸면 createManagedWorktree의 rollback(비범위)까지 깨진다.
export function buildTeardownWorktreeRemoveCommand(worktreePath, opts = {}) {
  const argv = ["worktree", "rm", "--worktree", `path:${worktreePath}`];
  if (opts.force === true) argv.push("--force");
  argv.push("--json");
  return argv;
}

// A6: 잔여 dispatch가 다음 배달을 막은 전례(태스크 지시) -- best-effort
// 정리, 종료 자체의 성패와 분리해 보고한다. taskId가 없으면(호출자가
// dispatch를 낸 적 없는 좌석) 생략. teardownSeat에서 분리(복잡도 분산).
function cleanupFailedTask(taskId, execFn) {
  if (!isNonEmptyString(taskId)) return null;
  try {
    return execFn(buildTaskUpdateFailedCommand(taskId));
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
}

// §2-C 순서 3/4/5: close -> (armed 경로에서만) rm 최대 1회 -> 사후 재관측.
// teardownSeat에서 분리(복잡도 분산 -- 관측/판정/실행을 각각 별 함수로).
function executeArmedTeardown(c, opts, before, judged) {
  const handleResult = resolveHandleForPort(c, opts, REASON.TEARDOWN_FAILED);
  if (!handleResult.ok) {
    return {
      ok: false,
      phase: TEARDOWN_PHASE.RESOLVE,
      armed: true,
      judged,
      before,
      reason: handleResult.reason,
      seatHandleReason: handleResult.seatHandleReason ?? null,
    };
  }

  const closed = guardedExec(
    buildSeatCloseCommand(handleResult.handle),
    opts.execFn,
    REASON.TEARDOWN_FAILED,
  );
  // HYK-171 사이클4b-2a §2-A: close 응답이 ok:true가 아니면(tab_not_found
  // 포함) 원인 미확정 실패로 즉시 정지한다 -- rm·task-update argv 0.
  // tab_not_found를 "이미 닫힘"으로 흡수해 rm으로 진행하던 이전 계약을
  // 뒤집는다(그 흡수가 PTY 고아를 삭제 성공으로 오분류시켰다).
  if (!closed.ok) {
    const classified = classifyCloseFailure(closed);
    return {
      ok: false,
      phase: TEARDOWN_PHASE.CLOSE,
      armed: true,
      judged,
      before,
      reason: classified.reason,
      closeErrorCode: classified.rawErrorCode,
      closeErrorMessage: classified.rawErrorMessage,
    };
  }

  const removed = guardedExec(
    buildTeardownWorktreeRemoveCommand(c.worktreePath, {
      force: opts.force === true,
    }),
    opts.execFn,
    REASON.TEARDOWN_FAILED,
  );
  if (!removed.ok) {
    return {
      ok: false,
      phase: TEARDOWN_PHASE.REMOVE,
      armed: true,
      judged,
      before,
      after: observeInventoryForTeardown(c, opts),
      reason: removed.reason,
    };
  }

  const after = observeInventoryForTeardown(c, opts);
  const execution = judgePostConditions({ before, after, cliOk: removed.ok });
  if (execution !== TEARDOWN_EXECUTION.SUCCEEDED) {
    return {
      ok: false,
      phase: TEARDOWN_PHASE.REMOVE,
      armed: true,
      judged,
      before,
      after,
      execution,
      reason: "TEARDOWN_POST_CONDITIONS_NOT_SUCCEEDED",
    };
  }

  return {
    ok: true,
    phase: TEARDOWN_PHASE.DONE,
    armed: true,
    judged,
    before,
    after,
    execution,
    cleanup: cleanupFailedTask(c.taskId, opts.execFn),
  };
}

// ctx: { role, worktreePath, taskId?, armed?, policy?, repoId? }
// opts: { execFn, gitFn?, existsFn?, existingSeatHandle?, force? }
export function teardownSeat(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const invalid = validateTeardownInput(c, opts);
  if (invalid) return { ok: false, reason: invalid };

  const before = observeInventoryForTeardown(c, opts);
  const judged = judgeTeardown({ inventory: before, policy: c.policy });
  const armed = c.armed === true;

  // §2-C 비타협 #1/#2: armed!==true 또는 allowSink!==true면 여기서 정지한다
  // -- close/rm/task-update 어느 것도 호출되지 않는다(위 관측 2건, orca
  // worktree/terminal list 조회는 읽기라 허용된다).
  if (!armed || !judged.allowSink) {
    return {
      ok: false,
      phase: TEARDOWN_PHASE.GATE,
      armed,
      judged,
      before,
      reason: !armed ? TEARDOWN_GATE_REASON.NOT_ARMED : judged.reason,
    };
  }

  return executeArmedTeardown(c, opts, before, judged);
}

// ---- 실 orca execFn (이 파일이 `orca` 문자열로 실제 프로세스를 spawn하는
// 유일한 지점 -- G9). run-step.mjs가 기본으로 이걸 쓰지만, 이 태스크에서는
// 어디에서도 호출되지 않는다(비타협 제약: 실 orca 호출 0). 테스트는 전부
// opts.execFn에 fake를 주입해 이 함수 자체를 실행하지 않는다.
export function createOrcaExecFn({ spawnSyncFn = spawnSync } = {}) {
  return function execFn(argv) {
    const raw = spawnSyncFn("orca", argv, { shell: false, encoding: "utf8" });
    if (
      isPlainObject(raw) &&
      raw.error &&
      raw.signal == null &&
      raw.status == null
    ) {
      throw raw.error;
    }
    const stdout = typeof raw?.stdout === "string" ? raw.stdout : "";
    try {
      return JSON.parse(stdout);
    } catch (err) {
      return {
        ok: false,
        reason: `orca-adapter: stdout not valid JSON (${errText(err)})`,
      };
    }
  };
}

// HYK-171 사이클3B (coder-task.md §2): launch-seam.mjs가 뒤에 두는 "실
// 워커를 띄우는" 얇은 실 sink -- ensureSeat/deliverTask(이 파일이 이미
// 내보내는 포트, buildSeatCreateCommand/buildSeatLaunchTextCommand 등을
// 그 안에서 그대로 쓴다)를 createOrcaExecFn(위, 이 파일에서만 `orca`를
// literal spawn하는 지점)로 조합할 뿐이다 -- 새 spawn 호출을 추가하지
// 않는다(G9 재확인: 이 함수도 스스로 spawnSync를 부르지 않고
// createOrcaExecFn이 만든 execFn만 통과시킨다).
//
// 비타협(coder-task.md §2/§5): 이 함수는 **어디에도 기본값으로 결선되지
// 않는다** -- launch-seam.mjs/grant-issuer.mjs 어느 쪽도 이걸 import하지
// 않고, sink 파라미터의 default도 아니다. 오직 호출자가 명시적으로
// import해서 acceptLaunch(..., { sink: createRealLaunchSink(...) })처럼
// 직접 넘겨야만 도달한다 -- 그리고 launch-seam.mjs는 armed=false가 강제인
// 이 사이클에서 그 sink 자체를 절대 호출하지 않는다(§4 6검 전부 통과해야
// 호출되고, 그 6검 중 하나는 이 사이클에서 상시 실패하는 armed===true
// 요구다).
// ---- HYK-171 사이클4b-2b-4 §1-A/1-D: 기록 seam 조립 ----
//
// dispatchWithStaleRecovery가 넘기는 raw 응답을 seat-registry.mjs의
// recordSeatDispatch가 받는 정규화 입력으로 바꾸고, 대장 파일에 원자
// 저장한다(saveRegistry의 tmp+rename). 이 함수 자체는 orca를 호출하지
// 않는다(execFn 없음) -- fs I/O만 한다.
//
// ⚠️ 정직 한계(coder-task.md §0): 이 recorder가 targetSelector로 쓰는
// worktreePath는 정상 동작하려면 대장에 그 worktreePath를 가진 안정
// 레코드가 이미 있어야 하는데, `createNewSeat`(위 D12 주석)가 더 이상
// `terminal create`를 호출하지 않으므로 프로덕션에서 그런 레코드가 생길
// 생산자가 없다 -- 즉 이 recorder는 프로덕션에서 항상 0-match(NO_TARGET,
// fail-closed)로 접힐 것이다. 이는 버그가 아니라 §0/§4가 사람 결정으로
// 남긴 "생성 영수증 부재"의 정직한 반영이다.
export function createDispatchReceiptRecorder({ registryPath, fs = {} } = {}) {
  const existsFn = typeof fs.existsFn === "function" ? fs.existsFn : existsSync;
  const readFn =
    typeof fs.readFn === "function"
      ? fs.readFn
      : (p) => readFileSync(p, "utf8");
  const writeFn =
    typeof fs.writeFn === "function"
      ? fs.writeFn
      : (p, text) => writeFileSync(p, text);
  const renameFn = typeof fs.renameFn === "function" ? fs.renameFn : renameSync;

  return function recordDispatchReceipt({ rawResponse, expect } = {}) {
    const envelope = normalizeDispatchRawUnion(rawResponse);
    if (!envelope.ok) {
      return {
        ok: false,
        reason: `orca-adapter: recordDispatchReceipt -- ${envelope.reasonCode}`,
      };
    }
    // M4: 응답의 runtime task id가 우리가 기대한 대상과 다르면(예: fake
    // execFn이 엉뚱한 배정 응답을 돌려준 경우) 무기록으로 접는다 -- 다른
    // task의 배정을 우리 것으로 잘못 결속하지 않는다.
    const e = isPlainObject(expect) ? expect : {};
    if (envelope.runtimeTaskId !== e.runtimeTaskId) {
      return {
        ok: false,
        reason:
          "orca-adapter: recordDispatchReceipt -- response runtimeTaskId does not match the expected dispatch target",
      };
    }

    const engine = ENGINE_BY_ROLE[e.role];
    const injectedProfile = judgeInjectedProfile({
      engine,
      shape: envelope.shape,
      injected: envelope.injected,
    });

    const loaded = loadRegistry(registryPath, { existsFn, readFn });
    if (!loaded.ok) {
      return {
        ok: false,
        reason: `orca-adapter: recordDispatchReceipt -- ${loaded.reason}`,
        injectedProfile,
      };
    }

    const recorded = recordSeatDispatch(loaded.registry, {
      worktreePath: e.worktreePath,
      assigneePaneKey: envelope.assigneePaneKey,
      harnessTaskId: e.harnessTaskId,
      runtimeTaskId: envelope.runtimeTaskId,
      dispatchId: envelope.dispatchId,
    });
    if (!recorded.ok) {
      return {
        ok: false,
        reason: `orca-adapter: recordDispatchReceipt -- ${recorded.reason}`,
        injectedProfile,
      };
    }

    const saved = saveRegistry(registryPath, recorded.registry, {
      writeFn,
      renameFn,
    });
    if (!saved.ok) {
      return {
        ok: false,
        reason: `orca-adapter: recordDispatchReceipt -- ${saved.reason}`,
        injectedProfile,
      };
    }
    return { ok: true, transition: recorded.transition, injectedProfile };
  };
}

// registryPath가 주어질 때만 기록 seam을 결선한다 -- 생략하면(현재 이
// 함수의 유일한 실 호출부인 launch-seam.mjs 어디서도 registryPath를 넘기지
// 않는다) opts.recordDispatchReceipt가 undefined로 남아
// dispatchWithStaleRecovery가 기록을 아예 시도하지 않는다(안전 기본값 --
// 새 결선 0 원칙과 충돌하지 않는다, §0 정직 표기 그대로 UNPROVEN 유지).
export function createRealLaunchSink({
  role,
  worktreePath,
  taskId,
  coordinatorHandle,
  execFn = createOrcaExecFn(),
  registryPath,
  registryFs,
} = {}) {
  const recordDispatchReceipt = isNonEmptyString(registryPath)
    ? createDispatchReceiptRecorder({ registryPath, fs: registryFs })
    : undefined;
  return function launchSink() {
    const seat = ensureSeat({ role, worktreePath }, { execFn });
    if (!seat.ok) return seat;
    return deliverTask(
      { role, worktreePath, taskId, coordinatorHandle },
      { execFn, recordDispatchReceipt },
    );
  };
}
