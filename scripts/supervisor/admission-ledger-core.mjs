// HYK-224 (coder-task.md §1/§3) -- durable slot ledger, atomic-admission
// CORE. Pure state transitions only: no fs/child_process/network (same I/O-0
// discipline as concurrency-core.mjs, whose header this mirrors). The store
// (admission-ledger-store.mjs) wraps every one of these transitions in a
// single filesystem lock so "read current ledger -> compute next ledger ->
// write it back" happens as one atomic unit from the caller's point of view
// -- this module itself never claims atomicity; it only guarantees that,
// given ONE snapshot of the ledger, it computes exactly one deterministic
// next state.
//
// Why a durable ledger and not "count orca's `dispatched` rows" (rejected
// design, 2026-08-11 리서치 §2-A): that count never falls when a round ends
// without a *next* dispatch to the same seat (D14's only close path) -- 34
// stale rows were observed still `dispatched` while ground truth was 0
// running. Feeding that number into a cap check permanently blocks every
// future admission once it exceeds the cap (gap#97 재발, largest form). This
// ledger instead tracks reservations this process itself created and only
// releases them via an explicit completion, sweep, or cutover -- never by
// re-reading a third party's unrelated bookkeeping.
//
// 이 코어가 보장하지 않는 것 (S11):
// - `seatKey`가 실제로 그 좌석에서 그 라운드가 살아있다는 것을 이 코어가
//   검증하지 않는다 -- 호출자(어댑터)가 injected `liveSeatKeys`를 어디서
//   구했는지는 이 파일 밖의 일이다(judgeConcurrency의 inFlight와 동일한
//   책임 분리).
// - 락 자체는 여기 없다(store의 책임) -- 이 모듈의 모든 함수는 "이미 락을
//   쥔 채로 읽은 한 장의 스냅샷"을 인자로 받는다는 가정 위에서만 동시
//   안전(concurrency-safe)하다.

export const ADMISSION_SCHEMA_VERSION = "admission-ledger/v1";

export const RESERVATION_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  SUSPECT: "SUSPECT",
  COMPLETED: "COMPLETED",
});

export const ADMISSION_DECISION = Object.freeze({
  ADMITTED: "ADMITTED",
  ALREADY_ADMITTED: "ALREADY_ADMITTED",
  BLOCKED: "BLOCKED",
});

export const ADMISSION_REASON = Object.freeze({
  OK: "OK",
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  LEDGER_MALFORMED: "LEDGER_MALFORMED",
  RESERVATION_NOT_FOUND: "RESERVATION_NOT_FOUND",
  RESERVATION_NOT_ACTIVE: "RESERVATION_NOT_ACTIVE",
  // HYK-344 §1-3 항2 -- completeReservation's pre-existing RESERVATION_NOT_
  // FOUND collapsed two genuinely different situations into one value: "no
  // reservation was ever admitted for this round" vs. "a reservation WAS
  // admitted, but under a different key than the one this completion call is
  // asking about" (the exact GoLabel/Task fallback drift ORCH observed,
  // 2026-08-24 08:40 -- dispatch-worker.ps1 admits under `$GoLabel`,
  // relay-handshake.mjs completes under the task file's `task_id:`; when
  // those two differ, completion silently misses). RESERVATION_KEY_MISMATCH
  // is the new, distinct value: it fires only when the ledger snapshot has
  // at least one OTHER active/suspect reservation that the requested id does
  // not match -- i.e. "something IS reserved here, just not under the key
  // you asked about" -- so a reader no longer has to guess which of the two
  // (never-admitted vs. wrong-key) actually happened.
  RESERVATION_KEY_MISMATCH: "RESERVATION_KEY_MISMATCH",
});

