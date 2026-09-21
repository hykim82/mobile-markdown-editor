// HYK-240: review-gate.mjs가 승인(`.harness/review.md`)이 "어느 코드 상태"에
// 대한 것인지 대조하지 않던 구멍을 닫는다. 이 모듈은 그 대조에 쓰는 "지문"을
// 재는 방법과, review.md에 적힌 지문과 현재 작업트리를 비교해 판정하는
// 로직을 담는다 -- review-gate.mjs 자체의 순수 함수 계약(checkReviewGate)은
// 건드리지 않는다(기존 20여 개 시험이 그 반환 shape을 단언하므로).
//
// 지문 측정 방법(§0 실측 근거): `git status --porcelain=v1 -z`는 현재
// 작업트리가 HEAD 대비 무엇이 바뀌었는지를 tracked 수정 · untracked 신규 ·
// 삭제 · rename 전부 잡는다(`git diff HEAD`만 쓰면 untracked 신규 파일을
// 못 잡는다 -- 직접 확인). 다만 상태 문자열만으로는 "이미 M 상태인 파일이
// 승인 이후 다시 수정됐다"를 못 잡으므로(상태 문자는 그대로 M), 각 파일의
// 현재 바이트 내용을 sha256으로 얹어 최종 지문에 반영한다.
//
// `.harness/` 자기참조 문제(§0 item4): 이 저장소의 `.harness/`는
// `.gitignore`에 등록돼 있어 `git status`(기본, `--ignored` 미지정)에
// 애초에 나타나지 않는다(직접 확인: `git check-ignore -v
// .harness/review.md`). 그러나 그 보호를 .gitignore 하나에만 맡기지 않는다
// -- 이 파일이 만드는 합성 시험 저장소들(review-gate-*.test.mjs 등)은
// `.gitignore` 없이 `.harness/`를 쓰는 경우가 실측상 있었다(그 상태에서는
// review.md 자신이 지문에 들어가, 지문을 review.md에 적는 순간 지문이
// 달라져 영원히 불일치하는 진짜 자기참조가 재현됐다). 그래서 아래
// `buildEntries`는 `.harness/`로 시작하는 경로를 .gitignore 여부와 무관하게
// 항상 걸러낸다. ⛔정직 한계: `.harness/` 안의 변경은 이 지문의 감시 범위
// 밖이다 -- 승인 이후 `.harness/` 안에서 무엇이 바뀌어도 이 게이트는
// 잡지 못한다(그 디렉터리는 하네스 진행 기록용이지 검토 대상 코드가 아니라는
// 전제).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

function repoRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return cwd ?? process.cwd();
  }
}

// Parses `git status --porcelain=v1 -z` output into {status, path} records.
// -z avoids core.quotepath escaping and uses NUL separators, so paths with
// spaces or non-ASCII bytes parse without ambiguity. Rename/copy records
// carry two NUL-terminated fields (new path, then orig path); the orig path
// is discarded here since binding only cares about the current path set.
function parsePorcelainZ(output) {
  const tokens = output.split("\0").filter((t) => t.length > 0);
  const records = [];
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i];
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    records.push({ status, path });
    i += 1;
    if (status[0] === "R" || status[0] === "C") {
      // orig path field follows; skip it.
      i += 1;
    }
  }
  return records;
}

