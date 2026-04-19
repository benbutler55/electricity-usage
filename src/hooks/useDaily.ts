import type { DailyData } from '../types/data'
import { useData } from './useData'

export function useDaily() {
  return useData<DailyData>('./data/daily.json')
}
