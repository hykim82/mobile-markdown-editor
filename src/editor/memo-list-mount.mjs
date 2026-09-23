// storage-mount.mjs 와 같은 자리(app.mjs 배선 vs fake adapter 로 직접
// 재는 시험 대상)의 목록 화면 쪽 짝(coder-task.md §0-1). adapter.list()
// -> list-query.mjs 의 정렬·필터 -> memo-list-view.mjs 의 DOM 렌더까지
// 한 호출로 잇는다.
import { visibleMemosSortedByUpdatedAt } from "../storage/list-query.mjs";
import { renderMemoList } from "./memo-list-view.mjs";

// PRD §5b "실행→입력 1초 내 -- 입력이 목록 로딩을 안 기다린다": 이 함수는
// adapter.list() 를 기다리는 refresh() 를 리턴만 하고, mountMemoList
// 자신은 그 Promise 를 기다리지 않는다(app.mjs 가 mountMemoList 를 부른
// 뒤 바로 이어서 에디터를 마운트한다 -- 에디터 쪽 registerUpdateListener
// 등록은 이 목록 로딩과 무관한 별개 코드 경로라 이 fetch 가 끝나지
// 않아도 입력을 막지 않는다).
export function mountMemoList(container, adapter, { onOpen } = {}) {
  async function refresh() {
    const records = await adapter.list();
    const visible = visibleMemosSortedByUpdatedAt(records);
    renderMemoList(container, visible, { onOpen });
    return visible;
  }

  return { refresh };
}
