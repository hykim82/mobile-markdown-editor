// HYK-208: runs the CI-canonical test suite inside a fresh, per-run clone of
// the committed repo state, instead of against whatever checkout invoked it.
// Rationale (docs/hyk206-parallel-test-isolation-findings-2026-08-08.md):
// 34 test files snapshot `git status --porcelain` before/after and assert
// zero diff, on the assumption that nothing else touches that checkout
// while they run. That assumption is false whenever another actor (a
// person, ORCH, a tool) runs `git status`/edits a tracked file/creates an
// untracked file in the SAME checkout during the run -- the snapshot window
// catches it and the test fails for a reason that has nothing to do with
// the code under test. Running the suite in a disposable clone gives each
// run true exclusive ownership of the checkout those 34 files snapshot, so
// external interference to the source repo can no longer be observed by
// them -- while a test that dirties ITS OWN (cloned) checkout and fails to
// clean up still trips the same safety nets, because those nets test
// `git rev-parse --show-toplevel` of the process's own cwd, which is the
// clone once `node --test` is spawned with `cwd: <clone>`.
//
// Approved tradeoff (task HYK-208 §2): only committed content is tested --
// `git clone` never carries uncommitted changes. This is intentional, not a
// bug; §3-4 requires this runner to say so on every run, plus which commit
// it tested, so nobody is left wondering why an uncommitted fix "didn't
// show up."
import {
  execFileSync,
  spawn as spawnAsync,
  spawnSync,
} from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNNER_STATUS,
  allocateRunSlot,
  parseTapSummaryCounts,
  writeNumberedRunnerReceipt,
  writeRunnerReceipt,
} from "./runner-receipt-writer.mjs";

// Windows can hand back an 8.3 short-name form of %TEMP% (e.g.
// "ADMINI~1"). At least one existing test (hyk171-cycle3a-mutation.test.mjs
// S6) builds a path from `new URL(...).pathname` without decoding it, so a
// literal "~" in the clone path turns into a literal "%7E" and the read
// 404s -- not a bug this task's scope covers (that file is admission-core-
// adjacent and off limits, see coder-task.md §0), so the isolated clone
// must simply not live under a short-name path in the first place.
function longFormTmpdir() {
  try {
    return realpathSync.native(tmpdir());
  } catch {
    return tmpdir();
  }
}

// Mirrors .github/workflows/enforce.yml's canonical check command exactly:
// four directories, each non-recursive (scripts/relay/*.test.mjs excludes
// scripts/relay/adapters/ -- that's why adapters gets its own entry).
export const TEST_DIRS = [
  "scripts/check",
  "scripts/relay",
  "scripts/relay/adapters",
  "scripts/supervisor",
];

// Fail-closed (HYK-208 2R, review finding): a directory this runner expects
// to exist in the clone (TEST_DIRS) that can't be read is NOT skipped --
// skipping would silently run fewer suites than the CI-canonical command
// and still report green. An unreadable expected directory means the clone
// is incomplete or the layout changed; either way this must be a loud
// failure, not a quiet one.
export function collectTestFiles(
  root,
  dirs = TEST_DIRS,
  { readdir = readdirSync } = {},
) {
  const files = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdir(join(root, dir));
    } catch (err) {
      throw new Error(
        `isolated-suite-runner: required test directory unreadable in the clone: ${dir} (${err.message}) -- fail-closed, refusing to silently run fewer suites than the CI-canonical command`,
        { cause: err },
      );
    }
    for (const name of entries.filter((f) => f.endsWith(".test.mjs")).sort()) {
      files.push(join(dir, name));
    }
  }
  return files;
}

