// HYK-217-dispatch-gate-1 (coder-task.md) -- CLI shell around
// dispatch-gate-decision-core.mjs. This is the thing the delivery tool
// (관제실 `dispatch-worker.ps1`, patched per coder.md's patch text, not this
// repo) is meant to call BEFORE injecting a task: it runs BOTH
// `reject-streak.mjs gate` and `reject-streak.mjs diagnostic-gate` against
// the about-to-be-dropped task file, feeds their exit codes through the pure
// core, prints one human-readable line per gate PLUS one aggregate verdict
// line, and exits 0 (deliver) or 1 (do not deliver) -- deliberately its OWN
// exit-code contract, distinct from the underlying gates' {0,1,2}, so a
// caller never has to remember two different meanings for "1".
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  decideFromGateExit,
  combineGateDecisions,
  checkGatePreconditions,
  checkLedgerEntryShape,
  checkLedgerPathResolution,
  checkOneBPrecondition,
  checkHeadCommitPrecondition,
  DISPATCH_GATE_STATE,
} from "./dispatch-gate-decision-core.mjs";
import {
  loadLedger,
  writeLedger,
  maskQuotedMarkerRegions,
} from "./reject-streak.mjs";
// HYK-257-done-stamp-2 §2 범위2 ⓑ: the ONE real, already-production-wired
// anchor for a machine dropped_at stamp -- 관제실 dispatch-worker.ps1
// (읽기 전용, 이 저장소 밖 실측 원문, 아래 bestEffortStampDroppedAt 헤더
// 인용)이 배달 직전 항상 이 CLI를 부른다(`& node $gateScript $roleTaskFile
// --expect-repo-root $Worktree`). in-repo function import, follows this
// file's existing sibling-module pattern (reject-streak.mjs 등) -- not a
// subprocess spawn, because stampDroppedAt has zero side-effect imports of
// its own and this file already statically imports several siblings.
//
// HYK-257-done-stamp-lint-1: imports from `./dropped-at-stamp-core.mjs`
// (scripts/check -> scripts/check, same directory), NOT
// `../relay/stamp-dropped-at.mjs` -- the latter direction (scripts/check
// importing scripts/relay) is this repo's ESLint no-restricted-imports
// architecture rule (A3 inventory, HYK-148: "real dependency direction is
// relay -> check only"), which real production commit-gate (pre-commit
// quality-check) enforces and previously blocked exactly this import.
// scripts/relay/stamp-dropped-at.mjs itself now re-exports from this same
// core file (relay -> check, the allowed direction) -- see that file's own
// header. Zero behavior change: same function, same contract, only the
// module boundary moved.
import { stampDroppedAt } from "./dropped-at-stamp-core.mjs";
// HYK-244-receipt-wire-2b2 §3-1: 1R 승인·커밋분(consumption-receipt-
// core.mjs) 판정 로직을 그대로 쓴다(⛔코어 무변경). zero-import 코어라
// 이 import 자체가 어떤 새 전이 의존성도 끌어들이지 않는다(그 파일
// 자신의 zero-import 시험이 그 계약을 고정한다). hyk241-oneb-gate-
// mutation.test.mjs가 이 파일을 고정 4파일 목록으로 격리 clone하므로,
// 그 목록에 이 파일도 추가했다(아래 커밋 diff의 시험 파일 참고) --
// relay-handshake.mjs 쪽(2R-a)이 정적 import를 피한 것과 다른 선택:
// 그쪽은 같은 파일을 격리하는 mutation 시험이 6개나 있어 전부 갱신하는
// 것보다 spawn이 더 저렴했지만, 여기는 격리 시험이 1개뿐이라 그 시험의
// 고정 목록에 한 줄 추가하는 쪽이 더 저렴하고, dispatch-gate-decision.mjs
// 자신이 이미 여러 형제 모듈을 정적 import하는 파일이라(reject-streak.mjs
// 등) 이 파일에서는 애초에 "정적 import 회피"가 기존 관례도 아니다.
import { toConsumptionGateDecision } from "./consumption-receipt-core.mjs";
// HYK-298-abort-record-1 §2-2: 이 파일이 이미 세운 "판정 코어는 zero-
// import, 사실 추출은 이 어댑터 파일이 한다" 선례(바로 위 consumption-
// receipt-core.mjs와 동일 구조)를 그대로 따른다. ⛔이 새 import는 이
// 파일을 격리 clone하는 기존 mutation 시험(hyk241-oneb-gate-mutation.
// test.mjs · dispatch-gate-consumption-wire.test.mjs · hyk263-archive-
// doneat.test.mjs)의 고정 파일 목록에도 함께 추가했다(안 하면 그
// 시험들의 모듈 로드 자체가 MODULE_NOT_FOUND로 깨진다 -- 바로 위
// CONSUMPTION_RECEIPT_CORE_PATH 추가 때와 같은 이유, 그 시험 파일들
// 자신의 주석 참조).
import { checkAbortRecord, ABORT_RECORD_STATE } from "./abort-record-core.mjs";
// HYK-311-retire-1 §2: same zero-import-core / adapter-extracts-facts
// precedent as abort-record-core.mjs directly above (own closed state set,
// own JSON directory `.harness/retirements/`) -- this is a SEPARATE axis,
// does NOT touch abort-record-core.mjs's MISSING-label-only scope. ⛔this
// new import is also added to the fixed-file-list mutation tests that
// isolate-clone this file (hyk241-oneb-gate-mutation.test.mjs ·
// dispatch-gate-consumption-wire.test.mjs · dispatch-gate-abort-wire.test.mjs ·
// hyk263-archive-doneat.test.mjs · hyk298-3r-envelope-fixtures.test.mjs),
// same reasoning as the ABORT_RECORD_CORE_PATH addition in each of those
// files' own comments.
import {
  checkRetirementRecord,
  RETIREMENT_RECORD_STATE,
} from "./retirement-record-core.mjs";
// HYK-457 §3-A: confirmRetirementBlockReason (and its
// RUNNER_GREEN_UNREACHABLE_AT_HEAD-only helper) used to be defined in this
// file, with a byte-drifted twin in admission-completion-adapter.mjs -- see
// retirement-block-reason-shared.mjs's header for the merge rationale.
import { confirmRetirementBlockReason } from "./retirement-block-reason-shared.mjs";
// HYK-307-order-1 §1: the delivery-time round-task snapshot (§ bestEffortSnapshotRoundTaskFile
// below) reuses this existing, already-tested preservation primitive
// (envelope-archive.mjs, HYK-204/HYK-241) rather than inventing a second
// archive mechanism -- scripts/check -> scripts/check, same allowed
// direction this file already uses for every other sibling import above.
import {
  archiveRoundTaskFileIfNew,
  classifyArchivedDispatchId,
  // HYK-461 §4-A: the envelope-binding read-back validator is now single-
  // sourced in its producer module (see that function's header) rather than
  // copied here -- this file and admission-completion-adapter.mjs both import
  // the one definition, killing the copy that HYK-456 §5-1 found the adapter
  // was missing entirely.
  resolveEnvelopeBindingValidity,
} from "./envelope-archive.mjs";
// HYK-239: reject-streak-chain.mjs's tamper-detection engine has existed
// since HYK-218 with zero production callers (§0 실측). This is the wiring
// -- NOT reject-streak.mjs/relay-handshake.mjs/review-gate.mjs, which the
// 9 mutation tests reject-streak-chain.mjs's own header comment names copy
// those three files into isolated tmpdirs that do not include this sidecar
// module (a sibling import there breaks all 9 with MODULE_NOT_FOUND).
// dispatch-gate-decision.mjs is never copied by any of those tests (every
// test that touches it imports the real file by URL, see
// dispatch-gate-decision.test.mjs/activation-dependency-core.test.mjs) and
// it already runs on EVERY dispatch (관제실 dispatch-worker.ps1 calls this
// CLI before injecting a task, see file header) -- the one place a chain
// check both runs every round and cannot be starved by the mutation-test
// copy mechanics.
import {
  loadChainLedger,
  catchUpCheckpoints,
  writeChainLedger,
  checkAppendOnly,
} from "./reject-streak-chain.mjs";

const REJECT_STREAK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "reject-streak.mjs",
);

// 2R/3R §2: the SAME structural facts checkGatePreconditions needs,
// extracted here (I/O + regex on the task file's own text) so the pure core
// never has to touch a filesystem. Mirrors reject-streak.mjs's own
// TASK_ID_LINE_RE/ISSUE_ID_RE *shape* (a task_id header line, an
// HYK-<digits> prefix) without importing them -- reject-streak.mjs does not
// export those regexes and 2R/3R §1/§6 forbid editing it to add an export;
// this is INPUT validation on the task file (a precondition check), not a
// reimplementation of reject-streak.mjs's own gate/envelope DECISION logic,
// which stays untouched and unduplicated.
//
// 3R: uses a GLOBAL match (matchAll) instead of 2R's single `.match()` --
// 2R only asked "is there a task_id line;" 3R's confirmative model requires
// "is there EXACTLY ONE" (반례 6: reject-streak.mjs's own non-global regex
// silently uses the FIRST match when there are two, ignoring the second
// line's streak-relevant content -- this CLI must see the true count to
// reject that ambiguity instead of inheriting the sub-gate's leniency).
const TASK_ID_LINE_RE_G = /^task_id:\s*(\S+)/gim;
const ISSUE_ID_PREFIX_RE = /^HYK-\d+/;
const ISSUE_ID_CAPTURE_RE = /^(HYK-\d+)/;
// HYK-383 2R §2: mirrors relay-handshake.mjs's own consumption-side
// HEAD_COMMIT_RE_G exactly(column-0 독립 줄, `[ \t]*`로 개행을 삼키지
// 않는다) -- ⛔`i` 플래그 없음(2R이 좁히는 신원: 정확히 소문자
// `head_commit:`만 표지로 인정한다, 대문자 `HEAD_COMMIT:`는 더 이상
// 아니다). ANYWHERE는 근사매치 진단 전용(매치 채택에는 절대 쓰지 않는다,
// TASK_ID_ANYWHERE_RE와 동일한 역할) -- 대소문자 무관하게 유지한다: 이
// 축은 "표지를 쓰려는 흔적이 있는데 형식이 깨졌다"(대문자 포함)와 "표지
// 자체가 없다"를 가르는 진단일 뿐, 대문자를 통과시키는 문이 아니다.
const DISPATCH_HEAD_COMMIT_RE_G =
  /^head_commit:[ \t]*([0-9a-fA-F]{40})[ \t]*$/gm;
const DISPATCH_HEAD_COMMIT_ANYWHERE_RE = /head_commit:\s*(\S+)/i;

function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n");
}

function extractTaskIdFacts(taskText) {
  const text = normalizeNewlines(taskText);
  const matches = [...text.matchAll(TASK_ID_LINE_RE_G)];
  const taskIdMatchCount = matches.length;
  const soleValue = taskIdMatchCount === 1 ? matches[0][1] : null;
  const taskIdFormatValid =
    soleValue !== null && ISSUE_ID_PREFIX_RE.test(soleValue);
  const issueIdMatch =
    soleValue !== null ? soleValue.match(ISSUE_ID_CAPTURE_RE) : null;
  return {
    taskIdMatchCount,
    taskIdFormatValid,
    issueId: issueIdMatch ? issueIdMatch[1] : null,
  };
}

// HYK-241 §2 조각2: same normalize/regex idiom as extractTaskIdFacts above --
// input validation on the task packet's own text, never a reimplementation
// of another module's decision logic. Anchored `^...$` column-0 lines,
// mirroring `task_id:`/`dropped_at:` throughout this codebase. Kept as a
// SEPARATE extraction (not folded into extractTaskIdFacts) so that
// function's existing return shape stays untouched.
const ONE_B_EXEC_RE = /^1b_exec_line:\s*(\S.*)$/im;
const ONE_B_SHOWN_RE = /^1b_shown:\s*(\S.*)$/im;
const ONE_B_REACH_RE = /^1b_reach_path:\s*(\S.*)$/im;
const ONE_B_PREREQ_RE = /^1b_prerequisite_for:\s*(\S.*)$/im;
// ⛔"아무 문장이나 있으면 통과"를 막기 위한 최소 서술 길이(코더-task §2 조각2
// 비타협). 정확한 값 자체는 판단이므로, 이 상수 하나로 좁혀 결과 파일에서
// 근거를 밝힌다.
const ONE_B_PREREQ_MIN_LEN = 10;

function extractOneBFacts(taskText) {
  const text = normalizeNewlines(taskText);
  const missingA = [];
  if (!ONE_B_EXEC_RE.test(text)) missingA.push("1b_exec_line");
  if (!ONE_B_SHOWN_RE.test(text)) missingA.push("1b_shown");
  if (!ONE_B_REACH_RE.test(text)) missingA.push("1b_reach_path");
  const prereqMatch = text.match(ONE_B_PREREQ_RE);
  const prereqValue = prereqMatch ? prereqMatch[1].trim() : null;
  return {
    aComplete: missingA.length === 0,
    missingA,
    bDeclared: prereqValue !== null,
    bValid: prereqValue !== null && prereqValue.length >= ONE_B_PREREQ_MIN_LEN,
  };
}

// HYK-383 2R §2: extracts the structural facts checkHeadCommitPrecondition
// needs from the ABOUT-TO-BE-DELIVERED task packet's own text -- mirrors
// extractOneBFacts's shape immediately above (S8: the pure core never
// touches a filesystem). ⛔only applies to REVIEW-family deliveries
// (isReviewRole, caller-derived from the task path's own filename, same
// role-derivation this file already uses everywhere else) -- CODER/VERIFY/
// PM callers never even reach the read below.
//
// Reads `taskPath` INDEPENDENTLY (not reusing a caller-supplied taskText)
// so a genuine read failure at exactly this check's own moment (permission
// change, file replaced mid-flight -- this repo's own TOCTOU-conscious
// convention, see resolveRepoRoot's header above) is observable as its own
// distinct REJECT_HEAD_COMMIT_UNREADABLE state, not silently absorbed into
// whatever an earlier, already-successful read happened to see.
function extractHeadCommitFacts(taskPath, role) {
  const isReviewRole = typeof role === "string" && /^review/i.test(role);
  if (!isReviewRole) {
    return { isReviewRole: false };
  }
  let text;
  try {
    text = readFileSync(taskPath, "utf8");
  } catch (err) {
    return {
      isReviewRole: true,
      readOk: false,
      readErrorReason: firstNonEmptyErrorText(err),
    };
  }
  const normalized = normalizeNewlines(text);
  const matches = [...normalized.matchAll(DISPATCH_HEAD_COMMIT_RE_G)];
  return {
    isReviewRole: true,
    readOk: true,
    headCommitMatchCount: matches.length,
    headCommitNearMissPresent:
      matches.length === 0 && DISPATCH_HEAD_COMMIT_ANYWHERE_RE.test(normalized),
  };
}

function runGateSubcommand(sub, taskPath, ledgerArgs) {
  try {
    const stdout = execFileSync(
      "node",
      [REJECT_STREAK_PATH, sub, taskPath, ...ledgerArgs],
      { encoding: "utf8" },
    );
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      // execFileSync throws on non-zero exit; err.status carries the real
      // code, err.status===undefined/null when the child died by signal
      // rather than exiting -- decideFromGateExit's REJECT_UNKNOWN_EXIT
      // branch is exactly for that case, so we pass it through as-is
      // rather than coercing it to a number.
      exitCode: err.status ?? null,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message ?? ""),
    };
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ledger") out.ledger = argv[++i];
    else if (argv[i] === "--expect-repo-root") out.expectRepoRoot = argv[++i];
    else if (argv[i] === "--chain") out.chain = argv[++i];
    // HYK-244-receipt-wire-2b2 §3-2: mirrors --ledger/--chain's own
    // arg-with-env-fallback shape (resolveDispatchReceiptPath below reads
    // the env fallback) -- ⛔관제실 절대경로 하드코딩 금지, 경로는
    // 인자/환경으로만 받는다.
    else if (argv[i] === "--dispatch-receipt-path")
      out.dispatchReceiptPath = argv[++i];
    // HYK-298-abort-record-1 §2-2: --dispatch-receipt-path와 같은
    // arg-with-env-fallback 모양(resolveAdmissionLedgerPathForAbort가 env
    // 폴백을 읽는다) -- ⛔관제실 절대경로 하드코딩 금지, 경로는
    // 인자/환경으로만 받는다. admission-completion-adapter.mjs의 영속
    // 포인터 폴백(mainRepoRoot 기반)은 재사용하지 않는다(§4 범위 밖:
    // 그 파일의 ADMISSION_LEDGER_PATH 폴백 동작 자체를 바꾸지 말라는
    // 지시가 있고, 이 축은 읽기 전용 판정이라 그 복잡한 폴백 없이도
    // 안전측(레코드 없음 취급)으로 물러날 수 있다).
    else if (argv[i] === "--admission-ledger-path")
      out.admissionLedgerPath = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

// HYK-239: mirrors reject-streak-chain.mjs's own CLI default (sidecar lives
// next to the ledger, same basename swap) -- `--chain` is an explicit
// override for tests/tooling, same shape as `--ledger`'s own override.
function resolveChainPath(args, ledgerPath) {
  return args.chain || join(dirname(ledgerPath), "reject-streak-chain.json");
}

function firstNonEmptyErrorText(err) {
  const text = String(err?.stderr ?? err?.message ?? err ?? "").trim();
  return text.length > 0 ? text : "(no detail)";
}

// HYK-220 1R->2R: 1R's dirname(taskPath) default (2R 검토 실측이 고친 CWD
// 기반보다는 나았다) still ties the ledger to THIS worktree's OWN
// `.harness/`, so a linked worktree with its own (e.g. freshly-created,
// streak-reset) local ledger file silently wins over the real, shared
// history -- that is the 2R 검토 P1 근거 B 우회. This resolves the ledger by
// asking git itself where the CURRENT repo's shared (`--git-common-dir`)
// storage lives, which is identical across every worktree of the same
// repo (main or linked) -- so the ledger converges on one file per repo
// regardless of which worktree a task was dropped into.
//
// P1-3 (bare 경계, 검토 실측): a linked worktree off a BARE repo has
// `--git-common-dir` return the bare repo's OWN directory (e.g.
// `.../repo.git`), not a nested `.git` folder -- `dirname()` on that value
// silently lands one level too high. `--is-bare-repository` (run with
// `--git-dir` pointed at the resolved common dir, so it asks about THAT
// repository regardless of the caller's own CWD) distinguishes the two
// shapes: bare -> the common dir itself is the root; non-bare -> its parent
// is the root (this repo, HARNESSENGINEERING, is the non-bare shape).
// HYK-221 축1 (검토 실측): execFileSync's stderr is, by Node's own default,
// piped to the PARENT process's real stderr in addition to being captured
// on the thrown error object -- so a git failure here (e.g. "not a git
// repository") used to leak raw git text onto this CLI's own stderr stream,
// ahead of and separate from the clean, single-reason-per-line contract the
// rest of this module promises. `stdio: ["ignore", "pipe", "pipe"]` keeps
// the capture (still available via `err.stderr` for firstNonEmptyErrorText)
// while suppressing that inherited passthrough -- this call becomes visible
// far more often once resolveLedgerPath (below) starts probing taskPath's
// repo even on the `--ledger`-only path, so a failure here is no longer a
// rare edge case this leak could stay hidden behind.
function resolveRepoRoot(dir) {
  const stdio = ["ignore", "pipe", "pipe"];
  let commonDir;
  try {
    commonDir = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio },
    ).trim();
  } catch (err) {
    return { root: null, detail: firstNonEmptyErrorText(err) };
  }
  let isBare;
  try {
    isBare = execFileSync(
      "git",
      ["--git-dir", commonDir, "rev-parse", "--is-bare-repository"],
      { encoding: "utf8", stdio },
    ).trim();
  } catch (err) {
    return { root: null, detail: firstNonEmptyErrorText(err) };
  }
  return {
    root: isBare === "true" ? commonDir : dirname(commonDir),
    detail: null,
  };
}

// Windows paths differ only by drive-letter case / slash direction /
// trailing slash between two calls that both, in fact, name the same repo
// root -- normalize before comparing so those never register as a mismatch.
function normalizeRootForCompare(root) {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// HYK-220 2R: replaces 1R's plain string-returning resolveLedgerPath.
// Returns `{ path, state: null }` on success (state:null tells the caller
// "proceed") or `{ path: null, state: <REJECT_*>, reason }` on failure --
// the caller (runDispatchGateDecision) routes a non-null state straight to
// checkLedgerPathResolution and NEVER reaches checkGatePreconditions /
// spawns either gate, same short-circuit shape as the existing
// taskPath-not-found branch.
//
// P1-1 (결속 미증명 + `--ledger` 우회): git succeeding only proves taskPath
// belongs to SOME repo, not the repo the caller intended. `--expect-repo-root`
// is an OPTIONAL caller-supplied fact (dispatch-worker.ps1 already knows
// which worktree it dispatched to); when given, taskPath's OWN resolved
// repo root must match it OR this rejects -- including when `--ledger` is
// ALSO given, so an explicit `--ledger` can no longer walk around the
// membership check by skipping repo resolution entirely (2R 검토 실측: 이전
// 설계에서 `--ledger`는 대조 없이 그대로 우선했다). When
// `--expect-repo-root` is NOT given, this check does not run at all -- an
// additive axis (S11 헤더 ③ 패턴), not a new mandatory requirement on every
// existing caller/test that never passed it. Symmetric with that: an
// explicit `--ledger` WITHOUT `--expect-repo-root` fully bypasses git
// resolution too (zero git calls, byte-identical to 1R/pre-2R behavior) --
// there is nothing to identify taskPath's repo FOR when no default needs
// computing and no expected repo was named to compare against. This keeps
// every existing fixture-based test (plain non-git tmpdirs + explicit
// `--ledger`) working unchanged; only the NO-`--ledger` default-resolution
// path and the `--expect-repo-root` membership check touch git at all.
// HYK-221 축1: an explicit `--ledger` WITHOUT `--expect-repo-root` used to
// return here unconditionally -- zero git calls, zero binding check, the
// ledger path was trusted as-is no matter which repo it actually belonged
// to. That is the exact gap this task's §1 축1 names: a caller (or a
// misconfigured delivery tool) can point `--ledger` at a stale/wrong-repo
// file and this precondition would happily proceed to ALLOW off of it.
// Fix, scoped to avoid the HYK-217 gap#97 shape (a blanket new check
// breaking every existing non-git-tmpdir fixture that never had a real repo
// to bind against): only run the membership check when taskPath itself CAN
// be resolved to a real repo. When it cannot (e.g. every existing
// fixture-based test's plain `mkdtempSync(tmpdir())` directory, which is
// deliberately not a git repo), there is no "current repo" to compare the
// ledger against, so behavior is unchanged -- byte-identical to before this
// fix. In real operation the task file always lives inside a real git
// worktree, so this check is live exactly where the gap actually mattered.
function resolveLedgerPath(args, taskPath) {
  if (args.ledger && !args.expectRepoRoot) {
    const taskRepoForLedger = resolveRepoRoot(dirname(taskPath));
    if (taskRepoForLedger.root === null) {
      return { path: args.ledger, state: null };
    }
    const ledgerRepo = resolveRepoRoot(dirname(args.ledger));
    if (
      ledgerRepo.root === null ||
      normalizeRootForCompare(ledgerRepo.root) !==
        normalizeRootForCompare(taskRepoForLedger.root)
    ) {
      return {
        path: null,
        state: DISPATCH_GATE_STATE.REJECT_REPO_MISMATCH,
        reason: `dispatch-gate-decision precondition: --ledger(${args.ledger})가 taskPath가 속한 저장소(${taskRepoForLedger.root})에 속하지 않음(${ledgerRepo.root === null ? `원인: ${ledgerRepo.detail}` : `실제: ${ledgerRepo.root}`}) -> 배달 거부(안전측 기본값 -- --expect-repo-root 없이 --ledger 만 주어졌다고 결속을 건너뛰지 않는다). 조치: --ledger가 taskPath와 같은 저장소를 가리키는지, 또는 --expect-repo-root를 함께 넘기는지 확인하라`,
      };
    }
    return { path: args.ledger, state: null };
  }
  const taskRepo = resolveRepoRoot(dirname(taskPath));
  if (taskRepo.root === null) {
    return {
      path: null,
      state: DISPATCH_GATE_STATE.REJECT_LEDGER_PATH_UNRESOLVABLE,
      reason: `dispatch-gate-decision precondition: taskPath가 속한 git 저장소를 식별하지 못함(대상 디렉터리: ${dirname(taskPath)}) -> 배달 거부(안전측 기본값 -- 원장 "부재"와는 다른 원인: 원장을 찾을 저장소 자체를 확정 못 했다). 원인: ${taskRepo.detail}. 조치: taskPath가 git 워크트리 안에 있는지, git 실행파일을 호출할 수 있는지 확인하라`,
    };
  }
  if (args.expectRepoRoot) {
    const expectedRepo = resolveRepoRoot(args.expectRepoRoot);
    if (expectedRepo.root === null) {
      return {
        path: null,
        state: DISPATCH_GATE_STATE.REJECT_LEDGER_PATH_UNRESOLVABLE,
        reason: `dispatch-gate-decision precondition: --expect-repo-root(${args.expectRepoRoot})가 속한 git 저장소를 식별하지 못함 -> 배달 거부(안전측 기본값). 원인: ${expectedRepo.detail}. 조치: --expect-repo-root 값이 실제 git 워크트리 경로인지 확인하라`,
      };
    }
    if (
      normalizeRootForCompare(expectedRepo.root) !==
      normalizeRootForCompare(taskRepo.root)
    ) {
      return {
        path: null,
        state: DISPATCH_GATE_STATE.REJECT_REPO_MISMATCH,
        reason: `dispatch-gate-decision precondition: taskPath가 속한 저장소(${taskRepo.root})가 기대 저장소(--expect-repo-root -> ${expectedRepo.root})와 다름 -> 배달 거부(안전측 기본값 -- --ledger 를 명시로 넘겼어도 이 대조를 건너뛰지 않는다). 조치: 배달 도구가 지금 조작 중인 워크트리 경로를 --expect-repo-root로 넘기는지 확인하라`,
      };
    }
  }
  return {
    path: args.ledger || join(taskRepo.root, ".harness", "reject-streak.json"),
    state: null,
  };
}

// 2R/3R §2 (P1-B / confirmative redesign): fail-closed precondition check
// BEFORE spawning either gate subprocess -- if this fails, the real gates
// are never called at all (checkGatePreconditions' reason is the ONLY
// decision). Extracted from runDispatchGateDecision to keep that function
// under the repo's ESLint complexity/line-count ceiling (quality-check).
function evaluatePrecondition(taskPath, ledgerPath) {
  const taskText = readFileSync(taskPath, "utf8");
  const { taskIdMatchCount, taskIdFormatValid, issueId } =
    extractTaskIdFacts(taskText);
  const ledgerExists = existsSync(ledgerPath);
  const loaded = ledgerExists ? loadLedger(ledgerPath) : null;
  // 3R 반례 7: only meaningful once ledger loaded AND issueId uniquely
  // resolved -- if either is false, a higher-priority check in
  // checkGatePreconditions (task_id/ledger-readability) already rejects
  // before this fact is ever consulted, so an "invalid" placeholder here is
  // inert, never itself the deciding reason.
  const entryShape =
    loaded?.ok === true && issueId !== null
      ? checkLedgerEntryShape(loaded.ledger, issueId)
      : { valid: false, reason: "(전제조건 미충족, 이 확인은 도달하지 않음)" };
  const precondition = checkGatePreconditions({
    taskIdMatchCount,
    taskIdFormatValid,
    ledgerExists,
    ledgerLoadOk: loaded?.ok ?? false,
    ledgerLoadReason: loaded?.reason,
    ledgerEntryShapeValid: entryShape.valid,
    ledgerEntryShapeReason: entryShape.reason,
  });
  return { precondition, loaded, issueId };
}

// HYK-239: the wiring. Runs once per dispatch, after the precondition check
// and the two reject-streak.mjs gate subprocesses have already confirmed
// this task is well-formed and the primary ledger is readable --
// `primaryLedger`/`issueId` here are the SAME values `runGatesAgainstSnapshot`
// just judged, not a second independent read (no new TOCTOU window).
//
// Two-step, same order the hash-chain literature uses: verify what is
// ALREADY checkpointed first (that is where tamper detection lives -- see
// checkAppendOnly), THEN extend the sidecar to cover whatever the primary
// ledger grew to since the last time this ran (catchUpCheckpoints, pure --
// only appends, never rewrites an already-verified entry). Extending AFTER
// verifying means a checkpoint can only ever be added for an entry that was
// itself just cross-checked as live-consistent one line above.
//
// §2 requirement 2 (판정 불가 ≠ 정상): a chain sidecar that exists but is
// unreadable/corrupt is fail-closed here (REJECT_CHAIN_UNJUDGABLE, its OWN
// state -- never folded into REJECT_CHAIN_TAMPER_DETECTED's "content is bad"
// meaning, nor into ALLOW). This diverges from reject-streak-chain.mjs's own
// CLI (which fail-OPENs on the same load failure, exit 0, matching
// reject-streak.mjs's convention) because THIS module's surrounding contract
// (dispatch-gate-decision-core.mjs's documented default-reject stance,
// checkGatePreconditions's five confirmations) is fail-closed throughout --
// an ambiguous sidecar is exactly the kind of "cannot confirm" case that
// stance already treats as REJECT, not a special exception carved out for
// this one axis.
// Split out of evaluateChainDecision below purely to keep that function's
// own cyclomatic complexity under the repo's ESLint ceiling (same reason
// reject-streak-chain.mjs/reject-streak.mjs extract their own helpers) --
// no behavior change, same order, same values.
function extendChainCheckpoints(chainPath, primaryLedger, chain, issueId) {
  const before = chain?.issues?.[issueId]?.entries?.length ?? 0;
  const nextChain = catchUpCheckpoints(primaryLedger, chain, issueId);
  const after = nextChain.issues?.[issueId]?.entries?.length ?? 0;
  if (after !== before) {
    writeChainLedger(chainPath, nextChain);
  }
  return { before, after };
}

function evaluateChainDecision({ chainPath, primaryLedger, issueId }) {
  const loadedChain = loadChainLedger(chainPath);
  if (!loadedChain.ok) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_CHAIN_UNJUDGABLE,
      allow: false,
      reason: `dispatch-gate-decision chain: ${loadedChain.reason} -> 배달 거부(안전측 기본값 -- 사이드카 판정 불가는 "정상"으로 접지 않는다). 조치: 사이드카(${chainPath})를 복구하거나, 손상이 확실하면 별도 판단으로 재구축하라`,
    };
  }
  const verify = checkAppendOnly({
    primaryLedger,
    chain: loadedChain.chain,
    issueId,
  });
  if (verify.status === "BLOCK") {
    return {
      state: DISPATCH_GATE_STATE.REJECT_CHAIN_TAMPER_DETECTED,
      allow: false,
      reason: `dispatch-gate-decision chain: BLOCK -> 배달 거부 -- ${verify.reason}`,
    };
  }
  const { before, after } = extendChainCheckpoints(
    chainPath,
    primaryLedger,
    loadedChain.chain,
    issueId,
  );
  return {
    state: DISPATCH_GATE_STATE.ALLOW,
    allow: true,
    reason: `dispatch-gate-decision chain: PASS -> 배달 허용 -- ${verify.reason} (checkpoint ${before} -> ${after})`,
  };
}

