// HYK-304-pages-deploy-1(coder-task.md §2 요구 2ⓐ·ⓔ): .github/workflows/
// deploy-pages.yml 자체를 YAML 파서 없이(새 의존성 0, product_scope 제약)
// 원문 텍스트에 대한 정적 대조로 잰다 -- public/sw.js 를 node:vm 으로
// "그대로 실행"해 재는 것과 같은 결의 선택이다: 실제 GitHub Actions 실행은
// 이 좌석에서 못 잰다(한계, 결과 파일 §한계 문단) -- 트리거·단계·권한
// 선언이 "파일에 그대로 있는가"만 값으로 잰다.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(
  here,
  "..",
  "..",
  ".github",
  "workflows",
  "deploy-pages.yml",
);
const enforcePath = join(
  here,
  "..",
  "..",
  ".github",
  "workflows",
  "enforce.yml",
);

const workflow = await readFile(workflowPath, "utf8");

test("배포 워크플로: main push 가 트리거다(+ workflow_dispatch 수동 실행, 근거는 파일 주석)", () => {
  assert.match(
    workflow,
    /^on:\n(?:.*\n)*?\s*push:\n\s*branches:\n\s*-\s*main/m,
  );
  assert.match(
    workflow,
    /workflow_dispatch:/,
    "수동 실행 트리거도 선언돼 있어야 한다(파일 머리 주석의 1줄 근거 참고)",
  );
});

test("배포 워크플로: pages/id-token 권한이 워크플로 안에서만 선언되고(contents:read 외 최상위 0), build 산출물에 dist 를 포함시킨 뒤 upload-pages-artifact/deploy-pages 순서로 돈다", () => {
  // 최상위 permissions 블록(첫 번째 'permissions:' 등장)에는 pages/id-token
  // 이 없어야 한다 -- 그 둘은 deploy 잡 블록 안에서만 선언된다.
  const topLevelPermissionsMatch = workflow.match(
    /^permissions:\n((?:^ {2}.*\n?)+)/m,
  );
  assert.ok(topLevelPermissionsMatch, "최상위 permissions 블록이 있어야 한다");
  assert.doesNotMatch(
    topLevelPermissionsMatch[1],
    /pages:\s*write|id-token:\s*write/,
    "최상위(워크플로 전체) permissions 에는 pages/id-token 이 없어야 한다 -- deploy 잡 안에서만 선언된다",
  );
  assert.match(topLevelPermissionsMatch[1], /contents:\s*read/);

  assert.match(
    workflow,
    /pages:\s*write/,
    "deploy 잡 어딘가에 pages: write 가 선언돼 있어야 한다",
  );
  assert.match(
    workflow,
    /id-token:\s*write/,
    "deploy 잡 어딘가에 id-token: write 가 선언돼 있어야 한다",
  );

  // 빌드 → upload-pages-artifact → deploy-pages 순서(텍스트 등장 순서로
  // 근사 확인 -- 실제 실행 순서는 jobs.deploy.needs:build 와 steps 배열
  // 순서가 보장한다, 이 칸은 "단계 자체가 파일에 있는가·상대 순서"만 잰다).
  const buildIdx = workflow.indexOf("npm run build:pages");
  const uploadIdx = workflow.indexOf("actions/upload-pages-artifact");
  const deployIdx = workflow.indexOf("actions/deploy-pages");
  assert.ok(buildIdx > -1 && uploadIdx > -1 && deployIdx > -1);
  assert.ok(
    buildIdx < uploadIdx && uploadIdx < deployIdx,
    "빌드 -> 산출물 업로드 -> 배포 순서로 등장해야 한다",
  );

  assert.match(
    workflow,
    /actions\/upload-pages-artifact@v3\s*\n\s*with:\s*\n\s*path:\s*public/,
    "업로드 산출물 경로가 public(= dist/app.js 를 포함하는 디렉터리)이어야 한다",
  );

  assert.match(
    workflow,
    /needs:\s*build/,
    "deploy 잡은 build 잡이 끝난 뒤에 돌아야 한다(needs: build)",
  );
});

test("배포 워크플로: 조용한 초록 금지 -- continue-on-error · if: 로 실패를 삼키는 조건부 건너뜀 · `|| true` 가 0개다", () => {
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.doesNotMatch(workflow, /\bif:\s*/);
  assert.doesNotMatch(workflow, /\|\|\s*true\b/);
});

test("배포 워크플로: Pages 활성화 확인(configure-pages) 단계가 build 산출물 생성 뒤·업로드 전에 있다(Pages 미활성이면 여기서 실패)", () => {
  const buildIdx = workflow.indexOf("npm run build:pages");
  const configureIdx = workflow.indexOf("actions/configure-pages");
  const uploadIdx = workflow.indexOf("actions/upload-pages-artifact");
  assert.ok(buildIdx > -1 && configureIdx > -1 && uploadIdx > -1);
  assert.ok(buildIdx < configureIdx && configureIdx < uploadIdx);
});

test("배포 워크플로: 액션 판이 전부 메이저 태그로 고정돼 있다(enforce.yml 의 checkout@v4/setup-node@v4 와 같은 관례)", () => {
  const actionRefs = [...workflow.matchAll(/uses:\s*([^\s]+)/g)].map(
    (m) => m[1],
  );
  assert.ok(actionRefs.length >= 5, "actions/* 참조가 5개 이상이어야 한다");
  for (const ref of actionRefs) {
    assert.match(
      ref,
      /@v\d+$/,
      `${ref}: 메이저 버전 태그(@vN)로 고정돼야 한다(SHA 고정도 허용되지만 이 저장소 관례는 태그)`,
    );
  }
});

test("배포 워크플로: enforce.yml(기존 품질 게이트)은 이 변경으로 건드리지 않았다", async () => {
  const enforce = await readFile(enforcePath, "utf8");
  assert.match(enforce, /name: enforce/);
  // 이 테스트는 enforce.yml 이 여전히 존재하고 이름이 그대로임을 확인한다
  // (내용 전체 바이트 비교는 git diff 가 더 정확히 증명한다, 결과 파일
  // §5 "git diff --name-only" 칸 참고 -- 이 칸은 "실수로 같은 디렉터리의
  // 다른 워크플로를 건드리지 않았다"는 안전망).
});
