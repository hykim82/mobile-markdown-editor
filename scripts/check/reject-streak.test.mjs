import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseReviewOutcome,
  applyOutcome,
  computeRecord,
  loadLedger,
  writeLedger,
  checkEnvelope,
  checkGate,
  checkDiagnosticEnvelope,
  checkDiagnosticGate,
  HARD_STOP_STREAK,
  formatNowLocal,
  ALLOWED_CAUSES,
  ALLOWED_ACTIONS,
  REJECT_STREAK_REASON_CODE,
} from "./reject-streak.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./reject-streak.mjs", import.meta.url),
);

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "reject-streak-test-"));
  try {
    fn(dir);
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

const COMPLETE_ENVELOPE = [
  "<!-- reject-streak-envelope",
  "원인 분류: 모델 한계",
  "ORCH 조치:",
  "- 모델 변경: sonnet -> opus 승격",
  "-->",
].join("\n");

const COMPLETE_DIAGNOSTIC_ENVELOPE = [
  "<!-- reject-streak-envelope",
  "원인 분류: 모델 한계",
  "재현 증거 포인터: review-3.md L12-L40 (동일 mutation 3회 재현)",
  "ORCH 조치:",
  "- 모델 변경: sonnet -> opus 승격",
  "-->",
].join("\n");

// ---------------------------------------------------------------------------
// parseReviewOutcome
// ---------------------------------------------------------------------------

test("(1) parseReviewOutcome: 'for:' line rejected -> issue id derived", () => {
  const result = parseReviewOutcome(
    "for: HYK-133-coder-2\ntask_id: HYK-133-review-2\nverdict: rejected\n",
  );
  assert.deepEqual(result, {
    ok: true,
    taskId: "HYK-133-coder-2",
    issueId: "HYK-133",
    verdict: "rejected",
    doneAt: null,
  });
});

test("(2) parseReviewOutcome: 'for:' absent -> falls back to 'task_id:'", () => {
  const result = parseReviewOutcome(
    "task_id: HYK-133-review-2\nverdict: approved\n",
  );
  assert.deepEqual(result, {
    ok: true,
    taskId: "HYK-133-review-2",
    issueId: "HYK-133",
    verdict: "approved",
    doneAt: null,
  });
});

// ---------------------------------------------------------------------------
// HYK-183-ledger-fix (축 A): parseReviewOutcome's DONE-line extraction
// ---------------------------------------------------------------------------

test("(1b) parseReviewOutcome: single '>>> DONE: ... @ <time>' line -> doneAt extracted", () => {
  const result = parseReviewOutcome(
    "for: HYK-133\nverdict: rejected\n\n>>> DONE: REVIEW-CODEX @ 2026-08-05 09:34 KST\n",
  );
  assert.equal(result.ok, true);
  assert.equal(result.doneAt, "2026-08-05 09:34 KST");
});

test("(1c) parseReviewOutcome: no DONE line -> doneAt is null (falls back, not blocked)", () => {
  const result = parseReviewOutcome("for: HYK-133\nverdict: rejected\n");
  assert.equal(result.ok, true);
  assert.equal(result.doneAt, null);
});

test("(1d) parseReviewOutcome: two DONE lines (ambiguous) -> doneAt is null, not a silently-chosen one", () => {
  const result = parseReviewOutcome(
    "for: HYK-133\nverdict: rejected\n\n>>> DONE: A @ 2026-08-05 09:00 KST\n>>> DONE: B @ 2026-08-05 09:10 KST\n",
  );
  assert.equal(result.ok, true);
  assert.equal(result.doneAt, null);
});

test("(3) parseReviewOutcome: neither 'for:' nor 'task_id:' -> ok:false", () => {
  const result = parseReviewOutcome("verdict: rejected\n");
  assert.equal(result.ok, false);
});

test("(4) parseReviewOutcome: task id not HYK-shaped -> ok:false", () => {
  const result = parseReviewOutcome("for: NOTANID\nverdict: rejected\n");
  assert.equal(result.ok, false);
});

test("(5) parseReviewOutcome: missing verdict line -> ok:false", () => {
  const result = parseReviewOutcome("for: HYK-133-coder-2\n");
  assert.equal(result.ok, false);
});

test("(6) parseReviewOutcome: verdict is case-insensitive, normalized lowercase", () => {
  const result = parseReviewOutcome(
    "for: HYK-133-coder-2\nverdict: APPROVED\n",
  );
  assert.equal(result.ok, true);
  assert.equal(result.verdict, "approved");
});

test("(7) parseReviewOutcome: verdict value outside approved/rejected -> ok:false", () => {
  const result = parseReviewOutcome("for: HYK-133-coder-2\nverdict: maybe\n");
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// applyOutcome / computeRecord
// ---------------------------------------------------------------------------

test("(8) applyOutcome: rejected on empty ledger -> streak=1", () => {
  const ledger = applyOutcome(
    { schema_version: 1, issues: {} },
    {
      issueId: "HYK-133",
      taskId: "HYK-133-coder-1",
      verdict: "rejected",
      at: "t1",
    },
  );
  assert.equal(ledger.issues["HYK-133"].streak, 1);
  assert.deepEqual(ledger.issues["HYK-133"].history, [
    { task_id: "HYK-133-coder-1", verdict: "rejected", at: "t1" },
  ]);
});

test("(9) applyOutcome: two consecutive rejected -> streak=2, history length 2", () => {
  let ledger = { schema_version: 1, issues: {} };
  ledger = applyOutcome(ledger, {
    issueId: "HYK-133",
    taskId: "HYK-133-coder-1",
    verdict: "rejected",
    at: "t1",
  });
  ledger = applyOutcome(ledger, {
    issueId: "HYK-133",
    taskId: "HYK-133-coder-2",
    verdict: "rejected",
    at: "t2",
  });
  assert.equal(ledger.issues["HYK-133"].streak, 2);
  assert.equal(ledger.issues["HYK-133"].history.length, 2);
});

test("(10) applyOutcome: approved resets streak to 0 but keeps history", () => {
  let ledger = { schema_version: 1, issues: {} };
  ledger = applyOutcome(ledger, {
    issueId: "HYK-133",
    taskId: "HYK-133-coder-1",
    verdict: "rejected",
    at: "t1",
  });
  ledger = applyOutcome(ledger, {
    issueId: "HYK-133",
    taskId: "HYK-133-coder-2",
    verdict: "rejected",
    at: "t2",
  });
  ledger = applyOutcome(ledger, {
    issueId: "HYK-133",
    taskId: "HYK-133-coder-3",
    verdict: "approved",
    at: "t3",
  });
  assert.equal(ledger.issues["HYK-133"].streak, 0);
  assert.equal(ledger.issues["HYK-133"].history.length, 3);
});

test("(11) applyOutcome: two issues tracked independently", () => {
  let ledger = { schema_version: 1, issues: {} };
  ledger = applyOutcome(ledger, {
    issueId: "HYK-129",
    taskId: "HYK-129-coder-1",
    verdict: "rejected",
    at: "t1",
  });
  ledger = applyOutcome(ledger, {
    issueId: "HYK-133",
    taskId: "HYK-133-coder-1",
    verdict: "rejected",
    at: "t2",
  });
  ledger = applyOutcome(ledger, {
    issueId: "HYK-129",
    taskId: "HYK-129-coder-2",
    verdict: "rejected",
    at: "t3",
  });
  assert.equal(ledger.issues["HYK-129"].streak, 2);
  assert.equal(ledger.issues["HYK-133"].streak, 1);
});

test("(12) computeRecord: composes parse + apply, returns resulting streak", () => {
  const result = computeRecord({
    reviewText: "for: HYK-133-coder-1\nverdict: rejected\n",
    ledger: { schema_version: 1, issues: {} },
    at: "t1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.issueId, "HYK-133");
  assert.equal(result.streak, 1);
});

test("(13) computeRecord: malformed review text -> ok:false, no ledger mutation attempted", () => {
  const result = computeRecord({
    reviewText: "nothing useful here\n",
    ledger: { schema_version: 1, issues: {} },
    at: "t1",
  });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// HYK-183 §2-1 R3: computeRecord idempotency -- the identification criterion
// is "same task_id + same verdict as the issue's LAST recorded history
// entry". These are functional unit tests of that criterion in isolation
// (the auto-wiring's own mkdtemp-worktree tests live in
// reject-streak-auto-record.test.mjs); no CLI process needed here.
// ---------------------------------------------------------------------------

test("(13b) computeRecord: identical (task_id, verdict) recorded twice in a row -> second call is a no-op duplicate, streak/history unchanged", () => {
  const first = computeRecord({
    reviewText: "for: HYK-183-review-1\nverdict: rejected\n",
    ledger: { schema_version: 1, issues: {} },
    at: "t1",
  });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.streak, 1);

  const second = computeRecord({
    reviewText: "for: HYK-183-review-1\nverdict: rejected\n",
    ledger: first.ledger,
    at: "t2",
  });
  assert.equal(second.ok, true);
  assert.equal(
    second.duplicate,
    true,
    "same task_id+verdict as the last entry must be recognized as a duplicate",
  );
  assert.equal(second.streak, 1, "streak must not double-count the repeat");
  assert.equal(
    second.ledger.issues["HYK-183"].history.length,
    1,
    "history must not gain a second entry for the repeat",
  );
});

test("(13c) computeRecord: same review text recorded THREE times -> streak stays 1 across all repeats, not 2 or 3", () => {
  let ledger = { schema_version: 1, issues: {} };
  const reviewText = "for: HYK-183-review-1\nverdict: rejected\n";
  for (let i = 0; i < 3; i++) {
    const result = computeRecord({ reviewText, ledger, at: `t${i}` });
    assert.equal(result.ok, true);
    assert.equal(result.streak, 1, `call #${i + 1} must keep streak at 1`);
    ledger = result.ledger;
  }
  assert.equal(ledger.issues["HYK-183"].history.length, 1);
});

test("(13d) computeRecord: a genuinely NEW round (different task_id, same verdict) is never mistaken for a duplicate -- two real consecutive rejects still count as streak=2", () => {
  const first = computeRecord({
    reviewText: "for: HYK-183-review-1\nverdict: rejected\n",
    ledger: { schema_version: 1, issues: {} },
    at: "t1",
  });
  const second = computeRecord({
    reviewText: "for: HYK-183-review-2\nverdict: rejected\n",
    ledger: first.ledger,
    at: "t2",
  });
  assert.equal(second.duplicate, false);
  assert.equal(second.streak, 2);
  assert.equal(second.ledger.issues["HYK-183"].history.length, 2);
});

// ---------------------------------------------------------------------------
// HYK-183-ledger-fix §3(a)/REVIEW 2R P2-1: 실물 재현 -- 문자열로 사건을
// 재구성하는 대신, **보존된 원장 표본 파일을 실제로 읽어** 그 안에 실제로
// 남아 있는 기록 2건(HYK-186·HYK-183의 2026-08-05 09:34 반려)과 누락 3건
// (그 뒤로도 streak가 1에 머무는 것으로 드러나는, 승인이 기록되지 않은
// 사실)을 시험 입력의 시작 상태로 삼는다. 파일이 없으면 이 시험은 (skip이
// 아니라) 실패해야 한다 -- 이 표본이 이 조각의 근거이므로, `readFileSync`를
// 어떤 존재-검사로도 감싸지 않는다: 파일이 없으면 여기서 그대로 던져
// 시험이 RED로 떨어진다. ⚠️ 이 파일은 읽기 전용으로만 다룬다(절대 쓰지
// 않는다) -- `computeRecord`/`applyOutcome`은 순수 함수라 입력 ledger
// 객체를 변형하지 않으므로 이 시험도 원본 JS 객체를 건드리지 않지만,
// 애초에 파일 자체에 대한 쓰기 연산이 이 시험에는 없다.
//
// HYK-183-ledger-fix 5R (PR #105 리눅스 CI ENOENT, 원인 확정 = ORCH·통역
// 계약 오류): 이 표본은 원래 저장소 밖 하네스-관제실 아카이브의 로컬
// Windows 드라이브 경로(파일명 `2026-08-05-원장-결함표본-reject-streak.json`)를
// 가리켰다 -- 리눅스 CI에는 그 경로 자체가 존재할 수 없으므로 매번
// ENOENT였다. 표본을 이 저장소 안 `reject-streak-defect-sample.json`으로
// 그대로(내용 무변경, SHA-256 대조로 바이트 동일 확인) 복사해 두고 그
// fixture를 읽도록 바꿨다 -- 출처: 위 하네스-관제실 아카이브, 채취 시각:
// 2026-08-05(ORCH가 사고 당시 원장 스냅샷을 보존한 시점). 이제 저장소
// 상대경로만 참조하므로 OS 무관하게 존재한다.
// ---------------------------------------------------------------------------

const ARCHIVED_LEDGER_DEFECT_SAMPLE_PATH = fileURLToPath(
  new URL("./reject-streak-defect-sample.json", import.meta.url),
);

test("(13f) HYK-183-ledger-fix §3(a) 실물 재현: 보존된 원장 결함표본을 실제로 읽어, 기록 2건(HYK-186·HYK-183 09:34 반려)이 누락 3건(streak가 1에 머무는 것으로 실측)을 낳은 그 상태에서 이어지는 라운드가 올바르게 처리됨을 증명한다", () => {
  // 존재-검사 없이 그대로 읽는다 -- 파일 부재는 skip이 아니라 실패다.
  const archivedRaw = readFileSync(ARCHIVED_LEDGER_DEFECT_SAMPLE_PATH, "utf8");
  const archivedLedger = JSON.parse(archivedRaw);

  // 표본 자체가 문서(§1 축 A/B)가 적은 그대로인지 먼저 실측 확인한다.
  const hyk186 = archivedLedger.issues["HYK-186"];
  const hyk183 = archivedLedger.issues["HYK-183"];
  assert.ok(hyk186, "표본에 HYK-186 항목이 있어야 한다");
  assert.ok(hyk183, "표본에 HYK-183 항목이 있어야 한다");
  const hyk186Last = hyk186.history[hyk186.history.length - 1];
  const hyk183Last = hyk183.history[hyk183.history.length - 1];
  assert.equal(hyk186Last.verdict, "rejected");
  assert.equal(hyk186Last.at, "2026-08-05 09:34 KST");
  assert.equal(hyk183Last.verdict, "rejected");
  assert.equal(hyk183Last.at, "2026-08-05 09:34 KST");
  assert.equal(
    hyk186.streak,
    1,
    "누락 3건의 실측 흔적: 반려 뒤 승인이 원장에 기록되지 않아 streak가 여전히 1이다",
  );

  // 축 A: 표본을 그대로 시작 상태로 삼아, HYK-186에 대한 "다른"(같은 bare
  // task_id, 다른 done_at) 반려 라운드가 이어져도 duplicate로 눌리지 않아야
  // 한다 -- 수리 전 코드(done_at 없이 task_id+verdict만 비교)로는 표본의
  // 09:34 반려와 이 새 반려가 동일 키로 충돌해 duplicate:true·streak:1로
  // 눌렸다(`hyk183-ledger-fix-mutation.test.mjs`의 축A 변이 시험이 이
  // 수리 전 동작을 RED로 별도 고정한다).
  const nextReject =
    "for: HYK-186\ntask_id: HYK-186\nverdict: rejected\nrole: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ 2026-08-05 11:02 KST\n";
  const afterReject = computeRecord({
    reviewText: nextReject,
    ledger: archivedLedger,
    at: "t1",
  });
  assert.equal(
    afterReject.duplicate,
    false,
    "표본의 09:34 반려와 다른 done_at을 가진 새 반려는 재확인이 아니라 진짜 새 라운드다",
  );
  assert.equal(
    afterReject.streak,
    2,
    "게이트 2의 근거인 연속 반려 카운트가 눌리지 않아야 한다",
  );

  // 축 B(원장 전이 자체): 같은 표본을 시작 상태로, "누락됐던 승인"이
  // 뒤늦게라도 들어오면 streak가 정상적으로 0으로 되돌아간다 -- 실제
  // commit-msg 훅 결선을 통한 E2E는 review-gate-auto-record.test.mjs (b)가
  // 별도로 증명한다; 여기서는 표본을 시작 상태로 한 원장 전이 자체를
  // 고정한다.
  const lateApproval =
    "for: HYK-186\ntask_id: HYK-186\nverdict: approved\nrole: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ 2026-08-05 13:00 KST\n";
  const afterApproval = computeRecord({
    reviewText: lateApproval,
    ledger: archivedLedger,
    at: "t2",
  });
  assert.equal(
    afterApproval.streak,
    0,
    "뒤늦게라도 기록된 승인은 streak를 0으로 되돌려야 한다",
  );

  // 순수성 확인: 두 "what-if" 분기가 서로 다른 시작 객체를 공유했으므로,
  // 원본 archivedLedger 자체(및 그 배열/객체)가 변형되지 않았는지 확인한다.
  assert.equal(
    archivedLedger.issues["HYK-186"].streak,
    1,
    "computeRecord는 순수 함수여야 한다 -- 입력 ledger를 제자리에서 바꾸면 안 된다",
  );
});

test("(13g) HYK-183-ledger-fix 축A: 같은 파일을 다시 확인하는 진짜 재시도(done_at 동일)는 여전히 1회만 기록된다 -- 축A 수리가 멱등성 자체를 없애지 않았음을 고정", () => {
  const reviewText =
    "for: HYK-186\ntask_id: HYK-186\nverdict: rejected\nrole: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ 2026-08-05 09:34 KST\n";
  const first = computeRecord({
    reviewText,
    ledger: { schema_version: 1, issues: {} },
    at: "t1",
  });
  const retry = computeRecord({
    reviewText,
    ledger: first.ledger,
    at: "t2",
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.streak, 1);
  assert.equal(retry.ledger.issues["HYK-186"].history.length, 1);
});

test("(13h) HYK-183-ledger-fix 축A: done_at이 양쪽 다 없을 때는(레거시/구형 결과 파일) 예전 동작(task_id+verdict만 비교)으로 되돌아간다", () => {
  const reviewText = "for: HYK-186\ntask_id: HYK-186\nverdict: rejected\n";
  const first = computeRecord({
    reviewText,
    ledger: { schema_version: 1, issues: {} },
    at: "t1",
  });
  const retry = computeRecord({
    reviewText,
    ledger: first.ledger,
    at: "t2",
  });
  assert.equal(
    retry.duplicate,
    true,
    "DONE 줄이 없는 입력에 대해서도 재시도 억제(멱등성)는 계속 동작해야 한다",
  );
});

test("(13e) computeRecord: duplicate call preserves the ORIGINAL (unmutated) ledger reference in its result", () => {
  const first = computeRecord({
    reviewText: "for: HYK-183-review-1\nverdict: rejected\n",
    ledger: { schema_version: 1, issues: {} },
    at: "t1",
  });
  const second = computeRecord({
    reviewText: "for: HYK-183-review-1\nverdict: rejected\n",
    ledger: first.ledger,
    at: "t2",
  });
  assert.equal(
    second.ledger,
    first.ledger,
    "a duplicate must return the SAME ledger object, not a fresh copy that only looks equal (proves writeLedger would be a true no-op if called)",
  );
});

// ---------------------------------------------------------------------------
// loadLedger / writeLedger
// ---------------------------------------------------------------------------

test("(14) loadLedger: missing file -> ok:true, existed:false, empty issues (streak 0 baseline)", () => {
  withFixtureDir((dir) => {
    const result = loadLedger(join(dir, "reject-streak.json"));
    assert.equal(result.ok, true);
    assert.equal(result.existed, false);
    assert.deepEqual(result.ledger.issues, {});
  });
});

test("(15) loadLedger: valid JSON -> ok:true, existed:true", () => {
  withFixtureDir((dir) => {
    const p = join(dir, "reject-streak.json");
    writeFileSync(
      p,
      JSON.stringify({
        schema_version: 1,
        issues: { "HYK-1": { streak: 3, history: [] } },
      }),
      "utf8",
    );
    const result = loadLedger(p);
    assert.equal(result.ok, true);
    assert.equal(result.ledger.issues["HYK-1"].streak, 3);
  });
});

test("(16) loadLedger: invalid JSON -> ok:false (UNJUDGABLE reason)", () => {
  withFixtureDir((dir) => {
    const p = join(dir, "reject-streak.json");
    writeFileSync(p, "{ not valid json", "utf8");
    const result = loadLedger(p);
    assert.equal(result.ok, false);
    assert.match(result.reason, /UNJUDGABLE/);
  });
});

test("(17) loadLedger: valid JSON but missing 'issues' object -> ok:false (UNJUDGABLE)", () => {
  withFixtureDir((dir) => {
    const p = join(dir, "reject-streak.json");
    writeFileSync(p, JSON.stringify({ schema_version: 1 }), "utf8");
    const result = loadLedger(p);
    assert.equal(result.ok, false);
  });
});

test("(18) writeLedger + loadLedger round-trip", () => {
  withFixtureDir((dir) => {
    const p = join(dir, "reject-streak.json");
    const ledger = {
      schema_version: 1,
      issues: {
        "HYK-9": {
          streak: 1,
          history: [{ task_id: "HYK-9-coder-1", verdict: "rejected", at: "t" }],
        },
      },
    };
    writeLedger(p, ledger);
    const reloaded = loadLedger(p);
    assert.equal(reloaded.ok, true);
    assert.deepEqual(reloaded.ledger, ledger);
  });
});

// ---------------------------------------------------------------------------
// checkEnvelope
// ---------------------------------------------------------------------------

test("(19) checkEnvelope: complete envelope -> ok:true", () => {
  const result = checkEnvelope(`# task\n\n${COMPLETE_ENVELOPE}\n`);
  assert.equal(result.ok, true);
});

test("(20) checkEnvelope: no envelope block at all -> ok:false", () => {
  const result = checkEnvelope("# task\n\nno envelope here.\n");
  assert.equal(result.ok, false);
});

test("(21) checkEnvelope: cause only, no ORCH 조치 header -> ok:false (ⓑ)", () => {
  const text = [
    "<!-- reject-streak-envelope",
    "원인 분류: 모델 한계",
    "-->",
  ].join("\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /ORCH 조치/);
});

test("(22) checkEnvelope: ORCH 조치 only, no cause -> ok:false (ⓑ)", () => {
  const text = [
    "<!-- reject-streak-envelope",
    "ORCH 조치:",
    "- 모델 변경: opus로",
    "-->",
  ].join("\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /원인 분류/);
});

test("(23) checkEnvelope: cause value not in allowed set -> ok:false", () => {
  const text = [
    "<!-- reject-streak-envelope",
    "원인 분류: 그냥 운이 나빴음",
    "ORCH 조치:",
    "- 모델 변경: x",
    "-->",
  ].join("\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, false);
});

test("(24) checkEnvelope: ORCH 조치 header present but zero bullets -> ok:false", () => {
  const text = [
    "<!-- reject-streak-envelope",
    "원인 분류: 설계 결함",
    "ORCH 조치:",
    "",
    "-->",
  ].join("\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, false);
});

test("(25) checkEnvelope: ORCH 조치 bullet with unrecognized label -> ok:false", () => {
  const text = [
    "<!-- reject-streak-envelope",
    "원인 분류: 설계 결함",
    "ORCH 조치:",
    "- 그냥 다시 시도: x",
    "-->",
  ].join("\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, false);
});

test("(26) checkEnvelope: all four allowed causes accepted", () => {
  for (const cause of ALLOWED_CAUSES) {
    const text = [
      "<!-- reject-streak-envelope",
      `원인 분류: ${cause}`,
      "ORCH 조치:",
      "- 재설계 지시: x",
      "-->",
    ].join("\n");
    assert.equal(
      checkEnvelope(text).ok,
      true,
      `cause '${cause}' should be accepted`,
    );
  }
});

test("(27) checkEnvelope: all five allowed action labels accepted individually", () => {
  for (const action of ALLOWED_ACTIONS) {
    const text = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "ORCH 조치:",
      `- ${action}: x`,
      "-->",
    ].join("\n");
    assert.equal(
      checkEnvelope(text).ok,
      true,
      `action '${action}' should be accepted`,
    );
  }
});

test("(28) checkEnvelope: 리서치(출처 포함) label form (parenthetical) still accepted (format-only per S4)", () => {
  const text = [
    "<!-- reject-streak-envelope",
    "원인 분류: 모델 한계",
    "ORCH 조치:",
    "- 리서치(출처 포함): https://example.com 참고",
    "-->",
  ].join("\n");
  assert.equal(checkEnvelope(text).ok, true);
});

test("(28b) checkEnvelope: CRLF-terminated envelope block still parses (Windows-authored doc/task file, review-1 root-cause repro)", () => {
  const text = [
    "<!-- reject-streak-envelope",
    "원인 분류: 모델 한계",
    "ORCH 조치:",
    "- 모델 변경: x",
    "-->",
  ].join("\r\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, true, result.reason);
});

test("(29) checkEnvelope: multiple ORCH 조치 bullets, only one needs to match", () => {
  const text = [
    "<!-- reject-streak-envelope",
    "원인 분류: 환경 차이",
    "ORCH 조치:",
    "- 뭔가 애매한 줄",
    "- 디스코프 제안: 이 태스크는 범위 밖으로",
    "-->",
  ].join("\n");
  assert.equal(checkEnvelope(text).ok, true);
});

// ---------------------------------------------------------------------------
// checkGate (R1-R3 known-bad/good matrix)
// ---------------------------------------------------------------------------

test("(30) ⓓ checkGate: streak=1 (no envelope) -> PASS", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-133": { streak: 1, history: [] } },
  };
  const result = checkGate({ taskText: "task_id: HYK-133-coder-2\n", ledger });
  assert.equal(result.status, "PASS");
});

test("(31) ⓐ checkGate: streak=2, no envelope -> BLOCK", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-133": { streak: 2, history: [] } },
  };
  const result = checkGate({ taskText: "task_id: HYK-133-coder-3\n", ledger });
  assert.equal(result.status, "BLOCK");
});

test("(32) ⓑ checkGate: streak=2, envelope with cause only -> BLOCK", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-133": { streak: 2, history: [] } },
  };
  const text =
    "task_id: HYK-133-coder-3\n<!-- reject-streak-envelope\n원인 분류: 모델 한계\n-->";
  const result = checkGate({ taskText: text, ledger });
  assert.equal(result.status, "BLOCK");
});

test("(32b) ⓑ checkGate: streak=2, envelope with ORCH 조치 only -> BLOCK", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-133": { streak: 2, history: [] } },
  };
  const text =
    "task_id: HYK-133-coder-3\n<!-- reject-streak-envelope\nORCH 조치:\n- 모델 변경: x\n-->";
  const result = checkGate({ taskText: text, ledger });
  assert.equal(result.status, "BLOCK");
});

test("(33) ⓒ checkGate: streak=2, complete envelope -> PASS", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-133": { streak: 2, history: [] } },
  };
  const text = `task_id: HYK-133-coder-3\n${COMPLETE_ENVELOPE}\n`;
  const result = checkGate({ taskText: text, ledger });
  assert.equal(result.status, "PASS");
});

test("(34) ⓔ checkGate: streak=0 (post-reset) -> PASS without envelope", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-133": { streak: 0, history: [] } },
  };
  const result = checkGate({ taskText: "task_id: HYK-133-coder-4\n", ledger });
  assert.equal(result.status, "PASS");
});

