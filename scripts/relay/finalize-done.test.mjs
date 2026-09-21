// HYK-186 완료조건2: finalize-done.mjs is the one supported machine-clock
// producer for a result file's '>>> DONE:' line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { finalizeDone, FINALIZE_DONE_REASON } from "./finalize-done.mjs";
import { observeDoneLine } from "../check/first-observation.mjs";
// HYK-359 (2R ext, ORCH-53): never let an ambient ADMISSION_LEDGER_PATH/
// ADMISSION_LOCK_PATH/DISPATCH_RECEIPT_PATH leaked from the invoking shell
// (or, in the ambient-env sweep's case, deliberately floated by a prior
// test in the same process) reach a relay-handshake.mjs child this file
// spawns -- see admission-ledger-env-isolation.mjs's own header, and
// relay-handshake.test.mjs's runCli for the same repo-wide idiom reused
// here rather than reinvented.
import { isolatedChildEnv } from "../check/admission-ledger-env-isolation.mjs";

const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "finalize-done.mjs",
);
// HYK-324/HYK-325 r2 §3 시험5: the sibling production CLI entry point
// (relay-handshake.mjs), spawned as its own child process -- not imported --
// same reasoning as CLI_PATH above (완료조건7, engine independence).
const HANDSHAKE_CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "check",
  "relay-handshake.mjs",
);

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "finalize-done-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    ...opts,
    // HYK-359 (2R ext, ORCH-53): strip any ambient admission-ledger env
    // before it reaches this child -- see the import above.
    env: isolatedChildEnv(opts.env),
  });
  assert.equal(res.error, undefined);
  assert.notEqual(res.status, null);
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

test("finalizeDone: callerSuppliedAt !== undefined is refused, regardless of value", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    for (const badValue of [
      "2020-01-01 00:00 KST",
      0,
      new Date(),
      null,
      false,
    ]) {
      const result = finalizeDone({
        role: "coder",
        harnessDir: dir,
        callerSuppliedAt: badValue,
      });
      assert.equal(result.ok, false);
      assert.equal(
        result.reasonCode,
        FINALIZE_DONE_REASON.CALLER_SUPPLIED_TIME_REJECTED,
      );
    }
  });
});

test("finalizeDone: normal call (no callerSuppliedAt) writes a DONE line stamped with the injected machine clock", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    const fixedMs = Date.parse("2026-08-09T05:00:00Z"); // 2026-08-09 14:00 KST
    const result = finalizeDone({
      role: "coder",
      harnessDir: dir,
      nowFn: () => fixedMs,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.FINALIZED);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(content, />>> DONE: CODER @ 2026-08-09 14:00:00 KST/);
  });
});

