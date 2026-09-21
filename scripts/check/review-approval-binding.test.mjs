// HYK-240: unit tests for review-approval-binding.mjs's pure-ish functions
// (computeFingerprint/evaluateBinding/extract*/formatBindingBlock). All git
// operations run inside disposable mkdtemp repos -- the real repo/.harness
// is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  computeFingerprint,
  evaluateBinding,
  extractBindingFingerprint,
  extractBindingEntries,
  formatBindingBlock,
} from "./review-approval-binding.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk240-bind-unit-"));
  try {
    git(dir, ["init", "--quiet", "-b", "main"]);
    git(dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "base",
    ]);
    mkdirSync(join(dir, ".harness"), { recursive: true });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// computeFingerprint
// ---------------------------------------------------------------------------

// HYK-281: a clean worktree must NOT collapse to the constant empty-string
// hash (e3b0c44298fc1c...) -- that value matches any clean worktree
// regardless of code content, so a binding recorded on it isn't bound to
// anything (실측: HYK-280 검토 2R/5R, 같은 상수 두 번 재현). Clean worktrees
// bind to HEAD instead.
test("computeFingerprint: clean worktree (only .harness/ present) -> bound to HEAD commit, NOT the empty-string constant", () => {
  withRepo((dir) => {
    const head = git(dir, ["rev-parse", "HEAD"]);
    const r = computeFingerprint({ cwd: dir });
    assert.equal(r.ok, true);
    assert.notEqual(
      r.fingerprint,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "clean-tree fingerprint must never be the empty-string hash (HYK-281)",
    );
    assert.deepEqual(r.entries, [`H HEAD ${head}`]);
  });
});

test("computeFingerprint: clean worktree, then a new commit lands -> fingerprint changes (HEAD-bound, not stuck on one constant)", () => {
  withRepo((dir) => {
    const before = computeFingerprint({ cwd: dir });
    writeFileSync(join(dir, "a.js"), "one", "utf8");
    git(dir, ["add", "a.js"]);
    git(dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "add a",
    ]);
    const after = computeFingerprint({ cwd: dir });
    assert.equal(before.ok, true);
    assert.equal(after.ok, true);
    assert.notEqual(
      before.fingerprint,
      after.fingerprint,
      "different HEAD commits must not fingerprint the same",
    );
  });
});

test("computeFingerprint: same content written twice -> identical fingerprint (determinism)", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "a.js"), "one", "utf8");
    const first = computeFingerprint({ cwd: dir });
    writeFileSync(join(dir, "b.js"), "two", "utf8");
    unlinkSync(join(dir, "b.js"));
    const second = computeFingerprint({ cwd: dir });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(
      first.fingerprint,
      second.fingerprint,
      "b.js created then removed must leave no trace",
    );
  });
});

test("computeFingerprint ⓐ: tracked file content modified -> fingerprint changes", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "a.js"), "one", "utf8");
    git(dir, ["add", "a.js"]);
    git(dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "add a",
    ]);
    const before = computeFingerprint({ cwd: dir });
    writeFileSync(join(dir, "a.js"), "two", "utf8");
    const after = computeFingerprint({ cwd: dir });
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.match(after.entries.join("\n"), /^M a\.js [0-9a-f]{64}$/m);
  });
});

test("computeFingerprint ⓑ: new untracked file -> caught (git diff HEAD alone would miss this)", () => {
  withRepo((dir) => {
    const before = computeFingerprint({ cwd: dir });
    writeFileSync(join(dir, "new.js"), "brand new", "utf8");
    const after = computeFingerprint({ cwd: dir });
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.match(after.entries.join("\n"), /^M new\.js [0-9a-f]{64}$/m);
  });
});

test("computeFingerprint: `git add`-ing an already-approved, unchanged file does NOT change the fingerprint (status-letter flip alone must be invisible)", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "new.js"), "brand new", "utf8");
    const beforeAdd = computeFingerprint({ cwd: dir });
    git(dir, ["add", "new.js"]);
    const afterAdd = computeFingerprint({ cwd: dir });
    assert.equal(
      beforeAdd.fingerprint,
      afterAdd.fingerprint,
      "staging alone (?? -> A, same content) must not look like a code change",
    );
  });
});

test("computeFingerprint ⓒ: tracked file deleted -> caught", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "a.js"), "one", "utf8");
    git(dir, ["add", "a.js"]);
    git(dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "add a",
    ]);
    const before = computeFingerprint({ cwd: dir });
    unlinkSync(join(dir, "a.js"));
    const after = computeFingerprint({ cwd: dir });
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.match(after.entries.join("\n"), /^D a\.js DELETED$/m);
  });
});

