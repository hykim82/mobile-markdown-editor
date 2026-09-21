// HYK-419-wire-1 (coder-task.md §2⑵) -- retire-author-shadow의 CLI 진입점.
//
// ★왜 CLI로 분리했는가 (relay-handshake.mjs에 직접 정적 import하지 않은
// 이유): 이 파일이 처음 이 관측을 relay-handshake.mjs 안에 assembleAuto
// AuthorFacts/evaluateAutoAuthorAuthorization의 **정적 import**로 심었을
// 때, 이 저장소의 격리 픽스처 시험 24개(admission-completion-spawn.test.mjs
// 등 -- relay-handshake.mjs를 "정확히 알려진 형제 파일 목록"(time-authority/
// reject-streak/envelope-archive)만 복사해 격리 디렉터리에서 서브프로세스로
// 돌리는 시험들)가 전부 MODULE_NOT_FOUND로 깨졌다(실측: npm test 5819개 중
// 60개 실패). abort-record-writer.mjs/admission-completion-adapter.mjs가
// 이미 정확히 같은 이유로 "정적 import 대신 서브프로세스 스폰"을 쓰고
// 있었다(spawnAbortRecordWriter의 자기 주석: "a 5th static import ... would
// break module resolution for every one of those tests at LOAD time; a spawn
// only fails at CALL time, absorbed by the try/catch") -- 이 라운드는 그
// 선례를 그대로 따른다: relay-handshake.mjs는 이 파일을 정적 import하지
// 않고, `node retirement-auto-author-shadow-cli.mjs <role> <taskId>
// [harnessDir] [doneAt]`로 스폰만 한다. 이 CLI 파일 자신이 격리 픽스처에
// 없으면 스폰이 실패하고(child_process 에러), 부모(relay-handshake.mjs)의
// 자체 try/catch가 그 실패를 흡수한다 -- 이 파일이 있든 없든 소비 자체는
// 절대 막히지 않는다(coder-task.md §2⑷ 차단 0).
//
// ★계약: 이 CLI는 무엇을 하든 표준출력에 정확히 한 줄
// (`retire-author-shadow: ...`)을 찍고 **항상 exit 0**으로 끝난다 -- 판정
// 불가/조립 불가/예상 밖 예외 어느 것도 이 CLI 자신의 종료코드에 반영되지
// 않는다(부모가 exit code를 읽지 않고 stdout만 그대로 console.log하기
// 때문에, exit 0이 아니면 부모의 execFileSync가 예외를 던져 그 stdout 자체를
// 잃는다 -- 이 CLI는 그 경로를 만들지 않는다).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { assembleAutoAuthorFacts } from "./retirement-auto-author-facts.mjs";
import { evaluateAutoAuthorAuthorization } from "./retirement-auto-author-core.mjs";
import { PERSISTENT_LEDGER_POINTER_FILENAME } from "./ledger-pointer-shared.mjs";

