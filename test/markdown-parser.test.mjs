import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, reconstruct } from "../src/markdown-parser.mjs";

// --- 기존 10개 시험 (약화 없이 유지) -----------------------------------
// ⛔해석 변경 1건: 헤딩·불릿·체크박스 결과에 `spans` 필드가 추가됐다(ⓒ 수리
// -- 그 세 타입도 이제 인라인 굵게/취소선을 본다). type/level/text/checked 에 대한
// 원래 단정은 전부 그대로이고, 새 필드가 빈 배열이라는 사실만 추가됐다 --
// 완화가 아니라 확장이다.

test('"# 제목" → heading level 1 "제목"', () => {
  assert.deepEqual(parse("# 제목"), {
    type: "heading",
    level: 1,
    text: "제목",
    spans: [],
  });
});

test('"### 셋" → heading level 3 "셋"', () => {
  assert.deepEqual(parse("### 셋"), {
    type: "heading",
    level: 3,
    text: "셋",
    spans: [],
  });
});

test('"## 소제목" → heading level 2 "소제목"', () => {
  assert.deepEqual(parse("## 소제목"), {
    type: "heading",
    level: 2,
    text: "소제목",
    spans: [],
  });
});

test('"- 사과" → bullet "사과"', () => {
  assert.deepEqual(parse("- 사과"), {
    type: "bullet",
    text: "사과",
    spans: [],
  });
});

test('"- [ ] 할일" → checkbox unchecked "할일"', () => {
  assert.deepEqual(parse("- [ ] 할일"), {
    type: "checkbox",
    checked: false,
    text: "할일",
    spans: [],
  });
});

test('"- [x] 완료" → checkbox checked "완료"', () => {
  assert.deepEqual(parse("- [x] 완료"), {
    type: "checkbox",
    checked: true,
    text: "완료",
    spans: [],
  });
});

test('"**굵게**" → paragraph with bold span "굵게"', () => {
  const result = parse("**굵게**");
  assert.equal(result.type, "paragraph");
  assert.deepEqual(result.spans, [{ type: "bold", text: "굵게" }]);
});

test('"~~취소~~" → paragraph with strike span "취소"', () => {
  const result = parse("~~취소~~");
  assert.equal(result.type, "paragraph");
  assert.deepEqual(result.spans, [{ type: "strike", text: "취소" }]);
});

test('"#제목" → paragraph (no space, not a heading)', () => {
  const result = parse("#제목");
  assert.equal(result.type, "paragraph");
  assert.equal(result.text, "#제목");
});

test('"그냥 텍스트" → paragraph "그냥 텍스트"', () => {
  const result = parse("그냥 텍스트");
  assert.equal(result.type, "paragraph");
  assert.equal(result.text, "그냥 텍스트");
  assert.deepEqual(result.spans, []);
});

// --- ⓐ 굵게/취소선이 "줄 전체"가 아니어도 선다 --------------------------

test('ⓐ 굵게가 줄 일부일 때도 선다: "할 일 **중요** 마감"', () => {
  const result = parse("할 일 **중요** 마감");
  assert.equal(result.type, "paragraph");
  assert.equal(result.text, "할 일 **중요** 마감");
  assert.deepEqual(result.spans, [{ type: "bold", text: "중요" }]);
});

test('ⓐ 취소선이 줄 일부일 때도 선다: "검토 ~~완료~~ 예정"', () => {
  const result = parse("검토 ~~완료~~ 예정");
  assert.deepEqual(result.spans, [{ type: "strike", text: "완료" }]);
});

// --- ⓑ 한 줄에 굵게/취소선이 여러 개 잡힌다 ------------------------------

test('ⓑ 굵게+취소선이 한 줄에 섞여도 둘 다 잡힌다: "**굵게** 와 ~~취소~~"', () => {
  const result = parse("**굵게** 와 ~~취소~~");
  assert.deepEqual(result.spans, [
    { type: "bold", text: "굵게" },
    { type: "strike", text: "취소" },
  ]);
});

test('ⓑ 같은 서식이 두 번 나오면 둘 다 잡힌다: "**a** 와 **b**"', () => {
  const result = parse("**a** 와 **b**");
  assert.deepEqual(result.spans, [
    { type: "bold", text: "a" },
    { type: "bold", text: "b" },
  ]);
});

// --- ⓒ 헤딩·목록·체크박스 안의 굵게/취소선도 선다 -----------------------

test('ⓒ 헤딩 안의 굵게: "# **중요** 제목"', () => {
  const result = parse("# **중요** 제목");
  assert.equal(result.type, "heading");
  assert.equal(result.level, 1);
  assert.equal(result.text, "**중요** 제목");
  assert.deepEqual(result.spans, [{ type: "bold", text: "중요" }]);
});

test('ⓒ 불릿 안의 굵게: "- **중요** 항목"', () => {
  const result = parse("- **중요** 항목");
  assert.equal(result.type, "bullet");
  assert.equal(result.text, "**중요** 항목");
  assert.deepEqual(result.spans, [{ type: "bold", text: "중요" }]);
});

test('ⓒ 체크박스 안의 취소선: "- [ ] ~~완료전~~ 할일"', () => {
  const result = parse("- [ ] ~~완료전~~ 할일");
  assert.equal(result.type, "checkbox");
  assert.equal(result.checked, false);
  assert.deepEqual(result.spans, [{ type: "strike", text: "완료전" }]);
});

// --- ⓓ 탐욕 매칭 수리: 여러 굵게가 하나로 삼켜지지 않는다 ----------------

