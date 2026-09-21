import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Generates the "frame file" ignore list this repo's pre-commit gate
// (hooks/pre-commit -> scripts/check/quality-check.mjs) needs so that
// bulk-committing the harness frame (HYK-304-frame-commit-1) does not get
// blocked by formatting/lint debt the harness's OWN source files already
// carry (they are not this repo's to fix -- see coder.md §1 for the
// measured counts). Two artifacts are (re)written from the SAME computed
// list so they cannot drift apart:
//   - .prettierignore              (native prettier mechanism)
//   - eslint.config.mjs generated `ignores` block (native ESLint flat-config
//     mechanism -- ESLint has no separate ignore-file support in flat
//     config, so the block lives inside the one config file it reads)
// Re-running this generator with unchanged inputs must produce byte-
// identical output (idempotent) -- see frame-ignore-guard.test.mjs for the
// mechanical proof.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

// Single source of truth for WHICH files the installer places in a target
// repo: the harness repo's own templates/harness-init/install.mjs. This
// workspace has no local copy of templates/harness-init/install.mjs (only
// project-context.template.md), so it is read from the harness repo
// (read-only -- never written) at this fixed path. Override with
// HARNESS_REPO_PATH for portability off this machine; there is no other
// discovery mechanism (honesty limit, see coder.md §10).
const HARNESS_REPO_PATH =
  process.env.HARNESS_REPO_PATH ??
  "C:/Users/Administrator/Documents/HARNESSENGINEERING";
const INSTALL_MJS = join(
  HARNESS_REPO_PATH,
  "templates",
  "harness-init",
  "install.mjs",
);

export async function loadInstallerCopyLists({
  installMjsPath = INSTALL_MJS,
} = {}) {
  const mod = await import(pathToFileURL(installMjsPath).href);
  return {
    checkFiles: mod.ENFORCEMENT_CHECK_FILES,
    relayFiles: mod.ENFORCEMENT_RELAY_FILES,
  };
}

// Fixed-path raw copies install.mjs makes that are NOT members of the two
// exported arrays above (they are copyRawFile() calls with a literal
// target path instead). Citations name the function each copy happens in
// so this list can be re-verified against a future install.mjs by reading
// that function, not by trusting this comment forever.
const FIXED_RAW_COPIES = [
  // installEnforcementScripts(): copyRawFile(hooks/commit-msg), copyRawFile(hooks/pre-commit)
  "hooks/commit-msg",
  "hooks/pre-commit",
  // main() solo-full block: copyRawFile(.github/workflows/enforce.yml)
  ".github/workflows/enforce.yml",
  // main() solo-full block: copyRawFile(.gitleaks.toml), conditional on existsSync in the harness repo (it exists)
  ".gitleaks.toml",
];

// Installer-sourced but NOT byte-identical raw copies: writeTemplateFile()
// substitutes placeholders (verify.sh/observe.sh/SKILL.md) or a dedicated
// substitution function rewrites a constant (pm-guard.mjs via
// installPmGuard()). Formatting/lint debt in the template source still
// lands in the substituted output, so these need the same exemption.
const SUBSTITUTED_FROM_INSTALLER = [
  "scripts/check/pm-guard.mjs", // installPmGuard() -- substitutes CONTROL_ROOM_ROOT
  "verify.sh", // installProfileAgnosticCore(): writeTemplateFile(verify.sh.template)
  "observe.sh", // installProfileAgnosticCore(): writeTemplateFile(observe.sh.template)
  ".claude/skills/capture-context/SKILL.md", // installProfileAgnosticCore(): writeTemplateFile(skill/capture-context/SKILL.md)
  "templates/harness-init/project-context.template.md", // installProfileAgnosticCore(): copyRawFile (raw, bundled alongside the substituted .harness/PROJECT-CONTEXT.md)
];

// Present in this worktree, but install.mjs's copy-list source does NOT
// declare them (HYK-209 candidate: "설치기 단일 출처의 공백", coder-task.md
// 조건1). Each line is an explicit, individually-reasoned literal path --
// never a directory wildcard -- so frame-ignore-guard.test.mjs's RED check
// (a src/**|test/**|spec/** literal would fail that test) has something
// real to guard. Reason codes:
//   R1 = scripts/supervisor/* -- install.mjs never copies this directory at
//        all (main()'s own comments confirm: "install.mjs는 scripts/
//        supervisor/*를 전혀 복사하지 않는다").
//   R2 = scripts/relay/adapters/* -- same: install.mjs's own comments name
//        scripts/relay/adapters/orca-adapter.mjs as "이 저장소에 설치되지
//        않았다" (unattended/parallel layer, not yet shipped).
//   R3 = scripts/check/*.mjs present in this worktree but absent from the
//        exported ENFORCEMENT_CHECK_FILES array (computed, not asserted --
//        see buildGapList below for the actual computation; this array is
//        the residual after that computation is intersected with what
//        exists on disk today).
//   R4 = scripts/relay/*.mjs (non-adapter) present but absent from
//        ENFORCEMENT_RELAY_FILES, same shape as R3 for the relay/ dir.
const GAP_REASON = {
  R1: "scripts/supervisor/* -- install.mjs never copies this directory (installer gap, HYK-209 candidate)",
  R2: "scripts/relay/adapters/* -- install.mjs never copies this directory (installer gap, HYK-209 candidate)",
  R3: "scripts/check/*.mjs present on disk but absent from install.mjs's ENFORCEMENT_CHECK_FILES export (installer gap, HYK-209 candidate)",
  R4: "scripts/relay/*.mjs present on disk but absent from install.mjs's ENFORCEMENT_RELAY_FILES export (installer gap, HYK-209 candidate)",
};

