// HYK-419-retire-author-1/2/3 -- tests for retirement-auto-author-core.mjs's
// evaluateAutoAuthorAuthorization.
//
// ★2R (검토 P1-1 반영): 1R의 앵커 검사는 "문자열이 비어 있지 않은가"만
// 봤다 -- 검토가 정상 OPEN facts에 `ownTaskArchivePath:
// "rounds/DOES-NOT-EXIST.md"` / `ownTaskArchiveFingerprint:
// "FORGED-FINGERPRINT"` / `recordedAt: "not-a-time"` /
// `successorLabelForRecord: "../../not-a-real-successor"`를 주입해
// AUTHORIZED_DRAFT를 뽑아냈다(원문 그대로 재현, 아래 "★검토 원문 재현"
// 절). 이 파일은 그 네 값을 문자 그대로 시험에 박고, 각각 구별되는 사유
// 코드로 거부되는지 고정한다 + 정상 경로(진짜 파일 + 진짜 지문 + 진짜
// 시각) 회귀 0.
//
// ★3R (검토 P1-1 재반려 반영): 2R의 경로 탈출 검사는 lexical(문자열
// resolve + 포함관계)일 뿐이었다 -- 검토가 harnessDir 밖에 실파일을
// 두고 `harnessDir/rounds/linked.md` 심볼릭 링크로 그 파일을 가리키게
// 한 뒤, 링크 대상의 진짜 SHA-256과 과거 KST 시각을 넣어 기본(진짜
// fs/crypto) 경로로 호출했더니 `AUTHORIZED_DRAFT`가 나왔다(§4-b "★검토
// 심볼릭 표본 재현"이 이 표본을 문자 그대로 재현한다).
//
// ★4R (검토 P1-1 재반려 반영): 정상 경로 fixture의 `recordedAt`이
// `"2020-01-01 00:00:00 KST"` 절대 시각으로 하드코딩돼 있었다 -- 지금
// 실행에서는 우연히 과거라 통과했을 뿐, "과거임을 요구하는 시험"이라는
// 증거가 되지 못했다(완료조건 §⑾ⓗ 미충족, 검토 원문). `pastRecordedAt()`
// 이 `Date.now()`에서 파생된 상대값(30분 전)을 매 호출마다 계산하도록
// 고쳤다. 되돌림 변이는 정확히 **10건**(2R의 8건 + 3R의 realpath 관문
// 변이 1건 + 4R의 fixture 상대화 변이 1건).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  evaluateAutoAuthorAuthorization,
  AUTO_AUTHOR_STATE,
  HUMAN_REQUIRED_FIELDS,
} from "./retirement-auto-author-core.mjs";
import { NEVER_CONSUMED_RETIRE_STATE } from "./hyk412-never-consumed-retire-core.mjs";
import {
  checkRetirementRecord,
  RETIREMENT_RECORD_STATE,
} from "./retirement-record-core.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = join(CHECK_DIR, "retirement-auto-author-core.mjs");

test("retirement-auto-author-core.mjs imports exactly node:fs/node:crypto/node:path + the hyk412 gate core (2R: real verification needs real I/O, no more)", () => {
  const text = readFileSync(CORE_PATH, "utf8");
  const specifiers = [
    ...text.matchAll(/^import\s+[\s\S]*?\s+from\s+"([^"]+)";/gm),
  ].map((m) => m[1]);
  assert.deepEqual(specifiers, [
    "node:fs",
    "node:crypto",
    "node:path",
    "./hyk412-never-consumed-retire-core.mjs",
  ]);
});

function tmpHarnessDir() {
  return mkdtempSync(join(tmpdir(), "hyk419-auto-author-"));
}

function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

