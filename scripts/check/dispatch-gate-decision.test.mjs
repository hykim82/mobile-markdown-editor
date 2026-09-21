import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeLedger } from "./reject-streak.mjs";
import {
  lookupDispatchId,
  DISPATCH_RECEIPT_LOOKUP_REASON,
} from "./dispatch-gate-decision.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./dispatch-gate-decision.mjs", import.meta.url),
);

// HYK-241 §2 조각2: every ALLOW-expected fixture below now also needs a
// 1-B declaration (checked LAST, after both gates + chain -- see
// dispatch-gate-decision.mjs's own comment at the call site) or the new
// axis alone would flip these fixtures to REJECT. REJECT-expected fixtures
// (task_id/ledger precondition failures, gate/chain BLOCKs) are unaffected
// -- they already short-circuit or already REJECT before/regardless of
// this axis, so they are left untouched.
const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-decision-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// HYK-342 4R §1: this file predates the receipt-evidence axis entirely --
// none of its fixtures ever create a sibling result file, so every case
// here is the "missing result file" bootstrap path. Since 4R distinguishes
// "receipt confirmed absent" from "receipt can't be confirmed at all"
// (UNSET path/env -> REJECT), every ALLOW-expected fixture below now needs
// a readable, confirmably-empty receipt to keep meaning "genuine first
// delivery" rather than accidentally exercising the new UNSET/REJECT case.
// A single shared empty receipts file (module-scoped, never written to)
// covers this for the whole file without touching each of the ~35 call
// sites individually.
const SHARED_EMPTY_RECEIPT_PATH = join(
  mkdtempSync(join(tmpdir(), "dispatch-gate-decision-test-receipts-")),
  "dispatch-receipts.jsonl",
);
writeFileSync(SHARED_EMPTY_RECEIPT_PATH, "", "utf8");

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, DISPATCH_RECEIPT_PATH: SHARED_EMPTY_RECEIPT_PATH },
      ...opts,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// ---------------------------------------------------------------------------
