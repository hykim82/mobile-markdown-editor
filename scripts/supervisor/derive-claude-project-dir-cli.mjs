// HYK-378-derive-single-source-1 (coder-task.md §1) -- 워크트리 절대경로를
// 받아 Claude Code 세션 로그 디렉터리 이름 한 줄을 낸다. 관제실
// `dispatch-worker.ps1`(514행)이 이 계산을 **자기만의 복제**로 갖고
// 있었던 것이 HYK-280 거짓 NOT_STARTED 통지 사고의 원인이었다(0-1·0-3절).
// ⛔이 파일은 새 계산을 하지 않는다 -- 정본
// `deriveClaudeProjectDirName`(rate-limit-stall-adapter.mjs)을 그대로
// 부른다. 복제가 이 사고의 원인이므로, 여기서 또 다른 복제를 만들면
// 이 라운드 자체가 실패다.
//
// 출력 계약(좁게 고정):
// - 성공: stdout에 이름 한 줄(개행 1개), 종료코드 0.
// - 실패: stderr에 사람이 읽을 사유 한 줄, 종료코드 2(사용법 오류).
// - `--json`: stdout에 `{"worktree":"...","projectDirName":"..."}` 한 줄
//   (개행 포함) -- ORCH나 다른 자동화가 입력값도 함께 확인하고 싶을 때
//   쓰라고 추가했다(선택, 기본은 이름 한 줄 그대로 -- PowerShell이 그
//   출력을 그대로 변수에 담아 쓸 수 있어야 한다는 §1 요구 때문에 기본
//   경로는 JSON으로 감싸지 않는다).
//
// Node 20 호환 -- ESM 표준 API만 사용.

import { deriveClaudeProjectDirName } from "./rate-limit-stall-adapter.mjs";

// computeProjectDirName(...) -- 인자 검증 + 정본 함수 호출을 한 곳에
// 모은다(시험이 이 함수를 직접 불러 CLI 프로세스를 안 띄우고도 검증할
// 수 있게 분리 -- dispatch-start-confirm-cli.mjs의 `runDispatchStartConfirm`
// 분리와 같은 패턴).
export function computeProjectDirName(worktreeAbsPath) {
  if (typeof worktreeAbsPath !== "string" || worktreeAbsPath.length === 0) {
    return { ok: false, reasonCode: "WORKTREE_PATH_MISSING" };
  }
  return {
    ok: true,
    projectDirName: deriveClaudeProjectDirName(worktreeAbsPath),
  };
}

function printUsage() {
  console.error(
    "usage: node scripts/supervisor/derive-claude-project-dir-cli.mjs <worktree-abs-path> [--json]",
  );
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/derive-claude-project-dir-cli.mjs");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  let worktreePath = null;
  let jsonOutput = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") jsonOutput = true;
    else if (argv[i] === "--worktree" || argv[i] === "--repo-root") {
      worktreePath = argv[++i];
    } else if (worktreePath === null && !argv[i].startsWith("--")) {
      worktreePath = argv[i];
    }
  }
  const result = computeProjectDirName(worktreePath);
  if (!result.ok) {
    printUsage();
    console.error(
      `derive-claude-project-dir-cli: 사유 코드=${result.reasonCode}`,
    );
    process.exit(2);
  }
  if (jsonOutput) {
    process.stdout.write(
      JSON.stringify({
        worktree: worktreePath,
        projectDirName: result.projectDirName,
      }) + "\n",
    );
  } else {
    process.stdout.write(result.projectDirName + "\n");
  }
  process.exit(0);
}
