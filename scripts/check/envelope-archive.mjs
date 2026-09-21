import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// HYK-204: 워커 봉투(`.harness/<role>.md`)는 라운드마다 덮어쓴다 -- 같은
// 트랙에서 5라운드를 돌리면 마지막 라운드 원문만 남고 앞선 4개는 다음
// 라운드가 쓰는 순간 사라진다(2026-08-08 실사례: 그날 밤 최대 산출이던
// «공허한 IN_SYNC» 반려 원문이 이렇게 소실됐다). 이 모듈은 그 원문을
// `<role>.md`가 다시 덮어쓰이기 *전에* 별도 파일로 복제해 남긴다.
//
// ⛔봉투 형식(계약)은 바꾸지 않는다: `<role>.md` 자체는 여기서 절대
// 쓰지/지우지 않는다 -- relay-handshake/review-gate/reject-streak 등 그
// 파일을 읽는 기존 소비자는 이 모듈의 존재를 몰라도 그대로 동작한다.
// 보존은 항상 "추가"(다른 경로에 사본을 하나 더 남기는 것)일 뿐이다.
//
// HYK-204 2R (검토 §C 지적, 확정 한계 -- 아직 안 덮이는 라운드 1건):
// 이 모듈은 오직 CONFIRMED 라운드만 안다 -- `checkRelayHandshake`가
// ok:true를 반환한 순간, 또는 `review-gate.mjs`의 커밋 승인 순간에만
// 호출된다. **핸드셰이크 자체가 실패한 라운드(예: 워커가 `>>> DONE:` 줄을
// 잘못 쓰거나 `task_id:` 표지가 어긋난 라운드)는 원문이 전혀 남지 않는다**
// -- archiveRoundEnvelope가 호출되는 지점 자체가 없기 때문이다
// (envelope-archive.test.mjs의 "wiring: checkRelayHandshake blocked
// (mismatch) -> no archive is written" 시험이 이 구멍을 직접 증명한다).
// 이 트랙은 이 구멍을 고치지 않는다 -- 다음 사람이 "라운드가 덮인다"를
// 과신하지 않도록 기재만 한다.

const ARCHIVE_SUBDIR = "rounds";

function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNonEmptyStringLocal(v) {
  return typeof v === "string" && v.length > 0;
}

// HYK-204 §2 축3(이름): 라운드 번호는 사람이 손으로 대는 값이 아니라 이미
// 그 role의 archive 폴더에 몇 개가 쌓여 있는지를 세어 기계적으로 매긴다
// -- "동일 파일명 재사용(=덮어쓰기 재발)"을 막는 것이 이 함수의 유일한
// 계약이므로, 순번을 건너뛰거나 파일이 지워졌더라도 기존 최댓값+1을 써서
// 절대 과거 순번을 재사용하지 않는다.
//
// HYK-204 2R (검토 §C 목록 밖 지적, 확정 한계 -- TOCTOU, 수리 안 함):
// 이 계산과 archiveRoundEnvelope의 실제 write 사이에 원자성이 없다 --
// readdirSync(읽기)와 writeFileSync(쓰기) 사이에 다른 프로세스가 끼어들
// 수 있는 창이 열려 있다. `checkRelayHandshake`의 실제 호출자가 5곳
// (relay-core.mjs, watch-result.mjs, orca-spike-runner.mjs,
// orca-spike-live.mjs, seat-signal-adapter.mjs)이라, 같은 role에 대해
// 이론상 두 프로세스가 거의 동시에 archiveRoundEnvelope를 부르면 둘 다
// 같은 "다음 번호"를 계산해 하나가 다른 하나를 조용히 덮어쓸 수 있다 --
// 정확히 이 모듈이 막으려던 그 사고 모양이 여기서만 재발할 수 있다는
// 뜻이다. 실제 운영에서 그런 동시 호출이 실제로 벌어지는지는 확인하지
// 못했다(좁은 위험으로만 기재). 수리하려면 파일 잠금/원자적 rename 같은
// 설계 변경이 필요해 이 트랙 범위 밖으로 남긴다.
// HYK-244 gate-unblock-1 §1 조각1 원인ⓑ 수리 (ORCH 실측 근거: envelope-
// archive.mjs 51행): 이 정규식이 role 대소문자를 정규화하지 않아서,
// 실제 생산 호출자가 어떤 호출은 "REVIEW"(대문자)로, 다른 호출은
// "review"(소문자)로 넘기면(둘 다 같은 role 개념인데 표기만 다름 --
// 2R-ci-1의 role 대소문자 분리와 같은 계열 결함) 이 함수가 기존
// `REVIEW-r1..r8.md`를 하나도 못 세고 번호를 1부터 다시 매겨
// `review-r1.md`를 만들었다. Windows는 대소문자를 구별하지 않아 그
// 새 파일이 기존 `REVIEW-r1.md`를 그대로 덮어써 보존 사본 1건이
// 실제로 소실됐다(`.gitignore`로 미추적이라 git 복구도 불가 -- 실사고,
// 되돌리지 않는다). 정규식에 `i` 플래그를 붙여 role 대소문자와 무관하게
// 기존 사본 전부를 세도록 고친다 -- "동일 파일명 재사용을 막는다"는
// 이 함수의 유일한 계약을 대소문자에도 확장할 뿐, 다른 동작은 그대로다.
export function nextArchiveFileName(role, existingNames) {
  const pattern = new RegExp(`^${escapeForRegex(role)}-r(\\d+)\\.md$`, "i");
  let maxRound = 0;
  for (const name of existingNames) {
    const m = pattern.exec(name);
    if (m) {
      const n = Number(m[1]);
      if (n > maxRound) maxRound = n;
    }
  }
  return `${role}-r${maxRound + 1}.md`;
}

// HYK-244 gate-unblock-1 §1 조각1 비타협 안전장치: nextArchiveFileName이
// 계산한 다음 번호라도, 그 정확한 파일명이 대소문자만 다르게 이미
// 존재하면(예: 계산 결과 "review-r9.md"인데 디렉터리엔 "REVIEW-r9.md"가
// 이미 있음 -- TOCTOU 경합, 또는 위 수리 이전에 실제로 벌어졌던 것과
// 같은 계열의 불일치) 절대 조용히 덮어쓰지 않는다. ⚠️existsSync(path)
// 하나만으로는 부족하다 -- Windows는 대소문자를 구별하지 않아
// existsSync 자체가 이미 "있다"고 답해 버려 호출자가 그 판단을 신뢰할
// 수 없고, Linux(대소문자 구별, 이 결함의 진짜 반증 자리)에서는
// existsSync가 그 반대로 "없다"고 답해 이 안전장치가 있으나마나가
// 된다. 그래서 둘 다에서 동일하게 동작하도록, 이미 읽어 둔 디렉터리
// 목록(existingNames)을 대소문자 무관 문자열 비교로 직접 대조한다.
export function findCaseInsensitiveCollision(fileName, existingNames) {
  const lower = fileName.toLowerCase();
  return existingNames.find((name) => name.toLowerCase() === lower) ?? null;
}

