// HYK-171 사이클4b-2c (coder-task.md §2-A) -- `orca terminal show --json` 원시
// 응답을 배정 결속 좌석 증명(dispatch-bound seat proof, dispatch-bound-seat-
// proof.mjs)이 받아들이는 정규화 입력으로 만드는 어댑터.
//
// fail-closed: 성공 조건 전부를 만족할 때만 ok:true. §1 실측(N1/N2/N3)에
// 따르면 stale handle(직전 handle) / 형식은 맞지만 존재하지 않는 handle /
// handle 형식조차 아닌 문자열 -- 이 세 가지 서로 다른 실패가 벤더 응답에서
// 전부 같은 오류 코드(`terminal_handle_stale`)로 나온다. 이 어댑터는 그
// 구별 불가능을 있는 그대로 접는다(단일 사유 코드) -- 응답 자체에 구별
// 근거가 없는데 세 갈래로 나누면 근거 없는 분류가 된다.
//
// 금지(coder-task.md §2-A):
// - `title`/`preview`를 읽지도 반환하지도 않는다(게이트 S8 -- 화면 문자열
//   의존 금지).
// - `paneRuntimeId`/`rendererGraphEpoch`를 식별자로 쓰지 않는다(실측 값이
//   각각 -1/0이라 신원 판정에 부적합하다고 §1이 명시).
// - 결손 필드에 키 자체를 만들지 않는다(`{...x, y: undefined}` 우회 금지).
//
// S6 경계: 이 파일은 raw JSON을 파싱하는 유일한 층이다. `orca` 명령을
// spawn하지 않는다(호출자가 이미 얻은 응답 객체만 받는다).

export const TERMINAL_SHOW_REASON = Object.freeze({
  NOT_OK: "NOT_OK",
  NO_TERMINAL_ENVELOPE: "NO_TERMINAL_ENVELOPE",
  FIELDS_INCOMPLETE: "FIELDS_INCOMPLETE",
  // §1 "`terminal list`를 신원 근거로 쓰지 말 것" 실측 근거: list의 폴백
  // 형태("pty:<worktreeId>@@<hash>", tabId===leafId)가 show 응답 자리에
  // 들어와도 여기서 거부된다.
  FALLBACK_FORM: "FALLBACK_FORM",
  VALID: "VALID",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// 배정 결속 좌석 증명 판정에 필요한 최소 필드만 옮긴다. `title`/`preview`는
// 여기 목록에 없다(S8) -- 결과 객체에 절대 나타나지 않는다.
const REQUIRED_FIELDS = [
  "handle",
  "ptyId",
  "worktreeId",
  "worktreePath",
  "tabId",
  "leafId",
];

// dispatch-correlation-adapter.mjs의 isUnadoptedFallbackForm과 판정 근거가
// 같다(§1 실측: 미채택 좌석의 `list` 폴백 composite 형태). 이 어댑터가
// 그 파일을 import해 결합을 만들지 않도록 순수 재선언한다 -- 로직이 두 줄뿐
// 이라 복제 비용보다 결합 회피 이득이 크다.
function isFallbackForm(v) {
  return v.startsWith("pty:") || v.includes("@@");
}

export function normalizeTerminalShow(rawResponse) {
  const raw = isPlainObject(rawResponse) ? rawResponse : {};

  // 비타협: 최상위 ok를 그대로 넘기지 않는다. ok!==true는 N1/N2/N3
  // (stale/없음/형식오류) 전부를 포함해 단일 사유 코드로 접는다.
  if (raw.ok !== true) {
    return { ok: false, reasonCode: TERMINAL_SHOW_REASON.NOT_OK };
  }

  const terminal =
    isPlainObject(raw.result) && isPlainObject(raw.result.terminal)
      ? raw.result.terminal
      : null;

  // `terminal list` 응답은 result.terminals(복수, 배열)이거나 행 자체가
  // 평평한 구조다 -- result.terminal(단수, 객체)이 아니므로 구조 자체가
  // 달라 여기서 자연히 걸린다(위장 불가, N-g).
  if (terminal === null) {
    return {
      ok: false,
      reasonCode: TERMINAL_SHOW_REASON.NO_TERMINAL_ENVELOPE,
    };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!isNonEmptyString(terminal[field])) {
      return {
        ok: false,
        reasonCode: TERMINAL_SHOW_REASON.FIELDS_INCOMPLETE,
      };
    }
  }

  const { handle, ptyId, worktreeId, worktreePath, tabId, leafId } = terminal;

  // §2-A 비타협: tabId !== leafId 그리고 둘 다 list 폴백 형태가 아니어야
  // 한다 -- 하나라도 걸리면 신원 판정 입력으로 쓰지 않는다.
  if (tabId === leafId || isFallbackForm(tabId) || isFallbackForm(leafId)) {
    return { ok: false, reasonCode: TERMINAL_SHOW_REASON.FALLBACK_FORM };
  }

  return {
    ok: true,
    handle,
    ptyId,
    worktreeId,
    worktreePath,
    tabId,
    leafId,
    paneKeyFromShow: `${tabId}:${leafId}`,
    reasonCode: TERMINAL_SHOW_REASON.VALID,
  };
}
