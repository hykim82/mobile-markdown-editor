import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkConsumptionReceipt,
  toConsumptionGateDecision,
  CONSUMPTION_RECEIPT_STATE,
} from "./consumption-receipt-core.mjs";
import { combineGateDecisions } from "./dispatch-gate-decision-core.mjs";

test("consumption-receipt-core.mjs has zero import statements (pure core contract, S8)", () => {
  const text = readFileSync(
    new URL("./consumption-receipt-core.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(/^import /m.test(text), false);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CODER_BINDING = {
  taskId: "HYK-244",
  role: "CODER",
  droppedAt: "2026-08-14 05:38 KST",
  resultFingerprint: "fp-1d-coder-9f3a21",
  dispatchId: "ctx_b880217cff07",
  doneAt: "2026-08-14 05:49:12 KST",
};

const CODER_EFFECTS_OK = {
  envelopeArchived: true,
  taskArchived: true,
  admissionReturned: true,
};

const REVIEW_BINDING = {
  taskId: "HYK-244",
  role: "REVIEW",
  droppedAt: "2026-08-14 09:00 KST",
  resultFingerprint: "fp-1d-review-77bc40",
  dispatchId: "ctx_review_1d",
  doneAt: "2026-08-14 09:12:41 KST",
};

const REVIEW_EFFECTS_OK = {
  envelopeArchived: true,
  taskArchived: true,
  admissionReturned: true,
  ledgerRecorded: true,
};

// ---------------------------------------------------------------------------
// [GREEN 정상] 결속 일치 + 필수 후속효과 전부 성공 -> 막지 않는다.
// ---------------------------------------------------------------------------

test("GREEN 정상 (CODER): binding matches, all required effects true -> PASS, allow", () => {
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [{ binding: CODER_BINDING, effects: CODER_EFFECTS_OK }],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.PASS);
  assert.equal(r.ok, true);
  assert.match(r.reason, /소비 완료로 판정/);
  assert.match(r.reason, /envelopeArchived/);

  const decision = toConsumptionGateDecision({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [{ binding: CODER_BINDING, effects: CODER_EFFECTS_OK }],
  });
  assert.equal(decision, null);
});

test("GREEN 정상 (REVIEW): binding matches, exactly one verdict line, ledgerRecorded true -> PASS", () => {
  const r = checkConsumptionReceipt({
    role: "REVIEW",
    currentBinding: REVIEW_BINDING,
    candidates: [
      {
        binding: REVIEW_BINDING,
        effects: REVIEW_EFFECTS_OK,
        verdictLineCount: 1,
      },
    ],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.PASS);
  assert.equal(r.ok, true);
  assert.match(r.reason, /ledgerRecorded/);
});

// ---------------------------------------------------------------------------
// [GREEN 과거파일] 과거 라운드의 결과 파일이 남아 있어도 현재 라운드와
// 결속이 다르면 그것을 "현재 미소비"로 오인하지 않는다.
// ---------------------------------------------------------------------------

test("GREEN 과거파일: a stale prior-round candidate with different droppedAt coexists, current round still resolves to PASS", () => {
  const staleFromPriorRound = {
    binding: { ...CODER_BINDING, droppedAt: "2026-08-13 05:38 KST" },
    // The stale round's own effects are irrelevant to this round's verdict --
    // deliberately left incomplete to prove it is never consulted.
    effects: {
      envelopeArchived: true,
      taskArchived: false,
      admissionReturned: false,
    },
  };
  const currentReceipt = { binding: CODER_BINDING, effects: CODER_EFFECTS_OK };

  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [staleFromPriorRound, currentReceipt],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.PASS);
  assert.equal(r.ok, true);
  // The stale candidate's own broken effects (taskArchived/admissionReturned
  // false) never surface as a failure reason -- proof it was filtered out by
  // binding, not merely outvoted.
  assert.doesNotMatch(r.reason, /성공 확인되지 않음/);
});

// ---------------------------------------------------------------------------
// [RED 누락] 정상 입력에서 영수증만 제거 -> 거부.
// ---------------------------------------------------------------------------

test("RED 누락: no candidates at all -> RECEIPT_MISSING, distinct state + reason names the missing receipt", () => {
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.RECEIPT_MISSING);
  assert.equal(r.ok, false);
  assert.match(r.reason, /영수증 후보가 하나도 없음/);

  const decision = toConsumptionGateDecision({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: undefined,
  });
  assert.equal(decision.state, CONSUMPTION_RECEIPT_STATE.RECEIPT_MISSING);
  assert.equal(decision.allow, false);
});

// ---------------------------------------------------------------------------
// [RED 결속변이] 영수증의 결속 값 중 하나만 현재와 다르게 -> 거부.
// ---------------------------------------------------------------------------

test("RED 결속변이 (droppedAt only): -> BINDING_MISMATCH, distinct state + reason shows both bindings", () => {
  const mutated = {
    binding: { ...CODER_BINDING, droppedAt: "2026-08-14 06:00 KST" },
    effects: CODER_EFFECTS_OK,
  };
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [mutated],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
  assert.equal(r.ok, false);
  assert.match(r.reason, /2026-08-14 05:38 KST/);
  assert.match(r.reason, /2026-08-14 06:00 KST/);
});

test("RED 결속변이 (taskId only): -> BINDING_MISMATCH, same distinct state as droppedAt mutation", () => {
  const mutated = {
    binding: { ...CODER_BINDING, taskId: "HYK-999" },
    effects: CODER_EFFECTS_OK,
  };
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [mutated],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
  assert.equal(r.ok, false);
});

test("RED 결속변이 (role only): -> BINDING_MISMATCH, same distinct state as the other single-field mutations", () => {
  const mutated = {
    binding: { ...CODER_BINDING, role: "VERIFY" },
    effects: CODER_EFFECTS_OK,
  };
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [mutated],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
  assert.equal(r.ok, false);
});

// HYK-244-receipt-core-1c (검토 1R 반려 원문 6번 대응): doneAt은 §3가
// 새로 추가한 4번째 결속 성분이다 -- droppedAt이 분 단위라 같은 분에
// 재배달된 두 라운드를 못 가르는 문제를 doneAt(초 단위 원문)으로 메운다.
// 이 시험은 그 성분 하나만 달라도 결속 불일치가 되는 것을 직접 확인한다.
test("RED 결속변이 (doneAt only): -> BINDING_MISMATCH -- 4번째 결속 성분도 단독 변이에 반응한다", () => {
  const mutated = {
    binding: { ...CODER_BINDING, doneAt: "2026-08-14 05:49:59 KST" },
    effects: CODER_EFFECTS_OK,
  };
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [mutated],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// HYK-244-receipt-core-1d (★한용 확정 §3, 검토 1R-c 재검 «반려2»/«신규
// 결함» 대응): 주 열쇠 = resultFingerprint + dispatchId. §4 지정 시험
// 그대로 -- 지문/식별자 단독 변이 거부, 누락(양쪽 다 없음 포함) 거부,
// 완료시각 누락·분단위 거부, 그리고 «신규 결함»의 정확한 재현+수리 증명.
// ---------------------------------------------------------------------------

test("RED 결과물 지문만 다른 후보 -> BINDING_MISMATCH (주 열쇠 성분1)", () => {
  const mutated = {
    binding: { ...CODER_BINDING, resultFingerprint: "fp-different-round" },
    effects: CODER_EFFECTS_OK,
  };
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [mutated],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
  assert.equal(r.ok, false);
});

test("RED 배달 식별자만 다른 후보 -> BINDING_MISMATCH (주 열쇠 성분2)", () => {
  const mutated = {
    binding: { ...CODER_BINDING, dispatchId: "ctx_different_dispatch" },
    effects: CODER_EFFECTS_OK,
  };
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [mutated],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
  assert.equal(r.ok, false);
});

test("RED 결과물 지문 누락(현재 라운드 자신의 결속에 없음, 후보와 무관) -> BINDING_MISMATCH, candidates를 보기도 전에 거부", () => {
  const currentWithoutFingerprint = {
    ...CODER_BINDING,
    resultFingerprint: undefined,
  };
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: currentWithoutFingerprint,
    candidates: [{ binding: CODER_BINDING, effects: CODER_EFFECTS_OK }],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
  assert.equal(r.ok, false);
  assert.match(r.reason, /결과물 지문/);
});

test("RED 배달 식별자 누락(현재 라운드 자신의 결속에 없음) -> BINDING_MISMATCH", () => {
  const currentWithoutDispatchId = { ...CODER_BINDING, dispatchId: "" };
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: currentWithoutDispatchId,
    candidates: [{ binding: CODER_BINDING, effects: CODER_EFFECTS_OK }],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
  assert.equal(r.ok, false);
  assert.match(r.reason, /배달 식별자/);
});

test("RED 완료시각 누락(현재 라운드 자신의 결속에 없음) -> BINDING_MISMATCH", () => {
  const currentWithoutDoneAt = { ...CODER_BINDING, doneAt: undefined };
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: currentWithoutDoneAt,
    candidates: [{ binding: CODER_BINDING, effects: CODER_EFFECTS_OK }],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
  assert.equal(r.ok, false);
  assert.match(r.reason, /완료시각\(doneAt\)이 없거나/);
});

test("RED 완료시각이 분 단위(초 없음, 검토자 실측 그대로 '2026-08-14 06:13 KST') -> BINDING_MISMATCH", () => {
  const currentMinutePrecision = {
    ...CODER_BINDING,
    doneAt: "2026-08-14 06:13 KST",
  };
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: currentMinutePrecision,
    candidates: [
      {
        binding: { ...CODER_BINDING, doneAt: "2026-08-14 06:13 KST" },
        effects: CODER_EFFECTS_OK,
      },
    ],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
  assert.equal(r.ok, false);
  assert.match(r.reason, /초 단위 정밀도가 아님/);
});

// HYK-244-receipt-core-1d (검토 1R-c 재검 «신규 결함» 원문 정확 재현 +
// 수리 증명): 검토자의 정확한 재현 절차 -- "현재·후보 결속 양쪽에서
// doneAt을 빼고 필수 공통 효과를 true로 넣은 직접 호출 결과가 PASS였다."
// 수리 전이면 이 시험은 PASS를 내야 정상이고(=버그), 수리 후에는
// BINDING_MISMATCH가 나와야 한다(=고쳐짐). 아래 §4 변이 표의 mutation
// 재현과 쌍을 이룬다.
test("신규 결함 재현: 현재·후보 결속 양쪽에서 doneAt이 둘 다 없어도(undefined===undefined) 더 이상 PASS로 새지 않는다", () => {
  const bothMissingDoneAt = { ...CODER_BINDING, doneAt: undefined };
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: bothMissingDoneAt,
    candidates: [
      {
        binding: { ...CODER_BINDING, doneAt: undefined },
        effects: CODER_EFFECTS_OK,
      },
    ],
  });
  assert.notEqual(r.state, CONSUMPTION_RECEIPT_STATE.PASS);
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
  assert.equal(r.ok, false);
});

test("신규 결함과 같은 형태: 결과물 지문이 양쪽 다 없어도(undefined===undefined) PASS로 새지 않는다", () => {
  const bothMissingFingerprint = {
    ...CODER_BINDING,
    resultFingerprint: undefined,
  };
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: bothMissingFingerprint,
    candidates: [
      {
        binding: { ...CODER_BINDING, resultFingerprint: undefined },
        effects: CODER_EFFECTS_OK,
      },
    ],
  });
  assert.notEqual(r.state, CONSUMPTION_RECEIPT_STATE.PASS);
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
});

