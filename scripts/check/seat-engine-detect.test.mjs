import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as seatEngineModule from "./seat-engine-detect.mjs";
import {
  detectSeatEngine,
  resolveSeatEngine,
  runSeatEngineDetectCli,
} from "./seat-engine-detect.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_PATH = join(
  REPO_ROOT,
  "scripts",
  "check",
  "seat-engine-detect.mjs",
);

// ORCH-71 실측 원문(coder-task.md §1): "engine=codex source=dispatch-worker.ps1:$engine
// role=REVIEW" 인데 실물 좌석은 claude였다 -- 이 사고의 정확한 재현 시나리오.
const CLAUDE_REVIEW_BANNER =
  "[REVIEW seat] engine=claude model=claude-opus-5 effort=high worktree=C:\\...\npane=abc\n" +
  "✻ Welcome to Claude Code!\n  Opus 5 · claude-opus-5\n  bypass permissions on\n";

const CODEX_REVIEW_BANNER =
  ">_ You are using OpenAI Codex\n  model:      gpt-5.6-terra\n  Weekly limit: [████] 97% left\n";

// 실측 회귀 픽스처(2026-09-16, 이 라운드가 실제로 띄운 codex REVIEW
// 시험 좌석의 preview 그대로): "MCP startup"은 처음에 claude 전용
// 마커로 잘못 가정됐었다 -- codex도 MCP 서버 로드 실패 시 같은 문구를
// 찍는다("⚠ MCP startup incomplete (failed: linear-server)"). 이 픽스처가
// 그 실측 라이브 시험에서 나온 원문이다 -- CODEX_ENGINE_MARKERS만 매치하고
// CLAUDE_ENGINE_MARKERS는 매치하지 않아야 한다(회귀하면 codex가
// unknown/claude로 오판정된다).
const REAL_CODEX_BANNER_WITH_MCP_STARTUP_TEXT =
  "MCPserveMCP server•CP serversP servers• servrs (21ervers (2/•rvers (2/3vers (2/3)ers (2/3):•rs (23): c\n" +
  "⚠ MCP startup incomplete (failed: linear-server)  › Ask Codex to do anything   gpt-5.6-luna xhigh · ~\\orca\\workspaces\\HARNESSENGINEERING\\hyk464-472-seat-origin-engine-1 · Context 0% used · monthly…\n";

test("detectSeatEngine: claude banner -> claude", () => {
  assert.equal(detectSeatEngine(CLAUDE_REVIEW_BANNER), "claude");
});

test("detectSeatEngine: codex banner -> codex", () => {
  assert.equal(detectSeatEngine(CODEX_REVIEW_BANNER), "codex");
});

test('detectSeatEngine: real codex banner containing "MCP startup" text is NOT mistaken for claude (2026-09-16 live-test regression)', () => {
  assert.equal(
    detectSeatEngine(REAL_CODEX_BANNER_WITH_MCP_STARTUP_TEXT),
    "codex",
  );
});

test("detectSeatEngine: empty/blank preview -> unknown (brand new seat, no evidence yet)", () => {
  assert.equal(detectSeatEngine(""), "unknown");
  assert.equal(detectSeatEngine("   \n  "), "unknown");
});

test("detectSeatEngine: neither marker present -> unknown", () => {
  assert.equal(detectSeatEngine("PS C:\\Users\\Administrator>"), "unknown");
});

test("detectSeatEngine: both markers present (contaminated transcript) -> unknown, not a guess", () => {
  assert.equal(
    detectSeatEngine(CLAUDE_REVIEW_BANNER + CODEX_REVIEW_BANNER),
    "unknown",
  );
});

test("HYK-472 2R: the role-fallback export is gone -- nothing can re-guess an engine from the role", () => {
  assert.equal(seatEngineModule.roleFallbackEngine, undefined);
});

test("resolveSeatEngine: measured engine wins even when it contradicts the role (the actual bug this round fixes)", () => {
  const r = resolveSeatEngine({
    previewText: CLAUDE_REVIEW_BANNER,
    role: "REVIEW",
  });
  assert.equal(r.engine, "claude");
  assert.equal(r.measured, "claude");
  assert.equal(r.source, "measured-preview");
});

