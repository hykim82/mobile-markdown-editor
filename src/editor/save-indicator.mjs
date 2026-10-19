// PRD §4 CUJ ④ "자동저장('저장됨')" · §8 "'저장됨' 미표시로 알림"(coder-task.md
// HYK-304-saved-indicator-1 §2). memo-store.mjs 의 onStatusChange 훅이 주는
// 상태(idle/saving/ok/retrying/quota-exceeded/failed) 중 "ok"일 때만 조용한
// "저장됨" 표시를 올리고, 실패(failed/quota-exceeded)·빈 메모(idle)에는
// 내린다.
//
// saving/retrying 은 일부러 손대지 않는다(HYK-304-e10-p3-cleanup-1 P3-4
// 정리 -- 근거는 관제실 2026-10-17-에디터-저장됨표시E7-1R-지시서.md §2-4
// ⓔ "입력 중(저장 대기 중)에는 '저장됨'을 어떻게 다루는지(내림/유지) --
// 선택과 근거"와 PRD §6 "거슬림 없음"): 디바운스 대기·재시도 1회는 매
// 입력마다 지나가는 전이 상태라, 그때마다 표시를 내렸다 올리면 오히려 더
// 거슬린다. 그래서 표시는 "마지막으로 확정된 저장 결과"를 들고 있다가
// 다음 ok/failed/quota-exceeded/idle 이 올 때만 갈아 치운다(설계 유지 --
// 동작 변경 0).
//
// aria-hidden 토글(HYK-304-saved-indicator-1-r2 §2-4, 책임자 판정
// 2026-10-17 22:4x 판단 2): opacity 로만 숨기면 화면 낭독기에는 계속
// 읽힌다 -- PRD §8 "미표시로 알림"이 낭독기 사용자에게도 성립하려면
// 보임/숨김 class 토글과 같은 자리에서 aria-hidden 도 같이 바꿔야 한다.
export function updateSaveIndicator(el, status) {
  if (!el) return;
  if (status === "ok") {
    el.classList.add("is-visible");
    el.removeAttribute("aria-hidden");
  } else if (
    status === "failed" ||
    status === "quota-exceeded" ||
    status === "idle"
  ) {
    el.classList.remove("is-visible");
    el.setAttribute("aria-hidden", "true");
  }
}
