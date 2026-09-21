#!/usr/bin/env sh
# Profile: solo-full ( solo-full | team-local )
# Thin wrapper: run the profile's verification command and propagate its
# exit code unchanged. Profile-agnostic by design — solo-full points this at
# `scripts/check/*.test.mjs`, team-local points it at a build command; the
# wrapper itself does not branch on profile.
#
# Runs bash scripts/verify.sh through `sh -c` rather than `exec bash scripts/verify.sh` directly:
# a bare `exec` replaces this process with only the first word of
# bash scripts/verify.sh, so a compound command joined with `&&`/`;` (e.g. three
# `node ... && node ... && node ...` test suites) silently runs just the
# first piece and exits 0 without ever running the rest. `sh -c '...'`
# parses the whole substituted string as one shell command first — `&&`/`;`
# all execute — and `exec` then replaces this process with that `sh`, so its
# real exit code (of the *last* command run) still propagates unchanged.
exec sh -c 'bash scripts/verify.sh'
