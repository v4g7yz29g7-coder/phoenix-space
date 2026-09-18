"""Smoke test for api/sdk_python.py against an in-process mock server."""

import http.server
import json
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.sdk_python import (  # noqa: E402
    AeonAPIError,
    AeonClient,
    AeonValidationError,
    backoff_delay,
    encode_query,
)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("x-request-id", "req-1")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/v1/agents" or self.path.startswith("/v1/agents?"):
            return self._send({"agents": [{"id": "a1", "name": "x"}], "path": self.path})
        if self.path.startswith("/v1/agents/list"):
            return self._send({"agents": [{"id": "a1", "name": "x"}], "path": self.path})
        if self.path.startswith("/v1/tasks/t1"):
            return self._send({"id": "t1", "status": "succeeded"})
        self._send({"code": "not_found", "message": "no such agent"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        return self._send({"ok": True, "echo": json.loads(raw or b"{}"), "path": self.path})

    def do_DELETE(self):
        return self._send({"deleted": True})


def main():
    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    client = AeonClient(base_url="http://127.0.0.1:{}/v1".format(port), api_key="sk-1")

    assert client.agents.list({"limit": 2})["agents"][0]["id"] == "a1"
    assert client.agents.create({"name": "hello"})["ok"] is True
    assert client.agents.invoke("a1", {"prompt": "hi"})["ok"] is True
    assert client.tasks.wait("t1", interval=0.01, timeout=2)["status"] == "succeeded"
    assert client.memory.remember({"content": "x"})["ok"] is True
    assert client.telemetry.track("evt", {"k": 1})["ok"] is True

    try:
        client.agents.get("missing")
    except AeonAPIError as err:
        assert err.status == 404 and err.request_id == "req-1"
    else:
        raise AssertionError("expected AeonAPIError")

    try:
        client.agents.create({})
    except AeonValidationError:
        pass
    else:
        raise AssertionError("expected AeonValidationError")

    assert encode_query({"a": 1, "b": "x y"}) == "?a=1&b=x%20y"
    assert backoff_delay(0, base=0.1) >= 0.1

    server.shutdown()
    print("SDK SMOKE OK")


if __name__ == "__main__":
    main()
