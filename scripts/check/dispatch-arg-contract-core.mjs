// HYK-319-argcheck-1 (coder-task.md) -- 순수 판정 코어. 파일시스템을 열지
// 않는다(입력은 전부 문자열 -- 배달기 스크립트 원문 하나). 하는 일은
// dispatch-arg-contract-registry.mjs가 선언한 저장소 CLI 5개 각각에 대해
// ⑴ 배달기 원문에서 그 CLI를 부르는 «호출 지점»을 찾고 ⑵ 그 호출문에
// 실제로 등장하는 인자 플래그 집합을 뽑아 ⑶ 선언된 필수 인자와 대조한다.
//
// ★계약(coder-task.md §2-3): 값이 아니라 «플래그 이름이 호출문에 있는가»만
// 본다. `--dispatch-receipt-path $ReceiptPath`에서 `$ReceiptPath`가 빈
// 문자열이든 존재하지 않는 변수든 이 모듈은 모른다 -- 그 옳음은 범위 밖.
//
// ★fail-closed(§2-3 비타협): 호출 지점을 못 찾거나(정의는 있는데 아무
// 창에서도 그 변수가 안 불림) 해석이 모호하면(같은 CLI가 둘 이상의 창에
// 걸리거나, 스크립트 경로 변수 자체가 둘 이상 정의됨) "통과"가 아니라
// 거부다 -- 아래 REASON 상수들이 그 각각을 서로 다른 코드로 구분한다.
//
// ★호출 지점 해석의 두 층(정직 한계, 반드시 결과 파일에 그대로 적을 것):
// 1층(직접 결속, 신뢰 높음) -- 배달기 원문에서 `$var = Join-Path ...
//    "<이 CLI의 상대경로>"`로 변수 하나를 그 CLI에 결속시키고, 그 변수가
//    실제로 `& node $var ...`(직접 호출) 또는 배열 리터럴의 첫 원소로
//    쓰이는 창을 찾는다. 이 경우 플래그 유무는 «그 CLI를 부른다고 이미
//    구조적으로 확정된 창»에서 뽑으므로, 필수 플래그가 전부 빠져 있어도
//    (즉 시그니처 점수가 0이어도) 정확히 그 창을 대상으로 판정한다 --
//    바로 이 경로가 HYK-256류 사고(있어야 할 플래그가 통째로 빠짐)를
//    잡는 경로다.
// 2층(간접 결속, 정직 한계) -- 그 변수가 다른 PowerShell 함수의 매개변수로
//    이름이 바뀌어 넘어간 뒤(예: dispatch-receipt-cli.mjs의 실물 호출은
//    `$receiptCliPath`를 함수 인자로 넘기고 그 함수 안에서는 `$cliPath`라는
//    별개 이름으로 배열을 조립한다) 호출되면, 1층 결속으로는 그 창을 못
//    찾는다. 이 코어는 그때만 «시그니처 점수»(그 CLI의 인식용 플래그가
//    그 창에 몇 개나 등장하는가) 최댓값이 «유일»할 때만 그 창을 채택한다
//    (동점이면 AMBIGUOUS, 하나도 없으면 NOT_FOUND). ★이 경로는 필수
//    플래그가 «전부» 빠진 창은 애초에 점수 0이라 못 찾는다 -- 즉 2층
//    결속 CLI에서는 «완전 누락»을 구조적으로 못 잡고 «일부 누락»만 잡는다.
//    이 한계는 CLI별 결속 층(resolution)을 결과에 그대로 실어 정직하게
//    보고한다(조용히 숨기지 않는다).

import { CLI_CONTRACTS } from "./dispatch-arg-contract-registry.mjs";

export const REASON = Object.freeze({
  PASS: "PASS",
  MISSING_ARGS: "MISSING_ARGS",
  SCRIPT_PATH_ASSIGNMENT_NOT_FOUND: "SCRIPT_PATH_ASSIGNMENT_NOT_FOUND",
  MULTIPLE_SCRIPT_PATH_BINDINGS: "MULTIPLE_SCRIPT_PATH_BINDINGS",
  CALL_SITE_NOT_FOUND: "CALL_SITE_NOT_FOUND",
  CALL_SITE_AMBIGUOUS: "CALL_SITE_AMBIGUOUS",
  MULTIPLE_INVOCATIONS: "MULTIPLE_INVOCATIONS",
});

