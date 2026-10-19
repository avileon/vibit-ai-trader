#!/usr/bin/env bash
# Checks: API health, DB, worker heartbeat, paper mode.  Exit 1 on failure.
set -euo pipefail
URL="${1:-http://127.0.0.1:3000}"
j=$(curl -fsS "$URL/api/health") || { echo "FAIL: API unreachable"; exit 1; }
echo "$j"
echo "$j" | grep -q '"status":"ok"' || { echo "FAIL: DB"; exit 1; }
echo "$j" | grep -q '"tradingMode":"paper"' || { echo "FAIL: not paper"; exit 1; }
echo "$j" | grep -q '"alive":true' || { echo "FAIL: worker heartbeat stale"; exit 1; }
echo "OK"
