// HYK-218: 반려 원장 추가-전용(append-only) 감시 계층 시험. ⛔ 실제
// `.harness/reject-streak.json`은 절대 건드리지 않는다 -- 모든 시험은
// mkdtemp 합성 원장/사이드카로만 돈다 (§0 비타협).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  chainHash,
  appendCheckpoint,
  catchUpCheckpoints,
  verifyChainIntegrity,
  checkAppendOnly,
  checkAppendOnlyAll,
  LIVE_COMPARISON_FIELDS,
  DERIVED_ONLY_FIELDS,
  CHECKPOINT_HASH_FIELDS,
} from "./reject-streak-chain.mjs";
import { applyOutcome, loadLedger } from "./reject-streak.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./reject-streak-chain.mjs", import.meta.url),
);
const DEFECT_SAMPLE_PATH = fileURLToPath(
  new URL("./reject-streak-defect-sample.json", import.meta.url),
);

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "reject-streak-chain-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withFixtureDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), "reject-streak-chain-test-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
      ...opts,
    });
    return { status: 0, stdout };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// A synthetic primary ledger built the same way reject-streak.mjs's own
// applyOutcome would build it -- rejected/rejected/approved on one issue.
function buildLedger(sequence) {
  let ledger = { schema_version: 1, issues: {} };
  let t = 0;
  for (const [issueId, verdict] of sequence) {
    t++;
    ledger = applyOutcome(ledger, {
      issueId,
      taskId: `${issueId}-round-${t}`,
      verdict,
      at: `t${t}`,
    });
  }
  return ledger;
}

// ---------------------------------------------------------------------------
// chainHash / appendCheckpoint / verifyChainIntegrity
// ---------------------------------------------------------------------------

test("(1) chainHash: deterministic for identical inputs", () => {
  const a = chainHash("GENESIS", {
    task_id: "x",
    verdict: "rejected",
    at: "t1",
    streak: 1,
  });
  const b = chainHash("GENESIS", {
    task_id: "x",
    verdict: "rejected",
    at: "t1",
    streak: 1,
  });
  assert.equal(a, b);
});

test("(2) chainHash: differs when any field changes", () => {
  const base = chainHash("GENESIS", {
    task_id: "x",
    verdict: "rejected",
    at: "t1",
    streak: 1,
  });
  const diffVerdict = chainHash("GENESIS", {
    task_id: "x",
    verdict: "approved",
    at: "t1",
    streak: 1,
  });
  const diffStreak = chainHash("GENESIS", {
    task_id: "x",
    verdict: "rejected",
    at: "t1",
    streak: 2,
  });
  assert.notEqual(base, diffVerdict);
  assert.notEqual(base, diffStreak);
});

test("(3) appendCheckpoint: chains off the previous entry's own hash", () => {
  let chain = { schema_version: 1, issues: {} };
  chain = appendCheckpoint(chain, {
    issueId: "HYK-1",
    taskId: "HYK-1-a",
    verdict: "rejected",
    at: "t1",
    streak: 1,
  });
  chain = appendCheckpoint(chain, {
    issueId: "HYK-1",
    taskId: "HYK-1-b",
    verdict: "rejected",
    at: "t2",
    streak: 2,
  });
  const entries = chain.issues["HYK-1"].entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].index, 0);
  assert.equal(entries[0].prev_hash, "GENESIS");
  assert.equal(entries[1].index, 1);
  assert.equal(entries[1].prev_hash, entries[0].hash);
});

test("(4) verifyChainIntegrity: clean chain -> ok", () => {
  let chain = { schema_version: 1, issues: {} };
  chain = appendCheckpoint(chain, {
    issueId: "HYK-1",
    taskId: "a",
    verdict: "rejected",
    at: "t1",
    streak: 1,
  });
  chain = appendCheckpoint(chain, {
    issueId: "HYK-1",
    taskId: "b",
    verdict: "rejected",
    at: "t2",
    streak: 2,
  });
  const result = verifyChainIntegrity(chain.issues["HYK-1"].entries);
  assert.equal(result.ok, true);
});