// Builds the fingerprint's raw entry lines from the current worktree. Each
// changed/new path becomes one line: "<status> <path> <sha256|DELETED>".
// Sorted by path so the same set of changes always hashes to the same
// digest regardless of git's enumeration order.
function buildEntries(cwd) {
  let statusOut;
  try {
    statusOut = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
      cwd,
      encoding: "utf8",
    });
  } catch (err) {
    return { ok: false, reason: `git status 실행 실패: ${err.message}` };
  }
  const records = parsePorcelainZ(statusOut);
  const lines = [];
  for (const { status, path } of records) {
    // Explicit exclude, not reliant on .gitignore alone -- see the
    // self-reference note at the top of this file.
    if (path === ".harness" || path.startsWith(".harness/")) continue;
    // Deliberately NOT using git's raw two-char status letters here: `git
    // add` alone flips an untracked file's status from "??" to "A " (and a
    // modified-tracked file's "M " to staged "M "/"MM" depending on further
    // edits) with the file's CONTENT unchanged. Reviewers approve before
    // staging; the commit round stages right before `git commit`. Keying
    // the fingerprint on the raw status text made every legitimate
    // approval fail ("불일치") the moment `git add` ran -- a false
    // positive on the very path §4-1 requires to have zero of. Collapsing
    // to just present-vs-deleted (content hash carries the real signal)
    // fixes that while still catching all three forgery types.
    const isDeleted = status.includes("D");
    if (isDeleted) {
      lines.push(`D ${path} DELETED`);
      continue;
    }
    const abs = join(cwd, path);
    let contentHash;
    try {
      const buf = readFileSync(abs);
      contentHash = createHash("sha256").update(buf).digest("hex");
    } catch (err) {
      lines.push(`? ${path} UNREADABLE:${err.code ?? err.message}`);
      continue;
    }
    lines.push(`M ${path} ${contentHash}`);
  }
  lines.sort();
  if (lines.length === 0) {
    // HYK-281: a clean worktree used to leave `lines` empty, so the
    // fingerprint below became sha256("") == the well-known empty-string
    // constant e3b0c44298fc1c... -- a value that matches ANY clean worktree
    // regardless of what code is actually checked out (실측: HYK-280 검토
    // 2R/5R, 같은 상수 두 번 재현). That let "이미 커밋된 판본 검토" rounds
    // record a binding that isn't bound to anything.
    //
    // Fix (범위 후보 ⓐ+ⓒ): when there is nothing uncommitted to fingerprint,
    // bind to the checked-out HEAD commit instead of an empty set -- this is
    // exactly the object "이미 커밋된 판본을 검토" approves, so it's the
    // correct binding target for that path, and it can never collide with
    // the old empty-tree constant (HEAD sha as string always differs from
    // the empty join). If HEAD itself can't be read (no commits yet), fail
    // closed (ⓑ) rather than falling back to the empty hash.
    let headSha;
    try {
      headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf8",
      }).trim();
    } catch (err) {
      return {
        ok: false,
        reason: `작업트리가 깨끗해 HEAD 커밋에 결속을 시도했으나 HEAD를 읽을 수 없음: ${err.message}`,
      };
    }
    lines.push(`H HEAD ${headSha}`);
  }
  return { ok: true, lines };
}

// HYK-240 2R (반려 1 수리, 검토 축 F1): the fingerprint above is measured
// from WORKING-TREE bytes, but `git commit` (plain, no -a) writes whatever
// is currently staged in the INDEX -- those can differ. Review's real
// repro: stage feature.js="INDEX_APPROVED", then edit the worktree ONLY to
// "WORKTREE_APPROVED", record a fingerprint (reads the worktree -> sees
// WORKTREE_APPROVED), then `git commit` -- the gate passed (fingerprint
// still matched the untouched worktree) but the commit actually recorded
// INDEX_APPROVED, which nobody's fingerprint ever covered.
//
// Fix chosen = option (나) from the task (keep the worktree-based
// fingerprint as the primary signal, add an independent index<->worktree
// sync requirement at gate time) over option (가) (rebase the fingerprint
// itself on index/blob content). Rationale: review's own axes A-D already
// independently confirmed the worktree-based fingerprint correctly (a)
// avoids false positives across `git add` (1R's fix) and (b) catches all
// three forgery types -- rebuilding it on index content would force
// re-proving both from scratch and risks reopening those axes. This gap is
// narrower: the missing invariant is specifically "index equals worktree
// for everything the fingerprint covers," so add exactly that as a second,
// independent check. It runs at GATE time (checkApprovalBinding, always
// invoked before every commit) rather than at --record time, because in
// this repo's normal flow nothing is staged yet when a reviewer approves
// (staging happens right before the separate "commit round") -- requiring
// sync at record time would fail the *legitimate* path every time.
//
// Uses `git diff --name-only -z` (tracked files where the worktree differs
// from what's staged) plus `git ls-files --others --exclude-standard -z`
// (worktree files not in the index at all, including partially-staged-out
// new files) -- together these cover every way the committed snapshot
// could diverge from the reviewed worktree, including partial staging
// (task §ⓐ4).
function checkIndexWorktreeSync(cwd) {
  let diffOut;
  let untrackedOut;
  try {
    diffOut = execFileSync("git", ["diff", "--name-only", "-z"], {
      cwd,
      encoding: "utf8",
    });
    untrackedOut = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd, encoding: "utf8" },
    );
  } catch (err) {
    return { ok: false, reason: `git diff/ls-files 실행 실패: ${err.message}` };
  }
  const paths = [...diffOut.split("\0"), ...untrackedOut.split("\0")]
    .filter(Boolean)
    .filter((p) => p !== ".harness" && !p.startsWith(".harness/"));
  return { ok: true, desyncedPaths: [...new Set(paths)].sort() };
}

