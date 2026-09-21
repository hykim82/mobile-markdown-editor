import { readFileSync, existsSync, writeFileSync } from "node:fs";
// HYK-450 ②: 표지 계수는 «문서가 주장한 줄»만 세어야 한다. 인용(펜스
// 코드블록·HTML 주석) 안의 표지 모양을 함께 세면, 영수증 한 줄을 인용한
// 정직한 보고서가 «표지 2개 -- 어느 것이 최종인지 결정할 수 없다»로
// 판정 불능이 된다 -- 연속 반려 안전장치가 «거짓 근거로 잠기는» 계열의
// 데이터 손실이다(HYK-438·HYK-449 와 같은 형태).
// ⛔새 마스킹을 여기서 다시 짜지 않는다 -- 판별식 «한 벌»이 아래에 있고
// relay-handshake.mjs 는 그것을 import 해 re-export 한다.
import { join, dirname } from "node:path";
import { execSync, execFileSync } from "node:child_process";

// HYK-133: a same-issue rejected-review streak has no mechanical memory --
// `.harness/review.md` is a single relay slot overwritten every round, so
// the "this issue has been rejected N times in a row" fact vanished the
// moment the next round's review.md landed. HYK-129 사이클3 hit this exact
// gap (6 consecutive rejects on one spot; the 3-streak model-escalation and
// 5-streak research-escalation moves that actually helped were ORCH's own
// unrecorded judgment calls, not anything the harness remembered). This
// module gives that streak a durable home (`.harness/reject-streak.json`,
// keyed by issue id, surviving every relay-slot overwrite) and a gate that
// blocks a same-spot re-drop once the streak reaches 2 unless the next task
// file carries an escalation envelope (cause + at least one ORCH action).

// ---- HYK-450 ②: 이 판별식이 «왜 이 파일에» 있는가 -------------------------
// 원래 relay-handshake.mjs 안에 있었다. HYK-450 이 reject-streak.mjs 에서도
// 같은 함수를 써야 해서 옮겼는데, 옮길 자리가 두 번 바뀌었다 -- 그 과정을
// 남겨 둔다(다음 사람이 같은 자리를 다시 시도하지 않도록):
//   ⓐ reject-streak → relay-handshake 로 «직접 import» : ⛔불가.
//      relay-handshake 는 이미 reject-streak 을 import 하고 그 const 를 자기
//      최상위에서 읽으므로(AMBIGUOUS_COVER_REASON_CODES), 반대 방향을 더하면
//      순환이 되고 reject-streak 이 진입 모듈일 때 TDZ 로 «적재 시점»에 터진다.
//   ⓑ 제3의 모듈(quoted-marker-mask.mjs)로 분리 : ⛔실측 결과 불가.
//      이 저장소의 격리 시험들은 reject-streak.mjs 를 임시 루트로 복사할 때
//      «각자 손으로 적은 파일 목록»을 쓴다(9개 파일이 그렇다). 새 모듈은 그
//      목록에 없으므로 모듈 없음으로 죽는다 -- 전체 러너에서 80건이 그렇게
//      실패했다. 그 목록들을 전부 고치는 것은 이 조각의 범위(최소 변경)를
//      넘고, 하나라도 빠뜨리면 같은 실패가 반복된다.
//   ⇒ ⓒ **relay-handshake 가 «이미» 의존하고 모든 격리 픽스처가 «이미»
//      복사하는 이 파일**에 둔다. 복제본은 만들지 않는다(그것이 이 결함의
//      원인이었다) -- relay-handshake.mjs 는 여기서 import 해 re-export 하므로
//      기존 호출자·시험은 한 줄도 바뀌지 않는다.
// ⚠️의미상 이 파일의 주제(연속 반려 원장)와 딱 맞는 자리는 아니다. 그 대가로
// «모든 소비자가 도달할 수 있는 한 벌»을 얻었다 -- 그 교환을 여기 적어 둔다.

// ---- HYK-449: 「인용된 표지」는 표지가 아니다 -----------------------------
//
// 2026-09-06 실사고: 검토자가 러너 영수증 **원문**을 코드블록(```)에 그대로
// 붙였고, 그 안의 `head_commit:` 줄이 칼럼 0 이라 이 파일이 **표지로 세었다**.
// 두 줄의 값은 완전히 동일했는데도 "어느 것이 최종인지 결정할 수 없다"로
// 거부됐고, 첫 관측이 이미 고정된 뒤라 고칠 수도 없어 라운드 하나가 양방향
// 교착에 빠졌다(HYK-449 등재문).
//
// ★수리의 단위는 **원소가 아니라 범주**다 -- HYK-442 1R 이 정확히 그 실수로
// 반려됐다(백틱 «하나만» 벗겼다가 같은 보고서의 홑따옴표 인용에 다시 뚫렸다).
// 그래서 여기서는 「무엇을 벗길까」가 아니라 **「이 문서가 «주장하는» 텍스트는
// 무엇인가」**를 정의한다:
//
//   ★판별식 -- 표지는 **문서 자신이 말하는 줄**일 때만 표지다. 문서가
//   「보여주기만 하는」 영역과 「꺼 둔」 영역의 글자는 표지가 아니다.
//     ⑴ **펜스 코드블록**(보여주는 영역) -- ``` 와 ~~~ **둘 다**, 3개 이상
//        **임의 길이**, CommonMark 대로 최대 3칸 들여쓴 펜스까지, 정보
//        문자열(```text 등) 유무 무관. 닫는 펜스는 **같은 문자로 여는 펜스
//        이상 길이**여야 한다(그래서 ````` 블록 안의 ``` 는 닫지 못한다).
//     ⑵ **HTML 주석**(꺼 둔 영역) `<!-- … -->` -- 이 저장소의 결과 파일이
//        실제로 쓰는 형태다(라운드 보존 블록의 `<!-- envelope-archive: … -->`).
//
// ⛔여기 **넣지 않은 것**과 그 근거(추측이 아니라 시험으로 고정했다 --
//   hyk449-quoted-marker-count.test.mjs 의 「범주 밖」 시험군):
//     - 인용 블록(`> `) · 들여쓴 코드블록(4칸) · 인라인 코드(`…`)는 그 줄이
//       애초에 **칼럼 0 이 아니다**. 이 파일의 표지 정규식은 전부 `^` 앵커라
//       원래 매치하지 못한다 -- 「범주에서 빠뜨린 자리」가 **아니라 이미 닫혀
//       있는 자리」다. ★단 HYK-469: 이건 「그 줄 전체가 표지로 세어지지
//       않는다」는 뜻이지 「인라인 코드 안의 <!--/--> 글자가 주석 스캐너에
//       안 보인다」는 뜻은 아니었다 -- `maskHtmlComments` 는 줄 앵커가 아니라
//       문자열 전체를 훑으므로 인라인 코드 «안」의 <!--/--> 도 그대로
//       읽혔다. 아래 `maskHtmlComments`(HYK-469 갱신분)가 그 구멍을 막는다.
// ⛔**`>>> BLOCKED:` / `NEEDS_INPUT:` 축에는 이 마스킹을 적용하지 않는다.**
//   그 축의 「어디에 있든 센다」는 **의도된 fail-closed 설계**이고(HYK-333 ·
//   HYK-442), 거기에 인용 제외를 넣는 것은 안전 성질을 약화시키는 회귀다.
//
// ⚠️마스킹은 **길이를 보존**한다(개행만 남기고 나머지 글자를 공백으로 바꾼다)
//   -- 호출자가 매치의 `.index` 로 **원문**을 자르기 때문이다(judgedRegion).
//   그래서 마스킹된 사본에서 얻은 오프셋이 원문에서 그대로 유효하다.
// ⚠️닫히지 않은 펜스/주석은 **문서 끝까지** 마스킹한다 -- 그 방향은
//   fail-closed 다(표지가 「사라져」 missing/pending 으로 떨어지지, 없는 표지가
//   생기지 않는다).
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
      // ⚠️`\r` 를 반드시 허용해야 한다: 이 저장소의 결과 파일은 실제로
      // **CRLF** 다(Windows 좌석). 줄을 `\n` 으로 가르면 각 줄 끝에 `\r` 가
      // 남는데, 그것을 허용하지 않으면 **닫는 펜스를 영영 못 알아본다** --
      // 그러면 첫 펜스가 문서 끝까지 인용으로 삼켜 «표지가 사라진» 것처럼
      // 되고 라운드가 PENDING 으로 막힌다(HYK-449 1R 에서 내 결과 파일이
      // 실제로 그렇게 막혔다). 다른 축들이 CRLF 에서 멀쩡한 이유는 그쪽
      // 정규식이 `m` 플래그를 써 `$` 가 `\r` 앞에서도 맞기 때문이고, 여기는
      // 줄 단위로 직접 대조하므로 그 도움을 받지 못한다.
      const closer = new RegExp(
        `^ {0,3}\\${fence.char}{${fence.len},}[ \t\r]*$`,
      );
      if (closer.test(line)) fence = null;
      return blankKeepingNewlines(line);
    })
    .join("\n");
}

