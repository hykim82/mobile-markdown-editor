import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkClearSafe, parseCycleReceipt } from "./clear-safe-check.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./clear-safe-check.mjs", import.meta.url));

const FULL_CYCLE_RECEIPT = [
  "<!-- cycle-receipt:",
  "  boundary: cycle",
  "  task_id: HYK-128-coder-1",
  "  result_ref: a333083",
  "  issue_ids: HYK-128",
  "  sync_result: ok",
  "  status_updated: yes",
  "  phase_update_needed: no",
  "-->",
].join("\n");

const FULL_PHASE_RECEIPT = [
  "<!-- cycle-receipt:",
  "  boundary: phase",
  "  task_id: HYK-128-coder-2",
  "  result_ref: a333083",
  "  issue_ids: HYK-128",
  "  sync_result: ok",
  "  status_updated: yes",
  "  phase_update_needed: yes",
  "  open_set_sync: ok",
  "-->",
].join("\n");

function greenWithAttest(receiptBlock) {
  return (
    "### 3) /clear 안전\n" +
    "🟢 **전 역할 안전** — /clear 가능.\n" +
    "<!-- clear-safe-attest: reconciled=2026-07-12 20:00 KST delta=applied -->\n" +
    (receiptBlock ? receiptBlock + "\n" : "")
  );
}

function withFieldRemoved(receiptBlock, field) {
  return receiptBlock
    .split("\n")
    .filter((line) => !new RegExp(`^\\s*${field}\\s*:`).test(line))
    .join("\n");
}

test("(a) green declared + attestation marker filled + complete cycle-receipt -> ok", () => {
  const text =
    "### 3) /clear 안전\n" +
    "🟢 **전 역할 안전** — /clear 가능.\n" +
    "<!-- clear-safe-attest: reconciled=2026-07-08 03:57 KST delta=applied -->\n" +
    FULL_CYCLE_RECEIPT +
    "\n";
  const result = checkClearSafe(text);
  assert.equal(result.ok, true);
  assert.match(result.reason, /reconciled=2026-07-08 03:57 KST/);
  assert.match(result.reason, /cycle-receipt present/);
});

test("(b) green declared + no attestation marker at all -> warn", () => {
  const text = "### 3) /clear 안전\n🟢 **전 역할 안전** — /clear 가능.\n";
  const result = checkClearSafe(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing clear-safe-attest marker/);
});

test("(c) green declared + attestation marker present but reconciled= empty -> warn", () => {
  const text =
    "### 3) /clear 안전\n" +
    "🟢 **전 역할 안전** — /clear 가능.\n" +
    "<!-- clear-safe-attest: reconciled= delta=none -->\n";
  const result = checkClearSafe(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /reconciled= is empty/);
});

test("(d) no green /clear signal anywhere -> ok (nothing to attest)", () => {
  const text = "### 3) /clear 안전\n🟡 **CODER 작업 중** — /clear 금지.\n";
  const result = checkClearSafe(text);
  assert.equal(result.ok, true);
  assert.match(result.reason, /nothing to attest/);
});

test("(e) attestation marker present but no green declaration -> ok", () => {
  const text =
    "### 3) /clear 안전\n" +
    "🟡 CODER 작업 중.\n" +
    "<!-- clear-safe-attest: reconciled=2026-07-08 03:00 KST delta=none -->\n";
  const result = checkClearSafe(text);
  assert.equal(result.ok, true);
  assert.match(result.reason, /nothing to attest/);
});

test("(f) malformed/odd input -> fail-open, ok", () => {
  assert.equal(checkClearSafe(null).ok, true);
  assert.equal(checkClearSafe(undefined).ok, true);
  assert.equal(checkClearSafe("  not even markdown ￿").ok, true);
});

test("(g) parseCycleReceipt: parses a full block into a flat field object", () => {
  const fields = parseCycleReceipt(FULL_CYCLE_RECEIPT);
  assert.deepEqual(fields, {
    boundary: "cycle",
    task_id: "HYK-128-coder-1",
    result_ref: "a333083",
    issue_ids: "HYK-128",
    sync_result: "ok",
    status_updated: "yes",
    phase_update_needed: "no",
  });
});

test("(h) parseCycleReceipt: no block at all -> null", () => {
  assert.equal(parseCycleReceipt("### 3) /clear 안전\n🟢 안전.\n"), null);
});

test("(i) G3: green + attest + no cycle-receipt block -> ok:false, missing-marker reason", () => {
  const text = greenWithAttest(null);
  const result = checkClearSafe(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing cycle-receipt marker/);
});

for (const field of [
  "task_id",
  "result_ref",
  "issue_ids",
  "sync_result",
  "status_updated",
  "phase_update_needed",
]) {
  test(`(j-${field}) G3: cycle-receipt missing required field '${field}' -> ok:false naming that field`, () => {
    const text = greenWithAttest(withFieldRemoved(FULL_CYCLE_RECEIPT, field));
    const result = checkClearSafe(text);
    assert.equal(result.ok, false);
    assert.match(result.reason, new RegExp(field));
  });
}

test("(k) G3: complete cycle-receipt (boundary=cycle) -> ok, open_set_sync not required", () => {
  const text = greenWithAttest(FULL_CYCLE_RECEIPT);
  const result = checkClearSafe(text);
  assert.equal(result.ok, true);
});

