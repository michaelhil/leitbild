/** Sensible-energy mixing for a finite, insulated, constant-cp liquid volume.
 * Outflow leaves at the volume's current temperature; incoming liquid then
 * mixes into what remains. No flow carries no energy and cannot reset it. */
export const mixedLiquidTemperatureStep = (input: {
  readonly inventoryKg: number
  readonly temperatureC: number
  readonly inflowKgPerS: number
  readonly inflowThermalRateKgCPerS: number
  readonly outflowKgPerS: number
  readonly dtSeconds: number
}): number => {
  const remaining = Math.max(0, input.inventoryKg - input.outflowKgPerS * input.dtSeconds)
  const next = remaining + input.inflowKgPerS * input.dtSeconds
  return next > 0
    ? (remaining * input.temperatureC + input.inflowThermalRateKgCPerS * input.dtSeconds) / next
    : input.temperatureC
}
