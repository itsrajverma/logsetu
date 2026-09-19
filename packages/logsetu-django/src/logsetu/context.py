"""Per-request context (path, user, tenant, request id) shared between middleware and handler.

Backed by ``contextvars`` so it works for both sync (threaded) and async Django.
"""

from __future__ import annotations

import contextvars
from typing import Any, Dict, Optional

_request_context: contextvars.ContextVar[Optional[Dict[str, Any]]] = contextvars.ContextVar(
    "logsetu_request_context", default=None
)


def set_request_context(ctx: Optional[Dict[str, Any]]) -> contextvars.Token:
    return _request_context.set(ctx)


def reset_request_context(token: contextvars.Token) -> None:
    try:
        _request_context.reset(token)
    except ValueError:  # token from another context (async edge cases)
        _request_context.set(None)


def get_request_context() -> Dict[str, Any]:
    return dict(_request_context.get() or {})


def update_request_context(**fields: Any) -> None:
    """Attach extra fields (e.g. tenant_id) to every log emitted during the current request."""
    current = _request_context.get()
    merged = dict(current or {})
    merged.update(fields)
    _request_context.set(merged)
