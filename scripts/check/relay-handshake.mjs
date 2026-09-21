import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  recordRejectStreakFromResultText,
  isReviewFamilyRole,
  REJECT_STREAK_REASON_CODE,
} from "./reject-streak.mjs";
import {
  archiveRoundEnvelope,
  archiveRoundTaskFileIfNew,
} from "./envelope-archive.mjs";
import {
  TIME_FIELD,
  TIME_AUTHORITY_STATE,
  MAX_FUTURE_SKEW_MS,
  KST_OFFSET_MS,
  isBeyondFutureSkew,
  isSuspectedTimezoneMislabel,
} from "./time-authority.mjs";
import {
  resolveChildProbeTimeoutMs,
  withTimeoutRetry,
} from "./child-probe-timeout-policy.mjs";

export { TIME_AUTHORITY_STATE, MAX_FUTURE_SKEW_MS };

// HYK-183: 결과 파일에 이 표지가 2개 이상이면 어느 것이 최종인지 결정할 수
// 없으므로 조용히 하나를 고르지 않고 판정 불가로 멈춘다(2026-07-31 거짓
// 기록 사고). TASK_ID_RE(과거: 첫 매치 채택)와 DONE_RE(과거: 마지막 매치
// 채택)가 서로 반대 방향을 조용히 골랐던 것이 이 수리의 대상이다.
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
//       있는 자리**다.
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