// 실제 archive 파일을 harnessDir 밑에 실제로 써 놓고, 그 실제 내용의 진짜
// 지문을 계산해 돌려준다 -- "정상 경로" 표본은 전부 이 함수로 만든다(문서
// 완료조건 §2⑷ "진짜 아카이브 파일 + 진짜 지문 + 진짜 시각").
function writeRealArchive(harnessDir, relPath, content) {
  const full = join(harnessDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return sha256Hex(content);
}

const REAL_ARCHIVE_REL_PATH = "rounds/coder-task-r1.md";
const REAL_ARCHIVE_CONTENT = "task_id: HYK-999-never-touched-1\n";

// ★4R (검토 P1-1 재반려 반영): 절대 시각 상수 대신 "지금"에서 파생된
// 상대값을 쓴다 -- retirement-auto-author-core.mjs가 스스로 파싱하는
// 것과 같은 KST(UTC+9) 오프셋으로, 로캘/실행 환경 시간대와 무관하게
// 항상 같은 문자열을 만든다(getUTC* 계열만 사용, 로컬 타임존 API 없음).
const KST_OFFSET_MS_FOR_FIXTURES = 9 * 60 * 60 * 1000;

function formatKstTimestamp(utcMs) {
  const shifted = new Date(utcMs + KST_OFFSET_MS_FOR_FIXTURES);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())} KST`
  );
}

// ★4R: 되돌림 변이 10/10 대상 -- 이 30분을 상수 절대 시각으로 되돌리면
// "지금에서 파생됐는가"를 잡는 시험이 RED가 된다. 30분은 checkTimezone
// Mislabel의 오탐 대역(정확히 9시간=540분 ±10분, 즉 530~550분 근처)과
// 충분히 멀다(30분은 그 대역에서 500분 이상 떨어져 있다) -- 그 대역
// 언저리를 스치지 않는 짧은 과거 값이라는 근거를 여기 명시로 남긴다.
const PAST_MINUTES_AGO_FOR_FIXTURES = 30;

function pastRecordedAt() {
  return formatKstTimestamp(
    Date.now() - PAST_MINUTES_AGO_FOR_FIXTURES * 60 * 1000,
  );
}

function openFacts(harnessDir, fingerprint, overrides = {}) {
  return {
    role: "CODER",
    harnessTaskLabel: "HYK-999-never-touched-1",
    ledgerReservation: {
      exists: true,
      harnessTaskLabel: "HYK-999-never-touched-1",
      status: "ACTIVE",
      completedAt: null,
    },
    dispatchReceiptMatchCount: 1,
    resultArchiveExists: false,
    ownTaskArchiveExists: true,
    hasLaterRoundArchive: false,
    staleEnoughSinceAdmission: true,
    successorLabelForRecord: "HYK-999-never-touched-2",
    harnessDir,
    ownTaskArchivePath: REAL_ARCHIVE_REL_PATH,
    ownTaskArchiveFingerprint: fingerprint,
    recordedAt: pastRecordedAt(),
    ...overrides,
  };
}

function withHarness(fn) {
  const harnessDir = tmpHarnessDir();
  try {
    const fingerprint = writeRealArchive(
      harnessDir,
      REAL_ARCHIVE_REL_PATH,
      REAL_ARCHIVE_CONTENT,
    );
    return fn(harnessDir, fingerprint);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. 게이트 재사용 (1R 회귀 유지)
// ---------------------------------------------------------------------------

test("CLOSED: hyk412 게이트가 LEDGER_RECORD_MISSING이면 -> GATE_CLOSED, gateState 그대로 전달", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { ledgerReservation: { exists: false } }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.GATE_CLOSED);
    assert.equal(r.ok, false);
    assert.equal(
      r.gateState,
      NEVER_CONSUMED_RETIRE_STATE.LEDGER_RECORD_MISSING,
    );
  });
});

test("CLOSED: hyk412 게이트가 SUCCESSOR_ROUND_EXISTS(case B)이면 -> GATE_CLOSED", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { hasLaterRoundArchive: true }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.GATE_CLOSED);
    assert.equal(
      r.gateState,
      NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_ROUND_EXISTS,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. ★검토 원문 재현 -- 네 값을 문자 그대로 주입, 각각 구별되는 사유 코드.
// ---------------------------------------------------------------------------

test("★검토 원문 재현 ⓐ: ownTaskArchivePath='rounds/DOES-NOT-EXIST.md' -> ARCHIVE_PATH_NOT_FOUND (초안 만들어지지 않음)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, {
        ownTaskArchivePath: "rounds/DOES-NOT-EXIST.md",
      }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.ARCHIVE_PATH_NOT_FOUND);
    assert.equal(r.ok, false);
    assert.equal(r.draftRecord, undefined);
  });
});

test("★검토 원문 재현 ⓑ: ownTaskArchiveFingerprint='FORGED-FINGERPRINT' -> FINGERPRINT_INVALID (초안 만들어지지 않음)", () => {
  withHarness((harnessDir) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, "FORGED-FINGERPRINT"),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.FINGERPRINT_INVALID);
    assert.equal(r.ok, false);
    assert.equal(r.draftRecord, undefined);
  });
});

test("★검토 원문 재현 ⓒ: recordedAt='not-a-time' -> RECORDED_AT_INVALID (초안 만들어지지 않음)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { recordedAt: "not-a-time" }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.RECORDED_AT_INVALID);
    assert.equal(r.ok, false);
    assert.equal(r.draftRecord, undefined);
  });
});

test("★검토 원문 재현 ⓓ: successorLabelForRecord='../../not-a-real-successor' -> SUCCESSOR_LABEL_GRAMMAR_INVALID (초안 만들어지지 않음)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, {
        successorLabelForRecord: "../../not-a-real-successor",
      }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.SUCCESSOR_LABEL_GRAMMAR_INVALID);
    assert.equal(r.ok, false);
    assert.equal(r.draftRecord, undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. 실물 검증 세부 -- 각 관문별 추가 표본.
// ---------------------------------------------------------------------------

test("ARCHIVE_PATH_TRAVERSAL: ownTaskArchivePath가 '..' 세그먼트를 포함하면 파일시스템에 닿기 전에 거부", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, {
        ownTaskArchivePath: "../outside/escape.md",
      }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.ARCHIVE_PATH_TRAVERSAL);
  });
});

test("ARCHIVE_PATH_TRAVERSAL: 절대경로/드라이브 표기도 거부(윈도우 드라이브 표기 포함)", () => {
  withHarness((harnessDir, fp) => {
    const r1 = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { ownTaskArchivePath: "/etc/passwd" }),
    );
    assert.equal(r1.state, AUTO_AUTHOR_STATE.ARCHIVE_PATH_TRAVERSAL);
    const r2 = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, {
        ownTaskArchivePath: "C:\\Windows\\System32\\config",
      }),
    );
    assert.equal(r2.state, AUTO_AUTHOR_STATE.ARCHIVE_PATH_TRAVERSAL);
  });
});

test("FINGERPRINT_INVALID: 형식은 맞지만(소문자 hex 64자) 실제 파일과 다른 지문은 거부(문자열 비교가 아니라 실제로 다시 해싱)", () => {
  withHarness((harnessDir) => {
    const wrongButWellFormed = "0".repeat(64);
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, wrongButWellFormed),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.FINGERPRINT_INVALID);
    assert.match(r.reason, /다시 해싱한 값/);
  });
});

test("FINGERPRINT_INVALID: 대문자 hex(형식 다름)도 거부(이 코어의 해시 출력 형식은 소문자로 고정)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp.toUpperCase()),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.FINGERPRINT_INVALID);
  });
});

test("ARCHIVE_UNREADABLE: 파일은 존재하지만 읽기 자체가 실패하면(주입된 seam) 별도 사유로 거부", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(openFacts(harnessDir, fp), {
      readFileFn: () => {
        throw new Error("synthetic read failure");
      },
    });
    assert.equal(r.state, AUTO_AUTHOR_STATE.ARCHIVE_UNREADABLE);
    assert.match(r.reason, /synthetic read failure/);
  });
});

// ★4R §2⑵ 훑기: 이 값은 «절대 시각 하드코딩» 대역 밖이다 -- 2월 30일은
// 어느 해에도 존재하지 않는 달력 날짜라서 "지금 기준 과거/미래"라는
// 개념 자체가 성립하지 않는다(달력 검증 실패를 시험하는 것이지 시간
// 경과를 시험하는 게 아니다) -- 그래서 상대값으로 바꾸지 않고 그대로
// 둔다.
test("RECORDED_AT_INVALID: 존재하지 않는 달력 날짜(2026-02-30)도 거부(정규식만으로는 못 잡는 값)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { recordedAt: "2026-02-30 10:00:00 KST" }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.RECORDED_AT_INVALID);
  });
});

// ★4R §2⑵ 훑기: 이 값도 그대로 둔다 -- "미래 시각 거부"를 고정하기
// «위해 일부러» 박은 절대 시각이다(검토 반려문이 명시적으로 예시로 든
// 제외 사유). 2099년은 이 시험이 계속 존재할 것으로 예상되는 기간
// 동안 "지금"이 될 수 없으므로, 상대값으로 바꿀 이유도 없고 바꾸면
// 오히려 "미래"라는 조건 자체를 흐린다.
test("RECORDED_AT_INVALID: 미래 시각은 형식이 멀쩡해도 거부", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { recordedAt: "2099-01-01 00:00:00 KST" }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.RECORDED_AT_INVALID);
    assert.match(r.reason, /미래 시각/);
  });
});

test("SUCCESSOR_LABEL_GRAMMAR_INVALID: 라벨 문법을 벗어나는 다른 형태(슬래시 포함)도 거부", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, {
        successorLabelForRecord: "HYK-1/../2",
      }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.SUCCESSOR_LABEL_GRAMMAR_INVALID);
  });
});

test("ARCHIVE_PATH_UNRESOLVABLE: realpathFn이 ENOENT가 아닌 다른 이유로 실패하면(권한 등) 별도 사유로 fail-closed(조용한 통과 금지, coder-task.md §2⑴)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(openFacts(harnessDir, fp), {
      realpathFn: () => {
        const err = new Error("synthetic EACCES");
        err.code = "EACCES";
        throw err;
      },
    });
    assert.equal(r.state, AUTO_AUTHOR_STATE.ARCHIVE_PATH_UNRESOLVABLE);
    assert.equal(r.ok, false);
    assert.match(r.reason, /synthetic EACCES/);
  });
});

// ---------------------------------------------------------------------------
// 3-b. ★3R 검토 심볼릭 표본 재현 -- harnessDir 밖 실파일 + harnessDir
// 내부의 심볼릭 링크가 그 파일을 가리킴 + 링크 대상의 진짜 SHA-256 +
// 과거 KST 시각 ⇒ 기본(진짜 fs/crypto) 경로로도 거부돼야 한다.
//
// 심볼릭 링크 생성은 플랫폼/권한에 좌우된다(coder-task.md §2⑵의 명시적
// 요구: 실패하면 조용히 빼지 말고 사실을 적어라). 이 좌석은 실측으로
// Windows에서 Administrator 권한으로 파일 심볼릭 링크 생성이 성공함을
// 먼저 확인했다(`fs.symlinkSync(target, link, "file")`, 사전 스파이크
// 스크립트로 직접 실행해 확인 -- 결과 파일의 "심볼릭 시험을 어떻게
// 만들었나" 절 참조). 그래도 이 시험 스위트 자체는 재실행 환경이 다를
// 수 있으므로 실패를 무시하지 않는다 -- symlink 생성이 실패하면 그
// 사실을 stderr에 남기고 `t.skip`으로 건너뛴다(조용히 빠지지 않는다).
// ---------------------------------------------------------------------------

function trySymlink(target, linkPath) {
  try {
    symlinkSync(target, linkPath, "file");
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

test("★검토 심볼릭 표본 재현: harnessDir 밖 실파일을 가리키는 rounds/linked.md 심볼릭 링크 + 링크 대상의 진짜 SHA-256 + 과거 KST 시각 -> 거부(ARCHIVE_PATH_TRAVERSAL), 기본 실 fs/crypto 경로로 호출", (t) => {
  const outerDir = tmpHarnessDir();
  const harnessDir = join(outerDir, "harness");
  mkdirSync(join(harnessDir, "rounds"), { recursive: true });
  try {
    const outsideContent =
      "this file lives OUTSIDE harnessDir -- the exact reviewer shape\n";
    const outsidePath = join(outerDir, "outside-real.md");
    writeFileSync(outsidePath, outsideContent, "utf8");
    const linkPath = join(harnessDir, "rounds", "linked.md");
    const symlinkAttempt = trySymlink(outsidePath, linkPath);
    if (!symlinkAttempt.ok) {
      console.error(
        `★검토 심볼릭 표본 재현: symlinkSync 실패(${symlinkAttempt.err.code ?? symlinkAttempt.err.message}) -- 이 좌석/실행 환경에서 심볼릭 링크 생성 권한이 없다. 대체 수단(정션)은 파일 단위 링크를 지원하지 않아 이 표본을 그대로 재현할 수 없다 -- skip.`,
      );
      t.skip(
        `symlinkSync unavailable in this environment: ${symlinkAttempt.err.code ?? symlinkAttempt.err.message}`,
      );
      return;
    }
    // 링크 «대상»의 진짜 SHA-256 -- 검토 원문 그대로("링크가 가리키는
    // 실제 내용의 SHA-256").
    const realFingerprint = sha256Hex(outsideContent);
    const facts = openFacts(harnessDir, realFingerprint, {
      ownTaskArchivePath: "rounds/linked.md",
    });
    // 기본(진짜 fs/crypto/시계) 경로로 호출 -- deps를 아무것도 주입하지
    // 않는다, 검토 원문의 "기본 실제 FS/crypto 경로로 호출했더니"를
    // 그대로 재현한다.
    const r = evaluateAutoAuthorAuthorization(facts);
    assert.equal(
      r.state,
      AUTO_AUTHOR_STATE.ARCHIVE_PATH_TRAVERSAL,
      `실패: 심볼릭 링크가 harnessDir 밖을 가리키는데도 거부되지 않음(state=${r.state})`,
    );
    assert.equal(r.ok, false);
    assert.equal(r.draftRecord, undefined);
    assert.match(r.reason, /심볼릭 링크\/정션/);
  } finally {
    rmSync(outerDir, { recursive: true, force: true });
  }
});

test("★과차단 0 회귀: 링크가 아닌 «진짜» harnessDir 내부 파일은 여전히 초안이 만들어진다(3R이 정상 경로를 막지 않았다는 직접 증거)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(openFacts(harnessDir, fp));
    assert.equal(r.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
    assert.equal(r.ok, true);
  });
});

test("★구조적 닫힘 훑기(coder-task.md §2⑷): 다른 경로 형태들도 닫힘 -- 상대경로 조합(./rounds/../rounds/x.md는 실재하지 않으므로 NOT_FOUND), 혼합 './'+'..' (../a/./b), UNC 형태(\\\\\\\\server\\\\share), 매우 긴 경로", () => {
  withHarness((harnessDir, fp) => {
    const notFoundOrTraversal = [
      AUTO_AUTHOR_STATE.ARCHIVE_PATH_NOT_FOUND,
      AUTO_AUTHOR_STATE.ARCHIVE_PATH_TRAVERSAL,
    ];
    for (const weirdPath of [
      "./rounds/../rounds/does-not-exist.md",
      "../a/./b/escape.md",
      "\\\\server\\share\\escape.md",
      `rounds/${"a".repeat(4000)}.md`,
    ]) {
      const r = evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, { ownTaskArchivePath: weirdPath }),
      );
      assert.ok(
        notFoundOrTraversal.includes(r.state),
        `경로 '${weirdPath}' -> 예상 밖 상태 ${r.state} (AUTHORIZED_DRAFT로 새지 않았는지만 확인, 실제 사유는 플랫폼에 따라 갈릴 수 있어 두 상태 중 하나면 통과로 본다)`,
      );
      assert.notEqual(r.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. §2⑶ 미열거 기본값 = 닫힘 -- 타입 뒤섞기·null·객체.
// ---------------------------------------------------------------------------

for (const [field, weirdValue] of [
  ["harnessDir", 12345],
  ["harnessDir", null],
  ["harnessDir", {}],
  ["ownTaskArchivePath", 12345],
  ["ownTaskArchivePath", null],
  ["ownTaskArchivePath", {}],
  ["ownTaskArchiveFingerprint", 12345],
  ["ownTaskArchiveFingerprint", null],
  ["ownTaskArchiveFingerprint", {}],
  ["recordedAt", 12345],
  ["recordedAt", null],
  ["recordedAt", {}],
]) {
  test(`CLOSED(타입 위조): ${field}=${JSON.stringify(weirdValue)} -> 안전측 거부(진짜 값이 아니면 어떤 타입도 통과하지 못한다)`, () => {
    withHarness((harnessDir, fp) => {
      const r = evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, { [field]: weirdValue }),
      );
      assert.notEqual(r.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
      assert.equal(r.ok, false);
    });
  });
}

test("CLOSED(타입 위조): successorLabelForRecord가 숫자/객체면 hyk412 게이트 자체가 먼저 닫는다(SUCCESSOR_LABEL_MISSING, isNonEmptyString 실패)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { successorLabelForRecord: 12345 }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.GATE_CLOSED);
    assert.equal(
      r.gateState,
      NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_LABEL_MISSING,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 정상 경로 회귀 0 -- 진짜 아카이브 파일 + 진짜 지문 + 진짜 시각.
// ---------------------------------------------------------------------------

test("GREEN(완료조건 §2⑷ 정상 경로 회귀 0): 진짜 파일 + 진짜 SHA-256 + 과거 KST 시각 + 문법에 맞는 후속 이름표 -> AUTHORIZED_DRAFT", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(openFacts(harnessDir, fp));
    assert.equal(r.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
    assert.equal(r.ok, true);
    assert.equal(r.draftRecord.archivePath, REAL_ARCHIVE_REL_PATH);
    assert.equal(r.draftRecord.archiveFingerprintClaimed, fp);
    assert.equal(r.draftRecord.blockReasonCode, null);
    assert.deepEqual([...r.humanRequiredFields], ["blockReasonCode"]);
    assert.deepEqual(r.humanRequiredFields, HUMAN_REQUIRED_FIELDS);
  });
});

test("GREEN: 후속 이름표가 슬러그 없이 'HYK-<숫자>' 단독이어도 문법상 허용(과차단 방지)", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, { successorLabelForRecord: "HYK-1000" }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
  });
});

// ---------------------------------------------------------------------------
// 6. blockReasonCode 구조적 닫힘 + 통합 시험 (1R 회귀 유지)
// ---------------------------------------------------------------------------

test("GREEN: facts에 blockReasonCode를 위조해 넣어도 draftRecord.blockReasonCode는 항상 null", () => {
  withHarness((harnessDir, fp) => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, fp, {
        blockReasonCode: "DONE_TIMESTAMP_NOT_PARSEABLE",
      }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
    assert.equal(r.draftRecord.blockReasonCode, null);
  });
});

test("통합: AUTHORIZED_DRAFT의 draftRecord를 checkRetirementRecord에 넣으면 INVALID_REASON_CODE로 거부됨", () => {
  withHarness((harnessDir, fp) => {
    const auto = evaluateAutoAuthorAuthorization(openFacts(harnessDir, fp));
    assert.equal(auto.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
    const verdict = checkRetirementRecord({
      role: auto.draftRecord.role,
      harnessTaskLabel: auto.draftRecord.harnessTaskLabel,
      candidates: [
        {
          record: auto.draftRecord,
          archiveExists: true,
          archiveFingerprintMatches: true,
          liveFingerprintMatches: null,
          blockReasonConfirmed: null,
        },
      ],
    });
    assert.equal(verdict.state, RETIREMENT_RECORD_STATE.INVALID_REASON_CODE);
  });
});

test("통합: 사람이 blockReasonCode를 채우면 구조적으로 RETIRED까지 통과할 수 있다", () => {
  withHarness((harnessDir, fp) => {
    const auto = evaluateAutoAuthorAuthorization(openFacts(harnessDir, fp));
    const humanFilled = {
      ...auto.draftRecord,
      blockReasonCode: "DONE_REWRITE_LOCKED",
    };
    const verdict = checkRetirementRecord({
      role: humanFilled.role,
      harnessTaskLabel: humanFilled.harnessTaskLabel,
      candidates: [
        {
          record: humanFilled,
          archiveExists: true,
          archiveFingerprintMatches: true,
          liveFingerprintMatches: true,
          blockReasonConfirmed: null,
        },
      ],
    });
    assert.equal(verdict.state, RETIREMENT_RECORD_STATE.RETIRED);
  });
});

// ---------------------------------------------------------------------------
// 7. 되돌림 변이(mutation) -- 정확히 10건, 문서(설계 문서 §7)의 숫자와 일치.
// 소스는 메모리에서만 읽어 고친 사본을 임시 디렉터리에 써서 동적 임포트
// 한다 -- 실 저장소 파일은 쓰기 대상이 아니므로 바이트 동일 복원이
// 구조적으로 보장된다(원복 증명은 그래도 각 시험 안에서 재확인한다).
// ---------------------------------------------------------------------------

function tmpMutantDir() {
  return mkdtempSync(join(tmpdir(), "hyk419-auto-author-mut-"));
}

async function importMutant(mutatedSource, dir) {
  writeFileSync(
    join(dir, "hyk412-never-consumed-retire-core.mjs"),
    readFileSync(
      join(CHECK_DIR, "hyk412-never-consumed-retire-core.mjs"),
      "utf8",
    ),
    "utf8",
  );
  const dest = join(dir, "retirement-auto-author-core.mjs");
  writeFileSync(dest, mutatedSource, "utf8");
  return import(`file://${dest}?t=${Date.now()}-${Math.random()}`);
}

