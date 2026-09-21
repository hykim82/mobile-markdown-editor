// HYK-186 2R §2 -- PreToolUse hook wiring `finalize-done.mjs` (built 1R) to
// the point workers actually complete their work: it blocks the Edit/Write/
// MultiEdit path from EVER introducing a `>>> DONE:` line into a `.harness/
// <role>.md` result file, and points the worker at
// `node scripts/relay/finalize-done.mjs <role> <harnessDir>` instead. This
// is the missing "결선" -- finalize-done.mjs existed since 1R but nothing
// called it (완료조건2's own text names this exact repo pattern: "장치는
// 있는데 아무것도 안 한다").
//
// ★신뢰 경계 (A) 판단 (coder-task.md §2-4): the CONSUMER side
// (relay-handshake.mjs's DONE_RE/parseKstTimestamp) is left completely
// untouched by this change -- it still accepts a hand-written `>>> DONE:`
// line exactly as before. Narrowing the consumer to "machine-only" would
// stop today's relay from recognizing ANY result file not written through
// this specific hook (every other repo/worktree in this harness that
// doesn't have this hook installed, every REVIEW/VERIFY round on a codex
// seat where this Claude-specific hook cannot even run) -- that is
// precisely the outage §2-4 warns against. So this round narrows only the
// PRODUCER side (this repo's own Claude Code sessions, via this hook), and
// only when the hook is actually installed (docs/harness-init.md) -- a
// worker in a session without it installed, or a codex seat, still
// falls back to hand-writing DONE, which the consumer still honors.
//
// Same install mechanism as role-guard.mjs (docs/harness-init.md 뒷단):
// added to `.claude/settings.local.json`'s PreToolUse hooks list by the
// harness-init installer, matched on tool_name in WRITE_TOOLS.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { normalizeToRepoRelative } from "./path-normalize.mjs";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
// Matches relay-handshake.mjs's own DONE_RE shape (column-0 anchored,
// case-insensitive keyword) -- this hook must recognize exactly the line
// the consumer recognizes, no looser and no stricter, or a worker could
// slip a DONE-shaped-but-not-quite line past this guard while the consumer
// still accepts it (or vice versa: this guard blocking something the
// consumer would have ignored anyway, a false block).
const DONE_LINE_RE = /^>>>\s*DONE:.*@/im;
// Result files this hook regulates: .harness/<role>.md (NOT *-task.md --
// those are ORCH-owned and role-guard.mjs already blocks CODER from
// touching them; this hook only ever fires on the worker's OWN result
// file, whichever role wrote it).
const RESULT_FILE_RE = /^\.harness\/(coder|review|verify)\.md$/i;

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

function extractNewContent(toolInput) {
  const t = toolInput ?? {};
  // Write: whole-file content. Edit: new_string (the replacement text
  // alone -- if the DONE line is being newly introduced by this edit, it
  // will appear in new_string; a pre-existing DONE line elsewhere in the
  // file that this edit doesn't touch is not this hook's concern, since it
  // was already written through some prior call this hook already saw).
  // MultiEdit: an `edits` array, each with its own new_string.
  if (typeof t.content === "string") return t.content;
  if (typeof t.new_string === "string") return t.new_string;
  if (Array.isArray(t.edits)) {
    return t.edits
      .map((e) => (typeof e?.new_string === "string" ? e.new_string : ""))
      .join("\n");
  }
  return "";
}

// checkDoneLineWrite({filePath, toolInput, repoRoot}) -> {ok, reason}
export function checkDoneLineWrite({ filePath, toolInput, repoRoot: root }) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { ok: true, reason: "done-line-write-guard: no file path provided" };
  }
  const { relative, insideRepo } = normalizeToRepoRelative(filePath, root);
  if (!insideRepo) {
    return {
      ok: true,
      reason: `done-line-write-guard: '${filePath}' is outside the repo root; not regulated`,
    };
  }
  if (!RESULT_FILE_RE.test(relative)) {
    return {
      ok: true,
      reason: `done-line-write-guard: '${relative}' is not a regulated result file`,
    };
  }
  const newContent = extractNewContent(toolInput);
  if (!DONE_LINE_RE.test(newContent)) {
    return {
      ok: true,
      reason: `done-line-write-guard: no '>>> DONE:' line in this write to '${relative}'`,
    };
  }
  const role = relative.match(RESULT_FILE_RE)[1];
  return {
    ok: false,
    reason: `done-line-write-guard: hand-writing '>>> DONE:' into '${relative}' is blocked -- caller-supplied timestamps are not accepted for this producer (완료조건2). Run 'node scripts/relay/finalize-done.mjs ${role} .harness' instead; it stamps the machine clock and appends the line for you. Write the rest of '${relative}' first (report body, no DONE line), then call finalize-done.mjs as your LAST step.`,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/done-line-write-guard.mjs");
if (invokedDirectly) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    // no stdin -- raw stays ""
  }

  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = hookInput.tool_name;
  if (!WRITE_TOOLS.has(toolName)) {
    process.exit(0);
  }

  const toolInput = hookInput.tool_input || {};
  const filePath = toolInput.file_path;
  if (!filePath) {
    process.exit(0);
  }

  const result = checkDoneLineWrite({
    filePath,
    toolInput,
    repoRoot: repoRoot(),
  });
  if (result.ok) {
    process.exit(0);
  }
  console.error(result.reason);
  process.exit(2);
}