function maskHtmlComments(content) {
  let out = content;
  let from = 0;
  for (;;) {
    const start = out.indexOf("<!--", from);
    if (start === -1) return out;
    const closeAt = out.indexOf("-->", start + 4);
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

const TASK_ID_RE = /^task_id:\s*(\S+)/im;
const TASK_ID_RE_G = /^task_id:\s*(\S+)/gim;
// HYK-180 사이클1: the anchored TASK_ID_RE only matches a standalone
// `task_id: <id>` line at column 0. When it fails to match, this
// unanchored variant tells apart two very different failure shapes: no
// `task_id:` token anywhere (genuinely absent, worker still writing --
// pending) vs a `task_id:` token that exists but isn't a standalone line
// (e.g. `for: X / task_id: Y / role: Z` -- a structural violation that no
// amount of waiting fixes). Never used to accept a match; only to produce
// a distinct diagnosis for the latter case.
const TASK_ID_ANYWHERE_RE = /task_id:\s*(\S+)/i;
// HYK-353 2R §1 (P1-2): exported so finalize-done.mjs can resolve the exact
// same `dropped_at:` raw text this file itself uses when it composes the
// (taskId, droppedAt) key it hands to first-observation.mjs's
// findFirstObservation -- same reuse-not-reinvent instruction as DONE_RE/
// isWellFormedDoneTimestamp above.
export const DROPPED_AT_RE = /^dropped_at:\s*(.+)$/im;
// HYK-183: 결과 파일에 이 표지가 2개 이상이면 어느 것이 최종인지 결정할
// 수 없으므로 조용히 하나를 고르지 않고 판정 불가로 멈춘다 (see the file
// header above for the fuller rationale this constant shares with
// TASK_ID_RE_G).
// ⛔HYK-324/HYK-325: exported so finalize-done.mjs can reuse the EXACT same
// "what counts as a well-formed DONE line" contract (coder-task.md §2-1's
// explicit "재사용하라, 새 기준을 발명하지 마라") instead of inventing its
// own copy that could silently drift from this one.
export const DONE_RE = /^>>>\s*DONE:.*@\s*(.+?)\s*$/gim;
// HYK-173-escalation-1: 결과 파일이 명시적으로 «막혔다»고 적을 수 있는
// column-0 표지. `>>> DONE:` 관례를 그대로 재사용한다(같은 파일 자리에서
// 같은 눈으로 찾을 수 있게). 이유 텍스트는 필수(빈 이유는 아래
// BLOCKED_ANYWHERE_RE 경로로 새서 MALFORMED로 fail-closed된다 -- "형식이
// 깨졌으면 괜찮다로 접지 않는다" 비타협).
// HYK-173-escalation-2 (REVIEW 반려 (1) 수리): 1R은 `\s*`를 세 자리 모두에
// 썼는데, `\s`는 `\n`을 포함한다 -- `^`/`$`가 column-0·줄-끝을 잡아도 그
// 사이의 `\s*`가 개행을 통째로 삼켜 «>>>\nBLOCKED: split»이나 «>>>
// BLOCKED:\nreason on next line» 같은 다중 행 입력이 "한 줄" 계약을 어기고도
// 정상 매치로 수락됐다(REVIEW 실측 `manual-split-after-arrows`/
// `manual-split-after-colon`). `>>>`와 키워드 사이, 콜론과 이유 사이의
// 공백은 개행을 포함하지 않는 `[ \t]*`로 좁힌다 -- 그 결과 콜론 뒤에 바로
// 개행이 오면 `(\S.*?)`가 그 자리에서 매치할 문자가 없어 이 정규식
// 자체가 매치하지 않고(아래 BLOCKED_ANYWHERE_RE의 near-miss 경로로 새어
// MALFORMED_BLOCKED가 된다), `>>>`와 개행 사이도 마찬가지로 막힌다.
const BLOCKED_RE = /^>>>[ \t]*(BLOCKED|NEEDS_INPUT):[ \t]*(\S.*?)[ \t]*$/gim;
// 위 엄격한 패턴이 매치하지 못했을 때, "애초에 그런 표지가 없다"(진짜
// pending)와 "표지를 쓰려고 한 흔적은 있는데 형식이 깨졌다"(예: column 0이
// 아님·이유 텍스트 없음·줄이 쪼개짐)를 가르는 near-miss 탐지.
// TASK_ID_ANYWHERE_RE와 동일한 역할 -- 매치 채택에는 절대 쓰지 않고 진단
// 구별에만 쓴다. 여기의 `\s*`는 의도적으로 유지한다 -- 바로 이 느슨함이
// «줄이 쪼개진 표지 흔적»까지 near-miss로 잡아내는 지점이다(엄격 패턴을
// 좁힌 것과 반대 방향의 요구).
// HYK-173-escalation-2 (REVIEW 반려 (2) 수리): `g` 플래그를 얹어 "몇 건
// 있는가"까지 셀 수 있게 한다 -- 엄격 매치가 정확히 1개 있어도 그 「옆에」
// 별도의 깨진 표지가 더 있으면(예: 유효 `>>> BLOCKED: valid` 한 줄과
// `status: >>> BLOCKED: midline`이 함께 있는 경우) 조용히 그 1개짜리
// 유효 매치로 확정하지 않고 MALFORMED_BLOCKED 계열로 승격해야 한다
// (REVIEW 실측 `manual-valid-plus-malformed`) -- resolveResultBlockedState
// 아래 참조. `matchAll`은 'g' 플래그가 있어도 원본 정규식의 `lastIndex`를
// 건드리지 않으므로(내부적으로 복제) 이 상수를 여러 곳에서 반복 호출해도
// 안전하다.
const BLOCKED_ANYWHERE_RE = />>>\s*(BLOCKED|NEEDS_INPUT)\b/gi;
// HYK-333: 관제실 워커 규칙 §3-b가 2026-08-21까지 `>>>` 없이 column-0
// `BLOCKED: <사유>` / `NEEDS_INPUT: <사유>` 를 쓰라고 가르쳤다(취소선으로
// 보존된 옛 문면). 그 시기 규칙을 정확히 지킨 워커의 정지 표지는 위
// BLOCKED_ANYWHERE_RE조차 매치하지 못해(둘 다 `>>>`를 요구) NONE으로 조용히
// 유실됐다(ORCH 재현, coder-task.md §1). 이 상수는 그 흔적만 좁게 잡는다 --
// column 0(줄 맨 앞, 선행 공백 0)에서 시작해야 한다. `^`가 줄 시작만
// 고정하므로 §3-2 요구 4가 금지한 "줄 중간의 ... BLOCKED: ..." 는 이
// 패턴에도 매치하지 않는다(무한 확장 방지 -- 오탐 억제는 여기서 끝나지
// 않고 아래 resolveResultBlockedState가 이 매치를 절대 BLOCKED/
// NEEDS_INPUT으로 승격하지 않는 것으로 한 번 더 막는다, 설계 판정 「A」).
// HYK-333 2R (검토 1R P2-1): 콜론 뒤 사유(`\S`)를 요구하지 않는다 --
// `BLOCKED:`(화살표도 사유도 없음) 한 단어만 쓴 줄이 이전에는 이 패턴에도
// 안 걸려 근본적으로 매치되지 않았고, `>>>`가 없으니 BLOCKED_ANYWHERE_RE도
// 못 잡아 결국 아무 near-miss도 안 잡혀 state=NONE(조용한 PENDING)으로
// 묻혔다 -- "빈 사유는 BLOCKED_RE도 거부하니 대칭"이라는 1R의 근거는
// 틀렸다(BLOCKED_RE 쪽은 `>>>`가 있으면 near-miss가 받아 내지만, 여기는
// `>>>`가 없어 애초에 받아 낼 곳이 없었다 -- 대칭이 아니라 사각지대).
// 사유를 요구하지 않도록 넓히면 이제 `>>>` 쪽(BLOCKED_ANYWHERE_RE는
// `>>>\s*(BLOCKED|NEEDS_INPUT)\b` -- 이 역시 콜론/사유를 요구하지 않는다)과
// 동작이 같아진다 -- "사유 없는 표지도 근처-미스로 본다"는 기준이 화살표
// 유무와 무관하게 일관된다.
// ⛔BLOCKED_RE(엄격 채택 기준, 채택에는 사유 필수)는 이 상수와 무관하게
// 그대로다 -- 건드리지 않는다.
const BLOCKED_BARE_COLUMN0_RE = /^(BLOCKED|NEEDS_INPUT):/gim;

// HYK-442 5R (검토 2R P1-ⓐ 수리 -- ⛔«인용인지 추정하는» 축 자체를 버린다):
//
// 이 이슈는 같은 실패를 세 번 반복했고, 세 번 다 공통점이 하나였다 --
// 「이 따옴표가 인용인가」를 문장부호 배치로 «추정»한 것이다:
//   1R -- 인용부호를 백틱 «한 원소»로 좁힘  -> 홑따옴표 인용에 다시 걸림
//         (정당한 정지 종결을 막는 «과차단»).
//   2R -- 집합을 3종으로 «넓힘»             -> 자연어 축약형 두 개(don't …
//         can't) 사이의 «진짜» 근접-미스가 통째로 스트립됨(«누락»).
//   4R -- 여는-자리 규칙(축 A) + 줄-선두 불가침(축 B)로 «배치»를 정교화
//         -> 검토 2R이 여섯 입력으로 뚫음: `'tis`/`'26`/문장-시작 홑따옴표는
//         여는 자리로 오인되고(축 A), BOM·제로폭 문자가 줄 앞에 오면
//         줄-선두 보호가 아예 작동하지 않았다(축 B).
// 추정 축은 «공격자가 입력을 정하는 한» 수렴하지 않는다. 그래서 5R은
// 인용부호를 ⛔한 글자도 다루지 않는다 -- 스트립 함수 자체가 사라졌다.
//
// ── 대신 «근접-미스»의 정의를 구조로 고정한다 ─────────────────────────
// 표지는 «줄 단위» 구성물이다 -- 엄격 채택 BLOCKED_RE 자신이 `^>>>`(줄 맨
// 앞)를 요구한다. 그러므로 «표지를 쓰려다 실패한 흔적»은 언제나 «줄 머리»에
// 온다: 실제로 관측된 근접-미스 다섯 형태(선행 공백 · `>>>` 없는 칼럼0 ·
// 콜론 없음 · 표지 2개 · 표지 0개)가 전부 그렇고, 워커 규칙 §3-b가 가르치는
// 형식("줄 맨 앞에 `>>>`를 붙여서") 자체가 그렇다. 반대로 «앞에 산문이 있는»
// 표지 모양은 그 줄의 «문장 일부»이지 표지 시도가 아니다.
// ⇒ 5R의 정의: ★표지 모양 앞에 «글자도 숫자도 하나도 없는» 줄만 근접-미스
//   시도로 센다(아래 PROSE_CHAR_RE). 인용부호는 글자도 숫자도 아니므로
//   판정에 관여하지 않는다 -- 백틱이든 홑따옴표든 겹따옴표든, 유니코드
//   유사 따옴표든, 괄호든, 짝이 맞든 안 맞든 «묻지 않는다». 「인용인가」라는
//   질문이 사라졌으므로 그 질문을 속이는 입력도 존재할 수 없다.
//
// 왜 이것이 여섯 공격을 «구조적으로» 닫는가: 공격의 공통 수법은 «진짜 표지
// 시도를 인용 스팬 안에 숨겨 지우는 것»이었다. 이제 지우는 단계가 없다.
// 줄 머리에서 시작한 시도 앞에는 (공백·글머리표·⛔ 같은 기호·BOM·제로폭
// 문자 등) 무엇이 와도 «글자/숫자»가 아니면 그대로 세어진다 -- 보이지 않는
// 문자는 애초에 `\p{L}`/`\p{N}`이 아니므로 «예외 목록 한 줄도 없이» 자동으로
// 덮인다(BOM·제로폭·word joiner·결합 문자 전부).
//
// ⚠️이 정의가 «좁히는» 것(정직 한계 -- coder.md에 등급과 함께 기재):
// 줄 중간에, 앞에 산문을 두고 나타나는 표지 모양은 이제 근접-미스가 아니다.
// 그것이 이 라운드가 «과차단»(원래 사고: 인용 언급 때문에 정상 종료가 막힘)과
// «누락»(검토가 뚫은 fail-open)을 동시에 없애는 유일한 길이었다 -- 두 실물
// 사고 파일의 인용 언급(coder-437-PRE-EDIT-1758.md 166행 · coder-laneB-PRE-
// EDIT.md 50·54행)과 HYK-333 (6)의 `status: >>> BLOCKED: midline`은 «인용부호
// 유무»를 빼면 구조가 완전히 같아서, 인용부호를 보지 않고 둘을 가르는 규칙은
// 원리적으로 존재하지 않는다(coder.md §2-1 증명).
//
// ⛔BLOCKED_RE(엄격 채택)는 건드리지 않는다 -- 이 파일의 어떤 근접-미스
// 판정도 표지를 «수락»하는 경로에는 관여하지 않는다.

// 표지 모양 «앞»에 산문이 있는가를 묻는 유일한 문자 부류. 글자(\p{L})와
// 숫자(\p{N}) 둘뿐이다 -- 인용부호·괄호·글머리표·화살표·보이지 않는 문자는
// 전부 여기에 해당하지 않으므로 판정에 영향을 주지 않는다.
const PROSE_CHAR_RE = /[\p{L}\p{N}]/u;

// 보이지 않는 형식 문자(BOM U+FEFF · 제로폭 U+200B~200F · word joiner
// U+2060~2064 · soft hyphen …)는 «있으나 없으나 같은 줄»이다. 칼럼0 고정인
// BLOCKED_BARE_COLUMN0_RE만 이 정규화가 필요하다(그 하나는 위치로 판정하므로
// 줄 앞에 보이지 않는 문자가 끼면 밀려난다). ⛔문자를 하나씩 열거한 예외
// 목록이 아니라 유니코드 «형식 문자» 부류 하나다.
const INVISIBLE_FORMAT_CHAR_RE = /\p{Cf}/gu;

// HYK-442 6R (검토 3R P1 -- 유일한 반려 사유): 5R의 판별 «축»(표지 모양 앞에
// 글자도 숫자도 없는 줄만 시도로 센다)은 검토의 여덟 공격을 전부 버텼다.
// 뚫린 곳은 축이 아니라 그 축이 서는 «자리» -- 줄 머리를 `lastIndexOf("\n")`
// 하나로 구한 탓에, LF가 «아닌» 줄 경계 뒤에 온 표지 시도는 앞줄 산문이
// 그대로 딸려 들어와 PROSE_CHAR_RE가 참이 되고 «시도가 아니다»로 사라졌다
// (검토 3R 실측: CR 단독·U+2028·U+2029·폼피드 네 경계 각각에서, 유효한 정지
// 결과가 함께 있을 때만 드러나는 fail-open).
// ⇒ 줄 경계를 «부류 하나»로 고친다. ⛔축은 한 글자도 바뀌지 않는다 --
// PROSE_CHAR_RE도, "앞에 산문이 없으면 시도"라는 규칙도 그대로다.
// 이 집합은 임의가 아니라 «줄을 끝내는 문자»의 표준 집합이다: JS 정규식이
// `m` 플래그에서 줄 종결자로 인정하는 넷(LF·CR·U+2028·U+2029 -- 그래서
// BLOCKED_RE/BLOCKED_BARE_COLUMN0_RE의 `^`가 이미 그 넷을 줄 머리로 본다)에,
// 유니코드가 줄 경계로 규정하지만 JS 정규식만 빼놓는 폼피드(U+000C)를 더한
// 것이다. 즉 이 상수는 «칼럼0 모양이 이미 쓰고 있던 줄 개념»을 화살표 모양
// 쪽에도 같게 맞추는 일이지, 새 경계를 발명하는 것이 아니다.
const LINE_BOUNDARY_CHAR_RE = /[\n\r\u2028\u2029\f]/u;

// 「`matchIndex`가 있는 줄은 어디서 시작하는가」. 뒤에서부터 «처음 만나는»
// 줄 경계 문자 바로 다음이 줄 머리다.
// ⚠️★CRLF가 «한 개»의 줄 경계로 남는 이유가 바로 이 «뒤에서부터»다: \r\n
// 앞에서 뒤로 훑으면 먼저 만나는 것이 LF이므로 줄 머리는 LF 다음 --
// LF만 쓰던 5R 계산과 CRLF 입력에서 «값이 같다». (경계를 앞에서부터 세거나
// \r과 \n을 각각 한 줄로 쪼개면 둘 사이에 빈 줄이 생겨, 그 뒤의 표지 모양이
// 「앞에 산문이 없는 줄」로 잘못 승격된다 -- 회귀 시험 (13)이 LF판·CRLF판의
// 판정을 네 방향으로 대조해 이 성질을 고정한다.)
function lineStartOffset(scan, matchIndex) {
  for (let i = matchIndex - 1; i >= 0; i -= 1) {
    if (LINE_BOUNDARY_CHAR_RE.test(scan[i])) return i + 1;
  }
  return 0;
}

// 근접-미스 «시도»의 개수. 두 표지 모양 모두 «그 매치가 시작한 줄»을 기준으로
// 판정한다:
//   ⓐ 화살표 모양(BLOCKED_ANYWHERE_RE) -- 매치 시작 위치와 그 줄의 머리
//      사이에 글자/숫자가 하나도 없을 것(그 «줄의 머리»는 lineStartOffset이
//      정한다 -- HYK-442 6R 전에는 LF 하나로만 구해서, LF가 아닌 줄 경계
//      뒤의 시도를 앞줄 산문에 가려 놓쳤다). ⛔줄 «전체»를 보지 않고 «앞»만
//      보는 이유: 이 정규식의 `\s*`는 의도적으로 개행을 건널 수 있고(줄이
//      쪼개진 표지 흔적을 잡는 지점, 그 상수 자신의 헤더 참조) 그 성질을
//      이 라운드가 없애지 않기 때문이다.
//   ⓑ `>>>` 없는 칼럼0 모양(BLOCKED_BARE_COLUMN0_RE) -- 이미 «칼럼 0»이라는
//      가장 엄격한 형태의 같은 규칙이다(HYK-333 §3-2 요구 4가 정한 경계를
//      이 라운드는 넓히지도 좁히지도 않는다).
// 두 모양은 겹치지 않는다(ⓑ는 `>>>`로 시작하는 줄에 매치하지 않는다) --
// 그래서 합계는 어떤 근접-미스도 두 번 세지 않는다(HYK-333 주석 그대로).
function countNearMissMarkerShapes(resultContent) {
  // 계수 전용 스캔이라 오프셋 보존이 필요 없다 -- 보이지 않는 형식 문자를
  // 먼저 지운다(줄 구조는 그대로: `\n`은 \p{Cf}가 아니다).
  const scan = resultContent.replace(INVISIBLE_FORMAT_CHAR_RE, "");
  let count = 0;
  for (const m of scan.matchAll(BLOCKED_ANYWHERE_RE)) {
    const lineStart = lineStartOffset(scan, m.index);
    if (!PROSE_CHAR_RE.test(scan.slice(lineStart, m.index))) count += 1;
  }
  count += [...scan.matchAll(BLOCKED_BARE_COLUMN0_RE)].length;
  return count;
}
// HYK-325 §2-3 (승격: HYK-418 §2-1): the non-column-0 meta line finalize-
// done.mjs appends right after a `>>> DONE:` line it wrote itself (see that
// file's own FINALIZE_DONE_MARKER_LINE). Absence used to only trigger a
// console warning (warnIfMissingFinalizeDoneMarker, removed by HYK-418 --
// see resolveDoneAt's own HYK-418 §2-1 comment for where this regex is now
// used to fail closed instead).
const DONE_STAMPED_BY_MARKER_RE = /^done_stamped_by:\s*finalize-done\s*$/im;

// HYK-428 §2⑴: `cwd` is optional/back-compat -- callers that omit it (every
// pre-HYK-428 caller) get the exact unchanged process.cwd()-derived
// behavior. Threading an explicit `cwd` (see mainRepoRoot below) is what
// lets the resolved path track the SAME directory an isolation gate already
// validated, instead of an unrelated, ambient process.cwd().
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

// HYK-183 §2 R2: the reject-streak ledger must live in ONE place -- the
// main repo -- no matter which worktree relay-handshake.mjs happens to run
// from (a per-worktree ledger silently reads streak=0 forever, per
// reject-streak.mjs's own module header on the 2026-07-26 실측). Mirrors
// hooks/commit-msg's own worktree -> main-clone resolution idiom rather
// than inventing a new one: resolve this cwd's own toplevel, then ask git
// for `--git-common-dir` (absolute when cwd is a linked worktree, relative
// "`.git`" when cwd already IS the main worktree) and strip the trailing
// "/.git" to land back on the main clone's root.
// HYK-183-ledger-fix (축 B): exported so review-gate.mjs (the commit-msg
// hook's script) can resolve the SAME centralized ledger location when it
// records an approval -- see that module's own header for why the approval
// path needs this at all.
// HYK-428 §2⑴: `startDir` is optional/back-compat (review-gate.mjs's own
// call site below omits it -- a commit-msg hook always runs with
// process.cwd() already equal to the worktree being committed in, so there
// is no separate "checked" directory to align to there). When a caller DOES
// pass `startDir` (autoRecordRejectStreak below), every git call in this
// resolution chain runs anchored at THAT directory, not at this process's
// own ambient cwd -- this is what makes the resolved ledger path track the
// exact same directory isInsideGitWorktree(harnessDir) already validated,
// closing the gap the header comment above (HYK-355 §2-B) describes: before
// this round, mainRepoRoot() ignored harnessDir entirely, so an isolated
// fixture (which legitimately passes isInsideGitWorktree, since it IS some
// git worktree) still resolved to whatever repo this process's cwd
// happened to be in when invoked in-process (coder-task.md §1-1 원문).
export function mainRepoRoot(startDir) {
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

// HYK-355 §2-B: mainRepoRoot() above resolves purely off THIS PROCESS's own
// cwd -- it has no idea which round directory (`harnessDir`) is actually
// being consumed. 2026-08-26 실사고: a worker ran a probe against this
// module's reject-streak recording path without `cd`-ing into an isolated
// fixture first; cwd defaulted to the real repo checkout, mainRepoRoot()
// happily resolved to that real repo's root, and a fabricated entry landed
// in the REAL `.harness/reject-streak.json` (coder-task.md §0/§1, HYK-357
// 칸 1→2). Unlike admission-completion-adapter.mjs (HYK-312's own
// isInsideGitWorktree, duplicated below by the same repo-wide convention --
// see that file's header on why small helpers are copied rather than
// imported; HYK-302/355 §2-A this round assessed importing a shared module
// here too, but relay-handshake.mjs is staged as a mutated/spawned fixture
// copy in ~20 separate test files across scripts/check -- see coder.md's
// §2-A note -- so a new static import here was judged too high-blast-radius
// to verify safely in this round's budget and was reverted; only
// admission-completion-adapter.mjs's and orch-stall-detect.mjs's copies
// were consolidated), autoRecordRejectStreak had ZERO isolation gate at
// all: every call silently trusted mainRepoRoot()'s cwd-derived answer.
// This is the gate that closes exactly that gap -- fail-closed (refuse to
// record, do NOT fall back to any default) whenever `harnessDir` (the round
// directory the caller told us to consume) is missing or does not itself
// resolve inside SOME registered git worktree. A real production round's
// `harnessDir` is always inside a real worktree of this very repo (it IS
// that worktree's own `.harness/`), so this never fires for a legitimate
// consumption -- only for the exact "ran outside an isolated fixture, no
// folder specified" shape the incident took.
// 정직 한계 (mirrors HYK-312's own, coder-task.md §1 원문 그대로): a
// deliberate separate git clone used for an experiment still passes this
// check (it genuinely is inside a worktree) -- this closes the "plain
// filesystem copy / no folder at all" shape the actual incident took, not
// every conceivable isolation escape.
function isInsideGitWorktree(dir) {
  if (!dir || !existsSync(dir)) return false;
  try {
    const out = execSync("git rev-parse --is-inside-work-tree", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}

// Extracted from checkRelayHandshake (quality-check: keeps its own
// complexity under the repo's ESLint ceiling) -- resolves the result
// file's task_id echo into either a match or one of three distinct
// diagnoses for the anchored-miss case (see TASK_ID_ANYWHERE_RE above).
// ⛔HYK-332: exported so finalize-done.mjs can reuse this EXACT
// "what counts as a valid task_id header" contract (coder-task.md §2
// 요구5's "정규식을 새로 짓지 말고 재사용하라") instead of a second copy
// that could silently drift. `kind` is additive (existing callers only
// ever read `.ok`/`.reason`) and lets a caller branch on the failure
// shape (missing/ambiguous/mid-line) without string-matching `.reason`.
export function resolveResultTaskId(resultContent) {
  // HYK-449: 인용된(코드블록·HTML 주석) 줄은 이 문서가 «말한» 것이 아니다.
  const scan = maskQuotedMarkerRegions(resultContent);
  const resultIdMatches = [...scan.matchAll(TASK_ID_RE_G)];
  if (resultIdMatches.length > 1) {
    return {
      ok: false,
      kind: "AMBIGUOUS",
      reason: `result has ${resultIdMatches.length} standalone 'task_id:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve)`,
    };
  }
  if (resultIdMatches.length === 1) {
    return { ok: true, id: resultIdMatches[0][1] };
  }
  if (TASK_ID_ANYWHERE_RE.test(scan)) {
    return {
      ok: false,
      kind: "MID_LINE",
      reason:
        "result task_id echo not at line start (must be a standalone `task_id: <id>` line at column 0, found mid-line)",
    };
  }
  return {
    ok: false,
    kind: "MISSING",
    reason: "result missing task_id echo (need a `task_id: <id>` line)",
  };
}

// Extracted from checkRelayHandshake (keeps its complexity under the
// repo's ESLint ceiling) -- mirrors resolveResultTaskId's shape: resolves
// the result file's '>>> DONE:' line into either a single match or an
// explicit ambiguity/absence reason, never a silently-chosen one.
function resolveResultDoneMatch(resultContent) {
  // HYK-449: 같은 이유로 인용된 `>>> DONE:` 줄은 세지 않는다. 마스킹이
  // 길이를 보존하므로 여기서 돌려주는 매치의 .index 는 «원문» 기준으로
  // 그대로 유효하다(호출자가 judgedRegion 을 그 오프셋으로 자른다).
  const doneMatches = [
    ...maskQuotedMarkerRegions(resultContent).matchAll(DONE_RE),
  ];
  if (doneMatches.length > 1) {
    return {
      ok: false,
      reason: `result has ${doneMatches.length} '>>> DONE:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve)`,
    };
  }
  if (doneMatches.length === 1) {
    return { ok: true, match: doneMatches[0] };
  }
  return {
    ok: false,
    // HYK-173-escalation-1: missing:true marks this specifically as "no
    // DONE line at all" (as opposed to the ambiguous->false branch above)
    // -- checkRelayHandshake uses this flag, not string-matching on
    // `reason`, to decide whether it's worth looking for an explicit
    // BLOCKED/NEEDS_INPUT marker before falling back to plain PENDING.
    missing: true,
    reason: 'result missing ">>> DONE: ... @ <time KST>" line (required)',
  };
}

// HYK-173-escalation-1 (§2 결과파일 상태 확장): resolves the result file's
// explicit "blocked" marker (see BLOCKED_RE above) into one of four
// outcomes -- never silently folded into "still pending". Mirrors
// resolveResultTaskId's ambiguous/malformed/absent three-way split so the
// same fail-closed discipline applies here too.
export const RESULT_BLOCK_STATE = Object.freeze({
  BLOCKED: "BLOCKED",
  NEEDS_INPUT: "NEEDS_INPUT",
  AMBIGUOUS_BLOCKED: "AMBIGUOUS_BLOCKED",
  MALFORMED_BLOCKED: "MALFORMED_BLOCKED",
  NONE: "NONE",
});

function resolveResultBlockedState(resultContent) {
  const matches = [...resultContent.matchAll(BLOCKED_RE)];
  if (matches.length > 1) {
    return {
      state: RESULT_BLOCK_STATE.AMBIGUOUS_BLOCKED,
      reason: `result has ${matches.length} '>>> BLOCKED:'/'>>> NEEDS_INPUT:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve)`,
    };
  }
  // HYK-173-escalation-2 (REVIEW 반려 (2) 수리): the anywhere-count always
  // includes every well-formed match too (BLOCKED_ANYWHERE_RE's pattern is
  // a strict superset of BLOCKED_RE's), so `anywhereCount > matches.length`
  // means there is at least one marker-shaped occurrence beyond the
  // well-formed one(s) already counted above -- a valid line coexisting
  // with a broken one, previously swallowed silently into the single valid
  // match.
  // HYK-442 5R: near-miss counting is LINE-based and never asks whether
  // something is quoted (see countNearMissMarkerShapes' own header for why
  // the quote axis was dropped entirely) -- a marker shape with prose
  // before it on its line is part of that sentence, not an attempt at the
  // marker. The strict `matches` count just above is computed on the
  // ORIGINAL resultContent (unaffected, untouched by this fix).
  const nearMissCount = countNearMissMarkerShapes(resultContent);
  if (matches.length === 1) {
    if (nearMissCount > matches.length) {
      return {
        state: RESULT_BLOCK_STATE.MALFORMED_BLOCKED,
        reason:
          "result has a well-formed '>>> BLOCKED:'/'>>> NEEDS_INPUT:' line AND at least one additional malformed '>>> BLOCKED:'/'>>> NEEDS_INPUT:'-shaped marker -- a valid+broken mix is not silently resolved to the valid one (fail-closed)",
      };
    }
    const kind = matches[0][1].toUpperCase();
    const detail = matches[0][2].trim();
    return { state: kind, detail };
  }
  if (nearMissCount > 0) {
    return {
      state: RESULT_BLOCK_STATE.MALFORMED_BLOCKED,
      reason:
        "result has a '>>> BLOCKED:'/'>>> NEEDS_INPUT:'-shaped marker (or a `>>>`-less column-0 'BLOCKED:'/'NEEDS_INPUT:' near-miss, HYK-333) that doesn't match the required column-0, single-line '>>> BLOCKED: <reason>' / '>>> NEEDS_INPUT: <reason>' form (fail-closed -- not treated as pending)",
    };
  }
  return { state: RESULT_BLOCK_STATE.NONE };
}

// HYK-313 §2: how long the round has gone with no observable change to its
// result file. `now`/`resultMtimeMs` are both caller-supplied (mirrors the
// rest of this file's clock-injection convention, see checkRelayHandshake's
// own `now` header comment) -- a missing/unmeasurable mtime (stat failure,
// isolated fixture with no fs access) returns `null`, never a guessed value
// (resolveMissingDoneOutcome treats `null` as "cannot judge age", falling
// back to the pre-HYK-313 unconditional PENDING -- fail-quiet, not
// fail-stalled, per §4-1's "오탐 0" 비타협).
function computePendingAgeMs(now, resultMtimeMs) {
  if (typeof now !== "number" || !Number.isFinite(now)) return null;
  if (typeof resultMtimeMs !== "number" || !Number.isFinite(resultMtimeMs)) {
    return null;
  }
  const ageMs = now - resultMtimeMs;
  return Number.isFinite(ageMs) ? ageMs : null;
}

// HYK-313 §4-1: threshold picked with a documented margin over the longest
// OBSERVED legitimate round in coder-task.md §0 (26 minutes, real incident on
// 2026-08-19) -- 30 minutes give that round ~15% headroom before this axis
// would ever call it stalled. This is the ONLY place §2's invariant trades
// off false positives against detection latency; a round genuinely still
// writing its result file within the last 30 minutes is never reclassified.
export const PENDING_STALL_THRESHOLD_MS = 30 * 60 * 1000;

// Extracted from checkRelayHandshake (quality-check: keeps its own
// complexity/line-count under the repo's ESLint ceiling) -- called only
// when resolveResultDoneMatch already confirmed genuine absence
// (`resultDone.missing`, i.e. not the separate ambiguous-DONE case above).
// Turns resolveResultBlockedState's 5-way state into the handshake's
// final ok:false return shape for this branch.
//
// HYK-313 §2/§4-2: `age` is the only new parameter -- BLOCKED/NEEDS_INPUT/
// AMBIGUOUS_BLOCKED/MALFORMED_BLOCKED below are all returned byte-identical
// to before this round (§4-2 비타협). Only the trailing `blocked.state ===
// NONE` branch (the actual "PENDING" case) changes: it now distinguishes a
// freshly-written result file (state stays "PENDING", reason unchanged --
// §4-1 오탐 0, byte-identical to pre-HYK-313 for every round under the
// threshold) from one whose mtime has not moved in
// >= PENDING_STALL_THRESHOLD_MS (a NEW `state: "STALLED_PENDING"`, §2's
// "표면화된 신호" -- still `ok:false`, so §4-2's "기존 ok/state 계약을 깨지
// 마라" is read as "don't touch the other four states", not "PENDING itself
// may never gain a new sibling value").
function resolveMissingDoneOutcome(
  resultContent,
  resultDoneReason,
  { now, resultMtimeMs } = {},
) {
  const blocked = resolveResultBlockedState(resultContent);
  if (
    blocked.state === RESULT_BLOCK_STATE.BLOCKED ||
    blocked.state === RESULT_BLOCK_STATE.NEEDS_INPUT
  ) {
    return {
      ok: false,
      state: blocked.state,
      reason: `worker reported ${blocked.state}: ${blocked.detail}`,
    };
  }
  if (
    blocked.state === RESULT_BLOCK_STATE.AMBIGUOUS_BLOCKED ||
    blocked.state === RESULT_BLOCK_STATE.MALFORMED_BLOCKED
  ) {
    return { ok: false, state: blocked.state, reason: blocked.reason };
  }
  // blocked.state === NONE -- genuinely still in progress or genuinely
  // stalled; computePendingAgeMs (not this function) is where that line is
  // decided.
  const ageMs = computePendingAgeMs(now, resultMtimeMs);
  if (ageMs !== null && ageMs >= PENDING_STALL_THRESHOLD_MS) {
    return {
      ok: false,
      state: "STALLED_PENDING",
      reason: `${resultDoneReason} -- result file has not changed in ${Math.round(
        ageMs / 1000,
      )}s (>= ${PENDING_STALL_THRESHOLD_MS / 1000}s stall threshold, HYK-313): worker may have stopped mid-task without a DONE/BLOCKED/NEEDS_INPUT marker (조용한 무한 대기 방지 -- 오탐 방지 근거는 이 함수 바로 위 PENDING_STALL_THRESHOLD_MS 주석 참조)`,
      ageMs,
    };
  }
  // HYK-313 2R (REVIEW 반려 1 수리): fresh PENDING returns EXACTLY the same
  // shape as the pre-HYK-313 parent commit -- `ageMs` is deliberately never
  // attached here (only the STALLED_PENDING branch above carries it, since
  // that is the new state this round introduces). The task's own "기존과
  // byte-identical" contract for fresh PENDING means the object itself, not
  // just its `state`/`reason` string values.
  return { ok: false, state: "PENDING", reason: resultDoneReason };
}

// Extracted from checkRelayHandshake (same ESLint-ceiling reason as its
// siblings above) -- wraps resolveResultDoneMatch's ok:false outcome,
// routing the genuine-absence case through resolveMissingDoneOutcome and
// leaving the ambiguous-DONE case's existing reason untouched.
function resolveResultDoneOutcome(resultContent, resultDone, ageCtx) {
  if (resultDone.missing) {
    return resolveMissingDoneOutcome(resultContent, resultDone.reason, ageCtx);
  }
  return { ok: false, reason: resultDone.reason };
}

// Extracted from checkRelayHandshake (keeps its complexity under the
// repo's ESLint ceiling) -- surfaces recordRejectStreakFromResultText's
// outcome via console.log/console.error rather than swallowing it (§2-1
// R4). Never touched by tests that assert on checkRelayHandshake's return
// value; this is purely the side-effect wiring described at its call site.
// HYK-204: mirrors autoRecordRejectStreak's shape -- surfaces
// archiveRoundEnvelope's outcome via console.log/console.error rather than
// swallowing it, and never touches this function's own return value.
// HYK-244 2R-a 조각2: return value added (was void) so the receipt-writing
// call site below can know whether this effect actually succeeded --
// logging alone (the pre-existing behavior, kept unchanged above) is
// invisible to a caller that needs a boolean. checkRelayHandshake's OWN
// return value/exit code contract is untouched (§3 금지) -- this return
// value is new surface, not a repurposing of an existing one.
function autoArchiveRoundEnvelope({ role, resultContent, harnessDir }) {
  const outcome = archiveRoundEnvelope({ role, resultContent, harnessDir });
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
  return outcome.ok;
}

// HYK-241 §2 조각1: archiveRoundEnvelope의 TASK-file 쌍 -- 이 함수가 불리는
// 시점(checkRelayHandshake의 ok:true 분기, 바로 아래)은 이 라운드의 task
// 파일(`<role>-task.md`)이 «다음 라운드가 그 자리를 덮어쓰기 전」 마지막
// 순간이다. §3-3 요건 1의 합격 기준(실패도 한 줄로 보이게)을 그대로
// 만족시키기 위해 autoArchiveRoundEnvelope와 동일하게 성공/실패 모두
// console.log/console.error로 찍는다 -- 조용히 사라지는 실패를 만들지 않는다.
// HYK-307-order-1 §1: archiveRoundTaskFileIfNew instead of the plain
// archiveRoundTaskFile this call used before -- dispatch-gate-decision.mjs
// now ALSO snapshots this same round's task-file text at delivery time
// (before this handshake-time call ever runs, see that file's own
// bestEffortSnapshotRoundTaskFile comment). In the normal ordered flow
// (deliver -> consume, §3 시험 ⓓ) the content here is byte-identical to
// that earlier snapshot, so archiveRoundTaskFile's own next-round-number
// logic would otherwise write a second, redundant copy every single
// round. archiveRoundTaskFileIfNew skips that duplicate (ok:true,
// skipped:true) while still delegating unchanged to archiveRoundTaskFile
// whenever no identical snapshot exists yet (e.g. this axis's own zero-
// import safety net if the new delivery-time hook ever fails/is
// bypassed) -- outcome.ok stays the same true/false either way, so this
// function's own success/failure contract to its caller is unchanged.
function autoArchiveRoundTaskFile({ role, taskContent, harnessDir }) {
  const outcome = archiveRoundTaskFileIfNew({ role, taskContent, harnessDir });
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
  return outcome.ok;
}

// HYK-244 2R-a 조각2: now returns `{ attempted, ok }` (was void) for the
// same reason as autoArchiveRoundEnvelope above -- REVIEW 계열의
// `ledgerRecorded` 효과를 판단하려면 이 결과가 필요하다. Non-REVIEW roles
// have `attempted:false`, which the receipt-writing call site below reads
// as "이 효과는 이 역할에 해당하지 않는다" (never treated as a failure).
// HYK-262: also carries `reason` through (was discarded after logging) so
// the caller can distinguish WHICH kind of `attempted:true, ok:false`
// this is -- see checkRelayHandshake's own use of it, right below.
// HYK-355 §2-B: `harnessDir` is now required to reach the mainRepoRoot()
// default -- see isInsideGitWorktree's own header for the incident this
// closes. Checked only for REVIEW-family roles (isReviewFamilyRole), the
// same set recordRejectStreakFromResultText itself would otherwise attempt
// for -- a non-REVIEW role keeps the exact pre-existing `{attempted:false}`
// no-op shape (recordRejectStreakFromResultText's own early return), never
// reaching this new gate at all.
function autoRecordRejectStreak({ role, resultContent, harnessDir }) {
  if (isReviewFamilyRole(role) && !isInsideGitWorktree(harnessDir)) {
    const blocked = {
      attempted: false,
      blocked: true,
      reasonCode: "UNISOLATED_HARNESS_DIR",
      reason: `reject-streak auto-record: refusing mainRepoRoot() default -- harnessDir '${harnessDir}' is not inside a registered git worktree (probe/experiment consumption context without an isolated ledger path) -- see HYK-355`,
    };
    console.error(blocked.reason);
    return blocked;
  }
  // HYK-428 §2⑴: anchor at `harnessDir` (the exact directory the gate above
  // just validated with isInsideGitWorktree), not the bare no-arg
  // mainRepoRoot() this line used before -- that old call resolved off this
  // PROCESS's own ambient cwd, a value completely decoupled from
  // harnessDir, which is how the gate above could pass (harnessDir
  // genuinely is some git worktree, e.g. an isolated fixture's own
  // `git init`) while the write still landed in whatever repo the caller's
  // cwd happened to be -- see mainRepoRoot's own header for the closed gap.
  // HYK-428: wrapped in try/catch (was bare) -- once the gate above passes,
  // mainRepoRoot(harnessDir) can still resolve to a directory whose
  // `.harness/` subdir does not exist (harnessDir is `isInsideGitWorktree`
  // but git itself failed to resolve a common-dir for some other reason),
  // and writeLedger has no parent-directory guard of its own -- this must
  // degrade to a logged, visible failure (mirrors every other side-effect
  // in this file, e.g. autoArchiveRoundEnvelope's own try/catch boundary),
  // never an uncaught crash that takes the whole handshake process down.
  let autoRecord;
  try {
    autoRecord = recordRejectStreakFromResultText({
      role,
      resultText: resultContent,
      ledgerPath: join(
        mainRepoRoot(harnessDir),
        ".harness",
        "reject-streak.json",
      ),
    });
  } catch (err) {
    const reason = `reject-streak auto-record: ledger write failed unexpectedly (${err.message}) -- ledger NOT updated, round completion not blocked`;
    console.error(reason);
    return {
      attempted: true,
      ok: false,
      reasonCode: "LEDGER_WRITE_ERROR",
      reason,
    };
  }
  if (!autoRecord.attempted) return { attempted: false, ok: false };
  if (autoRecord.ok) {
    console.log(autoRecord.reason);
  } else {
    console.error(autoRecord.reason);
  }
  return {
    attempted: true,
    ok: autoRecord.ok,
    reason: autoRecord.reason,
    reasonCode: autoRecord.reasonCode,
  };
}

// Extracted from checkRelayHandshake (quality-check: keeps its own
// complexity/line-count under the repo's ESLint ceiling) -- HYK-262 §3-1/
// §3-2: ⛔only the AMBIGUOUS-count 표지 줄 계약 violation (`for:`/`task_id:`/
// 판정 줄이 2개 이상이라 «어느 것이 최종인지 결정할 수 없다» --
// reject-streak.mjs:180-185/191/214 원문, all three share this exact
// phrase) rejects consumption. Every OTHER attempted-but-failed shape (no
// verdict line at all, a corrupt/unreadable ledger file) is a pre-existing,
// already-tested "still ok:true, still logs UNJUDGABLE" shape this task's
// scope does NOT touch (§4 완료조건 2: 정상 라운드 회귀 0). Returns null
// when this round is not blocked (the normal case), or the ok:false
// verdict to return immediately otherwise.
// HYK-262 §2 (책임자 확정 2R): the block used to be decided by regex-
// matching the Korean sentence 어느 것이 최종인지 결정할 수 없다 against
// `reason` -- 1R 검토 실측: rewording that sentence by one character
// silently killed the block. This set is the stable, never-reworded
// coupling value instead -- membership check against reject-streak.mjs's
// own REJECT_STREAK_REASON_CODE enum (imported, not re-declared), so the
// two files can never drift out of sync on what "ambiguous cover line"
// means. `reason` (the Korean sentence) is still carried through into this
// function's own return reason below for human readers -- it is read-only
// here now, never matched.
const AMBIGUOUS_COVER_REASON_CODES = new Set([
  REJECT_STREAK_REASON_CODE.AMBIGUOUS_FOR_LINE,
  REJECT_STREAK_REASON_CODE.AMBIGUOUS_TASK_ID_LINE,
  REJECT_STREAK_REASON_CODE.AMBIGUOUS_VERDICT_LINE,
]);

function checkAmbiguousCoverViolation(recordOutcome) {
  const isAmbiguous =
    recordOutcome.attempted &&
    !recordOutcome.ok &&
    AMBIGUOUS_COVER_REASON_CODES.has(recordOutcome.reasonCode);
  if (!isAmbiguous) return null;
  return {
    ok: false,
    reason: `consumption rejected (HYK-262): REVIEW-family result file violates the 표지 줄 계약 (for:/task_id:/판정 줄이 2개 이상 -- ${recordOutcome.reason}) -- envelope/task archiving and consumption receipt are skipped for this round (표지 줄을 고쳐 다시 완료해야 한다)`,
  };
}

// HYK-357-352 2R §1 (P1-1 수리): a SECOND, DISTINCT gate from the
// AMBIGUOUS-count violation above. 1R added `FOR_LINE_ISSUE_ID_UNPARSEABLE`
// (reject-streak.mjs) for a 'for:' line whose VALUE doesn't start with
// HYK-<digits> (e.g. 'for: ORCH') but never wired it into any consumption
// block -- the reasonCode existed, nothing consumed it, so the 2026-08-25
// 실사고 shape (`for: ORCH` + a valid `task_id:`) still passed consumption
// silently with the rejected verdict never reaching the ledger (검토 1R 급소
// 1). ⛔This is kept as its OWN Set/function (not folded into
// AMBIGUOUS_COVER_REASON_CODES/checkAmbiguousCoverViolation) precisely
// because 검토 1R flagged that reusing that block's "표지 줄이 2개 이상"
// wording here would misdescribe the cause: this is a VALUE violation
// (one cover line, wrong content), not a COUNT violation (too many cover
// lines). Currently the sole member is FOR_LINE_ISSUE_ID_UNPARSEABLE -- the
// plain ISSUE_ID_UNPARSEABLE branch (task_id:-sourced, 'for:' line absent)
// is deliberately NOT added here; that shape is unchanged, pre-existing,
// out-of-scope behavior (HYK-266 여지, 이 조각의 §1이 명시한 대상은 오직
// 'for:'가 원인인 갈래다).
const VALUE_INVALID_COVER_REASON_CODES = new Set([
  REJECT_STREAK_REASON_CODE.FOR_LINE_ISSUE_ID_UNPARSEABLE,
]);

function checkValueInvalidCoverViolation(recordOutcome) {
  const isValueInvalid =
    recordOutcome.attempted &&
    !recordOutcome.ok &&
    VALUE_INVALID_COVER_REASON_CODES.has(recordOutcome.reasonCode);
  if (!isValueInvalid) return null;
  // coder-task.md §1-3: a block must not be a dead end -- `recordOutcome.reason`
  // already carries the 1R diagnostic (which line was at fault, and whether
  // 'task_id:' was itself fine, verbatim including its value) built by
  // reject-streak.mjs's buildForLineUnparseableOutcome; carried through
  // here unmodified so the fix-it detail is not re-derived or paraphrased.
  return {
    ok: false,
    reason: `consumption rejected (HYK-357): REVIEW-family result file's 'for:' line fails the value spec (must be a CODER round's harness task_id, HYK-<digits>-..., not a role/person name -- ${recordOutcome.reason}) -- envelope/task archiving and consumption receipt are skipped for this round ('for:' 줄을 판정 대상 CODER 라운드의 harness task_id로 고쳐 다시 완료해야 한다)`,
  };
}

// HYK-262 §3 (책임자 확정 2R): the two shapes that reach `attempted:true,
// ok:false` WITHOUT being an ambiguous-cover-line violation (checked above)
// -- e.g. 판정 줄 0개(NO_VERDICT_LINE) or 원장 파일 손상(LEDGER_READ_FAILED/
// LEDGER_INVALID_JSON/LEDGER_INVALID_SHAPE) -- are deliberately NOT blocked
// this round (HYK-266 범위, 착수 금지). But §3의 근거 문장("관측·기록이
// 실패했으면 그 사실이 다음 단계의 「진행 가능 여부」에 반영되어야 한다 --
// 화면 출력만으로는 「반영」이 아니다")은 여전히 지켜야 하므로, 최소한
// «이 경우는 차단하지 않았다»는 사실 자체를 명시적으로 남긴다 -- 기존
// autoRecordRejectStreak의 console.error 한 줄(레코딩 실패 그 자체)과는
// 별개로, «그리고 이건 차단 안 했다»는 판단을 새로 찍는다.
function traceUnblockedRecordFailure(recordOutcome) {
  if (!recordOutcome.attempted || recordOutcome.ok) return;
  const reasonCode = recordOutcome.reasonCode ?? "UNKNOWN_REASON_CODE";
  console.log(
    `relay-handshake: NOT_BLOCKED (HYK-262 §3) -- reject-streak record failed with reasonCode=${reasonCode} but this round is NOT blocked (${recordOutcome.reason}) -- consumption/archiving/receipt proceed normally; HYK-266 (별건) decides whether this reasonCode class should block in future`,
  );
}

// ⛔HYK-324/HYK-325 r2 (REVIEW 반려 P1 수리): exported so finalize-done.mjs
// can reuse this exact parse -- same reason DONE_RE/hasDoneSecondsPrecision
// are exported above. Before this export, finalize-done.mjs's own
// "malformed, eligible for one-time replace" test only checked
// hasDoneSecondsPrecision, never whether the value actually parses --
// so a DONE line with an out-of-range date but seconds-shaped text (e.g.
// '2026-99-99 23:19:01 KST') was "not parseable" here (first observation
// skipped, "can be replaced" told to the caller) but NOT malformed there
// (ALREADY_FINALIZED refused) -- the exact split 검토자가 실측한 것.
export function parseKstTimestamp(str) {
  if (typeof str !== "string") return null;
  const cleaned = str.trim().replace(/\s*KST\s*$/i, "");
  const match = cleaned.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/,
  );
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}+09:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// HYK-324/HYK-325 r2: the ONE place "형식 유효" (format-valid DONE
// timestamp) is defined -- "파싱 가능 + 초 단위", exactly what resolveDoneAt
// below gates on (see its two checks just below this function's call
// sites). finalize-done.mjs's malformedSingle reuses this directly instead
// of re-deriving the same two conditions with its own (previously
// incomplete) copy -- coder-task.md r2 §2-1's explicit "한 곳에서만
// 정의하고 양쪽이 재사용하라".
export function isWellFormedDoneTimestamp(rawText) {
  return (
    parseKstTimestamp(rawText) !== null && hasDoneSecondsPrecision(rawText)
  );
}

// HYK-186 §2 완료조건2: `now` is the ONLY caller-injectable clock in this
// function, and it exists purely for test determinism (mirroring
// pull-admission.mjs's `nowMs` convention) -- the production CLI entry point
// at the bottom of this file never passes it, so every real invocation uses
// the machine clock. This is what "production `now`는 caller 자기신고가
// 아니어야 한다" means in practice: the *candidate* timestamps (dropped_at,
// DONE) are caller-supplied (they come from files workers/ORCH write), but
// the *authority clock* they are judged against is not.
// HYK-257 ⓒ: producer 도구 이름을 필드별로 하나로 고정한다 -- 거부 사유에
// "고치는 법"을 붙일 때마다 매번 다시 조립하지 않도록.
function fixToolHintFor(field) {
  return field === TIME_FIELD.TASK_DROPPED_AT
    ? "node scripts/relay/stamp-dropped-at.mjs (아직 미결선 -- coder-task.md §2 ⓐ 참조)"
    : "node scripts/relay/finalize-done.mjs <role>";
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// dropped_at은 분 단위(초 없음), DONE은 초 단위(HYK-244) -- rawText에 초가
// 있는지로 보정값의 정밀도를 맞춘다(원래 값 형식을 그대로 흉내낸다).
function formatKstLike(ms, rawText) {
  const kst = new Date(ms + KST_OFFSET_MS);
  const base = `${kst.getUTCFullYear()}-${pad2(kst.getUTCMonth() + 1)}-${pad2(
    kst.getUTCDate(),
  )} ${pad2(kst.getUTCHours())}:${pad2(kst.getUTCMinutes())}`;
  const hasSeconds = /\d{2}:\d{2}:\d{2}/.test(rawText);
  return hasSeconds
    ? `${base}:${pad2(kst.getUTCSeconds())} KST`
    : `${base} KST`;
}

// HYK-257 (★새 변종): a value off by ~exactly 9 hours from authority now is
// far more likely a UTC/KST mislabel than a genuine future or genuine
// staleness -- see time-authority.mjs's isSuspectedTimezoneMislabel header
// for why this is a heuristic, not a proof. Checked BEFORE checkFutureSkew
// so a +9h mislabel gets this more specific, correctable diagnosis instead
// of the generic future-skew message.
function checkTimezoneMislabel({ candidateDate, rawText, field, now }) {
  const candidateMs = candidateDate.getTime();
  if (!isSuspectedTimezoneMislabel(candidateMs, now)) return null;
  const state =
    field === TIME_FIELD.TASK_DROPPED_AT
      ? TIME_AUTHORITY_STATE.SUSPECTED_TZ_MISLABEL_DROPPED_AT
      : TIME_AUTHORITY_STATE.SUSPECTED_TZ_MISLABEL_DONE;
  const isAheadOfNow = candidateMs > now;
  const correctedMs = isAheadOfNow
    ? candidateMs - KST_OFFSET_MS
    : candidateMs + KST_OFFSET_MS;
  const corrected = formatKstLike(correctedMs, rawText);
  return {
    ok: false,
    state,
    reason: `'${field}' value '${rawText.trim()}' is suspiciously close to exactly 9 hours ${
      isAheadOfNow ? "ahead of" : "behind"
    } authority now (${new Date(now).toISOString()}) -- looks like a UTC value mislabeled 'KST' (or vice versa), not a genuine ${isAheadOfNow ? "future" : "stale"} value. 고치는 법: 손으로 9시간을 더하거나 빼지 말고 시계를 다시 읽어라 -- 아마 '${corrected}'를 의도했을 것이다. 앞으로는 ${fixToolHintFor(field)} 로 찍어라(손기입 금지).`,
  };
}

function checkFutureSkew({ candidateDate, rawText, field, now }) {
  const beyond = isBeyondFutureSkew(candidateDate.getTime(), now, field);
  if (beyond === false) return null;
  const skewMs = candidateDate.getTime() - now;
  const state =
    field === TIME_FIELD.TASK_DROPPED_AT
      ? TIME_AUTHORITY_STATE.FUTURE_DROPPED_AT
      : TIME_AUTHORITY_STATE.FUTURE_DONE;
  const reason =
    beyond === null
      ? `time-authority registry has no row for '${field}' -- fail-closed, treating '${rawText.trim()}' as a future violation`
      : `'${field}' value '${rawText.trim()}' is ${Math.round(
          skewMs / 1000,
        )}s ahead of authority now (${new Date(now).toISOString()}), which exceeds the allowed skew of ${MAX_FUTURE_SKEW_MS}ms. 고치는 법: 시계를 다시 읽어 지금(now)에 가까운 값으로 고쳐라(미리 적지 마라) -- 앞으로는 ${fixToolHintFor(field)} 로 찍어라.`;
  return { ok: false, state, reason };
}

// Extracted from checkRelayHandshake (quality-check: keeps its own
// complexity/line-count under the repo's ESLint ceiling) -- resolves the
// task file's dropped_at header into a parsed Date, applying the HYK-186
// future-skew check as part of that resolution (a dropped_at that projects
// into the future is a config-shape problem, independent of whether a
// result exists yet at all).
function resolveDroppedAt(taskContent, now) {
  const droppedMatch = taskContent.match(DROPPED_AT_RE);
  if (!droppedMatch) {
    return {
      ok: false,
      reason:
        "task file missing dropped_at header (required for staleness check)",
    };
  }
  const droppedAt = parseKstTimestamp(droppedMatch[1]);
  if (!droppedAt) {
    return {
      ok: false,
      reason: `task dropped_at not parseable: '${droppedMatch[1].trim()}' (need YYYY-MM-DD HH:MM KST format, e.g. '2026-08-17 05:22 KST' -- 앞으로는 ${fixToolHintFor(TIME_FIELD.TASK_DROPPED_AT)} 로 찍어라)`,
    };
  }
  const droppedMislabel = checkTimezoneMislabel({
    candidateDate: droppedAt,
    rawText: droppedMatch[1],
    field: TIME_FIELD.TASK_DROPPED_AT,
    now,
  });
  if (droppedMislabel) return droppedMislabel;
  const droppedFuture = checkFutureSkew({
    candidateDate: droppedAt,
    rawText: droppedMatch[1],
    field: TIME_FIELD.TASK_DROPPED_AT,
    now,
  });
  if (droppedFuture) return droppedFuture;
  return { ok: true, droppedAt, droppedMatch };
}

// HYK-244 2R-a §1/§2 조각1: 저장소가 «분 단위»를 시켰다(templates/
// harness-init/status.template.md의 예전 `>>> DONE: <role> @ <YYYY-MM-DD
// HH:MM>`)는 것이 실측된 뿌리 원인이고, 소비 절차(여기)는 그 형식을 전혀
// 검사하지 않았다(예전 `DONE_RE`는 `.+?`로 뒤 텍스트 전체를 그냥 받았다).
// 한용 확정 문면(coder-task.md §0, 2026-08-14 07:10, 조정 금지) = "«분
// 단위 거부» 문면은 약화 없이 유지" -- «시키는 곳»(템플릿)과 «검사하는
// 곳»(여기) 둘 다 손봐야 실제로 초 단위가 남는다.
//
// 왜 doneAt이 성공적으로 파싱된 «뒤에만» 이 검사를 거는가: `parseKstTimestamp`
// 는 여전히 `HH:MM(:SS)?`(초 선택)를 그대로 받아들인다(HYK-142 6A가 얼린
// 계약, time-authority.mjs 참조) -- 이 함수를 고치면 "형식이 아예 깨진
// 값"(예: `@ soon`)의 기존 "not parseable" 판정까지 건드리게 된다. 대신
// «값은 유효한 KST 시각으로 파싱됐지만 초가 없다»는 경우만 새로 거부하는
// 것이 이번 조각의 정확한 범위다 -- 그래서 파싱 성공 직후, future-skew
// 검사보다 먼저 이 확인을 끼워 넣는다(사유 문자열이 겹치지 않게).
// HYK-244 2R-a: minute-precision timestamps can't distinguish two rounds
// completed in the same minute -- seconds are required, not optional.
// ⛔HYK-324/HYK-325: exported so finalize-done.mjs can reuse this exact
// criterion (see DONE_RE's own export comment above -- same reason).
const DONE_SECONDS_PRECISION_RE = /\d{2}:\d{2}:\d{2}/;

export function hasDoneSecondsPrecision(rawDoneAtText) {
  return DONE_SECONDS_PRECISION_RE.test(rawDoneAtText);
}

// Extracted from checkRelayHandshake (same ESLint-ceiling reason as
// resolveDroppedAt above) -- resolves the result file's '>>> DONE:' line
// into a parsed Date, applying the HYK-244 seconds-precision check and the
// HYK-186 future-skew check as part of that resolution. ★PM 실측 재현
// 대상: before the HYK-186 fix, a DONE line dated 2099-01-01 passed
// silently ({"ok":true, reason:"relay handshake ok for FUTURE-1"}) --
// checkRelayHandshake had exactly one time comparison (`doneAt <
// droppedAt`) and zero comparisons against `now`. That fix rejects a DONE
// timestamp beyond authority-clock skew before it can ever reach the
// staleness/ok:true path in checkRelayHandshake; this HYK-244 addition
// rejects a DONE timestamp that lacks seconds precision, for the same
// "reject loudly before the ok:true path" reason.
// HYK-257-done-stamp-2 §2 범위1: called the MOMENT a well-formed '>>> DONE:'
// line is found -- before the mislabel/future-skew validity checks below,
// and on EVERY call (watch-result.mjs's watchResult polls checkRelayHandshake
// repeatedly, see first-observation.mjs's own header for the real production
// caller this closes the race against). Best-effort, non-fatal: a spawn
// failure here must never block or alter checkRelayHandshake's own verdict
// on its own (mirrors spawnAdmissionCompletion's house style exactly) --
// treated as "no observation available" (rewritten:false), not as a reject.
//
// HYK-324 §2-2: "well-formed" now specifically means format-valid (parses
// AND has seconds precision) -- see resolveDoneAt's call site below. This
// function itself does not decide that; it only records whatever it is
// asked to observe. A format-invalid DONE line is filtered out BEFORE
// reaching this call (never observed at all) because it can never be
// consumed anyway (checkRelayHandshake's own format checks reject it), so
// pinning it as "first observed" would only block finalize-done's one-time
// malformed-replace recovery path (HYK-324/HYK-325) without protecting
// anything -- the HYK-257 race this function guards against is about a
// FORMAT-VALID value being rewritten mid-flight, which is unaffected by
// this change (see resolveDoneAt).
//
// HYK-257-done-stamp-3 §2 범위1 (2R 반려 수리): `taskId`/`droppedAt`은
// 이제 별도 필드로 넘어간다 -- 2R처럼 `${taskId}::${droppedAt}`로 이어붙인
// 문자열 하나를 이 함수의 `taskId` 매개변수 자리에 밀어넣지 않는다(그
// 이어붙이기가 2R 반려 사유였다: 레코드에 진짜 dropped_at 필드가 없었고,
// 분-정밀도 충돌 시 같은 문자열 키가 서로 다른 라운드를 오염시켰다).
function spawnObserveDoneLine({
  taskId,
  droppedAt,
  role,
  harnessDir,
  resultContent,
  doneLineRaw,
}) {
  lastFirstObservationDetail = null;
  try {
    const scriptPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "first-observation.mjs",
    );
    const payload = JSON.stringify({
      taskId,
      droppedAt,
      role,
      resultContent,
      doneLineRaw,
    });
    // HYK-353: payload used to ride argv (`[scriptPath, harnessDir,
    // payload]`) -- a large `resultContent` (the full result file text)
    // blew past the OS command-line length limit (Windows ENAMETOOLONG),
    // silently dropping this round's first-observation entry (the round
    // still completed with exit 0, see spawnMarkObservationConsumed and
    // exitDistinctlyOnFirstObservationFailure below for how that silence is
    // now closed). Passing it via stdin (`input`) makes this channel
    // size-independent -- argv only ever carries the small, fixed
    // `harnessDir` path now.
    const out = execFileSync("node", [scriptPath, harnessDir], {
      input: payload,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out.trim());
    // HYK-353 2R §1 (P1-1, 검토 반려): the child can exit 0 with a
    // WELL-FORMED JSON payload while the actual log write inside it still
    // failed (e.g. the observation log's path is a directory --
    // `appendFileSync` throws, `recordFirstDoneObservation` catches its own
    // error and returns `{recorded:false, reason:"record failed: ..."}`,
    // and the pre-2R code here never looked at that field at all). Only
    // `reason` starting with `"record failed:"` counts as a genuine write
    // failure -- `reason === "already observed"` is the normal, expected
    // shape on a round's 2nd+ poll (recordFirstDoneObservation intentionally
    // no-ops once a generation already has an entry) and must stay
    // `ok:true`.
    const recordFailed =
      parsed?.record?.recorded === false &&
      typeof parsed.record.reason === "string" &&
      parsed.record.reason.startsWith("record failed:");
    if (recordFailed) {
      console.error(
        `relay-handshake: first-observation recording FAILED even though the child process exited cleanly (HYK-353 2R §1): ${parsed.record.reason}`,
      );
      lastFirstObservationDetail = {
        attempted: true,
        ok: false,
        reason: parsed.record.reason,
      };
    } else {
      lastFirstObservationDetail = { attempted: true, ok: true };
    }
    return parsed;
  } catch (err) {
    const detail = err.stderr ?? err.message;
    console.error(
      `relay-handshake: first-observation spawn skipped/failed (non-fatal, treated as no-observation -- HYK-257-done-stamp-2 §2 범위1): ${detail}`,
    );
    // HYK-353 (mirrors spawnAdmissionCompletionProcess's own `stderrText.
    // includes("admission-completion-adapter: ")` split, same file, right
    // above): `err.status`/exit code alone cannot tell "first-observation.mjs
    // actually ran and failed on its own" apart from "the script file itself
    // is simply absent in this context" (isolated mutation-test fixtures
    // that clone only a fixed dependency list, see this file's own header
    // comment on that -- both shapes share Node's generic module-resolution
    // exit code). first-observation.mjs's own error paths (usage guard,
    // payload-JSON-not-parseable, the new stdin-read failure) all print a
    // stable `"first-observation: "`-prefixed line; Node's own "Cannot find
    // module" text never does. Only the former counts as a genuine attempt.
    const stderrText = String(err.stderr ?? "");
    lastFirstObservationDetail = {
      attempted: stderrText.includes("first-observation: "),
      ok: false,
      reason: detail,
    };
    return { rewritten: false, error: "spawn failed" };
  }
}

// HYK-257-done-stamp-3 §2 범위1 (로그 수명): called exactly once, at the
// moment checkRelayHandshake has confirmed this round is fully COMPLETE
// (every check above -- handshake, dropped_at/DONE parsing, mislabel,
// future-skew, staleness, intermediate-rewrite -- has already passed).
// Marks this (taskId, droppedAt) generation as consumed in the
// first-observation log so a LATER round that happens to reuse the same
// key (2R's missed 분-정밀도 충돌 시나리오) starts a clean new generation
// instead of being compared against this already-judged round's value.
// Best-effort, non-fatal -- mirrors spawnObserveDoneLine's own house style
// exactly: a failure here must never change checkRelayHandshake's own
// verdict (the round is already judged complete by this point regardless).
function spawnMarkObservationConsumed({ taskId, droppedAt, role, harnessDir }) {
  try {
    const scriptPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "first-observation.mjs",
    );
    const payload = JSON.stringify({
      taskId,
      droppedAt,
      role,
      action: "markConsumed",
    });
    // HYK-353: same stdin transport as spawnObserveDoneLine above (this
    // payload is always small -- no resultContent -- but kept consistent so
    // the two spawn call sites share one CLI contract, see first-
    // observation.mjs's own CLI entry point).
    const out = execFileSync("node", [scriptPath, harnessDir], {
      input: payload,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(out.trim());
  } catch (err) {
    console.error(
      `relay-handshake: first-observation mark-consumed spawn skipped/failed (non-fatal -- HYK-257-done-stamp-3 §2 범위1): ${err.stderr ?? err.message}`,
    );
    return { recorded: false, reason: "spawn failed" };
  }
}

function resolveDoneAt(
  resultContent,
  now,
  { taskId, droppedAtRaw, role, harnessDir, resultMtimeMs } = {},
) {
  const resultDone = resolveResultDoneMatch(resultContent);
  if (!resultDone.ok) {
    // HYK-173-escalation-1 (§2): only the genuine-absence case (no
    // '>>> DONE:' line anywhere -- `missing`) is eligible to be
    // reclassified as an explicit BLOCKED/NEEDS_INPUT state. The
    // ambiguous-DONE case above keeps its existing reason/behavior
    // untouched (regression 0 on the `>>> DONE:` path).
    // HYK-313: `{ now, resultMtimeMs }` only ever reaches
    // resolveMissingDoneOutcome (via resolveResultDoneOutcome) -- the
    // ambiguous-DONE branch inside resolveResultDoneOutcome ignores this
    // 3rd argument entirely, so its own reason/behavior is untouched.
    return resolveResultDoneOutcome(resultContent, resultDone, {
      now,
      resultMtimeMs,
    });
  }
  const doneMatch = resultDone.match;

  // HYK-324 §2-2: format validity (parseable AND seconds-precision) is now
  // checked FIRST, before the first-observation spawn below. A format-
  // invalid DONE line can never be consumed regardless (checkRelayHandshake
  // rejects it here, every time), so recording it as "first observed" would
  // only block finalize-done's one-time malformed-replace recovery path,
  // not protect anything -- see spawnObserveDoneLine's own header for why
  // this is safe. When the format check fails, first observation is
  // skipped entirely (never spawned) and the reason is surfaced on stderr
  // so an operator watching the log sees why no observation was recorded.
  const doneAt = parseKstTimestamp(doneMatch[1]);
  if (!doneAt) {
    console.error(
      `relay-handshake: first-observation skipped: DONE line malformed (not parseable: '${doneMatch[1].trim()}') -- finalize-done 으로 1회 교체할 수 있다`,
    );
    return {
      ok: false,
      reason: `result DONE timestamp not parseable: '${doneMatch[1].trim()}' (need 'YYYY-MM-DD HH:MM:SS KST' format, e.g. '2026-08-17 05:22:47 KST' -- 앞으로는 ${fixToolHintFor(TIME_FIELD.RESULT_DONE_AT)} 로 찍어라)`,
    };
  }
  if (!hasDoneSecondsPrecision(doneMatch[1])) {
    console.error(
      `relay-handshake: first-observation skipped: DONE line malformed (minute-precision, seconds required: '${doneMatch[1].trim()}') -- finalize-done 으로 1회 교체할 수 있다`,
    );
    return {
      ok: false,
      reason: `result DONE timestamp is minute-precision, seconds required: '${doneMatch[1].trim()}' (need YYYY-MM-DD HH:MM:SS KST -- HYK-244 2R-a: minute precision cannot distinguish same-minute rounds, and the "분 단위 거부" contract is fixed, not relaxable. 앞으로는 ${fixToolHintFor(TIME_FIELD.RESULT_DONE_AT)} 로 찍어라)`,
    };
  }

  // HYK-418 §2-1 (승격: 경고 -> fail-closed 거부): same axis, same position,
  // same early-return-before-spawnObserveDoneLine technique as the two
  // format-validity checks directly above -- NOT a new post-observation
  // gate (coder-task.md §2-2's "새 축을 만들지 말고 그 축을 재사용하라").
  // A format-VALID '>>> DONE:' line with no `done_stamped_by: finalize-
  // done` marker anywhere in the file is very likely hand-typed (HYK-325's
  // own diagnosis, formerly only a console warning via
  // warnIfMissingFinalizeDoneMarker -- see that function's now-updated
  // header). Being positioned here, before spawnObserveDoneLine, means
  // first-observation is never recorded for a value this function is about
  // to reject anyway (완료조건2 -- 첫 관측을 박지 않는다), the exact same
  // guarantee the two checks above already provide for malformed/minute-
  // precision values. The reason string below names the literal recovery
  // command (finalize-done.mjs's REPLACED_UNMARKED path, HYK-418 §2-3) so
  // this rejection is not a dead end.
  if (!DONE_STAMPED_BY_MARKER_RE.test(resultContent)) {
    console.error(
      `relay-handshake: first-observation skipped: DONE line has no finalize-done marker (likely hand-typed, HYK-325) -- 복구: node scripts/relay/finalize-done.mjs ${role}`,
    );
    return {
      ok: false,
      reason: `result '>>> DONE:' line has no 'done_stamped_by: finalize-done' marker -- likely hand-typed (HYK-325), not accepted. Recovery: node scripts/relay/finalize-done.mjs ${role}`,
    };
  }

  // HYK-257-done-stamp-2 §2 범위1: record-then-compare happens here, BEFORE
  // mislabel/future-skew rejection can short-circuit -- an intermediate
  // rewrite (§2 범위1 실사례) must be observed even on a poll whose OWN
  // value would independently fail one of those checks (the real
  // incidents' first-observed value was itself a future/bad stamp, later
  // self-corrected). The reject decision on `observation.rewritten` is
  // only ACTED on at the final judged-ok:true moment in
  // checkRelayHandshake -- see that function's own use of this field.
  // HYK-324 §2-2: this call site moved BELOW the format-validity checks
  // above (was above them before this change) -- see this function's
  // header comment for why that reordering is safe (HYK-257's protection
  // is unaffected: it is about a format-VALID value rewritten mid-flight).
  //
  // HYK-257-done-stamp-3 §2 범위1 (2R 반려 수리): (taskId, droppedAt)을
  // 별도 필드로 first-observation.mjs에 넘긴다 -- 2R처럼 이어붙인 문자열
  // 하나를 taskId 자리에 밀어넣지 않는다. 이 저장소는 같은 task_id를
  // 여러 라운드에 걸쳐 재사용한다(ORCH가 다음 라운드 task 파일을 같은
  // taskId로 다시 덮어쓰는 것이 정상 -- HYK-241의 존재 이유 자체가 그
  // 덮어쓰기), 그래서 (taskId, droppedAt) 둘 다로 라운드를 구별해야
  // 한다. dropped_at은 «분» 정밀도뿐이라(DROPPED_AT_FORMAT_RE) 같은 분
  // 안의 연속 두 라운드는 이 쌍이 우연히 같아질 수 있다 -- 그 충돌은
  // first-observation.mjs의 소비-시(consumed) tombstone 수명 관리가
  // 닫는다(그 파일 자신의 findFirstObservation 헤더 참조): 라운드가
  // 소비 완료되면 그 세대는 tombstone으로 닫히고, 다음 라운드가 같은
  // 키를 재사용해도 이전 세대의 값과 비교되지 않고 새로 관측을
  // 시작한다.
  // HYK-423 3R §2 (구조 축 -- 두 반려의 공통 뿌리를 정면으로 다룬다,
  // coder.md 참조): 2R은 관측 지문의 «보호 범위»를 DONE 줄까지로 좁혔지만,
  // headCommitVerdict(HYK-383, 아래 checkRelayHandshake)는 그 뒤에도 여전히
  // resultContent «전체»를 다시 스캔했다 -- 지문이 보호하는 범위와 게이트가
  // «읽는» 범위가 서로 달라, DONE 줄 뒤에 head_commit: 을 새로 덧붙이면
  // 지문은 그대로인데 게이트만 통과했다(2R 검토가 실측 재현, 이 라운드의
  // 반려 사유). 3R은 이 두 범위를 **같은 이름의 같은 값**으로 통일한다:
  // `judgedRegion`(resultContent를 `>>> DONE:` 줄이 끝나는 지점까지 자른
  // 것)을 이 함수가 계산해 ⓐ 관측 지문(아래 spawnObserveDoneLine)과 ⓑ
  // checkRelayHandshake가 이후 호출하는, resultContent의 «값»을 읽는 모든
  // 게이트(headCommitVerdict/runnerReceiptVerdict의 claim 확인) 양쪽에
  // 그대로 넘긴다 -- 어느 한쪽만 손대는 방식(1R: 게이트 이름 결속, 2R:
  // 지문만 축소)을 반복하지 않기 위해서다. doneLineRaw 자체(아래
  // doneMatch[0])는 이 축과 별개로 checkIntermediateRewrite가 항상 직접
  // 비교한다(first-observation.mjs, 손대지 않았다) -- DONE 줄 자신은
  // 무조건 보호된다. 이 축소가 여전히 완화하는 것은 오직 DONE 줄 «뒤»의
  // 후기(postscript)뿐이다: 2026-09-03 실물 사고(coder-task.md §1-2)의
  // 정정("결과 파일에 덧붙임")이 그 모양이었다. DONE «앞»은 지문과 모든
  // judgedRegion 기반 게이트 양쪽에 그대로 포함되므로, 어느 게이트가
  // 거부했든 그 앞 내용을 고치면 여전히 rewritten으로 잡히고, DONE 뒤에
  // 무엇을 덧붙여도 judgedRegion 기반 게이트는 그것을 아예 보지 못한다
  // (coder.md ⑴ 전수표 -- 어느 검사기가 이 region을 쓰는지, 왜 다른
  // 검사기는 쓰지 않아도 안전한지).
  const judgedRegion = resultContent.slice(
    0,
    doneMatch.index + doneMatch[0].length,
  );
  const observation =
    taskId && droppedAtRaw
      ? spawnObserveDoneLine({
          taskId,
          droppedAt: droppedAtRaw,
          role,
          harnessDir,
          resultContent: judgedRegion,
          doneLineRaw: doneMatch[0],
        })
      : { rewritten: false };
  const doneMislabel = checkTimezoneMislabel({
    candidateDate: doneAt,
    rawText: doneMatch[1],
    field: TIME_FIELD.RESULT_DONE_AT,
    now,
  });
  if (doneMislabel) return doneMislabel;
  const doneFuture = checkFutureSkew({
    candidateDate: doneAt,
    rawText: doneMatch[1],
    field: TIME_FIELD.RESULT_DONE_AT,
    now,
  });
  if (doneFuture) return doneFuture;
  return { ok: true, doneAt, doneMatch, observation, judgedRegion };
}

// HYK-244 2R-a §2 조각2: `dispatchId`는 ⛔호출자가 명시적으로 넘긴 값만
// 쓴다(추측·유추 금지) -- 기본값 undefined, 넘어오지 않으면 영수증의
// binding에 그대로 undefined로 남아 1R 코어(consumption-receipt-core.mjs)
// 의 checkBindingPreconditions가 "주 열쇠 미확정"으로 거부한다(영수증이
// 있어도 아직 PASS를 못 낸다는 뜻 -- 이 조각의 범위 그대로, §3 정직
// 한계). 어디서 이 값을 넘길지는 2R-b가 결선한다.
// HYK-244 2R-ci-1: 파일 경로에 쓰는 표기와 결속/영수증에 담기는 role
// 값을 분리한다 -- 관제실 dispatch-worker.ps1(166/260행)이 실측으로
// 확인된 실제 관례: 라이브 task/result 파일은 항상 `$Role.ToLower()`로
// 쓴다(`.harness/coder-task.md`/`.harness/coder.md`, 이 워크트리에서
// `ls .harness/*.md`로 직접 확인 -- 전부 소문자). Windows는 파일시스템이
// 대소문자를 구별하지 않아 role이 대문자("CODER")로 와도 그 lowercase
// 파일을 그대로 찾지만, Linux(CI)는 구별해 못 찾는다(PR #152 CI
// `enforce` 잡 실측: "task file not found: .../CODER-task.md"). role
// 자신(바인딩·영수증·isReviewFamilyRole·아카이브 파일명에 쓰이는 값)은
// 검토 승인분이라 그대로 둔다 -- 오직 파일 경로 조립에만 소문자화한
// 별도 값을 쓴다.
//
// ⛔이 함수를 export하는 이유(HYK-244 2R-ci-1 §3): 파일시스템의 대소문자
// 구별 여부에 기대는 시험은 Windows에서 이 결함이 재발해도 절대 못
// 잡는다(오늘 실제로 그랬다 -- 로컬 3자리 전부 통과, CI만 반증). 이
// 함수를 순수 문자열 변환으로 분리해 export하면, "join 결과 문자열이
// 항상 소문자 파일명을 낸다"를 파일 존재 여부와 무관하게, 어느
// OS에서든 assert.equal 하나로 확인할 수 있다.
export function resolveLiveRoundFilePaths(role, harnessDir) {
  const roleForPath = String(role).toLowerCase();
  return {
    taskPath: join(harnessDir, `${roleForPath}-task.md`),
    resultPath: join(harnessDir, `${roleForPath}.md`),
  };
}

// HYK-257-done-stamp-lint-1: extracted from checkRelayHandshake (pure
// decomposition -- max-lines-per-function/complexity ESLint limits, 동작
// 변경 0) -- resolves the live task/result file paths, confirms both exist,
// and reads their content. Identical checks/return shapes/order to what
// used to be inline at the top of checkRelayHandshake.
function resolveTaskAndResultFiles(role, harnessDir) {
  const { taskPath, resultPath } = resolveLiveRoundFilePaths(role, harnessDir);

  if (!existsSync(taskPath)) {
    return { ok: false, reason: `task file not found: ${taskPath}` };
  }
  if (!existsSync(resultPath)) {
    return {
      ok: false,
      reason: `result file not found (worker not done?): ${resultPath}`,
    };
  }

  // HYK-313 §2: resultPath's own fs mtime is the one age signal this round
  // adds -- engine-agnostic (filesystem-only, no Claude-hook/codex-session
  // dependency, §3 요건) and reflects "언제 이 결과 파일이 마지막으로
  // 쓰였는가" directly, unlike dropped_at (a round can legitimately still be
  // actively writing long after it was dropped -- see resolveMissingDoneOutcome's
  // own header for why dropped_at was rejected as the age basis). Best-effort:
  // a stat failure here must not block the handshake's existing checks, so it
  // degrades to `null` (resolveMissingDoneOutcome then falls back to the
  // pre-HYK-313 unconditional PENDING, never mis-stalls on a measurement gap).
  let resultMtimeMs;
  try {
    resultMtimeMs = statSync(resultPath).mtimeMs;
  } catch {
    resultMtimeMs = null;
  }

  return {
    ok: true,
    taskPath,
    resultPath,
    taskContent: readFileSync(taskPath, "utf8"),
    resultContent: readFileSync(resultPath, "utf8"),
    resultMtimeMs,
  };
}

// HYK-257-done-stamp-lint-1: extracted from checkRelayHandshake (same
// ESLint-limit reason as resolveTaskAndResultFiles above) -- resolves and
// cross-checks the task file's task_id header against the result file's
// task_id echo. Identical checks/return shapes/order to what used to be
// inline in checkRelayHandshake.
function resolveMatchedTaskId(taskContent, resultContent) {
  const taskIdMatch = taskContent.match(TASK_ID_RE);
  if (!taskIdMatch) {
    return { ok: false, reason: "task file missing task_id header" };
  }
  const taskId = taskIdMatch[1];

  const resultTaskId = resolveResultTaskId(resultContent);
  if (!resultTaskId.ok) {
    return { ok: false, reason: resultTaskId.reason };
  }
  const resultId = resultTaskId.id;

  if (taskId !== resultId) {
    return {
      ok: false,
      reason: `handshake mismatch: task dropped '${taskId}' but result echoes '${resultId}' (stale or wrong task)`,
    };
  }

  return { ok: true, taskId };
}

// HYK-383: 검토 결과 계약의 자기확인이 dispatch/pane 일치뿐이라 «엉뚱한
// 커밋을 열심히 검토»해도 형식은 전부 통과했다(2026-08-28 19:07 실사고,
// HYK-377 review-5 -- 표지 task_id·dispatch·pane 전부 일치했으나 본문은
// 직전 라운드 커밋을 판정했고, 검토자 워크트리 HEAD도 그 값에서 한 번도
// 움직이지 않았다). 이 축은 REVIEW 계열 결과에만 건다(coder-task.md §2
// 범위) -- CODER 결과는 이번 범위 밖이다: 작성자는 커밋을 «만들며» 그
// 라운드 안에서 HEAD가 움직이므로 "판정 시점 HEAD == 배달 시점 지정
// 커밋" 같은 정적 대조가 성립하지 않는다(검토자는 판정 동안 커밋을 만들지
// 않으므로 HEAD가 고정돼 있어야 이 대조가 의미를 가진다).
//
// 두 축을 독립적으로 건다(coder-task.md §2 원문): 축 ⓐ만 있으면 워커가
// 지정값을 그대로 베껴 써도(실제로 그 커밋에 있지 않아도) 통과하고, 축
// ⓑ만 있으면 «엉뚱한 커밋에 머문 채 그 커밋을 정직하게 신고»하는 이번
// 실사고가 그대로 통과한다(축 ⓑ는 결과와 실물 워크트리의 내부 일관성만
// 보고, 그 워크트리가 애초에 배달이 지정한 대상 커밋에 있는지는 보지
// 않는다) -- 그래서 반드시 둘 다 건다.
// HYK-383: 콜론과 값 사이·값과 줄 끝 사이의 공백은 개행을 포함하지 않는
// `[ \t]*`로 좁힌다 -- `\s*`를 썼다면 "head_commit:\n<40-hex>"처럼 콜론
// 바로 뒤에 개행이 와도 그 개행을 통째로 삼켜 다중 행 입력이 "한 줄"
// 계약을 어기고도 매치를 수락한다(BLOCKED_RE가 이미 겪은 바로 그 함정,
// 이 파일 위쪽 HYK-173-escalation-2 주석 참조 -- coder-task.md §2도 "08-27
// 에 문장 속 인용이 표지로 오인된 전례"를 이 축의 앵커 요건 근거로 직접
// 인용한다).
// HYK-383 2R §2 (검토 1R P2 실측): ⛔`i` 플래그 없음 -- 정확히 소문자
// `head_commit:`만 표지로 인정한다. 1R은 `gim`(대문자 `HEAD_COMMIT:`도
// 수락)이었고, 검토자가 직접 probe해 실측했다 -- 신원을 좁힌다.
const HEAD_COMMIT_RE_G = /^head_commit:[ \t]*([0-9a-fA-F]{40})[ \t]*$/gm;
// resolveResultTaskId의 TASK_ID_ANYWHERE_RE와 동일한 역할 -- 매치 채택에는
// 절대 쓰지 않고, "표지 자체가 아예 없다"와 "표지를 쓰려는 흔적은 있는데
// 줄 시작이 아니거나 값이 40자 hex가 아니거나 대소문자가 다르다"를 가르는
// near-miss 진단에만 쓴다(대소문자 무관 유지 -- 대문자 HEAD_COMMIT:도 이제
// "근사매치"로는 잡혀야 "missing"이 아니라 더 정확한 진단을 준다).
const HEAD_COMMIT_ANYWHERE_RE = /head_commit:\s*(\S+)/i;

function resolveHeadCommitField(content, { label }) {
  // ★HYK-449 가 실제로 교착시킨 자리 -- 영수증을 코드블록에 인용한 것만으로
  // 「표지 2개」가 됐다(값은 동일했다).
  const scan = maskQuotedMarkerRegions(content);
  const matches = [...scan.matchAll(HEAD_COMMIT_RE_G)];
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `${label} has ${matches.length} standalone 'head_commit:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve, HYK-383)`,
    };
  }
  if (matches.length === 1) {
    return { ok: true, sha: matches[0][1].toLowerCase() };
  }
  if (HEAD_COMMIT_ANYWHERE_RE.test(scan)) {
    return {
      ok: false,
      reason: `${label} head_commit not a standalone column-0 'head_commit: <40-hex sha>' line (found mid-line, or value is not a full 40-hex git SHA, HYK-383)`,
    };
  }
  return {
    ok: false,
    reason: `${label} missing head_commit header (need a standalone \`head_commit: <40-hex sha>\` line, HYK-383)`,
  };
}

// 소비 시점에 «검토자 워크트리의 실제 HEAD»를 기계가 직접 읽는다(축 ⓑ) --
// 워커의 자기 진술(결과 파일 안의 head_commit:)을 신뢰하지 않는다.
// isInsideGitWorktree(위)와 동일하게 harnessDir를 cwd로 써서 git이 위로
// 저장소를 탐색하게 둔다(harnessDir 자신이 워크트리 루트가 아니라 그 안의
// `.harness/` 서브디렉터리인 정상 배치를 그대로 지원). `git rev-parse
// HEAD` 실패(워크트리가 아님·git 자체가 없음 등)는 ⛔fail-closed -- "확인할
// 수 없으니 통과"는 하지 않는다.
function readActualWorktreeHeadCommit(harnessDir) {
  try {
    const out = execSync("git rev-parse HEAD", {
      cwd: harnessDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!/^[0-9a-fA-F]{40}$/.test(out)) {
      return {
        ok: false,
        reason: `git rev-parse HEAD at '${harnessDir}' returned an unexpected value: '${out}' (HYK-383, fail-closed)`,
      };
    }
    return { ok: true, sha: out.toLowerCase() };
  } catch (err) {
    return {
      ok: false,
      reason: `git rev-parse HEAD failed at '${harnessDir}': ${err.stderr ?? err.message} (HYK-383, fail-closed -- cannot verify the reviewer worktree's actual HEAD)`,
    };
  }
}

// Extracted from checkRelayHandshake (same ESLint-limit reason as its
// siblings) -- REVIEW 계열에만 건다(isReviewFamilyRole, coder-task.md §2
// 범위: CODER는 이 축 밖). 비REVIEW 역할은 즉시 `{ok:true, skipped:true}`로
// 빠져 나가 이 축의 어떤 검사도 겪지 않는다(§4 무회귀: CODER/VERIFY 라운드
// 는 이 축이 존재하기 전과 완전히 동일하게 움직인다).
export function resolveHeadCommitBinding({
  role,
  taskContent,
  resultContent,
  harnessDir,
}) {
  if (!isReviewFamilyRole(role)) return { ok: true, skipped: true };

  const resultHead = resolveHeadCommitField(resultContent, {
    label: "result",
  });
  if (!resultHead.ok) return { ok: false, reason: resultHead.reason };

  const taskHead = resolveHeadCommitField(taskContent, { label: "task" });
  if (!taskHead.ok) {
    return {
      ok: false,
      reason: `task file missing head_commit header (required for REVIEW-family 판정 대상 커밋 지정, HYK-383) -- ${taskHead.reason}`,
    };
  }

  // 축 ⓐ(지정 대조): 결과가 배달이 지정한 대상 커밋과 같은가.
  if (resultHead.sha !== taskHead.sha) {
    return {
      ok: false,
      reason: `head_commit mismatch (축 ⓐ 지정 대조, HYK-383): task dispatch specifies '${taskHead.sha}' but result echoes '${resultHead.sha}' -- 배달이 지정한 대상 커밋과 결과가 판정했다고 신고한 커밋이 다르다`,
    };
  }

  // 축 ⓑ(실물 대조): 결과가 검토자 워크트리의 실제 HEAD와 같은가 --
  // 워커 진술이 아니라 기계가 직접 읽는다.
  const actualHead = readActualWorktreeHeadCommit(harnessDir);
  if (!actualHead.ok) {
    return {
      ok: false,
      reason: `head_commit verification failed (축 ⓑ 실물 대조, HYK-383): ${actualHead.reason}`,
    };
  }
  if (resultHead.sha !== actualHead.sha) {
    return {
      ok: false,
      reason: `head_commit mismatch (축 ⓑ 실물 대조, HYK-383): result echoes '${resultHead.sha}' but the reviewer worktree's actual HEAD ('${harnessDir}') is '${actualHead.sha}' -- 엉뚱한 커밋에 머문 채 그 커밋을 정직하게 신고했더라도 거부한다(2026-08-28 19:07 실사고 재현 방지)`,
    };
  }

  return { ok: true, sha: resultHead.sha };
}

// HYK-411: 2026-09-01 실측(coder-task.md §1 원문) -- `npm test 2>&1 | tail`
// 형태의 파이프는 **마지막 명령(tail)의** 종료코드를 셸에 보여준다. 실패한
// 러너가 파이프 뒤에서 exit 0으로 보인다(독립 재현: `sh -c 'exit 7' 2>&1 |
// tail -n 1` -> 파이프라인 exit 0). 실피해(HYK-408 1R): 워커가 낡은 수치
// (이전 베이스라인 그대로)를 "검증"으로 보고했고, 사람이 총계 불일치를
// 이상히 여겨 되물어서만 잡혔다 -- 기계가 막은 것이 아니었다.
//
// 이 축의 설계(coder-task.md §2-2 "주장 조건부"): 결과 파일이 "전체 러너
// 결과"를 주장할 때만 작동한다. 판별 표지 = coder-task.md 1b_exec_line이
// 지정하는 표준 실행 관용구 `npm test; echo "exit=$?"`가 남기는 칼럼 0의
// 단독 `exit=<정수>` 줄 -- 이 관용구를 쓰지 않은(=주장하지 않은) 라운드는
// 이 축을 완전히 건너뛰어 그대로 소비된다(§2-2 "주장하지 않은 라운드는
// 영향 0", 과차단 금지 -- 살아 있는 레인을 막지 않는다는 요구).
//
// 주장이 있으면 `<harnessDir>/runner-receipt.json`(isolated-suite-runner.mjs
// 가 스스로 쓰는 영수증, HYK-411 1R runner-receipt-writer.mjs)을 요구한다:
//   - 영수증 없음                        -> MISSING (fail-closed)
//   - JSON이 아니거나 필수 필드 결여      -> INVALID (fail-closed)
//   - runner_exit !== 0                  -> RED (파이프가 숨긴 빨간 실행)
//   - head_commit이 이 워크트리의 실제 HEAD와 다름 -> STALE (낡은 수치 재사용,
//     HYK-408 실피해의 정확한 형태)
// 네 사유를 서로 다른 code로 구별한다(HYK-413 "유휴/과차단 미구별" 재발
// 방지와 같은 규율 -- resolveDispatchRecordExistence의 LOOKUP_FAILED/
// ABSENT 구분과 동일 정신).
//
// ⛔zero-import 유지: relay-handshake.mjs를 고정 sidecar 파일목록으로
// 격리 clone하는 다수의 mutation 시험(hyk186-time-authority-mutation.
// test.mjs 등)이 이미 존재한다 -- 이 축에 새 모듈을 정적 import하면 그
// 시험들 전부의 고정 목록이 이 파일도 알아야 하는 광범위한 파급이 생긴다
// (admission-completion-adapter.mjs가 spawn으로만 불리는 것과 동일 근거,
// 이 파일 아래 wasAdmissionCompletionAttempted 주석 참조). runner-receipt-
// writer.mjs(생산자)는 이 파일을 전혀 모르고, 이 함수도 그 생산자를 전혀
// import하지 않는다 -- 오직 fs.readFileSync + JSON.parse로 그 결과물만
// 읽는다.
export const RUNNER_RECEIPT_FILENAME = "runner-receipt.json";

export const RUNNER_RECEIPT_REJECT_REASON = Object.freeze({
  MISSING: "RUNNER_RECEIPT_MISSING",
  RED: "RUNNER_RECEIPT_RED",
  STALE: "RUNNER_RECEIPT_STALE",
  INVALID: "RUNNER_RECEIPT_INVALID",
});

// coder-task.md 1b_exec_line 그대로: `npm test; echo "exit=$?"`. 표지는
// 콜론 뒤 인용이 표지로 오인된 과거 함정(HEAD_COMMIT_RE_G 주석 참조)을
// 반복하지 않도록 칼럼 0의 단독 줄만 인정한다.
const RUNNER_EXIT_CLAIM_RE = /^exit=\d+[ \t]*$/m;

export function resultClaimsRunnerResults(resultContent) {
  return (
    typeof resultContent === "string" &&
    RUNNER_EXIT_CLAIM_RE.test(resultContent)
  );
}

function readRunnerReceiptFile(harnessDir) {
  const path = join(harnessDir, RUNNER_RECEIPT_FILENAME);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { present: false, path };
  }
  try {
    return { present: true, path, receipt: JSON.parse(raw) };
  } catch (err) {
    return { present: true, path, parseError: err.message };
  }
}

export function resolveRunnerReceiptVerdict({ resultContent, harnessDir }) {
  if (!resultClaimsRunnerResults(resultContent)) {
    return { ok: true, skipped: true };
  }

  // 축 ⓑ(실물 대조)와 같은 함수 재사용: 워커의 자기 진술이 아니라 이
  // 워크트리의 실제 HEAD를 기계가 직접 읽는다 -- 영수증의 head_commit을
  // 대조할 기준값 자체가 위조 가능하면 이 축 전체가 무의미해진다.
  const actualHead = readActualWorktreeHeadCommit(harnessDir);
  if (!actualHead.ok) {
    return {
      ok: false,
      code: RUNNER_RECEIPT_REJECT_REASON.INVALID,
      reason: `runner receipt gate (HYK-411): cannot resolve this worktree's actual HEAD to compare against the receipt -- ${actualHead.reason}`,
    };
  }

  const found = readRunnerReceiptFile(harnessDir);
  if (!found.present) {
    return {
      ok: false,
      code: RUNNER_RECEIPT_REJECT_REASON.MISSING,
      reason: `runner receipt gate (HYK-411): result claims full runner results (standalone 'exit=<n>' line) but ${RUNNER_RECEIPT_FILENAME} is missing at '${found.path}' -- fail-closed, refusing to consume an unverifiable runner claim`,
    };
  }
  if (found.parseError) {
    return {
      ok: false,
      code: RUNNER_RECEIPT_REJECT_REASON.INVALID,
      reason: `runner receipt gate (HYK-411): ${found.path} is not valid JSON (${found.parseError}) -- fail-closed`,
    };
  }
  const receipt = found.receipt;
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    typeof receipt.runner_exit !== "number" ||
    typeof receipt.head_commit !== "string"
  ) {
    return {
      ok: false,
      code: RUNNER_RECEIPT_REJECT_REASON.INVALID,
      reason: `runner receipt gate (HYK-411): ${found.path} missing required fields (runner_exit: number, head_commit: string) -- fail-closed`,
    };
  }
  if (receipt.runner_exit !== 0) {
    return {
      ok: false,
      code: RUNNER_RECEIPT_REJECT_REASON.RED,
      reason: `runner receipt gate (HYK-411): runner receipt at ${found.path} reports runner_exit=${receipt.runner_exit} (non-zero) -- the runner itself observed a failed run, refusing to consume a result claiming green (파이프가 숨긴 빨간 실행 차단)`,
    };
  }
  if (receipt.head_commit.toLowerCase() !== actualHead.sha) {
    return {
      ok: false,
      code: RUNNER_RECEIPT_REJECT_REASON.STALE,
      reason: `runner receipt gate (HYK-411): runner receipt at ${found.path} head_commit '${receipt.head_commit}' does not match this worktree's actual HEAD '${actualHead.sha}' -- refusing to consume a stale/reused runner result (HYK-408 1R 실피해 재발 방지)`,
    };
  }
  return { ok: true };
}

// HYK-387: 2026-08-29 실사고 -- ORCH가 태스크 문안을 좌석에 배달했으나
// 배정(dispatch) 기록 생성이 `agent_prompt_stalled`로 실패했다. 문안은
// 도착했고 워커는 그대로 라운드를 시작해 커밋까지 만들었다. 런타임
// 태스크는 `ready`로 남아 있었다 -- 장부에는 그 라운드가 없었다.
//
// 기존 G1(위조 차단) 축들(위 resolveHeadCommitBinding 등)은 전부 «존재하는
// 기록이 진짜인가»(진위)만 본다 -- 기록이 «아예 없는» 시작은 애초에 그
// 검사의 대상에 들어오지 않는다(coder-task.md §1-Q1/Q2). 이 축은 그
// 반대: 소비 시점에 «이 라운드의 배정 기록이 장부(dispatch-receipt-
// cli.mjs가 append-only로 쓰는 JSONL 원장, HYK-219-receipts-1)에 실제로
// 있는가»를 확인한다.
//
// ⛔조회 실패(원장을 읽을 수 없음/손상)와 기록 없음(원장은 읽었지만 이
// 라운드에 대응하는 항목이 없음)을 같은 사유로 뭉뚱그리지 않는다
// (coder-task.md §4 급소 1) -- 아래 DISPATCH_RECORD_STATE 두 값이 서로
// 다른 코드 경로에서만 나온다:
//   - LOOKUP_FAILED: 원장 파일이 있는데 읽기 자체가 실패했다(EISDIR·
//     권한 등) -- "모른다".
//   - ABSENT: 원장 파일이 아예 없거나(한 번도 기록된 적 없음 -- 존재하지
//     않는 파일은 그 자체로 "기록이 0건"이라는 확정적 사실이다), 또는
//     원장은 정상적으로 읽었으나 이 라운드(role+taskId)에 대응하는 항목이
//     없다 -- "없다".
// 둘 다 fail-closed(ok:false)로 거부하되, state로 구분해 진단이 죽지 않게
// 한다.
//
// ⛔정직 한계(§0 경계 1 -- 실물 원장 접근 금지, 관제실 라이브 파일 무접촉):
// `dispatchLedgerPath`를 명시로 넘기면 그 값을 쓴다. 넘기지 않으면
// `<harnessDir>/dispatch-receipt-path.txt` 포인터 파일 fallback을
// 시도한다(resolveDispatchLedgerPath, 아래). 둘 다 없으면 그대로
// 스킵 -- 추측·하드코딩된 실물 경로는 여전히 없다.
//
// ⛔★3R 작업 도중 자체 발견·되돌림(env fallback을 뺐다, 아래 근거):
// 처음에는 env `DISPATCH_RECEIPT_PATH`도 세 번째(사실은 두 번째) fallback
// 단계로 넣었었다 -- 그런데 이 저장소 전체 러너(`isolated-suite-runner.mjs`)
// 실행 중 `HYK-359 완료조건4`(모든 CI-canonical 시험 파일을 떠도는
// 레거시 3개 env로 fuzz하는 스윕)가 **71개** 시험을 무더기로 실패시켰다.
// 원인: `DISPATCH_RECEIPT_PATH`는 `admission-ledger-env-isolation.mjs`의
// `AMBIENT_LEDGER_ENV_KEYS`에 이미 있던(1R 이전부터, 쓰기측
// `dispatch-receipt-cli.mjs`용) «보호 대상» 키였는데, 그 보호는
// **spawn된 자식 프로세스의 env**(`isolatedChildEnv`)만 막는다 -- **이
// 프로세스 안에서 직접(in-process) `checkRelayHandshake`를 부르는**
// 수십 개 기존 시험 파일(relay-handshake.test.mjs 등)은 그 보호를 전혀
// 쓰지 않는다(그럴 필요가 이 축이 생기기 전엔 없었다). 코어 함수 자체가
// 이 env를 읽게 만드는 순간, 그 수십 개 시험 전부가 "떠도는
// `DISPATCH_RECEIPT_PATH`"에 새로 노출됐다 -- 정확히 2R이 "기존 회귀
// 시험 수백 개가 우연히 그 경로와 충돌할 위험" 때문에 파일시스템 기본
// 경로 자동 추정을 기각했던 바로 그 형태의 사고가, 이번엔 env 이름
// 정합 자체 때문에 재현됐다(§3의 §4 급소 1 논의가 "다른 대안"으로
// 기각했던 위험이 실제로 관측된 것 -- 처음엔 "포인터 파일은 위험이 없다"
// 고만 적었는데, «env 단계 자체»가 위험했다는 것을 이 실측 뒤에야
// 알았다). 게다가 이 라운드 자신의 패치 문서(§3)가 이미 "env 하나만으로는
// 그 별도 터미널까지 값을 옮길 방법이 없다"고 결론 내렸으므로, env
// fallback은 실전에서 아무 이득도 없이 이 위험만 새로 만드는 셈이었다
// -- 그래서 되돌렸다. 포인터 파일만 남긴다(ambient 위험 0, §4 급소 1
// 증명은 그대로 유효).
//
// HYK-387 3R §1 (이름 정합 수리): 2R은 이 env 이름을 새로 `DISPATCH_
// RECEIPT_LEDGER_PATH`로 지었는데, 라이브 배달기(dispatch-worker.ps1
// 43~46/170~172행)는 이미 **`DISPATCH_RECEIPT_PATH`**를 쓰고 있었다 --
// `dispatch-receipt-cli.mjs`가 append-only로 쓰는 바로 그 파일의 경로를
// 가리키는 같은 개념(«영수증 파일» = «배정 기록이 쌓이는 원장», 다른
// 두 이름이 아니다). 새 이름을 만들지 않고 라이브 이름으로 맞췄다.
//
// HYK-387 3R §3 (급소 1 "패치가 env 를 어디에 심느냐"): 라이브
// `dispatch-worker.ps1`을 직접 읽어 확인한 결과, 이 스크립트는 **완료를
// 감시하는 쪽(watch-result.mjs/checkRelayHandshake)을 전혀 부르지
// 않는다** -- 배달(dispatch)과 착수 확인(exit 0/1/2/3/4/5)까지만 하고
// 끝난다. 즉 "배달기가 소비를 부르는 자리"는 애초에 존재하지 않는다
// (2R이 "정체를 확정 못했다"고 적은 그 프로세스는 여전히 사람/ORCH가
// 별도 터미널에서 손으로 돌리는 것으로 보인다 -- ps1 자체·관제실 grep
// 결과 둘 다 자동 호출자 0건). env 하나만으로는 그 별도 터미널까지
// 값을 옮길 방법이 없다(자식 프로세스 env는 부모 셸에 역전파되지 않고,
// Windows 영속 env(SetEnvironmentVariable "User")는 레지스트리를
// 건드리는 시스템 뮤테이션이라 §0 "확인창 유발 명령 회피"·"실물 곁파일
// 무접촉"과 같은 급의 위험을 새로 만든다 -- 이 라운드는 그 경로를
// 채택하지 않는다).
//
// 대신 (2) 포인터 파일을 쓴다: 배달기가 `$ReceiptPath`를 해석한 직후
// **바로 그 라운드의 `$Worktree`**(=harnessDir의 부모, 소비 쪽이 항상
// 이미 알고 있는 유일한 앵커) 안에 그 값을 한 줄로 적어 둔다. 소비
// 쪽은 매 호출마다 `harnessDir`을 필수로 받으므로(모든 실 호출자가
// 이미 넘긴다), 그 디렉터리 안의 정해진 파일 하나만 읽으면 된다 --
// 프로세스 경계·상대경로 기준(급소 3) 문제가 구조적으로 없다(배달기가
// 적는 값은 항상 절대경로, 소비 쪽은 그 문자열을 그대로 쓸 뿐 재해석
// 하지 않는다). 패치 상세는 `docs/control-room-patches/HYK-387-receipt-
// path-pointer.md` 참조.
export const DISPATCH_RECORD_STATE = Object.freeze({
  ABSENT: "DISPATCH_RECORD_ABSENT",
  LOOKUP_FAILED: "DISPATCH_RECORD_LOOKUP_FAILED",
  // HYK-387 2R §2 (P2 승격, 검토자 P2-ⓑ): 매칭 항목이 있어도 전부 이
  // 라운드의 완료 시각(doneAt) «뒤»에 기록됐다면 근거로 인정하지 않는다 --
  // ABSENT(항목이 아예 없음)와는 다른 사유이므로 별도 state로 구분한다
  // (LOOKUP_FAILED/ABSENT를 뭉뚱그리지 않는다는 1R의 규율을 그대로 확장).
  LATE: "DISPATCH_RECORD_LATE",
});

// HYK-387 2R §1 (P1-1 수리, 검토 원문 그대로 재현 방지): 1R까지는
// `dispatchLedgerPath`를 CLI 전용 `invokedDirectly` 블록에서만 읽었다
// (당시엔 env로) -- 검토자가 실측한 그대로, `watch-result.mjs`
// (watchResult의 기본 checkFn=checkRelayHandshake)·`relay-core.mjs`
// (checkExistingHandshake)·`orca-spike-live.mjs`(verifyFreshHandshake)·
// `orca-spike-runner.mjs`(runHandshakeStage의 `inp.handshake` 그대로
// 전달)·`seat-signal-adapter.mjs`(collectHandshake)는 전부
// `checkRelayHandshake`/`checkFn`을 **직접 import해서 호출**하고 CLI를
// 거치지 않으므로, CLI에만 있던 그 읽기를 단 한 번도 통과하지 않았다.
//
// 2R의 수리: fallback을 **여기, 코어 함수 자체**로 끌어올려 위에 나열한
// 5개 호출자 전부가 코드 수정 없이 한 번에 결선되게 했다("기본 호출에서
// 선다"는 완료조건을 캡처). 3R은 그 fallback의 «원천»을 env에서 포인터
// 파일로 바꿨다(위 헤더 주석의 "★3R 작업 도중 자체 발견·되돌림" 참조 --
// env는 이 저장소 CI-canonical 시험 수십 개를 새로 ambient-leak에
// 노출시켰고, 실전에서도 프로세스 경계를 못 넘어 이득이 없었다).
//
// ⛔실물 경로를 추측·하드코딩하지 않는다(1R부터의 원칙 유지) -- 포인터
// 파일이 없으면 여전히 undefined(스킵)다.
//
// ⛔시험 격리(§0/§4 급소 1): 포인터 파일은 격리가 필요 없는 설계다 --
// 어떤 ambient 프로세스 상태도 관여하지 않고, 오직 «호출자가 넘긴
// harnessDir 안에 그 파일이 실제로 있는가»만 본다. 시험은 mkdtemp
// 픽스처 디렉터리 안에 그 파일을 두거나 안 두는 것만으로 완전히
// 격리된다 -- env 방식이 되돌려진 바로 그 이유(위 헤더 참조)가 여기엔
// 구조적으로 적용되지 않는다.
const DISPATCH_RECEIPT_POINTER_FILENAME = "dispatch-receipt-path.txt";

function readDispatchReceiptPointerFile(harnessDir) {
  if (typeof harnessDir !== "string" || harnessDir.length === 0) {
    return undefined;
  }
  try {
    const raw = readFileSync(
      join(harnessDir, DISPATCH_RECEIPT_POINTER_FILENAME),
      "utf8",
    ).trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    // 포인터 파일이 없거나 못 읽음 -- 오류가 아니라 "이 fallback 단계는
    // 줄 게 없다"는 뜻이다. 다음 단계(스킵)로 그냥 넘어간다.
    return undefined;
  }
}

// HYK-413-seat-binding §2⑴: exported so orca-adapter.mjs's seat-resolution
// axis can reuse the exact same ledger-path resolution (explicit path arg,
// else `<harnessDir>/dispatch-receipt-path.txt` pointer file, else
// undefined/skip) that this file's own HYK-387 3R already hardened -- no
// second implementation of "where is the receipt ledger" is created.
export function resolveDispatchLedgerPath(explicit, harnessDir) {
  if (explicit !== undefined) return explicit;
  return readDispatchReceiptPointerFile(harnessDir);
}

// 원장(JSONL, dispatch-receipt-cli.mjs의 buildReceiptRecord가 쓰는 바로 그
// 형식)을 읽어 파싱 가능한 레코드 배열을 돌려준다. 파일이 아예 없으면
// "0건 확정"(ABSENT로 이어짐)과 "읽기 자체 실패"(LOOKUP_FAILED로 이어짐)을
// 여기서 갈라 반환한다 -- 호출자가 이 둘을 절대 같은 코드로 섞지 않도록.
// HYK-413-seat-binding §2⑴: exported alongside resolveDispatchLedgerPath
// above, same reuse rationale -- ABSENT-vs-LOOKUP_FAILED (ENOENT vs a real
// read error) and all-lines-corrupt-vs-partial-corruption are exactly the
// distinctions the new seat-resolution axis also needs, and re-deriving
// them separately would risk drifting out of sync with this file's own
// fail-closed rules.
export function readDispatchLedgerRecords(ledgerPath) {
  let raw;
  try {
    raw = readFileSync(ledgerPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      // 원장 파일이 한 번도 만들어진 적 없다 -- append-only 로그이므로
      // 이는 "지금까지 기록이 0건"이라는 확정적 사실이다(모른다가 아니라
      // 없다).
      return { ok: true, records: [] };
    }
    return {
      ok: false,
      reason: `DISPATCH_RECORD_LOOKUP_FAILED (HYK-387): dispatch ledger unreadable at '${ledgerPath}': ${err.message} (fail-closed -- 조회 실패, «없다»가 아니라 «모른다»)`,
    };
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const records = [];
  let parseFailures = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      parseFailures += 1;
    }
  }
  // 모든 줄이 손상됐다면(줄이 하나 이상 있었는데 하나도 못 읽었다면) 이
  // 원장에 이 라운드의 항목이 있는지 여부 자체를 판단할 수 없다 -- ABSENT로
  // 접지 않고 LOOKUP_FAILED로 fail-closed한다.
  if (lines.length > 0 && parseFailures === lines.length) {
    return {
      ok: false,
      reason: `DISPATCH_RECORD_LOOKUP_FAILED (HYK-387): dispatch ledger at '${ledgerPath}' has ${lines.length} line(s), all unparseable JSON -- 조회 실패(fail-closed, «없다»로 접지 않는다)`,
    };
  }
  // HYK-387 2R P2ⓒ (검토 관찰, 담음): 일부 줄만 손상됐고 나머지에서 매칭
  // 여부를 정상적으로 판단할 수 있으면(위 "전부 손상" 분기에 안 걸리면)
  // 이 함수는 이미 그 파싱 가능한 부분집합으로 계속 진행한다(막지 않는다)
  // -- 그 결정 자체는 1R부터 있던 동작이다. 이 라운드가 새로 더한 것은
  // `parseFailures`를 호출자에게 노출하는 것뿐이다: 부분 손상이 있었다는
  // 사실을 감사 로그에 남기기 위해서다(resolveDispatchRecordExistence의
  // console.error 참조) -- "막지 않는다"와 "조용히 감춘다"는 다르다.
  return { ok: true, records, parseFailures };
}

// role+taskId(=harness_task_label, dispatch-receipt-cli.mjs의 buildReceiptRecord
// 자체 필드명)로 이 라운드에 대응하는 배정 기록이 원장에 있는지만 본다 --
// 위조/진위(다른 축들의 몫)가 아니라 순수 존재 여부다.
// `doneAtMs`: 이 라운드가 완료로 판정된 시각(epoch ms, checkRelayHandshake가
// 이미 파싱한 doneAt를 그대로 넘긴다) -- HYK-387 2R §2(P2 승격) 시간축 검사에
// 쓴다. in-process 단위 시험(hyk387-6 등)처럼 이 인자가 생략되면(undefined)
// 시간축 검사는 스킵한다(1R 동작 그대로, §4 무회귀) -- checkRelayHandshake
// 자신의 호출부(아래)는 항상 넘긴다.
export function resolveDispatchRecordExistence({
  role,
  taskId,
  dispatchLedgerPath,
  doneAtMs,
  harnessDir,
}) {
  const ledgerPath = resolveDispatchLedgerPath(dispatchLedgerPath, harnessDir);
  if (!ledgerPath) return { ok: true, skipped: true };

  const ledger = readDispatchLedgerRecords(ledgerPath);
  if (!ledger.ok) {
    return {
      ok: false,
      state: DISPATCH_RECORD_STATE.LOOKUP_FAILED,
      reason: ledger.reason,
    };
  }

  // HYK-387 2R P2ⓒ (담음, 담지 않은 것 아님): 일부 줄만 손상됐어도 매칭은
  // 여전히 파싱 가능한 부분집합에서 진행한다(막지 않는다) -- 하지만 그
  // 손상이 있었다는 사실 자체는 조용히 삼키지 않고 감사 로그로 남긴다.
  if (ledger.parseFailures > 0) {
    console.error(
      `relay-handshake: dispatch ledger '${ledgerPath}' has ${ledger.parseFailures} corrupted line(s) alongside ${ledger.records.length} parseable record(s) -- 부분 손상은 이 축을 막지 않는다(HYK-387 P2ⓒ), 파싱 가능한 부분집합으로 계속 진행하되 이 사실을 남긴다`,
    );
  }

  // HYK-387 2R P2ⓐ (담음): role 비교를 대소문자 무시로 정규화한다 -- 검토자
  // 실측(소문자 호출 role vs 대문자로 기록된 정상 항목이 exact-equality
  // 때문에 false rejection). harness_task_label(taskId)은 대소문자 정규화
  // 대상이 아니다(그 값은 사람이 읽는 issue id 문자열이라 대소문자가
  // 의미를 가질 수 있다 -- role만 이 저장소 전역에서 이미 대소문자를
  // 섞어 쓰는 관용(coder/CODER)이 있다는 것이 검토자가 짚은 실제 문제였다).
  const roleLower = typeof role === "string" ? role.toLowerCase() : role;
  const matches = ledger.records.filter(
    (r) =>
      r &&
      typeof r === "object" &&
      typeof r.role === "string" &&
      r.role.toLowerCase() === roleLower &&
      r.harness_task_label === taskId,
  );
  if (matches.length === 0) {
    return {
      ok: false,
      state: DISPATCH_RECORD_STATE.ABSENT,
      reason: `DISPATCH_RECORD_ABSENT (HYK-387): no entry in ledger '${ledgerPath}' matches role='${role}' harness_task_label='${taskId}' -- 배정 기록이 장부에 없는 라운드는 정상으로 받아들여지지 않는다(2026-08-29 실사고 재현 방지)`,
    };
  }

  // HYK-387 2R §2 (P2 승격, 검토자 P2-ⓑ 원문): "결과가 끝난 뒤에 기록된
  // 배정 항목은 그 라운드의 근거가 될 수 없다." recorded_at(ISO, ms 정밀도)이
  // doneAtMs보다 «엄격히 이전»이어야만 근거로 인정한다.
  // ⛔경계값 설계(같은 초/역방향 스큐, 2R §2 요구): doneAt은 DONE 라인에서
  // 초 단위까지만 파싱된다(parseKstTimestamp) -- 즉 doneAtMs는 그 초의
  // "시작"(ms=000)을 가리킨다. recorded_at이 doneAtMs와 «정확히 같은
  // 값»이면 그 항목이 doneAt이 가리키는 바로 그 순간보다 앞선다는 것을
  // 증명할 수 없다(같은 밀리초) -- fail-closed 쪽(=LATE 취급)으로 접는다,
  // "<=" 이 아니라 "<"를 쓴다. 이 저장소의 다른 시간축 검사들
  // (isBeyondFutureSkew 등)도 동률을 안전측으로 접는 관례를 이미 쓴다
  // (checkFutureSkew 주석 참조) -- 새 기준을 발명하지 않고 그 관례를
  // 그대로 따른다. recorded_at이 파싱 불가능한 항목은 "근거 못 됨"으로
  // 취급한다(모른다는 있다로 접지 않는다, 1R의 fail-closed 규율과 동일).
  // 역방향 스큐(기록 기계 시계가 완료 기계 시계보다 빠르거나 느려 원인·
  // 결과 순서가 뒤집혀 보이는 경우)는 이 비교로는 원리적으로 구별할 수
  // 없다 -- 이 축은 "시간 선후는 진위의 값싼 대용"(검토자 원문)이라는
  // 것을 그대로 인정하고, 애매하면 거부(오탐보다 오인식 방지 우선)한다.
  if (typeof doneAtMs === "number" && Number.isFinite(doneAtMs)) {
    const timely = matches.filter((r) => {
      const recordedAtMs = Date.parse(r.recorded_at);
      return Number.isFinite(recordedAtMs) && recordedAtMs < doneAtMs;
    });
    if (timely.length === 0) {
      return {
        ok: false,
        state: DISPATCH_RECORD_STATE.LATE,
        reason: `DISPATCH_RECORD_LATE (HYK-387 P2): ${matches.length} matching ledger entr${
          matches.length === 1 ? "y" : "ies"
        } for role='${role}' harness_task_label='${taskId}' in '${ledgerPath}' but none were recorded strictly before this round's completion time (doneAt=${new Date(
          doneAtMs,
        ).toISOString()}) -- a dispatch record written at or after completion cannot serve as proof of assignment (fail-closed; 같은 밀리초도 "그 전"으로 인정하지 않는다)`,
      };
    }
    return { ok: true, matches: timely.length };
  }

  return { ok: true, matches: matches.length };
}

// HYK-257-done-stamp-lint-1: extracted from checkRelayHandshake (same
// ESLint-limit reason as above) -- the two checks that sit between
// resolveDoneAt succeeding and the completion side-effects starting:
// intermediate-rewrite rejection (HYK-257-done-stamp-2 §2 범위1) and the
// pre-existing staleness rejection. Returns the ok:false verdict to return
// immediately, or null when neither check rejects (proceed). Comments
// preserved verbatim from their original inline location -- same checks,
// same order, same reasons, only moved.
function checkRewriteAndStaleness({
  observation,
  doneAt,
  droppedAt,
  doneMatch,
  droppedMatch,
}) {
  // HYK-257-done-stamp-2 §2 범위1: this is the "최종 판정 시점" the 반려
  // 사유가 요구한 대조 지점 -- every check above (task_id 결속, dropped_at/
  // DONE 파싱·미래-시각·시간대-착오·staleness) has already passed, so this
  // is the moment checkRelayHandshake is ABOUT TO judge the round complete.
  // ★판정 강도(즉시 거부, 경고-후-통과 아님): 이 저장소는 fail-loud를
  // 일관되게 택해 왔다(HYK-183 결과파일 표지 중복=판정불가, HYK-262 표지
  // 줄 계약 위반=거부 -- "조용히 하나를 고르지 않는다"는 이 파일 맨 위
  // 주석부터의 반복 원칙). 중간 수정이 있었다는 것은 «기계가 판정하기 전
  // 결과 파일이 최소 한 번 더 쓰였다»는 사실 자체가 이미 손기입/시간
  // 착오 재발의 강한 신호이므로(§2 실사례 세 건 모두 자기정정이었지만,
  // 이 채널은 "그 결과가 우연히 옳았는지"를 판단할 수단이 없다 -- 오직
  // «달랐다»만 안다), 경고만 남기고 통과시키면 다음 라운드의 똑같은
  // 손기입을 막을 계기를 잃는다. ⛔정상 라운드 오탐 0은 위 observeDoneLine
  // 의 "처음 관측 = 스스로와 비교"설계로 이미 보장된다(rewritten은 오직
  // 두 번째 이상 서로 다른 관측이 있을 때만 true).
  if (observation?.rewritten) {
    return {
      ok: false,
      state: TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION,
      reason: `result DONE line was rewritten between first observation and final judgment (HYK-257-done-stamp-2 §2 범위1): first observed '${observation.existing?.doneLineRaw}' (at ${observation.existing?.observedAtMs}ms), now judging '${observation.currentDoneLine}' -- 소비 직전 중간 수정이 감지되어 거부한다(즉시 거부, 경고 아님). 고치는 법: DONE을 다시 손으로 고치지 말고 ${fixToolHintFor(TIME_FIELD.RESULT_DONE_AT)} 로 한 번만 찍어라.`,
    };
  }

  if (doneAt < droppedAt) {
    // HYK-398: `state` is a NEW field on this branch (previously absent --
    // only `ok`/`reason` existed here). Additive only: every existing
    // caller/test that reads `.ok`/`.reason` off this exact shape is
    // unaffected (no field was renamed or removed). checkRelayHandshake
    // uses this new `state` (below) to decide whether to attempt the
    // retirement-release side effect -- see
    // runRetirementSideEffectsIfApplicable's own header for why this exact
    // state, and only this one, triggers it.
    return {
      ok: false,
      state: "STALE_DONE_PREDATES_DROP",
      reason: `stale result: DONE (${doneMatch[1].trim()}) predates task drop (${droppedMatch[1].trim()})`,
    };
  }

  return null;
}

// HYK-398 §2-⑶ (책임자에게 위임된 설계 판단, 이 라운드의 결정과 근거): 원장
// 자리 반납을 어디에 붙일지는 두 후보(관제실 지시서: 소비 경로 relay-
// handshake.mjs 쪽 / 어댑터 admission-completion-adapter.mjs 쪽) 중
// relay-handshake.mjs를 골랐다 -- 이유: (1) dispatch-gate-decision.mjs의
// evaluateRetirementDecision은 «배달 게이트»(다음 라운드를 보낼지 결정)
// 축이라 «이 라운드가 끝났을 때 자리를 반납한다»는 소비측 사건과 자리가
// 다르다(관제실 지시서 §2-⑶이 이미 두 후보에서 그 축을 제외했다). (2)
// spawnAdmissionAbortProcess(바로 위)가 BLOCKED_TERMINATION_RELEASED에
// 대해 이미 증명한 자리 -- "checkRelayHandshake가 이 라운드를 최종
// 판정한 바로 그 순간, 서브프로세스로 스폰해 반납을 시도한다"는 완전히
// 같은 모양을 STALE에도 그대로 재사용한다(세 번째 문 신설 금지 -- 이미
// 있는 문 두 개의 배선만 잇는다). 실제 위조 방지 검증(다섯 관문)은 이
// 함수가 아니라 스폰되는 admission-completion-adapter.mjs의
// verifyRetirementEvidence가 «독립 프로세스 경계에서» 다시 한다(호출자
// 신뢰 금지, BLOCKED_TERMINATION_RELEASED와 동일한 신뢰 경계) -- 그래서
// 이 함수는 은퇴 기록의 존재/유효성을 스스로 확인하지 않는다: 은퇴
// 기록이 아직 없으면(가장 흔한 경우 -- 이 폴링은 매번 반복된다) 스폰은
// RETIREMENT_EVIDENCE_MISSING으로 그냥 실패하고 아무 것도 바뀌지
// 않는다(예약은 ACTIVE로 남는다) -- best-effort, non-fatal, 이 라운드
// 자신의 ok:false/state/reason은 조금도 바뀌지 않는다(S11 동일 원칙).
//
// ⛔state가 정확히 "STALE_DONE_PREDATES_DROP"일 때만 실행한다 -- 다른
// ok:false 상태(BLOCKED/NEEDS_INPUT/PENDING/AMBIGUOUS_BLOCKED/
// MALFORMED_BLOCKED/그 외 시간권한 위반)는 이 축의 대상이 아니다(관제실
// 지시서 §1 표: 은퇴 축은 "이름표는 VALID인데 영원히 소비 불가"한
// 라운드 전용이고, 그 첫 실사례가 바로 이 stale 모양이다).
// HYK-398: archiveRoundEnvelope(envelope-archive.mjs) 자신은 동일-내용
// 중복 방지가 없다(archiveRoundTaskFileIfNew와 달리 매 호출마다 무조건
// 다음 번호로 새 사본을 만든다 -- envelope-archive.mjs 자신의 코드로
// 직접 확인, 이 저장소의 기존 계약이라 이 라운드에서 바꾸지 않는다).
// STALE 라운드는 watch-result.mjs가 반복 폴링하므로(첫 폴링에서 정지로
// 판정된 뒤에도 계속) 그 무조건 신규 생성이 여기서는 실제 문제가
// 된다 -- 아카이브 사본이 매 폴링마다 하나씩 늘면 resolveRetirement
// ArchiveCandidateForAdapter(admission-completion-adapter.mjs)의 "정확히
// 하나만 인정" 규칙이 두 번째 폴링부터 영원히 AMBIGUOUS(그 코어가
// FINGERPRINT_MISMATCH로 접는다)로 떨어져 은퇴가 «영원히» 성립할 수 없게
// 된다. 그래서 이 축의 호출 지점에서만(archiveRoundEnvelope 자신은
// 무변경) "이 task_id의 사본이 rounds/에 이미 있으면 다시 만들지
// 않는다"는 별도 방어를 하나 추가한다.
function hasArchivedRoundCopyForTaskId(harnessDir, role, taskId) {
  const roundsDir = join(harnessDir, "rounds");
  let names;
  try {
    names = readdirSync(roundsDir);
  } catch {
    return false;
  }
  const pattern = new RegExp(`^${role}-r\\d+\\.md$`, "i");
  for (const name of names) {
    if (!pattern.test(name)) continue;
    let raw;
    try {
      raw = readFileSync(join(roundsDir, name), "utf8");
    } catch {
      continue;
    }
    const stripped = raw.replace(/^<!-- envelope-archive:[^\n]*-->\n/, "");
    const match = stripped.match(/^task_id:\s*(\S+)/m);
    if (match && match[1] === taskId) return true;
  }
  return false;
}

function runRetirementSideEffectsIfApplicable({
  state,
  role,
  harnessDir,
  taskId,
  taskContent,
  resultContent,
}) {
  if (state !== "STALE_DONE_PREDATES_DROP") return;
  runRetirementSideEffects({
    role,
    harnessDir,
    taskId,
    taskContent,
    resultContent,
  });
}

// HYK-398: quality-check max-lines-per-function 상한을 지키려고
// checkRelayHandshake 몸통에서 뽑았다(HYK-244-receipt-core-1b 선례와
// 동일한 이유, 판정/사유/부수효과는 조금도 바뀌지 않는다) -- HYK-342/
// HYK-249: BLOCKED/NEEDS_INPUT termination side-effects run here, AFTER
// doneResolved's own verdict/reason/state are already fixed -- this call
// never changes `doneResolved` (returned byte-identical), it only adds
// best-effort bookkeeping (see runBlockedTerminationSideEffectsIfApplicable's
// own header for why it's scoped to exactly these two states).
function returnDoneResolvedVerdict({
  doneResolved,
  role,
  harnessDir,
  taskId,
  taskContent,
  resultContent,
  droppedMatch,
  dispatchId,
  resultPath,
  now,
}) {
  runBlockedTerminationSideEffectsIfApplicable({
    state: doneResolved.state,
    role,
    harnessDir,
    taskId,
    taskContent,
    resultContent,
    droppedMatch,
    dispatchId,
    resultPath,
    now,
  });
  return doneResolved;
}

// HYK-398: quality-check max-lines-per-function 상한을 지키려고
// checkRelayHandshake 몸통에서 뽑았다(HYK-244-receipt-core-1b 선례와
// 동일한 이유, 판정/사유/부수효과는 조금도 바뀌지 않는다) -- 이 호출은
// `rewriteOrStaleVerdict`를 조금도 바꾸지 않는다(byte-identical 반환),
// runBlockedTerminationSideEffectsIfApplicable이 doneResolved 검증 직후
// 불리는 것과 정확히 같은 자리 원칙.
function returnRewriteOrStaleVerdict({
  rewriteOrStaleVerdict,
  role,
  harnessDir,
  taskId,
  taskContent,
  resultContent,
}) {
  runRetirementSideEffectsIfApplicable({
    state: rewriteOrStaleVerdict.state,
    role,
    harnessDir,
    taskId,
    taskContent,
    resultContent,
  });
  return rewriteOrStaleVerdict;
}

function runRetirementSideEffects({
  role,
  harnessDir,
  taskId,
  taskContent,
  resultContent,
}) {
  // BLOCKED_TERMINATION_RELEASED와 같은 이유로 봉투 2종을 먼저 보관한다
  // (runBlockedTerminationSideEffectsIfApplicable 참조) -- 은퇴 기록의
  // 아카이브 요구(`.harness/rounds/<role>-r<N>.md`가 실제로 존재하고
  // 지문이 일치)가 성립하려면 그 사본이 먼저 있어야 한다. hasArchivedRound
  // CopyForTaskId(바로 위)가 이미 이 task_id의 사본을 찾으면 건너뛴다
  // (반복 폴링에도 사본이 하나로 유지된다, 위 헤더 참조).
  if (!hasArchivedRoundCopyForTaskId(harnessDir, role, taskId)) {
    autoArchiveRoundEnvelope({ role, harnessDir, resultContent });
    autoArchiveRoundTaskFile({ role, harnessDir, taskContent });
  }

  spawnAdmissionRetirementReleaseProcess(taskId, harnessDir, role);
}

// HYK-419-wire-2 (coder-task.md §2⑵) -- «한 줄» 출력 계약을 부모가
// 보장하기 위한 정규화. 어떤 원문도 물리적으로 «한 줄»(개행 0)로 접고,
// 임의로 긴 원문(검토 실측: 격리 자식 stderr 2줄, CLI 부재 Node 오류
// 18~19줄, throw 오류 12줄 등)이 로그 한 줄을 과도하게 늘리지 않도록
// 길이 상한을 둔다. 상한을 넘는 나머지는 버리되(★말줄임 표시로 "잘렸다"는
// 사실 자체는 남긴다 -- 자른 사실을 숨기면 사람이 원문 전체가 짧았다고
// 오인할 수 있다), 코드/사유 앞부분(보통 진단에 가장 중요한 부분)은 항상
// 보존된다.
const SHADOW_LOG_MAX_LEN = 300;

function toOneLine(text) {
  const collapsed = String(text ?? "")
    .replace(/\r\n|\r|\n/g, " ")
    .trim();
  if (collapsed.length <= SHADOW_LOG_MAX_LEN) return collapsed;
  return `${collapsed.slice(0, SHADOW_LOG_MAX_LEN)}…(truncated)`;
}

function shadowLine(state, reason, taskId) {
  return `retire-author-shadow: ${state} reason=${toOneLine(reason)} label=${taskId} (shadow -- 아무것도 차단하지 않음)`;
}

// HYK-430 5R (§0 재설계 -- 폴백을 «더 잘 만들기»가 아니라 폴백이 필요한
// 상황 자체를 제거한다): 1R(복제) -> 2R(동적 import + 조용한 폴백) ->
// 4R(폴백을 모듈-부재 판별식으로 좁힘)까지 세 라운드가 이 자리에서
// 싸운 이유는 전부 같은 전제 하나였다 -- "격리 픽스처가
// child-probe-timeout-policy.mjs를 형제로 복사하지 않는다"는 환경
// 제약. 그 전제 자체를 5R에서 없앤다: relay-handshake.mjs를 격리
// 임시 디렉터리에 복사해 자식으로 돌리는 모든 시험(list-relay-
// handshake-isolated-fixtures.mjs가 기계로 세는 그 집합, HYK-430 4R
// §2⑵)이 이제 child-probe-timeout-policy.mjs도 형제로 함께 복사한다
// (scripts/check/relay-handshake-fixture-siblings.mjs가 그 복사 목록의
// 단일 소스). "정책을 못 읽는 경우"가 더 이상 존재하지 않으므로,
// 그 경우를 처리하던 동적 import·catch·isPolicyModuleAbsent·로컬
// 2000ms/재시도 0 폴백 경로가 전부 불필요해져 지운다 -- 남는 것은
// 평범한 정적 import 하나뿐이다.
const SHADOW_CLI_TIMEOUT_MS = 2000;

function resolveShadowCliTimeoutMs(baseTimeoutMs) {
  return resolveChildProbeTimeoutMs(baseTimeoutMs);
}

// §2⑶ "재시도 1회" -- 무응답(ETIMEDOUT)에서만 정확히 1회 재시도한다
// (RETRY_ON_TIMEOUT은 child-probe-timeout-policy.mjs가 유일한
// 정의처다).
function withTimeoutRetryIfAvailable(fn, isTimeout) {
  return withTimeoutRetry(fn, { isTimeout });
}

function isTimeoutError(err) {
  // Node의 child_process.execFileSync는 timeout 초과 시 자식을 killSignal로
  // 죽이고 err.code === 'ETIMEDOUT'(실측: 이 워크트리에서 직접 재현,
  // Windows도 동일)을 던진다 -- err.signal/err.killed는 플랫폼에 따라
  // 값이 다를 수 있어(예: Windows는 POSIX 시그널이 없다) code만 신뢰한다.
  return err && err.code === "ETIMEDOUT";
}

// 자식이 exit 0인데 stdout이 비었거나(P1-2 실측: "exit 0으로 stderr만 쓴
// 자식"은 out.trim()이 빈 문자열) retire-author-shadow: 접두어로 시작하지
// 않으면(예: 자식이 다른 도구의 경고 문구를 흘렸거나 CLI 계약이 미래에
// 깨진 경우), 이 CLI의 출력 계약이 이미 깨진 것 -- 부모가 그 사실 자체를
// 한 줄로 대신 만들어 남긴다(⛔줄이 0개인 경우를 절대 만들지 않는다,
// coder-task.md §3-2 비타협).
function normalizeChildStdout(out, taskId) {
  const trimmed = String(out ?? "").trim();
  const firstLine = trimmed.split(/\r\n|\r|\n/, 1)[0] ?? "";
  if (firstLine.startsWith("retire-author-shadow: ")) {
    return toOneLine(firstLine);
  }
  return shadowLine(
    "MALFORMED_OUTPUT",
    trimmed.length > 0 ? trimmed : "(empty stdout)",
    taskId,
  );
}

// HYK-419-wire-1 (coder-task.md §2⑵) -- «그림자» 결선. retirement-auto-
// author-core.mjs가 병합된 뒤에도(#247) 아무 코드도 그 코어를 부르지
// 않는다는 실측(ORCH grep)에 대한 첫 응답 -- 이 함수가 그 코어를 부르는
// «저장소 안의 첫 실호출자»다. ★비타협: 이 함수는 자신을 호출한
// runCompletionSideEffects의 반환값(따라서 checkRelayHandshake 전체의
// ok:true/exit code)을 조금도 바꾸지 않는다 -- 판정 결과는 표준출력 한
// 줄로만 나간다(coder-task.md §2⑵ 접두어 고정 요구).
//
// ★서브프로세스 스폰, 정적 import 아님 -- spawnAbortRecordWriter/
// spawnAdmissionCompletionProcess와 완전히 같은 이유(그 두 함수 바로 위
// 주석 참조): 이 파일은 다수의 격리 픽스처 시험(admission-completion-
// spawn.test.mjs 등, "relay-handshake.mjs + time-authority/reject-streak/
// envelope-archive만" 복사해 서브프로세스로 도는 시험 -- 정확한 개수는
// `node scripts/check/list-relay-handshake-isolated-fixtures.mjs`가
// 손으로 세지 않고 매번 다시 만든다, HYK-430 4R §2⑵)이 의존하는 정적
// import 그래프의 일부다 -- 5번째 정적 import를 추가하면 그 시험 전부가
// LOAD 시점에 MODULE_NOT_FOUND로 깨진다(실측: 첫 시도에서 npm test 60건
// 실패). retirement-auto-author-shadow-cli.mjs를 스폰만 하면 그 파일이
// 격리 픽스처에 없어도 실패는 CALL 시점(child_process 에러)으로 미뤄지고,
// 아래 try/catch가 흡수한다.
//
// HYK-419-wire-2 (2R 수리, 검토 P1-1/P1-2 반영): 이 함수는 여전히 «자신을
// 부르는 쪽의 결과값을 조금도 바꾸지 않는다»(1R 그대로) + 이제 두 가지를
// 추가로 보장한다 -- (a) execFileFn 호출에 timeout을 걸어 자식이 멈춰도
// 이 함수 자신이 멈추지 않는다(§2⑴) (b) 무엇이 나오든 정확히 한 줄만
// logFn을 통해 남는다(§2⑵, normalizeChildStdout/shadowLine이 그 계약을
// 강제한다) -- 1R의 try/catch 이중 방어선(§3, 되돌림 변이 ⓒ의 대상) 구조
// 자체는 바꾸지 않았다.
export function runRetireAuthorShadowObservation({
  role,
  harnessDir,
  taskId,
  doneAt,
  execFileFn = execFileSync,
  logFn = console.log,
  timeoutMs = resolveShadowCliTimeoutMs(SHADOW_CLI_TIMEOUT_MS),
}) {
  try {
    const cliPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "retirement-auto-author-shadow-cli.mjs",
    );
    const args = harnessDir
      ? [cliPath, role, taskId, harnessDir, doneAt]
      : [cliPath, role, taskId];
    // killSignal: SIGKILL -- SIGTERM은 자식이 무시/트랩할 수 있어(예:
    // 정확히 이 결함이 되돌림 변이 ⓐ가 지우는 것 -- timeout 없이 걸리는
    // 자식) "멈추지 않는다"는 비타협을 SIGTERM 하나로는 끝까지 보장할 수
    // 없다. SIGKILL은 무시할 수 없다(정직 한계: Windows는 POSIX 시그널이
    // 없어 Node가 내부적으로 TerminateProcess로 매핑한다 -- 이 워크트리
    // 자체가 Windows라 이 경로로 실측했다, 좀비 프로세스는 남기지 않음을
    // 시험(rr-timeout 계열)으로 확인).
    // HYK-430 2R: 무응답(TIMEOUT)만, 공통 정책이 로드됐을 때 정확히
    // 1회 재시도한다(§2⑶, 위 withTimeoutRetryIfAvailable 주석). 진짜
    // 무응답 자식은 재시도해도 다시 타임아웃되므로 탐지력은 보존된다
    // (§2⑷ 음성 대조 (E)).
    const out = withTimeoutRetryIfAvailable(
      () =>
        execFileFn("node", args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: timeoutMs,
          killSignal: "SIGKILL",
        }),
      isTimeoutError,
    );
    logFn(normalizeChildStdout(out, taskId));
  } catch (err) {
    // Missing CLI file (isolated test fixture), non-zero exit, timeout
    // (killed by the timeout option above), or any other spawn failure --
    // all logged as exactly one line, none fatal to the handshake's own
    // verdict/exit code (mirrors spawnAdmissionCompletionProcess's catch).
    const state = isTimeoutError(err) ? "TIMEOUT" : "OBSERVATION_ERROR";
    const reason = isTimeoutError(err)
      ? `spawn exceeded ${timeoutMs}ms, child killed`
      : String(err.stderr ?? err.message ?? "unknown spawn failure");
    logFn(shadowLine(state, reason, taskId));
  }
}

