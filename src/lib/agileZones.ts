import type { PriceSlot } from '../types/data'

export const PRICE_THRESHOLDS = {
  negative: 0,
  cheap: 16,
  mid: 30,
} as const

export interface ChargeWindow {
  valid_from: string
  valid_to: string
  price: number
}

/**
 * Returns the N cheapest half-hour slots from a price array, sorted cheapest first.
 * Used by CostAnalysisCard and will be extended for Phase 2 battery optimisation.
 */
export function cheapestSlots(slots: PriceSlot[], n: number): ChargeWindow[] {
  return [...slots]
    .sort((a, b) => a.value_inc_vat - b.value_inc_vat)
    .slice(0, n)
    .map(s => ({ valid_from: s.valid_from, valid_to: s.valid_to, price: s.value_inc_vat }))
}

/**
 * Estimates potential saving (pence) if peakKwh units were shifted
 * from peakPrice to the cheapest available price in slots.
 */
export function estimatedShiftSaving(
  peakKwh: number,
  peakPrice: number,
  slots: PriceSlot[],
): number {
  if (slots.length === 0 || peakKwh <= 0) return 0
  const cheapest = Math.min(...slots.map(s => s.value_inc_vat))
  const saving = (peakPrice - cheapest) * peakKwh
  return Math.max(0, saving)
}
