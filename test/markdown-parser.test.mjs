import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/markdown-parser.mjs";

test('"# 제목" → heading level 1 "제목"', () => {
  assert.deepEqual(parse("# 제목"), { type: "heading", level: 1, text: "제목" });
});

test('"### 셋" → heading level 3 "셋"', () => {
  assert.deepEqual(parse("### 셋"), { type: "heading", level: 3, text: "셋" });
});

test('"- 사과" → bullet "사과"', () => {
  assert.deepEqual(parse("- 사과"), { type: "bullet", text: "사과" });
});

test('"- [ ] 할일" → checkbox unchecked "할일"', () => {
  assert.deepEqual(parse("- [ ] 할일"), { type: "checkbox", checked: false, text: "할일" });
});

test('"- [x] 완료" → checkbox checked "완료"', () => {
  assert.deepEqual(parse("- [x] 완료"), { type: "checkbox", checked: true, text: "완료" });
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
