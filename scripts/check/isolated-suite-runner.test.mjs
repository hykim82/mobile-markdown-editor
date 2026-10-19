import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  TEST_DIRS,
  collectTestFiles,
  formatBanner,
  resolveNodeVersionWarning,
  runIsolatedSuite,
} from "./isolated-suite-runner.mjs";

// HYK-301: these tests spawn the real CLI entry point as a child process --
// importing runIsolatedSuite()/collectTestFiles() directly would never
// exercise the `invokedDirectly` argv-parsing branch these tests exist to
// cover, and the bug this task closes (unknown args silently ignored) lives
// entirely in that branch.
const runnerPath = fileURLToPath(
  new URL("./isolated-suite-runner.mjs", import.meta.url),
);

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [runnerPath, ...args], {
    encoding: "utf8",
    ...opts,
  });
}

test("collectTestFiles: lists *.test.mjs per dir, sorted, joined with the dir prefix", () => {
  const fakeTree = {
    "scripts/check": ["b.test.mjs", "a.test.mjs", "not-a-test.mjs"],
    "scripts/relay": ["r.test.mjs"],
    "scripts/relay/adapters": ["ad.test.mjs"],
    "scripts/supervisor": ["s.test.mjs"],
    "templates/harness-init": ["install-copylist-closure.test.mjs"],
  };
  const readdir = (path) => {
    const key = path.replace(/\\/g, "/").replace(/^\/repo\//, "");
    if (!(key in fakeTree)) throw new Error(`ENOENT: ${path}`);
    return fakeTree[key];
  };
  const files = collectTestFiles("/repo", TEST_DIRS, { readdir }).map((f) =>
    f.replace(/\\/g, "/"),
  );
  assert.deepEqual(files, [
    "scripts/check/a.test.mjs",
    "scripts/check/b.test.mjs",
    "scripts/relay/r.test.mjs",
    "scripts/relay/adapters/ad.test.mjs",
    "scripts/supervisor/s.test.mjs",
    "templates/harness-init/install-copylist-closure.test.mjs",
  ]);
});

test("collectTestFiles: a directory that does not exist in the clone throws (fail-closed), never silently skipped", () => {
  const readdir = () => {
    throw new Error("ENOENT");
  };
  assert.throws(
    () => collectTestFiles("/repo", ["scripts/missing"], { readdir }),
    /required test directory unreadable.*scripts\/missing/,
  );
});

test("collectTestFiles: fail-closed applies per directory -- an earlier readable dir's files do not mask a later dir's read failure", () => {
  const readdir = (path) => {
    const key = path.replace(/\\/g, "/").replace(/^\/repo\//, "");
    if (key === "scripts/check") return ["a.test.mjs"];
    throw new Error("ENOENT");
  };
  assert.throws(
    () =>
      collectTestFiles("/repo", ["scripts/check", "scripts/missing"], {
        readdir,
      }),
    /scripts\/missing/,
  );
});

test("formatBanner: always names the tested commit and always states uncommitted content is excluded", () => {
  const clean = formatBanner({ sha: "abc123", dirty: false });
  assert.match(clean, /tested commit abc123/);
  assert.match(clean, /uncommitted changes are NOT included/);
  assert.doesNotMatch(clean, /NOTE:/);
});

test("formatBanner: a dirty source checkout gets an explicit extra NOTE line, not a silent omission", () => {
  const dirty = formatBanner({ sha: "def456", dirty: true });
  assert.match(dirty, /tested commit def456/);
  assert.match(dirty, /NOTE: the source checkout has uncommitted changes/);
});

// HYK-464 §2 ⓐ-2: resolveNodeVersionWarning is a pure function (no spawn,
// no fs) -- unit-tested directly against synthetic version/engines-range
// strings, the same way node-target-version.test.mjs unit-tests
// resolveEnginesMajor against synthetic package.json text.
test("resolveNodeVersionWarning: matching majors -> null (no warning)", () => {
  assert.equal(
    resolveNodeVersionWarning({ nodeVersion: "v20.11.0", enginesNode: "20.x" }),
    null,
  );
});

test("resolveNodeVersionWarning: differing majors -> MISMATCH naming both versions, never a block (report-only, no exit-code language)", () => {
  const warning = resolveNodeVersionWarning({
    nodeVersion: "v26.2.0",
    enginesNode: "20.x",
  });
  assert.match(warning, /^MISMATCH:/);
  assert.match(warning, /v26\.2\.0/);
  assert.match(warning, /20\.x/);
});

test("resolveNodeVersionWarning: a major-only coincidental substring (Node 12 vs engines '120.x') is NOT treated as a match -- majors are parsed as whole leading numbers, not substrings", () => {
  const warning = resolveNodeVersionWarning({
    nodeVersion: "v12.0.0",
    enginesNode: "120.x",
  });
  assert.match(warning, /^MISMATCH:/);
});

test("resolveNodeVersionWarning: engines.node undeclared (null) -> UNKNOWN/판정 불가, never silently null/0", () => {
  const warning = resolveNodeVersionWarning({
    nodeVersion: "v20.11.0",
    enginesNode: null,
  });
  assert.match(warning, /^UNKNOWN:/);
  assert.match(warning, /판정 불가/);
});

test("resolveNodeVersionWarning: engines.node present but unparseable (no digits) -> UNKNOWN/판정 불가", () => {
  const warning = resolveNodeVersionWarning({
    nodeVersion: "v20.11.0",
    enginesNode: "latest",
  });
  assert.match(warning, /^UNKNOWN:/);
});

test("resolveNodeVersionWarning: nodeVersion itself unparseable -> UNKNOWN/판정 불가 (not thrown, not a false match)", () => {
  const warning = resolveNodeVersionWarning({
    nodeVersion: "garbage",
    enginesNode: "20.x",
  });
  assert.match(warning, /^UNKNOWN:/);
});

// HYK-464 2R P2-4 (책임자 판정 2026-10-16 16:4x §1): a range expression's
// leading number is NOT a reliable "the major" -- this intentionally
// REPLACES the 1R test that asserted a leading-number match for
// ">=20 <21" (that old assertion is exactly the behavior P2-4 narrows:
// a range must resolve to UNKNOWN regardless of what its leading number
// happens to be, not "match if the leading number happens to agree").
test("resolveNodeVersionWarning: HYK-464 2R P2-4 -- a range expression ('>=20 <21') is UNKNOWN/판정 불가 even when its leading number would have 'matched' under the old leading-number heuristic", () => {
  const warning = resolveNodeVersionWarning({
    nodeVersion: "v20.0.0",
    enginesNode: ">=20 <21",
  });
  assert.match(warning, /^UNKNOWN:/);
  assert.match(warning, /range expression/);
});

// coder-task.md §2 ⓔ 칸 2, 사례 1: `>=20`에 실제로는 불일치일 v22를 넣어도
// (범위식이라) 판정 불가 -- MISMATCH 경고가 아니라 UNKNOWN이어야 한다.
test("resolveNodeVersionWarning: HYK-464 2R P2-4 cell -- '>=20' (open-ended range) with v22.1.0 is UNKNOWN, never MISMATCH", () => {
  const warning = resolveNodeVersionWarning({
    nodeVersion: "v22.1.0",
    enginesNode: ">=20",
  });
  assert.match(warning, /^UNKNOWN:/);
});

test("resolveNodeVersionWarning: HYK-464 2R P2-4 -- a multi-alternative range ('^20 || ^22') is UNKNOWN, never MISMATCH, even though it names this run's own major", () => {
  const warning = resolveNodeVersionWarning({
    nodeVersion: "v22.1.0",
    enginesNode: "^20 || ^22",
  });
  assert.match(warning, /^UNKNOWN:/);
});

// coder-task.md §2 ⓔ 칸 2, 사례 2: 단일 버전(`20.x`)은 범위식이 아니므로
// 이 2R 수리 전과 똑같이 MISMATCH로 남아야 한다 -- 무회귀 확인.
test("resolveNodeVersionWarning: HYK-464 2R P2-4 regression guard -- a single pinned major ('20.x') with v26 is STILL MISMATCH, not UNKNOWN (ranges only)", () => {
  const warning = resolveNodeVersionWarning({
    nodeVersion: "v26.2.0",
    enginesNode: "20.x",
  });
  assert.match(warning, /^MISMATCH:/);
});

// P2-4 변이 1: SINGLE_VERSION_ENGINES_RE가 지워지면(= 범위식도 전부
// "단일 버전"으로 되돌아가면) 위 '>=20' 칸이 UNKNOWN 대신 MISMATCH로
// 거짓 매치돼 이 시험이 RED가 된다.
test("resolveNodeVersionWarning: P2-4 mutation guard -- a dash-range ('20 - 22') is also UNKNOWN, not resolved off either bound", () => {
  const warning = resolveNodeVersionWarning({
    nodeVersion: "v21.0.0",
    enginesNode: "20 - 22",
  });
  assert.match(warning, /^UNKNOWN:/);
});

// HYK-411: every test below that doesn't specifically exercise receipt
// writing passes a no-op writeReceipt/readFile so this suite never touches
// the real filesystem outside its own mkdtemp'd cloneDir/tapDir (the mocked
// `root` values here, like "/src", are not real directories -- letting the
// real writer run against them would either throw noisily or, worse,
// actually create a stray ".harness" next to the filesystem root).
const noopWriteReceipt = () => ({ path: "(stubbed)", receipt: {} });
const throwingReadFile = () => {
  throw new Error("stubbed: no tap file in this test");
};
// HYK-477 §2-3 2R: classifySpawnOutcome's ambiguous branch (non-zero status,
// no signal, no error) now needs hasCompletion -- computed from whether the
// tap file parses a completion summary (isolated-suite-runner.mjs's
// hasTapCompletion). Tests below that assert a specific non-zero exit code
// propagates verbatim are proving "a real run really failed" (not the
// measurement-unavailable axis, which has its own dedicated coverage in
// hyk473-runner-cap.test.mjs) -- they need a readFile that actually reports
// a completion, or the new axis reclassifies them as MEASUREMENT_UNAVAILABLE_
// OOM (exitCode forced to 1) instead of propagating the real status.
const completedTapReadFile = () =>
  "TAP version 13\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n";

test("runIsolatedSuite: clones from repoRoot (not cwd), runs node --test in the clone's cwd, and propagates the child's exit code", () => {
  const calls = [];
  const execFile = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return "/src\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
    if (args[0] === "status") return "";
    if (args[0] === "clone") return "";
    throw new Error(`unexpected execFile: ${cmd} ${args.join(" ")}`);
  };
  let spawnCwd;
  const spawn = (cmd, args, opts) => {
    spawnCwd = opts.cwd;
    return { status: 7 };
  };
  const logs = [];
  const exitCode = runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile,
    spawn,
    log: (m) => logs.push(m),
    collectFiles: () => ["scripts/check/a.test.mjs"],
    readFile: completedTapReadFile,
    writeReceipt: noopWriteReceipt,
  });
  assert.equal(exitCode, 7);
  const cloneCall = calls.find((c) => c.args[0] === "clone");
  assert.equal(cloneCall.args[1], "--quiet");
  assert.equal(cloneCall.args[2], "/src");
  const cloneDir = cloneCall.args[3];
  assert.equal(spawnCwd, cloneDir);
  assert.ok(logs.some((l) => l.includes("deadbeef")));
});

