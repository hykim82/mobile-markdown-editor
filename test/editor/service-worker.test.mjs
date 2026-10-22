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

  // P1 수리(네트워크 우선) 뒤에는 오프라인이어도 먼저 네트워크를 시도한다
  // (그래야 온라인일 때 새 판을 받을 수 있다) -- 실패하면 캐시로 떨어질
  // 뿐이다. 그래서 fetchLog 는 더 이상 비어있지 않다(수리 전 "캐시 우선"
  // 시절엔 네트워크를 안 탔으므로 비어있었다 -- 이 줄 자체가 전략이
  // 바뀌었다는 값 증거다).
  assert.deepEqual(sw.fetchLog, [
    "https://example.test/dist/app.js",
    "https://example.test/manifest.json",
  ]);
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

test("P1 수리 확인(검토 1R 탐침 재현): 판 A 설치 뒤 배포(판 B)가 있으면, 온라인 방문마다 번들이 새 판(B)으로 응답된다", async () => {
  const sw = loadServiceWorker({ serverVersion: "A" });
  await sw.runInstall(); // 판 A 로 설치(캐시에도 A 판 응답이 담긴다).
  sw.setServerVersion("B"); // 배포: 서버가 이제 판 B 를 준다(sw.js 바이트는
  // 그대로다 -- 새 install 이벤트는 안 일어난다. 실제 배포와 같은 전제).

  // 검토 1R 탐침과 같은 모양: 온라인 방문을 7회 반복해도 네트워크 우선이면
  // 그 전부가 최신(B)이어야 한다 -- 수리 전(캐시 우선) 버그는 7회 전부
  // 번들 A 에 갇혔다(검토 1R 결과 §2 ⓓ).
  for (let visit = 1; visit <= 7; visit += 1) {
    const result = await sw.runFetch("/dist/app.js");
    assert.equal(result.intercepted, true);
    assert.equal(
      result.response.version,
      "B",
      `온라인 방문 ${visit}회차: 번들이 배포된 새 판(B)이어야 한다`,
    );
  }
});

test("P1 수리와 공존: 오프라인이면 배포(B)와 무관하게 설치 시점에 캐시된 판(A)으로 앱이 뜬다", async () => {
  const sw = loadServiceWorker({ serverVersion: "A" });
  await sw.runInstall(); // 판 A 캐시.
  sw.setServerVersion("B"); // 배포됨(서버는 이제 B 를 줄 것이다).
  sw.setOnline(false); // 그러나 지금은 오프라인.

  const result = await sw.runFetch("/dist/app.js");
  assert.equal(result.intercepted, true);
  assert.equal(result.response.ok, true);
  assert.equal(
    result.response.version,
    "A",
    "오프라인에서는 네트워크를 못 타므로 설치 시점에 캐시된 판(A)으로 떨어져야 한다",
  );
});

test("P2-1 수리: 온라인 오류(500) 응답은 캐시된 정상 껍데기를 덮어쓰지 않는다", async () => {
  const sw = loadServiceWorker();
  await sw.runInstall(); // 정상(ok) 판이 캐시에 담긴다.
  sw.setServerError(500); // 다음부터 서버가 500 을 준다.

  const broken = await sw.runFetch("/index.html", { mode: "navigate" });
  assert.equal(
    broken.response.ok,
    false,
    "온라인에서는 그 500 응답을 그대로 돌려준다(브라우저 표준 동작) -- 이 호출 자체는 캐시를 덮어쓰지 않는지가 쟁점",
  );

  sw.setServerError(null); // 서버는 다시 정상으로 돌아왔다고 치고
  sw.setOnline(false); // 오프라인으로 전환해 캐시만 보게 만든다.
  const after = await sw.runFetch("/index.html", { mode: "navigate" });
  assert.equal(
    after.response.ok,
    true,
    "500 응답이 캐시된 정상 껍데기를 덮지 않았어야 한다(수리 전에는 500 이 캐시를 덮어 이 값이 false 가 됐다)",
  );
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
