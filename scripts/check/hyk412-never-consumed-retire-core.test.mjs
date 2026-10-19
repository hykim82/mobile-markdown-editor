// HYK-412-stuck-retire-2/3 -- tests for
// hyk412-never-consumed-retire-core.mjs's evaluateNeverConsumedRetirement.
//
// Things this file must prove (coder-task.md §3 완료 조건, 3R additions
// marked):
//   1. The new axis (task-r<N+1>.md absence, NOT task-r<N>.md absence) can
//      actually be TRUE for a real delivered-round file shape -- built with
//      the real archiver (envelope-archive.mjs's archiveRoundTaskFile), not
//      a hand-imagined layout. This is the direct fix for 1R's vacuous-pass
//      bug (검토 P1, 2R).
//   1b (3R). The "REAL SHAPE" fixtures compute their booleans by actually
//      reading the archiver-produced directory (readdirSync), not by
//      hand-typing `true`/`false` literals -- fixes 2R's review P2 gap.
//   2. Every closed branch rejects, and cutting any one guard (mutation)
//      wrongly opens the door for a facts object that should stay closed --
//      mutant count == design doc's stated count (11, 3R), restoration is
//      byte-identical by construction (mutants only ever exist as in-memory
//      strings, the real source file on disk is never opened for writing).
//   3 (3R). The four literal garbage values 3R's review injected against
//      resultArchiveExists/hasLaterRoundArchive ("UNKNOWN_FAILURE_CODE", 1,
//      undefined, "coder-task-r99.md") are pinned by name and all close the
//      door (no more truthy-fold), plus one freshly-invented garbage value
//      this round adds on its own to prove the closed-by-structure claim
//      isn't "one more value enumerated" but a real three-way branch.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  evaluateNeverConsumedRetirement,
  NEVER_CONSUMED_RETIRE_STATE,
} from "./hyk412-never-consumed-retire-core.mjs";
import { archiveRoundTaskFile } from "./envelope-archive.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = join(CHECK_DIR, "hyk412-never-consumed-retire-core.mjs");

function tmpHarnessDir() {
  return mkdtempSync(join(tmpdir(), "hyk412-never-consumed-"));
}

// A facts object every guard should accept -- the baseline for both the
// closed-branch tests (mutate one field away from this) and the mutation
// tests (cut one guard, this SAME violating-facts object should then wrongly
// pass).
function openFacts(overrides = {}) {
  return {
    role: "CODER",
    harnessTaskLabel: "HYK-999-never-touched-1",
    ledgerReservation: {
      exists: true,
      harnessTaskLabel: "HYK-999-never-touched-1",
      status: "ACTIVE",
      completedAt: null,
    },
    dispatchReceiptMatchCount: 1,
    resultArchiveExists: false,
    ownTaskArchiveExists: true,
    hasLaterRoundArchive: false,
    staleEnoughSinceAdmission: true,
    successorLabelForRecord: "HYK-999-never-touched-2",
    ...overrides,
  };
}

// 3R ⓑ: reads the REAL rounds/ directory an archiver call actually produced
// and computes the three archive-shape booleans from it -- mirrors what a
// future live adapter would do (readdirSync + the exact naming conventions
// envelope-archive.mjs's own nextTaskArchiveFileName/nextArchiveFileName
// use), instead of a test author hand-typing `true`/`false` (검토 P2).
function deriveArchiveShapeFactsFromRealDirectory({
  harnessDir,
  taskRole,
  resultRole,
  roundNumber,
}) {
  const roundsDir = join(harnessDir, "rounds");
  const existing = existsSync(roundsDir) ? readdirSync(roundsDir) : [];
  const ownTaskPattern = new RegExp(
    `^${taskRole}-task-r${roundNumber}\\.md$`,
    "i",
  );
  const laterTaskPattern = new RegExp(`^${taskRole}-task-r(\\d+)\\.md$`, "i");
  const resultPattern = new RegExp(`^${resultRole}-r\\d+\\.md$`, "i");
  const ownTaskArchiveExists = existing.some((name) =>
    ownTaskPattern.test(name),
  );
  const hasLaterRoundArchive = existing.some((name) => {
    const m = laterTaskPattern.exec(name);
    return m ? Number(m[1]) > roundNumber : false;
  });
  const resultArchiveExists = existing.some((name) => resultPattern.test(name));
  return { ownTaskArchiveExists, hasLaterRoundArchive, resultArchiveExists };
}