// HYK-257-done-stamp-lint-1: extracted from checkRelayHandshake (same
// ESLint-limit reason as above) -- runs every completion side-effect for a
// round that has passed every check above (consumed-observation tombstone,
// reject-streak record, envelope/task archiving, admission-completion
// return, consumption-receipt write), in the exact order/comments they used
// to run inline in checkRelayHandshake. Returns the ok:false verdict to
// return immediately for the one side-effect that can still change the
// function's own verdict (HYK-262's ambiguous-cover-line REVIEW rejection),
// or null when every check here still allows the round to complete.
function runCompletionSideEffects({
  role,
  harnessDir,
  taskId,
  taskContent,
  resultContent,
  droppedMatch,
  doneMatch,
  dispatchId,
}) {
  // HYK-257-done-stamp-3 §2 범위1 (로그 수명): this round is now confirmed
  // complete (every prior check passed) -- close out this generation's
  // first-observation entry so a future round cannot be compared against
  // it (see spawnMarkObservationConsumed's own header for why this must
  // happen exactly here, not earlier/later).
  spawnMarkObservationConsumed({
    taskId,
    droppedAt: droppedMatch[1].trim(),
    role,
    harnessDir,
  });

  // HYK-183 §2: the moment this function confirms a REVIEW-family result
  // file is COMPLETE (every prior check above already passed) is the one
  // moment the reject-streak ledger should be updated -- record's whole
  // job (reject-streak.mjs) is "did the LATEST, non-stale round on this
  // issue get rejected or approved", and everything above this line is
  // exactly the staleness/ambiguity resolution that answers that. Wired
  // here (inside the shared decision function, not only the CLI block) so
  // every caller -- the CLI AND in-process callers like relay-core.mjs --
  // gets it; §1's original gap was that NOTHING called `record` anywhere.
  //
  // HYK-262: moved AHEAD of autoArchiveRoundEnvelope/autoArchiveRoundTaskFile
  // (was after both -- see git history) and now DOES mutate this function's
  // own return value/exit code for one specific case: a REVIEW-family
  // result whose ledger record was attempted but failed (`attempted:true,
  // ok:false` -- e.g. a 표지 줄 계약 위반 that reject-streak.mjs itself
  // reports UNJUDGABLE for). Before this change that failure was only ever
  // surfaced via console.error while checkRelayHandshake still returned
  // ok:true -- the round finished silently with the reject-streak ledger
  // permanently missing an entry, disarming 게이트 2 (연속반려) with no
  // trace beyond a log line nobody was watching (실사고 2026-08-14, HYK-262
  // §2). ⛔이 조각의 상설 문장: «관측·기록이 실패했으면 그 사실이 다음
  // 단계의 «진행 가능 여부»에 반영되어야 한다 -- 화면 출력만으로는 «반영»이
  // 아니다.» Placing this check BEFORE the archive calls (rather than after,
  // leaving them unchanged) is a deliberate design choice, not an
  // accident: the completion condition's literal wording is "종료코드 0
  // 아님 · 영수증 미발행 · 보관 미실시" (exit nonzero, no receipt, NO
  // ARCHIVE) -- reordering makes "보관 미실시" literally true (the archive
  // calls are never reached) instead of leaving a half-true state where the
  // round is rejected AFTER its envelope/task file already got copied into
  // `.harness/rounds/`. CODER/VERIFY (isReviewFamilyRole false) are
  // unaffected: `autoRecordRejectStreak` returns `{attempted:false}` for
  // them, so this branch never fires and archiving/completion proceed
  // exactly as before (§3-1 요건, HYK-262 범위 -- REVIEW 계열만 영향).
  const recordOutcome = autoRecordRejectStreak({
    role,
    resultContent,
    harnessDir,
  });
  const coverViolation = checkAmbiguousCoverViolation(recordOutcome);
  if (coverViolation) return coverViolation;
  const valueViolation = checkValueInvalidCoverViolation(recordOutcome);
  if (valueViolation) return valueViolation;
  traceUnblockedRecordFailure(recordOutcome);
  // HYK-204: the moment this function confirms a round's result file is
  // COMPLETE (every check above already passed) is also the last moment
  // before ORCH drops the next round's task file and this same
  // `<role>.md` slot gets overwritten -- the exact loss point the 2026-08-08
  // 실사례 hit. Archived here (not left to the worker to remember) for the
  // same reason autoRecordRejectStreak lives here: every caller -- CLI and
  // in-process alike -- gets it, with no new notification device.
  const envelopeArchived = autoArchiveRoundEnvelope({
    role,
    resultContent,
    harnessDir,
  });
  const taskArchived = autoArchiveRoundTaskFile({
    role,
    taskContent,
    harnessDir,
  });
  // HYK-227 §2: moved here from the CLI-only `invokedDirectly` block below
  // (was line-local to that block prior to this change) so EVERY caller of
  // checkRelayHandshake -- not only the CLI entry point -- reaches this
  // completion step, exactly mirroring autoArchiveRoundEnvelope/
  // autoRecordRejectStreak immediately above (same call site, same "every
  // caller, CLI and in-process alike, gets it" contract). This is the fix
  // for the HYK-224-2R §3 옵션3 header comment's own documented gap ("in-
  // process callers... don't get this completion wiring -- CLI spawn point
  // only"): spawnAdmissionCompletion itself is unchanged (still a
  // try/catch-wrapped subprocess spawn, never a static import, so the 1R
  // isolated-fixture failure this design avoids stays avoided -- see that
  // function's own header).
  // HYK-312 §1: this local closure captures `harnessDir` (already a
  // parameter of the enclosing runCompletionSideEffects) so the module-level
  // spawnAdmissionCompletionProcess can learn which round directory is
  // actually being consumed, WITHOUT changing this call site's own text --
  // relay-handshake-completion-wire.test.mjs's ⓒ mutation test pins that
  // exact call-site line as its deletion target (see that test's own
  // `target` constant), so the call site itself must stay byte-identical.
  function spawnAdmissionCompletion(taskId) {
    return spawnAdmissionCompletionProcess(taskId, harnessDir);
  }
  const admissionReturned = spawnAdmissionCompletion(taskId);

  // HYK-244 2R-a §2 조각2: the moment every above effect's OWN outcome is
  // known (never before -- §1 실측: 이 셋은 실패해도 로그만 남기고 위
  // ok:true 자체는 바뀌지 않는다) is the one moment a consumption receipt
  // can be honestly issued. ⛔비타협: 후속효과 중 하나라도 실패하면 성공
  // 영수증을 만들지 않는다(§2 조각2 원문) -- writeReceipt below is only
  // ever called when requiredEffectsOk is true.
  autoWriteConsumptionReceipt({
    role,
    harnessDir,
    resultContent,
    taskId,
    droppedAt: droppedMatch[1].trim(),
    dispatchId,
    doneAt: doneMatch[1].trim(),
    envelopeArchived,
    taskArchived,
    admissionReturned,
    recordOutcome,
  });

  // HYK-419-wire-1 §2⑵: 모든 완료 후속효과의 결과가 나온 뒤, 그리고 이
  // 함수가 null(=판정 불변)을 돌려주기 직전 -- 되돌림 변이 ⓐ의 대상(이
  // 호출 한 줄을 지우면 grep으로 찾는 "그 줄이 찍힌다" 시험이 빨개진다).
  runRetireAuthorShadowObservation({
    role,
    harnessDir,
    taskId,
    doneAt: doneMatch[1].trim(),
  });

  return null;
}

