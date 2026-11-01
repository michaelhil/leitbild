/** R4-NUC-CRITICAL-BORON (plan r4, lead 1 Nov): the critical boron search
 * of the full-power preparation. The prepared coolant boron
 * (`reference-operating-hot` `preparedBoron_ppmEq`) is searched so that the
 * settled loop Tavg, the X4.4 Tavg channel's measurand at the settled state,
 * equals Tref's full-power end, the same measurand at the packet's prepared
 * hot reference. The rods stay at the A1 pose (`achievedRodTravel_m`) and
 * the feedback reference keeps `boronReference_ppmEq`; only the coolant's
 * absorber tracer moves, so the energy package (xenon, samarium, decay
 * stores, precursors) and every replica class are the A1 preparation's.
 *
 * One iterate is: compile the packets at the iterate's boron, S2 settle, S3
 * settle, measure (`water-ffi/tests/critical_boron.rs`). This script is the
 * rule between iterates, deterministic and declared by the wiki's
 * `ld01-critical-boron` block (model/operating-hot-reference.md):
 * - iterate 0 is the A1 boron (`boronReference_ppmEq`); it is never accepted;
 * - iterate 1 steps from iterate 0 on the prior slope dTavg/dc of the
 *   packet's own feedback coefficients (a uniform coolant and fuel shift at
 *   fixed power: water density, the boron it carries and Doppler, over the
 *   regions of the feedback reference);
 * - every later iterate is the secant of the last two;
 * - each iterate's boron is rounded to the block's `rounding_ppmEq`;
 * - the search accepts the first iterate k >= 1 with |Tavg - Tref| within
 *   the block's tolerance (the operator-grade Tavg budget) and refuses after
 *   `maximumIterates` without one. Nothing is clipped or defaulted.
 *
 * Usage: bun reference-design-critical-boron.ts <wiki root> <joined packet>
 *   <history.json>, where the history is `{"iterates":[{"boron_ppmEq":c,
 *   "measurement":<critical_boron.rs record>}, ...]}` in order. Prints the
 *   rule's decision as JSON: `{"next_ppmEq":c}` or `{"accepted":{...}}`. */
import { join } from 'node:path'
import { z } from 'zod'
import { parseOperatingHotReference } from './reference-design-operating-fluid'

const finite = z.number().finite(), positive = finite.positive()
export const criticalBoronSchema = z.object({
  target: z.literal('rodControlTavgMeasurandAtPreparedHotReference'),
  measurand: z.literal('rodControlTavgMeasurandAtSettledS3State'),
  tolerance: z.object({ budgetFraction: positive, uncertaintyFractionOfSpan: positive, span_K: positive }).strict(),
  prior: z.literal('packetFeedbackCoefficientsUniformShift'),
  update: z.literal('secantOfTheLastTwo'),
  rounding_ppmEq: positive,
  maximumIterates: z.number().int().min(2),
}).strict()
export type CriticalBoron = z.infer<typeof criticalBoronSchema>

export const parseCriticalBoron = (text: string) => {
  const blocks = [...text.matchAll(/```ld01-critical-boron\n([\s\S]*?)\n```/g)]
  if (blocks.length !== 1) throw Error(`expected one ld01-critical-boron block, found ${blocks.length}`)
  return criticalBoronSchema.parse(JSON.parse(blocks[0]![1]!))
}

export const toleranceK = (b: CriticalBoron) => b.tolerance.budgetFraction * b.tolerance.uncertaintyFractionOfSpan * b.tolerance.span_K

const packetSchema = z.object({
  feedback_metadata: z.object({
    parameters: z.object({ water_worth: positive, boron_per_ppm_eq: finite.negative(), doppler_per_sqrt_k: finite.negative(),
      domains: z.object({ boron_ppm_eq: z.object({ minimum: finite, maximum: finite }) }).passthrough() }).passthrough(),
  }).passthrough(),
  feedback_reference: z.object({
    fuelTemperature_K: z.array(positive).min(1), waterDensity_kg_m3: z.array(positive).min(2),
    moderatorTemperature_K: z.array(positive).min(2), boron_ppmEq: z.array(finite).min(2),
  }).passthrough(),
}).passthrough()

/** The prior slope dTavg/dc (K per ppm-eq) of the packet's own feedback at
 * its reference: a uniform shift dT of every region's coolant and of the
 * fuel at fixed power, against a change dc of the coolant boron, at zero
 * total reactivity change: `rho_T dT + rho_c dc = 0`. The coolant's
 * expansion is the reference's own between its two temperature bands. */