test("(35) checkGate: issue absent from ledger entirely -> treated as streak 0 -> PASS", () => {
  const ledger = { schema_version: 1, issues: {} };
  const result = checkGate({ taskText: "task_id: HYK-999-coder-1\n", ledger });
  assert.equal(result.status, "PASS");
});

test("(36) checkGate: streak=4 (deep ladder) still governed by the same envelope rule -> PASS with complete envelope", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-133": { streak: 4, history: [] } },
  };
  const text = `task_id: HYK-133-coder-5\n${COMPLETE_ENVELOPE}\n`;
  const result = checkGate({ taskText: text, ledger });
  assert.equal(result.status, "PASS");
});

test("(37) checkGate: task file with no task_id header -> UNJUDGABLE, fail-open", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-133": { streak: 5, history: [] } },
  };
  const result = checkGate({ taskText: "no header here\n", ledger });
  assert.equal(result.status, "UNJUDGABLE");
  assert.equal(result.ok, true);
});

test("(38) checkGate: task_id not HYK-shaped -> UNJUDGABLE, fail-open", () => {
  const ledger = { schema_version: 1, issues: {} };
  const result = checkGate({ taskText: "task_id: WEIRD-1\n", ledger });
  assert.equal(result.status, "UNJUDGABLE");
});

