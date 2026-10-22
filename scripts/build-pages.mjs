// HYK-304-pages-deploy-1 (coder-task.md §2 요구 2 ⓐ·ⓑ): GitHub Pages 배포
// 워크플로가 부르는 1회성 프로덕션 빌드 -- src/editor/dev-server.mjs 와
// 같은 esbuild 설정(entry·bundle·outdir, src/editor/esbuild-config.mjs
// 공유 모듈)을 쓴다. context().serve() 대신 build() 한 번만 호출하는
// 차이뿐이라 dev 와 배포 산출물이 같은 출처에서 나온다(드리프트 방지).
import { build } from "esbuild";
import { createBuildOptions } from "../src/editor/esbuild-config.mjs";

await build(createBuildOptions());
console.log("[build-pages] public/dist/app.js 생성 완료");
