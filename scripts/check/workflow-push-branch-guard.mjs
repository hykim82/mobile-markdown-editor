// workflow-push-branch-guard: fails when .github/workflows/enforce.yml's
// `push:` trigger does not cover the repository's actual default branch.
//
// Motivation (HYK-304-firstpaint-untitled-1 §8, 책임자 판정 3): enforce.yml
// had `push: branches: [master]` while this repo's default branch is
// `main` -- a merge to `main` silently never ran CI (measured: 0 `enforce`
// runs against `main` after PR #9 merged, coder-task.md §8-1). The
// `pull_request` trigger stayed correct the whole time, so every PR's green
// checkmark was real -- the missing piece was "does anyone look again after
// merge," which is exactly what a wrong push-trigger branch name silently
// turns off. A branch rename (main -> master or vice versa, or any future
// rename) would silently reintroduce this without this guard.
//
// What this PROVES: for the target workflow file, `on:` declares a `push:`
// trigger, and if that trigger restricts to a `branches:` list, that list
// includes the repo's resolved default branch. An absent `push:` key is
// ALSO a violation -- that's structurally the same failure this guard
// exists to catch (CI never running on a push to the default branch),
// just reached by deleting the trigger instead of mistyping its branch
// name.
//
// What this DOES NOT prove (deliberately narrow, matches this repo's guard
// idiom of an explicit non-goals list):
//   - Only `.github/workflows/enforce.yml` is checked (the `workflowPath`
//     default) -- this is the one file this finding was about; a future
//     second workflow file needs either its own call to
//     runWorkflowPushBranchGuard() or a deliberate widening of this file,
//     not silent coverage by this guard alone.
//   - The push-branch parsing is a narrow line-indentation reader (this
//     repo's idiom, see live-harness-scratch-guard.mjs's own header), not a
//     real YAML parser -- unusual formatting (flow-style `branches: [main]`,
//     tabs, a `!=` anchor/alias) is not understood and would read as "no
//     branches list found" rather than erroring loudly.
//   - Anything other than the push-trigger's branch coverage (job
//     permissions, other trigger types, secrets, step contents) is out of
//     scope entirely.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const DEFAULT_WORKFLOW_PATH = ".github/workflows/enforce.yml";
const HARDCODED_FALLBACK_BRANCH = "main";

function indentOf(line) {
  const m = line.match(/^(\s*)\S/);
  return m ? m[1].length : null;
}