// Computes the binding fingerprint for the current working tree state.
export function computeFingerprint({ cwd = process.cwd() } = {}) {
  const built = buildEntries(cwd);
  if (!built.ok) return built;
  const fingerprint = createHash("sha256")
    .update(built.lines.join("\n"))
    .digest("hex");
  return { ok: true, fingerprint, entries: built.lines };
}

const FINGERPRINT_LINE_RE = /^binding-fingerprint:\s*([0-9a-f]{64})\s*$/im;
const ENTRIES_FENCE_RE = /```binding-entries\r?\n([\s\S]*?)```/;

export function extractBindingFingerprint(content) {
  const normalized = content.replace(/\r\n/g, "\n");
  const m = normalized.match(FINGERPRINT_LINE_RE);
  return m ? m[1] : null;
}

export function extractBindingEntries(content) {
  const normalized = content.replace(/\r\n/g, "\n");
  const m = normalized.match(ENTRIES_FENCE_RE);
  if (!m) return null;
  return m[1].split("\n").filter((l) => l.length > 0);
}

// Builds the markdown block a reviewer appends to review.md at approval
// time: the fingerprint (what the gate compares) plus the raw entry lines
// (what --explain uses to show *which* files changed on mismatch).
export function formatBindingBlock({ fingerprint, entries }) {
  const entriesBlock = entries.length > 0 ? entries.join("\n") : "(no changes)";
  return `binding-fingerprint: ${fingerprint}\n\`\`\`binding-entries\n${entriesBlock}\n\`\`\`\n`;
}

// HYK-244 gate-unblock-1 §1 조각2 원인ⓐ 수리 (ORCH 실측 근거: 이 파일의
// 옛 --record가 `writeFileSync(reviewPath, existing + block)`로 이미
// 소비 완료된 `.harness/review.md`에 직접 덧붙였다 -- 그 결과 review.md의
// 지문이 승인 직후 즉시 무효가 됐다). binding-fingerprint/binding-entries
// 를 review.md 밖의 사이드카 파일로 분리한다 -- "소비 완료된 <role>.md를
// 어떤 경우에도 수정하지 않는다"는 이 브랜치가 새로 넣은 워커 지시
// 수칙(0017a15)을 하네스 도구 자신도 지킨다. 사이드카는 review.md와
// 같은 디렉터리에 두어(위치 추적이 쉬움) `.harness/` 밖 신규 최상위
// 디렉터리를 만들지 않는다.
function sidecarPathFor(reviewPath) {
  return join(dirname(reviewPath), "review-approval-binding.md");
}

