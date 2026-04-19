import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, ReferenceLine,
  ReferenceArea, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import type { ValueType, NameType } from 'recharts/types/component/DefaultTooltipContent'
import { usePrices } from '../../hooks/usePrices'
import { LoadingSpinner } from '../shared/LoadingSpinner'
import { ErrorBanner } from '../shared/ErrorBanner'
import { formatTime } from '../../lib/formatters'

interface ChartPoint {
  time: string
  ts: number
  price: number
}

export function AgileLineChart() {
  const { data, loading, error } = usePrices()

  if (loading) return <LoadingSpinner />
  if (error || !data) return <ErrorBanner />

  const now = new Date()
  const nowTs = now.getTime()

  const points: ChartPoint[] = data.slots.map(s => ({
    time: formatTime(s.valid_from),
    ts: new Date(s.valid_from).getTime(),
    price: s.value_inc_vat,
  }))

  const nowIndex = points.findIndex(p => p.ts > nowTs)

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">
          Agile Prices
        </h2>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> negative</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" /> cheap</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> mid</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> peak</span>
        </div>
      </div>

      {!data.tomorrow_available && (
        <p className="text-xs text-slate-500 mb-2">Tomorrow's prices not yet published (expected 4–8pm)</p>
      )}

      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />

          <ReferenceArea y1={-50} y2={0}   fill="#3b82f6" fillOpacity={0.08} />
          <ReferenceArea y1={0}   y2={16}  fill="#22c55e" fillOpacity={0.06} />
          <ReferenceArea y1={16}  y2={30}  fill="#f59e0b" fillOpacity={0.06} />
          <ReferenceArea y1={30}  y2={150} fill="#ef4444" fillOpacity={0.06} />

          <ReferenceLine y={0} stroke="#475569" strokeDasharray="2 2" />

          {nowIndex >= 0 && (
            <ReferenceLine
              x={points[nowIndex]?.time}
              stroke="#94a3b8"
              strokeDasharray="4 2"
              label={{ value: 'now', fill: '#94a3b8', fontSize: 10, position: 'insideTopRight' }}
            />
          )}

          <XAxis
            dataKey="time"
            tick={{ fill: '#94a3b8', fontSize: 10 }}
            tickLine={false}
            interval={7}
            axisLine={{ stroke: '#334155' }}
          />
          <YAxis
            tick={{ fill: '#94a3b8', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: ValueType | undefined) => `${v ?? ''}p`}
            width={36}
          />
          <Tooltip
            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
            labelStyle={{ color: '#94a3b8', fontSize: 12 }}
            formatter={(value: ValueType | undefined, _name: NameType | undefined) => {
              return [`${Number(value ?? 0).toFixed(2)}p/kWh`, 'Price'] as [string, string]
            }}
          />
          <Line
            type="stepAfter"
            dataKey="price"
            dot={false}
            stroke="#6366f1"
            strokeWidth={2}
            activeDot={{ r: 4, fill: '#6366f1' }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
