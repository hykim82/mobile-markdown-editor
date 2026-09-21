import { readFileSync } from "node:fs";

// Single declaration for the role this adapter allows to block at all --
// referenced by isBlockingRole and by every promoted checker's honesty
// notes, never repeated as a bare "ORCH" string literal (C.7).
export const BLOCKING_ROLE = "ORCH";

// Reads a Stop hook's stdin JSON payload (session_id, stop_hook_active, ...).
// Returns { ok, payload } -- `ok` preserves whether a well-formed JSON
// *object* was actually read, rather than silently collapsing every failure
// mode (empty stdin, non-JSON, JSON that parses to a non-object) into `{}`.
// That distinction matters: `{}` is a *confirmed* "no stop_hook_active, no
// recursion" payload (still eligible for blocking), while missing/malformed
// stdin is *uncertain* -- G3's "cannot judge -> UNJUDGABLE, never block"
// posture applies here exactly like it does to every other checker's own
// file/parse/git/network reads (review-1 rejected an earlier version of this
// function for collapsing that distinction and letting a malformed-stdin
// call reach blocking severity).
export function readStopHookPayload(fd = 0) {
  let raw;
  try {
    raw = readFileSync(fd, "utf8");
  } catch {
    return { ok: false, payload: {} };
  }
  if (!raw) return { ok: false, payload: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, payload: {} };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, payload: {} };
  }
  return { ok: true, payload: parsed };
}

export function isBlockingRole(role) {
  return role === BLOCKING_ROLE;
}

// Claude Code's Stop hook sets `stop_hook_active: true` on the re-invocation
// that follows a prior Stop hook's own block within the same turn -- this is
// the one-shot recursion guard: without it, a still-unresolved confirmed
// failure would re-block forever.
export function isRecursiveStop(hookPayload) {
  return hookPayload?.stop_hook_active === true;
}

// Renders the four required fields a promoted block must carry (design doc
// §4): check_id, reason_code, repair_hint (what ORCH should fix, one line),
// and attempt=N/M -- a single machine-parseable stderr line instead of free
// text, so the model gets one unambiguous self-repair cue.
export function formatBlockReason({ checkId, reasonCode, repairHint, attempt = 1, maxAttempts = 1 }) {
  return `[${checkId}] reason_code=${reasonCode} repair_hint=${repairHint} attempt=${attempt}/${maxAttempts}`;
}

// Single decision point every promoted Stop checker's CLI defers to *after*
// it has already computed its own confirmed ok/fail verdict via its existing
// pure check function. This adapter never re-derives fail-open/UNJUDGABLE for
// the *checker's own* file/parse/git/network reads -- each checker's pure
// function already returns ok:true for those (G3); this adapter only decides
// *severity* once a checker has confirmed an actual failure, plus its own
// G3 obligation over the one input it reads itself (the Stop hook payload):
//   - role !== ORCH -> exit 0, unconditionally. Blocking is ORCH-only by
//     design (STATUS/control-room hygiene is ORCH's to own, not PM/CODER/
//     REVIEW/VERIFY's) -- non-ORCH roles get an optional stderr diagnostic,
//     never a block, and never even the old advisory exit 1.
//   - hookPayloadResult.ok === false -- the Stop hook's own stdin payload
//     was missing/malformed/non-object; whether this is actually a
//     stop_hook_active re-invocation cannot be confirmed, so this is
//     UNJUDGABLE (G3): exit 0, never block on an assumption.
//   - stop_hook_active -- a prior Stop in this same turn already surfaced
//     one block; do not re-block (infinite-loop guard). The failure is still
//     unresolved, so a diagnostic reason is still returned, just at exit 0.
//   - ok -- nothing confirmed wrong, exit 0.
//   - otherwise -- confirmed failure, ORCH turn, first attempt, readable
//     payload: exit 2 with the four-field reason string above.
export function resolveStopBlock({ role, hookPayloadResult, ok, checkId, reasonCode, repairHint }) {
  if (!isBlockingRole(role)) {
    return {
      exit: 0,
      reason: `${checkId}: HARNESS_ROLE=${role ?? "unset"} -- blocking applies to ORCH only, passing through`,
    };
  }
  if (!hookPayloadResult?.ok) {
    return {
      exit: 0,
      reason: `${checkId}: reason_code=stop_payload_unreadable -- Stop hook stdin payload missing/unparseable, cannot confirm stop_hook_active -- UNJUDGABLE, not blocking`,
    };
  }
  if (isRecursiveStop(hookPayloadResult.payload)) {
    return {
      exit: 0,
      reason: `${checkId}: stop_hook_active -- one self-repair attempt already given this turn, not re-blocking (${repairHint})`,
    };
  }
  if (ok) {
    return { exit: 0, reason: null };
  }
  return { exit: 2, reason: formatBlockReason({ checkId, reasonCode, repairHint, attempt: 1, maxAttempts: 1 }) };
}