// 4R §3 (TOCTOU): checkGatePreconditions already judged `loadedLedger` --
// the in-memory object from THIS process's single read of ledgerPath. The
// two gate subcommands below are SEPARATE processes that would otherwise
// re-read the SAME live ledgerPath themselves; if the file on disk changes
// in the window between our read and their read (검토 실측: `streak`
// rewritten to 0 mid-flight via NODE_OPTIONS), the precondition's
// confirmation and the gates' actual verdict would be judging two
// DIFFERENT ledger states. Fix (한용 지시 "단일 읽기" 선택): materialize the
// ALREADY-VALIDATED in-memory ledger to a private, freshly-created
// snapshot file, and point BOTH gate subcommands at that snapshot instead
// of the live path -- they still "re-read" (separate processes,
// unavoidable), but what they read is now the frozen content this process
// already confirmed, not whatever the live file happens to contain at that
// moment. This closes the window between confirmation and gate execution;
// it does NOT (and cannot) close the earlier window between this
// process's OWN read of the live ledger and a concurrent writer's
// non-atomic write to that same file -- reject-streak.mjs's writeLedger()
// uses a plain writeFileSync, not an atomic rename, and this track cannot
// touch that file (§1/§6). A snapshotDir cleanup failure is logged, never
// allowed to change the verdict already decided from the (already-
// executed) gate results.
function runGatesAgainstSnapshot(taskPath, loadedLedger) {
  const snapshotDir = mkdtempSync(
    join(tmpdir(), "dispatch-gate-decision-snapshot-"),
  );
  const snapshotLedgerPath = join(snapshotDir, "reject-streak.json");
  writeLedger(snapshotLedgerPath, loadedLedger);
  const snapshotLedgerArgs = ["--ledger", snapshotLedgerPath];
  try {
    const gateResult = runGateSubcommand("gate", taskPath, snapshotLedgerArgs);
    const diagResult = runGateSubcommand(
      "diagnostic-gate",
      taskPath,
      snapshotLedgerArgs,
    );
    return [
      decideFromGateExit({ ...gateResult, label: "reject-streak gate" }),
      decideFromGateExit({
        ...diagResult,
        label: "reject-streak diagnostic-gate",
      }),
    ];
  } finally {
    try {
      rmSync(snapshotDir, { recursive: true, force: true });
    } catch (err) {
      console.error(
        `dispatch-gate-decision: snapshot cleanup failed (non-fatal, verdict already decided): ${err.message}`,
      );
    }
  }
}

// ===========================================================================
// HYK-244-receipt-wire-2b2 §3 -- 소비 완료 영수증 축 결선.
//
// ⛔코어(consumption-receipt-core.mjs)의 판정 로직은 건드리지 않는다 --
// 이 섹션 전체는 "이미 벌어진 사실을 코어가 요구하는 facts 모양으로
// 구조화해서 넘기기"만 한다(S8과 같은 원칙, checkOneBPrecondition이
// extractOneBFacts의 결과만 받는 이 파일 자신의 기존 구조와 동일).
//
// «직전 결과가 소비됐는가»의 대상: dispatch-worker.ps1이 이 CLI를 호출하는
// 시점은 NEW task 파일을 쓰기 *전*이므로, 이 시점의 taskPath는 여전히
// 방금 끝난 라운드 자신의 task 파일이다. 그 라운드의 binding(taskId·
// droppedAt)은 taskPath 자체에서, doneAt·resultFingerprint는 같은
// 디렉터리의 형제 결과 파일(`<role>.md`)에서 뽑는다 -- checkRelayHandshake
// 가 성공 판정을 내릴 때 참조하는 바로 그 두 파일이다.
// ===========================================================================

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// taskPath의 파일명 관례(`<role>-task.md`)에서 role을 뽑는다 -- relay-
// handshake.mjs가 이미 매 라운드 이 관례로 파일을 여닫으므로 새 관례가
// 아니다. 매치 실패(예상 밖 파일명)면 null -- 이 축을 적용할 대상이
// 무엇인지조차 모른다는 뜻이므로, 아래 evaluateConsumptionDecision이
// 이 경우 축 자체를 건너뛴다(거부도 허용도 지어내지 않는다).
function deriveRoleFromTaskPath(taskPath) {
  const base = taskPath.replace(/\\/g, "/").split("/").pop() ?? "";
  const m = base.match(/^(.+)-task\.md$/i);
  return m ? m[1] : null;
}

// HYK-298-abort-record-2 §2-2: `\s*`(원래 정규식) 대신 `[ \t]*`(수평
// 공백만) -- `\s*`는 줄바꿈도 먹어서, `task_id:` 뒤가 같은 줄에서
// 비어 있으면(예: `task_id:\nverdict: approved`) 다음 줄의 값을 그대로
// 집어 왔다(검토 실측: `whitespace_crossline`에서 `label=verdict:`).
// 값 추출을 같은 줄 안으로 한정한다 -- 이 상수는
// findArchivedDroppedAt/findArchivedResultFingerprint(아카이브 사본의
// task_id 대조)에서도 재사용되므로 그 두 자리도 함께 고쳐진다(같은
// 종류의 크로스라인 오추출을 막는 것이므로 개선이지 회귀가 아니다).
// ⛔`CONSUMPTION_DONE_RE_G`(바로 아래)는 건드리지 않는다 --
// doneAt 추출은 이 축(§2-1의 "이름표 없음/깨짐" 판별) 대상이 아니고,
// 지시서 §2-2가 "다른 축의 기존 동작을 깨뜨리지 마라"고 명시했다.
const CONSUMPTION_TASK_ID_RE_G = /^task_id:[ \t]*(\S+)/gim;
const CONSUMPTION_DROPPED_AT_RE = /^dropped_at:\s*(.+)$/im;
const CONSUMPTION_DONE_RE_G = /^>>>\s*DONE:.*@\s*(.+?)\s*$/gim;
// HYK-457: CONSUMPTION_HEAD_COMMIT_RE_G used to live here, for the sole use
// of confirmRunnerGreenUnreachableAtHead -- both moved to
// retirement-block-reason-shared.mjs (see that file's own copy/header).

// relay-handshake.mjs의 resolveResultTaskId/resolveResultDoneMatch와
// 동일한 "유일한 매치 하나만 채택, 0개·2개 이상이면 지어내지 않고
// undefined로 물러난다" 규칙을 그대로 복제한다(그 두 함수는 export되지
// 않는다 -- 그리고 어차피 이 축이 필요한 것은 값 하나뿐, 그 파일의
// 전체 handshake 판정이 아니다).
function extractSoleMatch(text, reG) {
  const matches = [...text.matchAll(reG)];
  return matches.length === 1 ? matches[0][1].trim() : undefined;
}

// HYK-468: header-task-id-shared.mjs의 resolveHeaderTaskId와 **로직 동일**
// (이 파일도 admission-completion-adapter.mjs와 같은 이유로 로컬 복제다 --
// dispatch-gate-abort-wire.test.mjs·dispatch-gate-consumption-wire.test.mjs·
// hyk263-archive-doneat.test.mjs·hyk298-3r-envelope-fixtures.test.mjs·
// hyk396-open-axis.test.mjs 등 이 파일 소스를 고정 파일 목록으로 격리
// 스테이징하는 mutation 시험이 다수 있어, 새 import를 추가하면
// MODULE_NOT_FOUND로 깨진다, 실측 확인). 세 곳(이 함수 + adapter의 로컬
// 복제 + header-task-id-shared.mjs 정본)이 갈라지면 회귀이므로 고칠 때는
// 반드시 서로 대조하라.
//
// task_id: 선언은 «구조적 선행 맥락»이 있는 줄에서만 읽는다 -- 그
// 바로 앞(빈 줄은 건너뛰고) 줄이 다른 헤더 줄(`key:` 형태)이거나
// `>>>` 표지이거나 파일 맨 앞이면 «진짜», 산문이 선행하면 «인용/예시»로
// 본다. round-archive 파일(rounds/<role>-r<N>.md 등) 본문에 산문으로
// 소개된 뒤 그대로 인용된 `task_id:` 줄이 진짜 선언과 충돌해 "2개"로
// 잘못 세는 사고를 막는다(실사고 재현: 검토자가 실제 exported
// resolveResultTaskId에 이 모양을 주입해 AMBIGUOUS를 재현했다).
//
// ⚠️1R 초안(첫 빈 줄 이전만 보는 "헤더 블록" 한정)은 실제로 회귀였다 --
// 빈 줄로 나뉜 두 개의 «진짜» task_id: 블록(옛 라운드 유지 + 새 라운드
// 추가, 산문 없음, HYK-183과 같은 사고 모양)을 헤더 블록 밖이라는 이유로
// 못 보고 스테일 값으로 조용히 확정해 버렸다(전체 러너 실측:
// nc-relay-handshake.test.mjs의 NC-2 RED). 빈 줄 위치만으로는 그 둘을
// 가를 수 없다 -- 자세한 이유와 두 사고 모양의 대조는
// header-task-id-shared.mjs 헤더 주석 참조(그 파일이 이 로직의 정본).
//
// ⚠️두 번째 실측 회귀(같은 라운드): envelope-archive.mjs가 아카이브
// 사본(rounds/<role>-task-r<N>.md 등)에 붙이는 `<!-- envelope-archive:
// ... -->` 헤더는 "그 앞 줄이 구조적인가"만 볼 때는 실선언을 가로막고,
// "`<!--`로 시작하면 무조건 구조적"으로 볼 때는 반대로 hyk396-dispatch-
// stamp.test.mjs (o)가 합성한 «일부러 깨진» 다줄 주석(닫는 `-->`가
// 다음 줄로 밀려난 모양, 검토자 실증 재현)까지 구조적으로 봐 버려 그
// 시험이 지키려는 "손상은 정말로 손상으로 보여야 한다"는 축이 사라진다.
// 올바른 축은 «주석 자체를 지우고 남는가»다 -- reject-streak.mjs의
// maskQuotedMarkerRegions(HYK-449, 펜스·HTML 주석을 여러 줄에 걸쳐
// 정확히 인식해 공백으로 지운다)를 이 검사 «이전»에 먼저 돌리면, 정상
// 주석이든 깨진 다줄 주석이든 전부 공백 줄이 되어 "빈 줄과 똑같이
// 건너뛴다"(아래 hasStructuralPredecessor의 `lines[i].trim() === ""`가
// 이미 그렇게 처리한다) -- 그래서 정상 주석 뒤의 실선언은 살고, 깨진
// 주석은 애초에 이 축에 걸리지 않아 classifyArchivedDispatchId 등 그
// 손상을 실제로 겨눈 검사가 여전히 REJECT를 낸다.
//
// HYK-468 3R (P1-2 표적 2, 검토자 반려 재수리): 이 정규식을 인라인으로
// 두면 정본 header-task-id-shared.mjs와 "바이트 동일"함을 기계로 대조할
// 자리가 없다. STRUCTURAL_LINE_RE라는 이름의 별도 상수로 뽑아 정본과
// 정확히 같은 텍스트로 둔다(scripts/check/hyk468-3r-copy-drift.test.mjs가
// 이 상수와 hasStructuralPredecessor 본문 둘 다 정본과 바이트 동일함을
// 단정한다) -- 판정 자체는 조금도 바뀌지 않는다.
// HYK-468 4R (P1, 검토자 반려 재수리): 같은 이유로 아래 두 곳
// (resolveHeaderTaskId 본문 + classifyTaskIdLabel의 strictMatches, 검토자
// REVIEW-r28.md가 인용한 872행)이 각자 이 정규식을 인라인으로 반복하고
// 있었다 -- STRUCTURAL_LINE_RE처럼 이름 붙은 상수가 아니라서 드리프트
// 시험의 손으로 고른 비교 목록에 오를 자리가 없었다. 정본
// header-task-id-shared.mjs의 RULE_CONSTANTS.TASK_ID_LINE_RE와 바이트
// 동일하게 이름을 맞추고, 두 호출부 모두 이 하나의 상수를 쓴다.
const TASK_ID_LINE_RE = /^task_id:[ \t]*(\S+)/i;
const STRUCTURAL_LINE_RE = /^[A-Za-z_][\w-]*:|^>>>/;

function hasStructuralPredecessor(lines, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    if (lines[i].trim() === "") continue;
    return STRUCTURAL_LINE_RE.test(lines[i]);
  }
  return true;
}

function resolveHeaderTaskId(content) {
  const lines = maskQuotedMarkerRegions(
    (content ?? "").replace(/\r\n/g, "\n"),
  ).split("\n");
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_ID_LINE_RE);
    if (!m) continue;
    if (!hasStructuralPredecessor(lines, i)) continue;
    candidates.push(m[1]);
  }
  if (candidates.length !== 1) return { ok: false, count: candidates.length };
  return { ok: true, id: candidates[0] };
}

// HYK-298-abort-record-2 §2-1 -- ★공통 문장("없는 것"과 "깨진 것"은
// 다르다) 그대로: `harnessTaskLabel === undefined`(위 extractSoleMatch)
// 하나만으로는 "이름표가 진짜로 하나도 없음"과 "있지만 복수/빈값/줄
// 중간이라 깨짐" 둘 다 undefined로 뭉개진다(검토가 재현한 반려 사유
// ⓐ). 이 함수는 그 둘을 구조적으로 가른다 -- 파일을 다시 읽지 않고
// resultText 하나만 받는 순수 함수(zero side-effect).
//
// HYK-298-label-classify-3 §2-1/2-2 (2R의 부작용 수리, ★공통 문장 그대로
// 재적용 -- "표지는 «줄머리»에 있는 것이다. 글 속에서 그 이름을 «언급»한
// 것은 표지가 아니다"): 2R은 "어디든 등장"(옛 TASK_ID_ANY_RE, 줄 시작
// 여부 무관)까지 세어 그 수가 줄머리 등장 수와 다르면 무조건 BROKEN으로
// 떨어뜨렸다. 그런데 검토 보고서(review.md)·이 코더 보고서(coder.md) 같은
// «정상 라운드 결과 파일»은 자기 몸 안에서 `task_id:`라는 표지 «자체»를
// 산문으로 설명하므로(예: "`task_id:` 줄이 0개·복수개이면 …") 원시
// 출현이 여러 건 생긴다 -- 그 출현은 전부 줄 시작이 아니다(어떤 문장이
// "task_id:"로 시작하는 경우가 없는 한). 그런데도 2R 규칙은 그 정상
// 라운드를 BROKEN으로 오분류해 다음 배달을 영구 차단했다(오늘 실측,
// coder-task.md §1 표). 3R은 그 오분류를 없앴다 -- 판정은 «줄머리»로
// 시작하는 줄의 개수(HYK-468 2R부터는 classifyTaskIdLabel 본문의 인라인
// `/^task_id:.*$/i` 줄별 검사, 예전 이름 TASK_ID_LOOSE_LINE_RE)와, 그
// 줄 안에서의 유효값 개수(CONSUMPTION_TASK_ID_RE_G)를 먼저 본다.
// **`looseLines === 1 &&
// strictCount === 1`(=`VALID`)은 이 질문에 도달조차 하지 않는다** --
// 정상 봉투(오늘 실물 2개: 줄머리 1 + 원시 3·11)는 항상 이 분기에서
// 먼저 걸러진다(HYK-298-label-boundary-5 §2 항ⓐ 요구 "과차단이 재발하지
// 않는 이유를 코드로 보장하라" -- VALID 판정이 아래 원시 재질문보다
// 먼저 오는 순서 자체가 그 보장이다).
//
// HYK-298-label-boundary-5 §2 항ⓐ(4R이 새로 연 구멍의 수리, 검토 실행
// 재현): looseLines === 0(줄머리 표지가 아예 없음)을 곧바로 MISSING으로
// 접으면, ★공통 문장이 이번에 다시 쓴 그대로 "«아예 없는 것»과 «쓰려다
// 잘못 쓴 것»은 다르다"는 구분이 깨진다 -- "참고: task_id: HYK-…"
// (middle_of_line)처럼 줄 중간에만 "task_id:"가 등장하는 라운드는
// **판정 내용이 실제로 든 살아있는 결과**일 수 있는데도, 줄머리에 없다는
// 이유만으로 "진짜 죽은 라운드"와 똑같이 MISSING 취급돼 abort-record
// 축(중단 기록만으로 통과)을 탔다(4R 검토 실측: 중단 기록 붙인 4형태 중
// middle_of_line만 `allow:true`). 그래서 looseLines === 0일 때 **한 번
// 더** 묻는다 -- 파일 어디에든(줄머리 여부 무관) "task_id:" 원시 출현이
// 하나라도 있으면 "쓰려다 잘못 쓴 것"으로 보고 `BROKEN`(차단)이다. 정말
// 한 글자도 없으면(anyCount === 0)만 `MISSING`(중단 기록으로 통과, 진짜
// 아무것도 못 쓰고 죽은 것)이다. ⛔이 재질문은 `looseLines === 0`
// 분기에서만 일어난다 -- `VALID`/그 외 `BROKEN` 분기(줄머리 2개 이상·
// 줄머리 1개인데 같은 줄 값이 비거나 크로스라인으로 새는 경우)는 이미
// 위 3R 규칙 그대로이며 원시 출현 개수와 무관하다(오늘 실물 2봉투가
// 원시 출현 3·11건이어도 여전히 VALID인 이유 -- 이 재질문에 도달하지
// 않는다).
//
// - looseLineIdxs(줄별 `/^task_id:.*$/i` 검사, 옛 이름 TASK_ID_LOOSE_LINE_RE):
//   줄 시작(`^`)에 "task_id:"로 시작하는 줄이 몇 개인지(값의 유효성은
//   무관, ⓐ·ⓑ 대응) 센다.
// - TASK_ID_ANY_RE: 줄 시작 여부와 무관하게 "task_id:"가 파일 어디에나
//   등장하는지 센다 -- `looseLines === 0`일 때만 이 질문을 쓴다(위 설명).
// - CONSUMPTION_TASK_ID_RE_G(위, 같은 줄로 한정됨): 값이 같은 줄 안에
//   실제로 있는(비어 있지 않은) "유효한" 라벨이 몇 개인지 센다.
//
// looseLines === 0이고 anyCount === 0 -> MISSING(진짜 없음). looseLines
// === 0이고 anyCount > 0 -> BROKEN(쓰려다 잘못 씀, 줄 중간 포함).
// looseLines === 1 && strictCount === 1 -> VALID(원시 출현 개수와 무관).
// 나머지 전부(줄머리 2개 이상·줄머리는 1개인데 같은 줄 값이 비었거나
// 크로스라인으로 새는 경우) -> BROKEN. fail-closed 기본은 그대로다.
const TASK_ID_ANY_RE = /task_id:/gi;

// HYK-468 2R (검토자 P1 반려, 정당함): 아래 세 카운트를 전부 resultText
// «전체»가 아니라 그 헤더 블록(첫 빈 줄 이전, 위 headerBlockOf)으로
// 한정한다 -- 코드펜스로 감싸지 않은 채 본문에 그대로 인용한 예시(예:
// "예를 들어 다음과 같은 줄이 주입된다: task_id: HYK-...")가 옛 로직
// 에서는 looseLines를 2로 세어 진짜 선언과 구별되지 않고 BROKEN으로
// 떨어졌다(실사고 재현, admission-completion-adapter.mjs/relay-
// handshake.mjs와 같은 결함 계열). 헤더 블록 밖의 언급은 이 축의 관심사가
// 아니다 -- "표지는 «줄머리»에 있는 것이다"라는 이 함수 자신의 기존
// 철학(위 HYK-298-label-classify-3 주석)을 "그리고 «헤더 블록 안»의
// 줄머리다"로 한 번 더 좁힌 것뿐, 새 철학이 아니다.
// HYK-468 3R §3: 2R 검토자는 이 함수가 공개 export가 아니어서 메모리
// 전용 probe로 우회해야 했다(REVIEW-r27.md "정직 한계"). coder-task.md
// §3의 "export하는 편이 낫다고 판단하면 그렇게 하라"에 따라 이 라운드는
// 테스트 전용으로 export한다 -- classifyTaskIdLabel 자신의 판정 로직은
// 한 글자도 바뀌지 않는다(`export` 키워드만 추가). 이 파일이 이미
// DISPATCH_RECEIPT_LOOKUP_REASON(아래) 등을 시험이 직접 값을 대조할 수
// 있게 export하는 것과 같은 관례다.
export function classifyTaskIdLabel(resultText) {
  const lines = maskQuotedMarkerRegions(
    (resultText ?? "").replace(/\r\n/g, "\n"),
  ).split("\n");
  const looseLineIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^task_id:.*$/i.test(lines[i])) continue;
    if (!hasStructuralPredecessor(lines, i)) continue;
    looseLineIdxs.push(i);
  }
  const looseLines = looseLineIdxs.length;
  if (looseLines === 0) {
    const anyCount = [...resultText.matchAll(TASK_ID_ANY_RE)].length;
    if (anyCount === 0) {
      return { kind: "MISSING", looseLines: 0, strictCount: 0 };
    }
    return { kind: "BROKEN", looseLines: 0, strictCount: 0, anyCount };
  }
  const strictMatches = looseLineIdxs
    .map((i) => lines[i].match(TASK_ID_LINE_RE))
    .filter(Boolean);
  const strictCount = strictMatches.length;
  if (looseLines === 1 && strictCount === 1) {
    return {
      kind: "VALID",
      value: strictMatches[0][1].trim(),
      looseLines,
      strictCount,
    };
  }
  return { kind: "BROKEN", looseLines, strictCount };
}

// evaluateConsumptionDecision 자신의 eslint complexity 상한을 지키려고
// 뽑았다(HYK-244-receipt-core-1b 선례와 동일한 이유, 판정 불변). VALID가
// 아니면 언제나 undefined -- 옛 경로들의 "지어내지 않는다" 계약과 동일.
function labelInfoToHarnessTaskLabel(labelInfo) {
  if (labelInfo.kind === "VALID") return labelInfo.value;
  return undefined;
}

// §2 조각2 지정과 동일: resultFingerprint = 결과 파일 내용의 SHA-256(hex).
// consumption-receipt-writer.mjs의 computeResultFingerprint와 알고리즘이
// 같아야 생산 쪽과 소비(게이트) 쪽이 같은 지문을 계산한다 -- 다른
// 알고리즘을 고르면 실제로는 동일한 결과 파일인데도 지문이 달라져
// bindingEqual이 영원히 불일치로 떨어진다(그 자체가 새 결함이므로
// 반드시 같은 알고리즘이어야 한다).
function computeConsumptionResultFingerprint(resultContent) {
  return createHash("sha256").update(resultContent, "utf8").digest("hex");
}

// §3-2 지정: dispatchId 출처 = 배달 영수증(dispatch-receipts.jsonl).
// ⛔관제실 절대경로 하드코딩 금지 -- args(--dispatch-receipt-path)나
// env(DISPATCH_RECEIPT_PATH, dispatch-receipt-cli.mjs가 이미 쓰는 바로 그
// 이름)로만 받는다.
//
// HYK-347 §1 경로 계약 (누가 넣어 주는가 · 설정되지 않으면 무슨 일이
// 일어나는가):
//   출처(어디서 오는가): 관제실 dispatch-worker.ps1이 자기 자식 프로세스
//   (이 CLI 포함, dispatch-receipt-cli.mjs·admission-completion-adapter.mjs·
//   scripts/supervisor/orch-stall-detect.mjs 전부 같은 이름을 읽는다)에
//   상속시키는 환경변수다 -- 이 저장소의 어떤 스크립트도 이 값을 자체
//   생성/기본값 지정하지 않는다(값의 "정본 소유자"는 관제실이다,
//   coder-task.md §4 표 "관제실이 넣어 준다").
//   미설정 시 무슨 일이 일어나는가: 이 함수는 null을 돌려준다 -- 그
//   null이 lookupDispatchId로 흘러가 `reasonCode: PATH_UNSET`(ok:false)이
//   되고, 이 함수를 호출하는 모든 소비 축(evaluateConsumptionDecision의
//   enrichCandidateDispatchId·evaluateAbortRecordDecision의
//   enrichAbortRecordDispatchId·hasDispatchReceiptForCurrentRound·
//   resolveMissingResultFileGate)은 그 실패를 "정말 없음"이 아니라
//   "확인 불가"로 취급해 안전측(REJECT 또는 무보강)으로 접는다 -- 판정을
//   ALLOW 쪽으로 뒤집는 법은 없다(fail-closed, HYK-342 4R §1 그대로 유지,
//   이 라운드가 그 판정 로직 자체를 바꾸지 않는다).
function resolveDispatchReceiptPath(args, env) {
  if (isNonEmptyString(args.dispatchReceiptPath))
    return args.dispatchReceiptPath;
  if (isNonEmptyString(env.DISPATCH_RECEIPT_PATH))
    return env.DISPATCH_RECEIPT_PATH;
  return null;
}

