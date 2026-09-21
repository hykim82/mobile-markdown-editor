import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
// HYK-338 3R: the runner's REAL exported TEST_DIRS, imported statically --
// see the HYK-338 3R block above checkCiCoverage for why this is
// side-effect-free (isolated-suite-runner.mjs's own invokedDirectly
// main-guard) and why it replaced all text-based TEST_DIRS parsing.
import { TEST_DIRS as RUNNER_TEST_DIRS } from "./isolated-suite-runner.mjs";

// The five judgment values this whole module ever returns for a check's
// wiring state (design report §2, "판정 5값 고정") -- listed worst-first so
// combineStatuses below can pick the most severe one deterministically.
export const STATUS_SEVERITY = [
  "NOT_INSTALLED",
  "SILENT_BROKEN",
  "DRIFT",
  "UNJUDGABLE",
  "ALIVE",
];

const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionStart",
  "UserPromptSubmit",
];

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

// One hook-event entry's { matcher, hooks: [...] } shape -> the command
// rows it contributes. Extracted from parseHookCommands (HYK-160
// quality-check: keeps parseHookCommands' own complexity under the repo's
// ESLint ceiling; pure refactor, same rows produced either way).
function commandsFromHookEntry(hookEvent, entry) {
  const matcher = typeof entry?.matcher === "string" ? entry.matcher : null;
  const innerHooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
  return innerHooks
    .filter((h) => typeof h?.command === "string")
    .map((h) => ({ hookEvent, matcher, command: h.command }));
}

// Extracts only { hookEvent, matcher, command } from a Claude settings JSON
// object -- never the whole file, never any other field (permissions, env,
// model, statusLine, ...). This is the one place this module ever looks at
// a settings file's shape, satisfying the "JSON 전문·env 값 출력 금지"
// constraint by construction (nothing else is ever read out of it).
export function parseHookCommands(settingsJson) {
  const out = [];
  if (!settingsJson || typeof settingsJson !== "object") return out;
  const hooks = settingsJson.hooks;
  if (!hooks || typeof hooks !== "object") return out;
  for (const hookEvent of HOOK_EVENTS) {
    const entries = hooks[hookEvent];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      out.push(...commandsFromHookEntry(hookEvent, entry));
    }
  }
  return out;
}

// Normalizes a hook command string (backslash/forward-slash agnostic) and
// extracts the scripts/check/<id>.mjs id it invokes -- null if the command
// doesn't reference a check script at all (e.g. a PowerShell notification
// balloon, which is UI, not a check -- see enforcement-inventory.json's
// "전역/CODER 알림 Stop" classification).
const SCRIPT_ID_RE = /scripts[\\/]check[\\/]([A-Za-z0-9_-]+)\.mjs/;
export function extractCheckScriptId(command) {
  if (typeof command !== "string") return null;
  const normalized = command.replace(/\\/g, "/");
  const match = normalized.match(SCRIPT_ID_RE);
  return match ? match[1] : null;
}

// Whether a manifest install_target (id + hookEvent + optional matcher) is
// actually present among a settings file's parsed hook commands.
export function findInstalledTarget(hookCommands, { id, hookEvent, matcher }) {
  const candidates = hookCommands.filter(
    (h) => h.hookEvent === hookEvent && extractCheckScriptId(h.command) === id,
  );
  if (candidates.length === 0) return { installed: false };
  if (matcher) {
    const exact = candidates.find((h) => h.matcher === matcher);
    if (!exact) {
      return {
        installed: true,
        matcherMismatch: true,
        actualMatchers: candidates.map((h) => h.matcher),
      };
    }
  }
  return { installed: true, matcherMismatch: false };
}

// Every scripts/check/<id>.mjs id referenced anywhere in `hookCommands` that
// is NOT among `expectedIds` -- an invocation the manifest doesn't know
// about at all (G6's "extra" case, e.g. a hand-added hook nobody registered).
export function findExtraInvocations(hookCommands, expectedIds) {
  const expected = new Set(expectedIds);
  const found = new Set();
  for (const h of hookCommands) {
    const id = extractCheckScriptId(h.command);
    if (id && !expected.has(id)) found.add(id);
  }
  return [...found];
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Compares a versioned git hook (tracked in the repo, e.g. hooks/commit-msg)
// against its installed copy (e.g. .git/hooks/commit-msg, or core.hooksPath
// if set) by content hash -- native git hooks have no "settings.json" to
// inspect, so wiring here means "the installed file is byte-identical to
// what's versioned," not "a JSON entry points at it."
export function checkNativeGitHook({
  versionedPath,
  installedPath,
  readFileFn = (p) => readFileSync(p, "utf8"),
  existsFn = existsSync,
}) {
  if (!existsFn(versionedPath)) {
    return {
      status: "UNJUDGABLE",
      reason: `versioned hook '${versionedPath}' not found in repo -- cannot compare`,
    };
  }
  if (!existsFn(installedPath)) {
    return {
      status: "NOT_INSTALLED",
      reason: `'${installedPath}' not installed (versioned copy exists at '${versionedPath}')`,
    };
  }
  const versioned = readFileFn(versionedPath);
  const installed = readFileFn(installedPath);
  if (sha256Hex(versioned) !== sha256Hex(installed)) {
    return {
      status: "DRIFT",
      reason: `installed hook '${installedPath}' differs from versioned '${versionedPath}' (sha256 mismatch)`,
    };
  }
  return {
    status: "ALIVE",
    reason: `installed hook '${installedPath}' matches versioned copy (sha256 match)`,
  };
}

// 8 days: matches the HYK-129 design's own bootstrap-warning window (a
// canary older than this is treated the same as "never ran" -- ORCH's boot
// reminder for a missed weekly trigger uses the same threshold).
export const DEFAULT_CANARY_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

// A Claude-only check (Stop/PreToolUse/UserPromptSubmit) cannot be judged
// ALIVE from static wiring alone (G9) -- static inspection only proves a
// hook *entry* exists, never that Claude Code actually invoked it and this
// harness observed a real bad->block->good transition. That requires a
// canary receipt: a small JSON record an isolated Claude Stop-hook run (or
// equivalent) writes after actually exercising the check.
export function checkCanaryReceipt({
  id,
  canaryDir,
  now = Date.now(),
  maxAgeMs = DEFAULT_CANARY_MAX_AGE_MS,
  readFileFn = (p) => readFileSync(p, "utf8"),
  existsFn = existsSync,
}) {
  if (!canaryDir) {
    return {
      status: "UNJUDGABLE",
      reason: `no canary receipt directory given -- cannot confirm '${id}' fired under a real Claude runtime event`,
    };
  }
  const receiptPath = join(canaryDir, `${id}.json`);
  if (!existsFn(receiptPath)) {
    return {
      status: "UNJUDGABLE",
      reason: `no canary receipt at '${receiptPath}' -- Claude-only check cannot be ALIVE from static wiring alone (G9)`,
    };
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileFn(receiptPath));
  } catch (err) {
    return {
      status: "UNJUDGABLE",
      reason: `canary receipt '${receiptPath}' is not valid JSON (${err.message})`,
    };
  }
  const required = ["check_id", "checked_at", "bad_exit", "good_exit"];
  const missing = required.filter(
    (f) => receipt[f] === undefined || receipt[f] === null || receipt[f] === "",
  );
  if (missing.length) {
    return {
      status: "UNJUDGABLE",
      reason: `canary receipt '${receiptPath}' missing field(s): ${missing.join(", ")}`,
    };
  }
  if (receipt.check_id !== id) {
    return {
      status: "UNJUDGABLE",
      reason: `canary receipt at '${receiptPath}' is for check_id '${receipt.check_id}', not '${id}'`,
    };
  }
  const checkedAt = new Date(receipt.checked_at);
  if (Number.isNaN(checkedAt.getTime())) {
    return {
      status: "UNJUDGABLE",
      reason: `canary receipt '${receiptPath}' has an unparseable checked_at ('${receipt.checked_at}')`,
    };
  }
  const ageMs = now - checkedAt.getTime();
  if (ageMs > maxAgeMs) {
    return {
      status: "UNJUDGABLE",
      reason: `canary receipt '${receiptPath}' is ${Math.round(ageMs / 86400000)}d old (max ${Math.round(maxAgeMs / 86400000)}d) -- stale, re-run the canary`,
    };
  }
  return {
    status: "ALIVE",
    reason: `canary receipt fresh (checked_at=${receipt.checked_at}, bad_exit=${receipt.bad_exit}, good_exit=${receipt.good_exit})`,
  };
}

