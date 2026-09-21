import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  resolveChildProbeTimeoutMs,
  withTimeoutRetry,
} from "./child-probe-timeout-policy.mjs";

// HYK-400 5R 위협 모델(책임자 판단 2026-08-31, 제안 A 승인 -- 1R~4R
// 4연속 반려가 하드스톱에 걸린 뒤 확정됐다): 이 판정기는 «낡음(stale)
// 탐지»가 목적이다 -- 대상은 우리 저장소의 «옛 커밋» 체크아웃이며, 오늘
// 실사고 2회의 실체도 둘 다 "워크트리 갱신을 잊고 배달"이었지 공격이
// 아니었다. ⛔대상이 «적극적으로 속이려 드는 경우»(같은 프로세스 안에서
// 전역을 오염시키거나 응답 채널을 선점하는 등, 4R 독립 검토가 실증:
// 대상이 전역 JSON.stringify를 덮어쓰자 러너의 정당한 writeResult()가
// 위조 응답을 쓰게 만들 수 있었다 -- child는 exit 0으로 깨끗이 끝나고
// 부모 판정은 ok:true, supported:true가 됐다)는 이 가드의 방어 범위
// 밖이다. ★정직 경계(원문): "악의적 대상 앞에서는 이 가드보다 더 쉬운
// 우회가 존재한다(가드 파일 삭제 등) -- 진짜 해법은 OS 권한 분리이며
// 그것은 HYK-89의 범위다." 이건 결함이 아니라 범위 밖이다 -- 자세한
// 근거는 docs/control-room-patches/HYK-400-receiver-capability-guard.md
// §0을 참조(이 라운드는 문서·주석만 바꾼다, 코드 동작은 4R 그대로다).
//
// HYK-400 6R (I-ENV, CI 런타임 실측 반려 수리): CI는 Node 20.20.2로
// 돈다(워크플로 node-version: 20). 이 저장소가 4R까지 하드코딩해 온
// `--permission` 플래그는 Node 22+에서만 통한다 -- Node 20 계열은 같은
// 기능을 `--experimental-permission`으로 부른다(직접 다운받은 Node
// 20.20.2 바이너리로 실측 확인, 2026-08-31: `--permission`은 즉시
// "bad option"으로 죽고 `--experimental-permission`만 통한다). 두
// 플래그는 서로 배타적이다 -- 하나가 다른 하나를 무해하게 무시하지
// 않고, 모르는 플래그를 받은 Node는 그 즉시 죽는다. 그래서 하드코딩된
// 버전 번호 분기 대신, 이 프로세스가 실제로 띄우는 node 바이너리에
// 최소 비용 probe(빈 스크립트 1회 실행)를 던져 어느 플래그가 실제로
// 통하는지 직접 확인한다(detectPermissionFlag, 결과는 execFileSyncFn별
// 1회 캐시) -- 미래 Node 판본이 플래그를 또 바꿔도 이 판정기 쪽 버전 표를
// 다시 손볼 필요가 없다. 두 후보 다 안 통하면(런타임이 권한 모델
// 자체를 모름) 그 즉시 fail-closed로 거부한다(I-ENV, "조용히 통과"
// 금지) -- 조용히 무권한 상태로 대상을 실행하는 경로는 없다.
// 추가 실측: Node 20의 `--experimental-permission`은 진입 스크립트
// 자신(러너 .mjs)도 `--allow-fs-read` 범위 밖이면 못 읽는다(Node 22+는
// 진입 스크립트를 면제한다 -- 실측으로 그 차이를 확인). 그래서 이제
// `--allow-fs-read`를 워크트리 경로«와» 러너 자신이 있는 디렉터리
// 둘 다에(반복 플래그로, 콤마 목록은 Node 20 experimental 쪽이 더는
// 안 받는다 -- 실측 확인) 준다 -- 실서비스에서는 러너가 항상 대상
// 워크트리 안(scripts/check/)에 있으므로 사실상 한 경로지만, 이
// 저장소의 시험처럼 러너와 대상 워크트리가 물리적으로 분리된 경우를
// 위해 명시적으로 둘 다 연다.
//
// HYK-400 2R (coder-task.md §1-2, 1R 검토 반려 P1-1/P1-2/P1-3 + P2 수리).
// 1R은 "대상 워크트리의 dispatch-receipt-cli.mjs를 판정기 자신의
// 프로세스 안에서 import해 파싱 성공 여부만 본다"였다 -- 검토가 실측으로
// 깬 세 가지:
//   P1-3 부작용 0 이 거짓이었다: import 순간 최상위 코드가 실행돼 실제
//     파일 쓰기가 일어났다("부작용 없다"는 «현재 정본 모듈»에 대한
//     추론이었지 «임의 대상»에 대한 보장이 아니었다).
//   P1-1 파싱 성공 == 이해 로 착각했다: 플래그를 다른 의미로 처리해도
//     {ok:true} 만 보고 supported:true 로 승인했다.
//   P1-2 경로 진위를 안 봤다: 대상이 다른 저장소를 가리키는 심링크여도
//     그대로 import해 승인했다.
// 2R은 이 세 축을 구조로 다시 세운다(구멍 메우기가 아니라 불변식):
//   I1(격리) -- scripts/check/hyk400-receiver-probe-runner.mjs 자신의
//     헤더 주석 참조. 대상 코드는 이 프로세스에서 «절대» 실행되지 않는다
//     -- 언제나 `node --permission --allow-fs-read=<worktree>` 로 뜬
//     별도 자식 프로세스 안에서만, execFileSync의 timeout으로 감시된
//     채로 실행된다. 타임아웃·비정상 종료·JSON 아닌 출력 = 전부 거부.
//   I2(의미) -- "파싱 성공"이 아니라 "우리가 넘긴 값이 실제로 응답에
//     반영됐는가"를 매번 다른 무작위 sentinel(§evaluateSemanticFidelity)
//     로 대조한다. 계약 필드(role/harnessTaskLabel/receiptPath)가
//     오염되지 않았는지도 함께 본다.
//   I3(경계) -- realpath로 해석한 대상 경로가 realpath로 해석한
//     워크트리 경계 «안»이어야 한다(resolveVerifiedTargetPath). 심링크가
//     다른 저장소를 가리키면 그 경로가 경계 밖으로 나가므로 거부된다.
//   I4(문 없애기) -- 검사할 플래그 집합은 호출자가 "이 플래그를 검사해
//     줘"라고 골라 넘기지 않는다(1R의 `flag` 파라미터, 안 넘기면
//     자동 통과하던 구멍). 대신 «이 배달이 실제로 보내는 인자 배열»
//     (deliveryArgs, ps1이 Record-DispatchReceipt에 실제로 넘기는 것과
//     바이트 동일해야 한다)을 통째로 받아, 그 안에서 필수 3필드를 뺀
//     나머지 --플래그를 기계로 뽑는다(deriveOptionalFlags). deliveryArgs가
//     비었거나 필수 3필드조차 없으면 "검사할 게 없다"로 조용히 통과하지
//     않고 거부한다(RECEIVER_GUARD_BAD_INPUT) -- "0개 검사"가 정당하려면
//     그 사실이 «형태를 갖춘 진짜 배달 인자»에서 유도돼야 한다.
//
// HYK-400 4R (I-ROOT, 1R/2R/3R 반려의 공통 뿌리): 세 라운드 모두 같은
// 결함의 다른 얼굴이었다 -- "부모가 «대상이 만들어낼 수 있는 바이트»를
// 신뢰 채널로 썼다"(1R 파싱 성공=이해로 착각, 2R 죽은 자식의 stdout을
// 믿음, 3R stdout 여러 줄 중 마지막 줄만 믿음). 이번 라운드는 표본을
// 더 막는 대신 채널 자체를 바꾼다 -- stdout은 판정에서 «완전히»
// 제외되고, 부모가 각 호출마다 새로 만드는 응답 파일(runIsolatedProbe의
// responseDir/responsePath)만 신뢰한다.
//   - 그 파일은 부모가 실행 «전»에 만들고, 자식에게는
//     `--allow-fs-write`를 그 파일이 있는 디렉터리 하나로만 좁혀서
//     준다(그 밖의 모든 쓰기는 여전히 거부 -- 대상이 실제로 워크트리
//     안 어디에도 쓸 수 없다는 I1의 보장은 그대로 유지된다).
//   - 러너는 그 파일에 `{flag:"wx"}`(exclusive create)로 쓴다 -- 대상이
//     같은 프로세스 안에서(아래 참조) 그 경로를 먼저 알아내 선점하면
//     러너 자신의 정당한 쓰기가 EEXIST로 실패해 비정상 종료하고, 3R의
//     I1′("종료 상태가 1차 축")가 그 자체로 거부한다.
//   - 부모는 자식이 «깨끗하게» 끝났을 때만(3R 그대로) 그 파일 전체를
//     한 번에 읽어 `JSON.parse`한다 -- 줄 단위로 자르지 않으므로 앞뒤
//     쓰레기·여러 줄 JSON은 파싱 자체가 실패해 거부된다(3R이 놓친
//     "stdout.trim().split('\n').pop()" 패턴을 구조적으로 없앤다).
// ⚠️정직 한계(완전한 격리가 아니다) -- 대상 코드는 러너와 «같은
// 프로세스» 안에서 import된다(별도 프로세스가 아니다, I1은 「그
// 프로세스가 워크트리 밖에 아무것도 못 쓴다」는 것만 보장한다). 즉
// 이론상 대상이 `process.argv`를 읽어 응답 파일 경로를 알아내
// 시도 전 그 파일을 exclusive-create로 선점할 수 있다 -- 러너는
// import 직전에 `process.argv[2]`를 지워 이 경로를 좁히지만
// (hyk400-receiver-probe-runner.mjs 참조), 이것이 "완전한 은닉"이라고
// 주장하지 않는다: 클로저 변수 자체를 훔칠 다른 JS 트릭까지는 막지
// 못한다. 이 라운드가 보장하는 것은 정확히 "stdout 내용은 판정에
// 무관하다"이지, "동일 프로세스 안 임의 사이드채널까지 전부 봉쇄"가
// 아니다 — 완전한 프로세스 경계가 필요하면 다음 축(별도 프로세스로
// 대상을 재격리)이 후속 과제다.