// lookupDispatchId에서 분리(quality-check: eslint complexity 상한 유지
// 목적, 동작 변경 없음) -- append-only JSONL 원문에서 role+
// harnessTaskLabel이 일치하는 "마지막" 레코드를 고른다(먼저 나온 매치가
// 아니라 마지막 -- append-only 로그이므로 그게 최신이다). 손상된 줄은
// 건너뛴다(부분쓰기 가능성, §참조 아래 lookupDispatchId 헤더).
// ⛔⛔ HYK-394-test-leak-3 §2 Q3 (2026-08-30, 검토자 rejected 판정
// 그대로 명시): 아래 anchor는 **계약이 아니다.** 검토자 원문: "dispatch_id
// 가 배달 시점 보존 사본에 박히지 않는다... 조회 시점을 안정화한
// 개선이지 «배달 시점에 파일에 박아 둔 결속»이 아니다." currentBinding과
// candidate 양쪽 dispatchId가 여전히 같은 (role, harnessTaskLabel) 조회
// 함수에서 파생되므로, 다른 5개 결속 필드(taskId/role/droppedAt/
// resultFingerprint/doneAt)가 이미 일치하는 한 dispatchId는 구조적으로
// redundant하다(HYK-394 2R coder.md §8 상세). **완성(dispatch_id를 배달
// 시점에 보존 사본에 실제로 굽는 것)은 이 저장소 범위 밖 -- HYK-396
// 예정.** 이 anchor 자체는 독립적으로 안전한 개선(옛 "매번 재계산"
// 결함을 닫아 false-reject 하나를 막는다, HYK-394 2R §5 RED 확인
// 완료)이라 남겨 뒀을 뿐, "배달 시점 결속"을 달성했다고 주장하지 않는다
// -- 이 축을 근거로 "dispatch_id 결속이 끝났다"고 판단하지 마라.
// HYK-394-dispatch-id-bind-2 §2 (P1): `beforeMs`, when given, restricts
// matches to ledger lines whose OWN `recorded_at` (dispatch-receipt-cli.mjs's
// buildReceiptRecord field, ISO, stamped the moment `orca orchestration
// dispatch` actually fired for THAT round) is STRICTLY earlier than
// `beforeMs` -- same tie-breaks-closed philosophy as relay-handshake.mjs's
// own `resolveDispatchRecordExistence` "timely" filter (that function's own
// header, HYK-387 2R §2 P2-ⓑ: "<" not "<=", a record at or after completion
// is not proof of assignment). Without this anchor, "latest match for
// (role, taskId)" silently drifts forward every time a NEW dispatch reuses
// the same taskId (a later round, or a re-drop) -- exactly the flaw HYK-394
// 1R proved exploitable (a query re-run at judgment time answers a
// DIFFERENT question than the same query run once at the round's own
// completion). Anchoring to `beforeMs` (the CALLER's own fixed, historical
// doneAt/completion instant) makes the answer stable no matter how much
// LATER the query actually runs, or how many more dispatches have been
// recorded for this taskId since -- this is what turns a live re-lookup
// into the "박아 두는 값" P1 requires, without needing to change WHERE or
// WHEN any writer runs. `beforeMs` omitted (undefined) preserves the exact
// prior behavior (existing callers/tests unaffected) -- callers that care
// about this safety property must now supply it (evaluateConsumptionDecision/
// enrichCandidateDispatchId below both do).
function findLatestReceiptMatch(raw, role, harnessTaskLabel, beforeMs) {
  const hasAnchor = typeof beforeMs === "number" && Number.isFinite(beforeMs);
  let match = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof rec.role === "string" &&
      rec.role.toUpperCase() === role.toUpperCase() &&
      rec.harness_task_label === harnessTaskLabel
    ) {
      if (hasAnchor) {
        const recordedAtMs = Date.parse(rec.recorded_at);
        // unparseable/missing recorded_at can't be proven "before" the
        // anchor -- excluded, not guessed into either side (fail-closed,
        // same posture as the rest of this axis).
        if (!Number.isFinite(recordedAtMs) || !(recordedAtMs < beforeMs)) {
          continue;
        }
      }
      match = rec;
    }
  }
  return match;
}

// ⛔"조회하지 못했다"(ok:false)와 "정말 없다"(ok:true, found:false)를
// 구별한다 -- 어느 쪽이든 dispatchId를 지어내지 않는다(2R-a 계약 유지).
// role 비교는 대소문자 무관(dispatch-receipts.jsonl 표본은 "CODER"/
// "REVIEW" 대문자, 이 CLI의 role은 파일명 관례상 소문자 "coder"/
// "review" -- 실측: dispatch-receipt-cli.mjs 44행 USAGE 문자열과
// 관제실 dispatch-receipts.jsonl 실제 샘플 라인을 직접 대조).
//
// HYK-347 §1/§2: every branch below now ALSO carries a machine-checkable
// `reasonCode` (previously only a Korean prose `reason` string existed --
// a caller/monitoring script had to string-match to tell branches apart).
// This is purely additive: every existing call site (enrichCandidateDispatchId,
// enrichAbortRecordDispatchId, hasDispatchReceiptForCurrentRound,
// resolveMissingResultFileGate) only ever reads `.ok`/`.found`/`.dispatchId`
// -- none of them read `.reason` or (before this round) `.reasonCode`, so
// adding this field changes zero accept/reject decisions (coder-task.md §2
// 비타협: "판정 로직 자체는 바꾸지 마라"). The specific pairing HYK-347
// names -- "미설정"(PATH_UNSET) vs "설정됐지만 0건"(NOT_FOUND) -- are two
// DIFFERENT reasonCode values here, never collapsed into one.
export const DISPATCH_RECEIPT_LOOKUP_REASON = Object.freeze({
  PATH_UNSET: "PATH_UNSET",
  LABEL_MISSING: "LABEL_MISSING",
  READ_FAILED: "READ_FAILED",
  MISSING_DISPATCH_ID_FIELD: "MISSING_DISPATCH_ID_FIELD",
  NOT_FOUND: "NOT_FOUND",
  FOUND: "FOUND",
});

// HYK-347 §3: exported so a contract test can pin the reasonCode
// distinction directly, without threading the full CLI/gate-decision
// surface just to observe this one function's return shape.
export function lookupDispatchId({
  role,
  harnessTaskLabel,
  receiptPath,
  beforeMs,
}) {
  if (!isNonEmptyString(receiptPath)) {
    return {
      ok: false,
      found: false,
      reasonCode: DISPATCH_RECEIPT_LOOKUP_REASON.PATH_UNSET,
      reason:
        "dispatch receipt path 없음(--dispatch-receipt-path/DISPATCH_RECEIPT_PATH 둘 다 미설정)",
    };
  }
  if (!isNonEmptyString(harnessTaskLabel)) {
    return {
      ok: false,
      found: false,
      reasonCode: DISPATCH_RECEIPT_LOOKUP_REASON.LABEL_MISSING,
      reason:
        "조회할 harness_task_label 없음(task 파일의 task_id: 줄이 없거나 모호함)",
    };
  }
  let raw;
  try {
    raw = readFileSync(receiptPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      found: false,
      reasonCode: DISPATCH_RECEIPT_LOOKUP_REASON.READ_FAILED,
      reason: `dispatch receipt 파일을 읽을 수 없음('${receiptPath}': ${err.message})`,
    };
  }
  const match = findLatestReceiptMatch(raw, role, harnessTaskLabel, beforeMs);
  if (!match) {
    return {
      ok: true,
      found: false,
      reasonCode: DISPATCH_RECEIPT_LOOKUP_REASON.NOT_FOUND,
    };
  }
  if (typeof match.dispatch_id !== "string" || match.dispatch_id.length === 0) {
    return {
      ok: false,
      found: false,
      reasonCode: DISPATCH_RECEIPT_LOOKUP_REASON.MISSING_DISPATCH_ID_FIELD,
      reason: `role=${role} label=${harnessTaskLabel}로 찾은 영수증 항목에 dispatch_id 필드가 없음`,
    };
  }
  return {
    ok: true,
    found: true,
    reasonCode: DISPATCH_RECEIPT_LOOKUP_REASON.FOUND,
    dispatchId: match.dispatch_id,
  };
}

// HYK-396 §2(여는 축, Q2 안전장치): (role, harnessTaskLabel) 라벨의
// dispatch-receipts.jsonl 전체 이력에서 서로 다른 dispatch_id가 몇 종
// 기록됐는지 센다 -- findLatestReceiptMatch/lookupDispatchId(위)와 달리
// beforeMs 앵커 없이 «이 라벨이 실제로 몇 번 배달됐는가» 자체를 묻는다.
// 이 값이 findArchivedRoundMeta의 새 선택축(아래) on/off 스위치다: 정확히
// 1이면(이 라벨의 실배달이 단 한 번뿐이면) "그 배달의 dispatch_id로
// 각인된 사본"을 골라도 헷갈릴 다른 진짜 배달이 없다. 2 이상이면(같은
// 라벨이 재드롭돼 실배달이 두 번 이상 기록됐으면) 새 선택축을 끄고
// findArchivedRoundMeta는 기존 "가장 높은 번호 사본만" 경로로 물러난다 --
// hyk394-dispatch-id-bind.test.mjs (b)가 이미 증명한 안전장치(droppedAt
// 불일치로 거부)를 그대로 남겨 둔다. HYK-394 2R/Q8이 반증한 것은
// "dispatch_id로 결속 대조를 넓히면" 뚫린다는 것이었다 -- 이 축은 실배달이
// 정확히 하나뿐일 때만 켜지므로 그 구멍을 다시 열지 않는다(재드롭 =
// 실배달 2건 이상 = 이 축 자체가 발동하지 않음).
function countDistinctDispatchIdsForLabel(receiptPath, role, harnessTaskLabel) {
  if (!isNonEmptyString(receiptPath) || !isNonEmptyString(harnessTaskLabel)) {
    return 0;
  }
  let raw;
  try {
    raw = readFileSync(receiptPath, "utf8");
  } catch {
    return 0;
  }
  const ids = new Set();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof rec.role === "string" &&
      rec.role.toUpperCase() === role.toUpperCase() &&
      rec.harness_task_label === harnessTaskLabel &&
      isNonEmptyString(rec.dispatch_id)
    ) {
      ids.add(rec.dispatch_id);
    }
  }
  return ids.size;
}

// HYK-244 2R-b3 결함1 수리: 게이트는 배달 "전"에 돈다 -- 이 시점에는
// taskPath(`<role>-task.md`)가 이미 "다음에 보낼" 새 라운드로 덮여 있다
// (ORCH 실측: dropped_at이 새 라운드 값이었다). "직전 라운드가
// 소비됐는가"를 판정하려면 결속의 모든 성분이 직전 라운드 자신에게서
// 와야 하는데, droppedAt만은 resultText(직전 라운드가 남긴 결과 파일)
// 자체에는 없다(프로토콜상 결과 파일은 task_id만 에코하고 dropped_at은
// 에코하지 않는다). 그 직전 라운드가 완료될 때 envelope-archive.mjs의
// archiveRoundTaskFile이 자기 task 파일을 `.harness/rounds/
// <role>-task-r<N>.md`에 원문 그대로 보존해 둔 사본이 유일하게 남은
// 출처다 -- harnessTaskLabel과 일치하는 사본을 찾아 그 안의 dropped_at을
// 그대로 쓴다(못 찾으면 undefined -- 지어내지 않는다, 1R 코어가
// 안전측으로 거부한다). role 비교는 대소문자 무관(결함3과 같은 이유 --
// 아카이브 파일명은 실제 생산 경로가 쓴 그대로의 대소문자를 담고 있어
// 파일명 관례상 소문자인 이 함수의 role 인자와 다를 수 있다).
// HYK-396 §2 (확장, 회귀 0): 기존 계약("가장 높은 번호 사본 하나만 대조"·
// task_id 일치 요구·droppedAt 못 찾으면 undefined) 그대로 두고, 같은
// 파일을 두 번 읽지 않도록 그 자리에서 dispatch_id 판정도 함께 뽑아 온다.
// droppedAt 자체는 여전히 "가장 높은 사본 하나만"이다(이 라운드 범위
// 밖 -- Q1은 dispatch_id 축만 좁힌다).
//
// HYK-396 3R §1 Q1⑴ (검토 rejected 사유 재현 방지 -- ★비타협): 2R까지는
// "가장 높은 사본이 ABSENT면 그걸로 «없음»을 확정"했다 -- 검토자가 직접
// 실행해 반증했다: 낮은 사본(r1)에 위조 dispatch_id를 심고 높은 사본(r2,
// 판정 대상)은 필드 자체를 안 남기면, 이 함수는 r2만 보고 ABSENT를
// 돌려줘 r1의 위조를 «영원히 못 본다»(실증: r1=ctx_probe_higher_forged
// / r2=필드없음 / 원장=ctx_probe_higher_real ⇒ fallback과 결합해
// status=0 ARCHIVE_MATCH ALLOW). ★불변식(coder-task.md §2 P): "각인을
// «없는 것처럼» 만드는 어떤 조작으로도 위조를 통과시킬 수 없다" -- 이
// 요구를 만족하려면 "가장 높은 사본"이 ABSENT일 때 그것만으로 끝내지
// 말고, 같은 라벨의 «다른 모든 사본»(더 낮은 번호)까지 살펴 그중
// 하나라도 DAMAGED거나 원장과 다른 VALUE(=위조 의심)면 거부해야 한다.
// 반대로 다른 사본이 전혀 없거나(단일 사본) 전부 ABSENT/원장과 일치하는
// VALUE뿐이면 "정말 아무 증거도 없다"는 뜻이므로 여전히 스킵(ALLOW) --
// 이게 깨지면 배달 시점 각인이 아예 없던 진짜 옛 사본(§2 Q3 회귀 요구,
// "각인 이전 옛 사본은 여전히 통과해야 한다")까지 막혀 릴레이가 멈춘다.
// ⛔"가장 높은 사본"이 ABSENT가 «아니면»(DAMAGED·VALUE) 이 스캔은 아예
// 안 돈다 -- 그 경우는 이미 그 사본 자신의 상태만으로 결정적이다(기존
// 계약 그대로, 회귀 0).
//
// lowerCopyEvidence: 가장 높은 사본이 ABSENT일 때만 채워지는, 더 낮은
// 번호 사본들 중 ABSENT가 «아닌» 것들의 분류 목록(순서 무관 -- 호출자가
// "하나라도 나쁘면 거부"만 물으므로 정렬이 필요 없다). 가장 높은 사본이
// ABSENT가 아니면 항상 빈 배열.
//
// HYK-396 §2(여는 축, Q2 -- coder-task.md P1): resolvedDispatchId(넷째
// 인자, countDistinctDispatchIdsForLabel이 정확히 1일 때만 호출자가
// 채워 준다, undefined면 이 축 전체가 꺼진다 -- ⛔값을 지어내지 않는다)가
// 주어지면, "가장 높은 번호 사본"으로 무조건 물러나기 전에 먼저 «이
// 라운드 자신의 dispatch_id로 각인된 사본»을 찾는다 -- 오늘 실측(같은
// 라벨 사본 5벌, 영수증은 19:13에 결속됐는데 가장 높은 번호는 19:45)의
// 정면 수리다. 정확히 하나 찾으면 그 사본의 droppedAt/dispatch_id를
// 채택하고(그 사본이 곧 "highest"의 자리를 대신한다 -- lowerCopyEvidence는
// 의미가 없다, 이 사본은 ABSENT가 아니라 VALUE이므로), 2개 이상 찾으면
// (경계값 ⓓ) 어느 것이 진짜인지 결정할 수 없으므로 새 kind
// "AMBIGUOUS"로 거부를 확정한다(checkArchivedDispatchIdBinding이 아래
// 표대로 두 경로 모두 거부), 0개면(각인된 사본이 하나도 없음 -- 이행
// 기간·회귀 케이스 ⓕ 포함) 기존 "가장 높은 번호" 경로로 그대로 물러난다
// (회귀 0 -- 이 축은 오직 "찾았을 때"만 선택을 바꾼다, 못 찾았을 때는
// 조금도 다르게 행동하지 않는다).
//
// findArchivedRoundMeta 자신의 eslint max-lines-per-function/complexity
// 상한을 지키려고 뽑았다(HYK-244-receipt-core-1b 선례와 동일한 이유,
// 판정/값은 조금도 바뀌지 않는다 -- 몸통만 쪼갠다). null = "폴백하라"
// (resolvedDispatchId가 없거나, 이 라운드 자신의 dispatch_id로 각인된
// 사본이 하나도 없다 -- 지어내지 않는다).
function selectArchivedRoundByDispatchId(matches, resolvedDispatchId) {
  if (!isNonEmptyString(resolvedDispatchId)) return null;
  const idMatches = matches.filter(
    (m) =>
      m.classified.kind === "VALUE" &&
      m.classified.value === resolvedDispatchId,
  );
  if (idMatches.length === 1) {
    return {
      droppedAt: idMatches[0].droppedAt,
      dispatchId: resolvedDispatchId,
      dispatchIdKind: "VALUE",
      lowerCopyEvidence: [],
    };
  }
  if (idMatches.length > 1) {
    // ⓓ 경계값: 같은 라벨의 사본 2벌 이상이 «이 라운드 자신의»
    // dispatch_id와 동일하게 각인돼 있다 -- 어느 것이 진짜인지 조용히
    // 고르지 않는다(P2 비타협). droppedAt은 그 중 하나(가장 높은 번호,
    // 결정 무관 -- 어차피 아래 checkArchivedDispatchIdBinding이
    // AMBIGUOUS를 무조건 거부하므로 이 값 자체가 최종 판정을 바꾸지
    // 않는다)만 실어 정상 결속 경로까지는 도달하게 해서, 이 거부가
    // "결속 불일치"라는 흔한 사유 뒤에 숨지 않고 AMBIGUOUS라는 자기
    // 사유로 드러나게 한다.
    const highestIdMatch = idMatches.reduce((a, b) =>
      b.roundNum > a.roundNum ? b : a,
    );
    return {
      droppedAt: highestIdMatch.droppedAt,
      dispatchId: undefined,
      dispatchIdKind: "AMBIGUOUS",
      lowerCopyEvidence: [],
    };
  }
  // idMatches.length === 0 -- 이 라운드 자신의 dispatch_id로 각인된 사본이
  // 하나도 없다(이행 기간 옛 사본만 있거나, 스탬프가 아직 안 됐거나).
  return null;
}

function findArchivedRoundMeta(
  harnessDir,
  role,
  harnessTaskLabel,
  resolvedDispatchId,
) {
  const archiveDir = join(harnessDir, "rounds");
  let names;
  try {
    names = readdirSync(archiveDir);
  } catch {
    return {
      droppedAt: undefined,
      dispatchId: undefined,
      dispatchIdKind: "ABSENT",
      lowerCopyEvidence: [],
    };
  }
  const pattern = new RegExp(`^${role}-task-r(\\d+)\\.md$`, "i");
  const matches = [];
  for (const name of names) {
    const m = pattern.exec(name);
    if (!m) continue;
    let content;
    try {
      content = readFileSync(join(archiveDir, name), "utf8");
    } catch {
      continue;
    }
    // HYK-468: header-block-scoped (see header-task-id-shared.mjs) --
    // a whole-file column-0 scan collided with a task_id: line quoted
    // verbatim later in this archive file's own body.
    const archivedTaskId = resolveHeaderTaskId(content);
    if (!archivedTaskId.ok || archivedTaskId.id !== harnessTaskLabel) continue;
    const droppedMatch = content.match(CONSUMPTION_DROPPED_AT_RE);
    if (!droppedMatch) continue;
    matches.push({
      roundNum: Number(m[1]),
      droppedAt: droppedMatch[1].trim(),
      classified: classifyArchivedDispatchId(content),
    });
  }
  if (matches.length === 0) {
    return {
      droppedAt: undefined,
      dispatchId: undefined,
      dispatchIdKind: "ABSENT",
      lowerCopyEvidence: [],
    };
  }
  // HYK-396 §2 Q2 -- 여는 축 선택(위 함수 헤더 참조, 헬퍼는
  // findArchivedRoundMeta 자신의 eslint max-lines-per-function/complexity
  // 상한을 지키려고 뽑았다 -- 판정/값은 조금도 바뀌지 않는다). null이면
  // 폴백하라는 뜻(resolvedDispatchId가 없거나, 이 라운드 자신의
  // dispatch_id로 각인된 사본이 하나도 없다).
  const idSelected = selectArchivedRoundByDispatchId(
    matches,
    resolvedDispatchId,
  );
  if (idSelected) return idSelected;
  matches.sort((a, b) => b.roundNum - a.roundNum);
  const [highest, ...lower] = matches;
  const dispatchIdKind = highest.classified.kind;
  const lowerCopyEvidence =
    dispatchIdKind === "ABSENT"
      ? lower.map((m2) => m2.classified).filter((c) => c.kind !== "ABSENT")
      : [];
  return {
    droppedAt: highest.droppedAt,
    dispatchId:
      dispatchIdKind === "VALUE" ? highest.classified.value : undefined,
    dispatchIdKind,
    lowerCopyEvidence,
  };
}

// HYK-396 §2 Q2(1R/2R) + 3R §1 Q1⑵ -- the new axis itself. Only called
// when the existing 6-field binding (consumption-receipt-core.mjs's
// bindingEqual) has ALREADY matched -- either via the primary
// decision===null branch (pathKind: "normal"), or via tryArchiveFallback's
// ARCHIVE_MATCH ALLOW (pathKind: "fallback" -- 2R §2 P1-1 fix: both
// ALLOW-producing paths must pass through this same veto, not just the
// first one -- the 1R gap the reviewer's forged-stamp sample exploited).
// This function can only ever TIGHTEN an already-ALLOW outcome (never
// loosen it). See checkArchivedDispatchIdBinding's own header for the
// full state×path disposition table (3R §2 Q2's explicit contract).
function resolveArchivedDispatchIdVeto(
  role,
  archivedRoundMeta,
  currentBinding,
  pathKind,
) {
  const idBinding = checkArchivedDispatchIdBinding(
    role,
    archivedRoundMeta,
    currentBinding.dispatchId,
    pathKind,
  );
  if (idBinding.reject) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_ARCHIVED_DISPATCH_ID_MISMATCH,
      allow: false,
      reason: idBinding.reason,
    };
  }
  return null;
}

// HYK-396 3R §2 Q2 -- ★상태×경로 명시 계약 표(코드 자신이 이 표다, 문서는
// coder.md에 재기재). 상태는 archivedRoundMeta.dispatchIdKind(가장 높은
// 사본 자신의 분류) + lowerCopyEvidence(그 사본이 ABSENT일 때만 채워지는,
// 3R §1 Q1⑴의 낮은 사본 스캔 결과)로 결정된다. 경로는 pathKind
// ("normal" = 정상 6성분 결속 ALLOW, "fallback" = tryArchiveFallback
// ARCHIVE_MATCH ALLOW)다.
//
// HYK-396 §2(여는 축, Q2) -- 표 갱신: 1차 조회(archivedRoundMeta,
// buildConsumptionBindingContext)는 ⛔여전히 "가장 높은 번호 사본"이다
// (회귀 0 -- hyk396-dispatch-stamp.test.mjs (j)가 이미 highest 기준으로
// ALLOW하는 사례를 실행으로 고정해 뒀다, 그 사례까지 바꿔치기하면 안
// 된다). 새 선택축은 그 1차 조회가 «실패했을 때만»
// (tryDispatchIdArchiveSelection, resolveConsumptionAllowOrFallthrough
// 아래) 켜지는 **재시도**다 -- «이 라운드 자신의 dispatch_id로 각인된
// 사본»을 찾아 findArchivedRoundMeta를 다시 부르고, 그 결과로 이 표를
// 다시 대조한다(tryArchiveFallback과 동일한 "정상 실패 시에만 재시도"
// 형태). 그 재시도에서 정확히 하나 찾으면 dispatchIdKind는 VALUE(사실상
// 항상 MATCH), lowerCopyEvidence는 빈 배열이다. 2개 이상 찾으면(같은
// 라벨 사본 여럿이 «이 라운드 자신의» dispatch_id와 동일하게 각인 --
// ⓓ 경계값) 새 상태 AMBIGUOUS로 떨어진다 -- 이 경우만 표에 새 행을
// 추가했다(★비타협: 조용히 하나를 고르지 않는다, P2).
//
// | 상태(선택된 사본 기준)                 | normal 경로 | fallback 경로 |
// |----------------------------------------|-------------|----------------|
// | AMBIGUOUS(같은 dispatch_id 사본 2벌+)  | REJECT      | REJECT         |
// | DAMAGED                                | REJECT      | REJECT         |
// | ABSENT + 낮은 사본에 DAMAGED/MISMATCH  | REJECT      | REJECT         |
// | ABSENT + 낮은 사본 전부 무해(없음·MATCH만) | ALLOW(스킵) | REJECT(★Q1⑵) |
// | MATCH(원장과 일치)                     | ALLOW(스킵) | ALLOW(스킵)    |
// | MISMATCH(원장과 다름)                  | REJECT      | REJECT         |
//
// 표에 없는 조합은 없다 -- dispatchIdKind는 정확히 {ABSENT, DAMAGED,
// VALUE, AMBIGUOUS} 네 값이고(AMBIGUOUS는 findArchivedRoundMeta의 새
// 선택축 전용, classifyArchivedDispatchId 자신은 여전히 3값만 반환)
// VALUE는 MATCH/MISMATCH로만 갈리며, lowerCopyEvidence는
// dispatchIdKind==="ABSENT"일 때만 의미를 갖는다(findArchivedRoundMeta가
// 그 외엔 항상 빈 배열을 돌려준다). pathKind는 호출자가 "normal"|
// "fallback" 둘 중 하나만 넘긴다(그 외 값을 넘기면 아래 fallback 분기
// 코드가 그 값을 "normal 아님"으로 취급 -- 문자열 비교이므로 오타는
// 곧장 REJECT 쪽으로 fail-closed된다, ALLOW로 새지 않는다).
//
// 시험(scripts/check/hyk396-dispatch-stamp.test.mjs, 상태별 최소 1개):
//   DAMAGED × normal        = (f)/(g)/(h)
//   ABSENT(단일, 증거 없음) × normal   = (d) -- ★Q3 회귀, 릴레이 정지 방지
//   ABSENT + 낮은 사본 MISMATCH × fallback = (e) -- ★검토자 실증 재현
//   ABSENT + 낮은 사본 MISMATCH × normal   = (j)
//   ABSENT(증거 없음) × fallback   = (k) -- ★3R Q1⑵ 신규
//   MATCH × normal          = (a)
//   MATCH × fallback        = (l)
//   MISMATCH × normal       = (c)
//   MISMATCH × fallback     = (e)(부수 확인) · (m)
// 시험(scripts/check/hyk396-open-axis.test.mjs, 이 여는 축 신규 6종,
// coder-task.md §3 표 그대로):
//   AMBIGUOUS × normal      = ⓓ(경계값)
//   MATCH(선택된 사본) × normal = ⓐ(오염 -- 이 축이 여는 대상)
//   (ⓑ/ⓒ/ⓔ/ⓕ는 선택축이 꺼지거나 기존 표로 떨어져 REJECT/ALLOW 유지)
// checkArchivedDispatchIdBinding 자신의 eslint complexity 상한을 지키려고
// 뽑았다(HYK-244-receipt-core-1b 선례와 동일한 이유, 판정/사유 문자열은
// 조금도 바뀌지 않는다) -- dispatchIdKind==="ABSENT" 분기 하나만 그대로
// 옮긴 것뿐이다.
function checkAbsentDispatchIdBinding(
  role,
  archivedRoundMeta,
  resolvedDispatchId,
  pathKind,
) {
  // HYK-396 3R §1 Q1⑴: 가장 높은 사본이 ABSENT라도 그걸로 끝내지 않는다 --
  // 더 낮은 사본들 중 하나라도 손상됐거나(DAMAGED) 원장과 다른 값(VALUE
  // mismatch)이면 위조 의심 증거이므로 거부한다.
  for (const evidence of archivedRoundMeta.lowerCopyEvidence) {
    if (evidence.kind === "DAMAGED") {
      return {
        reject: true,
        reason: `dispatch-gate-decision consumption: 가장 높은 보존 사본(rounds/${role}-task-r<N>.md)의 dispatch_id는 미각인(ABSENT)이지만, 같은 라벨의 더 낮은 사본에서 손상된 dispatch_id 각인이 발견됨 -- "없음"으로 결론 내리지 않는다(HYK-396 3R Q1⑴), 거부`,
      };
    }
    if (evidence.kind === "VALUE" && evidence.value !== resolvedDispatchId) {
      return {
        reject: true,
        reason: `dispatch-gate-decision consumption: 가장 높은 보존 사본(rounds/${role}-task-r<N>.md)의 dispatch_id는 미각인(ABSENT)이지만, 같은 라벨의 더 낮은 사본에 각인된 dispatch_id('${evidence.value}')가 이 라운드의 실제 배달 원장에서 조회된 값('${resolvedDispatchId ?? "(조회 불가/없음)"}')과 다름 -- 위조 의심, 거부(HYK-396 3R Q1⑴)`,
      };
    }
  }
  // HYK-396 3R §1 Q1⑵ (★비타협, 검토 원문 그대로): "이행 허용은 정상
  // 경로에만" -- fallback(ARCHIVE_MATCH) 경로는 이미 live 결과 지문이
  // 어긋난(=이상 신호가 이미 하나 있는) 상태에서 판단하므로, 거기에
  // dispatch_id 증거까지 «전혀 없다»는 것은 정상 경로의 "옛 사본이라
  // 그렇다"는 무해한 설명과 같은 확신을 주지 못한다 -- 안전측으로
  // 거부한다. normal 경로는 기존 계약(1R Q2 "값이 없으면 없다고
  // 기록") 그대로 스킵한다.
  if (pathKind === "fallback") {
    return {
      reject: true,
      reason: `dispatch-gate-decision consumption: fallback(ARCHIVE_MATCH) 경로에서 보존 사본(rounds/${role}-task-r<N>.md, 및 같은 라벨의 다른 사본 전부)에 dispatch_id 각인 증거가 전혀 없음 -- 이행 허용은 정상 경로에만 적용된다(HYK-396 3R Q1⑵), fallback은 안전측 거부`,
    };
  }
  return { reject: false };
}