// Manifest install_target paths use a leading placeholder segment
// (REPO/... , CONTROL_ROOM/..., USER_HOME/...) instead of a real root, so
// the manifest itself never hardcodes a machine-specific path -- tests
// substitute temp directories here instead of writing to real settings files.
export function resolvePlaceholderPath(pathTemplate, roots) {
  const m = /^(REPO|CONTROL_ROOM|USER_HOME)\/(.*)$/.exec(pathTemplate);
  if (!m) return null;
  const root = roots[m[1]];
  if (!root) return null;
  return join(root, m[2]);
}

// For a check that's never installed as its own hook but is instead
// imported and called by another script's source (packet-gate.mjs, called
// from role-guard.mjs) -- "wiring" here means "the caller's source still
// references it," checked by a plain substring search over that file.
export function checkSourceReference({
  file,
  pattern,
  readFileFn = (p) => readFileSync(p, "utf8"),
  existsFn = existsSync,
}) {
  if (!existsFn(file)) {
    return {
      status: "UNJUDGABLE",
      reason: `referencing file '${file}' not found -- cannot confirm it still calls this check`,
    };
  }
  const text = readFileFn(file);
  if (!text.includes(pattern)) {
    return {
      status: "SILENT_BROKEN",
      reason: `'${file}' no longer references '${pattern}' -- caller may have stopped invoking this check`,
    };
  }
  return { status: "ALIVE", reason: `'${file}' still references '${pattern}'` };
}

// CI's whole-directory test step is `node --test scripts/check/*.test.mjs`
// (enforce.yml) -- a single glob that, when Ubuntu Bash runs it, expands to
// every current and future scripts/check/*.test.mjs on disk. HYK-129 사이클3
// replaced enforce.yml's old per-file fixed step list with exactly this,
// because a fixed list goes stale the moment a new check is added (the same
// staleness class the doc's own former "37 cases" literal had). Recognizing
// the glob here means this checker never again misjudges a glob-based
// workflow as "missing" every individual file's literal basename substring.
//
// The judgment contract is exactly one question: *would Ubuntu Bash, running
// this run command, actually execute the whole suite?* That is a Bash
// tokenization question, not a substring question -- and three prior review
// rounds (5, 6, 7) died trying to answer it by bolting ever more conditions
// onto a single regex. Each rejection was really a place where regex boundary
// tricks and real Bash word-splitting disagreed:
//   - review-5: a *partial* wildcard (`scripts/check/*check.test.mjs`,
//     `scripts/check/selfcheck*.test.mjs`) covers only a subset, never the
//     whole directory -- must not count.
//   - review-6: a trailing continuation (`scripts/check/*.test.mjs.bak`) is a
//     different pattern matching zero real test files -- must not count; and
//     an accidental prefix (`xscripts/check/...`) must not count either.
//   - review-7: quotes around the glob (`"scripts/check/*.test.mjs"`) SUPPRESS
//     expansion in Bash -- the command then looks for one literal file named
//     `*.test.mjs`, runs zero tests, and must NOT count (was a false ALIVE);
//     while a shell control operator immediately after the glob
//     (`scripts/check/*.test.mjs&&echo done`, no space) still terminates the
//     word, so the glob DOES expand and the suite DOES run -- it must count
//     (was a false DRIFT).
// Instead of a fourth regex patch, this round tokenizes the text the way Bash
// does and asks whether any word is *exactly* the whole-directory glob with
// its `*` unquoted. Every case above then falls out of that one rule rather
// than needing its own lookahead/lookbehind. (Verified against a real `sh`
// subprocess by tests 28l/28m/28n below.)
//
// LIMITATION (documented, per the harness rule "새 강제 기능엔 한계를 정직히"):
// this tokenizer treats a backslash as a path separator -- so a Windows-authored
// `scripts\check\*.test.mjs` still counts (test 28f) -- NOT as Bash's escape
// character. enforce.yml runs on ubuntu-latest where paths use `/`, so this
// only affects hypothetical backslash-in-YAML authoring, never the real CI
// command. It also does not model `$(...)`/backtick command substitution,
// brace expansion, or variable expansion inside the glob token -- none of
// which appear in a plain `node --test <glob>` step.

// The one canonical word that means "run the whole check directory."
const WHOLE_CHECK_DIR_GLOB = "scripts/check/*.test.mjs";

// Characters that terminate a Bash word whether or not surrounded by blanks:
// whitespace plus the shell metacharacters that begin a control operator or
// redirection (`&&`/`||`/`;;` all terminate on their first char, so matching
// single chars suffices). This is why `*.test.mjs&&echo` still yields a
// complete, expandable glob word (review-7 case 2).
const WORD_TERMINATORS = new Set([
  " ",
  "\t",
  "\r",
  "\n",
  ";",
  "&",
  "|",
  "<",
  ">",
  "(",
  ")",
  "`",
]);

// Splits `text` into Bash-style words. For each word we record its literal
// text (quotes removed) and whether a `*` in it was UNQUOTED -- only an
// unquoted `*` triggers pathname expansion; a `*` inside single or double
// quotes is a literal filename character (review-7 case 1). Backslash is
// normalized to `/` up front and treated as a path separator, not a Bash
// escape (see LIMITATION above). A `#` that begins a word (at start of input
// or right after an unquoted word terminator) starts a shell comment that
// runs to end of line and is dropped -- so a commented-out glob *inside* a
// run: block (`# node --test scripts/check/*.test.mjs`) is not counted, just
// as Bash would not execute it (review-8 defect 1). A `#` mid-word (`a#b`)
// stays literal, matching Bash.
// Consumes one Bash word starting at `s[i]` (already known not to be a
// terminator/comment start) and returns its literal text, whether it
// contained an unquoted `*`, and the index just past it. Mechanically
// extracted from bashWords' inner while-loop (HYK-160 quality-check: keeps
// bashWords' own complexity under the repo's ESLint ceiling) -- identical
// character-by-character behavior, not a rewrite.
function consumeWord(s, startIndex) {
  const n = s.length;
  let i = startIndex;
  let literal = "";
  let starUnquoted = false;
  while (i < n && !WORD_TERMINATORS.has(s[i])) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < n && s[i] !== quote) {
        literal += s[i];
        i++;
      }
      if (i < n) i++; // consume closing quote (unterminated -> just stop at end)
    } else {
      if (ch === "*") starUnquoted = true;
      literal += ch;
      i++;
    }
  }
  return { literal, starUnquoted, nextIndex: i };
}

