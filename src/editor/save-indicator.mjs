// PRD §4 CUJ ④ "자동저장('저장됨')" · §8 "'저장됨' 미표시로 알림"(coder-task.md
// HYK-304-saved-indicator-1 §2). memo-store.mjs 의 onStatusChange 훅이 주는
// 상태(idle/saving/ok/retrying/quota-exceeded/failed) 중 "ok"일 때만 조용한
// "저장됨" 표시를 올리고, 실패(failed/quota-exceeded)·빈 메모(idle)에는
// 내린다.
//
// saving/retrying 은 일부러 손대지 않는다(coder-task.md §2-4-ⓔ, PRD §6
// "거슬림 없음"): 디바운스 대기·재시도 1회는 매 입력마다 지나가는 전이
// 상태라, 그때마다 표시를 내렸다 올리면 오히려 더 거슬린다. 그래서 표시는
// "마지막으로 확정된 저장 결과"를 들고 있다가 다음 ok/failed/quota-
// exceeded/idle 이 올 때만 갈아 치운다.
export function updateSaveIndicator(el, status) {
  if (!el) return;
  if (status === "ok") {
    el.classList.add("is-visible");
  } else if (
    status === "failed" ||
    status === "quota-exceeded" ||
    status === "idle"
  ) {
    el.classList.remove("is-visible");
  }
}
