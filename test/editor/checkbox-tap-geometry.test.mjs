// HYK-304-tap-overlay-geometry-1 (coder-task §3): 연속 체크줄에서 윗줄 탭은 윗줄만 바꾸고,
// 탭 덮개의 CSS 를 실제 스타일시트(public/index.html)에서 직접 읽어 M6(글리프 width 제거)·
// M7(덮개 제거)·덮개 재침범 회귀를 빨갛게 만든다.
//
// jsdom 에는 레이아웃이 없으므로 줄 상자는 테스트가 고정한다(줄마다 27px 씩 아래로 쌓인다).
// 실제 히트 구간(덮개가 이웃 줄을 가로채는지)은 헤드리스 Chrome 실측으로 따로 잰다 --
// 결과 파일 참조. 이 파일은 그 기하의 CSS 원인을 시험으로 붙든다.
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeProductEditor } from "../support/make-editor.mjs";
import { restoreMarkdownIntoEditor } from "../../src/editor/restore.mjs";
import { serializeEditorToMarkdown } from "../../src/editor/serialize.mjs";

const { window } = globalThis;

// 탭 판정(@lexical/list)이 읽는 ::before 의 px 너비 -- 실제 CSS 가 1.2em 을 준다(시험 아래 CSS 읽기 참고).
// 레이아웃이 없는 jsdom 에서 zoom 을 빈 문자열로 읽어 0 으로 나누는 경로만 1 로 고정한다.
const realGetComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (el, pseudo) => {
  const real = realGetComputedStyle(el, pseudo);
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "getPropertyValue") {
        return (name) =>
          name === "zoom" ? "1" : target.getPropertyValue(name);
      }
      if (pseudo === "::before" && prop === "width") return "20px";
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

const LINE = 27; // 줄 높이(px) -- 연속 줄은 이 간격으로 쌓인다(실측 27.19px)

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function checkItems(root) {
  return [...root.querySelectorAll("li[aria-checked]")];
}

// 줄 한 개를 주어진 세로 위치(top)에 둔 상자로 만들고 그 줄을 탭한다(좌표는 글리프 안).
function tapRowAt(li, index) {
  const top = index * LINE;
  li.getBoundingClientRect = () => ({
    left: 100,
    top,
    right: 300,
    bottom: top + LINE,
    width: 200,
    height: LINE,
    x: 100,
    y: top,
    toJSON() {},
  });
  for (const type of ["pointerdown", "pointerup"]) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      pointerType: { value: "touch" },
      clientX: { value: 105 },
    });
    li.dispatchEvent(event);
  }
}

// 덮개(::after)가 실제 CSS 에서 어떻게 정해졌는지 파일에서 직접 읽는다.
// 가짜 getComputedStyle 이 아니라 배포되는 스타일시트 원문을 묻는다.
const CSS_PATH = new URL("../../public/index.html", import.meta.url);

// CSS 는 나중 선언·나중 블록이 이긴다. 같은 선택자가 파일에 여러 번(@media 안쪽
// 포함) 나오면 그 블록들을 나타난 순서대로 이어붙여, declared() 가 "마지막 선언"을
// 고르면 그대로 캐스케이드의 "마지막 선언이 이긴다"가 된다. 각 블록 자체는 중괄호
// 깊이를 세어 매칭되는 닫는 중괄호까지 읽으므로 중첩 규칙(@media 등)을 가로지른다.
// 선택자가 쉼표로 묶인 목록 어디에 있어도(맨 앞·가운데·맨 뒤) 그 블록을 읽는다(P2-2) --
// 선택자 뒤에 "{" 가 바로 오지 않고 쉼표가 오면, 목록이 끝나는 다음 "{" 까지 건너뛴다.
//
// HYK-304-overlay-cascade-4(1R P3-3 · cascade-3 P3-1) -- 중괄호 깊이 계수가 CSS 주석 속
// "{"·"}" 도 구조로 세면 블록 경계가 뒤틀린다: 주석 안에 닫는 중괄호가 있으면 블록이 일찍
// 끝나고(X1), 여는 중괄호가 있으면 뒤 규칙까지 흡수한다(4f). 주석 처리된 가짜 블록도 실
// 규칙으로 읽힌다(4i). 그래서 깊이를 세기 전에 문서 전체에서 CSS 주석을 먼저 지운다 --
// 주석이 사라지면 그 안의 중괄호도, 주석 속 가짜 선택자 글자도 함께 사라진다.
// ⛔문자열 값(예: content: "{") 안의 중괄호는 이 수리의 범위 밖이다(결과 파일 한계 참고).
function ruleBody(css, selector) {
  const clean = stripComments(css);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const opener = new RegExp(`${escaped}\\s*(?:,|\\{)`, "g");
  let combined = null;
  let match;
  while ((match = opener.exec(clean))) {
    const brace = clean.indexOf("{", match.index);
    if (brace === -1) break;
    let depth = 1;
    let i = brace + 1;
    while (i < clean.length && depth > 0) {
      if (clean[i] === "{") depth++;
      else if (clean[i] === "}") depth--;
      i++;
    }
    const body = clean.slice(brace + 1, i - 1);
    combined = combined === null ? body : combined + body;
    opener.lastIndex = i;
  }
  return combined;
}

