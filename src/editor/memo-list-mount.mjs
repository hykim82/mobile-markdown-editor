// storage-mount.mjs 와 같은 자리(app.mjs 배선 vs fake adapter 로 직접
// 재는 시험 대상)의 목록 화면 쪽 짝(coder-task.md §0-1). adapter.list()
// -> list-query.mjs 의 정렬·필터 -> memo-list-view.mjs 의 DOM 렌더까지
// 한 호출로 잇는다.
import { visibleMemosSortedByUpdatedAt } from "../storage/list-query.mjs";
import { renderMemoList, renderMemoListError } from "./memo-list-view.mjs";

// PRD §5b "실행→입력 1초 내 -- 입력이 목록 로딩을 안 기다린다": 이 함수는
// adapter.list() 를 기다리는 refresh() 를 리턴만 하고, mountMemoList
// 자신은 그 Promise 를 기다리지 않는다(app.mjs 가 mountMemoList 를 부른
// 뒤 바로 이어서 에디터를 마운트한다 -- 에디터 쪽 registerUpdateListener
// 등록은 이 목록 로딩과 무관한 별개 코드 경로라 이 fetch 가 끝나지
// 않아도 입력을 막지 않는다).
//
// coder-task.md §2 (P2-1): app.mjs 가 이 refresh() 를 fire-and-forget 으로
// 부르므로(main() 이 기다리지 않는다), adapter.list() 가 거부되면 그
// 거부가 여기서 잡히지 않는 한 unhandledRejection 으로 새 나간다 --
// 화면은 "제목 + 빈 본문"뿐이고 사용자는 실패했다는 것 자체를 모른다
// (§2-1 실측). try/catch 로 그 거부를 여기서 끝내고, 실패 화면을
// 그린다. 재시도 = refresh 자기 자신을 다시 부르는 것 -- 저장 계층이
// 되살아 있으면 다음 호출은 정상 경로(renderMemoList)로 되돌아간다.
export function mountMemoList(container, adapter, { onOpen } = {}) {
  async function refresh() {
    let records;
    try {
      records = await adapter.list();
    } catch {
      renderMemoListError(container, { onRetry: refresh });
      return null;
    }
    const visible = visibleMemosSortedByUpdatedAt(records);
    renderMemoList(container, visible, { onOpen });
    return visible;
  }

  return { refresh };
}
