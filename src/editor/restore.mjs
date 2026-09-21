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
// "범위 밖"이 아니라 "범위 안"이었다.
// ⛔재정정(review.md §4 · HYK-304-storage-3): 위 수리(등장 횟수의
// 홀짝만 보는 판정)는 "짝이 없는" 축만 닫았고 "짝은 있지만 그 사이가
// 비어 있는"(공백만인 경우 포함) 축을 놓쳤다 -- "****"(짝은 맞다: 등장
// 2회)는 홀짝 판정으로는 통과해 버려 둘 다 토글로 처리되고, 그 사이
// 버퍼가 비어 flush()가 아무것도 안 남겨 네 글자가 흔적 없이 사라졌다.
// 그래서 tokenizeInline 은 이제 "등장 횟수의 홀짝"이 아니라 "이 마커의
// 다음 같은 마커를 실제로 찾아보고, 그 사이가 비어 있으면(공백만 포함)
// 그 여는/닫는 마커 둘 다 서식 토글이 아니라 글자 그대로 보존한다"는
// 한 규칙으로 판정한다(computeMarkerRoles) -- 홀수 번째 마지막 등장(짝
// 자체가 없음)과 "짝은 있지만 속이 빈" 경우가 같은 한 규칙으로 걸린다.
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { $createHeadingNode } from "@lexical/rich-text";
import { $createListNode, $createListItemNode } from "@lexical/list";
import { parse } from "../markdown-parser.mjs";

// text 안에서 marker(2글자)가 서로 겹치지 않게 나오는 시작 위치를 순서대로
// 모은다 -- computeMarkerRoles 가 "이 등장의 다음 같은 마커가 어디인가"를
// 보려면 위치 목록이 먼저 있어야 한다.
function findMarkerPositions(text, marker) {
  const positions = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(marker, i)) {
      positions.push(i);
      i += marker.length;
    } else {
      i += 1;
    }
  }
  return positions;
}

// ★한 규칙(coder-task.md §1-⑴): 이 마커 등장이 서식을 "여는지"("open")
// "닫는지"("close") 아니면 "글자 그대로"("literal")인지를, 등장 순서대로
// 하나씩 정한다. 지금 열려 있는 짝이 없으면 -- 이 등장이 마지막이거나
// (짝 자체가 없음), 다음 같은 마커까지의 사이가 비어 있으면(trim 결과
// 빈 문자열 -- 공백만인 경우 포함) -- literal 이다. 그 두 조건 다
// 아니면 open 으로 짝을 걸고, 다음에 만나는 같은 마커(짝 없는 마커가
// 그 사이에 없으므로 반드시 그 마커다)가 close 다.
function computeMarkerRoles(text, marker) {
  const positions = findMarkerPositions(text, marker);
  const roles = new Array(positions.length).fill("literal");
  let open = false;
  for (let idx = 0; idx < positions.length; idx += 1) {
    if (open) {
      roles[idx] = "close";
      open = false;
      continue;
    }
    const isLast = idx === positions.length - 1;
    if (isLast) {
      roles[idx] = "literal";
      continue;
    }
    const between = text.slice(
      positions[idx] + marker.length,
      positions[idx + 1],
    );
    if (between.trim() === "") {
      roles[idx] = "literal";
    } else {
      roles[idx] = "open";
      open = true;
    }
  }
  return roles;
}

function tokenizeInline(text) {
  const boldRoles = computeMarkerRoles(text, "**");
  const strikeRoles = computeMarkerRoles(text, "~~");
  const segments = [];
  let bold = false;
  let strikethrough = false;
  let buffer = "";
  let boldIdx = 0;
  let strikeIdx = 0;
  const flush = () => {
    if (buffer.length > 0) {
      segments.push({ text: buffer, bold, strikethrough });
    }
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const role = boldRoles[boldIdx];
      boldIdx += 1;
      if (role === "literal") {
        buffer += "**";
      } else {
        flush();
        bold = role === "open";
      }
      i += 2;
    } else if (text.startsWith("~~", i)) {
      const role = strikeRoles[strikeIdx];
      strikeIdx += 1;
      if (role === "literal") {
        buffer += "~~";
      } else {
        flush();
        strikethrough = role === "open";
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
