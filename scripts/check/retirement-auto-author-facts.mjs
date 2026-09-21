// HYK-419-wire-1 (coder-task.md §2⑴) -- "사실 조립기(어댑터)". 이 모듈
// «하나»의 일: 원장 파일(admission-ledger.json) · 배달 영수증 파일
// (dispatch-receipts.jsonl) · 그 워크트리의 `.harness/rounds/`를 읽어서
// retirement-auto-author-core.mjs의 evaluateAutoAuthorAuthorization이
// 요구하는 `facts` 객체를 **조립만** 한다.
//
// ⛔판정 0 -- 이 파일은 OPEN/CLOSED/AUTHORIZED_DRAFT 어느 것도 스스로
// 결정하지 않는다. 그 판단은 전부 retirement-auto-author-core.mjs(→
// hyk412-never-consumed-retire-core.mjs) 몫이다. 이 파일은 그 판정이 읽을
// «사실»만 파일에서 그러모은다.
// ⛔쓰기 0 -- 이 모듈은 fs 쓰기 함수를 import조차 하지 않는다.
// ⛔경로 하드코딩 0 -- ledgerPath/receiptPath/harnessDir 전부 호출자가
// 인자로 넘긴다(admission-completion-adapter.mjs의 "기본값으로 라이브
// 관제실 경로를 박지 않는다" 원칙과 동일, coder-task.md §0 "라이브 원장
// 무접촉" 요구를 이 계층에서 지키는 방법이 이것뿐이다).
//
// ★계약: **Never throws**(retirement-record-writer.mjs/abort-record-
// writer.mjs와 동일 계약). 읽기 실패·파일 부재·형식 불일치는 예외를
// 던지지 않고 `{ok:false, code, reason}`으로 돌려준다 -- 호출자(그림자
// 결선 지점)가 그 실패조차 "조립 불가"로 한 줄 찍고 넘어갈 수 있어야
// 하기 때문이다(coder-task.md §2⑵ "조립 불가·판정 불가여도 같은 형식의
// 한 줄을 찍어라").
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const ASSEMBLE_FAILURE = Object.freeze({
  MISSING_ARGS: "MISSING_ARGS",
  LEDGER_UNREADABLE: "LEDGER_UNREADABLE",
  LEDGER_MALFORMED: "LEDGER_MALFORMED",
  RECEIPT_UNREADABLE: "RECEIPT_UNREADABLE",
  ROUNDS_DIR_UNREADABLE: "ROUNDS_DIR_UNREADABLE",
});

// ★정직 한계(설계 문서 §5에 상술): 이 저장소 어디에도 "stall-watch
// 임계치"의 정본 상수가 없다(ORCH 실측 grep, hyk412-never-consumed-retire-
// core.mjs 자신도 그 계산을 호출자에게 위임한다). 이 조립기는 그림자
// 관측 하나만을 위해 24시간을 임시값으로 둔다 -- 실제 결선(진짜 차단)으로
// 갈 때는 이 값을 정본 상수로 교체해야 한다(다음 라운드 몫, 그림자 판정
// 자체는 이 값이 틀려도 아무것도 막지 않는다).
const SHADOW_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function defaultSha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assembleFailure(code, reason) {
  return { ok: false, code, reason };
}

// ledgerReservation 조립 -- admission-ledger-core.mjs의 스키마(§0
// isWellFormedLedger)를 그대로 읽는다: `ledger.reservations[label]`.
// reservationId는 이 저장소 관례상 harnessTaskLabel과 동일하다
// (admission-completion-adapter.mjs의 verifyBlockedTerminationEvidence와
// 동일 전제 -- 이 파일이 새로 만든 가정이 아니다).
function readLedgerFile(ledgerPath, readFileFn) {
  if (!isNonEmptyString(ledgerPath)) {
    return assembleFailure(
      ASSEMBLE_FAILURE.LEDGER_UNREADABLE,
      "retirement-auto-author-facts: ledgerPath 미설정 -> admission-ledger.json을 읽을 수 없음, 조립 불가",
    );
  }
  let raw;
  try {
    raw = readFileFn(ledgerPath, "utf8");
  } catch (err) {
    return assembleFailure(
      ASSEMBLE_FAILURE.LEDGER_UNREADABLE,
      `retirement-auto-author-facts: ledger 파일을 읽을 수 없음('${ledgerPath}': ${err.message}), 조립 불가`,
    );
  }
  try {
    return { ok: true, parsed: JSON.parse(raw) };
  } catch (err) {
    return assembleFailure(
      ASSEMBLE_FAILURE.LEDGER_MALFORMED,
      `retirement-auto-author-facts: ledger JSON 파싱 실패('${ledgerPath}': ${err.message}), 조립 불가`,
    );
  }
}

