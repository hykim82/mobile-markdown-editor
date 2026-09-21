// HYK-257-done-stamp-2/3 §2 범위1 -- unit tests for the "첫 관측 기록"
// channel (first-observation.mjs). Uses a fresh absolute temp dir per test
// (§5 constraint: never delete -- mkdtempSync only, listed in the round's
// report, no cleanup command run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  observeDoneLine,
  recordFirstDoneObservation,
  markObservationConsumed,
  checkIntermediateRewrite,
  findFirstObservation,
  hasCorruptEntries,
} from "./first-observation.mjs";

const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "first-observation.mjs",
);

function freshDir() {
  return mkdtempSync(join(tmpdir(), "hyk257-3r-first-obs-test-"));
}

test("observeDoneLine: first-ever observation compares against itself -- rewritten:false (오탐 0)", () => {
  const harnessDir = freshDir();
  const outcome = observeDoneLine({
    taskId: "task_abc",
    droppedAt: "2026-08-17 05:30 KST",
    role: "coder",
    harnessDir,
    resultContent:
      "task_id: task_abc\n>>> DONE: CODER @ 2026-08-17 05:37:54 KST\n",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-17 05:37:54 KST",
  });
  assert.equal(outcome.rewritten, false);
  const stored = findFirstObservation({
    taskId: "task_abc",
    droppedAt: "2026-08-17 05:30 KST",
    role: "coder",
    harnessDir,
  });
  assert.ok(stored);
  assert.equal(stored.taskId, "task_abc");
  assert.equal(stored.droppedAt, "2026-08-17 05:30 KST");
  assert.equal(stored.doneLineRaw, ">>> DONE: CODER @ 2026-08-17 05:37:54 KST");
});

test("observeDoneLine: second observation with SAME content stays rewritten:false", () => {
  const harnessDir = freshDir();
  const args = {
    taskId: "task_same",
    droppedAt: "2026-08-17 06:00 KST",
    role: "coder",
    harnessDir,
    resultContent:
      "task_id: task_same\n>>> DONE: CODER @ 2026-08-17 06:00:00 KST\n",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-17 06:00:00 KST",
  };
  const first = observeDoneLine(args);
  const second = observeDoneLine(args);
  assert.equal(first.rewritten, false);
  assert.equal(second.rewritten, false);
});

test("observeDoneLine: second observation with DIFFERENT DONE line -- rewritten:true (intermediate rewrite detected)", () => {
  const harnessDir = freshDir();
  const taskId = "task_rewrite";
  const droppedAt = "2026-08-17 05:30 KST";
  const role = "coder";
  const firstOutcome = observeDoneLine({
    taskId,
    droppedAt,
    role,
    harnessDir,
    resultContent:
      "task_id: task_rewrite\n>>> DONE: CODER @ 2026-08-17 05:44:12 KST\n",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-17 05:44:12 KST",
  });
  assert.equal(firstOutcome.rewritten, false);

  const secondOutcome = observeDoneLine({
    taskId,
    droppedAt,
    role,
    harnessDir,
    resultContent:
      "task_id: task_rewrite\n>>> DONE: CODER @ 2026-08-17 05:37:54 KST\n",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-17 05:37:54 KST",
  });
  assert.equal(secondOutcome.rewritten, true);
  assert.equal(
    secondOutcome.existing.doneLineRaw,
    ">>> DONE: CODER @ 2026-08-17 05:44:12 KST",
  );
  assert.equal(
    secondOutcome.currentDoneLine,
    ">>> DONE: CODER @ 2026-08-17 05:37:54 KST",
  );
});