// HYK-418 §2-3: this is now the ALREADY_FINALIZED case -- well-formed AND
// already marker-stamped (i.e. genuinely produced by finalize-done once
// before). A well-formed-but-UNMARKED line is a DIFFERENT, now-replaceable
// case -- see the next test.
test("finalizeDone: already has a marked DONE line -> refuses, never overwrites", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-01 00:00:00 KST\n${"done_stamped_by: finalize-done"}\n`,
      "utf8",
    );
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.ALREADY_FINALIZED);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      /2026-08-01 00:00:00 KST/,
      "original line must survive untouched",
    );
  });
});

// HYK-418 §2-3 (deadlock recovery path, coder-task.md §1 요구4): a
// well-formed but UNMARKED DONE line (the exact shape relay-handshake.mjs
// now rejects, HYK-418 §2-1) must be replaceable exactly once -- otherwise
// promoting the consumer side to fail-closed creates a round with no way
// out (HYK-423's real lockup).
test("finalizeDone: well-formed but unmarked DONE line -> replaced once (REPLACED_UNMARKED), original preserved as superseded_done:", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-01 00:00:00 KST\n",
      "utf8",
    );
    const fixedMs = Date.parse("2026-08-09T05:00:00Z"); // 2026-08-09 14:00 KST
    const result = finalizeDone({
      role: "coder",
      harnessDir: dir,
      nowFn: () => fixedMs,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.REPLACED_UNMARKED);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      /superseded_done: >>> DONE: CODER @ 2026-08-01 00:00:00 KST/,
      "original unmarked line preserved verbatim as superseded_done:",
    );
    assert.match(content, />>> DONE: CODER @ 2026-08-09 14:00:00 KST/);
    assert.match(content, /^done_stamped_by: finalize-done$/m);

    // §2-1 (2회째 교체 금지) co-exists: a second call must NOT replace again.
    const second = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(second.ok, false);
    assert.equal(second.reasonCode, FINALIZE_DONE_REASON.ALREADY_REPLACED);
  });
});

test("finalizeDone: result file missing -> refuses with a distinct reason", () => {
  withDir((dir) => {
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.RESULT_FILE_NOT_FOUND);
  });
});

// HYK-332 §3 시험1: task_id: missing -> DONE is not stamped, reasonCode
// names exactly what's missing, no '>>> DONE:' line is written.
test("finalizeDone: task_id: header missing -> refuses, no DONE stamped", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "no header here\n\nbody\n", "utf8");
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      FINALIZE_DONE_REASON.HEADER_TASK_ID_MISSING,
    );
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.doesNotMatch(content, />>> DONE/);
  });
});

test("finalizeDone: task_id: header ambiguous (2+ standalone lines) -> refuses", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\ntask_id: HYK-2\n\nbody\n",
      "utf8",
    );
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      FINALIZE_DONE_REASON.HEADER_TASK_ID_AMBIGUOUS,
    );
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.doesNotMatch(content, />>> DONE/);
  });
});

// HYK-332 §3 시험2: REVIEW-family result file missing 'for:' -> refused the
// same way, even though its 'task_id:' header is present and well-formed.
test("finalizeDone: REVIEW-family result missing 'for:' header -> refuses, no DONE stamped", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "review.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    const result = finalizeDone({ role: "review", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.HEADER_FOR_MISSING);
    const content = readFileSync(join(dir, "review.md"), "utf8");
    assert.doesNotMatch(content, />>> DONE/);
  });
});

test("finalizeDone: REVIEW-family result with 2+ 'for:' lines -> refuses ambiguous", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "review.md"),
      "task_id: HYK-1\nfor: HYK-1-coder-1\nfor: HYK-1-coder-2\n\nbody\n",
      "utf8",
    );
    const result = finalizeDone({ role: "review", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.HEADER_FOR_AMBIGUOUS);
  });
});

// HYK-332 §3 시험3: regression -- a well-formed REVIEW result (task_id: +
// for: both present, exactly once each) still gets DONE stamped normally.
test("finalizeDone: REVIEW-family result with well-formed task_id: + for: -> still finalizes normally", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "review.md"),
      "task_id: HYK-1\nfor: HYK-1-coder-1\n\nbody\n",
      "utf8",
    );
    const result = finalizeDone({
      role: "review",
      harnessDir: dir,
      nowFn: () => Date.parse("2026-08-09T05:00:00Z"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.FINALIZED);
    const content = readFileSync(join(dir, "review.md"), "utf8");
    assert.match(content, />>> DONE: REVIEW @ 2026-08-09 14:00:00 KST/);
  });
});

// HYK-332 §3 시험4 (프로덕션 진입점 -- CLI): the same gate fires through the
// CLI path, not just the exported function.
test("CLI: task_id: header missing -> non-zero exit, reason names what's missing, no DONE stamped", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "no header here\n\nbody\n", "utf8");
    const res = runCli(["coder", dir]);
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /missing task_id echo/);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.doesNotMatch(content, />>> DONE/);
  });
});

test("CLI (non-Claude engine path, 완료조건7): plain `node finalize-done.mjs <role> <dir>` writes a machine-stamped DONE line", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    const res = runCli(["coder", dir]);
    assert.equal(res.exit, 0);
    assert.match(res.stdout, /^FINALIZED: >>> DONE: CODER @ /);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      />>> DONE: CODER @ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} KST/,
    );
  });
});

test("finalizeDone: normal FINALIZED write also stamps the finalize-done marker line", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    const result = finalizeDone({
      role: "coder",
      harnessDir: dir,
      nowFn: () => Date.parse("2026-08-09T05:00:00Z"),
    });
    assert.equal(result.ok, true);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(content, /^done_stamped_by: finalize-done$/m);
  });
});

// HYK-324/HYK-325 §2-1 · §3 시험3: today's actual malformed text
// (minute-precision, 사고 A의 실제 문면) -> replaced exactly once.
test("finalizeDone: malformed (minute-precision) DONE line -> replaced once, original preserved as superseded_done:", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\nbody\n\n>>> DONE: CODER @ 2026-08-19 18:56 KST\n",
      "utf8",
    );
    const result = finalizeDone({
      role: "coder",
      harnessDir: dir,
      nowFn: () => Date.parse("2026-08-19T10:01:11Z"), // 2026-08-19 19:01:11 KST
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.REPLACED_MALFORMED);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      /^superseded_done: >>> DONE: CODER @ 2026-08-19 18:56 KST$/m,
      "original malformed line must survive verbatim, non-column-0",
    );
    assert.match(content, /^done_stamped_by: finalize-done$/m);
    // §3 시험5: exactly one '>>> DONE:' cover line survives (parser 계약).
    const doneLineMatches = [...content.matchAll(/^>>>\s*DONE:/gim)];
    assert.equal(doneLineMatches.length, 1);
    assert.match(
      content,
      />>> DONE: CODER @ 2026-08-19 19:01:11 KST/,
      "replacement must carry the machine clock, not any caller value",
    );
  });
});

// HYK-324/HYK-325 r2 §3 시험1 (검토 반려 P1 수리, 검토자가 쓴 입력 그대로):
// a DONE line that HAS seconds-shaped text but is NOT actually parseable
// (out-of-range month/day) -- r1's malformedSingle only checked
// hasDoneSecondsPrecision (text-shape), never parseability, so this exact
// value fell into neither "malformed, replace" nor "valid, refuse": it
// slipped through as ALREADY_FINALIZED while relay-handshake.mjs called it
// "not parseable" and told the caller it could be replaced. r2 reuses
// relay-handshake's own isWellFormedDoneTimestamp (파싱 가능 + 초 단위) so
// both sides agree this value is malformed and eligible for the one-time
// replace.
test("finalizeDone: 검토자 실측 입력 (seconds-shaped but unparseable, e.g. month=99) -> replaced once, not ALREADY_FINALIZED", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\nbody\n\n>>> DONE: CODER @ 2026-99-99 23:19:01 KST\n",
      "utf8",
    );
    const result = finalizeDone({
      role: "coder",
      harnessDir: dir,
      nowFn: () => Date.parse("2026-08-19T10:01:11Z"), // 2026-08-19 19:01:11 KST
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.REPLACED_MALFORMED);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      /^superseded_done: >>> DONE: CODER @ 2026-99-99 23:19:01 KST$/m,
      "original unparseable line must survive verbatim, non-column-0",
    );
    assert.match(
      content,
      />>> DONE: CODER @ 2026-08-19 19:01:11 KST/,
      "replacement must carry the machine clock, not any caller value",
    );
  });
});

// HYK-353 2R §1 (P1-2, 검토 반려) -------------------------------------------
//
// 재현: 정상 DONE을 observeDoneLine으로 먼저 기록(활성 첫 관측 생성)한 뒤,
// 결과 파일을 malformed DONE으로 덮어쓰고 finalizeDone을 호출한다. 수리
// 전에는 이 malformed 줄이 "교체 가능"으로 오인돼 REPLACED_MALFORMED가
// 실행됐다 -- 활성 관측이 있다는 사실 자체가 «이 malformed 값은 사후
// 변조일 수 있다»는 신호인데 그걸 무시하고 새 값을 찍어 증거를 지웠다.
test("finalizeDone: 활성 첫 관측이 있는데 malformed DONE으로 덮어쓴 뒤 finalize -- ACTIVE_OBSERVATION_BLOCKED로 거부, 파일은 변경되지 않는다 (P1-2)", () => {
  withDir((dir) => {
    const taskId = "HYK-1";
    const droppedAt = "2026-08-19 05:00 KST";
    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: ${taskId}\ndropped_at: ${droppedAt}\n`,
      "utf8",
    );
    const goodDoneRaw = ">>> DONE: CODER @ 2026-08-19 05:10:00 KST";
    const goodContent = `task_id: ${taskId}\n\n${goodDoneRaw}\n`;
    writeFileSync(join(dir, "coder.md"), goodContent, "utf8");
    const observed = observeDoneLine({
      taskId,
      droppedAt,
      role: "coder",
      harnessDir: dir,
      resultContent: goodContent,
      doneLineRaw: goodDoneRaw,
    });
    assert.equal(observed.rewritten, false);

    const malformedContent = `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-19 18:56 KST\n`;
    writeFileSync(join(dir, "coder.md"), malformedContent, "utf8");

    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      FINALIZE_DONE_REASON.ACTIVE_OBSERVATION_BLOCKED,
    );
    assert.equal(
      readFileSync(join(dir, "coder.md"), "utf8"),
      malformedContent,
      "the suspicious malformed content must survive untouched -- no laundered replacement",
    );
  });
});

