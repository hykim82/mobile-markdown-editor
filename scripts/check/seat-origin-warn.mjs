// HYK-460 축 C (coder-task.md §C) -- 손으로 띄운 좌석(런처 미경유)에는
// seat-origin-registry.mjs(HYK-464)의 기동 등록이 없다. 지금까지는 그
// 사실을 "고아 후보 «보고»"(seat-orphan-detect.mjs)로만 사람이 나중에
// 볼 수 있었고, 배달기(dispatch-gate-decision.mjs)는 그 등록 여부를
// 전혀 보지 않은 채 정상 배달했다(09-10 ORCH-65 실사고).
//
// ⛔이 라운드의 범위 = «1단계»뿐(coder-task.md §C-3, 책임자 확정):
// 미등록 좌석 = «경고 + 배달 «진행»(로그만)». «거부»는 이 라운드가
// 하지 않는다 -- 별도 소라운드로 남긴다. 그래서 이 모듈은
// dispatch-gate-decision-core.mjs의 DISPATCH_GATE_STATE(ALLOW/REJECT_*)에
// 새 REJECT_* 상태를 추가하지 않는다 -- 판정 결과는 오직 {warn, reason,
// message} 하나뿐이고, 배달 허용/거부(`combined.allow`)에는 관여하지
// 않는다(호출부인 dispatch-gate-decision.mjs가 이 결과를 lines에만
// 얹고, allow 계산에서는 뺀다).
//
// 탈출구(coder-task.md §C-4, 책임자 확정 ⓐ): `.harness/seat-override.md`
// 파일에 «이유·좌석 handle·작성자» 세 항목(`reason:`/`handle:`/`author:`
// 독립 줄, 값 비지 않음)이 모두 있으면 경고를 내리지 않는다. 셋 중
// 하나라도 없으면(빈 파일 포함) 탈출구로 인정하지 않는다 -- "빈 파일로
// 우회 불가"(§C-5 비타협).
//
// 옆문 2문 검사(§C-4가 요구, HYK-460 검토 1R P2-3 수리로 문면 정정):
// ⑴감사에서 보이는가 = ⛔이전 문면은 «override 파일 자체가 git 워크트리
// 안 파일이라 커밋 이력에 남는다»였는데 이는 «거짓 근거»였다 -- 이
// 저장소 .gitignore:1이 `.harness/`를 통째로 무시하므로
// `.harness/seat-override.md`는 git 커밋 이력에 «전혀» 남지 않는다.
// ⇒ 지금은 이 파일 아래 resolveSeatOriginWarnLine(dispatch-gate-
// decision.mjs)가 OVERRIDE_VALID 판정 시에도(warn:false라 경고는 아니지만)
// 그 message를 배달 로그 줄(`lines`)에 실제로 남기도록 고쳐 «예»로
// 만들었다 -- 감사 축은 git 이력이 아니라 «배달 로그 한 줄»이다.
// (hyk460-seat-origin-warn.test.mjs의 결선 시험이 그 줄이 실제로
// 나오는지 값으로 확인한다.) ⑵ 없으면 정당 작업이 막히는가 = 예(런처가
// 죽으면 복구 좌석을 손으로 띄워야 하는데, 1단계는 "거부"가 아니라
// "경고"이므로 애초에 막히지도 않지만, 2단계(거부)가 열릴 때를 대비해
// 지금 판정 경로를 미리 검증해 둔다) -> 설계된 문.
//
// 위조 한계(coder-task.md §D, 책임자 확정 ⓑ, 그대로 옮김): 등록부는
// «append-only 감사 로그」이지 «인증」이 아니다. 사람이 JSONL에 한 줄
// 적으면 통과한다. -> 이 강제의 실효는 «실수 방지」이지 «악의 차단」이
// 아니다. 런처 서명은 범위 밖.
//
// 엔진 무관(§C-6): 이 축의 기반은 «런처(orca-worker-seat.ps1) + 배달기
// (dispatch-gate-decision.mjs)»다 -- 등록부는 런처가 쓰고 배달기가
// 읽는다. Claude 전용이 아니다(codex 좌석도 같은 런처를 지난다). 정직
// 한계: 런처를 «안 쓰면» 기록이 안 남는다는 것이 이 설계의 전제이자
// 약점이다 -- 런처 자체를 우회하는 경로는 이 축이 못 막는다. 막는 것은
// «그렇게 띄운 좌석이 «일감을 받는 것»»뿐(그마저 1단계는 경고뿐이다).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPaneRegistered } from "./seat-origin-registry.mjs";

export const SEAT_ORIGIN_WARN_REASON = Object.freeze({
  PANE_KEY_MISSING: "PANE_KEY_MISSING",
  REGISTERED: "REGISTERED",
  OVERRIDE_VALID: "OVERRIDE_VALID",
  UNREGISTERED_OVERRIDE_INVALID: "UNREGISTERED_OVERRIDE_INVALID",
  UNREGISTERED_NO_OVERRIDE: "UNREGISTERED_NO_OVERRIDE",
});

