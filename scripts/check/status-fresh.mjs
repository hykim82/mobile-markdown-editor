import { existsSync, statSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";

// 5s grace: a worker writes its result file (e.g. coder.md) and then, in the
// same turn, self-reports its STATUS.md row. Those are two separate writes
// a few hundred ms to a few seconds apart, and filesystem mtime resolution
// on some volumes is itself coarse (up to ~1s on FAT-family filesystems).
// Without a grace window, a legitimately-fresh self-report could still show
// STATUS.md's mtime a hair *before* the result file's mtime and be flagged
// stale by pure `>` comparison. 5s comfortably covers both effects without
// being so wide it would miss a genuinely stale board (boards go stale by
// minutes-to-never, not single-digit seconds).
export const DEFAULT_GRACE_MS = 5000;

// Work files this check compares against: relay task/result files under
// .harness/ (`*-task.md`, `coder.md`, `review.md`, `verify.md`, etc).
// STATUS.md itself is obviously excluded (comparing it to itself is
// meaningless). PHASE-HANDOFF.md is also excluded: it is a phase-boundary
// document written only at session-rotation points, not on every relay
// cycle, so its mtime does not indicate "the board is behind."
const EXCLUDED_BASENAMES = new Set(["STATUS.md", "PHASE-HANDOFF.md"]);

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

function headTimeFromGit(repoRootPath) {
  try {
    const iso = execSync("git log -1 --format=%cI", { cwd: repoRootPath, encoding: "utf8" }).trim();
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

function newestWorkFile(harnessDir) {
  if (!existsSync(harnessDir)) return null;
  let newest = null;
  for (const name of readdirSync(harnessDir)) {
    if (!name.endsWith(".md")) continue;
    if (EXCLUDED_BASENAMES.has(basename(name))) continue;
    const full = join(harnessDir, name);
    let mtime;
    try {
      mtime = statSync(full).mtime;
    } catch {
      continue;
    }
    if (!newest || mtime > newest.mtime) {
      newest = { mtime, label: name };
    }
  }
  return newest;
}

// headTime: pass explicitly (a Date, or null to disable HEAD-commit
// comparison entirely) for testability without a real git repo. Leave
// undefined to have this compute HEAD's commit time from the real repo at
// `repoRoot()` -- the live/CLI path.
export function checkStatusFresh({ statusPath, harnessDir, graceMs = DEFAULT_GRACE_MS, headTime } = {}) {
  const root = repoRoot();
  const resolvedHarnessDir = harnessDir ?? join(root, ".harness");
  const resolvedStatusPath = statusPath ?? join(root, ".harness", "STATUS.md");

  if (!existsSync(resolvedStatusPath)) {
    return { ok: false, reason: `STATUS file not found: ${resolvedStatusPath}` };
  }
  const statusMtime = statSync(resolvedStatusPath).mtime;

  const candidates = [];

  const workFile = newestWorkFile(resolvedHarnessDir);
  if (workFile) candidates.push({ mtime: workFile.mtime, label: workFile.label });

  const resolvedHeadTime = headTime !== undefined ? headTime : headTimeFromGit(root);
  if (resolvedHeadTime) candidates.push({ mtime: resolvedHeadTime, label: "HEAD commit" });

  if (candidates.length === 0) {
    // Nothing to compare against (no eligible work files, no resolvable
    // HEAD time) -- vacuously fresh rather than blocking on missing signal.
    return { ok: true, reason: "no work files or HEAD commit time to compare against -- ok" };
  }

  candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const newest = candidates[0];

  const diffMs = newest.mtime.getTime() - statusMtime.getTime();
  if (diffMs > graceMs) {
    const overBy = Math.round((diffMs - graceMs) / 1000);
    return {
      ok: false,
      reason:
        `STATUS stale: '${newest.label}' (${newest.mtime.toISOString()}) is newer than ` +
        `STATUS.md (${statusMtime.toISOString()}) by ${Math.round(diffMs / 1000)}s, ` +
        `${overBy}s past the ${Math.round(graceMs / 1000)}s grace window`,
    };
  }

  return {
    ok: true,
    reason: `STATUS fresh (newest work '${newest.label}' at ${newest.mtime.toISOString()} is within ${Math.round(graceMs / 1000)}s grace of STATUS.md ${statusMtime.toISOString()})`,
  };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/status-fresh.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let statusPath = process.env.HARNESS_STATUS_PATH;
  let harnessDir = process.env.HARNESS_DIR;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--status") statusPath = args[++i];
    else if (args[i] === "--harness-dir") harnessDir = args[++i];
  }
  const result = checkStatusFresh({ statusPath, harnessDir });
  if (result.ok) {
    console.log(result.reason);
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
