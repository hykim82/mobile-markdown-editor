// HYK-218: reject-streak 원장(`.harness/reject-streak.json`)을 "추가
// 전용"으로 만드는 감시 계층.
//
// 핵심 통찰(이슈 본문 그대로): 원장을 지울 수 있는 주체는 사실상 ORCH
// 자신이다 -- 외부 공격이 아니라 "내가 나를 속이는" 시나리오다. 그래서
// 이 모듈은 삭제를 *막지* 않는다(정직 한계, §3 아래에 다시 명시: 이
// 코드와 완전히 같은 권한을 가진 주체는 원장과 이 모듈의 사이드카 파일을
// "함께" 다시 계산해 위조할 수 있다 -- 그건 원리적으로 막을 수 없다).
// 대신 "이 모듈을 거치지 않은 변경"이 구조적으로 드러나게 한다.
//
// ## 설계 -- 왜 기존 `reject-streak.json` 스키마를 그대로 두는가
//
// §2 비타협 제약: master의 게이트는 지금 이 순간에도 라이브 57이슈
// 원장을 그 스키마 그대로 읽고 있다. 이 라운드는 그 파일에 쓰기·삭제·
// 구조 변경을 절대 하지 않는다(§0). 그래서 해시 체인 필드를 기존
// history 엔트리에 追記하는 대신(그러면 원장 스키마 자체가 바뀐다),
// 완전히 별도의 사이드카 파일(`.harness/reject-streak-chain.json`)에
// "체크포인트"를 쌓는다 -- 원장은 100% 그대로, 사이드카가 "원장이 이
// 시점에 이런 모양이었다"를 기억하는 증인 역할을 한다.
//
// ## 왜 reject-streak.mjs를 import만 하고 절대 수정/재수출하지 않는가
//
// 실측(2026-08-12, 이 라운드 조사): `hyk183-ledger-fix-mutation.test.mjs`,
// `nc-codex-lane-future-block.test.mjs`, `review-gate-archive-safety.test.mjs`,
// `review-gate-unguarded-reads.test.mjs`, `hyk186-time-authority-mutation.test.mjs`,
// `envelope-archive-mutation.test.mjs`, `nc-reject-streak.test.mjs`,
// `nc-review-gate.test.mjs`, `relay-handshake.test.mjs` 9개 시험이
// `reject-streak.mjs`(+ 일부는 `relay-handshake.mjs`)를 격리된 임시
// 디렉터리로 그대로 복사해 독립 실행한다. 그 복사본은 이 파일
// (`reject-streak-chain.mjs`)을 함께 복사하지 않는다 -- 만약
// `reject-streak.mjs` 맨 위에 `import ... from "./reject-streak-chain.mjs"`
// 한 줄이라도 추가하면 저 9개 시험이 전부 MODULE_NOT_FOUND로 깨진다.
// 그래서 이 라운드는 `reject-streak.mjs`를 단 1바이트도 건드리지 않는다
// (읽기 전용 import만, 방향은 이 파일 -> reject-streak.mjs 한쪽뿐).
//
// ## 정직 한계 (§3, gap#98 과장 금지 선례) -- HYK-218 3R: 닫은 것 / 못 닫은 것
//
// ★**닫힌 것(3R, 한용 "다" ①)**: 2R까지는 `streak` 후퇴 검사가 사이드카가
// "기억한다고 주장하는" `lastCheckpoint.streak`를 그대로 믿었다. REVIEW
// 2R이 정확히 그 지점을 실증했다 -- 사이드카의 `streak`를 낮추고
// `CHECKPOINT_HASH_FIELDS`로 해시를 다시 계산하면 사이드카 자신은
// 내부적으로 여전히 정합(`verifyChainIntegrity` 통과)하므로, 그 값을
// 신뢰해 비교하던 검사가 PASS를 냈다. 3R은 그 신뢰를 끊었다:
// `checkAppendOnly`는 이제 `streak`를 사이드카에서 읽지 않고 **매번
// primary 원장의 `history`에서 직접 fold를 재계산**해 원장 자신의
// `streak` 필드와 대조한다(`foldStreakUpTo` 재사용, 아래 `checkAppendOnly`
// 참조) -- 사이드카가 무엇을 주장하든 이 비교에는 더 이상 관여하지 않는다.
//
// ★**여전히 못 닫은 것(3R, 한용 "다" ②, ⛔닫힌 것처럼 쓰지 않는다)**: 이
// 모듈과 완전히 동일한 파일-쓰기 권한을 가진 주체가 원장
// (`reject-streak.json`)과 사이드카(`reject-streak-chain.json`)를
// **"함께"** 새로 계산해 덮어쓰면(예: 원장 history에서 항목을 지우고,
// 그 지워진 상태에 맞춰 사이드카 체크포인트도 같이 다시 만들어 체인
// 해시를 처음부터 재계산) 이 체계는 여전히 뚫린다 -- 그 결과물은 3R이
// 새로 추가한 원장-자체-정합성 검사(streak == fold(history))도, 항목별
// 대조도, 사이드카 자체 해시 체인도 전부 통과한다. 해시 체인은
// 데이터베이스가 아니라 파일이고, 두 파일을 함께 쓸 수 있는 자는 둘을
// 함께 정합하게 다시 쓸 수 있다 -- 이건 구조적으로 막을 수 없다
// (`reject-streak-chain.test.mjs`의 "§3② 한계 고정" 시험이 이 입력이
// 지금도 PASS로 나온다는 사실 자체를 시험으로 박아 둔다. 이 시험이
// 실패하면 -- 즉 나중에 어떤 변경이 이걸 "닫았다"고 만들면 -- 이 주석과
// 그 시험 둘 다 갱신해야 한다).
//
// 이 설계가 실제로 잡는 것은(3R 이후에도, 그리고 3R이 새로 넓힌 부분)
// "한쪽만 건드리고 다른 쪽은 잊는" 실수다: 수기 JSON 편집, 부분 롤백
// 스크립트, 원장만 손대고 사이드카 존재를 모르는 도구, 그리고 이제
// **사이드카만 손대고 원장은 그대로 두는 도구까지** -- 실측상 사고의
// 대부분은 바로 이 형태다("공격"이 아니라 "무심코").
//
// ## 아직 없는 것 (§5-3 도달 경로 정직 신고)
//
// 이 라운드는 탐지 엔진 + 독립 CLI(checkpoint/verify)를 제공한다.
// `record`/`gate`/`diagnostic-gate` 3진입점이나 자동 기록 훅
// (`recordRejectStreakFromResultText`, relay-handshake.mjs/review-gate.mjs가
// 호출)에 이 체크를 자동으로 연결하는 배선은 **아직 없다** -- 그 배선은
// 위와 같은 이유로 reject-streak.mjs/relay-handshake.mjs/review-gate.mjs
// 자체를 건드려야 하고, 그 파일들도 각자 자기 자신을 복사하는 mutation
// 시험들의 대상이라 같은 위험이 반복된다. 이 라운드에서 그 배선까지
// 하기엔 위험 대비 검증 시간이 부족하다고 판단해, 배선은 REVIEW/다음
// 라운드가 "그 파일을 건드릴지 말지"를 독립적으로 판단하도록 남겨둔다.
// 지금은 사람(또는 자동화)이 `verify`/`verify-all`을 별도 단계로
// 호출해야 한다 -- "로그에 남는다"가 아니라 "아직 자동 호출 경로가
// 없다"고 정직하게 적는다.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadLedger } from "./reject-streak.mjs";