// 실패 사유별 exit code(§2-3 "알려진 실패 사유는 각각 다른 코드로 구분").
// 값이 클수록(숫자가 아니라 아래 우선순위 배열 인덱스) "더 심각"으로 쳐서
// 여러 CLI의 사유가 섞이면 그중 가장 우선순위 높은 사유의 코드를 CLI
// 전체 종료코드로 쓴다(runContractCheck의 exitCode 필드).
export const EXIT_CODE = Object.freeze({
  [REASON.PASS]: 0,
  [REASON.MISSING_ARGS]: 1,
  [REASON.CALL_SITE_NOT_FOUND]: 2,
  [REASON.SCRIPT_PATH_ASSIGNMENT_NOT_FOUND]: 3,
  [REASON.MULTIPLE_SCRIPT_PATH_BINDINGS]: 4,
  [REASON.CALL_SITE_AMBIGUOUS]: 5,
  [REASON.MULTIPLE_INVOCATIONS]: 6,
});
// PASS가 아닌 사유들 중 "이 실행 전체의 exit code"를 고를 때 쓰는 우선순위
// (가장 앞이 가장 우선). 여러 CLI가 서로 다른 사유로 실패하면, 더 근본적인
// (호출 지점 자체를 못 찾는) 사유가 "누락 인자만 있음"보다 앞선다 -- 사람이
// 먼저 고쳐야 할 문제가 무엇인지 종료코드만으로도 추정 가능하게.
const REASON_PRIORITY = [
  REASON.MULTIPLE_INVOCATIONS,
  REASON.CALL_SITE_AMBIGUOUS,
  REASON.MULTIPLE_SCRIPT_PATH_BINDINGS,
  REASON.SCRIPT_PATH_ASSIGNMENT_NOT_FOUND,
  REASON.CALL_SITE_NOT_FOUND,
  REASON.MISSING_ARGS,
];

function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n");
}

// 전체 줄 주석(트림 후 `#`로 시작하는 줄)을 빈 줄로 바꾼다 -- 코드와
// 같은 줄에 섞인 `# ...` 트레일링 주석은 건드리지 않는다(이 저장소·
// 관제실 실제 PowerShell 스타일이 코드/주석을 한 줄에 안 섞는다는 전제는
// seat-proof-wrapper-shape.mjs의 codeLinesOf와 동일). 이게 없으면 "예시로
// 호출문을 그대로 인용한 설명 주석"(실측: 관제실 155행 "# 게이트
// 호출(아래 & node $gateScript ...)에 --dispatch-receipt-path가")이
// 진짜 호출 창으로 오인식된다 -- 줄 번호/오프셋은 보존해야 하므로 줄을
// 지우지 않고 내용만 비운다.
function stripFullLineComments(text) {
  return text
    .split("\n")
    .map((line) => (line.trim().startsWith("#") ? "" : line))
    .join("\n");
}

function normalizeSlashes(p) {
  return (p ?? "").replace(/\\/g, "/");
}

// 배달기 원문 전체에서 `$var = Join-Path ... "<상대경로>"` 꼴 대입을 전부
// 찾는다. 값(상대경로)의 슬래시 방향은 무관하게 정규화해 비교한다(실측:
// 관제실 코드가 `/`·`\` 둘 다 섞어 쓴다).
function findJoinPathAssignments(text) {
  const re = /\$([A-Za-z_]\w*)\s*=\s*Join-Path\b[^\n]*?"([^"]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      varName: m[1],
      relPath: normalizeSlashes(m[2]),
      index: m.index,
    });
  }
  return out;
}

