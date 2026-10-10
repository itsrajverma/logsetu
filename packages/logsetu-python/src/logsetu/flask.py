"""Flask integration: request context on every log, unhandled exceptions and 5xx responses reported.

::

    from flask import Flask
    from logsetu.flask import LogSetu

    app = Flask(__name__)
    LogSetu(app, api_key=os.environ["LOGSETU_API_KEY"], endpoint=os.environ["LOGSETU_ENDPOINT"], source="flask-api")

or with an app factory: ``logsetu = LogSetu()`` at module level, then ``logsetu.init_app(app)``. Options not passed
explicitly are read from ``app.config`` (``LOGSETU_API_KEY``, ``LOGSETU_ENDPOINT``, ``LOGSETU_ENVIRONMENT``,
``LOGSETU_SOURCE``).
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Iterable, Optional

from flask import Flask, g, got_request_exception, request

from .client import LogSetuClient
from .conf import DEFAULT_REDACT_HEADERS, import_callable
from .context import get_request_context, reset_request_context, set_request_context
from .web import attach_handler, client_ip, exception_meta, make_client, mark_reported, redact, request_id

__all__ = ["LogSetu"]


class LogSetu:
    """Flask extension. ``capture_logging`` also forwards stdlib ``logging`` records at ``log_level`` and above."""

    def __init__(
        self,
        app: Optional[Flask] = None,
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
        redact_headers: Iterable[str] = DEFAULT_REDACT_HEADERS,
        debug: bool = False,
        client: Optional[LogSetuClient] = None,
    ) -> None:
        self._options = dict(api_key=api_key, endpoint=endpoint, environment=environment, source=source)
        self.get_tenant_id: Optional[Callable[[Any], Any]] = import_callable(get_tenant_id)
        self.capture_logging = capture_logging
        self.log_level = log_level
        self.capture_5xx = capture_5xx
        self.log_requests = log_requests
        self.redact_headers = tuple(redact_headers)
        self.debug = debug
        self.client: Optional[LogSetuClient] = client
        if app is not None:
            self.init_app(app)

    def init_app(self, app: Flask) -> None:
        cfg = app.config
        self.environment = self._options["environment"] or cfg.get("LOGSETU_ENVIRONMENT") or cfg.get("ENV") or "production"
        self.source = self._options["source"] or cfg.get("LOGSETU_SOURCE") or "flask"
        self.client = make_client(
            self._options["api_key"] or cfg.get("LOGSETU_API_KEY"),
            self._options["endpoint"] or cfg.get("LOGSETU_ENDPOINT"),
            environment=self.environment,
            source=self.source,
            debug=self.debug,
            client=self.client,
        )
        if self.capture_logging:
            attach_handler(self.client, self.log_level)

        app.before_request(self._before_request)
        app.after_request(self._after_request)
        app.teardown_request(self._teardown_request)
        got_request_exception.connect(self._on_exception, app, weak=False)
        app.extensions["logsetu"] = self

    # ---------- request lifecycle ----------

    def _before_request(self) -> None:
        headers = {k.lower(): v for k, v in request.headers.items()}
        ctx = {"request_id": request_id(headers), "method": request.method, "path": request.path}
        ip = client_ip(headers, request.remote_addr)
        if ip:
            ctx["ip"] = ip
        if self.get_tenant_id is not None:
            try:
                tenant = self.get_tenant_id(request)
                if tenant is not None:
                    ctx["tenant_id"] = str(tenant)
            except Exception:
                pass
        g._logsetu_token = set_request_context(ctx)
        g.logsetu_request_id = ctx["request_id"]

    def _after_request(self, response: Any) -> Any:
        try:
            status = response.status_code
            if self.capture_5xx and status >= 500 and not g.get("_logsetu_reported"):
                self._report("error", f"HTTP {status} on {request.method} {request.path}", {"status": status})
            elif self.log_requests:
                level = "warn" if status >= 400 else "info"
                self._report(level, f"{request.method} {request.path} {status}", {"status": status}, with_headers=False)
        except Exception:
            pass
        return response

    def _teardown_request(self, _exc: Optional[BaseException]) -> None:
        token = g.pop("_logsetu_token", None)
        if token is not None:
            reset_request_context(token)

    def _on_exception(self, _sender: Any, exception: BaseException, **_: Any) -> None:
        self._report("error", f"{type(exception).__name__}: {exception}", exception_meta(exception))
        mark_reported(exception)
        g._logsetu_reported = True

    # ---------- helpers ----------

    def _report(self, level: str, message: str, extra: dict, *, with_headers: bool = True) -> None:
        if self.client is None:
            return
        try:
            info = {"method": request.method, "path": request.path, "query": request.query_string.decode("latin-1")[:2000]}
            endpoint = request.endpoint
            if endpoint:
                info["endpoint"] = endpoint
            if request.url_rule is not None:
                info["route"] = request.url_rule.rule
            if with_headers:
                info["headers"] = redact(request.headers.items(), self.redact_headers)
            meta = {**get_request_context(), **extra, "request": info}
            self.client.log(level, message, meta, source=self.source, environment=self.environment)
        except Exception:  # never break the response cycle
            pass
