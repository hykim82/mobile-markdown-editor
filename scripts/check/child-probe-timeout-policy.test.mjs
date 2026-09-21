// HYK-430 1R -- child-probe-timeout-policy.mjs 자체의 단위 시험.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REFERENCE_FREE_MEM_BYTES,
  MIN_MULTIPLIER,
  MAX_MULTIPLIER,
  STARTUP_SENSITIVITY,
  loadMultiplier,
  resolveChildProbeBudget,
  resolveChildProbeTimeoutMs,
  withTimeoutRetry,
} from "./child-probe-timeout-policy.mjs";

test("loadMultiplier: 기준 가용 메모리 그대로면 배율 1.0", () => {
  assert.equal(loadMultiplier({ freeMemBytes: REFERENCE_FREE_MEM_BYTES }), 1);
});

test("loadMultiplier: 가용 메모리가 기준의 절반이면 배율 2.0", () => {
  assert.equal(
    loadMultiplier({ freeMemBytes: REFERENCE_FREE_MEM_BYTES / 2 }),
    2,
  );
});

test("loadMultiplier: 상한 MAX_MULTIPLIER를 넘지 않는다(극단적 저메모리)", () => {
  assert.equal(loadMultiplier({ freeMemBytes: 1 }), MAX_MULTIPLIER);
});

test("loadMultiplier: 가용 메모리가 기준보다 넉넉해도 하한 MIN_MULTIPLIER 밑으로 안 내려간다", () => {
  assert.equal(
    loadMultiplier({ freeMemBytes: REFERENCE_FREE_MEM_BYTES * 100 }),
    MIN_MULTIPLIER,
  );
});

test("loadMultiplier: freeMemBytes가 비정상(0/음수/NaN)이면 fail-closed로 최댓값", () => {
  assert.equal(loadMultiplier({ freeMemBytes: 0 }), MAX_MULTIPLIER);
  assert.equal(loadMultiplier({ freeMemBytes: -5 }), MAX_MULTIPLIER);
  assert.equal(loadMultiplier({ freeMemBytes: NaN }), MAX_MULTIPLIER);
});

test("resolveChildProbeBudget: 부하 0(여유 있는 메모리)이면 기동/응답 배율 둘 다 1.0이다(기존 기준값을 부풀리지 않는다)", () => {
  const budget = resolveChildProbeBudget({
    baseStartupMs: 1000,
    baseResponseMs: 2000,
    freeMemBytes: REFERENCE_FREE_MEM_BYTES * 100,
  });
  assert.equal(budget.startupMultiplier, MIN_MULTIPLIER);
  assert.equal(budget.responseMultiplier, MIN_MULTIPLIER);
  assert.equal(budget.startupMs, 1000);
  assert.equal(budget.responseMs, 2000);
});

test("resolveChildProbeBudget: 부하가 걸리면(freemem < 기준값) 기동 배율이 응답 배율보다 더 가파르게 커진다", () => {
  const budget = resolveChildProbeBudget({
    baseStartupMs: 1000,
    baseResponseMs: 1000,
    freeMemBytes: REFERENCE_FREE_MEM_BYTES / 2, // ratio = 2
  });
  // response: 1 + (2-1)*1 = 2. startup: 1 + (2-1)*1.5 = 2.5.
  assert.equal(budget.responseMultiplier, 2);
  assert.equal(budget.startupMultiplier, 1 + 1 * STARTUP_SENSITIVITY);
  assert.ok(budget.startupMultiplier > budget.responseMultiplier);
});

test("resolveChildProbeBudget: 저메모리에서는 기동/응답 둘 다 같은 상한으로 수렴한다", () => {
  const budget = resolveChildProbeBudget({
    baseStartupMs: 1000,
    baseResponseMs: 1000,
    freeMemBytes: 1,
  });
  assert.equal(budget.startupMultiplier, MAX_MULTIPLIER);
  assert.equal(budget.responseMultiplier, MAX_MULTIPLIER);
});

test("resolveChildProbeTimeoutMs: 단일 타임아웃은 응답 배율 하나만 적용한다", () => {
  const ms = resolveChildProbeTimeoutMs(2000, {
    freeMemBytes: REFERENCE_FREE_MEM_BYTES / 2,
  });
  assert.equal(ms, 4000);
});