// HYK-342/HYK-249 -- named `completion_reason` values a caller may ask
// completeReservation (below) to stamp. This is NOT a new state (RESERVATION_
// STATUS above is untouched, sweepAndRecover's own state-machine meaning is
// untouched) -- `completion_reason` was already an existing, optional field
// on a COMPLETED entry (sweepSuspectEntry has written the SUSPECT_TIMEOUT_
// RECOVERED value into it since HYK-224-3R; completeReservation itself never
// wrote it before this round). BLOCKED_TERMINATION_RELEASED is the new value:
// an EXPLICIT, immediate release of a reservation whose round ended in a
// BLOCKED/NEEDS_INPUT handshake outcome (relay-handshake.mjs), as opposed to
// SUSPECT_TIMEOUT_RECOVERED's mechanical, age-based sweep recovery. Kept as
// plain string constants (not re-exported by sweepSuspectEntry's own
// pre-existing literal, to avoid touching that already-tested line) so both
// producers and readers (dispatch-gate-decision.mjs's
// verifyAbortRecordRecoveryMarker) can refer to a single source of truth for
// the NEW value without touching sweep's own code.
// HYK-398 §2-⑶: RETIREMENT_RELEASED -- a VALID-labeled round whose retirement
// record was independently reconfirmed RETIRED (retirement-record-core.mjs's
// checkRetirementRecord) is released with THIS reason, deliberately distinct
// from SUSPECT_TIMEOUT_RECOVERED (age-based sweep recovery of a round that
// simply never checked in) and from BLOCKED_TERMINATION_RELEASED (a round
// that explicitly declared itself stopped). A retired round is neither -- it
// is a VALID, real result that can never be consumed through the normal
// receipt chain (stale/malformed timestamp, permanently). Keeping these three
// reasons distinct means an audit reading completion_reason never has to
// guess which of three very different closures actually happened.
export const COMPLETION_REASON = Object.freeze({
  SUSPECT_TIMEOUT_RECOVERED: "SUSPECT_TIMEOUT_RECOVERED",
  BLOCKED_TERMINATION_RELEASED: "BLOCKED_TERMINATION_RELEASED",
  RETIREMENT_RELEASED: "RETIREMENT_RELEASED",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isNonNegativeInteger(v) {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0
  );
}
function isIsoString(v) {
  return isNonEmptyString(v) && !Number.isNaN(Date.parse(v));
}

// isWellFormedLedger -- the one shape gate every transition below runs
// first. A ledger that fails this is never partially trusted (S11: "모름"을
// "비어 있음"으로 접지 않는다, concurrency-core.mjs와 동일 원칙) -- every
// transition function returns `{ok:false, reasonCode:LEDGER_MALFORMED}`
// rather than guessing at a repair.
// isWellFormedOptionalTimestamp -- HYK-224-3R §2: `flagged_unjudgeable_at`
// is additive -- absent (undefined, every pre-3R entry including the live
// ledger's two null-seat_key COMPLETED rows) is equally valid to explicitly
// null; only a present-but-wrong-type value is rejected. Extracted purely
// to keep isWellFormedReservationEntry's own cyclomatic complexity under
// the repo's ESLint ceiling (quality-check); no behavior change.
function isWellFormedNullableTimestamp(v) {
  return v === null || isIsoString(v);
}

// HYK-224-3R §2: `flagged_unjudgeable_at` is the one ADDITIVE field (absent
// -- undefined -- is equally valid to explicitly null, so every pre-3R
// entry, including the live ledger's two null-seat_key COMPLETED rows,
// stays well-formed). `completed_at`/`suspect_at` keep their original,
// stricter contract (must be present as null-or-ISO; undefined was never
// valid for those, and still isn't).
function isWellFormedOptionalNewTimestamp(v) {
  return v === undefined || isWellFormedNullableTimestamp(v);
}

function isWellFormedNullableString(v) {
  return v === null || isNonEmptyString(v);
}

// isWellFormedReservationEntry's own field checks, extracted purely to keep
// its cyclomatic complexity under the repo's ESLint ceiling (quality-check);
// no behavior change.
function isWellFormedReservationEntryFields(entry) {
  if (!isIsoString(entry.admitted_at)) return false;
  if (!isWellFormedNullableTimestamp(entry.completed_at)) return false;
  if (!isWellFormedNullableTimestamp(entry.suspect_at)) return false;
  if (!isWellFormedNullableString(entry.role)) return false;
  if (!isWellFormedNullableString(entry.seat_key)) return false;
  if (!isWellFormedOptionalNewTimestamp(entry.flagged_unjudgeable_at)) {
    return false;
  }
  return true;
}

function isWellFormedReservationEntry(entry) {
  if (!isPlainObject(entry)) return false;
  if (!Object.values(RESERVATION_STATUS).includes(entry.status)) return false;
  return isWellFormedReservationEntryFields(entry);
}

export function isWellFormedLedger(ledger) {
  if (!isPlainObject(ledger)) return false;
  if (ledger.schema_version !== ADMISSION_SCHEMA_VERSION) return false;
  if (!isIsoString(ledger.epoch)) return false;
  if (!isPlainObject(ledger.reservations)) return false;
  for (const [id, entry] of Object.entries(ledger.reservations)) {
    if (!isNonEmptyString(id)) return false;
    if (!isWellFormedReservationEntry(entry)) return false;
  }
  return true;
}

export function createEmptyLedger(epoch) {
  return {
    schema_version: ADMISSION_SCHEMA_VERSION,
    epoch,
    reservations: {},
  };
}

function countByStatus(ledger, status) {
  return Object.values(ledger.reservations).filter((r) => r.status === status)
    .length;
}

export function countActive(ledger) {
  return countByStatus(ledger, RESERVATION_STATUS.ACTIVE);
}

// isWellFormedAdmitArgs -- extracted purely to keep admitReservation's own
// cyclomatic complexity under the repo's ESLint ceiling (quality-check);
// same five checks, same fail-closed shape, no behavior change.
function isWellFormedAdmitArgs({ reservationId, cap, now, role, seatKey }) {
  if (!isNonEmptyString(reservationId)) return false;
  if (!isNonNegativeInteger(cap)) return false;
  if (!isIsoString(now)) return false;
  if (role !== null && !isNonEmptyString(role)) return false;
  if (seatKey !== null && !isNonEmptyString(seatKey)) return false;
  return true;
}

// admitReservation -- the ONE function §3's `CAP_ADMITTED`/`CAP_BLOCKED`
// table maps onto. Given a single ledger snapshot, computes the next ledger
// deterministically; never mutates the input object (callers/tests can
// safely reuse a fixture across cases).
export function admitReservation(ledger, args) {
  if (!isWellFormedLedger(ledger)) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.LEDGER_MALFORMED,
    };
  }
  if (!isPlainObject(args)) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.INVALID_ARGUMENTS,
    };
  }
  const { reservationId, cap, now, role = null, seatKey = null } = args;
  if (!isWellFormedAdmitArgs({ reservationId, cap, now, role, seatKey })) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.INVALID_ARGUMENTS,
    };
  }

  const existing = ledger.reservations[reservationId];
  if (existing && existing.status === RESERVATION_STATUS.ACTIVE) {
    // Idempotent re-admit of the SAME reservation id (retry of the same
    // round before its first admit's caller ever saw the response) never
    // double-counts against the cap -- this is not a second slot, it is the
    // same slot observed twice.
    const active = countActive(ledger);
    return {
      ok: true,
      ledger,
      decision: ADMISSION_DECISION.ALREADY_ADMITTED,
      active,
      activeBefore: active,
      reasonCode: ADMISSION_REASON.OK,
    };
  }

  const activeBefore = countActive(ledger);
  if (activeBefore >= cap) {
    return {
      ok: true,
      ledger,
      decision: ADMISSION_DECISION.BLOCKED,
      active: activeBefore,
      activeBefore,
      reasonCode: ADMISSION_REASON.OK,
    };
  }

  const nextLedger = {
    ...ledger,
    reservations: {
      ...ledger.reservations,
      [reservationId]: {
        status: RESERVATION_STATUS.ACTIVE,
        role,
        seat_key: seatKey,
        admitted_at: now,
        completed_at: null,
        suspect_at: null,
        flagged_unjudgeable_at: null,
        source: existing ? existing.source : "admission",
      },
    },
  };
  return {
    ok: true,
    ledger: nextLedger,
    decision: ADMISSION_DECISION.ADMITTED,
    active: activeBefore + 1,
    activeBefore,
    reasonCode: ADMISSION_REASON.OK,
  };
}

