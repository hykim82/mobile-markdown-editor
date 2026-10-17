// HYK-304-saved-indicator-1(coder-task.md §2): 수용 기준 4(ⓐⓑⓒⓓ)+ⓔ --
// 자동저장 성공/실패/재시도/빈 메모에서 "저장됨" 조용한 표시가 뜨고
// 내려가는지를 "실제 production 결선"(createMemoStore 의 onStatusChange
// 훅 -> storage-mount.mjs 의 mountStorage -> save-indicator.mjs, 셋 다
// 복제 없이 그대로)으로 잰다.
//
// 〔직접〕 app.mjs 를 esbuild 로 다시 부팅(test/support/app-harness.mjs)해
// 실제 키 입력으로 1초 디바운스 자동저장을 재는 기존 시험은 이 저장소에
// 없다 -- app-wiring.test.mjs/first-paint*.test.mjs 는 전부 seedMemo(미리
// 데이터만 심기)나 makeProductEditor()+editor.update()(편집기 상태를
// 직접 바꾸기)로만 "입력"을 만든다. jsdom 의 contenteditable 은 실제
// 키보드 입력을 흉내 내지 않으므로(브라우저 네이티브 입력 처리가 없다),
// 이 저장소 어떤 시험도 bootApp() 위에서 "진짜 타이핑"을 하지 않는다.
// 같은 선례를 따라 이 시험도 editor 자체는 쓰지 않고(저장소 상태 전이가
// 전부 memo-store.mjs 안에 있으므로, mountStorage 가 돌려주는 store의
// onContentChange 를 memo-store.test.mjs 와 같은 방식으로 직접 부른다),
// save-indicator 엘리먼트는 public/index.html 실물 마크업에서 그대로
// 읽어 온다(합성 DOM 아님 -- id 오타·CSS 자리 누락도 이 시험이 잡는다).
// 디바운스 1초는 node:test 의 가짜 시계(t.mock.timers)로 결정론적으로
// 통과한다(evidence_rule: 실제 대기 금지).
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { IDBObjectStore } from "fake-indexeddb";
import { makeProductEditor } from "../support/make-editor.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";
import { mountStorage } from "../../src/editor/storage-mount.mjs";
import { bootApp, waitFor } from "../support/app-harness.mjs";
import {
  installBeforeInputShims,
  typeBeforeInput,
} from "../support/bundle-typing.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = join(here, "..", "..", "public", "index.html");

async function loadSaveIndicatorEl() {
  const html = await readFile(indexHtmlPath, "utf8");
  const dom = new JSDOM(html);
  const el = dom.window.document.getElementById("save-indicator");
  assert.ok(
    el,
    "public/index.html 에 #save-indicator 가 없다 -- 마크업 자리가 사라졌다",
  );
  return el;
}

function isVisible(el) {
  return el.classList.contains("is-visible");
}

