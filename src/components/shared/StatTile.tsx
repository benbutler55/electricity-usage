interface Props {
  label: string
  value: string
  sub?: string
  valueClass?: string
}

export function StatTile({ label, value, sub, valueClass = 'text-slate-100' }: Props) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-slate-400 uppercase tracking-wide">{label}</span>
      <span className={`text-2xl font-bold tabular-nums ${valueClass}`}>{value}</span>
      {sub && <span className="text-xs text-slate-500">{sub}</span>}
    </div>
  )
}
