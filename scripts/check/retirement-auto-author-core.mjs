// HYK-419-retire-author-1/2 (coder-task.md) -- "누가 은퇴 기록을 자동으로
// 쓸 수 있는가"의 판정/자동화 코어.
//
// ★HYK-419-retire-author-2 (2R 수리, 검토 P1-1 반영): 1R은 이 파일의 zero-
// import 원칙(S8)을 "hyk412 게이트 재사용" 한 곳만 예외로 허용했었다 --
// 그 결과 기계 앵커(경로/지문/기록시각) 검사가 "문자열이 비어 있지 않다"
// 밖으로 나가지 못했고, 검토가 그 틈에 존재하지 않는 경로·형식만 그럴듯한
// 가짜 지문·파싱 불가능한 시각을 주입해 AUTHORIZED_DRAFT를 뽑아냈다
// (docs/HYK-419-retire-author-design.md §7 2R 정정 절 참조). 이 라운드는
// 그 틈을 닫기 위해 zero-import 원칙을 **의도적으로 넓힌다** -- 이 파일은
// 이제 `node:fs`/`node:crypto`/`node:path`를 직접 import해서 앵커를
// «실물»로 검증한다(파일 존재·SHA-256 재계산·시각 파싱). 이건 실수가
// 아니라 이번 계약이 명시적으로 요구한 것이다(coder-task.md §2⑴ "«비어
// 있지 않다» 류 검사로 때우지 마라").
//
// 판정 축(hyk412 게이트 재사용)은 1R 그대로다 -- 이 라운드가 넓힌 것은
// "기계 앵커가 실물과 일치하는가"를 확인하는 새로운 검증 계층이지, 게이트
// 자체의 OPEN/CLOSED 판정 로직이 아니다(새 판정 축 0, coder-task.md §2⑶
// 원칙은 그대로 지킨다 -- 아래 evaluateAutoAuthorAuthorization은 여전히
// evaluateNeverConsumedRetirement의 출력을 그대로 위임할 뿐 재구현하지
// 않는다).
//
// ⛔이 모듈은 어떤 배달 게이트·라이브 원장에도 결선되지 않는다
// (retirement-record-writer.mjs와 동일한 원칙, docs/HYK-412-stuck-retire-
// design.md §3-1 "저자 경계"를 그대로 물려받는다) -- 사람(또는 대리인
// ORCH)이 이 함수의 결과를 손으로 확인하고, 그 다음 손으로
// retirement-record-writer.mjs를 호출해야만 실제 기록이 생긴다.
//
// 자세한 설계 근거는 docs/HYK-419-retire-author-design.md 참조 -- 이 헤더는
// 코드 옆의 요약만 남긴다.
//
// §A 이 코어가 답하는 질문: "hyk412 게이트가 이미 OPEN이라고 판정한
// 라운드에 대해, «사람 서술 없이 기계 기록만으로» 완전한 은퇴 기록 초안을
// 조립할 수 있는가?" 답은 "거의, 그러나 정확히 한 필드는 못 한다"이다 --
// blockReasonCode. retirement-record-core.mjs의 RETIREMENT_BLOCK_REASON
// 닫힌 집합에는 "이 라운드는 소비 시도조차 된 적 없이 방치됐다"를 뜻하는
// 값이 아직 없다(그 집합의 네 값은 전부 "DONE 타임스탬프/재작성 정책"
// 계열이다, retirement-record-core.mjs 헤더 §3-2 참조). 그 값을 새로
// 추가하는 것은 기존 소비 축(checkArchiveFacts/checkReasonAndSuccessorFacts)
// 의 검증 로직을 넓히는 결선이라 이 라운드 범위 밖이다(docs/HYK-412-stuck-
// retire-design.md §3-2·§6이 이미 그렇게 판단했다 -- 이 라운드는 그 판단을
// 뒤집지 않는다). 그래서 이 코어는 blockReasonCode를 **절대로 채우지
// 않는다**(호출자가 그 필드를 넘겨도 무시한다, 아래 §C) -- 그 자리를
// "사람 손이 남는 자리"로 명시적으로 비워 둔다.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import {
  evaluateNeverConsumedRetirement,
  NEVER_CONSUMED_RETIRE_STATE,
} from "./hyk412-never-consumed-retire-core.mjs";