const GENESIS = "GENESIS";

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------

// HYK-218 2R (review fix, §1-3): single source of truth for which fields
// make up a checkpoint. The 2R regression this closes -- `at` silently
// excluded from checkAppendOnly's live-vs-checkpoint comparison while
// still being part of the hash -- was exactly two independently hardcoded
// field lists (one inside canonicalCheckpointFields, one inside the
// comparison loop) drifting apart. Fixing that ONE field is not enough on
// its own (§1-3 explicitly warns the same gap reopens the next time a
// field is added), so both call sites below now read off THESE arrays
// instead of hardcoding keys -- there is only one place left to edit, and
// reject-streak-chain.test.mjs asserts CHECKPOINT_HASH_FIELDS is built
// exactly by concatenating the other two (so a field literally cannot be
// added to the hash without a caller having decided which bucket it goes
// in).
//
// `streak` is deliberately NOT in LIVE_COMPARISON_FIELDS: a primary-ledger
// history ENTRY has no `streak` field of its own (only the ISSUE-level
// `ledger.issues[id].streak` does) -- there is no live per-entry value to
// compare `cp.streak` against, so it goes in DERIVED_ONLY_FIELDS instead.
// It is still hashed (so tampering with it alone, without recomputing the
// hash, is still caught by verifyChainIntegrity).
//
// HYK-218 3R update: the issue-level streak IS still cross-checked by a
// separate comparison further down in checkAppendOnly -- but as of 3R that
// comparison no longer reads `cp.streak`/`lastCheckpoint.streak` at all
// (2R's version did, and REVIEW reproduced a bypass through exactly that:
// lower the sidecar's `streak`, recompute its hash, and the stored numbers
// agree again). It now recomputes the fold DIRECTLY from the primary
// ledger's own history via `foldStreakUpTo` and compares that against the
// primary ledger's own `streak` field -- a check that no longer depends on
// anything the sidecar claims. Structural reason a per-entry `streak`
// mismatch in the loop above is still impossible once task_id/verdict/at
// all check out: `streak` is a pure fold over the verdict subsequence up
// to that index -- once every LIVE_COMPARISON_FIELDS entry matches at
// every checkpointed index, that subsequence is pinned, so the fold result
// cannot independently diverge. reject-streak-chain.test.mjs has a
// dedicated test exercising this claim (attempts to forge only `streak`
// alongside otherwise-matching task_id/verdict/at and confirms there is no
// live field left for such a forgery to hide in).
export const LIVE_COMPARISON_FIELDS = ["task_id", "verdict", "at"];
export const DERIVED_ONLY_FIELDS = ["streak"];
export const CHECKPOINT_HASH_FIELDS = [
  ...LIVE_COMPARISON_FIELDS,
  ...DERIVED_ONLY_FIELDS,
];