function checkArchivedDispatchIdBinding(
  role,
  archivedRoundMeta,
  resolvedDispatchId,
  pathKind,
) {
  // HYK-396 §2(여는 축 Q2/Q3-ⓓ): 같은 라벨의 사본 2벌 이상이 «이 라운드
  // 자신의» dispatch_id와 동일하게 각인돼 있으면(findArchivedRoundMeta의
  // 새 선택축이 idMatches.length>1로 판정한 경우) 어느 것이 진짜 그
  // 라운드의 것인지 조용히 고르지 않는다 -- pathKind와 무관하게 무조건
  // 거부(P2 비타협, "애매 통과 금지").
  if (archivedRoundMeta.dispatchIdKind === "AMBIGUOUS") {
    return {
      reject: true,
      reason: `dispatch-gate-decision consumption: 같은 라벨(rounds/${role}-task-r<N>.md)의 보존 사본 2벌 이상이 이 라운드 자신의 dispatch_id('${resolvedDispatchId ?? "(조회 불가/없음)"}')와 동일하게 각인돼 있음 -- 어느 것이 진짜 그 라운드의 것인지 결정할 수 없다(HYK-396 여는 축 Q3-ⓓ 경계값), 조용히 하나를 고르지 않고 거부(안전측 기본값)`,
    };
  }
  if (archivedRoundMeta.dispatchIdKind === "DAMAGED") {
    return {
      reject: true,
      reason: `dispatch-gate-decision consumption: 보존 사본(rounds/${role}-task-r<N>.md) 헤더의 dispatch_id 값이 손상됨(빈 값·공백·앞뒤공백·개행·중복 필드 중 하나) -- "없음"이 아니라 "손상"이므로 무조건 거부(HYK-396, 안전측 기본값 -- 원장 조회 결과와 무관)`,
    };
  }
  if (archivedRoundMeta.dispatchIdKind === "ABSENT") {
    return checkAbsentDispatchIdBinding(
      role,
      archivedRoundMeta,
      resolvedDispatchId,
      pathKind,
    );
  }
  const archivedDispatchId = archivedRoundMeta.dispatchId;
  if (archivedDispatchId === resolvedDispatchId) return { reject: false };
  return {
    reject: true,
    reason: `dispatch-gate-decision consumption: 보존 사본(rounds/${role}-task-r<N>.md)에 배달 시점 각인된 dispatch_id('${archivedDispatchId}')가 이 라운드의 실제 배달 원장(dispatch-receipts.jsonl)에서 조회된 dispatch_id('${resolvedDispatchId ?? "(조회 불가/없음)"}')와 다름 -> 위조 또는 다른 배달의 사본, 거부(HYK-396, 안전측 기본값)`,
  };
}

// HYK-394-dispatch-id-bind-2 §2 (P2, reintroduced then RE-REVERTED --
// see evaluateConsumptionDecision's own header below for the empirical
// finding): a "try every distinct archived droppedAt for this label, not
// just the highest-numbered one" relaxation was reintroduced here, this
// time paired with the dispatch_id anchor fix (findLatestReceiptMatch/
// lookupDispatchId/enrichCandidateDispatchId's `beforeMs`, still shipped,
// see those functions' own headers). It was proven, by direct execution
// (scripts/check/hyk394-dispatch-id-bind.test.mjs test (b)), that this
// STILL lets a genuinely-unconsumed redrop through: dispatchId anchoring
// correctly excludes the redrop's OWN (later) dispatch record, but the
// non-highest-round trial (the FIRST drop's own droppedAt) still matches
// the old receipt on every field -- not because of a stale/recomputed
// value, but because resultText genuinely still IS the first drop's own,
// truly-consumed content (the redrop's worker never overwrote it). No
// per-round binding field (taskId/role/droppedAt/resultFingerprint/
// dispatchId/doneAt) can distinguish "this is the same round, re-archived"
// from "this is a different, later round that reused the label and never
// finished" when the live result file simply hasn't changed. Per Q8's
// explicit instruction ("통과시키면 넣지 마라"), this relaxation is
// declined again; only this comment remains (findArchivedDroppedAt below,
// unchanged, remains the only lookup -- "highest round only" is what
// blocks fixture (b), by making droppedAt itself mismatch).

// HYK-244 2R-b3 결함2 수리 (필수 부속): 실물 생산 경로(relay-handshake.mjs
// -> consumption-receipt-writer.mjs)는 완료 시점에 자기 dispatchId를 알
// 방법이 없다(관제실 dispatch-receipts.jsonl에 그 라운드의 항목이 남는
// 것은 그 라운드가 "다음 라운드로" 배달됐을 때이지, 자기 자신이 끝날 때가
// 아니다 -- ORCH 실측 원문 그대로: 실제 생산된 영수증에 dispatchId
// 키가 아예 없다). ⇒ 후보(candidate) 쪽도 currentBinding과 **같은
// 출처(dispatch-receipts.jsonl)에서 같은 방식으로** dispatchId를
// 보강하지 않으면, 6성분 엄격 비교(§3 결함2 원문)가 "실물이 만든 후보는
// dispatchId가 영원히 undefined, currentBinding은 실제 문자열"이라는
// 비대칭 때문에 항상 불일치로 떨어진다 -- 코어(consumption-receipt-
// core.mjs, ⛔수정 금지)를 바꾸지 않고 이 비대칭을 없앨 수 있는 유일한
// 지점이 여기(게이트가 후보를 읽는 지점)다. 이미 찾은 값이 있으면(이론상
// 미래에 생산 경로가 직접 채우게 되더라도) 덮어쓰지 않는다.
// HYK-394-dispatch-id-bind-2 §2 (P1): anchors this backfill to the
// CANDIDATE'S OWN `doneAt` (its completion instant, fixed forever once the
// receipt was written) instead of "whatever is latest right now" -- see
// findLatestReceiptMatch's own header for why an unanchored "latest" query
// answers a different question every time it's re-run (HYK-394 1R's proven
// exploit). A candidate with a missing/malformed doneAt (parseKstToMs
// returns null) gets no anchor and is enriched with the OLD unanchored
// "latest" behavior -- this only affects receipts predating this field's
// reliability, not a new unsafe path (checkBindingPreconditions already
// requires a valid doneAt for ANY candidate to ever match, so an
// unanchored enrichment here can, at worst, feed a value into a comparison
// that a downstream check would reject anyway on other grounds).
// ⛔이 함수와 enrichCandidateDispatchId 아래는 HYK-394-test-leak-3 §2 Q3
// 명시가 적용되는 "계약 아님" 축의 일부다 -- findLatestReceiptMatch의
// 헤더(위쪽, "⛔⛔ HYK-394-test-leak-3 §2 Q3"로 시작) 참조, 완성은 HYK-396.
// eslint complexity 상한 유지 목적으로 뽑은 한 줄짜리 헬퍼(동작 변경 없음)
// -- enrichCandidateDispatchId 자신의 옵셔널 체이닝 개수가 이미 상한에
// 가까웠고, beforeMs 계산 하나를 더 인라인하면 초과한다.
function candidateBeforeMs(candidate) {
  return parseKstToMs(candidate?.binding?.doneAt) ?? undefined;
}

function enrichCandidateDispatchId(candidate, receiptPath) {
  if (isNonEmptyString(candidate?.binding?.dispatchId)) return candidate;
  const role = candidate?.binding?.role;
  const harnessTaskLabel = candidate?.binding?.taskId;
  if (!isNonEmptyString(role) || !isNonEmptyString(harnessTaskLabel))
    return candidate;
  const beforeMs = candidateBeforeMs(candidate);
  const lookup = lookupDispatchId({
    role,
    harnessTaskLabel,
    receiptPath,
    beforeMs,
  });
  if (!lookup.ok || !lookup.found) return candidate;
  return {
    ...candidate,
    binding: { ...candidate.binding, dispatchId: lookup.dispatchId },
  };
}

// `<harnessDir>/receipts/<role>-receipt-r<N>.json` 전부를 후보로 읽는다
// (최신 것만 고르지 않는다 -- 1R 코어 자신이 currentBinding과 정확히
// 일치하는 후보를 스스로 골라내므로, 여기서 미리 좁히면 "과거 라운드
// 후보가 섞여 있어도 코어가 올바르게 무시한다"는 1R의 보장을 검증할
// 기회 자체가 사라진다). 개별 파일이 읽기/파싱 실패하면 그 파일만
// 건너뛴다 -- 손상된 영수증 하나가 전체 조회를 막지 않는다(신뢰 못할
// 후보는 코어가 어차피 매치시키지 못해 안전측으로 떨어진다).
function readConsumptionCandidates(harnessDir, role, receiptPath) {
  const receiptsDir = join(harnessDir, "receipts");
  let names;
  try {
    names = readdirSync(receiptsDir);
  } catch {
    return [];
  }
  const pattern = new RegExp(`^${role}-receipt-r\\d+\\.json$`, "i");
  const candidates = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(receiptsDir, name), "utf8"));
      candidates.push(enrichCandidateDispatchId(raw, receiptPath));
    } catch {
      // 손상/미완성 쓰기 -- 건너뛴다(위 함수 헤더 참조).
    }
  }
  return candidates;
}

// HYK-244 2R-b4 §2-1 (한용 조건①): 제도 시행 시점 = commit `16eb377`
// (2R-a, consumption-receipt-writer.mjs 최초 도입)의 커밋 시각. ⛔이
// 브랜치 자신의 "결선(게이트 wiring) 커밋"을 기준으로 삼지 않는다 --
// 그 커밋은 이 라운드가 검토 승인된 *뒤에야* 만들어지므로, 기준이 자기
// 존재를 전제하는 순환이 생긴다(coder-task.md §2-1 원문 그대로 지적).
// `16eb377`은 이미 존재하는 커밋이라 순환이 없고, 그 시각 이전에 완료된
// 라운드는 영수증을 만드는 코드(consumption-receipt-writer.mjs) 자체가
// 저장소에 없었다는 것이 정의상 참이다 -- 그 라운드에 영수증이 없는
// 것은 "미소비"가 아니라 "판정 대상 아님"이 정확한 상태다. 값은 아래
// 명령의 실측 결과를 리터럴로 박아넣은 것이고, 런타임에 git을 조회하지
// 않는다(밖에서 읽는 가변값이 아니다):
//   $ git log -1 --format=%cI 16eb377
//   2026-08-14T08:50:27+09:00
const RECEIPTS_ERA_START_KST = "2026-08-14 08:50:27";

// relay-handshake.mjs의 (export되지 않는) parseKstTimestamp와 동일
// 알고리즘의 로컬 복제 -- 이 파일에 relay-handshake.mjs를 새로 import하면
// mutation-test 격리 픽스처(hyk241-oneb-gate-mutation.test.mjs)가 그
// 전체 의존성 트리(envelope-archive.mjs·time-authority.mjs·
// consumption-receipt-writer.mjs·node:crypto 등)까지 떠안아야 한다 --
// isReviewFamilyRole/REVIEW_ROLE_RE를 zero-import 코어에서 이미 복제해
// 둔 이 저장소의 기존 관례(consumption-receipt-core.mjs 자체 주석 §3-b)
// 그대로 따른다.
function parseKstToMs(str) {
  if (typeof str !== "string") return null;
  const cleaned = str.trim().replace(/\s*KST\s*$/i, "");
  const match = cleaned.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/,
  );
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}+09:00`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

// HYK-244 2R-b4 §2-2 (한용 확정, 조용한 통과 금지): 직전 라운드의
// doneAt이 제도 시행 시점보다 이전이면, 이 라운드는 애초에 영수증을
// 만들 방법이 없었으므로 "미소비"로 거부하면 안 된다 -- "판정 대상
// 아님"이라는 명시 상태를 사유와 함께 stderr에 찍고 통과시킨다(§2-2
// 원문: "«아무 말 없이 ALLOW»는 실패다"). doneAt/기준값 중 하나라도
// 파싱 불가면 면제하지 않는다(안전측 기본값 -- 판정 대상인지조차 모를
// 때 조용히 통과시키면 §2-3 "면제가 앞으로도 통하는 구멍" 그 자체가
// 된다).
// HYK-244 2R-b4 §2-4 (한용 조건②, 위조 표면 조사에 대한 부분 대응):
// doneAt 하나만으로 면제를 결정하면, 그 값은 워커가 자기 결과 파일에
// 직접 쓰는 값이라 워커가 완료 후에라도 파일을 다시 열어 과거로
// 고쳐 쓰면 언제든 면제를 받을 수 있다(§2-4 조사 결과, 아래 함수
// 헤더에 상세 기재). droppedAt(정확히는 envelope-archive.mjs가 완료
// *직후* 즉시 보존한 아카이브 사본의 droppedAt)은 ORCH가 태스크를
// 드롭할 때 쓰는 값이고, 그 사본은 워커의 사후 편집 창(다음 라운드
// 드롭 전까지 남는 live 결과 파일과 달리) 밖에 있다 -- doneAt 위조만으로는
// 더 이상 면제를 받을 수 없게, **두 값 다** 시행 시점보다 이전이어야
// 면제하도록 강화했다(완전한 차단은 아니다 -- 정직 한계는 checkPredatesReceipts
// 헤더 및 결과 보고 §2-4에 기재).
function checkPredatesReceipts(currentBinding) {
  const doneAtMs = parseKstToMs(currentBinding?.doneAt);
  const droppedAtMs = parseKstToMs(currentBinding?.droppedAt);
  const eraStartMs = parseKstToMs(RECEIPTS_ERA_START_KST);
  if (doneAtMs === null || droppedAtMs === null || eraStartMs === null)
    return false;
  if (doneAtMs >= eraStartMs || droppedAtMs >= eraStartMs) return false;
  console.error(
    `dispatch-gate-decision consumption: PREDATES_RECEIPTS -- 직전 라운드(${currentBinding?.taskId ?? "(라벨 미상)"}, doneAt=${currentBinding?.doneAt}, droppedAt=${currentBinding?.droppedAt})는 영수증 제도 시행 이전이라 판정 대상 아님(기준=${RECEIPTS_ERA_START_KST} KST, commit 16eb377)`,
  );
  return true;
}

// 이 축의 메인 진입점. null 반환 = "이 축을 적용할 대상이 없다"(role을
// 못 뽑거나, 형제 결과 파일이 아예 없어 소비할 직전 라운드 자체가
// 없는 부트스트랩 상황) -- checkOneBPrecondition이 성공 시 null을
// 반환해 decisions 배열에 아무것도 안 쌓는 것과 같은 관례. 그 외에는
// toConsumptionGateDecision(1R 코어)의 반환값을 그대로 내놓는다(PASS면
// null, 아니면 {state, allow:false, reason}) -- 이 함수 자신은 ALLOW/
// REJECT를 스스로 판단하지 않는다.
// HYK-244 2R-ci-1 §C (한용 확정 12:40, 조건 4개): live 결과 파일
// (`<role>.md`)의 지문이 후보와 안 맞아도, 그 라운드가 실제로 소비될
// 때 envelope-archive.mjs가 남긴 보존 사본(`.harness/rounds/<ROLE>-r<N>.md`)
// 의 지문이 영수증과 일치하면 "소비됨"으로 인정한다 -- 소비 완료 *후에*
// live 파일이 한 글자만 손질돼도 영구 미소비가 되는 문제(ORCH 실측: 이
// 워크트리 자신의 커밋 라운드 영수증이 정확히 이 모양으로 걸렸다,
// resultFingerprint만 다름)의 대응.
//
// 보존 사본 헤더 처리(⛔추측 금지, 실측): archiveRoundEnvelope가 남기는
// 사본은 정확히 한 줄의 헤더 `<!-- envelope-archive: role=<ROLE>
// archived_at=<시각> -->\n`를 원문 앞에 덧붙인다(envelope-archive.mjs
// 193행 원문 그대로). 이 워크트리의 실제 rounds/CODER-r15.md로 직접
// 검증: 그 헤더 한 줄만 제거한 나머지가 그 라운드의 실제 영수증
// resultFingerprint(36d83fd8…)와 SHA-256이 정확히 일치했다(coder.md
// §B 참조) -- 그래서 아래는 "그 정확한 헤더 패턴이면 한 줄만 벗기고,
// 아니면(추측 금지) 지문을 계산하지 않고 판정 불가로 물러난다."
const ARCHIVE_ENVELOPE_HEADER_RE =
  /^<!-- envelope-archive: role=\S+ archived_at=.*? -->\n/;

function stripArchiveEnvelopeHeader(content) {
  const match = content.match(ARCHIVE_ENVELOPE_HEADER_RE);
  return match ? content.slice(match[0].length) : content;
}

// 여러 개면 조용히 하나를 고르지 않고 판정 불가로 거부한다(§C 지시
// "어느 사본이 그 라운드의 것인지" 규칙 -- 이 저장소의 확정 방향,
// resolveMatchingCandidate의 ambiguous 처리와 같은 정신). 반환:
// {ok:true, fingerprint, path} | {ok:true, fingerprint:null}(못 찾음,
// 지어내지 않음) | {ok:false, reason}(찾았지만 2개 이상 -- 판정 불가).
// HYK-244 gate-unblock-1 §1 조각3 (한용 «가» 확정): 옛 규칙은 "같은
// 라벨의 후보가 2개 이상이면 무조건 판정 불가"였다 -- 그런데 실사고
// (§0)로 보존함에 진짜 사본(REVIEW-r8.md, 영수증과 지문 일치)과 손상된
// 잔재(REVIEW-r1.md, 대소문자 충돌 버그가 남긴 것)가 같은 라벨로 함께
// 남으면서 영구 판정 불가가 됐다. ⛔코어(consumption-receipt-core.mjs)는
// 무변경, SHA-256 완전 일치 요구도 그대로 -- 바뀌는 것은 "후보가 여럿일
// 때 조용히 하나를 고르는" 것이 아니라 "targetFingerprint(영수증
// 결속의 resultFingerprint)와 «정확히 일치»하는 후보가 «정확히 하나»면
// 그것으로 인정, 0개거나 2개 이상이면 여전히 판정 불가"로 정밀화하는
// 것뿐이다.
function findArchivedResultFingerprint(
  harnessDir,
  role,
  harnessTaskLabel,
  targetFingerprint,
) {
  const roundsDir = join(harnessDir, "rounds");
  let names;
  try {
    names = readdirSync(roundsDir);
  } catch {
    return { ok: true, fingerprint: null };
  }
  const pattern = new RegExp(`^${role}-r\\d+\\.md$`, "i");
  const labelMatches = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    let raw;
    try {
      raw = readFileSync(join(roundsDir, name), "utf8");
    } catch {
      continue;
    }
    const stripped = stripArchiveEnvelopeHeader(raw);
    const strippedTaskId = resolveHeaderTaskId(stripped);
    if (!strippedTaskId.ok || strippedTaskId.id !== harnessTaskLabel) continue;
    labelMatches.push({
      path: join("rounds", name),
      fingerprint: computeConsumptionResultFingerprint(stripped),
    });
  }
  if (labelMatches.length === 0) return { ok: true, fingerprint: null };
  if (!isNonEmptyString(targetFingerprint)) {
    // 무엇과 대조해야 할지(영수증 쪽 목표 지문)조차 모른다 -- 후보가
    // 있어도 "하나를 고를 근거"가 없으므로 옛 규칙과 동일하게 판정
    // 불가로 물러난다(지어내지 않는다).
    return {
      ok: false,
      reason: `보존 사본 후보 ${labelMatches.length}건이 같은 라벨(${harnessTaskLabel})과 일치하지만 대조할 목표 지문(영수증 결속)을 확정할 수 없다 -- 판정 불가`,
    };
  }
  const exactMatches = labelMatches.filter(
    (m) => m.fingerprint === targetFingerprint,
  );
  if (exactMatches.length === 0) return { ok: true, fingerprint: null };
  if (exactMatches.length > 1) {
    return {
      ok: false,
      reason: `보존 사본 후보 ${labelMatches.length}건 중 목표 지문과 일치하는 것이 ${exactMatches.length}건 -- 어느 것이 그 라운드의 것인지 결정할 수 없다(판정 불가, 조용히 하나를 고르지 않음)`,
    };
  }
  return {
    ok: true,
    fingerprint: exactMatches[0].fingerprint,
    path: exactMatches[0].path,
    labelMatchCount: labelMatches.length,
  };
}

// HYK-244 gate-unblock-1 §1 조각3 / HYK-263 §1 확장: currentBinding과
// taskId/role/droppedAt/dispatchId(=resultFingerprint·doneAt을 제외한
// 나머지 4성분) 전부가 정확히 같은 영수증 후보를 찾는다 -- 그 후보의
// resultFingerprint가 "보관함 대조가 맞혀야 할 목표값"이다. 정확히
// 하나가 아니면(0개 또는 2개 이상) 목표를 확정할 수 없다(undefined
// 반환, 지어내지 않음). HYK-263: doneAt은 더 이상 대조 성분이 아니다
// -- 검토 좌석이 소비 후 자기 결과 파일의 `>>> DONE:` 시각을 갱신하면
// 영수증의 doneAt과 라이브 결과 파일에서 새로 읽은 doneAt이 달라져
// 옛 5성분 규칙에서는 후보를 하나도 못 찾았다(2026-08-14 실사고,
// coder-task.md §0). ⛔resultFingerprint의 완전 일치 요구, "정확히
// 하나만 인정" 원칙, live 우선 재시도 구조는 조금도 바뀌지 않는다 --
// 대조 성분에서 doneAt 하나만 빠졌을 뿐이다.
const OTHER_BINDING_FIELDS = ["taskId", "role", "droppedAt", "dispatchId"];

// HYK-263 2R §1-② 갈래 «가»: 이 선별 함수 자체를 단위로 시험하려면
// export가 필요하다(dispatch-gate-decision.mjs는 그 전까지 CLI
// 진입점(runDispatchGateDecision)만 내보냈다 -- 이 라운드가 유일한
// export 추가다, 동작은 조금도 바뀌지 않는다).
export function findTargetFingerprint(currentBinding, candidates) {
  const matches = (Array.isArray(candidates) ? candidates : []).filter((c) =>
    OTHER_BINDING_FIELDS.every(
      (field) => c?.binding?.[field] === currentBinding?.[field],
    ),
  );
  if (matches.length !== 1) return undefined;
  const matched = matches[0];
  if (matched.binding?.doneAt !== currentBinding?.doneAt) {
    // ★무엇을 완화했는지 사람이 보게(coder-task.md §1 점5) -- doneAt이
    // 달라서 대조 성분을 좁혀 이 후보를 인정했다는 사실 자체를 남긴다.
    console.error(
      `dispatch-gate-decision consumption: doneAt 성분 제외 후보 인정 -- live doneAt=${currentBinding?.doneAt} 영수증 doneAt=${matched.binding?.doneAt} (taskId/role/droppedAt/dispatchId 4성분만 일치, doneAt 불일치는 허용됨)`,
    );
  }
  // HYK-263: fingerprint뿐 아니라 그 후보의 doneAt도 함께 돌려준다 --
  // 아래 재시도가 부르는 1R 코어(⛔수정 금지)는 여전히 6성분 전부를
  // 정확히 비교하므로, doneAt을 목표 후보 것으로 맞추지 않으면 live의
  // (손질된) doneAt과 어긋나 재시도가 코어 자체에서 실패한다.
  return {
    fingerprint: matched.binding.resultFingerprint,
    doneAt: matched.binding.doneAt,
  };
}

// HYK-244 2R-ci-1 §C: 1R 코어(⛔수정 금지)를 그대로 두고, live 지문으로
// 실패했을 때만 "그 실패의 유일한 원인이 resultFingerprint였다면" 보존
// 사본 지문으로 한 번 더 시도한다 -- 다른 필드(role/droppedAt/dispatchId/
// doneAt)까지 함께 바뀌는 것은 아니므로, resultFingerprint 하나만 바꾼
// currentBinding으로 같은 코어를 다시 부르는 것은 코어의 판정 로직을
// 조금도 바꾸지 않는다(그 함수를 두 번째로 호출할 뿐).
function tryArchiveFallback({
  role,
  currentBinding,
  candidates,
  harnessDir,
  harnessTaskLabel,
}) {
  const target = findTargetFingerprint(currentBinding, candidates);
  const targetFingerprint = target?.fingerprint;
  const archived = findArchivedResultFingerprint(
    harnessDir,
    role,
    harnessTaskLabel,
    targetFingerprint,
  );
  if (!archived.ok) {
    console.error(
      `dispatch-gate-decision consumption: 보관함 대조 판정 불가(안 지어냄) -- ${archived.reason}`,
    );
    return null;
  }
  if (!archived.fingerprint) return null; // 사본 자체가 없음 -- 조용히 물러난다(원래 실패를 그대로 반환).
  if (archived.fingerprint === currentBinding.resultFingerprint) return null; // live와 같음 -- 애초에 실패 원인이 아니었다.

  // ★조건② -- live≠보관함 불일치 관측을 무조건 먼저 찍는다(뒷손질
  // 관측 -- 이 사실 자체는 아래 재시도의 성패와 무관하게 항상 보인다).
  console.error(
    `dispatch-gate-decision consumption: live≠보관함 지문 불일치 관측 -- live=${currentBinding.resultFingerprint} archive(${archived.path})=${archived.fingerprint} (소비 후 결과 파일이 손질됐을 가능성)`,
  );

  const archiveBinding = {
    ...currentBinding,
    resultFingerprint: archived.fingerprint,
    // HYK-263: doneAt도 목표 후보의 것으로 맞춘다(위 findTargetFingerprint
    // 주석 참조) -- 대조 성분에서 doneAt을 뺀 것은 "후보를 찾는" 단계
    // 뿐이고, 코어 자신의 6성분 완전 일치 요구는 손대지 않았으므로
    // 재시도도 그 6성분을 채워 줘야 한다.
    doneAt: target?.doneAt ?? currentBinding.doneAt,
  };
  const retry = toConsumptionGateDecision({
    role,
    currentBinding: archiveBinding,
    candidates,
  });
  if (retry !== null) return null; // 보관함 지문으로도 매치 안 됨 -- 원래 실패를 그대로 반환.

  // ★조건① -- 보관함 대조로 인정될 때 사유가 반드시 찍힌다(조용한 통과
  // 0). §1 조각3 점4: 어느 사본을 왜 골랐는지 + 같은 라벨 후보 몇 건 중
  // 몇 건이 목표 지문과 일치했는지(정밀화가 실제로 "정확히 하나"만
  // 골랐다는 증거)를 함께 남긴다.
  console.error(
    `dispatch-gate-decision consumption: ARCHIVE_MATCH -- live 지문 불일치이나 보존 사본(${archived.path}) 지문이 영수증 결속의 목표 지문과 정확히 일치(같은 라벨 후보 ${archived.labelMatchCount}건 중 일치 1건) -> 소비 완료로 판정, 허용`,
  );
  return true;
}

