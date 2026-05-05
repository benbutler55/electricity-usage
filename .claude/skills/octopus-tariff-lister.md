---
name: octopus-tariff-lister
description: Lists all current Octopus Energy residential tariffs available to your account, with live unit rates for your region, estimated monthly cost based on 30-day consumption history, and a comparison to current Agile spend. Run this to evaluate whether switching tariffs makes sense.
---

# Octopus Tariff Lister

Execute these steps in order to produce a live tariff comparison for this account.

## Step 1 — Read account region

Read `public/data/meta.json` and extract the `region` letter (e.g. `"C"`).

If `--region X` was passed as an argument, use X instead.

## Step 2 — Fetch all open residential tariffs

Run:

```bash
curl -s "https://api.octopus.energy/v1/products/?page_size=100" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data['results']:
    if (p['brand'] == 'OCTOPUS_ENERGY' and
        p['direction'] == 'IMPORT' and
        not p['is_business'] and
        not p['is_prepay'] and
        not p['is_restricted'] and
        p['available_to'] is None):
        print(p['code'], '|', p['display_name'], '|', p['description'][:100])
"
```

Note every product code and display name.

## Step 3 — Fetch current unit rates for each tariff

For each product code from Step 2, build the tariff code as `E-1R-{PRODUCT_CODE}-{REGION}` and fetch rates:

```bash
curl -s "https://api.octopus.energy/v1/products/{PRODUCT_CODE}/electricity-tariffs/E-1R-{PRODUCT_CODE}-{REGION}/standard-unit-rates/?page_size=10"
```

From the results, extract the distinct `value_inc_vat` rate tiers and their `valid_from`/`valid_to` time windows for the most recent day. Record the cheap rate, standard rate, and peak rate (if any).

## Step 4 — Read 30-day consumption

Read `public/data/daily.json`. From all entries where `complete: true`:
- `avg_daily_kwh` = mean of `kwh` values
- `avg_daily_cost_pence` = mean of `cost_pence` values
- `agile_monthly_estimate` = `avg_daily_cost_pence × 30 / 100` in £

Read `public/data/heatmap.json`. Build an hourly consumption map: for each cell, the `avg_kwh` value tells you typical consumption in that hour.

## Step 5 — Estimate monthly cost on each tariff

For each tariff, estimate monthly cost by applying the rate windows to consumption:

**Flat rate tariff (e.g. Flexible Octopus):**
```
monthly = avg_daily_kwh × unit_rate_pence × 30 / 100
```

**2-rate tariff (e.g. Octopus Go: cheap 00:30–05:30, standard otherwise):**
```
cheap_kwh    = sum of avg_kwh from heatmap for hours 1–5 (London time)
standard_kwh = avg_daily_kwh − cheap_kwh
monthly      = (cheap_kwh × cheap_rate + standard_kwh × standard_rate) × 30 / 100
```

**3-rate tariff (e.g. Cosy: cheap 04–07 + 13–16 + 22–00, peak 16–19, standard rest):**
Apply the same heatmap lookup for each rate window's hours, using the actual `value_inc_vat` rates from Step 3.

**Flux (standard 00–15 + 18–24, peak 15–18):**
```
peak_kwh     = sum of avg_kwh for hours 15, 16, 17
standard_kwh = avg_daily_kwh − peak_kwh
monthly      = (peak_kwh × peak_rate + standard_kwh × standard_rate) × 30 / 100
```
Use actual fetched rates from Step 3, not hardcoded values.

## Step 6 — Present the comparison

Output a markdown table sorted by estimated monthly cost ascending:

| Tariff | Rate structure | Est. monthly | vs Agile | Eligible? |
|---|---|---|---|---|
| Agile (current) | Dynamic 30-min | £X.XX | — | ✓ on it |
| ... | ... | ... | ... | ... |

Use actual fetched rates in the "Rate structure" column. In the "vs Agile" column: negative = cheaper than Agile, positive = more expensive.

Eligibility notes:
- Octopus Go / Intelligent Go: "Needs EV"
- Cosy Octopus: "Needs heat pump"
- Intelligent Flux: "Needs solar + battery"
- All others: "✓"

Follow the table with a 2–3 sentence plain-English summary noting the best alternative and whether switching makes financial sense given the consumption pattern.