// HYK-353 2R §1 (P1-2) 대조군: task 파일이 없으면(taskId/droppedAt을 독립적
//으로 구할 수 없음) 새 게이트는 판정 불가로 fail-open하고, 기존
// REPLACED_MALFORMED 경로는 byte-identical하게 유지된다(회귀 0 -- 이 파일의
// 다른 malformed-replace 시험들은 전부 task 파일 없이 finalizeDone을 직접
// 호출한다).
test("finalizeDone: task 파일이 없으면(taskId/droppedAt 독립 확인 불가) 활성 관측 게이트는 fail-open -- REPLACED_MALFORMED 그대로 (회귀 0)", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\nbody\n\n>>> DONE: CODER @ 2026-08-19 18:56 KST\n",
      "utf8",
    );
    const result = finalizeDone({
      role: "coder",
      harnessDir: dir,
      nowFn: () => Date.parse("2026-08-19T10:01:11Z"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.REPLACED_MALFORMED);
  });
});

// HYK-353 3R §2 (책임자 판정 2026-08-25 22:16, 범위 한 줄 한정) -----------
//
// 재현: 이 라운드의 관측 로그에 파싱 불가능한 줄 «하나만» 있는 상태(크래시
// 중 잘린 append를 흉내낸다 -- 그 줄이 정확히 이 라운드의 관측이었을
// 수도 있다). 수리 전에는 `readEntries`가 그 줄을 조용히 건너뛰어
// `findFirstObservation`이 빈 배열을 보고 "관측 없음"으로 접었고,
// `resolveActiveObservation`이 null을 반환해 malformed DONE 재발행이
// 그대로 허용됐다(REPLACED_MALFORMED, ok:true). "손상돼 못 읽음"(모름)과
// "애초에 없음"(정당)을 갈라야 한다는 §2의 요구를 위반한다.
test("finalizeDone: 관측 로그에 파싱 불가능한 줄이 있으면(손상) -- 판정 불가로 재발행 거부, 파일은 변경되지 않는다 (P1, 3R)", () => {
  withDir((dir) => {
    const taskId = "HYK-1";
    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: ${taskId}\ndropped_at: 2026-08-19 05:00 KST\n`,
      "utf8",
    );
    const malformedContent = `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-19 18:56 KST\n`;
    writeFileSync(join(dir, "coder.md"), malformedContent, "utf8");
    // A single line that fails JSON.parse -- could have been this round's
    // own first-observation entry, corrupted mid-write.
    writeFileSync(
      join(dir, "coder-done-first-observation.jsonl"),
      "{ this is not valid json\n",
      "utf8",
    );
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      FINALIZE_DONE_REASON.OBSERVATION_LOG_UNDECIDABLE,
    );
    assert.equal(
      readFileSync(join(dir, "coder.md"), "utf8"),
      malformedContent,
      "content must survive untouched -- a corrupted (undecidable) log must never be treated as 'no observation'",
    );
  });
});

// HYK-353 3R §3 대조군: 손상된 줄이 로그에 «없으면» 이 새 게이트는 발동하지
// 않는다 -- 손상 검사 자체가 거짓 양성을 내지 않음을 고정한다.
test("finalizeDone: 관측 로그가 정상(손상 없음)이고 관측도 없으면 -- OBSERVATION_LOG_UNDECIDABLE이 아니라 기존 경로 그대로 (오탐 0)", () => {
  withDir((dir) => {
    const taskId = "HYK-1";
    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: ${taskId}\ndropped_at: 2026-08-19 05:00 KST\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-19 18:56 KST\n`,
      "utf8",
    );
    // A well-formed but unrelated entry (different taskId) -- log is
    // readable and every line parses fine, just doesn't match this round.
    writeFileSync(
      join(dir, "coder-done-first-observation.jsonl"),
      `${JSON.stringify({ taskId: "HYK-OTHER", droppedAt: "2020-01-01 00:00 KST", observedAtMs: 1, resultFingerprint: "x", doneLineRaw: "y" })}\n`,
      "utf8",
    );
    const result = finalizeDone({
      role: "coder",
      harnessDir: dir,
      nowFn: () => Date.parse("2026-08-19T10:01:11Z"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.REPLACED_MALFORMED);
  });
});

// HYK-324/HYK-325 §3 시험4: already-replaced file -> refuses a 2nd replace.
test("finalizeDone: already-replaced file (superseded_done: present) -> ALREADY_REPLACED, refuses a second replace", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\nbody\n\nsuperseded_done: >>> DONE: CODER @ 2026-08-19 18:56 KST\n>>> DONE: CODER @ 2026-08-19 19:01:11 KST\ndone_stamped_by: finalize-done\n",
      "utf8",
    );
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.ALREADY_REPLACED);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      />>> DONE: CODER @ 2026-08-19 19:01:11 KST/,
      "already-replaced line must survive untouched",
    );
  });
});