// HYK-241 §2 조각1: task 파일(`<role>-task.md`) 쪽의 같은 덮어쓰기 문제 --
// 라운드마다 ORCH가 다음 task 파일을 같은 이름으로 다시 쓰면, 지금까지
// «우리가 무엇을 지시했는가»의 원문이 그 순간 사라진다(§1 실사고: 결과
// 파일은 archiveRoundEnvelope가 보존하는데 지시서는 그 대상이 아니었다).
// 별도 이름 패턴(`<role>-task-r<N>.md`)을 써서 nextArchiveFileName의 기존
// 계약(정확히 `<role>-r<N>.md`만 셈)과 절대 충돌하지 않는다 -- 두 정규식
// 모두 상대방의 파일명을 매치하지 않는다(태그 사이에 반드시 `-task-`가
// 끼어 있어야 함).
export function nextTaskArchiveFileName(role, existingNames) {
  const pattern = new RegExp(
    `^${escapeForRegex(role)}-task-r(\\d+)\\.md$`,
    "i",
  );
  let maxRound = 0;
  for (const name of existingNames) {
    const m = pattern.exec(name);
    if (m) {
      const n = Number(m[1]);
      if (n > maxRound) maxRound = n;
    }
  }
  return `${role}-task-r${maxRound + 1}.md`;
}

const DROPPED_AT_RE_G = /^dropped_at:\s*(.+)$/gim;

// Metadata-only extraction, mirrors extractDoneAt below (ambiguous -> "unknown"
// rather than guessing).
function extractDroppedAt(taskContent) {
  const matches = [...taskContent.matchAll(DROPPED_AT_RE_G)];
  return matches.length === 1 ? matches[0][1].trim() : "unknown";
}

// Writes a verbatim copy of `taskContent` under
// `<harnessDir>/rounds/<role>-task-r<N>.md` -- the TASK-file sibling of
// archiveRoundEnvelope above. ⛔봉투 형식(계약)은 여기서도 바꾸지 않는다:
// `<role>-task.md` 자체는 절대 쓰지/지우지 않는다 -- 보존은 항상 "추가"다.
// Never throws -- same contract as archiveRoundEnvelope (a failure to
// archive must not block the handshake decision that triggered it).
export function archiveRoundTaskFile({
  role,
  taskContent,
  harnessDir,
  dispatchId: providedDispatchId,
  readdirFn = readdirSync,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  existsFn = existsSync,
}) {
  if (typeof role !== "string" || role === "") {
    return {
      ok: false,
      reason:
        "envelope-archive: role missing -- cannot preserve round task file",
    };
  }
  if (typeof taskContent !== "string") {
    return {
      ok: false,
      reason:
        "envelope-archive: taskContent missing -- cannot preserve round task file",
    };
  }
  const archiveDir = join(harnessDir, ARCHIVE_SUBDIR);
  try {
    if (!existsFn(archiveDir)) {
      mkdirFn(archiveDir, { recursive: true });
    }
    const existing = readdirFn(archiveDir);
    const fileName = nextTaskArchiveFileName(role, existing);
    // HYK-204 2R이 이미 기재한 TOCTOU 창(readdirSync와 writeFileSync
    // 사이, 파일 상단 주석 참조)을 좁히려고 쓰기 직전에 디렉터리를
    // 한 번 더 읽는다 -- 위 `existing`(번호 계산용 스냅샷)을 재사용하지
    // 않는다. 그 스냅샷을 그대로 대조하면 fileName은 항상 그 목록 안의
    // 무엇과도 case-insensitive로 같을 수 없어(정의상 max+1) 이 안전장치
    // 자체가 죽은 코드가 된다 -- 반드시 "새로 다시 읽은" 목록과 대조해야
    // 그 사이에 다른 프로세스가 만든 파일을 실제로 잡을 수 있다.
    const collision = findCaseInsensitiveCollision(
      fileName,
      readdirFn(archiveDir),
    );
    if (collision) {
      return {
        ok: false,
        reason: `envelope-archive: refusing to overwrite -- destination '${fileName}' collides (case-insensitive) with existing '${collision}'`,
      };
    }
    const destPath = join(archiveDir, fileName);
    const droppedAt = extractDroppedAt(taskContent);
    // HYK-396 §2/§3 (Q1 실측 근거: 이 헤더는 이 라운드가 배달되는 taskContent
    // 자체를 스냅숏하는 유일한 지점인데, 여기서 dispatch_id는 원리적으로
    // 아직 모른다 -- 이 CLI(dispatch-gate-decision.mjs의
    // bestEffortSnapshotRoundTaskFile)는 실물 앵커(dispatch-worker.ps1:171)가
    // 실제 `orca orchestration dispatch`를 부르기 «전»에 돈다, dispatch_id는
    // 그 호출의 응답에만 있다. ⛔값을 지어내지 않는다(coder-task.md §3 Q2) --
    // 호출자가 안 주면 리터럴 "unknown"을 적어 "모른다"는 사실 자체를
    // 남긴다(extractDroppedAt의 기존 "unknown" 관례와 동일). 실제 값은
    // stampDispatchIdOnLatestArchivedTaskFile(아래)이 배달 «직후»(dispatch_id를
    // 실제로 아는 순간) 이 파일을 다시 열어 덮어쓴다 -- 관제실 패치 제안
    // 문서 참조(docs/control-room-patches/HYK-396-dispatch-id-stamp.md).
    const dispatchId = isNonEmptyStringLocal(providedDispatchId)
      ? providedDispatchId
      : "unknown";
    const header = `<!-- envelope-archive: role=${role} kind=task dropped_at=${droppedAt} dispatch_id=${dispatchId} -->\n`;
    writeFileFn(destPath, header + taskContent, "utf8");
    return {
      ok: true,
      reason: `envelope-archive: ${role} round TASK file preserved -> ${join(ARCHIVE_SUBDIR, fileName)}`,
      path: destPath,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `envelope-archive: failed to preserve ${role} round task file (${err.message})`,
    };
  }
}

