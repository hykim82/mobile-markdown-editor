// HYK-319-argcheck-1 (coder-task.md §3) -- dispatch-arg-contract-core.mjs
// 순수 함수 시험. 실 관제실 파일을 건드리지 않는다(§0 비타협2) -- 이 파일
// 안의 모든 스크립트 원문은 이 파일 안에서 만든 합성 텍스트이거나(§2-4),
// 마지막 한 시험만 실 관제실 파일을 **읽기만** 한다(§2-5, seat-proof-
// wrapper-shape.test.mjs의 기존 관례와 동일하게 CI에서는 파일 부재로
// 건너뛴다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runContractCheck, REASON } from "./dispatch-arg-contract-core.mjs";
import { CLI_CONTRACTS } from "./dispatch-arg-contract-registry.mjs";

// ---------------------------------------------------------------------------
// 합성 배달기 원문 빌더 -- 관제실 dispatch-worker.ps1의 실측 다섯 호출
// 모양(직접 호출 3개 + 배열 리터럴 2개, 그중 하나는 함수 매개변수로
// 이름이 바뀌는 간접 결속)을 그대로 축소 재현한다. `omit`에 담긴 플래그
// 문자열은 해당 호출문에서 통째로 빠진다(값 토큰까지 같이 빠짐 -- 실제
// 배달기에서 "인자를 빠뜨리는" 실수와 같은 모양).
// ---------------------------------------------------------------------------
// omit 항목은 "<cliId>:<flag>" 꼴로 CLI별로 구분한다 -- --role처럼 여러
// CLI가 같은 플래그 이름을 쓰는 경우, 한 CLI에서 그 플래그를 빼는 시험이
// 다른 CLI의 같은 이름 플래그까지 같이 지워버리는 시험 자체의 버그를
// 막는다(실제로 이 버그로 (합성-2) 시험이 한 번 깨졌다 -- admission-cli의
// --role을 뺐더니 receipt-cli 줄의 --role까지 같이 사라졌었다).
function flagPair(cliId, flag, value, omit) {
  return omit.has(`${cliId}:${flag}`) ? "" : ` ${flag} ${value}`;
}

function buildSyntheticScript(omit = new Set()) {
  const G = "dispatch-gate-decision";
  const A = "admission-cli-admit";
  const R = "dispatch-receipt-cli";
  const S = "dispatch-worker-seat-proof-gate";
  const C = "dispatch-start-confirm-cli";
  return `
# 예시 설명 주석(아래 진짜 호출문을 그대로 인용) -- 이 줄은 판정 대상이
# 아니어야 한다: & node $gateScript --expect-repo-root $Worktree
$gateScript = Join-Path $Worktree "scripts/check/dispatch-gate-decision.mjs"
$roleTaskFile = Join-Path $Worktree ".harness/coder-task.md"
& node $gateScript ${omit.has(`${G}:<positional task-path>`) ? "" : "$roleTaskFile"}${flagPair(G, "--expect-repo-root", "$Worktree", omit)}${flagPair(G, "--dispatch-receipt-path", "$ReceiptPath", omit)}${flagPair(G, "--admission-ledger-path", "$admissionLedgerPath", omit)}

$admissionCliPath = Join-Path $Worktree "scripts/supervisor/admission-cli.mjs"
$admissionOut = & node $admissionCliPath ${omit.has(`${A}:<subcommand:admit>`) ? "" : "admit"}${flagPair(A, "--ledger", "$admissionLedgerPath", omit)}${flagPair(A, "--lock", "$admissionLockPath", omit)}${flagPair(A, "--reservation-id", "$label", omit)}${flagPair(A, "--cap-path", "$capPath", omit)}${flagPair(A, "--role", "$Role", omit)}${flagPair(A, "--seat-key", "$paneKey", omit)} 2>&1

$receiptCliPath = Join-Path $Worktree "scripts/relay/dispatch-receipt-cli.mjs"
function Record-DispatchReceipt([string]$cliPath, [string]$role, [string]$label, [string]$receiptPath) {
  $cliArgs = @($cliPath,${flagPair(R, "--role", "$role", omit)},${flagPair(R, "--task-label", "$label", omit)},${flagPair(R, "--receipt-path", "$receiptPath", omit)})
}

$gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"
$gateOut = & node $gateCliPath${flagPair(S, "--dispatch-show", "$dsShowPath", omit)}${flagPair(S, "--terminal-show", "$tsShowPath", omit)}${flagPair(S, "--harness-task-id", "$label", omit)}${flagPair(S, "--runtime-task-id", "$Task", omit)}${flagPair(S, "--dispatch-id", "$dispatchId", omit)}${flagPair(S, "--worktree-id", "$seatProofWorktreeId", omit)}${flagPair(S, "--worktree-path", "(Norm $Worktree)", omit)} 2>&1

$confirmCli = Join-Path $Worktree "scripts/supervisor/dispatch-start-confirm-cli.mjs"
$confirmArgs = @(
  $confirmCli,
  ${flagPair(C, "--repo-root", "$Worktree", omit)},
  ${flagPair(C, "--dispatched-at-ms", "$confirmDispatchedAtMs", omit)},
  ${flagPair(C, "--notify-dir", "$confirmNotifyDir", omit)}
)
`;
}

