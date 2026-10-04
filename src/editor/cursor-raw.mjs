// 커서 진입 시 원문 복원(PRD §5.1⑤ · §5.2③ · §8, HYK-304-cursor-raw-restore-1).
//
// 렌더링된 서식 줄(제목·목록·체크박스·굵게·취소선)에 커서가 다른 줄에서 «들어오면»
// 그 줄을 마크다운 원문으로 펼쳐 편집하게 하고, 커서가 나가면 다시 서식으로 접는다.
// 원문 조립은 serialize.mjs 가, 접기는 restore.mjs 가 맡는다 -- 라이브러리
// 직렬화는 쓰지 않는다(serialize.mjs 머리 주석의 정본 원칙).
//
// 설계 요약:
// - 펼친 줄은 최상위 블록 하나를 평문 단락 하나로 바꾼 것이고, 그 키를
//   raw-registry 에 적어 둔다. serialize 는 그 단락만 원문 그대로 내므로
//   저장 원문은 펼치기 전후 바이트가 같다(§5.1 구조 줄 · 저장 진실 불변).
// - «진입»만 펼친다. 타이핑으로 트리거가 완성되면 단락이 헤딩 등으로 교체되어
//   이전 블록이 사라지므로 진입으로 보지 않는다 -- 그래야 방금 만든 서식이
//   커서가 있는 동안 바로 원문으로 되돌아가지 않는다(IME 시험이 이 경로를 잰다).
// - 펼치기·접기는 CURSOR_RAW_TAG 로 표시하고(저장 리스너가 이 갱신을 건너뛴다),
//   HISTORIC_TAG 도 함께 단다. 마크다운 단축키 리스너는 이 태그가 붙은 갱신을
//   건너뛴다 -- 없으면 펼친 "# " 이 단축키에 걸려 다시 헤딩이 되고, 그 헤딩을
//   또 펼치는 무한 갱신이 된다(ime-composition 시험이 실제로 그 무한 갱신을 냈다).
// - 한글 조합(IME) 중에는 판정하지 않는다(PRD §8 "한글 조합 깨짐").
// - 펼친 줄 안에서 사용자가 트리거를 완성하면(예: "- " 입력) 그 줄은 서식으로
//   바뀌고 커서가 계속 있는 한 서식으로 남는다(다시 나갔다 들어오면 원문으로 펼친다).
import {
  $addUpdateTag,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  HISTORIC_TAG,
} from "lexical";
import { $isHeadingNode } from "@lexical/rich-text";
import { $isListNode } from "@lexical/list";
import {
  $serializeBlockToMarkdown,
  $serializeRawLineToMarkdown,
} from "./serialize.mjs";
import { $blockToNodes } from "./restore.mjs";
import { rawKeysOf } from "./raw-registry.mjs";

export const CURSOR_RAW_TAG = "cursor-raw";

// 저장 형식에서 역슬래시 한 글자는 두 글자로 나온다(serialize.mjs
// escapeBackslashes) -- 원문으로 펼칠 때 한 글자로 되돌린다.
function unescapeBackslashes(text) {
  return text.replace(/\\\\/g, "\\");
}

function $hasInlineFormat(node) {
  if ($isTextNode(node)) {
    return node.hasFormat("bold") || node.hasFormat("strikethrough");
  }
  if ($isElementNode(node)) {
    return node.getChildren().some($hasInlineFormat);
  }
  return false;
}

function $hasLineBreak(node) {
  if ($isLineBreakNode(node)) return true;
  if ($isElementNode(node)) {
    return node.getChildren().some($hasLineBreak);
  }
  return false;
}

// "원문과 화면이 달라 보이는" 블록만 펼친다 -- 평문 단락은 펼칠 것이 없다.
function $canShowRaw(block) {
  if (!$isElementNode(block) || $hasLineBreak(block)) return false;
  return $isHeadingNode(block) || $isListNode(block) || $hasInlineFormat(block);
}

// 커서가 있는 최상위 블록의 키(없으면 null).
function $activeTopKey() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const top = selection.anchor.getNode().getTopLevelElement();
  return top ? top.getKey() : null;
}

// 읽기 전용 계획 -- 펼칠 블록(진입한 경우만)과 접을 펼친 줄들.
// prevActiveKey 는 직전 상태에서 커서가 있던 블록이다. 그 블록이 지금은 사라졌다면
// (타이핑으로 서식이 된 것) 이 이동은 진입이 아니므로 펼치지 않는다.
function $planSync(editor, prevActiveKey) {
  const registry = rawKeysOf(editor);
  const activeKey = $activeTopKey();
  const restore = [...registry].filter((key) => key !== activeKey);
  const leftReplacedBlock =
    prevActiveKey !== null && $getNodeByKey(prevActiveKey) === null;
  const entered =
    activeKey !== null && activeKey !== prevActiveKey && !leftReplacedBlock;
  const activeNode = activeKey !== null ? $getNodeByKey(activeKey) : null;
  const rawify =
    entered &&
    !registry.has(activeKey) &&
    activeNode !== null &&
    $canShowRaw(activeNode)
      ? activeKey
      : null;
  return { restore, rawify };
}

function $rawifyBlock(editor, block) {
  const lines = $serializeBlockToMarkdown(block).split("\n");
  const paragraph = $createParagraphNode();
  lines.forEach((line, index) => {
    if (index > 0) paragraph.append($createLineBreakNode());
    const text = unescapeBackslashes(line);
    if (text.length > 0) paragraph.append($createTextNode(text));
  });
  block.replace(paragraph);
  rawKeysOf(editor).add(paragraph.getKey());
  paragraph.selectEnd();
}

function $unrawLine(editor, node) {
  const nodes = $blockToNodes($serializeRawLineToMarkdown(node));
  for (const created of nodes) {
    node.insertBefore(created);
  }
  node.remove();
  rawKeysOf(editor).delete(node.getKey());
}

function $applySync(editor, rawify) {
  $addUpdateTag(HISTORIC_TAG);
  const registry = rawKeysOf(editor);
  const activeKey = $activeTopKey();
  for (const key of [...registry]) {
    if (key === activeKey) continue;
    const node = $getNodeByKey(key);
    if (node) {
      $unrawLine(editor, node);
    } else {
      registry.delete(key);
    }
  }
  if (rawify !== null && rawify === activeKey) {
    const block = $getNodeByKey(rawify);
    if (block && $canShowRaw(block)) $rawifyBlock(editor, block);
  }
}

export function registerCursorRaw(editor) {
  return editor.registerUpdateListener(
    ({ tags, editorState, prevEditorState }) => {
      if (tags.has(CURSOR_RAW_TAG)) return;
      if (editor.isComposing()) return;
      const prevActiveKey = prevEditorState.read($activeTopKey);
      const { restore, rawify } = editorState.read(() =>
        $planSync(editor, prevActiveKey),
      );
      if (restore.length === 0 && rawify === null) return;
      editor.update(() => $applySync(editor, rawify), {
        tag: CURSOR_RAW_TAG,
      });
    },
  );
}
