import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  scanSource,
  scanRepo,
  validateAllowlist,
  maskNonCode,
  ALLOWLIST,
} from "./pathname-filepath-guard.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Shape of the pre-PR #13 call site (quality-check.test.mjs:13-16 before the
// HYK-304 repair). The regression that this guard exists to catch.
const OLD_SITE = `const QUALITY_CHECK_PATH = new URL(
  "./quality-check.mjs",
  import.meta.url,
).pathname.replace(/^\\/([A-Za-z]:)/, "$1");
`;

test("assignment shape: a chained .pathname bound to a *_PATH name is reported", () => {
  const hits = scanSource(OLD_SITE);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "assign");
  assert.equal(hits[0].line, 1);
});

test("assignment shape: a *Path camelCase name is reported too", () => {
  const hits = scanSource(
    `const scriptPath = new URL("./x.mjs", import.meta.url).pathname;\n`,
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "assign");
});

test("regex literal with parentheses inside the chain does not break the match", () => {
  const src = `const X_PATH = new URL("./a", import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, "$1");\nconst ok = 1;\n`;
  const hits = scanSource(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});

test("argument shape: direct .pathname argument to readFileSync / execFileSync / import() is reported", () => {
  const cases = [
    `readFileSync(new URL("./a.json", import.meta.url).pathname, "utf8");`,
    `execFileSync(process.execPath, new URL("./b.mjs", import.meta.url).pathname);`,
    `await import(new URL("./c.mjs", import.meta.url).pathname);`,
    `path.join(new URL("./d", import.meta.url).pathname, "e");`,
  ];
  for (const src of cases) {
    const hits = scanSource(src + "\n");
    assert.equal(hits.length, 1, `expected one hit for: ${src}`);
    assert.equal(hits[0].kind, "arg", src);
  }
});

test("argument shape: the callee name is reported on the hit", () => {
  const hits = scanSource(
    `spawnSync(process.execPath, [new URL("./z", import.meta.url).pathname]);\n`,
  );
  // Inside an array literal: not a direct argument (see the known-miss test).
  assert.equal(hits.length, 0);
  const direct = scanSource(
    `spawnSync(new URL("./z", import.meta.url).pathname, []);\n`,
  );
  assert.equal(direct.length, 1);
  assert.equal(direct[0].callee, "spawnSync");
});

test("fileURLToPath wrapper is accepted (both as the outer call and as the assigned value)", () => {
  assert.deepEqual(
    scanSource(
      `const QUALITY_CHECK_PATH = fileURLToPath(new URL("./q.mjs", import.meta.url));\n`,
    ),
    [],
  );
  assert.deepEqual(
    scanSource(
      `readFileSync(fileURLToPath(new URL("./q.mjs", import.meta.url).pathname));\n`,
    ),
    [],
  );
});

test("URL object passed as-is (no .pathname chain) is the accepted convention", () => {
  // Common in this repo (e.g. abort-record-core.test.mjs:11-12). Must stay
  // clean, or every ordinary readFileSync(new URL(...)) becomes a false positive.
  assert.deepEqual(
    scanSource(
      `const txt = readFileSync(new URL("./fixture.txt", import.meta.url), "utf8");\n`,
    ),
    [],
  );
  assert.deepEqual(
    scanSource(
      `const QUALITY_CHECK_PATH = resolveScriptPath(\n  new URL("./quality-check.mjs", import.meta.url),\n);\n`,
    ),
    [],
  );
});

test("mentions in comments and string/template literals are never reported", () => {
  const src = [
    `// builds a path from \`new URL(...).pathname\` without decoding it`,
    `/* const X_PATH = new URL("./a", import.meta.url).pathname; */`,
    `const msg = "readFileSync(new URL('./a').pathname)";`,
    'const tpl = `const Y_PATH = new URL("./b").pathname`;',
    ``,
  ].join("\n");
  assert.deepEqual(scanSource(src), []);
});

test("sanity-check shape on a variable (synthetic.pathname) is not reported (zero allowlist entries needed)", () => {
  const src = [
    `const synthetic = new URL(\`file:///C:/x/\${encodeURIComponent("y")}/q.mjs\`);`,
    `assert.match(synthetic.pathname, /%[0-9A-Fa-f]{2}/);`,
    ``,
  ].join("\n");
  assert.deepEqual(scanSource(src), []);
});

test("a non-*Path name holding .pathname is not reported (name heuristic is the documented limit)", () => {
  assert.deepEqual(
    scanSource(`const pathname = new URL("./a", import.meta.url).pathname;\n`),
    [],
  );
});

test("KNOWN MISS: a one-hop flow through a local variable is not reported (documented boundary)", () => {
  const src = [
    `const p = new URL("./a", import.meta.url).pathname;`,
    `execFileSync(process.execPath, [p]);`,
    ``,
  ].join("\n");
  assert.deepEqual(scanSource(src), []);
});

test("INTENDED MISS: a bare named import (import { join }) is not a path callee (HYK-304 P2-5)", () => {
  // Only the qualified path.join / path.resolve are in PATH_CALLEES. Matching
  // the bare name would also match every `x.join(...)` method call (the callee
  // tail is taken after the last dot), so widening it is a separate decision.
  const src = [
    `import { join } from "node:path";`,
    `join(new URL("./d", import.meta.url).pathname, "e");`,
    ``,
  ].join("\n");
  assert.deepEqual(scanSource(src), []);
});

test("INTENDED MISS (경계 기술뿐 · 잠금 아님): a .pathname inside a template-literal placeholder is not reported (HYK-304 P2-5)", () => {
  // Template bodies are masked like string literals, so a `${...}` placeholder
  // is never seen as code. Un-masking placeholders would also re-scan prose
  // that sits inside template strings, so this stays a documented boundary.
  // ⚠️ This test is NOT a lock on the placeholder branch. Measured by the
  // HYK-304 followup-2 reviewer: removing the backtick branch of skipLiteralAt,
  // or ending the literal at the placeholder start, both leave this test green.
  // It only records the boundary as it stands; widening the detection to cover
  // placeholders is a separate decision (it would re-scan template prose).
  const src =
    'readFileSync(`${new URL("./a", import.meta.url).pathname}/x.json`, "utf8");\n';
  assert.deepEqual(scanSource(src), []);
});

test("an assignment written inside a fileURLToPath(...) argument list is still reported (HYK-304 P2-1)", () => {
  // The wrapper exemption used to accept this. The raw .pathname is still bound
  // to a *_PATH name, so the wrapper must not hide it.
  const hits = scanSource(
    `fileURLToPath(X_PATH = new URL("./q.mjs", import.meta.url).pathname);\n`,
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "assign");
});

test("maskNonCode keeps length and newlines so line numbers survive masking", () => {
  const src = `const a = "x\\ny"; // tail\n/* c\n d */ const b = 2;\n`;
  const masked = maskNonCode(src);
  assert.equal(masked.length, src.length);
  assert.equal(masked.split("\n").length, src.split("\n").length);
});

test("allowlist format: file, line and reason are all required", () => {
  assert.deepEqual(validateAllowlist([]), []);
  const errors = validateAllowlist([{ file: "", line: 0, reason: "  " }]);
  assert.equal(errors.length, 3);
});

test("the real repo is clean with the shipped allowlist (no violations, no stale entries, no format errors)", () => {
  const result = scanRepo(REPO_ROOT, ALLOWLIST);
  assert.deepEqual(result.formatErrors, []);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.stale, []);
  assert.ok(result.files.length > 0);
});