export function bashWords(text) {
  const s = text.replace(/\\/g, "/");
  const words = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (WORD_TERMINATORS.has(s[i])) {
      i++;
      continue;
    }
    if (s[i] === "#") {
      // shell comment at a word boundary -> skip to end of line
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    const { literal, starUnquoted, nextIndex } = consumeWord(s, i);
    words.push({ literal, starUnquoted });
    i = nextIndex;
  }
  return words;
}

// True iff `text` contains a Bash word that is exactly the whole-check-dir
// glob with its `*` unquoted -- i.e. Ubuntu Bash running this command would
// actually expand it and hand every scripts/check/*.test.mjs file to node.
// A quoted glob, a partial wildcard, a `.bak` continuation, a prefixed path,
// or an other-directory glob all fail one of these two conditions.
export function coversViaCheckDirGlob(text) {
  return bashWords(text).some(
    (w) => w.literal === WHOLE_CHECK_DIR_GLOB && w.starUnquoted,
  );
}

// Decodes a YAML flow scalar (the text after `run:` on one line) into the
// exact string the runner hands to the shell. YAML quoting is a SEPARATE
// layer from shell quoting: the runner removes YAML quotes before bash ever
// sees the value, so it must be undone HERE -- before bashWords applies the
// shell-quoting rules -- or the two layers get conflated. Three forms:
//   plain    node --test x      -> verbatim (any quotes are literal shell
//                                   quotes, left for bashWords to interpret)
//   single   'a ''b'' c'        -> outer quotes removed, '' -> ' (the only
//                                   escape a YAML single-quoted scalar has)
//   double   "a \"b\" c"        -> outer quotes removed, backslash escapes
//                                   resolved
// review-9 defect 2: coder-9 stripped only the OUTER quotes and left interior
// `''` in place, so `run: 'node --test ''scripts/check/*.test.mjs'''` -- a
// glob that is SHELL-single-quoted after YAML decoding and therefore expands
// to nothing -- was mis-tokenized as an unquoted glob and wrongly judged
// ALIVE. Proper `''`->`'` decoding turns it back into `node --test
// 'scripts/check/*.test.mjs'`, which bashWords correctly sees as quoted.
//
// Bias-to-DRIFT rule: a value that OPENS with a quote but is not a
// well-formed quoted scalar (unbalanced, or trailing junk after the closing
// quote) is AMBIGUOUS. Rather than guess, decodeYamlScalar returns "" so the
// step contributes no coverage. For a coverage gate a false DRIFT
// (over-flagging -> a human looks) is safe, whereas a false ALIVE silently
// certifies an untested suite -- so when unsure we flag, never wave through.
export function decodeYamlScalar(raw) {
  const v = raw.trim();
  if (v[0] === "'") return decodeQuotedScalar(v, "'");
  if (v[0] === '"') return decodeQuotedScalar(v, '"');
  return v;
}

const DOUBLE_ESCAPES = {
  n: "\n",
  t: "\t",
  r: "\r",
  0: "\0",
  "\\": "\\",
  '"': '"',
};

// Single-quoted YAML scalar decoding (`'a ''b'' c'` -> `a 'b' c`, the only
// escape a YAML single-quoted scalar has). Split out of decodeQuotedScalar
// (HYK-160 quality-check: keeps each half's own complexity under the
// repo's ESLint ceiling) -- identical rules, just one quote style at a time.
function decodeSingleQuotedScalar(v) {
  let out = "";
  let i = 1;
  const n = v.length;
  while (i < n) {
    if (v[i] === "'") {
      if (v[i + 1] === "'") {
        out += "'"; // '' -> literal '
        i += 2;
        continue;
      }
      // closing quote: well-formed only if nothing but whitespace follows
      return v.slice(i + 1).trim() === "" ? out : "";
    }
    out += v[i];
    i += 1;
  }
  return ""; // reached end with no closing quote -> unbalanced -> ambiguous -> DRIFT
}

// Double-quoted YAML scalar decoding (backslash escapes resolved). Split
// out of decodeQuotedScalar for the same reason as decodeSingleQuotedScalar.
function decodeDoubleQuotedScalar(v) {
  let out = "";
  let i = 1;
  const n = v.length;
  while (i < n) {
    const ch = v[i];
    if (ch === "\\") {
      const next = v[i + 1];
      out +=
        next === undefined
          ? ""
          : next in DOUBLE_ESCAPES
            ? DOUBLE_ESCAPES[next]
            : next;
      i += 2;
      continue;
    }
    if (ch === '"') {
      return v.slice(i + 1).trim() === "" ? out : "";
    }
    out += ch;
    i += 1;
  }
  return ""; // reached end with no closing quote -> unbalanced -> ambiguous -> DRIFT
}

function decodeQuotedScalar(v, q) {
  return q === "'" ? decodeSingleQuotedScalar(v) : decodeDoubleQuotedScalar(v);
}

// Extracts the shell text of every `run:` step from a GitHub Actions workflow
// -- the ONLY part CI actually executes. Everything else (a step `name:`, any
// other mapping key, a YAML comment line) is excluded, so a glob or filename
// mentioned there can never be mistaken for real coverage. review-8 defect 1:
// the real enforce.yml carries the glob in BOTH its step name and its run:,
// and coder-8's whole-file scan therefore couldn't tell a healthy workflow
// from a future one whose run: had drifted to a single file.
//
// Handles the two run: forms GitHub Actions allows:
//   run: <inline command>        (optionally the whole command YAML-quoted)
//   run: |                        (block scalar; `>` folded and chomping
//     <line>                       indicators |-, |+, >- ... also accepted)
//     <line>
// No full YAML parser: a line-scanner keyed on the `run:` mapping key covers a
// steps list, and it ships with its own tests (inline, quoted inline, block
// scalar, indentation variants, multi-step, name/comment exclusion). Shell
// (#) comments inside a run block are left in the raw text here and dropped at
// tokenization time by bashWords, so a commented-out glob is not counted.
// HYK-338 3R: returns each `run:` step's decoded text as its OWN array
// entry (not pre-joined) -- extractRunText below joins them for the
// existing glob/literal-fallback callers, but the 3R allow-list check
// (matchesExactRunnerInvocation) needs each step in isolation: a step's
// *entire* text must be exactly `node <runnerPath>`, and joining steps
// together would let one step's trailing content bleed into the next
// step's leading content, corrupting that exactness check.
export function extractRunChunks(workflowText) {
  const lines = workflowText.split("\n");
  const runChunks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const m = /^(\s*)(?:-\s+)?run:(.*)$/.exec(line);
    if (!m) continue;
    const keyIndent = m[1].length;
    const rest = m[2].trim();
    const isBlockScalar = /^[|>][+-]?\d*\s*(?:#.*)?$/.test(rest);
    if (isBlockScalar) {
      const blockLines = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const raw = lines[j].replace(/\r$/, "");
        if (raw.trim() === "") {
          blockLines.push("");
          continue;
        }
        const indent = raw.length - raw.trimStart().length;
        if (indent <= keyIndent) break; // dedented back to a sibling key -> block ended
        blockLines.push(raw);
      }
      const indents = blockLines
        .filter((l) => l.trim() !== "")
        .map((l) => l.length - l.trimStart().length);
      const minIndent = indents.length ? Math.min(...indents) : 0;
      runChunks.push(blockLines.map((l) => l.slice(minIndent)).join("\n"));
      i = j - 1;
    } else {
      runChunks.push(decodeYamlScalar(rest));
    }
  }
  return runChunks;
}

