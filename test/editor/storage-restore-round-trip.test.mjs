// restore.mjs 는 serialize.mjs 의 역함수다(coder-task.md §0-2-⑸ "치고 ->
// 닫고 -> 다시 열면 그대로"). 대표 원문을 direct 로 에디터에 넣고
// serialize 한 뒤, 그 결과를 restore 로 새 에디터에 되넣고 다시
// serialize 했을 때 원문과 같아야 한다 -- 저장했다가 새로 여는 것의
// 데이터 계층 등가물.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { makeProductEditor } from "../support/make-editor.mjs";
import { restoreMarkdownIntoEditor } from "../../src/editor/restore.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";

const REPRESENTATIVE_BODIES = [
  "그냥 문단",
  "# 헤딩1",
  "## 헤딩2",
  "### 헤딩3",
  "- 첫줄\n- 둘째줄",
  "- [ ] 할일\n- [x] 다한일",
  "**굵게**",
  "~~취소선~~",
  "**굵고 ~~취소도~~ 같이**",
  "# 하나\n\n## 둘\n\n### 셋",
  "문단 하나\n\n- 목록 하나\n- 목록 둘\n\n**굵은** 문단",
  // HYK-304-linebreak-1(E4) -- 목록 항목 "안" 줄바꿈(Shift+Enter)이 "다음
  // 항목"과 같은 "\n" 하나로 표기되므로, 항목 시작 여부(그룹핑)로만
  // 갈라야 한다(3R P2-3 이 걸린 바로 그 자리). 항목1 이 둘째 줄을 갖고,
  // 항목2 는 갖지 않는 비대칭 모양까지 함께 재 둔다.
  "- 항목1\n항목1줄바꿈\n- 항목2",
  // LineBreakNode 는 서식이 없는 노드라(HYK-304 E4 실측: 실브라우저에서
  // ctrl+b 로 켠 굵게가 줄바꿈 앞뒤 TextNode 둘 다에 남는다) serialize.mjs
  // 는 굵게 구간을 줄바꿈에서 "**...**\n**...**" 두 span 으로 자연히
  // 가른다 -- 단일 "**" 가 원문 줄바꿈을 그대로 가로지르는 모양은 이
  // 직렬화기가 만들 수 없는 모양이라 fixed point 가 아니다.
  "**굵게1**\n**굵게2**",
];

for (const body of REPRESENTATIVE_BODIES) {
  test(`restore -> serialize 왕복이 원문을 보존한다: ${JSON.stringify(body)}`, () => {
    const { editor } = makeProductEditor();
    restoreMarkdownIntoEditor(editor, body);
    assert.equal(serializeEditorToMarkdown(editor), body);
  });
}

test("빈 본문을 restore 하면 에디터가 비어있다(빈 문단만)", () => {
  const { editor } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "");
  assert.equal(serializeEditorToMarkdown(editor), "");
});

// review.md §3-4/§3-6 -- 붙여넣기 0, "그냥 타이핑"만으로도 serialize.mjs
// 는 짝 없는 "**"/"~~" 를 그대로 원문에 내보낸다(닫는 짝을 못 친 굵게·
// 취소선 단축키, 지우다 만 서식 등). restore 는 이런 짝 없는 마커를
// 서식 토글이 아니라 "글자 그대로" 살려야 한다(§3-2 의 훼손·소실
// 재현을 막는 최소 대표 입력 -- B=별표 두 개, T=물결 두 개).
// ⛔이 목록 자체를 손으로 늘리지 않는다(그 자리가 2R 이 걸린 자리다,
// coder-task.md §1-⑵) -- 아래 GENERATED_SHAPES(생성 규칙)가 이 목록을
// «포함»한다(합집합으로 실행 -- REGRESSION_AND_GENERATED_BODIES 참고).
// 이 상수는 review.md 가 실측한 정확한 문자열을 그대로 유지하는
// 회귀 증거로만 남긴다(coder-task.md §1-⑹ "이전 라운드의 증거를
// 보존하라" -- 지우거나 새로 짜지 않는다).
const UNPAIRED_MARKER_BODIES = [
  "**미완성", // B미완성
  "메모 **", // 메모 B -- 마커 뒤 버퍼가 비어 마커 글자 자체가 사라지던 사례
  "a ** b", // a B b
  "~~미완성", // T미완성
  "메모 ~~", // 메모 T
  "**", // 마커만 있는 줄
  "**세 번**은 남고 마지막 **은 홀로",
  "줄끝에마커**", // 마커가 줄 끝에 오는 경우
];

