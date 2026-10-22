// HYK-304-pages-deploy-1 (coder-task.md §2 요구 2 ⓑ): dev-server.mjs(개발
// 서버)와 scripts/build-pages.mjs(배포 빌드)가 entry·bundle·outdir 를
// 따로 들고 있으면 둘이 드리프트한다(배포판이 dev와 다른 설정으로 만들어져
// 배포 뒤에만 깨지는 사고). 둘 다 이 모듈의 같은 옵션 객체를 쓴다.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..");
export const publicDir = join(repoRoot, "public");

export function createBuildOptions() {
  return {
    entryPoints: [join(here, "app.mjs")],
    bundle: true,
    outdir: join(publicDir, "dist"),
    format: "esm",
    sourcemap: true,
    logLevel: "info",
  };
}

// HYK-304-pages-deploy-1 2R(판정 2245 §2 ②): 배포 산출물만 압축(minify)하고
// sourcemap 을 끈다 -- 개발 서버(dev-server.mjs)는 여전히 createBuildOptions()
// 를 그대로 쓰므로 entry·bundle·outdir·sourcemap:true 등 개발 출력은 무변,
// 배포 출력 옵션(minify·sourcemap)만 여기서 덮어쓴다(공유 설정 모듈은 같다).
export function createDeployBuildOptions() {
  return {
    ...createBuildOptions(),
    minify: true,
    sourcemap: false,
  };
}