test('ⓓ 비탐욕 매칭: "**가** 나 **다**" → 두 개의 별도 굵게 스팬', () => {
  const result = parse("**가** 나 **다**");
  assert.deepEqual(result.spans, [
    { type: "bold", text: "가" },
    { type: "bold", text: "다" },
  ]);
});

// --- ⓔ 헤딩 레벨: PRD 는 1~3만 정의한다 ----------------------------------
// spec/PRD.md §5.2 원문: "# `/`## `/`### ` → 헤딩1/2/3" -- 4단계 이상은
// 트리거로 정의되어 있지 않으므로 "#### " 는 헤딩이 아니라 문단으로 남긴다.

test('ⓔ "#### 넷" → 헤딩이 아니라 문단(PRD 가 1~3만 정의)', () => {
  const result = parse("#### 넷");
  assert.equal(result.type, "paragraph");
  assert.equal(result.text, "#### 넷");
});

test('ⓔ "###### 여섯" → 문단', () => {
  const result = parse("###### 여섯");
  assert.equal(result.type, "paragraph");
  assert.equal(result.text, "###### 여섯");
});

// --- 1-2 음성 시험: 닫히지 않은 표기는 서식이 아니다 ---------------------

test('음성 "**안 닫힘" → 서식 0, 원문 그대로', () => {
  const result = parse("**안 닫힘");
  assert.equal(result.type, "paragraph");
  assert.equal(result.text, "**안 닫힘");
  assert.deepEqual(result.spans, []);
});

test('음성 "~~안 닫힘" → 서식 0, 원문 그대로', () => {
  const result = parse("~~안 닫힘");
  assert.equal(result.type, "paragraph");
  assert.equal(result.text, "~~안 닫힘");
  assert.deepEqual(result.spans, []);
});

test('음성 "-사과"(공백 없음) → 목록 아님, 문단', () => {
  const result = parse("-사과");
  assert.equal(result.type, "paragraph");
  assert.equal(result.text, "-사과");
});

// "- [y] 이상한값": 체크박스 마커([ ]/[x])가 아니므로 체크박스는 아니다.
// 다만 "- " 자체는 독립된 목록 트리거이므로 불릿으로 떨어진다(일반 마크다운
// 관례와 동일 -- 대괄호 내용이 무엇이든 "- " 로 시작하면 목록 항목이다).
test('음성 "- [y] 이상한값" → 체크박스 아님, 불릿으로 떨어짐', () => {
  const result = parse("- [y] 이상한값");
  assert.equal(result.type, "bullet");
  assert.equal(result.text, "[y] 이상한값");
});

// "****"(빈 굵게): `.+?` 는 1자 이상을 요구하므로 빈 내용은 매치되지 않는다
// -- 빈 서식은 사용자에게 표시할 의미가 없으므로 서식으로 인정하지 않고
// 문단 원문("****")으로 그대로 남긴다.
test('음성 "****"(빈 굵게) → 서식 0, 원문 그대로', () => {
  const result = parse("****");
  assert.equal(result.type, "paragraph");
  assert.equal(result.text, "****");
  assert.deepEqual(result.spans, []);
});

// --- 1-3 원문 보존: reconstruct(parse(line)) === line -------------------
// 방식 선택: 원문 문자열을 별도 필드로 중복 보관하지 않고, parse() 결과
// (타입+레벨+text)로부터 프리픽스를 결정적으로 재조립하는 reconstruct() 를
// 둔다. 각 타입의 프리픽스 문법이 고정(헤딩 "#{1,3} ", 체크박스 "- [ /x] ",
// 불릿 "- ")이라 text 안의 마커까지 보존돼 있으면 항상 원문으로 되돌릴 수
// 있다 -- spans 는 파생 메타데이터일 뿐이라 복원에 관여하지 않는다.

const ROUND_TRIP_LINES = [
  "# 제목",
  "## 소제목",
  "### 셋",
  "#### 넷",
  "- 사과",
  "- [ ] 할일",
  "- [x] 완료",
  "**굵게**",
  "~~취소~~",
  "**가** 나 **다**",
  "**굵게** 와 ~~취소~~",
  "# **중요** 제목",
  "- **중요** 항목",
  "- [ ] ~~완료전~~ 할일",
  "**안 닫힘",
  "~~안 닫힘",
  "-사과",
  "- [y] 이상한값",
  "****",
  "#제목",
  "그냥 텍스트",
];

for (const line of ROUND_TRIP_LINES) {
  test(`원문 보존: reconstruct(parse(${JSON.stringify(line)})) === 원문`, () => {
    assert.equal(reconstruct(parse(line)), line);
  });
}

// --- 한글 조합 완성·이모지·결합문자를 깨뜨리지 않는지 ---------------------
// PRD 범위 밖인 IME 조합 처리 자체는 다루지 않지만(입력 계층의 일),
// 파서가 조합 완성된 한글/이모지/결합문자를 훼손하지 않는지는 확인한다.

test("한글 조합 완성 문자 + 이모지 + 굵게가 함께 있어도 안 깨진다", () => {
  const line = "지하철 할일 😀 **긴급** 확인";
  const result = parse(line);
  assert.equal(result.type, "paragraph");
  assert.equal(result.text, line);
  assert.deepEqual(result.spans, [{ type: "bold", text: "긴급" }]);
  assert.equal(reconstruct(result), line);
});

test("결합문자(악센트 콤바이닝)가 굵게 스팬 안에 있어도 안 깨진다", () => {
  const combining = "café"; // café, 'e' + combining acute accent
  const line = `**${combining}** 강조`;
  const result = parse(line);
  assert.deepEqual(result.spans, [{ type: "bold", text: combining }]);
  assert.equal(reconstruct(result), line);
});