// AGENTS.md is not a frame file at all (it predates this round on main) --
// its prettier violation lives in its PRE-EXISTING body (lines 1-29, see
// coder.md §5 diff evidence), not in the appended Harness section. This
// round does not own rewriting AGENTS.md's pre-existing prose, so the
// whole file is exempted rather than hand-editing content this round did
// not write.
const MANUAL_NON_FRAME = ["AGENTS.md"];

// New files THIS round authors (generator + its contrast test). They are
// this repo's own tooling, not harness frame content -- they must stay
// prettier/eslint-clean like any other new script, not get swept into the
// gap list just because install.mjs (obviously) has never heard of them.
const THIS_ROUND_OWN_FILES = new Set([
  "scripts/check/gen-frame-ignore.mjs",
  "scripts/check/frame-ignore-guard.test.mjs",
  ".prettierignore", // the generator's own output artifact, not a lint/fmt target (no matching extension) and not an installer gap
]);

// Directories this generator is allowed to scan for frame-shaped files.
// Deliberately NOT a whole-repo walk: src/, test/, spec/ (product code) and
// node_modules/, .git/, .harness/ (gitignored/out of scope) must never even
// be visited, let alone pattern-matched -- the exclusion happens by not
// walking there at all, not by filtering afterward, so a future directory
// rename can't silently widen this into product-code territory.
const SCAN_DIRS = [
  "scripts/check",
  "scripts/relay",
  "scripts/supervisor",
  "hooks",
  ".github/workflows",
  ".claude/skills",
  "templates/harness-init",
];
// Root-level frame files that are not inside any of the directories above.
const SCAN_ROOT_FILES = [
  ".gitleaks.toml",
  "eslint.config.mjs",
  "package-lock.json",
  "package.json",
  "observe.sh",
  "verify.sh",
  "AGENTS.md",
  ".gitignore",
];

