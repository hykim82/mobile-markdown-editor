// coder-task.md §0-2-⑶/⑷: POC는 "같은 탭 하드 네비게이션"으로는 IndexedDB
// 를 못 깨서(방법이 약함) 크래시 원자성을 증명하지 못했다. 이 스크립트는
// 실제 Chrome DevTools Protocol로 ⓐ Storage.overrideQuotaForOrigin 로
// 저장공간 부족을 «실제로» 재현하고 ⓑ Page.crash() 로 탭 렌더러 프로세스를
// «실제로» 강제 종료한 뒤 재접속해 데이터가 살아있는지 확인한다.
// dev 서버(§1)를 이 스크립트가 직접 띄우고 끝에 반드시 PID로 끈다.
//
// 실행: node scripts/storage-crash-quota-check.mjs
// (사람이 손으로 치는 1b_exec_line 과는 별개 -- 이건 CDP 로 «강제 종료»를
// 실제로 일으키는 보강 확인이다.)
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const CHROME_PATH =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CDP_PORT = 9333;
const APP_PORT = 5173;
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

function log(...args) {
  console.log("[crash-quota-check]", ...args);
}

async function startDevServer() {
  const child = spawn(process.execPath, ["src/editor/dev-server.mjs"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let out = "";
    const onData = (chunk) => {
      out += chunk.toString();
      if (out.includes("[dev] PC:")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
    setTimeout(
      () => reject(new Error("dev server did not start in time")),
      10000,
    );
  });
  return child;
}

function stopDevServer(child) {
  const pid = child.pid;
  child.kill();
  log(`dev 서버 종료 요청: PID ${pid}`);
  return pid;
}

// 두 확인(크래시/쿼터)은 각자 «새 프로필»로 별도 Chrome 인스턴스를 띄운다
// -- 같은 프로필을 같이 쓰면 크래시 확인이 IndexedDB 에 남긴 데이터가
// 쿼터 확인의 "얼마나 채워야 넘치는가" 계산을 오염시킨다(실측: 같이
// 쓰니 쿼터 초과가 재현되다 안 되다 했다).
async function launchChrome(profileSuffix) {
  const child = spawn(
    CHROME_PATH,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      "--remote-allow-origins=*",
      "--user-data-dir=" +
        process.env.TEMP +
        `\\hyk304-storage-check-${profileSuffix}`,
      "--no-first-run",
      "--disable-gpu",
    ],
    { stdio: "ignore" },
  );
  await delay(1500);
  return child;
}

async function newTab(url) {
  const res = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  );
  return res.json();
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(e));
  });
}

