# Enforcement v1

## Purpose

HYK-80 found that the harness had conventions but no enforcement: every rule
assumed a disciplined agent would follow it, so a forgetful agent or an
ambiguous human trigger could break the process without anything catching it.
This document records the enforcement design and the first real
implementation (D2, delivered under HYK-81).

## Substrate decision

Enforcement checks run as **local git hooks backed by plain Node scripts
under `scripts/check/`**, not as agent-followed conventions and not as a
hosted CI service.

Reasons:

- **Outside agent control by design.** A hook fires on the git operation
  itself (e.g. `commit-msg`), so it runs whether or not the agent that made
  the commit remembered the rule. This mirrors the loop profile's
  `scripts/verify.sh` (HYK-72), which already proved that a small local
  script the agent cannot silently skip is enough to make a check real.
- **No new infra.** A solo operator with a local git repo already has hooks
  and Node available; no CI service, server, or account is required.
- **D4 is the one exception.** Comparing `STATUS.md` against Linear needs a
  network call, so that check runs as an orchestrator-invoked script rather
  than a pure local hook (see the table below).

## Defect-by-defect enforcement table

Source: HYK-80 design comment (2026-07-03, human-approved).

| Defect | Problem                                                                                                    | Enforcement mechanism                                                                                                                                                                                                                                                                                                     | Status                                         |
| ------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| D1     | Boot reads state but not procedure, so a post-`/clear` session re-derives (and misremembers) the rules.    | Boot-line pointer to `docs/claude-orchestrator-handoff.md` in the prompt template, `harness-init.md`, and `phase-handoff.template.md`.                                                                                                                                                                                    | Done (HYK-79)                                  |
| D2     | Orchestrator can skip the contract's required independent review and self-certify.                         | `commit-msg` git hook (`hooks/commit-msg` → `scripts/check/review-gate.mjs`): an issue-tagged commit is blocked unless `.harness/review.md` carries matching `for: <id>` + `verdict: approved` + an independent-reviewer `role: REVIEW-*` marker, or the message carries an audited `skip-review: <reason>` trailer line. | Implemented this issue (v2, HYK-81), see below |
| D3     | Relay has no task identity or acknowledgment, so a stale `<role>-task.md` can run under an ambiguous "go". | `<role>-task.md` carries `task_id:` + `dropped_at:` headers; `<role>.md` must echo the same `task_id:` and end with `>>> DONE: ... @ <time KST>`; `scripts/check/relay-handshake.mjs` diffs the two and rejects a mismatched id or a DONE timestamp that predates the drop.                                               | Implemented this issue (HYK-82), see below     |
| D4     | `STATUS.md` drifts from the real Linear issue state and poisons the next boot.                             | Script diffs Linear against `STATUS.md`; run at boot and at commit time (needs network access, so it is orchestrator-invoked rather than a local-only hook).                                                                                                                                                              | Design only in this issue                      |
| D5     | The Task Contract can silently contradict a governing document (e.g. role split in `multi-agent-v1.md`).   | Contract-vs-governing-document contradiction flag, to be promoted from a checklist item to a lint check.                                                                                                                                                                                                                  | Design only in this issue                      |

D1 is already live. D2 (HYK-81) and D3 (HYK-82) are real implementations. D4
and D5 are recorded here as committed enforcement design, not yet built.

## D2 review gate — detailed spec

### Rule

Given a commit message and a review-evidence file:

0. First, before any other step (including the skip-review escape hatch in
   step 2 below): if the subject line contains an **abbreviated issue
   enumeration** — a `HYK-<digits>` tag followed by one or more comma-chained
   bare numbers with no `HYK-` prefix (e.g. `(HYK-98, 99, 106)` or
   `HYK-98,99,106` with no spaces) — the commit is blocked unconditionally,
   with a reason that proposes the fully-written form (e.g. `HYK-98, HYK-99,
HYK-106`). This is a v4 (HYK-109) addition: abbreviated lists are **not
   parsed and expanded** (doing so silently would guess at ids from bare
   numbers, which is ambiguous — a bare number could be a PR number, a line
   count, or unrelated prose), they are mechanically rejected so a human or
   agent rewrites the subject with each id spelled out. A bare number is only
   treated as part of an abbreviated enumeration when it is a **standalone
   digit token** — immediately followed by a letter or digit makes it not an
   enumeration member (`HYK-98, 2x faster` and `HYK-98, 3rd attempt` pass
   through untouched, since `2x` and `3rd` are not bare numbers). This check
   only looks at the subject; an abbreviated list that appears only in the
   commit body is not detected (same subject-only scope as step 1 below) —
   an honest limitation, not a claim of full coverage.
1. If the message's **subject line** (first line) carries no `HYK-<digits>`
   tag, the commit is not issue work and passes unconditionally. A tag
   appearing only in the body (not the subject) does not count — this keeps a
   commit's issue scope tied to the human-visible subject, not incidental
   mentions in the body prose. When the subject carries **more than one**
   distinct `HYK-<digits>` tag (a batch commit, e.g. `fix: hygiene batch
(HYK-98, HYK-99)`), duplicates are deduplicated and **every** distinct tag
   is checked independently against the evidence file in step 3 — one tag's
   evidence does not cover another's.