// HYK-307-order-1 §1: archiveRoundTaskFile always assigns the NEXT
// incrementing round number and writes -- calling it twice for the SAME
// round's content (once at delivery time via the new dispatch-gate
// snapshot below, once at the normal successful-consumption archive that
// already existed before this track) would create two archive copies of
// identical content. Not a data-loss bug (nothing is overwritten -- the
// existing collision guard already refuses that), just a wasteful
// duplicate that also shifts round numbering. This header-stripping
// comparison lets a caller ask "is this exact content already preserved?"
// before calling archiveRoundTaskFile, so a second call for an unchanged
// round becomes a no-op instead of a second file.
const ARCHIVE_HEADER_LINE_RE = /^<!-- envelope-archive:[^\n]*-->\n/;

function stripArchiveHeader(fileText) {
  return fileText.replace(ARCHIVE_HEADER_LINE_RE, "");
}

// Scans `<harnessDir>/rounds/<role>-task-r*.md` (role match case-insensitive,
// same convention as nextTaskArchiveFileName/findCaseInsensitiveCollision
// above) for an existing archive whose body (header line stripped) is
// byte-identical to `taskContent`. Never throws -- an unreadable archive
// dir/file is treated as "no match found" (fail toward archiving, not
// toward silently skipping a round that in fact isn't preserved yet).
export function hasIdenticalArchivedTaskFile({
  role,
  taskContent,
  harnessDir,
  readdirFn = readdirSync,
  readFileFn = readFileSync,
}) {
  const archiveDir = join(harnessDir, ARCHIVE_SUBDIR);
  let names;
  try {
    names = readdirFn(archiveDir);
  } catch {
    return false;
  }
  const pattern = new RegExp(
    `^${escapeForRegex(role)}-task-r(\\d+)\\.md$`,
    "i",
  );
  for (const name of names) {
    if (!pattern.test(name)) continue;
    let body;
    try {
      body = stripArchiveHeader(readFileFn(join(archiveDir, name), "utf8"));
    } catch {
      continue;
    }
    if (body === taskContent) return true;
  }
  return false;
}

// Thin wrapper around archiveRoundTaskFile: skips the write (ok:true,
// skipped:true) when an archive with IDENTICAL content already exists for
// this role, otherwise delegates unchanged. archiveRoundTaskFile itself is
// untouched (⛔기존 계약 변경 금지) -- every existing caller/test of that
// function keeps its exact current behavior; this is a new, additive entry
// point for callers (the dispatch-gate delivery-time snapshot, §1) that
// need "preserve this round's text, but don't duplicate it" semantics.
export function archiveRoundTaskFileIfNew({
  role,
  taskContent,
  harnessDir,
  dispatchId,
  readdirFn = readdirSync,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  existsFn = existsSync,
  readFileFn = readFileSync,
}) {
  if (
    typeof role === "string" &&
    role !== "" &&
    typeof taskContent === "string" &&
    hasIdenticalArchivedTaskFile({
      role,
      taskContent,
      harnessDir,
      readdirFn,
      readFileFn,
    })
  ) {
    return {
      ok: true,
      skipped: true,
      reason: `envelope-archive: ${role} round TASK file content already preserved (identical snapshot exists in ${ARCHIVE_SUBDIR}/) -- skipped duplicate`,
    };
  }
  return {
    ...archiveRoundTaskFile({
      role,
      taskContent,
      harnessDir,
      dispatchId,
      readdirFn,
      mkdirFn,
      writeFileFn,
      existsFn,
    }),
    skipped: false,
  };
}

const DONE_RE_G = /^>>>\s*DONE:.*@\s*(.+?)\s*$/gim;

// Metadata-only extraction (never used for pass/fail decisions -- that's
// relay-handshake.mjs's job). Ambiguous (0 or >=2 matches) falls back to
// "unknown" rather than guessing which one is real; this header is a
// convenience label on the archive copy, not a second source of truth.
function extractDoneAt(resultContent) {
  const matches = [...resultContent.matchAll(DONE_RE_G)];
  return matches.length === 1 ? matches[0][1].trim() : "unknown";
}

// Writes a verbatim copy of `resultContent` under
// `<harnessDir>/rounds/<role>-r<N>.md`, N picked by nextArchiveFileName so
// two calls for the same role never land on the same file (§4 변조 ⓑ's
// exact regression). Never throws -- a failure to archive must not block
// the handshake/gate decision that triggered it; callers log `reason`.
export function archiveRoundEnvelope({
  role,
  resultContent,
  harnessDir,
  readdirFn = readdirSync,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  existsFn = existsSync,
}) {
  if (typeof role !== "string" || role === "") {
    return {
      ok: false,
      reason: "envelope-archive: role missing -- cannot preserve round",
    };
  }
  if (typeof resultContent !== "string") {
    return {
      ok: false,
      reason:
        "envelope-archive: resultContent missing -- cannot preserve round",
    };
  }
  const archiveDir = join(harnessDir, ARCHIVE_SUBDIR);
  try {
    if (!existsFn(archiveDir)) {
      mkdirFn(archiveDir, { recursive: true });
    }
    const existing = readdirFn(archiveDir);
    const fileName = nextArchiveFileName(role, existing);
    // TOCTOU 창을 좁히려고 쓰기 직전 재확인 -- archiveRoundTaskFile 위와
    // 같은 이유(번호 계산용 스냅샷 재사용 금지).
    const collision = findCaseInsensitiveCollision(
      fileName,
      readdirFn(archiveDir),
    );
    if (collision) {
      return {
        ok: false,
        reason: `envelope-archive: refusing to overwrite -- destination '${fileName}' collides (case-insensitive) with existing '${collision}'`,
      };
    }
    const destPath = join(archiveDir, fileName);
    const doneAt = extractDoneAt(resultContent);
    const header = `<!-- envelope-archive: role=${role} archived_at=${doneAt} -->\n`;
    writeFileFn(destPath, header + resultContent, "utf8");
    return {
      ok: true,
      reason: `envelope-archive: ${role} round preserved -> ${join(ARCHIVE_SUBDIR, fileName)}`,
      path: destPath,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `envelope-archive: failed to preserve ${role} round (${err.message})`,
    };
  }
}

