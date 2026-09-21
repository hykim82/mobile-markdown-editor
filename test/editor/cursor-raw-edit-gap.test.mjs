// coder-task.md §3-ⓖ (PRD §5.2 수용 기준③): "렌더링된 서식 영역에 커서
// 진입 시 그 줄의 마크다운 원문을 그대로 복원해 편집 가능"해야 한다.
//
// ⚠️정직 한계(못 재면 못 쟀다고 값으로 적고 §5 사람 눈 칸으로 넘겨라,
// coder-task.md §3-ⓖ 지시대로): registerMarkdownShortcuts 는 트리거가
// 완성되는 순간 원본 마크다운 기호("#", "**", "~~" 등)를 노드 트리에서
// 영구히 지운다(예: "# 제목" 을 치면 HeadingNode 는 텍스트로 "제목"만
// 갖고 "#"는 어디에도 남지 않는다). 그래서 "커서가 그 영역에 들어오면
// 원문이 «복원»된다"는 동작은 registerMarkdownShortcuts 를 그대로 쓰는
// 것만으로는 구조적으로 생기지 않는다 -- 커서 진입을 감지해 원문을
// 다시 조립하고 임시로 되돌려 보여주는 별도 상태 기계가 필요한데, 그건
// 이번 «화면 최소» 조각의 범위를 넘는 별도 설계 항목이다(1B_reach_path:
// 이 조각은 "화면이 생기는 첫 조각"이지 그 기능의 완성이 아니다).
//
// 그래서 이 시험은 "됐다"를 주장하지 않고, 대신 그 한계가 정확히 어디
// 있는지를 기계로 고정한다: 트리거가 완성된 뒤 헤딩 노드의 텍스트에는
// "#" 프리픽스가 전혀 남아있지 않다는 것 -- 즉 커서 진입만으로 그 문자를
// 되살릴 원본 데이터가 노드 트리 자체에는 없다는 사실을 증명한다. 사람
// 육안 확인 항목(§5)에서 이 동작을 실제로 확인해야 한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../support/jsdom-env.mjs";
import { $getRoot } from "lexical";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { PRODUCT_TRANSFORMERS } from "../../src/editor/transformers.mjs";
import { makeProductEditor } from "../support/make-editor.mjs";

test('알려진 한계: 트리거 완성 후 헤딩 노드 텍스트에는 "#"가 전혀 남아 있지 않다(커서 진입 복원용 원문 데이터가 노드에 없음)', () => {
  const { editor } = makeProductEditor();
  editor.update(
    () => {
      $convertFromMarkdownString("# 제목", PRODUCT_TRANSFORMERS);
    },
    { discrete: true },
  );
  const headingText = editor
    .getEditorState()
    .read(() => $getRoot().getFirstChild().getTextContent());
  assert.equal(headingText, "제목");
  assert.ok(
    !headingText.includes("#"),
    "헤딩 노드가 원본 '#' 프리픽스를 어딘가에 보관하고 있다면 이 한계 기록은 갱신이 필요하다",
  );
});
