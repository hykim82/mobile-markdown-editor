// HYK-183 v1 사이클2b (coder-task.md §3-1) -- 승인 권위 수집기(GitHub REST,
// 무인증) + 보호 브랜치 측정기.
//
// 배경(coder-task.md §1): 사이클2a(queue-observation-adapter.mjs)는 두 자리를
// 비워 뒀다 -- (1) `repo.protected_branch_name`은 측정값이 아니라 호출자
// 인자였고, (2) `manifest_commit.human_approved`의 유일한 구현체는 항상
// UNDECIDABLE을 반환하는 명시적 실패 포트였다. 이 파일이 그 두 자리를
// 채운다: `measureProtectedBranch`가 (1)을, `createGitHubApprovalPort`가
// (2)를 GitHub REST 조회로 대체한다.
//
// 왜 무인증(자격증명 0)인가(coder-task.md §1): 2026-07-29에 AI 좌석에 사람
// 계정의 관리자 자격증명이 살아 있는 것이 발견되어 알려진 경로 2개가
// 폐쇄됐다. 승인 증거(공개 저장소의 PR/리뷰/브랜치 메타데이터)는 자격증명
// 0으로도 전부 읽힌다는 것이 2026-07-30 07:2x KST에 실측됐다(D:\문서관리\
// 하네스-관제실\증거\2026-07-30-approval-rest\*.json). 자격증명이 없는
// 상태가 읽기 전용 토큰보다 강하다 -- 그래서 이 수집기는 인증 헤더를
// 어떤 경로로도 붙이지 않고, `process.env`의 토큰류를 읽지 않는다.
//
// 이 수집기가 증명하지 않는 것 (§5 정직 한계, 반드시 여기와 보고서 둘 다에
// 적는다):
// 1. 조사되지 않은 승인 표면 -- 이 수집기는 GitHub REST가 보고하는 PR
//    리뷰만 본다. 브라우저 세션 승인, 오프라인 합의, 다른 승인 경로가
//    있는지는 조사 대상 밖이다.
// 2. GitHub이 반환한 값 자체의 위조 가능성 -- 중간자 공격이나 GitHub 측
//    오류로 응답이 조작됐다면 이 수집기는 그것을 감지하지 못한다. 이
//    수집기는 "GitHub REST가 보고하는 값"을 측정할 뿐, 그 값의 절대적
//    진실성을 증명하지 않는다.
// 3. 상세 보호설정은 조회하지 않는다 -- `/branches/{b}/protection`은 무인증
//    401이다(실측: branch-master-protection-401.json). 그래서 "승인 필요
//    인원 수", "dismiss stale reviews" 같은 상세 보호 정책은 이 수집기의
//    검사 범위 밖이다. 이 수집기가 확인하는 것은 오직 `branches/{branch}`
//    응답의 `protected === true` 플래그뿐이다.
// 4. 표본 -- MEASURED 2건(PR #70·#71, 2026-07-30 07:2x KST 무인증 실측),
//    함정 1건(commit-985249f-pulls.json, 머지 커밋으로 조회해도 동일 PR이
//    반환되는 반례), 나머지는 그 payload를 변형한 SYNTHETIC이다.
// 5. `ALLOWLIST_REF_MISMATCH`의 운영 결과 -- 새 병합이 origin에 올라온
//    직후 `git fetch` 전에는 판정이 모름(시작 0)이 된다. 이것은 설계된
//    fail-closed이며, 라이브 도입 시 호출자가 fetch를 선행해야 한다.
// 6. 결선 상태(HYK-255-watch-wire-1 갱신) -- 온디맨드 부분 계수 CLI(scripts/
//    supervisor/partial-count-report.mjs의 collectGate4Independent ->
//    createGitHubApprovalPort -> isHumanApproved)에 결선됐고, 이제 상시
//    감시 실행 경로(watch-run.mjs의 runPartialCountStep -> 같은
//    runPartialCountOnce 경유)에도 결선됐다. ⚠️과대 주장 금지 -- "항상
//    최신"이라는 뜻은 아니다: 그 경로가 실제로 주기적으로 도는지(스케줄러
//    등록 여부)는 사람 손이고 이 파일 자신은 그 등록 여부를 모른다.
//
// 비타협(coder-task.md §2):
// - `orca` CLI 호출 0건(문자열 존재 자체는 위반이 아니다 -- 판정은 호출
//   여부).
// - 자격증명 0 -- Authorization/Cookie/X-Hub-* 등 인증 헤더를 붙이지 않고,
//   process.env의 토큰류를 읽지 않고, gh CLI·git credential·keyring에
//   접근하지 않는다.
// - 테스트에서 실제 네트워크 호출 0건 -- HTTP는 전부 주입 포트(fetchJson)로
//   나가고, 테스트는 가짜 포트만 쓴다.
// - live=false -- 상시 실행기·스케줄러·감시 루프·setInterval·CLI 진입점
//   없음.
// - 정본 큐 manifest 파일을 만들지 않는다.
// - throw로 판정을 대신하지 않는다 -- 모든 경로가 실패 객체를 반환한다.
// - 판정을 지어내지 않는다 -- 조회 불가·모호·실패는 전부 UNDECIDABLE이다.
// - 캐시를 승인 권위로 쓰지 않는다.