function canonicalCheckpointFields(entry) {
  // Stable field order -- built from CHECKPOINT_HASH_FIELDS, not a
  // hand-typed object literal (see the header comment above).
  const out = {};
  for (const field of CHECKPOINT_HASH_FIELDS) out[field] = entry[field] ?? null;
  return JSON.stringify(out);
}

export function chainHash(prevHash, entry) {
  return createHash("sha256")
    .update(String(prevHash ?? GENESIS))
    .update(canonicalCheckpointFields(entry))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// sidecar load/write (mirrors reject-streak.mjs's loadLedger/writeLedger
// UNJUDGABLE/fail-open convention -- same repo regulation, same shape)
// ---------------------------------------------------------------------------

function hasValidChainShape(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return false;
  return (
    typeof parsed.issues === "object" &&
    parsed.issues !== null &&
    !Array.isArray(parsed.issues)
  );
}

export function loadChainLedger(
  chainPath,
  { readFileFn = (p) => readFileSync(p, "utf8"), existsFn = existsSync } = {},
) {
  if (!existsFn(chainPath)) {
    return {
      ok: true,
      existed: false,
      chain: { schema_version: 1, issues: {} },
    };
  }
  let raw;
  try {
    raw = readFileFn(chainPath);
  } catch (err) {
    return {
      ok: false,
      reason: `reject-streak-chain: UNJUDGABLE -- failed to read chain sidecar '${chainPath}' (${err.message})`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `reject-streak-chain: UNJUDGABLE -- chain sidecar '${chainPath}' is not valid JSON (${err.message})`,
    };
  }
  if (!hasValidChainShape(parsed)) {
    return {
      ok: false,
      reason: `reject-streak-chain: UNJUDGABLE -- chain sidecar '${chainPath}' missing/invalid 'issues' object`,
    };
  }
  return { ok: true, existed: true, chain: parsed };
}

export function writeChainLedger(
  chainPath,
  chain,
  writeFileFn = writeFileSync,
) {
  writeFileFn(chainPath, JSON.stringify(chain, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// checkpoint construction (write side)
// ---------------------------------------------------------------------------

// Appends exactly one checkpoint entry for `issueId`, chaining off that
// issue's own last checkpoint (GENESIS if this is the first). Pure --
// caller decides whether/where to persist the result.
export function appendCheckpoint(
  chain,
  { issueId, taskId, verdict, at, streak },
) {
  const issues = { ...(chain?.issues ?? {}) };
  const prevEntries = issues[issueId]?.entries ?? [];
  const prevHash =
    prevEntries.length > 0 ? prevEntries[prevEntries.length - 1].hash : GENESIS;
  const index = prevEntries.length;
  const fields = { task_id: taskId, verdict, at, streak };
  const hash = chainHash(prevHash, fields);
  const stamped = { index, ...fields, prev_hash: prevHash, hash };
  issues[issueId] = { entries: [...prevEntries, stamped] };
  return { schema_version: chain?.schema_version ?? 1, issues };
}

function foldStreakUpTo(history, uptoIndexInclusive) {
  let streak = 0;
  for (let i = 0; i <= uptoIndexInclusive; i++) {
    streak = history[i]?.verdict === "rejected" ? streak + 1 : 0;
  }
  return streak;
}

// Idempotent "catch up": appends one checkpoint for every primary-ledger
// history entry of `issueId` that isn't checkpointed yet. Safe to call
// repeatedly -- a call with nothing new to checkpoint returns `chain`
// (structurally equal, same content) untouched. This is also how a
// pre-existing issue (one with history already in the live ledger before
// this feature existed) gets its FIRST checkpoints -- they establish a
// baseline from "now" forward; entries appended before this feature's
// adoption are covered retroactively at the moment `catchUpCheckpoints`
// first runs on them, same as any entry the primary ledger already has.
export function catchUpCheckpoints(primaryLedger, chain, issueId) {
  const history = primaryLedger?.issues?.[issueId]?.history ?? [];
  const already = chain?.issues?.[issueId]?.entries?.length ?? 0;
  let next = chain ?? { schema_version: 1, issues: {} };
  for (let i = already; i < history.length; i++) {
    const h = history[i];
    next = appendCheckpoint(next, {
      issueId,
      taskId: h.task_id,
      verdict: h.verdict,
      at: h.at,
      streak: foldStreakUpTo(history, i),
    });
  }
  return next;
}

// ---------------------------------------------------------------------------
// verification (read side)
// ---------------------------------------------------------------------------

// Checks the sidecar's OWN internal hash chain is self-consistent. This
// alone catches tampering INSIDE the sidecar file itself; it says nothing
// about whether the primary ledger still agrees with it (that's
// checkAppendOnly below).
export function verifyChainIntegrity(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: true, reason: "no checkpoint entries -- nothing to verify" };
  }
  let prevHash = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.index !== i || e.prev_hash !== prevHash) {
      return {
        ok: false,
        reason: `chain sidecar broken at entries[${i}]: index/prev_hash mismatch (expected index=${i}, prev_hash='${prevHash}')`,
      };
    }
    const expected = chainHash(prevHash, {
      task_id: e.task_id,
      verdict: e.verdict,
      at: e.at,
      streak: e.streak,
    });
    if (expected !== e.hash) {
      return {
        ok: false,
        reason: `chain sidecar broken at entries[${i}]: stored hash does not match recomputed hash`,
      };
    }
    prevHash = e.hash;
  }
  return {
    ok: true,
    reason: `chain sidecar verified through entries[${entries.length - 1}]`,
  };
}

