// Seat launch admission check (HYK-200). Fail-closed gate meant to be
// invoked by the control-room seat launcher BEFORE a worker seat is started
// (coder-task.md §1: "0이 아니면 좌석을 아예 띄우지 않는다"). This device
// does not decide anything new -- it wraps the already-merged
// hook-sync-check.mjs (HYK-196) core/IO and turns its verdict into (a) a
// human-readable message a person reads on the seat screen and (b) an exit
// code the launcher branches on. Comparison logic itself is NOT
// reimplemented here (coder-task.md §3 "대조 로직을 새로 쓰지 마라") --
// judgeHookSync/buildEntries/resolveInstalledDir all live in
// hook-sync-check.mjs and are reused as-is via runHookSyncCheck.
import { runHookSyncCheck } from "./hook-sync-check.mjs";

// The one copy-pasteable line this device ever tells a human to run. Kept as
// a single exported constant so the CLI output and the test suite that
// asserts its presence can never drift from each other.
export const FIX_COMMAND = "node scripts/check/hook-sync-check.mjs --install";

// ---------------------------------------------------------------------------
// Judgment: verdict -> { canLaunch, exitCode }. Exit code contract
// (coder-task.md §3, documented here as the single source of truth):
//   0 = IN_SYNC      -- seat may launch
//   2 = DRIFT         -- seat launch BLOCKED, a fix command exists
//   1 = UNDECIDABLE   -- seat launch BLOCKED, judgment itself failed
// Neither non-IN_SYNC branch is ever allowed to collapse to 0 -- that is the
// fail-closed contract §2-1 states explicitly ("설계 = 차단. 관측·경고가
// 아니다").
// ---------------------------------------------------------------------------
export function admissionFor(verdict) {
  if (verdict === "IN_SYNC") return { canLaunch: true, exitCode: 0 };
  if (verdict === "DRIFT") return { canLaunch: false, exitCode: 2 };
  return { canLaunch: false, exitCode: 1 };
}

// Review round 3 (HYK-200-preflight-3, P1-A): `judgeHookSync`'s
// `VERDICT_SEVERITY.find(...) ?? "IN_SYNC"` folds ZERO judged entries into
// IN_SYNC -- correct for hook-sync-check.mjs's own contract (never touched
// here, coder-task §2-1: "hook-sync-check.mjs 를 고치지 마라"), but wrong for
// THIS device's stronger promise ("0이 아니면 좌석을 아예 띄우지 않는다").
// An empty `hooks/`, or one containing only subdirectories (`buildEntries`
// only lists files), compares literally nothing yet reports "installed
// matches versioned" -- the fold happens HERE instead, downstream of the
// reused device, so hook-sync-check.mjs's other callers are unaffected.
function foldEmptyComparisonToUndecidable(result) {
  if (result.verdict !== "IN_SYNC" || result.results.length !== 0) {
    return result;
  }
  return {
    ...result,
    verdict: "UNDECIDABLE",
    reason:
      "0 comparison targets under versioned hooks/ (empty directory, or only subdirectories -- buildEntries only lists files) -- nothing was actually compared, so IN_SYNC cannot be claimed",
  };
}

// Runs the reused hook-sync-check device and folds its result into this
// device's own admission decision. `cwd` is the seat's worktree (the
// launcher runs this FROM the worktree it is about to start a seat in) --
// left injectable so tests can point it at synthetic fixtures instead of
// this real repo's own hooks.
//
// Review round 3 (P2-C): this function is documented as "always returns a
// verdict" (enforcement-v1.md), so a thrown exception from the reused
// device (e.g. `cwd` is not a git repo, or `git` is missing from PATH --
// both hit inside `runHookSyncCheck`'s `repoRoot()` shell-out) must fold
// into the same UNDECIDABLE contract as every other unresolvable
// condition instead of propagating as an unhandled exception. The CLI
// happened to still exit non-zero on an uncaught throw (Node's own
// default), but the seat screen showed a raw stack dump, not a verdict a
// launcher calling this as a FUNCTION could branch on.
export function evaluateSeatPreflight({ cwd = process.cwd() } = {}) {
  let result;
  try {
    result = runHookSyncCheck({ cwd });
  } catch (err) {
    result = {
      verdict: "UNDECIDABLE",
      mismatches: [],
      results: [],
      resolvedInstalledDir: null,
      source: null,
      reason: `runHookSyncCheck threw: ${err.message}`,
    };
  }
  result = foldEmptyComparisonToUndecidable(result);
  const admission = admissionFor(result.verdict);
  return { ...result, ...admission };
}

// Human-readable report (coder-task.md §3 "출력 요건"): what drifted (file +
// kind), and the exact command that fixes it -- terse, meant for a seat
// screen, not a log dump.
export function formatReport(result) {
  if (result.verdict === "IN_SYNC") {
    return `seat-preflight: PASS -- installed hooks (${result.resolvedInstalledDir}) match versioned hooks/. 좌석 기동 가능.`;
  }
  if (result.verdict === "DRIFT") {
    const lines = result.mismatches.map((m) => `  DRIFT ${m.name} (${m.kind})`);
    return [
      "seat-preflight: BLOCK -- installed hooks drifted from versioned hooks/. 좌석 기동 금지.",
      ...lines,
      `고치는 명령: ${FIX_COMMAND}`,
    ].join("\n");
  }
  // UNDECIDABLE -- no fix command exists (the judgment itself failed, not a
  // known drift), so this branch intentionally never prints FIX_COMMAND.
  //
  // Review round 3 (P1-B): `result.reason` is only ever set by
  // runHookSyncCheck's two EARLY-RETURN cases (installed-dir resolution
  // failure, versioned-dir-missing) plus this device's own P1-A/P2-C
  // fallbacks above -- it stays undefined for the far more common case of
  // a PER-FILE judgment failure (judgeHookFile returning UNDECIDABLE/DRIFT
  // for one entry while others are fine), so the old `reason ?? "unknown"`
  // printed the literal word "unknown" there, and any DRIFT entry judged
  // in the same run vanished entirely (judgeHookSync's worst-first fold
  // reports only the overall verdict, not which files caused it). Printing
  // every non-IN_SYNC entry from `result.results` closes both holes at
  // once; the coarse top-level `reason` remains the fallback only when
  // there is nothing more specific to show (results is empty).
  const perFileLines = (result.results ?? [])
    .filter((r) => r.status !== "IN_SYNC")
    .map((r) => `  ${r.status} ${r.name} -- ${r.reason}`);
  const lines =
    perFileLines.length > 0
      ? perFileLines
      : [`  reason: ${result.reason ?? "unknown"}`];
  return [
    "seat-preflight: BLOCK -- 판정 불가(UNDECIDABLE). 좌석 기동 금지.",
    ...lines,
  ].join("\n");
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/seat-preflight.mjs");
if (invokedDirectly) {
  const result = evaluateSeatPreflight({});
  console.log(formatReport(result));
  process.exit(result.exitCode);
}