test("연속 체크줄에서 윗줄을 탭하면 윗줄만 바뀌고 아랫줄은 [ ] 로 남는다", async () => {
  const { editor, root } = makeProductEditor();
  restoreMarkdownIntoEditor(editor, "- [ ] 첫째\n- [ ] 둘째");
  await settle();
  const [upper] = checkItems(root);
  // 윗줄 탭: 줄 상자는 위에서 0px 부터 27px 까지(아랫줄은 27px 부터). 이 시험은 탭을 윗줄에
  // 직접 건다 -- 히트 가로채기 자체는 jsdom 에 없어 못 본다. 가로채기는 아래 덮개 기하 시험과
  // 헤드리스 Chrome 실측(결과 파일)이 붙든다.
  tapRowAt(upper, 0);
  await settle();

  const after = checkItems(root);
  assert.equal(
    after[0].getAttribute("aria-checked"),
    "true",
    "윗줄이 바뀌어야 한다",
  );
  assert.equal(
    after[1].getAttribute("aria-checked"),
    "false",
    "아랫줄은 그대로여야 한다",
  );
  assert.equal(serializeEditorToMarkdown(editor), "- [x] 첫째\n- [ ] 둘째");
});

test("탭 덮개는 자기 줄의 첫 줄 상자 안에만 있다 -- 이웃 줄을 가로채지 않는다", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const after = ruleBody(css, "#editor-root li[aria-checked]::after");
  assert.ok(after, "덮개(::after) 규칙이 있어야 한다(M7 변이: 규칙 제거)");
  assert.match(after, /position:\s*absolute/, "덮개는 줄 기준으로 놓인다");
  assert.match(
    after,
    /top:\s*0\s*;/,
    "덮개 위쪽은 줄 상자 위쪽에 맞춘다(음수 top 이면 윗줄을 침범한다)",
  );
  assert.match(
    after,
    /height:\s*1lh\s*;/,
    "덮개 높이는 첫 줄 높이(1lh)다 -- 줄 높이보다 크면 아랫줄을 침범한다",
  );
});

// 가로 띠는 「관계」로 붙든다 -- left 와 width 를 한쪽 경계씩 따로 보면 띠가 글리프를 덮는지 아무도
// 안 본다(HYK-304-overlay-horizontal-1 · PR #27 검토 M8·A·B·C). 값은 em 으로 읽는다.
//   바닥  : 띠 왼쪽 끝이 글리프 왼쪽 1.4em 밖에 있다            (M8: left 0 · width 0 → 붕괴)
//   글리프: 띠 오른쪽 끝이 글리프 오른쪽 끝(1.2em)에 닿는다      (A: left -10em → 띠가 화면 밖으로 빠진다)
//   천장  : 띠 오른쪽 끝이 본문 글자 자리(1.4em = 글리프 1.2em + 여백 0.2em)를 넘지 않는다 (B: width 40em → 본문 삼킴)
//   존재  : content: "" 가 있어야 덮개가 생긴다                   (C: content 삭제 → 덮개 부재)
const GLYPH_EM = 1.2; // 글리프 ::before 의 width
const GLYPH_GAP_EM = 0.2; // 글리프 margin-right -- 본문 글자는 여기서 시작한다
const EM_EPS = 1e-9; // 부동소수 오차(-1.4 + 2.6 등)

// em 길이 하나, 또는 그 덧셈·뺄셈 calc() 를 em 값으로 읽는다. 읽을 수 없으면 NaN.
// 리터럴 정규식만 보면 뜻이 같은 고쳐쓰기(calc(1.4em + 1.2em))에 거짓 빨강이 난다(HYK-304 P2-6).
function emValue(expr) {
  if (expr === null) return NaN;
  const inner = expr
    .trim()
    .replace(/^calc\(([\s\S]*)\)$/, "$1")
    .trim();
  if (!/^[+-]?\s*\d+(?:\.\d+)?em(?:\s*[+-]\s*\d+(?:\.\d+)?em)*$/.test(inner)) {
    return NaN;
  }
  let sum = 0;
  for (const [, sign, digits] of inner.matchAll(
    /([+-]?)\s*(\d+(?:\.\d+)?)em/g,
  )) {
    sum += (sign === "-" ? -1 : 1) * Number(digits);
  }
  return sum;
}

