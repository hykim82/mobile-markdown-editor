import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  claimTx,
  startTx,
  finishAttemptTx,
  checkExpiryTx,
} from "./arm-state.mjs";
import { runSpikeAttempt } from "./orca-spike-runner.mjs";
import { checkRelayHandshake } from "../check/relay-handshake.mjs";

// HYK-162 coder-8 (review-7 rejected 325df95의 수리, 보고서-pm2.md §4.4
// M1~M10이 계약): 라이브 발사 경로 자격 결속 재구현.
//
// review-7이 잡은 결함: 이전 `runLive`는 개별 CLI 플래그(--human-approval-ref,
// --arm-id, --cycle-id, --target 등)로 자기 자신이 packet/arm/task를 합성하고
// (`buildSyntheticFixture`), request와 expected(채점 기준)를 같은 CLI 값에서
// 조립했다 -- "발사 자격의 자기대조". 이 파일은 그 두 값의 근원을 완전히
// 분리한다: 라이브가 받는 유일한 자격 입력은 `arm-seal.mjs`가 만든 sealed
// authorization 파일 하나의 경로뿐이고(M2), request/expected는 오직 그
// authorization에서 파생된 canonical grant 봉투에서만 파생된다(M4). CLI
// 개별 플래그로 이 값들을 재정의할 방법은 없다.
//
// **이 파일이 실 orca를 부르는 유일한 경로는 CLI 진입(맨 아래)뿐이고, 그마저
// 명시적 `--live` 플래그 없이는 아무 것도 하지 않는다** -- 이 커밋 자체는
// 발사가 아니다(review-8 선행 필요, 이 태스크에서 실 orca 호출 0).

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function errText(err) {
  try {
    if (err && typeof err === "object") {
      const m = err.message;
      if (typeof m === "string") return m;
    }
    return String(err);
  } catch {
    return "unknown error (message accessor threw)";
  }
}
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export const REASON = Object.freeze({
  CLI_SHAPE_INVALID: "CLI_SHAPE_INVALID",
  AUTHORIZATION_UNREADABLE: "AUTHORIZATION_UNREADABLE",
  GRANT_UNREADABLE: "GRANT_UNREADABLE",
  GRANT_AUTHORIZATION_MISMATCH: "GRANT_AUTHORIZATION_MISMATCH",
  GRANT_FINGERPRINT_CORRUPT: "GRANT_FINGERPRINT_CORRUPT",
  PACKET_MISMATCH: "PACKET_MISMATCH",
  EXPIRED: "EXPIRED",
  CLAIM_REFUSED: "CLAIM_REFUSED",
  START_REFUSED: "START_REFUSED",
  DISPATCH_RECHECK_FAILED: "DISPATCH_RECHECK_FAILED",
  ATTEMPT_FAILED: "ATTEMPT_FAILED",
  HANDSHAKE_RECHECK_FAILED: "HANDSHAKE_RECHECK_FAILED",
  COMPLETE: "COMPLETE",
});

function deny(reason, detail) {
  return { ok: false, reason, detail: detail ?? null };
}

// S1: authorization 결속 이후의 실패는 그 시점까지 관측된 데이터(원형 orca
// 응답 dumps, 도달한 receipts, output_root, attemptId)를 실어 나른다 --
// 결속 이전(argv 파싱·authorization/grant/packet 로드)의 deny()는 output_root
// 자체를 모르므로 그대로 둔다(T5).
function observedDeny(reason, detail, observed = {}) {
  return {
    ok: false,
    reason,
    detail: detail ?? null,
    outputRoot: observed.outputRoot,
    attemptId: observed.attemptId,
    dumps: observed.dumps ?? [],
    receipts: observed.receipts ?? [],
  };
}

