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
// HYK-304-pages-deploy-1 (coder-task.md §2 요구 2ⓓ, P2-N3): putGate 는
// cache.put 의 완료 시점을 시험이 직접 붙잡아 둘 수 있게 하는 문이다 --
// 기본은 이미 열려 있어(resolved) 평소 시험에는 영향이 없다. P2-N3 칸
// (cache.put 이 event.waitUntil 로 넘긴 약속 "안"에서 끝난다)은 respondWith
// 로 나간 응답과 cache.put 완료 사이의 순서를 실제로 갈라 봐야 증명되는데,
// 이 가짜 환경은 전부 같은 마이크로태스크 틱 안에서 돌아(실제 I/O가
// 없음) 그 둘이 "항상 거의 동시에" 끝나버린다 -- gate 로 cache.put 을
// 시험이 원하는 시점까지 묶어 두면 그 순서를 결정적으로 재현할 수 있다.
function createFakeCacheStorage(fetchImpl, origin, putGate) {
  const named = new Map();
  function makeCache() {
    const store = new Map();
    return {
      async match(request) {
        return store.get(requestUrl(request, origin));
      },
      async put(request, response) {
        await putGate.promise;
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

// HYK-304-pages-deploy-1 (coder-task.md §2 요구 2ⓓ, P2-N3): fetch 이벤트도
// install/activate 처럼 waitUntil 을 받을 수 있어야 한다 -- sw.js 의
// cache.put 은 waitUntil 로 넘긴 백그라운드 갱신 약속 "안에서" 일어나고,
// 그 약속이 실제로 "settled"(아래 getter) 되기 전까지는 cache.put 이 아직
// 안 끝났을 수 있다(P2-N3 칸이 이 구분에 의존한다 -- respondWith 로 돌려준
// 응답은 즉시 받아도 캐시 갱신은 그 뒤에 끝날 수 있다는 것이 바로 이
// 전략의 핵심이다).
function makeFetchEvent(request) {
  const normalized =
    typeof request === "string"
      ? { url: request, mode: "same-origin" }
      : request;
  let responsePromise;
  let waitUntilPromise = Promise.resolve();
  return {
    request: normalized,
    respondWith(promise) {
      responsePromise = promise;
    },
    waitUntil(promise) {
      waitUntilPromise = promise;
    },
    get responded() {
      return responsePromise !== undefined;
    },
    get response() {
      return responsePromise;
    },
    get settled() {
      return waitUntilPromise;
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
// HYK-304-pages-deploy-1 (coder-task.md §2 요구 2ⓑ): basePath 는 서비스
// 워커의 등록 scope(=self.registration.scope, sw.js 가 앱 껍데기 경로 전체를
// 계산하는 기준)를 흉내낸다 -- 기본값 "/"(개발 서버 루트) 외에
// "/mobile-markdown-editor/" 같은 GitHub Pages 하위 경로도 같은 가짜로
// 재현할 수 있어야 "루트 절대 경로 하드코딩을 상대 경로로 바꾼" 수리가
// 두 환경 모두에서 실제로 맞는지 이 하니스로 확인할 수 있다.
// 네트워크 상태(온라인 여부·"서버가 지금 주는" 배포 판·강제 오류 상태코드)를
// fakeFetch 와 바깥의 setOnline()/setServerVersion()/setServerError() 가
// 같은 객체로 공유한다 -- loadServiceWorker 본문에서 이 모양을 그대로
// 조립하면 함수가 너무 길어져(eslint max-lines-per-function) 따로 뺐다.
function createNetworkState({ online, serverVersion }) {
  return {
    online,
    serverVersion,
    // null = 정상 응답. 숫자(예: 500)면 그 상태코드로 ok:false 응답을 준다
    // (P2-1 수리 확인 칸 -- "온라인 오류 응답이 캐시된 정상 껍데기를
    // 덮지 않는다").
    errorStatus: null,
  };
}

function createFakeFetch({ origin, state }) {
  const fetchLog = [];
  async function fakeFetch(input) {
    const url = requestUrl(input, origin);
    fetchLog.push(url);
    if (!state.online) {
      throw new TypeError("sw-harness: simulated offline network failure");
    }
    if (state.errorStatus !== null) {
      return new FakeResponse({
        url,
        ok: false,
        status: state.errorStatus,
        version: state.serverVersion,
      });
    }
    return new FakeResponse({ url, ok: true, version: state.serverVersion });
  }
  return { fakeFetch, fetchLog };
}

// sw.js 원문을 가짜 self/caches/fetch 전역 위에서 그대로 실행하고
// listeners(install/activate/fetch 핸들러)를 돌려준다.
function bootServiceWorkerSandbox({ origin, scope, fakeCaches, fakeFetch }) {
  const listeners = {};
  const sandbox = {
    self: {
      location: { origin },
      registration: { scope },
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
  return listeners;
}

export function loadServiceWorker({
  origin = "https://example.test",
  basePath = "/",
  online = true,
  serverVersion = "A",
} = {}) {
  const scope = new URL(basePath, origin).href;
  const networkState = createNetworkState({ online, serverVersion });
  const { fakeFetch, fetchLog } = createFakeFetch({
    origin,
    state: networkState,
  });
  const putGate = { promise: Promise.resolve() };
  const fakeCaches = createFakeCacheStorage(fakeFetch, origin, putGate);
  const listeners = bootServiceWorkerSandbox({
    origin,
    scope,
    fakeCaches,
    fakeFetch,
  });

  return {
    listeners,
    caches: fakeCaches,
    fetchLog,
    setOnline(value) {
      networkState.online = value;
    },
    setServerVersion(value) {
      networkState.serverVersion = value;
    },
    setServerError(status) {
      networkState.errorStatus = status;
    },
    // cache.put 을 직접 호출 쪽에서 막아 둔다(기본은 열려 있음) --
    // 반환한 함수를 부르면 그 뒤로 대기 중이던 모든 cache.put 이 함께
    // 풀린다(P2-N3 칸 전용, 위 createFakeCacheStorage 주석 참고).
    pauseCachePut() {
      let release;
      putGate.promise = new Promise((resolve) => {
        release = resolve;
      });
      return release;
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
    //
    // 가공하지 않은 fetch 이벤트를 돌려준다(응답·waitUntil 어느 것도
    // 미리 기다리지 않음) -- P2-N3(cache.put 이 waitUntil 안에서 끝남)
    // 처럼 "응답은 나갔는데 백그라운드 갱신은 아직"인 순간을 직접 들여다
    // 봐야 하는 시험 전용. 보통은 아래 runFetch 를 쓴다.
    dispatchFetch(path, { mode = "same-origin" } = {}) {
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(path) ? path : origin + path;
      const event = makeFetchEvent({ url, mode });
      listeners.fetch(event);
      return event;
    },
    // path 는 origin 과 합쳐 전체 URL 이 된다(예: "/index.html"). 검토 1R
    // P2-4 수리: path 가 이미 절대 URL(스킴 포함, 예:
    // "https://cdn.other-origin.test/thing.js")이면 origin 을 앞에 덧붙여
    // 깨뜨리지 않고 그 값 그대로 쓴다 -- 수리 전에는 origin + path 로
    // 뭉개져 "다른 출처 입력"이 실제로는 한 번도 들어가지 않았다(칸
    // 이름이 말하는 입력이 그대로 하니스에 들어가게 하는 것이 이 수리의
    // 목적).
    //
    // HYK-304-pages-deploy-1(P2-N1 ⓒ, 캐시-즉시+뒤-갱신): 응답뿐 아니라
    // event.settled(= event.waitUntil 로 넘긴 백그라운드 갱신 약속)까지
    // 기다린 뒤에 반환한다 -- "방문"을 하나의 완결된 단위로 다루어, 같은
    // 시험 안에서 순서대로 여러 번 호출하면(재배포 재현 등) 앞 방문의
    // 캐시 갱신이 다음 방문이 시작되기 전에 반드시 끝나 있다는 것을
    // 보장한다(안 그러면 두 비동기 체인이 경합해 결과가 들쭉날쭉해진다).
    async runFetch(path, opts) {
      const event = this.dispatchFetch(path, opts);
      if (!event.responded) return { intercepted: false };
      const response = await event.response;
      await event.settled;
      return { intercepted: true, response };
    },
  };
}