// CSS 주석은 선언이 아니다 -- 주석 속에 적힌 옛 값(예: "/* was left: -1.4em; */")을
// "마지막 선언"으로 잘못 읽지 않도록 매칭 전에 지운다(P2-1). HYK-304-overlay-cascade-4
// 부터는 ruleBody() 의 중괄호 깊이 계수에도 적용한다 -- 주석 안 중괄호로 깊이가
// 틀어지는 문제(1R 검토 P3-3 · cascade-3 P3-1)를 이 함수로 함께 막는다.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

// CSS 는 같은 속성이 중복 선언되면 "마지막" 것이 이긴다 -- 단 !important 가 붙은
// 선언은 같은 우선순위 축에서 뒤에 오는 일반(!important 없는) 선언에 지지 않는다
// (P2-1/§6). declared() 는 그래서 "마지막 !important 선언" 이 있으면 그것을, 없으면
// "마지막 일반 선언" 을 돌려준다(전역 매칭으로 전부 모은 뒤 고른다).
function declared(body, name) {
  const clean = stripComments(body);
  const re = new RegExp(`(?:^|[\\s;])${name}:\\s*([^;]+);`, "g");
  let lastNormal = null;
  let lastImportant = null;
  let match;
  while ((match = re.exec(clean))) {
    const raw = match[1].trim();
    const important = /!\s*important\s*$/i.exec(raw);
    if (important) {
      lastImportant = raw.slice(0, important.index).trim();
    } else {
      lastNormal = raw;
    }
  }
  return lastImportant !== null ? lastImportant : lastNormal;
}

// HYK-304-overlay-cascade-4(P3-2) -- content 의 "있다/없다" 도 캐스케이드다: 마지막으로
// 이기는 content 선언이 none(또는 normal -- 기본값과 같은 뜻)이면 의사 요소가 생기지
// 않는다. "문자열 어디든 하나 있으면 통과" 로 보면 뒤 블록의 content: none 재선언을
// 놓친다(K2 -- 파일 수준 `</style>` 앞 붕괴 블록이 전건 초록이던 구멍). 주석 속 content
// 는 선언이 아니므로 먼저 지운다(P3-3 -- declared() 가 left·width 에 적용하는 전제를
// content 에도 적용한다 · K1).
function lastContentValue(body) {
  const clean = stripComments(body);
  const re = /(?:^|[\s;])content:\s*([^;]+);/g;
  let last = null;
  let match;
  while ((match = re.exec(clean))) {
    last = match[1].trim();
  }
  return last;
}

// 덮개 규칙 본문이 위 네 관계를 지키는지 판정한다. 빈 배열이면 통과.
function coverProblems(body) {
  const problems = [];
  const content = lastContentValue(body);
  if (content === null || /^(?:none|normal)$/i.test(content)) {
    problems.push('content: "" 가 없다 -- 덮개가 아예 생기지 않는다(C 변이)');
  }
  const left = emValue(declared(body, "left"));
  const width = emValue(declared(body, "width"));
  if (!Number.isFinite(left) || !Number.isFinite(width)) {
    problems.push("덮개 left·width 는 em 값(또는 그 calc())이어야 한다");
    return problems;
  }
  const right = left + width;
  if (left > -1.4 + EM_EPS) {
    problems.push(
      "덮개는 글리프 왼쪽으로 1.4em 밖까지 뻗어야 한다(M8: 44px 띠가 글리프 폭으로 붕괴)",
    );
  }
  if (right < GLYPH_EM - EM_EPS) {
    problems.push(
      "덮개 오른쪽 끝이 글리프 오른쪽 끝(1.2em)에 닿지 않는다(A: 띠가 글리프에서 떨어진다)",
    );
  }
  if (right > GLYPH_EM + GLYPH_GAP_EM + EM_EPS) {
    problems.push(
      "덮개가 본문 글자 자리(1.4em)를 넘는다(B: 본문을 눌러도 캐럿이 안 간다)",
    );
  }
  return problems;
}

