// HYK-304-pwa-installable-1 (coder-task.md §2 요구 3): 오프라인에서 앱
// 껍데기를 띄우는 서비스 워커.
//
// ⛔IndexedDB·메모 데이터 무접촉: 이 파일은 indexedDB 를 전혀 참조하지
// 않는다(아래 전체에서 그 낱말이 없다 -- grep 으로 직접 확인 가능).
// 메모는 IndexedDB(이 워커 밖, src/storage/**)에 그대로 남아 오프라인과
// 무관하다.
// ⛔외부 출처 요청 가로채기 0: fetch 핸들러 맨 앞에서 origin 을 확인하고
// 다르면 아무것도 하지 않는다(가로채지 않음 -- 브라우저 기본 동작으로
// 넘어간다).
// ⛔푸시·백그라운드 동기화·알림 권한 0(PRD "요구 권한 없음") -- 이 파일은
// push/sync 이벤트 리스너를 등록하지 않는다.
const CACHE_VERSION = "v1";
const CACHE_NAME = "mobile-markdown-editor-shell-" + CACHE_VERSION;

// HYK-304-pages-deploy-1 (coder-task.md §2 요구 2ⓑ, 하위 경로): 이 서비스
// 워커는 GitHub Pages 하위 경로(예: /mobile-markdown-editor/)와 개발
// 서버 루트(/) 양쪽에서 그대로 등록된다(src/editor/sw-register.mjs 가
// scope 를 넘기지 않으므로 기본 scope = 이 스크립트가 있는 디렉터리).
// self.registration.scope 는 등록 즉시(설치 전에도) 그 디렉터리의 절대
// URL 을 준다 -- 이 값을 기준으로 앱 껍데기 경로를 상대로 계산하면
// "/..." 로 하드코딩한 루트 절대 경로 없이 두 환경 모두에서 맞는다.
const SCOPE = self.registration.scope;
const APP_SHELL_RELATIVE = [
  "",
  "index.html",
  "dist/app.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon-180.png",
];
const APP_SHELL = APP_SHELL_RELATIVE.map((path) => new URL(path, SCOPE).href);
const APP_SHELL_PATHNAMES = new Set(
  APP_SHELL.map((href) => new URL(href).pathname),
);
const INDEX_URL = new URL("index.html", SCOPE).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
});

// 판 교체(캐시 이름의 버전 올림) 시 옛 캐시를 지운다 -- 안 지우면 오리진당
// 캐시 저장소가 계속 쌓인다(coder-task.md §2 요구 3 "캐시 판 교체" 근거).
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      ),
  );
});

// HYK-304-pages-deploy-1 (coder-task.md §2 요구 2ⓒ, P2-N1 전략 ⓒ):
// 캐시-즉시-응답 + 백그라운드 갱신(stale-while-revalidate). 이전 판
// (네트워크 우선, HYK-304-pwa-installable-1-r2 P1 수리)은 온라인일 때마다
// 네트워크 응답을 "기다려" 첫 화면을 그렸다 -- 네트워크가 느리면 그만큼
// 첫 화면도 늦어진다(PRD §5b "실행→입력 1초" NFR 과 충돌 가능). 이번 판은
// 캐시가 있으면 그것을 즉시 돌려주고(첫 화면 지연 0), 같은 요청에 대한
// 네트워크 응답도 별도로 기다려 ok 면 캐시를 그걸로 덮어쓴다 -- "이번
// 방문"은 옛 판을 보더라도 캐시가 새 판으로 바뀌어 있으므로 "다음 방문"
// 부터는 새 판이 캐시에서 바로 나온다(E17 1R P1 "영영 옛 판에 갇힘"과는
// 반대로, 여기서는 최소 한 번의 후속 방문마다 갱신이 들어온다 -- 아래
// service-worker.test.mjs 의 재배포 재현 칸). 캐시가 아예 없으면(첫 설치
// 전 등) 네트워크 응답을 기다린다 -- 그마저 실패하면(오프라인) 다시 캐시를
// 찾고, 탐색 요청이면 index.html 로 떨어진다.
//
// P2-N3(coder-task.md §2 요구 2ⓓ): cache.put 은 반드시 event.waitUntil 로
// 넘긴 약속 "안에서" 완료된다(아래 networkUpdate 가 event.waitUntil 인자
// 그 자체다) -- waitUntil 밖에서 fire-and-forget 으로 두면 브라우저가 fetch
// 이벤트가 끝났다고 보고 워커를 재활용할 때 그 put 이 완료되기 전에
// 끊길 수 있다(스펙: waitUntil 로 안 묶인 비동기 작업은 수명 보장이 없다).
function staleWhileRevalidate(request) {
  const networkUpdate = fetch(request)
    .then((response) => {
      if (!response.ok) return response;
      const copy = response.clone();
      return caches
        .open(CACHE_NAME)
        .then((cache) => cache.put(request, copy))
        .then(() => response);
    })
    .catch(() => undefined);

  const respondPromise = caches.match(request).then((cached) => {
    if (cached) return cached;
    return networkUpdate.then((response) => {
      if (response) return response;
      if (request.mode === "navigate") return caches.match(INDEX_URL);
      return undefined;
    });
  });

  return { respondPromise, networkUpdate };
}

function respondToShellRequest(event, request) {
  const { respondPromise, networkUpdate } = staleWhileRevalidate(request);
  event.respondWith(respondPromise);
  event.waitUntil(networkUpdate);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    respondToShellRequest(event, request);
    return;
  }

  if (APP_SHELL_PATHNAMES.has(url.pathname)) {
    respondToShellRequest(event, request);
  }
});
