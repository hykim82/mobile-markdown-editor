// HYK-224 (coder-task.md §1 항 2) -- "완료는 워커의 자기신고가 아니다 --
// 결과 소비자가 dispatch 결속을 검증한 뒤 «중립 실행부」가 기록한다."
//
// checkRelayHandshake (relay-handshake.mjs) is exactly that 중립 실행부: by
// the point it calls this adapter, it has ALREADY independently verified
// task_id binding (task file's task_id === result file's echoed task_id,
// HYK-183 anti-forgery) and staleness (DONE postdates dropped_at). The
// worker's own result file text never determines completion by itself --
// this only fires after checkRelayHandshake's own checks already passed,
// mirroring exactly where autoArchiveRoundEnvelope/autoRecordRejectStreak
// are wired (same call site, same "never mutates the caller's verdict"
// contract).
//
// 정직 한계(S11, same pattern as concurrency-cap-adapter.mjs's `live=false`)
// -- 1R: this was purely env-gated (`ADMISSION_LEDGER_PATH`), never wired
// unconditionally. Reason: the admission ledger is a GLOBAL, cross-repo/
// cross-worktree file (관제실 소유, coder-task §4 -- the ps1 side owns that
// path, not this repo), so this repo cannot hardcode it without breaking
// the isolated-clone CI runner (scripts/check/isolated-suite-runner.mjs
// clones this repo into a disposable tmp dir per run -- a hardcoded
// real-world path would make CI runs silently mutate 관제실 state, or fail
// there, neither of which 1R's scope covered). 1R shipped that env-only
// gate and escalated: nothing in this repo or 관제실 ever SET that env var,
// so in production the adapter was a 100% no-op regardless of how correct
// the call-site wiring was (1R's own coder.md 결과, confirmed by a live
// incident the same night -- ORCH had to hand-run
// `admission-cli complete` because nothing auto-released the slot).
//
// HYK-227 2R §2 (한용 판정 2026-08-12 08:56): env stays first-priority (a
// caller that explicitly sets it always wins, e.g. this file's own test
// suite), but resolvePersistentLedgerPaths() below adds a SECOND source --
// a small JSON pointer file the installer (templates/harness-init/
// install.mjs) writes once, at the one location every process (regardless
// of worktree) can find via mainRepoRoot() -- the exact "one place
// regardless of which worktree runs this" resolution relay-handshake.mjs's
// own reject-streak ledger already relies on (see that file's
// mainRepoRoot(), duplicated here rather than imported to keep this file's
// own isolated-fixture dependency closure unchanged -- see this file's
// own header on why a NEW static import here is exactly the risk 1R's
// spawn-not-import design avoided at the relay-handshake.mjs boundary).
// ⛔ this is "env-priority + persistent fallback", NOT "env got wired in" --
// when BOTH are absent, the adapter is still the exact same documented
// no-op (`attempted:false`) it always was; that branch's behavior and
// message text are UNCHANGED by this round (HYK-227 2R §3 항1 요구).
import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  completeReservation,
  COMPLETION_REASON,
} from "../supervisor/admission-ledger-core.mjs";
import { withLedgerLock } from "../supervisor/admission-ledger-store.mjs";
// HYK-398 §2-⑶ (책임자에게 위임된 설계 판단, 이 라운드의 결정과 근거):
// 이 파일 헤더(위 §2-A 이하)는 "무겁게 참조되는 모듈(dispatch-gate-
// decision.mjs 등)을 끌어들이지 않기 위해 작은 것들은 복제한다"는 원칙을
// 세워 두었고, retirement-record-core.mjs를 정적 import하지 «않는» 것은
// 지금까지 그 원칙의 결과가 아니라 단지 "아직 이 축을 쓰는 완료 사유가
// 없었다"는 사실의 반영이었을 뿐이다(§1 실측: 이 회차 전까지 완료 사유는
// BLOCKED_TERMINATION_RELEASED 하나뿐). retirement-record-core.mjs 자신은
// §2(모듈 헤더)가 명시하는 "zero-import 코어"다 -- node 내장도, 이 저장소의
// 다른 파일도 import하지 않는다(직접 확인: 이 파일 맨 위에 import 문이
// 하나도 없다). 이미 이 파일이 정적 import하는 admission-ledger-core.mjs·
// admission-ledger-store.mjs·ledger-pointer-shared.mjs와 정확히 같은
// 무게(0)다 -- dispatch-gate-decision.mjs를 끌어들일 때와 같은 위험(그
// 파일의 전체 의존성 트리, 이 어댑터를 격리 픽스처에 스폰하는 여러
// mutation 시험의 고정 파일 목록 붕괴)이 전혀 없다. 그래서 이 회차는 그
// 의도를 "바꾼다": zero-import 코어는 정적으로 들여오고, retirement-
// record-core.mjs가 스스로 읽지 않는 사실들(은퇴 기록 후보 로딩·아카이브
// 사본 위치/지문 대조·기계로 확인 가능한 사유 재확인)만 이 파일이 직접
// 재현한다(아래 헬퍼들) -- dispatch-gate-decision.mjs의 동명 로직과
// «같은 계약»이되, 이 파일 자신의 신뢰 경계(캐치되지 않는 무거운 import
// 0)를 지킨다.
import {
  checkRetirementRecord,
  RETIREMENT_RECORD_STATE,
} from "./retirement-record-core.mjs";
// HYK-302/355 §2-A: single-source these two (previously duplicated here and
// in orch-stall-detect.mjs / relay-handshake.mjs respectively) -- see
// ledger-pointer-shared.mjs's own header for why this is now imported
// rather than duplicated a third time, and coder.md for the fixture sibling
// lists this round updated to keep every isolated mutation test loadable.
import {
  PERSISTENT_LEDGER_POINTER_FILENAME,
  isInsideGitWorktree,
} from "./ledger-pointer-shared.mjs";
// HYK-457 §3-A: single-source confirmRetirementBlockReason (previously
// duplicated here as confirmRetirementBlockReasonForAdapter and in
// dispatch-gate-decision.mjs) -- see retirement-block-reason-shared.mjs's
// own header, and coder.md for the fixture sibling lists this round updated.
import { confirmRetirementBlockReason } from "./retirement-block-reason-shared.mjs";
// HYK-461 §4-A: the envelope-binding read-back validator, single-sourced in
// its producer module (envelope-archive.mjs's resolveEnvelopeBindingValidity).
// HYK-456 §5-1 measured this exact gap: resolveRetirementArchiveCandidateForAdapter
// below computed NO envelopeBindingValid, so it reached checkRetirementRecord
// as `undefined`, the core's `=== false` guard never fired, and a forged/hand
// copy header passed through the adapter's RETIREMENT_RELEASED path even
// though the canonical gate (dispatch-gate-decision.mjs) already rejected it.
// envelope-archive.mjs imports nothing from this repo (node:fs/path/crypto
// only), so adding it to this adapter's isolated-fixture sibling closure is
// cheap -- unlike dragging in dispatch-gate-decision.mjs, whose full import
// graph is exactly what this file's header (§ P1-1) forbids. The fixture
// sibling lists that stage a synthetic copy of THIS file were all updated
// this round to also stage envelope-archive.mjs (coder.md §4-A 전수 점검).
import { resolveEnvelopeBindingValidity } from "./envelope-archive.mjs";
// HYK-342 2R P1-1 (검토 원문 "회수 표식의 생산자 권한이 검증되지 않는다"):
// ⛔처음에는 relay-handshake.mjs에서 resolveResultTaskId/
// resolveResultBlockedState를 static import했으나, 실측 결과 이 파일을
// 고정 파일 목록으로 격리 clone하는 mutation 시험이 실제로 있었다
// (admission-completion-worktree-isolation.test.mjs·admission-completion-
// persistent-source.test.mjs 등 -- 실행해서 MODULE_NOT_FOUND로 직접 확인,
// "0건"이라던 최초 추정이 틀렸다). 그래서 이 파일 헤더가 위(§51-59
// repoRoot/mainRepoRoot 주석)에서 이미 설명한 그 원칙("무거운/많이 참조되는
// 모듈을 끌어들이지 않기 위해 작은 것들은 복제한다") 그대로, task_id 에코·
// BLOCKED/NEEDS_INPUT 표지 판정에 필요한 최소 조각만 아래에 복제한다 --
// relay-handshake.mjs의 BLOCKED_RE와 **바이트 동일**(그 파일 자신의
// 정의를 그대로 인용) -- "새로 발명"이 아니라 "같은 계약을 옮겨 적은
// 것"이다. 이 두 파일이 갈라지면(예: 근접-미스 처리가 relay-handshake.mjs
// 에서 갱신되는데 여기가 안 따라가면) 그 자체가 회귀이므로, 이 상수를
// 고칠 때는 반드시 relay-handshake.mjs의 동명 상수와 대조하라(주석으로만
// 강제되는 계약 -- 기계 강제는 이번 범위 밖).
const BLOCKED_RE = /^>>>[ \t]*(BLOCKED|NEEDS_INPUT):[ \t]*(\S.*?)[ \t]*$/gim;