function walk(relDir) {
  const abs = join(REPO_ROOT, relDir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...walk(rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

// Enumerates candidate frame files by walking known frame-owning directories
// on disk (SCAN_DIRS) plus a fixed root-file list (SCAN_ROOT_FILES) --
// deliberately NOT `git status` (HYK-304-frame-commit-1 live bug: once this
// round's own commit lands, every one of these files stops being "changed,"
// so a git-status-sourced list silently collapses to empty/near-empty on the
// very next run and overwrites .prettierignore / eslint.config.mjs with a
// wrong, smaller list -- caught by re-running this generator immediately
// after the commit and diffing against the committed tree, see coder.md).
function listWorktreeFrameFiles() {
  const files = SCAN_DIRS.flatMap(walk);
  for (const f of SCAN_ROOT_FILES) {
    if (existsSync(join(REPO_ROOT, f))) files.push(f);
  }
  return files.filter((f) => f !== "scripts/check-cases.mjs");
}

// Computes the gap list (R3/R4/R1/R2) by set-subtracting the installer's
// declared surface from what actually sits on disk in this worktree --
// this is the mechanical check GAP_REASON's comments describe, run live
// rather than trusted from memory.
function buildGapList(worktreeFiles, checkFiles, relayFiles) {
  const declared = new Set([
    ...checkFiles.map((f) => `scripts/check/${f}`),
    ...relayFiles.map((f) => `scripts/relay/${f}`),
    ...FIXED_RAW_COPIES,
    ...SUBSTITUTED_FROM_INSTALLER,
    ...MANUAL_NON_FRAME,
    "package.json",
    "package-lock.json",
    "eslint.config.mjs",
    ".gitignore",
  ]);
  const gap = [];
  for (const f of worktreeFiles) {
    if (declared.has(f) || THIS_ROUND_OWN_FILES.has(f)) continue;
    let reason;
    if (f.startsWith("scripts/supervisor/")) reason = GAP_REASON.R1;
    else if (f.startsWith("scripts/relay/adapters/")) reason = GAP_REASON.R2;
    else if (f.startsWith("scripts/check/")) reason = GAP_REASON.R3;
    else if (f.startsWith("scripts/relay/")) reason = GAP_REASON.R4;
    else reason = "uncategorized gap -- see coder.md for manual review";
    gap.push({ path: f, reason });
  }
  return gap.sort((a, b) => a.path.localeCompare(b.path));
}

export async function computeIgnoreList({
  installMjsPath = INSTALL_MJS,
  worktreeFiles,
} = {}) {
  const { checkFiles, relayFiles } = await loadInstallerCopyLists({
    installMjsPath,
  });
  const declaredPaths = [
    ...checkFiles.map((f) => `scripts/check/${f}`),
    ...relayFiles.map((f) => `scripts/relay/${f}`),
    ...FIXED_RAW_COPIES,
    ...SUBSTITUTED_FROM_INSTALLER,
  ];
  const files = worktreeFiles ?? listWorktreeFrameFiles();
  const gap = buildGapList(files, checkFiles, relayFiles);
  const allPaths = [
    ...new Set([
      ...declaredPaths,
      ...gap.map((g) => g.path),
      ...MANUAL_NON_FRAME,
    ]),
  ].sort((a, b) => a.localeCompare(b));
  return { allPaths, gap, declaredPaths };
}

const PRETTIERIGNORE_HEADER = `# GENERATED FILE -- do not hand-edit, re-run: node scripts/check/gen-frame-ignore.mjs
#
# Source: templates/harness-init/install.mjs's ENFORCEMENT_CHECK_FILES /
# ENFORCEMENT_RELAY_FILES exports (single source of truth for which files
# the harness installer places in a target repo), plus a small,
# individually-reasoned residual of files present in this worktree but not
# yet declared by that source (installer gap, HYK-209 candidate -- see
# scripts/check/gen-frame-ignore.mjs's GAP_REASON comments).
#
# Reason: these are harness frame files, not this repo's product code.
# Their pre-existing formatting/lint debt belongs to the harness repo, not
# to HYK-304-frame-commit-1, which only commits them -- it must not run
# \`prettier --write\` / \`eslint --fix\` on frame content (coder-task.md
# 조건3).
#
# Sunset: remove this file (or entries from it) once install.mjs's own
# source is formatting/lint-clean, or once the installer ships its own
# ignore-list mechanism -- whichever lands first.
`;

const ESLINT_BLOCK_START =
  "  // BEGIN GENERATED FRAME IGNORES -- scripts/check/gen-frame-ignore.mjs, do not hand-edit. See .prettierignore's header for source/reason/sunset.\n";
const ESLINT_BLOCK_END = "  // END GENERATED FRAME IGNORES\n";

function renderEslintBlock(allPaths) {
  const lines = allPaths.map((p) => `      ${JSON.stringify(p)},`).join("\n");
  return (
    ESLINT_BLOCK_START +
    "  {\n" +
    "    ignores: [\n" +
    lines +
    "\n    ],\n" +
    "  },\n" +
    ESLINT_BLOCK_END
  );
}

export function writePrettierIgnore(
  allPaths,
  { path = join(REPO_ROOT, ".prettierignore") } = {},
) {
  const body = allPaths.join("\n") + "\n";
  writeFileSync(path, PRETTIERIGNORE_HEADER + "\n" + body, "utf8");
  return path;
}

export function updateEslintConfig(
  allPaths,
  { path = join(REPO_ROOT, "eslint.config.mjs") } = {},
) {
  // core.autocrlf=true (this repo, Windows checkouts) rewrites LF -> CRLF on
  // disk, but the markers below are LF-literal -- normalize to LF before
  // searching/splicing, and write LF back out (git normalizes LF -> CRLF on
  // the next checkout the same way every other frame .mjs file already
  // does; this generator must not special-case itself).
  const current = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const startIdx = current.indexOf(ESLINT_BLOCK_START);
  const endIdx = current.indexOf(ESLINT_BLOCK_END);
  const block = renderEslintBlock(allPaths);
  let next;
  if (startIdx !== -1 && endIdx !== -1) {
    next =
      current.slice(0, startIdx) +
      block +
      current.slice(endIdx + ESLINT_BLOCK_END.length);
  } else {
    // First run: insert as the array's first element (right after `export
    // default [`), so the block sits ahead of every `files:`-scoped
    // override -- global ignores (no `files` key) apply regardless of
    // position, but keeping it first makes the generated section easy to
    // find by eye.
    const marker = "export default [\n";
    const at = current.indexOf(marker);
    if (at === -1) {
      throw new Error(
        `updateEslintConfig: could not find ${JSON.stringify(marker)} in ${path}`,
      );
    }
    next =
      current.slice(0, at + marker.length) +
      block +
      current.slice(at + marker.length);
  }
  writeFileSync(path, next, "utf8");
  return path;
}

async function main() {
  const { allPaths, gap } = await computeIgnoreList();
  const prettierPath = writePrettierIgnore(allPaths);
  const eslintPath = updateEslintConfig(allPaths);
  console.log(`wrote ${prettierPath} (${allPaths.length} entries)`);
  console.log(`wrote ${eslintPath} (generated ignores block updated)`);
  console.log(
    `gap (installer source does not declare, ${gap.length} entries):`,
  );
  for (const g of gap) console.log(`  ${g.path} -- ${g.reason}`);
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/gen-frame-ignore.mjs");
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.stack);
    process.exit(1);
  });
}
