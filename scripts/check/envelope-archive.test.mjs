// HYK-204 1R: 워커 봉투(`.harness/<role>.md`)는 라운드마다 덮어쓴다 -- 이
// 모듈은 그 원문을 라운드별로 별도 파일에 복제해 남긴다. §3-2 착수
// 기준(§5)의 핵심 실측: 같은 트랙에서 라운드 2회를 돌리면 두 라운드
// 원문이 각각 남아 있어야 한다(지금은 마지막 것만 남는다).
//
// ⛔합성 fixture만 쓴다 -- 실제 `.harness`는 절대 건드리지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  archiveRoundEnvelope,
  archiveUnconsumedRoundEnvelope,
  nextArchiveFileName,
  archiveRoundTaskFile,
  nextTaskArchiveFileName,
} from "./envelope-archive.mjs";
import { checkRelayHandshake } from "./relay-handshake.mjs";
import {
  computeFingerprint,
  formatBindingBlock,
} from "./review-approval-binding.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW_GATE_CLI = join(HERE, "review-gate.mjs");

function withFixtureDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// pure: nextArchiveFileName
// ---------------------------------------------------------------------------

test("nextArchiveFileName: empty archive dir -> round 1", () => {
  assert.equal(nextArchiveFileName("coder", []), "coder-r1.md");
});

test("nextArchiveFileName: existing r1 -> next is r2 (never reuses r1)", () => {
  assert.equal(nextArchiveFileName("coder", ["coder-r1.md"]), "coder-r2.md");
});

test("nextArchiveFileName: only counts files for THIS role -- a sibling role's files never bump the counter", () => {
  assert.equal(
    nextArchiveFileName("coder", ["review-r1.md", "review-r2.md"]),
    "coder-r1.md",
  );
});

test("nextArchiveFileName: a gap (r1 deleted, r2 present) still advances past the max -- never reuses a past round number", () => {
  assert.equal(nextArchiveFileName("coder", ["coder-r2.md"]), "coder-r3.md");
});

// ---------------------------------------------------------------------------
// HYK-244 gate-unblock-1 §1 조각1 원인ⓑ 실사고 재현 방지: role 대소문자가
// 호출마다 섞여도(실제로 이 워크트리의 REVIEW-r1..r8.md가 이렇게
// 만들어졌다가 "review"로 불린 한 번 때문에 REVIEW-r1.md가 실제로
// 소실됐다) 기존 사본을 전부 세야 한다. 파일시스템 대소문자 동작에
// 기대지 않는 순수 문자열/배열 단언(Windows·Linux 어디서나 같은 값).
// ---------------------------------------------------------------------------

test("nextArchiveFileName: role 대소문자가 기존 파일과 달라도(role='review', 기존='REVIEW-r*') 기존 사본을 전부 세어 다음 번호를 매긴다(실사고 재현 방지)", () => {
  assert.equal(
    nextArchiveFileName("review", [
      "REVIEW-r1.md",
      "REVIEW-r2.md",
      "REVIEW-r8.md",
    ]),
    "review-r9.md",
  );
});

test("nextArchiveFileName: role 대소문자 반대 방향(role='REVIEW', 기존='review-r*')도 동일하게 기존을 전부 센다", () => {
  assert.equal(
    nextArchiveFileName("REVIEW", ["review-r1.md", "review-r2.md"]),
    "REVIEW-r3.md",
  );
});

test("nextTaskArchiveFileName: role 대소문자 혼재에서도 기존 TASK 사본을 전부 센다(결과 쪽과 대칭)", () => {
  assert.equal(
    nextTaskArchiveFileName("review", [
      "REVIEW-task-r1.md",
      "REVIEW-task-r5.md",
    ]),
    "review-task-r6.md",
  );
});

// ---------------------------------------------------------------------------
// HYK-241 §2 조각1: nextTaskArchiveFileName -- TASK-file 쌍. 같은 디렉터리
// 안에서 nextArchiveFileName의 (`<role>-r<N>.md`) 패턴과 절대 서로의
// 파일을 세지 않는다는 것도 함께 증명한다.
// ---------------------------------------------------------------------------

