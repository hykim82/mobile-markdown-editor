// HYK-186: in-scope timestamp registry -- the machine-recorded timestamps
// relay judgment (완료 감지) directly reads to decide "did the worker
// finish", and the authority/format/bound rules each one carries.
//
// Trust boundary (A) ONLY (coder-task.md §3): the two fields
// relay-handshake.mjs's checkRelayHandshake() reads to make an ok:true/false
// completion call -- task `dropped_at` / result `>>> DONE: ... @ <time>`.
// Trust boundary (B) (받는함 파일명·구조화 헤더 -- human/routing audit,
// non-blocking) is deliberately NOT registered here; §3 명시: "둘에 같은
// '차단' 완료조건을 적용하지 마라".
//
// This registry is the SOLE source `checkRelayHandshake` consults for each
// field's future-skew upper bound (via `isBeyondFutureSkew` below) -- no
// hardcoded skew constant lives duplicated in relay-handshake.mjs. Removing
// a row here removes that field's future-bound enforcement entirely (see
// hyk186-time-authority-mutation.test.mjs mutation 1 -- 완료조건1 "행 또는
// 결선 하나를 제거하면 대응 mutation 시험이 RED").

// Authority-clock/worker-clock drift tolerance. Chosen generously above
// typical NTP/VM clock drift (seconds) and typical KST-header floor-to-second
// loss (up to 59s, since headers only carry minute precision) while staying
// far below the multi-hour/multi-year projection errors this task exists to
// catch (§1 실사례: 07-28 6시간, 2099-01-01).
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes

export const TIME_FIELD = Object.freeze({
  TASK_DROPPED_AT: "task.dropped_at",
  RESULT_DONE_AT: "result.>>> DONE",
});

export const TIME_AUTHORITY_STATE = Object.freeze({
  FUTURE_DROPPED_AT: "FUTURE_DROPPED_AT",
  FUTURE_DONE: "FUTURE_DONE",
  SUSPECTED_TZ_MISLABEL_DROPPED_AT: "SUSPECTED_TZ_MISLABEL_DROPPED_AT",
  SUSPECTED_TZ_MISLABEL_DONE: "SUSPECTED_TZ_MISLABEL_DONE",
  // HYK-257-done-stamp-2 §2 범위1: 소비 직전 첫 읽기(scripts/check/
  // first-observation.mjs, watch-result.mjs의 반복 폴링을 통해 매 라운드
  // 여러 번 관측됨)에서 기록된 DONE 표지가, 최종 판정 시점에 다시 읽은
  // DONE 표지와 다를 때(지문 또는 원문 중 하나라도) -- 판정 «전에» 결과
  // 파일이 다시 쓰였다는 뜻이다. 즉시 거부(경고-후-통과 아님)를 택한
  // 근거는 relay-handshake.mjs의 이 상태를 반환하는 지점 주석 참조.
  DONE_REWRITTEN_AFTER_FIRST_OBSERVATION:
    "DONE_REWRITTEN_AFTER_FIRST_OBSERVATION",
});

// HYK-257 (★새 변종 -- coder-task.md §1 추기 2026-08-16): a "시간대 착오"
// (UTC value hand-typed with a 'KST' label, or vice versa) does NOT always
// surface as a future-skew violation -- the 실사례(레인 F, HYK-265)의 값은
// 오히려 과거처럼 보였다(UTC로 찍힌 값에 KST 라벨만 붙었으므로 실제보다
// 9시간 «이른» 값으로 읽힌다). A value that is off by *exactly* the KST/UTC
// offset in either direction, within a tight tolerance, is far more likely
// to be this specific mislabeling than either a genuinely stale result or a
// genuinely long-running round -- KST_OFFSET_MS 자체가 uncommon 값이다
// (정직 우연히 정확히 9시간 근처로 끝나는 정상 라운드는 극히 드물다).
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // 9 hours

// Tight on purpose (10 minutes, not the 5-minute MAX_FUTURE_SKEW_MS's
// wider sibling) -- narrow enough that it fires only near-exactly on the
// 9-hour offset itself (the mislabeling signature), not on ordinary drift.
export const TZ_MISLABEL_TOLERANCE_MS = 10 * 60 * 1000; // 10 minutes

