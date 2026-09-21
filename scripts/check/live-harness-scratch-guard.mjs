// live-harness-scratch-guard: blocks a test file from building its scratch
// root as `join(<repo-root-derived identifier>, ".harness", ...)`.
//
// Motivation (HYK-394-test-leak-3, 2026-08-30 실사고): three test files
// (scripts/relay/hyk387-watch-result-default-wiring.test.mjs,
// scripts/check/hyk387-3r-receipt-pointer.test.mjs,
// scripts/check/hyk387-dispatch-record-required.test.mjs) each derived a
// "repo root" via `dirname(dirname(fileURLToPath(import.meta.url)))` and
// then built their mkdtemp scratch root as `join(REPO_ROOT, ".harness",
// "<name>-scratch")` -- deliberately reasoned (a real prior incident: a
// scratch dir directly under the repo root confused OTHER tests'
// `git status --porcelain` snapshot assertions, since `.harness/` is fully
// gitignored and everything else isn't). But sharing that directory TREE
// with the live, checked-out worktree's own `.harness/` (where ORCH's real
// round files, receipts, and archives live) meant this repo's own real
// review results and receipts were actually lost tonight when these tests
// ran directly against the live checkout (not through the isolated-clone
// runner). `os.tmpdir()` solves both problems at once (outside the repo
// entirely, so git status never sees it either) -- see any of the three
// fixed files' own headers for the full before/after.
//
// What this PROVES: for every changed `*.test.mjs`/`*.mjs` file, no
// `join(...)` call combines a "repo root" identifier (one assigned via
// `dirname(dirname(...))`, this repo's own idiom for
// `dirname(dirname(fileURLToPath(import.meta.url)))`) with the literal
// string `.harness` as an argument. Calibrated against the current
// tree (2026-08-30): 42 files reference the `.harness` string literal
// (near-universally as `join(<isolated-mkdtemp-dir>, ".harness", ...)`,
// a completely safe, common fixture-shape idiom), but only the three
// incident files combined it with a repo-root-derived identifier in the
// SAME join() call -- this narrow shape has zero measured false positives
// today (see this file's own test for the exact calibration evidence).
//
// What this DOES NOT prove (deliberately narrow, HYK-394-test-leak-3 §2 Q2
// "무거우면 만들지 마라" -- a general "does this path resolve under the
// live worktree" check needs real data-flow analysis across arbitrary
// variable indirection/string concatenation/imported helpers, which this
// text-pattern gate does not attempt):
//   - A repo-root identifier under a DIFFERENT name than what
//     `dirname(dirname(...))` directly produces (e.g. reassigned through an
//     intermediate variable, or imported from a shared helper module) is
//     not traced -- only the direct `dirname(dirname(...))` binding site
//     is recognized.
//   - String concatenation (`repoRoot + "/.harness/" + name`) or template
//     literals are not detected -- only `join(...)` call arguments are
//     inspected.
//   - A DIFFERENT dangerous root (e.g. a hardcoded absolute path to some
//     other live checkout) is out of scope entirely -- this gate is
//     specifically the shape of the 2026-08-30 incident, not a general
//     "test writes outside its own isolation" detector.
//   - Only the CHANGED set (per resolveChangedFiles) is inspected -- this
//     exact pattern already sitting in an untouched, pre-existing tracked
//     file is never re-scanned by this gate alone (mitigated once: this
//     round's own quality-check --mode ci run over the full HYK-394 diff
//     found zero remaining occurrences repo-wide, see this round's coder.md).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { resolveChangedFiles } from "./quality-check.mjs";

const TARGET_EXT_RE = /\.(mjs|js)$/;

// HYK-394-guard-self-4 §2 Q1 (검토자 rejected 판정, 2026-08-30): 이 가드
// 자신의 소스·시험 파일은 스캔 대상에서 제외한다 -- 이 파일의 헤더
// 예시(위 "What this PROVES" 문단)와 이 가드 자신의 시험(live-harness-
// scratch-guard.test.mjs, 시험 ⓐ)이 "합성 위반 문자열"을 리터럴로 담고
// 있어야 하는데(진짜 실행 코드가 아니라 검증용 텍스트), CI 형태로
// 스캔하면 이 가드 자신이 그 리터럴을 "진짜 위반"으로 오인해 exit 1을
// 낸다(2026-08-30 실측: `node scripts/check/live-harness-scratch-guard.mjs
// --mode ci --base-sha 6634c2862ec3` -> exit 1, live-harness-scratch-
// guard.test.mjs:26 신고). ⛔정확히 이 두 파일의 «절대·전체» 상대경로
// 문자열만 제외한다(예: "가드"라는 이름이 들어간 파일이면 무조건 제외
// 같은 넓은 규칙이 아니다) -- 그렇게 넓히면 미래의 «진짜» 라이브 쓰기
// 누수를 이 파일들과 이름이 비슷하다는 이유로 숨길 수 있다(이 라운드
// 자신의 시험 "과잉 제외 방지" 축이 정확히 이 위험을 시험으로 고정한다,
// live-harness-scratch-guard.test.mjs 참조).
const SELF_EXCLUDED_FILES = new Set([
  "scripts/check/live-harness-scratch-guard.mjs",
  "scripts/check/live-harness-scratch-guard.test.mjs",
]);

