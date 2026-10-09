/** Actual finite hot-reference material/event inputs. No plant integrator,
 * isotope-chain framework, photon transport or fine-model preparation. */
import { z } from 'zod'
import { compileDecayHistory, type DecayHistoryRecord } from './reference-design-decay-history'
import type { compileOperatingMapping } from './reference-design-operating-mapping'
import { operatingReferenceFissions, operatingSourceFreshFuelAtoms, type OperatingSourceCoefficients } from './reference-design-operating-source'

const positive = z.number().finite().positive(), nonnegative = z.number().finite().nonnegative()
const schema = z.object({
  identity: z.literal('LD01-HOT-ENERGY-1'), preparationDuration_s: positive,
  fertileCapture_barn: positive, fertileBinding_MeV: positive, xenonBinding_MeV: positive,
  samariumBinding_MeV: positive, bindingCoolantFraction: nonnegative.max(1),
  bindingCoolantSensitivity: z.tuple([nonnegative.max(1), nonnegative.max(1), nonnegative.max(1)]),
  promptFissionCoolantFraction: nonnegative.max(1),
  promptFissionCoolantSensitivity: z.tuple([nonnegative.max(1), nonnegative.max(1), nonnegative.max(1)]),
}).strict()
export type OperatingEnergyCoefficients = z.infer<typeof schema>
export function parseOperatingEnergy(document: string): OperatingEnergyCoefficients {
  const blocks = [...document.matchAll(/^```reference-operating-energy\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-operating-energy block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
const MeV_J = 1.602176634e-13
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0)

/** ∫exp(-a(t-s))exp(-b s)ds. Stable for equal rates and long ages. */
export function exponentialConvolution(a: number, b: number, seconds: number): number {
  if (![a, b, seconds].every(v => Number.isFinite(v) && v >= 0)) throw Error('Invalid finite preparation age/rate')
  const d = Math.abs(a - b)
  return Math.exp(-Math.min(a, b) * seconds) * (d === 0 ? seconds : -Math.expm1(-d * seconds) / d)
}

/** Low-burnup solution of x exp(-x)=F_end*t/N_original. The high-burnup
 * second solution is deliberately not an implicit alternative initializer. */
function burnupExponent(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1 / Math.E) throw Error('Infeasible low-burnup finite preparation')
  let lo = 0, hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (mid * Math.exp(-mid) < ratio) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Two finite linear parent/daughter stocks, zero ORIGINAL inventories and
 * an exponentially decreasing fission feed. Selected burnup rate is far
 * slower than the physical parent decay: reject outside that admitted chart. */
function finitePoisonPair(f0: number, mu: number, seconds: number, parentYield: number,
  daughterYield: number, parentDecay: number, daughterLoss: number): [number, number] {
  if (!(mu < .01 * parentDecay)) throw Error('Preparation outside slow-burnup poison chart')
  const parent = parentYield * f0 * exponentialConvolution(parentDecay, mu, seconds)
  const daughter = daughterYield * f0 * exponentialConvolution(daughterLoss, mu, seconds) +
    parentDecay * parentYield * f0 / (parentDecay - mu) *
    (exponentialConvolution(daughterLoss, mu, seconds) - exponentialConvolution(daughterLoss, parentDecay, seconds))
  if (![parent, daughter].every(v => Number.isFinite(v) && v >= 0)) throw Error('Unrepresentable finite poison history')
  return [parent, daughter]
}

export function prepareOperatingEnergy(mapping: ReturnType<typeof compileOperatingMapping>,
  source: OperatingSourceCoefficients, supplied: OperatingEnergyCoefficients, history: DecayHistoryRecord) {
  const coefficients = schema.parse(supplied), kernel = compileDecayHistory(history),
    fresh = operatingSourceFreshFuelAtoms(mapping, source), reference = operatingReferenceFissions(mapping, source),
    sigmaF = source.effectiveFission_barn * 1e-28, sigmaC = coefficients.fertileCapture_barn * 1e-28,
    seconds = coefficients.preparationDuration_s,
    lambda = [source.iodineHalfLife_s, source.xenonHalfLife_s, source.promethiumHalfLife_s].map(t => Math.LN2 / t),
    nuDelayed = source.delayedFractions.map(beta => beta * source.nuEffective),
    precursorLambda = source.delayedHalfLives_s.map(t => Math.LN2 / t)
  const carriers = mapping.carriers.map((carrier, a) => {
    const x = burnupExponent(reference.carriers[a]! * seconds / fresh.fissile[a]!), muF = x / seconds,
      exposure = muF / sigmaF, muC = sigmaC * exposure,
      fissile = fresh.fissile[a]! * Math.exp(-x), fertile = fresh.fertile[a]! * Math.exp(-muC * seconds),
      f0 = muF * fresh.fissile[a]!, c0 = muC * fresh.fertile[a]!,
      fissions = sigmaF * exposure * fissile, captures = sigmaC * exposure * fertile,
      spentFissions = fresh.fissile[a]! * -Math.expm1(-x),
      captureProduct = fresh.fertile[a]! * -Math.expm1(-muC * seconds),
      stores = kernel.groups.map(g => g.energy_J_per_event * (g.feed === 'fission' ? f0 : c0) *
        exponentialConvolution(g.lambda_s_inv, g.feed === 'fission' ? muF : muC, seconds)),
      precursors = nuDelayed.map((nu, g) => nu * f0 * exponentialConvolution(precursorLambda[g]!, muF, seconds)),
      [iodine, xenon] = finitePoisonPair(f0, muF, seconds, source.directIodine_per_fission,
        source.directXenon_per_fission, lambda[0]!, lambda[1]! + source.effectiveXeCapture_barn * 1e-28 * exposure),
      [promethium, samarium] = finitePoisonPair(f0, muF, seconds, source.directPromethium_per_fission,
        0, lambda[2]!, source.effectiveSmCapture_barn * 1e-28 * exposure),
      xenonCaptures = source.effectiveXeCapture_barn * 1e-28 * exposure * xenon,
      samariumCaptures = source.effectiveSmCapture_barn * 1e-28 * exposure * samarium,
      xenonLoss = lambda[1]! + source.effectiveXeCapture_barn * 1e-28 * exposure,
      integratedXenon = ((source.directIodine_per_fission + source.directXenon_per_fission) * spentFissions - iodine - xenon) / xenonLoss,
      xenonCaptureProductAtoms = source.effectiveXeCapture_barn * 1e-28 * exposure * integratedXenon,
      samariumCaptureProductAtoms = source.directPromethium_per_fission * spentFissions - promethium - samarium,
      promptFission_W = kernel.promptFissionEnergy_J * fissions,
      history_W = sum(stores.map((E, g) => kernel.groups[g]!.lambda_s_inv * E)),
      binding_W = MeV_J * (coefficients.fertileBinding_MeV * captures + coefficients.xenonBinding_MeV * xenonCaptures +
        coefficients.samariumBinding_MeV * samariumCaptures),
      coolant_W = coefficients.bindingCoolantFraction * binding_W + coefficients.promptFissionCoolantFraction * promptFission_W,
      fuel_W = (1 - coefficients.promptFissionCoolantFraction) * promptFission_W + history_W + (1 - coefficients.bindingCoolantFraction) * binding_W,
      // These are original-event receipts, not an extra state or retained heat.
      fissionEnergyCreated_J = history.fissionEnergy_MeV * MeV_J * spentFissions,
      fertileEnergyCreated_J = MeV_J * (coefficients.fertileBinding_MeV + sum(history.effectiveCaptureEnergy_MeV)) * captureProduct,
      poisonBindingCreated_J = MeV_J * (coefficients.xenonBinding_MeV * xenonCaptureProductAtoms +
        coefficients.samariumBinding_MeV * samariumCaptureProductAtoms),
      preparationReleased_J = fissionEnergyCreated_J + fertileEnergyCreated_J + poisonBindingCreated_J - sum(stores)
    if (![fissile, fertile, ...stores, ...precursors, fuel_W, coolant_W, xenonCaptureProductAtoms,
      samariumCaptureProductAtoms, preparationReleased_J].every(v => Number.isFinite(v) && v >= 0))
      throw Error('Invalid finite hot material preparation')
    return { id: carrier.id, originalFissileAtoms: fresh.fissile[a]!, originalFertileAtoms: fresh.fertile[a]!,
      fissileAtoms: fissile, fertileAtoms: fertile, spentFissions, captureProductAtoms: captureProduct,
      exposure_per_m2_s: exposure, fissions_per_s: fissions, fertileCaptures_per_s: captures,
      xenonCaptures_per_s: xenonCaptures, samariumCaptures_per_s: samariumCaptures,
      iodineAtoms: iodine, xenonAtoms: xenon, promethiumAtoms: promethium, samariumAtoms: samarium,
      xenonCaptureProductAtoms, samariumCaptureProductAtoms,
      stores_J: stores, precursors, promptFission_W, history_W, binding_W, fuel_W, coolant_W,
      preparationReleased_J }
  })
  const coolantByRegion_W = mapping.regions.map(() => 0)
  for (const e of mapping.intersections) coolantByRegion_W[e.region]! += carriers[e.carrier]!.coolant_W * e.uniformEmissionFraction
  const coolantExport_W = sum(carriers.map((c, a) => c.coolant_W * mapping.carriers[a]!.outsideEmissionFraction))
  return { identity: coefficients.identity, coefficients, history: kernel, carriers, coolantByRegion_W, coolantExport_W,
    totalFuel_W: sum(carriers.map(c => c.fuel_W)), totalCoolant_W: sum(coolantByRegion_W),
    totalDeposited_W: sum(carriers.map(c => c.fuel_W)) + sum(coolantByRegion_W),
    referenceFissions_per_s: sum(carriers.map(c => c.fissions_per_s)),
    referenceFertileCaptures_per_s: sum(carriers.map(c => c.fertileCaptures_per_s)),
    // A separately supplied preparation boundary exported already released heat.
    // The hot thermal stocks are NOT claimed to integrate this 30-day recipe.
    preparationExport_J: sum(carriers.map(c => c.preparationReleased_J)),
    scope: 'Analytic finite prescribed-exposure preparation and actual material/event inputs, not achieved irradiation, plant equilibrium, isotope assay, photon transport or whole-plant heat qualification.' }
}