function makeClient(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP timeout: ${method}`));
          }
        }, 8000);
      });
    },
  };
}

async function evaluate(client, expression, awaitPromise = false) {
  const { result, exceptionDetails } = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (exceptionDetails) {
    throw new Error(`evaluate failed: ${JSON.stringify(exceptionDetails)}`);
  }
  return result.value;
}

// document.execCommand('insertText', ...) 는 이 헤드리스 Chrome 에서
// «성공」을 보고하면서도 실제로는 아무것도 안 넣는다(실측: focus/active
// 는 true, DOM 은 그대로). 이 저장소의 다른 시험들도 애초에 실제 브라우저
// 입력 이벤트가 아니라 Lexical 노드를 직접 조작해 "타이핑"을 재현한다
// (checklist-live-typing-gap.test.mjs 등) -- 여기서는 그 대신 CDP 의
// Input.insertText(진짜 입력 파이프라인을 타는 전용 커맨드)를 쓴다.
// 실측: 이걸로 바꾸니 editor-root 에 실제 <p><span>...</span></p> 가
// 생기고 raw-panel 에도 그대로 반영됨을 확인했다.
async function typeInto(client, text) {
  const el = await evaluate(
    client,
    `(function() { const el = document.getElementById('editor-root'); el.focus(); return document.activeElement === el; })();`,
  );
  if (!el) throw new Error("editor-root 에 포커스를 줄 수 없었다");
  await client.send("Input.insertText", { text });
}

async function readSavedBody(client) {
  const expr = `
    (async () => {
      const id = localStorage.getItem('mobile-markdown-editor:current-memo-id');
      if (!id) return { id: null, body: null };
      const body = await new Promise((resolve, reject) => {
        const req = indexedDB.open('mobile-markdown-editor');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('memos', 'readonly');
          const getReq = tx.objectStore('memos').get(id);
          getReq.onsuccess = () => resolve(getReq.result ? getReq.result.body : null);
          getReq.onerror = () => reject(getReq.error);
        };
        req.onerror = () => reject(req.error);
      });
      return { id, body };
    })();
  `;
  return evaluate(client, expr, true);
}

async function readSaveNoticeText(client) {
  const expr = `
    (function() {
      const el = document.getElementById('save-notice');
      return { hidden: el.hidden, text: el.textContent };
    })();
  `;
  return evaluate(client, expr);
}

async function openAppTab() {
  const tab = await newTab(`${APP_ORIGIN}/`);
  const ws = await connectCdp(tab.webSocketDebuggerUrl);
  const client = makeClient(ws);
  await delay(500); // 번들 로드 + 초기 mount 대기
  return { tab, ws, client };
}

// 이 시험은 한 번에 큰 문자열 하나를 Input.insertText 로 밀어넣는 다른
// 확인들과 달리 "글자 하나씩" 나눠 보낸다 -- 실기기 육안 확인(claude-in-
// chrome 으로 실제 타이핑)에서 «디바운스 저장 경로»(scheduleDebouncedFlush)
// 가 실제 브라우저에서 "TypeError: Illegal invocation" 으로 죽는 버그를
// 찾았다(생성 시 즉시저장 경로만 타는 한 방 삽입으로는 이 버그가 전혀
// 안 걸렸다 -- node:test 단위 시험도 이 경로를 mock 이 아닌 진짜
// window.setTimeout 으로 실행하지 않아 못 잡았다). 고친 뒤 이 시험으로
// "여러 번 나눠 친 입력이 디바운스를 거쳐 «전부» 저장되는가"를 다시
// 확인한다.
async function runDebounceTypingCheck() {
  log("=== 디바운스 저장 경로: 여러 글자를 나눠 쳐서 실제로 검증 ===");
  const { client } = await openAppTab();
  await evaluate(
    client,
    `(function() { document.getElementById('editor-root').focus(); return true; })();`,
  );
  const text = "지하철에서 떠오른 일감";
  for (const ch of text) {
    await client.send("Input.insertText", { text: ch });
    await delay(80); // 실제 타이핑 간격 흉내(1초 디바운스보다 훨씬 짧게)
  }
  await delay(1500); // 마지막 입력 후 디바운스(1초) + 여유

  const saved = await readSavedBody(client);
  log("나눠 친 뒤 저장된 본문:", JSON.stringify(saved));
  return { expected: text, saved, matches: saved.body === text };
}

async function runCrashAtomicityCheck() {
  log("=== 크래시 원자성: Page.crash() 로 렌더러 프로세스 실제 강제 종료 ===");
  const { ws, client } = await openAppTab();
  await typeInto(client, "크래시 전에 쓴 문장");
  await delay(1500); // 1초 디바운스 + 여유 -> 실제로 커밋되게 한다
  const before = await readSavedBody(client);
  log("크래시 전 저장된 본문:", JSON.stringify(before));

  try {
    await client.send("Page.crash");
  } catch (err) {
    log(
      "Page.crash 호출 자체는 응답을 못 받음(렌더러가 죽어서 정상):",
      err.message,
    );
  }
  try {
    ws.close();
  } catch {
    // 이미 끊어졌을 수 있다
  }
  await delay(1000);

  const { client: client2 } = await openAppTab();
  const after = await readSavedBody(client2);
  log("크래시 후 재접속해서 읽은 본문:", JSON.stringify(after));

  return {
    before,
    after,
    survived: Boolean(after.body) && after.body === before.body,
  };
}

// 쿼터 override 는 페이지가 이미 로드돼 IndexedDB 커넥션/견적이 자리잡은
// 뒤에 걸면 늦게 반영될 수 있다(실측: app 로드 후 override 했더니 재현이
// 됐다 안 됐다 했다) -- about:blank 에서 먼저 걸고 나서 앱으로 navigate
// 한다.
async function runQuotaExceededCheck() {
  log("=== 저장공간 부족: Storage.overrideQuotaForOrigin 으로 실제 재현 ===");
  const tab = await newTab("about:blank");
  const ws = await connectCdp(tab.webSocketDebuggerUrl);
  const client = makeClient(ws);

  await client.send("Storage.overrideQuotaForOrigin", {
    origin: APP_ORIGIN,
    quotaSize: 4096,
  });
  await client.send("Page.navigate", { url: `${APP_ORIGIN}/` });
  await delay(1000);

  const estimateBefore = await evaluate(
    client,
    "navigator.storage.estimate()",
    true,
  );
  log("navigator.storage.estimate() (override 적용 후):", estimateBefore);

  await typeInto(client, "x".repeat(50000));
  await delay(1500);

  const notice = await readSaveNoticeText(client);
  log("알림 표시 상태:", notice);

  await client.send("Storage.overrideQuotaForOrigin", { origin: APP_ORIGIN });
  return { notice, estimateBefore };
}

async function main() {
  const devServer = await startDevServer();
  log("dev 서버 기동 완료, PID:", devServer.pid);

  const results = {};

  const debounceChrome = await launchChrome("debounce");
  try {
    results.debounce = await runDebounceTypingCheck();
  } catch (err) {
    results.debounceError = err.message;
  } finally {
    debounceChrome.kill();
  }

  const crashChrome = await launchChrome("crash");
  try {
    results.crash = await runCrashAtomicityCheck();
  } catch (err) {
    results.crashError = err.message;
  } finally {
    crashChrome.kill();
  }

  const quotaChrome = await launchChrome("quota");
  try {
    results.quota = await runQuotaExceededCheck();
  } catch (err) {
    results.quotaError = err.message;
  } finally {
    quotaChrome.kill();
  }

  log("=== 결과 ===");
  console.log(JSON.stringify(results, null, 2));

  const pid = stopDevServer(devServer);
  await delay(500);
  log(`서버 PID ${pid} 종료 요청 완료`);
}

main().catch((err) => {
  console.error("[crash-quota-check] 실패:", err);
  process.exitCode = 1;
});
