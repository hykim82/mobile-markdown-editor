#!/usr/bin/env bash
set -euo pipefail

# node 실행기 확정. 셸에 따라 node / node.exe(WSL interop)를 자동 선택한다.
# 검증을 약화하지 않고 실행기만 잡는다(테스트·케이스 통과 기준 불변).
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE="node"
elif command -v node.exe >/dev/null 2>&1; then
  NODE="node.exe"
else
  for d in "/mnt/c/Program Files/nodejs" "/c/Program Files/nodejs" "/usr/local/bin"; do
    if [ -x "$d/node" ]; then NODE="$d/node"; break; fi
    if [ -x "$d/node.exe" ]; then NODE="$d/node.exe"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  echo "[verify] FAIL: node 실행기를 찾을 수 없습니다 (node / node.exe)." >&2
  exit 127
fi
echo "[verify] node runner: $NODE"

echo "[verify] case safety check..."
"$NODE" scripts/check-cases.mjs

echo "[verify] tests..."
"$NODE" --test

echo "[verify] PASS"