// 이 시험 파일이 선언과 계속 함께 가도록, 레지스트리의 모든 필수 플래그를
// 자동으로 순회한다(수동 목록을 따로 유지하지 않음 -- 선언이 늘면 시험도
// 자동으로 늘어난다).
function allRequiredFlagEntries() {
  const out = [];
  for (const cli of CLI_CONTRACTS) {
    for (const req of cli.requiredArgs)
      out.push({
        cliId: cli.id,
        flag: req.flags[0],
        missingLabel: req.flags.join("|"),
      });
    if (cli.requiresPositionalArg)
      out.push({
        cliId: cli.id,
        flag: "<positional task-path>",
        missingLabel: "<positional task-path>",
      });
    if (cli.requiresSubcommand)
      out.push({
        cliId: cli.id,
        flag: `<subcommand:${cli.requiresSubcommand}>`,
        missingLabel: `<subcommand:${cli.requiresSubcommand}>`,
      });
  }
  return out;
}

// ---------------------------------------------------------------------------
// (1) 완전판 -- 전부 통과 (표본 1건).
// ---------------------------------------------------------------------------
test("(합성-1) 완전판 배달기 원문 -- 5개 CLI 전부 PASS, 전체 ALL_OK", () => {
  const result = runContractCheck(buildSyntheticScript());
  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 5);
  for (const f of result.findings) {
    assert.equal(f.reasonCode, REASON.PASS, `${f.id}: ${f.detail}`);
  }
});

