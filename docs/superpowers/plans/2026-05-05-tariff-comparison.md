# Tariff Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 2×2 tariff comparison panel to the dashboard, Flux savings columns to the battery optimiser table, and an `octopus-tariff-lister` skill + `/octopus-tariffs` slash command.

**Architecture:** Build-time fetch in `fetch_data.py` writes `tariff_comparison.json` with rates for Go, Cosy, Flux, and Flexible for the account's region. The React components read that file via the existing `useData` hook pattern. The CLI skill calls the live API on demand and cross-references `daily.json` consumption for cost estimates.

**Tech Stack:** Python 3 + requests (data fetch), React + TypeScript + Tailwind (frontend), Claude Code skills/commands (CLI tooling)

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `scripts/fetch_data.py` | Add `COMPARISON_TARIFFS` constant + `fetch_tariff_comparison()` + call in `main()` |
| Generated | `public/data/tariff_comparison.json` | Rate slots for Go/Cosy/Flux/Flexible for account region |
| Modify | `src/types/data.ts` | Add `TariffEntry` and `TariffComparisonData` interfaces |
| Create | `src/components/tariffs/TariffComparisonPanel.tsx` | 2×2 card grid showing rate-band bars for each tariff |
| Modify | `src/app/Dashboard.tsx` | Insert `<TariffComparisonPanel>` between ConsumptionOverlay and DailyCostBarChart |
| Modify | `src/components/battery/BatteryOptimiser.tsx` | Add `useData` call for tariff_comparison.json; add Flux/mo + Payback (F) columns |
| Modify | `.gitignore` | Add `.superpowers/` |
| Create | `.claude/skills/octopus-tariff-lister.md` | Skill: live API analysis with consumption-based cost estimate |
| Create | `.claude/commands/octopus-tariffs.md` | Slash command wrapper |

---

## Task 1: Python data fetch

**Files:**
- Modify: `scripts/fetch_data.py`

- [ ] **Step 1: Add `COMPARISON_TARIFFS` constant and `fetch_tariff_comparison` function**

Add after the `BATTERY_CATALOG` constant (around line 294) and before `build_battery_catalog`:

```python
COMPARISON_TARIFFS = [
    {"id": "go",       "name": "Octopus Go",       "product_slug": "GO-FIX-12M-26-04-18"},
    {"id": "cosy",     "name": "Cosy Octopus",      "product_slug": "COSY-FIX-12M-26-03-23"},
    {"id": "flux",     "name": "Intelligent Flux",  "product_slug": "INTELLI-FLUX-IMPORT-23-07-14"},
    {"id": "flexible", "name": "Flexible Octopus",  "product_slug": "VAR-22-11-01"},
]


def fetch_tariff_comparison(client: OctopusClient, region: str) -> list[dict]:
    print("Fetching tariff comparison rates…")
    now = now_utc()
    period_from = (now - timedelta(hours=72)).replace(minute=0, second=0, microsecond=0)
    period_to = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=2)

    tariffs = []
    for t in COMPARISON_TARIFFS:
        tariff_code = f"E-1R-{t['product_slug']}-{region}"
        path = f"/products/{t['product_slug']}/electricity-tariffs/{tariff_code}/standard-unit-rates/"
        try:
            slots = client.paginate(path, {
                "period_from": iso(period_from),
                "period_to": iso(period_to),
            }, authenticated=False)
            tariffs.append({
                "id": t["id"],
                "name": t["name"],
                "product_slug": t["product_slug"],
                "slots": sorted(slots, key=lambda s: s["valid_from"]),
            })
            print(f"  {t['name']}: {len(slots)} slots")
        except Exception as e:
            print(f"  WARNING: could not fetch {t['name']} ({tariff_code}): {e}", file=sys.stderr)

    return tariffs
```

- [ ] **Step 2: Call `fetch_tariff_comparison` in `main()`**

Add as the final data-fetch step, just before the `write_json("batteries.json", ...)` call (around line 392):

```python
    # Step 5: Tariff comparison rates for Go, Cosy, Flux, Flexible
    try:
        comparison_tariffs = fetch_tariff_comparison(client, account["region"])
        write_json("tariff_comparison.json", {
            "fetched_at": fetched_at,
            "region": account["region"],
            "tariffs": comparison_tariffs,
        })
    except Exception as e:
        print(f"WARNING: could not fetch tariff comparison: {e}", file=sys.stderr)
```