// HYK-461 §4-C: this round's runner receipt, preserved next to the round
// copy. Naming: `<role>-r<N>-runner-receipt.json`, co-located under `rounds/`
// with the round copy and sharing its round number N (derived from the round
// copy's own filename) -- deliberately NOT `receipts/<role>-receipt-r<N>.json`,
// which is a DIFFERENT schema (the consumption receipt, consumption-receipt-
// writer.mjs) living under a different directory (coder-task.md §4-C 요구:
// 기존 소비 영수증 관례와 충돌 금지). The live source is `<harnessDir>/
// runner-receipt.json` (runner-receipt-writer.mjs's RUNNER_RECEIPT_FILENAME --
// the literal is duplicated here rather than imported, to keep this module's
// zero-repo-import closure intact so it stays cheap to stage into the ~14
// isolated fixtures that already copy it, coder.md §4-A). Best-effort:
// returns {path:null} on any failure shape (no live receipt, unreadable,
// name collision, write failure) so a receipt-preservation problem never
// blocks or fails the round-copy write that is this function's real job.
const RUNNER_RECEIPT_LIVE_FILENAME = "runner-receipt.json";
// 이 라운드 결과 본문(및 러너 영수증 JSON)의 head_commit 결속 대조용
// (retirement-block-reason-shared.mjs의 CONSUMPTION_HEAD_COMMIT_RE_G와
// 바이트 동일한 계약 -- 40자 hex, 줄머리 `head_commit:` 표지만 인정).
const RESULT_HEAD_COMMIT_RE_G = /^head_commit:[ \t]*([0-9a-fA-F]{40})[ \t]*$/gm;

function roundRunnerReceiptFileName(roundFileName) {
  return roundFileName.replace(/\.md$/i, "-runner-receipt.json");
}

function extractSoleHeadCommit(text) {
  const m = [...text.matchAll(RESULT_HEAD_COMMIT_RE_G)];
  return m.length === 1 ? m[0][1].toLowerCase() : null;
}

// HYK-461 2R §2-C (검토 P2, 채택 = 옵션 1 «대조하고 불일치면 건너뛰고 사유
// 남김»): 보존하려는 영수증의 `head_commit`이 이 라운드 결과 본문의
// `head_commit:`과 대조된다. 근거: 이 영수증은 나중에 RUNNER_GREEN_
// UNREACHABLE_AT_HEAD 은퇴의 evidenceReceiptPath로 쓰일 수 있고, 그 재확인
// (confirmRunnerGreenUnreachableAtHead)은 «영수증 head == 결과 head»를
// 요구한다. 만약 라운드 사본을 남기는 순간 live 슬롯에 «다른 라운드»의
// 영수증이 앉아 있으면(러너가 이 라운드에서 아직 안 돌았거나 다음 라운드가
// 먼저 덮음), 그 엉뚱한 영수증을 이 라운드 사본에 결속해 두는 것은 미래
// 은퇴를 조용히 오도한다. ⇒ 대조가 «불일치»면 보존을 건너뛰고 그 사실을
// reason에 남긴다(⛔조용히 넘어가지 않는다). 옵션 2(불일치면 실패)를 쓰지
// 않은 이유: 이 함수는 best-effort/추가 전용이고, 영수증 결속 문제로 라운드
// «사본»(본업) 보존까지 막는 것은 과하다. 대조가 «불가»(본문에 head_commit이
// 없거나 여럿·영수증 JSON이 깨짐·head_commit 없음)면 «확정 불일치»가 아니므로
// 보존하되 reason에 「대조 불가」를 남긴다(그 영수증을 실제로 쓰는 재확인
// 단계가 어차피 head 대조를 다시 하므로 안전측 거부로 수렴한다).
function classifyReceiptHeadBinding(receiptRaw, resultContent) {
  const resultHead = extractSoleHeadCommit(resultContent);
  let receiptHead = null;
  try {
    const parsed = JSON.parse(receiptRaw);
    if (typeof parsed?.head_commit === "string") {
      receiptHead = parsed.head_commit.toLowerCase();
    }
  } catch {
    receiptHead = null;
  }
  if (resultHead === null || receiptHead === null) {
    return { verdict: "unverifiable", resultHead, receiptHead };
  }
  return {
    verdict: resultHead === receiptHead ? "match" : "mismatch",
    resultHead,
    receiptHead,
  };
}

function preserveRoundRunnerReceipt({
  fileName,
  harnessDir,
  archiveDir,
  resultContent,
  readFileFn,
  writeFileFn,
  existsFn,
}) {
  let receiptRaw;
  try {
    receiptRaw = readFileFn(
      join(harnessDir, RUNNER_RECEIPT_LIVE_FILENAME),
      "utf8",
    );
  } catch {
    return {
      path: null,
      reason: "no live runner-receipt.json to preserve (skipped)",
    };
  }
  // HYK-461 2R §2-C: head_commit 결속 대조 -- 확정 불일치면 보존 건너뜀.
  const binding = classifyReceiptHeadBinding(receiptRaw, resultContent);
  if (binding.verdict === "mismatch") {
    return {
      path: null,
      reason: `runner receipt head_commit (${binding.receiptHead}) != this round result head_commit (${binding.resultHead}) -- live runner-receipt.json belongs to a DIFFERENT round, refusing to bind a wrong receipt to this round (skipped, HYK-461 2R §2-C)`,
    };
  }
  const receiptName = roundRunnerReceiptFileName(fileName);
  const destPath = join(archiveDir, receiptName);
  // 라운드 사본 번호(N)를 그대로 물려받으므로 정상 흐름에서 이 이름은
  // 새 것이지만, 동일 이름이 이미 있으면(경합·재실행) 절대 조용히 덮지
  // 않는다 -- 보존은 언제나 "추가"다(archiveRoundEnvelope와 같은 계약).
  if (existsFn(destPath)) {
    return {
      path: null,
      reason: `runner receipt '${receiptName}' already exists -- not overwriting (skipped)`,
    };
  }
  try {
    writeFileFn(destPath, receiptRaw, "utf8");
  } catch (err) {
    return {
      path: null,
      reason: `failed to preserve runner receipt (${err.message})`,
    };
  }
  const bindingNote =
    binding.verdict === "unverifiable"
      ? " (head_commit 대조 불가 -- 본문/영수증 head_commit 부재·모호, 그대로 보존)"
      : "";
  return {
    path: join(ARCHIVE_SUBDIR, receiptName),
    reason: `runner receipt preserved -> ${join(ARCHIVE_SUBDIR, receiptName)}${bindingNote}`,
  };
}

