// HYK-189: CLI 진입점(§171-192 `invokedDirectly` 블록)의 인자 파싱 계약을
// 고정한다.
//
// ⚠️ 현재 동작을 «결함으로 명시하고 고정»하는 것이지 «옳다고 승인»하는
// 것이 아니다. 플래그 모양 인자를 역할 이름으로 받는 것은 결함이며,
// 고치면 이 시험도 함께 바뀌어야 한다(docs/enforcement-known-gaps.md
// gap#73 참조). `relay-handshake.mjs` 소스는 이 이슈 범위에서 수정하지
// 않는다 — 인자 파싱 결함(`--role coder` 같은 플래그 모양 인자를 역할
// 이름 `--role`로, `coder`를 harnessDir로 그대로 받아들이는 것)은 이번에
// 고치지 않고 미수리 결함으로만 등재한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  utimesSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import {
  checkRelayHandshake,
  resolveLiveRoundFilePaths,
  wasAdmissionCompletionAttempted,
  PENDING_STALL_THRESHOLD_MS,
} from "./relay-handshake.mjs";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";
import {
  isolatedChildEnv,
  isolatedChildEnvWithLedger,
} from "./admission-ledger-env-isolation.mjs";
import { RELAY_HANDSHAKE_STATIC_SIBLINGS } from "./relay-handshake-fixture-siblings.mjs";

// import.meta.url is resolved relative to this file's own location, not the
// process cwd -- unaffected by the cwd axis (repo root vs scripts/check),
// same reasoning as docs/enforcement-known-gaps.md's "cwd 축" note for the
// static relative imports the NC-2 suites use.
const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "relay-handshake.mjs",
);
const USAGE_MESSAGE = "usage: node relay-handshake.mjs <role> [harnessDir]";

// §2 비타협 #8(coder-task.md): 자식 프로세스 실패(spawn 실패·시그널 종료·
// status===null)는 CLI 계약 위반과 다른 종류의 실패다 -- fail-closed로
// 처리하되 "계약 위반"으로 세지 않는다. 여기서는 spawn 자체가 깨지면
// assert.fail로 그 사실을 명시하고, 정상적으로 끝난 프로세스만 그 exit
// code/stderr를 CLI 계약 단언에 넘긴다.
// HYK-359 2R P1-2: `opts.ledgerEnv` (named fields, see
// admission-ledger-env-isolation.mjs) is the ONLY way a call site may
// deliberately set one of the three protected keys -- `opts.env` itself is
// always run through isolatedChildEnv's stripping regardless, even if it
// spreads `...process.env` (that exact shape used to resurrect
// DISPATCH_RECEIPT_PATH, see the two call sites below that now use
// `ledgerEnv` instead of building `env` by hand).
function runCli(args, { ledgerEnv, ...opts } = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    ...opts,
    // HYK-359: never let an ambient ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH/
    // DISPATCH_RECEIPT_PATH leaked from the invoking shell reach this child --
    // see admission-ledger-env-isolation.mjs's header for why.
    env: ledgerEnv
      ? isolatedChildEnvWithLedger(ledgerEnv, opts.env)
      : isolatedChildEnv(opts.env),
  });
  if (res.error) {
    assert.fail(
      `child process failed to spawn (infra failure, not a CLI contract violation): ${res.error.message}`,
    );
  }
  if (res.status === null) {
    assert.fail(
      `child process terminated by signal ${res.signal} (infra failure, not a CLI contract violation)`,
    );
  }
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// HYK-383: REVIEW-family 결과는 이제 head_commit: 축(§2)이 소비를 막는다
// -- axis ⓑ(실물 대조)가 `git rev-parse HEAD`로 harnessDir를 직접 읽으므로
// REVIEW 계열 fixture는 실제 git 저장소 안에 있어야 하고, 그 실제 HEAD와
// task/result 양쪽의 head_commit: 이 전부 일치해야 한다. CODER/VERIFY/PM은
// 이 축 밖(resolveHeadCommitBinding 자체 스코프 가드)이라 git init 없이도
// 그대로 통과한다 -- 그래서 git init은 REVIEW 계열일 때만 한다.
function ensureGitHeadCommit(dir) {
  if (!existsSync(join(dir, ".git"))) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: dir,
    });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
    execFileSync(
      "git",
      ["commit", "-q", "--allow-empty", "-m", "relay-handshake test fixture"],
      { cwd: dir },
    );
  }
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

function writeValidFixture(dir, role, taskId) {
  const isReview = /^review/i.test(role);
  const headCommitLine = isReview
    ? `head_commit: ${ensureGitHeadCommit(dir)}\n`
    : "";
  writeFileSync(
    join(dir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: 2026-08-03 06:00 KST\n${headCommitLine}`,
    "utf8",
  );
  writeFileSync(
    join(dir, `${role}.md`),
    // HYK-418 §2-1: relay-handshake now rejects a well-formed DONE line
    // with no finalize-done marker (fail-closed) -- this shared fixture
    // builder must carry the marker so every CLI/ok:true test that reuses
    // it keeps exercising ITS OWN feature, not this promotion's rejection.
    `task_id: ${taskId}\n${headCommitLine}\n>>> DONE: ${role.toUpperCase()} @ 2026-08-03 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function withFixtureDirCli(fn) {
  const dir = mkdtempSync(join(tmpdir(), "relay-handshake-cli-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "relay-handshake-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTask(dir, role, content) {
  writeFileSync(join(dir, `${role}-task.md`), content, "utf8");
}

function writeResult(dir, role, content) {
  writeFileSync(join(dir, `${role}.md`), content, "utf8");
}

test("(a) task_id matches + DONE after dropped_at -> ok", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nsome report body\n\n>>> DONE: CODER @ 2026-07-05 06:10:00 KST\ndone_stamped_by: finalize-done\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("(b) task_id mismatch -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-2\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /handshake mismatch/);
  });
});

test("(c) result missing task_id echo -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "no id line here\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing task_id echo/);
  });
});

test("(d) task missing task_id header -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "dropped_at: 2026-07-05 06:00 KST\n");
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing task_id header/);
  });
});

test("(e) result file not found -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /result file not found/);
  });
});

test("(f) task file not found -> blocked", () => {
  withFixtureDir((dir) => {
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /task file not found/);
  });
});

test("(g) stale: DONE timestamp predates dropped_at -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:10 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:00:00 KST\ndone_stamped_by: finalize-done\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /stale result/);
  });
});

test("(h) id matches but result has no DONE line -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nsome report body, no DONE line\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing ">>> DONE/);
    assert.equal(
      result.state,
      "PENDING",
      "genuine no-marker-at-all absence must resolve to the distinct PENDING state, not just ok:false",
    );
  });
});

test("(i) id matches but task is missing dropped_at -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\n");
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing dropped_at/);
  });
});

test("(j) id matches but dropped_at is not parseable -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\ndropped_at: yesterday\n");
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /dropped_at not parseable/);
  });
});

test("(k) id matches but DONE timestamp is not parseable -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> DONE: CODER @ soon\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /DONE timestamp not parseable/);
  });
});

// --- HYK-142 6A: DONE parser `HH:MM(:SS)?` contract frozen --
// dropped_at/DONE timestamps observed in real STATUS/task files sometimes
// carry seconds (e.g. hooks that stamp `HH:MM:SS`) and sometimes don't --
// both forms must parse identically; anything else must still fail-closed.

test("(l) frozen: dropped_at with HH:MM:SS form -> ok", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00:15 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10:00 KST\ndone_stamped_by: finalize-done\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("(m) frozen: DONE with HH:MM:SS form -> ok", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10:45 KST\ndone_stamped_by: finalize-done\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("(n) frozen: both dropped_at and DONE carry HH:MM:SS -> ok, and seconds are honored for staleness ordering", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:10:30 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10:29 KST\ndone_stamped_by: finalize-done\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /stale result/);
  });
});

// ---------------------------------------------------------------------------
// HYK-244 2R-a §2 조각1: 완료시각(>>> DONE:) 분 단위 거부는 «약화 없이
// 유지»(한용 확정 문면). 이 시험들은 정밀도 축 하나만 격리해서 확인한다
// -- droppedAt/mismatch 등 다른 축이 섞이지 않도록, dropped_at은 항상
// DONE보다 충분히 이전으로 고정한다.
// ---------------------------------------------------------------------------

test("HYK-244 (분단위 거부) DONE with minute precision (no seconds) -> blocked loudly, distinct reason naming the offending raw value, never silently accepted", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /minute-precision, seconds required/);
    assert.match(result.reason, /2026-07-05 06:10 KST/);
    assert.match(result.reason, /HH:MM:SS/);
  });
});

test("HYK-244 (분단위 거부, CLI) minute-precision DONE -> CLI exits non-zero with the precision reason on stderr (loud, not quiet)", () => {
  withFixtureDirCli((dir) => {
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: HYK-244-minute-cli\ndropped_at: 2026-08-14 07:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-244-minute-cli\n\n>>> DONE: CODER @ 2026-08-14 07:10 KST\n",
      "utf8",
    );
    const { exit, stderr } = runCli(["coder", dir]);
    assert.notEqual(exit, 0);
    assert.match(stderr, /minute-precision, seconds required/);
  });
});

test("HYK-244 (초단위 정상통과, 오탐 0) DONE with seconds precision -> ok:true, precision check never fires on a well-formed input", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10:07 KST\ndone_stamped_by: finalize-done\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.reason, /minute-precision/);
  });
});

test("HYK-244 (분단위 거부) unparseable DONE ('@ soon') keeps its ORIGINAL 'not parseable' reason -- the new precision check never masks a pre-existing distinct failure mode", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> DONE: CODER @ soon\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /DONE timestamp not parseable/);
    assert.doesNotMatch(result.reason, /minute-precision/);
  });
});

// --- HYK-180 사이클1: mid-line task_id echo distinguished from genuine
// absence (사이클0 증거 -- REVIEW's `for: X / task_id: Y / role: Z` shape
// previously fell through to "missing echo", pending forever) --------

test("(p) known-bad: actual review.md shape -- G1 header + mid-line 'for: X / task_id: Y / role: Z' echo + DONE -> distinct reason, NOT 'missing task_id echo'", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "review",
      "task_id: HYK-167\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "review",
      "dispatch_verified: yes\ntask_id_from_dispatch: HYK-167-review-2\npane_match: 일치\n\nfor: HYK-167 / task_id: HYK-167-review-2 / role: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "review", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /task_id echo not at line start/);
    assert.doesNotMatch(result.reason, /^result missing task_id echo/);
  });
});

