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
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseWorkflowPushBranches,
  runWorkflowPushBranchGuard,
  defaultResolveDefaultBranch,
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

// P2-D(review-2R): origin/HEAD 가 없는 저장소에서 defaultResolveDefaultBranch()
// 를 부르면 git 이 stderr 에 내는 "fatal: ref ... is not a symbolic ref" 가
// (execFileSync 가 stdio 를 안 정하면 자식 stderr 를 부모 stderr 로 그대로
// 흘리는 Node 기본 동작 때문에) 화면에 그대로 새 나갔다 -- 사람이 "가드가
// 터졌다"로 읽는 오독의 원인. 이 시험은 process.stderr.write 를 몰래
// 가로채(자식의 stderr pipe 도 그 경로로 부모에 쓰이므로 이 방식으로 잡힌다,
// 실측 확인됨) 그 raw 문구가 안 새는지, 그리고 실패 사실 자체는(usedFallback)
// 여전히 이름으로 살아있는지를 함께 잰다.
test("defaultResolveDefaultBranch: origin/HEAD 가 없어도 git 의 raw stderr(fatal: ...)를 화면에 흘리지 않는다 (P2-D)", () => {
  withFixtureRepo((dir) => {
    const realWrite = process.stderr.write.bind(process.stderr);
    let leaked = "";
    process.stderr.write = (chunk, ...args) => {
      leaked += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      return realWrite(chunk, ...args);
    };
    let result;
    try {
      result = defaultResolveDefaultBranch(dir);
    } finally {
      process.stderr.write = realWrite;
    }
    assert.doesNotMatch(
      leaked,
      /fatal:/,
      "git 의 raw fatal: stderr 가 화면(부모 stderr)으로 새면 안 된다",
    );
    // 실패 자체는 삼켜지지 않는다 -- usedFallback 로 계속 소리낸다.
    assert.equal(result.usedFallback, true);
    assert.equal(result.branch, "main");
  });
});

// --- CLI 배선 시험: 실제 fixture git repo 로 --cwd 옵션의 end-to-end 를 잰다 ---

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

// --- P2-A(검토 2R): CI 축이 비어 있던 문제(HYK-304 §8-1 재발 형태)의 두 번째
// 방벽 -- ⓑ 선택지. 이 저장소의 «실물» .github/workflows/enforce.yml 을
// 직접 읽어 push.branches 가 기본 가지를 덮는지 값으로 잰다. 위의 다른
// 시험들과 달리 runWorkflowPushBranchGuard()/resolveDefaultBranchFn 을 전혀
// 부르지 않는다 -- git 이나 origin remote 상태에 «전혀» 기대지 않으므로
// (actions/checkout 이 origin/HEAD 를 못 세우는 CI 환경 특유의 문제와 무관)
// enforce.yml 자체가 push.branches 를 다시 master 로 되돌리는 실수만 나면
// git 환경과 무관하게 이 시험 하나로 빨개진다. `main` 은 이 저장소의 실제
// 기본 가지 이름을 리터럴로 박은 것 -- 바로 그 리터럴이 바뀌는 사고
// (§8-1: main 인데 master 로 오탈)를 잡는 게 이 시험의 목적이므로, git
// 으로 "지금" 기본 가지를 재조회하면 같은 실수가 이 시험도 함께 속인다.
test("P2-A: 실물 .github/workflows/enforce.yml 의 push 트리거가 이 저장소 기본 가지(main)를 덮는다 -- git/CI 환경 의존 0", () => {
  const enforceYmlPath = fileURLToPath(
    new URL("../../.github/workflows/enforce.yml", import.meta.url),
  );
  const text = readFileSync(enforceYmlPath, "utf8");
  const { hasPush, branches } = parseWorkflowPushBranches(text);
  assert.equal(
    hasPush,
    true,
    "enforce.yml 의 on: 에 push 트리거가 있어야 한다",
  );
  assert.ok(
    branches === null || branches.includes("main"),
    `enforce.yml 의 push.branches 는 "main" 을 포함하거나(또는 branches 자체가 없어 모든 가지를 매치)해야 한다 -- 실측: ${JSON.stringify(branches)}`,
  );
});
