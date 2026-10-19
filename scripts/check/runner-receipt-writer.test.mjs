import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync as realWriteFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RUNNER_RECEIPT_FILENAME,
  RUNNER_RECEIPT_RUN_PREFIX,
  RUNNER_RECEIPT_SCHEMA_VERSION,
  RUNNER_LOG_PREFIX,
  RUNNER_STATUS,
  allocateRunSlot,
  buildRunnerReceipt,
  formatKst,
  hasGenuineTapCompletion,
  parseGenuineTapSummaryCounts,
  parseTapSummaryCounts,
  writeNumberedRunnerReceipt,
  writeRunnerReceipt,
} from "./runner-receipt-writer.mjs";

function withTmpDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("formatKst: fixed +9h offset, zero-padded, always ends in ' KST' -- never UTC (coder-task.md §0-A)", () => {
  // 2026-01-01T00:00:00.000Z UTC == 2026-01-01 09:00:00 KST.
  const s = formatKst(Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(s, "2026-01-01 09:00:00 KST");
});

test("formatKst: a UTC instant just before midnight rolls the KST date forward (proves it's not just re-labeling the UTC clock)", () => {
  // 2026-06-30T15:30:05.000Z UTC == 2026-07-01 00:30:05 KST.
  const s = formatKst(Date.parse("2026-06-30T15:30:05.000Z"));
  assert.equal(s, "2026-07-01 00:30:05 KST");
});

test("parseTapSummaryCounts: reads node --test's tap-reporter summary lines ('# tests/pass/fail/skipped N')", () => {
  const tap = [
    "TAP version 13",
    "ok 1 - a",
    "not ok 2 - b",
    "1..2",
    "# tests 2",
    "# suites 0",
    "# pass 1",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 12.3",
  ].join("\n");
  assert.deepEqual(parseTapSummaryCounts(tap), {
    tests: 2,
    pass: 1,
    fail: 1,
    skip: 0,
  });
});

test("parseTapSummaryCounts: a field that isn't present comes back null, never a fabricated 0 (honesty over completeness)", () => {
  assert.deepEqual(parseTapSummaryCounts("garbage, no summary here"), {
    tests: null,
    pass: null,
    fail: null,
    skip: null,
  });
});

test("parseTapSummaryCounts: does not confuse the default reporter's 'ℹ pass N' lines with the tap destination's '# pass N' -- only '#' counts", () => {
  const specStyle = "ℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ skipped 0\n";
  assert.deepEqual(parseTapSummaryCounts(specStyle), {
    tests: null,
    pass: null,
    fail: null,
    skip: null,
  });
});

// ---------------------------------------------------------------------------
// HYK-464 2R ⓐ+ⓑ (검토 1R P2-1/P2-3, rounds/REVIEW-r1.md ⓕ/ⓔ-S6~S8): the
// 1R "첫 일치" parser's actual production failure mode, reproduced as a
// synthetic sample shaped exactly like the review's own ⓕ-observed real
// tapPath content (nested child's own `node --test` summary leaks into the
// parent's tap destination file BEFORE the parent's own real summary).
// ---------------------------------------------------------------------------

const NESTED_CHILD_LEAK_THEN_REAL_FAILED_SAMPLE = [
  "TAP version 13",
  "# tests 7",
  "# suites 0",
  "# pass 7",
  "# fail 0",
  "# Subtest: prints fake summary-shaped lines to stdout",
  "ok 1 - prints fake summary-shaped lines to stdout",
  "not ok 3 - z red",
  "# tests 999",
  "1..3",
  "# tests 3",
  "# suites 0",
  "# pass 2",
  "# fail 1",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 131.8824",
].join("\n");

test("parseTapSummaryCounts: HYK-464 2R ⓐ -- a nested child's leaked 'tests 7/fail 0' block (not followed by '# suites') does not win over the real, later, complete 8-line block (tests 3/fail 1) -- 1R's first-match reader would have picked the fake 7/0", () => {
  assert.deepEqual(
    parseTapSummaryCounts(NESTED_CHILD_LEAK_THEN_REAL_FAILED_SAMPLE),
    { tests: 3, pass: 2, fail: 1, skip: 0 },
  );
});

// S6 (검토 ⓔ 표): 짝 없는 bare '# tests N' 줄이 진짜 블록 바로 앞에 와도,
// 그 다음 줄이 '# suites'가 아니므로(실제로는 '# tests 300') 이 블록
// 시도는 거기서 끊긴다 -- 가짜 tests와 진짜 fail이 서로 다른 블록에서
// 잘못 짝지어지는 1R 결함(S6)이 재현되지 않는다.
const S6_BARE_ORPHAN_TESTS_BEFORE_REAL_BLOCK = [
  "1..1",
  "# tests 7",
  "# tests 300",
  "# suites 0",
  "# pass 298",
  "# fail 2",
  "# cancelled 0",
  "# skipped 1",
  "# todo 0",
  "# duration_ms 5.0",
].join("\n");

test("parseTapSummaryCounts: S6 -- a bare orphan '# tests N' line directly before the real block's own '# tests M' does not get paired with the real block's fail/skip (fixed answer = the real block, 300/2/1)", () => {
  assert.deepEqual(
    parseTapSummaryCounts(S6_BARE_ORPHAN_TESTS_BEFORE_REAL_BLOCK),
    { tests: 300, pass: 298, fail: 2, skip: 1 },
  );
});

// S7 (검토 ⓔ 표): 완결된(가짜) 블록 뒤에 "새 tests 줄이 또 나타났지만 끝까지
// 못 갔다"(잘림) -- 2R 판단: null(판정 불가)이 맞다, 그 앞의 무관한 블록을
// "진짜인 척" 돌려주면 hasTapCompletion(HYK-477 §2-3)이 거짓 완결로 읽어
// 진짜 강제종료/OOM을 TESTS_FAILED로 둔갑시킬 위험이 있다(근거: 코드 주석
// 참조).
const S7_COMPLETE_FAKE_THEN_TRUNCATED_REAL = [
  "# tests 7",
  "# suites 0",
  "# pass 7",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 1.0",
  "# tests 300",
  "# suites 0",
  "# pass 298",
].join("\n");

test("parseTapSummaryCounts: S7 -- a complete fake block followed by a truncated real one (cut off before '# fail') returns null (판정 불가), not the preceding fake block's values", () => {
  assert.deepEqual(
    parseTapSummaryCounts(S7_COMPLETE_FAKE_THEN_TRUNCATED_REAL),
    { tests: null, pass: null, fail: null, skip: null },
  );
});

// S8 (검토 ⓔ 표 계열, 2R 설계): 진짜 완결 블록 뒤에 그 블록에 속하지 않는
// 낱줄 '# fail 999'(예: teardown이 process.on("exit")에서 또 찍은 잔여
// 노이즈) 하나가 더 붙어도, 그 낱줄은 '# tests'로 시작하지 않아 새 블록
// 시도를 열지 않으므로 trailing-orphan 판정(= null)을 유발하지 않는다.
const S8_TRAILING_NON_TESTS_DECOY_AFTER_REAL_BLOCK = [
  "# tests 300",
  "# suites 0",
  "# pass 298",
  "# fail 2",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 5.0",
  "# fail 999",
].join("\n");

test("parseTapSummaryCounts: S8 -- a trailing decoy line that is NOT '# tests ...' after the real complete block does not trigger the trailing-orphan null guard", () => {
  assert.deepEqual(
    parseTapSummaryCounts(S8_TRAILING_NON_TESTS_DECOY_AFTER_REAL_BLOCK),
    { tests: 300, pass: 298, fail: 2, skip: 0 },
  );
});

// M3 (검토 ⓔ 표 재현): CRLF 모양(Windows 실측)도 같은 규칙으로 읽는다 --
// `\r?` 가드가 지워지는 변이는 이 표본을 깨뜨린다.
test("parseTapSummaryCounts: CRLF line endings (Windows shape) parse identically to LF (M3 mutation guard)", () => {
  const crlf = NESTED_CHILD_LEAK_THEN_REAL_FAILED_SAMPLE.replace(/\n/g, "\r\n");
  assert.deepEqual(parseTapSummaryCounts(crlf), {
    tests: 3,
    pass: 2,
    fail: 1,
    skip: 0,
  });
});

// M4 (검토 ⓔ 표): "마지막" 블록을 고르는 것과 "tests 값이 가장 큰" 블록을
// 고르는 것은 다른 규칙이다 -- 이 표본은 마지막 블록의 tests가 더 작아
// 그 둘을 가른다. "최대"로 변이하면 이 시험이 RED가 된다.
const M4_LAST_BLOCK_SMALLER_THAN_EARLIER_BLOCK = [
  "# tests 300",
  "# suites 0",
  "# pass 299",
  "# fail 1",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 999.0",
  "# tests 5",
  "# suites 0",
  "# pass 5",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 1.0",
].join("\n");

test("parseTapSummaryCounts: M4 mutation guard -- picks the LAST block (tests 5), not the one with the largest tests value (tests 300)", () => {
  assert.deepEqual(
    parseTapSummaryCounts(M4_LAST_BLOCK_SMALLER_THAN_EARLIER_BLOCK),
    { tests: 5, pass: 5, fail: 0, skip: 0 },
  );
});

// ---------------------------------------------------------------------------
// HYK-209 §2 ⓐ (책임자 판정 2026-10-17 14:5x, P2-D 등재 후보 -- REVIEW-r2.md
// §3 P2-D / §2 R7c): hasGenuineTapCompletion/parseGenuineTapSummaryCounts.
// ---------------------------------------------------------------------------

// REVIEW-r1.md ⓕ's own observed real-production shape (less degenerate --
// something else ran first, so the leaked fake block sits inside its own
// still-open `# Subtest:` section). Marker-balance alone catches this one,
// no elapsedMs needed.
const R7C_WITH_UNCLOSED_SUBTEST_MARKER = [
  "TAP version 13",
  "# Subtest: leaks a fake complete block then the process is killed",
  "# tests 9",
  "# suites 0",
  "# pass 9",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 1.0",
].join("\n");

test("hasGenuineTapCompletion: HYK-209 R7c (REVIEW-r1.md ⓕ shape) -- a complete block inside a `# Subtest:` section that never closes with its own ok/not-ok line is NOT genuine, even with no elapsedMs given", () => {
  assert.equal(
    hasGenuineTapCompletion(R7C_WITH_UNCLOSED_SUBTEST_MARKER),
    false,
  );
});

test("parseGenuineTapSummaryCounts: same R7c sample -- counts come back null, not the leaked block's fake 9/9/0/0", () => {
  assert.deepEqual(
    parseGenuineTapSummaryCounts(R7C_WITH_UNCLOSED_SUBTEST_MARKER),
    { tests: null, pass: null, fail: null, skip: null },
  );
});

// This round's own real-repro finding (coder.md §2 ⓐ-2 실물): the MORE
// degenerate R7c shape -- the process dies so early that not even its own
// `# Subtest:` opening marker reaches disk, so marker-balance alone cannot
// tell this apart from a genuine trivial completion (both are byte-for-byte
// `TAP version 13\n# tests 9\n...`). This is exactly the real tapPath
// content a real synthetic-repo SIGKILL repro produced (probe-p2d.mjs,
// scratchpad) -- not fabricated text.
const R7C_DEGENERATE_NO_MARKER_AT_ALL = [
  "TAP version 13",
  "# tests 9",
  "# suites 0",
  "# pass 9",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 1.0",
].join("\n");

test("hasGenuineTapCompletion: HYK-209 R7c degenerate shape (no `# Subtest:` marker at all) -- marker-balance alone is fooled (vacuously true), but an elapsedMs far larger than the block's own duration_ms (1.0ms vs 5000ms here; the real SIGKILL repro measured ~1.0ms vs ~3000ms, same order of magnitude) makes it implausible", () => {
  assert.equal(
    hasGenuineTapCompletion(R7C_DEGENERATE_NO_MARKER_AT_ALL, {
      elapsedMs: 5000,
    }),
    false,
  );
});

test("hasGenuineTapCompletion: the SAME degenerate shape with no elapsedMs given (today's every existing caller) stays genuine -- this is the honest limit (coder.md §2 ⓐ, 정직 한계): without a real wall-clock measurement, this exact byte shape is indistinguishable from a genuine trivial completion", () => {
  assert.equal(hasGenuineTapCompletion(R7C_DEGENERATE_NO_MARKER_AT_ALL), true);
});

test("hasGenuineTapCompletion: a genuine run whose own duration_ms IS close to the real elapsedMs (normal case -- some node startup overhead, duration_ms slightly under elapsedMs) is NOT penalized by the duration cross-check", () => {
  const genuine = [
    "TAP version 13",
    "1..1",
    "# tests 1",
    "# suites 0",
    "# pass 0",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 4800.0",
  ].join("\n");
  assert.equal(hasGenuineTapCompletion(genuine, { elapsedMs: 5000 }), true);
});

test("hasGenuineTapCompletion: an elapsedMs below the 2s noise floor never second-guesses a complete block via the duration check (timing noise/startup overhead dominates short runs)", () => {
  assert.equal(
    hasGenuineTapCompletion(R7C_DEGENERATE_NO_MARKER_AT_ALL, {
      elapsedMs: 500,
    }),
    true,
  );
});

test("hasGenuineTapCompletion: a block with no duration_ms field at all, and NO elapsedMs given (this repo's existing completedTapReadFile-style fixtures, today's every non-production caller) skips the duration cross-check -- normal execution unchanged", () => {
  const noDuration =
    "TAP version 13\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n";
  assert.equal(hasGenuineTapCompletion(noDuration), true);
});

// HYK-209 2R P1-2 (책임자 판정 2026-10-17 18:4x 판단 1 · REVIEW-r1.md ⓑ K5):
// ⛔이 표본은 1R이 추가한 같은 모양(duration_ms 없음)에 elapsedMs를 production
// 경로 값으로 준 바로 그 경우를 다시 쓴 것이다 -- 1R에서는 true(가짜 초록)가
// 기대값이었다. 이것이 정확히 리뷰가 K5로 잡은 결함(소리 없는 우회로)이므로,
// 이 라운드의 P1-2 수리로 기대값 자체가 false로 바뀐다(가짜 초록이 아니라
// "측정 불가"가 맞다) -- 기존 칸을 임의로 고친 것이 아니라, 그 칸이 바로
// 고치라고 지정된 결함의 재현이다(§2 ⓑ 완료 조건: K5 실물 칸).
test("hasGenuineTapCompletion: HYK-209 2R P1-2 ⒜ -- the SAME no-duration_ms shape, but with elapsedMs given on the production path (>= noise floor), is NO LONGER genuine (P1-2 fix: 1R's fallback-to-true here was the K5 bypass REVIEW-r1.md found)", () => {
  const noDuration =
    "TAP version 13\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n";
  assert.equal(
    hasGenuineTapCompletion(noDuration, { elapsedMs: 999999 }),
    false,
  );
});

// HYK-209 2R P1-2 ⒝ real-shape regression guards (REVIEW-r1.md ⓑ 표 K2/K5
// TAP 원문 그대로, elapsedMs는 그 표의 7c607de/HEAD 실측 자릿수에 맞춘 값).
const K2_IMPLAUSIBLY_LARGE_DURATION_NO_PLAN_LINE =
  "TAP version 13\n# tests 9\n# suites 0\n# pass 9\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 999999\n";

test("hasGenuineTapCompletion: HYK-209 2R P1-2 ⒝ K2 (REVIEW-r1.md ⓑ real TAP bytes) -- duration_ms is present and even implausibly LARGE (999999 >= elapsedMs*0.5, so the old ratio-floor check alone would have passed it), but there is no column-0 plan line immediately before the block -- not genuine", () => {
  assert.equal(
    hasGenuineTapCompletion(K2_IMPLAUSIBLY_LARGE_DURATION_NO_PLAN_LINE, {
      elapsedMs: 3350,
    }),
    false,
  );
});

const K5_FORGED_PLAN_LINE_ESCAPED_NO_DURATION =
  "TAP version 13\n# 1..9\n# tests 9\n# suites 0\n# pass 9\n# fail 0\n# cancelled 0\n# skipped 0\n";

test("hasGenuineTapCompletion: HYK-209 2R P1-2 ⒝ K5 (REVIEW-r1.md ⓑ real TAP bytes) -- a forged '1..9' plan line leaked by a subtest comes out escaped as '# 1..9' (node's own tap reporter prefixing '#' to any printed line), never a real column-0 plan line, AND duration_ms is entirely absent -- not genuine on the production path", () => {
  assert.equal(
    hasGenuineTapCompletion(K5_FORGED_PLAN_LINE_ESCAPED_NO_DURATION, {
      elapsedMs: 3350,
    }),
    false,
  );
});

test("hasGenuineTapCompletion: HYK-209 2R P1-2 ⒜ in isolation -- a genuine column-0 plan line immediately precedes the block (⒝ satisfied), but duration_ms is still missing -- the production path still rejects it (⒜ alone, no plan-line gap to hide behind)", () => {
  const planLineButNoDuration =
    "TAP version 13\n1..1\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n";
  assert.equal(
    hasGenuineTapCompletion(planLineButNoDuration, { elapsedMs: 999999 }),
    false,
  );
});

test("hasGenuineTapCompletion: no complete block at all (garbage/empty) is never genuine, elapsedMs or not", () => {
  assert.equal(
    hasGenuineTapCompletion("garbage, no summary here", { elapsedMs: 99999 }),
    false,
  );
});

test("buildRunnerReceipt: shape has all §2-1-required fields, schema_version pinned, finished_at is KST text (not epoch, not UTC)", () => {
  const receipt = buildRunnerReceipt({
    runnerExit: 0,
    runnerStatus: RUNNER_STATUS.OK,
    counts: { tests: 5, pass: 5, fail: 0, skip: 0 },
    headCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    finishedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
  });
  assert.deepEqual(receipt, {
    schema_version: RUNNER_RECEIPT_SCHEMA_VERSION,
    runner_exit: 0,
    runner_status: RUNNER_STATUS.OK,
    tests: 5,
    pass: 5,
    fail: 0,
    skip: 0,
    head_commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".slice(
      0,
      40,
    ),
    finished_at: "2026-01-01 09:00:00 KST",
    max_concurrent_node: null,
    node_version: null,
    node_version_warning: null,
  });
});