test("nextTaskArchiveFileName: empty archive dir -> round 1", () => {
  assert.equal(nextTaskArchiveFileName("coder", []), "coder-task-r1.md");
});

test("nextTaskArchiveFileName: existing task-r1 -> next is task-r2 (never reuses r1)", () => {
  assert.equal(
    nextTaskArchiveFileName("coder", ["coder-task-r1.md"]),
    "coder-task-r2.md",
  );
});

test("nextTaskArchiveFileName: does NOT count sibling result-envelope files (coder-r1.md) -- separate namespaces", () => {
  assert.equal(
    nextTaskArchiveFileName("coder", ["coder-r1.md", "coder-r2.md"]),
    "coder-task-r1.md",
  );
});

test("nextArchiveFileName (result side): does NOT count sibling task files (coder-task-r1.md) -- separate namespaces, symmetric check", () => {
  assert.equal(
    nextArchiveFileName("coder", ["coder-task-r1.md", "coder-task-r2.md"]),
    "coder-r1.md",
  );
});

// ---------------------------------------------------------------------------
// archiveRoundTaskFile: fs-backed behavior
// ---------------------------------------------------------------------------

test("archiveRoundTaskFile: writes a verbatim copy under <harnessDir>/rounds/<role>-task-r1.md", () => {
  withFixtureDir("task-archive-basic-", (dir) => {
    const content = "task_id: HYK-1\ndropped_at: 2026-08-13 06:00 KST\nbody\n";
    const outcome = archiveRoundTaskFile({
      role: "coder",
      taskContent: content,
      harnessDir: dir,
    });
    assert.equal(outcome.ok, true);
    const written = readFileSync(
      join(dir, "rounds", "coder-task-r1.md"),
      "utf8",
    );
    assert.ok(
      written.includes(content),
      "archived file must contain the round's actual task text, not just exist",
    );
  });
});

test("archiveRoundTaskFile: <role>-task.md itself is never touched -- preservation is additive only", () => {
  withFixtureDir("task-archive-contract-", (dir) => {
    const taskPath = join(dir, "coder-task.md");
    const content = "task_id: HYK-1\ndropped_at: 2026-08-13 06:00 KST\n";
    writeFileSync(taskPath, content, "utf8");
    archiveRoundTaskFile({
      role: "coder",
      taskContent: content,
      harnessDir: dir,
    });
    assert.equal(readFileSync(taskPath, "utf8"), content);
  });
});

test("archiveRoundTaskFile: two rounds for the same role -> BOTH original task texts survive, each in its own file", () => {
  withFixtureDir("task-archive-two-rounds-", (dir) => {
    const round1 = "task_id: HYK-241\n라운드1 지시\n";
    const round2 = "task_id: HYK-241\n라운드2 지시\n";
    const r1 = archiveRoundTaskFile({
      role: "coder",
      taskContent: round1,
      harnessDir: dir,
    });
    const r2 = archiveRoundTaskFile({
      role: "coder",
      taskContent: round2,
      harnessDir: dir,
    });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.notEqual(r1.path, r2.path);
    const files = readdirSync(join(dir, "rounds")).filter((f) =>
      f.includes("-task-"),
    );
    assert.deepEqual(files.sort(), ["coder-task-r1.md", "coder-task-r2.md"]);
    const stored1 = readFileSync(
      join(dir, "rounds", "coder-task-r1.md"),
      "utf8",
    );
    const stored2 = readFileSync(
      join(dir, "rounds", "coder-task-r2.md"),
      "utf8",
    );
    assert.ok(stored1.includes("라운드1 지시"));
    assert.ok(stored2.includes("라운드2 지시"));
  });
});