// ---- M2: CLI 자격 입력은 authorization 경로 하나뿐 ----
// `--authorization <path>` 이외의 어떤 플래그도(--target/--arm-id/--human-
// approval-ref/--coordinator/--output-dir 등) 받지 않는다 -- 발견되면 즉시
// 거부한다(개별 자격 오버라이드 채널 원천 봉쇄).
export function parseLiveArgv(argv) {
  const a = Array.isArray(argv) ? argv : [];
  const idx = a.indexOf("--authorization");
  if (idx < 0 || idx + 1 >= a.length) {
    return deny(
      REASON.CLI_SHAPE_INVALID,
      "orca-spike-live: --authorization <path> is required (the only permitted credential input, M2)",
    );
  }
  const allowed = new Set(["--live", "--authorization", a[idx + 1]]);
  for (const tok of a) {
    if (tok.startsWith("--") && !allowed.has(tok)) {
      return deny(
        REASON.CLI_SHAPE_INVALID,
        `orca-spike-live: unrecognized flag '${tok}' -- individual credential flags are forbidden (M2); only --authorization <path> is accepted`,
      );
    }
  }
  return { ok: true, authorizationPath: a[idx + 1] };
}

function defaultDeps(overrides = {}) {
  return {
    readFileFn:
      typeof overrides.readFileFn === "function"
        ? overrides.readFileFn
        : (p) => readFileSync(p, "utf8"),
    writeFileFn:
      typeof overrides.writeFileFn === "function"
        ? overrides.writeFileFn
        : writeFileSync,
    existsFn:
      typeof overrides.existsFn === "function"
        ? overrides.existsFn
        : existsSync,
    renameFn:
      typeof overrides.renameFn === "function" ? overrides.renameFn : undefined,
    writeFn:
      typeof overrides.writeFn === "function" ? overrides.writeFn : undefined,
    readFn:
      typeof overrides.readFn === "function" ? overrides.readFn : undefined,
    nowFn:
      typeof overrides.nowFn === "function"
        ? overrides.nowFn
        : () => new Date().toISOString(),
    spawnSyncFn:
      typeof overrides.spawnSyncFn === "function"
        ? overrides.spawnSyncFn
        : spawnSync,
  };
}

function readJsonFile(path, deps, unreadableReason, invalidReason) {
  let raw;
  try {
    raw = deps.readFileFn(path);
  } catch (err) {
    return {
      ok: false,
      reason: deny(unreadableReason, `${path}: ${errText(err)}`),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: deny(invalidReason, `${path}: ${errText(err)}`),
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      reason: deny(invalidReason, `${path}: not a JSON object`),
    };
  }
  return { ok: true, raw, parsed };
}

// M4: authorization(불변, 유일한 CLI 자격 입력)이 grant 파일의 정확한
// SHA-256(grant_sha256)을 sealing 시점에 증언해뒀다 -- grant는 authorization
// **이후에** 생성될 수 없으므로(순서상 grant가 먼저 쓰이고 authorization이
// grant_sha256을 담아 나중에 봉인된다), 이 대조가 "sealing 이후 누군가 grant
// 파일만 따로 수정했는가"를 잡는 유일한 방어선이다. request/expected를 전부
// grant에서 파생시켜도(자기대조처럼 보일 수 있으나) grant 자체가 authorization
// 이 증언한 해시와 다르면 request/expected가 무엇이든 여기서 이미 거부된다.
function verifyGrantBinding(authorization, grant, grantRaw) {
  const grantHash = sha256(grantRaw);
  if (grantHash !== authorization.grant_sha256) {
    return deny(
      REASON.GRANT_AUTHORIZATION_MISMATCH,
      `orca-spike-live: grant envelope SHA-256 ${grantHash} != authorization's sealed grant_sha256 ${authorization.grant_sha256} -- grant tampered after sealing`,
    );
  }
  if (grant.addendum_sha256 !== authorization.addendum_sha256) {
    return deny(
      REASON.GRANT_AUTHORIZATION_MISMATCH,
      "orca-spike-live: grant.addendum_sha256 != authorization.addendum_sha256 -- grant/authorization sealed from different addenda",
    );
  }
  // target fingerprint 자기정합성(구성요소로 재계산 -- grant 파일 통째 변조는
  // 위 grant_sha256 재계산으로 이미 잡히지만, 이 재계산은 grant 생성 로직
  // 자체의 정합성도 별도로 증명한다).
  const recomputedFingerprint = sha256(
    [
      authorization.target_terminal_handle,
      authorization.target_snapshot_sha256,
      authorization.target_repo_or_cwd,
      authorization.target_worktree_identity,
    ].join("|"),
  );
  if (
    grant.target_fingerprint !== recomputedFingerprint ||
    authorization.target_fingerprint !== recomputedFingerprint
  ) {
    return deny(
      REASON.GRANT_FINGERPRINT_CORRUPT,
      "orca-spike-live: target_fingerprint does not match its own recorded components",
    );
  }
  return { ok: true };
}

