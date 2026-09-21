// 범위 다리(coder-task.md §2-3 "메모 목록(홈) 화면은 범위 밖" 과의 접합
// 지점): 지금은 목록/라우팅이 없어 "에디터가 지금 열고 있는 메모가
// 무엇인지"를 저장할 화면이 없다. 이 한 줄(localStorage 포인터)만 그
// 자리를 임시로 메운다 -- 목록 화면이 생기면(다음 조각) 라우팅이 이
// 역할을 대신하고 이 파일은 없어진다. IndexedDB(메모 본문)와는 별개
// 저장소라 이 포인터를 잃어도 메모 데이터 자체는 안 없어진다.
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
