// 범위 다리(coder-task.md §2-3 "메모 목록(홈) 화면은 범위 밖" 과의 접합
// 지점)로 태어났지만, 그 서술은 이미 낡았다(HYK-304-list-error-wiring-1
// §4 · P2-ⓔ): 목록 화면(memo-list-mount.mjs)이 생긴 지금도 "에디터가
// 지금 열고 있는 메모가 무엇인지"를 라우팅이 대신하지 않는다 -- app.mjs
// 가 readCurrentMemoId/writeCurrentMemoId 를 그대로 임포트해 부팅 시
// 첫 화면 선택과 화면 전환마다 쓴다. 이 한 줄(localStorage 포인터)이
// 계속 그 역할을 맡는다. IndexedDB(메모 본문)와는 별개 저장소라 이
// 포인터를 잃어도 메모 데이터 자체는 안 없어진다.
const KEY = "mobile-markdown-editor:current-memo-id";

export function readCurrentMemoId() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeCurrentMemoId(id) {
  try {
    if (id) {
      localStorage.setItem(KEY, id);
    } else {
      localStorage.removeItem(KEY);
    }
  } catch {
    // localStorage 자체가 막힌 환경(사생활 모드 등)이면 "지금 메모
    // 기억하기"만 포기한다 -- 본문 저장(IndexedDB)은 별개 경로라 안 죽는다.
  }
}