test("runIsolatedSuite: a dirty source repo's uncommitted changes surface in the banner, not silently dropped", () => {
  const execFile = (cmd, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return "/src\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "cafef00d\n";
    if (args[0] === "status") return " M scripts/foo.mjs\n";
    if (args[0] === "clone") return "";
    throw new Error(`unexpected execFile: ${cmd} ${args.join(" ")}`);
  };
  const spawn = () => ({ status: 0 });
  const logs = [];
  runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile,
    spawn,
    log: (m) => logs.push(m),
    collectFiles: () => [],
    readFile: throwingReadFile,
    writeReceipt: noopWriteReceipt,
  });
  assert.ok(
    logs.some((l) =>
      l.includes("NOTE: the source checkout has uncommitted changes"),
    ),
  );
});

// HYK-411 §2-1: the runner writes its own observed exit code (plus the
// tap-parsed counts and the head commit it tested) to a receipt -- this is
// the actual fix (a downstream pipe cannot reach back and rewrite what this
// function itself writes, unlike the shell-visible exit code it also
// returns).
function execFileForReceiptTests() {
  return (cmd, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return "/src\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
    if (args[0] === "status") return "";
    if (args[0] === "clone") return "";
    throw new Error(`unexpected execFile: ${cmd} ${args.join(" ")}`);
  };
}

