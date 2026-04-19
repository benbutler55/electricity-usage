const TZ = 'Europe/London'

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
})

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

const monthFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  month: 'long',
  year: 'numeric',
})

export function formatTime(isoZ: string): string {
  return timeFormatter.format(new Date(isoZ))
}

export function formatDate(isoZ: string): string {
  return dateFormatter.format(new Date(isoZ))
}

export function formatMonthLabel(yyyyMm: string): string {
  return monthFormatter.format(new Date(`${yyyyMm}-01T00:00:00Z`))
}

export function penceToPounds(pence: number): string {
  const pounds = pence / 100
  if (Math.abs(pounds) < 10) return `£${pounds.toFixed(2)}`
  return `£${pounds.toFixed(0)}`
}

export function formatPrice(pencePerKwh: number): string {
  if (pencePerKwh < 0) return `${pencePerKwh.toFixed(1)}p`
  return `${pencePerKwh.toFixed(1)}p`
}

export function formatKwh(kwh: number): string {
  if (kwh >= 100) return `${kwh.toFixed(0)} kWh`
  if (kwh >= 10) return `${kwh.toFixed(1)} kWh`
  return `${kwh.toFixed(2)} kWh`
}

export function localDateString(isoZ: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(isoZ))
}