test("(5) verifyChainIntegrity: tampered stored hash -> not ok", () => {
  let chain = { schema_version: 1, issues: {} };
  chain = appendCheckpoint(chain, {
    issueId: "HYK-1",
    taskId: "a",
    verdict: "rejected",
    at: "t1",
    streak: 1,
  });
  const entries = chain.issues["HYK-1"].entries;
  entries[0].hash = "forged" + entries[0].hash.slice(6);
  const result = verifyChainIntegrity(entries);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// catchUpCheckpoints (write-side idempotent backfill)
// ---------------------------------------------------------------------------

test("(6) catchUpCheckpoints: backfills all history entries on first call", () => {
  const ledger = buildLedger([
    ["HYK-1", "rejected"],
    ["HYK-1", "rejected"],
    ["HYK-1", "approved"],
  ]);
  const chain = catchUpCheckpoints(
    ledger,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );
  const entries = chain.issues["HYK-1"].entries;
  assert.equal(entries.length, 3);
  assert.equal(entries[0].streak, 1);
  assert.equal(entries[1].streak, 2);
  assert.equal(entries[2].streak, 0);
});

test("(7) catchUpCheckpoints: idempotent -- second call with nothing new appends nothing", () => {
  const ledger = buildLedger([["HYK-1", "rejected"]]);
  const chainV1 = catchUpCheckpoints(
    ledger,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );
  const chainV2 = catchUpCheckpoints(ledger, chainV1, "HYK-1");
  assert.deepEqual(chainV1, chainV2);
});

test("(8) catchUpCheckpoints: catches up only the NEW tail on a second call", () => {
  const ledger1 = buildLedger([["HYK-1", "rejected"]]);
  let chain = catchUpCheckpoints(
    ledger1,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );
  assert.equal(chain.issues["HYK-1"].entries.length, 1);

  let ledger2 = applyOutcome(ledger1, {
    issueId: "HYK-1",
    taskId: "HYK-1-round-2",
    verdict: "rejected",
    at: "t2",
  });
  chain = catchUpCheckpoints(ledger2, chain, "HYK-1");
  assert.equal(chain.issues["HYK-1"].entries.length, 2);
  assert.equal(chain.issues["HYK-1"].entries[1].streak, 2);
});

// ---------------------------------------------------------------------------
// checkAppendOnly -- §4 ⓐⓑⓒⓓ
// ---------------------------------------------------------------------------

test("(9) §4ⓒ 새 이슈 첫 배달: 사이드카에 체크포인트가 없으면 오탐 없이 PASS", () => {
  const primaryLedger = { schema_version: 1, issues: {} };
  const chain = { schema_version: 1, issues: {} };
  const result = checkAppendOnly({ primaryLedger, chain, issueId: "HYK-999" });
  assert.equal(result.status, "PASS");
});

test("(9b) §4ⓒ 새 이슈 첫 배달: 원장엔 있어도 체크포인트가 없으면 여전히 PASS (기존 57이슈와 동일 상황)", () => {
  const primaryLedger = buildLedger([
    ["HYK-133", "rejected"],
    ["HYK-133", "rejected"],
  ]);
  const chain = { schema_version: 1, issues: {} };
  const result = checkAppendOnly({ primaryLedger, chain, issueId: "HYK-133" });
  assert.equal(result.status, "PASS");
});

test("(10) §4ⓓ 정상 진행 (0->1->2): 체크포인트와 원장이 계속 일치하면 매 단계 PASS", () => {
  let ledger = { schema_version: 1, issues: {} };
  let chain = { schema_version: 1, issues: {} };

  ledger = applyOutcome(ledger, {
    issueId: "HYK-1",
    taskId: "a",
    verdict: "rejected",
    at: "t1",
  });
  chain = catchUpCheckpoints(ledger, chain, "HYK-1");
  assert.equal(
    checkAppendOnly({ primaryLedger: ledger, chain, issueId: "HYK-1" }).status,
    "PASS",
  );

  ledger = applyOutcome(ledger, {
    issueId: "HYK-1",
    taskId: "b",
    verdict: "rejected",
    at: "t2",
  });
  chain = catchUpCheckpoints(ledger, chain, "HYK-1");
  assert.equal(
    checkAppendOnly({ primaryLedger: ledger, chain, issueId: "HYK-1" }).status,
    "PASS",
  );
  assert.equal(ledger.issues["HYK-1"].streak, 2);
});

test("(11) §4ⓐ 항목 삭제 주입 -> 거부 (history 길이가 체크포인트보다 짧아짐)", () => {
  let ledger = buildLedger([
    ["HYK-1", "rejected"],
    ["HYK-1", "rejected"],
  ]);
  let chain = catchUpCheckpoints(
    ledger,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );
  assert.equal(
    checkAppendOnly({ primaryLedger: ledger, chain, issueId: "HYK-1" }).status,
    "PASS",
  );

  // Inject a deletion: drop the first history entry directly (bypassing
  // applyOutcome/record, exactly the "ORCH가 도구를 거치지 않고 손댄다"
  // scenario this task targets).
  const tampered = JSON.parse(JSON.stringify(ledger));
  tampered.issues["HYK-1"].history.shift();
  const result = checkAppendOnly({
    primaryLedger: tampered,
    chain,
    issueId: "HYK-1",
  });
  assert.equal(result.status, "BLOCK");
  assert.match(
    result.reason,
    /entry deletion suspected|no longer matches checkpoint/,
  );
});

test("(12) §4ⓑ streak 후퇴 주입(2->0) -> 거부 (history는 그대로, streak 필드만 조작)", () => {
  let ledger = buildLedger([
    ["HYK-1", "rejected"],
    ["HYK-1", "rejected"],
  ]);
  let chain = catchUpCheckpoints(
    ledger,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );
  assert.equal(ledger.issues["HYK-1"].streak, 2);

  const tampered = JSON.parse(JSON.stringify(ledger));
  tampered.issues["HYK-1"].streak = 0;
  const result = checkAppendOnly({
    primaryLedger: tampered,
    chain,
    issueId: "HYK-1",
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /streak regression suspected/);
});

test("(13) 정상적인 approve로 인한 streak 0 복귀는 거부하지 않는다 (오탐 방지)", () => {
  let ledger = buildLedger([
    ["HYK-1", "rejected"],
    ["HYK-1", "rejected"],
  ]);
  let chain = catchUpCheckpoints(
    ledger,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );

  ledger = applyOutcome(ledger, {
    issueId: "HYK-1",
    taskId: "c",
    verdict: "approved",
    at: "t3",
  });
  const result = checkAppendOnly({
    primaryLedger: ledger,
    chain,
    issueId: "HYK-1",
  });
  assert.equal(result.status, "PASS");
  assert.equal(ledger.issues["HYK-1"].streak, 0);
});

test("(14) 중간 항목 치환(내용은 다르지만 개수는 그대로) -> 거부", () => {
  let ledger = buildLedger([
    ["HYK-1", "approved"],
    ["HYK-1", "rejected"],
    ["HYK-1", "rejected"],
  ]);
  let chain = catchUpCheckpoints(
    ledger,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );

  const tampered = JSON.parse(JSON.stringify(ledger));
  tampered.issues["HYK-1"].history[1] = {
    task_id: "forged",
    verdict: "approved",
    at: "t2",
  };
  const result = checkAppendOnly({
    primaryLedger: tampered,
    chain,
    issueId: "HYK-1",
  });
  assert.equal(result.status, "BLOCK");
});

// ---------------------------------------------------------------------------
// HYK-218 2R (REVIEW 1R 반려 사유 수리): checkAppendOnly의 원장 대조가
// task_id/verdict만 보고 `at`을 빠뜨려, `at`만 위조하면 PASS로 새는 것을
// 검토자가 직접 재현했다. §1-1/§1-2 회귀 시험.
// ---------------------------------------------------------------------------

test("(14b) §0 반려 재현 -- history[0]의 `at`만 위조(task_id/verdict는 그대로) -> 거부 (수리 전엔 PASS였다)", () => {
  let ledger = buildLedger([["HYK-1", "rejected"]]);
  let chain = catchUpCheckpoints(
    ledger,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );

  const tampered = JSON.parse(JSON.stringify(ledger));
  assert.equal(tampered.issues["HYK-1"].history[0].at, "t1");
  tampered.issues["HYK-1"].history[0].at = "forged-time";
  // task_id/verdict 는 손대지 않았다 -- 오직 `at`만 위조.
  assert.equal(
    tampered.issues["HYK-1"].history[0].task_id,
    ledger.issues["HYK-1"].history[0].task_id,
  );
  assert.equal(
    tampered.issues["HYK-1"].history[0].verdict,
    ledger.issues["HYK-1"].history[0].verdict,
  );

  const result = checkAppendOnly({
    primaryLedger: tampered,
    chain,
    issueId: "HYK-1",
  });
  assert.equal(
    result.status,
    "BLOCK",
    "at-only forgery must now be caught (2R fix)",
  );
  assert.match(result.reason, /no longer matches checkpoint/);
});

test("(14c) 구조 고정 -- CHECKPOINT_HASH_FIELDS는 LIVE_COMPARISON_FIELDS + DERIVED_ONLY_FIELDS의 단순 연결이다 (두 목록이 갈라질 수 없다는 것을 시험이 직접 확증)", () => {
  assert.deepEqual(CHECKPOINT_HASH_FIELDS, [
    ...LIVE_COMPARISON_FIELDS,
    ...DERIVED_ONLY_FIELDS,
  ]);
  // 해시에 들어가는 모든 필드는 반드시 "라이브와 대조한다" 아니면 "대조
  // 대상이 없는 파생값이다" 둘 중 하나로 분류돼 있어야 한다 -- 어느 쪽도
  // 아닌 필드(둘 다 속하거나 둘 다 안 속하는 경우)가 있으면 즉시 실패.
  const overlap = LIVE_COMPARISON_FIELDS.filter((f) =>
    DERIVED_ONLY_FIELDS.includes(f),
  );
  assert.deepEqual(
    overlap,
    [],
    "a field cannot be both live-compared and derived-only",
  );
  assert.equal(
    new Set(CHECKPOINT_HASH_FIELDS).size,
    CHECKPOINT_HASH_FIELDS.length,
    "no duplicate fields",
  );
});

test("(14d) `streak`은 라이브 대조 목록에 없다 -- 근거: primaryLedger의 history 엔트리엔 `streak` 필드 자체가 없다(오직 이슈 최상위 streak만 있다)", () => {
  const sampleLiveEntry = buildLedger([["HYK-1", "rejected"]]).issues["HYK-1"]
    .history[0];
  assert.equal(
    Object.prototype.hasOwnProperty.call(sampleLiveEntry, "streak"),
    false,
    "a real primary-ledger history entry has no per-entry streak field to compare against",
  );
  assert.equal(LIVE_COMPARISON_FIELDS.includes("streak"), false);
  assert.equal(DERIVED_ONLY_FIELDS.includes("streak"), true);
});

test("(14e) `streak`에 «같은 형태의 누락」은 없다 -- task_id/verdict/at이 전부 일치하면 streak은 그 부분열의 순수 fold라 독립적으로 위조될 여지가 없다(위조를 숨길 라이브 필드 자체가 없음을 실측)", () => {
  // Two issues built with IDENTICAL verdict sequences (so task_id/verdict/at
  // match at every checkpointed index) can never disagree on the streak a
  // checkpoint recorded -- there is no live field left for a streak forgery
  // to hide behind once the other three match.
  const seqA = buildLedger([
    ["HYK-1", "rejected"],
    ["HYK-1", "rejected"],
    ["HYK-1", "approved"],
  ]);
  const chain = catchUpCheckpoints(
    seqA,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );
  for (const cp of chain.issues["HYK-1"].entries) {
    const recomputed = seqA.issues["HYK-1"].history
      .slice(0, cp.index + 1)
      .reduce((s, e) => (e.verdict === "rejected" ? s + 1 : 0), 0);
    assert.equal(
      cp.streak,
      recomputed,
      `checkpoint[${cp.index}].streak must equal the pure fold over the identical, already-verified verdict subsequence`,
    );
  }
  // PASS confirms nothing here regresses the existing behavior either.
  assert.equal(
    checkAppendOnly({ primaryLedger: seqA, chain, issueId: "HYK-1" }).status,
    "PASS",
  );
});

// ---------------------------------------------------------------------------
// HYK-218 3R (REVIEW 2R 반려 사유 수리, 한용 "다" ①): 2R의 streak 후퇴
// 검사는 사이드카가 주장하는 `lastCheckpoint.streak`를 그대로 믿었다.
// 검토자는 사이드카의 `streak`를 낮추고 해시를 재계산하면(사이드카
// 자신은 내부적으로 여전히 정합) 그 비교가 무력화되는 것을 실증했다.
// 3R은 그 비교를 사이드카에 의존하지 않는, primary history에서 직접
// 재계산한 fold와의 대조로 바꿨다. §2 회귀 시험(ⓐ) + §2 변이 RED(ⓑ).
// ---------------------------------------------------------------------------

test("(14f) §2① 반려 재현 -- 원장 streak 후퇴(2->0) + 사이드카 streak도 같이 낮추고 해시 재계산(사이드카 자체 정합 유지) -> 거부 (수리 전엔 이 조합이 PASS였다)", () => {
  let ledger = buildLedger([
    ["HYK-1", "rejected"],
    ["HYK-1", "rejected"],
  ]);
  let chain = catchUpCheckpoints(
    ledger,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );
  assert.equal(ledger.issues["HYK-1"].streak, 2);
  assert.equal(chain.issues["HYK-1"].entries[1].streak, 2);

  // Attacker forges BOTH: primary ledger's own streak field (the actual
  // lie -- history entries themselves are untouched) AND the sidecar's
  // last checkpoint's streak, recomputing the sidecar's hash chain so
  // verifyChainIntegrity still reports the sidecar as self-consistent.
  const tamperedLedger = JSON.parse(JSON.stringify(ledger));
  tamperedLedger.issues["HYK-1"].streak = 0;

  const forgedChain = {
    schema_version: 1,
    issues: { "HYK-1": { entries: [] } },
  };
  let rebuilt = forgedChain;
  const h = ledger.issues["HYK-1"].history;
  // Re-derive checkpoints from scratch but lie about the LAST one's streak
  // (0 instead of the true 2) -- exactly "사이드카의 streak를 낮추고
  // 해시를 다시 계산" -- using the module's own appendCheckpoint so the
  // hash is properly (self-consistently) recomputed, not just hand-edited.
  rebuilt = appendCheckpoint(rebuilt, {
    issueId: "HYK-1",
    taskId: h[0].task_id,
    verdict: h[0].verdict,
    at: h[0].at,
    streak: 1,
  });
  rebuilt = appendCheckpoint(rebuilt, {
    issueId: "HYK-1",
    taskId: h[1].task_id,
    verdict: h[1].verdict,
    at: h[1].at,
    streak: 0,
  });
  // Confirm the forged sidecar really is internally self-consistent (this
  // is precisely what made the 2R-era bug hard to see -- nothing LOOKS
  // broken from the sidecar's own point of view).
  assert.equal(
    verifyChainIntegrity(rebuilt.issues["HYK-1"].entries).ok,
    true,
    "forged sidecar must still be internally self-consistent -- that is the whole point of this bypass",
  );

  const result = checkAppendOnly({
    primaryLedger: tamperedLedger,
    chain: rebuilt,
    issueId: "HYK-1",
  });
  assert.equal(
    result.status,
    "BLOCK",
    "3R fix must catch this even though the sidecar was recomputed to agree with the lie",
  );
  assert.match(result.reason, /streak regression suspected/);
  assert.match(
    result.reason,
    /recomputed directly from primary ledger history/,
  );
});

test("(14g) HYK-218 3R §2 변이 RED -- streak 검사를 사이드카(`lastCheckpoint.streak`) 신뢰로 되돌리면 (14f)의 정확히 그 우회가 다시 PASS로 새고, 시험은 RED가 된다", async () => {
  const src = readFileSyncForMutation(SCRIPT_PATH, "utf8");
  const marker =
    "  const streakCheck = checkStreakSelfConsistency(\n" +
    "    primaryLedger,\n" +
    "    primaryHistory,\n" +
    "    issueId,\n" +
    "  );\n" +
    "  if (!streakCheck.ok) {";
  assert.ok(
    src.includes(marker),
    "3R fix marker must exist in the source -- if this fails, the fix was already reverted/renamed",
  );
  // Revert to the pre-3R (2R-era) comparison: trust the sidecar's own
  // `streak` (lastCheckpoint.streak) instead of recomputing from primary
  // history -- bypassing checkStreakSelfConsistency at the call site
  // entirely, same net effect as reverting the helper itself.
  const mutated = src.replace(
    marker,
    "  const currentStreak = primaryLedger?.issues?.[issueId]?.streak ?? 0;\n" +
      "  const streakCheck = { currentStreak, recomputedStreak: lastCheckpoint.streak };\n" +
      "  if (primaryHistory.length === entries.length && currentStreak < lastCheckpoint.streak) {",
  );
  assert.notEqual(mutated, src);

  await withFixtureDirAsync(async (dir) => {
    const mutantPath = join(dir, "reject-streak-chain-mutant-streak.mjs");
    const rejectStreakAbs = fileURLToPath(
      new URL("./reject-streak.mjs", import.meta.url),
    ).replace(/\\/g, "/");
    const patched = mutated.replace(
      'from "./reject-streak.mjs"',
      `from "file://${rejectStreakAbs}"`,
    );
    writeFileSync(mutantPath, patched, "utf8");
    const mod = await import(`file://${mutantPath.replace(/\\/g, "/")}`);

    let ledger = buildLedger([
      ["HYK-1", "rejected"],
      ["HYK-1", "rejected"],
    ]);
    const tamperedLedger = JSON.parse(JSON.stringify(ledger));
    tamperedLedger.issues["HYK-1"].streak = 0;
    const h = ledger.issues["HYK-1"].history;
    let forged = { schema_version: 1, issues: {} };
    forged = mod.appendCheckpoint(forged, {
      issueId: "HYK-1",
      taskId: h[0].task_id,
      verdict: h[0].verdict,
      at: h[0].at,
      streak: 1,
    });
    forged = mod.appendCheckpoint(forged, {
      issueId: "HYK-1",
      taskId: h[1].task_id,
      verdict: h[1].verdict,
      at: h[1].at,
      streak: 0,
    });

    const result = mod.checkAppendOnly({
      primaryLedger: tamperedLedger,
      chain: forged,
      issueId: "HYK-1",
    });
    assert.equal(
      result.status,
      "PASS",
      "mutant (streak check reverted to trusting the sidecar) should let the co-forged input back through",
    );
  });

  const diff = execFileSyncForGitCheck("git", ["diff", "--", SCRIPT_PATH], {
    encoding: "utf8",
  });
  assert.equal(
    diff.trim(),
    "",
    "this test must never modify the real source file",
  );
});

// ---------------------------------------------------------------------------
// HYK-218 3R §3 (한용 "다" ②, 정직 한계 고정): 원장+사이드카를 "함께"
// 재계산해 위조하면 이 검사는 여전히 통과한다. ⛔이 시험은 "실패해야
// 한다"가 아니라 "지금 설계로는 통과한다"는 사실 자체를 고정한다 --
// 나중에 누가 이 한계를 조용히 "닫혔다"고 바꾸면(즉 이 입력이 갑자기
// BLOCK으로 바뀌면) 이 시험이 깨져서 문서와 코드가 다시 맞아떨어지도록
// 강제한다.
// ---------------------------------------------------------------------------

test("(14h) §3② 한계 고정(닫지 않음, 닫힌 척하지 않음) -- 원장 history에서 항목을 지우고 사이드카도 그 지워진 모습에 맞춰 처음부터 다시 만들면(둘 다 재계산) 지금 설계로는 PASS다", () => {
  let ledger = buildLedger([
    ["HYK-1", "rejected"],
    ["HYK-1", "rejected"],
    ["HYK-1", "approved"],
  ]);
  let chain = catchUpCheckpoints(
    ledger,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );
  assert.equal(
    checkAppendOnly({ primaryLedger: ledger, chain, issueId: "HYK-1" }).status,
    "PASS",
  );

  // Attacker deletes the middle entry from the PRIMARY ledger's history...
  const forgedLedger = JSON.parse(JSON.stringify(ledger));
  forgedLedger.issues["HYK-1"].history.splice(1, 1);
  // Recompute the issue-level streak so it too is consistent with the
  // shrunken history (an attacker forging the primary ledger would do
  // this, not leave a mismatch -- that mismatch is exactly what 3R's own
  // self-consistency check would otherwise catch).
  forgedLedger.issues["HYK-1"].streak = forgedLedger.issues[
    "HYK-1"
  ].history.reduce((s, e) => (e.verdict === "rejected" ? s + 1 : 0), 0);

  // ...AND rebuilds the sidecar FROM SCRATCH against that same shrunken
  // history, so every checkpoint, every hash, and the self-consistency
  // check all agree with each other -- because they were all derived from
  // the SAME (forged) primary ledger, using this module's own real
  // functions (not hand-edited hashes).
  const forgedChain = catchUpCheckpoints(
    forgedLedger,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );

  const result = checkAppendOnly({
    primaryLedger: forgedLedger,
    chain: forgedChain,
    issueId: "HYK-1",
  });
  // ★This assertion documents the known, accepted limitation -- it is NOT
  // a bug to fix. If this ever starts failing (status flips to BLOCK),
  // that means a future change closed this gap and BOTH this test and the
  // "정직 한계" header comment in reject-streak-chain.mjs must be updated
  // together so the code/doc/test never silently drift out of sync.
  assert.equal(
    result.status,
    "PASS",
    "documented limitation: a coordinated primary+sidecar re-derivation is not detectable by this design",
  );
});

// ---------------------------------------------------------------------------
// HYK-218 3R §4ⓓ 오탐 분모 N>=3 -- 새 streak 재계산 검사(currentStreak vs
// foldStreakUpTo(primaryHistory, ...)) 자체를 겨냥한, 서로 다른 3사유의
// "정상인데 걸리지 않는지" 시험. (1R의 17/18/19는 원장 형태 다양성을
// 겨냥했다 -- 이 셋은 3R이 새로 넣은 재계산 로직의 경계를 겨냥한다.)
// ---------------------------------------------------------------------------

test("(14i-1) 오탐 분모 3R #1 -- 체크포인트가 뒤처진 채(catch-up 지연) 원장만 더 자란 정상 상태도 PASS (재계산은 전체 history를 보므로 체크포인트 지연 자체는 문제가 아니다)", () => {
  let ledger = buildLedger([
    ["HYK-1", "rejected"],
    ["HYK-1", "rejected"],
  ]);
  // Checkpoint only the FIRST entry -- deliberately behind.
  let chain = { schema_version: 1, issues: {} };
  chain = catchUpCheckpoints(
    {
      issues: {
        "HYK-1": { history: ledger.issues["HYK-1"].history.slice(0, 1) },
      },
    },
    chain,
    "HYK-1",
  );
  assert.equal(chain.issues["HYK-1"].entries.length, 1);

  // Ledger keeps growing legitimately (a real third reject) while the
  // sidecar hasn't caught up to entry 2 or 3 yet.
  ledger = applyOutcome(ledger, {
    issueId: "HYK-1",
    taskId: "HYK-1-r3",
    verdict: "rejected",
    at: "t3",
  });
  assert.equal(ledger.issues["HYK-1"].streak, 3);

  const result = checkAppendOnly({
    primaryLedger: ledger,
    chain,
    issueId: "HYK-1",
  });
  assert.equal(
    result.status,
    "PASS",
    `lagging checkpoints on an otherwise-honest, growing ledger must not false-positive: ${result.reason}`,
  );
});

test("(14i-2) 오탐 분모 3R #2 -- 승인 없이 반려만 길게 이어진(항상 streak==history.length) 원장도 PASS", () => {
  const seq = Array.from({ length: 12 }, () => ["HYK-1", "rejected"]);
  let ledger = buildLedger(seq);
  let chain = catchUpCheckpoints(
    ledger,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );
  assert.equal(ledger.issues["HYK-1"].streak, 12);
  const result = checkAppendOnly({
    primaryLedger: ledger,
    chain,
    issueId: "HYK-1",
  });
  assert.equal(
    result.status,
    "PASS",
    `a long unbroken reject streak (streak == full history length) must not false-positive: ${result.reason}`,
  );
});

test("(14i-3) 오탐 분모 3R #3 -- 여러 이슈가 서로 다른 시점에 approve/reject를 섞어 반복(체크포인트를 매 라운드 갱신)해도 매 단계 PASS", () => {
  let ledger = { schema_version: 1, issues: {} };
  let chain = { schema_version: 1, issues: {} };
  const rounds = [
    ["HYK-9", "rejected"],
    ["HYK-8", "rejected"],
    ["HYK-9", "approved"],
    ["HYK-8", "rejected"],
    ["HYK-9", "rejected"],
    ["HYK-9", "rejected"],
    ["HYK-8", "approved"],
  ];
  let t = 0;
  for (const [issueId, verdict] of rounds) {
    t++;
    ledger = applyOutcome(ledger, {
      issueId,
      taskId: `${issueId}-r${t}`,
      verdict,
      at: `t${t}`,
    });
    chain = catchUpCheckpoints(ledger, chain, issueId);
    const result = checkAppendOnly({ primaryLedger: ledger, chain, issueId });
    assert.equal(
      result.status,
      "PASS",
      `round ${t} (${issueId}): ${result.reason}`,
    );
  }
  assert.equal(ledger.issues["HYK-9"].streak, 2);
  assert.equal(ledger.issues["HYK-8"].streak, 0);
});

test("(15) 사이드카 자체가 위조(해시 재계산 없이 값만 수정)되면 거부", () => {
  let ledger = buildLedger([["HYK-1", "rejected"]]);
  let chain = catchUpCheckpoints(
    ledger,
    { schema_version: 1, issues: {} },
    "HYK-1",
  );
  chain.issues["HYK-1"].entries[0].streak = 99; // hash not recomputed
  const result = checkAppendOnly({
    primaryLedger: ledger,
    chain,
    issueId: "HYK-1",
  });
  assert.equal(result.status, "BLOCK");
});

// ---------------------------------------------------------------------------
// checkAppendOnlyAll
// ---------------------------------------------------------------------------

test("(16) checkAppendOnlyAll: 하나라도 위반이면 전체 BLOCK, 위반 목록 포함", () => {
  let ledger = buildLedger([
    ["HYK-1", "rejected"],
    ["HYK-2", "rejected"],
  ]);
  let chain = { schema_version: 1, issues: {} };
  chain = catchUpCheckpoints(ledger, chain, "HYK-1");
  chain = catchUpCheckpoints(ledger, chain, "HYK-2");

  const tampered = JSON.parse(JSON.stringify(ledger));
  tampered.issues["HYK-2"].history = [];
  tampered.issues["HYK-2"].streak = 0;

  const result = checkAppendOnlyAll({ primaryLedger: tampered, chain });
  assert.equal(result.status, "BLOCK");
  const blocked = result.results.filter((r) => r.status === "BLOCK");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].issueId, "HYK-2");
});

// ---------------------------------------------------------------------------
// §4 오탐 분모: 정상 원장 표본 최소 3개 -- 전부 PASS(거짓 BLOCK 0)
// ---------------------------------------------------------------------------

test("(17) 오탐 표본 #1 -- 실제 defect-sample.json(19이슈, applyOutcome과 동일 fold 규칙으로 생성된 합성 원장) 전체가 체크포인트 직후 PASS", () => {
  const sampleLedger = JSON.parse(readFileSync(DEFECT_SAMPLE_PATH, "utf8"));
  let chain = { schema_version: 1, issues: {} };
  for (const issueId of Object.keys(sampleLedger.issues)) {
    chain = catchUpCheckpoints(sampleLedger, chain, issueId);
  }
  const result = checkAppendOnlyAll({ primaryLedger: sampleLedger, chain });
  assert.equal(
    result.status,
    "PASS",
    result.reason +
      JSON.stringify(result.results.filter((r) => r.status === "BLOCK")),
  );
});

test("(18) 오탐 표본 #2 -- 무작위성 있는 다중 이슈 원장(반려/승인 뒤섞임, 긴 이력)도 체크포인트 직후 PASS", () => {
  const seq = [];
  const issues = ["HYK-201", "HYK-202", "HYK-203"];
  const verdictPattern = [
    "rejected",
    "rejected",
    "approved",
    "rejected",
    "approved",
    "approved",
  ];
  for (let i = 0; i < 30; i++) {
    seq.push([
      issues[i % issues.length],
      verdictPattern[i % verdictPattern.length],
    ]);
  }
  const ledger = buildLedger(seq);
  let chain = { schema_version: 1, issues: {} };
  for (const issueId of issues)
    chain = catchUpCheckpoints(ledger, chain, issueId);
  const result = checkAppendOnlyAll({ primaryLedger: ledger, chain });
  assert.equal(result.status, "PASS");
});

test("(19) 오탐 표본 #3 -- 체크포인트 이후 정상적으로 이어서 기록된(catch-up을 여러 번 호출한) 원장도 PASS", () => {
  let ledger = { schema_version: 1, issues: {} };
  let chain = { schema_version: 1, issues: {} };
  const rounds = [
    ["HYK-77", "rejected"],
    ["HYK-77", "approved"],
    ["HYK-77", "rejected"],
    ["HYK-77", "rejected"],
    ["HYK-77", "rejected"],
  ];
  let t = 0;
  for (const [issueId, verdict] of rounds) {
    t++;
    ledger = applyOutcome(ledger, {
      issueId,
      taskId: `${issueId}-r${t}`,
      verdict,
      at: `t${t}`,
    });
    chain = catchUpCheckpoints(ledger, chain, issueId);
    const result = checkAppendOnly({ primaryLedger: ledger, chain, issueId });
    assert.equal(result.status, "PASS", `round ${t}: ${result.reason}`);
  }
  assert.equal(ledger.issues["HYK-77"].streak, 3);
});

// ---------------------------------------------------------------------------
// §0 호환성 실측 (읽기 전용): 현재 라이브 원장 스키마를 loadLedger(수정 無)가
// 여전히 그대로 읽을 수 있고, 체크포인트가 없는 상태(오늘의 실제 상황)에서
// checkAppendOnlyAll이 그 원장 전체를 오탐 0으로 통과시키는지 -- 파일은
// READ ONLY로만 연다, 절대 쓰지 않는다.
// ---------------------------------------------------------------------------

test("(20) §0/§2 호환성: 실제 라이브 reject-streak.json을 읽기 전용으로 로드해도 append-only 체크가 오탐 없이 전부 PASS (체크포인트 부재 = 무조건 PASS 설계이므로 당연 귀결이지만, 실제 파일 구조로 실측)", () => {
  // repo root via git, read-only.
  const rootResult = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const livePath = join(rootResult, ".harness", "reject-streak.json");
  const loaded = loadLedger(livePath);
  assert.equal(
    loaded.ok,
    true,
    "live ledger must remain parseable by the UNCHANGED loadLedger()",
  );
  // No sidecar chain exists in production yet -- checkAppendOnlyAll must
  // therefore PASS unconditionally for every one of the real issues.
  const result = checkAppendOnlyAll({
    primaryLedger: loaded.ledger,
    chain: { schema_version: 1, issues: {} },
  });
  assert.equal(result.status, "PASS");
});

// ---------------------------------------------------------------------------
// CLI (checkpoint / verify / verify-all)
// ---------------------------------------------------------------------------

test("(21) CLI checkpoint + verify: 정상 흐름 end-to-end", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    const chainPath = join(dir, "reject-streak-chain.json");
    const ledger = buildLedger([
      ["HYK-1", "rejected"],
      ["HYK-1", "rejected"],
    ]);
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");

    const checkpointRun = runCli([
      "checkpoint",
      "--issue",
      "HYK-1",
      "--ledger",
      ledgerPath,
      "--chain",
      chainPath,
    ]);
    assert.equal(checkpointRun.status, 0);

    const verifyRun = runCli([
      "verify",
      "--issue",
      "HYK-1",
      "--ledger",
      ledgerPath,
      "--chain",
      chainPath,
    ]);
    assert.equal(verifyRun.status, 0);
  });
});