// 하위호환(§1 점3 "사이드카 분리 + 읽는 자리 전건 갱신 + 하위호환" 요구
// 그대로): 사이드카가 있으면 그것을 정본으로 읽는다. 없으면(이 수리
// 이전에 review.md 안에 직접 적힌 옛 라운드들) review.md 자신을 그대로
// 읽어 예전과 동일하게 동작한다 -- 옛 기록을 무효화하지 않는다. 어느
// 쪽도 못 읽으면 빈 문자열로 물러난다("결속 없음"이 정직하게 뜨게
// 한다 -- 조용히 다른 경로로 넘어가 오류를 감추지 않는다).
function readBindingSourceText(reviewPath) {
  const sidecarPath = sidecarPathFor(reviewPath);
  if (existsSync(sidecarPath)) {
    try {
      return readFileSync(sidecarPath, "utf8");
    } catch {
      return "";
    }
  }
  if (existsSync(reviewPath)) {
    try {
      return readFileSync(reviewPath, "utf8");
    } catch {
      return "";
    }
  }
  return "";
}

function diffEntryLists(approvedLines, currentLines) {
  const approvedByPath = new Map();
  for (const line of approvedLines ?? []) {
    const parts = line.split(" ");
    approvedByPath.set(parts[1], line);
  }
  const currentByPath = new Map();
  for (const line of currentLines ?? []) {
    const parts = line.split(" ");
    currentByPath.set(parts[1], line);
  }
  const added = [];
  const removed = [];
  const changed = [];
  for (const [path, line] of currentByPath) {
    if (!approvedByPath.has(path)) {
      // A path with no approved-time entry that now shows DELETED means the
      // approval never touched this file and it was removed afterward --
      // report it as a deletion, not a generic "added" line, so --explain's
      // output matches what actually happened to the file.
      if (line.endsWith(" DELETED")) removed.push(path);
      else added.push(path);
    } else if (approvedByPath.get(path) !== line) {
      changed.push(path);
    }
  }
  for (const path of approvedByPath.keys()) {
    if (!currentByPath.has(path)) removed.push(path);
  }
  return {
    added: added.sort(),
    removed: [...new Set(removed)].sort(),
    changed: changed.sort(),
  };
}

// Fail-closed judgement: no binding info, or unmeasurable current state, or
// a mismatch all block the commit. Only an exact fingerprint match passes.
// Returns {ok, judgement, reason, approvedFingerprint, currentFingerprint}.
export function evaluateBinding(content, cwd) {
  const current = computeFingerprint({ cwd });
  const HOWTO =
    "지문 만드는 법: node scripts/check/review-approval-binding.mjs --explain";
  if (!current.ok) {
    return {
      ok: false,
      judgement: "판정 불가",
      reason: `판정 불가(커밋 차단): 현재 작업트리 지문을 잴 수 없음 (${current.reason}) -- ${HOWTO}`,
      approvedFingerprint: null,
      currentFingerprint: null,
    };
  }
  const approvedFingerprint = extractBindingFingerprint(content);
  if (approvedFingerprint === null) {
    return {
      ok: false,
      judgement: "결속 없음",
      reason: `결속 없음(커밋 차단): review.md에 binding-fingerprint 줄이 없다 -- ${HOWTO}`,
      approvedFingerprint: null,
      currentFingerprint: current.fingerprint,
    };
  }
  if (approvedFingerprint !== current.fingerprint) {
    return {
      ok: false,
      judgement: "불일치",
      reason: `불일치(커밋 차단): 승인 지문(${approvedFingerprint})과 현재 작업트리 지문(${current.fingerprint})이 다르다 -- 승인 후 코드가 바뀌었다. ${HOWTO}`,
      approvedFingerprint,
      currentFingerprint: current.fingerprint,
    };
  }
  // HYK-240 2R (반려 1 수리): the worktree fingerprint matches, but that
  // only proves the WORKING TREE matches what was approved -- `git commit`
  // writes the INDEX, not the working tree. Require they be identical too
  // (judgement stays "불일치" -- same bucket downstream consumers like
  // orch-stall-detect.mjs's judgeApprovalBindingForWorktree already treat
  // as MISMATCH -- just a distinct, actionable reason string).
  const sync = checkIndexWorktreeSync(cwd);
  if (!sync.ok) {
    return {
      ok: false,
      judgement: "판정 불가",
      reason: `판정 불가(커밋 차단): 인덱스와 작업트리가 일치하는지 확인할 수 없음 (${sync.reason}) -- ${HOWTO}`,
      approvedFingerprint,
      currentFingerprint: current.fingerprint,
    };
  }
  if (sync.desyncedPaths.length > 0) {
    return {
      ok: false,
      judgement: "불일치",
      reason: `불일치(커밋 차단): 작업트리 지문은 승인과 일치하지만, 실제 커밋될 인덱스 내용이 작업트리와 다르다(${sync.desyncedPaths.join(", ")}) -- git add 로 그 파일들을 스테이징한 뒤 다시 시도하거나(내용이 승인 시점과 같다면), 스테이징 내용이 승인 후 달라졌다면 재검토를 받아라. ${HOWTO}`,
      approvedFingerprint,
      currentFingerprint: current.fingerprint,
      desyncedPaths: sync.desyncedPaths,
    };
  }
  return {
    ok: true,
    judgement: "일치",
    reason: `일치(커밋 허용): 지문 ${current.fingerprint}`,
    approvedFingerprint,
    currentFingerprint: current.fingerprint,
  };
}