// HYK-468 3R (P1-1, 검토자 반려 재수리): 2R은 이 함수를 "첫 빈 줄 앞만
// 읽는" 방식으로 두고 "이미 1R에서 고쳤다"고 잘못 전제했다 -- 실은 그
// "첫 빈 줄" 방식 자체가 1R의 틀린 초안이었고(아래 참조), 2R 지시서가
// 세 번째 독자(이 파일)에는 그 사실을 반영하라고 말하지 않아 여기만 옛
// 방식에 머물렀다(ORCH 스펙 오류, coder-task.md §1 표 참조). 검토자가
// NC-2 입력(빈 줄로 갈린 «구조적» 선언 2개)을 직접 주입해, relay·dispatch는
// 거부하는데 이 함수만 「옛 값」을 확정함을 실측으로 잡았다 -- 실제 소비
// 경로의 fail-closed 보장을 깨는 P1.
//
// header-task-id-shared.mjs(정본)의 STRUCTURAL_LINE_RE/
// hasStructuralPredecessor/resolveHeaderTaskId와 **로직 동일**(이 파일이
// 위 헤더에서 이미 설명한 "무거운/많이 참조되는 모듈을 끌어들이지 않기
// 위해 작은 것들은 복제한다" 원칙 그대로 -- 새 import를 추가하면
// admission-completion-worktree-isolation.test.mjs/admission-completion-
// persistent-source.test.mjs의 고정 sibling 파일 목록이 이 파일을 더는
// 못 찾아 MODULE_NOT_FOUND로 깨진다, 실측 확인. maskQuotedMarkerRegions도
// 같은 이유로 reject-streak.mjs에서 import하지 않고 아래에 로컬 복제한다).
// 네 곳(이 함수 + relay-handshake.mjs 로컬 사본 + dispatch-gate-
// decision.mjs 로컬 사본 + header-task-id-shared.mjs 정본)이 갈라지면
// 회귀이므로 고칠 때는 반드시 서로 대조하라(scripts/check/hyk468-3r-copy-
// drift.test.mjs가 STRUCTURAL_LINE_RE와 hasStructuralPredecessor 본문의
// 바이트 동일성을 기계로 단정한다).
//
// task_id: 선언은 정확히 하나의 «구조적 선행 맥락»이 있는 열0 줄에서만
// 읽는다 -- 그 바로 앞(빈 줄/마스킹된 줄은 건너뛰고) 줄이 다른 헤더 줄
// (`key:` 형태)이거나 `>>>` 표지이거나 파일 맨 앞이면 «진짜», 산문이
// 선행하면 «인용/예시»로 본다(2R이 고친 hyk442-blocked-door-1/.harness/
// coder.md 1행 실선언 + 24행 인용 예시 실사고는 여전히 막는다).
// ⚠️1R의 "첫 빈 줄 앞만" 방식, 2R의 그 방식 유지는 둘 다 회귀였다 --
// 빈 줄로 나뉜 두 개의 «진짜» 구조적 task_id: 선언(옛 라운드 유지 + 새
// 라운드 추가, 산문 없음, HYK-183 NC-2 모양)을 헤더 블록 밖이라는 이유로
// 못 보고 스테일 값(matches[0])으로 조용히 확정해 버렸다(검토자 실측:
// admission만 `ok:true,id:"HYK-468-old"`, relay/dispatch는 거부).
// 자세한 이유는 header-task-id-shared.mjs 헤더 주석 참조(이 로직의 정본).
// HYK-468 4R (P1, 검토자 반려 재수리): 아래 resolveHeaderTaskId 본문은
// 이 정규식을 인라인으로 두고 있었다 -- STRUCTURAL_LINE_RE는 이미 이름을
// 가져서 드리프트 시험이 볼 수 있었지만, 이 상수는 이름이 없어 시험의
// 손으로 고른 비교 목록에 애초에 오를 자리가 없었다(정본과 다르게 갈라진
// 것은 relay였지만, 그 갈라짐이 안 잡힌 진짜 이유는 "목록에 없어서"다).
// 정본 header-task-id-shared.mjs가 export하는 RULE_CONSTANTS.
// TASK_ID_LINE_RE와 바이트 동일하게 이름을 맞춘다.
const TASK_ID_LINE_RE = /^task_id:[ \t]*(\S+)/i;
const STRUCTURAL_LINE_RE = /^[A-Za-z_][\w-]*:|^>>>/;

function hasStructuralPredecessor(lines, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    if (lines[i].trim() === "") continue;
    return STRUCTURAL_LINE_RE.test(lines[i]);
  }
  return true;
}

