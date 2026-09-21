import { writeFileSync } from "node:fs";
import { checkPreDispatch, buildSpec } from "./orca-predispatch.mjs";
import { checkRelayHandshake } from "../check/relay-handshake.mjs";

// HYK-162 사이클 2 (C 절충 스파이크, PKT-20260719-HYK162-ORCA-HYBRID-SPIKE §4): 사이클 1이
// 동결한 "시작 자격" 관문(orca-predispatch.mjs, 수정 금지·재사용만)을 실사용하는 스파이크
// 러너. **이 파일 안에서 orca 바이너리를 라이브로 호출하는 코드는 없다** -- 전부
// `execFn` 주입 계약 뒤로 미뤄진다(claude-adapter.mjs의 spawnSyncFn 주입 전례와 동형).
// 실 orca CLI 결선은 CLI 엔트리(맨 아래)에서만 일어나고, 그 실행 자체는 S7 REVIEW 승인
// 후 ORCH+사람 참관 하 1회로 한정된다(이 사이클 테스트는 전부 fake execFn).
//
// honesty (패킷 §7 인용): 이 러너는 "orca CLI 직접 호출을 실역 밖에서 기계 차단한다"는
// 주장이 아니다 -- 이 러너는 유일 허용 통로가 아니라 유일 **검증된** 통로일 뿐이다.
//
// S6 선언: 기반=B(Node 러너, 엔진 무관 -- Claude 훅 아님).

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function errText(err) {
  try {
    if (err && typeof err === "object") {
      const m = err.message;
      if (typeof m === "string") return m;
    }
    return String(err);
  } catch {
    return "unknown error (message accessor threw)";
  }
}

export const REASON = Object.freeze({
  PREDISPATCH_DENIED: "PREDISPATCH_DENIED",
  ORCA_COMMAND_NOT_ALLOWED: "ORCA_COMMAND_NOT_ALLOWED",
  TASK_CREATE_FAILED: "TASK_CREATE_FAILED",
  DISPATCH_FAILED: "DISPATCH_FAILED",
  CHECK_TIMEOUT: "CHECK_TIMEOUT",
  CHECK_ESCALATION: "CHECK_ESCALATION",
  CHECK_UNKNOWN_OUTCOME: "CHECK_UNKNOWN_OUTCOME",
  HANDSHAKE_FAILED: "HANDSHAKE_FAILED",
  COMPLETE: "COMPLETE",
});

