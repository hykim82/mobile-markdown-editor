// 렌더된 체크칸 탭 → [ ]↔[x] 전환(HYK-304-checkbox-tap-toggle-1 · coder-task §2).
//
// 갈리는 층(재현 시점 실측 · 고치기 전):
// - 그리기: 체크칸은 Lexical 이 li 에 붙이는 aria-checked 를 CSS 가 ::before 글리프로
//   그린다(public/index.html 의 li[aria-checked]::before). 이 층은 이미 있다.
// - 탭: 탭 → 토글 리스너는 @lexical/list 의 registerCheckList 가 root 에 달지만,
//   제품 결선(product-editor.mjs)은 그것을 부르지 않는다 -- 탭은 아무것도 바꾸지 않았다.
//
// 두 경로 분기점(@lexical/list handleClick): 체크칸을 누르면 토글과 함께
// 「항목에 DOM 포커스를 준다(domNode.focus)」가 기본 경로다. 실측(실브라우저 · 탭 1회 ·
// 커서가 다른 줄에 있을 때): 그 경로는 탭 직후 activeElement 를 li 로 옮겼다. 그
// 포커스 이동이 커서 진입을 낳아 줄을 펼치는지는 이 조건에서 관측되지 않았다.
// 커서·포커스를 아예 옮기지 않는 disableTakeFocusOnClick 을 고른다 -- 토글만 한다.
// (커서 진입 쪽 경로는 이 판정 근거로 쓰지 않는다 -- 재현하지 못했다.)
//
// IME 조합 중 탭은 무시한다(PRD §5.3). 라이브러리 리스너는 조합 상태를 보지 않으므로,
// 체크 항목 위의 click/pointerup 을 root 캡처 단계에서 끊는다(라이브러리 bubble 리스너
// 까지 닿지 않는다). 체크 항목 밖의 입력은 건드리지 않는다.
import { mergeRegister } from "lexical";
import { registerCheckList } from "@lexical/list";

const CHECK_ITEM_SELECTOR = "li[aria-checked]";

export function registerCheckboxTap(editor) {
  const unregisterCheckList = registerCheckList(editor, {
    disableTakeFocusOnClick: true,
  });

  let detachGuard = null;
  const unregisterGuard = editor.registerRootListener((root) => {
    if (detachGuard) detachGuard();
    detachGuard = null;
    if (root === null) return;
    // instanceof Element 을 쓰지 않는다 -- 다른 realm(iframe·시험 환경)의 원소는
    // 전역 Element 와 맞지 않아 리스너가 던지고, 그러면 가드가 조용히 빠진다.
    const checkItemOf = (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return null;
      return target.closest(CHECK_ITEM_SELECTOR);
    };
    const block = (event) => {
      if (!editor.isComposing()) return;
      if (checkItemOf(event) === null) return;
      event.stopPropagation();
    };
    // ⭐라이브러리 touch 경로는 같은 항목을 500ms 안에 다시 탭하면 조용히 버린다
    // (__lexicalCheckListLastHandled 중복 방지 · 실측: 460ms 간격 두 번 탭 → 한 번만
    // 토글). 중복 방지는 한 번의 누름 안에서 뒤따르는 click 을 막는 용도인데, 누름이
    // 시작될 때 기록을 비우면 누름과 누름 사이의 간격 문제가 사라진다.
    const startPress = (event) => {
      const item = checkItemOf(event);
      if (item !== null) item.__lexicalCheckListLastHandled = undefined;
    };
    root.addEventListener("pointerdown", startPress, { capture: true });
    root.addEventListener("click", block, { capture: true });
    root.addEventListener("pointerup", block, { capture: true });
    detachGuard = () => {
      root.removeEventListener("pointerdown", startPress, { capture: true });
      root.removeEventListener("click", block, { capture: true });
      root.removeEventListener("pointerup", block, { capture: true });
    };
  });

  return mergeRegister(unregisterCheckList, () => {
    if (detachGuard) detachGuard();
    detachGuard = null;
    unregisterGuard();
  });
}
