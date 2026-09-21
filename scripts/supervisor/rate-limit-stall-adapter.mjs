// HYK-270 (coder-task.md §2, §5) -- 한도(rate limit) 도달/회복 관측을
// "화면 밖" 근거에서 모은다.
//
// ★선행 조사(coder-task.md §2) 결론 -- 이 헤더에 그대로 옮긴다:
// - `orca terminal read`가 돌려주는 화면 스냅샷이 실제 좌석 상태보다
//   늦게 갱신될 수 있다는 것은 ORCH가 오늘(2026-08-16) 실측으로 겪었다
//   (coder-task.md §2-2 원문 그대로 -- Ctrl+U/Esc/백스페이스 40개를
//   보내도 화면이 그대로였다가, 글자 하나(`z`)를 보내야 비로소 실제
//   상태로 갱신됐다). ★이 조각 자신은 그 지연을 "몇 초"인지 별도로
//   재현하지 않았다(재현하려면 실제로 좌석 입력줄에 잔류 텍스트가 있는
//   상황을 만들어야 하는데, 그 자체가 §2-3 "탐침을 상시 수단으로 쓰지
//   말라"는 제약과 부딪힌다) -- ★그래서 "얼마나 늦는지"는 **못
//   규명했다**로 남긴다. "화면은 신뢰할 수 없다"는 정성적 결론만 확정.
// - 세션 로그(`~/.claude/projects/**/*.jsonl`)를 조사한 결과, 이 저장소
//   워크트리 자신의 세션 로그에 `isApiErrorMessage:true` +
//   `apiErrorStatus:429`인 항목이 실제로 존재한다(실측, 2026-08-16
//   조사 -- 이 파일이 그 발견을 코드로 옮긴 것). 이 필드는 화면 문자열이
//   아니라 Claude Code 자신이 세션 로그에 구조적으로 남기는 필드다 --
//   §2-3 "화면 밖 근거 중에서도 «아예 시작 못 한 경우»를 잡는 것을
//   골라라"는 이번 축(한도 정지)에는 다르게 적용된다: 한도 정지는
//   "시작 못 함"이 아니라 "진행하다 멈춤"이므로, 여기서는 "관측 자체가
//   화면이 아닌 구조화된 로그에서 나오는가"를 기준으로 골랐다.
// - ⚠️단 이 로그에는 "회복 예정 시각"(resets_at류) 필드가 없다 -- 429
//   응답 바디에 그런 필드가 실려 있지 않다(실측). 그래서 회복 시각은
//   추정값(rate-limit-stall-core.mjs의 `estimatedRecoveryAtMs`)일 수밖에
//   없고, "실제 회복"은 같은 로그에서 **그 시각 이후 정상 활동이
//   다시 관측되는 것**으로 판정한다(이 파일의 `recoveredAtMs`) -- 이
//   부분은 화면이 아니라 여전히 세션 로그다.
//
// 비타협: 부작용 0(읽기 전용) -- 이 파일은 세션 로그를 읽기만 한다.
// 쓰기·네트워크·orca 호출 0.
import path from "node:path";

// Claude Code가 워크트리 경로를 세션 로그 디렉터리 이름으로 접는 관례
// (실측, ~/.claude/projects/ 아래 실재 디렉터리 이름과 대조 확인):
// 경로 구분자(`\`,`/`)와 `:`를 각각 `-` 한 글자로 치환한다(병합 없음).
export function deriveClaudeProjectDirName(absRepoRoot) {
  return String(absRepoRoot).replace(/[\\/:]/g, "-");
}

const RATE_LIMIT_HIT_REASON = Object.freeze({
  DIR_LIST_FAILED: "RATE_LIMIT_DIR_LIST_FAILED",
  FILE_READ_FAILED: "RATE_LIMIT_FILE_READ_FAILED",
});

function parseJsonlLines(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // 손상된 줄 1개는 건너뛴다(로그 파일은 append-only이고 마지막 줄이
      // 쓰다 만 상태일 수 있다 -- 그 한 줄 때문에 전체 파일을 못 읽은
      // 것으로 접지 않는다. 판독 자체가 던지는 예외는 아래 catch가 잡는다).
    }
  }
  return entries;
}

function isRateLimitHitEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    entry.isApiErrorMessage === true &&
    entry.apiErrorStatus === 429
  );
}