// ---------------------------------------------------------------------------
// formatNowLocal
// ---------------------------------------------------------------------------

test("(39) formatNowLocal: shape 'YYYY-MM-DD HH:MM KST'", () => {
  const s = formatNowLocal(new Date(2026, 6, 13, 9, 5));
  assert.equal(s, "2026-07-13 09:05 KST");
});

// ---------------------------------------------------------------------------
// CLI end-to-end
// ---------------------------------------------------------------------------

test("(40) CLI record: rejected review -> ledger written with streak=1", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(
      reviewPath,
      "for: HYK-133-coder-1\nverdict: rejected\n",
      "utf8",
    );
    const { status, stdout } = runCli([
      "record",
      "--review",
      reviewPath,
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /streak=1/);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(ledger.issues["HYK-133"].streak, 1);
  });
});

test("(41) CLI record: ledger survives across two separate invocations (relay-slot-overwrite simulation)", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const ledgerPath = join(dir, "reject-streak.json");

    writeFileSync(
      reviewPath,
      "for: HYK-133-coder-1\nverdict: rejected\n",
      "utf8",
    );
    runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);

    // Simulate the relay slot being overwritten by the next round's review.
    writeFileSync(
      reviewPath,
      "for: HYK-133-coder-2\nverdict: rejected\n",
      "utf8",
    );
    const { status, stdout } = runCli([
      "record",
      "--review",
      reviewPath,
      "--ledger",
      ledgerPath,
    ]);

    assert.equal(status, 0);
    assert.match(stdout, /streak=2/);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(ledger.issues["HYK-133"].streak, 2);
    assert.equal(ledger.issues["HYK-133"].history.length, 2);
  });
});