const RECEIPT_CLI_RELATIVE_PATH = "scripts/relay/dispatch-receipt-cli.mjs";
const RUNNER_PATH = fileURLToPath(
  new URL("./hyk400-receiver-probe-runner.mjs", import.meta.url),
);
const RUNNER_DIR = dirname(RUNNER_PATH);
// HYK-430 1R: 이 기본값 자체는 "부하 0" 기준값이다. 실제로 쓰이는 예산은
// resolveChildProbeTimeoutMs가 그 시점의 가용 메모리로 넓힌 값이다
// (child-probe-timeout-policy.mjs 참조, coder-task.md §2⑶). 호출자가
// timeoutMs를 명시하면(예: 시험) 그 값을 그대로 쓴다 -- 배율은 "기본값"
// 에만 적용된다.
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const PERMISSION_FLAG_PROBE_BASE_TIMEOUT_MS = 5000;
// I-ENV(6R): 하드코딩된 버전 분기 대신 실제로 통하는 플래그를 probe로
// 확인한다(위 헤더 주석 참조). execPath 문자열이 아니라 execFileSyncFn
// «함수 자체»로 캐시한다(WeakMap) -- production은 항상 같은
// defaultExecFileSyncFn 참조 하나를 재사용하므로 사실상 프로세스당
// 1회지만, execPath로 캐시하면 시험이 다른 execFileSyncFn(다른 런타임을
// 흉내내는 스텁)을 주입해도 캐시가 실제 프로세스의 첫 probe 결과를 계속
// 돌려줘 스텁이 무시되는 조용한 오염이 생긴다(직접 겪음, 2026-08-31) --
// 함수 참조로 캐시하면 서로 다른 execFileSyncFn은 원리적으로 서로 다른
// 캐시 칸을 쓴다.
const PERMISSION_FLAG_CANDIDATES = Object.freeze([
  "--permission",
  "--experimental-permission",
]);
const permissionFlagCache = new WeakMap();
const BASELINE_FIELD_FLAGS = Object.freeze([
  "--role",
  "--task-label",
  "--receipt-path",
]);

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function rejected(reason, extra = {}) {
  return { ok: false, supported: false, reason, ...extra };
}

