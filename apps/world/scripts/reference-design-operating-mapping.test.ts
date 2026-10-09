import { describe, expect, test } from 'bun:test'
import { fuelAssemblyPositions } from './reference-design-fuel-handling'
import { compileOperatingMapping, type OperatingMappingInput } from './reference-design-operating-mapping'

// Exact selected physical construction, tested independently of the retained
// fine partition fixture. The batch additionally replays the current wiki owners.
const fuel: OperatingMappingInput['fuel'] = {
  assemblies: 193, latticeSide: 17, rodsPerAssembly: 264, guidesPerAssembly: 25, pitch_m: .0126,
  rodOuterDiameter_m: .0095, cladThickness_m: .00057, pelletDiameter_m: .0082, guideOuterDiameter_m: .0122,
  activeLength_m: 4, fuelDensityFraction: .95, fuelTheoreticalDensity_kg_m3: 10960, cladDensity_kg_m3: 6551,
}
const handling: OperatingMappingInput['handling'] = { slotRadiusSquared: 61, seatedBottom_m: -2.25, bottomFittingLength_m: .25 }
const partition: OperatingMappingInput['partition'] = {
  quadrants: [
    { id: 'NE', x0_m: 0, x1_m: 1.85, y0_m: 0, y1_m: 1.85 },
    { id: 'NW', x0_m: -1.85, x1_m: 0, y0_m: 0, y1_m: 1.85 },
    { id: 'SW', x0_m: -1.85, x1_m: 0, y0_m: -1.85, y1_m: 0 },
    { id: 'SE', x0_m: 0, x1_m: 1.85, y0_m: -1.85, y1_m: 0 },
  ], axialBounds_m: [-2, -4 / 3, -2 / 3, 0, 2 / 3, 4 / 3, 2],
}
const poses = fuelAssemblyPositions(handling, fuel).map(fa => ({ faId: fa.id, x_m: fa.x_m, y_m: fa.y_m, bottom_m: handling.seatedBottom_m }))
const input: OperatingMappingInput = { fuel, handling, partition, poses }
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
const moved = (faId: string, change: Partial<OperatingMappingInput['poses'][number]>) => compileOperatingMapping({ ...input,
  poses: poses.map(pose => pose.faId === faId ? { ...pose, ...change } : pose) })