// HYK-469: 백틱 1개로 감싼 인라인 코드 구간(줄을 못 건넌다 -- CommonMark
// 그대로) 안의 `<!--`/`-->` 글자는 «주석 표지 후보」로 세지 않는다. 실사고
// (2026-09-13, HYK-468-unblock-2 결과 파일 53행): 산문 한 줄에 인라인 코드로
// 감싼 여는 표지가 «두 번», 닫는 표지가 «한 번» 있었다. 옛 구현은 backtick 을
// 전혀 모르고 문자열 전체에서 순서대로 <!-- 다음 --> 를 찾았으므로, 첫 쌍을
// (우연히) 다 인라인 코드 안에서 소비한 뒤 «짝 없는 두 번째 여는 표지」를
// 진짜 열린 주석으로 보고 그 뒤 fail-closed 규칙(문서 끝까지 마스킹)을 적용해
// 완료 표지 줄까지 통째로 지웠다.
//
// ★고친 방식 -- 인라인 코드 «구간 자체를 지우지 않는다.» 대신 <!--/--> 를
// 찾을 때 그 위치가 인라인 코드 구간 «안」이면 후보에서 제외하고 다음 실제
// 위치를 계속 찾는다. 그래서:
//   ⓐ 인라인 코드 밖 텍스트(예: 이 함수 자신의 문서용 예시 `QUOTED-INLINE`)는
//      한 글자도 안 바뀐다 -- HYK-449 범주 밖 시험이 그 불변을 이미 고정한다.
//   ⓑ 진짜 여는 표지가 «인라인 코드 밖」에 있으면, 그 닫는 짝을 찾을 때도
//      인라인 코드 «안」의 --> 는 후보에서 제외한다 -- 그래야 인라인 코드로
//      감싼 --> 를 끼워 넣어 진짜 주석을 조기에 «풀어버리는» 위조를 막는다.
//   ⓒ 인라인 코드는 줄을 못 건너므로(정규식 [^`\n]*), 인라인 코드 안에 갇힌
//      «짝 없는» 여는 표지는 애초에 그 줄을 벗어나 문서 끝까지 삼킬 길이
//      없다 -- §2 가 요구한 「줄 단위로 닫히게」는 이 성질로 자동 성립한다.
// ⛔진짜(인라인 코드 밖) 여는 표지가 문서 안에서 끝내 못 닫히면 여전히 문서
// 끝까지 마스킹한다(fail-closed, 바뀌지 않음) -- HYK-449 원래 방향 그대로.
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

// 표지를 세는 축들이 보는 「문서 자신이 말한 것」. ⛔BLOCKED 축은 이것을
// 쓰지 않는다(위 주석). 내보내는 이유는 시험이 판별식 자체를 직접 재기
// 위해서다 -- 축마다 각자 복사본을 만들면 조용히 어긋난다(이 파일이
// DONE_RE/TASK_ID_RE_G 를 내보내는 것과 같은 재사용 규율).
export function maskQuotedMarkerRegions(content) {
  return maskHtmlComments(maskFencedBlocks(content));
}

// HYK-469 3R §2 (책임자 조건 1, HYK-468 4R과 같은 원리): 468 3R이 만든
// admission-completion-adapter.mjs 로컬 복제(고정 sibling 목록 때문에
// import 불가 -- 그 파일 헤더 주석 참조)가 이 인라인 코드 마스킹 규칙
// «전체»에서 정본과 바이트 동일한지, «손으로 고른 목록»이 아니라 이 묶음을
// 순회해서 기계로 단정하기 위한 export다. 정본이 이 묶음에 이름을 하나
// 더 추가하면(가짜든 진짜든) hyk468-3r-copy-drift.test.mjs는 코드 수정
// 없이 그 이름도 자동으로 admission 사본과 대조한다(같은 이름이 사본에
// 없으면 예외 0으로 통과가 아니라 실패). 이름은 admission 사본과 정확히
// 같아야 한다 -- maskQuotedMarkerRegions 자신은 admission에서 의도적으로
// 다른 이름(maskQuotedMarkerRegionsLocal)으로 복제돼 있으므로 이 묶음에
// 넣지 않는다(넣으면 정당한 이름 차이가 "예외 0" 계약을 깬다).
export const RULE_FUNCTIONS = {
  INLINE_CODE_SPAN_RE,
  inlineCodeRanges,
  isInsideAnyRange,
  findOutsideInlineCode,
  maskHtmlComments,
};