test("(q) paired good: same content, task_id moved to a standalone column-0 line -> ok", () => {
  withFixtureDir((dir) => {
    const headCommit = ensureGitHeadCommit(dir);
    writeTask(
      dir,
      "review",
      `task_id: HYK-167-review-2\ndropped_at: 2026-07-05 06:00 KST\nhead_commit: ${headCommit}\n`,
    );
    writeResult(
      dir,
      "review",
      `dispatch_verified: yes\ntask_id_from_dispatch: HYK-167-review-2\npane_match: 일치\ntask_id: HYK-167-review-2\nhead_commit: ${headCommit}\n\nfor: HYK-167 / role: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ 2026-07-05 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
    );
    const result = checkRelayHandshake({ role: "review", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("(r) genuine absence: no task_id token anywhere -> still 'missing task_id echo', unchanged from (c)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "no id token in this file at all\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /^result missing task_id echo/);
  });
});

test("(o) frozen: malformed seconds (single digit) still rejected", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00:5 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /dropped_at not parseable/);
  });
});
// ---------------------------------------------------------------------------
// HYK-173-escalation-1 §2: 결과 파일 상태 확장 -- 「막혔다」와 「아직
// 진행 중(pending)」을 판정기가 서로 다른 값으로 낸다. 4종 합성 결과
// 파일(정상 DONE / 막힘 상태 / DONE도 막힘도 없음(진짜 pending) / 형식이
// 깨진 막힘 표기)을 고정한다. 정상 DONE은 위 (a)가 이미 고정하므로
// (result.state는 그 경로에서 세팅되지 않는다 -- 회귀 0), 여기서는 나머지
// 3종 + 정상 DONE에 BLOCKED 마커가 섞여도 무시된다는 회귀 보강만 추가한다.
// ---------------------------------------------------------------------------

test("HYK-173-escalation-1 (s) explicit BLOCKED marker, no DONE line -> state=BLOCKED, distinct from PENDING", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nreproduce 실패, 재현 조건 불명\n\n>>> BLOCKED: 재현 실패 -- 조건 불명\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "BLOCKED");
    assert.match(
      result.reason,
      /worker reported BLOCKED: 재현 실패 -- 조건 불명/,
    );
  });
});

test("HYK-173-escalation-1 (t) explicit NEEDS_INPUT marker, no DONE line -> state=NEEDS_INPUT, distinct from PENDING and from BLOCKED", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nQUESTION: 어느 방향으로 갈지 결정 필요\n\n>>> NEEDS_INPUT: 게이트 신호 대기 중\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "NEEDS_INPUT");
    assert.match(
      result.reason,
      /worker reported NEEDS_INPUT: 게이트 신호 대기 중/,
    );
  });
});

test("HYK-173-escalation-1 (u) no DONE and no BLOCKED/NEEDS_INPUT marker -> state=PENDING (genuinely still in progress, not blocked)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n작업 중, 아직 보고 없음\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "PENDING");
  });
});

// HYK-414 래칫(time-judgment-now-injection): 이 라운드가 «새로 추가하는»
// checkRelayHandshake 호출은 실제 시계에 기대지 않는다 -- 이 파일 픽스처의
// dropped_at(2026-08-08 21:00 KST) 직후로 고정한 값을 명시적으로 넘긴다.
const HYK442_5R_FIXED_NOW = Date.parse("2026-08-08T12:05:00Z");

// ⛔HYK-442 5R: this test's contract CHANGED (see coder.md §2-1 for the
// impossibility proof and the responsible party's 5R instruction). A marker
// shape with PROSE before it on its line is no longer counted as a near-miss
// attempt: it is structurally indistinguishable from the quoted mentions that
// blocked two legitimate stop terminations on 2026-09-05, and every attempt to
// tell the two apart (three rounds: narrowing, widening, delimiter-position
// rules) was broken by review with attacker-chosen input. What survives -- and
// what this test now pins in BOTH directions -- is the line-based definition:
// an attempt begins its line (modulo whitespace/punctuation/invisible chars).
test("HYK-442 5R (구 HYK-173-escalation-1 (v), 계약 변경): 줄 «중간»(앞에 산문) 표지 모양만 있는 결과 -> PENDING · 같은 문장을 «줄 머리»에서 시작하면 여전히 MALFORMED_BLOCKED", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nstatus note: >>> BLOCKED: mid-line, not a standalone marker\n",
    );
    assert.equal(
      checkRelayHandshake({ role: "coder", harnessDir: dir }).state,
      "PENDING",
    );
    // 안전 축(잃어버리면 안 되는 쪽)은 그대로다 -- 줄 머리에서 시작한
    // 시도는 어떤 접두 기호가 붙어도 계속 fail-closed로 잡힌다.
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n⛔ >>> BLOCKED: mid-line, not a standalone marker\n",
    );
    const attempt = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: HYK442_5R_FIXED_NOW,
    });
    assert.equal(attempt.ok, false);
    assert.equal(
      attempt.state,
      "MALFORMED_BLOCKED",
      "a malformed blocked marker ATTEMPT must not silently fall back to plain pending",
    );
  });
});

test("HYK-173-escalation-1 (w) malformed blocked marker (empty reason after colon) -> state=MALFORMED_BLOCKED, fail-closed", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> BLOCKED:   \n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "MALFORMED_BLOCKED");
  });
});

test("HYK-173-escalation-1 (x) two BLOCKED lines -> state=AMBIGUOUS_BLOCKED, not silently resolved to either", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> BLOCKED: first reason\n>>> BLOCKED: second reason\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "AMBIGUOUS_BLOCKED");
  });
});

test("HYK-173-escalation-1 (y) regression: a normal DONE result with an incidental '>>> BLOCKED:' string still resolves ok=true (DONE path untouched, blocked check never runs when DONE resolves)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nearlier round note: >>> BLOCKED: old, resolved already\n\n>>> DONE: CODER @ 2026-07-05 06:10:00 KST\ndone_stamped_by: finalize-done\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// HYK-173-escalation-2 §2-1: REVIEW 반려 (1)/(2)의 4개 반례를 시험으로
// 못 박는다 -- 화살표 뒤 개행 · 콜론 뒤 개행 · 유효+깨진 공존 · 줄중간
// 표지. 앞 셋은 1R에는 없던 반례(REVIEW가 mkdtemp로 직접 주입해 잡음),
// 넷째(줄중간)는 1R의 (v)가 이미 고정했지만 REVIEW 반례 목록에도 있으므로
// 여기 다시 명시해 이 라운드의 "4개 반례" 완결성을 이 파일 하나로도
// 확인할 수 있게 한다.
// ---------------------------------------------------------------------------

test("HYK-173-escalation-2 (z1) REVIEW repro: newline right after '>>>' (before the keyword) -> MALFORMED_BLOCKED, NOT accepted as a valid one-line marker", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>>\nBLOCKED: split\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "MALFORMED_BLOCKED");
    assert.notEqual(
      result.state,
      "BLOCKED",
      "the pre-repair `\\s*` swallowed the newline and wrongly accepted this as a valid single-line marker",
    );
  });
});

test("HYK-173-escalation-2 (z2) REVIEW repro: newline right after the colon (reason on the next line) -> MALFORMED_BLOCKED, NOT accepted as a valid one-line marker", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> BLOCKED:\nreason on next line\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "MALFORMED_BLOCKED");
    assert.notEqual(
      result.state,
      "BLOCKED",
      "the pre-repair `\\s*` between the colon and the reason swallowed the newline and wrongly accepted this as valid",
    );
  });
});

// ⛔HYK-442 5R: 계약 변경(위 (v)와 같은 이유·같은 증명). «유효 표지 한 줄 +
// 별도의 깨진 시도»를 혼재로 보는 축 자체는 살아 있고(둘째 assert), 사라진
// 것은 «줄 중간·앞에 산문» 하나뿐이다.
test("HYK-442 5R (구 HYK-173-escalation-2 (z3), 계약 변경): 유효 표지 + 줄 «중간» 표지 모양 -> BLOCKED · 유효 표지 + «줄 머리» 깨진 시도 -> 여전히 MALFORMED_BLOCKED", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> BLOCKED: valid\nstatus: >>> BLOCKED: midline\n",
    );
    assert.equal(
      checkRelayHandshake({ role: "coder", harnessDir: dir }).state,
      "BLOCKED",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> BLOCKED: valid\n  >>> BLOCKED: broken attempt\n",
    );
    const mixed = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: HYK442_5R_FIXED_NOW,
    });
    assert.equal(mixed.ok, false);
    assert.equal(
      mixed.state,
      "MALFORMED_BLOCKED",
      "the pre-repair code stopped looking for near-misses the moment it found one strict match, so the separate broken line was silently ignored",
    );
  });
});

test("HYK-442 5R (구 HYK-173-escalation-2 (z4), 계약 변경): 줄 중간 표지 모양만 있는 결과 -> PENDING (위 (v)와 같은 입력·같은 계약, 여기서도 다시 고정)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nstatus note: >>> BLOCKED: mid-line, not a standalone marker\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "PENDING");
  });
});

// ---------------------------------------------------------------------------
// HYK-173-escalation-2 §2-3: 판단 -- 태스크 지시문이 결과 파일에 그대로
// 붙어 column-0 `>>> BLOCKED: <reason>` 한 줄이 "우연히" 만들어지는
// 경우, 이 라운드는 ⓐ를 선택한다 -- 그대로 "막힘"으로 본다(거짓 양성일
// 수 있지만 fail-loud). 근거: ⓑ(표지를 task_id에 결속)는 표지 계약을
// 바꾸므로 1R 시험 전체를 함께 고쳐야 하고, streak=1인 이번 라운드에
// 그 비용까지 얹는 건 위험이 더 크다. 이 저장소가 반복해 온 원칙("판정
// 불가/애매함은 조용히 접지 말고 드러내라")과도 ⓐ가 더 맞는다 -- 거짓
// BLOCKED 알림은 성가시지만 안전한 실패(사람이 보고 "이건 아니네" 하고
// 넘기면 그만)고, 반대로 진짜 막힘을 조용히 pending으로 접는 게 이
// 이슈가 막으려는 바로 그 사고다. 이 시험은 그 판정을 고정한다 -- 지우면
// (즉 우연한 삽입을 구별해 무시하도록 바꾸면) RED가 된다.
// ---------------------------------------------------------------------------

test("HYK-173-escalation-2 (z5) §2-3 판정 ⓐ: task-content가 그대로 결과 파일에 붙어 우연히 column-0 BLOCKED 한 줄이 생겨도 그대로 BLOCKED로 본다(거짓 양성 감수, fail-loud -- task_id 결속 등 우연 구별 방어를 넣지 않기로 한 결정을 고정)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    // 태스크 파일 문구를 그대로 복사-붙여넣기한 것을 흉내: 지시문 안의
    // 예시 줄이 column-0에 그대로 옮겨졌다.
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n(참고용으로 지시 원문을 그대로 붙여둔다)\n>>> BLOCKED: <이유>\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(
      result.state,
      "BLOCKED",
      "§2-3 ⓐ 결정: 우연한 삽입을 구별하지 않는다 -- 그대로 BLOCKED (fail-loud)",
    );
    assert.match(result.reason, /worker reported BLOCKED: <이유>/);
  });
});

// ---------------------------------------------------------------------------
// HYK-189 §완료조건 (a): 인자 없음 -> exit 1, stderr가 usage 문자열과
// 정확히 일치, 프로세스 실행 실패 0건. 느슨한 "exit !== 0" 단언은
// exit 2/시그널/spawn 실패까지 통과시키므로 여기서는 정확한 exit 1과
// stderr 정확 일치를 함께 단언한다.
// ---------------------------------------------------------------------------
test("HYK-189 (a) CLI: no args -> exit exactly 1, stderr exactly matches the usage string (strict, not loose 'exit !== 0')", () => {
  const { exit, stdout, stderr } = runCli([]);
  assert.equal(exit, 1, "must exit with exactly code 1, not merely non-zero");
  assert.equal(
    stderr.trim(),
    USAGE_MESSAGE,
    "stderr must exactly equal the usage string, not just contain/match it loosely",
  );
  assert.equal(stdout, "", "no-arg failure must not print anything to stdout");
});

// ---------------------------------------------------------------------------
// HYK-189 §완료조건 (b)+(d): 정상 위치 인자 coder/review/verify 3건을
// 분모로 고정하고 오탐 0/3을 산출 명령과 함께 제시한다. 각 role에 대해
// mkdtemp 픽스처 안에 유효한 <role>-task.md/<role>.md 쌍을 만들고, 첫
// 위치 인자가 그 role로, 두 번째 위치 인자가 harnessDir로 올바르게
// 파싱되어 exit 0(정상 판정)이 나오는지 확인한다.
// ---------------------------------------------------------------------------
test("HYK-189 (b)+(d) CLI: positional args coder/review/verify (denominator 3/3) -> role/harnessDir parsed correctly, false-positive rate 0/3", () => {
  const roles = ["coder", "review", "verify"];
  const falsePositives = [];
  for (const role of roles) {
    withFixtureDirCli((dir) => {
      writeValidFixture(dir, role, `HYK-189-${role}-fixture`);
      const { exit, stderr } = runCli([role, dir]);
      if (exit !== 0) {
        falsePositives.push({ role, exit, stderr });
      }
    });
  }
  assert.deepEqual(
    falsePositives,
    [],
    `positional-arg parsing must accept all ${roles.length}/${roles.length} well-formed invocations; false positives: ${JSON.stringify(falsePositives)}`,
  );
});

// ---------------------------------------------------------------------------
// HYK-189 §완료조건 (c), HYK-269 재작업: 플래그 모양 인자의 «현재» 의미
// 계약을 고정한다(argv 위치 파싱 결함 자체는 여전히 미수리 -- 위 파일
// 헤더 참조, gap#73 그대로). `node relay-handshake.mjs --role coder
// --harness-dir .harness` 호출에서 process.argv[2] === "--role"이 role
// 위치 인자로 그대로 들어가는 것은 이전과 같지만, HYK-269가 그 자리에
// role 허용 목록 검증(ALLOWED_ROLES)을 얹었으므로 "--role"은 이제 그
// 검증에서 바로 거부된다(task file not found까지 가지 않는다) -- role
// 값 자체가 알 수 없는 문자열이면 정본 4개(CODER/REVIEW/VERIFY/PM) 중
// 무엇에도 안 걸리는 게 당연하다. 나머지 인자(--harness-dir .harness)가
// 무시된다는 계약은 이 시험이 원래 고정하려던 게 아니므로 별도 확인하지
// 않는다.
// ---------------------------------------------------------------------------
test("HYK-269 CLI: unknown role literal ('bogus') is rejected with exit 1, allowed roles + a correct-format example shown", () => {
  const { exit, stdout, stderr } = runCli(["bogus"]);
  assert.equal(exit, 1);
  assert.equal(
    stderr.trim(),
    "unknown role 'bogus' -- allowed roles: CODER, REVIEW, VERIFY, PM\nexample: node relay-handshake.mjs CODER .harness",
    "rejection message must name the offending value, the allowed list, and a correct-format example -- not just a bare reason",
  );
  assert.equal(
    stdout,
    "",
    "unknown-role rejection must not print anything to stdout",
  );
});

test("HYK-269 CLI: lowercase/mixed-case role args (coder/Coder/CODER) are all accepted -- case-insensitive validation, never rejected as unknown", () => {
  for (const role of [
    "coder",
    "Coder",
    "CODER",
    "review",
    "REVIEW",
    "pm",
    "PM",
  ]) {
    withFixtureDirCli((dir) => {
      writeValidFixture(dir, role.toLowerCase(), `HYK-269-case-${role}`);
      const { exit, stderr } = runCli([role, dir]);
      assert.equal(
        exit,
        0,
        `role '${role}' must be accepted (case-insensitive match against CODER/REVIEW/VERIFY/PM), got stderr: ${stderr}`,
      );
    });
  }
});

test("HYK-269 CLI: flag-shaped role arg '--role' fails role validation (unknown role), exit 1, allowed-list + example shown", () => {
  const { exit, stderr } = runCli([
    "--role",
    "coder",
    "--harness-dir",
    ".harness",
  ]);
  assert.equal(exit, 1);
  assert.match(
    stderr.trim(),
    /^unknown role '--role' -- allowed roles: CODER, REVIEW, VERIFY, PM$/m,
    "unrecognized role literal must be rejected with the allowed-role list, not silently treated as a role name",
  );
  assert.match(
    stderr,
    /example: node relay-handshake\.mjs CODER \.harness/,
    "rejection must show a correct-format example call",
  );
});

// ---------------------------------------------------------------------------
// HYK-189 §완료조건 (e): 판별력 자동화 -- mutation 3종. 사본은 반드시
// `<tmp>/scripts/check/relay-handshake.mjs` 경로에 만든다(직접 실행
// 감지가 경로 suffix를 보므로, 아무 이름으로 두면 CLI 블록이 아예 안
// 돌아 「거짓 RED」가 된다 -- coder-task.md §2 비타협 #4). 치환이 정확히
// 1회 매치됨을 먼저 단언한다(0회·2회 이상은 skip이 아니라 실패 --
// §2 비타협 #5). 작성 시점부터 skip 0(§2 비타협 #6): 이 파일은 이미
// 추적본에 있는 relay-handshake.mjs를 변조하므로 커밋 후 해제에
// 의존하지 않는다.
// ---------------------------------------------------------------------------
const RELAY_HANDSHAKE_SRC = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/relay-handshake.mjs"],
  { encoding: "utf8" },
);

// HYK-183: relay-handshake.mjs now imports "./reject-streak.mjs" (the
// auto-record wiring), so a mutant written ALONE into a fresh scripts/check
// dir fails to even load (MODULE_NOT_FOUND) -- these M1-M3 mutations exist
// to probe relay-handshake.mjs's own CLI arg-parsing/exit-code contract,
// not reject-streak.mjs, so the real (unmutated) sibling module is copied
// alongside every mutant to keep the relative import resolvable.
const REJECT_STREAK_SRC = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/reject-streak.mjs"],
  { encoding: "utf8" },
);

// HYK-204: relay-handshake.mjs now also imports "./envelope-archive.mjs"
// (round preservation) -- same MODULE_NOT_FOUND risk reject-streak.mjs's
// comment above already documents, now for a second sibling.
const ENVELOPE_ARCHIVE_SRC = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/envelope-archive.mjs"],
  { encoding: "utf8" },
);

// HYK-186: relay-handshake.mjs now also imports "./time-authority.mjs" (the
// future-skew registry) -- same MODULE_NOT_FOUND risk the two siblings above
// already document, now for a third.
const TIME_AUTHORITY_SRC = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/time-authority.mjs"],
  { encoding: "utf8" },
);

// HYK-430 5R: relay-handshake.mjs now also statically imports
// "./child-probe-timeout-policy.mjs" (the polled-fallback removal) -- same
// MODULE_NOT_FOUND risk the three siblings above already document, now for
// a fourth.
const CHILD_PROBE_TIMEOUT_POLICY_SRC = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/child-probe-timeout-policy.mjs"],
  { encoding: "utf8" },
);

