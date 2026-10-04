// pathname-filepath-guard: blocks `new URL(...).pathname` (or any `.pathname`
// chained directly onto a `new URL(...)` expression) from being used as a
// filesystem path. Motivation (HYK-304 P2-1): `.pathname` leaves percent-
// encoding in place, so a worktree under a Korean-named directory resolves to
// `%EB%AA%A8...` and the spawn/read fails. PR #13 fixed that with a thin
// wrapper (`fileURLToPath`), but a call site reverted to the old shape would
// still pass every runtime test -- the wrapper is exercised directly by the
// regression test, not through the reverted call site (reviewer mutation M3).
// On POSIX `fileURLToPath` is equivalent to `decodeURIComponent(pathname)`,
// so the Linux CI also cannot tell the two shapes apart at runtime. This
// static scan is therefore the only CI-side anchor for that drift.
//
// What this PROVES: for every .mjs/.js/.cjs file under scripts/, test/ and
// src/, a `new URL(...)` expression whose result is chained to `.pathname` is
// reported when that value flows into one of two places:
//   (a) an assignment to an identifier shaped `*Path` or `*_PATH`
//   (b) a DIRECT argument of execFileSync / execFile / spawn / spawnSync /
//       readFileSync / writeFileSync / existsSync / import() / path.join /
//       path.resolve
// A chain whose direct call is fileURLToPath(...) is accepted (that call is
// not a path callee). An assignment written INSIDE a fileURLToPath(...)
// argument list is still reported (HYK-304 P2-1: the old exemption hid it).
// src/ is in scope because dev-server.mjs there is a Node script, not a
// browser file (HYK-304 P2-2).
//
// What this DOES NOT prove (see the "정직 한계" entries in the round report):
//   - One-hop flows are missed on purpose: `const p = new URL(...).pathname;
//     execFileSync(node, [p]);` is not reported. Widening to catch it would
//     also match legitimate `readFileSync(new URL(...))` call sites.
//   - Shape (a) is a name heuristic: a `*Path` variable that is not a
//     filesystem path is a future false positive, and a filesystem path held
//     in a non-`*Path` name is a miss.
//   - Comments and string/regex literal contents are masked out before the
//     scan, so mentions of the pattern in them are never reported.
//   - Only the CI step in .github/workflows/enforce.yml runs this; it is not
//     wired into hooks/pre-commit, so an uncommitted violation is not caught
//     until CI.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Allowlist of accepted violations. Each entry is { file, line, reason }:
// `file` is the repo-relative path with "/" separators, `line` the 1-indexed
// line of the `new URL` expression, and `reason` one sentence saying why the
// flow is acceptable. An entry with no matching violation is an error (stale
// allowlist entries would silently widen the gate).
export const ALLOWLIST = [];

const SCAN_DIRS = ["scripts", "test", "src"];
const SCAN_EXT_RE = /\.(mjs|js|cjs)$/;
const FS_CALLEES = new Set([
  "execFileSync",
  "execFile",
  "spawn",
  "spawnSync",
  "readFileSync",
  "writeFileSync",
  "existsSync",
]);
const PATH_CALLEES = new Set(["import", "path.join", "path.resolve"]);

const NEW_URL_RE = /\bnew\s+URL\s*\(/g;
const CHAIN_PATHNAME_RE = /^\s*\.\s*pathname\b/;
const ASSIGN_TARGET_RE = /([A-Za-z_$][\w$]*)\s*[=:]\s*$/;
const PATH_NAME_RE = /(Path|_PATH)$/;
const CALLEE_TAIL_RE = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/;

// Regex literals may start after these characters (or at the start of input).
// After an identifier or a closing bracket, "/" is division, not a regex.
const REGEX_PREFIX_RE = /[(,=:[!&|?{};+\-*%<>~^]/;

function skipString(src, start, quote) {
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    // A quoted string cannot span lines; a template literal can.
    if (quote !== "`" && ch === "\n") return i;
    i++;
  }
  return src.length;
}

function skipRegex(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\n") return -1;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "/") {
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      return i;
    }
    i++;
  }
  return -1;
}

// End index of a comment starting at `i`, or -1 when none starts there.
function skipCommentAt(src, i) {
  if (src[i] !== "/") return -1;
  if (src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl === -1 ? src.length : nl;
  }
  if (src[i + 1] === "*") {
    const close = src.indexOf("*/", i + 2);
    return close === -1 ? src.length : close + 2;
  }
  return -1;
}

// End index of a string / template / regex literal starting at `i`, or -1.
function skipLiteralAt(src, i, lastSig) {
  const ch = src[i];
  if (ch === '"' || ch === "'" || ch === "`") return skipString(src, i, ch);
  if (ch === "/" && (lastSig === "" || REGEX_PREFIX_RE.test(lastSig))) {
    return skipRegex(src, i);
  }
  return -1;
}

// Return a same-length copy of `src` where comment bodies and the contents
// of string / template / regex literals are replaced by spaces (newlines kept
// so line numbers survive). Code tokens are left untouched.
export function maskNonCode(src) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  let lastSig = "";
  while (i < src.length) {
    const ch = src[i];
    const commentEnd = skipCommentAt(src, i);
    if (commentEnd !== -1) {
      blank(i, commentEnd);
      i = commentEnd;
      continue;
    }
    const literalEnd = skipLiteralAt(src, i, lastSig);
    if (literalEnd !== -1) {
      blank(i + 1, literalEnd - 1);
      lastSig = ch;
      i = literalEnd;
      continue;
    }
    if (!/\s/.test(ch)) lastSig = ch;
    i++;
  }
  return out.join("");
}

