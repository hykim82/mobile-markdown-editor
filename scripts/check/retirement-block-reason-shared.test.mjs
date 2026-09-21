// HYK-457 §3-C: regression coverage for the exact drift shape that caused
// the real production failure this round fixes -- a new reason gets added
// to retirement-record-core.mjs's MECHANICALLY_CONFIRMABLE_BLOCK_REASONS
// (closed set), but one of the two implementations of
// confirmRetirementBlockReason never grows a branch for it, so that
// implementation silently falls through to `return null` for that reason
// forever (2026-09-08 ORCH-63 isolated measurement: HYK-455 added
// RUNNER_GREEN_UNREACHABLE_AT_HEAD to the set and wired a branch in
// dispatch-gate-decision.mjs's copy only -- admission-completion-adapter.mjs's
// copy fail-closed every real retirement using that reason). Merging the two
// copies into retirement-block-reason-shared.mjs (this round) makes that
// SPECIFIC drift structurally impossible (there is only one implementation
// now) -- but a future round could still add a reason to the closed set
// without adding a branch to the shared confirm function, silently
// reintroducing the same fail-closed shape from a single copy. §3-C's
// counting-tests-are-forbidden instruction ("개수만 세는 시험은 금지") is
// honored here by requiring, per reason, an actual fixture that proves the
// branch executes and returns the correct boolean -- not just that the
// element is present in the Set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RETIREMENT_BLOCK_REASON,
  MECHANICALLY_CONFIRMABLE_BLOCK_REASONS,
} from "./retirement-record-core.mjs";
import { confirmRetirementBlockReason } from "./retirement-block-reason-shared.mjs";

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Per-reason (fixture, expected-verdict) pairs. Each builder returns the
// exact (record, resultText, droppedAt, harnessDir) confirmRetirementBlockReason
// takes, plus the boolean it must return for THIS evidence shape. Adding a
// new reason to MECHANICALLY_CONFIRMABLE_BLOCK_REASONS without adding a
// matching entry here fails the "every reason has a builder" assertion
// below -- adding a builder here for a reason the shared function still
// doesn't branch on fails the "returns the expected boolean, not null"
// assertion. Both failure modes are the HYK-457 regression shape.
const FIXTURE_BUILDERS = {
  [RETIREMENT_BLOCK_REASON.DONE_TIMESTAMP_NOT_PARSEABLE]: () => ({
    record: {
      blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_TIMESTAMP_NOT_PARSEABLE,
    },
    resultText: ">>> DONE: CODER @ not-a-real-timestamp\n",
    droppedAt: "2025-01-01 00:00:00 KST",
    harnessDir: tmpDir("hyk457-table-parseable-"),
    expected: true,
  }),
  [RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT]: () => ({
    record: {
      blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT,
    },
    resultText: ">>> DONE: CODER @ 2020-01-01 00:00:00 KST\n",
    droppedAt: "2025-01-01 00:00:00 KST",
    harnessDir: tmpDir("hyk457-table-predates-"),
    expected: true,
  }),
  [RETIREMENT_BLOCK_REASON.RUNNER_GREEN_UNREACHABLE_AT_HEAD]: () => {
    const harnessDir = tmpDir("hyk457-table-runnergreen-");
    const headCommit = "a".repeat(40);
    writeFileSync(
      join(harnessDir, "runner-receipt.json"),
      JSON.stringify({ head_commit: headCommit, runner_exit: 1 }),
      "utf8",
    );
    return {
      record: {
        blockReasonCode:
          RETIREMENT_BLOCK_REASON.RUNNER_GREEN_UNREACHABLE_AT_HEAD,
        evidenceReceiptPath: "runner-receipt.json",
      },
      resultText: `head_commit: ${headCommit}\n`,
      droppedAt: null,
      harnessDir,
      expected: true,
    };
  },
  // HYK-478 §1-2: AUTHOR_SEAT_LOST_BEFORE_STAMP -- GREEN 표본은 ⓐ완료
  // 표지 0개(resultText에 `>>> DONE:` 줄이 아예 없음) + ⓑ admission
  // 원장에서 그 harnessTaskLabel의 예약이 SUSPECT(sweepAndRecover가 이미
  // liveSeatKeys 부재를 근거로 새겨 둔 상태)여야 둘 다 참이다.
  [RETIREMENT_BLOCK_REASON.AUTHOR_SEAT_LOST_BEFORE_STAMP]: () => {
    const harnessDir = tmpDir("hyk478-table-seatlost-");
    const harnessTaskLabel = "HYK-478-table-seatlost-round";
    const ledgerPath = join(harnessDir, "admission-ledger.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: "admission-ledger/v1",
        reservations: {
          [harnessTaskLabel]: {
            status: "SUSPECT",
            admitted_at: "2026-09-16T00:00:00.000Z",
            completed_at: null,
            suspect_at: "2026-09-16T00:10:01.000Z",
            role: "CODER",
            seat_key: "seat-that-died",
          },
        },
      }),
      "utf8",
    );
    return {
      record: {
        blockReasonCode: RETIREMENT_BLOCK_REASON.AUTHOR_SEAT_LOST_BEFORE_STAMP,
        harnessTaskLabel,
      },
      resultText: `task_id: ${harnessTaskLabel}\n`,
      droppedAt: null,
      harnessDir,
      ledgerPath,
      expected: true,
    };
  },
};

