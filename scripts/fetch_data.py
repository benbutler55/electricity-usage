"""
Fetch electricity data from the Octopus Energy API and write JSON files to public/data/.

Run from the repo root:
  OCTOPUS_API_KEY=sk_... OCTOPUS_ACCOUNT_NUMBER=A-... python scripts/fetch_data.py
"""

import json
import os
import sys

# Allow running from the repo root
sys.path.insert(0, os.path.dirname(__file__))

from octopus_client import OctopusClient  # noqa: E402  (path set above)

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from dateutil import tz

LONDON = tz.gettz("Europe/London")
OUT_DIR = "public/data"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def write_json(name: str, data: object) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  wrote {path}")


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_account(client: OctopusClient, account_number: str) -> dict:
    print("Fetching account info…")
    data = client.get(f"/accounts/{account_number}/")
    prop = data["properties"][0]
    emp = prop["electricity_meter_points"][0]
    mpan = emp["mpan"]
    meter_serial = emp["meters"][0]["serial_number"]
    # Find active agreement (no end date or end date in future)
    now = now_utc()
    agreements = emp.get("agreements", [])
    active = next(
        (a for a in agreements if a.get("valid_to") is None
         or datetime.fromisoformat(a["valid_to"].replace("Z", "+00:00")) > now),
        agreements[0] if agreements else None,
    )
    if not active:
        raise ValueError("No active tariff agreement found")
    tariff_code = active["tariff_code"]
    # e.g. E-1R-AGILE-24-10-01-C → product_slug=AGILE-24-10-01, region=C
    parts = tariff_code.split("-")
    region = parts[-1]
    product_slug = "-".join(parts[2:-1])
    return {
        "mpan": mpan,
        "meter_serial": meter_serial,
        "tariff_code": tariff_code,
        "product_slug": product_slug,
        "region": region,
    }


def fetch_prices(client: OctopusClient, product_slug: str, tariff_code: str) -> list[dict]:
    print("Fetching Agile prices…")
    now = now_utc()
    period_from = now.replace(hour=0, minute=0, second=0, microsecond=0)
    period_to = period_from + timedelta(days=2)
    path = f"/products/{product_slug}/electricity-tariffs/{tariff_code}/standard-unit-rates/"
    slots = client.paginate(path, {
        "period_from": iso(period_from),
        "period_to": iso(period_to),
    }, authenticated=False)
    return sorted(slots, key=lambda s: s["valid_from"])


def fetch_consumption(client: OctopusClient, mpan: str, serial: str, hours: int = 48) -> list[dict]:
    print(f"Fetching consumption ({hours}h)…")
    now = now_utc()
    period_from = now - timedelta(hours=hours)
    path = f"/electricity-meter-points/{mpan}/meters/{serial}/consumption/"
    slots = client.paginate(path, {
        "period_from": iso(period_from),
        "period_to": iso(now),
        "order_by": "period",
    })
    return sorted(slots, key=lambda s: s["interval_start"])


def build_daily(consumption_30d: list[dict], prices_map: dict[str, float]) -> list[dict]:
    by_day: dict[str, dict] = defaultdict(lambda: {"cost_pence": 0.0, "kwh": 0.0, "slot_count": 0})
    for slot in consumption_30d:
        dt_local = datetime.fromisoformat(slot["interval_start"].replace("Z", "+00:00")).astimezone(LONDON)
        day_key = dt_local.strftime("%Y-%m-%d")
        kwh = slot["consumption"]
        price = prices_map.get(slot["interval_start"])
        cost = kwh * price if price is not None else 0.0
        by_day[day_key]["cost_pence"] += cost
        by_day[day_key]["kwh"] += kwh
        by_day[day_key]["slot_count"] += 1

    return [
        {
            "date": date_str,
            "cost_pence": round(d["cost_pence"], 4),
            "kwh": round(d["kwh"], 4),
            "slot_count": d["slot_count"],
            "complete": d["slot_count"] >= 48,
        }
        for date_str in sorted(by_day.keys())
        for d in [by_day[date_str]]
    ]


def build_heatmap(consumption_30d: list[dict], prices_map: dict[str, float]) -> list[dict]:
    cells: dict[tuple[int, int], dict] = defaultdict(lambda: {"prices": [], "costs": [], "kwhs": []})
    for slot in consumption_30d:
        dt_local = datetime.fromisoformat(slot["interval_start"].replace("Z", "+00:00")).astimezone(LONDON)
        hour = dt_local.hour
        dow = dt_local.weekday()
        kwh = slot["consumption"]
        price = prices_map.get(slot["interval_start"])
        if price is not None:
            cells[(hour, dow)]["prices"].append(price)
            cells[(hour, dow)]["costs"].append(kwh * price)
            cells[(hour, dow)]["kwhs"].append(kwh)

    result = []
    for (hour, dow), v in cells.items():
        n = len(v["prices"])
        if n == 0:
            continue
        result.append({
            "hour": hour,
            "day_of_week": dow,
            "avg_price_inc_vat": round(sum(v["prices"]) / n, 4),
            "avg_cost_pence": round(sum(v["costs"]) / n, 4),
            "avg_kwh": round(sum(v["kwhs"]) / n, 4),
            "sample_count": n,
        })
    return result