// completeReservation -- the "정상 완료 소비" transition (PM 항 2). Caller
// (the neutral consumer, not the worker) is the one who decided the round
// genuinely finished; this function only records that decision and frees the
// slot. Completing an already-COMPLETED reservation is idempotent (ok:true,
// unchanged ledger) so a duplicate consumer call never errors.
//
// HYK-342/HYK-249: `args.reason` is a NEW, optional field -- when the caller
// supplies a non-empty string (e.g. COMPLETION_REASON.BLOCKED_TERMINATION_
// RELEASED, above), the resulting entry's `completion_reason` is stamped
// with it. When omitted (every pre-existing caller, the ok:true completion
// path in relay-handshake.mjs via admission-completion-adapter.mjs), the
// entry's `completion_reason` stays unset -- byte-identical to this
// function's behavior before this round. This is purely additive: it does
// not change WHEN a reservation transitions to COMPLETED, only what optional
// bookkeeping rides along with an already-decided transition.
// HYK-344 §1-3 항1/항2 -- extracted from completeReservation purely to keep
// its own cyclomatic/line-count complexity under the repo's ESLint ceiling
// (quality-check); no behavior change. Records BOTH the expected key
// (reservationId) AND what was actually found (or "nothing") in the ledger,
// instead of a bare "failed". A reservation is a plausible key-drift
// candidate only while it is still ACTIVE or SUSPECT (a COMPLETED entry
// already released its slot -- it is not "the round this caller meant", it
// is unrelated history).
function buildReservationNotFoundResult(ledger, reservationId) {
  const candidates = Object.entries(ledger.reservations)
    .filter(
      ([id, e]) =>
        id !== reservationId &&
        (e.status === RESERVATION_STATUS.ACTIVE ||
          e.status === RESERVATION_STATUS.SUSPECT),
    )
    .map(([id, e]) => ({
      reservationId: id,
      status: e.status,
      role: e.role ?? null,
      seatKey: e.seat_key ?? null,
    }));
  if (candidates.length > 0) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.RESERVATION_KEY_MISMATCH,
      candidates,
    };
  }
  return {
    ok: false,
    ledger: null,
    reasonCode: ADMISSION_REASON.RESERVATION_NOT_FOUND,
    candidates: [],
  };
}

