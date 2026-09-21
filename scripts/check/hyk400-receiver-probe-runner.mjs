// HYK-400 2R (I1) -- 이 파일은 판정기(hyk400-receiver-guard.mjs)의 부모
// 프로세스 «안에서는 절대» 실행되지 않는다. 언제나 별도 자식 프로세스로,
// `node --permission --allow-fs-read=<worktree 실경로>
// --allow-fs-write=<부모가 만든 응답 디렉터리>` (그 외 fs 쓰기·
// child_process·worker·addon·wasi는 전부 거부 상태) 로만 구동되고, 그
// 부모가 `execFileSync`의 `timeout`으로 감시한다(무한 top-level await·
// 무한 루프 대비, 적대 표본 ⓑ). 이 파일 자신은 신뢰 대상이다(저장소
// 추적 파일, 첫 인자로 받는 targetPath만 신뢰하지 않는다) -- 1R 검토가
// 잡은 P1-3("import 순간 최상위 코드가 실제로 파일을 썼다")는 이 파일이
// 스스로 대비하지 않는다. 격리는 «이 파일을 어떻게 실행하느냐»(부모의
// 프로세스 플래그)가 책임지고, 이 파일은 그 격리된 환경 안에서 대상을
// import해 순수 파서 함수만 두 번(베이스라인·플래그 포함) 호출한다.
//
// HYK-400 4R (I-ROOT, 1R/2R/3R 반려의 공통 뿌리 수리): 세 라운드 전부
// "부모가 «자식이 만들어낼 수 있는 바이트»를 신뢰 채널로 썼다"는 같은
// 결함이었다(1R 파싱 성공=이해 착각, 2R 죽은 자식의 stdout을 믿음, 3R
// 여러 줄 중 마지막 줄을 믿음). ⇒ stdout을 판정 채널에서 완전히 뺀다.
// 이 러너는 이제 부모가 «자신에게만» 넘겨준 응답 파일 경로에 결과를
// 쓴다 -- stdout에는 사람이 보는 진단 문구만 남기고(부모는 이를 절대
// 파싱하지 않는다), 판정에 쓰이는 유일한 바이트는 이 파일의 전체 내용
// 뿐이다(줄 단위로 자르지 않는다 -- `JSON.parse`가 전체 문자열을 요구
// 하므로 앞뒤 쓰레기·여러 줄은 그 자체로 파싱 실패가 된다).
//
// 쓰기는 `{ flag: "wx" }`(exclusive create)로 한다 -- 대상이 같은
// 프로세스 안에서 그 경로를 알아내 먼저 써 두면(아래 process.argv 삭제
// 참조) 이 러너의 정당한 쓰기가 EEXIST로 실패해 process가 비정상
// 종료하고, 부모의 I1′(3R) "종료 상태가 1차 축" 판정이 그 자체로
// 거부한다 -- 파일 내용을 굳이 대조할 필요가 없다.

import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

function writeResult(responsePath, payload) {
  writeFileSync(responsePath, JSON.stringify(payload), { flag: "wx" });
}

async function main() {
  const raw = process.argv[2];
  if (typeof raw !== "string" || raw.length === 0) {
    console.error("RECEIVER_CLI_PROBE_MALFORMED: 러너 입력 없음");
    process.exitCode = 2;
    return;
  }

  let input;
  try {
    input = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch (err) {
    console.error(
      `RECEIVER_CLI_PROBE_MALFORMED: 러너 입력 디코딩 실패(${err.message})`,
    );
    process.exitCode = 2;
    return;
  }

  const { targetPath, baselineArgs, flagArgs, responsePath } = input;
  if (typeof responsePath !== "string" || responsePath.length === 0) {
    console.error("RECEIVER_CLI_PROBE_MALFORMED: responsePath 없음");
    process.exitCode = 2;
    return;
  }

  // I-ROOT 하드닝(완전한 보장은 아니다 -- 정직 한계는 hyk400-receiver-
  // guard.mjs 헤더 주석 참조): 대상은 이 러너와 «같은 프로세스» 안에서
  // import되므로 process.argv를 그대로 두면 자신이 검사당하고 있다는
  // 사실과 응답 파일 경로를 스스로 읽어낼 수 있다. import 하기 «전»에
  // 원본 인자 문자열을 지운다.
  process.argv[2] = "[scrubbed]";

  let mod;
  try {
    mod = await import(pathToFileURL(targetPath).href);
  } catch (err) {
    // I1 실측(2026-08-30 프로토타입): 최상위에서 파일을 쓰려는 대상은
    // --permission이 ERR_ACCESS_DENIED를 던지고, 그 예외가 여기 import()의
    // reject로 그대로 전파된다 -- 실제 쓰기는 일어나지 않은 채로 이 경로에
    // 도달한다(부작용 0이 이 러너의 설계가 아니라 프로세스 자체의 능력
    // 결여로 보장됨, "우리 코드가 조심해서"가 아니다).
    writeResult(responsePath, {
      ok: false,
      reason: `RECEIVER_CLI_IMPORT_FAILED: ${err.message}`,
    });
    return;
  }

  if (typeof mod.parseDispatchReceiptArgs !== "function") {
    writeResult(responsePath, {
      ok: false,
      reason:
        "RECEIVER_CLI_CONTRACT_MISSING: parseDispatchReceiptArgs export 없음",
    });
    return;
  }

  let baseline;
  try {
    baseline = mod.parseDispatchReceiptArgs(baselineArgs, {});
  } catch (err) {
    writeResult(responsePath, {
      ok: false,
      reason: `RECEIVER_CLI_PROBE_THREW: baseline 호출 실패(${err.message})`,
    });
    return;
  }

  let withFlag;
  try {
    withFlag = mod.parseDispatchReceiptArgs(flagArgs, {});
  } catch (err) {
    writeResult(responsePath, {
      ok: false,
      reason: `RECEIVER_CLI_PROBE_THREW: flag 호출 실패(${err.message})`,
    });
    return;
  }

  writeResult(responsePath, { ok: true, baseline, withFlag });
}

main().catch((err) => {
  // 여기 도달 = 러너 자신의 예기치 못한 실패(예: writeResult 자체가
  // 던짐 -- EEXIST 포함). responsePath를 몰라 파일에 남길 수 없는
  // 경우도 있으므로 stderr에만 남기고, 비정상 종료 코드로 부모의
  // "종료 상태가 1차 축" 거부(I1′, 3R)에 맡긴다 -- stdout/stderr
  // 내용 자체는 부모가 판정에 쓰지 않는다.
  console.error(`RECEIVER_CLI_PROBE_CRASHED: ${err && err.message}`);
  process.exitCode = 3;
});