// M3: packet id/hash를 다시 대조 -- 실행 시점에 packet 파일이 sealing 이후
// 바뀌었거나 다른 signed packet으로 교체됐으면 거부한다(단일 SHA-256 대조가
// 서명자/시각을 포함한 내용 전체를 커버한다 -- 한 글자 변경도 잡는다).
function verifyPacketBinding(authorization, deps) {
  let packetContent;
  try {
    packetContent = deps.readFileFn(authorization.packet_path);
  } catch (err) {
    return deny(
      REASON.PACKET_MISMATCH,
      `orca-spike-live: cannot read packet '${authorization.packet_path}' (${errText(err)})`,
    );
  }
  const actualPacketHash = sha256(packetContent).toUpperCase();
  if (actualPacketHash !== String(authorization.packet_sha256).toUpperCase()) {
    return deny(
      REASON.PACKET_MISMATCH,
      `orca-spike-live: packet SHA-256 at launch time (${actualPacketHash}) != authorization's sealed hash (${authorization.packet_sha256}) -- different/tampered packet`,
    );
  }
  return { ok: true };
}

// ---- M3/M4: authorization + grant 봉투 읽기·결속 대조(오케스트레이션만) ----
function loadAndBindAuthorization(authorizationPath, deps) {
  const authRead = readJsonFile(
    authorizationPath,
    deps,
    REASON.AUTHORIZATION_UNREADABLE,
    REASON.AUTHORIZATION_UNREADABLE,
  );
  if (!authRead.ok) return authRead.reason;
  const authorization = authRead.parsed;
  if (!isNonEmptyString(authorization.grant_path)) {
    return deny(
      REASON.AUTHORIZATION_UNREADABLE,
      "orca-spike-live: authorization missing grant_path",
    );
  }

  const grantRead = readJsonFile(
    authorization.grant_path,
    deps,
    REASON.GRANT_UNREADABLE,
    REASON.GRANT_UNREADABLE,
  );
  if (!grantRead.ok) return grantRead.reason;
  const grant = grantRead.parsed;

  const bindingCheck = verifyGrantBinding(authorization, grant, grantRead.raw);
  if (!bindingCheck.ok) return bindingCheck;

  const packetCheck = verifyPacketBinding(authorization, deps);
  if (!packetCheck.ok) return packetCheck;

  return {
    ok: true,
    authorization,
    grant,
    authorizationHash: sha256(authRead.raw),
    grantRaw: grantRead.raw,
  };
}

function taskDescriptor(grant, attemptId, atIso) {
  return {
    task_id: grant.task_id,
    cycle_id: grant.cycle_id,
    lane: grant.role,
    attempt_id: attemptId,
    content_hash: grant.task_hash,
    at: atIso,
  };
}

// ---- M9: create-new-only 출력 ----
function writeNewFileOnly(path, content, writeFileFn) {
  writeFileFn(path, content, { flag: "wx" });
}

// ---- M5: 첫 execFn 호출(=task-create 직전)에서만 원자 claim+start ----
// 기존 arm-state claim/start 트랜잭션을 재사용한다(새 경합 로직 자작 금지).
// spawnFn은 no-op(실제 orca 호출은 execFn 체인이 한다 -- arm-state의
// spawnFn 훅으로 이중 호출하지 않는다). null 반환 = 계속 진행, 객체 반환 =
// 그 사유로 즉시 중단(첫 real orca 호출 전이므로 task-create 자체가 0회).
function performClaimAndStart(ctx) {
  const { armDir, armId, attemptId, grant, txDeps, deps } = ctx;
  const atIso = deps.nowFn();
  const claimResult = claimTx(
    armDir,
    armId,
    taskDescriptor(grant, attemptId, atIso),
    txDeps,
  );
  if (!claimResult.ok || claimResult.spawnAllowed !== true) {
    return { reason: REASON.CLAIM_REFUSED, detail: claimResult.reason };
  }
  const startResult = startTx(
    armDir,
    armId,
    { task_id: grant.task_id, attempt_id: attemptId, at: atIso },
    { ...txDeps, spawnFn: () => {} },
  );
  if (!startResult.ok || startResult.spawned !== true) {
    return { reason: REASON.START_REFUSED, detail: startResult.reason };
  }
  return null;
}

