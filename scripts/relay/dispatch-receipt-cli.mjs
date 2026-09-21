import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { stampDispatchIdOnLatestArchivedTaskFile } from "../check/envelope-archive.mjs";

// HYK-219-receipts-1 (gap#96 대조의 왼쪽 항): 배달 성공 직후 관제실
// `dispatch-worker.ps1`이 호출하는 저장소 CLI -- "우리 도구가 이 배달을
// 했다"는 구조화 영수증 1건을 append-only로 기록한다.
//
// 새로 만든 이유(§1-4, 기존 `createDispatchReceiptRecorder` 재사용 안 함):
// orca-adapter.mjs:3288의 recorder는 좌석 "생성" 회계(worktreePath로 이미
// 존재하는 대장 레코드를 찾아 갱신하는 `recordSeatDispatch`)를 위해
// 만들어졌고, 그 유일 결선(`createRealLaunchSink`)은 `launch-seam.mjs`의
// armed=false 사이클에만 붙어 있어 프로덕션에서 절대 안 불린다(그 파일
// 자신의 정직 한계 주석 그대로). 이 CLI가 실제로 걸리는 지점은 그것과
// 전혀 다른 경로 -- 사람이 돌리는 `dispatch-worker.ps1`의 매 dispatch
// 직후 -- 이라 그 recorder의 "0-match로 접힌다"는 자인이 그대로 적용된다
// (worktreePath 키의 안정 대장 레코드가 여기에도 없다). 대장 갱신이 아니라
// 그냥 "이 dispatch가 있었다"는 평평한 append-only 로그가 필요하므로,
// 스키마·관심사가 다른 새 CLI로 분리했다(기존 recorder를 억지로 끼워 맞추면
// 그 recorder의 생성-대장 전제를 이 경로에도 강제하게 된다).
//
// §1 비타협: 이 파일은 `orca`를 호출하지 않는다(execFn 없음, orca-adapter
// import 없음) -- ps1이 이미 받은 dispatch 응답 JSON을 stdin으로 받아
// 기록만 한다. orca-cli-boundary.mjs 정적 스캔 대상에 걸릴 spawn 호출이
// 이 파일에 전혀 없다.
//
// §4 주장 축소(문면 고정, 한용 확정 2026-08-10 18:20): 이 축은 같은 사용자
// 권한의 의도적 우회를 막지도, 확정 탐지하지도 못한다(표식·영수증 파일
// 모두 위조·삭제 가능). 잡는 것은 (a) 실수형 우회(도구를 지나쳐 나간
// 배달)와 (b) 영수증 없는 배달의 존재 신호까지다. 의도형 차단은 OS 권한
// 분리(HYK-89) 없이는 성립하지 않는다.
//
// HYK-219-receipts-2 (1R 반려 대응): 이 CLI 자체의 계약은 안 바뀜(§1 필수
// 6필드·loud failure·append-only 전부 유지). 바뀐 것은 두 가지뿐 --
// (1) dispatch_timestamp_utc로 필드명 개칭(§3-ⓑ, UTC 표시자 없어 오독
// 유발), (2) dispatch-worker.ps1이 이 CLI를 호출하기 전에 "이 파일이
// 있는지"만 먼저 확인해 없으면 dispatch 자체를 만들지 않는다(§1 반쪽
// 배달 방지 -- 그 확인 로직은 부트스트랩 문제라 CLI 안에 넣을 수 없다,
// ps1 쪽 상세는 그 파일 자신의 헤더 참조).

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// HYK-396 §3: `--harness-dir`는 선택 필드다(§1 필수 6필드에 포함되지
// 않는다 -- 이 플래그가 없어도 이 CLI의 기존 계약은 조금도 바뀌지
// 않는다). 관제실이 넘겨 주면(이 CLI가 이미 아는 role+dispatch_id로) 배달
// 시점 각인(§3 아래 runDispatchReceiptCli)을 시도하고, 안 넘기면 그
// 시도 자체를 건너뛴다(기존 배포/구 버전 관제실과 100% 호환).
const FLAG_TO_FIELD = Object.freeze({
  "--role": "role",
  "--task-label": "harnessTaskLabel",
  "--receipt-path": "receiptPath",
  "--harness-dir": "harnessDir",
});

