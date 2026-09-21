// HYK-186 §2 완료조건2 -- the ONE supported normal producer for a result
// file's '>>> DONE:' line. Its whole contract is negative: it refuses any
// caller-supplied timestamp outright and always records the machine clock
// (Date.now()) at the moment it writes.
//
// ⚠️정직 한계 (§3 "절대 주장 금지"): this script does not and cannot prevent
// a human or an AI worker from hand-editing `<role>.md` and typing a
// '>>> DONE: ... @ <any time>' line directly (Edit tool, a text editor, `echo
// >>`, ...) -- same filesystem, same OS permissions, unverifiable at this
// layer. What this script DOES guarantee: any completion recorded THROUGH
// this supported path carries a timestamp this process itself read from its
// own clock, never one an argument asked it to write. It is the "명시 사유로
// 차단" half of §2's contract -- callerSuppliedAt !== undefined is refused
// with FINALIZE_DONE_REASON.CALLER_SUPPLIED_TIME_REJECTED, not silently
// accepted or silently ignored.
//
// Engine independence (§3 완료조건7): this is a plain Node CLI, invokable as
// `node scripts/relay/finalize-done.mjs <role> [harnessDir]` from any shell,
// cron job, or CI step -- nothing here depends on a Claude Code hook or any
// Claude-specific runtime. finalize-done.test.mjs's CLI-spawn tests exercise
// exactly this non-Claude path.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
// HYK-324/HYK-325 §2-1 (r2 수리: 검토 반려 P1): reuse relay-handshake.mjs's
// own "well-formed DONE line" contract -- DONE_RE for finding the line, and
// isWellFormedDoneTimestamp (== "파싱 가능 + 초 단위", relay-handshake's
// resolveDoneAt gate) for deciding whether it's malformed-and-replaceable --
// instead of inventing a second copy that could silently drift. r1 only
// reused hasDoneSecondsPrecision (not the parseability half), so a
// seconds-shaped-but-unparseable value (e.g. '2026-99-99 23:19:01 KST')
// was "not parseable" (replaceable) at the handshake but ALREADY_FINALIZED
// (not replaceable) here -- 검토 반려 원문 참조. r2: both sides now call
// the exact same exported function.
import {
  DONE_RE,
  DROPPED_AT_RE,
  isWellFormedDoneTimestamp,
  resolveResultTaskId,
  resolveLiveRoundFilePaths,
} from "../check/relay-handshake.mjs";
// HYK-332 §2: reuse reject-streak.mjs's own 'for:' cover-line regex and
// REVIEW-family test -- same reuse-not-reinvent instruction as the
// relay-handshake.mjs import above.
import { FOR_LINE_RE_G, isReviewFamilyRole } from "../check/reject-streak.mjs";
// HYK-353 2R §1 (P1-2): reuse first-observation.mjs's own generation-lookup
// (active vs tombstoned) instead of re-deriving the same logic here -- same
// reuse-not-reinvent instruction as the relay-handshake.mjs import above.
import {
  findFirstObservation,
  hasCorruptEntries,
} from "../check/first-observation.mjs";

const DONE_LINE_RE = /^>>>\s*DONE:/im;
// HYK-325 §2-1 (2회째 교체 금지): once finalizeDone has replaced one
// malformed stamp, this marker is what stops it from doing so a second
// time -- see the ALREADY_REPLACED branch below.
const SUPERSEDED_DONE_RE = /^superseded_done:/im;
// HYK-325 §2-3: appended on the line right after every '>>> DONE:' line
// this producer writes (both the normal path and the malformed-replace
// path) -- a non-column-0 meta line, so it is never mistaken for the
// '>>> DONE:' line itself by any parser (DONE_LINE_RE/DONE_RE both anchor
// on '>>>' at column 0). relay-handshake.mjs's DONE_STAMPED_BY_MARKER_RE
// (HYK-418 §2-1: now a fail-closed rejection, not just a warning) reads
// this same literal text -- keep the two in sync.
export const FINALIZE_DONE_MARKER_LINE = "done_stamped_by: finalize-done";

function pad(n) {
  return String(n).padStart(2, "0");
}

