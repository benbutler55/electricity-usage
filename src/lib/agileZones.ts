import type { PriceSlot } from '../types/data'

export const PRICE_THRESHOLDS = {
  negative: 0,
  cheap: 16,
  mid: 30,
} as const

export const CHARGE_RATE_KW = 2.5   // assumed charge rate for scheduling
export const ROUND_TRIP_EFFICIENCY = 0.92

export type SlotAction = 'charge' | 'discharge' | 'normal'

export interface ScheduledSlot {
  slot: PriceSlot
  action: SlotAction
}

export interface BatterySavings {
  dailyPence: number
  monthlyPence: number
  avgChargePence: number
  avgDischargePence: number
  chargeSlotCount: number
}

export interface ChargeWindow {
  valid_from: string
  valid_to: string
  price: number
}

/**
 * Returns the N cheapest half-hour slots from a price array, sorted cheapest first.
 */
export function cheapestSlots(slots: PriceSlot[], n: number): ChargeWindow[] {
  return [...slots]
    .sort((a, b) => a.value_inc_vat - b.value_inc_vat)
    .slice(0, n)
    .map(s => ({ valid_from: s.valid_from, valid_to: s.valid_to, price: s.value_inc_vat }))
}

/**
 * Labels every price slot as charge / discharge / normal for a given battery capacity.
 * Charge = cheapest N slots (enough to fill the battery at CHARGE_RATE_KW).
 * Discharge = most expensive N slots (when to avoid the grid).
 */
export function scheduleSlots(slots: PriceSlot[], capacityKwh: number): ScheduledSlot[] {
  if (slots.length === 0) return []
  const n = Math.max(1, Math.ceil(capacityKwh / (CHARGE_RATE_KW * 0.5)))
  const sorted = [...slots].sort((a, b) => a.value_inc_vat - b.value_inc_vat)
  const chargeSet = new Set(sorted.slice(0, n).map(s => s.valid_from))
  const dischargeSet = new Set(sorted.slice(-n).map(s => s.valid_from))
  return slots.map(slot => ({
    slot,
    action: chargeSet.has(slot.valid_from) ? 'charge'
           : dischargeSet.has(slot.valid_from) ? 'discharge'
           : 'normal',
  }))
}

/**
 * Calculates estimated savings for a battery of given capacity.
 */
export function calcBatterySavings(slots: PriceSlot[], capacityKwh: number): BatterySavings {
  if (slots.length === 0) return { dailyPence: 0, monthlyPence: 0, avgChargePence: 0, avgDischargePence: 0, chargeSlotCount: 0 }
  const n = Math.max(1, Math.ceil(capacityKwh / (CHARGE_RATE_KW * 0.5)))
  const sorted = [...slots].sort((a, b) => a.value_inc_vat - b.value_inc_vat)
  const chargeGroup = sorted.slice(0, n)
  const dischargeGroup = sorted.slice(-n)
  const avgCharge = chargeGroup.reduce((a, s) => a + s.value_inc_vat, 0) / chargeGroup.length
  const avgDischarge = dischargeGroup.reduce((a, s) => a + s.value_inc_vat, 0) / dischargeGroup.length
  const dailyPence = Math.max(0, capacityKwh * (avgDischarge - avgCharge / ROUND_TRIP_EFFICIENCY))
  return {
    dailyPence,
    monthlyPence: dailyPence * 30,
    avgChargePence: avgCharge,
    avgDischargePence: avgDischarge,
    chargeSlotCount: n,
  }
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
  return Math.max(0, (peakPrice - cheapest) * peakKwh)
}