test("recordFirstDoneObservation: does not overwrite an existing entry for the same (taskId, droppedAt) generation (append-only)", () => {
  const harnessDir = freshDir();
  const taskId = "task_appendonly";
  const droppedAt = "2026-08-17 06:20 KST";
  const role = "review";
  const r1 = recordFirstDoneObservation({
    taskId,
    droppedAt,
    role,
    harnessDir,
    resultContent: "v1",
    doneLineRaw: ">>> DONE: REVIEW @ 2026-08-17 06:26:36 KST",
  });
  assert.equal(r1.recorded, true);
  const r2 = recordFirstDoneObservation({
    taskId,
    droppedAt,
    role,
    harnessDir,
    resultContent: "v2 -- different content",
    doneLineRaw: ">>> DONE: REVIEW @ 2026-08-17 06:09:47 KST",
  });
  assert.equal(r2.recorded, false);
  const stored = findFirstObservation({ taskId, droppedAt, role, harnessDir });
  assert.equal(
    stored.doneLineRaw,
    ">>> DONE: REVIEW @ 2026-08-17 06:26:36 KST",
  );
});

test("checkIntermediateRewrite: no prior observation -- rewritten:false, distinct reason", () => {
  const harnessDir = freshDir();
  const outcome = checkIntermediateRewrite({
    taskId: "task_never_seen",
    droppedAt: "2026-08-17 10:00 KST",
    role: "coder",
    harnessDir,
    resultContent: "anything",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-17 10:46:39 KST",
  });
  assert.equal(outcome.rewritten, false);
  assert.equal(outcome.reason, "no prior observation");
});

test("different taskIds under the same role/harnessDir do not interfere with each other", () => {
  const harnessDir = freshDir();
  const role = "verify";
  observeDoneLine({
    taskId: "task_x",
    droppedAt: "2026-08-17 01:00 KST",
    role,
    harnessDir,
    resultContent: "x-content",
    doneLineRaw: ">>> DONE: VERIFY @ 2026-08-17 01:00:00 KST",
  });
  const outcomeY = observeDoneLine({
    taskId: "task_y",
    droppedAt: "2026-08-17 02:00 KST",
    role,
    harnessDir,
    resultContent: "y-content",
    doneLineRaw: ">>> DONE: VERIFY @ 2026-08-17 02:00:00 KST",
  });
  assert.equal(
    outcomeY.rewritten,
    false,
    "task_y's first observation must not be flagged as a rewrite of task_x's entry",
  );
});

// HYK-257-done-stamp-3 §2 범위1 (2R 반려 수리 -- 라운드 분리 자체) -----------

test("HYK-257-done-stamp-3: same taskId, DIFFERENT droppedAt -- two legitimate rounds do NOT collide (record has separate droppedAt field, not a concatenated key)", () => {
  const harnessDir = freshDir();
  const taskId = "HYK-257-done-stamp-3"; // same task_id reused across rounds -- normal (HYK-241)
  const role = "coder";

  // Round 1R
  const round1 = observeDoneLine({
    taskId,
    droppedAt: "2026-08-17 12:04 KST",
    role,
    harnessDir,
    resultContent: "round1 body",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-17 12:10:00 KST",
  });
  assert.equal(
    round1.rewritten,
    false,
    "round 1's own first observation must not self-flag",
  );
  // (production would call markObservationConsumed here once round 1 is
  // judged ok:true -- this test exercises the case WITHOUT that call too,
  // to prove droppedAt alone already separates the generations)

  // Round 2R -- same taskId, genuinely different droppedAt, different DONE value.
  const round2 = observeDoneLine({
    taskId,
    droppedAt: "2026-08-17 12:57 KST",
    role,
    harnessDir,
    resultContent: "round2 body",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-17 13:05:00 KST",
  });
  assert.equal(
    round2.rewritten,
    false,
    "round 2 must NOT be flagged as an intermediate rewrite of round 1 -- 2R's bug: a taskId-only key collapsed these into one generation",
  );

  // The stored record for round 1 must carry its OWN droppedAt, not a
  // mangled composite string in the taskId field (2R's exact reported bug).
  const round1Entry = findFirstObservation({
    taskId,
    droppedAt: "2026-08-17 12:04 KST",
    role,
    harnessDir,
  });
  assert.equal(round1Entry.taskId, taskId);
  assert.equal(round1Entry.droppedAt, "2026-08-17 12:04 KST");
});