// ===========================================================================
// HYK-298-abort-record-1 §2 -- «중단 기록»(abort record) 축.
//
// §1 무엇을 위한 것인가(coder-task.md §1 원문): 죽은 라운드가 이름표
// (`task_id:`) 없이 결과 파일을 남기면, 위 harnessTaskLabel이 undefined가
// 되어 dispatchId 조회조차 못 하고 영원히 BINDING_MISMATCH로 거부된다 --
// 그 상태에서 빠져나가는 설계된 문이 없었다(유일한 기계 통과법은 결과
// 파일을 치우는 것뿐이었다). 이 축은 그 문이다: ORCH가 `.harness/aborts/
// <role>-abort-r<N>.json`에 «이 라운드는 중단됐다»는 증거(직전 배달
// 영수증에서 뽑은 dispatchId·harnessTaskLabel + 죽은 결과 파일의 SHA-256
// 지문 + admission 원장의 SUSPECT_TIMEOUT_RECOVERED 회수 표식)를 남기면,
// 그 기록이 abort-record-core.checkAbortRecord의 3개 독립 검증(지문 일치 ·
// dispatchId 실재 확인 · 회수 표식 확인)을 전부 통과할 때만 소비된 것으로
// 인정한다.
//
// §2 언제만 적용하는가(⛔coder-task.md §3 항3 요구 그대로 -- "내용 있는
// 미소비는 붙이든 말든 REJECT 유지"): harnessTaskLabel이 결과 파일에서
// 뽑히지 않을 때(이름표 자체가 없는 라운드)만 이 축을 켠다. 정상적으로
// `task_id:` 줄이 있는(=진짜 완료됐거나 최소한 자기 신원은 남긴) 결과
// 파일은 이 축을 아예 거치지 않는다 -- 그런 파일에 아무리 중단 기록을
// 갖다 붙여도 evaluateConsumptionDecision이 이 분기 자체에 진입하지
// 않으므로 옛 경로(consumption-receipt 축)만 그대로 적용된다. 이것이
// "내용 있는 미소비"가 중단 기록의 존재 여부와 무관하게 항상 REJECT로
// 남는 이유다.
function isNonEmptyAbortString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// §3-2와 동일한 arg-with-env-fallback 관례(resolveDispatchReceiptPath 참조).
function resolveAdmissionLedgerPathForAbort(args, env) {
  if (isNonEmptyAbortString(args.admissionLedgerPath))
    return args.admissionLedgerPath;
  if (isNonEmptyAbortString(env.ADMISSION_LEDGER_PATH))
    return env.ADMISSION_LEDGER_PATH;
  return null;
}

// `<harnessDir>/aborts/<role>-abort-r<N>.json` 전부를 후보로 읽는다 --
// readConsumptionCandidates와 동일한 "전부 읽고 코어가 걸러낸다" 원칙
// (과거/무관 라운드 기록이 섞여 있어도 지문이 안 맞으면 코어가 스스로
// 무시한다는 보장을 시험할 기회를 남긴다). 개별 파일 읽기/파싱 실패는
// 그 파일만 건너뛴다(손상된 기록 하나가 전체 조회를 막지 않는다 --
// readConsumptionCandidates와 동일 이유).
function readAbortRecordFiles(harnessDir, role) {
  const abortsDir = join(harnessDir, "aborts");
  let names;
  try {
    names = readdirSync(abortsDir);
  } catch {
    return [];
  }
  const pattern = new RegExp(`^${role}-abort-r\\d+\\.json$`, "i");
  const records = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    try {
      records.push(JSON.parse(readFileSync(join(abortsDir, name), "utf8")));
    } catch {
      // 손상/미완성 쓰기 -- 건너뛴다(위 함수 헤더 참조).
    }
  }
  return records;
}

// §3 검증2 -- 기록이 주장하는 dispatchId가 실제 배달 영수증(dispatch-
// receipts.jsonl)의 role+harnessTaskLabel 조합에서 나온 값과 정확히
// 같은가. 기존 lookupDispatchId를 그대로 재사용한다(같은 파일, 같은
// "지어내지 않는다" 계약 -- 조회 실패/정말 없음 둘 다 verified:false).
function verifyAbortRecordDispatchId(record, receiptPath) {
  const lookup = lookupDispatchId({
    role: record?.role,
    harnessTaskLabel: record?.harnessTaskLabel,
    receiptPath,
  });
  return (
    lookup.ok &&
    lookup.found &&
    isNonEmptyAbortString(record?.dispatchId) &&
    lookup.dispatchId === record.dispatchId
  );
}

// §3 검증3 -- admission 원장(scripts/supervisor/admission-ledger-core.mjs의
// sweepAndRecover가 남기는 것과 정확히 같은 모양)을 «읽기만» 한다(⛔쓰지
// 않는다, §4 범위 "실물 원장에 닿지 마라"와 별개로 이 축 자체가 읽기
// 전용 판정이다). reservationId는 admission-completion-adapter.mjs의
// spawnAdmissionCompletion(taskId)가 이미 실증한 관례(harnessTaskLabel을
// 그대로 reservationId로 쓴다, relay-handshake.mjs 1058-1064행)를
// 그대로 따른다 -- 새 관례를 만들지 않는다. 원장을 읽을 수 없거나
// (경로 미설정·파일 없음·JSON 파싱 실패) 그 예약이 없거나 completion_
// reason이 정확히 "SUSPECT_TIMEOUT_RECOVERED"가 아니면 false(안전측
// 기본값 -- "없으면 막는다").
// HYK-342/HYK-249: 두 번째로 인정하는 회수 표식 값. sweepAndRecover의
// 시간-기반 회수(SUSPECT_TIMEOUT_RECOVERED)와 달리, relay-handshake.mjs가
// BLOCKED/NEEDS_INPUT 핸드셰이크에서 즉시(sweep 대기 없이) admission-
// ledger-core.mjs의 completeReservation을 이 reason으로 불러 자리를
// 반납한다(admission-ledger-core.mjs의 COMPLETION_REASON 참조 -- 이 파일은
// 그 모듈을 새로 import하지 않는다, 기존 SUSPECT_TIMEOUT_RECOVERED 리터럴도
// import 없이 직접 비교하는 이 파일의 기존 관례를 그대로 따른다). 둘 중
// 하나만 있어도 "이 예약이 실제로 회수됐다"는 기계 표식으로 인정한다 --
// admission-ledger-core.mjs의 sweep 상태기계 의미는 조금도 바뀌지 않는다
// (completeReservation은 sweep이 아니라 명시적 소비자 호출이다).
const RECOVERY_MARKER_ALLOWED_REASONS = new Set([
  "SUSPECT_TIMEOUT_RECOVERED",
  "BLOCKED_TERMINATION_RELEASED",
]);

function verifyAbortRecordRecoveryMarker(record, ledgerPath) {
  if (!isNonEmptyAbortString(ledgerPath)) return false;
  if (!isNonEmptyAbortString(record?.harnessTaskLabel)) return false;
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  } catch {
    return false;
  }
  const entry = ledger?.reservations?.[record.harnessTaskLabel];
  return RECOVERY_MARKER_ALLOWED_REASONS.has(entry?.completion_reason);
}

// 이 축의 메인 진입점. evaluateConsumptionDecision이 harnessTaskLabel을
// 못 뽑았을 때(§2)만 부른다. checkAbortRecord(코어)의 판정을 그대로
// 내놓는다(VERIFIED면 null=ALLOW, 아니면 {state, allow:false, reason}) --
// 이 함수 자신은 ALLOW/REJECT를 스스로 판단하지 않는다. candidates가
// 하나 이상 있었다면(이 축이 실제로 판정에 관여했다면) 사유를 항상
// stderr에 남긴다(조용한 통과/조용한 흡수 금지, ARCHIVE_MATCH와 동일
// 원칙).
// HYK-342/HYK-249 (HYK-244 2R-b3 결함2와 동일한 근본 원인): abort-record-
// writer.mjs를 실제로 호출하는 프로덕션 생산자(relay-handshake.mjs의
// runBlockedTerminationSideEffectsIfApplicable)는 완료 시점에 자기
// dispatchId를 알 방법이 없다(그 파일 자신의 CLI 진입점은 dispatchId를
// 전혀 받지 않는다 -- ORCH 실측: relay-core.mjs/orca-spike-*.mjs 등 어느
// 실제 호출자도 checkRelayHandshake에 dispatchId를 넘기지 않는다). 같은
// 비대칭을 consumption 축의 enrichCandidateDispatchId(위)가 이미
// currentBinding 쪽에서 풀었다 -- 이 함수는 abort-record 후보 쪽에 같은
// 보강을 적용한다: 기록이 이미 dispatchId를 담고 있으면(예: HYK-298의
// 원래 MISSING-label 사용례처럼 사람이 직접 채운 경우) 그대로 두고, 비어
// 있을 때만 같은 출처(dispatch-receipts.jsonl)에서 role+harnessTaskLabel로
// 조회해 채운다 -- 지어내지 않는다(조회 실패/불명이면 그대로 undefined).
function enrichAbortRecordDispatchId(record, receiptPath) {
  if (isNonEmptyAbortString(record?.dispatchId)) return record;
  const role = record?.role;
  const harnessTaskLabel = record?.harnessTaskLabel;
  if (!isNonEmptyAbortString(role) || !isNonEmptyAbortString(harnessTaskLabel))
    return record;
  const lookup = lookupDispatchId({ role, harnessTaskLabel, receiptPath });
  if (!lookup.ok || !lookup.found) return record;
  return { ...record, dispatchId: lookup.dispatchId };
}

function evaluateAbortRecordDecision({
  role,
  harnessDir,
  resultText,
  receiptPath,
  admissionLedgerPath,
}) {
  const liveFingerprint = computeConsumptionResultFingerprint(resultText);
  const records = readAbortRecordFiles(harnessDir, role).map((record) =>
    enrichAbortRecordDispatchId(record, receiptPath),
  );
  const candidates = records.map((record) => ({
    record,
    dispatchIdVerified: verifyAbortRecordDispatchId(record, receiptPath),
    recoveryMarkerVerified: verifyAbortRecordRecoveryMarker(
      record,
      admissionLedgerPath,
    ),
  }));
  // HYK-244 2R-b3 결함3과 동일한 이유(위 currentBinding.role 주석 참조):
  // 실제 생산 관례상 role은 대문자로 굳는다 -- 기록 파일의 role 필드도
  // 그 관례를 따른다고 기대하고, 코어에 넘기는 role 사실도 그에 맞춘다.
  const verdict = checkAbortRecord({
    role: role.toUpperCase(),
    liveFingerprint,
    candidates,
  });
  // ★조용한 통과/조용한 흡수 금지 -- ARCHIVE_MATCH(위 tryArchiveFallback)와
  // 동일 원칙: ALLOW든(중단 기록이 이 라운드를 소비된 것으로 인정) 이
  // 축이 실제로 판정에 관여했다면(=candidates가 하나 이상, 즉 위조/시도된
  // 중단 기록이 있었다면) 항상 사유를 stderr에 남긴다. candidates가
  // 아예 없으면(이 axis를 시도조차 안 한 경우 -- 원래 사고의 기본 모양)
  // 로그를 남기지 않는다 -- 옛 경로만 있던 시절과 화면 출력이 동일해야
  // 회귀 0이다.
  if (candidates.length > 0) {
    console.error(`dispatch-gate-decision ${verdict.reason}`);
  }
  if (verdict.state === ABORT_RECORD_STATE.VERIFIED) return null;
  return { state: verdict.state, allow: false, reason: verdict.reason };
}

// evaluateConsumptionDecision 자신의 eslint complexity 상한을 지키기 위해
// §2 분기 하나를 여기로 뽑았다(HYK-244-receipt-core-1b 품질 보정 선례와
// 동일한 이유 -- 판정/문구는 조금도 바뀌지 않는다, 몸통만 쪼갠다). 반환:
// {done:true, result:null}(ALLOW) | {done:true, result:<REJECT 모양>} |
// {done:false}(옛 경로로 흘러 내려간다 -- NO_RECORD일 때만).
function resolveAbortRecordOutcome({
  role,
  harnessDir,
  resultText,
  receiptPath,
  admissionLedgerPath,
}) {
  const abortDecision = evaluateAbortRecordDecision({
    role,
    harnessDir,
    resultText,
    receiptPath,
    admissionLedgerPath,
  });
  if (abortDecision === null) return { done: true, result: null }; // ALLOW.
  if (abortDecision.state !== ABORT_RECORD_STATE.NO_RECORD) {
    return { done: true, result: abortDecision };
  }
  return { done: false };
}

// ===========================================================================
// HYK-311-retire-1 §2 -- «은퇴 기록»(retirement record) 축.
//
// §1 무엇을 위한 것인가(retirement-record-core.mjs 헤더 §1 원문 요약):
// abort-record 축(바로 위)은 이름표(`task_id:`)가 «아예 없는»(MISSING)
// 라운드만 구제한다 -- classifyTaskIdLabel의 kind === "MISSING" 한정,
// HYK-298-key-narrow-4 §2가 확정한 경계이며 이 축은 그 경계를 조금도
// 건드리지 않는다(아래 maybeResolveRetirementForValidLabel은 kind ===
// "VALID"일 때만 시도된다, MISSING/BROKEN은 전혀 이 축을 거치지 않는다).
// 그런데 이름표는 멀쩡한데(VALID) 정상 소비 영수증 체인
// (consumption-receipt-core.mjs, tryArchiveFallback 포함)으로 절대 소비될
// 수 없는 라운드가 생길 수 있다(예: DONE 타임스탬프가 기계로 파싱 불가한
// 형태로 남았거나, 재작성이 금지됐거나, 그 태스크 계약 자체가 결과 수리를
// 금지한 경우). 이 축은 그런 라운드를 위한, «정상 통로가 이미 실패했을
// 때만» 시도되는 별도 문이다(아래 evaluateConsumptionDecision 결선 위치
// 참조 -- tryArchiveFallback 다음, decision을 그대로 반환하기 직전).
//
// §2 언제만 적용하는가: labelInfo.kind === "VALID"일 때만(위 §1). BROKEN은
// 여전히 어떤 통로도 얻지 못한다(HYK-298-key-narrow-4의 "BROKEN = 언제나
// 차단" 진실을 그대로 유지 -- 이 축이 BROKEN을 위한 새 열쇠가 되지 않는다).
// ===========================================================================

// role/harnessTaskLabel 조합으로 `<harnessDir>/retirements/<role>-retire-
// r<N>.json` 전부를 후보로 읽는다 -- readAbortRecordFiles와 동일한 "전부
// 읽고 코어가 걸러낸다" 원칙. 개별 파일 읽기/파싱 실패는 그 파일만
// 건너뛴다.
function readRetirementRecordFiles(harnessDir, role) {
  const retirementsDir = join(harnessDir, "retirements");
  let names;
  try {
    names = readdirSync(retirementsDir);
  } catch {
    return [];
  }
  const pattern = new RegExp(`^${role}-retire-r\\d+\\.json$`, "i");
  const records = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    try {
      records.push(
        JSON.parse(readFileSync(join(retirementsDir, name), "utf8")),
      );
    } catch {
      // 손상/미완성 쓰기 -- 건너뛴다.
    }
  }
  return records;
}

// §3-1 (retirement-record-core.mjs 헤더): 아카이브 위치·관례를 재구현하지
// 않는다 -- 소비 축(tryArchiveFallback/findArchivedResultFingerprint)이
// 이미 쓰는 `.harness/rounds/<role>-r<N>.md` 보존 사본 관례를 그대로
// 재사용한다. findArchivedResultFingerprint(위, 소비 축 전용)는 "targetFingerprint
// 와 정확히 일치"만 반환하고 "존재하지만 다른 지문"을 구별하지 않으므로
// (그 함수는 재사용하지 않는다), 이 축은 자체적으로 label 일치 사본을
// 먼저 찾고(존재 여부를 그 자체로 판정), 그 다음에야 지문을 대조한다 --
// 위조 변종 c1(아카이브 자체가 없음)과 c2(아카이브는 있으나 지문이 다름)
// 를 서로 다른 상태로 구별하기 위해서다(요구서 §c 세 위조 변종이 구별되는
// 사유로 거부돼야 한다는 요구).
// HYK-455 §1 확대 라운드: envelope-archive.mjs의 archiveUnconsumedRoundEnvelope
// 가 새기는 원문 결속 필드(content_sha256, kind=unconsumed_result 헤더
// 라인 전용)를 몸통에서 다시 계산해 재확인한다. raw(스트립 전) 원문에서
// 그 헤더 한 줄만 뽑아 두 필드(kind/content_sha256)를 읽는다 -- 본문
// 텍스트가 우연히 같은 패턴의 문자열을 담고 있어도 헤더 밖은 절대
// 읽지 않는다.
//   - 헤더 자체가 없음(구 소비-성공 아카이브 · 이 필드를 아예 선언하지
//     않는 시험 픽스처) -> null(이 축이 적용될 대상이 아니다, 회귀 0 --
//     기존 archiveFingerprintMatches/liveFingerprintMatches 대조만 그대로
//     적용된다).
//   - kind=unconsumed_result 를 선언하지 않음 -> 마찬가지로 null(다른
//     kind의 헤더는 이 축의 관심사가 아니다).
//   - kind=unconsumed_result 는 선언했는데 content_sha256 필드가 없음 ->
//     false(§2 완료조건4 음성 시험 ⓑ: 결속 필드가 아예 없는 사본).
//   - content_sha256 필드는 있는데 몸통 재계산 값과 다름 -> false(§2
//     완료조건4 음성 시험 ⓐ: 원문과 결속이 어긋난 손 사본).
//   - 필드가 있고 몸통과 일치 -> true.
// HYK-461 §4-A: resolveEnvelopeBindingValidity (and its three header regexes)
// used to live here as this file's own copy -- now imported from
// envelope-archive.mjs, the producer of the very header it reads back (see
// that function's header for the single-source rationale and why the adapter
// side, not this side, was the one silently missing it). Byte-for-byte the
// same contract: the shared version recomputes the body sha256 with the same
// createHash("sha256").update(body,"utf8").digest("hex") this file's
// computeConsumptionResultFingerprint uses.

function resolveRetirementArchiveCandidate(
  harnessDir,
  role,
  harnessTaskLabel,
  claimedFingerprint,
) {
  const roundsDir = join(harnessDir, "rounds");
  let names;
  try {
    names = readdirSync(roundsDir);
  } catch {
    return { exists: false, fingerprintMatches: false };
  }
  const pattern = new RegExp(`^${role}-r\\d+\\.md$`, "i");
  const matches = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    let raw;
    try {
      raw = readFileSync(join(roundsDir, name), "utf8");
    } catch {
      continue;
    }
    const stripped = stripArchiveEnvelopeHeader(raw);
    const strippedTaskId = resolveHeaderTaskId(stripped);
    if (!strippedTaskId.ok || strippedTaskId.id !== harnessTaskLabel) continue;
    matches.push({
      path: join("rounds", name),
      fingerprint: computeConsumptionResultFingerprint(stripped),
      envelopeBindingValid: resolveEnvelopeBindingValidity(raw, stripped),
    });
  }
  if (matches.length === 0) return { exists: false, fingerprintMatches: false };
  if (matches.length > 1) {
    // 라벨이 일치하는 사본이 2개 이상 -- 어느 것을 대조해야 할지 조용히
    // 고르지 않는다. "아카이브는 있으나(exists) 유일하게 확정할 수 없어
    // 지문 대조를 통과시키지 않는다"는 뜻으로 fingerprintMatches:false를
    // 반환한다(FINGERPRINT_MISMATCH 상태로 떨어진다, 안전측 기본값).
    return {
      exists: true,
      fingerprintMatches: false,
      ambiguousCount: matches.length,
    };
  }
  return {
    exists: true,
    fingerprintMatches: matches[0].fingerprint === claimedFingerprint,
    envelopeBindingValid: matches[0].envelopeBindingValid,
    path: matches[0].path,
  };
}

// HYK-457: this function (and its RUNNER_GREEN_UNREACHABLE_AT_HEAD-only
// helper confirmRunnerGreenUnreachableAtHead, and the evidence-receipt-path
// resolver it needed) used to live here as its own copy, with a byte-drifted
// twin in admission-completion-adapter.mjs -- HYK-455 added the third
// mechanically-confirmable reason to this copy only, and the adapter's
// unpatched twin fail-closed every RUNNER_GREEN_UNREACHABLE_AT_HEAD
// retirement release for real (2026-09-08 ORCH-63 isolated measurement).
// Both copies are now retirement-block-reason-shared.mjs (see its header
// for the full contract and the "why not just import dispatch-gate-
// decision.mjs from the adapter" answer, and the import near the top of
// this file next to retirement-record-core.mjs). This file is the heavy
// one, so unlike the adapter it is never copied into an isolated mutation
// fixture -- tests spawn it at its real repo path instead -- so no
// sibling-list update was needed on this side.

// 이 축의 메인 진입점. checkRetirementRecord(코어)의 판정을 그대로
// 내놓는다(RETIRED면 null=ALLOW, 아니면 {state, allow:false, reason}) --
// abort 축의 evaluateAbortRecordDecision과 동일한 관례, 조용한 통과/조용한
// 흡수 금지도 동일(candidates.length > 0일 때만 stderr에 사유를 남긴다).
function evaluateRetirementDecision({
  role,
  harnessDir,
  resultText,
  harnessTaskLabel,
  droppedAt,
  admissionLedgerPath,
}) {
  const records = readRetirementRecordFiles(harnessDir, role);
  const liveFingerprint = computeConsumptionResultFingerprint(resultText);
  const candidates = records.map((record) => {
    const archiveInfo = resolveRetirementArchiveCandidate(
      harnessDir,
      role,
      harnessTaskLabel,
      record?.archiveFingerprintClaimed,
    );
    return {
      record,
      archiveExists: archiveInfo.exists,
      // HYK-455 §1 확대 라운드: resolveRetirementArchiveCandidate가 이미
      // 계산한 값을 그대로 옮긴다(true/false/null) -- ambiguousCount 분기
      // (2개 이상 매치)는 이 필드를 아예 채우지 않으므로 undefined가 되고,
      // checkArchiveFacts는 undefined를 null과 동일하게(=== false가
      // 아니므로 통과) 취급한다 -- 그 분기는 이미 fingerprintMatches:false
      // 로 FINGERPRINT_MISMATCH에 떨어지므로 이 축이 앞지를 필요가 없다.
      envelopeBindingValid: archiveInfo.envelopeBindingValid,
      archiveFingerprintMatches: archiveInfo.fingerprintMatches,
      // §3-1(c): 오늘의 실제 호출 경로는 liveFingerprint가 항상 계산
      // 가능한 시점에서만 이 축을 시도한다(resultText가 이미 읽혀
      // 있어야만 evaluateConsumptionDecision이 이 지점까지 도달한다) --
      // null 분기(live 사본이 아예 없어 대조를 건너뜀)는 방어적으로
      // 지원하되 이 배선에서는 도달하지 않는다(retirement-record-core.mjs
      // §5-c에 명시).
      liveFingerprintMatches:
        liveFingerprint === record?.archiveFingerprintClaimed,
      // HYK-398: droppedAt(호출자가 아카이브 사본에서 뽑아 온 값,
      // buildCurrentBinding.droppedAt) 전달 -- DONE_PREDATES_DROPPED_AT
      // 재확인에만 쓰인다(위 confirmRetirementBlockReason 헤더 참조).
      // HYK-478: admissionLedgerPath 전달 -- AUTHOR_SEAT_LOST_BEFORE_STAMP
      // 재확인에만 쓰인다(위 confirmRetirementBlockReason 헤더 참조).
      blockReasonConfirmed: confirmRetirementBlockReason(
        record,
        resultText,
        droppedAt,
        harnessDir,
        admissionLedgerPath,
      ),
    };
  });
  const verdict = checkRetirementRecord({
    role: role.toUpperCase(),
    harnessTaskLabel,
    candidates,
  });
  if (candidates.length > 0) {
    console.error(`dispatch-gate-decision ${verdict.reason}`);
  }
  if (verdict.state === RETIREMENT_RECORD_STATE.RETIRED) return null;
  return { state: verdict.state, allow: false, reason: verdict.reason };
}

// resolveAbortRecordOutcome과 동일한 구조: null=ALLOW, NO_RECORD가 아닌
// 실패는 즉시 그 사유로 REJECT, NO_RECORD(=은퇴 기록을 시도조차 안 함)면
// {done:false}로 물러나 호출자가 원래의 consumption REJECT 사유를 그대로
// 쓰게 한다(§ REGRESSION 요구: 은퇴 기록이 없으면 정상 미소비 REJECT가
// 조금도 바뀌지 않는다).
function resolveRetirementOutcome({
  role,
  harnessDir,
  resultText,
  harnessTaskLabel,
  droppedAt,
  admissionLedgerPath,
}) {
  const retirementDecision = evaluateRetirementDecision({
    role,
    harnessDir,
    resultText,
    harnessTaskLabel,
    droppedAt,
    admissionLedgerPath,
  });
  if (retirementDecision === null) return { done: true, result: null };
  if (retirementDecision.state !== RETIREMENT_RECORD_STATE.NO_RECORD) {
    return { done: true, result: retirementDecision };
  }
  return { done: false };
}

// §2: kind === "VALID"일 때만 시도한다(위 헤더 §2). 그 외(MISSING/BROKEN)
// 는 곧바로 {done:false}로 물러난다 -- MISSING은 abort 축의 전담 영역이고
// (이 축은 관여하지 않는다), BROKEN은 어떤 축의 열쇠도 아니다.
function maybeResolveRetirementForValidLabel({
  labelInfo,
  role,
  harnessDir,
  resultText,
  harnessTaskLabel,
  droppedAt,
  admissionLedgerPath,
}) {
  if (labelInfo.kind !== "VALID") return { done: false };
  return resolveRetirementOutcome({
    role,
    harnessDir,
    resultText,
    harnessTaskLabel,
    droppedAt,
    admissionLedgerPath,
  });
}

