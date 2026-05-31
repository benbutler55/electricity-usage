import { describe, it, expect } from 'vitest'
import type { PriceSlot, HeatmapCell } from '../types/data'
import {
  slotDurationHours,
  calcBatterySavings,
  representativeComparisonDay,
  sliceToDay,
  comparisonSavings,
  expandToHalfHours,
} from './agileZones'

// --- helpers -------------------------------------------------------------

/** One slot from a London-local start (BST dates use +01:00). */
function slot(startLocal: string, hours: number, price: number): PriceSlot {
  const from = new Date(startLocal)
  const to = new Date(from.getTime() + hours * 3_600_000)
  return {
    valid_from: from.toISOString(),
    valid_to: to.toISOString(),
    value_exc_vat: price,
    value_inc_vat: price,
  }
}

/** A full London day of 48 half-hour Agile slots. priceFn(hourOfDay) → p/kWh. */
function fullDay(londonDate: string, priceFn: (hour: number) => number): PriceSlot[] {
  const start = new Date(`${londonDate}T00:00:00+01:00`).getTime()
  return Array.from({ length: 48 }, (_, i) =>
    slot(new Date(start + i * 30 * 60_000).toISOString(), 0.5, priceFn(Math.floor(i / 2))),
  )
}

// cheap overnight (00:00–05:00), expensive evening peak (16:00–20:00)
const dayPrice = (h: number) => (h < 5 ? 8 : h >= 16 && h < 20 ? 35 : 20)

describe('slotDurationHours', () => {
  it('returns 0.5 for a half-hour slot', () => {
    expect(slotDurationHours(slot('2026-05-30T10:00:00+01:00', 0.5, 10))).toBeCloseTo(0.5)
  })
  it('returns the real duration for a multi-hour rate period', () => {
    expect(slotDurationHours(slot('2026-05-30T00:30:00+01:00', 4, 8))).toBeCloseTo(4)
  })
  it('falls back to 0.5 when valid_to is missing or non-positive', () => {
    const bad = { valid_from: 'x', valid_to: 'x', value_exc_vat: 1, value_inc_vat: 1 } as PriceSlot
    expect(slotDurationHours(bad)).toBeCloseTo(0.5)
  })
})

describe('calcBatterySavings — duration awareness', () => {
  it('charges full capacity across a long cheap rate-period, not just 0.5h worth', () => {
    // 2 kW battery, 4 kWh capacity. One 4h cheap period then one 4h expensive period.
    // Duration-aware: cheap 4h → 2kW*4h = 8kWh available, capped to 4 kWh capacity.
    // Old fixed-0.5h logic would only move 1 kWh and badly understate.
    const slots = [
      slot('2026-05-30T00:00:00+01:00', 4, 5),
      slot('2026-05-30T16:00:00+01:00', 4, 30),
    ]
    const s = calcBatterySavings(slots, 4, undefined, 2, 1)
    expect(s.effectiveKwh).toBeCloseTo(4, 1)        // whole battery cycled
    expect(s.dailyPence).toBeGreaterThan(80)         // ≈ 4*(30 - 5) = 100p
  })

  it('caps a long discharge slot by summed consumption across its hours', () => {
    // Heatmap: 0.5 kWh per half-hour for every hour/dow → 1 kWh per hour.
    const cells: HeatmapCell[] = []
    for (let dow = 0; dow < 7; dow++)
      for (let hour = 0; hour < 24; hour++)
        cells.push({ hour, day_of_week: dow, avg_kwh: 0.5 } as HeatmapCell)
    const slots = [
      slot('2026-05-30T00:00:00+01:00', 4, 5),   // charge window
      slot('2026-05-30T16:00:00+01:00', 4, 30),  // 4h discharge window → 4 kWh typical consumption
    ]
    const s = calcBatterySavings(slots, 10, cells, 5, 1)
    // 4h window at 0.5kWh/half-hour = 8 half-hours * 0.5 = 4 kWh consumption cap
    expect(s.effectiveKwh).toBeCloseTo(4, 1)
    expect(s.isConsumptionLimited).toBe(true)
  })
})

describe('representativeComparisonDay', () => {
  const complete = fullDay('2026-05-30', dayPrice)
  // a partial trailing day: only the evening peak remains (expensive→cheap, no full cycle)
  const partial = [
    slot('2026-05-31T18:00:00+01:00', 0.5, 35),
    slot('2026-05-31T18:30:00+01:00', 0.5, 30),
    slot('2026-05-31T19:00:00+01:00', 0.5, 25),
  ]

  it('selects a complete (~24h) day and ignores the partial tail', () => {
    const win = representativeComparisonDay([...complete, ...partial])
    expect(win).not.toBeNull()
    // window should span the complete day, ~24h
    const hours = (win!.endMs - win!.startMs) / 3_600_000
    expect(hours).toBeCloseTo(24, 0)
  })

  it('does NOT collapse to £0.00 on the partial tail (the original bug)', () => {
    const win = representativeComparisonDay([...complete, ...partial])!
    const dayAgile = sliceToDay([...complete, ...partial], win.startMs, win.endMs)
    const s = calcBatterySavings(dayAgile, 5, undefined, 2.5, 0.92)
    expect(s.monthlyPence).toBeGreaterThan(0)
  })

  it('returns null for empty input', () => {
    expect(representativeComparisonDay([])).toBeNull()
  })
})

