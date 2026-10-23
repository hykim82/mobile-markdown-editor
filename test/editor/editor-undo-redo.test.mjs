// HYK-304-editor-undo-1(coder-task.md §2 · PRD §5.6 "실행취소"): 실제 결선
// (product-editor.mjs 의 registerHistory)을 키보드(Ctrl+Z, Ctrl+Shift+Z,
// Ctrl+Y)·OS 네이티브(beforeinput historyUndo/historyRedo) 양쪽 경로로
// 실제 keydown/beforeinput 이벤트로 구동해 본문이 실제로 되돌는지/다시
// 실행되는지를 잰다. 기존 기법 재사용: make-editor.mjs(makeProductEditor),
// bundle-typing.mjs(typeBeforeInput), shortcut-bar.mjs(insertChip),
// usage-metrics-wiring.test.mjs/save-indicator.test.mjs 의 settle() 관례.
//
// ⚠️실측 전제 1(직접 확인, node_modules/lexical/src/LexicalEvents.ts):
// 키보드 Ctrl/Meta+Z, Ctrl/Meta+Shift+Z, Ctrl+Y 는 lexical 코어가
// createEditor() 시점부터 이미 keydown 에서 UNDO_COMMAND/REDO_COMMAND 를
// 디스패치한다(registerDefaultCommandHandlers, buildKeyDownShortcuts) --
// 지금까지는 그 커맨드를 듣는 리스너가 없어 no-op 였을 뿐이다.
// registerHistory 가 그 리스너를 단다. 그래서 이 파일은 registerHistory
// 호출 "자체"가 걸려 있는지만 확인하면 되고, 별도의 키 매핑 코드를 이
// 조각에서 새로 만들 필요가 없다(product-editor.mjs 변경 1줄로 충분).
//
// ⚠️실측 전제 2(직접 확인·시행착오): lexical 의 CAN_USE_BEFORE_INPUT
// (environment.ts)은 "`getTargetRanges` in new InputEvent('input')" 를
// lexical 모듈이 "처음 평가되는 그 순간" 1회만 확인해 프로세스 전역으로
// 고정한다. bundle-typing.mjs 의 installBeforeInputShims 는 그 getTargetRanges
// 를 시험 "본문 안"(= lexical 이 이미 평가된 뒤)에서 단다 -- 그러면
// CAN_USE_BEFORE_INPUT 이 false 로 굳어 lexical 코어가 'beforeinput' 자체를
// 전혀 듣지 않고(OS 네이티브 historyUndo/historyRedo 가 완전히 무시된다),
// usage-metrics.mjs 의 자체 'beforeinput' 리스너(product 코드, lexical
// 코어와 무관하게 직접 단다)만 계수를 센다. 그래서 이 파일은 "lexical"을
// import 하는 모든 모듈(make-editor.mjs 등)을 동적 import 로 미루고, 그
// 앞에서 getTargetRanges shim 을 먼저 달아 CAN_USE_BEFORE_INPUT 을 true로
// 고정한 뒤에야 불러온다 -- 공유 파일(jsdom-env.mjs)은 건드리지 않는다
// (coder-task.md product_scope 밖).
//
// 〔직접〕Meta+Z(Mac)는 이 라운드에서 실측하지 못한다 -- LexicalKeyboardShortcuts.ts
// 의 CONTROL_OR_META 는 IS_APPLE(navigator.platform 이 /Mac|iPod|iPhone|iPad/
// 매치)에 따라 ctrlKey 또는 metaKey 중 "하나만" 요구하도록 모듈 로드
// 시점에 1회 고정되는 상수다. 이 저장소의 jsdom-env.mjs 는 navigator.platform
// 이 빈 문자열이라 IS_APPLE=false 로 고정되고, 같은 프로세스 안에서는 이를
// 뒤집을 수 없다(Mac 전용 jsdom 환경을 새로 만들려면 별도 시험 파일이
// 필요하지만 coder-task.md product_scope 는 "새 시험 파일 최대 1"이라 이번
// 라운드에는 넣지 않는다). Ctrl+Z 가 실제로 UNDO_COMMAND 를 디스패치하는
// 것은 아래에서 실측하고, Meta+Z 는 "같은 코드 한 줄(LexicalEvents.ts
// 1725행 prevent('z', CONTROL_OR_META, UNDO_COMMAND, undefined))이 플랫폼만
// 다르게 해석한다"는 사실을 코드로 확인했을 뿐 이 라운드에서 실행해 재지는
// 않았다(추론 vs 실측 분리, coder-task.md universal_claim_discipline).
//
// ⚠️실측 한계 3: 실제 폰 OS 실행취소(iOS 흔들기·안드로이드 키보드 실행취소
// 키)가 내는 네이티브 beforeinput 의 정확한 모양과, 실제 한글 IME 조합과
// 실행취소의 상호작용은 jsdom(가짜 환경)에서 못 잰다(coder-task.md
// universal_claim_discipline) -- 아래 조합 중 시험은 "jsdom 이 흉내 낼 수
// 있는 범위"(CompositionEvent + beforeinput historyUndo 조합)까지만 잰다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

