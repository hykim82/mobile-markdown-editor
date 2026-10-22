// HYK-304-pwa-installable-1 (coder-task.md §2 요구 3, §2 요구 6 오프라인
// 칸) + HYK-304-pages-deploy-1(캐시-즉시+백그라운드-갱신 전략, 하위 경로).
// public/sw.js(고전 서비스 워커 스크립트) 자체를 test/support/
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

  // 캐시-즉시-응답 전략(아래 P2-N1 ⓒ 칸들)도 "항상 백그라운드로 네트워크를
  // 다시 띄운다"는 점은 이전 네트워크 우선 판과 같다 -- 그래서 오프라인
  // 이어도(그 네트워크 시도가 실패할 뿐) fetchLog 는 비어있지 않다. 이
  // 네트워크 시도 자체가 "다음 방문에 새 판"(재배포 반영)의 전제다.
  assert.deepEqual(sw.fetchLog, [
    "https://example.test/dist/app.js",
    "https://example.test/manifest.json",
  ]);
});

test("P2-N1 ⓒ(캐시-즉시-응답): 캐시가 있으면 네트워크를 기다리지 않고 캐시된 응답을 즉시 돌려준다", async () => {
  const sw = loadServiceWorker({ serverVersion: "A" });
  await sw.runInstall(); // 판 A 로 캐시.
  sw.setServerVersion("B"); // 서버는 이미 새 판(B)을 주기 시작했다고 치고.
  sw.fetchLog.length = 0;

  const result = await sw.runFetch("/index.html", { mode: "navigate" });
  assert.equal(result.intercepted, true);
  assert.equal(
    result.response.version,
    "A",
    "온라인이어도 캐시가 있으면 '이번 방문'은 설치 시점 판(A)을 그대로 보여준다 -- 네트워크 응답을 기다리지 않는다는 뜻",
  );
  assert.deepEqual(
    sw.fetchLog,
    ["https://example.test/index.html"],
    "백그라운드 갱신을 위한 네트워크 시도 자체는 여전히 건다(다음 방문에 새 판이 반영되려면 필요)",
  );
});

test("P2-N1 ⓒ(재배포 재현, E17 1R P1 반대 방향): 판 A 설치 뒤 배포(판 B)가 있으면 재배포 직후 방문은 여전히 A, 그 다음 방문부터 B로 바뀐다", async () => {
  const sw = loadServiceWorker({ serverVersion: "A" });
  await sw.runInstall(); // 판 A 로 설치(캐시에도 A 판 응답이 담긴다).
  sw.setServerVersion("B"); // 배포: 서버가 이제 판 B 를 준다(sw.js 바이트는
  // 그대로다 -- 새 install 이벤트는 안 일어난다. 실제 배포와 같은 전제).

  const firstVisit = await sw.runFetch("/dist/app.js");
  assert.equal(
    firstVisit.response.version,
    "A",
    "재배포 직후 첫 방문: 캐시가 아직 A 판이므로 A 를 그대로 보여준다",
  );

  // 위 runFetch 가 event.settled(=백그라운드 네트워크 갱신)까지 기다린
  // 뒤에 돌아오므로, 이 시점에는 캐시가 이미 B 판으로 덮어써져 있어야
  // 한다 -- 그래서 "다음 방문"부터는 네트워크를 다시 안 기다려도 캐시가
  // 곧바로 B 를 내어준다(검토 1R 탐침과 같은 모양으로 7회 반복해 안정성을
  // 확인한다, 수리 전 "영영 옛 판" 버그의 반대 방향 재현).
  for (let visit = 2; visit <= 7; visit += 1) {
    const result = await sw.runFetch("/dist/app.js");
    assert.equal(result.intercepted, true);
    assert.equal(
      result.response.version,
      "B",
      `방문 ${visit}회차: 첫 방문의 백그라운드 갱신이 끝났으므로 캐시가 이미 새 판(B)이어야 한다`,
    );
  }
});