// HYK-218 5R (pure extraction, quality-check complexity gate -- no behavior
// change): four small helpers pulled out of checkAppendOnly below so its
// own cyclomatic complexity stays under the repo's ESLint ceiling. Each
// helper does exactly what the inline code used to do, in the same order,
// with the same values -- checkAppendOnly's control flow, branch order,
// and every returned reason string are byte-identical to before this
// extraction.

function getCheckpointEntries(chain, issueId) {
  return chain?.issues?.[issueId]?.entries ?? [];
}

function getPrimaryHistory(primaryLedger, issueId) {
  return primaryLedger?.issues?.[issueId]?.history ?? [];
}

// §4ⓐ (항목 삭제 거부): returns the first checkpoint whose
// LIVE_COMPARISON_FIELDS no longer match the primary-ledger entry at that
// checkpoint's index (task_id/verdict/at changed, or the entry is gone),
// or null if every checkpoint still matches.
function findMismatchedCheckpoint(entries, primaryHistory) {
  for (const cp of entries) {
    const live = primaryHistory[cp.index];
    const fieldMismatch =
      !live ||
      LIVE_COMPARISON_FIELDS.some((field) => live[field] !== cp[field]);
    if (fieldMismatch) return cp;
  }
  return null;
}

// §4ⓑ (streak 후퇴 거부) -- HYK-218 3R (한용 "다" ①, review fix on 2R): DO
// NOT trust `cp.streak` / `lastCheckpoint.streak` here -- that value is
// whatever the SIDECAR recorded, and the 2R bypass REVIEW reproduced was
// exactly "lower the sidecar's `streak`, recompute its hash, and the two
// stored numbers agree again" (verifyChainIntegrity only proves the
// sidecar is internally self-consistent, never that it still reflects
// reality). The fix: derive the expected streak by recomputing the fold
// DIRECTLY from the primary ledger's OWN history -- a value that has no
// stored "streak" field anywhere to independently lie about, only
// verdicts, which are already field-by-field verified against the
// checkpoints (findMismatchedCheckpoint, above). This makes the check
// self-contained within the primary ledger and closes the "sidecar streak
// lowered + hash recomputed" path: an attacker touching ONLY the sidecar
// can no longer move this conclusion, because the sidecar's `streak` is
// no longer read at all for this comparison.
function checkStreakSelfConsistency(primaryLedger, primaryHistory, issueId) {
  const currentStreak = primaryLedger?.issues?.[issueId]?.streak ?? 0;
  const recomputedStreak = foldStreakUpTo(
    primaryHistory,
    primaryHistory.length - 1,
  );
  return {
    currentStreak,
    recomputedStreak,
    ok: currentStreak === recomputedStreak,
  };
}