export const AUTO_AUTHOR_STATE = Object.freeze({
  AUTHORIZED_DRAFT: "AUTHORIZED_DRAFT",
  GATE_CLOSED: "GATE_CLOSED",
  MACHINE_ANCHOR_INCOMPLETE: "MACHINE_ANCHOR_INCOMPLETE",
  ARCHIVE_PATH_TRAVERSAL: "ARCHIVE_PATH_TRAVERSAL",
  ARCHIVE_PATH_NOT_FOUND: "ARCHIVE_PATH_NOT_FOUND",
  ARCHIVE_PATH_UNRESOLVABLE: "ARCHIVE_PATH_UNRESOLVABLE",
  ARCHIVE_UNREADABLE: "ARCHIVE_UNREADABLE",
  FINGERPRINT_INVALID: "FINGERPRINT_INVALID",
  RECORDED_AT_INVALID: "RECORDED_AT_INVALID",
  SUCCESSOR_LABEL_GRAMMAR_INVALID: "SUCCESSOR_LABEL_GRAMMAR_INVALID",
});

// 이 코어가 조립하는 초안에서 사람 결정이 반드시 남는 필드(§A). 배열
// 자체를 얼려서(freeze) 호출자가 목록을 조작해 "다 채워졌다"고 우기지
// 못하게 한다(호출자가 이 상수를 읽기만 하지 이 코어가 그 값을 신뢰하지도
// 않는다 -- draftRecord.blockReasonCode는 항상 하드코딩된 null이다).
export const HUMAN_REQUIRED_FIELDS = Object.freeze(["blockReasonCode"]);

// SHA-256 hex는 이 코어 자신의 기본 hashFn(defaultSha256Hex)이 만드는
// 형태와 정확히 같은 소문자 64자만 인정한다(§2⑶ 미열거 기본값 닫힘 --
// 대문자 hex·짧은 문자열·해시가 아닌 임의 문자열 전부 이 정규식 하나로
// 닫힌다).
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
// `retirement-record-writer.mjs`/기존 라벨 관례("HYK-<숫자>-slug-<라운드>")
// 를 그대로 문법으로 삼는다 -- 슬래시/점 두 개 연속(`..`)이 문법 자체에
// 없으므로 경로 조각("../../not-a-real-successor")은 이 정규식 하나로
// 구조적으로 막힌다(새 예외 목록을 만들지 않는다).
const SUCCESSOR_LABEL_GRAMMAR_RE = /^HYK-\d+(-[A-Za-z0-9]+)*$/;
const RECORDED_AT_FORMAT_RE =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) KST$/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function defaultSha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// §B 기계 앵커 필드 넷(harnessDir/ownTaskArchivePath/
// ownTaskArchiveFingerprint/recordedAt) -- 이 단계는 "값이 존재하는가"만
// 본다(형식·실물 검증은 아래 각 전용 관문 몫). 하나라도 비어 있거나
// 문자열이 아니면 "기계 근거가 아직 다 안 모였다"로 안전측 거부한다
// (빈 문자열/undefined/숫자 등 어떤 타입이 와도 truthy-fold 없이 거부).
function checkMachineAnchorFacts({
  harnessDir,
  ownTaskArchivePath,
  ownTaskArchiveFingerprint,
  recordedAt,
}) {
  const missing = [];
  if (!isNonEmptyString(harnessDir)) missing.push("harnessDir");
  if (!isNonEmptyString(ownTaskArchivePath)) missing.push("ownTaskArchivePath");
  if (!isNonEmptyString(ownTaskArchiveFingerprint))
    missing.push("ownTaskArchiveFingerprint");
  if (!isNonEmptyString(recordedAt)) missing.push("recordedAt");
  if (missing.length === 0) return null;
  return {
    state: AUTO_AUTHOR_STATE.MACHINE_ANCHOR_INCOMPLETE,
    ok: false,
    reason: `retirement-auto-author: 기계 앵커 필드 누락(${missing.join(", ")}) -> 은퇴 기록 초안을 조립할 기계 근거가 아직 다 모이지 않음, 거부(안전측 기본값)`,
  };
}

