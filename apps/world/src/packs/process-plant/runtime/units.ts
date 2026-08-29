import type { ProcessPlantValue } from './model.ts'
import type { ProcessUnit } from '../graph/index.ts'

export const toCanonicalProcessValue = (value: ProcessPlantValue, unit: ProcessUnit): ProcessPlantValue => {
  if (unit === 'percent') {
    if (typeof value !== 'number') throw new Error('percent variables require numeric values')
    return value / 100
  }
  return value
}

export const fromCanonicalProcessValue = (value: ProcessPlantValue, unit: ProcessUnit): ProcessPlantValue => {
  if (unit === 'percent') {
    if (typeof value !== 'number') throw new Error('percent variables require numeric values')
    return value * 100
  }
  return value
}