// HYK-473 §2-1: `node --test` with no `--test-concurrency` defaults to one
// worker per CPU core (this file previously passed zero concurrency flags
// at all -- 0 hits on `--test-concurrency` grep, confirmed before this
// round). Each worker is its own child process with its own V8 heap, so on
// a machine already under memory pressure from unrelated processes,
// core-count-wide concurrency is exactly the shape HYK-468 4R traced its 3
// consecutive forced-kill runs to (dropped_at evidence: ~3.6-3.8GB/16.7GB
// free, steady across all 3 attempts -- not a spike this runner caused).
// Halving the core count keeps real parallelism (this suite has ~50+ test
// files; concurrency 1 would serialize all of them) while roughly halving
// the peak number of concurrent heaps; max(1, floor(...)) keeps 1-2 core
// machines from resolving to a 0 or negative concurrency.
export function resolveConcurrency({ cpuCount = cpus().length } = {}) {
  return Math.max(1, Math.floor(cpuCount / 2));
}

// HYK-477 §1-1: this runner's own `--test-concurrency` cap only bounds the
// ONE layer of `node --test` children it spawns directly. ORCH's real
// observation (coder-task.md §0): some of those files spawn ANOTHER
// `node --test` from inside themselves (a nested self-sweep,
// hyk359-ambient-env-regression.test.mjs's runProductionSweep chief among
// them) -- that grandchild inherits process.env but NOT this runner's
// `--concurrency` CLI flag, so it fell back to its own hardcoded/default
// concurrency regardless of how low the outer cap was set, undermining the
// whole point of lowering it. Exporting the resolved cap as an env var lets
// any such nested spawn point read it back and clamp itself, without this
// runner needing to know those spawn points exist.
export const NESTED_CONCURRENCY_ENV_VAR = "HARNESS_TEST_CONCURRENCY";

// A nested spawn point calls this with the concurrency IT would otherwise
// use (`desired`) and gets back `desired`, unless an ambient
// HARNESS_TEST_CONCURRENCY is both a valid positive integer AND smaller --
// min, never max, so a nested caller can never use this mechanism to raise
// its own concurrency above what it already intended (coder-task.md §1-1
// "상한을 올리는 방향으로는 쓰이지 않게 하라"). A missing/empty/invalid env
// value is silently ignored (falls back to `desired`) rather than thrown --
// this function runs at the START of a spawn call a real test suite depends
// on, so a malformed ambient env var must degrade to "no cap propagated",
// never abort the run.
export function resolveNestedConcurrency(desired, { env = process.env } = {}) {
  const raw = env[NESTED_CONCURRENCY_ENV_VAR];
  if (raw == null || raw === "") return desired;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return desired;
  return Math.min(desired, n);
}

// §2-1 "상한 값이 러너 로그 첫 줄에 값으로 찍히게 하라": this is logged
// before formatBanner's line in runIsolatedSuite, making it the literal
// first line a human watching the run sees.
export function formatConcurrencyBanner({ concurrency, reason }) {
  return `[isolated-suite-runner] test-concurrency=${concurrency} (${reason})`;
}

const DEFAULT_CONCURRENCY_REASON =
  "default: max(1, floor(cpu-count/2)) -- bounds peak concurrent node --test child heaps after HYK-468 4R's 3 consecutive OOM kills, traced to unbounded (core-count-wide) concurrency";
const OVERRIDE_CONCURRENCY_REASON = "explicit --concurrency override";