// ---------------------------------------------------------------------------
// (2) 인자 1개 누락 검출 -- 레지스트리의 모든 필수 항목(플래그·위치 인자·
// 서브커맨드)을 하나씩 빼가며 전수 검사(표본 N = allRequiredFlagEntries().length).
// ---------------------------------------------------------------------------
const REQUIRED_ENTRIES = allRequiredFlagEntries();
test(`(합성-2, 표본 ${REQUIRED_ENTRIES.length}건) 필수 항목을 하나씩 빼면 해당 CLI만 MISSING_ARGS로 검출된다`, () => {
  for (const { cliId, flag, missingLabel } of REQUIRED_ENTRIES) {
    const result = runContractCheck(
      buildSyntheticScript(new Set([`${cliId}:${flag}`])),
    );
    const finding = result.findings.find((f) => f.id === cliId);
    assert.ok(finding, `${cliId} finding missing entirely`);
    assert.equal(
      finding.reasonCode,
      REASON.MISSING_ARGS,
      `cli=${cliId} flag=${flag} got reasonCode=${finding.reasonCode} detail=${finding.detail}`,
    );
    assert.ok(
      finding.missing.includes(missingLabel),
      `cli=${cliId} flag=${flag} not listed in missing=[${finding.missing.join(",")}]`,
    );
    // 다른 4개 CLI는 그대로 PASS -- 한 인자 누락이 엉뚱한 CLI로 새지 않는다.
    for (const other of result.findings) {
      if (other.id === cliId) continue;
      assert.equal(
        other.reasonCode,
        REASON.PASS,
        `omitting ${cliId}'s ${flag} unexpectedly broke ${other.id}: ${other.detail}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// (3) fail-closed -- 호출 지점을 못 찾음(정의는 있는데 아무 데도 안 불림).
// ---------------------------------------------------------------------------
test("(fail-closed-1) 변수는 Join-Path로 정의됐지만 어느 창에서도 안 쓰임 -> CALL_SITE_NOT_FOUND(통과 아님)", () => {
  const text = `
$gateScript = Join-Path $Worktree "scripts/check/dispatch-gate-decision.mjs"
Write-Host "이 CLI는 이번 라운드에 그냥 안 부른다"
`;
  const result = runContractCheck(text, [CLI_CONTRACTS[0]]);
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].reasonCode, REASON.CALL_SITE_NOT_FOUND);
});

// ---------------------------------------------------------------------------
// (4) fail-closed -- Join-Path 대입 자체가 아예 없음.
// ---------------------------------------------------------------------------
test("(fail-closed-2) 스크립트 경로 대입 자체를 못 찾음 -> SCRIPT_PATH_ASSIGNMENT_NOT_FOUND(통과 아님)", () => {
  const text = `Write-Host "이 배달기 원문에는 dispatch-gate-decision.mjs 언급이 아예 없다"`;
  const result = runContractCheck(text, [CLI_CONTRACTS[0]]);
  assert.equal(result.ok, false);
  assert.equal(
    result.findings[0].reasonCode,
    REASON.SCRIPT_PATH_ASSIGNMENT_NOT_FOUND,
  );
});

// ---------------------------------------------------------------------------
// (5) fail-closed -- 같은 변수를 두 번 부름(어느 호출이 계약 대상인지 모호).
// ---------------------------------------------------------------------------
test("(fail-closed-3) 같은 변수를 부르는 호출 창이 2개 -> MULTIPLE_INVOCATIONS(통과 아님)", () => {
  const text = `
$gateScript = Join-Path $Worktree "scripts/check/dispatch-gate-decision.mjs"
& node $gateScript $roleTaskFile --expect-repo-root $Worktree --dispatch-receipt-path $ReceiptPath --admission-ledger-path $admissionLedgerPath
& node $gateScript $roleTaskFile --expect-repo-root $Worktree --dispatch-receipt-path $ReceiptPath --admission-ledger-path $admissionLedgerPath
`;
  const result = runContractCheck(text, [CLI_CONTRACTS[0]]);
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].reasonCode, REASON.MULTIPLE_INVOCATIONS);
});

// ---------------------------------------------------------------------------
// (6) fail-closed -- Join-Path 대입이 서로 다른 두 변수 이름으로 겹침.
// ---------------------------------------------------------------------------
test("(fail-closed-4) 같은 CLI 상대경로를 서로 다른 변수 2개에 대입 -> MULTIPLE_SCRIPT_PATH_BINDINGS(통과 아님)", () => {
  const text = `
$gateScriptA = Join-Path $Worktree "scripts/check/dispatch-gate-decision.mjs"
$gateScriptB = Join-Path $Worktree "scripts/check/dispatch-gate-decision.mjs"
& node $gateScriptA $roleTaskFile --expect-repo-root $Worktree --dispatch-receipt-path $ReceiptPath --admission-ledger-path $admissionLedgerPath
`;
  const result = runContractCheck(text, [CLI_CONTRACTS[0]]);
  assert.equal(result.ok, false);
  assert.equal(
    result.findings[0].reasonCode,
    REASON.MULTIPLE_SCRIPT_PATH_BINDINGS,
  );
});

// ---------------------------------------------------------------------------
// (7) 회귀 가드 -- 호출문을 "예로 든" 전체 줄 주석은 진짜 호출로 오인식
// 되지 않는다(관제실 실물 155행에서 실제로 걸렸던 버그, comment-stripping
// 수정 전에는 이 시험이 MULTIPLE_INVOCATIONS로 깨졌다).
// ---------------------------------------------------------------------------
test("(회귀) 호출문을 그대로 인용한 전체 줄 주석은 두 번째 호출로 오인식되지 않는다", () => {
  const text = `
# 게이트 호출(아래 & node $gateScript ...)에 --dispatch-receipt-path가 필요하다는 설명
$gateScript = Join-Path $Worktree "scripts/check/dispatch-gate-decision.mjs"
& node $gateScript $roleTaskFile --expect-repo-root $Worktree --dispatch-receipt-path $ReceiptPath --admission-ledger-path $admissionLedgerPath
`;
  const result = runContractCheck(text, [CLI_CONTRACTS[0]]);
  assert.equal(result.ok, true);
  assert.equal(result.findings[0].reasonCode, REASON.PASS);
});

// ---------------------------------------------------------------------------
// (8) anyOf -- --cap-path 대신 --cap만 있어도 admission-cli 항목은 통과.
// ---------------------------------------------------------------------------
test("(anyOf) admission-cli: --cap-path 없이 --cap만 있어도 그 항목은 만족된다", () => {
  const admissionCli = CLI_CONTRACTS.find(
    (c) => c.id === "admission-cli-admit",
  );
  const text = `
$admissionCliPath = Join-Path $Worktree "scripts/supervisor/admission-cli.mjs"
& node $admissionCliPath admit --ledger $l --lock $k --reservation-id $r --cap 5 --role $Role --seat-key $paneKey
`;
  const result = runContractCheck(text, [admissionCli]);
  assert.equal(
    result.findings[0].reasonCode,
    REASON.PASS,
    result.findings[0].detail,
  );
});

// ---------------------------------------------------------------------------
// (9) 위치 인자/서브커맨드 계약이 시험으로 고정됨(값이 아니라 존재만 본다는
// 계약의 일부 -- "$roleTaskFile" 값 자체가 실재하는 파일인지는 이 코어의
// 범위 밖).
// ---------------------------------------------------------------------------
test("(계약) 값의 옳음은 범위 밖 -- 존재하지 않는 파일을 가리키는 위치 인자도 «있다»로 통과", () => {
  const text = `
$gateScript = Join-Path $Worktree "scripts/check/dispatch-gate-decision.mjs"
& node $gateScript $ANY_TOKEN_EVEN_A_TYPO --expect-repo-root $Worktree --dispatch-receipt-path $ReceiptPath --admission-ledger-path $admissionLedgerPath
`;
  const result = runContractCheck(text, [CLI_CONTRACTS[0]]);
  assert.equal(result.findings[0].reasonCode, REASON.PASS);
});

test("(계약) admission-cli: subcommand가 'admit'이 아니면(오타 포함) MISSING_ARGS에 서브커맨드 항목이 뜬다", () => {
  const admissionCli = CLI_CONTRACTS.find(
    (c) => c.id === "admission-cli-admit",
  );
  const text = `
$admissionCliPath = Join-Path $Worktree "scripts/supervisor/admission-cli.mjs"
& node $admissionCliPath admitt --ledger $l --lock $k --reservation-id $r --cap-path $c --role $Role --seat-key $paneKey
`;
  const result = runContractCheck(text, [admissionCli]);
  assert.equal(result.findings[0].reasonCode, REASON.MISSING_ARGS);
  assert.ok(result.findings[0].missing.includes("<subcommand:admit>"));
});

// ---------------------------------------------------------------------------
// (10) §2-5 실물 대조 -- 실 관제실 파일을 **읽기만** 한다. CI에는 그 경로가
// 없으므로 건너뛴다(seat-proof-wrapper-shape.test.mjs와 동일한 관례).
// ---------------------------------------------------------------------------
const CONTROL_ROOM_SCRIPT_PATH =
  "D:\\문서관리\\하네스-관제실\\dispatch-worker.ps1";
test("(§2-5 실물 1회) 현재 관제실 dispatch-worker.ps1을 읽기로 대조한다", () => {
  if (!existsSync(CONTROL_ROOM_SCRIPT_PATH)) {
    console.log(
      `SKIP_REASON: control room path not present in this environment (expected on CI) -- ${CONTROL_ROOM_SCRIPT_PATH}`,
    );
    return;
  }
  const liveText = readFileSync(CONTROL_ROOM_SCRIPT_PATH, "utf8");
  const result = runContractCheck(liveText);
  // 결과 파일에 그대로 옮겨 적을 실측 -- 이 시험은 "지금 통과한다"를
  // 못박지 않는다(관제실이 바뀌면 이 시험도 그 변화를 그대로 보고해야
  // 하므로 assert.equal(result.ok, true)로 고정하지 않는다). 대신 판정이
  // 각 CLI마다 PASS 아니면 명확한 사유 하나로 떨어지는지만 구조적으로
  // 확인한다(코어가 예외 없이 5개 전부에 대해 답을 낸다는 계약).
  assert.equal(result.findings.length, 5);
  for (const f of result.findings) {
    assert.ok(Object.values(REASON).includes(f.reasonCode));
  }
  console.log(
    `REAL_CONTROL_ROOM_CHECK: ok=${result.ok} overallReasonCode=${result.overallReasonCode}\n` +
      result.findings
        .map(
          (f) =>
            `  ${f.id}: ${f.reasonCode}${f.missing.length ? " missing=" + f.missing.join(",") : ""}`,
        )
        .join("\n"),
  );
});
