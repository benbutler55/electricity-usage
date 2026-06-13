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

# Exit code signalling "couldn't reach the API this run" (e.g. an intermittent
# edge/WAF 403). The workflow treats it as soft: keep the last successful deploy
# rather than publishing empty data or marking the run failed.
EXIT_FETCH_BLOCKED = 75


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


def find_active_meter_serial(
    client: OctopusClient, mpan: str, serials: list[str]
) -> str:
    """Try each meter serial and return the first one that has consumption data."""
    now = now_utc()
    period_from = iso(now - timedelta(hours=48))
    path = f"/electricity-meter-points/{mpan}/meters/{{serial}}/consumption/"
    for serial in serials:
        try:
            result = client.get(
                path.format(serial=serial),
                {
                    "period_from": period_from,
                    "period_to": iso(now),
                    "page_size": 1,
                },
            )
            if result.get("count", 0) > 0 or result.get("results"):
                print(f"  active meter serial: {serial}")
                return serial
            print(f"  serial {serial}: no data")
        except Exception as e:
            print(f"  serial {serial}: error ({e})")
    # Fall back to first serial if none return data
    print(f"  warning: no serial returned data, using {serials[0]}")
    return serials[0]


def fetch_account(client: OctopusClient, account_number: str) -> dict:
    print("Fetching account info…")
    data = client.get(f"/accounts/{account_number}/")
    prop = data["properties"][0]
    emp = prop["electricity_meter_points"][0]
    mpan = emp["mpan"]

    # Collect all meter serials — accounts may have multiple (old + new after upgrade)
    all_serials = [m["serial_number"] for m in emp.get("meters", [])]
    print(f"  meters found: {all_serials}")
    meter_serial = (
        find_active_meter_serial(client, mpan, all_serials) if all_serials else ""
    )

    # Find active agreement (no end date or end date in future)
    now = now_utc()
    agreements = emp.get("agreements", [])
    active = next(
        (
            a
            for a in agreements
            if a.get("valid_to") is None
            or datetime.fromisoformat(a["valid_to"].replace("Z", "+00:00")) > now
        ),
        agreements[0] if agreements else None,
    )
    if not active:
        raise ValueError("No active tariff agreement found")
    tariff_code = active["tariff_code"]
    # e.g. E-1R-AGILE-24-10-01-A → product_slug=AGILE-24-10-01, region=A
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


def fetch_standing_charge(
    client: OctopusClient, product_slug: str, tariff_code: str
) -> float:
    """Return the current standing charge in pence/day inc VAT."""
    path = (
        f"/products/{product_slug}/electricity-tariffs/{tariff_code}/standing-charges/"
    )
    slots = client.paginate(path, authenticated=False)
    if not slots:
        raise ValueError(f"No standing charge data for {tariff_code}")
    now = now_utc()
    active = next(
        (
            s
            for s in slots
            if s.get("valid_to") is None
            or datetime.fromisoformat(s["valid_to"].replace("Z", "+00:00")) > now
        ),
        slots[0],
    )
    return active["value_inc_vat"]


def fetch_prices(
    client: OctopusClient, product_slug: str, tariff_code: str
) -> list[dict]:
    print("Fetching Agile prices…")
    now = now_utc()
    # Go back 72h so prices overlap fully with the consumption window
    period_from = (now - timedelta(hours=72)).replace(minute=0, second=0, microsecond=0)
    period_to = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(
        days=2
    )
    path = f"/products/{product_slug}/electricity-tariffs/{tariff_code}/standard-unit-rates/"
    slots = client.paginate(
        path,
        {
            "period_from": iso(period_from),
            "period_to": iso(period_to),
        },
        authenticated=False,
    )
    return sorted(slots, key=lambda s: s["valid_from"])


