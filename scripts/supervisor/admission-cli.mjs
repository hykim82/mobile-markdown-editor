// HYK-224 (coder-task.md §3, 1-B 3요건) -- CLI shell wiring
// admission-ledger-core.mjs (판정) + admission-ledger-store.mjs (원자 I/O)
// into the exact contract 관제실 `dispatch-worker.ps1` calls before every
// `orca orchestration dispatch`. "판단은 저장소, 관제실은 얇은 껍데기"
// (coder-task §4) -- this file is that 저장소 side: dispatch-worker.ps1
// only shells out to `node admission-cli.mjs admit ...` and branches on the
// output line + exit code below, it computes nothing itself.
//
// Output/exit contract (coder-task §3 table, byte-for-byte):
//   여유 있음   -> stdout: "CAP_ADMITTED reservation=<id> active_before=<n> cap=<cap>"  exit 0
//   상한 도달   -> stdout: "CAP_BLOCKED active=<n> cap=<cap>"                            exit 3
//   상태 불가   -> stdout: "CAP_STATE_UNAVAILABLE reason=<code>"                         exit 4
// (exit 0 is reserved for ADMITTED/ALREADY_ADMITTED only -- BLOCKED and
// STATE_UNAVAILABLE are always nonzero so a caller that merely checks
// `$LASTEXITCODE -ne 0` already does the safe thing without parsing text.)
import {
  admitReservation,
  completeReservation,
  sweepAndRecover,
  buildCutoverLedger,
  countActive,
  createEmptyLedger,
} from "./admission-ledger-core.mjs";
import {
  withLedgerLock,
  readLedgerUnlocked,
} from "./admission-ledger-store.mjs";
import { readConcurrencyCap } from "./concurrency-cap-adapter.mjs";

const EXIT = Object.freeze({
  OK: 0,
  BLOCKED: 3,
  STATE_UNAVAILABLE: 4,
  USAGE: 2,
});

// HYK-306 (coder-task.md §4-1): 2026-08-18 관제실이 `-GoLabel`을 빠뜨리자
// dispatch-worker.ps1이 조용히 런타임 id(`$Task`, `task_...` 모양)를 하네스
// 이름표 자리에 채워 넣었다(관제실 197행 `$label = if ($GoLabel) {...} else
// {$Task}`). 그 값이 흘러오는 첫 지점이 이 CLI의 `--reservation-id`다(ps1
// 220행, `orca orchestration dispatch` 호출 «전») -- 그래서 여기가 배달을
// 막을 수 있는 가장 이른 지점이고, "판단은 저장소" 원칙(coder-task §2)에
// 따라 판정 로직 전부를 여기 둔다. 관제실 쪽 수정은 그 조용한 대체 한
// 줄을 없애는 것뿐이다(§2, docs/control-room-patches/HYK-306-*.md).
// 런타임 id 모양 검사는 `orca orchestration dispatch-show`가 실제로 내는
// id 형식(`task_` + 16진수, 예 `task_ac822047b14d`)을 실측해 고정했다.
const RUNTIME_TASK_ID_SHAPE = /^task_[0-9a-f]+$/i;

// { ok: true } | { ok: false, reason: <사람이 읽고 바로 원인을 알 수 있는 문장> }
function validateHarnessLabel(label) {
  if (!label) {
    return {
      ok: false,
      reason:
        "--reservation-id is required -- dispatch-worker.ps1 must pass the harness task label (-GoLabel <HYK-...-N>), it cannot be omitted",
    };
  }
  if (RUNTIME_TASK_ID_SHAPE.test(label)) {
    return {
      ok: false,
      reason: `--reservation-id '${label}' looks like an orca runtime task id (task_...), not a harness label -- pass -GoLabel <HYK-...-N> explicitly instead of letting it fall back to the runtime id`,
    };
  }
  return { ok: true };
}

// exported for tests that want to check the shape rule without shelling out
export { validateHarnessLabel };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else {
      out._.push(a);
    }
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function printStateUnavailable(reasonCode, detail) {
  console.log(`CAP_STATE_UNAVAILABLE reason=${reasonCode}`);
  if (detail) console.error(`CAP_STATE_UNAVAILABLE detail: ${detail}`);
}