// (1) normal state, no streak history -> ALLOW, exit 0 (no false positive)
// ---------------------------------------------------------------------------
test("(1) streak 0 (empty but present ledger), fresh task file -> ALLOW, exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9001-fresh-1\nsome body\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    // 2R §2: an empty-but-PRESENT ledger (no issue entries yet) is the
    // normal "no rejections yet" state and must ALLOW -- distinct from a
    // MISSING ledger file, which 2R's stricter precondition now rejects
    // (see the "ledger file absent" test below).
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(2) streak 1 (below envelope threshold) -> ALLOW, exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9002-streak1-1\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9002": {
          streak: 1,
          history: [
            { task_id: "HYK-9002-coder-1", verdict: "rejected", at: "x" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(3) streak 2 with a complete envelope -> ALLOW, exit 0", () => {
  withFixtureDir((dir) => {
    const envelope = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "ORCH 조치:",
      "- 모델 변경: sonnet -> opus 승격",
      "-->",
    ].join("\n");
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9003-streak2-1\n${envelope}\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9003": {
          streak: 2,
          history: [
            { task_id: "HYK-9003-coder-1", verdict: "rejected", at: "x" },
            { task_id: "HYK-9003-coder-2", verdict: "rejected", at: "y" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

// N=3 normal-state samples above (fresh/streak-1/streak-2-with-envelope),
// each independently ALLOW -- 0/3 false positives (coder-task §3-1).

// ---------------------------------------------------------------------------
// real incident reproduction: gate BLOCK -> CLI must reject, machine-enforced
// ---------------------------------------------------------------------------
test("(4) streak 2, NO envelope -> reject-streak gate BLOCKs -> CLI REJECT, exit 1", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-9004-streak2-noenv-1\nno envelope here\n",
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9004": {
          streak: 2,
          history: [
            { task_id: "HYK-9004-coder-1", verdict: "rejected", at: "x" },
            { task_id: "HYK-9004-coder-2", verdict: "rejected", at: "y" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REJECT_BLOCKED|BLOCK\(exit 2\)/);
    assert.match(r.stderr, /REJECT --/);
  });
});

test("(5) streak 4 (hard-stop), ordinary envelope but no diagnostic evidence pointer -> diagnostic-gate BLOCKs -> CLI REJECT", () => {
  withFixtureDir((dir) => {
    const envelope = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "ORCH 조치:",
      "- 모델 변경: sonnet -> opus 승격",
      "-->",
    ].join("\n");
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9005-hardstop-1\n${envelope}\n`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9005": {
          streak: 4,
          history: [
            { task_id: "HYK-9005-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9005-coder-2", verdict: "rejected", at: "b" },
            { task_id: "HYK-9005-coder-3", verdict: "rejected", at: "c" },
            { task_id: "HYK-9005-coder-4", verdict: "rejected", at: "d" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /diagnostic-gate/);
    assert.match(r.stderr, /REJECT --/);
  });
});

// ---------------------------------------------------------------------------
// operational error -- exit 1 never folds to a silent ALLOW
// ---------------------------------------------------------------------------
test("(6) task file missing -> REJECT_OPERATIONAL_ERROR, exit 1, reason visible", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "does-not-exist.md");
    const r = runCli([taskPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /운영 오류/);
    assert.match(r.stderr, /task file not found/);
    assert.match(r.stderr, /REJECT --/);
  });
});

test("(7) no task-path argument at all -> usage error, exit 1 (not a silent allow)", () => {
  const r = runCli([]);
  assert.equal(r.status, 1);
});

// ---------------------------------------------------------------------------
// 1R/2R/3R §2 P1-B: fail-closed precondition check -- reject-streak.mjs
// itself treats these inputs as UNJUDGABLE/fail-open, or silently folds them
// (reviewer's live demonstrations across 1R/2R). The gates must NEVER even
// be spawned for these -- each must produce a DISTINCT reason string and
// none may be confused with REJECT_BLOCKED/REJECT_OPERATIONAL_ERROR.
// ---------------------------------------------------------------------------
test("(8) P1-B task_id header entirely absent -> REJECT_TASK_ID_NOT_UNIQUE, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "no task_id line here at all\nbody text\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /task_id 줄이 정확히 1개가 아님\(실제 0개\)/);
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("(반례6) 3R: task_id 줄이 2개(앞=기록없음/뒤=streak 2) -> REJECT_TASK_ID_NOT_UNIQUE, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // Exactly the reviewer's 2R-followup shape: two task_id lines, an
    // unresolvable one first and a resolvable one second -- reject-streak.mjs's
    // own non-global regex would use the FIRST match and silently ignore the
    // second line's real streak.
    writeFileSync(
      taskPath,
      "task_id: HYK-0000-nonexistent-1\ntask_id: HYK-9020-dup-1\nbody\n",
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9020": {
          streak: 2,
          history: [
            { task_id: "HYK-9020-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9020-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /task_id 줄이 정확히 1개가 아님\(실제 2개\)/);
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("(반례7) 3R: 원장 항목의 streak: null -> REJECT_LEDGER_ENTRY_MALFORMED, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9021-nullstreak-1\nbody\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    // Written directly (not via writeLedger+applyOutcome, which would never
    // produce a null streak) -- simulates on-disk corruption of a
    // previously-valid entry.
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 1,
        issues: { "HYK-9021": { streak: null, history: [] } },
      }),
      "utf8",
    );
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /해석 가능한 형태가 아님/);
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("(반례7-b) 3R: 원장 항목의 history가 배열이 아님 -> REJECT_LEDGER_ENTRY_MALFORMED, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9022-badhistory-1\nbody\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 1,
        issues: {
          "HYK-9022": { streak: 1, history: "not-an-array" },
        },
      }),
      "utf8",
    );
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /해석 가능한 형태가 아님/);
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("(반례8) 4R §2 검토 실측 -- 원장 항목의 streak: 1.5(소수) -> REJECT_LEDGER_ENTRY_MALFORMED, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9023-fractional-1\nbody\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 1,
        issues: { "HYK-9023": { streak: 1.5, history: [] } },
      }),
      "utf8",
    );
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /해석 가능한 형태가 아님/);
    assert.match(r.stderr, /정수/);
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("(9) P1-B ⓑ task_id present but not HYK-<digits> -> REJECT_TASK_ID_MALFORMED, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: NOT-AN-ISSUE-ID\nbody\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /HYK-<digits>.*형식으로 해석되지 않음|형식으로 해석되지 않음/,
    );
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("(10) P1-B ⓒ ledger file absent -> REJECT_LEDGER_MISSING, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9006-noledger-1\nbody\n", "utf8");
    const ledgerPath = join(dir, "does-not-exist-reject-streak.json");
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /원장 파일이 존재하지 않음/);
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("(11) P1-B ⓓ ledger present but corrupt (malformed JSON) -> REJECT_LEDGER_CORRUPT, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9007-corrupt-1\nbody\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(ledgerPath, "{ not valid json ][", "utf8");
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /원장을 읽거나 파싱할 수 없음/);
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("P1-B all six precondition-reject shapes produce MUTUALLY DISTINCT reason strings", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const missingIdPath = join(dir, "a.md");
    writeFileSync(missingIdPath, "no id\n", "utf8");
    const dupIdPath = join(dir, "a2.md");
    writeFileSync(
      dupIdPath,
      "task_id: HYK-9030-a\ntask_id: HYK-9030-b\n",
      "utf8",
    );
    const malformedIdPath = join(dir, "b.md");
    writeFileSync(malformedIdPath, "task_id: NOT-HYK\n", "utf8");
    const okPath = join(dir, "c.md");
    writeFileSync(okPath, "task_id: HYK-9008-x-1\n", "utf8");
    const noLedgerPath = join(dir, "missing-ledger.json");
    const corruptLedgerPath = join(dir, "corrupt.json");
    writeFileSync(corruptLedgerPath, "not json", "utf8");
    const nullStreakOkPath = join(dir, "d.md");
    writeFileSync(nullStreakOkPath, "task_id: HYK-9031-x-1\n", "utf8");
    const nullStreakLedgerPath = join(dir, "nullstreak.json");
    writeFileSync(
      nullStreakLedgerPath,
      JSON.stringify({
        schema_version: 1,
        issues: { "HYK-9031": { streak: null, history: [] } },
      }),
      "utf8",
    );

    const missing = runCli([missingIdPath, "--ledger", ledgerPath]).stderr;
    const dup = runCli([dupIdPath, "--ledger", ledgerPath]).stderr;
    const malformed = runCli([malformedIdPath, "--ledger", ledgerPath]).stderr;
    const noLedger = runCli([okPath, "--ledger", noLedgerPath]).stderr;
    const corrupt = runCli([okPath, "--ledger", corruptLedgerPath]).stderr;
    const badEntry = runCli([
      nullStreakOkPath,
      "--ledger",
      nullStreakLedgerPath,
    ]).stderr;
    // missing/dup share the SAME state (REJECT_TASK_ID_NOT_UNIQUE, "not
    // exactly one") but still produce DIFFERENT first-line text (count 0
    // vs count 2) -- verified separately below.
    assert.notEqual(
      missing.split("\n")[0],
      dup.split("\n")[0],
      "missing (count 0) and duplicate (count 2) task_id must not collapse to the same reason text",
    );
    const reasons = [missing, dup, malformed, noLedger, corrupt, badEntry];
    const uniqueFirstLines = new Set(reasons.map((r) => r.split("\n")[0]));
    assert.equal(
      uniqueFirstLines.size,
      6,
      "each of the six precondition-reject shapes must produce a distinguishable first reason line",
    );
  });
});

// ---------------------------------------------------------------------------
// 2R §4 지적2: expanded control samples the reviewer named by name --
// each is either a normal-ALLOW sample (counted toward N below) or a
// reject-expected sample (counted separately, never mixed into the
// false-positive denominator).
// ---------------------------------------------------------------------------
test("(12) normal: streak 3, complete general envelope -> ALLOW (below hard-stop, diagnostic not required)", () => {
  withFixtureDir((dir) => {
    const envelope = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "ORCH 조치:",
      "- 모델 변경: sonnet -> opus 승격",
      "-->",
    ].join("\n");
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9009-streak3-1\n${envelope}\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9009": {
          streak: 3,
          history: [
            { task_id: "HYK-9009-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9009-coder-2", verdict: "rejected", at: "b" },
            { task_id: "HYK-9009-coder-3", verdict: "rejected", at: "c" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(13) normal: streak 4 (hard-stop), complete DIAGNOSTIC envelope (incl. 재현 증거 포인터) -> ALLOW", () => {
  withFixtureDir((dir) => {
    const envelope = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "재현 증거 포인터: review-3.md L12-L40 (동일 mutation 3회 재현)",
      "ORCH 조치:",
      "- 모델 변경: sonnet -> opus 승격",
      "-->",
    ].join("\n");
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9010-hardstop-1\n${envelope}\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9010": {
          streak: 4,
          history: [
            { task_id: "HYK-9010-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9010-coder-2", verdict: "rejected", at: "b" },
            { task_id: "HYK-9010-coder-3", verdict: "rejected", at: "c" },
            { task_id: "HYK-9010-coder-4", verdict: "rejected", at: "d" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(14) normal: CRLF-terminated task file (fresh, streak 0) -> ALLOW (precondition regex tolerates CRLF)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9011-crlf-1\r\nbody line\r\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

// HYK-220 2R: rewritten for the git-common-dir-based default resolution
// (1R/2R §2 근거 B fix) -- the CWD-independence guarantee this test asserts
// is now provided by git identity, not by "resolve next to the task file"
// string logic, so both `dir` and the decoy `elsewhereDir` must themselves
// be real git repos (`resolveRepoRoot` needs an actual repo to identify;
// a plain non-git tmpdir now fail-closes with REJECT_LEDGER_PATH_UNRESOLVABLE
// instead of silently degrading to dirname-based lookup -- see test (17)).
test("(15) 2R: no --ledger given, invoking CWD is a DIFFERENT (also real) git repo than the task file's repo -- ledger still resolves from the task file's OWN repo, not from CWD's repo", () => {
  withFixtureDir((dir) => {
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    const harnessDir = join(dir, ".harness");
    mkdirSync(harnessDir);
    const taskPath = join(harnessDir, "coder-task.md");
    const envelope = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "ORCH 조치:",
      "- 모델 변경: sonnet -> opus 승격",
      "-->",
    ].join("\n");
    writeFileSync(
      taskPath,
      `task_id: HYK-9012-cwd-1\n${envelope}\n${ONE_B_BLOCK}`,
      "utf8",
    );
    // The task file's OWN repo ledger says streak=2 WITH an envelope
    // present -> should ALLOW. A DIFFERENT ledger, in a DIFFERENT real git
    // repo (the invoking CWD), says streak=4 (hard-stop, needs a
    // DIAGNOSTIC envelope this task file doesn't carry) -- if the CLI ever
    // resolves the ledger from CWD's repo instead of the task file's own
    // repo, this decoy would be consulted instead and the run would REJECT
    // (diagnostic-gate BLOCK) instead of ALLOW.
    writeLedger(join(harnessDir, "reject-streak.json"), {
      schema_version: 1,
      issues: {
        "HYK-9012": {
          streak: 2,
          history: [
            { task_id: "HYK-9012-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9012-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    const elsewhereDir = mkdtempSync(join(tmpdir(), "elsewhere-cwd-"));
    try {
      execFileSync("git", ["init", "-q", elsewhereDir]);
      execFileSync("git", [
        "-C",
        elsewhereDir,
        "config",
        "user.email",
        "t@t.com",
      ]);
      execFileSync("git", ["-C", elsewhereDir, "config", "user.name", "t"]);
      const elsewhereHarness = join(elsewhereDir, ".harness");
      mkdirSync(elsewhereHarness);
      writeLedger(join(elsewhereHarness, "reject-streak.json"), {
        schema_version: 1,
        issues: {
          "HYK-9012": {
            streak: 4,
            history: [
              { task_id: "HYK-9012-wrong-1", verdict: "rejected", at: "a" },
              { task_id: "HYK-9012-wrong-2", verdict: "rejected", at: "b" },
              { task_id: "HYK-9012-wrong-3", verdict: "rejected", at: "c" },
              { task_id: "HYK-9012-wrong-4", verdict: "rejected", at: "d" },
            ],
          },
        },
      });
      // no --ledger flag at all; cwd is elsewhereDir's repo, a DIFFERENT
      // repo than taskPath's own
      const r = runCli([taskPath], { cwd: elsewhereDir });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /ALLOW/);
    } finally {
      rmSync(elsewhereDir, { recursive: true, force: true });
    }
  });
});

test("(16) 4R §3 TOCTOU -- ledger mutated to streak=0 in the window between the precondition read and gate execution -> still REJECTs (snapshot isolates the gates from the live file)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-9600-toctou-1\nno envelope here\n",
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9600": {
          streak: 2,
          history: [
            { task_id: "HYK-9600-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9600-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    // Mirrors the reviewer's own NODE_OPTIONS technique: a --require hook
    // fires at the start of EVERY node process this run launches (this
    // CLI's own process = invocation #1, then the gate/diagnostic-gate
    // subprocesses = #2/#3). Invocation #1 is left alone (the CLI must be
    // allowed to read the real streak=2 ledger first); from invocation #2
    // onward the hook rewrites the LIVE ledger file (never whatever
    // snapshot path the CLI decided to pass down) to streak=0 BEFORE that
    // process's own code runs -- simulating an external actor changing the
    // ledger in the exact window between confirmation and gate execution.
    const counterPath = join(dir, "toctou-counter.txt");
    const mutatorPath = join(dir, "toctou-mutator.cjs");
    writeFileSync(
      mutatorPath,
      [
        "const fs = require('fs');",
        `const counterPath = ${JSON.stringify(counterPath)};`,
        `const liveLedgerPath = ${JSON.stringify(ledgerPath)};`,
        "let count = 0;",
        "try { count = Number(fs.readFileSync(counterPath, 'utf8')); } catch {}",
        "count += 1;",
        "fs.writeFileSync(counterPath, String(count), 'utf8');",
        "if (count >= 2) {",
        "  const ledger = JSON.parse(fs.readFileSync(liveLedgerPath, 'utf8'));",
        "  ledger.issues['HYK-9600'] = { streak: 0, history: [] };",
        "  fs.writeFileSync(liveLedgerPath, JSON.stringify(ledger, null, 2), 'utf8');",
        "}",
      ].join("\n"),
      "utf8",
    );
    const r = runCli([taskPath, "--ledger", ledgerPath], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${mutatorPath}`,
      },
    });
    assert.equal(
      r.status,
      1,
      "gate must still reject using the CONFIRMED streak=2, not the mid-flight-mutated streak=0",
    );
    assert.match(r.stderr, /BLOCK\(exit 2\)|streak=2/);
    // The live file WAS mutated (proves the attack scenario actually fired,
    // not that the mutator silently no-op'd).
    const liveLedgerAfter = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(liveLedgerAfter.issues["HYK-9600"].streak, 0);
  });
});

