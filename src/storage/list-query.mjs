// PRD §6 IA("메모 목록(홈)—에디터 2화면 · 목록 최신 수정순") + 이 라운드
// 표제 불변식(1)(2)(coder-task.md): 목록에 보이는 것은 저장된 메모
// «전부»이고 «그것뿐»이며(삭제시각 있는 메모·빈 메모는 안 보임), 언제나
// 최신 수정순이다. adapter.list()(IndexedDB getAll)는 순서를 보장하지
// 않으므로 이 함수가 그 순서 보장을 만들어 화면(memo-list-view.mjs)에
// 넘긴다 -- 화면은 이 함수가 돌려준 순서를 그대로 믿고 그린다.
//
// body 길이 0 제외는 방어적이다: 정상 경로(memo-store.mjs handleContentChange)
// 는 빈 본문 메모를 저장하지 않으므로 실제로는 나타나지 않아야 하지만,
// 그 불변을 이 목록 조회 자체도 지키게 해 "빈 메모도 안 보인다"(불변식
// (1))가 쓰기 경로 하나에만 의존하지 않게 한다.
export function visibleMemosSortedByUpdatedAt(records) {
  return records
    .filter((memo) => memo.deletedAt === null && memo.body.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// HYK-304-lifecycle-orphans-1 ⓐ: memo-lifecycle.mjs 의 hard-delete 예약이
// 메모리 setTimeout 뿐이라, 유예(graceMs) 안에 앱이 닫히면 그 레코드는
// deletedAt 이 찍힌 채 저장소에 영구히 남는다(목록에서는 위
// visibleMemosSortedByUpdatedAt 필터로 이미 숨어 있어 화면상으로는 드러나지
// 않는 저장공간 누수). 다음 시작에 "무엇이 지워져야 하는가"(이 순수 필터)
// 와 "어떻게 지우는가"(memo-lifecycle.mjs 의 cleanupExpiredDeletes, adapter
// 호출)를 나눈다 -- 위 visible 필터와 같은 자리에 두는 이유도 같다: 둘 다
// records 배열 위의 순수 조회다. 유예가 아직 안 지난(now < deletedAt +
// graceMs) 레코드는 여기 포함하지 않는다 -- 지우면 안 되는 레코드다.
export function expiredDeletedMemoIds(records, { now, graceMs }) {
  return records
    .filter(
      (memo) => memo.deletedAt !== null && memo.deletedAt + graceMs <= now,
    )
    .map((memo) => memo.id);
}
