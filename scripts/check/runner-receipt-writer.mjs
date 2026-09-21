// HYK-411 1R -- «러너가 자기 종료코드를 자기 손으로 적는» 영수증 생산자.
//
// §1 왜: `npm test 2>&1 | tail -N` 형태의 파이프는 종료코드를 마지막
// 명령(`tail`)의 것으로 바꿔치기한다 -- 실패한 러너가 파이프 뒤에서
// exit 0으로 보인다(coder-task.md §1 실측). 파이프는 러너 자신이 자기
// 파일에 적는 값은 바꿀 수 없으므로, 종료코드를 실제로 아는 프로세스
// (러너 자신, isolated-suite-runner.mjs)가 그 값을 파일에 쓰면 껍데기
// 셸이 무엇을 삼키든 진실이 남는다.
//
// ⛔이 모듈은 소비 판정(relay-handshake.mjs)에서 import되지 않는다 --
// 소비 쪽은 이 파일이 쓴 JSON을 그냥 읽기만 한다(fs.readFileSync +
// JSON.parse). relay-handshake.mjs를 고정 파일목록으로 격리 clone하는
// 다수의 mutation 시험(hyk186-time-authority-mutation.test.mjs 등)이
// 이미 있어, 그 파일에 새 정적 import를 추가하면 그 시험들의 고정
// sidecar 목록이 전부 이 파일도 알아야 하는 광범위한 파급이 생긴다 --
// admission-completion-adapter.mjs가 정확히 같은 이유로 정적 import되지
// 않고 이 저장소 전체가 "쓰는 쪽과 읽는 쪽은 별개 모듈" 관행을 쓰는 것과
// 동일 근거(consumption-receipt-writer.mjs 헤더 참조).
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RUNNER_RECEIPT_SCHEMA_VERSION = 2;
export const RUNNER_RECEIPT_FILENAME = "runner-receipt.json";

// HYK-473 §2-2: a receipt must be able to say "no measurement happened"
// as a DIFFERENT fact from "the tests failed" -- a forced kill (OOM,
// signal) means node --test never produced a real result, so a downstream
// reader (human or relay-handshake.mjs's fail-closed gate) that only ever
// saw runner_exit!=0 could not tell the two apart. TESTS_FAILED/OK cover
// the two cases where the child actually ran to completion and reported
// its own exit code; MEASUREMENT_UNAVAILABLE_OOM covers every case where
// it did not (isolated-suite-runner.mjs's classifySpawnOutcome is the only
// producer of this value, and it decides structurally on spawnSync's own
// signal/status/error fields -- never by matching message text, HYK-262).
export const RUNNER_STATUS = Object.freeze({
  OK: "OK",
  TESTS_FAILED: "TESTS_FAILED",
  MEASUREMENT_UNAVAILABLE_OOM: "MEASUREMENT_UNAVAILABLE_OOM",
});

