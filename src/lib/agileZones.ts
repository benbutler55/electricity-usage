import type { PriceSlot, HeatmapCell } from '../types/data'
import { localDateString } from './formatters'

export const PRICE_THRESHOLDS = {
  negative: 0,
  cheap: 16,
  mid: 30,
} as const

export const CHARGE_RATE_KW = 2.5   // default charge rate; pass battery-specific rate where known
export const ROUND_TRIP_EFFICIENCY = 0.92

const TZ = 'Europe/London'
const HALF_HOUR_MS = 30 * 60 * 1000
// Reused across hot loops — constructing an Intl formatter per call is costly.
const LONDON_HOUR_FMT = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: TZ })

const ms = (iso: string): number => new Date(iso).getTime()

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

export interface ComparisonWindow {
  startMs: number
  endMs: number
}

/**
 * Duration of a price slot in hours, derived from valid_from→valid_to.
 *
 * Agile slots are 30 min, but fixed tariffs (Go, Cosy, Flux) return multi-hour
 * rate periods as single slots.  Energy moved in/out of the battery scales with
 * this duration, so it must not be hard-coded to 0.5h.  Falls back to 0.5h when
 * the timestamps are missing or non-positive.
 */
export function slotDurationHours(slot: PriceSlot): number {
  const h = (ms(slot.valid_to) - ms(slot.valid_from)) / 3_600_000
  return Number.isFinite(h) && h > 0 ? h : 0.5
}

/** London (hour, day-of-week Mon=0) for an instant. */
function londonHourDow(epochMs: number): { hour: number; dow: number } {
  const dt = new Date(epochMs)
  const hour = Number(LONDON_HOUR_FMT.format(dt)) % 24
  const dow = (dt.getDay() + 6) % 7
  return { hour, dow }
}

/**
 * Typical consumption (kWh) during a slot, summed across every half-hour it
 * spans from the heatmap.  For a 30-min Agile slot this is just the single
 * matching cell; for a multi-hour fixed-tariff period it sums all the covered
 * half-hours so a long discharge window can shift more than one cell's worth.
 */
