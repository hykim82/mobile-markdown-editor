// HYK-411 1R -- «러너가 자기 종료코드를 자기 손으로 적는» 영수증 생산자.
//
// §1 왜: `npm test 2>&1 | tail -N` 형태의 파이프는 종료코드를 마지막
// 명령(`tail`)의 것으로 바꿔치기한다 -- 실패한 러너가 파이프 뒤에서
// exit 0으로 보인다(coder-task.md §1 실측). 파이프는 러너 자신이 자기
// 파일에 적는 값은 바꿀 수 없으므로, 종료코드를 실제로 아는 프로세스
// (러너 자신, isolated-suite-runner.mjs)가 그 값을 파일에 쓰면 껍데기
// 셸이 무엇을 삼키든 진실이 남는다.
//
// ⛔이 모듈은 소비 판정(relay-handshake.mjs)에서 import되지 않는다 --
// 소비 쪽은 이 파일이 쓴 JSON을 그냥 읽기만 한다(fs.readFileSync +
// JSON.parse). relay-handshake.mjs를 고정 파일목록으로 격리 clone하는
// 다수의 mutation 시험(hyk186-time-authority-mutation.test.mjs 등)이
// 이미 있어, 그 파일에 새 정적 import를 추가하면 그 시험들의 고정
// sidecar 목록이 전부 이 파일도 알아야 하는 광범위한 파급이 생긴다 --
// admission-completion-adapter.mjs가 정확히 같은 이유로 정적 import되지
// 않고 이 저장소 전체가 "쓰는 쪽과 읽는 쪽은 별개 모듈" 관행을 쓰는 것과
// 동일 근거(consumption-receipt-writer.mjs 헤더 참조).
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RUNNER_RECEIPT_SCHEMA_VERSION = 2;
export const RUNNER_RECEIPT_FILENAME = "runner-receipt.json";

// HYK-473 §2-2: a receipt must be able to say "no measurement happened"
// as a DIFFERENT fact from "the tests failed" -- a forced kill (OOM,
// signal) means node --test never produced a real result, so a downstream
// reader (human or relay-handshake.mjs's fail-closed gate) that only ever
// saw runner_exit!=0 could not tell the two apart. TESTS_FAILED/OK cover
// the two cases where the child actually ran to completion and reported
// its own exit code; MEASUREMENT_UNAVAILABLE_OOM covers every case where
// it did not (isolated-suite-runner.mjs's classifySpawnOutcome is the only
// producer of this value, and it decides structurally on spawnSync's own
// signal/status/error fields -- never by matching message text, HYK-262).
export const RUNNER_STATUS = Object.freeze({
  OK: "OK",
  TESTS_FAILED: "TESTS_FAILED",
  MEASUREMENT_UNAVAILABLE_OOM: "MEASUREMENT_UNAVAILABLE_OOM",
});

