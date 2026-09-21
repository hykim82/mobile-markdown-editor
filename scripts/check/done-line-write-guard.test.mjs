// HYK-186 2R §2 -- done-line-write-guard.mjs (PreToolUse hook wiring
// finalize-done.mjs to the worker's actual completion path).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { checkDoneLineWrite } from "./done-line-write-guard.mjs";

const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "done-line-write-guard.mjs",
);
const FAKE_ROOT = "C:/fake-repo-root-hyk186";

// The CLI resolves its own repoRoot() via `git rev-parse --show-toplevel`
// on its actual cwd (it takes no injectable root, unlike checkDoneLineWrite
// -- that is the real production shape a Claude Code hook process gets
// launched with: no argv, just stdin JSON, cwd = the repo). E2E tests below
// therefore anchor their file_path under the REAL repo root so the CLI's
// own resolution lines up -- read-only path-string comparison, no file is
// actually created or touched at any of these paths.
const REAL_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
})
  .trim()
  .replace(/\\/g, "/");

function runCliWithStdin(payload) {
  const res = spawnSync(process.execPath, [CLI_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  assert.notEqual(res.status, null, "process must not be signal-killed");
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// --- pure function tests ---

test("checkDoneLineWrite: Write with a >>> DONE line into .harness/coder.md -> blocked", () => {
  const result = checkDoneLineWrite({
    filePath: `${FAKE_ROOT}/.harness/coder.md`,
    toolInput: {
      content: "task_id: X\n\n>>> DONE: CODER @ 2026-08-10 00:00 KST\n",
    },
    repoRoot: FAKE_ROOT,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /finalize-done\.mjs coder \.harness/);
});

test("checkDoneLineWrite: Write to .harness/coder.md WITHOUT a DONE line -> allowed (report body still editable)", () => {
  const result = checkDoneLineWrite({
    filePath: `${FAKE_ROOT}/.harness/coder.md`,
    toolInput: { content: "task_id: X\n\nreport body, no done line yet\n" },
    repoRoot: FAKE_ROOT,
  });
  assert.equal(result.ok, true);
});

test("checkDoneLineWrite: Edit introducing a DONE line via new_string -> blocked", () => {
  const result = checkDoneLineWrite({
    filePath: `${FAKE_ROOT}/.harness/review.md`,
    toolInput: {
      new_string: ">>> DONE: REVIEW-CODEX @ 2026-08-10 00:00 KST\n",
    },
    repoRoot: FAKE_ROOT,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /finalize-done\.mjs review \.harness/);
});

test("checkDoneLineWrite: MultiEdit with a DONE line in one of several edits -> blocked", () => {
  const result = checkDoneLineWrite({
    filePath: `${FAKE_ROOT}/.harness/verify.md`,
    toolInput: {
      edits: [
        { old_string: "a", new_string: "b" },
        {
          old_string: "c",
          new_string: ">>> DONE: VERIFY @ 2026-08-10 00:00 KST\n",
        },
      ],
    },
    repoRoot: FAKE_ROOT,
  });
  assert.equal(result.ok, false);
});

test("checkDoneLineWrite: task file (.harness/coder-task.md) is untouched by this guard (role-guard.mjs's job, not this one)", () => {
  const result = checkDoneLineWrite({
    filePath: `${FAKE_ROOT}/.harness/coder-task.md`,
    toolInput: { content: ">>> DONE: CODER @ 2026-08-10 00:00 KST\n" },
    repoRoot: FAKE_ROOT,
  });
  assert.equal(result.ok, true, "task files are not RESULT_FILE_RE-regulated");
});

test("checkDoneLineWrite: unrelated file (source code) -> allowed", () => {
  const result = checkDoneLineWrite({
    filePath: `${FAKE_ROOT}/scripts/check/whatever.mjs`,
    toolInput: { content: ">>> DONE: this is just a code comment @ x\n" },
    repoRoot: FAKE_ROOT,
  });
  assert.equal(result.ok, true);
});

test("checkDoneLineWrite: mid-line/malformed DONE-shaped text (not column-0) -> allowed (mirrors relay-handshake's own DONE_RE anchoring, not a looser/stricter match)", () => {
  const result = checkDoneLineWrite({
    filePath: `${FAKE_ROOT}/.harness/coder.md`,
    toolInput: {
      content: "status: >>> DONE: midline @ 2026-08-10 00:00 KST\n",
    },
    repoRoot: FAKE_ROOT,
  });
  assert.equal(result.ok, true);
});

// --- production entry point, driven directly (§2 요구: 테스트 helper만
// 부르는 결선은 헛시험) -- real CLI process, real stdin JSON shaped exactly
// like Claude Code's PreToolUse hook payload. ---

test("E2E CLI: Write tool_name + >>> DONE content into .harness/coder.md -> exit 2, stderr names finalize-done.mjs", () => {
  const result = runCliWithStdin({
    tool_name: "Write",
    tool_input: {
      file_path: `${REAL_ROOT}/.harness/coder.md`,
      content: "task_id: X\n\n>>> DONE: CODER @ 2026-08-10 00:00 KST\n",
    },
  });
  assert.equal(result.exit, 2);
  assert.match(result.stderr, /finalize-done\.mjs coder \.harness/);
});

test("E2E CLI: Edit tool_name, DONE line in new_string, into .harness/review.md -> exit 2", () => {
  const result = runCliWithStdin({
    tool_name: "Edit",
    tool_input: {
      file_path: `${REAL_ROOT}/.harness/review.md`,
      old_string: "x",
      new_string: ">>> DONE: REVIEW-CODEX @ 2026-08-10 00:00 KST\n",
    },
  });
  assert.equal(result.exit, 2);
});

test("E2E CLI: same Write tool_name, no DONE line -> exit 0 (allowed)", () => {
  const result = runCliWithStdin({
    tool_name: "Write",
    tool_input: {
      file_path: `${REAL_ROOT}/.harness/coder.md`,
      content: "task_id: X\n\nreport body\n",
    },
  });
  assert.equal(result.exit, 0);
});

test("E2E CLI: a non-write tool_name (e.g. Bash) is never regulated by this hook -> exit 0 regardless of content", () => {
  const result = runCliWithStdin({
    tool_name: "Bash",
    tool_input: {
      command:
        "echo '>>> DONE: CODER @ 2026-08-10 00:00 KST' >> .harness/coder.md",
    },
  });
  assert.equal(
    result.exit,
    0,
    "this hook only regulates Edit/Write/MultiEdit tool_input.file_path -- Bash writes are the direct-file-edit limitation, documented, not silently intercepted here",
  );
});

test("E2E CLI: malformed/missing stdin JSON -> exit 0 (fail-open, never blocks on unreadable input)", () => {
  const res = spawnSync(process.execPath, [CLI_PATH], {
    input: "not json",
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
});

// ---------------------------------------------------------------------------
// HYK-186 2R §5 변조1 (필수): 2번 결선 제거 -> 완료 보고가 다시 caller
// 시각(손으로 쓴 DONE)을 조용히 타는지 -> RED.
// ---------------------------------------------------------------------------
test("mutation 1 (필수): checkDoneLineWrite's block branch removed -> a hand-written future/backdated DONE line is silently allowed again -> RED", () => {
  const src = readFileSync(CLI_PATH, "utf8");
  const target =
    "  const role = relative.match(RESULT_FILE_RE)[1];\n  return {\n    ok: false,";
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target must appear exactly once (found ${count})`,
  );
  const mutated = src.replace(
    target,
    "  const role = relative.match(RESULT_FILE_RE)[1];\n  return {\n    ok: true, // MUTATED: block removed\n    _unused: role,\n    okOriginal: false,",
  );
  const dir = mkdtempSync(join(tmpdir(), "done-guard-mut-"));
  // invokedDirectly checks the argv[1] suffix, and this module imports
  // "./path-normalize.mjs" by relative path -- the mutant must keep both
  // the exact path suffix AND a real sibling copy, or it either never runs
  // its CLI block at all or crashes on MODULE_NOT_FOUND (neither is a real
  // RED signal, both look like "exit != 0" for the wrong reason).
  const scriptsCheckDir = join(dir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  const mutantPath = join(scriptsCheckDir, "done-line-write-guard.mjs");
  writeFileSync(mutantPath, mutated, "utf8");
  writeFileSync(
    join(scriptsCheckDir, "path-normalize.mjs"),
    readFileSync(join(dirname(CLI_PATH), "path-normalize.mjs"), "utf8"),
    "utf8",
  );
  try {
    const res = spawnSync(process.execPath, [mutantPath], {
      input: JSON.stringify({
        tool_name: "Write",
        tool_input: {
          file_path: `${REAL_ROOT}/.harness/coder.md`,
          content: "task_id: X\n\n>>> DONE: CODER @ 2020-01-01 00:00 KST\n",
        },
      }),
      encoding: "utf8",
    });
    assert.equal(
      res.status,
      0,
      "RED: with the block branch removed, a hand-written (caller-supplied timestamp) DONE line is silently allowed through the guard",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