test("HYK-257-done-stamp-3: 로그 수명 -- round 1 CONSUMED, round 2 reuses the EXACT SAME (taskId, droppedAt) key (분-정밀도 충돌) -- round 2 must NOT be flagged", () => {
  const harnessDir = freshDir();
  const taskId = "task_collision";
  const droppedAt = "2026-08-17 12:41 KST"; // same minute-precision value for both rounds -- the 2R-missed edge case
  const role = "review";

  // Round 1: observed, then judged complete (consumed).
  const round1 = observeDoneLine({
    taskId,
    droppedAt,
    role,
    harnessDir,
    resultContent: "round1 final body",
    doneLineRaw: ">>> DONE: REVIEW @ 2026-08-17 12:45:00 KST",
  });
  assert.equal(round1.rewritten, false);
  const consumed = markObservationConsumed({
    taskId,
    droppedAt,
    role,
    harnessDir,
  });
  assert.equal(consumed.recorded, true);

  // A stray THIRD poll on round 1's own (already-consumed) generation must
  // still see it as "no active observation" from here on (fully closed) --
  // not strictly required by production (nothing polls after ok:true), but
  // pins the exact tombstone semantics.
  assert.equal(
    findFirstObservation({ taskId, droppedAt, role, harnessDir }),
    null,
  );

  // Round 2: a DIFFERENT round's worth of content, but happens to collide
  // on the exact same (taskId, droppedAt) pair (2R's missed scenario).
  const round2 = observeDoneLine({
    taskId,
    droppedAt,
    role,
    harnessDir,
    resultContent: "round2 completely different body",
    doneLineRaw: ">>> DONE: REVIEW @ 2026-08-17 13:02:00 KST",
  });
  assert.equal(
    round2.rewritten,
    false,
    "round 2 must start a clean generation -- round 1's consumed entry must not leak forward and false-flag it",
  );

  // And round 2's OWN generation is now active and would correctly still
  // catch a genuine intermediate rewrite within itself.
  const round2Rewrite = checkIntermediateRewrite({
    taskId,
    droppedAt,
    role,
    harnessDir,
    resultContent: "round2 tampered",
    doneLineRaw: ">>> DONE: REVIEW @ 2026-08-17 13:05:00 KST",
  });
  assert.equal(
    round2Rewrite.rewritten,
    true,
    "round 2's own generation must still detect a real intermediate rewrite within itself",
  );
});

test("HYK-257-done-stamp-3: normal 1R -> 2R end-to-end sequence (production shape) -- 오탐 0", () => {
  const harnessDir = freshDir();
  const taskId = "HYK-257-normal-sequence";
  const role = "coder";

  // Round 1: single poll observes the final value directly (no intermediate
  // rewrite), round judged complete, consumed.
  const r1 = observeDoneLine({
    taskId,
    droppedAt: "2026-08-17 09:00 KST",
    role,
    harnessDir,
    resultContent: "r1 body final",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-17 09:05:00 KST",
  });
  assert.equal(r1.rewritten, false);
  markObservationConsumed({
    taskId,
    droppedAt: "2026-08-17 09:00 KST",
    role,
    harnessDir,
  });

  // Round 2: new dropped_at (normal ORCH re-drop), single poll observes the
  // final value directly again.
  const r2 = observeDoneLine({
    taskId,
    droppedAt: "2026-08-17 09:30 KST",
    role,
    harnessDir,
    resultContent: "r2 body final",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-17 09:35:00 KST",
  });
  assert.equal(
    r2.rewritten,
    false,
    "round 2 (normal, no tampering) must pass cleanly after round 1's consumption",
  );
});

// HYK-353 2R §1 (P1-1) -----------------------------------------------------

test("observeDoneLine: successful first record -- returned `record` field says recorded:true", () => {
  const harnessDir = freshDir();
  const outcome = observeDoneLine({
    taskId: "task_record_success",
    droppedAt: "2026-08-25 09:00 KST",
    role: "coder",
    harnessDir,
    resultContent:
      "task_id: task_record_success\n>>> DONE: CODER @ 2026-08-25 09:05:00 KST\n",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-25 09:05:00 KST",
  });
  assert.equal(outcome.record.recorded, true);
});

