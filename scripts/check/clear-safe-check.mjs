import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { readStopHookPayload, resolveStopBlock } from "./stop-blocking.mjs";

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

// The reconciliation attestation marker this checker looks for, e.g.:
//   <!-- clear-safe-attest: reconciled=2026-07-08 03:57 KST delta=applied -->
//   <!-- clear-safe-attest: reconciled=none delta=none -->
// `reconciled=` is captured non-greedily up to the next ` delta=`, which is
// what lets a KST timestamp containing a space ("YYYY-MM-DD HH:MM KST")
// round-trip correctly instead of being cut at its first space.
const ATTEST_RE = /<!--\s*clear-safe-attest:\s*reconciled=(.*?)\s+delta=(.*?)\s*-->/i;

// Boundary receipt block, e.g.:
//   <!-- cycle-receipt:
//     boundary: cycle
//     task_id: HYK-128-coder-1
//     result_ref: a333083
//     issue_ids: HYK-128
//     sync_result: ok
//     status_updated: yes
//     phase_update_needed: no
//   -->
// Serialization choice: HTML comment (not a fenced block) to match this
// checker's existing `clear-safe-attest` marker convention -- one comment
// syntax for every machine-parsed STATUS.md marker, and it stays invisible
// in a rendered markdown preview the same way the attest line already does.
const CYCLE_RECEIPT_RE = /<!--\s*cycle-receipt:([\s\S]*?)-->/i;
const CYCLE_RECEIPT_FIELD_RE = /^\s*([a-zA-Z_]+)\s*:\s*(.*?)\s*$/;

// Required for every receipt regardless of boundary (G3). `boundary` itself
// and `open_set_sync` are intentionally excluded here -- `open_set_sync` is
// only required when boundary=phase (G4), checked separately below.
const CYCLE_RECEIPT_REQUIRED_FIELDS = [
  "task_id",
  "result_ref",
  "issue_ids",
  "sync_result",
  "status_updated",
  "phase_update_needed",
];

// Pure function: parses the cycle-receipt HTML-comment block into a flat
// { field: value } object. Returns null when no such block exists at all --
// callers must not confuse "block absent" with "block present but empty",
// though both currently fail the same way (missing required fields).
export function parseCycleReceipt(statusText) {
  const text = statusText ?? "";
  const match = text.match(CYCLE_RECEIPT_RE);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const fieldMatch = line.match(CYCLE_RECEIPT_FIELD_RE);
    if (fieldMatch) fields[fieldMatch[1]] = fieldMatch[2];
  }
  return fields;
}

// G3/G4: honesty note -- this only checks that the receipt's fields are
// *present and non-empty* (and, for phase boundaries, that open_set_sync
// isn't the unresolved '판정불가' sentinel). It cannot and does not verify
// that any field's *value* is actually true (e.g. that result_ref really
// names this cycle's result, or that sync_result reflects a real linear-sync
// run) -- same Tier2 soft/fail-open scope as the rest of this checker (see
// docs/enforcement-v1.md, "Scope B").
function checkCycleReceipt(statusText) {
  const receipt = parseCycleReceipt(statusText);
  if (!receipt) {
    return {
      ok: false,
      reason:
        "🟢 /clear-safe declared without a cycle-receipt block (missing cycle-receipt marker) -- " +
        "fill in the boundary receipt (task_id/result_ref/issue_ids/sync_result/status_updated/" +
        "phase_update_needed) before relying on this declaration",
    };
  }

  const missing = CYCLE_RECEIPT_REQUIRED_FIELDS.filter((field) => !receipt[field] || receipt[field].trim() === "");
  if (missing.length) {
    return {
      ok: false,
      reason: `🟢 /clear-safe declared but cycle-receipt is missing required field(s): ${missing.join(", ")} -- fill in the boundary receipt before relying on this declaration`,
    };
  }

  const boundary = (receipt.boundary ?? "").trim().toLowerCase();
  if (boundary === "phase") {
    const openSetSync = (receipt.open_set_sync ?? "").trim();
    if (!openSetSync || openSetSync === "판정불가") {
      return {
        ok: false,
        reason:
          "🟢 /clear-safe declared for a phase boundary but cycle-receipt's open_set_sync is missing or " +
          "'판정불가' -- 사람 확인 필요 before relying on this declaration",
      };
    }
  }

  return { ok: true, reason: `cycle-receipt present (task_id=${receipt.task_id}, boundary=${boundary || "cycle"})` };
}

