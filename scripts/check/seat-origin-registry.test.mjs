import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLaunchRecord,
  appendLaunchRecord,
  readRegistry,
  readRegistryDiagnostics,
  isPaneRegistered,
  runSeatOriginRegistryCli,
} from "./seat-origin-registry.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_PATH = join(
  REPO_ROOT,
  "scripts",
  "check",
  "seat-origin-registry.mjs",
);

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "seat-origin-registry-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("buildLaunchRecord: requires paneKey and role", () => {
  assert.throws(() => buildLaunchRecord({ role: "CODER" }), /MISSING_PANE_KEY/);
  assert.throws(() => buildLaunchRecord({ paneKey: "a:b" }), /MISSING_ROLE/);
});

test("buildLaunchRecord: fills optional fields with null, stamps launchedAt", () => {
  const r = buildLaunchRecord({
    paneKey: "a:b",
    role: "CODER",
    nowIso: "2026-09-16T00:00:00.000Z",
  });
  assert.equal(r.paneKey, "a:b");
  assert.equal(r.role, "CODER");
  assert.equal(r.engine, null);
  assert.equal(r.launchedVia, "orca-worker-seat.ps1");
  assert.equal(r.launchedAt, "2026-09-16T00:00:00.000Z");
});

test("appendLaunchRecord + readRegistry: round-trips one record, creates parent dir", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "nested", "seat-launch-registry.jsonl");
    const record = buildLaunchRecord({
      paneKey: "tab1:leaf1",
      role: "REVIEW",
      engine: "claude",
    });
    appendLaunchRecord(registryPath, record);
    const rows = readRegistry(registryPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].paneKey, "tab1:leaf1");
    assert.equal(rows[0].engine, "claude");
  });
});

test("readRegistry: missing file -> empty array, not a throw", () => {
  withTempDir((dir) => {
    assert.deepEqual(readRegistry(join(dir, "nope.jsonl")), []);
  });
});

test("readRegistry: skips corrupted/truncated lines without failing the whole read", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "reg.jsonl");
    writeFileSync(
      registryPath,
      '{"paneKey":"good:1","role":"CODER"}\n{not json\n',
      "utf8",
    );
    const rows = readRegistry(registryPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].paneKey, "good:1");
  });
});

// HYK-464 §3 (P2-1): 등록 실패(손상된 줄)가 조용히 사라지지 않고 개수로
// 드러난다 -- readRegistry는 하위호환을 위해 records만 돌려주지만,
// readRegistryDiagnostics를 쓰는 호출부(seat-census.mjs)는 이 개수를
// 얻어 출력에 표시할 수 있다.
test("readRegistryDiagnostics: reports corruptedLineCount alongside the surviving records (P2-1)", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "reg.jsonl");
    writeFileSync(
      registryPath,
      '{"paneKey":"good:1","role":"CODER"}\n{not json\n{"paneKey":"good:2","role":"CODER"}\nalso not json\n',
      "utf8",
    );
    const { records, corruptedLineCount } =
      readRegistryDiagnostics(registryPath);
    assert.equal(records.length, 2);
    assert.equal(corruptedLineCount, 2);
  });
});

test("readRegistryDiagnostics: missing file -> empty records, zero corrupted (cold start is not corruption)", () => {
  withTempDir((dir) => {
    const { records, corruptedLineCount } = readRegistryDiagnostics(
      join(dir, "nope.jsonl"),
    );
    assert.deepEqual(records, []);
    assert.equal(corruptedLineCount, 0);
  });
});

test("isPaneRegistered: true only for a pane key that actually appears (bidirectional)", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "reg.jsonl");
    appendLaunchRecord(
      registryPath,
      buildLaunchRecord({ paneKey: "tabA:leafA", role: "CODER" }),
    );
    assert.equal(isPaneRegistered(registryPath, "tabA:leafA"), true);
    // 유령 좌석(orphan) 시나리오: 등록부에 없는 pane key는 false여야 한다 --
    // 잡아야 할 것을 놓치면(false negative) 이 축 전체의 존재 이유가 없다.
    assert.equal(isPaneRegistered(registryPath, "ghost-tab:ghost-leaf"), false);
  });
});

test("isPaneRegistered: append-only, multiple records for the same pane still resolve true", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "reg.jsonl");
    appendLaunchRecord(
      registryPath,
      buildLaunchRecord({ paneKey: "tabA:leafA", role: "CODER" }),
    );
    appendLaunchRecord(
      registryPath,
      buildLaunchRecord({ paneKey: "tabA:leafA", role: "CODER" }),
    );
    assert.equal(readRegistry(registryPath).length, 2);
    assert.equal(isPaneRegistered(registryPath, "tabA:leafA"), true);
  });
});

test("runSeatOriginRegistryCli record: writes a record and reports it", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "reg.jsonl");
    const outcome = runSeatOriginRegistryCli([
      "record",
      "--registry-path",
      registryPath,
      "--pane-key",
      "tabX:leafX",
      "--role",
      "REVIEW",
      "--engine",
      "claude",
      "--model",
      "claude-opus-5",
      "--effort",
      "high",
      "--worktree",
      "C:/wt",
      "--launched-via",
      "orca-worker-seat.ps1",
    ]);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.record.paneKey, "tabX:leafX");
    assert.equal(isPaneRegistered(registryPath, "tabX:leafX"), true);
  });
});

test("runSeatOriginRegistryCli record: missing --pane-key fails cleanly", () => {
  withTempDir((dir) => {
    const outcome = runSeatOriginRegistryCli([
      "record",
      "--registry-path",
      join(dir, "reg.jsonl"),
      "--role",
      "CODER",
    ]);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /MISSING_PANE_KEY/);
  });
});

test("runSeatOriginRegistryCli is-registered: reflects prior record CLI-round-trip", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "reg.jsonl");
    runSeatOriginRegistryCli([
      "record",
      "--registry-path",
      registryPath,
      "--pane-key",
      "p:q",
      "--role",
      "CODER",
    ]);
    const yes = runSeatOriginRegistryCli([
      "is-registered",
      "--registry-path",
      registryPath,
      "--pane-key",
      "p:q",
    ]);
    const no = runSeatOriginRegistryCli([
      "is-registered",
      "--registry-path",
      registryPath,
      "--pane-key",
      "z:z",
    ]);
    assert.equal(yes.registered, true);
    assert.equal(no.registered, false);
  });
});

test("CLI end-to-end: spawned process record then is-registered agree", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "reg.jsonl");
    execFileSync(process.execPath, [
      SCRIPT_PATH,
      "record",
      "--registry-path",
      registryPath,
      "--pane-key",
      "e2e:pane",
      "--role",
      "CODER",
      "--engine",
      "claude",
    ]);
    const stdout = execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        "is-registered",
        "--registry-path",
        registryPath,
        "--pane-key",
        "e2e:pane",
      ],
      { encoding: "utf8" },
    );
    assert.match(stdout, /REGISTERED/);
  });
});
