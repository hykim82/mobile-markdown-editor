// coder-task.md §0-1-② "두 화면 오가기 -- 목록에서 메모를 고르면
// 에디터로". storage-mount.mjs 의 openMemoInEditor 가 그 전환의 데이터
// 쪽 절반(목록 카드 클릭 -> 에디터에 그 메모가 뜬다 / "+" -> 빈 에디터)을
// 맡는다. mountStorage 를 통째로 쓰지 않고 openMemoInEditor 를 직접
// 재는 이유는 restore-autosave-safety-net.test.mjs 와 같다 -- fake
// adapter 로 결정적으로, 실제 IndexedDB 없이 잰다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { $isListNode, $isListItemNode } from "@lexical/list";
import { makeProductEditor } from "../support/make-editor.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";
import {
  openMemoInEditor,
  restoreCurrentMemo,
} from "../../src/editor/storage-mount.mjs";
import {
  createMemoStore,
  CURRENT_BODY_FORMAT,
} from "../../src/storage/memo-store.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";
import {
  writeCurrentMemoId,
  readCurrentMemoId,
} from "../../src/storage/current-memo-pointer.mjs";
// HYK-304-legacy-cover-width-1(coder-task.md §1) P2-1 수리(HYK-304-
// fixture-module-1 · ⛔검토자 실측으로 정정): 예전 이 자리의 주석은
// "2번 입구(openMemoInEditor)는 legacy-body-compat.test.mjs 의 8개
// 고정점 표본 중 B1 하나만 덮는다"고 적었는데, 그 문면이 틀렸다 --
// B1 은 "고정점 표본"이 아니다(고정점 = B3·B5·B6·B8, legacy-body-
// compat.test.mjs 머리 주석의 정의: 복원 중 글자를 잃고도 재직렬화가
// 우연히 저장 원문과 같아지는 표본). B1 이 고정점이 아닌 이유는 --
// B1 이 손상되면 바이트가 달라져 안전판(restoreState.autosaveBlocked)이
// 스스로 발동하기 때문이다(검토자 실측: 변이 아래에서
// autosaveBlocked=true). 즉 목록 입구의 고정점 표본은 이 라운드
// 전까지 «0개»였고, 이제 아래 B5·B6 둘로 늘었다(coder-task.md §3
// P2-3 "덮개 폭" 수리) -- 고정점에서는 안전판이 못 잡으므로 구조
// 단정이 유일한 파수꾼이다.
import { LEGACY_FIXTURES } from "./legacy-fixtures.mjs";

function makeRestoreState() {
  return {
    applying: false,
    userEdited: false,
    done: true,
    autosaveBlocked: false,
  };
}

test("목록에서 메모 id 를 고르면 그 메모 본문이 에디터에 뜬다", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "memo-1",
    title: "첫 줄",
    body: "첫 줄\n\n둘째 문단",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();

  await openMemoInEditor(editor, store, adapter, restoreState, "memo-1");

  assert.equal(serializeEditorToMarkdown(editor), "첫 줄\n\n둘째 문단");
  assert.equal(store.getMemoId(), "memo-1");
  assert.equal(
    readCurrentMemoId(),
    "memo-1",
    "포인터도 그 메모로 옮겨져야 한다",
  );
});

test('"+"(새 메모)로 열면(id=null) 에디터가 빈 상태가 되고 포인터가 비워진다', async () => {
  writeCurrentMemoId("이전에-열려있던-메모");
  const adapter = createFakeAdapter();
  const { editor } = makeProductEditor();
  // 에디터에 이전 메모 내용이 남아있던 상태를 흉내낸다.
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("이전 메모 내용"));
      root.append(paragraph);
    },
    { discrete: true },
  );
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();

  await openMemoInEditor(editor, store, adapter, restoreState, null);

  assert.equal(serializeEditorToMarkdown(editor), "");
  assert.equal(store.getMemoId(), null);
  assert.equal(readCurrentMemoId(), null);
});

test("다른 메모로 전환하는 순간(applying)은 update 리스너가 사용자 입력으로 안 본다", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "memo-2",
    title: "본문",
    body: "본문",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();
  let userEditSeen = false;
  editor.registerUpdateListener(() => {
    if (!restoreState.applying) userEditSeen = true;
  });

  await openMemoInEditor(editor, store, adapter, restoreState, "memo-2");

  assert.equal(
    userEditSeen,
    false,
    "openMemoInEditor 가 건 update 는 applying=true 동안이어야 한다",
  );
});

test("전환 직후 왕복(restore round-trip)이 어긋나면 그 메모에 한해 autosaveBlocked 가 선다", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "memo-3",
    title: "원본",
    body: "원본이어야 하는 본문",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();
  const brokenRestoreFn = (ed) => {
    ed.update(
      () => {
        $getRoot().clear();
      },
      { discrete: true },
    );
  };

  await openMemoInEditor(editor, store, adapter, restoreState, "memo-3", {
    restoreFn: brokenRestoreFn,
  });

  assert.equal(restoreState.autosaveBlocked, true);
});