// ★2R: ownTaskArchivePath가 harnessDir 밖을 가리키지 않는지 문자열
// 구조로 먼저 거부한다(파일시스템에 닿기 전 -- 절대경로·`..` 세그먼트·
// 드라이브 표기 전부 닫는다). 이후 resolveSafeArchivePath가 실제 resolve
// 결과로 한 번 더 재확인한다(문자열 검사만으로 놓칠 수 있는 경로를
// defense-in-depth로 이중 차단). ★3R: 이 두 관문은 여전히 "어휘적"이다
// -- 심볼릭 링크·정션은 문자열만으로 판정할 수 없으므로(검토 P1-1) 이
// 관문들만으로는 못 막는다, 아래 verifyRealpathContainment가 그 틈을
// 메운다.
function looksLikeTraversal(relPath) {
  if (relPath.startsWith("/") || relPath.startsWith("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(relPath)) return true;
  return relPath.split(/[\\/]+/).includes("..");
}

// 되돌림 변이 4/9 대상: 이 함수 본문의 두 관문(문자열 휴리스틱 +
// resolve 결과 포함관계 재확인)을 통째로 지우면 harnessDir 밖의 실재
// 파일까지 그대로 resolve돼 존재/지문 확인 단계로 새어 나간다. resolve
// 결과가 정말 harnessDir 하위인지까지 재확인하고, 그렇지 않으면
// null(거부)을 반환한다. 통과하면 실제 절대경로 문자열을 돌려준다.
function resolveSafeArchivePath(harnessDir, relPath) {
  if (looksLikeTraversal(relPath)) return null;
  const base = resolve(harnessDir);
  const full = resolve(base, relPath);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

// ★3R (검토 P1-1 반영): lexical 포함 검사(resolveSafeArchivePath)는
// 심볼릭 링크·정션의 «대상»을 보지 않는다 -- `harnessDir/rounds/
// linked.md`라는 문자열은 harnessDir 하위이지만, 그 파일이 실제로는
// harnessDir 밖의 다른 파일을 가리키는 링크일 수 있다. 이 함수는 lexical
// 검사를 통과한 뒤 **realpath로 링크·정션을 실제로 해석**해 그 물리
// 경로가 정말 harnessDir 하위인지 다시 확인한다. harnessDir 자신도
// realpath로 정규화한다(양쪽 다 풀어야 한다 -- harnessDir 자체가 심볼릭
// 트리 밑에 있으면 한쪽만 풀었을 때 오탐/누락이 생긴다). 되돌림 변이
// 5/9 대상: 이 함수 호출을 지우면 심볼릭 링크로 우회된 harnessDir 밖
// 파일도 그대로 통과한다(검토가 만든 실제 침해 재현).
//
// 플랫폼 정직 한계(coder-task.md §2⑴ⓒ): `fs.realpathSync`는 Windows의
// NTFS 정션(디렉터리 reparse point)도 투명하게 해석한다(Node 내부적으로
// `GetFinalPathNameByHandle` 계열 API를 쓴다) -- 이 코어가 따로 분기하지
// 않아도 정션이 자동으로 닫힌다. 경로 대소문자는 이 코어가 스스로
// 정규화하지 않는다 -- Windows NTFS는 대소문자를 구분하지 않는 파일시스템
// 이므로 `realpathSync`가 돌려주는 대소문자 표기 자체가 이미 그 파일시스템
// 이 "실제로 저장한" 표기다(별도 대소문자 정규화가 필요 없다, POSIX
// 대소문자 구분 파일시스템에서는 애초에 문제가 되지 않는다).
function verifyRealpathContainment(harnessDir, full, realpathFn) {
  let realBase;
  try {
    realBase = realpathFn(harnessDir);
  } catch (err) {
    return {
      state: AUTO_AUTHOR_STATE.ARCHIVE_PATH_UNRESOLVABLE,
      ok: false,
      reason: `retirement-auto-author: harnessDir('${harnessDir}')의 realpath를 확인할 수 없음(${err.message}) -> 포함 관계를 검증하지 못함, 거부(안전측 기본값)`,
    };
  }
  let realFull;
  try {
    realFull = realpathFn(full);
  } catch (err) {
    if (err.code === "ENOENT") {
      // 파일이 실제로 없다 -- 이건 "탈출"이 아니라 "부재"다. existsFn이
      // 이미 true를 반환한 뒤 이 지점에 도달했다면(TOCTOU: existsFn과
      // realpathFn 호출 사이에 파일이 삭제됨) 조용히 통과시키지 않고
      // 호출자(existsFn 재확인 이후 경로)가 그 사실을 알 수 있도록 null을
      // 돌려준다 -- 이 함수 자신은 "존재하지 않음"을 사유 코드로 만들지
      // 않는다(그건 checkResolvedArchivePath의 existsFn 관문 몫, 안전측
      // 기본값이 이미 그쪽에서 적용된다).
      return null;
    }
    return {
      state: AUTO_AUTHOR_STATE.ARCHIVE_PATH_UNRESOLVABLE,
      ok: false,
      reason: `retirement-auto-author: ownTaskArchivePath가 가리키는 실제 경로를 확인할 수 없음(${err.message}) -> 거부(안전측 기본값)`,
    };
  }
  if (realFull !== realBase && !realFull.startsWith(realBase + sep)) {
    return {
      state: AUTO_AUTHOR_STATE.ARCHIVE_PATH_TRAVERSAL,
      ok: false,
      reason: `retirement-auto-author: ownTaskArchivePath가 심볼릭 링크/정션을 통해 harnessDir 밖(실제 경로 '${realFull}')을 가리킴 -> 경로 탈출(링크 우회) 의심, 거부(안전측 기본값)`,
    };
  }
  return null;
}

// checkArchiveExists/checkFingerprint 둘 다 이 한 함수만 통해서 fs에
// 닿는다(중복 정의 없음, 단일 선택 지점) -- lexical 탈출 검사 →
// 존재 확인 → realpath 재확인(★3R) 세 관문을 순서대로 통과해야
// {ok:true, full}을 돌려준다.
function resolveVerifiedArchivePath({
  harnessDir,
  ownTaskArchivePath,
  existsFn,
  realpathFn,
}) {
  const full = resolveSafeArchivePath(harnessDir, ownTaskArchivePath);
  if (full === null) {
    return {
      ok: false,
      failure: {
        state: AUTO_AUTHOR_STATE.ARCHIVE_PATH_TRAVERSAL,
        ok: false,
        reason: `retirement-auto-author: ownTaskArchivePath('${ownTaskArchivePath}')가 harnessDir 밖을 가리키거나 절대/드라이브 경로다 -> 경로 탈출 의심, 거부(안전측 기본값)`,
      },
    };
  }
  // 되돌림 변이 6/9 대상: 이 관문을 지우면 검토가 실제로 주입한
  // `"rounds/DOES-NOT-EXIST.md"`(실존하지 않는 아카이브 경로)도
  // 다음 단계로 새어 나간다.
  if (existsFn(full) !== true) {
    return {
      ok: false,
      failure: {
        state: AUTO_AUTHOR_STATE.ARCHIVE_PATH_NOT_FOUND,
        ok: false,
        reason: `retirement-auto-author: ownTaskArchivePath('${ownTaskArchivePath}')가 가리키는 아카이브 사본이 실제로 존재하지 않음(${full}) -> 거부(안전측 기본값)`,
      },
    };
  }
  const realpathFailure = verifyRealpathContainment(
    harnessDir,
    full,
    realpathFn,
  );
  if (realpathFailure) return { ok: false, failure: realpathFailure };
  return { ok: true, full };
}

function checkArchiveExists({
  harnessDir,
  ownTaskArchivePath,
  existsFn,
  realpathFn,
}) {
  const resolved = resolveVerifiedArchivePath({
    harnessDir,
    ownTaskArchivePath,
    existsFn,
    realpathFn,
  });
  return resolved.ok ? null : resolved.failure;
}

// 되돌림 변이 7/9 대상: 이 관문을 지우면 형식만 흉내 낸 지문
// (`"FORGED-FINGERPRINT"`)도, 형식은 맞지만 실제 파일과 다른 지문도
// AUTHORIZED_DRAFT까지 새어 나간다. 지문 «형식»(소문자 hex 64자)과
// «실값 일치»(실제 파일을 다시 해싱) 둘 다 이 한 관문이 함께 확인한다 --
// 형식이 아예 다르면 파일을 읽지 않고도 즉시 거부하고(무의미한 I/O
// 생략), 형식이 맞으면 반드시 실제로 다시 해싱해서 비교한다(문자열
// 비교만으로 "그럴듯한 값"에 속지 않는다). checkArchiveExists가 이미
// 정상 실행 경로에서 앞서 통과했더라도, 이 함수는 스스로 다시
// resolveVerifiedArchivePath(경로 탈출+존재+realpath 세 관문 전부)를
// 거친다(같은 자격으로 단독 호출되는 미래 호출자를 대비한 방어적 중복 --
// 이 함수 자신도 링크로 우회된 파일을 읽지 않기 위해서다).
function checkFingerprint({
  harnessDir,
  ownTaskArchivePath,
  ownTaskArchiveFingerprint,
  existsFn,
  realpathFn,
  readFileFn,
  hashFn,
}) {
  const resolved = resolveVerifiedArchivePath({
    harnessDir,
    ownTaskArchivePath,
    existsFn,
    realpathFn,
  });
  if (!resolved.ok) return resolved.failure;
  if (!SHA256_HEX_RE.test(ownTaskArchiveFingerprint)) {
    return {
      state: AUTO_AUTHOR_STATE.FINGERPRINT_INVALID,
      ok: false,
      reason: `retirement-auto-author: ownTaskArchiveFingerprint('${ownTaskArchiveFingerprint}')가 SHA-256 hex 형식(소문자 64자)이 아님 -> 거부(안전측 기본값)`,
    };
  }
  let content;
  try {
    content = readFileFn(resolved.full);
  } catch (err) {
    return {
      state: AUTO_AUTHOR_STATE.ARCHIVE_UNREADABLE,
      ok: false,
      reason: `retirement-auto-author: ownTaskArchivePath('${ownTaskArchivePath}')를 읽을 수 없음(${err.message}) -> 거부(안전측 기본값)`,
    };
  }
  const recomputed = hashFn(content);
  if (recomputed !== ownTaskArchiveFingerprint) {
    return {
      state: AUTO_AUTHOR_STATE.FINGERPRINT_INVALID,
      ok: false,
      reason: `retirement-auto-author: ownTaskArchiveFingerprint('${ownTaskArchiveFingerprint}')가 실제 파일을 다시 해싱한 값('${recomputed}')과 다름 -> 위조 의심, 거부(안전측 기본값)`,
    };
  }
  return null;
}

// KST 문자열을 UTC ms로 파싱한다. 형식이 다르거나(§2⑶: "not-a-time" 등
// 임의 문자열) 달력상 존재하지 않는 날짜(예: 2026-02-30)면 null -- 형식
// 정규식만으로는 못 잡는 값을 Date.UTC 왕복 검증으로 한 번 더 닫는다.
function parseKstTimestampToUtcMs(value) {
  const m = RECORDED_AT_FORMAT_RE.exec(value);
  if (!m) return null;
  const [, yStr, moStr, dStr, hStr, miStr, sStr] = m;
  const y = Number(yStr);
  const mo = Number(moStr);
  const d = Number(dStr);
  const h = Number(hStr);
  const mi = Number(miStr);
  const s = Number(sStr);
  const asIfUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const roundTrip = new Date(asIfUtc);
  const calendarValid =
    roundTrip.getUTCFullYear() === y &&
    roundTrip.getUTCMonth() === mo - 1 &&
    roundTrip.getUTCDate() === d &&
    roundTrip.getUTCHours() === h &&
    roundTrip.getUTCMinutes() === mi &&
    roundTrip.getUTCSeconds() === s;
  if (!calendarValid) return null;
  return asIfUtc - KST_OFFSET_MS;
}

// 되돌림 변이 8/9 대상: 이 관문을 지우면 `"not-a-time"`(파싱 불가) 뿐
// 아니라 미래 시각(아직 오지 않은 recordedAt)도 AUTHORIZED_DRAFT까지
// 새어 나간다 -- 형식 파싱과 미래-거부를 한 관문으로 묶는다(검토가 지목한
// 값은 형식 위반 하나였지만, coder-task.md §2⑴ⓒ가 "미래가 아님"까지
// 명시적으로 요구했으므로 같은 관문에서 함께 닫는다).
function checkRecordedAt({ recordedAt, nowFn }) {
  const utcMs = parseKstTimestampToUtcMs(recordedAt);
  if (utcMs === null) {
    return {
      state: AUTO_AUTHOR_STATE.RECORDED_AT_INVALID,
      ok: false,
      reason: `retirement-auto-author: recordedAt('${recordedAt}')이 'YYYY-MM-DD HH:MM:SS KST' 형식으로 파싱되지 않음(형식 위반 또는 존재하지 않는 달력 날짜) -> 거부(안전측 기본값)`,
    };
  }
  if (utcMs > nowFn().getTime()) {
    return {
      state: AUTO_AUTHOR_STATE.RECORDED_AT_INVALID,
      ok: false,
      reason: `retirement-auto-author: recordedAt('${recordedAt}')이 미래 시각임 -> 거부(안전측 기본값)`,
    };
  }
  return null;
}

// 되돌림 변이 9/9 대상: 이 관문을 지우면 `"../../not-a-real-successor"`
// 처럼 경로 조각을 흉내 낸 후속 이름표도 AUTHORIZED_DRAFT까지 새어
// 나간다. 문법(HYK-<숫자>[-슬러그...])을 벗어나는 값은 전부 이 정규식
// 하나로 닫힌다(예외 목록이 아니라 허용 목록 구조 자체가 방어선).
function checkSuccessorLabelGrammar(successorLabelForRecord) {
  if (SUCCESSOR_LABEL_GRAMMAR_RE.test(successorLabelForRecord)) return null;
  return {
    state: AUTO_AUTHOR_STATE.SUCCESSOR_LABEL_GRAMMAR_INVALID,
    ok: false,
    reason: `retirement-auto-author: successorLabelForRecord('${successorLabelForRecord}')가 라벨 문법(HYK-<숫자>[-슬러그...])에 맞지 않음 -> 경로 조각/임의 문자열 의심, 거부(안전측 기본값)`,
  };
}

// eslint complexity/length 상한 회피(retirement-record-core.mjs의
// checkArchiveFacts/checkReasonAndSuccessorFacts 선례와 동일한 이유 --
// 판정/문구는 조금도 바뀌지 않는다, 몸통만 쪼갠다). 앵커 존재→경로 탈출/
// 실존→지문→기록시각→후속이름표 다섯 관문을 순서대로 통과해야 null(계속
// 진행), 실패하면 그 사유의 {state, ok:false, reason, ...}를 그대로
// 반환한다.
function checkMachineAnchorsAgainstReality(
  {
    harnessDir,
    ownTaskArchivePath,
    ownTaskArchiveFingerprint,
    recordedAt,
    successorLabelForRecord,
  },
  { existsFn, realpathFn, readFileFn, hashFn, nowFn },
) {
  const anchorFailure = checkMachineAnchorFacts({
    harnessDir,
    ownTaskArchivePath,
    ownTaskArchiveFingerprint,
    recordedAt,
  });
  if (anchorFailure) return anchorFailure;

  const existsFailure = checkArchiveExists({
    harnessDir,
    ownTaskArchivePath,
    existsFn,
    realpathFn,
  });
  if (existsFailure) return existsFailure;

  const fingerprintFailure = checkFingerprint({
    harnessDir,
    ownTaskArchivePath,
    ownTaskArchiveFingerprint,
    existsFn,
    realpathFn,
    readFileFn,
    hashFn,
  });
  if (fingerprintFailure) return fingerprintFailure;

  const recordedAtFailure = checkRecordedAt({ recordedAt, nowFn });
  if (recordedAtFailure) return recordedAtFailure;

  const successorGrammarFailure = checkSuccessorLabelGrammar(
    successorLabelForRecord,
  );
  if (successorGrammarFailure) return successorGrammarFailure;

  return null;
}

// The one function this module exists to provide.
//
// facts: hyk412-never-consumed-retire-core.mjs의 evaluateNeverConsumedRetirement
// 가 받는 것과 정확히 같은 필드 전부 **그대로 위임**한다(§2⑶ "새 판정 축
// 금지") + 이 코어가 추가로 요구하는 기계 앵커 필드(harnessDir/
// ownTaskArchivePath/ownTaskArchiveFingerprint/recordedAt, §B).
//
// deps: 실물 검증에 쓰는 I/O seam -- 시험은 주입하고, 실 호출자는 전부
// 기본값(진짜 파일시스템/진짜 해시/진짜 시계)을 쓴다(coder-task.md §2⑴
// "기본값은 실제 파일시스템이어야 한다").
//
// ⛔blockReasonCode를 facts에 넣어도 무시한다 -- 이 함수의 시그니처 자체가
// 그 값을 읽지 않는다(구조적으로 닫힌 표면, §C 아래 참조).
export function evaluateAutoAuthorAuthorization(
  facts = {},
  {
    existsFn = existsSync,
    realpathFn = realpathSync,
    readFileFn = readFileSync,
    hashFn = defaultSha256Hex,
    nowFn = () => new Date(),
  } = {},
) {
  const {
    role,
    harnessTaskLabel,
    ledgerReservation,
    dispatchReceiptMatchCount,
    resultArchiveExists,
    ownTaskArchiveExists,
    hasLaterRoundArchive,
    staleEnoughSinceAdmission,
    successorLabelForRecord,
    harnessDir,
    ownTaskArchivePath,
    ownTaskArchiveFingerprint,
    recordedAt,
  } = facts;

  const gate = evaluateNeverConsumedRetirement({
    role,
    harnessTaskLabel,
    ledgerReservation,
    dispatchReceiptMatchCount,
    resultArchiveExists,
    ownTaskArchiveExists,
    hasLaterRoundArchive,
    staleEnoughSinceAdmission,
    successorLabelForRecord,
  });

  if (gate.state !== NEVER_CONSUMED_RETIRE_STATE.OPEN) {
    return {
      state: AUTO_AUTHOR_STATE.GATE_CLOSED,
      ok: false,
      gateState: gate.state,
      reason: `retirement-auto-author: hyk412 게이트가 OPEN이 아님(${gate.state}) -> 자동 작성 자격 없음, 거부(안전측 기본값). 게이트 사유: ${gate.reason}`,
    };
  }

  const realityFailure = checkMachineAnchorsAgainstReality(
    {
      harnessDir,
      ownTaskArchivePath,
      ownTaskArchiveFingerprint,
      recordedAt,
      successorLabelForRecord,
    },
    { existsFn, realpathFn, readFileFn, hashFn, nowFn },
  );
  if (realityFailure) return realityFailure;

  // §C blockReasonCode는 항상 null로 하드코딩한다 -- facts.blockReasonCode를
  // 읽는 코드 자체가 이 함수 안에 없다(위조하려면 이 파일의 소스 자체를
  // 고쳐야 한다, 캐치 불가능한 "그냥 안 읽는다"가 가장 강한 닫힘이다).
  return {
    state: AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT,
    ok: true,
    draftRecord: {
      role,
      harnessTaskLabel,
      archivePath: ownTaskArchivePath,
      archiveFingerprintClaimed: ownTaskArchiveFingerprint,
      blockReasonCode: null,
      successorLabel: successorLabelForRecord,
      recordedAt,
      evidence: { source: "hyk412-never-consumed", gateState: gate.state },
    },
    humanRequiredFields: HUMAN_REQUIRED_FIELDS,
    reason: `retirement-auto-author: hyk412 게이트 OPEN + 아카이브 실물 검증(경로 탈출 없음+실존+지문 재계산 일치)+기록시각(형식+미래아님)+후속이름표(문법) 전부 통과 -> 은퇴 기록 초안 조립 가능. blockReasonCode는 닫힌 사유 집합(retirement-record-core.mjs의 RETIREMENT_BLOCK_REASON)에 "미소비 방치"를 뜻하는 값이 아직 없어 기계로 못 채움 -> null로 남김(사람 결정 필요, docs/HYK-419-retire-author-design.md §3 참조). 이 초안은 blockReasonCode가 채워지기 전에는 retirement-record-core.mjs의 checkRetirementRecord를 통과하지 못한다(INVALID_REASON_CODE로 거부됨 -- 사람 손이 빠지면 구조적으로 완성되지 않는다).`,
  };
}