test("신규 결함과 같은 형태: 배달 식별자가 양쪽 다 없어도(undefined===undefined) PASS로 새지 않는다", () => {
  const bothMissingDispatchId = { ...CODER_BINDING, dispatchId: undefined };
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: bothMissingDispatchId,
    candidates: [
      {
        binding: { ...CODER_BINDING, dispatchId: undefined },
        effects: CODER_EFFECTS_OK,
      },
    ],
  });
  assert.notEqual(r.state, CONSUMPTION_RECEIPT_STATE.PASS);
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
});

// GREEN -- §4 지정: 주 열쇠 2종 + 완료시각(초 단위)이 전부 일치하고 필수
// 후속효과가 전부 성공하면 통과(GREEN 정상 시험과 같은 계약을 주 열쇠
// 재설계 이후 명시적으로 다시 확인).
test("GREEN 주 열쇠 확인: resultFingerprint+dispatchId+doneAt(초단위) 전부 일치 + 효과 전부 성공 -> PASS", () => {
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [{ binding: { ...CODER_BINDING }, effects: CODER_EFFECTS_OK }],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.PASS);
  assert.equal(r.ok, true);
});

// GREEN -- §4 지정: 과거 라운드 후보가 남아 있어도 주 열쇠(지문+식별자)가
// 다르면 현재 미소비로 오인하지 않는다.
test("GREEN 과거 라운드(주 열쇠가 다름)가 남아 있어도 현재 라운드는 정확히 구별되어 PASS", () => {
  const staleWithDifferentPrimaryKey = {
    binding: {
      ...CODER_BINDING,
      resultFingerprint: "fp-prior-round-stale",
      dispatchId: "ctx_prior_dispatch",
      doneAt: "2026-08-13 05:38:07 KST",
    },
    effects: {
      envelopeArchived: true,
      taskArchived: false,
      admissionReturned: false,
    },
  };
  const currentReceipt = { binding: CODER_BINDING, effects: CODER_EFFECTS_OK };

  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [staleWithDifferentPrimaryKey, currentReceipt],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.PASS);
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.reason, /성공 확인되지 않음/);
});