// HYK-461 §4-A: single source of truth for the envelope-binding READ-BACK
// validator -- the inverse of archiveUnconsumedRoundEnvelope's write-side
// (which stamps `kind=unconsumed_result content_sha256=<sha>` into the header
// below). It lived as a copy in dispatch-gate-decision.mjs (canonical
// consumption gate) with NO copy at all in admission-completion-adapter.mjs's
// resolveRetirementArchiveCandidateForAdapter -- so the adapter passed
// envelopeBindingValid===undefined and the core's `=== false` guard never
// fired on the adapter's retirement-release path (HYK-456 §5-1's reported
// wiring gap: a forged/hand copy header sailed through the second consumer).
//
// Why HOME it here in the producer module rather than a new *-shared.mjs
// sibling (the ledger-pointer-shared.mjs / retirement-block-reason-shared.mjs
// convention): (1) the validator's contract IS the exact header format this
// file writes -- keeping the reader beside the writer is the tightest
// single-source and the drift this dedup exists to kill can only happen if
// the two are apart; (2) this module is ALREADY a staged sibling in every
// isolated fixture that copies dispatch-gate-decision.mjs (HYK-307) or
// relay-handshake.mjs (relay-handshake-fixture-siblings.mjs), so deduping
// here adds ZERO staging churn on those ~14 sites -- only the small set of
// fixtures that stage a synthetic admission-completion-adapter.mjs needs this
// file added to their sibling list (the exact HYK-457 MODULE_NOT_FOUND-17
// hazard, avoided by choosing an already-staged home). A dedicated new
// *-shared.mjs would have re-opened that hazard on ~15 sites for no gain.
//
// Returns true | false | null:
//   null  -- no envelope header, or a header whose kind != unconsumed_result
//            (old consumption-success archives, or fixtures that never declare
//            the field): this axis does not apply -> regression 0.
//   false -- kind=unconsumed_result IS declared but content_sha256 is absent,
//            or present-but-mismatched against the recomputed body sha (hand
//            copy or damaged copy).
//   true  -- field present and matches the header-stripped body's sha256.
const ARCHIVE_ENVELOPE_HEADER_LINE_ANY_RE =
  /^<!-- envelope-archive:[^\n]*-->\n/;
const ARCHIVE_ENVELOPE_KIND_RE = /[ \t]kind=(\S+)/;
const ARCHIVE_ENVELOPE_CONTENT_SHA256_RE =
  /[ \t]content_sha256=([0-9a-fA-F]{64})\b/;

export function resolveEnvelopeBindingValidity(raw, strippedBody) {
  const headerMatch = raw.match(ARCHIVE_ENVELOPE_HEADER_LINE_ANY_RE);
  if (!headerMatch) return null;
  const headerLine = headerMatch[0];
  const kindMatch = headerLine.match(ARCHIVE_ENVELOPE_KIND_RE);
  if (!kindMatch || kindMatch[1] !== "unconsumed_result") return null;
  const shaMatch = headerLine.match(ARCHIVE_ENVELOPE_CONTENT_SHA256_RE);
  if (!shaMatch) return false;
  const claimed = shaMatch[1].toLowerCase();
  return (
    claimed === createHash("sha256").update(strippedBody, "utf8").digest("hex")
  );
}

