import {
  checkRelayHandshake,
  RESULT_BLOCK_STATE,
} from "../check/relay-handshake.mjs";
import { TIME_AUTHORITY_STATE } from "../check/time-authority.mjs";

// Single declarations (C.7): every default and every exit code this module
// hands out traces back to exactly one of these, never a repeated literal.
export const DEFAULT_INTERVAL_S = 60;
export const DEFAULT_KEEPALIVE_S = 240;
export const EXIT_DONE = 0;
export const EXIT_TICK = 3;
// HYK-136: distinct from EXIT_DONE(0)/EXIT_TICK(3) -- a confirmed config
// error must never be reported the same way as either "done" or "still
// waiting," or a caller script branching on exit code alone (the 07-14/17
// incident: PM DONE went undetected because a malformed --harness-dir
// silently fell back to the wrong directory and just kept ticking forever).
export const EXIT_CONFIG_INVALID = 4;
// HYK-160-coder-2 (review-1 결함 1 수리): a reason outside the fixed
// CONFIG/PENDING pattern lists means this module genuinely does not know
// whether waiting helps -- design §3.1 requires that state to be reported
// as UNJUDGABLE and NOT retried forever. coder-1 silently folded
// "unjudgable" into the same "keep polling" bucket as "pending," so a
// checkRelayHandshake reason string this module's fixtures don't cover
// (e.g. a future parser change) polled indefinitely with no exit path at
// all in plain mode (maxWaitS=0) -- exactly the review-1 repro
// (`watchResult({maxWaitS:1, checkFn:() => ({ok:false,
// reason:'unexpected handshake parser shape'})})` never terminated).
export const EXIT_UNJUDGABLE = 5;
// HYK-173-escalation-2 (REVIEW 반려 (3) 수리): checkRelayHandshake의
// `result.state`(HYK-173-escalation-1)가 여태 이 저장소의 어떤 생산
// 소비자에게도 읽히지 않았다 -- 판정 장치는 있는데 아무도 안 읽는 상태
// (REVIEW 실측: watch-result.mjs/relay-core.mjs/orch-stall-detect.mjs 전부
// reason 문자열만 보고 state를 무시). 이 라운드는 그 소비자를 정확히
// 하나만 이 모듈에 결선한다(coder-task.md §2-2 "딱 하나만" -- 범위 폭발
// 방지, orch-stall-detect.mjs는 다른 트랙 HYK-207 표면이라 손대지 않음).
// EXIT_DONE(0)/EXIT_TICK(3)/EXIT_CONFIG_INVALID(4)/EXIT_UNJUDGABLE(5)
// 어느 것과도 겹치지 않는 새 코드 -- "막힘"을 "아직 진행 중"이나 "형태를
// 모르는 실패"와 같은 코드로 접지 않는다는 이 파일의 기존 원칙을 그대로
// 확장한다. ⛔자동 재개·자동 조치는 여전히 0 -- 이 모듈은 계속 상태를
// 보고하고 종료할 뿐이다.
export const EXIT_BLOCKED = 6;
// HYK-186 §2 완료조건4/5: a future-dated dropped_at/DONE timestamp
// (`TIME_AUTHORITY_STATE.FUTURE_DROPPED_AT`/`FUTURE_DONE`, time-authority.mjs)
// is its own distinct family -- it must never fall through to `pending`
// (that would resume infinite polling, exactly the "미래로 -> 무한 대기"
// half of the §1 실사례 table this task exists to close) nor collapse into
// the pre-existing `blocked` family above (that family is worker-signaled
// intent; this one is an authority-clock rejection of a machine-parsed
// timestamp -- a different failure shape with a different fix: the header
// is wrong, not "the worker is stuck"). A new, non-overlapping exit code.
export const EXIT_FUTURE_REJECTED = 7;