test("src/ is in the scan scope: a Node script under src/ (dev-server.mjs shape) is scanned (HYK-304 P2-2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pathname-guard-src-"));
  try {
    mkdirSync(join(dir, "src", "editor"), { recursive: true });
    writeFileSync(
      join(dir, "src", "editor", "dev-server.mjs"),
      `readFileSync(new URL("./x.json", import.meta.url).pathname, "utf8");\n`,
    );
    const result = scanRepo(dir, []);
    assert.deepEqual(result.files, ["src/editor/dev-server.mjs"]);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, "src/editor/dev-server.mjs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforce.yml pins this guard as a fail-closed CI step with the exact command (HYK-304 P2-3)", () => {
  const yml = readFileSync(
    join(REPO_ROOT, ".github", "workflows", "enforce.yml"),
    "utf8",
  );
  // The step block runs from its name line to the next step (`- name:`).
  const block =
    /- name: pathname-filepath-guard[\s\S]*?(?=\n\s+- name:|\s*$)/.exec(yml);
  assert.ok(block, "enforce.yml must contain the pathname-filepath-guard step");
  assert.match(
    block[0],
    /\n\s+run: node scripts\/check\/pathname-filepath-guard\.mjs\s*$/,
  );
  assert.doesNotMatch(block[0], /\n\s+continue-on-error:/);
});

test("scanRepo: a stale allowlist entry is reported, and a matching entry suppresses a violation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pathname-guard-"));
  try {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(
      join(dir, "scripts", "bad.mjs"),
      `const DATA_PATH = new URL("./d", import.meta.url).pathname;\n`,
    );

    const unallowed = scanRepo(dir, []);
    assert.equal(unallowed.violations.length, 1);
    assert.equal(unallowed.violations[0].file, "scripts/bad.mjs");

    const allowed = scanRepo(dir, [
      { file: "scripts/bad.mjs", line: 1, reason: "synthetic test entry" },
    ]);
    assert.deepEqual(allowed.violations, []);
    assert.deepEqual(allowed.stale, []);

    const stale = scanRepo(dir, [
      { file: "scripts/gone.mjs", line: 9, reason: "points nowhere" },
    ]);
    assert.equal(stale.stale.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
