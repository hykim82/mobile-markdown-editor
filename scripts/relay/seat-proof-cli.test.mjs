import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runSeatProofCli,
  formatSeatProofCliResult,
  parseSeatProofCliArgs,
  CLI_REASON,
} from "./seat-proof-cli.mjs";
import {
  rawTerminalShowP1,
  rawDispatchShowP2,
  rawTerminalListRowDisguisedAsShow,
  expectedMatchingP1P2,
} from "./hyk171-cycle4b2c-fixtures.mjs";

// HYK-294 (coder-task.md §2-1 항목3/4) -- seat-proof-cli.mjs 시험. 실제
// 파일시스템을 쓰지 않는다 -- readFileFn을 in-memory map으로 주입해
// (path -> text) 순수하게 구동한다(§3-1 "실물 형태 2종으로 CLI 직접
// 실행"은 이 파일이 아니라 결과 파일(.harness/coder.md)에 원문으로 남기는
// 별도 실측 절차다).

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

function baseFiles(overrides = {}) {
  return {
    "/ds.json": JSON.stringify(rawDispatchShowP2(overrides.dispatchOverrides)),
    "/ts.json": JSON.stringify(rawTerminalShowP1(overrides.terminalOverrides)),
    "/expected.json": JSON.stringify(
      expectedMatchingP1P2(overrides.expectedOverrides),
    ),
  };
}

function argsFor(files, over = {}) {
  return [
    "--dispatch-show",
    over.dispatchShow || "/ds.json",
    "--terminal-show",
    over.terminalShow || "/ts.json",
    "--expected",
    over.expected || "/expected.json",
  ];
}

// ---------------------------------------------------------------------------
// (a) 정상 좌석 응답 -- PROVEN exit 0.
// ---------------------------------------------------------------------------
test("normal seat: matching dispatch-show + terminal-show + expected -- PROVEN, exit 0", () => {
  const files = baseFiles();
  const result = runSeatProofCli(argsFor(files), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "PROVEN");
  assert.equal(result.reasonCode, "PROVEN");
  assert.equal(formatSeatProofCliResult(result), "SEAT_PROOF: PROVEN/PROVEN");
});

// ---------------------------------------------------------------------------
// (b) 퇴화 좌석 응답 -- tabId===leafId -- 거부 exit 2.
// ---------------------------------------------------------------------------
test("degenerate seat: tabId === leafId is rejected -- UNPROVEN/TERMINAL_SHOW_INVALID, exit 2", () => {
  const degenerateTabId = "same-value-for-both";
  const files = baseFiles({
    terminalOverrides: { tabId: degenerateTabId, leafId: degenerateTabId },
  });
  const result = runSeatProofCli(argsFor(files), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "UNPROVEN");
  assert.equal(result.reasonCode, "TERMINAL_SHOW_INVALID");
});

// ---------------------------------------------------------------------------
// (b2) 퇴화 좌석 응답 -- `pty:` 접두 폴백 형태 -- 거부 exit 2.
// ---------------------------------------------------------------------------
test("degenerate seat: 'pty:' fallback-form tabId is rejected -- UNPROVEN/TERMINAL_SHOW_INVALID, exit 2", () => {
  const files = baseFiles({
    terminalOverrides: {
      tabId: "pty:e841ec57-…::C:/Users/…/pm-lane@@cd142cb0",
    },
  });
  const result = runSeatProofCli(argsFor(files), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "UNPROVEN");
  assert.equal(result.reasonCode, "TERMINAL_SHOW_INVALID");
});

// ---------------------------------------------------------------------------
// (c) paneKey 불일치 -- 거부.
// ---------------------------------------------------------------------------
test("paneKey mismatch -- UNPROVEN/PANE_KEY_MISMATCH, exit 2", () => {
  const files = baseFiles({
    terminalOverrides: {
      leafId: "baba3a4b-05b3-42e9-ba76-93ad0ba9e070", // 마지막 글자만 다름
    },
  });
  const result = runSeatProofCli(argsFor(files), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "UNPROVEN");
  assert.equal(result.reasonCode, "PANE_KEY_MISMATCH");
});

// ---------------------------------------------------------------------------
// (d) 입력 JSON 결손(파일 없음)/파손(깨진 JSON) -- exit 2.
// ---------------------------------------------------------------------------
test("missing input file -- CLI_INPUT_READ_FAILED, exit 2", () => {
  const files = baseFiles();
  const result = runSeatProofCli(
    argsFor(files, { dispatchShow: "/does-not-exist.json" }),
    { readFileFn: fakeReadFileFn(files) },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, null);
  assert.equal(result.reasonCode, CLI_REASON.INPUT_READ_FAILED);
});

