/** Compact LD-01 fuel geometry only: no nuclear coefficients, source solve or
 * fine-partition preparation. Production weights need their own physical law;
 * a uniform material-emission fraction is not a fission-production weight. */
import type { parseFuelConstruction } from './reference-design-fuel-construction'
import { fuelAssemblyPositions, fuelLatticeSites } from './reference-design-fuel-handling'
import type { parseFuelHandling } from './reference-design-fuel-handling'

type Fuel = Pick<ReturnType<typeof parseFuelConstruction>, 'assemblies' | 'latticeSide' | 'pitch_m' |
  'rodsPerAssembly' | 'guidesPerAssembly' | 'rodOuterDiameter_m' | 'guideOuterDiameter_m' |
  'pelletDiameter_m' | 'cladThickness_m' | 'activeLength_m' | 'fuelDensityFraction' |
  'fuelTheoreticalDensity_kg_m3' | 'cladDensity_kg_m3'>
type Handling = Pick<ReturnType<typeof parseFuelHandling>, 'slotRadiusSquared' |
  'seatedBottom_m' | 'bottomFittingLength_m'>

export type Quadrant = { id: string, x0_m: number, x1_m: number, y0_m: number, y1_m: number }
export type OperatingPartition = {
  /** Rectangular axis-quadrant footprint, not a cylindrical-core boundary. */
  quadrants: readonly [Quadrant, Quadrant, Quadrant, Quadrant]
  /** Seven explicit equal-band boundaries. They are spatial, not material cuts. */
  axialBounds_m: readonly [number, number, number, number, number, number, number]
}
export type AssemblyPose = { faId: string, x_m: number, y_m: number, bottom_m: number }
export type OperatingMappingInput = {
  fuel: Fuel, handling: Handling, partition: OperatingPartition,
  /** Complete achieved poses; an omitted assembly is an error, not seated fuel. */
  poses: readonly AssemblyPose[]
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
const overlap = (a: number, b: number, c: number, d: number) => Math.max(0, Math.min(b, d) - Math.max(a, c))
const close = (actual: number, expected: number, label: string) => {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected < 0 || Math.abs(actual - expected) > 2e-11 * expected)
    throw Error('Operating geometry does not close: ' + label)
}

/** Analytic circle/rectangle area. Integration is split at arc/edge crossings;
 * this small geometry primitive does not import or prepare the fine source graph. */
function circleArea(radius: number, x0: number, x1: number, y0: number, y1: number): number {
  const lo = Math.max(-radius, x0), hi = Math.min(radius, x1)
  if (hi <= lo || y1 <= -radius || y0 >= radius || y1 <= y0) return 0
  if (x0 <= -radius && x1 >= radius && y0 <= -radius && y1 >= radius) return Math.PI * radius ** 2
  const cuts = [lo, hi]
  for (const y of [y0, y1]) if (Math.abs(y) < radius) {
    const x = Math.sqrt((radius - y) * (radius + y))
    for (const cut of [-x, x]) if (cut > lo && cut < hi) cuts.push(cut)
  }
  cuts.sort((a, b) => a - b)
  const primitive = (x: number) => .5 * (x * Math.sqrt(Math.max(0, (radius - x) * (radius + x))) + radius ** 2 * Math.asin(x / radius))
  let area = 0
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1]!, b = cuts[i]!, height = Math.sqrt((radius - (a + b) / 2) * (radius + (a + b) / 2))
    if (Math.min(y1, height) <= Math.max(y0, -height)) continue
    const arc = primitive(b) - primitive(a)
    area += (y1 < height ? y1 * (b - a) : arc) - (y0 > -height ? y0 * (b - a) : -arc)
  }
  if (!Number.isFinite(area) || area < 0) throw Error('Invalid analytic fuel intersection')
  return area
}