function assertMutationTargetUnique(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `${label}: mutation target must appear exactly once (found ${count})`,
  );
}

function assertOriginalUnchanged(src) {
  assert.equal(
    readFileSync(CORE_PATH, "utf8"),
    src,
    "원복 증명 실패: 실제 retirement-auto-author-core.mjs가 시험 도중 바뀌었다",
  );
}

test("되돌림 변이 1/10: 게이트-닫힘 검사 제거 -> CLOSED facts도 AUTHORIZED_DRAFT로 잘못 열린다(RED), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  if (gate.state !== NEVER_CONSUMED_RETIRE_STATE.OPEN) {
    return {
      state: AUTO_AUTHOR_STATE.GATE_CLOSED,
      ok: false,
      gateState: gate.state,
      reason: \`retirement-auto-author: hyk412 게이트가 OPEN이 아님(\${gate.state}) -> 자동 작성 자격 없음, 거부(안전측 기본값). 게이트 사유: \${gate.reason}\`,
    };
  }
`;
  assertMutationTargetUnique(src, target, "mutation 1");
  const mutated = src.replace(target, "");
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = await withHarness((harnessDir, fp) =>
      mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, { ledgerReservation: { exists: false } }),
      ),
    );
    assert.equal(r.state, "AUTHORIZED_DRAFT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 2/10: 앵커-미완성(존재 확인) 검사 제거 -> 문자열이 아닌 harnessDir이 조용히 넘어가 예외로 새어 나간다(RED, 크래시 방지 목적이 실제로 이 관문임을 증명), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  const anchorFailure = checkMachineAnchorFacts({
    harnessDir,
    ownTaskArchivePath,
    ownTaskArchiveFingerprint,
    recordedAt,
  });
  if (anchorFailure) return anchorFailure;