- [ ] **Step 3: Run ruff and verify the script executes**

```bash
cd /home/ben/Github/personal/electricity-usage
ruff check scripts/fetch_data.py
```

Expected: no errors.

Then do a dry-run smoke test against the live API (replace with real values):

```bash
OCTOPUS_API_KEY=sk_live_... OCTOPUS_ACCOUNT_NUMBER=A-... python scripts/fetch_data.py
```

Expected output includes:
```
Fetching tariff comparison rates…
  Octopus Go: N slots
  Cosy Octopus: N slots
  Intelligent Flux: N slots
  Flexible Octopus: N slots
  wrote public/data/tariff_comparison.json
```

Verify the file was written:
```bash
python3 -c "import json; d=json.load(open('public/data/tariff_comparison.json')); print(d['region'], [t['id'] for t in d['tariffs']])"
```

Expected: `C ['go', 'cosy', 'flux', 'flexible']` (region letter will match account).

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch_data.py
git commit -m "feat: fetch tariff comparison rates for Go/Cosy/Flux/Flexible"
```

---

## Task 2: TypeScript types

**Files:**
- Modify: `src/types/data.ts`

- [ ] **Step 1: Add `TariffEntry` and `TariffComparisonData` interfaces**

Append to the end of `src/types/data.ts`:

```ts
export interface TariffEntry {
  id: string           // 'go' | 'cosy' | 'flux' | 'flexible'
  name: string
  product_slug: string
  slots: PriceSlot[]   // same shape as prices.json slots
}

export interface TariffComparisonData {
  fetched_at: string
  region: string
  tariffs: TariffEntry[]
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/ben/Github/personal/electricity-usage
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types/data.ts
git commit -m "feat: add TariffEntry and TariffComparisonData types"
```

---

## Task 3: TariffComparisonPanel component

**Files:**
- Create: `src/components/tariffs/TariffComparisonPanel.tsx`

- [ ] **Step 1: Create the component file**

```bash
mkdir -p /home/ben/Github/personal/electricity-usage/src/components/tariffs
```

Create `src/components/tariffs/TariffComparisonPanel.tsx` with:

```tsx
import { useData } from '../../hooks/useData'
import { usePrices } from '../../hooks/usePrices'
import type { TariffComparisonData, TariffEntry, PriceSlot } from '../../types/data'
import { tierColour } from '../../lib/priceColour'

/** Returns the ms timestamp of midnight today in Europe/London. */
function londonMidnightMs(): number {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).format(now)
  const [h, m] = parts.split(':').map(Number)
  return now.getTime() - (h * 3600 + m * 60) * 1000 - now.getSeconds() * 1000 - now.getMilliseconds()
}

interface Band {
  leftPct: number
  widthPct: number
  price: number
}

function slotsToBands(slots: PriceSlot[]): Band[] {
  const midnight = londonMidnightMs()
  const end = midnight + 86400000
  return slots
    .map(s => ({ from: +new Date(s.valid_from), to: +new Date(s.valid_to), price: s.value_inc_vat }))
    .filter(s => s.to > midnight && s.from < end)
    .sort((a, b) => a.from - b.from)
    .map(s => ({
      leftPct: (Math.max(s.from, midnight) - midnight) / 86400000 * 100,
      widthPct: (Math.min(s.to, end) - Math.max(s.from, midnight)) / 86400000 * 100,
      price: s.price,
    }))
}

const TIME_LABELS = ['00:00', '06:00', '12:00', '18:00', '23:30']