test("CLI: malformed DONE line -> REPLACED_MALFORMED on stdout, replacement stamped on disk", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-19 18:56 KST\n",
      "utf8",
    );
    const res = runCli(["coder", dir]);
    assert.equal(res.exit, 0);
    assert.match(res.stdout, /^REPLACED_MALFORMED: >>> DONE: CODER @ /);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      /^superseded_done: >>> DONE: CODER @ 2026-08-19 18:56 KST$/m,
    );
  });
});

test("CLI: --at (or any --at=... form) is refused on sight, before any file is touched", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    const res = runCli(["coder", dir, "--at", "2020-01-01 00:00 KST"]);
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /rejects caller-supplied timestamps/);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.doesNotMatch(
      content,
      />>> DONE/,
      "no DONE line should have been written",
    );

    const res2 = runCli(["coder", dir, "--at=2020-01-01 00:00 KST"]);
    assert.notEqual(res2.exit, 0);
    assert.match(res2.stderr, /rejects caller-supplied timestamps/);
  });
});

// HYK-324/HYK-325 r2 §3 시험5 (검토 반려 P1 수리, production-entry-point):
// both CLIs run as REAL child processes (not the exported functions) against
// the SAME fixture directory, chained exactly as an operator would run them
// -- (1) relay-handshake.mjs sees the malformed stamp, skips first
// observation, and its stderr tells the caller "finalize-done 으로 1회
// 교체할 수 있다"; (2) finalize-done.mjs, run next against that same
// directory, actually performs that promised one-time replace. r1 only
// fixed the exported-function path (finalizeDone) and the unit-level
// malformedSingle check -- this locks the full CLI-to-CLI flow the review
// found broken, not just the library call.
function runHandshakeCli(args) {
  const res = spawnSync(process.execPath, [HANDSHAKE_CLI_PATH, ...args], {
    encoding: "utf8",
    // HYK-359 (2R ext, ORCH-53): the fixtures this file spawns
    // relay-handshake.mjs against never intend to exercise the admission-
    // completion side effect -- an ambient ADMISSION_LEDGER_PATH (real
    // shell leftover, or deliberately floated by hyk359-ambient-env-
    // regression.test.mjs's own sweep) made checkRelayHandshake attempt a
    // real completion against a ledger with no matching reservation
    // (RESERVATION_NOT_FOUND), tripping HYK-344's exit 3 instead of the 0
    // this file's own round-trip test expects -- not a marker-contract
    // failure, an environment-isolation gap in the spawn itself.
    env: isolatedChildEnv(),
  });
  assert.equal(res.error, undefined);
  assert.notEqual(res.status, null);
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

test("production entry point (검토자 실측 입력): relay-handshake CLI announces the 1회 교체 recovery path, finalize-done CLI actually performs it", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: HYK-1\ndropped_at: 2026-08-19 05:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\nbody\n\n>>> DONE: CODER @ 2026-99-99 23:19:01 KST\n",
      "utf8",
    );

    const handshake = runHandshakeCli(["CODER", dir]);
    assert.notEqual(handshake.exit, 0, "malformed DONE must not be consumed");
    assert.match(handshake.stderr, /not parseable/);
    assert.match(handshake.stderr, /finalize-done 으로 1회 교체할 수 있다/);

    const finalize = runCli(["coder", dir]);
    assert.equal(finalize.exit, 0);
    assert.match(finalize.stdout, /^REPLACED_MALFORMED: >>> DONE: CODER @ /);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      /^superseded_done: >>> DONE: CODER @ 2026-99-99 23:19:01 KST$/m,
    );
  });
});