// I4: 검사 대상 플래그 집합은 실제 배달 인자 배열에서 기계로 유도된다 --
// 호출자가 "이것만 봐 줘"라고 고르지 않는다. deliveryArgs가 비었거나
// 필수 3필드(계약상 항상 보내는 것, HYK-219)조차 없으면 그 자체가
// "이건 진짜 배달 인자가 아니다"라는 신호이므로 조용히 통과시키지 않고
// 거부한다.
export function deriveOptionalFlags(deliveryArgs) {
  if (!Array.isArray(deliveryArgs) || deliveryArgs.length === 0) {
    return {
      ok: false,
      reason:
        "RECEIVER_GUARD_BAD_INPUT: deliveryArgs가 비었다 -- 이 배달이 실제로 보내는 인자 배열을 그대로 넘겨야 한다(검사를 생략할 목적으로 빈 배열/미지정을 쓸 수 없다)",
    };
  }
  const missingBaseline = BASELINE_FIELD_FLAGS.filter(
    (f) => !deliveryArgs.includes(f),
  );
  if (missingBaseline.length > 0) {
    return {
      ok: false,
      reason: `RECEIVER_GUARD_BAD_INPUT: 필수 필드 플래그 누락(${missingBaseline.join(", ")}) -- 진짜 배달 인자 배열로 보이지 않는다`,
    };
  }
  const flags = [];
  for (const arg of deliveryArgs) {
    if (
      typeof arg === "string" &&
      arg.startsWith("--") &&
      !BASELINE_FIELD_FLAGS.includes(arg)
    ) {
      flags.push(arg);
    }
  }
  return { ok: true, flags: [...new Set(flags)] };
}

