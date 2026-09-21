// HYK-457 (coder-task.md §2/§3-A -- HYK-350 "정의 두 벌 드리프트" 교훈,
// ledger-pointer-shared.mjs가 세운 것과 같은 관례): single source of truth
// for `confirmRetirementBlockReason` -- the "재확인 가능한 은퇴 사유가
// live 파일에서 실제로 사실인가" 판정 -- which was independently
// duplicated in dispatch-gate-decision.mjs (:2208, 사유 3개 대응) and
// admission-completion-adapter.mjs (:648, `...ForAdapter`, 사유 2개
// 대응 -- HYK-455가 세 번째 사유(RUNNER_GREEN_UNREACHABLE_AT_HEAD)를
// 추가하며 이 사본을 갱신하지 않아 발생한 fail-closed 회귀, 2026-09-08
// ORCH-63 격리 실측). 이 파일은 두 사본의 "합집합"이다: doneAt 추출은
// 다른 지점(정본은 CONSUMPTION_DONE_RE_G, 어댑터는 인라인 리터럴)이었지만
// 정규식 리터럴이 바이트 동일했으므로 이 파일이 그 하나를 그대로 쓴다;
// runner-green 가지는 정본에만 있었으므로(어댑터는 애초에 없었다) 그대로
// 옮긴다.
//
// admission-completion-adapter.mjs의 파일 헤더(HYK-398 §2-⑶)가 명시한
// 원칙 -- "무겁게 참조되는 모듈(dispatch-gate-decision.mjs 등)을 끌어들이지
// 않는다" -- 을 이 파일도 지킨다: import는 node 내장(node:fs, node:path)과
// retirement-record-core.mjs(그 자신도 zero-import 코어) 뿐이다.
// dispatch-gate-decision.mjs를 이 파일이 참조하는 일은 없다(방향이
// 반대면 그 파일의 전체 의존성 트리를 다시 끌어들이게 된다).
//
// ⚠️ this file is now a sibling every isolated/mutation fixture that stages
// a synthetic copy of admission-completion-adapter.mjs must also stage
// (mirrors the existing ledger-pointer-shared.mjs/retirement-record-core.mjs
// sibling pattern those fixtures already carry) -- this round updated every
// such site it found (see coder.md for the full list). dispatch-gate-
// decision.mjs is never copied into an isolated fixture (every test that
// touches it spawns the real file at its real repo path instead, see that
// file's own header) so this file needs no sibling-list update on that side.

import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import {
  RETIREMENT_BLOCK_REASON,
  MECHANICALLY_CONFIRMABLE_BLOCK_REASONS,
} from "./retirement-record-core.mjs";

const CONSUMPTION_DONE_RE_G = /^>>>\s*DONE:.*@\s*(.+?)\s*$/gim;
// HYK-455 §2 -- RUNNER_GREEN_UNREACHABLE_AT_HEAD 재확인 전용: 이 라운드
// 자신의 결과 파일이 주장하는 head_commit(그 러너가 실제로 돈 커밋)을
// 뽑는다. `head_commit:` 소문자 표지만 인정한다 -- 값은 40자 hex(sha)로
// 고정해 위조 문자열이 아무 값이나 채워 넣지 못하게 한다.
const CONSUMPTION_HEAD_COMMIT_RE_G =
  /^head_commit:[ \t]*([0-9a-fA-F]{40})[ \t]*$/gm;

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// "유일한 매치 하나만 채택, 0개·2개 이상이면 지어내지 않고 undefined로
// 물러난다" 규칙 (dispatch-gate-decision.mjs의 extractSoleMatch와 동일).
function extractSoleMatch(text, reG) {
  const matches = [...text.matchAll(reG)];
  return matches.length === 1 ? matches[0][1].trim() : undefined;
}

// HYK-478 §1-2 ⓐ: AUTHOR_SEAT_LOST_BEFORE_STAMP 전용 -- extractSoleMatch와
// 달리 «값»이 아니라 «개수»가 증거다(표지가 정확히 0개여야 "완료를 선언한
// 적이 없다"는 사실이 선다). 같은 CONSUMPTION_DONE_RE_G를 재사용한다(이
// 저장소가 이미 "DONE 표지"로 인정하는 유일한 모양 -- 새 정규식을 만들지
// 않는다).
function countConsumptionDoneMarkers(text) {
  return [...text.matchAll(CONSUMPTION_DONE_RE_G)].length;
}

