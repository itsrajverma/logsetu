import logging

import pytest

from logsetu import client as client_module

from .fakeserver import FakeLogSetu


@pytest.fixture
def fake_server():
    server = FakeLogSetu()
    yield server
    server.close()


@pytest.fixture(autouse=True)
def _reset_logging_and_registry():
    root = logging.getLogger()
    saved = list(root.handlers)
    yield
    for h in root.handlers:
        if h not in saved:
            root.removeHandler(h)
            h.close()
    for c in list(client_module._registry.values()):
        c.close()
    client_module._registry.clear()
