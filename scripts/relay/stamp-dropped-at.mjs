// HYK-257 ⓐ -- the ONE supported machine-clock producer for a task file's
// `dropped_at` header. Mirrors finalize-done.mjs's (HYK-186) contract
// exactly, reused for the drop-time field: it refuses any caller-supplied
// timestamp outright and always stamps the machine clock (Date.now()) at
// the moment it is called. This is the "B 원칙" (HYK-186) applied to the
// second of the two hand-typed timestamps named in coder-task.md §1 --
// `dropped_at` had been selfishly hand-typed by ORCH 4 times (08-12~08-14),
// producing an "estimate, not a reading" value that relay-handshake.mjs's
// future-skew check caught every time, at the cost of a lost round.
//
// ⚠️정직 한계 (§3 "절대 주장 금지"): this script does not and cannot stop a
// human or an AI from hand-typing `dropped_at: <any time>` directly into a
// task file (Edit tool, a text editor, ...) -- same filesystem, same OS
// permissions, unverifiable at this layer. What it guarantees is narrower:
// any value produced THROUGH this script is read from its own clock, never
// from an argument that asked it to write something else.
//
// ⚠️결선 한계 (coder-task.md §2 제약1 비타협): this round does not wire this
// script into 관제실 dispatch-worker.ps1 (그 파일은 이 라운드에서 수정
// 금지) -- the exact call the wrapper should make is documented in
// .harness/coder.md (결과 파일) for ORCH to review and wire separately.
//
// Engine independence (coder-task.md §2 제약5): plain Node CLI, invokable as
// `node scripts/relay/stamp-dropped-at.mjs` from any shell/cron/CI step --
// nothing here depends on a Claude Code hook or any Claude-specific runtime.
//
// HYK-257-done-stamp-lint-1: the pure formatting/contract logic now lives in
// scripts/check/dropped-at-stamp-core.mjs (moved, not duplicated) so
// scripts/check/dispatch-gate-decision.mjs can use it without importing
// across the scripts/check -> scripts/relay boundary (that direction is an
// ESLint no-restricted-imports error -- A3 inventory, HYK-148: "real
// dependency direction is relay -> check only"). This file re-exports both
// symbols unchanged (relay -> check is the allowed direction) so every
// existing external import of `stampDroppedAt`/`STAMP_DROPPED_AT_REASON`
// from THIS file keeps working byte-for-byte -- a pure move, zero behavior
// change (this round's §3 요건1).
import {
  stampDroppedAt,
  STAMP_DROPPED_AT_REASON,
} from "../check/dropped-at-stamp-core.mjs";
export { stampDroppedAt, STAMP_DROPPED_AT_REASON };

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/stamp-dropped-at.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  // No `--at`/timestamp-shaped flag is recognized at all -- mirrors
  // finalize-done.mjs's CLI: refuses even the ATTEMPT to pass a time, on
  // sight, before anything else runs.
  const timeFlagAttempt = args.find(
    (a) => a === "--at" || a.startsWith("--at="),
  );
  if (timeFlagAttempt) {
    console.error(
      `stamp-dropped-at rejects caller-supplied timestamps: '${timeFlagAttempt}' is not a supported flag (this CLI never accepts a time argument)`,
    );
    process.exit(1);
  }
  const result = stampDroppedAt({});
  console.log(`DROPPED_AT: ${result.value}`);
  process.exit(0);
}
