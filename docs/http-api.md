# HTTP API

Base URL: your LogSetu server, e.g. `http://localhost:8686`. All bodies and responses are JSON.

## Authentication

| Who | How |
|---|---|
| SDKs / your apps | `Authorization: Bearer <project api key>` (or `X-Api-Key: <key>`, or `?apiKey=<key>` for beacons) |
| Dashboard | Session cookie set by `POST /api/auth/login` |

API keys are scoped to one project: they can ingest into it and read its logs/stats, nothing else.
Project management requires the admin session.

## `POST /api/v1/ingest`

Accepts a single log, an array, or `{ "logs": [...] }` (max 500 per request). Returns **202** immediately;
persistence happens after the response is sent.

```json
{
  "level": "error",                 // debug | info | warn | error | fatal (case-insensitive). Default "info"
  "message": "Payment failed",      // required, ≤ 10 000 chars
  "source": "nextjs-api",           // optional, default "unknown"
  "environment": "production",      // optional, default "production"
  "timestamp": "2026-09-19T08:00:00Z", // optional ISO string, unix seconds or ms. Default: now
  "meta": { "orderId": 456, "stack": "Error: ..." } // optional object, ≤ 64 KB serialized
}
```

Responses:

| Status | Body |
|---|---|
| `202` | `{ "accepted": 3 }` |
| `400` | `{ "error": "Validation failed", "details": [{ "path": "0.level", "message": "…" }] }` |
| `401` | `{ "error": "Invalid or missing API key" }` |
| `429` | `{ "error": "Rate limit exceeded", "details": { "retryAfterSeconds": 42 } }` + `Retry-After` header |

Tip: put stack traces under `meta.stack` (or `stacktrace` / `traceback`) — the dashboard renders those keys as a
formatted trace.

## `GET /api/v1/logs`

Newest first. Admin session or project API key (the key's project is enforced regardless of `projectId`).

| Query param | Description |
|---|---|
| `projectId` | required for admin callers |
| `level` | comma-separated: `error,fatal` |
| `source` / `environment` | exact match |
| `search` | substring match on message (case-insensitive) |
| `from` / `to` | ISO timestamps |
| `page` / `limit` | default `1` / `50`, max limit `500` |

```json
{ "logs": [ { "id": "…", "projectId": "…", "level": "error", "message": "…", "source": "…", "environment": "…",
              "meta": { }, "timestamp": "…", "createdAt": "…" } ],
  "total": 1234, "page": 1, "limit": 50, "hasMore": true }
```

## `GET /api/v1/projects/:id/stats`

Admin session or that project's API key.

```json
{
  "total": 120345,
  "last24h": { "debug": 10, "info": 300, "warn": 20, "error": 4, "fatal": 0 },
  "series": [ { "bucket": "2026-09-18T09:00:00.000Z", "counts": { "debug": 1, "info": 12, "warn": 0, "error": 0, "fatal": 0 } }, … 24 items ],
  "sources": ["django-backend", "nextjs-web"],
  "environments": ["production", "staging"]
}
```

## Projects (admin session only)

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/api/v1/projects` | — | `{ projects: [{ id, name, apiKey, retentionDays, createdAt, logCount }] }` |
| `POST` | `/api/v1/projects` | `{ "name": "my-app" }` | `201` `{ project }` with a fresh `apiKey` |
| `GET` | `/api/v1/projects/:id` | — | |
| `PATCH` | `/api/v1/projects/:id` | `{ "name"?: "…", "rotateKey"?: true, "retentionDays"?: 1–3650 \| null }` | rotating invalidates the old key immediately; `retentionDays: null` falls back to the server default |
| `DELETE` | `/api/v1/projects/:id` | — | deletes the project **and all its logs** |

## Retention (admin session only)

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/api/v1/retention/run` | `{ "projectId"?: "…" }` | Run the cleanup now; returns `{ ranAt, projects: [{ id, name, retentionDays, deleted }], totalDeleted }` |
| `GET` | `/api/v1/retention/run` | — | `{ last }` — result of the most recent run |

The cleanup also runs automatically every `LOGSETU_RETENTION_INTERVAL_MINUTES` (default 60).

## Auth

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/auth/login` | `{ "password": "…" }` → sets `logsetu_session` cookie (7 days) |
| `POST` | `/api/auth/logout` | — |

## Health

`GET /api/health` → `{ "ok": true, "database": "sqlite" | "postgres", "version": "0.1.0" }` (503 if the DB is unreachable).
