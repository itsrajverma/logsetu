"""Configuration helpers: resolve callables from dotted paths and read ``settings.LOGSETU``."""

from __future__ import annotations

import importlib
from typing import Any, Callable, Dict, Optional, Union

TenantGetter = Callable[[Any], Optional[str]]

DEFAULT_REDACT_HEADERS = ("authorization", "cookie", "set-cookie", "x-api-key", "x-csrftoken", "proxy-authorization")


def import_callable(value: Union[str, Callable[..., Any], None]) -> Optional[Callable[..., Any]]:
    """Accept a callable or a dotted path like ``"myapp.tenants.get_tenant_id"``."""
    if value is None:
        return None
    if callable(value):
        return value
    if not isinstance(value, str):
        raise TypeError(f"expected callable or dotted path, got {type(value)!r}")
    module_path, _, attr = value.rpartition(".")
    if not module_path:
        raise ImportError(f"'{value}' is not a dotted path")
    module = importlib.import_module(module_path)
    try:
        return getattr(module, attr)
    except AttributeError as e:
        raise ImportError(f"module '{module_path}' has no attribute '{attr}'") from e


def django_settings() -> Dict[str, Any]:
    """``settings.LOGSETU`` if Django is configured, else ``{}``. Never raises."""
    try:
        from django.conf import settings

        if not settings.configured:
            return {}
        value = getattr(settings, "LOGSETU", None)
        return dict(value) if isinstance(value, dict) else {}
    except Exception:
        return {}
