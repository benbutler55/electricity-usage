import { usePrices } from '../../hooks/usePrices'
import { useConsumption } from '../../hooks/useConsumption'
import { StatTile } from '../shared/StatTile'
import { LoadingSpinner } from '../shared/LoadingSpinner'
import { penceToPounds, formatPrice, formatKwh, localDateString, formatTime } from '../../lib/formatters'
import { tierTextClass } from '../../lib/priceColour'

export function TodaySummaryCard() {
  const { data: prices, loading: pl } = usePrices()
  const { data: consumption, loading: cl } = useConsumption()

  if (pl || cl) return <LoadingSpinner />

  const now = new Date()
  const todayStr = localDateString(now.toISOString())

  // Consumption slots from today (local date)
  const todayConsumption = consumption?.slots.filter(
    s => localDateString(s.interval_start) === todayStr
  ) ?? []

  // Prices for today
  const todayPrices = prices?.slots.filter(
    s => localDateString(s.valid_from) === todayStr
  ) ?? []

  // Match consumption to price by interval_start == valid_from
  const priceMap = new Map(todayPrices.map(s => [new Date(s.valid_from).toISOString(), s.value_inc_vat]))

  // Cost so far — only slots that have ended
  const completedSlots = todayConsumption.filter(s => new Date(s.interval_end) <= now)
  const costSoFar = completedSlots.reduce((acc, s) => {
    const price = priceMap.get(new Date(s.interval_start).toISOString()) ?? 0
    return acc + s.consumption * price
  }, 0)
  const kwhToday = todayConsumption.reduce((acc, s) => acc + s.consumption, 0)

  // Cheapest upcoming slot
  const upcoming = prices?.slots.filter(s => new Date(s.valid_from) > now) ?? []
  const cheapest = upcoming.length > 0
    ? upcoming.reduce((a, b) => a.value_inc_vat < b.value_inc_vat ? a : b)
    : null

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
      <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide mb-4">Today</h2>
      <div className="grid grid-cols-3 gap-4">
        <StatTile
          label="Cost so far"
          value={completedSlots.length ? penceToPounds(costSoFar) : '—'}
          sub={completedSlots.length ? `${completedSlots.length} slots` : 'No data yet'}
        />
        <StatTile
          label="Consumed"
          value={todayConsumption.length ? formatKwh(kwhToday) : '—'}
        />
        {cheapest ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-slate-400 uppercase tracking-wide">Cheapest upcoming</span>
            <span className={`text-2xl font-bold tabular-nums ${tierTextClass(cheapest.value_inc_vat)}`}>
              {formatPrice(cheapest.value_inc_vat)}
            </span>
            <span className="text-xs text-slate-500">{formatTime(cheapest.valid_from)}</span>
          </div>
        ) : (
          <StatTile label="Cheapest upcoming" value="—" />
        )}
      </div>
    </div>
  )
}
