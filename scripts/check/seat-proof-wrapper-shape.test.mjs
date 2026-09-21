import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  judgeSeatProofWrapperShape,
  judgeSeatProofWrapperCanonical,
  judgeSeatProofWrapper,
  computeCanonicalFingerprint,
} from "./seat-proof-wrapper-shape.mjs";
import {
  findPowerShell,
  runWrapperBehavior,
  FAKE_GATE_PROVEN_SCRIPT,
  FAKE_GATE_UNPROVEN_SCRIPT,
} from "./seat-proof-wrapper-behavior.mjs";
import {
  FIXED_FUNCTION_TEXT,
  BROKEN_FUNCTION_TEXT,
  BYPASS_FORMS,
  KNOWN_LIMITATION_FORMS,
  SAFE_FORMS,
} from "./seat-proof-wrapper-fixtures.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./seat-proof-wrapper-shape.mjs", import.meta.url),
);
const CANONICAL_PATH = fileURLToPath(
  new URL("./seat-proof-wrapper-canonical.json", import.meta.url),
);
const CANONICAL = JSON.parse(readFileSync(CANONICAL_PATH, "utf8"));

// review r1 §2-4 P2: this checker's own local anchor for the live control
// room file. Not a fixture -- read at test time, so it always reflects
// whatever the live wrapper currently says (see the live-file test below).
const CONTROL_ROOM_SCRIPT_PATH =
  "D:\\문서관리\\하네스-관제실\\dispatch-worker.ps1";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "seat-proof-wrapper-shape-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
    });
    return { status: 0, stdout };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// ---------------------------------------------------------------------
// PRIMARY VERDICT: fingerprint (judgeSeatProofWrapperCanonical). This is
// wrapper-shape-3's central contract -- §2-1 "지문 일치 = OK · 불일치 =
// BROKEN". Everything else in this file (shape diagnostic, behavioral
// check) is secondary.
// ---------------------------------------------------------------------

test("정본1: 정본 지문과 일치하는 문면 -> OK", async () => {
  const result = await judgeSeatProofWrapperCanonical(
    FIXED_FUNCTION_TEXT,
    CANONICAL,
  );
  assert.deepEqual(result, { verdict: "OK" });
});

test("정본2: 정본 지문에서 한 글자만 달라도 -> BROKEN/CANONICAL_MISMATCH", async () => {
  const oneCharOff = FIXED_FUNCTION_TEXT.replace(
    "return $gateExit",
    "return $gateExit ",
  );
  assert.notEqual(oneCharOff, FIXED_FUNCTION_TEXT);
  const result = await judgeSeatProofWrapperCanonical(oneCharOff, CANONICAL);
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "CANONICAL_MISMATCH");
});

test("정본3: 오늘의 결함 실물 문면(uncaptured) -> BROKEN/CANONICAL_MISMATCH (모양이 아니라 지문으로 잡는다)", async () => {
  const result = await judgeSeatProofWrapperCanonical(
    BROKEN_FUNCTION_TEXT,
    CANONICAL,
  );
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "CANONICAL_MISMATCH");
});

test("정본4: 함수 자체가 없는 텍스트 -> BROKEN/FUNCTION_NOT_FOUND (fail-closed)", async () => {
  const result = await judgeSeatProofWrapperCanonical(
    "function SomeOtherFunction() {\n  return 0\n}\n",
    CANONICAL,
  );
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "FUNCTION_NOT_FOUND");
});

test("정본5: 빈 문자열 입력 -> BROKEN/FUNCTION_NOT_FOUND", async () => {
  const result = await judgeSeatProofWrapperCanonical("", CANONICAL);
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "FUNCTION_NOT_FOUND");
});

test("정본6: canonical 인자 자체가 없으면 -> BROKEN/CANONICAL_MISSING (fail-closed, 지문 없으면 통과시키지 않는다)", async () => {
  const resultUndefined = await judgeSeatProofWrapperCanonical(
    FIXED_FUNCTION_TEXT,
    undefined,
  );
  assert.equal(resultUndefined.verdict, "BROKEN");
  assert.equal(resultUndefined.reasonCode, "CANONICAL_MISSING");

  const resultMalformed = await judgeSeatProofWrapperCanonical(
    FIXED_FUNCTION_TEXT,
    { sha256: "" },
  );
  assert.equal(resultMalformed.verdict, "BROKEN");
  assert.equal(resultMalformed.reasonCode, "CANONICAL_MISSING");
});

