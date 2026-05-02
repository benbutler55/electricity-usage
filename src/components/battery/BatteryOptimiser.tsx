import { useState } from 'react'
import { usePrices } from '../../hooks/usePrices'
import { useData } from '../../hooks/useData'
import type { HeatmapData, BatteryCatalog, BatteryProduct } from '../../types/data'
import { LoadingSpinner } from '../shared/LoadingSpinner'
import { ErrorBanner } from '../shared/ErrorBanner'
import { formatTime, penceToPounds } from '../../lib/formatters'
import { tierColour } from '../../lib/priceColour'
import { scheduleSlots, calcBatterySavings, ROUND_TRIP_EFFICIENCY } from '../../lib/agileZones'

const ACTION_COLOUR: Record<string, string> = {
  charge: '#22c55e',
  discharge: '#ef4444',
  normal: '#334155',
}
const ACTION_LABEL: Record<string, string> = {
  charge: 'Charge from grid',
  discharge: 'Run from battery',
  normal: 'Grid as normal',
}

function groupConsecutive(scheduled: ReturnType<typeof scheduleSlots>, action: string) {
  const filtered = scheduled.filter(s => s.action === action)
  if (filtered.length === 0) return []
  const groups: { from: string; to: string; avgPrice: number }[] = []
  let current = { from: filtered[0].slot.valid_from, to: filtered[0].slot.valid_to, prices: [filtered[0].slot.value_inc_vat] }
  for (let i = 1; i < filtered.length; i++) {
    if (filtered[i - 1].slot.valid_to === filtered[i].slot.valid_from) {
      current.to = filtered[i].slot.valid_to
      current.prices.push(filtered[i].slot.value_inc_vat)
    } else {
      groups.push({ from: current.from, to: current.to, avgPrice: current.prices.reduce((a, b) => a + b, 0) / current.prices.length })
      current = { from: filtered[i].slot.valid_from, to: filtered[i].slot.valid_to, prices: [filtered[i].slot.value_inc_vat] }
    }
  }
  groups.push({ from: current.from, to: current.to, avgPrice: current.prices.reduce((a, b) => a + b, 0) / current.prices.length })
  return groups
}

