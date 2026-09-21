// HYK-272/HYK-270-stall-visible-2/-3 (coder-task.md §3, §4) -- 배달 후
// "착수" 판정 순수 코어. §3(HYK-274 선행 조사) 실측 결론을 그대로 근거로
// 쓴다:
//
// - `orca terminal read`(화면 스냅샷)는 이 좌석 자신이 연속으로 작업 중일
//   때(§3-1 조건 ⓒ) 특정 출력이 **76초가 지나도록도 반영되지 않는** 경우를
//   이번 조각에서 직접 실측했다(자기 마커 프로브, coder.md §관측 지연
//   실측 참조) -- 즉 화면은 "몇 초 지연" 수준이 아니라 **무한정 지연될 수
//   있다.** ⇒ 화면 문자열을 이 축의 판정 근거로 쓰지 않는다.
// - ORCH의 2026-08-16 21:18 실측: 세션 기록 파일은 **크기는 계속 느는데
//   `mtime`은 갱신 안 되는 구간**이 있었다(214KB→5.1MB, mtime 은 그대로).
//   ⇒ **mtime이 아니라 "크기"** 를 진행 신호로 쓴다.
// - ORCH가 21시 승인창 정지 사고에서 **실제로 이 방법(크기 1분마다 재서
//   3분 무증가 = 멈춤)으로 잡아냈다** -- 화면 밖 근거 중 이미 실전에서
//   검증된 것을 그대로 택했다.
//
// ★HYK-270-stall-visible-3 (2R REVIEW 반려 수리, coder-task.md §1-§2 그대로):
// 2R은 "두 관측 사이에 한 번이라도 증가가 있었는가"(`detectSizeGrowth`,
// 정렬 후 지금까지의 최소값보다 큰 값이 한 번이라도 나오면 전진)만 봤다.
// 이 판정은 **"증가가 언제 있었는가"를 잊는다** -- 검토자 실측 그대로:
// 관측열 `totalBytes = 0 -> 5000 -> 5000 -> …`(배달 후 시작했다가 승인창
// 등으로 멈춘 실제 사례 2 형태)에서 두 번째 관측(0->5000) 시점에 이미
// "언젠가 증가가 있었다"는 사실이 영구히 성립해 버려, 그 뒤로 아무리
// 오래 안 늘어도 계속 `STARTED`로 남는다 -- 오늘 21시 승인창 정지를 이
// 판정으로는 못 잡는다(보고와 실제 동작의 불일치, 2R REVIEW 반려 원문).
//
// 수리: "증가가 있었는가"가 아니라 **"가장 최근 증가가 언제였는가"**
// (`lastGrowthAtMs`)를 추적하고, 그 시각으로부터 `now`까지 경과가
// `stallThresholdMs`를 넘으면 "시작 후 멈춤"(`STALLED_AFTER_START`)으로
// 가른다 -- "시작 못 함"(`NOT_STARTED`)과는 다른 사람 조치(전자=좌석 확인,
// 후자=재배달)가 필요하므로 값을 뭉개지 않는다(coder-task.md §2 항4).
//
// 이 코어는 "세션 기록 파일 총 바이트 수가 언제 마지막으로 늘었는가"만
// 본다 -- dispatch-start-core.mjs(터미널 lastOutputAt 축)와 판정 형태는
// 비슷하지만 관측의 출처가 다르므로(화면이 아니라 파일 크기) 별도 파일로
// 둔다(그 파일의 헤더 주석이 "좌석 lastOutputAt"에 강하게 결부돼 있어
// 필드 이름만 바꿔 재사용하면 그 문서화가 거짓이 된다).
//
// 비타협: I/O 0, throw 0 -- 이 코어는 관측 배열을 받기만 한다. 실제 파일
// 크기 수집은 dispatch-start-size-adapter.mjs(이 코어 밖)가 한다.

export const DISPATCH_START_SIZE_VERDICT = Object.freeze({
  STARTED: "STARTED",
  NOT_STARTED: "NOT_STARTED",
  // ★신규(3R) -- 한 번은 커졌지만(=시작은 했다) 그 뒤 `stallThresholdMs`
  // 넘게 더 안 큼(=승인창 등으로 멈춤). `NOT_STARTED`(애초에 시작도 못
  // 함)와 값을 공유하지 않는다 -- 사람이 할 일이 다르다(coder-task.md §2
  // 항4: 전자는 좌석 확인, 후자는 재배달).
  STALLED_AFTER_START: "STALLED_AFTER_START",
  UNDECIDABLE: "UNDECIDABLE",
});