function writeMutantCli(mutatedSrc) {
  const rootDir = mkdtempSync(join(tmpdir(), "relay-handshake-mutant-"));
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  const mutantPath = join(scriptsCheckDir, "relay-handshake.mjs");
  writeFileSync(mutantPath, mutatedSrc, "utf8");
  writeFileSync(
    join(scriptsCheckDir, "reject-streak.mjs"),
    REJECT_STREAK_SRC,
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "envelope-archive.mjs"),
    ENVELOPE_ARCHIVE_SRC,
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "time-authority.mjs"),
    TIME_AUTHORITY_SRC,
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "child-probe-timeout-policy.mjs"),
    CHILD_PROBE_TIMEOUT_POLICY_SRC,
    "utf8",
  );
  return { rootDir, mutantPath };
}

function runMutantCli(mutantPath, args, opts = {}) {
  const res = spawnSync(process.execPath, [mutantPath, ...args], {
    encoding: "utf8",
    ...opts,
  });
  if (res.error) {
    assert.fail(
      `mutant child process failed to spawn (infra failure, not a mutation signal): ${res.error.message}`,
    );
  }
  if (res.status === null) {
    assert.fail(
      `mutant child process terminated by signal ${res.signal} (infra failure, not a mutation signal)`,
    );
  }
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the source (found ${count}) -- 0 or 2+ is a test failure, not a skip`,
  );
}

// HYK-189 재작업 1R (coder-task.md §9): M1/M2 둘 다 harnessDir을 넘기지
// 않고 checkRelayHandshake({role})만 호출하는 경로를 거친다 -- 그때
// relay-handshake.mjs 자신의 기본값 `join(repoRoot(), ".harness")`가
// 발동하고, `repoRoot()`는 인자 없는 `git rev-parse --show-toplevel`을
// (자식 프로세스 자신의) cwd 기준으로 실행한다. 이 자식 프로세스에
// 명시적 `cwd`를 안 주면 부모(테스트 러너)의 cwd를 물려받아 **이
// 워크트리의 진짜 `.harness/`**를 읽게 된다 -- ORCH가 실측한 바로 그
// flaky의 원인(그 순간 실제 `.harness/coder.md`가 유효한 handshake였다).
// `cwd`를 os 임시 디렉터리 아래 새 mkdtemp 루트로 고정하면 그 루트는
// 어떤 git 워크트리에도 속하지 않으므로 `git rev-parse --show-toplevel`가
// 실패하고 `repoRoot()`는 catch로 그 임시 루트 자체를 반환한다 -- 그
// 결과 "기본값"이 이 시험이 통제하는 `<sandbox>/.harness`가 되어 실제
// 저장소 상태와 완전히 분리된다(§2 비타협 #3 "mkdtemp 안에서만"의 정신).
function makeSandboxRoot({ seedValidDefaultHandshake = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "relay-handshake-sandbox-"));
  if (seedValidDefaultHandshake) {
    const harnessDir = join(root, ".harness");
    mkdirSync(harnessDir, { recursive: true });
    writeValidFixture(harnessDir, "coder", "SANDBOX-AMBIENT-DEFAULT");
  }
  return root;
}

test("HYK-189 (e) mutation M1: removing the no-arg usage guard -> the exact usage-string contract breaks (RED signal; proves the guard is load-bearing), hermetic (cwd pinned off the real repo)", () => {
  const target =
    '  if (!role) {\n    console.error("usage: node relay-handshake.mjs <role> [harnessDir]");\n    process.exit(1);\n  }\n';
  assertExactlyOneMatch(RELAY_HANDSHAKE_SRC, target, "M1 usage guard");
  const mutated = RELAY_HANDSHAKE_SRC.replace(target, "");
  const { rootDir, mutantPath } = writeMutantCli(mutated);
  const sandboxRoot = makeSandboxRoot();
  try {
    const { exit, stderr } = runMutantCli(mutantPath, [], {
      cwd: sandboxRoot,
    });
    assert.equal(
      exit,
      1,
      "mutant still exits 1 (falls through to the generic path-not-found branch)",
    );
    assert.notEqual(
      stderr.trim(),
      USAGE_MESSAGE,
      "mutant must NOT produce the exact usage string anymore -- RED signal proving the (a) contract's usage guard is load-bearing",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

// 재작업 1R: 이 시험은 원래 "override 없는 임시 픽스처 + exit !== 0"으로
// M2를 단언했으나, 그 실패 신호가 방어가 아니라 "그 순간 이 워크트리의
// 실제 .harness/에 무엇이 있었는가"에서 나왔다(§9 ORCH 실측 -- 코더가
// 방금 쓴 .harness/coder.md가 유효한 handshake라 mutant가 우연히
// exit 0으로 «성공»해 단언이 깨졌다). 아래는 두 가지로 고쳤다:
// (1) cwd를 makeSandboxRoot()로 고정해 실제 저장소를 절대 건드리지
//     않는다(hermetic). (2) 결과를 "exit !== 0"이라는 느슨한 값이 아니라
//     "override 픽스처를 실제로 읽었는가"라는 더 강한 신호로 바꿨다 --
//     override 픽스처는 의도적으로 mismatch시켜, 올바른 구현이라면 ambient
//     상태와 무관하게 항상 "handshake mismatch"로 exit 1이어야 한다는
//     불변량을 먼저 real(비변조) CLI로 확인한 뒤, mutant가 그 불변량을
//     깨는지 본다. ambient 기본 위치를 "없음"과 "유효한 handshake로
//     시딩"이라는 두 조건 모두에서 반복해, «주변 상태가 있든 없든 같은
//     결함이 드러난다»는 것 자체를 시험으로 고정한다(§9 항목 3).
test("HYK-189 (e) mutation M2: removing the second positional arg (harnessDir override) -> a valid fixture in a custom dir is no longer honored (RED signal; proves passing harnessDirArg is load-bearing), hermetic and invariant across ambient-default state", () => {
  const target =
    '  const harnessDirArg = process.argv[3];\n  // HYK-387 3R (자체 발견 결함 수리): 이 블록은 2R까지 `dispatchLedgerPath`\n  // 를 자기 스스로 `process.env`에서 읽어 명시로 넘겼다 -- 그런데\n  // `checkRelayHandshake`/`resolveDispatchRecordExistence` 자신이 이제\n  // 같은 env(+포인터 파일)를 «자기 안에서» 이미 읽는다(위 헤더 참조).\n  // 명시로 넘기면(비록 그 값이 "env를 그대로 읽어온 것"이어도)\n  // `resolveDispatchLedgerPath`의 `explicit !== undefined` 분기가 즉시\n  // 그 값을 채택해 버려, 코어 함수 자신의 env/포인터파일 fallback\n  // 경로가 CLI를 통해서는 «한 번도 실행되지 않는» 사각을 만든다(3R\n  // 작업 중 실측: 이 사각 때문에 되돌림 변이 hyk387-11이 fallback을\n  // 실제로 무력화해도 CLI 경로에서는 그 무력화가 전혀 드러나지\n  // 않았다 -- 이 줄 자체가 그 무력화를 우회하는 별도 경로였던 것).\n  // 이 줄을 지워 CLI도 다른 모든 실 호출자와 완전히 같은 모양\n  // (`{role, harnessDir}`, dispatchLedgerPath 키 자체를 안 넘김)으로\n  // 부르게 한다 -- 이제 CLI 경로도 코어 함수의 fallback을 실제로 타고,\n  // 그 fallback을 무력화하면 CLI 경로에서도 정직하게 드러난다.\n  const result = harnessDirArg\n    ? checkRelayHandshake({ role, harnessDir: harnessDirArg })\n    : checkRelayHandshake({ role });\n'; // exact-copy anchor rebuilt from source (3R)
  assertExactlyOneMatch(
    RELAY_HANDSHAKE_SRC,
    target,
    "M2 harnessDir passthrough",
  );
  const mutated = RELAY_HANDSHAKE_SRC.replace(
    target,
    "  const result = checkRelayHandshake({ role });\n",
  );
  const { rootDir, mutantPath } = writeMutantCli(mutated);
  try {
    for (const seedAmbient of [false, true]) {
      const sandboxRoot = makeSandboxRoot({
        seedValidDefaultHandshake: seedAmbient,
      });
      try {
        withFixtureDirCli((overrideDir) => {
          // override 픽스처는 의도적으로 mismatch -- 올바르게 override를
          // 읽는 구현이라면 항상 "handshake mismatch"로 exit 1이어야 한다.
          writeFileSync(
            join(overrideDir, "coder-task.md"),
            "task_id: OVERRIDE-REAL\ndropped_at: 2026-08-03 06:00 KST\n",
            "utf8",
          );
          writeFileSync(
            join(overrideDir, "coder.md"),
            "task_id: OVERRIDE-DIFFERENT\n\n>>> DONE: CODER @ 2026-08-03 06:10 KST\n",
            "utf8",
          );

          // 불변량 선확인: 변조 안 된 실제 CLI는 ambient 상태(seedAmbient)와
          // 무관하게 override를 읽어 항상 동일하게 실패해야 한다.
          const real = runCli(["coder", overrideDir], { cwd: sandboxRoot });
          assert.equal(
            real.exit,
            1,
            `real CLI must always honor the override and reject the mismatched fixture regardless of ambient default state (seedAmbient=${seedAmbient})`,
          );
          assert.match(
            real.stderr,
            /handshake mismatch/,
            `real CLI's failure reason must come from the override fixture's mismatch, not ambient state (seedAmbient=${seedAmbient})`,
          );

          // mutant: harnessDirArg를 무시하므로 sandboxRoot/.harness(ambient)를
          // 본다 -- ambient 유무에 따라 다른 이유로 불변량이 깨지는 것 자체가
          // "override가 전혀 읽히지 않았다"는 증거다.
          const mutant = runMutantCli(mutantPath, ["coder", overrideDir], {
            cwd: sandboxRoot,
          });
          if (seedAmbient) {
            assert.equal(
              mutant.exit,
              0,
              `mutant reads the seeded ambient default (a valid, unrelated handshake) instead of the override -- RED signal (seedAmbient=${seedAmbient})`,
            );
          } else {
            assert.equal(
              mutant.exit,
              1,
              `mutant still exits 1 here, but for the wrong reason (seedAmbient=${seedAmbient})`,
            );
            assert.doesNotMatch(
              mutant.stderr,
              /handshake mismatch/,
              `mutant's exit 1 must come from "task file not found" in the absent ambient default, NOT from ever reading the override's mismatch -- proves the override was never consulted (seedAmbient=${seedAmbient})`,
            );
          }
        });
      } finally {
        rmSync(sandboxRoot, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// HYK-344 2R (코더 자신의 실측 재작업 -- 최초 구현은 err.status===정수 여부로
// "attempted && failed"를 판정했다가, 이 바로 그 시나리오(격리 픽스처에
// admission-completion-adapter.mjs가 없음 -- writeMutantCli가 그 파일을
// 사이드카로 복사하지 않는다)에서 Node 자신의 MODULE_NOT_FOUND도 exit 1을
// 낸다는 사실(HYK-189 (h)가 이미 고정한 바로 그 함정)에 걸려 «어댑터 파일이
// 없을 뿐인» 무해한 격리 픽스처 갭까지 exit 3으로 오분류했다 -- 로컬 재현
// 즉시 잡혀 stderr 모양 기반 판정으로 교체했다. 이 시험이 없으면 그 회귀가
// 조용히 재발할 수 있다(§8의 세 정본 시험 어느 것도 "어댑터 파일이 실제로
// 없는" 시나리오를 지나가지 않는다 -- 전부 실제 ledger + 실제 adapter
// 파일이 있는 경로만 쓴다).
test("HYK-344 2R 회귀: admission-completion-adapter.mjs가 격리 픽스처에 아예 없으면(Node MODULE_NOT_FOUND, exit 1 공유) -- exit 3(attempted+실패)으로 오분류하지 않는다, exit 0 그대로", () => {
  const { rootDir, mutantPath } = writeMutantCli(RELAY_HANDSHAKE_SRC); // 무변조 사본 -- writeMutantCli 자체가 admission-completion-adapter.mjs를 사이드카로 복사하지 않는다
  try {
    withFixtureDirCli((dir) => {
      writeValidFixture(dir, "coder", "HYK-344-missing-adapter-1");
      const { exit, stdout, stderr } = runMutantCli(mutantPath, ["coder", dir]);
      assert.equal(
        exit,
        0,
        `a genuinely-absent adapter sibling file must stay the pre-existing harmless no-op (exit 0), not be misread as an attempted-and-failed completion (exit 3)\nstdout=${stdout}\nstderr=${stderr}`,
      );
      assert.doesNotMatch(
        stderr,
        /exiting 3/,
        "MODULE_NOT_FOUND from a missing sibling file must never route through the exit-3 channel",
      );
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// HYK-353 §3-3: mirrors the HYK-344 2R regression right above it, one level
// down -- writeMutantCli never copies first-observation.mjs as a sidecar
// either, so a genuinely-absent first-observation.mjs (isolated fixture gap,
// not a real spawn failure) must stay the pre-existing harmless exit 0, not
// be misread as an attempted-and-failed first-observation recording.
test("HYK-353: first-observation.mjs가 격리 픽스처에 아예 없으면(Node MODULE_NOT_FOUND) -- exit 3으로 오분류하지 않는다, exit 0 그대로", () => {
  const { rootDir, mutantPath } = writeMutantCli(RELAY_HANDSHAKE_SRC); // 무변조 사본 -- writeMutantCli는 first-observation.mjs를 사이드카로 복사하지 않는다
  try {
    withFixtureDirCli((dir) => {
      writeValidFixture(dir, "coder", "HYK-353-missing-first-observation-1");
      const { exit, stdout, stderr } = runMutantCli(mutantPath, ["coder", dir]);
      assert.equal(
        exit,
        0,
        `a genuinely-absent first-observation.mjs sibling file must stay the pre-existing harmless no-op (exit 0), not be misread as an attempted-and-failed recording (exit 3)\nstdout=${stdout}\nstderr=${stderr}`,
      );
      assert.doesNotMatch(
        stderr,
        /first-observation recording FAILED/,
        "MODULE_NOT_FOUND from a missing sibling file must never route through the exit-3 channel",
      );
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// HYK-353 §3-3: the positive case -- first-observation.mjs sidecar IS
// present but genuinely fails on its own (a real defect, not a fixture
// gap). Proves the round's own verdict stays ok:true (§3-3's "라운드
// 합격/불합격 신호를 부수적 기록 실패와 뒤섞지 마라" honored) while the CLI
// exit code still surfaces the failure distinctly (exit 3, same channel as
// HYK-344's admission-completion sibling) instead of folding it into a
// silent exit 0 (the exact HYK-353 실사고 shape this task closes).
test("HYK-353: first-observation.mjs가 존재하지만 실제로 실패하면 -- 라운드는 ok:true 그대로, CLI는 exit 3으로 구별해 드러낸다", () => {
  const { rootDir, mutantPath } = writeMutantCli(RELAY_HANDSHAKE_SRC);
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  // A first-observation.mjs stand-in that always fails with a stable,
  // self-identifying "first-observation: " prefix -- exactly the shape a
  // genuine failure inside the real file would produce (usage guard /
  // payload-not-parseable / stdin-read failure all share this prefix, see
  // spawnObserveDoneLine's own header comment).
  writeFileSync(
    join(scriptsCheckDir, "first-observation.mjs"),
    "console.error('first-observation: forced failure for HYK-353 test'); process.exit(1);\n",
    "utf8",
  );
  try {
    withFixtureDirCli((dir) => {
      writeValidFixture(dir, "coder", "HYK-353-genuine-failure-1");
      const { exit, stdout, stderr } = runMutantCli(mutantPath, ["coder", dir]);
      assert.equal(
        exit,
        3,
        `a genuine first-observation failure must exit 3 (distinct from 0/1), not be silently folded into exit 0\nstdout=${stdout}\nstderr=${stderr}`,
      );
      assert.match(
        stderr,
        /first-observation recording FAILED/,
        "exit 3 must be traceable to the first-observation channel specifically, not just any nonzero exit",
      );
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// HYK-353 2R §1 (P1-1, 검토 반려): the real first-observation.mjs sidecar is
// copied alongside the mutant relay-handshake.mjs (writeMutantCli's default
// siblings don't include it) so this test exercises the ACTUAL write-failure
// detection path (recordFirstDoneObservation's own catch -> observeDoneLine's
// `record` field -> spawnObserveDoneLine's `recordFailed` check), not a
// stand-in. Making the observation log PATH a directory (appendFileSync
// throws EISDIR) reproduces 검토자의 정확한 재현: the child process still
// exits 0 with well-formed JSON, and only the NEW `record.reason` field lets
// the parent tell "wrote nothing" apart from "wrote successfully".
const FIRST_OBSERVATION_SRC = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/first-observation.mjs"],
  { encoding: "utf8" },
);

test("HYK-353 2R: 관측 로그 경로가 디렉터리라서 쓰기 자체가 실패하면 -- 자식이 exit 0으로 JSON을 돌려줘도 exit 3으로 구별해 드러낸다 (P1-1)", () => {
  const { rootDir, mutantPath } = writeMutantCli(RELAY_HANDSHAKE_SRC);
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  writeFileSync(
    join(scriptsCheckDir, "first-observation.mjs"),
    FIRST_OBSERVATION_SRC,
    "utf8",
  );
  try {
    withFixtureDirCli((dir) => {
      writeValidFixture(dir, "coder", "HYK-353-2R-write-failure-1");
      // Make the observation log's own path a directory -- appendFileSync
      // inside recordFirstDoneObservation throws (EISDIR), caught internally
      // and returned as {recorded:false, reason:"record failed: ..."}.
      mkdirSync(join(dir, "coder-done-first-observation.jsonl"));
      const { exit, stdout, stderr } = runMutantCli(mutantPath, ["coder", dir]);
      assert.equal(
        exit,
        3,
        `an observation-log write failure must exit 3, not the pre-2R silent exit 0\nstdout=${stdout}\nstderr=${stderr}`,
      );
      assert.match(
        stderr,
        /first-observation recording FAILED even though the child process exited cleanly/,
      );
      assert.match(stderr, /record failed:/);
      assert.ok(
        existsSync(join(dir, "coder-done-first-observation.jsonl")),
        "the directory-shaped log path must be left untouched, not silently replaced",
      );
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("HYK-189 (e) mutation M3: removing non-zero exit propagation on failure -> a blocked handshake wrongly reports success (RED signal; proves exit-code propagation is load-bearing)", () => {
  const target =
    "  if (result.ok) {\n    process.exit(0);\n  } else {\n    console.error(result.reason);\n    process.exit(1);\n  }\n";
  assertExactlyOneMatch(RELAY_HANDSHAKE_SRC, target, "M3 non-zero propagation");
  const mutated = RELAY_HANDSHAKE_SRC.replace(
    target,
    "  if (result.ok) {\n    process.exit(0);\n  } else {\n    console.error(result.reason);\n    process.exit(0);\n  }\n",
  );
  const { rootDir, mutantPath } = writeMutantCli(mutated);
  try {
    withFixtureDirCli((dir) => {
      // task_id 불일치 -> 실제 CLI라면 exit 1이어야 하는 명백한 계약
      // 위반 사례.
      writeFileSync(
        join(dir, "coder-task.md"),
        "task_id: HYK-189-real\ndropped_at: 2026-08-03 06:00 KST\n",
        "utf8",
      );
      writeFileSync(
        join(dir, "coder.md"),
        "task_id: HYK-189-different\n\n>>> DONE: CODER @ 2026-08-03 06:10 KST\n",
        "utf8",
      );
      const { exit } = runMutantCli(mutantPath, ["coder", dir]);
      assert.equal(
        exit,
        0,
        "mutant wrongly reports success (exit 0) for a blocked handshake -- RED signal proving non-zero exit propagation is load-bearing",
      );
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-189 §완료조건 (h): 자식 프로세스 실패(status===null·spawn error·
// timeout)는 계약 위반과 구별해 fail-closed 처리한다. runCli/runMutantCli
// 둘 다 이미 그 구분을 assert.fail로 명시한다(위 정의 참조) -- 여기서는
// 그 fail-closed 경로가 실제로 발동함을 존재하지 않는 스크립트 경로로
// 직접 확인한다(spawn 자체는 성공하지만 대상 파일이 없어 Node가 즉시
// 비정상 종료하는 경우까지 규정한다).
// ---------------------------------------------------------------------------
test("HYK-189 (h) CLI: spawning a nonexistent script path exits 1 too, but must not be misread as a legitimate handshake failure -- distinguishable only by stderr shape, not exit code", () => {
  const bogusPath = join(tmpdir(), "relay-handshake-does-not-exist.mjs");
  const res = spawnSync(process.execPath, [bogusPath], { encoding: "utf8" });
  assert.equal(
    res.error,
    undefined,
    "spawnSync itself starts node fine here (ENOENT-class spawn failures are the separate res.error/res.status===null case runCli/runMutantCli already fail-close on above)",
  );
  // This is the crux of (h): Node's own 'module not found' failure also
  // exits with status 1 -- textually indistinguishable from the CLI's own
  // legitimate exit(1) by exit code alone. Only the stderr SHAPE tells them
  // apart: Node's loader error never matches the usage string (a) or the
  // relay-handshake `reason` sentences (b)/(c)/(e) assert on. A naive
  // "exit === 1 -> handshake blocked" reading of this process's output
  // would wrongly count "the script wasn't even found" as "the handshake
  // contract was violated."
  assert.equal(
    res.status,
    1,
    "Node's module-not-found failure happens to share the CLI's own exit(1) code",
  );
  assert.doesNotMatch(
    res.stderr,
    /^task file not found|^result file not found|^usage: node relay-handshake\.mjs/m,
    "Node's own loader error must not be confused with any of relay-handshake.mjs's own error/usage strings",
  );
  assert.match(
    res.stderr,
    /Cannot find module|MODULE_NOT_FOUND/,
    "this exit(1) is Node failing to even load the script, not relay-handshake's own contract logic running",
  );
});

// ---------------------------------------------------------------------------
// HYK-186 §2 완료조건4/6: future-skew upper bound -- boundary values + a
// fixed 0/N normal-control battery. All in-process via the injectable `now`
// param (production default is Date.now(); the CLI never overrides it -- see
// hyk186-time-authority-mutation.test.mjs mutation 2 for the CLI-level E2E
// repro of the ★PM 실측 case).
// ---------------------------------------------------------------------------
import { MAX_FUTURE_SKEW_MS } from "./time-authority.mjs";

const FIXED_NOW = Date.parse("2026-08-09T05:00:00Z"); // 2026-08-09 14:00 KST

function isoKst(ms) {
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())} KST`;
}