async function settle() {
  // fake-adapter.mjs 의 put/get 은 전부 순수 async 함수(실제 타이머 없음) --
  // memo-store.test.mjs 와 같은 모양으로 마이크로태스크 몇 틱만 흘려보내면
  // 충분하다.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("ⓐ 입력 → 1초 디바운스 저장 성공 → '저장됨' 보임", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const indicator = await loadSaveIndicatorEl();
  const adapter = createFakeAdapter();
  const { editor } = makeProductEditor();
  const notice = { hidden: true, textContent: "" };
  const store = mountStorage(editor, notice, adapter, {}, indicator);

  assert.equal(
    isVisible(indicator),
    false,
    "부팅 직후(아직 저장 전)에는 보이면 안 된다",
  );

  await store.onContentChange("a"); // 생성(= 첫 글자) 은 디바운스 없이 즉시 저장
  assert.equal(store.getStatus(), "ok");
  assert.equal(
    isVisible(indicator),
    true,
    "즉시 저장(생성) 성공 뒤 보여야 한다",
  );

  // 이제부터는 "이미 있는 메모"를 고쳐 실제 1초 디바운스 경로를 탄다.
  store.onContentChange("ab"); // await 하지 않음 -- 디바운스 대기, 캐럿은 저장을 안 기다린다
  assert.equal(
    isVisible(indicator),
    true,
    "ⓔ: 디바운스 대기 중(아직 저장 결과가 안 나옴)에는 지난 성공 표시를 그대로 둔다 -- 매 입력마다 내렸다 올리면 더 거슬린다(PRD §6)",
  );

  t.mock.timers.tick(999);
  await settle();
  assert.equal(
    isVisible(indicator),
    true,
    "999ms(아직 디바운스 전)에도 지난 표시가 그대로여야 한다",
  );

  t.mock.timers.tick(1);
  // tick() 은 due 콜백(performSave 의 동기 구간, 첫 await 전까지)을 바로
  // 실행한다 -- 그 시점 상태는 "saving" 인데, 이 상태는 save-indicator.mjs 가
  // 손대지 않는 상태라(ⓔ) 여기서도 표시가 그대로인지 같이 확인한다.
  assert.equal(
    store.getStatus(),
    "saving",
    "tick() 직후(마이크로태스크 전)에는 아직 saving 이어야 한다",
  );
  assert.equal(
    isVisible(indicator),
    true,
    "saving 전이 상태에서도 지난 표시를 내리지 않아야 한다(ⓔ)",
  );

  await settle();
  assert.equal(store.getStatus(), "ok");
  assert.equal(
    isVisible(indicator),
    true,
    "1000ms 뒤 디바운스 저장이 성공하면 '저장됨'이 보여야 한다",
  );
});

test("ⓑ 저장 실패 주입 → '저장됨' 안 보임(입력이 계속돼도 실패 동안 다시 안 보임)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const indicator = await loadSaveIndicatorEl();
  const adapter = createFakeAdapter();
  const { editor } = makeProductEditor();
  const notice = { hidden: true, textContent: "" };
  const store = mountStorage(editor, notice, adapter, {}, indicator);

  await store.onContentChange("a");
  assert.equal(
    isVisible(indicator),
    true,
    "사전 조건: 첫 저장은 성공해 보여야 한다",
  );

  adapter.forceNextPutFailures(2); // 첫 시도 + 재시도 1회 모두 실패
  store.onContentChange("ab");
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(store.getStatus(), "failed");
  assert.equal(
    isVisible(indicator),
    false,
    "저장 실패 뒤에는 '저장됨'이 내려가야 한다(PRD §8 '미표시로 알림')",
  );

  // 실패 동안 입력이 계속돼도(=다음 디바운스 사이클도 계속 실패) 다시
  // 쓰이지(=깜빡이며 다시 보이지) 않아야 한다.
  adapter.forceNextPutFailures(2);
  store.onContentChange("abc");
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(store.getStatus(), "failed");
  assert.equal(
    isVisible(indicator),
    false,
    "실패가 이어지는 동안에는 계속 안 보여야 한다",
  );
});

test("ⓒ 재시도 성공 → '저장됨' 다시 보임", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const indicator = await loadSaveIndicatorEl();
  const adapter = createFakeAdapter();
  const { editor } = makeProductEditor();
  const notice = { hidden: true, textContent: "" };
  const store = mountStorage(editor, notice, adapter, {}, indicator);

  await store.onContentChange("a");
  adapter.forceNextPutFailures(2);
  store.onContentChange("ab");
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(store.getStatus(), "failed");
  assert.equal(
    isVisible(indicator),
    false,
    "사전 조건: 실패 뒤엔 안 보여야 한다",
  );

  store.onContentChange("abc"); // 다음 입력(정책 "입력마다 재시도") -- 이번엔 실패 주입 없음
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(store.getStatus(), "ok");
  assert.equal(
    isVisible(indicator),
    true,
    "재시도(다음 입력의 새 저장 사이클)가 성공하면 '저장됨'이 복귀해야 한다",
  );
});

