// 브라우저 엔트리(에스빌드로 번들). 라이브 렌더링 화면(HYK-304-render-1)
// 에 이어 HYK-304-storage-1 이 저장·자동저장을, 이 라운드(HYK-304-
// memo-list-1)가 메모 목록(홈) 화면과 두 화면 오가기를 붙인다 --
// PRD §6/§7/§8, coder-task.md §0.
import tokens from "../../spec/design-tokens.json";
import { serializeEditorToMarkdown } from "./serialize.mjs";
import { createProductEditor } from "./product-editor.mjs";
import { mountStorage, openMemoInEditor } from "./storage-mount.mjs";
import { mountNotionCopy } from "./notion-copy.mjs";
import { mountShortcutBar } from "./shortcut-bar.mjs";
import { mountMemoList } from "./memo-list-mount.mjs";
import { mountFirstRunNotice } from "./first-run-notice.mjs";
import { recordAppOpen, mountUsageStatsCard } from "./usage-metrics.mjs";
import { createIndexedDbAdapter } from "../storage/indexeddb-adapter.mjs";
import { writeCurrentMemoId } from "../storage/current-memo-pointer.mjs";
import { cleanupExpiredDeletes } from "../storage/memo-lifecycle.mjs";
import { registerServiceWorker } from "./sw-register.mjs";

// HYK-304-system-theme-1: 색 토큰 6개(--color-bg·--color-bg-elevated·
// --color-text-primary·--color-text-muted·--color-accent·--color-border)는
// 더 이상 여기서 인라인으로 박지 않는다. element.style.setProperty 는
// documentElement 의 "인라인 스타일"이고, 인라인 스타일은 캐스케이드에서
// 저자 스타일시트의 어떤 선택자보다도 위다(@media 블록 안에 있어도 그
// 미디어가 매치되는 것과 무관하게 인라인이 이긴다) -- 그래서 이 6개를
// 라이트 값으로 인라인에 박아 두면 public/index.html 의
// @media (prefers-color-scheme: dark) 블록이 선언한 다크 값이 영원히
// 가려진다(기준선 실측: 이 함수를 그대로 두고 다크 블록만 추가해 보면
// documentElement 의 getComputedStyle 이 라이트 값에서 안 움직인다).
// 라이트·다크 값은 이제 index.html 의 :root/@media 블록이 전담하고,
// 매체질의는 브라우저가 스스로 다시 그리므로 이 색 6개에는 JS 가 필요
// 없다(결과 파일 §2 근거). 폰트 3개는 테마와 무관해 그대로 둔다.
function applyDesignTokens() {
  const root = document.documentElement;
  root.style.setProperty("--font-family", tokens["font.family"]);
  root.style.setProperty("--font-size-body", tokens["font.size.body"]);
  root.style.setProperty(
    "--line-height-body",
    String(tokens["line.height.body"]),
  );
}

// 결선은 product-editor.mjs 한 곳이다(시험 헬퍼와 같은 함수를 부른다).
function mountEditor(container) {
  return createProductEditor(container, {
    namespace: "mobile-markdown-editor",
    onError: (error) => {
      throw error;
    },
  });
}

function mountRawPanel(editor, panel) {
  const render = () => {
    panel.textContent = serializeEditorToMarkdown(editor);
  };
  editor.registerUpdateListener(render);
  render();
}

// PRD §6 IA "메모 목록(홈)—에디터 2화면". 두 화면은 항상 둘 다 DOM 에
// 있고 hidden 속성만 토글한다(라우팅 라이브러리 없이 의존 0 유지).
function showScreen(screens, name) {
  const showEditor = name === "editor";
  screens.editor.hidden = !showEditor;
  screens.list.hidden = showEditor;
}

function grabElements() {
  return {
    firstRunNotice: {
      element: document.getElementById("first-run-notice"),
      textEl: document.getElementById("first-run-notice-text"),
      closeButton: document.getElementById("first-run-notice-close-button"),
    },
    editorRoot: document.getElementById("editor-root"),
    rawPanel: document.getElementById("raw-panel"),
    saveNotice: document.getElementById("save-notice"),
    saveIndicator: document.getElementById("save-indicator"),
    copyButton: document.getElementById("notion-copy-button"),
    copyToast: document.getElementById("notion-copy-toast"),
    shortcutBar: document.getElementById("shortcut-bar"),
    listRoot: document.getElementById("list-root"),
    listDeleteToast: document.getElementById("list-delete-toast"),
    listDeleteToastText: document.getElementById("list-delete-toast-text"),
    listUndoButton: document.getElementById("list-delete-undo-button"),
    listSaveErrorButton: document.getElementById("list-save-error-button"),
    newMemoButton: document.getElementById("new-memo-button"),
    backButton: document.getElementById("back-to-list-button"),
    // HYK-304-usage-metrics-1: 목록 제목 길게 누르기로만 열리는 숨은
    // 통계 카드(usage-metrics.mjs 의 mountUsageStatsCard 가 결선 전부를
    // 맡는다 -- 여기는 DOM 참조 셋을 모으기만 한다).
    usageStats: {
      trigger: document.querySelector("#list-screen .topbar h1"),
      card: document.getElementById("usage-stats-card"),
      closeButton: document.getElementById("usage-stats-close-button"),
    },
    screens: {
      list: document.getElementById("list-screen"),
      editor: document.getElementById("editor-screen"),
    },
  };
}