// admit -- the ONE call on 관제실's critical path (before `orca
// orchestration dispatch`). A read-missing ledger is STATE_UNAVAILABLE, not
// an implicit "cap=0 in flight" -- an uninitialized epoch must be cut over
// explicitly (init-cutover) before any admission can be judged, so a
// misconfigured/never-initialized ledger path fails closed instead of
// silently admitting past a phantom empty cap.
// resolveAdmitCap -- reuses concurrency-cap-adapter.mjs's own fail-closed
// schema check (HYK-193 S-5: "값의 출처가 한용이어야 한다", never a
// code-side default like 2) instead of re-deriving cap-reading logic here.
// Returns `{ok:true, cap}` or `{ok:false, reasonCode, detail}`.
function resolveAdmitCap({ cap, capPath }) {
  if (!capPath) return { ok: true, cap: Number(cap) };
  const capRead = readConcurrencyCap({ capPath });
  if (!capRead.ok) {
    return {
      ok: false,
      reasonCode: `CAP_VALUE_${capRead.reason}`,
      detail: capRead.detail,
    };
  }
  return { ok: true, cap: capRead.cap };
}

// admitTransition -- the withLedgerLock callback body, extracted to keep
// cmdAdmit's own line count under the repo's ESLint ceiling (quality-check);
// no behavior change from the inline version.
function admitTransition(
  readResult,
  { reservationId, capNum, now, role, seatKey },
) {
  if (!readResult.ok) {
    return {
      result: {
        kind: "state_unavailable",
        reasonCode: readResult.reasonCode,
        detail: readResult.detail,
      },
      nextLedger: null,
    };
  }
  const admit = admitReservation(readResult.ledger, {
    reservationId,
    cap: capNum,
    now,
    role: role ?? null,
    seatKey: seatKey ?? null,
  });
  if (!admit.ok) {
    return {
      result: {
        kind: "state_unavailable",
        reasonCode: admit.reasonCode,
        detail: "admitReservation rejected the current ledger",
      },
      nextLedger: null,
    };
  }
  return {
    result: {
      kind: "decision",
      decision: admit.decision,
      active: admit.active,
      activeBefore: admit.activeBefore,
    },
    nextLedger: admit.decision === "BLOCKED" ? null : admit.ledger,
  };
}

// resolveDebugLockOptions -- test-support only, extracted to keep cmdAdmit's
// own cyclomatic complexity under the repo's ESLint ceiling (quality-check);
// no behavior change from the inline version.
function resolveDebugLockOptions(args) {
  const debugDelayMs = args["debug-delay-ms"]
    ? Number(args["debug-delay-ms"])
    : 0;
  const lockOptions = { criticalSectionDelayMs: debugDelayMs };
  if (args["stale-lock-ms"] !== undefined) {
    lockOptions.staleLockMs = Number(args["stale-lock-ms"]);
  }
  if (args["lock-timeout-ms"] !== undefined) {
    lockOptions.lockTimeoutMs = Number(args["lock-timeout-ms"]);
  }
  return lockOptions;
}

function cmdAdmit(args) {
  const {
    ledger: ledgerPath,
    lock: lockPath,
    "reservation-id": reservationId,
    cap,
    "cap-path": capPath,
    role,
    "seat-key": seatKey,
  } = args;
  if (!ledgerPath || !lockPath || (!cap && !capPath)) {
    console.error(
      "usage: admit --ledger <path> --lock <path> --reservation-id <id> (--cap <n> | --cap-path <concurrency-cap.json>) [--role <r>] [--seat-key <k>]",
    );
    return EXIT.USAGE;
  }
  const labelCheck = validateHarnessLabel(reservationId);
  if (!labelCheck.ok) {
    console.error(`admit: ${labelCheck.reason}`);
    return EXIT.USAGE;
  }
  const capResolved = resolveAdmitCap({ cap, capPath });
  if (!capResolved.ok) {
    printStateUnavailable(capResolved.reasonCode, capResolved.detail);
    return EXIT.STATE_UNAVAILABLE;
  }
  const capNum = capResolved.cap;
  const now = nowIso();
  const outcome = withLedgerLock(
    ledgerPath,
    lockPath,
    (readResult) =>
      admitTransition(readResult, {
        reservationId,
        capNum,
        now,
        role,
        seatKey,
      }),
    resolveDebugLockOptions(args),
  );

  if (!outcome.ok) {
    printStateUnavailable(outcome.reasonCode, outcome.detail);
    return EXIT.STATE_UNAVAILABLE;
  }
  const { result } = outcome;
  if (result.kind === "state_unavailable") {
    printStateUnavailable(result.reasonCode, result.detail);
    return EXIT.STATE_UNAVAILABLE;
  }
  if (result.decision === "BLOCKED") {
    console.log(`CAP_BLOCKED active=${result.active} cap=${capNum}`);
    return EXIT.BLOCKED;
  }
  console.log(
    `CAP_ADMITTED reservation=${reservationId} active_before=${result.activeBefore} cap=${capNum}`,
  );
  return EXIT.OK;
}