// Index of the "(" that directly encloses position `from` in masked code, or
// -1 when `from` is not inside a call's argument list at this level (e.g. it
// sits inside an array or object literal, or at statement level).
function enclosingOpenParen(masked, from) {
  let depth = 0;
  for (let k = from - 1; k >= 0; k--) {
    const ch = masked[k];
    if (ch === ")" || ch === "]" || ch === "}") {
      depth++;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) return ch === "(" ? k : -1;
      depth--;
    } else if (ch === ";" && depth === 0) {
      return -1;
    }
  }
  return -1;
}

function matchingCloseParen(masked, openIndex) {
  let depth = 0;
  for (let k = openIndex; k < masked.length; k++) {
    const ch = masked[k];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

// Name of the call whose argument list directly contains `from`, or null.
function directCalleeOf(masked, from) {
  const open = enclosingOpenParen(masked, from);
  if (open === -1) return null;
  const head = masked.slice(0, open).replace(/\s+$/, "");
  const m = CALLEE_TAIL_RE.exec(head);
  if (!m) return null;
  return m[1].replace(/\s+/g, "");
}

function lineOf(src, index) {
  let line = 1;
  for (let k = 0; k < index; k++) if (src[k] === "\n") line++;
  return line;
}

// Decide whether a chained `new URL(...).pathname` at `exprStart` flows into a
// filesystem path. Returns { kind, callee } or null.
function classifyFlow(masked, exprStart) {
  const before = masked.slice(0, exprStart).replace(/\s+$/, "");
  const assign = ASSIGN_TARGET_RE.exec(before);
  const callee = directCalleeOf(masked, exprStart);
  if (assign && PATH_NAME_RE.test(assign[1])) {
    return { kind: "assign", callee: null };
  }
  if (
    callee &&
    (FS_CALLEES.has(callee.split(".").pop()) || PATH_CALLEES.has(callee))
  ) {
    return { kind: "arg", callee };
  }
  return null;
}

// Scan one file's source text. Returns [{ line, kind, callee, snippet }].
export function scanSource(src) {
  const masked = maskNonCode(src);
  const violations = [];
  NEW_URL_RE.lastIndex = 0;
  let m;
  while ((m = NEW_URL_RE.exec(masked)) !== null) {
    const exprStart = m.index;
    const closeParen = matchingCloseParen(masked, exprStart + m[0].length - 1);
    if (closeParen === -1) continue;
    if (!CHAIN_PATHNAME_RE.test(masked.slice(closeParen + 1))) continue;

    const flow = classifyFlow(masked, exprStart);
    if (!flow) continue;

    const line = lineOf(src, exprStart);
    violations.push({
      line,
      kind: flow.kind,
      callee: flow.callee,
      snippet: src.split("\n")[line - 1].trim(),
    });
  }
  return violations;
}

// Walk SCAN_DIRS under `root` and return repo-relative file paths.
export function listScanFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (SCAN_EXT_RE.test(name)) {
        files.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  for (const dir of SCAN_DIRS) {
    try {
      if (statSync(join(root, dir)).isDirectory()) walk(join(root, dir));
    } catch {
      // A missing scan directory simply has no files to scan.
    }
  }
  return files.sort();
}

// Check the allowlist format. Returns a list of error strings (empty = ok).
export function validateAllowlist(allowlist) {
  const errors = [];
  allowlist.forEach((entry, idx) => {
    const where = `ALLOWLIST[${idx}]`;
    if (typeof entry.file !== "string" || entry.file.length === 0) {
      errors.push(`${where}: file must be a non-empty repo-relative path`);
    }
    if (!Number.isInteger(entry.line) || entry.line < 1) {
      errors.push(`${where}: line must be a positive integer`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      errors.push(`${where}: reason must be a non-empty sentence`);
    }
  });
  return errors;
}

// Scan the whole repo under `root`. Returns { files, violations, stale,
// formatErrors } where `violations` are the unallowed hits and `stale` are
// allowlist entries that matched nothing.
export function scanRepo(root, allowlist = ALLOWLIST) {
  const formatErrors = validateAllowlist(allowlist);
  const files = listScanFiles(root);
  const hits = [];
  for (const file of files) {
    const src = readFileSync(join(root, file), "utf8");
    for (const v of scanSource(src)) hits.push({ file, ...v });
  }
  const used = new Set();
  const violations = [];
  for (const hit of hits) {
    const idx = allowlist.findIndex(
      (e) => e.file === hit.file && e.line === hit.line,
    );
    if (idx === -1) violations.push(hit);
    else used.add(idx);
  }
  const stale = allowlist.filter((_, idx) => !used.has(idx));
  return { files, violations, stale, formatErrors };
}

function main(argv) {
  const rootIdx = argv.indexOf("--root");
  const root =
    rootIdx !== -1
      ? argv[rootIdx + 1]
      : fileURLToPath(new URL("../../", import.meta.url));
  const result = scanRepo(root);
  const tag = "[pathname-filepath-guard]";
  for (const err of result.formatErrors)
    console.error(`${tag} ALLOWLIST FORMAT: ${err}`);
  for (const v of result.violations) {
    console.error(
      `${tag} FAIL ${v.file}:${v.line} (${v.kind}${v.callee ? " " + v.callee : ""}) ${v.snippet}`,
    );
  }
  for (const s of result.stale) {
    console.error(
      `${tag} STALE ALLOWLIST ${s.file}:${s.line} matches no violation`,
    );
  }
  const failed =
    result.formatErrors.length > 0 ||
    result.violations.length > 0 ||
    result.stale.length > 0;
  if (failed) {
    console.error(`${tag} FAILED (${result.violations.length} violation(s))`);
    process.exit(1);
  }
  console.log(
    `${tag} OK scanned ${result.files.length} file(s), 0 violation(s), ${ALLOWLIST.length} allowlisted`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
