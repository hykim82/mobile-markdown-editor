import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runGate,
  parseGateArgs,
  buildExpected,
  GATE_REASON,
} from "./dispatch-worker-seat-proof-gate.mjs";
import {
  rawTerminalShowP1,
  rawDispatchShowP2,
  expectedMatchingP1P2,
} from "./hyk171-cycle4b2c-fixtures.mjs";

// HYK-299 (docs/enforcement-known-gaps.md gap#55 결선, coder-task.md §4-3)
// -- dispatch-worker-seat-proof-gate.mjs 시험. seat-proof-cli.test.mjs와
// 같은 실제 fs를 쓰지 않는 순수 구동 스타일(fakeReadFileFn)을 그대로
// 따른다. 이 파일이 «반드시» 증명해야 하는 4가지(coder-task.md §4-3):
// (1) GREEN, (2) RED(인과 -- 같은 입력에서 좌석 신원 한 조각만 어긋나게
// 바꾸면 뒤집힘), (3) 동어반복 방지(--expected가 --terminal-show에서
// 파생되지 않음), (4) 회귀 0(정상 좌석 영향 없음) -- 그리고 §4-3-보너스
// (오늘 실제 오배송 = 빈 handle 반례).

function fakeReadFileFn(files) {
  return (path) => {
    if (!(path in files)) {
      const err = new Error(`ENOENT: no such file '${path}'`);
      err.code = "ENOENT";
      throw err;
    }
    return files[path];
  };
}

function expectedFlags(exp) {
  return [
    "--harness-task-id",
    exp.harnessTaskId,
    "--runtime-task-id",
    exp.runtimeTaskId,
    "--dispatch-id",
    exp.dispatchId,
    "--worktree-id",
    exp.worktreeId,
    "--worktree-path",
    exp.worktreePath,
  ];
}

function baseFiles(overrides = {}) {
  return {
    "/ds.json": JSON.stringify(rawDispatchShowP2(overrides.dispatchOverrides)),
    "/ts.json": JSON.stringify(rawTerminalShowP1(overrides.terminalOverrides)),
  };
}

function argsFor(files, exp, over = {}) {
  return [
    "--dispatch-show",
    over.dispatchShow || "/ds.json",
    "--terminal-show",
    over.terminalShow || "/ts.json",
    ...expectedFlags(exp),
  ];
}

// ---------------------------------------------------------------------------
// (1) GREEN -- 좌석·배정이 일치하는 정상 입력 -- PROVEN, exit 0, 배달 진행.
// ---------------------------------------------------------------------------
test("GREEN: matching dispatch-show + terminal-show + gate flags -- PROVEN, exit 0", () => {
  const files = baseFiles();
  const exp = expectedMatchingP1P2();
  const result = runGate(argsFor(files, exp), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "PROVEN");
  assert.equal(result.reasonCode, "PROVEN");
});

