// HYK-323 (wrapper-shape-3): shared fixture texts for both the fingerprint
// checker's unit tests and the behavioral (real-PowerShell-execution)
// checker's unit tests. Centralized so the "우회 9종" (bypass forms) used
// as CANONICAL_MISMATCH fixtures and the ones used as behavioral
// counterexamples are provably the SAME text, not two hand-copied lists
// that could silently drift apart.
//
// FIXED_FUNCTION_TEXT is the live control room `Invoke-SeatProofGate` body.
// HYK-415-canonical-sync-2 (2026-09-01): re-synced to the post-HYK-271
// body (the sidecar modal-check wire, see
// docs/control-room-patches/HYK-271-wire-modal-check.md) -- copied
// verbatim from scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-
// hyk271-wire-applied.ps1.txt, the same repo-tracked fixture
// seat-proof-wrapper-canonical.json's sha256 was re-measured from. It is a
// curated snapshot, not a live read of the control room file -- see
// seat-proof-wrapper-shape.test.mjs's "실물" test for the actual live-file
// comparison.

export const FIXED_FUNCTION_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  if (-not (Test-Path $gateCliPath)) {",
  '    Write-Error "SEAT_PROOF_CLI_MISSING: $gateCliPath 가 없다 -- 좌석 증명을 확인할 수 없으므로 배달을 계속하지 않는다(HYK-299 gap#55 기계 게이트, fail-closed)."',
  "    exit 8",
  "  }",
  '  $dsShowPath = Join-Path $env:TEMP "hyk299-seatproof-$Task-dispatch-show.json"',
  '  $tsShowPath = Join-Path $env:TEMP "hyk299-seatproof-$Task-terminal-show.json"',
  "  & orca orchestration dispatch-show --task $Task --json | Out-File -FilePath $dsShowPath -Encoding utf8",
  "  & orca terminal show --terminal $handle --json | Out-File -FilePath $tsShowPath -Encoding utf8",
  "  # worktreeId 축은 ps1이 사전에 독립적으로 알 수 있는 값이 아니다(실측:",
  "  # `<세션 guid>::<경로>` 형태, guid part는 ps1이 모른다) -- 이번 결선에서는",
  "  # 방금 뜬 terminal-show 자신에서 취한다(부분 동어반복, 알려진 한계 --",
  "  # docs/control-room-patches/HYK-299-dispatch-worker-seat-proof.md 정직",
  "  # 한계 절 참조). worktreePath는 $Worktree(ps1이 처음부터 아는 값, Norm으로",
  "  # orca의 슬래시 표기와 맞춘다)를 그대로 쓴다 -- 이 축은 진짜 독립이다.",
  "  # 배정 신원 축(harnessTaskId=$label/runtimeTaskId=$Task/dispatchId)과",
  "  # pane-key 축(dispatch-show의 assignee_pane_key vs 이 terminal-show의",
  "  # tabId:leafId)은 전부 진짜 독립 대조다.",
  "  $tsShowObj = Get-Content $tsShowPath -Raw | ConvertFrom-Json",
  "  $seatProofWorktreeId = $tsShowObj.result.terminal.worktreeId",
  "  # ★HYK-323 비상 직수리(2026-08-19, ORCH 교대 28회차 · 검토 없이 적용 -- 상신",
  "  # 통역 받는함 `2026-08-19-1906-상신-좌석증명-래퍼결함-배달전면차단.md` 5항 ⓐ 승인분).",
  "  # 결함: `& node ...` 의 stdout 한 줄이 함수 반환값에 섞여 `return $LASTEXITCODE` 와",
  "  # 함께 [문장, 코드] 배열로 나갔다 -> 호출부 `-ne 0` 이 «PROVEN(exit 0)» 도 참으로 읽어",
  "  # **모든 배달을 거부**했다(합성 재현 완료: exit 0 인데 거부). 판정 로직·검사 강도는",
  "  # 그대로이며, 화면 출력을 Write-Host 로 분리해 반환값을 종료코드 하나로 만든다.",
  "  $gateOut = & node $gateCliPath --dispatch-show $dsShowPath --terminal-show $tsShowPath --harness-task-id $label --runtime-task-id $Task --dispatch-id $dispatchId --worktree-id $seatProofWorktreeId --worktree-path (Norm $Worktree) 2>&1",
  "  $gateExit = $LASTEXITCODE",
  '  foreach ($line in @($gateOut)) { Write-Host "      $line" }',
  "  # HYK-271(2026-09-01, HYK-271-wire-1 -- docs/control-room-patches/HYK-271-preflight-preview-marker.md",
  "  # §2/§2-a): 좌석 증명 게이트가 이미 통과했을 때만(先행 게이트가 이미",
  "  # 비0이면 그대로 그 사유로 거부되므로 여기서 또 돌 이유가 없다), 같은",
  "  # $tsShowPath로 사이드카 모달 검사기를 부른다 -- 추가 orca 조회 0, 기존",
  "  # $gateExit 하나에 그대로 접는다(새 exit 코드·새 분기 없음, design doc",
  '  # "두 게이트 중 하나라도 비0이면 기존 SEAT_PROOF_REJECTED 분기에 그대로',
  '  # 올라탄다" 그대로).',
  '  if ($gateExit -eq 0) { & node (Join-Path $Worktree "scripts/relay/dispatch-worker-modal-check.mjs") --terminal-show $tsShowPath 2>&1 | ForEach-Object { Write-Host "      $_" }; $gateExit = $LASTEXITCODE }',
  "  return $gateExit",
  "}",
].join("\n");