test("ⓓ 빈 메모(첫 글자 전 · 전부 지워 빈 문자열) → '저장됨' 표시 0", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const indicatorBeforeAnyInput = await loadSaveIndicatorEl();
  const adapterA = createFakeAdapter();
  const { editor: editorA } = makeProductEditor();
  mountStorage(
    editorA,
    { hidden: true, textContent: "" },
    adapterA,
    {},
    indicatorBeforeAnyInput,
  );
  assert.equal(
    isVisible(indicatorBeforeAnyInput),
    false,
    "첫 글자 입력 전(빈 메모)에는 표시가 없어야 한다",
  );

  const indicator = await loadSaveIndicatorEl();
  const adapter = createFakeAdapter();
  const { editor } = makeProductEditor();
  const store = mountStorage(
    editor,
    { hidden: true, textContent: "" },
    adapter,
    {},
    indicator,
  );
  await store.onContentChange("a");
  assert.equal(
    isVisible(indicator),
    true,
    "사전 조건: 저장 성공 뒤엔 보여야 한다",
  );

  await store.onContentChange(""); // 전부 지워 빈 문자열 -- 하드 삭제 경로(memo-store.mjs clearToEmpty), 상태 idle
  assert.equal(store.getStatus(), "idle");
  assert.equal(
    isVisible(indicator),
    false,
    "빈 메모로 돌아가면 '저장됨'이 다시 내려가야 한다",
  );
});

test("저장공간 부족(quota-exceeded)도 실패와 같이 '저장됨'이 안 보인다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const indicator = await loadSaveIndicatorEl();
  const adapter = createFakeAdapter();
  const { editor } = makeProductEditor();
  const store = mountStorage(
    editor,
    { hidden: true, textContent: "" },
    adapter,
    {},
    indicator,
  );

  await store.onContentChange("a");
  assert.equal(
    isVisible(indicator),
    true,
    "사전 조건: 첫 저장 성공 뒤엔 보여야 한다",
  );

  const quotaError = Object.assign(new Error("no space"), {
    name: "QuotaExceededError",
  });
  adapter.forceNextPutFailures(2, quotaError);
  store.onContentChange("ab");
  t.mock.timers.tick(1000);
  await settle();

  assert.equal(store.getStatus(), "quota-exceeded");
  assert.equal(
    isVisible(indicator),
    false,
    "PRD §8 '저장공간 부족'도 자동저장 실패와 같이 미표시가 돼야 한다",
  );
});

// P2-1(coder-task.md §2-1, 검토 1R P2-1): 위 ⓐ~ⓑ 등은 전부 mountStorage
// 를 직접 불러 memo-store 의 onStatusChange 훅만 재므로, app.mjs(브라우저
// 엔트리)의 grabElements/mountStorage 결선 자체가 끊겨도 빨개지지 않는다
// (검토자 변이 M1·M2 실측, REVIEW-r1.md §2 P2-1). 이 칸은 bootApp() 으로
// 실제 app.mjs 번들을 부팅하고, 번들 안 Lexical 에 진짜 beforeinput 을
// 쏴 그 결선을 직접 잰다.
test("P2-1 번들 경로: 실제 app.mjs 결선 위에서 타이핑 → 저장 성공 → '저장됨' 보임, 실패 → 안 보임", async () => {
  const dom = await bootApp({ seed: (d) => installBeforeInputShims(d) });
  const { document } = dom.window;
  await waitFor(
    () => document.querySelector("#list-root .memo-list-empty") !== null,
  );
  document.getElementById("new-memo-button").click();
  await waitFor(
    () => document.getElementById("editor-screen").hidden === false,
  );

  const root = document.getElementById("editor-root");
  const indicator = document.getElementById("save-indicator");
  assert.equal(
    isVisible(indicator),
    false,
    "사전 조건: 부팅 + 새 메모 직후(아직 저장 전)에는 안 보여야 한다",
  );

  // 첫 글자(=생성) 는 디바운스 없이 즉시 저장된다(memo-store.mjs
  // createNewMemo 주석) -- 1초 대기 없이 바로 결과를 볼 수 있다.
  typeBeforeInput(dom, root, "insertText", "a");
  await waitFor(() => isVisible(indicator) === true);
  assert.equal(
    isVisible(indicator),
    true,
    "실제 번들 결선 위에서 타이핑 → 저장 성공 뒤 '저장됨'이 보여야 한다(M1·M2 가 이 칸을 RED 로 만든다)",
  );

  // 실패 경로(권장): 다음 저장(디바운스 1초) 의 put 을 강제로 실패시켜
  // (app-wiring.test.mjs 배선 7 과 같은 몽키패치 방식) 결선이 실패 상태도
  // 그대로 반영하는지 본다.
  const originalPut = IDBObjectStore.prototype.put;
  let failuresLeft = 2; // 첫 시도 + 즉시 재시도 1회 모두 실패 -> "failed"
  IDBObjectStore.prototype.put = function patchedPut(...args) {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("save-indicator P2-1: 강제 저장 실패");
    }
    return originalPut.apply(this, args);
  };
  try {
    typeBeforeInput(dom, root, "insertText", "b");
    await waitFor(() => isVisible(indicator) === false, { timeout: 5000 });
    assert.equal(
      isVisible(indicator),
      false,
      "실제 번들 결선 위에서 저장 실패 뒤에는 '저장됨'이 내려가야 한다",
    );
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
});