// HYK-418 §2-3: presence check for FINALIZE_DONE_MARKER_LINE (defined just
// above), reading it back from this file's OWN exported constant rather
// than a second regex copy -- see resolveExistingDoneLine's
// unmarkedWellFormedSingle comment for why this isn't a cross-import of
// relay-handshake.mjs's DONE_STAMPED_BY_MARKER_RE instead.
function hasFinalizeDoneMarker(content) {
  return content
    .split("\n")
    .some((rawLine) => rawLine.trim() === FINALIZE_DONE_MARKER_LINE);
}

// KST has no DST -- a fixed +9h offset from UTC is exact and stable, unlike
// relying on the host machine's local timezone setting.
function formatKst(nowMs) {
  const kst = new Date(nowMs + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(
    kst.getUTCDate(),
  )} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(
    kst.getUTCSeconds(),
  )} KST`;
}

export const FINALIZE_DONE_REASON = Object.freeze({
  CALLER_SUPPLIED_TIME_REJECTED: "CALLER_SUPPLIED_TIME_REJECTED",
  ROLE_INVALID: "ROLE_INVALID",
  HARNESS_DIR_INVALID: "HARNESS_DIR_INVALID",
  RESULT_FILE_NOT_FOUND: "RESULT_FILE_NOT_FOUND",
  ALREADY_FINALIZED: "ALREADY_FINALIZED",
  FINALIZED: "FINALIZED",
  // HYK-324/HYK-325 §2-1: a single malformed (e.g. minute-precision)
  // '>>> DONE:' line was found and replaced, exactly once.
  REPLACED_MALFORMED: "REPLACED_MALFORMED",
  // HYK-325 §2-1: a malformed line was already replaced once before --
  // refuses to replace again (no infinite re-issue).
  ALREADY_REPLACED: "ALREADY_REPLACED",
  // HYK-418 §2-3: a single format-VALID '>>> DONE:' line with no
  // `done_stamped_by: finalize-done` marker -- very likely hand-typed
  // (HYK-325's own diagnosis). Now that relay-handshake.mjs's consumer side
  // rejects exactly this shape (fail-closed, coder-task.md §2-1), a round
  // stamped this way had NO recovery path before this reason code existed
  // (finalize-done used to treat a format-valid line as ALREADY_FINALIZED
  // unconditionally -- the deadlock coder-task.md §1 요구4 names). Replaced
  // exactly once, same one-shot discipline as REPLACED_MALFORMED (guarded
  // by the same SUPERSEDED_DONE_RE check below -- see ALREADY_REPLACED).
  REPLACED_UNMARKED: "REPLACED_UNMARKED",
  // HYK-353 2R §1 (P1-2): a well-formed DONE line for this exact
  // (taskId, droppedAt) round was already recorded by the first-observation
  // channel (HYK-257-done-stamp-2) and has not yet been consumed -- the
  // current '>>> DONE:' line is malformed only because the result file was
  // rewritten AFTER that observation. Replacing it here would silently
  // launder a suspicious intermediate rewrite (defeats HYK-257's whole
  // point) instead of letting checkRelayHandshake's own
  // DONE_REWRITTEN_AFTER_FIRST_OBSERVATION rejection ever see it.
  ACTIVE_OBSERVATION_BLOCKED: "ACTIVE_OBSERVATION_BLOCKED",
  // HYK-353 3R (책임자 판정 2026-08-25 22:16, 범위 한 줄 한정): the
  // observation log has at least one line that fails to parse as JSON, so
  // whether THIS round has an active observation cannot be determined --
  // "판정 불가"(모름), distinct from ACTIVE_OBSERVATION_BLOCKED's "판정
  // 가능, 실제로 활성"(있음이 확인됨). Refused for the same reason: a
  // "모름"이 "없음"으로 조용히 접히면 손상된 흔적이 지워지고 새 DONE이
  // 찍힌다.
  OBSERVATION_LOG_UNDECIDABLE: "OBSERVATION_LOG_UNDECIDABLE",
  // HYK-332 §2: the result file's required 'task_id:' cover line (all
  // roles, coder-task.md §1⑴) is missing, ambiguous (2+ standalone
  // matches), or present but not a standalone column-0 line.
  HEADER_TASK_ID_MISSING: "HEADER_TASK_ID_MISSING",
  HEADER_TASK_ID_AMBIGUOUS: "HEADER_TASK_ID_AMBIGUOUS",
  HEADER_TASK_ID_MALFORMED: "HEADER_TASK_ID_MALFORMED",
  // HYK-332 §2: the result file's required 'for:' cover line (REVIEW-family
  // roles only, coder-task.md §1⑵) is missing or ambiguous.
  HEADER_FOR_MISSING: "HEADER_FOR_MISSING",
  HEADER_FOR_AMBIGUOUS: "HEADER_FOR_AMBIGUOUS",
});

// HYK-332 §2 요구1/2/3: called right after `existing` is read and before
// any DONE line is inspected/written -- refuses to stamp DONE on a result
// file that is missing a required cover line, and names exactly what's
// missing (0 matches vs 2+ ambiguous vs present-but-not-standalone), per
// coder-task.md §1's machine-verified consumer contract
// (relay-handshake.mjs's resolveResultTaskId / reject-streak.mjs's
// FOR_LINE_RE_G). `role:` is deliberately NOT checked here -- §1⑶ found it
// is not gated by any consumer, so making it required here would newly
// break existing well-formed result files that never wrote a `role:` line.
function checkRequiredHeaders({ existing, role, resultPath }) {
  const taskIdResult = resolveResultTaskId(existing);
  if (!taskIdResult.ok) {
    const reasonCode =
      taskIdResult.kind === "AMBIGUOUS"
        ? FINALIZE_DONE_REASON.HEADER_TASK_ID_AMBIGUOUS
        : taskIdResult.kind === "MID_LINE"
          ? FINALIZE_DONE_REASON.HEADER_TASK_ID_MALFORMED
          : FINALIZE_DONE_REASON.HEADER_TASK_ID_MISSING;
    return {
      ok: false,
      reasonCode,
      reason: `finalize-done refuses to stamp DONE: ${taskIdResult.reason} (${resultPath})`,
    };
  }

  if (isReviewFamilyRole(role)) {
    const forMatches = [...existing.matchAll(FOR_LINE_RE_G)];
    if (forMatches.length > 1) {
      return {
        ok: false,
        reasonCode: FINALIZE_DONE_REASON.HEADER_FOR_AMBIGUOUS,
        reason: `finalize-done refuses to stamp DONE: result has ${forMatches.length} standalone 'for:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve) (${resultPath})`,
      };
    }
    if (forMatches.length === 0) {
      return {
        ok: false,
        reasonCode: FINALIZE_DONE_REASON.HEADER_FOR_MISSING,
        reason: `finalize-done refuses to stamp DONE: REVIEW-family result missing required 'for:' cover line (need a standalone \`for: <id>\` line) (${resultPath})`,
      };
    }
  }

  return { ok: true };
}

