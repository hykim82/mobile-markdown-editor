import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseDispatchReceiptArgs,
  resolveDispatchTimestamp,
  extractDispatchEnvelope,
  buildReceiptRecord,
  appendReceiptLine,
  runDispatchReceiptCli,
  formatDispatchReceiptResult,
} from "./dispatch-receipt-cli.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(THIS_DIR, "dispatch-receipt-cli.mjs");

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function validResponse(overrides = {}) {
  return JSON.stringify({
    ok: true,
    result: {
      dispatch: {
        id: "ctx_1",
        task_id: "task_1",
        assignee_pane_key: "pane:1",
        dispatched_at: "2026-08-10 21:01:00",
        ...overrides,
      },
    },
  });
}

// --- parseDispatchReceiptArgs -----------------------------------------------

test("parseDispatchReceiptArgs: requires role, task-label, and a receipt path", () => {
  assert.equal(parseDispatchReceiptArgs([]).ok, false);
  assert.equal(
    parseDispatchReceiptArgs(["--role", "CODER", "--task-label", "HYK-1"]).ok,
    false,
  );
  const ok = parseDispatchReceiptArgs([
    "--role",
    "CODER",
    "--task-label",
    "HYK-1",
    "--receipt-path",
    "/x/receipts.jsonl",
  ]);
  assert.deepEqual(ok, {
    ok: true,
    role: "CODER",
    harnessTaskLabel: "HYK-1",
    receiptPath: "/x/receipts.jsonl",
  });
});

test("parseDispatchReceiptArgs: falls back to env DISPATCH_RECEIPT_PATH when --receipt-path is omitted", () => {
  const r = parseDispatchReceiptArgs(
    ["--role", "CODER", "--task-label", "HYK-1"],
    { DISPATCH_RECEIPT_PATH: "/env/receipts.jsonl" },
  );
  assert.equal(r.ok, true);
  assert.equal(r.receiptPath, "/env/receipts.jsonl");
});

test("parseDispatchReceiptArgs: --receipt-path flag wins over env", () => {
  const r = parseDispatchReceiptArgs(
    [
      "--role",
      "CODER",
      "--task-label",
      "HYK-1",
      "--receipt-path",
      "/flag.jsonl",
    ],
    { DISPATCH_RECEIPT_PATH: "/env.jsonl" },
  );
  assert.equal(r.receiptPath, "/flag.jsonl");
});

test("parseDispatchReceiptArgs: rejects unrecognized flags and '='-syntax", () => {
  assert.equal(parseDispatchReceiptArgs(["--bogus", "x"]).ok, false);
  assert.equal(parseDispatchReceiptArgs(["--role=CODER"]).ok, false);
});

test("parseDispatchReceiptArgs: --help short-circuits without requiring other flags", () => {
  assert.deepEqual(parseDispatchReceiptArgs(["--help"]), {
    ok: true,
    help: true,
  });
});

// --- resolveDispatchTimestamp -----------------------------------------------

test("resolveDispatchTimestamp: prefers dispatched_at, then created_at, over fallback", () => {
  assert.deepEqual(
    resolveDispatchTimestamp({ dispatched_at: "A", created_at: "B" }),
    { dispatchTimestamp: "A", timestampSource: "response.dispatched_at" },
  );
  assert.deepEqual(resolveDispatchTimestamp({ created_at: "B" }), {
    dispatchTimestamp: "B",
    timestampSource: "response.created_at",
  });
});

test("resolveDispatchTimestamp: falls back to a live wall-clock read, never a guessed/backdated value", () => {
  const fixedNow = new Date("2026-08-10T00:00:00.000Z");
  const r = resolveDispatchTimestamp({}, () => fixedNow);
  assert.equal(r.timestampSource, "fallback_wallclock");
  assert.equal(r.dispatchTimestamp, fixedNow.toISOString());
});

// --- extractDispatchEnvelope: loud failure on any missing required field ---

test("extractDispatchEnvelope: invalid JSON -> ok:false", () => {
  const r = extractDispatchEnvelope("not json");
  assert.equal(r.ok, false);
  assert.match(r.reason, /not valid JSON/);
});