describe('compact actual fuel mapping', () => {
  test('193 identities and 386 actual half carriers produce the literal 24-region incidence', () => {
    const result = compileOperatingMapping(input)
    expect(result.totals.assemblies).toBe(193); expect(result.totals.carriers).toBe(386)
    expect(result.totals.regions).toBe(24); expect(result.intersections).toHaveLength(1344)
    expect(new Set(result.assemblies.map(fa => fa.faId)).size).toBe(193)
    expect(new Set(result.carriers.map(carrier => carrier.id)).size).toBe(386)
    expect(new Set(result.regions.map(region => region.id)).size).toBe(24)
    expect(result.totals.outsideFuelVolume_m3).toBe(0)
    const exactFuelVolume = 193 * 264 * Math.PI * (.0082 / 2) ** 2 * 4
    expect(result.totals.fuelVolume_m3).toBeCloseTo(exactFuelVolume, 12)
    expect(result.totals.fuelMass_kg).toBeCloseTo(exactFuelVolume * .95 * 10960, 8)
    expect(sum(result.regions.map(region => region.fuelVolume_m3))).toBeCloseTo(exactFuelVolume, 12)
    for (const carrier of result.carriers) {
      const own = result.intersections.filter(edge => result.carriers[edge.carrier] === carrier)
      expect(sum(own.map(edge => edge.uniformEmissionFraction)) + carrier.outsideEmissionFraction).toBeCloseTo(1, 13)
    }
    // Conditional fixed-coefficient N24 + C(386*6) structure only. Production
    // and emission each have six cross entries per literal support; diagonal
    // production losses reuse the N diagonal. Feedback adds actual positions.
    expect(24 + 386 * 6).toBe(2340)
    expect(24 + 88 + 386 * 6 + 2 * result.intersections.length * 6).toBe(18556)
  })

  test('axis material divides by actual pins and preserves asymmetric carrier identity', () => {
    const result = compileOperatingMapping(input), central = result.assemblies.find(fa => fa.x_m === 0 && fa.y_m === 0)!,
      axis = result.assemblies.find(fa => fa.x_m > 0 && fa.y_m === 0)!,
      away = result.assemblies.find(fa => fa.x_m > 0 && fa.y_m > 0)!
    for (const [fa, sectors] of [[central, 4], [axis, 2], [away, 1]] as const) {
      const carrier = result.carriers.findIndex(c => c.faId === fa.faId && c.index === 0),
        edges = result.intersections.filter(edge => edge.carrier === carrier)
      expect(edges).toHaveLength(sectors * 3)
      for (const edge of edges) expect(edge.uniformEmissionFraction).toBeCloseTo(1 / (sectors * 3), 13)
    }
    const translated = moved(central.faId, { x_m: .002 }),
      own = translated.intersections.filter(edge => translated.carriers[edge.carrier]!.faId === central.faId),
      east = sum(own.filter(edge => ['NE', 'SE'].includes(translated.regions[edge.region]!.id.split('/')[0]!)).map(edge => edge.fuelVolume_m3)),
      west = sum(own.filter(edge => ['NW', 'SW'].includes(translated.regions[edge.region]!.id.split('/')[0]!)).map(edge => edge.fuelVolume_m3))
    expect(east).toBeGreaterThan(west)
    // Independent circular-segment formula: twelve fuel pins lie on the x
    // axis column (the other five sites are guides); other columns stay whole.
    const radius = fuel.pelletDiameter_m / 2, shift = .002,
      segment = shift * Math.sqrt(radius ** 2 - shift ** 2) + radius ** 2 * Math.asin(shift / radius)
    expect((east - west) / (east + west)).toBeCloseTo(2 * 12 * segment / (264 * Math.PI * radius ** 2), 13)
    expect(translated.carriers.map(c => c.id)).toEqual(result.carriers.map(c => c.id))
    expect(own.every(edge => !('productionWeight' in edge))).toBe(true)
  })

  test('partial axial withdrawal exposes actual outside fraction without core renormalization', () => {
    const fa = poses.find(pose => pose.x_m === 0 && pose.y_m === 0)!, result = moved(fa.faId, { bottom_m: -.75 }),
      lower = result.carriers.find(c => c.faId === fa.faId && c.index === 0)!, upper = result.carriers.find(c => c.faId === fa.faId && c.index === 1)!
    expect(lower.outsideEmissionFraction).toBe(0)
    expect(upper.outsideEmissionFraction).toBeCloseTo(.75, 14)
    expect(sum(result.intersections.filter(edge => result.carriers[edge.carrier] === upper).map(edge => edge.uniformEmissionFraction))).toBeCloseTo(.25, 14)
    expect(lower.referenceFuelMass_kg).toBe(upper.referenceFuelMass_kg)
    expect(result.totals.outsideFuelVolume_m3).toBeCloseTo(.75 * upper.fuelVolume_m3, 14)
  })

  test('lateral crop and wholly outside material retain finite volume and histories support', () => {
    const fa = poses.find(pose => pose.x_m === 0 && pose.y_m === 0)!, partial = moved(fa.faId, { x_m: 1.85 }),
      whole = moved(fa.faId, { x_m: 3, bottom_m: 10 })
    for (const carrier of partial.carriers.filter(c => c.faId === fa.faId)) {
      expect(carrier.outsideEmissionFraction).toBeCloseTo(.5, 13)
      expect(carrier.insideFuelVolume_m3 + carrier.outsideFuelVolume_m3).toBeCloseTo(carrier.fuelVolume_m3, 14)
    }
    const combined = moved(fa.faId, { x_m: 1.85, bottom_m: -.75 })
    expect(combined.carriers.find(c => c.faId === fa.faId && c.index === 1)!.outsideEmissionFraction).toBeCloseTo(.875, 13)
    for (const carrier of whole.carriers.filter(c => c.faId === fa.faId)) {
      expect(carrier.outsideEmissionFraction).toBeCloseTo(1, 13)
      expect(carrier.insideFuelVolume_m3).toBe(0)
      expect(whole.intersections.some(edge => whole.carriers[edge.carrier] === carrier)).toBe(false)
    }
    expect(whole.carriers.map(c => [c.id, c.referenceFuelMass_kg, c.referenceCladMass_kg])).toEqual(partial.carriers.map(c => [c.id, c.referenceFuelMass_kg, c.referenceCladMass_kg]))
  })

  test('bad geometry, absent poses and overlapping source regions fail visibly', () => {
    expect(() => compileOperatingMapping({ ...input, poses: poses.slice(1) })).toThrow('identity')
    expect(() => compileOperatingMapping({ ...input, poses: [...poses.slice(1), poses[1]!] })).toThrow('duplicated')
    expect(() => moved(poses[0]!.faId, { x_m: NaN })).toThrow('pose')
    expect(() => compileOperatingMapping({ ...input, fuel: { ...fuel, pelletDiameter_m: .02 } })).toThrow('construction')
    expect(() => compileOperatingMapping({ ...input, fuel: { ...fuel, activeLength_m: 0 } })).toThrow('construction')
    expect(() => compileOperatingMapping({ ...input, fuel: { ...fuel, assemblies: 192 } })).toThrow('assembly count')
    expect(() => compileOperatingMapping({ ...input, partition: { ...partition, axialBounds_m: [-2, -1, -.5, 0, .5, 1, 2] } })).toThrow('equal axial')
    const duplicate: OperatingMappingInput['partition'] = { ...partition,
      quadrants: [partition.quadrants[0], partition.quadrants[0], partition.quadrants[2], partition.quadrants[3]] }
    expect(() => compileOperatingMapping({ ...input, partition: duplicate })).toThrow('unique')
    const overlap: OperatingMappingInput['partition'] = { ...partition,
      quadrants: [partition.quadrants[0], { ...partition.quadrants[1], x1_m: .1 }, partition.quadrants[2], partition.quadrants[3]] }
    expect(() => compileOperatingMapping({ ...input, partition: overlap })).toThrow('axis quadrant')
  })
})