// HYK-473 §2-2: distinguishes "the suite ran to completion and node --test
// itself reported a result" from "no result was ever produced" -- the
// latter must never be recorded as TESTS_FAILED, because that is a
// different fact (§1 of coder-task.md: a downstream reader must be able to
// tell "fail 0 but not green" apart from a real red run). Decided
// structurally on spawnSync's own signal/status/error fields, in that
// order -- never by matching any message/log text (HYK-262: a one-
// character wording change must not silently flip a judgment). Empirically
// verified (this round, Windows, node -- spawnSync with timeout+SIGKILL):
// a forced kill sets result.signal (e.g. "SIGKILL") and usually also
// result.error (e.g. ETIMEDOUT) with result.status left null; a real
// non-zero exit sets only result.status, leaving signal/error null/absent.
//
// HYK-477 §2-3 2R (검토 P1-1 재반려, 2026-09-16, rounds/REVIEW-r1.md): 이
// 저장소가 실제로 겪는 강제 종료는 위 `result.status == null` 분기로 잡히지
// 않는다 -- Windows에는 POSIX 시그널이 없어 spawnSync가 강제 종료를
// result.signal이 아니라 result.status에 숫자(0xFFFFFFFF 등)로 채워
// 돌려주기 때문이다(같은 커밋이 스스로 쓴 영수증이 증거:
// .harness/runner-receipt-run5.json -- runner_exit 4294967295 ·
// runner_status TESTS_FAILED · tests/pass/fail/skip 전부 null, 짝 로그
// full-runner-5.log는 요약 줄 없이 끊김). 그래서 "status가 null/undefined
// 인가"만 보던 분류기는 이 플랫폼의 진짜 강제종료를 하나도 못 잡고
// TESTS_FAILED로 접었다.
//
// 검토 권고 ⓐ(가장 강한 축, 종료코드 목록에 기대지 않는다)로 바꾼다:
// signal/error도 없고 status도 0이 아닌 경우, "node --test 자신이 tap
// reporter에 완료 요약 줄(`# tests N`)을 남겼는가"(hasCompletion, 호출자가
// 실제 tap 파일을 읽어 판단해 넘긴다 -- 아래 hasTapCompletion)로 가른다.
// 진짜 시험 실패는 개별 테스트가 실패해도 node --test 프로세스 자체는
// 끝까지 돌아 요약까지 쓰므로(관찰 사실), 이 신호는 "정말 실패했다"와
// "완료 결과 자체가 없다"를 종료코드의 플랫폼별 모양과 무관하게 가른다 --
// Windows의 0xFFFFFFFF든 다른 어떤 비정상 코드든 목록을 만들 필요가 없다.
export function classifySpawnOutcome(result, { hasCompletion = false } = {}) {
  if (result.signal) {
    return { status: RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM, exitCode: 1 };
  }
  if (result.error) {
    return { status: RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM, exitCode: 1 };
  }
  if (result.status === 0) {
    return { status: RUNNER_STATUS.OK, exitCode: 0 };
  }
  if (!hasCompletion) {
    return { status: RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM, exitCode: 1 };
  }
  return { status: RUNNER_STATUS.TESTS_FAILED, exitCode: result.status ?? 1 };
}

// HYK-477 §2-3 2R: the input classifySpawnOutcome's hasCompletion needs --
// isolated into its own function so a tap-read failure (no file, unreadable,
// no summary line) degrades to "no completion" rather than throwing and
// losing the real spawn outcome. Reuses parseTapSummaryCounts (the same
// parser emitRunnerReceipt uses for the receipt's own counts) so both call
// sites agree on what "a completion summary" looks like.
function hasTapCompletion({ tapPath, readFile }) {
  try {
    return parseTapSummaryCounts(readFile(tapPath, "utf8")).tests != null;
  } catch {
    return false;
  }
}

// The one-line disclosure required by task §3-4: which commit was tested,
// and an explicit statement that uncommitted content was not.
export function formatBanner({ sha, dirty }) {
  const base = `[isolated-suite-runner] tested commit ${sha} -- ran against an isolated clone of committed HEAD only, uncommitted changes are NOT included in this run`;
  if (!dirty) return base;
  return `${base}\n[isolated-suite-runner] NOTE: the source checkout has uncommitted changes -- they were excluded from this run`;
}