// cli.scriptBasename(예: "scripts/check/dispatch-gate-decision.mjs")로
// 끝나는 Join-Path 대입 var 이름을 찾는다. 0개 -> null. 2개 이상(서로 다른
// var 이름) -> ambiguous(복수 결속).
function resolveScriptPathVar(assignments, scriptBasename) {
  const matches = assignments.filter((a) => a.relPath.endsWith(scriptBasename));
  const distinctVars = [...new Set(matches.map((a) => a.varName))];
  if (distinctVars.length === 0) return { varName: null, ambiguous: false };
  if (distinctVars.length > 1) return { varName: null, ambiguous: true };
  return { varName: distinctVars[0], ambiguous: false };
}

// 창(호출 지점 후보) 하나의 모양: { kind, startToken, argsText, index }
// startToken = "& node" 뒤 또는 "@(" 뒤 첫 토큰(스크립트 경로를 담은
// 변수 이름, "$" 제거). argsText = 그 뒤 나머지 인자 원문(플래그·위치
// 인자 추출 대상).

// 직접 호출 창: `& node $var ...(줄 끝까지)`. 실측 5개 호출 지점이 전부
// 한 줄 안에 있으므로(§2-1 표 인용 행) 줄 끝을 창의 끝으로 삼는다 -- 여러
// 줄에 걸친 직접 호출은 이 코어의 인식 범위 밖(발견 시 CALL_SITE_NOT_FOUND
// 로 fail-closed, "모르면 멈춘다"의 정확한 적용).
function findDirectCallWindows(text) {
  const re = /&\s*node\s+\$([A-Za-z_]\w*)\b([^\n]*)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      kind: "direct",
      startToken: m[1],
      argsText: m[2],
      index: m.index,
    });
  }
  return out;
}

// 배열 리터럴 호출 창: `@( $var, ... )` -- 괄호 깊이를 세어 짝이 맞는
// 닫는 괄호까지를 창으로 삼는다(여러 줄에 걸쳐도 동작 -- confirmArgs가
// 이 모양). 첫 원소가 변수([A-Za-z_]\w*, "$" 접두)가 아니면(예: 리터럴
// 문자열 하나뿐인 배열) 이 코어가 다루는 호출 창이 아니므로 버린다.
function findArrayCallWindows(text) {
  const out = [];
  const openRe = /@\(/g;
  let m;
  while ((m = openRe.exec(text)) !== null) {
    const openIdx = m.index + m[0].length;
    let depth = 1;
    let i = openIdx;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue; // 짝 안 맞음 -- 이 창은 버린다(다른 판정에 영향 없음).
    const body = text.slice(openIdx, i);
    const firstTokenMatch = /^\s*\$([A-Za-z_]\w*)\s*,/.exec(body);
    if (!firstTokenMatch) continue;
    const restStart = firstTokenMatch[0].length;
    out.push({
      kind: "array",
      startToken: firstTokenMatch[1],
      argsText: body.slice(restStart),
      index: m.index,
    });
    openRe.lastIndex = i + 1;
  }
  return out;
}

// argsText를 토큰으로 나눈다: 따옴표 문자열('...'/"...")은 통째로 하나,
// 그 외는 공백/쉼표/세미콜론으로 구분된 덩어리 하나. 각 토큰의 감싼
// 따옴표는 벗긴다.
function tokenize(argsText) {
  const re = /"[^"]*"|'[^']*'|[^\s,;]+/g;
  const raw = argsText.match(re) ?? [];
  return raw.map((t) =>
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
      ? t.slice(1, -1)
      : t,
  );
}

const REDIRECT_NOISE_RE = /^\d*>&?\d*$/;

function isFlagToken(tok) {
  return tok.startsWith("--");
}

function isNoiseToken(tok) {
  return REDIRECT_NOISE_RE.test(tok);
}

