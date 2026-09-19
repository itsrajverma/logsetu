"""LogSetu SDK for Django & DRF.

Quick start (settings.py)::

    LOGGING = {
        "version": 1,
        "handlers": {
            "logsetu": {
                "class": "logsetu.handler.LogSetuHandler",
                "api_key": env("LOGSETU_API_KEY"),
                "endpoint": env("LOGSETU_ENDPOINT"),
                "environment": "production",
                "source": "django-backend",
                "level": "WARNING",
            },
        },
        "root": {"handlers": ["logsetu"], "level": "INFO"},
    }
    MIDDLEWARE = [..., "logsetu.middleware.LogSetuMiddleware"]
"""

from .client import LogSetuClient, get_client, __version__
from .context import get_request_context, update_request_context

__all__ = [
    "LogSetuClient",
    "get_client",
    "get_request_context",
    "update_request_context",
    "capture_exception",
    "__version__",
]

default_app_config = "logsetu.apps.LogSetuConfig"


def capture_exception(exc: BaseException, message: str = "", **meta: object) -> None:
    """Report an exception through the configured ``LogSetuHandler`` (via the stdlib logger)."""
    import logging

    logging.getLogger("logsetu.capture").error(message or f"{type(exc).__name__}: {exc}", exc_info=exc, extra=meta)
