interface Props {
  children: React.ReactNode
  cols?: 1 | 2
}

export function SectionGrid({ children, cols = 2 }: Props) {
  const grid = cols === 2 ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'
  return (
    <div className={`grid ${grid} gap-4 mt-4`}>
      {children}
    </div>
  )
}
