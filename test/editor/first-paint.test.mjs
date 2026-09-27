// coder-task.md HYK-304-firstpaint-untitled-1 §1: E3 검토자가 실측한 부팅
// 깜빡임 -- "import 직후(동기): list hidden? false editor hidden? true" ->
// "1틱 뒤: list hidden? true editor hidden? false". 목록이 한 틱 보였다가
// 에디터로 바뀌는 그 자체를 값으로 잡는다.
//
// "import 직후(동기)" 시점은 app-harness.mjs 의 seed 훅(JSDOM 이 정적
// public/index.html 을 이미 파싱했지만 app.mjs 번들은 아직 한 줄도
// 실행되지 않은 시점 -- installDomGlobals 뒤, 번들 import 전)에서 읽어야
// 가장 정확하다. bootApp() 이 반환한 뒤에 읽는 방식도 처음엔 써 봤지만,
// 포인터가 없는 분기(restoreCurrentMemo 가 adapter I/O 없이 즉시
// return)는 결정이 순수 프라미스 체인뿐이라 "await import(dataUrl)" 이
// 내부적으로 여러 마이크로태스크를 도는 사이 이미 끝나 버려 그 시점의
// 값이 결정 «전»인지 «후»인지가 실행 환경(동적 import 의 내부 스케줄링)
// 에 따라 갈렸다(실측: 3회 연속 재현되는 결정론적 참패, 요행이 아니다).
// seed 훅에서 읽으면 app.mjs 코드가 "한 줄도" 안 돈 시점이라 이 문제가
// 원천적으로 없다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootApp, waitFor } from "../support/app-harness.mjs";
import { createIndexedDbAdapter } from "../../src/storage/indexeddb-adapter.mjs";
import { writeCurrentMemoId } from "../../src/storage/current-memo-pointer.mjs";

async function seedMemo(id, body) {
  const adapter = createIndexedDbAdapter();
  await adapter.put({
    id,
    title: body,
    body,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
}

// hidden 속성의 "실제 값 변화"만 전환 목록에 담는다(같은 값을 다시 써도
// 잡히는 잡음은 제외) -- "화면이 보이게 되는 일이 화면당 최대 1회"를 이
// 목록의 길이로 잰다.
function attachHiddenObserver(dom, el) {
  const transitions = [];
  const obs = new dom.window.MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName !== "hidden") continue;
      const wasHidden = m.oldValue !== null;
      const isHidden = el.hidden;
      if (wasHidden !== isHidden) transitions.push({ wasHidden, isHidden });
    }
  });
  obs.observe(el, {
    attributes: true,
    attributeFilter: ["hidden"],
    attributeOldValue: true,
  });
  return { obs, transitions };
}

// 포인터가 메모를 가리키는 경우(부팅 후 에디터로 가야 하는 경우) --
// E3 검토자가 실측한 그 시나리오와 동일하다.
test("깜빡임: 포인터가 있어도 import 직후엔 두 화면 다 숨겨져 있고, 결정 후 에디터만 정확히 한 번 나타난다", async () => {
  let baseline;
  let listObs;
  let editorObs;

  const dom = await bootApp({
    seed: async (d) => {
      await seedMemo("flash-editor-1", "깜빡임 확인용 메모");
      writeCurrentMemoId("flash-editor-1");
      const { document } = d.window;
      const listScreen = document.getElementById("list-screen");
      const editorScreen = document.getElementById("editor-screen");
      // 이 시점엔 app.mjs 가 아직 한 줄도 실행되지 않았다(정적 HTML 그대로).
      baseline = { list: listScreen.hidden, editor: editorScreen.hidden };
      listObs = attachHiddenObserver(d, listScreen);
      editorObs = attachHiddenObserver(d, editorScreen);
    },
  });
  const { document } = dom.window;
  const listScreen = document.getElementById("list-screen");
  const editorScreen = document.getElementById("editor-screen");

  assert.deepEqual(
    baseline,
    { list: true, editor: true },
    "import 직후(동기): 두 화면 다 숨겨져 있어야 한다(첫 화면 결정 전에는 무엇도 그려지지 않아야 함)",
  );

  await waitFor(() => editorScreen.hidden === false);
  assert.equal(
    listScreen.hidden,
    true,
    "결정 후: list-screen 은 계속 숨겨져 있어야 한다",
  );
  assert.equal(
    editorScreen.hidden,
    false,
    "결정 후: editor-screen 만 보여야 한다",
  );

  listObs.obs.disconnect();
  editorObs.obs.disconnect();

  assert.deepEqual(
    listObs.transitions,
    [],
    "list-screen 의 hidden 값은 한 번도 실제로 바뀌면 안 된다(깜빡임이면 여기서 false->true 전환이 잡힌다)",
  );
  assert.deepEqual(
    editorObs.transitions,
    [{ wasHidden: true, isHidden: false }],
    "editor-screen 의 hidden 값은 정확히 1회만(hidden->보임) 바뀌어야 한다",
  );
});

// 포인터가 없는 경우(부팅 후 목록으로 가야 하는 경우) -- 반대 분기도
// 같은 불변식을 지키는지 확인한다.
test("깜빡임: 포인터가 없을 때도 import 직후엔 두 화면 다 숨겨져 있고, 결정 후 목록만 정확히 한 번 나타난다", async () => {
  let baseline;
  let listObs;
  let editorObs;

  const dom = await bootApp({
    seed: async (d) => {
      const { document } = d.window;
      const listScreen = document.getElementById("list-screen");
      const editorScreen = document.getElementById("editor-screen");
      baseline = { list: listScreen.hidden, editor: editorScreen.hidden };
      listObs = attachHiddenObserver(d, listScreen);
      editorObs = attachHiddenObserver(d, editorScreen);
    },
  });
  const { document } = dom.window;
  const listScreen = document.getElementById("list-screen");
  const editorScreen = document.getElementById("editor-screen");

  assert.deepEqual(
    baseline,
    { list: true, editor: true },
    "import 직후(동기): 두 화면 다 숨겨져 있어야 한다",
  );

  await waitFor(() => listScreen.hidden === false);
  assert.equal(
    editorScreen.hidden,
    true,
    "결정 후: editor-screen 은 계속 숨겨져 있어야 한다",
  );
  assert.equal(listScreen.hidden, false, "결정 후: list-screen 만 보여야 한다");

  listObs.obs.disconnect();
  editorObs.obs.disconnect();

  assert.deepEqual(
    editorObs.transitions,
    [],
    "editor-screen 의 hidden 값은 한 번도 실제로 바뀌면 안 된다",
  );
  assert.deepEqual(
    listObs.transitions,
    [{ wasHidden: true, isHidden: false }],
    "list-screen 의 hidden 값은 정확히 1회만(hidden->보임) 바뀌어야 한다",
  );
});