// HYK-342/HYK-249 §3 채택 설계 -- «정지 종결(termination)» 후속효과.
//
// coder-task.md §1 기전: relay-handshake.mjs는 BLOCKED/NEEDS_INPUT을
// ok:false로 되돌리고 여기서 멈췄다 -- 라운드를 닫는 후속효과 5종(봉투
// 보관 2종·원장 자리 반납·소비 영수증 발행·첫 관측 기록)이 전부 ok:true
// 가지(runCompletionSideEffects)에만 매달려 있어 정지 라운드는 그 중 어느
// 것도 받지 못했다. HYK-249(자리 미반납)와 HYK-342(다음 배달 영구 거부)는
// 이 하나의 결손의 증상 둘이다.
//
// 이 함수는 그 중 정지 경로에 맞는 세 가지만 붙인다: 봉투 보관 2종(그대로
// 재사용, envelope-archive.mjs는 role/resultContent 또는 taskContent/
// harnessDir만 받는 순수 함수라 ok:true 분기와 똑같이 부를 수 있다) ·
// 원장 자리 반납(단 «완료»가 아니라 «정지 회수» 사유로 -- admission-
// ledger-core.mjs의 completeReservation에 새로 추가된 선택적 reason 인자,
// COMPLETION_REASON.BLOCKED_TERMINATION_RELEASED) · 중단 기록 작성
// (abort-record-writer.mjs를 여기서 프로덕션에 처음 결선한다, HYK-298이
// 만들었지만 프로덕션 호출자가 0이었던 그 문). 소비 영수증(정상 완료
// 전용)과 첫 관측 기록(DONE 라인 전용)은 정지 라운드에 해당하지 않으므로
// 붙이지 않는다.
//
// ⛔모두 best-effort, non-fatal -- 이 함수의 반환값(void)은 checkRelayHandshake
// 자신의 ok:false/reason/state를 조금도 바꾸지 않는다(runCompletionSideEffects의
// ok:true 분기와 동일한 "부수효과는 판정을 바꾸지 않는다" 원칙, S11).
//
// ⛔state가 정확히 "BLOCKED" | "NEEDS_INPUT"일 때만 실행한다(§3 "BLOCKED/
// NEEDS_INPUT 가지" 그대로) -- AMBIGUOUS_BLOCKED/MALFORMED_BLOCKED/PENDING/
// STALLED_PENDING은 "정상적으로 정지를 선언한 라운드"가 아니라 "판정 자체가
// 불확실한" 상태이므로, 그런 상태에서 원장 자리를 반납하거나 중단 기록을
// 남기면 아직 살아있을 수도 있는 라운드의 자리를 성급하게 빼앗는 결과가
// 된다.
function runBlockedTerminationSideEffectsIfApplicable({
  state,
  role,
  harnessDir,
  taskId,
  taskContent,
  resultContent,
  droppedMatch,
  dispatchId,
  resultPath,
  now,
}) {
  if (state !== "BLOCKED" && state !== "NEEDS_INPUT") return;

  // ⚠️인자 순서가 runCompletionSideEffects의 동일 호출과 다르다(의도적 --
  // 동작은 완전히 같지만, envelope-archive-mutation.test.mjs/hyk241-task-
  // archive-mutation.test.mjs의 assertExactlyOneMatch가 정확히 1개의
  // call-site 문자열만 찾도록 요구한다. 두 자리를 byte-identical로
  // 만들면 "어느 자리를 변이할지" 자체가 모호해진다).
  const envelopeArchived = autoArchiveRoundEnvelope({
    role,
    harnessDir,
    resultContent,
  });
  const taskArchived = autoArchiveRoundTaskFile({
    role,
    harnessDir,
    taskContent,
  });
  const abortReleased = spawnAdmissionAbortProcess(taskId, harnessDir, role);

  spawnAbortRecordWriter({
    role: role.toUpperCase(),
    harnessDir,
    harnessTaskLabel: taskId,
    dispatchId,
    droppedAt: droppedMatch[1].trim(),
    leftoverFingerprint: computeResultFingerprint(resultContent),
    leftoverPath: resultPath,
    recordedAt: new Date(now).toISOString(),
    evidence: {
      source: "relay-handshake-blocked-termination",
      state,
      envelopeArchived,
      taskArchived,
      abortReleased,
    },
  });
}

