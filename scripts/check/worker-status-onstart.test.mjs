import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isGoPrompt,
  extractTaskId,
  buildStatusLabel,
  applyStatusUpdate,
  computeUpdate,
  findSection1Bounds,
  checkTrackMatch,
} from "./worker-status-onstart.mjs";

const STATUS_FIXTURE = `# STATUS

## A

### 1) table
| 역할 | 다음 할 일 | 갱신 |
|---|---|---|
| 👤 **사람** | 대기 | 2026-07-11 20:00 |
| ORCH | 대기 | 2026-07-11 20:00 |
| PM | IDLE | 2026-07-11 19:50 |
| CODER | 대기 — HYK-110-coder-1 드롭됨, "go" 대기 | 2026-07-11 21:07 |
| REVIEW | IDLE | 2026-07-11 21:07 |
| VERIFY | IDLE | 2026-07-07 02:17 |

## B
other content
`;

test("(1) isGoPrompt: bare 'go' matches", () => {
  assert.equal(isGoPrompt("go"), true);
});

test("(2) isGoPrompt: 'go HYK-110-coder-1' matches", () => {
  assert.equal(isGoPrompt("go HYK-110-coder-1"), true);
});

test("(3) isGoPrompt: leading whitespace tolerated", () => {
  assert.equal(isGoPrompt("  go now"), true);
});

test("(4) isGoPrompt: 'gogo' does not match (no word boundary after 'go')", () => {
  assert.equal(isGoPrompt("gogo"), false);
});

test("(5) isGoPrompt: '완료' does not match", () => {
  assert.equal(isGoPrompt("완료"), false);
});

test("(6) isGoPrompt: non-string prompt does not match", () => {
  assert.equal(isGoPrompt(undefined), false);
});

test("(7) extractTaskId: reads task_id header", () => {
  assert.equal(
    extractTaskId("task_id: HYK-110-coder-1\ndropped_at: ...\n"),
    "HYK-110-coder-1",
  );
});

test("(8) extractTaskId: missing header returns null", () => {
  assert.equal(extractTaskId("no header here\n"), null);
});

test("(9) extractTaskId: non-string content returns null", () => {
  assert.equal(extractTaskId(null), null);
});

test("(10) buildStatusLabel: non-PM role uses 🔨 작업중", () => {
  assert.equal(
    buildStatusLabel("CODER", "HYK-110-coder-1"),
    "🔨 작업중: HYK-110-coder-1",
  );
});

test("(11) buildStatusLabel: PM role uses 📝 기획중", () => {
  assert.equal(buildStatusLabel("PM", "HYK-1-pm-1"), "📝 기획중: HYK-1-pm-1");
});

