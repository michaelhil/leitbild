export const firstOrderLag = (config: {
  readonly current: number
  readonly target: number
  readonly dtSeconds: number
  readonly timeConstantSeconds: number
}): number => {
  const timeConstant = Math.max(1e-9, config.timeConstantSeconds)
  const fraction = Math.max(0, Math.min(1, config.dtSeconds / timeConstant))
  return config.current + (config.target - config.current) * fraction
}

export const boundedApproach = (config: {
  readonly current: number
  readonly target: number
  readonly maxDelta: number
}): number => {
  if (Math.abs(config.target - config.current) <= config.maxDelta) return config.target
  return config.current + Math.sign(config.target - config.current) * config.maxDelta
}

export const inventoryBalanceStep = (config: {
  readonly currentInventory: number
  readonly inflowKgPerS: number
  readonly outflowKgPerS: number
  readonly dtSeconds: number
  readonly minInventory: number
  readonly maxInventory: number
}): number => {
  const next = config.currentInventory + (config.inflowKgPerS - config.outflowKgPerS) * config.dtSeconds
  return Math.max(config.minInventory, Math.min(config.maxInventory, next))
}

export const pumpHeadResistanceFlowTarget = (config: {
  readonly developedHeadPa: number
  readonly nominalHeadPa: number
  readonly nominalFlowKgPerS: number
  readonly resistanceCoefficient: number
  readonly minimumFlowKgPerS: number
}): number => {
  const headRatio = Math.max(0, config.developedHeadPa) / Math.max(1, config.nominalHeadPa)
  const resistanceFactor = 1 + Math.max(0, config.resistanceCoefficient)
  const hydraulicFlow = config.nominalFlowKgPerS * Math.sqrt(headRatio / resistanceFactor)
  return Math.max(config.minimumFlowKgPerS, hydraulicFlow)
}

export const pressureDropMPaFromFlow = (config: {
  readonly flowKgPerS: number
  readonly nominalFlowKgPerS: number
  readonly nominalPressureDropMPa: number
  readonly resistanceMultiplier?: number
}): number => {
  const flowRatio = Math.max(0, config.flowKgPerS) / Math.max(1, config.nominalFlowKgPerS)
  const resistanceMultiplier = config.resistanceMultiplier ?? 1
  return Math.max(0, config.nominalPressureDropMPa) * Math.max(0, resistanceMultiplier) * flowRatio * flowRatio
}

export const pressureDrivenLeakFlowKgPerS = (config: {
  readonly areaFraction: number
  readonly pressureDeltaMPa: number
  readonly coefficientKgPerSPerSqrtMPa: number
}): number =>
  Math.max(0, Math.min(1, config.areaFraction))
  * Math.max(0, config.coefficientKgPerSPerSqrtMPa)
  * Math.sqrt(Math.max(0, config.pressureDeltaMPa))
