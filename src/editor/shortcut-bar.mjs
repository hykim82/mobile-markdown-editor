// 단축키바(PRD §5.3, HYK-304-shortcut-bar-1). 칩 5종은 라벨 버튼이며 탭하면
// 커서 위치에 정해진 마크다운 문자열을 넣는다 -- 자음 연타 자동 치환이 아니다
// (PRD §10 "칩 탭 전용", GLOSSARY "자음더블 자동 치환(폐기)").
//
// 매핑은 PRD §5.3 문면 그대로다(임의 추가 0). 굵게만 커서 위치가 정해져 있다
// ("커서 가운데") -- caret 은 삽입된 문자열 안에서의 오프셋이다.
import { $getSelection, $isRangeSelection } from "lexical";
//
// 블록 3종(제목·목록·체크박스)은 본문을 넣은 뒤 마지막 공백 한 글자를 칩이 별도
// 입력 이벤트로 흘린다(space: true). §5.2 트리거(@lexical/markdown 의
// registerMarkdownShortcuts)는 "앵커가 한 글자 움직인 업데이트"에서만 발화하므로,
// 공백 없이 본문만 넣으면 서식이 되지 않는다(HYK-304-shortcut-bar-2R, 실측).
// ⚠️ 이 발화 성질은 @lexical/markdown 내부 동작이다 -- 판본 0.51.0 에 고정돼
// 있다(package-lock.json). 판본이 올라가면 조용히 깨질 수 있고, 그때는 칩 시험
// "탭 직후 블록 3종은 서식이 된다"가 가장 먼저 빨개진다.
export const SHORTCUT_CHIPS = Object.freeze([
  { label: "제목", text: "#", space: true },
  { label: "목록", text: "-", space: true },
  { label: "굵게", text: "** **", caret: 3 },
  { label: "체크박스", text: "- [ ]", space: true },
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
  if (applied && chip.space) {
    // 마지막 공백은 별도 update 한 글자 입력으로 흘린다 -- 트리거는 그 입력에서 발화한다.
    editor.update(() => {
      $getSelection().insertText(" ");
    });
  }
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