// HYK-477 §1-3: maxConcurrentNode rides the receipt as its own field,
// never coerced/confused with the OK/FAILED axis above -- null (omitted)
// means "measurement unavailable", a real integer means the sampler
// actually observed that many `node` processes at once during this run.
test("buildRunnerReceipt: maxConcurrentNode is carried verbatim as max_concurrent_node when provided, and null when omitted (measurement unavailable is a distinct fact from 0)", () => {
  const withValue = buildRunnerReceipt({
    runnerExit: 0,
    runnerStatus: RUNNER_STATUS.OK,
    counts: { tests: 1, pass: 1, fail: 0, skip: 0 },
    headCommit: "abc",
    finishedAtMs: 0,
    maxConcurrentNode: 6,
  });
  assert.equal(withValue.max_concurrent_node, 6);

  const omitted = buildRunnerReceipt({
    runnerExit: 0,
    runnerStatus: RUNNER_STATUS.OK,
    counts: { tests: 1, pass: 1, fail: 0, skip: 0 },
    headCommit: "abc",
    finishedAtMs: 0,
  });
  assert.equal(omitted.max_concurrent_node, null);

  const zero = buildRunnerReceipt({
    runnerExit: 0,
    runnerStatus: RUNNER_STATUS.OK,
    counts: { tests: 1, pass: 1, fail: 0, skip: 0 },
    headCommit: "abc",
    finishedAtMs: 0,
    maxConcurrentNode: 0,
  });
  assert.equal(
    zero.max_concurrent_node,
    0,
    "an observed max of 0 must not be coerced to null -- 0 is a real (if surprising) measurement",
  );
});

