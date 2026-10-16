// HYK-434: worker-dispatch-rule.md §1이 요구하는 "결과 파일 맨 위 3줄"
// (dispatch_verified:/task_id_from_dispatch:/pane_match:)을 relay-
// handshake.mjs가 실제로 배달 영수증 원장(dispatch-receipts.jsonl)과
// 기계로 대조하는지 확인한다(resolveG1DispatchVerificationVerdict,
// checkRelayHandshake에 결선). 2026-08-25 HYK-357 inject-3 실물(ORCH-99
// 인계서 ⓕ-3) -- G1 3줄이 빠진 결과 파일도 소비가 통과했다 -- 가 이
// 축의 재현 대상이다.
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 SCRATCH_ROOT(os.tmpdir() 아래,
// 이 워크트리 밖) 아래 mkdtemp 디렉터리에만 쓴다 -- hyk387-dispatch-
// record-required.test.mjs와 동일한 관용구(coder-task.md §0 경계 2).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  checkRelayHandshake,
  resolveG1DispatchVerificationVerdict,
} from "./relay-handshake.mjs";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";
import { RELAY_HANDSHAKE_STATIC_SIBLINGS } from "./relay-handshake-fixture-siblings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "relay-handshake.mjs");
const SIBLING_DEPS = RELAY_HANDSHAKE_STATIC_SIBLINGS;

// HYK-434 2R (full-runner RED, live repro): a fixed literal root here
// collided with ITSELF under isolated-suite-runner.mjs's full pass -- this
// exact file runs once directly (as this suite file) AND a second time
// concurrently as the installed copy inside install-g1-adapter-list
// .test.mjs's (b) child `node --test` (both resolve the same absolute
// tmpdir() path regardless of which copy's bytes are executing), so each
// instance's `after()` rmSync of the shared root could delete the other's
// still-in-use mkdtemp fixture dir mid-run (observed: "task file not
// found" for (g1-b)'s own fixture). mkdtemp-ing the root itself up front
// gives every process instance its own unique root, closing that race.
const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), "hyk434-scratch-"));

