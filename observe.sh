#!/usr/bin/env sh
# Profile: solo-full ( solo-full | team-local )
#
# Two-layer split: verify.sh answers "does it build / pass its check suite"
# (verify.sh.template). This script, observe.sh, answers a different
# question -- "does the app actually come up and respond" -- by booting it,
# polling until it's ready, then hitting a handful of HTTP routes and
# reporting pass/fail. Scope is deliberately capped at curl/HTTP-level
# checks; a headless-browser render check is out of scope here (HYK-102) and
# left for a future issue if a project needs it.
#
# Every REPLACE_ME_* token below is project-specific and cannot be known at
# install time (unlike bash scripts/verify.sh and friends, which install.mjs
# substitutes from its own CLI flags) -- fill these in by hand once, using
# this harness's plain <UPPER_SNAKE> placeholder convention (HYK-97,
# see project-context.template.md): easy to grep for, and this script
# refuses to run at all while any of them are still unedited.
#
# POSIX sh only (no bashisms) -- must run under Windows Git Bash as well as
# a normal Linux/macOS shell. Only `$!`, `kill`, `trap`, and arithmetic
# expansion `$(( ))` are used from outside strict POSIX-sh baseline, all of
# which are standard sh, not bash extensions.

set -u

BASE_URL="REPLACE_ME_BASE_URL"                            # e.g. http://localhost:5173
BOOT_CMD="REPLACE_ME_BOOT_CMD"                             # e.g. npm run dev
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-30}"       # override via env var if needed

LIMITATION_NOTE="NOTE: this script only confirms HTTP status codes (and, optionally, a substring in the response body). HTTP 200 != client-side rendering or interaction working correctly. Anything this script cannot mechanically confirm (rendering, client-side behavior, visual correctness, etc.) belongs in the task report's 'limitations' section -- never claim it was 'verified' on the strength of this script alone."

print_note() {
  echo ""
  echo "$LIMITATION_NOTE"
}

# Guard: refuse to run against an unedited template. A bare REPLACE_ME_*
# string is never a valid URL or command, so failing loudly here beats a
# confusing curl/exec error further down.
case "$BASE_URL" in
  REPLACE_ME_*)
    echo "observe.sh: BASE_URL is still the unedited placeholder ('$BASE_URL') -- fill in REPLACE_ME_BASE_URL before running this script." >&2
    print_note
    exit 1
    ;;
esac
case "$BOOT_CMD" in
  REPLACE_ME_*)
    echo "observe.sh: BOOT_CMD is still the unedited placeholder ('$BOOT_CMD') -- fill in REPLACE_ME_BOOT_CMD before running this script." >&2
    print_note
    exit 1
    ;;
esac

# --- boot ---
# Backgrounded through `sh -c` (not `exec`) so this script keeps running
# after it, and its PID is kept so cleanup can stop it again below.
BOOT_PID=""
cleanup() {
  if [ -n "$BOOT_PID" ]; then
    kill "$BOOT_PID" >/dev/null 2>&1
    wait "$BOOT_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

sh -c "$BOOT_CMD" &
BOOT_PID=$!

# --- readiness polling ---
elapsed=0
ready=0
while [ "$elapsed" -lt "$READY_TIMEOUT_SECONDS" ]; do
  if curl -s -o /dev/null "$BASE_URL"; then
    ready=1
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

if [ "$ready" -ne 1 ]; then
  echo "observe.sh: FAIL -- '$BASE_URL' did not respond within ${READY_TIMEOUT_SECONDS}s" >&2
  print_note
  exit 1
fi

# --- machine checks ---
# check_http <path> <expected_status> [<must_contain>]
# Compares the HTTP status code (always) and, if a third argument is given,
# checks the response body contains that literal substring (plain `grep`,
# not a regex engine -- keeps this portable across curl/grep builds).
FAILURES=0
CHECKS_RAN=0

check_http() {
  path="$1"
  expected_status="$2"
  must_contain="${3:-}"
  url="${BASE_URL}${path}"
  body_file=$(mktemp)
  status=$(curl -s -o "$body_file" -w "%{http_code}" "$url")
  ok=1
  if [ "$status" != "$expected_status" ]; then
    echo "FAIL: $path -- expected status $expected_status, got $status"
    ok=0
  fi
  if [ -n "$must_contain" ] && ! grep -q -- "$must_contain" "$body_file"; then
    echo "FAIL: $path -- response body did not contain '$must_contain'"
    ok=0
  fi
  if [ "$ok" -eq 1 ]; then
    echo "PASS: $path ($status)"
  else
    FAILURES=$((FAILURES + 1))
  fi
  rm -f "$body_file"
  CHECKS_RAN=$((CHECKS_RAN + 1))
}

# REPLACE_ME_CHECKS -- replace this whole block with this project's real
# routes (delete the guard below once real checks are added). Example
# (TEAM10-style):
#   check_http "/" 200
#   check_http "/api/health" 200 "ok"
#   check_http "/no-such-route" 404

if [ "$CHECKS_RAN" -eq 0 ]; then
  echo "observe.sh: FAIL -- no checks defined yet. Replace the REPLACE_ME_CHECKS block above with real check_http calls for this project's routes." >&2
  print_note
  exit 1
fi

# --- verdict ---
print_note

if [ "$FAILURES" -gt 0 ]; then
  echo "observe.sh: FAIL -- $FAILURES check(s) failed"
  exit 1
fi

echo "observe.sh: PASS -- all checks passed"
exit 0
