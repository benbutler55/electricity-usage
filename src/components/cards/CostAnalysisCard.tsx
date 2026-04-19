import { useData } from '../../hooks/useData'
import type { HeatmapData } from '../../types/data'
import { StatTile } from '../shared/StatTile'
import { LoadingSpinner } from '../shared/LoadingSpinner'
import { ErrorBanner } from '../shared/ErrorBanner'
import { penceToPounds, formatPrice } from '../../lib/formatters'
import { tierTextClass } from '../../lib/priceColour'
import { usePrices } from '../../hooks/usePrices'
import { estimatedShiftSaving } from '../../lib/agileZones'

const HOURS = ['12am','1am','2am','3am','4am','5am','6am','7am','8am','9am','10am','11am',
               '12pm','1pm','2pm','3pm','4pm','5pm','6pm','7pm','8pm','9pm','10pm','11pm']

export function CostAnalysisCard() {
  const { data: heatmap, loading, error } = useData<HeatmapData>('./data/heatmap.json')
  const { data: prices } = usePrices()

  if (loading) return <LoadingSpinner />
  if (error || !heatmap) return <ErrorBanner />

  // Aggregate by hour across all days
  const byHour: Record<number, { prices: number[]; kwhs: number[] }> = {}
  for (const cell of heatmap.cells) {
    if (!byHour[cell.hour]) byHour[cell.hour] = { prices: [], kwhs: [] }
    byHour[cell.hour].prices.push(cell.avg_price_inc_vat)
    byHour[cell.hour].kwhs.push(cell.avg_kwh)
  }

  const hourStats = Object.entries(byHour).map(([h, v]) => ({
    hour: Number(h),
    avgPrice: v.prices.reduce((a, b) => a + b, 0) / v.prices.length,
  }))

  const cheapestHour = hourStats.reduce((a, b) => a.avgPrice < b.avgPrice ? a : b)
  const peakHour = hourStats.reduce((a, b) => a.avgPrice > b.avgPrice ? a : b)

  // % of consumption in peak hours (16-19 local = 4pm-7pm)
  const peakHours = new Set([16, 17, 18])
  const peakKwh = heatmap.cells
    .filter(c => peakHours.has(c.hour))
    .reduce((a, c) => a + c.avg_kwh * c.sample_count, 0)
  const totalCellKwh = heatmap.cells.reduce((a, c) => a + c.avg_kwh * c.sample_count, 0)
  const peakPct = totalCellKwh > 0 ? (peakKwh / totalCellKwh) * 100 : 0

  // Estimated saving from shifting peak usage to cheapest available price
  const avgPeakPrice = heatmap.cells
    .filter(c => peakHours.has(c.hour))
    .map(c => c.avg_price_inc_vat)
    .reduce((a, b, _, arr) => a + b / arr.length, 0)
  const dailyPeakKwh = heatmap.cells.filter(c => peakHours.has(c.hour)).reduce((a, c) => a + c.avg_kwh, 0)
  const saving = prices
    ? estimatedShiftSaving(dailyPeakKwh, avgPeakPrice, prices.slots)
    : 0

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
      <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide mb-4">Cost Analysis</h2>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-slate-400 uppercase tracking-wide">Cheapest hour</span>
          <span className={`text-xl font-bold ${tierTextClass(cheapestHour.avgPrice)}`}>
            {HOURS[cheapestHour.hour]}
          </span>
          <span className="text-xs text-slate-500">avg {formatPrice(cheapestHour.avgPrice)}/kWh</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-slate-400 uppercase tracking-wide">Most expensive hour</span>
          <span className={`text-xl font-bold ${tierTextClass(peakHour.avgPrice)}`}>
            {HOURS[peakHour.hour]}
          </span>
          <span className="text-xs text-slate-500">avg {formatPrice(peakHour.avgPrice)}/kWh</span>
        </div>
        <StatTile
          label="Usage in peak (4–7pm)"
          value={`${peakPct.toFixed(0)}%`}
          sub="of daily kWh"
        />
        {saving > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-slate-400 uppercase tracking-wide">Potential daily saving</span>
            <span className="text-xl font-bold text-green-400">{penceToPounds(saving)}</span>
            <span className="text-xs text-slate-500">by shifting peak load</span>
          </div>
        )}
      </div>
      <p className="text-xs text-slate-500">Based on {heatmap.basis_days} days of data</p>
    </div>
  )
}