// Finds `keyName:` (a key with no inline value -- a nested block) anywhere
// in `lines`, ignoring indentation (used only for the file-level `on:` key,
// which this repo's one workflow file always writes at column 0).
function findTopLevelKeyBlock(lines, keyName) {
  const re = new RegExp(`^(\\s*)${keyName}:\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) return { lineIndex: i, indent: m[1].length };
  }
  return null;
}

// Finds `keyName:` as a direct descendant of the block that starts at
// `parentLineIndex`/`parentIndent` -- stops (returns null) as soon as a
// non-blank line at or below the parent's own indent is seen, i.e. once
// control has left that block without finding the key.
function findChildBlock(lines, parentLineIndex, parentIndent, keyName) {
  const re = new RegExp(`^(\\s*)${keyName}:\\s*$`);
  for (let i = parentLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (indent <= parentIndent) return null;
    const m = line.match(re);
    if (m) return { lineIndex: i, indent: m[1].length };
  }
  return null;
}

// Collects `- item` list entries that are direct children of the block
// starting at `parentLineIndex`/`parentIndent`.
function extractListItems(lines, parentLineIndex, parentIndent) {
  const items = [];
  for (let i = parentLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (indent <= parentIndent) break;
    const m = line.match(/^\s*-\s*(\S+)/);
    if (m) items.push(m[1]);
  }
  return items;
}

// Reads the "on: ... push: ... branches: ..." shape by indentation, the
// same narrow text-pattern style this repo's other scripts/check guards
// use (no YAML parser dependency). Returns `hasPush: false` if there is no
// `push:` key under `on:` at all, or `{ hasPush: true, branches }` where
// `branches` is `null` when the push trigger has no branches filter
// (matches every branch, including the default -- not a violation) or the
// array of branch name strings when it does.
export function parseWorkflowPushBranches(text) {
  const lines = text.split(/\r?\n/);

  const on = findTopLevelKeyBlock(lines, "on");
  if (!on) return { hasPush: false, branches: null };

  const push = findChildBlock(lines, on.lineIndex, on.indent, "push");
  if (!push) return { hasPush: false, branches: null };

  const branchesKey = findChildBlock(
    lines,
    push.lineIndex,
    push.indent,
    "branches",
  );
  if (!branchesKey) return { hasPush: true, branches: null };

  const branches = extractListItems(
    lines,
    branchesKey.lineIndex,
    branchesKey.indent,
  );
  return { hasPush: true, branches };
}

// 기본 가지를 git 에서 읽는다(하드코딩 "main" 리터럴이면 가지 이름이 또
// 바뀌면 또 조용히 꺼진다 -- coder-task.md §8-3). origin 추적이 없거나
// 이 명령을 못 읽으면(예: origin remote 없는 고립 클론) 하드코딩
// 폴백으로 내려간다 -- 그 한계는 반환값의 `source` 에 그대로 남긴다.
export function defaultResolveDefaultBranch(cwd) {
  try {
    const out = execFileSync(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd, encoding: "utf8" },
    ).trim();
    // out 은 "origin/main" 모양이다 -- 첫 세그먼트(remote 이름)만 뗀다.
    const branch = out.split("/").slice(1).join("/");
    if (branch) {
      return {
        branch,
        source: "git symbolic-ref refs/remotes/origin/HEAD",
      };
    }
  } catch {
    // fall through to hardcoded fallback below
  }
  return {
    branch: HARDCODED_FALLBACK_BRANCH,
    source: `hardcoded fallback ("${HARDCODED_FALLBACK_BRANCH}") -- git symbolic-ref refs/remotes/origin/HEAD 를 못 읽음(origin remote 미추적 등)`,
  };
}

export function runWorkflowPushBranchGuard({
  cwd,
  workflowPath = DEFAULT_WORKFLOW_PATH,
  readFileFn = (fullPath) => readFileSync(fullPath, "utf8"),
  resolveDefaultBranchFn = defaultResolveDefaultBranch,
} = {}) {
  const fullPath = join(cwd, workflowPath);
  let text;
  try {
    text = readFileFn(fullPath);
  } catch (err) {
    return {
      ok: false,
      reason: `workflow-push-branch-guard: failed to read ${workflowPath} -- fail-closed (${err.message})`,
    };
  }

  const { branch: defaultBranch, source: defaultBranchSource } =
    resolveDefaultBranchFn(cwd);
  const { hasPush, branches } = parseWorkflowPushBranches(text);

  if (!hasPush) {
    return {
      ok: false,
      reason:
        `workflow-push-branch-guard: ${workflowPath} 의 on: 에 push 트리거가 없다 -- ` +
        `${defaultBranch} 에 병합돼도 CI 가 안 돈다(HYK-304 §8-1 재발 형태, default branch source: ${defaultBranchSource})`,
      defaultBranch,
      defaultBranchSource,
      hasPush,
      branches,
    };
  }

  if (branches !== null && !branches.includes(defaultBranch)) {
    return {
      ok: false,
      reason:
        `workflow-push-branch-guard: ${workflowPath} 의 push.branches(${branches.join(", ")}) 가 ` +
        `저장소 기본 가지(${defaultBranch})를 포함하지 않는다 -- ${defaultBranch} 에 병합돼도 CI 가 안 돈다(HYK-304 §8-1, default branch source: ${defaultBranchSource})`,
      defaultBranch,
      defaultBranchSource,
      hasPush,
      branches,
    };
  }

  return {
    ok: true,
    reason: `workflow-push-branch-guard: ${workflowPath} 의 push 트리거가 기본 가지(${defaultBranch})를 포함한다`,
    defaultBranch,
    defaultBranchSource,
    hasPush,
    branches,
  };
}

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/workflow-push-branch-guard.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let cwd = repoRoot();
  let workflowPath = DEFAULT_WORKFLOW_PATH;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd") cwd = args[++i];
    else if (args[i] === "--workflow-path") workflowPath = args[++i];
  }
  const result = runWorkflowPushBranchGuard({ cwd, workflowPath });
  if (result.ok) {
    console.log(result.reason);
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