test("archiveRoundTaskFile: role missing -> ok:false, never throws", () => {
  withFixtureDir("task-archive-bad-role-", (dir) => {
    const outcome = archiveRoundTaskFile({
      role: "",
      taskContent: "x",
      harnessDir: dir,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /role missing/);
  });
});

// ---------------------------------------------------------------------------
// archiveRoundEnvelope: fs-backed behavior
// ---------------------------------------------------------------------------

test("archiveRoundEnvelope: writes a verbatim copy under <harnessDir>/rounds/<role>-r1.md", () => {
  withFixtureDir("envelope-archive-basic-", (dir) => {
    const content =
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-08 06:10 KST\n";
    const outcome = archiveRoundEnvelope({
      role: "coder",
      resultContent: content,
      harnessDir: dir,
    });
    assert.equal(outcome.ok, true);
    const written = readFileSync(join(dir, "rounds", "coder-r1.md"), "utf8");
    assert.ok(
      written.includes(content),
      "archived file must contain the round's actual content, not just exist",
    );
  });
});

// ---------------------------------------------------------------------------
// HYK-244 gate-unblock-1 §1 조각1 비타협 안전장치: 목적지가 대소문자만
// 다르게 이미 있으면 절대 덮어쓰지 않는다. 실제 동시성 없이(단일
// 프로세스, node --test) 이 TOCTOU 창을 재현하려고, readdirFn을 호출
// 횟수에 따라 다른 목록을 반환하도록 주입한다 -- 1차 호출(번호 계산)
// 때는 아직 충돌 파일이 "없다"고 답하고, 2차 호출(쓰기 직전 재확인)
// 때는 "방금 다른 프로세스가 만든 것"처럼 그 파일이 나타나게 한다.
// 프로덕션 export(archiveRoundEnvelope/archiveRoundTaskFile)를 직접
// 구동하고, 반환된 계약 필드(ok/reason)의 실제 내용을 검사한다(공허
// 시험 금지 요구 그대로).
// ---------------------------------------------------------------------------

function makeRacingReaddir(firstList, secondList) {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? firstList : secondList;
  };
}

test("archiveRoundEnvelope: 쓰기 직전 재확인에서 대소문자만 다른 목적지가 새로 나타나면(TOCTOU 경합 재현) 덮어쓰지 않고 ok:false를 반환한다", () => {
  withFixtureDir("envelope-archive-race-", (dir) => {
    const roundsDir = join(dir, "rounds");
    mkdirSync(roundsDir, { recursive: true });
    const outcome = archiveRoundEnvelope({
      role: "review",
      resultContent:
        "task_id: HYK-1\n\n>>> DONE: REVIEW @ 2026-08-08 06:10 KST\n",
      harnessDir: dir,
      readdirFn: makeRacingReaddir([], ["REVIEW-r1.md"]),
    });
    assert.equal(
      outcome.ok,
      false,
      "경합으로 나타난 대소문자-충돌 목적지를 놓치면 안 된다",
    );
    assert.match(outcome.reason, /refusing to overwrite/);
    assert.match(outcome.reason, /review-r1\.md/);
    assert.match(outcome.reason, /REVIEW-r1\.md/);
    assert.equal(
      existsSync(join(roundsDir, "REVIEW-r1.md")),
      false,
      "실제로 쓰기가 시도조차 되지 않아야 한다(원래 있던 파일도 아니고, 새로 만들어지지도 않아야 함)",
    );
  });
});

