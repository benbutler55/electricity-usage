export interface PriceSlot {
  valid_from: string   // ISO8601Z
  valid_to: string
  value_exc_vat: number  // p/kWh
  value_inc_vat: number  // p/kWh, may be negative
}

export interface PricesData {
  fetched_at: string
  tomorrow_available: boolean
  slots: PriceSlot[]
}

export interface ConsumptionSlot {
  interval_start: string  // ISO8601Z
  interval_end: string
  consumption: number     // kWh
}

export interface ConsumptionData {
  fetched_at: string
  period_from: string
  period_to: string
  slots: ConsumptionSlot[]
}

export interface DayRecord {
  date: string       // YYYY-MM-DD in Europe/London
  cost_pence: number
  kwh: number
  slot_count: number
  complete: boolean
}

export interface DailyData {
  fetched_at: string
  days: DayRecord[]
}

export interface MonthSummary {
  month: string               // YYYY-MM
  cost_pence: number
  kwh: number
  days_complete: number
  days_in_month: number
  projected_cost_pence: number
  avg_daily_cost_pence: number
}

export interface MonthlyData {
  fetched_at: string
  current: MonthSummary
  previous: MonthSummary
}

export interface HeatmapCell {
  hour: number         // 0-23
  day_of_week: number  // 0=Monday, 6=Sunday
  avg_price_inc_vat: number  // p/kWh
  avg_cost_pence: number
  avg_kwh: number
  sample_count: number
}

export interface HeatmapData {
  fetched_at: string
  basis_days: number
  cells: HeatmapCell[]
}

export interface MetaData {
  fetched_at: string
  mpan: string
  meter_serial: string
  tariff_code: string    // e.g. E-1R-AGILE-24-10-01-C
  product_slug: string   // e.g. AGILE-24-10-01
  region: string         // single letter, e.g. C
}
