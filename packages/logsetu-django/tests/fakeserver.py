"""Tiny in-process HTTP server that records ingest requests (used instead of a real LogSetu)."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List


class FakeLogSetu:
    def __init__(self, fail_first: int = 0, status: int = 202) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.fail_first = fail_first
        self.status = status
        self._lock = threading.Lock()
        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length) or b"[]")
                with server._lock:
                    server.requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
                    n = len(server.requests)
                code = 503 if n <= server.fail_first else server.status
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"accepted":1}')

            def log_message(self, *args: Any) -> None:  # silence
                pass

        self.httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def logs(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [entry for r in self.requests if r["path"].startswith("/api/v1/ingest") for entry in r["body"]]

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
