import { usePrices } from '../../hooks/usePrices'
import { useData } from '../../hooks/useData'
import type { MetaData } from '../../types/data'
import { PriceBadge } from '../shared/PriceBadge'
import { formatTime } from '../../lib/formatters'

export function StatusBar() {
  const { data: prices } = usePrices()
  const { data: meta } = useData<MetaData>('./data/meta.json')

  const now = new Date()
  const currentSlot = prices?.slots.find(s =>
    new Date(s.valid_from) <= now && now < new Date(s.valid_to)
  )
  const nextSlot = prices?.slots.find(s => new Date(s.valid_from) > now)

  return (
    <header className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur border-b border-slate-800">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="text-slate-100 font-semibold text-lg">⚡ Electricity</span>
          {meta && (
            <span className="text-xs text-slate-500 hidden sm:inline">{meta.tariff_code}</span>
          )}
        </div>

        <div className="flex items-center gap-6">
          {currentSlot ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Now</span>
              <PriceBadge pencePerKwh={currentSlot.value_inc_vat} size="lg" />
            </div>
          ) : (
            <span className="text-slate-500 text-sm">Price unavailable</span>
          )}

          {nextSlot && (
            <div className="hidden sm:flex items-center gap-2">
              <span className="text-xs text-slate-400">Next ({formatTime(nextSlot.valid_from)})</span>
              <PriceBadge pencePerKwh={nextSlot.value_inc_vat} />
            </div>
          )}

          {prices && (
            <span className="text-xs text-slate-500">
              Updated {formatTime(prices.fetched_at)}
            </span>
          )}
        </div>
      </div>
    </header>
  )
}
