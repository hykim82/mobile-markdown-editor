// HYK-323 (wrapper-shape-3) §2-2: the fingerprint checker
// (seat-proof-wrapper-shape.mjs) proves the live wrapper's text has not
// drifted from a known-good snapshot, but it never proves that snapshot
// actually behaves correctly -- that PROVEN (exit 0) reads as a pass and
// UNPROVEN (exit 2) reads as a rejection. This module does that by
// actually invoking a candidate `Invoke-SeatProofGate` function body in a
// real PowerShell process, against two fake gate CLIs standing in for the
// real dispatch-worker-seat-proof-gate.mjs:
//   ⓐ prints "SEAT_PROOF: PROVEN/PROVEN" and exits 0
//   ⓑ prints "SEAT_PROOF: UNPROVEN/UNPROVEN" and exits 2
// and reads back whether the caller convention actually used at both call
// sites in dispatch-worker.ps1 -- `$seatProofExit = Invoke-SeatProofGate
// ...; if ($seatProofExit -ne 0) { reject }` -- resolves to PASS or REJECT.
//
// Honesty limit (§2-3, same wording required in the result file): this
// only runs where PowerShell is actually installed (Windows, or pwsh on
// another OS). CI does not have that -- callers must treat "PowerShell not
// found" as an explicit skip with a printed reason, never a silent pass.
//
// I/O: this module DOES touch the filesystem (temp dirs, fake gate
// scripts) and DOES spawn a child process -- unlike the pure fingerprint/
// shape judges, it cannot be a pure function. Every temp artifact is
// written under the OS temp dir and removed in a `finally`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const FAKE_GATE_PROVEN_SCRIPT = [
  'console.log("SEAT_PROOF: PROVEN/PROVEN");',
  "process.exit(0);",
].join("\n");

export const FAKE_GATE_UNPROVEN_SCRIPT = [
  'console.log("SEAT_PROOF: UNPROVEN/UNPROVEN reason=FAKE_GATE_REJECT");',
  "process.exit(2);",
].join("\n");

const PS_CANDIDATES = ["pwsh", "powershell.exe", "powershell"];

// Returns the first working PowerShell executable name, or null if none is
// on PATH. Cached per-process call (cheap enough not to bother memoizing
// across calls -- each is a single fast `-Command` invocation).
export function findPowerShell() {
  for (const candidate of PS_CANDIDATES) {
    try {
      execFileSync(
        candidate,
        ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function psQuote(path) {
  return path.replace(/`/g, "``").replace(/"/g, '`"');
}

// Runs `functionDefinitionText` (a full `function Invoke-SeatProofGate(...)
// { ... }` block) in a real PowerShell process, wired to a fake gate CLI
// (`gateFlavorScript`, one of FAKE_GATE_*_SCRIPT above) at exactly the path
// the real function joins ($Worktree +
// "scripts/relay/dispatch-worker-seat-proof-gate.mjs"), then calls it with
// the SAME caller convention dispatch-worker.ps1 uses at both of its call
// sites and reports whether that convention read it as PASS or REJECT.
//
// Returns one of: "PASS", "REJECT", or a string starting with "ERROR:"
// (the harness itself failed -- e.g. a PowerShell parse error in the
// candidate function text) so a bad fixture cannot be silently miscounted
// as either behavioral outcome.
export function runWrapperBehavior(
  functionDefinitionText,
  gateFlavorScript,
  psExe,
) {
  const exe = psExe ?? findPowerShell();
  if (!exe) {
    throw new Error(
      "runWrapperBehavior: no PowerShell executable found on PATH -- call findPowerShell() first and skip with a reason instead of calling this",
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "seat-proof-behavior-"));
  try {
    const relayDir = join(dir, "scripts", "relay");
    mkdirSync(relayDir, { recursive: true });
    const gatePath = join(relayDir, "dispatch-worker-seat-proof-gate.mjs");
    writeFileSync(gatePath, gateFlavorScript, "utf8");

    // HYK-415-canonical-sync-2: the post-HYK-271 canonical body (and any
    // candidate text that copies its modal-check call) reaches a second
    // script, scripts/relay/dispatch-worker-modal-check.mjs, at the same
    // $Worktree-relative path the real wrapper joins. This harness stands
    // in a stub that always reports NON_MODAL/exit 0 -- same role as
    // FAKE_GATE_PROVEN_SCRIPT above (a fixture stand-in, not the
    // production script), so a candidate function's PASS/REJECT reading of
    // *its own* gate call stays what this harness actually tests; the
    // modal-check axis's own detection logic is covered separately by
    // dispatch-worker-modal-check.test.mjs, not here. Written
    // unconditionally: candidate texts that never call this path (all the
    // synthetic BYPASS_FORMS/SAFE_FORMS bodies, which predate HYK-271)
    // simply never touch this file.
    const modalCheckPath = join(relayDir, "dispatch-worker-modal-check.mjs");
    writeFileSync(
      modalCheckPath,
      [
        'console.log("dispatch-worker-modal-check: NON_MODAL (fake, always clean)");',
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );

    const dsShowPath = join(dir, "ds-show.json");
    const tsShowPath = join(dir, "ts-show.json");
    writeFileSync(dsShowPath, "{}", "utf8");
    writeFileSync(tsShowPath, "{}", "utf8");

    const harnessPath = join(dir, "harness.ps1");
    // Sets exactly the free variables the nine bypass forms (and the
    // canonical body) reference, then defines the candidate function and
    // calls it via dispatch-worker.ps1's real caller convention (both call
    // sites: `$seatProofExit = Invoke-SeatProofGate ...; if
    // ($seatProofExit -ne 0) { reject }`).
    const harness = [
      `$ErrorActionPreference = "Continue"`,
      // The real dispatch-worker.ps1 defines Norm() to convert backslash
      // paths to orca's forward-slash convention; the canonical body calls
      // `(Norm $Worktree)`, so the harness needs a stand-in with the same
      // signature (identity is fine -- this test only cares whether the
      // call reads exit code correctly, not the exact string it prints).
      `function Norm([string]$p) { return $p -replace "\\\\", "/" }`,
      `$Worktree = "${psQuote(dir)}"`,
      `$node = "node"`,
      `$Task = "T"`,
      `$label = "L"`,
      `$handle = "H"`,
      `$dispatchId = "D"`,
      `$dsShowPath = "${psQuote(dsShowPath)}"`,
      `$tsShowPath = "${psQuote(tsShowPath)}"`,
      "",
      functionDefinitionText,
      "",
      `$seatProofExit = Invoke-SeatProofGate $dispatchId`,
      `if ($seatProofExit -ne 0) { Write-Output "BEHAVIOR_RESULT:REJECT" } else { Write-Output "BEHAVIOR_RESULT:PASS" }`,
    ].join("\n");
    writeFileSync(harnessPath, harness, "utf8");

    let stdout = "";
    let stderr = "";
    try {
      stdout = execFileSync(
        exe,
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
        { encoding: "utf8" },
      );
    } catch (err) {
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? String(err.message ?? err);
    }

    if (/BEHAVIOR_RESULT:PASS/.test(stdout)) return "PASS";
    if (/BEHAVIOR_RESULT:REJECT/.test(stdout)) return "REJECT";
    return `ERROR:${(stdout + stderr).slice(0, 500)}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
