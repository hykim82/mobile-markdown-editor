// HYK-257-done-stamp-lint-1 -- pure core extracted from
// scripts/relay/stamp-dropped-at.mjs so scripts/check/dispatch-gate-
// decision.mjs can use it WITHOUT importing across the scripts/check ->
// scripts/relay boundary (the repo's architecture rule -- A3 inventory,
// HYK-148 -- is "real dependency direction is relay -> check only"; a
// scripts/check/* file importing scripts/relay/* is backwards and is an
// ESLint no-restricted-imports error, not a style nit).
//
// This file has ZERO side-effect imports (no node:fs/node:child_process/
// etc) -- exactly like consumption-receipt-core.mjs's own "zero-import
// core" pattern this repo already uses (see dispatch-gate-decision.mjs's
// own header comment on that file for the same reasoning): a pure core is
// safe for BOTH scripts/check/* callers (this direction is fine, check ->
// check) and scripts/relay/* callers (relay -> check is the allowed
// direction) to import statically, with no risk of pulling in a forbidden
// transitive dependency either way.
//
// scripts/relay/stamp-dropped-at.mjs re-exports stampDroppedAt/
// STAMP_DROPPED_AT_REASON from here (relay -> check, allowed) so its own
// CLI entry point and existing external callers/tests are unchanged --
// this is a pure move, not a behavior change (coder-task.md 이번
// 라운드 §3 요건1: 동작 변경 0).

function pad(n) {
  return String(n).padStart(2, "0");
}

// KST has no DST -- a fixed +9h offset from UTC is exact and stable, unlike
// relying on the host machine's local timezone setting (same rationale as
// finalize-done.mjs's own formatKst). Minute precision, no seconds --
// dropped_at's registered formatPrecision (scripts/check/time-authority.mjs)
// and task-drop-core.mjs's DROPPED_AT_FORMAT_RE both expect exactly this
// shape ("YYYY-MM-DD HH:MM KST").
function formatKstMinute(nowMs) {
  const kst = new Date(nowMs + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(
    kst.getUTCDate(),
  )} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())} KST`;
}

export const STAMP_DROPPED_AT_REASON = Object.freeze({
  CALLER_SUPPLIED_TIME_REJECTED: "CALLER_SUPPLIED_TIME_REJECTED",
  STAMPED: "STAMPED",
});

// stampDroppedAt({ callerSuppliedAt, nowFn }) -> { ok, reasonCode, reason?, value?, nowMs? }
//
// `callerSuppliedAt`: MUST be omitted (undefined). Passing anything else --
// a string, a Date, a number, even a value equal to what the machine clock
// would have produced anyway -- is refused outright, mirroring
// finalize-done.mjs's `callerSuppliedAt` contract exactly: this producer
// does not read a caller-supplied time argument at all.
export function stampDroppedAt({
  callerSuppliedAt,
  nowFn = () => Date.now(),
} = {}) {
  if (callerSuppliedAt !== undefined) {
    return {
      ok: false,
      reasonCode: STAMP_DROPPED_AT_REASON.CALLER_SUPPLIED_TIME_REJECTED,
      reason:
        "stamp-dropped-at rejects caller-supplied timestamps -- this producer always records its own machine clock (Date.now()) at stamp time; do not pass callerSuppliedAt",
    };
  }
  const nowMs = nowFn();
  return {
    ok: true,
    reasonCode: STAMP_DROPPED_AT_REASON.STAMPED,
    value: formatKstMinute(nowMs),
    nowMs,
  };
}
