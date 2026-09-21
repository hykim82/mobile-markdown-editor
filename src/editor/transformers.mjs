// PRD §5.2 트리거 규칙 그대로: 헤딩1~3 · 목록 · 체크박스 · 굵게 · 취소선.
// 이 다섯 개가 이 조각이 다루는 «라이브 렌더링»의 전체 트리거 집합이다 --
// 다른 @lexical/markdown 트랜스포머(인용·순서목록·코드블록 등)는 범위 밖.
import {
  HEADING,
  UNORDERED_LIST,
  CHECK_LIST,
  BOLD_STAR,
  STRIKETHROUGH,
} from "@lexical/markdown";
import { HeadingNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";

// ⚠️순서가 의미를 바꾼다: CHECK_LIST_REGEX 는 "- [ ] "를, UNORDERED_LIST_REGEX
// 는 "- "만 요구한다 -- 즉 체크박스 줄도 UNORDERED_LIST 에 먼저 걸린다.
// UNORDERED_LIST 를 CHECK_LIST 보다 앞에 두면(실측 확인됨) 체크박스가
// 실제 체크 가능한 리스트가 아니라 "[ ] 할일"이라는 «글자»를 담은 평범한
// 불릿으로 잘못 수입된다(바이트 문자열만 보면 왕복은 통과해 조용히 숨는
// 버그). 반드시 CHECK_LIST 를 UNORDERED_LIST 보다 먼저 둔다.
export const PRODUCT_TRANSFORMERS = [
  HEADING,
  CHECK_LIST,
  UNORDERED_LIST,
  BOLD_STAR,
  STRIKETHROUGH,
];

export const PRODUCT_NODES = [HeadingNode, ListNode, ListItemNode];
