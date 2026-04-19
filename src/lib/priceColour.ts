export type PriceTier = 'negative' | 'cheap' | 'mid' | 'peak'

export function getPriceTier(pencePerKwh: number): PriceTier {
  if (pencePerKwh < 0) return 'negative'
  if (pencePerKwh < 16) return 'cheap'
  if (pencePerKwh < 30) return 'mid'
  return 'peak'
}

const TIER_COLOURS: Record<PriceTier, string> = {
  negative: '#3b82f6',
  cheap: '#22c55e',
  mid: '#f59e0b',
  peak: '#ef4444',
}

const TIER_BG_CLASSES: Record<PriceTier, string> = {
  negative: 'bg-blue-500',
  cheap: 'bg-green-500',
  mid: 'bg-amber-500',
  peak: 'bg-red-500',
}

const TIER_TEXT_CLASSES: Record<PriceTier, string> = {
  negative: 'text-blue-400',
  cheap: 'text-green-400',
  mid: 'text-amber-400',
  peak: 'text-red-400',
}

export function tierColour(pencePerKwh: number): string {
  return TIER_COLOURS[getPriceTier(pencePerKwh)]
}

export function tierBgClass(pencePerKwh: number): string {
  return TIER_BG_CLASSES[getPriceTier(pencePerKwh)]
}

export function tierTextClass(pencePerKwh: number): string {
  return TIER_TEXT_CLASSES[getPriceTier(pencePerKwh)]
}