export const BROKEN_FUNCTION_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  if (-not (Test-Path $gateCliPath)) {",
  '    Write-Error "SEAT_PROOF_CLI_MISSING: $gateCliPath 가 없다 -- 좌석 증명을 확인할 수 없으므로 배달을 계속하지 않는다(HYK-299 gap#55 기계 게이트, fail-closed)."',
  "    exit 8",
  "  }",
  '  $dsShowPath = Join-Path $env:TEMP "hyk299-seatproof-$Task-dispatch-show.json"',
  '  $tsShowPath = Join-Path $env:TEMP "hyk299-seatproof-$Task-terminal-show.json"',
  "  & orca orchestration dispatch-show --task $Task --json | Out-File -FilePath $dsShowPath -Encoding utf8",
  "  & orca terminal show --terminal $handle --json | Out-File -FilePath $tsShowPath -Encoding utf8",
  "  $tsShowObj = Get-Content $tsShowPath -Raw | ConvertFrom-Json",
  "  $seatProofWorktreeId = $tsShowObj.result.terminal.worktreeId",
  "  & node $gateCliPath --dispatch-show $dsShowPath --terminal-show $tsShowPath --harness-task-id $label --runtime-task-id $Task --dispatch-id $dispatchId --worktree-id $seatProofWorktreeId --worktree-path (Norm $Worktree)",
  "  return $LASTEXITCODE",
  "}",
].join("\n");

// The nine bypass notations §1 of the HYK-323-wrapper-shape-3 task lists,
// verbatim from review r1 (forms 1-3) and review r2 (forms 4-9) -- all nine
// read as OK from at least one prior round's shape checker despite being
// the same defect class (gate CLI output escapes into the function's
// return value, so a caller's `-ne 0` reads PROVEN/exit-0 as a rejection
// too). Kept minimal (no unrelated setup lines) so both the fingerprint
// test (this text != canonical text) and the behavioral test (actually run
// this function body against a fake gate) exercise the exact same
// notation.
export const BYPASS_FORMS = [
  {
    id: "1-write-output-leak",
    label: "①캡처 후 Write-Output 재유출",
    text: [
      "function Invoke-SeatProofGate([string]$dispatchId) {",
      '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
      "  $gateOut = & node $gateCliPath --dispatch-show $dsShowPath 2>&1",
      "  Write-Output $gateOut",
      "  return $LASTEXITCODE",
      "}",
    ].join("\n"),
  },
  {
    id: "2-duplicate-definition",
    label: "②수리본 뒤 미캡처 결함본 중복 정의",
    text: [
      FIXED_FUNCTION_TEXT,
      "",
      "function Invoke-SeatProofGate([string]$dispatchId) {",
      '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
      "  & node $gateCliPath --dispatch-show $dsShowPath",
      "  return $LASTEXITCODE",
      "}",
    ].join("\n"),
  },
  {
    id: "3-splatting",
    label: "③splatting(@nodeArgs)으로 미캡처 호출",
    text: [
      "function Invoke-SeatProofGate([string]$dispatchId) {",
      '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
      '  $nodeArgs = @($gateCliPath, "--dispatch-show", $dsShowPath)',
      "  & node @nodeArgs",
      "  return $LASTEXITCODE",
      "}",
    ].join("\n"),
  },
  {
    id: "4-invoke-expression",
    label: "④Invoke-Expression 간접 호출",
    text: [
      "function Invoke-SeatProofGate([string]$dispatchId) {",
      '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
      '  $cmd = "& node `"$gateCliPath`" --dispatch-show `"$dsShowPath`""',
      "  Invoke-Expression $cmd",
      "  return $LASTEXITCODE",
      "}",
    ].join("\n"),
  },
  {
    id: "5-first-of-two-leaked",
    label: "⑤두 게이트 호출 중 첫 번째 캡처 변수만 재유출",
    text: [
      "function Invoke-SeatProofGate([string]$dispatchId) {",
      '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
      "  $gateOut1 = & node $gateCliPath --dispatch-show $dsShowPath 2>&1",
      "  Write-Output $gateOut1",
      "  $gateOut2 = & node $gateCliPath --terminal-show $tsShowPath 2>&1",
      "  $gateExit = $LASTEXITCODE",
      "  return $gateExit",
      "}",
    ].join("\n"),
  },
  {
    id: "6-write-output-inputobject",
    label: "⑥Write-Output -InputObject $gateOut",
    text: [
      "function Invoke-SeatProofGate([string]$dispatchId) {",
      '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
      "  $gateOut = & node $gateCliPath --dispatch-show $dsShowPath 2>&1",
      "  Write-Output -InputObject $gateOut",
      "  return $LASTEXITCODE",
      "}",
    ].join("\n"),
  },
  {
    id: "7-parenthesized-expression",
    label: "⑦괄호식 ($gateOut)",
    text: [
      "function Invoke-SeatProofGate([string]$dispatchId) {",
      '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
      "  $gateOut = & node $gateCliPath --dispatch-show $dsShowPath 2>&1",
      "  ($gateOut)",
      "  return $LASTEXITCODE",
      "}",
    ].join("\n"),
  },
  {
    id: "8-get-command-node",
    label: "⑧& (Get-Command node) ...",
    text: [
      "function Invoke-SeatProofGate([string]$dispatchId) {",
      '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
      "  & (Get-Command node) $gateCliPath --dispatch-show $dsShowPath",
      "  return $LASTEXITCODE",
      "}",
    ].join("\n"),
  },
  {
    id: "9-node-case-variant",
    label: "⑨$Node 대소문자 변형 호출",
    text: [
      "function Invoke-SeatProofGate([string]$dispatchId) {",
      '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
      "  & $Node $gateCliPath --dispatch-show $dsShowPath",
      "  return $LASTEXITCODE",
      "}",
    ].join("\n"),
  },
];

