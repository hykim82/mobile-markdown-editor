import { test } from "node:test";
import assert from "node:assert/strict";
import { openSync, closeSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BLOCKING_ROLE,
  isBlockingRole,
  isRecursiveStop,
  formatBlockReason,
  resolveStopBlock,
  readStopHookPayload,
} from "./stop-blocking.mjs";

// A valid, well-formed "no recursion" payload -- the anchor case: reading a
// real ({} object, successfully parsed) payload must still allow blocking.
const READABLE_EMPTY = { ok: true, payload: {} };
const READABLE_RECURSIVE = { ok: true, payload: { stop_hook_active: true } };
const UNREADABLE = { ok: false, payload: {} };

test("(1) isBlockingRole: only 'ORCH' is blocking", () => {
  assert.equal(isBlockingRole("ORCH"), true);
  assert.equal(isBlockingRole(BLOCKING_ROLE), true);
  for (const role of ["PM", "CODER", "REVIEW", "VERIFY", undefined, null, "", "orch"]) {
    assert.equal(isBlockingRole(role), false);
  }
});

test("(2) isRecursiveStop: true only for stop_hook_active === true", () => {
  assert.equal(isRecursiveStop({ stop_hook_active: true }), true);
  assert.equal(isRecursiveStop({ stop_hook_active: false }), false);
  assert.equal(isRecursiveStop({}), false);
  assert.equal(isRecursiveStop(null), false);
  assert.equal(isRecursiveStop(undefined), false);
  assert.equal(isRecursiveStop({ stop_hook_active: "true" }), false);
});

test("(3) formatBlockReason: contains all four required fields", () => {
  const reason = formatBlockReason({
    checkId: "clear-safe-check",
    reasonCode: "clear_safe_incomplete",
    repairHint: "fill in the receipt",
  });
  assert.match(reason, /\[clear-safe-check\]/);
  assert.match(reason, /reason_code=clear_safe_incomplete/);
  assert.match(reason, /repair_hint=fill in the receipt/);
  assert.match(reason, /attempt=1\/1/);
});

test("(4) resolveStopBlock: role !== ORCH -> exit 0 even on a confirmed failure", () => {
  for (const role of ["PM", "CODER", "REVIEW", "VERIFY", undefined, null, ""]) {
    const decision = resolveStopBlock({
      role,
      hookPayloadResult: READABLE_EMPTY,
      ok: false,
      checkId: "clear-safe-check",
      reasonCode: "clear_safe_incomplete",
      repairHint: "fix it",
    });
    assert.equal(decision.exit, 0, `role=${role} must pass through`);
    assert.match(decision.reason, /blocking applies to ORCH only/);
  }
});

test("(5) resolveStopBlock: role === ORCH + ok:true -> exit 0, no block", () => {
  const decision = resolveStopBlock({
    role: "ORCH",
    hookPayloadResult: READABLE_EMPTY,
    ok: true,
    checkId: "clear-safe-check",
    reasonCode: "clear_safe_incomplete",
    repairHint: "n/a",
  });
  assert.equal(decision.exit, 0);
  assert.equal(decision.reason, null);
});

test("(6) resolveStopBlock: role === ORCH + confirmed failure + readable {} payload + first attempt -> exit 2 with 4-field reason (anchor: a real, well-formed, empty payload must still allow blocking)", () => {
  const decision = resolveStopBlock({
    role: "ORCH",
    hookPayloadResult: READABLE_EMPTY,
    ok: false,
    checkId: "controlroom-fresh",
    reasonCode: "controlroom_stale",
    repairHint: "commit the control room",
  });
  assert.equal(decision.exit, 2);
  assert.match(decision.reason, /\[controlroom-fresh\]/);
  assert.match(decision.reason, /reason_code=controlroom_stale/);
  assert.match(decision.reason, /repair_hint=commit the control room/);
  assert.match(decision.reason, /attempt=1\/1/);
});

test("(7) resolveStopBlock: role === ORCH + confirmed failure + stop_hook_active -> exit 0, not re-blocked", () => {
  const decision = resolveStopBlock({
    role: "ORCH",
    hookPayloadResult: READABLE_RECURSIVE,
    ok: false,
    checkId: "clear-safe-check",
    reasonCode: "clear_safe_incomplete",
    repairHint: "still broken",
  });
  assert.equal(decision.exit, 0);
  assert.match(decision.reason, /stop_hook_active/);
  assert.match(decision.reason, /not re-blocking/);
});

test("(8) resolveStopBlock: stop_hook_active guard takes effect even for non-ORCH (role check short-circuits first either way)", () => {
  const decision = resolveStopBlock({
    role: "CODER",
    hookPayloadResult: READABLE_RECURSIVE,
    ok: false,
    checkId: "clear-safe-check",
    reasonCode: "clear_safe_incomplete",
    repairHint: "n/a",
  });
  assert.equal(decision.exit, 0);
});