// 창 하나에서 실제로 등장한 플래그 집합과, 스크립트 경로 바로 다음의
// "첫 비플래그·비노이즈 토큰"(위치 인자/서브커맨드 후보)을 뽑는다.
function analyzeWindowArgs(argsText) {
  const tokens = tokenize(argsText);
  const presentFlags = new Set(tokens.filter(isFlagToken));
  let firstNonFlag = null;
  for (const tok of tokens) {
    if (isNoiseToken(tok)) continue;
    if (isFlagToken(tok)) break; // 첫 플래그 전까지만 위치 인자 후보로 본다.
    firstNonFlag = tok;
    break;
  }
  return { presentFlags, firstNonFlag };
}

function allRecognitionFlags(cli) {
  const set = new Set();
  for (const req of cli.requiredArgs) for (const f of req.flags) set.add(f);
  for (const f of cli.recognitionOnlyFlags ?? []) set.add(f);
  return set;
}

function scoreWindow(window, recognitionFlags) {
  const { presentFlags } = analyzeWindowArgs(window.argsText);
  let score = 0;
  for (const f of presentFlags) if (recognitionFlags.has(f)) score++;
  return score;
}

// requiredArgs + requiresPositionalArg/requiresSubcommand를 창 하나의
// 실제 내용과 대조해 빠진 항목 이름 목록을 만든다(플래그는 그 자체 이름,
// anyOf는 "--a|--b" 표기, 위치 인자는 "<positional task-path>", 서브커맨드는
// "<subcommand:admit>").
function findMissing(cli, window) {
  const { presentFlags, firstNonFlag } = analyzeWindowArgs(window.argsText);
  const missing = [];
  for (const req of cli.requiredArgs) {
    const satisfied = req.flags.some((f) => presentFlags.has(f));
    if (!satisfied) missing.push(req.flags.join("|"));
  }
  if (cli.requiresPositionalArg && firstNonFlag === null) {
    missing.push("<positional task-path>");
  }
  if (cli.requiresSubcommand && firstNonFlag !== cli.requiresSubcommand) {
    missing.push(`<subcommand:${cli.requiresSubcommand}>`);
  }
  return missing;
}

function directResolutionFinding(cli, varName, boundWindows) {
  if (boundWindows.length === 1) {
    const window = boundWindows[0];
    const missing = findMissing(cli, window);
    return {
      id: cli.id,
      reasonCode: missing.length === 0 ? REASON.PASS : REASON.MISSING_ARGS,
      missing,
      resolution: "direct",
      detail:
        missing.length === 0
          ? `직접 결속(변수 $${varName}) -- 필수 인자 전부 확인됨`
          : `직접 결속(변수 $${varName}) -- 누락: ${missing.join(", ")}`,
    };
  }
  return {
    id: cli.id,
    reasonCode: REASON.MULTIPLE_INVOCATIONS,
    missing: [],
    resolution: null,
    detail: `변수 $${varName}를 쓰는 호출 창이 ${boundWindows.length}개 발견됨 -- 어느 호출이 계약 대상인지 판정 불가`,
  };
}