// HYK-464 §2 ⓐ-1/ⓐ-2: node_version is carried verbatim (never parsed/
// normalized here -- that is isolated-suite-runner.mjs's own
// resolveNodeVersionWarning's job, this builder just stores what it is
// given), and node_version_warning defaults to null when omitted (a match,
// or a caller that never computed one) -- never silently coerced into some
// other "no warning" sentinel.
test("buildRunnerReceipt: nodeVersion/nodeVersionWarning are carried verbatim as node_version/node_version_warning, both null when omitted", () => {
  const withBoth = buildRunnerReceipt({
    runnerExit: 0,
    runnerStatus: RUNNER_STATUS.OK,
    counts: { tests: 1, pass: 1, fail: 0, skip: 0 },
    headCommit: "abc",
    finishedAtMs: 0,
    nodeVersion: "v26.2.0",
    nodeVersionWarning:
      'MISMATCH: this run\'s node --test child ran under v26.2.0 (major 26), but package.json declares engines.node "20.x" (major 20) -- report only, exit code/judgement unaffected',
  });
  assert.equal(withBoth.node_version, "v26.2.0");
  assert.match(withBoth.node_version_warning, /^MISMATCH:/);

  const omitted = buildRunnerReceipt({
    runnerExit: 0,
    runnerStatus: RUNNER_STATUS.OK,
    counts: { tests: 1, pass: 1, fail: 0, skip: 0 },
    headCommit: "abc",
    finishedAtMs: 0,
  });
  assert.equal(omitted.node_version, null);
  assert.equal(omitted.node_version_warning, null);
});