// Callers that don't classify a spawn outcome themselves (this file's own
// pre-HYK-473 tests, e.g.) still get a sane runner_status: zero exit reads
// as OK, anything else as TESTS_FAILED -- the old (schema v1) behavior,
// preserved as a default rather than silently dropped.
function deriveRunnerStatus(runnerExit) {
  return runnerExit === 0 ? RUNNER_STATUS.OK : RUNNER_STATUS.TESTS_FAILED;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// KST는 DST가 없다 -- UTC에서 고정 +9h를 더하는 쪽이 호스트 머신의 로컬
// 타임존 설정에 기대는 것보다 안정적이다(finalize-done.mjs의 formatKst와
// 동일 근거·동일 구현 -- 그 파일을 import하지 않는 이유도 위 헤더와 같다:
// isolated-suite-runner.mjs는 relay/ 쪽 모듈에 의존하지 않는다).
export function formatKst(nowMs) {
  const kst = new Date(nowMs + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(
    kst.getUTCDate(),
  )} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(
    kst.getUTCSeconds(),
  )} KST`;
}

// `node --test`가 병기 tap reporter destination에 쓰는 표준 요약 줄
// (`# tests N` / `# pass N` / `# fail N` / `# skipped N`)을 파싱한다.
// 실측(이 라운드, node v26.2.0): 기본 reporter는 `ℹ`로, tap reporter는
// `#`로 같은 요약을 찍는다 -- 이 파서는 tap 목적지 파일을 대상으로 하므로
// `#`만 본다. 못 찾은 필드는 null로 남긴다(추정치로 메우지 않는다 --
// fail-closed는 소비 쪽 책임이고, 이 함수는 "모른다"를 정직하게 알린다).
//
// HYK-464 2R (검토 1R P2-1 실측, rounds/REVIEW-r1.md ⓕ): 이 run의 실제
// tapPath 파일에 중첩 `node --test` 자식(예: hyk359의 nested self-sweep)의
// 자기 요약이 부모 프로세스 요약보다 "먼저" `#` 줄로 섞여 들어간다 -- 1R의
// `new RegExp(...,"m").exec(...)`(g 없음, "첫 일치")는 그 가짜 블록을
// 집어, 실패한 실행(runner_exit 1)의 영수증이 "fail 0"을 적었다(검토
// 원문 인용 그대로: runner-receipt-run1.json이 tests 7 · fail 0을 적었는데
// 실제 runner_status는 TESTS_FAILED였다). 아래 정의가 그 공백을 메운다 --
// install-g1-adapter-list.test.mjs의 parseTapSummary ·
// hyk359-ambient-env-regression.test.mjs의 parseLastTapSummaryPair가 같은
// 규칙을 테스트 파일 안에 중복 정의한다(coder-task.md §2 ⓑ: 프로덕션
// 모듈 신설 금지 -- 세 곳이 같은 "요약 블록 경계" 규칙을 공유하되 import로
// 엮이지는 않는다).
//
// 경계 규칙: 진짜 node --test tap 요약은 항상 `# tests N` -> (중간에
// `# suites`/`# cancelled`/`# todo`/`# duration_ms`가 몇 개든 끼어도 됨,
// 이 필드들은 이 함수가 안 읽으므로 스킵 가능) -> `# pass N` -> (같은 스킵)
// -> `# fail N` -> (같은 스킵) -> `# skipped N` 순서로 "서로 다른 요약
// 필드만" 사이에 둔다. `# Subtest: ...`처럼 요약 필드가 아닌 임의의 `#`
// 줄은 스킵 대상이 아니다 -- 그래서 중첩 자식의 블록이 그 직후의 서브테스트
// 줄(TAP 구조상 반드시 뒤따른다)에서 매치가 끊겨, 진짜 블록까지 이어붙지
// 않는다(1R의 버그가 정확히 "임의의 `#.*` 줄은 다 건너뜀"이었다면 이
// 함수는 그 전철을 밟지 않는다 -- 단, 이 함수는 pick-per-field가 아니라
// "하나의 블록에서 네 필드를 함께" 뽑으므로 1R과 같은 결함 유형 자체가
// 없다).
//
// 중복 매치가 있으면 "마지막" 블록을 쓴다(검토 ⓑ 실측: 중첩 자식의
// 블록이 항상 부모 블록보다 먼저 온다). 마지막 완결 블록 "뒤"에 짝 없는
// `# tests N` 줄이 또 있으면(= 새 블록이 시작됐다가 못 끝났다 -- 잘린
// 요약) null을 돌려준다, 그 앞의(어쩌면 무관한) 블록 값을 "진짜인 척"
// 돌려주지 않는다 -- isolated-suite-runner.mjs의 hasTapCompletion은 이
// 함수의 `tests != null`을 "완결됐다"는 신호로 쓰므로(HYK-477 §2-3,
// classifySpawnOutcome), 잘린 꼬리를 조용히 과거 블록으로 메우면 진짜
// 강제종료/OOM을 "완결된 TESTS_FAILED"로 둔갑시킬 위험이 있다(P2-3,
// 2R 판단 -- 잘린 블록 = «판정 불가», «앞 블록» 아님).
const TAP_SKIPPABLE_FIELD_LINE =
  "(?:# (?:suites|cancelled|todo) \\d+|# duration_ms [\\d.]+)\\r?\\n";
const TAP_SUMMARY_BLOCK_RE = new RegExp(
  "^# tests (\\d+)\\r?\\n" +
    `(?:${TAP_SKIPPABLE_FIELD_LINE})*?` +
    "# pass (\\d+)\\r?\\n" +
    `(?:${TAP_SKIPPABLE_FIELD_LINE})*?` +
    "# fail (\\d+)\\r?\\n" +
    `(?:${TAP_SKIPPABLE_FIELD_LINE})*?` +
    "# skipped (\\d+)\\r?$",
  "gm",
);

// Isolated so hasGenuineTapCompletion below can look at the SAME blocks
// array parseTapSummaryCounts matched, without a second, possibly-diverging
// copy of TAP_SUMMARY_BLOCK_RE -- byte-for-byte the same matching this
// function always did (no behavior change for parseTapSummaryCounts).
function matchSummaryBlocks(text) {
  return [...text.matchAll(TAP_SUMMARY_BLOCK_RE)];
}

export function parseTapSummaryCounts(tapText) {
  const text = tapText ?? "";
  const empty = { tests: null, pass: null, fail: null, skip: null };
  const blocks = matchSummaryBlocks(text);
  if (blocks.length === 0) return empty;
  const last = blocks[blocks.length - 1];
  const tail = text.slice(last.index + last[0].length);
  if (/^# tests \d+/m.test(tail)) return empty;
  return {
    tests: Number(last[1]),
    pass: Number(last[2]),
    fail: Number(last[3]),
    skip: Number(last[4]),
  };
}

// HYK-209 §2 ⓐ (책임자 판정 2026-10-17 14:5x, P2-D 등재 후보 — 근거
// REVIEW-r2.md §3 P2-D/§2 R7c): parseTapSummaryCounts above answers "what
// are the counts in the LAST complete block", which is the right question
// for a run that genuinely finished. It is the WRONG question when the
// parent (outer `node --test`) itself never produced its own summary at
// all, and the only complete 4-field block in the file belongs to a
// SUBTEST's own leaked diagnostic output (a nested child's real tap stream,
// or -- the simpler, empirically-confirmed real mechanism, REVIEW-r1.md ⓕ
// -- a subtest printing plain `console.log("tests 7")`/`"pass 7"`/... lines
// with no leading "#", which node's own tap reporter then writes out
// verbatim as `# tests 7`/`# pass 7`/... because only a leading "#" in the
// printed text itself gets escaped). R7c is exactly that shape with nothing
// else in the file afterward: a forced-kill run whose only "complete" block
// is that leaked fake one.
//
// 구조적 신호(〔추론〕 -- HYK-209 2R P2-1, 검토 1R 지적으로 근거 표식 정정:
// 1R은 이 자리를 〔직접〕이라 적었지만, 실물 재현(검토 1R ⓑ 표 K1·K3·K4·N3,
// Windows · Node v26.2.0 4표본)에서 이 신호 하나만 지우는 변이(V1)를 넣어도
// 그 네 표본의 판정이 전혀 바뀌지 않았다 -- 즉 이 신호가 그 실물 표본들에서
// 실제로 일을 한 적이 없다는 뜻이다. 아래는 설계 의도의 서술이지 실물
// 관측으로 확인된 사실이 아니다): node --test가 실제로 끝까지 가서 찍는
// 최종 요약은 "닫히지 않은" `# Subtest: <name>` 구간 안에서 나오지 않는다는
// 것이 설계 전제다 -- 최종 요약은 모든 서브테스트가 각자 자기 결과줄
// (`ok N ...`/`not ok N ...`)로 닫힌 "뒤"에만 나온다. 반대로 서브테스트가
// 흘린 가짜 블록은 그 서브테스트 자신의 진단 구간 "안"에서 나오므로, 부모가
// 그 결과줄을 찍기 전에 죽으면(R7c) 그 구간은 영원히 닫히지 않는다. 그래서
// "마지막으로 고른 블록보다 앞에 열린(닫히지 않은) `# Subtest:` 구간이
// 하나라도 있는가"가 "이 블록이 진짜 최상위 요약인가"를 가르는 신호가
// 되도록 설계했다 -- 열림 줄과 닫힘 줄의 "개수"만 비교한다(정확한 짝
// 추적이 아니라 균형 카운트; 이 저장소의 기존 TAP 표본들(빈 파일 ·
// completedTapReadFile 류 · M4/S6/S7/S8)은 전부 `# Subtest:` 줄이 0개라
// 이 신호가 항상 "진짜"로 판정하므로, 이 변경은 그 표본들의 판정을 바꾸지
// 않는다 -- 정상 실행 무변경 요구를 만족한다〔직접〕).
//
// ⛔정직 한계 1/3(〔추론〕): 이 신호는 "서브테스트 구간이 제대로 닫혔는가"만
// 보는 근사 카운트이고, 여러 서브테스트에 걸쳐 열림/닫힘이 뒤섞인 극단적
// 교차 배치까지는 추적하지 않는다. 또한 중첩 가짜 블록이 "둘 이상"
// 연쇄되면서 그중 하나가 우연히 제 구간을 닫는 모양(이 라운드 범위 밖,
// §2 ⓐ는 "완결 가짜 블록 하나 + 부모 요약 전체 부재"만 요구)까지는
// 다루지 않는다.
// ⛔정직 한계 1-2/3(〔직접〕, HYK-209 2R P2-1 -- 검토 1R ⓘ 기록 정정): 이
// 신호가 R7C_WITH_UNCLOSED_SUBTEST_MARKER 표본(아래 시험 파일)을 판별하는
// "근거"라며 1R이 인용한 REVIEW-r1.md ⓕ 원문은 실제로는 반대 순서다 --
// 그 원문은 "가짜 줄(`# tests 7`…`# fail 0`)이 먼저 나오고 그 다음 줄이
// `# Subtest: ...`"라고 적었다(가짜 블록이 아직 안 닫힌 `# Subtest:` 구간
// "안"이 아니라 "앞"). 실물(K1·K3·K4·N3) 표본에서 이 신호가 실제로 어떤
// 일도 하지 않았다는 것(위 1/3)과 같은 결함의 두 얼굴이다 -- 이 모듈의
// R7C_WITH_UNCLOSED_SUBTEST_MARKER 단위 시험 자체는 합성 fixture로 여전히
// 통과하지만, 그 판정이 실물 재현에서 작동했다는 근거는 아니다.
const TAP_SUBTEST_OPEN_RE = /^# Subtest: .*\r?$/gm;
const TAP_SUBTEST_CLOSE_RE = /^(?:not )?ok \d+ .*\r?$/gm;

// ⛔정직 한계 2/2(〔직접〕, 이 라운드 실물 재현으로 발견): 위 marker-균형
// 신호는 "가짜 블록 바로 앞에 다른 서브테스트 출력이 조금이라도 있었던"
// 모양(REVIEW-r1.md ⓕ의 실제 관측 원문 — `# Subtest:`가 먼저 열리고, 그
// 열림이 끝까지 안 닫힌 채로 가짜 블록이 나온다)만 잡는다. 더 극단적인
// 모양 -- 단 하나뿐인 테스트가 가짜 블록을 찍은 "직후", 자기 자신의
// `# Subtest:` 여는 줄조차 디스크에 flush되기 전에 죽는 경우 -- 는 이
// 라운드 실제 강제종료 재현(fake.test.mjs, SIGKILL, 합성 저장소)에서
// 직접 관측됐다: tapPath 전문이 `TAP version 13\n# tests 9\n...`뿐이고
// `# Subtest:` 자체가 단 한 글자도 없다. 이 모양은 "서브테스트가 하나뿐이고
// 정상적으로 끝난 진짜 완결"(이 저장소 기존 시험 다수의 completedTapReadFile
// 류 표본과 바이트 단위로 동일)과 텍스트만으로는 구분 불가능하다 --
// marker-균형 신호가 여기서는 무력하다(열림 0 · 닫힘 0 → "닫힘 ≥ 열림"이
// 공허하게 참).
//
// 그래서 둘째 신호(아래 isDurationPlausible)를 더한다: 호출자가 실제로
// 측정한 "이 spawn 호출의 벽시계 경과 시간"(elapsedMs, isolated-suite-
// runner.mjs의 spawnSuiteInClone이 Date.now() 전후로 잰다)과, 블록이 자기
// 입으로 주장하는 `# duration_ms`를 맞대어 본다 -- 진짜 최상위 요약의
// duration_ms는 "그 프로세스가 실제로 산 시간"과 가까워야 한다(node
// 자신의 시작/종료 오버헤드만큼만 작을 수 있다). 가짜 블록은 그 프로세스가
// 죽기 전까지 실제로 산 시간과 무관한 값(이 라운드 재현값 "1.0")을 찍는다
// -- 재현: elapsedMs ≈ 3000(spawnSync timeout) · 블록 duration_ms = 1.0 →
// 비율 1/3000, 명백히 "그 프로세스가 실제로 산 시간"일 수 없다.
// `elapsedMs`가 주어지지 않거나(기존 호출자 전부 -- 이 필드를 모른다) 이
// MIN_ELAPSED_FOR_CHECK_MS(2초) 미만이면(타이밍 잡음/시작 오버헤드가 비율을
// 지배할 수 있는 영역) 이 신호는 그냥 "적용 안 함"(진짜로 간주)으로 빠진다
// -- 정상 실행 무변경 요구(기존 시험 전부가 elapsedMs를 안 주거나 노이즈
// 바닥 아래다)를 건드리지 않는다〔직접〕. 이 저장소의 실제 전건 러너는 수십
// 초~분 단위이므로(runner_axis 주석) 그 범위 밖은 이 round의 실제 사용처에
// 영향이 없다.
// ⛔정직 한계(〔추론〕): 이 비율 임계값(0.5)은 설계 선택이고, 극단적으로
// 느린 node 시작 오버헤드를 가진 환경에서는 아주 짧은 진짜 완결을 과잉
// 거부할 수 있다 -- 그 경우도 "측정 불가"로 접지, "가짜 초록"으로 접지는
// 않으므로 이 모듈의 "정직 > 완결" 원칙과 같은 방향의 오차다.
//
// HYK-209 2R P1-2(검토 1R 실측 K2·K5, 책임자 판정 2026-10-17 18:4x 판단 1):
// 1R은 "duration_ms가 없으면 진짜로 간주"했다 -- 생산 경로(elapsedMs가 실제로
// 주어짐)에서는 이것이 그대로 우회로였다(K5: 가짜 블록이 duration_ms를 아예
// 안 찍는다). 그래서 production 경로(elapsedMs가 노이즈 바닥 이상으로 주어짐)
// 에서만 두 가지를 추가로 요구한다 -- ⒜ 최종 블록 뒤에 실제 `# duration_ms`가
// 있어야 한다(없으면 더 이상 "적용 안 함"이 아니라 "가짜") ⒝
// hasGenuineTapCompletion 쪽에서, 그 블록 바로 앞에 열 0 TAP 계획 줄
// (`1..N`)이 있어야 한다. 서브테스트가 흘리는 위조 블록은 node 자신의 tap
// reporter가 서브테스트 출력 앞에 "#"를 붙여 이스케이프하므로(`# 1..9`),
// 가짜 블록은 구조적으로 열 0 계획 줄을 가질 수 없다(REVIEW-r1.md ⓑ K5
// TAP 원문 실측: `# 1..9`). 기존 fixture(elapsedMs 미지정이거나 노이즈
// 바닥 아래)는 이 두 요구 모두를 건너뛰므로 무변경이다.
const MIN_ELAPSED_FOR_CHECK_MS = 2000;
const MIN_DURATION_RATIO = 0.5;
const TRAILING_DURATION_RE = /^(?:# todo \d+\r?\n)?# duration_ms ([\d.]+)\r?$/m;
// 생산 경로 전용 ⒝ 계획 줄 신호 -- 절대 시작 또는 직전 개행 바로 뒤, 그리고
// 그 블록의 시작 바로 앞에서 끝나야 한다(둘 사이에 다른 줄이 끼면 "바로
// 앞"이 아니므로 불일치).
const PRODUCTION_PLAN_LINE_RE = /(?:^|\n)1\.\.\d+\r?\n$/;

function isProductionPathElapsed(elapsedMs) {
  return Number.isFinite(elapsedMs) && elapsedMs >= MIN_ELAPSED_FOR_CHECK_MS;
}

function isDurationPlausible({ blockEndIndex, text, elapsedMs }) {
  if (!isProductionPathElapsed(elapsedMs)) {
    return true; // not enough signal to second-guess the marker check
  }
  const window = text.slice(blockEndIndex, blockEndIndex + 300);
  const m = TRAILING_DURATION_RE.exec(window);
  // HYK-209 2R P1-2 ⒜: on the production path (elapsedMs given, above the
  // noise floor), a block with no duration_ms at all is no longer treated as
  // genuine by default -- a real spawnSuiteInClone caller always measures
  // elapsedMs, so a genuine top-level summary from THAT path should carry its
  // own duration_ms too; only non-production callers (no elapsedMs / below
  // the floor) still get the old "nothing to cross-check" pass above.
  if (!m) return false;
  const blockDurationMs = Number(m[1]);
  return blockDurationMs >= elapsedMs * MIN_DURATION_RATIO;
}

export function hasGenuineTapCompletion(tapText, { elapsedMs } = {}) {
  const text = tapText ?? "";
  const blocks = matchSummaryBlocks(text);
  if (blocks.length === 0) return false;
  const last = blocks[blocks.length - 1];
  const blockEndIndex = last.index + last[0].length;
  const tail = text.slice(blockEndIndex);
  if (/^# tests \d+/m.test(tail)) return false;
  const before = text.slice(0, last.index);
  const opens = [...before.matchAll(TAP_SUBTEST_OPEN_RE)].length;
  const closes = [...before.matchAll(TAP_SUBTEST_CLOSE_RE)].length;
  if (closes < opens) return false;
  // HYK-209 2R P1-2 ⒝: production path only -- the matched block must be
  // immediately preceded by a genuine, unescaped, column-0 TAP plan line.
  if (
    isProductionPathElapsed(elapsedMs) &&
    !PRODUCTION_PLAN_LINE_RE.test(before)
  ) {
    return false;
  }
  return isDurationPlausible({ blockEndIndex, text, elapsedMs });
}

// Combines the above with parseTapSummaryCounts -- the counts a receipt
// should actually record. When hasGenuineTapCompletion is false, this
// returns the SAME null-filled shape parseTapSummaryCounts returns for "no
// summary at all", never the leaked block's fake numbers (coder-task.md §2
// ⓐ-1: "영수증이 TESTS_FAILED·fail 0 이 되지 않게").
export function parseGenuineTapSummaryCounts(tapText, { elapsedMs } = {}) {
  const empty = { tests: null, pass: null, fail: null, skip: null };
  if (!hasGenuineTapCompletion(tapText, { elapsedMs })) return empty;
  return parseTapSummaryCounts(tapText);
}

// HYK-477 §1-3: "the run's own max concurrent `node` process count", a
// machine-observed value (never a human report) so a downstream reader can
// tell "the concurrency cap actually held" apart from "nobody ever checked"
// after the fact from the receipt alone. `null` means the measurement
// itself was unavailable (sampler failed to start/stop cleanly, or this
// caller predates the field) -- a DIFFERENT fact from "0 processes seen",
// so it is never coerced to 0.
// HYK-464 §2 ⓐ-1/ⓐ-2: `node_version` records exactly which Node binary ran
// this run's `node --test` child (isolated-suite-runner.mjs's
// spawnSuiteInClone spawns that child via `process.execPath`, i.e. the SAME
// binary as this runner process itself -- so the parent's own
// `process.version` IS the child's version, verbatim, with no separate
// "ask the child" step needed). `node_version_warning` is null when that
// version's major agrees with package.json's declared `engines.node`
// major, a descriptive string on a real mismatch, and a DIFFERENT
// descriptive string (never a silent null) when the comparison itself
// could not be made (engines.node undeclared/unparseable, or
// process.version unparseable) -- "판정 불가" must never collapse into
// "0 경고" (coder-task.md §2 ⓐ-2 "조용히 0 금지"). Never blocks: this
// field rides the receipt alongside an unaffected runner_exit/runner_status,
// the same "report, don't gate" posture as max_concurrent_node above.
// Pulled out of buildRunnerReceipt below so that function's own
// complexity gate doesn't absorb these four counts fields' `?.`/`??`
// branches (HYK-464 §2 ⓐ-1: adding node_version/node_version_warning
// pushed the inline version over the limit) -- no behavior change, this is
// byte-for-byte the same `counts?.[key] ?? null` four call sites previously
// wrote out individually.
function countField(counts, key) {
  return counts?.[key] ?? null;
}

export function buildRunnerReceipt({
  runnerExit,
  runnerStatus,
  counts,
  headCommit,
  finishedAtMs,
  maxConcurrentNode,
  nodeVersion,
  nodeVersionWarning,
}) {
  return {
    schema_version: RUNNER_RECEIPT_SCHEMA_VERSION,
    runner_exit: runnerExit,
    runner_status: runnerStatus ?? deriveRunnerStatus(runnerExit),
    tests: countField(counts, "tests"),
    pass: countField(counts, "pass"),
    fail: countField(counts, "fail"),
    skip: countField(counts, "skip"),
    head_commit: headCommit,
    finished_at: formatKst(finishedAtMs),
    max_concurrent_node: maxConcurrentNode ?? null,
    node_version: nodeVersion ?? null,
    node_version_warning: nodeVersionWarning ?? null,
  };
}

// `<root>/.harness/runner-receipt.json`에 쓴다. ⛔.harness/는 gitignore라
// CI·새 clone에는 애초에 없다(coder-task.md §2-1 정직 의무) -- 그 디렉터리가
// 없으면 만든다. §2-1 "실패했다고 영수증을 안 쓰면 안 된다"를 만족하려면
// 이 함수 자체는 절대 예외를 삼켜 "썼다"고 거짓 보고하지 않되, 호출자
// (runIsolatedSuite)는 이 쓰기가 실패해도 러너 자신의 exit code 전파를
// 절대 막지 않는다(그 쪽은 try/catch로 감싼다 -- 영수증을 못 쓰는 것이
// 시험 결과 자체를 감춰서는 안 된다).
//
// ⛔이 파일은 "최신본" 하나만 이 경로에 쓴다 -- 회차별(run-scoped) 사본은
// 별개 함수(allocateRunSlot/writeNumberedRunnerReceipt, 아래)가 맡는다.
// HYK-485 §2-1: 기존 이 함수의 시그니처/동작을 한 글자도 바꾸지 않는 것
// 자체가 "기존 runner-receipt.json 독자 무영향" 요구의 증명이다.
export function writeRunnerReceipt({
  harnessDir,
  runnerExit,
  runnerStatus,
  counts,
  headCommit,
  finishedAtMs,
  maxConcurrentNode,
  nodeVersion,
  nodeVersionWarning,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
}) {
  const dir = harnessDir;
  mkdirFn(dir, { recursive: true });
  const receipt = buildRunnerReceipt({
    runnerExit,
    runnerStatus,
    counts,
    headCommit,
    finishedAtMs,
    maxConcurrentNode,
    nodeVersion,
    nodeVersionWarning,
  });
  const path = join(dir, RUNNER_RECEIPT_FILENAME);
  writeFileFn(path, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  return { path, receipt };
}

// HYK-485 §1 실측(HYK-480 1R): 러너를 정직하게 2회 돌려도, 영수증 경로가
// `.harness/runner-receipt.json` 하나뿐이라 2회차가 1회차를 같은 경로에
// 덮어썼다 -- 배달 후 남은 기계 증거는 "2회차 영수증 하나"뿐이었고, 1회차는
// 산문 주장으로만 존재했다. 이 두 export는 회차별(run-scoped) 사본
// (`runner-receipt-run<N>.json` · `full-runner-<N>.log`)을 "기계로" 남겨
// 그 병을 없앤다.
export const RUNNER_RECEIPT_RUN_PREFIX = "runner-receipt-run";
export const RUNNER_LOG_PREFIX = "full-runner-";
const RUN_SLOT_MAX_ATTEMPTS = 10000;
const RUN_SLOT_NAME_RE = new RegExp(
  `^${RUNNER_RECEIPT_RUN_PREFIX}(\\d+)\\.json$`,
);

// HYK-485 §2-2 2R (검토 P2-2, rounds/REVIEW-r1.md): 소비 쪽(relay-
// handshake.mjs)은 "가장 큰 N이 가장 최근"이라고 가정한다(entries.slice(-2)).
// 시작점을 항상 1로 두고 "첫 빈 자리"를 wx로 차지하면, 중간 파일이 지워진
// 뒤의 재할당이 그 빈 자리를 다시 채운다 -- 실제로는 다섯 번째 실행인데
// 파일 이름은 2번이 된다(검토 재현: run2 삭제 후 재할당 -> 5가 아니라 2).
// 그러면 소비 쪽의 "가장 큰 N" 가정이 깨져 실제로 가장 최근인 실행이
// 조용히 무시된다. 시작점을 "지금 있는 가장 큰 N + 1"로 두면(비어 있으면
// 1) 지워진 자리는 다시 채워지지 않고 번호가 항상 앞으로만 늘어나 그
// 가정이 다시 참이 된다. 이 읽기와 그 다음 wx 배타 생성 사이에는 여전히
// 경쟁이 있을 수 있지만(다른 프로세스가 그 사이 같은 N을 먼저 차지),
// 그 경쟁은 아래 EEXIST 재시도 루프가 그대로 흡수한다 -- 이 함수가 이미
// "경쟁에서 진 쪽은 다음 N으로"를 보장하므로 시작점이 어디든 유일성은
// 깨지지 않는다(바뀌는 것은 "재사용 여부"뿐, "경쟁 안전성"은 무영향).
function nextRunSlotStart(harnessDir, readdirFn) {
  let names;
  try {
    names = readdirFn(harnessDir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const name of names) {
    const m = RUN_SLOT_NAME_RE.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// §2-1 "회차 번호 <N>을 무엇으로 정할지" 근거: 기존 파일 개수를 세어
// 정하는 방식은 "세기"와 "쓰기" 사이에 다른 프로세스가 끼어들 수 있는
// TOCTOU 경쟁을 안고 있다(두 실행이 같은 카운트를 보고 같은 N을 고를 수
// 있다) -- 그게 바로 이 이슈가 고치려는 병(경로 하나 공유)의 재판이다.
// 대신 각 N의 영수증 자리를 배타적 생성("wx" == O_CREAT|O_EXCL, POSIX와
// Windows(CreateFile CREATE_NEW) 양쪽에서 원자적)으로 "먼저 차지한 쪽만
// 그 N을 갖는다"로 만든다 -- 경쟁에서 진 프로세스는 EEXIST를 받고 다음
// N을 시도한다. 이 루프 자체가 "동시 실행에서 충돌하지 않는다"는 근거다
// (coder-task.md §8 ⓐ 정직 한계: 이 파일이 사는 harnessDir 자체가 서로
// 다른 워크트리마다 별개이므로, 여기서 막는 경쟁은 "같은 워크트리 안에서"
// 겹치는 경우로 범위가 한정된다 -- 그 범위 안에서는 이 방식이 정말로
// 막는다, 단순 카운팅은 그 범위 안에서도 못 막는다).
export function allocateRunSlot({
  harnessDir,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  readdirFn = readdirSync,
  maxAttempts = RUN_SLOT_MAX_ATTEMPTS,
}) {
  mkdirFn(harnessDir, { recursive: true });
  const start = nextRunSlotStart(harnessDir, readdirFn);
  for (let n = start; n < start + maxAttempts; n++) {
    const receiptPath = join(
      harnessDir,
      `${RUNNER_RECEIPT_RUN_PREFIX}${n}.json`,
    );
    try {
      // 빈 자리표시자 -- 이 wx 생성의 성공 자체가 "이 프로세스가 N을
      // 차지했다"는 증명이다. 실제 내용은 run이 끝난 뒤
      // writeNumberedRunnerReceipt가 덮어쓴다.
      writeFileFn(receiptPath, "", { flag: "wx" });
      return {
        runNumber: n,
        receiptPath,
        logPath: join(harnessDir, `${RUNNER_LOG_PREFIX}${n}.log`),
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // 경쟁에서 졌다 -- 다음 N으로.
    }
  }
  throw new Error(
    `allocateRunSlot: exhausted ${maxAttempts} attempts under ${harnessDir} -- refusing to loop forever`,
  );
}

// allocateRunSlot이 예약한 자리표시자를 실제 영수증 내용으로 덮어쓴다.
// writeRunnerReceipt와 같은 payload 모양(buildRunnerReceipt 재사용)이지만
// 대상 경로가 고정 RUNNER_RECEIPT_FILENAME이 아니라 호출자가 이미
// allocateRunSlot에서 받은 receiptPath다.
export function writeNumberedRunnerReceipt({
  receiptPath,
  runnerExit,
  runnerStatus,
  counts,
  headCommit,
  finishedAtMs,
  maxConcurrentNode,
  nodeVersion,
  nodeVersionWarning,
  writeFileFn = writeFileSync,
}) {
  const receipt = buildRunnerReceipt({
    runnerExit,
    runnerStatus,
    counts,
    headCommit,
    finishedAtMs,
    maxConcurrentNode,
    nodeVersion,
    nodeVersionWarning,
  });
  writeFileFn(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  return { path: receiptPath, receipt };
}