// Entry point review-gate.mjs's CLI block calls after checkReviewGate
// already confirmed independent-review approval evidence -- this is the
// ADDITIONAL check HYK-240 adds (approval <-> code-state binding). Kept as
// a separate function (not folded into checkReviewGate) so
// checkReviewGate's own pure-function contract, and the ~20 existing tests
// asserting its return shape, stay untouched.
// HYK-244 gate-unblock-1 §1 조각2: 사이드카가 있으면(existsSync로 먼저
// 확인) 사이드카를 정본으로 읽는다 -- 없으면 review.md 자신을 그대로
// 읽는다(하위호환, 위 readBindingSourceText와 같은 우선순위). ⛔여기서는
// 실패를 삼키지 않는다(readBindingSourceText와 달리) -- checkApprovalBinding
// 은 커밋 게이트 자신의 판정이라 "못 읽었다"를 반드시 throw로 드러내
// 아래 catch가 fail-closed(판정 불가)로 명시적으로 처리하게 한다(옛
// 동작과 동일한 계약 -- review.md가 아예 없을 때도 옛 코드는 이 catch로
// 떨어졌다, 그 동작을 그대로 보존).
export function checkApprovalBinding({ reviewPath, cwd = process.cwd() }) {
  const sidecarPath = sidecarPathFor(reviewPath);
  const sourcePath = existsSync(sidecarPath) ? sidecarPath : reviewPath;
  let content;
  try {
    content = readFileSync(sourcePath, "utf8");
  } catch (err) {
    return {
      ok: false,
      judgement: "판정 불가",
      reason: `판정 불가(커밋 차단): ${sourcePath === sidecarPath ? "승인 결속 사이드카" : "review.md"}를 다시 읽을 수 없음 (${err.message}) -- node scripts/check/review-approval-binding.mjs --explain`,
    };
  }
  return evaluateBinding(content, cwd);
}

function readReviewContentIfPresent(reviewPath) {
  const text = readBindingSourceText(reviewPath);
  return text.length > 0 ? text : null;
}

function judgeForExplain(content, reviewPath, cwd) {
  if (content) return evaluateBinding(content, cwd);
  return {
    judgement: "결속 없음",
    reason: `결속 없음(커밋 차단): review.md와 승인 결속 사이드카(${sidecarPathFor(reviewPath)}) 둘 다 없음 -- node scripts/check/review-approval-binding.mjs --explain`,
  };
}

