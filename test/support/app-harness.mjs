// coder-task.md §3(P2-4): app.mjs(브라우저 엔트리)를 실제로 부팅해
// "배선"이 살아있는지 재는 시험 전용 통로. app.mjs 는 맨 아래에서 main()
// 을 즉시 실행하는 부수효과가 있고(에스빌드 엔트리라 그게 맞다,
// storage-mount.mjs 머리 주석 참고), 게다가 `import tokens from
// "../../spec/design-tokens.json"` 처럼 import attribute 없는 JSON
// import 를 쓴다(Node 의 네이티브 ESM 로더는 이걸 거부한다 -- 아래
// bundleApp 참고). 그래서 이 파일을 node --test 에서 직접 import 할 수
// 없다 -- E3(PR #7) 검토가 남긴 스모크(§3-3)와 같은 이유로, 이미 있는
// devDependency 인 esbuild 로 한 번 번들해서 부팅한다.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { IDBFactory } from "fake-indexeddb";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const appEntry = join(repoRoot, "src", "editor", "app.mjs");
const indexHtmlPath = join(repoRoot, "public", "index.html");

let cachedBundle = null;

// esbuild 는 Node 의 네이티브 로더와 달리 .json 을 그 자리에서 JS 값으로
// 인라인한다(로더 내장) -- 그래서 번들된 코드는 import attribute 문제가
// 없다. bundle:true 라 lexical 등도 함께 인라인된다(dev-server.mjs 가
// 실제 배포에 쓰는 것과 같은 옵션).
async function bundleApp() {
  if (cachedBundle) return cachedBundle;
  const result = await build({
    entryPoints: [appEntry],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  cachedBundle = result.outputFiles[0].text;
  return cachedBundle;
}

function installDomGlobals(dom) {
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.Text = dom.window.Text;
  globalThis.Range = dom.window.Range;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.CompositionEvent = dom.window.CompositionEvent;
  globalThis.InputEvent = dom.window.InputEvent;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.CustomEvent = dom.window.CustomEvent;
  // current-memo-pointer.mjs 는 전역 `localStorage` 를 바로 참조한다
  // (test/support/jsdom-env.mjs 와 같은 이유).
  globalThis.localStorage = dom.window.localStorage;
  // indexeddb-adapter.mjs 는 전역 `indexedDB` 를 바로 참조한다. 매
  // bootApp() 호출마다 새 IDBFactory 를 심어 시험 사이에 데이터가
  // 새지 않게 한다(fake-indexeddb/auto 의 전역 인스턴스 하나를 계속
  // 재사용하면 이전 시험이 만든 메모가 다음 시험에도 보인다).
  globalThis.indexedDB = new IDBFactory();
}

// public/index.html 실물(또는 htmlOverride, 시험이 id 를 일부러 지운
// 사본)을 jsdom 에 올리고, 그 위에서 app.mjs 번들을 실행한다. bootApp
// 이 리턴하기 전에 main() 이 동기 구간(grabElements/mountEditor/
// wireListNavigation)까지는 이미 실행된 상태다 -- list.refresh() 등
// 비동기 뒷부분은 호출부가 waitFor 로 기다려야 한다(app.mjs 자신도
// 안 기다린다, PRD §5b).
// seed(dom) 은 installDomGlobals 뒤 · 번들 import(= main() 실행) 전에
// 불린다 -- 이 틈에 (번들이 아닌) 진짜 src 모듈을 그대로 import 해
// indexedDB/localStorage 를 미리 채울 수 있다(카드 클릭·부팅 시 첫 화면
// 선택 같은 "이미 데이터가 있을 때" 시나리오 재현용).
export async function bootApp({ htmlOverride, seed } = {}) {
  const html = htmlOverride ?? (await readFile(indexHtmlPath, "utf8"));
  const dom = new JSDOM(html, { url: "http://localhost/" });
  installDomGlobals(dom);
  if (seed) await seed(dom);

  const code = await bundleApp();
  // data: URL 은 내용으로 캐시되는 ES 모듈 스펙시파이어라, 같은 문자열을
  // 두 번 import() 하면 두 번째는 재실행 없이 캐시된 모듈을 돌려준다(
  // main() 이 한 번만 돈다) -- 시험마다 새 부팅이 필요하므로 매번 다른
  // 논스를 꼬리에 붙여 스펙시파이어를 바꾼다.
  const nonce = `\n// app-harness nonce: ${Date.now()}-${Math.random()}`;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code + nonce, "utf8").toString("base64")}`;
  await import(dataUrl);

  return dom;
}

export async function waitFor(
  predicate,
  { timeout = 3000, interval = 10 } = {},
) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeout) {
      throw new Error("waitFor: 시간 안에 조건을 만족하지 못했다");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
