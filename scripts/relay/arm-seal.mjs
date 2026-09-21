import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { createArmStore, armStorePath } from "./arm-state.mjs";

// HYK-162 coder-8 (보고서-pm2.md §4.2/§4.4, 패킷-addendum-초안.md §F): 사람이
// signed addendum 하나를 서명한 뒤 1회 실행하는 seal/arm 세리모니. review-7이
// rejected한 결함(합성 fixture가 request/expected를 자기대조)의 근본 원인은
// "진짜 grant를 누가 만드는지 세리모니가 없었다"는 것 -- 이 파일이 그 발급자다.
//
// 이 스크립트는 개별 자격 CLI 플래그를 받지 않는다. 입력은 서명된 addendum
// 파일 경로 하나뿐이다(addendum §F.2). addendum의 구조화 필드(§A~E)만 읽고,
// 그 값을 실제 packet/task/target 파일과 대조한 뒤에만 두 개의 새 파일
// (authorization, grant 봉투)과 기존 arm-state ARMED store를 만든다.
//
// 2계층 분리(REVIEW 지시, arm-state.mjs 재설계 금지):
//   (a) authorization 파일 -- addendum 전체가 봉인한 모든 필드(packet/task/
//       target/output 등)를 canonical 보존하는 불변 봉투. 이 파일이 진실의
//       근원이다.
//   (b) grant 봉투 파일 -- authorization에서만 파생되는 canonical 부분집합.
//       M4가 요구하는 "task hash·target fingerprint·role·authorization hash"를
//       담는다. 라이브 드라이버가 읽는 것은 이 grant 봉투 + authorization뿐.
//   (c) 기존 arm-state ARMED store -- createArmStore()가 만드는, 필드셋이
//       고정된 예산/claim 전용 store. grant 봉투의 호환 서브셋으로만 생성한다.
//       arm-state.mjs 자체는 손대지 않는다.

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

