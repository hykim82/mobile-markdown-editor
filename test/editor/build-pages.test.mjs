// HYK-304-pages-deploy-1(coder-task.md §2 요구 2ⓐ·ⓑ): scripts/build-pages.mjs
// 가 src/editor/dev-server.mjs 와 "같은 출처"(src/editor/esbuild-config.mjs)
// 의 entry·bundle·outdir 로 빌드하는지, 그리고 실제로 실행하면
// public/dist/app.js 가 생기는지를 값으로 잰다(드리프트 방지 칸).
import { readFile, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBuildOptions,
  publicDir,
} from "../../src/editor/esbuild-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
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

test("createBuildOptions(): entry 가 src/editor/app.mjs, outdir 가 public/dist, bundle:true, format:esm 이다", () => {
  const options = createBuildOptions();
  assert.equal(options.entryPoints.length, 1);
  assert.match(options.entryPoints[0], /src[\\/]editor[\\/]app\.mjs$/);
  assert.equal(options.outdir, join(publicDir, "dist"));
  assert.equal(options.bundle, true);
  assert.equal(options.format, "esm");
});

test("실행: scripts/build-pages.mjs 를 실제로 돌리면 public/dist/app.js 가 생긴다(.gitignore 대상, 커밋에는 포함되지 않는다)", async () => {
  const outFile = join(publicDir, "dist", "app.js");
  await rm(join(publicDir, "dist"), { recursive: true, force: true });

  const { build } = await import("esbuild");
  await build(createBuildOptions());

  const stats = await stat(outFile);
  assert.ok(stats.size > 0, "public/dist/app.js 가 비어있지 않아야 한다");

  const gitignore = await readFile(join(repoRoot, ".gitignore"), "utf8");
  assert.match(
    gitignore,
    /^dist\/$/m,
    ".gitignore 에 dist/ 가 있어야 빌드 산출물이 커밋에 안 들어간다",
  );
});
