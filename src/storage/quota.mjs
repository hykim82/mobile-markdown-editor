// PRD §8 "저장공간 부족" 정책 지원. isQuotaExceededError 는 실패 원인이
// 저장공간 부족인지 구분해 memo-store.mjs 가 그 경우에만 "알림 O" +
// 캐시 정리를 시도하게 한다("자동저장 실패"의 일반 경로는 알림 없음).
// DOMException.name(표준 스펙 이름)과 옛 code 22(구형 브라우저 하위
// 호환) 둘 다 본다.
export function isQuotaExceededError(error) {
  if (!error) return false;
  return error.name === "QuotaExceededError" || error.code === 22;
}

// "캐시 정리 시도"는 정책 문구가 요구하는 최선노력 동작이다 -- Cache API
// (서비스워커 캐시)가 있으면 비워서 여유를 만들어 본다. 이 프로젝트는
// 아직 서비스워커/Cache API를 쓰지 않으므로(caches 전역 자체가 없는
// 환경이 흔함) 실패해도 조용히 false 를 돌려준다 -- 정직 한계: 이것으로
// 실제 저장공간이 늘어난다는 보장은 없다, "시도했다"만 보장한다.
export async function attemptCacheCleanup() {
  if (typeof caches === "undefined") return false;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    return true;
  } catch {
    return false;
  }
}
