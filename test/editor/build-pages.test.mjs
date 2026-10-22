// HYK-304-pages-deploy-1(coder-task.md §2 요구 2ⓐ·ⓑ, 2R 판정 2245 §2 ②):
// scripts/build-pages.mjs 가 src/editor/dev-server.mjs 와 "같은 출처"
// (src/editor/esbuild-config.mjs)의 entry·bundle·outdir 로 빌드하는지,
// 배포 전용 옵션(minify·sourcemap)만 createDeployBuildOptions() 로 갈라져
// 개발 출력은 무변인지, 그리고 실제로 실행하면 public/dist/app.js 가
// 압축·sourcemap 없이 생기는지를 값으로 잰다(드리프트 방지 칸).
import { readFile, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBuildOptions,
  createDeployBuildOptions,
  publicDir,
} from "../../src/editor/esbuild-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const buildPagesScript = join(repoRoot, "scripts", "build-pages.mjs");
const devServerSource = await readFile(
  join(repoRoot, "src", "editor", "dev-server.mjs"),
  "utf8",
);
const buildScriptSource = await readFile(
  join(repoRoot, "scripts", "build-pages.mjs"),
  "utf8",
);

test("정적 대조: dev-server.mjs 와 scripts/build-pages.mjs 둘 다 src/editor/esbuild-config.mjs 에서 빌드 옵션을 가져온다(같은 출처, 드리프트 방지)", () => {
  assert.match(devServerSource, /from\s+["']\.\/esbuild-config\.mjs["']/);
  assert.match(
    buildScriptSource,
    /from\s+["'](\.\.\/)?src\/editor\/esbuild-config\.mjs["']/,
  );
  assert.doesNotMatch(
    buildScriptSource,
    /ctx\.serve\(/,
    "build-pages.mjs 는 1회성 build() 만 쓴다 -- dev-server 처럼 context().serve() 로 띄우지 않는다",
  );
});

// 3R(검토 2R P1-1): 이 두 칸은 esbuild 를 실제로 부르지 않고 옵션 객체
// 모양만 재는 "설정 동일성" 칸이다(scripts/build-pages.mjs 파일 자체의
// outdir·minify 하드코딩은 안 본다) -- 그래서 import 로 남겨도 된다. 실제
// 스크립트 자리 변이(outdir·개발 출력 되돌림)를 잡는 책임은 아래 "실행"
// 칸(자식 프로세스로 scripts/build-pages.mjs 를 그대로 돌림)에 있다.
test("createBuildOptions()(개발 서버용): entry 가 src/editor/app.mjs, outdir 가 public/dist, bundle:true, format:esm, sourcemap:true, minify 미설정(기본 false)이다 -- 2R 배포 전용 옵션(minify·sourcemap)이 섞여 들어오면 이 칸이 깨진다(개발 출력 무변 근거)", () => {
  const options = createBuildOptions();
  assert.equal(options.entryPoints.length, 1);
  assert.match(options.entryPoints[0], /src[\\/]editor[\\/]app\.mjs$/);
  assert.equal(options.outdir, join(publicDir, "dist"));
  assert.equal(options.bundle, true);
  assert.equal(options.format, "esm");
  assert.equal(options.sourcemap, true);
  assert.equal(options.minify, undefined);
});

// HYK-304-pages-deploy-1 2R(판정 2245 §2 ②): createDeployBuildOptions() 는
// createBuildOptions() 와 같은 entry·outdir·bundle·format 을 공유 모듈에서
// 그대로 물려받고 minify:true·sourcemap:false 만 덮어쓴다 -- 이 칸은
// 실제 esbuild 실행 없이(빠른 단위 칸) 그 사양 고정만 잰다.
test("createDeployBuildOptions()(배포용): minify:true, sourcemap:false, 그 외(entry·outdir·bundle·format)는 createBuildOptions() 와 같다(공유 설정 모듈)", () => {
  const devOptions = createBuildOptions();
  const deployOptions = createDeployBuildOptions();
  assert.equal(deployOptions.minify, true);
  assert.equal(deployOptions.sourcemap, false);
  assert.deepEqual(deployOptions.entryPoints, devOptions.entryPoints);
  assert.equal(deployOptions.outdir, devOptions.outdir);
  assert.equal(deployOptions.bundle, devOptions.bundle);
  assert.equal(deployOptions.format, devOptions.format);
});

// 3R(검토 2R P1-1): 배포가 실제로 부르는 것은 scripts/build-pages.mjs
// 파일이다 -- createDeployBuildOptions() 를 여기서 직접 import 해 esbuild
// 를 부르면 그 파일 자신의 outdir·minify·sourcemap 하드코딩은 한 번도
// 안 거친다(2R 에서 1R M13(outdir -> public/wrong)과 배포를 개발 출력으로
// 되돌리는 변이가 둘 다 이 칸을 GREEN 으로 통과한 이유). 이 칸은 그
// 파일을 자식 프로세스로 그대로 실행해(node scripts/build-pages.mjs,
// 종료코드는 execFileSync 가 비정상 종료 시 던지는 것으로 판정) 그
// 하드코딩을 직접 거치게 한다.
test("실행: node scripts/build-pages.mjs 를 자식 프로세스로 실제 실행하면(설정 import 아님) public/dist/app.js 가 생기고(.gitignore 대상, 커밋에는 포함되지 않는다), 압축 상한 밑이며 sourcemap 파일이 없다(1R 미압축 1,247,790B 대비) -- outdir 를 public/wrong 으로 바꾸거나 배포를 개발 출력(minify:false, sourcemap:true)으로 되돌리는 변이는 이 칸이 걸린다(2R 검토 P1-1 수리)", async () => {
  const outFile = join(publicDir, "dist", "app.js");
  const mapFile = `${outFile}.map`;
  await rm(join(publicDir, "dist"), { recursive: true, force: true });

  execFileSync(process.execPath, [buildPagesScript], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  const stats = await stat(outFile);
  assert.ok(stats.size > 0, "public/dist/app.js 가 비어있지 않아야 한다");
  assert.ok(
    stats.size < 700_000,
    `배포 산출물(${stats.size}B)이 압축 상한(700,000B) 밑이어야 한다 -- 1R 미압축 1,247,790B 대비 큰 차이가 없으면 minify 가 실제로 안 먹은 것(sourcemap 끄는 변이·minify 끄는 변이 RED 근거)`,
  );

  await assert.rejects(
    stat(mapFile),
    /ENOENT/,
    "sourcemap(.map) 파일이 없어야 한다 -- 배포 산출물은 sourcemap 을 끈다(다시 켜는 변이 RED 근거)",
  );

  const gitignore = await readFile(join(repoRoot, ".gitignore"), "utf8");
  assert.match(
    gitignore,
    /^dist\/$/m,
    ".gitignore 에 dist/ 가 있어야 빌드 산출물이 커밋에 안 들어간다",
  );
});
