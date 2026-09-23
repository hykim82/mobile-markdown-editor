// HYK-304-linebreak-3 -- REVIEW-r2.md §1 이 정본으로 지목한 P1 수리.
// HYK-304-linebreak-2 가 도입한 backslash-escape 단사 규칙(serialize.mjs
// escapeBackslashes)은 "새로 저장되는 데이터"에서는 옳았지만, main
// (dac26cf -- 이 규칙 자체가 생기기 전 배포본, escape/LineBreakNode 처리
// 0건, 검토자가 기계로 확인)이 이미 저장해 둔 메모까지 그 규칙으로
// 읽으면서 옛 메모의 "보이는 글자"를 훼손했다(review.md §1-2).
//
// 이 파일의 8개 픽스처(B1~B8)는 REVIEW-r2.md §1-2 표를 그대로 옮긴 것이다
// (coder-task.md §2 "그대로 픽스처로" -- 새로 상상해 만들지 않는다).
// bodyFormat 마커(memo-store.mjs 의 CURRENT_BODY_FORMAT)가 없는 레코드는
// storage-mount.mjs 가 legacy 옵션을 걸어 main 의 옛 규칙(escape 없음,
// LineBreakNode 조용히 버림)으로 복원·재직렬화한다 -- 그 옛 규칙은 애초에
// 이 8개를 전부 바이트 그대로 왕복시켰던 바로 그 코드이므로(main 자체가
// 실제로 저장해 둔 데이터), legacy 로 다시 읽으면 손실이 없다.
//
// RED 증거(고치기 전, coder-task.md §2): 워크트리 밖 스크립트로 이 라운드
// 수정 전 커밋(HEAD=aa973a927cde42d3ba6d83db96b4658c34b86884)의 restore/
// serialize 를 그대로 돌려 확인했다(.harness/coder.md 에 명령·출력
// 그대로) -- B1·B2·B4·B7 은 재직렬화 바이트가 저장 원문과 달라졌고
// (안전판 발동), B3·B5·B6·B8 은 복원 중 글자를 잃고도 재직렬화가 우연히
// 저장 바이트와 같아져(escape 가 잃은 만큼 다시 두 배로 부풀려서) 안전판이
// 못 잡았다(review.md §1-3 "고정점"). 아래 시험들은 그 RED 가 이 수리로
// 전부 GREEN 이 됐음을 프로덕션 경로(storage-mount.restoreCurrentMemo,
// bodyFormat 마커 유무로 legacy 를 자동으로 고르는 그 경로) 그대로 잰다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { $isListNode, $isListItemNode } from "@lexical/list";
import { makeProductEditor } from "../support/make-editor.mjs";
import {
  restoreCurrentMemo,
  mountStorage,
} from "../../src/editor/storage-mount.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";
import {
  createMemoStore,
  CURRENT_BODY_FORMAT,
} from "../../src/storage/memo-store.mjs";
import { createFakeAdapter } from "../support/fake-adapter.mjs";
import { writeCurrentMemoId } from "../../src/storage/current-memo-pointer.mjs";

// review.md §1-2 의 8개 표본 -- "저장돼 있던 body" 열 그대로.
const LEGACY_FIXTURES = {
  B1: "C:\\Users\\han\\memo.md",
  B2: "끝에 백슬래시\\",
  B3: "a\\\\b",
  B4: "a\\\\\\b",
  B5: "- 항목1\\\n- 항목2",
  B6: "- [x] 할일1\\\n- [ ] 할일2",
  B7: "수식 \\alpha 와 \\beta",
  B8: "a\\\\\\\\b",
};

function makeRestoreState() {
  return {
    applying: false,
    userEdited: false,
    done: false,
    autosaveBlocked: false,
  };
}

async function restoreLegacyRecord(body) {
  const id = `legacy-${Math.random().toString(36).slice(2)}`;
  writeCurrentMemoId(id);
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
  await restoreCurrentMemo(editor, store, adapter, restoreState);
  return { editor, restoreState, adapter, id };
}