`;
  assertMutationTargetUnique(src, target, "mutation 2");
  const mutated = src.replace(target, "");
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    await withHarness(async (harnessDir, fp) => {
      await assert.rejects(
        () =>
          Promise.resolve().then(() =>
            mod.evaluateAutoAuthorAuthorization(
              openFacts(harnessDir, fp, { harnessDir: 12345 }),
            ),
          ),
        /TypeError/,
        "RED: 앵커-미완성 검사가 없으면 harnessDir 타입 위조가 구조화된 거부 대신 예외로 새어 나간다",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 3/10: blockReasonCode 하드코딩 제거 -> 위조된 사유 코드가 draftRecord로 새어 나간다(RED), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = "      blockReasonCode: null,";
  assertMutationTargetUnique(src, target, "mutation 3");
  const mutated = src.replace(
    target,
    "      blockReasonCode: facts.blockReasonCode ?? null,",
  );
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = await withHarness((harnessDir, fp) =>
      mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, { blockReasonCode: "FORGED_REASON_CODE" }),
      ),
    );
    assert.equal(r.state, "AUTHORIZED_DRAFT");
    assert.equal(r.draftRecord.blockReasonCode, "FORGED_REASON_CODE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 4/10: resolveSafeArchivePath의 경로 탈출 방어 두 겹(문자열 휴리스틱 + resolve 결과 포함관계 재확인)을 통째로 제거하면 -> ★3R 이후에도 harnessDir 밖의 «실재하는» 파일은 realpath 재확인(mutation 6이 지키는 관문)이 독립적으로 여전히 막는다(AUTHORIZED_DRAFT로 새지 않는다, 이중 방어가 실제로 작동) -- 그러나 «부재»(존재하지 않는 탈출 경로)의 사유 코드가 ARCHIVE_PATH_TRAVERSAL에서 ARCHIVE_PATH_NOT_FOUND로 바뀐다(RED, 이 관문이 «올바른 사유 코드를 즉시 주는 것»에 인과적으로 기여한다는 증거), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  if (looksLikeTraversal(relPath)) return null;
  const base = resolve(harnessDir);
  const full = resolve(base, relPath);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
`;
  assertMutationTargetUnique(src, target, "mutation 4");
  const mutated = src.replace(
    target,
    `  const base = resolve(harnessDir);
  const full = resolve(base, relPath);
  return full;
`,
  );
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    await withHarness((harnessDir, fp) => {
      // ★3R 실측: 이 관문(lexical)만 지우면 realpath 재확인(mutation 6이
      // 지키는 별도 관문)이 «실재하는» harnessDir 밖 파일까지는 여전히
      // 막는다(방금 검증) -- 그래서 이 표본으로는 AUTHORIZED_DRAFT가
      // 나오지 않는다. 대신 «존재하지 않는» 탈출 경로에서 사유 코드가
      // 바뀐다는 것으로 이 관문의 인과 기여를 증명한다: lexical 관문이
      // 있으면 즉시 ARCHIVE_PATH_TRAVERSAL(파일시스템에 닿지 않고), 없으면
      // existsFn까지 내려가 ARCHIVE_PATH_NOT_FOUND로 바뀐다.
      const r = mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, {
          ownTaskArchivePath: "../outside/does-not-exist.md",
        }),
      );
      assert.notEqual(
        r.state,
        "ARCHIVE_PATH_TRAVERSAL",
        "RED: lexical 관문이 없으면 존재하지 않는 탈출 경로도 더 이상 ARCHIVE_PATH_TRAVERSAL로 안 잡히고 ARCHIVE_PATH_NOT_FOUND로 바뀐다",
      );
      assert.equal(r.state, "ARCHIVE_PATH_NOT_FOUND");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 5/10: 존재 확인 관문 제거 -> 'rounds/DOES-NOT-EXIST.md'(검토 원문)가 realpath 확인 단계로 새어 나간다(RED), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  if (existsFn(full) !== true) {
    return {
      ok: false,
      failure: {
        state: AUTO_AUTHOR_STATE.ARCHIVE_PATH_NOT_FOUND,
        ok: false,
        reason: \`retirement-auto-author: ownTaskArchivePath('\${ownTaskArchivePath}')가 가리키는 아카이브 사본이 실제로 존재하지 않음(\${full}) -> 거부(안전측 기본값)\`,
      },
    };
  }
`;
  assertMutationTargetUnique(src, target, "mutation 5");
  const mutated = src.replace(target, "");
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = await withHarness((harnessDir, fp) =>
      mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, {
          ownTaskArchivePath: "rounds/DOES-NOT-EXIST.md",
        }),
      ),
    );
    assert.notEqual(r.state, "ARCHIVE_PATH_NOT_FOUND");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 6/10 (★3R 신설): realpath 재확인 관문 제거 -> 검토의 심볼릭 표본(harnessDir 밖 실파일 + rounds/linked.md 링크 + 링크 대상 진짜 지문)이 그대로 AUTHORIZED_DRAFT까지 새어 나간다(RED, 이번 반려의 핵심 원인을 직접 증명), 원복 확인 -- symlink 생성이 이 환경에서 실패하면 skip", async (t) => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  const realpathFailure = verifyRealpathContainment(
    harnessDir,
    full,
    realpathFn,
  );
  if (realpathFailure) return { ok: false, failure: realpathFailure };
