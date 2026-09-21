// HYK-270-stall-visible-2 (coder-task.md §3, §4) -- 세션 기록 파일 "총
// 바이트 수"를 모은다(mtime 아님 -- §3 실측: mtime은 크기가 느는 중에도
// 갱신 안 되는 구간이 관측됐다). deriveClaudeProjectDirName은
// rate-limit-stall-adapter.mjs와 동일 관례를 그대로 재사용한다(중복
// 구현 0).
import { statSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { deriveClaudeProjectDirName } from "./rate-limit-stall-adapter.mjs";

export const DISPATCH_START_SIZE_COLLECT_REASON = Object.freeze({
  DIR_LIST_FAILED: "DISPATCH_START_SIZE_DIR_LIST_FAILED",
  STAT_FAILED: "DISPATCH_START_SIZE_STAT_FAILED",
});

// ★HYK-378 2R(REVIEW P1-2 반려 수리) -- 1R은 `readdir` 실패를 코드 구분
// 없이 전부 `[]`(폴더 없음과 동형)로 삼켰다. 검토자 실측: `EACCES`를
// 주입하니 하위 전사록 200B가 있는데도 `ok:true/totalBytes:100`으로
// 정상 관측이 나왔다 -- "못 읽었다"가 "괜찮다"로 둔갑한 fail-open.
// ⇒ **부재(ENOENT)와 "경로 성분이 폴더가 아님"(ENOTDIR, entryName이
// 애초에 파일인 흔한 경우)만** 정상으로 접고, 그 밖의 모든 코드(EACCES
// 등)는 실패로 전파한다(불변식 E).
const BENIGN_ENUMERATION_CODES = new Set(["ENOENT", "ENOTDIR"]);

// ★HYK-378 4R(REVIEW P1-2 세 번째 반려 수리 -- ORCH 재설계 지시 그대로,
// 불변식 L "경로 관문") -- 2R·3R은 "이 특정 디렉터리 항목이 링크인가"를
// 층마다 하나씩 검사했다(세션 UUID 폴더, 그다음 파일...). 검토자가
// 매번 «한 겹 바깥»에서 새 우회를 찾아냈다(`projectDir` 자신 300B ·
// `session/subagents` 자신 400B · `claudeHomeDir` 상위 250B) -- 층별
// 검사는 구조적으로 "몇 번째 층까지 셌는가"의 두더지 잡기가 된다(ORCH
// 판정 문면 그대로).
//
// ★수리(층별 검사 폐기, 단일 관문으로 교체):
// 1. **뿌리 신뢰 검사** -- `claudeHomeDir` -> `claudeHomeDir/projects` ->
//    `projectDir`(파생된 이름) 이 세 경로 «자신»이 하나라도 링크면(entry
//    자체가 symlink/junction) 그 뿌리 전체를 신뢰하지 않는다(내부를
//    들여다보지도 않고 0바이트로 접는다) -- ★이 검사가 필요한 이유는
//    "최종 realpath containment"만으로는 «anchor 자신이 링크인 경우»를
//    원리적으로 못 잡기 때문이다(anchor가 이미 그 링크를 따라간 곳을
//    가리키면, 그 안의 모든 것이 "anchor 안에 있다"고 트리비얼하게
//    참이 되어 버린다 -- 그래서 anchor 후보 자신은 lstat로 먼저 걸러야
//    한다).
// 2. **최종 realpath containment** -- 뿌리가 신뢰되면 `projectDir`의
//    실제 경로(`realpathFn`)를 한 번만 구하고, 그 아래서 발견한 «모든»
//    후보 파일 각각의 실제 경로가 그 안에 있는지(`path.relative`가
//    `..`로 시작하지 않는지)만 확인한다. ★이 한 관문이 세션 UUID 폴더가
//    링크든, `subagents` 폴더가 링크든, 파일 자신이 링크든 **똑같이**
//    잡는다(중간에 어떤 이름의 폴더가 있든 몰라도 된다 -- "이름"이 아니라
//    "결과 위치"로 판단하므로 다음 두더지가 안 생긴다).
function isWithinRealBase(candidateRealPath, baseRealPath) {
  if (candidateRealPath === baseRealPath) return true;
  const rel = path.relative(baseRealPath, candidateRealPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// checkEntryLink(candidatePath, lstatFn) -> {ok, exists, isLink} |
// {ok:false, reasonCode, detail} -- 부재는 "존재 안 함"(정상, 상위
// 호출부가 판단), 그 밖의 예외는 실패로 전파한다(불변식 E와 동일 원칙).
function checkEntryLink(candidatePath, lstatFn) {
  try {
    return {
      ok: true,
      exists: true,
      isLink: lstatFn(candidatePath).isSymbolicLink(),
    };
  } catch (err) {
    if (err && BENIGN_ENUMERATION_CODES.has(err.code)) {
      return { ok: true, exists: false, isLink: false };
    }
    return {
      ok: false,
      reasonCode: DISPATCH_START_SIZE_COLLECT_REASON.STAT_FAILED,
      detail: err && err.message ? err.message : String(err),
    };
  }
}

// verifyProjectRootTrusted(claudeHomeDir, projectsDir, projectDir, lstatFn)
// -> {ok:true, trusted:true} | {ok:true, trusted:false, missing:boolean} |
// {ok:false, reasonCode, detail} -- ★4R L 관문 1단계(위 헤더 주석).
function verifyProjectRootTrusted(
  claudeHomeDir,
  projectsDir,
  projectDir,
  lstatFn,
) {
  for (const segment of [claudeHomeDir, projectsDir, projectDir]) {
    const check = checkEntryLink(segment, lstatFn);
    if (!check.ok) return check;
    if (!check.exists) return { ok: true, trusted: false, missing: true };
    if (check.isLink) return { ok: true, trusted: false, missing: false };
  }
  return { ok: true, trusted: true };
}

// listAllSessionJsonlPaths(projectDir, readdirFn) -> {ok, paths} |
// {ok:false, reasonCode, detail} -- 순수 열거만 한다(링크 판단은 더 이상
// 여기서 안 함 -- ★4R부터 realpath containment가 그 역할을 대신한다).
// 최상위 `.jsonl` + 그 아래 `<entry>/subagents/*.jsonl`을 한데 모은다
// (한 단계만 -- 2R 범위 결정 그대로 유지, coder.md 근거 참조).
function listSubagentJsonlPaths(projectDir, entryName, readdirFn) {
  const subagentsDir = path.join(projectDir, entryName, "subagents");
  let subNames;
  try {
    subNames = readdirFn(subagentsDir);
  } catch (err) {
    if (err && BENIGN_ENUMERATION_CODES.has(err.code))
      return { ok: true, paths: [] };
    return {
      ok: false,
      reasonCode: DISPATCH_START_SIZE_COLLECT_REASON.DIR_LIST_FAILED,
      detail: err && err.message ? err.message : String(err),
    };
  }
  return {
    ok: true,
    paths: subNames
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => path.join(subagentsDir, n)),
  };
}

function listAllSessionJsonlPaths(projectDir, readdirFn) {
  let entries;
  try {
    entries = readdirFn(projectDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true, paths: [] };
    return {
      ok: false,
      reasonCode: DISPATCH_START_SIZE_COLLECT_REASON.DIR_LIST_FAILED,
      detail: err && err.message ? err.message : String(err),
    };
  }

  const paths = [];
  for (const name of entries) {
    if (name.endsWith(".jsonl")) {
      paths.push(path.join(projectDir, name));
      continue;
    }
    const sub = listSubagentJsonlPaths(projectDir, name, readdirFn);
    if (!sub.ok) return sub; // ★2R -- 열거 실패를 조용히 안 삼킨다(불변식 E).
    paths.push(...sub.paths);
  }
  return { ok: true, paths };
}

// sumContainedFileSizes(filePaths, projectRealPath, {statFn, realpathFn}) ->
// {ok, totalBytes, includedCount, excludedSymlinkCount} | {ok:false,
// reasonCode, detail} -- ★4R L 관문 2단계(위 헤더 주석). 각 후보의 실제
// 경로를 구해 `projectRealPath` 안에 있는지만 본다 -- 링크인지 아닌지가
// 아니라 "결과적으로 어디 있는가"로 판단한다(링크를 따라가도 그 목적지가
// 프로젝트 안이면 통과, 안이 아니면 아무리 평범한 이름이어도 배제).
function sumContainedFileSizes(
  filePaths,
  projectRealPath,
  { statFn, realpathFn },
) {
  let totalBytes = 0;
  let includedCount = 0;
  let excludedSymlinkCount = 0;
  for (const filePath of filePaths) {
    let realPath;
    try {
      realPath = realpathFn(filePath);
    } catch (err) {
      return {
        ok: false,
        reasonCode: DISPATCH_START_SIZE_COLLECT_REASON.STAT_FAILED,
        detail: err && err.message ? err.message : String(err),
      };
    }
    if (!isWithinRealBase(realPath, projectRealPath)) {
      excludedSymlinkCount += 1; // 신뢰 경계 밖 -- 안 세고 안 따라간다.
      continue;
    }
    try {
      totalBytes += statFn(filePath).size;
    } catch (err) {
      return {
        ok: false,
        reasonCode: DISPATCH_START_SIZE_COLLECT_REASON.STAT_FAILED,
        detail: err && err.message ? err.message : String(err),
      };
    }
    includedCount += 1;
  }
  return { ok: true, totalBytes, includedCount, excludedSymlinkCount };
}

// collectTotalSessionBytes({repoRoot, claudeHomeDir}, {readdirFn, statFn,
// lstatFn, realpathFn}) -> {ok, totalBytes, fileCount, excludedSymlinkCount}
// | {ok:false, reasonCode, detail}
//
// - 세션 로그 디렉터리 자체가 없으면(아직 이 워크트리에 세션이 하나도
//   시작 안 됨) 정상적으로 `totalBytes:0`이다(결손 아님 -- "아직 시작
//   전"과 "판정 불가"를 구별한다).
// - `excludedSymlinkCount` = 신뢰 경계 밖이라 배제한 항목 수(★4R부터
//   "뿌리 자체가 링크"인 경우도 1로 잡는다 -- 그 경우 안은 아예 안 본다).
export function collectTotalSessionBytes(
  { repoRoot, claudeHomeDir },
  {
    readdirFn,
    statFn = statSync,
    lstatFn = lstatSync,
    realpathFn = realpathSync,
  },
) {
  const projectsDir = path.join(claudeHomeDir, "projects");
  const projectDir = path.join(
    projectsDir,
    deriveClaudeProjectDirName(repoRoot),
  );

  const rootCheck = verifyProjectRootTrusted(
    claudeHomeDir,
    projectsDir,
    projectDir,
    lstatFn,
  );
  if (!rootCheck.ok) return rootCheck;
  if (rootCheck.missing) {
    return { ok: true, totalBytes: 0, fileCount: 0, excludedSymlinkCount: 0 };
  }
  if (!rootCheck.trusted) {
    // ★4R -- 뿌리 자신(claudeHomeDir·projects·projectDir 중 하나)이
    // 링크다 -- 안을 들여다보지 않고 통째로 배제한다(§L 1단계).
    return { ok: true, totalBytes: 0, fileCount: 0, excludedSymlinkCount: 1 };
  }

  const listed = listAllSessionJsonlPaths(projectDir, readdirFn);
  if (!listed.ok) return listed;

  const projectRealPath = realpathFn(projectDir); // 뿌리가 이미 신뢰됐으므로 안전.
  const summed = sumContainedFileSizes(listed.paths, projectRealPath, {
    statFn,
    realpathFn,
  });
  if (!summed.ok) return summed;

  return {
    ok: true,
    totalBytes: summed.totalBytes,
    fileCount: summed.includedCount,
    excludedSymlinkCount: summed.excludedSymlinkCount,
  };
}
