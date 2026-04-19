import type { ConsumptionData } from '../types/data'
import { useData } from './useData'

export function useConsumption() {
  return useData<ConsumptionData>('./data/consumption.json')
}
