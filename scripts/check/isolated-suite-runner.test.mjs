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