function repoRootOf(cwd, execFile) {
  return execFile("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

// HYK-411 §2-1: the runner writes its OWN observed exit code to a receipt
// file -- a downstream pipe (`npm test | tail`) can rewrite what the shell
// sees as ITS exit code, but it cannot reach back into this process and
// change what this process writes to its own file. Deliberately
// unconditional on runnerExit === 0 (§2-1 "실패했다고 영수증을 안 쓰면
// 안 된다" -- a red run must leave a receipt too, or this fix only ever
// proves the case nobody needed proving). Never throws: a failure to read
// the tap summary or write the receipt must never be mistaken for -- and
// must never suppress -- the suite's own real exit code (same "never
// throws past this point" posture as consumption-receipt-writer.mjs's
// writeConsumptionReceipt).
//
// HYK-485 §2-1: also writes a run-scoped numbered copy (allocateRunSlot's
// receiptPath, computed BEFORE spawn so its sibling logPath can ride node
// --test's own argv -- see runIsolatedSuite/spawnSuiteInClone) alongside
// the unconditionally-preserved "latest" write above. Both writes share the
// SAME counts/finishedAtMs (computed once here) so the numbered copy is a
// byte-for-byte-except-path snapshot of the same run, not two independently
// timed observations of it. Guarded in its OWN try/catch, separate from the
// latest-file write above: a numbered-copy failure must not affect (and
// must not be masked by) the latest write's own success/failure, and
// neither may ever affect the suite's real exit code.
function emitRunnerReceipt({
  root,
  sha,
  runnerExit,
  runnerStatus,
  tapPath,
  runSlot,
  readFile,
  writeReceipt,
  writeNumberedReceipt = writeNumberedRunnerReceipt,
  nowMs,
  log,
  maxConcurrentNode,
}) {
  let counts = { tests: null, pass: null, fail: null, skip: null };
  try {
    counts = parseTapSummaryCounts(readFile(tapPath, "utf8"));
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: could not read tap summary at ${tapPath} (${err.message}) -- receipt will carry null counts`,
    );
  }
  const finishedAtMs = nowMs();
  try {
    const { path } = writeReceipt({
      harnessDir: join(root, ".harness"),
      runnerExit,
      runnerStatus,
      counts,
      headCommit: sha,
      finishedAtMs,
      maxConcurrentNode,
    });
    log(`[isolated-suite-runner] runner receipt written -> ${path}`);
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: failed to write runner receipt (${err.message}) -- consumption-side fail-closed gate (relay-handshake.mjs) will treat this as a missing receipt`,
    );
  }
  if (!runSlot.receiptPath) return;
  try {
    const { path } = writeNumberedReceipt({
      receiptPath: runSlot.receiptPath,
      runnerExit,
      runnerStatus,
      counts,
      headCommit: sha,
      finishedAtMs,
      maxConcurrentNode,
    });
    log(`[isolated-suite-runner] per-run numbered receipt written -> ${path}`);
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: failed to write numbered receipt run${runSlot.runNumber} (${err.message}) -- HYK-485 §2-2's per-round comparison will see this run's evidence as missing, i.e. measurement-unavailable, not as a fabricated pass`,
    );
  }
}

// Builds the argv for the in-clone `node --test` invocation. A second,
// machine-readable tap reporter destination rides alongside the human-facing
// spec reporter (HYK-411) -- `node --test` supports repeated
// --test-reporter/--test-reporter-destination pairs, so both fire from one
// process without disturbing the real-time inherited stdio a human watches.
//
// HYK-485 §2-1: a THIRD reporter pair (spec -> logPath, when logPath is
// given) rides the same mechanism to produce the persistent "러너 stdout
// 로그" (full-runner-<N>.log) -- same format as what the human sees live on
// stdout, written directly by node --test itself to a durable file. This
// was chosen deliberately over capturing/teeing the child's stdio in this
// process: switching spawnSuiteInClone's stdio away from "inherit" (e.g. to
// "pipe" + manual re-emit) would buffer output until the child exits,
// losing the real-time view a human watches during a run that can take
// minutes -- a regression this task's scope does not ask for and §5 does
// not authorize. Adding a reporter destination changes nothing about
// stdio/spawn semantics at all: node --test writes it as a plain side
// effect of its own three-reporter fan-out, `stdio: "inherit"` below is
// completely untouched.
function buildNodeTestArgs(files, tapPath, concurrency, logPath) {
  const args = [
    "--test",
    `--test-concurrency=${concurrency}`,
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${tapPath}`,
  ];
  if (logPath) {
    args.push("--test-reporter=spec", `--test-reporter-destination=${logPath}`);
  }
  args.push(...files);
  return args;
}

// Runs the suite inside the already-prepared clone and returns its
// classified outcome (§2-2: {status, exitCode}, never a bare exit code --
// see classifySpawnOutcome). Isolated into its own function so
// runIsolatedSuite's own branching stays low (max-lines-per-function/
// complexity gate, coder-task.md quality bar).
function spawnSuiteInClone({
  spawn,
  cloneDir,
  files,
  tapPath,
  concurrency,
  logPath,
  readFile,
}) {
  const result = spawn(
    process.execPath,
    buildNodeTestArgs(files, tapPath, concurrency, logPath),
    {
      cwd: cloneDir,
      stdio: "inherit",
      // HYK-403: marks this run as having gone through a canonical entry
      // point, so canonical-suite-entrypoint.test.mjs (scripts/check, swept
      // up by any construction of the four-directory glob, including a
      // hand-built one) can tell a real `npm test` / CI run apart from
      // someone hand-typing `node --test <glob>` directly against a live
      // checkout -- the exact shape that leaked into the control room on
      // 2026-08-30.
      env: {
        ...process.env,
        HYK403_CANONICAL_SUITE_ENTRYPOINT: "isolated-suite-runner",
        // HYK-477 §1-1: propagates the resolved cap to any nested spawn
        // point this in-clone `node --test` process (or a test file it
        // runs) creates -- see resolveNestedConcurrency's own comment.
        [NESTED_CONCURRENCY_ENV_VAR]: String(concurrency),
      },
    },
  );
  return classifySpawnOutcome(result, {
    hasCompletion: hasTapCompletion({ tapPath, readFile }),
  });
}

// Removes the two scratch directories this run made. Isolated so the
// `keep` branch doesn't count against runIsolatedSuite's own complexity.
function cleanupRunDirs({ keep, log, cloneDir, tapDir }) {
  rmSync(tapDir, { recursive: true, force: true });
  if (keep) {
    log(`[isolated-suite-runner] --keep set: leaving clone at ${cloneDir}`);
    return;
  }
  rmSync(cloneDir, { recursive: true, force: true });
}

// Resolves the concurrency cap and logs it as the run's first line (§2-1
// "첫 줄"). Isolated so its branching doesn't count against
// runIsolatedSuite's own complexity gate.
function resolveAndLogConcurrency({ concurrency, resolveConcurrencyFn, log }) {
  const resolveFn = resolveConcurrencyFn ?? resolveConcurrency;
  const resolvedConcurrency = concurrency ?? resolveFn();
  const reason =
    concurrency != null
      ? OVERRIDE_CONCURRENCY_REASON
      : DEFAULT_CONCURRENCY_REASON;
  log(formatConcurrencyBanner({ concurrency: resolvedConcurrency, reason }));
  return resolvedConcurrency;
}

// No numbered artifacts this run (allocation failed, or nothing asked for
// them) -- a real object with null fields rather than a bare `null` so
// call sites read `runSlot.logPath`/`runSlot.receiptPath` directly instead
// of needing optional-chaining at every use (keeps runIsolatedSuite's own
// branch count down; each `?.` is itself a branch for the complexity gate).
const NO_RUN_SLOT = Object.freeze({
  runNumber: null,
  receiptPath: null,
  logPath: null,
});

// HYK-485 §2-1: allocates this run's numbered-artifact slot BEFORE spawn
// (its logPath must ride node --test's own argv, see buildNodeTestArgs) --
// isolated into its own function so a failure here degrades gracefully
// instead of crashing the whole run before the real suite ever starts.
// Never throws: allocation infra (mkdir/exclusive-create) is not the thing
// this runner exists to prove green or red -- a failure here just means
// this run won't have numbered artifacts (the "latest" runner-receipt.json
// is written separately, unaffected either way).
function resolveRunSlot({
  harnessDir,
  allocateRunSlotFn = allocateRunSlot,
  log,
}) {
  try {
    // a stub/test double is allowed to signal "no slot" with a bare
    // `null`/`undefined` return -- normalize it to the real sentinel so
    // every downstream reader can rely on `runSlot.logPath` existing.
    return allocateRunSlotFn({ harnessDir }) ?? NO_RUN_SLOT;
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: failed to allocate a per-run artifact slot (${err.message}) -- this run will not produce numbered runner-receipt-run<N>.json/full-runner-<N>.log artifacts; the latest runner-receipt.json is unaffected`,
    );
    return NO_RUN_SLOT;
  }
}

// HYK-477 §1-3: the sampler script's path, resolved once at module load
// (mirrors how the rest of this file locates its own sibling modules via
// static import -- this one is spawned, not imported, so it needs its own
// file path instead).
const CONCURRENCY_SAMPLER_PATH = fileURLToPath(
  new URL("./node-concurrency-sampler.mjs", import.meta.url),
);

// Starts the background sampler process (see node-concurrency-sampler.mjs's
// own header for why it must be a SEPARATE process, not an in-process
// timer). Never throws: a failure to start sampling must not affect the
// suite run itself -- same "infra failure degrades gracefully" posture as
// resolveRunSlot above. Returns `null` on failure so stopConcurrencySampler
// can treat "never started" and "failed to stop" uniformly (both -> no
// measurement).
function startConcurrencySampler({
  spawnFn = spawnAsync,
  samplerPath = CONCURRENCY_SAMPLER_PATH,
  outPath,
  intervalMs = 250,
  log,
}) {
  try {
    const child = spawnFn(
      process.execPath,
      [samplerPath, "--interval-ms", String(intervalMs), "--out", outPath],
      { stdio: "ignore" },
    );
    child.unref?.();
    return child;
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: failed to start node-concurrency sampler (${err.message}) -- receipt's max_concurrent_node will be null`,
    );
    return null;
  }
}

