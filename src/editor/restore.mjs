// serialize.mjs 의 역함수 -- 저장된 §7 본문(마크다운 원문)을 에디터에
// 다시 채운다("치고 -> 닫고 -> 다시 열면 그대로", coder-task.md §0-2-⑸).
//
// ⛔같은 원칙, 반대 방향(serialize.mjs 머리 주석 참고 ·
// test/editor/no-library-serialize-in-src.test.mjs 가 src/ 전체를 훑어
// 기계로 지킨다): 저장에서 라이브러리 직렬화를 안 쓰듯, 복원에서도
// $convertFromMarkdownString 을 안 쓴다 -- 그 시험은 이름이 코드에
// "실행"되어 나타나기만 해도 걸리므로(줄 주석은 제외) 여기서 써도
// 그대로 걸린다. 대신 이 파일이 serialize.mjs 의 역함수를 직접 짠다.
// ⛔정정(review.md §3-3 · HYK-304-storage-2): 예전 이 자리의 주석은
// "serialize.mjs 가 실제로 만들 수 있는 형태(제대로 짝 맞은 "**"/"~~")만
// 가정한다 -- 임의의 외부 마크다운 붙여넣기 복원은 범위 밖" 이라고 적혀
// 있었다. 그 가정은 틀렸다: 붙여넣기 없이 "그냥 타이핑"만으로도
// serialize.mjs 는 짝 없는 "**"/"~~" 를 그대로 원문에 내보낸다(등록
// 순서가 안 맞는 마크다운 단축키 입력, 지우다 만 서식 등) -- 이 결함은
// "범위 밖"이 아니라 "범위 안"이었다. 그래서 tokenizeInline 은 짝 없는
// 마커(같은 마커가 홀수 번 나오는 경우의 마지막 등장)를 서식 토글이
// 아니라 글자 그대로 보존한다(아래 tokenizeInline 주석 참고). 짝이 맞는
// 인라인 마크는 여전히 serialize.mjs 와 같은 중첩 규칙("**" 바깥·"~~"
// 안쪽)을 가정한다.
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { $createHeadingNode } from "@lexical/rich-text";
import { $createListNode, $createListItemNode } from "@lexical/list";
import { parse } from "../markdown-parser.mjs";

// text 안에서 marker(2글자)가 서로 겹치지 않게 몇 번 나오는지 센다 --
// 아래 tokenizeInline 이 "이 마커가 짝이 있는가"를 미리 알기 위한 헬퍼.
function countMarkerOccurrences(text, marker) {
  let count = 0;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(marker, i)) {
      count += 1;
      i += marker.length;
    } else {
      i += 1;
    }
  }
  return count;
}

// serialize.mjs 는 "**"/"~~" 를 항상 짝 맞춰(열고-닫고) 내보내지만, 저장된
// 원문은 타이핑만으로도(붙여넣기 없이) 짝이 없는 "**"/"~~" 를 담을 수
// 있다(review.md §3-3 실측). 짝이 없는 마커까지 서식 토글로 삼키면 ⓐ 남은
// 구간이 통째로 서식이 되며 재직렬화 때 닫는 마커가 새로 생기거나
// ⓑ 마커 뒤 버퍼가 비어 있으면 그 마커 글자 자체가 흔적 없이 사라진다
// (review.md §3-2). 그래서 같은 마커의 등장 순서를 세어(1번째-2번째가
// 한 쌍, 3번째-4번째가 한 쌍, ...) 마지막 하나가 짝이 없을 때만(등장
// 횟수가 홀수) 그 마지막 등장을 토글이 아니라 "글자 그대로" 버퍼에 넣는다.
function tokenizeInline(text) {
  const totalBold = countMarkerOccurrences(text, "**");
  const totalStrike = countMarkerOccurrences(text, "~~");
  const segments = [];
  let bold = false;
  let strikethrough = false;
  let buffer = "";
  let boldSeen = 0;
  let strikeSeen = 0;
  const flush = () => {
    if (buffer.length > 0) {
      segments.push({ text: buffer, bold, strikethrough });
    }
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      boldSeen += 1;
      const isUnpaired = boldSeen === totalBold && totalBold % 2 === 1;
      if (isUnpaired) {
        buffer += "**";
      } else {
        flush();
        bold = !bold;
      }
      i += 2;
    } else if (text.startsWith("~~", i)) {
      strikeSeen += 1;
      const isUnpaired = strikeSeen === totalStrike && totalStrike % 2 === 1;
      if (isUnpaired) {
        buffer += "~~";
      } else {
        flush();
        strikethrough = !strikethrough;
      }
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
