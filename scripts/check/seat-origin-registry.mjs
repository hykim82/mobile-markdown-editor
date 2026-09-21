// HYK-464 (coder-task.md §3 항목 2 "기동 주체 표식" + 항목 3 "고아 좌석
// 판별"의 재료). 좌석이 생성될 때 «누가·무엇으로 띄웠는지»를 좌석 자신이
// 아니라(title은 셸이 덮어써 못 쓴다 -- 관제실 dispatch-worker.ps1:98-101
// D15 주석) 별도 등록부(append-only JSONL)에 남긴다. 관제실
// orca-worker-seat.ps1(정본 런처)이 좌석을 실제로 실행하기 «직전»에 이
// CLI의 record 서브커맨드를 부른다 -- 손으로 `orca terminal create`를
// 친 좌석은 이 런처를 거치지 않으므로 등록부에 안 남는다(그것이 바로
// seat-orphan-detect.mjs가 쓰는 신호).
//
// 판단은 여기(저장소), 관제실은 얇은 껍데기(호출 + 종료코드 분기) --
// HYK-217/HYK-299 계열과 같은 관례. 등록부 파일의 실제 경로는 관제실이
// 정한다(admission-ledger.json과 같은 패턴 -- $PSScriptRoot 기준 상대
// 경로를 인자로 넘긴다, 이 저장소는 그 절대경로를 하드코딩하지 않는다).
//
// 정직 한계(결과 파일에 그대로 옮길 것):
// - 등록은 «런처가 정상적으로 이 CLI를 불렀을 때»만 남는다 -- 손으로
//   기동한 좌석이 이 CLI를 흉내 내 등록 레코드를 위조하는 것을 막지
//   못한다(§2 마커 위조 한계와 같은 층, HYK-462 §4 후보ⓑ의 한계와 동일).
// - 이 라운드가 만드는 것은 «쓰기»와 «조회» 두 축뿐이다 -- 배달기가 이
//   등록 여부로 배달 자체를 거부하는 배선은 범위 밖(그런 배선을 만들면
//   §7 무접촉 dispatch-gate-decision.mjs를 건드려야 한다).
// - 등록부는 이 라운드 이전에 뜬 좌석에는 소급 적용되지 않는다(콜드
//   스타트 갭) -- 이 패치 이전에 뜬 모든 좌석은 등록부에 없으므로
//   seat-orphan-detect.mjs 관점에서는 "미등록"으로 보인다. 배포 직후에는
//   이 갭이 노이즈를 만든다(결과 파일에 실측으로 남긴다).

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function buildLaunchRecord({
  paneKey,
  role,
  engine,
  model,
  effort,
  worktree,
  launchedVia,
  nowIso = new Date().toISOString(),
}) {
  if (!paneKey) throw new Error("MISSING_PANE_KEY");
  if (!role) throw new Error("MISSING_ROLE");
  return {
    paneKey,
    role,
    engine: engine ?? null,
    model: model ?? null,
    effort: effort ?? null,
    worktree: worktree ?? null,
    launchedVia: launchedVia ?? "orca-worker-seat.ps1",
    launchedAt: nowIso,
  };
}

export function appendLaunchRecord(registryPath, record) {
  const dir = dirname(registryPath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(registryPath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

// 등록부는 append-only JSONL이다 -- 같은 pane key가 여러 번 등록될 수
// 있다(재시작·재배달). 조회는 "이 pane key가 등록부에 한 번이라도
// 등장했는가"만 본다(존재 확인이지 최신값 병합이 아니다 -- 고아 판별에
// 필요한 것은 그것뿐이므로 범위를 늘리지 않는다).
//
// HYK-464 추기 수리(P2-1: 등록 실패의 조용한 통과를 막는다) -- 손상된
// 줄(append 중 강제종료로 잘린 마지막 줄 등)은 여전히 건너뛴다(fail-closed로
// 전체 조회를 중단시키지 않는다, 이 파일은 감사 로그이지 트랜잭션
// 저장소가 아니다), 그러나 이제 "몇 줄을 건너뛰었는지"를 함께 돌려준다 --
// 예전에는 그 개수가 어디에도 남지 않아 손상이 있어도 호출부가 알 길이
// 없었다(조용한 통과). readRegistry는 하위호환을 위해 records 배열만
// 돌려주는 얇은 래퍼로 남긴다.
export function readRegistryDiagnostics(registryPath) {
  if (!existsSync(registryPath)) {
    return { records: [], corruptedLineCount: 0 };
  }
  const raw = readFileSync(registryPath, "utf8");
  const records = [];
  let corruptedLineCount = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      corruptedLineCount += 1;
    }
  }
  return { records, corruptedLineCount };
}

export function readRegistry(registryPath) {
  return readRegistryDiagnostics(registryPath).records;
}

export function isPaneRegistered(registryPath, paneKey) {
  if (!paneKey) return false;
  return readRegistry(registryPath).some((r) => r.paneKey === paneKey);
}

function parseArgs(argv) {
  const out = { sub: argv[0] ?? null };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--registry-path") out.registryPath = argv[++i];
    else if (a === "--pane-key") out.paneKey = argv[++i];
    else if (a === "--role") out.role = argv[++i];
    else if (a === "--engine") out.engine = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--effort") out.effort = argv[++i];
    else if (a === "--worktree") out.worktree = argv[++i];
    else if (a === "--launched-via") out.launchedVia = argv[++i];
  }
  return out;
}

const USAGE =
  "Usage:\n" +
  "  node seat-origin-registry.mjs record --registry-path <path> --pane-key <k> --role <Role> [--engine <e>] [--model <m>] [--effort <f>] [--worktree <path>] [--launched-via <name>]\n" +
  "  node seat-origin-registry.mjs is-registered --registry-path <path> --pane-key <k>\n";

export function runSeatOriginRegistryCli(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.sub || parsed.sub === "--help") return { ok: true, help: true };
  if (!parsed.registryPath) {
    return { ok: false, reason: "MISSING_REGISTRY_PATH" };
  }
  if (parsed.sub === "record") {
    try {
      const record = buildLaunchRecord(parsed);
      appendLaunchRecord(parsed.registryPath, record);
      return { ok: true, sub: "record", record };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }
  if (parsed.sub === "is-registered") {
    if (!parsed.paneKey) return { ok: false, reason: "MISSING_PANE_KEY" };
    const registered = isPaneRegistered(parsed.registryPath, parsed.paneKey);
    return { ok: true, sub: "is-registered", registered };
  }
  return { ok: false, reason: `UNKNOWN_SUBCOMMAND:${parsed.sub}` };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/seat-origin-registry.mjs");
if (invokedDirectly) {
  const outcome = runSeatOriginRegistryCli(process.argv.slice(2));
  if (outcome.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!outcome.ok) {
    console.error(`FAILED reason=${outcome.reason}`);
    process.exit(1);
  }
  if (outcome.sub === "record") {
    console.log(
      `RECORDED paneKey=${outcome.record.paneKey} role=${outcome.record.role} engine=${outcome.record.engine}`,
    );
  } else if (outcome.sub === "is-registered") {
    console.log(outcome.registered ? "REGISTERED" : "NOT_REGISTERED");
  }
  process.exit(0);
}
