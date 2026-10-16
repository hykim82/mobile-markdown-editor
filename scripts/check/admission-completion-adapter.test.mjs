import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  autoCompleteAdmission,
  completeAdmissionReservation,
} from "./admission-completion-adapter.mjs";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";
import {
  createEmptyLedger,
  admitReservation,
  sweepAndRecover,
} from "../supervisor/admission-ledger-core.mjs";

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), "admission-completion-adapter-test-"));
  return {
    dir,
    ledger: join(dir, "ledger.json"),
    lock: join(dir, "ledger.lock"),
  };
}

// HYK-279: "ADMISSION_LEDGER_PATH is unset" must mean neither resolution
// source is present -- not just the env var. admission-completion-adapter.mjs
// (HYK-227 2R) also falls back to a persistent pointer file at
// `<mainRepoRoot>/.harness/admission-ledger-path.json`, resolved via
// `git rev-parse --git-common-dir` off `process.cwd()`. Before this fix, this
// test deleted only the env var and ran with cwd left at this worktree's real
// path -- whose mainRepoRoot IS the shared main HARNESSENGINEERING checkout,
// which (실측: confirmed present on disk) has that pointer file installed,
// pointing at the REAL control-room ledger. So the test's own premise
// (attempted:false) was false in this environment: the adapter actually
// attempted a completion for the literal fixture id "HYK-000-x-1" against the
// real ledger (RESERVATION_NOT_FOUND) and durably appended that failure to
// the real `*.completion-failures.jsonl` -- exactly the ORCH-measured leak
// (coder-task.md §1) and this repo's one pre-existing baseline test failure.
// Fix: chdir into a synthetic, pointer-file-less git repo for the duration of
// the assertion (same pattern as
// admission-completion-persistent-source.test.mjs's ⓒ test), so mainRepoRoot()
// has nothing real to resolve to regardless of which worktree/machine this
// runs on.
function buildSyntheticRepoWithoutPointer() {
  const dir = mkdtempSync(join(tmpdir(), "hyk279-adapter-noop-repo-"));
  execSync("git init -q", { cwd: dir });
  mkdirSync(join(dir, ".harness"), { recursive: true });
  return dir;
}