// Repo-root derivation idiom this codebase uses everywhere:
// `const X = dirname(dirname(<anything>))` (usually
// `dirname(dirname(fileURLToPath(import.meta.url)))` or
// `dirname(dirname(HERE))`). Captures the bound identifier name.
const REPO_ROOT_BINDING_RE =
  /\b(?:const|let)\s+(\w+)\s*=\s*dirname\(\s*dirname\(/g;

function findRepoRootIdentifiers(source) {
  const names = new Set();
  for (const m of source.matchAll(REPO_ROOT_BINDING_RE)) {
    names.add(m[1]);
  }
  return names;
}

// For each repo-root identifier, look for `join(<ws>IDENT<ws>,<ws>"..harness"`
// or `resolve(<ws>IDENT<ws>,<ws>"..harness"` (single or double quotes,
// case-insensitive on the literal) anywhere later in the file. Deliberately
// simple (no full parenthesis-balance tracking) -- see file header for
// scope. HYK-394-guard-wire-1 §2⓶ widened this twice from the original
// join()-only, exact-case match after measuring two accidental-shape
// bypasses: ⓐ a case-differing literal (".Harness") still resolves to the
// same live directory on this repo's case-insensitive filesystems (Windows/
// macOS default) but slipped past a case-sensitive match; ⓒ `resolve(...)`
// is a drop-in substitute for `join(...)` a contributor could reach for
// without any intent to evade the gate, and produces the identical
// filesystem effect. Both widenings stay inside the same narrow shape (an
// already-repo-root-bound identifier + the literal ".harness" as an
// argument to a path-building call) -- this does not attempt general
// data-flow analysis, see the file header's "What this DOES NOT prove".
function findViolations(source) {
  const idents = findRepoRootIdentifiers(source);
  const violations = [];
  for (const ident of idents) {
    const re = new RegExp(
      `(?:join|resolve)\\(\\s*${ident}\\s*,\\s*["']\\.harness["']`,
      "i",
    );
    const m = source.match(re);
    if (m) {
      const line = source.slice(0, m.index).split("\n").length;
      violations.push({ identifier: ident, line, snippet: m[0] });
    }
  }
  return violations;
}

function defaultReadFileText(cwd, file) {
  return readFileSync(join(cwd, file), "utf8");
}

function defaultReadBlobText({ cwd, file, mode }) {
  const ref = mode === "ci" ? `HEAD:${file}` : `:${file}`;
  return execFileSync("git", ["cat-file", "blob", ref], {
    cwd,
    encoding: "utf8",
  });
}

export function runLiveHarnessScratchGuard({
  cwd,
  mode,
  baseSha,
  files,
  gitDiff,
  readFileText = defaultReadFileText,
  readBlobText = defaultReadBlobText,
} = {}) {
  let targets;
  let readText;
  if (files) {
    targets = files;
    readText = (file) => readFileText(cwd, file);
  } else {
    const changed = resolveChangedFiles({ cwd, mode, baseSha, gitDiff });
    if (!changed.ok) return changed;
    targets = changed.files;
    readText = (file) => readBlobText({ cwd, file, mode });
  }

  const scanned = targets.filter(
    (f) => TARGET_EXT_RE.test(f) && !SELF_EXCLUDED_FILES.has(f),
  );
  const allViolations = [];

  for (const file of scanned) {
    let text;
    try {
      text = readText(file);
    } catch (err) {
      return {
        ok: false,
        reason: `live-harness-scratch-guard: failed to read ${file} -- fail-closed (${err.message})`,
        violations: [],
      };
    }
    for (const v of findViolations(text)) {
      allViolations.push({ file, ...v });
    }
  }

  if (allViolations.length > 0) {
    return {
      ok: false,
      reason:
        `live-harness-scratch-guard: ${allViolations.length} live-worktree-.harness-scratch pattern(s) found -- ` +
        allViolations
          .map(
            (v) =>
              `${v.file}:${v.line} (join(${v.identifier}, ".harness"...) -- use os.tmpdir() instead, HYK-394-test-leak-3)`,
          )
          .join(", "),
      violations: allViolations,
    };
  }

  return {
    ok: true,
    reason: `live-harness-scratch-guard: ${scanned.length} file(s) scanned -- no live-.harness-scratch pattern found`,
    violations: [],
  };
}

// Recursively lists every .mjs/.js file under `dir` (used only by this
// file's own calibration test, not by the CI/staged entry points above,
// which always work off `resolveChangedFiles`).
export function listAllScriptFiles(dir, relBase = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".git") continue;
      out.push(...listAllScriptFiles(abs, relBase));
    } else if (TARGET_EXT_RE.test(entry)) {
      out.push(abs.slice(relBase.length + 1).replace(/\\/g, "/"));
    }
  }
  return out;
}

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/live-harness-scratch-guard.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let mode = "staged";
  let baseSha = process.env.QUALITY_BASE_SHA;
  let cwd = repoRoot();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") mode = args[++i];
    else if (args[i] === "--base-sha") baseSha = args[++i];
    else if (args[i] === "--cwd") cwd = args[++i];
  }
  const result = runLiveHarnessScratchGuard({ cwd, mode, baseSha });
  if (result.ok) {
    console.log(result.reason);
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
