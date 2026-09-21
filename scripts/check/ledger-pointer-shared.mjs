// HYK-302/355 (coder-task.md §2-A, 책임자 조건 ③ -- HYK-350 "정의 두 벌
// 드리프트" 교훈): single source of truth for two pieces of state that were
// independently duplicated across production files --
// `PERSISTENT_LEDGER_POINTER_FILENAME` (admission-completion-adapter.mjs
// :201 and orch-stall-detect.mjs :2005) and `isInsideGitWorktree`
// (admission-completion-adapter.mjs :565 and relay-handshake.mjs :196).
// Both bodies below are byte-for-byte the union of the two prior copies --
// see isInsideGitWorktree's own comment for the one behavioral difference
// between the two prior copies (relay-handshake.mjs's `!dir` guard) and why
// carrying it here is safe for both call sites.
//
// ⚠️ this file is now a THIRD sibling every isolated/mutation fixture that
// stages a synthetic copy of admission-completion-adapter.mjs,
// relay-handshake.mjs, or orch-stall-detect.mjs must also stage (mirrors
// the existing admission-ledger-core.mjs/admission-ledger-store.mjs/
// time-authority.mjs/envelope-archive.mjs/reject-streak.mjs sibling
// pattern those fixtures already carry) -- this round updated every such
// site it found (see coder.md).

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

export const PERSISTENT_LEDGER_POINTER_FILENAME = "admission-ledger-path.json";

// isInsideGitWorktree -- HYK-312 §1 / HYK-355 §2-B: "is the round directory
// the caller told us to consume itself inside SOME git worktree" -- a plain
// `git rev-parse --is-inside-work-tree` run with cwd=dir. A scratch/temp
// copy (never `git init`-ed) fails this immediately. The `!dir` guard
// (relay-handshake.mjs's prior copy; admission-completion-adapter.mjs's
// prior copy relied on its own call site never passing a falsy `dir`) is
// kept here because it is strictly more defensive and both current call
// sites already only ever call this with a truthy `dir`.
// 정직 한계: a deliberate SEPARATE git clone used for an experiment still
// passes this check (it genuinely is inside a worktree) -- this gate closes
// the "plain filesystem copy / no folder at all" shape the actual incidents
// took, not every conceivable isolation escape.
export function isInsideGitWorktree(dir) {
  if (!dir || !existsSync(dir)) return false;
  try {
    const out = execSync("git rev-parse --is-inside-work-tree", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}
