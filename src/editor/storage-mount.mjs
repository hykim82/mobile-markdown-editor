// app.mjs(브라우저 엔트리) 에서 저장·자동저장 배선만 떼어낸 파일 --
// coder-task.md §0-2-⑹, PRD §7/§8. app.mjs 는 맨 아래에서 main() 을
// 즉시 실행하는 부수효과가 있어(에스빌드 엔트리라 그게 맞다) 그 파일을
// 그대로 import 하면 test 환경에도 main() 이 함께 실행돼 DOM 이 없어
// 터진다. mountStorage/restoreCurrentMemo 는 fake adapter 로 직접 재는
// 시험 대상이라 부수효과 없는 이 파일로 분리한다.
import { serializeEditorToMarkdown } from "./serialize.mjs";
import { restoreMarkdownIntoEditor } from "./restore.mjs";
import { createIndexedDbAdapter } from "../storage/indexeddb-adapter.mjs";
import { createMemoStore } from "../storage/memo-store.mjs";
import {
  readCurrentMemoId,
  writeCurrentMemoId,
} from "../storage/current-memo-pointer.mjs";

export function updateSaveNotice(notice, status) {
  if (status === "quota-exceeded") {
    notice.textContent =
      "저장 공간이 부족해요(placeholder 알림 문구 -- 최종 카피는 디자인 확정 필요, coder-task.md §0-2-⑴)";
    notice.hidden = false;
  } else if (status === "restore-mismatch") {
    // 소수리 A(coder-task.md §1-⑺, 3R 검토 P2-4): 복원 불일치로
    // 자동저장이 차단되면 예전엔 console.error 만 남아 사용자는 자기
    // 입력이 저장되지 않는 것을 몰랐다. 문구는 placeholder -- 최종 카피
    // 확정은 한용 몫이다.
    notice.textContent =
      "저장이 막혔습니다 -- 새로 고침 뒤 다시 확인해 주세요(placeholder 알림 문구 -- 최종 카피는 디자인 확정 필요, coder-task.md §1-⑺)";
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
}

// 범위 다리(current-memo-pointer.mjs 참고): 메모 목록 화면이 없는 지금,
// localStorage 에 적어 둔 마지막 메모 id 가 있으면 그 메모를 불러와
// 에디터에 되돌린다("치고 -> 닫고 -> 다시 열면 그대로", §0-2-⑸).
//
// ⛔정정(review.md §4-4 · HYK-304-storage-2): adapter.get 은 비동기라
// 이 조회가 도는 동안에도 사용자는 이미 타이핑할 수 있다. restoreState 는
// 그 틈에 친 글자를 잃지 않기 위한 신호다 -- applying 은 이 함수가
// root.clear() 로 화면을 덮어쓰는 그 한 번의 update 만 표시하고(그 동안은
// mountStorage 의 리스너가 저장을 건너뛴다 -- 방금 막 불러온 내용을
// 다시 저장할 필요가 없다), userEdited 는 그 리스너가 "이건 restore 가
// 만든 update 가 아니라 진짜 사용자 입력"이라고 관측했음을 말한다.
// userEdited 가 이미 true 면 사용자가 조회보다 먼저 타이핑을 시작한
// 것이므로 여기서 store.loadMemo/restoreMarkdownIntoEditor 를 걸지
// 않는다 -- 그 두 호출이 곧 root.clear() 로 사용자가 막 친 글자를
// 지워버리는 통로이기 때문이다.
//
// ⭐런타임 안전판(coder-task.md §1-⑷ · "모양 전수를 놓쳐도 데이터가 안
// 사라지게 하는 마지막 문"): restoreMarkdownIntoEditor 가 restore.mjs 의
// tokenizeInline 이 아직 상상 못 한 모양(다음 P1)에서 원문을 훼손해도,
// 그 훼손이 즉시 자동저장으로 이어져 저장된 원문을 덮어쓰지는 않게
// 막는다. 복원 직후(사용자가 아무것도 치기 전) 에디터를 다시 직렬화해
// "방금 불러온 저장 원문"과 바이트가 같은지 그 자리에서 확인하고, 다르면
// restoreState.autosaveBlocked 를 세워 이후 자동저장을 전부 콘솔 기록으로
// 돌린다(§1-⑷-ⓑ) -- 세션 하나를 자동저장 없이 보내는 게, 눈치채지 못한
// 채 멀쩡한 저장 원문을 훼손된 값으로 덮어쓰는 것보다 훨씬 싸다.
export async function restoreCurrentMemo(
  editor,
  store,
  adapter,
  restoreState,
  {
    restoreFn = restoreMarkdownIntoEditor,
    serializeFn = serializeEditorToMarkdown,
    logFn = (...args) => console.error(...args),
  } = {},
) {
  const existingId = readCurrentMemoId();
  if (!existingId) return;
  const record = await adapter.get(existingId);
  if (restoreState.userEdited) return;
  if (!record || record.deletedAt !== null) {
    writeCurrentMemoId(null);
    return;
  }
  store.loadMemo(record);
  restoreState.applying = true;
  restoreFn(editor, record.body);
  restoreState.applying = false;

  const restoredBody = serializeFn(editor);
  if (restoredBody !== record.body) {
    restoreState.autosaveBlocked = true;
    logFn(
      "[storage] restore round-trip mismatch -- refusing to autosave over this memo until reload",
      { memoId: record.id, storedBody: record.body, restoredBody },
    );
  }
}

// restoreOptions 는 프로덕션에서 안 쓴다(항상 기본값) -- restore.mjs/
// serialize.mjs 를 실제로 갈아끼우지 않고도 "복원이 훼손을 냈다"는
// 상황을 시험이 직접 주입해 안전판(§1-⑷)만 독립적으로 재는 통로다.
export function mountStorage(
  editor,
  notice,
  adapter = createIndexedDbAdapter(),
  restoreOptions = {},
) {
  const store = createMemoStore(adapter, {
    onStatusChange: (status) => updateSaveNotice(notice, status),
  });

  const restoreState = {
    applying: false,
    userEdited: false,
    done: false,
    autosaveBlocked: false,
  };

  // ⛔정정(review.md §4-4): 예전 코드는 이 리스너를 restoreCurrentMemo 가
  // "끝난 뒤"에만 등록했다 -- 그래서 IndexedDB 조회가 도는 동안 사용자가
  // 친 글자는 저장 없이 버려졌고, 조회가 끝나면 restoreMarkdownIntoEditor
  // 의 root.clear() 가 그 화면 내용마저 덮어썼다. 이제 리스너를 조회를
  // "기다리지 않고" 지금 바로 등록해 그 틈의 입력도 놓치지 않는다.
  //
  // ⭐변경 플래그는 "사용자 입력에서만" 선다(coder-task.md §1-⑷-ⓐ): 이
  // 리스너는 restoreState.applying(= restoreCurrentMemo 자신의 update)일
  // 때 맨 위에서 돌아가므로, userEdited 가 true 로 서는 유일한 경로는
  // restore 가 만들지 않은 update -- 즉 실제 사용자 입력이다.
  editor.registerUpdateListener(() => {
    if (restoreState.applying) return;
    if (!restoreState.done) restoreState.userEdited = true;
    if (restoreState.autosaveBlocked) {
      console.error(
        "[storage] autosave skipped: an earlier restore for this memo did not round-trip losslessly",
      );
      // 소수리 A(§1-⑺): console.error 뿐이면 사용자는 자기 입력이
      // 저장되지 않는 것을 모른다 -- 같은 신호를 화면에도 띄운다.
      updateSaveNotice(notice, "restore-mismatch");
      return;
    }
    const body = serializeEditorToMarkdown(editor);
    store.onContentChange(body).then(() => {
      writeCurrentMemoId(store.getMemoId());
    });
  });

  restoreCurrentMemo(editor, store, adapter, restoreState, restoreOptions)
    .then(() => {
      // 사용자가 아직 한 글자도 안 쳤어도(위 리스너가 아직 안 불렸어도)
      // 복원 시점에 이미 불일치가 잡혔다면 그 즉시 화면에 띄운다.
      if (restoreState.autosaveBlocked) {
        updateSaveNotice(notice, "restore-mismatch");
      }
    })
    .finally(() => {
      restoreState.done = true;
    });

  // 정책 "자동저장": 뒤로가기·백그라운드 전환 시 즉시 저장.
  const flushOnHide = () => {
    if (restoreState.autosaveBlocked) return;
    store.flushImmediate().then(() => writeCurrentMemoId(store.getMemoId()));
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnHide();
  });
  window.addEventListener("pagehide", flushOnHide);

  return store;
}