// HYK-298-abort-record-2 §2-1 -> HYK-298-label-classify-3 §2-3(단락 순서
// 수리) -> HYK-298-key-narrow-4 §2(열쇠 종류 좁히기, 검토 3R 반려 수리)
// 로 갱신 -- ★한용 위임 판정 문자 그대로: ***«BROKEN 통과 열쇠 = 정상
// 소비 영수증 체인뿐. 중단 기록은 MISSING 전용이며 BROKEN에서는 열쇠가
// 아니다.»*** 3R은 "없는 것"(MISSING)과 "있지만 깨진 것"(BROKEN) 둘 다
// 먼저 중단 기록(abort-record) 축을 시도하게 했다 -- 그런데 검토가
// 실측했듯 `abort-record-writer.mjs`는 **호출자가 필드를 넘기면 그대로
// JSON을 쓰는 생산자**일 뿐, 그 기록의 작성 주체·무결성·admission
// 원장 자체의 변조 여부를 인증하지 않는다(★공통 문장: "문을 여는
// 열쇠를 문 안에 있는 사람이 스스로 만들 수 있으면, 그건 잠긴 문이
// 아니다"). `BROKEN`(복수·공백/빈값·줄 중간·줄넘김 오인식 -- 이름표를
// 신뢰할 수 없는 라운드)에게 그 자가생산 가능한 열쇠로 문을 열어주는
// 것은 3R이 고치려던 과차단 문제와 무관하게 새 위조 경로를 여는
// 것이었다(검토 4형태 ALLOW 재현이 그 증거).
//
// 그래서 이제 **`MISSING`만** 중단 기록 축을 탄다(ⓑ, 본래 HYK-298의
// 목적 그대로 -- 이름표 없이 죽은 라운드를 구제하는 문). `VALID`와
// `BROKEN`은 **똑같이** {done:false}로 물러나 옛 consumption-receipt
// 경로(보관 사본 + 소비 영수증, `toConsumptionGateDecision`)로 내려간다
// (ⓐ). `BROKEN`을 위한 별도의 즉시 REJECT 분기(3R의 `rejectForBrokenLabel`)
// 도 제거했다 -- BROKEN은 harnessTaskLabel이 애초에 undefined이므로
// (`labelInfoToHarnessTaskLabel` 참조) 그 옛 경로 자체가 dispatchId를
// 조회할 열쇠를 못 찾아 구조적으로 REJECT로 떨어진다(그 REJECT 사유는
// VALID 미소비 라운드가 §C에서 이미 겪는 것과 같은 계열의 소비-영수증
// 부재 사유이지, "이름표가 깨졌다"는 별도 사유가 아니다 -- BROKEN에게
// 특별 취급을 하나도 남기지 않는 것이 이 열쇠 좁히기의 요지다).
//
// HYK-298-label-boundary-5 §2 항ⓑ(계약 문구 정직화, 4R 정직 한계에서
// 검토가 실행으로 확인한 사실 그대로): `dispatchId`는 오직
// `lookupDispatchId(role, harnessTaskLabel, receiptPath)`로만 조회되고,
// `harnessTaskLabel`은 `kind === "VALID"`일 때만 실제 값을 갖는다. 즉
// `kind === "BROKEN"`인 라운드는 `currentBinding.dispatchId`가 **항상**
// `undefined`이므로 `checkBindingPreconditions`(주 열쇠 필수)에서
// 구조적으로 걸려 반드시 `BINDING_MISMATCH`로 REJECT된다 -- "정상 소비
// 영수증 체인이 있으면 BROKEN도 통과할 수 있다"는 4R의 표현은 ***도달
// 불가능한 경로를 있는 것처럼 말한 것***이었다(검토 반려 사유 ⓑ 그대로:
// "이 기록은 소비 영수증과 동일하지 않다"는 지적을 넘어, 그 소비
// 영수증 경로 자체가 BROKEN에게는 열리지 않는다). ***현재의 진실은
// «BROKEN = 언제나 차단»이다*** -- 아래 코드는 그 진실을 그대로
// 구현한다(BROKEN이 통과할 "열쇠"를 새로 만들지 않는다, 지시서 §2 항ⓑ
// ⛔"도달 경로를 새로 만들지는 마라"). 이 진입점(`{done:false}`로
// 물러나 옛 경로로 흘려보내는 것) 자체는 §C(내용 있는 미소비)가 이미
// 거치는 것과 동일한 관례를 재사용한 것일 뿐, BROKEN 전용의 새 통과
// 가능성을 여는 것이 아니다.
function maybeResolveAbortRecordForMissingLabel({
  labelInfo,
  role,
  harnessDir,
  resultText,
  receiptPath,
  args,
  env,
}) {
  if (labelInfo.kind !== "MISSING") return { done: false };
  return resolveAbortRecordOutcome({
    role,
    harnessDir,
    resultText,
    receiptPath,
    admissionLedgerPath: resolveAdmissionLedgerPathForAbort(args, env),
  });
}

// HYK-342/HYK-249 §3/§4 요구1 -- 이름표가 VALID여도(정지 라운드는 task_id
// 줄을 정상적으로 쓴다, §1 "빠진 고리 1") 중단 기록 축을 연다. ⛔새 판정
// 로직을 발명하지 않는다 -- checkAbortRecord(코어)도 resolveAbortRecordOutcome
// (바로 위 MISSING 축이 쓰는 그 함수)도 조금도 건드리지 않는다. 이 함수는
// «언제 그 축에 도달하는가»라는 게이팅 조건 하나만 추가한다(위 MISSING
// 전용 함수와 정확히 같은 모양, kind만 다르다). ⛔BROKEN은 여전히 이 문을
// 얻지 못한다 -- kind가 정확히 "VALID"일 때만 열린다(★한용 위임 판정
// "BROKEN 통과 열쇠 = 정상 소비 영수증 체인뿐"은 이 축이 조금도 건드리지
// 않는다).
//
// evaluateConsumptionDecision에서의 호출 위치(정상 소비 경로 + 아카이브
// 대조 + retirement 축이 전부 실패한 뒤, 맨 마지막)가 핵심이다 -- VALID
// 라벨의 대다수(정상 완료 라운드)는 doneAt이 있어 정상 경로에서 이미
// ALLOW로 끝나고 이 축에 도달조차 하지 않는다. 이 축에 실제로 도달하는
// VALID 라운드는 "이름표는 멀쩡한데 정상 경로로는 절대 소비될 수 없는"
// 라운드뿐이다 -- 그 중 진짜로 여기서 통과하는 것은 checkAbortRecord의
// 증거 3종(지문 일치·dispatchId 실재·회수 표식)을 전부 갖춘 것뿐이다
// (안전측 기본값은 그대로: 후보가 없거나 안 맞으면 NO_RECORD로 물러나
// 원래 REJECT 사유가 그대로 보존된다).
// HYK-342/HYK-249 2R (dispatch-gate-abort-wire.test.mjs §C 반례 수리):
// `labelInfo.kind === "VALID"` 하나만으로 이 문을 열면, task_id도 있고
// `>>> DONE:`도 있는데 «영수증만 아직 안 쓰인» 진짜 완료 라운드까지(HYK-298
// 이전부터 있던 별개의 결손, 이 라운드 범위 밖) 이 축을 타 버린다 -- §C가
// 지키던 "내용 있는 미소비는 이 축이 아예 적용되지 않는다"는 경계를
// 침범한다. ⛔이 축이 실제로 구제해야 하는 것은 BLOCKED-termination 라운드
// (task_id는 있지만 `>>> DONE:` 자체가 없는 모양)뿐이다 -- 그래서
// `doneAtMissing`(호출자가 이미 뽑아 둔 currentBinding.doneAt이 undefined인지)
// 을 두 번째 조건으로 함께 요구한다. DONE이 있는 VALID 라벨은(§C의 그
// 시나리오) 여전히 이 축에 닿지 않는다 -- 경계는 조금도 넓어지지 않는다.
function maybeResolveAbortRecordForValidLabel({
  labelInfo,
  doneAtMissing,
  role,
  harnessDir,
  resultText,
  receiptPath,
  args,
  env,
}) {
  if (labelInfo.kind !== "VALID" || !doneAtMissing) return { done: false };
  return resolveAbortRecordOutcome({
    role,
    harnessDir,
    resultText,
    receiptPath,
    admissionLedgerPath: resolveAdmissionLedgerPathForAbort(args, env),
  });
}

// evaluateConsumptionDecision 자신의 eslint complexity 상한을 지키려고
// 뽑았다(HYK-244-receipt-core-1b 선례와 동일한 이유, 판정/로그 문구는
// 조금도 바뀌지 않는다, 몸통만 쪼갠다) -- lookupDispatchId 호출 + 그
// 결과에 따른 조용한 통과 금지 로그 두 줄을 하나로 묶는다.
function lookupDispatchIdWithLogging({
  role,
  harnessTaskLabel,
  receiptPath,
  beforeMs,
}) {
  const lookup = lookupDispatchId({
    role,
    harnessTaskLabel,
    receiptPath,
    beforeMs,
  });
  if (!lookup.ok) {
    console.error(
      `dispatch-gate-decision consumption: dispatch_id 조회 실패(안 지어냄) -- ${lookup.reason}`,
    );
  } else if (!lookup.found) {
    console.error(
      `dispatch-gate-decision consumption: role=${role} label=${harnessTaskLabel}에 대응하는 배달 영수증을 못 찾음(정말 없음, 안 지어냄)`,
    );
  }
  return lookup;
}

// HYK-342 2R P1-2 (검토 원문 "옆문이 «한 겹 뒤로 물러난 것»에 그치지
// 않게"): 워크트리 밖(관제실) 배달 영수증(dispatch-receipts.jsonl)에 이
// role + 이 taskId 조합의 배달 기록이 남아 있는지 확인한다 -- 이 파일은
// 워크트리 안을 아무리 지워도 남는다(검토자 힌트 원문). lookupDispatchId
// 를 재사용한다(이미 이 파일이 abort-record/consumption 두 축 모두에서
// 쓰는 그 함수 그대로 -- 새 조회 로직을 발명하지 않는다). role 비교는
// 그 함수 자신이 이미 대소문자 무관으로 처리한다.
function hasDispatchReceiptForCurrentRound(role, taskId, receiptPath) {
  if (!isNonEmptyString(taskId) || !isNonEmptyString(receiptPath)) {
    return false;
  }
  const lookup = lookupDispatchId({
    role,
    harnessTaskLabel: taskId,
    receiptPath,
  });
  return lookup.ok && lookup.found;
}