// CAN_USE_BEFORE_INPUT 고정 전에 shim 적용(위 "실측 전제 2") -- 아래
// 동적 import 들이 이 뒤에서 lexical 을 처음 평가한다.
globalThis.window.InputEvent.prototype.getTargetRanges =
  function getTargetRanges() {
    return [];
  };

const lexical = await import("lexical");
const { makeProductEditor } = await import("../support/make-editor.mjs");
const { installBeforeInputShims, typeBeforeInput } =
  await import("../support/bundle-typing.mjs");
const { serializeEditorToMarkdown } =
  await import("../../src/editor/serialize.mjs");
const { insertChip } = await import("../../src/editor/shortcut-bar.mjs");
const { mountStorage } = await import("../../src/editor/storage-mount.mjs");
const { createFakeAdapter } = await import("../support/fake-adapter.mjs");
const { readRecentWeeks } = await import("../../src/editor/usage-metrics.mjs");

const { window } = globalThis;

// registerHistory 의 undo()/redo() 가 만드는 state 교체, typeBeforeInput 의
// native 삽입 경로, insertChip 의 두 번째(공백) update 는 모두 {discrete:true}
// 가 아닌 보통 update라 비동기(마이크로/매크로태스크)로 반영된다(직접 실측,
// settle 없이 읽으면 이전 값이 보인다) -- usage-metrics-wiring.test.mjs 류의
// 기존 settle() 관례를 그대로 쓴다.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function markdownOf(editor) {
  return serializeEditorToMarkdown(editor);
}

function seedText(editor, text) {
  editor.update(
    () => {
      const root = lexical.$getRoot();
      root.clear();
      const paragraph = lexical.$createParagraphNode();
      const textNode = lexical.$createTextNode(text);
      paragraph.append(textNode);
      root.append(paragraph);
      textNode.select(text.length, text.length);
    },
    { discrete: true },
  );
}

function makeFakeDom() {
  const fakeDom = { window };
  installBeforeInputShims(fakeDom);
  return fakeDom;
}