function slotConsumption(slot: PriceSlot, heatmapMap: Map<string, number>, fallback: number): number {
  const from = ms(slot.valid_from)
  const to = ms(slot.valid_to)
  if (!(to > from)) {
    const { hour, dow } = londonHourDow(from)
    return heatmapMap.get(`${hour}:${dow}`) ?? fallback
  }
  let total = 0
  for (let t = from; t < to; t += HALF_HOUR_MS) {
    const { hour, dow } = londonHourDow(t)
    total += heatmapMap.get(`${hour}:${dow}`) ?? fallback
  }
  return total
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
 * Charge thresholds derived by filling the battery from the cheapest energy.
 *
 * Walks slots cheapest-first, accumulating each slot's energy (rate × duration)
 * until the battery is full.  avgCharge is the energy-weighted price of that
 * fill; maxChargePrice is the dearest slot needed, widened by one slot so a
 * value a hair above the cut-off isn't excluded by a rounding gap.
 */
function getThresholds(
  slots: PriceSlot[],
  capacityKwh: number,
  chargeRateKw: number,
  efficiency: number,
) {
  const asc = [...slots].sort((a, b) => a.value_inc_vat - b.value_inc_vat)
  let cum = 0
  let costNum = 0
  let energyDen = 0
  let lastIdx = 0
  for (let i = 0; i < asc.length; i++) {
    const avail = chargeRateKw * slotDurationHours(asc[i])
    const used = Math.min(avail, Math.max(0, capacityKwh - cum))
    if (used <= 0) break
    costNum += used * asc[i].value_inc_vat
    energyDen += used
    cum += used
    lastIdx = i
    if (cum >= capacityKwh - 1e-9) break
  }
  const avgCharge = energyDen > 0 ? costNum / energyDen : (asc[0]?.value_inc_vat ?? 0)
  const threshIdx = Math.min(lastIdx + 1, asc.length - 1)
  const maxChargePrice = asc[threshIdx]?.value_inc_vat ?? avgCharge
  return { avgCharge, maxChargePrice, breakEven: avgCharge / efficiency }
}

/**
 * Shared setup for both SoC simulations: time-sorted slots, charge/break-even
 * thresholds, the set of discharge-eligible slot keys, and the heatmap lookup.
 */
function prepareSimulation(
  slots: PriceSlot[],
  capacityKwh: number,
  chargeRateKw: number,
  efficiency: number,
  heatmapCells?: HeatmapCell[],
) {
  const byTime = [...slots].sort((a, b) => ms(a.valid_from) - ms(b.valid_from))
  const thresholds = getThresholds(byTime, capacityKwh, chargeRateKw, efficiency)
  const dischargeEligible = new Set(
    byTime.filter(s => s.value_inc_vat > thresholds.breakEven).map(s => s.valid_from),
  )
  const heatmapMap = heatmapCells?.length
    ? new Map(heatmapCells.map(c => [`${c.hour}:${c.day_of_week}`, c.avg_kwh]))
    : null
  return { byTime, ...thresholds, dischargeEligible, heatmapMap }
}

/**
 * Discharge priority gate — prevents the battery wasting energy on a mediocre
 * slot when a more expensive opportunity is still coming later in the day.
 *
 * At slot i we hold `soc` kWh.  Walk the remaining discharge-eligible slots
 * most-expensive-first, accumulating their dischargeable energy until `soc` is
 * covered; the cheapest price in that set is the cut-off.  We discharge NOW
 * only if the current price clears that cut-off.  Energy-based so it works for
 * both 30-min Agile slots and multi-hour fixed-tariff periods.
 */
function isPriorityDischarge(
  price: number,
  timeIdx: number,
  timeSortedSlots: PriceSlot[],
  soc: number,
  chargeRateKw: number,
  dischargeEligible: Set<string>,
): boolean {
  if (soc <= 1e-9) return false
  const remaining = timeSortedSlots
    .slice(timeIdx)
    .filter(s => dischargeEligible.has(s.valid_from))
    .map(s => ({ price: s.value_inc_vat, energy: chargeRateKw * slotDurationHours(s) }))
    .sort((a, b) => b.price - a.price)
  let cum = 0
  let cutoff = Infinity
  for (const r of remaining) {
    if (cum >= soc) break
    cutoff = r.price
    cum += r.energy
  }
  if (cutoff === Infinity) return false
  return price >= cutoff
}

/**
 * Labels every price slot as charge / discharge / normal using SoC simulation
 * with look-ahead priority gating on discharge.
 *
 * Charge  = price ≤ maxChargePrice AND battery not full.
 * Discharge = price > break-even AND battery has energy AND price is among the
 *             dearest remaining discharge prices the current SoC can cover.
 *
 * Energy per slot scales with the slot's real duration.  Multi-cycle falls out
 * naturally: if the battery empties during a morning peak, cheap midday slots
 * recharge it for the evening peak.
 */
export function scheduleSlots(
  slots: PriceSlot[],
  capacityKwh: number,
  chargeRateKw = CHARGE_RATE_KW,
  efficiency = ROUND_TRIP_EFFICIENCY,
  heatmapCells?: HeatmapCell[],
): ScheduledSlot[] {
  if (slots.length === 0) return []

  const { byTime, maxChargePrice, dischargeEligible, heatmapMap } =
    prepareSimulation(slots, capacityKwh, chargeRateKw, efficiency, heatmapCells)

  let soc = 0
  const actionMap = new Map<string, SlotAction>()

  byTime.forEach((slot, i) => {
    const p = slot.value_inc_vat
    const slotEnergy = chargeRateKw * slotDurationHours(slot)
    if (p <= maxChargePrice && soc < capacityKwh - 1e-6) {
      soc = Math.min(capacityKwh, soc + slotEnergy)
      actionMap.set(slot.valid_from, 'charge')
    } else if (
      dischargeEligible.has(slot.valid_from) &&
      soc > 1e-6 &&
      isPriorityDischarge(p, i, byTime, soc, chargeRateKw, dischargeEligible)
    ) {
      // Use consumption-capped deduction when heatmap available so the visual
      // matches what calcBatterySavings computes — otherwise full-rate depletion
      // makes the battery appear empty too soon and hides later discharge events.
      let deduct = slotEnergy
      if (heatmapMap) {
        deduct = Math.min(slotEnergy, slotConsumption(slot, heatmapMap, slotEnergy))
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
 *
 * Energy per slot scales with the slot's real duration, so fixed tariffs with
 * multi-hour rate periods (Go, Cosy, Flux) are measured correctly rather than
 * as if every slot were 30 minutes.
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

  const { byTime, avgCharge, maxChargePrice, dischargeEligible, heatmapMap } =
    prepareSimulation(slots, capacityKwh, chargeRateKw, efficiency, heatmapCells)

  let soc = 0, socT = 0
  let chargeKwh = 0, chargeCost = 0, chargeSlotCount = 0
  let disKwh = 0, disSaving = 0
  let disKwhT = 0, disSavingT = 0
  let isConsumptionLimited = false

  byTime.forEach((slot, i) => {
    const p = slot.value_inc_vat
    const slotEnergy = chargeRateKw * slotDurationHours(slot)

    // Charge
    if (p <= maxChargePrice) {
      if (soc < capacityKwh - 1e-6) {
        const kwh = Math.min(slotEnergy, capacityKwh - soc)
        soc += kwh
        chargeKwh += kwh
        chargeCost += (kwh / efficiency) * p   // grid draw cost inc round-trip loss
        chargeSlotCount++
      }
      if (socT < capacityKwh - 1e-6) {
        socT = Math.min(capacityKwh, socT + slotEnergy)
      }
    }

    // Discharge (both trackers use the same priority gate, with their own SoC)
    if (dischargeEligible.has(slot.valid_from)) {
      if (socT > 1e-6 && isPriorityDischarge(p, i, byTime, socT, chargeRateKw, dischargeEligible)) {
        const kwh = Math.min(slotEnergy, socT)
        socT = Math.max(0, socT - kwh)
        disKwhT += kwh
        disSavingT += kwh * p
      }

      if (soc > 1e-6 && isPriorityDischarge(p, i, byTime, soc, chargeRateKw, dischargeEligible)) {
        let kwh = Math.min(slotEnergy, soc)
        if (heatmapMap) {
          const consumption = slotConsumption(slot, heatmapMap, slotEnergy)
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
 * Picks a stable, fully-covered London day to score every tariff over, so the
 * battery comparison is apples-to-apples and never collapses to £0.00 on a
 * partial-day tail.  Returns the latest day whose slots span ≥23h (a complete
 * day) — that's tomorrow once Agile publishes it, otherwise the most recent
 * complete day already in the data.  Window is [day 00:00, next 00:00) in UTC ms.
 */
export function representativeComparisonDay(agileSlots: PriceSlot[]): ComparisonWindow | null {
  if (agileSlots.length === 0) return null
  const byDay = new Map<string, PriceSlot[]>()
  for (const s of agileSlots) {
    const key = localDateString(s.valid_from)
    const list = byDay.get(key) ?? []
    list.push(s)
    byDay.set(key, list)
  }
  const keys = [...byDay.keys()].sort()
  for (let i = keys.length - 1; i >= 0; i--) {
    const daySlots = byDay.get(keys[i])!
    const coveredHours = daySlots.reduce((a, s) => a + slotDurationHours(s), 0)
    if (coveredHours >= 23) {
      let startMs = Infinity
      let endMs = -Infinity
      for (const s of daySlots) {
        startMs = Math.min(startMs, ms(s.valid_from))
        endMs = Math.max(endMs, ms(s.valid_to))
      }
      return { startMs, endMs }
    }
  }
  return null
}

/**
 * Returns slots overlapping [startMs, endMs), each clipped to that window so a
 * fixed tariff's multi-day rate period contributes only its in-day duration.
 */
export function sliceToDay(slots: PriceSlot[], startMs: number, endMs: number): PriceSlot[] {
  const out: PriceSlot[] = []
  for (const s of slots) {
    const clipFrom = Math.max(ms(s.valid_from), startMs)
    const clipTo = Math.min(ms(s.valid_to), endMs)
    if (clipTo <= clipFrom) continue
    out.push({
      ...s,
      valid_from: new Date(clipFrom).toISOString(),
      valid_to: new Date(clipTo).toISOString(),
    })
  }
  return out
}

/**
 * Savings for one tariff scored over the shared comparison window, so every
 * tariff is measured the same way.  When no complete day is available
 * (`window` is null) all tariffs fall back identically to their full slot
 * array, keeping the comparison coherent rather than mixing horizons.
 */
export function comparisonSavings(
  slots: PriceSlot[],
  window: ComparisonWindow | null,
  capacityKwh: number,
  heatmapCells?: HeatmapCell[],
  chargeRateKw = CHARGE_RATE_KW,
  efficiency = ROUND_TRIP_EFFICIENCY,
): BatterySavings {
  const scoped = window ? sliceToDay(slots, window.startMs, window.endMs) : slots
  return calcBatterySavings(scoped, capacityKwh, heatmapCells, chargeRateKw, efficiency)
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