// 순수 판정(zero I/O) -- caller(아래 evaluateSeatOriginWarningForWorktree,
// 그리고 이 파일 밖의 dispatch-gate-decision.mjs)가 이미 읽어낸 사실만
// 받는다(S8과 같은 원칙). ★변이 RED 표적: 이 함수가 "warn"을 항상
// false로 되돌리면(예: `if (!paneKey) ...` 이후 무조건 `warn:false`)
// hyk460-seat-origin-warn.test.mjs의 미등록/override-무효 시험이 뒤집힌다.
export function evaluateSeatOriginWarning({
  paneKey,
  registered,
  overridePresent,
  overrideValid,
} = {}) {
  if (!paneKey) {
    return {
      warn: false,
      reason: SEAT_ORIGIN_WARN_REASON.PANE_KEY_MISSING,
      message:
        "seat-origin-warn: pane key 없음 -- 판정 불가(경고 생략, HYK-460 1단계는 경고만 다룬다)",
    };
  }
  if (registered === true) {
    return {
      warn: false,
      reason: SEAT_ORIGIN_WARN_REASON.REGISTERED,
      message: `seat-origin-warn: pane=${paneKey} 등록부에 있음 -- 경고 없음`,
    };
  }
  if (overridePresent === true && overrideValid === true) {
    return {
      warn: false,
      reason: SEAT_ORIGIN_WARN_REASON.OVERRIDE_VALID,
      message: `seat-origin-warn: pane=${paneKey} 등록부에 없으나 .harness/seat-override.md(필수 3항목 충족)가 있어 경고 생략(HYK-460 §C-4 설계된 문)`,
    };
  }
  if (overridePresent === true && overrideValid !== true) {
    return {
      warn: true,
      reason: SEAT_ORIGIN_WARN_REASON.UNREGISTERED_OVERRIDE_INVALID,
      message: `seat-origin-warn: WARN -- pane=${paneKey} 등록부에 없고 .harness/seat-override.md는 있으나 필수 3항목(reason/handle/author)을 갖추지 못해 탈출구로 인정하지 않음(HYK-460 1단계 -- 배달은 그대로 진행, 거부 아님)`,
    };
  }
  return {
    warn: true,
    reason: SEAT_ORIGIN_WARN_REASON.UNREGISTERED_NO_OVERRIDE,
    message: `seat-origin-warn: WARN -- pane=${paneKey} 등록부에 없음(런처 미경유 가능성, HYK-460 1단계 -- 배달은 그대로 진행, 거부 아님). 탈출구: .harness/seat-override.md에 reason:/handle:/author: 세 줄을 채워라`,
  };
}

const OVERRIDE_REASON_RE = /^reason:\s*(\S.*)$/im;
const OVERRIDE_HANDLE_RE = /^handle:\s*(\S.*)$/im;
const OVERRIDE_AUTHOR_RE = /^author:\s*(\S.*)$/im;

// §C-5 비타협: 필수 3항목(이유·좌석 handle·작성자) 중 하나라도 없으면
// (빈 파일 포함) valid:false -- "빈 파일로 우회 불가".
export function readOverrideFacts(overridePath) {
  if (!existsSync(overridePath)) return { present: false, valid: false };
  let text;
  try {
    text = readFileSync(overridePath, "utf8");
  } catch {
    return { present: true, valid: false };
  }
  const valid =
    OVERRIDE_REASON_RE.test(text) &&
    OVERRIDE_HANDLE_RE.test(text) &&
    OVERRIDE_AUTHOR_RE.test(text);
  return { present: true, valid };
}

// 어댑터: 워크트리 + 등록부 경로 + pane key로부터 사실을 모아 순수 판정에
// 넘긴다(evaluateSeatOriginWarning 자체는 파일을 읽지 않는다).
// registryPath가 없으면(관제실이 아직 안 넘겼거나 로컬 실행) 등록부를
// "조회 불가"로 보되, fail-closed 방향(=경고 쪽)으로 접는다 -- registered
// 를 false로 취급한다(등록부가 없어서 "확인 못했다"를 "정상"으로 읽지
// 않는다, 이 저장소의 기존 관례와 동일).
export function evaluateSeatOriginWarningForWorktree({
  worktree,
  registryPath,
  paneKey,
}) {
  const overridePath = join(worktree, ".harness", "seat-override.md");
  const overrideFacts = readOverrideFacts(overridePath);
  const registered =
    registryPath && existsSync(registryPath)
      ? isPaneRegistered(registryPath, paneKey)
      : false;
  return evaluateSeatOriginWarning({
    paneKey,
    registered,
    overridePresent: overrideFacts.present,
    overrideValid: overrideFacts.valid,
  });
}

function parseArgs(argv) {
  const out = { worktree: null, registryPath: null, paneKey: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--worktree") out.worktree = argv[++i];
    else if (a === "--registry-path") out.registryPath = argv[++i];
    else if (a === "--pane-key") out.paneKey = argv[++i];
  }
  return out;
}

const USAGE =
  "Usage: node seat-origin-warn.mjs --worktree <path> --registry-path <path> --pane-key <key>\n" +
  "Prints a WARN line (exit 0 always -- HYK-460 1단계는 경고만, 거부하지 않는다) when\n" +
  "the pane key has no seat-origin-registry.mjs record and no valid .harness/seat-override.md escape hatch.";

export function runSeatOriginWarnCli(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.worktree) return { ok: false, reason: "MISSING_WORKTREE" };
  const outcome = evaluateSeatOriginWarningForWorktree(parsed);
  return { ok: true, outcome };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/seat-origin-warn.mjs");
if (invokedDirectly) {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }
  const result = runSeatOriginWarnCli(process.argv.slice(2));
  if (!result.ok) {
    console.error(`FAILED reason=${result.reason}`);
    process.exit(2);
  }
  console.log(result.outcome.message);
  process.exit(0); // ⛔항상 0 -- 이 CLI는 절대 배달을 거부하지 않는다(1단계).
}
