// HYK-419-wire-1 (coder-task.md §2⑴) -- retirement-auto-author-facts.mjs의
// 조립기 단위 시험. ⛔ 실 관제실 원장/영수증 파일은 절대 참조하지 않는다
// -- 이 파일의 모든 픽스처는 mkdtemp가 만든 격리 표적이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assembleAutoAuthorFacts,
  ASSEMBLE_FAILURE,
} from "./retirement-auto-author-facts.mjs";
import {
  evaluateAutoAuthorAuthorization,
  AUTO_AUTHOR_STATE,
} from "./retirement-auto-author-core.mjs";

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withTmp(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeLedger(path, reservations) {
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: "admission-ledger/v1",
      epoch: "2026-01-01T00:00:00.000Z",
      reservations,
    }),
    "utf8",
  );
}

function writeReceipts(path, lines) {
  writeFileSync(
    path,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// §1: 필수 인자/harnessDir 부재
// ---------------------------------------------------------------------------

test("role/harnessTaskLabel/harnessDir 중 하나라도 없으면 MISSING_ARGS(예외 없이)", () => {
  const result = assembleAutoAuthorFacts({ role: "CODER" });
  assert.equal(result.ok, false);
  assert.equal(result.code, ASSEMBLE_FAILURE.MISSING_ARGS);
});

test("harnessDir가 실제로 존재하지 않으면 MISSING_ARGS", () => {
  const result = assembleAutoAuthorFacts({
    role: "CODER",
    harnessTaskLabel: "HYK-1-x-1",
    harnessDir: "C:/definitely/not/a/real/path/hyk419-nonexistent",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, ASSEMBLE_FAILURE.MISSING_ARGS);
});

// ---------------------------------------------------------------------------
// §2: ledger 소스 -- 미설정/읽기 실패/형식 불일치는 전부 조립 불가
// ---------------------------------------------------------------------------

test("ledgerPath 미설정 -> LEDGER_UNREADABLE, reason에 '미설정' 포함(회귀변이 ⓑ의 대상)", () => {
  withTmp("hyk419-facts-harness-", (harnessDir) => {
    const result = assembleAutoAuthorFacts({
      role: "CODER",
      harnessTaskLabel: "HYK-419-x-1",
      harnessDir,
      receiptPath: undefined,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, ASSEMBLE_FAILURE.LEDGER_UNREADABLE);
    assert.match(result.reason, /미설정/);
  });
});

test("ledgerPath가 실재하지 않는 파일 -> LEDGER_UNREADABLE", () => {
  withTmp("hyk419-facts-harness-", (harnessDir) => {
    const result = assembleAutoAuthorFacts({
      role: "CODER",
      harnessTaskLabel: "HYK-419-x-1",
      harnessDir,
      ledgerPath: join(harnessDir, "does-not-exist.json"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, ASSEMBLE_FAILURE.LEDGER_UNREADABLE);
  });
});

test("ledger JSON이 깨져 있으면 LEDGER_MALFORMED", () => {
  withTmp("hyk419-facts-harness-", (harnessDir) => {
    const ledgerPath = join(harnessDir, "l.json");
    writeFileSync(ledgerPath, "{not valid json", "utf8");
    const result = assembleAutoAuthorFacts({
      role: "CODER",
      harnessTaskLabel: "HYK-419-x-1",
      harnessDir,
      ledgerPath,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, ASSEMBLE_FAILURE.LEDGER_MALFORMED);
  });
});

// ---------------------------------------------------------------------------
// §3: receipt 소스
// ---------------------------------------------------------------------------

test("receiptPath 미설정 -> RECEIPT_UNREADABLE (ledger는 정상이어도)", () => {
  withTmp("hyk419-facts-harness-", (harnessDir) => {
    const ledgerPath = join(harnessDir, "l.json");
    writeLedger(ledgerPath, {});
    const result = assembleAutoAuthorFacts({
      role: "CODER",
      harnessTaskLabel: "HYK-419-x-1",
      harnessDir,
      ledgerPath,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, ASSEMBLE_FAILURE.RECEIPT_UNREADABLE);
  });
});

// ---------------------------------------------------------------------------
// §4: rounds/ 소스
// ---------------------------------------------------------------------------

test("rounds 디렉터리 자리에 파일이 있으면(디렉터리 아님) ROUNDS_DIR_UNREADABLE", () => {
  withTmp("hyk419-facts-harness-", (harnessDir) => {
    const ledgerPath = join(harnessDir, "l.json");
    const receiptPath = join(harnessDir, "r.jsonl");
    writeLedger(ledgerPath, {});
    writeReceipts(receiptPath, []);
    // "rounds"를 디렉터리가 아니라 파일로 만들어 readdirSync가 실제로
    // 실패하게 만든다(주입이 아니라 진짜 파일시스템 오류).
    writeFileSync(join(harnessDir, "rounds"), "not a directory", "utf8");
    const result = assembleAutoAuthorFacts({
      role: "CODER",
      harnessTaskLabel: "HYK-419-x-1",
      harnessDir,
      ledgerPath,
      receiptPath,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, ASSEMBLE_FAILURE.ROUNDS_DIR_UNREADABLE);
  });
});

// ---------------------------------------------------------------------------
// §5: Never throws -- 조립기가 던지도록 강제한 경우에도 예외가 새지 않는다
// (coder-task.md §2⑷ "차단 0" 증명의 절반 -- 조립기 자신의 몫).
// ---------------------------------------------------------------------------

test("readFileFn이 강제로 던져도(Error가 아닌 값 포함) 조립기는 예외를 던지지 않고 ok:false로 접는다", () => {
  withTmp("hyk419-facts-harness-", (harnessDir) => {
    const throwingReadFileFn = () => {
      throw "boom (not an Error instance)";
    };
    assert.doesNotThrow(() => {
      const result = assembleAutoAuthorFacts({
        role: "CODER",
        harnessTaskLabel: "HYK-419-x-1",
        harnessDir,
        ledgerPath: join(harnessDir, "l.json"),
        readFileFn: throwingReadFileFn,
      });
      assert.equal(result.ok, false);
    });
  });
});

// ---------------------------------------------------------------------------
// §6: 완전 성공 경로 -- 세 소스 전부 조립되고, 그대로 core에 먹여
// AUTHORIZED_DRAFT까지 실제로 도달한다(조립기 <-> 코어의 실물 결합 증명).
// ---------------------------------------------------------------------------

test("세 소스 전부 정상이면 facts가 조립되고, 그 facts를 core에 그대로 먹이면 AUTHORIZED_DRAFT까지 도달한다", () => {
  withTmp("hyk419-facts-harness-", (harnessDir) => {
    const label = "HYK-419-x-1";
    const ledgerPath = join(harnessDir, "l.json");
    const receiptPath = join(harnessDir, "r.jsonl");
    const admittedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeLedger(ledgerPath, {
      [label]: {
        status: "ACTIVE",
        admitted_at: admittedAt,
        completed_at: null,
        role: "CODER",
        seat_key: "seat-1",
      },
    });
    writeReceipts(receiptPath, [{ role: "CODER", harness_task_label: label }]);
    mkdirSync(join(harnessDir, "rounds"), { recursive: true });
    writeFileSync(
      join(harnessDir, "rounds", "CODER-task-r1.md"),
      `task_id: ${label}\ndropped_at: 2026-08-01 07:00 KST\n`,
      "utf8",
    );

    const result = assembleAutoAuthorFacts({
      role: "CODER",
      harnessTaskLabel: label,
      harnessDir,
      ledgerPath,
      receiptPath,
      successorLabelForRecord: "HYK-420-next-1",
      recordedAt: "2026-08-03 07:00:00 KST",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.facts.ledgerReservation, {
      exists: true,
      harnessTaskLabel: label,
      status: "ACTIVE",
      completedAt: null,
    });
    assert.equal(result.facts.dispatchReceiptMatchCount, 1);
    assert.equal(result.facts.resultArchiveExists, false);
    assert.equal(result.facts.ownTaskArchiveExists, true);
    assert.equal(result.facts.hasLaterRoundArchive, false);
    assert.equal(result.facts.staleEnoughSinceAdmission, true);
    assert.equal(typeof result.facts.ownTaskArchiveFingerprint, "string");
    assert.equal(result.facts.ownTaskArchiveFingerprint.length, 64);

    const verdict = evaluateAutoAuthorAuthorization(result.facts);
    assert.equal(verdict.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.draftRecord.blockReasonCode, null);
  });
});

test("이 label이 ledger에 없으면 ledgerReservation.exists=false로 정직하게 조립된다(위조 없음)", () => {
  withTmp("hyk419-facts-harness-", (harnessDir) => {
    const ledgerPath = join(harnessDir, "l.json");
    const receiptPath = join(harnessDir, "r.jsonl");
    writeLedger(ledgerPath, {});
    writeReceipts(receiptPath, []);
    mkdirSync(join(harnessDir, "rounds"), { recursive: true });
    const result = assembleAutoAuthorFacts({
      role: "CODER",
      harnessTaskLabel: "HYK-419-x-1",
      harnessDir,
      ledgerPath,
      receiptPath,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.facts.ledgerReservation, { exists: false });
    assert.equal(result.facts.dispatchReceiptMatchCount, 0);
    assert.equal(result.facts.ownTaskArchiveExists, false);
  });
});
