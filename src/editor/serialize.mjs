// ⛔정본 원칙 (coder-task.md §0-1): 원문(마크다운) 문자열은 제품이 직접
// 재구성한다. @lexical/markdown 의 $convertToMarkdownString 은 알려진
// 손실 버그가 있어(POC 실측: 짝 없는 "~" 가 "\~" 로 이스케이프됨) 저장·복사
// 경로에서 부르지 않는다 -- 이 파일은 그 함수를 import 하지 않는다
// (test/editor/no-library-serialize-in-src.test.mjs 가 이를 기계로 지킨다).
//
// ⚠️알려진 한계: @lexical/markdown 소스(MarkdownTransformers.ts)에는
// 목록의 원본 마커 문자('-'/'*'/'+')를 기록하는 `listMarkerState`가
// `export const`로 있고 .d.ts 에도 선언돼 있지만, 0.51.0 로 설치되는 실제
// 배포 번들(dist/LexicalMarkdown.dev.js 등)의 최종 export 목록에는 없다
// (실측: import 시도 시 "does not provide an export named 'listMarkerState'").
// 즉 타입 선언과 런타임 배포가 어긋난 상태라 공개 API로 마커 문자를 읽을
// 방법이 없다 -- 그래서 이 조각은 PRD §5.2 가 정의하는 유일한 목록
// 트리거 문자인 "-" 를 항상 쓴다("*"/"+" 로 시작한 원문을 불러오면 "-" 로
// 정규화되어 그 한 글자만은 원문과 달라진다; 아래 round-trip 시험의
// KNOWN_LIMITATIONS 에 이 경우 하나가 문서화돼 있다).
import {
  $getRoot,
  $isTextNode,
  $isElementNode,
  $isLineBreakNode,
} from "lexical";
import { $isHeadingNode } from "@lexical/rich-text";
import { $isListNode, $isListItemNode } from "@lexical/list";

const LIST_MARKER = "-";

// 굵게가 바깥, 취소선이 안쪽 -- "**굵고 ~~취소도~~ 같이**" 같은 중첩 표기의
// 확정된 표시 순서(coder-task.md 관찰 21번 입력). 순서를 바꾸면 이 하나의
// 중첩 케이스만 뒤집힌 마커로 재조립된다.
const INLINE_MARKS = [
  { name: "bold", marker: "**" },
  { name: "strikethrough", marker: "~~" },
];

// ⭐단사(injective) 규칙(HYK-304-linebreak-2 · review.md P1-1 수리): 줄바꿈을
// "\"+줄바꿈으로 내보내면서 원문에 "원래 있던" backslash 는 그대로 두면,
// 그 backslash 가 escape 마커의 절반과 같은 바이트가 되어 서로 다른 두
// 문서가 같은 바이트로 저장된다(review.md 표 참고). 규칙: escape 문자로
// 쓰는 글자(backslash) 는 "그 자신도" escape 한다 -- 원문의 backslash
// 1개를 2개로 내보낸다. 그러면 저장된 문자열에서 "\n" 바로 앞의 연속
// backslash 개수는 항상 "홀수 = 줄바꿈 escape 마커(마지막 한 개) + 그
// 앞의 원문 backslash 쌍들" 아니면 "짝수 = 원문 backslash 쌍들만, \n 은
// escape 가 아니다"로만 나뉘어 유일하게 복원된다(restore.mjs 의 역함수
// 참고 -- splitBlockLines/tokenizeInline 이 이 홀짝을 그대로 센다).
function escapeBackslashes(text) {
  return text.replace(/\\/g, "\\\\");
}

