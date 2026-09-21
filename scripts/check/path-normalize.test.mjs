import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toDriveStyle,
  normalizeAbsolute,
  normalizeToRepoRelative,
} from "./path-normalize.mjs";

test("(1) toDriveStyle maps a WSL-style path to drive-letter form", () => {
  assert.equal(toDriveStyle("/mnt/c/Users/foo"), "C:/Users/foo");
});

test("(2) toDriveStyle maps a Git-Bash-style path to drive-letter form", () => {
  assert.equal(toDriveStyle("/c/Users/foo"), "C:/Users/foo");
});

test("(3) toDriveStyle leaves an already-drive-style path unchanged", () => {
  assert.equal(toDriveStyle("C:/Users/foo"), "C:/Users/foo");
});

test("(4) toDriveStyle leaves an unrelated absolute POSIX path unchanged", () => {
  assert.equal(toDriveStyle("/usr/local/bin"), "/usr/local/bin");
});

test("(5) normalizeAbsolute converts backslashes to forward slashes", () => {
  assert.equal(
    normalizeAbsolute("C:\\Users\\foo\\bar.md"),
    "C:/Users/foo/bar.md",
  );
});

test("(6) normalizeAbsolute resolves '..' traversal", () => {
  assert.equal(normalizeAbsolute("C:/Users/foo/../bar.md"), "C:/Users/bar.md");
});

// HYK-309: these two fixtures used to spell out this repo's own live
// control-room path -- unrelated to what the test actually exercises
// (WSL/git-bash drive-letter normalization is generic), so a generic
// example path removes the incidental machine-path leak without weakening
// the assertion.
test("(7) normalizeAbsolute resolves a WSL-style path the same as its drive-letter equivalent", () => {
  assert.equal(
    normalizeAbsolute("/mnt/d/example-root/example-dir/STATUS.md"),
    normalizeAbsolute("D:/example-root/example-dir/STATUS.md"),
  );
});

test("(8) normalizeAbsolute resolves a Git-Bash-style path the same as its drive-letter equivalent", () => {
  assert.equal(
    normalizeAbsolute("/d/example-root/example-dir/STATUS.md"),
    normalizeAbsolute("D:/example-root/example-dir/STATUS.md"),
  );
});

test("(9) normalizeAbsolute resolves a relative path against a base", () => {
  assert.equal(normalizeAbsolute("foo/bar.md", "/repo"), "/repo/foo/bar.md");
});

test("(10) normalizeAbsolute with no base returns a normalized relative path as-is", () => {
  assert.equal(normalizeAbsolute("foo/../bar.md"), "bar.md");
});

test("(11) normalizeToRepoRelative resolves an in-repo relative path", () => {
  const result = normalizeToRepoRelative(".harness/coder-task.md", "/repo");
  assert.deepEqual(result, {
    relative: ".harness/coder-task.md",
    insideRepo: true,
  });
});

test("(12) normalizeToRepoRelative reports a path outside the repo root", () => {
  const result = normalizeToRepoRelative("/other/place/file.md", "/repo");
  assert.equal(result.insideRepo, false);
  assert.equal(result.relative, null);
});

test("(13) normalizeToRepoRelative treats the repo root itself as relative=''", () => {
  const result = normalizeToRepoRelative("/repo", "/repo");
  assert.deepEqual(result, { relative: "", insideRepo: true });
});

test("(14) normalizeToRepoRelative resolves '..' traversal before comparing", () => {
  const result = normalizeToRepoRelative(".harness/foo/../review.md", "/repo");
  assert.deepEqual(result, {
    relative: ".harness/review.md",
    insideRepo: true,
  });
});