test("runIsolatedSuite: a RED run (non-zero exit) still gets a receipt written -- §2-1 explicitly forbids skipping the receipt on failure", () => {
  const receipts = [];
  // HYK-477 §2-3 2R: a real RED run (node --test completed and reported a
  // real failure) must classify as TESTS_FAILED, not MEASUREMENT_UNAVAILABLE_
  // OOM -- completedTapReadFile makes that distinction observable here too
  // (runnerStatus), not just via the coincidentally-matching exitCode.
  const exitCode = runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile: execFileForReceiptTests(),
    spawn: () => ({ status: 1 }),
    log: () => {},
    collectFiles: () => [],
    readFile: completedTapReadFile,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].runnerExit, 1);
  assert.equal(receipts[0].runnerStatus, "TESTS_FAILED");
  assert.equal(receipts[0].headCommit, "deadbeef");
});

test("runIsolatedSuite: receipt's headCommit is the runner's OWN `git rev-parse HEAD` reading of the source root, not something spawn/collectFiles could influence", () => {
  const receipts = [];
  runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile: execFileForReceiptTests(),
    spawn: () => ({ status: 0 }),
    log: () => {},
    collectFiles: () => [],
    readFile: throwingReadFile,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
  });
  assert.equal(receipts[0].headCommit, "deadbeef");
  assert.equal(receipts[0].runnerExit, 0);
});