// ---- G2 (review-3 수리, 사이클 2에서 실제 Orca CLI 문법으로 재정의): 패킷 §4-2
// 허용 3종만, **exact argv shape**로. review-3가 직접 재현한 결함 -- 이전 버전은
// prefix 비교라 고정 토큰 뒤에 임의 인자를 덧붙여도(`--agent attacker`/`--run-hooks`/
// `--linear`) 통과했다. 이제 고정 토큰은 위치까지 정확히 일치해야 하고(순서 변경·삽입
// 불가), 길이도 정확히 일치해야 하며(초과 인자 거부), 값 슬롯은 타입만 검증한다.
//
// 사이클 2 정정(ORCH 실측, `orca ... --help` + task-create 1회 read-only 프로브):
// 구 3형(`--task-id`/`--target`/`--timeout`)은 실제 Orca CLI에 존재하지 않는
// 플래그였다 -- 사이클 1 화이트리스트는 실제 CLI로 한 번도 검증되지 않은 채 승인됐다.
// 아래가 실제 문법이다. task-create는 `--task-id`를 받지 않는다(runtime이 id를
// 생성). dispatch는 `--task <runtime task id>`/`--to <handle>`. check는 task id로
// 거르지 못하고 `--terminal <coordinator handle>`/`--types`로 coordinator 인박스를
// 거른다. 그 외 조합(terminal send, dispatch --agent/--setup/--run-hooks,
// orchestration run, automations, linear 등)은 이 러너의 코드 경로에 없고, 이
// 가드가 방어적으로도 거부한다.
const ORCA_COMMAND_SHAPES = Object.freeze([
  {
    name: "task-create",
    length: 5,
    fixed: {
      0: "orchestration",
      1: "task-create",
      2: "--spec",
      4: "--json",
    },
    values: [3],
  },
  {
    name: "dispatch",
    length: 8,
    fixed: {
      0: "orchestration",
      1: "dispatch",
      2: "--task",
      4: "--to",
      6: "--inject",
      7: "--json",
    },
    values: [3, 5],
  },
  // HYK-170 사이클2 ②-b coder-1 (D11, pm-2 §QA): codex(REVIEW=codex/terra
  // 좌석 프로필 한정) 배달은 --inject가 입력을 깨뜨려(OSC escape 누출)
  // 무-inject dispatch로 배정 기록만 만든다 -- 관제실 스톱갭
  // `dispatch-worker.ps1`의 `Invoke-Dispatch -inject:$false` 경로가 이미
  // 라이브로 검증한 형태 그대로다(추측 argv 아님). 이전엔 이 정확한 7-원소
  // 형태가 known-bad(사이클2 (3d))로 거부됐다 -- 지금은 D11이 이 profile을
  // 정당화하므로 화이트리스트에 **추가**한다(기존 inject 형태를 느슨하게
  // 만든 것이 아니라 별도 exact shape 신설, 위치·길이 그대로 강제).
  {
    name: "dispatch-no-inject",
    length: 7,
    fixed: {
      0: "orchestration",
      1: "dispatch",
      2: "--task",
      4: "--to",
      6: "--json",
    },
    values: [3, 5],
  },
  {
    name: "check-wait",
    length: 10,
    fixed: {
      0: "orchestration",
      1: "check",
      2: "--terminal",
      4: "--types",
      5: "worker_done,escalation",
      6: "--wait",
      7: "--timeout-ms",
      9: "--json",
    },
    values: [3, 8],
  },
]);

function matchesShape(cmd, shape) {
  if (cmd.length !== shape.length) return false;
  for (const idx of Object.keys(shape.fixed)) {
    if (cmd[Number(idx)] !== shape.fixed[idx]) return false;
  }
  return shape.values.every((idx) => isNonEmptyString(cmd[idx]));
}

export function assertAllowedOrcaCommand(argv) {
  const cmd = Array.isArray(argv) ? argv : [];
  const matches = ORCA_COMMAND_SHAPES.some((shape) => matchesShape(cmd, shape));
  if (!matches) {
    return {
      ok: false,
      reason: `orca-spike-runner: ${REASON.ORCA_COMMAND_NOT_ALLOWED} -- ${JSON.stringify(cmd)} does not exactly match any whitelisted §4-2 command shape`,
    };
  }
  return { ok: true };
}

function stop(reason, detail, receipts) {
  return { ok: false, allow: false, reason, detail: detail ?? null, receipts };
}

function pushReceipt(receipts, entry, nowFn) {
  receipts.push({ at: nowFn(), ...entry });
}