// coverProblems() 의 가로 판정과 같은 "마지막 선언이 이긴다" 캐스케이드를 세로(top·height)
// 에도 적용한다(P2-3) -- declared() 로 마지막 값을 뽑아 정확한 값과 비교한다. 위
// "자기 줄의 첫 줄 상자 안에만 있다" 시험의 assert.match 는 문자열 어디든 있으면
// 통과해 캐스케이드 뒤집힘을 못 본다(vertR1: 규칙 끝 재선언에도 match 가 여전히 통과).
//
// HYK-304-overlay-cascade-4(P3-4) -- 정확 문자열 비교("0"·"1lh")는 뜻이 같은 다른 표기
// (0px·0em·calc(0px)·+0 / calc(1lh)·1LH)를 거짓 빨강으로 본다(가로의 calc 등가 수용,
// P2-6 과 비대칭). isZeroTop()/isOneLineHeight() 가 그 등가를 받는다 -- 실제로 붕괴한
// 값(예: -20px·3lh)은 그대로 빨갛다.
function isZeroTop(value) {
  if (value === null) return false;
  const inner = value
    .trim()
    .replace(/^calc\(([\s\S]*)\)$/i, "$1")
    .trim();
  return /^[+-]?0(?:\.0+)?(?:px|em)?$/i.test(inner);
}

function isOneLineHeight(value) {
  if (value === null) return false;
  const inner = value
    .trim()
    .replace(/^calc\(([\s\S]*)\)$/i, "$1")
    .trim();
  return /^1lh$/i.test(inner);
}

function verticalProblems(body) {
  const problems = [];
  const top = declared(body, "top");
  if (!isZeroTop(top)) {
    problems.push(
      `덮개 위쪽은 줄 상자 위쪽에 맞춘다(음수 top 이면 윗줄을 침범한다) -- 실제 top=${top}`,
    );
  }
  const height = declared(body, "height");
  if (!isOneLineHeight(height)) {
    problems.push(
      `덮개 높이는 첫 줄 높이(1lh)다 -- 줄 높이보다 크면 아랫줄을 침범한다 -- 실제 height=${height}`,
    );
  }
  return problems;
}

// (v)·(w) 공용 -- left: 0em; width: 0em; 로 붕괴한 덮개의 기대 문제 목록(바닥·글리프
// 2건, 2R 검토 §3-2). 변이별 "먼저 적은" 기대값(coverProblems 코드 순서: 바닥 → 글리프)과
// 판정기 출력을 맞춘 뒤 고정한다 -- 길이·존재 여부만 보는 notDeepEqual 이 아니라 내용을 본다.
const EXPECTED_COLLAPSE_PROBLEMS = [
  "덮개는 글리프 왼쪽으로 1.4em 밖까지 뻗어야 한다(M8: 44px 띠가 글리프 폭으로 붕괴)",
  "덮개 오른쪽 끝이 글리프 오른쪽 끝(1.2em)에 닿지 않는다(A: 띠가 글리프에서 떨어진다)",
];

test("탭 덮개의 가로 띠는 바닥·글리프·천장·존재의 네 관계를 지킨다 -- 하나라도 깨지면 빨갛다(M8·A·B·C)", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const after = ruleBody(css, "#editor-root li[aria-checked]::after");
  assert.ok(after, "덮개(::after) 규칙이 있어야 한다");
  assert.deepEqual(coverProblems(after), []);
});

test("같은 뜻의 calc() 표기는 초록이다 -- 리터럴 정규식에 묶이지 않는다(P2-6)", () => {
  const sameMeaning = [
    'content: ""; left: calc(-1.4em); width: calc(1.4em + 1.2em);',
    'content: ""; left: calc(0em - 1.4em); width: 2.6em;',
    'content: ""; left: -1.40em; width: calc(4em - 1.4em);',
    'content: ""; left: -1.4em; width: calc(1.2em + 1.4em);',
  ];
  for (const body of sameMeaning) {
    assert.deepEqual(coverProblems(body), [], body);
  }
});

test("판정기는 네 변이를 각각 빨갛게 본다", () => {
  const mutants = {
    M8: 'content: ""; left: 0em; width: 0em;',
    A: 'content: ""; left: -10em; width: 2.6em;',
    B: 'content: ""; left: -1.4em; width: 40em;',
    C: "left: -1.4em; width: 2.6em;",
  };
  for (const [name, body] of Object.entries(mutants)) {
    assert.notDeepEqual(coverProblems(body), [], `${name} 변이가 초록이다`);
  }
});