const ISSUE_ID_RE = /^(HYK-\d+)/;
// HYK-183: 결과 파일에 이 표지가 2개 이상이면 어느 것이 최종인지 결정할 수
// 없으므로 조용히 하나를 고르지 않고 판정 불가로 멈춘다(2026-07-31 거짓
// 기록 사고). `for:`/`verdict:`는 항상 개수부터 세야 하므로 global 버전만
// 남긴다; `task_id:`는 checkGate/checkDiagnosticGate가 단일 매치로도 쓰므로
// non-global과 global 버전을 함께 둔다.
// ⛔HYK-332: exported so finalize-done.mjs can reuse this exact 'for:'
// cover-line regex (coder-task.md §2 요구5) instead of inventing a second
// copy that could silently drift from this one.
export const FOR_LINE_RE_G = /^for:\s*(\S+)/gm;
const TASK_ID_LINE_RE = /^task_id:\s*(\S+)/im;
const TASK_ID_LINE_RE_G = /^task_id:\s*(\S+)/gim;
const VERDICT_LINE_RE_G = /^verdict:\s*(approved|rejected)\s*$/gim;
// HYK-183-ledger-fix (축 A): 결과 파일의 `>>> DONE: ... @ <시각>` 줄에서
// 그 라운드가 실제로 끝난 시각을 뽑는다. `for:`/`task_id:`는 ORCH가 같은
// 이슈의 여러 실제 라운드에 걸쳐 바로 그 이슈 id를 그대로(라운드 구분자
// 없이) 반복해 쓰는 실측 관행이 있어(2026-08-05 원장 표본: `HYK-183`,
// `HYK-186`이 서로 다른 시각의 서로 다른 라운드에 매번 동일 문자열로
// 반복 기록됨) 그 값만으로는 "같은 라운드를 다시 확인한 것"과 "다른
// 라운드가 우연히 같은 문자열을 썼다"를 구분할 수 없다. DONE 시각은
// 라운드마다 실제로 다른 실시각이므로(동일 파일을 재확인하는 진짜
// 재시도만 완전히 같다) 그 구분을 기계적으로 대신한다. DONE 줄이
// 0개·2개 이상(모호)이면 doneAt=null로 물러나 기존(taskId+verdict만
// 보는) 판정으로 fail back한다 -- 새 신호가 없다고 판정 자체가 막히지
// 않는다.
const DONE_LINE_RE_G = /^>>>\s*DONE:.*@\s*(.+?)\s*$/gim;

// The envelope lives inside an HTML comment, same convention as
// pm-snapshot-gate.mjs's `<!-- pm-snapshot ... -->` block -- a form ORCH can
// copy-paste into a task file without it rendering as visible prose.
const ENVELOPE_BLOCK_RE = /<!--\s*reject-streak-envelope([\s\S]*?)-->/i;
const CAUSE_LINE_RE = /^\s*원인\s*분류\s*:\s*(.+?)\s*$/m;
const ACTIONS_HEADER_RE = /^\s*ORCH\s*조치\s*:\s*$/m;

// The ladder's step-2 requirement (게이트-기준.md §HYK-133 R2): exactly these
// four cause labels, exactly these five action labels. A label is accepted
// either as an exact match or as a prefix (so "스펙 오류(ORCH)" -- the label
// this design itself uses -- and a hand-typed "리서치(출처 포함): ..." both
// match without demanding byte-identical punctuation).
export const ALLOWED_CAUSES = [
  "스펙 오류(ORCH)",
  "모델 한계",
  "환경 차이",
  "설계 결함",
];
export const ALLOWED_ACTIONS = [
  "리서치",
  "모델 변경",
  "재설계 지시",
  "디스코프 제안",
  "PM B2 자문 회부",
];

export const ESCALATION_LADDER = {
  2: "봉투 강제 (원인 분류 + ORCH 조치 >=1, 이 게이트가 기계 검사)",
  3: "모델 승격 검토 권장 (관례, 기계 강제 아님)",
  4: "디스코프/PM B2 자문 후보 (관례, 기계 강제 아님 -- HYK-158로 진단 봉투만 기계 강제, 자문 자체는 여전히 관례)",
};

// HYK-158: promotes ladder step 4 ("디스코프/PM B2 자문 후보") from a purely
// advisory checkpoint to a machine-checked "hard-stop" -- the tier where two
// prior real incidents (6A review-2/3, 07-15) were handled by ORCH's own
// unrecorded judgment, exactly the gap that motivated this task (STATUS
// "예행 2회 실증 관례의 승격 관리"). The design report (§3.2) does not name
// a numeric streak threshold; step 4 is the ladder's own existing
// "structurally stuck, needs more than another envelope" tier, so this
// reuses it rather than inventing a new number -- an explicit CODER design
// choice, not a guess, and flagged for REVIEW to confirm.
export const HARD_STOP_STREAK = 4;

// HYK-158 field: extends the existing HYK-133 envelope schema (원인 분류 +
// ORCH 조치) with a third required field for the hard-stop tier only --
// 재현 증거 포인터 (a pointer to reproduction evidence), matching the design
// report's "기존 HYK-133 봉투 스키마 확장" instruction to extend, not
// replace, the same `<!-- reject-streak-envelope ... -->` block.
const EVIDENCE_POINTER_LINE_RE = /^\s*재현\s*증거\s*포인터\s*:\s*(.+?)\s*$/m;

// HYK-262 §2 (책임자 확정): relay-handshake.mjs used to decide "block
// consumption" by matching the Korean sentence 어느 것이 최종인지 결정할
// 수 없다 against `reason` with a regex -- 1R's own검토 실측 showed
// rewording that sentence by one character silently kills the block. A
// structured, never-reworded reasonCode is the stable coupling value the
// 책임자 asked for; `reason` stays exactly as-is (added, not replaced) for
// human readers/logs. Every ok:false branch below that can occur sets one
// of these -- relay-handshake.mjs matches on reasonCode membership, never
// on `reason` text.
export const REJECT_STREAK_REASON_CODE = Object.freeze({
  // 표지 줄(for:/task_id:/verdict:)이 2개 이상 -- 어느 것이 최종인지 결정할
  // 수 없어 판정 자체를 거부하는 세 갈래. relay-handshake.mjs가 소비를
  // 막는 대상은 정확히 이 세 코드다.
  AMBIGUOUS_FOR_LINE: "AMBIGUOUS_FOR_LINE",
  AMBIGUOUS_TASK_ID_LINE: "AMBIGUOUS_TASK_ID_LINE",
  AMBIGUOUS_VERDICT_LINE: "AMBIGUOUS_VERDICT_LINE",
  // 표지 줄 계약 위반이 아닌, 다른 이유로 UNJUDGABLE한 갈래들 -- §3의
  // "막지 않는 2종"이 흔적을 남길 때 어느 종류인지 구분하는 데 쓰인다.
  NO_COVER_LINE: "NO_COVER_LINE",
  ISSUE_ID_UNPARSEABLE: "ISSUE_ID_UNPARSEABLE",
  // HYK-357: 'for:' 값이 있는데 HYK-<숫자>로 시작하지 않아 실패한 갈래를
  // ISSUE_ID_UNPARSEABLE에서 따로 뗀 코드. 이 갈래는 조용히 task_id:로
  // 폴백하지 않는다(§0-B "없음≠모름") -- 대신 이 reasonCode 자체가
  // "for: 때문에 막혔다"는 신호가 되고, reason 문자열에 task_id: 줄이
  // 멀쩡했는지(값과 함께)를 항상 덧붙여 사람이 5초 안에 원인을 알 수
  // 있게 한다. task_id: 자체가 unparseable한 경우(즉 rawTaskId가 for:
  // 없이 task_id:에서 왔거나, for:는 있었지만 task_id:도 같이 깨진 경우)는
  // 여전히 일반 ISSUE_ID_UNPARSEABLE로 남는다.
  FOR_LINE_ISSUE_ID_UNPARSEABLE: "FOR_LINE_ISSUE_ID_UNPARSEABLE",
  NO_VERDICT_LINE: "NO_VERDICT_LINE",
  LEDGER_READ_FAILED: "LEDGER_READ_FAILED",
  LEDGER_INVALID_JSON: "LEDGER_INVALID_JSON",
  LEDGER_INVALID_SHAPE: "LEDGER_INVALID_SHAPE",
});

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

