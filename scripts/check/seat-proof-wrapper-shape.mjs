// HYK-323 (wrapper-shape-1): the seat-proof gate's repo-side units
// (dispatch-worker-seat-proof-gate.mjs / seat-proof-cli.mjs) were tested
// exhaustively, but the control-room PowerShell wrapper layer around them
// (`Invoke-SeatProofGate` in dispatch-worker.ps1) had zero tests checking
// whether it could ever return a *passing* verdict at all. 2026-08-19: that
// wrapper leaked the gate CLI's stdout into its own PowerShell return value
// alongside `return $LASTEXITCODE`, so callers received a 2-element array
// and `-ne 0` read PROVEN (exit 0) as a failure too -- every delivery was
// rejected, with no passing path. This module mechanizes a check for that
// specific class of defect so it cannot silently return.
//
// HYK-323 (wrapper-shape-2, review r1 rejection, P1 x3): a first version of
// this checker judged the wrapper by regex-matched *shape* (notation
// pattern-matching). Review r1 found three notations that all read as OK
// from that version but are the same defect class or worse (capture-then-
// leak via Write-Output/bare-expression, a second uncaptured definition
// shadowing a fixed one, and array-splatted call args). All three were
// patched into the shape regexes.
//
// HYK-323 (wrapper-shape-3, review r2 rejection, P1 x6, ORCH judgment
// "accept 가+나, reject 다" 2026-08-19 23:12): review r2 found SIX MORE
// notations the patched shape checker still read as OK (Invoke-Expression
// indirection, leaking only the first of two captured calls, `-InputObject`,
// a parenthesized bare expression, `& (Get-Command node)`, and a `$Node`
// case variant the checker's case-sensitive regex missed). Chasing notation
// is a losing game -- PowerShell has unboundedly many ways to write "call
// this and don't discard its output," and every regex fix invites the next
// unrecognized one. ORCH's judgment: stop trying to recognize every unsafe
// *shape*; instead pin what the *known-good* function body looks like
// (a SHA-256 fingerprint of its exact text) and treat any deviation --
// recognized-safe-looking or not -- as BROKEN. Shape checking is kept, but
// demoted to a DIAGNOSTIC that explains *why* a fingerprint mismatch
// happened; it is never the verdict authority. See
// judgeSeatProofWrapperShape (diagnostic) vs. judgeSeatProofWrapperCanonical
// (verdict) below.
//
// Honesty limits (§2-3, keep in both this header and the result file):
// - CI cannot see the control room (`D:\문서관리\하네스-관제실\`) -- this
//   checker inspects the real wrapper only when run locally by a human/ORCH
//   with that path. What CI runs is this module's OWN unit tests, never a
//   check of the live wrapper. Do not claim "CI prevents recurrence."
// - The fingerprint check (this module's verdict) inspects *exact text*,
//   never *execution* -- it does not run the wrapper to confirm exit 0 is
//   actually read as a pass. The separate behavioral checker
//   (seat-proof-wrapper-behavior.mjs) covers execution, but it too only
//   runs locally where PowerShell exists (same local-anchor limit).
// - This local-anchor limit is not new to this round -- the wrapper-shape-1
//   shape checker was exactly as local-anchored as this fingerprint checker
//   is. Neither version has ever run as part of CI's view of the control
//   room.
// - Wiring this checker into the control room's delivery path itself
//   (dispatch-worker.ps1 calling this CLI before trusting the seat-proof
//   gate) is proposed only, in docs/control-room-patches/
//   HYK-323-seat-proof-wrapper-shape-check.md -- not applied by this round.
//
// HYK-323 (wrapper-shape-4, scope-narrowing final round, 책임자 판정
// 2026-08-20 00:02 "ⓐ 범위 축소" 확정): review r3 proved the fingerprint
// verdict itself is text-only in a way wrapper-shape-3's header did not
// spell out plainly enough -- pasting the EXACT canonical body inside a
// PowerShell here-string (`@'...'@`), or inside a dead `if ($false) { ... }`
// block, makes `extractAllFunctionBodies` find and hash the same braced
// text even though no `Invoke-SeatProofGate` function is ever actually
// defined at runtime (confirmed with pwsh: calling the wrapper then throws
// "not recognized" -- FUNCTION_ABSENT). The fingerprint verdict reads that
// as OK/unchanged. This is not a bug to patch (three straight review rounds
// already proved chasing individual notations is a losing game -- see
// wrapper-shape-3 header above); it is the FLOOR of what text comparison
// can ever promise, and this round's job is to say that floor out loud
// instead of letting the tool's name imply more. Restated as the six-line
// honesty contract (§2-2 of the HYK-323-wrapper-shape-4 task, keep this
// wording identical in the result file and in
// docs/control-room-patches/HYK-323-seat-proof-wrapper-shape-check.md):
//
//   1. 이 검사기가 하는 일: 관제실 좌석증명 래퍼 함수가 정본과 달라졌는지
//      알린다. 그뿐이다.
//   2. 막는 것: 사고성 회귀(실수로 결함 재도입) -- 텍스트가 바뀌면 반드시
//      걸린다.
//   3. 막지 못하는 것: 고의 우회. 실측된 예 -- 정본 본문을 here-string
//      안에 넣거나 `if ($false)` 블록 안에 넣으면 함수가 존재하지
//      않는데도 지문이 같다(검토 3차 실증, pwsh 로 FUNCTION_ABSENT 확인).
//   4. 왜 그 이상 못 가나: 텍스트 분석은 실행 문맥을 모른다. 그리고
//      관제실을 고칠 수 있는 주체는 이 검사기도 끌 수 있다 -- 이 층에
//      "공격자 방어"를 기대하면 안 된다.
//   5. CI 는 관제실을 볼 수 없다 -- 이 검사는 로컬 앵커다(기존 방식도
//      마찬가지였다).
//   6. 정본 갱신 절차: 관제실 함수를 정당하게 고치면 ⑴새 지문 측정
//      ⑵사유 기재 ⑶검토 라운드 경유(HYK-306 방식).
//
// The verdict's printed vocabulary changed accordingly: `WRAPPER_SHAPE:
// OK|BROKEN` (read too easily as "the wrapper is safe") is now
// `WRAPPER_CHANGED: NO|YES` (says only what was actually checked -- did the
// live text move away from the pinned fingerprint). The `verdict`/
// `reasonCode` fields returned by the exported functions are internal API
// and are unchanged (OK/BROKEN) -- only the CLI's human-facing stdout
// wording changed; callers that parse the exported objects are unaffected.