export function extractRunText(workflowText) {
  return extractRunChunks(workflowText).join("\n");
}

// HYK-338: CI's canonical scripts/check step no longer names files or a
// glob directly -- it delegates to isolated-suite-runner.mjs, which scans
// its own TEST_DIRS (scripts/check among them). Recognizing that indirection
// means reading TEST_DIRS out of the runner's OWN source at judge time
// (single source of truth -- see the runner's own comment) rather than
// copying the directory list into this file by hand, which would just
// create a second copy that can drift out of sync the same way the glob
// check itself drifted (HYK-350 is exactly that "two copies" failure mode).
const RUNNER_SCRIPT_REL_PATH = "scripts/check/isolated-suite-runner.mjs";

// HYK-338 3R (책임자 판정 «가», 2026-08-25): 1R and 2R both tried to INFER
// runner coverage from workflow TEXT -- 1R read TEST_DIRS with a regex over
// the runner's raw source (beaten by a decoy declaration in a comment/
// string), 2R fixed that but still tried to INFER "does this run: step
// execute the runner" from token shape (beaten by node -e/--check/other-
// script argument forms the heuristic never anticipated). Each fix chased a
// new synthetic bypass because inference from text has no natural stopping
// point. The reroute (coder-task.md §2, 책임자 조건 확인): stop inferring
// BOTH questions --
//   (2-1) TEST_DIRS: import the runner module's REAL exported value
//         directly. No text is parsed at all, so no decoy text (comment,
//         string, nested object/array, regex-before-real, template
//         interpolation, re-export) can ever be mistaken for it -- there is
//         nothing left to parse. isolated-suite-runner.mjs has a
//         `invokedDirectly` main-guard (its own line ~146) gating all
//         process-executing code behind `process.argv[1]` ending in that
//         file's own path, so a plain `import` from HERE never satisfies
//         that guard -- static import is side-effect-free and synchronous,
//         confirmed by ORCH before this round (coder-task.md §2-1).
//   (2-2) run: step recognition: flip from "infer whether this looks like
//         an invocation" to an ALLOW LIST -- matchesExactRunnerInvocation
//         below recognizes exactly one shape (`node <runnerPath>`, the
//         step's ENTIRE text and nothing else) as ALIVE-eligible. Every
//         other shape that still mentions the path (a flag, a second
//         command, npx/pwsh/env prefixes, a relative path, "nodejs"
//         instead of "node", ...) is real text CI might be running --
//         UNJUDGABLE, not silently ALIVE and not asserted DRIFT, with the
//         actual offending text in the reason so a human can extend the
//         allow list (책임자 조건①, coder-task.md §2-2).

// The one recognized shape: the step's run: text, trimmed, is exactly
// `node <runnerScriptRelPath>` -- the path may optionally be wrapped in a
// single matching pair of straight quotes (the same quote char on both
// sides), nothing else. No flags, no second command, no interpreter other
// than the literal token `node` (this workflow runs on ubuntu-latest, so
// `node.exe`/`nodejs` are real-but-different forms, not this one -- see
// nodejs-interpreter in the test suite). Anything not matching this is a
// real form this checker does not yet recognize, not an absence.
const ACCEPTED_RUNNER_INVOCATION_RE = /^node\s+(["']?)(.+)\1$/;

export function matchesExactRunnerInvocation(chunkText, runnerScriptRelPath) {
  const m = ACCEPTED_RUNNER_INVOCATION_RE.exec(chunkText.trim());
  return m !== null && m[2] === runnerScriptRelPath;
}

// HYK-403: a second recognized shape -- the step's run: text, trimmed, is
// exactly `npm test`. Recognized ONLY when package.json's own "test" script
// resolves (via the SAME allow-list check above) to `node
// <runnerScriptRelPath>` -- so this never becomes a second, looser way to
// claim ALIVE; it's the exact same allow-listed invocation, one indirection
// through npm's script name. If package.json's "test" script is ever
// repointed at something else, this stops recognizing "npm test" and falls
// through to the existing UNJUDGABLE/DRIFT handling below, same as any
// other unrecognized shape.
export function matchesNpmTestInvocation(
  chunkText,
  npmTestScript,
  runnerScriptRelPath,
) {
  if (chunkText.trim() !== "npm test") return false;
  return (
    typeof npmTestScript === "string" &&
    matchesExactRunnerInvocation(npmTestScript, runnerScriptRelPath)
  );
}

// Real default for npmTestScript below: package.json's own "scripts.test",
// read once at judge time (not statically imported -- package.json is JSON,
// not an ES module). Never throws: a missing/unparseable package.json
// yields null, which matchesNpmTestInvocation always rejects (fail-closed,
// same posture as RUNNER_TEST_DIRS import failing).
function readNpmTestScript(root = repoRoot()) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return typeof pkg?.scripts?.test === "string" ? pkg.scripts.test : null;
  } catch {
    return null;
  }
}

// HYK-403: the single shared predicate for "is this run: text a canonical
// whole-suite invocation" -- either recognized shape, one place. Every
// consumer that needs to recognize the runner's canonical invocation (this
// module's own checkCiCoverage, AND ci-gitleaks-order.mjs's step-order
// check) calls this instead of matchesExactRunnerInvocation directly, so a
// future third recognized shape only needs to be added here once.
export function isRecognizedSuiteInvocation(
  chunkText,
  runnerScriptRelPath = RUNNER_SCRIPT_REL_PATH,
  npmTestScript = readNpmTestScript(),
) {
  return (
    matchesExactRunnerInvocation(chunkText, runnerScriptRelPath) ||
    matchesNpmTestInvocation(chunkText, npmTestScript, runnerScriptRelPath)
  );
}