test("(22) CLI verify: 새 이슈(체크포인트 없음)는 exit 0 (오탐 0)", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    const chainPath = join(dir, "reject-streak-chain.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify({ schema_version: 1, issues: {} }),
      "utf8",
    );
    const verifyRun = runCli([
      "verify",
      "--issue",
      "HYK-999",
      "--ledger",
      ledgerPath,
      "--chain",
      chainPath,
    ]);
    assert.equal(verifyRun.status, 0);
  });
});

test("(23) CLI verify: 체크포인트 이후 원장에서 항목이 삭제되면 exit 2", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    const chainPath = join(dir, "reject-streak-chain.json");
    let ledger = buildLedger([
      ["HYK-1", "rejected"],
      ["HYK-1", "rejected"],
    ]);
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    runCli([
      "checkpoint",
      "--issue",
      "HYK-1",
      "--ledger",
      ledgerPath,
      "--chain",
      chainPath,
    ]);

    // Simulate ORCH hand-editing the ledger: drop an entry, forget the chain
    // sidecar exists.
    ledger.issues["HYK-1"].history.pop();
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");

    const verifyRun = runCli([
      "verify",
      "--issue",
      "HYK-1",
      "--ledger",
      ledgerPath,
      "--chain",
      chainPath,
    ]);
    assert.equal(verifyRun.status, 2);
    assert.match(verifyRun.stderr, /reject-streak append-only/);
  });
});