// Extracted from finalizeDone (ESLint max-lines-per-function/complexity
// ceiling, HYK-148 house rule) -- decides what to do with a result file
// that ALREADY has a '>>> DONE:' line: replace it once (malformed, not yet
// replaced), refuse a second replace (ALREADY_REPLACED), or refuse outright
// (ALREADY_FINALIZED, the pre-HYK-324/325 behavior, unchanged for a
// format-valid stamp). Returns the finalizeDone-shaped result object;
// finalizeDone below only decides WHETHER to call this (does a DONE line
// exist at all) and performs the actual write.
//
// HYK-324/HYK-325 §2-1 (r2: isWellFormedDoneTimestamp, not just
// hasDoneSecondsPrecision -- 검토 반려 P1 수리): a '>>> DONE:' line already
// exists -- decide whether it's format-valid (reuse relay-handshake.mjs's
// own "파싱 가능 + 초 단위" contract wholesale, per coder-task.md's explicit
// "don't invent a new criterion" instruction) or eligible for a ONE-TIME
// replace. Only the exact shape this repo actually hits (exactly one
// DONE_RE match, format-invalid per that shared contract) is treated as
// malformed-and-replaceable; anything else (zero matches despite the loose
// DONE_LINE_RE test, or more than one DONE_RE match/ambiguous) falls back
// to the existing, conservative
// ALREADY_FINALIZED refusal -- this producer never guesses which line to
// touch when it can't tell.
// HYK-353 2R §1 (P1-2): "활성" 정의 -- 이 (taskId, droppedAt) 라운드의 첫
// 관측 항목이 first-observation.mjs의 관측 로그에 존재하고(recorded),
// 아직 소비 표시(tombstone, `markObservationConsumed`)가 없다. 이는
// `findFirstObservation`이 이미 구현한 바로 그 판정이다(HYK-257-done-
// stamp-3의 세대 구분 -- 소비까지 끝난 세대는 tombstone 이후 null을
// 반환해 "활성"에서 자동으로 빠진다, 재사용 그대로). taskId/droppedAt을
// 독립적으로 다시 구할 수 없으면(task 파일 없음/dropped_at 헤더 없음/
// 파싱 불가) 판정 불가로 fail-open한다 -- 이 새 게이트가 기존
// FINALIZED/ALREADY_REPLACED/malformed-replace 경로의 회귀를 만들지
// 않는다는 §3 요구를 지키기 위함이다(기존 시험들은 task 파일 없이
// finalizeDone을 직접 호출하는 경우가 많다).
function resolveActiveObservation({ existing, role, harnessDir }) {
  if (typeof harnessDir !== "string" || harnessDir.length === 0) return null;
  const taskIdResult = resolveResultTaskId(existing);
  if (!taskIdResult.ok) return null;
  const { taskPath } = resolveLiveRoundFilePaths(role, harnessDir);
  if (!existsSync(taskPath)) return null;
  let taskContent;
  try {
    taskContent = readFileSync(taskPath, "utf8");
  } catch {
    return null;
  }
  const droppedMatch = taskContent.match(DROPPED_AT_RE);
  if (!droppedMatch) return null;
  const droppedAt = droppedMatch[1].trim();
  // HYK-353 3R (책임자 판정 2026-08-25 22:16, 범위 한 줄 한정): "판정할 수
  // 없으면(손상·부분 파손 포함) 재발행을 거부한다" -- readEntries가
  // 손상된 줄을 조용히 건너뛰기 때문에, 손상된 줄이 정확히 이 라운드의
  // 관측이었어도 findFirstObservation은 그냥 null(= "관측 없음")을
  // 돌려준다. 이 라운드에 진짜 관측이 «없는» 경우(정당한 관측 전 첫
  // finalize)와 관측이 «있었는데 손상돼 못 읽은» 경우를 반드시 갈라야
  // 한다(§2 요구) -- 후자를 전자와 같이 취급하면 손상된 흔적을 조용히
  // 지우고 새 DONE을 찍게 된다. 손상 여부는 어느 (taskId, droppedAt)
  // 소속인지 알 수 없으므로 로그 파일 전체를 훑는다(hasCorruptEntries의
  // 헤더 참조) -- findFirstObservation 호출보다 먼저 확인해, 손상이
  // 있으면 그 판정 자체를 "모름"으로 접고 아래 active 판정을 아예
  // 신뢰하지 않는다.
  if (hasCorruptEntries(role, harnessDir)) {
    return {
      taskId: taskIdResult.id,
      droppedAt,
      entry: null,
      undecidable: true,
    };
  }
  const active = findFirstObservation({
    taskId: taskIdResult.id,
    droppedAt,
    role,
    harnessDir,
  });
  return active ? { taskId: taskIdResult.id, droppedAt, entry: active } : null;
}