// reject-streak.mjs의 maskQuotedMarkerRegions와 **바이트 동일 로직**의
// 로컬 복제 -- 이 함수 자체는 위 hasStructuralPredecessor의 바이트 동일성
// 계약(드리프트 시험 대상) 밖이다: 함수 본문 축 드리프트 시험은
// STRUCTURAL_LINE_RE 정규식과 hasStructuralPredecessor 본문만 대조한다
// (coder-task.md §2-2). import하지 않고 복제하는 이유는 위
// resolveHeaderTaskId 주석과 동일(고정 sibling 파일 목록 MODULE_NOT_FOUND
// 실측).
// HYK-469 3R §1 (책임자 조건 1): 아래 인라인 코드 구간 정규식 +
// inlineCodeRanges/isInsideAnyRange/findOutsideInlineCode 세 헬퍼와
// maskHtmlComments 본문은 reject-streak.mjs가 2R에서 export한
// RULE_FUNCTIONS 묶음과 «바이트 동일하게» 이식됐다(로직 창작 0) --
// hyk468-3r-copy-drift.test.mjs가 그 묶음을 순회하며 이 사본을 기계로
// 대조한다(§2, "순회 계약"으로 확장, 손으로 고른 목록이 아니다). 2R까지는
// 이 로컬 복제가 옛(순수 indexOf) 형태에 멈춰 있어, 병합 후 admission만
// 인라인 코드로 감싼 <!--/--> 후보를 진짜 주석으로 오판해 옛 판정을
// fail-open으로 확정했다(469 3R coder-task.md §0 반려 사유 그대로).
const INLINE_CODE_SPAN_RE = /`[^`\n]*`/g;

function inlineCodeRanges(content) {
  const ranges = [];
  for (const m of content.matchAll(INLINE_CODE_SPAN_RE)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function isInsideAnyRange(ranges, pos) {
  return ranges.some(([start, end]) => pos >= start && pos < end);
}

function findOutsideInlineCode(content, needle, from, ranges) {
  let at = content.indexOf(needle, from);
  while (at !== -1 && isInsideAnyRange(ranges, at)) {
    at = content.indexOf(needle, at + 1);
  }
  return at;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

function blankKeepingNewlines(text) {
  return text.replace(/[^\n]/g, " ");
}

function maskFencedBlocks(content) {
  let fence = null;
  return content
    .split("\n")
    .map((line) => {
      if (fence === null) {
        const opened = FENCE_OPEN_RE.exec(line);
        if (!opened) return line;
        fence = { char: opened[1][0], len: opened[1].length };
        return blankKeepingNewlines(line);
      }
      const closer = new RegExp(
        `^ {0,3}\\${fence.char}{${fence.len},}[ \t\r]*$`,
      );
      if (closer.test(line)) fence = null;
      return blankKeepingNewlines(line);
    })
    .join("\n");
}

function maskHtmlComments(content) {
  // ⚠️구간은 «원문»(마스킹 전) 기준으로 한 번만 계산한다 -- 아래 루프의
  // 블랭크는 길이를 보존하므로(blankKeepingNewlines) 오프셋이 반복 내내
  // 그대로 유효하다.
  const codeRanges = inlineCodeRanges(content);
  let out = content;
  let from = 0;
  for (;;) {
    const start = findOutsideInlineCode(out, "<!--", from, codeRanges);
    if (start === -1) return out;
    const closeAt = findOutsideInlineCode(out, "-->", start + 4, codeRanges);
    const end = closeAt === -1 ? out.length : closeAt + 3;
    out =
      out.slice(0, start) +
      blankKeepingNewlines(out.slice(start, end)) +
      out.slice(end);
    from = end;
  }
}

function maskQuotedMarkerRegionsLocal(content) {
  return maskHtmlComments(maskFencedBlocks(content));
}

function resolveHeaderTaskId(content) {
  const lines = maskQuotedMarkerRegionsLocal(
    (content ?? "").replace(/\r\n/g, "\n"),
  ).split("\n");
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_ID_LINE_RE);
    if (!m) continue;
    if (!hasStructuralPredecessor(lines, i)) continue;
    candidates.push(m[1]);
  }
  if (candidates.length !== 1) return { ok: false, count: candidates.length };
  return { ok: true, id: candidates[0] };
}

// resolveResultTaskId(relay-handshake.mjs)의 최소 재현 -- "정확히 하나의
// 구조적 선행 맥락이 있는 열머리 task_id: 값만 인정, 0개/2개 이상은
// 확정하지 않는다"는 동일 계약(위 resolveHeaderTaskId를 통해).
function resolveEchoedTaskId(resultContent) {
  return resolveHeaderTaskId(resultContent);
}

// HYK-468 3R §3: 이 파일의 판정 함수는 공개 export가 아니었다(2R 검토자가
// 그래서 메모리 전용 probe로 우회해야 했다 -- REVIEW-r27.md "정직 한계").
// 이 라운드는 "export하는 편이 낫다고 판단하면 그렇게 하고 사유를 적어라"
// (coder-task.md §3) 조건에 따라 테스트 전용으로 export한다 -- 이 파일이
// 이미 DONE_RE/FOR_LINE_RE_G 등을 같은 이유(시험이 정의 자체를 직접 재기
// 위해, 축마다 복사본을 만들면 조용히 어긋난다)로 export하는 관례와 같다.
// 원본 판정 로직은 한 글자도 바뀌지 않는다 -- `export` 키워드만 추가.
export { resolveHeaderTaskId as __probeResolveHeaderTaskId };

// HYK-469 3R §1: 위와 같은 이유(테스트 전용 export, 원본 로직 한 글자도
// 안 바뀜) -- 네 독자(정본·relay·dispatch·admission)가 같은 입력에 같은
// 판정을 내리는지 직접 비교하려면 이 로컬 복제 자체를 시험이 호출할 수
// 있어야 한다.
export { maskQuotedMarkerRegionsLocal as __probeMaskQuotedMarkerRegionsLocal };

// resolveResultBlockedState(relay-handshake.mjs)의 최소 재현 -- "정확히
// 하나의 well-formed '>>> BLOCKED:'/'>>> NEEDS_INPUT:' 줄만 인정"은 그대로
// 옮기되, 이 검증은 relay-handshake.mjs 자신의 전체 5-상태 판정(근접-미스
// 세분류 포함)을 재구현하지 않는다 -- 여기 필요한 질문은 "유효한 표지가
// 정확히 하나 있는가" 하나뿐이다(모호/근접-미스는 전부 "없음"으로 접어
// 거부한다 -- 안전측 기본값, relay-handshake.mjs보다 엄격하면 엄격했지
// 느슨하지 않다).
function hasWellFormedBlockedMarker(resultContent) {
  const matches = [...resultContent.matchAll(BLOCKED_RE)];
  return matches.length === 1;
}

// HYK-342 3R §0/§2 (신뢰 경계 교정: 결과 파일은 워커가 쓴다 -- "워커가
// 만들어 낼 수 없는 것"이 아니다): 검토자가 2R에서 재현한 우회로 -- 워커가
// 자기 결과 파일에 지어낸 task_id(`HYK-342-fake-result-1`)와 지어낸
// `>>> BLOCKED:` 표지를 함께 써 두면, 위 두 확인(task_id 에코 일치·
// 표지 존재)만으로는 그대로 통과했다. 그 둘 다 워커가 쓸 수 있는 파일
// 안에서만 확인하기 때문이다. 이 라운드는 세 번째 확인을 추가한다: 그
// task_id가 실제로 관제실 배달 영수증(dispatch-receipts.jsonl, 워커가
// 쓸 수 없는 파일)에 이 role로 실재하는가. dispatch-gate-decision.mjs의
// lookupDispatchId와 동일한 계약(role 대소문자 무관, harness_task_label
// 정확히 일치, 마지막 매치 채택, 손상된 줄 건너뜀)을 최소 재현한다
// (⛔새 조회 로직 발명 금지 -- 이 파일 헤더가 이미 설명한 "무겁게 참조되는
// 모듈을 끌어들이지 않기 위해 작은 것들은 복제한다" 원칙 그대로, dispatch-
// gate-decision.mjs는 abort-record-core/consumption-receipt-core/
// retirement-record-core/reject-streak 등을 정적 import하는 무거운
// 파일이라 그 파일 자체를 끌어들이면 이 파일의 격리 시험들이 다시 깨진다
// -- P1-1 때 relay-handshake.mjs를 정적 import했다가 실측으로 확인한 것과
// 동일한 위험).
//
// ★HYK-443 5R (검토 2R P1-ⓑ): 위 셋(role·label·영수증 실재)만으로는
// «좌석 혼동»이 남는다 -- 검토자 실측 재현(`other-seat-same-label`): 같은
// 라벨·같은 role로 «다른 좌석»에 배달된 영수증 한 줄만 있으면 이 함수가
// true를 돌려주어 그 좌석의 자리가 반납됐다(fail-open). 배달 영수증은
// 라벨당 한 줄이 아니다(dispatch-receipt-cli.mjs의 append-only 원장) --
// 재배달·다른 워크트리·라벨 재사용이면 같은 (role,label)로 여러 좌석 줄이
// 공존한다. 그래서 네 번째 조건을 건다: 그 줄의 `assignee_pane_key`가
// ★이 예약이 배정됐던 좌석의 pane key와 정확히 일치할 것.
//
// ⛔4R은 그 대조 상대를 «지금 이 프로세스의 `ORCA_PANE_KEY`»로 잡았고, 그것이
// 검토 2R이 P1으로 재현한 «가용성 회귀»였다: 좌석 «밖»에서 도는 프로세스
// (ORCH 터미널 -- 2026-09-05 HYK-437의 반납이 실제로 탄 경로)는 그 좌석의
// pane key를 갖지 않으므로 정당한 반납이 전부 거부되고 예약이 ACTIVE로 남아
// cap을 점유했다. 즉 4R의 축은 «증거»를 «호출자»에 묶었다 -- 호출자가 누구든
// 증거의 진위는 달라지지 않는데도.
//
// ⇒ 5R: 대조 상대를 «호출자»가 아니라 ★«반납 대상 예약 자신»으로 옮긴다.
// 원장(admission-ledger)의 각 예약은 배정 시점에 그 좌석을 스스로 기록한다
// (`reservations[<label>].seat_key` -- admitReservation의 `seat_key`, 관제실
// 배달측이 `admission-cli admit --seat-key`로 넣는 값이고 실측상 그 값은
// 정확히 pane key `${tabId}:${leafId}`다). 그래서 이 대조는
//   «이 라벨이 실제로 배달된 좌석»(영수증 줄의 assignee_pane_key)
//   == «이 예약이 배정된 좌석»(원장의 seat_key)
// 라는, 양쪽 다 ★배달측이 쓴 두 기록 사이의 대조가 된다.
//
// 왜 위조에 강한가: 두 값 중 어느 쪽도 워커가 쓰지 않는다 -- 영수증은
// dispatch 응답 봉투에서 뽑아 배달 순간에 append되고(dispatch-receipt-cli),
// seat_key는 배정 순간에 관제실이 원장에 적는다. 워커가 결과 파일에 무엇을
// 적든 이 두 기록은 바뀌지 않는다. 그리고 남의 좌석에 배달된 영수증 줄은
// 이 예약의 seat_key와 다르므로 `other-seat-same-label`은 계속 거부된다.
// 반대로 «누가 반납을 실행하는가»는 판정에서 완전히 빠졌으므로, 좌석 밖
// ORCH 프로세스가 남의 `.harness/`를 대상으로 도는 정당한 경로가 되살아난다.
//
// 왜 pane key라는 값인가(회전하지 않는 값 고르기): 좌석 handle(`term_…`)은
// 재접속마다 재발급된다 -- ⓐ벤더 규정 ⓑ워커 기동 규칙 §1("handle 비교는
// 쓰지 않는다") ⓒ2026-08-17 실측 재현. 그 근거로 HYK-294가 판정에서 handle
// 축을 빼고 pane key만 남겼다(scripts/relay/dispatch-bound-seat-proof.mjs
// 헤더). 영수증과 원장이 이미 «같은 그 값»을 각자 기록하고 있으므로, 새
// 신원 개념도 새 파일 형식도 발명하지 않는다.
//
// ⛔대조할 값이 없으면 «통과»가 아니라 «거부»다(fail-closed): 예약에
// seat_key가 없거나(구 cutover 시드 항목 -- 실측 724건 중 20건, 전부 옛
// 항목), 영수증 줄에 `assignee_pane_key`가 없으면 어느 좌석인지 확정할 수
// 없으므로 반납을 거부한다 -- "확인 못 함"은 "확인됨"이 아니다.
//
// 한 영수증 줄이 «이 예약의 좌석·이 라운드»인가 (ESLint complexity 상한
// 회피용 추출, 판정 문면은 그대로).
function receiptRecordMatchesThisSeatRound(
  rec,
  role,
  harnessTaskLabel,
  reservationSeatKey,
) {
  if (typeof rec.role !== "string") return false;
  if (rec.role.toUpperCase() !== role.toUpperCase()) return false;
  if (rec.harness_task_label !== harnessTaskLabel) return false;
  // HYK-443 5R: 좌석 신원 대조. 값이 없거나 다르면 이 줄은 «이 예약의
  // 배달»이 아니다 -- 라벨/role이 같아도 남의 좌석 영수증으로는 반납하지
  // 않는다(pane key는 대소문자 정규화 대상이 아니다: 벤더가 만든
  // uuid 쌍 문자열이라 사람이 섞어 쓰는 관용이 존재하지 않는다).
  if (!isNonEmptyString(rec.assignee_pane_key)) return false;
  return rec.assignee_pane_key === reservationSeatKey;
}

function hasDispatchReceiptForRound(
  role,
  harnessTaskLabel,
  receiptPath,
  reservationSeatKey,
) {
  if (
    !isNonEmptyString(receiptPath) ||
    !isNonEmptyString(harnessTaskLabel) ||
    !isNonEmptyString(reservationSeatKey)
  ) {
    return false;
  }
  let raw;
  try {
    raw = readFileSync(receiptPath, "utf8");
  } catch {
    return false;
  }
  let found = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      receiptRecordMatchesThisSeatRound(
        rec,
        role,
        harnessTaskLabel,
        reservationSeatKey,
      )
    ) {
      found = true;
    }
  }
  return found;
}

// resolveDispatchReceiptPath(dispatch-gate-decision.mjs)와 동일한 arg-
// with-env-fallback 관례(같은 env 이름, `DISPATCH_RECEIPT_PATH` --
// dispatch-receipt-cli.mjs가 이미 쓰는 바로 그 이름) -- 관제실 절대경로
// 하드코딩 금지.
//
// HYK-347 §1 경로 계약 (이 파일에서의 사용): 출처는 dispatch-gate-
// decision.mjs 위 주석과 동일(관제실이 자식 프로세스에 상속시키는 env,
// 이 저장소 어디도 기본값을 만들지 않는다). 미설정(및 `receiptPathArg`도
// 없음) 시 이 함수는 null을 돌려주고, 그 null은
// verifyBlockedTerminationEvidence -> hasDispatchReceiptForRound로 흘러가
// 즉시 `false`(증거 없음, 아래 hasDispatchReceiptForRound 헤더 참조)가
// 되어 BLOCKED_TERMINATION_RELEASED 완료 자체가 거부(fail-closed)된다 --
// "정말 배달 안 됨"과 "경로를 몰라서 확인 못 함"이 이 지점에서는 둘 다
// 거부라는 같은 결과로 이어지지만(§0 신뢰 경계: 워커가 위조할 수 있는
// 표식만으로 자리를 반납하지 않는다는 요구가 우선), reason 문자열은
// receiptPath 자체를 그대로 담아(§0 아래 verifyBlockedTerminationEvidence
// 참조) "(경로 미설정)"과 실제 경로 문자열을 구별해 남긴다 -- 판정
// 로직(거부 여부)은 바꾸지 않는다.
function resolveReceiptPathForVerification(receiptPathArg, env) {
  if (isNonEmptyString(receiptPathArg)) return receiptPathArg;
  if (isNonEmptyString(env?.DISPATCH_RECEIPT_PATH)) {
    return env.DISPATCH_RECEIPT_PATH;
  }
  return null;
}

// HYK-443 5R: «이 예약이 배정된 좌석»의 pane key. 출처는 반납 대상 원장
// 자신(`reservations[<label>].seat_key`)이고, 이 어댑터는 그 원장 경로를
// 이미 인자로 받고 있다 -- 새 env 축도, 새 파일도 만들지 않는다.
// ⛔읽기 전용이며 락을 잡지 않는다: 이 값은 배정 시점에 한 번 쓰이고 그
// 예약이 사는 동안 바뀌지 않는다(admitReservation은 ACTIVE 예약의
// 재-admit을 idempotent no-op으로 처리해 기존 레코드를 다시 쓰지 않는다).
// 실제 완료 전이는 그대로 withLedgerLock 안에서 일어난다.
// 읽을 수 없거나·JSON이 깨졌거나·해당 예약이 없거나·seat_key가 비어 있으면
// null -> hasDispatchReceiptForRound가 즉시 false(거부, fail-closed).
function resolveReservationSeatKey(ledgerPath, reservationId) {
  if (!isNonEmptyString(ledgerPath) || !isNonEmptyString(reservationId)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ledgerPath, "utf8"));
  } catch {
    return null;
  }
  const entry = parsed?.reservations?.[reservationId];
  if (!entry || !isNonEmptyString(entry.seat_key)) return null;
  return entry.seat_key;
}

// repoRoot/mainRepoRoot -- duplicated from relay-handshake.mjs's own
// (exported) versions rather than imported. This mirrors the repo-wide
// convention (every scripts/check/*.mjs file that needs this resolves it
// locally -- grep confirms ~30 independent copies) precisely because each
// of these files must stay independently copyable into an isolated
// fixture/target repo without dragging in an unrelated module's full
// import graph (relay-handshake.mjs alone pulls in reject-streak.mjs,
// envelope-archive.mjs, time-authority.mjs -- none of which this adapter
// needs).
// HYK-437 §2⑵ (mirrors HYK-428's identical fix in relay-handshake.mjs's own
// repoRoot/mainRepoRoot, coder-task.md §1 원문): `cwd` is optional/back-
// compat -- callers that omit it get the exact unchanged process.cwd()-
// derived behavior (e.g. this file's own module-load-time no-arg shape, and
// any caller that genuinely has no other directory to anchor to). Threading
// an explicit `cwd` (see mainRepoRoot below) is what lets the resolved path
// track the SAME directory isInsideGitWorktree(harnessDir) already
// validated (autoCompleteAdmission's gate above), instead of an unrelated,
// ambient process.cwd() -- see mainRepoRoot's own header for the exact gap
// this closes.
function repoRoot(cwd) {
  try {
    return execSync(
      "git rev-parse --show-toplevel",
      cwd ? { encoding: "utf8", cwd } : { encoding: "utf8" },
    ).trim();
  } catch {
    return cwd ?? process.cwd();
  }
}

// HYK-437 §2⑵: `startDir` is optional/back-compat (same reasoning as
// repoRoot above). Before this round, mainRepoRoot() ignored harnessDir
// entirely -- when this adapter runs as a spawned CHILD PROCESS (the
// documented design, see this file's own header on why relay-handshake.mjs
// spawns rather than imports), the child's cwd is whatever the PARENT
// process's cwd happened to be (execFileSync in relay-handshake.mjs's
// spawnAdmissionCompletionProcess never sets a `cwd` override) -- completely
// decoupled from harnessDir, the round directory actually being consumed.
// So resolvePersistentLedgerPaths() below could read (and
// completeAdmissionReservation could then mutate) a DIFFERENT worktree's
// pointer file/ledger than the one isInsideGitWorktree(harnessDir) just
// validated -- independently reproduced (coder.md §2⑴): two synthetic git
// repos A (spawn cwd) and B (harnessDir), each with its own pointer file and
// its own ledger admitting the SAME reservation id; spawning the adapter
// with cwd=A, harnessDir=B released A's reservation and left B's untouched.
// Passing `harnessDir` through to mainRepoRoot() below closes that gap by
// anchoring every git call in this resolution chain at harnessDir itself.
function mainRepoRoot(startDir) {
  const root = repoRoot(startDir);
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf8",
      cwd: root,
    }).trim();
    const absCommonDir = /^([A-Za-z]:[\\/]|\/)/.test(commonDir)
      ? commonDir
      : join(root, commonDir);
    return absCommonDir.replace(/[\\/]\.git$/, "");
  } catch {
    return root;
  }
}

// resolvePersistentLedgerPaths -- reads the installer-written pointer file
// (see install.mjs's installAdmissionLedgerPointer). Fail-open on every
// error shape (file absent, unreadable, malformed JSON, missing/blank
// `ledgerPath` field) -- treated identically to "nothing configured here",
// never a new failure mode layered on top of the pre-existing no-op.
//
// HYK-437 §2⑵/§2⑶: `startDir` (optional/back-compat, forwarded to
// mainRepoRoot above) anchors BOTH the pointer-file lookup below AND (since
// mainRepoRoot is the one shared resolution chain) the ledger path it names
// -- there is no separate "pointer axis" that resolves differently from the
// ledger axis in this file; they are the same call.
function resolvePersistentLedgerPaths(startDir) {
  const pointerPath = join(
    mainRepoRoot(startDir),
    ".harness",
    PERSISTENT_LEDGER_POINTER_FILENAME,
  );
  if (!existsSync(pointerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pointerPath, "utf8"));
    if (typeof parsed.ledgerPath !== "string" || !parsed.ledgerPath) {
      return null;
    }
    return {
      ledgerPath: parsed.ledgerPath,
      lockPath:
        typeof parsed.lockPath === "string" && parsed.lockPath
          ? parsed.lockPath
          : null,
    };
  } catch {
    return null;
  }
}

// HYK-224-3R §3 (REVIEW 2R 반려): 검토자 실측 -- 잘못된 ledger로 이 adapter가
// 실패해도 relay-handshake CLI는 exit 0, 부모 경고는 non-fatal, 게다가 사유
// 텍스트 자체가 비어 있었다("세부 오류가 비어 있었다"). 원인은 아래 두
// 실패 분기(ledger unreadable / store unavailable)가 `readResult.reasonCode`
// /`outcome.reasonCode`만 문자열에 넣고 그 옆의 `.detail`(실제 I/O 에러
// 메시지)을 버리고 있었던 것 -- reasonCode 하나만으로는 "무엇이" 잘못됐는지
// 사람이 알 수 없다. 아래 세 실패 분기 모두 이제 `detail`을 반드시 포함한다.
function reasonWithDetail(reasonCode, detail) {
  return `${reasonCode}${detail ? ` -- ${detail}` : " (no detail available)"}`;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// HYK-344 §1-3 항1/항2 -- distinguishes the three outcomes a completion
// rejection can now carry (RESERVATION_NOT_FOUND vs the new RESERVATION_
// KEY_MISMATCH from admission-ledger-core.mjs's completeReservation; the
// third, "ledger unreadable", is already a structurally different code path
// -- see `reasonWithDetail` above and the `outcome.ok`-false branch below,
// neither of which ever calls this function). Both the expected key
// (reservationId) and what was actually found in the ledger (candidates, or
// explicitly none) are always named -- never collapsed to a bare "failed".
function buildCompletionRejectionReason(reservationId, complete) {
  if (complete.reasonCode === "RESERVATION_KEY_MISMATCH") {
    const found = complete.candidates
      .map((c) => `${c.reservationId} (status=${c.status})`)
      .join(", ");
    return `admission-completion-adapter: completeReservation rejected (RESERVATION_KEY_MISMATCH) -- expected reservation key '${reservationId}' not found, but ${complete.candidates.length} OTHER active/suspect reservation(s) exist in this ledger snapshot: ${found} -- this looks like a key drift (e.g. GoLabel/Task mismatch), NOT "no reservation was ever made"`;
  }
  return `admission-completion-adapter: completeReservation rejected (${complete.reasonCode}) for '${reservationId}' -- the reservation could not be transitioned to COMPLETED in the current ledger snapshot (no other active/suspect reservation exists in this ledger snapshot either -- no reservation was ever admitted under any key visible here)`;
}

// HYK-342 2R P1-1 -- the closed set of `reason` values this adapter will
// ever act on. 검토자 원문: "completeReservation은 비어 있지 않은 임의
// 문자열을 completion_reason으로 기록한다" -- 어댑터가 그 임의성을
// 그대로 통과시키던 것이 결함의 절반이었다. `undefined`(정상 완료, 기존
// ok:true 경로)는 이 집합 밖에서 별도로 허용된다(아래 completeAdmission
// Reservation 참조) -- 이 집합은 "완료 사유를 명시하는" 값만 닫는다.
const KNOWN_COMPLETION_REASONS = new Set([
  COMPLETION_REASON.BLOCKED_TERMINATION_RELEASED,
  COMPLETION_REASON.RETIREMENT_RELEASED,
]);

// HYK-342 2R P1-1 / 3R §0/§2 -- «회수 표식의 생산자 권한» 검증. 검토자가
// 재현한 공격(중단 핸드셰이크를 거치지 않고 이 어댑터를 직접 실행해
// completion_reason=BLOCKED_TERMINATION_RELEASED를 찍는 것)을 막는다.
//
// ⚠️3R §0 신뢰 경계 교정: 2R은 "harnessDir/role이 가리키는 결과 파일의
// task_id 에코 + BLOCKED 표지"를 «호출자가 만들어 낼 수 없는 것»으로
// 잘못 취급했다 -- 결과 파일은 워커가 쓰는 파일이므로 워커가 지어낸
// task_id + 지어낸 표지를 직접 써 두면 그 둘만으로는 여전히 통과했다
// (검토자 2R §1 항1 실측). 워커가 쓸 수 없는 곳은 관제실 배달 영수증
// (dispatch-receipts.jsonl)뿐이다(§0). 그래서 이 함수는 이제 **셋**을
// 확인한다 -- (a) 결과 파일이 실제로 존재하고 (b) 그 결과 파일의 task_id
// 에코가 정확히 이 reservationId와 일치하고(HYK-183 anti-forgery) (c) 그
// 결과 파일이 정확히 BLOCKED/NEEDS_INPUT 상태이며 **(d, 신규) 그
// reservationId가 실제로 dispatch-receipts.jsonl에 이 role로 배달된 적이
// 있다**(hasDispatchReceiptForRound, 워커가 못 쓰는 파일). 넷 중
// 하나라도 아니면 거부(fail-closed) -- 표식 문자열 자체나 비밀값에
// 기대지 않는다(⛔검토자가 금지한 그 경로).
//
// ★남는 표면(3R §2 "닫으려 하지 마라"): 워커가 «자기 실제(진짜 배달된)
// 라벨»로 가짜 정지 표지를 쓰는 경우는 이 확인으로 막히지 않는다 --
// BLOCKED 선언 자체는 이 하네스가 정상 신호로 받아들이기로 설계한
// 것이므로, 이 검증이 닫는 것은 "배달된 적 없는 라운드로 표식을 만드는
// 것"뿐이다(coder.md 정직 한계 절에도 명시).
function verifyBlockedTerminationEvidence({
  harnessDir,
  role,
  reservationId,
  receiptPath,
  reservationSeatKey,
}) {
  if (!isNonEmptyString(harnessDir) || !isNonEmptyString(role)) {
    return {
      ok: false,
      reason: `admission-completion-adapter: BLOCKED_TERMINATION_RELEASED 요청에 harnessDir/role이 없음 -- 증거를 확인할 대상 자체를 특정할 수 없음, 거부(안전측 기본값)`,
    };
  }
  // resolveLiveRoundFilePaths(relay-handshake.mjs)와 동일한 파일명 관례
  // (role을 소문자화해 `<role>.md`) -- Windows는 대소문자를 구별하지
  // 않지만 Linux(CI)는 구별하므로 그대로 맞춘다.
  const resultPath = join(harnessDir, `${String(role).toLowerCase()}.md`);
  let resultContent;
  try {
    resultContent = readFileSync(resultPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `admission-completion-adapter: BLOCKED_TERMINATION_RELEASED 증거 확인 실패 -- 결과 파일을 읽을 수 없음('${resultPath}': ${err.message}), 거부(안전측 기본값)`,
    };
  }
  const taskIdResolved = resolveEchoedTaskId(resultContent);
  if (!taskIdResolved.ok || taskIdResolved.id !== reservationId) {
    return {
      ok: false,
      reason: `admission-completion-adapter: BLOCKED_TERMINATION_RELEASED 증거 확인 실패 -- 결과 파일('${resultPath}')의 task_id 에코가 reservationId('${reservationId}')와 일치하지 않거나 확정되지 않음(${taskIdResolved.ok ? `실제: ${taskIdResolved.id}` : `task_id 줄 ${taskIdResolved.count}개`}), 거부(안전측 기본값)`,
    };
  }
  if (!hasWellFormedBlockedMarker(resultContent)) {
    return {
      ok: false,
      reason: `admission-completion-adapter: BLOCKED_TERMINATION_RELEASED 증거 확인 실패 -- 결과 파일('${resultPath}')에 유효한 '>>> BLOCKED:'/'>>> NEEDS_INPUT:' 표지가 정확히 하나 있지 않음, 거부(안전측 기본값)`,
    };
  }
  if (
    !hasDispatchReceiptForRound(
      role,
      reservationId,
      receiptPath,
      reservationSeatKey,
    )
  ) {
    return {
      ok: false,
      reason: `admission-completion-adapter: BLOCKED_TERMINATION_RELEASED 증거 확인 실패 -- reservationId('${reservationId}')가 role='${role}'로 ★이 예약이 배정된 좌석(pane key=${reservationSeatKey ?? "(원장에 seat_key 없음)"})에 실제 배달된 기록이 dispatch-receipts.jsonl(${receiptPath ?? "(경로 미설정)"})에 없음 -- 워커가 지어낸 이름표 또는 «다른 좌석의 영수증»으로 의심, 거부(안전측 기본값, HYK-342 3R §2 / HYK-443 5R 예약-좌석 대조)`,
    };
  }
  return { ok: true };
}

// HYK-398 §2-⑶: RETIREMENT_RELEASED 증거 확인. resultPath 재읽기는
// verifyBlockedTerminationEvidence와 같은 사유(독립 재검증, 호출자를
// 신뢰하지 않음)로 여기서도 다시 한다 -- reservationId를 그대로 믿지
// 않고, harnessDir/role이 가리키는 실제 파일들에서 다시 유도한다.
//
// dispatch-gate-decision.mjs의 evaluateRetirementDecision와 «같은 계약»
// (같은 다섯 관문 -- role+harnessTaskLabel 일치·아카이브 존재·지문 대조
// (아카이브+live 둘 다)·사유 코드 유효성/기계 재확인·후속 이름표)을
// checkRetirementRecord(코어, 정적 import)에 위임해 재현한다. 이 파일이
// 스스로 하는 일은 오직 "그 코어가 요구하는 사실들을 harnessDir 아래
// 실제 파일에서 다시 읽어 구조화하는 것"뿐이다(§2 zero-import 코어
// 계약과 동일한 분업, 위 import 헤더 참조).
const RETIREMENT_DROPPED_AT_RE = /^dropped_at:\s*(.+)$/im;
const RETIREMENT_ARCHIVE_ENVELOPE_HEADER_RE =
  /^<!-- envelope-archive: role=\S+ archived_at=.*? -->\n/;

// computeResultFingerprint(relay-handshake.mjs)/computeConsumptionResultFingerprint
// (dispatch-gate-decision.mjs)와 바이트 동일(sha256 hex of utf8 text) --
// 이 파일 헤더가 이미 설명한 "작은 것은 복제한다" 원칙 그대로.
function computeRetirementFingerprint(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function stripRetirementArchiveEnvelopeHeader(content) {
  const match = content.match(RETIREMENT_ARCHIVE_ENVELOPE_HEADER_RE);
  return match ? content.slice(match[0].length) : content;
}

// dispatch-gate-decision.mjs의 readRetirementRecordFiles와 동일한 계약:
// 디렉터리 부재 -> []. 손상/파싱 실패한 개별 파일은 건너뛴다(치명적이지
// 않음, 코어가 후보 필터링을 맡는다).
function readRetirementRecordFilesForAdapter(harnessDir, role) {
  const retirementsDir = join(harnessDir, "retirements");
  let names;
  try {
    names = readdirSync(retirementsDir);
  } catch {
    return [];
  }
  const pattern = new RegExp(`^${role}-retire-r\\d+\\.json$`, "i");
  const records = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    try {
      records.push(
        JSON.parse(readFileSync(join(retirementsDir, name), "utf8")),
      );
    } catch {
      continue;
    }
  }
  return records;
}

// dispatch-gate-decision.mjs의 resolveRetirementArchiveCandidate와 동일한
// 계약: `.harness/rounds/<role>-r<N>.md` 중 봉투 헤더를 벗긴 뒤 자신의
// task_id 에코가 harnessTaskLabel과 일치하는 사본을 찾는다(record.archivePath
// 를 그대로 믿지 않는다 -- 내용으로 찾는다). 정확히 하나면 그 지문을
// claimedFingerprint와 대조, 0개면 ARCHIVE_MISSING으로 이어지는
// exists:false, 2개 이상이면 안전측 기본값(exists:true, fingerprintMatches:false).
function resolveRetirementArchiveCandidateForAdapter(
  harnessDir,
  role,
  harnessTaskLabel,
  claimedFingerprint,
) {
  const roundsDir = join(harnessDir, "rounds");
  let names;
  try {
    names = readdirSync(roundsDir);
  } catch {
    return { exists: false, fingerprintMatches: false };
  }
  const pattern = new RegExp(`^${role}-r\\d+\\.md$`, "i");
  const matches = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    let raw;
    try {
      raw = readFileSync(join(roundsDir, name), "utf8");
    } catch {
      continue;
    }
    const stripped = stripRetirementArchiveEnvelopeHeader(raw);
    const idResolved = resolveHeaderTaskId(stripped);
    if (!idResolved.ok || idResolved.id !== harnessTaskLabel) {
      continue;
    }
    matches.push({
      fingerprint: computeRetirementFingerprint(stripped),
      // HYK-461 §4-A: compute the SAME envelopeBindingValid the canonical gate
      // computes (resolveEnvelopeBindingValidity from the producer module) so
      // the core's ARCHIVE_ENVELOPE_BINDING_INVALID guard fires on this
      // consumer too -- previously never populated here (HYK-456 §5-1).
      envelopeBindingValid: resolveEnvelopeBindingValidity(raw, stripped),
    });
  }
  if (matches.length === 0) {
    return { exists: false, fingerprintMatches: false };
  }
  if (matches.length > 1) {
    // 라벨이 일치하는 사본이 2개 이상 -- 어느 것을 대조할지 조용히 고르지
    // 않는다. envelopeBindingValid는 채우지 않으므로 undefined가 되고,
    // 코어의 `=== false` 비교에 걸리지 않는다(정본 resolveRetirementArchiveCandidate의
    // ambiguousCount 분기와 동일 계약) -- 이미 fingerprintMatches:false로
    // FINGERPRINT_MISMATCH에 떨어진다.
    return { exists: true, fingerprintMatches: false };
  }
  return {
    exists: true,
    fingerprintMatches: matches[0].fingerprint === claimedFingerprint,
    envelopeBindingValid: matches[0].envelopeBindingValid,
  };
}

// HYK-461 2R §2-B: 대체 증거 승격이 실패한 «구별되는» 사유(검토 P1-2:
// 넷을 하나의 일반 사유로 뭉개지 마라). verifyRetirementEvidence가 이
// 코드를 그대로 사람이 읽는 사유 문자열에 실어 시험이 사유별로 고정할 수
// 있게 한다.
const ARCHIVE_SUBSTITUTE_REASON = Object.freeze({
  // 이름표가 reservationId와 일치하는 보존 사본이 아예 없음(사본 자체가
  // 없거나 이름표가 다름) -- 표 ⓒ.
  LABEL_MISMATCH: "ARCHIVE_SUBSTITUTE_LABEL_MISMATCH",
  // 이름표는 일치하는데 봉투 결속이 false(kind=unconsumed_result인데
  // content_sha256이 몸통과 불일치/부재) -- 손 사본 의심, 표 ⓐ.
  BINDING_INVALID: "ARCHIVE_SUBSTITUTE_BINDING_INVALID",
  // 이름표는 일치하는데 결속 헤더 자체가 부재(null -- 봉투 헤더 없음 또는
  // kind!=unconsumed_result인 구형 사본) -- 표 ⓑ.
  BINDING_ABSENT: "ARCHIVE_SUBSTITUTE_BINDING_ABSENT",
  // 결속이 유효한(true) 이름표 일치 사본이 «2개 이상» -- 어느 것을 증거로
  // 쓸지 조용히 고르지 않는다, 표 ⓓ.
  AMBIGUOUS: "ARCHIVE_SUBSTITUTE_AMBIGUOUS",
});

// HYK-461 §4-B / 2R §2-B: live `<role>.md`가 다음 라운드로 덮여 task_id
// 에코가 어긋난 경우의 «대체 증거 원문» 선택. rounds/<role>-r<N>.md 중
// (봉투 헤더를 벗긴) 본문의 task_id 에코가 정확히 reservationId와 일치하는
// 사본들을 모으고, 그 중 봉투 결속이 유효한(resolveEnvelopeBindingValidity
// === true) 것이 «정확히 하나»일 때만 그 stripped 본문을 대체 증거로
// 승격한다. 그 외에는 ★왜 실패했는지를 «구별되는» reasonCode로 돌려준다
// (검토 P1-2). 반환:
//   { ok: true, evidenceText }
//   { ok: false, reasonCode, detail }
//
// ⛔이 함수 자체가 이미 «위조 면»을 지킨다(범위 3): 결속이 어긋난 사본
// (false)·결속을 선언하지 않은 사본(null)·이름표가 다른 사본은 대체
// 증거로 승격되지 않고, 결속 유효 사본이 여럿이면 조용히 하나를 고르지
// 않고 거부한다(안전측). live 축을 «없애는» 것이 아니라 결속이 검증된
// 보존 사본을 «더하는» 것이다(§4-B).
function resolveArchivedRetirementEvidenceText(
  harnessDir,
  role,
  harnessTaskLabel,
) {
  const roundsDir = join(harnessDir, "rounds");
  let names;
  try {
    names = readdirSync(roundsDir);
  } catch {
    return { ok: false, reasonCode: ARCHIVE_SUBSTITUTE_REASON.LABEL_MISMATCH };
  }
  const pattern = new RegExp(`^${role}-r\\d+\\.md$`, "i");
  // 이름표가 일치하는 사본만 모은다(각각의 결속 상태 true/false/null 보존).
  const labelMatched = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    let raw;
    try {
      raw = readFileSync(join(roundsDir, name), "utf8");
    } catch {
      continue;
    }
    const stripped = stripRetirementArchiveEnvelopeHeader(raw);
    const idResolved = resolveHeaderTaskId(stripped);
    if (!idResolved.ok || idResolved.id !== harnessTaskLabel) {
      continue;
    }
    labelMatched.push({
      stripped,
      binding: resolveEnvelopeBindingValidity(raw, stripped),
    });
  }
  const valid = labelMatched.filter((c) => c.binding === true);
  if (valid.length === 1) return { ok: true, evidenceText: valid[0].stripped };
  if (valid.length >= 2) {
    return {
      ok: false,
      reasonCode: ARCHIVE_SUBSTITUTE_REASON.AMBIGUOUS,
      detail: `결속 유효 사본 ${valid.length}개`,
    };
  }
  // valid.length === 0: 이름표 일치 사본이 아예 없거나(=사본 없음/이름표
  // 다름), 있어도 전부 결속 false/부재. false를 부재보다 «더 의심»으로 본다
  // (손 사본은 헤더를 흉내 냈으나 sha가 어긋나는 쪽이 더 적극적 위조 시도).
  if (labelMatched.length === 0) {
    return { ok: false, reasonCode: ARCHIVE_SUBSTITUTE_REASON.LABEL_MISMATCH };
  }
  if (labelMatched.some((c) => c.binding === false)) {
    return { ok: false, reasonCode: ARCHIVE_SUBSTITUTE_REASON.BINDING_INVALID };
  }
  return { ok: false, reasonCode: ARCHIVE_SUBSTITUTE_REASON.BINDING_ABSENT };
}

// HYK-457: parseRetirementKstToMs and confirmRetirementBlockReasonForAdapter
// used to live here as this file's own copy of dispatch-gate-decision.mjs's
// confirmRetirementBlockReason contract -- HYK-455 added a third
// mechanically-confirmable reason (RUNNER_GREEN_UNREACHABLE_AT_HEAD) to the
// dispatch-gate-decision.mjs copy only, leaving this copy fail-closed for
// every retirement using that reason (2026-09-08 ORCH-63 isolated
// measurement; §2 of coder-task.md). Both copies are now
// retirement-block-reason-shared.mjs (see that file's header for the merge
// rationale and why it stays import-light like ledger-pointer-shared.mjs,
// and this file's own top import block for the actual import statement).

// verifyRetirementEvidence -- RETIREMENT_RELEASED의 진입점. reservationId를
// harnessTaskLabel로 삼아 harnessDir 아래 실제 파일에서 독립적으로 다시
// 사실을 유도하고, checkRetirementRecord(코어)에 그대로 넘긴다. RETIRED가
// 아니면 어떤 상태든(NO_RECORD/AMBIGUOUS/ARCHIVE_MISSING/FINGERPRINT_
// MISMATCH/INVALID_REASON_CODE/BLOCK_REASON_UNCONFIRMED/SUCCESSOR_LABEL_
// MISSING) 거부(fail-closed) -- verdict.reason을 그대로 실어 사람이 읽을
// 수 있게 한다(§4 완료조건 2 "증거가 하나라도 빠지면 거부" 요구 그대로).
// HYK-461 §4-B: 채택 증거 원문 결정(verifyRetirementEvidence의 max-lines-
// per-function 상한 회피용 추출, 판정/문면은 그대로). live 축은 그대로
// 우선한다 -- live `<role>.md`의 task_id 에코가 reservationId와 맞으면 그
// 원문을 증거로 쓴다. 다음 라운드가 그 파일을 덮어(1-3/HYK-346 실물)
// 에코가 어긋나면, ★결속이 유효한 보존 사본(envelopeBindingValid===true,
// 이름표 일치, 유일)이 있을 때만 그 사본 자신의 stripped 본문을 «대체
// 증거»로 승격한다. 대체 증거가 없으면(사본 없음·결속 무효·이름표 다름·
// 모호) 거부한다(위조 면 보존, §4-B/범위3). 통과면 {ok:true, evidenceText},
// 실패면 verifyRetirementEvidence가 즉시 돌려줄 {ok:false, reason}.
function resolveRetirementEvidenceText({
  liveContent,
  resultPath,
  harnessDir,
  roleUpper,
  reservationId,
}) {
  const liveTaskId = resolveEchoedTaskId(liveContent);
  if (liveTaskId.ok && liveTaskId.id === reservationId) {
    // HYK-461 2R §2-A: live 축은 «독립» 경로다 -- live task_id 에코가
    // reservationId와 일치하면 보존 사본의 결속 상태와 무관하게 live 본문을
    // 증거로 쓴다(source:"live"). 결속 검사는 대체 증거 경로에서만
    // 적용된다(verifyRetirementEvidence의 candidate 빌드 참조).
    return { ok: true, evidenceText: liveContent, source: "live" };
  }
  const archived = resolveArchivedRetirementEvidenceText(
    harnessDir,
    roleUpper,
    reservationId,
  );
  if (!archived.ok) {
    const liveDetail = liveTaskId.ok
      ? `실제: ${liveTaskId.id}`
      : `task_id 줄 ${liveTaskId.count}개`;
    return {
      ok: false,
      // HYK-461 2R §2-B: 구별되는 reasonCode를 그대로 실어 시험이 사유별로
      // 고정할 수 있게 한다(검토 P1-2: 넷을 하나로 뭉개지 마라).
      reason: `admission-completion-adapter: RETIREMENT_RELEASED 증거 확인 실패 [${archived.reasonCode}${archived.detail ? `: ${archived.detail}` : ""}] -- 결과 파일('${resultPath}')의 task_id 에코가 reservationId('${reservationId}')와 일치하지 않거나 확정되지 않고(${liveDetail}), 이를 대체할 «결속이 유효한·이름표 일치·유일한 보존 사본»(rounds/${roleUpper}-r<N>.md)도 확정할 수 없음, 거부(안전측 기본값, HYK-461 §4-B)`,
    };
  }
  return { ok: true, evidenceText: archived.evidenceText, source: "archive" };
}

// verifyRetirementEvidence의 quality-check max-lines-per-function 상한
// 회피용 추출(HYK-398 §2-⑶/HYK-244 2R-b3 선례와 동일한 이유, 판정/문면은
// 조금도 바뀌지 않는다) -- 후보별 다섯 사실(아카이브 존재·결속·지문 대조
// 둘·기계 재확인)을 조립하는 몸통만 뽑는다. HYK-461 §4-B: 지문·사유
// 재확인은 모두 «채택된 증거 원문»(evidenceText) 기준으로 유도한다. 대체
// 증거 경로에서는 evidenceText가 보존 사본의 stripped 본문이므로,
// evidenceFingerprint는 곧 그 사본의 content_sha256(=record.
// archiveFingerprintClaimed)과 같아지고, blockReason 재확인도 그 사본이
// 주장하는 head_commit(덮인 live가 아니라)에 대해 이뤄진다.
// HYK-478: ledgerPath는 그대로 confirmRetirementBlockReason에 전달된다 --
// AUTHOR_SEAT_LOST_BEFORE_STAMP 재확인에만 쓰인다(그 함수 헤더 참조).
function buildRetirementCandidatesForAdapter(
  records,
  {
    harnessDir,
    roleUpper,
    reservationId,
    evidenceText,
    fromArchive,
    droppedAtRaw,
    ledgerPath,
  },
) {
  const evidenceFingerprint = computeRetirementFingerprint(evidenceText);
  return records.map((record) => {
    const archiveInfo = resolveRetirementArchiveCandidateForAdapter(
      harnessDir,
      roleUpper,
      reservationId,
      record?.archiveFingerprintClaimed,
    );
    return {
      record,
      archiveExists: archiveInfo.exists,
      // HYK-461 §4-A + 2R §2-A: 결속 검사는 «대체 증거 경로»에서만 적용한다.
      // archive 소스면 정본과 동일하게 실제 값을 넘겨 코어의
      // ARCHIVE_ENVELOPE_BINDING_INVALID 방어가 살아 있게 하고, live 소스면
      // null을 넘겨(코어의 `=== false` 비교에 걸리지 않음) live 축이 사본
      // 결속에 종속되지 않게 한다(검토 P1-1).
      envelopeBindingValid: fromArchive
        ? archiveInfo.envelopeBindingValid
        : null,
      archiveFingerprintMatches: archiveInfo.fingerprintMatches,
      liveFingerprintMatches:
        evidenceFingerprint === record?.archiveFingerprintClaimed,
      blockReasonConfirmed: confirmRetirementBlockReason(
        record,
        evidenceText,
        droppedAtRaw,
        harnessDir,
        ledgerPath,
      ),
    };
  });
}

function verifyRetirementEvidence({
  harnessDir,
  role,
  reservationId,
  ledgerPath,
}) {
  if (!isNonEmptyString(harnessDir) || !isNonEmptyString(role)) {
    return {
      ok: false,
      reason: `admission-completion-adapter: RETIREMENT_RELEASED 요청에 harnessDir/role이 없음 -- 증거를 확인할 대상 자체를 특정할 수 없음, 거부(안전측 기본값)`,
    };
  }
  const resultPath = join(harnessDir, `${String(role).toLowerCase()}.md`);
  const roleUpper = String(role).toUpperCase();
  let liveContent;
  try {
    liveContent = readFileSync(resultPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `admission-completion-adapter: RETIREMENT_RELEASED 증거 확인 실패 -- 결과 파일을 읽을 수 없음('${resultPath}': ${err.message}), 거부(안전측 기본값)`,
    };
  }
  // HYK-461 §4-B: 채택할 증거 원문을 정한다(live 우선, 없으면 결속 유효
  // 보존 사본으로 대체) -- 아래 헬퍼 참조.
  const evidence = resolveRetirementEvidenceText({
    liveContent,
    resultPath,
    harnessDir,
    roleUpper,
    reservationId,
  });
  if (!evidence.ok) return evidence;
  const evidenceText = evidence.evidenceText;
  // HYK-461 2R §2-A (검토 P1-1): the envelope-binding self-consistency check
  // gates the ARCHIVE SUBSTITUTE path ONLY. When live is the evidence source,
  // the live file's own fingerprint is independently checked below
  // (liveFingerprintMatches), so a sibling preserved copy's broken
  // self-binding must NOT block an otherwise-valid live retirement -- 1R made
  // it a mandatory axis that could reject a valid live retirement, which
  // violated §2-A ("live 에코가 맞으면 보존 사본 상태와 무관하게 성립"). The
  // check is NOT removed -- resolveArchivedRetirementEvidenceText already
  // enforced envelopeBindingValid===true to even PROMOTE a copy to substitute
  // evidence (forgery defense intact); here we merely stop re-imposing it on
  // the live path.
  const fromArchive = evidence.source === "archive";
  const taskPath = join(harnessDir, `${String(role).toLowerCase()}-task.md`);
  // HYK-478: 초기값 없이 선언한다 -- try/catch 두 갈래가 모두 무조건
  // 재할당하므로(성공하면 파싱값, 실패하면 null) 선언 시점의 `= null`은
  // 도달 전에 항상 덮여써져 죽은 대입이었다(이 추출이 클로저 밖으로
  // 꺼내면서 eslint의 흐름 분석이 그 사실을 새로 증명해냈다 -- no-useless-
  // assignment, 동작은 바이트 하나 안 바뀐다).
  let droppedAtRaw;
  try {
    const taskContent = readFileSync(taskPath, "utf8");
    const droppedMatch = taskContent.match(RETIREMENT_DROPPED_AT_RE);
    droppedAtRaw = droppedMatch ? droppedMatch[1].trim() : null;
  } catch {
    droppedAtRaw = null;
  }
  const records = readRetirementRecordFilesForAdapter(harnessDir, roleUpper);
  const candidates = buildRetirementCandidatesForAdapter(records, {
    harnessDir,
    roleUpper,
    reservationId,
    evidenceText,
    fromArchive,
    droppedAtRaw,
    ledgerPath,
  });
  const verdict = checkRetirementRecord({
    role: roleUpper,
    harnessTaskLabel: reservationId,
    candidates,
  });
  if (verdict.state !== RETIREMENT_RECORD_STATE.RETIRED) {
    return {
      ok: false,
      reason: `admission-completion-adapter: RETIREMENT_RELEASED 증거 확인 실패 -- ${verdict.reason}`,
    };
  }
  return { ok: true };
}

// HYK-342/HYK-249: `reason` is a NEW, optional field threaded straight
// through to completeReservation's own `args.reason` (admission-ledger-
// core.mjs) -- see that function's header for the stamping contract. Every
// pre-existing caller (the ok:true completion path) omits it, so this
// function's behavior for them is byte-identical to before this round.
//
// HYK-398 §2-⑶: quality-check max-lines-per-function 상한을 지키려고
// completeAdmissionReservation 몸통에서 뽑았다(HYK-244-receipt-core-1b
// 선례와 동일한 이유, 판정/사유 문구는 조금도 바뀌지 않는다) -- reason별
// evidence 확인 두 갈래(BLOCKED_TERMINATION_RELEASED/RETIREMENT_RELEASED)
// 를 하나로 묶는다. 통과(evidence 불필요 포함)면 null, 실패면 그
// completeAdmissionReservation이 즉시 돌려줄 {ok:false, reasonCode, reason}.
function checkCompletionReasonEvidence({
  reason,
  harnessDir,
  role,
  reservationId,
  receiptPath,
  ledgerPath,
}) {
  if (reason === COMPLETION_REASON.BLOCKED_TERMINATION_RELEASED) {
    const evidence = verifyBlockedTerminationEvidence({
      harnessDir,
      role,
      reservationId,
      receiptPath: resolveReceiptPathForVerification(receiptPath, process.env),
      // HYK-443 5R: 좌석 신원은 «반납 대상 예약 자신»에서 읽는다(호출자의
      // env가 아니라) -- 이 값이 없으면 verifyBlockedTerminationEvidence가
      // 거부한다(fail-closed).
      reservationSeatKey: resolveReservationSeatKey(ledgerPath, reservationId),
    });
    if (!evidence.ok) {
      return {
        ok: false,
        reasonCode: "BLOCKED_TERMINATION_EVIDENCE_MISSING",
        reason: `${evidence.reason} -- reservation '${reservationId}' NOT released`,
      };
    }
  }
  // HYK-398 §2-⑶: RETIREMENT_RELEASED도 같은 fail-closed 원칙 -- evidence
  // 확인이 완료 호출(completeReservation) 자체보다 먼저 실행되고, 실패하면
  // 완료는 아예 시도되지 않는다(이 축이 새로 만드는 유일한 완료 통로).
  if (reason === COMPLETION_REASON.RETIREMENT_RELEASED) {
    const evidence = verifyRetirementEvidence({
      harnessDir,
      role,
      reservationId,
      // HYK-478: AUTHOR_SEAT_LOST_BEFORE_STAMP 재확인에 필요한 admission
      // 원장 경로 -- 이 함수는 이미 그 경로를 인자로 받고 있다(위
      // completeAdmissionReservation 호출부 참조), 새 인자를 만들지 않는다.
      ledgerPath,
    });
    if (!evidence.ok) {
      return {
        ok: false,
        reasonCode: "RETIREMENT_EVIDENCE_MISSING",
        reason: `${evidence.reason} -- reservation '${reservationId}' NOT released`,
      };
    }
  }
  return null;
}

// HYK-342 2R P1-1: `reason` is no longer trusted at face value -- a non-
// empty value MUST be one of KNOWN_COMPLETION_REASONS (closed set), and
// BLOCKED_TERMINATION_RELEASED specifically requires `harnessDir`/`role`
// and passes verifyBlockedTerminationEvidence BEFORE completeReservation is
// ever called -- a failed verification means NO completion happens at all
// (fail-closed: this release path either has real corroborating evidence,
// or it does not run).
export function completeAdmissionReservation({
  reservationId,
  ledgerPath,
  lockPath,
  now = new Date().toISOString(),
  reason,
  harnessDir,
  role,
  receiptPath,
}) {
  if (reason !== undefined && !KNOWN_COMPLETION_REASONS.has(reason)) {
    return {
      ok: false,
      reasonCode: "UNKNOWN_COMPLETION_REASON",
      reason: `admission-completion-adapter: 알 수 없는 completion reason('${reason}') -- 닫힌 집합(${[...KNOWN_COMPLETION_REASONS].join(", ")}) 밖의 값은 거부(안전측 기본값, HYK-342 2R P1-1) -- reservation '${reservationId}' NOT released`,
    };
  }
  const evidenceFailure = checkCompletionReasonEvidence({
    reason,
    harnessDir,
    role,
    reservationId,
    receiptPath,
    ledgerPath,
  });
  if (evidenceFailure) return evidenceFailure;
  const outcome = withLedgerLock(ledgerPath, lockPath, (readResult) => {
    if (!readResult.ok) {
      return {
        result: {
          ok: false,
          reasonCode: readResult.reasonCode,
          reason: `admission-completion-adapter: ledger unreadable (${reasonWithDetail(readResult.reasonCode, readResult.detail)}) -- reservation '${reservationId}' NOT released`,
        },
      };
    }
    const complete = completeReservation(readResult.ledger, {
      reservationId,
      now,
      reason,
    });
    if (!complete.ok) {
      return {
        result: {
          ok: false,
          reasonCode: complete.reasonCode,
          reason: buildCompletionRejectionReason(reservationId, complete),
          // HYK-344 §1-3 항1: surfaced as its own field (not just folded
          // into the `reason` string) so an automated caller/monitoring
          // script can act on it without parsing prose -- the durable audit
          // record below (appendCompletionFailureAudit) also carries this.
          candidates: complete.candidates ?? [],
        },
      };
    }
    return {
      result: {
        ok: true,
        reason: `admission-completion-adapter: reservation '${reservationId}' released (changed=${complete.changed})`,
      },
      nextLedger: complete.changed ? complete.ledger : null,
    };
  });
  if (!outcome.ok) {
    return {
      ok: false,
      reasonCode: outcome.reasonCode,
      reason: `admission-completion-adapter: store unavailable (${reasonWithDetail(outcome.reasonCode, outcome.detail)}) -- reservation '${reservationId}' NOT released`,
    };
  }
  return outcome.result;
}

// appendCompletionFailureAudit -- HYK-224-3R §3's "최소 감사 기록" 요구:
// a failure that only ever reached the screen (console.error) is lost the
// moment the terminal scrolls or the process's stdout isn't captured
// anywhere -- "화면에만 = 도달로 안 침" (coder-task §3). This durably
// appends one JSON line per failure to a file co-located with the ledger
// (`${ledgerPath}.completion-failures.jsonl` -- no new env var, no new
// "얇은 껍데기" surface: derivable from the one path the caller already
// gave us). Best-effort: a failure to even WRITE the audit record is itself
// logged to stderr (never silently swallowed) but never thrown past this
// function's boundary -- an audit-logging failure must not cascade into a
// second, different kind of silent failure.
function appendCompletionFailureAudit({
  ledgerPath,
  reservationId,
  reasonCode,
  reason,
  candidates,
  now,
}) {
  const auditPath = `${ledgerPath}.completion-failures.jsonl`;
  const record = {
    at: now,
    reservationId,
    reasonCode: reasonCode ?? "UNKNOWN",
    reason,
    // HYK-344 §1-3 항1/항3: durable, machine-parseable record of "what was
    // actually found" alongside "what was expected" (reservationId above) --
    // present (possibly empty array) only when the failure came from
    // completeAdmissionReservation's RESERVATION_NOT_FOUND/RESERVATION_KEY_
    // MISMATCH branch; absent for other failure shapes (e.g. ledger
    // unreadable) where it would not mean anything.
    ...(candidates !== undefined ? { candidates } : {}),
  };
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    console.error(
      `admission-completion-adapter: FAILED TO WRITE AUDIT RECORD (${auditPath}): ${err.message} -- original failure was: ${reason}`,
    );
  }
}

// autoCompleteAdmission -- the relay-handshake.mjs call-site wrapper.
// `attempted:false` (no ledger path resolved from EITHER source) is
// deliberately distinct from `attempted:true, ok:false` (a path was
// resolved, but the release itself failed) -- a caller/reader must never
// conflate "not wired here yet" with "wired and silently failing."
//
// HYK-227 2R §2/§3 항1: `ADMISSION_LEDGER_PATH` still wins whenever it is
// set (unchanged 1R priority -- e.g. this file's own test suite always
// takes this branch). Only when it is ABSENT does this now fall through to
// resolvePersistentLedgerPaths()'s installer-written pointer file. When
// NEITHER source resolves a path, the outcome is byte-for-byte the exact
// same `{ attempted: false }` 1R always returned -- this branch's shape and
// meaning are unchanged (§3 항1's explicit "사유 문구를 바꾸지 마라").
// HYK-289 (coder-task.md §2-1, "조용한 기본값은 안전장치가 아니다"): the
// persistent-pointer branch below is itself a silent, unconfirmable default
// -- ORCH measured it firing for real from a plain `node
// scripts/check/selfcheck-smoke.mjs` run (no `--test`, no fixture isolation
// at all), durably mutating the REAL control-room ledger's side file. The
// persistent pointer is legitimate PRODUCTION behavior for this adapter's
// real in-process callers (checkRelayHandshake, imported directly by
// scripts/relay/{watch-result,relay-core,orca-spike-runner,orca-spike-live}.mjs
// and scripts/relay/adapters/seat-signal-adapter.mjs -- none of these run
// under `node --test`, ORCH confirmed via repo-wide grep) -- so it cannot
// simply be removed or gated behind a brand-new opt-in nobody would ever
// set. `process.env.NODE_TEST_CONTEXT` is a Node.js-builtin var the
// `node --test` runner sets on its OWN process (confirmed empirically: a
// plain `node foo.mjs` never has it, `node --test foo.test.mjs` always
// does) -- not a guess, not derived from this adapter's own
// reservationId/args. Any child spawned without an `env` override inherits
// process.env, so this signal propagates through the existing spawn chain
// (checkRelayHandshake -> spawnAdmissionCompletion -> this file's CLI) for
// every `node --test` run that forgets sweep-ledger-isolation.mjs's
// `--import` preload (coder-task.md §1's "확장된" scope), with zero changes
// to relay-handshake.mjs. This does NOT close every gap (정직 한계, see
// coder.md): a plain `node <check-script>.mjs` invocation that is neither
// run under `node --test` NOR self-isolating (like this file's own
// selfcheck-smoke.mjs fix) is still indistinguishable from a real
// production caller from inside this function alone -- §2-1's "애매하면
// 거부" is satisfied here only for the `node --test` class, not that
// residual one.
//
// HYK-289 2R (coder-task.md §★★경계 계약, 책임자 확정 2026-08-18): this is
// NOT "block the fallback everywhere except when told not to" -- the
// boundary is drawn on PURPOSE, not as a residual gap:
//   막는 것 (blocked)   = `node --test` + 점검·스모크 진입점 (test/check
//                          entry points -- e.g. this file's own test suite,
//                          selfcheck-smoke.mjs).
//   유지하는 것 (kept)  = production consumption/monitoring entry points'
//                          pointer fallback -- `relay-handshake.mjs` (its
//                          CLI), `scripts/relay/watch-result.mjs`,
//                          `scripts/relay/orca-spike-live.mjs`, and the
//                          library callers `relay-core.mjs`,
//                          `adapters/seat-signal-adapter.mjs`,
//                          `orca-spike-runner.mjs`.
// Why keeping it is correct, not a hole: the persistent pointer file is a
// device HYK-227 built ON PURPOSE ("설치기가 써 두는 것") specifically so
// these production callers get a working ledger path WITHOUT every 관제실
// script having to set one -- and 관제실 never does: ORCH's repo-wide grep
// found zero 관제실 scripts that set `ADMISSION_LEDGER_PATH`. Blocking the
// fallback for these callers would not close a leak, it would silently kill
// real reservation-release/monitoring in production. A strictly stronger
// contract (reject everywhere unless explicitly opted in) is intentionally
// NOT this round's scope -- tracked separately as HYK-302.
function persistentFallbackAllowed() {
  return !process.env.NODE_TEST_CONTEXT;
}