test("HYK-457 §3-C (HYK-478 확대): MECHANICALLY_CONFIRMABLE_BLOCK_REASONS's known reasons still each have a FIXTURE_BUILDERS entry (sanity floor for the loop below)", () => {
  assert.deepEqual(
    new Set(Object.keys(FIXTURE_BUILDERS)),
    new Set([...MECHANICALLY_CONFIRMABLE_BLOCK_REASONS]),
    "FIXTURE_BUILDERS and the live MECHANICALLY_CONFIRMABLE_BLOCK_REASONS set have drifted -- add/remove a builder to match",
  );
});

test("HYK-457 §3-C: every MECHANICALLY_CONFIRMABLE_BLOCK_REASONS member reaches a real branch in confirmRetirementBlockReason and returns the correct boolean (table-driven; auto-walks the LIVE set so a new reason is covered the moment it's added to both)", () => {
  for (const reason of MECHANICALLY_CONFIRMABLE_BLOCK_REASONS) {
    const builder = FIXTURE_BUILDERS[reason];
    assert.ok(
      builder,
      `MECHANICALLY_CONFIRMABLE_BLOCK_REASONS grew a new reason ('${reason}') with no FIXTURE_BUILDERS entry in this regression test -- this IS the HYK-457 drift shape: a reason can be "in the closed set" while nothing confirms it. Add a builder here.`,
    );
    const { record, resultText, droppedAt, harnessDir, ledgerPath, expected } =
      builder();
    const actual = confirmRetirementBlockReason(
      record,
      resultText,
      droppedAt,
      harnessDir,
      ledgerPath,
    );
    assert.equal(
      typeof actual,
      "boolean",
      `confirmRetirementBlockReason returned ${JSON.stringify(actual)} (not a boolean) for mechanically-confirmable reason '${reason}' -- this is exactly the HYK-457 regression: a reason is in the closed set but no branch confirms it, so it falls through to null and retirement-record-core.mjs's checkRetirementRecord rejects with BLOCK_REASON_UNCONFIRMED forever.`,
    );
    assert.equal(
      actual,
      expected,
      `unexpected verdict for reason '${reason}' with its GREEN fixture`,
    );
  }
});

// Negative counterpart: prove the table isn't just asserting "always true".
// Same three reasons, evidence deliberately broken one axis each.
test("HYK-457 §3-C negative: the same three reasons return false (not null, not true) when their evidence is broken", () => {
  assert.equal(
    confirmRetirementBlockReason(
      { blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_TIMESTAMP_NOT_PARSEABLE },
      ">>> DONE: CODER @ 2025-01-01 00:00:00 KST\n",
      "2025-01-02 00:00:00 KST",
      tmpDir("hyk457-table-neg-parseable-"),
    ),
    false,
  );
  assert.equal(
    confirmRetirementBlockReason(
      { blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT },
      ">>> DONE: CODER @ 2030-01-01 00:00:00 KST\n",
      "2025-01-01 00:00:00 KST",
      tmpDir("hyk457-table-neg-predates-"),
    ),
    false,
  );
  const harnessDir = tmpDir("hyk457-table-neg-runnergreen-");
  const headCommit = "a".repeat(40);
  writeFileSync(
    join(harnessDir, "runner-receipt.json"),
    JSON.stringify({ head_commit: headCommit, runner_exit: 0 }),
    "utf8",
  );
  assert.equal(
    confirmRetirementBlockReason(
      {
        blockReasonCode:
          RETIREMENT_BLOCK_REASON.RUNNER_GREEN_UNREACHABLE_AT_HEAD,
        evidenceReceiptPath: "runner-receipt.json",
      },
      `head_commit: ${headCommit}\n`,
      null,
      harnessDir,
    ),
    false,
  );
  // HYK-478 §1-2 negative (ⓐ 위반): 완료 표지가 실제로 «있는»데(1개)
  // AUTHOR_SEAT_LOST_BEFORE_STAMP를 대는 경우 -- ⓑ(원장 SUSPECT)는 참이어도
  // 전체는 거짓이어야 한다(§2 완료조건2 "하나라도 거짓이면 거부").
  const seatLostHarnessTaskLabel = "HYK-478-table-neg-seatlost-round";
  const seatLostLedgerPath = join(
    tmpDir("hyk478-table-neg-seatlost-"),
    "admission-ledger.json",
  );
  writeFileSync(
    seatLostLedgerPath,
    JSON.stringify({
      schema_version: "admission-ledger/v1",
      reservations: {
        [seatLostHarnessTaskLabel]: {
          status: "SUSPECT",
          admitted_at: "2026-09-16T00:00:00.000Z",
          completed_at: null,
          suspect_at: "2026-09-16T00:10:01.000Z",
          role: "CODER",
          seat_key: "seat-that-died",
        },
      },
    }),
    "utf8",
  );
  assert.equal(
    confirmRetirementBlockReason(
      {
        blockReasonCode: RETIREMENT_BLOCK_REASON.AUTHOR_SEAT_LOST_BEFORE_STAMP,
        harnessTaskLabel: seatLostHarnessTaskLabel,
      },
      `task_id: ${seatLostHarnessTaskLabel}\n>>> DONE: CODER @ 2026-09-16 00:20:00 KST\n`,
      null,
      tmpDir("hyk478-table-neg-seatlost-harnessdir-"),
      seatLostLedgerPath,
    ),
    false,
  );
});

test("confirmRetirementBlockReason returns null (not a fake boolean) for a contract-text-only reason it cannot mechanically confirm", () => {
  assert.equal(
    confirmRetirementBlockReason(
      { blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_REWRITE_LOCKED },
      ">>> DONE: CODER @ 2025-01-01 00:00:00 KST\n",
      "2025-01-02 00:00:00 KST",
      tmpDir("hyk457-table-nonmech-"),
    ),
    null,
  );
});
