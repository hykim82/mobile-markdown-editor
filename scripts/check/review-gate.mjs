import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { recordRejectStreakFromResultText } from "./reject-streak.mjs";
import { mainRepoRoot } from "./relay-handshake.mjs";
import { archiveRoundEnvelope } from "./envelope-archive.mjs";
import { checkApprovalBinding } from "./review-approval-binding.mjs";

// HYK-183: 결과 파일에 이 표지가 2개 이상이면 어느 것이 최종인지 결정할 수
// 없으므로 조용히 하나를 고르지 않고 판정 불가로 멈춘다(2026-07-31 거짓
// 기록 사고). 과거 `/verdict:\s*approved/i.test(content)`는 존재 검사라
// 최신 판정이 rejected여도 옛 approved 줄이 남아 있으면 통과시켰다.
const VERDICT_LINE_RE_G = /^verdict:\s*(approved|rejected)\s*$/gim;
const HYK_TAG_RE_GLOBAL = /HYK-\d+/g;
// A standalone digit token (not part of a longer word like "2x" or "3rd") chained
// by a comma onto a preceding HYK-<digits> tag is an abbreviated enumeration.
const ABBREVIATED_ENUMERATION_RE = /HYK-\d+(?:\s*,\s*\d+(?![A-Za-z0-9]))+/g;

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

