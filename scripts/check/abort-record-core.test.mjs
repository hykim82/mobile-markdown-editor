import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkAbortRecord,
  toAbortRecordGateDecision,
  ABORT_RECORD_STATE,
} from "./abort-record-core.mjs";

test("abort-record-core.mjs has zero import statements (pure core contract, S8)", () => {
  const text = readFileSync(
    new URL("./abort-record-core.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(/^import /m.test(text), false);
});

const RECORD = {
  role: "REVIEW",
  harnessTaskLabel: "HYK-298-dead-round-1",
  dispatchId: "ctx_abort_test_1",
  droppedAt: "2026-08-18 03:00:00 KST",
  leftoverFingerprint: "fp-dead-review-abc123",
  leftoverPath: ".harness/review.md",
};

function candidateOf(overrides, verifiedOverrides = {}) {
  return {
    record: { ...RECORD, ...overrides },
    dispatchIdVerified: true,
    recoveryMarkerVerified: true,
    ...verifiedOverrides,
  };
}

// ---------------------------------------------------------------------------
// [GREEN 정상] 지문 일치 + dispatchId 검증 + 회수 표식 검증 전부 -> VERIFIED.
// ---------------------------------------------------------------------------

test("GREEN 정상: 지문·dispatchId·회수표식 셋 다 검증됨 -> VERIFIED, allow", () => {
  const r = checkAbortRecord({
    role: "REVIEW",
    liveFingerprint: RECORD.leftoverFingerprint,
    candidates: [candidateOf({})],
  });
  assert.equal(r.state, ABORT_RECORD_STATE.VERIFIED);
  assert.equal(r.ok, true);
  assert.match(r.reason, /abort-record:/);

  const gateDecision = toAbortRecordGateDecision({
    role: "REVIEW",
    liveFingerprint: RECORD.leftoverFingerprint,
    candidates: [candidateOf({})],
  });
  assert.equal(
    gateDecision,
    null,
    "VERIFIED -> gate axis returns null (ALLOW)",
  );
});

// ---------------------------------------------------------------------------
// [RED 위조1] 지문 불일치 -> NO_RECORD (이 후보는 이 라운드의 것이 아니다).
// ---------------------------------------------------------------------------

test("RED 위조1: live 지문과 기록의 leftoverFingerprint가 다름(위조 지문) -> NO_RECORD, 거부", () => {
  const r = checkAbortRecord({
    role: "REVIEW",
    liveFingerprint: "fp-actually-different-live-content",
    candidates: [candidateOf({})],
  });
  assert.equal(r.state, ABORT_RECORD_STATE.NO_RECORD);
  assert.equal(r.ok, false);
  assert.match(r.reason, /일치하는 중단 기록 후보가 하나도 없음/);

  const decision = toAbortRecordGateDecision({
    role: "REVIEW",
    liveFingerprint: "fp-actually-different-live-content",
    candidates: [candidateOf({})],
  });
  assert.notEqual(decision, null);
  assert.equal(decision.allow, false);
});

// ---------------------------------------------------------------------------
// [RED 위조2] 기록의 dispatchId가 배달 영수증에서 확인 안 됨(위조) -> DISPATCH_ID_UNVERIFIED.
// ---------------------------------------------------------------------------

test("RED 위조2: dispatchId가 배달 영수증과 대조되지 않음(위조/불명) -> DISPATCH_ID_UNVERIFIED, 거부", () => {
  const r = checkAbortRecord({
    role: "REVIEW",
    liveFingerprint: RECORD.leftoverFingerprint,
    candidates: [candidateOf({}, { dispatchIdVerified: false })],
  });
  assert.equal(r.state, ABORT_RECORD_STATE.DISPATCH_ID_UNVERIFIED);
  assert.equal(r.ok, false);
  assert.match(r.reason, /dispatchId가 배달 영수증.*확인되지 않음/);
});

// ---------------------------------------------------------------------------
// [RED 위조3] 원장에 SUSPECT_TIMEOUT_RECOVERED 표식이 없음(회수 사실 미확인) -> RECOVERY_MARKER_MISSING.
// ---------------------------------------------------------------------------

test("RED 위조3: dispatchId는 검증됐지만 admission 원장에 회수 표식(SUSPECT_TIMEOUT_RECOVERED)이 없음 -> RECOVERY_MARKER_MISSING, 거부", () => {
  const r = checkAbortRecord({
    role: "REVIEW",
    liveFingerprint: RECORD.leftoverFingerprint,
    candidates: [candidateOf({}, { recoveryMarkerVerified: false })],
  });
  assert.equal(r.state, ABORT_RECORD_STATE.RECOVERY_MARKER_MISSING);
  assert.equal(r.ok, false);
  assert.match(r.reason, /회수 표식\(SUSPECT_TIMEOUT_RECOVERED\)이 없음/);
});

// ---------------------------------------------------------------------------
// [RED] 후보가 아예 없음 -> NO_RECORD.
// ---------------------------------------------------------------------------

test("RED: 중단 기록 후보가 아예 없음(빈 배열) -> NO_RECORD, 거부", () => {
  const r = checkAbortRecord({
    role: "REVIEW",
    liveFingerprint: RECORD.leftoverFingerprint,
    candidates: [],
  });
  assert.equal(r.state, ABORT_RECORD_STATE.NO_RECORD);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// [RED] role이 다른 후보는 무시됨 -> NO_RECORD (role도 별개로 재확인한다).
// ---------------------------------------------------------------------------

test("RED: role이 다른 후보(지문은 우연히 같음)는 무시됨 -> NO_RECORD", () => {
  const r = checkAbortRecord({
    role: "CODER",
    liveFingerprint: RECORD.leftoverFingerprint,
    candidates: [candidateOf({ role: "REVIEW" })],
  });
  assert.equal(r.state, ABORT_RECORD_STATE.NO_RECORD);
});

// ---------------------------------------------------------------------------
// [RED] 구조적으로 무효한 레코드(필드 비어 있음)는 매치 대상에서 제외.
// ---------------------------------------------------------------------------

test("RED: harnessTaskLabel이 빈 문자열인 구조적으로 무효한 레코드는 매치되지 않음(빈 값끼리 새는 구멍 차단) -> NO_RECORD", () => {
  const r = checkAbortRecord({
    role: "REVIEW",
    liveFingerprint: RECORD.leftoverFingerprint,
    candidates: [candidateOf({ harnessTaskLabel: "" })],
  });
  assert.equal(r.state, ABORT_RECORD_STATE.NO_RECORD);
});

test("RED: dispatchId가 없는(undefined) 레코드는 매치되지 않음 -> NO_RECORD", () => {
  const r = checkAbortRecord({
    role: "REVIEW",
    liveFingerprint: RECORD.leftoverFingerprint,
    candidates: [candidateOf({ dispatchId: undefined })],
  });
  assert.equal(r.state, ABORT_RECORD_STATE.NO_RECORD);
});

// ---------------------------------------------------------------------------
// [RED] 후보가 2개 이상 일치 -> AMBIGUOUS(조용히 하나를 고르지 않는다).
// ---------------------------------------------------------------------------

test("RED: 같은 role·같은 지문의 후보가 2개 -> AMBIGUOUS, 거부(조용히 하나를 고르지 않음)", () => {
  const r = checkAbortRecord({
    role: "REVIEW",
    liveFingerprint: RECORD.leftoverFingerprint,
    candidates: [
      candidateOf({ harnessTaskLabel: "HYK-298-dead-round-1" }),
      candidateOf({ harnessTaskLabel: "HYK-298-dead-round-1-dup" }),
    ],
  });
  assert.equal(r.state, ABORT_RECORD_STATE.AMBIGUOUS);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// [RED] role/liveFingerprint 자체가 없음 -> NO_RECORD(적용 대상 미확정).
// ---------------------------------------------------------------------------

test("RED: role 또는 liveFingerprint가 없으면 -> NO_RECORD(적용 대상 확정 불가, 안전측 기본값)", () => {
  assert.equal(
    checkAbortRecord({
      role: undefined,
      liveFingerprint: RECORD.leftoverFingerprint,
      candidates: [candidateOf({})],
    }).state,
    ABORT_RECORD_STATE.NO_RECORD,
  );
  assert.equal(
    checkAbortRecord({
      role: "REVIEW",
      liveFingerprint: undefined,
      candidates: [candidateOf({})],
    }).state,
    ABORT_RECORD_STATE.NO_RECORD,
  );
});

// ---------------------------------------------------------------------------
// 대조군: 혼합 후보(다른 라운드 것들이 섞여 있어도 정확히 하나만 매치되면 VERIFIED).
// ---------------------------------------------------------------------------

test("대조군: 다른 라운드의 후보들이 섞여 있어도 지문이 일치하는 것은 정확히 하나 -> VERIFIED", () => {
  const r = checkAbortRecord({
    role: "REVIEW",
    liveFingerprint: RECORD.leftoverFingerprint,
    candidates: [
      candidateOf({
        harnessTaskLabel: "HYK-1-other-round",
        leftoverFingerprint: "fp-completely-different",
      }),
      candidateOf({}),
      candidateOf({ role: "CODER", harnessTaskLabel: "HYK-2-other-role" }),
    ],
  });
  assert.equal(r.state, ABORT_RECORD_STATE.VERIFIED);
});