test("(12) applyStatusUpdate: replaces exactly the CODER row, other rows untouched", () => {
  const result = applyStatusUpdate({
    statusText: STATUS_FIXTURE,
    role: "CODER",
    label: "🔨 작업중: HYK-110-coder-1",
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(result.ok, true);
  assert.match(
    result.updatedText,
    /\| CODER \| 🔨 작업중: HYK-110-coder-1 \| 2026-07-11 21:11 \|/,
  );
  // every other row's exact original line survives untouched
  assert.match(
    result.updatedText,
    /\| 👤 \*\*사람\*\* \| 대기 \| 2026-07-11 20:00 \|/,
  );
  assert.match(result.updatedText, /\| ORCH \| 대기 \| 2026-07-11 20:00 \|/);
  assert.match(result.updatedText, /\| PM \| IDLE \| 2026-07-11 19:50 \|/);
  assert.match(result.updatedText, /\| REVIEW \| IDLE \| 2026-07-11 21:07 \|/);
  assert.match(result.updatedText, /\| VERIFY \| IDLE \| 2026-07-07 02:17 \|/);
  // everything outside the table (headings, section B) is untouched too
  assert.match(result.updatedText, /## B\nother content/);
});

test("(13) applyStatusUpdate: replaced row keeps the same 3-cell pipe format", () => {
  const result = applyStatusUpdate({
    statusText: STATUS_FIXTURE,
    role: "CODER",
    label: "🔨 작업중: HYK-110-coder-1",
    nowStr: "2026-07-11 21:11",
  });
  const line = result.updatedText
    .split("\n")
    .find((l) => l.startsWith("| CODER |"));
  assert.equal((line.match(/\|/g) || []).length, 4);
});

test("(14) applyStatusUpdate: PM row replaced with 📝 기획중 phrasing", () => {
  const result = applyStatusUpdate({
    statusText: STATUS_FIXTURE,
    role: "PM",
    label: "📝 기획중: HYK-1-pm-1",
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(result.ok, true);
  assert.match(
    result.updatedText,
    /\| PM \| 📝 기획중: HYK-1-pm-1 \| 2026-07-11 21:11 \|/,
  );
});

test("(15) applyStatusUpdate: no matching row -> ok:false, text unaffected", () => {
  const result = applyStatusUpdate({
    statusText: STATUS_FIXTURE,
    role: "NOPE",
    label: "x",
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(result.ok, false);
});

test("(16) computeUpdate: non-go prompt -> noop, no STATUS touched", () => {
  const decision = computeUpdate({
    prompt: "완료",
    role: "CODER",
    taskContent: "task_id: HYK-110-coder-1\n",
    statusText: STATUS_FIXTURE,
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(decision.action, "noop");
});

test("(17) computeUpdate: unregulated role (ORCH) -> noop", () => {
  const decision = computeUpdate({
    prompt: "go HYK-110-coder-1",
    role: "ORCH",
    taskContent: "task_id: HYK-110-coder-1\n",
    statusText: STATUS_FIXTURE,
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(decision.action, "noop");
});

test("(18) computeUpdate: unset role -> noop", () => {
  const decision = computeUpdate({
    prompt: "go HYK-110-coder-1",
    role: undefined,
    taskContent: "task_id: HYK-110-coder-1\n",
    statusText: STATUS_FIXTURE,
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(decision.action, "noop");
});

test("(19) computeUpdate: missing task_id in task content -> warn (fail-open), no write", () => {
  const decision = computeUpdate({
    prompt: "go",
    role: "CODER",
    taskContent: "no task_id here\n",
    statusText: STATUS_FIXTURE,
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(decision.action, "warn");
});

test("(20) computeUpdate: null task content (file not found) -> warn (fail-open)", () => {
  const decision = computeUpdate({
    prompt: "go",
    role: "CODER",
    taskContent: null,
    statusText: STATUS_FIXTURE,
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(decision.action, "warn");
});

test("(21) computeUpdate: full go path for CODER -> write with correct label/taskId", () => {
  const decision = computeUpdate({
    prompt: "go HYK-110-coder-1",
    role: "CODER",
    taskContent: "task_id: HYK-110-coder-1\ndropped_at: 2026-07-11 21:05 KST\n",
    statusText: STATUS_FIXTURE,
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(decision.action, "write");
  assert.equal(decision.taskId, "HYK-110-coder-1");
  assert.equal(decision.label, "🔨 작업중: HYK-110-coder-1");
  assert.match(
    decision.updatedText,
    /\| CODER \| 🔨 작업중: HYK-110-coder-1 \| 2026-07-11 21:11 \|/,
  );
});

test("(22) computeUpdate: full go path for PM -> write with 📝 기획중 label", () => {
  const decision = computeUpdate({
    prompt: "go HYK-1-pm-1",
    role: "PM",
    taskContent: "task_id: HYK-1-pm-1\ndropped_at: 2026-07-11 21:05 KST\n",
    statusText: STATUS_FIXTURE,
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(decision.action, "write");
  assert.match(
    decision.updatedText,
    /\| PM \| 📝 기획중: HYK-1-pm-1 \| 2026-07-11 21:11 \|/,
  );
});

test("(23) computeUpdate: STATUS row missing for role -> warn (fail-open)", () => {
  const decision = computeUpdate({
    prompt: "go",
    role: "REVIEW",
    taskContent: "task_id: HYK-1-review-1\n",
    statusText: "# STATUS\nno table here\n",
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(decision.action, "warn");
});

// --- round 2: independent review reproduced a real mis-scoping bug --
// round-1's row regex searched the *whole file*, not just §1, so a
// same-shaped `| ROLE | ... | ... |` line sitting in a different section
// (e.g. free-text data under §5/§6) could be mis-replaced whenever §1 had
// no row for that role at all. The fix scopes the search to §1's own body
// first (findSection1Bounds) before ever looking for a role's row.

const REPRO_NO_SECTION1_ROW_BUT_B_HAS_LOOKALIKE = `# STATUS

## A

### 1) table
| 역할 | 다음 할 일 | 갱신 |
|---|---|---|
| REVIEW | IDLE | 2026-07-11 21:07 |

## B
| CODER | B-section data | old |
`;

test("(24) round-2 repro: no CODER row in §1, but a look-alike CODER row exists in §B -> ok:false, input fully unchanged (the exact bug an independent review reproduced)", () => {
  const result = applyStatusUpdate({
    statusText: REPRO_NO_SECTION1_ROW_BUT_B_HAS_LOOKALIKE,
    role: "CODER",
    label: "🔨 작업중: HYK-1",
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(result.ok, false);
  // No updatedText is produced at all on the fail-open path -- there is
  // nothing for a caller to accidentally write back, so §B's look-alike
  // row (still present in the untouched original fixture) can never reach
  // disk in a mis-replaced form. This is the exact mis-replacement round-1
  // was capable of and round-2 closes structurally, not just by luck.
  assert.equal(result.updatedText, undefined);
  assert.match(
    REPRO_NO_SECTION1_ROW_BUT_B_HAS_LOOKALIKE,
    /\| CODER \| B-section data \| old \|/,
  );
});

const BOTH_SECTION1_AND_B_HAVE_CODER_ROW = `# STATUS

## A

### 1) table
| 역할 | 다음 할 일 | 갱신 |
|---|---|---|
| CODER | 대기 | 2026-07-11 20:00 |

## B
| CODER | B-section data | old |
`;

test("(25) round-2: §1 has a CODER row AND §B has a look-alike CODER row -> only §1's row is replaced, §B stays byte-for-byte", () => {
  const result = applyStatusUpdate({
    statusText: BOTH_SECTION1_AND_B_HAVE_CODER_ROW,
    role: "CODER",
    label: "🔨 작업중: HYK-1",
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(result.ok, true);
  assert.match(
    result.updatedText,
    /### 1\) table\n\| 역할 \| 다음 할 일 \| 갱신 \|\n\|---\|---\|---\|\n\| CODER \| 🔨 작업중: HYK-1 \| 2026-07-11 21:11 \|/,
  );
  // §B's row is untouched -- still the old literal text, not the new label.
  assert.match(
    result.updatedText,
    /## B\n\| CODER \| B-section data \| old \|/,
  );
});

test("(26) round-2: no '### 1)'-style heading at all -> ok:false, fail-open", () => {
  const noHeadingText = "# STATUS\n## A\n| CODER | data | old |\n";
  const result = applyStatusUpdate({
    statusText: noHeadingText,
    role: "CODER",
    label: "🔨 작업중: HYK-1",
    nowStr: "2026-07-11 21:11",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no STATUS §1 heading found/);
});

test("(27) findSection1Bounds: returns null when no §1 heading exists", () => {
  assert.equal(
    findSection1Bounds("# STATUS\n## A\nno numbered heading\n"),
    null,
  );
});

test("(28) findSection1Bounds: bounds stop at the next heading, regardless of level", () => {
  const bounds = findSection1Bounds(STATUS_FIXTURE);
  const body = STATUS_FIXTURE.slice(bounds.bodyStart, bounds.bodyEnd);
  assert.match(body, /\| CODER \|/);
  assert.doesNotMatch(body, /## B/);
});

// --- round 3: independent review reproduced a second real bug --
// round-2 correctly scoped the row search to §1's body, but the row
// regex's own trailing `\s*` (before its final `$`) could still consume
// the row's own newline(s) -- and did, specifically whenever the matched
// row was the *last* row inside §1's body, because `sectionBody` itself
// (produced by findSection1Bounds) ends exactly at the next heading's
// start. For that row only, `\s*` could greedily eat every trailing
// newline via the end-of-string form of `$` (no internal `\n` left to
// force an earlier backtrack stop), gluing the replaced row directly onto
// the next heading with zero newlines in between. Fixed by restricting the
// trailing whitespace class to non-newline characters (`[^\S\r\n]*`).

const LAST_ROW_DIRECTLY_BEFORE_NEXT_HEADING = `# STATUS

## A

### 1) table
| 역할 | 다음 할 일 | 갱신 |
|---|---|---|
| CODER | one | old |
### 2) next
content here
`;

test("(29) round-3 repro: §1's last row sits directly before '### 2)' -> replacing it preserves the newline and heading structure (the exact bug an independent review reproduced)", () => {
  const beforeLineCount =
    LAST_ROW_DIRECTLY_BEFORE_NEXT_HEADING.split("\n").length;
  const result = applyStatusUpdate({
    statusText: LAST_ROW_DIRECTLY_BEFORE_NEXT_HEADING,
    role: "CODER",
    label: "🔨 작업중: HYK-1",
    nowStr: "2026-07-11 22:00",
  });
  assert.equal(result.ok, true);
  // The row and the next heading must NOT be glued together.
  assert.doesNotMatch(result.updatedText, /\|### 2\)/);
  assert.match(
    result.updatedText,
    /\| CODER \| 🔨 작업중: HYK-1 \| 2026-07-11 22:00 \|\n### 2\) next\ncontent here\n/,
  );
  assert.equal(result.updatedText.split("\n").length, beforeLineCount);
});

const REAL_SHAPED_VERIFY_LAST_ROW = `# STATUS

## A

### 1) 다음 행동
| 역할 | 다음 할 일 | 갱신 |
|---|---|---|
| CODER | IDLE | 2026-07-11 21:48 |
| REVIEW | IDLE | 2026-07-11 21:59 |
| VERIFY | IDLE | 2026-07-07 02:17 |

### 2) 한 줄 상태
some status line
`;

test("(30) round-3: VERIFY as §1's last row (matching the real STATUS.md shape) -> structure fully intact after replacement", () => {
  const beforeLineCount = REAL_SHAPED_VERIFY_LAST_ROW.split("\n").length;
  const result = applyStatusUpdate({
    statusText: REAL_SHAPED_VERIFY_LAST_ROW,
    role: "VERIFY",
    label: "🔨 작업중: HYK-1-verify-1",
    nowStr: "2026-07-11 22:00",
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.updatedText, /\|### 2\)/);
  assert.match(
    result.updatedText,
    /\| VERIFY \| 🔨 작업중: HYK-1-verify-1 \| 2026-07-11 22:00 \|\n\n### 2\) 한 줄 상태\nsome status line\n/,
  );
  // every other row in §1 must survive untouched
  assert.match(result.updatedText, /\| CODER \| IDLE \| 2026-07-11 21:48 \|/);
  assert.match(result.updatedText, /\| REVIEW \| IDLE \| 2026-07-11 21:59 \|/);
  assert.equal(result.updatedText.split("\n").length, beforeLineCount);
});

const EOF_NO_TRAILING_NEWLINE = `# STATUS

### 1) table
| 역할 | 다음 할 일 | 갱신 |
|---|---|---|
| CODER | one | old |`;

test("(31) round-3 edge: §1's last row is also the literal end of file (no trailing newline at all) -> still replaces safely", () => {
  const result = applyStatusUpdate({
    statusText: EOF_NO_TRAILING_NEWLINE,
    role: "CODER",
    label: "🔨 작업중: HYK-1",
    nowStr: "2026-07-11 22:00",
  });
  assert.equal(result.ok, true);
  assert.equal(
    result.updatedText,
    `# STATUS\n\n### 1) table\n| 역할 | 다음 할 일 | 갱신 |\n|---|---|---|\n| CODER | 🔨 작업중: HYK-1 | 2026-07-11 22:00 |`,
  );
});

// ---------------------------------------------------------------------------
// HYK-152: track-consistency hardening (checkTrackMatch, G8)
// ---------------------------------------------------------------------------

const REPO_ROOT = "C:/Users/Administrator/Documents/HARNESSENGINEERING";
const OTHER_ROOT = "C:/Users/Administrator/Documents/TEAM10";

const STATUS_FIXTURE_WITH_MARKER = `<!-- harness-track-root: ${REPO_ROOT} -->
${STATUS_FIXTURE}`;

test("(32) checkTrackMatch: repoRoot omitted -> SKIP (pure-function backward compat, not a live loophole -- CLI always passes it)", () => {
  const result = checkTrackMatch({ statusText: STATUS_FIXTURE });
  assert.equal(result.status, "SKIP");
});

test("(33) known-bad: no '<!-- harness-track-root -->' marker in STATUS at all -> STATUS_TARGET_UNJUDGABLE", () => {
  const result = checkTrackMatch({
    statusText: STATUS_FIXTURE,
    repoRoot: REPO_ROOT,
  });
  assert.equal(result.status, "UNJUDGABLE");
  assert.match(result.reason, /^STATUS_TARGET_UNJUDGABLE/);
});

test("(34) known-bad: repoRoot itself unresolvable (empty string) -> STATUS_TARGET_UNJUDGABLE", () => {
  const result = checkTrackMatch({
    statusText: STATUS_FIXTURE_WITH_MARKER,
    repoRoot: "",
  });
  assert.equal(result.status, "UNJUDGABLE");
  assert.match(result.reason, /^STATUS_TARGET_UNJUDGABLE/);
});

test("(35) known-bad: STATUS declares a DIFFERENT track root (HYK-152's real incident shape -- TEAM10 task, harness control-room STATUS) -> STATUS_TRACK_MISMATCH", () => {
  const teamStatus = `<!-- harness-track-root: ${OTHER_ROOT} -->\n${STATUS_FIXTURE}`;
  const result = checkTrackMatch({
    statusText: teamStatus,
    repoRoot: REPO_ROOT,
  });
  assert.equal(result.status, "MISMATCH");
  assert.match(result.reason, /^STATUS_TRACK_MISMATCH/);
});

test("(36) paired good: same STATUS, marker corrected to the actual repo root -> OK (single-variable fix)", () => {
  const result = checkTrackMatch({
    statusText: STATUS_FIXTURE_WITH_MARKER,
    repoRoot: REPO_ROOT,
  });
  assert.equal(result.status, "OK");
});

test("(37) checkTrackMatch: comparison is OS/case/trailing-slash agnostic (Windows path realism)", () => {
  const result = checkTrackMatch({
    statusText: STATUS_FIXTURE_WITH_MARKER,
    repoRoot: "c:\\users\\administrator\\documents\\harnessengineering\\",
  });
  assert.equal(result.status, "OK");
});

test("(38) known-bad: computeUpdate end-to-end -- track mismatch blocks the write entirely, decision.action stays 'warn'", () => {
  const teamStatus = `<!-- harness-track-root: ${OTHER_ROOT} -->\n${STATUS_FIXTURE}`;
  const decision = computeUpdate({
    prompt: "go HYK-110-coder-1",
    role: "CODER",
    taskContent: "task_id: HYK-110-coder-1\ndropped_at: 2026-07-11 21:05 KST\n",
    statusText: teamStatus,
    nowStr: "2026-07-11 21:11",
    repoRoot: REPO_ROOT,
  });
  assert.equal(decision.action, "warn");
  assert.match(decision.reason, /^STATUS_TRACK_MISMATCH/);
});

test("(39) paired good: computeUpdate end-to-end -- matching track root, same task/prompt -> write succeeds (single-variable fix from test 38)", () => {
  const decision = computeUpdate({
    prompt: "go HYK-110-coder-1",
    role: "CODER",
    taskContent: "task_id: HYK-110-coder-1\ndropped_at: 2026-07-11 21:05 KST\n",
    statusText: STATUS_FIXTURE_WITH_MARKER,
    nowStr: "2026-07-11 21:11",
    repoRoot: REPO_ROOT,
  });
  assert.equal(decision.action, "write");
  assert.match(
    decision.updatedText,
    /\| CODER \| 🔨 작업중: HYK-110-coder-1 \| 2026-07-11 21:11 \|/,
  );
});

test("(40) G8: on a successful track-matched write, only the CODER row changes -- every other §1 row is byte-identical before/after", () => {
  const decision = computeUpdate({
    prompt: "go HYK-110-coder-1",
    role: "CODER",
    taskContent: "task_id: HYK-110-coder-1\ndropped_at: 2026-07-11 21:05 KST\n",
    statusText: STATUS_FIXTURE_WITH_MARKER,
    nowStr: "2026-07-11 21:11",
    repoRoot: REPO_ROOT,
  });
  assert.equal(decision.action, "write");
  const otherRoleLines = [
    "| 👤 **사람** | 대기 | 2026-07-11 20:00 |",
    "| ORCH | 대기 | 2026-07-11 20:00 |",
    "| PM | IDLE | 2026-07-11 19:50 |",
    "| REVIEW | IDLE | 2026-07-11 21:07 |",
    "| VERIFY | IDLE | 2026-07-07 02:17 |",
  ];
  for (const line of otherRoleLines) {
    assert.ok(
      decision.updatedText.includes(line),
      `unrelated row must survive byte-identical: ${line}`,
    );
  }
});

test("(41) known-bad: task/root unresolvable (empty taskContent) is reported by the pre-existing check, not misreported as a track issue", () => {
  const decision = computeUpdate({
    prompt: "go",
    role: "CODER",
    taskContent: null,
    statusText: STATUS_FIXTURE_WITH_MARKER,
    nowStr: "2026-07-11 21:11",
    repoRoot: REPO_ROOT,
  });
  assert.equal(decision.action, "warn");
  assert.match(decision.reason, /task file missing\/unreadable/);
});

// ---------------------------------------------------------------------------
// HYK-160-coder-6 (review-4 결함 1): wiring-order contract -- deploying the
// hardened hook before every target STATUS carries a correct marker is a
// breaking-change scenario (docs/enforcement-v1.md's new "HYK-152 하드닝:
// track-consistency 배선 순서 계약" section). These two tests pair "skip the
// order" against "follow the order" so the contract is pinned by a test,
// not only by prose. Synthetic STATUS fixtures only (S7) -- no real
// control-room STATUS.md is ever read or written here.
// ---------------------------------------------------------------------------

test("(42) known-bad: wiring-order violation -- hardened hook deployed against a STATUS that has NOT had step 1 (marker install) done yet reproduces the exact regression shape (go-time write silently stops)", () => {
  const decision = computeUpdate({
    prompt: "go HYK-110-coder-1",
    role: "CODER",
    taskContent: "task_id: HYK-110-coder-1\ndropped_at: 2026-07-11 21:05 KST\n",
    statusText: STATUS_FIXTURE, // no harness-track-root marker -- step 1 skipped
    nowStr: "2026-07-11 21:11",
    repoRoot: REPO_ROOT, // the hardened hook is live (repoRoot supplied)
  });
  assert.equal(
    decision.action,
    "warn",
    "a real go-time write must not silently succeed when the deployment order was skipped",
  );
  assert.match(decision.reason, /^STATUS_TARGET_UNJUDGABLE/);
});

test("(43) paired good: same deployment (hardened hook live), but steps 1+2 done first (marker installed and verified to match repoRoot) -> the previously-working go-time write is restored, single variable changed", () => {
  const decision = computeUpdate({
    prompt: "go HYK-110-coder-1",
    role: "CODER",
    taskContent: "task_id: HYK-110-coder-1\ndropped_at: 2026-07-11 21:05 KST\n",
    statusText: STATUS_FIXTURE_WITH_MARKER, // step 1 done: marker installed
    nowStr: "2026-07-11 21:11",
    repoRoot: REPO_ROOT, // step 2 done: marker matches this track's repoRoot
  });
  assert.equal(
    decision.action,
    "write",
    "following the mandatory order restores the write the skipped-order test lost",
  );
  assert.match(
    decision.updatedText,
    /\| CODER \| 🔨 작업중: HYK-110-coder-1 \| 2026-07-11 21:11 \|/,
  );
});
