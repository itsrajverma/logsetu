"""Framework-neutral helpers shared by the Flask and ASGI (FastAPI / Starlette) integrations."""

from __future__ import annotations

import logging
import traceback
import uuid
from typing import Any, Dict, Iterable, Optional, Tuple

from .client import LogSetuClient, get_client
from .conf import DEFAULT_REDACT_HEADERS
from .handler import LogSetuHandler


def make_client(
    api_key: Optional[str],
    endpoint: Optional[str],
    *,
    environment: str,
    source: str,
    debug: bool = False,
    client: Optional[LogSetuClient] = None,
) -> LogSetuClient:
    if client is not None:
        return client
    return get_client(api_key or "", endpoint or "", environment=environment, source=source, debug=debug)


def attach_handler(client: LogSetuClient, level: int, logger: Optional[logging.Logger] = None) -> LogSetuHandler:
    """Attach a ``LogSetuHandler`` sharing *client* to *logger* (root by default), once."""
    target = logger or logging.getLogger()
    for h in target.handlers:
        if isinstance(h, LogSetuHandler) and h.client is client:
            return h
    handler = LogSetuHandler(client.api_key, client.endpoint, environment=client.environment, source=client.source,
                             level=level, client=client)
    target.addHandler(handler)
    if target.level == logging.NOTSET or target.level > level:
        target.setLevel(level)
    return handler


def request_id(headers: Dict[str, str]) -> str:
    return headers.get("x-request-id") or uuid.uuid4().hex[:16]


def client_ip(headers: Dict[str, str], remote_addr: Optional[str]) -> Optional[str]:
    forwarded = headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return remote_addr


def redact(headers: Iterable[Tuple[str, str]], redact_headers: Iterable[str] = DEFAULT_REDACT_HEADERS) -> Dict[str, str]:
    hidden = {h.lower() for h in redact_headers}
    return {k.lower(): ("[REDACTED]" if k.lower() in hidden else str(v)[:500]) for k, v in headers}


def mark_reported(exc: BaseException) -> None:
    """Flag *exc* so ``LogSetuHandler`` drops the framework's own log record for it (no duplicates)."""
    try:
        exc._logsetu_reported = True  # type: ignore[attr-defined]
    except Exception:  # pragma: no cover - exceptions with __slots__
        pass


def exception_meta(exc: BaseException) -> Dict[str, Any]:
    return {
        "exception": type(exc).__name__,
        "stack": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
    }