test("OPEN: every guard satisfied -> door opens, ok:true", () => {
  const result = evaluateNeverConsumedRetirement(openFacts());
  assert.equal(result.state, NEVER_CONSUMED_RETIRE_STATE.OPEN);
  assert.equal(result.ok, true);
});

// --- §1: the axis is TRUE in a real, archiver-produced round shape, with
// booleans COMPUTED from the real directory (3R fix for review P2) --------

test("REAL SHAPE: a genuinely never-retried round -- booleans computed by reading the real archiver-produced directory, not hand-typed", () => {
  const harnessDir = tmpHarnessDir();
  try {
    const dispatched = archiveRoundTaskFile({
      role: "coder",
      taskContent:
        "task_id: HYK-999-never-touched-1\ndropped_at: 2026-09-01 05:00 KST\n",
      harnessDir,
    });
    assert.equal(
      dispatched.ok,
      true,
      "round 1's own dispatch must archive its own task file",
    );
    // The bug 1R had: it checked THIS round's own archive count and expected
    // 0. That count is always >= 1 the instant dispatch happens -- proven
    // directly here.
    assert.match(dispatched.path, /coder-task-r1\.md$/);

    const shape = deriveArchiveShapeFactsFromRealDirectory({
      harnessDir,
      taskRole: "coder",
      resultRole: "CODER",
      roundNumber: 1,
    });
    assert.deepEqual(shape, {
      ownTaskArchiveExists: true,
      hasLaterRoundArchive: false,
      resultArchiveExists: false,
    });

    const result = evaluateNeverConsumedRetirement(openFacts(shape));
    assert.equal(result.state, NEVER_CONSUMED_RETIRE_STATE.OPEN);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

test("REAL SHAPE: reproduces HYK-271-evidence-3/evidence-3b -- once round 2 is actually dispatched, the computed hasLaterRoundArchive flips to true and the axis correctly refuses to call round 1 'never touched'", () => {
  const harnessDir = tmpHarnessDir();
  try {
    archiveRoundTaskFile({
      role: "coder",
      taskContent:
        "task_id: HYK-271-evidence-3\ndropped_at: 2026-08-30 12:10 KST\n",
      harnessDir,
    });
    const round2 = archiveRoundTaskFile({
      role: "coder",
      taskContent:
        "task_id: HYK-271-evidence-3b\ndropped_at: 2026-08-30 14:00 KST\n",
      harnessDir,
    });
    assert.equal(round2.ok, true);
    assert.match(round2.path, /coder-task-r2\.md$/);

    const shape = deriveArchiveShapeFactsFromRealDirectory({
      harnessDir,
      taskRole: "coder",
      resultRole: "CODER",
      roundNumber: 1,
    });
    assert.deepEqual(shape, {
      ownTaskArchiveExists: true,
      hasLaterRoundArchive: true, // computed, not hand-typed -- coder-task-r2.md is real
      resultArchiveExists: false,
    });

    const result = evaluateNeverConsumedRetirement(
      openFacts({
        harnessTaskLabel: "HYK-271-evidence-3",
        ledgerReservation: {
          exists: true,
          harnessTaskLabel: "HYK-271-evidence-3",
          status: "ACTIVE",
          completedAt: null,
        },
        ...shape,
      }),
    );
    assert.equal(
      result.state,
      NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_ROUND_EXISTS,
    );
    assert.equal(result.ok, false);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

// --- closed branches: one field away from OPEN, each must reject with its
// own distinct state (미열거 기본값 닫힘, coder-task.md §2⑷) -------------

const CLOSED_BRANCH_CASES = [
  {
    name: "LABEL_MISSING (role absent)",
    overrides: { role: "" },
    expected: NEVER_CONSUMED_RETIRE_STATE.LABEL_MISSING,
  },
  {
    name: "LABEL_MISSING (harnessTaskLabel absent)",
    overrides: { harnessTaskLabel: "" },
    expected: NEVER_CONSUMED_RETIRE_STATE.LABEL_MISSING,
  },
  {
    name: "LEDGER_RECORD_MISSING",
    overrides: { ledgerReservation: { exists: false } },
    expected: NEVER_CONSUMED_RETIRE_STATE.LEDGER_RECORD_MISSING,
  },
  {
    name: "LEDGER_RECORD_LABEL_MISMATCH (evidence-3b shape: ledger label differs from task label)",
    overrides: {
      ledgerReservation: {
        exists: true,
        harnessTaskLabel: "HYK-999-never-touched-1-DIFFERENT",
        status: "ACTIVE",
        completedAt: null,
      },
    },
    expected: NEVER_CONSUMED_RETIRE_STATE.LEDGER_RECORD_LABEL_MISMATCH,
  },
  {
    name: "LEDGER_NOT_ACTIVE (status COMPLETED)",
    overrides: {
      ledgerReservation: {
        exists: true,
        harnessTaskLabel: "HYK-999-never-touched-1",
        status: "COMPLETED",
        completedAt: "2026-09-01T00:00:00.000Z",
      },
    },
    expected: NEVER_CONSUMED_RETIRE_STATE.LEDGER_NOT_ACTIVE,
  },
  {
    name: "DISPATCH_RECEIPT_NOT_EXACTLY_ONE (0 matches)",
    overrides: { dispatchReceiptMatchCount: 0 },
    expected: NEVER_CONSUMED_RETIRE_STATE.DISPATCH_RECEIPT_NOT_EXACTLY_ONE,
  },
  {
    name: "DISPATCH_RECEIPT_NOT_EXACTLY_ONE (2 matches, label reuse)",
    overrides: { dispatchReceiptMatchCount: 2 },
    expected: NEVER_CONSUMED_RETIRE_STATE.DISPATCH_RECEIPT_NOT_EXACTLY_ONE,
  },
  {
    name: "RESULT_ARCHIVE_ALREADY_EXISTS (explicit true)",
    overrides: { resultArchiveExists: true },
    expected: NEVER_CONSUMED_RETIRE_STATE.RESULT_ARCHIVE_ALREADY_EXISTS,
  },
  {
    name: 'RESULT_ARCHIVE_UNJUDGABLE (검토 injected value: "UNKNOWN_FAILURE_CODE") -- 3R fix',
    overrides: { resultArchiveExists: "UNKNOWN_FAILURE_CODE" },
    expected: NEVER_CONSUMED_RETIRE_STATE.RESULT_ARCHIVE_UNJUDGABLE,
  },
  {
    name: "RESULT_ARCHIVE_UNJUDGABLE (검토 injected value: 1) -- 3R fix",
    overrides: { resultArchiveExists: 1 },
    expected: NEVER_CONSUMED_RETIRE_STATE.RESULT_ARCHIVE_UNJUDGABLE,
  },
  {
    name: "RESULT_ARCHIVE_UNJUDGABLE (검토 injected value: undefined) -- 3R fix",
    overrides: { resultArchiveExists: undefined },
    expected: NEVER_CONSUMED_RETIRE_STATE.RESULT_ARCHIVE_UNJUDGABLE,
  },
  {
    name: "RESULT_ARCHIVE_UNJUDGABLE (novel garbage this round invents: a plain object) -- 3R 완료 조건 2, 미열거 기본값이 구조적으로 닫힘을 재확인",
    overrides: { resultArchiveExists: { nested: true } },
    expected: NEVER_CONSUMED_RETIRE_STATE.RESULT_ARCHIVE_UNJUDGABLE,
  },
  {
    name: "OWN_TASK_ARCHIVE_MISSING (structurally impossible for a real dispatch, refuse anyway)",
    overrides: { ownTaskArchiveExists: false },
    expected: NEVER_CONSUMED_RETIRE_STATE.OWN_TASK_ARCHIVE_MISSING,
  },
  {
    name: "SUCCESSOR_ROUND_EXISTS (explicit true)",
    overrides: { hasLaterRoundArchive: true },
    expected: NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_ROUND_EXISTS,
  },
  {
    name: 'SUCCESSOR_ROUND_ARCHIVE_UNJUDGABLE (검토 injected value: "coder-task-r99.md") -- 3R fix',
    overrides: { hasLaterRoundArchive: "coder-task-r99.md" },
    expected: NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_ROUND_ARCHIVE_UNJUDGABLE,
  },
  {
    name: "SUCCESSOR_ROUND_ARCHIVE_UNJUDGABLE (검토 injected value: undefined) -- 3R fix",
    overrides: { hasLaterRoundArchive: undefined },
    expected: NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_ROUND_ARCHIVE_UNJUDGABLE,
  },
  {
    name: "SUCCESSOR_ROUND_ARCHIVE_UNJUDGABLE (novel garbage this round invents: NaN) -- 3R 완료 조건 2",
    overrides: { hasLaterRoundArchive: NaN },
    expected: NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_ROUND_ARCHIVE_UNJUDGABLE,
  },
  {
    name: "TOO_RECENT",
    overrides: { staleEnoughSinceAdmission: false },
    expected: NEVER_CONSUMED_RETIRE_STATE.TOO_RECENT,
  },
  {
    name: "SUCCESSOR_LABEL_MISSING",
    overrides: { successorLabelForRecord: "" },
    expected: NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_LABEL_MISSING,
  },
];

for (const { name, overrides, expected } of CLOSED_BRANCH_CASES) {
  test(`CLOSED: ${name}`, () => {
    const result = evaluateNeverConsumedRetirement(openFacts(overrides));
    assert.equal(result.state, expected);
    assert.equal(result.ok, false);
  });
}

// --- mutation tests: cut each guard clause in the REAL source (in-memory
// string surgery + dynamic import of the mutated copy under a tmp path --
// the real file on disk is never written to, so restoration is byte-
// identical by construction, nothing to undo). Doc count must match this
// count exactly (design doc states 11, 3R -- see docs/HYK-412-stuck-retire-
// design.md). 10 call-site guards (one per rejection state family) + 1 new
// mutant (3R) that cuts ONLY the shared UNJUDGABLE branch inside
// checkExplicitNegativeFact (the exact new protection review P1 demanded) --
// proven separately from the call-site guards because RESULT_ARCHIVE and
// SUCCESSOR_ROUND now share that one helper function.
const MUTATION_CASES = [
  {
    name: "LABEL_MISSING guard cut",
    marker:
      "if (!isNonEmptyString(role) || !isNonEmptyString(harnessTaskLabel)) {",
    violatingFacts: openFacts({ role: "" }),
  },
  {
    name: "LEDGER_RECORD_MISSING guard cut",
    marker: "if (ledgerReservation?.exists !== true) {",
    // Only `exists` is wrong -- every other field already matches, so
    // cutting THIS guard specifically (not a downstream one) is what must
    // let it through.
    violatingFacts: openFacts({
      ledgerReservation: {
        exists: false,
        harnessTaskLabel: "HYK-999-never-touched-1",
        status: "ACTIVE",
        completedAt: null,
      },
    }),
  },
  {
    name: "LEDGER_RECORD_LABEL_MISMATCH guard cut",
    marker: "if (ledgerReservation.harnessTaskLabel !== harnessTaskLabel) {",
    violatingFacts: openFacts({
      ledgerReservation: {
        exists: true,
        harnessTaskLabel: "DIFFERENT-LABEL",
        status: "ACTIVE",
        completedAt: null,
      },
    }),
  },
  {
    name: "LEDGER_NOT_ACTIVE guard cut",
    marker:
      'if (\n    ledgerReservation.status !== "ACTIVE" ||\n    ledgerReservation.completedAt !== null\n  ) {',
    violatingFacts: openFacts({
      ledgerReservation: {
        exists: true,
        harnessTaskLabel: "HYK-999-never-touched-1",
        status: "COMPLETED",
        completedAt: "2026-09-01T00:00:00.000Z",
      },
    }),
  },
  {
    name: "DISPATCH_RECEIPT_NOT_EXACTLY_ONE guard cut",
    marker: "if (dispatchReceiptMatchCount !== 1) {",
    violatingFacts: openFacts({ dispatchReceiptMatchCount: 0 }),
  },
  {
    name: "RESULT_ARCHIVE call-site guard cut (both RESULT_ARCHIVE_ALREADY_EXISTS and RESULT_ARCHIVE_UNJUDGABLE stop being enforced)",
    marker: "if (resultArchiveFailure) return resultArchiveFailure;",
    violatingFacts: openFacts({ resultArchiveExists: true }),
  },
  {
    name: "OWN_TASK_ARCHIVE_MISSING guard cut",
    marker: "if (ownTaskArchiveExists !== true) {",
    violatingFacts: openFacts({ ownTaskArchiveExists: false }),
  },
  {
    name: "SUCCESSOR_ROUND call-site guard cut (both SUCCESSOR_ROUND_EXISTS and SUCCESSOR_ROUND_ARCHIVE_UNJUDGABLE stop being enforced)",
    marker: "if (successorRoundFailure) return successorRoundFailure;",
    violatingFacts: openFacts({ hasLaterRoundArchive: true }),
  },
  {
    name: "TOO_RECENT guard cut",
    marker: "if (staleEnoughSinceAdmission !== true) {",
    violatingFacts: openFacts({ staleEnoughSinceAdmission: false }),
  },
  {
    name: "SUCCESSOR_LABEL_MISSING guard cut",
    marker: "if (!isNonEmptyString(successorLabelForRecord)) {",
    violatingFacts: openFacts({ successorLabelForRecord: "" }),
  },
  {
    // 3R NEW: cuts only the shared helper's UNJUDGABLE branch (leaves the
    // `=== true` branch intact) -- proves the truthy-fold fix itself (검토
    // P1) is load-bearing, independent of the call-site-level mutants above
    // (which would also pass even if this specific branch were dead code,
    // since they cut the whole call site). Uses the exact literal value
    // review injected against resultArchiveExists.
    name: "shared checkExplicitNegativeFact UNJUDGABLE branch cut (3R fix for 검토 P1's truthy-fold)",
    marker: "if (value !== false) {",
    violatingFacts: openFacts({ resultArchiveExists: "UNKNOWN_FAILURE_CODE" }),
  },
];

assert.equal(
  MUTATION_CASES.length,
  11,
  "mutation case count must match the design doc's stated count (11, 3R)",
);

// Cuts a single `if (...) { ... return reject(...); }` block by finding the
// marker line and the matching closing brace at the same nesting depth, then
// deleting that whole block from the source text.
function cutGuardBlock(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(
    start >= 0,
    `mutation marker not found in current source: ${marker}`,
  );
  let depth = 0;
  let i = start;
  let braceSeen = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      depth++;
      braceSeen = true;
    } else if (ch === "}") {
      depth--;
      if (braceSeen && depth === 0) {
        i++; // include the closing brace
        break;
      }
    }
  }
  return src.slice(0, start) + src.slice(i);
}

// A single-line `if (cond) return X;` (no braces) is cut by deleting just
// that line -- cutGuardBlock's brace-matcher would otherwise swallow the
// next unrelated block (there is no opening `{` on these lines).
function cutSingleLineGuard(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(
    start >= 0,
    `mutation marker not found in current source: ${marker}`,
  );
  const lineEnd = src.indexOf("\n", start);
  assert.ok(lineEnd >= 0, "mutation marker's line must end with a newline");
  return src.slice(0, start) + src.slice(lineEnd + 1);
}

const SINGLE_LINE_MUTATION_MARKERS = new Set([
  "if (resultArchiveFailure) return resultArchiveFailure;",
  "if (successorRoundFailure) return successorRoundFailure;",
]);

for (const { name, marker, violatingFacts } of MUTATION_CASES) {
  test(`MUTATION: ${name} -- cutting it wrongly opens the door for facts that should stay closed`, async () => {
    const src = readFileSync(CORE_PATH, "utf8");
    const occurrences = src.split(marker).length - 1;
    assert.equal(
      occurrences,
      1,
      `mutation marker must appear exactly once in current source (found ${occurrences}): ${marker}`,
    );
    const mutated = SINGLE_LINE_MUTATION_MARKERS.has(marker)
      ? cutSingleLineGuard(src, marker)
      : cutGuardBlock(src, marker);
    assert.notEqual(mutated, src, "mutation must actually change the source");

    const tmpDirPath = mkdtempSync(join(tmpdir(), "hyk412-mut-"));
    try {
      const mutantPath = join(tmpDirPath, "mutant.mjs");
      writeFileSync(mutantPath, mutated, "utf8");

      const mutantModule = await import(
        `file://${mutantPath}?t=${Date.now()}-${Math.random()}`
      );
      const result =
        mutantModule.evaluateNeverConsumedRetirement(violatingFacts);
      assert.equal(
        result.ok,
        true,
        "RED: cutting this guard must wrongly open the door for a facts object that should be rejected",
      );
      assert.equal(result.state, NEVER_CONSUMED_RETIRE_STATE.OPEN);
    } finally {
      rmSync(tmpDirPath, { recursive: true, force: true });
    }

    // Restoration proof: the real source file was only ever opened for
    // reading in this test, never for writing -- byte-identical by
    // construction.
    const after = readFileSync(CORE_PATH, "utf8");
    assert.equal(
      after,
      src,
      "원복 증명 실패: 실제 hyk412-never-consumed-retire-core.mjs가 이 시험 도중 바뀌었다",
    );
  });
}
