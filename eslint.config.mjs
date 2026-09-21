import eslintJs from "@eslint/js";

export default [
  // BEGIN GENERATED FRAME IGNORES -- scripts/check/gen-frame-ignore.mjs, do not hand-edit. See .prettierignore's header for source/reason/sunset.
  {
    ignores: [
      ".claude/skills/capture-context/SKILL.md",
      ".github/workflows/enforce.yml",
      ".gitleaks.toml",
      "AGENTS.md",
      "hooks/commit-msg",
      "hooks/pre-commit",
      "observe.sh",
      "scripts/check/abort-record-core.mjs",
      "scripts/check/abort-record-core.test.mjs",
      "scripts/check/abort-record-writer.mjs",
      "scripts/check/admission-completion-adapter.mjs",
      "scripts/check/admission-ledger-env-isolation.mjs",
      "scripts/check/admission-ledger-env-isolation.test.mjs",
      "scripts/check/child-probe-timeout-policy.mjs",
      "scripts/check/child-probe-timeout-policy.test.mjs",
      "scripts/check/clear-safe-check.mjs",
      "scripts/check/clear-safe-check.test.mjs",
      "scripts/check/consumption-receipt-core.mjs",
      "scripts/check/consumption-receipt-core.test.mjs",
      "scripts/check/consumption-receipt-writer.mjs",
      "scripts/check/context-inject.mjs",
      "scripts/check/context-inject.test.mjs",
      "scripts/check/controlroom-fresh.mjs",
      "scripts/check/controlroom-fresh.test.mjs",
      "scripts/check/dispatch-arg-contract-core.mjs",
      "scripts/check/dispatch-arg-contract-core.test.mjs",
      "scripts/check/dispatch-arg-contract-registry.mjs",
      "scripts/check/dispatch-arg-contract.mjs",
      "scripts/check/dispatch-arg-contract.test.mjs",
      "scripts/check/dispatch-gate-decision-core.mjs",
      "scripts/check/dispatch-gate-decision-core.test.mjs",
      "scripts/check/dispatch-gate-decision.mjs",
      "scripts/check/dispatch-gate-decision.test.mjs",
      "scripts/check/done-line-write-guard.mjs",
      "scripts/check/done-line-write-guard.test.mjs",
      "scripts/check/dropped-at-stamp-core.mjs",
      "scripts/check/envelope-archive.mjs",
      "scripts/check/envelope-archive.test.mjs",
      "scripts/check/first-observation.mjs",
      "scripts/check/first-observation.test.mjs",
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-28-hyk378-exit4-applied.ps1.txt",
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-28-hyk378-exit4-before.ps1.txt",
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-29-hyk272-notstarted-applied.ps1.txt",
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-29-hyk272-notstarted-before.ps1.txt",
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-29-hyk387-receipt-pointer-applied.ps1.txt",
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-29-hyk387-receipt-pointer-before.ps1.txt",
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-30-hyk396-dispatch-id-stamp-applied.ps1.txt",
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-30-hyk396-dispatch-id-stamp-before.ps1.txt",
      "scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-applied.ps1.txt",
      "scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-before.ps1.txt",
      "scripts/check/fixtures/control-room-dispatch-worker-2026-09-03-hyk422-dispatch-run-boundary-applied.ps1.txt",
      "scripts/check/fixtures/control-room-dispatch-worker-2026-09-03-hyk422-dispatch-run-boundary-before.ps1.txt",
      "scripts/check/fixtures/control-room-gate-criteria-2026-08-27-hyk274-s19-applied.md.txt",
      "scripts/check/fixtures/control-room-gate-criteria-2026-08-27-hyk274-s19-before.md.txt",
      "scripts/check/fixtures/control-room-live-baseline/README.md",
      "scripts/check/fixtures/control-room-live-baseline/worker-dispatch-rule.md.txt",
      "scripts/check/fixtures/control-room-orca-worker-seat-2026-08-29-hyk379-update-suppress-applied.ps1.txt",
      "scripts/check/fixtures/control-room-orca-worker-seat-2026-08-29-hyk379-update-suppress-before.ps1.txt",
      "scripts/check/fixtures/control-room-orca-worker-seat-2026-09-10-hyk462-seat-config-injection-applied.ps1.txt",
      "scripts/check/fixtures/control-room-orca-worker-seat-2026-09-10-hyk462-seat-config-injection-before.ps1.txt",
      "scripts/check/fixtures/control-room-settings-2026-08-20-hyk330-applied.json.txt",
      "scripts/check/fixtures/control-room-settings-2026-08-20-hyk330-before.json.txt",
      "scripts/check/fixtures/control-room-worker-dispatch-rule-2026-08-21-hyk335-applied.md.txt",
      "scripts/check/fixtures/control-room-worker-dispatch-rule-2026-08-21-hyk335-before.md.txt",
      "scripts/check/fixtures/control-room-worker-dispatch-rule-2026-08-26-hyk357-352-applied.md.txt",
      "scripts/check/fixtures/control-room-worker-dispatch-rule-2026-08-26-hyk357-352-before.md.txt",
      "scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk286-applied.ps1.txt",
      "scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied-hyk271-synced.ps1.txt",
      "scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt",
      "scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20.ps1.txt",
      "scripts/check/fixtures/hyk400-dispatch-receipt-cli-pre-hyk396.mjs.txt",
      "scripts/check/fixtures/hyk400-hostile-different-meaning.mjs.txt",
      "scripts/check/fixtures/hyk400-hostile-hang.mjs.txt",
      "scripts/check/fixtures/hyk400-hostile-output-exit3.mjs.txt",
      "scripts/check/fixtures/hyk400-hostile-output-exitcode.mjs.txt",
      "scripts/check/fixtures/hyk400-hostile-output-sigterm.mjs.txt",
      "scripts/check/fixtures/hyk400-hostile-stdout-forged-response.mjs.txt",
      "scripts/check/fixtures/hyk400-hostile-stdout-leading-garbage.mjs.txt",
      "scripts/check/fixtures/hyk400-hostile-stdout-multiline-json.mjs.txt",
      "scripts/check/fixtures/hyk400-hostile-stdout-trailing-garbage.mjs.txt",
      "scripts/check/fixtures/hyk400-hostile-string-mention.mjs.txt",
      "scripts/check/fixtures/hyk400-hostile-write.mjs.txt",
      "scripts/check/fixtures/hyk442-blocked-door-1-coder-frozen.md.txt",
      "scripts/check/hook-sync-check.mjs",
      "scripts/check/hyk400-receiver-guard.mjs",
      "scripts/check/hyk400-receiver-guard.test.mjs",
      "scripts/check/hyk400-receiver-probe-runner.mjs",
      "scripts/check/hyk412-never-consumed-retire-core.mjs",
      "scripts/check/isolated-suite-runner.mjs",
      "scripts/check/isolated-suite-runner.test.mjs",
      "scripts/check/ledger-pointer-shared.mjs",
      "scripts/check/list-relay-handshake-isolated-fixtures.mjs",
      "scripts/check/live-harness-scratch-guard.mjs",
      "scripts/check/node-concurrency-sampler.mjs",
      "scripts/check/nul-byte-guard.mjs",
      "scripts/check/packet-gate.mjs",
      "scripts/check/packet-gate.test.mjs",
      "scripts/check/path-normalize.mjs",
      "scripts/check/path-normalize.test.mjs",
      "scripts/check/pm-guard.mjs",
      "scripts/check/pm-guard.test.mjs",
      "scripts/check/quality-check.mjs",
      "scripts/check/quality-check.test.mjs",
      "scripts/check/reject-streak-chain.mjs",
      "scripts/check/reject-streak-chain.test.mjs",
      "scripts/check/reject-streak-defect-sample.json",
      "scripts/check/reject-streak.mjs",
      "scripts/check/reject-streak.test.mjs",
      "scripts/check/relay-handshake-fixture-siblings.mjs",
      "scripts/check/relay-handshake.mjs",
      "scripts/check/relay-handshake.test.mjs",
      "scripts/check/retirement-auto-author-core.mjs",
      "scripts/check/retirement-auto-author-facts.mjs",
      "scripts/check/retirement-auto-author-shadow-cli.mjs",
      "scripts/check/retirement-block-reason-shared.mjs",
      "scripts/check/retirement-block-reason-shared.test.mjs",
      "scripts/check/retirement-record-core.mjs",
      "scripts/check/retirement-record-core.test.mjs",
      "scripts/check/retirement-record-writer.mjs",
      "scripts/check/review-approval-binding.mjs",
      "scripts/check/review-approval-binding.test.mjs",
      "scripts/check/review-gate.mjs",
      "scripts/check/review-gate.test.mjs",
      "scripts/check/role-guard.mjs",
      "scripts/check/role-guard.test.mjs",
      "scripts/check/role-profiles.json",
      "scripts/check/runner-receipt-writer.mjs",
      "scripts/check/runner-receipt-writer.test.mjs",
      "scripts/check/seat-engine-detect.mjs",
      "scripts/check/seat-engine-detect.test.mjs",
      "scripts/check/seat-origin-registry.mjs",
      "scripts/check/seat-preflight.mjs",
      "scripts/check/seat-proof-wrapper-behavior.mjs",
      "scripts/check/seat-proof-wrapper-canonical.json",
      "scripts/check/seat-proof-wrapper-fixtures.mjs",
      "scripts/check/seat-proof-wrapper-shape.mjs",
      "scripts/check/seat-proof-wrapper-shape.test.mjs",
      "scripts/check/selfcheck-inventory.mjs",
      "scripts/check/status-fresh.mjs",
      "scripts/check/status-fresh.test.mjs",
      "scripts/check/stop-blocking.mjs",
      "scripts/check/stop-blocking.test.mjs",
      "scripts/check/time-authority.mjs",
      "scripts/check/time-authority.test.mjs",
      "scripts/check/worker-status-onstart.mjs",
      "scripts/check/worker-status-onstart.test.mjs",
      "scripts/relay/adapters/dispatch-correlation-adapter.mjs",
      "scripts/relay/adapters/dispatch-postcheck-core.mjs",
      "scripts/relay/adapters/orca-adapter.mjs",
      "scripts/relay/adapters/seat-signal-adapter.mjs",
      "scripts/relay/adapters/teardown-inventory-adapter.mjs",
      "scripts/relay/adapters/terminal-show-adapter.mjs",
      "scripts/relay/admission-core.mjs",
      "scripts/relay/arm-seal.mjs",
      "scripts/relay/arm-state.mjs",
      "scripts/relay/auth-grant-canonical.mjs",
      "scripts/relay/auth-grant-ed25519.mjs",
      "scripts/relay/auth-grant-pin.mjs",
      "scripts/relay/dispatch-bound-seat-proof.mjs",
      "scripts/relay/dispatch-bound-seat-proof.test.mjs",
      "scripts/relay/dispatch-receipt-cli.mjs",
      "scripts/relay/dispatch-receipt-cli.test.mjs",
      "scripts/relay/dispatch-worker-modal-check.mjs",
      "scripts/relay/dispatch-worker-modal-check.test.mjs",
      "scripts/relay/dispatch-worker-seat-proof-gate.mjs",
      "scripts/relay/dispatch-worker-seat-proof-gate.test.mjs",
      "scripts/relay/finalize-done.mjs",
      "scripts/relay/finalize-done.test.mjs",
      "scripts/relay/hyk171-cycle4b2c-fixtures.mjs",
      "scripts/relay/hyk271-axis-preview-marker-synthetic.test.mjs",
      "scripts/relay/hyk271-marker-catalog-real-corpus.test.mjs",
      "scripts/relay/launch-seam.mjs",
      "scripts/relay/orca-predispatch.mjs",
      "scripts/relay/orca-spike-live.mjs",
      "scripts/relay/orca-spike-runner.mjs",
      "scripts/relay/plain-snapshot.mjs",
      "scripts/relay/pull-admission.mjs",
      "scripts/relay/pull-authorization.mjs",
      "scripts/relay/pull-grant-canonical.mjs",
      "scripts/relay/relay-core.mjs",
      "scripts/relay/running-receipt.mjs",
      "scripts/relay/seat-proof-cli.mjs",
      "scripts/relay/seat-proof-cli.test.mjs",
      "scripts/relay/seat-readiness.mjs",
      "scripts/relay/seat-registry.mjs",
      "scripts/relay/stable-intent.mjs",
      "scripts/relay/stamp-dropped-at.mjs",
      "scripts/relay/teardown-core.mjs",
      "scripts/relay/watch-result.mjs",
      "scripts/supervisor/admission-cli.mjs",
      "scripts/supervisor/admission-ledger-core.mjs",
      "scripts/supervisor/admission-ledger-store.mjs",
      "scripts/supervisor/approval-authority-adapter.mjs",
      "scripts/supervisor/concurrency-cap-adapter.mjs",
      "scripts/supervisor/concurrency-cap.json",
      "scripts/supervisor/dispatch-start-confirm-cli.mjs",
      "scripts/supervisor/dispatch-start-size-adapter.mjs",
      "scripts/supervisor/dispatch-start-size-core.mjs",
      "scripts/supervisor/rate-limit-stall-adapter.mjs",
      "templates/harness-init/project-context.template.md",
      "verify.sh",
    ],
  },
  // END GENERATED FRAME IGNORES
  eslintJs.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        module: "readonly",
        require: "readonly",
        URL: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message: "Named exports only (HYK-148 Tier1) — no default export.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/scripts/relay/*", "../relay/*", "./relay/*"],
              message:
                "scripts/check/* must not import scripts/relay/* — real dependency direction is relay -> check only (A3 inventory, HYK-148).",
            },
          ],
        },
      ],
      complexity: ["error", 12],
      "max-lines-per-function": [
        "error",
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    // scripts/check/* is the side of the boundary the deny-map restricts (relay -> check only).
    files: ["scripts/check/**/*.mjs"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/scripts/relay/*", "../relay/*", "./relay/*"],
              message:
                "scripts/check/* must not import scripts/relay/* — real dependency direction is relay -> check only (A3 inventory, HYK-148).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["scripts/relay/**/*.mjs"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    // HYK-185 seat-wire (coder-task.md §2-1, explicit design requirement):
    // orch-stall-detect.mjs (scripts/supervisor/) must read seat liveness
    // through scripts/relay/adapters/orca-adapter.mjs's read-only
    // collectSeatLivenessObservation -- the same file G9
    // (orca-cli-boundary.mjs) already treats as the sole exec-call site.
    // This is a narrow, explicit exception for exactly these files
    // (production entry point + its wiring tests), not a reopening of
    // the general relay -> non-relay dependency direction.
    // HYK-185-seat-idle-1: seat-idle-wire.test.mjs is the same shape one
    // more time -- it exercises the same production entry point for the
    // new idle axis, through the same read-only adapter call.
    // HYK-185-startcheck-wire: dispatch-start-wire.test.mjs is the same
    // shape again for the new dispatch-start axis.
    // HYK-185-seat-multi: hyk185-seat-multi-repro.test.mjs is the same
    // shape once more -- it directly calls the read-only
    // collectSeatLivenessObservation/collectSeatObservationsForWorktree
    // ports on the real 2026-08-05 21:36 KST sample to show the
    // before/after difference (coder-task.md acceptance (a)).
    // HYK-173-push-wire (coder-task.md §5-C/§5-D): the same narrow
    // exception, one more time, for the escalation axis wiring --
    // orch-stall-detect.mjs calls reduceCoordinatorState/shouldWakeHuman
    // (scripts/relay/escalation-state.mjs) to judge scoped escalation
    // messages, and watch-run.mjs calls shouldNotify from the same module
    // to dedupe reach-notify writes (the dedupe needs a state-file write,
    // which orch-stall-detect.mjs's own read-only contract forbids --
    // watch-run.mjs is already the I/O runner, so that's where it lives).
    // Both are production entry points wiring an already-merged pure
    // judgment layer, not a reopening of the general relay -> non-relay
    // dependency direction. escalation-axis-wire.test.mjs exercises the
    // same production path.
    // HYK-212-postcheck-1 (coder-task.md §2): the same narrow exception,
    // one more time, for the dispatch-postcheck axis -- orch-stall-
    // detect.mjs's judgeDispatchPostcheckAcrossWorktrees reads the
    // dispatch-postcheck-core.mjs verdict constants that the wire tests
    // also assert against. dispatch-postcheck-wire.test.mjs/dispatch-
    // postcheck-axis-wire.test.mjs exercise the same production path
    // (runOrchStallDetect/runWatchOnce) as their seat-liveness/escalation
    // predecessors above.
    // HYK-228-sweeper-liveness (coder-task.md §3, 4R quality-gate repair):
    // the same narrow exception, one more time, for the admission-sweep
    // trigger axis -- admission-sweep-wire.mjs's queryTerminalList reads
    // live seat state through orca-adapter.mjs's buildTerminalListCommand/
    // parseTerminalList/createOrcaExecFn. This is read-only: the only
    // execFn call this file makes is buildTerminalListCommand() =
    // ["terminal", "list", "--json"] -- a query, never dispatch/send/close
    // (verified by reading admission-sweep-wire.mjs's queryTerminalList,
    // its sole exec call site). admission-sweep-wire.mjs is itself a
    // production entry point (both the watch-run.mjs periodic sweep step
    // and its own standalone CLI event-trigger path, per its file-header
    // design note) wiring that read-only adapter port to the pure
    // judgment core (admission-sweep-trigger-core.mjs) -- the same shape
    // as orch-stall-detect.mjs/watch-run.mjs above, not a reopening of
    // the general relay -> non-relay dependency direction.
    // HYK-285-wake-1 (coder-task.md §2 비타협 4): wake-wire.mjs must reuse
    // orca-adapter.mjs's buildSeatLaunchTextCommand/createOrcaExecFn to
    // send the fixed §3-C wake message rather than reimplementing a
    // command builder or spawning "orca" itself (that spawn boundary is
    // enforced separately by orca-cli-boundary.mjs/G9). Same shape as the
    // exceptions above: a production entry point wiring an already-merged
    // relay port, not a reopening of the general dependency direction.
    // HYK-408-seat-decide (coder-task.md §3 완료조건3): same shape one
    // more time -- hyk408-seat-decide-repro.test.mjs exercises
    // classifySeatPreview/collectSeatLivenessObservation/AGENT_MARKER_RE/
    // DELIVERED_SEAT_REASON directly (read-only adapter ports) against
    // real-measured strings to pin the ledger-primary/screen-fallback
    // repro, same pattern as hyk185-seat-multi-repro.test.mjs above.
    // HYK-413-seat-binding-2 (coder-task.md §2⑴ "투영 지점까지 확인하라"):
    // same shape one more time -- hyk413-seat-reason-projection.test.mjs
    // drives judgeSeatLivenessForRepo (production entry point) directly to
    // confirm the adapter's split reason codes survive the supervisor's
    // own observationReasonForClosedCorrelation projection, importing only
    // read-only ports (SEAT_LIVENESS_OBSERVATION_REASON/DELIVERED_SEAT_REASON)
    // from orca-adapter.mjs, same pattern as hyk408-seat-decide-repro.test.mjs
    // above.
    files: [
      "scripts/supervisor/orch-stall-detect.mjs",
      "scripts/supervisor/seat-liveness-wire.test.mjs",
      "scripts/supervisor/seat-idle-wire.test.mjs",
      "scripts/supervisor/dispatch-start-wire.test.mjs",
      "scripts/supervisor/hyk185-seat-multi-repro.test.mjs",
      "scripts/supervisor/hyk408-seat-decide-repro.test.mjs",
      "scripts/supervisor/hyk413-seat-reason-projection.test.mjs",
      "scripts/supervisor/watch-run.mjs",
      "scripts/supervisor/escalation-axis-wire.test.mjs",
      "scripts/supervisor/reach-report-core.mjs",
      "scripts/supervisor/reach-report-core.test.mjs",
      "scripts/supervisor/dispatch-postcheck-wire.test.mjs",
      "scripts/supervisor/dispatch-postcheck-axis-wire.test.mjs",
      "scripts/supervisor/admission-sweep-wire.mjs",
      "scripts/supervisor/wake-wire.mjs",
      "scripts/supervisor/wake-wire.test.mjs",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    // ESLint's own flat-config loader requires this file to be a default
    // export -- the one tool-mandated exception the Tier1 design doc calls
    // for ("도구가 default export를 요구하는 파일은 경로가 명시된 최소
    // override만 허용").
    files: ["eslint.config.mjs"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  {
    // HYK-304-render-layer-1: 이 저장소 최초의 브라우저 실행 코드(에디터
    // 렌더링 계층) -- lexical 은 DOM/window 전역을 가정한다. 지금까지의
    // languageOptions.globals 는 node 전역만 선언돼 있었으므로 이 경로만
    // 좁게 브라우저 전역을 더한다.
    files: ["src/editor/**/*.mjs"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
      },
    },
  },
  {
    // test/editor/** 와 test/support/** 는 jsdom 으로 lexical 을 헤드리스
    // 구동한다(브라우저 DOM 전역이 있다고 가정하는 lexical import 시점
    // 요구 때문) -- 같은 이유로 브라우저 전역이 필요하다.
    files: ["test/editor/**/*.mjs", "test/support/**/*.mjs"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
      },
    },
  },
];