// (v) 캐스케이드 고정 -- R1(마지막 선언)·R2(뒤 블록)·R2m(@media 로 감싼 뒤 블록)·R3(중첩 중괄호)를
// ruleBody() -> coverProblems() 경로로 실제로 태운다(HYK-304-overlay-cascade-2 · 검토 P1-1).
// 바로 위 "판정기는 네 변이를..." 처럼 문자열을 coverProblems() 에 직접 넣으면 ruleBody() 를
// 안 타는 헛시험이 되어, ruleBody()/declared() 를 base 판으로 되돌려도 안 걸린다 -- 그래서
// 여기서는 실제 public/index.html 원문을 문자열로 변이시켜 ruleBody() 에 태운다.
test("판정기는 캐스케이드 구멍(R1·R2·R2m·R3)을 ruleBody() 경로로 빨갛게 본다", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const SELECTOR = "#editor-root li[aria-checked]::after";
  const ORIGINAL_RULE = `#editor-root li[aria-checked]::after {
        content: "";
        position: absolute;
        left: -1.4em;
        top: 0;
        width: 2.6em;
        height: 1lh;
      }`;
  assert.ok(
    css.includes(ORIGINAL_RULE),
    "원본 덮개 규칙 문구가 바뀌었다 -- 아래 변이 문자열도 같이 맞춰야 한다",
  );
  assert.ok(css.includes("</style>"), "</style> 태그가 없다");

  // HEAD 실물 CSS(변이 없음) -- 같은 ruleBody() 경로로 초록이어야 한다.
  assert.deepEqual(coverProblems(ruleBody(css, SELECTOR)), []);

  const mutations = {
    // R1: 같은 블록 끝에 중복 선언 -- "마지막 선언이 이긴다"가 깨지면 초록(구멍)이다.
    R1: css.replace(ORIGINAL_RULE, () =>
      ORIGINAL_RULE.replace(
        "height: 1lh;",
        "height: 1lh;\n        left: 0em;\n        width: 0em;",
      ),
    ),
    // R2: </style> 바로 앞의 뒤쪽 블록 -- "마지막 블록이 이긴다"가 깨지면 초록(구멍)이다.
    R2: css.replace(
      "</style>",
      () =>
        '#editor-root li[aria-checked]::after { content: ""; left: 0em; width: 0em; }\n    </style>',
    ),
    // R2m: 같은 뒤 블록을 @media 로 감싸도 여전히 붙들어야 한다.
    R2m: css.replace(
      "</style>",
      () =>
        '@media (max-width: 9999px) { #editor-root li[aria-checked]::after { content: ""; left: 0em; width: 0em; } }\n    </style>',
    ),
    // R3: 블록 「안」에 중첩 중괄호(@media)를 넣고 그 뒤에 재선언 -- 중첩을 가로질러 뒤
    // 선언까지 읽어야 한다(안 그러면 깊이 계수가 첫 "}" 에서 끊겨 재선언을 놓친다).
    R3: css.replace(ORIGINAL_RULE, () =>
      ORIGINAL_RULE.replace(
        "height: 1lh;",
        "height: 1lh;\n        @media (min-width:0px){color:red;}\n        left: 0em;\n        width: 0em;",
      ),
    ),
  };

  for (const [name, mutated] of Object.entries(mutations)) {
    assert.notEqual(mutated, css, `${name} 변이가 실제로 걸리지 않았다`);
    const body = ruleBody(mutated, SELECTOR);
    assert.ok(body, `${name}: ruleBody() 가 덮개 규칙을 못 읽었다`);
    // 네 변이 모두 left: 0em; width: 0em; 로 붕괴하므로 기대 문제는 같다(바닥·글리프
    // 2건) -- notDeepEqual(…, []) 은 "문제 있음"만 보고 어떤 관계가 깨졌는지 보지
    // 않아, declared() 가 엉뚱한 사유로 빨간 변이도 통과시킨다(2R 검토 P2-1 · ⓖ).
    assert.deepEqual(
      coverProblems(body),
      EXPECTED_COLLAPSE_PROBLEMS,
      `${name} 변이가 ruleBody()/coverProblems() 경로에서 기대한 문제 목록과 다르다 -- 캐스케이드 구멍이 다시 뚫렸거나 엉뚱한 사유로 빨갛다`,
    );
  }
});