export function completeReservation(ledger, args) {
  if (!isWellFormedLedger(ledger)) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.LEDGER_MALFORMED,
    };
  }
  if (!isPlainObject(args)) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.INVALID_ARGUMENTS,
    };
  }
  const { reservationId, now, reason } = args;
  if (!isNonEmptyString(reservationId) || !isIsoString(now)) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.INVALID_ARGUMENTS,
    };
  }
  const entry = ledger.reservations[reservationId];
  if (!entry) {
    return buildReservationNotFoundResult(ledger, reservationId);
  }
  if (entry.status === RESERVATION_STATUS.COMPLETED) {
    return {
      ok: true,
      ledger,
      changed: false,
      reasonCode: ADMISSION_REASON.OK,
    };
  }
  const nextEntry = {
    ...entry,
    status: RESERVATION_STATUS.COMPLETED,
    completed_at: now,
  };
  if (isNonEmptyString(reason)) {
    nextEntry.completion_reason = reason;
  }
  const nextLedger = {
    ...ledger,
    reservations: {
      ...ledger.reservations,
      [reservationId]: nextEntry,
    },
  };
  return {
    ok: true,
    ledger: nextLedger,
    changed: true,
    reasonCode: ADMISSION_REASON.OK,
  };
}

// sweepAndRecover -- 비정상 종료 회수 (PM 항 3 관련: 회수 없이 출발하면
// 며칠 안에 후보 A와 같은 상태가 된다, 리서치 §5-2). Two independent
// transitions applied in one pass over a single snapshot:
//   1. ACTIVE -> SUSPECT: an active reservation whose seat_key is NOT among
//      `liveSeatKeys` (caller-observed ground truth, e.g. `orca terminal
//      list` after role inference) AND older than `staleAfterMs`.
//   2. SUSPECT -> ACTIVE: seat_key reappears in `liveSeatKeys` (false alarm,
//      e.g. a transient seat-list read glitch) -- reservation is restored,
//      never silently dropped.
//   3. SUSPECT -> COMPLETED (freed, `completion_reason: SUSPECT_TIMEOUT`):
//      still absent after `recoveryGraceMs` beyond suspect_at -- this is the
//      "reboot" recovery path: a crashed seat never comes back, so the slot
//      is eventually returned to the pool instead of leaking forever.
// A reservation with `seatKey: null` (cutover-seeded entries whose role/seat
// could not be inferred, coder-task.md §2, or pre-3R entries admitted before
// dispatch-worker.ps1 passed --seat-key) is never auto-freed or auto-kept-
// silent -- there is no ground-truth signal to judge its liveness by, and
// guessing would violate fail-closed. HYK-224-3R §2 (REVIEW 2R 반려): 2R's
// "never touch it" left such an entry permanently INVISIBLE to sweep --
// exactly what the reviewer flagged as "«sweep 대상 아님」으로 영원히 남지
// 마라". 3R keeps the "never guess liveness" rule (status stays ACTIVE, it
// is NOT auto-freed) but makes a stale-by-age one VISIBLE: this durably
// stamps `flagged_unjudgeable_at` on the entry and surfaces it in `changed`
// (coder-task §2: "명시적 «판단 불가」 상태 + 사람이 볼 수 있는 표시") --
// once flagged, it is not re-flagged/re-reported on every subsequent sweep
// (avoids alert fatigue); a human resolves it (e.g. `complete` it directly,
// or re-admit under a real seat_key).
export function sweepAndRecover(ledger, args) {
  if (!isWellFormedLedger(ledger)) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.LEDGER_MALFORMED,
    };
  }
  if (!isPlainObject(args)) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.INVALID_ARGUMENTS,
    };
  }
  const { now, liveSeatKeys, staleAfterMs, recoveryGraceMs } = args;
  if (!isIsoString(now)) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.INVALID_ARGUMENTS,
    };
  }
  if (!Array.isArray(liveSeatKeys) || !liveSeatKeys.every(isNonEmptyString)) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.INVALID_ARGUMENTS,
    };
  }
  if (
    !isNonNegativeInteger(staleAfterMs) ||
    !isNonNegativeInteger(recoveryGraceMs)
  ) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.INVALID_ARGUMENTS,
    };
  }

  const liveSet = new Set(liveSeatKeys);
  const nowMs = Date.parse(now);
  const nextReservations = {};
  const changed = [];

  for (const [id, entry] of Object.entries(ledger.reservations)) {
    const swept = sweepOneEntry(entry, {
      liveSet,
      nowMs,
      now,
      staleAfterMs,
      recoveryGraceMs,
    });
    nextReservations[id] = swept.entry;
    if (swept.transition) {
      changed.push({ reservationId: id, ...swept.transition });
    }
  }

  return {
    ok: true,
    ledger: { ...ledger, reservations: nextReservations },
    changed,
    reasonCode: ADMISSION_REASON.OK,
  };
}

