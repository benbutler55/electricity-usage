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

function getThresholds(
  slots: PriceSlot[],
  capacityKwh: number,
  chargeRateKw: number,
  efficiency: number,
) {
  const kwhPerSlot = chargeRateKw * 0.5
  const nFill = Math.max(1, Math.ceil(capacityKwh / kwhPerSlot))
  const sortedAsc = [...slots].sort((a, b) => a.value_inc_vat - b.value_inc_vat)

  // avgCharge uses the exact cheapest nFill slots — keeps the savings calculation accurate.
  const refSlots = sortedAsc.slice(0, nFill)
  const avgCharge = refSlots.reduce((a, s) => a + s.value_inc_vat, 0) / refSlots.length

  // Charge threshold uses nFill+1 slots so that a slot 0.1–0.2p above the exact
  // Nth-cheapest isn't excluded by a rounding gap.  Without this, one missing
  // pre-peak charge slot leaves the battery half-full and budget=1.
  const threshIdx = Math.min(nFill, sortedAsc.length - 1)
  const maxChargePrice = sortedAsc[threshIdx].value_inc_vat

  return { kwhPerSlot, nFill, avgCharge, maxChargePrice, breakEven: avgCharge / efficiency }
}

/**
 * Discharge priority gate — prevents the battery wasting energy on a mediocre
 * slot when a more expensive opportunity is still coming later in the day.
 *
 * At slot i, we have `soc` kWh available which can cover ceil(soc/kwhPerSlot)
 * more discharge slots.  We should only discharge NOW if the current price is
 * among the top-budget remaining discharge-eligible prices.  If a cheaper slot
 * comes first in time but an expensive one follows, we hold the charge.
 */
function isPriorityDischarge(
  price: number,
  timeIdx: number,
  timeSortedSlots: PriceSlot[],
  soc: number,
  kwhPerSlot: number,
  dischargeEligible: Set<string>,
): boolean {
  const budget = Math.ceil(soc / kwhPerSlot)
  if (budget === 0) return false
  const remaining = timeSortedSlots
    .slice(timeIdx)                           // current slot onward
    .filter(s => dischargeEligible.has(s.valid_from))
    .map(s => s.value_inc_vat)
    .sort((a, b) => b - a)                   // descending
    .slice(0, budget)                         // top-budget prices
  if (remaining.length === 0) return false
  return price >= remaining[remaining.length - 1]  // current price is competitive
}

/**
 * Labels every price slot as charge / discharge / normal using SoC simulation
 * with look-ahead priority gating on discharge.
 *
 * Charge  = price ≤ maxChargePrice AND battery not full.
 * Discharge = price > break-even AND battery has energy AND price is among
 *             the top-K remaining discharge prices (K = ceil(soc / kwhPerSlot)).
 *
 * The priority gate prevents discharging at a 19p slot at 2:30pm when 30p+
 * slots are still coming at 4–7pm.  Multi-cycle falls out naturally: if the
 * battery empties during a morning peak, cheap midday slots recharge it for
 * the evening peak.
 */
export function scheduleSlots(
  slots: PriceSlot[],
  capacityKwh: number,
  chargeRateKw = CHARGE_RATE_KW,
  efficiency = ROUND_TRIP_EFFICIENCY,
  heatmapCells?: HeatmapCell[],
): ScheduledSlot[] {
  if (slots.length === 0) return []

  const byTime = [...slots].sort(
    (a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime(),
  )
  const { kwhPerSlot, maxChargePrice, breakEven } = getThresholds(
    byTime, capacityKwh, chargeRateKw, efficiency,
  )
  const dischargeEligible = new Set(
    byTime.filter(s => s.value_inc_vat > breakEven).map(s => s.valid_from),
  )
  const heatmapMap = heatmapCells?.length
    ? new Map(heatmapCells.map(c => [`${c.hour}:${c.day_of_week}`, c.avg_kwh]))
    : null

  let soc = 0
  const actionMap = new Map<string, SlotAction>()

  byTime.forEach((slot, i) => {
    const p = slot.value_inc_vat
    if (p <= maxChargePrice && soc < capacityKwh - 1e-6) {
      soc = Math.min(capacityKwh, soc + kwhPerSlot)
      actionMap.set(slot.valid_from, 'charge')
    } else if (
      dischargeEligible.has(slot.valid_from) &&
      soc > 1e-6 &&
      isPriorityDischarge(p, i, byTime, soc, kwhPerSlot, dischargeEligible)
    ) {
      // Use consumption-capped deduction when heatmap available so the visual
      // matches what calcBatterySavings computes — otherwise full-rate depletion
      // makes the battery appear empty after 2 slots and hides the remaining
      // discharge events that still happen across the evening.
      let deduct = kwhPerSlot
      if (heatmapMap) {
        const dt = new Date(slot.valid_from)
        const hour = Number(
          new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: TZ }).format(dt),
        )
        const dow = (dt.getDay() + 6) % 7
        deduct = Math.min(kwhPerSlot, heatmapMap.get(`${hour}:${dow}`) ?? kwhPerSlot)
      }
      soc = Math.max(0, soc - deduct)
      actionMap.set(slot.valid_from, 'discharge')
    } else {
      actionMap.set(slot.valid_from, 'normal')
    }
  })

  // Preserve original input order so the UI timeline renders correctly
  return slots.map(slot => ({ slot, action: actionMap.get(slot.valid_from) ?? 'normal' }))
}

const TZ = 'Europe/London'

/**
 * Calculates estimated savings using the same SoC + priority-gate simulation.
 *
 * Two parallel SoC trackers run in one pass:
 *   realistic — per-slot discharge capped at heatmap consumption
 *   theoretical — full discharge rate, no consumption cap
 *
 * Charge cost = Σ (kWh stored / efficiency × slot price): round-trip loss
 * allocated to the charge side, so discharge revenue is face-value kWh × price.
 * Only the fraction of charge cost that served actual discharge is counted.
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

  const byTime = [...slots].sort(
    (a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime(),
  )
  const { kwhPerSlot, avgCharge, maxChargePrice, breakEven } = getThresholds(
    byTime, capacityKwh, chargeRateKw, efficiency,
  )
  const dischargeEligible = new Set(
    byTime.filter(s => s.value_inc_vat > breakEven).map(s => s.valid_from),
  )
  const heatmapMap = heatmapCells?.length
    ? new Map(heatmapCells.map(c => [`${c.hour}:${c.day_of_week}`, c.avg_kwh]))
    : null

  let soc = 0, socT = 0
  let chargeKwh = 0, chargeCost = 0, chargeSlotCount = 0
  let disKwh = 0, disSaving = 0
  let disKwhT = 0, disSavingT = 0
  let isConsumptionLimited = false

  byTime.forEach((slot, i) => {
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

    // Discharge (both trackers use the same priority gate, with their own SoC)
    if (dischargeEligible.has(slot.valid_from)) {
      if (socT > 1e-6 && isPriorityDischarge(p, i, byTime, socT, kwhPerSlot, dischargeEligible)) {
        const kwh = Math.min(kwhPerSlot, socT)
        socT = Math.max(0, socT - kwh)
        disKwhT += kwh
        disSavingT += kwh * p
      }

      if (soc > 1e-6 && isPriorityDischarge(p, i, byTime, soc, kwhPerSlot, dischargeEligible)) {
        let kwh = Math.min(kwhPerSlot, soc)
        if (heatmapMap) {
          const dt = new Date(slot.valid_from)
          const hour = Number(
            new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: TZ }).format(dt),
          )
          const dow = (dt.getDay() + 6) % 7
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
  })

  // Allocate only the share of charge cost that served discharged energy
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