function extractSkipReview(message) {
  // 1) Strip code fences — docs/examples that describe the gate must not be
  //    mistaken for a skip directive.
  const withoutFences = message.replace(/```[\s\S]*?```/g, "");
  // 2) The trailer block is the last paragraph (block after the last blank-line split).
  const paragraphs = withoutFences.replace(/\s+$/, "").split(/\n[ \t]*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  // 3) Only a line-start `skip-review:` inside that trailer block counts.
  const m = last.match(/^[ \t]*skip-review:[ \t]*(.*)$/im);
  return m ? m[1].trim() : null; // null = not a skip directive
}

// Extracted from checkReviewGate (quality-check: keep checkReviewGate's own
// complexity under the repo's ESLint ceiling, same reason reject-streak.mjs
// extracts its own helpers) -- HYK-183: counts anchored `verdict:` lines and
// resolves whether the review is approved, or reports ambiguity when there
// is more than one.
function resolveVerdict(content) {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const verdictMatches = [...normalizedContent.matchAll(VERDICT_LINE_RE_G)];
  if (verdictMatches.length > 1) {
    return { ambiguous: true, count: verdictMatches.length };
  }
  return {
    ambiguous: false,
    approved:
      verdictMatches.length === 1 &&
      verdictMatches[0][1].toLowerCase() === "approved",
  };
}

function findAbbreviatedEnumerations(subject) {
  const groups = [];
  for (const match of subject.matchAll(ABBREVIATED_ENUMERATION_RE)) {
    const text = match[0];
    const leadId = text.match(/^HYK-\d+/)[0];
    const bareIds = [...text.matchAll(/,\s*(\d+)(?![A-Za-z0-9])/g)].map(
      (m) => `HYK-${m[1]}`,
    );
    groups.push([leadId, ...bareIds]);
  }
  return groups;
}

export function checkReviewGate({
  message,
  reviewPath = join(repoRoot(), ".harness", "review.md"),
}) {
  const subject = message.split(/\r?\n/, 1)[0] ?? "";

  const abbreviatedGroups = findAbbreviatedEnumerations(subject);
  if (abbreviatedGroups.length > 0) {
    const suggestion = abbreviatedGroups
      .map((ids) => ids.join(", "))
      .join("; ");
    return {
      ok: false,
      reason: `abbreviated issue list in subject; write each id fully: ${suggestion}`,
    };
  }

  const tagMatches = subject.match(HYK_TAG_RE_GLOBAL);
  if (!tagMatches) {
    return { ok: true, reason: "no HYK-<id> tag in message; not issue work" };
  }
  const issueIds = [...new Set(tagMatches)];

  const skipReason = extractSkipReview(message);
  if (skipReason !== null) {
    if (skipReason.length === 0) {
      return { ok: false, reason: "skip-review reason must not be empty" };
    }
    return { ok: true, reason: `skip-review audited: ${skipReason}` };
  }

  if (!existsSync(reviewPath)) {
    return { ok: false, reason: `review file not found: ${reviewPath}` };
  }
  // HYK-205: existsSync passing does not guarantee readFileSync succeeds
  // (TOCTOU race, EISDIR, permissions) -- this read is the gate's own
  // judgment of the evidence, not a side-effect record (contrast
  // recordApprovalToLedger/archiveApprovedRound below, which degrade to a
  // logged non-block). "gate couldn't read the evidence" is
  // indistinguishable from "there is no evidence" -- treating it as a pass
  // would be fail-open, which this repo has repeatedly treated as a defect
  // (HYK-183's ambiguous-verdict handling took the same stance). So this
  // blocks, same as the not-found branch just above, but through a
  // controlled return instead of letting the exception escape uncaught
  // into hooks/commit-msg's exit code.
  let content;
  try {
    content = readFileSync(reviewPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `review file unreadable: ${reviewPath} (${err.message}); the gate cannot verify approval and blocks -- fix or restore the file (e.g. re-run the review step), then retry the commit`,
    };
  }

  return evaluateReviewEvidence(content, issueIds, reviewPath);
}

// Extracted from checkReviewGate (quality-check: keep checkReviewGate's own
// complexity under the repo's ESLint ceiling, same reason resolveVerdict is
// extracted above) -- HYK-205: this extraction also made room for
// checkReviewGate's own read to be guarded (try/catch) without pushing the
// function back over the ceiling.
function evaluateReviewEvidence(content, issueIds, reviewPath) {
  const missingIds = issueIds.filter(
    (issueId) => !new RegExp(`for:\\s*${issueId}\\b`).test(content),
  );
  if (missingIds.length > 0) {
    return {
      ok: false,
      reason: `missing review evidence for ${missingIds.join(", ")} in ${reviewPath} (need "for: <id>" + approved verdict for each)`,
    };
  }

  const verdict = resolveVerdict(content);
  if (verdict.ambiguous) {
    return {
      ok: false,
      reason: `review verdict ambiguous for ${issueIds.join(", ")}: ${verdict.count}개 'verdict:' 줄이 있어 어느 것이 최종인지 결정할 수 없다 (${reviewPath})`,
    };
  }
  if (!verdict.approved) {
    return {
      ok: false,
      reason: `review not approved for ${issueIds.join(", ")} (need verdict: approved)`,
    };
  }
  const hasIndependentReviewer = /role:\s*REVIEW/i.test(content);
  if (!hasIndependentReviewer) {
    return {
      ok: false,
      reason: `self-certification blocked: review evidence for ${issueIds.join(", ")} lacks an independent reviewer (need role: REVIEW-*)`,
    };
  }
  return {
    ok: true,
    reason: `independent review evidence found for ${issueIds.join(", ")}`,
  };
}

// HYK-183-ledger-fix (축 B): checkReviewGate가 `ok:true`를 낸 이유가 진짜
// "for:/verdict: approved/role: REVIEW-* 증거를 확인했다"인지, 아니면
// "HYK 태그가 없다"/"skip-review"처럼 review.md를 아예 읽지 않은 조기
// 통과인지를 CLI 쪽에서 독립적으로 재판단한다(checkReviewGate 자체의
// 반환 모양은 손대지 않는다 -- 기존 20여 개 순수 함수 시험이 그 모양을
// 그대로 단언하므로, 회귀 없이 부작용만 CLI 블록에 얹는다). 뒤의 두
// 경로에서 review.md를 무조건 읽어 기록하면, 이 커밋과 무관한(다른
// 이슈의) 남은 review.md 내용을 이 커밋의 승인으로 잘못 붙일 수 있다.
function isGenuineReviewApproval(message, reviewPath) {
  const subject = message.split(/\r?\n/, 1)[0] ?? "";
  if (!subject.match(HYK_TAG_RE_GLOBAL)) return false;
  if (extractSkipReview(message) !== null) return false;
  return existsSync(reviewPath);
}

// HYK-183-ledger-fix (축 B): 승인이 커밋으로 이어지는 유일하게 «보장된»
// 관문(commit-msg 훅)에 원장 기록을 함께 건다. 기존 설계(37d68a1)는
// "반려 라운드는 커밋 자체가 없어 커밋 훅으로 못 본다"는 근거로 커밋 훅
// 결선을 통째로 기각했으나, 그 근거는 승인에는 적용되지 않는다 -- 승인은
// 반드시 커밋을 만들고, 이 훅은 그 커밋마다 반드시 실행된다.
// checkRelayHandshake 쪽 자동 기록(HYK-183 §2)은 ORCH가 "다음 라운드"를
// 위해 handshake를 다시 확인할 때 걸리는 부작용이라, 승인처럼 다음
// 라운드가 없는 종결 상태에서는 그 계기 자체가 생기지 않는다 -- 실측:
// 2026-08-05 오늘 승인 3건이 원장에 없다(§1 축 B). 이 훅은 반대로
// "커밋이 있으면 반드시 실행된다"를 보장하므로 승인 쪽의 정본 기록
// 지점으로 삼는다. `recordRejectStreakFromResultText`를 그대로 재사용해
// 판정/멱등성 로직을 재구현하지 않는다(role: "review"만 넘기면 축 A의
// done_at 포함 중복 판정까지 그대로 적용된다).
function recordApprovalToLedger(reviewPath) {
  // HYK-205: this re-read (checkReviewGate already read the same file
  // earlier in the same process) is a RECORD, not a judgment -- the commit
  // is already approved by the time this runs (isGenuineReviewApproval
  // gates the call). A TOCTOU race here (file removed/replaced between
  // checkReviewGate's read and this one) must degrade to "ledger not
  // updated, visibly logged", never "commit blocked" -- same contract
  // HYK-204 established for archiveApprovedRound just below.
  let reviewText;
  try {
    reviewText = readFileSync(reviewPath, "utf8");
  } catch (err) {
    console.error(
      `reject-streak: failed to record approval (re-read failed, commit NOT blocked: ${err.message})`,
    );
    return;
  }
  const ledgerPath = join(mainRepoRoot(), ".harness", "reject-streak.json");
  const outcome = recordRejectStreakFromResultText({
    role: "review",
    resultText: reviewText,
    ledgerPath,
  });
  if (!outcome.attempted) return;
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
}

// HYK-204: an APPROVED review round never triggers relay-handshake's own
// archive wiring (see recordApprovalToLedger's header just above -- an
// approval is a terminal state, so nothing ever re-checks that handshake
// for a "next round"). This commit-msg hook is the one choke point
// guaranteed to run on every approved commit, so it is also the archive
// site for the WINNING round's review.md -- otherwise exactly the round
// that decided the outcome would be the one round never preserved.
//
// HYK-204 2R (반려 수리): this function's OWN `readFileSync(reviewPath)` --
// not `archiveRoundEnvelope`'s internals, which already try/catch -- was
// the actual hole (REVIEW §A-2, real injection: deleting review.md right
// after entry produced `EXIT CODE: 1` from hooks/commit-msg, blocking an
// otherwise-approved commit). The whole function body is wrapped here
// (not just the read) so any failure on this path -- read or archive --
// degrades to a logged, visible failure instead of an uncaught throw
// escaping into the commit-msg hook's exit code. Preservation failing must
// never mean "commit blocked"; it must mean "commit succeeds, and the
// failure is on stderr for whoever's watching" (mirrors
// autoArchiveRoundEnvelope's own try/catch boundary in
// envelope-archive.mjs -- the CODER/rejected-REVIEW path already had this
// exact guarantee, this closes the gap on the APPROVED path).
// HYK-314: a rework round's commit often runs in a DIFFERENT `git worktree
// add` checkout than the one where REVIEW approved it -- `.harness/` is
// gitignored and lives on-disk per-worktree, so that worktree's own
// `.harness/review.md` never sees an approval that happened elsewhere. The
// worker's only escape used to be the `skip-review:` audit trailer on every
// such commit (ORCH 2026-08-20 실사고: banning that trailer in a task file
// left the worker unable to commit at all).
//
// Fix (direction ⓐ): mirror the SAME shared-anchor pattern
// recordApprovalToLedger/mainRepoRoot already use for reject-streak.json --
// on a GENUINE approval (isGenuineReviewApproval + binding already
// verified against the worktree that actually holds the reviewed bytes),
// cache a copy of the evidence (review text + binding-fingerprint block) at
// `mainRepoRoot()/.harness/approved-reviews/<issueId>.md`. `mainRepoRoot()`
// resolves via `git rev-parse --git-common-dir`, which is the ONE physical
// directory every linked worktree of this repo shares -- unlike a plain
// file copy into the next worktree (the "옆문" ORCH already rejected), nothing
// here bypasses the binding check: a rework-round commit that falls back to
// this cache still re-runs `checkApprovalBinding` against ITS OWN current
// worktree bytes (see resolveEffectiveReviewPath's caller below), so the
// fingerprint must still match byte-for-byte what REVIEW actually approved.
//
// ⛔정직 한계 (§2-3 self-cert 점검 결과): this cache is a plain file under a
// path any worktree of this repo can write to -- it is NOT cryptographically
// tied to "a real REVIEW round wrote it." That is the SAME trust level
// `.harness/review.md` itself already has today (evaluateReviewEvidence's
// `hasIndependentReviewer` check is a text convention -- `/role:\s*REVIEW/i`
// -- not a signature). This change does not weaken that baseline: a worker
// who could forge a local review.md today (self-cert) could equally forge
// this shared cache file; no NEW bypass opens, and the SAME two guards
// (role: REVIEW text + fingerprint match against current worktree bytes)
// still gate every consumption of it, local or shared.
const APPROVED_EVIDENCE_SUBDIR = join(".harness", "approved-reviews");

function sharedApprovedEvidencePath(issueId) {
  return join(mainRepoRoot(), APPROVED_EVIDENCE_SUBDIR, `${issueId}.md`);
}

// Resolves which review.md-shaped file checkReviewGate should read: the
// local per-worktree file if it exists (unchanged default), otherwise -- for
// the common single-issue commit case only -- the shared cache for that one
// issue if the commit's own binding check will still be able to verify it.
// Multi-issue commits (rare; HYK-315's abbreviated-enumeration guard already
// discourages them) are NOT resolved through the shared cache: the cache's
// evaluateReviewEvidence pass would need every id's own `verdict:` line in
// one blob, and resolveVerdict's ambiguous-count check would then reject
// TWO genuinely-approved ids as "모호" -- a false block, not a silent pass,
// but out of scope for this fix. Those still need `skip-review:` (unchanged,
// pre-existing behavior).
function resolveEffectiveReviewPath(message, localReviewPath) {
  if (existsSync(localReviewPath)) return localReviewPath;
  const subject = message.split(/\r?\n/, 1)[0] ?? "";
  const tagMatches = subject.match(HYK_TAG_RE_GLOBAL);
  if (!tagMatches) return localReviewPath;
  const issueIds = [...new Set(tagMatches)];
  if (issueIds.length !== 1) return localReviewPath;
  const sharedPath = sharedApprovedEvidencePath(issueIds[0]);
  return existsSync(sharedPath) ? sharedPath : localReviewPath;
}

// Writes the shared cache entry above. Only called for a GENUINE, binding-
// verified local approval (never for a commit that itself consumed the
// cache -- see the CLI block's `reviewPath === defaultReviewPath` guard --
// so this never re-derives a cache entry from a cache entry). Mirrors
// archiveApprovedRound's own never-throws contract: a caching failure must
// not block an otherwise-approved commit.
function cacheApprovedEvidenceShared(reviewPath, message) {
  const subject = message.split(/\r?\n/, 1)[0] ?? "";
  const tagMatches = subject.match(HYK_TAG_RE_GLOBAL);
  if (!tagMatches) return;
  const issueIds = [...new Set(tagMatches)];
  try {
    const reviewText = readFileSync(reviewPath, "utf8");
    const sidecarPath = join(dirname(reviewPath), "review-approval-binding.md");
    const bindingBlock = existsSync(sidecarPath)
      ? readFileSync(sidecarPath, "utf8")
      : "";
    const combined = `${reviewText.replace(/\s+$/, "")}\n\n${bindingBlock}`;
    const dir = join(mainRepoRoot(), APPROVED_EVIDENCE_SUBDIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (const issueId of issueIds) {
      writeFileSync(sharedApprovedEvidencePath(issueId), combined, "utf8");
    }
    console.log(
      `shared-evidence-cache: cached approval for ${issueIds.join(", ")} -> ${dir}`,
    );
  } catch (err) {
    console.error(
      `shared-evidence-cache: failed to cache approval for cross-worktree rework (commit NOT blocked: ${err.message})`,
    );
  }
}

function archiveApprovedRound(reviewPath) {
  try {
    const reviewText = readFileSync(reviewPath, "utf8");
    const outcome = archiveRoundEnvelope({
      role: "review",
      resultContent: reviewText,
      harnessDir: dirname(reviewPath),
    });
    if (outcome.ok) {
      console.log(outcome.reason);
    } else {
      console.error(outcome.reason);
    }
  } catch (err) {
    console.error(
      `envelope-archive: failed to preserve review round (approval re-read failed, commit NOT blocked: ${err.message})`,
    );
  }
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/review-gate.mjs");
if (invokedDirectly) {
  const commitMsgFile = process.argv[2];
  if (!commitMsgFile) {
    console.error("usage: node review-gate.mjs <commit-msg-file>");
    process.exit(1);
  }
  const message = readFileSync(commitMsgFile, "utf8");
  const defaultReviewPath = join(repoRoot(), ".harness", "review.md");
  // HYK-314: falls back to the shared cross-worktree evidence cache only
  // when the local review.md is absent (see resolveEffectiveReviewPath's
  // own header for the single-issue scope limit).
  const reviewPath = resolveEffectiveReviewPath(message, defaultReviewPath);
  const result = checkReviewGate({ message, reviewPath });
  if (result.ok) {
    if (isGenuineReviewApproval(message, reviewPath)) {
      // HYK-240: checkReviewGate above only confirms "for:/verdict:
      // approved/role: REVIEW" evidence exists -- it never checked THAT
      // approval was for the code state actually about to be committed.
      // This binding check closes that gap: fail-closed (missing binding,
      // unmeasurable worktree, or a fingerprint mismatch all block), kept
      // as a separate call rather than folded into checkReviewGate so that
      // function's own pure-function contract (and the ~20 existing tests
      // asserting its return shape) stay untouched.
      //
      // HYK-314: this check ALWAYS re-runs here, even when `reviewPath` came
      // from the shared cache -- the fingerprint inside that cached evidence
      // must still match THIS worktree's current bytes byte-for-byte. A
      // rework round that diverges from what REVIEW actually approved still
      // fails closed ("불일치"), exactly like the local-file path always has.
      const binding = checkApprovalBinding({ reviewPath, cwd: repoRoot() });
      if (!binding.ok) {
        console.error(binding.reason);
        process.exit(1);
      }
      // Only a GENUINE local approval gets recorded/archived/cached -- a
      // commit that merely CONSUMED the shared cache (reviewPath !==
      // defaultReviewPath) is not itself a review round conclusion, so it
      // must not re-record the streak ledger, re-archive a round envelope,
      // or overwrite the cache with a copy of itself.
      if (reviewPath === defaultReviewPath) {
        recordApprovalToLedger(reviewPath);
        archiveApprovedRound(reviewPath);
        cacheApprovedEvidenceShared(reviewPath, message);
      }
    }
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
