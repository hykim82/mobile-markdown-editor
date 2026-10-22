// HYK-304-pwa-installable-1 (coder-task.md §2 요구 1·2·5). manifest 필수
// 칸 + 색↔토큰 일치 + 아이콘 실재/실제 PNG 픽셀 크기(파일 바이트에서 직접
// 읽는다, §2 요구 2 "시험이 파일 바이트에서 읽어 대조") + index.html head
// 의 manifest 링크·theme-color(라이트/다크)·apple-touch-icon.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderIconPng } from "../../scripts/gen-pwa-icons.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const manifestPath = join(repoRoot, "public", "manifest.json");
const indexHtmlPath = join(repoRoot, "public", "index.html");
const iconsDir = join(repoRoot, "public", "icons");
const tokensPath = join(repoRoot, "spec", "design-tokens.json");

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function readPngDimensions(buf) {
  // PNG IHDR 칸: 서명 8바이트 뒤 length(4)+type(4) 다음이 IHDR 본문이고,
  // 그 안 처음 4바이트가 width, 다음 4바이트가 height(둘 다 빅엔디안).
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("manifest: 필수 칸이 전부 있고 PRD 제목·색 토큰 값과 일치한다", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const tokens = JSON.parse(await readFile(tokensPath, "utf8"));

  assert.equal(
    manifest.name,
    "한 손 마크다운 에디터",
    "spec/PRD.md 제목 그대로",
  );
  assert.equal(typeof manifest.short_name, "string");
  assert.ok(manifest.short_name.length > 0 && manifest.short_name.length <= 12);
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.lang, "ko");
  assert.equal(
    manifest.theme_color,
    tokens["color.accent"].light,
    "theme_color = color.accent 라이트 토큰 값 그대로",
  );
  assert.equal(
    manifest.background_color,
    tokens["color.bg"].light,
    "background_color = color.bg 라이트 토큰 값 그대로",
  );
});

test("manifest: icons 배열에 192·512 가 PNG·any+maskable 로 있다", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.ok(Array.isArray(manifest.icons));
  const bySize = new Map(manifest.icons.map((icon) => [icon.sizes, icon]));
  for (const sizes of ["192x192", "512x512"]) {
    const icon = bySize.get(sizes);
    assert.ok(icon, `icons 배열에 ${sizes} 항목이 있어야 한다`);
    assert.equal(icon.type, "image/png");
    assert.match(icon.purpose, /\bany\b/);
    assert.match(icon.purpose, /\bmaskable\b/);
    assert.equal(icon.src, `/icons/icon-${sizes.split("x")[0]}.png`);
  }
});

test("아이콘 파일: 192·512 PNG 가 실재하고 파일 바이트에서 읽은 실제 픽셀 크기가 파일명과 같다", async () => {
  for (const size of [192, 512]) {
    const buf = await readFile(join(iconsDir, `icon-${size}.png`));
    assert.deepEqual(buf.subarray(0, 8), PNG_SIGNATURE, `${size}: PNG 서명`);
    const { width, height } = readPngDimensions(buf);
    assert.equal(width, size, `${size}: 실제 가로 픽셀`);
    assert.equal(height, size, `${size}: 실제 세로 픽셀`);
  }
});

test("아이콘 파일: iOS apple-touch-icon(180) 이 실재하고 180x180 이다", async () => {
  const buf = await readFile(join(iconsDir, "apple-touch-icon-180.png"));
  assert.deepEqual(buf.subarray(0, 8), PNG_SIGNATURE);
  const { width, height } = readPngDimensions(buf);
  assert.equal(width, 180);
  assert.equal(height, 180);
});

test("아이콘: scripts/gen-pwa-icons.mjs 재생성 결과가 커밋된 파일과 바이트 단위로 같다(결정적 생성 증거)", async () => {
  const cases = [
    [192, "icon-192.png"],
    [512, "icon-512.png"],
    [180, "apple-touch-icon-180.png"],
  ];
  for (const [size, filename] of cases) {
    const generated = renderIconPng(size);
    const committed = await readFile(join(iconsDir, filename));
    assert.ok(
      generated.equals(committed),
      `${filename}: 생성기 재실행 출력이 커밋된 파일과 바이트까지 같아야 한다(결정적)`,
    );
  }
});

test("index.html head: manifest 링크·theme-color(라이트·다크)·apple-touch-icon 이 있다", async () => {
  const html = await readFile(indexHtmlPath, "utf8");
  assert.match(html, /<link[^>]*rel="manifest"[^>]*href="\/manifest\.json"/);
  assert.match(
    html,
    /<meta[^>]*name="theme-color"[^>]*media="\(prefers-color-scheme:\s*light\)"[^>]*content="#3B6FE0"/,
  );
  assert.match(
    html,
    /<meta[^>]*name="theme-color"[^>]*media="\(prefers-color-scheme:\s*dark\)"[^>]*content="#5B8DEF"/,
  );
  assert.match(
    html,
    /<link[^>]*rel="apple-touch-icon"[^>]*sizes="180x180"[^>]*href="\/icons\/apple-touch-icon-180\.png"/,
  );
  assert.match(
    html,
    /<meta[^>]*name="apple-mobile-web-app-capable"[^>]*content="yes"/,
  );
});
