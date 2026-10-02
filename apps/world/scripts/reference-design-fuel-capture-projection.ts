/** Offline LD-01 constitutive comparison; not a live source/thermal runtime. */
export type FuelThermalWeight = { referenceFuelMass_kg: number; temperature_K: number }

/** One immutable material segment, excluding cladding, gas and water.
 * Reference masses include the thermal owner's axial integration weights.
 * Geometry/field incidence and remaining-target scaling are separate inputs.
 */
export function fuelCaptureMultiplier(weights: readonly FuelThermalWeight[], fD = 1) {
  if (!weights.length || !Number.isFinite(fD) || fD < 0 || fD > 1)
    throw new Error('Invalid LD-01 fuel capture projection')
  let mass = 0, response = 0
  for (const w of weights) {
    if (!Number.isFinite(w.referenceFuelMass_kg) || w.referenceFuelMass_kg <= 0
      || !Number.isFinite(w.temperature_K) || w.temperature_K < 290 || w.temperature_K > 2000)
      throw new Error('Fuel weight or temperature outside selected material domain')
    mass += w.referenceFuelMass_kg
    response += w.referenceFuelMass_kg * Math.sqrt(w.temperature_K / 300)
  }
  if (!Number.isFinite(mass) || !Number.isFinite(response))
    throw new Error('Nonfinite fuel capture projection sum')
  const meanSquareRoot = response / mass
  return { meanSquareRoot, captureMultiplier: 1 + fD * (meanSquareRoot - 1) }
}
