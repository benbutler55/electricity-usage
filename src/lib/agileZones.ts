import type { PriceSlot, HeatmapCell } from '../types/data'

export const PRICE_THRESHOLDS = {
  negative: 0,
  cheap: 16,
  mid: 30,
} as const

export const CHARGE_RATE_KW = 2.5   // default charge rate; pass battery-specific rate where known
export const ROUND_TRIP_EFFICIENCY = 0.92

export type SlotAction = 'charge' | 'discharge' | 'normal'

export interface ScheduledSlot {
  slot: PriceSlot
  action: SlotAction
}

export interface BatterySavings {
  dailyPence: number          // capped by realistic consumption
  monthlyPence: number
  theoreticalDailyPence: number  // assumes full capacity utilised every cycle
  avgChargePence: number
  avgDischargePence: number
  chargeSlotCount: number
  effectiveKwh: number        // kWh actually shifted (min of capacity vs peak consumption)
  isConsumptionLimited: boolean
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
export function scheduleSlots(slots: PriceSlot[], capacityKwh: number, chargeRateKw = CHARGE_RATE_KW): ScheduledSlot[] {
  if (slots.length === 0) return []
  const n = Math.max(1, Math.ceil(capacityKwh / (chargeRateKw * 0.5)))
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

const TZ = 'Europe/London'

/**
 * Calculates estimated savings for a battery of given capacity.
 * Pass heatmapCells to get a consumption-realistic figure; omit for theoretical max.
 *
 * Formula: saving = effectiveKwh × (avgDischarge − avgCharge ÷ efficiency)
 *   - You draw capacityKwh/efficiency from the grid to store capacityKwh (charge loss)
 *   - You avoid buying effectiveKwh at the peak rate (discharge gain)
 *   - effectiveKwh is capped at typical consumption during the discharge window
 */
export function calcBatterySavings(
  slots: PriceSlot[],
  capacityKwh: number,
  heatmapCells?: HeatmapCell[],
  chargeRateKw = CHARGE_RATE_KW,
  efficiency = ROUND_TRIP_EFFICIENCY,
): BatterySavings {
  const empty: BatterySavings = {
    dailyPence: 0, monthlyPence: 0, theoreticalDailyPence: 0,
    avgChargePence: 0, avgDischargePence: 0, chargeSlotCount: 0,
    effectiveKwh: 0, isConsumptionLimited: false,
  }
  if (slots.length === 0) return empty

  const n = Math.max(1, Math.ceil(capacityKwh / (chargeRateKw * 0.5)))
  const sorted = [...slots].sort((a, b) => a.value_inc_vat - b.value_inc_vat)
  const chargeGroup = sorted.slice(0, n)
  const dischargeGroup = sorted.slice(-n)
  const avgCharge = chargeGroup.reduce((a, s) => a + s.value_inc_vat, 0) / chargeGroup.length
  const avgDischarge = dischargeGroup.reduce((a, s) => a + s.value_inc_vat, 0) / dischargeGroup.length

  const theoreticalDailyPence = Math.max(0, capacityKwh * (avgDischarge - avgCharge / efficiency))

  // Estimate realistic consumption during discharge window from heatmap
  let effectiveKwh = capacityKwh
  let isConsumptionLimited = false
  if (heatmapCells && heatmapCells.length > 0) {
    const heatmapMap = new Map(
      heatmapCells.map(c => [`${c.hour}:${c.day_of_week}`, c.avg_kwh])
    )
    const peakConsumption = dischargeGroup.reduce((sum, slot) => {
      const dt = new Date(slot.valid_from)
      const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: TZ }).format(dt))
      const dow = (dt.getDay() + 6) % 7 // 0=Mon
      return sum + (heatmapMap.get(`${hour}:${dow}`) ?? 0)
    }, 0)
    if (peakConsumption > 0 && peakConsumption < capacityKwh) {
      effectiveKwh = peakConsumption
      isConsumptionLimited = true
    }
  }

  const dailyPence = Math.max(0, effectiveKwh * (avgDischarge - avgCharge / efficiency))
  return {
    dailyPence,
    monthlyPence: dailyPence * 30,
    theoreticalDailyPence,
    avgChargePence: avgCharge,
    avgDischargePence: avgDischarge,
    chargeSlotCount: n,
    effectiveKwh,
    isConsumptionLimited,
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