// isInsideGitWorktree -- HYK-312 §1's original gate against the exact
// 2026-08-19 실사고 shape (a scratch/temp `.harness` copy outside any git
// worktree still resolving the real persistent pointer via cwd-derived
// `mainRepoRoot()`). Now imported from ledger-pointer-shared.mjs (HYK-302/
// 355 §2-A dedup) -- see that file's header for the full history and the
// one prior behavioral difference (relay-handshake.mjs's `!dir` guard) it
// carries forward unchanged for this file's call site below.

// HYK-302/355 §2-C (coder-task.md, «최소 요구»): under `node --test`
// (persistentFallbackAllowed()===false), this stays the exact
// byte-identical pre-existing no-op -- HYK-227 2R §3 항1's "사유 문구를
// 바꾸지 마라" still applies to this branch (admission-completion-
// persistent-source.test.mjs's ⓒ/ⓒ-2/ⓒ-3 pin exactly this shape under
// `node --test`, and the entire local test suite runs there). Outside
// `node --test`, with genuinely NEITHER source resolved (no
// ADMISSION_LEDGER_PATH, no installer-written pointer file), the
// pre-existing behavior was an equally silent {attempted:false} -- the
// exact "quiet default" HYK-289's own header calls out as not a safety
// net. This now reuses the SAME loud, already-tested channel HYK-312's own
// UNISOLATED_HARNESS_DIR gate established (`blocked:true`, CLI exit 1, and
// -- via relay-handshake.mjs's existing
// exitDistinctlyOnAdmissionCompletionFailure, unchanged by this round --
// the round's own CLI surfaces this as exit 3, not a silent 0) instead of
// inventing a new one. 정직 한계: in real production this branch should
// essentially never fire (ORCH confirmed the real control-room pointer
// file is already installed) -- this closes the "nobody configured
// anything at all" shape, the exact one HYK-227 1R's silent no-op let
// through into a real incident (see this file's own header).
function unconfiguredLedgerOutcome() {
  if (!persistentFallbackAllowed()) {
    return { attempted: false };
  }
  return {
    attempted: false,
    blocked: true,
    reasonCode: "LEDGER_PATH_UNCONFIGURED",
    reason: `admission-completion-adapter: no admission ledger path configured -- set ADMISSION_LEDGER_PATH, or ensure the installer-written .harness/${PERSISTENT_LEDGER_POINTER_FILENAME} pointer file exists at the main repo root -- see HYK-302`,
  };
}