test("observeDoneLine: second poll of the SAME generation -- `record` says recorded:false, reason 'already observed' (NOT a failure)", () => {
  const harnessDir = freshDir();
  const args = {
    taskId: "task_record_already",
    droppedAt: "2026-08-25 09:10 KST",
    role: "coder",
    harnessDir,
    resultContent:
      "task_id: task_record_already\n>>> DONE: CODER @ 2026-08-25 09:15:00 KST\n",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-25 09:15:00 KST",
  };
  observeDoneLine(args);
  const second = observeDoneLine(args);
  assert.equal(second.record.recorded, false);
  assert.equal(second.record.reason, "already observed");
});

test("observeDoneLine: the log path itself is a directory -- write fails, `record` surfaces recorded:false with a 'record failed:' reason", () => {
  const harnessDir = freshDir();
  mkdirSync(join(harnessDir, "coder-done-first-observation.jsonl"));
  const outcome = observeDoneLine({
    taskId: "task_write_failure",
    droppedAt: "2026-08-25 09:20 KST",
    role: "coder",
    harnessDir,
    resultContent:
      "task_id: task_write_failure\n>>> DONE: CODER @ 2026-08-25 09:25:00 KST\n",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-25 09:25:00 KST",
  });
  assert.equal(outcome.record.recorded, false);
  assert.match(
    outcome.record.reason,
    /^record failed:/,
    `must be distinguishable from the 'already observed' shape: ${JSON.stringify(outcome.record)}`,
  );
});

// HYK-353 2R §1 (P2-2) -------------------------------------------------------

test("CLI: stdin cut before any payload arrives -- usage error carries the 'first-observation: ' prefix (machine-distinguishable from a missing sidecar file)", () => {
  const res = spawnSync(process.execPath, [CLI_PATH, "somedir"], {
    encoding: "utf8",
    input: "",
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /^first-observation: usage: /);
});

// HYK-353 3R §2 (책임자 판정 2026-08-25 22:16, 범위 한 줄 한정) -----------

test("hasCorruptEntries: log missing entirely -> false (없음, not 모름)", () => {
  const harnessDir = freshDir();
  assert.equal(hasCorruptEntries("coder", harnessDir), false);
});

test("hasCorruptEntries: log exists, every line parses -> false", () => {
  const harnessDir = freshDir();
  observeDoneLine({
    taskId: "task_clean",
    droppedAt: "2026-08-25 10:00 KST",
    role: "coder",
    harnessDir,
    resultContent:
      "task_id: task_clean\n>>> DONE: CODER @ 2026-08-25 10:05:00 KST\n",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-25 10:05:00 KST",
  });
  assert.equal(hasCorruptEntries("coder", harnessDir), false);
});

test("hasCorruptEntries: log has one unparseable line -> true, regardless of which round it would have belonged to", () => {
  const harnessDir = freshDir();
  writeFileSync(
    join(harnessDir, "coder-done-first-observation.jsonl"),
    "{ not valid json\n",
    "utf8",
  );
  assert.equal(hasCorruptEntries("coder", harnessDir), true);
});

test("hasCorruptEntries: one valid entry + one corrupted line -> still true (corruption anywhere blocks judgment)", () => {
  const harnessDir = freshDir();
  observeDoneLine({
    taskId: "task_mixed",
    droppedAt: "2026-08-25 11:00 KST",
    role: "coder",
    harnessDir,
    resultContent:
      "task_id: task_mixed\n>>> DONE: CODER @ 2026-08-25 11:05:00 KST\n",
    doneLineRaw: ">>> DONE: CODER @ 2026-08-25 11:05:00 KST",
  });
  appendFileSync(
    join(harnessDir, "coder-done-first-observation.jsonl"),
    "{ garbage\n",
    "utf8",
  );
  assert.equal(hasCorruptEntries("coder", harnessDir), true);
});
