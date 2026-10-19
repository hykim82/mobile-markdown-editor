// HYK-244-receipt-wire-2a §4 -- 소비 완료 영수증 «생산자» 시험.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  computeResultFingerprint,
  countVerdictLines,
  nextReceiptFileName,
  writeConsumptionReceipt,
} from "./consumption-receipt-writer.mjs";
import {
  checkConsumptionReceipt,
  CONSUMPTION_RECEIPT_STATE,
} from "./consumption-receipt-core.mjs";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "consumption-receipt-writer-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// computeResultFingerprint -- §2 지정: 결과 파일 내용의 SHA-256(hex).
// ---------------------------------------------------------------------------

test("computeResultFingerprint: matches a directly-computed SHA-256 hex digest of the same content", () => {
  const content =
    "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-14 07:10:05 KST\n";
  const expected = createHash("sha256").update(content, "utf8").digest("hex");
  assert.equal(computeResultFingerprint(content), expected);
});

test("computeResultFingerprint: different content -> different fingerprint (no accidental collision for near-identical inputs)", () => {
  const a = computeResultFingerprint(
    "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-14 07:10:05 KST\n",
  );
  const b = computeResultFingerprint(
    "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-14 07:10:06 KST\n",
  );
  assert.notEqual(a, b);
});

test("computeResultFingerprint: same content -> same fingerprint (deterministic, re-derivable independently)", () => {
  const content = "identical content\n";
  assert.equal(
    computeResultFingerprint(content),
    computeResultFingerprint(content),
  );
});

// ---------------------------------------------------------------------------
// countVerdictLines -- consumption-receipt-core.checkReviewVerdictLine이
// 요구하는 정확한 개수(0/1/2+)를 그대로 낸다.
// ---------------------------------------------------------------------------

test("countVerdictLines: 0 when no verdict line present", () => {
  assert.equal(countVerdictLines("task_id: HYK-1\n\nno verdict here\n"), 0);
});

test("countVerdictLines: 1 for a single well-formed verdict line (approved or rejected)", () => {
  assert.equal(countVerdictLines("for: HYK-1\nverdict: approved\n"), 1);
  assert.equal(countVerdictLines("for: HYK-1\nverdict: rejected\n"), 1);
});

test("countVerdictLines: 2 when both approved and rejected lines coexist (ambiguous)", () => {
  assert.equal(
    countVerdictLines("verdict: approved\n...\nverdict: rejected\n"),
    2,
  );
});

// ---------------------------------------------------------------------------
// writeConsumptionReceipt -- fs-backed behavior.
// ---------------------------------------------------------------------------

test("writeConsumptionReceipt: writes a JSON file under <harnessDir>/receipts/<role>-receipt-r1.json with binding/effects/verdictLineCount", () => {
  withFixtureDir((dir) => {
    const binding = {
      taskId: "HYK-1",
      role: "coder",
      droppedAt: "2026-08-14 07:00 KST",
      resultFingerprint: "abc123",
      dispatchId: "ctx_test_1",
      doneAt: "2026-08-14 07:10:05 KST",
    };
    const effects = {
      envelopeArchived: true,
      taskArchived: true,
      admissionReturned: true,
    };
    const outcome = writeConsumptionReceipt({
      role: "coder",
      harnessDir: dir,
      binding,
      effects,
      verdictLineCount: undefined,
    });
    assert.equal(outcome.ok, true);
    const written = JSON.parse(
      readFileSync(join(dir, "receipts", "coder-receipt-r1.json"), "utf8"),
    );
    assert.deepEqual(written.binding, binding);
    assert.deepEqual(written.effects, effects);
  });
});

test("writeConsumptionReceipt: two rounds for the same role -> BOTH receipts survive under distinct filenames (no overwrite)", () => {
  withFixtureDir((dir) => {
    const base = {
      role: "coder",
      harnessDir: dir,
      effects: {
        envelopeArchived: true,
        taskArchived: true,
        admissionReturned: true,
      },
    };
    const r1 = writeConsumptionReceipt({
      ...base,
      binding: {
        taskId: "HYK-1",
        role: "coder",
        droppedAt: "d1",
        resultFingerprint: "fp1",
        dispatchId: "d1",
        doneAt: "t1",
      },
    });
    const r2 = writeConsumptionReceipt({
      ...base,
      binding: {
        taskId: "HYK-1",
        role: "coder",
        droppedAt: "d2",
        resultFingerprint: "fp2",
        dispatchId: "d2",
        doneAt: "t2",
      },
    });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.notEqual(r1.path, r2.path);
    const files = readdirSync(join(dir, "receipts")).sort();
    assert.deepEqual(files, ["coder-receipt-r1.json", "coder-receipt-r2.json"]);
  });
});