// HYK-244-receipt-core-1c (검토 1R 반려 원문 6번 재현 + 수리 증명): 검토자가
// 실측한 그대로 -- 같은 이슈·같은 역할의 두 라운드가 같은 "분"에 드롭되면
// (droppedAt 동일) taskId+role+droppedAt 3성분만으로는 구별이 안 됐다.
// doneAt(각 라운드 자신의 완료 시각, 초 단위)을 4번째 성분으로 추가한
// 뒤에는 같은 분에 드롭된 두 라운드도 서로 다른 doneAt으로 구별된다 --
// 과거 라운드(같은 droppedAt, 다른 doneAt)가 남아 있어도 현재 라운드
// 자신의 영수증(현재 doneAt과 일치)만 골라 PASS한다.
test("같은 분 두 라운드: droppedAt은 동일하지만 주 열쇠(지문+식별자)가 다른 과거 라운드가 남아 있어도 현재 라운드는 정확히 구별되어 PASS", () => {
  const sameMinuteDroppedAt = "2026-08-14 05:38 KST"; // 두 라운드가 공유하는 "같은 분"
  const priorRoundBinding = {
    taskId: "HYK-244",
    role: "CODER",
    droppedAt: sameMinuteDroppedAt,
    resultFingerprint: "fp-1d-prior-round", // 과거 라운드 자신의 주 열쇠(다름)
    dispatchId: "ctx_prior_round_1d",
    doneAt: "2026-08-14 05:38:07 KST", // 과거 라운드 자신의 완료 시각(다름)
  };
  const currentRoundBinding = {
    taskId: "HYK-244",
    role: "CODER",
    droppedAt: sameMinuteDroppedAt, // 검토자 반례: droppedAt이 우연히 같다
    resultFingerprint: "fp-1d-current-round", // 현재 라운드 자신의 주 열쇠(다름)
    dispatchId: "ctx_current_round_1d",
    doneAt: "2026-08-14 05:38:53 KST", // 현재 라운드 자신의 완료 시각(다름)
  };
  const priorRoundReceipt = {
    binding: priorRoundBinding,
    // 과거 라운드는 사실 부분 실패였다고 가정 -- 그런데도 절대 현재 라운드의
    // 판정에 섞이지 않는다는 것을 이 시험이 증명한다.
    effects: {
      envelopeArchived: true,
      taskArchived: false,
      admissionReturned: false,
    },
  };
  const currentRoundReceipt = {
    binding: currentRoundBinding,
    effects: CODER_EFFECTS_OK,
  };

  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: currentRoundBinding,
    candidates: [priorRoundReceipt, currentRoundReceipt],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.PASS);
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.reason, /성공 확인되지 않음/);
});

