// coder-task.md §3-ⓔ: 「직렬화 금지」를 시험이 지키게 하라 -- 라이브러리의
// 마크다운 직렬화 함수를 저장·복사 경로에서 부르지 않는다는 것을
// 기계가 검사해야 한다("안 쓸게요"는 시험이 아니다). @lexical/markdown
// 의 $convertToMarkdownString/$convertFromMarkdownString 이 src/ 아래
// «실행 코드»에 나타나지 않는지 훑는다. 줄 주석("//...")은 훑기 전에
// 걷어낸다 -- 예를 들어 serialize.mjs 머리 주석은 이 두 이름을 왜 안
// 쓰는지 설명하려고 그 이름 자체를 언급하는데, 그건 이 시험이 막으려는
// "실제로 부르는" 행위가 아니다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const BANNED_NAMES = ["$convertToMarkdownString", "$convertFromMarkdownString"];
const LINE_COMMENT_RE = /\/\/.*$/gmu;

function listMjsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listMjsFiles(full));
    } else if (entry.endsWith(".mjs")) {
      files.push(full);
    }
  }
  return files;
}

test("src/ 실행 코드 어디에도 라이브러리 마크다운 직렬화 함수 이름이 나타나지 않는다", () => {
  const offenders = [];
  for (const file of listMjsFiles(SRC_DIR)) {
    const code = readFileSync(file, "utf8").replace(LINE_COMMENT_RE, "");
    for (const name of BANNED_NAMES) {
      if (code.includes(name)) {
        offenders.push(`${file}: ${name}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `저장·복사 경로(src/)는 라이브러리 직렬화 함수를 부르면 안 된다(coder-task.md §0-1/§3-ⓔ): ${offenders.join(", ")}`,
  );
});