// HYK-412 1R -- 이 CLI는 relay-handshake.mjs가 `env`를 명시로 넘기지 않고
// 스폰하는데(부모 환경을 상속), 그 환경변수(ADMISSION_LEDGER_PATH/
// DISPATCH_RECEIPT_PATH)를 세팅하는 주체가 실제 배달 경로 어디에도 없어
// 매번 undefined -> LEDGER_UNREADABLE로 죽었다(실측 5건, coder-task.md
// §1). 아래 두 resolve* 함수는 admission-completion-adapter.mjs의
// resolvePersistentLedgerPaths()(포인터 파일 `.harness/admission-ledger-
// path.json`, mainRepoRoot 기준)와 relay-handshake.mjs 자신의
// resolveDispatchLedgerPath()(포인터 파일 `<harnessDir>/dispatch-receipt-
// path.txt`)와 **같은 개념**이다 -- coder-task.md §2⑵ "이미 있는 관용구를
// 재사용하라, 새 방식을 발명하지 마라"에 따라 새로 지어내지 않았다.
// ★2R 문면 정정(coder-task.md §2⑶, 2R 검토 P1-1이 지적한 실사고): 1R은
// 여기서 mainRepoRoot가 "모든 워크트리에서 같은 파일로 수렴한다"고
// 적었었는데, 그 문장은 1R이 실제로 검증한 것보다 넓었다(bare 저장소
// 기반 워크트리에서는 수렴하지 않았다, 아래 §HYK-412 2R P1-1 참조 --
// 지금은 2R 수리로 그 배치도 수렴하지만, 이 CLI가 "지원한다"고 말할 수
// 있는 배치는 여전히 **직접 격리 픽스처로 실측한 것만**이다: 일반 링크드
// 워크트리 · bare 저장소 기반 링크드 워크트리 · 메인 저장소 자신(비-
// 워크트리, `.git`이 디렉터리인 경우). retirement-auto-author-shadow-
// cli.test.mjs가 이 세 모양 + 다른 CWD 축을 직접 구동해 고정한다 -- 그
// 밖의 모양(예: git이 내부 포맷을 바꾸거나, `.git` 파일이 예상 밖 형식일
// 때)은 지원 선언 밖이며, 그때는 §정직 한계에 적은 대로 안전측
// (LEDGER_PATH_UNRESOLVABLE)으로 접힌다. relay-handshake.mjs를
// 정적 import하지 않고 로직만 재현한 이유는 이 파일 자신의 헤더(위)가
// 이미 밝힌 것과 같다: 이 CLI가 relay-handshake.mjs의 전체 import
// 그래프(reject-streak/envelope-archive/time-authority 등)에 묶이면,
// admission-completion-spawn.test.mjs 등이 고정한 "정확히 이 4개 형제
// 파일만" 격리 픽스처 모양이 이 파일을 통해 다시 깨질 위험이 생긴다
// (admission-completion-adapter.mjs가 mainRepoRoot()/repoRoot()를
// import 대신 복제한 것과 동일한 이유, 그 파일 자신의 주석 참조).
//
// ⚠️ mainRepoRoot는 여기서 **git 서브프로세스를 스폰하지 않는다**(1차
// 구현은 admission-completion-adapter.mjs와 똑같이 `execSync("git ...",
// {cwd: harnessDir})`를 그대로 재현했으나, 그 1차 구현이 실측으로 드러낸
// 새 회귀가 있었다: 이 CLI는 매 소비마다 스폰되고(부모 relay-handshake.mjs
// 자신도 이미 이 CLI를 스폰한다, 3단 프로세스), harnessDir을 cwd로 git을
// 또 스폰하면 Windows에서 그 디렉터리가 곧이어 rmSync되는 시험 20개가
// EPERM(디렉터리 사용 중)으로 무더기 실패했다 -- npm test 재실행 실측,
// 1R 자신의 1차 커밋에서 발견. git 서브프로세스가 필요한 진짜 이유는
// "링크드 워크트리의 .git이 디렉터리가 아니라 상위 저장소를 가리키는
// 포인터 파일"이라는 사실 하나뿐이고, 그 사실은 git 바이너리 없이
// 파일시스템만으로도 그대로 읽을 수 있다(git 자신의 온디스크 규약 --
// `.git`가 파일이면 그 내용이 정확히 `gitdir: <메인>/.git/worktrees/
// <이름>`이다, 이 워크트리 자신의 `.git` 파일로 직접 확인). 아래는 그
// 파싱을 재현한 것 -- "git-common-dir을 구한다"는 목적은 그대로이고
// (같은 관용구, 다른 실행 수단), 서브프로세스 스폰 0이라 위 회귀 자체가
// 구조적으로 없다.
//
// HYK-412 2R P1-1(검토 반려, coder-task.md §1): bare 저장소 기반 링크드
// 워크트리에서 `.git` 파일은 `gitdir: <bare>/worktrees/<이름>`을
// 가리킨다(일반 저장소의 `<메인>/.git/worktrees/<이름>`과 달리 `.git`
// 세그먼트가 없다 -- bare 저장소 디렉터리 자신이 곧 git 디렉터리이기
// 때문). 1R의 fs 구현은 `/worktrees/<이름>` 접미어를 제거한 뒤 **무조건
// `dirname()`을 한 번 더** 적용했는데, 이건 "메인 저장소는 항상
// `<루트>/.git/worktrees/<이름>` 모양이다"를 암묵적으로 가정한 것이고
// bare에서는 거짓이다(그 경우 접미어 제거 결과가 이미 저장소 루트
// 자신이다, 한 단계 더 올라가면 그 부모로 새 버린다).
//
// ★§1⑴-b 실측 판정(coder-task.md가 요구): 이 버그는 "서브프로세스를
// 버리고 fs 파싱으로 바꾼 결정" 자체의 결과가 **아니다** -- 직접 확인:
// admission-completion-adapter.mjs가 실제로 쓰는 git-서브프로세스 버전
// (`git rev-parse --git-common-dir`의 결과 문자열에 정규식
// `/[\\/]\.git$/`으로 "끝이 정확히 '/.git'이면만" 조건부로 그 접미어를
// 벗기는 방식)을 이 워크트리에서 직접 재현해 같은 bare 픽스처에 돌려
//봤더니 **처음부터 정확한 bare 루트를 그대로 돌려줬다**(bare 디렉터리
// 경로는 보통 "*.git"으로 끝나긴 해도 그 앞에 경로 구분자가 오는 위치가
// 아니라 정규식이 매치하지 않는다 -- 실측: `.../bare-repo.git`이 그대로
// 나옴, 벗겨지지 않음). 즉 원래 관용구는 "무조건 한 단계 위로"가 아니라
// "정확히 '/.git'로 끝날 때만 벗긴다"는 **조건부** 로직이었는데, 1R의 fs
// 포팅 과정에서 그 조건을 놓치고 무조건 `dirname()`으로 옮겨 적은 것이
// 이번 회귀의 실제 원인이다(내 포팅 실수, EPERM 회피 결정과는 무관).
//
// 수리: 조건부 스트립을 되살리되, dispatch-gate-decision.mjs의
// resolveRepoRoot가 이미 정확한 신호로 쓰는 "이 디렉터리가 bare
// 저장소인가"를 **그 파일과 같은 개념**(`--is-bare-repository`가 내부적
// 으로 읽는 신호, git의 config 파일 `core.bare`)으로 판별한다 -- 정규식
// 접미어 매칭(admission-completion-adapter.mjs 버전)보다 더 정확하다
// (bare 저장소 디렉터리 이름이 우연히 정확히 ".git"으로 끝나는 극단
// 사례까지 올바르게 구별한다, §정직 한계 참조). 여기서도 서브프로세스는
// 스폰하지 않는다 -- `config` 파일 자체를 읽어 `bare = true` 줄이
// 있는지만 본다(git이 `--is-bare-repository`를 판정할 때 참조하는 바로
// 그 값).
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function findGitEntry(startDir) {
  let dir = startDir;
  for (;;) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) return gitPath;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const WORKTREE_GITDIR_SUFFIX_RE = /[\\/]worktrees[\\/][^\\/]+[\\/]?$/;