test("정본7: CRLF 줄바꿈 + 들여쓰기 흔들림에도 정본 문면은 여전히 OK (정규화는 CRLF->LF만)", async () => {
  const crlfFixed = FIXED_FUNCTION_TEXT.replace(/\n/g, "\r\n");
  const result = await judgeSeatProofWrapperCanonical(crlfFixed, CANONICAL);
  assert.deepEqual(result, { verdict: "OK" });
});

test("정본8: 들여쓰기만 바뀌어도(정규화 범위 밖) -> BROKEN/CANONICAL_MISMATCH", async () => {
  const reindented = FIXED_FUNCTION_TEXT.replace(/^ {2}/gm, "\t\t");
  const result = await judgeSeatProofWrapperCanonical(reindented, CANONICAL);
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "CANONICAL_MISMATCH");
});

test("정본9: 중복 정의여도 마지막(살아있는) 정의만 지문으로 비교한다 -- 마지막이 정본과 같으면 OK", async () => {
  const brokenFirstThenFixed = [
    BROKEN_FUNCTION_TEXT,
    "",
    FIXED_FUNCTION_TEXT,
  ].join("\n");
  const result = await judgeSeatProofWrapperCanonical(
    brokenFirstThenFixed,
    CANONICAL,
  );
  assert.deepEqual(result, { verdict: "OK" });
});

// ---------------------------------------------------------------------
// §3 항목3: 우회 9종 각각 -> 전부 BROKEN (모양 판정 결과와 무관하게)
// ---------------------------------------------------------------------

for (const form of BYPASS_FORMS) {
  test(`우회 ${form.id} (${form.label}): 지문 불일치 -> BROKEN/CANONICAL_MISMATCH`, async () => {
    const result = await judgeSeatProofWrapperCanonical(form.text, CANONICAL);
    assert.equal(result.verdict, "BROKEN");
    assert.equal(result.reasonCode, "CANONICAL_MISMATCH");
  });
}

test("우회 9종이 서로 다른 텍스트이고 정본과도 다름을 확인 (동어반복 방지)", () => {
  const texts = new Set([
    FIXED_FUNCTION_TEXT,
    ...BYPASS_FORMS.map((f) => f.text),
  ]);
  assert.equal(texts.size, BYPASS_FORMS.length + 1);
});

// ---------------------------------------------------------------------
// HYK-323 (wrapper-shape-4) §2-2/§3 항목4: 한계 실증 시험. ⛔이 아래 두
// 시험은 "버그"가 아니라 "이 검사기가 원리적으로 막지 못하는 것"의
// 증거다(모듈 헤더 wrapper-shape-4 절 참조). here-string / 죽은
// `if ($false)` 블록 안에 정본 본문을 그대로 넣으면, 함수가 실제로는
// 정의되지 않는데도 지문은 정본과 같아 "변경 없음"으로 읽힌다 -- 고의
// 우회는 이 층의 탐지 대상이 아니다.
// ---------------------------------------------------------------------

for (const form of KNOWN_LIMITATION_FORMS) {
  test(`알려진 한계 ${form.id} (${form.label}): 함수가 실제로는 정의되지 않는데도 지문은 정본과 같아 -> OK(변경 없음) -- 버그 아님, 문서화된 한계`, async () => {
    const result = await judgeSeatProofWrapperCanonical(form.text, CANONICAL);
    assert.deepEqual(
      result,
      { verdict: "OK" },
      `${form.id}: 이 OK는 "함수가 안전하다"는 뜻이 아니다 -- 텍스트가 우연히 정본과 같은 바이트를 담고 있다는 뜻뿐이다(고의 우회는 탐지 대상 아님, §2-2)`,
    );
  });
}

