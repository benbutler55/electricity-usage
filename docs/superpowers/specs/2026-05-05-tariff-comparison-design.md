# Tariff Comparison Design

**Date:** 2026-05-05  
**Status:** Approved

## Summary

Three coordinated additions to the electricity dashboard:

1. A **2×2 tariff comparison panel** showing Agile, Go, Cosy, and Flux rate structures for today
2. **Flux savings columns** added to the existing battery comparison table
3. A **`octopus-tariff-lister` skill + `/octopus-tariffs` slash command** for on-demand live tariff analysis

---

## 1. Data Layer

### New: `public/data/tariff_comparison.json`

Produced by a new `fetch_tariff_comparison(client, region)` function added to `scripts/fetch_data.py`. Called in `main()` after the existing steps.

**What it fetches:**
- Octopus Go (`GO-FIX-12M-26-04-18`)
- Cosy Octopus (`COSY-FIX-12M-26-03-23`)
- Intelligent Flux (`INTELLI-FLUX-IMPORT-23-07-14`)
- Flexible Octopus (`VAR-22-11-01`)

For each: calls `standard-unit-rates/` for the user's region letter (e.g. `E-1R-GO-FIX-12M-26-04-18-C`). Fetches the last 72h of slots (matching the existing prices window) so today's rates are always present.

**Schema:**
```json
{
  "fetched_at": "2026-05-05T12:00:00Z",
  "region": "C",
  "tariffs": [
    {
      "id": "go",
      "name": "Octopus Go",
      "product_slug": "GO-FIX-12M-26-04-18",
      "slots": [
        { "valid_from": "...", "valid_to": "...", "value_inc_vat": 9.5 },
        { "valid_from": "...", "valid_to": "...", "value_inc_vat": 31.6 }
      ]
    },
    { "id": "cosy", "name": "Cosy Octopus", "product_slug": "COSY-FIX-12M-26-03-23", "slots": [...] },
    { "id": "flux", "name": "Intelligent Flux", "product_slug": "INTELLI-FLUX-IMPORT-23-07-14", "slots": [...] },
    { "id": "flexible", "name": "Flexible Octopus", "product_slug": "VAR-22-11-01", "slots": [...] }
  ]
}
```

`slots` uses the same `PriceSlot` shape (`valid_from`, `valid_to`, `value_inc_vat`) already in `types/data.ts`. Rates for fixed tariffs repeat daily; Flux updates periodically.

**Error handling:** Failure to fetch any individual tariff is caught and logged as a warning. If the whole step fails, `main()` continues (same pattern as existing optional steps).

### Updated: `src/types/data.ts`

Add two new types:
```ts
export interface TariffEntry {
  id: string
  name: string
  product_slug: string
  slots: PriceSlot[]
}

export interface TariffComparisonData {
  fetched_at: string
  region: string
  tariffs: TariffEntry[]
}
```

---

## 2. Frontend

### New: `src/components/tariffs/TariffComparisonPanel.tsx`

**Layout:** 2×2 CSS grid, one card per tariff.

**Data:** `useData<TariffComparisonData>('./data/tariff_comparison.json')`. Agile data comes from the existing `usePrices()` hook.

**Each card shows:**
- Tariff name + type badge (LIVE / FIXED / DYNAMIC)
- A horizontal rate-band bar — each segment's width is proportional to hours at that rate within a 24h window, coloured via the existing `tierColour(price)` function
- Rate labels inside or below each band (e.g. `9.5p · 31.6p`)
- A one-line summary (cheap window description or avg/range for Agile)

**Agile card:** Uses `prices.json` slots for today; renders a sparkline bar chart (same bar-per-slot approach as the existing price timeline in `BatteryOptimiser`) instead of fixed bands.

**Placement in `Dashboard.tsx`:** New `<SectionGrid cols={1}>` block inserted between `<ConsumptionOverlay />` and `<DailyCostBarChart />`.

### Modified: `src/components/battery/BatteryOptimiser.tsx`

**Two new columns** in the existing battery comparison table:

| Model | kWh | Price | +Install | Monthly saving | Payback | **Flux/mo** | **Payback (F)** | Type |
|---|---|---|---|---|---|---|---|---|

Flux slots are read via a `useData<TariffComparisonData>('./data/tariff_comparison.json')` call directly inside `BatteryOptimiser` (same pattern as the existing `heatmap.json` and `batteries.json` calls already in that component). The Flux tariff entry is located by `id === 'flux'`. For each battery, `calcBatterySavings(fluxSlots, battery.kwh, heatmap?.cells, battery.charge_rate_kw, battery.efficiency)` is called — the existing function requires no changes.

If `tariff_comparison.json` hasn't loaded, Flux columns render `—`.

---

## 3. CLI Tooling

### Skill: `.claude/skills/octopus-tariff-lister.md`

When invoked, Claude executes the following analysis:

1. Read `public/data/meta.json` → extract `region`
2. `GET /v1/products/?page_size=100` → filter to open, residential, import, non-business, non-prepay, non-restricted, `brand=OCTOPUS_ENERGY`
3. For each time-of-use tariff (Go, Cosy, Flux, Intelligent Go, and any new ones): fetch `standard-unit-rates/` for the region, get the most recent set of rates
4. Read `public/data/daily.json` → compute average daily kWh and typical hourly distribution from the 30-day history
5. For each tariff: estimate monthly cost by applying rate windows to consumption pattern (cheap-window hours get cheap rate; peak hours get peak rate; rest get standard rate)
6. Compare estimated monthly costs to actual Agile spend from `daily.json`
7. Output a formatted markdown table:

```
| Tariff              | Rate structure          | Est. monthly | vs Agile | Eligible? |
|---------------------|-------------------------|-------------|---------|-----------|
| Agile (current)     | Dynamic 30-min          | £XX         | —       | ✓ on it   |
| Flexible Octopus    | Flat ~XXp               | £XX         | +/-£XX  | ✓         |
| Octopus Go          | 9.5p 00:30–05:30 / 31p  | £XX         | +/-£XX  | needs EV  |
| Intelligent Go      | 9.5p 23:30–05:30 / 31p  | £XX         | +/-£XX  | needs EV  |
| Cosy Octopus        | 14p×8h / 32p / 50p peak | £XX         | +/-£XX  | needs HP  |
| Intelligent Flux    | 21p / 28p 15–18h        | £XX         | +/-£XX  | needs bat |
```

Followed by a short plain-English recommendation based on the numbers.

### Slash command: `.claude/commands/octopus-tariffs.md`

Thin wrapper that invokes the skill. Accepts an optional `--region X` argument to override the region from `meta.json` (for checking a different DNO region without re-running the fetch).

Running `/octopus-tariffs` triggers the full analysis. Running `/octopus-tariffs --region A` runs the same analysis for region A.

---

## Implementation order

1. `scripts/fetch_data.py` — add `fetch_tariff_comparison`, write `tariff_comparison.json`
2. `src/types/data.ts` — add `TariffEntry` and `TariffComparisonData`
3. `src/components/tariffs/TariffComparisonPanel.tsx` — new component
4. `src/app/Dashboard.tsx` — insert panel
5. `src/components/battery/BatteryOptimiser.tsx` — add Flux columns
6. `.claude/skills/octopus-tariff-lister.md` — skill definition
7. `.claude/commands/octopus-tariffs.md` — slash command

Each step is independently testable and shippable.
