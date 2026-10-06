// 제품 에디터 결선을 한 곳에 모은다(HYK-304-cursor-raw-restore-1, 1안).
// app.mjs(브라우저 엔트리)와 test/support/make-editor.mjs(시험 헬퍼)가 둘 다
// 이 함수를 부른다 -- 예전엔 두 곳이 같은 결선을 복제했고, 그 틈에서 시험
// 헬퍼에만 새 기능을 걸어도 제품에는 안 걸린 채 시험이 전부 초록일 수 있었다.
import { createEditor } from "lexical";
import { registerMarkdownShortcuts } from "@lexical/markdown";
import { registerRichText } from "@lexical/rich-text";
import { PRODUCT_TRANSFORMERS, PRODUCT_NODES } from "./transformers.mjs";
import { EDITOR_THEME } from "./theme.mjs";
import { registerCursorRaw } from "./cursor-raw.mjs";
import { registerChecklistPromotion } from "./checklist-promote.mjs";

export function createProductEditor(root, { namespace, onError }) {
  const editor = createEditor({
    namespace,
    onError,
    nodes: PRODUCT_NODES,
    theme: EDITOR_THEME,
  });
  editor.setRootElement(root);
  registerRichText(editor);
  registerMarkdownShortcuts(editor, PRODUCT_TRANSFORMERS);
  registerChecklistPromotion(editor);
  registerCursorRaw(editor);
  return editor;
}
