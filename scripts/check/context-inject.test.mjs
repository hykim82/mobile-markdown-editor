import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractHardConstraints, isUsableCard } from "./context-inject.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./context-inject.mjs", import.meta.url));

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "context-inject-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, stdin) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      input: stdin ?? "",
      encoding: "utf8",
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", status: err.status };
  }
}

// --- extractHardConstraints (pure function) ---

test("(a) extracts the HARD CONSTRAINTS section body", () => {
  const text = "# Project\n\nsome prose\n\n## HARD CONSTRAINTS\n\n- never do X\n- always do Y\n";
  const result = extractHardConstraints(text);
  assert.equal(result.ok, true);
  assert.match(result.text, /never do X/);
  assert.match(result.text, /always do Y/);
});

test("(b) stops at the next ## heading", () => {
  const text = "## HARD CONSTRAINTS\n\n- rule one\n\n## Other Section\n\nnot part of constraints\n";
  const result = extractHardConstraints(text);
  assert.equal(result.ok, true);
  assert.match(result.text, /rule one/);
  assert.doesNotMatch(result.text, /not part of constraints/);
});

test("(c) no HARD CONSTRAINTS heading -> ok:false", () => {
  const text = "# Project\n\nno such section here\n";
  const result = extractHardConstraints(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no ## HARD CONSTRAINTS section/);
});

test("(d) HARD CONSTRAINTS section present but blank -> ok:false", () => {
  const text = "## HARD CONSTRAINTS\n\n   \n\n## Next\nmore\n";
  const result = extractHardConstraints(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/);
});

test("(e) case-insensitive heading with extra whitespace", () => {
  const text = "##   hard constraints   \nrule text here\n";
  const result = extractHardConstraints(text);
  assert.equal(result.ok, true);
  assert.match(result.text, /rule text here/);
});

test("(f) heading with extra trailing words is not an exact match -> ok:false", () => {
  const text = "## HARD CONSTRAINTS (v1)\nrule text\n";
  const result = extractHardConstraints(text);
  assert.equal(result.ok, false);
});

// --- CLI integration ---

test("(g) session-start + file exists with constraints -> stdout JSON injects text, exit 0", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "## HARD CONSTRAINTS\n\n- never commit .harness/ to the team repo\n", "utf8");
    const { stdout, status } = runCli(
      ["--mode", "session-start", "--context", contextPath],
      JSON.stringify({ hook_event_name: "SessionStart", source: "clear", session_id: "x" }),
    );
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(parsed.hookSpecificOutput.additionalContext, /never commit \.harness\//);
  });
});

test("(h) session-start + file missing -> exit 0, warning in additionalContext", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "does-not-exist.md");
    const { stdout, status } = runCli(["--mode", "session-start", "--context", contextPath]);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /찾지 못함/);
  });
});

test("(i) session-start + file exists but no HARD CONSTRAINTS section -> exit 0, warning", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "# Project\n\nnothing relevant here\n", "utf8");
    const { stdout, status } = runCli(["--mode", "session-start", "--context", contextPath]);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /HARD CONSTRAINTS를 사용할 수 없음/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /no ## HARD CONSTRAINTS section/);
  });
});

test("(j) user-prompt-submit + file exists -> exit 0, no output", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "## HARD CONSTRAINTS\n\n- rule\n", "utf8");
    const { stdout, status } = runCli(["--mode", "user-prompt-submit", "--context", contextPath]);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "");
  });
});

test("(k) user-prompt-submit + file missing -> exit 2, block decision", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "does-not-exist.md");
    const { stdout, stderr, status } = runCli(["--mode", "user-prompt-submit", "--context", contextPath]);
    assert.equal(status, 2);
    assert.match(stderr, /PROJECT-CONTEXT\.md/);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, "block");
  });
});

test("(l) malformed stdin payload does not crash the CLI", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "## HARD CONSTRAINTS\n\n- rule\n", "utf8");
    const { status } = runCli(["--mode", "session-start", "--context", contextPath], "{ not valid json ][");
    assert.equal(status, 0);
  });
});

// --- isUsableCard (pure function) + HYK-96 scope A (form gate) ---

test("(m) isUsableCard: normal filled-in body -> ok", () => {
  const text = "## HARD CONSTRAINTS\n\n- never commit .harness/ to the team repo\n";
  const result = isUsableCard(text);
  assert.equal(result.ok, true);
});

test("(n) isUsableCard: empty section -> ok:false", () => {
  const text = "## HARD CONSTRAINTS\n\n   \n";
  const result = isUsableCard(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/);
});

test("(o) isUsableCard: unresolved placeholder token -> ok:false", () => {
  const text = "## HARD CONSTRAINTS\n\n- never commit harness tooling to <GITHUB_REPO>\n";
  const result = isUsableCard(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /<GITHUB_REPO>/);
});

test("(p) user-prompt-submit + empty HARD CONSTRAINTS -> exit 2, block", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "## HARD CONSTRAINTS\n\n   \n", "utf8");
    const { stdout, stderr, status } = runCli(["--mode", "user-prompt-submit", "--context", contextPath]);
    assert.equal(status, 2);
    assert.match(stderr, /사용할 수 없습니다/);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, "block");
  });
});

test("(q) user-prompt-submit + unedited template (placeholder present) -> exit 2, block", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(
      contextPath,
      "## HARD CONSTRAINTS\n\n- Never commit or push harness tooling to <GITHUB_REPO>.\n- <this project's own hard constraint>\n",
      "utf8",
    );
    const { stdout, status } = runCli(["--mode", "user-prompt-submit", "--context", contextPath]);
    assert.equal(status, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, "block");
    assert.match(parsed.reason, /<GITHUB_REPO>/);
  });
});

