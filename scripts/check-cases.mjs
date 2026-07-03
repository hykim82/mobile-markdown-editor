// 동결된 구조화 케이스가 테스트에 남아있는지 확인하는 안전검사.
// 런타임 정답 증명이 아니라, 테스트가 조용히 약화되지 않았는지만 본다.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "test";

// Task Contract(HYK)의 구조화 테스트 케이스 필수 입력 토큰.
const REQUIRED = [
  "# 제목",
  "## 소제목",
  "### 셋",
  "- 사과",
  "- [ ]",
  "- [x]",
  "**굵게**",
  "~~취소~~",
  "#제목",
  "그냥 텍스트",
];

if (!existsSync(TEST_DIR)) {
  console.error(`[check-cases] FAIL: ${TEST_DIR}/ 디렉터리가 없습니다.`);
  process.exit(1);
}

const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.mjs"));
if (files.length === 0) {
  console.error("[check-cases] FAIL: test/*.test.mjs 테스트 파일이 없습니다.");
  process.exit(1);
}

const content = files
  .map((f) => readFileSync(join(TEST_DIR, f), "utf8"))
  .join("\n");

const missing = REQUIRED.filter((tok) => !content.includes(tok));
if (missing.length > 0) {
  console.error("[check-cases] FAIL: 동결 케이스 입력 누락 -> " + missing.join(", "));
  process.exit(1);
}

console.log(
  `[check-cases] OK: 테스트 파일 ${files.length}개에 필수 케이스 ${REQUIRED.length}종 존재.`,
);
