# OpenTelemetry export

LogSetu can forward every log it ingests to any [OTLP](https://opentelemetry.io/docs/specs/otlp/) collector or
backend that accepts OTLP/HTTP — the OpenTelemetry Collector, Grafana Alloy / Loki, Honeycomb, Datadog, New Relic,
SigNoz, Axiom, etc. LogSetu keeps its own copy; the export is fire-and-forget alongside it.

## Enable it

```bash
LOGSETU_OTLP_ENDPOINT=http://otel-collector:4318            # base URL; /v1/logs is appended
# LOGSETU_OTLP_ENDPOINT=https://otlp.example.com/v1/logs    # …or the full logs URL
LOGSETU_OTLP_HEADERS=Authorization=Bearer%20xyz,x-tenant=acme  # optional, comma-separated k=v (URL-encode values)
LOGSETU_OTLP_PROJECTS=acme-storefront,billing               # optional: only these projects (names or ids)
LOGSETU_OTLP_INTERVAL_MS=2000                               # optional: flush interval
```

Restart the server; it logs `exporting logs to OTLP collector at …` on boot. Check health at any time (admin session):

```bash
curl -b cookies.txt https://logs.example.com/api/v1/otlp/status
# {"enabled":true,"url":"http://otel-collector:4318/v1/logs","queued":0,"exported":18234,"dropped":0,
#  "failedBatches":0,"lastSuccessAt":"…","lastError":null}
```

## Mapping

| LogSetu | OTLP |
|---|---|
| `source` | resource `service.name` |
| `environment` | resource `deployment.environment.name` |
| project | resource `logsetu.project.id`, `logsetu.project.name` |
| `timestamp` / `createdAt` | `timeUnixNano` / `observedTimeUnixNano` |
| `level` | `severityNumber` + `severityText` (`debug`=5, `info`=9, `warn`=13, `error`=17, `fatal`=21) |
| `message` | `body` (string) |
| `meta.*` | log attributes (numbers, booleans, arrays and nested objects keep their types) |
| `meta.stack` / `meta.exception` | `exception.stacktrace` / `exception.type` |
| `meta.traceId` / `meta.spanId` (or `trace_id` / `span_id`) | `traceId` / `spanId` — correlates logs with your traces |
| issue (error grouping) | attribute `logsetu.issue.id` |

## Delivery

Logs are batched (up to 512 per request) using the JSON encoding of OTLP/HTTP. Requests that fail with `429`, `502`,
`503` or `504` — or with network errors — are retried with backoff (honouring `Retry-After`), up to 4 attempts. The
in-memory queue holds at most 10,000 logs; beyond that the oldest are dropped and counted in `dropped`. Export runs
in-process, so each server replica forwards the logs it ingested.

## Example: OpenTelemetry Collector

```yaml
# otelcol.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
  # otlphttp/loki: { endpoint: http://loki:3100/otlp }
service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [debug]
```

```yaml
# docker-compose.override.yml
services:
  logsetu:
    environment:
      LOGSETU_OTLP_ENDPOINT: http://otelcol:4318
  otelcol:
    image: otel/opentelemetry-collector-contrib:latest
    volumes: ["./otelcol.yaml:/etc/otelcol-contrib/config.yaml"]
```
