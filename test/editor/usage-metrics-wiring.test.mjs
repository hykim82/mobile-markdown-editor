// HYK-304-usage-metrics-1(coder-task.md §2 요구 2~4) -- 카운터 모듈만 따로
// 불러 재는 헛시험이 아니라, 실제 결선(app.mjs 부팅·mountNotionCopy·
// product-editor.mjs 의 beforeinput 리스너)을 거쳐 값이 오르는지를 잰다.
// app-wiring.test.mjs/save-indicator.test.mjs 와 같은 bootApp()+
// typeBeforeInput 기법, ime-composition.test.mjs 와 같은 네이티브
// CompositionEvent 기법을 그대로 쓴다(새 기법 발명 없음).
//
// ⚠️파일 안 순서 주의(직접 실측): bootApp() 은 매호출마다 globalThis.window/
// document/localStorage 를 그 부팅의 jsdom 으로 "영구히" 덮어쓴다(복원
// 없음, app-harness.mjs installDomGlobals). makeProductEditor() 는 매번
// "지금의" globalThis.document 위에 에디터를 올린다 -- 그래서 이 파일은
// jsdom-env.mjs 의 원래 전역이 아직 살아있는 동안(= bootApp 을 한 번도
// 부르기 전) makeProductEditor 기반 시험을 먼저 끝내고, 그 다음에야
// bootApp 기반 시험을 돈다(node:test 는 등록 순서대로 순차 실행).
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { bootApp, waitFor } from "../support/app-harness.mjs";
import {
  installBeforeInputShims,
  typeBeforeInput,
} from "../support/bundle-typing.mjs";
import { makeProductEditor } from "../support/make-editor.mjs";
import { readRecentWeeks } from "../../src/editor/usage-metrics.mjs";

function seedText(editor, text) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      const textNode = $createTextNode(text);
      paragraph.append(textNode);
      root.append(paragraph);
      textNode.select(text.length, text.length);
    },
    { discrete: true },
  );
}

function makeFakeDom() {
  const fakeDom = { window: globalThis.window };
  installBeforeInputShims(fakeDom);
  return fakeDom;
}

// ======================================================================
// 1부: makeProductEditor() (= product-editor.mjs 가 실제로 만드는 에디터,
// registerUsageInputTracking 결선 그대로) 위에서 재입력 추정 판정의
// 반대 방향 3가지를 잰다. bootApp() 을 아직 한 번도 안 불렀으므로
// window.localStorage 는 jsdom-env.mjs 의 원래 인스턴스다.
// ======================================================================