// checkRelayHandshake's `ok:false` reasons fall into three families this
// module must never confuse (HYK-136/HYK-160-coder-2 게이트 계약): a CONFIG
// reason means the inputs themselves are wrong -- no amount of waiting
// fixes a task file that doesn't exist or has no task_id header, so
// polling on it forever is a silent hang, not patience. A PENDING reason
// means the inputs are fine and the worker just hasn't finished yet -- the
// normal, expected wait state, safe to keep polling. Anything not matching
// either list is UNJUDGABLE (honesty: this module does not claim to
// classify every possible checkRelayHandshake failure string, only the
// ones its own known-bad/good fixtures cover) and MUST terminate the loop
// with its own distinct status/exit rather than being silently treated as
// either safe-to-retry pending or a confirmed config error.
const CONFIG_REASON_PATTERNS = [
  /^task file not found/,
  /^task file missing task_id header/,
  /^task file missing dropped_at header/,
  /^task dropped_at not parseable/,
  // HYK-180 사이클1: a `task_id:` token that exists but isn't a standalone
  // line at column 0 is a structural violation of the result file, not a
  // worker-still-writing state -- no amount of polling fixes it, so it must
  // classify as config (terminal), never fold into pending's silent
  // infinite-poll bucket the way the anchored-miss case briefly did.
  /^result task_id echo not at line start/,
];
const PENDING_REASON_PATTERNS = [
  /^result file not found/,
  /^handshake mismatch/,
  /^result missing ">>> DONE/,
  // HYK-172 결함5: task_id 에코 이전 "쓰는 중" 결과파일은 진짜로 망가진
  // 것이 아니라 DONE 라인 누락과 대칭인 미완결 substate다 -- config나
  // unjudgable이 아니라 pending으로 폴링을 유지해야 한다. (정직 한계:
  // 이는 재분류일 뿐, "쓰는 중 vs 진짜로 망가진 파일"을 mtime/size/lock
  // 같은 시간축 신호로 구별하지 않는다 -- 그 견고화는 HYK-136 계열 후속.)
  /^result missing task_id echo/,
  /^stale result/,
];

export function classifyWatchFailure(reason) {
  if (typeof reason !== "string") return "unjudgable";
  if (CONFIG_REASON_PATTERNS.some((re) => re.test(reason))) return "config";
  if (PENDING_REASON_PATTERNS.some((re) => re.test(reason))) return "pending";
  return "unjudgable";
}

// HYK-173-escalation-2 (§2-2): every non-PENDING state
// checkRelayHandshake's RESULT_BLOCK_STATE can produce belongs to the
// "blocked family" this module now reports as its own distinct `blocked`
// status -- BLOCKED/NEEDS_INPUT (explicit worker signal) as well as
// MALFORMED_BLOCKED/AMBIGUOUS_BLOCKED (an attempted marker that is broken
// or ambiguous). All four share the same fail-closed posture: none of them
// is "still safely pending," so none may fall through to the old
// reason-string classification's `pending` bucket. `RESULT_BLOCK_STATE.NONE`
// and the absent-state case (a plain missing-DONE PENDING result carries no
// `state` field distinct from this set) are deliberately excluded --
// PENDING keeps going through the existing classifyWatchFailure path
// unchanged (regression 0 on the pre-existing pending/config/unjudgable
// split, per relay-handshake.test.mjs (y)/1R's DONE-wins invariant).
const BLOCKED_FAMILY_STATES = new Set([
  RESULT_BLOCK_STATE.BLOCKED,
  RESULT_BLOCK_STATE.NEEDS_INPUT,
  RESULT_BLOCK_STATE.MALFORMED_BLOCKED,
  RESULT_BLOCK_STATE.AMBIGUOUS_BLOCKED,
]);

export function isBlockedFamilyState(state) {
  return typeof state === "string" && BLOCKED_FAMILY_STATES.has(state);
}

// HYK-186 §5 변조5 대상: the one place a `TIME_AUTHORITY_STATE` value is
// consulted by any consumer in this repo. Remove this call (or the wiring
// below that uses it) and a future-dated result stops being reported as
// `future_rejected`/EXIT_FUTURE_REJECTED and instead falls through to
// classifyWatchFailure's reason-string patterns -- which do not recognize
// this module's "'<field>' value ... is ...s ahead of authority now ..."
// reason text at all, so it lands on the catch-all `unjudgable` bucket
// (§3 "새 사유를 결선하지 않으면 UNJUDGABLE로만 끝난다").
const FUTURE_REJECTED_STATES = new Set([
  TIME_AUTHORITY_STATE.FUTURE_DROPPED_AT,
  TIME_AUTHORITY_STATE.FUTURE_DONE,
]);

