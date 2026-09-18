"""EverOS Python SDK.

A lightweight, dependency-free client for the EverOS HTTP API.

Features
--------
* Automatic request retries with exponential backoff
* Configurable timeouts and base URL
* Typed exceptions for every failure mode
* Rich resource clients: ``client.memories``, ``client.tasks``, ``client.users``
* Pagination helpers
* Context-manager support (``with EverOSClient(...) as client:``)

Example
-------
>>> with EverOSClient(base_url="https://api.everos.ai", api_key="sk-...") as c:
...     mem = c.memories.create(content="hello world", tags=["demo"])
...     print(mem["id"])
"""

from __future__ import annotations

import json
import logging
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional

__all__ = [
    "EverOSClient",
    "EverOSError",
    "APIError",
    "AuthenticationError",
    "NotFoundError",
    "RateLimitError",
    "ValidationError",
    "ConnectionError_",
    "TimeoutError_",
    "MemoriesResource",
    "TasksResource",
    "UsersResource",
    "Paginator",
    "RetryPolicy",
]

__version__ = "0.3.1"

logger = logging.getLogger("everos.sdk")

DEFAULT_BASE_URL = "https://api.everos.ai"
DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RETRIES = 3
DEFAULT_BACKOFF = 0.5
USER_AGENT = f"everos-python/{__version__}"