`;
  assertMutationTargetUnique(src, target, "mutation 6");
  const mutated = src.replace(target, "  void verifyRealpathContainment;\n");
  const dir = tmpMutantDir();
  const outerDir = tmpHarnessDir();
  try {
    const harnessDir = join(outerDir, "harness");
    mkdirSync(join(harnessDir, "rounds"), { recursive: true });
    const outsideContent = "mutation 6 decoy -- outside harnessDir\n";
    const outsidePath = join(outerDir, "outside-real.md");
    writeFileSync(outsidePath, outsideContent, "utf8");
    const linkPath = join(harnessDir, "rounds", "linked.md");
    const symlinkAttempt = trySymlink(outsidePath, linkPath);
    if (!symlinkAttempt.ok) {
      console.error(
        `되돌림 변이 6/10: symlinkSync 실패(${symlinkAttempt.err.code ?? symlinkAttempt.err.message}) -- skip`,
      );
      t.skip(
        `symlinkSync unavailable: ${symlinkAttempt.err.code ?? symlinkAttempt.err.message}`,
      );
      return;
    }
    const mod = await importMutant(mutated, dir);
    const r = mod.evaluateAutoAuthorAuthorization(
      openFacts(harnessDir, sha256Hex(outsideContent), {
        ownTaskArchivePath: "rounds/linked.md",
      }),
    );
    assert.equal(
      r.state,
      "AUTHORIZED_DRAFT",
      "RED: realpath 재확인이 없으면 심볼릭 링크로 우회된 harnessDir 밖 파일도 그대로 통과한다",
    );
  } finally {
    rmSync(outerDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 7/10: 지문 검사 제거 -> 'FORGED-FINGERPRINT'(검토 원문)가 그대로 AUTHORIZED_DRAFT까지 새어 나간다(RED), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  const fingerprintFailure = checkFingerprint({
    harnessDir,
    ownTaskArchivePath,
    ownTaskArchiveFingerprint,
    existsFn,
    realpathFn,
    readFileFn,
    hashFn,
  });
  if (fingerprintFailure) return fingerprintFailure;
`;
  assertMutationTargetUnique(src, target, "mutation 7");
  const mutated = src.replace(target, "");
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = await withHarness((harnessDir) =>
      mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, "FORGED-FINGERPRINT"),
      ),
    );
    assert.equal(r.state, "AUTHORIZED_DRAFT");
    assert.equal(r.draftRecord.archiveFingerprintClaimed, "FORGED-FINGERPRINT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 8/10: 기록시각 검사 제거 -> 'not-a-time'(검토 원문)이 그대로 AUTHORIZED_DRAFT까지 새어 나간다(RED), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  const recordedAtFailure = checkRecordedAt({ recordedAt, nowFn });
  if (recordedAtFailure) return recordedAtFailure;
`;
  assertMutationTargetUnique(src, target, "mutation 8");
  const mutated = src.replace(target, "");
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = await withHarness((harnessDir, fp) =>
      mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, { recordedAt: "not-a-time" }),
      ),
    );
    assert.equal(r.state, "AUTHORIZED_DRAFT");
    assert.equal(r.draftRecord.recordedAt, "not-a-time");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

test("되돌림 변이 9/10: 후속 이름표 문법 검사 제거 -> '../../not-a-real-successor'(검토 원문)가 그대로 AUTHORIZED_DRAFT까지 새어 나간다(RED), 원복 확인", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  const successorGrammarFailure = checkSuccessorLabelGrammar(
    successorLabelForRecord,
  );
  if (successorGrammarFailure) return successorGrammarFailure;
`;
  assertMutationTargetUnique(src, target, "mutation 9");
  const mutated = src.replace(target, "");
  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = await withHarness((harnessDir, fp) =>
      mod.evaluateAutoAuthorAuthorization(
        openFacts(harnessDir, fp, {
          successorLabelForRecord: "../../not-a-real-successor",
        }),
      ),
    );
    assert.equal(r.state, "AUTHORIZED_DRAFT");
    assert.equal(r.draftRecord.successorLabel, "../../not-a-real-successor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assertOriginalUnchanged(src);
  }
});