function reservationEntryFromLedger(parsed, harnessTaskLabel) {
  const reservations =
    parsed && typeof parsed === "object" ? parsed.reservations : null;
  const entry =
    reservations && typeof reservations === "object"
      ? reservations[harnessTaskLabel]
      : undefined;
  return entry && typeof entry === "object" ? entry : null;
}

function readLedgerReservation({ ledgerPath, harnessTaskLabel, readFileFn }) {
  const fileResult = readLedgerFile(ledgerPath, readFileFn);
  if (!fileResult.ok) return fileResult;

  const entry = reservationEntryFromLedger(fileResult.parsed, harnessTaskLabel);
  if (!entry) {
    return { ok: true, ledgerReservation: { exists: false }, admittedAt: null };
  }
  return {
    ok: true,
    ledgerReservation: {
      exists: true,
      harnessTaskLabel,
      status: typeof entry.status === "string" ? entry.status : null,
      completedAt: entry.completed_at === undefined ? null : entry.completed_at,
    },
    admittedAt:
      typeof entry.admitted_at === "string" ? entry.admitted_at : null,
  };
}

// dispatchReceiptMatchCount 조립 -- admission-completion-adapter.mjs의
// hasDispatchReceiptForRound와 동일한 손상-줄-건너뜀 관례를 재현한다
// (⛔새 조회 로직 발명 금지, 그 파일 헤더가 이미 밝힌 이유 그대로: 이
// 파일도 무거운 정적 import를 늘리지 않기 위해 작은 파싱 로직을 복제한다).
function countDispatchReceiptMatches({
  receiptPath,
  role,
  harnessTaskLabel,
  readFileFn,
}) {
  if (!isNonEmptyString(receiptPath)) {
    return assembleFailure(
      ASSEMBLE_FAILURE.RECEIPT_UNREADABLE,
      "retirement-auto-author-facts: receiptPath 미설정 -> dispatch-receipts.jsonl을 읽을 수 없음, 조립 불가",
    );
  }
  let raw;
  try {
    raw = readFileFn(receiptPath, "utf8");
  } catch (err) {
    return assembleFailure(
      ASSEMBLE_FAILURE.RECEIPT_UNREADABLE,
      `retirement-auto-author-facts: 배달 영수증 파일을 읽을 수 없음('${receiptPath}': ${err.message}), 조립 불가`,
    );
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof rec.role === "string" &&
      rec.role.toUpperCase() === String(role).toUpperCase() &&
      rec.harness_task_label === harnessTaskLabel
    ) {
      count += 1;
    }
  }
  return { ok: true, dispatchReceiptMatchCount: count };
}

// .harness/rounds/ 조립 -- relay-handshake.mjs의 hasArchivedRoundCopyForTaskId
// 와 동일한 파일명 관례(`<role>-r<N>.md`/`<role>-task-r<N>.md`, 대소문자
// 무관)를 재사용한다(⛔새 이름 관례 발명 금지).
function readNamesInDir(roundsDir, readdirFn) {
  try {
    return { ok: true, names: readdirFn(roundsDir) };
  } catch (err) {
    return assembleFailure(
      ASSEMBLE_FAILURE.ROUNDS_DIR_UNREADABLE,
      `retirement-auto-author-facts: rounds 디렉터리를 읽을 수 없음('${roundsDir}': ${err.message}), 조립 불가`,
    );
  }
}

function extractTaskIdLine(raw) {
  const match = raw.match(/^task_id:\s*(\S+)/m);
  return match ? match[1] : null;
}

// 이 role의 자기 task-r<N>.md 사본(내용의 task_id: 줄이 harnessTaskLabel과
// 정확히 일치하는 것)을 찾는다 -- 찾으면 {ownRoundNumber, ownTaskArchivePath},
// 못 찾으면 둘 다 null.
function findOwnTaskArchive({
  roundsDir,
  role,
  harnessTaskLabel,
  names,
  readFileFn,
}) {
  const taskPattern = new RegExp(`^${role}-task-r(\\d+)\\.md$`, "i");
  for (const name of names) {
    const m = taskPattern.exec(name);
    if (!m) continue;
    let raw;
    try {
      raw = readFileFn(join(roundsDir, name), "utf8");
    } catch {
      continue;
    }
    if (extractTaskIdLine(raw) === harnessTaskLabel) {
      return {
        ownRoundNumber: Number(m[1]),
        ownTaskArchivePath: join("rounds", name),
      };
    }
  }
  return { ownRoundNumber: null, ownTaskArchivePath: null };
}