test("(24) CLI verify-all: 여러 이슈 중 하나만 위반해도 exit 2 + 개별 결과 출력", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    const chainPath = join(dir, "reject-streak-chain.json");
    let ledger = buildLedger([
      ["HYK-1", "rejected"],
      ["HYK-2", "rejected"],
    ]);
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    runCli([
      "checkpoint",
      "--issue",
      "HYK-1",
      "--ledger",
      ledgerPath,
      "--chain",
      chainPath,
    ]);
    runCli([
      "checkpoint",
      "--issue",
      "HYK-2",
      "--ledger",
      ledgerPath,
      "--chain",
      chainPath,
    ]);

    ledger.issues["HYK-1"].streak = 0; // regression, no new history
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");

    const run = runCli([
      "verify-all",
      "--ledger",
      ledgerPath,
      "--chain",
      chainPath,
    ]);
    assert.equal(run.status, 2);
    assert.match(run.stdout, /BLOCK HYK-1/);
    assert.match(run.stdout, /PASS HYK-2/);
  });
});

// ---------------------------------------------------------------------------
// §4ⓔ 변이(mutation) RED: 탐지 분기를 제거하면 시험이 빨간불
// ---------------------------------------------------------------------------
//
// 원복 증명 방식: 이 시험은 checkAppendOnly의 소스 텍스트를 읽어, "길이가
// 체크포인트보다 짧아지는" 검사 블록이 실제로 소스에 존재하는지
// 문자열로 확증한다(있어야 하는 코드가 실제로 거기 있다는 것 자체가
// "제거하면 이 시험이 깨진다"의 증거) + 그 블록을 제거한 변이본을 별도
// 파일로 만들어 동적 import, 같은 입력에 대해 실제로 PASS로 뒤집히는지
// (RED가 켜지는지) 검증한다. 변이본은 mkdtemp 임시 파일일 뿐 이 저장소
// 파일을 전혀 건드리지 않는다(git diff --exit-code로 원본 무변경 확인).
import { readFileSync as readFileSyncForMutation } from "node:fs";
import { execFileSync as execFileSyncForGitCheck } from "node:child_process";