function resolveExistingDoneLine({
  existing,
  resultPath,
  role,
  nowFn,
  harnessDir,
}) {
  // Checked BEFORE the malformed/valid split below: a file that already
  // underwent one replace must never be replaced again, regardless of
  // whether its CURRENT '>>> DONE:' line happens to look valid or
  // malformed -- the marker alone is what "already replaced" means.
  if (SUPERSEDED_DONE_RE.test(existing)) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.ALREADY_REPLACED,
      reason: `result file's malformed '>>> DONE:' line was already replaced once -- finalize-done only replaces a malformed stamp a single time (${resultPath})`,
    };
  }

  const doneMatches = [...existing.matchAll(DONE_RE)];
  const malformedSingle =
    doneMatches.length === 1 && !isWellFormedDoneTimestamp(doneMatches[0][1]);
  // HYK-418 §2-3: the other half of the deadlock coder-task.md §1 요구4
  // names -- a single line that IS format-valid but was never stamped
  // through this producer (no FINALIZE_DONE_MARKER_LINE anywhere in the
  // file). Reuses this same file's own exported marker-line constant
  // (hasFinalizeDoneMarker below) rather than duplicating the literal a
  // third time -- relay-handshake.mjs already keeps its own copy of this
  // regex in manual sync (see that file's DONE_STAMPED_BY_MARKER_RE
  // comment); a real cross-import here would be circular (relay-handshake
  // -> finalize-done -> relay-handshake, since finalize-done already
  // imports DONE_RE/isWellFormedDoneTimestamp/etc. FROM relay-handshake),
  // so this file instead re-derives presence from ITS OWN already-exported
  // constant, which cannot drift because there is nothing to keep in sync.
  const unmarkedWellFormedSingle =
    doneMatches.length === 1 &&
    isWellFormedDoneTimestamp(doneMatches[0][1]) &&
    !hasFinalizeDoneMarker(existing);

  if (!malformedSingle && !unmarkedWellFormedSingle) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.ALREADY_FINALIZED,
      reason: `result file already has a '>>> DONE:' line -- finalize-done never overwrites (${resultPath})`,
    };
  }

  // HYK-353 2R §1 (P1-2, widened HYK-418 §2-3): this line looks
  // replaceable -- either malformed, or format-valid but unmarked -- but if
  // an active (not-yet-consumed) first observation already exists for this
  // exact round, that shape is itself suspicious (the file was rewritten
  // AFTER a well-formed value was already seen) -- refuse the replace
  // instead of quietly producing a fresh, never-observed value. Same gate,
  // both callers: an unmarked hand-typed DONE overwriting an observed
  // machine-stamped one is exactly as suspicious as a malformed rewrite.
  const activeObservation = resolveActiveObservation({
    existing,
    role,
    harnessDir,
  });
  if (activeObservation?.undecidable) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.OBSERVATION_LOG_UNDECIDABLE,
      reason: `finalize-done refuses to replace this '>>> DONE:' line: the observation log for taskId='${activeObservation.taskId}' droppedAt='${activeObservation.droppedAt}' (first-observation.mjs) contains at least one line that failed to parse -- whether this round has an active observation cannot be determined, and "모름" must not be silently treated as "없음" (${resultPath})`,
    };
  }
  if (activeObservation) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.ACTIVE_OBSERVATION_BLOCKED,
      reason: `finalize-done refuses to replace this '>>> DONE:' line: an active (not yet consumed) first observation already exists for taskId='${activeObservation.taskId}' droppedAt='${activeObservation.droppedAt}' (first-observation.mjs) -- replacing it now would launder a suspicious post-observation rewrite instead of letting checkRelayHandshake's own intermediate-rewrite rejection see it (${resultPath})`,
    };
  }

  const supersededLine = doneMatches[0][0];
  const nowMs = nowFn();
  const line = `>>> DONE: ${role.toUpperCase()} @ ${formatKst(nowMs)}`;
  // Preserve the original line verbatim as a non-column-0
  // `superseded_done:` body line (never counted as a '>>> DONE:' cover
  // line by any parser -- DONE_LINE_RE/DONE_RE both anchor on '>>>' at
  // column 0, and this replacement text starts with 'superseded_done:')
  // then append the machine-stamped replacement, same as the normal path.
  const withSuperseded = existing.replace(
    supersededLine,
    `superseded_done: ${supersededLine}`,
  );
  const separator = withSuperseded.endsWith("\n") ? "" : "\n";
  writeFileSync(
    resultPath,
    `${withSuperseded}${separator}${line}\n${FINALIZE_DONE_MARKER_LINE}\n`,
    "utf8",
  );

  // HYK-418 §2-3: malformedSingle and unmarkedWellFormedSingle are mutually
  // exclusive (a malformed timestamp can never also be
  // isWellFormedDoneTimestamp), so exactly one of these two branches ran to
  // reach this point -- reasonCode/reason distinguish which recovery this
  // was for the caller/CLI (see the CLI's REPLACED_MALFORMED-vs-default
  // branch and the new REPLACED_UNMARKED branch below).
  return malformedSingle
    ? {
        ok: true,
        reasonCode: FINALIZE_DONE_REASON.REPLACED_MALFORMED,
        reason: `replaced malformed '>>> DONE:' line ('${supersededLine}') with machine-stamped '${line}' in ${resultPath} (original preserved as 'superseded_done:')`,
        line,
        supersededLine,
        nowMs,
      }
    : {
        ok: true,
        reasonCode: FINALIZE_DONE_REASON.REPLACED_UNMARKED,
        reason: `replaced unmarked (likely hand-typed) '>>> DONE:' line ('${supersededLine}') with machine-stamped '${line}' in ${resultPath} (original preserved as 'superseded_done:')`,
        line,
        supersededLine,
        nowMs,
      };
}

