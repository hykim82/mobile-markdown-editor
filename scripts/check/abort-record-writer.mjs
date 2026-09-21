// HYK-298-abort-record-1 §2-1 -- «중단 기록» 생산자.
//
// abort-record-core.mjs가 확정한 계약(record.role/harnessTaskLabel/
// dispatchId/leftoverFingerprint 등)의 모양으로 실제 JSON 파일을
// `<harnessDir>/aborts/<role>-abort-r<N>.json`에 남긴다. ⛔이 모듈은
// abort-record-core.mjs의 판정 로직을 전혀 건드리지 않는다(import조차
// 하지 않는다 -- 생산자와 판정자는 별개 모듈, consumption-receipt-
// writer.mjs가 consumption-receipt-core.mjs를 import하지 않는 것과 동일한
// 선례). 이 파일이 만드는 JSON을 실제로 «검증»하는 것은 소비(게이트) 쪽의
// 몫이다 -- 이 writer 자신은 무엇도 미리 참이라고 가정하지 않는다(호출자
// -- 사람이든 ORCH든 -- 가 실제로 관측한 사실을 그대로 옮겨 적을 뿐).
//
// ⛔이 모듈은 배달 게이트에 결선되지 않는다(consumption-receipt-writer.mjs
// 와 동일 원칙) -- dispatch-gate-decision.mjs가 이 파일이 남긴 JSON을
// 읽어 검증하는 것은 그 파일 쪽의 몫이다.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ABORT_SUBDIR = "aborts";

// consumption-receipt-writer.mjs의 escapeForRegex를 그대로 복제한다(같은
// 이유 -- import할 값이 없는 모듈-지역 함수, 이 저장소의 기존 관례).
function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// consumption-receipt-writer.mjs의 nextReceiptFileName과 동일한 "이미 쌓인
// 개수를 세어 다음 번호를 매기는" 방식(대소문자 무관 -- 그 파일의
// HYK-269 2R P1① 수리 이유를 그대로 물려받는다, Windows 대소문자 무관
// 충돌 방지).
export function nextAbortFileName(role, existingNames) {
  const pattern = new RegExp(
    `^${escapeForRegex(role)}-abort-r(\\d+)\\.json$`,
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
  return `${role}-abort-r${maxRound + 1}.json`;
}

function findCaseInsensitiveCollisionLocal(target, names) {
  const lower = target.toLowerCase();
  for (const name of names) {
    if (name.toLowerCase() === lower && name !== target) return name;
  }
  return null;
}

// 중단 기록을 `<harnessDir>/aborts/<role>-abort-r<N>.json`에 쓴다.
// ⛔envelope-archive.mjs/consumption-receipt-writer.mjs와 같은 계약:
// **Never throws** -- 기록을 못 쓰는 것이 호출자의 다른 작업을 막아서는
// 안 된다. 실패는 {ok:false, reason}으로만 알린다.
export function writeAbortRecord({
  role,
  harnessDir,
  harnessTaskLabel,
  dispatchId,
  droppedAt,
  leftoverFingerprint,
  leftoverPath,
  recordedAt,
  evidence,
  readdirFn = readdirSync,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  existsFn = existsSync,
}) {
  if (typeof role !== "string" || role === "") {
    return {
      ok: false,
      reason: "abort-record-writer: role missing -- cannot write record",
    };
  }
  try {
    const abortsDir = join(harnessDir, ABORT_SUBDIR);
    if (!existsFn(abortsDir)) {
      mkdirFn(abortsDir, { recursive: true });
    }
    const existing = readdirFn(abortsDir);
    const fileName = nextAbortFileName(role, existing);
    // TOCTOU 창을 좁힌다 -- consumption-receipt-writer.mjs의 동일 수리와
    // 같은 이유(쓰기 직전 재확인).
    const collision = findCaseInsensitiveCollisionLocal(
      fileName,
      readdirFn(abortsDir),
    );
    if (collision) {
      return {
        ok: false,
        reason: `abort-record-writer: refusing to overwrite -- destination '${fileName}' collides (case-insensitive) with existing '${collision}'`,
      };
    }
    const destPath = join(abortsDir, fileName);
    const record = {
      role,
      harnessTaskLabel,
      dispatchId,
      droppedAt,
      leftoverFingerprint,
      leftoverPath,
      recordedAt,
      evidence,
    };
    writeFileFn(destPath, JSON.stringify(record, null, 2) + "\n", "utf8");
    return {
      ok: true,
      reason: `abort-record-writer: ${role} 라운드 중단 기록 작성 -> ${join(ABORT_SUBDIR, fileName)}`,
      path: destPath,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `abort-record-writer: failed to write ${role} round abort record (${err.message})`,
    };
  }
}

// CLI 진입점. consumption-receipt-writer.mjs와 동일한 이유로 payload를
// argv 하나(JSON 문자열)로 받는다 -- 필드가 여럿이라 JSON으로 묶는다.
if (
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/abort-record-writer.mjs")
) {
  const harnessDir = process.argv[2];
  const payloadJson = process.argv[3];
  if (!harnessDir || !payloadJson) {
    console.error(
      "usage: node abort-record-writer.mjs <harnessDir> <payloadJson>",
    );
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err) {
    console.error(
      `abort-record-writer: payload JSON not parseable: ${err.message}`,
    );
    process.exit(1);
  }
  const outcome = writeAbortRecord({ ...payload, harnessDir });
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
  process.exit(outcome.ok ? 0 : 1);
}
