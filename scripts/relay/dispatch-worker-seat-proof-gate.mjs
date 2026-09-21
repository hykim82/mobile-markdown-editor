// HYK-299 (docs/enforcement-known-gaps.md gap#55 결선, coder-task.md §4-1)
// -- 관제실 `dispatch-worker.ps1`이 부를 얇은 진입점.
//
// seat-proof-cli.mjs를 그대로 쓴다(§4-1 "판정 로직은 새로 만들지 마라") --
// 이 파일이 새로 하는 일은 딱 하나, ps1이 이미 알고 있는 배정 의도 다섯
// 필드(--harness-task-id/--runtime-task-id/--dispatch-id/--worktree-id/
// --worktree-path)를 이 프로세스 «안에서» 조립해 seat-proof-cli.mjs의
// `--expected` 슬롯에 stdin으로 먹이는 것뿐이다. dispatch-show/
// terminal-show 파일은 그 경로 그대로 seat-proof-cli.mjs에 넘길 뿐, 이
// 파일은 그 두 파일의 내용을 열어서 읽지 않는다(buildExpected는 fs를
// 아예 import하지 않는다 -- 구조적으로 "--expected를 --terminal-show에서
// 파생시키는" 동어반복이 이 진입점 자체에서는 발생할 수 없다. 호출자가
// --worktree-id/--worktree-path 값 자체를 어디서 구했는지는 이 파일의
// 책임 밖이다 -- 그 출처의 독립성은
// docs/control-room-patches/HYK-299-dispatch-worker-seat-proof.md에
// 정직하게 적혀 있다).
//
// 종료코드 계약은 seat-proof-cli.mjs와 동일하다: 0 = PROVEN, 2 = 그 외
// 전부(fail-closed). 이 파일 자신의 인자 파싱 실패도 exit 2다.

import {
  runSeatProofCli,
  formatSeatProofCliResult,
} from "./seat-proof-cli.mjs";

export const GATE_REASON = Object.freeze({
  ARGS_MISSING: "GATE_ARGS_MISSING",
  ARGS_UNRECOGNIZED: "GATE_ARGS_UNRECOGNIZED",
});

const FLAG_TO_FIELD = Object.freeze({
  "--dispatch-show": "dispatchShowSource",
  "--terminal-show": "terminalShowSource",
  "--harness-task-id": "harnessTaskId",
  "--runtime-task-id": "runtimeTaskId",
  "--dispatch-id": "dispatchId",
  "--worktree-id": "worktreeId",
  "--worktree-path": "worktreePath",
});

const REQUIRED_FLAGS = Object.keys(FLAG_TO_FIELD);

// argv 파싱만 하는 순수 함수 -- I/O 없음(seat-proof-cli.mjs의
// parseSeatProofCliArgs와 같은 모양을 그대로 따른다).
export function parseGateArgs(argv) {
  const fields = {};
  const rest = Array.isArray(argv) ? argv.slice() : [];
  while (rest.length > 0) {
    const flag = rest.shift();
    if (!(flag in FLAG_TO_FIELD)) {
      return {
        ok: false,
        reasonCode: GATE_REASON.ARGS_UNRECOGNIZED,
        detail: `unrecognized argument '${flag}'`,
      };
    }
    const value = rest.shift();
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false,
        reasonCode: GATE_REASON.ARGS_MISSING,
        detail: `'${flag}' requires a value`,
      };
    }
    fields[FLAG_TO_FIELD[flag]] = value;
  }

  const missing = REQUIRED_FLAGS.filter(
    (flag) => !(FLAG_TO_FIELD[flag] in fields),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reasonCode: GATE_REASON.ARGS_MISSING,
      detail: `missing required argument(s): ${missing.join(", ")}`,
    };
  }

  return { ok: true, fields };
}

// expected는 오직 이 다섯 필드로만 조립된다. 이 함수는 fs를 열지 않는다
// -- --dispatch-show/--terminal-show가 가리키는 파일 내용을 읽어 값을
// 채우는 경로가 이 파일 안에 아예 없다(구조적 비타협).
export function buildExpected(fields) {
  return {
    harnessTaskId: fields.harnessTaskId,
    runtimeTaskId: fields.runtimeTaskId,
    dispatchId: fields.dispatchId,
    worktreeId: fields.worktreeId,
    worktreePath: fields.worktreePath,
  };
}

// runGate(argv, opts) -> seat-proof-cli.mjs의 runSeatProofCli와 같은 모양
// { ok, exitCode, verdict, reasonCode, detail }. opts.readFileFn은
// dispatch-show/terminal-show 두 파일 읽기에만 쓰인다(--expected는 항상
// 이 프로세스 안에서 만든 stdin으로 간다 -- opts.stdinText는 여기서
// 덮어쓴다, 호출자가 넘긴 값이 있어도 무시한다).
export function runGate(argv, opts = {}) {
  const parsed = parseGateArgs(argv);
  if (!parsed.ok) {
    return {
      ok: false,
      exitCode: 2,
      verdict: null,
      reasonCode: parsed.reasonCode,
      detail: parsed.detail,
    };
  }

  const { dispatchShowSource, terminalShowSource } = parsed.fields;
  const expected = buildExpected(parsed.fields);
  const innerArgv = [
    "--dispatch-show",
    dispatchShowSource,
    "--terminal-show",
    terminalShowSource,
    "--expected",
    "-",
  ];
  return runSeatProofCli(innerArgv, {
    readFileFn: opts.readFileFn,
    stdinText: JSON.stringify(expected),
  });
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/dispatch-worker-seat-proof-gate.mjs");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const result = runGate(argv);
  console.log(formatSeatProofCliResult(result));
  process.exit(result.exitCode);
}