// ---- 명령 빌더(순수, 동적 문자열 조합 없음) ----
// task-create는 하네스 task_id를 받지 않는다 -- runtime이 id를 생성한다(G-a).
// spec 문자열(= `go <하네스 task_id>`, buildSpec 재사용)만 넘긴다.
export function buildTaskCreateCommand(spec) {
  return ["orchestration", "task-create", "--spec", spec, "--json"];
}
// runtimeTaskId = task-create 응답에서 파싱한 id(parseRuntimeTaskId). 하네스
// task_id와 별개 -- 절대 우리가 만든 하네스 task_id를 여기 넣지 않는다.
export function buildDispatchCommand(runtimeTaskId, terminalHandle) {
  return [
    "orchestration",
    "dispatch",
    "--task",
    runtimeTaskId,
    "--to",
    terminalHandle,
    "--inject",
    "--json",
  ];
}
// D11 (codex REVIEW 프로필 전용, dispatch-worker.ps1 실측 그대로): --inject
// 없이 배정 기록만 만든다. text-send/Enter는 별도 명령(buildSeatLaunchTextCommand/
// buildSeatSubmitCommand, orca-adapter.mjs)으로 이어진다.
export function buildDispatchCommandNoInject(runtimeTaskId, terminalHandle) {
  return [
    "orchestration",
    "dispatch",
    "--task",
    runtimeTaskId,
    "--to",
    terminalHandle,
    "--json",
  ];
}
// check는 task id로 못 거른다(실제 CLI에 그런 옵션 없음) -- coordinatorHandle=이
// 스파이크를 실행 중인 coordinator 자신의 터미널 핸들(dispatch --to의 worker
// terminalHandle과는 별개 값)의 인박스를 worker_done/escalation 타입으로만 거른다.
export function buildCheckWaitCommand(coordinatorHandle, timeoutMs) {
  return [
    "orchestration",
    "check",
    "--terminal",
    coordinatorHandle,
    "--types",
    "worker_done,escalation",
    "--wait",
    "--timeout-ms",
    String(timeoutMs),
    "--json",
  ];
}

// G-a: task-create 응답에서 runtime task id 파싱(방어적) -- ORCH 실측 형태:
// 최상위 ok:true, result.task.id(예 task_80fa0dcac6c7), result.task.status="ready".
// 형태 불일치·id 비어있음은 전부 실패로 취급(추측 채움 금지).
export function parseRuntimeTaskId(response) {
  if (!isPlainObject(response) || response.ok !== true) return null;
  const task = isPlainObject(response.result) ? response.result.task : null;
  const id = isPlainObject(task) ? task.id : null;
  return isNonEmptyString(id) ? id : null;
}

// 화이트리스트 통과 + execFn 호출 + 예외/비-ok 응답을 지정된 reason으로 통일.
// export됨(review-3 수리): 이 함수가 실제 호출점에서 쓰는 유일한 execFn 진입로다.
// 배선 반사실 테스트가 이 함수를 *직접* 불러 forbidden argv에도 execFn이 호출되지
// 않음을 확인한다 -- assertAllowedOrcaCommand 함수 자체만 단위 테스트하는 것으로는
// "호출점이 그 결과를 실제로 소비하는지"가 증명되지 않는다는 review-3의 지적을 닫는다.
export function runGuardedStep(argv, opts, failReason, receipts, stepName) {
  const guard = assertAllowedOrcaCommand(argv);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  let response;
  try {
    response = opts.execFn(argv);
  } catch (err) {
    pushReceipt(
      receipts,
      { step: stepName, command: argv, error: errText(err) },
      opts.nowFn,
    );
    return {
      ok: false,
      reason: `orca-spike-runner: ${failReason} -- execFn threw (${errText(err)})`,
    };
  }
  pushReceipt(
    receipts,
    { step: stepName, command: argv, response },
    opts.nowFn,
  );
  if (!isPlainObject(response) || response.ok !== true) {
    return {
      ok: false,
      reason: `orca-spike-runner: ${failReason} -- ${isPlainObject(response) && isNonEmptyString(response.reason) ? response.reason : "response.ok !== true"}`,
    };
  }
  return { ok: true, response };
}

