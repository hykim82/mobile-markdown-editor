// HYK-271-marker-catalog-1 (2R widen) added "Enter to select" to
// MODAL_MARKERS as a STANDALONE substring to catch the two real selection-
// menu incidents cited below. Review (P1-1) proved that standalone form
// false-positived on ordinary prose. HYK-271-marker-catalog-3 (2R repair)
// replaced it with MODAL_TAIL_COMBO (a proximity-combo check,
// dispatch-worker-modal-check.mjs) PLUS a self-catalog-quote strip to also
// unblock a self-edit-screen sample. Review (2R P1) then proved that strip
// silently deleted real modal text too (a false NEGATIVE, worse than the
// false positive it fixed). HYK-271-marker-catalog-4 (3R criterion-
// correction repair, ORCH gate-2 verdict A) removes the strip entirely --
// the "editing screen must also be NON_MODAL" requirement that forced it
// into existence is withdrawn as a spec error. This file now measures:
// the combo (kept, unchanged), the self-edit-screen sample re-labeled as a
// KNOWN OVER-BLOCK (an accepted limitation, not something this catalog
// tries to fix), and the reviewer's exact false-negative reproduction
// (now closed simply because the strip that caused it is gone).
//
// This file is deliberately separate from hyk271-axis-preview-marker-
// synthetic.test.mjs. That file's own header draws an explicit honesty line
// ("hand-authored strings ... NOT captured from a live seat ... NOT a
// citation of this repository's own prior incident transcript") -- mixing
// real incident text and real live-seat previews into that file would
// silently erase that line. This file exists precisely because that line no
// longer holds for the two real-incident samples below: they ARE real
// incident transcripts, cited by source.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePreview,
  previewContainsMarker,
} from "./adapters/orca-adapter.mjs";
import {
  MODAL_MARKERS,
  MODAL_TAIL_COMBO,
  previewMatchesTailCombo,
} from "./dispatch-worker-modal-check.mjs";

// Mirrors runModalCheck's own two-stage check (standalone markers, then the
// tail combo) without re-deriving either -- both primitives are imported
// unmodified. `markers`/`combo` are overridable for the mutation test below,
// same test-seam shape as runModalCheck's opts.markers/opts.tailCombo.
function classify(preview, markers = MODAL_MARKERS, combo = MODAL_TAIL_COMBO) {
  return (
    markers.some((marker) => previewContainsMarker(preview, marker)) ||
    previewMatchesTailCombo(preview, combo)
  );
}

// ---------------------------------------------------------------------------
// Positive corpus -- the two real incident samples coder-task.md §1 (2R
// widen round) cites (verbatim, not paraphrased). Both must classify MODAL
// under the combo.
// ---------------------------------------------------------------------------
export const REAL_INCIDENT_SAMPLES = [
  {
    label: "real-incident-A-founding-hyk271-issue-body",
    // Source: HYK-271 issue body, a transcript a human operator read
    // directly off a stuck seat on 2026-08-16. This is the screen that
    // opened this issue.
    preview:
      "Claude-in-chrome MCP Server\nStatus: connected\n1. View tools\n2. Reconnect\n3. Disable\n↑↓ to navigate · Enter to select · Esc to back",
  },
  {
    label: "real-incident-B-today-hyk415-worker-block",
    // Source: an HYK-415 worker seat, observed stuck for 20 minutes on
    // 2026-09-01 20:0x. This is the same class of gap recurring in
    // production, on the day the widen round was scoped.
    preview:
      "npm test (전체 러너)가 백그라운드에서 아직 실행 중입니다(8분 타임아웃 초과).\n완료 알림을 기다릴까요, 아니면 지금 상태를 확인할까요?\n❯ 1. 완료 알림 기다리기 (권장)\n  2. 지금 중간 출력 확인\n  3. Type something.\nEnter to select · ↑/↓ to navigate · Esc to cancel",
  },
];