test("(41b) CLI record: same review.md re-run twice (identical content, e.g. re-invoked auto-wiring) -> second run reports DUPLICATE, streak/history unchanged on disk", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const ledgerPath = join(dir, "reject-streak.json");

    writeFileSync(
      reviewPath,
      "for: HYK-133-coder-1\nverdict: rejected\n",
      "utf8",
    );
    const first = runCli([
      "record",
      "--review",
      reviewPath,
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(first.status, 0);
    assert.match(first.stdout, /streak=1/);
    const afterFirst = readFileSync(ledgerPath, "utf8");

    const second = runCli([
      "record",
      "--review",
      reviewPath,
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(second.status, 0);
    assert.match(
      second.stdout,
      /DUPLICATE/,
      "a repeat record of the exact same round must be visibly reported as a duplicate, not silently re-recorded",
    );
    const afterSecond = readFileSync(ledgerPath, "utf8");
    assert.equal(
      afterSecond,
      afterFirst,
      "the ledger FILE on disk must be byte-identical after the duplicate call (writeLedger must not even be invoked)",
    );
    const ledger = JSON.parse(afterSecond);
    assert.equal(ledger.issues["HYK-133"].streak, 1);
    assert.equal(ledger.issues["HYK-133"].history.length, 1);
  });
});

test("(42) CLI record: review file missing -> UNJUDGABLE, exit 0, no ledger file created", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const ledgerPath = join(dir, "reject-streak.json");
    const { status, stdout } = runCli([
      "record",
      "--review",
      reviewPath,
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /UNJUDGABLE/);
    assert.equal(existsSync(ledgerPath), false);
  });
});

