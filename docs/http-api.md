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
| `issueId` | only events grouped into this issue |
| `from` / `to` | ISO timestamps |
| `page` / `limit` | default `1` / `50`, max limit `500` |

```json
{ "logs": [ { "id": "…", "projectId": "…", "level": "error", "message": "…", "source": "…", "environment": "…",
              "meta": { }, "timestamp": "…", "createdAt": "…" } ],
  "total": 1234, "page": 1, "limit": 50, "hasMore": true }
```

## `GET /api/v1/logs/stream`

Server-Sent Events stream of **newly ingested** logs — this is what the dashboard's *Live* toggle uses. Same auth and
filters as `GET /api/v1/logs` (`projectId`, `level`, `source`, `environment`, `search`, `from`, `to`; no paging).

```
$ curl -N -H "Authorization: Bearer $LOGSETU_API_KEY" "https://logs.example.com/api/v1/logs/stream?level=error,fatal"
retry: 3000
event: ready
data: {}

event: logs
data: [{"id":"…","level":"error","message":"…","timestamp":"…", …}]

: ping
```

- `event: logs` carries a JSON array (one ingest batch, filtered). Comment lines (`: ping`) are sent every 15s.
- On reconnect the stream does not replay missed logs — re-query `GET /api/v1/logs` after a `ready` event.
- The event bus is in-process: with several server replicas behind a load balancer, a stream only sees logs ingested
  by its own replica.

## Issues (error grouping)

Every `error` / `fatal` log is fingerprinted and grouped into an **issue**. The fingerprint is built from:

1. `meta.fingerprint` (string or array of strings) if the SDK sent one — full control over grouping;
2. otherwise, the log's `source` + exception type + stack frames (function + file; line numbers, bundle hashes and
   absolute paths are ignored so the same bug groups across deploys). Stacks are read from `meta.stack` (also
   `stacktrace`, `traceback`, `exc_text`, `error.stack`) — both SDKs send this automatically;
3. with no stack: `source` + the first line of the message with numbers, UUIDs, emails, URLs, IPs and quoted values
   normalized away (`"User 42 not found"` and `"User 97 not found"` are one issue).

Resolved issues reopen automatically when a new event arrives; ignored issues keep counting but stay out of the open
list. Issues whose last event is older than the project's retention window are deleted with their logs.

### `GET /api/v1/issues`

Admin session or project API key. Query: `projectId`, `status` (`open` default · `resolved` · `ignored` · `all`),
`sort` (`lastSeen` default · `firstSeen` · `count`), `search` (title substring), `page`, `limit` (max 100).

```json
{ "issues": [ { "id": "…", "title": "TypeError: x is undefined", "culprit": "checkout (chunks/cart.js)",
                "level": "error", "source": "web", "status": "open", "count": 214, "last24h": 12,
                "firstSeen": "…", "lastSeen": "…", "resolvedAt": null } ],
  "total": 3, "page": 1, "limit": 50, "hasMore": false, "counts": { "open": 3, "resolved": 5, "ignored": 1 } }
```

Events for an issue: `GET /api/v1/logs?projectId=…&issueId=…`.

### `GET /api/v1/issues/:id` · `PATCH /api/v1/issues/:id` · `DELETE /api/v1/issues/:id`

`GET` works with an admin session or the project's API key. `PATCH { "status": "resolved" | "ignored" | "open" }` and
`DELETE` (events are kept, just ungrouped) require the admin session.

## Alerts (admin session only)

Alert rules notify a **Slack** incoming webhook, **email** recipients (needs `LOGSETU_SMTP_URL`) or any **webhook**.
Two triggers:

- `threshold` — at least `threshold` logs matching `levels` (and optional `source` / `environment`) within the last
  `windowMinutes`. Evaluated a moment after matching logs arrive (at most every 10s per rule).
- `new_issue` — an error/fatal [issue](#issues-error-grouping) is created, or a resolved one regresses.

After firing, a rule stays quiet for `cooldownMinutes` (use `0` to get every new issue).

| Method | Path | Body / notes |
|---|---|---|
| `GET` | `/api/v1/alerts?projectId=…` | `{ rules, events, emailConfigured, publicUrlConfigured }` — `events` = last 30 notifications |
| `POST` | `/api/v1/alerts` | `{ projectId, name, channel: "slack"\|"email"\|"webhook", target, trigger?, levels?, threshold?, windowMinutes?, cooldownMinutes?, source?, environment?, enabled? }` |
| `PATCH` | `/api/v1/alerts/:id` | any subset of the fields above |
| `DELETE` | `/api/v1/alerts/:id` | |
| `POST` | `/api/v1/alerts/:id/test` | sends a test notification now (`502` + `{ ok: false, error }` if delivery fails) |

Defaults: `trigger: "threshold"`, `levels: ["error","fatal"]`, `threshold: 10`, `windowMinutes: 5`,
`cooldownMinutes: 15`. For email, `target` is a comma-separated list of addresses.

Webhook deliveries are a JSON `POST` (10s timeout; non-2xx counts as a failure and shows in the history):

```json
{
  "title": "[LogSetu] acme-storefront: Error spike",
  "text": "12 error/fatal logs in the last 5 min — threshold is 10.\n• [error] api: Redis timeout …",
  "url": "https://logs.example.com/dashboard?project=…&level=error,fatal&range=1h",
  "event": "threshold",
  "rule": { "id": "…", "name": "Error spike", "levels": ["error","fatal"], "threshold": 10, "windowMinutes": 5 },
  "project": { "id": "…", "name": "acme-storefront" },
  "count": 12,
  "samples": [ { "level": "error", "message": "…", "source": "api", "timestamp": "…" } ]
}
```

`new_issue` payloads have `"event": "new_issue"` and an `issues` array (`kind: "new" | "regression"`, title, culprit,
count, …). `url` is only set when `LOGSETU_PUBLIC_URL` is configured. Alerts are evaluated in-process, so run a single
server replica (or accept that each replica only alerts on the logs it ingested).

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