// sweepOneEntry -- the per-reservation half of sweepAndRecover's transition
// table, extracted to keep sweepAndRecover's own cyclomatic complexity under
// the repo's ESLint ceiling (quality-check). Returns `{entry, transition}`
// where `transition` is `null` for "unchanged" or `{from, to}` for a state
// change -- the caller folds that into its own `changed` list (which also
// carries `reservationId`, not this function's concern).
function sweepOneEntry(
  entry,
  { liveSet, nowMs, now, staleAfterMs, recoveryGraceMs },
) {
  if (entry.seat_key === null) {
    return sweepNullSeatKeyEntry(entry, { nowMs, now, staleAfterMs });
  }
  if (entry.status === RESERVATION_STATUS.ACTIVE) {
    return sweepActiveEntry(entry, { liveSet, nowMs, staleAfterMs, now });
  }
  if (entry.status === RESERVATION_STATUS.SUSPECT) {
    return sweepSuspectEntry(entry, { liveSet, nowMs, recoveryGraceMs, now });
  }
  return { entry, transition: null };
}

// sweepNullSeatKeyEntry -- HYK-224-3R §2. Only ACTIVE entries are candidates
// (COMPLETED ones, like the live ledger's two pre-3R null-seat_key rows,
// already released their slot and need no visibility action; a SUSPECT
// null-seat_key entry cannot exist -- this function is the only place that
// ever touches a null-seat_key entry, and it never assigns SUSPECT). Once
// `flagged_unjudgeable_at` is already set, this is a no-op (idempotent,
// no repeat `changed` entries every sweep tick) -- the flag is a durable
// one-time signal, not a live heartbeat.
function sweepNullSeatKeyEntry(entry, { nowMs, now, staleAfterMs }) {
  if (entry.status !== RESERVATION_STATUS.ACTIVE) {
    return { entry, transition: null };
  }
  if (entry.flagged_unjudgeable_at) {
    return { entry, transition: null };
  }
  const ageMs = nowMs - Date.parse(entry.admitted_at);
  if (ageMs <= staleAfterMs) {
    return { entry, transition: null };
  }
  return {
    entry: { ...entry, flagged_unjudgeable_at: now },
    transition: {
      from: RESERVATION_STATUS.ACTIVE,
      to: RESERVATION_STATUS.ACTIVE,
      flag: "UNJUDGEABLE_NO_SEAT_KEY",
    },
  };
}