function disarmMidFlight(ctx, detailReason) {
  const { armDir, armId, grant, attemptId, deps, txDeps } = ctx;
  finishAttemptTx(
    armDir,
    armId,
    {
      task_id: grant.task_id,
      attempt_id: attemptId,
      at: deps.nowFn(),
      outcome: "error",
      detail: { reason: detailReason },
    },
    txDeps,
  );
}

// ---- M6: task-create 뒤, dispatch 직전 재검사(만료 + grant/task 파일 불변성 --
// target fingerprint/task hash는 grant 파일에 들어있으므로 grant 파일 전체
// 재해시 비교가 그 값들의 변경도 함께 잡는다). null 반환 = dispatch 진행 허용.
function performDispatchRecheck(ctx) {
  const { armDir, armId, grant, deps, txDeps, boundGrantRaw } = ctx;
  const expiryRecheck = checkExpiryTx(
    armDir,
    armId,
    txDeps.nowFn,
    deps.nowFn(),
    txDeps,
  );
  if (!expiryRecheck.ok || expiryRecheck.expired) {
    return {
      reason: REASON.DISPATCH_RECHECK_FAILED,
      detail: `expired before dispatch (${expiryRecheck.reason ?? "expired"})`,
    };
  }
  let freshGrantRaw;
  try {
    freshGrantRaw = deps.readFileFn(ctx.authorization.grant_path);
  } catch {
    freshGrantRaw = null;
  }
  if (freshGrantRaw !== boundGrantRaw) {
    disarmMidFlight(ctx, "grant envelope changed mid-flight");
    return {
      reason: REASON.DISPATCH_RECHECK_FAILED,
      detail: "grant envelope changed between task-create and dispatch",
    };
  }
  let freshTaskContent;
  try {
    freshTaskContent = deps.readFileFn(grant.task_file_path);
  } catch {
    freshTaskContent = null;
  }
  if (
    freshTaskContent === null ||
    sha256(freshTaskContent) !== grant.task_hash
  ) {
    disarmMidFlight(ctx, "task content changed mid-flight");
    return {
      reason: REASON.DISPATCH_RECHECK_FAILED,
      detail: "task content changed between task-create and dispatch",
    };
  }
  return null;
}

// ---- M10: claim/start가 실제로 성공했던 시도만 finishAttemptTx로 종결
// (RUNNING -> terminal -> DISARMED). predispatch 단계에서 이미 거부된 경우
// (claim 시도조차 없었던 경우)는 store가 ARMED 그대로다 -- arm-state 스스로의
// claim() 로직이 다음 시도에서도 동일 검증을 반복한다.
function concludeAttempt(ctx, result) {
  const { armDir, armId, grant, attemptId, deps, txDeps } = ctx;
  const outcome = result.ok
    ? "done"
    : result.reason === "CHECK_ESCALATION"
      ? "question"
      : "error";
  finishAttemptTx(
    armDir,
    armId,
    {
      task_id: grant.task_id,
      attempt_id: attemptId,
      at: deps.nowFn(),
      outcome,
      detail: { reason: result.reason },
    },
    txDeps,
  );
}

// ---- M7/M8 (honesty, 정직 한계): worker_done payload의 taskId/dispatchId
// 실제 키 위치는 라이브 미실측이다(orca-spike-runner.mjs의 G-b 주석과 동일
// 근거 -- task-create 응답만 ORCH가 read-only로 실측했고, dispatch 응답/
// check --wait 메시지 envelope의 taskId/dispatchId 필드 위치는 확인되지
// 않았다). 이 함수는 그 미확인 필드를 추측으로 매핑하지 않는다. 대신 완료
// 권위는 오직 checkRelayHandshake(파일 결속, 확인된 계약)에만 있고, 여기서는
// runSpikeAttempt가 이미 ok:true를 반환한 뒤에도 handshake를 다시 한 번
// 재확인한다 -- 미확인 스키마 경로는 성공 선언 없이 PAUSED로 수렴해야 한다는
// 인수 조건을 지킨다.
function verifyFreshHandshake(grant) {
  return checkRelayHandshake({
    role: grant.role,
    harnessDir: grant.harness_dir,
  });
}

