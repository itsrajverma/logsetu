import logging

import pytest

from logsetu.client import LogSetuClient

flask = pytest.importorskip("flask")
fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from logsetu.fastapi import LogSetuMiddleware  # noqa: E402
from logsetu.flask import LogSetu  # noqa: E402


def make_client(fake_server, source):
    return LogSetuClient("ls_key", fake_server.url, source=source, environment="ci", flush_interval=0.1)


# ---------- Flask ----------


def flask_app(fake_server, **kwargs):
    app = flask.Flask(__name__)
    client = make_client(fake_server, "flask-api")
    LogSetu(app, client=client, source="flask-api", environment="ci",
            get_tenant_id=lambda req: req.headers.get("X-Tenant"), **kwargs)

    @app.get("/ok")
    def ok():
        logging.getLogger("myapp").warning("inside view", extra={"order_id": 7})
        return "ok"

    @app.get("/boom/<int:item>")
    def boom(item):
        raise ValueError(f"bad item {item}")

    @app.get("/down")
    def down():
        return "down", 503

    @app.get("/missing")
    def missing():
        return "nope", 404

    return app, client


def test_flask_reports_exceptions_with_request_context(fake_server):
    app, client = flask_app(fake_server)
    http = app.test_client()
    assert http.get("/ok", headers={"X-Request-Id": "req-1", "X-Tenant": "acme"}).status_code == 200
    assert http.get("/boom/3", headers={"Authorization": "Bearer secret"}).status_code == 500
    assert client.flush(timeout=5)

    logs = fake_server.logs
    assert [(l["level"], l["message"]) for l in logs] == [("warn", "inside view"), ("error", "ValueError: bad item 3")]
    view_log, error = logs
    assert view_log["meta"]["order_id"] == 7
    assert view_log["meta"]["request"] == {"request_id": "req-1", "method": "GET", "path": "/ok", "ip": "127.0.0.1",
                                           "tenant_id": "acme"}
    assert error["source"] == "flask-api" and error["environment"] == "ci"
    assert "ValueError: bad item 3" in error["meta"]["stack"]
    assert error["meta"]["request"]["route"] == "/boom/<int:item>"
    assert error["meta"]["request"]["headers"]["authorization"] == "[REDACTED]"


def test_flask_reports_bare_5xx_and_optionally_logs_requests(fake_server):
    app, client = flask_app(fake_server, log_requests=True)
    http = app.test_client()
    http.get("/missing")
    http.get("/down")
    assert client.flush(timeout=5)
    assert [(l["level"], l["message"]) for l in fake_server.logs] == [
        ("warn", "GET /missing 404"),
        ("error", "HTTP 503 on GET /down"),
    ]


# ---------- FastAPI / ASGI ----------


def fastapi_app(fake_server, **kwargs):
    app = fastapi.FastAPI()
    client = make_client(fake_server, "fastapi")
    app.add_middleware(LogSetuMiddleware, client=client, source="fastapi", environment="ci",
                       get_tenant_id=lambda scope: dict(scope["headers"]).get(b"x-tenant", b"").decode() or None,
                       **kwargs)

    @app.get("/ok")
    async def ok():
        logging.getLogger("myapp").error("async view")
        return {"ok": True}

    @app.get("/sync")
    def sync_view():
        logging.getLogger("myapp").warning("sync view in threadpool")
        return {"ok": True}

    @app.get("/boom/{item}")
    async def boom(item: int):
        raise RuntimeError(f"exploded {item}")

    @app.get("/teapot")
    async def teapot():
        raise fastapi.HTTPException(status_code=418)

    @app.get("/down")
    async def down():
        return fastapi.Response("down", status_code=503)

    @app.get("/healthz")
    async def healthz():
        return {"ok": True}

    return app, client


def test_fastapi_reports_exceptions_with_request_context(fake_server):
    app, client = fastapi_app(fake_server)
    http = TestClient(app, raise_server_exceptions=False)
    assert http.get("/ok", headers={"X-Request-Id": "req-1", "X-Tenant": "acme"}).status_code == 200
    assert http.get("/sync", headers={"X-Request-Id": "req-2"}).status_code == 200
    assert http.get("/boom/5", headers={"Cookie": "session=x"}).status_code == 500
    assert http.get("/teapot").status_code == 418
    assert client.flush(timeout=5)

    logs = fake_server.logs
    assert [(l["level"], l["message"]) for l in logs] == [
        ("error", "async view"),
        ("warn", "sync view in threadpool"),
        ("error", "RuntimeError: exploded 5"),
    ]
    assert logs[0]["meta"]["request"]["request_id"] == "req-1"
    assert logs[0]["meta"]["tenant_id"] == "acme"
    assert logs[1]["meta"]["request"]["request_id"] == "req-2"
    error = logs[2]
    assert error["source"] == "fastapi" and error["meta"]["status"] == 500
    assert "RuntimeError: exploded 5" in error["meta"]["stack"]
    assert error["meta"]["request"]["route"] == "/boom/{item}"
    assert error["meta"]["request"]["headers"]["cookie"] == "[REDACTED]"


def test_fastapi_reports_bare_5xx_logs_requests_and_ignores_paths(fake_server):
    app, client = fastapi_app(fake_server, log_requests=True, ignore_paths=["/healthz"])
    http = TestClient(app, raise_server_exceptions=False)
    http.get("/healthz")
    http.get("/teapot")
    http.get("/down")
    assert client.flush(timeout=5)
    assert [(l["level"], l["message"]) for l in fake_server.logs] == [
        ("warn", "GET /teapot 418"),
        ("error", "HTTP 503 on GET /down"),
    ]
    assert fake_server.logs[1]["meta"]["duration_ms"] >= 0