test("computeFingerprint: .harness/ changes never affect the fingerprint (self-reference guard), even without a .gitignore entry", () => {
  withRepo((dir) => {
    const before = computeFingerprint({ cwd: dir });
    writeFileSync(
      join(dir, ".harness", "review.md"),
      "for: HYK-1\nverdict: approved\n",
      "utf8",
    );
    writeFileSync(join(dir, ".harness", "coder.md"), "whatever", "utf8");
    const after = computeFingerprint({ cwd: dir });
    assert.equal(
      before.fingerprint,
      after.fingerprint,
      ".harness/ writes must be invisible to the fingerprint",
    );
  });
});

test("computeFingerprint: re-modifying an already-modified tracked file changes the fingerprint (status char alone (M) would not have caught this)", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "a.js"), "base", "utf8");
    git(dir, ["add", "a.js"]);
    git(dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "add a",
    ]);
    writeFileSync(join(dir, "a.js"), "first edit", "utf8");
    const afterFirstEdit = computeFingerprint({ cwd: dir });
    writeFileSync(join(dir, "a.js"), "second edit -- tampered", "utf8");
    const afterSecondEdit = computeFingerprint({ cwd: dir });
    assert.notEqual(afterFirstEdit.fingerprint, afterSecondEdit.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// evaluateBinding (fail-closed judgement)
// ---------------------------------------------------------------------------

test("evaluateBinding: no binding-fingerprint line in review.md -> 결속 없음, blocked", () => {
  withRepo((dir) => {
    const r = evaluateBinding(
      "for: HYK-1\nverdict: approved\nrole: REVIEW\n",
      dir,
    );
    assert.equal(r.ok, false);
    assert.equal(r.judgement, "결속 없음");
    assert.match(r.reason, /결속 없음\(커밋 차단\)/);
  });
});

test("evaluateBinding: fingerprint present and matches current worktree -> 일치, allowed", () => {
  withRepo((dir) => {
    const fp = computeFingerprint({ cwd: dir });
    const content = `for: HYK-1\nverdict: approved\n${formatBindingBlock({ fingerprint: fp.fingerprint, entries: fp.entries })}`;
    const r = evaluateBinding(content, dir);
    assert.equal(r.ok, true);
    assert.equal(r.judgement, "일치");
    assert.match(r.reason, /일치\(커밋 허용\)/);
  });
});

test("evaluateBinding: fingerprint present but stale (code changed after approval) -> 불일치, blocked", () => {
  withRepo((dir) => {
    const fp = computeFingerprint({ cwd: dir });
    const content = `for: HYK-1\nverdict: approved\n${formatBindingBlock({ fingerprint: fp.fingerprint, entries: fp.entries })}`;
    writeFileSync(
      join(dir, "tampered.js"),
      "sneaked in after approval",
      "utf8",
    );
    const r = evaluateBinding(content, dir);
    assert.equal(r.ok, false);
    assert.equal(r.judgement, "불일치");
    assert.match(r.reason, /불일치\(커밋 차단\)/);
  });
});

// HYK-240 2R (반려 1 수리, 검토 축 F1): the worktree fingerprint can match
// approval while the INDEX (what `git commit` actually writes) still
// differs -- e.g. content staged, then the worktree file edited again
// without re-staging. evaluateBinding must independently require index ==
// worktree, not just trust the fingerprint match.
test("evaluateBinding: worktree fingerprint matches approval, but the file is STAGED with different content than the worktree -> 불일치, blocked, names the desynced file", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "feature.js"), "INDEX_APPROVED", "utf8");
    git(dir, ["add", "feature.js"]);
    writeFileSync(join(dir, "feature.js"), "WORKTREE_APPROVED", "utf8");
    // Fingerprint is computed from the WORKTREE (as designed), so this
    // captures WORKTREE_APPROVED -- exactly what a reviewer approving the
    // worktree would see.
    const fp = computeFingerprint({ cwd: dir });
    const content = `for: HYK-1\nverdict: approved\n${formatBindingBlock({ fingerprint: fp.fingerprint, entries: fp.entries })}`;
    const r = evaluateBinding(content, dir);
    assert.equal(r.ok, false);
    assert.equal(r.judgement, "불일치");
    assert.match(r.reason, /불일치\(커밋 차단\)/);
    assert.match(r.reason, /feature\.js/);
    assert.deepEqual(r.desyncedPaths, ["feature.js"]);
  });
});