// ---- 라이브 1회 시도 ----
// opts.deps: 테스트 주입용(readFileFn/writeFileFn/existsFn/renameFn/writeFn/
// readFn/nowFn/spawnSyncFn). 생략 시 실제 fs/시계/spawnSync.
function buildTxDeps(deps) {
  return {
    readFileFn: deps.readFileFn,
    writeFileFn: deps.writeFileFn,
    existsFn: deps.existsFn,
    renameFn: deps.renameFn,
    writeFn: deps.writeFn,
    readFn: deps.readFn,
    // arm-state's safeNow requires a safe-integer ms clock -- derive it from
    // the injected ISO nowFn so tests can control expiry deterministically
    // (M6/A7: nowFn returning increasing timestamps across calls).
    nowFn: () => Date.parse(deps.nowFn()),
  };
}

function checkPreflightExpiry(grant, deps) {
  const preNowMs = Date.parse(deps.nowFn());
  if (
    !Number.isSafeInteger(preNowMs) ||
    preNowMs > Date.parse(grant.expires_at)
  ) {
    return {
      failed: deny(
        REASON.EXPIRED,
        `orca-spike-live: authorization already expired at pre-flight (expires_at=${grant.expires_at})`,
      ),
    };
  }
  return { preNowMs };
}

// M5/M6 gate wrapped around the raw orca execFn: claim+start happens lazily
// on the very first call (task-create, before any real spawn); the dispatch
// recheck happens on the call whose argv names "dispatch". `state` carries
// the claimed/failure flags back out to the caller (closures can't return
// two things at once without an object).
function makeWrappedExecFn(ctx, rawExecFn, state) {
  return function wrappedExecFn(commandArgv) {
    if (!state.claimed) {
      state.claimed = true;
      const failure = performClaimAndStart(ctx);
      if (failure) {
        state.failure = failure;
        return {
          ok: false,
          reason: `orca-spike-live: ${failure.reason} -- ${failure.detail}`,
        };
      }
    } else if (Array.isArray(commandArgv) && commandArgv[1] === "dispatch") {
      const failure = performDispatchRecheck(ctx);
      if (failure) {
        state.failure = failure;
        return {
          ok: false,
          reason: `orca-spike-live: ${failure.reason} -- ${failure.detail}`,
        };
      }
    }
    return rawExecFn(commandArgv);
  };
}

function buildAttemptInput(ctx, preNowMs) {
  const { armDir, armId, authorization, grant } = ctx;
  const request = {
    human_approval_ref: grant.human_approval_ref,
    arm_id: grant.arm_id,
    cycle_id: grant.cycle_id,
    task_id: grant.task_id,
    content_hash: grant.task_hash,
    target: grant.target_handle,
    role: grant.role,
  };
  return {
    predispatch: {
      armDir,
      arm_id: armId,
      packetPath: authorization.packet_path,
      taskFilePath: grant.task_file_path,
      nowMs: preNowMs,
      request,
      // M4: expected는 CLI가 아니라 오직 grant에서만 파생된다 -- request와
      // 같은 근원(grant)에서 나오지만, 그 근원 자체가 authorization_hash로
      // 결속된 불변 봉투이므로 임의 호출자가 둘 다 조작할 수 없다.
      expected: { target: grant.target_handle, role: grant.role },
    },
    task_id: grant.task_id,
    terminalHandle: grant.target_handle,
    coordinatorHandle: grant.coordinator_handle,
    timeoutMs: grant.timeout_ms,
    handshake: { role: grant.role, harnessDir: grant.harness_dir },
  };
}

