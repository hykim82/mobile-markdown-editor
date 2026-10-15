// HYK-304-first-run-notice-1 (coder-task.md §2): PRD §5b "최초 실행 1회
// 고지 '메모는 이 기기에만 저장됩니다'" / §8 보존 "최초 실행 1회 조용한
// 고지"의 결선. app-wiring.test.mjs 와 같은 이유로 app.mjs(브라우저
// 엔트리)를 test/support/app-harness.mjs 로 실제 부팅해 잰다 -- 고지
// 함수만 따로 불러 재면 "함수가 있다"만 증명하고 app.mjs 결선이 끊긴
// 채로도 초록일 수 있다(coder-task.md 1b_exec_line, E1 검토가 지적한
// "출하 파일을 안 보는 칸" 회피).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bootApp, waitFor } from "../support/app-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = join(here, "..", "..", "public", "index.html");

// 책임자 판정 §2 요구 3-ⓐ(coder-task.md): 문구는 상수를 import 해 비교
// 하지 않고 "문자열 리터럴"로 박는다 -- FIRST_RUN_NOTICE_TEXT 가 바뀌는
// 변이(N5)에도 이 시험이 그대로 걸리게 한다(E1 검토 P3-5 선례).
const NOTICE_TEXT = "메모는 이 기기에만 저장됩니다";

async function waitForListScreen(document) {
  await waitFor(
    () => document.querySelector("#list-root .memo-list-empty") !== null,
  );
}

// ⓐ 첫 실행(기록 없음): 고지 문구가 DOM 에 보인다(N3 생존: 렌더 제거
// 시 element 가 hidden 인 채로 남아 RED. N5 생존: 문구 한 글자라도
// 다르면 이 리터럴 비교가 RED).
test("①첫 실행(기록 없음): 최초 실행 고지가 문구 그대로 보인다", async () => {
  const dom = await bootApp();
  const { document } = dom.window;
  await waitForListScreen(document);

  const notice = document.getElementById("first-run-notice");
  assert.equal(notice.hidden, false, "첫 실행에는 고지가 보여야 한다");
  assert.equal(
    document.getElementById("first-run-notice-text").textContent,
    NOTICE_TEXT,
    "고지 문구는 PRD §5b 원문 그대로여야 한다",
  );
});

// ⓑ 닫으면 기록되고 고지가 사라진다(N1 생존 전제: 닫기 자체는 기록과
// 별개로 항상 숨긴다 -- 기록 실패 분기는 아래 ④ 시험이 ⓓ 로 잰다).
test("②닫기 버튼을 누르면 고지가 사라진다", async () => {
  const dom = await bootApp();
  const { document } = dom.window;
  await waitForListScreen(document);

  document.getElementById("first-run-notice-close-button").click();

  assert.equal(
    document.getElementById("first-run-notice").hidden,
    true,
    "닫기 뒤 고지는 바로 사라져야 한다",
  );
});

// ⓒ 닫은 뒤 다시 부팅(기록 있음)하면 고지가 안 뜬다(N1 생존: 기록 쓰기
// 줄이 지워지면 이 재부팅에서 다시 뜬다 -- N2 생존: 기록 읽기를
// 무시하면 역시 다시 뜬다).
test("③닫은 뒤 다시 실행하면(기록 있음) 고지가 뜨지 않는다", async () => {
  const first = await bootApp();
  await waitForListScreen(first.window.document);
  first.window.document.getElementById("first-run-notice-close-button").click();
  assert.equal(
    first.window.document.getElementById("first-run-notice").hidden,
    true,
  );

  // app-harness.mjs 의 bootApp() 은 매 호출마다 새 JSDOM(+새 localStorage)
  // 을 만든다 -- "기록이 재실행에도 남아있다"를 재려면 같은 window 를
  // 재사용해 그 window 의 localStorage 에 이미 쓰인 기록으로 app.mjs 를
  // 다시 부팅해야 한다(htmlOverride 로 같은 문서를 다시 읽어 들여도
  // globalThis.localStorage 는 installDomGlobals 가 매번 "그 dom" 의
  // localStorage 로 다시 꽂으므로, 두 번째 bootApp 호출에 같은 dom 의
  // localStorage 를 읽게 하려면 seed 로 직접 옮겨 심는다).
  const second = await bootApp({
    seed: (dom) => {
      dom.window.localStorage.setItem(
        "mobile-markdown-editor:first-run-notice-seen",
        first.window.localStorage.getItem(
          "mobile-markdown-editor:first-run-notice-seen",
        ),
      );
    },
  });
  await waitForListScreen(second.window.document);

  assert.equal(
    second.window.document.getElementById("first-run-notice").hidden,
    true,
    "기록이 있으면 재실행에도 고지가 뜨지 않아야 한다",
  );
});

