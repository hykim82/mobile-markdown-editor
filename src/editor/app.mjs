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
import { mountStorage } from "./storage-mount.mjs";

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