// HYK-342/HYK-249: `reason` (optional) is forwarded to completeAdmission
// Reservation below unchanged -- see that function's own header. Every
// pre-existing caller omits it (byte-identical no-op stamping behavior).
// HYK-342 2R P1-1: `role` (optional) is forwarded alongside `reason` --
// required only when reason===BLOCKED_TERMINATION_RELEASED (see
// verifyBlockedTerminationEvidence); every pre-existing caller omits both.
// HYK-342 3R §2: `receiptPath` (optional) is forwarded alongside `reason`/
// `role` -- required (directly or via DISPATCH_RECEIPT_PATH env,
// resolveReceiptPathForVerification) only when reason===
// BLOCKED_TERMINATION_RELEASED. Every pre-existing caller omits it.
export function autoCompleteAdmission({
  reservationId,
  harnessDir,
  reason,
  role,
  receiptPath,
}) {
  let ledgerPath = process.env.ADMISSION_LEDGER_PATH;
  // HYK-312 §1: gate the persistent-pointer fallback below (never the
  // explicit ADMISSION_LEDGER_PATH env path just above, which is this
  // file's own "designed door", coder-task.md §4 ⓒ) behind a harnessDir
  // isolation check, checked and returned BEFORE the pre-existing
  // persistent-fallback block so that block's own source text (pinned
  // byte-for-byte by admission-completion-persistent-source.test.mjs's ⓓ
  // mutation target) stays untouched. `harnessDir` is optional/backward-
  // compatible: callers that don't pass it (every pre-HYK-312 in-process
  // caller/test) get the exact unchanged pre-HYK-312 behavior -- this is a
  // strictly additive gate, not a stricter default.
  if (
    !ledgerPath &&
    harnessDir &&
    persistentFallbackAllowed() &&
    !isInsideGitWorktree(harnessDir)
  ) {
    return {
      attempted: false,
      blocked: true,
      reasonCode: "UNISOLATED_HARNESS_DIR",
      reason: `admission-completion-adapter: refusing persistent-pointer fallback -- harnessDir '${harnessDir}' is not inside a registered git worktree (test/experiment consumption context without an explicit ADMISSION_LEDGER_PATH) -- see HYK-312`,
    };
  }
  let persistentLockPath = null;
  if (!ledgerPath && persistentFallbackAllowed()) {
    // HYK-437 §2⑵: anchor at harnessDir (already isInsideGitWorktree-
    // validated above), not the bare no-arg call -- see resolvePersistentLedgerPaths's header.
    const persistent = resolvePersistentLedgerPaths(harnessDir);
    if (persistent) {
      ledgerPath = persistent.ledgerPath;
      persistentLockPath = persistent.lockPath;
    }
  }
  if (!ledgerPath) {
    return unconfiguredLedgerOutcome();
  }
  const lockPath =
    process.env.ADMISSION_LOCK_PATH ||
    persistentLockPath ||
    `${ledgerPath}.lock`;
  const outcome = completeAdmissionReservation({
    reservationId,
    ledgerPath,
    lockPath,
    reason,
    harnessDir,
    role,
    receiptPath,
  });
  if (!outcome.ok) {
    appendCompletionFailureAudit({
      ledgerPath,
      reservationId,
      reasonCode: outcome.reasonCode,
      reason: outcome.reason,
      candidates: outcome.candidates,
      now: new Date().toISOString(),
    });
  }
  return { attempted: true, ...outcome };
}

