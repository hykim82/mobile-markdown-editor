import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkRetirementRecord,
  toRetirementGateDecision,
  RETIREMENT_RECORD_STATE,
  RETIREMENT_BLOCK_REASON,
  MECHANICALLY_CONFIRMABLE_BLOCK_REASONS,
} from "./retirement-record-core.mjs";

test("retirement-record-core.mjs has zero import statements (pure core contract, S8)", () => {
  const text = readFileSync(
    new URL("./retirement-record-core.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(/^import /m.test(text), false);
});

const RECORD = {
  role: "CODER",
  harnessTaskLabel: "HYK-311-blocked-round-1",
  archivePath: "rounds/CODER-r1.md",
  archiveFingerprintClaimed: "fp-archive-abc123",
  blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_TIMESTAMP_NOT_PARSEABLE,
  successorLabel: "HYK-311-blocked-round-1-next",
  recordedAt: "2026-08-19 10:00:00 KST",
};

function candidateOf(overrides, factOverrides = {}) {
  return {
    record: { ...RECORD, ...overrides },
    archiveExists: true,
    archiveFingerprintMatches: true,
    liveFingerprintMatches: true,
    blockReasonConfirmed: true,
    ...factOverrides,
  };
}

// ---------------------------------------------------------------------------
// [GREEN 정상] 아카이브 존재+지문 일치 + 사유 코드 유효 + 기계 재확인 +
// 후속 이름표 다섯 관문 전부 통과 -> RETIRED.
// ---------------------------------------------------------------------------

test("GREEN 정상: 다섯 관문 전부 통과 -> RETIRED, allow", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({})],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.RETIRED);
  assert.equal(r.ok, true);
  assert.match(r.reason, /retirement-record:/);

  const gateDecision = toRetirementGateDecision({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({})],
  });
  assert.equal(gateDecision, null, "RETIRED -> gate axis returns null (ALLOW)");
});

// ---------------------------------------------------------------------------
// [GREEN] 기계로 확인 불가능한 사유(계약 텍스트)는 blockReasonConfirmed가
// null이어도 통과한다 -- §3-4 정직 한계가 실제로 구현됐는지의 증거.
// ---------------------------------------------------------------------------

test("GREEN: 계약 텍스트 사유(DONE_REWRITE_LOCKED)는 blockReasonConfirmed:null이어도 RETIRED (기계 재확인 대상이 아님, §3-4)", () => {
  assert.equal(
    MECHANICALLY_CONFIRMABLE_BLOCK_REASONS.has(
      RETIREMENT_BLOCK_REASON.DONE_REWRITE_LOCKED,
    ),
    false,
    "전제: DONE_REWRITE_LOCKED는 기계 확인 가능 집합 밖이어야 한다",
  );
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [
      candidateOf(
        { blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_REWRITE_LOCKED },
        { blockReasonConfirmed: null },
      ),
    ],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.RETIRED);
});

// ---------------------------------------------------------------------------
// [RED 위조1] 아카이브 자체가 없음 -> ARCHIVE_MISSING.
// ---------------------------------------------------------------------------

test("RED 위조1: 아카이브 사본이 존재하지 않음 -> ARCHIVE_MISSING, 거부", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({}, { archiveExists: false })],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.ARCHIVE_MISSING);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// [RED 위조2] 아카이브 사본 지문 불일치 -> FINGERPRINT_MISMATCH.
// ---------------------------------------------------------------------------

test("RED 위조2: 아카이브 사본은 있으나 지문이 기록의 주장과 다름 -> FINGERPRINT_MISMATCH, 거부", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({}, { archiveFingerprintMatches: false })],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.FINGERPRINT_MISMATCH);
  assert.equal(r.ok, false);
});

test("RED 위조2b: 아카이브 지문은 맞지만 live 사본 지문이 어긋남 -> FINGERPRINT_MISMATCH, 거부", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({}, { liveFingerprintMatches: false })],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.FINGERPRINT_MISMATCH);
});

