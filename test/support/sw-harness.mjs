// HYK-304-pwa-installable-1 (coder-task.md §2 요구 3, "가짜 caches·fetch"):
// public/sw.js 는 고전(non-module) 서비스 워커 스크립트라 import 로 못
// 불러온다(self/caches/fetch 가 전역이어야 하는 전제) -- test/support/
// app-harness.mjs 가 esbuild+jsdom 으로 app.mjs 를 부팅하는 것과 같은
// 이유로, 여기서는 node:vm 샌드박스에 가짜 self/caches/fetch 를 심고
// 그 전역 위에서 sw.js 원문을 그대로 실행한다(코드를 고치거나 베끼지
// 않는다 -- 실제 파일을 읽어 그대로 돌린다).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const swPath = join(here, "..", "..", "public", "sw.js");

// 실 Response 의 clone()/ok 만 흉내 낸 최소 가짜 -- body 스트림은 이
// 시험들이 들여다보지 않는다(캐시 적중 여부·호출 횟수만 잰다). `version`
// 은 실제 Response API 에 없는 시험 전용 칸 -- "서버가 지금 어느 배포
// 판을 주고 있었는지"를 캐시에 저장된 뒤에도 구분해 재기 위해 둔다
// (coder-task.md §2 요구 1, P1 업데이트 함정 재현/수리 확인 칸).
class FakeResponse {
  constructor({ url, ok = true, status = 200, version } = {}) {
    this.url = url;
    this.ok = ok;
    this.status = status;
    this.version = version;
  }
  clone() {
    return new FakeResponse({
      url: this.url,
      ok: this.ok,
      status: this.status,
      version: this.version,
    });
  }
}

// 실제 Cache API 는 addAll(["/dist/app.js"]) 처럼 origin-상대 경로를
// 줘도 서비스 워커 자신의 origin 에 맞춰 절대 URL로 정규화해 저장하고,
// fetch 이벤트의 request.url(언제나 절대 URL)로 조회할 때도 같은 정규화를
// 거친다 -- 그래서 상대 경로로 넣고 절대 URL로 찾아도 맞아야 한다. 이
// 가짜도 같은 정규화를 해야 install(상대 경로 배열)과 실제 fetch 요청
// (절대 URL)이 같은 자원으로 맞아떨어진다.
function requestUrl(request, origin) {
  const raw = typeof request === "string" ? request : request.url;
  return new URL(raw, origin).href;
}

// caches.open()/keys()/delete() = 실제 CacheStorage 와 같은 모양(이름별
// Cache 인스턴스를 들고 있다가 통째로 지울 수 있다 -- activate 의 "옛 캐시
// 삭제" 단언이 이 모양에 의존한다). 최상위 caches.match() 는 모든 캐시를
// 순서대로 뒤진다(실제 CacheStorage.match 의 기본 동작과 같다 -- sw.js
// 의 respondToNavigation 폴백이 이 전역 조회에 의존한다).
function createFakeCacheStorage(fetchImpl, origin) {
  const named = new Map();
  function makeCache() {
    const store = new Map();
    return {
      async match(request) {
        return store.get(requestUrl(request, origin));
      },
      async put(request, response) {
        store.set(requestUrl(request, origin), response);
      },
      async addAll(requests) {
        for (const request of requests) {
          const url = requestUrl(request, origin);
          const response = await fetchImpl({ url, mode: "same-origin" });
          if (!response.ok) {
            throw new Error(`sw-harness fake addAll: fetch failed for ${url}`);
          }
          store.set(url, response);
        }
      },
      size() {
        return store.size;
      },
    };
  }
  return {
    async open(name) {
      if (!named.has(name)) named.set(name, makeCache());
      return named.get(name);
    },
    async keys() {
      return [...named.keys()];
    },
    async delete(name) {
      return named.delete(name);
    },
    async match(request) {
      for (const cache of named.values()) {
        const hit = await cache.match(request);
        if (hit) return hit;
      }
      return undefined;
    },
  };
}