function withFixtureDir(prefix, fn) {
  const dir = mkdtempSync(join(SCRATCH_ROOT, prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

after(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

// hyk387-dispatch-record-required.test.mjs와 동일한 상대-오프셋 관용구
// (절대 달력값은 미래-스큐/tz-오판 휴리스틱 창과 우연히 겹칠 수 있다,
// 그 파일 헤더 "HYK-387 2R (자체 회귀 수리, 실측)" 참조).
function formatKst(ms, { seconds = false } = {}) {
  const d = new Date(ms + 9 * 60 * 60 * 1000); // KST = UTC+9, UTC 필드로 렌더링
  const p2 = (n) => String(n).padStart(2, "0");
  const base = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(
    d.getUTCDate(),
  )} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return seconds ? `${base}:${p2(d.getUTCSeconds())} KST` : `${base} KST`;
}

const NOW_MS = Date.now();
const DEFAULT_DROPPED_MS = Math.floor((NOW_MS - 30 * 60 * 1000) / 1000) * 1000; // now - 30분
const DEFAULT_DONE_MS = Math.floor((NOW_MS - 10 * 60 * 1000) / 1000) * 1000; // now - 10분
// 원장 기록은 dropped_at과 doneAt 사이(=정상적으로 "배정 뒤 완료 전")에
// 둔다 -- HYK-387 LATE 축(recorded_at < doneAtMs)과 우연히 충돌하지 않게.
const DEFAULT_RECORDED_AT_MS = DEFAULT_DROPPED_MS + 60 * 1000; // dropped 1분 뒤

const RUNTIME_TASK_ID = "task_aaaaaaaaaaaa";
const PANE_KEY =
  "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222";
// HYK-434 3R §2-4 "다른 pane = Q": 영수증과 «다른» 완전한 uuid:uuid 모양
// 값. "x" 같은 비-토큰 문자열은 §2-1 토큰 추출 대상이 아니라서(토큰
// 0개로 처리돼 "최소 1개" 규칙상 그 자리가 그냥 없는 것과 같다) 더 이상
// 비대칭 거부를 시험하지 못한다 -- 진짜 비대칭 위조를 시험하려면 토큰
// 모양을 갖춘 «다른» 값이어야 한다(아래 asym 표본들이 이 값을 쓴다).
const OTHER_PANE_KEY =
  "99999999-9999-9999-9999-999999999999:88888888-8888-8888-8888-888888888888";

function g1Block({
  dispatchVerified = "yes",
  taskIdFromDispatch = RUNTIME_TASK_ID,
  paneLeft = PANE_KEY,
  paneRight = PANE_KEY,
  paneVerdict = "일치",
} = {}) {
  return `dispatch_verified: ${dispatchVerified}\ntask_id_from_dispatch: ${taskIdFromDispatch}\npane_match: ${paneLeft} == ${paneRight} ? ${paneVerdict}\n`;
}

function writeCoderRound(
  dir,
  {
    taskId = "HYK-434-T",
    doneAtMs = DEFAULT_DONE_MS,
    droppedAtMs = DEFAULT_DROPPED_MS,
    g1 = g1Block(),
    extra = "",
  } = {},
) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${formatKst(droppedAtMs)}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n${g1}${extra}\n>>> DONE: CODER @ ${formatKst(
      doneAtMs,
      {
        seconds: true,
      },
    )}\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function writeBlockedCoderRound(
  dir,
  {
    taskId = "HYK-434-T",
    droppedAtMs = DEFAULT_DROPPED_MS,
    reason = "git worktree unreachable",
    g1 = "",
  } = {},
) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${formatKst(droppedAtMs)}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n${g1}\n>>> BLOCKED: ${reason}\n`,
    "utf8",
  );
}

function ledgerLine(record) {
  return JSON.stringify(record) + "\n";
}

function validReceipt({
  role = "coder",
  taskId = "HYK-434-T",
  recordedAtMs = DEFAULT_RECORDED_AT_MS,
  runtimeTaskId = RUNTIME_TASK_ID,
  paneKey = PANE_KEY,
} = {}) {
  return {
    recorded_at: new Date(recordedAtMs).toISOString(),
    runtime_task_id: runtimeTaskId,
    dispatch_id: "ctx_1",
    assignee_pane_key: paneKey,
    dispatch_timestamp_utc: new Date(DEFAULT_DROPPED_MS).toISOString(),
    dispatch_timestamp_source: "response.dispatched_at",
    role,
    harness_task_label: taskId,
  };
}

// hyk387-dispatch-record-required.test.mjs와 동일한 관용구: args[1]이
// harnessDir(모든 호출부가 `runCli(["coder", dir], ...)` 모양)이므로,
// ledgerPath가 주어지면 그 디렉터리 안에 포인터 파일을 직접 쓴다.
function runCli(args, { ledgerPath } = {}) {
  if (ledgerPath) {
    writeFileSync(
      join(args[1], "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );
  }
  const env = isolatedChildEnv({});
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env,
  });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  assert.notEqual(res.status, null, "process must not be signal-killed");
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function withLedger(dir, records) {
  const ledgerPath = join(dir, "dispatch-receipts.jsonl");
  writeFileSync(ledgerPath, records.map((r) => ledgerLine(r)).join(""), "utf8");
  return ledgerPath;
}

// ---------------------------------------------------------------------------
// ⓐ 정상 경로: 3줄이 원장과 정확히 일치 -> 소비 성공(exit 0).
// ---------------------------------------------------------------------------
test("(g1-a)★ 정상 경로: dispatch_verified/task_id_from_dispatch/pane_match 3줄이 원장과 일치 -> 실 CLI exit 0", () => {
  withFixtureDir("g1-normal-", (dir) => {
    writeCoderRound(dir);
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.equal(res.exit, 0, `expected clean pass, got stderr: ${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// ⓑ task_id_from_dispatch가 앞 배달(재배달 전)의 runtime id -- 거부 + 사유에
// 줄 이름·기대값·실제값.
// ---------------------------------------------------------------------------
test("(g1-b)★ 위조: task_id_from_dispatch가 앞 라운드의 runtime id -> 거부, 사유에 줄 이름·기대·실제가 모두 찍힌다", () => {
  withFixtureDir("g1-stale-taskid-", (dir) => {
    const staleRuntimeId = "task_bbbbbbbbbbbb";
    writeCoderRound(dir, {
      g1: g1Block({ taskIdFromDispatch: staleRuntimeId }), // 앞 라운드 값을 그대로 가져옴
    });
    const ledgerPath = withLedger(dir, [validReceipt()]); // 원장의 진짜 값은 RUNTIME_TASK_ID
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /G1 cross-check failed \(HYK-434\)/);
    assert.match(res.stderr, /'task_id_from_dispatch:' line value mismatch/);
    assert.match(res.stderr, new RegExp(`expected '${RUNTIME_TASK_ID}'`));
    assert.match(res.stderr, new RegExp(`found '${staleRuntimeId}'`));
  });
});

// ---------------------------------------------------------------------------
// ⓒ 3줄 전부 부재 -> 거부(missing).
// ---------------------------------------------------------------------------
test("(g1-c)★ 3줄 전부 부재 -> 거부(missing, HYK-434)", () => {
  withFixtureDir("g1-all-missing-", (dir) => {
    writeCoderRound(dir, { g1: "" });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /G1 cross-check failed \(HYK-434\)/);
    assert.match(res.stderr, /missing \(no standalone column-0 line found/);
  });
});

// ---------------------------------------------------------------------------
// ⓓ dispatch_verified: no -> 거부.
// ---------------------------------------------------------------------------
test("(g1-d)★ dispatch_verified: no -> 거부(값 자체가 통과 조건을 만족하지 않는다)", () => {
  withFixtureDir("g1-not-verified-", (dir) => {
    writeCoderRound(dir, { g1: g1Block({ dispatchVerified: "no" }) });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'dispatch_verified:' line value mismatch/);
    assert.match(res.stderr, /expected 'yes', found 'no'/);
  });
});

// ---------------------------------------------------------------------------
// ⓔ pane_match의 키가 영수증과 다름 -> 거부.
// ---------------------------------------------------------------------------
test("(g1-e)★ pane_match 줄의 키가 원장의 assignee_pane_key와 다르다 -> 거부", () => {
  withFixtureDir("g1-pane-mismatch-", (dir) => {
    writeCoderRound(dir, {
      g1: g1Block({ paneLeft: OTHER_PANE_KEY, paneRight: OTHER_PANE_KEY }),
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'pane_match:' line value mismatch/);
    assert.match(res.stderr, new RegExp(`expected '${PANE_KEY}'`));
    assert.match(
      res.stderr,
      new RegExp(`found '${OTHER_PANE_KEY}', '${OTHER_PANE_KEY}'`),
    );
  });
});

test("(g1-e2) pane_match 줄 자신이 '불일치'로 끝난다 -> 거부(값이 정직해도 불일치면 통과시키지 않는다)", () => {
  withFixtureDir("g1-pane-disagree-", (dir) => {
    writeCoderRound(dir, {
      g1: g1Block({ paneVerdict: "불일치" }),
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'pane_match:' line mismatch/);
  });
});

// ---------------------------------------------------------------------------
// ⓕ 재배달 2건 -- 마지막 배달(recorded_at 최신) 기준으로 대조한다.
// ---------------------------------------------------------------------------
test("(g1-f)★ 재배달 2건: 결과가 «최신» 배달 값을 쓰면 통과, «이전» 배달 값을 쓰면 거부(가장 최근 것이 기준)", () => {
  withFixtureDir("g1-redispatch-", (dir) => {
    const oldRuntimeId = "task_cccccccccccc";
    const oldPane =
      "33333333-3333-3333-3333-333333333333:44444444-4444-4444-4444-444444444444";
    const oldRecordedAtMs = DEFAULT_DROPPED_MS + 10 * 1000;
    const newRecordedAtMs = DEFAULT_DROPPED_MS + 20 * 1000;
    const ledgerPath = withLedger(dir, [
      validReceipt({
        recordedAtMs: oldRecordedAtMs,
        runtimeTaskId: oldRuntimeId,
        paneKey: oldPane,
      }),
      validReceipt({
        recordedAtMs: newRecordedAtMs,
        runtimeTaskId: RUNTIME_TASK_ID,
        paneKey: PANE_KEY,
      }),
    ]);

    // 최신 배달 값 -> 통과.
    writeCoderRound(dir, { g1: g1Block() });
    const passRes = runCli(["coder", dir], { ledgerPath });
    assert.equal(passRes.exit, 0, `stderr: ${passRes.stderr}`);

    // 이전 배달 값 -> 거부(더 이상 기준이 아니다).
    writeCoderRound(dir, {
      g1: g1Block({
        taskIdFromDispatch: oldRuntimeId,
        paneLeft: oldPane,
        paneRight: oldPane,
      }),
    });
    const failRes = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(failRes.exit, 0);
    assert.match(
      failRes.stderr,
      /'task_id_from_dispatch:' line value mismatch/,
    );
  });
});

// ---------------------------------------------------------------------------
// ⓖ 펜스 코드블록 «안»에만 3줄이 있다 -> 인용으로 마스킹되어 부재로 거부.
// ---------------------------------------------------------------------------
test("(g1-g)★ G1 3줄이 펜스 코드블록 안에만 인용돼 있다 -> 마스킹되어 부재로 거부(HYK-449/HYK-450과 같은 함정)", () => {
  withFixtureDir("g1-fenced-", (dir) => {
    const fenced = "```\n" + g1Block() + "```\n";
    writeCoderRound(dir, { g1: "", extra: fenced });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /missing \(no standalone column-0 line found/);
  });
});

// ---------------------------------------------------------------------------
// ⓗ 인용 밖 중복 -- 같은 키가 2번 이상 -> 모호 거부(조용히 하나를 고르지
// 않는다, HYK-486 선례).
// ---------------------------------------------------------------------------
test("(g1-h)★ AMBIGUOUS: 인용 밖에 'dispatch_verified:' 줄이 2개 -> 거부, 어느 것이 최종인지 결정할 수 없다", () => {
  withFixtureDir("g1-ambiguous-", (dir) => {
    writeCoderRound(dir, {
      g1:
        "dispatch_verified: yes\ndispatch_verified: yes\n" +
        `task_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /ambiguous, cannot resolve, HYK-434/);
  });
});

// ---------------------------------------------------------------------------
// ⓘ 어댑터 A -- 원장 포인터가 없다(사람 `go`, 이 라운드의 배달 기록이
// 원리상 없음) -> G1 대조를 건너뛴다, 건너뛴 사실이 출력에 한 줄로
// 보여야 한다(침묵 0).
// ---------------------------------------------------------------------------
test("(g1-i)★ 어댑터 A(원장 포인터 없음): G1 대조를 건너뛰고 그대로 소비 성공 + 건너뛴 사실이 stderr에 한 줄로 찍힌다(침묵 0)", () => {
  withFixtureDir("g1-adapter-a-", (dir) => {
    // ⛔G1 3줄을 아예 쓰지 않는다 -- 어댑터 A는 그 부재조차 보지 않는다는
    // 것을 보이기 위해서다.
    writeCoderRound(dir, { g1: "" });
    // ledgerPath/포인터 파일 둘 다 만들지 않는다.
    const res = runCli(["coder", dir]);
    assert.equal(res.exit, 0, `stderr: ${res.stderr}`);
    assert.match(
      res.stderr,
      /G1 dispatch-ledger cross-check skipped \(어댑터 A/,
      "건너뛴 사실이 한 줄로 보여야 한다(침묵 0)",
    );
  });
});

// ---------------------------------------------------------------------------
// ⓙ 범위 확인: BLOCKED 표지 라운드는 G1 부재여도 기존대로 소비된다(무회귀).
// G1 축은 DONE 소비에만 결선된다 -- BLOCKED는 이 축에 닿기 전에 이미
// 빠져나간다(resolveHandshakeCore).
// ---------------------------------------------------------------------------
test("(g1-j)★ 범위 확인: G1 3줄이 전혀 없는 BLOCKED 라운드도 BLOCKED 사유로(G1 사유 아님) 그대로 처리된다(무회귀, 레인 잠금 방지)", () => {
  withFixtureDir("g1-blocked-scope-", (dir) => {
    writeBlockedCoderRound(dir, { reason: "git worktree unreachable" });
    // 원장조차 만들지 않는다 -- BLOCKED 라운드는 이 축에 닿지 않으므로
    // 영향이 없어야 한다.
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "BLOCKED");
    assert.match(result.reason, /git worktree unreachable/);
    assert.doesNotMatch(result.reason, /G1 cross-check/);
  });
});

test("(g1-j2) 범위 확인: BLOCKED 라운드 + 원장이 실제로 있어도(기록 0건) G1/dispatchRecord 축 어느 쪽도 닿지 않는다", () => {
  withFixtureDir("g1-blocked-with-ledger-", (dir) => {
    writeBlockedCoderRound(dir, { reason: "awaiting input" });
    const ledgerPath = withLedger(dir, []); // 기록 0건
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /awaiting input/);
    assert.doesNotMatch(res.stderr, /DISPATCH_RECORD_ABSENT/);
    assert.doesNotMatch(res.stderr, /G1 cross-check/);
  });
});

// ---------------------------------------------------------------------------
// in-process 단위 확인 -- resolveG1DispatchVerificationVerdict 자체를
// 직접 구동한다(§4 "프로덕션 실체를 구동" 요건 -- CLI 레벨 시험과 별개로
// export된 실제 함수 그 자체도 직접 부른다).
// ---------------------------------------------------------------------------
test("(g1-k) in-process: dispatchRecordVerdict.skipped=true -> {ok:true, skipped:true}, G1 내용은 전혀 읽지 않는다", () => {
  const r = resolveG1DispatchVerificationVerdict({
    resultContent: "",
    dispatchRecordVerdict: { ok: true, skipped: true },
  });
  assert.deepEqual(r, { ok: true, skipped: true });
});

test("(g1-l) in-process: matchRecords가 정상 값일 때 정상 3줄 -> ok:true", () => {
  const r = resolveG1DispatchVerificationVerdict({
    resultContent: g1Block(),
    dispatchRecordVerdict: {
      ok: true,
      matches: 1,
      matchRecords: [validReceipt()],
    },
  });
  assert.equal(r.ok, true, r.reason);
});

// ---------------------------------------------------------------------------
// 되돌림 변이 G1~G5(coder-task.md §2-8) -- 소스를 문자열 치환해 격리
// 사본을 만들고 실 CLI(spawnSync)로 구동한다(hyk387-dispatch-record-
// required.test.mjs의 stageMutatedRelayHandshake와 동일 관용구 --
// invokedDirectly 게이트가 경로 suffix "scripts/check/relay-handshake.mjs"
// 매치만 보므로, 변조본도 그 중첩 구조를 재현해야 한다).
// ---------------------------------------------------------------------------
function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

function stageMutatedRelayHandshake(stageDir, mutateFn) {
  const nestedDir = join(stageDir, "scripts", "check");
  mkdirSync(nestedDir, { recursive: true });
  const original = readFileSync(CLI_PATH, "utf8");
  const mutated = mutateFn(original);
  assert.notEqual(
    mutated,
    original,
    "mutation must actually change the source",
  );
  writeFileSync(join(nestedDir, "relay-handshake.mjs"), mutated, "utf8");
  for (const dep of SIBLING_DEPS) {
    writeFileSync(
      join(nestedDir, dep),
      readFileSync(join(HERE, dep), "utf8"),
      "utf8",
    );
  }
  return join(nestedDir, "relay-handshake.mjs");
}

function runMutatedCli(mutatedCliPath, args) {
  const env = isolatedChildEnv({});
  const res = spawnSync(process.execPath, [mutatedCliPath, ...args], {
    encoding: "utf8",
    env,
  });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// G1: G1 대조 호출 자체를 제거한다 -> (g1-b)/(g1-c) 표본이 다시 통과한다(RED).
test("(g1-mut-1)★ 되돌림 변이 G1: checkRelayHandshake의 G1 호출 자체를 제거하면 -- (g1-c) 3줄 전부 부재 표본이 다시 통과한다(RED)", () => {
  withFixtureDir("g1-mut1-", (dir) => {
    const target =
      "  const g1Verdict = resolveG1DispatchVerificationVerdict({\n    resultContent: judgedRegion,\n    dispatchRecordVerdict,\n  });\n  if (!g1Verdict.ok) return g1Verdict;\n\n";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "G1 call site");

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, ""),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, { g1: "" }); // (g1-c) 표본: 3줄 전부 부재
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.equal(
      mutRes.exit,
      0,
      `RED 필수: G1 호출이 제거되면 3줄 부재 표본도 잘못 통과해야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      originalRes.exit,
      0,
      "원본(무력화 안 됨)은 같은 표본을 반드시 거부한다(대조군)",
    );
  });
});

// G2: "최신 배달" 대신 "첫 배달"(가장 이른 recorded_at) 기준으로 바꾼다
// -> (g1-f)의 재배달 표본이 RED(이전 배달 값으로도 통과한다).
test("(g1-mut-2)★ 되돌림 변이 G2: 최신 배달 대신 첫 배달 기준으로 바꾸면 -- (g1-f)의 «이전 배달 값» 표본이 다시 통과한다(RED)", () => {
  withFixtureDir("g1-mut2-", (dir) => {
    const target =
      "function resolveLatestDispatchRecord(records) {\n  return records.reduce((best, r) => {\n    const t = Date.parse(r?.recorded_at);\n    if (!Number.isFinite(t)) return best;\n    const bestT = best ? Date.parse(best.recorded_at) : -Infinity;\n    return t > bestT ? r : best;\n  }, null);\n}";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "latest-record reduce");
    const mutated_target_replacement =
      "function resolveLatestDispatchRecord(records) {\n  return records.reduce((best, r) => {\n    const t = Date.parse(r?.recorded_at);\n    if (!Number.isFinite(t)) return best;\n    const bestT = best ? Date.parse(best.recorded_at) : Infinity;\n    return t < bestT ? r : best; // HYK-434 되돌림 변이 G2: 최신 대신 가장 이른 레코드를 고른다\n  }, null);\n}";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, mutated_target_replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    const oldRuntimeId = "task_cccccccccccc";
    const oldPane =
      "33333333-3333-3333-3333-333333333333:44444444-4444-4444-4444-444444444444";
    const oldRecordedAtMs = DEFAULT_DROPPED_MS + 10 * 1000;
    const newRecordedAtMs = DEFAULT_DROPPED_MS + 20 * 1000;
    const ledgerPath = withLedger(roundDir, [
      validReceipt({
        recordedAtMs: oldRecordedAtMs,
        runtimeTaskId: oldRuntimeId,
        paneKey: oldPane,
      }),
      validReceipt({
        recordedAtMs: newRecordedAtMs,
        runtimeTaskId: RUNTIME_TASK_ID,
        paneKey: PANE_KEY,
      }),
    ]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );
    // 결과는 '이전 배달' 값을 쓴다 -- 원본이면 거부되는 표본.
    writeCoderRound(roundDir, {
      g1: g1Block({
        taskIdFromDispatch: oldRuntimeId,
        paneLeft: oldPane,
        paneRight: oldPane,
      }),
    });

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.equal(
      mutRes.exit,
      0,
      `RED 필수: 첫 배달 기준이면 이전 배달 값도 통과해야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      originalRes.exit,
      0,
      "원본은 같은 표본을 반드시 거부한다(대조군)",
    );
  });
});

// G3: 마스킹(maskQuotedMarkerRegions)을 제거해 원문 텍스트에서 직접 줄을
// 판독하게 바꾼다 -> (g1-g) 펜스 인용 표본이 RED(펜스 안 인용도 표지로
// 오인해 통과한다).
test("(g1-mut-3)★ 되돌림 변이 G3: 마스킹을 제거하고 원문에서 직접 판독하면 -- (g1-g)의 펜스-인용 표본이 다시 통과한다(RED)", () => {
  withFixtureDir("g1-mut3-", (dir) => {
    const target =
      "  const scan = maskQuotedMarkerRegions(content, { indentedBlocks: true });";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "resolveG1StandaloneLine masking");
    const replacement =
      "  const scan = content; // HYK-434 되돌림 변이 G3: 마스킹 제거";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    const fenced = "```\n" + g1Block() + "```\n";
    writeCoderRound(roundDir, { g1: "", extra: fenced });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.equal(
      mutRes.exit,
      0,
      `RED 필수: 마스킹이 없으면 펜스 안 인용도 표지로 통과해야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      originalRes.exit,
      0,
      "원본은 같은 표본을 반드시 거부한다(대조군)",
    );
  });
});

// G4: 어댑터 A 분기(skipped)를 거부로 바꾼다 -> (g1-i) 표본이 RED(포인터
// 없는 정상 라운드가 거부당한다 -- 과차단).
test("(g1-mut-4)★ 되돌림 변이 G4: 어댑터 A의 skip을 거부로 바꾸면 -- (g1-i)의 포인터-없음 정상 라운드가 거부당한다(RED, 과차단)", () => {
  withFixtureDir("g1-mut4-", (dir) => {
    const target =
      "  if (dispatchRecordVerdict.skipped) {\n    console.error(\n      \"relay-handshake: G1 dispatch-ledger cross-check skipped (어댑터 A -- this round has no dispatch-receipt ledger pointer, HYK-434) -- 'dispatch_verified:'/'task_id_from_dispatch:'/'pane_match:' header lines are NOT cross-checked against the ledger for this round\",\n    );\n    return { ok: true, skipped: true };\n  }";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "adapter-A skip branch");
    const replacement =
      '  if (dispatchRecordVerdict.skipped) {\n    return { ok: false, reason: "HYK-434 되돌림 변이 G4: 어댑터 A를 거부로 바꿈" };\n  }';

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, { g1: "" }); // 어댑터 A -- 포인터 자체가 없다
    // ledgerPath/포인터 파일 둘 다 만들지 않는다(= 어댑터 A).

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.notEqual(
      mutRes.exit,
      0,
      "RED 필수: skip이 거부로 바뀌면 포인터 없는 정상 라운드도 잘못 거부당해야 한다",
    );

    const originalRes = runCli(["coder", roundDir]);
    assert.equal(
      originalRes.exit,
      0,
      `원본은 같은 표본을 통과시킨다(대조군). stderr: ${originalRes.stderr}`,
    );
  });
});

// G5: DONE 한정 조건을 제거한다(BLOCKED에도 적용) -- returnDoneResolvedVerdict가
// BLOCKED/NEEDS_INPUT 상태에서도 G1 대조를 돌려, 실패하면 그 결과를
// doneResolved 대신 반환하도록 바꾼다 -> (g1-j) 표본이 RED(G1 3줄이 없는
// BLOCKED 라운드가 BLOCKED 사유 대신 G1 사유로 거부된다 -- 레인 잠금 위험
// 형태의 회귀).
test("(g1-mut-5)★ 되돌림 변이 G5: DONE 한정 조건을 제거해 BLOCKED에도 G1 대조를 적용하면 -- (g1-j)의 BLOCKED 표본이 BLOCKED 사유 대신 G1 사유로 거부된다(RED)", () => {
  withFixtureDir("g1-mut5-", (dir) => {
    const target =
      "function returnDoneResolvedVerdict({\n  doneResolved,\n  role,\n  harnessDir,\n  taskId,\n  taskContent,\n  resultContent,\n  droppedMatch,\n  dispatchId,\n  resultPath,\n  now,\n}) {\n  runBlockedTerminationSideEffectsIfApplicable({\n    state: doneResolved.state,\n    role,\n    harnessDir,\n    taskId,\n    taskContent,\n    resultContent,\n    droppedMatch,\n    dispatchId,\n    resultPath,\n    now,\n  });\n  return doneResolved;\n}";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "returnDoneResolvedVerdict body");
    const replacement =
      "function returnDoneResolvedVerdict({\n  doneResolved,\n  role,\n  harnessDir,\n  taskId,\n  taskContent,\n  resultContent,\n  droppedMatch,\n  dispatchId,\n  resultPath,\n  now,\n}) {\n  runBlockedTerminationSideEffectsIfApplicable({\n    state: doneResolved.state,\n    role,\n    harnessDir,\n    taskId,\n    taskContent,\n    resultContent,\n    droppedMatch,\n    dispatchId,\n    resultPath,\n    now,\n  });\n  // HYK-434 되돌림 변이 G5: DONE 한정 조건 제거 -- BLOCKED/NEEDS_INPUT에도 G1을 적용한다.\n  if (doneResolved.state === 'BLOCKED' || doneResolved.state === 'NEEDS_INPUT') {\n    const forcedG1 = resolveG1DispatchVerificationVerdict({\n      resultContent,\n      dispatchRecordVerdict: resolveDispatchRecordExistence({ role, taskId, harnessDir }),\n    });\n    if (!forcedG1.ok) return forcedG1;\n  }\n  return doneResolved;\n}";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeBlockedCoderRound(roundDir, { reason: "git worktree unreachable" }); // G1 3줄 없음
    const ledgerPath = withLedger(roundDir, [validReceipt()]); // 포인터가 있으므로 어댑터 A가 아니다
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.notEqual(mutRes.exit, 0);
    assert.match(
      mutRes.stderr,
      /G1 cross-check failed/,
      "RED 필수: BLOCKED 사유 대신 G1 사유로 거부돼야 한다(현재는 이렇게 되지 않는다는 것이 (g1-j))",
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(originalRes.exit, 0);
    assert.match(originalRes.stderr, /git worktree unreachable/);
    assert.doesNotMatch(
      originalRes.stderr,
      /G1 cross-check/,
      "원본은 BLOCKED 사유만 내야 한다(대조군, (g1-j)와 동일 불변식)",
    );
  });
});

// ===========================================================================
// HYK-434 2R(coder-task.md §2 요구 7) -- 책임자 축 ⓐ "형식→값 대조 좁히기".
// 아래부터는 값이 원장과 완전히 같은데 «줄 모양»만 다른 표본들이 실 CLI로
// 소비(exit 0)되는지를 직접 구동한다(1R 검토 ⓐ-2 표의 26종, 책임자 축
// ⓐ~ⓕ 범주 23종 + 덧 3종 = 26). 표 한 줄 = 칸 하나(프로덕션 export인
// checkRelayHandshake를 CLI로 직접 구동 -- 헛시험 1형태 아님).
// ===========================================================================
// (라벨, g1 3줄 생성기) -- 전부 값은 원장(RUNTIME_TASK_ID/PANE_KEY)과 같다.
const FORMAT_ONLY_VARIANTS = [
  [
    "ⓐ 줄 앞 공백(dispatch_verified)",
    () =>
      ` dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓐ 줄 앞 공백(pane_match)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\n pane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓑ tid 백틱",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: \`${RUNTIME_TASK_ID}\`\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓑ tid 큰따옴표",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: "${RUNTIME_TASK_ID}"\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓑ pane 백틱",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: \`${PANE_KEY}\` == \`${PANE_KEY}\` ? 일치\n`,
  ],
  [
    "ⓑ dispatch_verified 백틱",
    () =>
      `dispatch_verified: \`yes\`\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓒ Yes",
    () =>
      `dispatch_verified: Yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓒ YES",
    () =>
      `dispatch_verified: YES\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓒ pane 대문자",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY.toUpperCase()} == ${PANE_KEY.toUpperCase()} ? 일치\n`,
  ],
  [
    "ⓒ tid 대문자",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID.toUpperCase()}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓓ 구분자 =",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} = ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓓ 구분자 ===",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} === ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓓ 구분자 ->",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} -> ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓓ 전각 ？",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ？ 일치\n`,
  ],
  [
    "ⓓ `?` 없음(아카이브 모양, 실라운드 공유)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} 일치\n`,
  ],
  [
    "ⓔ 끝낱말 생략(`?` 있음)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ?\n`,
  ],
  [
    "ⓔ 끝낱말 생략(`?` 없음)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY}\n`,
  ],
  [
    "ⓔ 일치함",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치함\n`,
  ],
  [
    "ⓔ match",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? match\n`,
  ],
  [
    "ⓔ (일치)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? (일치)\n`,
  ],
  [
    "ⓕ 키 대소문자 Dispatch_Verified",
    () =>
      `Dispatch_Verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓕ 키 대소문자 TASK_ID_FROM_DISPATCH",
    () =>
      `dispatch_verified: yes\nTASK_ID_FROM_DISPATCH: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓕ 키 대소문자 Pane_Match",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\nPane_Match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "덧 굵게(**dispatch_verified:**)",
    () =>
      `**dispatch_verified:** yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "덧 목록 기호(- )",
    () =>
      `- dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "덧 전각 콜론",
    () =>
      `dispatch_verified： yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
];

assert.equal(
  FORMAT_ONLY_VARIANTS.length,
  26,
  "1R 검토 ⓐ-2 표의 26종과 칸 수가 일치해야 한다(표 드리프트 방지)",
);

for (const [label, buildG1] of FORMAT_ONLY_VARIANTS) {
  test(`(g1-fmt)★ 형식만 다른 표본(값은 원장과 같음) -- ${label} -> 실 CLI exit 0(소비)`, () => {
    withFixtureDir("g1-fmt-", (dir) => {
      writeCoderRound(dir, { g1: buildG1() });
      const ledgerPath = withLedger(dir, [validReceipt()]);
      const res = runCli(["coder", dir], { ledgerPath });
      assert.equal(
        res.exit,
        0,
        `값은 원장과 같은데 줄 모양만 다르다는 이유로 거부되면 안 된다. stderr: ${res.stderr}`,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// ⓑ 1R 검토가 모은 실라운드 5건의 공유 모양 -- `?` 없이 "<pane> == <pane>
// 일치"(아카이브에서 그대로 재현한 모양, 위 FORMAT_ONLY_VARIANTS의 "`?`
// 없음" 항과 값은 같지만 이 표본은 "실라운드 재현"이라는 목적 자체를
// 전용 시험으로 고정해 둔다(coder-task.md §2 요구 7-ⓑ).
// ---------------------------------------------------------------------------
test('(g1-livefmt)★ 실라운드 5건 공유 모양: pane_match가 `?` 없이 "<pane> == <pane> 일치"로만 끝나도 소비된다', () => {
  withFixtureDir("g1-livefmt-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.equal(res.exit, 0, `stderr: ${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// ⓒ 부재 3종 -- 키 하나씩만 없음 -> 거부 + 사유에 «그 줄 이름»이 찍힌다
// (1R P2-1: 변이 R1/R2가 이 칸이 없어서 생존했다 -- 이 칸이 그 생존을
// 다시 빨갛게 만든다, 아래 (g1-mut-v4)).
// ---------------------------------------------------------------------------
test("(g1-absent-dv)★ 부재: dispatch_verified: 줄만 없음 -> 거부, 사유에 그 줄 이름이 찍힌다", () => {
  withFixtureDir("g1-absent-dv-", (dir) => {
    writeCoderRound(dir, {
      g1: `task_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'dispatch_verified:' line missing/);
  });
});

test("(g1-absent-tid)★ 부재: task_id_from_dispatch: 줄만 없음 -> 거부, 사유에 그 줄 이름이 찍힌다", () => {
  withFixtureDir("g1-absent-tid-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'task_id_from_dispatch:' line missing/);
  });
});

test("(g1-absent-pane)★ 부재: pane_match: 줄만 없음 -> 거부, 사유에 그 줄 이름이 찍힌다", () => {
  withFixtureDir("g1-absent-pane-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'pane_match:' line missing/);
  });
});

// ---------------------------------------------------------------------------
// ⓔ pane 비대칭 2종 -- 한쪽만 영수증과 같음 -> 거부(1R P2-2: 변이 R5가
// 이 칸이 없어서 생존했다, 아래 (g1-mut-v5)가 다시 빨갛게 만든다).
// ---------------------------------------------------------------------------
// HYK-434 3R §2-4 표 7(`Q P == P ? 일치`)/책임자 판정 ⓒ "전부": 비대칭
// 위조는 "x" 같은 비-토큰이 아니라 «다른» 완전한 토큰(Q)으로 시험해야
// 한다(위 OTHER_PANE_KEY 주석 참조) -- "x"는 토큰 추출 대상이 아니라서
// 더 이상 거부 사유가 되지 않는다(아래 (g1-nontoken-side) 표본이 그
// 반대 성질을 고정한다).
test("(g1-pane-asym-left)★ pane 비대칭: 왼쪽만 다른 토큰(`Q == <정답>`) -> 거부(값, 사유에 Q)", () => {
  withFixtureDir("g1-pane-asym-left-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${OTHER_PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'pane_match:' line value mismatch/);
    assert.match(res.stderr, new RegExp(`found '${OTHER_PANE_KEY}'`));
    assert.doesNotMatch(res.stderr, new RegExp(`found '[^']*${PANE_KEY}'`));
  });
});

test("(g1-pane-asym-right)★ pane 비대칭: 오른쪽만 다른 토큰(`<정답> == Q`) -> 거부(값, 사유에 Q)", () => {
  withFixtureDir("g1-pane-asym-right-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${OTHER_PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'pane_match:' line value mismatch/);
    assert.match(res.stderr, new RegExp(`found '${OTHER_PANE_KEY}'`));
  });
});

// HYK-434 3R §2-4 표 8("P ? 일치", 토큰 1개 = 정답) 판정 ⓒ "최소 1개":
// 반대편이 토큰 모양을 전혀 갖추지 않은 문자열("x")이면 그 자리는
// "다른 값"이 아니라 "토큰이 없는 자리"로 취급돼, 남은 한 개의 올바른
// 토큰만으로 소비된다.
test('(g1-nontoken-side)★ pane_match: 한쪽이 토큰 모양이 아닌 문자열("x")이고 반대쪽이 정답 1개뿐이어도 소비된다(판정 ⓒ "최소 1개")', () => {
  withFixtureDir("g1-pane-nontoken-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: x == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.equal(res.exit, 0, `stderr: ${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// ⓘ 백틱 값이 «실제로 다르면» value mismatch(줄 이름 포함)로 거부된다 --
// 형식(백틱 자체)이 "value mismatch"로 찍히는 1R P2-4와 달리, 여기는
// 값이 진짜 다른 경우라 "value mismatch"가 정답이다.
// ---------------------------------------------------------------------------
test("(g1-backtick-tid-diff)★ 백틱 tid인데 값 자체가 다름 -> 'task_id_from_dispatch:' value mismatch로 거부(형식 문제로 오인되지 않는다)", () => {
  withFixtureDir("g1-backtick-tid-diff-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: \`task_wrongwrongwrong\`\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'task_id_from_dispatch:' line value mismatch/);
    assert.match(res.stderr, /found 'task_wrongwrongwrong'/);
  });
});

test("(g1-backtick-pane-diff)★ 백틱 pane인데 값 자체가 다름 -> 'pane_match:' value mismatch로 거부(형식 문제로 오인되지 않는다)", () => {
  withFixtureDir("g1-backtick-pane-diff-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: \`${OTHER_PANE_KEY}\` == \`${OTHER_PANE_KEY}\` ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'pane_match:' line value mismatch/);
    assert.match(
      res.stderr,
      new RegExp(`found '${OTHER_PANE_KEY}', '${OTHER_PANE_KEY}'`),
    );
  });
});

// ===========================================================================
// 되돌림 변이 V1~V5(coder-task.md §2 요구 8) -- 2R이 추가한 값-대조
// 로직 자체를 하나씩 무력화해, 바로 위 ⓐ~ⓘ 칸들이 «실제로 그 코드가
// 지탱한다»는 것을 보인다(헛시험 방지, 1R과 같은 관용구).
// ===========================================================================

// V1: stripG1ValueDecoration의 장식 벗기기를 제거 -> 백틱으로 감싼 값(ⓘ)이
// 다시 거부된다(RED).
test("(g1-mut-v1)★ 되돌림 변이 V1: stripG1ValueDecoration의 장식 벗기기를 제거하면 -- 백틱으로 감싼 tid(값은 같음)가 다시 거부된다(RED)", () => {
  withFixtureDir("g1-mutv1-", (dir) => {
    const target =
      'function stripG1ValueDecoration(raw) {\n  return raw\n    .trim()\n    .replace(/^[`\'"*]+/, "")\n    .replace(/[`\'"*]+$/, "")\n    .trim();\n}';
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "stripG1ValueDecoration body");
    const replacement =
      "function stripG1ValueDecoration(raw) {\n  return raw; // HYK-434 되돌림 변이 V1: 장식 벗기기 제거\n}";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: \`${RUNTIME_TASK_ID}\`\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.notEqual(
      mutRes.exit,
      0,
      `RED 필수: 장식 벗기기가 없으면 백틱 값(값은 같음)이 다시 거부돼야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.equal(originalRes.exit, 0, "원본은 같은 표본을 통과시킨다(대조군)");
  });
});

// V2: pane_match 키 대소문자 무시(/i)를 제거 -> 키 대소문자 변형(ⓐ)이
// 다시 거부된다(RED).
test("(g1-mut-v2)★ 되돌림 변이 V2: pane_match 키 대소문자 무시를 제거하면 -- 'Pane_Match:' 키 대소문자 표본이 다시 거부된다(RED)", () => {
  withFixtureDir("g1-mutv2-", (dir) => {
    const target = "[ \\t]*$/gim;\nconst PANE_MATCH_ANYWHERE_RE";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "PANE_MATCH_RE_G flags");
    const replacement = "[ \\t]*$/gm;\nconst PANE_MATCH_ANYWHERE_RE";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\nPane_Match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.notEqual(
      mutRes.exit,
      0,
      `RED 필수: pane_match 키 대소문자 무시가 없으면 'Pane_Match:' 표본이 다시 거부돼야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.equal(originalRes.exit, 0, "원본은 같은 표본을 통과시킨다(대조군)");
  });
});

// V3: pane_match 토큰 추출을 1R 정규식(`\?` 필수)으로 되돌림 -> `?` 없는
// 실라운드 모양(ⓑ)이 다시 거부된다(RED).
test("(g1-mut-v3)★ 되돌림 변이 V3: pane_match 추출을 1R 정규식(`\\?` 필수)으로 되돌리면 -- `?` 없는 실라운드 모양이 다시 거부된다(RED)", () => {
  withFixtureDir("g1-mutv3-", (dir) => {
    const target =
      "const PANE_MATCH_RE_G =\n  /^[ \\t]*(?:[-*+][ \\t]+|\\d+\\.[ \\t]+)?\\*{0,2}pane_match\\*{0,2}[ \\t]*[:：][ \\t]*\\*{0,2}[ \\t]*(\\S.*?)[ \\t]*$/gim;";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "PANE_MATCH_RE_G declaration");
    const replacement =
      "const PANE_MATCH_RE_G =\n  /^pane_match:[ \\t]*(\\S+)[ \\t]*==[ \\t]*(\\S+)[ \\t]*\\?[ \\t]*(일치|불일치)[ \\t]*$/gm; // HYK-434 되돌림 변이 V3: 1R 정규식 복귀";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} 일치\n`,
    });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.notEqual(
      mutRes.exit,
      0,
      `RED 필수: \`?\` 필수 정규식으로 되돌리면 \`?\` 없는 표본이 다시 거부돼야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.equal(originalRes.exit, 0, "원본은 같은 표본을 통과시킨다(대조군)");
  });
});

// V4: resolveG1StandaloneLine의 "missing" 사유에서 ${label}(줄 이름)을
// 제거 -> (g1-absent-*) 표본들의 줄 이름 단언이 다시 빨개진다(RED).
test("(g1-mut-v4)★ 되돌림 변이 V4: missing 사유에서 줄 이름을 제거하면 -- 부재 표본의 '줄 이름 고정' 단언이 다시 빨개진다(RED)", () => {
  withFixtureDir("g1-mutv4-", (dir) => {
    const target =
      "  return {\n    ok: false,\n    reason: `${label} missing (no standalone column-0 line found, HYK-434)`,\n  };";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(
      original,
      target,
      "resolveG1StandaloneLine missing reason",
    );
    const replacement =
      "  return {\n    ok: false,\n    reason: `missing (no standalone column-0 line found, HYK-434)`, // HYK-434 되돌림 변이 V4: 줄 이름 제거\n  };";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, {
      g1: `task_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`, // dispatch_verified 부재
    });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.notEqual(
      mutRes.exit,
      0,
      "변이 후에도 거부는 유지된다(기능 자체는 안 바뀜)",
    );
    assert.doesNotMatch(
      mutRes.stderr,
      /'dispatch_verified:' line missing/,
      "RED 필수: 줄 이름이 제거되면 (g1-absent-dv)와 같은 단언이 더 이상 맞지 않아야 한다",
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(originalRes.exit, 0);
    assert.match(
      originalRes.stderr,
      /'dispatch_verified:' line missing/,
      "원본은 줄 이름이 찍힌다(대조군)",
    );
  });
});

// ===========================================================================
// HYK-434 3R §2-4 고정 칸(기대값 표) -- pane_match 전부-추출 알고리즘이
// 실제로 책임자 판정 ⓒ("전부 뽑아 전부 = assignee_pane_key · 최소 1개")를
// 구현하는지, 표의 나머지 행(5·6·9·10·11·13·14·16·21·22·23·29a·31)을
// 실 CLI로 직접 구동한다. (행 7·8은 위 asym-left/nontoken-side 전용
// 시험이 이미 고정한다.)
// ===========================================================================
const PANE_FIXED_CELL_TABLE = [
  [
    "표5: P == P == Q ? 일치(토큰 3, 하나 다름) -> 거부(값·Q)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} == ${OTHER_PANE_KEY} ? 일치\n`,
    { exit: "reject", reasonIncludes: [OTHER_PANE_KEY] },
  ],
  [
    "표6: P == P ? 일치 (Q) -> 거부(값·Q)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치 (${OTHER_PANE_KEY})\n`,
    { exit: "reject", reasonIncludes: [OTHER_PANE_KEY] },
  ],
  [
    "표9: ? 일치(토큰 0) -> 거부(형식)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ? 일치\n`,
    { exit: "reject", reasonIncludes: ["no pane key token"] },
  ],
  [
    "표10: P==P ? 일치(공백 없음) -> 소비",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY}==${PANE_KEY} ? 일치\n`,
    { exit: "consume" },
  ],
  [
    "표11: P== P ? 일치 -> 소비",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY}== ${PANE_KEY} ? 일치\n`,
    { exit: "consume" },
  ],
  [
    "표13: P->P ? 일치(공백 없는 화살표) -> 소비",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY}->${PANE_KEY} ? 일치\n`,
    { exit: "consume" },
  ],
  [
    "표14: P → P ? 일치(유니코드 화살표) -> 소비",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} → ${PANE_KEY} ? 일치\n`,
    { exit: "consume" },
  ],
  [
    "표16: Px == Px(접미 위조, 토큰 경계 침범) -> 거부(토큰 0 = 형식)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY}x == ${PANE_KEY}x ? 일치\n`,
    { exit: "reject", reasonIncludes: ["no pane key token"] },
  ],
  [
    "표29a: pane_match 줄이 `+ ` 목록 기호 -> 소비",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\n+ pane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    { exit: "consume" },
  ],
  [
    "표29a: pane_match 줄이 `1. ` 번호 목록 기호 -> 소비",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\n1. pane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    { exit: "consume" },
  ],
  [
    "표31: pane 자리표시 템플릿(<ORCA_PANE_KEY 값> == …) -> 거부(형식·토큰 0)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: <ORCA_PANE_KEY 값> == <assignee_pane_key 값> ? 일치|불일치\n`,
    { exit: "reject", reasonIncludes: ["no pane key token"] },
  ],
];

for (const [label, buildG1, expect_] of PANE_FIXED_CELL_TABLE) {
  test(`(g1-table)★ HYK-434 3R 고정 칸 -- ${label}`, () => {
    withFixtureDir("g1-table-", (dir) => {
      writeCoderRound(dir, { g1: buildG1() });
      const ledgerPath = withLedger(dir, [validReceipt()]);
      const res = runCli(["coder", dir], { ledgerPath });
      if (expect_.exit === "consume") {
        assert.equal(res.exit, 0, `기대: 소비. stderr: ${res.stderr}`);
      } else {
        assert.notEqual(res.exit, 0, "기대: 거부");
        for (const needle of expect_.reasonIncludes ?? []) {
          assert.ok(
            res.stderr.includes(needle),
            `사유에 '${needle}'가 있어야 한다. stderr: ${res.stderr}`,
          );
        }
      }
    });
  });
}

// HYK-434 3R §2-3(P2-1 수리, 판정 ⓐ) -- 들여쓴 펜스·코드 블록도 G1 판독
// 경로에서는 "인용"으로 가려진다(표21·22·23).
test("(g1-indented-codeblock)★ 표21: G1 3줄이 4칸 들여쓴 코드 블록 안«에만» 있다 -> 마스킹되어 부재로 거부", () => {
  withFixtureDir("g1-indented-code-", (dir) => {
    const indented =
      "example only, not a real declaration.\n\n" +
      `    dispatch_verified: yes\n    task_id_from_dispatch: ${RUNTIME_TASK_ID}\n    pane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`;
    writeCoderRound(dir, { g1: "", extra: indented });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /missing \(no standalone column-0 line found/);
  });
});

test("(g1-indented-fence)★ 표22: 목록 안 4칸 들여쓴 펜스 안«에만» G1 3줄이 있다 -> 마스킹되어 부재로 거부", () => {
  withFixtureDir("g1-indented-fence-", (dir) => {
    const indentedFence =
      "- example:\n\n" +
      "    ```\n" +
      `    dispatch_verified: yes\n    task_id_from_dispatch: ${RUNTIME_TASK_ID}\n    pane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n` +
      "    ```\n";
    writeCoderRound(dir, { g1: "", extra: indentedFence });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /missing \(no standalone column-0 line found/);
  });
});

test("(g1-indented-fence-plus-real)★ 표23: 실제 3줄 + 목록 안 4칸 펜스 예시(dispatch_verified: no) -> 소비(예시는 중복으로 안 센다)", () => {
  withFixtureDir("g1-indented-fence-real-", (dir) => {
    const indentedFenceExample =
      "\n- example of a bad declaration:\n\n" +
      "    ```\n    dispatch_verified: no\n    ```\n";
    writeCoderRound(dir, { g1: g1Block(), extra: indentedFenceExample });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.equal(res.exit, 0, `stderr: ${res.stderr}`);
  });
});

// ===========================================================================
// HYK-434 3R §2-5 되돌림 변이 T1~T4 -- 2R에서 V3/V5가 맡던 자리를
// 대체한다(2R의 "구분자 앞뒤 두 토큰" 구조 자체가 사라졌으므로, 그
// 구조를 되돌리는 쪽이 이제 더 정확한 회귀 시험이다).
// ===========================================================================

// T1: 토큰 "전부 추출" 대신 2R의 "구분자 앞뒤 두 토큰" 정규식으로 되돌리면
// -- 표 5·6·8·10·11·14가 RED여야 한다(책임자 판정 ⓒ "전부"·"최소 1개"를
// 지탱하는 바로 그 코드).
test("(g1-mut-t1)★ 되돌림 변이 T1: 토큰 전부 추출을 2R의 '구분자 앞뒤 두 토큰' 정규식으로 되돌리면 -- 표 5·6·8·10·11·14가 RED다", () => {
  withFixtureDir("g1-mutt1-", (dir) => {
    const target =
      "  // §2-1 요구 2: V(콜론 뒤 값부 전체)를 구분자로 쪼개지 않는다.\n  const valuePart = pm.match[1];\n  // §2-1 요구 3: pane key 모양 토큰을 전부 뽑는다(원문 그대로 -- 가공\n  // 하지 않는다, §2-1 요구 7 \"사유에 캡처 가공 값을 넣지 마라\").\n  const tokens = [...valuePart.matchAll(PANE_TOKEN_RE_G)].map((m) => m[0]);\n  // §2-1 요구 4: 토큰 0개 = 형식 거부(값 거부가 아니다).\n  if (tokens.length === 0) {\n    return {\n      ok: false,\n      reason: `G1 cross-check failed (HYK-434): 'pane_match:' line has no pane key token (HYK-434, line: '${valuePart}')`,\n    };\n  }\n  // §2-1 요구 5: 뽑은 토큰 전부가 영수증 값과 같아야 한다(대소문자\n  // 무시) -- 하나라도 다르면 값 거부, 사유에 다른 토큰 전부를 원문\n  // 그대로 적는다(여럿이면 전부).\n  const expectedLower = expectedPaneKey.toLowerCase();\n  const mismatched = tokens.filter((t) => t.toLowerCase() !== expectedLower);\n  if (mismatched.length > 0) {\n    return {\n      ok: false,\n      reason: `G1 cross-check failed (HYK-434): 'pane_match:' line value mismatch -- expected '${expectedPaneKey}' (most recent matching dispatch ledger record, recorded_at=${recordedAt}), found '${mismatched.join(\"', '\")}'`,\n    };\n  }\n  // §2-1 요구 6: 전부 같으면 끝으로 \"불일치\" 선언 여부만 본다(판정 ⓑ).\n  // 끝 낱말 `일치`·`?`의 유무·철자는 보지 않는다.\n  if (valuePart.includes(\"불일치\")) {\n    return {\n      ok: false,\n      reason: `G1 cross-check failed (HYK-434): 'pane_match:' line mismatch -- worker declared 불일치 even though both pane keys equal '${expectedPaneKey}' (HYK-434)`,\n    };\n  }\n  return { ok: true };\n}";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "resolveG1PaneMatchVerdict body");
    const replacement =
      "  // HYK-434 되돌림 변이 T1: 토큰 전부 추출 대신 \"구분자 앞뒤 두 토큰\"만\n  // 보는 2R 구조로 되돌린다.\n  const twoTokenMatch = pm.match[1].match(\n    /^(\\S+)[ \\t]*(?:={1,3}|->)[ \\t]*(\\S+)(.*)$/,\n  );\n  if (!twoTokenMatch) {\n    return {\n      ok: false,\n      reason: `G1 cross-check failed (HYK-434): 'pane_match:' line has no pane key token (HYK-434, line: '${pm.match[1]}')`,\n    };\n  }\n  const leftKey = twoTokenMatch[1];\n  const rightKey = twoTokenMatch[2];\n  const trailing = twoTokenMatch[3] ?? \"\";\n  if (\n    leftKey.toLowerCase() !== expectedPaneKey.toLowerCase() ||\n    rightKey.toLowerCase() !== expectedPaneKey.toLowerCase()\n  ) {\n    return {\n      ok: false,\n      reason: `G1 cross-check failed (HYK-434): 'pane_match:' line value mismatch -- expected '${expectedPaneKey}', found '${leftKey}', '${rightKey}'`,\n    };\n  }\n  if (trailing.includes(\"불일치\")) {\n    return {\n      ok: false,\n      reason: `G1 cross-check failed (HYK-434): 'pane_match:' line mismatch -- worker declared 불일치 even though both pane keys equal '${expectedPaneKey}' (HYK-434)`,\n    };\n  }\n  return { ok: true };\n}";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const samples = [
      ["표5", `${PANE_KEY} == ${PANE_KEY} == ${OTHER_PANE_KEY} ? 일치`],
      ["표6", `${PANE_KEY} == ${PANE_KEY} ? 일치 (${OTHER_PANE_KEY})`],
      ["표8", `${PANE_KEY} ? 일치`],
      ["표10", `${PANE_KEY}==${PANE_KEY} ? 일치`],
      ["표11", `${PANE_KEY}== ${PANE_KEY} ? 일치`],
      ["표14", `${PANE_KEY} → ${PANE_KEY} ? 일치`],
    ];
    for (const [rowLabel, paneLine] of samples) {
      const roundDir = join(dir, `round-${rowLabel}`);
      mkdirSync(roundDir);
      writeCoderRound(roundDir, {
        g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${paneLine}\n`,
      });
      const ledgerPath = withLedger(roundDir, [validReceipt()]);
      writeFileSync(
        join(roundDir, "dispatch-receipt-path.txt"),
        ledgerPath,
        "utf8",
      );

      const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
      const originalRes = runCli(["coder", roundDir], { ledgerPath });
      assert.notEqual(
        mutRes.exit === 0,
        originalRes.exit === 0,
        `RED 필수(${rowLabel}): T1 변이는 원본과 다른 판정을 내야 한다. mut exit=${mutRes.exit} stderr=${mutRes.stderr} / original exit=${originalRes.exit} stderr=${originalRes.stderr}`,
      );
    }
  });
});

// T2: 토큰 경계(lookbehind/lookahead)를 제거하면 -- 표16(접미 위조)이
// RED다(최소 1개 규칙이 접미 위조까지 "정답"으로 받아들여 버린다).
test("(g1-mut-t2)★ 되돌림 변이 T2: pane 토큰 경계(lookbehind/lookahead)를 제거하면 -- 표16(접미 위조)이 다시 소비된다(RED)", () => {
  withFixtureDir("g1-mutt2-", (dir) => {
    const target =
      "const PANE_TOKEN_RE_G =\n  /(?<![0-9A-Za-z_:-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z_:-])/gi;";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "PANE_TOKEN_RE_G declaration");
    const replacement =
      "const PANE_TOKEN_RE_G =\n  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi; // HYK-434 되돌림 변이 T2: 경계 제거";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY}x == ${PANE_KEY}x ? 일치\n`,
    });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.equal(
      mutRes.exit,
      0,
      `RED 필수: 경계가 없으면 접미 위조(표16)가 소비돼야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      originalRes.exit,
      0,
      "원본은 같은 표본을 반드시 거부한다(대조군)",
    );
  });
});

// T3: G1 판독의 마스킹 확장(들여쓴 펜스·코드 블록)을 제거하면 -- 표21이
// RED다(예시가 "진짜"로 읽혀 소비된다, P2-1 회귀).
test("(g1-mut-t3)★ 되돌림 변이 T3: G1 판독의 마스킹 확장(들여쓴 펜스·코드 블록)을 제거하면 -- 표21의 들여쓴 예시가 다시 소비된다(RED)", () => {
  withFixtureDir("g1-mutt3-", (dir) => {
    const target =
      "  const scan = maskQuotedMarkerRegions(content, { indentedBlocks: true });";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(
      original,
      target,
      "resolveG1StandaloneLine masking option",
    );
    const replacement =
      "  const scan = maskQuotedMarkerRegions(content); // HYK-434 되돌림 변이 T3: 들여쓴 블록 마스킹 확장 제거";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    const indented =
      "example only, not a real declaration.\n\n" +
      `    dispatch_verified: yes\n    task_id_from_dispatch: ${RUNTIME_TASK_ID}\n    pane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`;
    writeCoderRound(roundDir, { g1: "", extra: indented });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.equal(
      mutRes.exit,
      0,
      `RED 필수: 마스킹 확장이 없으면 들여쓴 예시가 진짜로 읽혀 소비돼야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      originalRes.exit,
      0,
      "원본은 같은 표본을 부재로 거부한다(대조군)",
    );
  });
});

// ===========================================================================
// HYK-434 책임자 판정(2026-10-14 11:4x §2 · 2026-10-15 13:41 §5-(2)) --
// 3R 검토 P2-1이 지적한 "기대값 표 33행 중 11행(4·12·15·17·19·20·24·26·
// 27·29b·32)에 고정 칸이 없다"를 닫는다. 각 행은 REVIEW-r3.md ⓐ의 HEAD
// 열 실측(실제 CLI 세 판 대조)을 그대로 옮긴다 -- 새 정규식·새 판정을
// 발명하지 않고, 이미 HEAD가 실제로 내는 판정을 칸으로 고정할 뿐이다.
// 표 19만 예외: 3R 기대값은 "부재"였지만 HEAD 실제 행동은 "형식"이다
// (`>` 인용 접두가 리스트 마커 집합 밖이라 reGlobal이 못 보고,
// reAnywhere는 보므로 형식 거부로 떨어진다) -- 이 조각은 §2 point1이
// 지시한 대로 "지금 HEAD 행동(형식 거부)"을 고정하고 그 차이를 여기
// 주석과 결과 파일에 갈라 적는다(P3-1, 코드 변경 0).
// ===========================================================================
const HEAD_FIXED_CELL_TABLE_2 = [
  [
    "표4: tid 장식 덩어리 `*'\"tid\"'*`(백틱+별+홑따옴표+겹따옴표 겹침) -> 소비(stripG1ValueDecoration이 좌우 run을 전부 벗긴다, 3R REVIEW-r2 ⓘ)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: \`*'"${RUNTIME_TASK_ID}"'*\`\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    { exit: "consume" },
  ],
  [
    "표12: pane_match: P ==P ? 일치(== 앞만 공백, 뒤는 없음) -> 소비",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} ==${PANE_KEY} ? 일치\n`,
    { exit: "consume" },
  ],
  [
    "표15a: tid 접미 위조(task_aaaa…x) -> 거부(값), 사유에 원문 그대로",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}x\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    {
      exit: "reject",
      reasonIncludes: [
        "'task_id_from_dispatch:' line value mismatch",
        `found '${RUNTIME_TASK_ID}x'`,
      ],
    },
  ],
  [
    "표15b: tid 접두 위조(xtask_aaaa…) -> 거부(값), 사유에 원문 그대로",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: x${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    {
      exit: "reject",
      reasonIncludes: [
        "'task_id_from_dispatch:' line value mismatch",
        `found 'x${RUNTIME_TASK_ID}'`,
      ],
    },
  ],
  [
    "표17: pane_match: 줄 + Pane_Match: 줄(대소문자만 다름, 둘 다 값은 원장과 같음) -> 거부(모호, 어느 것이 최종인지 결정할 수 없다)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\nPane_Match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    {
      exit: "reject",
      reasonIncludes: [
        "'pane_match:' line has 2 standalone lines",
        "어느 것이 최종인지 결정할 수 없다",
      ],
    },
  ],
  [
    "표19: 인용 `> - dispatch_verified: yes` 만(블록쿼트+목록 겹침) -> 거부(형식) -- ⚠️3R 기대값은 «부재»였으나(P3-1) `>`는 reGlobal의 허용 접두(목록 기호) 밖이라 reAnywhere만 맞아 형식으로 떨어지는 게 HEAD의 실제 행동이다. 이 칸은 그 차이를 그대로 고정한다(코드 변경 0).",
    () =>
      `> - dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    {
      exit: "reject",
      reasonIncludes: [
        "'dispatch_verified:' line present but not a standalone column-0 well-formed line",
      ],
    },
  ],
  [
    "표20: 실제 3줄 + 인용 `> dispatch_verified: no`(뒤에 덧붙은 인용 예시) -> 소비(인용 줄은 reGlobal에 안 걸려 표지로 안 셈, 모호도 아니다)",
    () => g1Block() + "> dispatch_verified: no\n",
    { exit: "consume" },
  ],
  [
    "표24: 실제 3줄 + 일반 마크다운 펜스(0칸 들여쓰기) 예시 -> 소비(펜스 안 예시는 마스킹돼 중복으로 안 센다)",
    () => g1Block() + "```\ndispatch_verified: no\n```\n",
    { exit: "consume" },
  ],
  [
    "표26: dispatch_verified: yes, but…(값 뒤 꼬리 설명) -> 거부(값), 사유에 원문 그대로",
    () =>
      `dispatch_verified: yes, but…\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    {
      exit: "reject",
      reasonIncludes: [
        "'dispatch_verified:' line value mismatch",
        "found 'yes, but…'",
      ],
    },
  ],
  [
    "표27a: dispatch_verified: yes (not really) -> 거부(값), 사유에 원문 그대로",
    () =>
      `dispatch_verified: yes (not really)\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    {
      exit: "reject",
      reasonIncludes: [
        "'dispatch_verified:' line value mismatch",
        "found 'yes (not really)'",
      ],
    },
  ],
  [
    "표27b: dispatch_verified: yes|no -> 거부(값), 사유에 원문 그대로",
    () =>
      `dispatch_verified: yes|no\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    {
      exit: "reject",
      reasonIncludes: [
        "'dispatch_verified:' line value mismatch",
        "found 'yes|no'",
      ],
    },
  ],
  [
    "표29b-dv: `## dispatch_verified: yes`(머리 접두) -> 거부(형식)",
    () =>
      `## dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    {
      exit: "reject",
      reasonIncludes: [
        "'dispatch_verified:' line present but not a standalone column-0 well-formed line",
      ],
    },
  ],
  [
    "표29b-pane: `## pane_match: ...`(머리 접두) -> 거부(형식)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\n## pane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    {
      exit: "reject",
      reasonIncludes: [
        "'pane_match:' line present but not a standalone column-0 well-formed line",
      ],
    },
  ],
  [
    "표32: tid 뒤 꼬리 주석 `(dispatch-show)` -> 거부(값, 꼬리까지 값부로 캡처됨)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID} (dispatch-show)\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    {
      exit: "reject",
      reasonIncludes: [
        "'task_id_from_dispatch:' line value mismatch",
        `found '${RUNTIME_TASK_ID} (dispatch-show)'`,
      ],
    },
  ],
];