// I3: 대상 경로를 realpath로 해석해, 워크트리 자신도 realpath로 해석한
// 경계 «안»에 있는지 확인한다. 심링크가 다른 저장소를 가리키면
// targetReal이 그 경계 밖으로 나가 거부된다. realpathSync는 파일시스템
// 메타데이터만 읽는다(대상 코드를 실행하지 않는다) -- I1과 별개의 축.
export function resolveVerifiedTargetPath({ worktree }) {
  if (!isNonEmptyString(worktree)) {
    return rejected("RECEIVER_CLI_MISSING: worktree 경로가 비었다");
  }
  let worktreeReal;
  try {
    worktreeReal = realpathSync(worktree);
  } catch (err) {
    return rejected(
      `RECEIVER_CLI_MISSING: worktree를 realpath로 해석할 수 없다(${err.message})`,
    );
  }
  const candidatePath = join(worktree, RECEIPT_CLI_RELATIVE_PATH);
  if (!existsSync(candidatePath)) {
    return rejected(`RECEIVER_CLI_MISSING: ${candidatePath} 가 없다`);
  }
  let targetReal;
  try {
    targetReal = realpathSync(candidatePath);
  } catch (err) {
    return rejected(
      `RECEIVER_CLI_MISSING: ${candidatePath} 를 realpath로 해석할 수 없다(${err.message})`,
    );
  }
  const boundary = worktreeReal.endsWith(sep)
    ? worktreeReal
    : worktreeReal + sep;
  if (targetReal !== worktreeReal && !targetReal.startsWith(boundary)) {
    return rejected(
      `RECEIVER_CLI_BOUNDARY_ESCAPE: ${candidatePath} 가 워크트리 경계 밖(${targetReal})을 가리킨다(심링크/다른 저장소/경로 탈출 의심)`,
    );
  }
  return { ok: true, targetReal, worktreeReal };
}

function defaultExecFileSyncFn(cmd, args, opts) {
  return execFileSync(cmd, args, opts);
}

// I-ENV(6R): 이 execFileSyncFn이 실제로 어느 권한 모델 플래그를
// 받아들이는지 최소 비용으로 확인한다(빈 스크립트 1회 실행, 부작용
// 없음 -- process.exit(0)만 한다). 둘 다 안 통하면 null을 돌려준다.
// execFileSyncFn별로 캐시해 매 확인마다 다시 묻지 않는다.
function detectPermissionFlag(execFileSyncFn) {
  if (permissionFlagCache.has(execFileSyncFn)) {
    return permissionFlagCache.get(execFileSyncFn);
  }
  let detected = null;
  for (const flag of PERMISSION_FLAG_CANDIDATES) {
    try {
      execFileSyncFn(process.execPath, [flag, "-e", "process.exit(0)"], {
        timeout: resolveChildProbeTimeoutMs(
          PERMISSION_FLAG_PROBE_BASE_TIMEOUT_MS,
        ),
        stdio: "ignore",
      });
      detected = flag;
      break;
    } catch {
      // 이 후보는 이 런타임에서 안 통한다 -- 다음 후보로 넘어간다.
    }
  }
  permissionFlagCache.set(execFileSyncFn, detected);
  return detected;
}