test("(10) resolveStopBlock: repairHint carries through unmodified into the block reason (no re-summarizing)", () => {
  const repairHint = "attest marker present but reconciled= is empty -- run /capture-context";
  const decision = resolveStopBlock({
    role: "ORCH",
    hookPayloadResult: READABLE_EMPTY,
    ok: false,
    checkId: "clear-safe-check",
    reasonCode: "clear_safe_incomplete",
    repairHint,
  });
  assert.match(decision.reason, new RegExp(repairHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// --- review-1 rejected fix: malformed/unreadable Stop payload must be
// UNJUDGABLE (exit 0), never allowed to reach blocking severity (G3) ---

test("(11) resolveStopBlock: role === ORCH + confirmed failure + unreadable payload -> exit 0, UNJUDGABLE (never exit 2 on an assumption)", () => {
  const decision = resolveStopBlock({
    role: "ORCH",
    hookPayloadResult: UNREADABLE,
    ok: false,
    checkId: "clear-safe-check",
    reasonCode: "clear_safe_incomplete",
    repairHint: "fix it",
  });
  assert.equal(decision.exit, 0);
  assert.match(decision.reason, /reason_code=stop_payload_unreadable/);
  assert.match(decision.reason, /UNJUDGABLE/);
});

test("(12) resolveStopBlock: unreadable payload takes priority over ok:true (still exit 0, but for the right reason -- doesn't matter here since both are 0, but the reason text should reflect payload unreadability when both conditions independently hold)", () => {
  const decision = resolveStopBlock({
    role: "ORCH",
    hookPayloadResult: UNREADABLE,
    ok: true,
    checkId: "clear-safe-check",
    reasonCode: "clear_safe_incomplete",
    repairHint: "n/a",
  });
  assert.equal(decision.exit, 0);
});

test("(13) resolveStopBlock: non-ORCH role + unreadable payload -> exit 0 via the role gate (short-circuits before payload is even considered)", () => {
  const decision = resolveStopBlock({
    role: "CODER",
    hookPayloadResult: UNREADABLE,
    ok: false,
    checkId: "clear-safe-check",
    reasonCode: "clear_safe_incomplete",
    repairHint: "n/a",
  });
  assert.equal(decision.exit, 0);
  assert.match(decision.reason, /blocking applies to ORCH only/);
});

// --- readStopHookPayload: real fd reads (openSync a temp file, no fake
// stdin trickery needed since readFileSync accepts any fd, not just 0) ---

function withPayloadFd(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "stop-blocking-test-"));
  const filePath = join(dir, "payload.json");
  writeFileSync(filePath, content, "utf8");
  const fd = openSync(filePath, "r");
  try {
    fn(fd);
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("(14) readStopHookPayload: valid JSON object -> { ok: true, payload }", () => {
  withPayloadFd('{"stop_hook_active":true,"session_id":"abc"}', (fd) => {
    assert.deepEqual(readStopHookPayload(fd), { ok: true, payload: { stop_hook_active: true, session_id: "abc" } });
  });
});

test("(15) readStopHookPayload: valid empty object '{}' -> { ok: true, payload: {} } (anchor: a real, well-formed empty payload is NOT the same as unreadable)", () => {
  withPayloadFd("{}", (fd) => {
    assert.deepEqual(readStopHookPayload(fd), { ok: true, payload: {} });
  });
});

test("(16) readStopHookPayload: malformed/non-JSON content -> { ok: false, payload: {} } (review-1 repro)", () => {
  withPayloadFd("not-json", (fd) => {
    assert.deepEqual(readStopHookPayload(fd), { ok: false, payload: {} });
  });
});

test("(17) readStopHookPayload: empty file/stdin -> { ok: false, payload: {} } (review-1 repro)", () => {
  withPayloadFd("", (fd) => {
    assert.deepEqual(readStopHookPayload(fd), { ok: false, payload: {} });
  });
});

test("(18) readStopHookPayload: valid JSON that isn't an object (array) -> { ok: false, payload: {} }", () => {
  withPayloadFd("[1,2,3]", (fd) => {
    assert.deepEqual(readStopHookPayload(fd), { ok: false, payload: {} });
  });
});

test("(19) readStopHookPayload: valid JSON that isn't an object (null literal) -> { ok: false, payload: {} }", () => {
  withPayloadFd("null", (fd) => {
    assert.deepEqual(readStopHookPayload(fd), { ok: false, payload: {} });
  });
});

test("(20) readStopHookPayload: unreadable fd (already closed) -> { ok: false, payload: {} }, never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "stop-blocking-test-"));
  const filePath = join(dir, "payload.json");
  writeFileSync(filePath, "{}", "utf8");
  const fd = openSync(filePath, "r");
  closeSync(fd); // fd is now invalid
  try {
    assert.deepEqual(readStopHookPayload(fd), { ok: false, payload: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
