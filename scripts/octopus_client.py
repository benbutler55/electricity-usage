"""Octopus Energy REST API client with auth, pagination, and transient-error backoff."""

import sys
import time
from typing import Any

import requests

# Statuses worth retrying. The Octopus API intermittently returns 403 on
# authenticated endpoints (e.g. /accounts/) under throttling rather than 429,
# so a single flaky response shouldn't abort the whole daily fetch. 5xx are
# transient server errors. A genuinely bad key returns 403 on every attempt and
# still surfaces loudly once retries are exhausted.
RETRY_STATUSES = frozenset({403, 429, 500, 502, 503, 504})
MAX_ATTEMPTS = 5
MAX_BACKOFF_S = 30


class OctopusClient:
    BASE = "https://api.octopus.energy/v1"

    def __init__(self, api_key: str) -> None:
        self.session = requests.Session()
        self.session.auth = (api_key, "")
        self.session.headers["Accept"] = "application/json"
        # Separate unauthenticated session for public price endpoints.
        self.public_session = requests.Session()
        self.public_session.headers["Accept"] = "application/json"

    def _request(
        self,
        session: requests.Session,
        url: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """GET with retry/backoff on transient HTTP statuses and network errors."""
        for attempt in range(MAX_ATTEMPTS):
            last = attempt == MAX_ATTEMPTS - 1
            try:
                resp = session.get(url, params=params or {}, timeout=30)
            except requests.RequestException as e:
                if last:
                    raise
                wait = min(2 ** attempt, MAX_BACKOFF_S)
                print(f"  network error ({e}); retry {attempt + 2}/{MAX_ATTEMPTS} in {wait}s…", file=sys.stderr)
                time.sleep(wait)
                continue

            if resp.status_code in RETRY_STATUSES and not last:
                wait = min(2 ** attempt, MAX_BACKOFF_S)
                print(f"  HTTP {resp.status_code} from API; retry {attempt + 2}/{MAX_ATTEMPTS} in {wait}s…", file=sys.stderr)
                time.sleep(wait)
                continue

            # Either a success, a non-retryable status, or the final attempt:
            # raise_for_status surfaces the real error loudly on exhaustion.
            resp.raise_for_status()
            return resp.json()

        raise RuntimeError(f"Failed after {MAX_ATTEMPTS} retries: GET {url}")

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._request(self.session, f"{self.BASE}{path}", params)

    def get_url(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._request(self.session, url, params)

    def get_public(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Unauthenticated GET — used for public price endpoints."""
        return self._request(self.public_session, f"{self.BASE}{path}", params)

    def paginate(self, path: str, params: dict[str, Any] | None = None, authenticated: bool = True) -> list[dict[str, Any]]:
        """Fetch all pages and return a flat list of results."""
        session = self.session if authenticated else self.public_session
        page = self._request(session, f"{self.BASE}{path}", {**(params or {}), "page_size": 1500})

        results: list[dict[str, Any]] = list(page.get("results", []))
        while page.get("next"):
            page = self._request(session, page["next"])
            results.extend(page.get("results", []))
        return results