function classifyFlag(arg) {
  if (arg.startsWith("--") && arg.includes("=")) {
    const flagName = arg.slice(0, arg.indexOf("="));
    return {
      error: `unsupported '${flagName}=value' syntax ('${arg}') -- use '${flagName} value' (space-separated) instead`,
    };
  }
  if (arg.startsWith("--") && !FLAG_TO_FIELD[arg]) {
    return { error: `unrecognized flag '${arg}'` };
  }
  return { field: FLAG_TO_FIELD[arg] };
}

// HYK-347 §1 경로 계약 (이 CLI에서의 사용, 쓰기 측): `DISPATCH_RECEIPT_PATH`
// 는 관제실(dispatch-worker.ps1)이 이 CLI를 자식 프로세스로 부를 때 넣어
// 주는 env다 -- 이 저장소는 값을 생성하거나 기본 경로를 하드코딩하지
// 않는다(§1 "관제실 소유" 원칙, dispatch-gate-decision.mjs의
// resolveDispatchReceiptPath 주석과 동일 계약). `--receipt-path`도 env도
// 둘 다 없으면 아래 parseDispatchReceiptArgs가 즉시 `ok:false`(파일을
// 쓰지 않는다) -- 조용히 어딘가에 기본 파일을 만들지 않는다(§1 "얇은
// 껍데기 금지").
const USAGE =
  "usage: dispatch-receipt-cli.mjs --role <CODER|REVIEW|VERIFY|PM> --task-label <harness task label> [--receipt-path <path>] [--harness-dir <path>]\n" +
  "  dispatch 응답 JSON(orca orchestration dispatch --json 출력)을 stdin으로 받는다.\n" +
  "  --receipt-path 생략 시 env DISPATCH_RECEIPT_PATH를 쓴다 -- 둘 다 없으면 실패(저장소 안 절대경로 하드코딩 금지).\n" +
  "  --harness-dir 생략 시 HYK-396 배달 시점 dispatch_id 각인을 건너뛴다(선택 필드, 구 버전 관제실 호환).";

// env는 호출자가 명시로 주입한다(direct-entry는 process.env) -- 순수 함수로
// 유지해 시험이 실 환경을 건드리지 않게 한다.
export function parseDispatchReceiptArgs(args, env = {}) {
  if (args.includes("--help")) return { ok: true, help: true };
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const classified = classifyFlag(args[i]);
    if (classified.error) return { ok: false, reason: classified.error };
    if (classified.field) parsed[classified.field] = args[++i];
  }
  if (
    !isNonEmptyString(parsed.receiptPath) &&
    isNonEmptyString(env.DISPATCH_RECEIPT_PATH)
  ) {
    parsed.receiptPath = env.DISPATCH_RECEIPT_PATH;
  }
  if (
    !isNonEmptyString(parsed.role) ||
    !isNonEmptyString(parsed.harnessTaskLabel) ||
    !isNonEmptyString(parsed.receiptPath)
  ) {
    return { ok: false, reason: `missing required field(s) -- ${USAGE}` };
  }
  return { ok: true, ...parsed };
}

// 응답에서 반드시 있어야 하는 3필드 -- 하나라도 없으면(빈 문자열 포함)
// 시끄러운 실패. 시각 필드는 별도(resolveDispatchTimestamp, fallback 있음).
const REQUIRED_DISPATCH_FIELDS = Object.freeze([
  { key: "task_id", out: "runtimeTaskId" },
  { key: "id", out: "dispatchId" },
  { key: "assignee_pane_key", out: "assigneePaneKey" },
]);

