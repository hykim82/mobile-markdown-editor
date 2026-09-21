import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideFromGateExit,
  combineGateDecisions,
  checkGatePreconditions,
  checkLedgerEntryShape,
  checkLedgerPathResolution,
  checkOneBPrecondition,
  DISPATCH_GATE_STATE,
} from "./dispatch-gate-decision-core.mjs";

test("dispatch-gate-decision-core.mjs has zero import statements (pure core contract)", () => {
  const text = readFileSync(
    new URL("./dispatch-gate-decision-core.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(/^import /m.test(text), false);
});

// ---------------------------------------------------------------------------
// decideFromGateExit -- closed state set {ALLOW, REJECT_BLOCKED,
// REJECT_OPERATIONAL_ERROR, REJECT_UNKNOWN_EXIT}
// ---------------------------------------------------------------------------

test("exit 0 -> ALLOW, reason carries stdout", () => {
  const r = decideFromGateExit({
    exitCode: 0,
    stdout:
      "reject-streak gate: HYK-217 streak=0 (<2) -- envelope not required",
    stderr: "",
    label: "reject-streak gate",
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.ALLOW);
  assert.equal(r.allow, true);
  assert.match(r.reason, /PASS\(exit 0\)/);
  assert.match(r.reason, /streak=0/);
});

test("exit 2 -> REJECT_BLOCKED, reason carries stderr not stdout", () => {
  const r = decideFromGateExit({
    exitCode: 2,
    stdout: "should not appear",
    stderr: "reject-streak gate: HYK-217 streak=3 (>=2) -- no envelope",
    label: "reject-streak gate",
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_BLOCKED);
  assert.equal(r.allow, false);
  assert.match(r.reason, /BLOCK\(exit 2\)/);
  assert.match(r.reason, /streak=3/);
  assert.doesNotMatch(r.reason, /should not appear/);
});

test("exit 1 -> REJECT_OPERATIONAL_ERROR (never ALLOW -- no silent-normal fold)", () => {
  const r = decideFromGateExit({
    exitCode: 1,
    stdout: "",
    stderr: "reject-streak gate: task file not found: /tmp/missing.md",
    label: "reject-streak gate",
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_OPERATIONAL_ERROR);
  assert.equal(r.allow, false);
  assert.match(r.reason, /운영 오류/);
  assert.match(r.reason, /task file not found/);
});

test("unexpected exit code (e.g. killed by signal, exitCode null) -> REJECT_UNKNOWN_EXIT", () => {
  for (const exitCode of [null, undefined, 3, -1, 137]) {
    const r = decideFromGateExit({
      exitCode,
      stdout: "",
      stderr: "",
      label: "reject-streak gate",
    });
    assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_UNKNOWN_EXIT);
    assert.equal(r.allow, false);
  }
});

test("reason is always a non-empty human-readable string, even with no output", () => {
  for (const exitCode of [0, 1, 2, 5]) {
    const r = decideFromGateExit({
      exitCode,
      stdout: "",
      stderr: "",
      label: "x",
    });
    assert.equal(typeof r.reason, "string");
    assert.ok(r.reason.length > 0);
    assert.doesNotMatch(r.reason, /undefined/);
  }
});

test("label defaults to 'dispatch gate' when omitted", () => {
  const r = decideFromGateExit({ exitCode: 0, stdout: "ok", stderr: "" });
  assert.match(r.reason, /^dispatch gate:/);
});

// ---------------------------------------------------------------------------
// checkLedgerEntryShape (3R §2/§3 반례7) -- reject-streak.mjs reads
// `ledger?.issues?.[issueId]?.streak ?? 0`, which folds a literal `null`
// streak to 0 (JS `??` treats null/undefined as nullish). This function
// inspects the RAW entry before that fold happens.
// ---------------------------------------------------------------------------

test("checkLedgerEntryShape: no entry for the issue -> valid (never-rejected is a normal state)", () => {
  const r = checkLedgerEntryShape({ schema_version: 1, issues: {} }, "HYK-1");
  assert.equal(r.valid, true);
});

test("checkLedgerEntryShape: entry.streak is a valid non-negative finite number -> valid", () => {
  const r = checkLedgerEntryShape(
    { issues: { "HYK-1": { streak: 3, history: [] } } },
    "HYK-1",
  );
  assert.equal(r.valid, true);
});

test("checkLedgerEntryShape: 반례7 -- entry.streak === null -> invalid", () => {
  const r = checkLedgerEntryShape(
    { issues: { "HYK-1": { streak: null, history: [] } } },
    "HYK-1",
  );
  assert.equal(r.valid, false);
  assert.match(r.reason, /streak/);
});

test("checkLedgerEntryShape: entry.streak is a string, negative, NaN, or Infinity -> invalid", () => {
  for (const streak of ["2", -1, NaN, Infinity, -Infinity]) {
    const r = checkLedgerEntryShape(
      { issues: { "HYK-1": { streak, history: [] } } },
      "HYK-1",
    );
    assert.equal(r.valid, false, `expected invalid for streak=${streak}`);
  }
});

test("checkLedgerEntryShape: 4R §2 실측 -- entry.streak is a non-integer finite number (e.g. 1.5) -> invalid (2R/3R 형태 검사가 이 값을 놓쳤던 지점)", () => {
  for (const streak of [1.5, 0.1, 2.999, -0.5]) {
    const r = checkLedgerEntryShape(
      { issues: { "HYK-1": { streak, history: [] } } },
      "HYK-1",
    );
    assert.equal(r.valid, false, `expected invalid for streak=${streak}`);
    assert.match(r.reason, /정수/);
  }
});

test("checkLedgerEntryShape: entry.streak is a valid non-negative INTEGER (incl. 0) -> valid", () => {
  for (const streak of [0, 1, 2, 100]) {
    const r = checkLedgerEntryShape(
      { issues: { "HYK-1": { streak, history: [] } } },
      "HYK-1",
    );
    assert.equal(r.valid, true, `expected valid for streak=${streak}`);
  }
});

test("checkLedgerEntryShape: entry.history present but not an array -> invalid", () => {
  const r = checkLedgerEntryShape(
    { issues: { "HYK-1": { streak: 2, history: "not-an-array" } } },
    "HYK-1",
  );
  assert.equal(r.valid, false);
  assert.match(r.reason, /history/);
});

test("checkLedgerEntryShape: entry.history absent -> valid (history is optional)", () => {
  const r = checkLedgerEntryShape(
    { issues: { "HYK-1": { streak: 0 } } },
    "HYK-1",
  );
  assert.equal(r.valid, true);
});

test("checkLedgerEntryShape: entry itself is not a plain object (array/null/primitive) -> invalid", () => {
  for (const entry of [null, [1, 2], "oops", 5]) {
    const r = checkLedgerEntryShape({ issues: { "HYK-1": entry } }, "HYK-1");
    assert.equal(r.valid, false);
  }
});

test("checkLedgerEntryShape: malformed ledger object itself (missing .issues) -> does not throw, treated as no-entry (valid)", () => {
  assert.doesNotThrow(() => checkLedgerEntryShape({}, "HYK-1"));
  assert.doesNotThrow(() => checkLedgerEntryShape(null, "HYK-1"));
  assert.doesNotThrow(() => checkLedgerEntryShape(undefined, "HYK-1"));
});

// ---------------------------------------------------------------------------
// checkGatePreconditions (1R/2R/3R §2) -- 3R rewrites this to a confirmative
// (default-reject) model: ALLOW (return null) requires EVERY fact to be the
// literal boolean `true` for the taskIdMatchCount===1 -- unexpected types
// (numbers, strings, undefined) fail the strict comparisons and fall to
// REJECT, closing the set defensively. All facts here are the same
// structural shape the CLI extracts (regex match count on task_id lines,
// loadLedger()'s own .ok boolean, checkLedgerEntryShape's own .valid
// boolean) -- never a string match on the sub-gate's own stdout/stderr (S8).
// ---------------------------------------------------------------------------

const ALL_GOOD = {
  taskIdMatchCount: 1,
  taskIdFormatValid: true,
  ledgerExists: true,
  ledgerLoadOk: true,
  ledgerEntryShapeValid: true,
};

test("checkGatePreconditions: all facts good -> null (proceed to real gates)", () => {
  assert.equal(checkGatePreconditions(ALL_GOOD), null);
});

test("checkGatePreconditions: taskIdMatchCount=0 (no task_id line) -> REJECT_TASK_ID_NOT_UNIQUE, checked before all others", () => {
  const r = checkGatePreconditions({
    ...ALL_GOOD,
    taskIdMatchCount: 0,
    taskIdFormatValid: false,
    ledgerExists: false,
    ledgerLoadOk: false,
    ledgerEntryShapeValid: false,
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_TASK_ID_NOT_UNIQUE);
  assert.equal(r.allow, false);
});

test("checkGatePreconditions: 3R 반례6 -- taskIdMatchCount=2 (duplicate task_id lines) -> REJECT_TASK_ID_NOT_UNIQUE", () => {
  const r = checkGatePreconditions({ ...ALL_GOOD, taskIdMatchCount: 2 });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_TASK_ID_NOT_UNIQUE);
  assert.equal(r.allow, false);
});

test("checkGatePreconditions: taskIdFormatValid=false (line present exactly once, bad format) -> REJECT_TASK_ID_MALFORMED", () => {
  const r = checkGatePreconditions({
    ...ALL_GOOD,
    taskIdFormatValid: false,
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_TASK_ID_MALFORMED);
  assert.equal(r.allow, false);
});

test("checkGatePreconditions: ledgerExists=false -> REJECT_LEDGER_MISSING", () => {
  const r = checkGatePreconditions({ ...ALL_GOOD, ledgerExists: false });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_LEDGER_MISSING);
  assert.equal(r.allow, false);
});

test("checkGatePreconditions: ledgerLoadOk=false (present but corrupt) -> REJECT_LEDGER_CORRUPT, reason carries ledgerLoadReason", () => {
  const r = checkGatePreconditions({
    ...ALL_GOOD,
    ledgerLoadOk: false,
    ledgerLoadReason: "ledger 'x.json' is not valid JSON (boom)",
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_LEDGER_CORRUPT);
  assert.equal(r.allow, false);
  assert.match(r.reason, /boom/);
});

test("checkGatePreconditions: 3R 반례7 -- ledgerEntryShapeValid=false (e.g. streak: null) -> REJECT_LEDGER_ENTRY_MALFORMED, reason carries ledgerEntryShapeReason", () => {
  const r = checkGatePreconditions({
    ...ALL_GOOD,
    ledgerEntryShapeValid: false,
    ledgerEntryShapeReason:
      "이슈 'HYK-9999'.streak이 유효한 음이 아닌 유한 수가 아님(null)",
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_LEDGER_ENTRY_MALFORMED);
  assert.equal(r.allow, false);
  assert.match(r.reason, /streak이 유효한/);
});

test("checkGatePreconditions: all six rejecting states produce mutually distinct reason strings and state codes", () => {
  const states = [
    checkGatePreconditions({ ...ALL_GOOD, taskIdMatchCount: 0 }),
    checkGatePreconditions({ ...ALL_GOOD, taskIdMatchCount: 2 }),
    checkGatePreconditions({ ...ALL_GOOD, taskIdFormatValid: false }),
    checkGatePreconditions({ ...ALL_GOOD, ledgerExists: false }),
    checkGatePreconditions({ ...ALL_GOOD, ledgerLoadOk: false }),
    checkGatePreconditions({ ...ALL_GOOD, ledgerEntryShapeValid: false }),
  ];
  const uniqueReasons = new Set(states.map((s) => s.reason));
  assert.equal(uniqueReasons.size, 6);
  // taskIdMatchCount=0 and =2 are DIFFERENT root causes (missing vs
  // duplicate) but 3R deliberately maps both to the SAME state
  // (REJECT_TASK_ID_NOT_UNIQUE, "not exactly one") -- only 5 distinct
  // state codes across 6 reasons, verified explicitly here so a future
  // change can't accidentally merge a genuinely different cause into this
  // shared state without this assertion catching the count shift.
  const uniqueStates = new Set(states.map((s) => s.state));
  assert.equal(uniqueStates.size, 5);
});

test("checkGatePreconditions: missing/undefined args object -> does not throw, treated as all-bad (fail-closed)", () => {
  assert.doesNotThrow(() => checkGatePreconditions());
  const r = checkGatePreconditions();
  assert.equal(r.allow, false);
});

// ---------------------------------------------------------------------------
// 3R §2-2: closed-set defense -- unexpected/malformed CALLER input (wrong
// types, not just wrong values) must default to REJECT, never accidentally
// satisfy a strict `=== true` / `=== 1` comparison. This is what "그 외
// 전부가 반드시 거부 쪽에 있어야 한다" means at the type level, not just the
// value level covered by the per-field tests above.
// ---------------------------------------------------------------------------

test("checkGatePreconditions: closed-set defense -- truthy-but-not-strictly-true/1 values never satisfy the checks (all reject)", () => {
  const weirdInputs = [
    { ...ALL_GOOD, taskIdMatchCount: "1" }, // string, not number
    { ...ALL_GOOD, taskIdMatchCount: 1.5 }, // not exactly 1
    { ...ALL_GOOD, taskIdFormatValid: 1 }, // truthy number, not boolean true
    { ...ALL_GOOD, taskIdFormatValid: "true" }, // truthy string, not boolean true
    { ...ALL_GOOD, ledgerExists: "yes" },
    { ...ALL_GOOD, ledgerLoadOk: {} }, // truthy object, not boolean true
    { ...ALL_GOOD, ledgerEntryShapeValid: [] }, // truthy array, not boolean true
    { ...ALL_GOOD, taskIdMatchCount: NaN },
    { ...ALL_GOOD, taskIdMatchCount: Infinity },
  ];
  for (const input of weirdInputs) {
    const r = checkGatePreconditions(input);
    assert.notEqual(
      r,
      null,
      `expected reject for ${JSON.stringify(input)}, got ALLOW`,
    );
    assert.equal(r.allow, false);
  }
});

test("checkGatePreconditions: closed-set defense -- an entirely unrecognized extra field never flips the verdict to allow", () => {
  const r = checkGatePreconditions({
    ...ALL_GOOD,
    someFutureFieldNobodyCheckedFor: true,
    anotherSurprise: "whatever",
  });
  // extra unknown fields are simply ignored -- the known five checks still
  // all pass, so this one is the one legitimate ALLOW case even with junk
  // fields attached, proving unknown fields can't SUPPRESS a real reject
  // either (the function only reads the five names it destructures).
  assert.equal(r, null);
});

// ---------------------------------------------------------------------------
// combineGateDecisions
// ---------------------------------------------------------------------------

test("combine: all ALLOW -> allow=true, reasons preserved in order", () => {
  const a = decideFromGateExit({
    exitCode: 0,
    stdout: "a-ok",
    stderr: "",
    label: "A",
  });
  const b = decideFromGateExit({
    exitCode: 0,
    stdout: "b-ok",
    stderr: "",
    label: "B",
  });
  const combined = combineGateDecisions([a, b]);
  assert.equal(combined.allow, true);
  assert.deepEqual(combined.states, [
    DISPATCH_GATE_STATE.ALLOW,
    DISPATCH_GATE_STATE.ALLOW,
  ]);
  assert.equal(combined.reasons.length, 2);
});

test("combine: one REJECT among ALLOWs -> allow=false, both reasons kept", () => {
  const a = decideFromGateExit({
    exitCode: 0,
    stdout: "a-ok",
    stderr: "",
    label: "A",
  });
  const b = decideFromGateExit({
    exitCode: 2,
    stdout: "",
    stderr: "b-blocked",
    label: "B",
  });
  const combined = combineGateDecisions([a, b]);
  assert.equal(combined.allow, false);
  assert.equal(combined.reasons.length, 2);
  assert.match(combined.reasons[1], /b-blocked/);
});

test("combine: empty list -> allow=false (never silently allow on no input)", () => {
  const combined = combineGateDecisions([]);
  assert.equal(combined.allow, false);
});

test("combine: non-array input -> allow=false, does not throw", () => {
  assert.doesNotThrow(() => combineGateDecisions(null));
  assert.equal(combineGateDecisions(undefined).allow, false);
});

// ---------------------------------------------------------------------------
// HYK-220 2R P1-1/P1-2 -- checkLedgerPathResolution. Kept as its own pure
// function (not folded into checkGatePreconditions) precisely so ALL_GOOD
// and every checkGatePreconditions test above stays byte-for-byte unchanged
// -- this is an EARLIER, separate axis the caller checks first.
// ---------------------------------------------------------------------------

test("checkLedgerPathResolution: state=null (git resolution succeeded) -> null (proceed to checkGatePreconditions)", () => {
  assert.equal(checkLedgerPathResolution({ state: null, path: "/x" }), null);
});

// HYK-221 축2: reversed from the pre-existing contract this test used to
// assert (missing/malformed resolution -> silently treated as "proceed").
// `resolution?.state ?? null` collapses a genuine success (`{path, state:
// null}`) and a missing/malformed resolution object onto the same `null` --
// this function can no longer read both as "proceed." A well-formed success
// always also carries a non-empty `path`; its absence means "판정 불가," a
// distinct REJECT_LEDGER_RESOLUTION_UNJUDGABLE state, never a silent ALLOW.
test("checkLedgerPathResolution: missing/undefined/malformed resolution object -> REJECT_LEDGER_RESOLUTION_UNJUDGABLE, never silently treated as proceed", () => {
  assert.doesNotThrow(() => checkLedgerPathResolution());
  for (const malformed of [undefined, null, {}, { state: undefined }]) {
    const r = checkLedgerPathResolution(malformed);
    assert.notEqual(
      r,
      null,
      `${JSON.stringify(malformed)} must not resolve to "proceed"`,
    );
    assert.equal(r.allow, false);
    assert.equal(
      r.state,
      DISPATCH_GATE_STATE.REJECT_LEDGER_RESOLUTION_UNJUDGABLE,
    );
    assert.ok(r.reason.length > 0);
  }
});

test("checkLedgerPathResolution: REJECT_LEDGER_PATH_UNRESOLVABLE (P1-2 -- git identify failure, distinct from ledger-missing)", () => {
  const r = checkLedgerPathResolution({
    state: DISPATCH_GATE_STATE.REJECT_LEDGER_PATH_UNRESOLVABLE,
    reason: "git 저장소를 식별하지 못함(x)",
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_LEDGER_PATH_UNRESOLVABLE);
  assert.equal(r.allow, false);
  assert.match(r.reason, /식별하지 못함/);
  assert.notEqual(r.state, DISPATCH_GATE_STATE.REJECT_LEDGER_MISSING);
});

test("checkLedgerPathResolution: REJECT_REPO_MISMATCH (P1-1)", () => {
  const r = checkLedgerPathResolution({
    state: DISPATCH_GATE_STATE.REJECT_REPO_MISMATCH,
    reason: "저장소가 기대와 다름",
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_REPO_MISMATCH);
  assert.equal(r.allow, false);
  assert.match(r.reason, /기대와 다름/);
});

test("checkLedgerPathResolution: reason missing/blank -> falls back to a non-empty generated reason (never an empty-string decision)", () => {
  const r1 = checkLedgerPathResolution({
    state: DISPATCH_GATE_STATE.REJECT_REPO_MISMATCH,
  });
  assert.equal(typeof r1.reason, "string");
  assert.ok(r1.reason.length > 0);
  const r2 = checkLedgerPathResolution({
    state: DISPATCH_GATE_STATE.REJECT_REPO_MISMATCH,
    reason: "   ",
  });
  assert.ok(r2.reason.trim().length > 0);
});

test("checkLedgerPathResolution: closed-set defense -- an unrecognized non-null state value never falls through as ALLOW", () => {
  const r = checkLedgerPathResolution({ state: "SOMETHING_NOBODY_DEFINED" });
  assert.notEqual(r, null);
  assert.equal(r.allow, false);
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_LEDGER_PATH_UNRESOLVABLE);
});

// P1-2 요구: "적힌 수 ≠ 실제 목록" 재발 방지 -- 상태 개수를 손으로 세지 않고
// Object.keys()로 기계 유도한다. 이 테스트가 지키는 것은 "DISPATCH_GATE_STATE에
// 새 상태를 추가하면 이 숫자도 자동으로 따라온다"는 사실 하나뿐이다(특정
// 숫자를 정답으로 못박지 않는다).
test("DISPATCH_GATE_STATE: key count and value count always agree (machine-derived, never hand-counted)", () => {
  const keys = Object.keys(DISPATCH_GATE_STATE);
  const values = Object.values(DISPATCH_GATE_STATE);
  assert.equal(keys.length, values.length);
  assert.equal(
    new Set(values).size,
    values.length,
    "every state value must be unique",
  );
  // every key name must equal its own value (the convention every existing
  // entry in this object already follows) -- catches a copy-paste typo
  // where a NEW key's value accidentally collides with an EXISTING one.
  for (const key of keys) {
    assert.equal(DISPATCH_GATE_STATE[key], key);
  }
});

test("DISPATCH_GATE_STATE: HYK-220 2R additions are present and REJECT_LEDGER_MISSING remains distinct from both", () => {
  const keys = new Set(Object.keys(DISPATCH_GATE_STATE));
  assert.ok(keys.has("REJECT_LEDGER_PATH_UNRESOLVABLE"));
  assert.ok(keys.has("REJECT_REPO_MISMATCH"));
  assert.notEqual(
    DISPATCH_GATE_STATE.REJECT_LEDGER_PATH_UNRESOLVABLE,
    DISPATCH_GATE_STATE.REJECT_LEDGER_MISSING,
  );
  assert.notEqual(
    DISPATCH_GATE_STATE.REJECT_REPO_MISMATCH,
    DISPATCH_GATE_STATE.REJECT_LEDGER_MISSING,
  );
});

// ---------------------------------------------------------------------------
// HYK-241 §2 조각2: checkOneBPrecondition -- ⓐ 세 요건 완비 OR ⓑ 유효한
// 선행 작업 선언, 둘 중 하나가 없으면 REJECT_ONE_B_MISSING.
// ---------------------------------------------------------------------------

test("checkOneBPrecondition: ⓐ complete -> null (proceed), regardless of ⓑ", () => {
  assert.equal(
    checkOneBPrecondition({
      aComplete: true,
      missingA: [],
      bDeclared: false,
      bValid: false,
    }),
    null,
  );
});

test("checkOneBPrecondition: ⓐ incomplete but ⓑ declared AND valid -> null (proceed)", () => {
  assert.equal(
    checkOneBPrecondition({
      aComplete: false,
      missingA: ["1b_exec_line", "1b_shown", "1b_reach_path"],
      bDeclared: true,
      bValid: true,
    }),
    null,
  );
});

test("checkOneBPrecondition: ⓐ incomplete AND ⓑ not declared at all -> REJECT_ONE_B_MISSING, names the missing ⓐ cells and ⓑ's absence", () => {
  const r = checkOneBPrecondition({
    aComplete: false,
    missingA: ["1b_shown"],
    bDeclared: false,
    bValid: false,
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_ONE_B_MISSING);
  assert.equal(r.allow, false);
  assert.match(r.reason, /1b_shown/);
  assert.match(r.reason, /선언 없음/);
});

test("checkOneBPrecondition: ⓐ incomplete AND ⓑ declared but too short -> REJECT_ONE_B_MISSING, reason distinguishes 'too short' from 'absent' (⛔아무 문장이나 통과 금지)", () => {
  const r = checkOneBPrecondition({
    aComplete: false,
    missingA: ["1b_exec_line", "1b_shown", "1b_reach_path"],
    bDeclared: true,
    bValid: false,
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_ONE_B_MISSING);
  assert.match(r.reason, /너무 짧아/);
  assert.doesNotMatch(r.reason, /선언 없음/);
});

test("checkOneBPrecondition: ⓑ declared+valid but ⓐ also complete -> still null (either is sufficient, not both required)", () => {
  assert.equal(
    checkOneBPrecondition({
      aComplete: true,
      missingA: [],
      bDeclared: true,
      bValid: true,
    }),
    null,
  );
});

test("checkOneBPrecondition: missing/undefined input object -> treated as neither ⓐ nor ⓑ satisfied -> REJECT_ONE_B_MISSING (never a silent proceed on absent facts)", () => {
  const r = checkOneBPrecondition();
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_ONE_B_MISSING);
  assert.equal(r.allow, false);
});

test("DISPATCH_GATE_STATE: REJECT_ONE_B_MISSING is present and distinct from every other REJECT_* state", () => {
  const keys = Object.keys(DISPATCH_GATE_STATE);
  assert.ok(keys.includes("REJECT_ONE_B_MISSING"));
  const values = keys.map((k) => DISPATCH_GATE_STATE[k]);
  assert.equal(new Set(values).size, values.length, "no two states collide");
});