// ---------------------------------------------------------------------------
// HYK-269 2R P1① fixture: 검토자가 실제로 재현한 그 사고 -- 소문자 영수증이
// 이미 있는 상태에서 대문자 role로 소비(또는 그 반대)해도, 기존 파일은
// 내용 무변경(sentinel 비교)이고 새 영수증은 case-insensitive 계수 덕에
// 다음 번호(r2)로 생성된다(같은 r1으로 되돌아가 덮어쓰지 않는다).
// ---------------------------------------------------------------------------

test("HYK-269 2R P1① fixture: lowercase receipt exists ('coder-receipt-r1.json') -> consuming with role 'CODER' does NOT overwrite it, writes 'CODER-receipt-r2.json' instead", () => {
  withFixtureDir((dir) => {
    const sentinelBinding = {
      taskId: "HYK-9200-lower-sentinel",
      role: "CODER",
      droppedAt: "SENTINEL-DROPPED-AT",
      resultFingerprint: "SENTINEL-FINGERPRINT",
      dispatchId: "ctx_sentinel",
      doneAt: "SENTINEL-DONE-AT",
    };
    const first = writeConsumptionReceipt({
      role: "coder",
      harnessDir: dir,
      binding: sentinelBinding,
      effects: {
        envelopeArchived: true,
        taskArchived: true,
        admissionReturned: true,
      },
    });
    assert.equal(first.ok, true);
    const sentinelPath = join(dir, "receipts", "coder-receipt-r1.json");
    const sentinelContentBefore = readFileSync(sentinelPath, "utf8");

    const second = writeConsumptionReceipt({
      role: "CODER",
      harnessDir: dir,
      binding: {
        taskId: "HYK-9200-upper-next",
        role: "CODER",
        droppedAt: "d2",
        resultFingerprint: "fp2",
        dispatchId: "ctx_2",
        doneAt: "t2",
      },
      effects: {
        envelopeArchived: true,
        taskArchived: true,
        admissionReturned: true,
      },
    });
    assert.equal(
      second.ok,
      true,
      "정상 케이스(TOCTOU 아님)에서는 case-insensitive 계수가 다음 번호를 정확히 찾아 충돌 자체가 없다",
    );

    assert.equal(
      readFileSync(sentinelPath, "utf8"),
      sentinelContentBefore,
      "기존 소문자 영수증 내용은 단 1바이트도 바뀌지 않아야 한다(오늘 실측: role 대문자 소비가 이 파일을 실제로 덮어썼다)",
    );
    const files = readdirSync(join(dir, "receipts")).sort();
    assert.deepEqual(
      files,
      ["CODER-receipt-r2.json", "coder-receipt-r1.json"],
      "새 영수증은 같은 r1이 아니라 다음 번호(r2)로 생성된다 -- 오늘 사고는 정확히 이 지점에서 r1으로 되돌아갔다",
    );
  });
});

test("HYK-269 2R P1① fixture (거꾸로): uppercase receipt exists ('CODER-receipt-r1.json') -> consuming with role 'coder' does NOT overwrite it either (symmetric protection)", () => {
  withFixtureDir((dir) => {
    const sentinelBinding = {
      taskId: "HYK-9201-upper-sentinel",
      role: "CODER",
      droppedAt: "SENTINEL-DROPPED-AT-2",
      resultFingerprint: "SENTINEL-FINGERPRINT-2",
      dispatchId: "ctx_sentinel_2",
      doneAt: "SENTINEL-DONE-AT-2",
    };
    const first = writeConsumptionReceipt({
      role: "CODER",
      harnessDir: dir,
      binding: sentinelBinding,
      effects: {
        envelopeArchived: true,
        taskArchived: true,
        admissionReturned: true,
      },
    });
    assert.equal(first.ok, true);
    const sentinelPath = join(dir, "receipts", "CODER-receipt-r1.json");
    const sentinelContentBefore = readFileSync(sentinelPath, "utf8");

    const second = writeConsumptionReceipt({
      role: "coder",
      harnessDir: dir,
      binding: {
        taskId: "HYK-9201-lower-next",
        role: "CODER",
        droppedAt: "d2",
        resultFingerprint: "fp2",
        dispatchId: "ctx_2",
        doneAt: "t2",
      },
      effects: {
        envelopeArchived: true,
        taskArchived: true,
        admissionReturned: true,
      },
    });
    assert.equal(second.ok, true);
    assert.equal(
      readFileSync(sentinelPath, "utf8"),
      sentinelContentBefore,
      "반대 방향(대문자 먼저, 소문자로 소비)도 동일하게 보호돼야 한다",
    );
    const files = readdirSync(join(dir, "receipts")).sort();
    assert.deepEqual(files, ["CODER-receipt-r1.json", "coder-receipt-r2.json"]);
  });
});