test("archiveRoundTaskFile: 쓰기 직전 재확인에서 대소문자만 다른 목적지가 새로 나타나면(TOCTOU 경합 재현) 덮어쓰지 않고 ok:false를 반환한다(대칭)", () => {
  withFixtureDir("envelope-archive-race-task-", (dir) => {
    const roundsDir = join(dir, "rounds");
    mkdirSync(roundsDir, { recursive: true });
    const outcome = archiveRoundTaskFile({
      role: "review",
      taskContent: "task_id: HYK-1\ndropped_at: 2026-08-08 06:00 KST\n",
      harnessDir: dir,
      readdirFn: makeRacingReaddir([], ["REVIEW-task-r1.md"]),
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /refusing to overwrite/);
    assert.match(outcome.reason, /review-task-r1\.md/);
    assert.match(outcome.reason, /REVIEW-task-r1\.md/);
  });
});

test("archiveRoundEnvelope: <role>.md itself is never touched -- preservation is additive only, the envelope contract is unchanged", () => {
  withFixtureDir("envelope-archive-contract-", (dir) => {
    const resultPath = join(dir, "coder.md");
    const content =
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-08 06:10 KST\n";
    writeFileSync(resultPath, content, "utf8");
    archiveRoundEnvelope({
      role: "coder",
      resultContent: content,
      harnessDir: dir,
    });
    assert.equal(readFileSync(resultPath, "utf8"), content);
  });
});

// ---------------------------------------------------------------------------
// HYK-455 §1 확대 라운드: archiveUnconsumedRoundEnvelope -- «미소비» 라운드
// 보존 사본 designed path. archiveRoundEnvelope와 같은 계약(추가 전용 ·
// `<role>.md` 무접촉 · never throws · 같은 rounds/<ROLE>-r<N>.md 파일
// 시리즈 공유)에 원문 결속 필드(content_sha256)만 더한다.
// ---------------------------------------------------------------------------

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("archiveUnconsumedRoundEnvelope: writes a verbatim copy under <harnessDir>/rounds/<role>-r1.md with a self-consistent content_sha256 header field", () => {
  withFixtureDir("envelope-archive-unconsumed-", (dir) => {
    const content =
      "task_id: HYK-9455x2-unit\nhead_commit: " + "a".repeat(40) + "\n";
    const result = archiveUnconsumedRoundEnvelope({
      role: "CODER",
      resultContent: content,
      harnessDir: dir,
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.contentSha256, sha256Hex(content));
    const written = readFileSync(join(dir, "rounds", "CODER-r1.md"), "utf8");
    assert.match(
      written,
      /^<!-- envelope-archive: role=CODER archived_at=\S+ kind=unconsumed_result content_sha256=[0-9a-f]{64} -->\n/,
    );
    assert.match(
      written,
      new RegExp(`content_sha256=${result.contentSha256}\\b`),
    );
    // 헤더 한 줄을 벗기면 원문과 바이트 동일해야 한다(추가 전용 계약).
    const stripped = written.replace(/^<!-- envelope-archive:[^\n]*-->\n/, "");
    assert.equal(stripped, content);
  });
});

test("archiveUnconsumedRoundEnvelope: <role>.md itself is never touched -- preservation is additive only", () => {
  withFixtureDir("envelope-archive-unconsumed-contract-", (dir) => {
    const resultPath = join(dir, "coder.md");
    const content =
      "task_id: HYK-9455x2-unit2\n>>> DONE: CODER @ 이것은-파싱될-수-없는-시각\n";
    writeFileSync(resultPath, content, "utf8");
    archiveUnconsumedRoundEnvelope({
      role: "CODER",
      resultContent: content,
      harnessDir: dir,
    });
    assert.equal(readFileSync(resultPath, "utf8"), content);
  });
});

test("archiveUnconsumedRoundEnvelope: role/resultContent missing -> ok:false, never throws", () => {
  withFixtureDir("envelope-archive-unconsumed-missing-", (dir) => {
    assert.equal(
      archiveUnconsumedRoundEnvelope({ resultContent: "x", harnessDir: dir })
        .ok,
      false,
    );
    assert.equal(
      archiveUnconsumedRoundEnvelope({ role: "coder", harnessDir: dir }).ok,
      false,
    );
  });
});

test("archiveUnconsumedRoundEnvelope: two rounds for the same role -> BOTH original texts survive, each in its own file, each with its own correct content_sha256", () => {
  withFixtureDir("envelope-archive-unconsumed-two-rounds-", (dir) => {
    const round1 = "task_id: HYK-9455x2-r1\n라운드1 미소비 원문\n";
    const round2 = "task_id: HYK-9455x2-r1\n라운드2 미소비 원문\n";
    const r1 = archiveUnconsumedRoundEnvelope({
      role: "CODER",
      resultContent: round1,
      harnessDir: dir,
    });
    const r2 = archiveUnconsumedRoundEnvelope({
      role: "CODER",
      resultContent: round2,
      harnessDir: dir,
    });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.notEqual(r1.path, r2.path);
    assert.notEqual(r1.contentSha256, r2.contentSha256);
    const names = readdirSync(join(dir, "rounds")).sort();
    assert.deepEqual(names, ["CODER-r1.md", "CODER-r2.md"]);
  });
});

test("archiveUnconsumedRoundEnvelope: shares the SAME rounds/<ROLE>-r<N>.md numbering series as archiveRoundEnvelope -- never collides regardless of call order", () => {
  withFixtureDir("envelope-archive-unconsumed-shared-series-", (dir) => {
    const consumed = archiveRoundEnvelope({
      role: "CODER",
      resultContent:
        "task_id: HYK-9455x2-shared\n>>> DONE: CODER @ 2026-09-08 12:00:00 KST\n",
      harnessDir: dir,
    });
    assert.equal(consumed.ok, true);
    const unconsumed = archiveUnconsumedRoundEnvelope({
      role: "CODER",
      resultContent:
        "task_id: HYK-9455x2-shared\nhead_commit: " + "b".repeat(40) + "\n",
      harnessDir: dir,
    });
    assert.equal(unconsumed.ok, true);
    const names = readdirSync(join(dir, "rounds")).sort();
    assert.deepEqual(names, ["CODER-r1.md", "CODER-r2.md"]);
  });
});

test("archiveRoundEnvelope: two rounds for the same role -> BOTH original texts survive, each in its own file (core §3-2 실측)", () => {
  withFixtureDir("envelope-archive-two-rounds-", (dir) => {
    const round1 =
      "task_id: HYK-204\nverdict: rejected\n\n>>> DONE: REVIEW-CODEX @ 2026-08-08 06:00 KST\n";
    const round2 =
      "task_id: HYK-204\nverdict: approved\n\n>>> DONE: REVIEW-CODEX @ 2026-08-08 07:00 KST\n";

    const r1 = archiveRoundEnvelope({
      role: "review",
      resultContent: round1,
      harnessDir: dir,
    });
    const r2 = archiveRoundEnvelope({
      role: "review",
      resultContent: round2,
      harnessDir: dir,
    });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.notEqual(
      r1.path,
      r2.path,
      "round 1 and round 2 must land on distinct files",
    );

    const files = readdirSync(join(dir, "rounds"));
    assert.deepEqual(files.sort(), ["review-r1.md", "review-r2.md"]);

    const stored1 = readFileSync(join(dir, "rounds", "review-r1.md"), "utf8");
    const stored2 = readFileSync(join(dir, "rounds", "review-r2.md"), "utf8");
    assert.ok(stored1.includes(round1) && stored1.includes("rejected"));
    assert.ok(stored2.includes(round2) && stored2.includes("approved"));
  });
});

test("archiveRoundEnvelope: role missing -> ok:false, never throws", () => {
  withFixtureDir("envelope-archive-bad-role-", (dir) => {
    const outcome = archiveRoundEnvelope({
      role: "",
      resultContent: "x",
      harnessDir: dir,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /role missing/);
  });
});

// ---------------------------------------------------------------------------
// wiring: checkRelayHandshake (CODER + rejected-then-rechecked REVIEW path)
// ---------------------------------------------------------------------------

function writeTask(dir, role, taskId, droppedAt, headCommit = "") {
  writeFileSync(
    join(dir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: ${droppedAt}\n${headCommit ? `head_commit: ${headCommit}\n` : ""}`,
    "utf8",
  );
}

function writeResult(dir, role, taskId, doneAt, extra = "", headCommit = "") {
  writeFileSync(
    join(dir, `${role}.md`),
    // HYK-418 §2-1: relay-handshake now rejects a well-formed DONE line
    // with no finalize-done marker (fail-closed) -- this file's own
    // subject is envelope archiving, not the marker gate, so carry the
    // marker to reach that axis unmasked.
    `task_id: ${taskId}\n${headCommit ? `head_commit: ${headCommit}\n` : ""}${extra}\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

// HYK-383: REVIEW 계열 소비는 head_commit: 축(축 ⓐ+ⓑ)도 통과해야 한다 --
// 축 ⓑ가 harnessDir에서 `git rev-parse HEAD`를 직접 읽으므로, 이 fixture
// 디렉터리를 진짜 git 저장소로 만들고 그 실제 HEAD를 반환한다.
function ensureGitHeadCommit(dir) {
  if (!existsSync(join(dir, ".git"))) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: dir,
    });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
    execFileSync(
      "git",
      ["commit", "-q", "--allow-empty", "-m", "envelope-archive test fixture"],
      { cwd: dir },
    );
  }
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

test("wiring: checkRelayHandshake ok -> archives the round AND still returns the same pass/fail contract as before (regression 0)", () => {
  withFixtureDir("relay-wiring-", (dir) => {
    writeTask(dir, "coder", "HYK-204", "2026-08-08 06:00 KST");
    writeResult(dir, "coder", "HYK-204", "2026-08-08 06:10:00 KST");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "relay handshake ok for HYK-204");
    assert.equal(
      readFileSync(join(dir, "rounds", "coder-r1.md"), "utf8").includes(
        "HYK-204",
      ),
      true,
    );
  });
});

test("wiring (HYK-241 §2 조각1): checkRelayHandshake ok -> ALSO archives the round's TASK file, via the SAME production call site -- never calling archiveRoundTaskFile directly", () => {
  withFixtureDir("relay-wiring-task-", (dir) => {
    writeTask(dir, "coder", "HYK-241", "2026-08-13 06:00 KST");
    writeResult(dir, "coder", "HYK-241", "2026-08-13 06:10:00 KST");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
    const archivedTask = readFileSync(
      join(dir, "rounds", "coder-task-r1.md"),
      "utf8",
    );
    assert.match(archivedTask, /HYK-241/);
    assert.match(archivedTask, /dropped_at: 2026-08-13 06:00 KST/);
  });
});

test("wiring (HYK-241 §2 조각1): 라운드 2회 -> 두 라운드의 task 지시 원문이 각각 다른 파일로 남는다 (덮어쓰기 재발 없음)", () => {
  withFixtureDir("relay-wiring-task-two-rounds-", (dir) => {
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: HYK-242\ndropped_at: 2026-08-13 06:00 KST\n라운드1 지시문\n",
      "utf8",
    );
    writeResult(dir, "coder", "HYK-242", "2026-08-13 06:10:00 KST");
    const first = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(first.ok, true);

    // ORCH가 다음 라운드 task 파일을 같은 자리에 덮어쓴다 -- 이 덮어쓰기가
    // §1 실사고의 원인이었다.
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: HYK-242\ndropped_at: 2026-08-13 07:00 KST\n라운드2 지시문\n",
      "utf8",
    );
    writeResult(dir, "coder", "HYK-242", "2026-08-13 07:10:00 KST");
    const second = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(second.ok, true);

    const round1 = readFileSync(
      join(dir, "rounds", "coder-task-r1.md"),
      "utf8",
    );
    const round2 = readFileSync(
      join(dir, "rounds", "coder-task-r2.md"),
      "utf8",
    );
    assert.match(round1, /라운드1 지시문/);
    assert.match(round2, /라운드2 지시문/);
  });
});

test("wiring: checkRelayHandshake blocked (mismatch) -> no archive is written -- only CONFIRMED rounds are preserved", () => {
  withFixtureDir("relay-wiring-blocked-", (dir) => {
    writeTask(dir, "coder", "HYK-204", "2026-08-08 06:00 KST");
    writeResult(dir, "coder", "HYK-WRONG", "2026-08-08 06:10 KST");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(dir, "rounds")), false);
  });
});