// (w) 1R P2-1·P2-2·P2-3·2R §6 고정 -- 주석 안 선언(4g·4h)·!important·선택자 목록
// 맨 앞/맨 뒤(4d·4e)·세로 캐스케이드(vertR1)가 ruleBody()/coverProblems()(세로는
// ruleBody()/verticalProblems()) 경로에서 기대한 문제 목록으로 빨갛다. 합성 CSS 문자열을
// ruleBody() 에 태우므로(coverProblems() 에 직접 넣지 않으므로) 헛시험 1형태가 아니다.
test("판정기는 주석 속 선언·!important·선택자 목록 위치·세로 캐스케이드를 각각 기대한 문제로 빨갛게 본다", () => {
  const SELECTOR = "#editor-root li[aria-checked]::after";

  const horizontalFixtures = {
    "4g(선언 뒤 주석에 옛 값이 있다)": `${SELECTOR} {
      content: "";
      position: absolute;
      left: 0em; /* 이전 값 left: -1.4em; */
      top: 0;
      width: 0em; /* 이전 값 width: 2.6em; */
      height: 1lh;
    }`,
    "4h(규칙 끝 주석에 옛 값을 한꺼번에 적는다)": `${SELECTOR} {
      content: "";
      position: absolute;
      left: 0em;
      top: 0;
      width: 0em;
      height: 1lh; /* was left: -1.4em; width: 2.6em; */
    }`,
    "important(규칙 앞쪽 !important 가 뒤 일반 선언에 지지 않는다)": `${SELECTOR} {
      content: "";
      position: absolute;
      left: 0em !important;
      top: 0;
      width: 0em !important;
      height: 1lh;
      left: -1.4em;
      width: 2.6em;
    }`,
    "4d(선택자 목록 맨 앞 -- 덮어쓰기 블록을 못 읽으면 거짓 초록)": `${SELECTOR} {
      content: "";
      position: absolute;
      left: -1.4em;
      top: 0;
      width: 2.6em;
      height: 1lh;
    }
    ${SELECTOR}, .unrelated-sibling {
      left: 0em;
      width: 0em;
    }`,
    "4e(선택자 목록 맨 뒤)": `${SELECTOR} {
      content: "";
      position: absolute;
      left: -1.4em;
      top: 0;
      width: 2.6em;
      height: 1lh;
    }
    .unrelated-sibling, ${SELECTOR} {
      left: 0em;
      width: 0em;
    }`,
  };

  for (const [name, css] of Object.entries(horizontalFixtures)) {
    const body = ruleBody(css, SELECTOR);
    assert.ok(body, `${name}: ruleBody() 가 덮개 규칙을 못 읽었다`);
    assert.deepEqual(coverProblems(body), EXPECTED_COLLAPSE_PROBLEMS, name);
  }

  const vertR1 = `${SELECTOR} {
    content: "";
    position: absolute;
    left: -1.4em;
    top: 0;
    width: 2.6em;
    height: 1lh;
    top: -20px;
    height: 3lh;
  }`;
  const vertBody = ruleBody(vertR1, SELECTOR);
  assert.ok(vertBody, "vertR1: ruleBody() 가 덮개 규칙을 못 읽었다");
  assert.deepEqual(verticalProblems(vertBody), [
    "덮개 위쪽은 줄 상자 위쪽에 맞춘다(음수 top 이면 윗줄을 침범한다) -- 실제 top=-20px",
    "덮개 높이는 첫 줄 높이(1lh)다 -- 줄 높이보다 크면 아랫줄을 침범한다 -- 실제 height=3lh",
  ]);

  // 실물 CSS(변이 없음) -- 같은 경로(가로·세로 둘 다)로 초록.
  const realCss = readFileSync(CSS_PATH, "utf8");
  const realBody = ruleBody(realCss, SELECTOR);
  assert.deepEqual(coverProblems(realBody), []);
  assert.deepEqual(verticalProblems(realBody), []);
});