function hasNextTaskArchive({ role, ownRoundNumber, names }) {
  if (ownRoundNumber === null) return false;
  const nextPattern = new RegExp(
    `^${role}-task-r${ownRoundNumber + 1}\\.md$`,
    "i",
  );
  return names.some((n) => nextPattern.test(n));
}

// 이 role의 결과 아카이브(`<role>-r<N>.md`, envelope-archive.mjs가 남긴
// 주석 머리를 벗겨낸 뒤 task_id: 줄을 비교) 중 이 harnessTaskLabel과
// 일치하는 사본이 이미 있는지 -- relay-handshake.mjs의
// hasArchivedRoundCopyForTaskId와 동일한 판정.
function hasMatchingResultArchive({
  roundsDir,
  role,
  harnessTaskLabel,
  names,
  readFileFn,
}) {
  const resultPattern = new RegExp(`^${role}-r\\d+\\.md$`, "i");
  for (const name of names) {
    if (!resultPattern.test(name)) continue;
    let raw;
    try {
      raw = readFileFn(join(roundsDir, name), "utf8");
    } catch {
      continue;
    }
    const stripped = raw.replace(/^<!-- envelope-archive:[^\n]*-->\n/, "");
    if (extractTaskIdLine(stripped) === harnessTaskLabel) return true;
  }
  return false;
}

// .harness/rounds/ 조립 -- relay-handshake.mjs의 hasArchivedRoundCopyForTaskId
// 와 동일한 파일명 관례(`<role>-r<N>.md`/`<role>-task-r<N>.md`, 대소문자
// 무관)를 재사용한다(⛔새 이름 관례 발명 금지).
function readRoundsFacts({
  harnessDir,
  role,
  harnessTaskLabel,
  readdirFn,
  readFileFn,
}) {
  const roundsDir = join(harnessDir, "rounds");
  const namesResult = readNamesInDir(roundsDir, readdirFn);
  if (!namesResult.ok) return namesResult;
  const { names } = namesResult;

  const { ownRoundNumber, ownTaskArchivePath } = findOwnTaskArchive({
    roundsDir,
    role,
    harnessTaskLabel,
    names,
    readFileFn,
  });

  return {
    ok: true,
    ownTaskArchiveExists: ownTaskArchivePath !== null,
    ownTaskArchivePath,
    hasLaterRoundArchive: hasNextTaskArchive({ role, ownRoundNumber, names }),
    resultArchiveExists: hasMatchingResultArchive({
      roundsDir,
      role,
      harnessTaskLabel,
      names,
      readFileFn,
    }),
  };
}

function computeOwnArchiveFingerprint({
  harnessDir,
  ownTaskArchivePath,
  readFileFn,
  hashFn,
}) {
  if (!ownTaskArchivePath) return null;
  try {
    const buf = readFileFn(join(harnessDir, ownTaskArchivePath));
    return hashFn(buf);
  } catch {
    return null;
  }
}

// admitted_at + SHADOW_STALE_THRESHOLD_MS와 "지금"을 비교한다 -- admitted_at
// 이 없거나 파싱 불가면 false(안전측 -- "충분히 지났다"를 지어내지
// 않는다).
function computeStaleEnoughSinceAdmission(admittedAt, nowFn) {
  if (!isNonEmptyString(admittedAt)) return false;
  const admittedMs = Date.parse(admittedAt);
  if (Number.isNaN(admittedMs)) return false;
  return nowFn().getTime() - admittedMs >= SHADOW_STALE_THRESHOLD_MS;
}

function validateAssembleArgs({
  role,
  harnessTaskLabel,
  harnessDir,
  existsFn,
}) {
  if (
    !isNonEmptyString(role) ||
    !isNonEmptyString(harnessTaskLabel) ||
    !isNonEmptyString(harnessDir)
  ) {
    return assembleFailure(
      ASSEMBLE_FAILURE.MISSING_ARGS,
      "retirement-auto-author-facts: role/harnessTaskLabel/harnessDir 중 하나 이상이 없음 -> 조립 대상을 특정할 수 없음, 조립 불가",
    );
  }
  if (!existsFn(harnessDir)) {
    return assembleFailure(
      ASSEMBLE_FAILURE.MISSING_ARGS,
      `retirement-auto-author-facts: harnessDir('${harnessDir}')가 존재하지 않음 -> 조립 불가`,
    );
  }
  return { ok: true };
}