// HYK-257-done-stamp-lint-1: decomposed into resolveTaskAndResultFiles/
// resolveMatchedTaskId/checkRewriteAndStaleness/runCompletionSideEffects
// (all defined immediately above, in the exact original inline order) to
// satisfy ESLint's max-lines-per-function/complexity limits (real
// pre-commit gate, HYK-148) -- 순수 분해, 동작 변경 0: every check, every
// side-effect call, every comment explaining WHY a step exists, is
// unchanged and runs in the exact same order as before. Only the "which
// function's stack frame it runs in" changed.
// HYK-398: quality-check max-lines-per-function 상한을 지키려고
// checkRelayHandshake 몸통에서 뽑았다(HYK-244-receipt-core-1b 선례와
// 동일한 이유, 판정/사유/순서는 조금도 바뀌지 않는다) -- 파일 해석·
// task_id 결속·dropped_at 해석 세 단계를 하나로 묶는다(각각 실패하면
// 그 단계 자신의 verdict를 그대로 돌려준다, ok:false 지름길 순서 불변).
function resolveHandshakePrereqs(role, harnessDir, now) {
  const filesResolved = resolveTaskAndResultFiles(role, harnessDir);
  if (!filesResolved.ok) return { ok: false, verdict: filesResolved };
  const { taskContent, resultContent, resultMtimeMs, resultPath } =
    filesResolved;

  const idResolved = resolveMatchedTaskId(taskContent, resultContent);
  if (!idResolved.ok) return { ok: false, verdict: idResolved };
  const { taskId } = idResolved;

  const droppedResolved = resolveDroppedAt(taskContent, now);
  if (!droppedResolved.ok) return { ok: false, verdict: droppedResolved };
  const { droppedAt, droppedMatch } = droppedResolved;

  return {
    ok: true,
    taskContent,
    resultContent,
    resultMtimeMs,
    resultPath,
    taskId,
    droppedAt,
    droppedMatch,
  };
}

