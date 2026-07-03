#!/usr/bin/env bash
set -euo pipefail

echo "[verify] case safety check..."
node scripts/check-cases.mjs

echo "[verify] tests..."
node --test

echo "[verify] PASS"
