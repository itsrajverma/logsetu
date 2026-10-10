import time

from logsetu.client import LogSetuClient, to_json_safe


def test_batches_and_flushes(fake_server):
    c = LogSetuClient("ls_key", fake_server.url, source="t", environment="ci", flush_interval=0.2)
    c.log("info", "one", {"a": 1})
    c.log("warn", "two")
    assert c.flush(timeout=5)
    logs = fake_server.logs
    assert [(l["level"], l["message"]) for l in logs] == [("info", "one"), ("warn", "two")]
    assert logs[0]["source"] == "t" and logs[0]["environment"] == "ci" and logs[0]["meta"] == {"a": 1}
    assert fake_server.requests[0]["auth"] == "Bearer ls_key"
    assert fake_server.requests[0]["path"] == "/api/v1/ingest"
    c.close()


def test_flushes_on_interval_without_explicit_flush(fake_server):
    c = LogSetuClient("k", fake_server.url, flush_interval=0.2)
    c.log("info", "tick")
    time.sleep(0.8)
    assert [l["message"] for l in fake_server.logs] == ["tick"]
    c.close()


def test_flushes_when_batch_size_reached(fake_server):
    c = LogSetuClient("k", fake_server.url, flush_interval=30, batch_size=3)
    for i in range(3):
        c.log("info", f"m{i}")
    deadline = time.time() + 3
    while time.time() < deadline and len(fake_server.logs) < 3:
        time.sleep(0.05)
    assert len(fake_server.logs) == 3
    c.close()


def test_retries_on_5xx(fake_server):
    fake_server.fail_first = 2
    c = LogSetuClient("k", fake_server.url, max_retries=3)
    c.log("error", "retry me")
    assert c.flush(timeout=10)
    assert len(fake_server.requests) == 3
    assert fake_server.logs[-1]["message"] == "retry me"
    c.close()


def test_drops_on_4xx_without_retry(fake_server, capsys):
    fake_server.status = 401
    c = LogSetuClient("k", fake_server.url)
    c.log("error", "unauthorized")
    assert c.flush(timeout=5)
    assert len(fake_server.requests) == 1
    assert "[logsetu] server rejected batch (HTTP 401)" in capsys.readouterr().err
    c.close()


def test_unreachable_server_never_raises_and_warns_once(capsys):
    c = LogSetuClient("k", "http://127.0.0.1:9", max_retries=0, timeout=0.5)
    c.log("error", "a")
    c.flush(timeout=5)
    c.log("error", "b")
    c.flush(timeout=5)
    err = capsys.readouterr().err
    assert err.count("[logsetu] giving up") == 1
    assert "suppressed" in err
    c.close()


def test_queue_cap_drops_oldest(fake_server):
    c = LogSetuClient("k", fake_server.url, flush_interval=30, batch_size=500, max_queue_size=5)
    for i in range(8):
        c.log("info", f"m{i}")
    assert c.flush(timeout=5)
    assert [l["message"] for l in fake_server.logs] == ["m3", "m4", "m5", "m6", "m7"]
    assert c.dropped == 3
    c.close()


def test_disabled_without_config(capsys):
    c = LogSetuClient("", "")
    c.log("info", "x")
    assert c.enabled is False
    assert "not configured" in capsys.readouterr().err


def test_to_json_safe():
    class Weird:
        def __repr__(self):
            return "<Weird>"

    from datetime import datetime, timezone

    value = to_json_safe({"b": b"bytes", "d": datetime(2020, 1, 1, tzinfo=timezone.utc), "w": Weird(), "s": {1, 2}, 3: None})
    assert value == {"b": "bytes", "d": "2020-01-01T00:00:00+00:00", "w": "<Weird>", "s": [1, 2], "3": None}
