// coder-task.md §1-B-ⓐ: 사람이 칠 «한 줄» = `npm run dev`. esbuild 컨텍스트로
// 브라우저 번들을 만들고(변경 시 자동 재빌드) public/ 을 정적으로 서빙한다.
// 0.0.0.0 으로 열어 같은 와이파이의 휴대폰에서도 접속 가능하게 한다.
import { context } from "esbuild";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const publicDir = join(repoRoot, "public");
const PORT = 5173;

function lanAddresses() {
  const addresses = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const entry of iface ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

async function main() {
  const ctx = await context({
    entryPoints: [join(here, "app.mjs")],
    bundle: true,
    outdir: join(publicDir, "dist"),
    format: "esm",
    sourcemap: true,
    logLevel: "info",
  });

  const { port } = await ctx.serve({
    servedir: publicDir,
    host: "0.0.0.0",
    port: PORT,
  });

  console.log(`[dev] PC: http://localhost:${port}/`);
  for (const address of lanAddresses()) {
    console.log(`[dev] 휴대폰(같은 와이파이): http://${address}:${port}/`);
  }
}

main();