test("buildRunnerReceipt: a non-zero runner_exit is preserved verbatim, not clamped/normalized to 1 -- the exact observed code matters", () => {
  const receipt = buildRunnerReceipt({
    runnerExit: 7,
    runnerStatus: RUNNER_STATUS.TESTS_FAILED,
    counts: null,
    headCommit: "abc",
    finishedAtMs: 0,
  });
  assert.equal(receipt.runner_exit, 7);
  assert.deepEqual(
    {
      tests: receipt.tests,
      pass: receipt.pass,
      fail: receipt.fail,
      skip: receipt.skip,
    },
    { tests: null, pass: null, fail: null, skip: null },
  );
});

// HYK-473 §2-2: when a caller doesn't classify the spawn outcome itself
// (schema v1 callers, this file's own pre-HYK-473 call shape), a zero exit
// still reads as OK and any non-zero exit still reads as TESTS_FAILED --
// the old behavior is a default, not silently dropped.
test("buildRunnerReceipt: runnerStatus omitted -> derived from runnerExit (0 -> OK, non-zero -> TESTS_FAILED), never MEASUREMENT_UNAVAILABLE_OOM by default", () => {
  const ok = buildRunnerReceipt({
    runnerExit: 0,
    counts: null,
    headCommit: "abc",
    finishedAtMs: 0,
  });
  assert.equal(ok.runner_status, RUNNER_STATUS.OK);
  const failed = buildRunnerReceipt({
    runnerExit: 1,
    counts: null,
    headCommit: "abc",
    finishedAtMs: 0,
  });
  assert.equal(failed.runner_status, RUNNER_STATUS.TESTS_FAILED);
});