// Direct existence check (not via runWrapperBehavior's PASS/REJECT/ERROR
// classifier): confirms PowerShell never actually defines the function for
// either known-limitation form. Deliberately does NOT assert what the
// caller-convention comparison (`$seatProofExit -ne 0`) does with the
// resulting $null -- that happens to read as REJECT for this specific
// harness because $null -ne 0 is $true in PowerShell, but that is an
// accident of this one comparison, not a guarantee this checker makes; the
// only claim this module makes is FUNCTION_ABSENT itself.
function checkFunctionDefined(functionDefinitionText, psExe) {
  const dir = mkdtempSync(join(tmpdir(), "seat-proof-known-limit-"));
  try {
    const scriptPath = join(dir, "check.ps1");
    const script = [
      functionDefinitionText,
      'if (Get-Command Invoke-SeatProofGate -ErrorAction SilentlyContinue) { Write-Output "FUNCTION_LIVE" } else { Write-Output "FUNCTION_ABSENT" }',
    ].join("\n");
    writeFileSync(scriptPath, script, "utf8");
    try {
      return execFileSync(
        psExe,
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { encoding: "utf8" },
      );
    } catch (err) {
      return (err.stdout ?? "") + (err.stderr ?? "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(`알려진 한계 실증(행동): here-string/if($false) 문면은 PowerShell이 실제로는 Invoke-SeatProofGate 함수를 정의하지 않는다(FUNCTION_ABSENT) -- 지문은 OK라 해도 실물은 살아있지 않다는 뜻. PowerShell 없으면 사유와 함께 skip`, (t) => {
  if (!PS_EXE) {
    t.skip(
      "SKIP_REASON: no PowerShell executable found on PATH (expected on CI without pwsh)",
    );
    return;
  }
  for (const form of KNOWN_LIMITATION_FORMS) {
    const stdout = checkFunctionDefined(form.text, PS_EXE);
    assert.match(
      stdout,
      /FUNCTION_ABSENT/,
      `${form.id}: 실제로는 함수가 정의되지 않아야 한다 (actual output=${stdout})`,
    );
  }
});

// ---------------------------------------------------------------------
// 모양 판정(judgeSeatProofWrapperShape)은 이제 보조 진단이다 -- §2-4:
// "모양 판정이 OK 라도 지문이 다르면 BROKEN 이어야 한다." 우회 9종 중
// 4~9번은 review r2가 밝힌 대로 모양 판정 자체는 OK를 낸다(진단 공백,
// 의도적으로 패치하지 않음 -- 모듈 헤더 참조). 아래 시험은 그 공백을
// 정직하게 기록하면서, 그럼에도 종합 판정(judgeSeatProofWrapper)의
// verdict는 지문이 우선해 BROKEN으로 남는다는 것을 증명한다.
// ---------------------------------------------------------------------

const SHAPE_DIAGNOSTIC_GAP_IDS = new Set([
  "4-invoke-expression",
  "5-first-of-two-leaked",
  "6-write-output-inputobject",
  "7-parenthesized-expression",
  "8-get-command-node",
  "9-node-case-variant",
]);

for (const form of BYPASS_FORMS) {
  const expectShapeOk = SHAPE_DIAGNOSTIC_GAP_IDS.has(form.id);
  test(`우회 ${form.id}: 모양 진단은 ${expectShapeOk ? "OK(알려진 공백)" : "BROKEN(모양도 잡음)"}이지만 종합 verdict는 지문 우선으로 항상 BROKEN`, async () => {
    const shape = judgeSeatProofWrapperShape(form.text);
    if (expectShapeOk) {
      assert.equal(
        shape.verdict,
        "OK",
        `${form.id}는 모양 진단의 알려진 공백이어야 한다(review r2 발견분)`,
      );
    } else {
      assert.equal(shape.verdict, "BROKEN");
    }

    const combined = await judgeSeatProofWrapper(form.text, CANONICAL);
    assert.equal(
      combined.verdict,
      "BROKEN",
      "모양 진단이 OK를 내더라도 종합 verdict는 지문 불일치로 BROKEN이어야 한다",
    );
    assert.equal(combined.reasonCode, "CANONICAL_MISMATCH");
    assert.equal(combined.diagnostic.verdict, shape.verdict);
  });
}

// HYK-415-canonical-sync-2 (2026-09-01): since the HYK-271 modal-check wire
// landed in the canonical body, the diagnostic (never the verdict
// authority -- module header) now reads a known false positive here:
// `& node (...dispatch-worker-modal-check.mjs) ... | ForEach-Object {
// Write-Host ... }` is a SAFE discard-and-log pattern (nothing escapes to
// the function's return value -- ForEach-Object's scriptblock only calls
// Write-Host, never Write-Output), but findUncapturedGateCall's
// SAFE_DISCARD_SUFFIX_RE only recognizes `| Out-Null`, not this notation --
// exactly the class of "diagnostic can't keep up with every safe notation"
// limitation the module header already documents (review r2/r3 history).
// Per coder-task.md (HYK-415-canonical-sync-2 round) §2, the diagnostic
// regex itself is out of scope to loosen (that's a verdict-adjacent change
// requiring its own review, not a canonical-text sync); this test instead
// records the CURRENT accurate expectation so it stops asserting something
// no longer true of the real pinned body.
test("종합: 정본 문면은 verdict OK -- 모양 진단은 알려진 오탐(UNCAPTURED_GATE_OUTPUT, HYK-271 모달체크 호출을 | ForEach-Object { Write-Host } 폐기로 인식 못함)", async () => {
  const combined = await judgeSeatProofWrapper(FIXED_FUNCTION_TEXT, CANONICAL);
  assert.equal(combined.verdict, "OK");
  assert.equal(combined.diagnostic.verdict, "BROKEN");
  assert.equal(combined.diagnostic.reasonCode, "UNCAPTURED_GATE_OUTPUT");
});

// ---------------------------------------------------------------------
// 안전 표기 대조군 (§2-2/§3) -- 과잉 차단(false positive) 0을 확인한다.
// 지문 관점에서는 정본과 다른 텍스트이므로 CANONICAL_MISMATCH가 정상이다
// (정본 자체가 아닌 "안전해 보이는 변형"은 여전히 사람 검토를 거쳐야
// 정본에 편입된다 -- §2-1 정당 변경 절차). 여기서는 모양 진단이 이 안전
// 표기들을 여전히 OK로 인식함을 확인한다(진단 정보로서의 가치 유지).
// ---------------------------------------------------------------------

for (const form of SAFE_FORMS) {
  test(`안전 표기 ${form.id} (${form.label}): 모양 진단은 OK, 지문은 정본과 달라 CANONICAL_MISMATCH`, async () => {
    const shape = judgeSeatProofWrapperShape(form.text);
    assert.deepEqual(shape, { verdict: "OK" });

    const canonical = await judgeSeatProofWrapperCanonical(
      form.text,
      CANONICAL,
    );
    assert.equal(canonical.verdict, "BROKEN");
    assert.equal(canonical.reasonCode, "CANONICAL_MISMATCH");
  });
}

// ---------------------------------------------------------------------
// §2-2/§6: 행동 검사 -- 실제 PowerShell로 후보 함수 정의를 실행해, 가짜
// 게이트 ⓐ(PROVEN/exit 0)에서 PASS로, ⓑ(UNPROVEN/exit 2)에서 REJECT로
// 읽히는지 확인한다. PowerShell이 없으면(CI) 명시 사유와 함께 skip한다
// (§2-2 "조용한 skip 금지").
// ---------------------------------------------------------------------

const PS_EXE = findPowerShell();

test("행동1: 정본 문면 -- 가짜 게이트 ⓐ(PROVEN) -> PASS; PowerShell 없으면 사유와 함께 skip", (t) => {
  if (!PS_EXE) {
    t.skip(
      "SKIP_REASON: no PowerShell executable found on PATH (expected on CI without pwsh)",
    );
    return;
  }
  const result = runWrapperBehavior(
    FIXED_FUNCTION_TEXT,
    FAKE_GATE_PROVEN_SCRIPT,
    PS_EXE,
  );
  assert.equal(result, "PASS");
});

test("행동2: 정본 문면 -- 가짜 게이트 ⓑ(UNPROVEN) -> REJECT; PowerShell 없으면 사유와 함께 skip", (t) => {
  if (!PS_EXE) {
    t.skip(
      "SKIP_REASON: no PowerShell executable found on PATH (expected on CI without pwsh)",
    );
    return;
  }
  const result = runWrapperBehavior(
    FIXED_FUNCTION_TEXT,
    FAKE_GATE_UNPROVEN_SCRIPT,
    PS_EXE,
  );
  assert.equal(result, "REJECT");
});

// §6: 우회 9종의 행동 검사 결과 표 -- 표기 / 실행 가능 여부 / ⓐ에서의
// 판정 / ⓑ에서의 판정. 아홉 형태 전부 review r1/r2가 "실제 결함인데 OK로
// 오판됐다"고 지적한 문면이므로, ⓐ(PROVEN/exit 0)에서도 REJECT로 읽혀야
// 결함성이 실증된다 -- ⓐ에서 PASS로 읽히면 그 표기는 실제로는 안전하다는
// 뜻이니 그 결과 자체를 정직하게 기록한다(가정하지 않는다).
const behaviorTable = [];

for (const form of BYPASS_FORMS) {
  test(`행동 반례 ${form.id} (${form.label}): 실제 실행 결과 기록; PowerShell 없으면 사유와 함께 skip`, (t) => {
    if (!PS_EXE) {
      t.skip(
        "SKIP_REASON: no PowerShell executable found on PATH (expected on CI without pwsh)",
      );
      behaviorTable.push({ id: form.id, label: form.label, runnable: false });
      return;
    }
    const underProven = runWrapperBehavior(
      form.text,
      FAKE_GATE_PROVEN_SCRIPT,
      PS_EXE,
    );
    const underUnproven = runWrapperBehavior(
      form.text,
      FAKE_GATE_UNPROVEN_SCRIPT,
      PS_EXE,
    );
    behaviorTable.push({
      id: form.id,
      label: form.label,
      runnable: true,
      underProven,
      underUnproven,
    });
    // 모든 우회 9종은 review r1/r2가 실제 결함으로 지적한 문면이다 --
    // ⓐ(PROVEN/exit 0)에서도 REJECT로 읽혀야 그 지적이 행동으로도
    // 실증된다.
    assert.equal(
      underProven,
      "REJECT",
      `${form.id}: PROVEN(exit 0) 하에서도 REJECT로 읽혀야 결함성이 실증된다 (actual=${underProven})`,
    );
    assert.equal(underUnproven, "REJECT");
  });
}

test("행동 반례 표 요약 출력 (결과 파일에 옮겨 적을 표)", () => {
  if (behaviorTable.length === 0) return;
  console.log("\n표기 | 실행가능 | PROVEN(ⓐ) | UNPROVEN(ⓑ)");
  for (const row of behaviorTable) {
    console.log(
      `${row.label} | ${row.runnable ? "yes" : "no(skip)"} | ${row.underProven ?? "-"} | ${row.underUnproven ?? "-"}`,
    );
  }
});

for (const form of SAFE_FORMS) {
  test(`안전 표기 행동 ${form.id}: ⓐ->PASS, ⓑ->REJECT; PowerShell 없으면 사유와 함께 skip`, (t) => {
    if (!PS_EXE) {
      t.skip(
        "SKIP_REASON: no PowerShell executable found on PATH (expected on CI without pwsh)",
      );
      return;
    }
    const underProven = runWrapperBehavior(
      form.text,
      FAKE_GATE_PROVEN_SCRIPT,
      PS_EXE,
    );
    const underUnproven = runWrapperBehavior(
      form.text,
      FAKE_GATE_UNPROVEN_SCRIPT,
      PS_EXE,
    );
    assert.equal(underProven, "PASS");
    assert.equal(underUnproven, "REJECT");
  });
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

test("CLI: 정본 문면 파일(+실제 canonical.json) -> WRAPPER_CHANGED: NO + exit 0", () => {
  withFixtureDir((dir) => {
    const path = join(dir, "fixed.ps1");
    writeFileSync(path, FIXED_FUNCTION_TEXT, "utf8");
    const result = runCli(["--script", path]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^WRAPPER_CHANGED: NO$/m);
  });
});

test("CLI: 결함 문면 파일 -> WRAPPER_CHANGED: YES reason=CANONICAL_MISMATCH + exit 2", () => {
  withFixtureDir((dir) => {
    const path = join(dir, "broken.ps1");
    writeFileSync(path, BROKEN_FUNCTION_TEXT, "utf8");
    const result = runCli(["--script", path]);
    assert.equal(result.status, 2);
    assert.match(
      result.stdout,
      /^WRAPPER_CHANGED: YES reason=CANONICAL_MISMATCH$/m,
    );
  });
});

test("CLI: 우회 표기 파일도 -> WRAPPER_CHANGED: YES reason=CANONICAL_MISMATCH + exit 2 (표본 1개)", () => {
  withFixtureDir((dir) => {
    const path = join(dir, "bypass.ps1");
    writeFileSync(path, BYPASS_FORMS[6].text, "utf8"); // form 7: 괄호식, 모양진단은 OK인 형태
    const result = runCli(["--script", path]);
    assert.equal(result.status, 2);
    assert.match(
      result.stdout,
      /^WRAPPER_CHANGED: YES reason=CANONICAL_MISMATCH$/m,
    );
  });
});

test("CLI: 알려진 한계 표기(here-string) -> 지문은 정본과 같아 WRAPPER_CHANGED: NO + exit 0 (버그 아님, 문서화된 한계 -- §2-2)", () => {
  withFixtureDir((dir) => {
    const path = join(dir, "limit.ps1");
    writeFileSync(path, KNOWN_LIMITATION_FORMS[0].text, "utf8");
    const result = runCli(["--script", path]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^WRAPPER_CHANGED: NO$/m);
  });
});

test("CLI: --script 인자 누락 -> exit 2", () => {
  const result = runCli([]);
  assert.equal(result.status, 2);
});

test("CLI: 존재하지 않는 --script 파일 -> exit 2 (fail-closed)", () => {
  const result = runCli([
    "--script",
    join(tmpdir(), "no-such-file-hyk323.ps1"),
  ]);
  assert.equal(result.status, 2);
});

test("CLI: 존재하지 않는 --canonical 파일 -> WRAPPER_CHANGED: YES reason=CANONICAL_FILE_UNREADABLE + exit 2 (fail-closed)", () => {
  withFixtureDir((dir) => {
    const scriptPath = join(dir, "fixed.ps1");
    writeFileSync(scriptPath, FIXED_FUNCTION_TEXT, "utf8");
    const result = runCli([
      "--script",
      scriptPath,
      "--canonical",
      join(dir, "no-such-canonical.json"),
    ]);
    assert.equal(result.status, 2);
    assert.match(
      result.stdout,
      /^WRAPPER_CHANGED: YES reason=CANONICAL_FILE_UNREADABLE$/m,
    );
  });
});

test("CLI: 커스텀 --canonical 로 다른 정본 지정 가능 -- 그 지문과 일치하면 OK", () => {
  withFixtureDir((dir) => {
    const scriptPath = join(dir, "broken.ps1");
    writeFileSync(scriptPath, BROKEN_FUNCTION_TEXT, "utf8");
    const fp = computeCanonicalFingerprint(BROKEN_FUNCTION_TEXT);
    assert.ok(!fp.error);
    const canonicalPath = join(dir, "custom-canonical.json");
    writeFileSync(canonicalPath, "will be overwritten below", "utf8");

    // computeCanonicalFingerprint returns the raw body text; hash it the
    // same way the CLI does (sha256 of the CRLF->LF-normalized body) to
    // build a matching canonical file.
    const sha256 = createHash("sha256")
      .update(fp.liveBody, "utf8")
      .digest("hex");
    writeFileSync(canonicalPath, JSON.stringify({ sha256 }), "utf8");

    const result = runCli([
      "--script",
      scriptPath,
      "--canonical",
      canonicalPath,
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^WRAPPER_CHANGED: NO$/m);
  });
});

// ---------------------------------------------------------------------
// 실물 (§3 항목5 · §2-4 P2 나안 부분 적용) -- 로컬에 관제실 경로가 있으면
// 지금 살아있는 파일 자체를 넣어 회귀 0을 확인한다. CI에는 이 경로가 없으므로
// (§2-3 정직 한계) 조용히 통과가 아니라 명시 사유와 함께 skip한다.
// ---------------------------------------------------------------------

test("실물: 현재 관제실 dispatch-worker.ps1이 있으면 정본 지문과 일치(회귀 0); 없으면(CI) 사유와 함께 skip", async (t) => {
  if (!existsSync(CONTROL_ROOM_SCRIPT_PATH)) {
    t.skip(
      `SKIP_REASON: control room path not present in this environment (expected on CI) -- ${CONTROL_ROOM_SCRIPT_PATH}`,
    );
    return;
  }
  const liveText = readFileSync(CONTROL_ROOM_SCRIPT_PATH, "utf8");
  const result = await judgeSeatProofWrapperCanonical(liveText, CANONICAL);
  assert.deepEqual(result, { verdict: "OK" });
});