for (const [label, buildG1, expect_] of HEAD_FIXED_CELL_TABLE_2) {
  test(`(g1-table2)★ HYK-434 H2 고정 칸(3R P2-1 수리) -- ${label}`, () => {
    withFixtureDir("g1-table2-", (dir) => {
      writeCoderRound(dir, { g1: buildG1() });
      const ledgerPath = withLedger(dir, [validReceipt()]);
      const res = runCli(["coder", dir], { ledgerPath });
      if (expect_.exit === "consume") {
        assert.equal(res.exit, 0, `기대: 소비. stderr: ${res.stderr}`);
      } else {
        assert.notEqual(res.exit, 0, "기대: 거부");
        for (const needle of expect_.reasonIncludes ?? []) {
          assert.ok(
            res.stderr.includes(needle),
            `사유에 '${needle}'가 있어야 한다. stderr: ${res.stderr}`,
          );
        }
      }
    });
  });
}

// ===========================================================================
// HYK-434 H2 S4·S5 -- 3R 검토 ⓔ가 찾은 "행동 RED 0"(헛시험) 두 칸을
// 되돌림 변이로 고정한다(coder-task.md §2 point2). S4/S5 둘 다 프로덕션
// 판정을 실제로 약화시켜, 지금은 거부되는 표본이 그 약화 아래서만
// 소비되는지를 본다(대조군은 원본이 여전히 거부함을 확인).
// ===========================================================================