function parseKstToMs(str) {
  if (typeof str !== "string") return null;
  const cleaned = str.trim().replace(/\s*KST\s*$/i, "");
  const match = cleaned.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/,
  );
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}+09:00`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

// harnessDir 밖을 가리키는 evidenceReceiptPath(경로 탈출)를 거부한다 --
// resolveEvidenceReceiptPathWithinHarnessDir (dispatch-gate-decision.mjs의
// 옛 사본과 동일한 계약).
function resolveEvidenceReceiptPathWithinHarnessDir(
  harnessDir,
  evidenceReceiptPath,
) {
  if (!isNonEmptyString(evidenceReceiptPath)) return null;
  const resolvedHarnessDir = resolve(harnessDir);
  const resolvedPath = resolve(harnessDir, evidenceReceiptPath);
  const rel = relative(resolvedHarnessDir, resolvedPath);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("..\\")
  ) {
    return null;
  }
  if (isAbsolute(rel)) return null;
  return resolvedPath;
}

// record.evidenceReceiptPath(§설계 조건 2)가 가리키는 러너 영수증
// (runner-receipt-writer.mjs 스키마, HYK-411)을 harnessDir 기준으로 실제로
// 다시 읽어, 그 안의 head_commit이 이 라운드 결과 파일 자신의 head_commit:
// 줄과 같고 runner_exit이 0이 아님을 독립적으로 재유도한다. 경로가
// 없거나·harnessDir을 벗어나거나·파일을 못 읽거나·JSON이 아니거나·
// head_commit이 다르거나·runner_exit이 0(=그 커밋에서 실제로는 초록)이면
// false -- "ORCH가 그렇다고 했다"만으로는 통과하지 못한다.
function confirmRunnerGreenUnreachableAtHead(record, harnessDir, resultText) {
  const resultHeadCommit = extractSoleMatch(
    resultText,
    CONSUMPTION_HEAD_COMMIT_RE_G,
  );
  if (!isNonEmptyString(resultHeadCommit)) return false;
  const resolvedPath = resolveEvidenceReceiptPathWithinHarnessDir(
    harnessDir,
    record?.evidenceReceiptPath,
  );
  if (resolvedPath === null) return false;
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch {
    return false;
  }
  return (
    receipt?.head_commit === resultHeadCommit &&
    typeof receipt?.runner_exit === "number" &&
    receipt.runner_exit !== 0
  );
}

// HYK-478 §1-2 ⓑ: AUTHOR_SEAT_LOST_BEFORE_STAMP 전용 -- 이 라운드
// (record.harnessTaskLabel로 admit된 예약)가 admission 원장에서 더는
// ACTIVE가 아님을 원장 파일을 다시 읽어 독립적으로 재확인한다.
// dispatch-gate-decision.mjs의 verifyAbortRecordRecoveryMarker와 같은
// 신뢰 축(sweepAndRecover가 이미 원장에 새긴 사실을 다시 읽을 뿐, 좌석
// 목록을 이 함수가 다시 조회하지 않는다 -- retirement-record-core.mjs의
// RETIREMENT_BLOCK_REASON 주석 §정직 한계 참조)이다. admission-ledger-
// core.mjs를 import하지 않는다(§S8 zero-heavy-import 원칙, 이 파일 헤더
// 그대로) -- RESERVATION_STATUS.SUSPECT/COMPLETED와
// COMPLETION_REASON.SUSPECT_TIMEOUT_RECOVERED의 리터럴 값만 그대로
// 복제한다(dispatch-gate-decision.mjs의 RECOVERY_MARKER_ALLOWED_REASONS와
// 동일한 기존 관례).
//
// ledgerPath가 없거나·못 읽거나·JSON이 아니거나·그 harnessTaskLabel의
// 예약 항목이 원장에 아예 없거나·그 항목이 여전히 ACTIVE면 false(안전측
// 기본값 -- "아직 안 죽었을 수도 있다"를 거부로 접는다).
function confirmReservationSeatLost(harnessTaskLabel, ledgerPath) {
  if (!isNonEmptyString(harnessTaskLabel) || !isNonEmptyString(ledgerPath)) {
    return false;
  }
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  } catch {
    return false;
  }
  const entry = ledger?.reservations?.[harnessTaskLabel];
  if (!entry) return false;
  if (entry.status === "SUSPECT") return true;
  return (
    entry.status === "COMPLETED" &&
    entry.completion_reason === "SUSPECT_TIMEOUT_RECOVERED"
  );
}

// HYK-478 §1-2: 두 독립 사실(ⓐ 완료 표지 0개 · ⓑ 원장이 이미 ACTIVE가
// 아님을 새김) «둘 다» 참이어야 true다 -- DONE_PREDATES_DROPPED_AT이 이미
// "두 사실을 하나의 confirm 함수 안에서 && 로 묶는다"는 같은 모양을 쓰고
// 있다(위 참조).
function confirmAuthorSeatLostBeforeStamp(record, resultText, ledgerPath) {
  if (countConsumptionDoneMarkers(resultText) !== 0) return false;
  return confirmReservationSeatLost(record?.harnessTaskLabel, ledgerPath);
}

// §3-4 (retirement-record-core.mjs 헤더): 기계로 확인 가능한 사유(현재
// 넷 -- DONE_TIMESTAMP_NOT_PARSEABLE · DONE_PREDATES_DROPPED_AT ·
// RUNNER_GREEN_UNREACHABLE_AT_HEAD · AUTHOR_SEAT_LOST_BEFORE_STAMP)만
// 독립 재확인한다. 나머지 사유(DONE_REWRITE_LOCKED ·
// TASK_CONTRACT_PROHIBITS_REPAIR)는 이 코드베이스가 기계로 재현할 수
// 없는 계약 텍스트 질문이므로 null을 돌려준다(가짜 확인을 만들지 않는다
// -- null은 코어가 "이 사유는 이 축에서 재확인 대상이 아니다"로 이미
// 처리한다, MECHANICALLY_CONFIRMABLE_BLOCK_REASONS 확인).
//
// harnessDir은 필수다: RUNNER_GREEN_UNREACHABLE_AT_HEAD 가지가 러너
// 영수증을 harnessDir 기준 상대 경로로 다시 읽어야 하기 때문이다(위
// confirmRunnerGreenUnreachableAtHead 참조) -- 이 인자가 없던 옛
// admission-completion-adapter.mjs 사본이 정확히 이 가지를 결선하지
// 못해 fail-closed로 떨어졌던 결함(HYK-457 §2)이다.
// ledgerPath(HYK-478 §1-2 신규 인자, 5번째)는 AUTHOR_SEAT_LOST_BEFORE_STAMP
// 가지 전용이다 -- 나머지 가지는 이 인자를 전혀 읽지 않는다(undefined로
// 호출해도 무해, 이 함수의 기존 네 인자 계약은 바이트 하나 안 바뀐다).
export function confirmRetirementBlockReason(
  record,
  resultText,
  droppedAt,
  harnessDir,
  ledgerPath,
) {
  if (!MECHANICALLY_CONFIRMABLE_BLOCK_REASONS.has(record?.blockReasonCode)) {
    return null;
  }
  if (
    record.blockReasonCode ===
    RETIREMENT_BLOCK_REASON.DONE_TIMESTAMP_NOT_PARSEABLE
  ) {
    const doneAt = extractSoleMatch(resultText, CONSUMPTION_DONE_RE_G);
    return isNonEmptyString(doneAt) && parseKstToMs(doneAt) === null;
  }
  if (
    record.blockReasonCode === RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT
  ) {
    const doneAt = extractSoleMatch(resultText, CONSUMPTION_DONE_RE_G);
    const doneAtMs = parseKstToMs(doneAt);
    const droppedAtMs = parseKstToMs(droppedAt);
    return doneAtMs !== null && droppedAtMs !== null && doneAtMs < droppedAtMs;
  }
  if (
    record.blockReasonCode ===
    RETIREMENT_BLOCK_REASON.RUNNER_GREEN_UNREACHABLE_AT_HEAD
  ) {
    return confirmRunnerGreenUnreachableAtHead(record, harnessDir, resultText);
  }
  if (
    record.blockReasonCode ===
    RETIREMENT_BLOCK_REASON.AUTHOR_SEAT_LOST_BEFORE_STAMP
  ) {
    return confirmAuthorSeatLostBeforeStamp(record, resultText, ledgerPath);
  }
  return null;
}