// dispatched_at/created_at 순으로 응답 안 시각을 우선 쓴다. 응답에 없을 때만
// wall-clock을 "그 순간" 읽어 fallback으로 쓴다(선기입 금지 -- 지금 시각을
// 미리 지어내지 않고 실제로 지금 읽는다). scripts/check/time-authority.mjs는
// TASK_DROPPED_AT/RESULT_DONE_AT 두 필드만 관장하고 "지금 시각을 읽는" export가
// 없어 여기서 직접 재사용할 함수가 없다 -- 그 모듈의 원칙(추측 금지, 그 순간의
// wall-clock)만 그대로 따른다.
const TIMESTAMP_CANDIDATE_FIELDS = Object.freeze([
  "dispatched_at",
  "created_at",
]);

export function resolveDispatchTimestamp(dispatch, nowFn = () => new Date()) {
  for (const field of TIMESTAMP_CANDIDATE_FIELDS) {
    const v = dispatch?.[field];
    if (isNonEmptyString(v)) {
      return { dispatchTimestamp: v, timestampSource: `response.${field}` };
    }
  }
  return {
    dispatchTimestamp: nowFn().toISOString(),
    timestampSource: "fallback_wallclock",
  };
}

// responseText -> { ok:true, runtimeTaskId, dispatchId, assigneePaneKey,
// dispatchTimestamp, timestampSource } | { ok:false, reason }. 파싱 실패나
// 3필드 중 하나라도 결손이면 무조건 ok:false -- 부분 값을 절대 반환하지 않는다.
export function extractDispatchEnvelope(
  responseText,
  nowFn = () => new Date(),
) {
  // PowerShell's pipeline (ConvertTo-Json | node ...) can prepend a UTF-8 BOM
  // to stdin depending on console encoding (실측: dispatch-worker.ps1 라이브
  // 왕복, HYK-219-receipts-1) -- strip it before parsing so a BOM alone never
  // turns a well-formed response into a JSON-parse failure.
  const stripped =
    typeof responseText === "string" && responseText.charCodeAt(0) === 0xfeff
      ? responseText.slice(1)
      : responseText;
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    return {
      ok: false,
      reason: `dispatch-receipt: response is not valid JSON (${err.message})`,
    };
  }
  const dispatch = parsed?.result?.dispatch;
  if (!dispatch || typeof dispatch !== "object") {
    return {
      ok: false,
      reason: "dispatch-receipt: response has no result.dispatch object",
    };
  }
  const missing = [];
  const out = {};
  for (const { key, out: outKey } of REQUIRED_DISPATCH_FIELDS) {
    const v = dispatch[key];
    if (!isNonEmptyString(v)) missing.push(key);
    else out[outKey] = v;
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `dispatch-receipt: response missing required field(s): ${missing.join(", ")}`,
    };
  }
  return { ok: true, ...out, ...resolveDispatchTimestamp(dispatch, nowFn) };
}

// HYK-219-receipts-2 §3-ⓑ (1R 실측 결함): orca 응답의 dispatched_at/
// created_at은 표시자 없는 UTC다(실측: 응답 "2026-08-10 21:22:01"이 기록된
// 그 순간 로컬 시계는 "2026-08-11 06:22 KST" -- 정확히 +9h). 필드명에
// "_utc"만 뒤에 붙이고 원본 문자열은 그대로 보존한다(재포맷/타임존 변환은
// 하지 않는다 -- 벤더가 준 원본을 조용히 바꾸면 그 자체가 새 오독 소스가
// 된다). fallback_wallclock 경로는 이미 Date#toISOString()이 "Z" 접미로
// UTC임을 스스로 드러내므로 같은 필드명 하나로 두 출처 모두 커버된다.
export function buildReceiptRecord({
  envelope,
  role,
  harnessTaskLabel,
  nowFn = () => new Date(),
}) {
  return {
    recorded_at: nowFn().toISOString(),
    runtime_task_id: envelope.runtimeTaskId,
    dispatch_id: envelope.dispatchId,
    assignee_pane_key: envelope.assigneePaneKey,
    dispatch_timestamp_utc: envelope.dispatchTimestamp,
    dispatch_timestamp_source: envelope.timestampSource,
    role,
    harness_task_label: harnessTaskLabel,
  };
}

