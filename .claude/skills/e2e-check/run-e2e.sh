#!/usr/bin/env bash
# Runs a Playwright flow script against a production build using the eventhub_e2e database.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="${1:-$ROOT/.claude/skills/e2e-check/smoke.cjs}"
PORT="${E2E_PORT:-3100}"
BASE_URL="$(grep -E '^DATABASE_URL=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)"
BASE_URL="${BASE_URL:-postgresql://eventhub:eventhub@localhost:5432/eventhub}"
E2E_DB_URL="${E2E_DATABASE_URL:-${BASE_URL%/*}/eventhub_e2e}"
case "$E2E_DB_URL" in *_e2e) ;; *) echo "Refusing: E2E database name must end in _e2e ($E2E_DB_URL)"; exit 1 ;; esac

cd "$ROOT"
psql "${BASE_URL%/*}/postgres" -qtc "select 1 from pg_database where datname='eventhub_e2e'" | grep -q 1 \
  || psql "${BASE_URL%/*}/postgres" -qc "create database eventhub_e2e" >/dev/null
npx tsx scripts/migrate.ts "$E2E_DB_URL" >/dev/null
psql "$E2E_DB_URL" -qc "TRUNCATE users, events, otp_challenges, dev_outbox, audit_logs, rate_events, storage_deletions, event_metrics RESTART IDENTITY CASCADE" 2>/dev/null

if [ "${SKIP_BUILD:-0}" != "1" ]; then npm run build >/dev/null; fi
if curl -s -o /dev/null "http://localhost:$PORT/login"; then echo "Port $PORT is already in use (a leftover server?). Stop it first."; exit 1; fi
LOG="$(mktemp)"
# Production mode requires a field-encryption key (ADR-0019); a throwaway one per run is fine here.
export DATA_ENCRYPTION_KEY="${DATA_ENCRYPTION_KEY:-$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")}"
DATABASE_URL="$E2E_DB_URL" ALLOW_DEV_DELIVERY=1 STORAGE_DRIVER=fs APP_URL="http://localhost:$PORT" PORT="$PORT" setsid "$ROOT/node_modules/.bin/next" start >"$LOG" 2>&1 &
SERVER=$!
# Kill the whole process group: next-server outlives its parent, and a leftover server
# would make the next run silently test the old build.
trap 'kill -- -$SERVER 2>/dev/null || kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do curl -s -o /dev/null "http://localhost:$PORT/login" && break; sleep 0.5; done

NODE_PATH="$ROOT/node_modules:$(npm root -g)" E2E_BASE="http://localhost:$PORT" E2E_DATABASE_URL="$E2E_DB_URL" node "$SCRIPT"
