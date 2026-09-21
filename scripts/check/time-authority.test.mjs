// HYK-186 완료조건1 -- registry shape/consumption tests. See
// hyk186-time-authority-mutation.test.mjs for the "행/결선 제거 -> RED"
// mutation coverage this completion condition also requires.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIME_FIELD,
  TIME_AUTHORITY_STATE,
  TIME_AUTHORITY_REGISTRY,
  MAX_FUTURE_SKEW_MS,
  findTimeAuthorityRow,
  isBeyondFutureSkew,
} from "./time-authority.mjs";

const REQUIRED_ROW_KEYS = [
  "field",
  "producer",
  "consumer",
  "authorityClock",
  "formatPrecision",
  "lowerRule",
  "upperRule",
  "upperBoundMs",
  "stateOnViolation",
];

test("HYK-186 완료조건1: registry has exactly the two trust-boundary-(A) fields, each with every required column", () => {
  assert.equal(TIME_AUTHORITY_REGISTRY.length, 2);
  const fields = TIME_AUTHORITY_REGISTRY.map((r) => r.field).sort();
  assert.deepEqual(
    fields,
    [TIME_FIELD.RESULT_DONE_AT, TIME_FIELD.TASK_DROPPED_AT].sort(),
  );
  for (const row of TIME_AUTHORITY_REGISTRY) {
    for (const key of REQUIRED_ROW_KEYS) {
      assert.ok(
        Object.hasOwn(row, key) && row[key] !== undefined && row[key] !== "",
        `row for ${row.field} missing/empty column '${key}'`,
      );
    }
    assert.equal(
      typeof row.producer === "string" && row.producer.includes(".mjs"),
      true,
      `row for ${row.field} producer must name a concrete file`,
    );
    assert.equal(
      typeof row.consumer === "string" && row.consumer.includes(".mjs"),
      true,
      `row for ${row.field} consumer must name a concrete file`,
    );
  }
});

test("HYK-186: registry is frozen (rows and the array itself) -- no accidental in-place mutation by a consumer", () => {
  assert.ok(Object.isFrozen(TIME_AUTHORITY_REGISTRY));
  for (const row of TIME_AUTHORITY_REGISTRY) {
    assert.ok(Object.isFrozen(row));
  }
});

test("findTimeAuthorityRow: unregistered field returns null (fail-closed anchor for isBeyondFutureSkew)", () => {
  assert.equal(findTimeAuthorityRow("no.such.field"), null);
  assert.equal(
    findTimeAuthorityRow(TIME_FIELD.TASK_DROPPED_AT).field,
    TIME_FIELD.TASK_DROPPED_AT,
  );
});

test("isBeyondFutureSkew: within skew -> false, beyond skew -> true, unregistered field -> null (never silently false)", () => {
  const now = 1_000_000;
  assert.equal(
    isBeyondFutureSkew(now, now, TIME_FIELD.RESULT_DONE_AT),
    false,
    "candidate == now must be within bounds",
  );
  assert.equal(
    isBeyondFutureSkew(
      now + MAX_FUTURE_SKEW_MS,
      now,
      TIME_FIELD.RESULT_DONE_AT,
    ),
    false,
    "candidate exactly at the boundary is NOT beyond it (boundary itself passes)",
  );
  assert.equal(
    isBeyondFutureSkew(
      now + MAX_FUTURE_SKEW_MS + 1,
      now,
      TIME_FIELD.RESULT_DONE_AT,
    ),
    true,
    "candidate one unit past the boundary is a violation",
  );
  assert.equal(
    isBeyondFutureSkew(now + 1, now, "unregistered.field"),
    null,
    "unregistered field must return null, not false -- callers must fail-closed on null",
  );
});

// HYK-257: two more states added -- SUSPECTED_TZ_MISLABEL_DONE/
// SUSPECTED_TZ_MISLABEL_DROPPED_AT (relay-handshake.mjs's checkTimezoneMislabel,
// see that file's own header). watch-result.mjs's isFutureRejectedState does
// NOT recognize these two (deliberately -- they are a distinct diagnosis
// from "future", not a future-rejected verdict) -- a round blocked this way
// still surfaces loudly through checkRelayHandshake's own ok:false/reason,
// just not through the future_rejected watch-result exit code. 정직 한계:
// wiring the watch-result-side notification for this new state pair is
// follow-up scope, not this task's (coder-task.md §2 범위: relay-handshake
// 소비 게이트 자체가 막는지가 이 라운드의 완료 조건).
// HYK-257-done-stamp-2 §2 범위1: a fifth state added --
// DONE_REWRITTEN_AFTER_FIRST_OBSERVATION (relay-handshake.mjs's
// checkRelayHandshake, first-observation.mjs's observeDoneLine). Not a
// future-skew or mislabel diagnosis -- it fires when a result file's
// '>>> DONE:' line differs between the first time this exact round
// (taskId + dropped_at) was observed and the final judged-ok:true moment,
// proving an intermediate rewrite happened before judgment could ever see
// it. Immediate reject (not warn-and-pass), matching this registry's
// existing fail-loud posture for every other row here.
test("HYK-186/HYK-257/HYK-257-done-stamp-2: TIME_AUTHORITY_STATE exposes exactly the five states relay-handshake.mjs consumes", () => {
  assert.deepEqual(Object.keys(TIME_AUTHORITY_STATE).sort(), [
    "DONE_REWRITTEN_AFTER_FIRST_OBSERVATION",
    "FUTURE_DONE",
    "FUTURE_DROPPED_AT",
    "SUSPECTED_TZ_MISLABEL_DONE",
    "SUSPECTED_TZ_MISLABEL_DROPPED_AT",
  ]);
});
