"""ASGI middleware for FastAPI, Starlette, Litestar, Quart and any other ASGI app.

::

    from fastapi import FastAPI
    from logsetu.asgi import LogSetuMiddleware

    app = FastAPI()
    app.add_middleware(
        LogSetuMiddleware,
        api_key=os.environ["LOGSETU_API_KEY"],
        endpoint=os.environ["LOGSETU_ENDPOINT"],
        source="fastapi",
    )

Every log emitted while a request is handled (through stdlib ``logging``) carries the request id, method and path;
unhandled exceptions and 5xx responses are reported with redacted headers. No dependency on Starlette itself.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Awaitable, Callable, Dict, Iterable, MutableMapping, Optional

from .client import LogSetuClient
from .conf import DEFAULT_REDACT_HEADERS, import_callable
from .context import get_request_context, reset_request_context, set_request_context
from .web import attach_handler, client_ip, exception_meta, make_client, mark_reported, redact, request_id

__all__ = ["LogSetuMiddleware"]

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


class LogSetuMiddleware:
    """Pure ASGI middleware (no ``BaseHTTPMiddleware``), so it doesn't buffer streaming responses."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
        environment: Optional[str] = None,
        source: Optional[str] = None,
        get_tenant_id: Any = None,
        capture_logging: bool = True,
        log_level: int = logging.WARNING,
        capture_5xx: bool = True,
        log_requests: bool = False,
        ignore_paths: Iterable[str] = (),
        redact_headers: Iterable[str] = DEFAULT_REDACT_HEADERS,
        debug: bool = False,
        client: Optional[LogSetuClient] = None,
    ) -> None:
        self.app = app
        self.environment = environment or os.environ.get("LOGSETU_ENVIRONMENT") or "production"
        self.source = source or os.environ.get("LOGSETU_SOURCE") or "asgi"
        self.client = make_client(
            api_key or os.environ.get("LOGSETU_API_KEY"),
            endpoint or os.environ.get("LOGSETU_ENDPOINT"),
            environment=self.environment,
            source=self.source,
            debug=debug,
            client=client,
        )
        if capture_logging:
            attach_handler(self.client, log_level)
        # Called with the ASGI scope; return a tenant id or None.
        self.get_tenant_id: Optional[Callable[[Scope], Any]] = import_callable(get_tenant_id)
        self.capture_5xx = capture_5xx
        self.log_requests = log_requests
        self.ignore_paths = frozenset(ignore_paths)
        self.redact_headers = tuple(redact_headers)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("path") in self.ignore_paths:
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
        ctx: Dict[str, Any] = {"request_id": request_id(headers), "method": scope.get("method"), "path": scope.get("path")}
        client_addr = scope.get("client")
        ip = client_ip(headers, client_addr[0] if client_addr else None)
        if ip:
            ctx["ip"] = ip
        if self.get_tenant_id is not None:
            try:
                tenant = self.get_tenant_id(scope)
                if tenant is not None:
                    ctx["tenant_id"] = str(tenant)
            except Exception:
                pass
        scope.setdefault("state", {})["logsetu_request_id"] = ctx["request_id"]

        status = 0
        started = time.monotonic()

        async def send_wrapper(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = int(message["status"])
            await send(message)

        token = set_request_context(ctx)
        try:
            await self.app(scope, receive, send_wrapper)
        except BaseException as exc:
            if isinstance(exc, Exception):
                self._report(scope, headers, "error", f"{type(exc).__name__}: {exc}",
                             {**exception_meta(exc), "status": status or 500, "duration_ms": _ms(started)})
                mark_reported(exc)
            raise
        else:
            if self.capture_5xx and status >= 500:
                self._report(scope, headers, "error", f"HTTP {status} on {scope.get('method')} {scope.get('path')}",
                             {"status": status, "duration_ms": _ms(started)})
            elif self.log_requests:
                self._report(scope, headers, "warn" if status >= 400 else "info",
                             f"{scope.get('method')} {scope.get('path')} {status}",
                             {"status": status, "duration_ms": _ms(started)}, with_headers=False)
        finally:
            reset_request_context(token)

    def _report(self, scope: Scope, headers: Dict[str, str], level: str, message: str, extra: Dict[str, Any],
                *, with_headers: bool = True) -> None:
        try:
            info: Dict[str, Any] = {
                "method": scope.get("method"),
                "path": scope.get("path"),
                "query": (scope.get("query_string") or b"").decode("latin-1")[:2000],
            }
            route = getattr(scope.get("route"), "path", None)
            if route:
                info["route"] = route
            if with_headers:
                info["headers"] = redact(headers.items(), self.redact_headers)
            meta = {**get_request_context(), **extra, "request": info}
            self.client.log(level, message, meta, source=self.source, environment=self.environment)
        except Exception:  # never break the response cycle
            pass


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
