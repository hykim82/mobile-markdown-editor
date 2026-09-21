// HYK-272/HYK-270-stall-visible-2/-3 (coder-task.md §4) -- 배달 직후
// "착수" 확인 CLI. ps1(관제실 dispatch-worker.ps1, ★이 저장소가 직접
// 고치지 않는다)이 배달 직후 이 한 줄을 불러 확인한다:
//
//   node scripts/supervisor/dispatch-start-confirm-cli.mjs \
//     --repo-root <워크트리 절대경로> --dispatched-at-ms <배달 시각 epoch ms> \
//     --claude-home <좌석 런처가 쓰는 실제 세션 기록 폴더> \
//     --baseline-bytes <배달 시점에 그 폴더에서 잰 총 바이트 수 -- 선택> \
//     --watch-dir <D:\문서관리\하네스-관제실\watch> \
//     --notify-dir <D:\문서관리\통역\받는함> \
//     --task-id <하네스 라벨>
//
// ★HYK-280(coder-task.md §2) -- `--claude-home`과 `--baseline-bytes`는
// 둘 다 선택 인자다. 안 넘기면 이전과 100% 동일하게 동작한다(회귀 0):
// `--claude-home` 생략 시 `os.homedir()/.claude`(기존 기본값), `--baseline-
// bytes` 생략 시 기준선을 심지 않는다(기존처럼 이 실행의 첫 실관측이
// 곧 기준선). `--claude-home`은 순수 폴더 경로이므로 claude 워커 좌석
// (`.claude-team` 등)이든 codex 좌석(`ORCA_CODEX_HOME` 아래)이든 호출자가
// 무엇을 넘기든 코드는 그 이름을 몰라도 된다(§2 항4 -- 엔진 이름 분기 0).
//
// 종료코드(★3R부터 3상태 -- coder-task.md §2 항4 "값을 뭉개지 마라"):
// - 0 = 착수 확인(STARTED).
// - 1 = **아예 시작 못 함**(NOT_STARTED, 타임아웃까지 세션 기록 파일 총
//   바이트 수가 한 번도 늘지 않음) -- 사람 조치: **재배달**.
// - 3 = **시작 후 멈춤**(STALLED_AFTER_START, 한 번은 늘었지만 그 마지막
//   증가로부터 `stallThresholdMs`가 지나도록 더 안 늚 -- 오늘 21시 승인창
//   정지 사고와 동형) -- 사람 조치: **좌석 상태 확인**(재배달이 아니다,
//   이미 뭔가는 하고 있었으므로).
// - 2 = 판정 불가(관측 수집 자체가 실패 -- 조용히 "착수함"으로 접지
//   않는다, §2-3 계열 원칙).
// 1·3 둘 다 사람이 읽는 한 줄이 stderr에 찍히고 notifyDir에 통지 파일
// 1장이 남는다(§3 "새 알림 채널 0" -- 기존 notifyDir 재사용). 통지 문구는
// 두 상태마다 다르다(조치가 다르므로).
//
// ★신호 선택 근거(coder-task.md §4-1 항1 요구, §3 실측 인용):
// - 화면(`orca terminal read`)은 이 조각 자신의 실측(coder.md 관측 지연
//   절)에서 76초가 지나도록 자기 마커를 반영하지 않는 경우가 나왔다 --
//   상한이 없다. 그래서 이 CLI는 화면을 전혀 읽지 않는다(orca 호출 0).
// - mtime은 ORCH 실측(§3-2)에서 "크기는 느는데 mtime은 그대로"인 구간이
//   있었다 -- 그래서 "크기"(dispatch-start-size-adapter.mjs)만 쓴다.
//
// ★HYK-270-stall-visible-3 (2R REVIEW 반려 수리, coder-task.md §1-§2):
// 2R은 관측 두 번째(=최초 증가)에서 즉시 STARTED로 폴링을 끝냈다 -- 그
// 뒤로 안 늘어도 다시 안 본다. 검토자 실측 원문: "totalBytes=0 → 5000 →
// 5000 → …"(승인창 등으로 멈춘 사례 2)가 `STARTED`로 종료돼 사례 2를
// 구조적으로 못 잡았다. ★수리: STARTED는 더 이상 "한 번이라도 늘면
// 즉시" 확정되지 않는다 -- 이 루프는 `timeoutMs`(배달 시각 기준, 기존과
// 동일한 전체 관측 창) 끝까지 계속 폴링하고, 그 시점에 코어가 최종
// 판정한다: 그 창 안에서 계속(=마지막 증가가 `stallThresholdMs` 이내)
// 늘고 있었으면 STARTED, 늘다가 멈췄으면(마지막 증가로부터
// `stallThresholdMs` 초과) STALLED_AFTER_START. ★단 STALLED_AFTER_START나
// NOT_STARTED가 먼저 확정되면(더 기다려도 뒤집힐 수 없는 나쁜 소식) 그
// 즉시 폴링을 멈추고 시끄럽게 실패한다 -- 나쁜 소식을 기다리게 하지
// 않는다.
//
// ★사례 1·2 커버리지(coder-task.md §4-2/§2 요구, ★3R 갱신):
// - 사례 1(메뉴 잔류로 아예 시작 못 함): 세션 로그 총 바이트 수가
//   `timeoutMs`까지 한 번도 안 늘어남 -> `NOT_STARTED`.
// - 사례 2(시작은 했으나 승인창 등으로 멈춤): 어느 정도 커지다가 그
//   마지막 증가로부터 `stallThresholdMs`를 넘게 더 안 늘어남 ->
//   `STALLED_AFTER_START`(★3R부터 실제로 잡는다 -- 2R은 이 경우를
//   `STARTED`로 잘못 종료했다).
// ⚠️**한계(2R부터 유지, 여전히 유효)**: 이 CLI는 "배달 직후 1회" 확인용
// 이라 `timeoutMs` 창을 넘어선 뒤에(예: 10분 진행하다 멈춤) 일어나는
// 정지는 혼자서 못 잡는다 -- 그건 이미 결선된 주기 감시(watch-run.mjs의
// dispatch-start 축, HYK-201)의 몫이다.
//
// Node 20 호환 -- ESM 표준 API만 사용.
import { writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { collectTotalSessionBytes } from "./dispatch-start-size-adapter.mjs";
import {
  judgeDispatchStartBySize,
  resolveAndValidateThresholds,
  DISPATCH_START_SIZE_VERDICT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STALL_THRESHOLD_MS,
} from "./dispatch-start-size-core.mjs";

export const DISPATCH_START_CONFIRM_STATUS = Object.freeze({
  STARTED: "DISPATCH_START_CONFIRM_STARTED",
  NOT_STARTED: "DISPATCH_START_CONFIRM_NOT_STARTED",
  STALLED_AFTER_START: "DISPATCH_START_CONFIRM_STALLED_AFTER_START",
  COLLECTION_FAILED: "DISPATCH_START_CONFIRM_COLLECTION_FAILED",
  // ★HYK-378 4R(REVIEW P1-1 반려 수리, 불변식 K) -- 생산 진입점이 폴링을
  // «시작하기 전에» 수치 인자를 일괄 거부할 때 쓰는 종결 상태. 기존
  // COLLECTION_FAILED(런타임 중 관측 수집이 실패)와 성격이 다르다 --
  // 이건 "애초에 이 호출 자체가 말이 안 된다"는 것이라 폴링을 단 한
  // 번도 시작하지 않는다(사람 조치도 다르다: 좌석·재배달이 아니라
  // 호출부(ps1 등)의 인자 자체를 고쳐야 한다).
  INVALID_ARGS: "DISPATCH_START_CONFIRM_INVALID_ARGS",
});

// 종료코드(문서 헤더와 동일 값 -- CLI 블록과 시험 양쪽이 이 표를 재사용).
export const DISPATCH_START_CONFIRM_EXIT_CODE = Object.freeze({
  [DISPATCH_START_CONFIRM_STATUS.STARTED]: 0,
  [DISPATCH_START_CONFIRM_STATUS.NOT_STARTED]: 1,
  [DISPATCH_START_CONFIRM_STATUS.COLLECTION_FAILED]: 2,
  [DISPATCH_START_CONFIRM_STATUS.STALLED_AFTER_START]: 3,
  // ★4R -- 기존 0~3과 안 겹치는 새 코드. "판정 불가"(2, 관측 실패)와도
  // 값을 공유하지 않는다 -- 하나는 실행 중 I/O가 실패한 것이고, 이건
  // 애초에 시작할 자격이 없는 호출이었다는 뜻이라 사람이 볼 조치가 다르다.
  [DISPATCH_START_CONFIRM_STATUS.INVALID_ARGS]: 4,
});

function defaultClaudeHomeDir() {
  return path.join(os.homedir(), ".claude");
}

function formatKstIsh(ms) {
  return new Date(ms).toISOString();
}

function buildNotStartedNoticeText({
  taskId,
  dispatchedAtMs,
  nowMs,
  observationCount,
}) {
  const lines = [];
  lines.push(
    `# 배달 후 착수 확인 실패 -- 아예 시작 못 함 -- ${formatKstIsh(nowMs)}`,
  );
  lines.push("");
  lines.push(`- 태스크: ${taskId || "(미상)"}`);
  lines.push(`- 배달 시각: ${formatKstIsh(dispatchedAtMs)}`);
  lines.push(
    `- 세션 기록 파일 총 바이트 수가 그 뒤 한 번도 늘지 않았습니다(관측 ${observationCount}회, 화면 미사용 -- 세션 로그 크기 기반).`,
  );
  lines.push("");
  lines.push(
    "이 좌석이 배달을 아예 못 받았을 수 있습니다(메뉴 잔류 등). 자동 재시도는 하지 않습니다 -- 사람이 **재배달** 여부를 결정해 주십시오.",
  );
  return lines.join("\n") + "\n";
}

function buildStalledAfterStartNoticeText({
  taskId,
  dispatchedAtMs,
  nowMs,
  lastGrowthAtMs,
  stallThresholdMs,
}) {
  const lines = [];
  lines.push(
    `# 배달 후 착수 확인 실패 -- 시작 후 멈춤 -- ${formatKstIsh(nowMs)}`,
  );
  lines.push("");
  lines.push(`- 태스크: ${taskId || "(미상)"}`);
  lines.push(`- 배달 시각: ${formatKstIsh(dispatchedAtMs)}`);
  lines.push(
    `- 마지막으로 세션 기록 파일이 커진 시각: ${formatKstIsh(lastGrowthAtMs)}`,
  );
  lines.push(
    `- 그 뒤로 ${Math.round(stallThresholdMs / 60000)}분 넘게 더 늘지 않았습니다(화면 미사용 -- 세션 로그 크기 기반).`,
  );
  lines.push("");
  lines.push(
    "이 좌석은 배달을 받아 시작은 했지만(예: 승인창 등에 걸려) 진행이 멈췄을 수 있습니다. 자동 재시도는 하지 않습니다 -- 사람이 **좌석 상태를 직접 확인**해 주십시오(재배달이 아닙니다 -- 이미 뭔가는 하고 있었습니다).",
  );
  return lines.join("\n") + "\n";
}

function buildNoticeFileName(nowMs) {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  return `dispatch-start-confirm-notify-${iso}.md`;
}

// ★HYK-378 5R(REVIEW P1-2 저장소 쪽 절반 수리, 불변식 O "관측 가능성") --
// `INVALID_ARGS`는 4R까지 stderr 한 줄뿐이었다. 무인 운용에서 그 줄을
// 아무도 안 읽으면(검토자 실측: 관제실 `dispatch-worker.ps1`이 미지
// 종료코드에 경고만 남기고 배달을 계속함 -- fail-open) 신호가 통째로
// 유실된다. ★설계 선택(반박 환영) -- 4R에서 "통지 파일을 안 남긴다"고
// 판단한 이유("좌석이 멈췄다"와 독자가 다르다)는 여전히 옳다고 본다 --
// 그래서 이번에도 NOT_STARTED/STALLED_AFTER_START와 **같은 파일**을
// 안 쓴다. 대신 **다른 파일명 접두사**로 별도 종류의 통지를 남긴다 --
// 좌석을 확인하라는 뜻이 아니라 "이 호출 자체(ps1 등 호출부가 넘긴
// 인자)가 잘못됐다"는 뜻임을 파일명만 보고도 구별할 수 있어야 한다는
// 원칙을 지키면서, 동시에 "저장소 안에서 관측 가능한 산출물"(불변식 O)
// 요구도 채운다.
function buildInvalidArgsNoticeFileName(nowMs) {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  return `dispatch-start-confirm-invalid-args-${iso}.md`;
}

function buildInvalidArgsNoticeText({ taskId, nowMs, reasonCode }) {
  const lines = [];
  lines.push(
    `# 배달 후 착수 확인 실패 -- 잘못된 인자 -- ${formatKstIsh(nowMs)}`,
  );
  lines.push("");
  lines.push(`- 태스크: ${taskId || "(미상)"}`);
  lines.push(`- 사유 코드: ${reasonCode || "(미상)"}`);
  lines.push("");
  lines.push(
    "이건 **좌석이 멈춘 것이 아닙니다** -- 이 CLI를 호출한 쪽(예: 관제실 `dispatch-worker.ps1`)이 넘긴 수치 인자 자체가 잘못됐습니다(`NaN`·`Infinity`·범위 밖 값 등). **좌석 확인이 아니라 호출부의 인자를 고쳐야 합니다.** 이 실행은 세션 폴더를 단 한 번도 들여다보지 않았습니다(폴링 미시작).",
  );
  return lines.join("\n") + "\n";
}

// writeInvalidArgsNotice(...) -- NOT_STARTED/STALLED_AFTER_START와 같은
// notifyDir을 쓰되 파일명 접두사가 달라(위 buildInvalidArgsNoticeFileName)
// 다른 종류의 실패임을 구별한다. `writeFailureNotice`와 나란히 두되
// 통합하지 않는다 -- 인자 형태가 달라(이쪽은 `stallThresholdMs`처럼
// 판정 세부값이 없다) 억지로 합치면 옵션 인자가 늘어나 오히려 "경우
// 나열"에 가까워진다(4R 지시서가 지목한 패턴).
//
// ★HYK-378 6R(REVIEW P1 반려 수리, 불변식 P "통지 실패가 결론을 바꾸면
// 안 된다") -- 5R까지는 이 함수가 `mkdirFn`/`writeFn` 실패를 전혀
// 처리하지 않았다. 검토자 실측: `notifyDir`를 파일로 만들어 두면
// (그 안에 하위 파일을 만들 수 없으므로) `mkdirFn`이 `ENOENT`로 던지고,
// 그 예외가 이 함수 밖으로 그대로 새 나가 `invokedDirectly` 블록의
// 나머지(=`process.exit(4)`)가 **아예 실행되지 않았다** -- Node가 처리
// 안 된 예외로 죽으면서 실측 `status:1`(기본 실패 종료 코드)이 됐다 --
// "잘못된 인자로 불렸다"는 결론(exit 4) 자체가 통지 실패라는 «부수
// 효과» 때문에 뒤집힌 것이다. ⇒ 이 함수는 이제 **절대 던지지 않는다**
// -- 성공/실패를 판정 객체로 돌려주고, 호출부가 원래의 `INVALID_ARGS`
// 결론과 무관하게 처리하게 한다(아래 `invokedDirectly` 블록).
function writeInvalidArgsNotice({
  result,
  taskId,
  notifyDir,
  nowFn,
  writeFn,
  mkdirFn,
  existsFn,
}) {
  try {
    if (!existsFn(notifyDir)) mkdirFn(notifyDir, { recursive: true });
    const nowMs = nowFn();
    const text = buildInvalidArgsNoticeText({
      taskId,
      nowMs,
      reasonCode: result.reasonCode,
    });
    const noticePath = path.join(
      notifyDir,
      buildInvalidArgsNoticeFileName(nowMs),
    );
    writeFn(noticePath, text, "utf8");
    return { ok: true, noticePath };
  } catch (err) {
    // ★6R -- 조용히 삼키지 않는다(불변식 P ⛔"조용히 삼키지 마라"): 실패
    // 사실 자체를 호출부에 돌려준다. 원본 스택은 여기서 버리고 사람이
    // 읽을 짧은 사유(`err.message`)만 담는다 -- stderr에 스택 트레이스
    // 대신 문장이 남아야 한다는 완료조건 1 요구 그대로.
    return {
      ok: false,
      detail: err && err.message ? err.message : String(err),
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ★HYK-280(coder-task.md §2 항3) -- "배달 시점" 크기를 기준선으로 심는다.
// 이 CLI의 첫 실관측(runDispatchStartConfirm 루프의 첫 collect())이 배달
// 순간보다 늦게 일어나면(항상 그렇다 -- 프로세스 기동 자체에 시간이
// 든다), 그 사이에 이미 커진 몫이 "언제 늘었는지" 정보 없이 그 첫
// 관측값 자체에 녹아 버려 이후로 더 안 늘면 NOT_STARTED로 오판한다(4R
// 알려진 한계 fixture가 고정했던 그 자리). 호출자(ps1)가 배달 순간에
// 잰 크기를 `baselineBytes`로 넘기면, 그 값을 `dispatchedAtMs` 시각의
// 관측으로 미리 심어 둔다 -- 그러면 그 뒤 첫 실관측이 이 값보다 크기만
// 해도 "증가"로 정상 인식된다. 안 넘기면(기존 호출부 그대로) 빈
// 배열을 돌려줘 기존 동작과 100% 동일(회귀 0).
function buildInitialObservations(dispatchedAtMs, baselineBytes) {
  if (!Number.isFinite(baselineBytes) || baselineBytes < 0) return [];
  return [
    { observedAtMs: dispatchedAtMs, totalBytes: Math.trunc(baselineBytes) },
  ];
}

// 코어가 낸 판정 하나를 이 CLI의 status로 옮긴다(judged.verdict === STARTED
// 지만 아직 전체 관측 창이 안 끝났으면 여기서 status를 정하지 않고 null을
// 돌려준다 -- 호출부가 계속 폴링한다).
function statusFromJudged(judged, nowMs, dispatchedAtMs, timeoutMs) {
  if (judged.verdict === DISPATCH_START_SIZE_VERDICT.STALLED_AFTER_START) {
    return DISPATCH_START_CONFIRM_STATUS.STALLED_AFTER_START;
  }
  if (judged.verdict === DISPATCH_START_SIZE_VERDICT.NOT_STARTED) {
    return DISPATCH_START_CONFIRM_STATUS.NOT_STARTED;
  }
  if (judged.verdict === DISPATCH_START_SIZE_VERDICT.STARTED) {
    const pastOverallTimeout = nowMs - dispatchedAtMs >= timeoutMs;
    return pastOverallTimeout ? DISPATCH_START_CONFIRM_STATUS.STARTED : null;
  }
  return null; // UNDECIDABLE -- 계속 폴링.
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// ★HYK-378 4R(REVIEW P1-1 반려 수리, 불변식 K "입력 관문") -- 생산
// 진입점(`runDispatchStartConfirm`)이 폴링 루프에 들어가기 «전에» 모든
// 수치 인자를 한 번에 검증한다. 코어의 `resolveAndValidateThresholds`를
// 그대로 재사용해(중복 구현 0) `timeoutMs`·`stallThresholdMs`·
// `sustainedGrowthBytes`·`stallGraceMultiplier`를 검증하고, 이 함수
// 스스로는 코어가 모르는 두 인자(`dispatchedAtMs`·`pollIntervalMs`)를
// 같은 자리에서 함께 검증한다 -- ★"경우를 나열"(4R 지시서 §1 원인
// 분류가 정확히 지목한 패턴)하지 않도록, 여섯 인자 전부가 이 한 함수
// 하나를 거치지 않고는 루프에 도달할 수 없다(생산 코드에 각 인자별
// `if (Number.isNaN(x))` 를 따로 흩어 심지 않는다).
function validateProductionArgs({
  dispatchedAtMs,
  timeoutMs,
  stallThresholdMs,
  pollIntervalMs,
  sustainedGrowthBytes,
  stallGraceMultiplier,
}) {
  if (!isFiniteNumber(dispatchedAtMs)) {
    return { ok: false, reasonCode: "DISPATCHED_AT_MS_INVALID" };
  }
  const pollInterval =
    pollIntervalMs === undefined || pollIntervalMs === null
      ? 15000
      : pollIntervalMs;
  if (!isFiniteNumber(pollInterval) || pollInterval <= 0) {
    return { ok: false, reasonCode: "POLL_INTERVAL_MS_INVALID" };
  }
  const resolved = resolveAndValidateThresholds({
    timeoutMs,
    stallThresholdMs,
    sustainedGrowthBytes,
    stallGraceMultiplier,
  });
  if (!resolved.ok) return resolved;
  return { ok: true, ...resolved, pollIntervalMs: pollInterval };
}

// pollOnce(...) -- 폴링 한 회차(관측 1회 + 판정)를 수행한다
// (runDispatchStartConfirm에서 분리 -- eslint 함수 길이·complexity 상한
// 준수, 로직은 그대로). `terminal`이 있으면 루프가 그 자리에서 끝나야
// 한다는 뜻, 없으면 계속 폴링. `excludedSymlinkCount`는 이번 회차에
// 관측된 값(불변식 M) -- `null`이면 이번 회차엔 배제가 없었다는 뜻이라
// 호출부가 이전 값을 그대로 유지한다.
function pollOnce({ collect, observations, dispatchedAtMs, nowMs, validated }) {
  const snap = collect();
  if (!snap.ok) {
    return {
      terminal: {
        status: DISPATCH_START_CONFIRM_STATUS.COLLECTION_FAILED,
        reasonCode: snap.reasonCode,
        detail: snap.detail,
      },
      excludedSymlinkCount: null,
    };
  }
  let excludedSymlinkCount = null;
  if (
    isFiniteNumber(snap.excludedSymlinkCount) &&
    snap.excludedSymlinkCount > 0
  ) {
    excludedSymlinkCount = snap.excludedSymlinkCount;
    // ★M -- 로그 소비(완료조건 3 "결과·통지·로그 중 하나 이상"의 로그 축).
    console.error(
      `dispatch-start-confirm: excludedSymlinkCount=${snap.excludedSymlinkCount} (신뢰 경계 밖 링크/junction 배제 -- 세션 폴더 구조를 확인하십시오)`,
    );
  }
  observations.push({ observedAtMs: nowMs, totalBytes: snap.totalBytes });

  const judged = judgeDispatchStartBySize({
    observations,
    dispatchedAtMs,
    now: nowMs,
    timeoutMs: validated.timeoutMs,
    stallThresholdMs: validated.stallThresholdMs,
    sustainedGrowthBytes: validated.sustainedGrowthBytes,
    stallGraceMultiplier: validated.stallGraceMultiplier,
  });
  const status = statusFromJudged(
    judged,
    nowMs,
    dispatchedAtMs,
    validated.timeoutMs,
  );
  if (status === null) return { terminal: null, excludedSymlinkCount };
  return {
    terminal: {
      status,
      reasonCode: judged.reasonCode,
      details: judged.details,
    },
    excludedSymlinkCount,
  };
}

// pollUntilTerminal(...) -- 검증을 통과한 뒤의 실제 폴링 루프(runDispatchStartConfirm
// 에서 분리 -- eslint complexity 상한 준수, 로직은 그대로). ★HYK-378
// 4R(불변식 M) -- 배제 신호(excludedSymlinkCount)의 마지막 관측값을
// 최종 결과에 실어 보낸다(3R까지는 아무도 안 읽었다).
async function pollUntilTerminal({
  collect,
  observations,
  dispatchedAtMs,
  validated,
  now,
  sleepFn,
}) {
  let lastExcludedSymlinkCount = 0;
  for (;;) {
    const nowMs = now();
    const { terminal, excludedSymlinkCount } = pollOnce({
      collect,
      observations,
      dispatchedAtMs,
      nowMs,
      validated,
    });
    if (excludedSymlinkCount !== null) {
      lastExcludedSymlinkCount = excludedSymlinkCount;
    }
    if (terminal !== null) {
      return {
        ...terminal,
        observations,
        excludedSymlinkCount: lastExcludedSymlinkCount,
      };
    }
    // 아직 확정 안 됨(UNDECIDABLE, 또는 STARTED지만 전체 관측 창이 안
    // 끝남) -- 계속 폴링한다. ★2R 결함이 정확히 이 지점이었다: "STARTED
    // 처음 보이면 즉시 반환"했었다. ★4R: 여기 도달했다는 것 자체가
    // `validated`를 이미 통과했다는 뜻이라 `stallThresholdMs=NaN`류
    // 인자로는 이 루프에 절대 들어오지 않는다(불변식 K).
    await sleepFn(validated.pollIntervalMs);
  }
}

// runDispatchStartConfirm(...) -- 폴링 루프 본체. 전부 주입 가능(시험은
// sleepFn을 즉시 반환하는 가짜로 넘겨 실제로 기다리지 않는다).
export async function runDispatchStartConfirm({
  repoRoot,
  dispatchedAtMs,
  claudeHomeDir = defaultClaudeHomeDir(),
  baselineBytes = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
  pollIntervalMs = 15000,
  sustainedGrowthBytes,
  stallGraceMultiplier,
  now = Date.now,
  sleepFn = sleep,
  readdirFn = readdirSync,
  statFn,
  lstatFn,
  collectFn,
}) {
  // ★불변식 K -- 루프 진입 전에 딱 한 번, 전부 함께 검증한다.
  const validated = validateProductionArgs({
    dispatchedAtMs,
    timeoutMs,
    stallThresholdMs,
    pollIntervalMs,
    sustainedGrowthBytes,
    stallGraceMultiplier,
  });
  if (!validated.ok) {
    return {
      status: DISPATCH_START_CONFIRM_STATUS.INVALID_ARGS,
      reasonCode: validated.reasonCode,
      observations: [],
    };
  }

  const collect = () =>
    (collectFn ?? collectTotalSessionBytes)(
      { repoRoot, claudeHomeDir },
      { readdirFn, statFn, lstatFn },
    );

  const observations = buildInitialObservations(dispatchedAtMs, baselineBytes);
  return pollUntilTerminal({
    collect,
    observations,
    dispatchedAtMs,
    validated,
    now,
    sleepFn,
  });
}

function writeFailureNotice({
  result,
  taskId,
  dispatchedAtMs,
  stallThresholdMs,
  notifyDir,
  nowFn,
  writeFn,
  mkdirFn,
  existsFn,
}) {
  if (!existsFn(notifyDir)) mkdirFn(notifyDir, { recursive: true });
  const nowMs = nowFn();
  const text =
    result.status === DISPATCH_START_CONFIRM_STATUS.NOT_STARTED
      ? buildNotStartedNoticeText({
          taskId,
          dispatchedAtMs,
          nowMs,
          observationCount: result.observations.length,
        })
      : buildStalledAfterStartNoticeText({
          taskId,
          dispatchedAtMs,
          nowMs,
          lastGrowthAtMs: result.details?.lastGrowthAtMs ?? null,
          stallThresholdMs,
        });
  const noticePath = path.join(notifyDir, buildNoticeFileName(nowMs));
  writeFn(noticePath, text, "utf8");
  return noticePath;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/dispatch-start-confirm-cli.mjs");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  let repoRoot = null;
  let dispatchedAtMs = null;
  let notifyDir = null;
  let taskId = null;
  let claudeHomeDir = undefined; // undefined -> runDispatchStartConfirm이 기존 기본값(os.homedir()/.claude) 그대로 씀(회귀 0).
  let baselineBytes = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS;
  let pollIntervalMs = 15000;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo-root") repoRoot = argv[++i];
    else if (argv[i] === "--dispatched-at-ms")
      dispatchedAtMs = Number(argv[++i]);
    else if (argv[i] === "--notify-dir") notifyDir = argv[++i];
    else if (argv[i] === "--task-id") taskId = argv[++i];
    // ★HYK-280(coder-task.md §2 항1) -- "어떤 폴더의 세션 기록을 볼지"를
    // 호출자가 정한다. 이름은 ORCH가 §1b_exec_line에 제시한 그대로
    // `--claude-home`을 쓰되, 값은 순수 폴더 경로라 claude·codex 어느
    // 좌석의 기록 폴더든 그대로 넘기면 된다(코드는 엔진 이름을 전혀 모른다
    // -- §2 항4 "엔진 이름 분기 0").
    else if (argv[i] === "--claude-home") claudeHomeDir = argv[++i];
    // ★HYK-280(coder-task.md §2 항3) -- 배달 시점에 호출자가 이미 재 둔
    // 세션 기록 총 바이트 수. 안 넘기면 기준선을 심지 않는다(기존 동작
    // 그대로, 회귀 0).
    else if (argv[i] === "--baseline-bytes") baselineBytes = Number(argv[++i]);
    else if (argv[i] === "--timeout-ms") timeoutMs = Number(argv[++i]);
    else if (argv[i] === "--stall-threshold-ms")
      stallThresholdMs = Number(argv[++i]);
    else if (argv[i] === "--poll-interval-ms")
      pollIntervalMs = Number(argv[++i]);
    // --watch-dir accepted for future use/parity but not required by this
    // CLI today (notice writing only needs notifyDir); reserved so ps1's
    // one-liner can pass the same argument set it already threads to the
    // other supervisor CLIs without this one erroring on an unknown flag.
    else if (argv[i] === "--watch-dir") i++; // 예약(수용만) -- 아래 헤더 주석 참조.
  }
  if (!repoRoot || !Number.isFinite(dispatchedAtMs) || !notifyDir) {
    console.error(
      "usage: dispatch-start-confirm-cli.mjs --repo-root <path> --dispatched-at-ms <epoch-ms> --notify-dir <path> [--task-id <id>] [--claude-home <path>] [--baseline-bytes <n>] [--timeout-ms <n>] [--stall-threshold-ms <n>] [--poll-interval-ms <n>]",
    );
    process.exit(2);
  }
  const result = await runDispatchStartConfirm({
    repoRoot,
    dispatchedAtMs,
    ...(claudeHomeDir !== undefined ? { claudeHomeDir } : {}),
    baselineBytes,
    timeoutMs,
    stallThresholdMs,
    pollIntervalMs,
  });
  if (result.status === DISPATCH_START_CONFIRM_STATUS.STARTED) {
    console.log(`dispatch-start-confirm: STARTED (${result.reasonCode})`);
    process.exit(DISPATCH_START_CONFIRM_EXIT_CODE[result.status]);
  }
  // ★4R(불변식 K) -- 잘못된 수치 인자는 폴링을 단 한 번도 시작하지 않고
  // 여기서 스스로, 시끄럽게 끝난다(강제 종료가 아니라 정상적인 return
  // 경로). ★5R(REVIEW P1-2 저장소 쪽 절반, 불변식 O) -- 4R까지는 stderr
  // 한 줄뿐이라 호출부가 그 줄을 안 읽으면(검토자 실측: 관제실
  // dispatch-worker.ps1의 fail-open) 신호가 통째로 유실됐다. stderr는
  // 그대로 두고(휘발성 로그로도 여전히 유용), **저장소 안에서 관측
  // 가능한 산출물**(notifyDir의 별도 종류 통지 파일)을 추가로 남긴다 --
  // "좌석이 멈췄다"는 신호와 파일명부터 다르다(위 buildInvalidArgsNoticeFileName
  // 헤더 주석 참조).
  if (result.status === DISPATCH_START_CONFIRM_STATUS.INVALID_ARGS) {
    // ★6R(불변식 P) -- 통지 시도 자체가 실패해도(예: notifyDir가 파일)
    // 그 실패는 여기서 조용히 삼키거나 예외로 새 나가게 두지 않는다 --
    // `writeInvalidArgsNotice`는 이제 절대 던지지 않으므로(위 헤더 주석)
    // 아래 exit(4)는 통지 성공/실패와 무관하게 **항상** 실행된다.
    const notice = writeInvalidArgsNotice({
      result,
      taskId,
      notifyDir,
      nowFn: Date.now,
      writeFn: writeFileSync,
      mkdirFn: mkdirSync,
      existsFn: existsSync,
    });
    const reasonLine = `dispatch-start-confirm: INVALID_ARGS(${result.reasonCode}) -- 수치 인자를 확인하십시오(NaN·Infinity·범위 밖 값 등). 폴링을 시작하지 않았습니다.`;
    if (notice.ok) {
      console.error(`${reasonLine} notice=${notice.noticePath}`);
    } else {
      // ★6R -- 통지 실패 «자체»도 사람이 읽을 문장으로 남긴다(스택
      // 트레이스가 아니라, 검토자가 지적한 "ENOENT 스택만 남았다"의
      // 정확한 반례). 원래 결론(잘못된 인자·exit 4)은 안 바뀐다.
      console.error(reasonLine);
      console.error(
        `dispatch-start-confirm: 통지 파일을 남기지 못했습니다(${notice.detail}) -- notifyDir을 확인하십시오. 이 실행 자체의 결론(잘못된 인자, exit 4)은 바뀌지 않습니다.`,
      );
    }
    process.exit(DISPATCH_START_CONFIRM_EXIT_CODE[result.status]);
  }
  if (
    result.status === DISPATCH_START_CONFIRM_STATUS.NOT_STARTED ||
    result.status === DISPATCH_START_CONFIRM_STATUS.STALLED_AFTER_START
  ) {
    const noticePath = writeFailureNotice({
      result,
      taskId,
      dispatchedAtMs,
      stallThresholdMs,
      notifyDir,
      nowFn: Date.now,
      writeFn: writeFileSync,
      mkdirFn: mkdirSync,
      existsFn: existsSync,
    });
    const humanLabel =
      result.status === DISPATCH_START_CONFIRM_STATUS.NOT_STARTED
        ? "NOT_STARTED(아예 시작 못 함 -- 재배달 필요)"
        : "STALLED_AFTER_START(시작 후 멈춤 -- 좌석 확인 필요)";
    console.error(
      `dispatch-start-confirm: ${humanLabel} -- ${taskId || "(task)"}. notice=${noticePath}`,
    );
    process.exit(DISPATCH_START_CONFIRM_EXIT_CODE[result.status]);
  }
  console.error(
    `dispatch-start-confirm: COLLECTION_FAILED (${result.reasonCode}) -- ${result.detail}`,
  );
  process.exit(DISPATCH_START_CONFIRM_EXIT_CODE[result.status]);
}