// check --wait 응답의 outcome을 fail-closed로 분류. worker_done은 여기서는 *운반
// 영수증*일 뿐이다 -- 완료 권위는 이어지는 checkRelayHandshake만이 준다(G6/G8).
//
// honesty (G-b 미구현 -- question_packet 필요, coder.md 참조): 패킷/태스크가 요구한
// worker_done payload의 taskId/dispatchId 결속(이 스파이크가 만든 runtime id·발급한
// dispatch id와 일치하는지 확인해 "떠도는 완료 신호"를 거부)은 여기 구현되지 않았다.
// 이유: dispatch 응답과 check --wait --json 응답의 실제 메시지 봉투 형태(payload가
// 어디에 어떤 키로 오는지)가 이 사이클에 한 번도 실측되지 않았다(task-create만
// ORCH가 read-only 프로브로 실측함) -- 추측으로 채우면 "검증된 계약"이라는 이 러너의
// honesty 전제를 어긴다. 실행은 여전히 fail-closed(outcome 미인식은 거부)이지만,
// 이 결속이 빠진 채로는 동일 coordinator 인박스에 온 *다른* worker_done을 이 스파이크
// 완료로 오인할 잔여 위험이 남는다 -- 완료 **권위**는 handshake뿐이라 그 위험은
// handshake가 흡수하지만(G6/G8 불변), 구조 갭 G-b 자체는 이번 사이클에서 정지됨.
function classifyCheckOutcome(response) {
  const outcome = isPlainObject(response) ? response.outcome : undefined;
  if (outcome === "worker_done") return { ok: true };
  if (outcome === "escalation") {
    return {
      ok: false,
      reason: `orca-spike-runner: ${REASON.CHECK_ESCALATION} -- worker escalated, human gate required`,
    };
  }
  if (outcome === "timeout") {
    return {
      ok: false,
      reason: `orca-spike-runner: ${REASON.CHECK_TIMEOUT} -- check --wait timed out`,
    };
  }
  return {
    ok: false,
    reason: `orca-spike-runner: ${REASON.CHECK_UNKNOWN_OUTCOME} -- unrecognized outcome ${JSON.stringify(outcome)}`,
  };
}

// ① 사이클 1 판정기(재사용, 재구현 금지) -- ALLOW 아니면 orca 호출 0.
function runPreDispatchStage(inp, o, deps, receipts) {
  const pd = checkPreDispatch(inp.predispatch, o);
  pushReceipt(
    receipts,
    { step: "predispatch", allow: pd.allow, reason: pd.reason },
    deps.nowFn,
  );
  if (!pd.allow) return stop(REASON.PREDISPATCH_DENIED, pd.reason, receipts);
  if (typeof deps.execFn !== "function") {
    return stop(
      REASON.TASK_CREATE_FAILED,
      "orca-spike-runner: opts.execFn is required past predispatch",
      receipts,
    );
  }
  return null;
}

// ②③④: task-create -> dispatch --inject -> check --wait (전부 execFn 뒤 -- 실 orca 호출 0).
function runOrcaStages(inp, deps, receipts) {
  const specResult = buildSpec(inp.task_id);
  if (!specResult.ok)
    return stop(REASON.TASK_CREATE_FAILED, specResult.reason, receipts);

  const created = runGuardedStep(
    buildTaskCreateCommand(specResult.spec),
    deps,
    REASON.TASK_CREATE_FAILED,
    receipts,
    "task-create",
  );
  if (!created.ok)
    return stop(REASON.TASK_CREATE_FAILED, created.reason, receipts);

  // G-a: 하네스 task_id와 별개인 runtime task id를 응답에서 캡처 -- 이게 없으면
  // dispatch를 나를 대상이 없다(구 버전은 이 자리에 하네스 task_id를 잘못 넣었다).
  const runtimeTaskId = parseRuntimeTaskId(created.response);
  if (!runtimeTaskId) {
    return stop(
      REASON.TASK_CREATE_FAILED,
      "orca-spike-runner: TASK_CREATE_FAILED -- response.result.task.id missing/empty (runtime id required to dispatch, G-a)",
      receipts,
    );
  }

  const dispatched = runGuardedStep(
    buildDispatchCommand(runtimeTaskId, inp.terminalHandle),
    deps,
    REASON.DISPATCH_FAILED,
    receipts,
    "dispatch",
  );
  if (!dispatched.ok)
    return stop(REASON.DISPATCH_FAILED, dispatched.reason, receipts);

  const checked = runGuardedStep(
    buildCheckWaitCommand(inp.coordinatorHandle, inp.timeoutMs),
    deps,
    REASON.CHECK_UNKNOWN_OUTCOME,
    receipts,
    "check-wait",
  );
  if (!checked.ok)
    return stop(REASON.CHECK_UNKNOWN_OUTCOME, checked.reason, receipts);

  const outcomeCheck = classifyCheckOutcome(checked.response);
  if (!outcomeCheck.ok) {
    const reason = outcomeCheck.reason.includes(REASON.CHECK_ESCALATION)
      ? REASON.CHECK_ESCALATION
      : outcomeCheck.reason.includes(REASON.CHECK_TIMEOUT)
        ? REASON.CHECK_TIMEOUT
        : REASON.CHECK_UNKNOWN_OUTCOME;
    return stop(reason, outcomeCheck.reason, receipts);
  }
  return null;
}

