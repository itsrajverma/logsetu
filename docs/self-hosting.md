# Self-hosting LogSetu

## Quick start (SQLite)

```bash
curl -o docker-compose.yml https://raw.githubusercontent.com/itsrajverma/logsetu/main/docker-compose.yml
LOGSETU_ADMIN_PASSWORD=change-me docker compose up -d
```

Open http://localhost:8686, sign in with the password, create a project and copy its API key.

Data is stored in the `logsetu-data` named volume (`/data/logsetu.db` inside the container). SQLite in WAL mode
comfortably handles a few million log lines per project on a small VPS.

## Production (Postgres)

```bash
curl -o docker-compose.prod.yml https://raw.githubusercontent.com/itsrajverma/logsetu/main/docker-compose.prod.yml
curl -o .env https://raw.githubusercontent.com/itsrajverma/logsetu/main/.env.example
# edit .env: LOGSETU_ADMIN_PASSWORD, LOGSETU_SECRET (openssl rand -hex 32), POSTGRES_PASSWORD
docker compose -f docker-compose.prod.yml up -d
```

Already have a Postgres? Use `docker-compose.yml` and set `DATABASE_URL=postgresql://user:pass@host:5432/logsetu`
in `.env` — the server picks the driver from the URL scheme.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `LOGSETU_ADMIN_PASSWORD` | — | **Required.** Dashboard password. |
| `LOGSETU_SECRET` | derived from the password | HMAC key for session cookies. Set a random 32+ char string in production so changing the password invalidates sessions predictably. |
| `DATABASE_URL` | `file:/data/logsetu.db` | `file:<path>` (SQLite) or `postgresql://…` |
| `LOGSETU_PORT` | `8686` | Host port mapping (compose only) |
| `LOGSETU_RATE_LIMIT_PER_MIN` | `1000` | Per-project ingestion limit. Exceeding it returns `429` with `Retry-After`; SDKs back off automatically. |
| `LOGSETU_SECURE_COOKIES` | `0` | Set to `1` when served over HTTPS so the session cookie gets the `Secure` flag. |

## Reverse proxy (HTTPS)

Point your proxy at port 8686 and set `LOGSETU_SECURE_COOKIES=1`. Example with Caddy:

```
logs.example.com {
    reverse_proxy localhost:8686
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name logs.example.com;
    location / {
        proxy_pass http://127.0.0.1:8686;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        client_max_body_size 5m;   # ingest batches
    }
}
```

The ingest endpoint sends permissive CORS headers so browser SDKs can post from any origin; the dashboard and query
APIs are cookie/API-key protected.

## Backups

- **SQLite**: `docker compose exec logsetu sh -c 'sqlite3 /data/logsetu.db ".backup /data/backup.db"'` or simply
  stop the container and copy the volume. WAL mode means copying the live `.db` file alone may miss recent writes.
- **Postgres**: standard `pg_dump` against the `db` service.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

Schema migrations are plain SQL files shipped in the image and applied automatically on start
(`apps/server/scripts/migrate.mjs`); already-applied migrations are tracked in `_logsetu_migrations`.

## Building the image yourself

```bash
git clone https://github.com/itsrajverma/logsetu && cd logsetu
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

## Running without Docker

```bash
pnpm install
pnpm --filter @logsetu/server build          # generates Prisma clients + Next.js build
cd apps/server
LOGSETU_ADMIN_PASSWORD=change-me DATABASE_URL=file:./data/logsetu.db node scripts/migrate.mjs
LOGSETU_ADMIN_PASSWORD=change-me DATABASE_URL=file:./data/logsetu.db pnpm start   # http://localhost:8686
```

Requires Node 20+ and build tools for `better-sqlite3` (prebuilt binaries cover most platforms).

## Resource usage

The container idles at ~80 MB RAM. Ingestion is bounded by SQLite write throughput (thousands of logs/second on
NVMe) — the API returns `202` immediately and persists in the background, so SDKs never wait on disk.

## Security notes

- API keys are stored in plaintext so they can be re-displayed in the dashboard; rotate a key from **Projects → Rotate key** if it leaks.
- The single admin password is compared in constant time; sessions are HMAC-signed cookies valid for 7 days.
- Log `meta` is stored as-is. Redact secrets in your SDK config (`beforeSend` in JS, `REDACT_HEADERS` in Django) before they leave your app.
