// serialize.mjs 의 역함수 -- 저장된 §7 본문(마크다운 원문)을 에디터에
// 다시 채운다("치고 -> 닫고 -> 다시 열면 그대로", coder-task.md §0-2-⑸).
//
// ⛔같은 원칙, 반대 방향(serialize.mjs 머리 주석 참고 ·
// test/editor/no-library-serialize-in-src.test.mjs 가 src/ 전체를 훑어
// 기계로 지킨다): 저장에서 라이브러리 직렬화를 안 쓰듯, 복원에서도
// $convertFromMarkdownString 을 안 쓴다 -- 그 시험은 이름이 코드에
// "실행"되어 나타나기만 해도 걸리므로(줄 주석은 제외) 여기서 써도
// 그대로 걸린다. 대신 이 파일이 serialize.mjs 의 역함수를 직접 짠다.
// 이 파일이 되돌리는 인라인 마크(굵게/취소선) 문법은 serialize.mjs 가
// 실제로 만들 수 있는 형태(제대로 짝 맞고 "**" 바깥·"~~" 안쪽으로
// 중첩됨)만 가정한다 -- 임의의 외부 마크다운 붙여넣기 복원은 범위 밖.
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { $createHeadingNode } from "@lexical/rich-text";
import { $createListNode, $createListItemNode } from "@lexical/list";
import { parse } from "../markdown-parser.mjs";

function tokenizeInline(text) {
  const segments = [];
  let bold = false;
  let strikethrough = false;
  let buffer = "";
  const flush = () => {
    if (buffer.length > 0) {
      segments.push({ text: buffer, bold, strikethrough });
    }
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      flush();
      bold = !bold;
      i += 2;
    } else if (text.startsWith("~~", i)) {
      flush();
      strikethrough = !strikethrough;
      i += 2;
    } else {
      buffer += text[i];
      i += 1;
    }
  }
  flush();
  return segments;
}

function appendInline(parentNode, text) {
  for (const segment of tokenizeInline(text)) {
    const textNode = $createTextNode(segment.text);
    if (segment.bold) textNode.toggleFormat("bold");
    if (segment.strikethrough) textNode.toggleFormat("strikethrough");
    parentNode.append(textNode);
  }
}

function buildBlockNode(line) {
  const parsed = parse(line);
  if (parsed.type === "heading") {
    const node = $createHeadingNode(`h${parsed.level}`);
    appendInline(node, parsed.text);
    return node;
  }
  const node = $createParagraphNode();
  appendInline(node, parsed.text);
  return node;
}

function isListLine(line) {
  const type = parse(line).type;
  return type === "bullet" || type === "checkbox";
}

function buildListNode(lines) {
  const first = parse(lines[0]);
  const listType = first.type === "checkbox" ? "check" : "bullet";
  const list = $createListNode(listType);
  for (const line of lines) {
    const parsed = parse(line);
    const item =
      listType === "check"
        ? $createListItemNode(parsed.checked)
        : $createListItemNode();
    appendInline(item, parsed.text);
    list.append(item);
  }
  return list;
}

export function restoreMarkdownIntoEditor(editor, body) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      if (body.length === 0) return;
      for (const block of body.split("\n\n")) {
        const lines = block.split("\n");
        if (lines.every(isListLine)) {
          root.append(buildListNode(lines));
        } else {
          for (const line of lines) {
            root.append(buildBlockNode(line));
          }
        }
      }
    },
    { discrete: true },
  );
}