test("runIsolatedSuite: tap summary counts are parsed from the tap-reporter destination file and threaded into the receipt payload", () => {
  const tap = ["# tests 12", "# pass 10", "# fail 2", "# skipped 0", ""].join(
    "\n",
  );
  const receipts = [];
  runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile: execFileForReceiptTests(),
    spawn: () => ({ status: 1 }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => tap,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
  });
  assert.deepEqual(receipts[0].counts, {
    tests: 12,
    pass: 10,
    fail: 2,
    skip: 0,
  });
});

test("runIsolatedSuite: an unreadable tap file degrades to null counts (not a crash, not a fabricated count)", () => {
  const receipts = [];
  const logs = [];
  const exitCode = runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile: execFileForReceiptTests(),
    spawn: () => ({ status: 0 }),
    log: (m) => logs.push(m),
    collectFiles: () => [],
    readFile: throwingReadFile,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(receipts[0].counts, {
    tests: null,
    pass: null,
    fail: null,
    skip: null,
  });
  assert.ok(logs.some((l) => l.includes("WARNING")));
});

// ---------------------------------------------------------------------------
// HYK-209 §2 ⓐ (책임자 판정 2026-10-17 14:5x, P2-D 등재 후보 -- REVIEW-r2.md
// §3 P2-D/§2 R7c): full-pipeline wiring test. Proves classifySpawnOutcome's
// ambiguous branch (status != 0, no signal, no error -- the real Windows
// forced-kill shape isolated-suite-runner.mjs's own header cites) no longer
// misreads a leaked-fake-block tap file as a genuine completion, end to end
// through runIsolatedSuite -> emitRunnerReceipt. The tap text below is the
// REAL bytes a real synthetic-repo SIGKILL repro produced (coder.md §2
// ⓐ-2 실물, scratchpad probe-p2d.mjs) -- not fabricated. The elapsed-time
// gap (real repro: ~3000ms wall clock vs the block's own claimed 1.0ms) is
// reproduced here via an injected `nowMs` counter instead of an actual
// 3-second sleep, so this test stays fast; see hasGenuineTapCompletion's
// own duration-plausibility tests (runner-receipt-writer.test.mjs) for the
// lower-level unit coverage of that same cross-check.
// ---------------------------------------------------------------------------
const REAL_SIGKILL_LEAKED_TAP_TEXT =
  "TAP version 13\n# tests 9\n# suites 0\n# pass 9\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.0\n";