const FUNCTION_NAME = "Invoke-SeatProofGate";
// Call recognition is anchored on the call operator + command name
// (`& node ...` / `& $node ...`), NOT on the argument notation that
// follows it. Review r1 broke the wrapper-shape-1 version of this regex
// (which required the literal token sequence `& node $gateCliPath`) simply
// by splatting the same arguments through an array (`& node @nodeArgs`).
// Argument notation will keep growing new forms; the call-operator anchor
// does not need to. NOTE (wrapper-shape-3): this regex, and everything
// derived from it below, is now DIAGNOSTIC ONLY (see module header) --
// review r2 proved conclusively that no finite set of such regexes can be
// trusted as the verdict authority.
const GATE_CALL_RE = /&\s*(node\b|\$node\b)/;
const CAPTURED_ASSIGNMENT_RE = /^\$[A-Za-z_]\w*\s*=/;
const CAPTURED_VAR_NAME_RE = /^\$([A-Za-z_]\w*)\s*=/;
// A call piped straight to `Out-Null` discards its output without ever
// needing a capturing variable at all -- an explicit, safe alternative to
// `$var = ...`, not a defect.
const SAFE_DISCARD_SUFFIX_RE = /\|\s*Out-Null\s*$/i;
const RETURN_RE = /^return\s+(.+)$/;
const SIMPLE_VAR_RE = /^\$([A-Za-z_]\w*)$/;