// append-only: 기존 줄을 절대 읽지도 다시 쓰지도 않는다(rewrite 없음) --
// O_APPEND 계열 append만 쓰므로 1번째 줄이 이후 호출로 변형될 여지가 없다.
export function appendReceiptLine({
  receiptPath,
  record,
  appendFn = (p, text) => appendFileSync(p, text, "utf8"),
  mkdirFn = (p) => mkdirSync(p, { recursive: true }),
}) {
  try {
    mkdirFn(dirname(receiptPath));
    appendFn(receiptPath, JSON.stringify(record) + "\n");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `dispatch-receipt: failed to append to '${receiptPath}' (${err.message})`,
    };
  }
}

export function runDispatchReceiptCli(argv, opts = {}) {
  const env = opts.env ?? {};
  const nowFn =
    typeof opts.nowFn === "function" ? opts.nowFn : () => new Date();

  const parsed = parseDispatchReceiptArgs(argv, env);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.help) return { ok: true, help: true };

  const envelope = extractDispatchEnvelope(opts.stdinText ?? "", nowFn);
  if (!envelope.ok) return envelope;

  const record = buildReceiptRecord({
    envelope,
    role: parsed.role,
    harnessTaskLabel: parsed.harnessTaskLabel,
    nowFn,
  });

  const appended = appendReceiptLine({
    receiptPath: parsed.receiptPath,
    record,
    appendFn: opts.appendFn,
    mkdirFn: opts.mkdirFn,
  });
  if (!appended.ok) return appended;

  // HYK-396 §3 (완성: dispatch_id를 배달 시점에 보존 사본에 실제로 굽는다).
  // 이 지점이 그 순간이다 -- 이 CLI 호출 자체가 "방금 실제 dispatch 응답을
  // 받았다"는 사실이고, record.dispatch_id는 그 응답에서 막 뽑은 값이다
  // (위 REQUIRED_DISPATCH_FIELDS, 지어낸 값이 아니다). `--harness-dir`가
  // 없으면(구 버전 관제실, 또는 아직 패치 미적용) 시도 자체를 건너뛴다 --
  // best-effort, 이 CLI 자신의 exit code/ok는 영향받지 않는다(영수증
  // append 자체가 이 CLI의 1차 계약, §1 그대로).
  let stamp;
  if (isNonEmptyString(parsed.harnessDir)) {
    stamp = stampDispatchIdOnLatestArchivedTaskFile({
      role: parsed.role,
      harnessDir: parsed.harnessDir,
      dispatchId: record.dispatch_id,
    });
  }

  return { ok: true, record, stamp };
}

export function formatDispatchReceiptResult(result) {
  if (result.help) return USAGE;
  if (result.ok) {
    const r = result.record;
    const stampSuffix = result.stamp
      ? ` stamp=${result.stamp.ok ? (result.stamp.skipped ? "SKIPPED" : "OK") : "FAILED"}(${result.stamp.reason})`
      : "";
    return (
      `RECORDED dispatch_id=${r.dispatch_id} runtime_task_id=${r.runtime_task_id} ` +
      `assignee_pane_key=${r.assignee_pane_key} role=${r.role} label=${r.harness_task_label} ` +
      `timestamp_utc=${r.dispatch_timestamp_utc}(${r.dispatch_timestamp_source})${stampSuffix}`
    );
  }
  return `FAILED reason=${result.reason}`;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/dispatch-receipt-cli.mjs");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  let stdinText = "";
  if (!argv.includes("--help")) {
    try {
      stdinText = readFileSync(0, "utf8");
    } catch {
      stdinText = "";
    }
  }
  const result = runDispatchReceiptCli(argv, { stdinText, env: process.env });
  console.log(formatDispatchReceiptResult(result));
  process.exit(result.ok ? 0 : 1);
}
