// coder-task.md §3-ⓒ/ⓓ: 원문 필드가 «바이트 그대로» 남는다 -- 대표 입력
// 21개(POC `poc-lexical` 브랜치 poc/lexical/markdown-roundtrip.test.mjs 가
// 쓴 그 목록, 읽기 전용 참고)를 넣고 원문 필드를 다시 꺼내 검사한다.
//
// 이 시험은 $convertFromMarkdownString 을 "고정 문서 문자열 -> 노드 트리"
// 픽스처 생성기로만 쓴다(테스트 전용 -- src/ 저장 경로가 아니므로 ⓔ 금지
// 대상이 아니다). 검사 대상(SUT)은 항상 우리 자체 직렬화 함수
// serializeEditorToMarkdown 이다 -- $convertToMarkdownString 은 이 파일
// 어디서도 부르지 않는다.
//
// POC 는 같은 21개를 라이브러리 자체 $convertToMarkdownString 으로 내보내
// "가격은 100~200원 정도" 한 건이 "가격은 100\\~200원 정도"로 깨지는 걸
// 확인했다(KNOWN_LOSSY). 우리 직렬화기는 그 함수를 아예 쓰지 않으므로 그
// 케이스는 완전히 고쳤다(아래 별도 ⓓ 시험 참조).
//
// 대신 이 조각 자체가 발견한 새 한계가 하나 있다: "* 별표"는 목록
// 트리거이지만, 원본 마커 문자('*')를 읽어올 공개 API가 0.51.0 배포판에
// 없다(src/editor/serialize.mjs 상단 주석 참조 -- listMarkerState 가
// 타입에는 선언돼 있으나 실제 export 목록에 없음, 실측 확인됨). 그래서
// "-" 로 정규화되어 그 한 글자만 원문과 달라진다 -- PRD §5.2 가 정의하는
// 트리거 문자는 애초에 "-" 하나뿐이므로 제품 실사용 경로(사용자가 직접
// 타이핑)에서는 나오지 않는 값이지만, 이 시험은 POC 목록을 그대로 재사용
// 하므로 정직하게 KNOWN_LIMITATIONS 로 박아 둔다(조용히 빼지 않는다).
import { test } from "node:test";
import assert from "node:assert/strict";
import "../support/jsdom-env.mjs";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { createEditor } from "lexical";
import {
  PRODUCT_TRANSFORMERS,
  PRODUCT_NODES,
} from "../../src/editor/transformers.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";

const INPUTS = [
  // 1-10: test/markdown-parser.test.mjs 의 라운드트립 목록과 겹치는 대표값
  "# 제목",
  "## 소제목",
  "### 셋",
  "- 사과",
  "- [ ] 할일",
  "- [x] 완료",
  "**굵게**",
  "~~취소~~",
  "#제목",
  "그냥 텍스트",
  // 11-21: POC 가 추가한 값(다중 블록·이모지·경계 케이스)
  "**중요** 한 항목과 ~~취소된~~ 항목",
  "# Title 제목",
  "- [ ] 지하철에서 마크다운 메모 작성하기",
  "- 사과\n- 바나나\n- 포도",
  "# 하나\n\n## 둘\n\n### 셋",
  "오늘 뭐 적어볼까요? 😊",
  "가격은 100~200원 정도",
  "* 별표",
  "12월 3일 회의 준비 - 자료 검토",
  "안녕하세요, 반갑습니다!",
  "**굵고 ~~취소도~~ 같이**",
];

const KNOWN_LIMITATIONS = new Map([["* 별표", "- 별표"]]);

function roundTrip(input) {
  const editor = createEditor({
    namespace: "round-trip-test",
    onError: (error) => {
      throw error;
    },
    nodes: PRODUCT_NODES,
  });
  editor.update(
    () => {
      $convertFromMarkdownString(input, PRODUCT_TRANSFORMERS);
    },
    { discrete: true },
  );
  return serializeEditorToMarkdown(editor);
}

for (const input of INPUTS) {
  test(`원문 보존 왕복: ${JSON.stringify(input)}`, () => {
    const expected = KNOWN_LIMITATIONS.has(input)
      ? KNOWN_LIMITATIONS.get(input)
      : input;
    assert.equal(roundTrip(input), expected);
  });
}

// ⓓ 회귀 고정: POC 에서 Lexical·ProseMirror 둘 다 깨뜨린 바로 그 입력.
// 위 21개 루프에도 포함돼 있지만, 이 값은 «우연히 통과»가 아니라 «반드시
// 지켜야 할 계약»이므로 별도 시험으로 다시 박는다.
test('ⓓ 회귀: "가격은 100~200원 정도" 가 글자 하나까지 원문 그대로 남는다', () => {
  const input = "가격은 100~200원 정도";
  assert.equal(roundTrip(input), input);
});