// CI coverage: every scripts/check/*.test.mjs basename that actually exists
// on disk (discovered dynamically, not hardcoded, so a brand-new check's
// test file is caught even before anyone updates the manifest) must be run by
// CI -- either by a whole-directory glob in a run: step, referenced
// literally in one, or (HYK-338) run through isolated-suite-runner.mjs in
// its one recognized invocation shape, credited against that module's own
// REAL imported TEST_DIRS (see the HYK-338 3R block above -- no text is
// parsed for either question anymore). Only the run: steps count
// (extractRunChunks/extractRunText); text in a step name: or a comment
// executes nothing and is ignored (review-8 defect 1).
// checkCiCoverage's recognized-invocation branch (§2-2's ALIVE/DRIFT
// decision once a step's text matches matchesExactRunnerInvocation).
// Extracted so checkCiCoverage itself stays a single dispatch per branch
// (HYK-160 quality-check: keeps checkCiCoverage's own complexity under the
// repo's ESLint ceiling) -- pure refactor, identical statuses/reasons.
function judgeRecognizedRunnerInvocation({
  runnerTestDirs,
  runnerScriptRelPath,
  checkDirRelPath,
  missing,
  testFiles,
}) {
  if (!Array.isArray(runnerTestDirs) || runnerTestDirs.length === 0) {
    return {
      status: "UNJUDGABLE",
      missing,
      reason: `CI runs '${runnerScriptRelPath}' but its imported TEST_DIRS could not be determined (got ${JSON.stringify(runnerTestDirs)}) -- fail-closed, cannot confirm which directories it actually scans`,
    };
  }
  if (!runnerTestDirs.includes(checkDirRelPath)) {
    return {
      status: "DRIFT",
      missing,
      reason: `'${runnerScriptRelPath}' is invoked by CI but its TEST_DIRS (${JSON.stringify(runnerTestDirs)}) does not include '${checkDirRelPath}' -- ${missing.length}/${testFiles.length} check test suite(s) not actually run: ${missing.join(", ")}`,
    };
  }
  return {
    status: "ALIVE",
    missing: [],
    reason: `CI runs '${checkDirRelPath}' indirectly via '${runnerScriptRelPath}' (run: step is exactly 'node ${runnerScriptRelPath}'), whose own imported TEST_DIRS (real value, no text parsing) includes '${checkDirRelPath}' -- covers all ${testFiles.length} discovered suite(s)`,
  };
}

export function checkCiCoverage({
  workflowText,
  testFiles,
  runnerTestDirs = RUNNER_TEST_DIRS,
  checkDirRelPath = "scripts/check",
  runnerScriptRelPath = RUNNER_SCRIPT_REL_PATH,
  npmTestScript = readNpmTestScript(),
}) {
  // HYK-338 2R (review P1-3, kept in 3R -- 검토자가 통과시킨 부분): zero
  // discovered test files must never read as "all covered" -- an empty
  // `testFiles` makes every path below vacuously true (a glob "covers all 0
  // suites", the literal fallback's `missing` list starts empty), which is
  // exactly the failure mode this whole issue is about: CI reporting green
  // while nothing actually runs. UNJUDGABLE (not DRIFT) because zero
  // discovered files is ambiguous on its own -- it could be a real (if
  // unusual) empty target directory or a broken discovery step upstream --
  // and this function has no way to tell which from testFiles alone; either
  // way it must not be credited as coverage. This check comes before every
  // other path so none of them can short-circuit past it.
  if (!Array.isArray(testFiles) || testFiles.length === 0) {
    return {
      status: "UNJUDGABLE",
      missing: [],
      reason:
        'zero check test suite(s) were discovered to judge CI coverage against -- an empty set is not the same as "everything is wired," and this function cannot tell a genuinely empty target from a broken discovery step -- fail-closed',
    };
  }
  const runChunks = extractRunChunks(workflowText);
  const runText = runChunks.join("\n");
  const words = bashWords(runText);
  if (words.some((w) => w.literal === WHOLE_CHECK_DIR_GLOB && w.starUnquoted)) {
    return {
      status: "ALIVE",
      missing: [],
      reason: `CI runs scripts/check/*.test.mjs via a directory glob in a run: step -- covers all ${testFiles.length} discovered suite(s), including future ones`,
    };
  }
  // Literal per-file fallback, matched against the run: steps' effective token
  // text (quotes removed, shell comments dropped by bashWords) -- never the
  // whole YAML, so a basename appearing only in a name:/comment can't credit.
  const effective = words.map((w) => w.literal).join("\n");
  const missing = testFiles.filter((f) => !effective.includes(f));
  if (missing.length === 0) {
    return {
      status: "ALIVE",
      missing: [],
      reason: `all ${testFiles.length} check test suite(s) referenced in CI run: steps`,
    };
  }
  // HYK-338 3R allow-list (§2-2), extended HYK-403: a step whose ENTIRE
  // text is exactly `node <runnerScriptRelPath>`, OR exactly `npm test`
  // when package.json's "test" script itself resolves to that same
  // invocation -- either is the one recognized invocation shape.
  const isRecognizedInvocation = runChunks.some((chunk) =>
    isRecognizedSuiteInvocation(chunk, runnerScriptRelPath, npmTestScript),
  );
  if (isRecognizedInvocation) {
    return judgeRecognizedRunnerInvocation({
      runnerTestDirs,
      runnerScriptRelPath,
      checkDirRelPath,
      missing,
      testFiles,
    });
  }
  // HYK-338 3R (§2-2, 책임자 조건①): the runner path is mentioned somewhere
  // in a run: step (bashWords already drops `#` shell comments, so a
  // commented-out mention does not count here) but not in the one
  // recognized shape -- this is a REAL, unrecognized form, not an absence.
  // UNJUDGABLE with the actual offending text, never a silent DRIFT that
  // would look identical to "the path isn't there at all." A SUBSTRING
  // check (not exact word equality) on purpose: a relative "./scripts/..."
  // path or a quoted multi-word argument (`pwsh -c "node <path>"` tokenizes
  // as ONE word containing the whole quoted string, spaces included -- see
  // consumeWord) both still genuinely reference the runner path without
  // that word ever being equal to it.
  const mentioningChunks = runChunks.filter((chunk) =>
    bashWords(chunk).some((w) => w.literal.includes(runnerScriptRelPath)),
  );
  if (mentioningChunks.length > 0) {
    return {
      status: "UNJUDGABLE",
      missing,
      reason: `CI's run: step(s) reference '${runnerScriptRelPath}' but not in the one recognized form 'node ${runnerScriptRelPath}' (found: ${JSON.stringify(mentioningChunks.map((c) => c.trim()))}) -- if this really runs the suite, add its shape to selfcheck-inventory.mjs's allow list (matchesExactRunnerInvocation)`,
    };
  }
  return {
    status: "DRIFT",
    missing,
    reason: `${missing.length}/${testFiles.length} check test suite(s) not wired into CI run: steps: ${missing.join(", ")}`,
  };
}

// Picks the single worst status among a list, per STATUS_SEVERITY's
// worst-first ordering -- e.g. [ALIVE, DRIFT, ALIVE] -> DRIFT.
export function combineStatuses(statuses) {
  for (const s of STATUS_SEVERITY) {
    if (statuses.includes(s)) return s;
  }
  return "ALIVE";
}

// Judges a single manifest entry against injected file/settings state --
// every filesystem/settings read is a parameter with a real-world default,
// the same injection-point convention as status-fresh.mjs/controlroom-fresh.mjs.
// One claude-settings install_target's wiring check (judgeEntry step 3's
// per-target branch, extracted so the caller's loop body stays a single
// dispatch instead of a nested condition -- HYK-160 quality-check: keeps
// judgeEntry's own complexity/line-count under the repo's ESLint ceiling,
// no behavior change).
function judgeClaudeSettingsTarget(entry, target, settingsByLocation) {
  const settings = settingsByLocation[target.location];
  if (settings === undefined) {
    return {
      status: "UNJUDGABLE",
      reason: `no settings loaded for location '${target.location}' -- cannot judge wiring`,
    };
  }
  const hookCommands = parseHookCommands(settings);
  const result = findInstalledTarget(hookCommands, {
    id: entry.id,
    hookEvent: target.hook_event,
    matcher: target.matcher,
  });
  if (!result.installed) {
    return {
      status: target.required ? "NOT_INSTALLED" : "UNJUDGABLE",
      reason: `'${entry.id}' not found in ${target.location}'s ${target.hook_event} hooks`,
    };
  }
  if (result.matcherMismatch) {
    return {
      status: "DRIFT",
      reason: `'${entry.id}' installed in ${target.location}'s ${target.hook_event} but matcher differs (expected '${target.matcher}', found ${JSON.stringify(result.actualMatchers)})`,
    };
  }
  return {
    status: "ALIVE",
    reason: `'${entry.id}' wired in ${target.location}'s ${target.hook_event}`,
  };
}

