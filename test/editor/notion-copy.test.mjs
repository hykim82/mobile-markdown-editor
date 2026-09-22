// PRD §5.4 "노션 복사" -- coder-task.md §1.
//
// ⭐표제 축(coder-task.md 파일 머리 불변식): 클립보드에 "실제로 들어간
// 바이트"가 원문 필드의 바이트와 "같다". 이 파일의 모든 성공 경로
// 시험은 가짜 클립보드로 넘긴 값을 "썼다"에서 멈추지 않고, 넘겨받은
// 값 자체를 원문과 바이트 단위로(Buffer.equals) 비교한다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { makeProductEditor } from "../support/make-editor.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";
import { createMemoStore } from "../../src/storage/memo-store.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";
import {
  getNotionCopyBody,
  isNotionCopyDisabled,
  performNotionCopy,
  mountNotionCopy,
} from "../../src/editor/notion-copy.mjs";

function assertByteIdentical(actual, expected, message) {
  assert.equal(actual, expected, message);
  assert.ok(
    Buffer.from(actual, "utf8").equals(Buffer.from(expected, "utf8")),
    `${message} (바이트 비교)`,
  );
}

function makeFakeClipboard() {
  const writes = [];
  return {
    writes,
    writeText: async (text) => {
      writes.push(text);
    },
  };
}

function makeFailingClipboard(error) {
  return {
    writeText: async () => {
      throw error ?? new Error("fake clipboard: forced writeText failure");
    },
  };
}

// -- (1) 원문 필드가 출처임을 단정하는 시험 --------------------------------
//
// getNotionCopyBody/performNotionCopy 는 store 만 받는다(editor 인자 자체가
// 없다) -- 그래서 "에디터를 다시 직렬화"할 방법이 함수 시그니처 수준에서
// 없다. 이 시험은 store.getBody() 가 실제 에디터 렌더링 결과와 "다른"
// 값을 돌려주는 상황을 만들어, 복사된 값이 그 불일치 상황에서도 여전히
// store 쪽 값과 같음을(=렌더링 경로를 안 탐을) 단정한다.
test("복사 값의 출처는 원문 필드(store.getBody())다 -- 에디터를 다시 직렬화한 값과 store 값이 달라도 store 값이 나간다", async () => {
  const { editor } = makeProductEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createTextNode("에디터 렌더링 쪽 텍스트(복사되면 안 됨)"),
      );
      root.append(paragraph);
    },
    { discrete: true },
  );
  assert.equal(
    serializeEditorToMarkdown(editor),
    "에디터 렌더링 쪽 텍스트(복사되면 안 됨)",
  );

  const fakeStore = { getBody: () => "원문 필드 쪽 텍스트(이게 복사돼야 함)" };
  const clipboard = makeFakeClipboard();

  const copied = await performNotionCopy(fakeStore, clipboard);

  assertByteIdentical(
    copied,
    "원문 필드 쪽 텍스트(이게 복사돼야 함)",
    "복사 값은 store.getBody() 여야 한다",
  );
  assertByteIdentical(
    clipboard.writes[0],
    "원문 필드 쪽 텍스트(이게 복사돼야 함)",
    "클립보드에 실제로 들어간 값도 store.getBody() 여야 한다",
  );
  assert.notEqual(
    clipboard.writes[0],
    serializeEditorToMarkdown(editor),
    "에디터 재직렬화 값이 우연히 나가지 않았음을 재확인",
  );
});

test("getNotionCopyBody 는 store.getBody() 를 그대로 반환한다(가공 없음)", () => {
  const fakeStore = { getBody: () => "그대로 반환돼야 함 **굵게** 아님" };
  assert.equal(
    getNotionCopyBody(fakeStore),
    "그대로 반환돼야 함 **굵게** 아님",
  );
});

// -- (4) 빈 본문일 때 버튼 비활성 ------------------------------------------
// "원문 길이 0"에만 -- 공백·마커만인 본문은 비어 있지 않다(coder-task.md
// §1-⑷, 저장 3R 과 같은 판정선).

test("빈 본문(길이 0)만 비활성 판정이다", () => {
  assert.equal(isNotionCopyDisabled({ getBody: () => "" }), true);
});

test("공백만인 본문은 비활성이 아니다(트림 금지)", () => {
  assert.equal(isNotionCopyDisabled({ getBody: () => " " }), false);
});

test("마커만 있는 본문(예: '**')은 비활성이 아니다", () => {
  assert.equal(isNotionCopyDisabled({ getBody: () => "**" }), false);
});