// N=7 normal-state samples total across this file (fresh/streak-1/streak-2-
// envelope/streak-3-envelope/streak-4-diagnostic-envelope/CRLF/no-ledger-
// arg-CWD-independence), each independently ALLOW -- 0/7 false positives.
// Reject-expected samples (streak-2-no-envelope, streak-4-no-diagnostic,
// task-id-missing, task-id-malformed, ledger-missing, ledger-corrupt,
// file-missing, no-argument = 8 total) are counted separately and never
// folded into the N=7 false-positive denominator (2R §4 지적2 요구).

// ---------------------------------------------------------------------------
// HYK-220 2R §2: the six mandatory scenarios the 1R review named by number.
// All six build REAL git repos/worktrees under tmpdir (never touch this
// repo's own .git) -- resolveLedgerPath's new default path is git-identity
// based, so a fixture that wants to exercise it honestly needs a real repo.
// ---------------------------------------------------------------------------

function initGitRepo(dir) {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
}

function commitAll(dir, message) {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message]);
}

test("(17) §2-1 정상 링크드 워크트리 -- 메인 정본 원장으로 수렴 (streak 0, fresh) -> ALLOW", () => {
  withFixtureDir((dir) => {
    const mainDir = join(dir, "main");
    mkdirSync(mainDir);
    initGitRepo(mainDir);
    mkdirSync(join(mainDir, ".harness"));
    writeFileSync(join(mainDir, "README.md"), "x\n", "utf8");
    writeLedger(join(mainDir, ".harness", "reject-streak.json"), {
      schema_version: 1,
      issues: {},
    });
    commitAll(mainDir, "init");
    const wtDir = join(dir, "wt1");
    execFileSync("git", [
      "-C",
      mainDir,
      "worktree",
      "add",
      "-q",
      "--detach",
      wtDir,
      "HEAD",
    ]);
    // wtDir already checked out .harness/ from HEAD (git worktree add
    // materializes the working tree) -- no mkdir needed.
    const taskPath = join(wtDir, ".harness", "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9100-fresh-1\nbody\n${ONE_B_BLOCK}`,
      "utf8",
    );
    // wt1 has NO local reject-streak.json at all -- must still ALLOW by
    // converging on main's ledger.
    const r = runCli([taskPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(18) §2-2 ★핵심★ 로컬 원장 streak 리셋 우회가 닫힘 -- 링크드 워크트리에 streak=0 빈 원장을 심어도 정본 streak=2(봉투 없음)를 읽어 REJECT", () => {
  withFixtureDir((dir) => {
    const mainDir = join(dir, "main");
    mkdirSync(mainDir);
    initGitRepo(mainDir);
    mkdirSync(join(mainDir, ".harness"));
    writeFileSync(join(mainDir, "README.md"), "x\n", "utf8");
    writeLedger(join(mainDir, ".harness", "reject-streak.json"), {
      schema_version: 1,
      issues: {
        "HYK-9101": {
          streak: 2,
          history: [
            { task_id: "HYK-9101-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9101-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    commitAll(mainDir, "init");
    const wtDir = join(dir, "wt-bypass-attempt");
    execFileSync("git", [
      "-C",
      mainDir,
      "worktree",
      "add",
      "-q",
      "--detach",
      wtDir,
      "HEAD",
    ]);
    // wtDir already checked out .harness/ (with main's real streak=2
    // ledger) from HEAD -- the writeLedger call below deliberately
    // OVERWRITES that checked-out copy with a local streak-reset decoy.
    const taskPath = join(wtDir, ".harness", "coder-task.md");
    // NO envelope -- if the local, freshly-created ledger below were
    // honored, streak would read as 0 (no entry) and this would ALLOW.
    writeFileSync(taskPath, "task_id: HYK-9101-retry-1\nno envelope\n", "utf8");
    writeLedger(join(wtDir, ".harness", "reject-streak.json"), {
      schema_version: 1,
      issues: {},
    });
    const r = runCli([taskPath]);
    assert.equal(
      r.status,
      1,
      "must REJECT using main's real streak=2, not the local streak-0 decoy",
    );
    assert.match(r.stderr, /streak=2/);
    assert.match(r.stderr, /BLOCK\(exit 2\)/);
  });
});

test("(19) §2-3 비-git 경로 + 로컬 원장 -- 1R까지는 ALLOW였다(검토 실측), 2R 이후 REJECT(REJECT_LEDGER_PATH_UNRESOLVABLE)", () => {
  withFixtureDir((dir) => {
    // deliberately NOT a git repo
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9102-nongit-1\nbody\n", "utf8");
    // a local ledger sitting right next to the task file, streak 0 -- 1R's
    // dirname(taskPath) default would have read this and ALLOWed.
    writeLedger(join(dir, "reject-streak.json"), {
      schema_version: 1,
      issues: {},
    });
    const r = runCli([taskPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(
      r.stderr,
      /REJECT_LEDGER_PATH_UNRESOLVABLE|저장소를 식별하지 못함/,
    );
    assert.doesNotMatch(
      r.stderr,
      /원장 파일이 존재하지 않음/,
      "must NOT collapse into the ordinary ledger-missing reason (P1-2)",
    );
  });
});

test("(20) §2-4 P1-1 다른 저장소 taskPath -- --expect-repo-root와 실제 소속 저장소가 다르면 REJECT(REJECT_REPO_MISMATCH)", () => {
  withFixtureDir((dir) => {
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    mkdirSync(repoA);
    mkdirSync(repoB);
    initGitRepo(repoA);
    initGitRepo(repoB);
    mkdirSync(join(repoA, ".harness"));
    mkdirSync(join(repoB, ".harness"));
    writeFileSync(join(repoA, "a.txt"), "x\n", "utf8");
    writeFileSync(join(repoB, "b.txt"), "x\n", "utf8");
    writeLedger(join(repoA, ".harness", "reject-streak.json"), {
      schema_version: 1,
      issues: {},
    });
    commitAll(repoA, "init");
    commitAll(repoB, "init");
    const taskPath = join(repoA, ".harness", "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9103-wrongrepo-1\nbody\n", "utf8");
    // taskPath truly belongs to repoA, but the caller says it expected repoB
    const r = runCli([taskPath, "--expect-repo-root", repoB]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /REJECT_REPO_MISMATCH|기대 저장소.*다름/);
  });
});

test("(21) §2-6 P1-1 후단 -- 명시 --ledger 도 --expect-repo-root 대조를 통과 못 하면 REJECT (이전엔 --ledger가 대조 없이 그대로 우선했다)", () => {
  withFixtureDir((dir) => {
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    mkdirSync(repoA);
    mkdirSync(repoB);
    initGitRepo(repoA);
    initGitRepo(repoB);
    mkdirSync(join(repoA, ".harness"));
    writeFileSync(join(repoA, "a.txt"), "x\n", "utf8");
    writeFileSync(join(repoB, "b.txt"), "x\n", "utf8");
    commitAll(repoA, "init");
    commitAll(repoB, "init");
    const taskPath = join(repoA, ".harness", "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-9104-explicitledger-1\nbody\n",
      "utf8",
    );
    // An explicit --ledger that would ALLOW if honored (empty issues, no
    // rejection history) -- but --expect-repo-root names repoB, which does
    // NOT match taskPath's real repo (repoA), so this must still REJECT.
    const explicitLedgerPath = join(dir, "attacker-controlled-ledger.json");
    writeLedger(explicitLedgerPath, { schema_version: 1, issues: {} });
    const r = runCli([
      taskPath,
      "--ledger",
      explicitLedgerPath,
      "--expect-repo-root",
      repoB,
    ]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /REJECT_REPO_MISMATCH|기대 저장소.*다름/);
  });
});

test("(22) §2-5 bare 경계 -- bare 저장소 기반 링크드 워크트리에서도 원장 경로가 bare 디렉터리 자신 밑으로 올바르게 수렴 (검토 실측: dirname()이 한 단계 더 올라가 틀렸었다)", () => {
  withFixtureDir((dir) => {
    const bareDir = join(dir, "repo.git");
    execFileSync("git", ["init", "-q", "--bare", bareDir]);
    const seedDir = join(dir, "seed");
    execFileSync("git", ["clone", "-q", bareDir, seedDir]);
    execFileSync("git", ["-C", seedDir, "config", "user.email", "t@t.com"]);
    execFileSync("git", ["-C", seedDir, "config", "user.name", "t"]);
    writeFileSync(join(seedDir, "a.txt"), "x\n", "utf8");
    commitAll(seedDir, "init");
    execFileSync("git", ["-C", seedDir, "push", "-q", "origin", "HEAD:master"]);
    const wtDir = join(dir, "wt-bare");
    execFileSync("git", [
      "-C",
      bareDir,
      "worktree",
      "add",
      "-q",
      "--detach",
      wtDir,
      "HEAD",
    ]);
    mkdirSync(join(wtDir, ".harness"));
    const taskPath = join(wtDir, ".harness", "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9105-bare-1\nno envelope\n", "utf8");
    // ★the resolved root for a bare repo is the bare dir ITSELF (no nested
    // .git) -- if resolveLedgerPath still did plain dirname(--git-common-dir)
    // here, it would look one level too high (dir/, not dir/repo.git/) and
    // find no .harness at all there either -- so this ledger placement is
    // the assertion that the bare-aware root math actually took effect: a
    // streak=2/no-envelope entry placed at the CORRECT (bare-dir-rooted)
    // path must be found and must BLOCK. The bare repo dir has no working
    // tree of its own, so its .harness/ must be created explicitly.
    mkdirSync(join(bareDir, ".harness"));
    writeLedger(join(bareDir, ".harness", "reject-streak.json"), {
      schema_version: 1,
      issues: {
        "HYK-9105": {
          streak: 2,
          history: [
            { task_id: "HYK-9105-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9105-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    const r = runCli([taskPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /streak=2/);
    assert.match(r.stderr, /BLOCK\(exit 2\)/);
  });
});

// ---------------------------------------------------------------------------
// HYK-221 축1: `--ledger` given WITHOUT `--expect-repo-root` used to bypass
// git binding entirely (`if (args.ledger && !args.expectRepoRoot) return
// {path: args.ledger, state: null}`) -- an explicit ledger path was trusted
// no matter which repo it actually belonged to. Tests (23)/(24) below are
// the ★positive/negative control★ this task's §5-2 requires: (23) proves
// the SAME-repo case still ALLOWs (no new false positive), (24) proves the
// DIFFERENT-repo case -- which used to silently pass through -- now REJECTs.
// Test (25) is the regression guard for the *other* half of the fix: when
// taskPath is NOT inside any git repo at all (every one of this file's
// tests (1)-(14)/P1-B's plain non-git tmpdir fixtures), the membership
// check must not run at all -- byte-identical to pre-fix behavior, so none
// of those existing fixtures break (HYK-217 gap#97 shape avoided).
// ---------------------------------------------------------------------------

test("(23) HYK-221 축1 양성 대조 -- --ledger가 taskPath와 같은 저장소에 있으면(--expect-repo-root 없이도) ALLOW", () => {
  withFixtureDir((dir) => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    initGitRepo(repo);
    mkdirSync(join(repo, ".harness"));
    writeFileSync(join(repo, "a.txt"), "x\n", "utf8");
    commitAll(repo, "init");
    const taskPath = join(repo, ".harness", "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9200-samerepo-1\nbody\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(repo, ".harness", "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(24) HYK-221 축1 -- --ledger가 taskPath와 다른 실제 저장소에 있고 --expect-repo-root가 없으면 REJECT (수리 전: 대조 없이 그대로 통과했다)", () => {
  withFixtureDir((dir) => {
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    mkdirSync(repoA);
    mkdirSync(repoB);
    initGitRepo(repoA);
    initGitRepo(repoB);
    mkdirSync(join(repoA, ".harness"));
    mkdirSync(join(repoB, ".harness"));
    writeFileSync(join(repoA, "a.txt"), "x\n", "utf8");
    writeFileSync(join(repoB, "b.txt"), "x\n", "utf8");
    commitAll(repoA, "init");
    commitAll(repoB, "init");
    const taskPath = join(repoA, ".harness", "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9201-diffrepo-1\nbody\n", "utf8");
    // repoB's ledger would ALLOW if honored (empty issues) -- it must not be.
    const foreignLedgerPath = join(repoB, ".harness", "reject-streak.json");
    writeLedger(foreignLedgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", foreignLedgerPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /REJECT_REPO_MISMATCH|속하지 않음/);
  });
});

test("(25) HYK-221 축1 회귀 방지 -- taskPath가 어떤 git 저장소에도 속하지 않으면(비-git tmpdir) --ledger 만으로도 그대로 통과(기존 fixture 계약 불변)", () => {
  withFixtureDir((dir) => {
    // deliberately NOT a git repo, mirrors tests (1)-(14)/P1-B's own fixture
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9202-nongit-1\nbody\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ALLOW/);
  });
});

// ---------------------------------------------------------------------------
// HYK-239: reject-streak-chain.mjs wiring. §1 결선 위치 = this file (측정
// 근거는 파일 헤더의 HYK-239 주석 참조). §2 세 요건의 기계 증거:
//   1) N -> N+1 checkpoint 증가가 stdout에 사람이 읽을 수 있게 보인다(아래
//      (26)).
//   2) 위조 시 사람이 읽을 수 있는 사유와 함께 비0 종료(아래 (27)/(28)).
//   3) 도달 경로 = 이 CLI 자체가 배달 게이트다(파일 헤더 참조) -- REJECT는
//      곧 배달 거부.
// ---------------------------------------------------------------------------

function envelopeText() {
  return [
    "<!-- reject-streak-envelope",
    "원인 분류: 모델 한계",
    "ORCH 조치:",
    "- 모델 변경: sonnet -> opus 승격",
    "-->",
  ].join("\n");
}

test("(26) HYK-239 결선: 첫 실행에서 체크포인트가 0 -> N으로 늘어나고, 두 번째 실행은 변화 없음(N -> N, 멱등) -- 둘 다 stdout에 사람이 읽을 수 있게 보인다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9300-chainwire-1\n${envelopeText()}\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9300": {
          streak: 2,
          history: [
            { task_id: "HYK-9300-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9300-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    const r1 = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    assert.match(r1.stdout, /ALLOW/);
    assert.match(r1.stdout, /dispatch-gate-decision chain: PASS/);
    assert.match(r1.stdout, /checkpoint 0 -> 2/);
    const chainPath = join(dir, "reject-streak-chain.json");
    assert.equal(existsSync(chainPath), true, "chain sidecar must be created");
    const chain = JSON.parse(readFileSync(chainPath, "utf8"));
    assert.equal(chain.issues["HYK-9300"].entries.length, 2);

    const r2 = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.match(
      r2.stdout,
      /checkpoint 2 -> 2/,
      "no new entries -> idempotent",
    );
  });
});

test("(27) HYK-239 ★핵심★ 위조 탐지 -- 이미 체크포인트된 원장 항목을 사후에 조용히 고치면(원장만 손댐, 사이드카는 그대로) 기존 두 게이트는 여전히 PASS 하지만 chain 검사가 REJECT하여 배달이 막힌다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9301-tamper-1\n${envelopeText()}\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9301": {
          streak: 2,
          history: [
            { task_id: "HYK-9301-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9301-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    // round 1: establishes the checkpoint baseline (as production would,
    // one real dispatch at a time)
    const r1 = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);

    // self-tamper: the primary ledger's ALREADY-checkpointed history[1] is
    // silently edited (e.g. a hand edit or a partial rollback script) --
    // the sidecar is left untouched, exactly the "한쪽만 건드리고 다른 쪽은
    // 잊는" scenario reject-streak-chain.mjs's own header documents as its
    // real target.
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    ledger.issues["HYK-9301"].history[1].task_id = "HYK-9301-coder-2-TAMPERED";
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");

    const r2 = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(
      r2.status,
      1,
      "the two original gates alone would ALLOW this (envelope present, streak unchanged) -- only the chain check catches it",
    );
    assert.match(r2.stderr, /reject-streak gate: PASS/);
    assert.match(r2.stderr, /reject-streak diagnostic-gate: PASS/);
    assert.match(r2.stderr, /dispatch-gate-decision chain: BLOCK/);
    assert.match(r2.stderr, /no longer matches checkpoint/);
    assert.match(r2.stderr, /REJECT --/);
  });
});

test("(28) HYK-239 판정 불가 ≠ 정상 -- 사이드카 파일이 손상(JSON 파싱 실패)되면 ALLOW로 접지 않고 REJECT_CHAIN_UNJUDGABLE 로 분리된 사유와 함께 배달 거부", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9302-corruptchain-1\nbody\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const chainPath = join(dir, "reject-streak-chain.json");
    writeFileSync(chainPath, "{ not valid json ][", "utf8");
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /dispatch-gate-decision chain:.*UNJUDGABLE/);
    assert.doesNotMatch(
      r.stderr,
      /chain: BLOCK/,
      "corrupt sidecar must not be reported as a tamper BLOCK -- it is a distinct judgment-impossible state",
    );
  });
});

// ---------------------------------------------------------------------------
// HYK-241 §2 조각2: 1-B 검문 -- 태스크 패킷에 북극성 1-B 세 요건(ⓐ) 또는
// 선행 작업 선언(ⓑ) 중 하나가 없으면 REJECT. 다른 모든 전제조건과 두 게이트
// 모두 통과했을 때만 이 축이 최종 판정을 좌우한다(dispatch-gate-decision.mjs
// 호출부 주석 참조).
// ---------------------------------------------------------------------------

test("(29) HYK-241 1-B 검문: ⓐ 세 칸 전부 없음, ⓑ 선언도 없음 -> REJECT_ONE_B_MISSING, 누락 칸 이름이 사유 문장에 나온다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9400-nooneb-1\nbody\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /REJECT_ONE_B_MISSING|북극성 1-B/);
    assert.match(r.stderr, /1b_exec_line/);
    assert.match(r.stderr, /1b_shown/);
    assert.match(r.stderr, /1b_reach_path/);
    assert.match(r.stderr, /선언 없음/);
    assert.match(r.stderr, /REJECT --/);
  });
});

test("(30) HYK-241 1-B 검문: ⓐ 세 칸이 모두 채워지면 -> ALLOW (다른 전제조건도 정상일 때)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-9401-onebA-1\n1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task>\n1b_shown: ALLOW/REJECT 한 줄\n1b_reach_path: CLI 종료코드 -- 관제실 화면\n",
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(31) HYK-241 1-B 검문: ⓐ 없이 ⓑ 선행 작업 선언(10자 이상)만 있으면 -> ALLOW (1-B는 금지 필터가 아니라 우선순위)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-9402-onebB-1\n1b_prerequisite_for: HYK-9999 사람 실측 게이트를 준비하는 선행 작업\n",
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(32) HYK-241 1-B 검문: ⓑ 선언은 있으나 10자 미만(placeholder) -> REJECT_ONE_B_MISSING, '너무 짧아' 사유 (⛔아무 문장이나 통과 금지)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-9403-onebBshort-1\n1b_prerequisite_for: ok\n",
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /너무 짧아/);
    assert.match(r.stderr, /REJECT --/);
  });
});

test("(33) HYK-241 1-B 검문: 다른 전제조건이 먼저 실패하면(task_id 없음) 1-B 사유는 등장하지 않는다 -- gates never spawned 규약과 동일하게 앞단이 이긴다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "no task_id line here\nbody\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /task_id 줄이 정확히 1개가 아님/);
    assert.doesNotMatch(r.stderr, /REJECT_ONE_B_MISSING/);
  });
});

// ---------------------------------------------------------------------------
// HYK-347 §3 계약 시험: `DISPATCH_RECEIPT_PATH` 미설정과 "설정됐지만 이
// 라운드로 배달된 영수증이 0건"이 lookupDispatchId의 reasonCode에서
// 서로 다른 값으로 나오는지 고정한다 (§2: "판정 로직 자체는 바꾸지
// 않는다" -- 이 시험은 ok/found 불리언이 아니라 오직 reasonCode만 본다).
// ---------------------------------------------------------------------------

test("HYK-347 계약 ⓐ: receiptPath 자체가 미설정이면 reasonCode=PATH_UNSET (ok:false)", () => {
  const result = lookupDispatchId({
    role: "CODER",
    harnessTaskLabel: "HYK-347-x-1",
    receiptPath: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.found, false);
  assert.equal(result.reasonCode, DISPATCH_RECEIPT_LOOKUP_REASON.PATH_UNSET);
});

test("HYK-347 계약 ⓑ: receiptPath는 설정됐지만 이 role+label로 배달된 영수증이 0건이면 reasonCode=NOT_FOUND (ok:true, found:false) -- ⓐ와 다른 값", () => {
  withFixtureDir((dir) => {
    const receiptPath = join(dir, "dispatch-receipts.jsonl");
    // 파일은 존재하고 읽을 수 있지만, 이 role+label과 일치하는 줄이 없다.
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ role: "REVIEW", harness_task_label: "OTHER-LABEL", dispatch_id: "ctx_other" })}\n`,
      "utf8",
    );
    const result = lookupDispatchId({
      role: "CODER",
      harnessTaskLabel: "HYK-347-x-1",
      receiptPath,
    });
    assert.equal(result.ok, true);
    assert.equal(result.found, false);
    assert.equal(result.reasonCode, DISPATCH_RECEIPT_LOOKUP_REASON.NOT_FOUND);
    assert.notEqual(
      result.reasonCode,
      DISPATCH_RECEIPT_LOOKUP_REASON.PATH_UNSET,
      "«미설정»과 «설정됐지만 0건»은 서로 다른 값으로 표면화돼야 한다(HYK-347 §2)",
    );
  });
});

test("HYK-347 계약 ⓒ (회귀 확인): 실제로 일치하는 영수증이 있으면 reasonCode=FOUND, ok:true, found:true, dispatchId가 채워진다 -- 판정 로직 자체는 그대로", () => {
  withFixtureDir((dir) => {
    const receiptPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ role: "CODER", harness_task_label: "HYK-347-x-1", dispatch_id: "ctx_real" })}\n`,
      "utf8",
    );
    const result = lookupDispatchId({
      role: "CODER",
      harnessTaskLabel: "HYK-347-x-1",
      receiptPath,
    });
    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    assert.equal(result.reasonCode, DISPATCH_RECEIPT_LOOKUP_REASON.FOUND);
    assert.equal(result.dispatchId, "ctx_real");
  });
});