export const DISPATCH_START_SIZE_REASON = Object.freeze({
  ARGS_INVALID: "ARGS_INVALID",
  NOW_INVALID: "NOW_INVALID",
  THRESHOLD_INVALID: "THRESHOLD_INVALID",
  OBSERVATIONS_INVALID: "OBSERVATIONS_INVALID",
  OBSERVATION_MALFORMED: "OBSERVATION_MALFORMED",
  OBSERVATION_IN_FUTURE: "OBSERVATION_IN_FUTURE",
  TOO_FEW_OBSERVATIONS: "TOO_FEW_OBSERVATIONS",
  GREW_RECENTLY: "GREW_RECENTLY",
  NO_GROWTH_PAST_TIMEOUT: "NO_GROWTH_PAST_TIMEOUT",
  STALLED_PAST_THRESHOLD: "STALLED_PAST_THRESHOLD",
});

// 근거: §4-2 사례2에서 ORCH가 실전에 쓴 값 그대로(1분 간격 폴링, 3분
// 무증가 = 멈춤). 호출자가 언제든 다른 값으로 덮어쓸 수 있다.
export const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
// ★신규(3R) -- "시작 후 멈춤" 판정의 무증가 허용 시간. ORCH가 오늘 21시
// 승인창 정지 사고에서 실전에 쓴 값과 동일(3분 무증가 = 멈춤, coder-
// task.md §2 항2 "참고 실측" 그대로) -- `timeoutMs`(배달 시각 기준)와
// 기원이 다르므로(이쪽은 "마지막 증가 시각" 기준) 별도 상수로 둔다.
// 호출자가 언제든 다른 값으로 덮어쓸 수 있다(하드코딩 아님).
export const DEFAULT_STALL_THRESHOLD_MS = 3 * 60 * 1000;

// ★신규(HYK-378) -- "임계 시간을 그냥 늘린다"가 아니라 "실제로 검증된
// 작업량이 있었는가"라는 별개 증거에 «조건부로» 여유를 준다. 오늘
// 실사고 표본 2(HYK-377 2R, coder.md §1 첨부 원문)는 하위 에이전트 없이도
// «단일 긴 호출» 하나(첨부 원문의 "almost done thinking with medium
// effort")가 기본 무증가 허용(3분)을 살짝 넘겨 조용했다 -- 그 시점까지
// 이미 baseline 대비 75,724B가 실제로 자라 있었다(diagnostic 원문:
// baseline=634067 -> last_observation=709791). ★B를 지키는 장치: 이
// 여유는 "이미 sustainedGrowthBytes 이상 실제로 자란 적이 있을 때만"
// 켜지고 배수만큼 상한이 있다(무제한 아님) -- 완료조건 2의 합성 표본은
// growthSinceStartBytes=0이라 이 여유를 아예 못 받고 기본 임계 그대로
// 잡힌다. 진짜 승인창 정지는 대개 위험한 명령을 실행하기 «직전»에 걸려
// 증거가 쌓이기 전에 일어나므로, 이미 많이 자란 뒤의 정지까지 이 여유가
// 가려버리는 경우는 알려진 한계로 남긴다(신호·눈멂 표 참조).
export const DEFAULT_SUSTAINED_GROWTH_BYTES = 50_000;
export const DEFAULT_STALL_GRACE_MULTIPLIER = 2;
// ★HYK-378 2R(REVIEW P1-1 반려 수리) -- `stallGraceMultiplier`가 검증 없이
// 그대로 곱해져 `Infinity`/`NaN`/과대 유한값이면 무증가가 얼마나 길든
// `STARTED`로 새는 구멍이 있었다(검토자 실측: 1,000,000,000ms 무증가도
// `STARTED`). ★결정(반박 환영) -- "안전하게 접는다"(값을 조용히 clamp)가
// 아니라 **"거부한다"**를 택했다: `timeoutMs`/`stallThresholdMs`가 이미
// 같은 파일에서 "0 이하면 UNDECIDABLE/THRESHOLD_INVALID"로 거부하는
// 선례가 있고, 이 축도 정지 판정을 좌우하는 안전 계수이므로 같은 자리·
// 같은 방식으로 다뤄야 값이 뭉개지지 않는다(잘못된 배수를 몰래 4로
// 깎아 쓰면 호출자가 자신이 준 값이 안 먹혔다는 것을 영영 모른다).
export const MAX_STALL_GRACE_MULTIPLIER = 4;