2. Else, if the commit message's trailer block — the last paragraph, after
   stripping any code fences (` ``` `) — contains a line whose first
   non-whitespace text is `skip-review: <reason>` (case-insensitive) with a
   non-empty `<reason>`, the commit passes — this is an audited escape hatch,
   not a silent bypass (the reason stays in git history for later audit). An
   empty reason (`skip-review: ` with nothing after it) is rejected. A
   `skip-review:` line that sits outside the trailer block (an earlier
   paragraph followed by more prose), or that appears only inside a code
   fence (for example, in a commit that documents this very rule), is not
   recognized as a skip directive at all — it falls through to the
   review-evidence check in step 3.
3. Else, the review-evidence file (default `.harness/review.md`, resolved
   from the repository root) must exist and satisfy all three of (v2,
   HYK-81; multi-tag behavior below is v3, HYK-108):
   - a `for: <id>` line matching **each** distinct issue id found in the
     subject (see step 1) — for a single-tag commit this is one line, for a
     batch commit it is one `for:` line per tag;
   - an approval verdict line `verdict: approved`. A bare `ready_for_review`
     declaration **no longer counts on its own** — that string is what a
     role writes about its _own_ work (e.g. Coder's `coder.md`), so accepting
     it let a role self-certify;
   - an independent-reviewer marker `role: REVIEW...` (case-insensitive,
     e.g. `role: REVIEW-CODEX`). Without it, an approval with no reviewer
     identity, or an approval attributed to a non-`REVIEW-*` role (such as
     the Orchestrator approving its own work), is treated as
     self-certification and blocked.

   The `verdict: approved` and `role: REVIEW-*` checks are file-level,
   checked once regardless of how many tags are in the subject — a batch
   review is a single approval covering the whole batch, not one approval
   per issue. The `for:` check is per-tag: **all** three conditions must hold
   for the commit to pass. Otherwise it is blocked, and the reason names
   which piece is missing — for the `for:` check, it names **every** tag
   still missing evidence, not just the first, so a blocked batch commit's
   stderr says exactly which issue ids still need a `for:` line.

### Batch review convention

A batch task's `review.md` (one review covering multiple issues, e.g. a
hygiene sweep across several Linear tickets) must carry a separate `for: <id>`
line for each issue it covers, in addition to a single `verdict: approved` and
`role: REVIEW-*` line covering the whole batch. A batch id alone (e.g. `for:
HYGIENE-1-coder-1`) does not satisfy the gate for any of the underlying
issue ids — the commit-msg hook matches subject tags against `for:` lines
literally, so each real issue id needs its own line. Writing the batch's
issue list as a shorthand enumeration (`HYK-98, 99, 106`) instead of fully
writing each id (`HYK-98, HYK-99, HYK-106`) is **mechanically rejected** by
step 0 of the rule above (v4, HYK-109) — the judgment rule for what counts as
an abbreviated member is: a comma-separated bare number is part of the
enumeration only when it is a standalone digit token (not immediately
followed by a letter or digit, so `2x`/`3rd` are not caught).

### Known limitation (v2, honesty note)

The hook only pattern-matches the literal `role:` string inside
`.harness/review.md`; it has no cryptographic or process-level way to verify
that the named reviewer was actually an independent process. Whoever writes
`review.md` (a careless agent, or an operator with shell access) can still
type `role: REVIEW-CODEX` by hand without a real independent review having
happened. This is the same class of unresolved gap as "the hook runs locally
and can be bypassed by anyone with shell access to `.git/hooks`" — v2 raises
the cost of self-certification (a reviewer marker must be deliberately
fabricated, which is a stronger tell than a bare `verdict: approved`) without
making it cryptographically impossible. Closing that gap needs a signed or
CI-anchored review record, which is out of scope for this local-hook
substrate and is left for a future revision.

### Implementation

- `scripts/check/review-gate.mjs` exports the pure function
  `checkReviewGate({ message, reviewPath }) -> { ok, reason }` implementing
  the rule above, plus a CLI entry point: `node review-gate.mjs
<commit-msg-file>` exits `0` when `ok` and exits `1` with `reason` on
  stderr otherwise. When `reviewPath` is not supplied, the default resolves
  to `.harness/review.md` under the **repository root** (`git rev-parse
--show-toplevel`, falling back to `process.cwd()` outside a git repo), not
  the process's current working directory — this keeps the check correct
  regardless of where the calling hook happens to run from. The evidence
  check (rule step 3) tests `for:`, `verdict: approved`, and the
  independent-reviewer `role: REVIEW...` marker as three separate gates, each
  returning its own `reason` string when it fails.
- `scripts/check/review-gate.test.mjs` is a fixture-based test suite (node's
  built-in test runner), currently 25 cases, covering: no HYK tag; a tagged
  commit with no review evidence; a tagged commit with full independent
  review evidence (`for:` + `verdict: approved` + `role: REVIEW-*`); the
  skip-review trailer with a reason and with an empty reason; a
  `skip-review` mention inside inline brackets, mid-message (outside the
  trailer paragraph), or inside a code fence — each confirmed to fall
  through to the evidence check rather than being treated as a skip
  directive; a HYK tag present only in body prose (not the subject line);
  the three self-certification cases that must still be blocked — approved
  with no reviewer marker, approved with a non-`REVIEW-*` role, and a bare
  `ready_for_review` with no `verdict: approved`; four multi-tag cases
  (v3, HYK-108) — a subject with multiple distinct tags all satisfied passes,
  a subject with multiple tags where one lacks a `for:` line is blocked with
  that id named in the reason, a repeated tag in the subject is deduplicated
  so one `for:` line suffices, and a tag appearing only in the body (with a
  different tag in the subject) is confirmed not to be checked; and five
  abbreviated-enumeration cases (v4, HYK-109) — a spaced abbreviation
  (`HYK-98, 99`) is blocked with the full ids proposed in the reason, a
  no-space abbreviation (`HYK-98,99,106`) is blocked, a non-enumeration
  comma phrase (`HYK-98, 2x faster`) falls through to the normal evidence
  path unblocked by the abbreviation check, an abbreviation combined with a
  `skip-review:` trailer is still blocked (proving the format check runs
  before the skip-review check), and a fully-written multi-tag subject
  (the HYK-108 style) still passes as a regression check. Fixtures live
  under a temp directory created per test; no real repository state is
  touched.
- `hooks/commit-msg` is a thin wrapper (`#!/usr/bin/env sh`) that resolves
  the repository root itself before calling the script:

  ```sh
  #!/usr/bin/env sh
  root=$(git rev-parse --show-toplevel) || exit 1
  script="$root/scripts/check/review-gate.mjs"
  msg="$1"
  if command -v node >/dev/null 2>&1; then
    NODE=node
  elif command -v node.exe >/dev/null 2>&1; then
    NODE=node.exe
    # node.exe is a Windows binary. Under WSL the paths above are POSIX
    # (/mnt/c/...) which Windows node reads as C:\mnt\c\... and fails to
    # resolve. Translate the paths we hand it back into Windows form.
    if command -v wslpath >/dev/null 2>&1; then
      script=$(wslpath -w "$script")
      [ -n "$msg" ] && msg=$(wslpath -w "$msg")
    fi
  else
    echo "commit-msg hook: node runtime not found (need 'node' or 'node.exe' on PATH)" >&2
    exit 1
  fi
  exec "$NODE" "$script" "$msg"
  ```

  Resolving `$root` via `git rev-parse --show-toplevel` (rather than
  `dirname "$0"`) matters because the wrapper is copied or symlinked into
  `.git/hooks/` to be installed (see below). A `dirname "$0"`-relative path
  breaks once the script runs from `.git/hooks/commit-msg`, since
  `../scripts/check` then resolves under `.git/scripts`, not the repository's
  real `scripts/check`. `git rev-parse --show-toplevel` returns the real
  repository root regardless of which path git invoked the hook from, so the
  wrapper keeps working after installation. The wrapper is version-controlled
  in the repository; git only runs hooks from `.git/hooks/`, which is never
  checked in.

  The wrapper does not call `node` directly — a plain `node "$root/..."` call
  failed with exit 127 ("node: not found") under WSL-native bash, where PATH
  carries no Linux `node` binary, only Windows' `node.exe`. Instead the hook
  probes for a runner in order: `node` first, then `node.exe`. If neither is
  on `PATH`, the hook fails loudly with an explicit
  `node runtime not found (need 'node' or 'node.exe' on PATH)` message on
  stderr and exit `1`, instead of a silent/confusing 127.

  Finding `node.exe` is necessary but not sufficient under WSL. `git rev-parse
--show-toplevel` there returns a POSIX path (`/mnt/c/...`), and handing that
  to Windows' `node.exe` fails: Windows node reads `/mnt/c/...` as
  `C:\mnt\c\...` and throws `MODULE_NOT_FOUND` for the script — so even a
  no-tag commit that should pass would fail with exit `1` for the wrong
  reason. When the chosen runner is `node.exe` and `wslpath` is available
  (i.e. we are under WSL), the hook therefore translates both the script path
  and the commit-message-file argument (`$1`) to Windows form via
  `wslpath -w` before invoking node. `wslpath -w` resolves relative arguments
  (git normally passes `.git/COMMIT_EDITMSG`) against the current directory,
  so both absolute and relative message paths work. In Git-for-Windows sh the
  `node` branch is taken and `wslpath` is absent, so no translation happens
  and paths are already Windows-native — the wrapper works unchanged there.
  The final call uses `exec` so the hook's own exit code is exactly
  `review-gate.mjs`'s exit code, not a wrapper-introduced pass-through.

  This was verified directly in WSL-native bash (Ubuntu, WSL2): `node` absent,
  `node.exe` resolved from `/mnt/c/Program Files/nodejs/`; a no-tag message
  exits `0`; an HYK-tagged message with no evidence reaches review-gate's own
  missing-evidence rejection (exit `1`) rather than `MODULE_NOT_FOUND`; and
  removing both runners from `PATH` produces the explicit not-found error.

### Installing the hook

Git does not read hooks from a version-controlled path automatically.
**Preferred (HYK-196):** use `hook-sync-check.mjs --install`, which resolves
the correct installed-hooks location itself (`core.hooksPath` if set,
otherwise the `git rev-parse --git-common-dir`-based path — correct even
from inside a linked worktree, unlike a hardcoded `.git/hooks/`), copies
every file under `hooks/` that differs, and self-verifies before exiting 0:

```sh
node scripts/check/hook-sync-check.mjs --install
```

Re-run it any time to re-sync after a hook change (idempotent — a clean
match makes no changes and exits 0); `--json` gives a machine-readable
`{verdict, mismatches, ...}` for scripting. **Known limit (honest, per
docs/enforcement-known-gaps.md gap#91): this is not yet called automatically
at seat boot** — running it is still a manual (or ORCH-run) step until that
lands, so a stale installed hook can still go unnoticed if nobody runs it.

**Fallback (manual copy/symlink, kept for a fresh clone with no Node
available yet or any other reason the CLI above can't run):**

```sh
# copy (simplest, needs re-copying after hook changes)
cp hooks/commit-msg .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg

# or symlink (stays in sync with the versioned file automatically)
ln -sf ../../hooks/commit-msg .git/hooks/commit-msg
```

This installation step is manual and per-clone, matching git's own hook
model; it is not run automatically by any script in this repository. Because
the wrapper resolves `$root` at run time instead of assuming its own file
location, both the copy and the symlink install methods work correctly.

If you installed the hook via `cp` before the node-runner-search change
above landed, `.git/hooks/commit-msg` is a stale copy and must be
re-copied (`cp hooks/commit-msg .git/hooks/commit-msg`, or re-run
`hook-sync-check.mjs --install`) to pick up the `node`/`node.exe` fallback;
a symlink install picks up the change automatically since it never copies
the file's contents.

## D3 relay handshake — detailed spec

### Problem restated

Relay v2 uses a single `<role>-task.md` slot plus an ambiguous human "go".
The original bug: the Orchestrator overwrites the slot with a new task, but a
stale "go" already in flight runs the _old_ task — nothing mechanically
checks "which task is this go for" or "did the worker actually pick up the
task the Orchestrator intended." Until now, only the Orchestrator's own eyes
compared `task_id:`/`for:` by convention, which is exactly the kind of
convention-only gap this document exists to close.

### Rule

Given a `role` (e.g. `coder`) and a harness directory (default
`.harness/` under the repository root):

1. `taskPath = <harnessDir>/<role>-task.md`, `resultPath = <harnessDir>/<role>.md`.
2. If `taskPath` does not exist, blocked: `task file not found: <path>`.
3. If `resultPath` does not exist, blocked: `result file not found (worker not done?): <path>`.
4. Extract `task_id:` from the task file (`/^task_id:\s*(\S+)/im`). Missing → blocked: `task file missing task_id header`.
5. Extract the echoed `task_id:` from the result file (same pattern). Missing → blocked: `result missing task_id echo (need a` `task_id: <id>` `line)`.
6. If the two ids differ, blocked: `handshake mismatch: task dropped '<taskId>' but result echoes '<resultId>' (stale or wrong task)`.
7. Staleness is **fail-closed**: timing evidence is required, not optional.
   - If the task file has no `dropped_at:` header, blocked: `task file missing dropped_at header (required for staleness check)`.
   - If `dropped_at:` does not parse as a KST timestamp (`YYYY-MM-DD HH:MM(:SS)? KST`), blocked: `task dropped_at not parseable: '<raw>' (need YYYY-MM-DD HH:MM KST)`.
   - If the result file has no `>>> DONE: ... @ <time>` line, blocked: `result missing ">>> DONE: ... @ <time KST>" line (required)`.
   - If that DONE timestamp does not parse, blocked: `result DONE timestamp not parseable: '<raw>'`.
   - If both parse and the DONE time is earlier than the drop time, blocked: `stale result: DONE (<doneAt>) predates task drop (<droppedAt>)`.
     Missing or unparseable timing evidence is a rejection, not a skip — a
     revision of this rule briefly let missing/unparseable timestamps skip the
     staleness check and pass on id match alone; that was fail-_open_ (a stale
     same-id result with no or garbled timing evidence slipped through) and has
     been replaced by the fail-closed version above.
8. Otherwise, ok: `relay handshake ok for <taskId>`.

### Known limitation (honesty note)

Unlike the D2 review gate, this check is **not a git hook** — nothing forces
it to run. It is a script the Orchestrator (an agent) is expected to invoke
itself (`node scripts/check/relay-handshake.mjs <role>`) before trusting a
worker's result. If the Orchestrator forgets, or an agent decides the check
is inconvenient, it simply doesn't run. This is weaker than D2, which fires
on every commit regardless of agent cooperation. It sits in the same
unresolved-limitation family as D2's "`role:` string can be typed by hand
without a real review" — here, an agent could likewise skip running the
check, or hand-edit `task_id:`/`dropped_at:`/`>>> DONE: ... @` values to make
a stale result look fresh. Making this actually unbypassable would need an
external process or daemon that watches the relay files independently of the
Orchestrator's own goodwill — left for a future revision.

### Implementation

- `scripts/check/relay-handshake.mjs` follows `review-gate.mjs`'s shape:
  ESM, a `repoRoot()` helper (`git rev-parse --show-toplevel`, falling back
  to `process.cwd()`), a pure exported function
  `checkRelayHandshake({ role, harnessDir }) -> { ok, reason }`, and a direct
  CLI block. `harnessDir` defaults to `.harness` under the repository root
  (same root-resolution rationale as D2's `reviewPath`).
  `node relay-handshake.mjs <role> [harnessDir]` exits `0` when `ok` and
  exits `1` with `reason` on stderr otherwise.
- `parseKstTimestamp(str)` strips a trailing ` KST`, requires the remainder
  to match `YYYY-MM-DD HH:MM` with an optional `:SS` (space or `T`
  separator), and constructs a `Date` with an explicit `+09:00` offset;
  anything that doesn't match that shape returns `null` rather than throwing
  (it never crashes the caller). Both `dropped_at:` and the `>>> DONE: ... @`
  timestamp accept either form independently and identically — a task
  dropped with seconds and a result reported without them (or vice versa)
  still passes the staleness check on its merits. The caller is what changed
  in an earlier revision: `null` from either timestamp now means "reject",
  not "skip the check" — see Rule step 7.
  ⚠️**HYK-244 2R-a update**: the paragraph above describes `parseKstTimestamp`
  itself, which is unchanged. But `checkRelayHandshake`'s `resolveDoneAt` now
  layers an ADDITIONAL check on top, specific to the `>>> DONE:` field only
  (not `dropped_at:`): once a DONE value parses successfully, it is rejected
  unless the raw text also contains an `HH:MM:SS` group (seconds required).
  Root cause: `templates/harness-init/status.template.md` used to spell the
  DONE format as minute-only, and this file's own consumer never checked
  precision, so minute-only DONE lines were the near-universal production
  reality — which meant two rounds finishing in the same minute produced
  identical `doneAt` values, unable to be told apart. `dropped_at:` keeps
  accepting minute precision unchanged; only the result's own completion
  stamp now requires seconds.
- `scripts/check/relay-handshake.test.mjs` is a fixture-based test suite
  (node's built-in test runner, `withFixtureDir` pattern from
  `review-gate.test.mjs`), 15 cases: id match with DONE after the drop
  (passes); id mismatch; missing task_id echo; missing task_id header;
  missing result file; missing task file; a DONE timestamp that predates
  `dropped_at` (stale, blocked); the four fail-closed timing-evidence
  cases — a matching id with no DONE line at all, a task with no
  `dropped_at:` header, an unparseable `dropped_at:`, and an unparseable DONE
  timestamp (all four blocked); and four `HH:MM(:SS)?` contract cases frozen
  in HYK-142 6A — `dropped_at` with seconds (ok), DONE with seconds (ok),
  both with seconds where the seconds themselves decide staleness (blocked,
  1s apart), and a malformed single-digit seconds value (still rejected).
  Fixtures live under a temp directory per test; no real `.harness/` state is
  touched.

## Not over-engineered / solo-operable

This is one hook, one pure-function script, and one fixture test file — no
server, no CI account, no database, no scheduling system. The default
reviewPath and verdict format are plain text conventions an operator can
satisfy by hand: write `for: HYK-80`, `verdict: approved`, and `role:
REVIEW-CODEX` (or another `REVIEW-*` role) into `.harness/review.md` once an
independent review has actually happened, or add a `skip-review: <reason>`
trailer line at the end of the commit message when review genuinely does not
apply. Nothing here requires a second person to _operate_ the mechanics, but
the `role: REVIEW-*` marker only means something if whoever writes it is
telling the truth about a review having happened — see "Known limitation"
above. What this design actually guarantees is narrower: skipping review, or
self-certifying without an independent-reviewer marker, leaves a visible,
audited trace instead of silently vanishing, which is the actual gap HYK-80
identified.

## D-CI external anchor — server-side enforcement (HYK-87 / B1)

Everything above (D2 commit-msg gate, D3 handshake) runs _locally_ and depends
on agent cooperation — an agent can `--no-verify`, edit the hook, or skip the
handshake. The external anchor moves the authority off the agent's machine:

- **`.github/workflows/enforce.yml`** re-runs `review-gate.test.mjs`,
  `relay-handshake.test.mjs`, and `sh -n hooks/commit-msg` on every pull
  request and push to `master` (GitHub-hosted runner). The agent cannot skip
  or fake this.
- **`master` branch protection** requires a pull request, the `enforce` status
  check passing, and (B1) at least one approving review, with `enforce_admins`
  on so even repo admins go through it. Direct pushes to `master` are rejected
  (`GH006 ... Changes must be made through a pull request`).
- **Identity separation (B1):** the acting agent operates as a **Write-only**
  bot collaborator, so it cannot disable branch protection; the independent
  approval comes from the repo owner (a human, outside the agent). This closes
  the "agent holds an admin token and could just turn the protection off" gap.

Landing anything on `master` is therefore: `branch → push (as the bot) → open
PR → enforce CI green → human approval → merge`. Local hooks remain as fast
feedback, but authority now lives server-side.

Residual: fully removing the human from the loop would need a separate
automated reviewer identity the acting agent does not control — deferred.

## D — role-boundary guard (role-guard PreToolUse hook, HYK-86)

### Problem restated

In a prior session the Orchestrator misread "코더 됐어" (worker acknowledgment)
as a cue to activate the CODER role itself, and directly edited source and
overwrote `coder.md` — a role-boundary violation the harness had no
mechanical check for. HYK-86 had four branches; A (re-onboarding on resume),
B (answer format), and C (signal words) are handled by convention/docs
already. This section is **D: a local guard that mechanically blocks a
role's agent from writing files outside that role's lane**, catching the same
mistake in the moment instead of relying on the agent remembering.

Honesty note up front: this is a **PreToolUse hook in the same execution
environment as the agent it's guarding**. It stops accidental/confused
writes; it is not airtight against an adversarial agent that edits or removes
the hook config itself — that requires the external anchors already in
place, the CI checks in `enforce.yml` (HYK-87/88) and (later) an isolated
runner (HYK-89). This guard and the CI anchors are defense-in-depth, not
substitutes for each other.

### Rule

Given a `role` (from the `HARNESS_ROLE` environment variable) and a file
path a write-family tool is about to touch, resolved relative to the repo
root — paths outside the repo root are never regulated (e.g. the control
room under `D:\...` stays freely editable by ORCH):

| Role                 | Allowed to write (inside repo root)                                                   | Everything else                                                    |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ORCH`               | `.harness/<anything>-task.md` (dropping a task)                                       | denied                                                             |
| `CODER`              | anything, **except** `.harness/review.md`, `.harness/verify.md`, `.harness/*-task.md` | denied                                                             |
| `REVIEW`             | `.harness/review.md` only                                                             | denied                                                             |
| `VERIFY`             | `.harness/verify.md` only                                                             | denied                                                             |
| unset / unrecognized | everything (unrestricted)                                                             | — but a warning is emitted so a silently-inactive guard is visible |

### Implementation

- `scripts/check/role-guard.mjs` follows the same shape as
  `review-gate.mjs`/`relay-handshake.mjs`: a pure exported function
  `checkRoleWrite({ role, filePath, repoRoot }) -> { ok, reason, warn? }`
  plus a CLI entry point. Path normalization
  (`normalizeToRepoRelative`) lower-cases nothing but converts backslashes to
  forward slashes and matches drive-letter or POSIX absolute forms, so a
  Windows-style, WSL-style, or already-relative path all compare correctly
  against the repo root; anything that doesn't resolve under the repo root is
  reported as `insideRepo: false` and the write is unconditionally allowed.
- The CLI block implements the **Claude Code PreToolUse hook contract**: it
  reads the hook's JSON payload from stdin (`tool_name`,
  `tool_input.file_path` for `Edit`/`Write`/`MultiEdit`,
  `tool_input.notebook_path` for `NotebookEdit`), passes through
  unconditionally (`exit 0`) for any other tool name or a missing/malformed
  payload, and otherwise calls `checkRoleWrite` with `HARNESS_ROLE` and the
  repo root (`git rev-parse --show-toplevel`, same helper as the other two
  checks). The contract chosen is the **exit-code form**: `exit 0` to allow,
  `exit 2` with the reason on stderr to block — this is fed back to the
  calling agent as the reason it was stopped, mirroring how `commit-msg`
  already reports a D2 rejection. A warning branch (unset/unrecognized role)
  still exits `0` but prints the warning to stderr, so a mis-set
  `HARNESS_ROLE` is visible instead of silently disabling the guard.
- `scripts/check/role-guard.test.mjs` is a fixture-free, pure-function test
  suite (node's built-in test runner), 28 cases covering the full role ×
  path-type matrix: each role against a source file, its own result file,
  another role's result file, and a task file; an unset role and an
  unrecognized role string (both allow-with-warning); a repo-external path
  for ORCH (control room); backslash-path normalization; an absolute in-repo
  path resolving the same as its relative form; an absolute path on a
  different drive letter being treated as outside the repo; and (round 2,
  below) `.`/`..` traversal and WSL/Git-Bash path-scheme bypasses.

**Round 2 fix (independent review caught two bypasses):** the first cut of
`normalizeToRepoRelative` compared paths as strings without resolving `.`/`..`
segments or reconciling path schemes, so `.harness/foo/../review.md` matched
neither the literal `.harness/review.md` deny-rule nor got blocked, and a
WSL-style `/mnt/c/...` path was misjudged as outside a `C:/...`-form repo
root — both let a regulated write through. The fix normalizes drive schemes
first (`toDriveStyle`: `/mnt/<drive>/...` and `/<drive>/...` → `<DRIVE>:/...`)
and then resolves `.`/`..` via `node:path`'s `posix.normalize` before the
repo-relative comparison, so matching happens on the fully-resolved path, not
the literal string the tool reported.

### Local installation (not version-controlled)

Unlike `hooks/commit-msg`, this hook is wired through Claude Code's own
settings, not git. `.claude/settings.local.json` is untracked (like
`.harness/`), so the connection is per-clone/per-operator; only the script
itself is version-controlled. Register it under `hooks.PreToolUse`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/scripts/check/role-guard.mjs"
          }
        ]
      }
    ]
  }
}
```

And before starting a role's terminal/session, export the role it is acting
as, e.g. `export HARNESS_ROLE=CODER` (or `ORCH`, `REVIEW`, `VERIFY`) — the
guard reads this once per invocation from the environment, so it must be set
in the shell the agent's tool calls actually run in.

### Known limitation (honesty note)

Same environment, same trust boundary as the agent it watches: an agent that
edits `.claude/settings.local.json` to remove the hook, or unsets/rewrites
`HARNESS_ROLE`, defeats this guard entirely, and nothing here detects that
tampering. It is a guardrail against a confused or careless agent repeating
this session's mistake, not a barrier against an adversarial one. The
CI-anchored checks in `enforce.yml` (HYK-87/88, server-side, outside agent
control) and a future isolated runner (HYK-89) are what make the harness's
founding claim — verification outside agent control — actually true; this
guard narrows the window in which the D2/D3 kind of mistake can happen
locally, in the moment, before it ever reaches a commit.

## Secret scanning ② — gitleaks CI + engine-agnostic git hook (HYK-90)

### Relationship to ① (GitHub secret scanning / push protection)

This repo already has GitHub's native **Secret Scanning + Push Protection**
(①) live on the public repo — free, and it blocks a push containing a
recognized _provider_ credential pattern (AWS, Stripe, GitHub tokens, and
similar well-known shapes) before it ever lands. Its gap: **generic
high-entropy secrets, custom formats, and full-history/PR-diff scanning with
a configurable ruleset are GitHub Advanced Security features**, which are not
enabled here (paid). ② closes that gap for free with
[gitleaks](https://github.com/gitleaks/gitleaks), applied at two points:

- **CI (`enforce` job, server-side, authoritative):** every `push` to
  `master` and every `pull_request` is scanned; a finding fails the job and
  blocks the merge (branch protection already requires `enforce` green).
- **`hooks/pre-commit` (local, git-native, fast feedback):** every `git
commit`, by anyone or anything invoking git directly — Claude via a shell
  tool call, Codex, or a human at the terminal — runs through this hook
  first, unlike Claude Code's own `PreToolUse` hooks (see the role-guard
  section above), which only ever see Claude's own tool calls and are blind
  to Codex or a manual `git commit`. This is the concrete "Codex coverage"
  gap ② closes that a Claude-only mechanism structurally cannot.

### Pin and provenance

CI installs a specific, checksum-verified gitleaks release rather than a
floating tag or a third-party Action, per an explicit human decision (Option
A over Option B, `gitleaks/gitleaks-action`, recorded against HYK-90 — the
choice to add _any_ externally-sourced binary that executes in CI is a
supply-chain decision this harness treats as requiring a human sign-off
naming the specific dependency, not something an agent decides unilaterally
mid-task):

```yaml
env:
  GITLEAKS_VERSION: "8.30.1"
  GITLEAKS_SHA256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

# ...
      - name: Install gitleaks (pinned, checksum-verified)
        run: |
          set -e
          curl -sSL -o gitleaks.tar.gz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
          echo "${GITLEAKS_SHA256}  gitleaks.tar.gz" | sha256sum -c -
          tar -xzf gitleaks.tar.gz gitleaks
          chmod +x gitleaks
          sudo mv gitleaks /usr/local/bin/gitleaks

      - name: gitleaks secret scan
        run: gitleaks detect --source . --redact
```

The `GITLEAKS_SHA256` value is the official checksum published in gitleaks'
own `gitleaks_8.30.1_checksums.txt` release asset; `sha256sum -c` fails the
step (and the job) if the downloaded archive doesn't match byte-for-byte,
so a compromised or substituted download is caught before extraction. The
checkout step also sets `fetch-depth: 0` so `gitleaks detect` (which, run
inside a real git repository, scans the full accessible commit history, not
just the working tree) has that history available in CI, not just the single
shallow commit `actions/checkout` fetches by default.

### `.gitleaks.toml` — ruleset and allowlist policy

```toml
[extend]
useDefault = true
```

extends (does not replace) gitleaks' own default ruleset — every pattern
listed [here](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml)
(AWS/GCP/Stripe/GitHub/generic-api-key/private-key-block/etc., each with its
own entropy threshold) applies unmodified. Two narrow allowlist entries exist
on top of that, each scoped to one exact file _and_ one exact literal
substring (never a directory or blanket path exemption):

| File                                               | Exempted literal           | Why it's not a secret                                                          |
| -------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| `scripts/check/review-gate.test.mjs`               | `[skip-review: ...] token` | Test fixture prose describing the skip-review trailer format, not a credential |
| `templates/harness-init/phase-handoff.template.md` | `(save tokens)`            | Refers to LLM context-window tokens, not a credential                          |

Both were added preemptively per the source task's own examples, not because
a real gitleaks run flagged them — verified directly: running gitleaks
against this repo's full history with _only_ `useDefault = true` (no
allowlist at all) already comes back clean (`no leaks found`), because
neither string is quoted-and-assignment-shaped the way gitleaks' `generic-api-key`
rule requires (a `key/token/secret/password`-adjacent word alone, with no
attached random-looking value, doesn't match). The allowlist entries are a
defensive margin against a future gitleaks ruleset update tightening that
rule, not a fix for an observed false positive.

### `hooks/pre-commit` — engine-agnostic local scan

```sh
#!/usr/bin/env sh
root=$(git rev-parse --show-toplevel) || exit 1

if command -v gitleaks >/dev/null 2>&1; then
  GITLEAKS=gitleaks
elif command -v gitleaks.exe >/dev/null 2>&1; then
  GITLEAKS=gitleaks.exe
else
  echo "pre-commit hook: gitleaks not found on PATH ('gitleaks' or 'gitleaks.exe') -- skipping local secret scan for this commit." >&2
  echo "This is fail-open by design: local scanning is fast feedback only. CI (.github/workflows/enforce.yml) runs the authoritative gitleaks scan on every push/PR and will still block a real leak even if it slips past this local hook." >&2
  echo "Install gitleaks for local feedback: https://github.com/gitleaks/gitleaks#installing" >&2
  exit 0
fi

cd "$root" || exit 1
exec "$GITLEAKS" protect --staged --redact
```

Design notes, mirroring `hooks/commit-msg`'s runner-search lesson from
HYK-83: probe `gitleaks` then `gitleaks.exe` (Windows binary reachable from
WSL/Git-Bash) in that order; if neither is found, **fail open** — print a
three-line stderr explanation and `exit 0` rather than blocking every commit
on every machine that hasn't installed gitleaks yet. This is a deliberate
asymmetry with `hooks/commit-msg`'s D2 gate, which fails _closed_ (blocks)
when its own dependency (the review-evidence file) is missing: D2's evidence
file is something this harness's own workflow produces, so its absence is
itself meaningful, while a missing _third-party scanner binary_ just means
"not installed yet," and CI is the authority regardless. When gitleaks is
found, `gitleaks protect --staged --redact` scans exactly the staged diff (not
the whole tree or history — that's what `detect` does, reserved for CI), and
`exec` passes its exit code straight through: `0` clean, non-zero blocks the
commit with the finding printed (redacted) to the terminal.

### Installing the hook (per-clone, same pattern as `commit-msg`)

**Preferred (HYK-196):** `node scripts/check/hook-sync-check.mjs --install`
installs/re-syncs every file under `hooks/` (not just this one) in a single
command — see "Installing the hook" under D2 above for the full rationale
(`core.hooksPath`/worktree-correct resolution, idempotent, still not called
automatically at seat boot).

**Fallback (manual copy/symlink):**

```sh
cp hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
# or: ln -sf ../../hooks/pre-commit .git/hooks/pre-commit
```

Git does not read hooks from a version-controlled path automatically (same
caveat as `commit-msg`); this is a manual, per-clone install step.

### Known limitation (honesty note)

The local hook is explicitly **fail-open** on a missing scanner and, like
every other local hook in this document, runs in the same environment as the
agent it watches — an agent (or human) with shell access can edit or delete
`.git/hooks/pre-commit`, or simply `git commit --no-verify`, and nothing
locally stops that. **CI is the actual authority**: `enforce.yml`'s gitleaks
step runs server-side regardless of what happened locally, and branch
protection means a finding there blocks the merge no matter how the commit
was made. This mirrors ①'s own model (push protection is server-side) and
the D-CI external anchor section above — the local hook exists purely for
fast feedback, not as the security boundary.

**Codex vs. Claude coverage, restated:** the `role-guard` PreToolUse hook
above only fires on Claude Code's own tool calls (`Edit`/`Write`/`MultiEdit`/
`NotebookEdit`) and has no visibility into Codex or a manual terminal
`git commit`. `hooks/pre-commit`, being a native git hook, fires on _any_
`git commit` regardless of what produced it — this is what makes ② the
Codex-covering half of the two mechanisms, where role-guard is a
Claude-specific guardrail.

## STATUS freshness — Tier 2 (status-fresh.mjs + Stop hook, HYK-91)

### Relationship to Tier 1

The human-facing status board (`STATUS.md`) has, until now, been kept
current purely by convention (Tier 1): every role is _supposed_ to update
its row when it finishes, but nothing checked that it actually happened. A
skipped self-report leaves the board pointing at stale state, which then
poisons whatever reads it next — the human, or a fresh Orchestrator session
after a `/clear`. Tier 2 promotes that convention to a mechanical check:
`scripts/check/status-fresh.mjs` answers "has real work happened since
`STATUS.md` was last touched?" and a non-zero exit is meant to be wired to
Claude Code's `Stop` hook so a turn cannot end silently on a stale board.

### Design: mtime, not the human-readable timestamp string

The board's `**Updated: <YYYY-MM-DD HH:MM KST>**` line is for humans to
read, not for this check to parse. Freshness is judged by comparing file
**mtimes** instead:

- `statusMtime` — the mtime of `STATUS.md` itself.
- `newestWork` — the newest of: every `.harness/*.md` relay file except
  `STATUS.md` and `PHASE-HANDOFF.md` (task/result files — `*-task.md`,
  `coder.md`, `review.md`, `verify.md`, and similar), and the current
  `HEAD` commit's timestamp (`git log -1 --format=%cI`).
- If `newestWork` is later than `statusMtime` by more than a grace window,
  the board is stale: exit `1` with a reason naming which file (or `HEAD
commit`) is newer and by how much.

This was a deliberate choice over parsing the human-typed timestamp
string, for two reasons: parsing a hand-typed `YYYY-MM-DD HH:MM KST` string
inherits every format-drift risk `relay-handshake.mjs`'s `parseKstTimestamp`
already has to guard against (D3's known limitation), and — the more
important reason — mtime comparison is **purely relative ordering**, so it
never depends on the local clock's absolute accuracy. An earlier revision of
this harness worried the sandbox clock ran ~9h behind real time; a direct
comparison of PowerShell/Git-Bash/WSL/`git commit` timestamps on
2026-07-07 found all four agree with real KST, so that specific fear did not
reproduce — but the mtime design does not need that finding to hold. Even a
sandbox clock that _is_ skewed relative to real time still orders two files
written by the same clock correctly relative to each other, which is all
this check needs.

### Grace window

A worker's normal, correct behavior — write its result file, then
self-report its own `STATUS.md` row in the same turn (see the status
template's rule 5) — produces two writes a few hundred milliseconds to a
few seconds apart, with `STATUS.md` written _second_ and therefore normally
newer. A grace window absorbs that ordering plus coarse mtime resolution on
some filesystems (up to ~1s on FAT-family volumes) without either masking
real staleness or false-alarming on a normal self-report.
`DEFAULT_GRACE_MS = 5000` (5s): wide enough to cover both effects, narrow
enough that it cannot hide a board that is actually stale — real staleness
means minutes to indefinitely, not single-digit seconds.

### No false positive on Q&A / conversational turns

A turn that only answers a question — no file written under `.harness/`, no
new commit — leaves `newestWork` unchanged from whatever it already was.
Since `STATUS.md` was already at or ahead of that value from the previous
real update, the comparison stays fresh (`ok: true`) and the check does not
fire on turns that never touched durable state. `status-fresh.test.mjs`
covers this directly (test (e)) with a fixture where no file changes between
the initial "fresh" state and the re-check.

### Implementation

- `scripts/check/status-fresh.mjs` follows the same shape as
  `relay-handshake.mjs`/`role-guard.mjs`: a pure exported function
  `checkStatusFresh({ statusPath, harnessDir, graceMs, headTime }) -> {
ok, reason }` plus a CLI entry point (`node status-fresh.mjs [--status
<path>] [--harness-dir <path>]`, or the `HARNESS_STATUS_PATH` /
  `HARNESS_DIR` env vars). `headTime` is an explicit injection point — pass
  a `Date` or `null` to bypass the real `git log` call — which is what makes
  `status-fresh.test.mjs` able to exercise the HEAD-comparison branch
  without a real git repository in its fixtures.
- **Path override, required in this repository.** The default `statusPath`
  (`<repoRoot>/.harness/STATUS.md`) assumes the harness-init default layout
  where the board lives inside the target repo. HARNESSENGINEERING's own
  board lives _outside_ the repo, at `D:\문서관리\하네스-관제실\STATUS.md`
  (see "Harness control room" in project memory) — so any live invocation
  here must pass `--status "D:\문서관리\하네스-관제실\STATUS.md"` (or set
  `HARNESS_STATUS_PATH`) explicitly; the default path resolves to a file
  that does not exist in this repo.
- `scripts/check/status-fresh.test.mjs` (`node:test`, 11 cases): STATUS
  already newest (fresh); a worker result file newer than STATUS (stale,
  reason names the file); a difference inside the grace window (fresh, not
  a false positive) and just past it (stale); `PHASE-HANDOFF.md` alone being
  newer (excluded, still fresh); the Q&A no-op turn (fresh); a missing
  STATUS file (blocked, not silently ok); `HEAD` newer than STATUS (stale,
  reason names `HEAD commit`); `HEAD` older with no work files (fresh); no
  work files and no HEAD time at all (vacuously fresh); and a `.harness`
  directory that does not exist yet (falls back to HEAD-only comparison).
  All fixtures use `fs.utimesSync` under a temp directory to control mtimes
  directly; no real `.harness/` or repository state is touched.
- `.github/workflows/enforce.yml` runs `status-fresh.test.mjs` alongside the
  other three check suites, as a **regression test only** — the live check
  itself is not a CI gate (see limitation below), so what CI guarantees is
  narrower: that the check's own logic keeps working, not that any given
  commit's `STATUS.md` was actually fresh.

### Known limitations (honesty notes)

- **Claude-only, same as role-guard.** The intended trigger is Claude
  Code's `Stop` hook, which — like the `PreToolUse` role-guard hook — only
  ever sees Claude's own turns. A Codex worker (REVIEW, VERIFY) finishing a
  turn triggers no equivalent check; the same Claude-vs-Codex coverage gap
  documented for role-guard applies here.
- **Not a CI gate.** Unlike D2's commit-msg hook, staleness is not
  something a server-side CI run can meaningfully judge after the fact —
  CI sees a single commit, not the live relay state at the moment a
  particular turn ended. Only the test suite is CI-anchored; the live
  freshness check itself only ever runs locally, on the agent's own
  goodwill to have the Stop hook wired up at all.
- **Stop hook installation is a human, one-time, per-clone step, done here
  only as documentation, not by this task.** Wiring `.claude/settings.local.json`
  is self-modification of the same settings file the role-guard hook lives
  in, which this harness treats as a human action, not something an agent
  does to its own operating constraints mid-task. Install by adding, to
  `.claude/settings.local.json`:

  ```json
  {
    "hooks": {
      "Stop": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "node /absolute/path/to/scripts/check/status-fresh.mjs --status \"D:\\문서관리\\하네스-관제실\\STATUS.md\""
            }
          ]
        }
      ]
    }
  }
  ```

  A non-zero exit from this command is what should cause Claude Code to
  surface the Stop hook's block/warning to the operator; the exact
  UX (hard block vs. warning) depends on how Claude Code's `Stop` hook
  contract handles a failing command, which is outside this document's
  scope to define.

- Same trust boundary as every other local check in this document: an
  agent or operator with shell access can remove the Stop hook wiring, or
  simply never install it, and nothing here detects that. This sits in the
  same family as role-guard's and D2/D3's own honesty notes above.

## D6 — project-context injection (context-inject.mjs + SessionStart/UserPromptSubmit hook, HYK-94)

### Relationship to D1

D1 ("boot reads state but not procedure") was closed for the _operating
procedure_ by a boot-line pointer to
`docs/claude-orchestrator-handoff.md`. What it never covered is
_project-specific_ context — the hard constraints unique to one target repo
(the running example throughout this harness: TEAM10, where committing
harness tooling to the shared team repo would be a real incident, not a
style violation). Until now that knowledge lived in two soft places: a
human pasting a boot line, or an agent choosing to read the control room
unprompted. Both depend on someone remembering, every single time,
including after every `/clear`. D6 moves the _hard constraints_ subset of
that knowledge out of memory and into a file a hook reads mechanically.

### What gets injected

Exactly one section of one file: `.harness/PROJECT-CONTEXT.md`'s
`## HARD CONSTRAINTS` heading (exact title, case-insensitive), extracted up
to the next `##` heading or end of file. Everything else in that file
(freeform background prose) is for a human or agent to read manually — only
the constraints section is small and load-bearing enough to justify forcing
it into every session's context automatically.

### Two hooks, one job split each

- **`SessionStart`** (fires on `startup|resume|clear|compact`) — **inject
  only**. This hook type cannot block: even `exit 2` is ignored and the
  session proceeds regardless. So its contract here is unconditional:
  succeed by outputting the constraints as `additionalContext`, or — if the
  context file or its constraints section is missing — output a loud
  warning as `additionalContext` instead. Either way it exits `0`; a
  warning injected into context is the strongest signal this hook type can
  give.
- **`UserPromptSubmit`** (fires before every prompt, including the first
  one after `/clear`) — **gate only, does not re-inject**. If the context
  file exists _and its card is usable_ (see "Scope A" below), it passes
  silently (`exit 0`, no output) — this hook does not repeat the injection
  on every turn, which would waste tokens for no benefit once
  `SessionStart` has already done it once per session. It blocks — `exit 2`
  plus a `{"decision":"block","reason":"..."}` JSON payload — under two
  _confirmed_ conditions: the file is absent, or the file was read
  successfully and its card is confirmed unusable (empty or unedited
  placeholder). Anything less certain (a read error on a file that does
  exist, an unexpected exception) is **not** treated as confirmed-unusable
  and passes through instead (`exit 0`) — see "fail-open boundary" below.

**Enforcement strength, as decided:** "inject + block when the card is
absent or unusable" — not "inject + block on every turn," and not "warn
only." A project with no constraints card, or a stub card that was
installed but never actually filled in, is stopped cold at the first
prompt; a project with a real, filled-in card gets it injected once per
session start and is otherwise left alone.

### Scope A (HYK-96) — form gate: catching a stub card, not just a missing one

D6 as originally shipped only asked "does `PROJECT-CONTEXT.md` exist?" — a
freshly `install.mjs`-installed card technically exists but still carries
`project-context.template.md`'s own placeholder prose (e.g. the literal
token `<GITHUB_REPO>`) until someone actually edits it. That stub would pass
the original `UserPromptSubmit` gate and get treated as real content by
`SessionStart`, injecting placeholder junk instead of an actual hard
constraint — an unfilled card is functionally the same failure as no card
at all, and D6 v1 didn't catch it. Scope A closes that gap:

- `isUsableCard(contextText)` (in `context-inject.mjs`) composes
  `extractHardConstraints` with one more check: does the extracted body
  still contain an unresolved template token matching `/<[A-Z][A-Z0-9_]*>/`
  (this harness's placeholder convention across every template — status,
  phase-handoff, project-context)? A missing/empty section fails via
  `extractHardConstraints`'s existing reason; a present-but-unedited section
  fails with a `reason` naming the exact leftover token (e.g.
  `unresolved template placeholder <GITHUB_REPO> still present`).
- `UserPromptSubmit` now blocks on `isUsableCard(...).ok === false` in
  addition to file-absence, with the `reason` surfaced in the block payload
  so the person filling in the card knows exactly what's still a stub.
- `SessionStart` now checks the same `isUsableCard` gate before injecting:
  an unusable card produces the same warning-`additionalContext` path as a
  missing one (never injects placeholder text as if it were a real
  constraint), still `exit 0` (this hook type still cannot block).
- **Fail-open boundary, restated for Scope A:** blocking requires the file
  to have been read and its content _confirmed_ unusable. A file that
  exists but can't be read (permission error, race condition) is treated as
  uncertain, not confirmed-unusable, and passes through — the same
  fail-open principle D6 v1 already applied to unexpected exceptions, now
  extended to the new content check rather than only the existence check.
- Scope B (a `/clear`-time re-orientation checkpoint) and C (a skill for
  authoring/maintaining the card) are **not** part of Scope A and remain
  open follow-up work. Scope D (splitting the card's freeform background
  from its enforced constraints section) is covered separately below.

**Addendum (HYK-97) — the gate had a real gap, found by actual use, not
theory.** The example above (`<GITHUB_REPO>`) is exactly the kind of token
`isUsableCard`'s `/<[A-Z][A-Z0-9_]*>/` regex was built to catch, and
`install.mjs` _does_ substitute it at install time — so it was never the
placeholder actually left behind in practice. The template's **other**
example, `<this project's own hard constraint>`, is lowercase and was never
substituted (it's the slot a human is supposed to fill in), and the regex
does not match it at all: the pattern requires the _entire_ bracket body to
be `[A-Z][A-Z0-9_]*`, and "this project's..." fails at its second
character. A real `team-local` install onto TEAM10 (HYK-85's first
non-self-referential validation) hit this directly: the freshly-installed,
completely unedited stub card passed `isUsableCard` and the
`UserPromptSubmit` gate cleanly — the exact "unfilled card treated as real
content" failure Scope A exists to prevent, slipping through Scope A's own
regex.

Two fixes were possible: widen the regex to catch any `<...>` bracket, or
change the template so every fill-in slot is already `<UPPER_SNAKE>`-shaped.
**Widening the regex was rejected** — a real, already-filled-in card
legitimately contains bracket syntax that is not a placeholder (this
harness's own TEAM10 card has `` `docker compose exec web npm exec firebase
-- <login|init|deploy>` ``, describing real CLI subcommand choices, not an
unedited stub); a blanket `<...>` match would false-positive on that and
block a genuinely complete card. HYK-97's fix is **template-only**:
`project-context.template.md`'s fill-in slots (the one-line purpose, the
next hard constraint, the goals/intent/context body) are now
`<REPLACE_ME_PURPOSE_LINE>`, `<REPLACE_ME_HARD_CONSTRAINT_1>`, and
`<REPLACE_ME_GOALS_INTENT_CONTEXT>` — plain `<UPPER_SNAKE>` tokens the
existing regex already catches, chosen with a `REPLACE_ME_` prefix that
cannot collide with `install.mjs`'s own substitution tokens
(`<PROFILE>`, `<REPO_PATH>`, `<CONTROL_ROOM_PATH>`, `<GITHUB_REPO>`,
`<BOT_ACCOUNT>`, `<VERIFY_CMD>`). The explanatory prose that used to live
_inside_ the placeholder brackets (e.g. "Short, imperative, non-negotiable
rules only...") moved to plain guidance text or an HTML comment next to the
token, outside the angle brackets, so nothing is lost — it just no longer
sits somewhere the gate has to reason about. `context-inject.mjs` itself —
`isUsableCard`, `PLACEHOLDER_RE`, everything — is **unchanged**; this is a
template-shape fix confirmed by `context-inject.test.mjs` gaining three new
cases built from the _actual_ template file on disk (not a hand-copied
string), one of which is exactly the false-positive check above.

**Residual limit, unchanged by this fix:** this remains a form check, not a
content check. A human can delete a `<REPLACE_ME_...>` token and type
nothing meaningful in its place (an empty-ish bullet, a placeholder word
that isn't itself bracketed) and the gate has no way to know the content is
still hollow — Scope A was never designed to judge quality, only "is there
still a template slot sitting here unedited."

### Scope D (HYK-96) — card structure: constraints vs. context

Putting a project's full background, goals, and evolving narrative into
`PROJECT-CONTEXT.md` alongside its hard constraints would make the
`SessionStart` injection payload grow without bound — every session start
would re-inject an ever-longer wall of text, diluting the signal the
injected constraints are supposed to carry. Scope D's fix needed no new
enforcement logic, only a structural convention plus tests that pin it
down:

- `project-context.template.md` now has **two headings**: `## HARD
CONSTRAINTS` (short, imperative, non-negotiable — the only thing that
  gets injected) followed by `## 목표·의도·맥락` (Goals / Intent / Context —
  freeform, storage-only, never injected, as long as useful).
- This split costs nothing to enforce because `extractHardConstraints`
  (Scope A/D6) already stops at the _next_ `##` heading — putting a second
  section after `HARD CONSTRAINTS` was already excluded from injection by
  the extraction logic that existed before this task. Scope D is a
  documentation-and-template change confirmed by test, not a new code path:
  `context-inject.mjs` was not modified for this scope (verified directly —
  see the HYK-96D coder report for the exact confirmation command and
  output).
- `context-inject.test.mjs` pins this down with a two-section fixture card:
  `extractHardConstraints` returns only the `HARD CONSTRAINTS` body (the
  Goals/Intent/Context text is absent from the result), the `SessionStart`
  CLI's `additionalContext` contains the constraints but not the
  goals/intent prose, and `UserPromptSubmit`'s pass/block gate is unaffected
  by the extra section (structure doesn't change gate behavior, only what
  gets carried into every session).
- Forward-looking intent, not built in this scope: a future `/clear`-time
  re-orientation step (Scope B) is expected to append deltas to `## 목표·
의도·맥락` over time, making it the project's running memory rather than a
  one-time background paragraph written once at install time.

### Scope C (HYK-96) — `/capture-context` capture-assist skill

D6/Scope A close the _injection_ half of the capture problem — a session
cannot proceed with a missing or stub `PROJECT-CONTEXT.md`. What they never
address is the _other_ half: making a human or agent actually write the
card's content in the first place. Nothing mechanical enforces that a real
goal, intent, or hard constraint that came up mid-conversation ever makes it
into the file — that has always depended on someone remembering to go edit
it. Scope C does not close that gap (see "Honest limits" below — it
cannot be closed mechanically), it lowers the friction of doing it right:

- `.claude/skills/capture-context/SKILL.md` (this repository) and
  `templates/harness-init/skill/capture-context/SKILL.md` (the install
  template, `<PROFILE>`/`<REPO_PATH>`/`<CONTROL_ROOM_PATH>`/`<GITHUB_REPO>`
  parameterized) define a `/capture-context` skill: read the current card,
  scan the conversation for durable facts (as opposed to one-off,
  this-conversation-only details), propose a **delta** — not a full
  rewrite — split across the two Scope D sections, present it to the human
  for edit/approval, then write only the approved delta, and finally
  self-check the result.
- **Card-path resolution matches `context-inject.mjs` exactly.** The skill
  is prose, not code — it cannot import `resolveContextPath` — so it
  restates the same precedence as an explicit procedure: (a) the
  `--context <path>` argument baked into `.claude/settings.local.json`'s
  `SessionStart`/`UserPromptSubmit` hook command for `context-inject.mjs`;
  (b) the `HARNESS_CONTEXT_PATH` environment variable; (c) the default
  `<repo-root>/.harness/PROJECT-CONTEXT.md`. This matters concretely in this
  repository: the active card is the control-room path
  (`D:/문서관리/하네스-관제실/PROJECT-CONTEXT.md`, resolved via (a)), not
  `.harness/PROJECT-CONTEXT.md` under this repo, which does not exist here
  at all — a skill that assumed the repo-local default would silently edit
  or create the wrong file.
- **The skill exists to help pass Scope A's gate, not to bypass it.** Its
  self-check step is literally
  `node scripts/check/context-inject.mjs --mode user-prompt-submit --context <path>`
  exiting `0` — the same `isUsableCard` check `UserPromptSubmit` runs — so
  running the skill to completion is, by construction, a way to turn a stub
  card into one that passes the existing gate.
- **Respects the Scope D section split.** Hard, non-negotiable rules go to
  `## HARD CONSTRAINTS` (kept short, since that section alone is injected
  every session); everything else — background, evolving intent, narrative
  — is appended to `## 목표·의도·맥락`, which is explicitly meant to
  accumulate over time (the running-memory design Scope D already called
  out as a follow-up).
- **`install.mjs` ships the skill to both profiles.** `writeTemplateFile`
  copies `templates/harness-init/skill/capture-context/SKILL.md` to
  `<repo>/.claude/skills/capture-context/SKILL.md` with the same
  five-token substitution as every other template file, skip-and-warn if
  already present, for both `solo-full` and `team-local`.
- **`team-local` gitignore.** The skill file is harness tooling, so
  `gitignore.append.template`'s `team-local` block gained
  `.claude/skills/capture-context/` (narrower than the whole
  `.claude/skills/` directory, so this profile does not hide a team's own,
  unrelated skills that might live alongside it). `solo-full`'s block gets
  no new entry — the skill is a normal repository asset there, committed
  and reviewed like the hook scripts already are (unchanged from that
  block's existing rationale).

#### Honest limits (Scope C)

- **Cannot verify completeness or quality mechanically.** "Did this capture
  everything that mattered" is a judgment call the skill cannot make on its
  own — it surfaces only what the model _noticed_ as durable during the
  scan; the human's edit/approval step is the only actual quality gate.
- **Does not see through prior compaction.** If the conversation was already
  summarized before the skill ran, whatever the summary dropped is gone from
  the skill's view too — there is no way to recover it retroactively.
- **Not a hard gate, and not Scope B.** The skill only runs on explicit
  invocation (`/capture-context`); it does not intercept `/clear` and blocks
  nothing by itself. A `/clear`-time re-orientation _checkpoint_ is separate
  work, built below as Scope B.
- **Same local trust boundary as every other mechanism in this document.**
  Nothing stops an agent or operator from skipping the skill, or from
  writing a delta that looks plausible but doesn't actually reflect the
  conversation. The self-check step only proves the resulting card's _form_
  passes `isUsableCard` — it says nothing about whether its _content_ is
  honest.

### Scope B (HYK-96) — `/clear-safe` reconciliation checkpoint

**Platform limits, stated up front — read this before anything else in this
subsection:**

- **There is no hook that can intercept `/clear` conversationally.**
  `SessionStart`'s `clear|compact` matcher fires _after_ `/clear`, in the
  brand-new session — by then the old context is already gone, far too late
  to capture anything from it. Scope B is therefore **structurally
  incapable of being a hard gate** on `/clear` itself; it can only ever be a
  soft, Stop-hook-driven reminder plus a human convention.
- **Silent automatic compaction is not covered at all.** A quiet context
  compaction that happens without an explicit `/clear` gives this mechanism
  no signal to react to.
- **What the machine part actually verifies is form, not content** — the
  same altitude as Scope A's card gate: it can confirm a reconciliation
  _attestation_ was filled in, never that the reconciliation was done well
  or even done at all in good faith.

With those limits acknowledged, the actual mechanism:

- **Protocol.** Before writing a 🟢 "safe to `/clear`" declaration anywhere
  on the status board, run `/capture-context` (Scope C) to reconcile this
  session's goals/intent/hard-constraint delta into `PROJECT-CONTEXT.md`,
  then record that a reconciliation pass happened via a marker placed next
  to the 🟢 declaration:

  ```
  <!-- clear-safe-attest: reconciled=<YYYY-MM-DD HH:MM KST | none> delta=<none|applied|deferred> -->
  ```

  `reconciled=` must be either a real timestamp or the literal `none`
  (nothing needed reconciling this session) — never left blank. The
  human-facing 🟢 prose declaration is unchanged and still coexists with
  this marker; the marker is the machine-readable half of the same claim.

- **Soft checker, `Stop` hook.** `scripts/check/clear-safe-check.mjs`
  exports a pure function `checkClearSafe(statusText) -> { ok, reason }`
  following the same text-in/struct-out shape as
  `extractHardConstraints`/`checkStatusFresh`: it looks for a 🟢 declaration
  co-located with the literal text `/clear` within the same `##`/`###`
  heading-bounded section (or an explicit `clear-safe: green` marker as a
  language-neutral escape hatch), and if found, requires the
  `clear-safe-attest` marker to be present with a non-empty `reconciled=`
  value. No green signal at all → `ok: true` (nothing to attest — this
  mirrors Scope C's own "no delta — no update needed" low-friction design).
  Any parsing trouble fails open (`ok: true`) — consistent with every other
  check in this harness treating "uncertain" as "not confirmed unsafe."
  The CLI (`--status <path>`, or `HARNESS_STATUS_PATH`, same convention as
  `status-fresh.mjs`) exits `0` on `ok`, and **on a confirmed-missing
  attestation, `2` on an `HARNESS_ROLE=ORCH` turn's first Stop this cycle,
  else `0`** (superseded by HYK-131 — see "Stop hook blocking self-
  consumption" below; this was originally `1`, never `2`, matching
  `status-fresh.mjs`'s soft severity, and still is for every non-ORCH role
  and for a `stop_hook_active` re-invocation). This keeps the checker inside
  the "structurally cannot be a hard gate for non-ORCH roles" limit stated
  above, rather than pretending otherwise, while giving the one role that
  actually owns `STATUS.md` (ORCH) a real self-repair loop.
- **Relationship to A/C/D.** A (form gate) and D (card structure) are what
  make a _filled_ `PROJECT-CONTEXT.md` mechanically distinguishable from a
  stub; C (`/capture-context`) is the hand that actually does the
  reconciling and produces the delta. B is the last piece: the protocol
  and reminder that ties a 🟢 `/clear`-safe declaration to that
  reconciliation having actually been invoked, in a way a Stop hook can
  mechanically nudge on without ever being able to force it.
- **Template.** `templates/harness-init/status.template.md` documents the
  marker and protocol under a new "`/clear` safety (reconciliation
  attestation)" section, so a freshly-installed project's board carries the
  same convention from the start. `install.mjs` copies
  `clear-safe-check.mjs`/`.test.mjs` to both profiles alongside the other
  check scripts; wiring the `Stop` hook itself is, like `status-fresh.mjs`'s
  own hook, a human, one-time, per-clone step (self-modifying
  `.claude/settings.local.json` is treated as a human action throughout
  this harness, not something a task automates). Same JSON shape as
  `status-fresh.mjs`'s own `Stop` hook entry:

  ```json
  {
    "hooks": {
      "Stop": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "node /absolute/path/to/scripts/check/clear-safe-check.mjs --status \"/absolute/path/to/STATUS.md\""
            }
          ]
        }
      ]
    }
  }
  ```

  This can sit in the same `Stop` array entry as `status-fresh.mjs`'s
  command (Claude Code's `Stop` hook contract allows multiple commands per
  event) or its own separate entry — either way, both checks read the same
  board and both are non-blocking (`status-fresh.mjs` also warns rather
  than hard-blocks on `Stop`).

- **Cycle/phase boundary receipt (HYK-128 addition).** A 🟢 `/clear`-safe
  declaration that passes the attestation check above is now also required
  to carry a **cycle-receipt** block — a second machine-parsed marker,
  co-located with the attest marker in the same `/clear 안전` section:

  ```
  <!-- cycle-receipt:
    boundary: cycle | phase
    task_id: <this cycle's task_id>
    result_ref: <commit SHA / artifact path / DONE>
    issue_ids: <related Linear issue(s)>
    sync_result: ok | drift | 판정불가
    status_updated: yes | no
    phase_update_needed: yes | no
    open_set_sync: ok | drift | 판정불가   # required only when boundary=phase
  -->
  ```

  `checkClearSafe` runs this in addition to the existing attest check (both
  must pass for `ok: true`): for **every** boundary, the six fields
  `task_id`/`result_ref`/`issue_ids`/`sync_result`/`status_updated`/
  `phase_update_needed` must all be present and non-empty, or the check fails
  and names exactly which field(s) are missing (G3). For `boundary: phase`
  specifically, `open_set_sync` must additionally be present and not the
  literal `판정불가` sentinel — missing or `판정불가` fails with a
  "사람 확인 필요" (human confirmation needed) reason rather than a silent
  pass (G4). This exists to close a fresh-but-wrong drift the HYK-128
  diagnosis found concretely: PHASE-HANDOFF had stayed stale on HYK-110's
  actual state across a cycle boundary because nothing checked that a
  cycle's result, STATUS update, and phase-update-needed flag were closed
  out together.
  - **Honesty note, same shape as the attest check above — and narrower than
    an earlier draft of this note claimed:** this only verifies the six
    required fields are _present and non-empty_ (plus, for `boundary:
phase`, that `open_set_sync` specifically isn't empty or the literal
    `판정불가` sentinel). It does **not** validate that any field's value is
    well-formed or drawn from a known set — a receipt with `boundary:
nonsense`, `sync_result: nonsense`, or any other garbage string in a
    required field still passes, as long as the field is non-empty. It
    certainly does not verify that any field's value is _true_ (that
    `result_ref` really names this cycle's actual result, that `sync_result`
    reflects a real `linear-sync` run that was actually executed, etc.) —
    presence-only, not shape-valid, not fact-checked. Same Tier 2 soft
    ceiling as everything else in this subsection — and same HYK-131
    ORCH-only promotion as the attest check above (`exit 2` only on an
    `HARNESS_ROLE=ORCH` turn's first Stop; `exit 0` for every other role and
    for `stop_hook_active` re-invocations) — and any internal parsing
    trouble still fails open (`ok: true`) exactly like the pre-existing
    attest check.
  - `parseCycleReceipt(statusText) -> { field: value } | null` is exported
    from `clear-safe-check.mjs` alongside `checkClearSafe`, following the
    same pure text-in/struct-out shape as every other check in this
    document.

### v1 scope: deliberately minimal

`UserPromptSubmit` does not track "have I already injected this session" via
a marker file. The reasoning: `SessionStart`'s trigger list already includes
`clear`, so a `/clear` should already receive a fresh injection through that
hook without `UserPromptSubmit` needing session-scoped state — adding a
marker file here would be solving a problem `SessionStart` is already
supposed to solve, before confirming it doesn't. Whether `SessionStart`
actually fires its `additionalContext` payload on `clear` in practice (as
opposed to on paper) was **not independently reproduced in this task** — see
"Known limitations" below. If it turns out `clear` does not inject
reliably, that is a follow-up issue, not a reason to add marker-file state
to `UserPromptSubmit` pre-emptively (YAGNI, per this task's own explicit
instruction).

### Implementation

- `scripts/check/context-inject.mjs` follows the same shape as
  `role-guard.mjs`/`status-fresh.mjs`: a pure exported function
  `extractHardConstraints(contextText) -> { ok, text | reason }` (file I/O
  and hook-payload handling live only in the CLI block, so the extraction
  logic is testable without touching a filesystem or a hook contract) plus
  a CLI entry point: `node context-inject.mjs --mode
<session-start|user-prompt-submit> [--context <path>]`, path also
  overridable via `HARNESS_CONTEXT_PATH`. Default context path is
  `<repoRoot>/.harness/PROJECT-CONTEXT.md`, same root-resolution pattern as
  every other check here.
- No exception path can crash either hook. `session-start` catches any
  read/parse failure and falls back to an internal-error warning
  (`additionalContext`, still `exit 0`); `user-prompt-submit` catches any
  failure and falls back to `exit 0` (pass-through) rather than blocking —
  blocking is reserved for the one condition this task specifies
  (the file is confirmed absent), not for "something went wrong while
  checking."
- `scripts/check/context-inject.test.mjs` (`node:test`, 12 cases): 6 cover
  `extractHardConstraints` directly (extraction, stopping at the next `##`
  heading, missing heading, blank section, case/whitespace-insensitive
  heading match, and a heading with extra trailing words correctly _not_
  matching the exact-title requirement); 6 cover the CLI via
  `execFileSync` against a real child process (`session-start` with a
  populated file, with a missing file, and with a file missing the
  constraints section; `user-prompt-submit` with the file present and
  absent; and a malformed-JSON stdin payload confirmed not to crash the
  process — the CLI never actually needs to parse stdin for its own logic,
  so this test guards against a future change that starts parsing it
  unsafely).
- Hook wiring (not installed by this task — see limitations):
  `.claude/settings.local.json`'s `hooks.SessionStart` and
  `hooks.UserPromptSubmit`, each running
  `node ".../scripts/check/context-inject.mjs" --mode <mode> --context "<path>"`.

### Known limitations (honesty notes)

- **Client-side only, by construction.** Unlike D-CI's server-anchored
  gitleaks/branch-protection checks, context injection has no external
  anchor to move to — a `SessionStart`/`UserPromptSubmit` hook is
  inherently a property of the client running the session. This is not a
  gap to close later; it is what this mechanism _is_.
- **Same local trust boundary as role-guard and status-fresh.** An agent or
  operator with shell access can remove the hook wiring from
  `.claude/settings.local.json`, or delete `PROJECT-CONTEXT.md` and route
  around the block by editing the check script itself. Nothing here is
  cryptographically enforced; it raises the cost of skipping the guardrail,
  it does not make skipping impossible.
- **Claude-only.** Both hook types are a Claude Code mechanism; a Codex
  worker session has no equivalent trigger, so REVIEW/VERIFY terminals
  running Codex are not covered by this injection at all — the same
  Claude-vs-Codex split already noted for role-guard and status-fresh.
- **Hook installation is a human, one-time, per-clone step — not done by
  this task.** Same rationale as status-fresh's Stop hook: writing to
  `.claude/settings.local.json` is self-modification of the file the
  role-guard hook itself lives in, which this harness treats as a human
  action. The JSON snippet above is documentation only.
- **`clear`-triggered injection: confirmed live (2026-07-07), superseding
  the HYK-94 open item above.** After the hooks were wired into
  `.claude/settings.local.json`, a real `/clear` was run and the resulting
  session listed its hard constraints without having read the file itself
  — direct evidence that `SessionStart`'s `additionalContext` payload
  actually reaches the new session's visible context on the `clear`
  trigger, not just in the CLI's own simulated-payload output. HYK-94's
  original wording ("not independently verified") is superseded by this
  entry rather than deleted, so the record shows the claim was raised
  honestly first and then closed with real evidence, not asserted from the
  start.

## STATUS↔Linear sync — Tier 2 (linear-sync.mjs, HYK-93)

### Problem restated

`STATUS.md` §6 ("열린 이슈") lists issues believed still open, by convention
only — nothing checked that against Linear's actual state. This drifted in
practice: on 2026-07-07 the Orchestrator kept nagging the human to transition
an issue to Done that Linear already showed as Done, because §6 hadn't been
updated. The fix reduces to one crisp invariant: the set of issues §6 marks
open must be a subset of Linear's actual non-Done, non-canceled issue set. The
reverse gap — an issue open in Linear but missing from §6 entirely — is
checked too.

### D4, revisited

This is the same defect the enforcement table above (D4) already named and
marked "design only." Its tier ceiling was set then and holds now: Linear is
a server this harness does not control, so there is no local anchor that can
make this check unbypassable the way D-CI's gitleaks/branch-protection gate
is. Tier 2 — a script an agent is expected to run, wired to a `Stop` hook,
same honesty class as `status-fresh.mjs` and `context-inject.mjs` — is the
ceiling, not a stepping stone to something stronger available locally.

### Rule

Given STATUS.md's §6 block and a live query of Linear's issues for this
project:

- **`staleInStatus`** — an issue §6 lists as open, but Linear's
  `WorkflowState.type` for it is `completed`, `canceled`, or `duplicate`. This
  is the core drift the 2026-07-07 incident exhibited. (`duplicate` was added
  in the HYK-128 round below — team HYK's "Duplicate" state is a closed state
  too, just not `completed`/`canceled`; without it, an issue §6 still lists
  open but Linear marked Duplicate would silently miss this check.)
- **`missingInStatus`** — an issue Linear shows as not
  `completed`/`canceled`/`duplicate`, with no corresponding entry in §6 at all
  (the reverse gap).
- **`stateDrift`** (added in the HYK-128 round) — an issue open on _both_
  sides (§6 and Linear agree it's not done) but disagreeing on _which_ open
  state it's in — e.g. §6 says "Todo" while Linear says "In Progress". This is
  judged by **`stateName` text comparison, not `WorkflowState.type`**: team
  HYK's "In Progress" (`type: started`) and "In Review" (`type: backlog`) have
  _different_ types, so type comparison alone cannot distinguish them. §6's
  free-text state is normalized to one of a fixed canonical set (`Todo`, `In
Progress`, `In Review`, `Backlog`, `Done`, `Canceled`, `Duplicate`) via
  case-insensitive prefix match before comparison; when normalization fails
  (unrecognized text), the pair is skipped entirely rather than guessed at —
  this check would rather miss a drift than manufacture a false positive out
  of text it can't parse.

Any non-empty set among the three is reported as a drift; the CLI exits `2`
and names each offending issue with its §6 state (or Linear state, for the
missing case) so the caller knows exactly what to fix. Every genuinely open
issue that correctly appears open (and in the same state) on both sides — the
common case — produces no output beyond a one-line `ok`, exit `0`.

### Fail-open semantics

Every failure mode this check can hit _before_ it has a real diff to report
is treated as "cannot judge, so don't block":

- No `LINEAR_API_KEY` in `process.env` and no readable `.env.local` (or a
  `.env.local` with no `LINEAR_API_KEY=` line) in it — warn, exit `0`.
- STATUS file not found at the resolved path — warn, exit `0`.
- Any network or Linear API error (non-2xx response, GraphQL `errors`) —
  warn, exit `0`, with the underlying error message but never the token.

This mirrors `status-fresh.mjs`'s own philosophy: a Stop hook that hard-blocks
a session merely because the machine is offline, or a token hasn't been
provisioned yet, would make the harness _less_ usable, not more correct.
**Exit `2` is reserved exclusively for a confirmed diff** — an actual query
against Linear that came back and disagreed with §6. No failure mode short of
that produces anything stronger than a warning.

### Token handling

The Linear API key is never something this script's own output can leak:
`loadLinearApiKey` returns the key value to the caller for use as an HTTP
header, but every log line the CLI prints — the fail-open warnings, the ok
message, the per-issue drift lines — names only issue ids and Linear state
strings, never the key. `.env.local` itself (which also holds unrelated
Supabase/Resend secrets, not just `LINEAR_API_KEY`) was, until this task,
untracked only via a local `.git/info/exclude` entry — a per-clone guard that
does not travel with the repository and would not protect a fresh clone.
`.gitignore` now carries `.env.local` directly, which is the actual,
version-controlled guard.

### Implementation

- `scripts/check/linear-sync.mjs` follows the same shape as the other
  checks in this document: two pure, exported, network-free functions —
  `parseStatusOpenIssues(statusText) -> [{ id, state }]` (regex-extracts
  `- **HYK-<n>** ... — *<state>*` lines from the §6 block only, stopping at
  the next `###` heading, and skipping the parenthetical Done-rollup line
  since it doesn't match the `- **HYK-<n>**` shape at all) and
  `diffSync(statusIssues, linearIssues) -> { staleInStatus, missingInStatus,
stateDrift }` — plus `normalizeStatusState(text) -> <canonical name> | null`
  (the HYK-128 addition backing `stateDrift`'s prefix-match normalization) and
  `loadLinearApiKey(root, env = process.env)`, also exported and pure with
  respect to its `env` parameter, for the fail-open token-loading path.
  Everything that touches the network or the filesystem (`fetchLinearIssues`,
  the CLI's `main()`) is not exported and is exercised only by the live
  verification runs recorded below, not by the automated test suite.
- The state comparison keys off Linear's `WorkflowState.type` enum
  (`completed`/`canceled` vs. everything else), not the human-readable
  `name` — the same "compare the structured field, not the display string"
  principle `status-fresh.mjs` applies to mtimes over hand-typed timestamps.
- CLI: `node linear-sync.mjs [--status <path>]`. Default `--status` resolves
  straight to the control room's real path
  (`D:\문서관리\하네스-관제실\STATUS.md`), unlike `status-fresh.mjs`'s
  in-repo default that this project has to override every time — this
  script's default is already correct for live use here, and `--status` is
  chiefly a test/verification override.
- `scripts/check/linear-sync.test.mjs` (`node:test`, 20 cases as of the
  HYK-128 round, up from the original 9): §6 parsing against a fixture built
  from a real trimmed slice of this repo's own `STATUS.md` (including a
  priority-annotated state, `*Todo, **High***`, and the parenthetical
  Done-rollup line, both confirmed handled correctly); `staleInStatus`
  detection for `completed`, `canceled`, and `duplicate` Linear state types;
  `missingInStatus` detection (including the `duplicate` case); a fully
  matched case producing zero drift; four cases covering
  `loadLinearApiKey`'s fail-open path (no env, no file), the env-var path,
  reading from `.env.local`, and a `.env.local` present but missing the key
  (none of which ever assert on or print a real token value); and the
  HYK-128 additions — `normalizeStatusState` case-insensitivity/prefix
  matching/collision-avoidance/unrecognized-text-returns-null, plus
  `stateDrift` firing on mismatched open states, staying silent on matched
  states, staying silent when normalization fails, and staying silent when
  the Linear side is already closed.
- Stop hook wiring (not installed by this task, same convention as
  `status-fresh.mjs`/`clear-safe-check.mjs` — human, one-time, per-clone):

  ```json
  {
    "hooks": {
      "Stop": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "node /absolute/path/to/scripts/check/linear-sync.mjs"
            }
          ]
        }
      ]
    }
  }
  ```

  This can sit in the same `Stop` array as `status-fresh.mjs`'s and
  `clear-safe-check.mjs`'s entries.

### Live verification (this task)

- Full regression (as originally run): all 6 pre-existing check suites (97
  cases total) plus the new 9-case `linear-sync.test.mjs` — 106 cases, all
  passing. (The suite has grown since — see "Known limitations" for the
  current count as of the HYK-128 round.)
- Live sync against the real control room `STATUS.md` and real Linear data:
  `node scripts/check/linear-sync.mjs --status "D:\문서관리\하네스-관제실\STATUS.md"`
  → `linear-sync ok: 9 open issue(s) in STATUS §6 match Linear.`, exit `0`
  (the Orchestrator had already hand-reconciled §6 against Linear before this
  task started, so a clean result was the expected outcome, not a given).
- Live drift injection: a temporary copy of the real STATUS file had a fake
  open entry added for HYK-97 (already Done in Linear) — running against
  that copy correctly reported `staleInStatus: HYK-97 ... Linear state is
'Done' ...` and exited `2`; the temporary file was deleted immediately
  after. The real control room file was never modified.
- Fail-open: run from a directory outside this repository with
  `LINEAR_API_KEY` unset from the environment and no `.env.local` present —
  correctly warned and exited `0`.

### Known limitations (honesty notes)

- **Tier 2 ceiling, not a gap to close.** Unlike D-CI's gitleaks/branch
  protection, there is no external anchor available: Linear's servers are
  outside this harness's control, so nothing here can force this check to
  run the way `enforce.yml` forces the commit-msg gate. This is the D4 tier
  ceiling stated in the defect table above, not an oversight.
- **Claude-only trigger, same as `status-fresh.mjs`.** The intended `Stop`
  hook only ever sees Claude Code's own turns; a Codex REVIEW/VERIFY session
  ending triggers no equivalent check.
- **Per-clone, removable.** Same local trust boundary as every other check
  in this document: an agent or operator with shell access can skip running
  it, remove the `Stop` hook wiring, or hand-edit `STATUS.md` to match
  whatever Linear currently says without the underlying work having actually
  happened.
- **Token management is a real, ongoing burden.** The check depends on a
  live `LINEAR_API_KEY` being provisioned per environment (`.env.local` or
  the shell environment) and on `.gitignore` continuing to exclude it — a
  burden this design accepts deliberately (fail-open on a missing token)
  rather than making token provisioning a hard blocker.
- **Snapshot at `Stop`-hook time only.** Like `status-fresh.mjs`, this
  reflects the state of both files/API at the moment a turn ends, not a
  continuously-enforced invariant — a drift introduced and then fixed within
  the same turn, or one that appears between checks, is invisible to it.
- **`stateDrift` is a text comparison, nothing deeper (HYK-128 addition).**
  It only tells you §6's normalized state string doesn't match Linear's
  `stateName` string; it does not know _which_ side is wrong, does not
  validate that either side's state transition was legitimate, and does not
  attempt any judgment about §6's surrounding natural-language description
  (a state name can match while the prose around it is stale or misleading —
  that whole-paragraph truth judgment is out of scope, same as always). It
  is still Tier 2, still fail-open on any API/network error exactly like
  `staleInStatus`/`missingInStatus`, and — **normalized by HYK-131** — now
  exits `1` (advisory), never `2`, on any confirmed diff (`staleInStatus`,
  `missingInStatus`, or `stateDrift`). This corrects a contract drift this
  file previously had: the code exited `2` here while this check was already
  classified Tier 2/advisory everywhere else in this document (no external
  anchor can force a Linear-side correction, so a hard block was never
  actually earned). `resolveSyncExitCode({ staleInStatus, missingInStatus,
stateDrift }) -> 0 | 1` is exported from `linear-sync.mjs` specifically so
  this exit contract is unit-testable without a live Linear API call. Unlike
  `clear-safe-check.mjs`/`controlroom-fresh.mjs` below, this check was **not**
  promoted to ORCH-only blocking — see "Stop hook blocking self-consumption"
  below for why (Linear-side corrections may need a human, not just ORCH).
- **Test suite count, current as of the HYK-128 round: 20 cases in
  `linear-sync.test.mjs`**, part of a repo-wide `scripts/check/*.test.mjs`
  total of 257 (up from the 106 recorded above at this section's original
  writing) — the increase reflects this round's `stateDrift`/`duplicate`
  additions plus the unrelated `clear-safe-check.mjs` (cycle-receipt) and new
  `pm-snapshot-gate.mjs` checks documented elsewhere in this file, not scope
  creep in this check specifically.
- **No pagination.** `fetchLinearIssues` requests the first 250 issues for
  the configured team (or, if `LINEAR_TEAM_ID` is unset, the first 250
  issues visible to the token, filtered client-side to `HYK-<n>`
  identifiers) and does not follow `pageInfo.hasNextPage`. This project is
  far from that ceiling today; a project that grows past 250 issues would
  need this extended before the check could be trusted at that scale.

## PM snapshot evidence envelope — Tier 2 (pm-snapshot-gate.mjs, HYK-128)

### Problem restated

PM (the codex-driven PM lane) has no direct read access to Linear by design —
the only input it ever sees about issue state is whatever excerpt ORCH pastes
into the PM task file. Before this check, that excerpt was free text (e.g.
"관련 이슈 상태(ORCH 발췌, 2026-07-12 기준): HYK-104 ..."): no capture
timestamp, no snapshot identity, no declared "what I didn't check". If ORCH's
excerpt were stale or simply wrong, PM had no independent way to notice — the
diagnosis this task's packet is built from (HYK-128 F3) named this gap
explicitly.

### Rule

- **G5 — envelope required for B2/B3 tasks.** A PM task file's `type:` header
  (B1 역질문 / B2 진단·개선안 / B3 시스템검증) determines whether a structured
  snapshot envelope is required at all: **B1** (pure Q&A, no Linear-dependent
  judgment) or a task carrying an explicit `linear_evidence: none`
  opt-out are exempt outright — there's nothing to check. **B2/B3** must
  carry an HTML-comment `pm-snapshot` block:

  ```
  <!-- pm-snapshot
  snapshot_id: SNAP-20260712-2114
  captured_at: 2026-07-12 21:14 KST
  issue_ids: HYK-128, HYK-125
  issue HYK-128: state=Todo; excerpt="ORCH 릴레이 충실도 ..."
  issue HYK-125: state=Todo; excerpt="sol-PM 기계 규율 ..."
  omitted_fields: none
  unknown: none
  -->
  ```

  All of `snapshot_id`, `captured_at`, `issue_ids`, at least one
  `issue <ID>: state=...` line, `omitted_fields`, and `unknown` must be
  present and non-empty; a missing field fails the check with that field
  named explicitly, never a generic "envelope invalid." **`captured_at` is
  the one field with actual format validation** — it must match `YYYY-MM-DD
HH:MM KST` exactly (no seconds, `KST` required), and a non-empty but
  wrongly-shaped value (e.g. seconds included) fails with an
  invalid-format reason distinct from "missing." Every other field
  (`snapshot_id`, `issue_ids`, `omitted_fields`, `unknown`, and the content
  after `state=` on an issue line) is checked for **presence only** — a
  non-empty but nonsensical value (`snapshot_id: ?`, `issue_ids:
not-an-id`, an issue line with an empty state) still passes. This gate
  does not validate that any of these values are well-formed identifiers,
  real issue ids, or known states — only that PM filled something in.

- **G6 — echo check.** The PM task's `snapshot_id` must reappear verbatim in
  PM's result file (`pm.md`). This is a **literal string-identity check
  only** — it confirms PM read and echoed back the same envelope ORCH sent,
  nothing about whether PM's actual output correctly reflects that
  snapshot's content. Mismatch reports both the expected and actual id side
  by side; a task with no `snapshot_id` at all (a B1 task, or an
  opted-out B2/B3) skips the echo check as vacuously satisfied.

### Honesty note (Tier 2, same ceiling as everything else in this document)

This gate verifies the envelope's **presence and shape**, and the echoed
id's **literal string identity** — nothing more. It cannot and does not
verify that any excerpted issue state is actually current or correct against
live Linear (PM has no independent channel to check that itself, and this
check has no network access either); a well-formed envelope carrying a wrong
excerpt still passes. It is deliberately isolated from `relay-handshake.mjs`
— PM's structured-evidence requirement and the Claude coder/review relay's
own go/handshake mechanics are unrelated concerns, and this task explicitly
kept them that way (`relay-handshake.mjs`/`.test.mjs` untouched by this
check's introduction — verified via `git diff --name-only` at each round of
this work).

### Implementation

- `scripts/check/pm-snapshot-gate.mjs` follows the same shape as
  `packet-gate.mjs`: pure exported functions plus a CLI, `exit 0`/`1` only
  (no `exit 2`) — `parsePmType(taskText) -> 'B1'|'B2'|'B3'|null` (extracted
  case-insensitively and whitespace-tolerantly: leading indentation before
  `type`, `TYPE`/`Type` casing, a space before the colon, and a lowercase
  value like `b1` are all normalized to the canonical uppercase form —
  hardened in a follow-up round after an independent review reproduced four
  header variants the original stricter regex rejected),
  `checkPmSnapshotEnvelope(taskText) -> { ok, reason }` (G5), and
  `checkPmSnapshotEcho(taskText, resultText) -> { ok, reason }` (G6). CLI:
  `node pm-snapshot-gate.mjs --task <path> [--result <path>]` — envelope
  check alone with just `--task`, envelope-then-echo when `--result` is also
  given.
- `scripts/check/pm-snapshot-gate.test.mjs` (`node:test`, 30 cases): type
  parsing including the four header-variant regression cases and the
  lowercase-normalization return value; G5 skip paths (B1, explicit
  `linear_evidence: none`); G5 against a complete envelope; G5 failing on a
  missing envelope block entirely, on a B3 task, and on each of the six
  required fields missing individually (named per-field, not generically);
  two `captured_at` format-rejection cases (seconds included, `KST` suffix
  missing); G6 matching/missing/mismatched/skip-when-no-id cases; and five
  CLI-level `execFileSync` cases covering both exit-0 and non-zero paths.
- Wiring: this check has no `Stop`-hook entry of its own — unlike
  `relay-handshake.mjs`, it is invoked directly by ORCH at PM task
  drop/consume time (per the approved design for this task), not through the
  Claude-only hook mechanism the rest of this document relies on.

## Control room hygiene — Tier 2 (controlroom-fresh.mjs, HYK-115)

### Problem restated

The control room (`STATUS.md` + `PHASE-HANDOFF.md`, living outside the
target repository — see `status.template.md`'s "Two repos" framing and this
repository's own `D:\문서관리\하네스-관제실\`) is Orchestrator-maintained by
convention only, the same gap D1/Tier-1 already named for the operating
procedure in general. Two concrete failure modes were observed in practice:
a cycle's changes sitting uncommitted in the control room repo for many
hours (no anchor forcing a commit the way `review-gate.mjs` forces one in
the target repo), and `PHASE-HANDOFF.md` going stale relative to `STATUS.md`
— a fresh Orchestrator session boots off a handoff document describing a
phase that has since moved on. Both are invisible to every check already in
this document, since all of them scope to the target repository, not the
control room.

### Rule

Given a control room path (a directory outside the target repository):

- If the path is absent, not a directory, or not a git repository at all —
  **vacuously ok, no warning**. Most installs (`team-local`) have no control
  room; treating "there isn't one" as a defect would nag on every one of
  them, and a `solo-full` install that hasn't set one up yet is not this
  check's business to flag.
- **Check ①, dirty-cycle detection**: if `git status --porcelain` in the
  control room is non-empty (uncommitted changes) _and_ the last commit
  there is older than `DEFAULT_DIRTY_THRESHOLD_MS` (3h) — warn: looks like a
  cycle's changes were never committed.
- **Check ②, handoff staleness**: if both `STATUS.md` and
  `PHASE-HANDOFF.md` exist in the control room and `|STATUS.md mtime −
PHASE-HANDOFF.md mtime|` exceeds `DEFAULT_HANDOFF_THRESHOLD_MS` (12h) —
  warn: the handoff may no longer describe the current phase.
- Either warning is reported; **only an `HARNESS_ROLE=ORCH` turn's first
  Stop this cycle can escalate a confirmed warning to exit `2`** — see
  "Fail-open severity" below and "Stop hook blocking self-consumption"
  (HYK-131) further down for the full ORCH-only/recursion-guard contract.

### Fail-open severity, matching `linear-sync.mjs`'s convention

Every condition this check cannot judge with confidence is treated as
"nothing to report," mirroring `linear-sync.mjs`'s own fail-open philosophy
(no API key → skip; STATUS file missing → skip; network error → skip): an
absent control room, or a control room that is not a git repository,
resolves to `ok: true` with no warning at all, never a false alarm. Either
`STATUS.md` or `PHASE-HANDOFF.md` being missing works the same way, but only
for check ② (handoff staleness) — that comparison is simply skipped when it
cannot be made. **Check ① (dirty-cycle detection) is independent of both
files and keeps running regardless**: a control room with neither file
present can still produce a dirty-cycle warning if its working tree is
dirty and the last commit is older than the threshold. Missing
STATUS/PHASE-HANDOFF silences check ②, not the whole function. When a
warning _is_ produced, the severity **(superseded by HYK-131 — originally
always `exit 1`, mirroring `status-fresh.mjs`/`clear-safe-check.mjs`)** now
escalates to `exit 2` only on an `HARNESS_ROLE=ORCH` turn's first Stop this
cycle, and is `exit 0` for every non-ORCH role and for a `stop_hook_active`
re-invocation — see the new section below for the shared adapter this and
`clear-safe-check.mjs` both defer to. This check still exists to remind
ORCH specifically (the role that actually owns the control room), not to
block any other role's turn — a REVIEW/VERIFY/CODER/PM session, or a Codex
session this hook never even sees, is never affected by this check at all.

### Implementation

- `scripts/check/controlroom-fresh.mjs` follows the same shape as every
  other check in this document: a pure exported function
  `checkControlRoomFresh({ controlRoomPath, now, dirtyThresholdMs,
handoffThresholdMs, isGitRepoFn, gitStatusFn, lastCommitTimeFn, statusPath,
handoffPath }) -> { ok, warnings, reason }`, plus a CLI entry point
  (`node controlroom-fresh.mjs --control-room <path>`, or the
  `HARNESS_CONTROL_ROOM_PATH` env var). `isGitRepoFn`/`gitStatusFn`/
  `lastCommitTimeFn`/`now` are injection points for testability without a
  real git repository or real elapsed time, the same rationale as
  `status-fresh.mjs`'s `headTime` parameter.
- Thresholds are exported constants (`DEFAULT_DIRTY_THRESHOLD_MS`,
  `DEFAULT_HANDOFF_THRESHOLD_MS`), not inline literals, for the same reason
  `status-fresh.mjs` exports `DEFAULT_GRACE_MS`: one place to tune, and a
  test suite that pins the exact value instead of a magic number.
- `scripts/check/controlroom-fresh.test.mjs` (`node:test`, 8 cases): a dirty
  tree with a stale last commit (warns); a dirty tree with an
  unresolvable/null last commit time — an unborn repository or a failed
  `git log` call — (no warning, ok, matching the fail-open posture rather
  than treating the missing timestamp as "very old"); a dirty tree with a
  recent commit (ok); a clean tree regardless of commit age (ok); a
  STATUS/PHASE-HANDOFF mtime gap beyond threshold (warns); a control room
  path that is absent or not a git repo (vacuously ok); no `controlRoomPath`
  given at all (vacuously ok); and a mtime gap inside the threshold (ok, not
  a false positive). All git interaction is injected rather than shelled
  out to a real repository, so no fixture ever touches real git state.
- `templates/harness-init/install.mjs` copies `controlroom-fresh.mjs`/
  `.test.mjs` alongside the other check scripts for **both** profiles (the
  script itself is harmless to have installed even where it will never
  fire), but only wires the `Stop` hook command for the `solo-full` profile
  — `buildHooksBlock` appends a `controlroom-fresh.mjs --control-room
"<posix control room path>"` entry to the `Stop` array only when
  `params.profile === "solo-full"`; `team-local` has no control room path to
  pass, so no entry is added there.

### Live smoke (this task, read-only)

`node scripts/check/controlroom-fresh.mjs --control-room
"D:/문서관리/하네스-관제실"` was run directly against the real control room —
read-only, no write access taken (this task's own prohibition). See the
CODER result (`.harness/coder.md`, HYK-116-batch-coder-1) for the exact
exit code and warning text observed at run time; that observation is a
point-in-time reading of a live board, not something this document should
freeze as if it were permanent.

### Known limitations (honesty notes)

- **Tier 2 ceiling, not a gap to close — same class as `linear-sync.mjs`
  (D4).** The control room lives outside every repository this harness's
  local hooks can anchor to; there is no server-side authority (no CI, no
  branch protection) that could ever run over a `D:\...` path the way
  `enforce.yml` runs over `master`. This is a soft local reminder, full
  stop — it can never be promoted past Tier 2 without a genuinely different
  substrate (an external watcher process, out of scope here).
- **The Orchestrator can ignore a warning outright.** A `Stop`-hook exit `1`
  surfaces in the transcript but blocks nothing; an agent that decides the
  warning is noise can simply continue. The warning still lands in the
  conversation the human sees, though, which is the actual guarantee this
  mechanism makes — visibility, not enforcement.
- **Threshold values are initial guesses, not tuned.** `3h` (dirty-cycle)
  and `12h` (handoff gap) were chosen as plausible starting points, not
  derived from measured cycle cadence. HYK-116's own instruction calls for
  a one-week observation window before treating either number as settled;
  expect both to move.
- **Check ① structurally false-positives on this harness's own normal
  operation.** This relay treats the control room as a live dashboard:
  every worker self-report (`STATUS.md` §1 row) is a plain `Edit`, not
  followed by a commit, so the control room repo routinely sits dirty for
  hours between deliberate commits even when nothing is actually wrong.
  Once the last commit crosses the `3h` threshold, check ① keeps warning on
  every subsequent `Stop` regardless of how normal the cycle is — this was
  observed directly during this task's own live smoke (a REVIEW worker's
  ordinary go-time self-report left the control room dirty, and the very
  next invocation of this check fired the dirty-cycle warning). This is the
  concrete reason the `3h`/`12h` thresholds need the one-week observation
  window above, and also a reason the check's underlying premise
  ("dirty == suspicious") may need revisiting rather than just its numbers
  — a live dashboard that is _supposed_ to go uncommitted between cycles is
  a different shape of system than the "did someone forget to commit"
  failure this check was designed to catch.
- **Unresolvable commit time is treated as fail-open, not worst-case.** If
  the working tree is dirty but `lastCommitTimeFn` cannot resolve a last
  commit at all (an unborn repository with no commits yet, or a `git log`
  invocation that fails for any reason) — check ① emits **no warning**,
  matching the rest of this check's "confidence required to warn" posture
  (the same posture as the absent-control-room path returning vacuous `ok`,
  and `linear-sync.mjs`'s own fail-open philosophy). It does not assume the
  missing timestamp means "very old" and warn regardless; an unresolvable
  signal is treated the same as no signal.
- **mtime is a form heuristic, not a content check.** Like
  `status-fresh.mjs`'s own design note, comparing file mtimes says nothing
  about whether `PHASE-HANDOFF.md`'s _content_ still describes the current
  phase — a handoff edited five minutes ago to say something already
  wrong passes this check cleanly. It can only ever catch the "nobody
  touched this in a very long time" shape of staleness, not a fresh-but-
  incorrect one.
- **Claude-only trigger, same family as every other `Stop`-hook check
  here.** The intended `Stop` hook only ever fires on Claude Code's own
  turns; a Codex REVIEW/VERIFY session ending triggers no equivalent check.
- **Live activation is a human, one-time step, same convention as every
  other `Stop`/`PreToolUse` hook in this document.** This task's own scope
  explicitly excludes wiring this repository's real
  `.claude/settings.local.json` — see the CODER task's "라이브 활성화는 CODER
  스코프 아님" note and the coder result's explicit call-out.

## Stop hook blocking self-consumption (stop-blocking.mjs, HYK-131)

### Problem restated

Every `Stop`-hook check documented above (`status-fresh.mjs`,
`clear-safe-check.mjs`, `linear-sync.mjs`, `controlroom-fresh.mjs`) was
originally advisory-only: a confirmed failure surfaces as `exit 1`, which
Claude Code's `Stop` hook shows in the transcript but never actually
enforces. In practice this produced a "human = message bus" anti-pattern —
the warning lands only on the human's screen, and nothing makes the agent
that is actually responsible for the drift (ORCH, for `STATUS.md`/control-room
hygiene specifically) look at it or self-repair before ending its turn. This
was observed twice in a single day before this task was written.

### Rule

- **Role gate.** Blocking only ever applies when `HARNESS_ROLE === "ORCH"`.
  Every other role (`PM`/`CODER`/`REVIEW`/`VERIFY`) and an unset/unrecognized
  role pass through at `exit 0` unconditionally, with only an optional
  stderr diagnostic — never a block, and, for the two checks promoted below,
  no longer even the old advisory `exit 1`. `STATUS.md`/control-room hygiene
  is ORCH's to own; nagging every other role's turn about it was never this
  check's real audience.
- **Recursion guard.** Claude Code's `Stop` hook payload sets
  `stop_hook_active: true` on the re-invocation that follows a prior Stop
  hook's own block within the same turn. A promoted checker reads this from
  stdin (`readStopHookPayload`) and, if true, does **not** re-block — this is
  a one-shot self-repair opportunity, not an infinite retry loop.
- **Payload readability is itself a G3 judgment (review-1 fix).** Whether the
  Stop hook's own stdin payload is missing, empty, non-JSON, or JSON that
  doesn't parse to an object is _uncertain_, not a confirmed "no recursion":
  `readStopHookPayload` returns `{ ok, payload }` preserving that distinction
  instead of collapsing every failure into `{}`, and `resolveStopBlock`
  treats `ok: false` as `UNJUDGABLE` (`exit 0`, `reason_code:
stop_payload_unreadable`) — never blocking on an assumption about a
  payload it couldn't actually read. An independent review caught an earlier
  version of this adapter doing exactly that (malformed/empty stdin silently
  became `{}`, which then read as a valid non-recursive payload and reached
  `exit 2`); a real, well-formed `{}` payload (successfully parsed, simply
  empty) is unaffected and still eligible for blocking.
- **Fail-open unchanged.** The role gate and recursion guard sit **after**
  each checker's own pure function has already decided `ok`/`fail`; they
  never change what counts as a confirmed failure vs. an uncertain one. Every
  file-missing/parse-error/git-error/network-error case each checker already
  treated as fail-open (`ok: true`) is completely untouched by this adapter —
  G3's "`UNJUDGABLE` → `exit 0`" guarantee was true before HYK-131 and remains
  true after it, for the same reason (the pure check functions, not this
  adapter, are what decide that).
- **Reason format.** A confirmed block's stderr line carries four fields:
  `check_id`, `reason_code`, `repair_hint` (what ORCH should fix, one line —
  the checker's own human-readable reason, not re-summarized), and
  `attempt=1/1` (there is exactly one self-repair attempt per confirmed
  failure; the recursion guard is what makes this true rather than aspirational).

### Which checks were promoted, normalized, or left alone

| Check                   | Disposition                                         | Why                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clear-safe-check.mjs`  | **Promoted to ORCH-only blocking**                  | Receipt/attestation fields are ORCH's own to fill in — immediately self-repairable, and the confirmed-failure vs. fail-open split was already clean before this task.                                                                                                                                                                                                                                                                             |
| `controlroom-fresh.mjs` | **Promoted to ORCH-only blocking**                  | Dirty-cycle/handoff-staleness is ORCH's own control room to commit/refresh — same self-repair shape as clear-safe.                                                                                                                                                                                                                                                                                                                                |
| `linear-sync.mjs`       | **Normalized to advisory (`exit 1`, not blocking)** | A confirmed drift may mean `STATUS.md` is wrong, or it may mean Linear itself needs a human correction — not something ORCH can always self-repair alone, and this check depends on a live network call to a service outside this harness's control. This also **fixed a pre-existing contract drift**: the code exited `2` on a confirmed diff while every other reference to this check in this document already classified it Tier 2/advisory. |
| `status-fresh.mjs`      | **Left unchanged (still advisory, `exit 1`)**       | Staleness here can originate from a different worker or a human edit, not only from ORCH's own turn, and this task has no live evidence yet that ORCH-only blocking wouldn't misfire on that ambiguity. Revisit after the HYK-129 observation loop this task's design explicitly deferred to.                                                                                                                                                     |

### Implementation

- `scripts/check/stop-blocking.mjs` is the single shared adapter (not
  duplicated per checker, per this harness's own "one declaration" C.7
  convention): `isBlockingRole(role)`, `isRecursiveStop(hookPayload)`,
  `readStopHookPayload(fd) -> { ok, payload }` (stdin JSON parse; `ok: false`
  on missing/empty/malformed/non-object input — payload always `{}` in that
  case, but callers must check `ok` rather than trust the payload blindly),
  `formatBlockReason({ checkId, reasonCode, repairHint, attempt,
maxAttempts })`, and the single decision point `resolveStopBlock({ role,
hookPayloadResult, ok, checkId, reasonCode, repairHint }) -> { exit, reason
}` that every promoted checker's CLI calls once it already has its own
  `{ ok, reason }` verdict.
- `clear-safe-check.mjs` and `controlroom-fresh.mjs`'s CLI blocks each call
  `resolveStopBlock` after computing their existing `checkClearSafe`/
  `checkControlRoomFresh` result, passing that result's `reason` through
  unmodified as `repairHint` — the checker's own explanation of what's wrong
  doubles as ORCH's repair instruction, nothing is re-derived.
- `linear-sync.mjs` gained `resolveSyncExitCode({ staleInStatus,
missingInStatus, stateDrift }) -> 0 | 1`, a pure function extracted from
  the CLI's own inline exit-code logic so the drift-vs-clean contract is
  unit-testable without a live Linear API call; the fail-open paths (missing
  key, missing STATUS file, network error) are untouched and still exit `0`
  directly, before `resolveSyncExitCode` is ever reached.
- `scripts/check/stop-blocking.test.mjs` (`node:test`): role-gate matrix
  (ORCH vs. every other role/unset), recursion-guard behavior, the 4-field
  reason format, the full `resolveStopBlock` decision table (ok, role-gated,
  recursion-guarded, payload-unreadable, confirmed-block), and
  `readStopHookPayload` exercised against real file descriptors (`openSync`
  on a temp file, not a fake stdin) covering: valid payload, valid empty
  `{}` (the anchor — must stay `ok: true`, distinct from unreadable), malformed
  JSON, empty content, non-object JSON (array, `null`), and an already-closed
  fd.
- `clear-safe-check.test.mjs`/`controlroom-fresh.test.mjs` each gained
  CLI-level (`execFileSync`/`spawnSync` against the real script) cases
  covering: `HARNESS_ROLE=ORCH` + confirmed failure → `exit 2` with all four
  reason fields present; `HARNESS_ROLE=ORCH` + `ok` → `exit 0`; every
  non-ORCH role (including unset) + confirmed failure → `exit 0`;
  `HARNESS_ROLE=ORCH` + confirmed failure + `stop_hook_active: true` →
  `exit 0`, not re-blocked; an uncertain/fail-open input (missing STATUS
  file, absent control-room path) → `exit 0` regardless of role; and — the
  review-1 regression set — `HARNESS_ROLE=ORCH` + confirmed failure +
  malformed/non-JSON stdin → `exit 0` (`reason_code=stop_payload_unreadable`),
  same + empty stdin → `exit 0`, and same + a valid `{}` stdin → `exit 2`
  (the anchor confirming the fix didn't regress the original blocking path).
  `controlroom-fresh.test.mjs`'s CLI fixtures use a real temporary git
  repository (`git init`/`commit`, then an mtime bump) rather than the
  injected `git*Fn` functions the rest of that file's unit tests use, so the
  CLI's own default git-shelling path is exercised end-to-end — no write
  ever touches this repo or the real control room (G8's "OS temp only"
  posture).
- `linear-sync.test.mjs` gained unit tests for `resolveSyncExitCode` directly
  (clean → `0`; any of `staleInStatus`/`missingInStatus`/`stateDrift`
  individually or combined → `1`, never `2`) — a live-network CLI exec test
  was deliberately not added here, since exercising the real drift path would
  require either a live Linear API call or mocking global `fetch`, neither of
  which this task's scope covers.

### Known limitations (honesty notes)

- **Claude-only, same as every check this adapter sits behind.** The `Stop`
  hook is a Claude Code mechanism; a Codex-driven PM/REVIEW/VERIFY session
  ending triggers no equivalent event at all, so this adapter's role gate
  never even gets a chance to run for those sessions through this path —
  they are unaffected for an entirely separate reason than "role gate said
  no."
- **Stop-hook-time only, not continuously enforced.** Exactly like every
  other checker in this document, this only judges the state of
  `STATUS.md`/the control room at the moment a Stop hook fires. A drift that
  appears and is fixed within the same turn, or between Stop invocations, is
  invisible to it.
- **Tier 2 ceiling, not a gap this task closes.** Promoting a check to
  `exit 2` changes its _severity for ORCH_, not its _substrate_: there is
  still no external anchor (no CI, no branch protection) that can force this
  hook to run at all. An operator or agent with shell access can remove the
  `Stop` hook wiring from `.claude/settings.local.json`, unset
  `HARNESS_ROLE`, or edit `stop-blocking.mjs` itself, and nothing here
  detects any of that — the same trust boundary as role-guard's own honesty
  note.
- **One self-repair attempt, not a guarantee of repair.** The recursion
  guard prevents an infinite block loop, but it does not verify ORCH actually
  fixed anything on the re-invocation — a `stop_hook_active: true` turn
  passes through at `exit 0` regardless of whether the underlying condition
  is still broken. A second, still-unresolved failure is silently allowed
  through rather than surfaced again; this is a deliberate trade (favor
  forward progress over an unbounded block loop), not an oversight, but it
  does mean a persistently-broken ORCH turn can end without the human ever
  seeing a second reminder in that same turn.
- **Live Claude Stop-hook canary not run by this task.** This cycle's scope
  (per the approved design, gate ID `G12`) covers the adapter, the two
  promotions, the advisory normalization, and unit/CLI-process-level tests
  only — an actual Claude Code session hitting a real confirmed failure and
  observing the model receive and act on the `exit 2` feedback (the "bad →
  1 self-repair attempt → good" live loop) is explicitly deferred to an
  ORCH-run isolated canary in a later cycle, per the approved design's own
  ordering (§4/§5 of the design doc this task cites). Until that canary runs
  and its receipt is recorded, this adapter's live behavior is verified only
  at the CLI-process level (a real `node` child process with a real stdin
  payload and env var), not through an actual Claude Code `Stop` hook
  invocation.
- **`status-fresh.mjs` deliberately not promoted in this round.** See the
  table above — this is an open item for a future cycle, not an omission.

## Enforcement-layer self-check (selfcheck.mjs, HYK-129 사이클 2)

### Problem restated

Every check documented above is only as real as its installation: a script
can exist, pass its own unit tests, and still be silently unwired from the
settings file that was supposed to invoke it (a hand-edited
`.claude/settings.local.json`, a rename that broke a `command` string, a
fresh clone that never ran `install.mjs`). Nothing in this document, before
this task, ever verified the _installed_ state against a single source of
truth — each check's own docs section describes intent, not a live audit.
HYK-129 exists to close that gap: a periodic, mechanical run that confirms
what's actually wired, actually fires, and actually behaves as documented,
rather than trusting the prose above to still be accurate.

### Rule

- **One manifest, `scripts/check/enforcement-inventory.json`.** Every
  check/hook/gate/install-target this document describes has exactly one
  entry: `id`, `substrate`, `script`, `test`, `install_targets` (placeholder
  paths — `REPO/...`, `CONTROL_ROOM/...`, `USER_HOME/...` — never a
  machine-specific absolute path), `expected_bad`/`expected_good`,
  `failure_exit`/`uncertain_exit`, `owner`, `claude_only`. Native git hooks
  and CI additionally carry `known_drift_note` where a drift is already
  known and deliberately left unresolved by this task's own scope (§ below).
- **Five judgment values, fixed.** `ALIVE` / `SILENT_BROKEN` / `DRIFT` /
  `UNJUDGABLE` / `NOT_INSTALLED` — never a sixth value, never a boolean.
  `SILENT_BROKEN` means the check is wired but its own script (or, for a
  source-referenced check, its caller) no longer exists/references it;
  `DRIFT` means wired but disagreeing with the manifest in some other way
  (hash mismatch, matcher mismatch, a CI suite the workflow doesn't run);
  `NOT_INSTALLED` means a required install target is simply absent;
  `UNJUDGABLE` means this runner cannot tell either way (settings unreadable,
  or — for every `claude_only` entry — no fresh canary receipt).
- **A Claude-only check is never ALIVE from static wiring alone (G9).**
  Confirming a hook _entry_ exists in a settings file proves intent to wire
  it, not that Claude Code ever actually invoked it. `role-guard`, `pm-guard`,
  `status-fresh`, `clear-safe-check`, `linear-sync`, `controlroom-fresh`,
  `context-inject`, and `worker-status-onstart` all require a fresh (≤8 day)
  canary receipt (`<canaryDir>/<id>.json`, fields `check_id`/`checked_at`/
  `bad_exit`/`good_exit`) to reach `ALIVE`; missing/stale/mismatched →
  `UNJUDGABLE`. This runner does not itself produce that receipt — see
  "Known limitations" below.
- **Temp-fixture smoke, zero real-repo writes (G8).** `selfcheck-smoke.mjs`
  exercises the CLI-runnable checks (`clear-safe-check`, `controlroom-fresh`,
  `status-fresh`, `relay-handshake`, `pm-snapshot-gate`) against real,
  OS-temp-only fixtures, and the two that can't be driven through their real
  CLI without a fixture-path override or a live network call
  (`review-gate`, `linear-sync`) via their exported pure functions instead —
  still real check logic, just invoked in-process. Every run snapshots
  `git status --short` before and after; the report's receipts section
  records whether that diff was zero.
- **Detection only, not repair.** This task's scope is explicitly to _find_
  drift, not fix it — the three drifts already known before this task began
  (pre-commit/gitleaks not installed in `.git/hooks`, CI running only 6 of
  this repo's `scripts/check/*.test.mjs` suites, and — resolved mid-cycle by
  HYK-131 — `linear-sync`'s exit-code contract) are left exactly as found;
  `selfcheck.mjs`'s job is to surface them in every run's report, not to
  silently fix or silently stop reporting them.

### Implementation

- `scripts/check/enforcement-inventory.json` — 14 entries (§1.2 of the
  HYK-129/131 design report, verbatim): `review-gate`, `pre-commit-gitleaks`,
  `role-guard`, `pm-guard`, `status-fresh`, `clear-safe-check`,
  `linear-sync`, `controlroom-fresh`, `context-inject`,
  `worker-status-onstart`, `relay-handshake`, `pm-snapshot-gate`,
  `packet-gate`, `ci-enforce`.
- `scripts/check/selfcheck-inventory.mjs` — pure functions:
  `parseHookCommands`/`extractCheckScriptId` (settings JSON in, hook
  commands out — only `matcher`/`command` are ever read, never any other
  settings field, so no secret/env value can leak through this path);
  `findInstalledTarget`/`findExtraInvocations` (G6 missing/extra);
  `checkNativeGitHook` (G7, sha256 comparison, `core.hooksPath`-aware
  caller); `checkCanaryReceipt` (G9); `checkSourceReference` (packet-gate's
  indirect wiring — verified by grepping `role-guard.mjs`'s own source for
  the import, not a settings file); `checkCiCoverage` (every
  `scripts/check/*.test.mjs` basename discovered on disk, not just the ones
  named in the manifest, must appear in `enforce.yml`'s text);
  `combineStatuses` (worst-first severity pick); `judgeEntry`/`runInventory`
  (per-entry and whole-manifest orchestration, every filesystem/settings
  read an injectable parameter with a real default — same convention as
  `status-fresh.mjs`/`controlroom-fresh.mjs`).
- `scripts/check/selfcheck-smoke.mjs` — one `smoke<Check>()` function per
  CLI-runnable check, each self-contained (creates and tears down its own
  `mkdtempSync` fixture, including a real temporary `git init` repo for
  `controlroom-fresh`), returning `[{ id, variant: 'bad'|'good', expectedExit,
actualExit, pass, evidence }]`; `captureGitStatus`/`runSmokeSuite` wrap all
  seven checks' cases together with a before/after `git status --short` diff
  (G8).
- `scripts/check/selfcheck-report.mjs` — `buildReport(...)` renders the
  design report §7 skeleton verbatim (`run_id`/`task_id`/`captured_at`/repo
  HEAD/runtime versions/`next_due`, 5-state summary, inventory table, smoke
  table, drift table, limitations, receipts) as pure markdown text from
  in-memory data only (G10) — no file I/O inside the builder itself;
  `writeReport` is the one function that touches disk.
- `scripts/check/selfcheck.mjs` — the single entry point (`inventory →
smoke → report`, no model call, one command): resolves the real repo
  root/control room/user home, loads the four real Claude settings files
  (repo, control room, `~/.claude-team`, `~/.claude`) it can find, runs
  inventory + smoke, and writes `.harness/selfcheck-report.md` (overridable
  via `--output`). `buildLimitations`/`buildReceipts` assemble the report's
  honesty sections from the run's own actual UNJUDGABLE entries and failed
  smoke cases, not a static boilerplate list — a run with different results
  produces a different limitations section.
- Each module ships its own `.test.mjs` (S3), case count deliberately not
  pinned here — `node --test scripts/check/<name>.test.mjs` is the one
  source of truth for how many cases each file currently has, and a fixed
  number in prose goes stale the moment a future round adds or removes a
  case (this exact staleness was caught live during this task: a prior
  version of this note said "37 cases" for `selfcheck-inventory.test.mjs`
  right after a different round had already brought it to 42):
  `selfcheck-inventory.test.mjs` (entirely synthetic fixtures — G6/G7/G9's
  own required coverage), `selfcheck-smoke.test.mjs` (real subprocess/
  pure-function execution against this repo's actual scripts, ending with a
  full `runSmokeSuite` real-repo run asserting `zeroDiff === true`),
  `selfcheck-report.test.mjs` (schema test over `REPORT_SECTIONS`),
  `selfcheck.test.mjs` (two of its cases run the real, full
  `inventory → smoke → report` pipeline against this repo's own manifest.
  Neither asserts a _specific_ live status for any entry — a round of this
  task originally asserted `pre-commit-gitleaks → NOT_INSTALLED` and
  `ci-enforce → DRIFT` literally, and that assertion broke the same day a
  human installed the `pre-commit` hook mid-cycle (live state changed out
  from under a test that had pinned one point-in-time reading as if it were
  permanent). The corrected version asserts only what must always hold
  regardless of live state: every entry resolves to one of the 5 fixed
  status values with non-empty evidence, and the `pre-commit-gitleaks`/
  `ci-enforce` entries are present in the results at all — never which
  status they currently carry).

### Live run (this task, read-only against the real repo)

`node scripts/check/selfcheck.mjs` was run for real against this repository
(not a fixture) — see the CODER result (`.harness/coder.md`,
HYK-129-coder-1) for the exact summary counts and the generated
`.harness/selfcheck-report.md` for the full report. No write ever touched
anything but that one output file; `git status --short` before/after the
smoke suite's portion of that run was identical (G8).

### 사이클 3 — CI 전수화(G5) + 8일 신선도 경고 (selfcheck-freshness.mjs)

- **G5, `ci-enforce`'s DRIFT resolved by construction, not by updating a
  list.** `enforce.yml`'s per-file fixed steps (`review-gate tests`,
  `relay-handshake tests`, ...) are replaced with a single glob step,
  `node --test scripts/check/*.test.mjs` — every current and future
  `scripts/check/*.test.mjs` file runs in CI without anyone editing this
  workflow again. `checkCiCoverage` (`selfcheck-inventory.mjs`) was updated
  to recognize this glob shape (`scripts/check/*` + `.test.mjs`, any
  directory-scoped glob) as covering every discovered test file, rather
  than searching for each file's literal basename substring in the workflow
  text (which would have misjudged a glob-based workflow as missing
  everything). A glob scoped to a _different_ directory does not count —
  verified by a dedicated synthetic case.
- **`selfcheck-freshness.mjs` — the selfcheck tool auditing its own
  bootstrap gap (PM 보고서 §6 [실행필요]).** A pure `checkSelfcheckFreshness`
  function reads `.harness/selfcheck-report.md`'s `captured_at` field and
  reports `fresh: false` (with a specific cause — absent, malformed, or
  older than 8 days) or `fresh: true`. The CLI is a `SessionStart` hook:
  when not fresh, it emits a `hookSpecificOutput.additionalContext` warning
  (the same JSON shape `context-inject.mjs`'s session-start mode uses) so
  the warning actually reaches a fresh session's visible context, not just
  its own stdout; when fresh, it logs a plain one-line confirmation. It
  **never blocks** (`process.exit(0)` unconditionally) — a stale self-audit
  is a reminder to re-run `selfcheck.mjs`, not a reason to stop a session
  from starting.
- **Self-registration.** `enforcement-inventory.json` now carries a
  `selfcheck-freshness` entry pointing at its own intended `SessionStart`
  install target — the selfcheck tool audits its own wiring the same way it
  audits every other check's, partially closing the "who checks the
  checker" gap this document's earlier round left open.
- **Weekly operating protocol (PM 보고서 §6 [즉시] 결정, verbatim).** A
  single human line, "주간 점검," on the same Sunday boundary HYK-123
  already uses, triggers ORCH to run **HYK-123 then HYK-129** back to back;
  each keeps its own `task_id`, result, failure state, and next-due date —
  the two reports are never merged into one. If HYK-129's run comes back
  red, the implementing relay for that week's other work does not open
  until the enforcement layer itself is repaired first. A skipped week is
  logged as `MISSED_TRIGGER`, never retroactively marked as a success —
  there is no Task Scheduler or other automatic trigger; the human's one
  line and ORCH's own distribution/receipt-collection are the entire
  mechanism.

### Known limitations (honesty notes)

- **This runner cannot itself produce a canary receipt.** `checkCanaryReceipt`
  reads one if given a directory; nothing in this task's scope makes one —
  that requires an actual isolated Claude Code session hitting a real Stop/
  PreToolUse/UserPromptSubmit event and recording the observed exit codes,
  which only a Claude-driven ORCH turn (not this Codex-runnable script) can
  do. Every `claude_only` entry is `UNJUDGABLE` on a run with no
  `--canary-dir`, by design, not by omission.
- **Local, removable, same trust boundary as every check in this document.**
  An operator or agent with shell access can edit
  `enforcement-inventory.json` to match whatever is currently installed
  (making every entry trivially `ALIVE`), remove a hook from
  `.claude/settings.local.json`, or simply never run `selfcheck.mjs` at all.
  Nothing here is cryptographically enforced or externally anchored — this
  is a Tier 2 mechanism through and through, same ceiling as `linear-sync.mjs`/
  `controlroom-fresh.mjs`.
- **Does not run itself (bootstrap limitation).** There is no scheduler
  invoking `selfcheck.mjs` on a cadence; it depends entirely on a human
  weekly trigger (paired with HYK-123's own Sunday-boundary loop, per the
  design report's §6) or an ORCH boot-time reminder once the last successful
  run crosses 8 days. A skipped week is recorded as `MISSED_TRIGGER`
  wherever the weekly runner (HYK-129 사이클 3+) logs it — this task does not
  build that scheduler, only the tool the scheduler is meant to invoke.
- **`review-gate`/`linear-sync` smoke bypasses their real CLI.** See "Rule"
  above — this is a deliberate, documented substitution (pure-function
  in-process call instead of a subprocess), not a silent gap; a future task
  could close it by adding a fixture-path override to `review-gate.mjs`'s
  CLI or a `fetch`-mockable seam to `linear-sync.mjs`'s, but this task does
  not do either.
- **Inventory status is a live reading, not a fact frozen into this
  document — see `.harness/selfcheck-report.md` for the current one.** At
  this task's first baseline run (2026-07-13), `pre-commit-gitleaks` read
  `NOT_INSTALLED` and `ci-enforce` read `DRIFT` (workflow missing several of
  this repo's `scripts/check/*.test.mjs` suites); both were carried-forward
  drifts, not new findings (documented in the HYK-129/131 design report's
  own diagnosis). `pre-commit-gitleaks` then flipped to `ALIVE` the same day
  when a human installed the hook mid-cycle — direct, immediate evidence
  that a specific status literal in prose goes stale the moment live state
  changes, which is exactly why the test suite documented above stopped
  asserting one. `ci-enforce`'s CI-coverage gap itself was closed in
  사이클 3 (the glob step above) — this document deliberately does not
  repeat a literal suite count (e.g. "6/14" or any other N/M) anywhere,
  because the set of `scripts/check/*.test.mjs` files, and therefore any
  such fraction, grows with every task that adds one, including this one;
  `node --test scripts/check/*.test.mjs`'s own output is the only number
  that can't go stale in prose.
- **Claude-only, Stop/PreToolUse/UserPromptSubmit-event-scoped, same as
  every check this manifest describes.** A Codex-driven PM/REVIEW/VERIFY
  session triggers none of the hook events this inventory checks for at
  all — this selfcheck tool itself is engine-agnostic (runs fine under
  Codex), but what it _measures_ (whether Claude's hooks fired) is not.
- **`selfcheck-freshness.mjs`'s own `SessionStart` wiring is NOT live as of
  this task.** Writing to this repository's real `.claude/settings.local.json`
  was attempted and explicitly declined by this session's own permission
  classifier, on the same "self-modifying live hook settings is a human,
  one-time, per-clone step" convention this document has stated for every
  other hook since D6/`status-fresh.mjs` — the classifier enforced that
  convention even when a signed task packet asked for the change, which is
  the intended behavior of that guardrail, not a bug. The manifest's
  `selfcheck-freshness` entry therefore honestly reads `NOT_INSTALLED` until
  a human adds the one line documented in this task's CODER result
  (`.harness/coder.md`, HYK-129-coder-5) to `.claude/settings.local.json`'s
  `SessionStart` array.
- **`selfcheck-freshness.mjs` checks a timestamp field, not the report's
  content.** Like `status-fresh.mjs`'s own mtime-based design note, a fresh
  `captured_at` says only that `selfcheck.mjs` ran recently — it says
  nothing about whether that run's findings were acted on, or whether the
  report itself was hand-edited to look fresher than it is (same local
  trust boundary as everything else in this section).

## E — PM lane enforcement (pm-guard + packet-gate + role-guard E4/E2ⓑ, HYK-121)

### Problem restated

HYK-121 introduces a fifth role, **PM** (planning-only), whose lane is the
control room (`D:\문서관리\하네스-관제실\`), never this repository and never
Linear directly. Its output is a **delegation packet** that the Orchestrator
only consumes once a human has signed the packet's `승인:` (approval) line —
without a mechanical check, nothing stops a PM session from writing into the
repo by accident, calling a Linear write tool directly, or an unsigned packet
being silently treated as if approved. This section is three enforcement
points implementing PM-에이전트-설계.md §7 (E1, E2/E2ⓑ, E4).

### E1 — `pm-guard.mjs`

A PreToolUse hook, same contract shape as `role-guard.mjs`: reads the hook's
JSON payload from stdin, `exit 0` to allow, `exit 2` + reason on stderr to
block.

- No-op (`exit 0`) unless `HARNESS_ROLE === "PM"` — this guard regulates only
  PM sessions; every other role is role-guard's concern.
- Blocks any call to a Linear write MCP tool matching
  `mcp__(linear-server|claude_ai_Linear)__(save_|create_|delete_)` outright —
  PM proposes via a packet, it does not commit to Linear itself.
  **HYK-267/HYK-273**: originally this regex named only `linear-server`; a
  real audit found `mcp__claude_ai_Linear__save_issue` (a second MCP
  connector exposing the same write surface) sailed through unblocked,
  because nothing in the repo referenced `claude_ai_Linear` at all. This is
  now the **2nd-layer** defense (name-matching, principled-incomplete — see
  the code comment on `LINEAR_WRITE_TOOL_RE` in `pm-guard.mjs`), not the
  primary one. The **1st layer** is keeping the PM session's own MCP config
  empty at launch (Claude: `--strict-mcp-config` + `{"mcpServers":{}}`) so no
  `mcp__*` tool exists to call in the first place — see "Known limitations"
  below for why that layer is a launch argument, not an anchor this repo can
  verify, and §HYK-267 below for the codex-side findings.
- For a write-family tool (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`) with a
  file path, the path is normalized (`path-normalize.mjs`'s
  `normalizeAbsolute` — the same backslash/WSL (`/mnt/c/...`)/Git-Bash
  (`/c/...`) handling `role-guard.mjs` uses, extracted to a shared module so
  the two guards can't silently diverge on path handling; pinned equal by
  `role-guard.test.mjs`'s existing WSL/Git-Bash/backslash cases plus
  `pm-guard.test.mjs`'s own (11)-(13)) and allow-listed against exactly two
  things: under the control room root (`D:/문서관리/하네스-관제실`), or a path
  containing `AppData/Local/Temp/claude/` (this harness's scratchpad
  convention). Everything else is denied.
- A missing/malformed PreToolUse payload fails open (`exit 0` with a stderr
  warning), matching `role-guard.mjs`'s own posture.

### E2 — `packet-gate.mjs`

`export function checkPacketGate({ packetPath }) -> { ok, reason }` parses
the packet file's `승인:` line and accepts exactly one signed form (per
`PM\템플릿\위임패킷-템플릿.md`): `승인: OK <이름> YYYY-MM-DD HH:MM`. Every other
case is a distinct rejection reason: the unsigned placeholder (`승인: ☐`), a
malformed signature (e.g. missing the time component), no `승인:` line at
all, or the file not existing. CLI: `node packet-gate.mjs <packet-path>` —
exit `0`/`1` with the reason on stdout/stderr.

### E2ⓑ — role-guard packet directive gate

`role-guard.mjs`'s `checkRoleWrite` now runs a packet check **before** its
existing "outside the repo root is unregulated" early return, because a
packet-sourced task drop can land anywhere a `*-task.md` file can be written —
this repo's `.harness/`, another repo's `.harness/` (e.g. a TEAM10 drop), or
the control room's `PM\relay\`. The check:

1. Only fires when the write target's **basename** matches `*-task.md`
   (location-independent — not scoped to `.harness/`).
2. Reads the write's content from `tool_input.content ?? tool_input.new_string`
   (covers `Write` and `Edit`; `MultiEdit`'s per-edit array is out of scope,
   by spec).
3. Looks for a `/^packet:\s*(\S+)/m` line. No line → not gated, falls through
   to normal role logic unaffected.
4. A value starting with `(` (e.g. `(없음 — 사람이 PM 설계 3승인으로 직접
발주)`) is a narrative aside, not a path reference, and is skipped — this
   is what keeps a task file's own descriptive header (like this task's own
   `coder-task.md`) from being misread as a dangling packet reference.
5. A non-absolute `packet:` value is rejected outright (`packet: 경로는
절대경로` — relative packet references are never trusted).
6. Otherwise `checkPacketGate({ packetPath })` runs; an unsigned/invalid
   packet blocks the task drop itself (`exit 2`), before the task ever
   reaches a worker.

### E4 — role-guard `KNOWN_ROLES` gains `PM`

`KNOWN_ROLES` now includes `"PM"`. Once a write is confirmed inside the repo
root, `role === "PM"` is an unconditional deny — reason: "PM may not write
inside the repo; PM lane = control room." This is deliberately a second,
independent line of defense: if a PM session is ever opened with the wrong
cwd (inside this repo instead of the control room), pm-guard's control-room
allow-list would already deny it, but E4 catches the same mistake from
role-guard's side too, the same "defense-in-depth, not substitutes for each
other" posture as every other guard pair in this document.

### Implementation

- `scripts/check/path-normalize.mjs` (new): `toDriveStyle`, `normalizeAbsolute`,
  `normalizeToRepoRelative` — extracted verbatim from `role-guard.mjs`'s
  original private helpers so `pm-guard.mjs` can reuse the identical
  WSL/Git-Bash/backslash normalization without a second, potentially
  drifting implementation. `role-guard.mjs` now imports from this module;
  its own 28-case test suite passing unchanged after the extraction is the
  regression check that the refactor didn't alter behavior.
- `scripts/check/pm-guard.mjs` (new), `scripts/check/packet-gate.mjs` (new),
  `scripts/check/role-guard.mjs` (extended) — each with a `.test.mjs`
  (`pm-guard.test.mjs` 15 cases, `packet-gate.test.mjs` 9 cases,
  `role-guard.test.mjs` grown from 28 to 39 cases covering E4 and E2ⓑ).

### Live smoke (this task, manual reproduction of 3 PreToolUse payloads)

```
echo '{"tool_name":"Write","tool_input":{"file_path":"C:/Users/Administrator/Documents/HARNESSENGINEERING/.harness/coder-task.md","content":"x"}}' | HARNESS_ROLE=PM node scripts/check/pm-guard.mjs
# -> exit 2: "pm-guard: PM may not write '...' — allow-list = control room (...) + scratchpad only"

echo '{"tool_name":"Edit","tool_input":{"file_path":"D:/문서관리/하네스-관제실/STATUS.md","new_string":"x"}}' | HARNESS_ROLE=PM node scripts/check/pm-guard.mjs
# -> exit 0

echo '{"tool_name":"Write","tool_input":{"file_path":".harness/coder-task.md","content":"task_id: X\npacket: <unsigned packet path>\n"}}' | HARNESS_ROLE=ORCH node scripts/check/role-guard.mjs
# -> exit 2: "role-guard: task drop blocked — unsigned/invalid packet '...': packet-gate: packet not yet approved (승인: ☐) in ..."
```

All three reproduced exactly as expected; see `.harness/coder.md`
(HYK-121-coder-1) for the raw run log.

### Control room installation (human, one-time — not done by this task)

Same convention as every other locally-installed hook in this document
(role-guard, status-fresh, controlroom-fresh): the script is version-controlled
here, but wiring it into a live session's `settings.local.json` is a human,
per-install step, done once in the **control room's own** settings (not this
repo's), since that is where PM sessions actually run:

`D:\문서관리\하네스-관제실\.claude\settings.local.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|mcp__linear-server__.*|mcp__claude_ai_Linear__.*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/Users/Administrator/Documents/HARNESSENGINEERING/scripts/check/pm-guard.mjs\""
          }
        ]
      }
    ]
  }
}
```

### Known limitations (honesty notes)

- **Claude-only, same family as role-guard/status-fresh/controlroom-fresh.**
  `pm-guard.mjs` and E4 are both Claude Code `PreToolUse` hooks — they only
  ever see Claude's own tool calls. §6's model routing already documents the
  consequence directly: a PM session run on **codex sol** (the recommended
  engine for B2/B3 diagnostic work) has no pm-guard/E4 coverage at all. The
  mitigation is structural, not a patch to this guard: **packet-gate (E2)
  runs on the ORCH side of the handoff**, so the human-signature requirement
  holds regardless of which engine produced the packet — the E2 gate does
  not care who PM was.
- **codex's own sandbox does not itself block a sol-PM session's repo
  writes — measured, not assumed.** A 2026-07-13 real-world probe (HYK-125,
  see the control room's `PM\산출물\하네스\2026-07-13-샌드박스실측\보고서.md`
  and the signed `PKT-20260713-sol-pm-sandbox-boundary`) had a sol-PM session
  attempt `apply_patch` against a path **outside** its declared
  `writable_roots` (a gitignored repo canary file, not the PM-output/relay
  paths that config section names) — the write **succeeded**. This
  contradicts the assumption that "codex's sandbox mechanically enforces
  `writable_roots`" would have been a second, engine-side backstop to the
  two guards above; it is not. The exact cause is unmeasured and this
  document does not claim one (a `sandbox_workspace_write` config value not
  actually applied to that session, permission composition, or a
  tool-specific boundary all remain open) — what is measured is only the
  outcome: a repo write outside the declared root went through. Concretely,
  and each limb below stated separately rather than bundled, because the
  two guards above cover genuinely different, narrower ground than "sol-PM
  repo writes are blocked" would suggest (pm-1 보고서 §7):
  - **`pm-guard` is Claude-only** — it is a Claude Code `PreToolUse` hook (see
    the first bullet above), so a **sol** (codex) PM session has no
    `pm-guard` coverage at all, not reduced coverage — the guard simply never
    runs in that engine.
  - **`packet-gate` only governs the packet-derived handoff, not a direct
    repo write.** It checks a signed `승인:` line on a _packet file_ before a
    packet-sourced `*-task.md` drop is accepted (E2/E2ⓑ above); it has no
    hook into, and does not inspect or block, a PM session's own direct
    `apply_patch`/`Write`/`Edit` calls against this repo.
  - **Therefore sol-PM's direct-repo-write prohibition is, as of this
    writing, convention only — no mechanical anchor enforces it.** Neither
    guard actually stops the write this probe demonstrated; "not `codex
sandboxing`" (the corrected framing above) is not replaced by "pm-guard
    and packet-gate instead" for this specific failure mode — both of those
    are real mechanisms for the different things they actually check, but
    neither is a backstop for a sol-PM session's direct repo write, and this
    document should not imply otherwise.
- **A missing `packet:` line is not detectable.** E2ⓑ only fires when the
  task file's content actually contains a `packet:` line — if whoever drops
  a packet-derived task simply forgets to write that line, nothing here
  notices the omission; the task drop proceeds ungated. The mitigation is
  the same convention-level one PM-에이전트-설계.md §7 names: a full-scope
  review card item asking "출처 packet 확인" (packet provenance confirmed).
- **Signature forgery is possible in principle.** `승인: OK <이름> <시각>` is a
  plain-text pattern match, not a cryptographic signature — anyone with
  shell/filesystem access to the packet file (the same OS user running the
  agent) can type that line by hand without a human having actually signed
  off. This is the same residual class already recorded for HYK-89
  (isolated-runner enforcement, deferred) and for D2's `role: REVIEW-*`
  marker above: the real anchor is the human reading the packet and typing
  the signature themselves, plus the control room's own git history as an
  audit trail — not something a local hook can make airtight.
- **`settings.local.json` itself is a local, operator-owned file.** Same
  trust boundary as role-guard's own settings wiring: an agent or operator
  with shell access could edit or remove the PreToolUse entry, and nothing
  here detects that tampering. Mitigated the same way role-guard already is
  — human installation and ownership convention, not a stronger guarantee.

### E-follow — HYK-267: MCP Linear-write blocking, "believed blocked" vs "measured blocked"

Prompted by "believing a gate blocks something isn't the same as it actually
blocking it" (this round's guiding line). HYK-273's gap (§E1 above — the
missing `claude_ai_Linear` prefix) is the concrete instance; this
subsection is the broader measurement work that gap triggered: what's
actually blocked today, what mechanism can block the other seats, and how to
_prove_ a block instead of assuming one.

**Two-layer model (applies to every mcp\__-tool-name guard in this repo, not
just pm-guard):**

1. **1st layer — empty MCP config at launch.** No `mcp__*` tool exists to
   call. This is the only layer that closes the _class_ of connectors, known
   or not-yet-known.
2. **2nd layer — tool-name matching** (`pm-guard.mjs`'s `LINEAR_WRITE_TOOL_RE`,
   this manifest's `matcher`). Catches exactly the prefixes someone has
   already enumerated. Principled-incomplete by construction — see the code
   comment in `pm-guard.mjs`.

Layer 1 is a **Claude seat launch argument** (`--strict-mcp-config` +
`{"mcpServers":{}}`), confirmed live only for the **claude worker seat**
(§1-2 of this task's `.harness/coder-task.md`). It is not a config file this
repo can read — it is process-argv at spawn time, chosen by the control
room's seat launcher, outside this repo and outside this task's write scope.

**ORCH's own Linear-read need (condition ② resolution, decided by the
responsible party, quoted verbatim):**

> _"이슈 본문이 필요하면 나에게 요청하라. 내가 받는함이나 지시문에 실어 주겠다.
> 오히려 이쪽이 정본 경로가 더 분명하다."_
> (If the issue body is needed, ask me for it — I'll deliver it via inbox or
> instruction. That's actually a clearer path of record than a live MCP read.)

Concretely, ORCH's own launch line should carry the same empty-MCP-config
argument as the claude worker seat (`--strict-mcp-config` +
`{"mcpServers":{}}` for a Claude-engine ORCH seat). This task does not edit
the control-room launcher (out of scope, §4) — this paragraph is the text
for the human/ORCH to apply; no functionality is lost because §1-2 already
established ORCH makes zero MCP calls in this repo (all `mcp__` references
are guard code/config/tests, never a live call — `linear-sync.mjs` talks to
Linear over a direct `fetch()` + `LINEAR_API_KEY`, not MCP).

**codex-side blocking mechanism (condition ④, §3-3 — read-only CLI/config
survey, nothing executed against a live PM/REVIEW session):**

- `codex --help` has no `--strict-mcp-config`-equivalent global flag.
- `codex mcp list --json` on this machine shows a live, **enabled** MCP
  connector named `linear-server` (`auth_status: not_logged_in` in this
  sandbox, but `enabled: true`) plus a separate, already-disabled `linear`
  entry (`enabled: false`). This confirms §1-2's "codex 좌석은 미차단"
  claim concretely: codex's own Linear MCP connector is live and enabled
  today, not merely un-audited.
- **A real per-invocation disable mechanism does exist**:
  `codex exec -c 'mcp_servers.<name>.enabled=false'` (repeatable, one `-c`
  per server) suppresses that server for the invocation. Measured, not
  assumed — see the discriminating procedure below; a blanket
  `-c 'mcp_servers={}'` override does **not** work (the baseline connection
  attempt still fires), so the override must name each server individually.
- **A persistent, config-file-level anchor also exists**: `codex`'s MCP
  server list lives in `%USERPROFILE%\.codex\config.toml` under
  `[mcp_servers.<name>]` stanzas (unlike Claude's launch-argument-only
  block). The already-disabled `linear` entry there carries `enabled = false`
  directly in that file; the currently-active `linear-server` entry (added
  under a `# BEGIN/END OMC MANAGED MCP REGISTRY` block) does not. This is a
  **harder anchor than Claude's launch argument** (§3-4) — a settings file,
  not an ephemeral argv — but this task does not edit it (§4: "codex
  계정·설정 변경 0", human/account territory); this paragraph is a finding
  for the human to act on, not an action taken.
  ⚠️ **Side finding, not this task's scope, flagged here for the record
  without reproducing the value**: that `config.toml` `linear-server` stanza
  stores its Linear API bearer token in plaintext inside the config file
  (an `Authorization` header value under
  `[mcp_servers.linear-server.headers]`). This task does not print, copy, or
  act on that value anywhere (chat, file, or commit) — flagging its
  _existence_ only, since it is directly adjacent to what this round
  measured and a live credential sitting in a plaintext config file is a
  standing exposure independent of the MCP-block question. No action taken;
  human decision required (rotate/move to a secret store, or accept as
  already-scoped local-machine risk).
- **No repo-side checkable anchor exists for either engine today.** Neither
  Claude's launch argument nor codex's `config.toml` stanza is something
  this repo's checkers can read without a path to that file being passed in
  (Claude: not a file at all; codex: a per-user-home file this repo has no
  standing reason to read outside of this measurement). A `seat-preflight`-
  style checker (same family as `hook-sync-check.mjs`/`seat-preflight.mjs`)
  that reads `%USERPROFILE%\.codex\config.toml` and asserts
  `mcp_servers.linear-server.enabled == false` is buildable in principle —
  not built in this round (would require the human decision above on the
  credential finding first, and a decision on where such a checker's
  install target belongs; flagged for a follow-up task, not invented here).

**Discriminating measurement procedure (§3-5/§6 — every command below
distinguishes "blocked" from "not blocked" by producing a _different_
observable in each state, closing the gap named in `.harness/coder-task.md`
§1-5's table of five failed prior attempts, all of which returned the same
value regardless of block state):**

1. **codex seat — per-invocation block, discriminating via transport error
   presence:**
   ```
   # baseline (server enabled, default config) -- expect AuthRequired transport errors on stderr
   codex exec --json "just say hi, do not call any tools"

   # blocked (per-invocation override) -- expect NO AuthRequired transport errors
   codex exec -c 'mcp_servers.linear-server.enabled=false' -c 'mcp_servers.linear.enabled=false' -c 'mcp_servers.node_repl.enabled=false' --json "just say hi, do not call any tools"
   ```
   Discriminating because the baseline run's stderr contains
   `rmcp::transport::worker: worker quit with fatal: ... AuthRequired` lines
   (the MCP client actually attempted a connection) and the override run's
   does not — the _presence_ of that line is the go/no-go signal, not
   `mcp_servers` count or tool-name grep (both of which return 0 in either
   state per the coder-task.md §1-5 table, i.e. non-discriminating).
2. **codex seat — server enumeration (static, discriminating via
   `enabled` field, not presence/absence):**
   ```
   codex mcp list --json
   ```
   Discriminating because a disabled server still appears in the list
   (`"enabled": false`) — checking for the _name's absence_ would be
   non-discriminating (name stays either way); checking the `enabled`
   boolean is what actually distinguishes the two states.
3. **claude 분리설정/기본 좌석 — launch-argument block, corrected method
   (this task re-tested `claude mcp list` live, from inside this very
   CODER session, and found it is NOT discriminating — coder-task.md §1-5's
   own △ caution about it turns out to be right, for a reason worth
   spelling out):**

   ```
   claude mcp list
   ```

   returned `claude.ai Linear: https://mcp.linear.app/mcp - ✔ Connected`
   when run inside this very CODER session — even though this task's own
   `ToolSearch` (query `"linear"`, run in the same session, same turn) found
   **zero** `mcp__`-prefixed tools available to call. That gap is the actual
   finding: `claude mcp list` health-checks the **account-level OAuth
   connector**, a property of the Anthropic account, not of any one
   session's tool registry — it reports "Connected" regardless of whether
   `--strict-mcp-config` kept that connector's tools out of _this_
   session's callable tool set. It is not a discriminator for the
   session-level block at all, and should not be used as one (correcting
   the reading that would otherwise seem natural from coder-task.md §1-5's
   table, which flagged this command as "△ shows pre-block state only"
   without spelling out _why_ it can't be pushed further into a real
   discriminator by re-running it after the block).

   The method that **is** discriminating, verified live in this session:
   from inside a running session, search the tool registry itself for any
   `mcp__`-prefixed tool (in Claude Code, `ToolSearch` with a query matching
   the connector's name, e.g. `"linear"`). A blocked session (this one,
   CODER, `--strict-mcp-config` applied per §1-2) returns no match despite
   the account-level connector being reachable (per the `claude mcp list`
   run above) — connector-reachable-but-zero-tools-exposed is the
   discriminating pair, not connector-reachable alone. An unblocked session
   would instead surface `mcp__claude_ai_Linear__*` (or `mcp__linear-server__*`
   if that connector is what's configured) entries in that same search.

4. **ORCH — same in-session `ToolSearch`/tool-registry check as (3)**, not
   `claude mcp list`, once ORCH's own launch line carries the empty-MCP-config
   argument (see the condition ② text above). Until that line is attached,
   an in-session search for `mcp__`-prefixed Linear tools inside an ORCH
   session is expected to find one (unblocked today, per §1-2's "codex/claude
   ORCH 좌석 today는 미차단" baseline) — that positive result is the honest
   current-state baseline to compare the post-fix session against, not a
   passing result on its own.

Any of the five methods coder-task.md §1-5 already tried and found
non-discriminating (`claude -p` tool-name prompting, `--debug` mcp string
count, `--output-format json`'s `mcp_servers` field, stream-json init
tools/mcp_servers, or grepping for `mcp__` occurrences anywhere) should not
be reused as a stand-in for the four above — each of those returns the same
value in both the blocked and unblocked state on this machine, which is
exactly the failure mode this subsection exists to not repeat.

## F — go-time worker status (worker-status-onstart.mjs, HYK-110)

### Problem restated

The relay's worker-status flow is `IDLE →(task dropped) waiting for "go"
→(go) 🔨 작업중 (in progress) →(done) ORCH 완료 보고 →(consumed) IDLE`. Of
these four transitions, only the _completion_ one had any mechanical
detector at all — `relay-handshake.mjs` and `status-fresh.mjs` both check
after the fact whether a worker's result echoes and postdates its task.
The **go-time** transition (a worker starting real work) had no detector
whatsoever: it depended purely on the worker remembering to hand-edit its
own STATUS §1 row immediately after typing "go," a convention with no
backstop. A real incident (`coder-11`) showed the failure mode directly: a
worker skipped that self-report, and the stale-looking row was misread as
"task not yet started" when the worker was, in fact, well into it.

### Design: do it, don't gate it

Every other check in this document is a **gate** — it inspects state someone
else produced and passes/blocks. `worker-status-onstart.mjs` is instead a
**doer**: on the `UserPromptSubmit` event, if the prompt is a go-command, it
writes the STATUS §1 row itself, mechanically, before the worker's actual
task-reading turn even begins. This removes the convention rather than
enforcing it — there is no "worker forgot" failure mode left to catch,
because the worker no longer performs this step at all.

### Rule

Given the `UserPromptSubmit` hook's JSON payload (read from stdin, its
`prompt` field is the user's submitted text) and three environment
variables (`HARNESS_ROLE`, `HARNESS_STATUS_PATH`, and — PM only —
`HARNESS_PM_RELAY_DIR`):

1. If `prompt` does not match `/^\s*go\b/i` (a go-command, e.g. `go` or `go
HYK-110-coder-1`; a `\b` word boundary means `gogo` does **not** match),
   the hook is a no-op — `exit 0`, no file touched at all. This check runs
   first, before any environment/file access, so a normal conversational
   turn costs nothing.
2. If `HARNESS_ROLE` is not one of `CODER`, `REVIEW`, `VERIFY`, `PM`
   (`REGULATED_ROLES`), no-op — `exit 0`. This excludes `ORCH` (which never
   has a go-time transition of its own) and any unset/unrecognized role,
   mirroring role-guard's own role gate.
3. Resolve the dropped task file: for `CODER`/`REVIEW`/`VERIFY`,
   `<repoRoot>/.harness/<role-lowercase>-task.md`; for `PM`,
   `<HARNESS_PM_RELAY_DIR>/pm-task.md` — and if `HARNESS_PM_RELAY_DIR` is
   unset, no-op (the control-room PM relay path is never hardcoded into
   this script, same injection-over-literal-path posture as
   `relay-handshake.mjs`'s own `--harness-dir` parameter).
4. Extract `task_id:` from the task file (`/^task_id:\s*(\S+)/im`, same
   pattern `relay-handshake.mjs` uses). Missing file, unreadable file, or a
   file with no `task_id:` header — **fail open**: a stderr warning,
   `exit 0`, nothing written. This hook must never block a worker's actual
   turn just because it couldn't perform its own convenience update.
5. If `HARNESS_STATUS_PATH` is unset, fail open the same way (never a
   hardcoded control-room path).
6. Build the status label: `🔨 작업중: <task_id>` for `CODER`/`REVIEW`/
   `VERIFY`, `📝 기획중: <task_id>` for `PM` (matching the PM boot block's
   own Mode-B go-time phrasing, not a new fourth label invented here).
7. Replace **exactly one** STATUS §1 table row — the row whose first
   pipe-delimited cell is this role (`/^\|\s*<role>\s*\|[^|]*\|[^|]*\|[^\S\r\n]*$/m`)
   — with `| <role> | <label> | <now> |`, where `<now>` is the local
   clock's current time formatted `YYYY-MM-DD HH:MM` (this harness's
   existing "read the machine's local clock directly" convention, not a
   timezone-string parse). The pipe-bounded match means a role name that
   happens to appear inside another row's free-text cell can never be
   mistaken for that row — every other row, and every other section of the
   file, is left byte-for-byte untouched. If no row matches the role at
   all, fail open (warn + `exit 0`, no partial write).
8. On any file-write failure, fail open the same way.

### Implementation

- `scripts/check/worker-status-onstart.mjs` splits cleanly into pure logic
  and I/O, more so than most other checks in this document: `isGoPrompt`,
  `extractTaskId`, `buildStatusLabel`, `findSection1Bounds`, and
  `applyStatusUpdate` are each a small pure function, and
  `computeUpdate({ prompt, role, taskContent, statusText, nowStr })`
  composes them into one decision (`{action: "noop"|"warn"|"write", ...}`)
  **without touching a filesystem at all** — every test in
  `worker-status-onstart.test.mjs` exercises this composed function
  directly, no temp-directory fixtures needed (unlike
  `relay-handshake.test.mjs`/`status-fresh.test.mjs`, which do need
  fixtures because their pure functions still take file paths). The CLI
  block at the bottom is a thin wrapper: read stdin, resolve the two/three
  env vars, read the two files, call `computeUpdate`, write the result.
- **Row replacement is scoped to STATUS §1's own body, not the whole
  file.** `findSection1Bounds(statusText)` first locates the character
  range between the "1)"-numbered heading line (matched immediately after
  the leading `#`s and whitespace, e.g. `### 1) 다음 행동 (...)` — anchored
  so a differently-numbered heading like `### 10) 고정 방향` can never be
  mistaken for it) and the next heading line of any level, or end of file.
  `applyStatusUpdate` then searches for the role's pipe-delimited row
  **only within that range**, before ever touching anything else. Every
  other row, every other heading's section, and everything outside §1
  entirely is structurally unreachable by the replacement regex, not
  merely unlikely to match it.
- `scripts/check/worker-status-onstart.test.mjs` (`node:test`, 28 cases):
  go-prompt matching (bare `go`, `go <id>`, leading whitespace, `gogo`
  rejected, `완료` rejected, non-string prompt rejected); `task_id`
  extraction (present, missing, non-string content); label building for
  both the default and PM phrasing; row replacement (exact-row match with
  every other row and every other file section confirmed untouched by
  literal-string assertion, PM phrasing, no-match case, and a pipe-count
  assertion confirming the replaced row keeps the original 3-cell format);
  the composed `computeUpdate` end-to-end for both the noop paths (non-go
  prompt, unregulated role, unset role), the warn/fail-open paths (missing
  `task_id`, null task content simulating a missing file, no matching
  STATUS row), and the full write path for both `CODER` and `PM`; plus five
  round-2 cases and three round-3 cases (below).

**Round 2 fix (independent review reproduced a real bug):** the first cut
of `applyStatusUpdate` searched the **entire file** for a role's row shape,
not just §1. When §1 had no row for a role but a different section (free
text under §5/§6, or a review-fixture's own data) happened to contain a
same-shaped `| ROLE | ... | ... |` line, that unrelated line got
mis-replaced instead of the function correctly reporting "no §1 row found."
An independent review reproduced this directly with a minimal fixture (a
`## A` section carrying only a `REVIEW` row under `### 1)`, a `## B`
section carrying a look-alike `CODER` row) and confirmed the mis-replace
plus a `ok:true` result — a full contradiction of both the code's own
"every other row and file section left untouched" comment and this
document's own claim of the same. The fix adds `findSection1Bounds` (above)
so the row search is bounded to §1's own body before it ever runs;
`worker-status-onstart.test.mjs` gained five cases pinning this: the exact
reproduction (no §1 row, look-alike row in §B — now `ok:false`, and no
`updatedText` is produced at all, so there is nothing a caller could
accidentally write back); the same look-alike row coexisting with a real §1
row for that role (only §1's row is replaced, §B's row stays byte-for-byte,
confirmed by literal-string match); a file with no `"1)"`-style heading at
all (`ok:false`, fail-open); and two direct tests of `findSection1Bounds`
itself (no heading → `null`; bounds stop at the next heading regardless of
its level or number).

**Round 3 fix (independent review reproduced a second real bug):** round 2
correctly bounded the row _search_ to §1's own body, but the row regex
itself still ended in a bare `\s*` before its final `$` — and `\s*` matches
newlines too. For an internal row (more §1 content follows it inside
`sectionBody`), greedy backtracking always stopped at the first `$`-valid
position, which is naturally right before that row's own single line
terminator, so this never showed up in round-2's own tests. But whichever
row happens to be **last** inside §1's body is a different case:
`findSection1Bounds` truncates `sectionBody` exactly at the next heading's
start, so that last row's trailing newline(s) are the literal end of the
search string — `\s*` could then consume all of them via the end-of-string
form of `$`, with no internal `\n` left to force an earlier stop. The
splice dropped every newline between that row and the next heading,
gluing them directly together (`| NOW |### 2) ...`). An independent review
reproduced this with a minimal fixture (a `CODER` row immediately followed
by a bare `### 2)` heading) and separately flagged that this is exactly the
real STATUS.md's own shape — `VERIFY` is §1's last row there. The fix
restricts the trailing whitespace class to non-newline characters
(`[^\S\r\n]*` in place of the trailing `\s*`), so the newline is never a
candidate for that quantifier to consume in the first place, regardless of
where the row sits or how many blank lines follow it.
`worker-status-onstart.test.mjs` gained three cases: the exact reproduction
(line count and heading structure both confirmed preserved via a literal
regex asserting the row and heading are _not_ glued); a fixture shaped
exactly like the real STATUS.md (`CODER`/`REVIEW`/`VERIFY` rows, `VERIFY`
last) replacing `VERIFY` and confirming every row plus the following
section header survive intact; and an edge case where the last §1 row is
also the literal end of the whole file (no trailing newline at all),
confirming the replacement still lands safely. A live smoke against a real
control-room STATUS.md copy (never the original — see the constraint
below) replacing its actual last-row `VERIFY` entry confirmed the same:
the diff was exactly the one row, and the file's total line count was
unchanged before and after.

With round 3, the Rule section's "every other row, and every other section
of the file, is left byte-for-byte untouched" claim (and the _newline_
between a replaced row and whatever follows it) is now actually true for
every row position within §1, not merely the internal-row cases round 2's
own test suite happened to exercise.

### Live smoke (this task, temp STATUS copy only — the real control-room

STATUS.md was never touched)

Three scenarios, run against a real dropped task file (`.harness/
coder-task.md`, this very task's own file, `task_id: HYK-110-coder-1`) but a
throwaway copy of STATUS.md's table under the session scratchpad:

```
① echo '{"prompt":"go HYK-110-coder-1"}' | HARNESS_ROLE=CODER HARNESS_STATUS_PATH=<tmp>/STATUS.md node scripts/check/worker-status-onstart.mjs
   -> exit 0; tmp STATUS's CODER row becomes: | CODER | 🔨 작업중: HYK-110-coder-1 | 2026-07-11 21:14 |

② echo '{"prompt":"go HYK-110-coder-1"}' | HARNESS_ROLE=ORCH HARNESS_STATUS_PATH=<tmp>/STATUS.md node scripts/check/worker-status-onstart.mjs
   -> exit 0; tmp STATUS unchanged (diff empty)

③ echo '{"prompt":"이거 왜 안돼?"}' | HARNESS_ROLE=CODER HARNESS_STATUS_PATH=<tmp>/STATUS.md node scripts/check/worker-status-onstart.mjs
   -> exit 0; tmp STATUS unchanged (diff empty)
```

All three reproduced exactly as expected; see `.harness/coder.md`
(HYK-110-coder-1) for the raw run log.

### Installation (human, one-time per session-launch config — not done by

this task)

Same convention as every other locally-installed hook in this document: the
script is version-controlled here, but wiring it into a live worker
session's `settings.json`/`settings.local.json` is a human, per-install
step, and the three environment variables it reads (`HARNESS_ROLE`,
`HARNESS_STATUS_PATH`, and for PM sessions `HARNESS_PM_RELAY_DIR`) are set
from the boot line, the same place `HARNESS_ROLE` is already set today for
`role-guard.mjs`.

ⓐ Worker (CODER/REVIEW/VERIFY) separated-plan config,
`C:\Users\Administrator\.claude-team\settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/Users/Administrator/Documents/HARNESSENGINEERING/scripts/check/worker-status-onstart.mjs\""
          }
        ]
      }
    ]
  }
}
```

ⓑ Control room, `D:\문서관리\하네스-관제실\.claude\settings.local.json`
(PM session — appended alongside the existing `pm-guard.mjs` `PreToolUse`
entry from §E, not replacing it):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|mcp__linear-server__.*|mcp__claude_ai_Linear__.*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/Users/Administrator/Documents/HARNESSENGINEERING/scripts/check/pm-guard.mjs\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/Users/Administrator/Documents/HARNESSENGINEERING/scripts/check/worker-status-onstart.mjs\""
          }
        ]
      }
    ]
  }
}
```

### HYK-152 하드닝: track-consistency 배선 순서 계약 (2026-07-18, HYK-160-coder-6)

`checkTrackMatch` (`worker-status-onstart.mjs`) requires each STATUS file to
carry its own `<!-- harness-track-root: <repo-root-path> -->` marker,
compared against the running session's self-derived `repoRoot()` before any
§1 row write proceeds — a mismatch or missing marker is `STATUS_TRACK_MISMATCH`
/ `STATUS_TARGET_UNJUDGABLE`, both "무쓰기" (never write). This closes the
관제실 §6 HYK-152 incident (an env leak pointed a TEAM10 session's
`HARNESS_STATUS_PATH` at the harness control-room STATUS.md).

**This is a breaking change if deployed out of order.** Every real STATUS.md
in production today has no such marker. If the hardened
`worker-status-onstart.mjs` is wired into a live session's settings before
every STATUS file it could ever target already carries a correct marker,
every real `go`-time write silently stops (`STATUS_TARGET_UNJUDGABLE`) —
the exact same class of "convention removed, nothing replaces it in the
gap" risk this document's own Design section warns about, just triggered by
a missing precondition instead of a code bug.

**Mandatory deployment order (a contract, not just a post-hoc honesty
note):**

1. **Marker installation, ORCH-only.** ORCH installs one
   `<!-- harness-track-root: <that track's actual repo root> -->` line into
   **every** STATUS.md this hook could ever be pointed at (harness
   control-room STATUS.md, TEAM10's STATUS.md, and any future track's).
   CODER's own role-guard lane forbids writing to control-room or
   other-track files at all — this step can never be a CODER task, by the
   same role-boundary this whole document enforces elsewhere (§D).
2. **Verification.** For each STATUS file, ORCH runs `checkTrackMatch`
   (or the equivalent CLI invocation) against that track's real `repoRoot()`
   and confirms `status: "OK"` — never assumes the marker text is correct
   just because a line was pasted in.
3. **Only then, code/hook deployment.** The hardened
   `worker-status-onstart.mjs` (and any settings.json/settings.local.json
   wiring change to it) is deployed only after every target STATUS file has
   passed step 2. Deploying the code before every marker is installed and
   verified is exactly the breaking scenario above — **explicitly
   prohibited** by this contract, not merely "not yet done."

Synthetic wiring-order contract test (`worker-status-onstart.test.mjs`,
OS-temp/synthetic STATUS fixtures only — no real control-room STATUS.md is
ever probed, per S7): a markerless STATUS + the hardened hook reproduces the
regression shape directly (write blocked, `STATUS_TARGET_UNJUDGABLE`); the
same STATUS with the marker installed (step 1) and matching `repoRoot()`
(step 2 passing) writes normally — pairing "skip the order" against "follow
the order" so the contract is pinned by a test, not only by this prose.

### Known limitations (honesty notes)

- **STATUS lives outside every repo — Tier 2 ceiling, not a gap to close.**
  Same class as `linear-sync.mjs` (D4) and `controlroom-fresh.mjs`: there is
  no server-side authority (no CI, no branch protection) that could ever
  run over a `D:\...` control-room path, so this can never be more than a
  local convenience mechanism, by the nature of where STATUS.md lives, not
  by an oversight in this implementation.
- **Codex workers (REVIEW/VERIFY) have no coverage at all, structurally.**
  `UserPromptSubmit` is a Claude Code hook type — it has no equivalent in a
  Codex session. When `REVIEW`/`VERIFY` run on Codex (this harness's normal
  routing, per `docs/model-orchestration.md`), their go-time STATUS update
  still depends entirely on the worker's own self-report convention, with
  zero mechanical backstop. This is not a partial gap this script narrows —
  it is a full miss for two of the four regulated roles' most common
  engine. The mitigation is the same one already recorded for role-guard
  and status-fresh's own Claude-only honesty notes: convention plus
  whatever the next full-scope review catches, nothing stronger.
- **An already-running session that predates the hook's installation is not
  retroactively covered.** The hook fires on `UserPromptSubmit` events
  going forward from whenever it was wired into that session's settings —
  a worker session already open when the hook is installed will not have
  it applied until its process restarts (same class of limitation
  `docs/harness-init.md`'s `install.mjs` section already notes for
  `role-guard.mjs`: "restart Claude Code once and confirm the hooks
  actually fire").
- **Same local trust boundary as every other hook in this document.** An
  agent or operator with shell access can edit or remove the
  `UserPromptSubmit` entry from `settings.json`/`settings.local.json`, or
  unset `HARNESS_ROLE`/`HARNESS_STATUS_PATH`, and nothing here detects
  that. This is a convenience mechanism removing a forgetting failure mode,
  not a security boundary — it sits in the same family as role-guard's and
  pm-guard's own "same environment as the agent it watches" limitation.

## G — reject-streak escalation gate (reject-streak.mjs, HYK-133)

### Problem restated

HYK-129 사이클3 hit the same spot rejected six times in a row. The moves that
actually helped mid-cycle — escalating to a stronger model around the third
consecutive reject, pulling in outside research around the fifth — were real
and effective, but existed purely as ORCH's own unrecorded, in-the-moment
judgment calls. Nothing wrote them down, nothing forced them to happen at a
consistent point, and — the concrete mechanical gap this closes — nothing
_could_ have forced them, because the fact "this issue has now been rejected
N times in a row" had nowhere durable to live: `.harness/review.md` is a
single relay slot, overwritten every round, so the streak evaporated the
moment the next round's review landed. This mechanizes today's convention
("관례 → 강제층", the same move D2 already made for review evidence, D3 for
task-id staleness).

### Two subcommands, one ledger

`scripts/check/reject-streak.mjs` follows the same shape as every other
check in this document — pure exported functions plus a thin CLI — but,
like `pm-snapshot-gate.mjs`, is `orch-direct` substrate: nothing hooks it
automatically, ORCH calls it itself at two points in the relay loop.

- **`record`** (`node reject-streak.mjs record --review <path> [--ledger
<path>]`) — run when ORCH consumes a review result, _before_ that round's
  `.harness/review.md` gets overwritten by the next round. Parses `for:`
  (falling back to `task_id:` if `for:` is absent — both carry the same
  leading `HYK-<n>` issue prefix) and `verdict: approved|rejected` out of
  the review text, derives the issue id, and updates
  `.harness/reject-streak.json`: a `rejected` verdict increments that
  issue's streak, an `approved` verdict resets it to 0. Every outcome is
  appended to that issue's `history` array regardless of verdict, so the
  ladder has the full sequence to point at later, not just the current
  count. An issue with no ledger entry yet starts at streak 0 — this is the
  same baseline `gate` uses, so a first-ever rejection reads as streak 1,
  not an error.
- **`gate`** (`node reject-streak.mjs gate [<coder-task-path>] [--ledger
<path>]`, default task path `.harness/coder-task.md`) — run before
  dropping the next task file for an issue. Looks up that issue's current
  streak; if `< 2`, passes unconditionally (`exit 0`). If `>= 2`, the task
  file must carry a complete **escalation envelope** (below) or the drop is
  refused (`exit 2`, reason on stderr, same exit-code contract as D2/role-guard).

### Escalation envelope — machine-parseable template

Lives inside an HTML comment, same convention as `pm-snapshot-gate.mjs`'s
`<!-- pm-snapshot ... -->` block (invisible in rendered markdown, easy to
copy-paste into a task file verbatim). Unlike a placeholder-form template,
this block is a **real, immediately-passing example** — copy it verbatim
into a task file and `gate` accepts it as-is (review-1, HYK-133-coder-1,
caught a first draft of this section that used `<...>` placeholder syntax
inside the block itself; a literal copy-paste of a placeholder obviously
never matches any of the allowed labels below, so the doc's own worked
example failed the gate it was documenting — this is the fixed version,
with a doc-code contract regression test, `reject-streak.test.mjs`, that
extracts exactly this fenced block and feeds it to `gate` so that drift
between this prose and the real parser is caught mechanically instead of by
the next reviewer noticing by hand):

```
<!-- reject-streak-envelope
원인 분류: 모델 한계
ORCH 조치:
- 모델 변경: sonnet -> opus로 승격, 다음 라운드부터 적용
-->
```

Swap in the real cause/action for the situation at hand — the two fields'
**allowed value sets**, not the example's specific wording, are what `gate`
actually checks:

- `원인 분류:` must be exactly one of **스펙 오류(ORCH)** | **모델 한계** |
  **환경 차이** | **설계 결함** (exact match or a label-prefix match, so
  `스펙 오류(ORCH)`'s own parenthetical doesn't need byte-identical
  reproduction).
- `ORCH 조치:` must be followed by at least one `- <분류>: <내용>` bullet
  whose `<분류>` is one of **리서치(출처 포함)** | **모델 변경** |
  **재설계 지시** | **디스코프 제안** | **PM B2 자문 회부** (again, exact or
  prefix match — a bullet like `- 리서치(출처 포함): <url>` matches the
  `리서치` label). Multiple bullets are allowed; only one needs to match for
  the envelope to be complete.

A block missing entirely, missing either field, or carrying a cause/action
label outside these two sets (including a literal, un-substituted
`<placeholder>` token) is rejected with a reason naming exactly which piece
is missing or invalid.

### Escalation ladder

Today's ad-hoc HYK-129 사이클3 pattern, written down as the ladder this gate
partially enforces:

| Streak                 | Requirement                                                             | Enforced by this gate?        |
| ---------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| 2 consecutive rejects  | Escalation envelope (cause + >=1 ORCH action) required on the next drop | **Yes** — `exit 2` if missing |
| 3 consecutive rejects  | Model escalation recommended/considered                                 | No — convention only          |
| 4+ consecutive rejects | Discope or PM B2 advisory candidate                                     | No — convention only          |

Only the streak-2 envelope requirement is mechanically gated. The 3-streak
and 4-streak rungs stay recorded here as the documented convention (per this
task's own scope decision — see honesty note below) but nothing currently
blocks a drop for failing to follow them; they rely on ORCH reading its own
streak (`.harness/reject-streak.json`) and choosing to act, the same
convention-only status every check in this document starts from before a
later revision mechanizes it further.

### Honesty note (S4)

This gate checks the envelope's **presence and shape only** — that a
recognized cause label and at least one recognized action label exist — never
whether the stated cause is the actually-correct diagnosis, whether the
research a `리서치` action claims has a real source, or whether the chosen
action is a good idea. Same scope limit `pm-snapshot-gate.mjs` already
documents for its own envelope: it is a "no unstrategized re-drop" check,
not an automated research or model-selection device. Both `record` and
`gate` are **ORCH self-invoked** (`orch-direct` substrate, no hook wires
either one) — this is Tier 2 by the same definition every other
orch-direct check in this document uses (relay-handshake, pm-snapshot-gate):
if ORCH forgets to run `record` after consuming a review, that round's
verdict never reaches the ledger and the streak undercounts; if ORCH forgets
to run `gate` before dropping a task, a same-spot re-drop with no envelope
simply isn't stopped. Nothing here is an agent-external anchor — it is a
convention with a mechanical shape-check bolted on, same trust boundary as
every other locally-invoked script in this document.

### Uncertain-state handling (fail-open, per R3)

A missing ledger file is a real, judgable state (every issue starts at
streak 0) — `gate` never creates or writes the ledger, only `record` does.
A ledger file that exists but fails to parse as JSON, or parses but lacks a
well-formed `issues` object, is **UNJUDGABLE**: both `record` and `gate`
print a reason containing the literal string `UNJUDGABLE`, leave the file
untouched, and exit `0` — the same fail-open posture every other check in
this document uses for a parse/read failure it cannot resolve (D2's missing
review file is the one deliberate fail-_closed_ exception; this gate is not
that case). A malformed `review.md` (no `for:`/`task_id:` line, no
recognized `verdict:` value) hits the same UNJUDGABLE-and-skip path in
`record`, rather than crashing or silently recording a guessed entry — a
hidden block is exactly what R3 rules out.

### Implementation

- `scripts/check/reject-streak.mjs`: pure functions `parseReviewOutcome`,
  `applyOutcome`, `computeRecord`, `loadLedger`/`writeLedger`,
  `checkEnvelope`, `checkGate`, plus the `record`/`gate` CLI dispatch —
  same text-in/struct-out shape as every other module in this document,
  fully unit-testable without a real filesystem for the pure half, fixture
  temp-dirs for the loader/CLI half (`review-gate.test.mjs`'s
  `withFixtureDir` pattern).
- `scripts/check/reject-streak.test.mjs` (`node:test`, 53 cases): outcome
  parsing (`for:`/`task_id:` fallback, missing fields, verdict
  normalization); ledger transitions (increment, reset, independent
  per-issue counters, history accumulation); ledger loading (missing file,
  valid JSON, invalid JSON, missing `issues` key, write/reload round-trip);
  envelope parsing (complete, absent, cause-only, actions-only, invalid
  cause, invalid action label, all four causes individually, all five
  action labels individually, parenthetical label form, multi-bullet with
  one match); the full R1–R3 known-bad/good matrix from
  게이트-기준.md §HYK-133 (ⓐ streak 2 no envelope → block, ⓑ cause-only and
  actions-only → block, ⓒ complete envelope → pass, ⓓ streak 1 no
  intervention → pass, ⓔ approved-reset then re-drop → pass, ⓕ corrupted
  ledger → UNJUDGABLE); and CLI end-to-end coverage including the
  relay-slot-overwrite simulation (two `record` calls against a review file
  rewritten in between, proving the ledger survives what `review.md` alone
  does not) and a full record→record→gate-blocked→gate-passed reproduction
  of the ⓐ scenario.
- Self-registered in `scripts/check/enforcement-inventory.json` as
  `reject-streak` (`orch-direct` substrate, `install_targets: []`, same
  "ALIVE via script+test existence" posture as `relay-handshake`/
  `pm-snapshot-gate`) — `selfcheck-inventory.mjs` picks it up without any
  code change, confirmed by a live `node scripts/check/selfcheck-inventory.mjs`
  run showing `reject-streak` as `ALIVE` alongside the pre-existing entries,
  zero regression to any other entry's judgment.
- `.github/workflows/enforce.yml`'s `node --test scripts/check/*.test.mjs`
  directory glob (HYK-129 사이클3) picks up `reject-streak.test.mjs`
  automatically — no CI file edit needed, confirmed by
  `selfcheck-inventory.mjs`'s own `ci-enforce` judgment reporting 20
  discovered suites (up from 19) after this file was added.

## D — report-style-guard (PreToolUse hook, HYK-143)

### Problem restated

A human-facing "report tone" style guide (control-room
`orchestrator-report-style.md`) was introduced. That guide is for how ORCH
reports to the human — it must not leak into worker _work documents_ (task
files, templates, memory), where a report skeleton would derail the machine
relay. `scripts/check/report-style-guard.mjs` is a `PreToolUse` guard, same
substrate as `role-guard`, that blocks a Write/Edit carrying report-tone
signatures into a watched work-document path.

### Rule

- Watched paths only (all other writes pass untouched): repo
  `.harness/<role>-task.md`, `templates/**`, control-room `PM/relay/*-task.md`,
  and any path containing `/memory/`. Path normalization reuses
  `path-normalize.mjs`.
- Signature A (guide copied): a markdown **heading** whose text contains the
  guide's title `기술 답변 톤` or its slug `orchestrator-report-style`.
- Signature B (report skeleton): the tokens `결론`, `진단`, and `정직 한계`
  **all** present as structural items (heading / numbered / bold), not as bare
  prose. Any two of three, or prose use of the words, passes.
- Confirmed match → exit 2 (block, naming the signature and line). Non-watched
  path or non-write tool → exit 0. Malformed/absent hook payload or non-string
  content → exit 0 (UNJUDGABLE, fail-open — HYK-129 G3 house convention).

### Known limitation (honesty note)

- **Claude-only.** Like `role-guard`, this is a Claude Code `PreToolUse` hook:
  it does not see codex-worker edits or manual file edits. It was wired into
  `.claude/settings.local.json` post-HYK-143 under human approval
  (HYK-115 precedent); the manifest's `install_targets` entry went stale
  (left `[]`) after that wiring landed, a drift independently confirmed by
  verify-2 (07-18) and closed by HYK-160 라이더ⓐ.
- **Signature-based, so variant phrasings evade it.** It keys on the guide's
  exact title/slug heading and the exact three skeleton tokens. A paraphrased
  tone leak, a translated heading, or a differently-named skeleton is not
  detected. It is a tripwire for the obvious copy/paste, not a semantic judge.
- **Deliberate §2A honesty adjustment.** The task contract phrased signature A
  as "the `기술 답변 톤` heading **or** the `orchestrator-report-style`
  string." A literal "slug string anywhere" match is unusable: the HYK-143
  task file itself quotes the bare slug in its §2A spec text and cites the
  `orchestrator-report-style.md` filename, and that same task file is listed
  as known-good (must pass). So the slug is matched only in **heading** form —
  a filename citation or a prose/backtick mention (a reference, not a tone
  leak) passes, while a document titled with the guide's slug is caught. Real
  guide copies also carry the `기술 답변 톤` title heading, which A catches
  independently.
- Self-registered in `scripts/check/enforcement-inventory.json` as
  `report-style-guard` (`claude-hook` substrate, `install_targets` now
  reflects the real `repo-settings`/`PreToolUse` wiring, `claude_only: true`).
  The `enforce.yml` directory glob picks up `report-style-guard.test.mjs`
  with no CI edit.

## H — B0 사전 설계비평 형식·존재·순서 게이트 (b0-gate.mjs, HYK-159/HYK-160)

### Problem restated

`relay-terminal-setup.md` §2.15's B0 loop (HYK-130) started as a pure
Tier2 convention: ORCH self-judges whether a design drop is "non-trivial"
enough to need a PM critique, and if so, exchanges a request/response/
consumption trio of blocks with PM before ever dropping the CODER task.
The 07-18 weekly loop (HYK-123-pm-2) collected a week of real drops and
found a 90% omission rate against that self-judgment — the convention
existed on paper but almost never actually ran. That crossed this repo's
own promotion bar (게이트-기준.md, "누락≥2 또는 ≥20%" 또는 "누락-반려
연결"), so §2.15 was mechanized: `scripts/check/b0-gate.mjs` checks a
target drop's classification marker and its three exchange blocks'
existence/order, the same "format and existence only, never content
quality" scope every other gate in this document keeps.

### Exact command

`node scripts/check/b0-gate.mjs --drop <pm-task 경로> --response <pm.md 경로> --consumption <로컬 소비 미러 경로>`

Run by ORCH directly (`orch-direct` substrate, same posture as
`reject-streak.mjs`/`pm-snapshot-gate.mjs` — no hook wires this
automatically) **before** dropping the CODER task, only when the B0
사전 자가판정 (5문항, §2.15) has classified the drop as **target**. A
드롭 classified **non-target** needs only its one-line `B0: 비대상
(사유: ...)` marker — `--response`/`--consumption` are omitted entirely
and the gate passes on the 사유 field's presence alone (never on its
soundness).

### Exit codes and reasons

`exit 2` = **coder-task 드롭 금지** (reason printed to stderr, one of):

- `B0_CLASSIFICATION_REQUIRED` — the drop has neither a `## B0 사전 비평
요청` block nor a `B0: 비대상 (사유: ...)` marker, or the 비대상 marker's
  사유 field is empty.
- `B0_EVIDENCE_REQUIRED` — a target drop is missing one of the three
  blocks (request/response/consumption), or a block is present but
  missing its `b0_id` or `결론` field.
- `B0_ID_MISMATCH` — the response or consumption block's `b0_id` doesn't
  match the request block's.
- `B0_CONSUMPTION_EVIDENCE_REQUIRED` — the consumption block is missing
  its `linear_comment:` field, or the field's value doesn't match either
  accepted format below.

`exit 0` = pass; only then does ORCH drop `coder-task.md`.

### `linear_comment:` format (2 accepted forms)

Either a full Linear web URL (`https://linear.app/...`) or the short
form `comment:<id>`. Format only — the gate never fetches Linear, so it
cannot and does not verify the comment actually exists or says what the
local mirror claims.

### Audit-trail precedence and mirror sync responsibility

**Linear 이슈 댓글이 여전히 정본**(§2.15 교환 형식 불변) — the local
`<!-- b0-consumption ... -->` mirror this gate reads is not a second
source of truth, it's ORCH's echo of the same consumption conclusion
already posted to Linear, written **immediately after** that comment, at
관제실 `PM\산출물\<트랙>\<주제 폴더>\b0-<b0_id>.md` (or the cycle's own
output file). **Sync responsibility = ORCH.** If the mirror and the
Linear comment ever disagree, the Linear comment wins.

### Honesty note (S4, Tier2)

Same shape/limits `pm-snapshot-gate.mjs` and `reject-streak.mjs` already
document for themselves: this gate checks presence, ordering, and
`linear_comment` format only — never whether the PM critique itself was
any good, whether ORCH's adoption decision was correct, or whether a
비대상 self-judgment was honest. `record`/`gate`-equivalent invocation is
**ORCH self-executed** (`orch-direct`, no hook) — if ORCH skips running
it before a drop, nothing stops that drop; `selfcheck-inventory.mjs`
audits the check's existence, not whether ORCH actually called it that
cycle. This is the identical trust boundary `reject-streak.mjs`'s own
honesty note already states for the same reason.

### Implementation

- `scripts/check/b0-gate.mjs`: pure functions `classifyB0`,
  `checkB0Contract` (dispatching to internal `checkResponseBlock`/
  `checkConsumptionBlock`/`checkTargetContract` helpers), plus a thin
  `--drop`/`--response`/`--consumption` CLI — same text-in/struct-out
  shape as every other module in this document.
- `scripts/check/b0-gate.test.mjs` (`node:test`, 27 cases): classification
  (target/non-target/neither); the full known-bad/paired-good matrix for
  all four reason constants above, each isolated to a single changed
  variable; three CLI end-to-end cases (complete exchange, 비대상
  shortcut, missing marker); the `linear_comment` known-bad (missing/
  malformed) and paired-good (URL form, `comment:<id>` short form) pairs
  (HYK-160-coder-2, review-1 결함 2); and three drop-time integration
  cases (HYK-160-coder-3, review-2 조건 3) exercising the exact command
  above against a realistic `pm-task.md`/`pm.md`/local-mirror layout:
  gate not invoked (nothing blocks an incomplete exchange sitting on
  disk — the honest limit stated above), gate invoked on an incomplete
  exchange (`exit 2`), gate invoked on a complete one (`exit 0`).
- `b0-gate.test.mjs` also carries a **doc-code contract test**
  (`docCodeContract` describe block, same convention as `reject-streak.
test.mjs`'s enforcement-v1.md extraction test) that reads this very
  section's fenced command line and reason-constant list out of
  `docs/enforcement-v1.md` and asserts them against `b0-gate.mjs`'s real
  exported reason strings and CLI flag names — a future edit to either
  side that drifts from the other fails the suite instead of waiting for
  a reviewer to notice by hand.
- **Not yet self-registered in `scripts/check/enforcement-inventory.json`**
  (honesty note, HYK-160-coder-3 scope: this round's diff was declared as
  `docs/enforcement-v1.md` + test files only) -- `b0-gate` should get the
  same `orch-direct`/`install_targets: []` manifest entry `reject-streak`/
  `pm-snapshot-gate` already carry, the same "ALIVE via script+test
  existence" posture, but that edit belongs to a follow-up round (or
  라이더ⓐ-style registration pass), not this one. Until registered, a
  `selfcheck-inventory.mjs` run correctly does **not** report a `b0-gate`
  row at all (it only judges entries the manifest lists).
- `.github/workflows/enforce.yml`'s `node --test scripts/check/*.test.mjs`
  directory glob picks up `b0-gate.test.mjs` automatically — no CI file
  edit needed.

## I — seat launch admission (seat-preflight.mjs, HYK-200)

### Problem restated

gap#91 (`hook-sync-check.mjs`, HYK-196): a worker's _installed_ git hook can
silently drift behind the _versioned_ `hooks/` mirror, and nothing stopped a
seat from launching on top of that drift — the incident that motivated
HYK-196 was caught only because a weekly `selfcheck` sweep happened to
notice, and that sweep is advisory (exit 0 either way), not a gate. HYK-196
built the comparison device; this track's job was narrower: give that device
a shape a seat launcher can actually call _before_ a seat starts, and make
that shape fail-closed.

### What this device is (and is not)

`scripts/check/seat-preflight.mjs` adds **no new comparison logic**. It
imports and calls `runHookSyncCheck` from the already-registered
`hook-sync-check.mjs` (HYK-196) and does exactly two things with its
verdict: turns it into a short human-readable message, and turns it into an
exit code a launcher can branch on.

### Exact command

```
node scripts/check/seat-preflight.mjs
```

No flags. It reads the current working directory as the seat's own
worktree — the launcher is expected to run it _from_ the worktree it is
about to start a seat in, the same way `hook-sync-check.mjs` itself already
resolves a linked worktree's installed hooks through `git-common-dir`
(never `<worktree>/.git/hooks`, which cannot exist — `.git` there is a
file, not a directory).

### Exit codes (fail-closed — 시안 §2-1, "설계 = 차단. 관측·경고가 아니다")

| exit | verdict     | 좌석 기동 | 화면에 뜨는 것                                                                           |
| ---- | ----------- | --------- | ---------------------------------------------------------------------------------------- |
| 0    | IN_SYNC     | 가능      | `seat-preflight: PASS -- ...`                                                            |
| 2    | DRIFT       | **금지**  | 어긋난 파일 이름 + `고치는 명령: node scripts/check/hook-sync-check.mjs --install`       |
| 1    | UNDECIDABLE | **금지**  | 판정 실패 사유 (고치는 명령 없음 — 알려진 드리프트가 아니라 판정 자체가 실패한 것이므로) |

Neither non-zero branch is ever allowed to collapse to 0 — a path-resolution
failure or an unreadable file blocks the seat exactly like a confirmed
drift does, just with a different, honestly-labeled reason.

### What a person does when a seat fails to start on this

1. Read the printed message — it names the drifted file(s), or says the
   judgment itself could not be made and why.
2. If DRIFT: run the printed line, `node scripts/check/hook-sync-check.mjs
--install`, then retry launching the seat.
3. If UNDECIDABLE: there is no drift to install over — the reason line says
   what failed to resolve (e.g. a missing `hooks/` directory, a
   `git-common-dir` lookup failure). Fix the underlying condition, then
   retry.
4. There is no escape hatch here by design (coder-task.md §2-3): no
   "skip this once" flag exists, and none should be added — that would
   reopen exactly the drift class HYK-196/gap#91 exist to close.

### Honesty note — what is NOT true yet

This CLI is callable and fail-closed today (verified end-to-end by real
spawned child-process tests in `seat-preflight.test.mjs`, not just
in-process function calls), but **the control-room seat launcher does not
call it yet**. That launcher is out of scope for this track by hard
boundary (coder-task.md §1: "너는 관제실 파일을 절대 건드리지 마라") — ORCH
prepares the exact line the launcher needs, and 한용 attaches it by hand.
Until that attachment happens, this device only protects a seat launch if a
human or ORCH remembers to run it first — the same limitation
`hook-sync-check.mjs` itself carries today. See
`docs/enforcement-known-gaps.md` gap#91 for the tracked remainder and
`scripts/check/enforcement-inventory.json`'s `seat-preflight` entry for the
same statement in machine-registered form.

### Implementation

- `scripts/check/seat-preflight.mjs`: `admissionFor(verdict)` (pure
  verdict → `{canLaunch, exitCode}` mapping), `evaluateSeatPreflight({cwd})`
  (calls the reused `runHookSyncCheck`, folds in the admission decision),
  `formatReport(result)` (the human-readable text above), plus a thin CLI
  entrypoint.
- `scripts/check/seat-preflight.test.mjs` (`node:test`) — case count
  deliberately not pinned here (this exact repo already caught itself
  going stale on a hand-written test count once before: "a prior version
  of this note said '37 cases' for `selfcheck-inventory.test.mjs` right
  after a different round had already brought it to 42", under "Enforcement-
  layer self-check (selfcheck.mjs, HYK-129 사이클 2)" above; `node --test
scripts/check/
seat-preflight.test.mjs` is the one source of truth for the current
  count). What it covers: the `admissionFor` mapping in isolation;
  behavioral proof injected via a real throwaway synthetic git repo,
  through the exported functions (`evaluateSeatPreflight`/`formatReport`),
  for every judgment outcome (IN_SYNC; content DRIFT; missing-file DRIFT;
  a versioned-`hooks/`-absent UNDECIDABLE, a distinct `ENOENT` path from
  the one below; the zero-comparison-targets fold to UNDECIDABLE,
  HYK-200 3R; a per-file judgment failure with no top-level `reason`
  whose UNDECIDABLE report still names the failing file and does not
  drop a coexisting DRIFT entry, HYK-200 3R; a caught exception from the
  reused device folding to UNDECIDABLE instead of propagating,
  HYK-200 3R) plus a linked-worktree case; and an HYK-199-precedent
  regression test proving this test file's own pass/fail does not depend
  on which directory `node --test` was invoked from. Separately, the
  production CLI entrypoint itself is proven end-to-end by real
  spawned-child-process tests (`spawnSync("node", [...])` against the
  actual script, not the exported functions) — deliberately not
  enumerated here which specific judgment outcomes those cases cover:
  4R's "each ... exercised both through the exported functions and
  through the actual CLI" claimed CLI coverage for every outcome above
  and was false for three of them (HYK-200-preflight-review-3 §1-A), the
  second staleness incident in this same note (after the "13 cases"
  count) — an itemized coverage-mode mapping carries the identical
  staleness risk as a hand-written count (it silently drifts the moment
  a future round adds an outcome, or moves one between coverage modes,
  without updating this sentence) and this note already treats that risk
  class as something to stop writing down, not merely correct once more;
  `node --test scripts/check/seat-preflight.test.mjs` remains the one
  source of truth for which cases spawn the CLI and which don't.
- Registered in `scripts/check/enforcement-inventory.json` as
  `seat-preflight` (`substrate: "manual"`, same convention as
  `hook-sync-check`/`skip-review-usage` above).
- `.github/workflows/enforce.yml`'s `node --test scripts/check/*.test.mjs`
  directory glob picks up `seat-preflight.test.mjs` automatically — no CI
  file edit needed.