function renderChangedFilesSection(approvedEntries, current) {
  const out = ["4) 바뀐 파일 목록:"];
  const diff = diffEntryLists(approvedEntries, current.entries);
  if (diff.added.length) out.push(`   추가: ${diff.added.join(", ")}`);
  if (diff.removed.length) {
    out.push(`   삭제/사라짐: ${diff.removed.join(", ")}`);
  }
  if (diff.changed.length) out.push(`   내용 변경: ${diff.changed.join(", ")}`);
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
    out.push(
      "   (review.md에 binding-entries 기록이 없어 파일 단위 비교 불가 -- 지문 해시만 다르다)",
    );
  }
  return out;
}

function renderExplain({ reviewPath, cwd }) {
  const content = readReviewContentIfPresent(reviewPath);
  const current = computeFingerprint({ cwd });
  const approvedFingerprint = content
    ? extractBindingFingerprint(content)
    : null;
  const approvedEntries = content ? extractBindingEntries(content) : null;
  const judged = judgeForExplain(content, reviewPath, cwd);

  const out = [
    `1) 승인이 결속된 지문: ${approvedFingerprint ?? "결속 없음(review.md에 binding-fingerprint 줄이 없거나 review.md가 없음)"}`,
    `2) 지금 작업트리의 지문: ${current.ok ? current.fingerprint : `판정 불가 (${current.reason})`}`,
    `3) 판정: ${judged.judgement} -- ${judged.reason}`,
  ];
  if (judged.desyncedPaths) {
    // Worktree fingerprint matched approval, but index differs from the
    // worktree -- the diff-based "4) 바뀐 파일 목록" below has nothing to
    // show (worktree itself never changed), so show the desync directly.
    out.push(
      "4) 바뀐 파일 목록(승인된 작업트리와 실제 커밋될 인덱스 사이):",
      `   ${judged.desyncedPaths.join(", ")}`,
    );
  } else if (judged.judgement === "불일치" && current.ok) {
    out.push(...renderChangedFilesSection(approvedEntries, current));
  }
  return out.join("\n");
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/review-approval-binding.mjs");

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const cwdIdx = args.indexOf("--cwd");
  const cwd = cwdIdx >= 0 ? args[cwdIdx + 1] : process.cwd();
  const reviewPathIdx = args.indexOf("--review-path");
  const reviewPath =
    reviewPathIdx >= 0
      ? args[reviewPathIdx + 1]
      : join(repoRoot(cwd), ".harness", "review.md");

  if (args.includes("--record")) {
    // HYK-244 gate-unblock-1 §1 조각2 원인ⓐ 수리: 옛 코드는 이 블록을
    // review.md 자신에 덧붙여 썼다(소비 완료된 결과 파일 무수정 수칙
    // 위반, §0 실사고의 직접 원인). 사이드카 파일(review.md 밖)에 항상
    // «새로» 쓴다 -- review.md는 여기서 단 한 글자도 건드리지 않는다.
    const current = computeFingerprint({ cwd });
    if (!current.ok) {
      console.error(`지문을 잴 수 없음: ${current.reason}`);
      process.exit(1);
    }
    const block = formatBindingBlock({
      fingerprint: current.fingerprint,
      entries: current.entries,
    });
    const force = args.includes("--force");
    const sidecarPath = sidecarPathFor(reviewPath);
    if (existsSync(sidecarPath)) {
      const existingSidecar = readFileSync(sidecarPath, "utf8");
      if (!force && extractBindingFingerprint(existingSidecar) !== null) {
        console.error(
          `승인 결속 사이드카에 이미 binding-fingerprint가 있음 -- 덮어쓰려면 --force 추가 (${sidecarPath})`,
        );
        process.exit(1);
      }
    }
    writeFileSync(sidecarPath, block, "utf8");
    console.log(`기록 완료: ${sidecarPath}\n${block}`);
    process.exit(0);
  }

  // Default (and --explain): human-readable report, per HYK-240 요건 1/2 --
  // must run with no required args in this worktree.
  console.log(renderExplain({ reviewPath, cwd }));
  process.exit(0);
}