// ★HYK-378 3R(REVIEW P1-1 재반려 수리 -- ORCH 재설계 지시 그대로) -- 2R은
// «새 인자»(stallGraceMultiplier)만 검증했지, 곱셈의 다른 항인 기존
// `stallThresholdMs`는 여전히 "유한·양수"뿐이었다. `Number.MAX_VALUE`는
// 유한하지만 `stallThresholdMs * stallGraceMultiplier`가 부동소수점
// 오버플로로 `Infinity`가 된다 -- 이 값은 기존 CLI `--stall-threshold-ms`
// 로 그대로 전달 가능해 운영 경로에서도 재현됐다(검토자 실측). ★수리
// 원칙(불변식 G) -- 개별 인자를 검증하는 대신 **"무증가 허용으로 실제
// 쓰이는 값"(effectiveStallThresholdMs) 자체에 절대 상한을 건다**: 아래
// `judgeFromGrowthHistory`가 유예 적용 여부와 무관하게 이 값을
// `Math.min(..., MAX_EFFECTIVE_STALL_THRESHOLD_MS)`으로 클램프한다.
// `Math.min(Infinity, cap)`은 항상 `cap`이므로, 두 인자의 곱이 오버플로로
// `Infinity`가 되든, 그냥 큰 유한값이 되든 결과는 always bounded --
// "어떤 인자 조합으로도"(불변식 G 문구 그대로)를 인자별 검증이 아니라
// 결과값 클램프로 만족시킨다. 값 = 기본 유예 상한(6분)의 5배(30분) --
// 정상적인 큰 `stallThresholdMs` 설정(예: 부하 큰 CI에서 10분 무증가
// 허용)까지는 여유를 주되, "10억 ms"류 공격값과는 수 자릿수 차이 나게
// 낮게 잡는다(호출자가 언제든 다른 값으로 덮어쓸 수 있다 -- 하드코딩
// 아님, 다만 검증 단계가 아니라 결과 클램프이므로 거부 사유는 안 남는다
// -- §신호·눈멂 표 "곱셈 오버플로" 행 참조).
export const MAX_EFFECTIVE_STALL_THRESHOLD_MS = 30 * 60 * 1000;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isNonNegativeInt(v) {
  return isFiniteNumber(v) && v >= 0 && Number.isInteger(v);
}

function undecidable(reasonCode) {
  return {
    ok: true,
    verdict: DISPATCH_START_SIZE_VERDICT.UNDECIDABLE,
    reasonCode,
    details: null,
  };
}

function isWellFormedObservation(entry) {
  if (!isPlainObject(entry)) return false;
  if (!isFiniteNumber(entry.observedAtMs)) return false;
  return isNonNegativeInt(entry.totalBytes);
}

// 관측 배열 자체 + 각 항목의 구조·미래시각을 검사한다(judgeDispatchStartBySize
// 에서 분리 -- eslint complexity 상한 준수, 로직은 그대로). 문제가 있으면
// 그 사유 코드를, 전부 온전하면 `null`을 돌려준다.
function firstObservationProblem(observations, now) {
  if (!Array.isArray(observations)) {
    return DISPATCH_START_SIZE_REASON.OBSERVATIONS_INVALID;
  }
  for (const entry of observations) {
    if (!isWellFormedObservation(entry)) {
      return DISPATCH_START_SIZE_REASON.OBSERVATION_MALFORMED;
    }
    if (entry.observedAtMs > now) {
      return DISPATCH_START_SIZE_REASON.OBSERVATION_IN_FUTURE;
    }
  }
  return null;
}

// ★수리(3R) -- "증가가 있었는가"가 아니라 "가장 최근 증가가 언제였는가"
// (`lastGrowthAtMs`)를 돌려준다. 정렬된 관측을 훑으며 지금까지의 최댓값
// (`runningMax`)을 넘어서는 값이 나올 때마다 그 시각으로 `lastGrowthAtMs`
// 를 갱신한다 -- 한 번도 안 늘었으면 `null`.
function computeLastGrowthAtMs(sortedObservations) {
  if (sortedObservations.length === 0) return null;
  let runningMax = sortedObservations[0].totalBytes;
  let lastGrowthAtMs = null;
  for (let i = 1; i < sortedObservations.length; i++) {
    const entry = sortedObservations[i];
    if (entry.totalBytes > runningMax) {
      runningMax = entry.totalBytes;
      lastGrowthAtMs = entry.observedAtMs;
    }
  }
  return lastGrowthAtMs;
}