for (const [name, body] of Object.entries(LEGACY_FIXTURES)) {
  test(`옛 형식 레코드(bodyFormat 없음) ${name} 는 legacy 복원 후 재직렬화가 저장 원문과 바이트 동일하다: ${JSON.stringify(body)}`, async () => {
    const { editor, restoreState } = await restoreLegacyRecord(body);
    // main(dac26cf)이 실제로 쓰던 그대로 재는 것과 같은 식(legacy 로
    // 재직렬화) -- 이 값이 원문과 같다는 것은 "보이는 글자가 한 글자도
    // 안 바뀐다"는 표제 불변식을 뜻한다(legacy 복원+legacy 재직렬화는
    // main 코드 자체의 정확한 역함수 쌍이다).
    assert.equal(
      serializeEditorToMarkdown(editor, { legacy: true }),
      body,
      "legacy 재직렬화는 저장 원문과 바이트가 같아야 한다",
    );
    // ⭐옛 규칙으로 정확히 왕복하므로(위 단언), 새 규칙으로 잰 재직렬화
    // 바이트가 원문과 달라지는 것은 "형식이 다르다"는 신호일 뿐 데이터
    // 손상이 아니다 -- restoreCurrentMemo 는 legacy 로 비교하므로 안전판이
    // 걸리지 않는다.
    assert.equal(
      restoreState.autosaveBlocked,
      false,
      "legacy 로 정확히 복원됐으므로 안전판이 걸리면 안 된다(§3 -- 이 라운드는 검토자의 미발동 4건까지 포함해 손실 자체를 없앴다)",
    );
  });
}

// B5·B6 은 review.md §1-2 표에서 "안전판 미발동"으로 표기된 목록 항목
// 표본이다 -- 바이트가 같다는 것만으로는 "항목이 안 합쳐졌다"를 보장하지
// 않으므로(§1-3 "고정점"의 핵심이 바로 그것) 항목 수·텍스트까지 구조로
// 확인한다.
test("B5(목록 항목이 역슬래시로 끝남)는 legacy 복원 후에도 항목이 2개로 남는다(합쳐지지 않는다)", async () => {
  const { editor } = await restoreLegacyRecord(LEGACY_FIXTURES.B5);
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

test("B6(체크박스 항목이 역슬래시로 끝남)는 legacy 복원 후에도 항목 2개 + 체크 상태가 그대로 남는다", async () => {
  const { editor } = await restoreLegacyRecord(LEGACY_FIXTURES.B6);
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

// ⭐이행 축(coder-task.md §1-⑸ 선택지 ⓐ, "재기록 없이도 안전한 길"): 옛
// 레코드를 불러온 뒤 사용자가 실제로 한 글자만 쳐도, 그 저장 경로가 이미
// bodyFormat 을 CURRENT_BODY_FORMAT 으로 올려 쓴다(memo-store.mjs
// handleContentChange) -- 별도의 "재기록 전용 쓰기"를 새로 만들지 않고도
// 다음 번 열 때부터는 새 규칙으로 정확히 읽힌다. 원문을 잃지 않는 길은
// "아예 다시 쓰지 않는다"(레거시 바이트는 사용자가 편집하기 전까지
// 디스크에 원본 그대로 남는다) 그 자체다.
test("옛 레코드를 불러온 뒤 사용자가 편집하면 bodyFormat 이 CURRENT_BODY_FORMAT 으로 올라간다(자연 이행, 강제 재기록 없음)", async () => {
  const id = "legacy-migrate-1";
  writeCurrentMemoId(id);
  const adapter = createFakeAdapter();
  await adapter.put({
    id,
    title: "제목",
    body: LEGACY_FIXTURES.B1,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  });
  const { editor } = makeProductEditor();
  const notice = document.createElement("div");
  mountStorage(editor, notice, adapter);
  await new Promise((resolve) => setTimeout(resolve, 0));

  // 불러온 직후에는 아직 디스크 레코드가 옛 형식 그대로여야 한다(재기록
  // 없음 -- 원문을 잃지 않는 길 그 자체).
  assert.equal((await adapter.get(id)).bodyFormat, undefined);

  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("사용자가 방금 친 글자"));
      root.append(paragraph);
    },
    { discrete: true },
  );
  await new Promise((resolve) => setTimeout(resolve, 1100)); // 디바운스(1000ms) 뒤 flush

  const saved = await adapter.get(id);
  assert.equal(saved.bodyFormat, CURRENT_BODY_FORMAT);
  assert.equal(saved.body, "사용자가 방금 친 글자");
});
