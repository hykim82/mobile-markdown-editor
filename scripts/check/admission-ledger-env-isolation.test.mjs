// HYK-359 2R P1-2 계약 시험 -- coder-task.md §3-1: "helper를 어떤 방식으로
// 부르든 떠도는 3키가 자식에게 새지 않는다"를 helper 자신의 계약으로
// 직접 고정한다. 이 파일은 P1-1(coder-task.md 급소: "helper가 아니라 실제
// 시험 파일이 helper를 타는지를 검사하라")과 다른 층위를 다룬다 -- P1-1은
// "보호 대상이 목록에서 함께 사라지면 잡히는가"이고, 이 파일은 "helper
// 자체의 stripping 계약이 어떤 입력 모양에도 성립하는가"다. 둘 다 필요하다
// (helper 계약이 맞아도 아무도 안 부르면 무의미하고, 다 불러도 계약이
// 새면 무의미하다).
//
// ⛔실사고(1R): `isolatedChildEnv(overrides, baseEnv)`가 `overrides`를
// 검사 없이 merge해, `overrides = { ...process.env, ADMISSION_LEDGER_PATH:
// x, ADMISSION_LOCK_PATH: y }` 형태(relay-handshake.test.mjs의 실제 호출
// 모양)로 부르면 그 안에 실려온 `...process.env`가 DISPATCH_RECEIPT_PATH를
// 되살렸다. 이 파일의 test 1이 정확히 그 입력 모양을 재현해 고정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isolatedChildEnv,
  isolatedChildEnvWithLedger,
} from "./admission-ledger-env-isolation.mjs";

const PROTECTED_KEYS = [
  "ADMISSION_LEDGER_PATH",
  "ADMISSION_LOCK_PATH",
  "DISPATCH_RECEIPT_PATH",
];

test("HYK-359 2R P1-2 (a): isolatedChildEnv -- overrides가 ...process.env를 통째로 품고 있어도(1R을 뚫었던 그 모양) 세 키는 살아남지 못한다", () => {
  const ambientBase = {
    PATH: "/usr/bin",
    ADMISSION_LEDGER_PATH: "C:\\floating\\ambient-ledger.json",
    ADMISSION_LOCK_PATH: "C:\\floating\\ambient-ledger.lock",
    DISPATCH_RECEIPT_PATH: "C:\\floating\\ambient-receipt.json",
  };
  // 1R을 뚫었던 정확한 모양: 호출부가 자기 두 값만 덮으려다 `...process.env`를
  // 통째로 옮겨온다 -- DISPATCH_RECEIPT_PATH는 아예 언급하지 않는다.
  const overridesShapedLikeTheBug = {
    ...ambientBase,
    ADMISSION_LEDGER_PATH: "C:\\my-fixture\\ledger.json",
    ADMISSION_LOCK_PATH: "C:\\my-fixture\\ledger.lock",
  };
  const result = isolatedChildEnv(overridesShapedLikeTheBug, ambientBase);
  for (const key of PROTECTED_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, key),
      false,
      `${key} must not survive isolatedChildEnv even when overrides spreads ...process.env -- got ${JSON.stringify(result[key])}`,
    );
  }
  assert.equal(
    result.PATH,
    "/usr/bin",
    "unrelated ambient keys must still pass through",
  );
});

test("HYK-359 2R P1-2 (b) 안 부수기 증명: isolatedChildEnvWithLedger -- 명시적으로 넘긴 ledgerEnv 값은 같은 떠도는 ambient 잡음 아래서도 그대로 살아남는다", () => {
  const ambientBase = {
    PATH: "/usr/bin",
    ADMISSION_LEDGER_PATH: "C:\\floating\\ambient-ledger.json",
    ADMISSION_LOCK_PATH: "C:\\floating\\ambient-ledger.lock",
    DISPATCH_RECEIPT_PATH: "C:\\floating\\ambient-receipt.json",
  };
  // 호출부가 여전히(부주의하게) overrides에 ...process.env를 실어보내도
  const overridesShapedLikeTheBug = { ...ambientBase };
  const result = isolatedChildEnvWithLedger(
    {
      admissionLedgerPath: "C:\\my-fixture\\ledger.json",
      admissionLockPath: "C:\\my-fixture\\ledger.lock",
    },
    overridesShapedLikeTheBug,
    ambientBase,
  );
  assert.equal(result.ADMISSION_LEDGER_PATH, "C:\\my-fixture\\ledger.json");
  assert.equal(result.ADMISSION_LOCK_PATH, "C:\\my-fixture\\ledger.lock");
  // dispatchReceiptPath was never named -> DISPATCH_RECEIPT_PATH must stay
  // absent, not fall back to the ambient value that was floating around.
  assert.equal(
    Object.prototype.hasOwnProperty.call(result, "DISPATCH_RECEIPT_PATH"),
    false,
    `DISPATCH_RECEIPT_PATH must stay absent when not explicitly named -- got ${JSON.stringify(result.DISPATCH_RECEIPT_PATH)}`,
  );
  assert.equal(result.PATH, "/usr/bin");
});

test("HYK-359 2R P1-2 (c): isolatedChildEnvWithLedger -- 명시적으로 이름 붙인 세 키 모두 ambient 잡음을 이기고 그대로 전달된다", () => {
  const ambientBase = {
    ADMISSION_LEDGER_PATH: "C:\\floating\\ambient-ledger.json",
    ADMISSION_LOCK_PATH: "C:\\floating\\ambient-ledger.lock",
    DISPATCH_RECEIPT_PATH: "C:\\floating\\ambient-receipt.json",
  };
  const result = isolatedChildEnvWithLedger(
    {
      admissionLedgerPath: "C:\\my-fixture\\ledger.json",
      admissionLockPath: "C:\\my-fixture\\ledger.lock",
      dispatchReceiptPath: "C:\\my-fixture\\receipt.json",
    },
    { ...ambientBase },
    ambientBase,
  );
  assert.equal(result.ADMISSION_LEDGER_PATH, "C:\\my-fixture\\ledger.json");
  assert.equal(result.ADMISSION_LOCK_PATH, "C:\\my-fixture\\ledger.lock");
  assert.equal(result.DISPATCH_RECEIPT_PATH, "C:\\my-fixture\\receipt.json");
});