# --------------------------------------------------------------------------- #
# Exceptions
# --------------------------------------------------------------------------- #
class EverOSError(Exception):
    """Base class for every error raised by the SDK."""

    def __init__(self, message: str, *, status: Optional[int] = None,
                 payload: Optional[Mapping[str, Any]] = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.payload = dict(payload or {})

    def __str__(self) -> str:  # pragma: no cover - trivial
        if self.status is not None:
            return f"[{self.status}] {self.message}"
        return self.message


class APIError(EverOSError):
    """The server returned a non-2xx response."""


class AuthenticationError(APIError):
    """401/403 - the API key is missing or invalid."""


class NotFoundError(APIError):
    """404 - the requested resource does not exist."""


class RateLimitError(APIError):
    """429 - too many requests; retry after a delay."""


class ValidationError(APIError):
    """422 - the request payload failed validation."""


class ConnectionError_(EverOSError):
    """The network layer could not reach the server."""


class TimeoutError_(EverOSError):
    """The request exceeded the configured timeout."""


# --------------------------------------------------------------------------- #
# Retry policy
# --------------------------------------------------------------------------- #
@dataclass
class RetryPolicy:
    """Controls how failed requests are retried."""

    max_retries: int = DEFAULT_MAX_RETRIES
    backoff: float = DEFAULT_BACKOFF
    max_backoff: float = 30.0
    retry_statuses: tuple = (408, 429, 500, 502, 503, 504)

    def should_retry(self, attempt: int, status: Optional[int] = None) -> bool:
        """Return ``True`` if another attempt should be made."""
        if attempt >= self.max_retries:
            return False
        if status is None:
            return True
        return status in self.retry_statuses

    def delay_for(self, attempt: int) -> float:
        """Compute the (jittered) delay before the next attempt."""
        raw = min(self.backoff * (2 ** attempt), self.max_backoff)
        return raw * (0.5 + random.random() * 0.5)


# --------------------------------------------------------------------------- #
# Pagination
# --------------------------------------------------------------------------- #
class Paginator(Iterator[Mapping[str, Any]]):
    """Lazily iterates over every page of a list endpoint."""

    def __init__(self, client: "EverOSClient", path: str,
                 params: Optional[Mapping[str, Any]] = None,
                 page_size: int = 50) -> None:
        self._client = client
        self._path = path
        self._params = dict(params or {})
        self._page_size = page_size
        self._cursor: Optional[str] = None
        self._buffer: List[Mapping[str, Any]] = []
        self._done = False

    def __iter__(self) -> "Paginator":
        return self

    def __next__(self) -> Mapping[str, Any]:
        while not self._buffer and not self._done:
            self._fetch_page()
        if not self._buffer:
            raise StopIteration
        return self._buffer.pop(0)

    def _fetch_page(self) -> None:
        params = dict(self._params)
        params["limit"] = self._page_size
        if self._cursor:
            params["cursor"] = self._cursor
        data = self._client.request("GET", self._path, params=params)
        items = data.get("data") or data.get("items") or []
        self._buffer.extend(items)
        self._cursor = data.get("next_cursor")
        if not self._cursor or len(items) < self._page_size:
            self._done = True

    def to_list(self) -> List[Mapping[str, Any]]:
        """Materialise the entire paginated result set."""
        return list(self)


# --------------------------------------------------------------------------- #
# Resource base
# --------------------------------------------------------------------------- #
class _Resource:
    """Shared plumbing for the resource clients."""

    _base_path = "/v1"

    def __init__(self, client: "EverOSClient") -> None:
        self._client = client

    def _url(self, *parts: str) -> str:
        joined = "/".join(str(p).strip("/") for p in parts if p is not None)
        return f"{self._base_path.rstrip('/')}/{joined}"


class MemoriesResource(_Resource):
    """CRUD operations for memory records."""

    _base_path = "/v1/memories"

    def create(self, content: str, *, tags: Optional[Iterable[str]] = None,
               metadata: Optional[Mapping[str, Any]] = None,
               user_id: Optional[str] = None) -> Mapping[str, Any]:
        """Create a new memory record."""
        if not content or not str(content).strip():
            raise ValidationError("content must be a non-empty string", status=422)
        body: Dict[str, Any] = {"content": content}
        if tags is not None:
            body["tags"] = list(tags)
        if metadata is not None:
            body["metadata"] = dict(metadata)
        if user_id is not None:
            body["user_id"] = user_id
        return self._client.request("POST", self._base_path, json_body=body)

    def get(self, memory_id: str) -> Mapping[str, Any]:
        """Fetch a single memory by id."""
        self._require_id(memory_id)
        return self._client.request("GET", f"{self._base_path}/{memory_id}")

    def update(self, memory_id: str, **fields: Any) -> Mapping[str, Any]:
        """Partially update a memory record."""
        self._require_id(memory_id)
        if not fields:
            raise ValidationError("no fields provided for update", status=422)
        return self._client.request("PATCH", f"{self._base_path}/{memory_id}",
                                    json_body=fields)

    def delete(self, memory_id: str) -> bool:
        """Delete a memory record. Returns ``True`` on success."""
        self._require_id(memory_id)
        self._client.request("DELETE", f"{self._base_path}/{memory_id}")
        return True

    def search(self, query: str, *, limit: int = 20) -> List[Mapping[str, Any]]:
        """Full-text / semantic search across memories."""
        if not query:
            raise ValidationError("query must not be empty", status=422)
        data = self._client.request("GET", f"{self._base_path}/search",
                                    params={"q": query, "limit": limit})
        return list(data.get("data") or data.get("items") or [])

    def list(self, *, page_size: int = 50, **filters: Any) -> Paginator:
        """Return a lazy paginator over all memories."""
        return Paginator(self._client, self._base_path, filters, page_size)

    @staticmethod
    def _require_id(memory_id: str) -> None:
        if not memory_id:
            raise ValidationError("memory_id is required", status=422)


class TasksResource(_Resource):
    """Background task management."""

    _base_path = "/v1/tasks"

    def create(self, kind: str, *, payload: Optional[Mapping[str, Any]] = None) -> Mapping[str, Any]:
        """Enqueue a new background task."""
        if not kind:
            raise ValidationError("kind is required", status=422)
        return self._client.request("POST", self._base_path,
                                    json_body={"kind": kind, "payload": dict(payload or {})})

    def get(self, task_id: str) -> Mapping[str, Any]:
        return self._client.request("GET", f"{self._base_path}/{task_id}")

    def status(self, task_id: str) -> str:
        """Convenience accessor returning the task status string."""
        return str(self.get(task_id).get("status", "unknown"))

    def cancel(self, task_id: str) -> Mapping[str, Any]:
        return self._client.request("POST", f"{self._base_path}/{task_id}/cancel")

    def wait(self, task_id: str, *, timeout: float = 300.0,
             poll_interval: float = 1.0) -> Mapping[str, Any]:
        """Block until the task reaches a terminal state or times out."""
        deadline = time.monotonic() + timeout
        terminal = {"succeeded", "failed", "cancelled"}
        while time.monotonic() < deadline:
            task = self.get(task_id)
            if task.get("status") in terminal:
                return task
            time.sleep(poll_interval)
        raise TimeoutError_(f"task {task_id} did not finish within {timeout}s")

    def list(self, *, page_size: int = 50, **filters: Any) -> Paginator:
        return Paginator(self._client, self._base_path, filters, page_size)


class UsersResource(_Resource):
    """User account operations."""

    _base_path = "/v1/users"

    def me(self) -> Mapping[str, Any]:
        return self._client.request("GET", f"{self._base_path}/me")

    def get(self, user_id: str) -> Mapping[str, Any]:
        return self._client.request("GET", f"{self._base_path}/{user_id}")

    def create(self, email: str, *, name: Optional[str] = None) -> Mapping[str, Any]:
        if "@" not in email:
            raise ValidationError("email is invalid", status=422)
        body = {"email": email}
        if name:
            body["name"] = name
        return self._client.request("POST", self._base_path, json_body=body)

    def list(self, *, page_size: int = 50, **filters: Any) -> Paginator:
        return Paginator(self._client, self._base_path, filters, page_size)


# --------------------------------------------------------------------------- #
# Client
# --------------------------------------------------------------------------- #
@dataclass
class _Config:
    base_url: str = DEFAULT_BASE_URL
    api_key: Optional[str] = None
    timeout: float = DEFAULT_TIMEOUT
    retry: RetryPolicy = field(default_factory=RetryPolicy)


class EverOSClient:
    """Synchronous EverOS API client.

    Parameters
    ----------
    base_url:
        Root URL of the API, without trailing slash.
    api_key:
        Bearer token used for authentication.
    timeout:
        Per-request timeout in seconds.
    max_retries:
        Number of retry attempts for transient failures.
    """

    def __init__(self, base_url: str = DEFAULT_BASE_URL, *,
                 api_key: Optional[str] = None, timeout: float = DEFAULT_TIMEOUT,
                 max_retries: int = DEFAULT_MAX_RETRIES,
                 retry_policy: Optional[RetryPolicy] = None) -> None:
        self._config = _Config(
            base_url=base_url.rstrip("/"),
            api_key=api_key,
            timeout=timeout,
            retry=retry_policy or RetryPolicy(max_retries=max_retries),
        )
        self.memories = MemoriesResource(self)
        self.tasks = TasksResource(self)
        self.users = UsersResource(self)

    # -- context manager ---------------------------------------------------- #
    def __enter__(self) -> "EverOSClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def close(self) -> None:
        """Release any held resources (kept for API symmetry)."""
        logger.debug("EverOSClient closed")

    # -- core request ------------------------------------------------------- #
    def request(self, method: str, path: str, *,
                params: Optional[Mapping[str, Any]] = None,
                json_body: Optional[Mapping[str, Any]] = None,
                headers: Optional[Mapping[str, str]] = None) -> Mapping[str, Any]:
        """Execute an HTTP request and decode the JSON response.

        Retries transient failures according to the configured policy.
        """
        url = self._build_url(path, params)
        body = json.dumps(json_body).encode("utf-8") if json_body is not None else None
        attempt = 0
        last_error: Optional[Exception] = None

        while True:
            try:
                return self._send(method, url, body, headers)
            except (ConnectionError_, TimeoutError_) as exc:
                last_error = exc
                if not self._config.retry.should_retry(attempt):
                    raise
            except APIError as exc:
                last_error = exc
                if not self._config.retry.should_retry(attempt, exc.status):
                    raise
            delay = self._config.retry.delay_for(attempt)
            logger.warning("retrying %s %s in %.2fs (attempt %d)", method, url, delay, attempt + 1)
            time.sleep(delay)
            attempt += 1
            if last_error is None:  # pragma: no cover - defensive
                raise EverOSError("retry loop reached an impossible state")

    def _send(self, method: str, url: str, body: Optional[bytes],
              headers: Optional[Mapping[str, str]]) -> Mapping[str, Any]:
        req = urllib.request.Request(url, data=body, method=method.upper())
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent", USER_AGENT)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if self._config.api_key:
            req.add_header("Authorization", f"Bearer {self._config.api_key}")
        for key, value in (headers or {}).items():
            req.add_header(key, value)

        try:
            with urllib.request.urlopen(req, timeout=self._config.timeout) as resp:
                raw = resp.read().decode("utf-8") or "{}"
                return json.loads(raw)
        except urllib.error.HTTPError as exc:
            self._raise_for_status(exc)
            raise  # pragma: no cover - _raise_for_status always raises
        except urllib.error.URLError as exc:
            if "timed out" in str(exc.reason).lower():
                raise TimeoutError_(f"request to {url} timed out") from exc
            raise ConnectionError_(f"could not reach {url}: {exc.reason}") from exc

    def _raise_for_status(self, exc: urllib.error.HTTPError) -> None:
        status = exc.code
        try:
            payload = json.loads(exc.read().decode("utf-8") or "{}")
        except (ValueError, OSError):
            payload = {}
        message = payload.get("message") or payload.get("error") or exc.reason or "request failed"
        mapping = {
            401: AuthenticationError,
            403: AuthenticationError,
            404: NotFoundError,
            422: ValidationError,
            429: RateLimitError,
        }
        cls = mapping.get(status, APIError)
        raise cls(str(message), status=status, payload=payload) from exc

    def _build_url(self, path: str, params: Optional[Mapping[str, Any]]) -> str:
        path = path if path.startswith("/") else f"/{path}"
        url = f"{self._config.base_url}{path}"
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            if clean:
                url = f"{url}?{urllib.parse.urlencode(clean, doseq=True)}"
        return url

    # -- convenience -------------------------------------------------------- #
    def ping(self) -> bool:
        """Return ``True`` if the API is reachable."""
        try:
            self.request("GET", "/v1/health")
            return True
        except EverOSError:
            return False

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"EverOSClient(base_url={self._config.base_url!r}, api_key={'***' if self._config.api_key else None})"


if __name__ == "__main__":  # pragma: no cover - manual smoke test
    logging.basicConfig(level=logging.INFO)
    with EverOSClient(api_key="demo") as client:
        print(client)
        print("reachable:", client.ping())