test("runIsolatedSuite: HYK-209 R7c real-repro bytes + an ambiguous Windows forced-kill status (no signal/error) -- before this round's fix this misclassified as TESTS_FAILED with fake 9/9/0/0 counts; now it is MEASUREMENT_UNAVAILABLE_OOM with null counts", () => {
  const receipts = [];
  let tick = 0;
  // Simulates the real repro's ~3000ms wall-clock gap without an actual
  // sleep: the first nowMs() call (spawnSuiteInClone's startedAtMs) returns
  // 0, the second (right after spawn returns, used for elapsedMs) returns
  // 5000 -- same order of magnitude as the real repro's measured ~3000ms.
  const nowMs = () => (tick++ === 0 ? 0 : 5000);
  const exitCode = runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile: execFileForReceiptTests(),
    // The real ambiguous Windows forced-kill shape: no signal, no error,
    // a non-zero status that is not a real node --test exit code
    // (isolated-suite-runner.mjs's own classifySpawnOutcome header cites
    // 0xFFFFFFFF from a real prior incident, runner-receipt-run5.json).
    spawn: () => ({ status: 0xffffffff }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => REAL_SIGKILL_LEAKED_TAP_TEXT,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    nowMs,
  });
  assert.equal(
    exitCode,
    1,
    "classifySpawnOutcome's MEASUREMENT_UNAVAILABLE_OOM branch always forces exitCode 1",
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].runnerStatus, "MEASUREMENT_UNAVAILABLE_OOM");
  assert.notEqual(
    receipts[0].runnerStatus,
    "TESTS_FAILED",
    "this is the exact pre-fix bug: a forced kill must never be recorded as a real test failure",
  );
  assert.deepEqual(receipts[0].counts, {
    tests: null,
    pass: null,
    fail: null,
    skip: null,
  });
});

// HYK-209 2R P1-2 (책임자 판정 2026-10-17 18:4x 판단 1 · REVIEW-r1.md ⓑ K2/K5
// 표 TAP 원문 그대로): full-pipeline wiring for the two shapes this round's
// fix closes -- K2 (duration_ms present but implausibly large, no plan line)
// and K5 (a forged '1..9' plan line that comes out escaped as '# 1..9', no
// duration_ms at all). Before this round's fix both landed as TESTS_FAILED
// with the leaked block's fake 9/9/0/0 counts (REVIEW-r1.md ⓑ HEAD column);
// after the fix both are MEASUREMENT_UNAVAILABLE_OOM with null counts, same
// as R7c/K1 above.
const K2_REAL_REPRO_TAP_TEXT =
  "TAP version 13\n# tests 9\n# suites 0\n# pass 9\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 999999\n";
const K5_REAL_REPRO_TAP_TEXT =
  "TAP version 13\n# 1..9\n# tests 9\n# suites 0\n# pass 9\n# fail 0\n# cancelled 0\n# skipped 0\n";

test("runIsolatedSuite: HYK-209 2R P1-2 K2 (REVIEW-r1.md ⓑ real TAP bytes, duration_ms=999999) -- before this round's fix this misclassified as TESTS_FAILED with fake 9/9/0/0 counts; now it is MEASUREMENT_UNAVAILABLE_OOM with null counts", () => {
  const receipts = [];
  let tick = 0;
  const nowMs = () => (tick++ === 0 ? 0 : 5000);
  const exitCode = runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile: execFileForReceiptTests(),
    spawn: () => ({ status: 1 }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => K2_REAL_REPRO_TAP_TEXT,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    nowMs,
  });
  assert.equal(exitCode, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].runnerStatus, "MEASUREMENT_UNAVAILABLE_OOM");
  assert.notEqual(receipts[0].runnerStatus, "TESTS_FAILED");
  assert.deepEqual(receipts[0].counts, {
    tests: null,
    pass: null,
    fail: null,
    skip: null,
  });
});