export function isFutureRejectedState(state) {
  return typeof state === "string" && FUTURE_REJECTED_STATES.has(state);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One checkFn result -> either a terminal loop outcome (done/config/
// unjudgable) or null ("keep polling" -- only for a genuinely transient
// checkFn throw or a classified-pending reason). Extracted from
// watchResult's own loop body (quality-check: keeps watchResult's own
// complexity under the repo's ESLint ceiling).
//
// `result.threw` (set only by runCheck's catch branch below) is the one
// case that bypasses classification entirely: a thrown error is a
// transient read failure, not a reason string at all, and this module's
// existing contract ("checkFn throwing is treated the same as an `ok:
// false` result... a transient error mid-poll is not done yet, not a
// crash") must keep polling through it -- never terminate on a throw the
// way a classified-unjudgable *reason* now does (review-1 결함 1's fix
// does not change throw-handling, only clean ok:false reasons).
function resolveCheckOutcome(result, elapsedS) {
  if (result.ok) {
    return { status: "done", reason: result.reason, elapsedS };
  }
  if (result.threw) {
    return null;
  }
  // HYK-173-escalation-2 (§2-2): checked before the old reason-string
  // classification -- an explicit BLOCKED/NEEDS_INPUT/MALFORMED_BLOCKED/
  // AMBIGUOUS_BLOCKED `state` is a stronger, structured signal than the
  // reason-string patterns below and must not be reduced back down to
  // whatever bucket its reason text happens to string-match (today that
  // would be "unjudgable" for BLOCKED/NEEDS_INPUT -- REVIEW's exact
  // complaint: the state exists but nothing reads it). DONE still wins
  // unconditionally (the `result.ok` branch above returns first, and
  // checkRelayHandshake never sets `state` alongside `ok:true`), so this
  // does not touch the "DONE wins" priority 1R's test (y) already froze.
  // HYK-186: checked before the blocked-family/reason-string classification
  // below -- a future-rejected state is a stronger, structured signal (an
  // authority-clock verdict on a parsed timestamp) than either the worker-
  // signaled blocked family or the plain reason-string patterns, and must
  // report its own distinct status/exit rather than being folded into either.
  if (isFutureRejectedState(result.state)) {
    return {
      status: "future_rejected",
      state: result.state,
      reason: `WATCH_FUTURE_REJECTED: ${result.state}: ${result.reason}`,
      elapsedS,
    };
  }
  if (isBlockedFamilyState(result.state)) {
    return {
      status: "blocked",
      state: result.state,
      reason: `WATCH_BLOCKED: ${result.state}: ${result.reason}`,
      elapsedS,
    };
  }
  const classification = classifyWatchFailure(result.reason);
  if (classification === "config") {
    return {
      status: "config",
      reason: `WATCH_CONFIG_INVALID: ${result.reason}`,
      elapsedS,
    };
  }
  if (classification === "unjudgable") {
    return {
      status: "unjudgable",
      reason: `WATCH_UNJUDGABLE: ${result.reason}`,
      elapsedS,
    };
  }
  return null;
}

// role/harnessDir: passed straight through to checkFn (default
// checkRelayHandshake -- role is the file-prefix form, e.g. "coder",
// matching `<role>-task.md`/`<role>.md`; harnessDir omitted lets
// checkRelayHandshake fall back to its own repo-root-relative default).
//
// intervalS: seconds between polls. maxWaitS: keep-alive tick threshold in
// seconds; 0 disables it entirely ("plain mode" -- poll indefinitely until
// done, meant for an unattended/away session with no ORCH turn to wake up).
//
// checkFn/sleepFn/nowFn: injection points, same rationale as every other
// check script's testability parameters (status-fresh.mjs's `headTime`,
// controlroom-fresh.mjs's `isGitRepoFn`/etc) -- a test drives the loop with
// a fake clock and a no-op sleep instead of waiting on real timers.
// checkFn throwing is treated the same as an `ok: false` result (a
// transient error mid-poll is "not done yet", not a crash) -- distinguishing
// error causes is left to whatever reads the loop's final report, not this
// loop itself.
export async function watchResult({
  role,
  harnessDir,
  intervalS = DEFAULT_INTERVAL_S,
  maxWaitS = DEFAULT_KEEPALIVE_S,
  checkFn = checkRelayHandshake,
  sleepFn = defaultSleep,
  nowFn = () => Date.now(),
} = {}) {
  const startedAt = nowFn();

  function runCheck() {
    try {
      return checkFn({ role, harnessDir });
    } catch (err) {
      return {
        ok: false,
        reason: `checkFn threw (treated as not done): ${err.message}`,
        threw: true,
      };
    }
  }

  // Immediate check before any sleep: a worker that was already done when
  // this loop started should exit on the spot, not wait a full interval
  // for no reason. Same immediacy applies to a confirmed config error --
  // fail-fast, never wait a tick to report a problem waiting can't solve.
  let outcome = resolveCheckOutcome(runCheck(), 0);
  if (outcome) return outcome;

  for (;;) {
    await sleepFn(intervalS * 1000);
    const elapsedS = Math.round((nowFn() - startedAt) / 1000);

    outcome = resolveCheckOutcome(runCheck(), elapsedS);
    if (outcome) return outcome;

    if (maxWaitS > 0 && elapsedS >= maxWaitS) {
      return {
        status: "tick",
        reason: `${role} not done after ${elapsedS}s (keep-alive tick)`,
        elapsedS,
      };
    }
  }
}

// Recognized space-separated flags only -- an `--flag=value` token (the
// 07-14/17 incident's actual shape: `--harness-dir=/some/path`) matches none
// of the `===` comparisons below and was previously silently ignored,
// leaving harnessDir undefined and the watcher pointed at the wrong default
// directory with no error at all. Detecting the unsupported shape up front
// and refusing immediately closes that hole; a caller must switch to the
// supported space-separated form (`--harness-dir /some/path`) instead.
const KNOWN_FLAGS = new Set([
  "--role",
  "--interval-s",
  "--max-wait-s",
  "--harness-dir",
]);

// Pure parse function (exported for tests, same testability convention as
// watchResult's injected checkFn/sleepFn/nowFn): never touches process.argv
// or process.exit itself, just turns argv into either a parsed options
// object or a config error.
export function parseWatchArgs(args) {
  let role;
  let intervalS = DEFAULT_INTERVAL_S;
  let maxWaitS = DEFAULT_KEEPALIVE_S;
  let harnessDir;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--") && arg.includes("=")) {
      const flagName = arg.slice(0, arg.indexOf("="));
      return {
        ok: false,
        reason: `unsupported '${flagName}=value' syntax ('${arg}') -- use '${flagName} value' (space-separated) instead`,
      };
    }
    if (arg.startsWith("--") && !KNOWN_FLAGS.has(arg)) {
      return { ok: false, reason: `unrecognized flag '${arg}'` };
    }
    if (arg === "--role") role = args[++i];
    else if (arg === "--interval-s") intervalS = Number(args[++i]);
    else if (arg === "--max-wait-s") maxWaitS = Number(args[++i]);
    else if (arg === "--harness-dir") harnessDir = args[++i];
  }
  return { ok: true, role, intervalS, maxWaitS, harnessDir };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/watch-result.mjs");
if (invokedDirectly) {
  const parsed = parseWatchArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`WATCH_CONFIG_INVALID: ${parsed.reason}`);
    process.exit(EXIT_CONFIG_INVALID);
  }
  const { role, intervalS, maxWaitS, harnessDir } = parsed;

  if (!role) {
    console.error(
      "usage: node watch-result.mjs --role <coder|review|verify> [--interval-s <n>] [--max-wait-s <n>] [--harness-dir <path>]",
    );
    process.exit(1);
  }

  const result = await watchResult({ role, harnessDir, intervalS, maxWaitS });
  if (result.status === "done") {
    console.log(`RESULT: ${role} done (${result.reason})`);
    process.exit(EXIT_DONE);
  } else if (result.status === "config") {
    console.error(result.reason);
    process.exit(EXIT_CONFIG_INVALID);
  } else if (result.status === "unjudgable") {
    console.error(result.reason);
    process.exit(EXIT_UNJUDGABLE);
  } else if (result.status === "blocked") {
    console.error(result.reason);
    process.exit(EXIT_BLOCKED);
  } else if (result.status === "future_rejected") {
    console.error(result.reason);
    process.exit(EXIT_FUTURE_REJECTED);
  } else {
    console.log(`TICK: ${result.reason}`);
    process.exit(EXIT_TICK);
  }
}
