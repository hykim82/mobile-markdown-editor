import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readStopHookPayload, resolveStopBlock } from "./stop-blocking.mjs";

// Single declaration for the "milliseconds per hour" conversion -- every
// threshold and every human-readable "Xh" label in this file derives from
// this constant instead of repeating the 3600000 literal (C.7).
export const MS_PER_HOUR = 60 * 60 * 1000;

// Thresholds are exported constants (not inline literals) so a future
// tuning pass (this harness expects a 1-week observation window before
// settling on real values, HYK-116) has exactly one place to change, and so
// tests can pin exact values instead of re-deriving them.
export const DEFAULT_DIRTY_THRESHOLD_MS = 3 * MS_PER_HOUR;
export const DEFAULT_HANDOFF_THRESHOLD_MS = 12 * MS_PER_HOUR;

// Single declaration for the two control-room filenames check (2) compares
// -- referenced here and by the default statusPath/handoffPath below,
// never repeated as a bare string literal (C.7).
export const STATUS_BASENAME = "STATUS.md";
export const HANDOFF_BASENAME = "PHASE-HANDOFF.md";

function defaultIsGitRepo(dirPath) {
  try {
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return false;
    execFileSync("git", ["-C", dirPath, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function defaultGitStatus(dirPath) {
  try {
    return execFileSync("git", ["-C", dirPath, "status", "--porcelain"], { encoding: "utf8" });
  } catch {
    return null;
  }
}

function defaultLastCommitTime(dirPath) {
  try {
    const iso = execFileSync("git", ["-C", dirPath, "log", "-1", "--format=%cI"], { encoding: "utf8" }).trim();
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

// controlRoomPath: the control-room repo living outside this project's own
// repo (see status.template.md / HARNESSENGINEERING's own control room).
// Absent, not a directory, or not a git repo at all -> vacuously ok, no
// warning: most installs (team-local) have no control room, and treating
// "there isn't one" as a defect would nag on every one of them.
//
// now / isGitRepoFn / gitStatusFn / lastCommitTimeFn: injection points for
// testability without a real git repository, same rationale as
// status-fresh.mjs's `headTime` parameter.
//
// statusPath / handoffPath: default to `<controlRoomPath>/STATUS.md` and
// `<controlRoomPath>/PHASE-HANDOFF.md`; either missing skips check ② only
// (check ① does not depend on either file).
export function checkControlRoomFresh({
  controlRoomPath,
  now = Date.now(),
  dirtyThresholdMs = DEFAULT_DIRTY_THRESHOLD_MS,
  handoffThresholdMs = DEFAULT_HANDOFF_THRESHOLD_MS,
  isGitRepoFn = defaultIsGitRepo,
  gitStatusFn = defaultGitStatus,
  lastCommitTimeFn = defaultLastCommitTime,
  statusPath,
  handoffPath,
} = {}) {
  if (!controlRoomPath || !isGitRepoFn(controlRoomPath)) {
    return { ok: true, warnings: [], reason: "control room path absent or not a git repo -- vacuously ok" };
  }

  const warnings = [];

  // Check (1): dirty working tree with no recent commit -- looks like a
  // cycle's changes were never committed. A commit time that cannot be
  // resolved at all (commitTime null -- unborn repo, `git log` failure) is
  // "cannot judge", not "assume worst case": it is skipped rather than
  // warned on, the same fail-open posture as the absent-control-room path
  // above and linear-sync.mjs's own philosophy (confidence required to warn).
  const porcelain = gitStatusFn(controlRoomPath);
  if (porcelain !== null && porcelain.trim() !== "") {
    const commitTime = lastCommitTimeFn(controlRoomPath);
    if (commitTime) {
      const ageMs = now - commitTime.getTime();
      if (ageMs > dirtyThresholdMs) {
        warnings.push(
          `control room working tree is dirty and the last commit is ${Math.round(ageMs / MS_PER_HOUR)}h old ` +
            `(threshold ${Math.round(dirtyThresholdMs / MS_PER_HOUR)}h) -- looks like a cycle's changes were never committed`,
        );
      }
    }
  }

  // Check (2): STATUS.md <-> PHASE-HANDOFF.md mtime gap -- a large gap
  // suggests one was updated without the other, i.e. a stale handoff.
  const resolvedStatusPath = statusPath ?? join(controlRoomPath, STATUS_BASENAME);
  const resolvedHandoffPath = handoffPath ?? join(controlRoomPath, HANDOFF_BASENAME);
  if (existsSync(resolvedStatusPath) && existsSync(resolvedHandoffPath)) {
    const statusMtimeMs = statSync(resolvedStatusPath).mtime.getTime();
    const handoffMtimeMs = statSync(resolvedHandoffPath).mtime.getTime();
    const gapMs = Math.abs(statusMtimeMs - handoffMtimeMs);
    if (gapMs > handoffThresholdMs) {
      warnings.push(
        `${STATUS_BASENAME} and ${HANDOFF_BASENAME} mtimes differ by ${Math.round(gapMs / MS_PER_HOUR)}h ` +
          `(threshold ${Math.round(handoffThresholdMs / MS_PER_HOUR)}h) -- handoff may be stale`,
      );
    }
  }

  if (warnings.length === 0) {
    return { ok: true, warnings, reason: "control room fresh (no dirty-cycle or handoff-staleness warnings)" };
  }
  return { ok: false, warnings, reason: warnings.join("; ") };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/controlroom-fresh.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let controlRoomPath = process.env.HARNESS_CONTROL_ROOM_PATH;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--control-room") controlRoomPath = args[++i];
  }

  const result = checkControlRoomFresh({ controlRoomPath });

  // HYK-131: ORCH-only blocking promotion, same adapter/rationale as
  // clear-safe-check.mjs. A confirmed warning (result.ok === false) now
  // hard-blocks (exit 2) only on an ORCH turn's first Stop this cycle;
  // every other role and any stop_hook_active re-invocation passes through
  // at exit 0. See stop-blocking.mjs and docs/enforcement-v1.md's honesty
  // notes for what this still cannot do.
  const decision = resolveStopBlock({
    role: process.env.HARNESS_ROLE,
    hookPayloadResult: readStopHookPayload(),
    ok: result.ok,
    checkId: "controlroom-fresh",
    reasonCode: "controlroom_stale",
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