test("이전 메모에서 안전판이 걸려있어도, 다른 메모를 새로 열면 그 메모는 안전판이 풀려있다", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "memo-4",
    title: "정상",
    body: "정상 본문",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();
  restoreState.autosaveBlocked = true; // 이전 메모에서 걸려있던 안전판

  await openMemoInEditor(editor, store, adapter, restoreState, "memo-4");

  assert.equal(
    restoreState.autosaveBlocked,
    false,
    "새로 연 메모는 왕복이 정상이므로 안전판이 풀려야 한다",
  );
});

// restoreCurrentMemo(초기 로드 전용 경로)는 openMemoInEditor 와 달리
// pointer 가 가리키는 메모가 삭제돼 있으면 포인터를 비운다 -- app.mjs
// 는 그 뒤 readCurrentMemoId() 로 "복원할 것이 있었는가"를 판단해 처음
// 보여줄 화면(에디터 vs 목록)을 고른다. 이 시험은 그 판단의 전제(삭제된
// 메모를 가리키던 포인터는 비워진다)를 값으로 고정한다.
test("초기 로드: 포인터가 가리키는 메모가 이미 삭제돼 있으면 포인터가 비워진다(앱 부팅 시 목록이 홈으로 보이는 전제)", async () => {
  writeCurrentMemoId("deleted-memo");
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "deleted-memo",
    title: "지워짐",
    body: "지워짐",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: 999,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = {
    applying: false,
    userEdited: false,
    done: false,
    autosaveBlocked: false,
  };

  await restoreCurrentMemo(editor, store, adapter, restoreState);

  assert.equal(readCurrentMemoId(), null);
});