// ★HYK-378 2R(REVIEW P1-1 반려 수리) -- 누적 성장량이 `sustainedGrowthBytes`
// 바를 «처음» 넘긴 시각을 돌려준다(못 넘겼으면 `null`). ★이 시각이
// "유예의 총 수명" 기준점이다 -- `lastGrowthAtMs`(가장 최근 증가)를
// 기준으로 삼으면 검토자가 실측한 대로 "359,999ms마다 1B씩" 흘려 넣는
// 관측열이 매번 유예를 다시 시작시켜 사실상 무한이 된다. 이 시각은 한
// 번 확정되면(=한 번 그 바를 넘기면) 그 뒤 관측이 아무리 늘어도
// 바뀌지 않으므로, 유예 마감(`sustainedAtMs + stallThresholdMs *
// stallGraceMultiplier`)이 고정된 벽시계 상한이 된다 -- 갱신 불가.
function computeSustainedAtMs(sortedObservations, sustainedGrowthBytes) {
  if (sortedObservations.length === 0) return null;
  const startBytes = sortedObservations[0].totalBytes;
  let runningMax = startBytes;
  if (runningMax - startBytes >= sustainedGrowthBytes) {
    return sortedObservations[0].observedAtMs;
  }
  for (let i = 1; i < sortedObservations.length; i++) {
    const entry = sortedObservations[i];
    if (entry.totalBytes > runningMax) runningMax = entry.totalBytes;
    if (runningMax - startBytes >= sustainedGrowthBytes) {
      return entry.observedAtMs;
    }
  }
  return null;
}

function resolveThreshold(value, defaultValue) {
  return value === undefined || value === null ? defaultValue : value;
}

// 네 임계 인자(timeout·stallThreshold·sustainedGrowth·graceMultiplier)를
// 한데 모아 검증한다(judgeDispatchStartBySize에서 분리 -- eslint
// complexity 상한 준수, 로직은 그대로). 문제가 있으면 그 사유 코드를,
// 전부 온전하면 `null`을 돌려준다. ★HYK-378 2R(REVIEW P1-1 반려 수리) --
// 기존 timeout/stallThreshold와 «같은 자리·같은 방식»(0 이하 거부)으로
// 이 축의 두 인자(sustainedGrowth·graceMultiplier)도 검증한다.
// sustainedGrowthBytes는 음수면 무의미(항상 즉시 "이미 자람"으로 뭉갤 수
// 있어 사실상 무제한 유예 통로), stallGraceMultiplier는 1(=여유 없음)
// 미만이거나 MAX_STALL_GRACE_MULTIPLIER를 넘으면(★검토자 실측:
// `Infinity`/`NaN`/과대 유한값이 무제한 유예로 샜다) 거부한다.
function firstThresholdProblem({
  timeout,
  stallThreshold,
  sustainedGrowth,
  graceMultiplier,
}) {
  if (!isFiniteNumber(timeout) || timeout <= 0) {
    return DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID;
  }
  if (!isFiniteNumber(stallThreshold) || stallThreshold <= 0) {
    return DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID;
  }
  if (!isFiniteNumber(sustainedGrowth) || sustainedGrowth < 0) {
    return DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID;
  }
  if (
    !isFiniteNumber(graceMultiplier) ||
    graceMultiplier < 1 ||
    graceMultiplier > MAX_STALL_GRACE_MULTIPLIER
  ) {
    return DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID;
  }
  return null;
}

