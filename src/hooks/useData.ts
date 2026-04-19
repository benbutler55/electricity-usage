import { useEffect, useState } from 'react'

interface DataState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

export function useData<T>(path: string): DataState<T> {
  const [state, setState] = useState<DataState<T>>({ data: null, loading: true, error: null })

  useEffect(() => {
    let cancelled = false
    setState({ data: null, loading: true, error: null })
    fetch(path)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<T>
      })
      .then(data => { if (!cancelled) setState({ data, loading: false, error: null }) })
      .catch(err => { if (!cancelled) setState({ data: null, loading: false, error: String(err) }) })
    return () => { cancelled = true }
  }, [path])

  return state
}
