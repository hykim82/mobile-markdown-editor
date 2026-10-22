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

test("배포 워크플로: main push 만 트리거다(2R 판정 2245 §2 ① -- 수동 실행(workflow_dispatch) 0, pull_request(_target) 0)", () => {
  assert.match(
    workflow,
    /^on:\n(?:.*\n)*?\s*push:\n\s*branches:\n\s*-\s*main/m,
  );
  assert.doesNotMatch(
    workflow,
    /workflow_dispatch:/,
    "수동 실행 트리거는 제거돼야 한다 -- main 밖 가지에서도 돌 수 있는 구멍이었다(판정 2245 §2 ①)",
  );
  assert.doesNotMatch(
    workflow,
    /pull_request(_target)?:/,
    "PR 트리거(pull_request/pull_request_target)는 0개여야 한다(P2-5)",
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

  // P2-2: path 값이 정확히 "public"(끝 고정)이어야 한다 -- 끝을 고정하지
  // 않으면 "public/icons" 같은 하위 디렉터리로 좁히는 변이도 이 정규식을
  // 그대로 통과한다(그러면 dist/app.js 가 업로드 산출물 밖으로 빠진다).
  const pathMatch = workflow.match(
    /actions\/upload-pages-artifact@v3\s*\n\s*with:\s*\n\s*path:\s*(\S+)\s*$/m,
  );
  assert.ok(pathMatch, "upload-pages-artifact 의 path: 값을 찾을 수 없다");
  assert.equal(
    pathMatch[1],
    "public",
    "업로드 산출물 경로가 정확히 public 이어야 한다(하위 디렉터리로 좁히면 dist/app.js 가 빠진다)",
  );

  assert.match(
    workflow,
    /needs:\s*build/,
    "deploy 잡은 build 잡이 끝난 뒤에 돌아야 한다(needs: build)",
  );
});

// P2-2(산출물 포함 확인) -- 3R(검토 2R P1-1 수리, P2-1 경합 제거): 이
// 칸은 원래 public/dist 를 지우고 다시 빌드해 "업로드 경로(public) 아래에
// dist/app.js 가 있다"를 쟀는데, build-pages.test.mjs 의 실행 칸도 같은
// public/dist 를 지우고 다시 빌드한다 -- node --test 는 서로 다른 시험
// 파일을 별도 프로세스로 동시에 돌리므로 두 칸이 같은 디스크 경로를 두고
// 경합한다(한쪽이 지우는 사이 다른 쪽이 읽어 ENOENT·부분 파일을 보는
// 산발적 실패). outdir(= publicDir/"dist")가 "public 아래"라는 사실은
// build-pages.test.mjs 의 createBuildOptions() 칸(outdir 를 join(publicDir,
// "dist") 로 직접 단언)과 그 "실행" 칸(자식 프로세스 실행 뒤 그 경로에서
// app.js 를 실제로 찾아낸다)이 이미 값으로 재므로, 이 칸은 그 쪽으로
// 합친다(중복 빌드 제거 -- 한 파일로 모음).

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

test("배포 워크플로: enforce.yml(기존 품질 게이트)은 여전히 존재하고 이름이 그대로다(2R 변경은 timeout-minutes 1줄뿐, 아래 별도 칸)", async () => {
  const enforce = await readFile(enforcePath, "utf8");
  assert.match(enforce, /name: enforce/);
  // 이 테스트는 enforce.yml 이 여전히 존재하고 이름이 그대로임을 확인한다
  // (내용 전체 바이트 비교는 git diff 가 더 정확히 증명한다, 결과 파일
  // §5 "git diff --name-only" 칸 참고 -- 이 칸은 "실수로 같은 디렉터리의
  // 다른 워크플로를 건드리지 않았다"는 안전망).
});

// P2-1(coder-task.md §2 요구 1): enforce 잡에 timeout-minutes 가 있어야
// 한다 -- 캐시 즉시 응답이 깨지는 변이(검토 1R M3)가 걸려도 CI 잡 기본
// 제한까지 멈춰 있지 않고 이 숫자 분 안에 실패로 끝난다.
test("enforce.yml: enforce 잡에 timeout-minutes 가 선언돼 있고 합리적인 분 단위 숫자다(멈추는 변이의 CI 쪽 안전망)", async () => {
  const enforce = await readFile(enforcePath, "utf8");
  const match = enforce.match(/^\s*timeout-minutes:\s*(\d+)\s*$/m);
  assert.ok(match, "enforce 잡에 timeout-minutes: 가 있어야 한다");
  const minutes = Number(match[1]);
  assert.ok(
    minutes > 0 && minutes <= 60,
    `timeout-minutes 값(${minutes})이 1~60 분 사이여야 한다(0 이하는 즉시 실패, 60 초과는 안전망 의미 없음)`,
  );
});
