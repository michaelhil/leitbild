/** Shared initial thermal state and neutral-feedback reference. Keep these
 * consistent when an operating point changes initial power or temperature. */
export const reactorInitialThermalState = (parameters: Readonly<Record<string, unknown>>) => {
  const inlet = Number(parameters.initialCoolantInletTemperatureC ?? 290)
  const outlet = inlet + 32
  const rise = Number(parameters.fuelTemperatureRiseAtRatedPowerC ?? 140) * Number(parameters.initialPowerFraction)
  const lower = outlet + rise * 0.88
  const mid = outlet + rise * 1.08
  const upper = outlet + rise
  return { inlet, outlet, lower, mid, upper, average: (lower + mid + upper) / 3 }
}
