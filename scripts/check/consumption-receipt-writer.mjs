// HYK-244-receipt-wire-2a §2 조각2 -- 소비 완료 영수증 «생산자».
//
// 1R(HYK-244-receipt-core-1~1d, 커밋 6c4a717)에서 `consumption-receipt-
// core.mjs`가 «영수증이 주어졌을 때 그것을 판정하는» 계약을 확정·승인
// 받았다. 이 모듈은 그 반대편 -- 실제 소비(`relay-handshake.mjs`의
// `checkRelayHandshake`)가 성공했을 때 그 계약이 요구하는 모양(binding
// 6성분 + effects + verdictLineCount)의 영수증을 **실제로 파일에 남긴다.**
//
// ⛔이 모듈은 `consumption-receipt-core.mjs`의 판정 로직을 전혀 건드리지
// 않는다(2R-a §3 금지) -- 그 코어를 import조차 하지 않는다(생산자와
// 판정자는 별개 모듈, 판정자의 zero-import 계약도 이 파일이 어떤 형태로
// 쓰든 깨지지 않는다). 이 파일이 만드는 JSON의 필드 이름은 그 코어의
// `checkConsumptionReceipt` facts 계약(코어 파일 268-274행 JSDoc)과 정확히
// 맞춘 것이며, 그 근거는 소비-측 시험(consumption-receipt-writer.test.mjs)
// 에서 실제로 그 코어에 넣어 PASS가 나오는 것으로 증명한다(2R-a §4-5).
//
// ⛔이 모듈은 배달 게이트에 결선되지 않는다(2R-a §3 금지, dispatch-gate-
// decision*.mjs 무수정) -- `relay-handshake.mjs`가 이 파일의
// `writeConsumptionReceipt`를 ok:true 분기에서 호출해 영수증을 "쌓아
// 두기만" 한다. 그 영수증을 실제로 읽어 배달을 막거나 통과시키는 일은
// 2R-b의 몫이다.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { findCaseInsensitiveCollision } from "./envelope-archive.mjs";

const RECEIPT_SUBDIR = "receipts";

// envelope-archive.mjs의 escapeForRegex(export 안 됨)를 그대로 복제한다 --
// role 문자열이 언젠가 정규식 특수문자를 포함해도 nextReceiptFileName의
// 패턴 조립이 깨지지 않게 하는 순수 헬퍼, import할 값이 없다(export되지
// 않은 모듈-지역 함수).
function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// reject-streak.mjs 26행의 VERDICT_LINE_RE_G를 그대로 복제한다(import하지
// 않는 이유: 그 상수 자체는 export되지 않고, `parseReviewOutcome`은 개수를
// 노출하지 않은 채 ok:false로 뭉뚱그린다 -- 이 writer는 consumption-
// receipt-core가 요구하는 "정확한 개수"(0/1/2+)가 필요하다).
const VERDICT_LINE_RE_G = /^verdict:\s*(approved|rejected)\s*$/gim;

// §2 조각2 지정: resultFingerprint = 결과 파일 내용의 SHA-256(hex).
export function computeResultFingerprint(resultContent) {
  return createHash("sha256").update(resultContent, "utf8").digest("hex");
}

// consumption-receipt-core.checkReviewVerdictLine이 세는 것과 정확히 같은
// 대상(REVIEW 계열 결과 파일의 'verdict: approved|rejected' 줄 개수)을
// 센다. REVIEW 계열이 아닌 role에서는 이 값이 무의미하지만(코어가 애초에
// 안 본다), 호출자가 role과 무관하게 넘겨도 안전하도록 항상 개수만 반환한다.
export function countVerdictLines(resultContent) {
  return [...resultContent.matchAll(VERDICT_LINE_RE_G)].length;
}

