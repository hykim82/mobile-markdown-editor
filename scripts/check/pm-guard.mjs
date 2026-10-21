import { readFileSync } from "node:fs";
import { normalizeAbsolute } from "./path-normalize.mjs";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// HYK-267: this is the 2nd-layer defense, not the 1st. The 1st layer is
// keeping the PM session's MCP config empty at launch (e.g. Claude's
// `--strict-mcp-config` + `{"mcpServers":{}}`) so no `mcp__*` tool exists to
// call in the first place -- that layer lives in the session's own launch
// line (control room's settings.local.json / seat launcher), outside this
// repo, and this script cannot see or verify it.
//
// This regex is a name-matching fallback for when that 1st layer is
// missing, misconfigured, or the connector changes shape. It is
// PRINCIPLED-INCOMPLETE: it can only list prefixes for connectors we know
// about today. HYK-273 found a live gap this way -- `mcp__linear-server__*`
// was listed but `mcp__claude_ai_Linear__*` (a different MCP connector
// exposing the same Linear write capability) was not, so it passed through
// unblocked. A 3rd connector with a 3rd tool-name prefix would reopen the
// exact same hole tomorrow. Do NOT read "this regex exists" as "Linear
// writes are blocked" -- read it as "the two prefixes we know about today
// are blocked; the 1st layer is what actually closes the class."
const LINEAR_WRITE_TOOL_RE =
  /^mcp__(linear-server|claude_ai_Linear)__(save_|create_|delete_)/;

// Fixed control-room root (PM's lane, outside every repo). Not configurable
// per-invocation: pm-guard is installed once, in the control room's own
// settings.local.json, and always regulates against this one root.
//
// HYK-309: this literal is THIS repo's own live solo-full control-room
// path -- correct for this repo's own instance, but install.mjs used to
// `copyRawFile` this module byte-for-byte into every target it installs,
// so every other install silently inherited this machine's own path
// instead of the target's. install.mjs now rewrites this exact
// `const CONTROL_ROOM_ROOT = "...";` line at install time (see
// substitutePmGuardControlRoom there) -- exported so pm-guard.test.mjs can
// derive its fixtures from whatever value is actually live, in this repo
// or an installed copy, instead of duplicating the literal a second time.
export const CONTROL_ROOM_ROOT = "D:/문서관리/하네스-관제실";
const SCRATCHPAD_MARKER = "appdata/local/temp/claude/";

// HYK-309 2R (REVIEW P2): exported with an optional `root` override (default
// preserves checkPmGuard's exact prior behavior, which always calls this
// with one argument) so pm-guard.test.mjs can exercise the WSL/git-bash/
// backslash-form recognition property against a synthetic root fully
// independent of whatever CONTROL_ROOM_ROOT this install happens to carry
// (a real control-room path for solo-full, a non-path sentinel for
// team-local) -- team-local's install has no control room to test writes
// into, but the format-equivalence property itself is generic and
// shouldn't silently lose coverage just because that particular profile
// has nothing configured to test it against.
export function isControlRoomPath(normalized, root = CONTROL_ROOM_ROOT) {
  const lower = normalized.toLowerCase();
  const rootLower = root.toLowerCase();
  return lower === rootLower || lower.startsWith(`${rootLower}/`);
}

function isScratchpadPath(normalized) {
  return normalized.toLowerCase().includes(SCRATCHPAD_MARKER);
}

// PM-only PreToolUse guard: outside a PM session this is a no-op (other
// roles are role-guard's concern). Inside a PM session, writes are
// allow-listed to the control room + scratchpad, and Linear's write MCP
// tools are blocked outright — PM proposes, it does not commit.
export function checkPmGuard({ role, toolName, filePath }) {
  if (role !== "PM") {
    return { ok: true, reason: "pm-guard: not a PM session; not regulated" };
  }

  if (typeof toolName === "string" && LINEAR_WRITE_TOOL_RE.test(toolName)) {
    return {
      ok: false,
      reason: `pm-guard: PM may not call Linear write tool '${toolName}' (packet + human sign-off only)`,
    };
  }

  if (!WRITE_TOOLS.has(toolName)) {
    return {
      ok: true,
      reason: `pm-guard: '${toolName}' is not a regulated write tool`,
    };
  }

  if (typeof filePath !== "string" || filePath.length === 0) {
    return { ok: true, reason: "pm-guard: no file path provided" };
  }

  const normalized = normalizeAbsolute(filePath);
  if (isControlRoomPath(normalized) || isScratchpadPath(normalized)) {
    return { ok: true, reason: `pm-guard: PM write allowed for '${filePath}'` };
  }

  return {
    ok: false,
    reason: `pm-guard: PM may not write '${filePath}' — allow-list = control room (${CONTROL_ROOM_ROOT}) + scratchpad only`,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/pm-guard.mjs");
if (invokedDirectly) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    // leave raw as ""
  }

  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    console.error("pm-guard: no/malformed PreToolUse payload; allowing");
    process.exit(0);
  }

  const toolName = hookInput.tool_name;
  const toolInput = hookInput.tool_input || {};
  const filePath = toolInput.file_path || toolInput.notebook_path;

  const result = checkPmGuard({
    role: process.env.HARNESS_ROLE,
    toolName,
    filePath,
  });
  if (result.ok) {
    process.exit(0);
  }
  console.error(result.reason);
  process.exit(2);
}