// ★P1 수리(2026-08-16, 검토자 실측 반려 -- coder-task.md §2 그대로):
// 이전 버전은 `isApiErrorMessage !== true`인 timestamp 보유 항목을 전부
// "정상 활동"으로 쳤다. `type:"user"`(사용자 입력·tool_result 제출 포함)
// 항목도 이 조건을 만족하므로, 429 한 건 뒤 사용자 입력만 있어도
// `recoveredAtMs`가 채워져 STALLED 통지가 조용히 억제됐다 -- 사용자
// 입력은 모델이 실제로 응답했다는 증거가 아니다.
//
// 실측(세션 jsonl 다건 대조, 표본 12,360여 건, 예외 0건): **진짜 성공
// 응답**은 top-level `type === "assistant"` +
// `message.model`이 `"<synthetic>"`이 아닌 실제 모델명 +
// `message.usage.output_tokens > 0`이다. 429/합성 메시지(errorEntry
// 포함)는 항상 `model:"<synthetic>"`이고 `output_tokens`는 항상 0이다
// (전수 조사에서 예외 0건 -- coder-task.md §2 "회복" 정의를 이 실측으로
// 좁힌다). ⚠️이 실측이 못 미치는 형태(예: 신모델·신API 응답 스키마
// 변경)를 만나면 fail-closed로 "회복 아님"에 접힌다(§2 요구사항 그대로
// -- 놓치는 것보다 과대검출이 낫다, 이 파일의 기존 관례와 동일).
function isSuccessResponseEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.type !== "assistant") return false;
  if (typeof entry.timestamp !== "string") return false;
  if (entry.isApiErrorMessage === true) return false;
  const message = entry.message;
  if (!message || typeof message !== "object") return false;
  if (typeof message.model !== "string" || message.model === "<synthetic>") {
    return false;
  }
  const outputTokens = message.usage ? message.usage.output_tokens : undefined;
  return typeof outputTokens === "number" && outputTokens > 0;
}

function entryTimeMs(entry) {
  if (!entry || typeof entry.timestamp !== "string") return null;
  const t = Date.parse(entry.timestamp);
  return Number.isNaN(t) ? null : t;
}

function listJsonlFiles(readdirFn, projectDir) {
  try {
    return {
      ok: true,
      fileNames: readdirFn(projectDir).filter((n) => n.endsWith(".jsonl")),
    };
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true, fileNames: null };
    return {
      ok: false,
      reasonCode: RATE_LIMIT_HIT_REASON.DIR_LIST_FAILED,
      detail: err && err.message ? err.message : String(err),
    };
  }
}

// 항목 하나가 누산기(acc = {hitAtMs, latestNormalAfterHitMs})에 미치는
// 영향만 계산한다(collectRateLimitObservation에서 분리 -- eslint
// complexity 상한 준수, 로직은 그대로).
function foldEntryIntoAcc(acc, entry, now) {
  const t = entryTimeMs(entry);
  if (t === null || t > now) return; // 미래 시각은 무시(시계 이상 방어).
  if (isRateLimitHitEntry(entry)) {
    if (acc.hitAtMs === null || t > acc.hitAtMs) acc.hitAtMs = t;
  } else if (isSuccessResponseEntry(entry)) {
    if (acc.latestNormalAfterHitMs === null || t > acc.latestNormalAfterHitMs) {
      acc.latestNormalAfterHitMs = t;
    }
  }
}

function scanFileIntoAcc({ readFileFn, filePath, now, acc }) {
  let text;
  try {
    text = readFileFn(filePath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reasonCode: RATE_LIMIT_HIT_REASON.FILE_READ_FAILED,
      detail: err && err.message ? err.message : String(err),
    };
  }
  for (const entry of parseJsonlLines(text)) foldEntryIntoAcc(acc, entry, now);
  return { ok: true };
}

// collectRateLimitObservation({repoRoot, now, claudeHomeDir}, {readdirFn,
// readFileFn}) -> {ok, observation} | {ok:false, reasonCode, detail}
//
// - `repoRoot` -- 이 저장소(워크트리)의 절대 경로.
// - `claudeHomeDir` -- `~/.claude` 상당 경로(시험은 mkdtemp로 주입).
// - 세션 로그 디렉터리 자체가 없으면(아직 이 워크트리에서 세션이 시작된
//   적 없음) 정상적으로 "흔적 없음"(hitAtMs:null)이다 -- 결손이 아니다.
export function collectRateLimitObservation(
  { repoRoot, now, claudeHomeDir },
  { readdirFn, readFileFn },
) {
  const projectDirName = deriveClaudeProjectDirName(repoRoot);
  const projectDir = path.join(claudeHomeDir, "projects", projectDirName);

  const listed = listJsonlFiles(readdirFn, projectDir);
  if (!listed.ok) return listed;
  if (listed.fileNames === null) {
    return { ok: true, observation: { hitAtMs: null, recoveredAtMs: null } };
  }

  const acc = { hitAtMs: null, latestNormalAfterHitMs: null };
  for (const name of listed.fileNames) {
    const scanned = scanFileIntoAcc({
      readFileFn,
      filePath: path.join(projectDir, name),
      now,
      acc,
    });
    if (!scanned.ok) return scanned;
  }

  if (acc.hitAtMs === null) {
    return { ok: true, observation: { hitAtMs: null, recoveredAtMs: null } };
  }
  const recoveredAtMs =
    acc.latestNormalAfterHitMs !== null &&
    acc.latestNormalAfterHitMs > acc.hitAtMs
      ? acc.latestNormalAfterHitMs
      : null;
  return { ok: true, observation: { hitAtMs: acc.hitAtMs, recoveredAtMs } };
}

export { RATE_LIMIT_HIT_REASON };
