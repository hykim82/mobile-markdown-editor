// HYK-430 4R (검토 반려 P1-2 수리) -- "픽스처 몇 개"를 손으로 세지
// 않는다. 이 스크립트가 그 수를 만든다. 세 가지를 구별해서 낸다:
//   1) relay-handshake.mjs를 참조하는 시험 전부(가장 넓음 -- 대부분은
//      평범한 `import {...} from "./relay-handshake.mjs"` 정적
//      소비자이고, 격리 복사와 무관하다).
//   2) 그중 relay-handshake.mjs를 «파일명 문자열»로 참조하면서(단순
//      import 구문이 아니라 writeFileSync/readFileSync 등으로 복사)
//      동시에 mkdtempSync를 쓰는 시험 -- "격리 임시 디렉터리에
//      relay-handshake.mjs를 복사해 도는 시험"의 기계적 정의.
//   3) 2)의 부분집합 중 child-probe-timeout-policy.mjs를 함께 복사하지
//      «않는» 시험 -- 이것이 실제로 정책 부재 폴백 경로를 타는 집합
//      이다(=이 라운드가 답해야 하는 "몇 개"의 진짜 정의).
// 이전 라운드들의 숫자(주석의 "24개"/"24개 이상", 2R 결과 파일의
// "31개")는 이 스크립트가 없던 시절 손으로 센 값이라 서로 달랐다 --
// 이 스크립트가 유일한 정본이다. 실행: `node scripts/check/
// list-relay-handshake-isolated-fixtures.mjs [--json]`.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCAN_DIRS = ["scripts/check", "scripts/relay", "scripts/supervisor"];

function listTestFilesRecursive(absDir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(listTestFilesRecursive(abs));
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      out.push(abs);
    }
  }
  return out;
}

// 1) relay-handshake.mjs를 참조하는 시험 전부(문자열 리터럴 매치 --
// import 구문·파일명 복사 구분 없이 "이 이름이 파일 안에 등장하는가").
export function findRelayHandshakeReferencingTests({
  repoRoot = REPO_ROOT,
} = {}) {
  const files = [];
  for (const dir of SCAN_DIRS) {
    for (const abs of listTestFilesRecursive(join(repoRoot, dir))) {
      const content = readFileSync(abs, "utf8");
      if (content.includes("relay-handshake.mjs")) {
        files.push(relative(repoRoot, abs).replace(/\\/g, "/"));
      }
    }
  }
  return files.sort();
}

// 2) 1)의 부분집합 -- "격리 임시 디렉터리에 relay-handshake.mjs를
// «파일명 문자열»로 복사해 도는 시험"의 기계적 정의: 파일 안에
// 큰따옴표로 감싼 리터럴 "relay-handshake.mjs"(= writeFileSync/
// readFileSync 등의 인자로 쓰인 모양, import 구문의
// `from "./relay-handshake.mjs"`도 이 리터럴 검사를 통과하지만
// mkdtempSync 동시 존재 조건이 순수 정적-소비자 파일 대부분을
// 걸러낸다)와 `mkdtempSync` 호출이 같은 파일에 함께 있는 시험.
export function findIsolatedCopyTests({ repoRoot = REPO_ROOT } = {}) {
  const files = [];
  for (const dir of SCAN_DIRS) {
    for (const abs of listTestFilesRecursive(join(repoRoot, dir))) {
      const content = readFileSync(abs, "utf8");
      if (
        /"relay-handshake\.mjs"/.test(content) &&
        content.includes("mkdtempSync")
      ) {
        files.push(relative(repoRoot, abs).replace(/\\/g, "/"));
      }
    }
  }
  return files.sort();
}

// 3) HYK-430 5R: 폴백이 제거되고 relay-handshake.mjs가
// child-probe-timeout-policy.mjs를 정적 import하게 되면서, 이 부분집합의
// 의미가 "정책 부재 폴백을 타는 시험"에서 "정책 파일을 형제로 복사하지
// 않아 MODULE_NOT_FOUND로 즉시 깨지는 시험"으로 바뀌었다(함수 이름은
// 4R 이후 여러 곳에서 참조되어 그대로 둔다). 리터럴 "child-probe-timeout-
// policy"를 자기 파일 안에 직접 갖고 있거나(개별 복사), 5R이 만든 단일
// 소스 scripts/check/relay-handshake-fixture-siblings.mjs를 import해서
// RELAY_HANDSHAKE_STATIC_SIBLINGS/RELAY_HANDSHAKE_FIXTURE_FILES로
// 간접 복사하면(대부분의 격리 픽스처가 5R부터 이 방식이다) 둘 다
// "복사함"으로 인정한다 -- 그렇지 않으면 소스를 한 곳으로 모은 파일들이
// 리터럴이 없다는 이유만으로 이 목록에 거짓으로 다시 나타난다.
export function findFallbackExercisingTests({ repoRoot = REPO_ROOT } = {}) {
  return findIsolatedCopyTests({ repoRoot }).filter((relPath) => {
    const content = readFileSync(join(repoRoot, relPath), "utf8");
    const copiesDirectly = content.includes("child-probe-timeout-policy");
    const copiesViaSharedSiblingsModule =
      content.includes("relay-handshake-fixture-siblings.mjs") &&
      /RELAY_HANDSHAKE_(STATIC_SIBLINGS|FIXTURE_FILES)/.test(content);
    return !copiesDirectly && !copiesViaSharedSiblingsModule;
  });
}

function main() {
  const asJson = process.argv.includes("--json");
  const referencing = findRelayHandshakeReferencingTests();
  const isolatedCopies = findIsolatedCopyTests();
  const fallbackExercising = findFallbackExercisingTests();
  const result = {
    relayHandshakeReferencingCount: referencing.length,
    isolatedCopyCount: isolatedCopies.length,
    fallbackExercisingCount: fallbackExercising.length,
    isolatedCopyFiles: isolatedCopies,
    fallbackExercisingFiles: fallbackExercising,
  };
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `relay-handshake.mjs를 참조하는 시험 전부: ${result.relayHandshakeReferencingCount}`,
  );
  console.log(
    `그중 격리 임시 디렉터리에 파일명으로 복사해 도는 시험(mkdtempSync 동반): ${result.isolatedCopyCount}`,
  );
  console.log(
    `그중 child-probe-timeout-policy.mjs를 함께 복사하지 않는 시험(=정책 부재 폴백을 실제로 타는 시험): ${result.fallbackExercisingCount}`,
  );
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/list-relay-handshake-isolated-fixtures.mjs");
if (invokedDirectly) {
  main();
}
