"""Octopus Energy REST API client with auth, pagination, and 429 backoff."""

import time
from typing import Any

import requests


class OctopusClient:
    BASE = "https://api.octopus.energy/v1"

    def __init__(self, api_key: str) -> None:
        self.session = requests.Session()
        self.session.auth = (api_key, "")
        self.session.headers["Accept"] = "application/json"

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        url = f"{self.BASE}{path}"
        for attempt in range(4):
            resp = self.session.get(url, params=params or {}, timeout=30)
            if resp.status_code == 429:
                wait = 2 ** attempt
                print(f"Rate limited, retrying in {wait}s…")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        raise RuntimeError(f"Failed after retries: GET {url}")

    def get_url(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        for attempt in range(4):
            resp = self.session.get(url, params=params or {}, timeout=30)
            if resp.status_code == 429:
                wait = 2 ** attempt
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        raise RuntimeError(f"Failed after retries: GET {url}")

    def get_public(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Unauthenticated GET — used for public price endpoints."""
        url = f"{self.BASE}{path}"
        for attempt in range(4):
            resp = requests.get(url, params=params or {}, timeout=30, headers={"Accept": "application/json"})
            if resp.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            resp.raise_for_status()
            return resp.json()
        raise RuntimeError(f"Failed after retries: GET {url}")

    def paginate(self, path: str, params: dict[str, Any] | None = None, authenticated: bool = True) -> list[dict[str, Any]]:
        """Fetch all pages and return a flat list of results."""
        p = {**(params or {}), "page_size": 1500}
        if authenticated:
            page = self.get(path, p)
        else:
            page = self.get_public(path, p)

        results: list[dict[str, Any]] = list(page.get("results", []))
        while page.get("next"):
            if authenticated:
                page = self.get_url(page["next"])
            else:
                page = requests.get(page["next"], timeout=30).json()
            results.extend(page.get("results", []))
        return results
