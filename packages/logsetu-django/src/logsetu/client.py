"""Thread-safe, batching HTTP client for the LogSetu ingestion API.

Uses only the standard library so the package has zero runtime dependencies.
Never raises into the host application: transport failures are reported once on
stderr and the affected batch is dropped.
"""

from __future__ import annotations

import atexit
import json
import queue
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

__version__ = "0.1.0"

LogDict = Dict[str, Any]

_MAX_BATCH = 500
_FLUSH: Any = object()  # queue sentinel: send whatever is buffered now
_STOP: Any = object()  # queue sentinel: send and exit


def to_json_safe(value: Any, depth: int = 0) -> Any:
    """Coerce arbitrary values into something ``json.dumps`` accepts."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if depth > 6:
        return repr(value)
    if isinstance(value, dict):
        return {str(k): to_json_safe(v, depth + 1) for k, v in list(value.items())[:200]}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_json_safe(v, depth + 1) for v in list(value)[:200]]
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")[:2000]
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:  # pragma: no cover
            pass
    return repr(value)


class LogSetuClient:
    """Queues log dicts and ships them in batches from a background daemon thread."""

    def __init__(
        self,
        api_key: str,
        endpoint: str,
        *,
        environment: str = "production",
        source: str = "django",
        flush_interval: float = 2.0,
        batch_size: int = 10,
        max_queue_size: int = 1000,
        max_retries: int = 3,
        timeout: float = 5.0,
        debug: bool = False,
        enabled: bool = True,
    ) -> None:
        self.api_key = api_key or ""
        self.endpoint = (endpoint or "").rstrip("/")
        self.ingest_url = f"{self.endpoint}/api/v1/ingest"
        self.environment = environment
        self.source = source
        self.flush_interval = max(0.05, float(flush_interval))
        self.batch_size = max(1, min(int(batch_size), _MAX_BATCH))
        self.max_queue_size = max(1, int(max_queue_size))
        self.max_retries = max(0, int(max_retries))
        self.timeout = float(timeout)
        self.debug = debug
        self.enabled = bool(enabled and self.api_key and self.endpoint)

        self._queue: "queue.Queue[Any]" = queue.Queue(maxsize=self.max_queue_size + 2)
        self._dropped = 0
        self._warned = False
        self._lock = threading.Lock()
        self._idle = threading.Event()
        self._idle.set()
        self._stopped = False
        self._thread: Optional[threading.Thread] = None

        if not self.enabled:
            if enabled:
                self._warn("api_key/endpoint not configured; logs will not be sent")
            return
        self._thread = threading.Thread(target=self._run, name="logsetu-worker", daemon=True)
        self._thread.start()
        atexit.register(self.close)

    # ---------- public ----------

    def log(
        self,
        level: str,
        message: str,
        meta: Optional[Dict[str, Any]] = None,
        *,
        timestamp: Optional[str] = None,
        source: Optional[str] = None,
        environment: Optional[str] = None,
    ) -> None:
        if not self.enabled or self._stopped:
            return
        entry: LogDict = {
            "level": level,
            "message": str(message)[:10_000],
            "source": source or self.source,
            "environment": environment or self.environment,
        }
        if timestamp:
            entry["timestamp"] = timestamp
        if meta:
            entry["meta"] = to_json_safe(meta)
        self.enqueue(entry)

    def enqueue(self, entry: LogDict) -> None:
        if not self.enabled or self._stopped:
            return
        self._idle.clear()
        with self._lock:
            if self._queue.qsize() >= self.max_queue_size:
                # Drop the oldest to make room; a log SDK must never block the request cycle.
                try:
                    self._queue.get_nowait()
                except queue.Empty:  # pragma: no cover
                    pass
                self._dropped += 1
            try:
                self._queue.put_nowait(entry)
            except queue.Full:  # pragma: no cover
                self._dropped += 1

    def flush(self, timeout: Optional[float] = 10.0) -> bool:
        """Block until everything currently queued has been sent (or *timeout* elapses)."""
        if not self.enabled or self._stopped:
            return True
        self._idle.clear()
        try:
            self._queue.put_nowait(_FLUSH)
        except queue.Full:  # pragma: no cover
            pass
        return self._idle.wait(timeout)

    def close(self) -> None:
        if not self.enabled or self._stopped:
            return
        self._stopped = True
        self._queue.put(_STOP)
        if self._thread is not None:
            self._thread.join(timeout=10.0)

    @property
    def dropped(self) -> int:
        return self._dropped

    # ---------- worker ----------

    def _run(self) -> None:
        batch: List[LogDict] = []
        deadline = time.monotonic() + self.flush_interval
        while True:
            try:
                item = self._queue.get(timeout=max(0.0, deadline - time.monotonic()))
            except queue.Empty:
                item = _FLUSH
            if item is _STOP:
                self._send(batch + self._drain())
                self._idle.set()
                return
            if item is not _FLUSH:
                batch.append(item)
            if batch and (len(batch) >= self.batch_size or item is _FLUSH):
                self._send(batch + self._drain(_MAX_BATCH - len(batch)))
                batch = []
            if item is _FLUSH or not batch:
                deadline = time.monotonic() + self.flush_interval
            if not batch and self._queue.empty():
                self._idle.set()

    def _drain(self, limit: int = _MAX_BATCH) -> List[LogDict]:
        out: List[LogDict] = []
        while len(out) < limit:
            try:
                more = self._queue.get_nowait()
            except queue.Empty:
                break
            if more is _STOP:
                self._queue.put_nowait(_STOP)
                break
            if more is not _FLUSH:
                out.append(more)
        return out

    def _send(self, batch: List[LogDict]) -> None:
        if not batch:
            return
        body = json.dumps(batch, default=str).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "User-Agent": f"logsetu-django/{__version__}",
        }
        last_error = "unknown error"
        for attempt in range(self.max_retries + 1):
            try:
                req = urllib.request.Request(self.ingest_url, data=body, headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=self.timeout) as res:  # noqa: S310 - user-configured URL
                    if 200 <= res.status < 300:
                        return
                    last_error = f"HTTP {res.status}"
            except urllib.error.HTTPError as e:
                if e.code < 500 and e.code != 429:
                    self._warn(f"server rejected batch (HTTP {e.code}); dropped {len(batch)} logs")
                    return
                last_error = f"HTTP {e.code}"
            except Exception as e:  # network errors, timeouts, DNS
                last_error = repr(e)
            if attempt < self.max_retries:
                time.sleep(min(30.0, 0.5 * (2**attempt)) + random.random() * 0.25)
        self._warn(f"giving up after {self.max_retries + 1} attempts ({last_error}); dropped {len(batch)} logs")

    def _warn(self, msg: str) -> None:
        # Deliberately bypass the logging module: the LogSetu handler may be attached to the root logger.
        if self.debug or not self._warned:
            self._warned = True
            suffix = "" if self.debug else " (further transport warnings suppressed; set debug=True to see them)"
            sys.stderr.write(f"[logsetu] {msg}{suffix}\n")


_registry: Dict[Tuple[str, str], LogSetuClient] = {}
_registry_lock = threading.Lock()


def get_client(api_key: str, endpoint: str, **kwargs: Any) -> LogSetuClient:
    """Return a shared client per (api_key, endpoint) so the handler and middleware use one queue."""
    key = (api_key or "", (endpoint or "").rstrip("/"))
    with _registry_lock:
        client = _registry.get(key)
        if client is None or client._stopped:
            client = LogSetuClient(api_key, endpoint, **kwargs)
            _registry[key] = client
        return client
