import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

const HEADING_RE = /^##\s+(.+?)\s*$/;

// Extracts the body of the "## HARD CONSTRAINTS" heading (exact title,
// case-insensitive) up to the next "##" heading or end of file. Pure
// text-in/struct-out so it is trivially unit-testable without touching the
// filesystem; file loading is the CLI's job.
export function extractHardConstraints(contextText) {
  const lines = (contextText ?? "").split(/\r?\n/);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m && m[1].trim().toLowerCase() === "hard constraints") {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) {
    return { ok: false, reason: "no ## HARD CONSTRAINTS section" };
  }
  let endIdx = lines.length;
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (/^##\s+/.test(lines[j])) {
      endIdx = j;
      break;
    }
  }
  const text = lines.slice(startIdx + 1, endIdx).join("\n").trim();
  if (!text) {
    return { ok: false, reason: "HARD CONSTRAINTS section is empty" };
  }
  return { ok: true, text };
}

// A freshly-installed card that was never edited still has its template's
// literal placeholder tokens (e.g. `<GITHUB_REPO>`) inside the HARD
// CONSTRAINTS body -- that is a stub, not real content, even though the
// section itself is technically non-empty. `<UPPER_SNAKE>` matches this
// harness's placeholder convention across all templates (status/phase-
// handoff/project-context), so one regex catches an unedited card
// regardless of which specific token was left in place.
const PLACEHOLDER_RE = /<[A-Z][A-Z0-9_]*>/;

// A card is "usable" only if it has a non-empty HARD CONSTRAINTS section
// AND that section contains no leftover placeholder token. Either failure
// mode -- section missing/empty (already covered by extractHardConstraints)
// or section present but unedited -- means the card is not real content.
export function isUsableCard(contextText) {
  const extracted = extractHardConstraints(contextText);
  if (!extracted.ok) return { ok: false, reason: extracted.reason };
  const placeholderMatch = extracted.text.match(PLACEHOLDER_RE);
  if (placeholderMatch) {
    return { ok: false, reason: `unresolved template placeholder ${placeholderMatch[0]} still present` };
  }
  return { ok: true };
}

function fileExists(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function resolveContextPath(explicitPath) {
  return explicitPath || process.env.HARNESS_CONTEXT_PATH || join(repoRoot(), ".harness", "PROJECT-CONTEXT.md");
}

function sessionStartOutput(contextPath) {
  let additionalContext;
  if (!fileExists(contextPath)) {
    additionalContext =
      `⚠️ PROJECT-CONTEXT.md를 ${contextPath}에서 찾지 못함 — ` +
      "이 프로젝트의 하드 제약이 주입되지 않았습니다. 진행 전 맥락 카드를 만드세요.";
  } else {
    try {
      const text = readFileSync(contextPath, "utf8");
      const usable = isUsableCard(text);
      if (usable.ok) {
        // isUsableCard.ok implies extractHardConstraints.ok, so this
        // re-extraction cannot fail.
        additionalContext = `프로젝트 하드 제약(자동 주입):\n${extractHardConstraints(text).text}`;
      } else {
        // Never inject placeholder junk as if it were real content --
        // warn instead, same as the file-missing/section-missing cases.
        additionalContext =
          `⚠️ ${contextPath}의 HARD CONSTRAINTS를 사용할 수 없음(${usable.reason}) — ` +
          "이 프로젝트의 하드 제약이 주입되지 않았습니다. 맥락 카드를 보완하세요.";
      }
    } catch (err) {
      additionalContext =
        `⚠️ ${contextPath}를 읽는 중 오류(${err.message}) — ` +
        "이 프로젝트의 하드 제약이 주입되지 않았습니다.";
    }
  }
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/context-inject.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let mode;
  let contextPathArg;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") mode = args[++i];
    else if (args[i] === "--context") contextPathArg = args[++i];
  }
  const contextPath = resolveContextPath(contextPathArg);

  if (mode === "session-start") {
    // SessionStart cannot block (exit 2 is ignored by the hook contract), so
    // any failure path here still exits 0 -- a warning injected into context
    // is the strongest signal this hook type can give.
    let output;
    try {
      output = sessionStartOutput(contextPath);
    } catch (err) {
      output = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `⚠️ context-inject internal error (${err.message}) — hard constraints not injected.`,
        },
      };
    }
    console.log(JSON.stringify(output));
    process.exit(0);
  } else if (mode === "user-prompt-submit") {
    // Blocking is reserved for two conditions this task specifies as
    // *confirmed*: the context file is absent, or it was read successfully
    // and its HARD CONSTRAINTS are confirmed empty/placeholder-only. Any
    // other failure (permission error reading an existing file, unexpected
    // exception) is "uncertain," not "confirmed unusable" -- fail open.
    try {
      if (!fileExists(contextPath)) {
        const reason =
          `PROJECT-CONTEXT.md가 ${contextPath}에 없습니다. ` +
          "이 프로젝트의 하드 제약 카드를 먼저 만드세요(진행 차단).";
        console.error(reason);
        console.log(JSON.stringify({ decision: "block", reason }));
        process.exit(2);
      }

      let text;
      try {
        text = readFileSync(contextPath, "utf8");
      } catch {
        // File exists but couldn't be read -- uncertain, not confirmed
        // unusable. Fail open.
        process.exit(0);
      }

      const usable = isUsableCard(text);
      if (usable.ok) {
        process.exit(0);
      }
      const reason =
        `PROJECT-CONTEXT.md(${contextPath})의 HARD CONSTRAINTS를 사용할 수 없습니다(${usable.reason}). ` +
        "이 프로젝트의 하드 제약 카드를 채우세요(진행 차단).";
      console.error(reason);
      console.log(JSON.stringify({ decision: "block", reason }));
      process.exit(2);
    } catch {
      process.exit(0);
    }
  } else {
    console.error("usage: node context-inject.mjs --mode <session-start|user-prompt-submit> [--context <path>]");
    process.exit(1);
  }
}
