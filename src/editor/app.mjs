// 브라우저 엔트리(에스빌드로 번들). 라이브 렌더링 화면(HYK-304-render-1)
// 에 이어 HYK-304-storage-1 이 저장·자동저장을, 이 라운드(HYK-304-
// memo-list-1)가 메모 목록(홈) 화면과 두 화면 오가기를 붙인다 --
// PRD §6/§7/§8, coder-task.md §0.
import { createEditor } from "lexical";
import { registerMarkdownShortcuts } from "@lexical/markdown";
import { registerRichText } from "@lexical/rich-text";
import tokens from "../../spec/design-tokens.json";
import { PRODUCT_TRANSFORMERS, PRODUCT_NODES } from "./transformers.mjs";
import { serializeEditorToMarkdown } from "./serialize.mjs";
import { EDITOR_THEME } from "./theme.mjs";
import { mountStorage, openMemoInEditor } from "./storage-mount.mjs";
import { mountNotionCopy } from "./notion-copy.mjs";
import { mountMemoList } from "./memo-list-mount.mjs";
import { createIndexedDbAdapter } from "../storage/indexeddb-adapter.mjs";
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

// PRD §6 IA "메모 목록(홈)—에디터 2화면". 두 화면은 항상 둘 다 DOM 에
// 있고 hidden 속성만 토글한다(라우팅 라이브러리 없이 의존 0 유지).
function showScreen(screens, name) {
  const showEditor = name === "editor";
  screens.editor.hidden = !showEditor;
  screens.list.hidden = showEditor;
}

function grabElements() {
  return {
    editorRoot: document.getElementById("editor-root"),
    rawPanel: document.getElementById("raw-panel"),
    saveNotice: document.getElementById("save-notice"),
    copyButton: document.getElementById("notion-copy-button"),
    copyToast: document.getElementById("notion-copy-toast"),
    listRoot: document.getElementById("list-root"),
    newMemoButton: document.getElementById("new-memo-button"),
    backButton: document.getElementById("back-to-list-button"),
    screens: {
      list: document.getElementById("list-screen"),
      editor: document.getElementById("editor-screen"),
    },
  };
}

// "+"(새 메모)·뒤로가기(PRD §6 "에디터 뒤로→목록(자동저장)") 배선.
// 목록 카드 클릭(다른 메모 열기)은 mountMemoList 의 onOpen 콜백(아래
// main())이 맡는다 -- 이 함수는 그와 짝이 되는 나머지 두 진입점이다.
function wireListNavigation({ newMemoButton, backButton, screens }, ctx) {
  const { editor, store, adapter, list } = ctx;
  newMemoButton.addEventListener("click", () => {
    openMemoInEditor(editor, store, adapter, store.restoreState, null).then(
      () => showScreen(screens, "editor"),
    );
  });
  backButton.addEventListener("click", () => {
    store
      .flushImmediate()
      .then(() => writeCurrentMemoId(store.getMemoId()))
      .finally(() => {
        list.refresh();
        showScreen(screens, "list");
      });
  });
}

function main() {
  applyDesignTokens();
  const elements = grabElements();
  const adapter = createIndexedDbAdapter();
  const editor = mountEditor(elements.editorRoot);
  mountRawPanel(editor, elements.rawPanel);
  const store = mountStorage(editor, elements.saveNotice, adapter);
  mountNotionCopy(editor, store, {
    button: elements.copyButton,
    toast: elements.copyToast,
  });

  const list = mountMemoList(elements.listRoot, adapter, {
    onOpen: (id) =>
      openMemoInEditor(editor, store, adapter, store.restoreState, id).then(
        () => showScreen(elements.screens, "editor"),
      ),
  });
  wireListNavigation(elements, { editor, store, adapter, list });

  // PRD §5b "입력이 목록 로딩을 안 기다린다": mountStorage 가 이미
  // registerUpdateListener 를 동기로 등록했으므로(에디터는 지금부터
  // 입력 가능) 아래 두 비동기 작업(목록 조회·초기 복원 확인)을 기다리지
  // 않는다 -- 둘 다 fire-and-forget 이고, 화면 전환만 그 결과에 뒤따른다.
  list.refresh();
  store.initialRestoreReady.then(() => {
    // restoreCurrentMemo(mountStorage 내부)는 pointer 가 가리키는 메모가
    // 없거나 이미 삭제됐으면 pointer 를 비운다(storage-mount.mjs) -- 그
    // 부작용이 끝난 뒤라 readCurrentMemoId() 로 "복원할 것이 있었는가"를
    // 그대로 판단할 수 있다.
    showScreen(elements.screens, readCurrentMemoId() ? "editor" : "list");
  });
}

main();