// P2-2(coder-task.md §2-2, 검토 1R P2-2): E3(PR #42) 의 "닫기 버튼 44px
// 규칙 단언"(test/editor/first-run-notice.test.mjs ⑩)과 같은 모양으로,
// "보임" 을 만드는 CSS 규칙 자체를 출하 파일에서 읽어 고정한다 -- 지금은
// 작성자 시험·탐침 둘 다 `.is-visible` class 유무만 보므로(jsdom 은
// 실제 opacity 계산을 하지 않는다, REVIEW-r1.md §2 P2-2), 이 규칙 3줄이
// 통째로 지워져도(변이 M3) 어떤 시험도 빨개지지 않았다.
test("P2-2 CSS 보임 규칙 단언: #save-indicator 기본 숨김 + .is-visible 이 opacity: 1 로 고정돼 있다", async () => {
  const html = await readFile(indexHtmlPath, "utf8");
  const withoutComments = html.replace(/\/\*[\s\S]*?\*\//g, "");

  const baseRule = withoutComments.match(/#save-indicator\s*\{([^}]*)\}/);
  assert.ok(baseRule, "#save-indicator 기본 규칙이 출하 CSS 에 있어야 한다");
  assert.match(
    baseRule[1],
    /opacity\s*:\s*0/,
    "기본 상태는 opacity: 0 으로 숨겨져 있어야 한다",
  );
  assert.match(
    baseRule[1],
    /transition\s*:\s*opacity\s+200ms/,
    "전환은 design-tokens.json motion.duration.base(200ms) 값 그대로여야 한다",
  );

  const visibleRule = withoutComments.match(
    /#save-indicator\.is-visible\s*\{([^}]*)\}/,
  );
  assert.ok(
    visibleRule,
    "#save-indicator.is-visible 규칙이 출하 CSS 에 있어야 한다(지워지면(M3) 여기서 바로 빨개진다)",
  );
  assert.match(
    visibleRule[1],
    /opacity\s*:\s*1/,
    "#save-indicator.is-visible 은 opacity: 1 로 고정돼 있어야 한다",
  );
});

// P3-1(coder-task.md §2-3, 검토 1R P3-1): 작성자 ⓐ 칸(이 파일 맨 위)은
// "saving" 유지만 단언한다 -- 첫 put 실패로 상태가 "retrying"(즉시
// 재시도 put 이 진행 중)인 창에서도 지난 성공 표시가 유지되는지는 아무
// 칸도 값으로 재지 않았다(변이 M4: retrying 도 내리게 하면 작성자 5건·
// 탐침 14건 모두 생존, REVIEW-r1.md §2 P3-1). 재시도 put 을 수동으로
// 멈춰 세워 그 창 자체를 값으로 잡는다.
test("P3-1 retrying 유지: 첫 실패 뒤 재시도 put 이 진행 중인 동안에도 '저장됨' 표시가 유지된다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const indicator = await loadSaveIndicatorEl();
  const adapter = createFakeAdapter();
  const { editor } = makeProductEditor();
  const notice = { hidden: true, textContent: "" };
  const store = mountStorage(editor, notice, adapter, {}, indicator);

  await store.onContentChange("a");
  assert.equal(
    isVisible(indicator),
    true,
    "사전 조건: 첫 저장 성공 뒤엔 보여야 한다",
  );

  const originalPut = adapter.put;
  let putCallCount = 0;
  let releaseRetryPut;
  adapter.put = async (memo) => {
    putCallCount += 1;
    if (putCallCount === 1) {
      throw new Error("P3-1: forced first failure"); // 첫 시도 실패 -> retrying
    }
    // 두 번째 시도(즉시 재시도) -- 바깥에서 release 할 때까지 멈춰, 그
    // 사이 상태가 "retrying" 인 창을 값으로 관찰한다.
    await new Promise((resolve) => {
      releaseRetryPut = resolve;
    });
    return originalPut(memo);
  };

  store.onContentChange("ab");
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(
    store.getStatus(),
    "retrying",
    "재시도 put 이 진행 중(아직 응답 전)이어야 한다",
  );
  assert.equal(
    isVisible(indicator),
    true,
    "retrying 동안에는 지난 성공 표시를 내리면 안 된다(coder-task.md §2-4-ⓔ, 변이 M4 가 이 칸을 RED 로 만든다)",
  );

  releaseRetryPut();
  await settle();
  assert.equal(store.getStatus(), "ok");
  assert.equal(
    isVisible(indicator),
    true,
    "재시도가 성공하면 표시는 그대로 보임을 유지한다",
  );
});

// P3-2(coder-task.md §2-4, 책임자 판정 2026-10-17 22:4x 판단 2): opacity
// 로만 숨긴 "저장됨"은 화면 낭독기에는 계속 읽힌다(REVIEW-r1.md §2 P3-2)
// -- PRD §8 "미표시로 알림"이 낭독기 사용자에게도 성립하려면 숨김 상태엔
// aria-hidden="true", 보임 상태엔 그 속성을 지워야 한다. aria-hidden 을
// 지우는 쪽을 택했다(값을 "false" 로 남기는 대신) -- 보이는 상태는
// 접근성 트리에서도 "평범한 보이는 엘리먼트"와 같아야 하고, 속성을 지우면
// 그 상태를 "false" 라는 값으로 흉내 내는 것보다 더 분명하다(선택 근거).
test("P3-2 aria-hidden 토글: 숨김 상태엔 aria-hidden=true, 보임(ok) 상태엔 지운다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const indicator = await loadSaveIndicatorEl();
  assert.equal(
    indicator.getAttribute("aria-hidden"),
    "true",
    "public/index.html 의 초기 마크업도 첫 화면 숨김 상태와 맞아야 한다",
  );

  const adapter = createFakeAdapter();
  const { editor } = makeProductEditor();
  const notice = { hidden: true, textContent: "" };
  const store = mountStorage(editor, notice, adapter, {}, indicator);

  await store.onContentChange("a");
  assert.equal(store.getStatus(), "ok");
  assert.equal(
    indicator.hasAttribute("aria-hidden"),
    false,
    "저장 성공(ok) 뒤에는 aria-hidden 을 지워 화면 낭독기에도 '저장됨'이 드러나야 한다(변이: 토글 제거 → RED)",
  );

  adapter.forceNextPutFailures(2);
  store.onContentChange("ab");
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(store.getStatus(), "failed");
  assert.equal(
    indicator.getAttribute("aria-hidden"),
    "true",
    "저장 실패(failed) 뒤에는 aria-hidden=true 로 화면 낭독기에서도 숨어야 한다(PRD §8 '미표시로 알림'이 낭독기 사용자에게도 성립해야 한다, 책임자 판정 2026-10-17 22:4x)",
  );

  const quotaError = Object.assign(new Error("no space"), {
    name: "QuotaExceededError",
  });
  // 실패 뒤 다음 입력이 성공하면 다시 지워져야 한다(ⓒ 와 같은 경로).
  store.onContentChange("abc");
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(store.getStatus(), "ok");
  assert.equal(
    indicator.hasAttribute("aria-hidden"),
    false,
    "재시도 성공 뒤엔 aria-hidden 도 다시 지워져야 한다",
  );

  adapter.forceNextPutFailures(2, quotaError);
  store.onContentChange("abcd");
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(store.getStatus(), "quota-exceeded");
  assert.equal(
    indicator.getAttribute("aria-hidden"),
    "true",
    "저장공간 부족(quota-exceeded)도 실패와 같이 aria-hidden=true 여야 한다",
  );
});
