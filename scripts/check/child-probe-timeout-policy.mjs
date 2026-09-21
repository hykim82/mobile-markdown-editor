// HYK-430 1R -- 공통 정책: "격리 자식 프로세스를 띄우고 고정 시간 안에
// 응답을 기대하는 프로브" 세 표면(relay-handshake.mjs의
// retire-author-shadow 관측, hyk400-receiver-guard.mjs의 두 스폰,
// dispatch-start-confirm-cli.test.mjs의 성장창/스폰 시험)이 각자
// 숫자를 따로 키우는 대신 여기 한 곳에서 파생시킨다(coder-task.md §2⑶).
//
// ★선택한 축(coder-task.md §2⑶ 요구 -- 무엇을 왜 고르는지):
//   1) 부하 적응 -- 가용 메모리(os.freemem())를 프록시로 쓴다. 이
//      워크트리에서 실측한 관찰(D:\문서관리\하네스-관제실\증거\
//      2026-09-04-HYK430-단일실패-실물\러너-단독-부하-관측.md)은 "다른
//      레인 0·사람 부하 0" 조건에서도 러너 단독 실행이 가용 메모리를
//      6.06GB -> 2.21GB까지 끌어내린다는 것이다 -- 즉 이 저장소에서
//      "부하"의 관측 가능한 신호는 CPU 경합보다 먼저 가용 메모리
//      고갈로 나타난다(추론, 확정 아님 -- 원 문서 등급 그대로 이어받음).
//      그래서 CPU 코어 수가 아니라 freemem을 배율의 입력으로 쓴다.
//   2) 기동 대기와 응답 대기의 분리 -- HYK-329(dispatch-start-confirm-cli
//      쪽 실사고, 이 파일 §1-2 주석 참조)의 근본 원인은 "자식이 아직
//      기동도 못 했는데 이미 관측 창이 닫힘"이었다. 이 정책은 배율을
//      "시작 배율"과 "응답 배율" 둘로 나누되, 부하 0(freemem==기준값)
//      에서는 «둘 다 1.0»이다(부하가 없는데도 기존에 실측 고정해 둔
//      기준값을 불필요하게 부풀리지 않는다) -- 대신 부하가 걸리기
//      시작하면(freemem < 기준값) 시작 배율이 응답 배율보다 «더
//      가파르게» 커진다(STARTUP_SENSITIVITY, 자식 node 프로세스 자체의
//      기동 지연이 실제 작업 지연보다 부하에 더 민감하다는 관측 -- 위
//      같은 문서, "spawn·node 기동이 창보다 더 지연" 재현 기록).
//   3) 재시도 1회 -- 무응답(TIMEOUT)에서만, 그것도 정확히 1회만
//      재시도한다. ⛔진짜 행(hang) 탐지력을 깎지 않는다: 진짜로 영원히
//      응답하지 않는 자식은 재시도해도 다시 타임아웃이므로 여전히
//      TIMEOUT으로 판정된다(§2⑷ 음성 대조가 바로 이것을 고정한다) --
//      재시도가 가리는 것은 "느렸을 뿐인" 단발성 지연이지 "정말 안
//      끝나는" 자식이 아니다.
//
// ★정직 한계: freemem 배율은 "이 저장소의 이번 관측"에서 나온 경험적
// 보정이지 수학적으로 유도된 상수가 아니다(추론 등급). 극단적 부하에서
// 여전히 부족할 수 있다 -- coder-task.md §2⑶가 요구하는 "한 곳에서
// 파생"의 목적은 그 경우에도 조정 지점이 하나뿐이게 하는 것이다.

import { freemem } from "node:os";

// 이 워크트리에서 "부하 없음"으로 실측된 가용 메모리 상한 근방(위 관측
// 문서, 6.06GB). 이 값을 기준으로 배율 1.0을 정의한다.
export const REFERENCE_FREE_MEM_BYTES = 4 * 1024 * 1024 * 1024; // 4GB

export const MIN_MULTIPLIER = 1;
export const MAX_MULTIPLIER = 3;
// 부하가 걸리기 시작하면(ratio>1) 시작 배율은 응답 배율보다 이 배수만큼
// 더 가파르게 커진다(위 §2 근거). ratio<=1(부하 0/여유)에서는 무관 --
// 두 배율 다 1.0으로 바닥을 공유한다.
export const STARTUP_SENSITIVITY = 1.5;

export const RETRY_ON_TIMEOUT = 1;

function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}

// freeMemBytes가 REFERENCE_FREE_MEM_BYTES보다 적을수록 배율이 커진다.
// freemem()을 읽을 수 없거나 0/음수면(비정상 런타임) 안전측으로 최댓값을
// 돌려준다 -- fail-closed로 "여유를 준다"이지 "검사를 생략한다"가 아니다.
export function loadMultiplier({
  freeMemBytes = freemem(),
  sensitivity = 1,
} = {}) {
  if (!Number.isFinite(freeMemBytes) || freeMemBytes <= 0) {
    return MAX_MULTIPLIER;
  }
  const ratio = REFERENCE_FREE_MEM_BYTES / freeMemBytes;
  if (ratio <= 1) return MIN_MULTIPLIER;
  const scaled = 1 + (ratio - 1) * sensitivity;
  return clamp(scaled, MIN_MULTIPLIER, MAX_MULTIPLIER);
}

// 기동(spawn~첫 관측)과 응답(첫 관측~완료) 두 예산을 각자 다른 민감도로
// 넓힌다. baseStartupMs/baseResponseMs는 "부하 0" 기준값이다 -- 부하가
// 없으면(freeMemBytes >= REFERENCE_FREE_MEM_BYTES) 둘 다 그대로 돌아온다.
export function resolveChildProbeBudget({
  baseStartupMs,
  baseResponseMs,
  freeMemBytes = freemem(),
} = {}) {
  const startupMultiplier = loadMultiplier({
    freeMemBytes,
    sensitivity: STARTUP_SENSITIVITY,
  });
  const responseMultiplier = loadMultiplier({ freeMemBytes });
  return {
    startupMs: Math.round(baseStartupMs * startupMultiplier),
    responseMs: Math.round(baseResponseMs * responseMultiplier),
    startupMultiplier,
    responseMultiplier,
  };
}

// 단일 고정 타임아웃 하나만 필요한 호출부(hyk400-receiver-guard.mjs,
// relay-handshake.mjs)를 위한 얇은 래퍼 -- "응답 배율" 하나만 쓴다(그
// 두 표면은 기동/응답을 구분하지 않는 단일 스폰-대기 형태이므로).
export function resolveChildProbeTimeoutMs(
  baseTimeoutMs,
  { freeMemBytes = freemem() } = {},
) {
  return Math.round(baseTimeoutMs * loadMultiplier({ freeMemBytes }));
}

// fn(attempt)이 isTimeout(err)==true인 에러로 던질 때만 최대
// retries번(기본 1) 재시도한다. 그 밖의 실패(비정상 종료·예외 등)는
// 즉시 그대로 던진다 -- 재시도는 오직 "무응답" 판정에만 적용된다.
export function withTimeoutRetry(
  fn,
  { retries = RETRY_ON_TIMEOUT, isTimeout } = {},
) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isTimeout(err)) throw err;
    }
  }
  throw lastErr;
}