// HYK-398: quality-check max-lines-per-function 상한을 지키려고
// checkRelayHandshake 몸통에서 뽑았다(HYK-244-receipt-core-1b 선례와
// 동일한 이유, 판정/사유/부수효과/순서는 조금도 바뀌지 않는다) --
// resolveHandshakePrereqs에 이어 DONE 해석까지 묶어, ok:false면 (부수효과
// 포함) 그 verdict를, ok:true면 이후 단계가 필요로 하는 값 전부를 돌려준다.
function resolveHandshakeCore({ role, harnessDir, now, dispatchId }) {
  const prereqs = resolveHandshakePrereqs(role, harnessDir, now);
  if (!prereqs.ok) return { ok: false, verdict: prereqs.verdict };
  const {
    taskContent,
    resultContent,
    resultMtimeMs,
    resultPath,
    taskId,
    droppedAt,
    droppedMatch,
  } = prereqs;

  const doneResolved = resolveDoneAt(resultContent, now, {
    taskId,
    droppedAtRaw: droppedMatch[1].trim(),
    role,
    harnessDir,
    resultMtimeMs,
  });
  if (!doneResolved.ok) {
    return {
      ok: false,
      verdict: returnDoneResolvedVerdict({
        doneResolved,
        role,
        harnessDir,
        taskId,
        taskContent,
        resultContent,
        droppedMatch,
        dispatchId,
        resultPath,
        now,
      }),
    };
  }
  const { doneAt, doneMatch, observation, judgedRegion } = doneResolved;
  return {
    ok: true,
    taskContent,
    resultContent,
    resultPath,
    taskId,
    droppedAt,
    droppedMatch,
    doneAt,
    doneMatch,
    observation,
    judgedRegion,
  };
}