export function priorSlope(packet: unknown) {
  const p = packetSchema.parse(packet), k = p.feedback_metadata.parameters, r = p.feedback_reference
  const bands = [...new Set(r.moderatorTemperature_K)].sort((a, b) => a - b)
  if (bands.length !== 2) throw Error(`expected two reference coolant temperatures, found ${bands.length}`)
  const density = (T: number) => {
    const d = r.waterDensity_kg_m3.filter((_, i) => r.moderatorTemperature_K[i] === T)
    if (new Set(d).size !== 1) throw Error(`reference coolant at ${T} K has more than one density`)
    return d[0]!
  }
  const [t1, t2] = bands as [number, number], [d1, d2] = [density(t1), density(t2)]
  const expansion = -(d2 - d1) / ((d1 + d2) / 2) / (t2 - t1)
  if (new Set(r.boron_ppmEq).size !== 1) throw Error('the feedback reference boron is not uniform')
  const cref = r.boron_ppmEq[0]!
  const doppler = r.fuelTemperature_K.reduce((a, T) => a + k.doppler_per_sqrt_k / (2 * Math.sqrt(T)), 0) / r.fuelTemperature_K.length
  const rhoT = -k.water_worth * expansion - k.boron_per_ppm_eq * cref * expansion + doppler
  const rhoC = k.boron_per_ppm_eq
  if (!(rhoT < 0)) throw Error(`the packet's isothermal coefficient ${rhoT} is not negative`)
  return { dTavg_dc_K_per_ppmEq: -rhoC / rhoT, rhoT_per_K: rhoT, rhoC_per_ppmEq: rhoC, expansion_per_K: expansion, referenceBoron_ppmEq: cref }
}

const measurementSchema = z.object({ tref_full_power_k: positive, settled_tavg_k: positive, error_k: finite }).passthrough()
export type Iterate = { boron_ppmEq: number, measurement: unknown }

/** The rule's decision after the measured iterates. */
export function decide(block: CriticalBoron, start_ppmEq: number, packet: unknown, iterates: readonly Iterate[]) {
  const tol = toleranceK(block), domain = packetSchema.parse(packet).feedback_metadata.parameters.domains.boron_ppm_eq
  if (iterates.length === 0) throw Error('no iterate: iterate 0 is the A1 boron, measured first')
  if (iterates[0]!.boron_ppmEq !== start_ppmEq) throw Error(`iterate 0 must be the A1 boron ${start_ppmEq}, not ${iterates[0]!.boron_ppmEq}`)
  const points = iterates.map((it, k) => {
    const m = measurementSchema.parse(it.measurement)
    if (m.error_k !== m.settled_tavg_k - m.tref_full_power_k) throw Error(`iterate ${k}: error is not Tavg - Tref`)
    return { k, c: it.boron_ppmEq, e: m.error_k, tref: m.tref_full_power_k, tavg: m.settled_tavg_k }
  })
  if (new Set(points.map(p => p.tref)).size !== 1) throw Error("the iterates' Tref differ: the prepared hot reference moved")
  const accepted = points.find(p => p.k >= 1 && Math.abs(p.e) <= tol)
  if (accepted) return { accepted: { iterate: accepted.k, preparedBoron_ppmEq: accepted.c, settledTavg_K: accepted.tavg, tref_K: accepted.tref, error_K: accepted.e, tolerance_K: tol }, points }
  if (points.length >= block.maximumIterates) throw Error(`no iterate within ${tol} K after ${points.length} iterates: the search refuses`)
  const last = points[points.length - 1]!
  let next: number, slope: number
  if (points.length === 1) {
    slope = priorSlope(packet).dTavg_dc_K_per_ppmEq
  } else {
    const prev = points[points.length - 2]!
    if (last.c === prev.c) throw Error('two iterates at one boron: the secant is undefined')
    slope = (last.e - prev.e) / (last.c - prev.c)
    if (!(slope < 0)) throw Error(`the measured slope ${slope} K/ppm-eq is not negative`)
  }
  next = Math.round((last.c - last.e / slope) / block.rounding_ppmEq) * block.rounding_ppmEq
  next = Number(next.toFixed(Math.max(0, -Math.floor(Math.log10(block.rounding_ppmEq)))))
  if (!(next >= domain.minimum && next <= domain.maximum)) throw Error(`next boron ${next} is outside the feedback domain`)
  if (points.some(p => p.c === next)) throw Error(`next boron ${next} repeats an iterate`)
  return { next_ppmEq: next, slope_K_per_ppmEq: slope, tolerance_K: tol, points }
}

if (import.meta.main) {
  const [wiki, packetPath, historyPath] = process.argv.slice(2)
  if (!wiki || !packetPath || !historyPath) throw Error('usage: <wiki root> <joined packet> <history.json>')
  const page = await Bun.file(join(wiki, 'world/packs/process-plant/reference-designs/ld-01/model/operating-hot-reference.md')).text()
  const block = parseCriticalBoron(page), hot = parseOperatingHotReference(page)
  const packet = JSON.parse(await Bun.file(packetPath).text())
  const history = z.object({ iterates: z.array(z.object({ boron_ppmEq: finite, measurement: z.unknown() }).strict()) }).strict()
    .parse(JSON.parse(await Bun.file(historyPath).text()))
  console.log(JSON.stringify({ rule: 'R4-NUC-CRITICAL-BORON', block, prior: priorSlope(packet), ...decide(block, hot.boronReference_ppmEq, packet, history.iterates) }))
}
