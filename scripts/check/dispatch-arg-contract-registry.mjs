// HYK-319-argcheck-1 (coder-task.md) -- 배달기(관제실 dispatch-worker.ps1)가
// 저장소 CLI 5개를 부를 때 반드시 넘겨야 하는 인자를 기계가 읽을 수 있는
// 형태로 선언한 곳. 이 파일은 데이터만 담는다(판정 로직은
// dispatch-arg-contract-core.mjs). 각 CLI 정의는 아래 필드를 쓴다:
//
// - id: 사람이 읽는 이름(결과 출력에 그대로 쓰인다).
// - scriptBasename: 배달기가 Join-Path로 조립하는 상대경로 조각(코드 실측,
//   docs/control-room-patches/HYK-319-*.md와 결과 파일에 그대로 인용).
// - requiredArgs: [{ flags: ["--x"] | ["--a","--b"](anyOf), hard, note }]
//   hard=true  -- §2-2 결속 시험이 "빼면 실제로 죽는다"를 확인한 항목.
//   hard=false -- 빼도 그 CLI 프로세스 자신은 안 죽는다(§2-2 "헛선언"
//     후보). 그런데도 선언을 유지하는 이유는 각 항목의 note에 적는다 --
//     이 축 전체의 존재 이유(HYK-256/315)가 바로 "안 죽지만 사고로 이어지는
//     누락"이므로, hard=false라고 선언에서 빼면 이 검사기의 존재 이유
//     자체가 없어진다(비타협 §2-2 "선언을 조용히 지우지 마라").
// - recognitionFlags: 호출 지점을 찾는 데 쓰는 신호(선택 인자 포함, 값의
//   옳음과 무관 -- 존재만 본다). requiredArgs보다 넓은 집합일 수 있다.
// - minRecognitionScore: 그 창을 "이 CLI의 호출 지점"으로 인정하는 최소
//   일치 개수(과소 매치로 엉뚱한 창을 집지 않게 하는 안전판).
// - requiresPositionalArg: 스크립트 경로 바로 다음에 `--`로 시작하지 않는
//   실제 인자 토큰(예: task 파일 경로)이 있어야 하면 true.
// - requiresSubcommand: 스크립트 경로 바로 다음에 이 문자열 리터럴 토큰이
//   있어야 하면 그 값(예: "admit").
export const CLI_CONTRACTS = Object.freeze([
  Object.freeze({
    id: "dispatch-gate-decision",
    scriptBasename: "scripts/check/dispatch-gate-decision.mjs",
    requiresPositionalArg: true,
    requiredArgs: Object.freeze([
      Object.freeze({
        flags: Object.freeze(["--expect-repo-root"]),
        hard: false,
        note:
          "CLI 자신은 --expect-repo-root 없이도 돈다(레포 결속 대조를 " +
          "건너뛸 뿐, usage 오류로 죽지 않음 -- resolveLedgerPath 실측). " +
          "그런데도 선언 유지: 이게 빠지면 --ledger가 다른 저장소를 " +
          "가리켜도 조용히 통과한다(HYK-220 2R이 막은 바로 그 구멍) -- " +
          "이 검사기의 목적은 «죽는지»가 아니라 «배달기가 실수로 빠뜨렸는지» " +
          "잡는 것이므로 소프트 항목도 선언에 남긴다.",
      }),
      Object.freeze({
        flags: Object.freeze(["--dispatch-receipt-path"]),
        hard: false,
        note:
          "HYK-256 실해 그 자체 -- 빠지면 env DISPATCH_RECEIPT_PATH로 " +
          "폴백하고, 그마저 없으면 소비 확인 축이 dispatchId를 못 찾아 " +
          "«판정 불가»로 REJECT 쪽에 힘을 싣는다(대조 실행 케이스 참고, " +
          "항상 죽는다고 단정할 수 없음 -- 그 이후에도 다른 사유가 이미 " +
          "REJECT일 수 있어 원인이 가려질 수 있다). 죽는지 여부와 무관하게 " +
          "이 인자가 바로 이 검사기를 만든 이유이므로 선언 유지.",
      }),
      // HYK-319-argcheck-2 (검토 1R P1 반려 수리): 1R 선언에서 빠졌던
      // 항목 -- 검토가 코드를 직접 인용해 지목했다. 코드 실측
      // (dispatch-gate-decision.mjs 218-239행 파싱 · 1226-1231행
      // resolveAdmissionLedgerPathForAbort · 1289-1299행
      // verifyAbortRecordRecoveryMarker): 이 인자(또는 env
      // ADMISSION_LEDGER_PATH)가 없으면 admission 원장을 읽을 경로
      // 자체가 없어 verifyAbortRecordRecoveryMarker가 **항상 false**로
      // 닫힌다 -- 즉 이름표 없이 죽은 라운드(abort record)의 정당한
      // 회수 표식이 실재해도 "회수 표식 없음"과 똑같이 REJECT된다.
      // Linear HYK-315(Todo·미수리)가 이미 등재한 바로 그 결함이고,
      // HYK-319 정본이 이 검사기를 "HYK-256·315 병의 일반해"라고
      // 못박았으므로 315를 못 잡으면 정본 요구를 충족하지 못한다.
      Object.freeze({
        flags: Object.freeze(["--admission-ledger-path"]),
        hard: false,
        note:
          "--dispatch-receipt-path와 같은 arg-with-env-fallback 모양 " +
          "(env ADMISSION_LEDGER_PATH) -- 둘 다 없어도 이 CLI 프로세스 " +
          "자체는 usage로 죽지 않는다(회수 표식 검증만 조용히 항상 " +
          "false로 닫힘, 값이 있는 다른 REJECT 사유 뒤에 원인이 가려질 " +
          "수도 있음). 없으면 회수 표식 검증이 항상 false로 닫혀 정당한 " +
          "abort record도 통과 못 한다(HYK-315) -- 죽는지 여부와 무관하게 " +
          "이 검사기의 존재 이유(안전 경로 사고 방지)이므로 선언 유지. " +
          "★환경변수 대체 경로의 한계: 이 검사기는 «호출 창 안의 플래그 " +
          "토큰»만 본다(코어 계약, 값이 아니라 이름만 대조) -- " +
          "`$env:ADMISSION_LEDGER_PATH = ...` 같은 전역 환경변수 설정은 " +
          "호출 창 밖의 상태라 지금 선언 형식으로 표현할 수 없다(anyOf는 " +
          "같은 창 안의 대체 «플래그»만 표현 가능, 전역 env 대입 문장을 " +
          "인식하는 축이 코어에 없음). 지금 실물 배달기는 이 env var를 " +
          "아예 설정하지 않으므로(검토 실측) 이 한계가 당장 오탐/누락을 " +
          "만들지는 않지만, 미래에 배달기가 --admission-ledger-path 대신 " +
          "이 env var만 설정하는 식으로 고쳐지면 이 검사기는 그 정당한 " +
          "충족을 알아보지 못하고 계속 MISSING_ARGS를 낼 것이다(과탐 쪽 " +
          "한계 -- 배달 자체를 막지는 않는다, 결선 전이므로).",
      }),
    ]),
  }),
  Object.freeze({
    id: "admission-cli-admit",
    scriptBasename: "scripts/supervisor/admission-cli.mjs",
    requiresSubcommand: "admit",
    requiredArgs: Object.freeze([
      Object.freeze({ flags: Object.freeze(["--ledger"]), hard: true }),
      Object.freeze({ flags: Object.freeze(["--lock"]), hard: true }),
      Object.freeze({
        flags: Object.freeze(["--reservation-id"]),
        hard: true,
      }),
      Object.freeze({
        flags: Object.freeze(["--cap-path", "--cap"]),
        hard: true,
        note:
          "admission-cli.mjs 실측: (--cap <n> | --cap-path <file>) 중 " +
          "하나만 있으면 통과(anyOf) -- 관제실은 항상 --cap-path를 쓴다.",
      }),
      Object.freeze({
        flags: Object.freeze(["--role"]),
        hard: false,
        note:
          "admission-cli.mjs cmdAdmit 실측: --role은 admitTransition에 " +
          "그대로 흘러갈 뿐 존재 확인이 없다(usage 오류로 죽지 않음). " +
          "관제실은 항상 넘기므로(원장 seat 레코드의 role 필드가 비면 " +
          "이후 축이 못 씀) 선언 유지.",
      }),
      Object.freeze({
        flags: Object.freeze(["--seat-key"]),
        hard: false,
        note:
          "--role과 동일 사유(admitTransition으로 그대로 흘러갈 뿐, " +
          "존재 확인 없음). 관제실은 항상 넘기며, 빠지면 sweep의 ground " +
          "truth(seat_key)가 비어 HYK-224-2R이 막은 «핸들 회전» 구멍이 " +
          "되돌아온다 -- 선언 유지.",
      }),
    ]),
  }),
  Object.freeze({
    id: "dispatch-receipt-cli",
    scriptBasename: "scripts/relay/dispatch-receipt-cli.mjs",
    requiredArgs: Object.freeze([
      Object.freeze({ flags: Object.freeze(["--role"]), hard: true }),
      Object.freeze({ flags: Object.freeze(["--task-label"]), hard: true }),
      Object.freeze({
        flags: Object.freeze(["--receipt-path"]),
        hard: true,
        note:
          "--receipt-path 자체가 없어도 env DISPATCH_RECEIPT_PATH가 있으면 " +
          "안 죽는다(parseDispatchReceiptArgs 실측, env 폴백). 관제실 실물 " +
          "호출은 항상 --receipt-path를 직접 넘긴다(§2-5 실측) -- 이 검사기는 " +
          "플래그 존재만 보므로 hard=true로 둔다(값이 아니라 «배달기 호출문에 " +
          "그 플래그가 있는가»가 계약이며, 이 CLI는 실제로 이 플래그가 없으면 " +
          "옵션 그 자체(env 대체)가 아닌 한 usage 오류로 죽는다).",
      }),
    ]),
  }),
  Object.freeze({
    id: "dispatch-worker-seat-proof-gate",
    scriptBasename: "scripts/relay/dispatch-worker-seat-proof-gate.mjs",
    requiredArgs: Object.freeze(
      [
        "--dispatch-show",
        "--terminal-show",
        "--harness-task-id",
        "--runtime-task-id",
        "--dispatch-id",
        "--worktree-id",
        "--worktree-path",
      ].map((flag) =>
        Object.freeze({ flags: Object.freeze([flag]), hard: true }),
      ),
    ),
  }),
  Object.freeze({
    id: "dispatch-start-confirm-cli",
    scriptBasename: "scripts/supervisor/dispatch-start-confirm-cli.mjs",
    requiredArgs: Object.freeze([
      Object.freeze({ flags: Object.freeze(["--repo-root"]), hard: true }),
      Object.freeze({
        flags: Object.freeze(["--dispatched-at-ms"]),
        hard: true,
      }),
      Object.freeze({ flags: Object.freeze(["--notify-dir"]), hard: true }),
    ]),
    // §2-1 실측 발견: coder-task.md §2-1 표는 --claude-home/--baseline-bytes/
    // --watch-dir/--task-id까지 "지금 넘기는 인자"로 적었지만, 코드 실측
    // (dispatch-start-confirm-cli.mjs 305-337행)과 관제실 실물(dispatch-
    // worker.ps1 543-554행, Claude 분기)은 다르다 -- --watch-dir은 실물
    // Claude 호출에 아예 없고(그 CLI는 accepted-but-unused로만 예약),
    // --claude-home/--baseline-bytes/--task-id는 코드 주석이 스스로
    // "둘 다 선택 인자다"(HYK-280)라고 밝힌다. 이 인자들은 필수 선언에서
    // 뺐다 -- recognitionOnlyFlags로만 남겨 호출 지점 인식 신호로 쓴다
    // (§2-1 비타협 "표와 다르면 다른 점을 결과 파일에 적어라" 이행).
    recognitionOnlyFlags: Object.freeze([
      "--claude-home",
      "--baseline-bytes",
      "--task-id",
      "--timeout-ms",
      "--stall-threshold-ms",
      "--poll-interval-ms",
    ]),
  }),
]);
