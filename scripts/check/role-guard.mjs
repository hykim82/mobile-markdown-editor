import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { normalizeToRepoRelative } from "./path-normalize.mjs";
import { checkPacketGate } from "./packet-gate.mjs";

const KNOWN_ROLES = ["ORCH", "CODER", "REVIEW", "VERIFY", "PM"];
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TASK_FILE_RE = /^\.harness\/[^/]+-task\.md$/i;
const TASK_FILENAME_RE = /-task\.md$/i;
const PACKET_LINE_RE = /^packet:\s*(\S+)/m;

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

// E2ⓑ: any `<...>-task.md` write (regardless of location — in-repo
// `.harness/`, another repo's `.harness/`, or the control room's
// `PM\relay\`) whose content quotes a `packet:` line must point at a
// packet that has been human-signed (packet-gate). A parenthesized value
// (e.g. `(없음 — ...)`) is a narrative aside, not a path reference, and is
// skipped rather than treated as a missing/unsigned packet.
function checkPacketDirective({ filePath, toolInput }) {
  const normalizedSlashes = filePath.replace(/\\/g, "/");
  const basename = normalizedSlashes.split("/").pop() ?? "";
  if (!TASK_FILENAME_RE.test(basename)) {
    return null;
  }

  const content = toolInput?.content ?? toolInput?.new_string;
  if (typeof content !== "string") {
    return null;
  }

  const match = content.match(PACKET_LINE_RE);
  if (!match) {
    return null;
  }

  const packetPath = match[1];
  if (packetPath.startsWith("(")) {
    return null;
  }

  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(packetPath) || packetPath.startsWith("/");
  if (!isAbsolute) {
    return {
      ok: false,
      reason: `role-guard: packet: '${packetPath}' must be an absolute path (relative packet references are rejected)`,
    };
  }

  const gateResult = checkPacketGate({ packetPath });
  if (!gateResult.ok) {
    return {
      ok: false,
      reason: `role-guard: task drop blocked — unsigned/invalid packet '${packetPath}': ${gateResult.reason}`,
    };
  }
  return null;
}

export function checkRoleWrite({ role, filePath, repoRoot: root, toolInput }) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { ok: false, reason: "role-guard: no file path provided" };
  }

  const packetCheck = checkPacketDirective({ filePath, toolInput });
  if (packetCheck) {
    return packetCheck;
  }

  const { relative, insideRepo } = normalizeToRepoRelative(filePath, root);
  if (!insideRepo) {
    return { ok: true, reason: `role-guard: '${filePath}' is outside the repo root; not regulated` };
  }

  if (!role || !KNOWN_ROLES.includes(role)) {
    return {
      ok: true,
      warn: true,
      reason: `role-guard: HARNESS_ROLE unset or unrecognized ('${role ?? ""}') — no role restriction applied for '${relative}'`,
    };
  }

  const isTaskFile = TASK_FILE_RE.test(relative);
  const isReviewFile = relative.toLowerCase() === ".harness/review.md";
  const isVerifyFile = relative.toLowerCase() === ".harness/verify.md";

  if (role === "PM") {
    return {
      ok: false,
      reason: "role-guard: PM may not write inside the repo; PM lane = control room",
    };
  }

  if (role === "ORCH") {
    if (isTaskFile) {
      return { ok: true, reason: `role-guard: ORCH may drop task file '${relative}'` };
    }
    return {
      ok: false,
      reason: `role-guard: ORCH may only write .harness/<role>-task.md task files, not '${relative}'`,
    };
  }

  if (role === "CODER") {
    if (isReviewFile || isVerifyFile || isTaskFile) {
      return {
        ok: false,
        reason: `role-guard: CODER may not write '${relative}' (owned by another role or ORCH)`,
      };
    }
    return { ok: true, reason: `role-guard: CODER write allowed for '${relative}'` };
  }

  if (role === "REVIEW") {
    if (isReviewFile) {
      return { ok: true, reason: `role-guard: REVIEW may write '${relative}'` };
    }
    return { ok: false, reason: `role-guard: REVIEW may only write .harness/review.md, not '${relative}'` };
  }

  // role === "VERIFY"
  if (isVerifyFile) {
    return { ok: true, reason: `role-guard: VERIFY may write '${relative}'` };
  }
  return { ok: false, reason: `role-guard: VERIFY may only write .harness/verify.md, not '${relative}'` };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/role-guard.mjs");
if (invokedDirectly) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }

  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    // No/malformed PreToolUse payload: nothing to check against, allow.
    process.exit(0);
  }

  const toolName = hookInput.tool_name;
  if (!WRITE_TOOLS.has(toolName)) {
    process.exit(0);
  }

  const toolInput = hookInput.tool_input || {};
  const filePath = toolInput.file_path || toolInput.notebook_path;
  if (!filePath) {
    process.exit(0);
  }

  const result = checkRoleWrite({ role: process.env.HARNESS_ROLE, filePath, repoRoot: repoRoot(), toolInput });
  if (result.warn) {
    console.error(result.reason);
  }
  if (result.ok) {
    process.exit(0);
  }
  console.error(result.reason);
  process.exit(2);
}
