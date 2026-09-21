import { readFileSync, existsSync } from "node:fs";

const APPROVAL_LINE_RE = /^승인:\s*(.*)$/m;
const SIGNED_RE = /^OK\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/;

// Parses a delegation-packet file's `승인:` (approval) line and reports
// whether it carries a valid human signature. Signed form (exact, per
// PM\템플릿\위임패킷-템플릿.md): `승인: OK <이름> YYYY-MM-DD HH:MM`.
export function checkPacketGate({ packetPath }) {
  if (typeof packetPath !== "string" || packetPath.length === 0) {
    return { ok: false, reason: "packet-gate: no packet path provided" };
  }
  if (!existsSync(packetPath)) {
    return { ok: false, reason: `packet-gate: packet file not found: ${packetPath}` };
  }

  let content;
  try {
    content = readFileSync(packetPath, "utf8");
  } catch (err) {
    return { ok: false, reason: `packet-gate: failed to read packet file: ${err.message}` };
  }

  const line = content.match(APPROVAL_LINE_RE);
  if (!line) {
    return { ok: false, reason: `packet-gate: no '승인:' line found in ${packetPath}` };
  }

  const value = line[1].trim();
  if (value === "☐") {
    return { ok: false, reason: `packet-gate: packet not yet approved (승인: ☐) in ${packetPath}` };
  }

  const signed = value.match(SIGNED_RE);
  if (!signed) {
    return {
      ok: false,
      reason: `packet-gate: malformed approval signature '승인: ${value}' in ${packetPath} (need '승인: OK <이름> YYYY-MM-DD HH:MM')`,
    };
  }

  return { ok: true, reason: `packet-gate: signed by ${signed[1]} at ${signed[2]} ${signed[3]}` };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/packet-gate.mjs");
if (invokedDirectly) {
  const packetPath = process.argv[2];
  if (!packetPath) {
    console.error("usage: node packet-gate.mjs <packet-path>");
    process.exit(1);
  }
  const result = checkPacketGate({ packetPath });
  if (result.ok) {
    console.log(result.reason);
    process.exit(0);
  }
  console.error(result.reason);
  process.exit(1);
}
