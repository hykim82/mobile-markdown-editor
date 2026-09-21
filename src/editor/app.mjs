// 브라우저 엔트리(에스빌드로 번들). 라이브 렌더링 화면(HYK-304-render-1)
// 에 이어 이 라운드(HYK-304-storage-1)가 저장·자동저장을 붙인다 --
// PRD §7/§8, coder-task.md §0.
import { createEditor } from "lexical";
import { registerMarkdownShortcuts } from "@lexical/markdown";
import { registerRichText } from "@lexical/rich-text";
import tokens from "../../spec/design-tokens.json";
import { PRODUCT_TRANSFORMERS, PRODUCT_NODES } from "./transformers.mjs";
import { serializeEditorToMarkdown } from "./serialize.mjs";
import { EDITOR_THEME } from "./theme.mjs";
import { restoreMarkdownIntoEditor } from "./restore.mjs";
import { createIndexedDbAdapter } from "../storage/indexeddb-adapter.mjs";
import { createMemoStore } from "../storage/memo-store.mjs";
import {
  readCurrentMemoId,
  writeCurrentMemoId,
} from "../storage/current-memo-pointer.mjs";

function applyDesignTokens() {
  const root = document.documentElement;
  root.style.setProperty("--color-bg", tokens["color.bg"].light);
  root.style.setProperty(
    "--color-bg-elevated",
    tokens["color.bg.elevated"].light,
  );
  root.style.setProperty(
    "--color-text-primary",
    tokens["color.text.primary"].light,
  );
  root.style.setProperty(
    "--color-text-muted",
    tokens["color.text.muted"].light,
  );
  root.style.setProperty("--color-accent", tokens["color.accent"].light);
  root.style.setProperty("--color-border", tokens["color.border"].light);
  root.style.setProperty("--font-family", tokens["font.family"]);
  root.style.setProperty("--font-size-body", tokens["font.size.body"]);
  root.style.setProperty(
    "--line-height-body",
    String(tokens["line.height.body"]),
  );
}

function mountEditor(container) {
  const editor = createEditor({
    namespace: "mobile-markdown-editor",
    onError: (error) => {
      throw error;
    },
    nodes: PRODUCT_NODES,
    theme: EDITOR_THEME,
  });
  editor.setRootElement(container);
  registerRichText(editor);
  registerMarkdownShortcuts(editor, PRODUCT_TRANSFORMERS);
  return editor;
}

function mountRawPanel(editor, panel) {
  const render = () => {
    panel.textContent = serializeEditorToMarkdown(editor);
  };
  editor.registerUpdateListener(render);
  render();
}

function updateSaveNotice(notice, status) {
  if (status === "quota-exceeded") {
    notice.textContent =
      "저장 공간이 부족해요(placeholder 알림 문구 -- 최종 카피는 디자인 확정 필요, coder-task.md §0-2-⑴)";
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
async function restoreCurrentMemo(editor, store, adapter, restoreState) {
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
  restoreMarkdownIntoEditor(editor, record.body);
  restoreState.applying = false;
}

function mountStorage(editor, notice) {
  const adapter = createIndexedDbAdapter();
  const store = createMemoStore(adapter, {
    onStatusChange: (status) => updateSaveNotice(notice, status),
  });

  const restoreState = { applying: false, userEdited: false, done: false };

  // ⛔정정(review.md §4-4): 예전 코드는 이 리스너를 restoreCurrentMemo 가
  // "끝난 뒤"에만 등록했다 -- 그래서 IndexedDB 조회가 도는 동안 사용자가
  // 친 글자는 저장 없이 버려졌고, 조회가 끝나면 restoreMarkdownIntoEditor
  // 의 root.clear() 가 그 화면 내용마저 덮어썼다. 이제 리스너를 조회를
  // "기다리지 않고" 지금 바로 등록해 그 틈의 입력도 놓치지 않는다.
  editor.registerUpdateListener(() => {
    if (restoreState.applying) return;
    if (!restoreState.done) restoreState.userEdited = true;
    const body = serializeEditorToMarkdown(editor);
    store.onContentChange(body).then(() => {
      writeCurrentMemoId(store.getMemoId());
    });
  });

  restoreCurrentMemo(editor, store, adapter, restoreState).finally(() => {
    restoreState.done = true;
  });

  // 정책 "자동저장": 뒤로가기·백그라운드 전환 시 즉시 저장.
  const flushOnHide = () => {
    store.flushImmediate().then(() => writeCurrentMemoId(store.getMemoId()));
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnHide();
  });
  window.addEventListener("pagehide", flushOnHide);

  return store;
}

function main() {
  applyDesignTokens();
  const editorRoot = document.getElementById("editor-root");
  const rawPanel = document.getElementById("raw-panel");
  const saveNotice = document.getElementById("save-notice");
  const editor = mountEditor(editorRoot);
  mountRawPanel(editor, rawPanel);
  mountStorage(editor, saveNotice);
}

main();