// Escape hatch for a board that doesn't phrase its human-facing declaration
// with a 🟢 emoji next to the literal text "/clear" (this harness's own
// convention -- see STATUS.md's "/clear 안전" section) but still wants to
// mark itself green explicitly.
const EXPLICIT_GREEN_RE = /clear-safe:\s*green/i;

// Detects a "🟢 /clear declared safe" signal, scoped to whichever `##`/`###`
// heading-bounded section it appears in -- so a stray 🟢 elsewhere on the
// board (e.g. in an unrelated "done" checkbox) does not falsely couple to an
// unrelated mention of "/clear" in a different section.
function greenDeclared(statusText) {
  if (EXPLICIT_GREEN_RE.test(statusText)) return true;
  const lines = statusText.split(/\r?\n/);
  const sections = [];
  let current = [];
  for (const line of lines) {
    if (/^#{2,3}\s+/.test(line)) {
      if (current.length) sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) sections.push(current.join("\n"));
  return sections.some((section) => section.includes("🟢") && section.includes("/clear"));
}

// Pure function: text in, verdict out (no file I/O), same shape as
// `extractHardConstraints`/`checkStatusFresh` in the other check scripts.
// This is deliberately a soft, form-only check -- see docs/enforcement-v1.md
// ("Scope B") for the platform-limitation reasons this cannot be a hard
// gate and cannot verify the attestation's *content*, only its *presence*.
export function checkClearSafe(statusText) {
  try {
    const text = statusText ?? "";

    if (!greenDeclared(text)) {
      return { ok: true, reason: "no 🟢 /clear declaration found -- nothing to attest" };
    }

    const match = text.match(ATTEST_RE);
    if (!match) {
      return {
        ok: false,
        reason:
          "🟢 /clear-safe declared without a filled context-card reconciliation attestation " +
          "(missing clear-safe-attest marker) -- run /capture-context and fill it in before relying on this declaration",
      };
    }

    const reconciled = match[1].trim();
    if (!reconciled) {
      return {
        ok: false,
        reason:
          "🟢 /clear-safe declared without a filled context-card reconciliation attestation " +
          "(clear-safe-attest marker present but reconciled= is empty) -- run /capture-context and fill it in",
      };
    }

    const receiptResult = checkCycleReceipt(text);
    if (!receiptResult.ok) return receiptResult;

    return {
      ok: true,
      reason: `clear-safe attestation present (reconciled=${reconciled}); ${receiptResult.reason}`,
    };
  } catch (err) {
    // Fail-open: any parsing trouble is uncertain, not a confirmed-missing
    // attestation -- this check is a soft reminder, not a hard gate, so it
    // never blocks (or, at the CLI level, warns) on something it can't
    // actually judge.
    return { ok: true, reason: `clear-safe-check internal error (${err.message}) -- fail-open` };
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/clear-safe-check.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let statusPath = process.env.HARNESS_STATUS_PATH;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--status") statusPath = args[++i];
  }
  statusPath = statusPath || join(repoRoot(), ".harness", "STATUS.md");

  let text;
  try {
    text = readFileSync(statusPath, "utf8");
  } catch (err) {
    // Missing/unreadable STATUS file is uncertain, not a confirmed-unsafe
    // declaration -- fail-open (this is a Stop-hook soft reminder, exit 1
    // is reserved for a confirmed unmet attestation, not "couldn't check").
    console.log(`clear-safe-check: could not read '${statusPath}' (${err.message}) -- fail-open, ok`);
    process.exit(0);
  }

  const result = checkClearSafe(text);

  // HYK-131: ORCH-only blocking promotion. A confirmed failure (result.ok
  // === false) now hard-blocks (exit 2) *only* on an ORCH turn's first Stop
  // in this cycle; every other role, and any stop_hook_active re-invocation,
  // passes through at exit 0 -- see stop-blocking.mjs for the shared
  // rationale, and docs/enforcement-v1.md's honesty notes for what this
  // still cannot do (Claude-only, Stop-time-only, Tier 2, removable).
  const decision = resolveStopBlock({
    role: process.env.HARNESS_ROLE,
    hookPayloadResult: readStopHookPayload(),
    ok: result.ok,
    checkId: "clear-safe-check",
    reasonCode: "clear_safe_incomplete",
    repairHint: result.reason,
  });

  if (result.ok) {
    console.log(result.reason);
  } else {
    console.error(result.reason);
    if (decision.reason) console.error(decision.reason);
  }
  process.exit(decision.exit);
}