export function sha256(text) {
  if (typeof text !== "string")
    throw new TypeError("arm-seal: sha256 requires a string");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fail(reason, extra = {}) {
  return { ok: false, reason: `arm-seal: ${reason}`, ...extra };
}

// ---- addendum 파서: ```text ... ``` 펜스 블록 안의 `key: value` 줄만 신뢰한다.
// 펜스 밖의 설명 산문(예: 서두의 "아래 `☐`가 모두...")은 절대 검사 대상이
// 아니다 -- 그 산문 자체가 안내 목적으로 ☐ 문자를 포함하므로, 펜스 밖까지
// 스캔하면 정상적으로 채워진 addendum도 항상 거부된다(오탐).
const FENCED_BLOCK_RE = /```text\r?\n([\s\S]*?)```/g;
const KV_LINE_RE = /^([A-Za-z0-9_가-힣]+):\s?(.*)$/;
const SIGNED_RE = /^OK\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/;

export function extractFencedBlocks(content) {
  const blocks = [];
  let m;
  FENCED_BLOCK_RE.lastIndex = 0;
  while ((m = FENCED_BLOCK_RE.exec(content)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

function stripAnnotation(value) {
  // "☐ (반드시 SPIKE-LIVE-1)" 같은 안내용 괄호 주석을 값 판정에서 제거한다.
  // ☐ 자체는 아래 별도 검사가 잡는다 -- 여기는 채워진 값의 trailing 안내문만 벗긴다.
  return value.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

export function parseAddendum(content) {
  if (typeof content !== "string" || content.length === 0) {
    return fail("addendum content is empty/not a string");
  }
  const blocks = extractFencedBlocks(content);
  if (blocks.length === 0) {
    return fail(
      "addendum has no ```text fenced blocks -- cannot locate structured fields",
    );
  }
  const joined = blocks.join("\n");
  if (joined.includes("☐")) {
    return fail(
      "addendum still has unfilled ☐ placeholder(s) inside its structured fields -- issuance refused",
    );
  }
  const fields = {};
  for (const block of blocks) {
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const kv = line.match(KV_LINE_RE);
      if (!kv) continue;
      fields[kv[1]] = kv[2].trim();
    }
  }
  return { ok: true, fields, raw: content };
}

// addendum 자체의 서명(`승인: OK <이름> YYYY-MM-DD HH:MM`) -- packet-gate와
// 동일 패턴 재사용(정확히 재현, packet-gate.mjs import는 하지 않는다 -- 그
// 모듈은 파일 경로를 받는 API라 in-memory 파싱과는 계약이 다르다).
function checkAddendumSigned(fields) {
  const value = fields["승인"];
  if (!isNonEmptyString(value) || value === "☐") {
    return fail("addendum '승인' line is not signed (☐ or empty)");
  }
  const signed = value.match(SIGNED_RE);
  if (!signed) {
    return fail(
      `addendum '승인' line is malformed -- need '승인: OK <이름> YYYY-MM-DD HH:MM', got '${value}'`,
    );
  }
  return {
    ok: true,
    signerName: signed[1],
    signedDate: signed[2],
    signedTime: signed[3],
  };
}

// addendum_id에서 "HYK<번호>" 패턴을 뽑아 사람 확인 문구를 파생한다(하드코딩
// 문자열 대신 addendum 자체에서 파생 -- 다른 addendum_id로 재사용 시도해도
// 문구가 자동으로 달라진다).
export function deriveConfirmationPhrase(fields) {
  const addendumId = fields.addendum_id;
  const taskId = fields.allowed_task_id;
  if (!isNonEmptyString(addendumId) || !isNonEmptyString(taskId)) return null;
  const m = addendumId.match(/HYK-?(\d+)/);
  if (!m) return null;
  return `ARM HYK-${m[1]} ${taskId}`;
}

function requireFields(fields, names) {
  const missing = [];
  for (const n of names) {
    if (!isNonEmptyString(fields[n])) missing.push(n);
  }
  return missing;
}

const REQUIRED_FIELD_NAMES = [
  "addendum_id",
  "packet_id",
  "packet_path",
  "packet_sha256",
  "packet_human_approval_ref",
  "arm_id",
  "cycle_id",
  "allowed_task_id",
  "allowed_lane",
  "max_starts_total",
  "max_starts_per_lane",
  "max_rejections",
  "publish_allowed",
  "question_policy",
  "error_policy",
  "retry_allowed",
  "task_file_resolved_path",
  "task_id_from_header",
  "task_sha256",
  "task_dropped_at",
  "result_file_resolved_path",
  "target_terminal_handle",
  "target_snapshot_captured_at",
  "target_snapshot_sha256",
  "target_repo_or_cwd",
  "target_worktree_identity",
  "target_role_evidence",
  "target_session_identity",
  "coordinator_terminal_handle",
  "coordinator_snapshot_sha256",
  "receipt_output_root_resolved_path",
  "receipt_write_mode",
  "timeout_ms",
];

function normalizeDeps(deps) {
  const d = isPlainObject(deps) ? deps : {};
  return {
    readFileFn:
      typeof d.readFileFn === "function"
        ? d.readFileFn
        : (p) => readFileSync(p, "utf8"),
    writeFileFn:
      typeof d.writeFileFn === "function" ? d.writeFileFn : writeFileSync,
    existsFn: typeof d.existsFn === "function" ? d.existsFn : existsSync,
    nowFn:
      typeof d.nowFn === "function" ? d.nowFn : () => new Date().toISOString(),
    readlineFn:
      typeof d.readlineFn === "function"
        ? d.readlineFn
        : async () => {
            // 실제 CLI 기본값: stdin 전체를 읽어 첫 줄을 사람 입력으로 취급한다
            // (이 저장소에 readline-sync 계열 의존성이 없다 -- 다른 CLI들의
            // `readFileSync(0, "utf8")` 전례와 동형).
            try {
              return readFileSync(0, "utf8").split(/\r?\n/)[0] ?? "";
            } catch {
              return "";
            }
          },
  };
}

function exclusiveWrite(path, content, writeFileFn) {
  writeFileFn(path, content, { flag: "wx" });
}

// ---- §A: 상위 packet과 대조 -- packet id/전체 SHA-256/승인 줄 exact 일치 ----
function validatePacketBinding(fields, deps) {
  let packetContent;
  try {
    packetContent = deps.readFileFn(fields.packet_path);
  } catch (err) {
    return fail(
      `cannot read packet at addendum's packet_path '${fields.packet_path}' (${errText(err)})`,
    );
  }
  const actualPacketHash = sha256(packetContent).toUpperCase();
  const claimedPacketHash = fields.packet_sha256.toUpperCase();
  if (actualPacketHash !== claimedPacketHash) {
    return fail(
      `packet SHA-256 mismatch -- addendum claims ${claimedPacketHash}, actual file is ${actualPacketHash} (different signed packet or tampered content)`,
    );
  }
  const approvalLine = packetContent.match(/^승인:\s*(.*)$/m);
  const approvalValue = approvalLine ? approvalLine[1].trim() : null;
  if (!isNonEmptyString(approvalValue) || approvalValue === "☐") {
    return fail("packet itself is not signed (승인: ☐ or missing)");
  }
  if (!approvalValue.includes(fields.packet_human_approval_ref)) {
    return fail(
      `packet approval line '${approvalValue}' does not match addendum's packet_human_approval_ref '${fields.packet_human_approval_ref}'`,
    );
  }
  return { ok: true, claimedPacketHash };
}

// ---- §C: 실제 task 파일과 대조 ----
function validateTaskBinding(fields, deps) {
  let taskContent;
  try {
    taskContent = deps.readFileFn(fields.task_file_resolved_path);
  } catch (err) {
    return fail(
      `cannot read task file '${fields.task_file_resolved_path}' (${errText(err)})`,
    );
  }
  const actualTaskHash = sha256(taskContent);
  if (actualTaskHash !== fields.task_sha256) {
    return fail(
      `task file SHA-256 mismatch -- addendum claims ${fields.task_sha256}, actual is ${actualTaskHash}`,
    );
  }
  const taskIdInHeader = stripAnnotation(fields.task_id_from_header);
  if (taskIdInHeader !== fields.allowed_task_id) {
    return fail(
      `task_id_from_header '${taskIdInHeader}' does not equal allowed_task_id '${fields.allowed_task_id}'`,
    );
  }
  const taskIdMatch = taskContent.match(/^task_id:\s*(\S+)/im);
  if (!taskIdMatch || taskIdMatch[1] !== fields.allowed_task_id) {
    return fail(
      `task file's own task_id header does not equal allowed_task_id '${fields.allowed_task_id}'`,
    );
  }
  return { ok: true };
}

// ---- §D: target/coordinator snapshot 존재 확인(값 자체는 사람이 이미 관측해
// addendum에 적은 canonical subset -- 여기서는 "미제공"이 아닌 한 각 필드가
// 실측값으로 채워졌는지만 재확인한다. Orca가 세션 identity를 제공하지 않으면
// addendum §D 규칙대로 "미제공" 문자열 자체가 유효한 값이다) ----
function validateTargetFields(fields) {
  for (const f of [
    "target_terminal_handle",
    "target_snapshot_sha256",
    "target_repo_or_cwd",
    "target_worktree_identity",
    "target_role_evidence",
  ]) {
    if (fields[f] === "판단 불가" || fields[f] === "미제공") {
      return fail(
        `target field '${f}' is '${fields[f]}' -- role/repo/worktree undetermined, issuance refused (addendum §D)`,
      );
    }
  }
  return { ok: true };
}

// ---- §E: 출력 root/write mode, §B: 예산/정책 고정값 검사 ----
function validateOutputAndBudget(fields) {
  if (fields.receipt_write_mode !== "create-new-only") {
    return fail(
      `receipt_write_mode must be exactly 'create-new-only', got '${fields.receipt_write_mode}'`,
    );
  }
  const timeoutMs = Number(fields.timeout_ms);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return fail(
      `timeout_ms is not a positive safe integer: '${fields.timeout_ms}'`,
    );
  }
  const maxStartsTotal = Number(fields.max_starts_total);
  const maxStartsPerLane = Number(fields.max_starts_per_lane);
  const maxRejections = Number(fields.max_rejections);
  if (
    !Number.isSafeInteger(maxStartsTotal) ||
    !Number.isSafeInteger(maxStartsPerLane) ||
    !Number.isSafeInteger(maxRejections)
  ) {
    return fail(
      "max_starts_total/max_starts_per_lane/max_rejections must be safe integers",
    );
  }
  if (fields.publish_allowed !== "false") {
    return fail("publish_allowed must be fixed 'false'");
  }
  if (fields.question_policy !== "pause" || fields.error_policy !== "pause") {
    return fail("question_policy/error_policy must both be 'pause'");
  }
  if (fields.retry_allowed !== "false") {
    return fail("retry_allowed must be fixed 'false'");
  }
  return {
    ok: true,
    timeoutMs,
    maxStartsTotal,
    maxStartsPerLane,
    maxRejections,
  };
}

// ---- issued_at/expires_at: addendum 승인 시각에서 결정적으로 파생 ----
function deriveTiming(signedCheck, deps) {
  const issuedAtIso = kstApprovalToIso(
    signedCheck.signedDate,
    signedCheck.signedTime,
  );
  if (!issuedAtIso) {
    return fail(
      `could not parse addendum approval timestamp '${signedCheck.signedDate} ${signedCheck.signedTime}'`,
    );
  }
  const expiresAtIso = new Date(
    Date.parse(issuedAtIso) + 30 * 60 * 1000,
  ).toISOString();
  const nowIso = deps.nowFn();
  const nowMs = Date.parse(nowIso);
  if (!Number.isSafeInteger(nowMs) || nowMs > Date.parse(expiresAtIso)) {
    return fail(
      `addendum grant would already be expired at seal time (expires_at=${expiresAtIso}, now=${nowIso})`,
    );
  }
  return { ok: true, issuedAtIso, expiresAtIso, nowIso };
}

// ---- 기존 파일/기존 arm_id 존재 검사(부분성공 금지, wx가 최종 방어선이지만
// 사전에도 명시적으로 거부해 사람이 이해 가능한 이유를 준다) ----
function checkNoExistingFiles(paths, deps) {
  for (const p of paths) {
    if (deps.existsFn(p)) {
      return fail(
        `refusing to overwrite existing file '${p}' -- same arm_id already sealed/armed`,
      );
    }
  }
  return { ok: true };
}

// ---- 사람 확인 문구 ----
async function confirmHuman(fields, addendumContent, deps) {
  const expectedPhrase = deriveConfirmationPhrase(fields);
  if (!expectedPhrase) {
    return fail(
      "could not derive human confirmation phrase from addendum_id/allowed_task_id",
    );
  }
  const summary = buildSummary(fields, addendumContent, expectedPhrase);
  const typed = await deps.readlineFn(summary);
  if (typed !== expectedPhrase) {
    return fail(
      `human confirmation mismatch -- expected exact '${expectedPhrase}', got ${JSON.stringify(typed)} (no partial success)`,
    );
  }
  return { ok: true, expectedPhrase };
}

function buildGrantObject(fields, ctx) {
  return {
    schema_version: 1,
    addendum_id: fields.addendum_id,
    addendum_sha256: ctx.addendumHash,
    packet_id: fields.packet_id,
    packet_path: fields.packet_path,
    packet_sha256: ctx.claimedPacketHash,
    human_approval_ref: fields.packet_human_approval_ref,
    arm_id: fields.arm_id,
    cycle_id: fields.cycle_id,
    task_id: fields.allowed_task_id,
    task_file_path: fields.task_file_resolved_path,
    task_hash: fields.task_sha256,
    target_handle: fields.target_terminal_handle,
    target_fingerprint: ctx.targetFingerprint,
    role: fields.allowed_lane,
    coordinator_handle: fields.coordinator_terminal_handle,
    harness_dir: ctx.harnessDir,
    output_root: fields.receipt_output_root_resolved_path,
    timeout_ms: ctx.timeoutMs,
    issued_at: ctx.issuedAtIso,
    expires_at: ctx.expiresAtIso,
    retry_allowed: false,
  };
}

function buildAuthorizationObject(fields, ctx) {
  return {
    schema_version: 1,
    addendum_id: fields.addendum_id,
    addendum_path: ctx.addendumPath,
    addendum_sha256: ctx.addendumHash,
    packet_id: fields.packet_id,
    packet_path: fields.packet_path,
    packet_sha256: ctx.claimedPacketHash,
    packet_human_approval_ref: fields.packet_human_approval_ref,
    arm_id: fields.arm_id,
    cycle_id: fields.cycle_id,
    allowed_task_id: fields.allowed_task_id,
    allowed_lane: fields.allowed_lane,
    max_starts_total: ctx.maxStartsTotal,
    max_starts_per_lane: ctx.maxStartsPerLane,
    max_rejections: ctx.maxRejections,
    publish_allowed: false,
    question_policy: "pause",
    error_policy: "pause",
    retry_allowed: false,
    task_file_resolved_path: fields.task_file_resolved_path,
    task_id_from_header: fields.allowed_task_id,
    task_sha256: fields.task_sha256,
    task_dropped_at: fields.task_dropped_at,
    result_file_resolved_path: fields.result_file_resolved_path,
    target_terminal_handle: fields.target_terminal_handle,
    target_snapshot_captured_at: fields.target_snapshot_captured_at,
    target_snapshot_sha256: fields.target_snapshot_sha256,
    target_repo_or_cwd: fields.target_repo_or_cwd,
    target_worktree_identity: fields.target_worktree_identity,
    target_role_evidence: fields.target_role_evidence,
    target_session_identity: fields.target_session_identity,
    target_fingerprint: ctx.targetFingerprint,
    coordinator_terminal_handle: fields.coordinator_terminal_handle,
    coordinator_snapshot_sha256: fields.coordinator_snapshot_sha256,
    receipt_output_root_resolved_path: fields.receipt_output_root_resolved_path,
    receipt_write_mode: "create-new-only",
    timeout_ms: ctx.timeoutMs,
    issued_at: ctx.issuedAtIso,
    expires_at: ctx.expiresAtIso,
    sealed_at: ctx.nowIso,
    sealed_confirmation: ctx.expectedPhrase,
    harness_dir: ctx.harnessDir,
    arm_store_dir: ctx.armStoreDir,
    grant_path: ctx.grantPath,
    grant_sha256: ctx.grantHash,
  };
}

// grant는 addendum 전체 해시에 결속된다(addendum이 이미 확정된 값이므로 순환이
// 없다). authorization은 grant보다 **나중에** 쓰이고, 그 grant 파일의 정확한
// SHA-256(grant_sha256)을 담는다 -- authorization(불변, 유일한 CLI 자격 입력)이
// "이 grant 파일이 sealing 시점과 바이트 단위로 동일한가"를 증명하는 최종
// 서명자 역할을 한다. sealing 이후 누군가 grant 파일만 수정해도(예:
// target_handle 한 값만 바꿔치기) authorization.grant_sha256과의 재대조에서
// 즉시 잡힌다(M4).
function writeGrantEnvelope(grantPath, grant, deps) {
  const grantContent = JSON.stringify(grant, null, 2) + "\n";
  try {
    exclusiveWrite(grantPath, grantContent, deps.writeFileFn);
  } catch (err) {
    return fail(
      `could not create grant envelope '${grantPath}' (${errText(err)}) -- no partial success`,
    );
  }
  let grantReread;
  try {
    grantReread = deps.readFileFn(grantPath);
  } catch (err) {
    return fail(
      `could not re-read grant envelope after write (${errText(err)})`,
    );
  }
  const grantHash = sha256(grantReread);
  if (grantHash !== sha256(grantContent)) {
    return fail(
      "grant envelope re-read hash mismatch after write -- refusing to seal authorization",
    );
  }
  return { ok: true, grantHash };
}

function writeAuthorizationEnvelope(authPath, authorization, deps) {
  const authContent = JSON.stringify(authorization, null, 2) + "\n";
  try {
    exclusiveWrite(authPath, authContent, deps.writeFileFn);
  } catch (err) {
    return fail(
      `could not create authorization file '${authPath}' (${errText(err)}) -- grant envelope already sealed; do not retry with the same arm_id`,
    );
  }
  // 재독 대조(설계 §F.5): 방금 쓴 내용을 다시 읽어 해시가 일치할 때만 계속.
  let reread;
  try {
    reread = deps.readFileFn(authPath);
  } catch (err) {
    return fail(
      `could not re-read authorization file after write (${errText(err)})`,
    );
  }
  if (sha256(reread) !== sha256(authContent)) {
    return fail(
      "authorization re-read hash mismatch after write -- refusing to arm the store",
    );
  }
  return { ok: true, authorizationHash: sha256(reread) };
}

function writeArmedStore(storePath, authorization, deps) {
  const created = createArmStore(
    {
      arm_id: authorization.arm_id,
      cycle_id: authorization.cycle_id,
      human_approval_ref: authorization.packet_human_approval_ref,
      issued_at: authorization.issued_at,
      expires_at: authorization.expires_at,
      allowed_lanes: [authorization.allowed_lane],
      allowed_task_ids: [authorization.allowed_task_id],
      max_starts_total: authorization.max_starts_total,
      max_starts_per_lane: authorization.max_starts_per_lane,
      max_rejections: authorization.max_rejections,
      publish_allowed: false,
      question_policy: "pause",
      error_policy: "pause",
    },
    { at: authorization.issued_at },
  );
  if (!created.ok) {
    return fail(
      `createArmStore refused compatible-subset grant -- ${created.reason}`,
    );
  }
  try {
    exclusiveWrite(
      storePath,
      JSON.stringify(created.store, null, 2) + "\n",
      deps.writeFileFn,
    );
  } catch (err) {
    return fail(
      `could not create ARMED store '${storePath}' (${errText(err)})`,
    );
  }
  return { ok: true };
}

// ---- 메인 세리모니(오케스트레이션만 -- 각 검증/쓰기 단계는 위 헬퍼 소유) ----
// opts: {
//   addendumPath, outDir (authorization/grant/arm-store를 쓸 디렉토리)
//   deps: { readFileFn, writeFileFn, existsFn, nowFn, readlineFn }
// }
// §A~§E 전 필드 검증(순수, I/O는 packet/task 파일 읽기뿐). 실패 시 fail(...),
// 성공 시 각 검증 단계의 파생값을 한데 모아 반환한다.
function validateAddendumFields(fields, addendumContent, deps) {
  const missing = requireFields(fields, REQUIRED_FIELD_NAMES);
  if (missing.length > 0) {
    return fail(`addendum is missing required field(s): ${missing.join(", ")}`);
  }

  const signedCheck = checkAddendumSigned(fields);
  if (!signedCheck.ok) return signedCheck;

  const packetCheck = validatePacketBinding(fields, deps);
  if (!packetCheck.ok) return packetCheck;

  const taskCheck = validateTaskBinding(fields, deps);
  if (!taskCheck.ok) return taskCheck;

  const targetCheck = validateTargetFields(fields);
  if (!targetCheck.ok) return targetCheck;

  const budgetCheck = validateOutputAndBudget(fields);
  if (!budgetCheck.ok) return budgetCheck;

  const timing = deriveTiming(signedCheck, deps);
  if (!timing.ok) return timing;

  return { ok: true, packetCheck, budgetCheck, timing };
}

// 사람 확인 이후: grant 봉투 -> authorization -> ARMED store 순으로 실제
// 파일을 만든다(오케스트레이션만 -- 각 write 단계는 위 헬퍼 소유).
function sealFiles(fields, paths, ctx, deps) {
  const grant = buildGrantObject(fields, ctx);
  const grantWrite = writeGrantEnvelope(paths.grantPath, grant, deps);
  if (!grantWrite.ok) return grantWrite;

  const authorization = buildAuthorizationObject(fields, {
    ...ctx,
    grantHash: grantWrite.grantHash,
  });
  const authWrite = writeAuthorizationEnvelope(
    paths.authPath,
    authorization,
    deps,
  );
  if (!authWrite.ok) return authWrite;

  const armWrite = writeArmedStore(paths.storePath, authorization, deps);
  if (!armWrite.ok) return armWrite;

  return {
    ok: true,
    authorizationPath: paths.authPath,
    grantPath: paths.grantPath,
    armStorePath: paths.storePath,
    authorizationHash: authWrite.authorizationHash,
  };
}

export async function sealArm(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const deps = normalizeDeps(o.deps);
  const { addendumPath, outDir } = o;

  if (!isNonEmptyString(addendumPath)) return fail("addendumPath is required");
  if (!isNonEmptyString(outDir)) return fail("outDir is required");

  let addendumContent;
  try {
    addendumContent = deps.readFileFn(addendumPath);
  } catch (err) {
    return fail(`cannot read addendum '${addendumPath}' (${errText(err)})`);
  }

  const parsed = parseAddendum(addendumContent);
  if (!parsed.ok) return parsed;
  const { fields } = parsed;

  const validated = validateAddendumFields(fields, addendumContent, deps);
  if (!validated.ok) return validated;

  const paths = {
    authPath: join(outDir, `authorization-${fields.arm_id}.json`),
    grantPath: join(outDir, `grant-${fields.arm_id}.json`),
    storePath: armStorePath(outDir, fields.arm_id),
  };
  const existingCheck = checkNoExistingFiles(Object.values(paths), deps);
  if (!existingCheck.ok) return existingCheck;

  const confirmed = await confirmHuman(fields, addendumContent, deps);
  if (!confirmed.ok) return confirmed;

  const targetFingerprint = sha256(
    [
      fields.target_terminal_handle,
      fields.target_snapshot_sha256,
      fields.target_repo_or_cwd,
      fields.target_worktree_identity,
    ].join("|"),
  );
  const ctx = {
    addendumPath,
    addendumHash: sha256(addendumContent),
    claimedPacketHash: validated.packetCheck.claimedPacketHash,
    harnessDir: deriveHarnessDir(fields.task_file_resolved_path),
    targetFingerprint,
    armStoreDir: outDir,
    grantPath: paths.grantPath,
    ...validated.budgetCheck,
    ...validated.timing,
    expectedPhrase: confirmed.expectedPhrase,
  };

  return sealFiles(fields, paths, ctx, deps);
}

function kstApprovalToIso(dateStr, timeStr) {
  const d = new Date(`${dateStr}T${timeStr}:00+09:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function deriveHarnessDir(taskFileResolvedPath) {
  // 실 CODER relay 정본 규약: `<repo>/.harness/<role>-task.md`. task 파일의
  // 부모 디렉토리가 곧 harnessDir이다(추측 금지 -- 경로 구조 자체에서 파생).
  return dirname(taskFileResolvedPath);
}

function buildSummary(fields, addendumContent, expectedPhrase) {
  return [
    `packet_id: ${fields.packet_id}`,
    `packet_sha256: ${fields.packet_sha256}`,
    `arm_id: ${fields.arm_id} / cycle_id: ${fields.cycle_id} / task_id: ${fields.allowed_task_id}`,
    `task_sha256: ${fields.task_sha256}`,
    `target: ${fields.target_terminal_handle}`,
    `addendum_sha256: ${sha256(addendumContent)}`,
    `사람이 정확히 다음 문구를 입력해야 진행합니다: ${expectedPhrase}`,
  ].join("\n");
}

// ---- CLI: `node arm-seal.mjs <signed-addendum-path> [outDir]` ----
const invokedDirectly =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/relay/arm-seal.mjs");
if (invokedDirectly) {
  const addendumPath = process.argv[2];
  const outDir = process.argv[3] ?? dirname(addendumPath ?? ".");
  if (!addendumPath) {
    console.error("usage: node arm-seal.mjs <signed-addendum-path> [outDir]");
    process.exit(1);
  }
  const result = await sealArm({ addendumPath, outDir });
  if (result.ok) {
    console.log(JSON.stringify(result));
    process.exit(0);
  }
  console.error(result.reason);
  process.exit(1);
}
