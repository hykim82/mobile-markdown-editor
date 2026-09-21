import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  resolveChangedFiles,
  runQualityCheck,
  parseCliArgs,
} from "./quality-check.mjs";

const QUALITY_CHECK_PATH = new URL(
  "./quality-check.mjs",
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function withFixtureRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "quality-check-test-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "a@a"]);
    git(dir, ["config", "user.name", "a"]);
    writeFileSync(join(dir, "base.mjs"), "export const base = 1;\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    const baseSha = git(dir, ["rev-parse", "HEAD"]);
    fn(dir, baseSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveChangedFiles: ci mode with missing base SHA -> fail-closed, not vacuous pass", () => {
  withFixtureRepo((dir) => {
    const result = resolveChangedFiles({
      cwd: dir,
      mode: "ci",
      baseSha: undefined,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /fail-closed/);
  });
});

test("resolveChangedFiles: ci mode with all-zero SHA (first push sentinel) -> fail-closed", () => {
  withFixtureRepo((dir) => {
    const result = resolveChangedFiles({
      cwd: dir,
      mode: "ci",
      baseSha: "0".repeat(40),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /fail-closed/);
  });
});

test("resolveChangedFiles: ci mode with unresolvable base SHA -> fail-closed (git diff error surfaced, not swallowed)", () => {
  withFixtureRepo((dir) => {
    const result = resolveChangedFiles({
      cwd: dir,
      mode: "ci",
      baseSha: "deadbeef".repeat(5),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /git diff against base SHA/);
  });
});

test("resolveChangedFiles: ci mode lists added/modified files, excludes deletions", () => {
  withFixtureRepo((dir, baseSha) => {
    writeFileSync(join(dir, "new.mjs"), "export const n = 1;\n", "utf8");
    writeFileSync(join(dir, "base.mjs"), "export const base = 2;\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "add+modify"]);
    git(dir, ["rm", "-q", "base.mjs"]);
    git(dir, ["commit", "-q", "-m", "delete base"]);
    const result = resolveChangedFiles({ cwd: dir, mode: "ci", baseSha });
    assert.equal(result.ok, true);
    // base.mjs was modified then deleted across the range; new.mjs was added.
    // Deletion-only status must never appear as a changed target.
    assert.ok(result.files.includes("new.mjs"));
    assert.ok(
      !result.files.includes("base.mjs") ||
        result.files.filter((f) => f === "base.mjs").length <= 1,
    );
  });
});

test("resolveChangedFiles: staged mode lists index vs HEAD (diff --cached)", () => {
  withFixtureRepo((dir) => {
    writeFileSync(join(dir, "staged.mjs"), "export const s = 1;\n", "utf8");
    git(dir, ["add", "staged.mjs"]);
    const result = resolveChangedFiles({ cwd: dir, mode: "staged" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.files, ["staged.mjs"]);
  });
});

test("resolveChangedFiles: unknown mode -> fail-closed with a clear reason", () => {
  withFixtureRepo((dir) => {
    const result = resolveChangedFiles({ cwd: dir, mode: "bogus" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown mode/);
  });
});

test("runQualityCheck: no changed files in scope -> vacuously green (does not invoke tools)", () => {
  withFixtureRepo((dir) => {
    let called = false;
    const result = runQualityCheck({
      cwd: dir,
      mode: "staged",
      runTool: () => {
        called = true;
        return { exitCode: 0, output: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(called, false);
  });
});

test("runQualityCheck: changed file with a lint violation -> gate fails (Q1/Q2 core case)", () => {
  withFixtureRepo((dir) => {
    writeFileSync(join(dir, "bad.mjs"), "const unused = 1;\n", "utf8");
    git(dir, ["add", "bad.mjs"]);
    const result = runQualityCheck({
      cwd: dir,
      mode: "staged",
      runTool: (tool) =>
        tool === "eslint"
          ? { exitCode: 1, output: "no-unused-vars" }
          : { exitCode: 0, output: "" },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /eslint/);
  });
});

test("runQualityCheck: untouched pre-existing violation is not in the changed set -> not passed to the tool (Q2 amnesty)", () => {
  withFixtureRepo((dir) => {
    // "untouched.mjs" pre-exists at HEAD with a violation but is not part of
    // this change -- it must never reach the tool call, proving the
    // changed-files-only scope (the pre-existing-violation amnesty).
    writeFileSync(join(dir, "untouched.mjs"), "const unused = 1;\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, [
      "commit",
      "-q",
      "-m",
      "pre-existing violation, not part of this change",
    ]);
    writeFileSync(join(dir, "clean.mjs"), "export const ok = 1;\n", "utf8");
    git(dir, ["add", "clean.mjs"]);
    const seenTargets = [];
    const result = runQualityCheck({
      cwd: dir,
      mode: "staged",
      runTool: (tool, targets) => {
        seenTargets.push(...targets);
        return { exitCode: 0, output: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.ok(
      !seenTargets.includes("untouched.mjs"),
      "pre-existing untouched file must not be linted",
    );
    assert.ok(seenTargets.includes("clean.mjs"));
  });
});

test("runQualityCheck: deleted file in the changed set is excluded (nothing left to lint)", () => {
  withFixtureRepo((dir) => {
    git(dir, ["rm", "-q", "base.mjs"]);
    const seenTargets = [];
    const result = runQualityCheck({
      cwd: dir,
      mode: "staged",
      runTool: (tool, targets) => {
        seenTargets.push(...targets);
        return { exitCode: 0, output: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seenTargets, []);
  });
});

test("runQualityCheck: format-only extensions (.json/.md) go through prettier only, not eslint", () => {
  withFixtureRepo((dir) => {
    writeFileSync(join(dir, "notes.md"), "# hi\n", "utf8");
    git(dir, ["add", "notes.md"]);
    const calls = [];
    const result = runQualityCheck({
      cwd: dir,
      mode: "staged",
      runTool: (tool) => {
        calls.push(tool);
        return { exitCode: 0, output: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["prettier"]);
  });
});

test("runQualityCheck: ci mode propagates the fail-closed reason from resolveChangedFiles (Q4 structural: no silent full-pass)", () => {
  withFixtureRepo((dir) => {
    const result = runQualityCheck({
      cwd: dir,
      mode: "ci",
      baseSha: undefined,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /fail-closed/);
  });
});

// --- HYK-393: unknown-flag rejection (fail-open ⓐ) ---

test("parseCliArgs: an unrecognized flag (e.g. --base instead of --base-sha) -> ok:false, does not fall back to defaults", () => {
  const result = parseCliArgs(["--base", "deadbeef"]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unrecognized argument/);
  assert.match(result.reason, /"--base"/);
});

test("parseCliArgs: known flags (--mode, --base-sha, --cwd) parse normally", () => {
  const result = parseCliArgs(["--mode", "ci", "--base-sha", "abc123"]);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "ci");
  assert.equal(result.baseSha, "abc123");
});

test("CLI: an unrecognized flag exits non-zero instead of silently defaulting to an empty-scope green (HYK-270 1R regression)", () => {
  withFixtureRepo((dir) => {
    assert.throws(() => {
      execFileSync(
        process.execPath,
        [QUALITY_CHECK_PATH, "--base", "deadbeef", "--cwd", dir],
        { encoding: "utf8" },
      );
    }, /Command failed/);
  });
});

test("CLI: the canonical CI invocation (--mode ci --base-sha <sha>) still exits 0 (no regression from the unknown-flag guard)", () => {
  // Deliberately no new in-scope file committed after baseSha: this proves
  // known-flag parsing still reaches runQualityCheck and exits 0 without
  // spawning the real eslint/prettier binaries (which don't exist relative
  // to this throwaway fixture repo's cwd) -- the "checked" (tool-invoking)
  // path is covered separately via injected runTool above.
  withFixtureRepo((dir, baseSha) => {
    const out = execFileSync(
      process.execPath,
      [QUALITY_CHECK_PATH, "--mode", "ci", "--base-sha", baseSha, "--cwd", dir],
      { encoding: "utf8" },
    );
    assert.match(out, /\[quality-check:empty\]/);
  });
});

// --- HYK-393: "0 targets" mechanically distinguished from "checked and
// passed" (fail-open ⓑ). Design choice: an empty scope still exits 0 (a
// docs-only or out-of-scope-extension change must not become a red build --
// see quality-check.mjs's KNOWN_FLAGS comment / coder.md §3 for the cost of
// the alternative), but `result.scope` and the CLI's stdout prefix now tag
// the two cases distinctly so a caller does not have to parse prose to tell
// "nothing to check" apart from "checked and clean."

test("runQualityCheck: empty scope is tagged scope:'empty', a real pass is tagged scope:'checked' -- mechanically distinguishable", () => {
  withFixtureRepo((dir) => {
    const empty = runQualityCheck({ cwd: dir, mode: "staged" });
    assert.equal(empty.ok, true);
    assert.equal(empty.scope, "empty");

    writeFileSync(join(dir, "clean.mjs"), "export const ok = 1;\n", "utf8");
    git(dir, ["add", "clean.mjs"]);
    const checked = runQualityCheck({
      cwd: dir,
      mode: "staged",
      runTool: () => ({ exitCode: 0, output: "" }),
    });
    assert.equal(checked.ok, true);
    assert.equal(checked.scope, "checked");
  });
});

test("CLI: empty-scope run prints a distinct [quality-check:empty] marker on stdout", () => {
  withFixtureRepo((dir) => {
    const out = execFileSync(
      process.execPath,
      [QUALITY_CHECK_PATH, "--mode", "staged", "--cwd", dir],
      { encoding: "utf8" },
    );
    assert.match(out, /\[quality-check:empty\]/);
  });
});

// --- HYK-393 2R: value-axis contract (REVIEW P1-1). Table: flag x value
// situation x expected outcome. Situations covered: (a) normal value ->
// accepted, (b) EOF (nothing after the flag) -> rejected, (c) next token is
// a KNOWN flag -> rejected, (d) next token is an UNKNOWN flag-shaped token
// -> rejected, (e) explicit empty-string value -> rejected. Exclusion rule:
// values that merely CONTAIN "--" but do not START with it (e.g. a sha or
// path with "--" in the middle) are out of scope for this table -- the
// contract (see quality-check.mjs's readFlagValue comment) only rejects
// values that START with "--", so a value like "abc--def" is case (a), not
// tested separately here since it is not a new code path.

test("parseCliArgs value-axis (b/EOF): --base-sha at end of args -> ok:false, fail-closed", () => {
  const result = parseCliArgs(["--base-sha"]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /requires a value but none was given/);
});

test("parseCliArgs value-axis (c/known-flag-as-value): --base-sha --mode -> ok:false, does not swallow --mode as the value", () => {
  const result = parseCliArgs(["--base-sha", "--mode"]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /looks like a flag, not a value/);
});

test("parseCliArgs value-axis (d/unknown-flag-as-value): --base-sha --foo -> ok:false", () => {
  const result = parseCliArgs(["--base-sha", "--foo"]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /looks like a flag, not a value/);
});

test("parseCliArgs value-axis (e/empty string): --base-sha '' -> ok:false", () => {
  const result = parseCliArgs(["--base-sha", ""]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty or whitespace-only value/);
});

test("parseCliArgs value-axis (a/normal value): --base-sha <sha> --mode ci --cwd <dir> -> ok:true, all three parsed", () => {
  const result = parseCliArgs([
    "--base-sha",
    "abc123",
    "--mode",
    "ci",
    "--cwd",
    "/some/dir",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.baseSha, "abc123");
  assert.equal(result.mode, "ci");
  assert.equal(result.cwd, "/some/dir");
});

test("parseCliArgs value-axis: --mode at EOF -> ok:false", () => {
  const result = parseCliArgs(["--mode"]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /requires a value but none was given/);
});

test("parseCliArgs value-axis: --cwd at EOF -> ok:false (was a Node ERR_INVALID_ARG_TYPE crash before this round -- now a designed rejection at parse time, before it ever reaches execFileSync)", () => {
  const result = parseCliArgs(["--cwd"]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /requires a value but none was given/);
});

test("CLI value-axis: node scripts/check/quality-check.mjs --base-sha (EOF, REVIEW's exact P1-1 reproduction #1) exits non-zero, not a vacuous green", () => {
  withFixtureRepo((dir) => {
    assert.throws(() => {
      execFileSync(
        process.execPath,
        [QUALITY_CHECK_PATH, "--cwd", dir, "--base-sha"],
        {
          encoding: "utf8",
        },
      );
    }, /Command failed/);
  });
});

test("CLI value-axis: node scripts/check/quality-check.mjs --base-sha --mode (swallowed-flag, REVIEW's exact P1-1 reproduction #2) exits non-zero, not a vacuous green", () => {
  withFixtureRepo((dir) => {
    assert.throws(() => {
      execFileSync(
        process.execPath,
        [QUALITY_CHECK_PATH, "--cwd", dir, "--base-sha", "--mode"],
        { encoding: "utf8" },
      );
    }, /Command failed/);
  });
});

// --- HYK-393 2R: name-axis regression guard (must still be non-zero after
// the value-axis change -- these were already fixed in 1R, re-asserted
// here directly against the CLI so a future edit to readFlagValue/
// parseCliArgs cannot accidentally reopen the name axis).
for (const badFlag of ["--base", "--baseSha", "-base-sha", "--Mode"]) {
  test(`CLI name-axis regression: ${badFlag} still exits non-zero (2R must not regress 1R's fix)`, () => {
    withFixtureRepo((dir) => {
      assert.throws(() => {
        execFileSync(
          process.execPath,
          [QUALITY_CHECK_PATH, "--cwd", dir, badFlag, "x"],
          { encoding: "utf8" },
        );
      }, /Command failed/);
    });
  });
}

// --- HYK-393 3R: value-ACCEPTANCE contract, derived from the partition in
// readFlagValue's own header comment, not hand-listed from REVIEW's two
// specific repros. The three cases below (ABSENT is already covered by the
// EOF tests above) are generated from several DISTINCT representatives per
// partition class -- the point is that any string in a class is rejected
// for the SAME reason (the class membership), not that these particular
// strings were separately discovered as bugs.

// Case (1): whitespace-only (trim() === ""). REVIEW 2R's P1-1 repro
// (`--base-sha "   "`) is one member of this infinite class; the others
// below are different representatives of the same class, not separate bugs.
for (const ws of ["", " ", "   ", "\t", "\n", " \t \n "]) {
  test(`parseCliArgs value-partition (1/whitespace-only): --base-sha ${JSON.stringify(ws)} -> ok:false`, () => {
    const result = parseCliArgs(["--base-sha", ws]);
    assert.equal(result.ok, false);
    assert.match(result.reason, /empty or whitespace-only value/);
  });
}

// Case (2): dash-leading (trim().startsWith("-")). REVIEW 2R's P1-2 repro
// (`--base-sha -`) is one member; `--`, `-x`, `---`, and a
// whitespace-padded flag-looking string are other members of the same
// class.
for (const dashy of ["-", "--", "-x", "---", "--anything", "  --mode  "]) {
  test(`parseCliArgs value-partition (2/dash-leading): --base-sha ${JSON.stringify(dashy)} -> ok:false`, () => {
    const result = parseCliArgs(["--base-sha", dashy]);
    assert.equal(result.ok, false);
    assert.match(result.reason, /looks like a flag, not a value/);
  });
}

// Case (3): everything else -- accepted. Several distinct representatives
// (a real-shaped SHA, a mode name, a Windows path, a value with internal
// but non-leading whitespace, a value containing "-" in the middle) all
// land in the same "neither whitespace-only nor dash-leading" class.
for (const good of [
  "3ca5d7f3f027771aa5dd37b9863acd8a8c022c77",
  "ci",
  "C:\\Users\\x\\repo",
  "ab c",
  "abc-def",
]) {
  test(`parseCliArgs value-partition (3/accepted): --base-sha ${JSON.stringify(good)} -> ok:true`, () => {
    const result = parseCliArgs(["--base-sha", good]);
    assert.equal(result.ok, true);
    assert.equal(result.baseSha, good);
  });
}

// REVIEW 2R's exact two P1 repros, pinned directly (both at the unit level
// and end-to-end through the real CLI subprocess).
test("parseCliArgs: REVIEW 2R P1-1 exact repro (--base-sha '   ') -> ok:false", () => {
  const result = parseCliArgs(["--base-sha", "   "]);
  assert.equal(result.ok, false);
});

test("parseCliArgs: REVIEW 2R P1-2 exact repro (--base-sha -) -> ok:false", () => {
  const result = parseCliArgs(["--base-sha", "-"]);
  assert.equal(result.ok, false);
});

test("CLI: REVIEW 2R P1-1 exact repro (node quality-check.mjs --base-sha '   ') exits non-zero, not a vacuous green", () => {
  withFixtureRepo((dir) => {
    assert.throws(() => {
      execFileSync(
        process.execPath,
        [QUALITY_CHECK_PATH, "--cwd", dir, "--base-sha", "   "],
        { encoding: "utf8" },
      );
    }, /Command failed/);
  });
});

test("CLI: REVIEW 2R P1-2 exact repro (node quality-check.mjs --base-sha -) exits non-zero, not a vacuous green", () => {
  withFixtureRepo((dir) => {
    assert.throws(() => {
      execFileSync(
        process.execPath,
        [QUALITY_CHECK_PATH, "--cwd", dir, "--base-sha", "-"],
        { encoding: "utf8" },
      );
    }, /Command failed/);
  });
});

// --- HYK-393 3R: value-axis regression guard -- the 7 inputs REVIEW 2R
// already measured as exit 1 (§1-2 of the 3R task file: "these are a
// regression guard, not a rediscovery target"). Re-asserted directly
// against the CLI so a future edit to readFlagValue cannot silently reopen
// any of them.
const VALUE_AXIS_REGRESSION_GUARD = [
  ["--base-sha", "--"],
  ["--base-sha", "--foo"],
  ["--mode", "bogus"],
  ["--mode"],
  ["--cwd"],
  ["--cwd", ""],
  ["--mode", "   "],
];
for (const args of VALUE_AXIS_REGRESSION_GUARD) {
  test(`CLI value-axis regression guard: ${JSON.stringify(args)} still exits non-zero`, () => {
    withFixtureRepo((dir) => {
      const fullArgs = args[0] === "--cwd" ? args : ["--cwd", dir, ...args];
      assert.throws(() => {
        execFileSync(process.execPath, [QUALITY_CHECK_PATH, ...fullArgs], {
          encoding: "utf8",
        });
      }, /Command failed/);
    });
  });
}