test("autoCompleteAdmission is a documented no-op (attempted:false) when ADMISSION_LEDGER_PATH is unset (honesty limit, not silent success)", () => {
  const saved = process.env.ADMISSION_LEDGER_PATH;
  const savedCwd = process.cwd();
  const repoDir = buildSyntheticRepoWithoutPointer();
  delete process.env.ADMISSION_LEDGER_PATH;
  process.chdir(repoDir);
  try {
    const outcome = autoCompleteAdmission({ reservationId: "HYK-000-x-1" });
    assert.deepEqual(outcome, { attempted: false });
  } finally {
    process.chdir(savedCwd);
    if (saved !== undefined) process.env.ADMISSION_LEDGER_PATH = saved;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("autoCompleteAdmission releases a real reservation when the env var is set (integration path relay-handshake.mjs uses)", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-224-cap-admission-1",
      "--cap",
      "1",
    ]);

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-224-cap-admission-1",
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, true);

    // Slot is free again -- a fresh admit for the same cap succeeds.
    const readmitExit = runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-224-cap-admission-2",
      "--cap",
      "1",
    ]);
    assert.equal(readmitExit, 0);
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-342/HYK-249: `reason` is a NEW, optional field threaded straight
// through to completeReservation's own `completion_reason` stamp -- this
// pins the integration path relay-handshake.mjs's BLOCKED-termination side
// effects use (spawnAdmissionAbortProcess -> this adapter's CLI -> here).
//
// HYK-342 2R P1-1: BLOCKED_TERMINATION_RELEASED now requires corroborating
// evidence (a live `<role>.md` result file whose task_id echo matches the
// reservationId and carries a well-formed `>>> BLOCKED:`/`>>> NEEDS_INPUT:`
// marker) -- this test seeds that file (mirroring what a genuine relay-
// handshake.mjs BLOCKED round leaves behind) so it still exercises the
// success path, not just the (separately tested) forgery-rejection path.
// HYK-342 3R §0/§2: the reviewer's 2R attack showed the worker CAN write
// its own task_id + BLOCKED marker (both are worker-writable) -- so this
// test also seeds a real dispatch-receipts.jsonl entry for this exact
// role+reservationId (the one thing a worker cannot fabricate) to still
// exercise the genuine success path under the tightened 3R contract.
test("autoCompleteAdmission with `reason` stamps completion_reason on the released reservation (BLOCKED-termination integration path)", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  const savedPane = process.env.ORCA_PANE_KEY;
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    // HYK-443 5R: 예약은 «어느 좌석에 배정됐는지»를 스스로 기록하고
    // (`--seat-key` -> reservations[...].seat_key), 반납 검증은 영수증의
    // `assignee_pane_key`를 «그 값»과 대조한다(호출자 env가 아니라) --
    // 진짜 성공 경로 재현이므로 둘을 같은 값으로 세운다.
    const seatPaneKey = "tab-hyk342blocked:leaf-hyk342blocked";
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-342-blocked-1",
      "--cap",
      "1",
      "--seat-key",
      seatPaneKey,
    ]);
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-342-blocked-1\n\n>>> BLOCKED: 시험용 정지\n",
      "utf8",
    );
    // 영수증 줄은 «어느 좌석에 배달됐는가»(assignee_pane_key)를 담는다 --
    // 위 admit의 --seat-key와 같은 값(진짜 배달 재현).
    const receiptPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ role: "CODER", harness_task_label: "HYK-342-blocked-1", dispatch_id: "ctx_test", assignee_pane_key: seatPaneKey })}\n`,
      "utf8",
    );

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    process.env.ORCA_PANE_KEY = seatPaneKey;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-342-blocked-1",
      reason: "BLOCKED_TERMINATION_RELEASED",
      harnessDir: dir,
      role: "CODER",
      receiptPath,
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, true, outcome.reason);

    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(
      written.reservations["HYK-342-blocked-1"].completion_reason,
      "BLOCKED_TERMINATION_RELEASED",
    );
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    if (savedPane !== undefined) process.env.ORCA_PANE_KEY = savedPane;
    else delete process.env.ORCA_PANE_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-342 3R §0/§2 (검토자가 2R에서 재현한 우회로의 재현): the worker
// writes its OWN result file with a made-up task_id + a well-formed
// BLOCKED marker (both are worker-writable, per the corrected §0 trust
// boundary) and admits a matching reservation under that same fake id --
// but NO dispatch receipt exists for it (nobody ever really dispatched
// this "round"). The 2R contract (task_id echo + BLOCKED marker only)
// would have accepted this; the 3R receipt check must refuse it.
test("HYK-342 3R §2: a worker-forged task_id + worker-forged BLOCKED marker with NO matching dispatch receipt is refused (reviewer's 2R bypass, now blocked)", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-342-fake-result-1",
      "--cap",
      "1",
    ]);
    // ⛔워커가 자기 결과 파일에 지어낸 task_id + 지어낸 BLOCKED 표지를
    // 직접 쓴다(검토자 2R §1 항1 실측 그대로 재현).
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-342-fake-result-1\n\n>>> BLOCKED: forged by worker\n",
      "utf8",
    );
    // ⛔dispatch-receipts.jsonl은 아예 만들지 않는다 -- 이 task_id로 배달된
    // 적이 정말 없다(워커가 지어낸 것이므로).

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-342-fake-result-1",
      reason: "BLOCKED_TERMINATION_RELEASED",
      harnessDir: dir,
      role: "CODER",
      receiptPath: join(dir, "dispatch-receipts.jsonl"), // 존재하지 않는 파일
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "BLOCKED_TERMINATION_EVIDENCE_MISSING");

    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(
      written.reservations["HYK-342-fake-result-1"].status,
      "ACTIVE",
      "워커 자작 이름표+표지만으로는 자리를 반납받지 못해야 한다",
    );
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-342 2R P1-1 (검토자가 재현한 공격의 재현): a caller that invokes the
// adapter directly with BLOCKED_TERMINATION_RELEASED but NO corroborating
// live BLOCKED result file must be refused -- the reservation stays ACTIVE.
test("HYK-342 2R P1-1: autoCompleteAdmission with reason=BLOCKED_TERMINATION_RELEASED but no live BLOCKED result file is refused (reviewer's direct-adapter-call attack, now blocked)", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-342-forged-1",
      "--cap",
      "1",
    ]);
    // ⛔결과 파일을 전혀 만들지 않는다 -- 검토자가 재현한 공격 그대로
    // (증거 없이 어댑터를 직접 실행).

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-342-forged-1",
      reason: "BLOCKED_TERMINATION_RELEASED",
      harnessDir: dir,
      role: "CODER",
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "BLOCKED_TERMINATION_EVIDENCE_MISSING");

    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(
      written.reservations["HYK-342-forged-1"].status,
      "ACTIVE",
      "위조 시도는 예약 상태를 조금도 바꾸지 못해야 한다",
    );
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-342 2R P1-1: an unknown/arbitrary reason string (not in the closed
// COMPLETION_REASON set) is refused outright -- closes the "비어 있지 않은
// 임의 문자열" half of the finding, independent of the evidence check.
test("HYK-342 2R P1-1: an unknown completion reason string is refused (closed enum, not arbitrary)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-342-unknown-reason",
      "--cap",
      "1",
    ]);
    const outcome = completeAdmissionReservation({
      reservationId: "HYK-342-unknown-reason",
      ledgerPath: ledger,
      lockPath: lock,
      reason: "TOTALLY_MADE_UP_REASON",
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "UNKNOWN_COMPLETION_REASON");
    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(
      written.reservations["HYK-342-unknown-reason"].status,
      "ACTIVE",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-398: RETIREMENT_RELEASED -- a third, distinct completion reason for a
// VALID-labeled round whose retirement record independently reconfirms
// RETIRED (retirement-record-core.mjs's checkRetirementRecord, imported
// directly -- see this adapter's own header for why that import is safe
// here). Mirrors the BLOCKED_TERMINATION_RELEASED tests above: a genuine
// success path (real archive + real retirement record + real dropped_at)
// and forgery/incompleteness rejections, each distinguishable.
// ---------------------------------------------------------------------------

const RETIREMENT_TASK_HEADER =
  "task_id: HYK-398-r-1\ndropped_at: 2026-08-08 21:00 KST\n";
const RETIREMENT_STALE_RESULT =
  "task_id: HYK-398-r-1\n\n>>> DONE: CODER @ 2026-08-08 20:00:00 KST\n";

function fingerprintOf(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function seedRetirementFixture(dir, { blockReasonCode, successorLabel } = {}) {
  writeFileSync(join(dir, "coder-task.md"), RETIREMENT_TASK_HEADER, "utf8");
  writeFileSync(join(dir, "coder.md"), RETIREMENT_STALE_RESULT, "utf8");
  mkdirSync(join(dir, "rounds"), { recursive: true });
  writeFileSync(
    join(dir, "rounds", "coder-r1.md"),
    RETIREMENT_STALE_RESULT,
    "utf8",
  );
  mkdirSync(join(dir, "retirements"), { recursive: true });
  writeFileSync(
    join(dir, "retirements", "coder-retire-r1.json"),
    JSON.stringify({
      role: "CODER",
      harnessTaskLabel: "HYK-398-r-1",
      archivePath: "rounds/coder-r1.md",
      archiveFingerprintClaimed: fingerprintOf(RETIREMENT_STALE_RESULT),
      blockReasonCode: blockReasonCode ?? "DONE_PREDATES_DROPPED_AT",
      successorLabel: successorLabel ?? "HYK-398-r-2",
      recordedAt: "2026-08-08 22:00:00 KST",
      evidence: { source: "test" },
    }),
    "utf8",
  );
}

test("HYK-398: autoCompleteAdmission with reason=RETIREMENT_RELEASED releases a genuinely-retired reservation and stamps completion_reason distinctly from SUSPECT_TIMEOUT_RECOVERED/BLOCKED_TERMINATION_RELEASED", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-398-r-1",
      "--cap",
      "1",
    ]);
    seedRetirementFixture(dir);

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-398-r-1",
      reason: "RETIREMENT_RELEASED",
      harnessDir: dir,
      role: "CODER",
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, true, outcome.reason);

    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(written.reservations["HYK-398-r-1"].status, "COMPLETED");
    assert.equal(
      written.reservations["HYK-398-r-1"].completion_reason,
      "RETIREMENT_RELEASED",
    );
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HYK-398: RETIREMENT_RELEASED with no retirement record at all is refused (RETIREMENT_EVIDENCE_MISSING), reservation stays ACTIVE", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-398-r-2",
      "--cap",
      "1",
    ]);
    // ⛔은퇴 기록도, 아카이브 사본도 만들지 않는다 -- 가장 흔한 경우(아직
    // ORCH가 은퇴를 선언하지 않음).
    writeFileSync(join(dir, "coder-task.md"), RETIREMENT_TASK_HEADER, "utf8");
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-398-r-2\n\n>>> DONE: CODER @ 2026-08-08 20:00:00 KST\n",
      "utf8",
    );

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-398-r-2",
      reason: "RETIREMENT_RELEASED",
      harnessDir: dir,
      role: "CODER",
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "RETIREMENT_EVIDENCE_MISSING");

    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(written.reservations["HYK-398-r-2"].status, "ACTIVE");
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HYK-398: RETIREMENT_RELEASED with a worker-forged task_id (no matching live result) is refused, reservation stays ACTIVE", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-398-r-forged",
      "--cap",
      "1",
    ]);
    // ⛔결과 파일 자체를 아예 만들지 않는다(검토자의 BLOCKED_TERMINATION_
    // RELEASED 공격 재현과 같은 형태 -- 증거 없이 어댑터를 직접 실행).

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-398-r-forged",
      reason: "RETIREMENT_RELEASED",
      harnessDir: dir,
      role: "CODER",
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "RETIREMENT_EVIDENCE_MISSING");

    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(written.reservations["HYK-398-r-forged"].status, "ACTIVE");
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HYK-398: RETIREMENT_RELEASED with a fingerprint-mismatched archive is refused (forged/stale archive claim), reservation stays ACTIVE", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-398-r-3",
      "--cap",
      "1",
    ]);
    writeFileSync(join(dir, "coder-task.md"), RETIREMENT_TASK_HEADER, "utf8");
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-398-r-3\n\n>>> DONE: CODER @ 2026-08-08 20:00:00 KST\n",
      "utf8",
    );
    mkdirSync(join(dir, "rounds"), { recursive: true });
    writeFileSync(
      join(dir, "rounds", "coder-r1.md"),
      "task_id: HYK-398-r-3\n\n>>> DONE: CODER @ 2026-08-08 20:00:00 KST\n",
      "utf8",
    );
    mkdirSync(join(dir, "retirements"), { recursive: true });
    writeFileSync(
      join(dir, "retirements", "coder-retire-r1.json"),
      JSON.stringify({
        role: "CODER",
        harnessTaskLabel: "HYK-398-r-3",
        archivePath: "rounds/coder-r1.md",
        archiveFingerprintClaimed: "sha256-does-not-match-anything",
        blockReasonCode: "DONE_PREDATES_DROPPED_AT",
        successorLabel: "HYK-398-r-4",
        recordedAt: "2026-08-08 22:00:00 KST",
        evidence: { source: "test" },
      }),
      "utf8",
    );

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-398-r-3",
      reason: "RETIREMENT_RELEASED",
      harnessDir: dir,
      role: "CODER",
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "RETIREMENT_EVIDENCE_MISSING");
    assert.match(outcome.reason, /지문 대조 실패/);

    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(written.reservations["HYK-398-r-3"].status, "ACTIVE");
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HYK-398: RETIREMENT_RELEASED with successorLabel missing is refused (SUCCESSOR_LABEL_MISSING), reservation stays ACTIVE", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-398-r-4",
      "--cap",
      "1",
    ]);
    writeFileSync(join(dir, "coder-task.md"), RETIREMENT_TASK_HEADER, "utf8");
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-398-r-4\n\n>>> DONE: CODER @ 2026-08-08 20:00:00 KST\n",
      "utf8",
    );
    mkdirSync(join(dir, "rounds"), { recursive: true });
    const content =
      "task_id: HYK-398-r-4\n\n>>> DONE: CODER @ 2026-08-08 20:00:00 KST\n";
    writeFileSync(join(dir, "rounds", "coder-r1.md"), content, "utf8");
    mkdirSync(join(dir, "retirements"), { recursive: true });
    writeFileSync(
      join(dir, "retirements", "coder-retire-r1.json"),
      JSON.stringify({
        role: "CODER",
        harnessTaskLabel: "HYK-398-r-4",
        archivePath: "rounds/coder-r1.md",
        archiveFingerprintClaimed: fingerprintOf(content),
        blockReasonCode: "DONE_PREDATES_DROPPED_AT",
        // ⛔successorLabel 자체를 뺀다.
        recordedAt: "2026-08-08 22:00:00 KST",
        evidence: { source: "test" },
      }),
      "utf8",
    );

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-398-r-4",
      reason: "RETIREMENT_RELEASED",
      harnessDir: dir,
      role: "CODER",
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "RETIREMENT_EVIDENCE_MISSING");
    assert.match(outcome.reason, /후속 이름표\(successorLabel\)가 없음/);

    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(written.reservations["HYK-398-r-4"].status, "ACTIVE");
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-457 §4 완료조건 1: RUNNER_GREEN_UNREACHABLE_AT_HEAD -- the third
// mechanically-confirmable reason (HYK-455) that admission-completion-
// adapter.mjs's OWN copy of this confirm logic never wired a branch for,
// fail-closing every real retirement using it (2026-09-08 ORCH-63 isolated
// measurement, coder-task.md §1/§2). These tests reproduce that exact shape
// against the fixed code: one success case with every piece of evidence
// present, then the same fixture with each piece of evidence removed one at
// a time -- each must independently refuse and leave the reservation ACTIVE.
// ---------------------------------------------------------------------------

const RUNNER_GREEN_HEAD_COMMIT = "b".repeat(40);

function seedRunnerGreenFixture(
  dir,
  {
    reservationId,
    includeEvidenceReceiptPath = true,
    receiptExists = true,
    receiptHeadCommit = RUNNER_GREEN_HEAD_COMMIT,
    receiptRunnerExit = 1,
  } = {},
) {
  const taskHeader = `task_id: ${reservationId}\ndropped_at: 2026-09-08 20:00 KST\n`;
  const resultContent =
    `task_id: ${reservationId}\nhead_commit: ${RUNNER_GREEN_HEAD_COMMIT}\n\n` +
    `>>> DONE: CODER @ 2026-09-08 20:03:19 KST\n`;
  writeFileSync(join(dir, "coder-task.md"), taskHeader, "utf8");
  writeFileSync(join(dir, "coder.md"), resultContent, "utf8");
  mkdirSync(join(dir, "rounds"), { recursive: true });
  writeFileSync(join(dir, "rounds", "coder-r1.md"), resultContent, "utf8");
  mkdirSync(join(dir, "retirements"), { recursive: true });
  writeFileSync(
    join(dir, "retirements", "coder-retire-r1.json"),
    JSON.stringify({
      role: "CODER",
      harnessTaskLabel: reservationId,
      archivePath: "rounds/coder-r1.md",
      archiveFingerprintClaimed: fingerprintOf(resultContent),
      blockReasonCode: "RUNNER_GREEN_UNREACHABLE_AT_HEAD",
      successorLabel: `${reservationId}-successor`,
      recordedAt: "2026-09-08 20:03:19 KST",
      evidence: { source: "test" },
      ...(includeEvidenceReceiptPath
        ? { evidenceReceiptPath: "runner-receipt.json" }
        : {}),
    }),
    "utf8",
  );
  if (receiptExists) {
    writeFileSync(
      join(dir, "runner-receipt.json"),
      JSON.stringify({
        head_commit: receiptHeadCommit,
        runner_exit: receiptRunnerExit,
      }),
      "utf8",
    );
  }
}

function runRunnerGreenCase(reservationId, seedOpts) {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      reservationId,
      "--cap",
      "1",
    ]);
    seedRunnerGreenFixture(dir, { reservationId, ...seedOpts });

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId,
      reason: "RETIREMENT_RELEASED",
      harnessDir: dir,
      role: "CODER",
    });
    const written = JSON.parse(readFileSync(ledger, "utf8"));
    return { outcome, status: written.reservations[reservationId].status };
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("HYK-457: RETIREMENT_RELEASED for a RUNNER_GREEN_UNREACHABLE_AT_HEAD retirement with every piece of evidence present succeeds (released, changed=true) -- this is exactly the case HYK-457's fix wires", () => {
  const { outcome, status } = runRunnerGreenCase("HYK-457-rg-1", {});
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.ok, true, outcome.reason);
  assert.equal(status, "COMPLETED");
});

test("HYK-457: RUNNER_GREEN_UNREACHABLE_AT_HEAD retirement is refused when evidenceReceiptPath itself is missing from the retirement record", () => {
  const { outcome, status } = runRunnerGreenCase("HYK-457-rg-2", {
    includeEvidenceReceiptPath: false,
  });
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /재확인되지 않음/);
  assert.equal(status, "ACTIVE");
});

test("HYK-457: RUNNER_GREEN_UNREACHABLE_AT_HEAD retirement is refused when the runner receipt file the record points to does not exist", () => {
  const { outcome, status } = runRunnerGreenCase("HYK-457-rg-3", {
    receiptExists: false,
  });
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /재확인되지 않음/);
  assert.equal(status, "ACTIVE");
});

test("HYK-457: RUNNER_GREEN_UNREACHABLE_AT_HEAD retirement is refused when the runner receipt's head_commit does not match the live result's head_commit (fingerprint mismatch on the runner-green axis)", () => {
  const { outcome, status } = runRunnerGreenCase("HYK-457-rg-4", {
    receiptHeadCommit: "c".repeat(40),
  });
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /재확인되지 않음/);
  assert.equal(status, "ACTIVE");
});

test("HYK-457: RUNNER_GREEN_UNREACHABLE_AT_HEAD retirement is refused when the runner receipt says runner_exit=0 (the commit is actually green -- retiring for this reason would be a lie)", () => {
  const { outcome, status } = runRunnerGreenCase("HYK-457-rg-5", {
    receiptRunnerExit: 0,
  });
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /재확인되지 않음/);
  assert.equal(status, "ACTIVE");
});

// ---------------------------------------------------------------------------
// HYK-478 §1-1/§1-2: AUTHOR_SEAT_LOST_BEFORE_STAMP -- 작성자 좌석이 완료
// 표지를 남기기 «전»에 소실된(2026-09-15 20:36 윈도우 업데이트 재부팅
// 실물, coder-task.md §0) 라운드. 두 독립 사실 «둘 다» 참이어야 released
// 된다: ⓐ 완료 표지 0개 ⓑ admission 원장 예약이 더는 ACTIVE가 아님
// (SUSPECT). admission-ledger-core.mjs의 실제 함수(admit ->
// sweepAndRecover)를 직접 돌려 SUSPECT/ACTIVE 원장을 만든다(합성 JSON을
// 손으로 짜지 않는다, dispatch-gate-retirement-wire.test.mjs의
// buildRealRecoveredLedger와 동일한 이유) -- runAdmissionCli의 admit을 쓰지
// 않는 것은 그 경로가 admitted_at을 실제 벽시계로 찍어 sweep 판정에
// 시간-기반 불확실성을 들이기 때문이다(이 파일도 결정적 ISO 문자열만 쓴다).
// ---------------------------------------------------------------------------

function buildSeatLostAdapterLedger(reservationId) {
  let ledger = createEmptyLedger("2026-09-16T00:00:00.000Z");
  const admit = admitReservation(ledger, {
    reservationId,
    cap: 1,
    now: "2026-09-16T00:00:00.000Z",
    role: "CODER",
    seatKey: "seat-that-died",
  });
  assert.equal(admit.decision, "ADMITTED");
  const swept = sweepAndRecover(admit.ledger, {
    now: "2026-09-16T00:10:01.000Z",
    liveSeatKeys: [],
    staleAfterMs: 5 * 60 * 1000,
    recoveryGraceMs: 10 * 60 * 1000,
  });
  assert.equal(swept.ok, true);
  assert.equal(swept.ledger.reservations[reservationId].status, "SUSPECT");
  return swept.ledger;
}

function buildSeatAliveAdapterLedger(reservationId) {
  let ledger = createEmptyLedger("2026-09-16T00:00:00.000Z");
  const admit = admitReservation(ledger, {
    reservationId,
    cap: 1,
    now: "2026-09-16T00:00:00.000Z",
    role: "CODER",
    seatKey: "seat-still-alive",
  });
  assert.equal(admit.decision, "ADMITTED");
  assert.equal(admit.ledger.reservations[reservationId].status, "ACTIVE");
  return admit.ledger;
}

function seedSeatLostFixture(dir, { reservationId, withDoneStamp = false }) {
  const taskHeader = `task_id: ${reservationId}\ndropped_at: 2026-09-16 08:00 KST\n`;
  // ⛔완료 표지 자체가 없다(윈도우 재부팅으로 표지를 쓰던 중 좌석이 죽은
  // 실물 형태 -- 열 0 `>>> DONE:` 줄이 하나도 없다). withDoneStamp가
  // 참이면(ⓐ 위반 시험) 반대로 «실제로 있는» 표지를 남긴다.
  const resultContent = withDoneStamp
    ? `task_id: ${reservationId}\n>>> DONE: CODER @ 2026-09-16 08:03:19 KST\n`
    : `task_id: ${reservationId}\n`;
  writeFileSync(join(dir, "coder-task.md"), taskHeader, "utf8");
  writeFileSync(join(dir, "coder.md"), resultContent, "utf8");
  mkdirSync(join(dir, "rounds"), { recursive: true });
  writeFileSync(join(dir, "rounds", "coder-r1.md"), resultContent, "utf8");
  mkdirSync(join(dir, "retirements"), { recursive: true });
  writeFileSync(
    join(dir, "retirements", "coder-retire-r1.json"),
    JSON.stringify({
      role: "CODER",
      harnessTaskLabel: reservationId,
      archivePath: "rounds/coder-r1.md",
      archiveFingerprintClaimed: fingerprintOf(resultContent),
      blockReasonCode: "AUTHOR_SEAT_LOST_BEFORE_STAMP",
      successorLabel: `${reservationId}-successor`,
      recordedAt: "2026-09-16 08:05:19 KST",
      evidence: { source: "test" },
    }),
    "utf8",
  );
}

function runSeatLostCase(
  reservationId,
  { withDoneStamp = false, seatAlive = false } = {},
) {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    const ledgerSnapshot = seatAlive
      ? buildSeatAliveAdapterLedger(reservationId)
      : buildSeatLostAdapterLedger(reservationId);
    writeFileSync(ledger, JSON.stringify(ledgerSnapshot) + "\n", "utf8");
    seedSeatLostFixture(dir, { reservationId, withDoneStamp });

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId,
      reason: "RETIREMENT_RELEASED",
      harnessDir: dir,
      role: "CODER",
    });
    const written = JSON.parse(readFileSync(ledger, "utf8"));
    return { outcome, status: written.reservations[reservationId].status };
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("HYK-478: RETIREMENT_RELEASED for an AUTHOR_SEAT_LOST_BEFORE_STAMP retirement with both facts confirmed (0 완료 표지 + admission 원장 SUSPECT) succeeds (released, changed=true)", () => {
  const { outcome, status } = runSeatLostCase("HYK-478-sl-1");
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.ok, true, outcome.reason);
  assert.equal(status, "COMPLETED");
});

test("HYK-478: AUTHOR_SEAT_LOST_BEFORE_STAMP retirement is refused when a completion stamp is actually present (ⓐ 위반 -- 표지가 있으면서 좌석 소실만 참이어도 거부)", () => {
  const { outcome, status } = runSeatLostCase("HYK-478-sl-2", {
    withDoneStamp: true,
  });
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /재확인되지 않음/);
  // ⛔ⓑ(좌석 소실)는 이 시험에서 참이므로 원장은 SUSPECT다(admission
  // 원장 자체는 이 거부와 무관하게 sweep이 이미 새긴 상태를 유지한다) --
  // "여전히 COMPLETED로 바뀌지 않았다"가 이 시험이 실제로 증명하는 것.
  assert.equal(status, "SUSPECT");
});

test("HYK-478: AUTHOR_SEAT_LOST_BEFORE_STAMP retirement is refused when the admission ledger still shows the reservation ACTIVE (ⓑ 위반 -- 좌석이 아직 살아 있을 수도 있으면 표지가 없어도 거부)", () => {
  const { outcome, status } = runSeatLostCase("HYK-478-sl-3", {
    seatAlive: true,
  });
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /재확인되지 않음/);
  assert.equal(status, "ACTIVE");
});

test("completeAdmissionReservation without `reason` leaves completion_reason unset (byte-identical to the pre-HYK-342 ok:true path)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-342-normal-1",
      "--cap",
      "1",
    ]);
    const outcome = completeAdmissionReservation({
      reservationId: "HYK-342-normal-1",
      ledgerPath: ledger,
      lockPath: lock,
    });
    assert.equal(outcome.ok, true);
    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(
      "completion_reason" in written.reservations["HYK-342-normal-1"],
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completeAdmissionReservation fails closed (ok:false) when the ledger path does not exist", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    const outcome = completeAdmissionReservation({
      reservationId: "ghost",
      ledgerPath: ledger,
      lockPath: lock,
    });
    assert.equal(outcome.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-224-3R §3 (REVIEW 2R 반려, 검토자 실측): "잘못된 ledger로 adapter가
// 실패해도 ... 세부 오류가 비어 있었다". This pins that the failure
// `reason` string now actually CONTAINS the underlying detail (e.g. the
// real ENOENT message), not just a bare reasonCode.
test("HYK-224-3R §3: a completion failure's reason string contains the actual underlying detail, not just a bare reasonCode", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    const outcome = completeAdmissionReservation({
      reservationId: "ghost",
      ledgerPath: ledger,
      lockPath: lock,
    });
    assert.equal(outcome.ok, false);
    // Must be more than just the reasonCode token -- must contain SOME
    // actual detail text (the real fs error message), not "(no detail
    // available)" for a case where a detail genuinely exists.
    assert.match(outcome.reason, /ENOENT|no such file/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-224-3R §3 -- "최소 감사 기록": a completion failure durably appends a
// JSON line to `${ledgerPath}.completion-failures.jsonl`, independent of
// whatever happens to stdout/stderr.
test("HYK-224-3R §3: a completion failure is durably audit-logged (JSONL file next to the ledger), not just printed", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    // No init-cutover -- ledger genuinely missing, guarantees a failure.
    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({ reservationId: "HYK-AUDIT-1" });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);

    const auditPath = `${ledger}.completion-failures.jsonl`;
    assert.ok(existsSync(auditPath), `audit file must exist: ${auditPath}`);
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const record = JSON.parse(lines[lines.length - 1]);
    assert.equal(record.reservationId, "HYK-AUDIT-1");
    assert.ok(record.reasonCode, "audit record must carry a reasonCode");
    assert.ok(record.reason, "audit record must carry the full reason text");
    assert.ok(record.at, "audit record must carry a timestamp");
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-344 §1 (본체, ORCH 실측 2026-08-24 08:40): the GoLabel/Task key-drift
// repro -- a reservation is admitted under one key ('HYK-344-real-1', mirrors
// dispatch-worker.ps1's `$GoLabel`) but completion is attempted under a
// DIFFERENT key ('HYK-344-drifted-1', mirrors relay-handshake.mjs's own
// task_id-file-resolved `$Task` fallback). Pins that the adapter surfaces
// this as the distinct RESERVATION_KEY_MISMATCH reasonCode (not the bare
// RESERVATION_NOT_FOUND a truly-never-admitted round would get), names the
// real key it found, and durably records both in the audit JSONL.
test("HYK-344: a key-drift completion (reservation exists under a DIFFERENT key) surfaces RESERVATION_KEY_MISMATCH with the real key named, both in the returned reason and the durable audit record", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-344-real-1",
      "--cap",
      "1",
    ]);

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-344-drifted-1",
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "RESERVATION_KEY_MISMATCH");
    assert.match(outcome.reason, /HYK-344-real-1/);
    assert.equal(outcome.candidates.length, 1);
    assert.equal(outcome.candidates[0].reservationId, "HYK-344-real-1");

    // The mismatched-against reservation itself must stay untouched/ACTIVE
    // -- a mismatch is a rejection, never a guessed completion.
    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(written.reservations["HYK-344-real-1"].status, "ACTIVE");

    const auditPath = `${ledger}.completion-failures.jsonl`;
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const record = JSON.parse(lines[lines.length - 1]);
    assert.equal(record.reservationId, "HYK-344-drifted-1");
    assert.equal(record.reasonCode, "RESERVATION_KEY_MISMATCH");
    assert.equal(record.candidates.length, 1);
    assert.equal(record.candidates[0].reservationId, "HYK-344-real-1");
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-344 §1-3 항2: the genuinely-never-admitted case (an empty ledger, no
// candidates anywhere) must stay RESERVATION_NOT_FOUND -- distinct from the
// key-mismatch case above -- with an EMPTY candidates array, not a missing
// field (a caller/monitoring script must be able to tell "checked, found
// none" apart from "field absent, meaning unclear").
test("HYK-344: completion against a genuinely empty ledger (no reservation ever admitted) stays RESERVATION_NOT_FOUND with an empty candidates list", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({ reservationId: "HYK-344-ghost-1" });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "RESERVATION_NOT_FOUND");
    assert.deepEqual(outcome.candidates, []);
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HYK-224-3R §3: a SUCCESSFUL completion does NOT write an audit-failure record", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-AUDIT-2",
      "--cap",
      "1",
    ]);
    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({ reservationId: "HYK-AUDIT-2" });
    assert.equal(outcome.ok, true);
    assert.equal(existsSync(`${ledger}.completion-failures.jsonl`), false);
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});
