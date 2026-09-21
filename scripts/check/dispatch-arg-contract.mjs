// HYK-319-argcheck-1 (coder-task.md) -- 얇은 CLI 진입점. 판정 로직은 전부
// dispatch-arg-contract-core.mjs(순수)에 있다. 이 파일이 하는 일은 딱
// 셋뿐: ⑴ --script 인자로 받은 배달기 원문을 **읽기만** 한다(§0 비타협2
// "관제실 쓰기 0" -- 이 파일에는 writeFileSync 등 쓰기 API가 전혀
// import되지 않는다) ⑵ 코어를 부른다 ⑶ 사람이 읽는 한 줄씩 출력하고
// 코어가 정한 exit code로 종료한다.
//
// ★위협 모형(coder-task.md §0 비타협7, 문면 그대로 유지): 막으려는 것은
// «사고» -- 사람이 배달기를 고치다 인자를 실수로 빠뜨리는 것 -- 뿐이다.
// ⛔고의 우회는 막지 못한다: 이 검사기는 배달기 «원문»을 정적으로 읽을
// 뿐 실행 문맥을 모른다(seat-proof-wrapper-shape.mjs의 정직 한계와 동일
// 계열 -- here-string이나 죽은 분기 안에 정본 호출문을 그대로 붙여넣으면
// 이 검사기는 여전히 "호출됨"으로 읽는다). 그리고 관제실을 고칠 수 있는
// 주체는 이 검사기 자체도 끌 수 있다(결선이 없으므로 지금은 아무도 이
// 검사기를 자동으로 부르지 않는다 -- §2-6 참고). 이 층에 "공격자 방어"를
// 기대하면 안 된다.
import { readFileSync } from "node:fs";
import { runContractCheck } from "./dispatch-arg-contract-core.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--script") out.script = argv[++i];
  }
  return out;
}

export function formatContractResult(result) {
  const lines = [];
  for (const f of result.findings) {
    if (f.reasonCode === "PASS") {
      lines.push(`PASS  ${f.id} -- ${f.detail}`);
    } else if (f.reasonCode === "MISSING_ARGS") {
      lines.push(
        `FAIL  ${f.id} MISSING_ARGS: ${f.missing.join(", ")} -- ${f.detail}`,
      );
    } else {
      lines.push(`FAIL  ${f.id} ${f.reasonCode} -- ${f.detail}`);
    }
  }
  lines.push(
    result.ok
      ? "dispatch-arg-contract: ALL_OK"
      : `dispatch-arg-contract: REJECT (overall reason=${result.overallReasonCode}, exit=${result.exitCode})`,
  );
  return lines.join("\n");
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/dispatch-arg-contract.mjs");
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.script) {
    console.error(
      "usage: node dispatch-arg-contract.mjs --script <path-to-dispatch-worker.ps1>",
    );
    process.exit(2);
  }
  let scriptText;
  try {
    scriptText = readFileSync(args.script, "utf8");
  } catch (err) {
    // fail-closed(§2-3): 읽을 수 없는 배달기 원문은 "통과"가 아니라 거부.
    console.error(
      `dispatch-arg-contract: failed to read --script file '${args.script}': ${err.message}`,
    );
    process.exit(9);
  }
  const result = runContractCheck(scriptText);
  console.log(formatContractResult(result));
  process.exit(result.exitCode);
}
