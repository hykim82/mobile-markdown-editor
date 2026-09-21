<!-- Installed by default at .harness/PROJECT-CONTEXT.md. `scripts/check/context-inject.mjs`
     reads this exact path (override with --context or HARNESS_CONTEXT_PATH). Only the
     "## HARD CONSTRAINTS" section below is injected into every new session, via the
     SessionStart hook; extraction stops at the next "##" heading, so everything under
     "## 목표·의도·맥락" below is never injected -- keep that section as long as you want, it
     costs nothing. A UserPromptSubmit hook blocks prompts entirely if this file is missing,
     or if HARD CONSTRAINTS is empty or still has an unedited template placeholder in it. See
     docs/enforcement-v1.md ("D6 — project-context injection", "Scope A", "Scope D") for the
     full mechanism.

     HYK-97: every fill-in slot below is an ALL-CAPS `<REPLACE_ME_...>` token,
     matching this harness's `<UPPER_SNAKE>` placeholder convention used
     everywhere else (STATUS/PHASE-HANDOFF templates, install.mjs's own
     `<GITHUB_REPO>` etc.) -- not lowercase descriptive prose in brackets.
     This is deliberate and load-bearing: `isUsableCard`'s placeholder gate
     only pattern-matches `<[A-Z][A-Z0-9_]*>`, so a lowercase placeholder
     here would silently read as "already filled in" and pass the gate on a
     freshly-installed, still-blank card -- exactly the gap HYK-97 closed
     (a real install.mjs-installed card was found doing this). Do not
     reintroduce a lowercase `<...>` placeholder in this file; put any
     guidance about what a slot is for in prose or an HTML comment outside
     the angle brackets, the way this file already does below. -->

# Project context — <REPO_PATH>

Profile: <PROFILE>

<!-- One line: what this file is for. Full background goes in "목표·의도·맥락"
     below, not here. Replace the token below with that one line. -->
<REPLACE_ME_PURPOSE_LINE>

## HARD CONSTRAINTS

<!-- Only this section is auto-injected every session start -- keep it short.
     Guidance: short, imperative, non-negotiable rules only -- not a style
     guide, only rules whose violation would be a real incident. One example
     per profile is filled in below; replace the REPLACE_ME token with this
     project's own next hard constraint (add more bullets the same way if
     there's more than one). -->

- (team-local example) Never commit or push harness tooling
  (`.harness/`, `verify.sh`, local hooks, `scripts/check/`) to
  `<GITHUB_REPO>` — this account does not own that repo, and its personal
  process tooling must not become shared team state.
- <REPLACE_ME_HARD_CONSTRAINT_1>

## 목표·의도·맥락 (Goals / Intent / Context)

<!-- This section is never injected -- it's for storage, not repetition.
     Length costs nothing here. A future /clear-time re-orientation step
     (HYK-96 Scope B) is expected to append deltas to this section over
     time, so treat it as the project's running memory, not a one-time
     background paragraph. Guidance: why this project exists, what it's
     for, the situation an agent walking in cold needs to know that isn't
     obvious from the code -- as much as is useful, since none of it is
     repeated into every session's context. Replace the token below. -->

<REPLACE_ME_GOALS_INTENT_CONTEXT>
