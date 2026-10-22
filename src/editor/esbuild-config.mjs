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