test("HYK-186 (경계) DONE exactly AT now+skew -> still ok (boundary itself is not a violation)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      `task_id: HYK-1\n\n>>> DONE: CODER @ ${isoKst(FIXED_NOW + MAX_FUTURE_SKEW_MS)}\ndone_stamped_by: finalize-done\n`,
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, true, "exactly at the boundary must pass");
  });
});

test("HYK-186 (경계, ★반례) DONE one unit (1 minute, the header's own precision floor) past now+skew -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      `task_id: HYK-1\n\n>>> DONE: CODER @ ${isoKst(FIXED_NOW + MAX_FUTURE_SKEW_MS + 60_000)}\ndone_stamped_by: finalize-done\n`,
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "FUTURE_DONE");
    assert.match(result.reason, /ahead of authority now/);
  });
});

test("HYK-186 (경계) dropped_at itself beyond now+skew -> blocked with FUTURE_DROPPED_AT, independent of any result content", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      `task_id: HYK-1\ndropped_at: ${isoKst(FIXED_NOW + MAX_FUTURE_SKEW_MS + 60_000).replace(/:\d\d KST/, " KST")}\n`,
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "FUTURE_DROPPED_AT");
  });
});

test("HYK-186 (★PM 실측 in-process repro): dropped_at=2026-07-31 03:00 / DONE=2099-01-01 00:00 -> now ok:false FUTURE_DONE (was ok:true before this fix)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: FUTURE-1\ndropped_at: 2026-07-31 03:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: FUTURE-1\n\n>>> DONE: CODER @ 2099-01-01 00:00:00 KST\ndone_stamped_by: finalize-done\n",
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: Date.parse("2026-07-31T03:05:00+09:00"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "FUTURE_DONE");
  });
});

