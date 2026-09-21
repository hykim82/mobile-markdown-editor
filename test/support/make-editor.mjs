// 공용 테스트 헬퍼 -- jsdom-env.mjs 를 먼저 import 한 테스트 파일에서만
// 쓴다(lexical 이 import 시점에 브라우저 DOM 전역을 요구하기 때문).
import { createEditor } from "lexical";
import { registerMarkdownShortcuts } from "@lexical/markdown";
import { registerRichText } from "@lexical/rich-text";
import {
  PRODUCT_TRANSFORMERS,
  PRODUCT_NODES,
} from "../../src/editor/transformers.mjs";
import { EDITOR_THEME } from "../../src/editor/theme.mjs";
import { makeEditableRoot } from "./jsdom-env.mjs";

export function makeProductEditor() {
  const editor = createEditor({
    namespace: "test-editor",
    onError: (error) => {
      throw error;
    },
    nodes: PRODUCT_NODES,
    theme: EDITOR_THEME,
  });
  const root = makeEditableRoot();
  editor.setRootElement(root);
  registerRichText(editor);
  registerMarkdownShortcuts(editor, PRODUCT_TRANSFORMERS);
  return { editor, root };
}

// registerMarkdownShortcuts 는 자신의 update 리스너 안에서 새 update() 를
// 걸어 트랜스폼을 적용한다 -- 그 nested update 는 트리거를 만든 update와
// 같은 사이클에 동기로 끝나지 않는다(실측: 다음 마이크로태스크/태스크에
// 반영). 그래서 트랜스폼 결과를 보려면 한 사이클 더 기다려야 한다.
export function waitForNextUpdate(editor) {
  return new Promise((resolve) => {
    const unregister = editor.registerUpdateListener(() => {
      unregister();
      resolve();
    });
  });
}