// 성장 이력(`lastGrowthAtMs`)이 확정된 뒤의 판정만 모은다(judgeDispatchStartBySize
// 에서 분리 -- eslint complexity 상한 준수).
function judgeFromGrowthHistory({
  lastGrowthAtMs,
  sustainedAtMs,
  observationCount,
  dispatchedAtMs,
  now,
  timeoutMs,
  stallThresholdMs,
  stallGraceMultiplier,
}) {
  if (lastGrowthAtMs === null) {
    const pastTimeout = now - dispatchedAtMs > timeoutMs;
    if (!pastTimeout) {
      return undecidable(DISPATCH_START_SIZE_REASON.TOO_FEW_OBSERVATIONS);
    }
    return {
      ok: true,
      verdict: DISPATCH_START_SIZE_VERDICT.NOT_STARTED,
      reasonCode: DISPATCH_START_SIZE_REASON.NO_GROWTH_PAST_TIMEOUT,
      details: { observationCount, timeoutMs },
    };
  }

  // DEFAULT_SUSTAINED_GROWTH_BYTES/computeSustainedAtMs 헤더 주석 참조 --
  // 이미 검증된 실제 작업량이 있을 때만, 그리고 그 유예가 «고정된
  // 벽시계 마감»(sustainedAtMs 기준, 갱신 불가) 안에서만 상한 있는
  // 배수만큼 무증가 허용을 늘린다. 합성 진짜-정지 표본(증가 0)은
  // sustainedAtMs가 `null`이라 이 조건을 절대 못 만족해 기본 임계
  // 그대로 잡힌다(B 보존) -- ★2R: 마감이 lastGrowthAtMs가 아니라
  // sustainedAtMs에 고정되므로, 소량 증가를 반복해도 마감이 갱신되지
  // 않는다(P1-1 "359,999ms마다 1B" 회귀 가드).
  // ★3R(P1-1 재반려 수리) -- 마감 계산 자체도 클램프된 유예 폭
  // (cappedGraceSpanMs)으로 한다. 클램프 전 원값(stallThresholdMs *
  // stallGraceMultiplier)이 오버플로로 `Infinity`가 되면 마감 시각도
  // `Infinity`가 돼 "영원히 유예 적용됨"이 성립해 버리므로, 마감 계산에
  // 들어가는 폭 자체를 먼저 절대 상한(MAX_EFFECTIVE_STALL_THRESHOLD_MS)
  // 으로 자른다.
  const cappedGraceSpanMs = Math.min(
    stallThresholdMs * stallGraceMultiplier,
    MAX_EFFECTIVE_STALL_THRESHOLD_MS,
  );
  const graceDeadlineMs =
    sustainedAtMs === null ? null : sustainedAtMs + cappedGraceSpanMs;
  const sustainedGrowthApplied =
    graceDeadlineMs !== null && now <= graceDeadlineMs;
  // ★3R(P1-1 재반려 수리, 불변식 G) -- 유예 미적용 분기(기본
  // `stallThresholdMs` 그대로)도 같은 절대 상한으로 클램프한다 --
  // `stallThresholdMs` 자체가 이미 거대하면(배수 곱 없이도) "사실상
  // 무증가 허용 무제한"과 같은 결과이므로, "곱셈 결과"뿐 아니라 이 축이
  // 실제로 판정에 쓰는 값 어디든 이 절대 상한을 벗어나지 않는다.
  const effectiveStallThresholdMs = Math.min(
    sustainedGrowthApplied ? cappedGraceSpanMs : stallThresholdMs,
    MAX_EFFECTIVE_STALL_THRESHOLD_MS,
  );

  const sinceGrowth = now - lastGrowthAtMs;
  if (sinceGrowth > effectiveStallThresholdMs) {
    return {
      ok: true,
      verdict: DISPATCH_START_SIZE_VERDICT.STALLED_AFTER_START,
      reasonCode: DISPATCH_START_SIZE_REASON.STALLED_PAST_THRESHOLD,
      details: {
        observationCount,
        lastGrowthAtMs,
        stallThresholdMs,
        effectiveStallThresholdMs,
        sustainedGrowthApplied,
      },
    };
  }
  return {
    ok: true,
    verdict: DISPATCH_START_SIZE_VERDICT.STARTED,
    reasonCode: DISPATCH_START_SIZE_REASON.GREW_RECENTLY,
    details: {
      observationCount,
      lastGrowthAtMs,
      effectiveStallThresholdMs,
      sustainedGrowthApplied,
    },
  };
}

