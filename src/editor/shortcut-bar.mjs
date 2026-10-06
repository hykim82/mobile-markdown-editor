// 단축키바(PRD §5.3, HYK-304-shortcut-bar-1). 칩 5종은 라벨 버튼이며 탭하면
// 커서 위치에 정해진 마크다운 문자열을 넣는다 -- 자음 연타 자동 치환이 아니다
// (PRD §10 "칩 탭 전용", GLOSSARY "자음더블 자동 치환(폐기)").
//
// 매핑은 PRD §5.3 문면 그대로다(임의 추가 0). 굵게만 커서 위치가 정해져 있다
// ("커서 가운데") -- caret 은 삽입된 문자열 안에서의 오프셋이다.
import { $getSelection, $isRangeSelection } from "lexical";

export const SHORTCUT_CHIPS = Object.freeze([
  { label: "제목", text: "#" },
  { label: "목록", text: "-" },
  { label: "굵게", text: "** **", caret: 3 },
  { label: "체크박스", text: "- [ ]" },
  { label: "취소선", text: "~~ ~~" },
]);

// 삽입이 일어났으면 true, 아무것도 안 건드렸으면 false(PRD §5.3 ③ 삽입 실패 시
// 본문 불변). 실패는 두 경우다: 에디터에 범위 선택이 없는 경우, 그리고 한글 조합
// 중인 경우(PRD §5.3 ② 조합 확정 후에만 삽입).
export function insertChip(editor, chip) {
  if (editor.isComposing()) return false;
  let applied = false;
  editor.update(
    () => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      selection.insertText(chip.text);
      if (chip.caret !== undefined) {
        // insertText 뒤 선택은 삽입 문자열 끝에 있다 -- 거기서 caret 만큼 되돌린다.
        const anchor = selection.anchor;
        const node = anchor.getNode();
        const at = anchor.offset - (chip.text.length - chip.caret);
        selection.setTextNodeRange(node, at, node, at);
      }
      applied = true;
    },
    { discrete: true },
  );
  return applied;
}

// 칩 버튼을 container 에 붙인다. 버튼은 mousedown/pointerdown 을 취소해서
// 에디터의 DOM 포커스와 선택을 잃지 않는다 -- 기본 동작대로 두면 버튼이 포커스를
// 받아 에디터 선택이 사라지고 칩이 삽입할 자리가 없어진다.
export function mountShortcutBar(editor, container) {
  const buttons = SHORTCUT_CHIPS.map((chip) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "shortcut-chip";
    button.textContent = chip.label;
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => insertChip(editor, chip));
    container.appendChild(button);
    return button;
  });
  return () => {
    for (const button of buttons) button.remove();
  };
}