// HYK-323 (wrapper-shape-4) §2-2/§2-3 item 3, §3 item 4: KNOWN LIMITATION,
// not a bypass to close. Both forms below embed the EXACT canonical body
// text (byte-identical `function Invoke-SeatProofGate(...) { ... }`) inside
// a context where PowerShell never actually defines that function --
// review r3 proved `extractAllFunctionBodies`'s brace-depth text scan finds
// and hashes that braced text regardless of what surrounds it, so the
// fingerprint verdict reads both as OK/unchanged even though calling
// Invoke-SeatProofGate afterward fails with "not recognized"
// (FUNCTION_ABSENT, confirmed with pwsh -- see the behavioral tests below).
// This is deliberate deception a human would have to construct on purpose;
// it is NOT the accidental-regression class this checker promises to catch
// (module header, wrapper-shape-4 section). Kept as fixtures so the gap is
// pinned by a test instead of only described in prose.
export const KNOWN_LIMITATION_FORMS = [
  {
    id: "limit-herestring",
    label: "정본 본문을 here-string 안에 넣음(함수로 정의되지 않음)",
    text: ["$notAFunction = @'", FIXED_FUNCTION_TEXT, "'@"].join("\n"),
  },
  {
    id: "limit-if-false",
    label: "정본 함수를 죽은 if ($false) 블록 안에 넣음(실행 경로 없음)",
    text: ["if ($false) {", FIXED_FUNCTION_TEXT, "}"].join("\n"),
  },
];

// Safe notations (§2-2/§3 false-positive guard) -- must behave PASS/REJECT
// correctly under the behavioral check same as FIXED_FUNCTION_TEXT.
export const SAFE_FORMS = [
  {
    id: "safe-write-host",
    label: "Write-Host로 캡처 변수 출력(파이프라인 미오염)",
    text: [
      "function Invoke-SeatProofGate([string]$dispatchId) {",
      '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
      "  $gateOut = & node $gateCliPath --dispatch-show $dsShowPath 2>&1",
      "  $gateExit = $LASTEXITCODE",
      '  foreach ($line in @($gateOut)) { Write-Host "      $line" }',
      "  return $gateExit",
      "}",
    ].join("\n"),
  },
  {
    id: "safe-null-assign",
    label: "$null = ... 로 출력 버림",
    text: [
      "function Invoke-SeatProofGate([string]$dispatchId) {",
      '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
      "  $null = & node $gateCliPath --dispatch-show $dsShowPath 2>&1",
      "  return $LASTEXITCODE",
      "}",
    ].join("\n"),
  },
  {
    id: "safe-out-null-pipe",
    label: "| Out-Null 로 출력 버림",
    text: [
      "function Invoke-SeatProofGate([string]$dispatchId) {",
      '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
      "  & node $gateCliPath --dispatch-show $dsShowPath | Out-Null",
      "  return $LASTEXITCODE",
      "}",
    ].join("\n"),
  },
];
