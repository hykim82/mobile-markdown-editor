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
async function restoreCurrentMemo(editor, store, adapter) {
  const existingId = readCurrentMemoId();
  if (!existingId) return;
  const record = await adapter.get(existingId);
  if (!record || record.deletedAt !== null) {
    writeCurrentMemoId(null);
    return;
  }
  store.loadMemo(record);
  restoreMarkdownIntoEditor(editor, record.body);
}

function mountStorage(editor, notice) {
  const adapter = createIndexedDbAdapter();
  const store = createMemoStore(adapter, {
    onStatusChange: (status) => updateSaveNotice(notice, status),
  });

  restoreCurrentMemo(editor, store, adapter).then(() => {
    editor.registerUpdateListener(() => {
      const body = serializeEditorToMarkdown(editor);
      store.onContentChange(body).then(() => {
        writeCurrentMemoId(store.getMemoId());
      });
    });
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
