// HYK-304-pwa-installable-1 (coder-task.md product_scope ⓔ): 설치 가능
// 조건(manifest)이 요구하는 192·512 PNG 아이콘(+ iOS 용 180)을 외부
// 이미지·새 npm 의존성 0으로 만드는 결정적 생성기. node:zlib(내장)만 써서
// PNG 바이트를 직접 조립한다 -- 입력(크기·토큰 색)이 같으면 바이트까지
// 같은 출력이 나온다(아래 renderIconPng 는 Date.now() 등 비결정 요소를
// 전혀 쓰지 않는다). public/icons/*.png 는 이 스크립트의 출력을 그대로
// 커밋한 것이고, pwa-manifest-and-icons.test.mjs 가 재생성 결과와 커밋된
// 파일이 바이트 단위로 같은지를 단언한다.
//
// 디자인: 전체 캔버스를 color.accent(라이트) 토큰으로 채우고, 중앙에 지름
// 60%(반지름 30%) 흰 원을 둔다 -- maskable 아이콘의 "안전 영역"(보통 중앙
// 80%)보다 작아 OS 가 원형/둥근사각형으로 잘라내도 원이 잘리지 않는다
// (purpose: "any maskable" 양쪽에 같은 파일을 쓰는 근거).
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const outDir = join(repoRoot, "public", "icons");
const tokensPath = join(repoRoot, "spec", "design-tokens.json");

function hexToRgb(hex) {
  const n = hex.replace("#", "");
  return [
    parseInt(n.slice(0, 2), 16),
    parseInt(n.slice(2, 4), 16),
    parseInt(n.slice(4, 6), 16),
  ];
}

function loadBackgroundColor() {
  const tokens = JSON.parse(readFileSync(tokensPath, "utf8"));
  return hexToRgb(tokens["color.accent"].light);
}

const FG = [0xff, 0xff, 0xff];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function renderRow(y, size, cx, cy, radiusSq, bg) {
  const row = Buffer.alloc(1 + size * 3);
  row[0] = 0; // 필터: None
  for (let x = 0; x < size; x++) {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const inCircle = dx * dx + dy * dy <= radiusSq;
    const [r, g, b] = inCircle ? FG : bg;
    const off = 1 + x * 3;
    row[off] = r;
    row[off + 1] = g;
    row[off + 2] = b;
  }
  return row;
}

// 색 타입 2(트루컬러 RGB, 알파 없음) · 8비트 · 필터 None · PNG 압축은
// zlib.deflateSync(내장)만 쓴다 -- 외부 이미지 인코딩 라이브러리 0.
export function renderIconPng(size, bg = loadBackgroundColor()) {
  const radius = size * 0.3;
  const cx = size / 2;
  const cy = size / 2;
  const radiusSq = radius * radius;
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(renderRow(y, size, cx, cy, radiusSq, bg));
  }
  const raw = Buffer.concat(rows);
  const idatData = deflateSync(raw, { level: 9 });

  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idatData),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const OUTPUTS = [
  { size: 192, name: "icon-192.png" },
  { size: 512, name: "icon-512.png" },
  { size: 180, name: "apple-touch-icon-180.png" },
];

function main() {
  mkdirSync(outDir, { recursive: true });
  for (const { size, name } of OUTPUTS) {
    writeFileSync(join(outDir, name), renderIconPng(size));
  }
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/gen-pwa-icons.mjs");
if (invokedDirectly) main();