test("빈 줄만 있는 본문(개행뿐)도 비활성이 아니다(길이 > 0)", () => {
  assert.equal(isNotionCopyDisabled({ getBody: () => "\n\n" }), false);
});

// -- (3) 생성 규칙으로 만든 조합: 서식 종류 x 짝/속 x 길이 x 문자 ----------
//
// coder-task.md §1-⑶: "서식 종류(제목·목록·체크박스·굵게·취소선·평문) x
// 짝/속(정상·짝없음·속빈) x 길이(한 줄·여러 줄·빈 줄 포함) x 문자(한글·
// 이모지·개행 CRLF/LF)". performNotionCopy 는 store.getBody() 를 그대로
// 돌려주는 항등 경로이므로(재파싱 없음), 이 시험의 목적은 "복사 파이프
// 라인 전체(store 저장 -> performNotionCopy -> 가짜 클립보드)가 실제로
// 그 항등을 어떤 모양에서도 깨지 않음"을 넓은 조합으로 실측하는 것이다.
//
// 서식 종류 중 제목/목록/체크박스/평문은 열고 닫는 마커 짝 개념이 없어
// "짝/속" 축이 실질적으로 굵게·취소선에만 적용된다 -- 그래서 "짝/속"은
// 서식 종류 목록 자체에 접어 넣는다(정상 6종 + 굵게·취소선의 짝없음·
// 속빈 4종 = 10종).
const FORMAT_KINDS = [
  { label: "제목", wrap: (s) => `# ${s}` },
  { label: "목록", wrap: (s) => `- ${s}` },
  { label: "체크박스", wrap: (s) => `- [ ] ${s}` },
  { label: "굵게-정상", wrap: (s) => `**${s}**` },
  { label: "굵게-짝없음", wrap: (s) => `**${s}` },
  { label: "굵게-속빈", wrap: () => `****` },
  { label: "취소선-정상", wrap: (s) => `~~${s}~~` },
  { label: "취소선-짝없음", wrap: (s) => `~~${s}` },
  { label: "취소선-속빈", wrap: () => `~~~~` },
  { label: "평문", wrap: (s) => s },
];

const LENGTHS = [
  { label: "한줄", shape: (line) => line },
  { label: "여러줄", shape: (line) => `${line}\n둘째 줄 ${line}` },
  { label: "빈줄포함", shape: (line) => `${line}\n\n빈 줄 뒤 ${line}` },
];

const CHARSETS = [
  { label: "한글", text: "한글텍스트", crlf: false },
  { label: "이모지", text: "😀🔥📎", crlf: false },
  { label: "개행CRLF", text: "줄바꿈용텍스트", crlf: true },
  { label: "개행LF", text: "줄바꿈용텍스트", crlf: false },
];

function generateCopyBodies() {
  const bodies = [];
  for (const kind of FORMAT_KINDS) {
    for (const length of LENGTHS) {
      for (const charset of CHARSETS) {
        const shaped = length.shape(charset.text);
        const wrapped = kind.wrap(shaped);
        const body = charset.crlf ? wrapped.replace(/\n/g, "\r\n") : wrapped;
        bodies.push({
          label: `종류=${kind.label}·길이=${length.label}·문자=${charset.label}`,
          body,
        });
      }
    }
  }
  return bodies;
}

const GENERATED_COPY_BODIES = generateCopyBodies();

test("생성기 축 조합 수는 10(서식종류x짝/속 유효조합)x3(길이)x4(문자)=120 으로 고정된다", () => {
  assert.equal(GENERATED_COPY_BODIES.length, 120);
});

let passCount = 0;
for (const { label, body } of GENERATED_COPY_BODIES) {
  test(`복사 파이프라인이 원문 바이트를 그대로 보존한다 (${label}): ${JSON.stringify(body)}`, async () => {
    const adapter = createFakeAdapter();
    const store = createMemoStore(adapter);
    await store.onContentChange(body);
    assertByteIdentical(
      store.getBody(),
      body,
      "store.getBody() 는 입력 원문과 같아야 한다",
    );

    const clipboard = makeFakeClipboard();
    const copied = await performNotionCopy(store, clipboard);

    assertByteIdentical(copied, body, "performNotionCopy 반환값");
    assertByteIdentical(
      clipboard.writes[0],
      body,
      "클립보드에 실제로 들어간 값",
    );
    passCount += 1;
  });
}

