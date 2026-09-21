import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

// The contrast check HYK-304-frame-commit-1's coder-task.md 조건2 requires:
// if the generated frame-ignore artifacts (.prettierignore /
// eslint.config.mjs's generated block) ever match a src/**, test/**, or
// spec/** path, this must go RED. Both artifacts are parsed from the real,
// on-disk files quality-check.mjs / hooks/pre-commit actually consume --
// not recomputed from scripts/check/gen-frame-ignore.mjs's in-memory
// function -- so a hand-edit to either file (the live mutation-RED
// demonstration in coder.md §"조건2") is what this test actually reacts to.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const PRODUCT_CODE_RE = /^(src|test|spec)\//;

function readPrettierIgnoreEntries() {
  const raw = readFileSync(join(REPO_ROOT, ".prettierignore"), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

async function readEslintGeneratedIgnores() {
  const url = pathToFileURL(join(REPO_ROOT, "eslint.config.mjs")).href;
  // cache-bust: a hand-edited eslint.config.mjs (the live mutation demo)
  // must be re-read, not served from Node's ESM module cache.
  const mod = await import(`${url}?t=${Date.now()}-${Math.random()}`);
  const config = mod.default;
  const generated = config.find(
    (entry) => Array.isArray(entry.ignores) && !entry.files,
  );
  assert.ok(
    generated,
    "eslint.config.mjs must contain a global `ignores` entry (no `files` key) -- the generated frame-ignore block",
  );
  return generated.ignores;
}

test("generated .prettierignore never matches src/**, test/**, spec/**", () => {
  const entries = readPrettierIgnoreEntries();
  const offenders = entries.filter((e) => PRODUCT_CODE_RE.test(e));
  assert.deepEqual(
    offenders,
    [],
    `.prettierignore must never ignore product code, found: ${JSON.stringify(offenders)}`,
  );
});

test("generated eslint.config.mjs ignores block never matches src/**, test/**, spec/**", async () => {
  const entries = await readEslintGeneratedIgnores();
  const offenders = entries.filter((e) => PRODUCT_CODE_RE.test(e));
  assert.deepEqual(
    offenders,
    [],
    `eslint.config.mjs's generated ignores block must never ignore product code, found: ${JSON.stringify(offenders)}`,
  );
});

// Real-tool axis (조건2: "naive grep으로 끝내지 마라 -- 실제 무시 판정을 재는
// 축을 적어도 하나"): picks one path this repo's OWN generated ignore list
// currently carries and one that it does NOT, then runs the real eslint /
// prettier binaries (the same ones hooks/pre-commit invokes via
// quality-check.mjs) and asserts the tools' own exit codes / "ignored"
// judgment, not a string match against the ignore files.
test("ESLint and Prettier actually skip a real frame-ignore-listed file (not naive grep)", () => {
  const ignoredPath = "scripts/check/controlroom-fresh.mjs"; // known real complexity violation, see coder.md §1
  const entries = readPrettierIgnoreEntries();
  assert.ok(
    entries.includes(ignoredPath),
    `fixture assumption broken: ${ignoredPath} must be in .prettierignore for this test to mean anything`,
  );

  const eslintBin = join(
    REPO_ROOT,
    "node_modules",
    "eslint",
    "bin",
    "eslint.js",
  );
  const prettierBin = join(
    REPO_ROOT,
    "node_modules",
    "prettier",
    "bin",
    "prettier.cjs",
  );

  // ESLint: exits 0 with only an "ignored" warning for an explicitly-passed
  // file matching a global `ignores` pattern (verified live against a
  // throwaway fixture before this file was written -- see coder.md).
  const eslintOut = execFileSync(process.execPath, [eslintBin, ignoredPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.match(
    eslintOut,
    /ignored because of a matching ignore pattern/,
    "ESLint must report the file as ignored, not silently pass it through",
  );

  // Prettier: --check on an explicitly-passed file matching .prettierignore
  // exits 0 and reports nothing was checked (no "Code style issues").
  const prettierOut = execFileSync(
    process.execPath,
    [prettierBin, "--check", ignoredPath],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.doesNotMatch(
    prettierOut,
    /Code style issues found/,
    "Prettier must skip the ignored file, not report style issues on it",
  );
});
