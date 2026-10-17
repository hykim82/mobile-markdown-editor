// HYK-304-saved-indicator-1-r2(coder-task.md §1·§2 P2-1): bootApp() 이
// 부팅한 실제 app.mjs 번들 위에서 "진짜 beforeinput 타이핑"을 재현하는
// 도우미. HYK-304-saved-indicator-1-review-1 검토가 만든 탐침
// bundle-probe.mjs(sha256 1d031cd617165a7797f4b6841e024355d51c184a7b83d2549
// a1e75245fe1f3f0, review-1R 1b_shown)에서 그대로 옮겨왔다 -- jsdom 은
// contenteditable 에 실제 키 입력을 흉내 내지 않지만(브라우저 네이티브
// 입력 처리가 없다), InputEvent.getTargetRanges 와
// Range.getBoundingClientRect 두 공백만 메우면 번들 안 Lexical 이 실제
// 브라우저와 같은 beforeinput 경로를 탄다(Lexical 이 preventDefault 한
// 삽입은 CONTROLLED_TEXT_INSERTION_COMMAND 로 처리하고, preventDefault
// 하지 않은 삽입은 "브라우저가 하듯" 텍스트 노드 변경 + input 이벤트로
// 대신한다).
export function installBeforeInputShims(dom) {
  const { window } = dom;
  window.InputEvent.prototype.getTargetRanges = function getTargetRanges() {
    return [];
  };
  if (!window.Range.prototype.getBoundingClientRect) {
    window.Range.prototype.getBoundingClientRect =
      function getBoundingClientRect() {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
        };
      };
  }
}

function placeCaretAtEnd(dom, root) {
  const { window } = dom;
  const { document } = window;
  const sel = window.getSelection();
  const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  const range = document.createRange();
  if (last) {
    range.setStart(last, last.length);
  } else {
    const p = root.querySelector("p") ?? root;
    range.setStart(p, 0);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// root 에 beforeinput 을 쏜다 -- Lexical 이 defaultPrevented 로 받으면
// (CONTROLLED_TEXT_INSERTION_COMMAND 로 자기 모델을 직접 갱신) 그걸로
// 끝이고, 그러지 않으면 브라우저가 하듯 텍스트 노드를 직접 고치고 뒤따라
// "input" 이벤트를 쏜다(Lexical 의 네이티브 변이 관찰 경로).
export function typeBeforeInput(dom, root, inputType, data = null) {
  placeCaretAtEnd(dom, root);
  const { window } = dom;
  const { document } = window;
  const ev = new window.InputEvent("beforeinput", {
    inputType,
    data,
    bubbles: true,
    cancelable: true,
  });
  root.dispatchEvent(ev);
  if (ev.defaultPrevented) return "controlled";

  const sel = window.getSelection();
  const node = sel.anchorNode;
  const offset = sel.anchorOffset;
  if (inputType === "insertText" && node && node.nodeType === 3) {
    node.insertData(offset, data);
    const r = document.createRange();
    r.setStart(node, offset + data.length);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  } else if (
    inputType === "deleteContentBackward" &&
    node &&
    node.nodeType === 3 &&
    offset > 0
  ) {
    node.deleteData(offset - 1, 1);
    const r = document.createRange();
    r.setStart(node, offset - 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  root.dispatchEvent(
    new window.InputEvent("input", { inputType, data, bubbles: true }),
  );
  return "native";
}