// HYK-455 §1 (확대 라운드) -- «미소비» 라운드 보존 사본 designed path.
//
// archiveRoundEnvelope(바로 위)는 오직 CONFIRMED(소비 성공, checkRelayHandshake
// ok:true 또는 review-gate 커밋 승인) 라운드만 안다 -- 이 파일 §1 헤더의
// "핸드셰이크 자체가 실패한 라운드는 원문이 전혀 남지 않는다 … 이 트랙은
// 이 구멍을 고치지 않는다" 자백이 가리키는 바로 그 구멍이다. 이 함수는
// 그 구멍을 위해 «추가로» 여는 문이다 -- archiveRoundEnvelope의 계약을
// 그대로 물려받는다(추가 전용 · `<role>.md` 무접촉 · never throws · 같은
// `rounds/<ROLE>-r<N>.md` 파일 시리즈 재사용, nextArchiveFileName/
// findCaseInsensitiveCollision 그대로 공유 -- 두 함수가 같은 role에 대해
// 번호를 다투면 항상 최댓값+1을 매기므로 파일명이 절대 충돌하지 않는다).
//
// 왜 헤더에 content_sha256을 새기는가(coder-task.md §1-4 "이 문을 열면
// «아카이브는 소비 성공 시에만 생긴다»는 사실상의 방어가 사라진다" 그대로):
// 소비 게이트(dispatch-gate-decision.mjs의 resolveEnvelopeBindingValidity)가
// 이 값을 몸통에서 다시 계산해 재확인한다 -- 값을 정직하게 채우지 않은
// (또는 헤더 모양만 흉내 내고 계산은 안 한) 손 사본을 기계가 구조적으로
// 구별할 수 있게 하기 위해서다. ⛔완전한 위조 방지가 «아니다» -- 공격자가
// SHA-256을 직접 계산해 넣으면 이 앵커도 재현 가능하다(retirement-record-
// core.mjs §5-b/§5-d와 같은 계열의 한계, `.harness/coder.md` 정직 한계
// 절 참조). 이 함수는 "실수·게으른 손 사본"을 막는 문턱일 뿐, 사려 깊은
// 위조자를 막는 암호학적 서명이 아니다.
//
// 헤더 필드 순서(`role=… archived_at=… kind=unconsumed_result
// content_sha256=…`)는 일부러 archiveRoundEnvelope의 옛 헤더 정규식
// (dispatch-gate-decision.mjs의 ARCHIVE_ENVELOPE_HEADER_RE, `role=\S+
// archived_at=.*? -->`)과 «호환»되게 골랐다 -- `archived_at=` 뒤의 lazy
// `.*?`가 추가 필드(`kind=… content_sha256=…`)를 통째로 삼키고 마지막
// ` -->`에서 멈추므로, stripArchiveEnvelopeHeader는 이 새 헤더도 옛
// 헤더와 똑같이 한 줄로 벗겨낸다(정규식을 고칠 필요가 없다 -- 회귀 0).
export function archiveUnconsumedRoundEnvelope({
  role,
  resultContent,
  harnessDir,
  readdirFn = readdirSync,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  existsFn = existsSync,
  readFileFn = readFileSync,
}) {
  if (typeof role !== "string" || role === "") {
    return {
      ok: false,
      reason:
        "envelope-archive: role missing -- cannot preserve unconsumed round",
    };
  }
  if (typeof resultContent !== "string") {
    return {
      ok: false,
      reason:
        "envelope-archive: resultContent missing -- cannot preserve unconsumed round",
    };
  }
  const archiveDir = join(harnessDir, ARCHIVE_SUBDIR);
  try {
    if (!existsFn(archiveDir)) {
      mkdirFn(archiveDir, { recursive: true });
    }
    const existing = readdirFn(archiveDir);
    const fileName = nextArchiveFileName(role, existing);
    // TOCTOU 창을 좁히려고 쓰기 직전 재확인 -- archiveRoundEnvelope와 같은
    // 이유(번호 계산용 스냅샷 재사용 금지).
    const collision = findCaseInsensitiveCollision(
      fileName,
      readdirFn(archiveDir),
    );
    if (collision) {
      return {
        ok: false,
        reason: `envelope-archive: refusing to overwrite -- destination '${fileName}' collides (case-insensitive) with existing '${collision}'`,
      };
    }
    const destPath = join(archiveDir, fileName);
    const doneAt = extractDoneAt(resultContent);
    const contentSha256 = createHash("sha256")
      .update(resultContent, "utf8")
      .digest("hex");
    const header = `<!-- envelope-archive: role=${role} archived_at=${doneAt} kind=unconsumed_result content_sha256=${contentSha256} -->\n`;
    // HYK-455 §1 확대 라운드: 일부러 archiveRoundEnvelope의 쓰기 호출
    // (`header + resultContent`)과 다른 표현(`\`${header}${resultContent}\``)을
    // 쓴다 -- 문자 그대로는 다르지만 실행 결과는 완전히 같다. 이유:
    // envelope-archive-mutation.test.mjs의 "mutation ⓒ" 시험이
    // `assertExactlyOneMatch(src, '    writeFileFn(destPath, header + resultContent, "utf8");\n', ...)`
    // 로 그 정확한 리터럴이 파일 안에 «단 하나뿐»이어야 한다고 고정해
    // 뒀다(고의 -- 어느 줄을 변이시켜야 할지 모호해지지 않게). 두 번째
    // 문자 그대로 동일한 줄을 추가하면 그 시험이 "몇 번째 매치가
    // archiveRoundEnvelope의 것인지" 결정할 수 없어 회귀로 깨진다(실제로
    // 이 라운드 초안이 그렇게 깨졌었다, .harness/coder.md §10 참조) --
    // 그 시험 자체(archiveRoundEnvelope 전용, ⛔건드리지 않는다)를 살리려면
    // 이 함수의 같은 줄을 텍스트만 다르게 써야 한다.
    writeFileFn(destPath, `${header}${resultContent}`, "utf8");
    // HYK-461 §4-C: preserve THIS round's runner receipt alongside the round
    // copy, keyed to the same round number, so a later retirement's
    // record.evidenceReceiptPath can point at a copy the NEXT round's
    // runner-receipt.json overwrite cannot clobber -- the exact availability
    // failure HYK-456 §1-3/§3-3 measured (a RUNNER_GREEN_UNREACHABLE_AT_HEAD
    // retirement whose evidence receipt was overwritten by a later round so
    // confirmRunnerGreenUnreachableAtHead could never re-derive the fact).
    // Best-effort / additive / never throws (same contract as the round-copy
    // write above): no live receipt -> skip, and the receipt-preservation
    // outcome never turns this ok:true into ok:false. See preserveRoundRunnerReceipt.
    const receipt = preserveRoundRunnerReceipt({
      fileName,
      harnessDir,
      archiveDir,
      resultContent,
      readFileFn,
      writeFileFn,
      existsFn,
    });
    return {
      ok: true,
      // preserveRoundRunnerReceipt always returns a non-empty reason on every
      // path, so no ternary is needed here (keeps this function under the
      // complexity cap).
      reason: `envelope-archive: ${role} unconsumed round preserved (designed path, content_sha256=${contentSha256}) -> ${join(
        ARCHIVE_SUBDIR,
        fileName,
      )} | ${receipt.reason}`,
      path: destPath,
      contentSha256,
      runnerReceiptPath: receipt.path,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `envelope-archive: failed to preserve ${role} unconsumed round (${err.message})`,
    };
  }
}

// CLI 진입점 -- ORCH가 «은퇴 실행 순서상 맨 앞»(coder-task.md §1-3 설계
// 조건5)에서 직접 칠 수 있는 정본 명령. harnessDir 아래 살아있는
// `<role>.md`(소문자 role 파일명, 이 저장소의 기존 관례 -- relay-
// handshake.mjs/dispatch-gate-decision.mjs가 읽는 그 파일)를 그대로 읽어
// archiveUnconsumedRoundEnvelope에 넘긴다 -- 그 파일 자체는 절대 건드리지
// 않는다(읽기만).
if (
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/envelope-archive.mjs")
) {
  const mode = process.argv[2];
  const harnessDir = process.argv[3];
  const role = process.argv[4];
  if (mode !== "archive-unconsumed" || !harnessDir || !role) {
    console.error(
      "usage: node envelope-archive.mjs archive-unconsumed <harnessDir> <ROLE>",
    );
    process.exit(1);
  }
  const resultPath = join(harnessDir, `${role.toLowerCase()}.md`);
  let resultContent;
  try {
    resultContent = readFileSync(resultPath, "utf8");
  } catch (err) {
    console.error(
      `envelope-archive: cannot read ${resultPath} to archive (${err.message})`,
    );
    process.exit(1);
  }
  const outcome = archiveUnconsumedRoundEnvelope({
    role,
    resultContent,
    harnessDir,
  });
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
  process.exit(outcome.ok ? 0 : 1);
}

// HYK-396 §2/§3 -- the delivery-time-stamp completion HYK-394 punted here
// (그 라운드 헤더의 "완성은 HYK-396 예정" 그대로). archiveRoundTaskFile's
// header (위) is written BEFORE the actual `orca orchestration dispatch`
// call fires (dispatch-gate-decision.mjs's bestEffortSnapshotRoundTaskFile
// runs at the real anchor dispatch-worker.ps1:171, which is BEFORE the
// dispatch response that carries dispatch_id exists) -- so it can only ever
// write the literal "unknown" for dispatch_id at that instant (a real value
// there would be invented, forbidden by coder-task.md §3 Q2). This function
// is the second half: called once the real dispatch_id IS known (control
// room, right after the dispatch response returns -- see the patch proposal
// docs/control-room-patches/HYK-396-dispatch-id-stamp.md for exactly where),
// it finds THIS round's own snapshot (the highest-numbered
// `<role>-task-r<N>.md`, which is guaranteed to be the file
// bestEffortSnapshotRoundTaskFile just wrote for this exact delivery,
// because no other delivery for this role can occur between the gate call
// and the dispatch response in the real single-threaded ps1 flow) and
// rewrites its header's dispatch_id field in place -- the round-task
// snapshot's BODY (the task instructions themselves) is never touched,
// only the header line this module itself owns.
//
// One-shot: refuses (ok:false) to overwrite an already-real (non-"unknown")
// stamp with a DIFFERENT value -- a second call for the same archive file
// with a different dispatchId means either a retry raced with a new
// delivery already claiming this label's next round slot, or a forged call;
// either way, silently overwriting would erase the very binding this axis
// exists to protect (fail loud instead, never fail silent). A call carrying
// the SAME dispatchId as what's already stamped is a true no-op retry
// (ok:true, skipped:true) -- idempotent, matching archiveRoundTaskFileIfNew's
// house style.
const ARCHIVE_TASK_FILE_NAME_RE_TEMPLATE = (role) =>
  new RegExp(`^${escapeForRegex(role)}-task-r(\\d+)\\.md$`, "i");