// HYK-342 4R §1 (검토 3R 원문 "«항목이 없음»과 «확인 불가»가 같은
// hasReceipt=false로 접힌다"): 위 hasDispatchReceiptForCurrentRound는
// "이 taskId 항목이 있는가"만 답한다 -- 영수증 경로가 아예 없거나, 파일을
// 못 읽거나, 내용이 통째로 깨져 있어도 똑같이 false를 돌려준다(fail-open
// 결함의 근원). 이 함수는 그보다 «먼저» 묻는다: "이 영수증 로그를 애초에
// 신뢰할 수 있게 읽었는가?" -- isReservationActiveForRound(바로 아래,
// 원장 쪽)가 이미 쓰는 것과 같은 "판단 불가는 안전측으로 접는다" 모양을
// «발명하지 않고» 그대로 옮긴 것이다(§1 요구 "그 모양에 맞춰라").
//
// 닫힌 3-상태:
//   ⓐ `confirmed:false`(경로 미설정 · 읽기 실패 · 내용이 통째로 깨짐 --
//      비어 있지 않은 줄이 하나라도 있는데 단 한 줄도 JSON으로 파싱되지
//      않으면 "이 파일이 진짜 영수증 로그인지조차 확신할 수 없다"로
//      본다) -- 호출자는 이걸 REJECT로 접어야 한다(§1 표 #1·#3).
//   ⓑ `confirmed:true`(파일이 없거나 · 읽혔지만 비어 있거나 · 읽혔고
//      최소 한 줄이 유효한 JSON) -- 이 경우엔 hasDispatchReceiptForCurrentRound
//      의 "이 taskId 항목이 있는가" 질문이 안전하게 의미를 갖는다: 항목이
//      없으면 "이 로그를 확인했는데 정말 없다"(§1 표 #2·#4, 진짜 부트스트랩
//      -- 파일 부재도 여기 포함한다, 이유는 함수 헤더 아래 참조), 있으면
//      기존 3R 판정(§1 표 #5)으로 넘어간다.
//
// ⚠️파일 «부재»(ENOENT)를 ⓑ(확인됨)로 두는 이유(§1 표 #2, 판단은 위임됐지만
// 다른 네 경우와 모순되지 않아야 한다는 요구): 관제실 실제 배달 경로
// (dispatch-worker.ps1, 아래 fixture 실측 참조)는 `--dispatch-receipt-path`
// 를 항상 «구체적인 값»으로 넘긴다(env 우선, 없으면 자기 스크립트
// 디렉터리 밑 기본 파일) -- 그 기본 파일은 이 관제실 전체에서 단 한 번도
// 배달이 없었을 때만 부재한다(진짜 최초 부트스트랩, 전역 로그라 사실상
// 전무한 경우). 그런 극단적인 경우를 제외하면 파일이 «있는데 이
// taskId 항목만 없는» 것과 파일이 «아예 없는» 것은 둘 다 "이 taskId로는
// 배달된 적이 없다"는 같은 사실을 말한다 -- 그래서 부재도 파손과 달리
// ⓑ로 둔다(파손은 "로그 자체가 신뢰 불가"이지만 부재는 "로그가 아직
// 시작되지 않았다"이다, 서로 다른 사실).
function classifyReceiptReadability(receiptPath) {
  if (!isNonEmptyString(receiptPath)) {
    return { confirmed: false, reason: "UNSET" };
  }
  let raw;
  try {
    raw = readFileSync(receiptPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { confirmed: true, reason: "ABSENT" };
    return {
      confirmed: false,
      reason: `UNREADABLE(${err.code ?? err.message})`,
    };
  }
  const nonEmptyLines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (nonEmptyLines.length === 0) {
    return { confirmed: true, reason: "EMPTY" };
  }
  const anyLineParses = nonEmptyLines.some((line) => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
  if (!anyLineParses) {
    return { confirmed: false, reason: "CORRUPT" };
  }
  return { confirmed: true, reason: "READABLE" };
}

// HYK-342 3R §0/§3: verifyAbortRecordRecoveryMarker(위, 같은 파일)와 동일한
// 모양 -- admission 원장(워크트리 밖, 워커가 못 쓰는 파일)을 «읽기만»
// 해서 이 taskId의 예약이 지금 `ACTIVE`인지 본다. 읽을 수 없거나(경로
// 미설정·파일 없음·JSON 파싱 실패) 그 예약이 없거나 상태가 `ACTIVE`가
// 아니면 false(안전측 기본값 -- "판단 불가는 ACTIVE 아님으로 접는다").
function isReservationActiveForRound(ledgerPath, taskId) {
  if (!isNonEmptyString(ledgerPath) || !isNonEmptyString(taskId)) return false;
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  } catch {
    return false;
  }
  return ledger?.reservations?.[taskId]?.status === "ACTIVE";
}

// HYK-342 §4 요구6(1R) -> 2R P1-2 -> 3R §0/§3(신뢰 경계 교정 + 재시도
// 오탐 수리) -- evaluateConsumptionDecision 자신의 eslint complexity/line
// 상한을 지키려고 뽑았다(판정/문구는 조금도 바뀌지 않는다는 기존 관례를
// 이 라운드도 지킨다, 다만 이번엔 판정 «로직 자체»가 바뀐다 -- 이전 두
// 라운드의 "문구만 바뀐다" 전제와 다르다).
//
// ⛔3R §0 신뢰 경계 교정: 1R/2R이 썼던 `.harness/rounds/` 로컬 아카이브
// 대조는 이 함수에서 완전히 뺐다 -- 그 디렉터리는 워크트리 «안»이라
// 워커가 지우거나 조작할 수 있는 자리다(§0: "워커 워크트리 안의 파일은
// 전부 워커가 쓸 수 있다"). 증거로 쓸 수 있는 것은 워커가 못 쓰는 두
// 곳뿐이다: 배달 영수증(hasDispatchReceiptForCurrentRound) · admission
// 원장(isReservationActiveForRound).
//
// ⛔3R §3 재시도 오탐 수리: 2R까지는 "이 role+taskId로 배달된 적이
// 있다"(영수증 존재)만으로 곧장 REJECT했다 -- 그런데 검토자가 지적한
// 대로, 관제실의 실제 순서는 «게이트 허용 -> 영수증 기록 -> 좌석증명·go
// 전달»이라 **정당한 재시도**(영수증은 남았지만 뒤 단계가 실패해 워커가
// 아직 결과를 낸 적이 없는 경우)도 영수증만으로 REJECT됐다. 원장이 그
// 라운드를 아직 `ACTIVE`로 안다면(예약이 살아 있다면) 그건 «증거가
// 사라진 것»이 아니라 «아직 안 끝난(또는 재시도 중인) 것»이므로
// ALLOW해야 한다. 이제 판정은:
//   1. 영수증 없음 -> **ALLOW**(진짜 부트스트랩 -- 이 taskId로 배달된
//      기록 자체가 없다).
//   2. 영수증 있음 + 원장이 이 예약을 `ACTIVE`로 앎 -> **ALLOW**(정당한
//      재배달/재시도 -- 3R §3 요구 2 · 4. 과거 다른 라운드의 아카이브가
//      워크트리에 쌓여 있어도 무관하다, 그건 더 이상 이 판정에 관여하지
//      않는다).
//   3. 영수증 있음 + 원장이 ACTIVE로 모름(COMPLETED·예약 없음·원장
//      판독 불가) -> **REJECT**(증거 삭제 -- 3R §3 요구 3, fail-closed
//      기본값: 판단 불가도 여기 떨어진다).
// 반환: `{shortCircuit:true, result:<null 또는 REJECT 모양>}` 이면 즉시
// 그 result를 반환하라, `{shortCircuit:false}`면 결과 파일이 있으니 계속
// 진행하라는 뜻이다.
function resolveMissingResultFileOutcome(
  resultPath,
  role,
  taskId,
  receiptPath,
  admissionLedgerPath,
) {
  if (existsSync(resultPath)) return { shortCircuit: false };
  // HYK-342 4R §1: "확인 불가"부터 먼저 걸러낸다 -- 아래
  // hasDispatchReceiptForCurrentRound의 false는 이제부터 "확인했는데
  // 정말 없다"만 뜻한다(§0 신뢰 경계 -- 판단 불가를 부트스트랩으로
  // 접지 않는다).
  const receiptReadability = classifyReceiptReadability(receiptPath);
  if (!receiptReadability.confirmed) {
    return {
      shortCircuit: true,
      result: {
        state: DISPATCH_GATE_STATE.REJECT_RESULT_EVIDENCE_MISSING,
        allow: false,
        reason: `dispatch-gate-decision consumption: 직전 결과 파일(${resultPath})이 없는데 배달 영수증(dispatch-receipts.jsonl)을 확인할 수 없음(${receiptReadability.reason} -- 경로 미설정/읽기 실패/내용 파손 중 하나) -> "항목이 없음"과 "확인 불가"는 다르다, 확인 불가는 안전측으로 거부(HYK-342 4R §1). 조치: --dispatch-receipt-path/DISPATCH_RECEIPT_PATH가 실제 영수증 로그를 가리키는지 확인하라`,
      },
    };
  }
  const hasReceipt = hasDispatchReceiptForCurrentRound(
    role.toUpperCase(),
    taskId,
    receiptPath,
  );
  if (!hasReceipt) {
    return { shortCircuit: true, result: null }; // 진짜 부트스트랩(확인함, 정말 없다).
  }
  const reservationActive = isReservationActiveForRound(
    admissionLedgerPath,
    taskId,
  );
  if (reservationActive) {
    return { shortCircuit: true, result: null }; // 정당한 재배달/재시도.
  }
  return {
    shortCircuit: true,
    result: {
      state: DISPATCH_GATE_STATE.REJECT_RESULT_EVIDENCE_MISSING,
      allow: false,
      reason: `dispatch-gate-decision consumption: 직전 결과 파일(${resultPath})이 없지만 이 role+taskId(${taskId ?? "(미확정)"})가 실제로 배달됐다는 영수증이 있고, admission 원장은 이 예약을 ACTIVE로 알지 못함(reservationActive=false -- 판단 불가도 포함) -> 재시도 중인 라운드가 아니라 증거가 사라진 것으로 판단, 배달 거부(안전측 기본값, HYK-342 3R §3). 조치: 결과 파일이 실수로 삭제됐는지 확인하거나, 진짜 정지 종결이면 relay-handshake.mjs의 BLOCKED-termination 경로(중단 기록 작성)를 거치게 하라`,
    },
  };
}

// HYK-342 2R P1-2 (evaluateConsumptionDecision 자신의 eslint max-lines
// 상한을 지키려고 뽑았다, 판정/문구는 조금도 바뀌지 않는다): receiptPath와
// 이 게이트가 지금 보고 있는 taskPath 자신(직전 라운드의 own task_id --
// 아직 다음 라운드가 안 덮어썼다면 그 값, HYK-244 2R-b3 결함1 주석과 동일
// 전제)의 task_id를 뽑아 resolveMissingResultFileOutcome에 넘긴다.
// receiptPath도 함께 돌려줘서 호출자가 뒤에서 재사용할 수 있게 한다(중복
// resolveDispatchReceiptPath 호출을 피한다).
function resolveMissingResultFileGate(taskPath, role, resultPath, args, env) {
  const receiptPath = resolveDispatchReceiptPath(args, env);
  // HYK-342 3R §3: admission 원장 경로도 abort-record 축과 같은 인자/환경
  // 변수(resolveAdmissionLedgerPathForAbort, 이 파일에 이미 있는 그
  // 함수)로 받는다 -- 새 경로 해석을 발명하지 않는다.
  const admissionLedgerPath = resolveAdmissionLedgerPathForAbort(args, env);
  const currentTaskId = extractSoleMatch(
    readFileSync(taskPath, "utf8"),
    CONSUMPTION_TASK_ID_RE_G,
  );
  const missingResult = resolveMissingResultFileOutcome(
    resultPath,
    role,
    currentTaskId,
    receiptPath,
    admissionLedgerPath,
  );
  if (missingResult.shortCircuit) return { ...missingResult, receiptPath };
  return {
    shortCircuit: false,
    receiptPath,
    resultText: readFileSync(resultPath, "utf8"),
  };
}

// classifyTaskIdLabel + labelInfoToHarnessTaskLabel 한 자리 묶음
// (evaluateConsumptionDecision 자신의 eslint max-lines 상한을 지키려고
// 뽑았다, 판정/값은 조금도 바뀌지 않는다).
function classifyAndLabel(resultText) {
  const labelInfo = classifyTaskIdLabel(resultText);
  return {
    labelInfo,
    harnessTaskLabel: labelInfoToHarnessTaskLabel(labelInfo),
  };
}

// evaluateConsumptionDecision 자신의 eslint max-lines 상한을 지키려고
// 뽑았다(HYK-244-receipt-core-1b 선례와 동일한 이유, 판정/값은 조금도
// 바뀌지 않는다) -- HYK-244 2R-b3 결함3 수리: 파일명 관례상 role은
// 소문자("coder")지만, 실제 생산 경로(관제실이 대문자 $Role로 relay-
// handshake.mjs CLI를 직접 호출)가 만드는 영수증의 role은 대문자
// ("CODER")다(ORCH 실측 원문, coder-task.md §2 결함3). 1R 코어는 6성분을
// strict === 로 비교하므로 실제 생산 값의 대소문자에 맞춘다.
function buildCurrentBinding({
  harnessTaskLabel,
  role,
  resultText,
  lookup,
  droppedAt,
}) {
  return {
    taskId: harnessTaskLabel,
    role: role.toUpperCase(),
    droppedAt,
    resultFingerprint: computeConsumptionResultFingerprint(resultText),
    dispatchId: lookup.ok && lookup.found ? lookup.dispatchId : undefined,
    doneAt: extractSoleMatch(resultText, CONSUMPTION_DONE_RE_G),
  };
}

// ⛔"계약 아님" 축 -- findLatestReceiptMatch의 헤더("⛔⛔ HYK-394-test-leak-3
// §2 Q3"로 시작, dispatch-gate-decision.mjs 상단부) 참조, 완성은 HYK-396.
// HYK-394-dispatch-id-bind-2 §2 (P1): same extraction buildCurrentBinding
// uses for `doneAt` itself, converted to epoch ms for the dispatch_id
// lookup's `beforeMs` anchor. A missing/ambiguous DONE line yields
// undefined (no anchor) -- the lookup then behaves exactly as before this
// round (unanchored), which is the existing "can't confirm, don't guess"
// posture this file already uses everywhere else.
function resultDoneAtMs(resultText) {
  return (
    parseKstToMs(extractSoleMatch(resultText, CONSUMPTION_DONE_RE_G)) ??
    undefined
  );
}

// evaluateConsumptionDecision 자신의 eslint max-lines 상한을 지키려고
// 뽑았다(HYK-244-receipt-core-1b 선례와 동일한 이유, 판정/값은 조금도
// 바뀌지 않는다) -- HYK-394-dispatch-id-bind-2 §2 (P1)의 dispatch_id
// lookup·HYK-244 2R-b3 결함1의 droppedAt 아카이브 조회·HYK-396 §2의
// archivedRoundMeta.dispatchId 동시 추출·checkPredatesReceipts 면제
// 판정·candidates 조회까지, currentBinding을 완성하는 데 필요한 모든
// 단계를 한데 묶는다. `predatesReceipts: true`면 호출자가 즉시 ALLOW로
// 물러난다(사유는 checkPredatesReceipts 자신이 이미 stderr에 찍는다).
function buildConsumptionBindingContext({
  role,
  harnessTaskLabel,
  harnessDir,
  receiptPath,
  resultText,
}) {
  const lookup = lookupDispatchIdWithLogging({
    role,
    harnessTaskLabel,
    receiptPath,
    beforeMs: resultDoneAtMs(resultText),
  });

  // 결함1의 나머지 절반: droppedAt도 같은 이유로 taskText가 아니라 그
  // 직전 라운드가 자기 task 파일을 보존해 둔 아카이브 사본에서 온다.
  // HYK-396 §2: 같은 조회에서 그 사본 헤더의 dispatch_id(배달 시점 각인,
  // 부재/"unknown"이면 undefined)도 함께 뽑는다 -- 아래 decision===null
  // (기존 6성분 결속이 이미 일치) 분기 뒤에서만 참조하는 별도 축이다.
  //
  // HYK-396 §2(여는 축 Q2, ★3R 회귀 0 실측으로 확정된 자리): 이 1차
  // 조회는 ⛔의도적으로 옛 "가장 높은 번호 사본" 경로 그대로 둔다 --
  // resolvedDispatchId를 여기서 곧장 넘기면 hyk396-dispatch-stamp.test.mjs
  // (j)(ABSENT+낮은 사본이 원장과 «우연히» 일치하는 무해 사례, highest가
  // 이미 영수증과 정확히 일치)가 REJECT로 뒤집힌다는 것을 직접 실행해
  // 확인했다 -- highest가 이미 성공하는 사례까지 다른 사본으로 바꿔치기하면
  // 안 된다. 새 선택축은 대신 resolveConsumptionAllowOrFallthrough(아래)가
  // "highest 기준 1차 시도가 실패했을 때만" 재시도로 붙인다(tryArchiveFallback과
  // 동일한 "정상 경로 실패 시에만" 원칙) -- 그래서 여기 1차 조회는
  // resolvedDispatchId 없이 그대로 호출한다(회귀 0).
  const archivedRoundMeta = findArchivedRoundMeta(
    harnessDir,
    role,
    harnessTaskLabel,
  );
  const currentBinding = buildCurrentBinding({
    harnessTaskLabel,
    role,
    resultText,
    lookup,
    droppedAt: archivedRoundMeta.droppedAt,
  });
  if (checkPredatesReceipts(currentBinding)) {
    return { predatesReceipts: true };
  }
  return {
    predatesReceipts: false,
    currentBinding,
    archivedRoundMeta,
    candidates: readConsumptionCandidates(harnessDir, role, receiptPath),
  };
}

// evaluateConsumptionDecision 자신의 eslint max-lines 상한을 지키려고
// 뽑았다(HYK-244-receipt-core-1b 선례와 동일한 이유, 판정/값은 조금도
// 바뀌지 않는다) -- 정상 6성분 결속(toConsumptionGateDecision)과
// tryArchiveFallback, 두 개의 독립적인 ALLOW 생산 경로를 하나로 묶는다.
//
// HYK-394-dispatch-id-bind-2 §2 (P2 재도입 -> 재반려, 실행으로 확인):
// "가장 높은 번호 사본"만 보지 않고 같은 라벨의 사본 중 하나라도 결속
// 전체와 일치하면 소비로 인정하는 완화를, 이번엔 dispatch_id anchor
// 수리(findLatestReceiptMatch/lookupDispatchId/enrichCandidateDispatchId의
// `beforeMs`, 그대로 남아 있음)와 함께 다시 넣어 실제로 실행해 봤다
// (scripts/check/hyk394-dispatch-id-bind.test.mjs 시험 (b)). ★결과: 여전히
// 뚫린다 -- dispatchId anchor는 재드롭 자신의(더 나중) dispatch_id를
// 정확히 걸러내지만, "가장 높은 번호가 아닌" 트라이얼(=첫 드롭 자신의
// droppedAt)은 옛 영수증과 «진짜로» 결속 전체가 일치한다(재계산 버그가
// 아니라 resultText 자체가 아직 첫 드롭 라운드 그대로이고, 그 라운드는
// 실제로 소비됐다는 사실 그 자체). taskId/role/droppedAt/resultFingerprint/
// dispatchId/doneAt 그 어떤 성분도 "같은 라운드가 재보존된 것"과 "다른
// (아직 안 끝난) 라운드가 같은 라벨을 재사용한 것"을 구별하지 못한다 --
// 살아 있는 결과 파일이 그 자체로 바뀌지 않았기 때문이다. Q8 지시
// 원문("통과시키면 넣지 마라") 그대로 이 완화는 다시 반려한다 --
// findArchivedRoundMeta(가장 높은 번호 사본 하나만 대조, 아래 미변경)가
// 유일한 조회로 남는다(그 "가장 높은 번호만" 제약 자체가 fixture (b)를
// 막아 주는 것 -- droppedAt 자체가 불일치로 떨어진다).
//
// HYK-396 2R §2 P1-1 (검토 rejected 사유 재현 방지 -- ★비타협): 1R은
// dispatch_id veto를 정상 6성분 결속 경로(decision===null)에만 걸었다 --
// tryArchiveFallback이 독립적으로 ALLOW(true)를 낼 수 있는 두 번째
// 통로라는 것을 놓쳐, 검토자가 실증한 위조 표본(사본 각인 ctx_..._forged
// / 원장 실값 ctx_..._real)이 이 통로로 그대로 새 나갔다(status=0 ALLOW
// ARCHIVE_MATCH). fallback 자체는 그대로 둔다(§2 Q1 "fallback 자체를
// 없애지 마라, 축을 추가하는 것이다") -- 두 ALLOW 경로 모두 ALLOW를 내기
// 직전에 같은 veto를 통과시킬 뿐, toConsumptionGateDecision/
// tryArchiveFallback 내부 로직·판정 사유는 조금도 바뀌지 않는다.
// HYK-396 §2(여는 축 Q2) -- «그 배달 id로 각인된 사본»으로 다시 골라
// 한 번 더 시도한다. tryArchiveFallback(바로 위, resultFingerprint 축)과
// 정확히 같은 형태: 정상(highest 기준) 경로가 «이미 실패했을 때만»
// 시도하는 재시도이지, 대체하는 것이 아니다 -- highest 기준이 이미
// ALLOW인 사례(예: hyk396-dispatch-stamp.test.mjs (j))는 이 함수 자체가
// 호출되지 않으므로 조금도 바뀌지 않는다(회귀 0, buildConsumptionBindingContext
// 헤더 주석 참조).
//
// 켜지는 조건: (1) currentBinding.dispatchId가 이미 실값으로 확정돼
// 있고(빈 값이면 무엇과 대조할지조차 모른다 -- 시도 안 함), (2) 이
// 라벨의 dispatch-receipts.jsonl 이력이 정확히 실배달 1건뿐이다
// (countDistinctDispatchIdsForLabel 헤더 참조 -- 재드롭=실배달 2건
// 이상이면 이 축은 꺼진다, hyk394-dispatch-id-bind.test.mjs (b)의
// 안전장치를 다시 열지 않기 위함).
// 반환: null(재시도 자체를 안 했거나 재시도해도 여전히 불일치 -- 호출자는
// 원래 실패를 그대로 쓴다) | { currentBinding, archivedRoundMeta }(재시도
// 결속이 일치 -- 호출자는 이 값으로 다시 veto(resolveArchivedDispatchIdVeto)를
// 통과시킨다). ★dispatchIdKind가 VALUE든 AMBIGUOUS든 이 함수는 "결속 재시도가
// 성공했다"까지만 판단한다 -- ALLOW/REJECT 최종 판정은 항상 veto(및 그
// 안의 checkArchivedDispatchIdBinding 상태×경로 표)의 몫이다(다른 ALLOW
// 생산 경로 두 곳과 동일한 관례, resolveArchivedDispatchIdVeto 자신의 헤더
// 참조) -- AMBIGUOUS는 그 표에서 항상 거부이므로, 재시도가 "성공"해도
// 최종 결과는 여전히 REJECT다(ⓓ 경계값 표본이 바로 이 경로).
function tryDispatchIdArchiveSelection({
  role,
  currentBinding,
  candidates,
  harnessDir,
  harnessTaskLabel,
  receiptPath,
}) {
  if (!isNonEmptyString(currentBinding?.dispatchId)) return null;
  const dispatchIdCountForLabel = countDistinctDispatchIdsForLabel(
    receiptPath,
    role,
    harnessTaskLabel,
  );
  if (dispatchIdCountForLabel !== 1) return null;

  const altMeta = findArchivedRoundMeta(
    harnessDir,
    role,
    harnessTaskLabel,
    currentBinding.dispatchId,
  );
  if (
    altMeta.dispatchIdKind !== "VALUE" &&
    altMeta.dispatchIdKind !== "AMBIGUOUS"
  ) {
    return null; // 못 찾음 -- 지어내지 않는다, 원래 실패 유지.
  }
  if (altMeta.droppedAt === currentBinding.droppedAt) return null; // highest와 같은 사본 -- 재시도 무의미.

  const altBinding = { ...currentBinding, droppedAt: altMeta.droppedAt };
  const retryDecision = toConsumptionGateDecision({
    role,
    currentBinding: altBinding,
    candidates,
  });
  if (retryDecision !== null) return null; // 재시도해도 여전히 불일치 -- 원래 실패 유지.

  console.error(
    `dispatch-gate-decision consumption: DISPATCH_ID_ARCHIVE_SELECT(${altMeta.dispatchIdKind}) -- «가장 높은 번호 사본»(droppedAt=${currentBinding.droppedAt}) 대조는 실패했으나, 이 라운드 자신의 dispatch_id('${currentBinding.dispatchId}')로 각인된 다른 보존 사본(droppedAt=${altMeta.droppedAt})으로 재시도하니 결속이 일치 -> veto로 최종 판정을 넘김(HYK-396 여는 축 Q2)`,
  );
  return { currentBinding: altBinding, archivedRoundMeta: altMeta };
}

function resolveConsumptionAllowOrFallthrough({
  role,
  currentBinding,
  candidates,
  archivedRoundMeta,
  harnessDir,
  harnessTaskLabel,
  receiptPath,
}) {
  const decision = toConsumptionGateDecision({
    role,
    currentBinding,
    candidates,
  });
  if (decision === null) {
    return {
      done: true,
      result: resolveArchivedDispatchIdVeto(
        role,
        archivedRoundMeta,
        currentBinding,
        "normal",
      ),
    };
  }

  const idSelection = tryDispatchIdArchiveSelection({
    role,
    currentBinding,
    candidates,
    harnessDir,
    harnessTaskLabel,
    receiptPath,
  });
  if (idSelection) {
    return {
      done: true,
      result: resolveArchivedDispatchIdVeto(
        role,
        idSelection.archivedRoundMeta,
        idSelection.currentBinding,
        "normal",
      ),
    };
  }

  if (
    tryArchiveFallback({
      role,
      currentBinding,
      candidates,
      harnessDir,
      harnessTaskLabel,
    })
  ) {
    return {
      done: true,
      result: resolveArchivedDispatchIdVeto(
        role,
        archivedRoundMeta,
        currentBinding,
        "fallback",
      ),
    };
  }
  return { done: false, decision };
}

function evaluateConsumptionDecision(taskPath, args, env = process.env) {
  const role = deriveRoleFromTaskPath(taskPath);
  if (!role) return null;

  const harnessDir = dirname(taskPath);
  const resultPath = join(harnessDir, `${role}.md`);
  const missingResult = resolveMissingResultFileGate(
    taskPath,
    role,
    resultPath,
    args,
    env,
  );
  if (missingResult.shortCircuit) return missingResult.result;
  const { receiptPath, resultText } = missingResult;

  // HYK-244 2R-b3 결함1 수리: taskPath(`<role>-task.md`)는 게이트가 도는
  // 이 시점엔 이미 "다음에 보낼" 새 라운드로 덮여 있다 -- 라벨은 아직
  // 다음 라운드가 안 덮어쓴 resultText(직전 라운드 자신의 결과 파일)의
  // task_id 에코에서 뽑는다(taskText를 쓰지 않는다).
  // HYK-298-abort-record-2 §2-1: harnessTaskLabel(sole-match)만으로는
  // "없음"과 "깨짐"이 둘 다 undefined로 뭉개진다 -- labelInfo가 그 둘을
  // 먼저 구조적으로 가른다. VALID일 때만 harnessTaskLabel에 실제 값이
  // 들어간다(그 외에는 undefined, 아래 옛 경로들의 기존 계약과 동일한
  // "지어내지 않는다" 모양을 유지).
  const { labelInfo, harnessTaskLabel } = classifyAndLabel(resultText);
  // HYK-298-abort-record-1 §2 / 2R §2-1 -> HYK-298-label-classify-3 §2-3
  // -> HYK-298-key-narrow-4 §2(열쇠 좁히기)로 갱신: 이름표가 «진짜로
  // 없을 때»(kind === "MISSING")**만** 중단 기록(abort-record) 축을
  // 거친다 -- 그 축은 이제 BROKEN을 위한 문이 아니다(위
  // maybeResolveAbortRecordForMissingLabel 주석 원문). 정상적으로
  // 이름표가 있는(VALID) 결과 파일과 «있지만 깨진»(BROKEN) 결과 파일은
  // 둘 다 이 축 자체가 {done:false}로 물러나 곧장 아래 옛
  // consumption-receipt 경로(정상 소비 영수증 체인)로 내려간다 --
  // BROKEN에게 남은 유일한 통과 열쇠는 그 경로뿐이다(★한용 위임 판정
  // 문자 그대로). MISSING이 그 축에서 NO_RECORD(=이 라운드를 가리키는
  // 중단 기록이 아예 없음)로 물러나면 마찬가지로 옛 경로로 흘러
  // 내려간다(원래 REJECT 사유를 그대로 보존, 회귀 0). 그 외(ALLOW·
  // AMBIGUOUS·DISPATCH_ID_UNVERIFIED·RECOVERY_MARKER_MISSING)는 MISSING
  // 한정으로 이 축의 결과를 그대로 반환한다 -- 위조/불완전 중단 기록이
  // 옛 경로의 일반 사유 뒤에 숨지 않게 한다.
  const abortOutcome = maybeResolveAbortRecordForMissingLabel({
    labelInfo,
    role,
    harnessDir,
    resultText,
    receiptPath,
    args,
    env,
  });
  if (abortOutcome.done) return abortOutcome.result;

  const bindingContext = buildConsumptionBindingContext({
    role,
    harnessTaskLabel,
    harnessDir,
    receiptPath,
    resultText,
  });
  if (bindingContext.predatesReceipts) return null; // ALLOW -- 사유는 위에서 이미 찍었다.
  const { currentBinding, archivedRoundMeta, candidates } = bindingContext;

  const allowOutcome = resolveConsumptionAllowOrFallthrough({
    role,
    currentBinding,
    candidates,
    archivedRoundMeta,
    harnessDir,
    harnessTaskLabel,
    receiptPath,
  });
  if (allowOutcome.done) return allowOutcome.result;

  // HYK-311-retire-1 §2: 정상 소비 경로(영수증 체인 + 보관함 대조)가 이미
  // 실패로 확정된 뒤에만, VALID 이름표 라운드에 한해 은퇴 기록 축을
  // 시도한다 -- 정상 통로를 조금도 앞지르지 않는다(그 통로가 이미 위에서
  // 실패했을 때만 도달하는 위치).
  const retirementOutcome = maybeResolveRetirementForValidLabel({
    labelInfo,
    role,
    harnessDir,
    resultText,
    harnessTaskLabel,
    // HYK-398: DONE_PREDATES_DROPPED_AT 재확인에 필요한 droppedAt --
    // currentBinding은 이미 buildConsumptionBindingContext에서
    // archivedRoundMeta.droppedAt(직전 라운드가 보존한 task 파일 사본에서
    // 뽑은 원문)으로 채워져 있다(이 함수 위 buildCurrentBinding 참조).
    droppedAt: currentBinding.droppedAt,
    // HYK-478: AUTHOR_SEAT_LOST_BEFORE_STAMP 재확인에 필요한 admission
    // 원장 경로 -- abort-record 축(resolveAdmissionLedgerPathForAbort)이
    // 이미 쓰는 같은 arg-with-env-fallback 리졸버를 그대로 재사용한다
    // (새 CLI 플래그·새 env 축을 만들지 않는다).
    admissionLedgerPath: resolveAdmissionLedgerPathForAbort(args, env),
  });
  if (retirementOutcome.done) return retirementOutcome.result;

  // HYK-342/HYK-249 §3/§4 요구1: 정상 경로 + retirement 축이 전부 실패로
  // 확정된 뒤에만, VALID 라벨에 한해 중단 기록 축을 시도한다(정상 통로를
  // 앞지르지 않는다, retirement와 동일 위치 원칙 -- 자세한 근거는
  // maybeResolveAbortRecordForValidLabel 자신의 헤더 참조).
  const validAbortOutcome = maybeResolveAbortRecordForValidLabel({
    labelInfo,
    doneAtMissing: currentBinding.doneAt === undefined,
    role,
    harnessDir,
    resultText,
    receiptPath,
    args,
    env,
  });
  if (validAbortOutcome.done) return validAbortOutcome.result;

  return allowOutcome.decision;
}

// HYK-257-done-stamp-2 §2 범위2 ⓑ -- 실재 앵커에 붙는 기계 dropped_at
// 결선.
//
// 실재 앵커 인용(관제실 dispatch-worker.ps1, 읽기 전용 실측 원문 -- 이
// 저장소 밖, 절대 수정하지 않음):
//   166:  $roleTaskFile = Join-Path $Worktree (".harness/" + $Role.ToLower() + "-task.md")
//   165:  $gateScript = Join-Path $Worktree "scripts/check/dispatch-gate-decision.mjs"
//   171:  & node $gateScript $roleTaskFile --expect-repo-root $Worktree
// 즉 관제실은 배달 «직전» 항상 이 CLI를 그 라운드의 task 파일 경로로
// 부른다. 이 함수는 정확히 그 첫 인자(runDispatchGateDecision의 taskPath,
// 곧 $roleTaskFile) 위에서 동작한다 -- 관제실 파일은 단 한 줄도 바뀌지
// 않는다. 이 저장소 변경 하나만으로 모든 실제 배달에 기계 스탬프가 공짜로
// 결선된다(관제실측 결선 불필요).
//
// HYK-316-dropped-stamp-1: dropped_at: 줄이 «이미 있으면» 덮어쓰고,
// «아예 없으면»(수기 작성 지시서가 기계 스탬프를 우회한 모양-- 어제
// 08-20 HYK-328-review-1 · HYK-330-pm-guard-prefix-1 라이브 재현: 배달은
// 성공했는데 소비 핸드셰이크가 "task file missing dropped_at header"로
// 영구 거부됨) `task_id:` 줄이 있을 때만 그 바로 다음 줄로 새로
// 삽입한다(책임자 판정 2026-08-21: 「거부」가 아니라 「스탬프」로 우회
// 경로를 막는다). `task_id:` 줄조차 없으면(라운드 지시서 모양이 아님)
// 여전히 아무것도 만들지 않고 건너뛴다 -- 손기입 대체값 금지(1R 원칙
// 유지): stampDroppedAt()이 실패하면 기존 파일을 그대로 둔다(삽입이든
// 덮어쓰기든 뭔가를 지어내지 않는다). Best-effort: 절대 throw하지 않고,
// 이 CLI 자신의 exit code에 영향을 주지 않는다(relay-handshake.mjs의
// spawnAdmissionCompletion/autoWriteConsumptionReceipt와 동일한 house
// style -- 실패는 console.error로만 드러난다).
//
// HYK-479 §A (469 mask-3 실사고 수리): 이 함수 자신은 여전히 "성공하면
// 실제로 쓴다"이지만, 이제 그 호출 자리가 runDispatchGateDecision의
// 게이트 판정(combined.allow) «뒤», ALLOW일 때만이다(아래 호출부
// 자신의 주석 참조) -- REJECT로 끝날 라운드는 이 함수 자체가 아예
// 호출되지 않으므로 dropped_at을 포함해 task 파일 바이트가 조금도
// 바뀌지 않는다. Best-effort/원자성 계약(throw 없음·exit code 불변)은
// 이 함수 자신은 그대로 유지한다 -- 바뀐 것은 "언제 부르는가"뿐이다.
const DROPPED_AT_LINE_RE = /^dropped_at:\s*.+$/im;

// HYK-316-dropped-stamp-1: 삽입 지점 판정용 -- 첫 `task_id:` 줄(값 유무·
// 형식 무관, 존재 자체만) 바로 뒤에 dropped_at을 끼워 넣는다. 이 저장소·
// 관제실 지시서 전부가 `task_id:`를 첫 줄로 쓰는 순서이므로(coder-task.md
// 이번 라운드 §3-2 근거) 삽입 위치는 그 줄의 끝이다. 시험용 합성
// precondition-reject 픽스처(예: 중복 task_id, 형식오류 task_id)도 이
// 줄 자체는 갖고 있으므로 삽입 대상이 되는 것이 의도된 동작이다 --
// 「task_id: 줄 존재 여부」만이 이 경계의 유일한 판정 기준이며, 그 값의
// 유효성은 이 함수의 관심사가 아니다(그건 아래 이어지는
// checkGatePreconditions의 몫).
const TASK_ID_LINE_FOR_INSERT_RE = /^task_id:.*$/m;

// HYK-257-done-stamp-3 §2 범위2 -- «시험·검증이 실물 .harness/*-task.md를
// 만지지 못하게» fail-loud 경계.
//
// 반려 사유 원문(2R): "검토 시작 시 실제 .harness/review-task.md는
// dropped_at: 2026-08-17 12:41 KST였으나 검증 후 12:50 KST로 바뀌었다."
// -- 검증(시험·수동 확인)이 이 저장소 자신의 살아 있는 조율 파일을
// 건드렸다. 문서로 "조심하자"는 조치로 인정되지 않는다(책임자 확정) --
// 이 함수가 그 자리에서 실제로 거부한다.
//
// 판정: taskPath가 실물로 «판정»되는 조건 = ① taskPath가 실제 git
// 저장소 안에 있고(resolveRepoRoot(dirname(taskPath)).root !== null --
// 이 저장소의 기존 dispatch-gate-decision.test.mjs 다수 시험이 쓰는
// `git init -q <tmpdir>` 픽스처도 "실제 git 저장소"이므로 이 조건 하나만
// 으로는 부족하다), ② 그 저장소가 다름아닌 «이 dispatch-gate-decision.mjs
// 소스 파일 자신이 속한 저장소»(=HARNESSENGINEERING 계열, 이 코드가
// 실행되는 순간의 실제 워크트리 공유 .git)와 같고(정확히 이 조건이
// 위 git-init 픽스처들을 걸러낸다 -- 그 픽스처들은 전혀 다른, 무관한
// 1회용 저장소이므로 이 비교에서 자동으로 제외된다), ③ 배달 «직전»
// 실물 앵커(관제실 dispatch-worker.ps1:171)가 항상 넘기는
// `--expect-repo-root`가 «없거나» taskPath의 실제 저장소와 «다르다».
// 실제 배달은 ①②까지는 참이어도(같은 워크트리) ③에서 항상
// --expect-repo-root가 정확히 그 워크트리를 가리키므로(ps1 자신의
// 구성상 구조적으로 보장됨, $roleTaskFile과 $Worktree가 같은 변수에서
// 나온다) 거부되지 않는다 -- ⚠️정직 한계: --expect-repo-root를 정확히
// 그 워크트리로 «수동으로 맞춰» 재현한 호출은 이 판정으로는 실물
// 배달과 구별할 수 없다(그 시점에는 신호가 실제 배달과 동일해진다) --
// 이 판정이 잡는 것은 그 정도로 정교하게 실제 배달을 흉내내지 «않은»
// 시험·수동 호출이며, 실사고(review-task.md 4회 변경)가 정확히 이
// 모양이었다(단순 taskPath 직접 지정, --expect-repo-root 부재/불일치).
let cachedSelfRepoRoot;
function selfRepoRoot() {
  if (cachedSelfRepoRoot === undefined) {
    cachedSelfRepoRoot = resolveRepoRoot(
      dirname(fileURLToPath(new URL(import.meta.url))),
    ).root;
  }
  return cachedSelfRepoRoot;
}

export class LiveTaskPathStampRefusedError extends Error {}

function guardAgainstLiveTaskPathStamp(taskPath, args) {
  const self = selfRepoRoot();
  if (self === null) return; // this source file itself isn't in a git repo (unexpected, but not this guard's concern)
  const taskRepo = resolveRepoRoot(dirname(taskPath));
  if (taskRepo.root === null) return; // not a real repo path (e.g. plain tmpdir fixture) -- safe, matches existing tests
  if (
    normalizeRootForCompare(taskRepo.root) !== normalizeRootForCompare(self)
  ) {
    return; // a real git repo, but NOT this repo family (e.g. the throwaway `git init` fixtures in dispatch-gate-decision.test.mjs) -- unrelated, safe
  }
  // taskPath is inside THIS repo family's own worktree. Only proceed if
  // --expect-repo-root was given AND resolves to this exact same repo --
  // the one shape real production (dispatch-worker.ps1:171) always and
  // only produces.
  if (args.expectRepoRoot) {
    const expected = resolveRepoRoot(args.expectRepoRoot);
    if (
      expected.root !== null &&
      normalizeRootForCompare(expected.root) === normalizeRootForCompare(self)
    ) {
      return; // production-shaped: matches real dispatch exactly
    }
  }
  throw new LiveTaskPathStampRefusedError(
    `dispatch-gate-decision: REFUSING to run bestEffortStampDroppedAt against '${taskPath}' -- this path is judged to be a LIVE file inside this repo's own worktree (${self}), not an isolated test fixture, and this invocation did not carry a validated --expect-repo-root matching that same worktree (the one shape real production dispatch always provides, dispatch-worker.ps1:171). HYK-257-done-stamp-3 §2 범위2: test/verification runs must target an isolated fixture (e.g. mkdtempSync), never this repo's own .harness/*-task.md -- see this function's own header for the 2R incident this refuses.`,
  );
}

// HYK-307-order-1 §1 (실사고 재발 방지 -- §0 원문): ORCH가 소비(핸드셰이크)
// 전에 `<role>-task.md`를 다음 라운드로 덮어쓰면, 이제껏 그 라운드의
// 유일한 원본이던 그 파일 내용이 영구히 사라졌다 -- 소비가 성공할 때만
// 원문을 보존하는 envelope-archive.mjs의 archiveRoundTaskFile(관제실
// relay-handshake.mjs 쪽 호출, HYK-241)은 «소비가 아예 안 일어난» 이
// 사고 모양을 덮지 못했다(§0-4 원문: 소비 실패 -> 보관본도 없음).
//
// ★언제 스냅숏하면 "직전 라운드 원문"이 보장되는가(실측 근거): 이 함수
// (bestEffortStampDroppedAt)는 실물 앵커(관제실 dispatch-worker.ps1:171)가
// «배달 직전 항상» 부르는 이 CLI 안에서, dropped_at을 막 기계로 찍은
// 직후에 실행된다 -- 이 순간의 taskPath 내용은 "지금 배달하려는 바로 그
// 라운드"의 최종 원문(막 찍힌 dropped_at 포함)이다. 이 시점에 스냅숏해
// 두면, ORCH가 이 라운드의 소비를 하기 전에 다음 라운드로 taskPath를
// 덮어쓰더라도 -- 심지어 소비 핸드셰이크가 영영 안 일어나더라도 -- 이
// 라운드 원문은 이미 `.harness/rounds/<role>-task-r<N>.md`에 별도
// 파일로 살아남는다. 정상 소비가 나중에 일어나면(relay-handshake.mjs의
// archiveRoundTaskFile) 같은 내용을 다시 보존하려 시도하지만,
// archiveRoundTaskFileIfNew의 동일-내용 중복 방지(바로 위 import 주석)
// 덕에 두 번째 호출은 조용히 스킵되어 기존 흐름의 관찰 가능한 동작이
// 바뀌지 않는다(§3 시험 ⓓ).
//
// best-effort, 절대 throw하지 않고 이 CLI의 exit code에 영향을 주지
// 않는다 -- bestEffortStampDroppedAt 자신의 house style(주석 상단)과
// 동일. dropped_at: 줄이 아예 없는 파일(구조적 전제 미충족, 위 skip
// 분기)은 이 함수도 건드리지 않는다 -- 그 부재는 이 라운드가 다루는
// 실패 모드가 아니다(위 house style 그대로).
function bestEffortSnapshotRoundTaskFile(taskPath, taskContent) {
  const role = deriveRoleFromTaskPath(taskPath);
  if (!role) return;
  try {
    const outcome = archiveRoundTaskFileIfNew({
      role,
      taskContent,
      harnessDir: dirname(taskPath),
    });
    if (!outcome.ok) {
      console.error(
        `dispatch-gate-decision: round task-file snapshot skipped (${outcome.reason})`,
      );
    } else if (!outcome.skipped) {
      console.log(`dispatch-gate-decision: ${outcome.reason}`);
    }
  } catch (err) {
    console.error(
      `dispatch-gate-decision: round task-file snapshot failed (non-fatal, best-effort): ${err.message}`,
    );
  }
}

function bestEffortStampDroppedAt(taskPath, args) {
  guardAgainstLiveTaskPathStamp(taskPath, args);
  try {
    const original = readFileSync(taskPath, "utf8");
    if (!DROPPED_AT_LINE_RE.test(original)) {
      // HYK-316-dropped-stamp-1: no existing dropped_at: line. Previously
      // this was an unconditional skip (see git history for the old
      // comment); now it's a skip ONLY when the file also lacks a
      // `task_id:` line (not shaped like a round task file at all -- 손기입
      // 대체값 금지 원칙, 없는 걸 지어내지 않는다). When `task_id:` IS
      // present, fall through to the insertion branch below instead of
      // returning here.
      const taskIdLineMatch = original.match(TASK_ID_LINE_FOR_INSERT_RE);
      if (!taskIdLineMatch) {
        // HYK-257-done-stamp-2 §2 범위2 ⓑ (검토 실측 수리): this remains an
        // EXPECTED, common skip (fixtures with neither header at all), not
        // a failure -- must go to stdout (console.log), never stderr.
        // Printing it via console.error made this best-effort side-effect's
        // own diagnostic text silently become the FIRST line of this CLI's
        // stderr output for every existing precondition-reject fixture,
        // shadowing the actual gate/precondition reason text those
        // fixtures assert on (dispatch-gate-decision.test.mjs "P1-B all six
        // precondition-reject shapes produce MUTUALLY DISTINCT reason
        // strings" caught this: two fixtures sharing the same taskPath
        // collapsed to the same stderr first line). console.error stays
        // reserved for genuine failures below (stampDroppedAt itself
        // failing, or an unexpected exception).
        console.log(
          `dispatch-gate-decision: dropped_at stamp skipped (no existing 'dropped_at:' line AND no 'task_id:' line in ${taskPath} either -- not shaped like a round task file, this round does not invent either)`,
        );
        return;
      }
      const stampedForInsert = stampDroppedAt({});
      if (!stampedForInsert.ok) {
        console.error(
          `dispatch-gate-decision: dropped_at stamp insertion skipped (stampDroppedAt failed: ${stampedForInsert.reason}) -- leaving file untouched (손기입 대체값 금지 원칙 유지), existing gate/consumption checks fail closed on whatever was already there`,
        );
        return;
      }
      const insertAt = taskIdLineMatch.index + taskIdLineMatch[0].length;
      const inserted =
        original.slice(0, insertAt) +
        `\ndropped_at: ${stampedForInsert.value}` +
        original.slice(insertAt);
      writeFileSync(taskPath, inserted, "utf8");
      // HYK-316-dropped-stamp-1 §2: 「거부」가 아니라 「스탬프」로 구현하되
      // 조용히 고치지 말라는 책임자 판정 -- 삽입 사실이 배달 출력에
      // 분명히 드러나도록 stdout에 명시적으로 남긴다.
      console.log(
        `dispatch-gate-decision: dropped_at MISSING -- machine-inserted right after 'task_id:' (HYK-316-dropped-stamp-1: hand-authored task file bypassed the machine stamp) -- ${taskPath} -> 'dropped_at: ${stampedForInsert.value}'`,
      );
      bestEffortSnapshotRoundTaskFile(taskPath, inserted);
      return;
    }
    // HYK-479-486 (write-once 수리): dropped_at: 줄이 «이미 있으면» 다시
    // 찍지 않는다. 이전에는 여기서 매번 stampDroppedAt({})을 새로 불러
    // 현재 시각으로 덮어썼는데, 같은 ALLOW 라운드가 재게이트되면(예:
    // 관제실 재시도) "처음 실제로 떨어뜨린 시각"이 최신 재게이트 시각으로
    // 조용히 지워졌다 -- dropped_at의 존재 의의(감사용 최초 낙하 시각)와
    // 정면으로 어긋난다. 값이 이미 있다는 것 자체가 "이 라운드는 이미 한
    // 번 스탬프됐다"는 증거이므로, 그 값을 그대로 보존하고 아무것도
    // 쓰지 않는다(스탬프 로직은 여전히 '줄이 없을 때 삽입'하는 위
    // 분기에서만 stampDroppedAt을 호출한다).
    console.log(
      `dispatch-gate-decision: dropped_at already present -- write-once, leaving existing value untouched (HYK-479-486: 재게이트가 최초 낙하 시각을 덮어쓰지 않는다) -- ${taskPath}`,
    );
    // HYK-307-order-1 §1: 값은 안 바뀌었지만 이 내용이 "이 라운드의 최종
    // 원문"이라는 사실은 그대로이므로, 여전히 스냅숏할 가치가 있다
    // (idempotent -- archiveRoundTaskFileIfNew의 동일-내용 중복 방지,
    // 위 header comment 참조).
    bestEffortSnapshotRoundTaskFile(taskPath, original);
  } catch (err) {
    console.error(
      `dispatch-gate-decision: dropped_at stamp best-effort failed (non-fatal to this CLI's own exit code): ${err.message}`,
    );
  }
}

// HYK-465 (coder-task.md §A): 2026-09-10 P1 반려의 실제 원인 -- `.harness/`
// 는 git-ignore라 작성자 결과(`<role>.md`)·러너 영수증이 커밋 diff에
// 절대 나오지 않는데, 지시서 자체가 그 절대경로를 안 적었다. 검토자는
// "볼 수 있는 표면을 전수 조사하고 없다"고 정직하게 반려했다 -- 사람이
// 매번 손으로 그 경로를 기억해 적는 방식은 이미 실패로 증명됐다(그날
// 안 적혔다). ⇒ 이 가게이트가 배달 직전 항상 거치는 자리라는 점(HYK-217
// 앵커, dispatch-worker.ps1:256)을 이용해, bestEffortStampDroppedAt과
// 같은 best-effort/비파괴 스타일로 그 경로들을 task 파일에 기계로
// 박아 넣는다. 이미 박혀 있으면(RESULT_FILE_LINE_RE 매치) 다시 넣지
// 않는다(idempotent -- 재실행/재게이트에서 중복 삽입 없음).
//
// HYK-480 §1 (책임자 실측 재현): 옛 `/^result_file:\s*.+$/im`의 `\s*`가
// 개행을 삼켰다 -- 입력 "task_id: X\nresult_file:\nrunner_receipt_file:\n"
// 에서 이 정규식은 "result_file:\nrunner_receipt_file:"를 통째로 매치해
// «빈 키 + 다음 줄»을 «이미 주입됨»으로 잘못 읽었다(478 1R 게이트
// 스냅샷 실물 증거: 네 키가 빈 값으로 그대로 있었는데도 주입 시도 자체가
// 없었다). `[ \t]*`(수평 공백만) + `\S`(같은 줄 안에 실제 값이 있어야
// 함)로 좁힌다 -- 이 파일의 다른 header 정규식들(DISPATCH_HEAD_COMMIT_RE_G·
// CONSUMPTION_TASK_ID_RE_G)이 이미 쓰는 같은 관례, 개행 비포함.
// HYK-480 §3 ⓓ: exported ONLY so the mutation-regression test can compare
// this (fixed) regex's behavior against a literal copy of the pre-fix
// regex side-by-side on the SAME fixture text -- same "export for
// test-only comparison, zero logic change" convention this file already
// uses for classifyTaskIdLabel/DISPATCH_RECEIPT_LOOKUP_REASON (see that
// function's own header comment).
export const RESULT_FILE_LINE_RE = /^result_file:[ \t]*\S.*$/im;

const HARNESS_GITIGNORE_NOTE_TEXT =
  ".harness/ 는 git-ignore라 커밋 diff에 절대 안 나온다 -- 검토는 위 절대경로 파일을 직접 열어 확인하라(HYK-465 기계 주입, 손 기억 의존 금지).";
const WORKTREE_DISCIPLINE_TEXT =
  "작업/검토가 끝나면 DONE 을 찍기 «전»에 워크트리를 작업/검토한 커밋에 둔 채로 두라 -- 뒷정리로 HEAD 를 옮기면 소비가 막힌다(HYK-465 기계 주입).";

// HYK-480 §2-1 (책임자 실사고 근거, 오늘 이 라운드 자신의 §0-1): 기계
// 주입하는 점검표 문면 «자체»가 "계수 줄을 열 0에서 완료 표지 모양으로
// 시작하지 않는 서식"을 명시해야 한다 -- 이 문장이 그것이다.
const COUNT_LINE_FORMAT_HINT =
  "계수 줄은 열 0 에서 완료 표지 모양으로 시작하지 마라(예: '- 완료 표지 개수: 1', ⛔'>>> 완료 표지 개수: 1' 아님)";

// HYK-480 §5: "결과 파일 필수 머리줄 점검표" -- 지금까지 ORCH가 매 라운드
// task 파일 §0에 손으로 옮겨 적던 바로 그 표(이 라운드 자신의
// coder-task.md §0이 그 실물, 근거: 478 검토 1R -- head_commit 단독 줄
// 요구가 손 지시서에서 빠져 DONE_REWRITE_LOCKED 은퇴)를 이제 이 CLI가
// 기계로 박는다. ⛔각 줄은 "result_header_checklist_<field>:"로 시작한다
// (단일 key:value 줄 관례 유지) -- 그리고 필드 이름 뒤에 실제 헤더
// 콜론("role:"·"task_id:"·"for:"·"verdict:"·"head_commit:")을 다시
// 쓰지 않는다(Korean "필드"로 대체) -- 이 점검표 문면 자체가, 예를 들어
// REVIEW 역할에서 DISPATCH_HEAD_COMMIT_ANYWHERE_RE(근사매치 진단, 위 171행)
// 같은 이 파일 자신의 다른 축을 우연히 건드리지 않기 위함이다(점검표가
// 표지를 위조하면 안 된다는 §0-2/§2-1 요구 그대로).
// ⚠️실측으로 잡힌 함정(구현 중 발견, dispatch-gate-head-commit-wire.test.mjs
// 회귀로 드러남): 키 이름 자체를 "result_header_checklist_head_commit:"로
// 지었더니 그 문자열 안에 "head_commit:"가 «부분 문자열»로 그대로 들어있어
// DISPATCH_HEAD_COMMIT_ANYWHERE_RE(경계 없는 `/head_commit:\s*(\S+)/i`)가
// 그 키 이름 자체를 근사매치로 오인했다(REJECT_HEAD_COMMIT_MISSING이
// REJECT_HEAD_COMMIT_NEAR_MISS로 둔갑). ⇒ 아래 키는 "head_commit"을
// 밑줄 없는 "headcommit"으로 써서 그 부분 문자열 충돌 자체를 없앤다 --
// 값 텍스트(사람이 읽는 설명)는 여전히 "head_commit 필드"라고 쓰되, 뒤에
// 콜론을 붙이지 않는다(마찬가지로 충돌 없음, "head_commit " 뒤는 공백).
export function buildResultHeaderChecklistLines(role) {
  const upperRole = role.toUpperCase();
  const isReview = /^review/i.test(role);
  const reviewOnlySpec = (whenReview) =>
    isReview ? whenReview : "검토 전용 -- 이 역할엔 0개";
  return [
    `result_header_checklist_note: ⛔결과 파일 필수 머리줄 점검표(HYK-480 기계 주입, 손 기억 의존 금지 -- HYK-465 와 같은 판정선) -- ${COUNT_LINE_FORMAT_HINT}`,
    `result_header_checklist_role: role 필드는 '${upperRole}' 값으로 정확히 1개`,
    "result_header_checklist_task_id: task_id 필드는 이 라운드 harness_label 값으로 정확히 1개",
    `result_header_checklist_for: for 필드는 ${reviewOnlySpec("판정 대상 CODER 라운드 harness_label 값으로 정확히 1개")}`,
    `result_header_checklist_verdict: verdict 필드는 ${reviewOnlySpec("approved 또는 rejected 중 하나만, 정확히 1개")}`,
    // HYK-479 §B-B: 문면이 "정확히 1개"라고만 말하고 «같은 줄»을 요구
    // 하지 않아, 검토 결과 파일의 head_commit이 두 줄로(키 한 줄 + 40-hex
    // 다음 줄) 갈라져 소비 정규식(relay-handshake.mjs의 HEAD_COMMIT_RE_G,
    // `^head_commit:[ \t]*([0-9a-fA-F]{40})[ \t]*$`)에 매치되지 않은 실사고를
    // 닫는다 -- 값 텍스트에 "같은 줄" 요구와 예시 형태를 명시로 추가한다.
    // ⚠️예시 문구도 위 §5 함정(부분 문자열 충돌)을 다시 확인했다: "head_commit"
    // 뒤에 곧바로 콜론을 붙이지 않는다("다음에 콜론"으로 띄어 쓴다) --
    // 그래야 DISPATCH_HEAD_COMMIT_ANYWHERE_RE가 이 설명 문장 자체를
    // 근사매치로 오인하지 않는다(dispatch-gate-decision-hyk480-empty-key-
    // inject.test.mjs (f)가 이 축을 고정한다).
    `result_header_checklist_headcommit: head_commit 필드는 ${reviewOnlySpec("단독 40-hex 줄(HYK-383) 정확히 1개 -- 키와 값은 반드시 같은 줄(줄바꿈 금지), 예시 형태: head_commit 다음에 콜론 하나 붙이고 공백만 두고 같은 줄에 곧바로 40자리 16진수 값(콜론 다음에 개행하고 다음 줄에 값만 쓰면 두 줄로 갈라져 표지로 인정되지 않는다)")}`,
    `result_header_checklist_done: 완료 표지(>>> DONE 또는 node scripts/relay/finalize-done.mjs ${upperRole})는 정확히 1개 -- 손기입 금지`,
    // HYK-485 범위3: 전체 러너를 2회 이상 돌릴 때의 회차별 파일명 규약을
    // 같은 주입 블록에 못박는다(러너 영수증/로그 정본은 이 규약과
    // 별개로 그대로 둔다 -- RUNNER_RECEIPT_RUN_PREFIX·runner-receipt-writer.mjs
    // 가 이미 프로덕션에서 구현한 이름과 맞춘다). 키 이름은 이 파일
    // 자신의 비타협 3가지(head_commit·task_id·verdict·for를 부분
    // 문자열로도 넣지 않는다)를 지킨다.
    `result_header_checklist_runner_naming: 전체 러너를 2회 이상 돌릴 때 회차별 영수증은 runner-receipt-run<N>.json, 로그는 full-runner-<N>.log 로 남기고, 정본 runner-receipt.json 은 그대로 둔다`,
  ];
}

// HYK-480 §1: 옛 4키(result_file·runner_receipt_file·harness_gitignore_note·
// worktree_discipline)의 실제 값. 점검표(위)는 이 값들과 별개로 항상
// 새로 덧붙는 텍스트라 "빈 키"로 사전 존재할 수 없다(이 라운드에 처음
// 생겼으므로) -- 그래서 아래 두 헬퍼는 이 옛 4키만을 "빈 키일 수 있는"
// 대상으로 다룬다.
function computeLegacyInjectionValues(role, harnessDir) {
  return {
    result_file: join(harnessDir, `${role.toLowerCase()}.md`),
    runner_receipt_file: join(harnessDir, "runner-receipt.json"),
    harness_gitignore_note: HARNESS_GITIGNORE_NOTE_TEXT,
    worktree_discipline: WORKTREE_DISCIPLINE_TEXT,
  };
}

// HYK-480 §1 (범위 1): "빈 키가 있으면 그 자리의 빈 키 4줄을 채우거나
// (제자리 교체) ... 중복 키 금지". 각 옛 키가 "값 없이"(같은 줄에 결측)
// 이미 존재하면 그 줄을 제자리에서 값 있는 줄로 교체한다 -- 새 줄을
// 추가하지 않으므로 중복이 생길 수 없다.
//
// HYK-486 (검토 P2-2 가 값으로 재현한 실사고) 수리:
// 1) ⛔마스킹 누락 -- 코드펜스/HTML 주석으로 «인용된» 빈 키(예: 본문에
//    예시로 박힌 `result_file:`)도 "진짜 키"로 오인해 채웠었다. 이제
//    maskQuotedMarkerRegions(HYK-449, 정본)로 먼저 가린 텍스트에서
//    후보를 찾는다 -- 마스킹은 blankKeepingNewlines로 길이/오프셋을
//    보존하므로(reject-streak.mjs 주석), masked 텍스트에서 찾은 match
//    index를 원문(text) 치환에 그대로 재사용해도 안전하다.
// 2) ⛔`replace`에 `g` 플래그가 없어 맨 앞 하나만 치환했다(뒤에 있는
//    진짜 키가 영원히 빈 채로 건너뛰어짐). matchAll로 «모든» 후보를
//    센다.
// 3) ★진짜(마스킹 살아남은) 키가 2개 이상이면 -- 어느 것이 "그" 빈
//    키인지 기계가 결정할 근거가 없으므로 -- 조용히 하나만 고르지
//    않고 거부한다(reject-streak.mjs의 for:/verdict: 이중 표지를
//    판정 불가로 멈추는 원칙과 같다, HYK-183).
// 4) 치환은 문자열 slice로 직접 이어붙인다(정규식 `.replace(re, str)`을
//    전혀 쓰지 않음) -- 치환 값에 `$&`·`$1` 같은 특수 패턴이 들어 있어도
//    `.replace()`의 `$` 치환 해석 자체가 개입할 여지가 없다(비타협
//    "함수형 치환으로 막아라" 요구).
export function fillEmptyLegacyKeysInPlace(text, legacyValues) {
  const masked = maskQuotedMarkerRegions(text);
  const filledKeys = [];
  const replacements = [];
  for (const key of Object.keys(legacyValues)) {
    const emptyKeyRe = new RegExp(`^${key}:[ \\t]*$`, "gim");
    const matches = [...masked.matchAll(emptyKeyRe)];
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      throw new Error(
        `fillEmptyLegacyKeysInPlace: key '${key}' appears as a genuine (non-quoted) empty key ${matches.length} times -- refusing to silently pick one (HYK-486)`,
      );
    }
    filledKeys.push(key);
    replacements.push({
      index: matches[0].index,
      length: matches[0][0].length,
      key,
    });
  }
  // 뒤에서 앞으로 치환해야 앞선 치환이 뒤에 남은 치환의 인덱스를
  // 어긋나게 하지 않는다. filledKeys는 legacyValues 순서를 그대로
  // 유지한다(appendMissingLegacyKeysAndChecklist가 "마지막으로 채운
  // 키"를 legacyValues 순서 기준으로 찾으므로, 파일 내 물리적 위치
  // 순서와 섞으면 안 된다).
  const byIndexDesc = [...replacements].sort((a, b) => b.index - a.index);
  let rewritten = text;
  for (const { index, length, key } of byIndexDesc) {
    rewritten =
      rewritten.slice(0, index) +
      `${key}: ${legacyValues[key]}` +
      rewritten.slice(index + length);
  }
  return { rewritten, filledKeys };
}