test("runIsolatedSuite: HYK-209 2R P1-2 K5 (REVIEW-r1.md ⓑ real TAP bytes, forged plan line escaped as '# 1..9', no duration_ms) -- before this round's fix this misclassified as TESTS_FAILED with fake 9/9/0/0 counts; now it is MEASUREMENT_UNAVAILABLE_OOM with null counts", () => {
  const receipts = [];
  let tick = 0;
  const nowMs = () => (tick++ === 0 ? 0 : 5000);
  const exitCode = runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile: execFileForReceiptTests(),
    spawn: () => ({ status: 1 }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => K5_REAL_REPRO_TAP_TEXT,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    nowMs,
  });
  assert.equal(exitCode, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].runnerStatus, "MEASUREMENT_UNAVAILABLE_OOM");
  assert.notEqual(receipts[0].runnerStatus, "TESTS_FAILED");
  assert.deepEqual(receipts[0].counts, {
    tests: null,
    pass: null,
    fail: null,
    skip: null,
  });
});

// HYK-464 §2 ⓐ-1/ⓐ-2: wiring tests for the node-version receipt field and
// its first-line warning. These inject `readPackageJsonFn`/`nodeVersion`
// directly (both default parameters) rather than touching the real fs --
// every OTHER test in this file (and in hyk473-runner-cap.test.mjs, out of
// this round's product_scope) relies on the default readPackageJsonFn
// failing against their fake "/src" root and degrading to the UNKNOWN/
// 판정 불가 case, which is deliberately never logged (see
// runIsolatedSuite's own comment) -- that is what keeps "the resolved
// concurrency cap is the run's literal first log line"
// (hyk473-runner-cap.test.mjs) from regressing.
// HYK-464 2R P2-6 (책임자 판정 2026-10-16 16:4x §1, 원문 "A"): 1R은 경고를
// 배너보다 "앞" 줄로 따로 log()했다 -- 그래서 배너가 둘째 줄로 밀렸다
// (HYK-473 §2-1 "상한 값이 첫 줄" 계약과 충돌, 검토 1R P2-6 지적). 2R은
// 하나의 첫 줄에 배너 먼저 + 같은 줄 끝에 경고를 붙인다. 경고 토큰도
// 판정 원문 모양("WARNING: NODE_VERSION_MISMATCH")으로 맞춘다(1R의
// "WARNING: MISMATCH:" 대체) -- 영수증 필드 자체는 하위 호환을 위해
// "MISMATCH: ..." 그대로 남긴다(아래 별도 단언).
test("runIsolatedSuite: HYK-464 2R P2-6 -- a real Node-major MISMATCH lands on the SAME first line as the concurrency banner (banner first, warning appended, token 'WARNING: NODE_VERSION_MISMATCH'), never a separate second line, and still rides the receipt payload (unchanged 'MISMATCH:' token for backward compat)", () => {
  const receipts = [];
  const logs = [];
  runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile: execFileForReceiptTests(),
    spawn: () => ({ status: 0 }),
    log: (m) => logs.push(m),
    collectFiles: () => [],
    readFile: completedTapReadFile,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    nodeVersion: "v26.2.0",
    readPackageJsonFn: () => ({ engines: { node: "20.x" } }),
  });
  assert.match(
    logs[0],
    /^\[isolated-suite-runner\] test-concurrency=.* -- WARNING: NODE_VERSION_MISMATCH:/,
  );
  assert.ok(
    !logs.slice(1).some((l) => l.includes("NODE_VERSION_MISMATCH")),
    `expected the warning to appear ONLY on logs[0], never on a later line; logs: ${JSON.stringify(logs)}`,
  );
  assert.equal(receipts[0].nodeVersion, "v26.2.0");
  assert.match(receipts[0].nodeVersionWarning, /^MISMATCH:/);
});

