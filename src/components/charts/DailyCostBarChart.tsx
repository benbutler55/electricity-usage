import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell, ReferenceLine,
} from 'recharts'
import type { ValueType, NameType } from 'recharts/types/component/DefaultTooltipContent'
import { useDaily } from '../../hooks/useDaily'
import { LoadingSpinner } from '../shared/LoadingSpinner'
import { ErrorBanner } from '../shared/ErrorBanner'
import { penceToPounds } from '../../lib/formatters'

export function DailyCostBarChart() {
  const { data, loading, error } = useDaily()

  if (loading) return <LoadingSpinner />
  if (error || !data) return <ErrorBanner />

  const today = new Date().toISOString().slice(0, 10)

  const points = data.days.map(d => ({
    label: new Date(d.date + 'T12:00:00Z').toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London',
    }),
    date: d.date,
    cost: d.cost_pence,
    kwh: d.kwh,
    complete: d.complete,
    isToday: d.date === today,
  }))

  const avg = points.reduce((a, p) => a + p.cost, 0) / points.length

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">
          Daily Cost (30 days)
        </h2>
        <span className="text-xs text-slate-500">avg {penceToPounds(avg)}/day</span>
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 32 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: '#94a3b8', fontSize: 9 }}
            tickLine={false}
            angle={-45}
            textAnchor="end"
            interval={3}
            axisLine={{ stroke: '#334155' }}
          />
          <YAxis
            tick={{ fill: '#94a3b8', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => penceToPounds(v)}
            width={44}
          />
          <ReferenceLine y={avg} stroke="#6366f1" strokeDasharray="4 2" strokeWidth={1} />
          <Tooltip
            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
            labelStyle={{ color: '#94a3b8', fontSize: 12 }}
            formatter={(value: ValueType | undefined, name: NameType | undefined) => {
              if (name === 'cost') return [penceToPounds(Number(value ?? 0)), 'Cost'] as [string, string]
              return [String(value ?? ''), String(name ?? '')] as [string, string]
            }}
          />
          <Bar dataKey="cost" radius={[3, 3, 0, 0]} maxBarSize={24}>
            {points.map((p, i) => (
              <Cell
                key={i}
                fill={p.isToday ? '#6366f1' : p.complete ? '#475569' : '#334155'}
                fillOpacity={p.isToday ? 1 : 0.8}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="text-xs text-slate-500 mt-1">Purple = today, dashed line = 30-day average</p>
    </div>
  )
}