// envelope-archive.mjs의 nextArchiveFileName/nextTaskArchiveFileName과 같은
// "이미 쌓인 개수를 세어 다음 번호를 매기는" 방식 -- 같은 파일명 재사용
// (=덮어쓰기)을 막는 것이 유일한 계약이다. 그 두 함수와 겹치지 않는 새
// 패턴(`<role>-receipt-r<N>.json`)을 쓴다.
//
// HYK-269 2R P1① 수리 (검토자 실측: 소문자 coder-receipt-r1.json이 있는
// 상태에서 대문자 CODER로 소비하자 이 정규식이 그 기존 사본을 하나도 못
// 세고 번호를 1부터 다시 매겨 -- Windows가 대소문자를 구별하지 않아 그
// 새 파일이 기존 파일을 실제로 덮어썼다). envelope-archive.mjs의
// nextArchiveFileName이 HYK-244 gate-unblock-1에서 이미 겪고 고친 것과
// 정확히 같은 결함 계열이라, 그 수리(정규식에 `i` 플래그)를 그대로
// 옮겨 심는다 -- 새 설계를 만들지 않는다.
export function nextReceiptFileName(role, existingNames) {
  const pattern = new RegExp(
    `^${escapeForRegex(role)}-receipt-r(\\d+)\\.json$`,
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
  return `${role}-receipt-r${maxRound + 1}.json`;
}

// 소비 완료 영수증을 `<harnessDir>/receipts/<role>-receipt-r<N>.json`에
// 쓴다. 내용은 consumption-receipt-core.checkConsumptionReceipt의 후보
// 배열 원소 모양(binding/effects/verdictLineCount) 그 자체다 -- 2R-b는
// 이 파일들을 읽어 그대로 candidates 배열에 넣기만 하면 된다.
//
// ⛔envelope-archive.mjs의 archiveRoundEnvelope와 같은 계약: **Never
// throws** -- 영수증을 못 쓰는 것이 소비 판정 자체(checkRelayHandshake의
// 반환값)를 막아서는 안 된다(2R-a §3: "기존 반환값·exit 계약을 바꾸는
// 것이 이 조각의 목적이 아니다"). 실패는 {ok:false, reason}으로만
// 알린다 -- 호출자가 로그로 남긴다.
export function writeConsumptionReceipt({
  role,
  harnessDir,
  binding,
  effects,
  verdictLineCount,
  readdirFn = readdirSync,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  existsFn = existsSync,
}) {
  if (typeof role !== "string" || role === "") {
    return {
      ok: false,
      reason:
        "consumption-receipt-writer: role missing -- cannot write receipt",
    };
  }
  try {
    const receiptDir = join(harnessDir, RECEIPT_SUBDIR);
    if (!existsFn(receiptDir)) {
      mkdirFn(receiptDir, { recursive: true });
    }
    const existing = readdirFn(receiptDir);
    const fileName = nextReceiptFileName(role, existing);
    // HYK-269 2R P1① 수리: envelope-archive.mjs의 archiveRoundEnvelope/
    // archiveRoundTaskFile과 같은 두 번째 겹 -- 번호 계산에 쓴 스냅샷
    // (`existing`)을 재사용하지 않고 쓰기 직전 디렉터리를 다시 읽어
    // 대소문자 무관으로 충돌을 재확인한다(TOCTOU 창을 좁힌다, 그 두
    // 함수의 주석과 동일 근거). ⚠️existsSync만으로는 부족하다 --
    // Windows는 대소문자를 구별하지 않아 existsSync가 이미 "있다"고
    // 답해도 그 값 자체를 신뢰할 수 없고, Linux(이 결함의 진짜 반증
    // 자리)에서는 반대로 "없다"고 답해 안전장치가 있으나마나가 된다.
    const collision = findCaseInsensitiveCollision(
      fileName,
      readdirFn(receiptDir),
    );
    if (collision) {
      return {
        ok: false,
        reason: `consumption-receipt-writer: refusing to overwrite -- destination '${fileName}' collides (case-insensitive) with existing '${collision}' -- 사람이 확인할 것: 같은 role의 대소문자만 다른 영수증이 이미 있다(예: 소문자 소비 후 대문자로, 또는 그 반대로 다시 소비). 두 파일이 서로 다른 라운드라면 그대로 두고 다음 소비는 이 라운드가 끝난 뒤 재시도하라 -- 조용히 덮어쓰지 않는다`,
      };
    }
    const destPath = join(receiptDir, fileName);
    const receipt = { binding, effects, verdictLineCount };
    writeFileFn(destPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
    return {
      ok: true,
      reason: `consumption-receipt-writer: ${role} round consumption receipt written -> ${join(RECEIPT_SUBDIR, fileName)}`,
      path: destPath,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `consumption-receipt-writer: failed to write ${role} round receipt (${err.message})`,
    };
  }
}

// HYK-244 2R-a: CLI 진입점. relay-handshake.mjs가 이 함수를 정적 import로
// 불러오지 않고(zero-static-import) `execFileSync`로 이 CLI를 스폰하는
// 이유는 admission-completion-adapter.mjs의 spawnAdmissionCompletion과
// 정확히 같다 -- relay-handshake.mjs를 격리 clone하는 6개 변이 시험 파일
// (hyk186-time-authority-mutation.test.mjs 등)의 `stageTree()`가 고정된
// 파일 목록만 복사하므로, relay-handshake.mjs가 이 파일을 정적 import하면
// 그 목록에 없는 이 파일 때문에 모듈 로드 자체가 실패해 관련 없는 변이
// 시험 전부가 깨진다(그 파일들 자신의 헤더 주석이 이미 이 위험을 문서화
// 했다). 페이로드는 argv 하나(JSON 문자열)로 받는다 -- `execFileSync`는
// 셸을 거치지 않으므로 이스케이프 문제가 없다(admission-completion-
// adapter.mjs가 taskId 하나만 받는 것과 달리, 여기는 필드가 여럿이라
// JSON으로 묶는다).
if (
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/consumption-receipt-writer.mjs")
) {
  const harnessDir = process.argv[2];
  const payloadJson = process.argv[3];
  if (!harnessDir || !payloadJson) {
    console.error(
      "usage: node consumption-receipt-writer.mjs <harnessDir> <payloadJson>",
    );
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err) {
    console.error(
      `consumption-receipt-writer: payload JSON not parseable: ${err.message}`,
    );
    process.exit(1);
  }
  const outcome = writeConsumptionReceipt({
    role: payload.role,
    harnessDir,
    binding: payload.binding,
    effects: payload.effects,
    verdictLineCount: payload.verdictLineCount,
  });
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
  process.exit(outcome.ok ? 0 : 1);
}