def fetch_consumption(
    client: OctopusClient, mpan: str, serial: str, hours: int = 72
) -> list[dict]:
    print(f"Fetching consumption ({hours}h)…")
    now = now_utc()
    period_from = now - timedelta(hours=hours)
    path = f"/electricity-meter-points/{mpan}/meters/{serial}/consumption/"
    slots = client.paginate(
        path,
        {
            "period_from": iso(period_from),
            "period_to": iso(now),
            "order_by": "period",
        },
    )
    return sorted(slots, key=lambda s: s["interval_start"])


def _utc_key(ts: str) -> str:
    """Normalise any ISO timestamp to UTC Z format for consistent map lookups."""
    return (
        datetime.fromisoformat(ts.replace("Z", "+00:00"))
        .astimezone(timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )


def build_daily(
    consumption_30d: list[dict], prices_map: dict[str, float]
) -> list[dict]:
    by_day: dict[str, dict] = defaultdict(
        lambda: {"cost_pence": 0.0, "kwh": 0.0, "slot_count": 0}
    )
    for slot in consumption_30d:
        dt_local = datetime.fromisoformat(
            slot["interval_start"].replace("Z", "+00:00")
        ).astimezone(LONDON)
        day_key = dt_local.strftime("%Y-%m-%d")
        kwh = slot["consumption"]
        price = prices_map.get(_utc_key(slot["interval_start"]))
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


def build_heatmap(
    consumption_30d: list[dict], prices_map: dict[str, float]
) -> list[dict]:
    cells: dict[tuple[int, int], dict] = defaultdict(
        lambda: {"prices": [], "costs": [], "kwhs": []}
    )
    for slot in consumption_30d:
        dt_local = datetime.fromisoformat(
            slot["interval_start"].replace("Z", "+00:00")
        ).astimezone(LONDON)
        hour = dt_local.hour
        dow = dt_local.weekday()
        kwh = slot["consumption"]
        price = prices_map.get(_utc_key(slot["interval_start"]))
        if price is not None:
            cells[(hour, dow)]["prices"].append(price)
            cells[(hour, dow)]["costs"].append(kwh * price)
            cells[(hour, dow)]["kwhs"].append(kwh)

    result = []
    for (hour, dow), v in cells.items():
        n = len(v["prices"])
        if n == 0:
            continue
        result.append(
            {
                "hour": hour,
                "day_of_week": dow,
                "avg_price_inc_vat": round(sum(v["prices"]) / n, 4),
                "avg_cost_pence": round(sum(v["costs"]) / n, 4),
                "avg_kwh": round(sum(v["kwhs"]) / n, 4),
                "sample_count": n,
            }
        )
    return result


def _days_in_month(yyyymm: str) -> int:
    year, month = int(yyyymm[:4]), int(yyyymm[5:7])
    if month == 12:
        next_month = datetime(year + 1, 1, 1)
    else:
        next_month = datetime(year, month + 1, 1)
    return (next_month - datetime(year, month, 1)).days


def build_monthly(days: list[dict], sc_per_day: float) -> dict:
    now_local = datetime.now(LONDON)
    current_month = now_local.strftime("%Y-%m")
    prev_dt = now_local.replace(day=1) - timedelta(days=1)
    prev_month = prev_dt.strftime("%Y-%m")

    def aggregate(month_str: str) -> dict:
        month_days = [d for d in days if d["date"].startswith(month_str)]
        if not month_days:
            return {
                "month": month_str,
                "cost_pence": 0.0,
                "kwh": 0.0,
                "days_complete": 0,
                "days_in_month": _days_in_month(month_str),
                "projected_cost_pence": 0.0,
                "avg_daily_cost_pence": 0.0,
            }
        unit_cost = sum(d["cost_pence"] for d in month_days)
        total_kwh = sum(d["kwh"] for d in month_days)
        complete_days = sum(1 for d in month_days if d["complete"])
        days_in_month = _days_in_month(month_str)
        total_cost = unit_cost + sc_per_day * complete_days
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


# Whole-home batteries wire into the consumer unit and can power general household
# load; portable stations (plug_in=True) only run whatever is plugged into them and
# are NOT suitable for whole-home time-of-use bill reduction — kept for comparison.
#
# Specs sourced from manufacturer datasheets + UK retailer listings, verified 2026-06-13.
# `efficiency` is the AC round-trip (grid→battery→home) — the figure that matters for
# no-solar arbitrage — NOT marketing "solar-to-home" efficiency. `output_kw` is the
# continuous discharge power: a battery whose output_kw is below the home's peak draw
# cannot cover the whole load and the shortfall is still imported from the grid.
BATTERY_CATALOG = [
    # ── Whole-home (installed) ──────────────────────────────────────────────
    {
        "id": "tesla-powerwall-3",
        "name": "Tesla Powerwall 3",
        "kwh": 13.5,
        "charge_rate_kw": 5.0,
        "output_kw": 11.5,
        "efficiency": 0.90,
        "price_gbp": 7500,
        "install_gbp": 2000,
        "plug_in": False,
        "whole_home": True,
        "url": "https://www.tesla.com/en_gb/powerwall",
        "notes": "13.5 kWh usable · 11.5 kW continuous · 10yr warranty · ~£8.5–10.5k installed (top of budget) · grid round-trip ~90% (97.5% headline is solar-to-home)",
    },
    {
        "id": "givenergy-all-in-one",
        "name": "GivEnergy All-in-One",
        "kwh": 13.5,
        "charge_rate_kw": 6.0,
        "output_kw": 6.0,
        "efficiency": 0.90,
        "price_gbp": 6650,
        "install_gbp": 1200,
        "plug_in": False,
        "whole_home": True,
        "url": "https://givenergy.com/products/all-in-one/",
        "notes": "13.5 kWh usable · 100% DoD · 6 kW AC-coupled inverter (battery cell rated 7.2 kW) · 12yr warranty · ~£7–8k installed",
    },
    {
        "id": "ecoflow-powerocean-10",
        "name": "EcoFlow PowerOcean (10 kWh)",
        "kwh": 10.24,
        "charge_rate_kw": 6.0,
        "output_kw": 5.0,
        "efficiency": 0.94,
        "price_gbp": 5200,
        "install_gbp": 750,
        "plug_in": False,
        "whole_home": True,
        "url": "https://energy.ecoflow.com/uk/products/PowerOcean-Single-Phase",
        "notes": "LFP · 6,000 cycles · 15yr warranty · Octopus native integration · dedicated circuit",
    },
    {
        "id": "ecoflow-powerocean-5",
        "name": "EcoFlow PowerOcean (5 kWh)",
        "kwh": 5.12,
        "charge_rate_kw": 6.0,
        "output_kw": 5.0,
        "efficiency": 0.94,
        "price_gbp": 2750,
        "install_gbp": 750,
        "plug_in": False,
        "whole_home": True,
        "url": "https://energy.ecoflow.com/uk/products/PowerOcean-Single-Phase",
        "notes": "LFP · 6,000 cycles · 15yr warranty · Octopus native integration · dedicated circuit",
    },
    {
        "id": "fox-ess-ecs",
        "name": "Fox ESS ECS (12.4 kWh)",
        "kwh": 12.42,
        "charge_rate_kw": 3.68,
        "output_kw": 3.68,
        "efficiency": 0.90,
        "price_gbp": 5000,
        "install_gbp": 1000,
        "plug_in": False,
        "whole_home": True,
        "url": "https://www.fox-ess.com/",
        "notes": "Modular 4.14 kWh × 3 · 90% DoD · single-phase inverter ~3.68 kW (low output — may not cover peak load) · 10–12yr warranty · ~£5.5–7.5k installed",
    },
    # ── Portable power stations (plug-in, NOT for whole-home bill reduction) ──
    {
        "id": "dji-power-2000",
        "name": "DJI Power 2000",
        "kwh": 2.048,
        "charge_rate_kw": 2.2,
        "output_kw": 3.0,
        "efficiency": 0.90,
        "price_gbp": 959,
        "install_gbp": 0,
        "plug_in": True,
        "whole_home": False,
        "url": "https://store.dji.com/uk/product/dji-power-2000",
        "notes": "LiFePO4 · 4,000 cycles · expandable · 13A plug · portable only — too small for whole-home arbitrage",
    },
    {
        "id": "dji-power-1000",
        "name": "DJI Power 1000",
        "kwh": 1.024,
        "charge_rate_kw": 2.2,
        "output_kw": 2.2,
        "efficiency": 0.90,
        "price_gbp": 699,
        "install_gbp": 0,
        "plug_in": True,
        "whole_home": False,
        "url": "https://store.dji.com/uk/product/dji-power-1000",
        "notes": "LiFePO4 · 4,000 cycles · expandable to 11.3 kWh · 13A plug · portable only",
    },
    {
        "id": "mygrid-moduleone",
        "name": "MyGrid ModuleOne",
        "kwh": 1.5,
        "charge_rate_kw": 0.8,
        "output_kw": 0.8,
        "efficiency": 0.90,
        "price_gbp": 1460,
        "install_gbp": 0,
        "plug_in": True,
        "whole_home": False,
        "url": "https://www.mygrid.energy/module-one",
        "notes": "LiFePO4 · 6,000 cycles · 800W bidirectional · UK company · 13A plug · portable only",
    },
]


COMPARISON_TARIFFS = [
    {"id": "go", "name": "Octopus Go", "product_slug": "GO-FIX-12M-26-04-18"},
    {"id": "cosy", "name": "Cosy Octopus", "product_slug": "COSY-FIX-12M-26-03-23"},
    {
        "id": "flux",
        "name": "Intelligent Flux",
        "product_slug": "INTELLI-FLUX-IMPORT-23-07-14",
    },
    {"id": "flexible", "name": "Flexible Octopus", "product_slug": "VAR-22-11-01"},
]


def fetch_tariff_comparison(client: OctopusClient, region: str) -> list[dict]:
    print("Fetching tariff comparison rates…")
    now = now_utc()
    period_from = (now - timedelta(hours=72)).replace(minute=0, second=0, microsecond=0)
    period_to = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(
        days=2
    )

    tariffs = []
    for t in COMPARISON_TARIFFS:
        tariff_code = f"E-1R-{t['product_slug']}-{region}"
        path = f"/products/{t['product_slug']}/electricity-tariffs/{tariff_code}/standard-unit-rates/"
        try:
            slots = client.paginate(
                path,
                {
                    "period_from": iso(period_from),
                    "period_to": iso(period_to),
                },
                authenticated=False,
            )
            tariffs.append(
                {
                    "id": t["id"],
                    "name": t["name"],
                    "product_slug": t["product_slug"],
                    "slots": sorted(slots, key=lambda s: s["valid_from"]),
                }
            )
            print(f"  {t['name']}: {len(slots)} slots")
        except Exception as e:
            print(
                f"  WARNING: could not fetch {t['name']} ({tariff_code}): {e}",
                file=sys.stderr,
            )

    return tariffs


def build_battery_catalog(fetched_at: str) -> dict:
    # Prices are maintained manually here; update and push when manufacturers change pricing
    return {
        "generated_at": fetched_at,
        "prices_verified": fetched_at[:10],
        "batteries": BATTERY_CATALOG,
    }


def main() -> None:
    api_key = os.environ.get("OCTOPUS_API_KEY", "")
    account_number = os.environ.get("OCTOPUS_ACCOUNT_NUMBER", "")
    if not api_key or not account_number:
        print(
            "ERROR: OCTOPUS_API_KEY and OCTOPUS_ACCOUNT_NUMBER must be set",
            file=sys.stderr,
        )
        sys.exit(1)

    client = OctopusClient(api_key)
    fetched_at = iso(now_utc())

    # Step 1: Account discovery — everything downstream needs it. If it fails
    # (typically an intermittent edge/WAF 403 after retries), exit soft so the
    # workflow keeps the last good deploy instead of shipping empty data.
    try:
        account = fetch_account(client, account_number)
        write_json("meta.json", {**account, "fetched_at": fetched_at})
    except Exception as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        if status == 401:
            # Bad/revoked key is a real config error — fail loudly so it's noticed,
            # not silently masked behind stale data.
            print(
                f"ERROR: Octopus API rejected credentials (401) — check OCTOPUS_API_KEY: {e}",
                file=sys.stderr,
            )
            sys.exit(1)
        print(f"WARNING: account discovery failed after retries: {e}", file=sys.stderr)
        sys.exit(EXIT_FETCH_BLOCKED)

    mpan = account["mpan"]
    serial = account["meter_serial"]
    product_slug = account["product_slug"]
    tariff_code = account["tariff_code"]
    prices_map: dict[str, float] = {}

    # Step 2: Agile prices
    try:
        price_slots = fetch_prices(client, product_slug, tariff_code)
        now = now_utc()
        tomorrow_start = (now + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        tomorrow_available = any(
            datetime.fromisoformat(s["valid_from"].replace("Z", "+00:00")).replace(
                tzinfo=None
            )
            >= tomorrow_start.replace(tzinfo=None)
            for s in price_slots
        )
        write_json(
            "prices.json",
            {
                "fetched_at": fetched_at,
                "tomorrow_available": tomorrow_available,
                "slots": price_slots,
            },
        )
        for s in price_slots:
            prices_map[_utc_key(s["valid_from"])] = s["value_inc_vat"]
    except Exception as e:
        print(f"WARNING: could not fetch prices: {e}", file=sys.stderr)

    # Step 3: Consumption 48h
    try:
        consumption_48h = fetch_consumption(client, mpan, serial, hours=72)
        write_json(
            "consumption.json",
            {
                "fetched_at": fetched_at,
                "period_from": iso(now_utc() - timedelta(hours=72)),
                "period_to": iso(now_utc()),
                "slots": consumption_48h,
            },
        )
    except Exception as e:
        print(f"WARNING: could not fetch 48h consumption: {e}", file=sys.stderr)

    # Step 4: Standing charge + consumption 30d + historical prices → daily, heatmap, monthly
    sc_per_day = 0.0
    try:
        sc_per_day = fetch_standing_charge(client, product_slug, tariff_code)
        print(f"  standing charge: {sc_per_day:.4f}p/day")
    except Exception as e:
        print(f"WARNING: could not fetch standing charge: {e}", file=sys.stderr)

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
            prices_map[_utc_key(s["valid_from"])] = s["value_inc_vat"]

        days = build_daily(consumption_30d, prices_map)
        write_json("daily.json", {"fetched_at": fetched_at, "days": days})

        write_json(
            "heatmap.json",
            {
                "fetched_at": fetched_at,
                "basis_days": 30,
                "cells": build_heatmap(consumption_30d, prices_map),
            },
        )

        write_json(
            "monthly.json",
            {
                "fetched_at": fetched_at,
                "standing_charge_per_day": round(sc_per_day, 4),
                **build_monthly(days, sc_per_day),
            },
        )
    except Exception as e:
        print(f"WARNING: could not fetch 30d data: {e}", file=sys.stderr)

    # Step 5: Tariff comparison rates for Go, Cosy, Flux, Flexible
    try:
        comparison_tariffs = fetch_tariff_comparison(client, account["region"])
        write_json(
            "tariff_comparison.json",
            {
                "fetched_at": fetched_at,
                "region": account["region"],
                "tariffs": comparison_tariffs,
            },
        )
    except Exception as e:
        print(f"WARNING: could not fetch tariff comparison: {e}", file=sys.stderr)

    write_json("batteries.json", build_battery_catalog(fetched_at))
    print("Done.")


if __name__ == "__main__":
    main()