test("runIsolatedSuite: matching Node majors -> no warning logged, receipt's nodeVersionWarning is null, nodeVersion is still recorded", () => {
  const receipts = [];
  const logs = [];
  runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile: execFileForReceiptTests(),
    spawn: () => ({ status: 0 }),
    log: (m) => logs.push(m),
    collectFiles: () => [],
    readFile: completedTapReadFile,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    nodeVersion: "v20.11.0",
    readPackageJsonFn: () => ({ engines: { node: "20.x" } }),
  });
  assert.ok(
    !logs.some((l) => l.includes("MISMATCH") || l.includes("UNKNOWN")),
    `expected no node-version warning logged on a match; logs: ${JSON.stringify(logs)}`,
  );
  assert.equal(receipts[0].nodeVersion, "v20.11.0");
  assert.equal(receipts[0].nodeVersionWarning, null);
});

test("runIsolatedSuite: engines.node unreadable (default readPackageJsonFn against a fake root, every other test's shape) -> UNKNOWN/판정 불가 rides the receipt but is NOT logged, and the concurrency banner stays the literal first line (§2-1's prior contract, hyk473-runner-cap.test.mjs, must not regress)", () => {
  const receipts = [];
  const logs = [];
  runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile: execFileForReceiptTests(),
    spawn: () => ({ status: 0 }),
    log: (m) => logs.push(m),
    collectFiles: () => [],
    readFile: completedTapReadFile,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    nodeVersion: "v26.2.0",
  });
  assert.match(logs[0], /^\[isolated-suite-runner\] test-concurrency=/);
  assert.match(receipts[0].nodeVersionWarning, /^UNKNOWN:/);
});

test("runIsolatedSuite: a receipt-write failure is swallowed (logged, not thrown) and the real exit code still propagates -- writing a receipt must never mask the suite's own result", () => {
  const logs = [];
  const exitCode = runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile: execFileForReceiptTests(),
    spawn: () => ({ status: 3 }),
    log: (m) => logs.push(m),
    collectFiles: () => [],
    readFile: completedTapReadFile,
    writeReceipt: () => {
      throw new Error("disk full");
    },
  });
  assert.equal(exitCode, 3);
  assert.ok(logs.some((l) => l.includes("WARNING") && l.includes("disk full")));
});

// M1 (검토 1R ⓔ 표 P2-2): a real MISMATCH must never change the returned
// exit code -- "report only, exit code/judgement unaffected" is a literal
// contract (resolveNodeVersionWarning's own string), but 1R had no test
// asserting it at the runIsolatedSuite level, so a mutation that forced
// exitCode to 1 on MISMATCH would have survived. Uses exit code 5
// (deliberately not 1) so a mutation hardcoding "1" on MISMATCH cannot
// coincidentally pass.
test("runIsolatedSuite: M1 mutation guard -- a real Node-major MISMATCH alongside a REAL failed spawn (exit 5) still returns the spawn's own exit code verbatim, never forced to 1 by the mismatch", () => {
  const exitCode = runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile: execFileForReceiptTests(),
    spawn: () => ({ status: 5 }),
    log: () => {},
    collectFiles: () => [],
    readFile: completedTapReadFile,
    writeReceipt: noopWriteReceipt,
    nodeVersion: "v26.2.0",
    readPackageJsonFn: () => ({ engines: { node: "20.x" } }),
  });
  assert.equal(exitCode, 5);
});

// M2 (검토 1R ⓔ 표 P2-2): the in-clone `node --test` child must be spawned
// via `process.execPath` (this runner's OWN binary -- node_version's whole
// meaning depends on "the child IS the same binary as the parent", see
// resolveNodeVersionWarning's own header comment), never a bare "node"
// string (which could resolve to a DIFFERENT installed Node on PATH).
test("runIsolatedSuite: M2 mutation guard -- the in-clone node --test child is spawned via process.execPath, not a bare 'node' string", () => {
  let capturedCmd;
  runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    execFile: execFileForReceiptTests(),
    spawn: (cmd) => {
      capturedCmd = cmd;
      return { status: 0 };
    },
    log: () => {},
    collectFiles: () => [],
    readFile: completedTapReadFile,
    writeReceipt: noopWriteReceipt,
  });
  assert.equal(capturedCmd, process.execPath);
  assert.notEqual(capturedCmd, "node");
});

