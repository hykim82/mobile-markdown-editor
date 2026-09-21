import { readFileSync } from "node:fs";

// HYK-294 (docs/enforcement-known-gaps.md gap#55 결선 진입점) -- 관제실
// (`dispatch-worker.ps1` 등)이 배달 직전/직후에 부를 수 있는 배정 결속
// 좌석 증명(dispatch-bound seat proof) CLI.
//
// 이 CLI는 순수 판정 사슬(terminal-show-adapter.mjs -> dispatch-correlation-
// adapter.mjs -> dispatch-bound-seat-proof.mjs)의 얇은 진입점일 뿐이다 --
// 판정 로직을 여기에 새로 두지 않는다. `orca` CLI를 이 파일이 직접
// spawn하지 않는다(호출자가 이미 얻은 `dispatch-show --json` /
// `terminal show --json` 응답을 파일 또는 stdin으로 준다 -- 순수 판정
// 유지, coder-task.md §2-1 항목3).
//
// 입력 3개, 각각 파일 경로 또는 `-`(stdin):
//   --dispatch-show <path|->   orca orchestration dispatch-show --json 원문
//   --terminal-show <path|->   orca terminal show --json 원문
//   --expected <path|->        { harnessTaskId, runtimeTaskId, dispatchId,
//                                 worktreeId, worktreePath } (호출자가
//                                 이미 알고 있는 배정 의도 -- dispatch-show/
//                                 terminal-show 자신에게서 파생하지 않는다.
//                                 그렇지 않으면 판정이 "자기 자신과
//                                 비교"하는 동어반복이 된다)
// stdin은 한 번만 읽을 수 있으므로 `-`는 세 인자 중 최대 하나에만 쓸 수
// 있다(그 이상이면 CLI_ARGS_AMBIGUOUS_STDIN으로 거부).
//
// 출력: 한 줄 사람이 읽는 판정 + reasonCode.
// 종료코드: 0 = PROVEN. 2 = 그 외 전부(거부·입력불량·「알 수 없음」 포함,
// fail-closed -- "알 수 없음"을 0으로 내지 않는다).

import { judgeDispatchBoundSeatProof } from "./dispatch-bound-seat-proof.mjs";
import { normalizeTerminalShow } from "./adapters/terminal-show-adapter.mjs";
import { normalizeDispatchShow } from "./adapters/dispatch-correlation-adapter.mjs";

export const CLI_REASON = Object.freeze({
  ARGS_MISSING: "CLI_ARGS_MISSING",
  ARGS_UNRECOGNIZED: "CLI_ARGS_UNRECOGNIZED",
  ARGS_AMBIGUOUS_STDIN: "CLI_ARGS_AMBIGUOUS_STDIN",
  INPUT_READ_FAILED: "CLI_INPUT_READ_FAILED",
  INPUT_JSON_INVALID: "CLI_INPUT_JSON_INVALID",
  EXPECTED_JSON_NOT_OBJECT: "CLI_EXPECTED_JSON_NOT_OBJECT",
});

const FLAG_TO_FIELD = Object.freeze({
  "--dispatch-show": "dispatchShowSource",
  "--terminal-show": "terminalShowSource",
  "--expected": "expectedSource",
});

const REQUIRED_FLAGS = ["--dispatch-show", "--terminal-show", "--expected"];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// argv 파싱만 하는 순수 함수 -- I/O 없음.
export function parseSeatProofCliArgs(argv) {
  const fields = {};
  const rest = Array.isArray(argv) ? argv.slice() : [];
  while (rest.length > 0) {
    const flag = rest.shift();
    if (!(flag in FLAG_TO_FIELD)) {
      return {
        ok: false,
        reasonCode: CLI_REASON.ARGS_UNRECOGNIZED,
        detail: `unrecognized argument '${flag}'`,
      };
    }
    const value = rest.shift();
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false,
        reasonCode: CLI_REASON.ARGS_MISSING,
        detail: `'${flag}' requires a value (path or '-')`,
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
      reasonCode: CLI_REASON.ARGS_MISSING,
      detail: `missing required argument(s): ${missing.join(", ")}`,
    };
  }

  const stdinCount = Object.values(fields).filter((v) => v === "-").length;
  if (stdinCount > 1) {
    return {
      ok: false,
      reasonCode: CLI_REASON.ARGS_AMBIGUOUS_STDIN,
      detail:
        "'-' (stdin) given for more than one input -- stdin can only be read once",
    };
  }

  return { ok: true, fields };
}