test("corrupt JSON input -- CLI_INPUT_JSON_INVALID, exit 2", () => {
  const files = baseFiles();
  files["/ts.json"] = "{not valid json at all";
  const result = runSeatProofCli(argsFor(files), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, null);
  assert.equal(result.reasonCode, CLI_REASON.INPUT_JSON_INVALID);
});

test("expected JSON is not an object (e.g. a bare array) -- CLI_EXPECTED_JSON_NOT_OBJECT, exit 2", () => {
  const files = baseFiles();
  files["/expected.json"] = "[1,2,3]";
  const result = runSeatProofCli(argsFor(files), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.reasonCode, CLI_REASON.EXPECTED_JSON_NOT_OBJECT);
});

// ---------------------------------------------------------------------------
// (e) ★HYK-294 핵심 -- handle이 달라도 paneKey가 맞으면 PROVEN.
// ---------------------------------------------------------------------------
test("HYK-294: assignee_handle differs from terminal-show handle but paneKey matches -- PROVEN, exit 0", () => {
  const files = baseFiles({
    dispatchOverrides: { assignee_handle: "term_totally-different-0000" },
  });
  const result = runSeatProofCli(argsFor(files), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "PROVEN");
  assert.equal(result.reasonCode, "PROVEN");
});

test("HYK-294: assignee_handle missing entirely but paneKey matches -- PROVEN, exit 0", () => {
  const files = baseFiles({
    dispatchOverrides: { assignee_handle: undefined },
  });
  const result = runSeatProofCli(argsFor(files), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "PROVEN");
});

// ---------------------------------------------------------------------------
// (f) `terminal list` 형태(⛔ `terminal show` 계약 위반) -- 거부.
// ---------------------------------------------------------------------------
test("terminal-list-shaped input in the --terminal-show slot is rejected -- UNPROVEN/TERMINAL_SHOW_INVALID, exit 2", () => {
  const files = baseFiles();
  files["/ts.json"] = JSON.stringify(rawTerminalListRowDisguisedAsShow());
  const result = runSeatProofCli(argsFor(files), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "UNPROVEN");
  assert.equal(result.reasonCode, "TERMINAL_SHOW_INVALID");
});

// ---------------------------------------------------------------------------
// (g) 인자 파싱 -- 결손/미인식/모호한 stdin.
// ---------------------------------------------------------------------------
test("args: missing --expected -- CLI_ARGS_MISSING, exit 2 (never exit 0 on unknown)", () => {
  const parsed = parseSeatProofCliArgs([
    "--dispatch-show",
    "/ds.json",
    "--terminal-show",
    "/ts.json",
  ]);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reasonCode, CLI_REASON.ARGS_MISSING);

  const files = baseFiles();
  const result = runSeatProofCli(
    ["--dispatch-show", "/ds.json", "--terminal-show", "/ts.json"],
    { readFileFn: fakeReadFileFn(files) },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.reasonCode, CLI_REASON.ARGS_MISSING);
});

test("args: unrecognized flag -- CLI_ARGS_UNRECOGNIZED, exit 2", () => {
  const files = baseFiles();
  const result = runSeatProofCli([...argsFor(files), "--policy", "loosen"], {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.reasonCode, CLI_REASON.ARGS_UNRECOGNIZED);
});

test("args: two inputs both requesting stdin ('-') -- CLI_ARGS_AMBIGUOUS_STDIN, exit 2", () => {
  const files = baseFiles();
  const result = runSeatProofCli(
    argsFor(files, { dispatchShow: "-", terminalShow: "-" }),
    { readFileFn: fakeReadFileFn(files), stdinText: files["/ds.json"] },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.reasonCode, CLI_REASON.ARGS_AMBIGUOUS_STDIN);
});

test("stdin: exactly one input read from stdin ('-') is accepted and joins the others -- PROVEN, exit 0", () => {
  const files = baseFiles();
  const result = runSeatProofCli(argsFor(files, { dispatchShow: "-" }), {
    readFileFn: fakeReadFileFn(files),
    stdinText: files["/ds.json"],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "PROVEN");
});

// ---------------------------------------------------------------------------
// (h) fail-closed: 「알 수 없음」을 0으로 내지 않는다.
// ---------------------------------------------------------------------------
test("fail-closed: every non-PROVEN outcome (CLI-level or judge-level) is exit 2, never exit 0", () => {
  const files = baseFiles();
  const scenarios = [
    runSeatProofCli([], { readFileFn: fakeReadFileFn(files) }),
    runSeatProofCli(argsFor(files, { dispatchShow: "/missing.json" }), {
      readFileFn: fakeReadFileFn(files),
    }),
    runSeatProofCli(
      argsFor(files, {
        expected: "/expected.json",
      }),
      {
        readFileFn: fakeReadFileFn({
          ...files,
          "/expected.json": "not json",
        }),
      },
    ),
  ];
  for (const s of scenarios) {
    assert.notEqual(s.exitCode, 0);
    assert.equal(s.exitCode, 2);
  }
});