test("(25) §4ⓔ 변이 RED -- 삭제/후퇴 탐지 본문을 제거한 사본은 같은 입력에서 PASS로 뒤집힌다(원래는 BLOCK)", async () => {
  const src = readFileSyncForMutation(SCRIPT_PATH, "utf8");
  // The whole detection body of checkAppendOnly -- length-shrink check,
  // per-checkpoint entry match loop, and streak-regression check -- lives
  // between these two anchors. Cutting it out and replacing it with an
  // unconditional PASS is the mutation: if any ONE of those three checks
  // alone still caught a given tamper, cutting only that one branch might
  // leave another branch standing guard (defense in depth is real -- test
  // 11 already shows the entry-match loop alone catches a shift()). This
  // mutation removes ALL of them at once, so the flip to PASS is
  // unambiguous proof the removed code -- not some other path -- was doing
  // the detecting.
  const startAnchor =
    "  const primaryHistory = getPrimaryHistory(primaryLedger, issueId);";
  const endAnchor = "\n\nexport function checkAppendOnlyAll(";
  const startIdx = src.indexOf(startAnchor);
  const endIdx = src.indexOf(endAnchor);
  assert.ok(
    startIdx !== -1,
    "mutation start anchor must exist in the source -- if this fails, the detector was already removed/renamed",
  );
  assert.ok(
    endIdx !== -1 && endIdx > startIdx,
    "mutation end anchor must exist after the start anchor",
  );
  const mutated =
    src.slice(0, startIdx) +
    '  return { status: "PASS", ok: true, reason: "mutated-bypass" };\n}' +
    src.slice(endIdx);

  await withFixtureDirAsync(async (dir) => {
    const mutantPath = join(dir, "reject-streak-chain-mutant.mjs");
    // Rewrite the relative import so the mutant can still resolve
    // reject-streak.mjs from its ORIGINAL location.
    const rejectStreakAbs = fileURLToPath(
      new URL("./reject-streak.mjs", import.meta.url),
    ).replace(/\\/g, "/");
    const patched = mutated.replace(
      'from "./reject-streak.mjs"',
      `from "file://${rejectStreakAbs}"`,
    );
    writeFileSync(mutantPath, patched, "utf8");

    const mod = await import(`file://${mutantPath.replace(/\\/g, "/")}`);

    let ledger = buildLedger([
      ["HYK-1", "rejected"],
      ["HYK-1", "rejected"],
    ]);
    let chain = mod.catchUpCheckpoints(
      ledger,
      { schema_version: 1, issues: {} },
      "HYK-1",
    );
    const tampered = JSON.parse(JSON.stringify(ledger));
    tampered.issues["HYK-1"].history.shift();

    // With the real (unmutated) detector, this is BLOCK (see test 11).
    // With the mutant (deletion-length check removed), it must flip to
    // PASS -- proving the removed block is the thing actually catching it.
    const result = mod.checkAppendOnly({
      primaryLedger: tampered,
      chain,
      issueId: "HYK-1",
    });
    assert.equal(
      result.status,
      "PASS",
      "mutant should fail to detect the deletion once the length-check block is removed",
    );
  });

  // Prove the real source file itself is untouched by this test.
  const diff = execFileSyncForGitCheck("git", ["diff", "--", SCRIPT_PATH], {
    encoding: "utf8",
  });
  assert.equal(
    diff.trim(),
    "",
    "this test must never modify the real source file",
  );
});