// Kills the sampler and reads back the max it observed. `child.kill()` on
// Windows is a forced TerminateProcess with no graceful shutdown -- the
// sampler mitigates that by persisting its running max on every tick, not
// only at exit (see its own module header), so this can still read a very
// recent value even though the process is already gone by the time this
// function's readFileFn runs.
function stopConcurrencySampler({
  child,
  outPath,
  readFileFn = readFileSync,
  log,
}) {
  if (!child) return null;
  try {
    child.kill();
  } catch {
    // best-effort -- a failure to kill an already-dead process must not
    // affect the run's own result.
  }
  try {
    const data = JSON.parse(readFileFn(outPath, "utf8"));
    return Number.isInteger(data.max) ? data.max : null;
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: could not read node-concurrency sampler output at ${outPath} (${err.message}) -- max_concurrent_node will be null`,
    );
    return null;
  }
}

// Runs the suite while sampling concurrent `node` process count around it
// (start sampler -> spawn suite -> stop sampler) and returns both the
// suite's own outcome and the sampled max together. Isolated into its own
// function purely to keep runIsolatedSuite's own branch count down (same
// "keeps runIsolatedSuite's own complexity gate happy" reasoning as
// resolveAndLogConcurrency/resolveRunSlot above) -- no new behavior, just a
// named seam around the three sampler-related statements.
function spawnSuiteWithSampler({
  spawn,
  cloneDir,
  files,
  tapPath,
  concurrency,
  logPath,
  readFile,
  samplerOutPath,
  startSampler = startConcurrencySampler,
  stopSampler = stopConcurrencySampler,
  log,
}) {
  const samplerChild = startSampler({ outPath: samplerOutPath, log });
  const outcome = spawnSuiteInClone({
    spawn,
    cloneDir,
    files,
    tapPath,
    concurrency,
    logPath,
    readFile,
  });
  const maxConcurrentNode = stopSampler({
    child: samplerChild,
    outPath: samplerOutPath,
    log,
  });
  return { outcome, maxConcurrentNode };
}

// Orchestrates one full run: clone committed HEAD -> run the suite in the
// clone -> report -> always clean up (unless `keep`). Returns the child
// process's exit code so the CLI entry point can propagate it verbatim.
export function runIsolatedSuite({
  sourceRoot,
  keep = false,
  concurrency,
  execFile = execFileSync,
  spawn = spawnSync,
  log = console.log,
  collectFiles = collectTestFiles,
  mkdtemp = mkdtempSync,
  readFile = readFileSync,
  writeReceipt = writeRunnerReceipt,
  allocateRunSlotFn,
  writeNumberedReceipt,
  nowMs = Date.now,
  resolveConcurrencyFn,
  startSampler,
  stopSampler,
} = {}) {
  const resolvedConcurrency = resolveAndLogConcurrency({
    concurrency,
    resolveConcurrencyFn,
    log,
  });
  const root = sourceRoot ?? repoRootOf(process.cwd(), execFile);
  const sha = execFile("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const porcelain = execFile("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  const dirty = porcelain.trim().length > 0;

  const cloneDir = mkdtempSync(join(longFormTmpdir(), "hyk208-isolated-"));
  // HYK-411: this tap destination lives OUTSIDE cloneDir on purpose --
  // writing it inside cloneDir would add an untracked file to the very
  // checkout the 34 git-status-porcelain safety-net tests (see this file's
  // own header) snapshot from inside, turning this runner's own
  // instrumentation into a false positive for those tests.
  const tapDir = mkdtemp(join(longFormTmpdir(), "hyk411-tap-"));
  const tapPath = join(tapDir, "runner-output.tap");
  const harnessDir = join(root, ".harness");
  const runSlot = resolveRunSlot({ harnessDir, allocateRunSlotFn, log });
  try {
    execFile("git", ["clone", "--quiet", root, cloneDir], { encoding: "utf8" });
    const files = collectFiles(cloneDir);
    log(formatBanner({ sha, dirty }));
    log(
      `[isolated-suite-runner] clone: ${cloneDir} (${files.length} test file(s))`,
    );
    const { outcome, maxConcurrentNode } = spawnSuiteWithSampler({
      spawn,
      cloneDir,
      files,
      tapPath,
      concurrency: resolvedConcurrency,
      logPath: runSlot.logPath,
      readFile,
      samplerOutPath: join(tapDir, "node-concurrency-sampler.json"),
      startSampler,
      stopSampler,
      log,
    });

    emitRunnerReceipt({
      root,
      sha,
      runnerExit: outcome.exitCode,
      runnerStatus: outcome.status,
      tapPath,
      runSlot,
      readFile,
      writeReceipt,
      writeNumberedReceipt,
      nowMs,
      log,
      maxConcurrentNode,
    });

    return outcome.exitCode;
  } finally {
    cleanupRunDirs({ keep, log, cloneDir, tapDir });
  }
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/isolated-suite-runner.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let sourceRoot;
  let keep = false;
  let concurrency;
  const unrecognized = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo-root") {
      if (i + 1 >= args.length) {
        unrecognized.push(args[i]);
      } else {
        sourceRoot = args[++i];
      }
    } else if (args[i] === "--keep") {
      keep = true;
    } else if (args[i] === "--concurrency") {
      if (i + 1 >= args.length) {
        unrecognized.push(args[i]);
      } else {
        const raw = args[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
          console.error(
            `[isolated-suite-runner] --concurrency must be a positive integer, got: ${raw} -- refusing to silently fall back to a default that could mask an operator's intended cap`,
          );
          process.exit(1);
        }
        concurrency = n;
      }
    } else {
      unrecognized.push(args[i]);
    }
  }
  if (unrecognized.length > 0) {
    console.error(
      `[isolated-suite-runner] unrecognized argument(s): ${unrecognized.join(" ")} -- refusing to silently ignore unknown arguments and run against the wrong target`,
    );
    process.exit(1);
  }
  const exitCode = runIsolatedSuite({ sourceRoot, keep, concurrency });
  process.exit(exitCode);
}