test("GREEN: liveFingerprintMatches가 null(도달 불가능한 방어 분기, §5-c)이어도 아카이브 지문이 맞으면 RETIRED", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({}, { liveFingerprintMatches: null })],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.RETIRED);
});

// ---------------------------------------------------------------------------
// [RED 위조3] 사유 코드가 닫힌 집합 밖 -> INVALID_REASON_CODE.
// ---------------------------------------------------------------------------

test("RED 위조3: 사유 코드가 닫힌 집합 밖(임의 문자열) -> INVALID_REASON_CODE, 거부", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({ blockReasonCode: "MADE_UP_REASON" })],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.INVALID_REASON_CODE);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// [RED 위조4] 기계 확인 가능 사유인데 독립 재확인 실패 -> BLOCK_REASON_UNCONFIRMED.
// ---------------------------------------------------------------------------

test("RED 위조4: DONE_TIMESTAMP_NOT_PARSEABLE인데 blockReasonConfirmed가 true가 아님(어댑터가 재확인 못함/ORCH 주장만) -> BLOCK_REASON_UNCONFIRMED, 거부", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({}, { blockReasonConfirmed: false })],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.BLOCK_REASON_UNCONFIRMED);

  const r2 = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({}, { blockReasonConfirmed: null })],
  });
  assert.equal(r2.state, RETIREMENT_RECORD_STATE.BLOCK_REASON_UNCONFIRMED);
});

// ---------------------------------------------------------------------------
// [RED 위조5] 후속 이름표 없음 -> SUCCESSOR_LABEL_MISSING.
// ---------------------------------------------------------------------------

test("RED 위조5: successorLabel이 비어 있음 -> SUCCESSOR_LABEL_MISSING, 거부", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({ successorLabel: "" })],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.SUCCESSOR_LABEL_MISSING);

  const r2 = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({ successorLabel: undefined })],
  });
  assert.equal(r2.state, RETIREMENT_RECORD_STATE.SUCCESSOR_LABEL_MISSING);
});

// ---------------------------------------------------------------------------
// [RED] 후보가 아예 없음 / role·harnessTaskLabel 불일치 -> NO_RECORD.
// ---------------------------------------------------------------------------

test("RED: 은퇴 기록 후보가 아예 없음(빈 배열) -> NO_RECORD, 거부", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.NO_RECORD);
  assert.equal(r.ok, false);
});

test("RED: role이 다른 후보는 무시됨 -> NO_RECORD", () => {
  const r = checkRetirementRecord({
    role: "REVIEW",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({ role: "CODER" })],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.NO_RECORD);
});

test("RED: harnessTaskLabel이 다른 후보는 무시됨 -> NO_RECORD", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: "HYK-311-different-label",
    candidates: [candidateOf({})],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.NO_RECORD);
});

test("RED: role/harnessTaskLabel이 빈 문자열인 구조적으로 무효한 레코드는 매치되지 않음 -> NO_RECORD", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({ harnessTaskLabel: "" })],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.NO_RECORD);
});

// ---------------------------------------------------------------------------
// [RED] 후보가 2개 이상 일치 -> AMBIGUOUS.
// ---------------------------------------------------------------------------

test("RED: 같은 role·같은 label의 후보가 2개 -> AMBIGUOUS, 거부(조용히 하나를 고르지 않음)", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [candidateOf({}), candidateOf({})],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.AMBIGUOUS);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// [RED] role/harnessTaskLabel 자체가 없음 -> NO_RECORD(적용 대상 미확정).
// ---------------------------------------------------------------------------

