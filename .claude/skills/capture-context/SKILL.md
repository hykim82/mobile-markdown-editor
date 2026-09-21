---
name: capture-context
description: Use when this project's goals, intent, or hard constraints have newly emerged or changed during the session, or right before /clear, and you want to fold that delta into PROJECT-CONTEXT.md (the project context card) instead of letting it evaporate.
---

# Capture Context

Installed for `solo-full` at `C:/Users/Administrator/Documents/모바일마크다운에디터`. This is a capture-assist tool —
it lowers the friction of keeping `PROJECT-CONTEXT.md` current; it does not
replace human judgment about what belongs there. See "Honest limits" below
before relying on it.

## Procedure

1. **Resolve the card path.** Do not assume `.harness/PROJECT-CONTEXT.md` —
   the active card can live outside the repository (e.g. a control room
   directory for a `solo-full` install). Resolve in this exact order,
   matching `scripts/check/context-inject.mjs`'s own precedence
   (`resolveContextPath`):
   1. **(a)** Read `.claude/settings.local.json`. Find the `SessionStart` or
      `UserPromptSubmit` hook command that invokes `context-inject.mjs` and
      read the `--context <path>` argument baked into that command string.
      For this install, that is typically
      `D:/문서관리/에디터-관제실/PROJECT-CONTEXT.md` when a control room path was
      configured (`solo-full`), or absent/omitted for `team-local` (which has
      no control room) — but re-read the actual hook config each time rather
      than trusting this note, since it is per-clone and can change.
   2. **(b)** If no `--context` argument is found, use the
      `HARNESS_CONTEXT_PATH` environment variable if set.
   3. **(c)** Otherwise, default to `C:/Users/Administrator/Documents/모바일마크다운에디터/.harness/PROJECT-CONTEXT.md`.
   State the resolved absolute path to the human explicitly before doing
   anything else — this is the single most important step, since acting on
   the wrong card silently defeats the whole point.

2. **Read the current card.** Load both sections as they exist today:
   `## HARD CONSTRAINTS` and `## 목표·의도·맥락 (Goals / Intent / Context)`
   (or whatever heading text is actually present). Note what's already
   there so the next step proposes only what's missing.

3. **Scan the conversation for durable facts.** Look across the session for
   things that are true beyond this conversation, and sort each into one of
   two buckets:
   - **Hard constraints** — short, imperative, non-negotiable rules whose
     violation would be a real incident (not a style preference). For a
     `team-local` install, "never commit or push harness tooling to
     `hykim82/mobile-markdown-editor`" is the standing example already in the installed card.
   - **Goals / intent / context** — why this project exists, background a
     cold-starting agent would need, evolving narrative.
   Exclude anything one-off or scoped to only this conversation (e.g. a
   specific value currently being debugged, a decision that only applies to
   the task at hand). If nothing durable came up, say so and skip to step 4.

4. **Compute the delta, not a rewrite.** Compare against what step 2 found.
   Propose only new-or-changed lines for `## HARD CONSTRAINTS` (kept short)
   and new paragraph(s) to append to `## 목표·의도·맥락`. If the card already
   covers everything durable from this session, say **"no delta — no update
   needed"** and stop here. Low friction when nothing changed matters as
   much as capturing when something did.

5. **Present the delta and wait.** Show the proposed delta to the human.
   Do not write the card yet. Do not decide unilaterally that the delta is
   final — this skill drafts, the human confirms. If the human edits the
   wording, use their edited wording verbatim, not a paraphrase of it.

6. **Write the approved delta.** Once approved:
   - `## HARD CONSTRAINTS`: append or edit in place, keep it short. If a
     proposed line is really background rather than a bright-line rule,
     route it to `## 목표·의도·맥락` instead of inflating this section.
   - `## 목표·의도·맥락`: **append** the delta paragraph(s). Never delete or
     rewrite existing content in this section — it is running memory that
     accumulates over the project's life, not a document to be re-authored
     each time.

7. **Self-check the result.** Run, against the resolved card path from step 1:

   ```sh
   node C:/Users/Administrator/Documents/모바일마크다운에디터/scripts/check/context-inject.mjs --mode user-prompt-submit --context <resolved-path>
   ```

   Confirm exit code `0` and report that confirmation to the human. This is
   a mechanical check that the card still satisfies `isUsableCard` (non-empty
   `HARD CONSTRAINTS`, no leftover `<PLACEHOLDER>` token) after the edit —
   it is not a check that the content is *good*, only that it is *usable*.

## Honest limits

- **Completeness and quality are not guaranteed.** "Did we capture everything
  that mattered in this conversation" is a judgment call this skill cannot
  make mechanically — it surfaces only what the model *noticed* as durable.
  Final judgment and sign-off is the human's, every time (step 5).
- **Silent compaction is not covered.** If the conversation was already
  summarized/compacted before this skill ran, whatever got dropped in that
  compaction is invisible to this scan — there is nothing to recover it from.
- **Not a hard gate.** This skill only runs when explicitly invoked
  (`/capture-context`). It does not intercept `/clear` and does not block
  anything by itself; a `/clear`-time re-orientation *checkpoint* is separate,
  future work (HYK-96 Scope B in the source repo), not part of this skill.
- **Same local trust boundary as every other check in this harness.** Nothing
  stops an agent or operator from skipping this skill entirely, or from
  writing a plausible-looking delta that doesn't actually reflect the
  conversation. Step 7's self-check only proves the card's *form* is usable,
  not that its *content* is honest.