// ⭐legacy 옵션(HYK-304-linebreak-3 · REVIEW-r2.md §1-1 "이 수정 전
// 배포본 -- main = dac26cf"): main 에는 escapeBackslashes 도
// LineBreakNode 처리도 없었다(0건, 기계로 확인됨) -- backslash 는 그냥
// 평범한 글자였고 Shift+Enter 로 만든 LineBreakNode 는 조용히
// 사라졌다(아무 것도 안 내보냄, E4 버그 그 자체). 그래서 legacy=true 는
// 그 시절 collectInlineSegments 를 «글자 그대로» 재현한다(escape 0,
// LineBreakNode 스킵) -- storage-mount.mjs 가 bodyFormat 마커 없는
// 레코드(= main 이 저장한 옛 메모)에 이 옵션을 건다. legacy=false(기본)는
// 지금까지의 새 규칙(단사 escape + 줄바꿈 마커) 그대로다.
function collectInlineSegments(elementNode, { legacy = false } = {}) {
  const segments = [];
  for (const child of elementNode.getChildren()) {
    if ($isTextNode(child)) {
      segments.push({
        text: legacy
          ? child.getTextContent()
          : escapeBackslashes(child.getTextContent()),
        bold: child.hasFormat("bold"),
        strikethrough: child.hasFormat("strikethrough"),
      });
    } else if ($isLineBreakNode(child)) {
      if (legacy) continue; // main 이 실제로 하던 그대로: 조용히 버린다.
      // Shift+Enter 로 만든 "같은 문단 안 줄바꿈"(HYK-304 E4). 이 노드는
      // TextNode 도 ElementNode 도 아니라서 위 두 분기 어디에도 안 걸리고
      // 조용히 사라졌었다 -- backslash + 줄바꿈 한 글자로 내보낸다(표준
      // 마크다운의 "하드 줄바꿈" 표기와 같은 모양). 줄바꿈 문자 «하나»만
      // 썼다면 "\n\n"(문단 나누기, $serializeRootToMarkdown 의 블록
      // 구분자)과 연속 두 번의 Shift+Enter 에서 정확히 충돌한다 --
      // backslash 를 앞세우면 몇 번을 연달아 내보내도("\\\n\\\n"…) 그
      // 사이에 "\n\n"(줄바꿈 두 개가 나란히)가 생기지 않는다. 이 마커
      // 자신은 escape 하지 않는다(escapeBackslashes 는 원문 글자에만
      // 적용된다) -- 위 단사 규칙 문단 참고.
      segments.push({ text: "\\\n", bold: false, strikethrough: false });
    } else if ($isElementNode(child)) {
      // 이 조각의 트리거 집합은 인라인 서식(굵게/취소선)만 만든다 -- 다른
      // 인라인 엘리먼트 노드는 나오지 않을 것이나, 나오면 텍스트만 취해
      // 조용히 삼키지 않고 최소한 글자는 보존한다.
      segments.push({
        text: legacy
          ? child.getTextContent()
          : escapeBackslashes(child.getTextContent()),
        bold: false,
        strikethrough: false,
      });
    }
  }
  return segments;
}

// 세그먼트를 markIndex 번째 마크 기준으로 연속 구간 묶어 재귀적으로
// 감싼다. 겹치는 두 마크(굵게+취소선)가 있어도 중첩 순서가 항상
// INLINE_MARKS 순서(굵게 바깥)로 고정되므로 결과가 결정적이다.
function wrapByMarks(segments, markIndex) {
  if (markIndex >= INLINE_MARKS.length) {
    return segments.map((segment) => segment.text).join("");
  }
  const { name, marker } = INLINE_MARKS[markIndex];
  const groups = [];
  for (const segment of segments) {
    const value = Boolean(segment[name]);
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.value === value) {
      lastGroup.segments.push(segment);
    } else {
      groups.push({ value, segments: [segment] });
    }
  }
  return groups
    .map((group) => {
      const inner = wrapByMarks(group.segments, markIndex + 1);
      return group.value ? `${marker}${inner}${marker}` : inner;
    })
    .join("");
}

function serializeInline(elementNode, options) {
  return wrapByMarks(collectInlineSegments(elementNode, options), 0);
}

function serializeListItem(item, listType, marker, options) {
  const body = serializeInline(item, options);
  if (listType === "check") {
    return `${marker} [${item.getChecked() ? "x" : " "}] ${body}`;
  }
  return `${marker} ${body}`;
}

// 중첩 목록(목록 항목 안에 또 목록)은 이 조각 범위 밖이다 -- PRD §5.2
// 트리거 규칙에 들여쓰기/중첩 목록이 정의돼 있지 않고, 대표 입력 21개에도
// 없다. 만나면 항목의 겉텍스트만 직렬화해 최소한 글자를 잃지는 않는다.
function serializeBlock(node, options) {
  if ($isHeadingNode(node)) {
    const level = Number(node.getTag().slice(1));
    return `${"#".repeat(level)} ${serializeInline(node, options)}`;
  }
  if ($isListNode(node)) {
    const listType = node.getListType();
    return node
      .getChildren()
      .filter($isListItemNode)
      .map((item) => serializeListItem(item, listType, LIST_MARKER, options))
      .join("\n");
  }
  return serializeInline(node, options);
}

// 블록 사이는 "\n\n" -- 대표 입력의 "# 하나\n\n## 둘\n\n### 셋"처럼 서로
// 다른 최상위 블록은 빈 줄로 구분된 원문에서 왔다. 같은 목록 안의 항목은
// serializeBlock 내부에서 "\n" 하나로 이미 묶인다(위 참조).
//
// options.legacy(HYK-304-linebreak-3): storage-mount.mjs 가 bodyFormat
// 마커 없는(= main/dac26cf 가 저장한 옛) 레코드를 다시 이 규칙으로
// 내보내 안전판(§1-⑷)의 "복원 직후 재직렬화 == 저장 원문" 비교가
// 레거시 레코드에서도 유효하게 남도록 쓴다 -- collectInlineSegments
// 문단 참고.
export function $serializeRootToMarkdown(options) {
  return $getRoot()
    .getChildren()
    .map((node) => serializeBlock(node, options))
    .join("\n\n");
}

export function serializeEditorToMarkdown(editor, options) {
  return editor.getEditorState().read(() => $serializeRootToMarkdown(options));
}