test("(43) CLI record: malformed review content -> UNJUDGABLE, exit 0, ledger untouched", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(reviewPath, "no useful fields\n", "utf8");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 1,
        issues: { "HYK-1": { streak: 9, history: [] } },
      }),
      "utf8",
    );
    const before = readFileSync(ledgerPath, "utf8");
    const { status, stdout } = runCli([
      "record",
      "--review",
      reviewPath,
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /UNJUDGABLE/);
    assert.equal(readFileSync(ledgerPath, "utf8"), before);
  });
});

test("(44) CLI gate: ⓐ streak=2, no envelope -> exit 2", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(taskPath, "task_id: HYK-133-coder-3\n", "utf8");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 1,
        issues: { "HYK-133": { streak: 2, history: [] } },
      }),
      "utf8",
    );
    const { status, stderr } = runCli([
      "gate",
      taskPath,
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(status, 2);
    assert.match(stderr, /reject-streak gate/);
  });
});

test("(45) CLI gate: ⓒ streak=2, complete envelope -> exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(
      taskPath,
      `task_id: HYK-133-coder-3\n${COMPLETE_ENVELOPE}\n`,
      "utf8",
    );
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 1,
        issues: { "HYK-133": { streak: 2, history: [] } },
      }),
      "utf8",
    );
    const { status } = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(status, 0);
  });
});

test("(46) CLI gate: ⓓ streak=1, no envelope -> exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(taskPath, "task_id: HYK-133-coder-2\n", "utf8");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 1,
        issues: { "HYK-133": { streak: 1, history: [] } },
      }),
      "utf8",
    );
    const { status } = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(status, 0);
  });
});

test("(47) CLI gate: ⓔ approved reset then re-drop with no envelope -> exit 0", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");

    writeFileSync(
      reviewPath,
      "for: HYK-133-coder-1\nverdict: rejected\n",
      "utf8",
    );
    runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);
    writeFileSync(
      reviewPath,
      "for: HYK-133-coder-2\nverdict: rejected\n",
      "utf8",
    );
    runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);
    writeFileSync(
      reviewPath,
      "for: HYK-133-coder-3\nverdict: approved\n",
      "utf8",
    );
    runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);

    writeFileSync(taskPath, "task_id: HYK-133-coder-4\n", "utf8");
    const { status } = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(status, 0);
  });
});

test("(48) CLI gate: ⓕ ledger file corrupted -> UNJUDGABLE, exit 0 (fail-open, not silently PASS-as-streak-0)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(taskPath, "task_id: HYK-133-coder-3\n", "utf8");
    writeFileSync(ledgerPath, "{ broken", "utf8");
    const { status, stdout } = runCli([
      "gate",
      taskPath,
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /UNJUDGABLE/);
  });
});