test("HYK-472 2R: unknown measurement is REFUSED -- no engine is chosen, even for a REVIEW role that used to fall back to codex", () => {
  const r = resolveSeatEngine({ previewText: "", role: "REVIEW" });
  assert.equal(r.refused, true);
  assert.equal(r.reason, "UNKNOWN_SEAT_ENGINE");
  assert.equal(r.measured, "unknown");
  assert.equal(r.engine, undefined);
  assert.equal(r.source, undefined);
  assert.match(r.detail, /NO_ENGINE_MARKER role=REVIEW preview_chars=0/);
});

test("HYK-472 2R: the refusal names the ambiguity kind (both markers vs none) and the markers it searched for", () => {
  const both = resolveSeatEngine({
    previewText: CLAUDE_REVIEW_BANNER + CODEX_REVIEW_BANNER,
    role: "CODER",
  });
  assert.match(both.detail, /^BOTH_ENGINE_MARKERS role=CODER/);
  assert.match(both.detail, /Sonnet\|Opus\|Fable\|bypass permissions/);
  assert.match(both.detail, /gpt-5\.6/);
});

test("resolveSeatEngine: CODER role + codex-looking preview still trusts the measurement", () => {
  const r = resolveSeatEngine({
    previewText: CODEX_REVIEW_BANNER,
    role: "CODER",
  });
  assert.equal(r.engine, "codex");
  assert.equal(r.source, "measured-preview");
});

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "seat-engine-detect-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runSeatEngineDetectCli: --preview-file path is read and classified", () => {
  withTempDir((dir) => {
    const file = join(dir, "preview.txt");
    writeFileSync(file, CLAUDE_REVIEW_BANNER, "utf8");
    const outcome = runSeatEngineDetectCli([
      "--preview-file",
      file,
      "--role",
      "REVIEW",
    ]);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.engine, "claude");
    assert.equal(outcome.result.source, "measured-preview");
  });
});

test("runSeatEngineDetectCli: missing preview file -> ok:false, does not throw", () => {
  const outcome = runSeatEngineDetectCli([
    "--preview-file",
    "C:\\does\\not\\exist.txt",
    "--role",
    "CODER",
  ]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "PREVIEW_FILE_UNREADABLE");
});

test("CLI end-to-end: spawned process prints JSON on stdout and exits 0", () => {
  withTempDir((dir) => {
    const file = join(dir, "preview.txt");
    writeFileSync(file, CODEX_REVIEW_BANNER, "utf8");
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT_PATH, "--preview-file", file, "--role", "PM"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.engine, "codex");
    assert.equal(parsed.source, "measured-preview");
  });
});

test("CLI end-to-end: unreadable file exits non-zero", () => {
  assert.throws(() => {
    execFileSync(
      process.execPath,
      [SCRIPT_PATH, "--preview-file", "C:\\nope\\nope.txt", "--role", "CODER"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

// HYK-472 2R 거부 경로 (coder-task.md §1 ⓐ-1·2). 종료코드 2 = 이 CLI 의 기존
// 실패 코드(PREVIEW_FILE_UNREADABLE 과 공유) -- 새 코드를 만들지 않았다.
// 배달기(dispatch-worker.ps1)는 비0 을 전부 ENGINE_DETECT_FAILED 로 멈춘다.
test("★CLI refusal: unknown preview -> exit 2, stdout empty, stderr names UNKNOWN_SEAT_ENGINE and role (no engine guessed)", () => {
  withTempDir((dir) => {
    const file = join(dir, "preview.txt");
    writeFileSync(file, "PS C:\\Users\\Administrator>", "utf8");
    let thrown = null;
    try {
      execFileSync(
        process.execPath,
        [SCRIPT_PATH, "--preview-file", file, "--role", "REVIEW"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "unknown measurement must not exit 0");
    assert.equal(thrown.status, 2);
    assert.equal(thrown.stdout, "");
    assert.match(thrown.stderr, /FAILED reason=UNKNOWN_SEAT_ENGINE/);
    assert.match(thrown.stderr, /role=REVIEW/);
  });
});

test("★CLI refusal (anti-vacuity): the SAME codex banner that resolves OK exits 0 -- so the exit-2 above is caused by unknown, not by the CLI being broken", () => {
  withTempDir((dir) => {
    const file = join(dir, "preview.txt");
    writeFileSync(file, CODEX_REVIEW_BANNER, "utf8");
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT_PATH, "--preview-file", file, "--role", "REVIEW"],
      { encoding: "utf8" },
    );
    assert.equal(JSON.parse(stdout.trim()).engine, "codex");
  });
});