// ---------------------------------------------------------------------------
// Negative corpus -- all 14 live, non-stuck seat previews ORCH measured with
// `orca terminal list --json` on 2026-09-01 22:05, reproduced verbatim
// (including truncation, redraw noise, and mixed encoding). None of these
// seats were blocked; every one must classify NON_MODAL.
// ---------------------------------------------------------------------------
export const LIVE_SEAT_SAMPLES = [
  {
    label: "01-hyk415-canonical-sync-1",
    preview:
      "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk415-canonical-sync-1>",
  },
  {
    label: "02-hyk415-canonical-sync-review",
    preview:
      "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk415-canonical-sync-review>",
  },
  {
    label: "03-hyk415-canonical-sync-review-codex-status-bar",
    preview:
      " 86% lef…ng Stop ho•g Stop hoo\n─ Worked for 19m 00s ───────────────────────────────────────────────────────────────────────────────────────────────────  › Ask Codex to do anything   gpt-5.6-luna xhigh · ~\\orca\\workspaces\\HARNESSENGINEERING\\hyk415-canonical-sync-review · Context 8% used · 5h 86% lef…",
  },
  {
    label: "04-HARNESSENGINEERING-effecting",
    preview: "✽ Effecting…",
  },
  {
    label: "05-pm-lane-repeated-prompt",
    preview:
      "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\pm-lane> PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\pm-lane> PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\pm-lane>PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\pm-lane>",
  },
  {
    label: "06-hyk389-send-boundary-1-coder-seat-banner",
    preview:
      "nstalled hooks (C:\\Users\\Administrator\\Documents\\HARNESSENGINEERING\\.git\\hooks) match versioned hooks/. 좌석 기동 가능.\n[CODER seat] worktree=C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk389-send-boundary-1  pane=e2edb904-64b2-43ba-a40b-50ebbb6308d7:591d3382-7e00-440f-9776-b4329bf2ddce\n/rc",
  },
  {
    label: "07-hyk394-narrow-1",
    preview:
      "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk394-narrow-1>",
  },
  {
    label: "08-hyk394-narrow-1-npm-audit-tail",
    preview:
      "run `npm fund` for details\n1 high severity vulnerability\nTo address all issues, run:\nnpm audit fix\nRun `npm audit` for details.\nPS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk394-narrow-1>",
  },
  {
    label: "09-hyk394-narrow-1-coder-seat-banner-plus-clear-prompt",
    preview:
      "trator\\Documents\\HARNESSENGINEERING\\.git\\hooks) match versioned hooks/. 좌석 기동 가능.\n[CODER seat] worktree=C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk394-narrow-1  pane=126b44f1-942d-4514-846f-275078864e48:ff58ccf2-766e-4188-b4f2-69d1d24dc06e\nnew task? /clear to save 230.6k tokensBBBB",
  },
  {
    label: "10-hyk412-stuck-retire-1",
    preview:
      "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk412-stuck-retire-1>",
  },
  {
    label: "11-hyk412-stuck-retire-1-coder-seat-banner-plus-clear-prompt",
    preview:
      "ator\\Documents\\HARNESSENGINEERING\\.git\\hooks) match versioned hooks/. 좌석 기동 가능.\n[CODER seat] worktree=C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk412-stuck-retire-1  pane=1cfee20b-56b4-4a9a-b5d3-89ded07b83b5:c71e3b37-1f66-49d9-965e-398c30f2a389\nnew task? /clear to save 220.9k tokens",
  },
  {
    label: "12-hyk412-stuck-retire-review",
    preview:
      "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk412-stuck-retire-review>",
  },
  {
    label: "13-hyk412-stuck-retire-review-codex-status-bar",
    preview:
      "p hookop hook•p hook hookookok\n─ Worked for 21m 32s ───────────────────────────────────────────────────────────────────────────────────────────────────  › Ask Codex to do anything   gpt-5.6-luna xhigh · ~\\orca\\workspaces\\HARNESSENGINEERING\\hyk412-stuck-retire-review · Context 79% used · 5h 90% left…",
  },
  {
    label:
      "14-hyk415-canonical-sync-1-coder-seat-banner-plus-clear-prompt (WARNING: contains '[CODER seat]' delivery banner -- if a marker matched this, every delivery would self-block)",
    preview:
      "or\\Documents\\HARNESSENGINEERING\\.git\\hooks) match versioned hooks/. 좌석 기동 가능.\n[CODER seat] worktree=C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk415-canonical-sync-1  pane=fdf2c90b-df3d-4750-ab1c-37ced862e214:0ea3f96c-103a-41fe-b612-f9dd64c077d0\nnew task? /clear to save 417.2k tokens",
  },
];