export function checkRelayHandshake({
  role,
  harnessDir = join(repoRoot(), ".harness"),
  now = Date.now(),
  dispatchId,
  dispatchLedgerPath,
}) {
  const core = resolveHandshakeCore({ role, harnessDir, now, dispatchId });
  if (!core.ok) return core.verdict;
  const {
    taskContent,
    resultContent,
    taskId,
    droppedAt,
    droppedMatch,
    doneAt,
    doneMatch,
    observation,
    judgedRegion,
  } = core;

  // HYK-325 §2-3 승격 (HYK-418 §2-1): the missing-marker check used to live
  // here as a console-only warning (warnIfMissingFinalizeDoneMarker, non-
  // fatal, never affected the verdict). It is now a fail-closed rejection
  // inside resolveDoneAt (above resolveHandshakeCore in this file), on the
  // same axis as the malformed/minute-precision checks -- see that
  // function's own HYK-418 §2-1 comment. By the time execution reaches
  // this point, `core.ok` was already true, which means resolveDoneAt's
  // marker check already passed -- there is nothing left to warn about
  // here, so this call site is deliberately gone rather than kept as dead
  // code that always no-ops.

  const rewriteOrStaleVerdict = checkRewriteAndStaleness({
    observation,
    doneAt,
    droppedAt,
    doneMatch,
    droppedMatch,
  });
  if (rewriteOrStaleVerdict) {
    return returnRewriteOrStaleVerdict({
      rewriteOrStaleVerdict,
      role,
      harnessDir,
      taskId,
      taskContent,
      resultContent,
    });
  }

  // HYK-383: 다른 모든 사유별 검사가 이미 통과한 뒤, 완료 판정 직전에 건다
  // (§4 무회귀 -- 기존 구체적 거부 사유가 가려지지 않는다). 비REVIEW는
  // 즉시 통과(resolveHeadCommitBinding 자체 헤더 참조). HYK-423 3R §2:
  // `resultContent` 전체가 아니라 `judgedRegion`(위 resolveDoneAt이 계산한,
  // 관측 지문과 «같은» 범위)을 넘긴다 -- resolveHeadCommitField가 DONE
  // 줄 뒤에 새로 나타나는 head_commit: 을 다시 스캔해 채택하는 것이
  // 2R 반려의 정확한 원인이었다(coder.md ⑴ 전수표). 지문이 보호하는
  // 범위와 이 게이트가 «읽는» 범위를 같은 값으로 묶어 그 어긋남 자체를
  // 없앤다.
  const headCommitVerdict = resolveHeadCommitBinding({
    role,
    taskContent,
    resultContent: judgedRegion,
    harnessDir,
  });
  if (!headCommitVerdict.ok) return headCommitVerdict;

  // HYK-411: headCommitVerdict와 같은 자리 원칙(§4 무회귀) -- role 무관(이번
  // 실사고 HYK-408 1R도 CODER 라운드였다, resolveDispatchRecordExistence와
  // 동일 논거). resultContent가 "전체 러너 결과"를 주장하지 않으면 즉시
  // ok:true(skipped)로 빠져 나가 이 축이 존재하기 전과 완전히 동일하게
  // 움직인다(과차단 금지). HYK-423 3R §2: 여기도 `judgedRegion`을 넘긴다
  // -- resultClaimsRunnerResults 자신은 이번 반려의 재현 대상이 아니었지만
  // (검토 ⑷: "이번 postscript 경로의 직접 원인은 아니다"), 같은 축(judged
  // vs 전체) 위에서 같은 종류의 값 확인을 하는 게이트이므로 구조적으로
  // 같은 범위를 쓰게 맞춘다 -- head_commit 하나만 땜질하지 않는다는
  // 이 라운드의 원칙(coder.md ⑵) 그대로.
  const runnerReceiptVerdict = resolveRunnerReceiptVerdict({
    resultContent: judgedRegion,
    harnessDir,
  });
  if (!runnerReceiptVerdict.ok) return runnerReceiptVerdict;

  // HYK-387: headCommitVerdict와 같은 자리 원칙(§4 무회귀) -- REVIEW 한정
  // 아님(오늘의 실사고는 CODER 라운드였다, coder-task.md §1 원문).
  const dispatchRecordVerdict = resolveDispatchRecordExistence({
    role,
    taskId,
    dispatchLedgerPath,
    doneAtMs: doneAt.getTime(),
    harnessDir,
  });
  if (!dispatchRecordVerdict.ok) return dispatchRecordVerdict;

  const sideEffectVerdict = runCompletionSideEffects({
    role,
    harnessDir,
    taskId,
    taskContent,
    resultContent,
    droppedMatch,
    doneMatch,
    dispatchId,
  });
  if (sideEffectVerdict) return sideEffectVerdict;

  return { ok: true, reason: `relay handshake ok for ${taskId}` };
}

// HYK-224-2R §3 옵션3, rewired HYK-227 §2 -- best-effort spawn of the
// neutral admission-completion executor (scripts/check/admission-
// completion-adapter.mjs), now called from INSIDE checkRelayHandshake's own
// ok:true branch above, so every caller (CLI entry point below AND every
// in-process caller -- relay-core.mjs, watch-result.mjs, seat-signal-
// adapter.mjs, orca-spike-live.mjs, orca-spike-runner.mjs) reaches it, not
// only the CLI. Deliberately NOT a module-level import (see that file's own
// header for why: an import here reintroduces the exact failure 1R hit --
// 6 mutation test files' stageTree()/checkFiles isolate relay-handshake.mjs
// with a small fixed dependency list, and importing a file outside that
// list breaks module resolution at LOAD time, before any test assertion
// even runs). A subprocess spawn only fails at CALL time (this function),
// which the try/catch below absorbs -- so an isolated fixture missing the
// adapter file degrades to a silent no-op here, never to a load error.
// Runs ONLY after checkRelayHandshake has already decided ok:true (dispatch
// binding independently verified) -- never changes checkRelayHandshake's own
// return value or the CLI's exit code either way (S11: this is best-effort
// bookkeeping, not part of the handshake verdict).
// HYK-244 ci-repair-1 §1 묶음C 수리: exit 0만으로 "성공"을 판단하면
// admission-completion-adapter.mjs 자신의 "attempted:false"(원장 경로가
// 아예 안 잡혀 시도조차 안 함, ⛔`admission-completion-adapter.mjs` 자체는
// HYK-250 범위라 수정하지 않음)도 exit 0으로 끝나므로 "시도조차 안 함"이
// "반납 성공"으로 둔갑한다(ORCH 실측, not ok 157 원문). 이 저장소 전체의
// 반복 원칙("부분 성공은 성공이 아니다", HYK-244 2R-a §2)과 정확히 같은
// 결의 결함이라, 그 adapter를 고치지 않고 여기서 stdout을 읽어 구별한다
// -- adapter가 실제로 찍는 안정된 문자열(admission-completion-adapter.mjs
// 293행, 바이트 동일 인용)과 대조한다. 순수 문자열 판별이라 파일시스템/
// 환경(설치기 포인터 파일 유무)과 무관하게 export해 직접 단언할 수 있다
// (HYK-244 2R-ci-1의 resolveLiveRoundFilePaths와 같은 이유 -- 그 환경
// 의존성 자체가 이 저장소 전체를 "로컬 통과가 증거가 아니다"로 만드는
// 근본 원인이므로, 문자열 수준에서 독립적으로 확인 가능해야 한다).
export function wasAdmissionCompletionAttempted(stdout) {
  return !String(stdout ?? "").includes("not attempted");
}

// HYK-344 2R (review-r1-verbatim.md §A P1, orch-measured-r1.md 잰 것1): the
// audit trail (${ledgerPath}.completion-failures.jsonl) HYK-344 1R added has
// ZERO production readers (검토자 rg 확인 + ORCH 독립 재확인, 둘 다 grep 0건)
// -- so "구별해서 기록한다"만으로는 "자동 호출자가 성공으로 오인한다"는 핵심
// 결함이 닫히지 않는다. This module-scoped slot is how that gap closes
// without widening `spawnAdmissionCompletionProcess`'s own return value: the
// boolean `admissionReturned` it returns is pinned byte-for-byte by
// relay-handshake-completion-wire.test.mjs's ⓒ mutation target (that test's
// own `target` constant -- the call-expression-plus-semicolon text pinned
// to appear exactly once in this file's working-tree source; NOT quoted
// verbatim here on purpose, HYK-344 3R -- writing it out literally in this
// very comment made it appear TWICE and broke that exact-once invariant,
// caught by the full isolated-suite-runner) -- the mutated `undefined;`
// substitution must stay a valid boolean-shaped assignment) AND is threaded
// into the consumption-receipt `effects` object
// downstream (consumption-receipt-core.mjs expects a boolean there, not an
// object) -- changing its shape would ripple into both. So the richer detail
// (was this genuinely ATTEMPTED-and-FAILED, vs never attempted at all
// because no ledger path resolved) rides this separate slot instead, read
// by the CLI entry point right after `checkRelayHandshake` returns (see
// `invokedDirectly` below). Reset at the top of every call so a call that
// never reaches admission completion this round (REJECTed/BLOCKED rounds,
// which don't invoke this function at all) never sees a PRIOR round's stale
// detail leak through a long-lived in-process caller.
let lastAdmissionCompletionDetail = null;

export function peekLastAdmissionCompletionDetail() {
  return lastAdmissionCompletionDetail;
}

// HYK-353 §3-3: mirrors lastAdmissionCompletionDetail's exact shape/reset
// discipline above -- a round that completes ok:true but whose
// first-observation spawn genuinely ATTEMPTED and FAILED (as opposed to
// never attempted, e.g. no taskId/droppedAtRaw yet) must not look
// indistinguishable from a clean success to a human/automated caller reading
// this CLI's exit code. Reset at the top of spawnObserveDoneLine's own call
// (see that function) so a long-lived in-process caller never sees a PRIOR
// round's stale detail leak through.
let lastFirstObservationDetail = null;

export function peekLastFirstObservationDetail() {
  return lastFirstObservationDetail;
}

// HYK-312 §1: renamed from `spawnAdmissionCompletion` -- the name
// `spawnAdmissionCompletion` is now the local single-arg closure defined
// inside runCompletionSideEffects (captures harnessDir from that scope), so
// this two-arg implementation function needed a distinct name to avoid
// shadowing confusion. Behavior is otherwise byte-for-byte unchanged.
function spawnAdmissionCompletionProcess(taskId, harnessDir) {
  lastAdmissionCompletionDetail = null;
  try {
    const adapterPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "admission-completion-adapter.mjs",
    );
    // HYK-312 §1: harnessDir is now forwarded so the adapter can tell
    // whether the round directory actually being consumed lives inside a
    // registered git worktree, instead of trusting THIS process's own cwd
    // (see admission-completion-adapter.mjs's isInsideGitWorktree header for
    // the incident this closes). Backward-compatible: an absent harnessDir
    // omits the arg entirely, which the adapter treats exactly as before
    // this round (execFileSync's args array rejects `undefined` elements).
    const args = harnessDir
      ? [adapterPath, taskId, harnessDir]
      : [adapterPath, taskId];
    const out = execFileSync("node", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(out.trim());
    const attempted = wasAdmissionCompletionAttempted(out);
    // HYK-344 2R: recorded on the SUCCESS path too (attempted && ok:true, or
    // genuinely not-attempted because no ledger path resolved) -- the CLI
    // reads this slot unconditionally, so a `null` left over from module
    // load (never actually reached this function) must not be
    // indistinguishable from "ran and everything was fine".
    lastAdmissionCompletionDetail = { attempted, ok: true };
    if (!attempted) return false;
    // HYK-244 2R-a 조각2: return value added (was void/undefined) so the
    // receipt-writing call site can know this effect (admissionReturned)
    // actually succeeded. Does not change try/catch structure or any
    // existing log line above/below.
    return true;
  } catch (err) {
    // Missing adapter file (isolated test fixture), non-zero exit
    // (attempted but failed), or any other spawn failure -- all logged,
    // none fatal to the handshake's own verdict/exit code.
    //
    // HYK-224-3R §3 (REVIEW 2R 반려, 판단): a completion-bookkeeping failure
    // here does NOT flip this CLI's own exit code to nonzero, even though
    // §3's requirement literally says "네가 판단하라" on that question.
    // Reasoning: this CLI's exit code is the ROUND's pass/fail signal (did
    // the worker's task_id binding and staleness checks pass) -- conflating
    // it with "did an auxiliary capacity-tracking side effect also succeed"
    // would make every future round's success depend on admission-ledger
    // infra being reachable, which coder-task §4 keeps deliberately
    // env-gated/optional. The failure is instead made LOUD through two
    // durable, independent channels instead: (1) err.stderr now carries the
    // adapter's own detailed reason (3R fix: the adapter used to print
    // failures via console.log, so this branch's `err.stderr` was empty --
    // 검토자 실측 "세부 오류가 비어 있었다"; now console.error, so it's
    // here), and (2) the adapter durably appends a JSON line to
    // `${ledgerPath}.completion-failures.jsonl` BEFORE this process ever
    // sees the failure (coder-task §3: "화면에만 = 도달로 안 침").
    //
    // HYK-344 2R §4 후보ⓐ 채택 (review-r1-verbatim.md §A P1): the "두 통로"
    // above turned out to have zero readers for one of them (audit JSONL,
    // orch-measured-r1.md 잰 것1) -- so THIS CLI's own exit code still needs
    // to distinguish "attempted and genuinely failed" from "not attempted at
    // all" (env not wired -- an expected, harmless gap this repo has always
    // tolerated). The 3R reasoning above (round pass/fail must not depend on
    // admission-ledger reachability) is still honored: exit 0 (full success)
    // and exit 1 (round itself rejected) keep their EXACT pre-existing
    // meaning, untouched. A THIRD, previously-unused value is what an
    // automated caller now sees for this one narrow case (see
    // `lastAdmissionCompletionDetail`/`peekLastAdmissionCompletionDetail`
    // above and the CLI entry point below) -- never conflated with either
    // existing code, so no caller's existing 0-vs-1 branching changes.
    // ⚠️ORCH/코더 실측(2R, isolated-fixture 회귀에서 직접 재현): `err.status`
    // 만으로는 "어댑터가 실제로 실행돼 자기 판단으로 실패했다"와 "어댑터
    // 파일이 격리 픽스처에 아예 없어 node 자신이 모듈을 못 찾아 죽었다"를
    // 구별하지 못한다 -- 둘 다 exit 1을 공유한다(정확히 HYK-189 (h)가 이미
    // 고정한 "Node의 module-not-found도 CLI 자신의 exit(1)과 같은 코드를
    // 쓴다"는 바로 그 함정). 그래서 exit code가 아니라 stderr 모양으로
    // 가른다: 어댑터가 실제로 실행돼 도달한 모든 실패 경로는 예외 없이
    // "admission-completion-adapter: "로 시작하는 자기 사유 문구를 찍는다
    // (admission-completion-adapter.mjs의 모든 outcome.reason/console.error
    // 호출부가 그 접두어로 시작 -- 이 파일이 그 문자열을 지어내지 않고
    // 그대로 인용한다). Node 자신의 "Cannot find module" 에러 텍스트는 그
    // 접두어를 절대 만들지 않으므로, 이 판정은 실제 실행 여부를 신뢰성
    // 있게 가른다.
    const stderrText = String(err.stderr ?? "");
    lastAdmissionCompletionDetail = {
      attempted: stderrText.includes("admission-completion-adapter: "),
      ok: false,
      detail: err.stderr ?? err.message,
    };
    console.error(
      `relay-handshake: admission-completion spawn skipped/failed (non-fatal to this handshake's own exit code, HYK-224-3R §3 reasoning above): ${err.stderr ?? err.message}`,
    );
    return false;
  }
}