// 세 소스(ledger/receipt/rounds)를 순서대로 읽는다 -- 하나라도 "조립
// 불가"면 그 실패를 그대로 위로 돌려주고(early exit), 셋 다 통과하면
// evaluateAutoAuthorAuthorization이 요구하는 facts 모양을 조립해 돌려준다.
function gatherAssembledFacts({
  role,
  harnessTaskLabel,
  harnessDir,
  ledgerPath,
  receiptPath,
  successorLabelForRecord,
  recordedAt,
  readFileFn,
  readdirFn,
  hashFn,
  nowFn,
}) {
  const ledgerResult = readLedgerReservation({
    ledgerPath,
    harnessTaskLabel,
    readFileFn,
  });
  if (!ledgerResult.ok) return ledgerResult;

  const receiptResult = countDispatchReceiptMatches({
    receiptPath,
    role,
    harnessTaskLabel,
    readFileFn,
  });
  if (!receiptResult.ok) return receiptResult;

  const roundsResult = readRoundsFacts({
    harnessDir,
    role,
    harnessTaskLabel,
    readdirFn,
    readFileFn,
  });
  if (!roundsResult.ok) return roundsResult;

  const ownTaskArchiveFingerprint = computeOwnArchiveFingerprint({
    harnessDir,
    ownTaskArchivePath: roundsResult.ownTaskArchivePath,
    readFileFn,
    hashFn,
  });

  return {
    ok: true,
    facts: {
      role,
      harnessTaskLabel,
      ledgerReservation: ledgerResult.ledgerReservation,
      dispatchReceiptMatchCount: receiptResult.dispatchReceiptMatchCount,
      resultArchiveExists: roundsResult.resultArchiveExists,
      ownTaskArchiveExists: roundsResult.ownTaskArchiveExists,
      hasLaterRoundArchive: roundsResult.hasLaterRoundArchive,
      staleEnoughSinceAdmission: computeStaleEnoughSinceAdmission(
        ledgerResult.admittedAt,
        nowFn,
      ),
      successorLabelForRecord,
      harnessDir,
      ownTaskArchivePath: roundsResult.ownTaskArchivePath,
      ownTaskArchiveFingerprint,
      recordedAt,
    },
  };
}

// The one function this module exists to provide. Never throws.
//
// 입력: role/harnessTaskLabel/harnessDir(필수) + ledgerPath/receiptPath
// (미설정이면 그 소스는 "조립 불가"로 즉시 거부) + successorLabelForRecord/
// recordedAt(호출자가 이미 알고 있는 값 -- 이 조립기가 새로 지어내지
// 않는다, coder-task.md §2⑶와 같은 원칙: 사람/다른 축이 아는 값을 이
// 파일이 추측하지 않는다).
export function assembleAutoAuthorFacts({
  role,
  harnessTaskLabel,
  harnessDir,
  ledgerPath,
  receiptPath,
  successorLabelForRecord = null,
  recordedAt = null,
  existsFn = existsSync,
  readFileFn = readFileSync,
  readdirFn = readdirSync,
  hashFn = defaultSha256Hex,
  nowFn = () => new Date(),
} = {}) {
  try {
    const argsCheck = validateAssembleArgs({
      role,
      harnessTaskLabel,
      harnessDir,
      existsFn,
    });
    if (!argsCheck.ok) return argsCheck;

    return gatherAssembledFacts({
      role,
      harnessTaskLabel,
      harnessDir,
      ledgerPath,
      receiptPath,
      successorLabelForRecord,
      recordedAt,
      readFileFn,
      readdirFn,
      hashFn,
      nowFn,
    });
  } catch (err) {
    // ★차단 0의 마지막 방어선: 위 세 조립 단계 어디에도 잡히지 않은
    // 예상 밖 예외(예: 시험이 강제로 던지도록 주입한 readFileFn)까지
    // 이 한 catch가 흡수한다 -- 이 함수를 부르는 그림자 결선 지점이
    // "예외를 절대 안 던진다"를 신뢰하고 try/catch 없이 불러도 되게
    // 하려는 것이 아니라(그 지점도 자체 방어선을 하나 더 둔다, coder-
    // task.md §2⑷), 이 계약 자체가 이 파일의 헤더가 약속한 것이기
    // 때문이다.
    return assembleFailure(
      ASSEMBLE_FAILURE.MISSING_ARGS,
      `retirement-auto-author-facts: 조립 중 예상하지 못한 예외(${err.message}) -> 조립 불가`,
    );
  }
}