test("RED: role 또는 harnessTaskLabel이 없으면 -> NO_RECORD(적용 대상 확정 불가, 안전측 기본값)", () => {
  assert.equal(
    checkRetirementRecord({
      role: undefined,
      harnessTaskLabel: RECORD.harnessTaskLabel,
      candidates: [candidateOf({})],
    }).state,
    RETIREMENT_RECORD_STATE.NO_RECORD,
  );
  assert.equal(
    checkRetirementRecord({
      role: "CODER",
      harnessTaskLabel: undefined,
      candidates: [candidateOf({})],
    }).state,
    RETIREMENT_RECORD_STATE.NO_RECORD,
  );
});

// ---------------------------------------------------------------------------
// 대조군: 혼합 후보(다른 라운드 것들이 섞여 있어도 정확히 하나만 매치되면 RETIRED).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HYK-398: DONE_PREDATES_DROPPED_AT -- 두 번째 기계-확인-가능 사유. 집합
// 멤버십·GREEN(재확인됨)·RED(재확인 안 됨/false/null) 셋 다 DONE_TIMESTAMP_
// NOT_PARSEABLE과 대칭으로 고정한다.
// ---------------------------------------------------------------------------

test("HYK-398: DONE_PREDATES_DROPPED_AT은 기계로 확인 가능한 사유 집합의 원소다", () => {
  assert.equal(
    MECHANICALLY_CONFIRMABLE_BLOCK_REASONS.has(
      RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT,
    ),
    true,
  );
});

test("HYK-398 GREEN: DONE_PREDATES_DROPPED_AT + blockReasonConfirmed:true -> RETIRED", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [
      candidateOf({
        blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT,
      }),
    ],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.RETIRED);
  assert.equal(r.ok, true);
});

test("HYK-398 RED: DONE_PREDATES_DROPPED_AT인데 blockReasonConfirmed가 true가 아님 -> BLOCK_REASON_UNCONFIRMED, 거부", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [
      candidateOf(
        { blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT },
        { blockReasonConfirmed: false },
      ),
    ],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.BLOCK_REASON_UNCONFIRMED);

  const r2 = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [
      candidateOf(
        { blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT },
        { blockReasonConfirmed: null },
      ),
    ],
  });
  assert.equal(r2.state, RETIREMENT_RECORD_STATE.BLOCK_REASON_UNCONFIRMED);
});

// ---------------------------------------------------------------------------
// HYK-455: RUNNER_GREEN_UNREACHABLE_AT_HEAD -- 세 번째 기계-확인-가능
// 사유. 집합 멤버십·GREEN(재확인됨)·RED(재확인 안 됨/false/null) 셋 다
// 앞의 두 사유와 대칭으로 고정한다(이 코어 자신은 evidenceReceiptPath를
// 스스로 읽지 않는다 -- 재확인 자체는 어댑터 몫, 여기서는 이미 재확인된
// blockReasonConfirmed 값이 판정에 실제로 반영되는지만 증명한다).
// ---------------------------------------------------------------------------

test("HYK-455: RUNNER_GREEN_UNREACHABLE_AT_HEAD은 기계로 확인 가능한 사유 집합의 원소다", () => {
  assert.equal(
    MECHANICALLY_CONFIRMABLE_BLOCK_REASONS.has(
      RETIREMENT_BLOCK_REASON.RUNNER_GREEN_UNREACHABLE_AT_HEAD,
    ),
    true,
  );
});

test("HYK-455 GREEN: RUNNER_GREEN_UNREACHABLE_AT_HEAD + blockReasonConfirmed:true -> RETIRED", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [
      candidateOf({
        blockReasonCode:
          RETIREMENT_BLOCK_REASON.RUNNER_GREEN_UNREACHABLE_AT_HEAD,
      }),
    ],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.RETIRED);
  assert.equal(r.ok, true);
});