// "+"(새 메모)·뒤로가기(PRD §6 "에디터 뒤로→목록(자동저장)") 배선.
// 목록 카드 클릭(다른 메모 열기)은 mountMemoList 의 onOpen 콜백(아래
// main())이 맡는다 -- 이 함수는 그와 짝이 되는 나머지 두 진입점이다.
function wireListNavigation({ newMemoButton, backButton, screens }, ctx) {
  const { editor, store, adapter, list } = ctx;
  newMemoButton.addEventListener("click", () => {
    openMemoInEditor(editor, store, adapter, store.restoreState, null).then(
      () => showScreen(screens, "editor"),
    );
  });
  backButton.addEventListener("click", () => {
    store
      .flushImmediate()
      .then(() => writeCurrentMemoId(store.getMemoId()))
      .finally(() => {
        list.refresh();
        showScreen(screens, "list");
      });
  });
}

function main() {
  applyDesignTokens();
  const elements = grabElements();
  // HYK-304-usage-metrics-1: 앱 시작 1회당 1(메모 내용·네트워크 전송 0).
  recordAppOpen();
  mountUsageStatsCard(elements.usageStats);
  // PRD §5b "최초 실행 1회 고지": 동기 호출이고(localStorage 읽기만,
  // await 없음) 입력을 막지 않는 배너라 그 뒤 에디터 마운트·입력 가능
  // 시점과 경합하지 않는다(실행→입력 1초 NFR, first-run-notice.mjs
  // 머리 주석).
  mountFirstRunNotice(elements.firstRunNotice);
  const adapter = createIndexedDbAdapter();
  // HYK-304-lifecycle-orphans-1 ⓐ: 저장소를 연 직후 · 입력과는 독립으로
  // soft-delete 고아(유예가 이미 지난 레코드)를 지운다. list.refresh()
  // 는 이 정리가 끝나길 기다리지 않는다(아래에서 먼저 fire-and-forget 으로
  // 불러 두므로) -- 어차피 그 레코드는 list-query.mjs 필터로 목록에서
  // 이미 숨어 있어 정리 시점과 화면은 무관하다. .catch 로 실패를 삼켜
  // 입력을 막지 않는다(실행→입력 1초 NFR, cleanupExpiredDeletes 자신도
  // 개별 실패를 이미 삼키지만 이중 방어).
  cleanupExpiredDeletes(adapter).catch(() => {});
  const editor = mountEditor(elements.editorRoot);
  mountRawPanel(editor, elements.rawPanel);
  // 한용 확정 ㄱ(HYK-304-home-list-updatedat-1): 앱을 열면 첫 화면은 항상
  // 목록이다. 마지막 메모 포인터는 시작 시 비운다 -- mountStorage 안의
  // restoreCurrentMemo 가 이 동기 시점에 포인터를 읽으므로 여기서 지우면
  // 그 복원은 아무것도 불러오지 않는다. 포인터를 살려 두면 복원이 목록에서
  // 카드를 누른 뒤에 끝나 그 메모를 옛 메모로 덮어쓸 수 있다(경합). 메모
  // 데이터(IndexedDB)는 그대로이고, 포인터는 열려 있는 메모를 적는 용도로만
  // 남는다(openMemoInEditor·자동저장이 다시 쓴다).
  writeCurrentMemoId(null);
  const store = mountStorage(
    editor,
    elements.saveNotice,
    adapter,
    {},
    elements.saveIndicator,
  );
  mountNotionCopy(editor, store, {
    button: elements.copyButton,
    toast: elements.copyToast,
  });
  mountShortcutBar(editor, elements.shortcutBar);

  const list = mountMemoList(elements.listRoot, adapter, {
    onOpen: (id) =>
      openMemoInEditor(editor, store, adapter, store.restoreState, id).then(
        () => showScreen(elements.screens, "editor"),
      ),
    toast: {
      element: elements.listDeleteToast,
      textEl: elements.listDeleteToastText,
      undoButton: elements.listUndoButton,
      errorButton: elements.listSaveErrorButton,
    },
  });
  wireListNavigation(elements, { editor, store, adapter, list });

  // PRD §5b "입력이 목록 로딩을 안 기다린다": mountStorage 가 이미
  // registerUpdateListener 를 동기로 등록했으므로(에디터는 지금부터
  // 입력 가능) 목록 조회를 기다리지 않는다 -- fire-and-forget 이고, 화면은
  // 목록을 동기로 연다(PRD §6 "메모 목록(홈)"). 포인터를 이미 비웠으므로
  // 초기 복원(initialRestoreReady)은 아무 일도 하지 않아 기다릴 것이 없다.
  list.refresh();
  showScreen(elements.screens, "list");
  // PWA 설치 가능(HYK-304-pwa-installable-1 §2 요구 4): 위 동기 구간이
  // 이미 끝난 뒤에 등록을 미룬다(sw-register.mjs 머리 주석 근거).
  registerServiceWorker();
}

main();
