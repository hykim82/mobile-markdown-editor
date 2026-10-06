// HYK-304 checkbox-in-list (.harness/coder-task.md §1-2): 점 목록(`- `)을 먼저
// 만든 뒤 그 줄에 `[ ] ` 를 치면 체크박스로 바꾼다(PRD §5.2 트리거).
//
// 왜 마크다운 단축키(CHECK_LIST)로는 안 되는가: "- " 가 먼저 불릿을 만들면
// 그 뒤의 "[ ] " 는 엘리먼트 트리거가 다시 검사하지 않는다(부모가 이미 목록
// 항목이라 root 직속이 아님 -- checklist-live-typing-gap.test.mjs 참고).
//
// 왜 TextNode 트랜스폼인가: 항목 안 글자가 바뀌면 Lexical 은 글자 노드만
// 더러워지고 항목(ListItemNode) 자체는 다시 트랜스폼되지 않는다(처음 한 글자
// 만 항목을 더럽힌다 -- 실측). 그래서 글자 노드를 보고, 그 글자 노드가 목록
// 항목의 첫 글자일 때만 판정한다.
//
// 떼어내기: 앞 항목은 불릿 목록에 그대로 두고, 이 항목만 새 체크 목록에,
// 뒤 항목은 새 불릿 목록에 옮긴다 -- 한 목록은 한 종류라서 쪼개야 한다.
import { $getSelection, $isRangeSelection, TextNode } from "lexical";
import { $createListNode, $isListItemNode, $isListNode } from "@lexical/list";
import { softJoinKeysOf } from "./raw-registry.mjs";

// PRD §5.2 문면: "[ ] " / "[x] " (뒤 공백 필수). 체크박스 모양이 아닌 "[y] "
// 는 일치하지 않아 불릿으로 남는다(경계 2).
// ⭐대소문자 구분(HYK-304-checkbox-in-list-2 · 1R 검토 P1-1): "[X] " 는 이 판정
// 밖이다. 복원기(markdown-parser.mjs CHECKBOX_RE)와 저장기(serialize.mjs)가
// 모두 소문자 "[x]" 만 체크로 알아보므로, 여기서 대문자를 체크로 바꾸면 저장
// 원문 "- [X] 할일" 이 복원 중 "- [x] 할일" 로 바뀌어 왕복이 깨진다.
const CHECK_PREFIX = /^\[( |x)\] /;

// 커서(캐럿)가 이 글자 노드 안에 있는지 -- 사람이 방금 이 자리에서 친 글자인지 가린다.
function $isCaretInside(textNode) {
  const selection = $getSelection();
  return (
    $isRangeSelection(selection) && selection.anchor.key === textNode.getKey()
  );
}

// 떼어 낸 접두어만큼 커서를 당긴다 -- 글자 위치는 그대로 두고 앞쪽 기호만 뺀다.
function $shiftSelectionAfterStrip(textNode, removedLength) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const key = textNode.getKey();
  for (const point of [selection.anchor, selection.focus]) {
    if (point.key === key) {
      point.set(key, Math.max(0, point.offset - removedLength), "text");
    }
  }
}

// 항목 하나를 체크 목록으로 떼어 낸다. 앞 항목은 원래 불릿 목록에 남고,
// 뒤 항목은 새 불릿 목록으로 옮긴다. 쪼갠 목록은 저장 때 앞 목록과 줄바꿈
// 하나로 이어 붙어야 원문이 한 목록으로 남는다(restore 가 목록 묶음에 쓰는
// softJoin 과 같은 규칙 -- 빈 줄로 떼면 저장 원문이 느슨한 목록으로 바뀐다).
function $splitItemIntoCheckList(editor, item, list, checked) {
  const softJoin = softJoinKeysOf(editor);
  const following = item.getNextSiblings();
  // ⭐소속 상속(HYK-304-checkbox-in-list-2 · 1R 검토 P3-2 · P3-4): 원래 목록이
  // 앞 묶음에 이어 붙는 묶음이었다면, 그 목록이 빈 채로 사라질 때 체크 목록이
  // 그 자리를 물려받아야 저장 때 줄바꿈 하나로 이어진다. 목록이 남으면 체크
  // 목록은 새 묶음이라 이어 붙는다. 사라진 목록의 키는 집합에서 지운다.
  const wasJoined = softJoin.has(list.getKey());
  const checkList = $createListNode("check");
  list.insertAfter(checkList);
  checkList.append(item);
  item.setChecked(checked);
  if (list.getChildrenSize() > 0 || wasJoined) softJoin.add(checkList.getKey());

  if (following.length > 0) {
    const tail = $createListNode("bullet");
    tail.append(...following);
    checkList.insertAfter(tail);
    softJoin.add(tail.getKey());
  }

  if (list.getChildrenSize() === 0) {
    list.remove();
    softJoin.delete(list.getKey());
  }
}

export function registerChecklistPromotion(editor) {
  return editor.registerNodeTransform(TextNode, (textNode) => {
    // 한글 조합 중에는 판정하지 않는다(PRD §5.3 ②) -- 조합이 끝나면 같은
    // 글자가 다시 더러워지므로 그때 판정된다.
    if (editor.isComposing()) return;

    // ⭐꾸민 글자 노드(굵게·취소선) 머리는 「커서가 그 글자 안에 있을 때」만 판정한다
    // (HYK-304-checkbox-decorated-head-1). 복원(restore)·접기(cursor-raw)도 같은
    // 트랜스폼을 탄다 -- 저장 원문 "- **[ ] b**" 는 복원 때 굵은 "[ ] b" 노드라서
    // 서식만 보고 승격하면 마커가 바깥에서 안쪽으로 옮겨져(1R P1-1) 원문이 깨진다.
    // 커서가 글자 안에 있다는 것은 사람이 그 자리에서 쳤다는 뜻이다(복원·접기가
    // 커서를 그 글자에 두지 않는다는 것은 checklist-decorated-head 의 B 교차 시험이
    // 시작·끝 두 자리에서 고정한다). 서식 없는 글자의 판정은 그대로 둔다.
    if (textNode.getFormat() !== 0 && !$isCaretInside(textNode)) return;

    const item = textNode.getParent();
    if (!$isListItemNode(item) || item.getFirstChild() !== textNode) return;

    const list = item.getParent();
    if (!$isListNode(list) || list.getListType() !== "bullet") return;

    const text = textNode.getTextContent();
    const match = CHECK_PREFIX.exec(text);
    if (!match) return;

    textNode.setTextContent(text.slice(match[0].length));
    $shiftSelectionAfterStrip(textNode, match[0].length);
    $splitItemIntoCheckList(editor, item, list, match[1].toLowerCase() === "x");
  });
}
