import logging
import logging.config

import pytest
from django.contrib.auth.models import User
from django.test import Client, override_settings

from logsetu.handler import LogSetuHandler


def get_tenant_id(request):
    return request.META.get("HTTP_X_TENANT") or None


def configure_logging(server, **handler_kwargs):
    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "handlers": {
                "logsetu": {
                    "class": "logsetu.handler.LogSetuHandler",
                    "api_key": "ls_django",
                    "endpoint": server.url,
                    "environment": "test",
                    "source": "django-backend",
                    "level": "INFO",
                    "flush_interval": 0.2,
                    **handler_kwargs,
                }
            },
            "root": {"handlers": ["logsetu"], "level": "INFO"},
        }
    )
    handler = next(h for h in logging.getLogger().handlers if isinstance(h, LogSetuHandler))
    return handler


def test_handler_maps_levels_extra_and_exc_info(fake_server):
    handler = configure_logging(fake_server)
    log = logging.getLogger("myapp")
    log.info("hello %s", "world", extra={"order_id": 7})
    log.warning("careful")
    log.debug("filtered out by level")
    try:
        1 / 0
    except ZeroDivisionError:
        log.exception("division")
    log.critical("fatal thing")
    handler.flush()

    logs = fake_server.logs
    assert [(l["level"], l["message"]) for l in logs] == [
        ("info", "hello world"),
        ("warn", "careful"),
        ("error", "division"),
        ("fatal", "fatal thing"),
    ]
    assert logs[0]["source"] == "django-backend" and logs[0]["environment"] == "test"
    assert logs[0]["meta"]["order_id"] == 7
    assert logs[0]["meta"]["logger"] == "myapp"
    assert logs[0]["timestamp"].endswith("+00:00")
    assert "ZeroDivisionError" in logs[2]["meta"]["stack"]
    assert logs[2]["meta"]["exception"] == "ZeroDivisionError"


def test_handler_reads_settings_logsetu_dict(fake_server):
    with override_settings(LOGSETU={"API_KEY": "from_settings", "ENDPOINT": fake_server.url, "SOURCE": "svc"}):
        handler = LogSetuHandler()
        logging.getLogger("x").addHandler(handler)
        logging.getLogger("x").warning("hi")
        handler.flush()
    assert fake_server.requests[0]["auth"] == "Bearer from_settings"
    assert fake_server.logs[0]["source"] == "svc"
    logging.getLogger("x").removeHandler(handler)


@pytest.mark.django_db
def test_middleware_attaches_request_context_and_tenant(fake_server):
    handler = configure_logging(fake_server, get_tenant_id="tests.test_django.get_tenant_id")
    client = Client()
    res = client.get("/ok/?q=1", HTTP_X_TENANT="acme", HTTP_X_REQUEST_ID="req-123")
    assert res.status_code == 200
    handler.flush()
    (entry,) = [l for l in fake_server.logs if l["message"] == "view ran"]
    assert entry["meta"]["order_id"] == 42
    assert entry["meta"]["tenant_id"] == "acme"
    assert entry["meta"]["request"] == {
        "request_id": "req-123",
        "method": "GET",
        "path": "/ok/",
        "ip": "127.0.0.1",
        "tenant_id": "acme",
    }


@pytest.mark.django_db
def test_middleware_reports_unhandled_exception_with_redacted_headers(fake_server):
    handler = configure_logging(fake_server)
    user = User.objects.create_user("raj", password="pw")
    client = Client(raise_request_exception=False)
    client.force_login(user)
    res = client.get("/boom/", HTTP_AUTHORIZATION="Bearer secret", HTTP_X_CUSTOM="keep")
    assert res.status_code == 500
    handler.flush()

    errors = [l for l in fake_server.logs if l["level"] == "error"]
    assert len(errors) == 1, "exception must be reported exactly once (not again as a 5xx response)"
    e = errors[0]
    assert e["message"] == "ValueError: kaboom"
    assert e["source"] == "django-backend"
    assert "kaboom" in e["meta"]["stack"] and "boom" in e["meta"]["stack"]
    headers = e["meta"]["request"]["headers"]
    assert headers["authorization"] == "[REDACTED]"
    assert headers["cookie"] == "[REDACTED]"
    assert headers["x-custom"] == "keep"
    assert e["meta"]["request"]["view"] == "tests.urls.boom"
    assert e["meta"]["user"] == {"id": user.pk, "username": "raj"}
    assert e["meta"]["request_id"]


@pytest.mark.django_db
def test_middleware_reports_5xx_responses(fake_server):
    handler = configure_logging(fake_server)
    res = Client().get("/bad-gateway/")
    assert res.status_code == 502
    handler.flush()
    (e,) = [l for l in fake_server.logs if l["level"] == "error"]
    assert e["message"] == "HTTP 502 on GET /bad-gateway/"
    assert e["meta"]["status"] == 502


@pytest.mark.django_db
def test_middleware_standalone_without_handler(fake_server):
    # No LogSetuHandler configured: middleware uses settings.LOGSETU directly.
    logging.config.dictConfig({"version": 1, "disable_existing_loggers": False, "root": {"handlers": []}})
    with override_settings(
        LOGSETU={"API_KEY": "mw", "ENDPOINT": fake_server.url, "SOURCE": "mw-only", "GET_TENANT_ID": get_tenant_id}
    ):
        client = Client(raise_request_exception=False)
        client.get("/boom/", HTTP_X_TENANT="globex")
        from logsetu.client import _registry

        for c in _registry.values():
            c.flush()
    (e,) = fake_server.logs
    assert e["source"] == "mw-only"
    assert e["meta"]["tenant_id"] == "globex"
    assert fake_server.requests[0]["auth"] == "Bearer mw"