// ⑤ 완료 권위 = 기존 handshake(재사용, 재구현 금지). worker_done은 위에서 운반
// 영수증으로만 기록됐고, 성공 선언은 오직 이 handshake가 ok일 때만(G6/G8).
function runHandshakeStage(inp, receipts, nowFn) {
  const handshake = checkRelayHandshake(
    isPlainObject(inp.handshake) ? inp.handshake : {},
  );
  pushReceipt(
    receipts,
    { step: "handshake", ok: handshake.ok, reason: handshake.reason },
    nowFn,
  );
  if (!handshake.ok)
    return stop(REASON.HANDSHAKE_FAILED, handshake.reason, receipts);
  return null;
}

// ---- 스파이크 1회 시도 (fail-closed, 자동 재시도 0) ----
// input: {
//   predispatch: checkPreDispatch(input, opts)에 그대로 넘길 payload
//   task_id            -- 하네스 task_id(스파이크 spec `go <task_id>`용, runtime id 아님)
//   terminalHandle     -- dispatch --to 대상(작업을 받는 worker 터미널)
//   coordinatorHandle  -- check --terminal 대상(이 스파이크를 실행 중인 coordinator 자신의
//                         인박스 -- terminalHandle과 별개 값. 사이클 1엔 없던 신규 필드)
//   timeoutMs          -- check --timeout-ms에 그대로 감(사이클 1의 timeoutS 초 단위 폐기 --
//                         실제 CLI 플래그가 ms 단위라 단위 착각 방지 위해 필드명 자체를 바꿈)
//   handshake: { role, harnessDir } -- checkRelayHandshake({role, harnessDir})에 그대로 전달
// }
// opts: { execFn, nowFn }
export function runSpikeAttempt(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  const o = isPlainObject(opts) ? opts : {};
  const deps = {
    execFn: typeof o.execFn === "function" ? o.execFn : null,
    nowFn:
      typeof o.nowFn === "function" ? o.nowFn : () => new Date().toISOString(),
  };
  const receipts = [];

  const predispatchStop = runPreDispatchStage(inp, o, deps, receipts);
  if (predispatchStop) return predispatchStop;

  const orcaStop = runOrcaStages(inp, deps, receipts);
  if (orcaStop) return orcaStop;

  const handshakeStop = runHandshakeStage(inp, receipts, deps.nowFn);
  if (handshakeStop) return handshakeStop;

  return {
    ok: true,
    allow: true,
    reason: REASON.COMPLETE,
    detail: null,
    receipts,
  };
}

// ---- CLI (orca 라이브 호출 결선은 여기뿐 -- 이 사이클에서 호출되지 않음) ----
const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/orca-spike-runner.mjs");
if (invokedDirectly) {
  console.error(
    "orca-spike-runner: CLI 라이브 결선은 이 사이클에 없다 -- 실 실행은 S7 REVIEW 승인 후 ORCH+사람 참관 하 1회로 한정된다 (패킷 PKT-20260719-HYK162-ORCA-HYBRID-SPIKE §4).",
  );
  process.exit(1);
}

// receipt 원장을 JSON 파일로 남기는 얇은 헬퍼(CLI가 필요 시 사용 -- 이 사이클에서는 미결선).
export function writeReceiptLedger(path, receipts) {
  writeFileSync(path, JSON.stringify(receipts, null, 2), "utf8");
}