// HYK-304-overlay-cascade-4 고정 -- content 존재 캐스케이드(P3-2 · K2)·주석 속 중괄호로
// 블록 경계가 뒤틀리는 모양(1R P3-3·cascade-3 P3-1 · X1·X1b·4f)·주석 처리된 가짜 블록을
// 실 규칙으로 읽던 거짓 빨강(1R P3-3 · 4i)·content 주석 축(P3-3 · K1)·세로 등가 표기
// (P3-4)를 ruleBody()/coverProblems()·verticalProblems() 경로로 실제로 태운다(합성
// CSS 문자열을 ruleBody() 에 넣으므로 헛시험 1형태가 아니다). 기대 문제 목록은 코드를
// 보고 먼저 적은 뒤 판정기 출력과 맞췄다(헛시험 2형태 금지 -- 길이·존재 여부만 보지 않음).
// 세 시험으로 나눈다(content 캐스케이드 · 주석 속 중괄호 · 세로 등가) -- 하나로 모으면
// max-lines-per-function(80) 을 넘는다.
test("판정기는 content 존재도 캐스케이드로 본다(K2·K1)", () => {
  const SELECTOR = "#editor-root li[aria-checked]::after";

  // K2: 덮개 규칙 뒤에 같은 선택자로 content: none 재선언 -- "마지막 블록이 이긴다" 가
  // content 에도 적용돼야 한다. "문자열 어디든 하나 있으면 통과" 로 보면 앞 블록의
  // content: "" 를 보고 통과한다(파일 수준 `</style>` 앞 K2 모양이 전건 초록이던 구멍).
  const K2_CSS = `${SELECTOR} {
    content: "";
    position: absolute;
    left: -1.4em;
    top: 0;
    width: 2.6em;
    height: 1lh;
  }
  ${SELECTOR} {
    content: none;
  }`;
  assert.deepEqual(coverProblems(ruleBody(K2_CSS, SELECTOR)), [
    'content: "" 가 없다 -- 덮개가 아예 생기지 않는다(C 변이)',
  ]);

  // K1: content 선언 자체가 CSS 주석으로 감싸져 있다 -- 선언이 아니므로 "없음"으로
  // 읽어야 한다(1R P2-1 이 left·width 에 적용한 주석 제거를 content 에도 적용).
  const K1_CSS = `${SELECTOR} {
    /* content: ""; */
    position: absolute;
    left: -1.4em;
    top: 0;
    width: 2.6em;
    height: 1lh;
  }`;
  assert.deepEqual(coverProblems(ruleBody(K1_CSS, SELECTOR)), [
    'content: "" 가 없다 -- 덮개가 아예 생기지 않는다(C 변이)',
  ]);
  // K1 직접(ruleBody 미경유, "같은 뜻의 calc() 표기" · "네 변이" 시험과 같은 방식) --
  // ruleBody() 가 문서 전체에서 주석을 먼저 지우므로(이 조각), K1 을 ruleBody() 경유로만
  // 재면 lastContentValue() 자신의 주석 제거가 걸리는지 독립적으로 가려낼 수 없다(결과
  // 파일 §2-6 C3 메모). coverProblems() 를 직접 불러 그 메커니즘 자체를 고정한다.
  assert.deepEqual(
    coverProblems(
      '/* content: ""; */ position: absolute; left: -1.4em; top: 0; width: 2.6em; height: 1lh;',
    ),
    ['content: "" 가 없다 -- 덮개가 아예 생기지 않는다(C 변이)'],
  );
});

test("판정기는 주석 속 중괄호로 블록 경계가 뒤틀리지 않는다(X1·X1b·4f·4i)", () => {
  const SELECTOR = "#editor-root li[aria-checked]::after";

  // X1: height 선언 뒤 CSS 주석 안에 닫는 중괄호가 하나 있고, 뒤에 붕괴 블록(그 블록
  // 끝에도 주석)이 있다 -- 주석 속 "}" 를 구조로 세면 첫 블록이 거기서 끊기고, 이어붙인
  // 몸통 위에서 주석 제거가 그 틈부터 뒤 블록의 "*/" 까지를 지워 붕괴 선언이 통째로
  // 사라진다(cascade-3 검토 §8 X1 · base→HEAD 로 뒤집힌 거짓 초록).
  const X1_CSS = `${SELECTOR} {
    content: "";
    position: absolute;
    left: -1.4em;
    top: 0;
    width: 2.6em;
    height: 1lh; /* note: closing brace inside comment } */
  }
  ${SELECTOR} {
    left: 0em;
    width: 0em; /* trailing comment */
  }`;
  assert.deepEqual(
    coverProblems(ruleBody(X1_CSS, SELECTOR)),
    EXPECTED_COLLAPSE_PROBLEMS,
  );

  // X1b: 같은 모양인데 뒤 블록에 주석이 없다 -- 뒤집힘의 원인이 "앞 블록의 열린 주석 ~
  // 뒤 블록의 */" 구간이었는지를 가른다. 이 모양은 cascade-3 에서도 이미 빨갰다(회귀
  // 아님) -- 뒤 블록의 주석 유무로 결과가 갈리지 않아야 한다.
  const X1B_CSS = `${SELECTOR} {
    content: "";
    position: absolute;
    left: -1.4em;
    top: 0;
    width: 2.6em;
    height: 1lh; /* note: closing brace inside comment } */
  }
  ${SELECTOR} {
    left: 0em;
    width: 0em;
  }`;
  assert.deepEqual(
    coverProblems(ruleBody(X1B_CSS, SELECTOR)),
    EXPECTED_COLLAPSE_PROBLEMS,
  );

  // 4f: 규칙 안 CSS 주석에 여는 중괄호가 있고 뒤에 무관한 .x 규칙이 있다 -- 주석 속 "{"
  // 를 구조로 세면 깊이가 하나 더 깊어져 .x 규칙까지 흡수한다(1R 검토 §5 4f). 정상
  // CSS이므로 초록이어야 한다 -- .x 는 다른 선택자라 끌어오지 않아야 한다.
  const FOUR_F_CSS = `${SELECTOR} {
    content: "";
    position: absolute;
    left: -1.4em; /* { 는 열기 */
    top: 0;
    width: 2.6em;
    height: 1lh;
  }
  .x { left: 0em; width: 9em; }`;
  assert.deepEqual(coverProblems(ruleBody(FOUR_F_CSS, SELECTOR)), []);

  // 4i: 주석 처리된 같은 선택자 블록("금지 예") -- 주석이므로 실제로는 아무 효과가
  // 없다. 주석을 지우지 않고 찾으면 주석 속 선택자 글자까지 집어 가짜 블록을 실 규칙
  // 으로 읽는다(1R 검토 §5 4i · 거짓 빨강). 정상 CSS이므로 초록이어야 한다.
  const FOUR_I_CSS = `${SELECTOR} {
    content: "";
    position: absolute;
    left: -1.4em;
    top: 0;
    width: 2.6em;
    height: 1lh;
  }
  /* 금지 예: ${SELECTOR} { content: ""; left: 0em; width: 0em; } */`;
  assert.deepEqual(coverProblems(ruleBody(FOUR_I_CSS, SELECTOR)), []);
});