// 2층: 간접 결속 폴백 -- 시그니처 점수 최댓값이 «유일»할 때만 채택.
// varName === null(정의 자체를 못 찾음)이거나, varName은 있는데 어떤 창도
// 그 이름을 직접 쓰지 않는(함수 매개변수로 이름이 바뀐) 경우 둘 다 이
// 경로를 탄다(호출자가 결정).
function heuristicResolutionFinding(cli, varName, allWindows) {
  const recognitionFlags = allRecognitionFlags(cli);
  const scored = allWindows
    .map((w) => ({ w, score: scoreWindow(w, recognitionFlags) }))
    .filter((s) => s.score > 0);
  if (scored.length === 0) {
    return {
      id: cli.id,
      reasonCode:
        varName === null
          ? REASON.SCRIPT_PATH_ASSIGNMENT_NOT_FOUND
          : REASON.CALL_SITE_NOT_FOUND,
      missing: [],
      resolution: null,
      detail:
        varName === null
          ? `'${cli.scriptBasename}'로 끝나는 Join-Path 대입을 찾지 못함`
          : `변수 $${varName}는 정의됐으나 어느 호출 창에서도 쓰이지 않고, 인식용 플래그 시그니처로도 후보 창을 찾지 못함`,
    };
  }
  const maxScore = Math.max(...scored.map((s) => s.score));
  const best = scored.filter((s) => s.score === maxScore);
  if (best.length > 1) {
    return {
      id: cli.id,
      reasonCode: REASON.CALL_SITE_AMBIGUOUS,
      missing: [],
      resolution: null,
      detail: `간접 결속 폴백에서 동점(점수 ${maxScore})인 후보 창이 ${best.length}개 -- 판정 불가`,
    };
  }
  const missing = findMissing(cli, best[0].w);
  return {
    id: cli.id,
    reasonCode: missing.length === 0 ? REASON.PASS : REASON.MISSING_ARGS,
    missing,
    resolution: "heuristic",
    detail:
      (missing.length === 0
        ? `간접 결속(시그니처 점수 ${maxScore}) -- 인식된 필수 인자 전부 확인됨`
        : `간접 결속(시그니처 점수 ${maxScore}) -- 누락: ${missing.join(", ")}`) +
      " -- ★정직 한계: 이 경로는 변수 결속이 아니라 플래그 시그니처 추정이므로 «필수 인자가 전부 빠진» 창은 구조적으로 못 잡는다(모듈 헤더 참고)",
  };
}

// CLI_CONTRACTS 항목 하나를 판정한다(runContractCheck의 contracts.map
// 콜백을 분리 -- 이 저장소 quality-check의 함수 길이/복잡도 상한 때문,
// 판정 로직은 무변경).
function resolveCliFinding(cli, assignments, allWindows) {
  const { varName, ambiguous } = resolveScriptPathVar(
    assignments,
    cli.scriptBasename,
  );
  if (ambiguous) {
    return {
      id: cli.id,
      reasonCode: REASON.MULTIPLE_SCRIPT_PATH_BINDINGS,
      missing: [],
      resolution: null,
      detail: `'${cli.scriptBasename}'로 끝나는 Join-Path 대입이 서로 다른 변수 이름으로 2개 이상 있음 -- 어느 것이 실제 호출에 쓰이는지 판정 불가`,
    };
  }

  // 1층: 직접 결속 -- varName이 실제로 정의됐고, 그 변수를 쓰는 창이
  // 정확히 하나 있으면 그 창을 채택한다(플래그 존재 여부와 무관).
  if (varName !== null) {
    const boundWindows = allWindows.filter((w) => w.startToken === varName);
    if (boundWindows.length > 0) {
      return directResolutionFinding(cli, varName, boundWindows);
    }
    // boundWindows.length === 0: 변수는 정의됐지만 어느 창에서도 안
    // 쓰임 -- 2층(간접 결속) 폴백으로 넘어간다.
  }
  return heuristicResolutionFinding(cli, varName, allWindows);
}

// 이 파일의 유일한 공개 진입점: 배달기 원문 하나를 받아 CLI_CONTRACTS의
// 각 항목을 판정한다. 반환: { overallReasonPriority, findings: [...] }.
// findings[i] = { id, reasonCode, missing, resolution, detail }
export function runContractCheck(scriptText, contracts = CLI_CONTRACTS) {
  const text = stripFullLineComments(normalizeNewlines(scriptText));
  const assignments = findJoinPathAssignments(text);
  const directWindows = findDirectCallWindows(text);
  const arrayWindows = findArrayCallWindows(text);
  const allWindows = [...directWindows, ...arrayWindows];

  const findings = contracts.map((cli) =>
    resolveCliFinding(cli, assignments, allWindows),
  );

  const failing = findings.filter((f) => f.reasonCode !== REASON.PASS);
  let overallReasonCode = REASON.PASS;
  for (const reason of REASON_PRIORITY) {
    if (failing.some((f) => f.reasonCode === reason)) {
      overallReasonCode = reason;
      break;
    }
  }
  return {
    ok: overallReasonCode === REASON.PASS,
    exitCode: EXIT_CODE[overallReasonCode],
    overallReasonCode,
    findings,
  };
}
