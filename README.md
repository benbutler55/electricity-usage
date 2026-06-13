# Electricity Usage Dashboard

Personal electricity usage dashboard for Octopus Energy (Agile tariff), deployed to GitHub Pages.

## Features

- **Live Agile prices** — half-hourly prices colour-coded by tier (negative / cheap / mid / peak)
- **Today summary** — cost and consumption for the latest available day; falls back to most recent complete day when today's meter data hasn't arrived yet
- **Consumption vs price overlay** — 72-hour dual-axis chart overlaying kWh bars with the price line; consumption bars populate as meter data arrives (~24–48h lag)
- **30-day daily cost chart** with 30-day average reference line
- **Time-of-day heatmap** — 24h × 7-day SVG grid of average prices; identifies cheapest and most expensive periods across the week
- **Cost analysis** — peak usage percentage (4–7pm) and estimated daily saving from load-shifting
- **Battery optimiser** — selectable battery products, grouped into **whole-home (installed)** and **portable** (the latter kept for comparison but flagged as unsuitable for whole-home bill reduction). Shows a price timeline and optimal charge/discharge windows for **both Agile and Octopus Cosy** over the same day so the schedules can be compared side by side (Cosy's coarse rate periods are normalised onto Agile's half-hour grid), estimated daily/monthly savings capped by your actual typical peak consumption, and theoretical maximum. The comparison table scores every battery on Agile vs **Octopus Cosy** (eligible for electric-boiler / storage-heater homes — unlike Octopus Go, which requires an EV) over one representative full day so the figures stay comparable. A **discharge-power check** warns when a battery's continuous output (kW) is below the home's busiest-hour demand, since the shortfall is still imported at the peak rate
- **Monthly summary** — current month spend vs previous month with projected full-month total

## Architecture

```
GitHub Actions (every 2h)
  → Python fetches Octopus Energy API
      - Account discovery (auto-detects MPAN, meter serial, tariff, region)
      - Agile prices: 72h history + today + tomorrow → prices.json
      - Consumption: last 72h → consumption.json
      - Consumption: last 30 days + historical prices → daily.json
      - Heatmap aggregation (24h × 7d avg price & kWh) → heatmap.json
      - Monthly summary (current + previous month) → monthly.json
      - Account metadata → meta.json
  → Vite builds React app (JSON included via public/ passthrough)
  → Deploys to GitHub Pages
```

Data files are generated at build time and never committed to git.

## Data files

| File | Contents | Updated |
|---|---|---|
| `prices.json` | Half-hourly Agile prices, 72h back + tomorrow | Every 2h |
| `consumption.json` | Half-hourly meter readings, last 72h | Every 2h |
| `daily.json` | Daily cost + kWh totals, last 30 days | Every 2h |
| `heatmap.json` | Avg price & consumption per hour × day-of-week | Every 2h |
| `monthly.json` | Current and previous month summaries | Every 2h |
| `meta.json` | MPAN, meter serial, tariff code, fetch timestamp | Every 2h |

## Setup

### 1. Create GitHub repository

Create a public repo named `electricity-usage` on your GitHub account.

### 2. Get your Octopus API key

Log in at [octopus.energy](https://octopus.energy) → Account → Developer settings → Generate API key.

### 3. Add GitHub Secrets

In the repo: Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `OCTOPUS_API_KEY` | Your API key (starts with `sk_`) |
| `OCTOPUS_ACCOUNT_NUMBER` | Your account number (format: `A-XXXXXXXX`) |

MPAN, meter serial, tariff code, and region are auto-discovered from your account.
If your account has multiple meters (e.g. after a smart meter upgrade), the script probes each serial and uses the one that returns consumption data.

### 4. Enable GitHub Pages

Settings → Pages → Source: **GitHub Actions**

### 5. Push and deploy

```bash
git remote add origin git@github.com:YOUR_USERNAME/electricity-usage.git
git push -u origin main
```

The workflow triggers automatically on push and every 2 hours thereafter.
Your dashboard will be live at `https://YOUR_USERNAME.github.io/electricity-usage/`

## Local development

### Python data fetch (requires your API key)

```bash
pip install -r scripts/requirements.txt
OCTOPUS_API_KEY=sk_... OCTOPUS_ACCOUNT_NUMBER=A-... python scripts/fetch_data.py
```

### React dev server

```bash
npm install
npm run dev
# http://localhost:5173
```

Data files from the Python fetch are served by the Vite dev server from `public/data/`.

### Tests

```bash
npm test                    # vitest — battery savings engine (src/lib/*.test.ts)
python -m pytest scripts/   # Octopus client retry/backoff, User-Agent, failure diagnostics
```

## Notes

- **Resilient fetch**: the Octopus client sends a descriptive `User-Agent` and retries transient 403/429/5xx with jittered backoff (honouring `Retry-After`). If the API is still unreachable after retries (e.g. an intermittent edge/WAF 403 on a CI runner IP), the workflow keeps the **last successful deploy** and skips redeploy rather than publishing empty data or failing the run — a `::warning::` is emitted instead. A genuine `401` (bad/revoked key) still fails the run loudly. On failure the client logs the response body + edge headers so the blocking layer is identifiable.
- **Meter data lag**: Smart meter readings flow through the DCC and arrive at Octopus ~24–48h after the consumption period. The dashboard handles this gracefully — consumption sections show available data and label the lag.
- **Agile price publication**: Tomorrow's half-hourly prices are published daily between 4pm and 8pm. The battery optimiser's live *schedule* shows tomorrow once available, falling back to today's remaining prices.
- **Battery savings formula**: `saving = effectiveKwh × (avgPeakRate − avgChargeRate ÷ efficiency)`. Effective kWh is capped at your typical peak-hour consumption (from the heatmap) to avoid over-stating savings for batteries larger than your actual peak load.
- **Savings comparison window**: the comparison table scores every tariff over one *representative complete day* (the latest day with full price coverage), not the live partial-day window. This keeps Agile and Cosy comparable and stops the figures collapsing to £0.00 before tomorrow's Agile prices publish.
- **Slot duration**: energy moved per slot is derived from each slot's actual `valid_from`→`valid_to` span, so fixed tariffs that return multi-hour rate periods (Cosy) are measured correctly rather than as if every slot were 30 minutes.
- **Comparison tariff**: the secondary tariff modelled against Agile is **Octopus Cosy** — eligible for electric-boiler and storage-heater homes (Octopus Go requires an EV/smart charger, so it isn't an option for a battery-only home). The purpose-built storage-heater tariff **Snug Octopus** is the ideal fit but has no public API product code and is currently unavailable, so Cosy is the closest live comparator.
- **Battery catalogue**: `BATTERY_CATALOG` in `scripts/fetch_data.py` carries `output_kw` (continuous discharge power) and a `whole_home` flag. `efficiency` is the **AC round-trip** (grid→battery→home) — the figure that matters for no-solar arbitrage — not the marketing "solar-to-home" number. Specs are sourced from manufacturer datasheets + UK retailer listings; update and re-push when they change.
- **Discharge-power warning**: `assessOutputPower` flags a battery whose `output_kw` is below the home's busiest **expensive-rate** hour (`peakDemandKw` looks only at dear-tier hours — the ones a battery actually discharges into — so a storage-heater home's cheap overnight charging spike doesn't trigger false warnings). The conservatism is a single knob, `PEAK_POWER_SAFETY_FACTOR` in `src/lib/agileZones.ts`.