export function BatteryOptimiser() {
  const { data: prices, loading, error } = usePrices()
  const { data: heatmap } = useData<HeatmapData>('./data/heatmap.json')
  const { data: catalog } = useData<BatteryCatalog>('./data/batteries.json')
  const [selectedId, setSelectedId] = useState('ecoflow-powerocean-5')

  if (loading) return <LoadingSpinner />
  if (error || !prices) return <ErrorBanner />

  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 0, 0, 0)

  const tomorrowSlots = prices.slots.filter(s => new Date(s.valid_from) >= tomorrow)
  const todayRemaining = prices.slots.filter(s => new Date(s.valid_from) >= now)
  const targetSlots = tomorrowSlots.length >= 24 ? tomorrowSlots : todayRemaining
  const usingTomorrow = tomorrowSlots.length >= 24

  const batteries: BatteryProduct[] = catalog?.batteries ?? []
  const selected = batteries.find(b => b.id === selectedId) ?? batteries[0]

  // Compute savings for all batteries (for comparison table)
  const allSavings = batteries.map(b => ({
    battery: b,
    savings: calcBatterySavings(targetSlots, b.kwh, heatmap?.cells, b.charge_rate_kw, b.efficiency),
  }))

  const selectedSavings = allSavings.find(s => s.battery.id === selectedId)?.savings
    ?? calcBatterySavings(targetSlots, selected?.kwh ?? 5, heatmap?.cells)

  const scheduled = selected
    ? scheduleSlots(targetSlots, selected.kwh, selected.charge_rate_kw)
    : []

  const chargeGroups = groupConsecutive(scheduled, 'charge')
  const dischargeGroups = groupConsecutive(scheduled, 'discharge')

  const minP = targetSlots.length ? Math.min(...targetSlots.map(s => s.value_inc_vat)) : 0
  const maxP = targetSlots.length ? Math.max(...targetSlots.map(s => s.value_inc_vat)) : 1
  const priceRange = maxP - minP || 1

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
      {/* Header */}
      <div className="flex items-start justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">Battery Optimiser</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {usingTomorrow ? "Tomorrow's schedule" : "Today's remaining prices"}
            {' · '}{targetSlots.length} slots · {catalog ? `prices verified ${catalog.prices_verified}` : ''}
          </p>
        </div>
      </div>

      {/* Product selector */}
      {batteries.length > 0 && (
        <div className="flex gap-2 flex-wrap mb-5">
          {batteries.map(b => (
            <button
              key={b.id}
              onClick={() => setSelectedId(b.id)}
              className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors text-left ${
                selectedId === b.id
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              <div>{b.name}</div>
              <div className={`font-normal ${selectedId === b.id ? 'text-indigo-200' : 'text-slate-400'}`}>
                {b.kwh} kWh · {b.plug_in ? '13A plug' : 'installed'}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Selected battery detail */}
      {selected && (
        <div className="mb-5 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50 flex flex-wrap gap-4 items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-200">{selected.name}</p>
            <p className="text-xs text-slate-400 mt-0.5">{selected.notes}</p>
            <a href={selected.url} target="_blank" rel="noopener noreferrer"
              className="text-xs text-indigo-400 hover:text-indigo-300 mt-1 inline-block">
              View product →
            </a>
          </div>
          <div className="flex gap-6 text-right flex-wrap">
            <div>
              <p className="text-xs text-slate-500">Battery</p>
              <p className="text-base font-bold text-slate-200">{penceToPounds(selected.price_gbp * 100)}</p>
            </div>
            {selected.install_gbp > 0 && (
              <div>
                <p className="text-xs text-slate-500">+ Installation</p>
                <p className="text-base font-bold text-slate-400">~{penceToPounds(selected.install_gbp * 100)}</p>
              </div>
            )}
            <div>
              <p className="text-xs text-slate-500">Total</p>
              <p className="text-base font-bold text-slate-100">{penceToPounds((selected.price_gbp + selected.install_gbp) * 100)}</p>
            </div>
          </div>
        </div>
      )}

      {/* Savings stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="bg-slate-900/50 rounded-lg p-3">
          <p className="text-xs text-slate-500 mb-1">Avg charge price</p>
          <p className="text-lg font-bold text-green-400">{selectedSavings.avgChargePence.toFixed(1)}p</p>
          <p className="text-xs text-slate-500">{selectedSavings.chargeSlotCount} slots</p>
        </div>
        <div className="bg-slate-900/50 rounded-lg p-3">
          <p className="text-xs text-slate-500 mb-1">Avg avoided rate</p>
          <p className="text-lg font-bold text-red-400">{selectedSavings.avgDischargePence.toFixed(1)}p</p>
          <p className="text-xs text-slate-500">during discharge</p>
        </div>
        <div className="bg-slate-900/50 rounded-lg p-3">
          <p className="text-xs text-slate-500 mb-1">Est. daily saving</p>
          <p className="text-lg font-bold text-indigo-400">{penceToPounds(selectedSavings.dailyPence)}</p>
          {selectedSavings.isConsumptionLimited && (
            <p className="text-xs text-amber-500">{selectedSavings.effectiveKwh.toFixed(1)} kWh shifted</p>
          )}
        </div>
        <div className="bg-slate-900/50 rounded-lg p-3">
          <p className="text-xs text-slate-500 mb-1">Est. monthly saving</p>
          <p className="text-lg font-bold text-indigo-300">{penceToPounds(selectedSavings.monthlyPence)}</p>
          {selected && selectedSavings.monthlyPence > 0 && (
            <p className="text-xs text-slate-500">
              payback {Math.round((selected.price_gbp + selected.install_gbp) / (selectedSavings.monthlyPence / 100))} mo
            </p>
          )}
        </div>
      </div>

      {selectedSavings.isConsumptionLimited && (
        <div className="mb-4 px-3 py-2 bg-amber-900/20 border border-amber-800/40 rounded-lg text-xs text-amber-400">
          Based on your typical peak-hour consumption, this battery would shift ~{selectedSavings.effectiveKwh.toFixed(1)} kWh/day — less than its {selected?.kwh} kWh capacity.
          Theoretical max: {penceToPounds(selectedSavings.theoreticalDailyPence)}/day if fully utilised.
        </div>
      )}

      {/* Price timeline */}
      <div className="mb-4">
        <p className="text-xs text-slate-500 mb-2">Price timeline</p>
        <div className="flex gap-0.5 h-16 items-end">
          {scheduled.map(({ slot, action }, i) => {
            const heightPct = 20 + ((slot.value_inc_vat - minP) / priceRange) * 80
            const colour = action !== 'normal' ? ACTION_COLOUR[action] : tierColour(slot.value_inc_vat)
            return (
              <div key={i} className="flex-1 rounded-sm cursor-default"
                style={{ height: `${heightPct}%`, backgroundColor: colour, opacity: action === 'normal' ? 0.4 : 0.9 }}
                title={`${formatTime(slot.valid_from)} · ${slot.value_inc_vat.toFixed(1)}p · ${ACTION_LABEL[action]}`}
              />
            )
          })}
        </div>
        <div className="flex justify-between mt-1 text-xs text-slate-600">
          {[0, 6, 12, 18, 23].map(i => (
            <span key={i}>{scheduled[Math.min(i * 2, scheduled.length - 1)]
              ? formatTime(scheduled[Math.min(i * 2, scheduled.length - 1)].slot.valid_from) : ''}</span>
          ))}
        </div>
      </div>

      <div className="flex gap-4 mb-5 text-xs text-slate-400">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-green-500" /> Charge window</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-red-500" /> Discharge window</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-slate-600" /> Grid as normal</span>
      </div>

      {/* Charge/discharge times */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div>
          <p className="text-xs font-medium text-green-400 uppercase tracking-wide mb-2">Charge windows</p>
          {chargeGroups.length === 0
            ? <p className="text-xs text-slate-500">No data</p>
            : chargeGroups.map((g, i) => (
              <div key={i} className="flex justify-between items-center py-1.5 border-b border-slate-700/50">
                <span className="text-sm text-slate-300">{formatTime(g.from)} – {formatTime(g.to)}</span>
                <span className="text-sm font-semibold text-green-400">{g.avgPrice.toFixed(1)}p/kWh</span>
              </div>
            ))}
        </div>
        <div>
          <p className="text-xs font-medium text-red-400 uppercase tracking-wide mb-2">Avoid grid (discharge)</p>
          {dischargeGroups.length === 0
            ? <p className="text-xs text-slate-500">No data</p>
            : dischargeGroups.map((g, i) => (
              <div key={i} className="flex justify-between items-center py-1.5 border-b border-slate-700/50">
                <span className="text-sm text-slate-300">{formatTime(g.from)} – {formatTime(g.to)}</span>
                <span className="text-sm font-semibold text-red-400">{g.avgPrice.toFixed(1)}p/kWh</span>
              </div>
            ))}
        </div>
      </div>

      {/* Comparison table */}
      {batteries.length > 0 && (
        <div>
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">All battery options compared</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-slate-700">
                  <th className="text-left pb-2 font-medium">Model</th>
                  <th className="text-right pb-2 font-medium">kWh</th>
                  <th className="text-right pb-2 font-medium">Price</th>
                  <th className="text-right pb-2 font-medium">+Install</th>
                  <th className="text-right pb-2 font-medium">Monthly saving</th>
                  <th className="text-right pb-2 font-medium">Payback</th>
                  <th className="text-right pb-2 font-medium">Type</th>
                </tr>
              </thead>
              <tbody>
                {allSavings.map(({ battery: b, savings: s }) => {
                  const total = b.price_gbp + b.install_gbp
                  const monthlyGbp = s.monthlyPence / 100
                  const paybackMonths = monthlyGbp > 0 ? Math.round(total / monthlyGbp) : null
                  const paybackYears = paybackMonths ? (paybackMonths / 12).toFixed(1) : '—'
                  const isSelected = b.id === selectedId
                  return (
                    <tr
                      key={b.id}
                      onClick={() => setSelectedId(b.id)}
                      className={`border-b border-slate-700/50 cursor-pointer transition-colors ${
                        isSelected ? 'text-slate-100' : 'text-slate-400 hover:text-slate-300'
                      }`}
                    >
                      <td className="py-2 pr-4">
                        <span className={`font-medium ${isSelected ? 'text-indigo-400' : ''}`}>{b.name}</span>
                        {s.isConsumptionLimited && <span className="ml-1 text-amber-500">†</span>}
                      </td>
                      <td className="text-right py-2">{b.kwh}</td>
                      <td className="text-right py-2">{penceToPounds(b.price_gbp * 100)}</td>
                      <td className="text-right py-2">{b.install_gbp ? `~${penceToPounds(b.install_gbp * 100)}` : '—'}</td>
                      <td className="text-right py-2 text-indigo-400 font-semibold">{penceToPounds(s.monthlyPence)}</td>
                      <td className="text-right py-2">{paybackYears} yrs</td>
                      <td className="text-right py-2">{b.plug_in ? '🔌 plug-in' : '🔧 installed'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="text-xs text-slate-600 mt-2">
              † saving capped at your typical peak-hour consumption (less than battery capacity) · click row to select
            </p>
          </div>
        </div>
      )}

      <p className="text-xs text-slate-600 mt-4">
        Saving = shifted kWh × (avoided peak rate − charge rate ÷ {ROUND_TRIP_EFFICIENCY * 100}% efficiency) · one cycle/day × 30 days.
        Prices verified {catalog?.prices_verified ?? 'at build time'} — update <code>BATTERY_CATALOG</code> in <code>scripts/fetch_data.py</code> when they change.
      </p>
    </div>
  )
}