import path from "node:path";

// ---------------------------------------------------------------------------
// 표면 상수
// ---------------------------------------------------------------------------

export const APPROVAL_STATUS = Object.freeze({
  APPROVED: "APPROVED",
  NOT_APPROVED: "NOT_APPROVED",
  UNDECIDABLE: "UNDECIDABLE",
});

// 각 코드가 NOT_APPROVED(확정 부정)인지 UNDECIDABLE(모름)인지는 코드 옆
// 주석과, 그 분류를 실제로 강제하는 NOT_APPROVED_REASON_CODES(아래)가
// 정본이다. 이 두 곳이 어긋나면 버그다.
export const APPROVAL_REASON = Object.freeze({
  // -- 확정 부정(NOT_APPROVED): 리뷰를 실제로 봤고, 그 결과가 승인이
  //    아니라는 것을 안다.
  NO_APPROVING_REVIEW: "NO_APPROVING_REVIEW", // 리뷰 목록이 비어 있다.
  REVIEW_COMMIT_MISMATCH: "REVIEW_COMMIT_MISMATCH", // 승인 리뷰의 commit_id !== PR head sha.
  REVIEWER_NOT_ALLOWLISTED: "REVIEWER_NOT_ALLOWLISTED", // 리뷰는 있으나 명단의 어떤 승인자와도 login+id가 일치하지 않는다.
  REVIEWER_IS_AUTHOR: "REVIEWER_IS_AUTHOR", // 명단의 승인자가 곧 PR 작성자다.
  LAST_REVIEW_NOT_APPROVED: "LAST_REVIEW_NOT_APPROVED", // 명단 승인자의 마지막 리뷰가 APPROVED가 아니다.

  // -- 모름(UNDECIDABLE): 조회 실패·모호·조건 불충족으로 승인 여부를
  //    판정할 근거 자체가 부족하다.
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  HTTP_FAILED: "HTTP_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  MALFORMED_PAYLOAD: "MALFORMED_PAYLOAD",
  PAGINATION_UNHANDLED: "PAGINATION_UNHANDLED",
  CALL_BUDGET_EXCEEDED: "CALL_BUDGET_EXCEEDED",
  NO_PR_LINK: "NO_PR_LINK",
  MULTIPLE_PR_LINKS: "MULTIPLE_PR_LINKS",
  MERGE_SHA_MISMATCH: "MERGE_SHA_MISMATCH",
  PR_NOT_MERGED: "PR_NOT_MERGED",
  BASE_NOT_PROTECTED_BRANCH: "BASE_NOT_PROTECTED_BRANCH",
  PROTECTED_BRANCH_UNCONFIRMED: "PROTECTED_BRANCH_UNCONFIRMED",
  REPO_IDENTITY_MISMATCH: "REPO_IDENTITY_MISMATCH",
  ALLOWLIST_UNREADABLE: "ALLOWLIST_UNREADABLE",
  ALLOWLIST_MALFORMED: "ALLOWLIST_MALFORMED",
  ALLOWLIST_REPO_MISMATCH: "ALLOWLIST_REPO_MISMATCH",
  ALLOWLIST_REF_MISMATCH: "ALLOWLIST_REF_MISMATCH",
});

// 이 Set이 위 분류 주석을 실제로 강제한다 -- verdictFor()가 이 Set 하나만
// 보고 status를 정한다(분류가 두 군데서 따로 어긋날 여지가 없다).
const NOT_APPROVED_REASON_CODES = new Set([
  APPROVAL_REASON.NO_APPROVING_REVIEW,
  APPROVAL_REASON.REVIEW_COMMIT_MISMATCH,
  APPROVAL_REASON.REVIEWER_NOT_ALLOWLISTED,
  APPROVAL_REASON.REVIEWER_IS_AUTHOR,
  APPROVAL_REASON.LAST_REVIEW_NOT_APPROVED,
]);

const GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_CALL_BUDGET = 8;

// ---------------------------------------------------------------------------
// 작은 유틸
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isFunction(v) {
  return typeof v === "function";
}

function toText(v) {
  if (Buffer.isBuffer(v)) return v.toString("utf8").trim();
  return String(v === null || v === undefined ? "" : v).trim();
}

function verdictFor(reason, evidence) {
  const status = NOT_APPROVED_REASON_CODES.has(reason)
    ? APPROVAL_STATUS.NOT_APPROVED
    : APPROVAL_STATUS.UNDECIDABLE;
  return { status, evidence: { reason, ...evidence } };
}