// ---------------------------------------------------------------------------
// HYK-269 2R P1① 두 번째 겹(쓰기 직전 재확인) 단독 시험: nextReceiptFileName의
// case-insensitive 계수만으로는 못 잡는 TOCTOU 경합을 readdirFn 주입으로
// 재현한다 -- 번호 계산용 첫 readdirFn 호출은 빈 목록을 주고(그래서
// "CODER-receipt-r1.json"을 다음 번호로 계산), 쓰기 직전 재확인용 두
// 번째 호출에서는 그 사이 다른 프로세스가 이미 만들어 둔 것처럼
// "coder-receipt-r1.json"이 있는 목록을 준다 -- 두 번째 겹이 없으면
// 이 상황에서 그대로 덮어쓴다.
// ---------------------------------------------------------------------------
test("HYK-269 2R P1① 두 번째 겹(TOCTOU 재확인, readdirFn 주입으로 재현): 번호 계산 스냅샷 이후 다른 프로세스가 같은 이름을 대소문자만 다르게 이미 써 뒀다면, 쓰기 직전 재확인이 그것을 잡아 거부한다(ok:false, 파일 안 씀)", () => {
  withFixtureDir((dir) => {
    let call = 0;
    const readdirFn = () => {
      call += 1;
      return call === 1 ? [] : ["coder-receipt-r1.json"];
    };
    let writeFileCalled = false;
    const writeFileFn = (...args) => {
      writeFileCalled = true;
      return writeFileSync(...args);
    };
    const outcome = writeConsumptionReceipt({
      role: "CODER",
      harnessDir: dir,
      binding: { taskId: "HYK-9202-race", role: "CODER" },
      effects: {
        envelopeArchived: true,
        taskArchived: true,
        admissionReturned: true,
      },
      readdirFn,
      writeFileFn,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /refusing to overwrite/);
    assert.match(outcome.reason, /collides \(case-insensitive\)/);
    assert.equal(
      writeFileCalled,
      false,
      "충돌이 잡히면 writeFileFn 자체가 호출되지 않아야 한다(조용한 덮어쓰기 0)",
    );
  });
});

test("writeConsumptionReceipt: role missing -> ok:false, never throws", () => {
  withFixtureDir((dir) => {
    const outcome = writeConsumptionReceipt({
      role: "",
      harnessDir: dir,
      binding: {},
      effects: {},
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /role missing/);
  });
});

test("writeConsumptionReceipt: never throws even when the harnessDir path is unwritable (fs error surfaces as ok:false)", () => {
  withFixtureDir((dir) => {
    // Make the intended receipts/ path collide with a pre-existing FILE (not
    // a directory) -- mkdirSync will throw EEXIST-as-not-a-directory, which
    // this function's try/catch must absorb into ok:false, not propagate.
    const collidingPath = join(dir, "receipts");
    writeFileSync(collidingPath, "not a directory\n", "utf8");
    const outcome = writeConsumptionReceipt({
      role: "coder",
      harnessDir: dir,
      binding: { taskId: "HYK-1" },
      effects: {},
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /failed to write/);
  });
});

// ---------------------------------------------------------------------------
// nextReceiptFileName -- 번호 매기기 계약(envelope-archive.mjs의
// nextArchiveFileName/nextTaskArchiveFileName과 같은 패턴, 겹치지 않는
// 새 파일명 규칙).
// ---------------------------------------------------------------------------

test("nextReceiptFileName: empty existing list -> round 1", () => {
  assert.equal(nextReceiptFileName("coder", []), "coder-receipt-r1.json");
});

test("nextReceiptFileName: existing r1/r2 -> next is r3, never reuses a past round even with gaps", () => {
  assert.equal(
    nextReceiptFileName("coder", [
      "coder-receipt-r1.json",
      "coder-receipt-r2.json",
    ]),
    "coder-receipt-r3.json",
  );
  assert.equal(
    nextReceiptFileName("coder", ["coder-receipt-r5.json"]),
    "coder-receipt-r6.json",
  );
});

test("nextReceiptFileName: does not confuse a different role's files with its own numbering", () => {
  assert.equal(
    nextReceiptFileName("coder", [
      "review-receipt-r1.json",
      "review-receipt-r2.json",
    ]),
    "coder-receipt-r1.json",
  );
});

// ---------------------------------------------------------------------------
// §4-5 비타협: "영수증이 1R 코어에 그대로 먹힌다" -- 생산된 영수증을
// checkConsumptionReceipt에 직접 넣어 PASS가 나오는 것을 시험으로 증명한다
// (모양이 같다는 주장만 하지 않는다).
// ---------------------------------------------------------------------------

test("§4-5 실제 연결: writeConsumptionReceipt이 만든 파일을 그대로 읽어 checkConsumptionReceipt에 candidates로 넣으면 PASS가 나온다 (CODER)", () => {
  withFixtureDir((dir) => {
    const binding = {
      taskId: "HYK-244",
      role: "coder",
      droppedAt: "2026-08-14 07:00 KST",
      resultFingerprint: computeResultFingerprint("some real result content\n"),
      dispatchId: "ctx_real_2rb",
      doneAt: "2026-08-14 07:10:05 KST",
    };
    const effects = {
      envelopeArchived: true,
      taskArchived: true,
      admissionReturned: true,
    };
    writeConsumptionReceipt({
      role: "coder",
      harnessDir: dir,
      binding,
      effects,
    });

    const receiptPath = join(dir, "receipts", "coder-receipt-r1.json");
    const candidate = JSON.parse(readFileSync(receiptPath, "utf8"));

    const r = checkConsumptionReceipt({
      role: "coder",
      currentBinding: binding,
      candidates: [candidate],
    });
    assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.PASS);
    assert.equal(r.ok, true);
  });
});

test("§4-5 실제 연결 (REVIEW): ledgerRecorded + verdictLineCount이 포함된 영수증도 코어에서 그대로 PASS한다", () => {
  withFixtureDir((dir) => {
    const binding = {
      taskId: "HYK-244",
      role: "review",
      droppedAt: "2026-08-14 09:00 KST",
      resultFingerprint: computeResultFingerprint("verdict: approved\n"),
      dispatchId: "ctx_real_review_2rb",
      doneAt: "2026-08-14 09:12:41 KST",
    };
    const effects = {
      envelopeArchived: true,
      taskArchived: true,
      admissionReturned: true,
      ledgerRecorded: true,
    };
    const verdictLineCount = countVerdictLines("verdict: approved\n");
    writeConsumptionReceipt({
      role: "review",
      harnessDir: dir,
      binding,
      effects,
      verdictLineCount,
    });

    const receiptPath = join(dir, "receipts", "review-receipt-r1.json");
    const candidate = JSON.parse(readFileSync(receiptPath, "utf8"));

    const r = checkConsumptionReceipt({
      role: "review",
      currentBinding: binding,
      candidates: [candidate],
    });
    assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.PASS);
    assert.equal(r.ok, true);
  });
});

test("§4-5 실제 연결 (부분 성공 방지 대조군): admissionReturned:false로 «만들어졌다면» 코어가 여전히 PARTIAL_SUCCESS로 거부한다 (직접 손으로 만든 영수증으로 대조 -- 실제 wiring은 이 경우 아예 파일을 쓰지 않는다, relay-handshake.test.mjs에서 별도 확인)", () => {
  withFixtureDir((dir) => {
    const binding = {
      taskId: "HYK-244",
      role: "coder",
      droppedAt: "2026-08-14 07:00 KST",
      resultFingerprint: "fp-partial",
      dispatchId: "ctx_partial",
      doneAt: "2026-08-14 07:10:05 KST",
    };
    // Deliberately hand-crafted with a failed effect -- this receipt should
    // never be produced by the real wiring (relay-handshake.mjs's
    // autoWriteConsumptionReceipt skips writing entirely in this case), but
    // if one somehow existed, the core must still reject it.
    writeConsumptionReceipt({
      role: "coder",
      harnessDir: dir,
      binding,
      effects: {
        envelopeArchived: true,
        taskArchived: true,
        admissionReturned: false,
      },
    });
    const candidate = JSON.parse(
      readFileSync(join(dir, "receipts", "coder-receipt-r1.json"), "utf8"),
    );
    const r = checkConsumptionReceipt({
      role: "coder",
      currentBinding: binding,
      candidates: [candidate],
    });
    assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.PARTIAL_SUCCESS);
    assert.equal(r.ok, false);
  });
});