// finalizeDone({ role, harnessDir, callerSuppliedAt, nowFn }) ->
// { ok, reasonCode, reason, line?, nowMs? }
//
// `callerSuppliedAt`: MUST be omitted (undefined). Passing anything else --
// a string, a Date, a number, even a value equal to what the machine clock
// would have produced anyway -- is refused outright. There is no "accept if
// it matches now" leniency: the contract is "this producer does not read a
// caller-supplied time argument at all", not "this producer validates a
// caller-supplied time argument".
export function finalizeDone({
  role,
  harnessDir,
  callerSuppliedAt,
  nowFn = () => Date.now(),
} = {}) {
  if (callerSuppliedAt !== undefined) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.CALLER_SUPPLIED_TIME_REJECTED,
      reason:
        "finalize-done rejects caller-supplied timestamps -- this producer always records its own machine clock (Date.now()) at finalization time; do not pass callerSuppliedAt",
    };
  }
  if (typeof role !== "string" || role.length === 0) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.ROLE_INVALID,
      reason: "role must be a non-empty string",
    };
  }
  if (typeof harnessDir !== "string" || harnessDir.length === 0) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.HARNESS_DIR_INVALID,
      reason: "harnessDir must be a non-empty string",
    };
  }

  const resultPath = join(harnessDir, `${role}.md`);
  if (!existsSync(resultPath)) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.RESULT_FILE_NOT_FOUND,
      reason: `result file not found: ${resultPath}`,
    };
  }

  const existing = readFileSync(resultPath, "utf8");

  const headerCheck = checkRequiredHeaders({ existing, role, resultPath });
  if (!headerCheck.ok) {
    return headerCheck;
  }

  if (DONE_LINE_RE.test(existing)) {
    return resolveExistingDoneLine({
      existing,
      resultPath,
      role,
      nowFn,
      harnessDir,
    });
  }

  const nowMs = nowFn();
  const separator = existing.endsWith("\n") ? "" : "\n";
  const line = `>>> DONE: ${role.toUpperCase()} @ ${formatKst(nowMs)}`;
  appendFileSync(
    resultPath,
    `${separator}${line}\n${FINALIZE_DONE_MARKER_LINE}\n`,
    "utf8",
  );

  return {
    ok: true,
    reasonCode: FINALIZE_DONE_REASON.FINALIZED,
    reason: `wrote '${line}' to ${resultPath}`,
    line,
    nowMs,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/finalize-done.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  // No `--at`/timestamp-shaped flag is recognized at all -- unlike
  // watch-result.mjs's KNOWN_FLAGS allowlist (which accepts and validates
  // known flags), this CLI refuses even the ATTEMPT to pass a time, on sight.
  const timeFlagAttempt = args.find(
    (a) => a === "--at" || a.startsWith("--at="),
  );
  if (timeFlagAttempt) {
    console.error(
      `finalize-done rejects caller-supplied timestamps: '${timeFlagAttempt}' is not a supported flag (this CLI never accepts a time argument)`,
    );
    process.exit(1);
  }
  const [role, harnessDirArg] = args;
  if (!role) {
    console.error("usage: node finalize-done.mjs <role> [harnessDir]");
    process.exit(1);
  }
  const harnessDir = harnessDirArg ?? join(process.cwd(), ".harness");
  const result = finalizeDone({ role, harnessDir });
  if (result.ok) {
    // HYK-324/HYK-325 §2-1 (widened HYK-418 §2-3): distinguish "replaced a
    // malformed stamp" and "replaced an unmarked (hand-typed) stamp" from a
    // plain first-time finalize on stdout, so a caller/operator watching
    // the log can tell which happened without inspecting the file.
    if (result.reasonCode === FINALIZE_DONE_REASON.REPLACED_MALFORMED) {
      console.log(
        `REPLACED_MALFORMED: ${result.line} (superseded: ${result.supersededLine})`,
      );
    } else if (result.reasonCode === FINALIZE_DONE_REASON.REPLACED_UNMARKED) {
      console.log(
        `REPLACED_UNMARKED: ${result.line} (superseded: ${result.supersededLine})`,
      );
    } else {
      console.log(`FINALIZED: ${result.line}`);
    }
    process.exit(0);
  }
  console.error(result.reason);
  process.exit(1);
}