function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n");
}

// Locates every `function Invoke-SeatProofGate(...) { ... }` in the text
// (PowerShell allows redefining a function; only the LAST definition is
// live at runtime) and returns each one's text strictly between its
// opening and matching closing brace (brace-depth counted, so a nested
// `foreach (...) { ... }` block doesn't truncate it early). An empty
// array means the header was never found; a `null` entry means a header
// was found but its braces never balanced.
export function extractAllFunctionBodies(text) {
  const headerRe = new RegExp(
    `function\\s+${FUNCTION_NAME}\\s*\\([^)]*\\)\\s*\\{`,
    "g",
  );
  const bodies = [];
  let headerMatch;
  while ((headerMatch = headerRe.exec(text)) !== null) {
    const start = headerMatch.index + headerMatch[0].length;
    let depth = 1;
    let i = start;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) {
      bodies.push(null);
      break;
    }
    bodies.push(text.slice(start, i));
    headerRe.lastIndex = i;
  }
  return bodies;
}

// Splits a function body into logical code lines: backtick (`) line
// continuations are joined into one logical line first (so a call split
// across lines is still seen whole by GATE_CALL_RE), then full-line
// `#`-comments and blank lines are dropped so a defect shape quoted inside
// a comment is never mistaken for the live statement it describes. Only
// whole-line comments are recognized -- this file's actual PowerShell
// style (control room + this repo's docs) never mixes code and comment on
// one line, so that's the shape worth trusting; a trailing `# ...` on a
// code line is not stripped.
function codeLinesOf(functionBody) {
  const rawLines = functionBody.split("\n").map((line) => line.trim());
  const logicalLines = [];
  let pending = "";
  for (const line of rawLines) {
    if (line.endsWith("`")) {
      pending += (pending ? " " : "") + line.slice(0, -1).trimEnd();
      continue;
    }
    pending += (pending ? " " : "") + line;
    logicalLines.push(pending.trim());
    pending = "";
  }
  if (pending) logicalLines.push(pending.trim());
  return logicalLines.filter((line) => line !== "" && !line.startsWith("#"));
}

