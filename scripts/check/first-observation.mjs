// HYK-257-done-stamp-2 §2 범위1 -- «첫 관측 기록» 채널.
//
// 문제(반려 사유 원문): checkRelayHandshake(relay-handshake.mjs)는 결과
// 파일을 딱 한 번, 판정 시점에만 readFileSync로 읽는다. 워커가 나쁜 DONE
// 값을 먼저 쓰고, 기계가 그것을 읽기 «전에» 좋은 값으로 고쳐 써도, 판정은
// 항상 최종본만 본다 -- 몇 번을 다시 실행해도 read-once 함수는 최종본만
// 본다. 검토자 반례: 이 경합은 «소비 직전 첫 읽기의 지문과 DONE 표지를
// 먼저 남기고 최종본과 대조»하는 좁은 경로로 닫을 수 있다(RACE_PROBE
// intermediate_observable=true).
//
// 이 채널이 실제로 닫는 것: scripts/relay/watch-result.mjs의 watchResult
// 폴링 루프가 checkFn(기본값 checkRelayHandshake)을 «완료로 판정될 때까지
// 매 interval마다 반복 호출»한다(watch-result.mjs:230-275, 즉시 1회 +
// 이후 sleep마다 재호출) -- 이것이 «최종 판정보다 먼저, 더 자주 불리는»
// 실재 프로덕션 호출자다.
//
// HYK-257-done-stamp-3 §2 범위1 (2R 반려 수리) -- 관측 라운드 분리:
// 2R은 `taskId::droppedAt`을 하나로 이어붙인 문자열을 이 채널의 `taskId`
// 필드에 그대로 넣었다(레코드 자체에는 별도 `droppedAt` 필드가 없었다).
// 검토자 실측: 이는 두 가지 문제를 낳는다 --
//   ① 레코드가 진짜 taskId를 담지 않아 "레코드에 dropped_at을 포함한다"는
//      보고와 실제 구현이 불일치한다(보고: 분리했다 / 실제: 이어붙였을
//      뿐이다).
//   ② dropped_at은 «분» 단위 정밀도뿐이다(DROPPED_AT_FORMAT_RE, 초 없음)
//      -- 같은 분 안에 연속 두 라운드가 배달되면(빠른 반려->재배달
//      사이클에서 실제로 일어날 수 있다) 두 라운드의 dropped_at 문자열이
//      우연히 같아져, 이어붙인 키가 충돌하고 서로 다른 라운드의 DONE 값이
//      "같은 라운드의 중간 수정"으로 오탐된다.
// 수리: taskId/droppedAt을 레코드에 **별도 필드**로 저장하고(둘 다로
// 조회), **로그 수명**을 추가한다 -- 라운드가 «소비 완료»되면(관측이 아니라
// 소비가 끝나는 시점) 그 라운드의 관측 항목을 소비-표시(tombstone)해
// 다음 라운드가 같은 (taskId, droppedAt) 키를 재사용하더라도(위 ②의 충돌
// 시나리오 포함) 소비된 이전 세대의 값과 비교되지 않고 항상 새로 관측을
// 시작하게 한다. append-only 계약은 유지한다(기존 항목을 지우거나
// 덮어쓰지 않는다 -- tombstone도 그냥 새 줄 append).
//
// 엔진 무관(coder-task.md §3 요건4): 이 모듈은 relay-handshake.mjs가 호출할
// 뿐, Claude 전용 훅이 아니다 -- codex 좌석의 결과 파일도 동일한 소비
// 경로(watch-result.mjs -> checkRelayHandshake)를 지난다.
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

function logPath(role, harnessDir) {
  return join(
    harnessDir,
    `${String(role).toLowerCase()}-done-first-observation.jsonl`,
  );
}

function fingerprint(resultContent) {
  return createHash("sha256").update(resultContent, "utf8").digest("hex");
}

// Append-only log 전체를 매번 다시 읽는다 -- 라운드당 항목 수가 적고(한
// (taskId, droppedAt) 쌍당 관측 1개 + 소비 시 tombstone 1개), 별도 인덱스
// 파일을 새로 만들지 않는다(범위 확장 금지).
function readEntries(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // 손상된 한 줄이 있어도(예: 쓰다 만 줄) 전체 로그를 못 읽는 것으로
      // 취급하지 않는다 -- 그 줄만 건너뛴다(append-only 로그는 다른 줄에
      // 영향을 주지 않아야 한다는 이 저장소의 기존 관례, envelope-archive
      // 계열과 동일).
    }
  }
  return entries;
}

function sameRound(entry, taskId, droppedAt) {
  return entry && entry.taskId === taskId && entry.droppedAt === droppedAt;
}

