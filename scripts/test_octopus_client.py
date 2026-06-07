"""Unit tests for OctopusClient retry/backoff, User-Agent, and failure diagnostics."""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import pytest  # noqa: E402
import requests  # noqa: E402

import octopus_client as oc  # noqa: E402


class FakeResp:
    """Minimal stand-in for requests.Response."""

    def __init__(self, status, body="", headers=None, json_data=None):
        self.status_code = status
        self.text = body
        self.headers = headers or {}
        self._json = json_data if json_data is not None else {}

    def json(self):
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Error", response=self)


@pytest.fixture(autouse=True)
def _instant_sleep(monkeypatch):
    """Never actually sleep during retry tests."""
    monkeypatch.setattr(oc.time, "sleep", lambda *_: None)


def test_sets_descriptive_user_agent():
    c = oc.OctopusClient("sk_test")
    ua = c.session.headers.get("User-Agent", "")
    assert "python-requests" not in ua          # not the default bot UA
    assert "electricity-usage" in ua            # identifies this app
    assert c.public_session.headers.get("User-Agent") == ua


def test_success_returns_json(monkeypatch):
    c = oc.OctopusClient("k")
    monkeypatch.setattr(c.session, "get", lambda *a, **k: FakeResp(200, json_data={"ok": 1}))
    assert c.get("/accounts/x/") == {"ok": 1}


def test_persistent_403_retries_all_attempts_then_raises(monkeypatch):
    c = oc.OctopusClient("k")
    calls = {"n": 0}

    def fake_get(*a, **k):
        calls["n"] += 1
        return FakeResp(403, body="blocked", headers={"Server": "awselb/2.0"})

    monkeypatch.setattr(c.session, "get", fake_get)
    with pytest.raises(requests.HTTPError):
        c.get("/accounts/x/")
    assert calls["n"] == oc.MAX_ATTEMPTS


def test_logs_diagnostics_on_failure(monkeypatch, capsys):
    c = oc.OctopusClient("k")
    monkeypatch.setattr(
        c.session, "get",
        lambda *a, **k: FakeResp(
            403, body="<html>blocked by waf</html>",
            headers={"Server": "awselb/2.0", "x-amzn-waf-action": "block"},
        ),
    )
    with pytest.raises(requests.HTTPError):
        c.get("/accounts/x/")
    err = capsys.readouterr().err
    assert "403" in err
    assert "blocked by waf" in err                       # response body captured
    assert "awselb" in err.lower() or "x-amzn-waf-action" in err.lower()  # diag headers


def test_honors_retry_after(monkeypatch):
    c = oc.OctopusClient("k")
    sleeps = []
    monkeypatch.setattr(oc.time, "sleep", lambda s: sleeps.append(s))
    seq = [FakeResp(429, headers={"Retry-After": "3"}), FakeResp(200, json_data={"ok": True})]
    monkeypatch.setattr(c.session, "get", lambda *a, **k: seq.pop(0))
    assert c.get("/x/") == {"ok": True}
    assert any(s >= 3 for s in sleeps)   # waited at least the server-requested Retry-After
