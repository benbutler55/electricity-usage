import { useData } from '../../hooks/useData'
import type { HeatmapData, HeatmapCell } from '../../types/data'
import { LoadingSpinner } from '../shared/LoadingSpinner'
import { ErrorBanner } from '../shared/ErrorBanner'
import { formatPrice } from '../../lib/formatters'
import { useState } from 'react'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => {
  if (i === 0) return '12am'
  if (i < 12) return `${i}am`
  if (i === 12) return '12pm'
  return `${i - 12}pm`
})

function interpolateColour(t: number): string {
  // 0 = green (#22c55e), 0.5 = amber (#f59e0b), 1 = red (#ef4444)
  const r = t < 0.5
    ? Math.round(34 + (245 - 34) * (t * 2))
    : Math.round(245 + (239 - 245) * ((t - 0.5) * 2))
  const g = t < 0.5
    ? Math.round(197 + (158 - 197) * (t * 2))
    : Math.round(158 + (68 - 158) * ((t - 0.5) * 2))
  const b = t < 0.5
    ? Math.round(94 + (11 - 94) * (t * 2))
    : Math.round(11 + (68 - 11) * ((t - 0.5) * 2))
  return `rgb(${r},${g},${b})`
}

export function HeatmapGrid() {
  const { data, loading, error } = useData<HeatmapData>('./data/heatmap.json')
  const [tooltip, setTooltip] = useState<{ cell: HeatmapCell; x: number; y: number } | null>(null)

  if (loading) return <LoadingSpinner />
  if (error || !data) return <ErrorBanner />

  // Build lookup: [hour][dow] → cell
  const cellMap: Record<number, Record<number, HeatmapCell>> = {}
  for (const cell of data.cells) {
    if (!cellMap[cell.hour]) cellMap[cell.hour] = {}
    cellMap[cell.hour][cell.day_of_week] = cell
  }

  if (data.cells.length === 0) return <ErrorBanner message="No heatmap data yet — prices will appear once consumption history is matched" />

  const allPrices = data.cells.map(c => c.avg_price_inc_vat)
  const minP = Math.min(...allPrices)
  const maxP = Math.max(...allPrices)
  const range = maxP - minP || 1

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">
          Price by Time of Day
        </h2>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="text-green-400">cheap</span>
          <div className="w-16 h-2 rounded" style={{
            background: 'linear-gradient(to right, #22c55e, #f59e0b, #ef4444)',
          }} />
          <span className="text-red-400">peak</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div style={{ minWidth: 340 }}>
          {/* Day headers */}
          <div className="flex mb-1 ml-10">
            {DAYS.map(d => (
              <div key={d} className="flex-1 text-center text-xs text-slate-400">{d}</div>
            ))}
          </div>

          {/* Grid rows */}
          {HOUR_LABELS.map((label, hour) => (
            <div key={hour} className="flex items-center mb-0.5">
              <div className="w-10 text-right pr-2 text-xs text-slate-500 shrink-0">{label}</div>
              {DAYS.map((_, dow) => {
                const cell = cellMap[hour]?.[dow]
                const t = cell ? (cell.avg_price_inc_vat - minP) / range : 0.5
                const colour = cell ? interpolateColour(t) : '#1e293b'
                return (
                  <div
                    key={dow}
                    className="flex-1 h-5 mx-0.5 rounded-sm cursor-pointer relative"
                    style={{ backgroundColor: colour, opacity: cell ? 1 : 0.2 }}
                    onMouseEnter={e => cell && setTooltip({ cell, x: e.clientX, y: e.clientY })}
                    onMouseMove={e => cell && setTooltip(t => t ? { ...t, x: e.clientX, y: e.clientY } : null)}
                    onMouseLeave={() => setTooltip(null)}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Floating tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs pointer-events-none"
          style={{ left: tooltip.x + 12, top: tooltip.y - 40 }}
        >
          <div className="text-slate-300 font-semibold">
            {DAYS[tooltip.cell.day_of_week]} {HOUR_LABELS[tooltip.cell.hour]}
          </div>
          <div className="text-slate-400">avg {formatPrice(tooltip.cell.avg_price_inc_vat)}/kWh</div>
          <div className="text-slate-500">{tooltip.cell.sample_count} samples</div>
        </div>
      )}

      <p className="text-xs text-slate-500 mt-2">
        Based on {data.basis_days} days — hover for details
      </p>
    </div>
  )
}