// complete -- called by the neutral consumer (relay-handshake.mjs's
// checkRelayHandshake, coder-task §1 항 2), never by the worker itself.
function cmdComplete(args) {
  const {
    ledger: ledgerPath,
    lock: lockPath,
    "reservation-id": reservationId,
  } = args;
  if (!ledgerPath || !lockPath || !reservationId) {
    console.error(
      "usage: complete --ledger <path> --lock <path> --reservation-id <id>",
    );
    return EXIT.USAGE;
  }
  const now = nowIso();
  const outcome = withLedgerLock(ledgerPath, lockPath, (readResult) => {
    if (!readResult.ok) {
      return {
        result: {
          kind: "state_unavailable",
          reasonCode: readResult.reasonCode,
        },
        nextLedger: null,
      };
    }
    const complete = completeReservation(readResult.ledger, {
      reservationId,
      now,
    });
    if (!complete.ok) {
      return {
        result: { kind: "state_unavailable", reasonCode: complete.reasonCode },
        nextLedger: null,
      };
    }
    return {
      result: { kind: "ok", changed: complete.changed },
      nextLedger: complete.changed ? complete.ledger : null,
    };
  });
  if (!outcome.ok) {
    printStateUnavailable(outcome.reasonCode, outcome.detail);
    return EXIT.STATE_UNAVAILABLE;
  }
  if (outcome.result.kind === "state_unavailable") {
    printStateUnavailable(outcome.result.reasonCode);
    return EXIT.STATE_UNAVAILABLE;
  }
  console.log(
    `CAP_COMPLETED reservation=${reservationId} changed=${outcome.result.changed}`,
  );
  return EXIT.OK;
}

// HYK-317 (coder-task.md §2-2): --live-seats 항목은 원장의 seat_key와 같은
// 축(paneKey, `${tabId}:${leafId}`)이어야 한다. 오늘 밤 ORCH가 손으로
// sweep을 돌리며 여기에 orca terminal handle(`term_...`) 목록을 넣어 진행
// 중이던 좌석의 자리표가 회수된 실사고(coder-task §1)가 실제로 났다 --
// 그 정확한 입력 모양을 여기서 거부한다(fail-closed: 조용히 도는 것보다
// 멈추는 게 낫다).
// ★정직 한계: 이 검사는 **모양만** 본다(handle 접두어 `term_`) -- "맞는
// 좌석 목록인지"는 이 검사로 알 수 없다. 오늘 사고처럼 형식은 맞는데
// (paneKey 모양인데) 목록 자체가 불완전한 경우는 여전히 못 잡는다.
const HANDLE_SHAPE = /^term_/i;
function findHandleShapedSeat(liveSeatKeys) {
  return liveSeatKeys.find(
    (k) => typeof k === "string" && HANDLE_SHAPE.test(k),
  );
}

// sweep -- 비정상 종료 회수 (coder-task §2 "비정상 종료 SUSPECT·복구").
// `--live-seats` is a JSON array of seat keys, caller-observed ground truth
// (this CLI never queries `orca` itself -- I/O 0 discipline extended to "no
// opinions about how liveness is observed", matching judgeConcurrency's
// inFlight injection pattern).
function cmdSweep(args) {
  const {
    ledger: ledgerPath,
    lock: lockPath,
    "live-seats": liveSeatsJson,
    "stale-after-ms": staleAfterMs,
    "recovery-grace-ms": recoveryGraceMs,
  } = args;
  if (!ledgerPath || !lockPath || !liveSeatsJson) {
    console.error(
      "usage: sweep --ledger <path> --lock <path> --live-seats <json-array> [--stale-after-ms <n>] [--recovery-grace-ms <n>]",
    );
    return EXIT.USAGE;
  }
  let liveSeatKeys;
  try {
    liveSeatKeys = JSON.parse(liveSeatsJson);
  } catch {
    console.error("sweep: --live-seats must be a JSON array of strings");
    return EXIT.USAGE;
  }
  if (Array.isArray(liveSeatKeys)) {
    const badSeat = findHandleShapedSeat(liveSeatKeys);
    if (badSeat) {
      console.error(
        `sweep: --live-seats contains a handle-shaped entry ('${badSeat}') -- pass paneKey values (tabId:leafId, matching the ledger's seat_key), not orca terminal handles (term_...); refusing to sweep with a mismatched-format seat list`,
      );
      return EXIT.USAGE;
    }
  }
  const now = nowIso();
  const outcome = withLedgerLock(ledgerPath, lockPath, (readResult) => {
    if (!readResult.ok) {
      return {
        result: {
          kind: "state_unavailable",
          reasonCode: readResult.reasonCode,
        },
        nextLedger: null,
      };
    }
    const swept = sweepAndRecover(readResult.ledger, {
      now,
      liveSeatKeys,
      staleAfterMs: staleAfterMs ? Number(staleAfterMs) : 30 * 60 * 1000,
      recoveryGraceMs: recoveryGraceMs
        ? Number(recoveryGraceMs)
        : 60 * 60 * 1000,
    });
    if (!swept.ok) {
      return {
        result: { kind: "state_unavailable", reasonCode: swept.reasonCode },
        nextLedger: null,
      };
    }
    return {
      result: { kind: "ok", changed: swept.changed },
      nextLedger: swept.changed.length ? swept.ledger : null,
    };
  });
  if (!outcome.ok) {
    printStateUnavailable(outcome.reasonCode, outcome.detail);
    return EXIT.STATE_UNAVAILABLE;
  }
  if (outcome.result.kind === "state_unavailable") {
    printStateUnavailable(outcome.result.reasonCode);
    return EXIT.STATE_UNAVAILABLE;
  }
  console.log(`CAP_SWEPT changed=${JSON.stringify(outcome.result.changed)}`);
  return EXIT.OK;
}