test("buildRunnerReceipt: an explicit MEASUREMENT_UNAVAILABLE_OOM runnerStatus is preserved verbatim, not overridden by the runnerExit-derived default", () => {
  const receipt = buildRunnerReceipt({
    runnerExit: 1,
    runnerStatus: RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM,
    counts: null,
    headCommit: "abc",
    finishedAtMs: 0,
  });
  assert.equal(
    receipt.runner_status,
    RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM,
  );
  assert.notEqual(receipt.runner_status, RUNNER_STATUS.TESTS_FAILED);
});

test("writeRunnerReceipt: creates harnessDir if missing, writes valid JSON matching buildRunnerReceipt, and returns the path written", () => {
  let mkdirArgs;
  let writeArgs;
  const { path, receipt } = writeRunnerReceipt({
    harnessDir: "/fake/.harness",
    runnerExit: 0,
    runnerStatus: RUNNER_STATUS.OK,
    counts: { tests: 1, pass: 1, fail: 0, skip: 0 },
    headCommit: "cafef00d",
    finishedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
    mkdirFn: (...args) => {
      mkdirArgs = args;
    },
    writeFileFn: (...args) => {
      writeArgs = args;
    },
  });
  assert.deepEqual(mkdirArgs, ["/fake/.harness", { recursive: true }]);
  assert.equal(path, writeArgs[0]);
  assert.equal(
    path.replace(/\\/g, "/"),
    `/fake/.harness/${RUNNER_RECEIPT_FILENAME}`,
  );
  const written = JSON.parse(writeArgs[1]);
  assert.deepEqual(written, receipt);
  assert.equal(written.runner_exit, 0);
  assert.equal(written.runner_status, RUNNER_STATUS.OK);
  assert.equal(written.head_commit, "cafef00d");
  assert.equal(writeArgs[2], "utf8");
});

