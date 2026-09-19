# logsetu-django

Ship Django / DRF logs and unhandled errors to your self-hosted [LogSetu](https://github.com/itsrajverma/logsetu) server.
Zero runtime dependencies, non-blocking (background thread + batching), and it never crashes your app if the log server is down.

```bash
pip install logsetu-django
```

## Setup (2 minutes)

```python
# settings.py
INSTALLED_APPS = [..., "logsetu"]  # optional, but nice for discoverability

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {
        "logsetu": {
            "class": "logsetu.handler.LogSetuHandler",
            "api_key": env("LOGSETU_API_KEY"),        # from the LogSetu dashboard → Projects
            "endpoint": env("LOGSETU_ENDPOINT"),      # e.g. https://logs.example.com
            "environment": env("ENVIRONMENT", default="production"),
            "source": "django-backend",
            "level": "WARNING",
        },
    },
    "root": {"handlers": ["logsetu"], "level": "INFO"},
}

MIDDLEWARE = [
    ...,
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "logsetu.middleware.LogSetuMiddleware",   # after auth middleware so user ids are captured
]
```

That's it. Every `logging` call at or above the handler's level is sent to LogSetu, and the middleware
reports unhandled exceptions (and 5xx responses) with the request path, method, view, user, redacted headers and full traceback.

```python
import logging
log = logging.getLogger(__name__)

log.warning("Checkout is slow", extra={"duration_ms": 1830, "cart_items": 12})
try:
    charge(card)
except PaymentError:
    log.exception("Payment failed")          # traceback is attached automatically
```

## Multi-tenant apps

Tag every log with the current tenant by pointing the SDK at a callable `(request) -> str | None`:

```python
# settings.py
LOGGING["handlers"]["logsetu"]["get_tenant_id"] = "myapp.tenants.get_tenant_id"

# myapp/tenants.py
def get_tenant_id(request):
    return getattr(request, "tenant", None) and request.tenant.slug
```

Or, from anywhere inside a request (e.g. after you resolve the tenant in your own middleware):

```python
from logsetu import update_request_context
update_request_context(tenant_id=tenant.slug, plan=tenant.plan)
```

## Handler options

| Option | Default | Description |
|---|---|---|
| `api_key` / `endpoint` | — | Required (or set `LOGSETU = {"API_KEY": ..., "ENDPOINT": ...}` in settings) |
| `environment` | `"production"` | Tag on every log |
| `source` | `"django"` | Tag on every log; override per record with `extra={"source": "celery"}` |
| `get_tenant_id` | `None` | Dotted path or callable `(request) -> str` |
| `include_extra` | `True` | Forward `extra={...}` fields as metadata |
| `include_request_context` | `True` | Attach request id / path / method / tenant set by the middleware |
| `flush_interval` | `2.0` | Seconds between background flushes |
| `batch_size` | `10` | Flush as soon as this many logs are queued |
| `max_queue_size` | `1000` | Drop oldest logs beyond this |
| `max_retries` | `3` | Retries with exponential backoff on 5xx / network errors |
| `timeout` | `5.0` | HTTP timeout in seconds |
| `debug` | `False` | Print every transport failure to stderr (otherwise only the first) |

## Middleware options (`settings.LOGSETU`)

The middleware reuses the client and options of a configured `LogSetuHandler`. Without a handler it can run standalone:

```python
LOGSETU = {
    "API_KEY": env("LOGSETU_API_KEY"),
    "ENDPOINT": env("LOGSETU_ENDPOINT"),
    "ENVIRONMENT": "production",
    "SOURCE": "django-backend",
    "GET_TENANT_ID": "myapp.tenants.get_tenant_id",
    "REDACT_HEADERS": ["authorization", "cookie", "x-api-key"],  # defaults already cover these
    "CAPTURE_5XX": True,   # also report 5xx responses that didn't raise
}
```

Every request gets a `request_id` (taken from `X-Request-ID` if present, otherwise generated) which is
attached to all logs emitted during that request and exposed as `request.logsetu_request_id`.

## Guarantees

- **Never blocks** the request cycle: `emit()` only appends to an in-memory queue.
- **Never raises** into your app: transport errors are printed once to stderr, then suppressed.
- **Never leaks secrets**: `Authorization`, `Cookie`, `X-Api-Key`, `X-CSRFToken` and `Proxy-Authorization` are redacted.
- **Never loses the last logs** on shutdown: the queue is flushed via `atexit`.

## Celery / management commands

Nothing special — the handler works anywhere Python's `logging` does. Set `extra={"source": "celery"}` to distinguish
workers, or configure a second handler with a different `source`.

## License

MIT