test("(l) G4: boundary=phase + open_set_sync=ok -> ok", () => {
  const text = greenWithAttest(FULL_PHASE_RECEIPT);
  const result = checkClearSafe(text);
  assert.equal(result.ok, true);
  assert.match(result.reason, /boundary=phase/);
});

test("(m) G4: boundary=phase + open_set_sync missing -> ok:false, '사람 확인 필요'", () => {
  const text = greenWithAttest(withFieldRemoved(FULL_PHASE_RECEIPT, "open_set_sync"));
  const result = checkClearSafe(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /사람 확인 필요/);
});

test("(n) G4: boundary=phase + open_set_sync=판정불가 -> ok:false, '사람 확인 필요'", () => {
  const receipt = FULL_PHASE_RECEIPT.replace("open_set_sync: ok", "open_set_sync: 판정불가");
  const text = greenWithAttest(receipt);
  const result = checkClearSafe(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /사람 확인 필요/);
});

// --- HYK-131: CLI-level ORCH-only blocking promotion (G1/G2/G3) ---

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "clear-safe-check-cli-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Runs the real CLI over a temp STATUS.md, injecting HARNESS_ROLE (env) and
// a Stop-hook-shaped stdin payload -- the same two inputs resolveStopBlock's
// role gate / recursion guard / payload-readability check read in
// production. `stdin`, when given, overrides the derived stop_hook_active
// JSON entirely -- used to feed malformed/empty payloads (review-1 repro).
function runCli(statusText, { role, stopHookActive = false, stdin } = {}) {
  return withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    writeFileSync(statusPath, statusText, "utf8");
    const env = { ...process.env };
    delete env.HARNESS_ROLE;
    if (role !== undefined) env.HARNESS_ROLE = role;
    const input = stdin !== undefined ? stdin : JSON.stringify({ stop_hook_active: stopHookActive });
    // spawnSync (not execFileSync) so stderr is captured regardless of exit
    // code -- a pass-through (exit 0) case still writes a diagnostic to
    // stderr, which execFileSync's throw-on-nonzero-only model would drop.
    const res = spawnSync("node", [SCRIPT_PATH, "--status", statusPath], { encoding: "utf8", env, input });
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  });
}

const BAD_STATUS = greenWithAttest(null); // missing cycle-receipt block -> confirmed failure
const GOOD_STATUS = greenWithAttest(FULL_CYCLE_RECEIPT); // complete -> ok

test("(o) CLI: role=ORCH + confirmed failure + first attempt -> exit 2 with 4-field reason", () => {
  const result = runCli(BAD_STATUS, { role: "ORCH" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /reason_code=clear_safe_incomplete/);
  assert.match(result.stderr, /repair_hint=/);
  assert.match(result.stderr, /attempt=1\/1/);
});

test("(p) CLI: role=ORCH + ok -> exit 0", () => {
  const result = runCli(GOOD_STATUS, { role: "ORCH" });
  assert.equal(result.status, 0);
});

for (const role of ["PM", "CODER", "REVIEW", "VERIFY", undefined]) {
  test(`(q-${role ?? "unset"}) CLI: role=${role ?? "unset"} + confirmed failure -> exit 0 (blocking is ORCH-only)`, () => {
    const result = runCli(BAD_STATUS, { role });
    assert.equal(result.status, 0);
  });
}

test("(r) CLI: role=ORCH + confirmed failure + stop_hook_active -> exit 0, not re-blocked", () => {
  const result = runCli(BAD_STATUS, { role: "ORCH", stopHookActive: true });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /stop_hook_active/);
});

// --- review-1 rejected fix: malformed/empty stdin must never reach blocking
// severity (G3) -- these three cases are the exact review-1 regression set.

test("(r2) CLI: role=ORCH + confirmed failure + malformed/non-JSON stdin -> exit 0, UNJUDGABLE (review-1 repro: previously exit 2)", () => {
  const result = runCli(BAD_STATUS, { role: "ORCH", stdin: "not-json" });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /reason_code=stop_payload_unreadable/);
});

test("(r3) CLI: role=ORCH + confirmed failure + empty stdin -> exit 0, UNJUDGABLE (review-1 repro: previously exit 2)", () => {
  const result = runCli(BAD_STATUS, { role: "ORCH", stdin: "" });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /reason_code=stop_payload_unreadable/);
});

test("(r4) CLI: role=ORCH + confirmed failure + valid '{}' stdin -> exit 2 (anchor: existing behavior must not regress)", () => {
  const result = runCli(BAD_STATUS, { role: "ORCH", stdin: "{}" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /reason_code=clear_safe_incomplete/);
});

test("(s) CLI: role=ORCH + unreadable STATUS file (uncertain) -> exit 0 (UNJUDGABLE, never blocks)", () => {
  const env = { ...process.env, HARNESS_ROLE: "ORCH" };
  const missingPath = join(tmpdir(), "clear-safe-check-does-not-exist-" + Date.now(), "STATUS.md");
  const res = spawnSync("node", [SCRIPT_PATH, "--status", missingPath], {
    encoding: "utf8",
    env,
    input: "{}",
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /fail-open/);
});