test("반대 방향: 한글 조합 중 지우기는 재입력 추정에 들어가지 않는다(조합 종료 후엔 정상 재개)", () => {
  window.localStorage.clear();
  const { editor, root } = makeProductEditor();
  const fakeDom = makeFakeDom();
  seedText(editor, "안녕하세요테스트조합");

  root.dispatchEvent(
    new window.CompositionEvent("compositionstart", {
      data: "",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(editor.isComposing(), true, "사전 조건: 조합 중이어야 한다");

  // 조합 중 3회 지우기 -- 재입력 추정 스트릭에 들어가면 안 된다.
  typeBeforeInput(fakeDom, root, "deleteContentBackward");
  typeBeforeInput(fakeDom, root, "deleteContentBackward");
  typeBeforeInput(fakeDom, root, "deleteContentBackward");

  root.dispatchEvent(
    new window.CompositionEvent("compositionend", {
      data: "",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(editor.isComposing(), false);

  typeBeforeInput(fakeDom, root, "insertText", "x");

  const { thisWeek } = readRecentWeeks();
  assert.equal(
    thisWeek.retypes,
    0,
    "조합 중 지우기는 통계에 전혀 반영되면 안 된다",
  );
});

test("반대 방향: 2글자만 연속 지우고 다시 입력하면 재입력 추정은 0회다", () => {
  window.localStorage.clear();
  const { editor, root } = makeProductEditor();
  const fakeDom = makeFakeDom();
  seedText(editor, "안녕하세요");

  typeBeforeInput(fakeDom, root, "deleteContentBackward");
  typeBeforeInput(fakeDom, root, "deleteContentBackward");
  typeBeforeInput(fakeDom, root, "insertText", "x");

  const { thisWeek } = readRecentWeeks();
  assert.equal(
    thisWeek.retypes,
    0,
    "3글자 미만은 재입력 추정에 안 들어가야 한다",
  );
});

test("반대 방향: 3글자 이상 지운 뒤 5초가 지나서 입력하면 재입력 추정은 0회다", (t) => {
  window.localStorage.clear();
  const { editor, root } = makeProductEditor();
  const fakeDom = makeFakeDom();
  seedText(editor, "안녕하세요테스트조합");

  t.mock.timers.enable({ apis: ["Date"] });
  typeBeforeInput(fakeDom, root, "deleteContentBackward");
  typeBeforeInput(fakeDom, root, "deleteContentBackward");
  typeBeforeInput(fakeDom, root, "deleteContentBackward");
  t.mock.timers.tick(5001);
  typeBeforeInput(fakeDom, root, "insertText", "x");

  const { thisWeek } = readRecentWeeks();
  assert.equal(
    thisWeek.retypes,
    0,
    "5초를 넘겨 입력하면 재입력 추정에 안 들어가야 한다",
  );
});

// ======================================================================
// 2부: bootApp() -- 실물 public/index.html + 실제 app.mjs 번들. 여기부터는
// globalThis.window/document/localStorage 가 매 bootApp() 호출마다 새로
// 덮어써지므로 위 1부와 뒤섞여도 서로 간섭하지 않는다.
// ======================================================================

async function waitForListScreen(document) {
  await waitFor(
    () => document.querySelector("#list-root .memo-list-empty") !== null,
  );
}

function statCell(document, metric, period) {
  return document.querySelector(
    `[data-metric="${metric}"][data-period="${period}"]`,
  );
}

// 통계 카드는 목록 제목(h1)을 길게 눌러야만 연다 -- pointerdown 뒤 모의
// setTimeout 으로 longPressMs(usage-metrics.mjs 의 LONG_PRESS_MS=600ms)를
// "결정적으로" 넘긴다(bootApp()/waitFor() 가 쓰는 실제 setTimeout 호출이
// 모두 끝난 뒤에만 모의 타이머를 켠다 -- 그 전에 켜면 waitFor 의 폴링
// 루프 자체가 멈춘다).
function longPressTitle(t, document) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const title = document.querySelector("#list-screen .topbar h1");
  title.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  t.mock.timers.tick(650);
}

function shortTapTitle(t, document) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const title = document.querySelector("#list-screen .topbar h1");
  title.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  title.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
  t.mock.timers.tick(650);
}

test("결선 전체: 앱 열기·새 메모·복사 성공·실행취소·재입력까지 실제 입력 경로로 세어 통계 카드에 그대로 뜬다", async (t) => {
  const clipboardWrites = [];
  const dom = await bootApp({
    seed: (d) => {
      installBeforeInputShims(d);
      Object.defineProperty(d.window.navigator, "clipboard", {
        value: {
          writeText: async (text) => {
            clipboardWrites.push(text);
          },
        },
        configurable: true,
      });
    },
  });
  const { document } = dom.window;
  await waitForListScreen(document);

  // 앱 연 횟수 = 이 bootApp() 의 main() 호출 1회(recordAppOpen, app.mjs).
  // "+"(새 메모) -> 첫 글자 입력(=생성, memo-store.mjs) -> 노션 복사
  // 버튼 -> 실행취소 -> 3자 이상 지우고 5초 안 다시 입력(재입력 추정)
  // 순서로 다섯 카운터를 전부 실제 경로로 센다.
  document.getElementById("new-memo-button").click();
  await waitFor(
    () => document.getElementById("editor-screen").hidden === false,
  );
  const root = document.getElementById("editor-root");

  assert.equal(
    typeBeforeInput(dom, root, "insertText", "안녕하세요"),
    "controlled",
    "shim 이 걸려 있어야 Lexical 이 beforeinput 을 controlled 경로로 처리한다",
  );
  await waitFor(() =>
    document.getElementById("save-indicator").classList.contains("is-visible"),
  );

  const copyButton = document.getElementById("notion-copy-button");
  assert.equal(copyButton.disabled, false, "본문이 있으니 복사 버튼은 활성");
  copyButton.click();
  await waitFor(() => clipboardWrites.length > 0);
  await waitFor(
    () => document.getElementById("notion-copy-toast").hidden === false,
  );

  // 실행취소(OS/키보드 네이티브, inputType==="historyUndo").
  typeBeforeInput(dom, root, "historyUndo");

  // 재입력 추정: 3글자 이상 연속 지우기 -> 5초 안(실제로는 거의 0ms 뒤)
  // 다시 입력.
  typeBeforeInput(dom, root, "deleteContentBackward");
  typeBeforeInput(dom, root, "deleteContentBackward");
  typeBeforeInput(dom, root, "deleteContentBackward");
  typeBeforeInput(dom, root, "insertText", "x");

  longPressTitle(t, document);
  const card = document.getElementById("usage-stats-card");
  assert.equal(card.hidden, false, "길게 누르면 카드가 보여야 한다");
  assert.equal(statCell(document, "opens", "this").textContent, "1");
  assert.equal(statCell(document, "newMemos", "this").textContent, "1");
  assert.equal(statCell(document, "copies", "this").textContent, "1");
  assert.equal(statCell(document, "undos", "this").textContent, "1");
  assert.equal(statCell(document, "retypes", "this").textContent, "1");
  assert.equal(
    statCell(document, "opens", "last").textContent,
    "0",
    "지난주 버킷은 아직 아무 것도 없어야 한다",
  );

  document.getElementById("usage-stats-close-button").click();
  assert.equal(card.hidden, true, "닫기를 누르면 다시 숨어야 한다");

  // 평소 화면에는 숫자 외 메모 "내용"이 전혀 안 보인다 -- 메모 본문
  // "안녕하세요x"는 raw-panel(개발용 표시)에만 있고 카드엔 숫자만.
  assert.doesNotMatch(card.textContent, /안녕/);
});

test("반대 방향: 노션 복사가 실패하면 복사 성공 카운터는 0이다", async (t) => {
  const dom = await bootApp({
    seed: (d) => {
      installBeforeInputShims(d);
      Object.defineProperty(d.window.navigator, "clipboard", {
        value: {
          writeText: async () => {
            throw new Error("usage-metrics-wiring: 강제 복사 실패");
          },
        },
        configurable: true,
      });
    },
  });
  const { document } = dom.window;
  await waitForListScreen(document);
  document.getElementById("new-memo-button").click();
  await waitFor(
    () => document.getElementById("editor-screen").hidden === false,
  );
  const root = document.getElementById("editor-root");
  typeBeforeInput(dom, root, "insertText", "복사 실패 확인");
  await waitFor(
    () => document.getElementById("notion-copy-button").disabled === false,
  );

  document.getElementById("notion-copy-button").click();
  await waitFor(
    () => document.getElementById("notion-copy-toast").hidden === false,
  );
  assert.match(
    document.getElementById("notion-copy-toast").textContent,
    /다시/,
    "사전 조건: 실패 토스트가 떠야 한다",
  );

  longPressTitle(t, document);
  assert.equal(
    statCell(document, "copies", "this").textContent,
    "0",
    "실패 경로에서는 복사 성공 카운터가 오르면 안 된다",
  );
});

test("반대 방향: 목록 제목을 짧게 탭하면(길게 누르기 전에 뗌) 카드가 열리지 않는다", async (t) => {
  const dom = await bootApp();
  const { document } = dom.window;
  await waitForListScreen(document);

  shortTapTitle(t, document);
  assert.equal(
    document.getElementById("usage-stats-card").hidden,
    true,
    "짧은 탭 뒤 길게 누르기 기준 시간이 지나도 카드는 열리면 안 된다",
  );
});

test("반대 방향: localStorage 접근이 막혀도 앱이 정상 기동하고 통계 카드는 0으로 보인다", async (t) => {
  const dom = await bootApp({
    seed: (d) => {
      d.window.Storage.prototype.getItem = function throwingGetItem() {
        throw new Error("usage-metrics-wiring: 강제 읽기 실패");
      };
      d.window.Storage.prototype.setItem = function throwingSetItem() {
        throw new Error("usage-metrics-wiring: 강제 쓰기 실패");
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

  longPressTitle(t, document);
  assert.equal(document.getElementById("usage-stats-card").hidden, false);
  for (const metric of ["opens", "newMemos", "copies", "undos", "retypes"]) {
    assert.equal(
      statCell(document, metric, "this").textContent,
      "0",
      `${metric}: 저장소가 막혔으면 0으로 보여야 한다`,
    );
  }
});