const ARCHIVE_TASK_HEADER_LINE_RE = /^<!-- envelope-archive:[^\n]*-->\n/;
// HYK-396 2R §2 (P2 검토 rejected 사유 재현 방지): `\S+`(옛 정규식)는 `=`
// 바로 뒤가 공백이거나(빈 값·앞 공백 변형) 값 안에 공백이 섞이면 그
// 자리에서 매치 자체가 실패했다 -- 그 실패는 "필드가 있는데 값이 손상"과
// "필드가 아예 없음"을 구별하지 못하고 둘 다 조용히 undefined(=ABSENT)로
// 뭉갰다(검토자 실측: 빈 값·공백만·앞 공백 변형 셋 다 ALLOW로 새는 원인).
// `[^\n]*?`(줄바꿈 제외, lazy) + 뒤이은 리터럴 ` -->`로 바꿔 "다음 필드
// 구분자(닫는 주석)까지의 원문 그대로"를 무조건 캡처한다 -- 그 안에 무엇이
// 들었든(빈 문자열·공백·앞뒤 공백 섞인 값) 아래 classifyArchivedDispatchId가
// 「모른다」로 접지 않고 반드시 판정한다. ⛔이 정규식은 쓰기 쪽
// (computeStampedContent)도 함께 쓴다 -- 전체 매치(`[0]`)가 항상 ` -->`로
// 끝나므로, 치환 문자열에도 그 접미사를 그대로 되붙여야 헤더가 안 깨진다
// (아래 replace 호출부 참고).
const ARCHIVE_TASK_HEADER_DISPATCH_ID_RE = /dispatch_id=([^\n]*?) -->/;

// HYK-396 3R §1 Q1⑶ (검토자 실증 재현 방지): 두 번째 우회 -- 각인 값 뒤에
// 개행을 하나 심으면 ARCHIVE_TASK_HEADER_LINE_RE(줄바꿈을 절대 허용하지
// 않는 `[^\n]*`)가 헤더 전체를 매치하지 못해 headerMatch가 null이 되고,
// 옛 코드는 이를 "헤더 자체가 없음"(ABSENT)으로 접었다 -- 실제로는
// `<!-- envelope-archive:` 접두사가 버젓이 있는, 이 모듈이 만든 사본이
// 깨진 것이다(잘림·중복 필드도 같은 계열: "파싱 실패"이지 "없음"이
// 아니다). 접두사 존재 여부로 그 둘을 가른다 -- 접두사가 있는데 온전한
// 한 줄 헤더로 파싱되지 않으면 DAMAGED, 접두사 자체가 없으면(이 모듈이
// 손댄 적 없는 파일) 진짜 ABSENT다.
const ARCHIVE_TASK_HEADER_PREFIX = "<!-- envelope-archive:";
const DISPATCH_ID_FIELD_OCCURRENCE_RE = /dispatch_id=/g;

// HYK-396 2R §2 -- 헤더에서 dispatch_id를 "판정 가능한 셋 중 하나"로
// 분류한다. 순수 함수(파일 I/O 없음), extractArchivedDispatchId(아래)와
// checkArchivedDispatchIdBinding(dispatch-gate-decision.mjs)이 각각 다른
// 목적으로 이 판정을 쓴다 -- 전자는 "값이 있으면 무엇인지"만 궁금하고,
// 후자는 "손상(DAMAGED)이면 무조건 거부"라는 세 번째 갈래가 필요하다.
//   - ABSENT: 헤더 접두사 자체가 없거나(이 모듈이 만든 사본이 아님),
//     온전한 헤더인데 필드 자체가 없거나(이행 기간 옛 사본), 리터럴
//     "unknown"(배달 시점 미확정 스냅숏, 아직
//     stampDispatchIdOnLatestArchivedTaskFile이 못 돈 경우) -- 이 축을
//     건드리지 않는다(1R Q2 "값 부재 스킵", 검토 §1 "다시 하지 마라"
//     목록에 있는 회귀 0 계약 그대로 유지).
//   - DAMAGED: 헤더 접두사는 있는데 한 줄로 온전히 파싱되지 않거나(개행
//     삽입·잘림, 3R §1 Q1⑶), `dispatch_id=`가 두 번 이상 나타나거나(중복
//     필드, 어느 것이 진짜인지 결정 불가), 필드는 있는데 값이 트림 후
//     빈 문자열이거나(빈 값·공백만), 원문 자체가 트림 결과와 다르다(앞뒤
//     공백 섞인 변형, 2R §2) -- ★"없음"이 아니라 "손상"이다. 이 상태는
//     언제나 거부로 이어져야 한다(2R §2 P2 원문 그대로, 3R §1 Q1⑶로
//     범위 확장: "파싱 실패는 «없음»이 아니다").
//   - VALUE: 위 두 경우가 아닌, 앞뒤 공백 없는 순수 토큰 하나 -- 실값으로
//     취급한다(원장 값과의 일치 여부는 호출자 몫).
export function classifyArchivedDispatchId(content) {
  const headerMatch = content.match(ARCHIVE_TASK_HEADER_LINE_RE);
  if (!headerMatch) {
    return content.startsWith(ARCHIVE_TASK_HEADER_PREFIX)
      ? { kind: "DAMAGED" }
      : { kind: "ABSENT" };
  }
  const headerLine = headerMatch[0];
  const fieldOccurrences = (
    headerLine.match(DISPATCH_ID_FIELD_OCCURRENCE_RE) ?? []
  ).length;
  if (fieldOccurrences > 1) return { kind: "DAMAGED" };
  const idMatch = headerLine.match(ARCHIVE_TASK_HEADER_DISPATCH_ID_RE);
  if (!idMatch) return { kind: "ABSENT" };
  const raw = idMatch[1];
  if (raw === "unknown") return { kind: "ABSENT" };
  if (raw.trim().length === 0 || raw !== raw.trim()) {
    return { kind: "DAMAGED", raw };
  }
  return { kind: "VALUE", value: raw };
}

