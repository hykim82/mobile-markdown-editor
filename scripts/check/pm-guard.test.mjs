import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPmGuard,
  CONTROL_ROOM_ROOT,
  isControlRoomPath,
} from "./pm-guard.mjs";
import { normalizeAbsolute } from "./path-normalize.mjs";

// HYK-309: every control-room fixture below is derived from the live
// CONTROL_ROOM_ROOT export instead of a second, independently hardcoded
// literal -- the old version hardcoded this repo's own live control-room
// path (and a matching repo path under this machine's account) a second
// time here, so an installed copy of this file kept asserting against THIS
// machine's path even after pm-guard.mjs itself was correctly substituted
// for the target (install.mjs copies this file raw; see coder.md for the
// full sweep). Deriving from the import makes the fixtures automatically
// correct wherever this file runs, live or installed.
const CONTROL_ROOM = `${CONTROL_ROOM_ROOT}/STATUS.md`;
const SCRATCHPAD =
  "C:/Users/anyuser/AppData/Local/Temp/claude/some-project/scratch.md";
// A generic repo path, deliberately unrelated to CONTROL_ROOM_ROOT and to
// any real machine account/project name -- these tests only need "some
// path that is not the control room and not the scratchpad."
const OTHER_REPO_FILE = "C:/repos/some-other-project/.harness/coder-task.md";
const OTHER_REPO_FILE_WSL =
  "/mnt/c/repos/some-other-project/.harness/coder-task.md";

// (11)/(12)/(13) exercise normalizeAbsolute's WSL/git-bash/backslash
// recognition of a Windows drive-letter path. Those forms only make sense
// when CONTROL_ROOM_ROOT is itself a drive-letter absolute path (true for
// this repo's own live value, and for any solo-full install) -- a
// team-local install substitutes a non-path sentinel (see pm-guard.mjs /
// install.mjs), for which these three forms are not meaningful and are
// skipped rather than asserting something false about a sentinel string.
const DRIVE_MATCH = /^([A-Za-z]):\/(.*)$/.exec(CONTROL_ROOM_ROOT);

test("(1) PM writing inside a repo is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Write",
    filePath: OTHER_REPO_FILE,
  });
  assert.equal(result.ok, false);
});

test("(2) PM writing the control room is allowed", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Edit",
    filePath: CONTROL_ROOM,
  });
  assert.equal(result.ok, true);
});

test("(3) PM writing the scratchpad is allowed", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Write",
    filePath: SCRATCHPAD,
  });
  assert.equal(result.ok, true);
});

test("(4) non-PM role is not regulated by pm-guard", () => {
  const result = checkPmGuard({
    role: "CODER",
    toolName: "Write",
    filePath: OTHER_REPO_FILE,
  });
  assert.equal(result.ok, true);
});

test("(5) unset role is not regulated by pm-guard", () => {
  const result = checkPmGuard({
    role: undefined,
    toolName: "Write",
    filePath: "C:/anywhere/file.md",
  });
  assert.equal(result.ok, true);
});

test("(6) PM calling a Linear write MCP tool (save_) is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__linear-server__save_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, false);
});

test("(7) PM calling a Linear write MCP tool (create_) is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__linear-server__create_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, false);
});

test("(8) PM calling a Linear write MCP tool (delete_) is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__linear-server__delete_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, false);
});

test("(9) PM calling a Linear read MCP tool is not blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__linear-server__list_issues",
    filePath: undefined,
  });
  assert.equal(result.ok, true);
});

// HYK-273: the `claude_ai_Linear` connector exposes the same save_/create_/
// delete_ write surface as `linear-server` under a different mcp__ prefix.
// The old regex (mcp__linear-server__ only) let this connector's writes
// through unblocked -- these three cases pin that gap shut and go RED again
// if the second prefix is ever dropped from LINEAR_WRITE_TOOL_RE.
test("(9b) PM calling the claude_ai_Linear connector's save_ tool is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__claude_ai_Linear__save_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, false);
});

test("(9c) PM calling the claude_ai_Linear connector's create_ tool is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__claude_ai_Linear__create_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, false);
});

test("(9d) PM calling the claude_ai_Linear connector's delete_ tool is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__claude_ai_Linear__delete_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, false);
});

