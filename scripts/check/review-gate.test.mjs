import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkReviewGate } from "./review-gate.mjs";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "review-gate-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("(a) no HYK tag -> ok", () => {
  const result = checkReviewGate({ message: "chore: tidy up README" });
  assert.equal(result.ok, true);
});

test("(b) HYK tag + missing review file -> blocked", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const result = checkReviewGate({
      message: "feat: add thing (HYK-999)",
      reviewPath,
    });
    assert.equal(result.ok, false);
  });
});

test("(c) HYK tag + approved review evidence with independent reviewer marker -> ok", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-999\nverdict: approved\nrole: REVIEW-CODEX\n", "utf8");
    const result = checkReviewGate({
      message: "feat: add thing (HYK-999)",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});

test("(d) skip-review trailer with reason -> ok", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const result = checkReviewGate({
      message: "fix: hotfix (HYK-999)\n\nskip-review: prod outage, approved out-of-band\n",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});

test("(e) skip-review trailer with empty reason -> blocked", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const result = checkReviewGate({
      message: "fix: hotfix (HYK-999)\n\nskip-review: \n",
      reviewPath,
    });
    assert.equal(result.ok, false);
  });
});

test("(f) inline bracket mention of skip-review is not a trailer; evidence path wins -> ok", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-999\nverdict: approved\nrole: REVIEW-CODEX\n", "utf8");
    const result = checkReviewGate({
      message:
        "fix: hotfix (HYK-999)\n\nDocs mention the `[skip-review: ]` token here.\n",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});

test("(g) inline bracket mention of skip-review, no matching evidence -> blocked with missing-evidence reason", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-000\nverdict: approved\n", "utf8");
    const result = checkReviewGate({
      message:
        "fix: hotfix (HYK-999)\n\nDocs mention the `[skip-review: whatever]` token here.\n",
      reviewPath,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing review evidence/);
  });
});

test("(h) real trailer line -> ok", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const result = checkReviewGate({
      message: "fix: x (HYK-999)\n\nskip-review: prod outage\n",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});

test("(i) HYK tag only in body prose, not in subject -> ok (not issue work)", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const result = checkReviewGate({
      message: "chore: cleanup\n\nRelated to HYK-123 sometime.\n",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});

test("(j) skip-review line mid-message (not the trailer paragraph), no matching evidence -> blocked with missing-evidence reason", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-000\nverdict: approved\n", "utf8");
    const result = checkReviewGate({
      message: "fix: x (HYK-999)\n\nskip-review: sneaky\n\nSome closing prose.\n",
      reviewPath,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing review evidence/);
  });
});

test("(k) skip-review example inside a code fence, no matching evidence -> blocked with missing-evidence reason", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-000\nverdict: approved\n", "utf8");
    const result = checkReviewGate({
      message: "fix: x (HYK-999)\n\n```\nskip-review: example only\n```\n",
      reviewPath,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing review evidence/);
  });
});

test("(l) empty skip-review example inside a code fence, evidence present -> ok via evidence path", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-999\nverdict: approved\nrole: REVIEW-CODEX\n", "utf8");
    const result = checkReviewGate({
      message: "fix: x (HYK-999)\n\n```\nskip-review:\n```\n",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});

test("(m) for + approved + independent reviewer role -> ok", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-999\nverdict: approved\nrole: REVIEW-CODEX\n", "utf8");
    const result = checkReviewGate({
      message: "feat: add thing (HYK-999)",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});

test("(n) for + approved but no reviewer role marker -> blocked as self-certification", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-999\nverdict: approved\n", "utf8");
    const result = checkReviewGate({
      message: "feat: add thing (HYK-999)",
      reviewPath,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /independent reviewer/);
  });
});

test("(o) for + approved + role is not REVIEW-* -> blocked as self-certification", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-999\nverdict: approved\nrole: ORCH-CLAUDE\n", "utf8");
    const result = checkReviewGate({
      message: "feat: add thing (HYK-999)",
      reviewPath,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /independent reviewer/);
  });
});

test("(p) ready_for_review alone (no verdict: approved) is not a pass, regardless of role marker", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-999\nready_for_review\nrole: REVIEW-CODEX\n", "utf8");
    const result = checkReviewGate({
      message: "feat: add thing (HYK-999)",
      reviewPath,
    });
    assert.equal(result.ok, false);
  });
});

test("(q) subject multi-tag + all have for: lines + approved + role -> ok", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(
      reviewPath,
      "for: HYK-98\nfor: HYK-99\nverdict: approved\nrole: REVIEW-CODEX\n",
      "utf8",
    );
    const result = checkReviewGate({
      message: "fix(init): hygiene batch (HYK-98, HYK-99)",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});

test("(r) subject multi-tag + one for: missing -> blocked, reason names missing id", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-98\nverdict: approved\nrole: REVIEW-CODEX\n", "utf8");
    const result = checkReviewGate({
      message: "fix(init): hygiene batch (HYK-98, HYK-99)",
      reviewPath,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /HYK-99/);
  });
});

test("(s) subject repeats same tag twice -> deduped, single for: line suffices -> ok", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-99\nverdict: approved\nrole: REVIEW-CODEX\n", "utf8");
    const result = checkReviewGate({
      message: "fix: HYK-99 twice HYK-99",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});

test("(t) subject has one tag, body has a different tag -> body tag not checked (subject-only semantics preserved)", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-999\nverdict: approved\nrole: REVIEW-CODEX\n", "utf8");
    const result = checkReviewGate({
      message: "feat: add thing (HYK-999)\n\nAlso touches HYK-123 in passing.\n",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});

test("(u) abbreviated enumeration '(HYK-98, 99)' in subject -> blocked, reason proposes full ids", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(
      reviewPath,
      "for: HYK-98\nfor: HYK-99\nverdict: approved\nrole: REVIEW-CODEX\n",
      "utf8",
    );
    const result = checkReviewGate({
      message: "fix(init): hygiene batch 1 (HYK-98, 99)",
      reviewPath,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /HYK-99/);
  });
});

test("(v) abbreviated enumeration with no spaces 'HYK-98,99,106' -> blocked", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const result = checkReviewGate({
      message: "fix(init): hygiene batch 1 (HYK-98,99,106)",
      reviewPath,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /abbreviated issue list/);
  });
});

test("(w) 'HYK-98, 2x faster' is not an abbreviated enumeration -> falls through to normal evidence path", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-98\nverdict: approved\nrole: REVIEW-CODEX\n", "utf8");
    const result = checkReviewGate({
      message: "perf: HYK-98, 2x faster",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});

test("(x) abbreviated enumeration + skip-review trailer -> still blocked (format check precedes skip-review)", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const result = checkReviewGate({
      message: "fix(init): hygiene batch 1 (HYK-98, 99)\n\nskip-review: prod outage, approved out-of-band\n",
      reviewPath,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /abbreviated issue list/);
  });
});

test("(y) fully-written multi-tag subject (HYK-108 style) still passes -> regression", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(
      reviewPath,
      "for: HYK-98\nfor: HYK-99\nfor: HYK-106\nverdict: approved\nrole: REVIEW-CODEX\n",
      "utf8",
    );
    const result = checkReviewGate({
      message: "fix(init): hygiene batch (HYK-98, HYK-99, HYK-106)",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});
