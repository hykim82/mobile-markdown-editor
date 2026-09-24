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
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $createLineBreakNode,
} from "lexical";
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

// serialize.mjs 의 escapeBackslashes 의 정확한 역(HYK-304-linebreak-2 ·
// review.md P1-1 수리). 원문 backslash 는 2개로 내보내지므로, "\n" 바로
// 앞의 연속 backslash 개수(run)의 «홀짝»만으로 유일하게 갈린다:
// - 홀수 run: 마지막 backslash 1개가 줄바꿈 escape 마커고, 그 앞
//   (run-1)개(항상 짝수)는 원문 backslash (run-1)/2 개가 escape 된 것.
// - 짝수 run(0 포함): "\n" 은 escape 가 아니다(splitBlockLines 가 이미
//   경계로 갈라내 여기까지 안 내려온다) -- run 개는 원문 backslash run/2
//   개가 escape 된 것이고, 그 뒤에 남는 "\n" 은 그대로 문자로 취급한다.
// "\n" 이 뒤따르지 않는 backslash run 은 전부 원문 backslash 가 escape 된
// 것이므로 항상 짝수이고, run/2 개로 되돌린다.
// ⭐legacy 토크나이저(HYK-304-linebreak-3 · REVIEW-r2.md §1-1): main
// (dac26cf, bodyFormat 마커가 생기기 전 배포본)의 tokenizeInline 을 그대로
// 재현한다 -- backslash 는 그 시절 그냥 평범한 글자였다(escape 규칙
// 자체가 없었다). "**"/"~~" 판정(computeMarkerRoles/findMarkerPositions)은
// 그 시절과 지금이 완전히 같다(이 축은 이번 라운드가 건드리지 않는다) --
// 그래서 이 함수는 아래 tokenizeInline 과 마커 처리 코드를 그대로
// 공유하고 backslash 분기만 없다. storage-mount.mjs 가 bodyFormat 마커
// 없는 레코드(= main 이 저장한 옛 메모)에서만 이 함수를 고른다.
function tokenizeInlineLegacy(text) {
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
    } else if (text[i] === "\\") {
      let j = i;
      while (text[j] === "\\") j += 1;
      const runLength = j - i;
      if (text[j] === "\n" && runLength % 2 === 1) {
        buffer += "\\".repeat((runLength - 1) / 2);
        flush();
        segments.push({ linebreak: true });
        i = j + 1;
      } else {
        buffer += "\\".repeat(Math.floor(runLength / 2));
        i = j;
      }
    } else {
      buffer += text[i];
      i += 1;
    }
  }
  flush();
  return segments;
}

function appendInline(parentNode, text, { legacy = false } = {}) {
  const segments = legacy ? tokenizeInlineLegacy(text) : tokenizeInline(text);
  for (const segment of segments) {
    if (segment.linebreak) {
      parentNode.append($createLineBreakNode());
      continue;
    }
    const textNode = $createTextNode(segment.text);
    if (segment.bold) textNode.toggleFormat("bold");
    if (segment.strikethrough) textNode.toggleFormat("strikethrough");
    parentNode.append(textNode);
  }
}

// block.split("\n") 은 backslash 로 escape 된 "\n"(같은 블록/항목 «안»
// 줄바꿈, HYK-304 E4)까지 전부 갈라 버린다 -- 그래서 "\n" 바로 앞에 연속된
// backslash 개수(run)의 «홀짝»을 센다(HYK-304-linebreak-2 · review.md
// P2-2 수리, serialize.mjs 의 escapeBackslashes 단사 규칙의 정확한 역):
// run 이 홀수면 마지막 backslash 1개가 줄바꿈 escape 마커라 이 "\n" 은
// 경계가 «아니다»(같은 항목 안 줄바꿈, tokenizeInline 이 되돌린다). run
// 이 짝수(0 포함)면 원문 backslash 들이 이미 쌍으로 escape 되어 있을 뿐
// "\n" 자신은 escape 가 아니므로, 목록 항목의 경계(또는 목록이 아니면 이
// 블록의 유일한 물리 줄 끝)로 본다. 앞 글자 1개만 보던 예전 판정은
// 원문에 원래 있던 backslash 가 "\n" 바로 앞에 오면(review.md P1-1) 홀짝을
// 못 갈라 항목 경계를 글자로 삼켰다.
// "\n\n"(문단 나누기)은 이미 restoreMarkdownIntoEditor 가 바깥에서 먼저
// 갈라냈으므로 여기 들어오는 block 문자열 안에는 절대 안 남는다.
function splitBlockLines(block) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== "\n") continue;
    let backslashRun = 0;
    let j = i - 1;
    while (j >= 0 && block[j] === "\\") {
      backslashRun += 1;
      j -= 1;
    }
    if (backslashRun % 2 === 0) {
      lines.push(block.slice(start, i));
      start = i + 1;
    }
  }
  lines.push(block.slice(start));
  return lines;
}

// 한 줄(line) 은 이미 splitBlockLines 가 항목/블록 경계로 확정한 것 --
// 그 안에 남은 "\\\n" 은 전부 그 항목/블록 "안" 줄바꿈이라 parse() 가
// 걷어낸 나머지 그대로(escape 포함) appendInline 에 넘기면 tokenizeInline
// 이 되돌린다.
function buildBlockNode(line, options) {
  const parsed = parse(line);
  if (parsed.type === "heading") {
    const node = $createHeadingNode(`h${parsed.level}`);
    appendInline(node, parsed.text, options);
    return node;
  }
  const node = $createParagraphNode();
  appendInline(node, parsed.text, options);
  return node;
}

function isListLine(line) {
  const type = parse(line).type;
  return type === "bullet" || type === "checkbox";
}

function buildListNode(lines, options) {
  const first = parse(lines[0]);
  const listType = first.type === "checkbox" ? "check" : "bullet";
  const list = $createListNode(listType);
  for (const line of lines) {
    const parsed = parse(line);
    const item =
      listType === "check"
        ? $createListItemNode(parsed.checked)
        : $createListItemNode();
    appendInline(item, parsed.text, options);
    list.append(item);
  }
  return list;
}

// options.legacy(HYK-304-linebreak-3 · REVIEW-r2.md §1-5 선택지 ⓐ):
// bodyFormat 마커 없는 레코드(= main/dac26cf 가 저장한 옛 메모, storage-
// mount.mjs 가 고른다)는 그 시절 물리 줄 나누기(`block.split("\n")`,
// backslash 홀짝을 안 보는 단순 분리)와 tokenizeInlineLegacy 로 읽는다 --
// splitBlockLines 의 홀짝 판정과 tokenizeInline 의 backslash-escape
// 해독은 이 라운드(HYK-304-linebreak-2) 가 도입한 규칙이라, 그 규칙이
// 없던 시절 body 에 걸면 "\n" 바로 앞의 평범한 backslash 를 줄바꿈
// escape 로 오해해 항목 경계를 삼킨다(REVIEW-r2.md §1-2 P1 그 자체).
export function restoreMarkdownIntoEditor(editor, body, options = {}) {
  const { legacy = false } = options;
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      if (body.length === 0) return;
      for (const block of body.split("\n\n")) {
        const lines = legacy ? block.split("\n") : splitBlockLines(block);
        if (lines.every(isListLine)) {
          root.append(buildListNode(lines, options));
        } else {
          for (const line of lines) {
            root.append(buildBlockNode(line, options));
          }
        }
      }
    },
    { discrete: true },
  );
}
