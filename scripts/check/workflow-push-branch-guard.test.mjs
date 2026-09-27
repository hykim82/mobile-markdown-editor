// review-1R-원문.md §9(P2-4): workflow-push-branch-guard.mjs 를 부르는
// 곳이 한 군데도 없었다 -- enforce.yml 스텝 없음 · hooks/pre-commit 없음
// · .test.mjs 짝 없음(npm test 스위트도 안 건드린다). 이 파일은 그 셋째
// 공백(단위 시험)을 메운다: 가드가 "빨강을 낼 수 있는가"를 픽스처로 재고,
// 함께 고친 P2-2(폴백 소리내기)·P2-3(빈 branches 문면)도 값으로 잰다.
// 실제 .github/workflows/enforce.yml 이나 이 저장소의 origin remote 는
// 건드리지 않는다 -- runWorkflowPushBranchGuard 가 받는 readFileFn/
// resolveDefaultBranchFn 주입 지점만 쓴다(단, 맨 아래 "CLI 배선" 시험
// 한 개만 실제 fixture git repo 로 end-to-end 를 잰다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseWorkflowPushBranches,
  runWorkflowPushBranchGuard,
} from "./workflow-push-branch-guard.mjs";

const GUARD_PATH = fileURLToPath(
  new URL("./workflow-push-branch-guard.mjs", import.meta.url),
);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const gitBranchesResolver = (branch) => () => ({
  branch,
  source: "git symbolic-ref refs/remotes/origin/HEAD",
  usedFallback: false,
});

test("parseWorkflowPushBranches: on: 자체가 없으면 hasPush:false", () => {
  const result = parseWorkflowPushBranches("name: enforce\njobs: {}\n");
  assert.deepEqual(result, { hasPush: false, branches: null });
});

test("parseWorkflowPushBranches: on: 은 있는데 push: 가 없으면 hasPush:false", () => {
  const text = "on:\n  pull_request:\njobs: {}\n";
  const result = parseWorkflowPushBranches(text);
  assert.deepEqual(result, { hasPush: false, branches: null });
});

test("parseWorkflowPushBranches: push: 만 있고 branches: 가 없으면 branches:null(모든 가지 매치)", () => {
  const text = "on:\n  push:\njobs: {}\n";
  const result = parseWorkflowPushBranches(text);
  assert.deepEqual(result, { hasPush: true, branches: null });
});

test("parseWorkflowPushBranches: push.branches 목록을 그대로 읽는다", () => {
  const text =
    "on:\n  push:\n    branches:\n      - main\n      - release\njobs: {}\n";
  const result = parseWorkflowPushBranches(text);
  assert.deepEqual(result, { hasPush: true, branches: ["main", "release"] });
});

test("runWorkflowPushBranchGuard: 파일을 못 읽으면 fail-closed", () => {
  const result = runWorkflowPushBranchGuard({
    cwd: "/nonexistent",
    readFileFn: () => {
      throw new Error("ENOENT: simulated");
    },
    resolveDefaultBranchFn: gitBranchesResolver("main"),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /fail-closed/);
});

test("runWorkflowPushBranchGuard: push 트리거 자체가 없으면 RED (HYK-304 §8-1 과 같은 모양)", () => {
  const result = runWorkflowPushBranchGuard({
    cwd: "/fixture",
    readFileFn: () => "on:\n  pull_request:\njobs: {}\n",
    resolveDefaultBranchFn: gitBranchesResolver("main"),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /push 트리거가 없다/);
});

test("runWorkflowPushBranchGuard: push.branches 가 기본 가지를 안 덮으면 RED -- 이 저장소가 실제로 겪은 사고(master vs main) 재현", () => {
  const result = runWorkflowPushBranchGuard({
    cwd: "/fixture",
    readFileFn: () => "on:\n  push:\n    branches:\n      - master\njobs: {}\n",
    resolveDefaultBranchFn: gitBranchesResolver("main"),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /master/);
  assert.match(result.reason, /main/);
});

test("runWorkflowPushBranchGuard: push.branches 가 빈 배열이면 P2-3 -- '(항목 없음)'으로 말하지 'push.branches()'로 괄호가 비지 않는다", () => {
  const result = runWorkflowPushBranchGuard({
    cwd: "/fixture",
    readFileFn: () => "on:\n  push:\n    branches:\njobs: {}\n",
    resolveDefaultBranchFn: gitBranchesResolver("main"),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /\(항목 없음\)/);
  assert.doesNotMatch(result.reason, /branches\(\)/);
});

test("runWorkflowPushBranchGuard: push.branches 가 기본 가지를 덮으면 GREEN, 사유에 default branch source 가 실린다", () => {
  const result = runWorkflowPushBranchGuard({
    cwd: "/fixture",
    readFileFn: () => "on:\n  push:\n    branches:\n      - main\njobs: {}\n",
    resolveDefaultBranchFn: gitBranchesResolver("main"),
  });
  assert.equal(result.ok, true);
  assert.match(result.reason, /default branch source: git symbolic-ref/);
});

test("runWorkflowPushBranchGuard: branches: 없이 push: 만 있으면(모든 가지 매치) GREEN", () => {
  const result = runWorkflowPushBranchGuard({
    cwd: "/fixture",
    readFileFn: () => "on:\n  push:\njobs: {}\n",
    resolveDefaultBranchFn: gitBranchesResolver("main"),
  });
  assert.equal(result.ok, true);
});

test("runWorkflowPushBranchGuard: P2-2 -- 기본 가지를 하드코딩 폴백으로 읽었으면(usedFallback) push.branches 가 맞아도 RED(조용한 성공 금지)", () => {
  const result = runWorkflowPushBranchGuard({
    cwd: "/fixture",
    readFileFn: () => "on:\n  push:\n    branches:\n      - main\njobs: {}\n",
    resolveDefaultBranchFn: () => ({
      branch: "main",
      source: 'hardcoded fallback ("main") -- git symbolic-ref ... 를 못 읽음',
      usedFallback: true,
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.usedFallback, true);
  assert.match(result.reason, /git remote set-head origin -a/);
});

// --- CLI 배선 시험: 실제 fixture git repo 로 --cwd 옵션의 end-to-end 를 잰다 ---

function withFixtureRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "workflow-push-branch-guard-test-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "a@a"]);
    git(dir, ["config", "user.name", "a"]);
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(dir) {
  try {
    const out = execFileSync("node", [GUARD_PATH, "--cwd", dir], {
      encoding: "utf8",
    });
    return { status: 0, out };
  } catch (err) {
    return { status: err.status, out: err.stderr };
  }
}

test("CLI: 실제 origin/HEAD 가 없는 fixture repo(일반적인 CI actions/checkout 형태)에서 --cwd 로 돌리면 RED", () => {
  withFixtureRepo((dir) => {
    writeFileSync(
      join(dir, ".github", "workflows", "enforce.yml"),
      "on:\n  push:\n    branches:\n      - main\njobs: {}\n",
      "utf8",
    );
    const result = runCli(dir);
    assert.equal(result.status, 1);
    assert.match(result.out, /git remote set-head origin -a/);
  });
});