test("생성기 조합 120개가 전부 통과했다(패스 수 = 조합 수)", () => {
  assert.equal(
    passCount,
    120,
    "이 시험이 먼저 끝나 버리면(등록 순서 문제) 항상 실패해야 한다 -- node:test 는 등록 순서대로 실행하므로 여기 도달했다면 위 120개가 이미 다 통과한 것",
  );
});

// -- (5) 실패 경로 실측: 원문 로컬 보존 ------------------------------------

test("클립보드 쓰기 실패 시 store 의 원문은 그대로 남는다(성공 실패와 무관하게 store 는 읽기 전용으로만 쓰인다)", async () => {
  const adapter = createFakeAdapter();
  const store = createMemoStore(adapter);
  await store.onContentChange("실패해도 남아야 하는 원문");

  const clipboard = makeFailingClipboard(new Error("permission denied"));
  await assert.rejects(() => performNotionCopy(store, clipboard));

  assert.equal(
    store.getBody(),
    "실패해도 남아야 하는 원문",
    "실패 후에도 원문이 그대로 남아 있어야 한다(P1 아니어야 함)",
  );
});

// -- mountNotionCopy 통합: 버튼 활성/비활성, 토스트, 햅틱, 에디터 유지 -----

function makeElements() {
  const button = document.createElement("button");
  const toast = document.createElement("div");
  toast.hidden = true;
  return { button, toast };
}

test("mountNotionCopy: 빈 본문이면 버튼이 비활성으로 시작하고, 입력이 생기면 활성화된다", async () => {
  const { editor } = makeProductEditor();
  const adapter = createFakeAdapter();
  const store = createMemoStore(adapter);
  const { button, toast } = makeElements();
  const clipboard = makeFakeClipboard();

  mountNotionCopy(editor, store, { button, toast }, { clipboard });
  assert.equal(button.disabled, true, "빈 본문에서는 비활성으로 시작해야 한다");

  await store.onContentChange("이제 내용이 생겼다");
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("이제 내용이 생겼다"));
      root.append(paragraph);
    },
    { discrete: true },
  );

  assert.equal(button.disabled, false, "본문이 생기면 활성화돼야 한다");
});

test("mountNotionCopy: 성공 시 토스트가 뜨고, 햅틱이 불리고, 에디터 내용은 그대로 유지된다", async () => {
  const { editor } = makeProductEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("복사할 본문"));
      root.append(paragraph);
    },
    { discrete: true },
  );
  const adapter = createFakeAdapter();
  const store = createMemoStore(adapter);
  await store.onContentChange("복사할 본문");

  const { button, toast } = makeElements();
  const clipboard = makeFakeClipboard();
  let vibrateMs = null;
  const timers = [];
  mountNotionCopy(
    editor,
    store,
    { button, toast },
    {
      clipboard,
      vibrate: (ms) => {
        vibrateMs = ms;
      },
      setTimeoutFn: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeoutFn: () => {},
    },
  );

  button.dispatchEvent(new window.Event("click"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertByteIdentical(
    clipboard.writes[0],
    "복사할 본문",
    "클립보드에 들어간 값",
  );
  assert.equal(toast.hidden, false, "성공 토스트가 보여야 한다");
  assert.match(toast.textContent, /노션에 복사됐어요/);
  assert.ok(vibrateMs !== null, "햅틱이 호출돼야 한다(PRD §5.4 가벼운 햅틱)");
  assert.equal(
    serializeEditorToMarkdown(editor),
    "복사할 본문",
    "복사 후 에디터 내용이 그대로여야 한다(수용 기준③)",
  );
  assert.equal(
    timers.some((timer) => timer.ms === 2000),
    true,
    "성공 토스트는 2초 뒤 자동으로 숨어야 한다(PRD §5.4)",
  );
});

test("mountNotionCopy: 실패 시 재시도 문구가 뜨고 원문은 store 에 그대로 남는다", async () => {
  const { editor } = makeProductEditor();
  const adapter = createFakeAdapter();
  const store = createMemoStore(adapter);
  await store.onContentChange("실패해도 남는 본문");

  const { button, toast } = makeElements();
  const clipboard = makeFailingClipboard();
  mountNotionCopy(editor, store, { button, toast }, { clipboard });

  button.dispatchEvent(new window.Event("click"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(toast.hidden, false, "오류 토스트(재시도 표시)가 보여야 한다");
  assert.match(toast.textContent, /다시/);
  assert.equal(
    store.getBody(),
    "실패해도 남는 본문",
    "실패해도 원문 로컬 보존(수용 기준④)",
  );
});