function validatePartition(partition: OperatingPartition) {
  const { quadrants, axialBounds_m: z } = partition
  if (quadrants.length !== 4 || z.length !== 7 || new Set(quadrants.map(q => q.id)).size !== 4)
    throw Error('Expected four unique quadrants and six axial bands')
  const seen = new Set<string>()
  for (const q of quadrants) {
    if (!q.id || ![q.x0_m, q.x1_m, q.y0_m, q.y1_m].every(Number.isFinite) || q.x0_m >= q.x1_m || q.y0_m >= q.y1_m ||
      !(q.x0_m === 0 || q.x1_m === 0) || !(q.y0_m === 0 || q.y1_m === 0))
      throw Error('Invalid axis quadrant')
    const key = (q.x0_m === 0 ? 'E' : 'W') + (q.y0_m === 0 ? 'N' : 'S')
    if (seen.has(key)) throw Error('Overlapping axis quadrants')
    seen.add(key)
  }
  const x0 = Math.min(...quadrants.map(q => q.x0_m)), x1 = Math.max(...quadrants.map(q => q.x1_m)),
    y0 = Math.min(...quadrants.map(q => q.y0_m)), y1 = Math.max(...quadrants.map(q => q.y1_m))
  if (quadrants.some(q => (q.x0_m < 0 && q.x0_m !== x0) || (q.x1_m > 0 && q.x1_m !== x1) ||
    (q.y0_m < 0 && q.y0_m !== y0) || (q.y1_m > 0 && q.y1_m !== y1)))
    throw Error('Quadrants do not tile one explicit rectangle')
  if (!z.every(Number.isFinite) || !z.every((value, i) => i === 0 || value > z[i - 1]!))
    throw Error('Invalid axial bounds')
  const width = (z[6] - z[0]) / 6
  if (!Number.isFinite(width) || width <= 0) throw Error('Unrepresentable axial bounds')
  for (let i = 1; i <= 6; i++) close(z[i]! - z[i - 1]!, width, 'equal axial bands')
  return { x0, x1, y0, y1 }
}

