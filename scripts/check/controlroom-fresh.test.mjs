import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkControlRoomFresh, DEFAULT_DIRTY_THRESHOLD_MS, DEFAULT_HANDOFF_THRESHOLD_MS } from "./controlroom-fresh.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./controlroom-fresh.mjs", import.meta.url));

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "controlroom-fresh-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const T0 = new Date("2026-07-10T00:00:00+09:00").getTime();
function touch(path, content, mtime) {
  writeFileSync(path, content, "utf8");
  utimesSync(path, mtime, mtime);
}

test("(1) dirty tree + last commit older than threshold -> warning", () => {
  withFixtureDir((dir) => {
    const result = checkControlRoomFresh({
      controlRoomPath: dir,
      now: T0,
      isGitRepoFn: () => true,
      gitStatusFn: () => " M STATUS.md\n",
      lastCommitTimeFn: () => new Date(T0 - (DEFAULT_DIRTY_THRESHOLD_MS + 3600000)),
    });
    assert.equal(result.ok, false);
    assert.match(result.warnings.join(" "), /working tree is dirty/);
  });
});

test("(1b) dirty tree + unresolvable commit time (null, e.g. unborn repo/git log failure) -> no warning, ok", () => {
  withFixtureDir((dir) => {
    const result = checkControlRoomFresh({
      controlRoomPath: dir,
      now: T0,
      isGitRepoFn: () => true,
      gitStatusFn: () => " M STATUS.md\n",
      lastCommitTimeFn: () => null,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });
});

test("(2) dirty tree but recent commit -> ok", () => {
  withFixtureDir((dir) => {
    const result = checkControlRoomFresh({
      controlRoomPath: dir,
      now: T0,
      isGitRepoFn: () => true,
      gitStatusFn: () => " M STATUS.md\n",
      lastCommitTimeFn: () => new Date(T0 - 60000),
    });
    assert.equal(result.ok, true);
  });
});

test("(3) clean tree -> ok regardless of commit age", () => {
  withFixtureDir((dir) => {
    const result = checkControlRoomFresh({
      controlRoomPath: dir,
      now: T0,
      isGitRepoFn: () => true,
      gitStatusFn: () => "",
      lastCommitTimeFn: () => new Date(T0 - DEFAULT_DIRTY_THRESHOLD_MS * 10),
    });
    assert.equal(result.ok, true);
  });
});

test("(4) STATUS.md <-> PHASE-HANDOFF.md mtime gap beyond threshold -> warning", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    const handoffPath = join(dir, "PHASE-HANDOFF.md");
    touch(statusPath, "status\n", new Date(T0));
    touch(handoffPath, "handoff\n", new Date(T0 - (DEFAULT_HANDOFF_THRESHOLD_MS + 3600000)));
    const result = checkControlRoomFresh({
      controlRoomPath: dir,
      now: T0,
      isGitRepoFn: () => true,
      gitStatusFn: () => "",
      lastCommitTimeFn: () => new Date(T0),
      statusPath,
      handoffPath,
    });
    assert.equal(result.ok, false);
    assert.match(result.warnings.join(" "), /handoff may be stale/);
  });
});

test("(5) control room path absent or not a git repo -> vacuously ok", () => {
  withFixtureDir((dir) => {
    const missing = join(dir, "does-not-exist");
    const result = checkControlRoomFresh({ controlRoomPath: missing, isGitRepoFn: () => false });
    assert.equal(result.ok, true);
    assert.match(result.reason, /vacuously ok/);
  });
});

test("(6) no controlRoomPath given at all -> vacuously ok", () => {
  const result = checkControlRoomFresh({});
  assert.equal(result.ok, true);
});

test("(7) mtime gap within threshold -> ok, not a false positive", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    const handoffPath = join(dir, "PHASE-HANDOFF.md");
    touch(statusPath, "status\n", new Date(T0));
    touch(handoffPath, "handoff\n", new Date(T0 - 3600000));
    const result = checkControlRoomFresh({
      controlRoomPath: dir,
      now: T0,
      isGitRepoFn: () => true,
      gitStatusFn: () => "",
      lastCommitTimeFn: () => new Date(T0),
      statusPath,
      handoffPath,
    });
    assert.equal(result.ok, true);
  });
});

// --- HYK-131: CLI-level ORCH-only blocking promotion (G1/G2/G3) ---
// Uses a real temp git repo (not injected git*Fn) so the CLI's own default
// git-shelling path is what gets exercised end-to-end, matching G8's "known-
// bad/good smoke uses OS temp only" posture.

