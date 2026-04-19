import { useData } from '../../hooks/useData'
import type { MonthlyData } from '../../types/data'
import { StatTile } from '../shared/StatTile'
import { LoadingSpinner } from '../shared/LoadingSpinner'
import { ErrorBanner } from '../shared/ErrorBanner'
import { penceToPounds, formatKwh, formatMonthLabel } from '../../lib/formatters'

export function MonthlySummaryCard() {
  const { data, loading, error } = useData<MonthlyData>('./data/monthly.json')

  if (loading) return <LoadingSpinner />
  if (error || !data) return <ErrorBanner />

  const { current, previous } = data
  const delta = current.cost_pence - previous.cost_pence
  const deltaSign = delta >= 0 ? '+' : ''
  const deltaClass = delta > 0 ? 'text-red-400' : 'text-green-400'

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
      <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide mb-1">
        {formatMonthLabel(current.month)}
      </h2>
      <p className="text-xs text-slate-500 mb-4">
        {current.days_complete} of {current.days_in_month} days complete
      </p>

      <div className="grid grid-cols-3 gap-4 mb-4">
        <StatTile
          label="Spent so far"
          value={penceToPounds(current.cost_pence)}
        />
        <StatTile
          label="Projected total"
          value={penceToPounds(current.projected_cost_pence)}
          sub="based on daily avg"
        />
        <StatTile
          label="Total usage"
          value={formatKwh(current.kwh)}
        />
      </div>

      <div className="border-t border-slate-700 pt-3 flex items-center gap-3">
        <span className="text-xs text-slate-500">vs {formatMonthLabel(previous.month)}:</span>
        <span className={`text-sm font-semibold ${deltaClass}`}>
          {deltaSign}{penceToPounds(Math.abs(delta))}
        </span>
        <span className="text-xs text-slate-500">
          (avg {penceToPounds(previous.avg_daily_cost_pence)}/day)
        </span>
      </div>
    </div>
  )
}
