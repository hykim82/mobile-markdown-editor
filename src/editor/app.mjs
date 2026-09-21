// 브라우저 엔트리(에스빌드로 번들). 이 조각의 «화면 최소 하나» -- 입력하는
// 즉시 실제 서식으로 보이는 라이브 렌더링 하나, 그리고 그 옆에 «지금
// 원문은 이것이다»를 그대로 보여주는 개발용 패널(coder-task.md
// §1-B-ⓑ-2, 저장·클립보드 경로는 만들지 않음).
import { createEditor } from "lexical";
import { registerMarkdownShortcuts } from "@lexical/markdown";
import { registerRichText } from "@lexical/rich-text";
import tokens from "../../spec/design-tokens.json";
import { PRODUCT_TRANSFORMERS, PRODUCT_NODES } from "./transformers.mjs";
import { serializeEditorToMarkdown } from "./serialize.mjs";
import { EDITOR_THEME } from "./theme.mjs";

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
  const editor = mountEditor(editorRoot);
  mountRawPanel(editor, rawPanel);
}

main();