// source("-" 또는 파일경로)를 실제 텍스트로 바꾼다. stdin은 opts.stdinText로
// 미리 채취해 넘겨받는다(중복 읽기 방지 -- 진짜 파이프 stdin은 한 번만
// 소비 가능).
function readSource(source, { readFileFn, stdinText }) {
  if (source === "-") {
    if (typeof stdinText !== "string") {
      return { ok: false, reasonCode: CLI_REASON.INPUT_READ_FAILED };
    }
    return { ok: true, text: stdinText };
  }
  try {
    return { ok: true, text: readFileFn(source, "utf8") };
  } catch (err) {
    return {
      ok: false,
      reasonCode: CLI_REASON.INPUT_READ_FAILED,
      detail: err && err.message,
    };
  }
}

function parseJson(text, { requireObject } = {}) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      reasonCode: CLI_REASON.INPUT_JSON_INVALID,
      detail: err && err.message,
    };
  }
  if (requireObject && !isPlainObject(value)) {
    return { ok: false, reasonCode: CLI_REASON.EXPECTED_JSON_NOT_OBJECT };
  }
  return { ok: true, value };
}

function rejected(reasonCode, detail) {
  return { ok: false, exitCode: 2, verdict: null, reasonCode, detail };
}

// 입력 슬롯 하나(--dispatch-show/--terminal-show/--expected)를 읽고
// 파싱한다. 실패 시 CLI 응답 모양(rejected())으로 바로 접어, 호출자가 세
// 슬롯을 같은 모양의 분기 3벌로 반복하지 않게 한다 -- 어떤 검사도
// 생략하지 않는다(읽기 실패/JSON 파손/object-아님 셋 다 그대로 남는다).
function readAndParseSlot(flagLabel, source, opts) {
  const read = readSource(source, opts);
  if (!read.ok) {
    return rejected(
      read.reasonCode,
      `${flagLabel}: ${read.detail || "read failed"}`,
    );
  }
  const json = parseJson(read.text, { requireObject: opts.requireObject });
  if (!json.ok) {
    return rejected(
      json.reasonCode,
      `${flagLabel}: ${json.detail || "invalid JSON"}`,
    );
  }
  return { ok: true, value: json.value };
}

// runSeatProofCli(argv, opts) -> { ok, exitCode, verdict, reasonCode, detail }
// 순수 함수 -- 실제 fs/stdin 접근은 주입된 opts.readFileFn/opts.stdinText를
// 통해서만 일어난다(테스트가 실제 파일 없이 구동할 수 있게).
export function runSeatProofCli(argv, opts = {}) {
  const readFileFn = opts.readFileFn || readFileSync;
  const stdinText = opts.stdinText;

  const parsedArgs = parseSeatProofCliArgs(argv);
  if (!parsedArgs.ok) {
    return rejected(parsedArgs.reasonCode, parsedArgs.detail);
  }
  const { dispatchShowSource, terminalShowSource, expectedSource } =
    parsedArgs.fields;
  const readOpts = { readFileFn, stdinText };

  const dispatchShowSlot = readAndParseSlot(
    "--dispatch-show",
    dispatchShowSource,
    readOpts,
  );
  if (!dispatchShowSlot.ok) return dispatchShowSlot;

  const terminalShowSlot = readAndParseSlot(
    "--terminal-show",
    terminalShowSource,
    readOpts,
  );
  if (!terminalShowSlot.ok) return terminalShowSlot;

  const expectedSlot = readAndParseSlot("--expected", expectedSource, {
    ...readOpts,
    requireObject: true,
  });
  if (!expectedSlot.ok) return expectedSlot;

  const dispatchShow = normalizeDispatchShow(dispatchShowSlot.value);
  const terminalShow = normalizeTerminalShow(terminalShowSlot.value);
  const verdict = judgeDispatchBoundSeatProof({
    dispatchShow,
    terminalShow,
    expected: expectedSlot.value,
  });

  const proven = verdict.verdict === "PROVEN";
  return {
    ok: proven,
    exitCode: proven ? 0 : 2,
    verdict: verdict.verdict,
    reasonCode: verdict.reasonCode,
    detail: null,
  };
}

export function formatSeatProofCliResult(result) {
  if (result.verdict) {
    return `SEAT_PROOF: ${result.verdict}/${result.reasonCode}`;
  }
  return `SEAT_PROOF: REJECTED/${result.reasonCode}${
    result.detail ? ` (${result.detail})` : ""
  }`;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/seat-proof-cli.mjs");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  let stdinText;
  if (argv.includes("-")) {
    try {
      stdinText = readFileSync(0, "utf8");
    } catch {
      stdinText = "";
    }
  }
  const result = runSeatProofCli(argv, { stdinText });
  console.log(formatSeatProofCliResult(result));
  process.exit(result.exitCode);
}