function pressUndo(root) {
  root.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function pressRedoShiftZ(root) {
  root.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function pressRedoCtrlY(root) {
  root.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "y",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function fireHistoryBeforeInput(root, inputType) {
  const ev = new window.InputEvent("beforeinput", {
    inputType,
    bubbles: true,
    cancelable: true,
  });
  root.dispatchEvent(ev);
  return ev.defaultPrevented;
}

test("Ctrl+Z(키보드)는 방금 입력을 되돌린다(①②, 실제 keydown -> UNDO_COMMAND)", async () => {
  const { editor, root } = makeProductEditor();
  const fakeDom = makeFakeDom();
  seedText(editor, "hello");
  await settle();
  typeBeforeInput(fakeDom, root, "insertText", "!");
  await settle();
  assert.equal(markdownOf(editor), "hello!");

  pressUndo(root);
  await settle();
  assert.equal(
    markdownOf(editor),
    "hello",
    "Ctrl+Z 가 방금 입력(느낌표)만 되돌려야 한다",
  );
});

test("Ctrl+Shift+Z, Ctrl+Y(키보드)는 되돌린 입력을 다시 실행한다", async () => {
  const { editor, root } = makeProductEditor();
  const fakeDom = makeFakeDom();
  seedText(editor, "hello");
  await settle();
  typeBeforeInput(fakeDom, root, "insertText", "!");
  await settle();

  pressUndo(root);
  await settle();
  assert.equal(markdownOf(editor), "hello");

  pressRedoShiftZ(root);
  await settle();
  assert.equal(markdownOf(editor), "hello!", "Ctrl+Shift+Z 가 재실행해야 한다");

  pressUndo(root);
  await settle();
  assert.equal(markdownOf(editor), "hello");

  pressRedoCtrlY(root);
  await settle();
  assert.equal(markdownOf(editor), "hello!", "Ctrl+Y 가 재실행해야 한다");
});

test("OS 네이티브 beforeinput historyUndo/historyRedo 도 같은 동작을 한다(실측 전제 2의 shim 적용 뒤)", async () => {
  const { editor, root } = makeProductEditor();
  const fakeDom = makeFakeDom();
  seedText(editor, "hello");
  await settle();
  typeBeforeInput(fakeDom, root, "insertText", "!");
  await settle();
  assert.equal(markdownOf(editor), "hello!");

  const undoDefaultPrevented = fireHistoryBeforeInput(root, "historyUndo");
  await settle();
  assert.equal(
    undoDefaultPrevented,
    true,
    "lexical 코어가 beforeinput historyUndo 를 가로채 preventDefault 했어야 한다(CAN_USE_BEFORE_INPUT=true 전제)",
  );
  assert.equal(
    markdownOf(editor),
    "hello",
    "beforeinput historyUndo(OS 네이티브 실행취소)가 되돌려야 한다",
  );

  const redoDefaultPrevented = fireHistoryBeforeInput(root, "historyRedo");
  await settle();
  assert.equal(redoDefaultPrevented, true);
  assert.equal(
    markdownOf(editor),
    "hello!",
    "beforeinput historyRedo(OS 네이티브 재실행)가 다시 실행해야 한다",
  );
});

test("반대 방향: 되돌릴 것이 없을 때 Ctrl+Z 는 본문을 바꾸지 않고 오류도 내지 않는다", async () => {
  const { editor, root } = makeProductEditor();
  seedText(editor, "변하지 않아야 하는 본문");
  await settle();

  assert.doesNotThrow(() => pressUndo(root));
  await settle();
  assert.equal(markdownOf(editor), "변하지 않아야 하는 본문");
});

test("단축키바 칩(공백 없는 '굵게') 삽입 1회 → Ctrl+Z 한 번 = 그 삽입만 되돌린다(원문 손실 0)", async () => {
  const { editor, root } = makeProductEditor();
  seedText(editor, "앞문장 ");
  await settle();

  insertChip(editor, { label: "굵게", text: "** **", caret: 3 });
  await settle();
  assert.equal(markdownOf(editor), "앞문장 ** **");

  pressUndo(root);
  await settle();
  assert.equal(
    markdownOf(editor),
    "앞문장 ",
    "칩이 넣은 서식 문자열만 지워지고 그 앞 본문은 그대로여야 한다",
  );
});

test("단축키바 칩('목록') 삽입 1회 → Ctrl+Z 한 번 = 그 삽입만 되돌린다(공백 흘림 포함)", async () => {
  const { editor, root } = makeProductEditor();
  seedText(editor, "앞문장 ");
  await settle();

  insertChip(editor, { label: "목록", text: "-", space: true });
  await settle();
  assert.equal(markdownOf(editor), "앞문장 - ");

  pressUndo(root);
  await settle();
  assert.equal(
    markdownOf(editor),
    "앞문장 ",
    "칩 본문과 칩이 흘린 공백이 한 undo 단위로 같이 되돌려져야 한다",
  );
});

// 〔직접〕실측 예외(결과 파일에도 적는다): 체크박스 칩만 "본문 삽입"과
// "공백 삽입"이 서로 다른 undo 단계로 쌓인다(굵게·목록과 다름) -- 1회째는
// 공백만 지운다. product_scope 가 이 라운드에서 shortcut-bar.mjs 변경을
// 허용하지 않아 고치지 않고 있는 그대로 등재한다(지시서 §2-4 와 달리 실제
// 데이터 손실은 두 undo 어느 단계에서도 없다 -- 그 앞 "앞문장 "은 항상
// 그대로다).
test("〔직접〕예외: '체크박스' 칩은 Ctrl+Z 한 번으로는 흘린 공백만 지워진다(2회째에 칩 본문까지 복원, 원문 손실은 0)", async () => {
  const { editor, root } = makeProductEditor();
  seedText(editor, "앞문장 ");
  await settle();

  insertChip(editor, { label: "체크박스", text: "- [ ]", space: true });
  await settle();
  assert.equal(markdownOf(editor), "앞문장 - [ ] ");

  pressUndo(root);
  await settle();
  assert.equal(
    markdownOf(editor),
    "앞문장 - [ ]",
    "실측: 1회째는 칩이 흘린 공백만 지운다(목록/제목 칩과 다른 모양)",
  );

  pressUndo(root);
  await settle();
  assert.equal(
    markdownOf(editor),
    "앞문장 ",
    "2회째로 칩 본문까지 전부 되돌아간다 -- 두 undo 모두에서 그 앞 본문은 손실되지 않는다",
  );
});

test("마크다운 자동 서식('# ' -> heading) 뒤 Ctrl+Z 한 번 = 서식만 되돌리고 원문(raw '# ')은 손실 0", async () => {
  const { editor, root } = makeProductEditor();
  const fakeDom = makeFakeDom();

  typeBeforeInput(fakeDom, root, "insertText", "#");
  await settle();
  typeBeforeInput(fakeDom, root, "insertText", " ");
  await settle();
  assert.equal(markdownOf(editor), "# ");
  assert.equal(
    editor
      .getEditorState()
      .read(() => lexical.$getRoot().getFirstChild().getType()),
    "heading",
    "사전 조건: '# ' 가 헤딩으로 서식됐어야 한다",
  );

  pressUndo(root);
  await settle();
  assert.equal(
    markdownOf(editor),
    "# ",
    "서식만 되돌려져야 한다 -- 원문 '# ' 글자는 그대로 남아야 한다(원문 손실 0)",
  );
  assert.equal(
    editor
      .getEditorState()
      .read(() => lexical.$getRoot().getFirstChild().getType()),
    "paragraph",
    "되돌린 뒤에는 평범한 문단이어야 한다(헤딩 서식이 풀림)",
  );
});

test("실행취소 뒤에도 자동저장 결선이 끊기지 않는다(되돌린 본문이 저장된다)", async () => {
  const { editor, root } = makeProductEditor();
  const adapter = createFakeAdapter();
  const notice = { hidden: true, textContent: "" };
  const store = mountStorage(editor, notice, adapter, {}, null);
  await store.initialRestoreReady;

  const fakeDom = makeFakeDom();
  seedText(editor, "a");
  await settle();
  typeBeforeInput(fakeDom, root, "insertText", "b");
  await settle();
  assert.equal(markdownOf(editor), "ab");
  assert.equal(store.getBody(), "ab", "타이핑 직후 저장 원문이 'ab' 여야 한다");

  pressUndo(root);
  await settle();
  assert.equal(markdownOf(editor), "a");
  assert.equal(
    store.getBody(),
    "a",
    "실행취소로 되돌린 본문도 자동저장 결선을 타고 저장돼야 한다(결선이 안 끊긴다)",
  );
});

test("E20 카운터: beforeinput historyUndo(OS 네이티브)는 세고, Ctrl+Z(키보드)는 안 센다(§1 ORCH 관찰 실측 확인)", async () => {
  window.localStorage.clear();
  const { editor, root } = makeProductEditor();
  const fakeDom = makeFakeDom();
  seedText(editor, "hello");
  await settle();

  typeBeforeInput(fakeDom, root, "insertText", "!");
  await settle();
  pressUndo(root);
  await settle();
  assert.equal(
    markdownOf(editor),
    "hello",
    "사전 조건: Ctrl+Z 가 실제로 되돌렸어야 한다",
  );
  assert.equal(
    readRecentWeeks().thisWeek.undos,
    0,
    "실측: Ctrl+Z 는 keydown 에서 바로 UNDO_COMMAND 로 가므로 beforeinput 을 거치지 않는다 -- E20 실행취소 카운터는 0이어야 한다",
  );

  typeBeforeInput(fakeDom, root, "insertText", "!");
  await settle();
  fireHistoryBeforeInput(root, "historyUndo");
  await settle();
  assert.equal(
    markdownOf(editor),
    "hello",
    "사전 조건: beforeinput historyUndo 도 실제로 되돌렸어야 한다",
  );
  assert.equal(
    readRecentWeeks().thisWeek.undos,
    1,
    "실측: beforeinput historyUndo(OS 네이티브 실행취소)는 그대로 카운터에 잡혀야 한다",
  );
});

// 〔직접·jsdom 한계〕(위 "실측 한계 3"): 실제 한글 IME 조합과 실행취소의
// 진짜 상호작용은 못 잰다. 여기서는 jsdom이 흉내 낼 수 있는 범위(조합 중
// OS 네이티브 historyUndo beforeinput)만 -- 오류를 던지지 않고 조합 상태가
// 정상적으로 풀리는지를 확인한다.
test("〔직접·jsdom 한계〕한글 조합 중 OS 네이티브 historyUndo 가 와도 오류를 던지지 않고 조합 상태가 깨지지 않는다", async () => {
  const { editor, root } = makeProductEditor();
  seedText(editor, "안녕");
  await settle();

  root.dispatchEvent(
    new window.CompositionEvent("compositionstart", {
      data: "",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(editor.isComposing(), true, "사전 조건: 조합 중이어야 한다");

  assert.doesNotThrow(() => fireHistoryBeforeInput(root, "historyUndo"));
  await settle();

  root.dispatchEvent(
    new window.CompositionEvent("compositionend", {
      data: "",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(
    editor.isComposing(),
    false,
    "historyUndo 를 겪은 뒤에도 조합 종료가 정상적으로 isComposing 을 false 로 되돌려야 한다",
  );
});