test("P2-N1 ⓒ와 오프라인 공존: 오프라인이면 배포(B)와 무관하게 설치 시점에 캐시된 판(A)으로 앱이 뜬다", async () => {
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
    "오프라인에서는 네트워크를 못 타므로(백그라운드 갱신도 실패) 설치 시점에 캐시된 판(A)으로 떨어져야 한다",
  );
});

test("온라인 오류(500)는 캐시를 덮지 않고, 캐시가 있으면 사용자도 그 오류를 보지 않는다", async () => {
  const sw = loadServiceWorker();
  await sw.runInstall(); // 정상(ok) 판이 캐시에 담긴다.
  sw.setServerError(500); // 다음부터 서버가 500 을 준다.

  const duringError = await sw.runFetch("/index.html", { mode: "navigate" });
  assert.equal(
    duringError.response.ok,
    true,
    "캐시-즉시-응답 전략에서는 캐시가 있는 한 500 응답 자체가 사용자에게 나가지 않는다 -- 캐시된 정상 껍데기가 그 자리를 대신한다",
  );

  // 직접 캐시를 들여다봐도 500 으로 덮어써지지 않았어야 한다(백그라운드
  // 갱신이 끝난 뒤 상태 -- runFetch 가 event.settled 까지 기다렸으므로
  // 이 시점에는 그 백그라운드 시도도 이미 끝나 있다).
  const cache = await sw.caches.open("mobile-markdown-editor-shell-v1");
  const cachedAfterError = await cache.match({
    url: "https://example.test/index.html",
  });
  assert.equal(
    cachedAfterError.ok,
    true,
    "500 응답이 캐시된 정상 껍데기를 덮지 않았어야 한다(수리 전에는 500 이 캐시를 덮어 이 값이 false 가 됐다)",
  );

  sw.setServerError(null); // 서버는 다시 정상으로 돌아왔다고 치고
  sw.setOnline(false); // 오프라인으로 전환해 캐시만 보게 만든다.
  const after = await sw.runFetch("/index.html", { mode: "navigate" });
  assert.equal(
    after.response.ok,
    true,
    "오프라인에서도 캐시는 여전히 정상 판이어야 한다",
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

// HYK-304-test-gaps-1(책임자 판정 2026-10-22 17:50 §3, E17 검토 2R
// P2-N2): 위 칸의 입력 pathname("/thing.js")은 APP_SHELL 밖이고
// mode도 navigate가 아니라서, sw.js 85행의 origin 가드 줄을 지워도
// 92행 APP_SHELL.includes 검사에서 이미 걸러져 intercepted:false가
// 그대로 나온다(가드가 실제로 막은 게 아니라 다른 조건이 우연히 같은
// 결과를 냈다) -- review.md §2 M5(가드 줄 제거 변이, 12/12 ok, RED
// 0건)가 그 증거다. 가드가 실제로 일하는 입력(APP_SHELL 경로 또는
// navigate 모드를 다른 출처로 보냄)으로 아래 두 칸을 추가한다.
test("외부 출처 + APP_SHELL 경로(P2-N2): 다른 출처의 /index.html 요청은 가로채지 않는다(같은 출처라면 걸릴 경로)", async () => {
  const sw = loadServiceWorker();
  await sw.runInstall();
  const result = await sw.runFetch("https://cdn.other-origin.test/index.html");
  assert.equal(
    result.intercepted,
    false,
    "pathname 은 APP_SHELL 안에 있지만 origin 이 달라서 가로채지 않아야 한다 -- origin 가드를 지우면 이 칸이 빨개진다(APP_SHELL_PATHNAMES.has 가 걸려 intercepted:true 가 됨)",
  );
});

test("외부 출처 + navigate 모드(P2-N2): 다른 출처의 탐색 요청은 가로채지 않는다(같은 출처라면 걸릴 경로)", async () => {
  const sw = loadServiceWorker();
  await sw.runInstall();
  const result = await sw.runFetch("https://cdn.other-origin.test/some-page", {
    mode: "navigate",
  });
  assert.equal(
    result.intercepted,
    false,
    "navigate 모드는 pathname 과 무관하게 가로채는 경로지만 origin 이 다르면 걸리지 않아야 한다 -- origin 가드를 지우면 이 칸이 빨개진다(navigate 분기가 먼저 걸려 intercepted:true 가 됨)",
  );
});

test("앱 껍데기 목록 밖의 같은 출처 요청은 가로채지 않는다(가짜 fetch 로그에 0회 -- 그대로 네트워크로 흘러간다는 뜻)", async () => {
  const sw = loadServiceWorker();
  await sw.runInstall();
  sw.fetchLog.length = 0;
  const result = await sw.runFetch("/some-other-path.txt");
  assert.equal(result.intercepted, false);
  assert.deepEqual(sw.fetchLog, []);
});

// HYK-304-pages-deploy-1 §2 요구 2ⓓ(P2-N3): cache.put 은 event.waitUntil
// 로 넘긴 약속 안에서 끝나야 한다 -- 밖에서 fire-and-forget 으로 두면
// 브라우저가 fetch 이벤트가 끝났다고 보고 워커를 재활용할 때 중간에
// 끊길 수 있다. 이 가짜 환경은 I/O가 없어 respondWith 응답과 cache.put
// 완료가 보통 같은 마이크로태스크 틱 안에서 함께 끝나버리므로, 그
// 순서를 직접 증명하려면 cache.put 을 시험이 붙잡아 둬야 한다
// (sw.pauseCachePut) -- dispatchFetch(runFetch 와 달리 settled 를 미리
// 기다리지 않는 원시 버전)로 "응답은 이미 나갔는데 cache.put 은 아직
// 묶여 있는" 상태를 만들고, 풀어 준 뒤에야 캐시가 바뀌는지 본다.
// 이 가짜 환경은 실제 I/O 지연이 없어(모든 가짜 fetch/cache 가 마이크로
// 태스크 한두 틱 안에 끝난다), "release 뒤 아무 await 나 하고 캐시를
// 본다"는 식의 시험은 waitUntil 연결 여부와 무관하게 통과해 버릴 수 있다
// (release() 가 큐에 올린 재개 작업이, 우리가 어떤 약속을 기다리든 그
// 사이에 끼어 먼저 돌 수 있어서다 -- 실측으로 확인). 그래서 "아직 안
// 풀었을 때 settled 가 진짜로 아직 안 끝나 있는가"를 Promise.race 로
// 직접 재는 쪽이 타이밍에 흔들리지 않는다: 이미 끝난 약속과 경합시키면
// 늘 그 이미 끝난 쪽이 이긴다(동일 틱에서 먼저 등록된 쪽이 이기는 V8
// 규칙), 아직 안 끝난 약속과 경합시키면 항상 방금 만든 비교용 약속이
// 이긴다.
function isStillPending(promise) {
  const pendingMarker = Symbol("pending");
  return Promise.race([promise, Promise.resolve(pendingMarker)]).then(
    (value) => value === pendingMarker,
  );
}

// HYK-304-pages-deploy-1 2R(coder-task.md §2 요구 1, P2-1 -- 검토 1R M3):
// 캐시-즉시-응답이 "캐시 있어도 네트워크부터 기다린다"로 망가지면 이 칸의
// `await event.response` 가 pauseCachePut 으로 묶인 networkUpdate 체인에
// 걸려 끝나지 않는다(releaseCachePut 을 호출하기 전에 응답을 기다리는
// 순서라서다). timeout 옵션으로 "멈춤" 대신 "짧은 시간 안의 실패"로
// 바꾼다 -- 값 근거: 이 칸은 정상 판에서 2ms 안쪽으로 끝난다(위 node
// --test 측정), 5000ms 면 정상 판 여유는 넉넉하고 멈추는 변이는 CI
// 기본 잡 제한(실질 무제한)까지 기다리지 않는다.
test(
  "P2-N3: cache.put 은 event.waitUntil 로 넘긴 약속 안에서 일어난다(waitUntil 자체가 불렸고, 그 약속이 끝나기 전엔 캐시가 안 바뀐다)",
  { timeout: 5000 },
  async () => {
    const sw = loadServiceWorker({ serverVersion: "A" });
    await sw.runInstall();
    sw.setServerVersion("B");
    const releaseCachePut = sw.pauseCachePut(); // cache.put 을 묶어 둔다.

    const event = sw.dispatchFetch("/dist/app.js");
    assert.equal(event.responded, true, "respondWith 가 불렸어야 한다");
    assert.equal(
      event.waitUntilCalled,
      true,
      "respondToShellRequest 는 event.waitUntil 을 호출해야 한다 -- 호출 자체가 없으면(fire-and-forget) 이 값이 false 로 남는다",
    );

    const response = await event.response; // 사용자에게 나가는 응답(캐시, 여전히 A).
    assert.equal(
      response.version,
      "A",
      "cache.put 이 묶여 있어도 캐시-즉시-응답(cache.match)은 그와 무관하게 바로 나간다",
    );

    assert.equal(
      await isStillPending(event.settled),
      true,
      "cache.put 을 아직 풀지 않았으므로 event.waitUntil 로 넘긴 약속도 아직 안 끝나 있어야 한다 -- cache.put 이 waitUntil '밖'에서 일어났다면(또는 waitUntil 에 엉뚱한, 이미 끝난 약속을 넘겼다면) settled 는 이 시점에 이미 끝나 있을 것이다",
    );

    releaseCachePut(); // 이제 cache.put 이 끝나도록 풀어 준다.
    await event.settled; // event.waitUntil 로 넘긴 그 약속이 끝나길 기다린다.

    const cache = await sw.caches.open("mobile-markdown-editor-shell-v1");
    const afterRelease = await cache.match({
      url: "https://example.test/dist/app.js",
    });
    assert.equal(
      afterRelease.version,
      "B",
      "cache.put 을 풀고 event.settled 가 끝난 뒤에는 캐시가 새 판(B)으로 갱신돼 있어야 한다",
    );
  },
);

// HYK-304-pages-deploy-1 §2 요구 2ⓑ(하위 경로): GitHub Pages 는
// https://hykim82.github.io/mobile-markdown-editor/ 처럼 저장소 이름이
// 붙은 하위 경로에 사이트를 올린다(추론 -- 실제 주소는 못 쟀다). 등록
// scope 가 "/" 대신 그 하위 경로가 되는 환경을 basePath 로 재현해, 앱
// 껍데기 경로 전부가 그 하위 경로 "안"으로 계산되는지와, 하위 경로
// "밖"(예: 다른 사이트의 루트 "/dist/app.js")은 여전히 가로채지 않는지를
// 값으로 잰다.
test("하위 경로(P2-N1 ⓑ): GitHub Pages 하위 경로에서도 앱 껍데기 전체가 그 경로 기준으로 캐시되고 응답된다", async () => {
  const sw = loadServiceWorker({
    origin: "https://hykim82.github.io",
    basePath: "/mobile-markdown-editor/",
  });
  await sw.runInstall();

  const cache = await sw.caches.open("mobile-markdown-editor-shell-v1");
  for (const path of APP_SHELL) {
    const subPathUrl =
      "https://hykim82.github.io/mobile-markdown-editor" +
      (path === "/" ? "/" : path);
    const hit = await cache.match({ url: subPathUrl });
    assert.ok(hit, `하위 경로 캐시에 ${subPathUrl} 가 있어야 한다`);
  }

  const bundle = await sw.runFetch("/mobile-markdown-editor/dist/app.js");
  assert.equal(bundle.intercepted, true);
  assert.equal(bundle.response.ok, true);

  const navigate = await sw.runFetch("/mobile-markdown-editor/", {
    mode: "navigate",
  });
  assert.equal(navigate.intercepted, true);
  assert.equal(navigate.response.ok, true);
});

test("하위 경로(P2-N1 ⓑ): 등록 scope 밖의 같은 출처 경로(예: 사이트 루트)는 가로채지 않는다", async () => {
  const sw = loadServiceWorker({
    origin: "https://hykim82.github.io",
    basePath: "/mobile-markdown-editor/",
  });
  await sw.runInstall();
  sw.fetchLog.length = 0;

  // "/dist/app.js"(하위 경로 접두 없이, 즉 다른 사이트의 루트에 있는
  // 동명 자원)는 scope 밖이라 이 서비스 워커가 알고 있는 APP_SHELL 과
  // pathname 이 다르다 -- 가로채지 않아야 한다.
  const result = await sw.runFetch("/dist/app.js");
  assert.equal(result.intercepted, false);
  assert.deepEqual(sw.fetchLog, []);
});

// HYK-304-pages-deploy-1 2R(coder-task.md §2 요구 4, P2-4): sw.js 의
// INDEX_URL 은 self.registration.scope 기준 상대 경로(new URL("index.html",
// SCOPE))로 계산된다 -- 하위 경로(GitHub Pages)에서도 그 하위 경로의
// index.html 로 떨어져야 한다. INDEX_URL 을 "/index.html"(루트 절대 경로)
// 로 되돌리는 변이가 걸리는 칸: 하위 경로 + 오프라인 + 캐시에 없는 탐색
// 요청(앱 껍데기 밖의 딥링크 경로)을 보내 staleWhileRevalidate 의 마지막
// 폴백(caches.match(INDEX_URL))이 "하위 경로의" index.html 로 떨어지는지
// 값으로 잰다. INDEX_URL 이 루트로 되돌려지면 하위 경로에는 그 캐시
// 엔트리가 없어(설치 시 "/mobile-markdown-editor/index.html"로 캐시됐지,
// "/index.html"로는 캐시되지 않았다) 폴백이 undefined 가 되고 이 칸이
// 빨개진다.
test("하위 경로 오프라인 폴백(P2-4): 캐시에 없는 딥링크를 오프라인으로 탐색하면 하위 경로의 index.html 로 떨어진다(INDEX_URL 을 루트로 되돌리는 변이 RED)", async () => {
  const sw = loadServiceWorker({
    origin: "https://hykim82.github.io",
    basePath: "/mobile-markdown-editor/",
  });
  await sw.runInstall(); // 하위 경로 기준으로 APP_SHELL(index.html 포함) 캐시.
  sw.setOnline(false); // 오프라인 -- networkUpdate 도 실패한다.

  const result = await sw.runFetch("/mobile-markdown-editor/some/deep/route", {
    mode: "navigate",
  });
  assert.equal(
    result.intercepted,
    true,
    "앱 껍데기 밖의 딥링크라도 navigate 모드면 가로채야 한다",
  );
  // 3R(검토 2R P1-1 과 같은 결의 지적, P2-3): INDEX_URL 이 루트로 되돌려지면
  // caches.match(INDEX_URL) 이 undefined 를 돌려줘 result.response 자체가
  // undefined 가 된다 -- 그 상태에서 바로 result.response.ok 를 읽으면
  // "Cannot read properties of undefined" TypeError 로 죽어, 이 칸이
  // 설계한 단언 문구가 아니라 엉뚱한 메시지로 빨개진다. 응답이 존재하는지
  // 먼저 단언해 변이가 "폴백 응답이 없다"는 설계한 문구로 떨어지게 한다.
  assert.ok(
    result.response,
    "캐시에 없는 딥링크라도 오프라인이면 하위 경로의 index.html 로 폴백 응답이 있어야 한다 -- INDEX_URL 이 루트로 되돌려지면 폴백 응답이 undefined 가 되어 이 칸이 깨진다",
  );
  assert.equal(result.response.ok, true, "폴백 응답이 ok 여야 한다");
  assert.equal(
    result.response.url,
    "https://hykim82.github.io/mobile-markdown-editor/index.html",
    "폴백 응답은 하위 경로의 index.html 이어야 한다(사이트 루트의 index.html 이 아니다)",
  );
});
