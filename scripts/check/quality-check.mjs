import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync, execFileSync } from "node:child_process";

// Extensions this gate actually inspects. Lint (ESLint) only understands
// ESM .mjs (the only JS flavor this repo has -- no .js/.cjs/.ts exist
// outside node_modules). Format (Prettier) additionally covers .js/.json/.md
// since those exist and Prettier can format all of them.
const LINT_EXT_RE = /\.mjs$/;
const FMT_EXT_RE = /\.(mjs|js|json|md)$/;

// A push event's `before` SHA is all zeros on the very first push of a new
// branch (no prior commit to diff against) -- GitHub's documented sentinel
// for "there is no base," not a real SHA. Treating it as usable would
// silently diff against a nonexistent commit; treating it as "no changes"
// would silently pass a first-push full-repo state. Fail-closed instead.
const NULL_SHA_RE = /^0+$/;

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

function parseNameStatus(out) {
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      // Plain add/modify: "M\tpath". Rename/copy: "R100\told\tnew" -- the
      // new path is what should be linted, so take the last field either way.
      return fields[fields.length - 1];
    });
}

// Resolves the set of changed files this gate must inspect. `mode: "ci"`
// diffs a required, externally-supplied base SHA against HEAD (the base is
// never inferred locally -- CI must inject it, see enforce.yml). `mode:
// "staged"` diffs the index against HEAD (the local pre-commit path).
// `--diff-filter=ACMR` deliberately excludes deletions: a deleted file has
// nothing left to lint, and D-only "changes" must not count toward scope.
export function resolveChangedFiles({ cwd, mode, baseSha, gitDiff } = {}) {
  const diff =
    gitDiff ??
    ((args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim());

  if (mode === "ci") {
    if (!baseSha || NULL_SHA_RE.test(baseSha)) {
      return {
        ok: false,
        reason:
          `quality-check: CI base SHA missing or null (got ${JSON.stringify(baseSha)}) -- ` +
          `fail-closed. A misconfigured workflow must not silently pass by treating ` +
          `"no base" as "no changes."`,
      };
    }
    try {
      const out = diff([
        "diff",
        "--name-status",
        "--diff-filter=ACMR",
        `${baseSha}...HEAD`,
      ]);
      return { ok: true, files: parseNameStatus(out) };
    } catch (err) {
      return {
        ok: false,
        reason: `quality-check: git diff against base SHA ${baseSha} failed -- fail-closed (${err.message})`,
      };
    }
  }

  if (mode === "staged") {
    try {
      const out = diff([
        "diff",
        "--cached",
        "--name-status",
        "--diff-filter=ACMR",
      ]);
      return { ok: true, files: parseNameStatus(out) };
    } catch (err) {
      return {
        ok: false,
        reason: `quality-check: git diff --cached failed -- fail-closed (${err.message})`,
      };
    }
  }

  return {
    ok: false,
    reason: `quality-check: unknown mode ${JSON.stringify(mode)} (expected "staged" or "ci")`,
  };
}

function defaultRunTool(tool, args, cwd) {
  const binPath =
    tool === "eslint"
      ? join(cwd, "node_modules", "eslint", "bin", "eslint.js")
      : join(cwd, "node_modules", "prettier", "bin", "prettier.cjs");
  try {
    const output = execFileSync(process.execPath, [binPath, ...args], {
      cwd,
      encoding: "utf8",
    });
    return { exitCode: 0, output };
  } catch (err) {
    return {
      exitCode: typeof err.status === "number" ? err.status : 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

// The gate itself: changed-files-only lint + format check ("축소안" /
// changed-files-green ratchet, HYK-148 coder-2 measurement -> coder-3
// wiring). Files untouched by the change under test are never inspected --
// that is the intended amnesty for this repo's pre-existing violations
// (coder-2 baseline: 41 lint errors, 78/113 unformatted files). Only files
// that appear in the changed set are held to a zero-violation bar.
export function runQualityCheck({
  cwd,
  mode,
  baseSha,
  runTool = defaultRunTool,
  gitDiff,
} = {}) {
  const changed = resolveChangedFiles({ cwd, mode, baseSha, gitDiff });
  if (!changed.ok) return changed;

  const existing = changed.files.filter((f) => existsSync(join(cwd, f)));
  const lintTargets = existing.filter((f) => LINT_EXT_RE.test(f));
  const fmtTargets = existing.filter((f) => FMT_EXT_RE.test(f));

  if (lintTargets.length === 0 && fmtTargets.length === 0) {
    return {
      ok: true,
      scope: "empty",
      reason:
        "quality-check: no changed files in scope (.mjs/.js/.json/.md) -- vacuously green",
    };
  }

  const results = [];
  if (lintTargets.length > 0) {
    results.push({
      tool: "eslint",
      targets: lintTargets,
      ...runTool("eslint", lintTargets, cwd),
    });
  }
  if (fmtTargets.length > 0) {
    results.push({
      tool: "prettier",
      targets: fmtTargets,
      ...runTool("prettier", ["--check", ...fmtTargets], cwd),
    });
  }

  const failed = results.filter((r) => r.exitCode !== 0);
  if (failed.length > 0) {
    return {
      ok: false,
      reason:
        `quality-check: ${failed.map((f) => f.tool).join(", ")} failed on changed file(s) -- ` +
        failed.map((f) => `[${f.tool}] ${f.output}`.trim()).join(" | "),
    };
  }

  return {
    ok: true,
    scope: "checked",
    reason: `quality-check: ${lintTargets.length} file(s) linted, ${fmtTargets.length} file(s) format-checked -- all clean`,
  };
}

// Flags this CLI actually understands. An unrecognized flag (a typo such as
// `--base` for `--base-sha`) must abort loudly rather than being silently
// dropped -- a dropped `--base-sha` falls back to `mode: "staged"`'s
// default, which diffs the index against HEAD and is empty outside a
// pre-commit context, so the run prints a vacuous green instead of the
// intended CI-mode result (HYK-270 1R, 2026-08-29: this exact typo produced
// a "quality clean" both the author and reviewer accepted at face value).
const KNOWN_FLAGS = new Set(["--mode", "--base-sha", "--cwd"]);

// Value-acceptance contract for the three flags above, all of which take a
// value. HYK-393 2R closed the *name* axis (an unrecognized flag) and part
// of the *value* axis (EOF, empty string, a value starting with "--"), but
// REVIEW 2R found the value axis was still closed by ENUMERATING rejected
// shapes rather than by a rule -- and enumeration missed whitespace-only
// values (`--base-sha "   "`) and a bare single dash (`--base-sha -`),
// both of which fell through to mode:"staged"'s default and printed an
// empty-scope green (1R's P1 shape, twice more).
//
// HYK-393 3R replaces the enumeration with a total, two-predicate
// PARTITION of every possible argv token, so "did I miss a case" stops
// being a question the reader has to trust and becomes something they can
// verify by case analysis instead of by trusting a sample list:
//
//   A token position is exactly one of:
//     (0) ABSENT           -- there is no next token at all (EOF)
//   ...and if a token IS present, its content is exactly one of:
//     (1) ALL WHITESPACE   -- `token.trim() === ""` (this includes the
//         empty string "" itself, since trim("") === "")
//     (2) DASH-LEADING     -- `token.trim()` starts with "-" (covers a
//         bare "-", "--", "-x", "--mode", "--anything" -- one or two
//         leading dashes are the ONLY way a token can look like a flag
//         rather than a value, so this single check subsumes both "looks
//         like a known flag" and "looks like an unknown flag")
//     (3) EVERYTHING ELSE  -- accepted as the value
//
// This is a proof by exhaustive case split on the FIRST non-whitespace
// character of the token (or its absence), not a list of specific bad
// inputs -- cases (1)+(2)+(3) cover 100% of the string domain by
// construction, so there is no "case we forgot to enumerate" the way
// "reject these seven specific strings" always leaves one open. A git SHA,
// a mode name ("ci"/"staged"), and a real directory path are never
// whitespace-only and never start with "-" in ordinary use, so nothing
// legitimate is expected to fall into (1) or (2) -- see this round's
// coder.md §5 for the one acknowledged cost (a --cwd path that itself
// starts with "-" is unsupported; this is not new in 3R, 2R already made
// the same call for "--"-leading paths and REVIEW 2R accepted it as P2).
function readFlagValue(args, i, flag) {
  const raw = args[i + 1];
  if (raw === undefined) {
    return {
      ok: false,
      reason: `quality-check: ${flag} requires a value but none was given (end of arguments) -- fail-closed rather than falling back to a default.`,
    };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      ok: false,
      reason: `quality-check: ${flag} was given an empty or whitespace-only value (${JSON.stringify(raw)}) -- fail-closed rather than falling back to a default.`,
    };
  }
  if (trimmed.startsWith("-")) {
    return {
      ok: false,
      reason: `quality-check: ${flag}'s value ${JSON.stringify(raw)} looks like a flag, not a value (it was likely swallowed from the next argument) -- fail-closed rather than silently consuming it.`,
    };
  }
  return { ok: true, value: raw };
}

export function parseCliArgs(args) {
  let mode = "staged";
  // QUALITY_BASE_SHA is read unconditionally here, but resolveChangedFiles's
  // "staged" branch (mode's default, and the only mode `npm run
  // quality:check` -- no args -- ever runs in) never reads `baseSha` at
  // all; the env var only has any effect when `--mode ci` is also given.
  // Setting QUALITY_BASE_SHA before a bare `npm run quality:check` does NOT
  // make it behave like a CI run (HYK-393 2R correction of the 1R result
  // file, which described this as "used instead of --base-sha").
  let baseSha = process.env.QUALITY_BASE_SHA;
  let cwd = repoRoot();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!KNOWN_FLAGS.has(flag)) {
      return {
        ok: false,
        reason:
          `quality-check: unrecognized argument ${JSON.stringify(flag)} -- ` +
          `known flags are ${[...KNOWN_FLAGS].join(", ")}. Refusing to run ` +
          `with an unknown flag rather than silently falling back to defaults.`,
      };
    }
    const read = readFlagValue(args, i, flag);
    if (!read.ok) return read;
    if (flag === "--mode") mode = read.value;
    else if (flag === "--base-sha") baseSha = read.value;
    else if (flag === "--cwd") cwd = read.value;
    i++;
  }
  return { ok: true, mode, baseSha, cwd };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/quality-check.mjs");
if (invokedDirectly) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.reason);
    process.exit(1);
  }
  const { mode, baseSha, cwd } = parsed;
  const result = runQualityCheck({ cwd, mode, baseSha });
  if (result.ok) {
    // `scope: "empty"` (no files in the changed set were in-scope) and
    // `scope: "checked"` (files were actually run through eslint/prettier)
    // are both a green exit code -- CI must not turn an empty diff (e.g. a
    // docs-only or out-of-scope-extension change) into a failure -- but the
    // two are tagged distinctly on stdout so a log reader (human or script)
    // can tell "nothing to check" apart from "checked and clean" without
    // parsing prose.
    console.log(`[quality-check:${result.scope}] ${result.reason}`);
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