// ---------------------------------------------------------------------------
// (2) RED(인과) -- 같은 입력에서 좌석 신원 한 조각(dispatchId)만 어긋나게
// 바꾸면 exit 2로 뒤집힌다. "통과만 세는" 시험이 아니라 뒤집히는 것을
// 직접 보여준다(coder-task.md §4-3 항목2 비타협).
// ---------------------------------------------------------------------------
test("RED(causal): flipping only --dispatch-id away from the true dispatch id flips PROVEN -> exit 2", () => {
  const files = baseFiles();
  const exp = expectedMatchingP1P2();

  const green = runGate(argsFor(files, exp), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(green.exitCode, 0);
  assert.equal(green.verdict, "PROVEN");

  const flipped = expectedMatchingP1P2({
    dispatchId: "ctx_wrong-dispatch-0000",
  });
  const red = runGate(argsFor(files, flipped), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(red.exitCode, 2);
  assert.equal(red.verdict, "UNPROVEN");
  assert.equal(red.reasonCode, "DISPATCH_ID_MISMATCH");
});

// 같은 인과 시험을 runtimeTaskId 축으로도 반복 -- 축마다 독립적으로
// 뒤집히는지 확인한다(하나만 보이고 나머지는 우연일 수 있다는 반박을
// 막는다).
test("RED(causal): flipping only --runtime-task-id flips PROVEN -> exit 2/TASK_ID_MISMATCH", () => {
  const files = baseFiles();
  const flipped = expectedMatchingP1P2({ runtimeTaskId: "task_wrong-0000" });
  const red = runGate(argsFor(files, flipped), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(red.exitCode, 2);
  assert.equal(red.verdict, "UNPROVEN");
  assert.equal(red.reasonCode, "TASK_ID_MISMATCH");
});

// ---------------------------------------------------------------------------
// (3) 동어반복 방지 -- --expected가 --terminal-show/--dispatch-show 파일
// 내용에서 파생되지 않았음을 직접 보여준다. buildExpected는 fs를 아예
// import하지 않는 순수 함수다(위 dispatch-worker-seat-proof-gate.mjs
// 소스 자체가 그 증거) -- 여기서는 그 계약을 실행으로 재확인한다: 파일
// 내용과 무관하게 넘긴 다섯 필드가 그대로 echo되는지, 그리고 파일의
// worktreeId와 --worktree-id 플래그 값이 어긋나면(파생시켰다면 항상
// 같아서 절대 못 잡았을 상황) 실제로 WORKTREE_MISMATCH로 거부되는지.
// ---------------------------------------------------------------------------
test("anti-tautology: buildExpected echoes only the 5 CLI flags, never touches fs", () => {
  const fields = {
    harnessTaskId: "HYK-anything",
    runtimeTaskId: "task_anything",
    dispatchId: "ctx_anything",
    worktreeId: "wt_anything",
    worktreePath: "/anywhere",
  };
  assert.deepEqual(buildExpected(fields), fields);
});

test("anti-tautology: --worktree-id disagreeing with the terminal-show file's own worktreeId is caught (would be invisible if --expected were derived from --terminal-show)", () => {
  const files = baseFiles();
  // P1 fixture의 실제 worktreeId는 "...pm-lane" 접미 -- 여기서는 그와 다른
  // 값을 --worktree-id로 준다(호출자가 독립적으로 알고 있다고 주장하는
  // 값이 실제로는 틀린 경우를 시뮬레이션).
  const wrongWorktree = expectedMatchingP1P2({
    worktreeId:
      "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/some-other-worktree",
  });
  const result = runGate(argsFor(files, wrongWorktree), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "UNPROVEN");
  assert.equal(result.reasonCode, "WORKTREE_MISMATCH");
});

// ---------------------------------------------------------------------------
// (4) 회귀 0 -- 기존 배달 경로(정상 좌석)는 영향 없음. handle이 달라도
// paneKey가 일치하면 여전히 PROVEN이어야 한다(HYK-294 불변식 -- 이
// 진입점을 새로 얹었다고 해서 그 불변식이 깨지면 안 된다).
// ---------------------------------------------------------------------------
test("regression: HYK-294 invariant survives the new gate wrapper -- differing assignee_handle, matching paneKey -- still PROVEN", () => {
  const files = baseFiles({
    dispatchOverrides: { assignee_handle: "term_totally-different-0000" },
  });
  const exp = expectedMatchingP1P2();
  const result = runGate(argsFor(files, exp), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "PROVEN");
});

// ---------------------------------------------------------------------------
// §4-3-보너스 -- 2026-08-19 16:35 실제 오배송(빈 handle이 "활성 터미널"로
// 흘러가 REVIEW 좌석에 조율자용 지시가 배달됨) 반례. 빈 handle로 얻은
// terminal-show는 handle 필드가 빈 문자열이라 어댑터의 REQUIRED_FIELDS
// 검사(비어있지 않은 문자열)에서 이미 걸린다 -- exit 2가 실제로 나오는지
// 직접 실행해 확인한다(가정이 아니라 실행 결과).
// ---------------------------------------------------------------------------
test("bonus repro: empty handle in terminal-show is rejected -- UNPROVEN/TERMINAL_SHOW_INVALID, exit 2 (2026-08-19 16:35 misdelivery shape)", () => {
  const files = baseFiles({ terminalOverrides: { handle: "" } });
  const exp = expectedMatchingP1P2();
  const result = runGate(argsFor(files, exp), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "UNPROVEN");
  assert.equal(result.reasonCode, "TERMINAL_SHOW_INVALID");
});

test("bonus repro: terminal-show call itself failing (empty/unresolvable handle -> ok:false) is rejected -- exit 2, never falls through to PROVEN", () => {
  const files = baseFiles();
  files["/ts.json"] = JSON.stringify({
    id: "reqEmptyHandle",
    ok: false,
    error: { code: "terminal_handle_invalid", message: "handle is empty" },
  });
  const exp = expectedMatchingP1P2();
  const result = runGate(argsFor(files, exp), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "UNPROVEN");
  assert.equal(result.reasonCode, "TERMINAL_SHOW_INVALID");
});

// ---------------------------------------------------------------------------
// 인자 파싱 -- gate 자신의 결손/미인식 인자도 fail-closed(exit 2).
// ---------------------------------------------------------------------------
test("gate args: missing a required flag (--dispatch-id) -- GATE_ARGS_MISSING, exit 2", () => {
  const files = baseFiles();
  const exp = expectedMatchingP1P2();
  const flags = argsFor(files, exp).filter(
    (_, i, arr) =>
      !(arr[i - 1] === "--dispatch-id" || arr[i] === "--dispatch-id"),
  );
  const parsed = parseGateArgs(flags);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reasonCode, GATE_REASON.ARGS_MISSING);

  const result = runGate(flags, { readFileFn: fakeReadFileFn(files) });
  assert.equal(result.exitCode, 2);
  assert.equal(result.reasonCode, GATE_REASON.ARGS_MISSING);
});

test("gate args: unrecognized flag -- GATE_ARGS_UNRECOGNIZED, exit 2", () => {
  const files = baseFiles();
  const exp = expectedMatchingP1P2();
  const result = runGate([...argsFor(files, exp), "--policy", "loosen"], {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.reasonCode, GATE_REASON.ARGS_UNRECOGNIZED);
});

// ---------------------------------------------------------------------------
// §3 항목8 -- HYK-299-casefold-1 실배달 재현 시험(게이트 계층). 아래 두
// 상수는 .harness/evidence/hyk299-seatproof-task_5ba32ba9e6bd-{dispatch,
// terminal}-show.json 의 내용을 그대로 옮긴 것이다(2026-08-19 18:10 실제
// 배달에서 배달기가 만든 원본 파일 -- 이 시험은 그 내용을 저장소 안
// fixture로 박아 넣을 뿐, `.harness/`를 읽지 않는다). argv는 관제실
// `dispatch-worker.ps1`이 실제로 만드는 모양 그대로 조립한다: `--worktree-id`
// 는 terminal-show의 원본 대소문자 그대로(코드 원문에 `--worktree-id
// $seatProofWorktreeId`, Norm()을 거치지 않는다), `--worktree-path`만
// `Norm()`(소문자화)을 거친다. 합성 입력으로 대소문자를 미리 맞춰 놓지
//않는다.
// ---------------------------------------------------------------------------
const HYK299_REAL_DISPATCH_SHOW = {
  id: "04d19cbd-cc5f-4ce3-a230-1eaf377b2a99",
  ok: true,
  result: {
    dispatch: {
      id: "ctx_fd5d03771398",
      task_id: "task_5ba32ba9e6bd",
      assignee_handle: "term_82babd3c-4f10-41bb-adeb-edf128e3f2fc",
      assignee_pane_key:
        "0ace207a-d6ac-46f6-8f2f-b9747d0c2e6a:d441ce36-38a7-4e19-8611-9fa7b81e485f",
      status: "dispatched",
      failure_count: 0,
      last_failure: null,
      dispatched_at: "2026-08-19 09:10:58",
      completed_at: null,
      created_at: "2026-08-19 09:10:58",
      last_heartbeat_at: null,
    },
  },
  _meta: { runtimeId: "50b1e964-1a53-4f20-8704-bf75c4c69f75" },
};

const HYK299_REAL_TERMINAL_SHOW = {
  id: "c14fb8a8-15dd-4bf7-af05-48327e948f2e",
  ok: true,
  result: {
    terminal: {
      handle: "term_82babd3c-4f10-41bb-adeb-edf128e3f2fc",
      ptyId:
        "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review@@9ea19715",
      worktreeId:
        "e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
      worktreePath:
        "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk306-review",
      branch: "refs/heads/hyk306-review",
      tabId: "0ace207a-d6ac-46f6-8f2f-b9747d0c2e6a",
      leafId: "d441ce36-38a7-4e19-8611-9fa7b81e485f",
      title: "hyk306-review",
      connected: true,
      writable: true,
      lastOutputAt: 1787130631932,
      preview: "SYNTHETIC(placeholder -- not a contract)",
      paneRuntimeId: 1,
      rendererGraphEpoch: 0,
    },
  },
  _meta: { runtimeId: "50b1e964-1a53-4f20-8704-bf75c4c69f75" },
};

function hyk299RealFiles() {
  return {
    "/hyk299-ds.json": JSON.stringify(HYK299_REAL_DISPATCH_SHOW),
    "/hyk299-ts.json": JSON.stringify(HYK299_REAL_TERMINAL_SHOW),
  };
}

// dispatch-worker.ps1이 실제로 조립하는 argv 모양: --worktree-id는
// terminal-show의 원본 worktreeId(대소문자 보존, Norm() 미적용), --worktree-path는
// Norm(원본 worktreePath)(소문자화).
function hyk299RealArgv(worktreePathOverride) {
  return [
    "--dispatch-show",
    "/hyk299-ds.json",
    "--terminal-show",
    "/hyk299-ts.json",
    "--harness-task-id",
    "HYK-299-casefold-1",
    "--runtime-task-id",
    HYK299_REAL_DISPATCH_SHOW.result.dispatch.task_id,
    "--dispatch-id",
    HYK299_REAL_DISPATCH_SHOW.result.dispatch.id,
    "--worktree-id",
    HYK299_REAL_TERMINAL_SHOW.result.terminal.worktreeId,
    "--worktree-path",
    worktreePathOverride,
  ];
}

test("HYK-299-casefold-1 repro (a): Norm()-lowercased --worktree-path, real evidence pair -- exit 0 (was exit 2 / WORKTREE_MISMATCH before the fix)", () => {
  const files = hyk299RealFiles();
  const lowered =
    HYK299_REAL_TERMINAL_SHOW.result.terminal.worktreePath.toLowerCase();
  const result = runGate(hyk299RealArgv(lowered), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "PROVEN");
});

test("HYK-299-casefold-1 repro (b): case-preserved --worktree-path, real evidence pair -- exit 0 (regression check)", () => {
  const files = hyk299RealFiles();
  const preserved = HYK299_REAL_TERMINAL_SHOW.result.terminal.worktreePath;
  const result = runGate(hyk299RealArgv(preserved), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "PROVEN");
});

test("HYK-299-casefold-1 repro (c): genuinely different --worktree-path, real evidence pair -- exit 2/WORKTREE_MISMATCH (detection preserved)", () => {
  const files = hyk299RealFiles();
  const wrong =
    "c:/users/administrator/orca/workspaces/harnessengineering/hyk306-label";
  const result = runGate(hyk299RealArgv(wrong), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "UNPROVEN");
  assert.equal(result.reasonCode, "WORKTREE_MISMATCH");
});