test("(9e) PM calling the claude_ai_Linear connector's read tool is not blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__claude_ai_Linear__list_issues",
    filePath: undefined,
  });
  assert.equal(result.ok, true);
});

test("(10) PM calling a non-write tool (Read) is not regulated", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Read",
    filePath: "C:/anywhere/file.md",
  });
  assert.equal(result.ok, true);
});

test(
  "(11) WSL-style path into the control room is recognized and allowed",
  { skip: !DRIVE_MATCH },
  () => {
    const [, drive, rest] = DRIVE_MATCH;
    const result = checkPmGuard({
      role: "PM",
      toolName: "Write",
      filePath: `/mnt/${drive.toLowerCase()}/${rest}/STATUS.md`,
    });
    assert.equal(result.ok, true);
  },
);

test(
  "(12) Git-Bash-style path into the control room is recognized and allowed",
  { skip: !DRIVE_MATCH },
  () => {
    const [, drive, rest] = DRIVE_MATCH;
    const result = checkPmGuard({
      role: "PM",
      toolName: "Write",
      filePath: `/${drive.toLowerCase()}/${rest}/STATUS.md`,
    });
    assert.equal(result.ok, true);
  },
);

test(
  "(13) backslash-form control room path is recognized and allowed",
  { skip: !DRIVE_MATCH },
  () => {
    const result = checkPmGuard({
      role: "PM",
      toolName: "Edit",
      filePath: `${CONTROL_ROOM_ROOT.replace(/\//g, "\\")}\\PM\\relay\\pm-task.md`,
    });
    assert.equal(result.ok, true);
  },
);

test("(14) WSL-style path into a repo (not control room) is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Write",
    filePath: OTHER_REPO_FILE_WSL,
  });
  assert.equal(result.ok, false);
});

test("(15) a path that merely starts with the control room name as a sibling dir is not fooled into passing", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Write",
    filePath: `${CONTROL_ROOM_ROOT}-아닌곳/file.md`,
  });
  assert.equal(result.ok, false);
});

// HYK-309 2R (REVIEW P2, judged worth closing rather than left as-is):
// (11)-(13) above are necessarily skip-only for team-local -- there is no
// control room to test writing into when CONTROL_ROOM_ROOT is the
// non-path sentinel, and that's correct, not a bug. But it also silently
// drops team-local's coverage of the WSL/git-bash/backslash
// format-equivalence property itself. These three always run, regardless
// of profile/DRIVE_MATCH, by calling the real allow-list logic
// (isControlRoomPath, now exported with an optional root override) against
// a synthetic root fully independent of whatever CONTROL_ROOM_ROOT this
// install actually carries -- restoring that generic coverage without
// pretending team-local has a control room to write into.
const SYNTHETIC_DRIVE_ROOT = "Z:/hyk309-synthetic-drive-root";

test("(16) WSL-style form of a synthetic root is recognized as that root, independent of profile/CONTROL_ROOM_ROOT", () => {
  const normalized = normalizeAbsolute(
    "/mnt/z/hyk309-synthetic-drive-root/STATUS.md",
  );
  assert.equal(isControlRoomPath(normalized, SYNTHETIC_DRIVE_ROOT), true);
});

test("(17) Git-Bash-style form of a synthetic root is recognized as that root, independent of profile/CONTROL_ROOM_ROOT", () => {
  const normalized = normalizeAbsolute(
    "/z/hyk309-synthetic-drive-root/STATUS.md",
  );
  assert.equal(isControlRoomPath(normalized, SYNTHETIC_DRIVE_ROOT), true);
});

test("(18) backslash form of a synthetic root is recognized as that root, independent of profile/CONTROL_ROOM_ROOT", () => {
  const normalized = normalizeAbsolute(
    `${SYNTHETIC_DRIVE_ROOT.replace(/\//g, "\\")}\\PM\\relay\\pm-task.md`,
  );
  assert.equal(isControlRoomPath(normalized, SYNTHETIC_DRIVE_ROOT), true);
});

test("(19) a synthetic root's sibling-name path is still correctly rejected, independent of profile/CONTROL_ROOM_ROOT", () => {
  const normalized = normalizeAbsolute(
    `${SYNTHETIC_DRIVE_ROOT}-not-it/file.md`,
  );
  assert.equal(isControlRoomPath(normalized, SYNTHETIC_DRIVE_ROOT), false);
});