// HYK-464 2R P2-6 ("repoRootOf가 배너보다 먼저 불리는 순서... 를 «배너가
// 먼저」로"): a non-git cwd makes root resolution throw BEFORE the
// concurrency banner can be merged with a node-version warning (there is
// no `root` yet to read engines.node from) -- but the banner itself never
// depended on root, so it must still be logged before the throw
// propagates, not silently dropped (1R's actual prior behavior: zero log
// lines on this path).
test("runIsolatedSuite: HYK-464 2R P2-6 -- when root resolution itself throws (non-git cwd), the concurrency banner is still logged before the error propagates (not silently dropped)", () => {
  const logs = [];
  const execFile = () => {
    throw new Error(
      "fatal: not a git repository (or any of the parent directories): .git",
    );
  };
  assert.throws(
    () =>
      runIsolatedSuite({
        startSampler: () => null,
        stopSampler: () => null,
        execFile,
        spawn: () => {
          throw new Error("must not be reached");
        },
        log: (m) => logs.push(m),
        collectFiles: () => {
          throw new Error("must not be reached");
        },
        concurrency: 3,
      }),
    /not a git repository/,
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[isolated-suite-runner\] test-concurrency=3 /);
});

test("runIsolatedSuite: a fail-closed collectFiles throw propagates out (never swallowed into a green run), and cleanup still runs", () => {
  const execFile = (cmd, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return "/src\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
    if (args[0] === "status") return "";
    if (args[0] === "clone") return "";
    throw new Error(`unexpected execFile: ${cmd} ${args.join(" ")}`);
  };
  let spawnCalled = false;
  const spawn = () => {
    spawnCalled = true;
    return { status: 0 };
  };
  assert.throws(
    () =>
      runIsolatedSuite({
        startSampler: () => null,
        stopSampler: () => null,
        execFile,
        spawn,
        log: () => {},
        collectFiles: () => {
          throw new Error("required test directory unreadable: scripts/x");
        },
      }),
    /required test directory unreadable/,
  );
  assert.equal(
    spawnCalled,
    false,
    "the suite must never run once directory collection has failed closed",
  );
});

test("CLI: an unrecognized positional argument is rejected -- exit!=0, and the raw argument text is in the output (HYK-301 repro/fix)", () => {
  const result = runCli(["/some/positional/path"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized argument/);
  assert.match(result.stderr, /\/some\/positional\/path/);
});

test("CLI: an unrecognized flag is rejected the same way as a bad positional (HYK-301 §4b)", () => {
  const result = runCli(["--nope"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized argument/);
  assert.match(result.stderr, /--nope/);
});

test("CLI: zero-argument invocation (the CI-canonical call) still passes argv parsing -- no 'unrecognized argument' rejection (HYK-301 §2-1 / §4c)", () => {
  // A bogus, non-git cwd makes runIsolatedSuite's `git rev-parse
  // --show-toplevel` fail fast, so this test doesn't have to pay for a
  // full clone + suite run to prove the arg-parsing stage was passed --
  // it only needs to show the failure is NOT the "unrecognized argument"
  // rejection, i.e. zero args reached runIsolatedSuite() same as before.
  const notARepo = mkdtempSync(join(tmpdir(), "hyk301-not-a-repo-"));
  try {
    const result = runCli([], { cwd: notARepo });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /unrecognized argument/);
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("CLI: --repo-root <path> is still recognized and its value consumed -- no 'unrecognized argument' rejection (HYK-301 §4d)", () => {
  // A bogus target path makes the downstream `git rev-parse HEAD` fail
  // fast once the CLI hands sourceRoot to runIsolatedSuite -- proving
  // --repo-root's value was consumed as a flag value, not flagged as an
  // unrecognized bare argument.
  const result = runCli(["--repo-root", "C:/definitely/not/a/repo/xyz"]);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /unrecognized argument/);
});

test("CLI: --repo-root with no following value is rejected, not silently undefined->cwd fallback (HYK-301 §2-11)", () => {
  const result = runCli(["--repo-root"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized argument/);
  assert.match(result.stderr, /--repo-root/);
});