test("(r) user-prompt-submit + filled-in card -> exit 0, no output (regression)", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "## HARD CONSTRAINTS\n\n- never commit .harness/ to the team repo\n", "utf8");
    const { stdout, status } = runCli(["--mode", "user-prompt-submit", "--context", contextPath]);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "");
  });
});

test("(s) session-start + placeholder card -> exit 0, warning (does not inject placeholder junk)", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "## HARD CONSTRAINTS\n\n- Never commit or push harness tooling to <GITHUB_REPO>.\n", "utf8");
    const { stdout, status } = runCli(["--mode", "session-start", "--context", contextPath]);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /^프로젝트 하드 제약\(자동 주입\)/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /<GITHUB_REPO>/);
  });
});

// --- HYK-96 Scope D: card structure (HARD CONSTRAINTS injected, Goals/Intent/Context stored only) ---

const TWO_SECTION_CARD =
  "## HARD CONSTRAINTS\n\n" +
  "- never commit .harness/ to the shared team repo\n\n" +
  "## 목표·의도·맥락 (Goals / Intent / Context)\n\n" +
  "- this project exists to pilot the team-local profile end to end\n" +
  "- long freeform background that should never be repeated into every session\n";

test("(t) extractHardConstraints on a two-section card returns only the HARD CONSTRAINTS body", () => {
  const result = extractHardConstraints(TWO_SECTION_CARD);
  assert.equal(result.ok, true);
  assert.match(result.text, /never commit \.harness\//);
  assert.doesNotMatch(result.text, /pilot the team-local profile/);
  assert.doesNotMatch(result.text, /목표·의도·맥락/);
});

test("(u) session-start injection on a two-section card includes HARD CONSTRAINTS, excludes Goals/Intent/Context", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, TWO_SECTION_CARD, "utf8");
    const { stdout, status } = runCli(["--mode", "session-start", "--context", contextPath]);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /never commit \.harness\//);
    assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /pilot the team-local profile/);
  });
});

test("(v) user-prompt-submit on a two-section card with a filled-in HARD CONSTRAINTS -> exit 0 (regression, structure doesn't affect the gate)", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, TWO_SECTION_CARD, "utf8");
    const { stdout, status } = runCli(["--mode", "user-prompt-submit", "--context", contextPath]);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "");
  });
});

// --- HYK-97: template placeholder gap (a freshly-installed stub card was
// silently passing isUsableCard because the template's own fill-in slots
// used lowercase descriptive prose in brackets, e.g. "<this project's own
// hard constraint>", which PLACEHOLDER_RE's `<[A-Z][A-Z0-9_]*>` never
// matched -- install.mjs already substitutes the real `<UPPER_SNAKE>`
// tokens like <GITHUB_REPO>, so the only thing left unedited in a fresh
// install was exactly the placeholder shape this regex is blind to. The
// fix is template-only (uppercase `<REPLACE_ME_...>` tokens); the regex
// itself is intentionally unchanged -- widening it would false-positive on
// a real card that legitimately contains an `<a|b|c>`-style literal (see
// case (y) below, a real shape from this harness's own TEAM10 card).
//
// These tests read the actual template file rather than a hand-copied
// string, on purpose: if the template's placeholder shape ever regresses
// back to something the gate can't see, these tests break along with it
// instead of quietly testing a stale copy.
const TEMPLATE_PATH = fileURLToPath(new URL("../../templates/harness-init/project-context.template.md", import.meta.url));

function freshInstallCard() {
  // Mirrors install.mjs's substitute(): only the install-time placeholder
  // tokens are replaced; REPLACE_ME_* is left exactly as shipped, since
  // that's what a card looks like the moment install.mjs finishes and
  // before any human has touched it.
  const raw = readFileSync(TEMPLATE_PATH, "utf8");
  const map = {
    "<PROFILE>": "team-local",
    "<REPO_PATH>": "C:/Users/Administrator/Documents/TEAM10",
    "<GITHUB_REPO>": "AL06-Class/AL06TEAM10",
  };
  let text = raw;
  for (const [token, value] of Object.entries(map)) {
    text = text.split(token).join(value);
  }
  return text;
}

test("(w) HYK-97: a freshly-installed stub card (real template, install-time tokens substituted) is blocked", () => {
  const result = isUsableCard(freshInstallCard());
  assert.equal(result.ok, false);
  assert.match(result.reason, /REPLACE_ME_HARD_CONSTRAINT_1/);
});

test("(x) HYK-97: filling in the stub's REPLACE_ME_HARD_CONSTRAINT_1 makes the card pass", () => {
  const filled = freshInstallCard().replace(
    "<REPLACE_ME_HARD_CONSTRAINT_1>",
    "never run a Firebase deploy without a human's explicit go-ahead",
  );
  const result = isUsableCard(filled);
  assert.equal(result.ok, true);
});

test("(z) HYK-97 regression: a real filled-in card using a literal <a|b|c>-style bracket does not false-positive", () => {
  const text =
    "## HARD CONSTRAINTS\n\n" +
    "- Firebase/deploy commands run inside the container: `docker compose exec web npm exec firebase -- <login|init|deploy>`\n" +
    "- never commit .harness/ to the shared team repo\n";
  const result = isUsableCard(text);
  assert.equal(result.ok, true);
});
