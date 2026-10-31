/** A finite tube-metal store between the primary and boiling secondary.
 * Bound the actual energy exchanged in a step, rather than clipping the
 * resulting temperature and silently creating/discarding stored heat. */
export const finiteSteamGeneratorMetalRates = (input: {
  readonly metalTemperatureC: number
  readonly primaryTemperatureC: number
  readonly secondaryTemperatureC: number
  readonly capacityMjPerC: number
  readonly primaryRequestedMw: number
  readonly secondaryRequestedMw: number
  readonly evaporationCapacityMw: number
  readonly dtSeconds: number
}) => {
  const coldStockRate = input.dtSeconds > 0
    ? input.capacityMjPerC * Math.max(0, input.metalTemperatureC - input.secondaryTemperatureC) / input.dtSeconds
    : input.metalTemperatureC > input.secondaryTemperatureC ? Number.POSITIVE_INFINITY : 0
  const secondaryMw = Math.max(0, Math.min(input.secondaryRequestedMw, input.evaporationCapacityMw, input.primaryRequestedMw + coldStockRate))
  const hotRoomRate = input.dtSeconds > 0
    ? input.capacityMjPerC * Math.max(0, input.primaryTemperatureC - input.metalTemperatureC) / input.dtSeconds
    : input.primaryTemperatureC > input.metalTemperatureC ? Number.POSITIVE_INFINITY : 0
  const primaryMw = Math.max(0, Math.min(input.primaryRequestedMw, secondaryMw + hotRoomRate))
  return { primaryMw, secondaryMw }
}
