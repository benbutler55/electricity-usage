interface Props {
  children: React.ReactNode
}

export function Shell({ children }: Props) {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-12">
      {children}
    </div>
  )
}
