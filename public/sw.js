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

// 검토 1R P1 수리: 탐색뿐 아니라 앱 껍데기 전부(번들·manifest·아이콘)를
// 네트워크 우선으로 바꾼다. 이전 판은 번들·manifest·아이콘을 "캐시
// 우선"으로만 줬는데, 그러면 캐시 판 이름(CACHE_VERSION, 손으로 올리는
// 상수)을 올리지 않는 한 새로 배포한 번들이 이미 설치된 클라이언트에
// 영영 안 보인다 -- 서비스 워커 자신의 바이트가 안 바뀌면 새 install 자체가
// 안 일어나므로(브라우저 스펙), v1 캐시가 그대로 남아 "새 index.html +
// 옛 번들"에 영구히 갇힌다(검토 1R 탐침 재현: 배포 뒤 온라인 7회 방문해도
// 번들 A 유지). 온라인일 때는 매번 네트워크를 다시 타서 최신 응답을 쓰고
// 캐시도 그 응답으로 갱신하므로, "손으로 올리는 상수"에만 기대지 않고도
// 다음 온라인 방문에서 바로 새 판이 보인다. 네트워크가 실패(오프라인)할
// 때만 캐시(설치 시점 또는 마지막으로 온라인에서 받은 판)로 떨어진다.
//
// 검토 1R P2-1 수리: 응답이 ok(2xx)일 때만 cache.put 한다 -- 서버가 오류
// 응답(예: 500)을 줘도 그 응답으로 캐시된 정상 껍데기를 덮어쓰지 않는다.
// 덮어썼다면 다음 오프라인 방문이 그 오류 응답을 영구히 돌려주는 사고가
// 난다.
function respondToShellRequest(request) {
  return fetch(request)
    .then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    })
    .catch(() =>
      caches.match(request).then((cached) => {
        if (cached) return cached;
        if (request.mode === "navigate") return caches.match("/index.html");
        return undefined;
      }),
    );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(respondToShellRequest(request));
    return;
  }

  if (APP_SHELL.includes(url.pathname)) {
    event.respondWith(respondToShellRequest(request));
  }
});