// HYK-221 축3: the CLI's default LEDGER path only -- review.md/coder-task.md
// defaults stay on repoRoot() (plain --show-toplevel, worktree-local; those
// files are meant to be per-worktree relay slots). The ledger is different:
// dispatch-gate-decision.mjs::resolveRepoRoot (the READING side) already
// resolves the repo via `git rev-parse --git-common-dir` (+ a bare-repo
// check), which converges every linked worktree of the same repo onto ONE
// path. This CLI's own default ledger resolution (the WRITING side, used
// when `record`/`gate`/`diagnostic-gate` are invoked with no `--ledger`) used
// to call plain repoRoot() instead -- `--show-toplevel` returns the CURRENT
// worktree's own root, a DIFFERENT answer in a linked worktree. That mismatch
// is the exact HYK-219 1R incident (§1 축3 of this task): a `record` run
// inside a worktree wrote to that worktree's own `.harness/reject-streak.json`
// while the gate kept reading the main repo's file, so the rejection never
// became visible to the 2-streak gate. Mirroring the read side's exact git
// invocation here (rather than reusing relay-handshake.mjs's mainRepoRoot(),
// which would be a circular import -- relay-handshake.mjs already imports
// FROM this module) closes that gap for every direct CLI invocation.
function ledgerRepoRoot() {
  const fallback = repoRoot();
  let commonDir;
  try {
    commonDir = execFileSync(
      "git",
      [
        "-C",
        fallback,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return fallback;
  }
  let isBare;
  try {
    isBare = execFileSync(
      "git",
      ["--git-dir", commonDir, "rev-parse", "--is-bare-repository"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return fallback;
  }
  return isBare === "true" ? commonDir : dirname(commonDir);
}

function issueIdFrom(taskIdLike) {
  const m =
    typeof taskIdLike === "string" ? taskIdLike.match(ISSUE_ID_RE) : null;
  return m ? m[1] : null;
}

// A source file authored/edited on Windows (this repo's own docs/*.md, seen
// live when review-1's doc-code contract test extracted a CRLF-line block
// straight out of docs/enforcement-v1.md) can carry `\r\n` line endings.
// `.` in a JS regex excludes `\r` (not just `\n`), so a bullet-line pattern
// like `/^\s*-\s*(.+)$/` silently fails to match a CRLF-terminated line --
// not a parse error, just zero bullets found, which is indistinguishable
// from "no bullets written." Normalizing once at every text-parsing entry
// point removes the whole class rather than patching each affected regex.
function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n");
}

// HYK-357: extracted out of parseReviewOutcome to keep that function under
// the repo's max-lines-per-function/complexity ceiling. Builds the
// diagnostic reason for the 'for:'-sourced-but-unparseable branch -- no
// silent fallback to 'task_id:' (§0-B "없음≠모름"), but the reason string
// always names whether 'task_id:' was itself fine (and its value) so a
// human can tell within 5 seconds that 'for:' -- not 'task_id:' -- is what
// blocked this round.
function buildForLineUnparseableOutcome(rawTaskId, taskIdMatches) {
  const singleTaskIdRaw =
    taskIdMatches.length === 1 ? taskIdMatches[0][1] : null;
  const taskIdIssueId = singleTaskIdRaw ? issueIdFrom(singleTaskIdRaw) : null;
  const taskIdDiagnostic =
    taskIdMatches.length === 0
      ? "task_id: 줄도 없다"
      : taskIdMatches.length > 1
        ? `task_id: 줄이 ${taskIdMatches.length}개라 그쪽도 모호하다`
        : taskIdIssueId
          ? `task_id: 은 멀쩡했다 (task_id: ${singleTaskIdRaw}) -- 그러나 조용히 그쪽으로 폴백하지 않는다`
          : `task_id: 도 같이 깨졌다 (task_id: ${singleTaskIdRaw})`;
  return {
    ok: false,
    reasonCode: REJECT_STREAK_REASON_CODE.FOR_LINE_ISSUE_ID_UNPARSEABLE,
    reason: `reject-streak record: 'for: ${rawTaskId}' does not start with HYK-<digits> -- cannot derive issue id from the 'for:' line. ${taskIdDiagnostic}`,
  };
}

// HYK-357-352 2R §2 (P1-2 판정 = ⓑ 위반 아님, 스펙 오류(ORCH) 자인): a
// 'for:' value and a 'task_id:' value CAN legitimately name different
// issues -- e.g. a bundled multi-issue review round whose 'for:' reads
// 'HYK-344+347+350' (issueIdFrom only ever extracts the FIRST HYK-<n>
// prefix, so a bundled round's derived issueId can differ from its own
// task_id:'s issueId BY DESIGN, not by mistake). Strict equality would
// therefore block a legitimate round (정당한 거부 회귀 -- the exact thing
// this task's §2 forbids). Instead of blocking, this surfaces the mismatch
// as a non-blocking diagnostic note (§0-B "없음≠모름": the fact that the
// two values point at different issues must not vanish silently just
// because it isn't a violation) -- see recordRejectStreakFromResultText
// for where this note reaches the console log.
function crossIssueNote(rawTaskIdFromForLine, issueId, taskIdMatches) {
  if (!rawTaskIdFromForLine || taskIdMatches.length !== 1) return null;
  const taskIdIssueId = issueIdFrom(taskIdMatches[0][1]);
  if (!taskIdIssueId || taskIdIssueId === issueId) return null;
  return `'for:' issue (${issueId}) differs from 'task_id:' issue (${taskIdIssueId}) -- not treated as a violation (e.g. legitimate bundled multi-issue rounds), noted for visibility only`;
}

// Reads `.harness/review.md`-shaped text and extracts what `record` needs:
// which task the verdict is about (prefers `for:`, the coder-round id being
// judged; falls back to the review round's own `task_id:` if `for:` is
// absent -- both share the same leading `HYK-<n>` issue prefix) and the
// verdict itself. Returns `{ ok: false, reason }` rather than throwing on
// any missing/malformed piece -- callers treat this as an UNJUDGABLE input,
// never a crash.
export function parseReviewOutcome(reviewText) {
  const text = normalizeNewlines(reviewText);
  // HYK-450 ②: 세는 것은 «주장된» 표지뿐이다(위 import 주석). 값을 뽑는
  // 것도 같은 사본에서 한다 -- 세는 텍스트와 읽는 텍스트가 다르면 그
  // 자체가 HYK-431 계열의 결함이다.
  const asserted = maskQuotedMarkerRegions(text);
  const forMatches = [...asserted.matchAll(FOR_LINE_RE_G)];
  const taskIdMatches = [...asserted.matchAll(TASK_ID_LINE_RE_G)];

  let rawTaskId = null;
  let rawTaskIdFromForLine = false;
  if (forMatches.length > 1) {
    return {
      ok: false,
      reasonCode: REJECT_STREAK_REASON_CODE.AMBIGUOUS_FOR_LINE,
      reason: `reject-streak record: UNJUDGABLE -- 'for:' 줄이 ${forMatches.length}개라 어느 것이 최종인지 결정할 수 없다`,
    };
  }
  if (forMatches.length === 1) {
    rawTaskId = forMatches[0][1];
    rawTaskIdFromForLine = true;
  } else if (taskIdMatches.length > 1) {
    return {
      ok: false,
      reasonCode: REJECT_STREAK_REASON_CODE.AMBIGUOUS_TASK_ID_LINE,
      reason: `reject-streak record: UNJUDGABLE -- 'task_id:' 줄이 ${taskIdMatches.length}개라 어느 것이 최종인지 결정할 수 없다`,
    };
  } else if (taskIdMatches.length === 1) {
    rawTaskId = taskIdMatches[0][1];
  }
  if (!rawTaskId) {
    return {
      ok: false,
      reasonCode: REJECT_STREAK_REASON_CODE.NO_COVER_LINE,
      reason:
        "reject-streak record: no 'for:' or 'task_id:' line found -- cannot resolve which task this verdict is about",
    };
  }
  const issueId = issueIdFrom(rawTaskId);
  if (!issueId) {
    // HYK-357: 조용한 폴백은 하지 않는다 -- rawTaskId가 'for:'에서 왔고
    // 그 값이 깨졌다면, 'task_id:'가 멀쩡했든 아니든 그 사실이 reason에
    // 그대로 드러나야 사람이 5초 안에 "for: 때문"임을 알 수 있다.
    if (rawTaskIdFromForLine) {
      return buildForLineUnparseableOutcome(rawTaskId, taskIdMatches);
    }
    return {
      ok: false,
      reasonCode: REJECT_STREAK_REASON_CODE.ISSUE_ID_UNPARSEABLE,
      reason: `reject-streak record: task id '${rawTaskId}' does not start with HYK-<digits> -- cannot derive issue id`,
    };
  }
  const verdictMatches = [...asserted.matchAll(VERDICT_LINE_RE_G)];
  if (verdictMatches.length > 1) {
    return {
      ok: false,
      reasonCode: REJECT_STREAK_REASON_CODE.AMBIGUOUS_VERDICT_LINE,
      reason: `reject-streak record: UNJUDGABLE -- 판정 줄이 ${verdictMatches.length}개라 어느 것이 최종인지 결정할 수 없다`,
    };
  }
  if (verdictMatches.length === 0) {
    return {
      ok: false,
      reasonCode: REJECT_STREAK_REASON_CODE.NO_VERDICT_LINE,
      reason:
        "reject-streak record: no 'verdict: approved' or 'verdict: rejected' line found",
    };
  }
  // 축 A: DONE 시각은 부가 식별자일 뿐이다 -- 0개(누락)·2개 이상(모호) 다
  // 똑같이 doneAt=null로 물러난다. 여러 개 중 하나를 조용히 고르지
  // 않는다(§0-B 표지 정직성과 같은 원칙); null이면 isDuplicate 판정이
  // task_id+verdict만 보던 예전 동작으로 그대로 되돌아갈 뿐, 판정 자체가
  // 막히지는 않는다.
  // HYK-450 ②: 같은 함수 안에서 한 계수만 원문을 보면 그 자체가 «조용한
  // 어긋남»이다 -- DONE 줄도 «주장된» 사본에서 센다. 이 축은 부가 식별자라
  // 방향도 안전하다(인용을 빼면 doneAt 이 오히려 더 자주 «하나»로 확정돼
  // 중복 판정이 정확해진다).
  const doneMatches = [...asserted.matchAll(DONE_LINE_RE_G)];
  const doneAt = doneMatches.length === 1 ? doneMatches[0][1] : null;
  const note = crossIssueNote(rawTaskIdFromForLine, issueId, taskIdMatches);
  return {
    ok: true,
    taskId: rawTaskId,
    issueId,
    verdict: verdictMatches[0][1].toLowerCase(),
    doneAt,
    ...(note ? { crossIssueNote: note } : {}),
  };
}

// Pure ledger transition: rejected increments that issue's streak, approved
// resets it to 0. An issue absent from the ledger starts at streak 0 (same
// "no ledger entry == streak 0" rule the gate side uses), so record/gate
// agree on what "no history yet" means. Every outcome is appended to that
// issue's history regardless of verdict -- the ladder needs the full
// sequence, not just the current streak, to explain itself later.
export function applyOutcome(ledger, { issueId, taskId, verdict, at, doneAt }) {
  const issues = { ...(ledger?.issues ?? {}) };
  const prev = issues[issueId] ?? { streak: 0, history: [] };
  const streak = verdict === "rejected" ? (prev.streak ?? 0) + 1 : 0;
  const entry = { task_id: taskId, verdict, at };
  // `doneAt` is an opt-in identifier (callers that never derive it, e.g.
  // direct unit tests of this function, keep producing the original
  // 3-field history shape) -- only computeRecord's caller passes it.
  if (doneAt !== undefined) entry.done_at = doneAt;
  issues[issueId] = {
    streak,
    history: [...(prev.history ?? []), entry],
  };
  return { schema_version: ledger?.schema_version ?? 1, issues };
}

// Composes parseReviewOutcome + applyOutcome into the one decision `record`
// needs. Never throws; a malformed review text is reported as `ok: false`
// so the CLI can treat it as UNJUDGABLE (fail-open) rather than corrupting
// the ledger with a guessed entry.
//
// HYK-183 §2-1 R3 (idempotency), 축 A 갱신(HYK-183-ledger-fix): identifies a
// repeat call by comparing against the issue's LAST recorded history entry.
// Originally this compared task_id+verdict alone on the assumption that
// "each round's result file echoes its OWN task_id" -- that assumption does
// NOT hold in production: the 2026-08-05 원장 표본 shows ORCH repeatedly
// writing the bare issue id (no round suffix) into both `for:`/`task_id:`
// across genuinely distinct rounds of the SAME issue (e.g. `HYK-186`
// rejected twice on the same day, both rounds echoing literally `HYK-186`).
// Under the old task_id+verdict-only key, the second real rejection was
// indistinguishable from a retried call on the first, so the gate silently
// swallowed it (§1 축 A: "게이트가 안 걸린다"). `done_at` (each round's own
// `>>> DONE: ... @ <time>` line, present on every valid result file) is
// added as a THIRD component precisely because it is the one thing that
// reliably differs between two genuinely different rounds while staying
// identical for a true retry of the same already-confirmed file. `doneAt`
// missing/ambiguous on either side falls back to the original two-field
// comparison (no new false negatives introduced when the new signal isn't
// available) -- see parseReviewOutcome's own DONE-line handling.
// HYK-357-352 2R §2: extracted so computeRecord doesn't gain a third/fourth
// ternary branch (repo's ESLint complexity ceiling) -- both computeRecord
// return sites attach the SAME optional field the same way.
function withCrossIssueNote(result, outcome) {
  return outcome.crossIssueNote
    ? { ...result, crossIssueNote: outcome.crossIssueNote }
    : result;
}

export function computeRecord({ reviewText, ledger, at }) {
  const outcome = parseReviewOutcome(reviewText);
  if (!outcome.ok)
    return {
      ok: false,
      reason: outcome.reason,
      reasonCode: outcome.reasonCode,
    };

  const existing = ledger?.issues?.[outcome.issueId];
  const lastEntry = existing?.history?.[existing.history.length - 1];
  const isDuplicate =
    !!lastEntry &&
    lastEntry.task_id === outcome.taskId &&
    lastEntry.verdict === outcome.verdict &&
    (lastEntry.done_at ?? null) === (outcome.doneAt ?? null);
  if (isDuplicate) {
    return withCrossIssueNote(
      {
        ok: true,
        duplicate: true,
        ledger,
        issueId: outcome.issueId,
        taskId: outcome.taskId,
        verdict: outcome.verdict,
        streak: existing.streak,
      },
      outcome,
    );
  }

  const nextLedger = applyOutcome(ledger, {
    issueId: outcome.issueId,
    taskId: outcome.taskId,
    verdict: outcome.verdict,
    at,
    doneAt: outcome.doneAt,
  });
  return withCrossIssueNote(
    {
      ok: true,
      duplicate: false,
      ledger: nextLedger,
      issueId: outcome.issueId,
      taskId: outcome.taskId,
      verdict: outcome.verdict,
      streak: nextLedger.issues[outcome.issueId].streak,
    },
    outcome,
  );
}

// Extracted from loadLedger (HYK-160 quality-check: keep loadLedger's own
// complexity under the repo's ESLint ceiling) -- true iff `parsed` is a
// plain object with a plain-object (non-array) `issues` field.
function hasValidIssuesShape(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return false;
  return (
    typeof parsed.issues === "object" &&
    parsed.issues !== null &&
    !Array.isArray(parsed.issues)
  );
}

// Loads the ledger, distinguishing "file doesn't exist yet" (a real,
// judgable state -- every issue starts at streak 0) from "file exists but
// is unreadable/malformed" (an UNJUDGABLE state per this task's R3/ⓕ --
// fail-open, never silently treated as streak 0 and never overwritten).
export function loadLedger(
  ledgerPath,
  { readFileFn = (p) => readFileSync(p, "utf8"), existsFn = existsSync } = {},
) {
  if (!existsFn(ledgerPath)) {
    return {
      ok: true,
      existed: false,
      ledger: { schema_version: 1, issues: {} },
    };
  }
  let raw;
  try {
    raw = readFileFn(ledgerPath);
  } catch (err) {
    return {
      ok: false,
      reasonCode: REJECT_STREAK_REASON_CODE.LEDGER_READ_FAILED,
      reason: `reject-streak: UNJUDGABLE -- failed to read ledger '${ledgerPath}' (${err.message})`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reasonCode: REJECT_STREAK_REASON_CODE.LEDGER_INVALID_JSON,
      reason: `reject-streak: UNJUDGABLE -- ledger '${ledgerPath}' is not valid JSON (${err.message})`,
    };
  }
  if (!hasValidIssuesShape(parsed)) {
    return {
      ok: false,
      reasonCode: REJECT_STREAK_REASON_CODE.LEDGER_INVALID_SHAPE,
      reason: `reject-streak: UNJUDGABLE -- ledger '${ledgerPath}' missing/invalid 'issues' object`,
    };
  }
  return { ok: true, existed: true, ledger: parsed };
}

export function writeLedger(ledgerPath, ledger, writeFileFn = writeFileSync) {
  writeFileFn(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

const REVIEW_ROLE_RE = /^review/i;

// HYK-183 §2: true iff `role` (relay-handshake.mjs's file-prefix role, e.g.
// "review"/"review2"/"coder"/"verify") belongs to the REVIEW family whose
// result file can carry a `verdict: approved|rejected` line. A CODER
// handshake has no verdict to record; `.harness/verify.md` (VERIFY role) is
// never scanned for a verdict line by review-gate.mjs/reject-streak.mjs
// either -- only "review"-prefixed roles are in scope here.
export function isReviewFamilyRole(role) {
  return typeof role === "string" && REVIEW_ROLE_RE.test(role);
}

// HYK-183 §2: composes loadLedger + computeRecord + writeLedger into the
// one call relay-handshake.mjs's auto-wiring needs at the exact moment it
// confirms a REVIEW-family result file is complete. Idempotency is
// computeRecord's job (see its own header); this function's job is failure
// VISIBILITY (§2-1 R4) -- every branch returns a human-readable `reason`,
// never a silent no-op, so a caller that logs it (relay-handshake.mjs's
// CLI and in-process callers alike) surfaces a read/parse/write failure
// instead of folding it into "ledger just wasn't touched, nobody noticed."
export function recordRejectStreakFromResultText({
  role,
  resultText,
  ledgerPath,
  at,
}) {
  if (!isReviewFamilyRole(role)) {
    return {
      attempted: false,
      ok: true,
      reason: `reject-streak auto-record: role '${role}' is not REVIEW-family -- skipped (no verdict to record)`,
    };
  }

  const loaded = loadLedger(ledgerPath);
  if (!loaded.ok) {
    return {
      attempted: true,
      ok: false,
      reasonCode: loaded.reasonCode,
      reason: loaded.reason,
    };
  }

  const computed = computeRecord({
    reviewText: resultText,
    ledger: loaded.ledger,
    at: at || formatNowLocal(),
  });
  if (!computed.ok) {
    return {
      attempted: true,
      ok: false,
      reasonCode: computed.reasonCode,
      reason: `reject-streak auto-record: UNJUDGABLE -- ${computed.reason} (fail-open, ledger untouched)`,
    };
  }
  // HYK-357-352 2R §2: a 'for:'/'task_id:' cross-issue mismatch is NOT a
  // violation (see crossIssueNote's own header) but must not vanish
  // silently either -- appended to the SAME reason line every caller
  // already logs (relay-handshake.mjs's autoRecordRejectStreak does
  // `console.log(autoRecord.reason)` on the ok:true path), no new log
  // channel needed.
  const noteSuffix = computed.crossIssueNote
    ? ` [NOTE: ${computed.crossIssueNote}]`
    : "";
  if (computed.duplicate) {
    return {
      attempted: true,
      ok: true,
      duplicate: true,
      reason: `reject-streak auto-record: DUPLICATE -- ${computed.issueId} <- ${computed.taskId} verdict=${computed.verdict} already last-recorded (streak=${computed.streak} unchanged), ledger not rewritten${noteSuffix}`,
    };
  }

  writeLedger(ledgerPath, computed.ledger);
  return {
    attempted: true,
    ok: true,
    duplicate: false,
    reason: `reject-streak auto-record: ${computed.issueId} <- ${computed.taskId} verdict=${computed.verdict} -> streak=${computed.streak}${noteSuffix}`,
  };
}

// Extracts the ORCH-action bullet lines from the envelope body's "ORCH
// 조치:" section -- every consecutive `- ...` line right after the header,
// stopping at the first blank line (once at least one bullet is captured)
// or the first non-bullet line. Returns null when the header itself is
// absent, [] when the header exists but no bullet followed it.
function extractActionBullets(body) {
  const headerMatch = body.match(ACTIONS_HEADER_RE);
  if (!headerMatch) return null;
  const rest = body.slice(body.indexOf(headerMatch[0]) + headerMatch[0].length);
  const bullets = [];
  for (const line of rest.split("\n")) {
    if (/^\s*$/.test(line)) {
      if (bullets.length > 0) break;
      continue;
    }
    const m = line.match(/^\s*-\s*(.+)$/);
    if (!m) break;
    bullets.push(m[1].trim());
  }
  return bullets;
}

function classifyAction(bulletLine) {
  const idx = bulletLine.indexOf(":");
  const label = (idx === -1 ? bulletLine : bulletLine.slice(0, idx)).trim();
  return (
    ALLOWED_ACTIONS.find(
      (allowed) => label === allowed || label.startsWith(allowed),
    ) ?? null
  );
}

// R2/R4: verifies a dropped task file's escalation envelope is *present and
// shaped correctly* -- honesty note (S4, item 4 of the task contract): this
// checks format only, never whether the stated cause is the real cause or
// whether the ORCH action is actually a good idea. That judgment is left to
// whoever reads the envelope later (review, or a human), same scope limit
// pm-snapshot-gate.mjs already documents for its own envelope.
export function checkEnvelope(taskText) {
  const text = normalizeNewlines(taskText);
  const blockMatch = text.match(ENVELOPE_BLOCK_RE);
  if (!blockMatch) {
    return {
      ok: false,
      reason:
        "reject-streak gate: no escalation envelope found (need '<!-- reject-streak-envelope ... -->' with 원인 분류 + ORCH 조치)",
    };
  }
  const body = blockMatch[1];

  const causeMatch = body.match(CAUSE_LINE_RE);
  const cause = causeMatch ? causeMatch[1].trim() : null;
  if (!cause) {
    return {
      ok: false,
      reason: "reject-streak gate: envelope missing '원인 분류:' field",
    };
  }
  if (!ALLOWED_CAUSES.some((c) => cause === c || cause.startsWith(c))) {
    return {
      ok: false,
      reason: `reject-streak gate: '원인 분류: ${cause}' is not one of ${ALLOWED_CAUSES.join(" | ")}`,
    };
  }

  const bullets = extractActionBullets(body);
  if (bullets === null) {
    return {
      ok: false,
      reason: "reject-streak gate: envelope missing 'ORCH 조치:' header",
    };
  }
  const classified = bullets.map(classifyAction).filter(Boolean);
  if (classified.length === 0) {
    return {
      ok: false,
      reason: `reject-streak gate: 'ORCH 조치' needs >=1 line '- <분류>: <내용>' matching ${ALLOWED_ACTIONS.join(" | ")} (found ${bullets.length} bullet(s), 0 matched)`,
    };
  }

  return {
    ok: true,
    reason: `reject-streak gate: envelope complete (원인 분류=${cause}, ORCH 조치=${classified.join(", ")})`,
  };
}

// R2/R3: the gate decision itself. `ledger` is the already-loaded object
// (loadLedger's corrupted/UNJUDGABLE case is handled by the caller before
// this is ever invoked -- see the CLI block). A task file with no
// resolvable task_id/issue id is UNJUDGABLE+fail-open, not a block --
// unlike the envelope-missing case, "I can't tell which issue this is"
// is never itself a reason to refuse a drop.
export function checkGate({ taskText, ledger }) {
  const text = normalizeNewlines(taskText);
  const taskIdMatch = text.match(TASK_ID_LINE_RE);
  if (!taskIdMatch) {
    return {
      status: "UNJUDGABLE",
      ok: true,
      reason:
        "reject-streak gate: UNJUDGABLE -- task file has no task_id header, cannot resolve issue id (fail-open)",
    };
  }
  const issueId = issueIdFrom(taskIdMatch[1]);
  if (!issueId) {
    return {
      status: "UNJUDGABLE",
      ok: true,
      reason: `reject-streak gate: UNJUDGABLE -- task_id '${taskIdMatch[1]}' does not start with HYK-<digits> (fail-open)`,
    };
  }

  const streak = ledger?.issues?.[issueId]?.streak ?? 0;
  if (streak < 2) {
    return {
      status: "PASS",
      ok: true,
      reason: `reject-streak gate: ${issueId} streak=${streak} (<2) -- envelope not required`,
    };
  }

  const envelope = checkEnvelope(text);
  if (!envelope.ok) {
    return {
      status: "BLOCK",
      ok: false,
      reason: `reject-streak gate: ${issueId} streak=${streak} (>=2) -- ${envelope.reason}`,
    };
  }
  return {
    status: "PASS",
    ok: true,
    reason: `reject-streak gate: ${issueId} streak=${streak} (>=2) -- ${envelope.reason}`,
  };
}

// HYK-158/G3: the hard-stop diagnostic envelope check -- same block
// (`<!-- reject-streak-envelope ... -->`) and 원인 분류/ORCH 조치 fields as
// checkEnvelope, PLUS the new 재현 증거 포인터 field. Kept as a separate
// function (not a flag bolted onto checkEnvelope) so the streak<2/streak>=2
// gate's existing reason strings -- already asserted by other tests/callers
// -- never shift shape; this is an additive extension, not a rewrite.
//
// Honesty (S4, design §3.2): this checks the envelope's *presence and
// shape* only. It never verifies the diagnosis is actually correct or
// sufficient, and never infers a cause or narrows issue scope on its own --
// that judgment stays with REVIEW/a human.
export function checkDiagnosticEnvelope(taskText) {
  const text = normalizeNewlines(taskText);
  const blockMatch = text.match(ENVELOPE_BLOCK_RE);
  if (!blockMatch) {
    return {
      ok: false,
      reason:
        "DIAGNOSTIC_REQUIRED -- hard-stop streak has no diagnostic envelope (need '<!-- reject-streak-envelope ... -->' with 원인 분류 + 재현 증거 포인터 + ORCH 조치)",
    };
  }
  const body = blockMatch[1];
  const missing = [];

  const causeMatch = body.match(CAUSE_LINE_RE);
  const cause = causeMatch ? causeMatch[1].trim() : null;
  if (!cause) {
    missing.push("원인 분류");
  } else if (!ALLOWED_CAUSES.some((c) => cause === c || cause.startsWith(c))) {
    missing.push(`원인 분류(허용값 아님: '${cause}')`);
  }

  const evidenceMatch = body.match(EVIDENCE_POINTER_LINE_RE);
  const evidencePointer = evidenceMatch ? evidenceMatch[1].trim() : null;
  if (!evidencePointer) {
    missing.push("재현 증거 포인터");
  }

  const bullets = extractActionBullets(body);
  const classifiedActions = (bullets ?? []).map(classifyAction).filter(Boolean);
  if (bullets === null) {
    missing.push("ORCH 조치");
  } else if (classifiedActions.length === 0) {
    missing.push(
      `ORCH 조치(허용 분류 불일치, ${bullets.length}개 불릿 중 0 매치)`,
    );
  }

  if (missing.length) {
    return {
      ok: false,
      reason: `DIAGNOSTIC_FIELD_MISSING -- missing field(s): ${missing.join(", ")}`,
    };
  }

  return {
    ok: true,
    reason: `diagnostic envelope complete (원인 분류=${cause}, 재현 증거 포인터=${evidencePointer}, ORCH 조치=${classifiedActions.join(", ")})`,
  };
}

// HYK-158/G3: the gate decision -- blocks the next coder drop for an issue
// whose streak has reached HARD_STOP_STREAK unless a complete diagnostic
// envelope accompanies it. Below the hard-stop tier this is always PASS
// regardless of the ordinary (streak>=2) envelope requirement checkGate
// already enforces -- the two gates are independent and both apply.
export function checkDiagnosticGate({ taskText, ledger }) {
  const text = normalizeNewlines(taskText);
  const taskIdMatch = text.match(TASK_ID_LINE_RE);
  if (!taskIdMatch) {
    return {
      status: "UNJUDGABLE",
      ok: true,
      reason:
        "reject-streak diagnostic gate: UNJUDGABLE -- task file has no task_id header, cannot resolve issue id (fail-open)",
    };
  }
  const issueId = issueIdFrom(taskIdMatch[1]);
  if (!issueId) {
    return {
      status: "UNJUDGABLE",
      ok: true,
      reason: `reject-streak diagnostic gate: UNJUDGABLE -- task_id '${taskIdMatch[1]}' does not start with HYK-<digits> (fail-open)`,
    };
  }

  const streak = ledger?.issues?.[issueId]?.streak ?? 0;
  if (streak < HARD_STOP_STREAK) {
    return {
      status: "PASS",
      ok: true,
      reason: `reject-streak diagnostic gate: ${issueId} streak=${streak} (<${HARD_STOP_STREAK}, not hard-stop) -- diagnostic envelope not required`,
    };
  }

  const diag = checkDiagnosticEnvelope(text);
  if (!diag.ok) {
    return {
      status: "BLOCK",
      ok: false,
      reason: `reject-streak diagnostic gate: ${issueId} streak=${streak} (hard-stop) -- ${diag.reason}`,
    };
  }
  return {
    status: "PASS",
    ok: true,
    reason: `reject-streak diagnostic gate: ${issueId} streak=${streak} (hard-stop) -- ${diag.reason}`,
  };
}

export function formatNowLocal(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} KST`;
}

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--review") out.review = args[++i];
    else if (args[i] === "--ledger") out.ledger = args[++i];
    else if (args[i] === "--at") out.at = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/reject-streak.mjs");
if (invokedDirectly) {
  const root = repoRoot();
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (sub === "record") {
    const reviewPath = args.review || join(root, ".harness", "review.md");
    const ledgerPath =
      args.ledger || join(ledgerRepoRoot(), ".harness", "reject-streak.json");

    if (!existsSync(reviewPath)) {
      console.log(
        `reject-streak record: UNJUDGABLE -- review file not found: ${reviewPath} (fail-open, ledger untouched)`,
      );
      process.exit(0);
    }
    const reviewText = readFileSync(reviewPath, "utf8");

    const loaded = loadLedger(ledgerPath);
    if (!loaded.ok) {
      console.log(loaded.reason + " (fail-open, ledger untouched)");
      process.exit(0);
    }

    const result = computeRecord({
      reviewText,
      ledger: loaded.ledger,
      at: args.at || formatNowLocal(),
    });
    if (!result.ok) {
      console.log(
        `reject-streak record: UNJUDGABLE -- ${result.reason} (fail-open, ledger untouched)`,
      );
      process.exit(0);
    }

    if (result.duplicate) {
      console.log(
        `reject-streak record: DUPLICATE -- ${result.issueId} <- ${result.taskId} verdict=${result.verdict} already last-recorded (streak=${result.streak} unchanged), ledger not rewritten`,
      );
      process.exit(0);
    }

    writeLedger(ledgerPath, result.ledger);
    console.log(
      `reject-streak record: ${result.issueId} <- ${result.taskId} verdict=${result.verdict} -> streak=${result.streak}`,
    );
    process.exit(0);
  }

  if (sub === "gate") {
    const taskPath = args._[0] || join(root, ".harness", "coder-task.md");
    const ledgerPath =
      args.ledger || join(ledgerRepoRoot(), ".harness", "reject-streak.json");

    if (!existsSync(taskPath)) {
      console.error(`reject-streak gate: task file not found: ${taskPath}`);
      process.exit(1);
    }
    const taskText = readFileSync(taskPath, "utf8");

    const loaded = loadLedger(ledgerPath);
    if (!loaded.ok) {
      console.log(loaded.reason + " -- exit 0 (fail-open, drop not blocked)");
      process.exit(0);
    }

    const result = checkGate({ taskText, ledger: loaded.ledger });
    if (result.status === "BLOCK") {
      console.error(result.reason);
      process.exit(2);
    }
    console.log(result.reason);
    process.exit(0);
  }

  if (sub === "diagnostic-gate") {
    const taskPath = args._[0] || join(root, ".harness", "coder-task.md");
    const ledgerPath =
      args.ledger || join(ledgerRepoRoot(), ".harness", "reject-streak.json");

    if (!existsSync(taskPath)) {
      console.error(
        `reject-streak diagnostic-gate: task file not found: ${taskPath}`,
      );
      process.exit(1);
    }
    const taskText = readFileSync(taskPath, "utf8");

    const loaded = loadLedger(ledgerPath);
    if (!loaded.ok) {
      console.log(loaded.reason + " -- exit 0 (fail-open, drop not blocked)");
      process.exit(0);
    }

    const result = checkDiagnosticGate({ taskText, ledger: loaded.ledger });
    if (result.status === "BLOCK") {
      console.error(result.reason);
      process.exit(2);
    }
    console.log(result.reason);
    process.exit(0);
  }

  console.error(
    "usage: node reject-streak.mjs record --review <path> [--ledger <path>] [--at <'YYYY-MM-DD HH:MM KST'>]",
  );
  console.error(
    "       node reject-streak.mjs gate [<task-path>] [--ledger <path>]",
  );
  console.error(
    "       node reject-streak.mjs diagnostic-gate [<task-path>] [--ledger <path>]",
  );
  process.exit(1);
}