// ⭐coder-task.md §1-⑵ -- "짝은 있지만 속이 빈"(review.md §4 새 P1,
// 별표 넷/물결 넷) 축까지 포함해 "마커 종류 x 위치 x 속 x 짝" 네 축의
// «전 조합»을 생성기로 깐다. 모양을 목록으로 세는 대신 생성 규칙으로
// 세면, 다음에 또 어떤 모양이 나와도(이 라운드가 미처 상상 못 한
// 모양이라도) 네 축 안에 있는 한 이미 시험을 통과한 것이다.
const MARKER_KINDS = [
  { label: "별표", markers: ["**"] },
  { label: "물결", markers: ["~~"] },
  { label: "혼합", markers: ["**", "~~"] },
];

// 속(content) -- "글자있음"은 실제 서식 토글이 성립하는 대조군, "빈"/
// "공백만"이 review.md §4 의 새 P1 축(짝은 있는데 사이가 비어 있음)이다.
const CONTENTS = [
  { label: "글자있음", value: "글자" },
  { label: "빈", value: "" },
  { label: "공백만", value: " " },
];

// 짝(pairing) -- repeat 는 이 마커가 몇 번 연달아 등장하는가다.
// 1=짝 없음(마지막 등장이 곧 미완성), 2=짝 있음, 3=셋 연속(처음 둘은
// 짝이 되고 마지막 하나가 다시 짝 없음이 되는 축까지 한 번에 덮는다).
const PAIRINGS = [
  { label: "있음", repeat: 2 },
  { label: "없음", repeat: 1 },
  { label: "셋연속", repeat: 3 },
];

// 위치(position) -- 생성된 마커 조각을 문장의 어디에 두는가. sep 은
// 마커 조각과 둘레 글자 사이를 무엇으로 잇는가다(LINE_BREAKS 축 참고) --
// "단독"은 둘레 글자 자체가 없어 sep 이 들어갈 자리가 없다.
const POSITIONS = [
  { label: "문두", wrap: (s, sep) => `${s}${sep}뒤` },
  { label: "문중", wrap: (s, sep) => `앞${sep}${s}${sep}뒤` },
  { label: "문미", wrap: (s, sep) => `앞${sep}${s}` },
  { label: "단독", wrap: (s) => s },
];

// ⭐줄바꿈(HYK-304-linebreak-1 E4) -- coder-task.md §1-⑵: 손으로 예문을
// 얹는 대신 이 축을 생성기에 넣어, 마커 조각 둘레의 이음(" ") 자체를
// "\n"(같은 문단 안 줄바꿈, LineBreakNode)으로 바꿔 본다. 마커 두 글자
// 내부는 절대 가르지 않는다(POSITIONS.wrap 이 sep 을 항상 마커 조각
// "바깥" 경계에만 놓는다) -- 줄바꿈이 "**"/"~~" 한 쌍을 반으로 쪼개면
// 그건 이 축이 아니라 마커 축 자체가 깨지는 별개 결함이라 걸러야 한다.
const LINE_BREAKS = [
  { label: "줄바꿈없음", sep: " " },
  { label: "문단안줄바꿈", sep: "\n" },
];

// marker 하나를 repeat 번 늘어놓고 그 사이마다 content 를 끼운다.
// repeat=1(짝 없음)이면 마커 하나 뒤에 content 가 트레일링 텍스트로
// 붙는다 -- "짝이 없다"와 "짝은 있는데 속이 비었다"를 같은 조립식으로
// 표현해, 생성기 자체가 "한 규칙"(coder-task.md §1-⑴)을 반영한다.
function buildMarkerRun(marker, repeat, content) {
  let run = marker;
  for (let i = 1; i < repeat; i += 1) {
    run += content + marker;
  }
  if (repeat === 1) run += content;
  return run;
}

function generateMarkerShapes() {
  const shapes = [];
  for (const kind of MARKER_KINDS) {
    for (const position of POSITIONS) {
      for (const content of CONTENTS) {
        for (const pairing of PAIRINGS) {
          for (const lineBreak of LINE_BREAKS) {
            const construct = kind.markers
              .map((marker) =>
                buildMarkerRun(marker, pairing.repeat, content.value),
              )
              .join("");
            shapes.push({
              label: `종류=${kind.label}·위치=${position.label}·속=${content.label}·짝=${pairing.label}·줄바꿈=${lineBreak.label}`,
              body: position.wrap(construct, lineBreak.sep),
            });
          }
        }
      }
    }
  }
  return shapes;
}

const GENERATED_SHAPES = generateMarkerShapes();

// "포함" 관계를 산문이 아니라 코드로 만든다: 레거시 목록과 생성기 출력을
// body 기준으로 합쳐서 하나의 시험 집합으로 돌린다. 같은 body 가 양쪽에
// 다 있으면(예: "**" 는 레거시 목록에도, 종류=별표·위치=단독·속=빈·
// 짝=없음 좌표에도 있다) 레거시 라벨을 남겨 회귀 증거 쪽 이름을 우선한다.
const REGRESSION_AND_GENERATED_BODIES = new Map();
for (const body of UNPAIRED_MARKER_BODIES) {
  REGRESSION_AND_GENERATED_BODIES.set(body, `review.md 재현(1R/2R 회귀)`);
}
for (const { label, body } of GENERATED_SHAPES) {
  if (!REGRESSION_AND_GENERATED_BODIES.has(body)) {
    REGRESSION_AND_GENERATED_BODIES.set(body, label);
  }
}

