export interface BranchElectricalParameters {
  readonly ratingMw: number
  readonly emergencyRatingMw: number
  readonly reactancePu: number
  readonly resistancePu: number
  readonly weatherExposure: 'low' | 'medium' | 'high'
}

const voltageRatingMw = (nominalKv: number, circuitMultiplier: number): number => {
  if (nominalKv >= 500) return 900 * circuitMultiplier
  if (nominalKv >= 420) return 1850 * circuitMultiplier
  if (nominalKv >= 300) return 1850 * circuitMultiplier
  if (nominalKv >= 220) return 720 * circuitMultiplier
  if (nominalKv >= 132) return 560 * circuitMultiplier
  if (nominalKv >= 66) return 120 * circuitMultiplier
  return 60 * circuitMultiplier
}

export const inferBranchElectricalParameters = (config: {
  readonly nominalKv: number
  readonly lengthKm: number
  readonly category: 'line' | 'cable'
  readonly name: string
}): BranchElectricalParameters => {
  const lowerName = config.name.toLowerCase()
  const parallelHint = lowerName.includes('1+2') || lowerName.includes(' 1&2') || lowerName.includes(' 1 og 2')
  const circuitMultiplier = parallelHint ? 1.65 : 1
  const cablePenalty = config.category === 'cable' ? 0.78 : 1
  const ratingMw = Math.round(voltageRatingMw(config.nominalKv, circuitMultiplier) * cablePenalty)
  const lengthFactor = Math.max(0.01, config.lengthKm / 100)
  const voltageFactor = Math.max(0.55, 420 / Math.max(66, config.nominalKv))
  const cableFactor = config.category === 'cable' ? 0.65 : 1
  const reactancePu = Number(Math.min(0.24, Math.max(0.012, lengthFactor * 0.075 * voltageFactor * cableFactor)).toFixed(4))
  const resistancePu = Number(Math.min(0.08, Math.max(0.003, lengthFactor * 0.014 * voltageFactor * (config.category === 'cable' ? 0.45 : 1))).toFixed(4))
  const weatherExposure = config.category === 'cable'
    ? 'low'
    : config.lengthKm >= 60
      ? 'high'
      : config.lengthKm >= 20
        ? 'medium'
        : 'low'
  return {
    ratingMw,
    emergencyRatingMw: Math.round(ratingMw * 1.18),
    reactancePu,
    resistancePu,
    weatherExposure,
  }
}

export const generatorDefaults = (kind: string, capacityMw: number): {
  readonly availableMw: number
  readonly dispatchMw: number
  readonly targetMw: number
  readonly reserveMw: number
  readonly rampRateMwPerMinute: number
  readonly inertiaSeconds: number
  readonly resourceFraction: number
} => {
  if (kind === 'wind' || kind === 'solar') {
    const resourceFraction = kind === 'wind' ? 0.52 : 0.28
    const availableMw = Math.round(capacityMw * resourceFraction)
    return {
      availableMw,
      dispatchMw: Math.round(availableMw * 0.82),
      targetMw: Math.round(availableMw * 0.86),
      reserveMw: Math.round(capacityMw * 0.05),
      rampRateMwPerMinute: Math.max(8, Math.round(capacityMw * 0.08)),
      inertiaSeconds: 0.8,
      resourceFraction,
    }
  }
  if (kind === 'thermal') {
    return {
      availableMw: Math.round(capacityMw * 0.88),
      dispatchMw: Math.round(capacityMw * 0.62),
      targetMw: Math.round(capacityMw * 0.65),
      reserveMw: Math.round(capacityMw * 0.12),
      rampRateMwPerMinute: Math.max(12, Math.round(capacityMw * 0.08)),
      inertiaSeconds: 4.2,
      resourceFraction: 0.88,
    }
  }
  return {
    availableMw: Math.round(capacityMw * 0.95),
    dispatchMw: Math.round(capacityMw * 0.74),
    targetMw: Math.round(capacityMw * 0.76),
    reserveMw: Math.round(capacityMw * 0.2),
    rampRateMwPerMinute: Math.max(20, Math.round(capacityMw * 0.22)),
    inertiaSeconds: 5.2,
    resourceFraction: 0.72,
  }
}
