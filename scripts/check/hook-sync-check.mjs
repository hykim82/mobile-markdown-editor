import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, isAbsolute } from "node:path";
import { sha256Hex } from "./selfcheck-inventory.mjs";

// ---------------------------------------------------------------------------
// CORE (pure judgment, I/O 0) -- same convention HYK-193 fixed
// (concurrency-core.mjs): every input is a value injected by the caller,
// never a path/readFn. All filesystem/git access lives below, outside this
// section.
// ---------------------------------------------------------------------------

// The three judgment values this device ever returns (design report §1
// "볼 것"), worst-first so combineFileStatuses can pick deterministically.
export const VERDICT_SEVERITY = ["UNDECIDABLE", "DRIFT", "IN_SYNC"];

// Judges a single hook file from its already-read versioned/installed sides.
// `versioned`/`installed` are one of:
//   { present: false }                         -- file does not exist
//   { present: true, readable: false, reason }  -- exists but could not be read
//   { present: true, readable: true, content }  -- read successfully
// The core itself is type-agnostic about `content` (it only ever passes it
// through sha256Hex) -- it is the I/O layer's job (buildEntries below) to
// make sure `content` is always raw bytes, never a UTF-8-decoded string
// (see the CONTRACT note on buildEntries' `readFileFn` default for why that
// distinction is load-bearing, not cosmetic).
// versioned is only ever `present: false` in a defensive sense (the caller
// only builds entries for names it just listed from the versioned dir), but
// the shape is still checked so a raced deletion fails closed, not silently.
export function judgeHookFile({ name, versioned, installed }) {
  if (!versioned.present || versioned.readable === false) {
    return {
      name,
      status: "UNDECIDABLE",
      reason: versioned.present
        ? `versioned hook '${name}' could not be read: ${versioned.reason}`
        : `versioned hook '${name}' unexpectedly missing during judgment`,
    };
  }
  if (!installed.present) {
    return {
      name,
      status: "DRIFT",
      kind: "missing",
      reason: `installed hook '${name}' is not present`,
    };
  }
  if (installed.readable === false) {
    return {
      name,
      status: "UNDECIDABLE",
      reason: `installed hook '${name}' could not be read: ${installed.reason}`,
    };
  }
  const versionedSha256 = sha256Hex(versioned.content);
  const installedSha256 = sha256Hex(installed.content);
  if (versionedSha256 !== installedSha256) {
    return {
      name,
      status: "DRIFT",
      kind: "content",
      versionedSha256,
      installedSha256,
      reason: `installed hook '${name}' differs from versioned '${name}' (sha256 mismatch)`,
    };
  }
  return {
    name,
    status: "IN_SYNC",
    versionedSha256,
    installedSha256,
    reason: `installed hook '${name}' matches versioned '${name}' (sha256 match)`,
  };
}

// Aggregates one judgeHookFile result list into the whole-device verdict +
// the `mismatches` shape the CLI/--json output exposes. Picks the worst
// per-file status (VERDICT_SEVERITY order) as the overall verdict -- a
// single unreadable file makes the whole run UNDECIDABLE (never silently
// downgraded to DRIFT or IN_SYNC), matching the design's fail-closed rule.
export function judgeHookSync(entries) {
  const results = entries.map(judgeHookFile);
  const statuses = results.map((r) => r.status);
  const verdict =
    VERDICT_SEVERITY.find((s) => statuses.includes(s)) ?? "IN_SYNC";
  const mismatches = results
    .filter((r) => r.status === "DRIFT")
    .map((r) => ({
      name: r.name,
      kind: r.kind,
      versionedSha256: r.versionedSha256,
      installedSha256: r.installedSha256,
    }));
  return { verdict, mismatches, results };
}

// ---------------------------------------------------------------------------
// I/O layer -- path resolution, file reads, git queries, --install writes.
// Everything below reads real state and hands plain values to the core above.
// ---------------------------------------------------------------------------

function repoRoot(cwd = process.cwd()) {
  return execSync("git rev-parse --show-toplevel", {
    cwd,
    encoding: "utf8",
  }).trim();
}

// `hooks/` is the versioned source of truth by default; `--versioned-dir`
// fully overrides it (never merged, never a secondary fallback), matching
// the task spec's "옵션으로 완전히 대체 가능" requirement.
export function resolveVersionedDir({ versionedDirOption, root }) {
  return versionedDirOption || join(root, "hooks");
}

