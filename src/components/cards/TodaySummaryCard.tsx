import { usePrices } from '../../hooks/usePrices'
import { useConsumption } from '../../hooks/useConsumption'
import { useDaily } from '../../hooks/useDaily'
import { StatTile } from '../shared/StatTile'
import { LoadingSpinner } from '../shared/LoadingSpinner'
import { penceToPounds, formatPrice, formatKwh, localDateString, formatTime } from '../../lib/formatters'
import { tierTextClass } from '../../lib/priceColour'

export function TodaySummaryCard() {
  const { data: prices, loading: pl } = usePrices()
  const { data: consumption, loading: cl } = useConsumption()
  const { data: daily, loading: dl } = useDaily()

  if (pl || cl || dl) return <LoadingSpinner />

  const now = new Date()
  const todayStr = localDateString(now.toISOString())

  const todayConsumption = consumption?.slots.filter(
    s => localDateString(s.interval_start) === todayStr
  ) ?? []

  const allPrices = prices?.slots ?? []
  const priceMap = new Map(allPrices.map(s => [new Date(s.valid_from).toISOString(), s.value_inc_vat]))

  const completedSlots = todayConsumption.filter(s => new Date(s.interval_end) <= now)
  const costSoFar = completedSlots.reduce((acc, s) => {
    return acc + s.consumption * (priceMap.get(new Date(s.interval_start).toISOString()) ?? 0)
  }, 0)
  const kwhToday = todayConsumption.reduce((acc, s) => acc + s.consumption, 0)

  // Most recent complete day from daily.json (used as fallback when today has no data yet)
  const completeDays = daily?.days.filter(d => d.complete) ?? []
  const latestDay = completeDays[completeDays.length - 1] ?? null
  const hasTodayData = todayConsumption.length > 0

  // Cheapest upcoming slot
  const upcoming = allPrices.filter(s => new Date(s.valid_from) > now)
  const cheapest = upcoming.length > 0
    ? upcoming.reduce((a, b) => a.value_inc_vat < b.value_inc_vat ? a : b)
    : null

  const heading = hasTodayData ? 'Today' : latestDay ? `Latest · ${latestDay.date}` : 'Today'

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">{heading}</h2>
        {!hasTodayData && (
          <span className="text-xs text-slate-500">Today's data arrives ~24h later</span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-4">
        <StatTile
          label={hasTodayData ? 'Cost so far' : 'Total cost'}
          value={hasTodayData
            ? (completedSlots.length ? penceToPounds(costSoFar) : '—')
            : (latestDay ? penceToPounds(latestDay.cost_pence) : '—')}
          sub={hasTodayData && completedSlots.length ? `${completedSlots.length} slots` : undefined}
        />
        <StatTile
          label="Consumed"
          value={hasTodayData
            ? (todayConsumption.length ? formatKwh(kwhToday) : '—')
            : (latestDay ? formatKwh(latestDay.kwh) : '—')}
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