// ---------------------------------------------------------------------------
// 8. ★4R fixture 위생 -- pastRecordedAt()이 실제로 "지금"에서 파생되는지
// 이 시험 파일 자신의 소스를 정적으로 검사한다(검토 P1-1 재반려: 절대
// 시각 상수가 다시 스며들면 이 검사가 잡아야 한다). 되돌림 변이 10/10이
// 이 검사기 자체의 인과 기여를 증명한다.
// ---------------------------------------------------------------------------

// pastRecordedAt() 함수 본문에 Date.now()가 실제로 있는지만 본다 -- "지금"
// 에서 파생되는가"라는 요구를 그대로 코드로 옮긴 최소 검사기다. 함수를
// 못 찾으면(이름이 바뀌는 등) 안전측으로 위반 처리한다.
function fixtureUsesAbsoluteTimestamp(sourceText) {
  const m = /function pastRecordedAt\(\) \{([\s\S]*?)\n\}/.exec(sourceText);
  if (!m) return true;
  return !/Date\.now\(\)/.test(m[1]);
}

test("★4R 정적 검사: 이 시험 파일 자신의 pastRecordedAt()가 Date.now()에서 파생됨을 소스에서 직접 확인(절대 시각 하드코딩 회귀 감지기의 GREEN 대조군)", () => {
  const selfSrc = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.equal(
    fixtureUsesAbsoluteTimestamp(selfSrc),
    false,
    "pastRecordedAt()가 Date.now()를 참조하지 않는다 -- 절대 시각 상수로 되돌아갔을 가능성",
  );
});