// `--installed-dir` fully overrides; otherwise `core.hooksPath` if the repo
// has one set, otherwise `git rev-parse --git-common-dir` + "/hooks" -- the
// git-common-dir form is required (not `.git/hooks` string-glued) because in
// a linked worktree `.git` is a *file*, not the hooks directory (task spec
// §1 rationale). Returns `{ dir, source }` on success or `{ dir: null,
// source: null, error }` when resolution itself fails (fed straight into a
// whole-run UNDECIDABLE by the CLI, never exit 0).
export function resolveInstalledDir({
  installedDirOption,
  cwd,
  execFn = execSync,
}) {
  if (installedDirOption) {
    return { dir: installedDirOption, source: "option" };
  }
  let hooksPath = "";
  try {
    hooksPath = execFn("git config --get core.hooksPath", {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    // unset -- fall through to the git-common-dir resolution below.
  }
  if (hooksPath) {
    const resolved = isAbsolute(hooksPath) ? hooksPath : join(cwd, hooksPath);
    return { dir: resolved, source: "core.hooksPath" };
  }
  let commonDir;
  try {
    commonDir = execFn("git rev-parse --git-common-dir", {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch (err) {
    return {
      dir: null,
      source: null,
      error: `git-common-dir resolution failed: ${err.message}`,
    };
  }
  const resolvedCommon = isAbsolute(commonDir)
    ? commonDir
    : join(cwd, commonDir);
  return { dir: join(resolvedCommon, "hooks"), source: "git-common-dir" };
}

function readSide(path, existsFn, readFileFn) {
  if (!existsFn(path)) return { present: false };
  try {
    return { present: true, readable: true, content: readFileFn(path) };
  } catch (err) {
    return { present: true, readable: false, reason: err.message };
  }
}

// ★★CONTRACT (HYK-196 2R, P1 fix): `readFileFn` MUST hand back raw bytes
// (a Buffer -- `readFileSync(p)` with no encoding), never a decoded string.
// `sha256Hex` (imported above) ignores its "utf8" encoding argument when
// given a Buffer (Node's Hash.update only consults inputEncoding for string
// data), so a Buffer flows through it byte-for-byte. A string, by contrast,
// has ALREADY been through UTF-8 decoding -- an invalid byte sequence (e.g.
// a lone 0x80-0xBF or 0xF5-0xFF byte) silently collapses to U+FFFD, so two
// files differing only in one invalid trailing byte can decode to the
// *same* string and therefore hash equal, reporting IN_SYNC for content
// that is not byte-identical (the exact defect an independent review found
// outside this task's own listed test cases -- see
// hook-sync-check.test.mjs's "P1 regression" test and
// docs/enforcement-known-gaps.md gap#91). Any caller injecting a custom
// `readFileFn` (e.g. a test) must preserve this raw-bytes contract or the
// same hole reopens.
//
// Every file (not directory) directly under `versionedDir` is in scope --
// all of them, not just pre-commit (task spec §3 "정본 hooks/ 에 있는 모든
// 파일이 대상이다"). Installed-side-only extras (e.g. *.sample) are never
// enumerated here, so they never affect the verdict (task spec §3, test 5).
export function buildEntries({
  versionedDir,
  installedDir,
  existsFn = existsSync,
  readFileFn = (p) => readFileSync(p),
  readdirFn = readdirSync,
  statFn = statSync,
}) {
  let names;
  try {
    names = readdirFn(versionedDir)
      .filter((n) => {
        try {
          return statFn(join(versionedDir, n)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch (err) {
    return {
      error: `versioned directory '${versionedDir}' not found or unreadable: ${err.message}`,
    };
  }
  const entries = names.map((name) => ({
    name,
    versionedPath: join(versionedDir, name),
    installedPath: join(installedDir, name),
    versioned: readSide(join(versionedDir, name), existsFn, readFileFn),
    installed: readSide(join(installedDir, name), existsFn, readFileFn),
  }));
  return { entries };
}

// --install: copies every DRIFT entry's versioned content over its installed
// path (creating installedDir if needed), best-effort preserving the exec
// permission bit. LIMITATION: chmod has no effect on Windows filesystems --
// documented here rather than silently pretending it always works.
//
// P2b fix (HYK-196 2R, review C5): a write/mkdir failure (permission denied,
// disk full, read-only installedDir, ...) here used to propagate as an
// unhandled exception, crashing the whole CLI instead of the documented
// "always a {verdict, mismatches, ...} JSON" contract. It is now caught and
// surfaced as `{ error }` so the caller can report it the same honest way
// every other unreadable/unresolvable condition in this device is reported:
// UNDECIDABLE, exit 1, still valid JSON -- never a silent 0, never a crash.
function installDrifted(entries, { statFn }) {
  for (const entry of entries) {
    const judged = judgeHookFile(entry);
    if (judged.status !== "DRIFT") continue;
    try {
      mkdirSync(join(entry.installedPath, ".."), { recursive: true });
      writeFileSync(entry.installedPath, entry.versioned.content);
    } catch (err) {
      return {
        error: `failed to install '${entry.name}' to '${entry.installedPath}': ${err.message}`,
      };
    }
    try {
      const mode = statFn(entry.versionedPath).mode;
      chmodSync(entry.installedPath, mode);
    } catch {
      // best-effort only -- exec bit has no meaning on Windows filesystems.
    }
  }
  return {};
}

function printText(judged, { resolvedInstalledDir, source }) {
  console.log(
    `hook-sync-check: verdict=${judged.verdict} installedDir=${resolvedInstalledDir} source=${source}`,
  );
  for (const r of judged.results) {
    console.log(`  ${r.status.padEnd(12)} ${r.name} -- ${r.reason}`);
  }
}

function parseArgs(argv) {
  const opts = { install: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--versioned-dir") opts.versionedDir = argv[++i];
    else if (argv[i] === "--installed-dir") opts.installedDir = argv[++i];
    else if (argv[i] === "--install") opts.install = true;
    else if (argv[i] === "--json") opts.json = true;
  }
  return opts;
}

// --install re-verify step, extracted from runHookSyncCheck to keep that
// function's own complexity under the repo's ESLint ceiling -- same
// behavior, just named separately (copy drifted files, then re-judge from a
// fresh read so a failure re-reading is reported honestly as UNDECIDABLE
// rather than assumed fixed).
function installAndReverify({
  entries,
  versionedDir,
  installedDir,
  existsFn,
  readFileFn,
  readdirFn,
  statFn,
}) {
  const installResult = installDrifted(entries, { statFn });
  if (installResult.error) {
    return {
      verdict: "UNDECIDABLE",
      mismatches: [],
      results: [],
      reason: installResult.error,
    };
  }
  const reread = buildEntries({
    versionedDir,
    installedDir,
    existsFn,
    readFileFn,
    readdirFn,
    statFn,
  });
  return reread.error
    ? {
        verdict: "UNDECIDABLE",
        mismatches: [],
        results: [],
        reason: reread.error,
      }
    : judgeHookSync(reread.entries);
}

// Normalizes the injectable filesystem ports to their real-fs defaults --
// split out of runHookSyncCheck purely to keep that function's own
// complexity under the repo's ESLint ceiling (each default value is its own
// branch under the `complexity` rule); no behavior change.
function normalizeFsPorts({
  existsFn = existsSync,
  readFileFn = (p) => readFileSync(p),
  readdirFn = readdirSync,
  statFn = statSync,
} = {}) {
  return { existsFn, readFileFn, readdirFn, statFn };
}

export function runHookSyncCheck(opts) {
  const {
    versionedDirOption,
    installedDirOption,
    install = false,
    cwd = process.cwd(),
    root,
  } = opts;
  const { existsFn, readFileFn, readdirFn, statFn } = normalizeFsPorts(opts);
  // repoRoot() shells out to git -- only needed when no explicit
  // --versioned-dir is given, so a caller working outside a git repo (e.g.
  // the CLI test's synthetic --installed-dir-only scenario) never pays for
  // or crashes on a git call it doesn't need.
  const resolvedRoot = root ?? (versionedDirOption ? null : repoRoot(cwd));
  const versionedDir = resolveVersionedDir({
    versionedDirOption,
    root: resolvedRoot,
  });
  const installedResolution = resolveInstalledDir({ installedDirOption, cwd });
  if (!installedResolution.dir) {
    return {
      verdict: "UNDECIDABLE",
      mismatches: [],
      resolvedInstalledDir: null,
      source: null,
      results: [],
      reason: installedResolution.error,
    };
  }
  const built = buildEntries({
    versionedDir,
    installedDir: installedResolution.dir,
    existsFn,
    readFileFn,
    readdirFn,
    statFn,
  });
  if (built.error) {
    return {
      verdict: "UNDECIDABLE",
      mismatches: [],
      resolvedInstalledDir: installedResolution.dir,
      source: installedResolution.source,
      results: [],
      reason: built.error,
    };
  }
  let judged = judgeHookSync(built.entries);
  if (install && judged.verdict === "DRIFT") {
    judged = installAndReverify({
      entries: built.entries,
      versionedDir,
      installedDir: installedResolution.dir,
      existsFn,
      readFileFn,
      readdirFn,
      statFn,
    });
  }
  return {
    ...judged,
    resolvedInstalledDir: installedResolution.dir,
    source: installedResolution.source,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/hook-sync-check.mjs");
if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  const result = runHookSyncCheck({
    versionedDirOption: opts.versionedDir,
    installedDirOption: opts.installedDir,
    install: opts.install,
  });
  if (opts.json) {
    console.log(
      JSON.stringify({
        verdict: result.verdict,
        mismatches: result.mismatches,
        resolvedInstalledDir: result.resolvedInstalledDir,
        source: result.source,
      }),
    );
  } else {
    printText(result, result);
  }
  process.exit(
    result.verdict === "IN_SYNC" ? 0 : result.verdict === "DRIFT" ? 2 : 1,
  );
}
