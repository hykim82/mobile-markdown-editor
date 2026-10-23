// HYK-304-usage-metrics-1(coder-task.md §2 요구 1) -- localStorage 키 1개 ·
// 주 버킷(월요일 0시 로컬) · 메모 내용 0 · 읽기 실패/JSON 파손/저장 막힘에도
// 앱 동작 무변. jsdom-env.mjs 가 globalThis.window.localStorage 를 심어 둔다
// (usage-metrics.mjs 는 window.localStorage 로만 접근한다, src/editor/**
// 전역 경계).
import "../support/jsdom-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordAppOpen,
  recordNewMemo,
  recordCopySuccess,
  recordUndo,
  recordRetypeEstimate,
  readRecentWeeks,
} from "../../src/editor/usage-metrics.mjs";

const KEY = "mobile-markdown-editor:usage-metrics";

function resetStorage() {
  window.localStorage.clear();
}

// 2026-10-19(월) 09:00 로컬 -- 그 주의 월요일.
const MONDAY = new Date(2026, 9, 19, 9, 0, 0);
const now = () => MONDAY;

test("키는 1개뿐이다", () => {
  resetStorage();
  recordAppOpen({ now });
  assert.deepEqual(Object.keys(window.localStorage), [KEY]);
});

test("저장된 값에는 메모 내용(글자)이 전혀 없다 -- 숫자만", () => {
  resetStorage();
  recordAppOpen({ now });
  recordNewMemo({ now });
  const raw = window.localStorage.getItem(KEY);
  const parsed = JSON.parse(raw);
  for (const bucket of Object.values(parsed.weeks)) {
    for (const value of Object.values(bucket)) {
      assert.equal(typeof value, "number");
    }
  }
  assert.doesNotMatch(
    raw,
    /[가-힣]/,
    "저장 원문에 한글(메모 내용일 수 있는 글자)이 없어야 한다",
  );
});

test("5개 카운터가 각각 독립적으로 이번 주 버킷에 쌓인다", () => {
  resetStorage();
  recordAppOpen({ now });
  recordAppOpen({ now });
  recordNewMemo({ now });
  recordCopySuccess({ now });
  recordUndo({ now });
  recordRetypeEstimate({ now });
  const { thisWeek } = readRecentWeeks({ now });
  assert.deepEqual(thisWeek, {
    opens: 2,
    newMemos: 1,
    copies: 1,
    undos: 1,
    retypes: 1,
  });
});

test("주 경계는 월요일 0시 로컬 -- 같은 주의 다른 요일/시각은 같은 버킷, 다음 주 월요일은 새 버킷", () => {
  resetStorage();
  const mondayMorning = new Date(2026, 9, 19, 0, 0, 1);
  const sundayNight = new Date(2026, 9, 25, 23, 59, 59); // 같은 주 일요일 끝
  const nextMonday = new Date(2026, 9, 26, 0, 0, 0); // 다음 주 월요일 0시
  recordAppOpen({ now: () => mondayMorning });
  recordAppOpen({ now: () => sundayNight });
  recordAppOpen({ now: () => nextMonday });

  const { thisWeek, lastWeek } = readRecentWeeks({ now: () => nextMonday });
  assert.equal(thisWeek.opens, 1, "다음 주 월요일 0시는 새 버킷이어야 한다");
  assert.equal(
    lastWeek.opens,
    2,
    "월요일 0시 1초와 일요일 23:59:59 는 같은(지난) 주 버킷이어야 한다",
  );
});

test("읽기 실패(사생활 모드 등, getItem 이 던짐)에도 기록이 던지지 않고 조용히 포기한다", () => {
  resetStorage();
  // first-run-notice.test.mjs ④와 같은 몽키패치 자리(Storage.prototype) --
  // 인스턴스가 아니라 프로토타입을 바꿔야 window.localStorage.getItem()
  // 호출이 실제로 이 가짜를 탄다.
  const original = window.Storage.prototype.getItem;
  window.Storage.prototype.getItem = function throwingGetItem() {
    throw new Error("private mode: storage blocked");
  };
  try {
    assert.doesNotThrow(() => recordAppOpen({ now }));
  } finally {
    window.Storage.prototype.getItem = original;
  }
});

