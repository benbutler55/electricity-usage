import { tierBgClass, tierTextClass } from '../../lib/priceColour'

interface Props {
  pencePerKwh: number
  size?: 'sm' | 'lg'
}

export function PriceBadge({ pencePerKwh, size = 'sm' }: Props) {
  const bg = tierBgClass(pencePerKwh)
  const text = size === 'lg' ? 'text-3xl font-bold' : 'text-sm font-semibold'
  const colour = tierTextClass(pencePerKwh)
  return (
    <span className={`${colour} ${text} tabular-nums`}>
      {pencePerKwh < 0 ? '' : ''}{pencePerKwh.toFixed(1)}p
      <span className={`ml-1 px-1.5 py-0.5 rounded text-xs font-medium text-white ${bg}`}>
        {pencePerKwh < 0 ? 'negative' : pencePerKwh < 16 ? 'cheap' : pencePerKwh < 30 ? 'mid' : 'peak'}
      </span>
    </span>
  )
}