function BandBar({ bands }: { bands: Band[] }) {
  return (
    <>
      <div className="relative h-8 rounded overflow-hidden bg-slate-900/50">
        {bands.map((b, i) => (
          <div
            key={i}
            className="absolute top-0 bottom-0 flex items-center justify-center"
            style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%`, backgroundColor: tierColour(b.price), opacity: 0.85 }}
            title={`${b.price.toFixed(1)}p/kWh`}
          >
            {b.widthPct > 12 && (
              <span className="text-white font-semibold" style={{ fontSize: '9px' }}>
                {b.price.toFixed(1)}p
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-between mt-1 text-slate-600" style={{ fontSize: '9px' }}>
        {TIME_LABELS.map(t => <span key={t}>{t}</span>)}
      </div>
    </>
  )
}

const BADGE: Record<string, { label: string; hex: string }> = {
  go:       { label: 'FIXED',    hex: '#22c55e' },
  cosy:     { label: 'FIXED',    hex: '#f59e0b' },
  flux:     { label: 'DYNAMIC',  hex: '#a855f7' },
  flexible: { label: 'VARIABLE', hex: '#64748b' },
}

function TariffCard({ tariff }: { tariff: TariffEntry }) {
  const { label, hex } = BADGE[tariff.id] ?? { label: 'FIXED', hex: '#64748b' }
  const bands = slotsToBands(tariff.slots)
  const rates = [...new Set(bands.map(b => b.price))].sort((a, b) => a - b)
  return (
    <div className="bg-slate-900/50 rounded-lg p-3 border border-slate-700/50">
      <div className="flex justify-between items-start mb-2">
        <p className="text-sm font-semibold text-slate-200">{tariff.name}</p>
        <span
          className="text-xs font-semibold px-1.5 py-0.5 rounded"
          style={{ color: hex, backgroundColor: hex + '20' }}
        >
          {label}
        </span>
      </div>
      <BandBar bands={bands} />
      <p className="text-xs text-slate-500 mt-2">
        {rates.map(r => `${r.toFixed(1)}p`).join(' · ')}
      </p>
    </div>
  )
}

export function TariffComparisonPanel() {
  const { data: tariffData } = useData<TariffComparisonData>('./data/tariff_comparison.json')
  const { data: prices } = usePrices()

  if (!tariffData && !prices) return null

  const agileBands: Band[] = prices ? slotsToBands(prices.slots) : []
  const displayTariffs = tariffData?.tariffs.filter(t => ['go', 'cosy', 'flux'].includes(t.id)) ?? []

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
      <div className="mb-4">
        <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">Tariff Comparison</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Rate structure by time of day · Region {tariffData?.region ?? '—'}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-900/50 rounded-lg p-3 border border-indigo-500/30">
          <div className="flex justify-between items-start mb-2">
            <div>
              <p className="text-sm font-semibold text-slate-200">Agile Octopus</p>
              <p className="text-xs text-slate-500">Your current tariff</p>
            </div>
            <span
              className="text-xs font-semibold px-1.5 py-0.5 rounded"
              style={{ color: '#818cf8', backgroundColor: '#6366f120' }}
            >
              LIVE
            </span>
          </div>
          {agileBands.length > 0 ? (
            <>
              <BandBar bands={agileBands} />
              <p className="text-xs text-slate-500 mt-2">
                {Math.min(...agileBands.map(b => b.price)).toFixed(1)}p –{' '}
                {Math.max(...agileBands.map(b => b.price)).toFixed(1)}p today
              </p>
            </>
          ) : (
            <p className="text-xs text-slate-600 mt-2">Loading…</p>
          )}
        </div>
        {displayTariffs.map(t => <TariffCard key={t.id} tariff={t} />)}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/tariffs/TariffComparisonPanel.tsx
git commit -m "feat: add TariffComparisonPanel with rate-band cards"
```

---

## Task 4: Dashboard integration

**Files:**
- Modify: `src/app/Dashboard.tsx`

- [ ] **Step 1: Add import and insert panel**

In `src/app/Dashboard.tsx`:

Add to the import block:
```tsx
import { TariffComparisonPanel } from '../components/tariffs/TariffComparisonPanel'
```

Insert a new `<SectionGrid cols={1}>` block between `<ConsumptionOverlay />` and `<DailyCostBarChart />`. The file currently reads (lines 22–28):

```tsx
        <SectionGrid cols={2}>
          <AgileLineChart />
          <ConsumptionOverlay />
        </SectionGrid>

        <SectionGrid cols={2}>
          <DailyCostBarChart />
```

Change to:

```tsx
        <SectionGrid cols={2}>
          <AgileLineChart />
          <ConsumptionOverlay />
        </SectionGrid>

        <SectionGrid cols={1}>
          <TariffComparisonPanel />
        </SectionGrid>

        <SectionGrid cols={2}>
          <DailyCostBarChart />
```

- [ ] **Step 2: Start dev server and verify the panel renders**

```bash
npm run dev
```

Open `http://localhost:5173`. Expected: a "Tariff Comparison" section appears between the consumption overlay and the daily cost chart. If `tariff_comparison.json` hasn't been fetched yet, the panel will either be hidden (returns `null`) or show the Agile card only — both are correct.

To test with data, copy a sample `tariff_comparison.json` to `public/data/`:

```bash
python3 -c "
import json
data = {
  'fetched_at': '2026-05-05T12:00:00Z',
  'region': 'C',
  'tariffs': [
    {
      'id': 'go', 'name': 'Octopus Go', 'product_slug': 'GO-FIX-12M-26-04-18',
      'slots': [
        {'valid_from': '2026-05-04T23:30:00Z', 'valid_to': '2026-05-05T04:30:00Z', 'value_exc_vat': 9.047619, 'value_inc_vat': 9.5},
        {'valid_from': '2026-05-05T04:30:00Z', 'valid_to': '2026-05-05T23:30:00Z', 'value_exc_vat': 30.133, 'value_inc_vat': 31.64},
      ]
    },
    {
      'id': 'cosy', 'name': 'Cosy Octopus', 'product_slug': 'COSY-FIX-12M-26-03-23',
      'slots': [
        {'valid_from': '2026-05-05T02:00:00Z', 'valid_to': '2026-05-05T05:00:00Z', 'value_exc_vat': 13.26, 'value_inc_vat': 13.92},
        {'valid_from': '2026-05-05T05:00:00Z', 'valid_to': '2026-05-05T11:00:00Z', 'value_exc_vat': 30.51, 'value_inc_vat': 32.04},
        {'valid_from': '2026-05-05T11:00:00Z', 'valid_to': '2026-05-05T14:00:00Z', 'value_exc_vat': 13.26, 'value_inc_vat': 13.92},
        {'valid_from': '2026-05-05T14:00:00Z', 'valid_to': '2026-05-05T17:00:00Z', 'value_exc_vat': 47.44, 'value_inc_vat': 49.81},
        {'valid_from': '2026-05-05T17:00:00Z', 'valid_to': '2026-05-05T20:00:00Z', 'value_exc_vat': 30.51, 'value_inc_vat': 32.04},
        {'valid_from': '2026-05-05T20:00:00Z', 'valid_to': '2026-05-05T22:00:00Z', 'value_exc_vat': 13.26, 'value_inc_vat': 13.92},
      ]
    },
    {
      'id': 'flux', 'name': 'Intelligent Flux', 'product_slug': 'INTELLI-FLUX-IMPORT-23-07-14',
      'slots': [
        {'valid_from': '2026-05-05T00:00:00Z', 'valid_to': '2026-05-05T14:00:00Z', 'value_exc_vat': 20.07, 'value_inc_vat': 21.08},
        {'valid_from': '2026-05-05T14:00:00Z', 'valid_to': '2026-05-05T17:00:00Z', 'value_exc_vat': 26.76, 'value_inc_vat': 28.10},
        {'valid_from': '2026-05-05T17:00:00Z', 'valid_to': '2026-05-06T00:00:00Z', 'value_exc_vat': 20.07, 'value_inc_vat': 21.08},
      ]
    },
  ]
}
import os; os.makedirs('public/data', exist_ok=True)
with open('public/data/tariff_comparison.json', 'w') as f: json.dump(data, f, indent=2)
print('written')
"
```

Reload the browser. Expected: all 4 cards appear — Agile sparkline + Go (green/blue bands), Cosy (green/amber/red bands), Flux (blue/red/blue bands).

- [ ] **Step 3: Commit**

```bash
git add src/app/Dashboard.tsx
git commit -m "feat: insert TariffComparisonPanel into dashboard"
```

---

## Task 5: Battery Optimiser — Flux columns

**Files:**
- Modify: `src/components/battery/BatteryOptimiser.tsx`

- [ ] **Step 1: Add import and data hook**

In the import at line 4, add `TariffComparisonData` to the type import:

```tsx
import type { HeatmapData, BatteryCatalog, BatteryProduct, TariffComparisonData } from '../../types/data'
```

After the existing three `useData`/`usePrices` calls (around line 43), add:

```tsx
  const { data: tariffComparison } = useData<TariffComparisonData>('./data/tariff_comparison.json')
```

- [ ] **Step 2: Compute `fluxSlots` and add to `allSavings`**

After `const batteries` and `const selected` are defined (around line 59), add:

```tsx
  const fluxSlots = tariffComparison?.tariffs.find(t => t.id === 'flux')?.slots ?? []
```

Then replace the existing `allSavings` definition (around line 63):

```tsx
  // Before:
  const allSavings = batteries.map(b => ({
    battery: b,
    savings: calcBatterySavings(targetSlots, b.kwh, heatmap?.cells, b.charge_rate_kw, b.efficiency),
  }))

  // After:
  const allSavings = batteries.map(b => ({
    battery: b,
    savings: calcBatterySavings(targetSlots, b.kwh, heatmap?.cells, b.charge_rate_kw, b.efficiency),
    fluxSavings: fluxSlots.length > 0
      ? calcBatterySavings(fluxSlots, b.kwh, heatmap?.cells, b.charge_rate_kw, b.efficiency)
      : null,
  }))
```

- [ ] **Step 3: Add columns to the comparison table**

In the `<thead>` row (around line 246), add two `<th>` cells after the `Payback` header and before `Type`:

```tsx
                  <th className="text-right pb-2 font-medium">Flux/mo</th>
                  <th className="text-right pb-2 font-medium">Payback (F)</th>
```

In the `<tbody>` map (around line 257), update the destructuring and add two `<td>` cells. Replace:

```tsx
              {allSavings.map(({ battery: b, savings: s }) => {
                const total = b.price_gbp + b.install_gbp
                const monthlyGbp = s.monthlyPence / 100
                const paybackMonths = monthlyGbp > 0 ? Math.round(total / monthlyGbp) : null
                const paybackYears = paybackMonths ? (paybackMonths / 12).toFixed(1) : '—'
                const isSelected = b.id === selectedId
```

With:

```tsx
              {allSavings.map(({ battery: b, savings: s, fluxSavings: fs }) => {
                const total = b.price_gbp + b.install_gbp
                const monthlyGbp = s.monthlyPence / 100
                const paybackMonths = monthlyGbp > 0 ? Math.round(total / monthlyGbp) : null
                const paybackYears = paybackMonths ? (paybackMonths / 12).toFixed(1) : '—'
                const fluxMonthlyGbp = fs ? fs.monthlyPence / 100 : null
                const fluxPaybackYears = fluxMonthlyGbp && fluxMonthlyGbp > 0
                  ? (total / fluxMonthlyGbp / 12).toFixed(1)
                  : null
                const isSelected = b.id === selectedId
```

Then add two `<td>` cells after the existing `Payback` `<td>` (which renders `paybackYears`) and before the `Type` `<td>`:

```tsx
                      <td className="text-right py-2 text-purple-400">
                        {fs ? penceToPounds(fs.monthlyPence) : '—'}
                      </td>
                      <td className="text-right py-2 text-slate-500">
                        {fluxPaybackYears ? `${fluxPaybackYears} yrs` : '—'}
                      </td>
```

- [ ] **Step 4: TypeScript compile + visual check**

```bash
npx tsc --noEmit
```

Expected: no errors.

Reload the dashboard. Expected: the battery comparison table now has two extra columns — "Flux/mo" in purple and "Payback (F)" in slate. If `tariff_comparison.json` is present with Flux slots, the values should be populated (small savings, long payback vs Agile).

- [ ] **Step 5: Commit**

```bash
git add src/components/battery/BatteryOptimiser.tsx
git commit -m "feat: add Flux savings columns to battery comparison table"
```

---

## Task 6: Skill and slash command

**Files:**
- Modify: `.gitignore`
- Create: `.claude/skills/octopus-tariff-lister.md`
- Create: `.claude/commands/octopus-tariffs.md`

- [ ] **Step 1: Add `.superpowers/` to `.gitignore`**

Append to `.gitignore`:

```
# Visual brainstorm sessions
.superpowers/
```

- [ ] **Step 2: Create the skill file**

Create `.claude/skills/octopus-tariff-lister.md`:

```markdown
---
name: octopus-tariff-lister
description: Lists all current Octopus Energy residential tariffs with live unit rates for the account region, estimated monthly cost based on 30-day consumption history, and a comparison to current Agile spend. Use this to evaluate whether switching tariffs would save money.
---

# Octopus Tariff Lister

Execute these steps in order to produce a live tariff comparison for this account.

## Step 1 — Read account region

Read `public/data/meta.json`. Extract the `region` letter (e.g. `"C"`).

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

Note every product code.

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

Read `public/data/heatmap.json`. Build an hourly consumption map: for each cell, the `avg_kwh` value tells you how much is typically consumed in that hour.

## Step 5 — Estimate monthly cost on each tariff

For each tariff, estimate monthly cost by applying the rate windows to consumption:

**Flat rate tariff (e.g. Flexible Octopus):**
```
monthly = avg_daily_kwh × unit_rate_pence × 30 / 100
```

**2-rate tariff (e.g. Octopus Go: cheap 00:30–05:30, standard otherwise):**
```
cheap_kwh   = sum of avg_kwh from heatmap for hours 1–5 (London time)
standard_kwh = avg_daily_kwh − cheap_kwh
monthly = (cheap_kwh × cheap_rate + standard_kwh × standard_rate) × 30 / 100
```

**3-rate tariff (e.g. Cosy: cheap 04–07 + 13–16 + 22–00, peak 16–19, standard rest):**
Apply the same heatmap lookup for each rate window's hours, using the actual `value_inc_vat` rates from Step 3.

**Flux (standard 00–15 + 18–24 @~21p, peak 15–18 @~28p):**
```
peak_kwh     = sum of avg_kwh for hours 15, 16, 17
standard_kwh = avg_daily_kwh − peak_kwh
monthly = (peak_kwh × 28.1 + standard_kwh × 21.1) × 30 / 100
```
(Use actual fetched rates, not the hardcoded examples above.)

## Step 6 — Present the comparison

Output a markdown table sorted by estimated monthly cost ascending:

| Tariff | Rate structure | Est. monthly | vs Agile | Eligible? |
|---|---|---|---|---|
| Agile (current) | Dynamic 30-min | £X.XX | — | ✓ on it |
| ... | ... | ... | ... | ... |

Use actual fetched rates in the "Rate structure" column (not hardcoded values).

In the "vs Agile" column: negative = cheaper than Agile, positive = more expensive.

Eligibility notes:
- Octopus Go / Intelligent Go: "Needs EV"
- Cosy Octopus: "Needs heat pump"
- Intelligent Flux: "Needs solar + battery"
- All others: "✓"

Follow the table with a 2–3 sentence plain-English summary noting the best alternative and whether switching makes financial sense given the consumption pattern.
```

- [ ] **Step 3: Create the slash command file**

Create `.claude/commands/octopus-tariffs.md`:

```markdown
---
description: Fetch all current Octopus Energy tariffs, show live rates for your region, and estimate monthly cost vs your current Agile spend. Pass --region X to check a specific region.
---

Use the `octopus-tariff-lister` skill to fetch and compare all current Octopus Energy residential tariffs for this account.

$ARGUMENTS
```

- [ ] **Step 4: Verify the slash command is discoverable**

Restart Claude Code in this project directory. Type `/octopus-tariffs` — the command should appear in autocomplete and execute the skill when run.

- [ ] **Step 5: Commit everything**

```bash
git add .gitignore .claude/skills/octopus-tariff-lister.md .claude/commands/octopus-tariffs.md
git commit -m "feat: add octopus-tariff-lister skill and /octopus-tariffs command"
```

---

## Task 7: Push and verify CI

- [ ] **Step 1: Push to remote**

```bash
git push origin main
```

- [ ] **Step 2: Check CI passes**

```bash
gh run watch
```

Expected: the `fetch-and-deploy` workflow fetches data (including `tariff_comparison.json`), builds, and deploys successfully.

- [ ] **Step 3: Verify live dashboard**

Open the deployed URL. Confirm:
1. Tariff Comparison panel appears with 4 cards (Agile + Go + Cosy + Flux)
2. Rate bands are coloured correctly (green = cheap, amber = mid, red = peak)
3. Battery comparison table has two new columns: Flux/mo and Payback (F)
4. `/octopus-tariffs` command runs without error