test("판정기는 세로 등가 표기를 초록으로 보고 실제 붕괴는 그대로 빨갛게 본다(P3-4)", () => {
  const SELECTOR = "#editor-root li[aria-checked]::after";

  // 세로 등가 표기(P3-4) -- top 의 0 과 height 의 1lh 는 각각 여러 표기로 적을 수 있다.
  // 전부 같은 뜻이므로 초록이어야 한다(거짓 빨강 0).
  const VERTICAL_EQUIVALENTS = {
    "top: 0px": { top: "0px", height: "1lh" },
    "top: 0em": { top: "0em", height: "1lh" },
    "top: calc(0px)": { top: "calc(0px)", height: "1lh" },
    "top: +0": { top: "+0", height: "1lh" },
    "height: calc(1lh)": { top: "0", height: "calc(1lh)" },
    "height: 1LH": { top: "0", height: "1LH" },
  };
  for (const [name, { top, height }] of Object.entries(VERTICAL_EQUIVALENTS)) {
    const body = ruleBody(
      `${SELECTOR} {
        content: "";
        position: absolute;
        left: -1.4em;
        top: ${top};
        width: 2.6em;
        height: ${height};
      }`,
      SELECTOR,
    );
    assert.deepEqual(verticalProblems(body), [], name);
  }

  // vertR1 -- 실제 붕괴 값(음수 top·늘어난 height)은 등가 수용과 무관하게 그대로
  // 빨갛다(세로 등가 수용이 진짜 붕괴까지 눈감지 않는지 다시 확인).
  const vertR1Body = ruleBody(
    `${SELECTOR} {
      content: "";
      position: absolute;
      left: -1.4em;
      top: 0;
      width: 2.6em;
      height: 1lh;
      top: -20px;
      height: 3lh;
    }`,
    SELECTOR,
  );
  assert.deepEqual(verticalProblems(vertR1Body), [
    "덮개 위쪽은 줄 상자 위쪽에 맞춘다(음수 top 이면 윗줄을 침범한다) -- 실제 top=-20px",
    "덮개 높이는 첫 줄 높이(1lh)다 -- 줄 높이보다 크면 아랫줄을 침범한다 -- 실제 height=3lh",
  ]);

  // 실물 CSS(변이 없음) -- 같은 경로(가로·세로 둘 다)로 초록.
  const realCss = readFileSync(CSS_PATH, "utf8");
  const realBody = ruleBody(realCss, SELECTOR);
  assert.deepEqual(coverProblems(realBody), []);
  assert.deepEqual(verticalProblems(realBody), []);
});

test("체크칸 글리프의 px 너비는 CSS 원문에 있다 -- 탭 판정이 NaN 으로 빗나가지 않게", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const before = ruleBody(css, "#editor-root li[aria-checked]::before");
  assert.ok(before, "글리프(::before) 규칙이 있어야 한다");
  assert.match(
    before,
    /width:\s*1\.2em\s*;/,
    "글리프 width 는 1.2em 이어야 한다(M6 변이: width 제거 → 탭 판정이 NaN 으로 전부 빗나간다)",
  );
});
