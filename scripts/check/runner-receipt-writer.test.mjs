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
