// HYK-477 §1-3: measures "how many `node` processes were alive on this
// machine at once, during a run" and reports the observed MAXIMUM so
// isolated-suite-runner.mjs's receipt can carry a machine fact (not a
// human report) about whether a concurrency cap actually held in
// practice.
//
// Why a SEPARATE process, not an in-process setInterval poller: the run
// this measures is driven by `spawnSync` (see isolated-suite-runner.mjs's
// spawnSuiteInClone), which blocks Node's single event loop for the
// entire suite -- no timer in the SAME process can fire while spawnSync
// is blocked. Only an independent OS process can keep sampling while the
// parent is synchronously blocked waiting on the child it spawned.
//
// ⚠️정직 한계 (measurement limits, task §1-3 요구):
// 1. Polling, not event-driven: a real peak that rises and falls entirely
//    between two samples is invisible -- this can only ever UNDERcount
//    the true peak, never overcount it.
// 2. System-WIDE count, not run-scoped: `tasklist`/`ps` see every `node`
//    process on the machine, including ones this run never started (an
//    editor, another Claude Code session, this very orchestrator). The
//    number is therefore an upper bound on "how many node processes this
//    run's own tree produced", not an exact isolated measurement --
//    narrowing it to a specific process tree would need OS-specific
//    parent-PID walking this round's scope does not cover.
// 3. Best-effort final write: the parent kills this process with no
//    graceful shutdown guarantee (Windows `TerminateProcess` via
//    `child.kill()` runs no exit handler), so the very last instant
//    before the kill may be missed -- mitigated by writing the running
//    max on EVERY sample, not only at exit, but a residual gap up to one
//    `--interval-ms` window remains.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// win32: `tasklist` lists one CSV/plain line per running `node.exe`
// instance; with none running it prints an "INFO: No tasks..." line
// instead of an empty result, so that case is special-cased to 0 rather
// than counted as "1 line, 1 process".
export function countNodeProcessesWindows({ exec = execFileSync } = {}) {
  const out = exec(
    "tasklist",
    ["/FI", "IMAGENAME eq node.exe", "/NH", "/FO", "CSV"],
    { encoding: "utf8" },
  );
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return 0;
  if (/^INFO:/i.test(lines[0])) return 0;
  return lines.length;
}

// posix: `ps -eo comm=` prints one bare command name per process (no
// header, trailing `=` on the format key suppresses it) -- counts entries
// that are exactly "node" (the basename of process.execPath), not merely
// containing it, so an unrelated "node-something" binary is never
// miscounted.
export function countNodeProcessesPosix({ exec = execFileSync } = {}) {
  const out = exec("ps", ["-eo", "comm="], { encoding: "utf8" });
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l === "node").length;
}

// Never throws (§ "정직 한계" above): a failed sample must not crash the
// sampler loop or the parent run -- it just contributes no data point for
// that tick, and `null` propagates as "measurement unavailable" if EVERY
// sample fails.
export function countNodeProcesses({
  platform = process.platform,
  exec = execFileSync,
} = {}) {
  try {
    return platform === "win32"
      ? countNodeProcessesWindows({ exec })
      : countNodeProcessesPosix({ exec });
  } catch {
    return null;
  }
}

// One sampling tick: takes a count, folds it into the running max, and
// (best-effort, never throws) persists {max, samples, lastSampleAtMs} to
// outPath so a parent that kills this process mid-run still finds the
// most recent max on disk (see module header, limitation 3).
export function sampleOnce({
  state,
  outPath,
  countFn = countNodeProcesses,
  writeFileFn = writeFileSync,
  nowMs = Date.now,
}) {
  const n = countFn();
  if (Number.isInteger(n)) {
    state.samples += 1;
    if (state.max == null || n > state.max) state.max = n;
  }
  try {
    writeFileFn(
      outPath,
      JSON.stringify({
        max: state.max,
        samples: state.samples,
        lastSampleAtMs: nowMs(),
      }),
      "utf8",
    );
  } catch {
    // best-effort persistence -- an I/O failure on one tick must not stop
    // sampling; the next tick's write may still succeed.
  }
  return state;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/node-concurrency-sampler.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let intervalMs = 250;
  let outPath;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--interval-ms") intervalMs = Number(args[++i]);
    else if (args[i] === "--out") outPath = args[++i];
  }
  if (!outPath) {
    console.error("[node-concurrency-sampler] --out <path> is required");
    process.exit(1);
  }
  const state = { max: null, samples: 0 };
  sampleOnce({ state, outPath });
  setInterval(() => sampleOnce({ state, outPath }), intervalMs);
}