// Callers that don't classify a spawn outcome themselves (this file's own
// pre-HYK-473 tests, e.g.) still get a sane runner_status: zero exit reads
// as OK, anything else as TESTS_FAILED -- the old (schema v1) behavior,
// preserved as a default rather than silently dropped.
function deriveRunnerStatus(runnerExit) {
  return runnerExit === 0 ? RUNNER_STATUS.OK : RUNNER_STATUS.TESTS_FAILED;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// KST는 DST가 없다 -- UTC에서 고정 +9h를 더하는 쪽이 호스트 머신의 로컬
// 타임존 설정에 기대는 것보다 안정적이다(finalize-done.mjs의 formatKst와
// 동일 근거·동일 구현 -- 그 파일을 import하지 않는 이유도 위 헤더와 같다:
// isolated-suite-runner.mjs는 relay/ 쪽 모듈에 의존하지 않는다).
export function formatKst(nowMs) {
  const kst = new Date(nowMs + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(
    kst.getUTCDate(),
  )} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(
    kst.getUTCSeconds(),
  )} KST`;
}

// `node --test`가 병기 tap reporter destination에 쓰는 표준 요약 줄
// (`# tests N` / `# pass N` / `# fail N` / `# skipped N`)을 파싱한다.
// 실측(이 라운드, node v26.2.0): 기본 reporter는 `ℹ`로, tap reporter는
// `#`로 같은 요약을 찍는다 -- 이 파서는 tap 목적지 파일을 대상으로 하므로
// `#`만 본다. 못 찾은 필드는 null로 남긴다(추정치로 메우지 않는다 --
// fail-closed는 소비 쪽 책임이고, 이 함수는 "모른다"를 정직하게 알린다).
export function parseTapSummaryCounts(tapText) {
  const pick = (label) => {
    const m = new RegExp(`^# ${label} (\\d+)\\s*$`, "m").exec(tapText ?? "");
    return m ? Number(m[1]) : null;
  };
  return {
    tests: pick("tests"),
    pass: pick("pass"),
    fail: pick("fail"),
    skip: pick("skipped"),
  };
}

// HYK-477 §1-3: "the run's own max concurrent `node` process count", a
// machine-observed value (never a human report) so a downstream reader can
// tell "the concurrency cap actually held" apart from "nobody ever checked"
// after the fact from the receipt alone. `null` means the measurement
// itself was unavailable (sampler failed to start/stop cleanly, or this
// caller predates the field) -- a DIFFERENT fact from "0 processes seen",
// so it is never coerced to 0.
export function buildRunnerReceipt({
  runnerExit,
  runnerStatus,
  counts,
  headCommit,
  finishedAtMs,
  maxConcurrentNode,
}) {
  return {
    schema_version: RUNNER_RECEIPT_SCHEMA_VERSION,
    runner_exit: runnerExit,
    runner_status: runnerStatus ?? deriveRunnerStatus(runnerExit),
    tests: counts?.tests ?? null,
    pass: counts?.pass ?? null,
    fail: counts?.fail ?? null,
    skip: counts?.skip ?? null,
    head_commit: headCommit,
    finished_at: formatKst(finishedAtMs),
    max_concurrent_node: maxConcurrentNode ?? null,
  };
}

// `<root>/.harness/runner-receipt.json`에 쓴다. ⛔.harness/는 gitignore라
// CI·새 clone에는 애초에 없다(coder-task.md §2-1 정직 의무) -- 그 디렉터리가
// 없으면 만든다. §2-1 "실패했다고 영수증을 안 쓰면 안 된다"를 만족하려면
// 이 함수 자체는 절대 예외를 삼켜 "썼다"고 거짓 보고하지 않되, 호출자
// (runIsolatedSuite)는 이 쓰기가 실패해도 러너 자신의 exit code 전파를
// 절대 막지 않는다(그 쪽은 try/catch로 감싼다 -- 영수증을 못 쓰는 것이
// 시험 결과 자체를 감춰서는 안 된다).
//
// ⛔이 파일은 "최신본" 하나만 이 경로에 쓴다 -- 회차별(run-scoped) 사본은
// 별개 함수(allocateRunSlot/writeNumberedRunnerReceipt, 아래)가 맡는다.
// HYK-485 §2-1: 기존 이 함수의 시그니처/동작을 한 글자도 바꾸지 않는 것
// 자체가 "기존 runner-receipt.json 독자 무영향" 요구의 증명이다.
export function writeRunnerReceipt({
  harnessDir,
  runnerExit,
  runnerStatus,
  counts,
  headCommit,
  finishedAtMs,
  maxConcurrentNode,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
}) {
  const dir = harnessDir;
  mkdirFn(dir, { recursive: true });
  const receipt = buildRunnerReceipt({
    runnerExit,
    runnerStatus,
    counts,
    headCommit,
    finishedAtMs,
    maxConcurrentNode,
  });
  const path = join(dir, RUNNER_RECEIPT_FILENAME);
  writeFileFn(path, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  return { path, receipt };
}

// HYK-485 §1 실측(HYK-480 1R): 러너를 정직하게 2회 돌려도, 영수증 경로가
// `.harness/runner-receipt.json` 하나뿐이라 2회차가 1회차를 같은 경로에
// 덮어썼다 -- 배달 후 남은 기계 증거는 "2회차 영수증 하나"뿐이었고, 1회차는
// 산문 주장으로만 존재했다. 이 두 export는 회차별(run-scoped) 사본
// (`runner-receipt-run<N>.json` · `full-runner-<N>.log`)을 "기계로" 남겨
// 그 병을 없앤다.
export const RUNNER_RECEIPT_RUN_PREFIX = "runner-receipt-run";
export const RUNNER_LOG_PREFIX = "full-runner-";
const RUN_SLOT_MAX_ATTEMPTS = 10000;
const RUN_SLOT_NAME_RE = new RegExp(
  `^${RUNNER_RECEIPT_RUN_PREFIX}(\\d+)\\.json$`,
);

// HYK-485 §2-2 2R (검토 P2-2, rounds/REVIEW-r1.md): 소비 쪽(relay-
// handshake.mjs)은 "가장 큰 N이 가장 최근"이라고 가정한다(entries.slice(-2)).
// 시작점을 항상 1로 두고 "첫 빈 자리"를 wx로 차지하면, 중간 파일이 지워진
// 뒤의 재할당이 그 빈 자리를 다시 채운다 -- 실제로는 다섯 번째 실행인데
// 파일 이름은 2번이 된다(검토 재현: run2 삭제 후 재할당 -> 5가 아니라 2).
// 그러면 소비 쪽의 "가장 큰 N" 가정이 깨져 실제로 가장 최근인 실행이
// 조용히 무시된다. 시작점을 "지금 있는 가장 큰 N + 1"로 두면(비어 있으면
// 1) 지워진 자리는 다시 채워지지 않고 번호가 항상 앞으로만 늘어나 그
// 가정이 다시 참이 된다. 이 읽기와 그 다음 wx 배타 생성 사이에는 여전히
// 경쟁이 있을 수 있지만(다른 프로세스가 그 사이 같은 N을 먼저 차지),
// 그 경쟁은 아래 EEXIST 재시도 루프가 그대로 흡수한다 -- 이 함수가 이미
// "경쟁에서 진 쪽은 다음 N으로"를 보장하므로 시작점이 어디든 유일성은
// 깨지지 않는다(바뀌는 것은 "재사용 여부"뿐, "경쟁 안전성"은 무영향).
function nextRunSlotStart(harnessDir, readdirFn) {
  let names;
  try {
    names = readdirFn(harnessDir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const name of names) {
    const m = RUN_SLOT_NAME_RE.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// §2-1 "회차 번호 <N>을 무엇으로 정할지" 근거: 기존 파일 개수를 세어
// 정하는 방식은 "세기"와 "쓰기" 사이에 다른 프로세스가 끼어들 수 있는
// TOCTOU 경쟁을 안고 있다(두 실행이 같은 카운트를 보고 같은 N을 고를 수
// 있다) -- 그게 바로 이 이슈가 고치려는 병(경로 하나 공유)의 재판이다.
// 대신 각 N의 영수증 자리를 배타적 생성("wx" == O_CREAT|O_EXCL, POSIX와
// Windows(CreateFile CREATE_NEW) 양쪽에서 원자적)으로 "먼저 차지한 쪽만
// 그 N을 갖는다"로 만든다 -- 경쟁에서 진 프로세스는 EEXIST를 받고 다음
// N을 시도한다. 이 루프 자체가 "동시 실행에서 충돌하지 않는다"는 근거다
// (coder-task.md §8 ⓐ 정직 한계: 이 파일이 사는 harnessDir 자체가 서로
// 다른 워크트리마다 별개이므로, 여기서 막는 경쟁은 "같은 워크트리 안에서"
// 겹치는 경우로 범위가 한정된다 -- 그 범위 안에서는 이 방식이 정말로
// 막는다, 단순 카운팅은 그 범위 안에서도 못 막는다).
export function allocateRunSlot({
  harnessDir,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  readdirFn = readdirSync,
  maxAttempts = RUN_SLOT_MAX_ATTEMPTS,
}) {
  mkdirFn(harnessDir, { recursive: true });
  const start = nextRunSlotStart(harnessDir, readdirFn);
  for (let n = start; n < start + maxAttempts; n++) {
    const receiptPath = join(
      harnessDir,
      `${RUNNER_RECEIPT_RUN_PREFIX}${n}.json`,
    );
    try {
      // 빈 자리표시자 -- 이 wx 생성의 성공 자체가 "이 프로세스가 N을
      // 차지했다"는 증명이다. 실제 내용은 run이 끝난 뒤
      // writeNumberedRunnerReceipt가 덮어쓴다.
      writeFileFn(receiptPath, "", { flag: "wx" });
      return {
        runNumber: n,
        receiptPath,
        logPath: join(harnessDir, `${RUNNER_LOG_PREFIX}${n}.log`),
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // 경쟁에서 졌다 -- 다음 N으로.
    }
  }
  throw new Error(
    `allocateRunSlot: exhausted ${maxAttempts} attempts under ${harnessDir} -- refusing to loop forever`,
  );
}

// allocateRunSlot이 예약한 자리표시자를 실제 영수증 내용으로 덮어쓴다.
// writeRunnerReceipt와 같은 payload 모양(buildRunnerReceipt 재사용)이지만
// 대상 경로가 고정 RUNNER_RECEIPT_FILENAME이 아니라 호출자가 이미
// allocateRunSlot에서 받은 receiptPath다.
export function writeNumberedRunnerReceipt({
  receiptPath,
  runnerExit,
  runnerStatus,
  counts,
  headCommit,
  finishedAtMs,
  maxConcurrentNode,
  writeFileFn = writeFileSync,
}) {
  const receipt = buildRunnerReceipt({
    runnerExit,
    runnerStatus,
    counts,
    headCommit,
    finishedAtMs,
    maxConcurrentNode,
  });
  writeFileFn(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  return { path: receiptPath, receipt };
}
