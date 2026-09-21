// HYK-311-retire-1 §2 -- «은퇴 기록» 생산자.
//
// retirement-record-core.mjs가 확정한 계약(record.role/harnessTaskLabel/
// archivePath/archiveFingerprintClaimed/blockReasonCode/successorLabel 등)의
// 모양으로 실제 JSON 파일을 `<harnessDir>/retirements/<role>-retire-r<N>.json`
// 에 남긴다. ⛔이 모듈은 retirement-record-core.mjs의 판정 로직을 전혀
// 건드리지 않는다(import조차 하지 않는다 -- 생산자와 판정자는 별개 모듈,
// abort-record-writer.mjs가 abort-record-core.mjs를 import하지 않는 것과
// 동일한 선례). 이 파일이 만드는 JSON을 실제로 «검증»하는 것은 소비(게이트)
// 쪽의 몫이다 -- 이 writer 자신은 무엇도 미리 참이라고 가정하지 않는다
// (호출자 -- 사람이든 ORCH든 -- 가 실제로 관측한 사실을 그대로 옮겨 적을
// 뿐이다).
//
// ⛔이 모듈은 배달 게이트에 결선되지 않는다(abort-record-writer.mjs와
// 동일 원칙) -- dispatch-gate-decision.mjs가 이 파일이 남긴 JSON을 읽어
// 검증하는 것은 그 파일 쪽의 몫이다.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RETIREMENT_SUBDIR = "retirements";

// abort-record-writer.mjs의 escapeForRegex를 그대로 복제한다(같은 이유 --
// import할 값이 없는 모듈-지역 함수, 이 저장소의 기존 관례).
function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// abort-record-writer.mjs의 nextAbortFileName과 동일한 "이미 쌓인 개수를
// 세어 다음 번호를 매기는" 방식(대소문자 무관 -- 그 파일의 HYK-269 2R P1①
// 수리 이유를 그대로 물려받는다, Windows 대소문자 무관 충돌 방지).
export function nextRetirementFileName(role, existingNames) {
  const pattern = new RegExp(
    `^${escapeForRegex(role)}-retire-r(\\d+)\\.json$`,
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
  return `${role}-retire-r${maxRound + 1}.json`;
}

function findCaseInsensitiveCollisionLocal(target, names) {
  const lower = target.toLowerCase();
  for (const name of names) {
    if (name.toLowerCase() === lower && name !== target) return name;
  }
  return null;
}

// 은퇴 기록을 `<harnessDir>/retirements/<role>-retire-r<N>.json`에 쓴다.
// ⛔abort-record-writer.mjs/envelope-archive.mjs와 같은 계약: **Never
// throws** -- 기록을 못 쓰는 것이 호출자의 다른 작업을 막아서는 안 된다.
// 실패는 {ok:false, reason}으로만 알린다.
export function writeRetirementRecord({
  role,
  harnessDir,
  harnessTaskLabel,
  archivePath,
  archiveFingerprintClaimed,
  blockReasonCode,
  successorLabel,
  recordedAt,
  evidence,
  evidenceReceiptPath,
  readdirFn = readdirSync,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  existsFn = existsSync,
}) {
  if (typeof role !== "string" || role === "") {
    return {
      ok: false,
      reason: "retirement-record-writer: role missing -- cannot write record",
    };
  }
  try {
    const retirementsDir = join(harnessDir, RETIREMENT_SUBDIR);
    if (!existsFn(retirementsDir)) {
      mkdirFn(retirementsDir, { recursive: true });
    }
    const existing = readdirFn(retirementsDir);
    const fileName = nextRetirementFileName(role, existing);
    // TOCTOU 창을 좁힌다 -- abort-record-writer.mjs의 동일 수리와 같은
    // 이유(쓰기 직전 재확인).
    const collision = findCaseInsensitiveCollisionLocal(
      fileName,
      readdirFn(retirementsDir),
    );
    if (collision) {
      return {
        ok: false,
        reason: `retirement-record-writer: refusing to overwrite -- destination '${fileName}' collides (case-insensitive) with existing '${collision}'`,
      };
    }
    const destPath = join(retirementsDir, fileName);
    const record = {
      role,
      harnessTaskLabel,
      archivePath,
      archiveFingerprintClaimed,
      blockReasonCode,
      successorLabel,
      recordedAt,
      evidence,
      // HYK-455 §2 설계 조건 2 -- MECHANICALLY_CONFIRMABLE_BLOCK_REASONS의
      // RUNNER_GREEN_UNREACHABLE_AT_HEAD만 이 필드를 요구한다(어댑터가
      // 없으면 blockReasonConfirmed:false로 떨어뜨려 사실상 필수 필드로
      // 만든다, retirement-record-core.mjs 헤더 주석 참조) -- 나머지
      // 사유는 이 필드를 그냥 무시한다(undefined로 기록돼도 무해).
      // HYK-478: AUTHOR_SEAT_LOST_BEFORE_STAMP는 이 필드도, 어떤 새 필드도
      // 요구하지 않는다 -- 그 사유의 재확인(ⓐ 완료 표지 개수 · ⓑ admission
      // 원장 상태)은 이미 존재하는 값(role/harnessTaskLabel과 어댑터가
      // 별도로 이미 갖고 있는 admission 원장 경로)만으로 끝난다, 이 writer
      // 는 그 사유든 어떤 사유든 blockReasonCode를 그대로 옮겨 적을 뿐이다
      // (이 파일 헤더의 "무엇도 미리 참이라고 가정하지 않는다" 원칙 그대로).
      evidenceReceiptPath,
    };
    writeFileFn(destPath, JSON.stringify(record, null, 2) + "\n", "utf8");
    return {
      ok: true,
      reason: `retirement-record-writer: ${role} 라운드 은퇴 기록 작성 -> ${join(RETIREMENT_SUBDIR, fileName)}`,
      path: destPath,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `retirement-record-writer: failed to write ${role} round retirement record (${err.message})`,
    };
  }
}

// CLI 진입점. abort-record-writer.mjs와 동일한 이유로 payload를 argv
// 하나(JSON 문자열)로 받는다 -- 필드가 여럿이라 JSON으로 묶는다.
if (
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/retirement-record-writer.mjs")
) {
  const harnessDir = process.argv[2];
  const payloadJson = process.argv[3];
  if (!harnessDir || !payloadJson) {
    console.error(
      "usage: node retirement-record-writer.mjs <harnessDir> <payloadJson>",
    );
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err) {
    console.error(
      `retirement-record-writer: payload JSON not parseable: ${err.message}`,
    );
    process.exit(1);
  }
  const outcome = writeRetirementRecord({ ...payload, harnessDir });
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
  process.exit(outcome.ok ? 0 : 1);
}