// Compares a control-room "live" doc (e.g. D:\문서관리\하네스-관제실\*.md)
// against its repo-tracked drift baseline copy, by content hash -- same
// four-state judgment as checkNativeGitHook (UNJUDGABLE/NOT_INSTALLED/
// DRIFT/ALIVE), reused rather than re-implemented, because "installed copy
// byte-identical to versioned copy" is exactly the same question a native
// git hook answers, just with CONTROL_ROOM standing in for .git/hooks as
// the "live" root (HYK-336 §2). Manifest paths are placeholders
// (REPO/..., CONTROL_ROOM/...) resolved via resolvePlaceholderPath so the
// manifest itself never hardcodes a machine-specific control-room path.
export function checkControlRoomDoc({
  target,
  roots,
  readFileFn = (p) => readFileSync(p, "utf8"),
  existsFn = existsSync,
}) {
  const versionedPath = resolvePlaceholderPath(target.versioned_path, roots);
  const installedPath = resolvePlaceholderPath(target.installed_path, roots);
  if (!versionedPath) {
    return {
      status: "UNJUDGABLE",
      reason: `versioned_path '${target.versioned_path}' could not be resolved (missing root) -- cannot compare`,
    };
  }
  if (!installedPath) {
    return {
      status: "UNJUDGABLE",
      reason: `installed_path '${target.installed_path}' could not be resolved (missing CONTROL_ROOM root) -- cannot compare`,
    };
  }
  return checkNativeGitHook({
    versionedPath,
    installedPath,
    readFileFn,
    existsFn,
  });
}

// One install_target's judgment, dispatched by kind -- extracted from
// judgeWiring's per-target loop (HYK-336 quality-check: keeps judgeWiring's
// own line count under the repo's ESLint ceiling once a third kind
// (control-room-doc) joined git-hook/claude-settings). Returns null for an
// unrecognized kind, same as the loop silently skipping it before.
function judgeInstallTarget(
  entry,
  target,
  { root, roots, settingsByLocation, readFileFn, existsFn },
) {
  if (target.kind === "git-hook") {
    return checkNativeGitHook({
      versionedPath: join(root, target.versioned_path),
      installedPath: join(root, target.installed_path),
      readFileFn,
      existsFn,
    });
  }
  if (target.kind === "claude-settings") {
    return judgeClaudeSettingsTarget(entry, target, settingsByLocation);
  }
  if (target.kind === "control-room-doc") {
    return checkControlRoomDoc({ target, roots, readFileFn, existsFn });
  }
  return null;
}

// judgeEntry step 3: wiring, dispatched by install_target kind (or a
// source-reference / CI-coverage special case for entries with no
// settings-based wiring). Extracted from judgeEntry itself for the same
// quality-check reason as judgeClaudeSettingsTarget above -- pure
// refactor, same statuses/evidence this block always produced.
function judgeWiring(
  entry,
  {
    root,
    roots = {},
    settingsByLocation,
    readFileFn,
    existsFn,
    testFiles,
    scriptPath,
  },
) {
  const statuses = [];
  const evidence = [];

  if (entry.id === "ci-enforce") {
    if (existsFn(scriptPath) && testFiles) {
      // HYK-338 3R: checkCiCoverage no longer needs the runner's source
      // text at all -- its TEST_DIRS default is the real static import
      // (RUNNER_TEST_DIRS), not a file read.
      const ci = checkCiCoverage({
        workflowText: readFileFn(scriptPath),
        testFiles,
      });
      statuses.push(ci.status);
      evidence.push(ci.reason);
    } else if (existsFn(scriptPath)) {
      statuses.push("UNJUDGABLE");
      evidence.push(
        "no discovered test file list given -- cannot judge CI coverage",
      );
    }
    return { statuses, evidence };
  }

  if (entry.source_reference_check) {
    const src = checkSourceReference({
      file: join(root, entry.source_reference_check.file),
      pattern: entry.source_reference_check.pattern,
      readFileFn,
      existsFn,
    });
    statuses.push(src.status);
    evidence.push(src.reason);
    return { statuses, evidence };
  }

  if (
    Array.isArray(entry.install_targets) &&
    entry.install_targets.length > 0
  ) {
    for (const target of entry.install_targets) {
      const judged = judgeInstallTarget(entry, target, {
        root,
        roots,
        settingsByLocation,
        readFileFn,
        existsFn,
      });
      if (!judged) continue;
      statuses.push(judged.status);
      evidence.push(judged.reason);
    }
    return { statuses, evidence };
  }

  // install_targets === [] and no source_reference_check (relay-handshake,
  // pm-snapshot-gate): nothing to check beyond script/test existence, but a
  // report row must still say *why* this is ALIVE rather than leaving
  // evidence empty (review-1 caught an earlier round leaving these two
  // entries' evidence blank in the actual generated report).
  evidence.push(
    `'${entry.id}' is not hook-installed (ORCH invokes it directly) -- judged from script/test existence alone`,
  );
  return { statuses, evidence };
}

export function judgeEntry(
  entry,
  {
    repoRoot: root,
    roots,
    settingsByLocation = {},
    canaryDir,
    now = Date.now(),
    existsFn = existsSync,
    readFileFn = (p) => readFileSync(p, "utf8"),
    testFiles,
  } = {},
) {
  const evidence = [];
  const statuses = [];

  // 1. Script (and, for CI, the workflow file) must exist at all.
  const scriptPath = join(root, entry.script);
  if (!existsFn(scriptPath)) {
    statuses.push("SILENT_BROKEN");
    evidence.push(`script '${entry.script}' not found at '${scriptPath}'`);
  }

  // 2. Test file must exist (S3) -- absence is a DRIFT against this
  // harness's own "every check ships with .test.mjs" convention, not a
  // functional break, so it doesn't outrank SILENT_BROKEN/NOT_INSTALLED.
  if (entry.test) {
    const testPath = join(root, entry.test);
    if (!existsFn(testPath)) {
      statuses.push("DRIFT");
      evidence.push(
        `test '${entry.test}' not found at '${testPath}' (S3 violation)`,
      );
    }
  }

  // 3. Wiring (see judgeWiring above).
  const wiring = judgeWiring(entry, {
    root,
    roots,
    settingsByLocation,
    readFileFn,
    existsFn,
    testFiles,
    scriptPath,
  });
  statuses.push(...wiring.statuses);
  evidence.push(...wiring.evidence);

  // 4. Claude-only checks additionally require a fresh canary receipt (G9),
  // but only once wiring itself hasn't already confirmed a worse problem --
  // no point demanding a canary for a hook that isn't even installed.
  if (entry.claude_only && combineStatuses(statuses) === "ALIVE") {
    const canary = checkCanaryReceipt({ id: entry.id, canaryDir, now });
    statuses.push(canary.status);
    evidence.push(canary.reason);
  }

  const status = statuses.length === 0 ? "ALIVE" : combineStatuses(statuses);
  return { id: entry.id, status, evidence };
}