test("evaluateBinding: index and worktree back in sync (re-staged after the mismatch) -> 일치, allowed", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "feature.js"), "INDEX_APPROVED", "utf8");
    git(dir, ["add", "feature.js"]);
    writeFileSync(join(dir, "feature.js"), "WORKTREE_APPROVED", "utf8");
    const fp = computeFingerprint({ cwd: dir });
    const content = `for: HYK-1\nverdict: approved\n${formatBindingBlock({ fingerprint: fp.fingerprint, entries: fp.entries })}`;
    // Re-stage so index catches up with the approved worktree content.
    git(dir, ["add", "feature.js"]);
    const r = evaluateBinding(content, dir);
    assert.equal(r.ok, true);
    assert.equal(r.judgement, "일치");
  });
});

test("evaluateBinding: `git add`-ing an unchanged file (1R regression guard) still resolves to 일치 -- the new index/worktree sync check must not reintroduce the git-add false positive", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "feature.js"), "content", "utf8");
    const fp = computeFingerprint({ cwd: dir });
    const content = `for: HYK-1\nverdict: approved\n${formatBindingBlock({ fingerprint: fp.fingerprint, entries: fp.entries })}`;
    git(dir, ["add", "feature.js"]);
    const r = evaluateBinding(content, dir);
    assert.equal(r.ok, true);
    assert.equal(r.judgement, "일치");
  });
});

test("evaluateBinding: current worktree unmeasurable (cwd not a git repo) -> 판정 불가, blocked (fail-closed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk240-not-a-repo-"));
  try {
    const r = evaluateBinding(
      "for: HYK-1\nverdict: approved\nbinding-fingerprint: " +
        "a".repeat(64) +
        "\n",
      dir,
    );
    assert.equal(r.ok, false);
    assert.equal(r.judgement, "판정 불가");
    assert.match(r.reason, /판정 불가\(커밋 차단\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-281: "이미 커밋된 판본을 검토" 경로 -- 리뷰어가 작업트리가 깨끗한
// 상태(작업자가 이미 커밋한 뒤)에서 승인을 기록하는 흐름. 결속 대상은 그
// 순간의 HEAD 커밋이어야 하고, 그 뒤 HEAD가 바뀌면(새 커밋) 반드시
// 재검토를 요구해야 한다 -- 예전처럼 "빈 지문이라 아무 clean 트리에나
// 일치"해서는 안 된다.
test("evaluateBinding: clean-tree approval binds to HEAD -> still 일치 while HEAD unchanged, then 불일치 once a new commit lands (no silent pass-through)", () => {
  withRepo((dir) => {
    const fp = computeFingerprint({ cwd: dir });
    const content = `for: HYK-1\nverdict: approved\n${formatBindingBlock({ fingerprint: fp.fingerprint, entries: fp.entries })}`;
    const stillClean = evaluateBinding(content, dir);
    assert.equal(stillClean.ok, true);
    assert.equal(stillClean.judgement, "일치");

    writeFileSync(join(dir, "a.js"), "one", "utf8");
    git(dir, ["add", "a.js"]);
    git(dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "add a after approval",
    ]);
    const afterNewCommit = evaluateBinding(content, dir);
    assert.equal(afterNewCommit.ok, false);
    assert.equal(afterNewCommit.judgement, "불일치");
    assert.match(afterNewCommit.reason, /불일치\(커밋 차단\)/);
  });
});

// ---------------------------------------------------------------------------
// extract*/formatBindingBlock round-trip
// ---------------------------------------------------------------------------

test("formatBindingBlock + extractBindingFingerprint/extractBindingEntries round-trip", () => {
  const block = formatBindingBlock({
    fingerprint: "f".repeat(64),
    entries: ["M a.js " + "1".repeat(64), "?? b.js " + "2".repeat(64)],
  });
  assert.equal(extractBindingFingerprint(block), "f".repeat(64));
  assert.deepEqual(extractBindingEntries(block), [
    "M a.js " + "1".repeat(64),
    "?? b.js " + "2".repeat(64),
  ]);
});

test("extractBindingFingerprint: CRLF content still matches (review.md may be CRLF on Windows)", () => {
  const content = `for: HYK-1\r\nbinding-fingerprint: ${"c".repeat(64)}\r\n`;
  assert.equal(extractBindingFingerprint(content), "c".repeat(64));
});