// ---------------------------------------------------------------------------
// False-positive corpus (review P1-1). Both must classify NON_MODAL --
// "Enter to select" and its companion appear far apart, unlike a rendered
// hint bar where they sit right next to each other.
// ---------------------------------------------------------------------------
export const FALSE_POSITIVE_SAMPLES = [
  {
    label: "false-positive-ordinary-menu-prose",
    // A normal explanatory sentence about keyboard shortcuts -- exactly the
    // shape review P1-1 flagged the standalone "Enter to select" substring
    // as blocking. "Enter to select" and "to navigate" both appear, but far
    // apart (well beyond MODAL_TAIL_COMBO.maxGapChars=15).
    preview:
      "To use this interactive menu, press Enter to select the highlighted item. You can also use the arrow keys to navigate between the available options, or press Escape at any time to cancel.",
  },
  {
    label: "false-positive-ordinary-documentation-prose",
    // A README/help-doc style paragraph mentioning the phrase in passing,
    // not rendering an actual hint bar.
    preview:
      "## Keyboard shortcuts\n\nMost of this tool's interactive prompts follow the same convention: hit Enter to select whatever option is currently highlighted. Full documentation for all supported keybindings lives in docs/keybindings.md.",
  },
];

// ---------------------------------------------------------------------------
// KNOWN OVER-BLOCK (HYK-271-marker-catalog-4, ORCH gate-2 verdict A):
// this is NOT a defect this catalog tries to fix -- same convention as
// dispatch-worker-modal-check.test.mjs's "KNOWN MISS" sample. A seat
// editing this catalog's own source (or viewing a diff of it) that shows a
// marker string is accepted to self-block; an earlier attempt to close this
// by deleting quoted catalog text from the preview before matching also
// silently deleted real modal text (review 2R P1) -- that attempt was
// withdrawn as a spec error (the requirement forcing it into existence was
// impossible to satisfy safely), not re-attempted here. See design doc
// appendix for the withdrawal history.
// ---------------------------------------------------------------------------
export const KNOWN_OVER_BLOCK_SAMPLES = [
  {
    label: "known-over-block-self-edit-screen (coder-task.md §1 exact quote)",
    // Source: 2R-widen coder-task.md §1 -- ORCH's direct observation of the
    // CODER seat's own screen while it was mid-diff editing MODAL_MARKERS.
    // This matches via the ORIGINAL standalone "Allow command?" marker
    // (measured: MODAL_TAIL_COMBO does NOT match this sample -- no
    // companion word is present), not the new combo -- the over-block was
    // never about "Enter to select" alone. expectModal:true, not a typo.
    preview:
      '      237      "Allow command?",\n      238 +    "Enter to select",\n      239    ]);',
    expectModal: true,
  },
];

// ---------------------------------------------------------------------------
// Reviewer's exact false-negative reproduction (2R P1, HYK-271-marker-
// catalog-4 §2⑵ⓓ): with the self-catalog-quote strip now removed, this is
// simply a real approval-prompt render containing "Allow command?" -- must
// classify MODAL like any other command-approval prompt.
// ---------------------------------------------------------------------------
export const REVIEWER_FALSE_NEGATIVE_SAMPLE = {
  label: "reviewer-2R-P1-false-negative-repro",
  preview: 'Command approval prompt\n"Allow command?",\nSelect an action',
};

// WHAT SHOULD TURN RED: if the combo stops matching either real incident
// sample (e.g. maxGapChars shrinks below the measured gap, or the primary/
// companion text drifts), this test turns red.
test("MODAL_TAIL_COMBO: both real incident samples (founding + today) classify MODAL", () => {
  const mismatches = REAL_INCIDENT_SAMPLES.filter((s) => !classify(s.preview));
  assert.deepEqual(
    mismatches.map((s) => s.label),
    [],
    `expected every real incident sample to classify MODAL, but these did not: ${JSON.stringify(mismatches.map((s) => s.label))}`,
  );
});

// WHAT SHOULD TURN RED: if a future change to the combo ever makes any of
// these 14 real, non-stuck live-seat previews classify MODAL, this test
// turns red (that would mean every delivery to that seat now
// false-positives).
test("MODAL_TAIL_COMBO: all 14 real live-seat previews (none blocked) classify NON_MODAL -- measured false positives, not asserted", () => {
  const falsePositives = LIVE_SEAT_SAMPLES.filter((s) => classify(s.preview));
  assert.deepEqual(
    falsePositives.map((s) => s.label),
    [],
    `expected zero false positives on the live-seat corpus, but these matched: ${JSON.stringify(falsePositives.map((s) => s.label))}`,
  );
});

