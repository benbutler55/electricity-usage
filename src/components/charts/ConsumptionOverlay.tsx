import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts'
import type { ValueType, NameType } from 'recharts/types/component/DefaultTooltipContent'
import { usePrices } from '../../hooks/usePrices'
import { useConsumption } from '../../hooks/useConsumption'
import { LoadingSpinner } from '../shared/LoadingSpinner'
import { ErrorBanner } from '../shared/ErrorBanner'
import { formatTime } from '../../lib/formatters'
import { tierColour } from '../../lib/priceColour'

interface ChartPoint {
  time: string
  kwh: number | null
  price: number
  cost: number | null
  barColour: string
}

export function ConsumptionOverlay() {
  const { data: consumption, loading: cl, error: ce } = useConsumption()
  const { data: prices, loading: pl, error: pe } = usePrices()

  if (cl || pl) return <LoadingSpinner />
  if ((ce && pe) || !prices) return <ErrorBanner />

  const now = new Date()

  // Last 48h of price slots as the authoritative x-axis
  const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000)
  const priceSlots = prices.slots
    .filter(s => new Date(s.valid_from) >= cutoff && new Date(s.valid_from) <= now)
    .sort((a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime())

  // Consumption lookup by normalised UTC key
  const consumptionMap = new Map(
    consumption?.slots.map(s => [new Date(s.interval_start).toISOString(), s.consumption]) ?? []
  )

  const points: ChartPoint[] = priceSlots.map(s => {
    const utcKey = new Date(s.valid_from).toISOString()
    const kwh = consumptionMap.get(utcKey) ?? null
    const price = s.value_inc_vat
    return {
      time: formatTime(s.valid_from),
      kwh,
      price,
      cost: kwh !== null ? kwh * price : null,
      barColour: tierColour(price),
    }
  })

  const consumedSlots = points.filter(p => p.kwh !== null).length
  const totalSlots = points.length
  const lagNote = consumedSlots < totalSlots
    ? `${consumedSlots}/${totalSlots} slots have data · meter lags ~24–48h`
    : undefined

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
      <div className="flex items-start justify-between mb-4 gap-2 flex-wrap">
        <div>
          <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">
            Consumption vs Price (48h)
          </h2>
          {lagNote && <p className="text-xs text-slate-500 mt-0.5">{lagNote}</p>}
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-1"><span className="w-6 h-0.5 bg-indigo-400" /> price</span>
          <span className="flex items-center gap-1"><span className="w-4 h-3 bg-slate-500 rounded-sm" /> kWh</span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis
            dataKey="time"
            tick={{ fill: '#94a3b8', fontSize: 10 }}
            tickLine={false}
            interval={11}
            axisLine={{ stroke: '#334155' }}
          />
          <YAxis
            yAxisId="kwh"
            tick={{ fill: '#94a3b8', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => `${v}kWh`}
            width={44}
          />
          <YAxis
            yAxisId="price"
            orientation="right"
            tick={{ fill: '#94a3b8', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => `${v}p`}
            width={32}
          />
          <Tooltip
            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
            labelStyle={{ color: '#94a3b8', fontSize: 12 }}
            formatter={(value: ValueType | undefined, name: NameType | undefined) => {
              const v = Number(value ?? 0)
              if (name === 'kwh') return v > 0 ? [`${v.toFixed(3)} kWh`, 'Usage'] as [string, string] : ['No data yet', 'Usage'] as [string, string]
              if (name === 'price') return [`${v.toFixed(2)}p/kWh`, 'Price'] as [string, string]
              return [String(value ?? ''), String(name ?? '')] as [string, string]
            }}
          />
          <Bar yAxisId="kwh" dataKey="kwh" maxBarSize={20} radius={[2, 2, 0, 0]}>
            {points.map((p, i) => (
              <Cell key={i} fill={p.barColour} fillOpacity={p.kwh !== null ? 0.7 : 0} />
            ))}
          </Bar>
          <Line
            yAxisId="price"
            type="stepAfter"
            dataKey="price"
            dot={false}
            stroke="#818cf8"
            strokeWidth={1.5}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
