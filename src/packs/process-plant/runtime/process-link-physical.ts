import type { CompiledProcessLink } from '../graph/index.ts'

export const physicalNumber = (
  link: CompiledProcessLink,
  key: 'nominalResistance' | 'nominalFlowKgPerS' | 'leakCoefficientKgPerSPerSqrtMPa',
  defaultValue: number,
): number => {
  const value = link.physical?.[key]
  return value === undefined ? defaultValue : value
}

export const physicalFlowCapacityKgPerS = (link: CompiledProcessLink): number =>
  physicalNumber(link, 'nominalFlowKgPerS', Number.POSITIVE_INFINITY)