// The real detector: cross-checks the PRIMARY ledger's history for
// `issueId` against what the sidecar checkpoint chain remembers.
//
// -- §4ⓒ (새 이슈 첫 배달 오탐 0): an issue with NO checkpoint entries yet
//    (never gone through the chained write path, including every issue on
//    the CURRENT live ledger before this feature existed) always PASSes --
//    there is nothing to compare against, so a brand-new issue's first
//    delivery is never blocked. This is a structural guarantee, not a
//    special case: findMismatchedCheckpoint simply has zero checkpoints to
//    fail on.
// -- §4ⓐ (항목 삭제 거부): a primary history SHORTER than the checkpoint
//    count, or whose entry at a checkpointed index no longer matches
//    (task_id/verdict/at changed), is BLOCKed (see findMismatchedCheckpoint).
// -- §4ⓑ (streak 후퇴 거부): see checkStreakSelfConsistency above.
// -- §4ⓓ (정상 진행 통과): a primary ledger that only ever grew past its
//    last checkpoint, in a way consistent with the fold rule (reject ->
//    +1, approve -> 0), PASSes.
export function checkAppendOnly({ primaryLedger, chain, issueId }) {
  const entries = getCheckpointEntries(chain, issueId);

  const sidecarIntegrity = verifyChainIntegrity(entries);
  if (!sidecarIntegrity.ok) {
    return {
      status: "BLOCK",
      ok: false,
      reason: `reject-streak append-only: ${issueId} -- ${sidecarIntegrity.reason}`,
    };
  }

  if (entries.length === 0) {
    return {
      status: "PASS",
      ok: true,
      reason: `reject-streak append-only: ${issueId} has no checkpoint history yet -- nothing to cross-check (first delivery, or issue predates this feature)`,
    };
  }

  const primaryHistory = getPrimaryHistory(primaryLedger, issueId);
  if (primaryHistory.length < entries.length) {
    return {
      status: "BLOCK",
      ok: false,
      reason: `reject-streak append-only: ${issueId} -- primary ledger history has ${primaryHistory.length} entries but checkpoint chain remembers ${entries.length}; history shrank (entry deletion suspected)`,
    };
  }

  const mismatchedCheckpoint = findMismatchedCheckpoint(
    entries,
    primaryHistory,
  );
  if (mismatchedCheckpoint) {
    return {
      status: "BLOCK",
      ok: false,
      reason: `reject-streak append-only: ${issueId} -- primary ledger history[${mismatchedCheckpoint.index}] no longer matches checkpoint (${LIVE_COMPARISON_FIELDS.join("/")} changed or entry replaced)`,
    };
  }

  const lastCheckpoint = entries[entries.length - 1];
  const streakCheck = checkStreakSelfConsistency(
    primaryLedger,
    primaryHistory,
    issueId,
  );
  if (!streakCheck.ok) {
    return {
      status: "BLOCK",
      ok: false,
      reason: `reject-streak append-only: ${issueId} -- streak field (${streakCheck.currentStreak}) does not match the fold recomputed directly from primary ledger history (${streakCheck.recomputedStreak}) -- streak regression suspected (recomputed from primary history, sidecar-reported streak is not trusted for this check)`,
    };
  }

  return {
    status: "PASS",
    ok: true,
    reason: `reject-streak append-only: ${issueId} -- primary ledger consistent with ${entries.length} checkpoint(s) through history[${lastCheckpoint.index}]`,
  };
}