test("extractDispatchEnvelope: missing result.dispatch -> ok:false", () => {
  const r = extractDispatchEnvelope(JSON.stringify({ ok: true, result: {} }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no result\.dispatch/);
});

for (const field of ["id", "task_id", "assignee_pane_key"]) {
  test(`extractDispatchEnvelope: missing '${field}' -> ok:false, no partial fields returned`, () => {
    const dispatch = {
      id: "ctx_1",
      task_id: "task_1",
      assignee_pane_key: "pane:1",
    };
    delete dispatch[field];
    const r = extractDispatchEnvelope(
      JSON.stringify({ ok: true, result: { dispatch } }),
    );
    assert.equal(r.ok, false);
    assert.match(r.reason, new RegExp(field));
    assert.equal(r.runtimeTaskId, undefined);
    assert.equal(r.dispatchId, undefined);
    assert.equal(r.assigneePaneKey, undefined);
  });
}

test("extractDispatchEnvelope: empty-string field counts as missing", () => {
  const r = extractDispatchEnvelope(
    JSON.stringify({
      ok: true,
      result: {
        dispatch: { id: "", task_id: "task_1", assignee_pane_key: "pane:1" },
      },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /id/);
});

test("extractDispatchEnvelope: strips a leading UTF-8 BOM before parsing (PowerShell pipeline emits one)", () => {
  const r = extractDispatchEnvelope("﻿" + validResponse());
  assert.equal(r.ok, true);
  assert.equal(r.runtimeTaskId, "task_1");
});

test("extractDispatchEnvelope: all 3 required fields present -> ok:true with timestamp resolved", () => {
  const r = extractDispatchEnvelope(validResponse());
  assert.equal(r.ok, true);
  assert.equal(r.runtimeTaskId, "task_1");
  assert.equal(r.dispatchId, "ctx_1");
  assert.equal(r.assigneePaneKey, "pane:1");
  assert.equal(r.dispatchTimestamp, "2026-08-10 21:01:00");
  assert.equal(r.timestampSource, "response.dispatched_at");
});

// --- buildReceiptRecord / appendReceiptLine ---------------------------------

test("buildReceiptRecord: carries all 6 required fields", () => {
  const envelope = extractDispatchEnvelope(validResponse());
  const record = buildReceiptRecord({
    envelope,
    role: "CODER",
    harnessTaskLabel: "HYK-219-receipts-1",
    nowFn: () => new Date("2026-08-10T21:05:00.000Z"),
  });
  assert.deepEqual(record, {
    recorded_at: "2026-08-10T21:05:00.000Z",
    runtime_task_id: "task_1",
    dispatch_id: "ctx_1",
    assignee_pane_key: "pane:1",
    dispatch_timestamp_utc: "2026-08-10 21:01:00",
    dispatch_timestamp_source: "response.dispatched_at",
    role: "CODER",
    harness_task_label: "HYK-219-receipts-1",
  });
});

test("buildReceiptRecord: dispatch_timestamp_utc field name self-documents the unit (§3-ⓑ, no silent reformat of the vendor string)", () => {
  const record = buildReceiptRecord({
    envelope: {
      runtimeTaskId: "task_1",
      dispatchId: "ctx_1",
      assigneePaneKey: "pane:1",
      dispatchTimestamp: "2026-08-10 21:22:01",
      timestampSource: "response.dispatched_at",
    },
    role: "REVIEW",
    harnessTaskLabel: "HYK-219-receipts-2",
  });
  assert.equal(record.dispatch_timestamp_utc, "2026-08-10 21:22:01");
  assert.equal(record.dispatch_timestamp, undefined);
});

test("appendReceiptLine: appends a line and never rewrites prior content (DI'd fs)", () => {
  let written = "";
  const appendFn = (p, text) => {
    written += text;
  };
  const mkdirFn = () => {};
  const r1 = appendReceiptLine({
    receiptPath: "/x/receipts.jsonl",
    record: { a: 1 },
    appendFn,
    mkdirFn,
  });
  assert.equal(r1.ok, true);
  const r2 = appendReceiptLine({
    receiptPath: "/x/receipts.jsonl",
    record: { a: 2 },
    appendFn,
    mkdirFn,
  });
  assert.equal(r2.ok, true);
  const lines = written.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
  assert.deepEqual(JSON.parse(lines[1]), { a: 2 });
});

test("appendReceiptLine: write failure -> ok:false with a human-readable reason", () => {
  const r = appendReceiptLine({
    receiptPath: "/x/receipts.jsonl",
    record: { a: 1 },
    appendFn: () => {
      throw new Error("disk full");
    },
    mkdirFn: () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /disk full/);
});

// --- runDispatchReceiptCli: end-to-end with real temp-dir fs ---------------

test("runDispatchReceiptCli: good response + args -> file gets exactly 1 line with the 6 fields as real values", () => {
  withTempDir("hyk219-receipt-", (dir) => {
    const receiptPath = join(dir, "receipts.jsonl");
    const result = runDispatchReceiptCli(
      [
        "--role",
        "CODER",
        "--task-label",
        "HYK-219-receipts-1",
        "--receipt-path",
        receiptPath,
      ],
      {
        stdinText: validResponse(),
        nowFn: () => new Date("2026-08-10T21:05:00.000Z"),
      },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const lines = readFileSync(receiptPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.runtime_task_id, "task_1");
    assert.equal(record.dispatch_id, "ctx_1");
    assert.equal(record.assignee_pane_key, "pane:1");
    assert.equal(record.dispatch_timestamp_utc, "2026-08-10 21:01:00");
    assert.equal(record.role, "CODER");
    assert.equal(record.harness_task_label, "HYK-219-receipts-1");
  });
});

test("runDispatchReceiptCli: creates the receipt file's parent directory if missing", () => {
  withTempDir("hyk219-receipt-", (dir) => {
    const receiptPath = join(dir, "nested", "sub", "receipts.jsonl");
    const result = runDispatchReceiptCli(
      [
        "--role",
        "CODER",
        "--task-label",
        "HYK-219-receipts-1",
        "--receipt-path",
        receiptPath,
      ],
      { stdinText: validResponse() },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(existsSync(receiptPath), true);
  });
});

test("runDispatchReceiptCli: 2 dispatches -> 2 lines, and the 1st line is byte-identical after the 2nd write (append-only)", () => {
  withTempDir("hyk219-receipt-", (dir) => {
    const receiptPath = join(dir, "receipts.jsonl");
    runDispatchReceiptCli(
      [
        "--role",
        "CODER",
        "--task-label",
        "HYK-219-receipts-1",
        "--receipt-path",
        receiptPath,
      ],
      { stdinText: validResponse({ id: "ctx_1", task_id: "task_1" }) },
    );
    const afterFirst = readFileSync(receiptPath, "utf8");
    assert.equal(afterFirst.trim().split("\n").length, 1);

    runDispatchReceiptCli(
      [
        "--role",
        "CODER",
        "--task-label",
        "HYK-219-receipts-1",
        "--receipt-path",
        receiptPath,
      ],
      { stdinText: validResponse({ id: "ctx_2", task_id: "task_2" }) },
    );
    const afterSecond = readFileSync(receiptPath, "utf8");
    const lines = afterSecond.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(
      lines[0] + "\n",
      afterFirst,
      "1st line must be unchanged by the 2nd write",
    );
    assert.equal(JSON.parse(lines[1]).dispatch_id, "ctx_2");
  });
});

// --- HYK-396 §3: optional --harness-dir wiring (delivery-time dispatch_id stamp) ---

test("runDispatchReceiptCli: no --harness-dir -> stamp is skipped entirely (result.stamp is undefined, old callers unaffected)", () => {
  withTempDir("hyk396-receipt-", (dir) => {
    const receiptPath = join(dir, "receipts.jsonl");
    const result = runDispatchReceiptCli(
      [
        "--role",
        "CODER",
        "--task-label",
        "HYK-396-1",
        "--receipt-path",
        receiptPath,
      ],
      { stdinText: validResponse() },
    );
    assert.equal(result.ok, true);
    assert.equal(result.stamp, undefined);
  });
});

test("runDispatchReceiptCli: --harness-dir given + a matching rounds/CODER-task-r1.md snapshot exists -> stamps the real dispatch_id into it", () => {
  withTempDir("hyk396-receipt-", (dir) => {
    const receiptPath = join(dir, "receipts.jsonl");
    const harnessDir = join(dir, ".harness");
    const roundsDir = join(harnessDir, "rounds");
    mkdirSync(roundsDir, { recursive: true });
    writeFileSync(
      join(roundsDir, "CODER-task-r1.md"),
      "<!-- envelope-archive: role=CODER kind=task dropped_at=2026-08-30 10:00 KST dispatch_id=unknown -->\ntask_id: HYK-396-1\n",
      "utf8",
    );
    const result = runDispatchReceiptCli(
      [
        "--role",
        "CODER",
        "--task-label",
        "HYK-396-1",
        "--receipt-path",
        receiptPath,
        "--harness-dir",
        harnessDir,
      ],
      { stdinText: validResponse({ id: "ctx_stamped" }) },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.stamp.ok, true);
    const stamped = readFileSync(join(roundsDir, "CODER-task-r1.md"), "utf8");
    assert.match(stamped, /dispatch_id=ctx_stamped/);
  });
});

test("runDispatchReceiptCli: --harness-dir given but no snapshot exists -> receipt append still succeeds (stamp failure is best-effort, non-fatal)", () => {
  withTempDir("hyk396-receipt-", (dir) => {
    const receiptPath = join(dir, "receipts.jsonl");
    const harnessDir = join(dir, ".harness");
    const result = runDispatchReceiptCli(
      [
        "--role",
        "CODER",
        "--task-label",
        "HYK-396-1",
        "--receipt-path",
        receiptPath,
        "--harness-dir",
        harnessDir,
      ],
      { stdinText: validResponse() },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.stamp.ok, false);
    assert.equal(existsSync(receiptPath), true);
  });
});

test("runDispatchReceiptCli: missing response field -> ok:false, 0 lines written (no partial record)", () => {
  withTempDir("hyk219-receipt-", (dir) => {
    const receiptPath = join(dir, "receipts.jsonl");
    const result = runDispatchReceiptCli(
      [
        "--role",
        "CODER",
        "--task-label",
        "HYK-219-receipts-1",
        "--receipt-path",
        receiptPath,
      ],
      {
        stdinText: JSON.stringify({
          ok: true,
          result: { dispatch: { id: "ctx_1", task_id: "task_1" } },
        }),
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /assignee_pane_key/);
    assert.equal(existsSync(receiptPath), false);
  });
});

test("runDispatchReceiptCli: bad args -> ok:false before touching the filesystem", () => {
  const result = runDispatchReceiptCli([], { stdinText: validResponse() });
  assert.equal(result.ok, false);
});

// --- formatDispatchReceiptResult --------------------------------------------

test("formatDispatchReceiptResult: renders a human-readable line for ok:true and ok:false", () => {
  const ok = formatDispatchReceiptResult({
    ok: true,
    record: {
      dispatch_id: "ctx_1",
      runtime_task_id: "task_1",
      assignee_pane_key: "pane:1",
      role: "CODER",
      harness_task_label: "HYK-1",
      dispatch_timestamp_utc: "2026-08-10 21:01:00",
      dispatch_timestamp_source: "response.dispatched_at",
    },
  });
  assert.match(ok, /^RECORDED /);
  assert.match(ok, /dispatch_id=ctx_1/);
  assert.match(ok, /timestamp_utc=2026-08-10 21:01:00/);

  const failed = formatDispatchReceiptResult({ ok: false, reason: "boom" });
  assert.equal(failed, "FAILED reason=boom");
});

// ---------------------------------------------------------------------------
// direct-entry: real child process, stdin piped, no orca spawned anywhere in
// this file (static + behavioral -- this CLI has zero orca exec calls).
// ---------------------------------------------------------------------------

function runCliChildProcess(args, { stdinText = "" } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      input: stdinText,
    });
    return { status: 0, stdout };
  } catch (err) {
    return {
      status: typeof err.status === "number" ? err.status : 1,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
    };
  }
}

test("direct-entry: --help prints usage and exits 0 without reading stdin", () => {
  const result = runCliChildProcess(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^usage: dispatch-receipt-cli\.mjs/);
});

test("direct-entry: good response via stdin -> RECORDED line, exit 0, and the receipt file has 1 real line", () => {
  withTempDir("hyk219-receipt-child-", (dir) => {
    const receiptPath = join(dir, "receipts.jsonl");
    const result = runCliChildProcess(
      [
        "--role",
        "CODER",
        "--task-label",
        "HYK-219-receipts-1",
        "--receipt-path",
        receiptPath,
      ],
      { stdinText: validResponse() },
    );
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout.trim(), /^RECORDED /);
    const record = JSON.parse(readFileSync(receiptPath, "utf8").trim());
    assert.equal(record.runtime_task_id, "task_1");
    assert.equal(record.dispatch_id, "ctx_1");
    assert.equal(record.assignee_pane_key, "pane:1");
  });
});

test("direct-entry: missing field via stdin -> FAILED line on stdout, exit 1, no file written", () => {
  withTempDir("hyk219-receipt-child-", (dir) => {
    const receiptPath = join(dir, "receipts.jsonl");
    const result = runCliChildProcess(
      [
        "--role",
        "CODER",
        "--task-label",
        "HYK-219-receipts-1",
        "--receipt-path",
        receiptPath,
      ],
      {
        stdinText: JSON.stringify({
          ok: true,
          result: { dispatch: { id: "ctx_1", task_id: "task_1" } },
        }),
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout.trim(), /^FAILED reason=.*assignee_pane_key/);
    assert.equal(existsSync(receiptPath), false);
  });
});

test("direct-entry: missing args -> FAILED usage, exit 1 (no stdin needed)", () => {
  const result = runCliChildProcess([]);
  assert.equal(result.status, 1);
  assert.match(result.stdout.trim(), /^FAILED reason=missing required field/);
});

// ---------------------------------------------------------------------------
// static: G9 -- this CLI spawns `orca` zero times (it only ever reads an
// already-obtained response from stdin).
// ---------------------------------------------------------------------------
test("static: production CLI source has zero orca exec calls", () => {
  const src = readFileSync(CLI_PATH, "utf8");
  assert.equal(
    /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(\s*["'`]orca["'`]/.test(
      src,
    ),
    false,
  );
});