// Discovers scripts/check/*.test.mjs basenames on disk -- the real,
// dynamic set CI coverage is judged against (not the manifest's own,
// necessarily-incomplete `test` field list).
export function discoverCheckTestFiles(checkDir, readdirFn = readdirSync) {
  return readdirFn(checkDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort();
}

// Every id a manifest expects at a given claude-settings location (i.e. the
// ids findExtraInvocations should NOT flag there) -- an entry can have more
// than one install_target at the same location (context-inject: SessionStart
// + UserPromptSubmit), so this collects across all of an entry's targets.
export function expectedIdsForLocation(manifest, location) {
  const ids = new Set();
  for (const entry of manifest.checks) {
    for (const target of entry.install_targets ?? []) {
      if (target.kind === "claude-settings" && target.location === location)
        ids.add(entry.id);
    }
  }
  return [...ids];
}

// G6's "extra" half: for every settings file this run actually loaded,
// finds every scripts/check/<id>.mjs invocation the manifest doesn't expect
// there at all -- a hand-added hook nobody registered. Returns one DRIFT-shaped
// result per extra invocation (prefixed `extra:` so it can never collide with
// a real manifest entry's id), carrying the hookEvent(s) it was found under
// as evidence. review-1 caught an earlier round of this module where
// findExtraInvocations existed, was unit-tested, but nothing ever called it
// from runInventory -- so a real extra hook was silently never reported.
export function findExtraResults(manifest, settingsByLocation) {
  const results = [];
  for (const [location, settings] of Object.entries(settingsByLocation)) {
    if (settings === undefined || settings === null) continue;
    const hookCommands = parseHookCommands(settings);
    const expectedIds = expectedIdsForLocation(manifest, location);
    for (const extraId of findExtraInvocations(hookCommands, expectedIds)) {
      const hookEvents = [
        ...new Set(
          hookCommands
            .filter((h) => extractCheckScriptId(h.command) === extraId)
            .map((h) => h.hookEvent),
        ),
      ];
      results.push({
        id: `extra:${location}:${extraId}`,
        status: "DRIFT",
        evidence: [
          `manifest에 없는 hook command '${extraId}.mjs' found in ${location}'s ${hookEvents.join(", ")} hooks -- register it in enforcement-inventory.json or remove the hook entry`,
        ],
      });
    }
  }
  return results;
}

// HYK-160 라이더ⓐ: a dedicated, fixed-reason wrapper around
// findExtraResults for the exact drift this task fixed (report-style-guard
// wired in settings.local.json but registered with `install_targets: []`,
// independently confirmed by verify-2 07-18). findExtraResults already
// detects the underlying condition generically (any settings-wired hook
// command absent from the manifest's expected ids at that location) with a
// free-text DRIFT reason; this function gives that same condition a single
// fixed reason string, ENFORCEMENT_INVENTORY_MISSING, so a known-bad fixture
// can assert on it directly (Tier0 "정확한 원인 고정") instead of matching
// prose that could reword under a future edit.
//
// Honesty (S4, design §3.4): registering an id here only proves the
// manifest and settings agree it exists -- it is never proof the guard
// behaves correctly. Content/behavior correctness is each guard's own
// known-bad/good test matter, not this function's.
export function checkEnforcementInventoryRegistration({
  manifest,
  settingsByLocation,
}) {
  const extras = findExtraResults(manifest, settingsByLocation);
  if (extras.length === 0) {
    return {
      status: "PASS",
      ok: true,
      reason:
        "enforcement-inventory: every wired hook command has a matching manifest install_targets entry",
    };
  }
  const ids = extras.map((e) => e.id.replace(/^extra:/, "")).join(", ");
  return {
    status: "BLOCK",
    ok: false,
    reason: `ENFORCEMENT_INVENTORY_MISSING: wired hook command(s) with no manifest install_targets entry -- ${ids}`,
  };
}

// HYK-160 라이더ⓑ: the 10 hook-command instances Orca's per-session settings
// injection is expected to carry additively (design report §3.8, sourced
// from 이식계획-v1.md R3's "Orca 주입 훅 10종") -- 8 repo-settings instances
// (role-guard/report-style-guard PreToolUse; status-fresh/clear-safe-check/
// linear-sync/controlroom-fresh Stop; context-inject/selfcheck-freshness
// SessionStart) + context-inject's second UserPromptSubmit instance + the
// user-level worker-status-onstart UserPromptSubmit instance = 10. This is a
// snapshot baseline, not a law of nature -- if this batch's own new hooks
// (research-receipt/go-task-id-gate) get installed in a later round, this
// list legitimately grows and must be updated alongside that installation
// (honesty: this function detects shrinkage against ITS OWN list, it does
// not independently know what "should" be wired at any future point).
export const EXPECTED_INJECTED_HOOKS = [
  { id: "role-guard", hookEvent: "PreToolUse" },
  { id: "report-style-guard", hookEvent: "PreToolUse" },
  { id: "status-fresh", hookEvent: "Stop" },
  { id: "clear-safe-check", hookEvent: "Stop" },
  { id: "linear-sync", hookEvent: "Stop" },
  { id: "controlroom-fresh", hookEvent: "Stop" },
  { id: "context-inject", hookEvent: "SessionStart" },
  { id: "selfcheck-freshness", hookEvent: "SessionStart" },
  { id: "context-inject", hookEvent: "UserPromptSubmit" },
  { id: "worker-status-onstart", hookEvent: "UserPromptSubmit" },
];

// G9 (라이더ⓑ, additive half): a fixed-reason check that a previously-wired
// hook was never silently deleted or swapped for something else -- distinct
// from checkHookWiringRegistered below because the *cause* differs (someone/
// something removed a live hook entry) and so does the fix (restore the
// entry), matching design §1's "원인·조치가 다르므로 별도 reason" mandate.
// Additive-only: an extra hook beyond this list is not this check's concern
// (findExtraResults/ENFORCEMENT_INVENTORY_MISSING already covers that).
export function checkHookSetAdditive({
  expectedHooks = EXPECTED_INJECTED_HOOKS,
  hookCommands,
}) {
  const commands = Array.isArray(hookCommands) ? hookCommands : [];
  const missing = expectedHooks.filter(
    (exp) =>
      !commands.some(
        (h) =>
          h.hookEvent === exp.hookEvent &&
          extractCheckScriptId(h.command) === exp.id,
      ),
  );
  if (missing.length > 0) {
    const names = missing.map((m) => `${m.id}@${m.hookEvent}`).join(", ");
    return {
      status: "BLOCK",
      ok: false,
      reason: `HOOK_SET_DRIFT -- expected hook(s) no longer wired: ${names}`,
    };
  }
  return {
    status: "PASS",
    ok: true,
    reason: `hook-set-additive: all ${expectedHooks.length} expected hooks still additively present`,
  };
}

// G9 (라이더ⓑ, wiring half): a fixed-reason wrapper over runInventory's own
// NOT_INSTALLED judgment -- an entry the manifest *does* register but whose
// settings/path is broken (deleted matcher, wrong hook_event, missing
// installed git hook copy, ...). Same "wrap an existing primitive with a
// fixed reason" pattern as checkEnforcementInventoryRegistration above.
export function checkHookWiringRegistered({
  manifest,
  repoRoot: root,
  roots = {},
  settingsByLocation = {},
  canaryDir,
  now = Date.now(),
  testFiles,
}) {
  const { results } = runInventory({
    manifest,
    repoRoot: root,
    roots,
    settingsByLocation,
    canaryDir,
    now,
    testFiles,
  });
  const notInstalled = results.filter((r) => r.status === "NOT_INSTALLED");
  if (notInstalled.length > 0) {
    const ids = notInstalled.map((r) => r.id).join(", ");
    return {
      status: "BLOCK",
      ok: false,
      reason: `HOOK_WIRING_MISSING -- registered check(s) with broken settings/path wiring: ${ids}`,
    };
  }
  return {
    status: "PASS",
    ok: true,
    reason:
      "hook-wiring-registered: every manifest-registered check with install_targets is actually wired",
  };
}

export function runInventory({
  manifest,
  repoRoot: root,
  roots = {},
  settingsByLocation = {},
  canaryDir,
  now = Date.now(),
  existsFn = existsSync,
  readFileFn = (p) => readFileSync(p, "utf8"),
  testFiles,
}) {
  const results = manifest.checks.map((entry) =>
    judgeEntry(entry, {
      repoRoot: root,
      roots,
      settingsByLocation,
      canaryDir,
      now,
      existsFn,
      readFileFn,
      testFiles,
    }),
  );
  results.push(...findExtraResults(manifest, settingsByLocation));
  const summary = {
    ALIVE: 0,
    SILENT_BROKEN: 0,
    DRIFT: 0,
    UNJUDGABLE: 0,
    NOT_INSTALLED: 0,
  };
  for (const r of results) summary[r.status]++;
  return { results, summary };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/selfcheck-inventory.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let manifestPath;
  let canaryDir = process.env.HARNESS_CANARY_DIR;
  let controlRoomPath =
    process.env.HARNESS_CONTROL_ROOM_PATH || "D:/문서관리/하네스-관제실";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--manifest") manifestPath = args[++i];
    else if (args[i] === "--canary-dir") canaryDir = args[++i];
    else if (args[i] === "--control-room") controlRoomPath = args[++i];
  }
  const root = repoRoot();
  manifestPath =
    manifestPath ||
    join(root, "scripts", "check", "enforcement-inventory.json");

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.error(
      `selfcheck-inventory: could not read/parse manifest '${manifestPath}' (${err.message})`,
    );
    process.exit(1);
  }

  const roots = {
    REPO: root,
    CONTROL_ROOM: controlRoomPath,
    USER_HOME: process.env.USERPROFILE || process.env.HOME,
  };
  const settingsByLocation = {};
  for (const entry of manifest.checks) {
    for (const target of entry.install_targets ?? []) {
      if (
        target.kind !== "claude-settings" ||
        settingsByLocation[target.location] !== undefined
      )
        continue;
      const resolved = resolvePlaceholderPath(target.path, roots);
      if (resolved && existsSync(resolved)) {
        try {
          settingsByLocation[target.location] = JSON.parse(
            readFileSync(resolved, "utf8"),
          );
        } catch {
          settingsByLocation[target.location] = null;
        }
      }
    }
  }

  const testFiles = discoverCheckTestFiles(join(root, "scripts", "check"));
  const { results, summary } = runInventory({
    manifest,
    repoRoot: root,
    roots,
    settingsByLocation,
    canaryDir,
    testFiles,
  });

  console.log(`selfcheck-inventory: ${JSON.stringify(summary)}`);
  for (const r of results) {
    console.log(`  ${r.status.padEnd(14)} ${r.id} -- ${r.evidence.join("; ")}`);
  }
  process.exit(0);
}

