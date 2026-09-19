/** Offline physical CET selection checks. No live instruments or plant runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const fraction = z.number().finite().min(0).max(1)
export const cetBasisSchema = z.object({
  diameter_m: positive, length_m: positive, density_kg_m3: positive,
  heatCapacity_J_kgK: positive, conductivity_W_mK: positive,
  leadDiameter_m: positive, leadLength_m: positive,
  liquidFilm_W_m2K: positive, gasFilm_W_m2K: positive,
  effectiveRadiationFactor: fraction,
  minimumBody_C: z.number().finite(), maximumBody_C: z.number().finite(),
}).strict().refine(b => b.maximumBody_C > b.minimumBody_C, 'Body domain must be ordered')
export type CetBasis = z.infer<typeof cetBasisSchema>

export function parseCetBasis(document: string): CetBasis {
  const matches = [...document.matchAll(/```reference-cet-basis\s*\n([\s\S]*?)\n```/g)]
  if (matches.length !== 1) throw Error('Exactly one reference-cet-basis block required')
  return cetBasisSchema.parse(JSON.parse(matches[0]![1]!))
}

export function cetGeometry(b: CetBasis) {
  const volume = Math.PI * b.diameter_m ** 2 / 4 * b.length_m
  const leadVolume = 2 * Math.PI * b.leadDiameter_m ** 2 / 4 * b.leadLength_m
  const area = Math.PI * b.diameter_m * b.length_m + Math.PI * b.diameter_m ** 2 / 2
  const capacity = (volume + leadVolume) * b.density_kg_m3 * b.heatCapacity_J_kgK
  const leadConductance = b.conductivity_W_mK * leadVolume / b.leadLength_m ** 2
  return { volume_m3: volume, leadVolume_m3: leadVolume, area_m2: area, capacity_J_K: capacity,
    leadConductance_W_K: leadConductance,
    liquidTimeConstant_s: capacity / (b.liquidFilm_W_m2K * area),
    gasTimeConstant_s: capacity / (b.gasFilm_W_m2K * area),
    liquidBiot: b.liquidFilm_W_m2K * volume / area / b.conductivity_W_mK,
    leadHeatBound_W: leadConductance * (b.maximumBody_C - b.minimumBody_C),
    dryLeadBiasBound_K: leadConductance * (b.maximumBody_C - b.minimumBody_C) / (b.gasFilm_W_m2K * area),
    lumpedLeadCapacityFraction: leadVolume / (volume + leadVolume),
  }
}

const absoluteC = z.number().finite().gt(-273.15)
const environmentSchema = z.object({
  liquidExposure: fraction,
  liquid_C: absoluteC.optional(), gas_C: absoluteC.optional(),
  clad: z.array(z.object({ areaWeight: positive, temperature_C: absoluteC }).strict()).min(1),
}).strict().superRefine((e, ctx) => {
  if (e.liquidExposure > 0 && e.liquid_C === undefined) ctx.addIssue({ code: 'custom', message: 'Exposed liquid needs actual temperature' })
  if (e.liquidExposure < 1 && e.gas_C === undefined) ctx.addIssue({ code: 'custom', message: 'Exposed gas needs actual temperature' })
  if (Math.abs(e.clad.reduce((s, c) => s + c.areaWeight, 0) - 1) > 1e-12) ctx.addIssue({ code: 'custom', message: 'Clad weights must sum to one' })
})
export type CetEnvironment = z.infer<typeof environmentSchema>

/** Positive heat enters the probe. Receiver entries debit the actual finite owners. */
export function cetHeat(b: CetBasis, body_C: number, input: CetEnvironment) {
  const e = environmentSchema.parse(input)
  if (!Number.isFinite(body_C) || body_C < b.minimumBody_C || body_C > b.maximumBody_C) throw Error('Probe left its selected material/model domain')
  const a = cetGeometry(b).area_m2, w = e.liquidExposure
  const liquid = w === 0 ? 0 : a * w * b.liquidFilm_W_m2K * (e.liquid_C! - body_C)
  const gas = w === 1 ? 0 : a * (1 - w) * b.gasFilm_W_m2K * (e.gas_C! - body_C)
  const radiation = e.clad.map(c => a * (1 - w) * b.effectiveRadiationFactor * 5.670374419e-8
    * c.areaWeight * ((c.temperature_C + 273.15) ** 4 - (body_C + 273.15) ** 4))
  return { probe_W: liquid + gas + radiation.reduce((s, q) => s + q, 0),
    liquid_W: -liquid, gas_W: -gas, clad_W: radiation.map(q => -q) }
}

/** Analytic prescribed-bath comparison, not an advancing finite-fluid calculation. */
export function cetBathResponse(b: CetBasis, initial_C: number, bath_C: number, seconds: number, liquid: boolean) {
  if (![initial_C, bath_C, seconds].every(Number.isFinite) || seconds < 0) throw Error('Invalid bath comparison')
  const g = cetGeometry(b), tau = liquid ? g.liquidTimeConstant_s : g.gasTimeConstant_s
  return bath_C + (initial_C - bath_C) * Math.exp(-seconds / tau)
}

/** Unique equilibrium of monotone heat law within the declared body envelope. */
export function cetEquilibrium(b: CetBasis, environment: CetEnvironment) {
  let low = b.minimumBody_C, high = b.maximumBody_C
  if (cetHeat(b, low, environment).probe_W < 0 || cetHeat(b, high, environment).probe_W > 0) throw Error('Equilibrium outside body domain')
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2
    if (cetHeat(b, mid, environment).probe_W > 0) low = mid
    else high = mid
  }
  return (low + high) / 2
}

export function cetComparison(b: CetBasis) {
  const dry = { liquidExposure: 0, gas_C: 300, clad: [{ areaWeight: 1, temperature_C: 700 }] }
  const wet = { liquidExposure: 1, liquid_C: 100, clad: [{ areaWeight: 1, temperature_C: 700 }] }
  return { geometry: cetGeometry(b), prescribedBath: [10, 60, 300].map(seconds => ({ seconds,
    liquid_C: cetBathResponse(b, 100, 300, seconds, true), gas_C: cetBathResponse(b, 100, 300, seconds, false) })),
    dryHotCladEquilibrium_C: cetEquilibrium(b, dry), wetHotCladEquilibrium_C: cetEquilibrium(b, wet),
    sensitivity: [.5, 1, 2].flatMap(filmFactor => [0, .03, .09].map(effectiveRadiationFactor => {
      const s = { ...b, liquidFilm_W_m2K: b.liquidFilm_W_m2K * filmFactor,
        gasFilm_W_m2K: b.gasFilm_W_m2K * filmFactor, effectiveRadiationFactor }
      return { filmFactor, effectiveRadiationFactor, gasTimeConstant_s: cetGeometry(s).gasTimeConstant_s,
        liquidBiot: cetGeometry(s).liquidBiot, dryEquilibrium_C: cetEquilibrium(s, dry) }
    })), connectedCoreQualified: false }
}

if (import.meta.main) {
  const [ownerPath, receiptPath] = process.argv.slice(2)
  if (!ownerPath || !receiptPath) throw Error('Usage: reference-design-cet.ts phase-dependent-measurements.md receipt.json')
  const document = await Bun.file(ownerPath).text(), source = await Bun.file(import.meta.path).text()
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const basis = parseCetBasis(document)
  const receipt = { sourceSha256: hash(source), documentSha256: hash(document), basis, ...cetComparison(basis) }
  await Bun.write(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt))
}
