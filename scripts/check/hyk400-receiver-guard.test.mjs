// HYK-400 2R -- 수신부 능력 확인기 시험. 1R 검토 반려(P1-1/P1-2/P1-3/P2)가
// 잡은 세 축(격리·의미·경계)과 "검사 대상을 호출자가 고르지 못하게"(I4)를
// 전부 적대 표본 + 되돌림 변이로 재확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkReceiptCliFlagSupport,
  deriveOptionalFlags,
  resolveVerifiedTargetPath,
} from "./hyk400-receiver-guard.mjs";

const GUARD_PATH = fileURLToPath(
  new URL("./hyk400-receiver-guard.mjs", import.meta.url),
);
const RUNNER_PATH = fileURLToPath(
  new URL("./hyk400-receiver-probe-runner.mjs", import.meta.url),
);
// HYK-430 1R: guard가 이제 이 형제 파일을 정적 import한다
// (child-probe-timeout-policy.mjs). 격리 mutDir 픽스처(admission-
// completion-spawn.test.mjs와 같은 관례)는 guard·runner 두 파일만
// 복사해 왔으므로, 아래 모든 mutDir 시험에도 이 파일을 함께 복사해야
// MODULE_NOT_FOUND로 깨지지 않는다.
const POLICY_PATH = fileURLToPath(
  new URL("./child-probe-timeout-policy.mjs", import.meta.url),
);
const originalPolicySrc = readFileSync(POLICY_PATH, "utf8");
function seedPolicySibling(mutDir) {
  writeFileSync(
    join(mutDir, "child-probe-timeout-policy.mjs"),
    originalPolicySrc,
  );
}
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

const REAL_DELIVERY_ARGS = [
  "--role",
  "CODER",
  "--task-label",
  "hyk400-real-label",
  "--receipt-path",
  "hyk400-real-receipt-path",
  "--harness-dir",
  "hyk400-real-harness-dir",
];

function seedReceiptCli(worktree, fixtureName) {
  const relayDir = join(worktree, "scripts/relay");
  mkdirSync(relayDir, { recursive: true });
  const dest = join(relayDir, "dispatch-receipt-cli.mjs");
  copyFileSync(join(FIXTURES_DIR, fixtureName), dest);
  return dest;
}

