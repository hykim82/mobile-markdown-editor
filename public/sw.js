// HYK-304-pwa-installable-1 (coder-task.md §2 요구 3): 오프라인에서 앱
// 껍데기를 띄우는 서비스 워커. public/ 이 esbuild dev-server.mjs 의
// servedir 최상위라 이 파일의 등록 scope 는 앱 전체("/")다.
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
const APP_SHELL = [
  "/",
  "/index.html",
  "/dist/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon-180.png",
];

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

// 탐색(문서) 요청 = 네트워크 우선. 캐시만 우선이면 새 판을 배포해도 이미
// 설치된 앱이 영원히 옛 index.html 을 보게 된다("업데이트가 영영 안
// 보이는" 위험, coder-task.md §2 요구 3) -- 네트워크가 성공하면 그 응답을
// 쓰고 캐시도 최신으로 갱신한다. 네트워크가 실패(오프라인)할 때만 캐시로
// 떨어진다.
function respondToNavigation(request) {
  return fetch(request)
    .then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      return response;
    })
    .catch(() =>
      caches
        .match(request)
        .then((cached) => cached || caches.match("/index.html")),
    );
}

// 그 외 앱 껍데기 자원(번들·manifest·아이콘) = 캐시 우선. 오프라인에서도
// 지연 없이 뜬다. 캐시에 없으면 네트워크에서 받아 캐시를 채운다.
function respondToShellAsset(request) {
  return caches.match(request).then((cached) => {
    if (cached) return cached;
    return fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      return response;
    });
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(respondToNavigation(request));
    return;
  }

  if (APP_SHELL.includes(url.pathname)) {
    event.respondWith(respondToShellAsset(request));
  }
});
