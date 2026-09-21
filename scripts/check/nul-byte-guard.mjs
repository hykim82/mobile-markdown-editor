// nul-byte-guard: blocks committing a file whose bytes contain a raw NUL
// (0x00). Motivation (HYK-183 NC-3 incident): a source file with 5 raw NUL
// bytes made `git diff --numstat` report it as binary ("-\t-"), which means
// a PR review renders it as "Binary file changed" with no visible diff --
// the reviewer cannot see what they are approving. eslint, prettier, node
// parsing, and quality-check.mjs all passed on that file; none of them read
// raw bytes for NUL, so none of them caught it. This gate is the first one
// that does.
//
// What this PROVES: for every changed file whose extension is in the
// allowlist below (or an extensionless file under hooks/), the AUTHORITATIVE
// bytes for that mode contain zero 0x00 bytes. "Authoritative" differs by
// entry point (HYK-183 2R fix -- REVIEW P1: an earlier version read working-
// tree bytes for `mode: "staged"`, which could diverge from what actually
// gets committed if the working tree changed after staging):
//   - `mode: "staged"`  -> the INDEX blob (`git cat-file blob :<path>`),
//     i.e. exactly what `git commit` would write. This is what the local
//     pre-commit hook uses.
//   - `mode: "ci"`      -> the HEAD blob (`git cat-file blob HEAD:<path>`),
//     i.e. exactly what was actually committed. This is what the CI step
//     uses, and it stays correct even if run locally against a dirty
//     working tree.
//   - `files` (direct list, used by the false-positive-denominator
//     measurement and by tests) -> the WORKING-TREE filesystem bytes
//     (`readFileSync`). There is no git ref to resolve against for an
//     arbitrary caller-supplied file list, so this entry point intentionally
//     keeps reading the filesystem directly -- it does not claim to check
//     "what would be committed."
//
// What this DOES NOT prove (see docs/enforcement-known-gaps.md for the full
// entry with evidence):
//   - Files outside the allowlist are never inspected -- a NUL byte in an
//     extension not listed here slips through untouched.
//   - Only the CHANGED set (per resolveChangedFiles) is inspected -- a NUL
//     byte already sitting in an untouched, pre-existing tracked file is
//     never re-checked.
//   - This only catches NUL bytes specifically. Other byte sequences that
//     make git classify a file as binary (e.g. certain control-byte
//     patterns) are not detected by this gate.
//   - The local hook path (hooks/pre-commit) only runs if that hook is
//     actually installed at .git/hooks/pre-commit -- an uninstalled hook
//     means this gate never runs locally at all. The CI step in
//     .github/workflows/enforce.yml is the real anchor.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { resolveChangedFiles } from "./quality-check.mjs";

// Allowlist, not denylist: this repo wants to preserve the freedom to
// commit genuine binary assets (images, etc.) without this gate rejecting
// them for "containing bytes that aren't text." Extensionless files under
// hooks/ are included because this repo's git hooks (hooks/pre-commit,
// hooks/commit-msg) have no extension and are exactly the kind of
// hand-authored shell text this gate exists to protect.
const TARGET_EXT_RE = /\.(mjs|js|cjs|json|md|yml|yaml|sh|txt|html|css)$/;

function isTargetFile(file) {
  if (TARGET_EXT_RE.test(file)) return true;
  const normalized = file.replace(/\\/g, "/");
  if (!normalized.startsWith("hooks/")) return false;
  const basename = normalized.slice("hooks/".length);
  // Extensionless AND not itself another path segment (no further "/").
  return (
    basename.length > 0 && !basename.includes("/") && !basename.includes(".")
  );
}

function defaultReadFileBytes(cwd, file) {
  return readFileSync(join(cwd, file));
}

// Default authoritative-bytes reader for the mode-resolution path (staged/
// ci). Reads the git object store, not the working tree filesystem, so the
// result matches exactly what would be (or was) committed -- see the
// header comment above for why `mode` selects a different ref.
// `execFileSync`'s default encoding is "buffer" (no `encoding` option
// passed), which is binary-safe -- required so a raw NUL byte inside the
// blob round-trips intact instead of being corrupted by a text decode.
function defaultReadBlobBytes({ cwd, file, mode }) {
  const ref = mode === "ci" ? `HEAD:${file}` : `:${file}`;
  return execFileSync("git", ["cat-file", "blob", ref], { cwd });
}

function countNulBytes(bytes) {
  let count = 0;
  let firstOffset = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x00) {
      count++;
      if (firstOffset === -1) firstOffset = i;
    }
  }
  return { count, firstOffset };
}

// Pure core: given a resolved file list (or a {cwd, mode, baseSha, gitDiff}
// resolution request), scans each target file's raw bytes for 0x00.
// `files`, when provided, is used verbatim -- no mode resolution -- and its
// bytes come from the working-tree filesystem via `readFileBytes` (see
// header comment: there is no git ref to resolve for an arbitrary caller
// list). This is the entry point the false-positive-denominator measurement
// (docs/enforcement-known-gaps.md §3-c) and the test suite use to scan an
// arbitrary file list directly. The `mode` path instead reads the
// AUTHORITATIVE committed-or-to-be-committed bytes via `readBlobBytes` (git
// index/HEAD blob, not the working tree) -- deleted files are already
// excluded by `resolveChangedFiles`'s `--diff-filter=ACMR`, so no separate
// existence filter is needed here (unlike quality-check.mjs, which reads
// the working tree and therefore does need one).
export function runNulByteGuard({
  cwd,
  mode,
  baseSha,
  files,
  gitDiff,
  readFileBytes = defaultReadFileBytes,
  readBlobBytes = defaultReadBlobBytes,
} = {}) {
  let targets;
  let readBytes;
  if (files) {
    targets = files;
    readBytes = (file) => readFileBytes(cwd, file);
  } else {
    const changed = resolveChangedFiles({ cwd, mode, baseSha, gitDiff });
    if (!changed.ok) return changed;
    targets = changed.files;
    readBytes = (file) => readBlobBytes({ cwd, file, mode });
  }

  const scanned = targets.filter(isTargetFile);
  const violations = [];

  for (const file of scanned) {
    let bytes;
    try {
      bytes = readBytes(file);
    } catch (err) {
      return {
        ok: false,
        reason: `nul-byte-guard: failed to read ${file} -- fail-closed (${err.message})`,
        violations: [],
      };
    }
    const { count, firstOffset } = countNulBytes(bytes);
    if (count > 0) {
      violations.push({ file, count, firstOffset });
    }
  }

  if (violations.length > 0) {
    return {
      ok: false,
      reason:
        `nul-byte-guard: raw NUL byte(s) found in ${violations.length} file(s) -- ` +
        violations
          .map(
            (v) => `${v.file} (count=${v.count}, firstOffset=${v.firstOffset})`,
          )
          .join(", "),
      violations,
    };
  }

  return {
    ok: true,
    reason: `nul-byte-guard: ${scanned.length} file(s) scanned -- no raw NUL bytes found`,
    violations: [],
  };
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
    .endsWith("scripts/check/nul-byte-guard.mjs");
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
  const result = runNulByteGuard({ cwd, mode, baseSha });
  if (result.ok) {
    console.log(result.reason);
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