// HYK-224-2R §3 옵션3 -- "제3의 자리(완료를 기록하는 중립 실행부를
// handshake 밖에 두기)". relay-handshake.mjs는 이 파일을 IMPORT하지
// 않는다(1R에서 정확히 그 import가 6개 mutation 시험 파일의 stageTree
// 고정 의존성 목록을 깨서 19건 RED를 냈다 -- coder.md 1R §4). 대신
// relay-handshake.mjs가 이 파일을 별도 자식 프로세스로 스폰한다 --
// import가 아니라 execFileSync 스폰이므로, 이 파일이 격리 픽스처
// 디렉터리에 없을 때(스폰 자체가 ENOENT로 실패) 그 실패는 relay-
// handshake.mjs 모듈 "로드 시점"이 아니라 "호출 시점"에 일어나고, 그
// 호출부가 try/catch로 감싸 무시한다 -- 그래서 기존 mutation 시험들의
// 소규모 격리 의존성 목록을 하나도 건드리지 않는다.
// HYK-227 1R 갱신 (이 문단은 1R 전 상태를 그대로 남겨둔 채였던 오기 --
// 2R에서 정정): 스폰 호출 자체는 더 이상 relay-handshake.mjs의 CLI
// 진입점(`invokedDirectly` 블록)에만 있지 않다 -- checkRelayHandshake
// 함수 본문(ok:true 분기, autoArchiveRoundEnvelope/autoRecordRejectStreak
// 바로 다음)으로 옮겨져 CLI·in-process 호출자 6곳(relay-core.mjs·
// watch-result.mjs·seat-signal-adapter.mjs·orca-spike-live.mjs·
// orca-spike-runner.mjs·CLI 진입점) 전부가 동일하게 이 스폰을 거친다.
// 그 "부르는 지점"의 결선은 2R 시점 기준 모든 저장소 호출자를 덮는다 --
// 다만 이 스폰이 실제로 슬롯을 반납하는지는 여전히 이 함수가 얻는
// `ledgerPath`(env 우선 + 영속 기본값, 위 §2 참고)에 달려 있다.
if (
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/admission-completion-adapter.mjs")
) {
  const reservationId = process.argv[2];
  if (!reservationId) {
    console.error(
      "usage: node admission-completion-adapter.mjs <reservationId> [harnessDir]",
    );
    process.exit(1);
  }
  const harnessDir = process.argv[3];
  // HYK-342/HYK-249: 4th positional arg, optional, backward-compatible --
  // pre-existing callers (relay-handshake.mjs's ok:true spawn) pass only
  // 2-3 args, so `reason` is undefined and completeReservation's stamping
  // stays off (see completeAdmissionReservation's own header).
  const reason = process.argv[4];
  // HYK-342 2R P1-1: 5th positional arg, optional -- required only when
  // reason===BLOCKED_TERMINATION_RELEASED (verifyBlockedTerminationEvidence
  // rejects that reason without it). Every pre-2R call site (and the
  // ok:true normal-completion path) never passes a 5th arg.
  const role = process.argv[5];
  // HYK-342 3R §2: 6th positional arg, optional -- explicit override for
  // the receipt path (falls back to DISPATCH_RECEIPT_PATH env otherwise,
  // resolveReceiptPathForVerification). Every pre-3R call site never
  // passes a 6th arg.
  const receiptPath = process.argv[6];
  const outcome = autoCompleteAdmission({
    reservationId,
    harnessDir,
    reason,
    role,
    receiptPath,
  });
  // HYK-312 §1: a blocked persistent-fallback attempt is the one outcome
  // shape that must NOT be treated like the pre-existing silent no-op below
  // -- it is a refusal (거부), not "not attempted", so it gets its own
  // nonzero exit + reason on stderr instead of exit 0 on stdout.
  if (outcome.blocked) {
    console.error(outcome.reason);
    process.exit(1);
  }
  if (!outcome.attempted) {
    console.log(
      "admission-completion-adapter: not attempted (ADMISSION_LEDGER_PATH unset)",
    );
    process.exit(0);
  }
  // HYK-224-3R §3: failures go to stderr, not stdout -- relay-handshake.mjs's
  // spawn wrapper captures BOTH streams separately (stdio:["ignore","pipe",
  // "pipe"]) and its own catch-block logging reads `err.stderr`, which was
  // previously empty for this exact case because this line used console.log
  // for the failure text too (검토자 실측: "세부 오류가 비어 있었다").
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
  process.exit(outcome.ok ? 0 : 1);
}