// I-ROOT(4R) 관문 1/2: 자식을 스폰하고, execFileSync가 던지는 예외만으로
// 타임아웃(무한 대기/무한 루프)·비정상 종료(3R I1′)를 분류한다. 정상
// 반환(종료코드 0·시그널 없음)이면 { ok: true }만 돌려준다 -- stdout은
// 여기서도, 호출부에서도 참조하지 않는다.
function spawnIsolatedChild({
  responseDir,
  targetReal,
  worktreeReal,
  baselineArgs,
  flagArgs,
  responsePath,
  execFileSyncFn,
  timeoutMs,
}) {
  const permissionFlag = detectPermissionFlag(execFileSyncFn);
  if (!permissionFlag) {
    // I-ENV(6R): 이 런타임은 --permission도 --experimental-permission도
    // 모른다 -- 격리를 세울 방법이 없다. 조용히 무권한으로 대상을 실행
    // 하지 않는다(fail-closed, I-ENV 그대로).
    return rejected(
      `RECEIVER_CLI_RUNTIME_UNSUPPORTED: 이 Node 런타임(${process.version})은 --permission도 --experimental-permission도 지원하지 않아 격리 여부를 판정할 수 없다(fail-closed)`,
    );
  }

  const payload = Buffer.from(
    JSON.stringify({
      targetPath: targetReal,
      baselineArgs,
      flagArgs,
      responsePath,
    }),
  ).toString("base64");

  const isSpawnTimeout = (err) =>
    err.signal === "SIGKILL" || err.code === "ETIMEDOUT";

  try {
    // HYK-430 1R (coder-task.md §2⑶): "무응답"만 정확히 1회 재시도한다
    // (child-probe-timeout-policy.mjs). 진짜로 계속 응답하지 않는 자식은
    // 재시도해도 다시 같은 이유로 타임아웃되므로 탐지력은 그대로 --
    // 재시도가 지워 주는 건 단발성 지연뿐이다(§2⑷ 음성 대조가 이를
    // 직접 고정한다, hyk400-receiver-guard.test.mjs (I)).
    withTimeoutRetry(
      () =>
        execFileSyncFn(
          process.execPath,
          [
            permissionFlag,
            `--allow-fs-read=${RUNNER_DIR}`,
            `--allow-fs-read=${worktreeReal}`,
            `--allow-fs-write=${responseDir}`,
            RUNNER_PATH,
            payload,
          ],
          {
            cwd: worktreeReal,
            encoding: "utf8",
            timeout: timeoutMs,
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
          },
        ),
      { isTimeout: isSpawnTimeout },
    );
    return { ok: true };
  } catch (err) {
    if (isSpawnTimeout(err)) {
      return rejected(
        "RECEIVER_CLI_PROBE_TIMEOUT: 격리 프로세스가 제한시간 내 응답하지 않았다(무한 대기/무한 루프 의심, 1회 재시도 포함)",
      );
    }
    // execFileSync가 정상 반환하는 유일한 경로가 종료코드 0·시그널
    // 없음이다. stdout에 무엇이 찍혔든(그리고 응답 파일이 어떻게
    // 됐든) child는 비정상 종료했으므로 읽지 않고 거부한다.
    return rejected(
      `RECEIVER_CLI_PROBE_CRASHED: 격리 프로세스가 비정상 종료했다(status=${err.status ?? "unknown"}, signal=${err.signal ?? "none"}; ${err.message})`,
    );
  }
}

