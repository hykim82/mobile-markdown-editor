// HYK-304-pwa-installable-1 (coder-task.md §2 요구 3, §2 요구 6 오프라인
// 칸). public/sw.js(고전 서비스 워커 스크립트) 자체를 test/support/
// sw-harness.mjs 의 가짜 self/caches/fetch 위에서 실행해 설치·활성화·
// fetch 가로채기를 단위로 잰다 -- 실제 브라우저 오프라인 실행은 못 잰다
// (한계, 결과 파일 §한계 문단).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadServiceWorker } from "../support/sw-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const swSource = await readFile(
  join(here, "..", "..", "public", "sw.js"),
  "utf8",
);

const APP_SHELL = [
  "/",
  "/index.html",
  "/dist/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon-180.png",
];

test("정적 대조: public/sw.js 원문에 indexedDB 실사용(API 접근·호출)이 0개다(§2 요구 3 무접촉)", () => {
  // 바로 뒤에 `.`/`(` 가 와야 "실제 API 접근"으로 치고, 설명 주석 속 낱말
  // 언급(예: "indexedDB 를 전혀 참조하지")은 걸지 않는다 -- 이 파일이
  // 바로 그 무접촉을 설명하는 주석을 머리에 달고 있다.
  assert.doesNotMatch(swSource, /\bindexedDB\s*[.(]/);
});

test("정적 대조: public/sw.js 는 push·sync 리스너를 등록하지 않는다(PRD 요구 권한 없음)", async () => {
  const sw = loadServiceWorker();
  assert.equal(sw.listeners.push, undefined);
  assert.equal(sw.listeners.sync, undefined);
  assert.equal(typeof sw.listeners.install, "function");
  assert.equal(typeof sw.listeners.activate, "function");
  assert.equal(typeof sw.listeners.fetch, "function");
});

test("install: 앱 껍데기 전체(7개 경로)를 캐시에 채운다", async () => {
  const sw = loadServiceWorker();
  await sw.runInstall();
  const cache = await sw.caches.open("mobile-markdown-editor-shell-v1");
  assert.equal(cache.size(), APP_SHELL.length);
  for (const path of APP_SHELL) {
    const hit = await cache.match({ url: "https://example.test" + path });
    assert.ok(hit, `캐시에 ${path} 가 있어야 한다`);
  }
});

test("오프라인: 설치 뒤 네트워크가 끊겨도 탐색 요청이 캐시된 index.html 로 응답한다", async () => {
  const sw = loadServiceWorker();
  await sw.runInstall();
  sw.setOnline(false);

  const result = await sw.runFetch("/index.html", { mode: "navigate" });
  assert.equal(result.intercepted, true);
  assert.equal(result.response.ok, true);
  assert.equal(result.response.url, "https://example.test/index.html");
});

test("오프라인: 설치 뒤 네트워크가 끊겨도 번들(app.js)·manifest 가 캐시로 응답한다", async () => {
  const sw = loadServiceWorker();
  await sw.runInstall();
  sw.setOnline(false);
  sw.fetchLog.length = 0; // install 중 발생한 호출 기록은 비운다.

  const bundle = await sw.runFetch("/dist/app.js");
  assert.equal(bundle.intercepted, true);
  assert.equal(bundle.response.ok, true);

  const manifest = await sw.runFetch("/manifest.json");
  assert.equal(manifest.intercepted, true);
  assert.equal(manifest.response.ok, true);

  // 캐시 우선 전략이므로 오프라인 상태에서도 network fetch 를 다시 시도하지
  // 않는다(캐시에 이미 있었으므로) -- fetchLog 가 비어있어야 한다.
  assert.deepEqual(sw.fetchLog, []);
});

test("탐색 네트워크 우선: 온라인이면 네트워크 응답을 쓰고 캐시도 최신으로 갱신한다(업데이트가 안 보이는 위험 방지)", async () => {
  const sw = loadServiceWorker();
  await sw.runInstall();
  // 설치 때 캐시된 것과는 별개로, 온라인 탐색은 항상 네트워크를 다시 탄다.
  sw.fetchLog.length = 0;

  const result = await sw.runFetch("/index.html", { mode: "navigate" });
  assert.equal(result.intercepted, true);
  assert.deepEqual(sw.fetchLog, ["https://example.test/index.html"]);
});

test("캐시 판 교체: activate 가 현재 판과 다른 이름의 캐시를 지운다", async () => {
  const sw = loadServiceWorker();
  // 옛 판 캐시를 먼저 만들어 둔다(이전 설치의 잔존물 재현).
  await sw.caches.open("mobile-markdown-editor-shell-v0");
  await sw.runInstall(); // 현재 판(v1) 캐시 생성.

  let names = await sw.caches.keys();
  assert.ok(names.includes("mobile-markdown-editor-shell-v0"));
  assert.ok(names.includes("mobile-markdown-editor-shell-v1"));

  await sw.runActivate();

  names = await sw.caches.keys();
  assert.deepEqual(names, ["mobile-markdown-editor-shell-v1"]);
});

test("외부 출처 요청 가로채기 0: origin 이 다른 요청은 respondWith 가 불리지 않는다", async () => {
  const sw = loadServiceWorker();
  await sw.runInstall();
  const result = await sw.runFetch("https://cdn.other-origin.test/thing.js");
  assert.equal(result.intercepted, false);
});

test("앱 껍데기 목록 밖의 같은 출처 요청은 가로채지 않는다(가짜 fetch 로그에 0회 -- 그대로 네트워크로 흘러간다는 뜻)", async () => {
  const sw = loadServiceWorker();
  await sw.runInstall();
  sw.fetchLog.length = 0;
  const result = await sw.runFetch("/some-other-path.txt");
  assert.equal(result.intercepted, false);
  assert.deepEqual(sw.fetchLog, []);
});