// HYK-342/HYK-249: mirrors spawnAdmissionCompletionProcess exactly (same
// subprocess-not-import reasoning, same try/catch/never-throws contract,
// same wasAdmissionCompletionAttempted stdout-string check) -- the one
// difference is the 4th/5th CLI args, which ask admission-completion-
// adapter.mjs to stamp `completion_reason: BLOCKED_TERMINATION_RELEASED`
// (admission-ledger-core.mjs's COMPLETION_REASON) on the released
// reservation instead of leaving it unset (the ok:true path's normal-
// completion shape). HYK-342 2R P1-1: the adapter now REQUIRES `role`
// (5th arg) to independently re-verify this round's own live result file
// before it will accept that reason -- this call always supplies it
// (checkRelayHandshake already confirmed BLOCKED/NEEDS_INPUT on that exact
// file moments ago, so the verification is redundant-but-consistent for a
// genuine call, and is exactly what a forged direct invocation lacks).
// Never changes checkRelayHandshake's own return value/exit code (same S11
// rationale as its sibling).
function spawnAdmissionAbortProcess(taskId, harnessDir, role) {
  try {
    const adapterPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "admission-completion-adapter.mjs",
    );
    // HYK-443: the adapter's verifyBlockedTerminationEvidence (admission-
    // completion-adapter.mjs) requires a 6th positional arg (receiptPath) to
    // find dispatch-receipts.jsonl -- this call used to stop at the 5th
    // (role), so the adapter's own resolveReceiptPathForVerification always
    // fell through to `DISPATCH_RECEIPT_PATH` env (never set by this repo's
    // own automated consumption path, only by a manually-run ORCH terminal)
    // and then to null -- BLOCKED_TERMINATION_RELEASED release therefore
    // ALWAYS failed with "(경로 미설정)" (coder-task.md §1-2 실물 재현).
    // ⛔새 관례 발명 금지(coder-task.md §2): this file's own
    // resolveDispatchLedgerPath (above) already resolves the exact same
    // pointer-file convention (`<harnessDir>/dispatch-receipt-path.txt`)
    // that resolveDispatchRecordExistence uses moments earlier in this same
    // handshake -- reused here unchanged, not re-derived. `undefined` (no
    // explicit path, no pointer file) resolves to `undefined`, which is
    // simply omitted from `args` below -- the adapter's own env fallback and
    // fail-closed null-path rejection are unchanged for that case.
    const resolvedReceiptPath = resolveDispatchLedgerPath(
      undefined,
      harnessDir,
    );
    const args = harnessDir
      ? [
          adapterPath,
          taskId,
          harnessDir,
          "BLOCKED_TERMINATION_RELEASED",
          role,
          ...(resolvedReceiptPath !== undefined ? [resolvedReceiptPath] : []),
        ]
      : [adapterPath, taskId];
    const out = execFileSync("node", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(out.trim());
    return wasAdmissionCompletionAttempted(out);
  } catch (err) {
    console.error(
      `relay-handshake: admission-abort spawn skipped/failed (non-fatal to this handshake's own exit code, HYK-342/HYK-249): ${err.stderr ?? err.message}`,
    );
    return false;
  }
}

// HYK-398 §2-⑶: spawnAdmissionAbortProcess(위)를 그대로 거울처럼 따른다 --
// 같은 서브프로세스-스폰(정적 import 아님) 계약, 같은 try/catch/never-
// throws 계약, 같은 wasAdmissionCompletionAttempted stdout 판독. 유일한
// 차이는 완료 사유(`RETIREMENT_RELEASED`, admission-ledger-core.mjs의
// COMPLETION_REASON -- SUSPECT_TIMEOUT_RECOVERED·BLOCKED_TERMINATION_
// RELEASED와 구별되는 세 번째 값)뿐이다. receiptPath(6번째 위치 인자)는
// 넘기지 않는다 -- RETIREMENT_RELEASED는 admission-completion-adapter.mjs
// 자신의 verifyRetirementEvidence가 은퇴 기록의 아카이브+지문 이중 대조로
// 이미 워커-위조 표면을 닫으므로(관제실 지시서 §1 표: 은퇴 기록 자체는
// ORCH가 쓰는 파일, 워커가 쓸 수 있는 결과 파일이 아니다), 배달 영수증
// 대조(BLOCKED_TERMINATION_RELEASED 전용 3R 방어, verifyBlockedTermination
// Evidence 자신의 헤더 참조)까지 요구하지 않는다.
function spawnAdmissionRetirementReleaseProcess(taskId, harnessDir, role) {
  try {
    const adapterPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "admission-completion-adapter.mjs",
    );
    const args = harnessDir
      ? [adapterPath, taskId, harnessDir, "RETIREMENT_RELEASED", role]
      : [adapterPath, taskId];
    const out = execFileSync("node", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(out.trim());
    return wasAdmissionCompletionAttempted(out);
  } catch (err) {
    console.error(
      `relay-handshake: admission-retirement-release spawn skipped/failed (non-fatal to this handshake's own exit code, HYK-398): ${err.stderr ?? err.message}`,
    );
    return false;
  }
}

// HYK-244 2R-a §2 조각2: resultFingerprint = 결과 파일 내용의 SHA-256(hex)
// -- ⛔지정(coder-task.md §2 원문), 다른 알고리즘을 고르지 않는다. This is
// a small, deliberate duplicate of consumption-receipt-writer.mjs's own
// `computeResultFingerprint` (same reason spawnAdmissionCompletion never
// statically imports its sibling adapter -- see spawnConsumptionReceiptWriter
// below): relay-handshake.mjs itself must stay inside the 4-file fixed
// dependency list the mutation-test isolation fixtures stage, and computing
// the fingerprint here (to decide whether it's even worth spawning the
// writer CLI) does not require importing anything beyond node:crypto
// (already a builtin import above).
function computeResultFingerprint(resultContent) {
  return createHash("sha256").update(resultContent, "utf8").digest("hex");
}

// HYK-244 2R-a §2 조각2: consumption-receipt-core.mjs's checkReviewVerdictLine
// counts exactly this -- REVIEW-family result 파일의 'verdict: approved|
// rejected' 줄 개수. Duplicated from reject-streak.mjs's own (unexported)
// VERDICT_LINE_RE_G (that file's line 26) for the same reason: this file
// needs the RAW count (0/1/2+), not reject-streak.mjs's own collapsed
// ok:false-on-ambiguous shape (`parseReviewOutcome` never exposes the count
// itself).
const VERDICT_LINE_RE_G = /^verdict:\s*(approved|rejected)\s*$/gim;

// HYK-449: 내보낸다 -- 시험/probe 가 이 축을 «생산 코드 그대로» 잴 수 있게
// (축마다 시험이 자기 복사본 정규식을 만들면 조용히 어긋난다).
export function countVerdictLines(resultContent) {
  // HYK-449: 인용된 `verdict:` 줄은 세지 않는다(위 maskQuotedMarkerRegions).
  return [...maskQuotedMarkerRegions(resultContent).matchAll(VERDICT_LINE_RE_G)]
    .length;
}

// HYK-244 2R-a §2 조각2: builds the consumption-receipt-core.mjs candidate
// shape (binding/effects/verdictLineCount) and spawns the writer CLI ONLY
// when every required effect for this role succeeded -- ⛔비타협: 부분
// 성공은 성공 영수증이 아니다(§2 원문). REVIEW 계열(isReviewFamilyRole,
// reject-streak.mjs 385-394행과 동일 규칙)만 ledgerRecorded를 필수로 본다,
// consumption-receipt-core.mjs의 requiredEffectKeysFor와 정확히 같은
// 판별. Never mutates checkRelayHandshake's own return value either way
// (같은 이유로 spawnAdmissionCompletion도 그렇다) -- 실패/스킵 모두
// console.error로만 드러난다.
function autoWriteConsumptionReceipt({
  role,
  harnessDir,
  resultContent,
  taskId,
  droppedAt,
  dispatchId,
  doneAt,
  envelopeArchived,
  taskArchived,
  admissionReturned,
  recordOutcome,
}) {
  const isReview = isReviewFamilyRole(role);
  const ledgerRecorded = isReview ? recordOutcome.ok : undefined;
  const requiredEffectsOk =
    envelopeArchived === true &&
    taskArchived === true &&
    admissionReturned === true &&
    (isReview ? ledgerRecorded === true : true);
  if (!requiredEffectsOk) {
    console.error(
      `relay-handshake: consumption receipt NOT written for ${taskId} -- 필수 후속효과 미확인(envelopeArchived=${envelopeArchived}, taskArchived=${taskArchived}, admissionReturned=${admissionReturned}${isReview ? `, ledgerRecorded=${ledgerRecorded}` : ""}) -- 부분 성공은 성공 영수증이 아니다(HYK-244 2R-a §2)`,
    );
    return;
  }

  // HYK-269 §2-1 조각1: binding.role만 정본 대문자로 굳힌다 -- dispatch-
  // gate-decision.mjs:1074의 currentBinding.role(`role.toUpperCase()`)과
  // 정확히 같은 정규화. 아래 spawnConsumptionReceiptWriter 호출의 최상위
  // `role`(영수증 파일명 조립에 쓰임, consumption-receipt-writer.mjs의
  // nextReceiptFileName)은 손대지 않는다 -- 파일명 관례(소문자)는 그대로
  // 둔다(coder-task.md §2-1 원문 비타협).
  const binding = {
    taskId,
    role: role.toUpperCase(),
    droppedAt,
    resultFingerprint: computeResultFingerprint(resultContent),
    dispatchId,
    doneAt,
  };
  const effects = isReview
    ? { envelopeArchived, taskArchived, admissionReturned, ledgerRecorded }
    : { envelopeArchived, taskArchived, admissionReturned };
  const verdictLineCount = isReview
    ? countVerdictLines(resultContent)
    : undefined;

  spawnConsumptionReceiptWriter({
    role,
    harnessDir,
    binding,
    effects,
    verdictLineCount,
  });
}

// HYK-244 2R-a §2 조각2: mirrors spawnAdmissionCompletion exactly (see that
// function's own header, right above) -- deliberately NOT a static import
// of consumption-receipt-writer.mjs, for the identical reason: the 6
// mutation-test isolation fixtures (hyk186-time-authority-mutation.test.mjs
// 등) stage relay-handshake.mjs inside a fixed 4-file clone (relay-
// handshake.mjs/time-authority.mjs/reject-streak.mjs/envelope-archive.mjs)
// -- a static import of a 5th file breaks module resolution at LOAD time
// for every mutation test in those files, not just the ones this feature
// touches. A subprocess spawn only fails at CALL time, absorbed by the
// try/catch below -- an isolated fixture missing the writer file degrades
// to a silent no-op, never a load error. Never changes checkRelayHandshake's
// own return value or exit code either way (same S11 rationale as
// spawnAdmissionCompletion).
function spawnConsumptionReceiptWriter({
  role,
  harnessDir,
  binding,
  effects,
  verdictLineCount,
}) {
  try {
    const writerPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "consumption-receipt-writer.mjs",
    );
    const payload = JSON.stringify({
      role,
      binding,
      effects,
      verdictLineCount,
    });
    const out = execFileSync("node", [writerPath, harnessDir, payload], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(out.trim());
  } catch (err) {
    // Missing writer file (isolated test fixture), non-zero exit, or any
    // other spawn failure -- all logged, none fatal to the handshake's own
    // verdict/exit code (mirrors spawnAdmissionCompletion's catch exactly).
    console.error(
      `relay-handshake: consumption-receipt-writer spawn skipped/failed (non-fatal to this handshake's own exit code): ${err.stderr ?? err.message}`,
    );
  }
}

// HYK-342/HYK-249: mirrors spawnConsumptionReceiptWriter exactly (same
// subprocess-not-import reasoning -- this file is staged into a small fixed-
// file mutation-test isolation clone, relay-handshake.mjs/time-authority.mjs/
// reject-streak.mjs/envelope-archive.mjs, and a 5th static import of
// abort-record-writer.mjs would break module resolution for every one of
// those tests at LOAD time; a spawn only fails at CALL time, absorbed by the
// try/catch below). Writes `<harnessDir>/aborts/<role>-abort-r<N>.json` via
// abort-record-writer.mjs's own CLI (HYK-298-abort-record-1) -- this is that
// writer's first production caller (its own header documented zero
// production callers before this round). Never changes checkRelayHandshake's
// own return value/exit code (same S11 rationale as its sibling).
function spawnAbortRecordWriter({
  role,
  harnessDir,
  harnessTaskLabel,
  dispatchId,
  droppedAt,
  leftoverFingerprint,
  leftoverPath,
  recordedAt,
  evidence,
}) {
  try {
    const scriptPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "abort-record-writer.mjs",
    );
    const payload = JSON.stringify({
      role,
      harnessTaskLabel,
      dispatchId,
      droppedAt,
      leftoverFingerprint,
      leftoverPath,
      recordedAt,
      evidence,
    });
    const out = execFileSync("node", [scriptPath, harnessDir, payload], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(out.trim());
    return true;
  } catch (err) {
    console.error(
      `relay-handshake: abort-record-writer spawn skipped/failed (non-fatal to this handshake's own exit code, HYK-342/HYK-249): ${err.stderr ?? err.message}`,
    );
    return false;
  }
}

// HYK-269 §2-1 조각2: 소비 CLI 진입점에서 role 인자가 정본 4개(CODER/
// REVIEW/VERIFY/PM) 중 하나인지 대소문자 무관으로 검증하는 허용 목록.
// ⚠️여기서는 role의 표기(대소문자)를 바꾸지 않고 그대로 통과시킨다 --
// resolveLiveRoundFilePaths(라이브 파일 경로)/envelope-archive.mjs(라운드
// 보관 파일명)/consumption-receipt-writer.mjs(영수증 파일명)이 전부 이
// role 문자열을 그대로 파일명 조립에 쓰므로, 여기서 케이스를 바꾸면
// «파일명 관례를 바꾸지 마라»는 비타협을 깬다. 정본 표기 정규화는 결속
// 기록(binding.role) 쪽에서만, 그 필드가 실제로 쓰이는 자리(아래
// autoWriteConsumptionReceipt의 binding 조립부)에서 한다.
const ALLOWED_ROLES = Object.freeze(["CODER", "REVIEW", "VERIFY", "PM"]);

function describeRoleUsage() {
  return `allowed roles: ${ALLOWED_ROLES.join(", ")}\nexample: node relay-handshake.mjs CODER .harness`;
}

// HYK-344 2R (review-r1-verbatim.md §A P1): this round genuinely finished
// (task_id binding + staleness all passed, `result.ok === true`) -- but that
// is not the same question as "did the admission-ledger reservation for it
// actually get released". `peekLastAdmissionCompletionDetail()` is set
// synchronously inside THIS process's own single `checkRelayHandshake` call
// (module-scoped slot, see its own header) -- exits 3 only when completion
// was genuinely ATTEMPTED and FAILED (e.g. a reservation key mismatch),
// never for the harmless "not attempted" gap (no ledger path resolved), so
// existing deployments that never wired ADMISSION_LEDGER_PATH keep seeing
// exit 0 exactly as before. A no-op (returns normally) whenever `result.ok`
// is false or the completion detail doesn't apply, so the caller's own
// pinned (result.ok) block always runs next exactly as before.
//
// HYK-344 3R (책임자 판정 2026-08-25 11:19, review-r2-verbatim.md §A P1
// 반려): full exit-code table + this fact are documented in
// `docs/relay-handshake-exit-code-contract.md` -- keep both in sync.
// ★★ WHO READS THIS RIGHT NOW: nothing in this repo spawns this CLI as a
// child process in a production path (검증됨 -- relay-handshake.test.mjs의
// "HYK-344 3R" 시험이 저장소 소스를 실제로 스캔해 이를 계약으로 고정한다,
// 관제실 dispatch-worker.ps1도 배달만 하지 이 CLI를 부르지 않는다는 사실은
// 그 ps1이 이 저장소 밖에 있어 CI가 못 닿으므로 사람이 확인한 사실로만
// 남는다). `checkRelayHandshake`를 함수로 import하는 in-process
// 호출자들(relay-core.mjs 등)은 프로세스가 아니라 반환값을 보므로 이
// exit code 자체를 볼 수 없다. ⇒ exit 3은 지금 **두 가지 뜻**을 동시에
// 갖는다: (1) 장차 supervisor 자동 호출 층(HYK-354, 이 라운드 범위 밖)이
// 읽을 신호다. (2) 지금은 ORCH(사람 역할)가 매 라운드 이 CLI를 손으로
// 치고 출력을 눈으로 읽는 것이 유일한 소비 경로다. ⛔이건 결함이 아니라
// "아직 안 만든 층"이다 -- 자동 호출 층을 여기서 급조하지 않는다.
function exitDistinctlyOnAdmissionCompletionFailure(result) {
  if (!result.ok) return;
  const completionDetail = peekLastAdmissionCompletionDetail();
  if (completionDetail?.attempted === true && completionDetail?.ok === false) {
    console.error(
      `relay-handshake: round completed but admission-ledger reservation release FAILED (${completionDetail.detail ?? "no detail available"}) -- exiting 3 (distinct from 0=full success / 1=round rejected) so an automated caller cannot mistake this for a clean success (HYK-344 2R)`,
    );
    process.exit(3);
  }
}

// HYK-353 §3-3: same "완료를 시도했으나 실패 -> exit 3" channel as
// exitDistinctlyOnAdmissionCompletionFailure above, applied to the
// first-observation spawn (spawnObserveDoneLine) -- a round genuinely
// finishing (task_id 결속/staleness 통과, `result.ok === true`) while its
// first-observation record genuinely ATTEMPTED and FAILED (e.g. the
// ENAMETOOLONG-class transport failure this task closes, or any future
// spawn failure) must not read as indistinguishable from a clean success.
// Never attempted (no taskId/droppedAtRaw yet, e.g. a rejected/blocked
// round that never reaches resolveDoneAt's observation call) stays exit 0,
// exactly like the admission-completion sibling above. This deliberately
// does NOT change checkRelayHandshake's own ok/state/reason -- §3-3's own
// caveat ("라운드의 합격/불합격 신호를 부수적 기록 실패와 뒤섞지 마라"는
// 원 설계 판단은 유지한다) is read literally: the round's verdict is
// untouched, only the CLI's exit code gains a second, distinguishable
// failure channel (mirroring HYK-344 2R's own precedent instead of
// inventing a new one).
function exitDistinctlyOnFirstObservationFailure(result) {
  if (!result.ok) return;
  const observationDetail = peekLastFirstObservationDetail();
  if (
    observationDetail?.attempted === true &&
    observationDetail?.ok === false
  ) {
    console.error(
      `relay-handshake: round completed but first-observation recording FAILED (${observationDetail.reason ?? "no detail available"}) -- exiting 3 (distinct from 0=full success / 1=round rejected) so an automated caller cannot mistake this for a clean success (HYK-353, mirrors HYK-344 2R's admission-completion channel)`,
    );
    process.exit(3);
  }
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/relay-handshake.mjs");
if (invokedDirectly) {
  const role = process.argv[2];
  if (!role) {
    console.error("usage: node relay-handshake.mjs <role> [harnessDir]");
    process.exit(1);
  }
  if (!ALLOWED_ROLES.includes(role.toUpperCase())) {
    console.error(`unknown role '${role}' -- ${describeRoleUsage()}`);
    process.exit(1);
  }
  // HYK-227 §2: spawnAdmissionCompletion is no longer called here directly
  // -- it now runs INSIDE checkRelayHandshake itself (see that function's
  // own ok:true branch, right before its return), so every caller gets it,
  // not just this CLI block. Calling it again here would double-spawn on
  // every CLI-path completion.
  const harnessDirArg = process.argv[3];
  // HYK-387 3R (자체 발견 결함 수리): 이 블록은 2R까지 `dispatchLedgerPath`
  // 를 자기 스스로 `process.env`에서 읽어 명시로 넘겼다 -- 그런데
  // `checkRelayHandshake`/`resolveDispatchRecordExistence` 자신이 이제
  // 같은 env(+포인터 파일)를 «자기 안에서» 이미 읽는다(위 헤더 참조).
  // 명시로 넘기면(비록 그 값이 "env를 그대로 읽어온 것"이어도)
  // `resolveDispatchLedgerPath`의 `explicit !== undefined` 분기가 즉시
  // 그 값을 채택해 버려, 코어 함수 자신의 env/포인터파일 fallback
  // 경로가 CLI를 통해서는 «한 번도 실행되지 않는» 사각을 만든다(3R
  // 작업 중 실측: 이 사각 때문에 되돌림 변이 hyk387-11이 fallback을
  // 실제로 무력화해도 CLI 경로에서는 그 무력화가 전혀 드러나지
  // 않았다 -- 이 줄 자체가 그 무력화를 우회하는 별도 경로였던 것).
  // 이 줄을 지워 CLI도 다른 모든 실 호출자와 완전히 같은 모양
  // (`{role, harnessDir}`, dispatchLedgerPath 키 자체를 안 넘김)으로
  // 부르게 한다 -- 이제 CLI 경로도 코어 함수의 fallback을 실제로 타고,
  // 그 fallback을 무력화하면 CLI 경로에서도 정직하게 드러난다.
  const result = harnessDirArg
    ? checkRelayHandshake({ role, harnessDir: harnessDirArg })
    : checkRelayHandshake({ role });
  // HYK-344 2R: kept as a call BEFORE the pinned (result.ok) block below,
  // rather than inlined inside it -- relay-handshake-cli-mutation-M3.test.mjs
  // (HYK-189 (e) mutation M3) pins that exact block's source text byte-for-
  // byte (`assertExactlyOneMatch`) to prove non-zero exit propagation is
  // load-bearing; inlining new lines inside it would break that pin without
  // changing anything the mutation itself tests. This call is a pure early
  // exit -- it returns normally (no-op) whenever exit 3 does not apply, so
  // the pinned block below is always reached exactly as before.
  exitDistinctlyOnAdmissionCompletionFailure(result);
  exitDistinctlyOnFirstObservationFailure(result);
  if (result.ok) {
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
