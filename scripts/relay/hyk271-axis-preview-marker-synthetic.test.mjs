// HYK-271-preflight-1 (1R): synthetic-sample proof for the AXIS CHOICE this
// round makes (coder-task.md §2 -- "pick an axis and prove it distinguishes
// a modal-blocked seat from a normal idle seat with synthetic samples, do
// not just assert it would work").
//
// This does NOT reimplement detection logic (coder-task.md precedent
// "대조 로직을 새로 쓰지 마라") -- normalizePreview/previewContainsMarker are
// imported unmodified from scripts/relay/adapters/orca-adapter.mjs (already
// merged, PR #232's axis-orca-query-preview evidence_kind=동작코드 pointer).
// This file only supplies (a) a marker catalog and (b) synthetic preview
// samples, then measures the existing function against them. The
// measurement itself -- not the code under test -- is the new evidence this
// round produces (evidence_kind 실측관측 per the inventory's own contract in
// hyk271-modal-detect-inventory.test.mjs).
//
// Honesty boundary (read before citing this file as evidence elsewhere):
// the MODAL_MARKER_SAMPLES below are hand-authored strings that resemble the
// publicly documented shape of Claude Code / Codex CLI interactive
// permission prompts (e.g. "Do you want to proceed?" / numbered
// yes-options, "Allow command?"). They are NOT captured from a live seat
// (coder-task.md §0 forbids inducing a modal on a live seat) and are NOT a
// citation of this repository's own prior incident transcript -- no such
// repo-tracked transcript exists for a *command-approval* modal (the one
// incident this repo does cite, HYK-379, is an *update-confirmation*
// modal with different text, and axis-process-pty-liveness's 3R evidence
// explicitly flags that generalizing across modal *kinds* is unproven).
// So: this proves "IF a modal's rendered text looks like these samples,
// marker matching distinguishes it from idle/busy text" -- it does NOT
// prove "these are the exact strings a real command-approval modal renders
// in this orca setup". See docs/control-room-patches/HYK-271-preflight-preview-marker.md
// §4 for what remains unmeasured.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePreview,
  previewContainsMarker,
} from "./adapters/orca-adapter.mjs";
// HYK-271-wire-1: MODAL_MARKERS now lives in dispatch-worker-modal-check.mjs
// (the production sidecar this axis got wired into) -- imported back here
// rather than kept as a second copy, so the catalog has exactly one source
// (design doc §1-b: this list is unverified against real modal text, and
// two copies would risk silently drifting apart).
import { MODAL_MARKERS } from "./dispatch-worker-modal-check.mjs";

function classifyPreviewForModal(preview, markers = MODAL_MARKERS) {
  return markers.some((marker) => previewContainsMarker(preview, marker));
}

// Synthetic samples. "idle"/"busy" = what a normal, undispatched seat looks
// like (must classify NOT modal). "modal" = full, undamaged marker text
// (must classify modal). "modal-truncated" = the known, previously-flagged
// weakness (mid-redraw marker split across a shell-predictive-echo
// boundary) -- MUST classify NOT modal, and that failure is the point of
// the sample, not a bug in the test.
// HYK-271-wire-1: exported so dispatch-worker-modal-check.test.mjs can
// reuse these exact samples (coder-task.md §2⑵ "합성 표본은 기존 ...의
// 표본을 재사용하라(새로 지어내지 마라)") instead of re-authoring them.
export const SAMPLES = [
  {
    label: "idle-shell-prompt",
    preview: "PS C:\\Users\\Administrator\\worktree> ",
    expectModal: false,
  },
  {
    label: "idle-empty-preview",
    preview: "",
    expectModal: false,
  },
  {
    label: "busy-actively-working",
    preview: "esc to interrupt) Running tests... (12s)",
    expectModal: false,
  },
  {
    label: "busy-queued-message-signal",
    preview: "Press up to edit queued messages",
    expectModal: false,
  },
  {
    label: "idle-conversation-mentions-yes-no",
    // adversarial: normal assistant prose that happens to contain
    // question-shaped words, must not false-positive on a loose classifier.
    // (None of MODAL_MARKERS's exact phrases appear here -- this checks the
    // catalog is specific enough not to fire on ordinary text.)
    preview: "Should I proceed with the refactor? Let me know either way.",
    expectModal: false,
  },
  {
    label: "modal-claude-permission-full",
    preview:
      "Do you want to proceed?\n1. Yes\n2. Yes, and don't ask again this session\n3. No, and tell Claude what to do differently",
    expectModal: true,
  },
  {
    label: "modal-codex-approval-full",
    preview: "Allow command? [y/N] git push origin main",
    expectModal: true,
  },
  {
    label: "modal-claude-permission-with-redraw-noise",
    // realistic shell predictive-echo interleaving (whitespace collapse
    // handles this -- normalizePreview already folds runs of whitespace).
    preview: "Do   you  want to\nproceed?   1. Yes",
    expectModal: true,
  },
  {
    label: "modal-truncated-marker-split-mid-word (KNOWN MISS)",
    // the exact weakness the inventory already flags in prose
    // (distinguishes_idle: "모달 마커가 재그림 구간에 걸리면 위음성이 날 수
    // 있다") -- here it is reproduced as a concrete, measured sample instead
    // of an assumption. The marker word itself is split by a redraw
    // artifact (a stray control character represented here as a literal
    // mid-word cut), which defeats substring matching even after
    // whitespace normalization.
    preview: "Do you want to proc" + "\u0008\u0008\u0008" + "eed?",
    expectModal: false, // <- this IS the false negative, asserted on purpose
  },
];

test("normalizePreview/previewContainsMarker distinguish full-text modal previews from idle/busy previews (synthetic)", () => {
  const results = SAMPLES.map((s) => ({
    label: s.label,
    got: classifyPreviewForModal(s.preview),
    expected: s.expectModal,
  }));
  const mismatches = results.filter((r) => r.got !== r.expected);
  assert.deepEqual(
    mismatches,
    [],
    `axis-orca-query-preview marker match disagreed with expectation on: ${JSON.stringify(mismatches)}`,
  );
});

test("sanity: normalizePreview collapses the redraw-noise sample's whitespace but does not repair a mid-word control-character split", () => {
  const noisy = normalizePreview("Do   you  want to\nproceed?   1. Yes");
  assert.equal(noisy, "Do you want to proceed? 1. Yes");
  const truncated = normalizePreview(
    "Do you want to proc" + "\u0008\u0008\u0008" + "eed?",
  );
  // the control characters survive normalization (only \s is collapsed) and
  // sit inside the word "proceed", so no exact-substring marker can match
  // this -- this is what makes the KNOWN MISS sample above a genuine miss,
  // not a typo in the fixture.
  assert.ok(
    !truncated.includes("Do you want to proceed?"),
    "expected the control-character split to survive normalization and break the marker substring",
  );
});

test("measured false-positive check: none of the idle/busy samples contain any catalog marker even before classification", () => {
  const idleOrBusy = SAMPLES.filter((s) => !s.expectModal);
  for (const s of idleOrBusy) {
    for (const marker of MODAL_MARKERS) {
      assert.equal(
        previewContainsMarker(s.preview, marker),
        false,
        `expected idle/busy sample "${s.label}" not to contain marker "${marker}"`,
      );
    }
  }
});