// HYK-304-fixture-module-1 §7(⭐PR #12 흡수 -- 책임자 판정, PR #12 는
// base 충돌로 병합되지 않았고 이 브랜치가 그 두 칸을 바이트 동일로
// 흡수한다): coder-task.md(HYK-304-legacy-open-cover-1) §1-필수1칸 원문
// 그대로 -- 옛 형식 레코드를 "목록에서 카드를 눌러" 여는 입구
// (openMemoInEditor)도 restoreCurrentMemo(앱을 열 때의 초기 복원 입구)
// 와 마찬가지로 legacy 옵션을 걸어야 한다.
// applyRecordToEditor(storage-mount.mjs)의 isLegacyRecord 판정 원문:
//   function isLegacyRecord(record) {
//     return record.bodyFormat !== CURRENT_BODY_FORMAT;
//   }
// 즉 bodyFormat 필드가 없거나 CURRENT_BODY_FORMAT("escaped-v1")과
// 다르면 옛 형식이다. 픽스처는 legacy-body-compat.test.mjs 의 B1(실제
// 역슬래시 2개가 든 윈도우 경로 문자열)을 그대로 가져온다 -- "역슬래시가
// 두 개로 보인다"는 회귀 모양을 상상이 아니라 그 문서가 지목한 실제
// 문자로 잰다.
test("목록에서 옛 형식(bodyFormat 없음) 레코드를 openMemoInEditor 로 열면 재직렬화가 저장 원문과 바이트 동일하다(legacy 복원)", async () => {
  const id = "legacy-via-list-1";
  const body = "C:\\Users\\han\\memo.md"; // legacy-body-compat.test.mjs B1
  writeCurrentMemoId(null);
  const adapter = createFakeAdapter();
  // ⛔bodyFormat 필드를 일부러 안 넣는다 -- main(dac26cf)이 저장해 뒀던
  // 진짜 옛 레코드를 흉내 낸다(그 시절엔 이 필드 자체가 없었다).
  await adapter.put({
    id,
    title: "제목",
    body,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();

  await openMemoInEditor(editor, store, adapter, restoreState, id);

  assert.equal(
    serializeEditorToMarkdown(editor, { legacy: true }),
    body,
    "legacy 재직렬화는 저장 원문과 바이트가 같아야 한다(보이는 글자 불변식)",
  );
  assert.equal(
    restoreState.autosaveBlocked,
    false,
    "legacy 로 정확히 복원됐으므로 안전판이 걸리면 안 된다",
  );
});

// 대조군(있으면 좋은 1칸): 현재 형식(bodyFormat === CURRENT_BODY_FORMAT)
// 레코드는 openMemoInEditor 로 열어도 legacy=false 로 다뤄져야 한다 --
// 위 시험과 짝을 이뤄 isLegacyRecord 판정이 "레코드에 따라 갈린다"는
// 것을 값으로 고정한다.
test("목록에서 현재 형식(bodyFormat=CURRENT_BODY_FORMAT) 레코드를 openMemoInEditor 로 열면 legacy=false 로 다뤄진다(대조군)", async () => {
  const id = "current-via-list-1";
  // 현재 형식(escaped-v1)에서 저장 원문의 backslash 2개는 "보이는 글자"
  // backslash 1개를 뜻한다(serialize.mjs escapeBackslashes 단사 규칙) --
  // 그래서 이 픽스처는 실제 두 글자(\\)를 담는다.
  const body = "역슬래시\\\\한개";
  writeCurrentMemoId(null);
  const adapter = createFakeAdapter();
  await adapter.put({
    id,
    title: "제목",
    body,
    bodyFormat: CURRENT_BODY_FORMAT,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();

  await openMemoInEditor(editor, store, adapter, restoreState, id);

  assert.equal(
    serializeEditorToMarkdown(editor),
    body,
    "현재 형식 규칙(legacy=false)으로 왕복해도 바이트가 같아야 한다",
  );
  assert.equal(restoreState.autosaveBlocked, false);
});

// HYK-304-legacy-cover-width-1(P2-3 "덮개 폭" 후속): 위 B1 표본 하나만으로는
// "고정점 표본"(legacy-body-compat.test.mjs 머리 주석 -- 복원 중 글자를
// 잃고도 재직렬화가 우연히 저장 원문과 같아지는 B3·B5·B6·B8)에서 2번
// 입구가 구조까지 지키는지 잰 적이 없었다. legacy-body-compat.test.mjs 의
// B5/B6 구조 단정(§ B5(목록 항목이 역슬래시로 끝남)/B6(체크박스))을 그대로
// 본떠 openMemoInEditor 경로로도 같은 모양으로 잰다 -- 두 입구의 단정이
// 같은 모양이어야 입구가 갈리는 날 비교가 된다.
test("B5(목록 항목이 역슬래시로 끝남, 고정점 표본)를 openMemoInEditor(목록에서 열기)로 열어도 항목이 2개로 남는다(합쳐지지 않는다)", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "legacy-open-b5",
    title: "제목",
    body: LEGACY_FIXTURES.B5,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();

  await openMemoInEditor(
    editor,
    store,
    adapter,
    restoreState,
    "legacy-open-b5",
  );

  // HYK-304-fixture-module-1 §3(P2-3 "신규 2칸에 1번 입구가 가진 단정
  // 두 종을 더한다" -- legacy-body-compat.test.mjs 의 표본 루프 문면을
  // 본뜬다): ⓐ재직렬화를 legacy 로 고정한 바이트 단정. B5 는 고정점
  // 표본이라 바이트가 같다는 것만으로는 "항목이 안 합쳐졌다"를 보장하지
  // 않으므로(아래 구조 단정이 그 축을 잡는다) 이 단정은 별도 축이다.
  assert.equal(
    serializeEditorToMarkdown(editor, { legacy: true }),
    LEGACY_FIXTURES.B5,
    "legacy 재직렬화는 저장 원문과 바이트가 같아야 한다",
  );
  // ⓑ B5·B6 은 2번 입구에서 안전판이 걸리지 않는다는 사실을 시험 안에
  // 못박는다(이전엔 검토 문서에만 있었다).
  assert.equal(
    restoreState.autosaveBlocked,
    false,
    "legacy 로 정확히 복원됐으므로 안전판이 걸리면 안 된다",
  );

  editor.getEditorState().read(() => {
    const list = $getRoot()
      .getChildren()
      .find((node) => $isListNode(node));
    assert.ok(list, "목록 노드가 있어야 한다");
    const items = list.getChildren().filter($isListItemNode);
    assert.equal(items.length, 2, "항목 2개가 그대로 남아야 한다");
    assert.equal(items[0].getTextContent(), "항목1\\");
    assert.equal(items[1].getTextContent(), "항목2");
  });
});

test("B6(체크박스 항목이 역슬래시로 끝남, 고정점 표본)를 openMemoInEditor(목록에서 열기)로 열어도 항목 2개 + 체크 상태가 그대로 남는다", async () => {
  const adapter = createFakeAdapter();
  await adapter.put({
    id: "legacy-open-b6",
    title: "제목",
    body: LEGACY_FIXTURES.B6,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const store = createMemoStore(adapter);
  const restoreState = makeRestoreState();

  await openMemoInEditor(
    editor,
    store,
    adapter,
    restoreState,
    "legacy-open-b6",
  );

  // HYK-304-fixture-module-1 §3(P2-3) -- B5 와 같은 두 축(ⓐⓑ).
  assert.equal(
    serializeEditorToMarkdown(editor, { legacy: true }),
    LEGACY_FIXTURES.B6,
    "legacy 재직렬화는 저장 원문과 바이트가 같아야 한다",
  );
  assert.equal(
    restoreState.autosaveBlocked,
    false,
    "legacy 로 정확히 복원됐으므로 안전판이 걸리면 안 된다",
  );

  editor.getEditorState().read(() => {
    const list = $getRoot()
      .getChildren()
      .find((node) => $isListNode(node));
    assert.ok(list, "목록 노드가 있어야 한다");
    const items = list.getChildren().filter($isListItemNode);
    assert.equal(items.length, 2, "항목 2개가 그대로 남아야 한다");
    assert.equal(items[0].getTextContent(), "할일1\\");
    assert.equal(items[0].getChecked(), true);
    assert.equal(items[1].getTextContent(), "할일2");
    assert.equal(items[1].getChecked(), false);
  });
});
