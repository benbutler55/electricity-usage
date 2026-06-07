"""Octopus Energy REST API client with auth, pagination, and transient-error backoff."""

import random
import sys
import time
from typing import Any

import requests

# Statuses worth retrying. The Octopus API (behind AWS CloudFront/ALB) can
# intermittently return 403 on authenticated endpoints — sometimes a brief
# throttle, sometimes a longer edge/WAF block keyed to the runner IP that a
# short retry can't clear. 5xx are transient server errors. A genuinely bad key
# returns 403 on every attempt and still surfaces loudly once retries exhaust.
RETRY_STATUSES = frozenset({403, 429, 500, 502, 503, 504})
MAX_ATTEMPTS = 5
MAX_BACKOFF_S = 30

# Identify the app explicitly. The default "python-requests/x.y" User-Agent is a
# common trigger for managed bot/WAF rules at the edge, which is a likely cause
# of the intermittent 403s on certain CI runner IPs.
USER_AGENT = "electricity-usage-dashboard/1.0 (+https://github.com/benbutler55/electricity-usage)"

# Response headers worth logging when a request ultimately fails — they reveal
# which layer rejected us (AWS WAF/ALB/CloudFront vs the Octopus app).
_DIAG_HEADERS = {
    "server", "via", "retry-after", "www-authenticate",
    "x-amzn-errortype", "x-amzn-requestid", "x-amzn-waf-action",
    "x-amz-cf-id", "x-amz-apigw-id", "cf-ray", "x-cache",
}


def _log_failure_diagnostics(resp: requests.Response) -> None:
    """Dump status, identifying headers, and a body snippet for a failed response."""
    headers = {k: v for k, v in resp.headers.items() if k.lower() in _DIAG_HEADERS}
    body = " ".join((resp.text or "").split())[:500]
    print(
        f"  HTTP {resp.status_code} failure diagnostics — headers={headers} body={body!r}",
        file=sys.stderr,
    )


def _backoff_seconds(attempt: int, resp: requests.Response | None = None) -> float:
    """Exponential backoff with jitter, honoring a server Retry-After hint when present."""
    wait = min(2 ** attempt, MAX_BACKOFF_S)
    if resp is not None:
        retry_after = resp.headers.get("Retry-After")
        if retry_after:
            try:
                wait = min(max(wait, int(retry_after)), MAX_BACKOFF_S)
            except ValueError:
                pass  # HTTP-date form — fall back to exponential backoff
    return wait + random.uniform(0, min(wait, 5) * 0.5)  # jitter to de-synchronize retries


class OctopusClient:
    BASE = "https://api.octopus.energy/v1"

    def __init__(self, api_key: str) -> None:
        self.session = requests.Session()
        self.session.auth = (api_key, "")
        self.session.headers["Accept"] = "application/json"
        self.session.headers["User-Agent"] = USER_AGENT
        # Separate unauthenticated session for public price endpoints.
        self.public_session = requests.Session()
        self.public_session.headers["Accept"] = "application/json"
        self.public_session.headers["User-Agent"] = USER_AGENT

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
                wait = _backoff_seconds(attempt)
                print(f"  network error ({e}); retry {attempt + 2}/{MAX_ATTEMPTS} in {wait:.1f}s…", file=sys.stderr)
                time.sleep(wait)
                continue

            if resp.status_code in RETRY_STATUSES and not last:
                wait = _backoff_seconds(attempt, resp)
                print(f"  HTTP {resp.status_code} from API; retry {attempt + 2}/{MAX_ATTEMPTS} in {wait:.1f}s…", file=sys.stderr)
                time.sleep(wait)
                continue

            # Either a success, a non-retryable status, or the final attempt.
            # On any error, dump diagnostics before raising so the real cause
            # (edge/WAF block vs app throttle vs bad key) is visible in CI logs.
            if resp.status_code >= 400:
                _log_failure_diagnostics(resp)
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