function makeLifecycleEvent() {
  let waitUntilPromise = Promise.resolve();
  return {
    waitUntil(promise) {
      waitUntilPromise = promise;
    },
    get settled() {
      return waitUntilPromise;
    },
  };
}

function makeFetchEvent(request) {
  const normalized =
    typeof request === "string"
      ? { url: request, mode: "same-origin" }
      : request;
  let responsePromise;
  return {
    request: normalized,
    respondWith(promise) {
      responsePromise = promise;
    },
    get responded() {
      return responsePromise !== undefined;
    },
    get response() {
      return responsePromise;
    },
  };
}

// origin = 가짜 self.location.origin(동일 출처 요청 판정의 기준). online
// = false 로 만들면 fetchImpl 이 전부 reject 한다(오프라인 재현).
// serverVersion = 지금 "서버가 주는" 배포 판 표지(P1 업데이트 함정 재현용
// -- setServerVersion() 으로 재배포를 흉내낼 수 있다). 캐시에 응답이
// 저장된 뒤에도 그 응답이 담고 있던 version 값은 안 바뀌므로, 온라인
// 재요청이 "새 판을 받아오는지"와 오프라인이 "캐시된 옛 판에 머무는지"를
// 값으로 구분해 잴 수 있다.
export function loadServiceWorker({
  origin = "https://example.test",
  online = true,
  serverVersion = "A",
} = {}) {
  const listeners = {};
  let isOnline = online;
  let currentServerVersion = serverVersion;
  // null = 정상 응답. 숫자(예: 500)면 그 상태코드로 ok:false 응답을 준다
  // (P2-1 수리 확인 칸 -- "온라인 오류 응답이 캐시된 정상 껍데기를
  // 덮지 않는다").
  let serverErrorStatus = null;
  const fetchLog = [];

  async function fakeFetch(input) {
    const url = requestUrl(input, origin);
    fetchLog.push(url);
    if (!isOnline) {
      throw new TypeError("sw-harness: simulated offline network failure");
    }
    if (serverErrorStatus !== null) {
      return new FakeResponse({
        url,
        ok: false,
        status: serverErrorStatus,
        version: currentServerVersion,
      });
    }
    return new FakeResponse({ url, ok: true, version: currentServerVersion });
  }

  const fakeCaches = createFakeCacheStorage(fakeFetch, origin);
  const sandbox = {
    self: {
      location: { origin },
      addEventListener(type, handler) {
        listeners[type] = handler;
      },
    },
    caches: fakeCaches,
    fetch: fakeFetch,
    URL: globalThis.URL,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(swPath, "utf8"), sandbox, { filename: swPath });

  return {
    listeners,
    caches: fakeCaches,
    fetchLog,
    setOnline(value) {
      isOnline = value;
    },
    setServerVersion(value) {
      currentServerVersion = value;
    },
    setServerError(status) {
      serverErrorStatus = status;
    },
    async runInstall() {
      const event = makeLifecycleEvent();
      listeners.install(event);
      await event.settled;
      return event;
    },
    async runActivate() {
      const event = makeLifecycleEvent();
      listeners.activate(event);
      await event.settled;
      return event;
    },
    // path 는 origin 과 합쳐 전체 URL 이 된다(예: "/index.html"). 검토 1R
    // P2-4 수리: path 가 이미 절대 URL(스킴 포함, 예:
    // "https://cdn.other-origin.test/thing.js")이면 origin 을 앞에 덧붙여
    // 깨뜨리지 않고 그 값 그대로 쓴다 -- 수리 전에는 origin + path 로
    // 뭉개져 "다른 출처 입력"이 실제로는 한 번도 들어가지 않았다(칸
    // 이름이 말하는 입력이 그대로 하니스에 들어가게 하는 것이 이 수리의
    // 목적).
    async runFetch(path, { mode = "same-origin" } = {}) {
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(path) ? path : origin + path;
      const event = makeFetchEvent({ url, mode });
      listeners.fetch(event);
      if (!event.responded) return { intercepted: false };
      return { intercepted: true, response: await event.response };
    },
  };
}
