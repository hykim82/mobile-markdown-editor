// ⚠️정직 한계(이 조각이 실제 브라우저에서 타이핑해보다가 발견한 것 --
// coder-task.md §6 "정직 한계"): PRD §5.2 는 체크박스 트리거를 "`- [ ] `"
// 라고 적지만, 실제로 그 글자들을 한 자씩(-, 공백, [, 공백, ], 공백) 치면
// 라이브 렌더링은 체크박스가 아니라 «평범한 불릿 + 글자로 남은 "[ ] "»가
// 된다. 원인: @lexical/markdown 의 트리거 판정(runElementTransformers,
// MarkdownShortcuts.ts)은 "방금 입력한 문자가 공백"일 때마다 즉시
// 정규식을 검사한다. "- " 두 글자만 쳤을 때 이미 UNORDERED_LIST_REGEX
// (`/^(\s*)[-*+]\s/`)가 매치해 그 자리에서 바로 불릿으로 바뀌어 버리고,
// 그 다음에 "[ ] "를 더 쳐도 CHECK_LIST 는 다시 걸리지 않는다(엘리먼트
// 트랜스포머는 "부모의 부모가 root"일 때만 재검사하는데, 불릿으로 바뀐
// 순간 그 줄의 부모는 이미 목록 항목이 되어 있다). PRODUCT_TRANSFORMERS
// 안에서 CHECK_LIST 를 UNORDERED_LIST 보다 앞에 두어도(실제로 그렇게
// 되어 있다 -- src/editor/transformers.mjs) 이 순서는 바뀌지 않는다 --
// "- " 만 쳤을 때는 CHECK_LIST_REGEX 자체가 아직 매치할 텍스트가 없기
// 때문이다.
//
// 대신 대괄호를 먼저 치는("[ ] 할일", 앞의 "- " 없이) 경로는 실제로
// 체크박스로 잘 선다 -- CHECK_LIST_REGEX 의 "- " 프리픽스는 선택
// 그룹이라서다. 이 시험은 그 두 가지 실측 결과를 그대로 고정한다:
// (1) "- " 를 먼저 완성하면 불릿이 된다(체크박스 트리거가 막힘)
// (2) "[ ] " 를 (선행 대시 없이) 완성하면 체크박스가 된다
//
// 다음 라운드로 넘길 구체적 제안: 불릿으로 갓 바뀐, 아직 다른 형제가
// 없는 ListItemNode 의 텍스트가 "[ ]"/"[x]"로 시작하면 그 목록을
// 체크리스트로 재분류하는 별도 트랜스폼(예: registerNodeTransform)을
// 추가하면 PRD 문면 그대로의 "- [ ] " 순차 타이핑도 살릴 수 있다 --
// 이번 «화면 최소» 조각의 범위를 넘어서 여기 적어만 둔다.
//
// 추가 실측(브라우저 수동 확인, coder.md §5 참고): 이미 만들어진 목록
// 안에서 Enter 로 새 항목을 잇고 그 줄에 "[x] "를 쳐도 체크는 안 켜진다
// -- 새 항목은 부모가 root 가 아니라 이미 그 목록이므로(위와 같은 이유)
// 엘리먼트 트리거가 아예 재검사되지 않고, "[x] "는 그냥 글자로 남는다.
// 같은 근본 원인의 다른 얼굴이라 별도 시험을 추가하지 않았다.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../support/jsdom-env.mjs";
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
} from "lexical";
import { $isListNode, $isListItemNode } from "@lexical/list";
import {
  makeProductEditor,
  waitForNextUpdate,
} from "../support/make-editor.mjs";

// 진짜 타이핑처럼 한 글자씩 순차로 넣는다 -- runElementTransformers 는
// "방금 입력한 문자가 공백일 때만" 검사하므로(MarkdownShortcuts.ts),
// 여러 글자를 한 update 에 몰아넣으면(예: "[" -> "[ ] ") 실제 타이핑과
// 다른 결과가 나올 수 있다(중간 검사 기회를 건너뛰기 때문). 한 글자씩
// 순차 update 로 넣어야 실제 키 입력과 같은 판정 시점을 재현한다.
function typeCharByChar(editor, fullText) {
  let key;
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      const textNode = $createTextNode(fullText[0]);
      paragraph.append(textNode);
      $getRoot().append(paragraph);
      textNode.select(1, 1);
      key = textNode.getKey();
    },
    { discrete: true },
  );
  for (let length = 2; length <= fullText.length; length += 1) {
    editor.update(
      () => {
        const textNode = $getNodeByKey(key);
        textNode.setTextContent(fullText.slice(0, length));
        textNode.select(length, length);
      },
      { discrete: true },
    );
  }
}

test('한계 (1): "- " 를 먼저 완성하면 불릿이 된다 -- 이후 "[ ] "를 쳐도 체크박스로 못 감', async () => {
  const { editor } = makeProductEditor();
  typeCharByChar(editor, "- ");
  await waitForNextUpdate(editor);
  const listType = editor.getEditorState().read(() => {
    const first = $getRoot().getFirstChild();
    return $isListNode(first) ? first.getListType() : null;
  });
  assert.equal(
    listType,
    "bullet",
    '"- " 완성 시점에는 항상 불릿이다(체크박스 정규식이 아직 매치할 게 없음)',
  );
});

test('한계 (2)의 반증: 대시 없이 "[ ] " 를 먼저 완성하면 체크박스로 선다', async () => {
  const { editor } = makeProductEditor();
  typeCharByChar(editor, "[ ] ");
  await waitForNextUpdate(editor);
  const [listType, checked] = editor.getEditorState().read(() => {
    const first = $getRoot().getFirstChild();
    if (!$isListNode(first)) {
      return [null, undefined];
    }
    const item = first.getFirstChild();
    return [
      first.getListType(),
      $isListItemNode(item) ? item.getChecked() : undefined,
    ];
  });
  assert.equal(listType, "check");
  assert.equal(checked, false);
});