// HYK-353 3R (책임자 판정 2026-08-25 22:16, 범위 한 줄 한정): "관측 로그를
// 판정할 수 없으면(손상·부분 파손 포함) 재발행을 거부한다" -- 읽기 실패
// 경로(파일이 디렉터리라 readFileSync 자체가 던지는 경우)는 이미 호출자
// 쪽에서 예외로 전파돼 안전하게 거부되지만(§3 회귀 대상, 손대지 않음),
// readEntries는 손상된 한 줄을 조용히 건너뛰어(위 readEntries 자신의
// house style 주석 참조 -- append-only 로그가 다른 줄에 영향을 주지
// 않아야 한다는 기존 관례, 이 함수는 그 관례를 뒤집지 않는다) "이 라운드의
// 관측이 원래 없다"와 "관측이 있었는데 손상돼 못 읽었다"를 구별하지
// 못하게 만든다. 손상된 줄은 파싱 자체가 실패하므로 어느 (taskId,
// droppedAt)에 속했는지 알 수 없다 -- 그래서 "이 라운드에 속한 손상"만
// 골라내지 않고, 로그 파일 «전체»에 파싱 실패 줄이 하나라도 있으면
// 무조건 true를 반환한다(더 정밀한 귀속은 이 판정에 필요 없다 -- 호출자
// finalize-done.mjs의 resolveActiveObservation은 "판정 불가 -> 거부"만
// 필요로 하지, "어느 라운드가 손상됐는지"는 필요로 하지 않는다 -- ORCH
// 지시서의 "손상 JSONL 일반론으로 확장 금지"를 문자 그대로 지키는
// 범위). readEntries/findFirstObservation의 기존 동작(생산 소비
// 경로 -- checkIntermediateRewrite/observeDoneLine)은 이 함수와 무관하게
// 그대로다(다른 개선 금지).
export function hasCorruptEntries(role, harnessDir) {
  const path = logPath(role, harnessDir);
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      JSON.parse(trimmed);
    } catch {
      return true;
    }
  }
  return false;
}

// HYK-257-done-stamp-3 §2 범위1: 이 (taskId, droppedAt) 쌍의 «현재 세대»
// 첫 관측을 찾는다. 파일을 순서대로 훑으며 이 쌍에 매치하는 항목을 볼 때
// -- tombstone(consumed:true)이면 현재 세대를 리셋(active=null, "이 쌍은
// 이미 소비되어 끝났다, 다음 매치는 새 세대")하고, 관측 항목인데 아직
// active가 없으면 그것을 이번 세대의 기준값으로 채택한다(그 뒤에 같은
// 세대 안에서 또 관측 항목이 나타나는 일은 없다 -- recordFirstDoneObservation
// 이 이미 active가 있으면 다시 쓰지 않으므로). 파일 끝에서 active가 남아
// 있으면 그것이 "지금 비교해야 할 첫 관측"이고, tombstone으로 끝났으면
// null(= 이 세대는 이미 소비되어 끝났다 -- 다음 라운드가 같은 키를 다시
// 써도 깨끗하게 새로 시작한다).
export function findFirstObservation({ taskId, droppedAt, role, harnessDir }) {
  const entries = readEntries(logPath(role, harnessDir));
  let active = null;
  for (const entry of entries) {
    if (!sameRound(entry, taskId, droppedAt)) continue;
    if (entry.consumed === true) {
      active = null;
      continue;
    }
    if (active === null) active = entry;
  }
  return active;
}

