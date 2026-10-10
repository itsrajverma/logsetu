"""FastAPI integration — an alias of :mod:`logsetu.asgi`.

::

    from logsetu.fastapi import LogSetuMiddleware
    app.add_middleware(LogSetuMiddleware, api_key=..., endpoint=..., source="fastapi")
"""

from .asgi import LogSetuMiddleware

__all__ = ["LogSetuMiddleware"]