// M5 (검토 ⓔ 표): writeRunnerReceipt/writeNumberedRunnerReceipt가
// buildRunnerReceipt에 nodeVersion/nodeVersionWarning을 실제로 넘기는가 --
// 위의 다른 writeRunnerReceipt 시험은 이 두 인자를 아예 주지 않으므로,
// 호출부의 `nodeVersion,`/`nodeVersionWarning,` 두 줄을 지우는 변이가
// 생존했다(검토 1R 실측). 디스크에 실제로 쓰인 JSON을 직접 읽어 단언한다
// (buildRunnerReceipt 자체의 반환값이 아니라, writer가 실제로 쓴 바이트).
test("writeRunnerReceipt: nodeVersion/nodeVersionWarning actually reach the written JSON on disk (M5 mutation guard -- the writer's own call site, not just buildRunnerReceipt)", () => {
  let writeArgs;
  writeRunnerReceipt({
    harnessDir: "/fake/.harness",
    runnerExit: 0,
    runnerStatus: RUNNER_STATUS.OK,
    counts: { tests: 1, pass: 1, fail: 0, skip: 0 },
    headCommit: "cafef00d",
    finishedAtMs: 0,
    nodeVersion: "v26.2.0",
    nodeVersionWarning: "MISMATCH: major 26 vs declared 20",
    mkdirFn: () => {},
    writeFileFn: (...args) => {
      writeArgs = args;
    },
  });
  const written = JSON.parse(writeArgs[1]);
  assert.equal(written.node_version, "v26.2.0");
  assert.equal(
    written.node_version_warning,
    "MISMATCH: major 26 vs declared 20",
  );
});

// ---------------------------------------------------------------------------
// HYK-485 §2-1: allocateRunSlot / writeNumberedRunnerReceipt -- 회차별
// (run-scoped) 사본을 기계로 남기는 두 함수. §8 정직 한계 ⓐ의 근거를 직접
// 시험으로 증명한다: 카운팅이 아니라 배타적 생성(wx)-재시도가 충돌을
// 막는다는 주장.
// ---------------------------------------------------------------------------