// I-ROOT(4R) 관문 2/2: 응답 파일 «전체»를 한 번에 읽어 JSON.parse한다 --
// 줄 단위로 자르지 않으므로(3R이 놓친 지점) 앞뒤 쓰레기·여러 줄 JSON은
// 파싱 자체가 실패해 거부된다.
function readIsolatedResponse(responsePath) {
  if (!existsSync(responsePath)) {
    return rejected(
      "RECEIVER_CLI_PROBE_MISSING_RESPONSE: 격리 프로세스가 깨끗하게 끝났지만 응답 파일을 남기지 않았다",
    );
  }
  let content;
  try {
    content = readFileSync(responsePath, "utf8");
  } catch (err) {
    return rejected(
      `RECEIVER_CLI_PROBE_MALFORMED: 응답 파일을 읽을 수 없다(${err.message})`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return rejected(
      `RECEIVER_CLI_PROBE_MALFORMED: 응답 파일을 JSON으로 해석할 수 없다(${err.message})`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    return rejected(
      "RECEIVER_CLI_PROBE_MALFORMED: 응답 파일 내용이 객체가 아니다",
    );
  }
  if (parsed.ok !== true) {
    return rejected(parsed.reason ?? "RECEIVER_CLI_PROBE_MALFORMED: 사유 없음");
  }
  return { ok: true, baseline: parsed.baseline, withFlag: parsed.withFlag };
}

// I1 + I-ROOT(4R): 대상을 절대 이 프로세스 안에서 import하지 않는다.
// 별도 자식 프로세스(node --permission, fs 쓰기는 이 함수가 만든 응답
// 디렉터리 하나로만 좁혀서 허용, 그 밖엔 전부 기본 거부)를
// execFileSync의 timeout으로 감시하며 부른다. 그 관문(spawnIsolatedChild)을
// 통과했을 때만 -- stdout이 아니라 -- 이 함수가 만든 응답 파일을
// 읽는다(readIsolatedResponse): 대상이 stdout에 무엇을 뿜든(여러 줄
// 유효 JSON·앞뒤 쓰레기·러너 흉내) 판정과 무관하다(fail-open 금지).
function runIsolatedProbe({
  targetReal,
  worktreeReal,
  baselineArgs,
  flagArgs,
  execFileSyncFn,
  timeoutMs,
}) {
  const responseDir = mkdtempSync(
    join(tmpdir(), "hyk400-receiver-guard-response-"),
  );
  try {
    const responsePath = join(responseDir, "response.json");
    const spawned = spawnIsolatedChild({
      responseDir,
      targetReal,
      worktreeReal,
      baselineArgs,
      flagArgs,
      responsePath,
      execFileSyncFn,
      timeoutMs,
    });
    if (!spawned.ok) return spawned;
    return readIsolatedResponse(responsePath);
  } finally {
    // 부모 소유의 임시 자원이다(OS 임시 디렉터리, 라이브 .harness가
    // 아니다) -- 판정 결과와 무관하게 항상 정리한다.
    rmSync(responseDir, { recursive: true, force: true });
  }
}

// I2: "파싱이 성공했다"가 아니라 "우리가 보낸 값이 실제로 반영됐다"를
// 본다. baseline/withFlag 두 응답을 대조해:
//   1) 계약 필드(role/harnessTaskLabel/receiptPath)가 baseline이 기대한
//      값 그대로인지(둘 다) -- 오염되면 거부.
//   2) withFlag의 harnessDir가 sentinel과 정확히 같은지 -- 이 플래그의
//      계약상 의미 필드에 값이 실제로 반영됐다는 증거다. 다른 필드에
//      sentinel을 복사하거나 고정 상수로 치환한 응답은 거부한다.
function matchesProbeContract(response, values) {
  return (
    response?.ok === true &&
    response.role === values.roleValue &&
    response.harnessTaskLabel === values.taskLabelValue &&
    response.receiptPath === values.receiptPathValue
  );
}

function classifyFlagFailure(withFlag, flag) {
  if (
    typeof withFlag?.reason === "string" &&
    withFlag.reason.includes(`unrecognized flag '${flag}'`)
  ) {
    return { ok: true, supported: false, reason: withFlag.reason };
  }
  return rejected(
    `RECEIVER_CLI_PROBE_INCONCLUSIVE: flag 포함 호출이 예상 밖 사유로 실패했다(${withFlag?.reason ?? "사유 없음"})`,
  );
}

function responseCarriesSentinel(baseline, withFlag, sentinel) {
  return withFlag?.harnessDir === sentinel && baseline?.harnessDir !== sentinel;
}

function evaluateSemanticFidelity({
  baseline,
  withFlag,
  roleValue,
  taskLabelValue,
  receiptPathValue,
  flag,
  sentinel,
}) {
  const probeValues = { roleValue, taskLabelValue, receiptPathValue };
  if (!matchesProbeContract(baseline, probeValues)) {
    return rejected(
      "RECEIVER_CLI_CONTRACT_MISMATCH: baseline 호출이 계약(role/harnessTaskLabel/receiptPath 그대로 반영)을 지키지 않는다",
    );
  }

  if (withFlag?.ok === false) {
    return classifyFlagFailure(withFlag, flag);
  }
  if (!matchesProbeContract(withFlag, probeValues)) {
    return rejected(
      "RECEIVER_CLI_CONTRACT_MISMATCH: flag 포함 호출이 계약 필드를 오염시켰거나 예상 밖 응답을 반환했다",
    );
  }

  if (!responseCarriesSentinel(baseline, withFlag, sentinel)) {
    return {
      ok: true,
      supported: false,
      reason: `RECEIVER_CLI_SEMANTIC_MISMATCH: '${flag}'가 파싱은 되지만(ok:true) 넘긴 값이 응답 어디에도 반영되지 않았다(다른 의미로 처리하거나 값을 버리는 것으로 의심)`,
    };
  }
  return { ok: true, supported: true, reason: null };
}

export async function checkReceiptCliFlagSupport({
  worktree,
  deliveryArgs,
  execFileSyncFn = defaultExecFileSyncFn,
  timeoutMs = resolveChildProbeTimeoutMs(DEFAULT_PROBE_TIMEOUT_MS),
}) {
  const derived = deriveOptionalFlags(deliveryArgs);
  if (!derived.ok) {
    return rejected(derived.reason, { checkedFlags: [] });
  }
  if (derived.flags.length === 0) {
    return {
      ok: true,
      supported: true,
      reason: "NO_OPTIONAL_FLAGS_IN_DELIVERY",
      checkedFlags: [],
    };
  }

  const resolved = resolveVerifiedTargetPath({ worktree });
  if (!resolved.ok) {
    return { ...resolved, checkedFlags: derived.flags };
  }

  for (const flag of derived.flags) {
    const sentinel = `hyk400-sentinel-${randomUUID()}`;
    const roleValue = `hyk400-role-${randomUUID()}`;
    const taskLabelValue = `hyk400-label-${randomUUID()}`;
    const receiptPathValue = `hyk400-receipt-${randomUUID()}`;
    const baselineArgs = [
      "--role",
      roleValue,
      "--task-label",
      taskLabelValue,
      "--receipt-path",
      receiptPathValue,
    ];
    const flagArgs = [...baselineArgs, flag, sentinel];

    const probe = runIsolatedProbe({
      targetReal: resolved.targetReal,
      worktreeReal: resolved.worktreeReal,
      baselineArgs,
      flagArgs,
      execFileSyncFn,
      timeoutMs,
    });
    if (!probe.ok) {
      return { ...probe, checkedFlags: derived.flags, failedFlag: flag };
    }

    const verdict = evaluateSemanticFidelity({
      baseline: probe.baseline,
      withFlag: probe.withFlag,
      roleValue,
      taskLabelValue,
      receiptPathValue,
      flag,
      sentinel,
    });
    if (!verdict.supported) {
      return { ...verdict, checkedFlags: derived.flags, failedFlag: flag };
    }
  }

  return {
    ok: true,
    supported: true,
    reason: null,
    checkedFlags: derived.flags,
  };
}

function parseCliArgs(argv) {
  const out = { worktree: undefined, deliveryArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--worktree") {
      out.worktree = argv[++i];
    } else if (argv[i] === "--delivery-arg") {
      out.deliveryArgs.push(argv[++i]);
    }
  }
  return out;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/hyk400-receiver-guard.mjs");
if (invokedDirectly) {
  const { worktree, deliveryArgs } = parseCliArgs(process.argv.slice(2));
  if (!isNonEmptyString(worktree)) {
    console.error(
      "FAILED reason=usage: hyk400-receiver-guard.mjs --worktree <path> [--delivery-arg <token>]...",
    );
    process.exit(1);
  }
  const result = await checkReceiptCliFlagSupport({ worktree, deliveryArgs });
  if (result.ok && result.supported) {
    console.log(
      `SUPPORTED checked=${JSON.stringify(result.checkedFlags)} worktree=${worktree}`,
    );
    process.exit(0);
  }
  console.error(
    `REJECTED worktree=${worktree} checked=${JSON.stringify(result.checkedFlags ?? [])} reason=${result.reason}`,
  );
  process.exit(1);
}