export function runLive(argv, opts = {}) {
  const deps = defaultDeps(opts.deps);

  const parsedArgv = parseLiveArgv(argv);
  if (!parsedArgv.ok) return parsedArgv;

  const bound = loadAndBindAuthorization(parsedArgv.authorizationPath, deps);
  if (!bound.ok) return bound;
  const { authorization, grant } = bound;
  const attemptId = `${grant.arm_id}--live-attempt`;

  const preflight = checkPreflightExpiry(grant, deps);
  if (preflight.failed) {
    return observedDeny(preflight.failed.reason, preflight.failed.detail, {
      outputRoot: grant.output_root,
      attemptId,
    });
  }

  const ctx = {
    armDir: authorization.arm_store_dir,
    armId: grant.arm_id,
    attemptId,
    grant,
    authorization,
    txDeps: buildTxDeps(deps),
    deps,
    boundGrantRaw: bound.grantRaw,
  };

  const state = { claimed: false, failure: null };
  const rawExecFn = createLiveExecFn({ spawnSyncFn: deps.spawnSyncFn });
  const wrappedExecFn = makeWrappedExecFn(ctx, rawExecFn, state);

  const result = runSpikeAttempt(buildAttemptInput(ctx, preflight.preNowMs), {
    execFn: wrappedExecFn,
    nowFn: deps.nowFn,
  });

  // M10: claim/start가 실제로 성공했던 시도만 종결(concludeAttempt 참고).
  if (state.claimed && state.failure === null) {
    concludeAttempt(ctx, result);
  }

  if (state.failure) {
    return observedDeny(state.failure.reason, state.failure.detail, {
      outputRoot: grant.output_root,
      attemptId,
      dumps: rawExecFn.dumps,
    });
  }
  if (!result.ok) {
    return observedDeny(
      REASON.ATTEMPT_FAILED,
      `${result.reason}${result.detail ? ` -- ${result.detail}` : ""}`,
      {
        outputRoot: grant.output_root,
        attemptId,
        dumps: rawExecFn.dumps,
        receipts: result.receipts,
      },
    );
  }

  // M7/M8 (honesty, verifyFreshHandshake 참고): 성공 선언 전 handshake 재확인.
  const freshHandshake = verifyFreshHandshake(grant);
  if (!freshHandshake.ok) {
    return observedDeny(
      REASON.HANDSHAKE_RECHECK_FAILED,
      freshHandshake.reason,
      {
        outputRoot: grant.output_root,
        attemptId,
        dumps: rawExecFn.dumps,
        receipts: result.receipts,
      },
    );
  }

  return {
    ok: true,
    reason: REASON.COMPLETE,
    receipts: result.receipts,
    dumps: rawExecFn.dumps,
    outputRoot: grant.output_root,
    armId: ctx.armId,
    attemptId: ctx.attemptId,
  };
}

// ---- M9: authorization에서 파생된 output root 아래 receipts/raw dump를 새
// 파일로만 남긴다(임의 --output-dir 없음 -- 오직 grant.output_root뿐).
export function writeLiveOutputs(result, deps = {}) {
  if (!result || !isNonEmptyString(result.outputRoot)) return;
  const writeFileFn =
    typeof deps.writeFileFn === "function" ? deps.writeFileFn : writeFileSync;
  writeNewFileOnly(
    join(result.outputRoot, `spike-live-receipts-${result.attemptId}.json`),
    JSON.stringify(result.receipts ?? [], null, 2),
    writeFileFn,
  );
  writeNewFileOnly(
    join(result.outputRoot, `spike-live-raw-dump-${result.attemptId}.json`),
    JSON.stringify(result.dumps ?? [], null, 2),
    writeFileFn,
  );
  if (!result.ok) {
    writeNewFileOnly(
      join(result.outputRoot, `spike-live-failure-${result.attemptId}.json`),
      JSON.stringify(
        { ok: false, reason: result.reason, detail: result.detail ?? null },
        null,
        2,
      ),
      writeFileFn,
    );
  }
}

