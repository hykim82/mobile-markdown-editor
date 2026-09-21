// HYK-193 1R (coder-task.md §2, §3) -- 동시 실행 전역 상한 값 어댑터.
//
// 배경: 서명 패킷 `PKT-20260807-SUPERVISOR-CONCURRENCY-ADDENDUM-V1` S-5 --
// "상한은 고정 숫자가 아니라 한용이 정한 현재 값이며, supervisor는 그
// 값을 읽어서 쓴다(스스로 정하지 않는다). 상한을 코드에 상수로 박아
// 두면 이 게이트는 미충족(값의 출처가 한용이어야 한다)". concurrency-
// core.mjs는 «I/O 0»을 비타협으로 선언한 코어이므로(그 파일 머리 참조),
// 값을 읽는 일은 코어 밖인 이 파일이 한다 -- ★새로 발명하지 않고
// `approver-allowlist.json` + `approval-authority-adapter.mjs`의 선례를
// 그대로 따른다: schema_version이 있는 작은 커밋 JSON + throw로 판정을
// 대신하지 않는 fail-closed 어댑터.
//
// 이 어댑터가 정하지 않는 것:
// - 값이 무엇이어야 하는가(한용 몫, coder-task.md §2 -- 이 어댑터는
//   숫자를 고르지 않고 파일에 적힌 값을 그대로 옮길 뿐이다).
// - 값 파일 변경 승인 절차 자체를 강제하지 않는다 -- 그 강제는 브랜치
//   보호(PR + 사람 승인)이며 이 파일 밖의 일이다(approver-allowlist와
//   같은 방식, coder-task.md §2).
//
// 정직 한계(S11):
// - live=false -- 이 어댑터를 부르는 상시 실행기는 아직 없다(호출자
//   없음, coder-task.md §8-3). 도입 시 호출자는 이 어댑터의 성공
//   반환값(`cap`)을 concurrency-core.mjs의 `judgeConcurrency` 인자
//   `globalCap`에 그대로 주입해야 한다 -- 이 어댑터 자신은
//   judgeConcurrency를 호출하지 않는다(결선은 이 조각의 범위 밖).
// - `origin/master` 판본이 아니라 **호출자가 넘긴 경로의 작업 트리
//   내용**을 읽는다(approval-authority-adapter.readApproverAllowlist와
//   달리 git blob을 거치지 않는다) -- 이 값 파일은 GitHub 승인 판정에
//   쓰이는 것이 아니라 로컬 프로세스가 읽는 설정이므로, 판본 고정
//   요구가 없다(그 요구가 필요해지면 다음 사이클 몫).
//
// 비타협(coder-task.md §3):
// - throw로 판정을 대신하지 않는다 -- 모든 경로가 실패 객체를
//   반환한다(approval-authority-adapter.mjs 선례 그대로).
// - fail-closed -- 파일 부재·읽기 실패·JSON 파싱 실패·스키마
//   불일치(`schema_version` 불일치 포함)·`global_hard_cap`이 음이 아닌
//   정수가 아님, 전부 실패 객체다. ⛔어떤 경로도 숫자 기본값으로
//   폴백하지 않는다 -- 그 폴백이 곧 되살아난 코드 상수다(한용 14:47
//   확정, coder-task.md §2).

import { readFileSync } from "node:fs";

export const CONCURRENCY_CAP_REASON = Object.freeze({
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  FILE_UNREADABLE: "FILE_UNREADABLE",
  MALFORMED_JSON: "MALFORMED_JSON",
  SCHEMA_MISMATCH: "SCHEMA_MISMATCH",
});

export const CONCURRENCY_CAP_SCHEMA_VERSION = "concurrency-cap/v1";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonNegativeInteger(v) {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0
  );
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// isWellFormedCapSchema -- schema_version이 정확히 이 값이 아니면(누락·
// 타입 불일치·다른 버전 문자열 전부) 스키마 불일치다. approval-
// authority-adapter.mjs의 재작업 2R P1-3과 같은 원칙: schema_version
// 필드 자체도 스키마 검사 대상이다.
function isWellFormedCapSchema(parsed) {
  return (
    isPlainObject(parsed) &&
    parsed.schema_version === CONCURRENCY_CAP_SCHEMA_VERSION &&
    isNonNegativeInteger(parsed.global_hard_cap)
  );
}

// readConcurrencyCap({capPath, readFn}) ->
//   {ok:true, cap, capPath} | {ok:false, reason, detail}
//
// readFn은 시험 주입용(기본 fs.readFileSync) -- 이 함수 자신은 그 인자로
// 받은 함수(또는 fs.readFileSync) 외의 I/O 표면을 열지 않는다.
export function readConcurrencyCap(args) {
  if (!isPlainObject(args)) {
    return {
      ok: false,
      reason: CONCURRENCY_CAP_REASON.INVALID_ARGUMENTS,
      detail: "readConcurrencyCap arguments missing/invalid",
    };
  }
  const { capPath, readFn } = args;
  if (!isNonEmptyString(capPath)) {
    return {
      ok: false,
      reason: CONCURRENCY_CAP_REASON.INVALID_ARGUMENTS,
      detail: "capPath missing/invalid",
    };
  }
  const read = readFn === undefined ? readFileSync : readFn;
  if (typeof read !== "function") {
    return {
      ok: false,
      reason: CONCURRENCY_CAP_REASON.INVALID_ARGUMENTS,
      detail: "readFn must be a function when provided",
    };
  }

  let raw;
  try {
    raw = read(capPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: CONCURRENCY_CAP_REASON.FILE_UNREADABLE,
      detail: err && err.message ? err.message : String(err),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: CONCURRENCY_CAP_REASON.MALFORMED_JSON,
      detail: err && err.message ? err.message : String(err),
    };
  }

  if (!isWellFormedCapSchema(parsed)) {
    return {
      ok: false,
      reason: CONCURRENCY_CAP_REASON.SCHEMA_MISMATCH,
      detail:
        "schema mismatch (schema_version must equal " +
        JSON.stringify(CONCURRENCY_CAP_SCHEMA_VERSION) +
        ", global_hard_cap must be a non-negative integer)",
    };
  }

  return { ok: true, cap: parsed.global_hard_cap, capPath };
}