export function compileOperatingMapping(input: OperatingMappingInput) {
  const { fuel: f, handling: h, partition, poses } = input
  const bounds = validatePartition(partition)
  if (![f.pitch_m, f.rodOuterDiameter_m, f.guideOuterDiameter_m, f.pelletDiameter_m, f.cladThickness_m,
    f.activeLength_m, f.fuelDensityFraction, f.fuelTheoreticalDensity_kg_m3, f.cladDensity_kg_m3, h.bottomFittingLength_m]
    .every(value => Number.isFinite(value) && value > 0) || !Number.isFinite(h.seatedBottom_m) ||
    !Number.isInteger(f.assemblies) || f.assemblies <= 0 || f.fuelDensityFraction > 1 || h.slotRadiusSquared !== 61)
    throw Error('Invalid physical fuel construction')
  const rf = f.pelletDiameter_m / 2, ro = f.rodOuterDiameter_m / 2, ri = ro - f.cladThickness_m
  if (!(rf < ri && ri < ro) || f.rodOuterDiameter_m >= f.pitch_m || f.guideOuterDiameter_m >= f.pitch_m)
    throw Error('Overlapping physical fuel construction')
  const reference = fuelAssemblyPositions(h, f), pins = fuelLatticeSites(f).filter(pin => !pin.guide),
    referenceFuelArea = pins.length * Math.PI * rf ** 2, halfLength = f.activeLength_m / 2,
    fullFuelVolume = referenceFuelArea * halfLength, referenceFuelMass = fullFuelVolume * f.fuelDensityFraction * f.fuelTheoreticalDensity_kg_m3,
    referenceCladMass = pins.length * Math.PI * (ro ** 2 - ri ** 2) * halfLength * f.cladDensity_kg_m3
  if (![referenceFuelArea, fullFuelVolume, referenceFuelMass, referenceCladMass].every(value => Number.isFinite(value) && value > 0))
    throw Error('Unrepresentable physical fuel construction')
  const poseById = new Map<string, AssemblyPose>()
  for (const pose of poses) {
    if (poseById.has(pose.faId) || ![pose.x_m, pose.y_m, pose.bottom_m].every(Number.isFinite))
      throw Error('Invalid or duplicated achieved assembly pose')
    poseById.set(pose.faId, pose)
  }
  if (poses.length !== reference.length || reference.some(fa => !poseById.has(fa.id)))
    throw Error('Missing or unknown achieved assembly identity')

  const regions = partition.quadrants.flatMap((q, sector) => Array.from({ length: 6 }, (_, axialBand) => ({
    ...q, id: q.id + '/band/' + axialBand, sector, axialBand, z0_m: partition.axialBounds_m[axialBand]!,
    z1_m: partition.axialBounds_m[axialBand + 1]!, fuelVolume_m3: 0,
  })))
  const carriers: { id: string, faId: string, index: number, z0_m: number, z1_m: number, fuelVolume_m3: number,
    referenceFuelMass_kg: number, referenceCladMass_kg: number, insideFuelVolume_m3: number,
    outsideFuelVolume_m3: number, outsideEmissionFraction: number }[] = []
  const intersections: { region: number, carrier: number, fuelVolume_m3: number, uniformEmissionFraction: number }[] = []
  const assemblies = reference.map(fa => {
    const pose = poseById.get(fa.id)!
    const areas = partition.quadrants.map(q => sum(pins.map(pin => circleArea(rf,
      q.x0_m - pose.x_m - pin.x, q.x1_m - pose.x_m - pin.x,
      q.y0_m - pose.y_m - pin.y, q.y1_m - pose.y_m - pin.y))))
    // Compute outside geometry directly as disjoint strips. A tiny negative
    // residual is never clipped into a fabricated fully represented material.
    const outsideArea = sum(pins.map(pin => {
      const x0 = bounds.x0 - pose.x_m - pin.x, x1 = bounds.x1 - pose.x_m - pin.x,
        y0 = bounds.y0 - pose.y_m - pin.y, y1 = bounds.y1 - pose.y_m - pin.y
      return circleArea(rf, -rf, x0, -rf, rf) + circleArea(rf, x1, rf, -rf, rf) +
        circleArea(rf, x0, x1, -rf, y0) + circleArea(rf, x0, x1, y1, rf)
    }))
    close(sum(areas) + outsideArea, referenceFuelArea, fa.id + ' transverse fuel area')
    for (let index = 0; index < 2; index++) {
      const z0 = pose.bottom_m + h.bottomFittingLength_m + index * halfLength, z1 = z0 + halfLength,
        insideLength = overlap(z0, z1, partition.axialBounds_m[0], partition.axialBounds_m[6]),
        outsideLength = overlap(z0, z1, z0, partition.axialBounds_m[0]) + overlap(z0, z1, partition.axialBounds_m[6], z1),
        carrier = carriers.length, insideFuelVolume = sum(areas) * insideLength,
        outsideFuelVolume = outsideArea * halfLength + sum(areas) * outsideLength
      close(insideFuelVolume + outsideFuelVolume, fullFuelVolume, fa.id + '/segment/' + index)
      carriers.push({ id: fa.id + '/segment/' + index, faId: fa.id, index, z0_m: z0, z1_m: z1,
        fuelVolume_m3: fullFuelVolume, referenceFuelMass_kg: referenceFuelMass, referenceCladMass_kg: referenceCladMass,
        insideFuelVolume_m3: insideFuelVolume, outsideFuelVolume_m3: outsideFuelVolume,
        outsideEmissionFraction: outsideFuelVolume / fullFuelVolume })
      for (let region = 0; region < regions.length; region++) {
        const r = regions[region]!, volume = areas[r.sector]! * overlap(z0, z1, r.z0_m, r.z1_m)
        if (volume > 0) {
          intersections.push({ region, carrier, fuelVolume_m3: volume, uniformEmissionFraction: volume / fullFuelVolume })
          r.fuelVolume_m3 += volume
        }
      }
    }
    return { ...pose, reference_x_m: fa.x_m, reference_y_m: fa.y_m }
  })
  close(sum(intersections.map(edge => edge.fuelVolume_m3)), sum(carriers.map(carrier => carrier.insideFuelVolume_m3)), 'inside receipts')
  return { assemblies, carriers, regions, intersections,
    totals: { assemblies: assemblies.length, carriers: carriers.length, regions: regions.length, supports: intersections.length,
      fuelVolume_m3: fullFuelVolume * carriers.length, fuelMass_kg: referenceFuelMass * carriers.length,
      activeCladMass_kg: referenceCladMass * carriers.length,
      outsideFuelVolume_m3: sum(carriers.map(carrier => carrier.outsideFuelVolume_m3)) },
    scope: 'Actual vertical, unrotated fuel-pin geometry and two material-half carriers for a rectangular four-quadrant footprint and six equal axial bands. Current positive supports and uniform material emission only; no cylindrical-core or mechanical scene admission, reachable movement union/derivatives, fission-production weights, neutron coefficients, thermal/fluid partition or criticality claim.' }
}