// ---- 실 orca execFn 어댑터 (변경 없음 -- M1~M10과 무관, 운반 계층) ----
// check --wait --json의 실제 응답 형태(관찰, dry-run): { ok, result: { messages: [...],
// count } } -- 러너의 classifyCheckOutcome은 {outcome} 어휘(worker_done/escalation/timeout)를
// 기대하므로 여기서만 변환한다. task-create/dispatch는 원형(parsed JSON) 그대로 반환 --
// 러너의 parseRuntimeTaskId가 `result.task.id`를 직접 읽는다.
//
// honesty: message.type 위치는 dry-run 관찰(`--type worker_done`으로 전송하므로 응답도
// 대칭적으로 `message.type`일 것이라는 추정)일 뿐, 실제 라이브 1회 실행에서 확정되지
// 않았다. 이 추정이 틀렸다면 outcome은 미인식 타입으로 수렴해 timeout으로 분류되고
// (아래 fail-closed), 그 경우 완료는 오직 handshake 재확인 실패로 PAUSED에 머문다 --
// worker_done의 taskId/dispatchId 정확한 위치(M7/M8이 참조하는 "실측 전 매핑 금지"
// 대상)도 이 함수가 확정하지 않는다. 라이브 최초 실행 후 이 가정이 틀렸다면 이
// 함수만 국소 수리하면 된다(러너·predispatch는 무관).
export function mapCheckResponse(parsed) {
  if (!isPlainObject(parsed) || parsed.ok !== true) {
    return {
      ok: false,
      reason: `orca-spike-live: check response not ok -- ${JSON.stringify(parsed)}`,
    };
  }
  const messages = Array.isArray(parsed.result?.messages)
    ? parsed.result.messages
    : [];
  let outcome = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const type = isPlainObject(m) ? m.type : undefined;
    if (type === "worker_done") {
      outcome = "worker_done";
      break;
    }
    if (type === "escalation") {
      outcome = "escalation";
      break;
    }
  }
  if (!outcome) outcome = "timeout"; // 없음(빈 messages)·미인식 타입 전부 timeout으로 수렴
  return { ok: true, outcome, raw: parsed };
}

function normalizeSpawnResult(raw) {
  const isObj = isPlainObject(raw);
  return {
    stdout: isObj && typeof raw.stdout === "string" ? raw.stdout : "",
    stderr: isObj && typeof raw.stderr === "string" ? raw.stderr : "",
    status: isObj && typeof raw.status === "number" ? raw.status : null,
    spawnError:
      isObj && raw.error != null && raw.signal == null && raw.status == null
        ? errText(raw.error)
        : null,
  };
}

function parseStdoutJson(stdout, spawnError) {
  if (spawnError) return { parsed: null, parseError: null };
  try {
    return { parsed: JSON.parse(stdout), parseError: null };
  } catch (err) {
    return { parsed: null, parseError: errText(err) };
  }
}

export function createLiveExecFn({ spawnSyncFn = spawnSync } = {}) {
  const dumps = [];
  function execFn(argv) {
    const cmd = Array.isArray(argv) ? argv[1] : undefined;
    const raw = spawnSyncFn("orca", argv, { shell: false, encoding: "utf8" });
    const { stdout, stderr, status, spawnError } = normalizeSpawnResult(raw);
    const { parsed, parseError } = parseStdoutJson(stdout, spawnError);

    dumps.push({
      argv,
      cmd,
      status,
      stdout,
      stderr,
      spawnError,
      parsed,
      parseError,
    });

    if (spawnError) {
      return {
        ok: false,
        reason: `orca-spike-live: orca process never started -- ${spawnError}`,
      };
    }
    if (parseError) {
      return {
        ok: false,
        reason: `orca-spike-live: orca stdout is not valid JSON -- ${parseError}`,
      };
    }
    return cmd === "check" ? mapCheckResponse(parsed) : parsed;
  }
  execFn.dumps = dumps;
  return execFn;
}

// ---- 원형 응답 덤프 저장(사람 판독용, M9: 새 파일로만) ----
export function writeRawDump(path, dumps, deps = {}) {
  const writeFileFn =
    typeof deps.writeFileFn === "function" ? deps.writeFileFn : writeFileSync;
  writeNewFileOnly(path, JSON.stringify(dumps, null, 2), writeFileFn);
}

// ---- CLI (실 orca 호출은 여기뿐 -- --live 플래그 없으면 아무 것도 안 함) ----
export function shouldRunLive(argv) {
  return Array.isArray(argv) && argv.includes("--live");
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/orca-spike-live.mjs");
if (invokedDirectly) {
  if (!shouldRunLive(process.argv)) {
    console.error(
      "orca-spike-live: --live 플래그 없이는 실행하지 않는다(오발사 방지). 실제 발사는 review-8 승인 + arm-seal 실행 + 사람 참관 하에서만, 이 커밋엔 호출되지 않는다.",
    );
    process.exit(1);
  }
  const result = runLive(process.argv);
  writeLiveOutputs(result);
  console.log(
    JSON.stringify({
      ok: result.ok,
      reason: result.reason,
      detail: result.detail ?? null,
    }),
  );
  process.exit(result.ok ? 0 : 1);
}
