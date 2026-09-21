import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkStatusFresh, DEFAULT_GRACE_MS } from "./status-fresh.mjs";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "status-fresh-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Base epoch far enough apart that OS mtime resolution never blurs the
// ordering between fixture files.
const T0 = new Date("2026-07-07T00:00:00+09:00");
function at(offsetSeconds) {
  return new Date(T0.getTime() + offsetSeconds * 1000);
}

function touch(path, content, mtime) {
  writeFileSync(path, content, "utf8");
  utimesSync(path, mtime, mtime);
}

test("(a) STATUS is the newest file -> fresh (ok)", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    touch(join(dir, "coder.md"), "task_id: HYK-1\n>>> DONE: CODER @ x\n", at(0));
    touch(statusPath, "status board\n", at(10));
    const result = checkStatusFresh({ statusPath, harnessDir: dir, headTime: null });
    assert.equal(result.ok, true);
  });
});

test("(b) worker result file newer than STATUS -> stale, reason names the file", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    touch(statusPath, "status board\n", at(0));
    touch(join(dir, "coder.md"), "task_id: HYK-1\n>>> DONE: CODER @ x\n", at(60));
    const result = checkStatusFresh({ statusPath, harnessDir: dir, headTime: null });
    assert.equal(result.ok, false);
    assert.match(result.reason, /STATUS stale/);
    assert.match(result.reason, /coder\.md/);
  });
});

test("(c) difference inside the grace window -> still fresh (not a false positive)", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    touch(statusPath, "status board\n", at(0));
    // 3s after STATUS.md, well inside the default 5s grace.
    touch(join(dir, "coder.md"), "task_id: HYK-1\n>>> DONE: CODER @ x\n", at(3));
    assert.ok(3000 < DEFAULT_GRACE_MS, "test assumption: 3s must be inside DEFAULT_GRACE_MS");
    const result = checkStatusFresh({ statusPath, harnessDir: dir, headTime: null });
    assert.equal(result.ok, true);
  });
});

test("(c2) difference just past the grace window -> stale", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    touch(statusPath, "status board\n", at(0));
    touch(join(dir, "coder.md"), "task_id: HYK-1\n>>> DONE: CODER @ x\n", at(DEFAULT_GRACE_MS / 1000 + 1));
    const result = checkStatusFresh({ statusPath, harnessDir: dir, headTime: null });
    assert.equal(result.ok, false);
  });
});

test("(d) only PHASE-HANDOFF.md is newer -> excluded from comparison, still fresh", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    touch(statusPath, "status board\n", at(0));
    touch(join(dir, "coder.md"), "task_id: HYK-1\n>>> DONE: CODER @ x\n", at(-30));
    touch(join(dir, "PHASE-HANDOFF.md"), "phase handoff\n", at(120));
    const result = checkStatusFresh({ statusPath, harnessDir: dir, headTime: null });
    assert.equal(result.ok, true);
  });
});

test("(e) Q&A turn: nothing in .harness changed, no new commit -> fresh (no false positive)", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    touch(join(dir, "coder.md"), "task_id: HYK-1\n>>> DONE: CODER @ x\n", at(-100));
    touch(statusPath, "status board\n", at(0));
    // Simulate a later turn where nothing changed: re-check without touching
    // any file. Nothing is newer than STATUS.md, so it stays fresh.
    const result = checkStatusFresh({ statusPath, harnessDir: dir, headTime: null });
    assert.equal(result.ok, true);
  });
});

test("(f) STATUS file itself missing -> blocked, not silently ok", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    touch(join(dir, "coder.md"), "task_id: HYK-1\n>>> DONE: CODER @ x\n", at(0));
    const result = checkStatusFresh({ statusPath, harnessDir: dir, headTime: null });
    assert.equal(result.ok, false);
    assert.match(result.reason, /STATUS file not found/);
  });
});

test("(g) HEAD commit time newer than STATUS -> stale, reason names HEAD commit", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    touch(statusPath, "status board\n", at(0));
    const result = checkStatusFresh({ statusPath, harnessDir: dir, headTime: at(60) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /HEAD commit/);
  });
});

test("(h) HEAD commit time older than STATUS, no work files -> fresh", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    touch(statusPath, "status board\n", at(60));
    const result = checkStatusFresh({ statusPath, harnessDir: dir, headTime: at(0) });
    assert.equal(result.ok, true);
  });
});

test("(i) no work files, no HEAD time (null) -> vacuously fresh", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    touch(statusPath, "status board\n", at(0));
    const result = checkStatusFresh({ statusPath, harnessDir: dir, headTime: null });
    assert.equal(result.ok, true);
  });
});

test("(j) harnessDir does not exist at all -> falls back to HEAD-only comparison, fresh", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    touch(statusPath, "status board\n", at(60));
    const missingHarnessDir = join(dir, "does-not-exist");
    const result = checkStatusFresh({ statusPath, harnessDir: missingHarnessDir, headTime: at(0) });
    assert.equal(result.ok, true);
  });
});
