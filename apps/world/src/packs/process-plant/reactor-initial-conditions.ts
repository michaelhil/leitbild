import { waterDeltaTFromHeatMw } from './runtime/thermophysics.ts'

/** Shared initial thermal state and neutral-feedback reference. Keep these
 * consistent when an operating point changes initial power or temperature. */
export const reactorInitialThermalState = (parameters: Readonly<Record<string, unknown>>) => {
  const inlet = Number(parameters.initialCoolantInletTemperatureC ?? 290)
  const thermalFraction = Number(parameters.initialPowerFraction) * (1 + Number(parameters.decayHeatFractionAtPower ?? 0.06))
  const outlet = inlet + waterDeltaTFromHeatMw(Number(parameters.ratedPowerMw) * thermalFraction, Number(parameters.nominalPrimaryFlowKgPerS ?? 17_000))
  const rise = Number(parameters.fuelTemperatureRiseAtRatedPowerC ?? 140) * thermalFraction
  const lower = outlet + rise * 0.88
  const mid = outlet + rise * 1.08
  const upper = outlet + rise
  return { inlet, outlet, lower, mid, upper, average: (lower + mid + upper) / 3 }
}