// HYK-418 §2-1/§2-3 (deadlock recovery, round-trip): promoting relay-
// handshake.mjs's missing-marker check from a warning to a fail-closed
// rejection (coder-task.md §1 요구4's whole point) would be a dead end on
// its own -- finalize-done used to treat ANY format-valid DONE line as
// ALREADY_FINALIZED, so a round stamped by hand had no way out. This locks
// the full CLI-to-CLI recovery loop, same production-entry-point
// convention as the test directly above: (1) relay-handshake CLI rejects
// the unmarked DONE and names the exact recovery command, (2) finalize-
// done CLI performs the one-time REPLACED_UNMARKED replace, (3) relay-
// handshake CLI, run again against the SAME round, now accepts it.
test("HYK-418 §2-3 production entry point: relay-handshake CLI rejects an unmarked well-formed DONE and names the recovery command; finalize-done CLI's one-time REPLACED_UNMARKED clears it; relay-handshake CLI then accepts the SAME round", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: HYK-1\ndropped_at: 2026-08-19 05:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\nbody\n\n>>> DONE: CODER @ 2026-08-19 05:10:00 KST\n",
      "utf8",
    );

    const before = runHandshakeCli(["CODER", dir]);
    assert.notEqual(
      before.exit,
      0,
      "unmarked (hand-typed) DONE must not be consumed",
    );
    assert.match(before.stderr, /no finalize-done marker/);
    assert.match(
      before.stderr,
      /node scripts\/relay\/finalize-done\.mjs CODER/,
    );

    const finalize = runCli(["coder", dir]);
    assert.equal(finalize.exit, 0);
    assert.match(finalize.stdout, /^REPLACED_UNMARKED: >>> DONE: CODER @ /);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      /^superseded_done: >>> DONE: CODER @ 2026-08-19 05:10:00 KST$/m,
    );
    assert.match(content, /^done_stamped_by: finalize-done$/m);

    const after = runHandshakeCli(["CODER", dir]);
    assert.equal(
      after.exit,
      0,
      "after the one-time machine re-stamp, the SAME round must now be consumable -- otherwise the promotion in coder-task.md §1 요구4 creates a dead end, not a recovery",
    );
  });
});