// ---------------------------------------------------------------------------
// 무인증 fetchJson 실 구현 -- 테스트는 이걸 호출하지 않는다(§4-9).
// 온디맨드 부분 계수 CLI(partial-count-report.mjs)와 상시 감시 실행 경로
// (watch-run.mjs, HYK-255-watch-wire-1) 양쪽의 기본 fetch 포트로 불린다.
// ⚠️과대 주장 금지 -- 이 함수 자신은 그 경로가 실제로 주기적으로 도는지
// (스케줄러 등록 여부)를 모른다.
// ---------------------------------------------------------------------------

export function createAnonymousFetchJson() {
  return {
    async fetchJson({ url }) {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        const rawText = await response.text();
        let json = null;
        if (rawText.length > 0) {
          try {
            json = JSON.parse(rawText);
          } catch {
            json = null;
          }
        }
        return {
          ok: response.ok,
          status: response.status,
          json,
          linkHeader: response.headers.get("link"),
          rawTextLength: rawText.length,
        };
      } catch (err) {
        return {
          ok: false,
          status: null,
          json: null,
          linkHeader: null,
          rawTextLength: 0,
          networkError: true,
          detail: err && err.message ? err.message : String(err),
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// git 층 -- repo 신원 측정 + origin/master 판본 명단 읽기.
// ---------------------------------------------------------------------------

async function runGitSafe(git, args) {
  let result;
  try {
    result = await git.run(args);
  } catch (err) {
    return {
      ok: false,
      detail: err && err.message ? err.message : String(err),
    };
  }
  if (!result || typeof result.code !== "number") {
    return { ok: false, detail: "git port returned malformed result" };
  }
  if (result.code !== 0) {
    return { ok: false, detail: toText(result.stderr) };
  }
  return { ok: true, stdout: toText(result.stdout) };
}

const HTTPS_REMOTE_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?\/?$/;
const SSH_REMOTE_RE = /^git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/;

// measureRepoIdentity({git}) -> {ok:true, repoFullName} | {ok:false, reason, detail}
//
// 호출자가 repo 이름을 문자열로 넘기는 경로는 없다 -- git remote를 실제로
// 읽는다(측정값화의 핵심, coder-task.md §3-1).
export async function measureRepoIdentity({ git }) {
  if (!isPlainObject(git) || !isFunction(git.run)) {
    return {
      ok: false,
      reason: APPROVAL_REASON.REPO_IDENTITY_MISMATCH,
      detail: "git port missing/invalid",
    };
  }
  const remote = await runGitSafe(git, ["remote", "get-url", "origin"]);
  if (!remote.ok) {
    return {
      ok: false,
      reason: APPROVAL_REASON.REPO_IDENTITY_MISMATCH,
      detail: remote.detail,
    };
  }
  const url = remote.stdout;
  const match = url.match(HTTPS_REMOTE_RE) || url.match(SSH_REMOTE_RE);
  if (!match) {
    return {
      ok: false,
      reason: APPROVAL_REASON.REPO_IDENTITY_MISMATCH,
      detail: `unrecognized remote.origin.url: ${url}`,
    };
  }
  return { ok: true, repoFullName: `${match[1]}/${match[2]}` };
}

function isWellFormedApprover(approver) {
  return (
    isPlainObject(approver) &&
    isNonEmptyString(approver.login) &&
    typeof approver.id === "number" &&
    Number.isFinite(approver.id)
  );
}

// readApproverAllowlist({git, allowlistPath, expectedRepoFullName, expectedRefSha})
//   -> {ok:true, allowlist, allowlistRefSha} | {ok:false, reason, detail}
//
// **`origin/master` 판본만** 읽는다 -- 작업 폴더(worktree)나 다른 체크아웃
// 판본을 읽는 경로는 없다(한용 확정 2, coder-task.md §3-1).
function isWellFormedReadAllowlistArgs({
  git,
  allowlistPath,
  expectedRepoFullName,
  expectedRefSha,
}) {
  return (
    isPlainObject(git) &&
    isFunction(git.run) &&
    isNonEmptyString(allowlistPath) &&
    isNonEmptyString(expectedRepoFullName) &&
    isNonEmptyString(expectedRefSha)
  );
}

export async function readApproverAllowlist(args) {
  const { git, allowlistPath, expectedRepoFullName, expectedRefSha } =
    args ?? {};
  if (!isWellFormedReadAllowlistArgs(args ?? {})) {
    return {
      ok: false,
      reason: APPROVAL_REASON.INVALID_ARGUMENTS,
      detail: "readApproverAllowlist arguments missing/invalid",
    };
  }

  const refResult = await runGitSafe(git, ["rev-parse", "origin/master"]);
  if (!refResult.ok) {
    return {
      ok: false,
      reason: APPROVAL_REASON.ALLOWLIST_UNREADABLE,
      detail: refResult.detail,
    };
  }
  const refSha = refResult.stdout;
  if (refSha !== expectedRefSha) {
    return {
      ok: false,
      reason: APPROVAL_REASON.ALLOWLIST_REF_MISMATCH,
      detail: `origin/master=${refSha} expected(protected branch head)=${expectedRefSha}`,
    };
  }

  const gitPath = allowlistPath.split(path.sep).join("/");
  const blobResult = await runGitSafe(git, [
    "cat-file",
    "blob",
    `origin/master:${gitPath}`,
  ]);
  if (!blobResult.ok) {
    return {
      ok: false,
      reason: APPROVAL_REASON.ALLOWLIST_UNREADABLE,
      detail: blobResult.detail,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(blobResult.stdout);
  } catch (err) {
    return {
      ok: false,
      reason: APPROVAL_REASON.ALLOWLIST_MALFORMED,
      detail: err.message,
    };
  }
  if (!isWellFormedAllowlistSchema(parsed)) {
    return {
      ok: false,
      reason: APPROVAL_REASON.ALLOWLIST_MALFORMED,
      detail:
        "allowlist schema mismatch (repo/approvers[].login/approvers[].id required)",
    };
  }
  if (parsed.repo !== expectedRepoFullName) {
    return {
      ok: false,
      reason: APPROVAL_REASON.ALLOWLIST_REPO_MISMATCH,
      detail: `allowlist.repo=${parsed.repo} expected=${expectedRepoFullName}`,
    };
  }

  return { ok: true, allowlist: parsed, allowlistRefSha: refSha };
}

const ALLOWLIST_SCHEMA_VERSION = "approver-allowlist/v1";

// 재작업 2R P1-3 -- schema_version이 정확히 이 값이 아니면(누락·타입
// 불일치·다른 버전 문자열 전부) ALLOWLIST_MALFORMED다. §3-3 계약이 요구하는
// "스키마 불일치를 닫는다"에는 schema_version 필드 자체도 포함된다.
function isWellFormedAllowlistSchema(parsed) {
  return (
    isPlainObject(parsed) &&
    parsed.schema_version === ALLOWLIST_SCHEMA_VERSION &&
    isNonEmptyString(parsed.repo) &&
    Array.isArray(parsed.approvers) &&
    parsed.approvers.length > 0 &&
    parsed.approvers.every(isWellFormedApprover)
  );
}

// safeFetchJson -- 주입된 fetchJson이 throw해도 이 모듈 안 **모든** 직접
// 호출 지점에서 예외가 새지 않게 한다(재작업 2R P1-1: 이전에는
// makeBudgetedFetch만 이걸 했는데, measureProtectedBranch 등 public export를
// *직접* 호출하면(=budgetedFetch를 거치지 않으면) throw가 그대로 샜다).
// interpretHttpResponse가 이해하는 {networkError:true, detail} 형태로 흡수한다.
async function safeFetchJson(fetchJson, opts) {
  try {
    return await fetchJson(opts);
  } catch (err) {
    return {
      networkError: true,
      detail: err && err.message ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// HTTP 응답 해석 -- 예산 초과/네트워크 예외/상태코드/JSON 파싱을 전부
// 실패 객체로 흡수한다(throw 0).
// ---------------------------------------------------------------------------

function interpretHttpResponse(resp) {
  if (!isPlainObject(resp)) {
    return {
      ok: false,
      reason: APPROVAL_REASON.HTTP_FAILED,
      detail: "malformed fetch response (not an object)",
    };
  }
  if (resp.budgetExceeded) {
    return {
      ok: false,
      reason: APPROVAL_REASON.CALL_BUDGET_EXCEEDED,
      detail: "REST call budget exceeded",
    };
  }
  if (resp.networkError) {
    return {
      ok: false,
      reason: APPROVAL_REASON.HTTP_FAILED,
      detail: resp.detail,
    };
  }
  if (typeof resp.status !== "number") {
    return {
      ok: false,
      reason: APPROVAL_REASON.HTTP_FAILED,
      detail: "response missing numeric status",
    };
  }
  if (resp.status === 403 || resp.status === 429) {
    return {
      ok: false,
      reason: APPROVAL_REASON.RATE_LIMITED,
      detail: `status ${resp.status}`,
    };
  }
  if (!resp.ok) {
    return {
      ok: false,
      reason: APPROVAL_REASON.HTTP_FAILED,
      detail: `status ${resp.status}`,
    };
  }
  if (!isPlainObject(resp.json) && !Array.isArray(resp.json)) {
    return {
      ok: false,
      reason: APPROVAL_REASON.MALFORMED_PAYLOAD,
      detail: "response json missing/invalid",
    };
  }
  return { ok: true, json: resp.json, linkHeader: resp.linkHeader };
}

// measureProtectedBranch({fetchJson, repoFullName})
//   -> {ok:true, protectedBranchName, protectedHeadSha, evidence}
//    | {ok:false, reason, detail}
//
// 상세 보호설정(/branches/{b}/protection)은 무인증 401이라 쓰지 않는다(§5
// 정직 한계 3). 여기서 확인하는 것은 branches/{branch} 응답의
// `protected === true` 뿐이다.
export async function measureProtectedBranch({ fetchJson, repoFullName }) {
  if (!isFunction(fetchJson) || !isNonEmptyString(repoFullName)) {
    return {
      ok: false,
      reason: APPROVAL_REASON.INVALID_ARGUMENTS,
      detail: "measureProtectedBranch arguments missing/invalid",
    };
  }

  const repoResp = await safeFetchJson(fetchJson, {
    url: `${GITHUB_API_BASE}/repos/${repoFullName}`,
  });
  const repoParsed = interpretHttpResponse(repoResp);
  if (!repoParsed.ok) return repoParsed;

  const defaultBranch = repoParsed.json.default_branch;
  if (!isNonEmptyString(defaultBranch)) {
    return {
      ok: false,
      reason: APPROVAL_REASON.MALFORMED_PAYLOAD,
      detail: "repo response missing default_branch",
    };
  }

  const branchResp = await safeFetchJson(fetchJson, {
    url: `${GITHUB_API_BASE}/repos/${repoFullName}/branches/${encodeURIComponent(defaultBranch)}`,
  });
  const branchParsed = interpretHttpResponse(branchResp);
  if (!branchParsed.ok) return branchParsed;

  const branchJson = branchParsed.json;
  if (branchJson.protected !== true) {
    return {
      ok: false,
      reason: APPROVAL_REASON.PROTECTED_BRANCH_UNCONFIRMED,
      detail: "branch response protected !== true",
    };
  }
  if (
    !isPlainObject(branchJson.commit) ||
    !isNonEmptyString(branchJson.commit.sha)
  ) {
    return {
      ok: false,
      reason: APPROVAL_REASON.MALFORMED_PAYLOAD,
      detail: "branch response missing commit.sha",
    };
  }

  return {
    ok: true,
    protectedBranchName: defaultBranch,
    protectedHeadSha: branchJson.commit.sha,
    evidence: {
      repo_full_name: repoFullName,
      default_branch: defaultBranch,
      protected_head_sha: branchJson.commit.sha,
    },
  };
}

// ---------------------------------------------------------------------------
// 호출 예산 -- isHumanApproved 1회 호출이 쓰는 REST 호출 수 상한(기본 8,
// 근거: 무인증 한도 60/시간 실측 rate-limit.json).
// ---------------------------------------------------------------------------

function makeBudgetedFetch(fetchJson, state) {
  return async function budgeted(opts) {
    if (state.count >= state.budget) {
      return { budgetExceeded: true };
    }
    state.count += 1;
    try {
      return await fetchJson(opts);
    } catch (err) {
      return {
        networkError: true,
        detail: err && err.message ? err.message : String(err),
      };
    }
  };
}

// ---------------------------------------------------------------------------
// isHumanApproved의 각 단계를 별도 함수로 쪼갠다(가독성 + eslint
// complexity/max-lines-per-function 예산 준수). 각 함수는 {ok:true, ...} |
// {ok:false, reason, detail}를 반환한다 -- isHumanApproved가 그것을
// verdictFor()로 감싸는 조립만 한다.

// 4. 병합 커밋 -> PR 단일 연결. (함정: head 커밋으로 조회해도 같은 PR이
//    1건 반환된다 -- merge_commit_sha가 sha와 정확히 일치하는 것만 센다.)
async function measurePullLink({ fetchJson, repoFullName, sha }) {
  const resp = await safeFetchJson(fetchJson, {
    url: `${GITHUB_API_BASE}/repos/${repoFullName}/commits/${sha}/pulls`,
  });
  const parsed = interpretHttpResponse(resp);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.json)) {
    return {
      ok: false,
      reason: APPROVAL_REASON.MALFORMED_PAYLOAD,
      detail: "commits/pulls response is not an array",
    };
  }
  const matching = parsed.json.filter(
    (pr) => isPlainObject(pr) && pr.merge_commit_sha === sha,
  );
  if (matching.length >= 2) {
    return { ok: false, reason: APPROVAL_REASON.MULTIPLE_PR_LINKS };
  }
  if (matching.length === 0) {
    return {
      ok: false,
      reason:
        parsed.json.length === 0
          ? APPROVAL_REASON.NO_PR_LINK
          : APPROVAL_REASON.MERGE_SHA_MISMATCH,
    };
  }
  // P1-2와 같은 원칙: 확정적으로 쓸 값(pullNumber)의 형태가 온전한지 판정
  // 전에 확인한다 -- 온전하지 않으면 모름(MALFORMED_PAYLOAD)이다.
  if (!Number.isInteger(matching[0].number)) {
    return { ok: false, reason: APPROVAL_REASON.MALFORMED_PAYLOAD };
  }
  return { ok: true, pullNumber: matching[0].number };
}

function isWellFormedPullDetail(pull) {
  return (
    isPlainObject(pull) &&
    isPlainObject(pull.base) &&
    isPlainObject(pull.head) &&
    isNonEmptyString(pull.head.sha) &&
    isPlainObject(pull.user) &&
    isNonEmptyString(pull.user.login) &&
    typeof pull.user.id === "number"
  );
}

// 5. PR 상세 -- merged / base.ref / head.sha / user(작성자).
async function measurePullDetail({
  fetchJson,
  repoFullName,
  pullNumber,
  protectedBranchName,
}) {
  const resp = await safeFetchJson(fetchJson, {
    url: `${GITHUB_API_BASE}/repos/${repoFullName}/pulls/${pullNumber}`,
  });
  const parsed = interpretHttpResponse(resp);
  if (!parsed.ok) return parsed;
  const pull = parsed.json;
  if (!isWellFormedPullDetail(pull)) {
    return { ok: false, reason: APPROVAL_REASON.MALFORMED_PAYLOAD };
  }
  if (pull.merged !== true) {
    return { ok: false, reason: APPROVAL_REASON.PR_NOT_MERGED };
  }
  if (pull.base.ref !== protectedBranchName) {
    return { ok: false, reason: APPROVAL_REASON.BASE_NOT_PROTECTED_BRANCH };
  }
  return { ok: true, pull };
}

// 재작업 2R P1-2 -- 리뷰 항목의 필드 형태 검사를 판정보다 먼저 둔다. state가
// 비어있거나 문자열이 아님 · commit_id 없음/문자열 아님 · user 없음/객체
// 아님(login/id 포함) · submitted_at 없음/정렬 불가(Date.parse 실패) · 항목이
// 객체가 아님 -- 전부 MALFORMED_PAYLOAD(모름)다. 원칙: **확정 부정은
// payload가 온전할 때만 주장한다.** 손상된 리뷰 하나가 섞여 있으면 "마지막
// 리뷰가 무엇인지"조차 신뢰할 수 없으므로(제출 순서 정렬이 깨질 수 있다)
// 리뷰 목록 전체를 모름으로 닫는다.
function isWellFormedReviewItem(review) {
  return (
    isPlainObject(review) &&
    isPlainObject(review.user) &&
    isNonEmptyString(review.user.login) &&
    typeof review.user.id === "number" &&
    isNonEmptyString(review.state) &&
    isNonEmptyString(review.commit_id) &&
    isNonEmptyString(review.submitted_at) &&
    !Number.isNaN(Date.parse(review.submitted_at))
  );
}

// 6. 리뷰 목록 -- 페이지네이션 미처리 감지 + 배열 검증 + 항목별 형태 검사까지
// 이 함수의 책임이다(리뷰어별 승인 판정은 decideApprovalFromReviews가 순수
// 함수로 담당하며, 이 함수가 넘기는 reviews는 전부 형태가 온전함이 보장된다).
async function measureReviews({ fetchJson, repoFullName, pullNumber }) {
  const resp = await safeFetchJson(fetchJson, {
    url: `${GITHUB_API_BASE}/repos/${repoFullName}/pulls/${pullNumber}/reviews?per_page=100`,
  });
  const parsed = interpretHttpResponse(resp);
  if (!parsed.ok) return parsed;
  const linkHeader = isPlainObject(resp) ? resp.linkHeader : null;
  if (isNonEmptyString(linkHeader) && /rel="next"/.test(linkHeader)) {
    return { ok: false, reason: APPROVAL_REASON.PAGINATION_UNHANDLED };
  }
  if (!Array.isArray(parsed.json)) {
    return { ok: false, reason: APPROVAL_REASON.MALFORMED_PAYLOAD };
  }
  if (!parsed.json.every(isWellFormedReviewItem)) {
    return { ok: false, reason: APPROVAL_REASON.MALFORMED_PAYLOAD };
  }
  if (hasAmbiguousReviewerTimestamp(parsed.json)) {
    return { ok: false, reason: APPROVAL_REASON.MALFORMED_PAYLOAD };
  }
  return { ok: true, reviews: parsed.json };
}

// 재작업 3R (coder-task.md §11, 한용 게이트 2 지시) -- 같은 리뷰어가 같은
// submitted_at(파싱된 시각)으로 2건 이상의 리뷰를 냈으면 "어느 쪽이
// 마지막인지" 순서 판정이 불가능하다. 임의로 하나를 고르지 않고(그건 승인
// 여부를 지어내는 것과 같다) 모름으로 닫는다.
function hasAmbiguousReviewerTimestamp(reviews) {
  const seenTimestampsByReviewer = new Map();
  for (const review of reviews) {
    const key = `${review.user.login}:${review.user.id}`;
    const ts = Date.parse(review.submitted_at);
    let seen = seenTimestampsByReviewer.get(key);
    if (!seen) {
      seen = new Set();
      seenTimestampsByReviewer.set(key, seen);
    }
    if (seen.has(ts)) return true;
    seen.add(ts);
  }
  return false;
}

// 재작업 3R -- 리뷰어별 "마지막" 리뷰는 응답 배열 순서가 아니라
// submitted_at(파싱된 시각)이 가장 늦은 것으로 결정한다. GitHub이 항상
// 시간 오름차순으로 응답을 준다는 보장은 문서로 확인되지 않았으므로 그
// 가정을 코드에서 제거한다(한용 게이트 2 판정: 이전 라운드의 반려는 이
// 정렬 수단 미명시가 원인이었다). measureReviews가 이미 모든 항목의 형태
// 온전함 + 리뷰어별 시각 유일성(동시각 없음)을 보장하므로 여기서는 안전하게
// 최댓값 비교만 하면 된다(재검증하면 도달 불가능한 방어선이 생긴다).
function lastReviewPerReviewer(reviews) {
  const lastByReviewer = new Map();
  for (const review of reviews) {
    const key = `${review.user.login}:${review.user.id}`;
    const ts = Date.parse(review.submitted_at);
    const current = lastByReviewer.get(key);
    if (!current || ts > Date.parse(current.submitted_at)) {
      lastByReviewer.set(key, review);
    }
  }
  return lastByReviewer;
}

function classifyApproverReview(review, author) {
  if (review.user.login === author.login && review.user.id === author.id) {
    return APPROVAL_REASON.REVIEWER_IS_AUTHOR;
  }
  if (review.state !== "APPROVED") {
    return APPROVAL_REASON.LAST_REVIEW_NOT_APPROVED;
  }
  if (review.commit_id !== author.pullHeadSha) {
    return APPROVAL_REASON.REVIEW_COMMIT_MISMATCH;
  }
  return null; // 승인으로 확정.
}

// 순수 함수 -- 리뷰어별 마지막 리뷰만(제출 순서대로 덮어쓴다) + 명단
// 순서대로 훑어 첫 유효 승인자를 찾는다. 판별은 user.login + user.id 명시
// 일치로만 한다 -- user.type으로 봇/사람을 가리지 않는다(실측상 우리 봇
// 계정도 type: "User"다, pull-71.json 확인).
function decideApprovalFromReviews({ reviews, approvers, author, pull }) {
  if (reviews.length === 0) {
    return { reason: APPROVAL_REASON.NO_APPROVING_REVIEW };
  }
  const lastByReviewer = lastReviewPerReviewer(reviews);
  for (const approver of approvers) {
    const review = lastByReviewer.get(`${approver.login}:${approver.id}`);
    if (!review) continue;
    const rejectionReason = classifyApproverReview(review, {
      login: author.login,
      id: author.id,
      pullHeadSha: pull.head.sha,
    });
    if (rejectionReason) return { reason: rejectionReason, review };
    return {
      approved: true,
      review,
    };
  }
  return { reason: APPROVAL_REASON.REVIEWER_NOT_ALLOWLISTED };
}

// ---------------------------------------------------------------------------
// createGitHubApprovalPort({fetchJson, git, allowlistPath, callBudget})
//   -> { async isHumanApproved(sha) }
//
// queue-observation-adapter.mjs의 approval 포트 계약과 그대로 호환된다:
// {status, evidence}를 반환하고, APPROVED/NOT_APPROVED 외는 전부 수집
// 실패(UNDECIDABLE)로 흡수된다.
// ---------------------------------------------------------------------------

function isWellFormedApprovalPortDeps({ fetchJson, git, allowlistPath }) {
  return (
    isFunction(fetchJson) &&
    isPlainObject(git) &&
    isFunction(git.run) &&
    isNonEmptyString(allowlistPath)
  );
}

// repo 신원 + 보호 브랜치 + 명단, 세 측정을 한데 묶어 isHumanApproved의
// 몸통을 짧게 유지한다(eslint max-lines-per-function/complexity 예산).
async function resolveApprovalContext({
  git,
  budgetedFetchJson,
  allowlistPath,
}) {
  const repoIdentity = await measureRepoIdentity({ git });
  if (!repoIdentity.ok) {
    return {
      ok: false,
      reason: repoIdentity.reason,
      detail: repoIdentity.detail,
      evidence: {},
    };
  }
  const repoFullName = repoIdentity.repoFullName;

  const branch = await measureProtectedBranch({
    fetchJson: budgetedFetchJson,
    repoFullName,
  });
  if (!branch.ok) {
    return {
      ok: false,
      reason: branch.reason,
      detail: branch.detail,
      evidence: { repo_full_name: repoFullName },
    };
  }

  const allowlistResult = await readApproverAllowlist({
    git,
    allowlistPath,
    expectedRepoFullName: repoFullName,
    expectedRefSha: branch.protectedHeadSha,
  });
  if (!allowlistResult.ok) {
    return {
      ok: false,
      reason: allowlistResult.reason,
      detail: allowlistResult.detail,
      evidence: {
        repo_full_name: repoFullName,
        protected_branch_name: branch.protectedBranchName,
        protected_head_sha: branch.protectedHeadSha,
      },
    };
  }

  return {
    ok: true,
    repoFullName,
    branch,
    allowlistResult,
    baseEvidence: {
      repo_full_name: repoFullName,
      protected_branch_name: branch.protectedBranchName,
      protected_head_sha: branch.protectedHeadSha,
      allowlist_ref_sha: allowlistResult.allowlistRefSha,
    },
  };
}

// 병합 커밋->PR 연결 + PR 상세 + 리뷰 목록, 세 측정을 한데 묶는다.
async function resolvePullData({
  budgetedFetchJson,
  repoFullName,
  sha,
  protectedBranchName,
}) {
  const link = await measurePullLink({
    fetchJson: budgetedFetchJson,
    repoFullName,
    sha,
  });
  if (!link.ok) {
    return {
      ok: false,
      reason: link.reason,
      detail: link.detail,
      evidence: {},
    };
  }
  const pullNumber = link.pullNumber;

  const detail = await measurePullDetail({
    fetchJson: budgetedFetchJson,
    repoFullName,
    pullNumber,
    protectedBranchName,
  });
  if (!detail.ok) {
    return {
      ok: false,
      reason: detail.reason,
      detail: detail.detail,
      evidence: { pull_number: pullNumber },
    };
  }

  const reviewsResult = await measureReviews({
    fetchJson: budgetedFetchJson,
    repoFullName,
    pullNumber,
  });
  if (!reviewsResult.ok) {
    return {
      ok: false,
      reason: reviewsResult.reason,
      detail: reviewsResult.detail,
      evidence: { pull_number: pullNumber },
    };
  }

  return {
    ok: true,
    pullNumber,
    pull: detail.pull,
    reviews: reviewsResult.reviews,
  };
}

function evidenceForDecision(decision, pull, sha) {
  if (!decision.review) return {};
  return {
    pull_head_sha: pull.head.sha,
    merge_commit_sha: sha,
    review_id: decision.review.id,
    reviewer_login: decision.review.user.login,
    reviewer_id: decision.review.user.id,
    author_login: pull.user.login,
    author_id: pull.user.id,
  };
}

export function createGitHubApprovalPort(deps = {}) {
  const { fetchJson, git, allowlistPath, callBudget } = deps;
  return {
    async isHumanApproved(sha) {
      if (!isWellFormedApprovalPortDeps(deps)) {
        return verdictFor(APPROVAL_REASON.INVALID_ARGUMENTS, {
          detail: "createGitHubApprovalPort dependencies missing/invalid",
        });
      }
      if (!isNonEmptyString(sha)) {
        return verdictFor(APPROVAL_REASON.INVALID_ARGUMENTS, {
          detail: "sha missing/invalid",
        });
      }

      const budget =
        Number.isInteger(callBudget) && callBudget > 0
          ? callBudget
          : DEFAULT_CALL_BUDGET;
      const state = { count: 0, budget };
      const budgetedFetchJson = makeBudgetedFetch(fetchJson, state);

      const context = await resolveApprovalContext({
        git,
        budgetedFetchJson,
        allowlistPath,
      });
      if (!context.ok) {
        return verdictFor(context.reason, {
          ...context.evidence,
          detail: context.detail,
          rest_call_count: state.count,
        });
      }

      const pullData = await resolvePullData({
        budgetedFetchJson,
        repoFullName: context.repoFullName,
        sha,
        protectedBranchName: context.branch.protectedBranchName,
      });
      if (!pullData.ok) {
        return verdictFor(pullData.reason, {
          ...context.baseEvidence,
          ...pullData.evidence,
          detail: pullData.detail,
          rest_call_count: state.count,
        });
      }

      const decision = decideApprovalFromReviews({
        reviews: pullData.reviews,
        approvers: context.allowlistResult.allowlist.approvers,
        author: pullData.pull.user,
        pull: pullData.pull,
      });
      const finalEvidence = {
        ...context.baseEvidence,
        pull_number: pullData.pullNumber,
        ...evidenceForDecision(decision, pullData.pull, sha),
        rest_call_count: state.count,
      };
      if (decision.approved) {
        return { status: APPROVAL_STATUS.APPROVED, evidence: finalEvidence };
      }
      return verdictFor(decision.reason, finalEvidence);
    },
  };
}
