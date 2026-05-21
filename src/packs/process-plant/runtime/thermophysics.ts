const clampValue = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

export const specificHeatWaterKjPerKgK = 4.18
export const latentHeatSteamMjPerKg = 2.26

export const heatMwFromWaterFlowAndDeltaT = (
  flowKgPerS: number,
  deltaTemperatureC: number,
): number => Math.max(0, flowKgPerS * specificHeatWaterKjPerKgK * deltaTemperatureC / 1_000)

export const waterDeltaTFromHeatMw = (
  heatMw: number,
  flowKgPerS: number,
): number => heatMw * 1_000 / (Math.max(1, flowKgPerS) * specificHeatWaterKjPerKgK)

export const steamFlowKgPerSFromHeatMw = (heatMw: number): number =>
  Math.max(0, heatMw / latentHeatSteamMjPerKg)

export const saturationTemperatureCFromPressureMPa = (pressureMPa: number): number => {
  const pressure = clampValue(pressureMPa, 0.2, 16)
  return clampValue(100 + 92.5 * Math.log10(pressure * 10), 100, 345)
}

export const energyBalanceTemperatureStep = (config: {
  readonly currentTemperatureC: number
  readonly heatInMw: number
  readonly heatOutMw: number
  readonly dtSeconds: number
  readonly thermalCapacityMjPerK: number
  readonly minTemperatureC: number
  readonly maxTemperatureC: number
}): number => {
  const thermalCapacity = Math.max(1, config.thermalCapacityMjPerK)
  const deltaTemperature = (config.heatInMw - config.heatOutMw) * config.dtSeconds / thermalCapacity
  return clampValue(config.currentTemperatureC + deltaTemperature, config.minTemperatureC, config.maxTemperatureC)
}
