// coder-task.md §0-2-⑹ 증거물: storage-adapter 계약(put/get/list/remove)
// 을 만족하는 두 번째 구현(메모리, 어디에도 실제로 쓰지 않는다).
// test/support/adapter-contract.mjs 가 이 구현과 IndexedDB 구현
// (src/storage/indexeddb-adapter.mjs) 양쪽에 «똑같은» 시험을 돌려
// 인터페이스가 실제로 갈아끼워짐을 보인다. memo-store 의 실패·재시도·
// 저장공간 부족 시험에도 이 구현의 forceNextPutFailures 를 써서 저장
// 실패를 결정적으로 재현한다.
export function createFakeAdapter() {
  const rows = new Map();
  let failuresLeft = 0;
  let failureToThrow = null;
  let listFailuresLeft = 0;
  let listFailureToThrow = null;

  return {
    async put(memo) {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw failureToThrow ?? new Error("fake-adapter: forced put failure");
      }
      rows.set(memo.id, { ...memo });
    },
    async get(id) {
      const memo = rows.get(id);
      return memo ? { ...memo } : undefined;
    },
    async list() {
      if (listFailuresLeft > 0) {
        listFailuresLeft -= 1;
        throw (
          listFailureToThrow ?? new Error("fake-adapter: forced list failure")
        );
      }
      return [...rows.values()].map((memo) => ({ ...memo }));
    },
    async remove(id) {
      rows.delete(id);
    },
    // 계약 밖의 시험 전용 제어 훅 -- runAdapterContractTests 는 이 메서드를
    // 부르지 않는다(어댑터 계약은 put/get/list/remove 넷뿐이다).
    forceNextPutFailures(times, error) {
      failuresLeft = times;
      failureToThrow = error ?? null;
    },
    // coder-task.md §2(P2-1): 목록 조회(저장 계층) 실패를 결정적으로
    // 재현하는 훅 -- forceNextPutFailures 와 같은 모양.
    forceNextListFailures(times, error) {
      listFailuresLeft = times;
      listFailureToThrow = error ?? null;
    },
  };
}