function initGitControlRoom(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

// `stdin`, when given, overrides the derived stop_hook_active JSON entirely
// -- used to feed malformed/empty payloads (review-1 repro).
function runCli(dir, { role, stopHookActive = false, stdin } = {}) {
  const env = { ...process.env };
  delete env.HARNESS_ROLE;
  if (role !== undefined) env.HARNESS_ROLE = role;
  const input = stdin !== undefined ? stdin : JSON.stringify({ stop_hook_active: stopHookActive });
  // spawnSync (not execFileSync) so stderr is captured regardless of exit
  // code -- a pass-through (exit 0) case still writes a diagnostic to
  // stderr, which execFileSync's throw-on-nonzero-only model would drop.
  const res = spawnSync("node", [SCRIPT_PATH, "--control-room", dir], { encoding: "utf8", env, input });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// Bad fixture: STATUS.md/PHASE-HANDOFF.md committed clean (so check ①
// dirty-cycle never fires), then STATUS.md's mtime is bumped far ahead of
// PHASE-HANDOFF.md's -- beyond DEFAULT_HANDOFF_THRESHOLD_MS -- to trigger
// check ② (handoff staleness) deterministically without depending on wall
// clock or a stale git commit.
function withBadControlRoom(fn) {
  withFixtureDir((dir) => {
    initGitControlRoom(dir);
    const statusPath = join(dir, "STATUS.md");
    const handoffPath = join(dir, "PHASE-HANDOFF.md");
    writeFileSync(statusPath, "status\n", "utf8");
    writeFileSync(handoffPath, "handoff\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const now = new Date();
    utimesSync(statusPath, now, now);
    utimesSync(handoffPath, new Date(now.getTime() - (DEFAULT_HANDOFF_THRESHOLD_MS + 3600000)), new Date(now.getTime() - (DEFAULT_HANDOFF_THRESHOLD_MS + 3600000)));
    fn(dir);
  });
}

function withGoodControlRoom(fn) {
  withFixtureDir((dir) => {
    initGitControlRoom(dir);
    writeFileSync(join(dir, "STATUS.md"), "status\n", "utf8");
    writeFileSync(join(dir, "PHASE-HANDOFF.md"), "handoff\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    fn(dir);
  });
}

test("(8) CLI: role=ORCH + confirmed handoff-stale failure + first attempt -> exit 2 with 4-field reason", () => {
  withBadControlRoom((dir) => {
    const result = runCli(dir, { role: "ORCH" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /reason_code=controlroom_stale/);
    assert.match(result.stderr, /repair_hint=/);
    assert.match(result.stderr, /attempt=1\/1/);
  });
});

test("(9) CLI: role=ORCH + fresh control room -> exit 0", () => {
  withGoodControlRoom((dir) => {
    const result = runCli(dir, { role: "ORCH" });
    assert.equal(result.status, 0);
  });
});

for (const role of ["PM", "CODER", "REVIEW", "VERIFY", undefined]) {
  test(`(10-${role ?? "unset"}) CLI: role=${role ?? "unset"} + confirmed failure -> exit 0 (blocking is ORCH-only)`, () => {
    withBadControlRoom((dir) => {
      const result = runCli(dir, { role });
      assert.equal(result.status, 0);
    });
  });
}

test("(11) CLI: role=ORCH + confirmed failure + stop_hook_active -> exit 0, not re-blocked", () => {
  withBadControlRoom((dir) => {
    const result = runCli(dir, { role: "ORCH", stopHookActive: true });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /stop_hook_active/);
  });
});

// --- review-1 rejected fix: malformed/empty stdin must never reach blocking
// severity (G3) -- these three cases are the exact review-1 regression set.

test("(13) CLI: role=ORCH + confirmed failure + malformed/non-JSON stdin -> exit 0, UNJUDGABLE (review-1 repro: previously exit 2)", () => {
  withBadControlRoom((dir) => {
    const result = runCli(dir, { role: "ORCH", stdin: "not-json" });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /reason_code=stop_payload_unreadable/);
  });
});

test("(14) CLI: role=ORCH + confirmed failure + empty stdin -> exit 0, UNJUDGABLE (review-1 repro: previously exit 2)", () => {
  withBadControlRoom((dir) => {
    const result = runCli(dir, { role: "ORCH", stdin: "" });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /reason_code=stop_payload_unreadable/);
  });
});

test("(15) CLI: role=ORCH + confirmed failure + valid '{}' stdin -> exit 2 (anchor: existing behavior must not regress)", () => {
  withBadControlRoom((dir) => {
    const result = runCli(dir, { role: "ORCH", stdin: "{}" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /reason_code=controlroom_stale/);
  });
});

test("(12) CLI: role=ORCH + absent control room path (uncertain) -> exit 0 (UNJUDGABLE, never blocks)", () => {
  const env = { ...process.env, HARNESS_ROLE: "ORCH" };
  const missingPath = join(tmpdir(), "controlroom-fresh-does-not-exist-" + Date.now());
  const result = execFileSync("node", [SCRIPT_PATH, "--control-room", missingPath], {
    encoding: "utf8",
    env,
    input: "{}",
  });
  assert.match(result, /vacuously ok/);
});
