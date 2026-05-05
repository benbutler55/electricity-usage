import { useData } from '../../hooks/useData'
import { usePrices } from '../../hooks/usePrices'
import type { TariffComparisonData, TariffEntry, PriceSlot } from '../../types/data'
import { tierColour } from '../../lib/priceColour'

/** Returns the ms timestamp of midnight today in Europe/London. */
function londonMidnightMs(): number {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).format(now)
  const [h, m] = parts.split(':').map(Number)
  return now.getTime() - (h * 3600 + m * 60) * 1000 - now.getSeconds() * 1000 - now.getMilliseconds()
}

interface Band {
  leftPct: number
  widthPct: number
  price: number
}

function slotsToBands(slots: PriceSlot[]): Band[] {
  const midnight = londonMidnightMs()
  const end = midnight + 86400000
  return slots
    .map(s => ({ from: +new Date(s.valid_from), to: +new Date(s.valid_to), price: s.value_inc_vat }))
    .filter(s => s.to > midnight && s.from < end)
    .sort((a, b) => a.from - b.from)
    .map(s => ({
      leftPct: (Math.max(s.from, midnight) - midnight) / 86400000 * 100,
      widthPct: (Math.min(s.to, end) - Math.max(s.from, midnight)) / 86400000 * 100,
      price: s.price,
    }))
}

const TIME_LABELS = ['00:00', '06:00', '12:00', '18:00', '23:30']

function BandBar({ bands }: { bands: Band[] }) {
  return (
    <>
      <div className="relative h-8 rounded overflow-hidden bg-slate-900/50">
        {bands.map((b, i) => (
          <div
            key={i}
            className="absolute top-0 bottom-0 flex items-center justify-center"
            style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%`, backgroundColor: tierColour(b.price), opacity: 0.85 }}
            title={`${b.price.toFixed(1)}p/kWh`}
          >
            {b.widthPct > 12 && (
              <span className="text-white font-semibold" style={{ fontSize: '9px' }}>
                {b.price.toFixed(1)}p
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-between mt-1 text-slate-600" style={{ fontSize: '9px' }}>
        {TIME_LABELS.map(t => <span key={t}>{t}</span>)}
      </div>
    </>
  )
}

const BADGE: Record<string, { label: string; hex: string }> = {
  go:       { label: 'FIXED',    hex: '#22c55e' },
  cosy:     { label: 'FIXED',    hex: '#f59e0b' },
  flux:     { label: 'DYNAMIC',  hex: '#a855f7' },
  flexible: { label: 'VARIABLE', hex: '#64748b' },
}

function TariffCard({ tariff }: { tariff: TariffEntry }) {
  const { label, hex } = BADGE[tariff.id] ?? { label: 'FIXED', hex: '#64748b' }
  const bands = slotsToBands(tariff.slots)
  const rates = [...new Set(bands.map(b => b.price))].sort((a, b) => a - b)
  return (
    <div className="bg-slate-900/50 rounded-lg p-3 border border-slate-700/50">
      <div className="flex justify-between items-start mb-2">
        <p className="text-sm font-semibold text-slate-200">{tariff.name}</p>
        <span
          className="text-xs font-semibold px-1.5 py-0.5 rounded"
          style={{ color: hex, backgroundColor: hex + '20' }}
        >
          {label}
        </span>
      </div>
      <BandBar bands={bands} />
      <p className="text-xs text-slate-500 mt-2">
        {rates.map(r => `${r.toFixed(1)}p`).join(' · ')}
      </p>
    </div>
  )
}

export function TariffComparisonPanel() {
  const { data: tariffData } = useData<TariffComparisonData>('./data/tariff_comparison.json')
  const { data: prices } = usePrices()

  if (!tariffData && !prices) return null

  const agileBands: Band[] = prices ? slotsToBands(prices.slots) : []
  const displayTariffs = tariffData?.tariffs.filter(t => ['go', 'cosy', 'flux'].includes(t.id)) ?? []

  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
      <div className="mb-4">
        <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">Tariff Comparison</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Rate structure by time of day · Region {tariffData?.region ?? '—'}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-900/50 rounded-lg p-3 border border-indigo-500/30">
          <div className="flex justify-between items-start mb-2">
            <div>
              <p className="text-sm font-semibold text-slate-200">Agile Octopus</p>
              <p className="text-xs text-slate-500">Your current tariff</p>
            </div>
            <span
              className="text-xs font-semibold px-1.5 py-0.5 rounded"
              style={{ color: '#818cf8', backgroundColor: '#6366f120' }}
            >
              LIVE
            </span>
          </div>
          {agileBands.length > 0 ? (
            <>
              <BandBar bands={agileBands} />
              <p className="text-xs text-slate-500 mt-2">
                {Math.min(...agileBands.map(b => b.price)).toFixed(1)}p –{' '}
                {Math.max(...agileBands.map(b => b.price)).toFixed(1)}p today
              </p>
            </>
          ) : (
            <p className="text-xs text-slate-600 mt-2">Loading…</p>
          )}
        </div>
        {displayTariffs.map(t => <TariffCard key={t.id} tariff={t} />)}
      </div>
    </div>
  )
}
