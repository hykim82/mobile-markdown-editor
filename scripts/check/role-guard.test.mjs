import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRoleWrite } from "./role-guard.mjs";

const repoRoot = "/repo";

function withPacket(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "role-guard-test-"));
  const p = join(dir, "packet.md").replace(/\\/g, "/");
  writeFileSync(p, content, "utf8");
  try {
    fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("(1) ORCH may drop a task file", () => {
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: ".harness/coder-task.md",
    repoRoot,
  });
  assert.equal(result.ok, true);
});

test("(2) ORCH may not edit a source file", () => {
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: "scripts/check/review-gate.mjs",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(3) ORCH may not write a worker result file", () => {
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: ".harness/coder.md",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(4) ORCH is unrestricted outside the repo root (control room)", () => {
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: "/other/control-room/STATUS.md",
    repoRoot,
  });
  assert.equal(result.ok, true);
});

test("(5) CODER may edit a source file", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: "scripts/check/foo.mjs",
    repoRoot,
  });
  assert.equal(result.ok, true);
});

test("(6) CODER may not write review.md", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: ".harness/review.md",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(7) CODER may not write verify.md", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: ".harness/verify.md",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(8) CODER may not write a task file", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: ".harness/coder-task.md",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(9) CODER may write its own result file", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: ".harness/coder.md",
    repoRoot,
  });
  assert.equal(result.ok, true);
});

test("(10) REVIEW may write review.md", () => {
  const result = checkRoleWrite({
    role: "REVIEW",
    filePath: ".harness/review.md",
    repoRoot,
  });
  assert.equal(result.ok, true);
});

test("(11) REVIEW may not edit a source file", () => {
  const result = checkRoleWrite({
    role: "REVIEW",
    filePath: "scripts/check/review-gate.mjs",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(12) REVIEW may not write verify.md", () => {
  const result = checkRoleWrite({
    role: "REVIEW",
    filePath: ".harness/verify.md",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(13) VERIFY may write verify.md", () => {
  const result = checkRoleWrite({
    role: "VERIFY",
    filePath: ".harness/verify.md",
    repoRoot,
  });
  assert.equal(result.ok, true);
});

test("(14) VERIFY may not edit a source file", () => {
  const result = checkRoleWrite({
    role: "VERIFY",
    filePath: "docs/enforcement-v1.md",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(15) VERIFY may not write review.md", () => {
  const result = checkRoleWrite({
    role: "VERIFY",
    filePath: ".harness/review.md",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(16) unset role allows the write but flags a warning", () => {
  const result = checkRoleWrite({
    role: undefined,
    filePath: "scripts/check/foo.mjs",
    repoRoot,
  });
  assert.equal(result.ok, true);
  assert.equal(result.warn, true);
});

test("(17) unknown role string allows the write but flags a warning", () => {
  const result = checkRoleWrite({
    role: "SOMETHING-ELSE",
    filePath: "scripts/check/foo.mjs",
    repoRoot,
  });
  assert.equal(result.ok, true);
  assert.equal(result.warn, true);
});

test("(18) backslash path is normalized before matching", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: "scripts\\check\\foo.mjs",
    repoRoot,
  });
  assert.equal(result.ok, true);
});

test("(19) absolute in-repo path resolves the same as a relative one", () => {
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: `${repoRoot}/.harness/coder-task.md`,
    repoRoot,
  });
  assert.equal(result.ok, true);
});

test("(20) absolute path on a different drive is treated as outside the repo", () => {
  const result = checkRoleWrite({
    role: "REVIEW",
    filePath: "D:/other/file.md",
    repoRoot: "C:/repo",
  });
  assert.equal(result.ok, true);
});

// --- round 2: REVIEW-CODEX found two path-normalization bypasses (both closed here) ---

test("(21) CODER traversal '.harness/foo/../review.md' resolves to review.md -> deny", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: ".harness/foo/../review.md",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(22) CODER traversal '.harness/foo/../verify.md' resolves to verify.md -> deny", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: ".harness/foo/../verify.md",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(23) CODER traversal '.harness/foo/../coder-task.md' resolves to a task file -> deny", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: ".harness/foo/../coder-task.md",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(24) ORCH traversal '.harness/../scripts/...' escapes .harness -> deny", () => {
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: ".harness/../scripts/check/foo.mjs",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(25) ORCH: WSL-style absolute path for an in-repo file is recognized as inside the repo -> deny", () => {
  const winRoot = "C:/Users/Administrator/Documents/HARNESSENGINEERING";
  const result = checkRoleWrite({
    role: "ORCH",
    filePath:
      "/mnt/c/Users/Administrator/Documents/HARNESSENGINEERING/scripts/check/review-gate.mjs",
    repoRoot: winRoot,
  });
  assert.equal(result.ok, false);
});

test("(26) ORCH: WSL-style path for the same repo's task file is still allowed", () => {
  const winRoot = "C:/Users/Administrator/Documents/HARNESSENGINEERING";
  const result = checkRoleWrite({
    role: "ORCH",
    filePath:
      "/mnt/c/Users/Administrator/Documents/HARNESSENGINEERING/.harness/coder-task.md",
    repoRoot: winRoot,
  });
  assert.equal(result.ok, true);
});

test("(27) WSL-style path on a genuinely different drive stays outside the repo -> allow", () => {
  const winRoot = "C:/Users/Administrator/Documents/HARNESSENGINEERING";
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: "/mnt/d/other/place/file.md",
    repoRoot: winRoot,
  });
  assert.equal(result.ok, true);
});