describe('comparisonSavings', () => {
  const complete = fullDay('2026-05-30', dayPrice)

  it('scores over the representative window, matching a manual slice', () => {
    const win = representativeComparisonDay(complete)!
    const viaHelper = comparisonSavings(complete, win, 5, undefined, 2.5, 0.92)
    const manual = calcBatterySavings(sliceToDay(complete, win.startMs, win.endMs), 5, undefined, 2.5, 0.92)
    expect(viaHelper.monthlyPence).toBeCloseTo(manual.monthlyPence, 5)
  })

  it('falls back to the full slot array when the window is null', () => {
    const viaHelper = comparisonSavings(complete, null, 5, undefined, 2.5, 0.92)
    const manual = calcBatterySavings(complete, 5, undefined, 2.5, 0.92)
    expect(viaHelper.monthlyPence).toBeCloseTo(manual.monthlyPence, 5)
  })
})

describe('expandToHalfHours', () => {
  it('leaves 30-min Agile slots unchanged in count and price', () => {
    const day = fullDay('2026-05-30', dayPrice)
    const expanded = expandToHalfHours(day)
    expect(expanded).toHaveLength(day.length)
    expect(expanded.map(s => s.value_inc_vat)).toEqual(day.map(s => s.value_inc_vat))
  })

  it('splits a multi-hour Go rate-period into contiguous half-hours of the same price', () => {
    const go = [slot('2026-05-30T00:30:00+01:00', 5, 9.5)] // 5h night rate
    const expanded = expandToHalfHours(go)
    expect(expanded).toHaveLength(10) // 5h / 0.5h
    expect(expanded.every(s => s.value_inc_vat === 9.5)).toBe(true)
    // contiguous: each slot's end equals the next slot's start
    for (let i = 1; i < expanded.length; i++) {
      expect(expanded[i].valid_from).toBe(expanded[i - 1].valid_to)
    }
    // spans exactly the original period
    expect(expanded[0].valid_from).toBe(go[0].valid_from)
    expect(expanded[expanded.length - 1].valid_to).toBe(go[0].valid_to)
  })

  it('preserves a trailing remainder shorter than 30 min', () => {
    const odd = [slot('2026-05-30T00:00:00+01:00', 1.25, 12)] // 1h15m → 2×30m + 15m
    const expanded = expandToHalfHours(odd)
    expect(expanded).toHaveLength(3)
    const last = expanded[expanded.length - 1]
    expect(slotDurationHours(last)).toBeCloseTo(0.25)
    expect(last.valid_to).toBe(odd[0].valid_to)
  })

  it('keeps total energy equivalent (same savings as the coarse slots)', () => {
    const coarse = [
      slot('2026-05-30T00:00:00+01:00', 4, 5),
      slot('2026-05-30T16:00:00+01:00', 4, 30),
    ]
    const fine = calcBatterySavings(expandToHalfHours(coarse), 4, undefined, 2, 1)
    const raw = calcBatterySavings(coarse, 4, undefined, 2, 1)
    expect(fine.dailyPence).toBeCloseTo(raw.dailyPence, 1)
  })
})

describe('sliceToDay', () => {
  it('clips a long multi-day rate-period down to the target day window', () => {
    const win = { startMs: new Date('2026-05-30T00:00:00+01:00').getTime(),
                  endMs: new Date('2026-05-31T00:00:00+01:00').getTime() }
    // one 120h Go-style night-rate period spanning many days
    const goNight = [slot('2026-05-28T00:30:00+01:00', 120, 9.5)]
    const clipped = sliceToDay(goNight, win.startMs, win.endMs)
    expect(clipped).toHaveLength(1)
    const dur = slotDurationHours(clipped[0])
    expect(dur).toBeLessThanOrEqual(24)
    expect(dur).toBeGreaterThan(0)
  })

  it('drops slots that do not overlap the window', () => {
    const win = { startMs: new Date('2026-05-30T00:00:00+01:00').getTime(),
                  endMs: new Date('2026-05-31T00:00:00+01:00').getTime() }
    const far = [slot('2026-06-05T00:00:00+01:00', 1, 10)]
    expect(sliceToDay(far, win.startMs, win.endMs)).toHaveLength(0)
  })
})