// isSuspectedTimezoneMislabel(candidateMs, nowMs) -> boolean
//
// ⚠️정직 한계: this is a heuristic, not a proof -- a round that genuinely
// takes ~9h ± this tolerance to complete would also match. It is offered as
// an additional loud diagnostic (coder-task.md §2 ⓒ: 거부할 때 고치는 법을
// 함께 출력한다), not as a claim that every match IS a mislabel.
//
// HYK-257b §4 (제거 조건, 삭제 금지 -- unconditional 제거 금지, coder-task.md
// 원문): this heuristic exists ONLY because a hand-written `>>> DONE:`/
// `dropped_at:` value can still reach checkRelayHandshake with no machine
// provenance to check against (gap#95/gap#101, docs/enforcement-known-
// gaps.md) -- so a genuine UTC/KST mislabel and a genuine 9h-long round are
// indistinguishable from the timestamp text alone, and this guess is the
// best available signal. **삭제해도 되는 유일한 조건**: gap#95의 이전
// 계획(런처/supervisor가 좌석을 "완료"로 표시하기 직전 `finalize-done.mjs`
// provenance를 모든 소비 경로에서 강제 검증하도록 결선되는 것 -- 즉
// `relay-handshake.mjs`의 checkRelayHandshake가 더 이상 caller가 직접
// 손으로 쓴 타임스탬프 텍스트를 신뢰하지 않고, 그 값이 machine-clock
// 생산자를 거쳤음을 검증할 수 있는 상태)이 실제로 코드로 결선되고, 그
// 결선이 codex 좌석 포함 모든 엔진에서 검증됐을 때만 이 함수(및
// checkTimezoneMislabel 호출부, relay-handshake.mjs)를 제거해도 안전하다.
// 그 전에 제거하면 hand-written 시각 오기입(9시간 시간대 착오)이 아무
// 진단 없이 FUTURE_DONE/FUTURE_DROPPED_AT 같은 일반 미래-시각 오류로만
// 보여, "고치는 법"이 사라진다(§2 ⓒ 요건 위반) -- 이번 라운드(HYK-257b)는
// 이 조건을 충족하지 못했으므로(gap#101: 코드 강제 미착수, 문서 수정만)
// 이 함수를 그대로 둔다.
export function isSuspectedTimezoneMislabel(candidateMs, nowMs) {
  if (!Number.isFinite(candidateMs) || !Number.isFinite(nowMs)) return false;
  const absDiff = Math.abs(candidateMs - nowMs);
  return Math.abs(absDiff - KST_OFFSET_MS) <= TZ_MISLABEL_TOLERANCE_MS;
}

export const TIME_AUTHORITY_REGISTRY = Object.freeze([
  Object.freeze({
    field: TIME_FIELD.TASK_DROPPED_AT,
    producer:
      "scripts/supervisor/task-drop-core.mjs:dropTaskFile (구조 검증만 프로덕션 경로 미결선 -- own header 실측)",
    consumer: "scripts/check/relay-handshake.mjs:checkRelayHandshake",
    authorityClock:
      "checkRelayHandshake's `now` param (default Date.now()) -- caller never overrides this in the CLI entry point",
    formatPrecision: "YYYY-MM-DD HH:MM KST, minute precision (no seconds)",
    lowerRule:
      "none (dropped_at has no known-earlier anchor to compare against)",
    upperRule: "dropped_at <= now + MAX_FUTURE_SKEW_MS",
    upperBoundMs: MAX_FUTURE_SKEW_MS,
    stateOnViolation: TIME_AUTHORITY_STATE.FUTURE_DROPPED_AT,
  }),
  Object.freeze({
    field: TIME_FIELD.RESULT_DONE_AT,
    producer:
      "worker manual edit of <role>.md's '>>> DONE:' line; scripts/relay/finalize-done.mjs is the ONE supported machine-clock producer (정직 한계: direct file edits bypass it -- see that file's own header)",
    consumer: "scripts/check/relay-handshake.mjs:checkRelayHandshake",
    authorityClock:
      "checkRelayHandshake's `now` param (default Date.now()) -- caller never overrides this in the CLI entry point",
    formatPrecision:
      "YYYY-MM-DD HH:MM:SS KST, seconds required (HYK-244 2R-a -- relay-handshake.mjs rejects a minute-only DONE line before this future-skew check ever runs; the historical HH:MM[:SS] optional-seconds parsing in parseKstTimestamp is unchanged, only DONE additionally requires seconds now)",
    lowerRule: "doneAt >= droppedAt (pre-existing stale-result rejection)",
    upperRule: "doneAt <= now + MAX_FUTURE_SKEW_MS",
    upperBoundMs: MAX_FUTURE_SKEW_MS,
    stateOnViolation: TIME_AUTHORITY_STATE.FUTURE_DONE,
  }),
]);

export function findTimeAuthorityRow(field) {
  return TIME_AUTHORITY_REGISTRY.find((r) => r.field === field) ?? null;
}

// isBeyondFutureSkew(candidateMs, nowMs, field) -> true | false | null
//
// null means "this field has no registry row" -- callers MUST fail closed on
// null (treat as a violation), never treat an unregistered field as
// automatically safe. This is what makes 완료조건1's "행 제거 -> RED" hold:
// removing a row does not silently open a hole, it makes every candidate for
// that field look like a violation instead (fail-closed), which itself is a
// distinct, testable RED (see mutation test 1).
export function isBeyondFutureSkew(candidateMs, nowMs, field) {
  const row = findTimeAuthorityRow(field);
  if (!row) return null;
  if (!Number.isFinite(candidateMs) || !Number.isFinite(nowMs)) return null;
  return candidateMs - nowMs > row.upperBoundMs;
}