// 완료조건6: 정상 대조군 N건, 오탐 0/N. N=6, spanning: far in the past, just
// past dropped_at, several minutes ago, exactly `now`, and both boundary
// values already covered above (counted separately as boundary tests, not
// folded into this N to keep the two categories distinguishable per §8).
const NORMAL_CONTROL_SAMPLES = [
  { label: "far in the past", doneOffsetMs: -1000 * 60 * 60 * 24 * 30 },
  { label: "1 hour ago", doneOffsetMs: -1000 * 60 * 60 },
  { label: "1 minute ago", doneOffsetMs: -60_000 },
  { label: "exactly now", doneOffsetMs: 0 },
  {
    label: "10 seconds in the future (sub-minute, floors to now's minute)",
    doneOffsetMs: 10_000,
  },
  {
    label: "1 minute inside the skew allowance",
    doneOffsetMs: MAX_FUTURE_SKEW_MS - 60_000,
  },
];

test(`HYK-186 완료조건6: normal control battery, N=${NORMAL_CONTROL_SAMPLES.length}, 오탐 0/${NORMAL_CONTROL_SAMPLES.length}`, () => {
  let falsePositives = 0;
  for (const sample of NORMAL_CONTROL_SAMPLES) {
    withFixtureDir((dir) => {
      // dropped_at is always well before every sample's DONE offset (the
      // most negative sample here is -30 days) so this battery exercises
      // ONLY the future-skew axis, never the pre-existing stale-result axis.
      writeTask(
        dir,
        "coder",
        "task_id: HYK-1\ndropped_at: 2026-01-01 00:00 KST\n",
      );
      writeResult(
        dir,
        "coder",
        `task_id: HYK-1\n\n>>> DONE: CODER @ ${isoKst(FIXED_NOW + sample.doneOffsetMs)}\ndone_stamped_by: finalize-done\n`,
      );
      const result = checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW,
      });
      if (!result.ok) {
        falsePositives += 1;
        assert.fail(
          `false positive on sample '${sample.label}': ${result.reason}`,
        );
      }
    });
  }
  assert.equal(
    falsePositives,
    0,
    `오탐 ${falsePositives}/${NORMAL_CONTROL_SAMPLES.length}`,
  );
});

