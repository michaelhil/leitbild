/** The controlled-spray path section (`pzrSpray`) for the joined spine: the
 * line, its valve and actuator, and the distributor, from their owners'
 * strict wiki blocks, unchanged or derived by stated arithmetic. Rust owns
 * every law (`operating/src/control/spray_valve.rs`); this compiler reads,
 * checks and composes.
 *
 * - `ld01-pzr-spray-line`: source region, route elevations, length, bore,
 *   wall, roughness, stroke rate, inlet check, and the valve passage's
 *   low-Reynolds transition (R4-PZR-SPRAY-LAMINAR, judgement);
 * - `ld01-pzr-spray-port`: the distributor's aggregate effective area and
 *   the entry elevation, which must be the line's outlet;
 * - `reference-pressurizer-normal-thermal`: the valve's sizing point
 *   (20 kg/s at 0.20 MPa) and the line length and bore it was sized on,
 *   which must agree with the line block;
 * - `reference-spray-operating-scale`: the sizing density.
 *
 * The valve's full-reference area follows as `CdA_full = m / sqrt(2 rho dp)`
 * (pressure-and-inventory.md prints 0.0011584536025922127 m2). The line is
 * one coarse region on two half-line phase paths (the surge line's
 * pattern): each half carries half the length and volume and its elevation
 * change; the valve acts on the first, the distributor on the second.
 * Restriction losses are on the line area: `K = (A / CdA)^2`.
 *
 * Usage: bun reference-design-operating-pzr-spray.ts <wiki root> */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { ownedBlock } from './reference-design-operating-pzr'
import { equipmentOwners, parsePzrSpray } from './reference-design-operating-pzr-cases'

export const pzrSprayOwners = {
  line: { page: 'systems/primary-coolant/pressure-and-inventory.md', heading: 'Controlled-spray material path', fence: 'ld01-pzr-spray-line' },
  port: equipmentOwners.spray,
  sizing: { page: 'systems/primary-coolant/pressurizer-thermal-state.md', heading: 'Normal circulation and required thermal duty', fence: 'reference-pressurizer-normal-thermal' },
  density: { page: 'operations/procedure-decision-basis.md', heading: 'Attended primary-pressure reduction', fence: 'reference-spray-operating-scale' },
} as const

const positive = z.number().finite().positive()
const lineSchema = z.object({ sourceRegion: z.string().min(1), inletElevation_m: z.number().finite(), outletElevation_m: z.number().finite(),
  developedLength_m: positive, insideDiameter_m: positive, wallThickness_m: positive, roughness_m: positive,
  valveStrokesPerSecond: positive, inletCheck: z.literal('ideal-one-way'), valveLowReynoldsTransition: positive }).strict()
const sizingSchema = z.object({ sprayReferenceFlow_kg_s: positive, sprayReferenceDifferential_Pa: positive,
  sprayLength_m: positive, sprayInsideDiameter_m: positive, sprayWallThickness_m: positive }).passthrough()
const densitySchema = z.object({ sourceDensity_kg_m3: positive }).passthrough()

export type PzrSprayPages = Record<keyof typeof pzrSprayOwners, string>

/** The `pzrSpray` section from the owners' page texts. */
export function compileOperatingPzrSpray(pages: PzrSprayPages) {
  const o = pzrSprayOwners
  const line = lineSchema.parse(ownedBlock(pages.line, o.line.heading, o.line.fence))
  const port = parsePzrSpray(pages.port)
  const sizing = sizingSchema.parse(ownedBlock(pages.sizing, o.sizing.heading, o.sizing.fence))
  const { sourceDensity_kg_m3: rho } = densitySchema.parse(ownedBlock(pages.density, o.density.heading, o.density.fence))
  if (line.outletElevation_m !== port.elevation_m) throw Error(`The line ends at ${line.outletElevation_m} m, the spray entry is at ${port.elevation_m} m`)
  if (!(line.outletElevation_m > line.inletElevation_m)) throw Error('The controlled line rises from its source to the spray entry')
  if (line.developedLength_m !== sizing.sprayLength_m || line.insideDiameter_m !== sizing.sprayInsideDiameter_m || line.wallThickness_m !== sizing.sprayWallThickness_m)
    throw Error('The line block disagrees with the line the valve was sized on')
  const rise = line.outletElevation_m - line.inletElevation_m
  if (rise > line.developedLength_m) throw Error('A straight-equivalent line cannot rise more than its length')
  const area = Math.PI * line.insideDiameter_m ** 2 / 4, volume = area * line.developedLength_m
  const valveFull = sizing.sprayReferenceFlow_kg_s / Math.sqrt(2 * rho * sizing.sprayReferenceDifferential_Pa)
  const distributorLoss = (area / port.aggregateEffectiveArea_m2) ** 2
  const half = line.developedLength_m / 2
  const halves = [
    { face: `${line.sourceRegion}->SPRAY`, from: line.sourceRegion, to: 'SPRAY', length_m: half, inverseAreaLength_per_m: half / area,
      volume_m3: volume / 2, elevationChange_m: rise / 2, formLoss: 0, restriction: 'valve' as const },
    { face: 'SPRAY->PZR.SPRAY', from: 'SPRAY', to: 'PZR.SPRAY', length_m: half, inverseAreaLength_per_m: half / area,
      volume_m3: volume / 2, elevationChange_m: rise / 2, formLoss: distributorLoss, restriction: 'distributor' as const },
  ]
  return {
    source: line.sourceRegion,
    line: { length_m: line.developedLength_m, insideDiameter_m: line.insideDiameter_m, area_m2: area, volume_m3: volume,
      inletElevation_m: line.inletElevation_m, outletElevation_m: line.outletElevation_m,
      // A uniform straight rise: the volume centroid is the mid elevation.
      centroidElevation_m: (line.inletElevation_m + line.outletElevation_m) / 2,
      wallThickness_m: line.wallThickness_m, roughness_m: line.roughness_m, wall: 'circular_churchill' as const },
    halves,
    valve: { face: halves[0]!.face, fullEffectiveArea_m2: valveFull, fullOpenFormLoss: (area / valveFull) ** 2,
      strokesPerSecond: line.valveStrokesPerSecond, inletCheck: line.inletCheck, lowReynoldsTransition: line.valveLowReynoldsTransition,
      sizing: { flow_kg_s: sizing.sprayReferenceFlow_kg_s, differential_Pa: sizing.sprayReferenceDifferential_Pa, density_kg_m3: rho } },
    distributor: { face: halves[1]!.face, aggregateEffectiveArea_m2: port.aggregateEffectiveArea_m2, elevation_m: port.elevation_m, formLoss: distributorLoss },
  }
}

export async function prepareOperatingPzrSpray(wiki: string) {
  const base = join(wiki, 'world/packs/process-plant/reference-designs/ld-01')
  const names = Object.entries(pzrSprayOwners) as [keyof typeof pzrSprayOwners, { page: string, fence: string }][]
  const pages = Object.fromEntries(await Promise.all(names.map(async ([k, o]) => [k, await Bun.file(join(base, o.page)).text()]))) as PzrSprayPages
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { ...compileOperatingPzrSpray(pages), provenance: {
    consumed: names.map(([k, o]) => ({ page: o.page, fence: o.fence, sha256: hash(pages[k]) })),
    sourceSha256: hash(await Bun.file(import.meta.path).text()) } }
}

if (import.meta.main) {
  const [wiki] = Bun.argv.slice(2)
  if (!wiki || Bun.argv.length !== 3) throw Error('Usage: operating-pzr-spray <wiki root>')
  console.log(JSON.stringify(await prepareOperatingPzrSpray(wiki)))
}