// HYK-430 2R §2⑶ⓑ -- "정책에 상한이 있는가"(부하가 극단적일 때 제한
// 시간이 무한히 늘면 「고부하=무탐지」가 된다). resolveChildProbeTimeoutMs
// 는 hyk400-receiver-guard.mjs·relay-handshake.mjs 둘 다 실제로 쓰는
// 단일-타임아웃 경로다 -- 이 경로에도 MAX_MULTIPLIER 상한이 실제로
// 걸리는지 극단적 저메모리로 직접 확인한다(resolveChildProbeBudget과는
// 별개 함수라 따로 확인이 필요하다).
test("resolveChildProbeTimeoutMs: 극단적 저메모리에서도 MAX_MULTIPLIER 상한 안에서 멎는다(무한히 늘지 않는다)", () => {
  const ms1 = resolveChildProbeTimeoutMs(2000, { freeMemBytes: 1 });
  const ms2 = resolveChildProbeTimeoutMs(2000, {
    freeMemBytes: 1 / 1_000_000,
  });
  assert.equal(ms1, 2000 * MAX_MULTIPLIER);
  assert.equal(
    ms2,
    2000 * MAX_MULTIPLIER,
    "freeMemBytes가 더 작아져도(더 극단적이어도) 값이 더 커지지 않아야 한다 -- 상한에서 멎었다는 증거",
  );
});

// ---------------------------------------------------------------------------
// withTimeoutRetry
// ---------------------------------------------------------------------------

test("withTimeoutRetry: 첫 시도가 성공하면 재시도 없이 그 값을 돌려준다", () => {
  let calls = 0;
  const result = withTimeoutRetry(
    () => {
      calls += 1;
      return "ok";
    },
    { isTimeout: () => true },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withTimeoutRetry: 타임아웃 에러는 정확히 1회(기본값)만 재시도한 뒤 성공하면 그 값을 돌려준다", () => {
  let calls = 0;
  const result = withTimeoutRetry(
    () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("timed out");
        err.timedOut = true;
        throw err;
      }
      return "ok-on-retry";
    },
    { isTimeout: (err) => err.timedOut === true },
  );
  assert.equal(result, "ok-on-retry");
  assert.equal(calls, 2);
});

// ★음성 대조와 짝을 이루는 단위 시험(coder-task.md §2⑷의 축소판): 진짜로
// 계속 타임아웃되는 자식은 재시도 예산을 다 써도 여전히 타임아웃
// 에러로 던져진다 -- 탐지력이 재시도로 사라지지 않는다는 것을 이
// 모듈 수준에서 먼저 고정한다(실제 자식 프로세스를 쓰는 종단 음성
// 대조는 hyk400-receiver-guard.test.mjs (I) 시험 참조).
test("withTimeoutRetry: 매번 타임아웃이면 재시도 예산을 다 쓴 뒤 마지막 타임아웃 에러를 그대로 던진다(탐지력 보존)", () => {
  let calls = 0;
  assert.throws(() => {
    withTimeoutRetry(
      () => {
        calls += 1;
        const err = new Error(`timed out #${calls}`);
        err.timedOut = true;
        throw err;
      },
      { isTimeout: (err) => err.timedOut === true },
    );
  }, /timed out #2/);
  assert.equal(calls, 2, "1회 재시도(기본값) = 총 시도 2회");
});

test("withTimeoutRetry: 타임아웃이 아닌 에러는 재시도 없이 즉시 던진다", () => {
  let calls = 0;
  assert.throws(() => {
    withTimeoutRetry(
      () => {
        calls += 1;
        throw new Error("crashed, not a timeout");
      },
      { isTimeout: () => false },
    );
  }, /crashed, not a timeout/);
  assert.equal(calls, 1);
});

test("withTimeoutRetry: retries:0을 넘기면 재시도 없이 첫 타임아웃을 즉시 던진다", () => {
  let calls = 0;
  assert.throws(() => {
    withTimeoutRetry(
      () => {
        calls += 1;
        const err = new Error("timed out");
        err.timedOut = true;
        throw err;
      },
      { retries: 0, isTimeout: () => true },
    );
  }, /timed out/);
  assert.equal(calls, 1);
});
