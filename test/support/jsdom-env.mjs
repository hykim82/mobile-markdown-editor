// lexical 은 import 시점에 브라우저 DOM 전역이 있다고 가정한다 -- node
// --test 환경에서 헤드리스로 구동하려면 이 파일을 그 어떤 lexical/
// @lexical/* import보다 먼저 import 해서 최소 전역을 심어야 한다.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});

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
// current-memo-pointer.mjs 는 전역 `localStorage` 를 바로 참조한다(HYK-304
// -storage-3 · 런타임 안전판 시험이 app.mjs 의 mountStorage/
// restoreCurrentMemo 를 이 전역으로 실제로 태워야 해서 추가) -- 없으면
// ReferenceError 가 그 파일의 try/catch 에 조용히 삼켜져 포인터가 항상
// null 로 읽힌다.
globalThis.localStorage = dom.window.localStorage;

export function setNativeSelection(node, offset) {
  if (!node) {
    return;
  }
  const selection = globalThis.window.getSelection();
  const range = globalThis.document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function getTextDomNode(container) {
  const span = container.querySelector('span[data-lexical-text="true"]');
  return span ? span.firstChild : null;
}

export function makeEditableRoot() {
  const root = globalThis.document.createElement("div");
  root.contentEditable = "true";
  globalThis.document.body.appendChild(root);
  return root;
}
