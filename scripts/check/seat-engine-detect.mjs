// HYK-472 (coder-task.md §2 -- 배달기가 엔진을 «역할」이 아니라 «좌석 실측」으로
// 정하게 한다). 판단은 여기(저장소 CLI) 몫이고, 관제실
// dispatch-worker.ps1은 이 CLI를 부르고 종료코드/출력으로만 분기하는 얇은
// 껍데기다(HYK-217/HYK-299 계열과 같은 관례).
//
// 계기(coder-task.md §1, ORCH-71 2026-09-16 실측): dispatch-worker.ps1이
// `$engine = if ($Role -eq "REVIEW" -or $Role -eq "PM") { "codex" } else
// { "claude" }`로 «역할」만 보고 엔진을 정했다. 2026-09-15 한용 확정으로
// REVIEW 좌석이 claude 엔진(orca-review-claude-seat.ps1 임시 래퍼)으로
// 뜨는데도 배달기는 여전히 REVIEW=codex로 믿어, ⑴ claude 좌석에 codex용
// 배달 경로(terminal send "go")를 태우고 ⑵ 착수 확인이 codex 세션 폴더를
// 관측해 실물은 정상 완주했는데도 NOT_STARTED(오탐)를 냈다(REVIEW 배달
// 4회 전부 재현).
//
// 이 모듈은 좌석이 실제로 화면에 찍은 배너 텍스트(orca terminal
// list/show의 preview 필드)에서 엔진 고유 마커를 찾는다 -- 역할이 무엇을
// "기대"하는지는 보지 않는다. 마커가 모호하거나(둘 다 매치·둘 다 없음)
// 아직 아무것도 안 찍힌 갓 생긴 좌석이면 엔진을 고르지 않고 거부한다(HYK-472
// 2R: 옛 역할-추정 폴백을 걷어냈다 -- 역할로 추측하면 claude 좌석에 codex
// 배달 경로가 태워지는 사고가 그대로 난다). 거부는 CLI 종료코드 2(기존 실패
// 코드)로 나오며, 배달기(관제실 dispatch-worker.ps1)는 그 비0을 fail-closed로
// 받는다. 기다림은 배달기 쪽 짧은 재시도가 맡는다(패치 문서 참고).

import { readFileSync } from "node:fs";

// 배너 마커는 실제 CLI가 기동 직후 화면에 찍는, 서로 겹치지 않는 고유
// 문자열만 쓴다(코드 실측 -- 관제실 dispatch-worker.ps1:102의 기존
// Looks-Like-Agent 마커 집합 중 엔진 고유분만 골랐다. `weekly \d`·
// `[CODER]`/`[REVIEW]`는 두 엔진 모두에서 나올 수 있어 제외 -- "에이전트인가"
// 판정과 "어느 엔진인가" 판정은 서로 다른 질문이다).
//
// ★실측 수정(2026-09-16, 이 라운드 자신의 라이브 시험): "MCP startup"은
// 원래 claude 전용 마커로 가정했으나, 실제로 띄운 codex REVIEW 좌석의
// preview에도 "⚠ MCP startup incomplete (failed: linear-server)"가 그대로
// 찍혔다(codex도 MCP 서버를 로드하며 같은 문구를 쓴다) -- claude 전용이
// 아니었다. 넣어 뒀다면 codex 좌석을 claude로 오판정했을 것이다(양쪽
// 마커가 다 매치 -> unknown으로만 떨어지므로 실제 사고로 이어지진
// 않았겠지만, "고유 마커"라는 전제 자체가 거짓이었다). 제거.
export const CLAUDE_ENGINE_MARKERS = /Sonnet|Opus|Fable|bypass permissions/;
export const CODEX_ENGINE_MARKERS = /gpt-5\.6/;

export function detectSeatEngine(previewText) {
  const text = String(previewText ?? "");
  const isClaude = CLAUDE_ENGINE_MARKERS.test(text);
  const isCodex = CODEX_ENGINE_MARKERS.test(text);
  if (isClaude && !isCodex) return "claude";
  if (isCodex && !isClaude) return "codex";
  return "unknown";
}

export const UNKNOWN_SEAT_ENGINE_REASON = "UNKNOWN_SEAT_ENGINE";

// 실측이 claude/codex 로 나오면 role 과 달라도 실측을 따른다(HYK-472 1R 이
// 고친 사고 형태). 실측이 unknown 이면 엔진을 고르지 않는다 -- role 로 추측
// 하던 옛 폴백(role-fallback-ambiguous-preview)은 2R 에서 걷어냈다: 프로덕션
// 호출자가 없었고, 남겨 두면 다음 호출자가 조용히 다시 쓸 수 있는 문이었다.
export function resolveSeatEngine({ previewText, role }) {
  const measured = detectSeatEngine(previewText);
  if (measured === "unknown") {
    return {
      refused: true,
      reason: UNKNOWN_SEAT_ENGINE_REASON,
      measured,
      role: role ?? null,
      detail: describeUnknown(previewText, role),
    };
  }
  return {
    engine: measured,
    measured,
    source: "measured-preview",
    role: role ?? null,
  };
}

function describeUnknown(previewText, role) {
  const text = String(previewText ?? "");
  const kind =
    CLAUDE_ENGINE_MARKERS.test(text) && CODEX_ENGINE_MARKERS.test(text)
      ? "BOTH_ENGINE_MARKERS"
      : "NO_ENGINE_MARKER";
  return (
    `${kind} role=${role ?? "(none)"} preview_chars=${text.length} ` +
    "찾던 마커: claude[Sonnet|Opus|Fable|bypass permissions] / codex[gpt-5.6] -- " +
    "엔진을 추측하지 않고 거부한다"
  );
}

function parseArgs(argv) {
  const out = { previewFile: null, preview: null, role: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help") out.help = true;
    else if (a === "--preview-file") out.previewFile = argv[++i];
    else if (a === "--preview") out.preview = argv[++i];
    else if (a === "--role") out.role = argv[++i];
  }
  return out;
}

const USAGE =
  "Usage: node seat-engine-detect.mjs --role <Role> (--preview-file <path> | --preview <text>)\n" +
  "Prints JSON {engine, measured, source, role} on stdout, exit 0.\n" +
  "engine in {claude, codex}; source = measured-preview.\n" +
  "unknown measurement -> REFUSED: stderr 'FAILED reason=UNKNOWN_SEAT_ENGINE ...', exit 2 (no engine guessed).";

export function runSeatEngineDetectCli(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) return { ok: true, help: true };
  let previewText = parsed.preview;
  if (previewText === null && parsed.previewFile) {
    try {
      previewText = readFileSync(parsed.previewFile, "utf8");
    } catch (err) {
      return {
        ok: false,
        reason: "PREVIEW_FILE_UNREADABLE",
        detail: err.message,
      };
    }
  }
  const result = resolveSeatEngine({
    previewText: previewText ?? "",
    role: parsed.role,
  });
  if (result.refused) {
    return { ok: false, reason: result.reason, detail: result.detail };
  }
  return { ok: true, result };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/seat-engine-detect.mjs");
if (invokedDirectly) {
  const outcome = runSeatEngineDetectCli(process.argv.slice(2));
  if (outcome.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!outcome.ok) {
    console.error(
      `FAILED reason=${outcome.reason} detail=${outcome.detail ?? ""}`,
    );
    process.exit(2);
  }
  console.log(JSON.stringify(outcome.result));
  process.exit(0);
}