// WHAT SHOULD TURN RED: this is the regression review P1-1 forced -- if the
// combo's proximity constraint is ever loosened back toward a standalone
// substring match, either of these turns MODAL again.
test("MODAL_TAIL_COMBO: ordinary prose and documentation both classify NON_MODAL (the false positives review P1-1 proved)", () => {
  const falsePositives = FALSE_POSITIVE_SAMPLES.filter((s) =>
    classify(s.preview),
  );
  assert.deepEqual(
    falsePositives.map((s) => s.label),
    [],
    `expected zero false positives on the adversarial corpus, but these matched: ${JSON.stringify(falsePositives.map((s) => s.label))}`,
  );
});

// WHAT SHOULD TURN RED: if this ever stops classifying MODAL, either the
// combo weakened (silently narrowing the over-block, worth re-checking
// against a real incident) or something else changed this sample's shape --
// this pin exists so the over-block stays a documented, deliberate choice
// rather than a silently-drifting accident (KNOWN MISS convention).
test("KNOWN OVER-BLOCK (accepted limitation, not a defect): the self-edit-screen sample still classifies MODAL -- fixing it previously required deleting real modal text (2R P1), so it is not fixed here", () => {
  for (const s of KNOWN_OVER_BLOCK_SAMPLES) {
    assert.equal(
      classify(s.preview),
      s.expectModal,
      `expected "${s.label}" to classify MODAL (accepted over-block)`,
    );
  }
});

// WHAT SHOULD TURN RED: this is the exact sample review (2R P1) used to
// prove the (now-removed) preview-cleaning step that ran before matching
// silently deleted real modal text. With that step removed, this must
// classify MODAL like any other "Allow command?" approval prompt.
test("reviewer's 2R-P1 false-negative reproduction now classifies MODAL (the removed step that caused the miss is gone, not narrowed)", () => {
  assert.equal(
    classify(REVIEWER_FALSE_NEGATIVE_SAMPLE.preview),
    true,
    `expected "${REVIEWER_FALSE_NEGATIVE_SAMPLE.label}" to classify MODAL`,
  );
});

// ---------------------------------------------------------------------------
// Reversal mutation (coder-task.md §2⑵ⓓ -- "콤보를 끄면 두 실사고가 NON_MODAL로
// 새는지 확인 + 바이트 동일 복원"): disable the tail combo entirely and
// confirm both real incident samples leak back to NON_MODAL. This proves
// the combo, not something else (e.g. one of the original 4 MODAL_MARKERS),
// is what catches them. This never edits the source file -- MODAL_TAIL_COMBO
// is asserted byte-identical before and after.
// ---------------------------------------------------------------------------
test("mutation (되돌림 변이): disabling MODAL_TAIL_COMBO entirely lets BOTH real incident samples leak back to NON_MODAL -- proves the combo, not the original 4 markers, is what catches them", () => {
  const before = JSON.stringify(MODAL_TAIL_COMBO);

  const withCombo = REAL_INCIDENT_SAMPLES.map((s) => classify(s.preview));
  assert.deepEqual(
    withCombo,
    [true, true],
    "sanity: unmutated combo must classify both real incident samples MODAL",
  );

  const withoutCombo = REAL_INCIDENT_SAMPLES.map((s) =>
    classify(s.preview, MODAL_MARKERS, null),
  );
  assert.deepEqual(
    withoutCombo,
    [false, false],
    "disabling the tail combo must let both real incident samples leak back to NON_MODAL",
  );

  // byte-identical restoration check: this test never mutated the source
  // module's export, only passed a local override -- confirm that holds.
  assert.equal(
    JSON.stringify(MODAL_TAIL_COMBO),
    before,
    "MODAL_TAIL_COMBO must be byte-identical to what it was before this test ran",
  );
});

// Sanity check on normalizePreview against the two real samples specifically
// (both contain non-ASCII middle-dot separators and Korean text around the
// marker -- confirm whitespace normalization doesn't need to touch them for
// the marker match to work).
test("sanity: 'Enter to select' appears verbatim in both real incident samples even before normalization", () => {
  for (const s of REAL_INCIDENT_SAMPLES) {
    assert.ok(
      s.preview.includes("Enter to select"),
      `expected raw preview for "${s.label}" to already contain 'Enter to select' verbatim`,
    );
    assert.ok(
      normalizePreview(s.preview).includes("Enter to select"),
      `expected normalized preview for "${s.label}" to contain 'Enter to select'`,
    );
  }
});