// init-cutover -- PM 항 3, "동결된 전환 시점의 실좌석을 재검해 새 epoch의
// 초기값을 만든다". `--live-seats` here is `[{seatKey, role}]` (role
// nullable). Refuses to overwrite an existing ledger unless `--force` is
// given, so a re-run never silently discards an already-running epoch.
function cmdInitCutover(args) {
  const {
    ledger: ledgerPath,
    lock: lockPath,
    "live-seats": liveSeatsJson,
    force,
  } = args;
  if (!ledgerPath || !lockPath || !liveSeatsJson) {
    console.error(
      "usage: init-cutover --ledger <path> --lock <path> --live-seats <json-array> [--force]",
    );
    return EXIT.USAGE;
  }
  let liveSeats;
  try {
    liveSeats = JSON.parse(liveSeatsJson);
  } catch {
    console.error(
      "init-cutover: --live-seats must be a JSON array of {seatKey, role}",
    );
    return EXIT.USAGE;
  }
  const now = nowIso();
  const outcome = withLedgerLock(ledgerPath, lockPath, (readResult) => {
    if (readResult.ok && force !== "true" && force !== "1") {
      return {
        result: {
          kind: "state_unavailable",
          reasonCode: "LEDGER_ALREADY_EXISTS",
        },
        nextLedger: null,
      };
    }
    const built = buildCutoverLedger({ liveSeats, now, epoch: now });
    if (!built.ok) {
      return {
        result: { kind: "state_unavailable", reasonCode: built.reasonCode },
        nextLedger: null,
      };
    }
    return {
      result: { kind: "ok", active: countActive(built.ledger) },
      nextLedger: built.ledger,
    };
  });
  if (!outcome.ok) {
    printStateUnavailable(outcome.reasonCode, outcome.detail);
    return EXIT.STATE_UNAVAILABLE;
  }
  if (outcome.result.kind === "state_unavailable") {
    printStateUnavailable(outcome.result.reasonCode);
    return EXIT.STATE_UNAVAILABLE;
  }
  console.log(`CAP_CUTOVER_DONE epoch=${now} active=${outcome.result.active}`);
  return EXIT.OK;
}

function cmdStatus(args) {
  const { ledger: ledgerPath } = args;
  if (!ledgerPath) {
    console.error("usage: status --ledger <path>");
    return EXIT.USAGE;
  }
  const readResult = readLedgerUnlocked(ledgerPath);
  if (!readResult.ok) {
    printStateUnavailable(readResult.reasonCode, readResult.detail);
    return EXIT.STATE_UNAVAILABLE;
  }
  console.log(
    `CAP_STATUS active=${countActive(readResult.ledger)} epoch=${readResult.ledger.epoch}`,
  );
  return EXIT.OK;
}

export function runAdmissionCli(argv) {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest);
  switch (sub) {
    case "admit":
      return cmdAdmit(args);
    case "complete":
      return cmdComplete(args);
    case "sweep":
      return cmdSweep(args);
    case "init-cutover":
      return cmdInitCutover(args);
    case "status":
      return cmdStatus(args);
    default:
      console.error(
        "usage: admission-cli.mjs <admit|complete|sweep|init-cutover|status> ...",
      );
      return EXIT.USAGE;
  }
}

// exported for tests that want createEmptyLedger without a fresh import
export { createEmptyLedger };

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/admission-cli.mjs");
if (invokedDirectly) {
  process.exit(runAdmissionCli(process.argv.slice(2)));
}