// ⓓ 저장소 접근이 던져도(사생활 모드 등) 앱은 정상 기동하고 입력을 막지
// 않는다(N4 생존: try/catch 가 없으면 이 getItem 몽키패치에 main() 자체가
// 던져 부팅이 죽는다 -- 아래 waitForListScreen 이 타임아웃으로 실패).
test("④저장소(localStorage) 접근이 예외를 던져도 앱이 정상 기동하고 입력을 막지 않는다", async () => {
  const dom = await bootApp({
    seed: (d) => {
      d.window.Storage.prototype.getItem = function throwingGetItem() {
        throw new Error("first-run-notice.test.mjs: 강제 읽기 실패");
      };
      d.window.Storage.prototype.setItem = function throwingSetItem() {
        throw new Error("first-run-notice.test.mjs: 강제 쓰기 실패");
      };
    },
  });
  const { document } = dom.window;
  await waitForListScreen(document);

  assert.equal(
    document.getElementById("list-screen").hidden,
    false,
    "저장소 예외가 있어도 목록 화면은 정상적으로 떠야 한다",
  );

  // "입력을 막지 않는다"를 부팅 생존 그 자체로만 재지 않고, 그 뒤 "+"
  // 로 에디터까지 실제로 열려 입력 가능한(contenteditable) 상태가
  // 되는지까지 잇는다 -- main() 중간(mountFirstRunNotice 호출부)에서
  // 예외가 삼켜지지 않고 던져지면 이 뒤 단계(adapter 생성·에디터
  // 마운트·목록 배선)가 전혀 실행되지 않아 이 블록이 타임아웃으로 죽는다.
  document.getElementById("new-memo-button").click();
  await waitFor(
    () => document.getElementById("editor-screen").hidden === false,
  );
  assert.equal(
    document.getElementById("editor-root").getAttribute("contenteditable"),
    "true",
    "저장소 예외 뒤에도 에디터는 입력 가능(contenteditable) 상태로 열려야 한다",
  );
});

// ⓔ 고지가 떠 있는 동안에도(닫기 전) 입력이 막히지 않는다(PRD §5b
// 실행→입력 1초 NFR). jsdom 은 실제 레이아웃·히트테스트를 하지 않으므로
// (좌표 기반 클릭 가로채임은 touch-action 시험과 같은 이유로 여기서 못
// 잰다), 이 시험은 두 값으로 "비차단"을 좁힌다: ⑴ 고지가 떠 있는 채로도
// "+"·카드 클릭 등 다른 엘리먼트 클릭이 정상 도달한다(고지가 전체를
// 덮는 투명 오버레이가 아니라는 기능적 증거) ⑵ 고지 자신이 CSS 상
// 화면을 덮는 고정 오버레이(position: fixed 전체 덮개)로 선언돼 있지
// 않다(구조적 증거, 출하 CSS 를 직접 읽는 선례 -- 변이 N3 가 렌더 자체를
// 지우면 ⓐ 가 이미 잡으므로, 여기는 "떠 있는 상태에서의 비차단"만
// 좁혀 잰다).
test("⑤고지가 떠 있는 동안에도 다른 조작(새 메모 열기)이 가로채이지 않는다(비차단)", async () => {
  const html = await readFile(indexHtmlPath, "utf8");
  const withoutComments = html.replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleMatch = /#first-run-notice\s*\{([^}]*)\}/s.exec(withoutComments);
  assert.ok(ruleMatch, "#first-run-notice 규칙이 출하 CSS 에 있어야 한다");
  assert.doesNotMatch(
    ruleMatch[1],
    /position\s*:\s*fixed/,
    "고지 자신은 화면을 덮는 고정 오버레이(position: fixed)로 선언돼 있으면 안 된다",
  );

  const dom = await bootApp();
  const { document } = dom.window;
  await waitForListScreen(document);
  assert.equal(
    document.getElementById("first-run-notice").hidden,
    false,
    "이 시험은 고지가 떠 있는 상태를 전제한다",
  );

  document.getElementById("new-memo-button").click();
  await waitFor(
    () => document.getElementById("editor-screen").hidden === false,
  );

  // 고지는 여전히 떠 있어야 한다(닫지 않았으므로) -- 그 상태에서도 화면
  // 전환(클릭)이 가로채이지 않고 끝까지 도달했다는 것이 비차단의 기능적
  // 증거다.
  assert.equal(
    document.getElementById("first-run-notice").hidden,
    false,
    "닫지 않았으니 고지는 에디터 화면에서도 그대로 떠 있어야 한다",
  );
  assert.equal(
    document.getElementById("editor-root").getAttribute("contenteditable"),
    "true",
    "고지가 떠 있는 채로도 에디터는 입력 가능 상태여야 한다",
  );
});