// HYK-480 §1/§5: 빈 키 제자리 교체 뒤, (a) 아예 존재하지 않는 옛 키가
// 있으면(부분 템플릿) 그것도 채워 넣고, (b) 이 라운드가 처음 도입하는
// 점검표 7줄을 «같은 주입 블록»으로 그 바로 뒤에 덧붙인다(범위 5: 같은
// 주입 블록에 점검표를 박는다) -- 중복 키를 만들지 않도록 이미 (값이든
// 빈 키로든) 존재하는 옛 키는 다시 추가하지 않는다.
function appendMissingLegacyKeysAndChecklist(
  rewrittenAfterFill,
  filledKeys,
  legacyValues,
  checklistLines,
) {
  const legacyKeys = Object.keys(legacyValues);
  const missingKeys = legacyKeys.filter(
    (key) => !new RegExp(`^${key}:`, "im").test(rewrittenAfterFill),
  );
  const tailBlock = [
    ...missingKeys.map((key) => `${key}: ${legacyValues[key]}`),
    ...checklistLines,
  ]
    .map((line) => `\n${line}`)
    .join("");
  const lastFilledKey = filledKeys[filledKeys.length - 1];
  const lastFilledLineRe = new RegExp(`^${lastFilledKey}:.*$`, "im");
  const lastFilledMatch = rewrittenAfterFill.match(lastFilledLineRe);
  const insertAt = lastFilledMatch.index + lastFilledMatch[0].length;
  return (
    rewrittenAfterFill.slice(0, insertAt) +
    tailBlock +
    rewrittenAfterFill.slice(insertAt)
  );
}

function bestEffortInjectResultPaths(taskPath, args) {
  guardAgainstLiveTaskPathStamp(taskPath, args);
  const role = deriveRoleFromTaskPath(taskPath);
  if (!role) return;
  try {
    const original = readFileSync(taskPath, "utf8");
    const existingMatch = original.match(RESULT_FILE_LINE_RE);
    if (existingMatch) {
      // HYK-480 §2: 조용한 no-op 제거 -- 매치된 줄 자체를 로그에 남긴다
      // (task_id 부재 건너뛰기 로그와 같은 관례, §1 실사고의 "로그 없이
      // return"을 닫는다).
      console.log(
        `dispatch-gate-decision: result-path injection skipped (already injected -- matched line: '${existingMatch[0].trim()}') -- ${taskPath}`,
      );
      return;
    }
    const harnessDir = resolve(dirname(taskPath));
    const legacyValues = computeLegacyInjectionValues(role, harnessDir);
    const checklistLines = buildResultHeaderChecklistLines(role);

    const { rewritten: afterFill, filledKeys } = fillEmptyLegacyKeysInPlace(
      original,
      legacyValues,
    );
    if (filledKeys.length > 0) {
      const finalText = appendMissingLegacyKeysAndChecklist(
        afterFill,
        filledKeys,
        legacyValues,
        checklistLines,
      );
      writeFileSync(taskPath, finalText, "utf8");
      console.log(
        `dispatch-gate-decision: result-path block machine-injected (HYK-480, in-place fill of empty template keys: ${filledKeys.join(", ")}) -- ${taskPath} -> result_file=${legacyValues.result_file}, runner_receipt_file=${legacyValues.runner_receipt_file}`,
      );
      return;
    }

    const taskIdLineMatch = original.match(TASK_ID_LINE_FOR_INSERT_RE);
    if (!taskIdLineMatch) {
      console.log(
        `dispatch-gate-decision: result-path injection skipped (no 'task_id:' line in ${taskPath} -- not shaped like a round task file, this round does not invent one)`,
      );
      return;
    }
    // HYK-465 §A-3 (책임자 지시): 같은 주입 경로로 워크트리 이동 금지
    // 규율도 함께 박는다 -- 손 주입은 다음 라운드에서 사라진다.
    // HYK-480 §5: 옛 4줄 뒤에 결과 파일 필수 머리줄 점검표 7줄도 같은
    // 블록으로 덧붙인다.
    const block = [
      ...Object.entries(legacyValues).map(([key, value]) => `${key}: ${value}`),
      ...checklistLines,
    ]
      .map((line) => `\n${line}`)
      .join("");
    const insertAt = taskIdLineMatch.index + taskIdLineMatch[0].length;
    const inserted =
      original.slice(0, insertAt) + block + original.slice(insertAt);
    writeFileSync(taskPath, inserted, "utf8");
    console.log(
      `dispatch-gate-decision: result-path block machine-injected (HYK-465/HYK-480) -- ${taskPath} -> result_file=${legacyValues.result_file}, runner_receipt_file=${legacyValues.runner_receipt_file}`,
    );
  } catch (err) {
    console.error(
      `dispatch-gate-decision: result-path injection best-effort failed (non-fatal to this CLI's own exit code): ${err.message}`,
    );
  }
}

export function runDispatchGateDecision(argv) {
  const args = parseArgs(argv);
  const taskPath = args._[0];
  if (!taskPath) {
    return {
      allow: false,
      lines: [
        "dispatch-gate-decision: usage: node dispatch-gate-decision.mjs <task-path> [--ledger <path>] [--expect-repo-root <path>]",
      ],
    };
  }
  const decisions = [];
  if (!existsSync(taskPath)) {
    // Routed through the SAME decideFromGateExit the spawned gates use
    // (exitCode:1, matching reject-streak.mjs's own "task file not found"
    // exit-1 contract) rather than a bespoke early-return -- so this path
    // and the spawned-gate exit-1 path share one mutation point (coder-task
    // §4-2's RED reproduction covers both by covering the core function).
    decisions.push(
      decideFromGateExit({
        exitCode: 1,
        stdout: "",
        stderr: `task file not found: ${taskPath}`,
        label: "dispatch-gate-decision (task file check)",
      }),
    );
  } else {
    // HYK-257-done-stamp-2 §2 범위2 ⓑ: as early as possible once the file's
    // existence is confirmed, before any gate decision runs -- best-effort,
    // never blocks/changes what follows. HYK-479 §A: dropped_at stamping
    // itself is deliberately NOT run here any more (see the ALLOW-gated
    // call further below) -- only the result-path/checklist injection
    // stays unconditional, since it was never the thing 469 mask-3 broke.
    bestEffortInjectResultPaths(taskPath, args);
    const ledgerResolution = resolveLedgerPath(args, taskPath);
    const pathDecision = checkLedgerPathResolution(ledgerResolution);
    if (pathDecision) {
      // HYK-220 2R: mirrors the taskPath-not-found branch above -- a
      // failure to even IDENTIFY the ledger's repo short-circuits before
      // checkGatePreconditions/either gate subprocess is ever reached.
      decisions.push(pathDecision);
    } else {
      const { precondition, loaded, issueId } = evaluatePrecondition(
        taskPath,
        ledgerResolution.path,
      );
      if (precondition) {
        decisions.push(precondition);
      } else {
        decisions.push(...runGatesAgainstSnapshot(taskPath, loaded.ledger));
        decisions.push(
          evaluateChainDecision({
            chainPath: resolveChainPath(args, ledgerResolution.path),
            primaryLedger: loaded.ledger,
            issueId,
          }),
        );
        // HYK-241 §2 조각2: placed LAST (after both gates + chain), not
        // ahead of them like checkGatePreconditions/checkLedgerPathResolution
        // -- an earlier placement would short-circuit before the gates ever
        // run, which changes the "gates never spawned" assertions every
        // existing precondition-reject test in dispatch-gate-decision.test.mjs
        // already makes about task_id/ledger shapes. Running last means the
        // OUTCOME (delivery blocked) is identical either way when 1-B is
        // missing; only ALLOW-bound fixtures need a 1-B declaration added.
        // checkOneBPrecondition returns null on success -- nothing is pushed
        // then, same convention checkGatePreconditions/
        // checkLedgerPathResolution already follow (no positive confirmation
        // line, only the final combined ALLOW/REJECT line covers it).
        const oneBDecision = checkOneBPrecondition(
          extractOneBFacts(readFileSync(taskPath, "utf8")),
        );
        if (oneBDecision) decisions.push(oneBDecision);
        // HYK-383 2R §2: same placement reasoning as oneBDecision immediately
        // above -- last among the precondition axes, after gates+chain+1-B,
        // so this new axis's outcome never changes which existing
        // precondition-reject fixture short-circuits before which gate (only
        // ALLOW-bound REVIEW-role fixtures need a head_commit: line added).
        // extractHeadCommitFacts itself no-ops (isReviewRole:false) for every
        // non-REVIEW role, so CODER/VERIFY/PM delivery is untouched by
        // construction, not by a caller-side branch here.
        const headCommitDecision = checkHeadCommitPrecondition(
          extractHeadCommitFacts(taskPath, deriveRoleFromTaskPath(taskPath)),
        );
        if (headCommitDecision) decisions.push(headCommitDecision);
        // HYK-244-receipt-wire-2b2 §3-1: same placement reasoning as
        // oneBDecision immediately above -- last, after gates+chain+1-B,
        // so this new axis's outcome never changes which existing
        // precondition-reject fixture short-circuits before which gate.
        // Returns null when not applicable (no role derivable, or no
        // prior round's result file exists yet -- bootstrap) or when the
        // 1R core itself says PASS; only a genuine non-PASS verdict is
        // ever pushed.
        const consumptionDecision = evaluateConsumptionDecision(taskPath, args);
        if (consumptionDecision) decisions.push(consumptionDecision);
      }
    }
  }
  const combined = combineGateDecisions(decisions);

  // HYK-479 §A (469 mask-3 실사고 수리): dropped_at은 이제 「게이트가
  // ALLOW로 «판정한 뒤»에만」 찍는다. combined.allow는 taskPath가 실재할
  // 때만(위 else 분기) 여기 도달하므로 -- taskPath 부재 분기는 항상
  // decideFromGateExit({exitCode:1, ...})로 allow:false만 만든다 -- 이
  // 호출은 파일이 실재하는 ALLOW 라운드에서만 실행된다. REJECT 라운드는
  // task 파일 바이트를 그대로 둔다(거부하면 아무것도 바뀌지 않는다는
  // 게이트의 존재 이유 그대로). best-effort/원자성은
  // bestEffortStampDroppedAt 자신의 house style을 그대로 물려받는다
  // (throw하지 않고, 이 CLI의 exit code에 영향을 주지 않는다).
  if (combined.allow) {
    bestEffortStampDroppedAt(taskPath, args);
  }

  const lines = [...combined.reasons];
  lines.push(
    combined.allow
      ? "dispatch-gate-decision: ALLOW -- 두 게이트 모두 통과, 배달 진행"
      : "dispatch-gate-decision: REJECT -- 위 사유로 배달 거부, 원인 확인 후 재시도하라",
  );
  return { allow: combined.allow, lines };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/dispatch-gate-decision.mjs");
if (invokedDirectly) {
  const { allow, lines } = runDispatchGateDecision(process.argv.slice(2));
  for (const line of lines) {
    if (allow) console.log(line);
    else console.error(line);
  }
  process.exit(allow ? 0 : 1);
}
