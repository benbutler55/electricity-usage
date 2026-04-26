import { useState } from 'react'
import { usePrices } from '../../hooks/usePrices'
import { LoadingSpinner } from '../shared/LoadingSpinner'
import { ErrorBanner } from '../shared/ErrorBanner'
import { formatTime, penceToPounds } from '../../lib/formatters'
import { tierColour } from '../../lib/priceColour'
import { scheduleSlots, calcBatterySavings, ROUND_TRIP_EFFICIENCY } from '../../lib/agileZones'

const BATTERY_OPTIONS = [
  { label: '1.5 kWh', kwh: 1.5, note: 'MyGrid' },
  { label: '5 kWh',   kwh: 5,   note: 'EcoFlow' },
  { label: '7.5 kWh', kwh: 7.5, note: 'EcoFlow ×1.5' },
  { label: '10 kWh',  kwh: 10,  note: 'EcoFlow ×2' },
]

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

export function BatteryOptimiser() {
  const { data: prices, loading, error } = usePrices()
  const [selectedKwh, setSelectedKwh] = useState(5)

  if (loading) return <LoadingSpinner />
  if (error || !prices) return <ErrorBanner />

  const now = new Date()

  // Prefer tomorrow's slots if available, otherwise use remaining today's slots
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 0, 0, 0)

  const tomorrowSlots = prices.slots.filter(s => new Date(s.valid_from) >= tomorrow)
  const todayRemaining = prices.slots.filter(s => new Date(s.valid_from) >= now)
  const targetSlots = tomorrowSlots.length >= 24 ? tomorrowSlots : todayRemaining
  const usingTomorrow = tomorrowSlots.length >= 24

  const scheduled = scheduleSlots(targetSlots, selectedKwh)
  const savings = calcBatterySavings(targetSlots, selectedKwh)

  // Group consecutive charge/discharge slots into windows for display
  function groupConsecutive(slots: typeof scheduled, action: string) {
    const filtered = slots.filter(s => s.action === action)
    if (filtered.length === 0) return []
    const groups: { from: string; to: string; avgPrice: number }[] = []
    let current = { from: filtered[0].slot.valid_from, to: filtered[0].slot.valid_to, prices: [filtered[0].slot.value_inc_vat] }
    for (let i = 1; i < filtered.length; i++) {
      const prev = filtered[i - 1].slot.valid_to
      const curr = filtered[i].slot.valid_from
      if (prev === curr) {
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

  const chargeGroups = groupConsecutive(scheduled, 'charge')
  const dischargeGroups = groupConsecutive(scheduled, 'discharge')

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">
            Battery Optimiser
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {usingTomorrow ? "Tomorrow's schedule" : "Today's remaining prices"}
            {' · '}{targetSlots.length} slots · {ROUND_TRIP_EFFICIENCY * 100}% efficiency assumed
          </p>
        </div>
        {/* Battery size selector */}
        <div className="flex gap-2 flex-wrap">
          {BATTERY_OPTIONS.map(opt => (
            <button
              key={opt.kwh}
              onClick={() => setSelectedKwh(opt.kwh)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                selectedKwh === opt.kwh
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              {opt.label}
              <span className="ml-1 text-slate-400 font-normal">{opt.note}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Savings stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="bg-slate-900/50 rounded-lg p-3">
          <p className="text-xs text-slate-500 mb-1">Avg charge price</p>
          <p className="text-lg font-bold text-green-400">{savings.avgChargePence.toFixed(1)}p</p>
          <p className="text-xs text-slate-500">{savings.chargeSlotCount} slots</p>
        </div>
        <div className="bg-slate-900/50 rounded-lg p-3">
          <p className="text-xs text-slate-500 mb-1">Avg discharge saving</p>
          <p className="text-lg font-bold text-red-400">{savings.avgDischargePence.toFixed(1)}p</p>
          <p className="text-xs text-slate-500">avoided rate</p>
        </div>
        <div className="bg-slate-900/50 rounded-lg p-3">
          <p className="text-xs text-slate-500 mb-1">Est. daily saving</p>
          <p className="text-lg font-bold text-indigo-400">{penceToPounds(savings.dailyPence)}</p>
        </div>
        <div className="bg-slate-900/50 rounded-lg p-3">
          <p className="text-xs text-slate-500 mb-1">Est. monthly saving</p>
          <p className="text-lg font-bold text-indigo-300">{penceToPounds(savings.monthlyPence)}</p>
        </div>
      </div>

      {/* Price timeline with charge/discharge overlay */}
      <div className="mb-4">
        <p className="text-xs text-slate-500 mb-2">Price timeline</p>
        <div className="flex gap-0.5 h-16 items-end">
          {scheduled.map(({ slot, action }, i) => {
            const minP = Math.min(...targetSlots.map(s => s.value_inc_vat))
            const maxP = Math.max(...targetSlots.map(s => s.value_inc_vat))
            const range = maxP - minP || 1
            const heightPct = 20 + ((slot.value_inc_vat - minP) / range) * 80
            const baseColour = action !== 'normal' ? ACTION_COLOUR[action] : tierColour(slot.value_inc_vat)
            const opacity = action === 'normal' ? 0.4 : 0.9
            return (
              <div
                key={i}
                className="flex-1 rounded-sm relative group cursor-default"
                style={{ height: `${heightPct}%`, backgroundColor: baseColour, opacity }}
                title={`${formatTime(slot.valid_from)} · ${slot.value_inc_vat.toFixed(1)}p · ${ACTION_LABEL[action]}`}
              />
            )
          })}
        </div>
        {/* X-axis time labels */}
        <div className="flex justify-between mt-1 text-xs text-slate-600">
          {[0, 6, 12, 18, 23].map(i => (
            <span key={i}>{scheduled[i * 2] ? formatTime(scheduled[Math.min(i * 2, scheduled.length - 1)].slot.valid_from) : ''}</span>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-4 mb-5 text-xs text-slate-400">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-green-500" /> Charge window</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-red-500" /> Discharge window</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-slate-600" /> Grid as normal</span>
      </div>

      {/* Charge / discharge window lists */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <p className="text-xs font-medium text-green-400 uppercase tracking-wide mb-2">Charge windows</p>
          {chargeGroups.length === 0 ? (
            <p className="text-xs text-slate-500">No data</p>
          ) : chargeGroups.map((g, i) => (
            <div key={i} className="flex justify-between items-center py-1.5 border-b border-slate-700/50">
              <span className="text-sm text-slate-300">{formatTime(g.from)} – {formatTime(g.to)}</span>
              <span className="text-sm font-semibold text-green-400">{g.avgPrice.toFixed(1)}p/kWh</span>
            </div>
          ))}
        </div>
        <div>
          <p className="text-xs font-medium text-red-400 uppercase tracking-wide mb-2">Avoid grid (discharge)</p>
          {dischargeGroups.length === 0 ? (
            <p className="text-xs text-slate-500">No data</p>
          ) : dischargeGroups.map((g, i) => (
            <div key={i} className="flex justify-between items-center py-1.5 border-b border-slate-700/50">
              <span className="text-sm text-slate-300">{formatTime(g.from)} – {formatTime(g.to)}</span>
              <span className="text-sm font-semibold text-red-400">{g.avgPrice.toFixed(1)}p/kWh</span>
            </div>
          ))}
        </div>
      </div>

      <p className="text-xs text-slate-600 mt-4">
        Savings estimated assuming one full charge/discharge cycle daily × 30 days.
        Actual savings vary with consumption patterns and available price slots.
      </p>
    </div>
  )
}