test("(28) Windows-drive path on a genuinely different drive stays outside the repo -> allow", () => {
  const winRoot = "C:/Users/Administrator/Documents/HARNESSENGINEERING";
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: "D:/other/place/file.md",
    repoRoot: winRoot,
  });
  assert.equal(result.ok, true);
});

// --- E4: PM full write-deny inside the repo ---

test("(29) PM may not write a task file inside the repo", () => {
  const result = checkRoleWrite({
    role: "PM",
    filePath: ".harness/coder-task.md",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

test("(30) PM may not write a plain source file inside the repo", () => {
  const result = checkRoleWrite({
    role: "PM",
    filePath: "scripts/check/foo.mjs",
    repoRoot,
  });
  assert.equal(result.ok, false);
});

// --- E2ⓑ: packet: directive gate on any *-task.md write ---

test("(31) *-task.md write quoting a signed packet passes through to normal role logic", () => {
  withPacket("승인: OK 한용 2026-07-11 17:00\n", (packetPath) => {
    const result = checkRoleWrite({
      role: "ORCH",
      filePath: ".harness/coder-task.md",
      repoRoot,
      toolInput: { content: `task_id: X\npacket: ${packetPath}\n` },
    });
    assert.equal(result.ok, true);
  });
});

test("(32) *-task.md write quoting an unsigned packet is denied outright", () => {
  withPacket("승인: ☐\n", (packetPath) => {
    const result = checkRoleWrite({
      role: "ORCH",
      filePath: ".harness/coder-task.md",
      repoRoot,
      toolInput: { content: `task_id: X\npacket: ${packetPath}\n` },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unsigned\/invalid packet/);
  });
});

test("(33) *-task.md write quoting a missing packet file is denied", () => {
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: ".harness/coder-task.md",
    repoRoot,
    toolInput: { content: "task_id: X\npacket: /does/not/exist.md\n" },
  });
  assert.equal(result.ok, false);
});

test("(34) *-task.md write with no packet: line falls through to normal role logic unaffected", () => {
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: ".harness/coder-task.md",
    repoRoot,
    toolInput: { content: "task_id: X\nno packet line here\n" },
  });
  assert.equal(result.ok, true);
});

test("(35) *-task.md write with a parenthesized packet-ish value (narrative, not a path) is not gated", () => {
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: ".harness/coder-task.md",
    repoRoot,
    toolInput: { content: "task_id: X\npacket: (없음 — 사람이 직접 발주)\n" },
  });
  assert.equal(result.ok, true);
});

test("(36) *-task.md write with a relative packet: path is rejected (absolute-only)", () => {
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: ".harness/coder-task.md",
    repoRoot,
    toolInput: { content: "task_id: X\npacket: relative/packet.md\n" },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /absolute path/);
});

test("(37) packet: gate applies via new_string too (Edit tool), not just content (Write)", () => {
  withPacket("승인: ☐\n", (packetPath) => {
    const result = checkRoleWrite({
      role: "ORCH",
      filePath: ".harness/coder-task.md",
      repoRoot,
      toolInput: { new_string: `task_id: X\npacket: ${packetPath}\n` },
    });
    assert.equal(result.ok, false);
  });
});

// HYK-309: was hardcoded to this repo's own live control-room path; this
// test only needs "some absolute path outside repoRoot" -- a generic
// example removes the incidental machine-path leak without weakening the
// assertion.
test("(38) packet: gate applies to a task file outside this repo's root (e.g. control room PM\\relay\\)", () => {
  withPacket("승인: ☐\n", (packetPath) => {
    const result = checkRoleWrite({
      role: "ORCH",
      filePath: "D:/example-control-room/PM/relay/pm-task.md",
      repoRoot,
      toolInput: { content: `task_id: X\npacket: ${packetPath}\n` },
    });
    assert.equal(result.ok, false);
  });
});

test("(39) a write that is not a *-task.md file is never packet-gated even with a packet: line", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: "scripts/check/foo.mjs",
    repoRoot,
    toolInput: { content: "packet: /does/not/exist.md\n" },
  });
  assert.equal(result.ok, true);
});