// ---------------------------------------------------------------------------
// HYK-244 2R-ci-1 §3: Windows에서도 잡히는 문자열 수준 시험.
//
// 원인(CI `enforce` 잡 실측, not ok 224): checkRelayHandshake가 라이브
// task/result 파일 경로를 `${role}-task.md`/`${role}.md`로 만드는데,
// role이 대문자("CODER")로 넘어오면(2R-b 결선 이후 실제 생산 관례) 경로도
// "CODER-task.md"가 된다. 이 워크트리의 실제 관례(dispatch-worker.ps1
// 166/260행 `$Role.ToLower()`, `ls .harness/*.md`로 직접 확인)는 항상
// 소문자 파일명이라 Linux(대소문자 구별)에서는 파일을 못 찾는다.
// Windows는 파일시스템이 대소문자를 구별하지 않아 이 결함을 원리적으로
// 못 잡는다 -- 그래서 파일 존재 여부가 아니라 "join이 만드는 문자열
// 자체"를 단언한다(파일시스템 동작에 기대지 않음).
// ---------------------------------------------------------------------------

test("HYK-244 2R-ci-1: resolveLiveRoundFilePaths는 role 대소문자와 무관하게 항상 소문자 파일명 문자열을 낸다(문자열 수준, OS 무관)", () => {
  const dir = "/fixture-root"; // 실존 여부와 무관 -- 순수 문자열 join만 검사.
  for (const role of ["CODER", "coder", "CoDeR", "REVIEW", "review"]) {
    const { taskPath, resultPath } = resolveLiveRoundFilePaths(role, dir);
    assert.match(
      taskPath.replace(/\\/g, "/"),
      /\/[a-z]+-task\.md$/,
      `role='${role}': taskPath('${taskPath}')는 소문자 파일명으로 끝나야 한다`,
    );
    assert.match(
      resultPath.replace(/\\/g, "/"),
      /\/[a-z]+\.md$/,
      `role='${role}': resultPath('${resultPath}')는 소문자 파일명으로 끝나야 한다`,
    );
    assert.equal(
      taskPath.replace(/\\/g, "/"),
      `${dir}/${role.toLowerCase()}-task.md`,
      `role='${role}': taskPath는 정확히 소문자화된 role로 만든 경로여야 한다`,
    );
    assert.equal(
      resultPath.replace(/\\/g, "/"),
      `${dir}/${role.toLowerCase()}.md`,
      `role='${role}': resultPath는 정확히 소문자화된 role로 만든 경로여야 한다`,
    );
  }
});