// S4: task_id_from_dispatch 값 비교를 엄격한 전체 일치(!==)에서 부분
// 일치(includes)로 완화하면 -- 접미 위조(task_aaaa…x)가 소비된다(RED,
// 위조 가능).
test("(g1-mut-s4)★ 되돌림 변이 S4: task_id_from_dispatch 값 비교를 부분 일치(includes)로 완화하면 -- 접미 위조(tid+x) 표본이 소비된다(RED, 위조 가능)", () => {
  withFixtureDir("g1-muts4-", (dir) => {
    const target =
      "  const tidValue = stripG1ValueDecoration(tid.match[1]);\n  if (tidValue.toLowerCase() !== String(latest.runtime_task_id).toLowerCase()) {\n    return {\n      ok: false,\n      reason: `G1 cross-check failed (HYK-434): 'task_id_from_dispatch:' line value mismatch -- expected '${latest.runtime_task_id}' (most recent matching dispatch ledger record, recorded_at=${latest.recorded_at}), found '${tidValue}'`,\n    };\n  }";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(
      original,
      target,
      "task_id_from_dispatch exact-equality check",
    );
    const replacement =
      "  const tidValue = stripG1ValueDecoration(tid.match[1]);\n  // HYK-434 되돌림 변이 S4: 전체 일치 대신 부분 일치(includes)로 완화\n  if (!tidValue.toLowerCase().includes(String(latest.runtime_task_id).toLowerCase())) {\n    return {\n      ok: false,\n      reason: `G1 cross-check failed (HYK-434): 'task_id_from_dispatch:' line value mismatch -- expected '${latest.runtime_task_id}' (most recent matching dispatch ledger record, recorded_at=${latest.recorded_at}), found '${tidValue}'`,\n    };\n  }";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}x\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.equal(
      mutRes.exit,
      0,
      `RED 필수: 부분 일치로 완화되면 접미 위조(tid+x) 표본이 소비돼야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      originalRes.exit,
      0,
      "원본은 같은 표본을 반드시 거부한다(대조군)",
    );
  });
});

// S5: dispatch_verified 키의 허용 접두 집합(목록 기호)에 블록쿼트 `>`를
// 추가하면 -- 인용된 예시 줄이 "진짜 표지"로 읽혀 소비된다(RED, 인용
// 배제라는 설계 의도를 정면으로 깬다).
test("(g1-mut-s5)★ 되돌림 변이 S5: dispatch_verified 키의 접두 허용 집합에 `>`(인용)를 추가하면 -- 인용된 dispatch_verified 줄이 진짜로 읽혀 소비된다(RED)", () => {
  withFixtureDir("g1-muts5-", (dir) => {
    const target =
      "const DISPATCH_VERIFIED_RE_G =\n  /^[ \\t]*(?:[-*+][ \\t]+|\\d+\\.[ \\t]+)?\\*{0,2}dispatch_verified\\*{0,2}[ \\t]*[:：][ \\t]*(\\S.*?)[ \\t]*$/gim;";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(
      original,
      target,
      "DISPATCH_VERIFIED_RE_G declaration",
    );
    const replacement =
      "const DISPATCH_VERIFIED_RE_G =\n  /^[ \\t]*(?:[-*+>][ \\t]+|\\d+\\.[ \\t]+)?\\*{0,2}dispatch_verified\\*{0,2}[ \\t]*[:：][ \\t]*(\\S.*?)[ \\t]*$/gim; // HYK-434 되돌림 변이 S5: 인용 `>` 접두 허용";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, {
      g1: `> dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.equal(
      mutRes.exit,
      0,
      `RED 필수: '>' 접두가 허용되면 인용된 dispatch_verified 줄이 진짜로 읽혀 소비돼야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      originalRes.exit,
      0,
      "원본은 같은 표본을 반드시 거부한다(대조군, '>' 는 허용 접두 밖이라 형식 거부)",
    );
  });
});

// T4: 사유 문자열에 캡처 가공 값(망가진 값)을 쓰면 -- 표5·7의 사유 원문
// 단언이 RED다(§2-1 요구 7 "사유에는 캡처 가공 값을 넣지 마라").
test("(g1-mut-t4)★ 되돌림 변이 T4: 사유에 가공된(망가진) 값을 쓰면 -- 표5·7의 '원문 그대로' 단언이 RED다", () => {
  withFixtureDir("g1-mutt4-", (dir) => {
    const target =
      "      reason: `G1 cross-check failed (HYK-434): 'pane_match:' line value mismatch -- expected '${expectedPaneKey}' (most recent matching dispatch ledger record, recorded_at=${recordedAt}), found '${mismatched.join(\"', '\")}'`,";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "pane mismatch reason (raw token)");
    const replacement =
      "      reason: `G1 cross-check failed (HYK-434): 'pane_match:' line value mismatch -- expected '${expectedPaneKey}' (most recent matching dispatch ledger record, recorded_at=${recordedAt}), found '${mismatched.map((t) => `${t.slice(0, -1)}=`).join(\"', '\")}'`, // HYK-434 되돌림 변이 T4: 사유에 가공 값";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const rows = [
      ["표5", `${PANE_KEY} == ${PANE_KEY} == ${OTHER_PANE_KEY} ? 일치`],
      ["표7", `${OTHER_PANE_KEY} ${PANE_KEY} == ${PANE_KEY} ? 일치`],
    ];
    for (const [rowLabel, paneLine] of rows) {
      const roundDir = join(dir, `round-${rowLabel}`);
      mkdirSync(roundDir);
      writeCoderRound(roundDir, {
        g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${paneLine}\n`,
      });
      const ledgerPath = withLedger(roundDir, [validReceipt()]);
      writeFileSync(
        join(roundDir, "dispatch-receipt-path.txt"),
        ledgerPath,
        "utf8",
      );

      const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
      assert.notEqual(
        mutRes.exit,
        0,
        `${rowLabel}: 여전히 거부돼야 한다(판정 자체는 안 바뀜)`,
      );
      assert.doesNotMatch(
        mutRes.stderr,
        new RegExp(`found '${OTHER_PANE_KEY}'`),
        `RED 필수(${rowLabel}): 사유가 가공되면 원문 그대로의 '${OTHER_PANE_KEY}'가 더 이상 보이지 않아야 한다`,
      );

      const originalRes = runCli(["coder", roundDir], { ledgerPath });
      assert.notEqual(originalRes.exit, 0);
      assert.match(
        originalRes.stderr,
        new RegExp(`found '${OTHER_PANE_KEY}'`),
        `${rowLabel}: 원본은 사유에 원문 그대로의 값을 찍는다(대조군)`,
      );
    }
  });
});
