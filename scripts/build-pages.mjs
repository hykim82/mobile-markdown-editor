// HYK-304-pages-deploy-1 (coder-task.md §2 요구 2 ⓐ·ⓑ, 2R 판정 2245 §2 ②):
// GitHub Pages 배포 워크플로가 부르는 1회성 프로덕션 빌드 -- src/editor/
// dev-server.mjs 와 entry·bundle·outdir 는 같은 esbuild-config.mjs 공유
// 모듈에서 나온다(드리프트 방지). createDeployBuildOptions() 가 그 공유
// 옵션에 minify:true·sourcemap:false 만 덮어써 배포 산출물만 압축하고
// sourcemap 을 끈다(개발 서버 출력은 createBuildOptions() 그대로 무변).
import { build } from "esbuild";
import { createDeployBuildOptions } from "../src/editor/esbuild-config.mjs";

await build(createDeployBuildOptions());
console.log("[build-pages] public/dist/app.js 생성 완료");