test("HYK-244 2R-ci-1 RED(변이, 필수): 경로 조립에서 소문자화를 제거하면 대문자 role일 때 문자열 시험이 실제로 실패한다(이 시험이 load-bearing임을 증명, 파일시스템 동작 무관)", async () => {
  const src = readFileSync(
    fileURLToPath(new URL("./relay-handshake.mjs", import.meta.url)),
    "utf8",
  );
  const target = "  const roleForPath = String(role).toLowerCase();\n";
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target must appear exactly once (found ${count})`,
  );
  // 소문자화를 제거 -- role을 가공 없이 그대로 쓰게 되돌린다(결함 재현).
  const mutated = src.replace(target, "  const roleForPath = role;\n");

  const mutDir = mkdtempSync(join(tmpdir(), "relay-handshake-ci-mut-"));
  try {
    // relay-handshake.mjs 자신이 형제 모듈(reject-streak.mjs·
    // envelope-archive.mjs·time-authority.mjs·child-probe-timeout-
    // policy.mjs)을 정적 import하므로, 동적 import가 module resolution에서
    // 성공하려면 그 사본도 같은 디렉터리에 함께 있어야 한다(이 저장소의
    // 다른 mutation 격리 픽스처들과 동일한 관례).
    const here = dirname(fileURLToPath(import.meta.url));
    for (const dep of RELAY_HANDSHAKE_STATIC_SIBLINGS) {
      writeFileSync(
        join(mutDir, dep),
        readFileSync(join(here, dep), "utf8"),
        "utf8",
      );
    }
    const mutPath = join(mutDir, "relay-handshake.mjs");
    writeFileSync(mutPath, mutated, "utf8");
    // HYK-244 ci-repair-1 §1 묶음B 수리: 원래 `return import(...).then(...)`
    // 이었다 -- 화살표 함수가 async가 아니었으므로 try 블록의 "동기적"
    // 실행은 그 Promise를 반환하는 순간 끝나고, 바로 이어지는 finally의
    // rmSync가 import()의 실제 모듈 로드(파일 읽기)가 끝나기 «전에»
    // mutDir를 지워 버리는 경쟁 조건이었다(ORCH 실측: Linux CI에서
    // ENOENT로 재현, Windows에서는 우연히 타이밍이 맞아 통과했을 뿐).
    // `await`로 바꿔 import()의 완료(그리고 아래 단언까지)가 try 블록
    // 안에서 전부 끝난 뒤에만 finally의 rmSync가 돌게 한다.
    const mod = await import(pathToFileURL(mutPath).href);
    const { taskPath } = mod.resolveLiveRoundFilePaths(
      "CODER",
      "/fixture-root",
    );
    const normalized = taskPath.replace(/\\/g, "/");
    assert.notEqual(
      normalized,
      "/fixture-root/coder-task.md",
      "RED: 소문자화를 제거하면 대문자 role일 때 경로가 더 이상 소문자 파일명이 아니어야 한다(예: /fixture-root/CODER-task.md) -- 이 시험이 그 회귀를 실제로 잡는다는 증거",
    );
    assert.equal(normalized, "/fixture-root/CODER-task.md");
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-244 ci-repair-1 §1 묶음C: wasAdmissionCompletionAttempted -- 문자열
// 수준(파일시스템/환경 무관)으로 "시도조차 안 함"과 "시도해서 실패/성공"을
// 구별하는지 직접 확인한다. admission-completion-adapter.mjs 293행이 실제로
// 찍는 문자열을 그대로 인용(추측 아님).
// ---------------------------------------------------------------------------

test("HYK-244 ci-repair-1: wasAdmissionCompletionAttempted는 adapter의 '시도조차 안 함' 출력을 attempted:false로 정확히 구별한다(문자열 수준)", () => {
  assert.equal(
    wasAdmissionCompletionAttempted(
      "admission-completion-adapter: not attempted (ADMISSION_LEDGER_PATH unset)",
    ),
    false,
    "adapter가 실제로 찍는(293행) 그 문자열 -- attempted:false로 읽혀야 한다",
  );
  assert.equal(
    wasAdmissionCompletionAttempted(
      "admission-completion-adapter: reservation 'HYK-9-1' released (changed=true)",
    ),
    true,
    "실제로 시도해서 성공한 출력 -- attempted:true로 읽혀야 한다",
  );
  assert.equal(
    wasAdmissionCompletionAttempted(""),
    true,
    "빈 출력(아직 안 읽음 등)은 '시도 안 함'으로 오판하면 안 된다 -- 안전측은 attempted:true 유지(exit 0이면 성공으로 보는 기존 관례 그대로, 이 함수는 오직 그 명시적 문자열 하나만 골라낸다)",
  );
});

// ---------------------------------------------------------------------------
// HYK-313: PENDING의 나이(age) 인지 -- 결과 파일에 DONE도 BLOCKED/
// NEEDS_INPUT 표지도 없을 때, 그 결과 파일의 fs mtime이
// PENDING_STALL_THRESHOLD_MS 이상 정지해 있으면 `state: "STALLED_PENDING"`
// 으로 표면화하고, 그 미만이면 기존과 완전히 동일한 `state: "PENDING"`을
// 낸다(§4-1 오탐 0). backdateResultMtime은 실제 fs mtime을 과거로 되돌려
// "결과 파일이 오래 전에 마지막으로 쓰였다"를 결정적으로 재현한다(엔진
// 무관 신호 -- Claude 훅/codex 세션 파일에 의존하지 않는다, §3 요건).
// ---------------------------------------------------------------------------

function backdateResultMtime(dir, role, ageMs) {
  const { resultPath } = resolveLiveRoundFilePaths(role, dir);
  const past = new Date(Date.now() - ageMs);
  utimesSync(resultPath, past, past);
}

test("HYK-313 (a) ★재현 -- DONE 없음 + 표지 없음 + 결과 파일이 임계값 이상 정지 -> state=STALLED_PENDING (미완/정지가 신호로 표면화)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-19 04:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n작업 중, 아직 보고 없음\n");
    backdateResultMtime(dir, "coder", PENDING_STALL_THRESHOLD_MS + 60_000);
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "STALLED_PENDING");
    assert.match(result.reason, /result file has not changed in/);
    assert.ok(
      result.ageMs >= PENDING_STALL_THRESHOLD_MS,
      "ageMs must reflect the actual elapsed time since the result file's last write",
    );
  });
});

test("HYK-313 (b) ★오탐 방지(가장 중요) -- DONE 없음 + 표지 없음 + 결과 파일이 방금 쓰임 -> 반환 객체가 부모 커밋(HYK-313 이전)과 «완전히 동일»(deep equal) -- ageMs 같은 새 키가 하나라도 늘면 실패", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-19 04:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n작업 중, 아직 보고 없음\n");
    // 방금 write했으므로 mtime은 실제 현재 시각과 사실상 같다 -- 되돌리지
    // 않는다(정상 진행 중인 라운드의 실제 모양 그대로).
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    // HYK-313 2R (REVIEW 반려 1 수리): state/ageMs 타입 검사만으로는 "여분의
    // 키가 새로 붙었다"는 회귀를 놓친다(1R의 실제 반려 사유) -- deepStrictEqual
    // 로 객체 전체를 부모 커밋(df2673f 이전, HYK-313 미적용)이 내던
    // `{ ok:false, state:"PENDING", reason }` 세 키와 정확히 대조한다.
    assert.deepStrictEqual(result, {
      ok: false,
      state: "PENDING",
      reason: 'result missing ">>> DONE: ... @ <time KST>" line (required)',
    });
  });
});

test("HYK-313 (c) 기존 표지 회귀 -- BLOCKED 표지가 있으면 결과 파일이 오래 정지해 있어도 state=BLOCKED 그대로(STALLED_PENDING으로 대체되지 않는다)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-19 04:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> BLOCKED: 승인 대기 중\n");
    backdateResultMtime(dir, "coder", PENDING_STALL_THRESHOLD_MS + 60_000);
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "BLOCKED");
    assert.match(result.reason, /worker reported BLOCKED: 승인 대기 중/);
  });
});

test("HYK-313 (d) 정상 소비 회귀 -- DONE 이 제대로 있으면 결과 파일이 오래 정지해 있어도(=DONE 이후 재작성 없음) ok:true 그대로", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-19 04:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nsome report body\n\n>>> DONE: CODER @ 2026-08-19 04:10:00 KST\ndone_stamped_by: finalize-done\n",
    );
    backdateResultMtime(dir, "coder", PENDING_STALL_THRESHOLD_MS + 60_000);
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("HYK-313 (e) ★RED 대조 -- 임계값을 절대 넘지 않는 나이(threshold - 1ms)는 STALLED_PENDING이 되지 않는다(경계값 회귀)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-19 04:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n작업 중\n");
    backdateResultMtime(dir, "coder", PENDING_STALL_THRESHOLD_MS - 1_000);
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "PENDING");
  });
});

// ---------------------------------------------------------------------------
// HYK-313 2R (REVIEW 반려 2 수리): (a)-(e) above are all in-process
// checkRelayHandshake() calls -- review-task §2-8's requirement (실 CLI
// 자식 프로세스의 종료코드·stderr 내용 단언) was never actually exercised
// for the new STALLED_PENDING path. These two spawn the real CLI
// (relay-handshake.mjs's own `invokedDirectly` block, same runCli helper
// the (e)/(h)/mutation-M1..M3 tests above already use) and assert on its
// actual process-boundary exit code + stderr text -- not the in-process
// return value.
// ---------------------------------------------------------------------------

test("HYK-313 2R (CLI-a) STALLED_PENDING 경로: 실 CLI 자식 프로세스 -- exit 1, stderr에 정지 사유(경과 초·임계값)가 식별 가능하게 찍힌다", () => {
  withFixtureDirCli((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-19 04:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n작업 중, 아직 보고 없음\n");
    backdateResultMtime(dir, "coder", PENDING_STALL_THRESHOLD_MS + 60_000);
    const { exit, stderr } = runCli(["coder", dir]);
    assert.equal(exit, 1);
    assert.match(
      stderr,
      /result file has not changed in \d+s/,
      "stderr must name the elapsed-seconds stall signal, not just a bare 'not done yet'",
    );
    assert.match(
      stderr,
      />= 1800s stall threshold/,
      "stderr must also name the threshold itself (PENDING_STALL_THRESHOLD_MS=30min=1800s), so a human reading stderr alone can tell this is a stall verdict, not plain pending",
    );
  });
});

test("HYK-313 2R (CLI-b) fresh PENDING 대조군: 실 CLI 자식 프로세스 -- exit 1 (동일한 실패 종료코드)이지만 stderr에 정지 표지가 «나오지 않는다» (구별 가능성 증명)", () => {
  withFixtureDirCli((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-19 04:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n작업 중, 아직 보고 없음\n");
    // 방금 write -- 되돌리지 않는다(정상 진행 중인 라운드의 실제 모양).
    const { exit, stderr } = runCli(["coder", dir]);
    assert.equal(
      exit,
      1,
      "PENDING도 여전히 ok:false이므로 exit code 자체는 STALLED_PENDING과 같다(§4-2 ok/state 계약 무변경) -- 구별은 stderr 텍스트로만 가능해야 한다",
    );
    assert.doesNotMatch(
      stderr,
      /result file has not changed in \d+s/,
      "정상 진행 중인 라운드의 stderr에 정지 표지 문구가 새어들면 오탐이다",
    );
    assert.doesNotMatch(stderr, /stall threshold/);
    assert.match(
      stderr,
      /result missing ">>> DONE/,
      "여전히 기존 PENDING 사유 문구 그대로 나와야 한다(회귀 0)",
    );
  });
});

// ---------------------------------------------------------------------------
// HYK-344 §1 (본체) -- 재현 게이트 + 수리 고정. ORCH 실측(2026-08-24 08:40):
// 원장 예약 키가 라운드 라벨과 어긋나면(dispatch-worker.ps1의 GoLabel/Task
// 폴백 어긋남 형태) 자리 반납·영수증 작성이 조용히 안 되면서도 이 CLI의
// 종료코드는 0으로 남는다. 아래 시험들은 그 세 증거를 CLI 수준(진짜 자식
// 프로세스, 격리된 원장)에서 동시에 확인하고, 수리(RESERVATION_KEY_MISMATCH
// 구별) 이후에도 종료코드 0 자체는 바뀌지 않는다는 설계 판단(HYK-224-3R §3,
// 뒤집지 않음)을 함께 고정한다 -- 대신 감사 기록(*.completion-failures.jsonl)
// 이 "어느 키가 실제로 살아있는지"를 담아, 그 파일을 읽는 자동 호출자가
// 「성공」으로 오독하지 못하게 한다.
// ---------------------------------------------------------------------------

function isolatedLedgerPaths() {
  const dir = mkdtempSync(join(tmpdir(), "hyk344-ledger-repro-"));
  return {
    dir,
    ledger: join(dir, "ledger.json"),
    lock: join(dir, "ledger.lock"),
  };
}

// HYK-344 2R (review-r1-verbatim.md §A P1): 1R은 이 시험이 "exit 0"을
// «수리 결과»로 단언했다 -- 그게 정확히 검토자가 반려한 지점이다(감사
// 파일에 프로덕션 소비자가 없어 exit 0이 여전히 "성공"으로 오독됐다). 2R은
// 같은 재현 입력에 대해 CLI 자신의 exit code가 이제 3(구별되는 값)임을
// 단언하도록 갱신한다 -- 나머지 두 증거(자리 미반납·영수증 미기록)는
// 그대로 유지(회귀 대상 아님, 검토자가 그 둘을 문제삼지 않았다).
test("HYK-344 2R 재현->수리 확인: 원장 예약 키(GoLabel 흉내)와 완료측 taskId(Task 폴백 흉내)가 어긋나면 -- (1) CLI exit code는 3(구별되는 값, 더 이상 0이 아니다), (2) 원장의 진짜 키는 반납되지 않음(ACTIVE 유지), (3) 소비 영수증은 안 써진다", () => {
  const { dir: ledgerDir, ledger, lock } = isolatedLedgerPaths();
  withFixtureDirCli((harnessDir) => {
    try {
      const GO_LABEL = "HYK-344-golabel-1";
      const TASK_FALLBACK_ID = "HYK-344-task-fallback-1";

      runAdmissionCli([
        "init-cutover",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--live-seats",
        "[]",
      ]);
      runAdmissionCli([
        "admit",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--reservation-id",
        GO_LABEL,
        "--cap",
        "1",
      ]);

      writeValidFixture(harnessDir, "coder", TASK_FALLBACK_ID);

      const { exit, stdout, stderr } = runCli(["coder", harnessDir], {
        // HYK-359 2R P1-2: `ledgerEnv` (named fields), never a hand-built
        // `env: { ...process.env, ... }` -- that shape is exactly what
        // resurrected an ambient DISPATCH_RECEIPT_PATH in 1R.
        ledgerEnv: { admissionLedgerPath: ledger, admissionLockPath: lock },
      });

      // (1) 2R: exit code is now 3 -- a distinct value from 0 (full
      // success) and 1 (round itself rejected), so an automated caller can
      // no longer read this as a clean success (coder.md §4 후보ⓐ 채택).
      assert.equal(exit, 3, `stdout=${stdout}\nstderr=${stderr}`);
      assert.match(
        stderr,
        /exiting 3.*HYK-344 2R/,
        "the distinguishing stderr line must actually be present, not just the exit code",
      );

      // (2) the REAL reservation (GO_LABEL) is still ACTIVE -- the slot was
      // never released, even though the CLI reported exit 0.
      const ledgerRaw = JSON.parse(readFileSync(ledger, "utf8"));
      assert.equal(ledgerRaw.reservations[GO_LABEL].status, "ACTIVE");

      // (3) no consumption receipt was written (admissionReturned stayed
      // false -- "부분 성공은 성공 영수증이 아니다").
      const receiptDir = join(harnessDir, "receipts");
      assert.equal(
        existsSync(receiptDir),
        false,
        "consumption receipt directory must not exist -- receipt was never written",
      );

      // Bonus (수리 고정): the audit trail must distinguish this as a key
      // MISMATCH (a real reservation exists, just under a different key),
      // not a bare "not found" -- and must name the real key.
      const auditPath = `${ledger}.completion-failures.jsonl`;
      assert.ok(existsSync(auditPath));
      const lines = readFileSync(auditPath, "utf8").trim().split("\n");
      const record = JSON.parse(lines[lines.length - 1]);
      assert.equal(record.reservationId, TASK_FALLBACK_ID);
      assert.equal(record.reasonCode, "RESERVATION_KEY_MISMATCH");
      assert.equal(record.candidates.length, 1);
      assert.equal(record.candidates[0].reservationId, GO_LABEL);
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });
});

test("HYK-344 정상 경로 회귀 0: 원장 예약 키와 완료측 taskId가 일치하면 -- exit 0, 원장 자리는 실제로 반납(COMPLETED), 소비 영수증이 실제로 써진다", () => {
  const { dir: ledgerDir, ledger, lock } = isolatedLedgerPaths();
  withFixtureDirCli((harnessDir) => {
    try {
      const MATCHING_ID = "HYK-344-matching-1";

      runAdmissionCli([
        "init-cutover",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--live-seats",
        "[]",
      ]);
      runAdmissionCli([
        "admit",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--reservation-id",
        MATCHING_ID,
        "--cap",
        "1",
      ]);

      writeValidFixture(harnessDir, "coder", MATCHING_ID);

      const { exit, stdout, stderr } = runCli(["coder", harnessDir], {
        // HYK-359 2R P1-2: same fix as the sibling mutation test above.
        ledgerEnv: { admissionLedgerPath: ledger, admissionLockPath: lock },
      });
      assert.equal(exit, 0, `stdout=${stdout}\nstderr=${stderr}`);

      const ledgerRaw = JSON.parse(readFileSync(ledger, "utf8"));
      assert.equal(
        ledgerRaw.reservations[MATCHING_ID].status,
        "COMPLETED",
        "matching-key completion must actually release the slot",
      );

      const receiptDir = join(harnessDir, "receipts");
      assert.equal(
        existsSync(receiptDir),
        true,
        "matching-key completion must actually write a consumption receipt",
      );

      const auditPath = `${ledger}.completion-failures.jsonl`;
      assert.equal(
        existsSync(auditPath),
        false,
        "a successful matching-key completion must not write a failure-audit record",
      );
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });
});

// HYK-344 2R §4 후보ⓐ 정직 한계 고정: ADMISSION_LEDGER_PATH가 아예 미설정인
// 기존(HYK-224 1R 이전부터의) 배포는 "not attempted"이지 "attempted+실패"가
// 아니다 -- 이 시험은 그 harmless 갭이 새 exit 3으로 잘못 넘어가지 않는지
// 고정한다(그랬다면 ADMISSION_LEDGER_PATH를 아예 안 쓰는 모든 기존 호출자가
// 이번 라운드로 갑자기 exit 3을 받는 회귀가 됐을 것).
test("HYK-344 2R 정직 한계 회귀: ADMISSION_LEDGER_PATH가 아예 미설정이면(=not attempted) exit는 여전히 0 -- attempted+실패(exit 3)와 혼동하지 않는다", () => {
  withFixtureDirCli((harnessDir) => {
    const NO_LEDGER_ID = "HYK-344-no-ledger-1";
    writeValidFixture(harnessDir, "coder", NO_LEDGER_ID);

    const env = { ...process.env };
    delete env.ADMISSION_LEDGER_PATH;
    delete env.ADMISSION_LOCK_PATH;
    const { exit, stdout, stderr } = runCli(["coder", harnessDir], { env });

    assert.equal(exit, 0, `stdout=${stdout}\nstderr=${stderr}`);
    assert.doesNotMatch(
      stderr,
      /exiting 3/,
      "the not-attempted gap must never be reported through the exit-3 channel",
    );
  });
});

// ---------------------------------------------------------------------------
// HYK-344 3R §2-2: "지금은 사람이 유일한 호출자다"를 시험으로 고정한다 --
// 검토 원문(review-r2-verbatim.md §A P1)이 확인한 바 그대로, 이 저장소
// 안에서 relay-handshake.mjs의 CLI를 실제로 자식 프로세스로 «실행»하는
// 프로덕션 경로가 0건이다(관제실 dispatch-worker.ps1도 배달만 하지 이
// CLI를 부르지 않는다 -- 그건 이 저장소 밖 파일이라 CI가 닿을 수 없으므로
// 이 시험의 범위 밖이며, 결과 파일에 «수동 확인, 자동 고정 아님»으로
// 명시한다). ⛔주석/문서 문자열만 보는 시험이면 안 된다는 요구(coder-task
// §2-2) 그대로, 이 시험은 저장소 소스 파일을 실제로 읽어 스캔한다.
//
// 방법: scripts/ 아래 모든 *.mjs 파일(테스트 파일과 relay-handshake.mjs
// 자기 자신은 제외 -- 아래 이유)에서, 주석을 벗겨낸 뒤 남는 텍스트에
// 따옴표로 감싼 리터럴 "relay-handshake.mjs" 문자열이 있는지 찾는다.
// 그런 리터럴이 프로덕션 코드에 있어야 할 유일한 이유는 그 파일 경로를
// 조립해 실행(spawn)하려는 것뿐이다(이 저장소의 기존 관례 -- 예:
// admission-completion-adapter.mjs를 스폰하는 코드가 정확히 이 모양으로
// "admission-completion-adapter.mjs" 리터럴을 쓴다). 오탐 제외:
// (a) relay-handshake.mjs 자기 자신 -- 자기 CLI 진입점 판별(`endsWith(...)`)
//     이 자기 파일명을 리터럴로 갖고 있는 게 정상이라 제외.
// (b) *.test.mjs 파일 전부 -- 시험이 CLI를 자식 프로세스로 실행해
//     검증하는 것은 이미 알려진 정당한 용도이므로 제외(정의상 "프로덕션
//     호출자"가 아니다).
// 주석 벗기기는 정규식 기반 최선-노력이다(완전한 JS 파서 아님) -- 블록
// 주석(`/* */`)과 줄 주석(`//`)을 지운다. ⚠️정직 한계: 문자열 리터럴
// 안에 `//`가 들어있으면(예: URL) 그 뒤가 주석으로 잘못 벗겨질 수 있다 --
// 이 저장소의 실제 소스에서 relay-handshake.mjs 리터럴 근처에 그런 문자열이
// 없음을 이 시험 자신의 결과(0건)로 확인했다. 그리고 문자열을 쪼개
// 이어붙이거나 동적으로 조립한 경로(예: `"relay-" + "handshake.mjs"`)는
// 이 정규식 스캔으로 원리적으로 잡지 못한다 -- 고의적 회피는 이 시험의
// 범위 밖이다(결과 파일에 동일하게 명시).
function stripCommentsBestEffort(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// 정적/동적 import 지정자는 "in-process 함수 호출자" 범주다(검토자가 이미
// 확인: "checkRelayHandshake를 import하는 in-process 호출자들도 프로세스
// 종료 코드를 소비하지 않습니다") -- 이 시험이 찾는 것은 그 반대(자식
// 프로세스로 «실행»하는 것)이므로, 세 import 모양(정적 `from "..."`,
// 사이드이펙트 `import "..."`, 동적 `import("...")`)을 먼저 지운 뒤
// 남는 리터럴만 offender 후보로 본다.
function stripRelayHandshakeImportSpecifiers(src) {
  return src
    .replace(/from\s*(["'])[^"']*relay-handshake\.mjs\1/g, "")
    .replace(/import\s*\(\s*(["'])[^"']*relay-handshake\.mjs\1\s*\)/g, "")
    .replace(/import\s*(["'])[^"']*relay-handshake\.mjs\1/g, "");
}

function listMjsFilesRecursive(rootDir) {
  const out = [];
  for (const entry of readdirSync(rootDir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    // entry.parentPath (Node 20.12+) / entry.path (older) -- both give the
    // directory containing this entry; fall back defensively.
    const parentDir = entry.parentPath ?? entry.path ?? rootDir;
    out.push(join(parentDir, entry.name));
  }
  return out;
}

// (c) HYK-430 4R -- 의도적 예외 목록(⛔조용히 넓히지 마라, 새 항목을
// 추가할 때마다 «왜 스폰 호출자가 아닌지»를 한 줄로 밝힌다). 이
// 시험이 잡으려는 것은 "relay-handshake.mjs CLI를 자식 프로세스로
// 실행하는 새 프로덕션 호출자"다 -- 아래 파일은 그 반대(파일명
// 문자열을 «검색 대상»으로만 쓰는 정적 분석 도구, 자식 프로세스
// 실행 0건)이므로 이 시험의 관심사 밖이다.
const KNOWN_NON_SPAWN_LITERAL_REFERENCES = [
  // list-relay-handshake-isolated-fixtures.mjs: "얼마나 많은 시험이
  // relay-handshake.mjs를 격리 복사하는가"를 세는 정적 스캐너다 --
  // content.includes("relay-handshake.mjs")로 다른 파일의 텍스트
  // 안에서 이 이름을 찾을 뿐, 이 파일 자신은 relay-handshake.mjs를
  // spawn/import 둘 다 하지 않는다(HYK-430 4R §2⑵).
  "scripts/check/list-relay-handshake-isolated-fixtures.mjs",
  // relay-handshake-fixture-siblings.mjs: HYK-430 5R -- 격리 픽스처가
  // 복사해야 할 형제 파일 이름 목록의 단일 소스(§2⑵). 배열 리터럴
  // 안에 "relay-handshake.mjs" 문자열이 있을 뿐, 이 파일 자신은
  // relay-handshake.mjs를 spawn/import 둘 다 하지 않는다.
  "scripts/check/relay-handshake-fixture-siblings.mjs",
];

test("HYK-344 3R: relay-handshake.mjs CLI를 실제로 실행(spawn)하는 프로덕션 호출자는 이 저장소 안에 0건 -- «지금은 사람이 유일한 호출자»가 시험으로 고정된다", () => {
  const scriptsRoot = join(
    dirname(fileURLToPath(new URL(import.meta.url))),
    "..",
  );
  const selfPath = fileURLToPath(new URL(import.meta.url).href).replace(
    /relay-handshake\.test\.mjs$/,
    "relay-handshake.mjs",
  );
  const allFiles = listMjsFilesRecursive(scriptsRoot);
  assert.ok(
    allFiles.length > 50,
    `sanity: recursive .mjs walk under scripts/ must find far more than 50 files (found ${allFiles.length}) -- a near-zero count would silently make this test's "0 callers" pass meaninglessly`,
  );
  const offenders = [];
  for (const filePath of allFiles) {
    const normalized = filePath.replace(/\\/g, "/");
    if (normalized.endsWith("/relay-handshake.mjs")) continue; // (a) self
    if (normalized.endsWith(".test.mjs")) continue; // (b) test callers
    if (
      KNOWN_NON_SPAWN_LITERAL_REFERENCES.some((allowed) =>
        normalized.endsWith(`/${allowed}`),
      )
    ) {
      continue; // (c) known non-spawn static-analysis tool, see above
    }
    const stripped = stripRelayHandshakeImportSpecifiers(
      stripCommentsBestEffort(readFileSync(filePath, "utf8")),
    );
    if (/["'][^"']*relay-handshake\.mjs["']/.test(stripped)) {
      offenders.push(filePath);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these non-test, non-self files reference the literal "relay-handshake.mjs" filename outside a comment -- a production caller may have been added; wire its exit-3 handling and update this test's allowlist deliberately (never silently): ${JSON.stringify(offenders)}`,
  );
  // self-check: relay-handshake.mjs itself DOES contain the literal (its own
  // invokedDirectly guard) -- confirms the scan mechanism actually works
  // rather than e.g. silently reading zero bytes from every file.
  assert.match(
    stripCommentsBestEffort(readFileSync(selfPath, "utf8")),
    /["'][^"']*relay-handshake\.mjs["']/,
    "sanity: relay-handshake.mjs's own source must still contain its own filename literal (its CLI-invocation guard) -- if this fails, the scan/strip mechanism itself is broken, not the claim being tested",
  );
});