const BARE_CONFIG_RE = /^[ \t]*bare[ \t]*=[ \t]*true[ \t]*$/im;

// gitDir이 bare 저장소 자신인지 -- git이 `core.bare`를 판정하는 것과 같은
// 신호(그 디렉터리의 `config` 파일)를 서브프로세스 없이 직접 읽는다.
// 확인 불가(파일 없음/못 읽음)면 null("모른다") -- 호출자는 이를 "아니다"
// 취급해 기존 non-bare 경로(무조건 dirname 한 단계)로 안전하게 접는다
// (1R이 이미 하던 동작과 동일, 새 실패 모드를 얹지 않는다).
function isBareGitDirectory(gitDir) {
  try {
    const configText = readFileSync(join(gitDir, "config"), "utf8");
    return BARE_CONFIG_RE.test(configText);
  } catch {
    return null;
  }
}

function mainRepoRoot(startDir) {
  if (!isNonEmptyString(startDir)) return startDir;
  const gitPath = findGitEntry(startDir);
  if (!gitPath) return startDir;
  let stat;
  try {
    stat = statSync(gitPath);
  } catch {
    return startDir;
  }
  if (stat.isDirectory()) {
    // 메인 저장소 자신 -- .git이 디렉터리다, 그 부모가 곧 루트.
    return dirname(gitPath);
  }
  // 링크드 워크트리 -- .git은 "gitdir: <메인>/.git/worktrees/<이름>"
  // (일반) 또는 "gitdir: <bare>/worktrees/<이름>"(bare) 한 줄짜리 파일
  // 이다(git 자신의 온디스크 규약).
  try {
    const raw = readFileSync(gitPath, "utf8").trim();
    const m = raw.match(/^gitdir:\s*(.+)$/);
    if (!m) return startDir;
    const worktreeGitDir = m[1].trim();
    if (!WORKTREE_GITDIR_SUFFIX_RE.test(worktreeGitDir)) return startDir;
    const mainGitDir = worktreeGitDir.replace(WORKTREE_GITDIR_SUFFIX_RE, "");
    // bare면 mainGitDir 자신이 이미 저장소 루트(포인터 파일이 그 아래
    // .harness/에 있다) -- 한 단계 더 올라가면 안 된다. non-bare(또는
    // 판별 불가)면 기존 그대로 그 부모가 루트(mainGitDir은 "<루트>/.git").
    return isBareGitDirectory(mainGitDir) ? mainGitDir : dirname(mainGitDir);
  } catch {
    return startDir;
  }
}