test("되돌림 변이 10/10 (★4R 신설): pastRecordedAt()을 절대 시각 상수로 되돌리면 -> 위 정적 검사기가 위반으로 잡는다(RED, 검사기 자신의 인과 기여 증명), 원복 확인(이 파일 자신은 시험 도중 쓰기 대상이 아니었다)", () => {
  const selfSrc = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const target = `const PAST_MINUTES_AGO_FOR_FIXTURES = 30;

function pastRecordedAt() {
  return formatKstTimestamp(
    Date.now() - PAST_MINUTES_AGO_FOR_FIXTURES * 60 * 1000,
  );
}`;
  // ⚠️이 시험은 자기참조적이다 -- target 문자열 자체가 이 시험의 소스
  // 코드 안에도(바로 위 template literal로) 그대로 등장하므로, 파일
  // 전체에서 "정확히 1회"를 요구하는 일반 assertMutationTargetUnique는
  // 이 경우 구조적으로 항상 2를 낸다(실제 정의 1 + 이 인용문 1, 실측
  // 확인됨). 그래서 이 시험 «자신이 시작되는 지점 이전»의 접두 구간
  // 에서만 유일성을 확인한다 -- 그 접두 구간에는 진짜 정의만 있고
  // 이 인용문은 없다. `String.prototype.replace`는 첫 매치만 바꾸므로,
  // 접두 구간에서 유일함이 확인되면 아래 replace가 진짜 정의를
  // 정확히 겨냥한다는 것이 보장된다.
  const selfTestStart = selfSrc.indexOf('test("되돌림 변이 10/10');
  const prefix = selfSrc.slice(0, selfTestStart);
  assertMutationTargetUnique(prefix, target, "mutation 10 (prefix)");
  const mutated = selfSrc.replace(
    target,
    `const PAST_MINUTES_AGO_FOR_FIXTURES = 30;

function pastRecordedAt() {
  return "2020-01-01 00:00:00 KST";
}`,
  );
  assert.equal(
    fixtureUsesAbsoluteTimestamp(mutated),
    true,
    "RED: pastRecordedAt()을 상수로 되돌리면 정적 검사기가 위반을 잡아야 한다 -- 못 잡으면 검사기 자체가 무의미하다",
  );
  assert.equal(
    readFileSync(fileURLToPath(import.meta.url), "utf8"),
    selfSrc,
    "원복 증명 실패: 이 시험 파일 자신이 시험 도중 바뀌었다",
  );
});
