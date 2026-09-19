"""Django middleware: attaches request context to every log and reports unhandled exceptions.

Add it to ``MIDDLEWARE`` (after ``AuthenticationMiddleware`` if you want user ids)::

    MIDDLEWARE = [..., "logsetu.middleware.LogSetuMiddleware"]

It reuses the client of a configured ``LogSetuHandler``; alternatively configure it directly::

    LOGSETU = {
        "API_KEY": env("LOGSETU_API_KEY"),
        "ENDPOINT": env("LOGSETU_ENDPOINT"),
        "ENVIRONMENT": "production",
        "SOURCE": "django-backend",
        "GET_TENANT_ID": "myapp.tenants.get_tenant_id",   # callable(request) -> str | None
        "REDACT_HEADERS": ["authorization", "cookie"],     # default list already covers the usual suspects
        "CAPTURE_5XX": True,                                # also log responses with status >= 500 that didn't raise
    }
"""

from __future__ import annotations

import logging
import traceback
import uuid
from typing import Any, Callable, Dict, Optional

from django.utils.deprecation import MiddlewareMixin

from .client import LogSetuClient, get_client
from .conf import DEFAULT_REDACT_HEADERS, django_settings, import_callable
from .context import get_request_context, reset_request_context, set_request_context
from .handler import LogSetuHandler


def _find_handler() -> Optional[LogSetuHandler]:
    """The first LogSetuHandler attached to any configured logger (root first)."""
    loggers = [logging.getLogger()] + [
        lg for lg in logging.Logger.manager.loggerDict.values() if isinstance(lg, logging.Logger)
    ]
    for lg in loggers:
        for h in lg.handlers:
            if isinstance(h, LogSetuHandler):
                return h
    return None


class LogSetuMiddleware(MiddlewareMixin):
    """Capture request metadata for every log line and report unhandled exceptions with full context."""

    def __init__(self, get_response: Callable[..., Any]) -> None:
        super().__init__(get_response)
        cfg = django_settings()
        handler = _find_handler()
        self.client: LogSetuClient = (
            handler.client
            if handler is not None
            else get_client(
                cfg.get("API_KEY", ""),
                cfg.get("ENDPOINT", ""),
                environment=cfg.get("ENVIRONMENT", "production"),
                source=cfg.get("SOURCE", "django"),
                debug=bool(cfg.get("DEBUG", False)),
            )
        )
        self.source: str = cfg.get("SOURCE") or (handler.source if handler else "django")
        self.environment: str = cfg.get("ENVIRONMENT") or (handler.environment if handler else "production")
        self.get_tenant_id = import_callable(cfg.get("GET_TENANT_ID")) or (handler.get_tenant_id if handler else None)
        self.redact_headers = {h.lower() for h in cfg.get("REDACT_HEADERS", DEFAULT_REDACT_HEADERS)}
        self.capture_5xx: bool = bool(cfg.get("CAPTURE_5XX", True))

    # ---------- request lifecycle ----------

    def process_request(self, request: Any) -> None:
        ctx: Dict[str, Any] = {
            "request_id": request.META.get("HTTP_X_REQUEST_ID") or uuid.uuid4().hex[:16],
            "method": request.method,
            "path": request.path,
        }
        ip = self._client_ip(request)
        if ip:
            ctx["ip"] = ip
        tenant = self._tenant(request)
        if tenant is not None:
            ctx["tenant_id"] = tenant
        request._logsetu_token = set_request_context(ctx)  # noqa: SLF001
        request.logsetu_request_id = ctx["request_id"]

    def process_response(self, request: Any, response: Any) -> Any:
        try:
            status = getattr(response, "status_code", 0)
            if self.capture_5xx and status >= 500 and not getattr(request, "_logsetu_reported", False):
                self._report(
                    request,
                    level="error",
                    message=f"HTTP {status} on {request.method} {request.path}",
                    extra={"status": status},
                )
                request._logsetu_reported = True  # noqa: SLF001
        finally:
            token = getattr(request, "_logsetu_token", None)
            if token is not None:
                reset_request_context(token)
        return response

    def process_exception(self, request: Any, exception: BaseException) -> None:
        stack = "".join(traceback.format_exception(type(exception), exception, exception.__traceback__))
        self._report(
            request,
            level="error",
            message=f"{type(exception).__name__}: {exception}",
            extra={"exception": type(exception).__name__, "stack": stack},
        )
        request._logsetu_reported = True  # noqa: SLF001
        return None  # let Django produce the 500 response as usual

    # ---------- helpers ----------

    def _report(self, request: Any, *, level: str, message: str, extra: Dict[str, Any]) -> None:
        try:
            meta: Dict[str, Any] = {**get_request_context(), **extra, "request": self.request_info(request)}
            user = self.user_info(request)
            if user:
                meta["user"] = user
            self.client.log(level, message, meta, source=self.source, environment=self.environment)
        except Exception:  # never break the response cycle
            pass

    def request_info(self, request: Any) -> Dict[str, Any]:
        info: Dict[str, Any] = {
            "method": request.method,
            "path": request.path,
            "query": request.META.get("QUERY_STRING", "")[:2000],
            "headers": self.redacted_headers(request),
        }
        ip = self._client_ip(request)
        if ip:
            info["ip"] = ip
        try:
            view = request.resolver_match.view_name if request.resolver_match else None
            if view:
                info["view"] = view
        except Exception:
            pass
        return info

    def redacted_headers(self, request: Any) -> Dict[str, str]:
        out: Dict[str, str] = {}
        headers = getattr(request, "headers", None)
        items = headers.items() if headers is not None else (
            (k[5:].replace("_", "-"), v) for k, v in request.META.items() if k.startswith("HTTP_")
        )
        for name, value in items:
            key = str(name).lower()
            out[key] = "[REDACTED]" if key in self.redact_headers else str(value)[:500]
        return out

    def user_info(self, request: Any) -> Optional[Dict[str, Any]]:
        user = getattr(request, "user", None)
        if user is None:
            return None
        try:
            if not getattr(user, "is_authenticated", False):
                return None
            info: Dict[str, Any] = {"id": getattr(user, "pk", None)}
            username = getattr(user, "get_username", None)
            if callable(username):
                info["username"] = username()
            return info
        except Exception:
            return None

    def _tenant(self, request: Any) -> Optional[str]:
        if self.get_tenant_id is None:
            return None
        try:
            value = self.get_tenant_id(request)
            return None if value is None else str(value)
        except Exception:
            return None

    @staticmethod
    def _client_ip(request: Any) -> Optional[str]:
        forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.META.get("REMOTE_ADDR")