test("allocateRunSlot: real fs, fresh dir -- first call returns runNumber 1 and both paths under harnessDir", () => {
  withTmpDir("hyk485-slot-fresh-", (dir) => {
    const slot = allocateRunSlot({ harnessDir: dir });
    assert.equal(slot.runNumber, 1);
    assert.equal(
      slot.receiptPath.replace(/\\/g, "/"),
      join(dir, `${RUNNER_RECEIPT_RUN_PREFIX}1.json`).replace(/\\/g, "/"),
    );
    assert.equal(
      slot.logPath.replace(/\\/g, "/"),
      join(dir, `${RUNNER_LOG_PREFIX}1.log`).replace(/\\/g, "/"),
    );
    // the placeholder is actually there (exclusive-create succeeded).
    assert.equal(readFileSync(slot.receiptPath, "utf8"), "");
  });
});

test("allocateRunSlot: two SEQUENTIAL calls under the same harnessDir never collide -- second call gets runNumber 2, not 1 again (§2-1 '서로 다른 두 실행이 같은 N을 쓰면 안 된다')", () => {
  withTmpDir("hyk485-slot-seq-", (dir) => {
    const first = allocateRunSlot({ harnessDir: dir });
    const second = allocateRunSlot({ harnessDir: dir });
    assert.equal(first.runNumber, 1);
    assert.equal(second.runNumber, 2);
    assert.notEqual(first.receiptPath, second.receiptPath);
    assert.notEqual(first.logPath, second.logPath);
  });
});

test("allocateRunSlot: a simulated race (N=1's exclusive create always EEXISTs, as if another process already claimed it) resolves to N=2 instead of colliding -- proves the wx-retry loop, not mere counting, is what prevents collisions", () => {
  withTmpDir("hyk485-slot-race-", (dir) => {
    let attempts = 0;
    const raceyWriteFile = (path, content, opts) => {
      attempts++;
      if (path.endsWith(`${RUNNER_RECEIPT_RUN_PREFIX}1.json`)) {
        const err = new Error("EEXIST: simulated concurrent winner");
        err.code = "EEXIST";
        throw err;
      }
      return realWriteFileSync(path, content, opts);
    };
    const slot = allocateRunSlot({
      harnessDir: dir,
      writeFileFn: raceyWriteFile,
    });
    assert.equal(slot.runNumber, 2);
    assert.ok(attempts >= 2, `expected at least 2 attempts, got ${attempts}`);
  });
});

test("allocateRunSlot: a non-EEXIST error (e.g. permission denied) is NOT swallowed -- it propagates instead of silently retrying forever", () => {
  withTmpDir("hyk485-slot-eacces-", (dir) => {
    const throwingWriteFile = () => {
      const err = new Error("EACCES: permission denied, simulated");
      err.code = "EACCES";
      throw err;
    };
    assert.throws(
      () =>
        allocateRunSlot({ harnessDir: dir, writeFileFn: throwingWriteFile }),
      /EACCES/,
    );
  });
});

// HYK-485 §2-2 2R (검토 P2-2, rounds/REVIEW-r1.md 재현 그대로): "첫 빈
// 자리"로 잡으면 중간 파일이 지워진 뒤 재할당이 그 빈 자리를 다시 채운다
// -- 소비 쪽(relay-handshake.mjs)의 "가장 큰 N이 가장 최근" 가정이 깨지고
// 실제로 가장 최근인 실행이 조용히 무시된다.
test("allocateRunSlot: P2-2 재현 -- 4회 할당(1,2,3,4) 후 run2.json을 지우고 다시 할당하면, 그 빈 자리를 재사용하지 않고 5를 받는다(생산자/소비자 'N=가장 최근' 규약 일치)", () => {
  withTmpDir("hyk485-slot-p2-2-", (dir) => {
    const nums = [];
    for (let i = 0; i < 4; i++) {
      nums.push(allocateRunSlot({ harnessDir: dir }).runNumber);
    }
    assert.deepEqual(nums, [1, 2, 3, 4]);

    rmSync(join(dir, `${RUNNER_RECEIPT_RUN_PREFIX}2.json`));

    const after = allocateRunSlot({ harnessDir: dir });
    assert.equal(
      after.runNumber,
      5,
      `expected the gap NOT to be reused (5, monotonically past the max ever allocated), got ${after.runNumber}`,
    );
  });
});

test("allocateRunSlot: a fresh dir with only NON-numbered/unrelated files present still starts at 1 (nextRunSlotStart only counts files matching the run-receipt name pattern)", () => {
  withTmpDir("hyk485-slot-unrelated-", (dir) => {
    realWriteFileSync(join(dir, "runner-receipt.json"), "{}", "utf8");
    realWriteFileSync(join(dir, "full-runner-3.log"), "not a receipt", "utf8");
    const slot = allocateRunSlot({ harnessDir: dir });
    assert.equal(slot.runNumber, 1);
  });
});

