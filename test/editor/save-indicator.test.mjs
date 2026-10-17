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
import { makeProductEditor } from "../support/make-editor.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";
import { mountStorage } from "../../src/editor/storage-mount.mjs";

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