// HYK-160-coder-8 (moved from selfcheck-inventory.test.mjs by HYK-364, same
// behavior): `.claude/settings.local.json` is git-untracked by design, so a
// fresh worktree/CI checkout never has it -- there is no live wiring to
// audit there (covered by the local weekly selfcheck loop instead). Living
// here (a non-test module) lets any caller -- the test file's own (47)/(58)
// cases, and HYK-364's skip-inventory-contract.test.mjs -- resolve the exact
// same skip decision instead of re-implementing it.
export const CI_MISSING_SETTINGS_SKIP_REASON =
  "live wiring file '.claude/settings.local.json' is local-only (git-untracked) -- CI has no live wiring to audit here; local weekly selfcheck covers this gap";

export function resolveRealRepoGuard47({
  repoRoot,
  settingsPathOverride,
  existsFn = existsSync,
  readFileFn = (p) => readFileSync(p, "utf8"),
}) {
  const settingsPath =
    settingsPathOverride ?? join(repoRoot, ".claude", "settings.local.json");
  if (!existsFn(settingsPath)) {
    return { outcome: "skip", reason: CI_MISSING_SETTINGS_SKIP_REASON };
  }
  const manifest = JSON.parse(
    readFileFn(
      join(repoRoot, "scripts", "check", "enforcement-inventory.json"),
    ),
  );
  const settings = JSON.parse(readFileFn(settingsPath));
  const result = checkEnforcementInventoryRegistration({
    manifest,
    settingsByLocation: { "repo-settings": settings },
  });
  return {
    outcome: result.status === "PASS" ? "pass" : "fail",
    reason: result.reason,
  };
}

export const CI_MISSING_REPO_SETTINGS_SKIP_REASON =
  "live wiring file '.claude/settings.local.json' is local-only (git-untracked) -- CI has no repo-settings wiring to audit here; local weekly selfcheck covers this gap";

export function resolveRealRepoGuard58({
  repoRoot,
  repoSettingsPathOverride,
  userSettingsPathOverride,
  existsFn = existsSync,
  readFileFn = (p) => readFileSync(p, "utf8"),
}) {
  const repoSettingsPath =
    repoSettingsPathOverride ??
    join(repoRoot, ".claude", "settings.local.json");
  if (!existsFn(repoSettingsPath)) {
    return { outcome: "skip", reason: CI_MISSING_REPO_SETTINGS_SKIP_REASON };
  }
  const repoSettings = JSON.parse(readFileFn(repoSettingsPath));

  const userSettingsPath =
    userSettingsPathOverride ??
    join(
      process.env.USERPROFILE || process.env.HOME,
      ".claude-team",
      "settings.json",
    );
  let userSettings = { hooks: {} };
  if (existsFn(userSettingsPath)) {
    try {
      userSettings = JSON.parse(readFileFn(userSettingsPath));
    } catch {
      userSettings = { hooks: {} };
    }
  }

  const hookCommands = [
    ...parseHookCommands(repoSettings),
    ...parseHookCommands(userSettings),
  ];
  const result = checkHookSetAdditive({ hookCommands });
  return {
    outcome: result.status === "PASS" ? "pass" : "fail",
    reason: result.reason,
  };
}
