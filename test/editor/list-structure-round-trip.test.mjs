// review.md P1-1(HYK-304-linebreak-2 반려 사유) -- 기존 왕복 시험은 전부
// "바이트가 같은가"만 잰다. 하지만 P1-1 의 손상 모양은 "손상된 바이트를
// 다시 저장해도 똑같은 바이트가 나오는" 고정점이라, 바이트 동일성 축은
// 이 결함 계열을 원리적으로 볼 수 없다(review.md §0-4/P2-5). 그래서 이
// 파일은 별도 축을 세운다: 저장 -> 복원 -> 재저장 전후로 ⓐ블록/항목의
// "개수" ⓑ각 노드의 "종류" ⓒ체크박스의 "체크 상태"가 같은지를 잰다.
//
// 원본 구조는 항상 "타이핑 그대로의" Lexical 노드를 제품 직렬화기를
// 거치지 않고 직접 조립해서 만든다(review.md 가 재현한 방법과 같다 --
// "제품 에디터에 만들고 제품 직렬화기로 저장"). restoreMarkdownIntoEditor
// 로 만든 트리를 기준(before)으로 삼지 않는다 -- 그러면 restore.mjs 자체의
// 버그가 기준값에도 스며들어 왕복이 우연히 "안정적으로 틀린" 채로
// 통과할 수 있다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  $getRoot,
  $createTextNode,
  $isTextNode,
  $isLineBreakNode,
} from "lexical";
import {
  $createListNode,
  $createListItemNode,
  $isListNode,
  $isListItemNode,
} from "@lexical/list";
import { makeProductEditor } from "../support/make-editor.mjs";
import { restoreMarkdownIntoEditor } from "../../src/editor/restore.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";

function nodeKind(node) {
  if ($isLineBreakNode(node)) return "linebreak";
  if ($isTextNode(node)) return "text";
  return "other";
}

// ⓐ항목 개수 ⓑ각 자식 노드 종류 ⓒ체크 상태를 한 서명으로 묶는다.
// root 에는 항상 목록 노드 하나만 둔다(이 축의 재현 범위).
function listStructureSignature(editor) {
  return editor.getEditorState().read(() => {
    const root = $getRoot();
    const blocks = root.getChildren();
    assert.equal(
      blocks.length,
      1,
      "이 축의 입력은 항상 최상위 블록 1개(목록)다",
    );
    const list = blocks[0];
    assert.ok($isListNode(list), "최상위 블록은 목록 노드여야 한다");
    return {
      listType: list.getListType(),
      items: list
        .getChildren()
        .filter($isListItemNode)
        .map((item) => ({
          checked: list.getListType() === "check" ? item.getChecked() : null,
          childKinds: item.getChildren().map(nodeKind),
        })),
    };
  });
}

// review.md 재현과 같은 방식 -- markdown 문자열을 거치지 않고 Lexical 노드를
// 직접 조립한다("타이핑 그대로"의 편집기 상태).
function buildTypedListEditor({ listType, items }) {
  const { editor } = makeProductEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const list = $createListNode(listType);
      for (const item of items) {
        const listItem =
          listType === "check"
            ? $createListItemNode(item.checked)
            : $createListItemNode();
        for (const seg of item.segments) {
          const textNode = $createTextNode(seg.text);
          if (seg.bold) textNode.toggleFormat("bold");
          listItem.append(textNode);
        }
        list.append(listItem);
      }
      root.append(list);
    },
    { discrete: true },
  );
  return editor;
}

// review.md §2 -- 생성기 축에 백슬래시 좌표가 "없었다"는 빈칸을 채운다.
// 여기는 네 위치 중 "목록 표지 옆"(항목 텍스트 맨 앞, "- "/"- [ ] " 바로
// 뒤) 좌표를 담당한다 -- 나머지 세 곳(줄 끝·줄 중간·마커 옆)은
// storage-restore-round-trip.test.mjs 의 인라인 생성기 축이 담당한다
// (그 파일의 BACKSLASH_RUNS 축 주석 참고).
const BACKSLASH_POSITIONS = [
  {
    label: "줄끝",
    // 항목1 텍스트가 백슬래시로 끝난다 -- P1-1 원 재현과 정확히 같은 자리.
    item1Segments: (run) => [{ text: `항목1${run}`, bold: false }],
  },
  {
    label: "줄중간",
    item1Segments: (run) => [{ text: `항${run}목1`, bold: false }],
  },
  {
    label: "마커옆",
    // 굵게 서식 바로 뒤에 백슬래시가 붙는다.
    item1Segments: (run) => [
      { text: "굵게", bold: true },
      { text: `${run}뒤`, bold: false },
    ],
  },
  {
    label: "목록표지옆",
    // 항목 텍스트 맨 앞 -- 직렬화되면 목록 표지("- ") 바로 뒤에 온다.
    item1Segments: (run) => [{ text: `${run}항목1`, bold: false }],
  },
];

// 몇 개 연달아 있든 성립해야 한다(review.md §2) -- 1/2/3 개를 덮는다.
const BACKSLASH_COUNTS = [1, 2, 3];

const LIST_TYPES = ["bullet", "check"];

function buildShapes() {
  const shapes = [];
  for (const position of BACKSLASH_POSITIONS) {
    for (const count of BACKSLASH_COUNTS) {
      for (const listType of LIST_TYPES) {
        const run = "\\".repeat(count);
        shapes.push({
          label: `위치=${position.label}·백슬래시=${count}개·목록=${listType}`,
          listType,
          items: [
            { checked: true, segments: position.item1Segments(run) },
            { checked: false, segments: [{ text: "항목2", bold: false }] },
          ],
        });
      }
    }
  }
  return shapes;
}

// 4(위치) x 3(백슬래시 개수) x 2(목록 종류) = 24. 축을 놓치면 이 수가 준다.
const STRUCTURE_SHAPES = buildShapes();

test("구조 축 조합 수는 4(위치)x3(백슬래시 개수)x2(목록 종류)=24 로 고정된다", () => {
  assert.equal(STRUCTURE_SHAPES.length, 24);
});

for (const shape of STRUCTURE_SHAPES) {
  test(`저장->복원->재저장 전후로 구조(항목 수·노드 종류·체크 상태)가 그대로다: ${shape.label}`, () => {
    const typedEditor = buildTypedListEditor({
      listType: shape.listType,
      items: shape.items,
    });
    const before = listStructureSignature(typedEditor);
    assert.equal(before.items.length, 2, "typed 편집기는 항상 항목 2개다");

    const saved1 = serializeEditorToMarkdown(typedEditor);
    const { editor: restoredEditor } = makeProductEditor();
    restoreMarkdownIntoEditor(restoredEditor, saved1);
    const afterFirstRoundTrip = listStructureSignature(restoredEditor);
    assert.deepEqual(
      afterFirstRoundTrip,
      before,
      "저장->복원 뒤 구조가 원본과 같아야 한다(항목 수 포함)",
    );

    const saved2 = serializeEditorToMarkdown(restoredEditor);
    const { editor: reRestoredEditor } = makeProductEditor();
    restoreMarkdownIntoEditor(reRestoredEditor, saved2);
    const afterSecondRoundTrip = listStructureSignature(reRestoredEditor);
    assert.deepEqual(
      afterSecondRoundTrip,
      before,
      "재복원 뒤에도 구조가 원본과 같아야 한다(반복 재접속 안정성)",
    );
  });
}
