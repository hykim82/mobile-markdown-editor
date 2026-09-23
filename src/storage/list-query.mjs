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