// 이 (taskId, droppedAt) 세대에 대해 «처음»으로 DONE 줄을 관측한
// 순간에만 append한다(이미 이번 세대의 기록이 있으면 아무것도 하지
// 않는다 -- 덮어쓰지 않는다, append-only 계약). Best-effort: 실패해도
// 절대 throw하지 않는다(checkRelayHandshake 자신의 판정에 영향을 주지
// 않아야 한다는 이 파일의 house style, spawnAdmissionCompletion/
// autoWriteConsumptionReceipt와 동일 원칙).
export function recordFirstDoneObservation({
  taskId,
  droppedAt,
  role,
  harnessDir,
  resultContent,
  doneLineRaw,
  observedAtMs = Date.now(),
}) {
  try {
    const existing = findFirstObservation({
      taskId,
      droppedAt,
      role,
      harnessDir,
    });
    if (existing)
      return { recorded: false, reason: "already observed", existing };
    const entry = {
      taskId,
      droppedAt,
      observedAtMs,
      resultFingerprint: fingerprint(resultContent),
      doneLineRaw: doneLineRaw.trim(),
    };
    appendFileSync(
      logPath(role, harnessDir),
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
    return { recorded: true, entry };
  } catch (err) {
    return { recorded: false, reason: `record failed: ${err.message}` };
  }
}

// HYK-257-done-stamp-3 §2 범위1 (로그 수명): 이 (taskId, droppedAt) 라운드가
// «소비 완료»된 순간(checkRelayHandshake가 ok:true를 반환하기 직전, 그
// 라운드의 모든 검사를 이미 통과한 시점)에만 부른다. 이후 같은 키가 다시
// 나타나도(2R이 놓친 분-정밀도 충돌 시나리오 포함) findFirstObservation은
// 이 tombstone 이후를 "새 세대"로 취급해 처음부터 다시 관측한다 --
// 소비된 라운드의 값이 다음 라운드를 오염시키지 않는다. Best-effort,
// 항상 append만 한다(append-only 계약 유지, 기존 줄을 지우거나 고치지
// 않는다).
export function markObservationConsumed({
  taskId,
  droppedAt,
  role,
  harnessDir,
  consumedAtMs = Date.now(),
}) {
  try {
    const entry = { taskId, droppedAt, consumed: true, consumedAtMs };
    appendFileSync(
      logPath(role, harnessDir),
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
    return { recorded: true, entry };
  } catch (err) {
    return { recorded: false, reason: `mark-consumed failed: ${err.message}` };
  }
}

// 최종 판정 시점(ok:true 반환 직전)에 부른다. «이 (taskId, droppedAt)
// 세대에 대해 이전에 기록된 첫 관측»과 «지금 판정 중인 값»을 대조한다 --
// 다르면(지문 또는 DONE 원문 중 하나라도) 중간에 결과 파일이 다시 쓰였다는
// 뜻이다.
//
// 정상 라운드(오탐 0): 한 (taskId, droppedAt)을 처음 보는 그 호출 자체가
// 위 recordFirstDoneObservation을 통해 "방금 그 값"을 기록하므로, 같은
// 호출 안에서 바로 대조하면 항상 일치한다(스스로와 비교) -- 아무 것도
// 뜨지 않는다. 불일치는 오직 «이 세대를 이전의 다른 호출에서 이미 한 번
// 관측했는데 그때와 지금 값이 다를 때»에만 발생한다. 이미 소비-표시된
// 세대는 findFirstObservation이 null을 반환하므로(위 함수 헤더 참조)
// 다음 라운드가 같은 키를 재사용해도 오탐하지 않는다.
export function checkIntermediateRewrite({
  taskId,
  droppedAt,
  role,
  harnessDir,
  resultContent,
  doneLineRaw,
}) {
  try {
    const existing = findFirstObservation({
      taskId,
      droppedAt,
      role,
      harnessDir,
    });
    if (!existing) return { rewritten: false, reason: "no prior observation" };
    const currentFingerprint = fingerprint(resultContent);
    const currentDoneLine = doneLineRaw.trim();
    const rewritten =
      existing.resultFingerprint !== currentFingerprint ||
      existing.doneLineRaw !== currentDoneLine;
    return { rewritten, existing, currentFingerprint, currentDoneLine };
  } catch (err) {
    // 대조 자체가 실패하면(예: 로그 파일 I/O 오류) 오탐 0 원칙을 지키기
    // 위해 "중간 수정 없음"으로 fail-open 하지 않는다 -- 하지만 이 채널은
    // 어디까지나 «좁히는» 보조 채널이지 기존 게이트를 약화하면 안 되므로
    // (§3 요건2), 대조 실패 자체는 판정 불가(rewritten:false, error 표시)
    // 로 남기고 기존 검사들에게 판정을 맡긴다 -- 이 채널이 없던 시절과
    // 정확히 같은 동작으로 후퇴한다(fail-closed의 방향은 "기존 검사가
    // 계속 작동한다"이지 "이 채널이 새 차단을 만든다"가 아니다).
    return { rewritten: false, error: err.message };
  }
}

// 단일 원자적 진입점: record-then-compare를 한 번의 호출로 묶는다(별도
// spawn 2회 대신 1회 -- CLI 호출자(relay-handshake.mjs)가 이것 하나만
// 쓴다). 정상 라운드에서 이 세대를 처음 보는 호출은 recordFirst가 방금
// 쓴 값을 그대로 다시 읽어 스스로와 비교하므로 항상 rewritten:false다.
// HYK-353 2R §1 (P1-1): the `record` field is additive -- existing callers
// that only ever read `rewritten`/`reason`/`existing`/`currentDoneLine`
// (this file's own tests, relay-handshake.mjs's pre-existing usage) see no
// shape change. It surfaces `recordFirstDoneObservation`'s own outcome
// (previously discarded -- called for its side effect only) so a caller can
// tell "the record write itself failed" (`recorded:false`, `reason` starts
// with 'record failed:') apart from "this generation was already observed"
// (`recorded:false`, `reason` === 'already observed', the normal 2nd-poll
// case) apart from "recorded for the first time just now" (`recorded:true`)
// -- three genuinely different outcomes that `checkIntermediateRewrite`'s
// own return value alone cannot distinguish (a write failure still leaves
// `findFirstObservation` seeing nothing, so `checkIntermediateRewrite`
// reports the same "no prior observation" shape as a clean first poll).
export function observeDoneLine({
  taskId,
  droppedAt,
  role,
  harnessDir,
  resultContent,
  doneLineRaw,
  observedAtMs = Date.now(),
}) {
  const recordOutcome = recordFirstDoneObservation({
    taskId,
    droppedAt,
    role,
    harnessDir,
    resultContent,
    doneLineRaw,
    observedAtMs,
  });
  const rewriteOutcome = checkIntermediateRewrite({
    taskId,
    droppedAt,
    role,
    harnessDir,
    resultContent,
    doneLineRaw,
  });
  return {
    ...rewriteOutcome,
    record: {
      recorded: recordOutcome.recorded,
      reason: recordOutcome.reason,
    },
  };
}

// HYK-257-done-stamp-2/3 §2 범위1: CLI 진입점. relay-handshake.mjs는 이
// 파일을 정적 import하지 않는다 -- consumption-receipt-writer.mjs/
// admission-completion-adapter.mjs와 정확히 같은 이유(그 두 파일의 헤더
// 참조): relay-handshake.mjs를 고정 4파일 목록으로 격리 clone하는 6개
// 변이 시험 파일(hyk186-time-authority-mutation.test.mjs 등)이 있고, 이
// 파일을 그 목록에 없는 채로 정적 import하면 모듈 로드 자체가 실패해
// 관련 없는 변이 시험 전부가 깨진다. execFileSync로 스폰하고, payload는
// JSON 문자열 argv 하나로 받는다(셸을 거치지 않으므로 이스케이프 문제
// 없음). stdout에는 JSON 결과 한 줄만 찍는다(호출자가 그대로 파싱).
//
// payload.action: "observe"(기본값, 생략 가능) | "markConsumed" -- 3R
// 신설. relay-handshake.mjs가 이 두 동작을 서로 다른 시점(첫 발견 순간 /
// 최종 소비 확정 순간)에 각각 부른다.
if (
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/first-observation.mjs")
) {
  const harnessDir = process.argv[2];
  // HYK-353: payload used to arrive as argv[3] -- a large `resultContent`
  // (the full result file text) blew past the OS command-line length limit
  // (Windows ENAMETOOLONG), silently dropping this round's first-observation
  // entry while the caller (relay-handshake.mjs's spawnObserveDoneLine)
  // treated the spawn failure as best-effort/non-fatal and the round still
  // completed with exit 0. Reading the payload from stdin instead makes this
  // channel size-independent -- argv only ever carries the small, fixed
  // `harnessDir` path now.
  let payloadJson;
  try {
    payloadJson = readFileSync(0, "utf8");
  } catch (err) {
    console.error(
      `first-observation: failed to read payload from stdin: ${err.message}`,
    );
    process.exit(1);
  }
  if (!harnessDir || !payloadJson) {
    // HYK-353 2R §1 (P2-2, 검토 반려): every other error path in this CLI
    // block prints a `"first-observation: "`-prefixed line -- this one used
    // to be the sole exception (bare `"usage: ..."`, no prefix). The
    // parent's genuine-attempt-vs-missing-sidecar split
    // (relay-handshake.mjs's `spawnObserveDoneLine`) keys off that exact
    // prefix, so a stdin-cut-before-payload failure (empty stdin, e.g. the
    // pipe closed early) was silently indistinguishable from "the script
    // file itself doesn't exist" -- both would fail the `.includes(
    // "first-observation: ")` check even though this one is a genuine,
    // reachable failure.
    console.error(
      "first-observation: usage: node first-observation.mjs <harnessDir> <payloadJson={taskId,droppedAt,role,resultContent,doneLineRaw,action?} via stdin>",
    );
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err) {
    console.error(
      `first-observation: payload JSON not parseable: ${err.message}`,
    );
    process.exit(1);
  }
  const outcome =
    payload.action === "markConsumed"
      ? markObservationConsumed({
          taskId: payload.taskId,
          droppedAt: payload.droppedAt,
          role: payload.role,
          harnessDir,
        })
      : observeDoneLine({
          taskId: payload.taskId,
          droppedAt: payload.droppedAt,
          role: payload.role,
          harnessDir,
          resultContent: payload.resultContent,
          doneLineRaw: payload.doneLineRaw,
        });
  console.log(JSON.stringify(outcome));
  process.exit(0);
}