function tmpWorktree(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(args) {
  try {
    const stdout = execFileSync("node", [GUARD_PATH, ...args], {
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

function deliveryArgsFor(worktree) {
  return [
    "--role",
    "CODER",
    "--task-label",
    "probe-label",
    "--receipt-path",
    join(worktree, "receipt.jsonl"),
    "--harness-dir",
    join(worktree, ".harness"),
  ];
}

// ============================================================
// I4 -- 검사 대상 플래그는 호출자가 고르지 않는다(실제 배달 인자에서 유도)
// ============================================================

test("I4: 실제 ps1 delivery 리터럴을 그대로 넣으면 --harness-dir 하나만 유도된다(오늘 현실을 고정)", () => {
  const result = deriveOptionalFlags(REAL_DELIVERY_ARGS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.flags, ["--harness-dir"]);
});

test("I4: deliveryArgs가 비어 있으면(캡션 생략) 조용히 통과하지 않고 거부한다", () => {
  const result = deriveOptionalFlags([]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /RECEIVER_GUARD_BAD_INPUT/);
});

test("I4: deliveryArgs가 undefined면(안 넘김) 거부한다 -- 1R의 opt-out 구멍 삭제 확인", () => {
  const result = deriveOptionalFlags(undefined);
  assert.equal(result.ok, false);
  assert.match(result.reason, /RECEIVER_GUARD_BAD_INPUT/);
});

test("I4: 필수 3필드가 없는 배열은 '진짜 배달 인자'로 보지 않고 거부한다", () => {
  const result = deriveOptionalFlags(["--harness-dir", "x"]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /RECEIVER_GUARD_BAD_INPUT/);
});

test("I4: 필수 3필드만 있고 선택 플래그가 없으면(진짜 배달 인자) 검사 대상 0개로 유도된다", async () => {
  const args = ["--role", "R", "--task-label", "L", "--receipt-path", "P"];
  const derived = deriveOptionalFlags(args);
  assert.equal(derived.ok, true);
  assert.deepEqual(derived.flags, []);

  const result = await checkReceiptCliFlagSupport({
    worktree: "/this/path/does/not/exist/at/all",
    deliveryArgs: args,
  });
  assert.equal(result.ok, true);
  assert.equal(result.supported, true);
  assert.equal(result.reason, "NO_OPTIONAL_FLAGS_IN_DELIVERY");
});

test("I4 되돌림: 0-flags 통과는 '구조적으로 유도된 사실'이지 '캡션 생략'이 아니다 -- 진짜 배달 인자가 아니면 여전히 거부됨을 대조", async () => {
  const emptyResult = await checkReceiptCliFlagSupport({
    worktree: REPO_ROOT,
    deliveryArgs: [],
  });
  assert.equal(
    emptyResult.ok,
    false,
    "빈 배열은 여전히 거부(RED가 아니어야 함)",
  );
  assert.match(emptyResult.reason, /RECEIVER_GUARD_BAD_INPUT/);
});

// ============================================================
// I3 -- 경계: realpath가 워크트리 밖을 가리키면 거부
// ============================================================

test("I3: 심링크가 다른 저장소를 가리키면 거부된다(RECEIVER_CLI_BOUNDARY_ESCAPE)", () => {
  const worktree = tmpWorktree("hyk400-boundary-worktree-");
  const outside = tmpWorktree("hyk400-boundary-outside-");
  try {
    const relayDir = join(worktree, "scripts/relay");
    mkdirSync(relayDir, { recursive: true });
    const outsideFile = join(outside, "evil-receipt-cli.mjs");
    copyFileSync(
      join(FIXTURES_DIR, "hyk400-hostile-different-meaning.mjs.txt"),
      outsideFile,
    );
    symlinkSync(
      outsideFile,
      join(relayDir, "dispatch-receipt-cli.mjs"),
      "file",
    );

    const resolved = resolveVerifiedTargetPath({ worktree });
    assert.equal(resolved.ok, false);
    assert.match(resolved.reason, /RECEIVER_CLI_BOUNDARY_ESCAPE/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("I3 되돌림: 경계 검사를 끄면 같은 심링크가 통과해 버린다(RED) -- 원본 소스는 손대지 않는다", async () => {
  const originalGuardSrc = readFileSync(GUARD_PATH, "utf8");
  const originalRunnerSrc = readFileSync(RUNNER_PATH, "utf8");

  const anchor =
    "if (targetReal !== worktreeReal && !targetReal.startsWith(boundary)) {\n    return rejected(\n      `RECEIVER_CLI_BOUNDARY_ESCAPE: ${candidatePath} 가 워크트리 경계 밖(${targetReal})을 가리킨다(심링크/다른 저장소/경로 탈출 의심)`,\n    );\n  }";
  assert.ok(
    originalGuardSrc.includes(anchor),
    "mutation anchor not found -- guard source drifted",
  );
  const mutatedSrc = originalGuardSrc.replace(anchor, "/* I3 mutated off */");
  assert.notEqual(mutatedSrc, originalGuardSrc);

  const mutDir = tmpWorktree("hyk400-i3-mutant-");
  const worktree = tmpWorktree("hyk400-i3-boundary-worktree-");
  const outside = tmpWorktree("hyk400-i3-boundary-outside-");
  try {
    writeFileSync(join(mutDir, "hyk400-receiver-guard.mjs"), mutatedSrc);
    writeFileSync(
      join(mutDir, "hyk400-receiver-probe-runner.mjs"),
      originalRunnerSrc,
    );
    seedPolicySibling(mutDir);

    const relayDir = join(worktree, "scripts/relay");
    mkdirSync(relayDir, { recursive: true });
    // 밖을 가리키는 대상은 --harness-dir을 «정말로» 지원하는(=이 저장소 실물)
    // 파일이어야 한다 -- 경계 검사가 살아 있을 때 거부의 원인이 "경계"뿐임을
    // 확실히 하기 위해서다(의미 검사까지 우연히 걸려 RED가 안 나오는 것을 방지).
    const outsideFile = join(outside, "real-receipt-cli.mjs");
    copyFileSync(
      join(REPO_ROOT, "scripts/relay/dispatch-receipt-cli.mjs"),
      outsideFile,
    );
    symlinkSync(
      outsideFile,
      join(relayDir, "dispatch-receipt-cli.mjs"),
      "file",
    );

    // I1(--allow-fs-read이 worktreeReal로 스코프됨)이 이 축과 별개로
    // "경계 밖 파일을 읽지도 못하게" 이미 막는다(의도된 이중 방어) --
    // 그래서 이 변이는 전체 파이프라인이 아니라 I3를 «직접» 구현하는
    // resolveVerifiedTargetPath 단위에서 확인한다(I1의 방어가 신호를
    // 가리는 것을 피하기 위해).
    const mutatedGuard = await import(
      pathToFileURL(join(mutDir, "hyk400-receiver-guard.mjs")).href
    );
    const resolved = mutatedGuard.resolveVerifiedTargetPath({ worktree });
    assert.equal(
      resolved.ok,
      true,
      "I3 변이 후에는 경계 탈출 대상의 realpath 검사가 통과해 버린다(RED, 경계 검사가 실제로 이 축을 막고 있었다는 증거)",
    );
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    const afterGuardSrc = readFileSync(GUARD_PATH, "utf8");
    const afterRunnerSrc = readFileSync(RUNNER_PATH, "utf8");
    assert.equal(
      afterGuardSrc,
      originalGuardSrc,
      "원본 hyk400-receiver-guard.mjs 바이트가 변형된 채로 남았다",
    );
    assert.equal(
      afterRunnerSrc,
      originalRunnerSrc,
      "원본 hyk400-receiver-probe-runner.mjs 바이트가 변형된 채로 남았다",
    );
  }
});

// ============================================================
// I1 -- 격리: 대상 코드는 이 프로세스 안에서 절대 실행되지 않는다
// ============================================================

test("ⓐ 최상위에서 파일을 쓰는 수신부: 거부되고 실제로 파일이 안 생긴다", async () => {
  const worktree = tmpWorktree("hyk400-hostile-write-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-hostile-write.mjs.txt");
    const proofPath = join(worktree, "hyk400-hostile-write-proof.txt");
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_IMPORT_FAILED/);
    assert.throws(
      () => readFileSync(proofPath, "utf8"),
      "적대 표본이 실제로 파일을 만들었다 -- 격리 실패",
    );
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ⓐ 되돌림: --permission 격리를 끄면 같은 대상이 실제로 파일을 쓴다(RED)", async () => {
  const originalGuardSrc = readFileSync(GUARD_PATH, "utf8");
  const originalRunnerSrc = readFileSync(RUNNER_PATH, "utf8");

  const anchor =
    "            permissionFlag,\n" +
    "            `--allow-fs-read=${RUNNER_DIR}`,\n" +
    "            `--allow-fs-read=${worktreeReal}`,\n" +
    "            `--allow-fs-write=${responseDir}`,\n";
  assert.ok(
    originalGuardSrc.includes(anchor),
    "mutation anchor not found -- guard source drifted",
  );
  // 세 인자 전부 지운다(개별 삭제 불가 -- node는 --permission 없이
  // --allow-fs-read/--allow-fs-write만 있으면 ERR_MISSING_OPTION으로
  // 자식 자체가 뜨지도 못해, "격리가 꺼진 상태"가 아니라 "다른 이유로
  // 크래시"가 되어 이 시험의 목적(I1이 실제로 이 표본을 막고 있었다는
  // 증거)을 가린다). 셋 다 없으면 프로세스 권한 제약이 전혀 없는
  // 평범한 자식이 되어 대상의 최상위 쓰기가 실제로 일어난다.
  const mutatedSrc = originalGuardSrc.replace(
    anchor,
    "            // I1 mutated off (no --permission/--allow-fs-*)\n",
  );
  assert.notEqual(mutatedSrc, originalGuardSrc);

  const mutDir = tmpWorktree("hyk400-i1-mutant-");
  const worktree = tmpWorktree("hyk400-i1-write-worktree-");
  try {
    writeFileSync(join(mutDir, "hyk400-receiver-guard.mjs"), mutatedSrc);
    writeFileSync(
      join(mutDir, "hyk400-receiver-probe-runner.mjs"),
      originalRunnerSrc,
    );
    seedPolicySibling(mutDir);
    seedReceiptCli(worktree, "hyk400-hostile-write.mjs.txt");
    const proofPath = join(worktree, "hyk400-hostile-write-proof.txt");

    const mutatedGuard = await import(
      pathToFileURL(join(mutDir, "hyk400-receiver-guard.mjs")).href
    );
    await mutatedGuard.checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });

    assert.doesNotThrow(
      () => readFileSync(proofPath, "utf8"),
      "I1(--permission) 변이 후에는 적대 파일이 실제로 써진다(RED, 격리가 실제로 이 축을 막고 있었다는 증거)",
    );
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    const afterGuardSrc = readFileSync(GUARD_PATH, "utf8");
    const afterRunnerSrc = readFileSync(RUNNER_PATH, "utf8");
    assert.equal(afterGuardSrc, originalGuardSrc);
    assert.equal(afterRunnerSrc, originalRunnerSrc);
  }
});

// HYK-430 2R(검토 반려 P1-2 §2⑵ⓐ 전수 열거 대상) -- 이 시험의
// `elapsedMs < 5000`도 relay-handshake-retire-author-shadow-wire.test.mjs
// (E)와 «같은 형태»(재시도로 늘어난 실측 시간 vs 독립적으로 고른 절대
// 값)였다. 아직 실측으로 깨지지는 않았지만(800ms×2회=1600ms 나름의
// 여유), REVIEW가 재현한 2572ms/400ms(6.4배) 비율을 그대로 적용하면
// 1600ms×6.4≈10240ms로 5000ms를 넘을 수 있어 ★같은 종류의 잠재
// 결함이다 -- 지금 고친다. 결정적 호출-횟수 스파이(부하 무관)를
// 주 증거로 삼고, 벽시계 상한은 "무한정 대기하지 않는다"는 느슨한
// 안전망으로만 남긴다(REVIEW 실측 배율 6.4배에 5배 이상 여유를 얹은
// 배율로 timeoutMs*시도횟수에서 파생 -- 독립 절대값이 아니다).
const WORST_CASE_OVERHEAD_MULTIPLIER = 40; // REVIEW 실측 6.4배 + 넉넉한 여유.

test("ⓑ 무한 top-level await(이벤트 루프를 살려 둔 채): 제한시간 안에 거부된다, 재시도 정확히 1회(호출 횟수로 결정적 증명)", async () => {
  const worktree = tmpWorktree("hyk400-hostile-hang-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-hostile-hang.mjs.txt");
    const timeoutMs = 800;
    let spawnCalls = 0;
    const startedAt = Date.now();
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
      timeoutMs,
      // detectPermissionFlag도 같은 execFileSyncFn을 통해 플래그
      // 탐지용 프로브(`-e "process.exit(0)"`)를 한 번 스폰한다 --
      // 그건 이 시험이 재는 "무응답 자식에 대한 재시도"가 아니므로
      // 스파이에서 제외한다(그 프로브 인자는 언제나 -e를 포함한다).
      execFileSyncFn: (...args) => {
        const cliArgs = args[1] ?? [];
        if (!cliArgs.includes("-e")) spawnCalls += 1;
        return execFileSync(...args);
      },
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_PROBE_TIMEOUT/);
    assert.equal(
      spawnCalls,
      2,
      `무응답 자식은 재시도 1회를 포함해 정확히 2번 스폰돼야 한다 -- 실측: ${spawnCalls}`,
    );
    const looseCeilingMs = timeoutMs * 2 * WORST_CASE_OVERHEAD_MULTIPLIER;
    assert.ok(
      elapsedMs < looseCeilingMs,
      `2회 시도(각 ${timeoutMs}ms) 대비 ${WORST_CASE_OVERHEAD_MULTIPLIER}배 여유(${looseCeilingMs}ms)를 넘으면 타임아웃 메커니즘 자체가 소실된 회귀로 본다 -- 실측: ${elapsedMs}ms`,
    );
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// HYK-430 1R §2⑷ 음성 대조(새로 추가) -- spawnIsolatedChild가 이제
// withTimeoutRetry로 무응답을 1회 재시도한다(child-probe-timeout-
// policy.mjs). "재시도가 탐지력을 깎지 않는다"를 이 시험이 직접 잰다:
// 진짜로 영원히 응답하지 않는 자식은 재시도해도 여전히 거부돼야 하고,
// 재시도가 실제로 «두 번째 자식 프로세스를 다시 스폰»했다는 것도
// 경과시간으로 증명한다(1회 시도만 했다면 elapsedMs가 timeoutMs 근처에
// 머물렀을 것 -- 2회 시도했으므로 timeoutMs의 배 이상 걸려야 한다).
test("★음성 대조: 재시도(1회) 뒤에도 진짜 무응답 자식은 여전히 거부된다 -- 탐지력이 재시도로 사라지지 않는다(호출 횟수로 결정적 증명)", async () => {
  const worktree = tmpWorktree("hyk400-hostile-hang-retry-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-hostile-hang.mjs.txt");
    const timeoutMs = 500;
    let spawnCalls = 0;
    const startedAt = Date.now();
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
      timeoutMs,
      // detectPermissionFlag도 같은 execFileSyncFn을 통해 플래그
      // 탐지용 프로브(`-e "process.exit(0)"`)를 한 번 스폰한다 --
      // 그건 이 시험이 재는 "무응답 자식에 대한 재시도"가 아니므로
      // 스파이에서 제외한다(그 프로브 인자는 언제나 -e를 포함한다).
      execFileSyncFn: (...args) => {
        const cliArgs = args[1] ?? [];
        if (!cliArgs.includes("-e")) spawnCalls += 1;
        return execFileSync(...args);
      },
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(
      result.supported,
      false,
      "재시도 예산을 다 써도 결론은 여전히 미지원(거부)이어야 한다 -- 탐지력 보존",
    );
    assert.match(result.reason, /RECEIVER_CLI_PROBE_TIMEOUT/);
    // 결정적 증명(부하 무관) -- 벽시계보다 우선한다.
    assert.equal(
      spawnCalls,
      2,
      `재시도 1회를 포함해 정확히 2번 스폰돼야 한다 -- 실측: ${spawnCalls}`,
    );
    // HYK-430 4R §2⑶(P2-1 판정, REVIEW 2R) -- ★남기기로 결정한다.
    // 근거: 이건 «하한»이지 P1-2가 깨졌던 «상한»이 아니다 -- 부하가
    // 늘면 elapsedMs는 더 커질 뿐이라 이 부등식은 부하가 늘수록 «더
    // 쉽게» 참이 된다(P1-2와 정반대 방향). 유일하게 이 부등식이
    // 실패할 수 있는 경우는 "재시도가 실제로 두 번째 스폰을 하지
    // 않았다"(스파이가 이미 spawnCalls===2로 결정적으로 배제) 또는
    // "OS의 execFileSync timeout이 요청한 시간보다 실제로 짧게
    // 끊었다"(타이머 하한 보장이 깨진 것 -- 이건 이 시험이 잡아야
    // 하는 진짜 회귀다)뿐이다. 상한은 걸지 않는다 -- 위 ⓑ 시험이
    // 그 축을 이미 담당한다. 즉 이 하한은 spawnCalls의 «보조»이지
    // «대체 불가한 주 증거»가 아니며, 제거해도 탐지력이 줄지는
    // 않지만 남겨도 부하에 취약해지지 않으므로(방향이 반대) 굳이
    // 지울 이유가 없다고 판단했다.
    assert.ok(
      elapsedMs >= timeoutMs * 1.5,
      `1회 재시도가 실제로 자식을 다시 스폰했다면 경과시간이 timeoutMs(${timeoutMs}ms)의 1.5배 이상이어야 한다(1회 시도만 했다면 이 시험이 실패해야 한다) -- 실측: ${elapsedMs}ms`,
    );
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

async function assertAbnormalExitRejected(fixtureName, label) {
  const worktree = tmpWorktree(`hyk400-${label}-worktree-`);
  try {
    seedReceiptCli(worktree, fixtureName);
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(
      result.ok,
      false,
      `${label}: 비정상 child는 ok:false여야 한다`,
    );
    assert.equal(
      result.supported,
      false,
      `${label}: 비정상 child가 supported:true가 되면 안 된다`,
    );
    assert.match(result.reason, /RECEIVER_CLI_PROBE_CRASHED/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
}

test("ⓐ I1′: 정상 JSON 출력 후 SIGTERM 자살은 stdout과 무관하게 거부된다", async () => {
  await assertAbnormalExitRejected(
    "hyk400-hostile-output-sigterm.mjs.txt",
    "output-sigterm",
  );
});

test("ⓑ I1′: 정상 JSON 출력 후 process.exitCode=1은 stdout과 무관하게 거부된다", async () => {
  await assertAbnormalExitRejected(
    "hyk400-hostile-output-exitcode.mjs.txt",
    "output-exitcode",
  );
});

test("ⓒ I1′: 정상 JSON 출력 후 process.exit(3)은 stdout과 무관하게 거부된다", async () => {
  await assertAbnormalExitRejected(
    "hyk400-hostile-output-exit3.mjs.txt",
    "output-exit3",
  );
});

test("I1′ 되돌림: 종료 상태 검사를 끄면 ⓐⓑⓒ가 다시 통과하고 원본 바이트는 복원된다(RED)", async () => {
  const originalGuardSrc = readFileSync(GUARD_PATH, "utf8");
  const originalRunnerSrc = readFileSync(RUNNER_PATH, "utf8");
  const crashRejectStart = originalGuardSrc.indexOf(
    "    return rejected(\n      `RECEIVER_CLI_PROBE_CRASHED:",
  );
  assert.notEqual(
    crashRejectStart,
    -1,
    "I1′ mutation anchor not found -- guard source drifted",
  );
  const crashRejectEndMarker = "\n    );";
  const crashRejectEnd = originalGuardSrc.indexOf(
    crashRejectEndMarker,
    crashRejectStart,
  );
  assert.ok(
    crashRejectEnd > crashRejectStart,
    "I1′ mutation anchor not found -- guard source drifted",
  );
  const crashRejectAnchor = originalGuardSrc.slice(
    crashRejectStart,
    crashRejectEnd + crashRejectEndMarker.length,
  );
  // 4R(I-ROOT)에서는 판정의 신뢰 채널이 stdout에서 부모 소유 응답
  // 파일로 옮겨갔다 -- 이 표본들(SIGTERM/exitCode=1/exit(3))은 죽기
  // «전»에 정상적으로 그 응답 파일을 쓴다(러너의 동기 코드가 자식의
  // setImmediate 킬보다 먼저 끝난다). 그래서 3R 스타일 "stdout이
  // 그럴듯하면 믿는다" 되돌림은 이제 성립하지 않는다(stdout이 신뢰
  // 채널이 아니므로) -- 대신 이 변이는 "비정상 종료를 아예 무시하고
  // 응답 파일을 읽으러 간다"로 되돌린다. 이게 새 아키텍처에서 I1′의
  // 정확한 대응 축이다: 파일이 있든 없든, 응답이 유효하든 아니든, 종료
  // 상태가 깨끗하지 않으면 그 자체로 거부해야 한다는 불변식을 끈다.
  const mutatedSrc = originalGuardSrc.replace(
    crashRejectAnchor,
    "    return { ok: true }; // I1′ mutated off (crash ignored)",
  );
  assert.notEqual(mutatedSrc, originalGuardSrc);

  const mutDir = tmpWorktree("hyk400-i1-status-mutant-");
  const specimens = [
    ["hyk400-hostile-output-sigterm.mjs.txt", "SIGTERM"],
    ["hyk400-hostile-output-exitcode.mjs.txt", "exitCode=1"],
    ["hyk400-hostile-output-exit3.mjs.txt", "exit(3)"],
  ];
  try {
    writeFileSync(join(mutDir, "hyk400-receiver-guard.mjs"), mutatedSrc);
    writeFileSync(
      join(mutDir, "hyk400-receiver-probe-runner.mjs"),
      originalRunnerSrc,
    );
    seedPolicySibling(mutDir);
    const mutatedGuard = await import(
      pathToFileURL(join(mutDir, "hyk400-receiver-guard.mjs")).href
    );
    for (const [fixtureName, label] of specimens) {
      const worktree = tmpWorktree(`hyk400-i1-status-${label}-`);
      try {
        seedReceiptCli(worktree, fixtureName);
        const result = await mutatedGuard.checkReceiptCliFlagSupport({
          worktree,
          deliveryArgs: deliveryArgsFor(worktree),
        });
        assert.equal(
          result.supported,
          true,
          `${label}: 종료 상태 검사를 끄면 죽기 전에 쓰인 유효 응답 파일 때문에 다시 통과해야 RED다`,
        );
      } finally {
        rmSync(worktree, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
    assert.equal(
      readFileSync(GUARD_PATH, "utf8"),
      originalGuardSrc,
      "원본 guard 바이트가 변형된 채로 남았다",
    );
    assert.equal(
      readFileSync(RUNNER_PATH, "utf8"),
      originalRunnerSrc,
      "원본 runner 바이트가 변형된 채로 남았다",
    );
  }
});

// ============================================================
// I-ROOT(4R) -- 부모는 대상이 오염시킬 수 있는 어떤 바이트도(stdout)
// 신뢰하지 않는다. 아래 네 표본은 전부 실제 --harness-dir 계약을
// 정상적으로/비정상적으로 처리하되, stdout에 각기 다른 방식으로 소음을
// 낸다 -- 판정은 부모가 만든 응답 파일만 보므로 그 소음과 무관해야
// 한다.
// ============================================================

test("ⓐ I-ROOT: stdout에 유효 JSON 두 줄을 내도(3R을 뚫었던 모양) 실제 미지원(값을 버림)이 정확히 판정된다", async () => {
  const worktree = tmpWorktree("hyk400-stdout-multiline-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-hostile-stdout-multiline-json.mjs.txt");
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.ok, true, "판정 자체는 성공(결론 = 미지원)");
    assert.equal(
      result.supported,
      false,
      "stdout의 여러 줄 JSON이 진짜(파일 기반) 판정을 흔들면 안 된다 -- 실제로는 값을 버리므로 미지원이어야 한다",
    );
    assert.match(result.reason, /RECEIVER_CLI_SEMANTIC_MISMATCH/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ⓑ I-ROOT: stdout에 유효 JSON 뒤 쓰레기를 붙여도 실제 미지원(값을 버림)이 정확히 판정된다", async () => {
  const worktree = tmpWorktree("hyk400-stdout-trailing-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-hostile-stdout-trailing-garbage.mjs.txt");
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.ok, true, "판정 자체는 성공(결론 = 미지원)");
    assert.equal(
      result.supported,
      false,
      "stdout의 뒤쪽 쓰레기가 진짜(파일 기반) 판정을 흔들면 안 된다 -- 실제로는 값을 버리므로 미지원이어야 한다",
    );
    assert.match(result.reason, /RECEIVER_CLI_SEMANTIC_MISMATCH/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ⓒ I-ROOT: stdout에 유효 JSON 앞에 쓰레기를 붙여도 실제 미지원(값을 버림)이 정확히 판정된다", async () => {
  const worktree = tmpWorktree("hyk400-stdout-leading-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-hostile-stdout-leading-garbage.mjs.txt");
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.ok, true, "판정 자체는 성공(결론 = 미지원)");
    assert.equal(
      result.supported,
      false,
      "stdout의 앞쪽 쓰레기가 진짜(파일 기반) 판정을 흔들면 안 된다 -- 실제로는 값을 버리므로 미지원이어야 한다",
    );
    assert.match(result.reason, /RECEIVER_CLI_SEMANTIC_MISMATCH/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ⓓ I-ROOT: 대상이 러너를 흉내내 stdout에 완벽한 가짜 'supported:true'를 뿜어도, 진짜 결과(미지원)가 그대로 나온다", async () => {
  const worktree = tmpWorktree("hyk400-stdout-forged-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-hostile-stdout-forged-response.mjs.txt");
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(
      result.ok,
      true,
      "판정 자체는 성공(결론 = 미지원) -- 위조된 stdout이 크래시를 유발하지 않는다",
    );
    assert.equal(
      result.supported,
      false,
      "대상이 stdout에 뭘 뿜든, 실제로 --harness-dir 값을 버리는 대상은 미지원으로 판정돼야 한다(위조 무시 확인)",
    );
    assert.match(result.reason, /RECEIVER_CLI_SEMANTIC_MISMATCH/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// I-ROOT 되돌림 시험 전용 -- 채널을 응답 파일에서 옛 "stdout 마지막
// 줄만 본다"(3R 이전) 로직으로 되돌린다. 두 관문을 순서대로 무력화한다:
// (1) spawnIsolatedChild가 execFileSyncFn의 stdout 반환값을 다시 붙잡게
// 만들고, (2) runIsolatedProbe가 readIsolatedResponse(파일) 대신 그
// stdout의 마지막 줄만 파싱하게 만든다.
function buildIRootLegacyMutation(originalGuardSrc) {
  const spawnReturnAnchor =
    "    withTimeoutRetry(\n      () =>\n        execFileSyncFn(\n          process.execPath,";
  assert.ok(
    originalGuardSrc.includes(spawnReturnAnchor),
    "I-ROOT mutation anchor(spawn) not found -- guard source drifted",
  );
  let mutatedSrc = originalGuardSrc.replace(
    spawnReturnAnchor,
    "    const capturedStdout = withTimeoutRetry(\n      () =>\n        execFileSyncFn(\n          process.execPath,",
  );

  const spawnOkAnchor = "    return { ok: true };\n  } catch (err) {";
  assert.ok(
    mutatedSrc.includes(spawnOkAnchor),
    "I-ROOT mutation anchor(spawn-ok) not found -- guard source drifted",
  );
  mutatedSrc = mutatedSrc.replace(
    spawnOkAnchor,
    "    return { ok: true, stdout: capturedStdout }; // I-ROOT mutated: capture stdout\n  } catch (err) {",
  );

  const dispatchAnchor =
    "    if (!spawned.ok) return spawned;\n    return readIsolatedResponse(responsePath);";
  assert.ok(
    mutatedSrc.includes(dispatchAnchor),
    "I-ROOT mutation anchor(dispatch) not found -- guard source drifted",
  );
  mutatedSrc = mutatedSrc.replace(
    dispatchAnchor,
    [
      "    if (!spawned.ok) return spawned;",
      "    // I-ROOT mutated off: 파일이 아니라 stdout 마지막 줄을 신뢰(3R 이전 모양)",
      '    const lastLine = (spawned.stdout ?? "").trim().split("\\n").pop();',
      "    let legacyParsed;",
      "    try {",
      "      legacyParsed = JSON.parse(lastLine);",
      "    } catch (err) {",
      "      return rejected(`RECEIVER_CLI_PROBE_MALFORMED: ${err.message}`);",
      "    }",
      '    if (!legacyParsed || typeof legacyParsed !== "object" || legacyParsed.ok !== true) {',
      '      return rejected(legacyParsed?.reason ?? "RECEIVER_CLI_PROBE_MALFORMED: legacy");',
      "    }",
      "    return { ok: true, baseline: legacyParsed.baseline, withFlag: legacyParsed.withFlag };",
    ].join("\n"),
  );

  assert.notEqual(mutatedSrc, originalGuardSrc);
  return mutatedSrc;
}

test("I-ROOT 되돌림: 채널을 응답 파일에서 다시 stdout으로 되돌리면 ⓐ~ⓓ 전부 진짜와 다른(잘못된) 결과로 새 버리고, 원본 바이트는 복원된다(RED)", async () => {
  const originalGuardSrc = readFileSync(GUARD_PATH, "utf8");
  const originalRunnerSrc = readFileSync(RUNNER_PATH, "utf8");
  const mutatedSrc = buildIRootLegacyMutation(originalGuardSrc);

  const mutDir = tmpWorktree("hyk400-iroot-mutant-");
  // 실제 관측(2026-08-30 실측, 이 라운드가 직접 mutant를 빌드해 확인) --
  // 진짜(4R) 답은 넷 다 supported:false(SEMANTIC_MISMATCH)인데, stdout
  // 채널로 되돌리면 넷 다 «다른» 결과가 나온다: ⓐⓑⓒ는 stdout 소음이
  // legacy 파서를 아예 망가뜨려 "판정 불가"(ok:false, CONTRACT_MISMATCH/
  // MALFORMED)로 새고, ⓓ는 완벽하게 위조된 stdout을 그대로 믿어
  // supported:true(진짜 보안 우회)로 새 버린다. 넷 다 진짜 채널이 내는
  // "ok:true, supported:false, SEMANTIC_MISMATCH" 삼중주를 재현하지
  // 못한다는 게 RED의 증거다.
  const specimens = [
    ["hyk400-hostile-stdout-multiline-json.mjs.txt", "multiline"],
    ["hyk400-hostile-stdout-trailing-garbage.mjs.txt", "trailing"],
    ["hyk400-hostile-stdout-leading-garbage.mjs.txt", "leading"],
    ["hyk400-hostile-stdout-forged-response.mjs.txt", "forged"],
  ];
  try {
    writeFileSync(join(mutDir, "hyk400-receiver-guard.mjs"), mutatedSrc);
    writeFileSync(
      join(mutDir, "hyk400-receiver-probe-runner.mjs"),
      originalRunnerSrc,
    );
    seedPolicySibling(mutDir);
    const mutatedGuard = await import(
      pathToFileURL(join(mutDir, "hyk400-receiver-guard.mjs")).href
    );
    for (const [fixtureName, label] of specimens) {
      const worktree = tmpWorktree(`hyk400-iroot-${label}-`);
      try {
        seedReceiptCli(worktree, fixtureName);
        const result = await mutatedGuard.checkReceiptCliFlagSupport({
          worktree,
          deliveryArgs: deliveryArgsFor(worktree),
        });
        const matchesCorrectTriple =
          result.ok === true &&
          result.supported === false &&
          typeof result.reason === "string" &&
          result.reason.includes("RECEIVER_CLI_SEMANTIC_MISMATCH");
        assert.equal(
          matchesCorrectTriple,
          false,
          `${label}: stdout 채널로 되돌리면 진짜 채널의 (ok:true, supported:false, SEMANTIC_MISMATCH) 답을 못 내야 RED다 -- 실제로는 ${JSON.stringify(result)}`,
        );
      } finally {
        rmSync(worktree, { recursive: true, force: true });
      }
    }
    // ⓓ는 가장 심각한 갈래(진짜 보안 우회)라 별도로 강하게 못박는다 --
    // 실측 그대로: 위조가 완벽히 통해 supported:true로 승인된다.
    const forgedWorktree = tmpWorktree("hyk400-iroot-forged-strict-");
    try {
      seedReceiptCli(
        forgedWorktree,
        "hyk400-hostile-stdout-forged-response.mjs.txt",
      );
      const forgedResult = await mutatedGuard.checkReceiptCliFlagSupport({
        worktree: forgedWorktree,
        deliveryArgs: deliveryArgsFor(forgedWorktree),
      });
      assert.equal(
        forgedResult.supported,
        true,
        "stdout 채널로 되돌리면 ⓓ의 위조가 그대로 통과해 supported:true(진짜 보안 우회)가 돼야 RED다",
      );
    } finally {
      rmSync(forgedWorktree, { recursive: true, force: true });
    }
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
    assert.equal(
      readFileSync(GUARD_PATH, "utf8"),
      originalGuardSrc,
      "원본 guard 바이트가 변형된 채로 남았다",
    );
    assert.equal(
      readFileSync(RUNNER_PATH, "utf8"),
      originalRunnerSrc,
      "원본 runner 바이트가 변형된 채로 남았다",
    );
  }
});

test("ⓑ 되돌림: 격리 프로세스 실패(타임아웃 포함)를 거부가 아니라 '건너뛰기'로 바꾸면(제한시간 자체는 여전히 작동) RED가 된다", async () => {
  const originalGuardSrc = readFileSync(GUARD_PATH, "utf8");
  const originalRunnerSrc = readFileSync(RUNNER_PATH, "utf8");

  // runIsolatedProbe 자신의 타임아웃 감지(SIGKILL/ETIMEDOUT)는 그대로 두고
  // (제한시간이 실제로 프로세스를 죽이는 능력은 이 변이가 끄지 않는다),
  // 그 실패를 최종 판정에 반영하는 «호출부»만 무력화한다 -- probe가 실패해도
  // continue로 넘어가 마지막에 supported:true로 떨어지게 만든다. 이렇게
  // 해야 "타임아웃이 실제로 걸렸다"와 "그 실패를 거부로 연결한다"를 각각
  // 별도로 확인할 수 있다(앞 시험이 전자, 이 시험이 후자).
  const anchor =
    "    if (!probe.ok) {\n      return { ...probe, checkedFlags: derived.flags, failedFlag: flag };\n    }";
  assert.ok(
    originalGuardSrc.includes(anchor),
    "mutation anchor not found -- guard source drifted",
  );
  const mutatedSrc = originalGuardSrc.replace(
    anchor,
    "    if (!probe.ok) {\n      continue; // I1 probe-failure handling mutated off\n    }",
  );
  assert.notEqual(mutatedSrc, originalGuardSrc);

  const mutDir = tmpWorktree("hyk400-i1-timeout-mutant-");
  const worktree = tmpWorktree("hyk400-i1-hang-worktree-");
  try {
    writeFileSync(join(mutDir, "hyk400-receiver-guard.mjs"), mutatedSrc);
    writeFileSync(
      join(mutDir, "hyk400-receiver-probe-runner.mjs"),
      originalRunnerSrc,
    );
    seedPolicySibling(mutDir);
    seedReceiptCli(worktree, "hyk400-hostile-hang.mjs.txt");

    const mutatedGuard = await import(
      pathToFileURL(join(mutDir, "hyk400-receiver-guard.mjs")).href
    );
    const result = await mutatedGuard.checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
      timeoutMs: 800,
    });
    assert.equal(
      result.supported,
      true,
      "I1 타임아웃 판정 변이 후에는 무한 대기 대상이 supported:true로 새 버린다(RED)",
    );
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    const afterGuardSrc = readFileSync(GUARD_PATH, "utf8");
    const afterRunnerSrc = readFileSync(RUNNER_PATH, "utf8");
    assert.equal(afterGuardSrc, originalGuardSrc);
    assert.equal(afterRunnerSrc, originalRunnerSrc);
  }
});

// ============================================================
// I2 -- 의미: 파싱 성공이 아니라 값이 실제로 반영됐는지 본다
// ============================================================

test("ⓒ 다른 의미로 처리하는 수신부(값을 고정 상수로 치환): 거부되고 사유가 SEMANTIC_MISMATCH다", async () => {
  const worktree = tmpWorktree("hyk400-different-meaning-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-hostile-different-meaning.mjs.txt");
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_SEMANTIC_MISMATCH/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ⓔ 문자열만 언급하고 실제로는 무시하는 수신부: 거부되고 사유가 SEMANTIC_MISMATCH다(정적 텍스트 검사였다면 오탐했을 표본)", async () => {
  const worktree = tmpWorktree("hyk400-string-mention-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-hostile-string-mention.mjs.txt");
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_SEMANTIC_MISMATCH/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ⓒ/ⓔ 되돌림: 의미 대조를 끄면(sentinel 확인 없이 ok:true만 보면) 두 표본 다 supported:true로 새 버린다(RED)", async () => {
  const originalGuardSrc = readFileSync(GUARD_PATH, "utf8");
  const originalRunnerSrc = readFileSync(RUNNER_PATH, "utf8");

  const anchor =
    "  if (!responseCarriesSentinel(baseline, withFlag, sentinel)) {\n    return {\n      ok: true,\n      supported: false,\n      reason: `RECEIVER_CLI_SEMANTIC_MISMATCH: '${flag}'가 파싱은 되지만(ok:true) 넘긴 값이 응답 어디에도 반영되지 않았다(다른 의미로 처리하거나 값을 버리는 것으로 의심)`,\n    };\n  }\n  return { ok: true, supported: true, reason: null };";
  assert.ok(
    originalGuardSrc.includes(anchor),
    "mutation anchor not found -- guard source drifted",
  );
  const mutatedSrc = originalGuardSrc.replace(
    anchor,
    "  return { ok: true, supported: true, reason: null }; // I2 mutated off",
  );
  assert.notEqual(mutatedSrc, originalGuardSrc);

  const mutDir = tmpWorktree("hyk400-i2-mutant-");
  const worktreeC = tmpWorktree("hyk400-i2-c-worktree-");
  const worktreeE = tmpWorktree("hyk400-i2-e-worktree-");
  try {
    writeFileSync(join(mutDir, "hyk400-receiver-guard.mjs"), mutatedSrc);
    writeFileSync(
      join(mutDir, "hyk400-receiver-probe-runner.mjs"),
      originalRunnerSrc,
    );
    seedPolicySibling(mutDir);
    seedReceiptCli(worktreeC, "hyk400-hostile-different-meaning.mjs.txt");
    seedReceiptCli(worktreeE, "hyk400-hostile-string-mention.mjs.txt");

    const mutatedGuard = await import(
      pathToFileURL(join(mutDir, "hyk400-receiver-guard.mjs")).href
    );
    const resultC = await mutatedGuard.checkReceiptCliFlagSupport({
      worktree: worktreeC,
      deliveryArgs: deliveryArgsFor(worktreeC),
    });
    const resultE = await mutatedGuard.checkReceiptCliFlagSupport({
      worktree: worktreeE,
      deliveryArgs: deliveryArgsFor(worktreeE),
    });
    assert.equal(resultC.supported, true, "ⓒ가 I2 변이 후 새 버려야 한다(RED)");
    assert.equal(resultE.supported, true, "ⓔ가 I2 변이 후 새 버려야 한다(RED)");
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
    rmSync(worktreeC, { recursive: true, force: true });
    rmSync(worktreeE, { recursive: true, force: true });
    const afterGuardSrc = readFileSync(GUARD_PATH, "utf8");
    const afterRunnerSrc = readFileSync(RUNNER_PATH, "utf8");
    assert.equal(afterGuardSrc, originalGuardSrc);
    assert.equal(afterRunnerSrc, originalRunnerSrc);
  }
});

// ============================================================
// ⓕ 확인 자체가 실패(구문 오류·export 부재·파일 부재) -- 거부
// ============================================================

test("ⓕ 수신부 CLI 파일 자체가 없으면 거부(RECEIVER_CLI_MISSING)", async () => {
  const worktree = tmpWorktree("hyk400-missing-worktree-");
  try {
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_MISSING/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ⓕ 구문 오류가 있는 수신부는 거부(RECEIVER_CLI_IMPORT_FAILED) -- 격리 프로세스 안에서 잡힌다", async () => {
  const worktree = tmpWorktree("hyk400-syntax-error-worktree-");
  try {
    const relayDir = join(worktree, "scripts/relay");
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(
      join(relayDir, "dispatch-receipt-cli.mjs"),
      "this is not valid javascript {{{",
      "utf8",
    );
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_IMPORT_FAILED/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ⓕ parseDispatchReceiptArgs export가 없는 수신부는 거부(RECEIVER_CLI_CONTRACT_MISSING)", async () => {
  const worktree = tmpWorktree("hyk400-nocontract-worktree-");
  try {
    const relayDir = join(worktree, "scripts/relay");
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(
      join(relayDir, "dispatch-receipt-cli.mjs"),
      "export const somethingElse = 1;\n",
      "utf8",
    );
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_CONTRACT_MISSING/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// ============================================================
// ⓖ 가드 CLI 자체 부재 -- I5 실측 코드(ps1 exit 10 도달 가능성)
// ============================================================

test("ⓖ/I5: Write-Error 뒤 exit N은 $ErrorActionPreference=Stop 아래서 도달 불가하다(1R 반려 사유 재현)", () => {
  const dir = tmpWorktree("hyk400-i5-deadcode-");
  try {
    const script = join(dir, "deadcode.ps1");
    writeFileSync(
      script,
      [
        '$ErrorActionPreference = "Stop"',
        'Write-Error "SOME ERROR"',
        "exit 10",
      ].join("\n"),
      "utf8",
    );
    let status;
    try {
      execFileSync("pwsh", ["-File", script], { stdio: "pipe" });
      status = 0;
    } catch (err) {
      status = err.status;
    }
    assert.equal(
      status,
      1,
      "Write-Error 뒤 exit 10은 도달 불가하다 -- 실제 관측 코드는 암묵 1이어야 한다(1R 반려 실측과 동일)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ⓖ/I5 복원: Write-Host로 바꾸면 exit 10이 실제로 도달한다(이번 패치가 쓰는 형태)", () => {
  const dir = tmpWorktree("hyk400-i5-fixed-");
  try {
    const script = join(dir, "fixed.ps1");
    writeFileSync(
      script,
      [
        '$ErrorActionPreference = "Stop"',
        'Write-Host "RECEIVER_GUARD_CLI_MISSING: synthetic" -ForegroundColor Red',
        "exit 10",
      ].join("\n"),
      "utf8",
    );
    let status;
    try {
      execFileSync("pwsh", ["-File", script], { stdio: "pipe" });
      status = 0;
    } catch (err) {
      status = err.status;
    }
    assert.equal(status, 10, "Write-Host 뒤 exit 10은 실제로 도달해야 한다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// 지원/미지원 -- 정본 수신부 vs HYK-396 이전 수신부(회귀 확인)
// ============================================================

test("지원: 이 저장소 자신의 dispatch-receipt-cli.mjs는 --harness-dir을 의미대로 지원한다", async () => {
  const result = await checkReceiptCliFlagSupport({
    worktree: REPO_ROOT,
    deliveryArgs: REAL_DELIVERY_ARGS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.supported, true);
  assert.deepEqual(result.checkedFlags, ["--harness-dir"]);
});

test("지원 CLI: 지원 워크트리 -> exit 0 + SUPPORTED", () => {
  const args = ["--worktree", REPO_ROOT];
  for (const tok of REAL_DELIVERY_ARGS) args.push("--delivery-arg", tok);
  const { status, stdout } = runCli(args);
  assert.equal(status, 0);
  assert.match(stdout, /^SUPPORTED/);
});

test("미지원: HYK-396 이전 dispatch-receipt-cli.mjs(커밋 8ac19a0)는 unrecognized flag로 거부된다", async () => {
  const worktree = tmpWorktree("hyk400-unsupported-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-dispatch-receipt-cli-pre-hyk396.mjs.txt");
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.ok, true, "판정 자체는 성공(결론 = 미지원)");
    assert.equal(result.supported, false);
    assert.match(result.reason, /unrecognized flag '--harness-dir'/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("미지원 CLI: worktree 인자가 없으면 usage + exit 1(부작용 없이 거부)", () => {
  const { status, stderr } = runCli([]);
  assert.notEqual(status, 0);
  assert.match(stderr, /usage:/);
});

// Q4류 되돌림 -- 가드 없이 미지원 CLI를 직접 부르면 오늘 실사고 그대로의
// 옛 오류로 깨진다(부작용 없음도 같은 시험이 확인).
test("가드 없이 미지원 CLI를 직접 부르면 오늘 실사고와 같은 문구로 깨진다(변이 = 가드를 아예 거치지 않음)", () => {
  const dir = tmpWorktree("hyk400-direct-call-");
  try {
    const cliPath = seedReceiptCli(
      dir,
      "hyk400-dispatch-receipt-cli-pre-hyk396.mjs.txt",
    );
    let status, stdout;
    try {
      stdout = execFileSync(
        "node",
        [
          cliPath,
          "--role",
          "CODER",
          "--task-label",
          "hyk400-q4-probe",
          "--receipt-path",
          join(dir, "receipt.jsonl"),
          "--harness-dir",
          join(dir, ".harness"),
        ],
        { input: "{}", encoding: "utf8" },
      );
      status = 0;
    } catch (err) {
      status = err.status;
      stdout = err.stdout ?? "";
    }
    assert.notEqual(status, 0);
    assert.equal(
      stdout.trim(),
      "FAILED reason=unrecognized flag '--harness-dir'",
    );
    assert.throws(() => readFileSync(join(dir, "receipt.jsonl"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// I-ENV(6R) -- 이 판정기는 CI가 실제로 쓰는 런타임(Node 20, --permission이
// 아니라 --experimental-permission만 아는)에서도 낡은 워크트리 거부·
// 지원 워크트리 통과·확인 실패 거부 세 축이 성립해야 한다. 이 시험을
// 돌리는 기계가 Node 20이든 26이든(둘 다로 직접 검증했다 -- §원인 확정
// 절 참조, 별도로 Node 20.20.2 바이너리를 내려받아 전체 스위트를
// 두 번째로 그 위에서도 실행했다) 이식 가능해야 한다. 그래서 이
// 스텁은 "--permission은 늘 모른다고 답한다"(CI 실측 그대로, 호스트가
// 실제로 그걸 알든 모르든 무조건 거부)로 고정하고, "--experimental-
// permission"만 이 호스트가 실제로 이해하는 형태로 번역(이미 그
// 이름이면 그대로, 아니면 --permission으로 바꿔) 진짜 execFileSync에
// 위임한다 -- 어느 호스트에서 돌든 "CI처럼 --permission을 모르는
// 런타임"이라는 시뮬레이션 자체는 항상 같은 뜻이 된다.
// ============================================================

function detectRealPermissionFlagOnThisHost() {
  for (const flag of PERMISSION_FLAG_CANDIDATES_FOR_TEST) {
    try {
      execFileSync(process.execPath, [flag, "-e", "process.exit(0)"], {
        stdio: "ignore",
      });
      return flag;
    } catch {
      // 다음 후보로.
    }
  }
  throw new Error(
    "이 호스트는 --permission도 --experimental-permission도 모른다 -- I-ENV 시험을 흉내낼 기준(진짜 플래그)이 없다",
  );
}

const PERMISSION_FLAG_CANDIDATES_FOR_TEST = Object.freeze([
  "--permission",
  "--experimental-permission",
]);

function makeCiLikeExecFileSyncFn() {
  const realWorkingFlag = detectRealPermissionFlagOnThisHost();
  return (cmd, args, opts) => {
    const [flag, ...rest] = args;
    if (flag === "--permission") {
      const err = new Error(
        "bad option: --permission (simulated Node 20-like runtime)",
      );
      err.status = 9;
      throw err;
    }
    if (flag === "--experimental-permission") {
      return execFileSync(cmd, [realWorkingFlag, ...rest], opts);
    }
    return execFileSync(cmd, args, opts);
  };
}

function makeNeitherFlagWorksExecFileSyncFn() {
  let calls = 0;
  const fn = (_cmd, args) => {
    calls += 1;
    const err = new Error(
      `bad option: ${args[0]} (simulated unsupported runtime)`,
    );
    err.status = 9;
    throw err;
  };
  fn.callCount = () => calls;
  return fn;
}

test("I-ENV: --permission이 죽고 --experimental-permission만 사는 런타임(CI 흉내)에서도 지원 워크트리는 통과한다", async () => {
  const execFileSyncFn = makeCiLikeExecFileSyncFn();
  const result = await checkReceiptCliFlagSupport({
    worktree: REPO_ROOT,
    deliveryArgs: REAL_DELIVERY_ARGS,
    execFileSyncFn,
  });
  assert.equal(result.ok, true);
  assert.equal(result.supported, true);
});

test("I-ENV: --permission이 죽고 --experimental-permission만 사는 런타임(CI 흉내)에서도 미지원(HYK-396 이전) 워크트리는 거부된다", async () => {
  const worktree = tmpWorktree("hyk400-ienv-unsupported-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-dispatch-receipt-cli-pre-hyk396.mjs.txt");
    const execFileSyncFn = makeCiLikeExecFileSyncFn();
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
      execFileSyncFn,
    });
    assert.equal(result.ok, true, "판정 자체는 성공(결론 = 미지원)");
    assert.equal(result.supported, false);
    assert.match(result.reason, /unrecognized flag '--harness-dir'/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("I-ENV: --permission이 죽고 --experimental-permission만 사는 런타임(CI 흉내)에서도 확인 자체 실패(파일 없음)는 거부된다", async () => {
  const worktree = tmpWorktree("hyk400-ienv-missing-worktree-");
  try {
    const execFileSyncFn = makeCiLikeExecFileSyncFn();
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
      execFileSyncFn,
    });
    assert.equal(result.ok, false);
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_MISSING/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("I-ENV: --permission도 --experimental-permission도 다 죽는 런타임은 fail-closed로 거부하고, 대상을 아예 실행하지 않는다", async () => {
  const worktree = tmpWorktree("hyk400-ienv-neither-worktree-");
  try {
    // 대상 CLI가 있어도(지원 워크트리) -- 런타임 자체가 격리를 세울 수
    // 없으면 대상을 아예 만지지 않는다는 것을 보이려고 REPO_ROOT를 쓴다.
    const execFileSyncFn = makeNeitherFlagWorksExecFileSyncFn();
    const result = await checkReceiptCliFlagSupport({
      worktree: REPO_ROOT,
      deliveryArgs: REAL_DELIVERY_ARGS,
      execFileSyncFn,
    });
    assert.equal(result.ok, false);
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_RUNTIME_UNSUPPORTED/);
    assert.match(
      result.reason,
      /v\d+\.\d+\.\d+/,
      "런타임 버전을 사유에 남겨야 한다",
    );
    // 두 후보(--permission, --experimental-permission) probe만 시도하고
    // 실제 격리 자식(러너 스폰)은 절대 시도하지 않는다 -- fail-closed는
    // "시도했지만 실패"가 아니라 "애초에 시도하지 않는다"여야 한다.
    assert.equal(
      execFileSyncFn.callCount(),
      2,
      `probe만 2회(두 후보) 있어야 하는데 ${execFileSyncFn.callCount()}회 호출됐다 -- 실제 스폰까지 시도한 것으로 보인다`,
    );
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("I-ENV 되돌림: 플래그 자동탐지를 끄고 --permission을 다시 하드코딩하면, CI 흉내 런타임에서 지원 워크트리도 크래시로 거부된다(RED, 바이트 동일 복원)", async () => {
  const originalGuardSrc = readFileSync(GUARD_PATH, "utf8");
  const originalRunnerSrc = readFileSync(RUNNER_PATH, "utf8");

  const anchor =
    "            permissionFlag,\n" +
    "            `--allow-fs-read=${RUNNER_DIR}`,\n" +
    "            `--allow-fs-read=${worktreeReal}`,\n" +
    "            `--allow-fs-write=${responseDir}`,\n";
  assert.ok(
    originalGuardSrc.includes(anchor),
    "I-ENV mutation anchor not found -- guard source drifted",
  );
  // I-ENV(6R) 이전(1R~5R) 그대로 -- 플래그를 probe하지 않고 "--permission"을
  // 하드코딩한다. RUNNER_DIR 읽기 권한도 함께 빠지지만(이 시험의 핵심은
  // 플래그 자체이므로), 이 변이 목적상 부차적이다.
  const mutatedSrc = originalGuardSrc.replace(
    anchor,
    '            "--permission",\n' +
      "            `--allow-fs-read=${worktreeReal}`,\n" +
      "            `--allow-fs-write=${responseDir}`,\n",
  );
  assert.notEqual(mutatedSrc, originalGuardSrc);

  const mutDir = tmpWorktree("hyk400-ienv-mutant-");
  try {
    writeFileSync(join(mutDir, "hyk400-receiver-guard.mjs"), mutatedSrc);
    writeFileSync(
      join(mutDir, "hyk400-receiver-probe-runner.mjs"),
      originalRunnerSrc,
    );
    seedPolicySibling(mutDir);
    const mutatedGuard = await import(
      pathToFileURL(join(mutDir, "hyk400-receiver-guard.mjs")).href
    );
    const execFileSyncFn = makeCiLikeExecFileSyncFn();
    const result = await mutatedGuard.checkReceiptCliFlagSupport({
      worktree: REPO_ROOT,
      deliveryArgs: REAL_DELIVERY_ARGS,
      execFileSyncFn,
    });
    assert.equal(
      result.supported,
      false,
      "플래그 자동탐지를 끄면 CI 흉내 런타임에서 진짜 지원 워크트리도 거부돼야 RED다(이게 오늘 CI가 실제로 겪은 17건 실패의 재현이다)",
    );
    assert.match(
      result.reason,
      /RECEIVER_CLI_PROBE_CRASHED/,
      `하드코딩된 --permission이 이 런타임에서 즉시 죽어야 하는데 실제 사유 = ${result.reason}`,
    );
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
    assert.equal(
      readFileSync(GUARD_PATH, "utf8"),
      originalGuardSrc,
      "원본 guard 바이트가 변형된 채로 남았다",
    );
    assert.equal(
      readFileSync(RUNNER_PATH, "utf8"),
      originalRunnerSrc,
      "원본 runner 바이트가 변형된 채로 남았다",
    );
  }
});
