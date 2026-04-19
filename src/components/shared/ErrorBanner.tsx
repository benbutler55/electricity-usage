interface Props {
  message?: string
}

export function ErrorBanner({ message = 'Data unavailable' }: Props) {
  return (
    <div className="flex items-center justify-center h-32 text-slate-400 text-sm">
      {message}
    </div>
  )
}
