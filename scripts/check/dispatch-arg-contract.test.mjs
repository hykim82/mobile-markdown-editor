// HYK-319-argcheck-1 -- 얇은 CLI 진입점(dispatch-arg-contract.mjs) 시험.
// 판정 로직은 dispatch-arg-contract-core.test.mjs가 이미 덮는다 -- 여기서는
// CLI 껍데기 자체(인자 파싱·파일 읽기 실패·exit code 전달·읽기 전용)만 본다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(
  new URL("./dispatch-arg-contract.mjs", import.meta.url),
);

function runCli(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
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

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-arg-contract-cli-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("--script 없이 실행하면 usage 출력 + exit 2", () => {
  const r = runCli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test("--script가 가리키는 파일이 없으면 fail-closed exit 9(통과 아님)", () => {
  const r = runCli(["--script", "C:\\this-does-not-exist-argcheck.ps1"]);
  assert.equal(r.status, 9);
  assert.match(r.stderr, /failed to read/);
});

test("이 CLI는 --script 파일을 읽기만 한다 -- 실행 전후로 바이트가 그대로다(쓰기 0 확인)", () => {
  withFixtureDir((dir) => {
    const scriptPath = join(dir, "fake-dispatch-worker.ps1");
    const before = `Write-Host "no repo CLI calls here"`;
    writeFileSync(scriptPath, before, "utf8");
    runCli(["--script", scriptPath]);
    const after = readFileSync(scriptPath, "utf8");
    assert.equal(after, before);
  });
});

test("정상 판정 시 exit code가 코어의 exitCode와 그대로 일치한다(완전판 합성 스크립트 -> ALL_OK, exit 0)", () => {
  withFixtureDir((dir) => {
    const scriptPath = join(dir, "fake-dispatch-worker.ps1");
    writeFileSync(
      scriptPath,
      `
$gateScript = Join-Path $Worktree "scripts/check/dispatch-gate-decision.mjs"
$roleTaskFile = Join-Path $Worktree ".harness/coder-task.md"
& node $gateScript $roleTaskFile --expect-repo-root $Worktree --dispatch-receipt-path $ReceiptPath --admission-ledger-path $admissionLedgerPath

$admissionCliPath = Join-Path $Worktree "scripts/supervisor/admission-cli.mjs"
& node $admissionCliPath admit --ledger $l --lock $k --reservation-id $r --cap-path $c --role $Role --seat-key $paneKey

$receiptCliPath = Join-Path $Worktree "scripts/relay/dispatch-receipt-cli.mjs"
function Record-DispatchReceipt([string]$cliPath, [string]$role, [string]$label, [string]$receiptPath) {
  $cliArgs = @($cliPath, "--role", $role, "--task-label", $label, "--receipt-path", $receiptPath)
}

$gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"
& node $gateCliPath --dispatch-show $ds --terminal-show $ts --harness-task-id $h --runtime-task-id $rt --dispatch-id $di --worktree-id $wi --worktree-path $wp

$confirmCli = Join-Path $Worktree "scripts/supervisor/dispatch-start-confirm-cli.mjs"
$confirmArgs = @(
  $confirmCli,
  "--repo-root"; $Worktree,
  "--dispatched-at-ms"; $ms,
  "--notify-dir"; $nd
)
`,
      "utf8",
    );
    const r = runCli(["--script", scriptPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALL_OK/);
  });
});