// NOTE: these fixtures deliberately never write a real `verdict: approved`/
// `verdict: rejected` line. Role "review" makes reject-streak.mjs's own
// isReviewFamilyRole(role) true, and that module's ledger path is NOT
// injectable -- mainRepoRoot() always resolves THIS machine's actual main
// repo, not this test's mkdtemp fixture. A genuine verdict line here would
// silently write a synthetic entry into the REAL production
// `.harness/reject-streak.json`, exactly the "실제 .harness를 어지럽히지
// 마라" rule this suite must never violate (a 2026-08-08 실측 mistake this
// very track made and had to clean up by hand). An "outcome-note:" line
// keeps the round content distinguishable while parseReviewOutcome's own
// verdict-line requirement fails closed, so no write is ever attempted.
test("wiring: same track, two rounds re-checked via checkRelayHandshake -> both round texts survive under harnessDir/rounds (§5 착수 기준 그대로)", () => {
  withFixtureDir("relay-wiring-two-rounds-", (dir) => {
    const headCommit = ensureGitHeadCommit(dir);
    // Round 1: rejected review, re-checked once ORCH re-verifies the
    // handshake for "다음 라운드" (relay-handshake.mjs's own comment on
    // why its auto-record wiring lives here).
    writeTask(dir, "review", "HYK-204", "2026-08-08 06:00 KST", headCommit);
    writeResult(
      dir,
      "review",
      "HYK-204",
      "2026-08-08 06:10:00 KST",
      "outcome-note: needs-rework\n",
      headCommit,
    );
    const first = checkRelayHandshake({ role: "review", harnessDir: dir });
    assert.equal(first.ok, true);

    // Round 2: same track, task file re-dropped for the next review pass,
    // result overwritten -- this overwrite is exactly what used to erase
    // round 1's text.
    writeTask(dir, "review", "HYK-204", "2026-08-08 07:00 KST", headCommit);
    writeResult(
      dir,
      "review",
      "HYK-204",
      "2026-08-08 07:10:00 KST",
      "outcome-note: looks-good\n",
      headCommit,
    );
    const second = checkRelayHandshake({ role: "review", harnessDir: dir });
    assert.equal(second.ok, true);

    // HYK-241 §2 조각1: checkRelayHandshake now ALSO archives the round's
    // TASK file at the same call site -- this test's own writeTask() calls
    // above mean review-task-r1.md/review-task-r2.md now appear here too
    // (additive, not a regression: result-envelope filenames are unchanged).
    const files = readdirSync(join(dir, "rounds")).sort();
    assert.deepEqual(files, [
      "review-r1.md",
      "review-r2.md",
      "review-task-r1.md",
      "review-task-r2.md",
    ]);
    assert.match(
      readFileSync(join(dir, "rounds", "review-r1.md"), "utf8"),
      /needs-rework/,
    );
    assert.match(
      readFileSync(join(dir, "rounds", "review-r2.md"), "utf8"),
      /looks-good/,
    );
  });
});