function findLatestArchivedTaskFileName(role, existingNames) {
  const pattern = ARCHIVE_TASK_FILE_NAME_RE_TEMPLATE(role);
  let bestRound = -1;
  let bestName;
  for (const name of existingNames) {
    const m = pattern.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (n > bestRound) {
      bestRound = n;
      bestName = name;
    }
  }
  return bestName ?? null;
}

// stampDispatchIdOnLatestArchivedTaskFile 자신의 eslint max-lines/
// complexity 상한을 지키려고 뽑았다(동작 변경 없음) -- 대상 파일을
// 찾고 읽는, 순수 I/O 부분만 담당한다.
function readLatestArchivedTaskFile(role, harnessDir, readdirFn, readFileFn) {
  const archiveDir = join(harnessDir, ARCHIVE_SUBDIR);
  let names;
  try {
    names = readdirFn(archiveDir);
  } catch (err) {
    return {
      ok: false,
      reason: `envelope-archive: cannot list ${archiveDir} to find this round's snapshot (${err.message})`,
    };
  }
  const fileName = findLatestArchivedTaskFileName(role, names);
  if (!fileName) {
    return {
      ok: false,
      reason: `envelope-archive: no ${role}-task-r*.md snapshot found in ${archiveDir} -- nothing to stamp (delivery-time snapshot must run first)`,
    };
  }
  const destPath = join(archiveDir, fileName);
  try {
    return { ok: true, destPath, content: readFileFn(destPath, "utf8") };
  } catch (err) {
    return {
      ok: false,
      reason: `envelope-archive: cannot read ${destPath} to stamp dispatch_id (${err.message})`,
    };
  }
}

// stampDispatchIdOnLatestArchivedTaskFile 자신의 eslint max-lines/
// complexity 상한을 지키려고 뽑았다(동작 변경 없음) -- 헤더 판독 +
// one-shot 판정 + 새 헤더 텍스트 계산까지, 파일 I/O가 전혀 없는 순수
// 함수(시험하기 쉽게 분리). 반환 모양: {ok:false, reason} | {ok:true,
// skipped, reason} | {ok:true, skipped:false, rewritten}.
function computeStampedContent(destPath, content, dispatchId) {
  const headerMatch = content.match(ARCHIVE_TASK_HEADER_LINE_RE);
  if (!headerMatch) {
    return {
      ok: false,
      reason: `envelope-archive: ${destPath} has no envelope-archive header line -- not a file this module produced, refusing to stamp`,
    };
  }
  const headerLine = headerMatch[0];
  const idMatch = headerLine.match(ARCHIVE_TASK_HEADER_DISPATCH_ID_RE);
  const existing = idMatch ? idMatch[1] : undefined;
  if (existing === dispatchId) {
    return {
      ok: true,
      skipped: true,
      reason: `envelope-archive: ${destPath} already stamped with dispatch_id=${dispatchId} -- no-op retry`,
    };
  }
  if (existing !== undefined && existing !== "unknown") {
    return {
      ok: false,
      reason: `envelope-archive: refusing to overwrite ${destPath}'s existing dispatch_id=${existing} with a different value (${dispatchId}) -- one-shot stamp, this looks like a race or a forged call`,
    };
  }
  // HYK-396 2R: ARCHIVE_TASK_HEADER_DISPATCH_ID_RE의 전체 매치(`[0]`)는
  // 이제 항상 ` -->`로 끝난다(위 정규식 자신의 헤더 주석 참조) -- 치환
  // 문자열에도 그 접미사를 그대로 되붙여야 헤더가 안 깨진다.
  const newHeaderLine = idMatch
    ? headerLine.replace(
        ARCHIVE_TASK_HEADER_DISPATCH_ID_RE,
        `dispatch_id=${dispatchId} -->`,
      )
    : headerLine.replace(/ -->\n$/, ` dispatch_id=${dispatchId} -->\n`);
  return {
    ok: true,
    skipped: false,
    rewritten: content.replace(ARCHIVE_TASK_HEADER_LINE_RE, newHeaderLine),
  };
}

export function stampDispatchIdOnLatestArchivedTaskFile({
  role,
  harnessDir,
  dispatchId,
  readdirFn = readdirSync,
  readFileFn = readFileSync,
  writeFileFn = writeFileSync,
}) {
  if (!isNonEmptyStringLocal(role)) {
    return {
      ok: false,
      reason: "envelope-archive: role missing -- cannot stamp dispatch_id",
    };
  }
  if (!isNonEmptyStringLocal(dispatchId)) {
    return {
      ok: false,
      reason:
        "envelope-archive: dispatchId missing -- refusing to invent a value (손기입 대체값 금지)",
    };
  }
  const found = readLatestArchivedTaskFile(
    role,
    harnessDir,
    readdirFn,
    readFileFn,
  );
  if (!found.ok) return found;
  const { destPath, content } = found;
  const computed = computeStampedContent(destPath, content, dispatchId);
  if (!computed.ok || computed.skipped) {
    return computed.ok ? { ...computed, path: destPath } : computed;
  }
  try {
    writeFileFn(destPath, computed.rewritten, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `envelope-archive: failed to write stamped dispatch_id to ${destPath} (${err.message})`,
    };
  }
  return {
    ok: true,
    skipped: false,
    reason: `envelope-archive: ${destPath} stamped with dispatch_id=${dispatchId}`,
    path: destPath,
  };
}

// Extraction counterpart of the above -- reads dispatch_id back out of an
// archived round-task snapshot's header. Returns undefined for "no header"/
// "no field"/literal "unknown" (ABSENT, §2 Q2 1R: absence is absence) AND
// for DAMAGED (empty/whitespace-only/surrounded-by-whitespace -- §2 Q2 2R:
// "손상"). ⛔이 thin wrapper만 쓰는 호출자는 ABSENT와 DAMAGED를 구별하지
// 못한다 -- DAMAGED를 반드시 별도로 다뤄야 하는 호출자(소비 판정 축,
// dispatch-gate-decision.mjs)는 classifyArchivedDispatchId를 직접 써야
// 한다(findArchivedRoundMeta가 그렇게 한다). 이 wrapper는 순수 "값이
// 있으면 무엇인지"만 궁금한 나머지 호출자·시험을 위해 남긴다.
export function extractArchivedDispatchId(content) {
  const classified = classifyArchivedDispatchId(content);
  return classified.kind === "VALUE" ? classified.value : undefined;
}
