import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPacketGate } from "./packet-gate.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./packet-gate.mjs", import.meta.url));

function withPacket(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "packet-gate-test-"));
  const p = join(dir, "packet.md");
  writeFileSync(p, content, "utf8");
  try {
    fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("(1) signed approval passes", () => {
  withPacket("packet_id: PKT-1\n승인: OK 한용 2026-07-11 17:00\n", (p) => {
    const result = checkPacketGate({ packetPath: p });
    assert.equal(result.ok, true);
  });
});

test("(2) unsigned checkbox fails", () => {
  withPacket("packet_id: PKT-1\n승인: ☐\n", (p) => {
    const result = checkPacketGate({ packetPath: p });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not yet approved/);
  });
});

test("(3) no 승인 line at all fails", () => {
  withPacket("packet_id: PKT-1\nno approval line here\n", (p) => {
    const result = checkPacketGate({ packetPath: p });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no '승인:' line/);
  });
});

test("(4) malformed signature (missing time) fails", () => {
  withPacket("승인: OK 한용 2026-07-11\n", (p) => {
    const result = checkPacketGate({ packetPath: p });
    assert.equal(result.ok, false);
    assert.match(result.reason, /malformed approval signature/);
  });
});

test("(5) malformed signature (missing name) fails", () => {
  withPacket("승인: OK 2026-07-11 17:00\n", (p) => {
    const result = checkPacketGate({ packetPath: p });
    assert.equal(result.ok, false);
    assert.match(result.reason, /malformed approval signature/);
  });
});

test("(6) missing file fails", () => {
  const result = checkPacketGate({ packetPath: "Z:/does/not/exist/packet.md" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not found/);
});

test("(7) no path provided fails", () => {
  const result = checkPacketGate({ packetPath: undefined });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no packet path provided/);
});

test("(8) CLI exits 0 for a signed packet", () => {
  withPacket("승인: OK 한용 2026-07-11 17:00\n", (p) => {
    execFileSync("node", [SCRIPT_PATH, p], { encoding: "utf8" });
  });
});

test("(9) CLI exits non-zero for an unsigned packet", () => {
  withPacket("승인: ☐\n", (p) => {
    assert.throws(() => execFileSync("node", [SCRIPT_PATH, p], { encoding: "utf8" }));
  });
});