def _days_in_month(yyyymm: str) -> int:
    year, month = int(yyyymm[:4]), int(yyyymm[5:7])
    if month == 12:
        next_month = datetime(year + 1, 1, 1)
    else:
        next_month = datetime(year, month + 1, 1)
    return (next_month - datetime(year, month, 1)).days


def build_monthly(days: list[dict]) -> dict:
    now_local = datetime.now(LONDON)
    current_month = now_local.strftime("%Y-%m")
    prev_dt = now_local.replace(day=1) - timedelta(days=1)
    prev_month = prev_dt.strftime("%Y-%m")

    def aggregate(month_str: str) -> dict:
        month_days = [d for d in days if d["date"].startswith(month_str)]
        if not month_days:
            return {
                "month": month_str, "cost_pence": 0.0, "kwh": 0.0,
                "days_complete": 0, "days_in_month": _days_in_month(month_str),
                "projected_cost_pence": 0.0, "avg_daily_cost_pence": 0.0,
            }
        total_cost = sum(d["cost_pence"] for d in month_days)
        total_kwh = sum(d["kwh"] for d in month_days)
        complete_days = sum(1 for d in month_days if d["complete"])
        days_in_month = _days_in_month(month_str)
        avg = total_cost / max(complete_days, 1)
        return {
            "month": month_str,
            "cost_pence": round(total_cost, 2),
            "kwh": round(total_kwh, 3),
            "days_complete": complete_days,
            "days_in_month": days_in_month,
            "projected_cost_pence": round(avg * days_in_month, 2),
            "avg_daily_cost_pence": round(avg, 2),
        }

    return {"current": aggregate(current_month), "previous": aggregate(prev_month)}


def main() -> None:
    api_key = os.environ.get("OCTOPUS_API_KEY", "")
    account_number = os.environ.get("OCTOPUS_ACCOUNT_NUMBER", "")
    if not api_key or not account_number:
        print("ERROR: OCTOPUS_API_KEY and OCTOPUS_ACCOUNT_NUMBER must be set", file=sys.stderr)
        sys.exit(1)

    client = OctopusClient(api_key)
    fetched_at = iso(now_utc())

    # Step 1: Account discovery — fail fast if this fails
    try:
        account = fetch_account(client, account_number)
        write_json("meta.json", {**account, "fetched_at": fetched_at})
    except Exception as e:
        print(f"ERROR fetching account: {e}", file=sys.stderr)
        sys.exit(1)

    mpan = account["mpan"]
    serial = account["meter_serial"]
    product_slug = account["product_slug"]
    tariff_code = account["tariff_code"]
    prices_map: dict[str, float] = {}

    # Step 2: Agile prices
    try:
        price_slots = fetch_prices(client, product_slug, tariff_code)
        now = now_utc()
        tomorrow_start = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        tomorrow_available = any(
            datetime.fromisoformat(s["valid_from"].replace("Z", "+00:00")).replace(tzinfo=None)
            >= tomorrow_start.replace(tzinfo=None)
            for s in price_slots
        )
        write_json("prices.json", {
            "fetched_at": fetched_at,
            "tomorrow_available": tomorrow_available,
            "slots": price_slots,
        })
        for s in price_slots:
            prices_map[s["valid_from"]] = s["value_inc_vat"]
    except Exception as e:
        print(f"WARNING: could not fetch prices: {e}", file=sys.stderr)

    # Step 3: Consumption 48h
    try:
        consumption_48h = fetch_consumption(client, mpan, serial, hours=48)
        write_json("consumption.json", {
            "fetched_at": fetched_at,
            "period_from": iso(now_utc() - timedelta(hours=48)),
            "period_to": iso(now_utc()),
            "slots": consumption_48h,
        })
    except Exception as e:
        print(f"WARNING: could not fetch 48h consumption: {e}", file=sys.stderr)

    # Step 4: Consumption 30d + historical prices → daily, heatmap, monthly
    try:
        consumption_30d = fetch_consumption(client, mpan, serial, hours=30 * 24)

        print("Fetching historical prices (30d)…")
        now = now_utc()
        hist_slots = client.paginate(
            f"/products/{product_slug}/electricity-tariffs/{tariff_code}/standard-unit-rates/",
            {
                "period_from": iso(now - timedelta(days=30)),
                "period_to": iso(now),
            },
            authenticated=False,
        )
        for s in hist_slots:
            prices_map[s["valid_from"]] = s["value_inc_vat"]

        days = build_daily(consumption_30d, prices_map)
        write_json("daily.json", {"fetched_at": fetched_at, "days": days})

        write_json("heatmap.json", {
            "fetched_at": fetched_at,
            "basis_days": 30,
            "cells": build_heatmap(consumption_30d, prices_map),
        })

        write_json("monthly.json", {"fetched_at": fetched_at, **build_monthly(days)})
    except Exception as e:
        print(f"WARNING: could not fetch 30d data: {e}", file=sys.stderr)

    print("Done.")


if __name__ == "__main__":
    main()
