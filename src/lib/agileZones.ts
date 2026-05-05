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
  theoreticalDailyPence: number  // no consumption cap — pure SoC limit
  avgChargePence: number
  avgDischargePence: number
  chargeSlotCount: number
  effectiveKwh: number        // kWh actually discharged
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
 * Derives charge/discharge thresholds from a slot array.
 *
 * maxChargePrice: price of the Nth cheapest slot where N = slots to fill the battery once.
 *   The battery charges at any slot at or below this price.
 * breakEven: avgCharge / efficiency — discharge is only profitable above this line.
 *   Discharging below it costs more to recharge than it saves.
 */
function getThresholds(
  slots: PriceSlot[],
  capacityKwh: number,
  chargeRateKw: number,
  efficiency: number,
) {
  const kwhPerSlot = chargeRateKw * 0.5
  const nFill = Math.max(1, Math.ceil(capacityKwh / kwhPerSlot))
  const sortedAsc = [...slots].sort((a, b) => a.value_inc_vat - b.value_inc_vat)
  const refSlots = sortedAsc.slice(0, nFill)
  const avgCharge = refSlots.reduce((a, s) => a + s.value_inc_vat, 0) / refSlots.length
  const maxChargePrice = refSlots[refSlots.length - 1].value_inc_vat
  return { kwhPerSlot, nFill, avgCharge, maxChargePrice, breakEven: avgCharge / efficiency }
}

/**
 * Labels every price slot as charge / discharge / normal using SoC simulation.
 *
 * Charge  = slot price ≤ maxChargePrice AND battery not full.
 * Discharge = slot price > break-even AND battery has energy.
 *
 * Processing in time order with SoC tracking means the battery naturally
 * recharges during cheap midday dips and discharges again during the evening
 * peak — multi-cycle falls out of the simulation without explicit modelling.
 */
export function scheduleSlots(
  slots: PriceSlot[],
  capacityKwh: number,
  chargeRateKw = CHARGE_RATE_KW,
  efficiency = ROUND_TRIP_EFFICIENCY,
): ScheduledSlot[] {
  if (slots.length === 0) return []
  const { kwhPerSlot, maxChargePrice, breakEven } = getThresholds(
    slots, capacityKwh, chargeRateKw, efficiency,
  )
  const dischargeEligible = new Set(
    slots.filter(s => s.value_inc_vat > breakEven).map(s => s.valid_from),
  )
  let soc = 0
  return slots.map(slot => {
    const p = slot.value_inc_vat
    if (p <= maxChargePrice && soc < capacityKwh - 1e-6) {
      soc = Math.min(capacityKwh, soc + kwhPerSlot)
      return { slot, action: 'charge' as SlotAction }
    }
    if (dischargeEligible.has(slot.valid_from) && soc > 1e-6) {
      soc = Math.max(0, soc - kwhPerSlot)
      return { slot, action: 'discharge' as SlotAction }
    }
    return { slot, action: 'normal' as SlotAction }
  })
}

const TZ = 'Europe/London'

/**
 * Calculates estimated savings for a battery of given capacity.
 *
 * Strategy: charge during all slots at or below maxChargePrice; discharge
 * during all slots above the break-even threshold in time order.  SoC
 * tracking allows multi-cycle operation (recharge → re-discharge).
 *
 * Pass heatmapCells to cap per-slot discharge at typical consumption for
 * that hour/day-of-week.  Omit for theoretical (SoC-only limited) figures.
 *
 * Charge cost = Σ (kWh stored / efficiency × slot price) — round-trip loss
 * is accounted for on the charge side so discharge revenue is face value.
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

  const { kwhPerSlot, avgCharge, maxChargePrice, breakEven } = getThresholds(
    slots, capacityKwh, chargeRateKw, efficiency,
  )
  const dischargeEligible = new Set(
    slots.filter(s => s.value_inc_vat > breakEven).map(s => s.valid_from),
  )
  const heatmapMap = heatmapCells?.length
    ? new Map(heatmapCells.map(c => [`${c.hour}:${c.day_of_week}`, c.avg_kwh]))
    : null

  // Run two SoC trackers in one pass:
  //   soc  = realistic (discharge capped by heatmap consumption)
  //   socT = theoretical (discharge at full rate, no consumption cap)
  let soc = 0, socT = 0
  let chargeKwh = 0, chargeCost = 0, chargeSlotCount = 0
  let disKwh = 0, disSaving = 0
  let disKwhT = 0, disSavingT = 0
  let isConsumptionLimited = false

  for (const slot of slots) {
    const p = slot.value_inc_vat

    // Charge
    if (p <= maxChargePrice) {
      if (soc < capacityKwh - 1e-6) {
        const kwh = Math.min(kwhPerSlot, capacityKwh - soc)
        soc += kwh
        chargeKwh += kwh
        chargeCost += (kwh / efficiency) * p   // grid draw cost inc round-trip loss
        chargeSlotCount++
      }
      if (socT < capacityKwh - 1e-6) {
        socT = Math.min(capacityKwh, socT + kwhPerSlot)
      }
    }

    // Discharge
    if (dischargeEligible.has(slot.valid_from)) {
      // Theoretical
      if (socT > 1e-6) {
        const kwh = Math.min(kwhPerSlot, socT)
        socT = Math.max(0, socT - kwh)
        disKwhT += kwh
        disSavingT += kwh * p
      }

      // Realistic (with per-slot consumption cap)
      if (soc > 1e-6) {
        let kwh = Math.min(kwhPerSlot, soc)
        if (heatmapMap) {
          const dt = new Date(slot.valid_from)
          const hour = Number(
            new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: TZ }).format(dt),
          )
          const dow = (dt.getDay() + 6) % 7   // 0=Mon
          const consumption = heatmapMap.get(`${hour}:${dow}`) ?? kwhPerSlot
          if (consumption < kwh) {
            kwh = consumption
            isConsumptionLimited = true
          }
        }
        soc = Math.max(0, soc - kwh)
        disKwh += kwh
        disSaving += kwh * p
      }
    }
  }

  // Allocate only the fraction of charge cost that served actual discharge
  const allocatedChargeCost = chargeKwh > 0
    ? chargeCost * Math.min(1, disKwh / chargeKwh)
    : 0
  const theoreticalChargeCost = disKwhT > 0 ? (disKwhT / efficiency) * avgCharge : 0

  const dailyPence = Math.max(0, disSaving - allocatedChargeCost)
  const theoreticalDailyPence = Math.max(0, disSavingT - theoreticalChargeCost)

  return {
    dailyPence,
    monthlyPence: dailyPence * 30,
    theoreticalDailyPence,
    avgChargePence: chargeKwh > 0
      ? chargeCost / (chargeKwh / efficiency)
      : avgCharge,
    avgDischargePence: disKwh > 0 ? disSaving / disKwh : 0,
    chargeSlotCount,
    effectiveKwh: disKwh,
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