test("(49) CLI gate: no ledger file at all -> streak 0 baseline -> exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(taskPath, "task_id: HYK-133-coder-1\n", "utf8");
    const { status } = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(status, 0);
    assert.equal(
      existsSync(ledgerPath),
      false,
      "gate must never create/write the ledger",
    );
  });
});

test("(50) CLI gate: missing task file -> exit 1 (operator error, not a judgment)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "does-not-exist.md");
    const { status } = runCli(["gate", taskPath]);
    assert.equal(status, 1);
  });
});

test("(51) CLI: no subcommand -> usage, exit 1", () => {
  const { status } = runCli([]);
  assert.equal(status, 1);
});

// ---------------------------------------------------------------------------
// Doc-code contract (review-1, HYK-133-coder-1 repro guard): enforcement-v1.md
// §G's envelope template must itself pass the real gate parser verbatim, so
// a future edit that touches the doc's prose without keeping the worked
// example real-valued is caught mechanically, not by a reviewer noticing by
// hand the way review-1 had to.
// ---------------------------------------------------------------------------

function extractEnvelopeTemplateFromDocs() {
  const docPath = fileURLToPath(
    new URL("../../docs/enforcement-v1.md", import.meta.url),
  );
  const text = readFileSync(docPath, "utf8");
  const m = text.match(
    /```\r?\n(<!--\s*reject-streak-envelope[\s\S]*?-->)\r?\n```/,
  );
  if (!m)
    throw new Error(
      "could not find a fenced reject-streak-envelope template block in docs/enforcement-v1.md",
    );
  return m[1];
}

test("(53) doc-code contract: enforcement-v1.md §G envelope template passes checkEnvelope verbatim", () => {
  const block = extractEnvelopeTemplateFromDocs();
  const result = checkEnvelope(block);
  assert.equal(result.ok, true, result.reason);
});

test("(54) doc-code contract: the doc's template also clears the full gate at streak>=2 with no edits", () => {
  const block = extractEnvelopeTemplateFromDocs();
  const ledger = {
    schema_version: 1,
    issues: { "HYK-1": { streak: 3, history: [] } },
  };
  const result = checkGate({
    taskText: `task_id: HYK-1-coder-9\n${block}\n`,
    ledger,
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(55) sanity: an un-substituted '<...>' placeholder cause is still rejected (the exact review-1 repro shape, kept as a permanent regression guard)", () => {
  const text = [
    "<!-- reject-streak-envelope",
    "원인 분류: <스펙 오류(ORCH) | 모델 한계 | 환경 차이 | 설계 결함 중 하나>",
    "ORCH 조치:",
    "- <분류>: <내용>",
    "-->",
  ].join("\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, false);
});

test("(52) end-to-end: record 2 rejects then gate without envelope blocks the real ⓐ scenario", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");

    writeFileSync(
      reviewPath,
      "for: HYK-133-coder-1\ntask_id: HYK-133-review-1\nrole: REVIEW-CODEX\nverdict: rejected\n",
      "utf8",
    );
    runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);
    writeFileSync(
      reviewPath,
      "for: HYK-133-coder-2\ntask_id: HYK-133-review-2\nrole: REVIEW-CODEX\nverdict: rejected\n",
      "utf8",
    );
    runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);

    writeFileSync(
      taskPath,
      "task_id: HYK-133-coder-3\ndropped_at: 2026-07-13 18:00 KST\n\nno envelope in this drop\n",
      "utf8",
    );
    const blocked = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(blocked.status, 2);

    writeFileSync(
      taskPath,
      `task_id: HYK-133-coder-3\ndropped_at: 2026-07-13 18:05 KST\n\n${COMPLETE_ENVELOPE}\n`,
      "utf8",
    );
    const passed = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(passed.status, 0);
  });
});

// ---------------------------------------------------------------------------
// HYK-158: hard-stop diagnostic envelope (checkDiagnosticEnvelope/checkDiagnosticGate)
// ---------------------------------------------------------------------------

test("(56) HARD_STOP_STREAK is fixed at 4 (ladder step 4, promoted from convention)", () => {
  assert.equal(HARD_STOP_STREAK, 4);
});

test("(57) checkDiagnosticEnvelope: complete envelope (cause+evidence pointer+action) -> ok:true", () => {
  const result = checkDiagnosticEnvelope(
    `# task\n\n${COMPLETE_DIAGNOSTIC_ENVELOPE}\n`,
  );
  assert.equal(result.ok, true, result.reason);
});

test("(58) known-bad: no envelope at all -> DIAGNOSTIC_REQUIRED", () => {
  const result = checkDiagnosticEnvelope("# task\n\nno envelope here.\n");
  assert.equal(result.ok, false);
  assert.match(result.reason, /^DIAGNOSTIC_REQUIRED/);
});

test("(59) known-bad: envelope present but missing the new 재현 증거 포인터 field (HYK-133 envelope reused as-is) -> DIAGNOSTIC_FIELD_MISSING", () => {
  const result = checkDiagnosticEnvelope(`# task\n\n${COMPLETE_ENVELOPE}\n`);
  assert.equal(result.ok, false);
  assert.match(result.reason, /^DIAGNOSTIC_FIELD_MISSING/);
  assert.match(result.reason, /재현 증거 포인터/);
});

test("(60) paired good: same envelope, only 재현 증거 포인터 field added -> passes", () => {
  const bad = checkDiagnosticEnvelope(`# task\n\n${COMPLETE_ENVELOPE}\n`);
  assert.equal(bad.ok, false);
  const good = checkDiagnosticEnvelope(
    `# task\n\n${COMPLETE_DIAGNOSTIC_ENVELOPE}\n`,
  );
  assert.equal(good.ok, true, good.reason);
});

test("(61) known-bad: envelope missing 원인 분류 (evidence+action present) -> DIAGNOSTIC_FIELD_MISSING names 원인 분류", () => {
  const text = [
    "<!-- reject-streak-envelope",
    "재현 증거 포인터: review-3.md L12",
    "ORCH 조치:",
    "- 리서치: 사전 사례 조사",
    "-->",
  ].join("\n");
  const result = checkDiagnosticEnvelope(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /원인 분류/);
});

test("(62) known-bad: envelope missing ORCH 조치 header -> DIAGNOSTIC_FIELD_MISSING names ORCH 조치", () => {
  const text = [
    "<!-- reject-streak-envelope",
    "원인 분류: 환경 차이",
    "재현 증거 포인터: review-3.md L12",
    "-->",
  ].join("\n");
  const result = checkDiagnosticEnvelope(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /ORCH 조치/);
});