// HYK-304-linebreak-1(E4): 108 에 2(줄바꿈: 없음/문단 안 줄바꿈) 축을
// 곱해 216 이 됐다("단독" 위치는 sep 이 들어갈 자리가 없어 두 줄바꿈
// 값이 같은 body 를 만들지만, 그 중복도 조합 수 자체에는 그대로 잡힌다
// -- REGRESSION_AND_GENERATED_BODIES 의 Map 이 실제 시험에서는 중복을
// 제거한다).
test("생성기 축 조합 수는 3(종류)x4(위치)x3(속)x3(짝)x2(줄바꿈)=216 로 고정된다(축을 놓치면 이 수가 줄어든다)", () => {
  assert.equal(GENERATED_SHAPES.length, 216);
});

for (const [body, label] of REGRESSION_AND_GENERATED_BODIES) {
  test(`restore -> serialize 왕복이 원문을 글자 그대로 보존한다 (${label}): ${JSON.stringify(body)}`, () => {
    const { editor } = makeProductEditor();
    restoreMarkdownIntoEditor(editor, body);
    assert.equal(serializeEditorToMarkdown(editor), body);
  });
}

// 화면에 실제로 남는 문단(포맷 토글 없이 문자 그대로)을 만든다 -- 사용자가
// "**"/"~~" 를 키보드로 직접 쳤을 때 에디터 상태가 되는 모양과 같다.
function makeTypedPlainTextEditor(text) {
  const { editor } = makeProductEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(text));
      root.append(paragraph);
    },
    { discrete: true },
  );
  return editor;
}

// coder-task.md §1-⑶ -- 이 라운드의 표제 불변식(★원문 바이트는 저장·
// 복원·재저장 어디서도 변하지 않는다)을 시험 이름 자체가 말하게 한다.
// coder-task.md §1-⑵ -- "저장 → 복원 → 재저장" 3단 왕복이 바이트 동일해야
// 한다(예전 시험은 restore -> serialize 한 번만 봤다). 타이핑 그대로의
// 편집기 상태에서 저장(1) -> 복원 -> 재저장(2) -> 다시 복원 -> 재저장(3)
// 까지 세 단계 모두 바이트가 같아야 재접속을 반복해도 안정적이다.
for (const [body, label] of REGRESSION_AND_GENERATED_BODIES) {
  test(`원문 바이트는 저장·복원·재저장 어디서도 변하지 않는다 (${label}): ${JSON.stringify(body)}`, () => {
    const typedEditor = makeTypedPlainTextEditor(body);
    const saved1 = serializeEditorToMarkdown(typedEditor);
    assert.equal(
      saved1,
      body,
      "타이핑 직후 저장(서식 없음)은 원문과 같아야 한다",
    );

    const { editor: restoredEditor } = makeProductEditor();
    restoreMarkdownIntoEditor(restoredEditor, saved1);
    const saved2 = serializeEditorToMarkdown(restoredEditor);
    assert.equal(
      saved2,
      saved1,
      "복원 후 재저장이 저장 원문과 바이트 동일해야 한다",
    );

    const { editor: reRestoredEditor } = makeProductEditor();
    restoreMarkdownIntoEditor(reRestoredEditor, saved2);
    const saved3 = serializeEditorToMarkdown(reRestoredEditor);
    assert.equal(
      saved3,
      saved2,
      "두 번째 복원 뒤 재저장도 바이트 동일해야 한다(반복 재접속 안정성)",
    );
  });
}

// review.md §4 -- "짝은 있지만 속이 빈" 마커에서 다시 연 뒤 화면·원문이
// 그대로여야 한다는 것을 이름으로 못박은 대표 케이스(생성기 출력 중
// 실제 리포트 문구와 가장 가까운 좌표를 사람이 읽기 좋은 이름으로 뽑아
// 한 번 더 고정한다 -- GENERATED_SHAPES 순회에도 이미 포함되어 있다).
test('"짝은 있지만 속이 빈" 마커(review.md §4 신규 P1)도 생성기 축 안에 있다: 별표·단독·빈·있음 == "****"', () => {
  const shape = GENERATED_SHAPES.find(
    (s) =>
      s.label === "종류=별표·위치=단독·속=빈·짝=있음·줄바꿈=줄바꿈없음" &&
      s.body === "****",
  );
  assert.ok(shape, "이 좌표가 생성기 출력에 없으면 축 정의가 깨진 것이다");
});
