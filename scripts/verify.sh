#!/usr/bin/env bash
set -euo pipefail

# node가 PATH에 없는 셸(일부 샌드박스/로그인 셸) 보정 — 검증을 약화하지 않고 실행 경로만 확보한다.
if ! command -v node >/dev/null 2>&1; then
  for d in "/c/Program Files/nodejs" "/usr/local/bin"; do
    if [ -x "$d/node" ] || [ -x "$d/node.exe" ]; then PATH="$d:$PATH"; break; fi
  done
fi

echo "[verify] case safety check..."
node scripts/check-cases.mjs

echo "[verify] tests..."
node --test

echo "[verify] PASS"