test("JSON 파손(값이 깨진 문자열)이어도 던지지 않고 빈 저장소로 본다(카운터는 0부터 다시 시작)", () => {
  resetStorage();
  window.localStorage.setItem(KEY, "{이건 JSON이 아님");
  assert.doesNotThrow(() => recordAppOpen({ now }));
  const { thisWeek } = readRecentWeeks({ now });
  assert.equal(
    thisWeek.opens,
    1,
    "파손된 값을 버리고 0에서 다시 시작해야 한다",
  );
});

test("모양이 기대와 다른 값(배열·weeks 없음)이어도 던지지 않고 빈 저장소로 본다", () => {
  resetStorage();
  window.localStorage.setItem(KEY, JSON.stringify([1, 2, 3]));
  assert.doesNotThrow(() => recordAppOpen({ now }));
  const { thisWeek } = readRecentWeeks({ now });
  assert.equal(thisWeek.opens, 1);
});

test("쓰기 막힘(setItem 이 던짐)에도 기록이 던지지 않는다(다시 안 쌓이는 것만 포기)", () => {
  resetStorage();
  const original = window.Storage.prototype.setItem;
  window.Storage.prototype.setItem = function throwingSetItem() {
    throw new Error("private mode: storage blocked");
  };
  try {
    assert.doesNotThrow(() => recordAppOpen({ now }));
  } finally {
    window.Storage.prototype.setItem = original;
  }
});

test("버킷 상한(최근 8주)을 넘으면 가장 오래된 주부터 버린다", () => {
  resetStorage();
  // 10주치를 각기 다른 주에 1회씩 기록한다(월요일마다 7일씩 진행).
  const base = new Date(2026, 9, 19, 9, 0, 0); // 2026-10-19(월)
  const weekDates = [];
  for (let i = 0; i < 10; i += 1) {
    weekDates.push(new Date(base.getTime() + i * 7 * 24 * 60 * 60 * 1000));
  }
  for (const d of weekDates) {
    recordAppOpen({ now: () => d });
  }
  const parsed = JSON.parse(window.localStorage.getItem(KEY));
  assert.equal(
    Object.keys(parsed.weeks).length,
    8,
    "8주 상한을 넘는 오래된 버킷은 버려야 한다",
  );
  // 가장 최근 기록(10번째 주)은 여전히 남아 있어야 한다.
  const { thisWeek } = readRecentWeeks({ now: () => weekDates[9] });
  assert.equal(thisWeek.opens, 1);
  // 가장 오래된(1번째 주)은 버려졌어야 한다.
  const oldestWeekAsNow = new Date(
    weekDates[0].getTime() + 24 * 60 * 60 * 1000,
  );
  const { thisWeek: oldest } = readRecentWeeks({ now: () => oldestWeekAsNow });
  assert.equal(
    oldest.opens,
    0,
    "가장 오래된 버킷은 상한에 밀려 사라졌어야 한다",
  );
});

test("읽기 쪽 한 주가 깨져 있어도(모양 이상) 다른 멀쩡한 주는 영향받지 않는다", () => {
  resetStorage();
  recordAppOpen({ now }); // 멀쩡한 이번 주 버킷을 하나 만든다.
  const parsed = JSON.parse(window.localStorage.getItem(KEY));
  const weekKey = Object.keys(parsed.weeks)[0];
  const corrupted = {
    weeks: { ...parsed.weeks, "corrupt-week": { opens: "아님" } },
  };
  window.localStorage.setItem(KEY, JSON.stringify(corrupted));

  const { thisWeek } = readRecentWeeks({ now });
  assert.equal(
    thisWeek.opens,
    1,
    "깨진 이웃 버킷이 있어도 멀쩡한 버킷 값은 그대로 읽혀야 한다",
  );
  void weekKey;
});