// Walks backward from `fromIndex` for the nearest `$varName = <rhs>`
// assignment and returns its trimmed right-hand side, or null if none.
function lastAssignmentRhs(codeLines, varName, fromIndex) {
  const assignRe = new RegExp(`^\\$${varName}\\s*=\\s*(.+)$`);
  for (let i = fromIndex; i >= 0; i--) {
    const m = assignRe.exec(codeLines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

// Shape ⓐ: the gate CLI is invoked without capturing its output into a
// variable. In PowerShell, an uncaptured command's stdout joins the
// enclosing function's own pipeline output. Returns `{ broken, capturedVar
// }`: `broken` is a verdict object if an uncaptured call was found, else
// null; `capturedVar` is the name (if any) of the variable that captured
// the gate call's output, for shape ⓒ below.
function findUncapturedGateCall(codeLines) {
  let capturedVar = null;
  for (const line of codeLines) {
    if (!GATE_CALL_RE.test(line)) continue;
    if (CAPTURED_ASSIGNMENT_RE.test(line)) {
      const varMatch = CAPTURED_VAR_NAME_RE.exec(line);
      if (varMatch) capturedVar = varMatch[1];
      continue;
    }
    if (SAFE_DISCARD_SUFFIX_RE.test(line)) continue;
    return {
      broken: {
        verdict: "BROKEN",
        reasonCode: "UNCAPTURED_GATE_OUTPUT",
        detail: line,
      },
      capturedVar,
    };
  }
  return { broken: null, capturedVar };
}

// Shape ⓒ (review r1 P1-1): the variable that captured the gate call's
// stdout gets leaked back out as the function's own output anyway --
// either explicitly (`Write-Output`/its alias `echo`) or implicitly (the
// variable alone on its own line is itself a PowerShell output statement).
// `Write-Host` (writes to the host, not the pipeline), `$null = ...`, and
// `| Out-Null` are void/discarding forms and stay OK. Returns a BROKEN
// verdict if a leak is found, else null.
//
// KNOWN DIAGNOSTIC GAP (review r2 forms 5-9, not fixed here -- see module
// header): this only tracks the LAST captured variable name, so a leak of
// an earlier captured variable (form 5) is missed; `-InputObject` (form 6),
// a parenthesized bare expression (form 7), `& (Get-Command node)` (form
// 8), and the case-insensitive `$Node` variant (form 9) are not recognized
// either. These are NOT patched, on purpose -- wrapper-shape-3's judgment
// is that patching individual notations is the losing strategy review r2
// demonstrated; the fingerprint check (judgeSeatProofWrapperCanonical) is
// what actually closes all nine, regardless of this function's blind
// spots. This function stays only as an explanatory diagnostic.
function findLeakedCapturedOutput(codeLines, capturedVar) {
  if (!capturedVar) return null;
  const leakWriteRe = new RegExp(
    `^(Write-Output|echo)\\s+\\$${capturedVar}\\b`,
    "i",
  );
  const bareVarRe = new RegExp(`^\\$${capturedVar}$`);
  for (const line of codeLines) {
    if (leakWriteRe.test(line) || bareVarRe.test(line)) {
      return {
        verdict: "BROKEN",
        reasonCode: "LEAKED_CAPTURED_OUTPUT",
        detail: line,
      };
    }
  }
  return null;
}

// Judges a single function body's code lines. Never sees whether other
// definitions of the same function exist -- that's the caller's job.
// DIAGNOSTIC ONLY as of wrapper-shape-3 -- see module header.
function judgeFunctionBody(codeLines) {
  const { broken: uncapturedBroken, capturedVar } =
    findUncapturedGateCall(codeLines);
  if (uncapturedBroken) return uncapturedBroken;

  const leakBroken = findLeakedCapturedOutput(codeLines, capturedVar);
  if (leakBroken) return leakBroken;

  // Shape ⓑ: the function must end in a `return <expr>` whose value is
  // traceably an exit code -- either `$LASTEXITCODE` directly, or a
  // variable whose last assignment before the return is exactly
  // `$LASTEXITCODE`. Anything else means the function's return value isn't
  // provably a bare exit code.
  const last = codeLines[codeLines.length - 1];
  const returnMatch = last ? RETURN_RE.exec(last) : null;
  if (!returnMatch) {
    return {
      verdict: "BROKEN",
      reasonCode: "RETURN_NOT_EXIT_CODE",
      detail: last ?? "(empty function body)",
    };
  }

  const returnExpr = returnMatch[1].trim();
  if (returnExpr === "$LASTEXITCODE") {
    return { verdict: "OK" };
  }

  const varMatch = SIMPLE_VAR_RE.exec(returnExpr);
  if (!varMatch) {
    return {
      verdict: "BROKEN",
      reasonCode: "RETURN_NOT_EXIT_CODE",
      detail: last,
    };
  }

  const rhs = lastAssignmentRhs(codeLines, varMatch[1], codeLines.length - 2);
  if (rhs !== "$LASTEXITCODE") {
    return {
      verdict: "BROKEN",
      reasonCode: "RETURN_NOT_EXIT_CODE",
      detail: last,
    };
  }

  return { verdict: "OK" };
}

// Pure DIAGNOSTIC judge (wrapper-shape-3: demoted from verdict authority --
// see module header): given the wrapper script's full text, explains
// whether its recognized shape looks safe or not. This function's OK does
// NOT mean the wrapper is safe (review r2 proved 6 notations it misses);
// its BROKEN is useful only to explain *why* a fingerprint mismatch
// happened when the mismatch is one of the two forms this function does
// still recognize (forms 1-3, plus the always-checked shape ⓑ/ⓓ). The
// actual pass/fail decision is judgeSeatProofWrapperCanonical, always.
export function judgeSeatProofWrapperShape(scriptText) {
  const text = normalizeNewlines(scriptText);
  const bodies = extractAllFunctionBodies(text);
  if (bodies.length === 0) {
    return {
      verdict: "BROKEN",
      reasonCode: "FUNCTION_NOT_FOUND",
      detail: `function ${FUNCTION_NAME} not found (or braces unbalanced)`,
    };
  }

  const judgments = bodies.map((body) =>
    body === null
      ? {
          verdict: "BROKEN",
          reasonCode: "FUNCTION_NOT_FOUND",
          detail: "braces unbalanced",
        }
      : judgeFunctionBody(codeLinesOf(body)),
  );

  // Shape ⓓ (review r1 P1-2): more than one definition exists. Fail-closed
  // regardless of whether every individual body judges OK -- ambiguity
  // about which definition is actually live at runtime is itself the
  // defect, not something a per-body pass can clear.
  if (bodies.length > 1) {
    const firstBroken = judgments.find((j) => j.verdict === "BROKEN");
    const baseDetail = firstBroken
      ? firstBroken.detail
      : `all ${bodies.length} definitions individually judged OK`;
    return {
      verdict: "BROKEN",
      reasonCode: firstBroken ? firstBroken.reasonCode : "MULTIPLE_DEFINITIONS",
      detail: `${baseDetail} (MULTIPLE_DEFINITIONS: ${bodies.length} definitions of ${FUNCTION_NAME} found)`,
    };
  }

  return judgments[0];
}

// Computes the fingerprint of the LIVE definition -- PowerShell keeps only
// the LAST `function Invoke-SeatProofGate` definition when more than one
// exists, so that is the one whose behavior actually matters and the one
// this hashes. Normalization is CRLF->LF only (see
// seat-proof-wrapper-canonical.json's "normalization" field for why it is
// kept this narrow). Returns `{ sha256, bodyCount }` on success, or a
// BROKEN verdict object (via the `error` field) if no function was found or
// its braces never balanced.
export function computeCanonicalFingerprint(scriptText) {
  const text = normalizeNewlines(scriptText);
  const bodies = extractAllFunctionBodies(text);
  if (bodies.length === 0) {
    return {
      error: {
        verdict: "BROKEN",
        reasonCode: "FUNCTION_NOT_FOUND",
        detail: `function ${FUNCTION_NAME} not found (or braces unbalanced)`,
      },
    };
  }
  const liveBody = bodies[bodies.length - 1];
  if (liveBody === null) {
    return {
      error: {
        verdict: "BROKEN",
        reasonCode: "FUNCTION_NOT_FOUND",
        detail: "braces unbalanced",
      },
    };
  }
  // node:crypto is imported lazily (module-scope top-level await is
  // avoided so this file stays importable in non-async contexts) -- see
  // call sites below, both of which are already async/CLI paths.
  return { liveBody, bodyCount: bodies.length };
}

async function sha256Hex(text) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// PRIMARY VERDICT (wrapper-shape-3): the wrapper's live
// `Invoke-SeatProofGate` body must byte-match (after CRLF->LF
// normalization) the pinned canonical fingerprint. A match is OK; anything
// else -- a recognized-unsafe shape, an unrecognized-but-actually-unsafe
// shape (all nine review r1/r2 bypass forms), or a legitimate-but-
// unreviewed edit -- is BROKEN/CANONICAL_MISMATCH. There is no third
// option and no "shape looked fine so let it through" escape hatch: shape
// is diagnostic only (see judgeSeatProofWrapperShape above).
//
// `canonical` must be `{ sha256: "<hex>" }` (see
// seat-proof-wrapper-canonical.json). A missing/malformed canonical
// argument is itself fail-closed BROKEN -- this checker refuses to fall
// back to "no fingerprint pinned, so anything passes."
export async function judgeSeatProofWrapperCanonical(scriptText, canonical) {
  if (!canonical || typeof canonical.sha256 !== "string" || !canonical.sha256) {
    return {
      verdict: "BROKEN",
      reasonCode: "CANONICAL_MISSING",
      detail: "no canonical fingerprint (sha256) supplied to compare against",
    };
  }

  const fp = computeCanonicalFingerprint(scriptText);
  if (fp.error) return fp.error;

  const actualSha256 = await sha256Hex(fp.liveBody);
  if (actualSha256 !== canonical.sha256) {
    return {
      verdict: "BROKEN",
      reasonCode: "CANONICAL_MISMATCH",
      detail: `expected sha256=${canonical.sha256} actual sha256=${actualSha256} (live definition is the LAST of ${fp.bodyCount} found)`,
    };
  }
  return { verdict: "OK" };
}

// Combined entry point: primary verdict (fingerprint) plus a diagnostic
// field (shape) that never overrides it. Callers that only need pass/fail
// should read `.verdict`/`.reasonCode`; `.diagnostic` exists purely to
// help a human understand *why* a CANONICAL_MISMATCH happened when the
// mismatch happens to be a shape this checker's regexes still recognize.
export async function judgeSeatProofWrapper(scriptText, canonical) {
  const primary = await judgeSeatProofWrapperCanonical(scriptText, canonical);
  const diagnostic = judgeSeatProofWrapperShape(scriptText);
  return { ...primary, diagnostic };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--script") out.script = argv[++i];
    else if (argv[i] === "--canonical") out.canonical = argv[++i];
  }
  return out;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/seat-proof-wrapper-shape.mjs");
if (invokedDirectly) {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");

  const args = parseArgs(process.argv.slice(2));
  if (!args.script) {
    console.error(
      "usage: node seat-proof-wrapper-shape.mjs --script <path-to-dispatch-worker.ps1> [--canonical <path-to-canonical.json>]",
    );
    process.exit(2);
  }

  const canonicalPath =
    args.canonical ??
    join(
      dirname(fileURLToPath(import.meta.url)),
      "seat-proof-wrapper-canonical.json",
    );

  let scriptText;
  try {
    scriptText = readFileSync(args.script, "utf8");
  } catch (err) {
    console.error(
      `seat-proof-wrapper-shape: failed to read --script file: ${err.message}`,
    );
    process.exit(2);
  }

  let canonical;
  try {
    canonical = JSON.parse(readFileSync(canonicalPath, "utf8"));
  } catch (err) {
    // Fail-closed (§3 item 6): a missing/unreadable canonical file must
    // never be silently treated as "no fingerprint required."
    console.log(`WRAPPER_CHANGED: YES reason=CANONICAL_FILE_UNREADABLE`);
    console.error(
      `  detail: failed to read/parse --canonical file '${canonicalPath}': ${err.message}`,
    );
    process.exit(2);
  }

  const result = await judgeSeatProofWrapper(scriptText, canonical);
  if (result.diagnostic) {
    const d = result.diagnostic;
    console.log(
      d.verdict === "OK"
        ? "WRAPPER_SHAPE_DIAGNOSTIC: NO_KNOWN_SHAPE_DEVIATION (informational only, not the verdict -- see module header for what this does and does not prove)"
        : `WRAPPER_SHAPE_DIAGNOSTIC: DEVIATION reason=${d.reasonCode} (informational only, not the verdict)`,
    );
  }
  if (result.verdict === "OK") {
    console.log("WRAPPER_CHANGED: NO");
    process.exit(0);
  }
  console.log(`WRAPPER_CHANGED: YES reason=${result.reasonCode}`);
  if (result.detail) console.error(`  detail: ${result.detail}`);
  process.exit(2);
}
