import type { PricesData } from '../types/data'
import { useData } from './useData'

export function usePrices() {
  return useData<PricesData>('./data/prices.json')
}