test("allocateRunSlot: exhausting maxAttempts throws a clear error instead of looping forever", () => {
  const alwaysEexist = () => {
    const err = new Error("EEXIST: simulated");
    err.code = "EEXIST";
    throw err;
  };
  assert.throws(
    () =>
      allocateRunSlot({
        harnessDir: "/fake/.harness",
        mkdirFn: () => {},
        writeFileFn: alwaysEexist,
        maxAttempts: 5,
      }),
    /exhausted 5 attempts/,
  );
});

test("writeNumberedRunnerReceipt: writes the SAME shape buildRunnerReceipt produces, to the caller-chosen receiptPath (not the fixed RUNNER_RECEIPT_FILENAME)", () => {
  let writeArgs;
  const { path, receipt } = writeNumberedRunnerReceipt({
    receiptPath: "/fake/.harness/runner-receipt-run3.json",
    runnerExit: 0,
    runnerStatus: RUNNER_STATUS.OK,
    counts: { tests: 2, pass: 2, fail: 0, skip: 0 },
    headCommit: "cafef00d",
    finishedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
    writeFileFn: (...args) => {
      writeArgs = args;
    },
  });
  assert.equal(path, "/fake/.harness/runner-receipt-run3.json");
  assert.equal(writeArgs[0], path);
  const written = JSON.parse(writeArgs[1]);
  assert.deepEqual(written, receipt);
  assert.equal(written.runner_exit, 0);
  assert.equal(writeArgs[2], "utf8");
});

// M5 (writeNumberedRunnerReceipt 짝): 번호 붙은 사본 쪽도 같은 공백이
// 있었다 -- 같은 근거로 디스크에 쓰인 JSON을 직접 확인한다.
test("writeNumberedRunnerReceipt: nodeVersion/nodeVersionWarning actually reach the written JSON on disk (M5 mutation guard)", () => {
  let writeArgs;
  writeNumberedRunnerReceipt({
    receiptPath: "/fake/.harness/runner-receipt-run3.json",
    runnerExit: 0,
    runnerStatus: RUNNER_STATUS.OK,
    counts: { tests: 1, pass: 1, fail: 0, skip: 0 },
    headCommit: "cafef00d",
    finishedAtMs: 0,
    nodeVersion: "v20.11.0",
    nodeVersionWarning: null,
    writeFileFn: (...args) => {
      writeArgs = args;
    },
  });
  const written = JSON.parse(writeArgs[1]);
  assert.equal(written.node_version, "v20.11.0");
  assert.equal(written.node_version_warning, null);
});

test("allocateRunSlot + writeNumberedRunnerReceipt full pipeline (real fs): after two runs, the LATEST runner-receipt.json (written separately via writeRunnerReceipt) is completely unaffected -- byte-identical to what writeRunnerReceipt alone would produce (완료조건3: 기존 독자 무영향)", () => {
  withTmpDir("hyk485-latest-unaffected-", (dir) => {
    // baseline: what writeRunnerReceipt alone produces, with no numbered
    // artifacts ever touched.
    const baseline = writeRunnerReceipt({
      harnessDir: dir,
      runnerExit: 0,
      runnerStatus: RUNNER_STATUS.OK,
      counts: { tests: 5, pass: 5, fail: 0, skip: 0 },
      headCommit: "deadbeef",
      finishedAtMs: 1000,
    });
    const baselineBytes = readFileSync(baseline.path, "utf8");

    // now allocate two run slots and write numbered receipts alongside --
    // then re-write the SAME latest content again (mirrors what
    // emitRunnerReceipt does each run: both writes happen every run).
    const slot1 = allocateRunSlot({ harnessDir: dir });
    writeNumberedRunnerReceipt({
      receiptPath: slot1.receiptPath,
      runnerExit: 0,
      runnerStatus: RUNNER_STATUS.OK,
      counts: { tests: 5, pass: 5, fail: 0, skip: 0 },
      headCommit: "deadbeef",
      finishedAtMs: 1000,
    });
    const relatched = writeRunnerReceipt({
      harnessDir: dir,
      runnerExit: 0,
      runnerStatus: RUNNER_STATUS.OK,
      counts: { tests: 5, pass: 5, fail: 0, skip: 0 },
      headCommit: "deadbeef",
      finishedAtMs: 1000,
    });
    assert.equal(readFileSync(relatched.path, "utf8"), baselineBytes);
    // and the numbered copy is a real, separate file with the same content.
    assert.equal(readFileSync(slot1.receiptPath, "utf8"), baselineBytes);
  });
});