test("HYK-455 RED: RUNNER_GREEN_UNREACHABLE_AT_HEAD인데 blockReasonConfirmed가 true가 아님(어댑터가 러너 영수증을 재확인 못함/ORCH 주장만) -> BLOCK_REASON_UNCONFIRMED, 거부", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [
      candidateOf(
        {
          blockReasonCode:
            RETIREMENT_BLOCK_REASON.RUNNER_GREEN_UNREACHABLE_AT_HEAD,
        },
        { blockReasonConfirmed: false },
      ),
    ],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.BLOCK_REASON_UNCONFIRMED);

  const r2 = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [
      candidateOf(
        {
          blockReasonCode:
            RETIREMENT_BLOCK_REASON.RUNNER_GREEN_UNREACHABLE_AT_HEAD,
        },
        { blockReasonConfirmed: null },
      ),
    ],
  });
  assert.equal(r2.state, RETIREMENT_RECORD_STATE.BLOCK_REASON_UNCONFIRMED);
});

// ---------------------------------------------------------------------------
// HYK-478 §1-1/§1-2 -- AUTHOR_SEAT_LOST_BEFORE_STAMP(작성자 좌석이 완료
// 표지를 남기기 전에 소실됨). 앞의 셋과 동일한 형태로 고정한다(이 코어
// 자신은 ⓐ완료 표지 개수 ·ⓑadmission 원장 상태를 스스로 읽지 않는다 --
// 재확인 자체는 어댑터/공유 confirm 함수 몫, 여기서는 이미 재확인된
// blockReasonConfirmed 값이 판정에 실제로 반영되는지만 증명한다).
// ---------------------------------------------------------------------------

test("HYK-478: AUTHOR_SEAT_LOST_BEFORE_STAMP는 기계로 확인 가능한 사유 집합의 원소다", () => {
  assert.equal(
    MECHANICALLY_CONFIRMABLE_BLOCK_REASONS.has(
      RETIREMENT_BLOCK_REASON.AUTHOR_SEAT_LOST_BEFORE_STAMP,
    ),
    true,
  );
});

test("HYK-478 GREEN: AUTHOR_SEAT_LOST_BEFORE_STAMP + blockReasonConfirmed:true -> RETIRED", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [
      candidateOf({
        blockReasonCode: RETIREMENT_BLOCK_REASON.AUTHOR_SEAT_LOST_BEFORE_STAMP,
      }),
    ],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.RETIRED);
  assert.equal(r.ok, true);
});

test("HYK-478 RED: AUTHOR_SEAT_LOST_BEFORE_STAMP인데 blockReasonConfirmed가 true가 아님(ⓐ완료 표지·ⓑ좌석 소실 중 하나라도 어댑터가 재확인 못함/ORCH 주장만) -> BLOCK_REASON_UNCONFIRMED, 거부", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [
      candidateOf(
        {
          blockReasonCode:
            RETIREMENT_BLOCK_REASON.AUTHOR_SEAT_LOST_BEFORE_STAMP,
        },
        { blockReasonConfirmed: false },
      ),
    ],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.BLOCK_REASON_UNCONFIRMED);

  const r2 = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [
      candidateOf(
        {
          blockReasonCode:
            RETIREMENT_BLOCK_REASON.AUTHOR_SEAT_LOST_BEFORE_STAMP,
        },
        { blockReasonConfirmed: null },
      ),
    ],
  });
  assert.equal(r2.state, RETIREMENT_RECORD_STATE.BLOCK_REASON_UNCONFIRMED);
});

test("대조군: 다른 라운드의 후보들이 섞여 있어도 role+label이 일치하는 것은 정확히 하나 -> RETIRED", () => {
  const r = checkRetirementRecord({
    role: "CODER",
    harnessTaskLabel: RECORD.harnessTaskLabel,
    candidates: [
      candidateOf({ harnessTaskLabel: "HYK-1-other-round" }),
      candidateOf({}),
      candidateOf({ role: "REVIEW", harnessTaskLabel: "HYK-2-other-role" }),
    ],
  });
  assert.equal(r.state, RETIREMENT_RECORD_STATE.RETIRED);
});
