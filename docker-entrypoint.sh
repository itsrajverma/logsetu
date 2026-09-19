#!/bin/sh
set -e
if [ -z "$LOGSETU_ADMIN_PASSWORD" ]; then
  echo "[logsetu] ERROR: LOGSETU_ADMIN_PASSWORD is not set. Add it to your .env or docker-compose.yml." >&2
  exit 1
fi
cd /app/apps/server
node scripts/migrate.mjs
echo "[logsetu] starting on http://0.0.0.0:${PORT:-8686}"
exec node server.js