// ★HYK-378 4R(REVIEW P1-1 반려 수리, 불변식 K "입력 관문") -- 이 코어의
// 임계 인자 4개(timeout·stallThreshold·sustainedGrowth·graceMultiplier)를
// «기본값 해석 + 검증»까지 한 번에 하는 재사용 가능한 관문. 지금까지는
// 이 로직이 `judgeDispatchStartBySize` 안에만 있어서, 그 함수를 호출하지
// 않는 생산 진입점(`runDispatchStartConfirm`)은 `NaN` 같은 값을 아예
// 걸러낼 방법이 없었다(검토자 실측: `stallThresholdMs: Number.NaN`을
// 그대로 폴링 루프에 흘려 넣으면 코어는 매 폴링마다 `UNDECIDABLE`을
// 내지만, 그 루프 자신은 `UNDECIDABLE`을 "아직 확정 안 됨"으로만 알아
// 영원히 폴링했다 -- `--stall-threshold-ms NaN`이 기존 CLI 인자로 그대로
// 전달 가능해 실측 `ETIMEDOUT`/`SIGTERM`까지 재현됨). ★생산 진입점이
// 폴링을 시작하기 «전에» 이 함수를 한 번 불러 확정적으로 거부할 수 있게
// 만드는 것이 이 함수의 존재 이유다 -- `judgeDispatchStartBySize`도 이제
// 이 함수를 그대로 재사용해 로직이 두 곳에서 갈라지지 않는다(같은 판단을
// 두 번 구현하면 한쪽만 고쳐지는 사고가 난다, 2R~3R이 반복해서 겪은
// "새 인자만 검증" 패턴과 동형).
export function resolveAndValidateThresholds({
  timeoutMs,
  stallThresholdMs,
  sustainedGrowthBytes,
  stallGraceMultiplier,
} = {}) {
  const timeout = resolveThreshold(timeoutMs, DEFAULT_TIMEOUT_MS);
  const stallThreshold = resolveThreshold(
    stallThresholdMs,
    DEFAULT_STALL_THRESHOLD_MS,
  );
  const sustainedGrowth = resolveThreshold(
    sustainedGrowthBytes,
    DEFAULT_SUSTAINED_GROWTH_BYTES,
  );
  const graceMultiplier = resolveThreshold(
    stallGraceMultiplier,
    DEFAULT_STALL_GRACE_MULTIPLIER,
  );
  const reasonCode = firstThresholdProblem({
    timeout,
    stallThreshold,
    sustainedGrowth,
    graceMultiplier,
  });
  if (reasonCode) return { ok: false, reasonCode };
  return {
    ok: true,
    timeoutMs: timeout,
    stallThresholdMs: stallThreshold,
    sustainedGrowthBytes: sustainedGrowth,
    stallGraceMultiplier: graceMultiplier,
  };
}

// judgeDispatchStartBySize({observations, dispatchedAtMs, now, timeoutMs,
// stallThresholdMs}) -> {ok, verdict, reasonCode, details}
//
// - `observations` = [{observedAtMs, totalBytes}], 시간순 무관(정렬함).
// - 한 번도 안 늘었고 `now - dispatchedAtMs > timeoutMs`면 `NOT_STARTED`.
//   아직 타임아웃 전이면 `UNDECIDABLE`(성급하게 단정하지 않는다).
// - 한 번이라도 늘었는데 그 마지막 증가 이후 `stallThresholdMs`를 넘게
//   더 안 늘었으면 `STALLED_AFTER_START`("시작은 했다"가 전제라 `NOT_STARTED`
//   와 절대 같은 값이 아니다).
// - 한 번 늘었고 그 마지막 증가가 `stallThresholdMs` 이내면 `STARTED`.
export function judgeDispatchStartBySize(args) {
  if (!isPlainObject(args)) {
    return {
      ok: false,
      verdict: DISPATCH_START_SIZE_VERDICT.UNDECIDABLE,
      reasonCode: DISPATCH_START_SIZE_REASON.ARGS_INVALID,
      details: null,
    };
  }
  const {
    observations,
    dispatchedAtMs,
    now,
    timeoutMs,
    stallThresholdMs,
    sustainedGrowthBytes,
    stallGraceMultiplier,
  } = args;
  if (!isFiniteNumber(now))
    return undecidable(DISPATCH_START_SIZE_REASON.NOW_INVALID);
  if (!isFiniteNumber(dispatchedAtMs))
    return undecidable(DISPATCH_START_SIZE_REASON.ARGS_INVALID);
  const resolved = resolveAndValidateThresholds({
    timeoutMs,
    stallThresholdMs,
    sustainedGrowthBytes,
    stallGraceMultiplier,
  });
  if (!resolved.ok) return undecidable(resolved.reasonCode);
  const observationProblem = firstObservationProblem(observations, now);
  if (observationProblem) return undecidable(observationProblem);

  const sorted = [...observations].sort(
    (a, b) => a.observedAtMs - b.observedAtMs,
  );
  const lastGrowthAtMs = computeLastGrowthAtMs(sorted);
  const sustainedAtMs = computeSustainedAtMs(
    sorted,
    resolved.sustainedGrowthBytes,
  );
  return judgeFromGrowthHistory({
    lastGrowthAtMs,
    sustainedAtMs,
    observationCount: sorted.length,
    dispatchedAtMs,
    now,
    timeoutMs: resolved.timeoutMs,
    stallThresholdMs: resolved.stallThresholdMs,
    sustainedGrowthBytes: resolved.sustainedGrowthBytes,
    stallGraceMultiplier: resolved.stallGraceMultiplier,
  });
}