test("같은 분 두 라운드: 현재 라운드 자신의 영수증이 아직 없고 과거 라운드(같은 droppedAt, 다른 주 열쇠)만 있으면 -> BINDING_MISMATCH(과거 것을 현재 것으로 오인하지 않는다)", () => {
  const sameMinuteDroppedAt = "2026-08-14 05:38 KST";
  const priorRoundBinding = {
    taskId: "HYK-244",
    role: "CODER",
    droppedAt: sameMinuteDroppedAt,
    resultFingerprint: "fp-1d-prior-round",
    dispatchId: "ctx_prior_round_1d",
    doneAt: "2026-08-14 05:38:07 KST",
  };
  const currentRoundBinding = {
    taskId: "HYK-244",
    role: "CODER",
    droppedAt: sameMinuteDroppedAt,
    resultFingerprint: "fp-1d-current-round",
    dispatchId: "ctx_current_round_1d",
    doneAt: "2026-08-14 05:38:53 KST",
  };

  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: currentRoundBinding,
    candidates: [{ binding: priorRoundBinding, effects: CODER_EFFECTS_OK }],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// HYK-244-receipt-core-1c (검토 1R 반려 원문 5번 대응): REVIEW 계열 판별은
// role === "REVIEW" 정확 일치가 아니라 reject-streak.mjs의 REVIEW_ROLE_RE
// (`/^review/i`)를 그대로 복제해 쓴다 -- 실제 relay-handshake.mjs 호출
// 관례가 소문자 "review"이기 때문이다(검토자가 소문자 role로 직접 재현).
// ---------------------------------------------------------------------------

test("REVIEW 계열 판별 (소문자 'review'): ledgerRecorded 누락 -> PARTIAL_SUCCESS, PASS로 새지 않는다", () => {
  const lowerReviewBinding = { ...REVIEW_BINDING, role: "review" };
  const r = checkConsumptionReceipt({
    role: "review",
    currentBinding: lowerReviewBinding,
    candidates: [
      {
        binding: lowerReviewBinding,
        effects: { ...REVIEW_EFFECTS_OK, ledgerRecorded: false },
        verdictLineCount: 1,
      },
    ],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.PARTIAL_SUCCESS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /ledgerRecorded/);
});

test("REVIEW 계열 판별 (후속 표기 'review2'): ledgerRecorded 누락 -> PARTIAL_SUCCESS, PASS로 새지 않는다", () => {
  const review2Binding = { ...REVIEW_BINDING, role: "review2" };
  const r = checkConsumptionReceipt({
    role: "review2",
    currentBinding: review2Binding,
    candidates: [
      {
        binding: review2Binding,
        effects: { ...REVIEW_EFFECTS_OK, ledgerRecorded: false },
        verdictLineCount: 1,
      },
    ],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.PARTIAL_SUCCESS);
  assert.match(r.reason, /ledgerRecorded/);
});

test("REVIEW 계열 판별 (소문자 'review'): 판정 줄이 1개가 아니면 -> VERDICT_AMBIGUOUS(대문자 REVIEW와 동일하게 동작)", () => {
  const lowerReviewBinding = { ...REVIEW_BINDING, role: "review" };
  const r = checkConsumptionReceipt({
    role: "review",
    currentBinding: lowerReviewBinding,
    candidates: [
      {
        binding: lowerReviewBinding,
        effects: REVIEW_EFFECTS_OK,
        verdictLineCount: 0,
      },
    ],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.VERDICT_AMBIGUOUS);
});

test("REVIEW 계열이 아닌 role('coder', 'verify')은 ledgerRecorded가 없어도 PARTIAL_SUCCESS로 새지 않는다(오탐 0 대조군)", () => {
  const rCoder = checkConsumptionReceipt({
    role: "coder",
    currentBinding: { ...CODER_BINDING, role: "coder" },
    candidates: [
      {
        binding: { ...CODER_BINDING, role: "coder" },
        effects: CODER_EFFECTS_OK,
      },
    ],
  });
  assert.equal(rCoder.state, CONSUMPTION_RECEIPT_STATE.PASS);

  const verifyBinding = { ...CODER_BINDING, role: "verify" };
  const rVerify = checkConsumptionReceipt({
    role: "verify",
    currentBinding: verifyBinding,
    candidates: [{ binding: verifyBinding, effects: CODER_EFFECTS_OK }],
  });
  assert.equal(rVerify.state, CONSUMPTION_RECEIPT_STATE.PASS);
});

// ---------------------------------------------------------------------------
// [RED 부분성공] 필수 후속효과 중 하나만 실패·미확인 -> 거부.
// ---------------------------------------------------------------------------

test("RED 부분성공 (admissionReturned false): -> PARTIAL_SUCCESS, reason names exactly the failed key", () => {
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [
      {
        binding: CODER_BINDING,
        effects: { ...CODER_EFFECTS_OK, admissionReturned: false },
      },
    ],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.PARTIAL_SUCCESS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /admissionReturned/);
  assert.doesNotMatch(r.reason, /envelopeArchived 이\(가\)/);
});

test("RED 부분성공 (REVIEW ledgerRecorded unconfirmed, others true): -> PARTIAL_SUCCESS names ledgerRecorded specifically", () => {
  const r = checkConsumptionReceipt({
    role: "REVIEW",
    currentBinding: REVIEW_BINDING,
    candidates: [
      {
        binding: REVIEW_BINDING,
        effects: { ...REVIEW_EFFECTS_OK, ledgerRecorded: false },
        verdictLineCount: 1,
      },
    ],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.PARTIAL_SUCCESS);
  assert.match(r.reason, /ledgerRecorded/);
});

// ---------------------------------------------------------------------------
// [RED 판정모호] REVIEW 결과에 승인·반려가 함께 있거나 판정이 없음 ->
// 판정을 고르지 않고 영수증 미발행 상태로 멈춤 + 거부.
// ---------------------------------------------------------------------------

test("RED 판정모호 (verdict lines: 2, 승인+반려 함께): -> VERDICT_AMBIGUOUS, distinct from PARTIAL_SUCCESS/BINDING_MISMATCH", () => {
  const r = checkConsumptionReceipt({
    role: "REVIEW",
    currentBinding: REVIEW_BINDING,
    candidates: [
      {
        binding: REVIEW_BINDING,
        effects: REVIEW_EFFECTS_OK,
        verdictLineCount: 2,
      },
    ],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.VERDICT_AMBIGUOUS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /판정 줄이 정확히 1개가 아님/);
  assert.match(r.reason, /2개/);
});

test("RED 판정모호 (verdict lines: 0, 판정 없음): -> VERDICT_AMBIGUOUS, reason reflects zero", () => {
  const r = checkConsumptionReceipt({
    role: "REVIEW",
    currentBinding: REVIEW_BINDING,
    candidates: [
      {
        binding: REVIEW_BINDING,
        effects: REVIEW_EFFECTS_OK,
        verdictLineCount: 0,
      },
    ],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.VERDICT_AMBIGUOUS);
  assert.match(r.reason, /0개/);
});

test("RED 판정모호 (verdict lines: undefined for REVIEW): -> VERDICT_AMBIGUOUS, never silently treated as 1", () => {
  const r = checkConsumptionReceipt({
    role: "REVIEW",
    currentBinding: REVIEW_BINDING,
    candidates: [{ binding: REVIEW_BINDING, effects: REVIEW_EFFECTS_OK }],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.VERDICT_AMBIGUOUS);
});

// ---------------------------------------------------------------------------
// Multiple exact-binding matches -> also VERDICT_AMBIGUOUS (§4 header:
// "조용히 하나를 고르지 않는다" reused for the receipt-count axis too).
// ---------------------------------------------------------------------------

test("two candidates both matching current binding -> VERDICT_AMBIGUOUS, never silently picks one", () => {
  const r = checkConsumptionReceipt({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [
      { binding: CODER_BINDING, effects: CODER_EFFECTS_OK },
      {
        binding: CODER_BINDING,
        effects: { ...CODER_EFFECTS_OK, taskArchived: false },
      },
    ],
  });
  assert.equal(r.state, CONSUMPTION_RECEIPT_STATE.VERDICT_AMBIGUOUS);
  assert.match(r.reason, /2개/);
});

// ---------------------------------------------------------------------------
// Adapter shape (§2-B): PASS -> null, otherwise {state, allow:false, reason}
// -- and it must compose with combineGateDecisions unchanged.
// ---------------------------------------------------------------------------

test("adapter: non-PASS decision composes into combineGateDecisions like any other gate axis", () => {
  const consumptionDecision = toConsumptionGateDecision({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [],
  });
  const otherAxisAllow = null; // e.g. an already-passing dispatch-gate-decision-core axis
  const combined = combineGateDecisions(
    [consumptionDecision, otherAxisAllow].filter(Boolean),
  );
  assert.equal(combined.allow, false);
  assert.deepEqual(combined.states, [
    CONSUMPTION_RECEIPT_STATE.RECEIPT_MISSING,
  ]);
});

test("adapter: PASS -> null composes into an all-allow combineGateDecisions call", () => {
  const consumptionDecision = toConsumptionGateDecision({
    role: "CODER",
    currentBinding: CODER_BINDING,
    candidates: [{ binding: CODER_BINDING, effects: CODER_EFFECTS_OK }],
  });
  assert.equal(consumptionDecision, null);
  // A null entry must never be forwarded into combineGateDecisions as-is
  // (its own contract reads `d?.allow === true`, and `null?.allow` is
  // undefined, not true) -- callers only push non-null decisions in.
  const combined = combineGateDecisions([consumptionDecision].filter(Boolean));
  assert.equal(combined.allow, false); // empty list -> combineGateDecisions' own "no decisions" default
  assert.deepEqual(combined.states, []);
});
