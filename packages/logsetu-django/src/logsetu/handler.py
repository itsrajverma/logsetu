"""``logging.Handler`` that ships records to LogSetu.

Configure it through Django's ``LOGGING`` dict (or ``logging.config.dictConfig``)::

    "handlers": {
        "logsetu": {
            "class": "logsetu.handler.LogSetuHandler",
            "api_key": env("LOGSETU_API_KEY"),
            "endpoint": env("LOGSETU_ENDPOINT"),
            "environment": "production",
            "source": "django-backend",
            "level": "WARNING",
            # optional:
            # "get_tenant_id": "myapp.tenants.get_tenant_id",
        },
    },
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, Union

from .client import LogSetuClient, get_client
from .conf import TenantGetter, django_settings, import_callable
from .context import get_request_context

LEVEL_MAP = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",
    logging.ERROR: "error",
    logging.CRITICAL: "fatal",
}

# Attributes every LogRecord has; anything else came from ``extra=`` and is forwarded as meta.
_STANDARD_ATTRS = frozenset(
    {
        "name", "msg", "args", "levelname", "levelno", "pathname", "filename", "module", "exc_info", "exc_text",
        "stack_info", "lineno", "funcName", "created", "msecs", "relativeCreated", "thread", "threadName",
        "processName", "process", "message", "asctime", "taskName",
    }
)


def level_name(levelno: int) -> str:
    if levelno >= logging.CRITICAL:
        return "fatal"
    if levelno >= logging.ERROR:
        return "error"
    if levelno >= logging.WARNING:
        return "warn"
    if levelno >= logging.INFO:
        return "info"
    return "debug"


class LogSetuHandler(logging.Handler):
    """Send Python logging records to a LogSetu server, batched on a background thread."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
        *,
        environment: Optional[str] = None,
        source: Optional[str] = None,
        level: Union[int, str] = logging.NOTSET,
        get_tenant_id: Union[str, TenantGetter, None] = None,
        include_extra: bool = True,
        include_request_context: bool = True,
        flush_interval: float = 2.0,
        batch_size: int = 10,
        max_queue_size: int = 1000,
        max_retries: int = 3,
        timeout: float = 5.0,
        debug: bool = False,
        client: Optional[LogSetuClient] = None,
    ) -> None:
        super().__init__(level)
        cfg = django_settings()
        self.api_key = api_key or cfg.get("API_KEY") or ""
        self.endpoint = endpoint or cfg.get("ENDPOINT") or ""
        self.environment = environment or cfg.get("ENVIRONMENT") or "production"
        self.source = source or cfg.get("SOURCE") or "django"
        self.include_extra = include_extra
        self.include_request_context = include_request_context
        self.get_tenant_id: Optional[Callable[[Any], Optional[str]]] = import_callable(
            get_tenant_id or cfg.get("GET_TENANT_ID")
        )
        self.client = client or get_client(
            self.api_key,
            self.endpoint,
            environment=self.environment,
            source=self.source,
            flush_interval=flush_interval,
            batch_size=batch_size,
            max_queue_size=max_queue_size,
            max_retries=max_retries,
            timeout=timeout,
            debug=bool(debug or cfg.get("DEBUG", False)),
        )

    def emit(self, record: logging.LogRecord) -> None:
        try:
            # Django's own ``django.request`` logger re-logs 5xx responses; skip those the
            # middleware already reported with richer context.
            req = record.__dict__.get("request")
            if req is not None and getattr(req, "_logsetu_reported", False):
                return
            self.client.enqueue(self.build_entry(record))
        except Exception:
            self.handleError(record)

    def build_entry(self, record: logging.LogRecord) -> Dict[str, Any]:
        meta: Dict[str, Any] = {
            "logger": record.name,
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
            "process": record.process,
            "thread": record.threadName,
        }
        if record.exc_info:
            exc_type = record.exc_info[0]
            meta["exception"] = exc_type.__name__ if exc_type else None
            if not record.exc_text:
                record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            meta["stack"] = record.exc_text
        if record.stack_info:
            meta["stack_info"] = record.stack_info
        if self.include_extra:
            for key, value in record.__dict__.items():
                if key not in _STANDARD_ATTRS and not key.startswith("_") and key not in meta:
                    meta[key] = _summarize_request(value) if key == "request" else value
        if self.include_request_context:
            ctx = get_request_context()
            if ctx:
                meta["request"] = ctx
                if "tenant_id" in ctx and "tenant_id" not in meta:
                    meta["tenant_id"] = ctx["tenant_id"]
        # Allow logger.info("...", extra={"source": "celery"}) to override per-record.
        source = meta.pop("source", None) or self.source
        environment = meta.pop("environment", None) or self.environment
        return {
            "level": level_name(record.levelno),
            "message": self.format_message(record),
            "source": str(source),
            "environment": str(environment),
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "meta": _json_safe(meta),
        }

    def format_message(self, record: logging.LogRecord) -> str:
        try:
            msg = record.getMessage()
        except Exception:
            msg = str(record.msg)
        return msg[:10_000]

    def flush(self) -> None:
        self.client.flush(timeout=5.0)

    def close(self) -> None:
        try:
            self.client.flush(timeout=5.0)
        finally:
            super().close()


def _summarize_request(value: Any) -> Any:
    """``extra={"request": HttpRequest}`` (as Django does) → a small dict instead of a repr."""
    meta = getattr(value, "META", None)
    if not isinstance(meta, dict):
        return value
    return {
        "method": getattr(value, "method", None),
        "path": getattr(value, "path", None),
        "query": meta.get("QUERY_STRING", "")[:2000],
    }


def _json_safe(meta: Dict[str, Any]) -> Dict[str, Any]:
    from .client import to_json_safe

    return {k: to_json_safe(v) for k, v in meta.items() if v is not None}