export function checkAppendOnlyAll({ primaryLedger, chain }) {
  const issueIds = new Set([
    ...Object.keys(primaryLedger?.issues ?? {}),
    ...Object.keys(chain?.issues ?? {}),
  ]);
  const results = [...issueIds].sort().map((issueId) => ({
    issueId,
    ...checkAppendOnly({ primaryLedger, chain, issueId }),
  }));
  const violations = results.filter((r) => r.status === "BLOCK");
  return violations.length === 0
    ? {
        status: "PASS",
        ok: true,
        reason: `reject-streak append-only: all ${results.length} issue(s) verified clean`,
        results,
      }
    : {
        status: "BLOCK",
        ok: false,
        reason: `reject-streak append-only: ${violations.length}/${results.length} issue(s) failed verification`,
        results,
      };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ledger") out.ledger = args[++i];
    else if (args[i] === "--chain") out.chain = args[++i];
    else if (args[i] === "--issue") out.issue = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/reject-streak-chain.mjs");

if (invokedDirectly) {
  const root = repoRoot();
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const ledgerPath =
    args.ledger || join(root, ".harness", "reject-streak.json");
  const chainPath =
    args.chain || join(root, ".harness", "reject-streak-chain.json");

  if (sub === "checkpoint") {
    if (!args.issue) {
      console.error(
        "usage: node reject-streak-chain.mjs checkpoint --issue <HYK-nnn> [--ledger <path>] [--chain <path>]",
      );
      process.exit(1);
    }
    const loadedLedger = loadLedger(ledgerPath);
    if (!loadedLedger.ok) {
      console.log(
        loadedLedger.reason + " -- exit 0 (fail-open, chain untouched)",
      );
      process.exit(0);
    }
    const loadedChain = loadChainLedger(chainPath);
    if (!loadedChain.ok) {
      console.log(
        loadedChain.reason + " -- exit 0 (fail-open, chain untouched)",
      );
      process.exit(0);
    }
    const before = loadedChain.chain.issues?.[args.issue]?.entries?.length ?? 0;
    const nextChain = catchUpCheckpoints(
      loadedLedger.ledger,
      loadedChain.chain,
      args.issue,
    );
    const after = nextChain.issues?.[args.issue]?.entries?.length ?? 0;
    if (after === before) {
      console.log(
        `reject-streak-chain checkpoint: ${args.issue} already up to date (${before} checkpoint(s))`,
      );
      process.exit(0);
    }
    writeChainLedger(chainPath, nextChain);
    console.log(
      `reject-streak-chain checkpoint: ${args.issue} ${before} -> ${after} checkpoint(s)`,
    );
    process.exit(0);
  }

  if (sub === "verify") {
    if (!args.issue) {
      console.error(
        "usage: node reject-streak-chain.mjs verify --issue <HYK-nnn> [--ledger <path>] [--chain <path>]",
      );
      process.exit(1);
    }
    const loadedLedger = loadLedger(ledgerPath);
    if (!loadedLedger.ok) {
      console.log(loadedLedger.reason + " -- exit 0 (fail-open, UNJUDGABLE)");
      process.exit(0);
    }
    const loadedChain = loadChainLedger(chainPath);
    if (!loadedChain.ok) {
      console.log(loadedChain.reason + " -- exit 0 (fail-open, UNJUDGABLE)");
      process.exit(0);
    }
    const result = checkAppendOnly({
      primaryLedger: loadedLedger.ledger,
      chain: loadedChain.chain,
      issueId: args.issue,
    });
    if (result.status === "BLOCK") {
      console.error(result.reason);
      process.exit(2);
    }
    console.log(result.reason);
    process.exit(0);
  }

  if (sub === "verify-all") {
    const loadedLedger = loadLedger(ledgerPath);
    if (!loadedLedger.ok) {
      console.log(loadedLedger.reason + " -- exit 0 (fail-open, UNJUDGABLE)");
      process.exit(0);
    }
    const loadedChain = loadChainLedger(chainPath);
    if (!loadedChain.ok) {
      console.log(loadedChain.reason + " -- exit 0 (fail-open, UNJUDGABLE)");
      process.exit(0);
    }
    const result = checkAppendOnlyAll({
      primaryLedger: loadedLedger.ledger,
      chain: loadedChain.chain,
    });
    for (const r of result.results) {
      console.log(
        `  ${r.status === "PASS" ? "PASS" : "BLOCK"} ${r.issueId} -- ${r.reason}`,
      );
    }
    if (result.status === "BLOCK") {
      console.error(result.reason);
      process.exit(2);
    }
    console.log(result.reason);
    process.exit(0);
  }

  console.error(
    "usage: node reject-streak-chain.mjs checkpoint --issue <HYK-nnn> [--ledger <path>] [--chain <path>]",
  );
  console.error(
    "       node reject-streak-chain.mjs verify --issue <HYK-nnn> [--ledger <path>] [--chain <path>]",
  );
  console.error(
    "       node reject-streak-chain.mjs verify-all [--ledger <path>] [--chain <path>]",
  );
  process.exit(1);
}