test("(26) HYK-218 2R §1-4 변이 RED -- LIVE_COMPARISON_FIELDS에서 `at`만 빼면 (14b)의 정확히 그 우회(at만 위조)가 다시 PASS로 새고, 시험은 RED가 된다", async () => {
  const src = readFileSyncForMutation(SCRIPT_PATH, "utf8");
  const marker =
    'export const LIVE_COMPARISON_FIELDS = ["task_id", "verdict", "at"];';
  assert.ok(
    src.includes(marker),
    "mutation target line must exist in the source -- if this fails, the 2R fix was already reverted/renamed",
  );
  const mutated = src.replace(
    marker,
    'export const LIVE_COMPARISON_FIELDS = ["task_id", "verdict"];',
  );
  assert.notEqual(mutated, src, "the replace must actually change something");

  await withFixtureDirAsync(async (dir) => {
    const mutantPath = join(dir, "reject-streak-chain-mutant-at.mjs");
    const rejectStreakAbs = fileURLToPath(
      new URL("./reject-streak.mjs", import.meta.url),
    ).replace(/\\/g, "/");
    const patched = mutated.replace(
      'from "./reject-streak.mjs"',
      `from "file://${rejectStreakAbs}"`,
    );
    writeFileSync(mutantPath, patched, "utf8");

    const mod = await import(`file://${mutantPath.replace(/\\/g, "/")}`);

    // Exactly the reviewer's repro: forge ONLY `at`, leave task_id/verdict
    // (and the sidecar) untouched.
    let ledger = buildLedger([["HYK-1", "rejected"]]);
    let chain = mod.catchUpCheckpoints(
      ledger,
      { schema_version: 1, issues: {} },
      "HYK-1",
    );
    const tampered = JSON.parse(JSON.stringify(ledger));
    tampered.issues["HYK-1"].history[0].at = "forged-time";

    const result = mod.checkAppendOnly({
      primaryLedger: tampered,
      chain,
      issueId: "HYK-1",
    });
    // With the real (unmutated, post-2R-fix) detector this is BLOCK (test
    // 14b). With `at` removed from the comparison list it must flip back
    // to PASS -- reproducing the exact bypass REVIEW 1R reported and
    // proving LIVE_COMPARISON_FIELDS's `at` entry is what closes it.
    assert.equal(
      result.status,
      "PASS",
      "mutant (at removed from comparison) should let the at-only forgery back through",
    );
  });

  const diff = execFileSyncForGitCheck("git", ["diff", "--", SCRIPT_PATH], {
    encoding: "utf8",
  });
  assert.equal(
    diff.trim(),
    "",
    "this test must never modify the real source file",
  );
});