// admission-completion-adapter.mjs의 resolvePersistentLedgerPaths()와
// 같은 계약: 포인터 파일 부재/파싱 실패/빈 값은 전부 null(호출자가 "경로를
// 못 찾음"으로 접는다), 새 실패 모드를 얹지 않는다.
function resolvePersistentLedgerPath(harnessDir) {
  const pointerPath = join(
    mainRepoRoot(harnessDir),
    ".harness",
    PERSISTENT_LEDGER_POINTER_FILENAME,
  );
  if (!existsSync(pointerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pointerPath, "utf8"));
    return isNonEmptyString(parsed.ledgerPath) ? parsed.ledgerPath : null;
  } catch {
    return null;
  }
}

// relay-handshake.mjs의 DISPATCH_RECEIPT_POINTER_FILENAME과 같은 이름/같은
// 위치(harnessDir 바로 아래) -- 배달기가 이미 그 라운드의 harnessDir에
// 적어 두는 파일이므로 mainRepoRoot 조회조차 필요 없다.
const DISPATCH_RECEIPT_POINTER_FILENAME = "dispatch-receipt-path.txt";

function resolvePersistentReceiptPath(harnessDir) {
  if (!isNonEmptyString(harnessDir)) return null;
  try {
    const raw = readFileSync(
      join(harnessDir, DISPATCH_RECEIPT_POINTER_FILENAME),
      "utf8",
    ).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function resolveLedgerPathForShadow(harnessDir) {
  if (isNonEmptyString(process.env.ADMISSION_LEDGER_PATH)) {
    return process.env.ADMISSION_LEDGER_PATH;
  }
  return resolvePersistentLedgerPath(harnessDir);
}

function resolveReceiptPathForShadow(harnessDir) {
  if (isNonEmptyString(process.env.DISPATCH_RECEIPT_PATH)) {
    return process.env.DISPATCH_RECEIPT_PATH;
  }
  return resolvePersistentReceiptPath(harnessDir);
}

// coder-task.md §2⑶ -- "경로를 못 찾음"(env도 없고 포인터 파일도 없어 확인
// 자체를 못 함)과 "원장이 진짜 없음/손상"(경로는 확보했으나 그 경로의
// 파일을 못 읽음)을 같은 사유 코드로 뭉뚱그리지 않는다. facts.mjs 자신은
// 여전히 "경로 하드코딩/추측 0" 계약을 지킨다(호출자가 넘긴 값만 읽는다,
// 이 파일이 바뀌지 않는다) -- 구별은 여기, 호출자 쪽에서 "그 경로가 애초에
// resolve됐었는가"를 알고 있을 때만 라벨을 바꿔 붙인다.
function relabelUnresolvedPathReason(code, { ledgerPath, receiptPath }) {
  if (code === "LEDGER_UNREADABLE" && !isNonEmptyString(ledgerPath)) {
    return "LEDGER_PATH_UNRESOLVABLE";
  }
  if (code === "RECEIPT_UNREADABLE" && !isNonEmptyString(receiptPath)) {
    return "RECEIPT_PATH_UNRESOLVABLE";
  }
  return code;
}

export function buildShadowLine({ role, taskId, harnessDir, doneAt }) {
  try {
    const ledgerPath = resolveLedgerPathForShadow(harnessDir);
    const receiptPath = resolveReceiptPathForShadow(harnessDir);
    const assembled = assembleAutoAuthorFacts({
      role,
      harnessTaskLabel: taskId,
      harnessDir,
      ledgerPath,
      receiptPath,
      recordedAt: doneAt,
    });
    if (!assembled.ok) {
      const reason = relabelUnresolvedPathReason(assembled.code, {
        ledgerPath,
        receiptPath,
      });
      return `retire-author-shadow: ASSEMBLE_FAILED reason=${reason} label=${taskId} (shadow -- 아무것도 차단하지 않음)`;
    }
    const verdict = evaluateAutoAuthorAuthorization(assembled.facts);
    return `retire-author-shadow: JUDGED reason=${verdict.state} label=${taskId} (shadow -- 아무것도 차단하지 않음)`;
  } catch (err) {
    return `retire-author-shadow: OBSERVATION_ERROR reason=${err.message} label=${taskId} (shadow -- 아무것도 차단하지 않음)`;
  }
}

if (
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/retirement-auto-author-shadow-cli.mjs")
) {
  const [, , role, taskId, harnessDir, doneAt] = process.argv;
  console.log(buildShadowLine({ role, taskId, harnessDir, doneAt }));
  process.exit(0);
}