function sweepActiveEntry(entry, { liveSet, nowMs, staleAfterMs, now }) {
  const ageMs = nowMs - Date.parse(entry.admitted_at);
  if (liveSet.has(entry.seat_key) || ageMs <= staleAfterMs) {
    return { entry, transition: null };
  }
  return {
    entry: { ...entry, status: RESERVATION_STATUS.SUSPECT, suspect_at: now },
    transition: {
      from: RESERVATION_STATUS.ACTIVE,
      to: RESERVATION_STATUS.SUSPECT,
    },
  };
}

function sweepSuspectEntry(entry, { liveSet, nowMs, recoveryGraceMs, now }) {
  if (liveSet.has(entry.seat_key)) {
    return {
      entry: { ...entry, status: RESERVATION_STATUS.ACTIVE, suspect_at: null },
      transition: {
        from: RESERVATION_STATUS.SUSPECT,
        to: RESERVATION_STATUS.ACTIVE,
      },
    };
  }
  const suspectAgeMs = nowMs - Date.parse(entry.suspect_at);
  if (suspectAgeMs <= recoveryGraceMs) {
    return { entry, transition: null };
  }
  return {
    entry: {
      ...entry,
      status: RESERVATION_STATUS.COMPLETED,
      completed_at: now,
      completion_reason: "SUSPECT_TIMEOUT_RECOVERED",
    },
    transition: {
      from: RESERVATION_STATUS.SUSPECT,
      to: RESERVATION_STATUS.COMPLETED,
    },
  };
}

// buildCutoverLedger -- PM 항 3의 "동결된 전환 시점의 실좌석을 재검해 새
// epoch의 초기값을 만든다". Deliberately does NOT read orca's 34 stale
// `dispatched` rows at all (satisfies "옛 34건을 건드리지 않는다 -- 읽기만"
// by construction: this function has no argument through which those rows
// could even flow in) -- the new epoch's only inputs are the caller-observed
// live seats at cutover time. `liveSeats` entries are `{seatKey, role}`
// (role nullable when HYK-214 inference could not resolve it -- fail-closed
// per coder-task.md §2: an unresolved role is recorded as null, never
// guessed).
export function buildCutoverLedger(args) {
  if (!isPlainObject(args)) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.INVALID_ARGUMENTS,
    };
  }
  const { liveSeats, now, epoch, reservationIdPrefix = "cutover" } = args;
  if (!Array.isArray(liveSeats)) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.INVALID_ARGUMENTS,
    };
  }
  if (!isIsoString(now) || !isIsoString(epoch)) {
    return {
      ok: false,
      ledger: null,
      reasonCode: ADMISSION_REASON.INVALID_ARGUMENTS,
    };
  }
  for (const s of liveSeats) {
    if (!isPlainObject(s) || !isNonEmptyString(s.seatKey)) {
      return {
        ok: false,
        ledger: null,
        reasonCode: ADMISSION_REASON.INVALID_ARGUMENTS,
      };
    }
    if (s.role !== null && s.role !== undefined && !isNonEmptyString(s.role)) {
      return {
        ok: false,
        ledger: null,
        reasonCode: ADMISSION_REASON.INVALID_ARGUMENTS,
      };
    }
  }

  const reservations = {};
  liveSeats.forEach((s, index) => {
    const reservationId = `${reservationIdPrefix}-${index}-${s.seatKey}`;
    reservations[reservationId] = {
      status: RESERVATION_STATUS.ACTIVE,
      role: s.role ?? null,
      seat_key: s.seatKey,
      admitted_at: now,
      completed_at: null,
      suspect_at: null,
      flagged_unjudgeable_at: null,
      source: "cutover",
    };
  });

  return {
    ok: true,
    ledger: { schema_version: ADMISSION_SCHEMA_VERSION, epoch, reservations },
    reasonCode: ADMISSION_REASON.OK,
  };
}