test("(63) checkDiagnosticGate: streak=3 (<HARD_STOP_STREAK) -> PASS even with no envelope at all", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-158": { streak: 3, history: [] } },
  };
  const result = checkDiagnosticGate({
    taskText: "task_id: HYK-158-coder-4\n",
    ledger,
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(64) known-bad: checkDiagnosticGate streak=4 (hard-stop), no envelope -> BLOCK with DIAGNOSTIC_REQUIRED", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-158": { streak: 4, history: [] } },
  };
  const result = checkDiagnosticGate({
    taskText: "task_id: HYK-158-coder-5\n",
    ledger,
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /DIAGNOSTIC_REQUIRED/);
});

test("(65) known-bad: checkDiagnosticGate streak=4, envelope missing evidence pointer -> BLOCK with DIAGNOSTIC_FIELD_MISSING", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-158": { streak: 4, history: [] } },
  };
  const result = checkDiagnosticGate({
    taskText: `task_id: HYK-158-coder-5\n${COMPLETE_ENVELOPE}\n`,
    ledger,
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /DIAGNOSTIC_FIELD_MISSING/);
});

test("(66) paired good: same ledger+task, evidence pointer field alone added -> PASS", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-158": { streak: 4, history: [] } },
  };
  const bad = checkDiagnosticGate({
    taskText: `task_id: HYK-158-coder-5\n${COMPLETE_ENVELOPE}\n`,
    ledger,
  });
  assert.equal(bad.status, "BLOCK");
  const good = checkDiagnosticGate({
    taskText: `task_id: HYK-158-coder-5\n${COMPLETE_DIAGNOSTIC_ENVELOPE}\n`,
    ledger,
  });
  assert.equal(good.status, "PASS", good.reason);
});

test("(67) streak beyond hard-stop (e.g. 6) still requires the diagnostic envelope", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-158": { streak: 6, history: [] } },
  };
  const result = checkDiagnosticGate({
    taskText: "task_id: HYK-158-coder-7\n",
    ledger,
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /DIAGNOSTIC_REQUIRED/);
});

test("(68) UNJUDGABLE: task file has no task_id header -> fail-open, never claims diagnosis complete", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-158": { streak: 5, history: [] } },
  };
  const result = checkDiagnosticGate({
    taskText: "no task_id header here\n",
    ledger,
  });
  assert.equal(result.status, "UNJUDGABLE");
  assert.equal(result.ok, true);
});

test("(69) ordinary checkGate (streak>=2) envelope is untouched/unbroken by the new diagnostic gate existing alongside it", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-133": { streak: 2, history: [] } },
  };
  const result = checkGate({
    taskText: `task_id: HYK-133-coder-9\n${COMPLETE_ENVELOPE}\n`,
    ledger,
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(70) CLI diagnostic-gate: end-to-end hard-stop scenario blocks then passes (single-variable fix)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    const ledger = {
      schema_version: 1,
      issues: { "HYK-158": { streak: 4, history: [] } },
    };
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");

    writeFileSync(
      taskPath,
      "task_id: HYK-158-coder-5\ndropped_at: 2026-07-18 16:00 KST\n\nno envelope in this drop\n",
      "utf8",
    );
    const blocked = runCli([
      "diagnostic-gate",
      taskPath,
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /DIAGNOSTIC_REQUIRED/);

    writeFileSync(
      taskPath,
      `task_id: HYK-158-coder-5\ndropped_at: 2026-07-18 16:05 KST\n\n${COMPLETE_DIAGNOSTIC_ENVELOPE}\n`,
      "utf8",
    );
    const passed = runCli([
      "diagnostic-gate",
      taskPath,
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(passed.status, 0);

    // forbidden side effect check: diagnostic-gate must never write the ledger
    const ledgerAfter = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.deepEqual(
      ledgerAfter,
      ledger,
      "diagnostic-gate must never mutate the ledger",
    );
  });
});

test("(71) CLI diagnostic-gate: corrupted ledger -> UNJUDGABLE, exit 0 (fail-open per existing contract)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(taskPath, "task_id: HYK-158-coder-9\n", "utf8");
    writeFileSync(ledgerPath, "{not valid json", "utf8");
    const { status, stdout } = runCli([
      "diagnostic-gate",
      taskPath,
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /UNJUDGABLE/);
  });
});

// ---------------------------------------------------------------------------
// HYK-221 축3 (★실사고 재현 방지): the CLI's DEFAULT ledger path (no
// `--ledger` given) used to resolve via plain `repoRoot()`
// (`git rev-parse --show-toplevel`), which in a LINKED WORKTREE returns that
// worktree's own root -- a DIFFERENT answer than dispatch-gate-decision.mjs's
// `resolveRepoRoot` (`--git-common-dir`), which converges on the MAIN repo.
// A `record` run inside a worktree therefore wrote to a worktree-local
// ledger the gate would never read (HYK-219 1R: exactly this made a real
// rejection invisible to the 2-streak gate). Both build REAL git
// repos/worktrees under a tmpdir (never touch this repo's own .git).
// ---------------------------------------------------------------------------

function initGitRepo(dir) {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
}

function commitAll(dir, message) {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message]);
}

test("(72) HYK-221 축3 실증 -- 워크트리 안에서 record --review만(--ledger 생략) 실행하면 정본(main) 원장에 쓴다 -- 워크트리 로컬 원장 파일은 생성/변경되지 않는다", () => {
  withFixtureDir((dir) => {
    const mainDir = join(dir, "main");
    initGitRepo(mainDir);
    writeFileSync(join(mainDir, "README.md"), "x\n", "utf8");
    // .harness/reject-streak.json is committed so the linked worktree below
    // checks out its OWN copy of it (the realistic shape of the incident --
    // a worktree-local file with the SAME name genuinely exists).
    mkdirSync(join(mainDir, ".harness"));
    writeLedger(join(mainDir, ".harness", "reject-streak.json"), {
      schema_version: 1,
      issues: {},
    });
    commitAll(mainDir, "init");
    const wtDir = join(dir, "wt-axis3");
    execFileSync("git", [
      "-C",
      mainDir,
      "worktree",
      "add",
      "-q",
      "--detach",
      wtDir,
      "HEAD",
    ]);
    // Overwrite the worktree's checked-out copy with a distinguishable decoy
    // value -- a post-hoc read/write to THIS file (rather than main's) is
    // then unmistakable.
    const wtLedgerPath = join(wtDir, ".harness", "reject-streak.json");
    writeLedger(wtLedgerPath, {
      schema_version: 1,
      issues: { DECOY: { streak: 99, history: [] } },
    });
    const reviewPath = join(wtDir, ".harness", "review.md");
    writeFileSync(
      reviewPath,
      "task_id: HYK-9700-axis3-1\nverdict: rejected\n>>> DONE: REVIEW @ 2026-08-11 09:00 KST\n",
      "utf8",
    );
    const { status, stdout } = runCli(["record", "--review", reviewPath], {
      cwd: wtDir,
    });
    assert.equal(status, 0, stdout);

    const wtLedgerAfter = JSON.parse(readFileSync(wtLedgerPath, "utf8"));
    assert.deepEqual(
      wtLedgerAfter.issues,
      { DECOY: { streak: 99, history: [] } },
      "worktree-local decoy ledger must be untouched -- record must not have written here",
    );

    const mainLedgerPath = join(mainDir, ".harness", "reject-streak.json");
    const mainLedgerAfter = JSON.parse(readFileSync(mainLedgerPath, "utf8"));
    assert.equal(mainLedgerAfter.issues["HYK-9700"].streak, 1);
  });
});