// ---------------------------------------------------------------------------
// wiring: review-gate.mjs's commit-msg hook (the APPROVED terminal round --
// never re-checked by relay-handshake since there is no "next round")
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initPlainGitRepo(dir) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-m",
    "base",
    "--quiet",
  ]);
}

function runCli(scriptPath, args, opts = {}) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    ...opts,
  });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

test("wiring: review-gate.mjs commit-msg hook archives the APPROVED (winning, terminal) round -- the one round relay-handshake never re-checks", () => {
  withFixtureDir("review-gate-wiring-", (dir) => {
    initPlainGitRepo(dir);
    // HYK-240: binding-fingerprint must match `dir`'s state at CLI time or
    // checkApprovalBinding fail-closes this ("결속 없음"). Computed fresh
    // (not hardcoded) so it stays correct regardless of what else is on
    // disk here.
    const fp = computeFingerprint({ cwd: dir });
    assert.equal(
      fp.ok,
      true,
      `fingerprint must be computable in ${dir}: ${fp.reason}`,
    );
    const binding = formatBindingBlock({
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });
    writeFileSync(
      join(dir, ".harness", "review.md"),
      `for: HYK-9800\ntask_id: HYK-9800\nrole: REVIEW-CODEX\nverdict: approved\n${binding}\n>>> DONE: REVIEW-CODEX @ 2026-08-08 12:00 KST\n`,
      "utf8",
    );
    // Production's commit-message file lives under `.git/`, outside the
    // working tree `git status` scans -- write it elsewhere so it doesn't
    // shift the fingerprint just recorded above.
    const msgDir = mkdtempSync(join(tmpdir(), "review-gate-wiring-msg-"));
    const commitMsgFile = join(msgDir, "commit-msg.txt");
    writeFileSync(commitMsgFile, "fix(check): HYK-9800 -- something\n", "utf8");

    const result = runCli(REVIEW_GATE_CLI, [commitMsgFile], { cwd: dir });
    assert.equal(result.exit, 0);
    const archived = readFileSync(
      join(dir, ".harness", "rounds", "review-r1.md"),
      "utf8",
    );
    assert.match(archived, /HYK-9800/);
    assert.match(archived, /verdict: approved/);
  });
});