// HYK-221 축3 (양방향): the "gate" side of this incident is a DIFFERENT
// script -- dispatch-gate-decision.mjs -- not reject-streak.mjs's own
// `gate` subcommand. Cross-checking record's write against reject-streak.mjs's
// OWN `gate` subcommand would prove nothing about the real incident: both
// would use the exact same (possibly still-buggy) `repoRoot()` default, so
// they'd always agree with each other even under the pre-fix mutation --
// the actual HYK-219 1R gap was specifically that dispatch-gate-decision.mjs
// (git-common-dir based) and reject-streak.mjs's CLI default (previously
// --show-toplevel based) computed two DIFFERENT paths. This test therefore
// invokes dispatch-gate-decision.mjs as the read side, proving the two
// independent scripts' default ledger resolutions actually converge.
const DISPATCH_GATE_DECISION_SCRIPT = fileURLToPath(
  new URL("./dispatch-gate-decision.mjs", import.meta.url),
);

function runDispatchGateDecisionCli(args, opts = {}) {
  try {
    const stdout = execFileSync(
      "node",
      [DISPATCH_GATE_DECISION_SCRIPT, ...args],
      { encoding: "utf8", ...opts },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

test("(73) HYK-221 축3 양방향 실증 -- record(쓰기, --ledger 생략, reject-streak.mjs)가 워크트리에서 늘린 streak을 dispatch-gate-decision.mjs(읽기, --ledger/--expect-repo-root 생략)도 그대로 읽는다", () => {
  withFixtureDir((dir) => {
    const mainDir = join(dir, "main");
    initGitRepo(mainDir);
    writeFileSync(join(mainDir, "README.md"), "x\n", "utf8");
    mkdirSync(join(mainDir, ".harness"));
    writeLedger(join(mainDir, ".harness", "reject-streak.json"), {
      schema_version: 1,
      issues: {},
    });
    commitAll(mainDir, "init");
    const wtDir = join(dir, "wt-axis3-roundtrip");
    execFileSync("git", [
      "-C",
      mainDir,
      "worktree",
      "add",
      "-q",
      "--detach",
      wtDir,
      "HEAD",
    ]);
    const reviewPath = join(wtDir, ".harness", "review.md");
    const taskPath = join(wtDir, ".harness", "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-9701-roundtrip-1\nno envelope\n",
      "utf8",
    );

    // Two rejections (distinct DONE timestamps so computeRecord's dedup
    // does not fold them into one) push the issue to streak=2.
    writeFileSync(
      reviewPath,
      "task_id: HYK-9701-roundtrip-1\nverdict: rejected\n>>> DONE: REVIEW @ 2026-08-11 09:00 KST\n",
      "utf8",
    );
    let r = runCli(["record", "--review", reviewPath], { cwd: wtDir });
    assert.equal(r.status, 0, r.stdout);
    writeFileSync(
      reviewPath,
      "task_id: HYK-9701-roundtrip-1\nverdict: rejected\n>>> DONE: REVIEW @ 2026-08-11 09:05 KST\n",
      "utf8",
    );
    r = runCli(["record", "--review", reviewPath], { cwd: wtDir });
    assert.equal(r.status, 0, r.stdout);

    // dispatch-gate-decision.mjs, also with NO --ledger/--expect-repo-root,
    // from the SAME worktree -- must read the streak=2 that reject-streak.mjs's
    // record (also with no --ledger) just wrote to the MAIN repo's ledger,
    // and REJECT (no envelope) rather than see streak=0 from some unrelated
    // file.
    const gateResult = runDispatchGateDecisionCli([taskPath], { cwd: wtDir });
    assert.equal(gateResult.status, 1, gateResult.stdout + gateResult.stderr);
    assert.match(gateResult.stderr, /streak=2/);
    assert.match(gateResult.stderr, /REJECT/);
  });
});

// ---------------------------------------------------------------------------
// HYK-450 ② -- 표지 계수는 «문서가 주장한 줄»만 센다.
//
// 결함(실물 계열): 영수증·로그를 코드블록에 그대로 인용한 정직한 보고서가
// «판정 줄이 2개라 어느 것이 최종인지 결정할 수 없다»로 판정 불능이 됐다 --
// 연속 반려 안전장치가 거짓 근거로 잠기는 데이터 손실(HYK-438·HYK-449 계열).
// ⛔완화가 아니다: «진짜» 중복은 여전히 거부해야 한다(아래 두 번째 시험).
// ⚠️이 시험군에는 표지 문자열이 문자 그대로 들어간다 -- 시험 파일이므로
// 정상이다(coder-task.md §0.7 ⓒ).
// ---------------------------------------------------------------------------

const HYK450_FENCE = "```";

test("(HYK-450 ②) 인용된 'verdict:' 한 줄은 세지 않는다 -- 판정 불능이 되지 않는다", () => {
  const text = [
    "for: HYK-450-TARGET-1",
    "verdict: approved",
    "",
    `${HYK450_FENCE}text`,
    "verdict: rejected",
    HYK450_FENCE,
    "",
  ].join("\n");
  const r = parseReviewOutcome(text);
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.verdict, "approved");
  assert.equal(r.issueId, "HYK-450");
});

test("(HYK-450 ②) 인용된 'for:'/'task_id:' 줄도 세지 않는다", () => {
  const text = [
    "for: HYK-450-TARGET-1",
    "verdict: rejected",
    "",
    `${HYK450_FENCE}text`,
    "for: HYK-000-QUOTED-9",
    "task_id: HYK-000-QUOTED-9",
    HYK450_FENCE,
    "",
    "<!-- 보존 블록: task_id: HYK-000-COMMENTED-8 -->",
  ].join("\n");
  const r = parseReviewOutcome(text);
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.taskId, "HYK-450-TARGET-1");
  assert.equal(r.verdict, "rejected");
});

test("(HYK-450 ②) ⛔완화 0: «진짜» 중복 줄은 여전히 판정 불능으로 거부된다", () => {
  const twoVerdicts = parseReviewOutcome(
    [
      "for: HYK-450-TARGET-1",
      "verdict: approved",
      "verdict: rejected",
      "",
    ].join("\n"),
  );
  assert.equal(twoVerdicts.ok, false);
  assert.equal(
    twoVerdicts.reasonCode,
    REJECT_STREAK_REASON_CODE.AMBIGUOUS_VERDICT_LINE,
  );

  const twoFors = parseReviewOutcome(
    [
      "for: HYK-450-TARGET-1",
      "for: HYK-450-TARGET-2",
      "verdict: approved",
      "",
    ].join("\n"),
  );
  assert.equal(twoFors.ok, false);
  assert.equal(
    twoFors.reasonCode,
    REJECT_STREAK_REASON_CODE.AMBIGUOUS_FOR_LINE,
  );
});
