import { expect, test } from 'bun:test'
import { compileOperatingPzrSpray, type PzrSprayPages } from './reference-design-operating-pzr-spray'

// Test-only owner texts in the shapes the compiler reads; not plant evidence.
const fence = (name: string, body: unknown) => '```' + name + '\n' + JSON.stringify(body) + '\n```\n'
const line = { sourceRegion: 'COLD.A', inletElevation_m: 3, outletElevation_m: 18.5, developedLength_m: 25, insideDiameter_m: .1,
  wallThickness_m: .01, roughness_m: 1.5e-6, valveStrokesPerSecond: .5, inletCheck: 'ideal-one-way', valveLowReynoldsTransition: 2300 }
const port = { elevation_m: 18.5, exitCount: 16, exitBore_m: .012, ringRadius_m: .6, effectiveAreaPerExit_m2: .0000625, aggregateEffectiveArea_m2: .001 }
const sizing = { sprayReferenceFlow_kg_s: 20, sprayReferenceDifferential_Pa: 200000, sprayLength_m: 25, sprayInsideDiameter_m: .1, sprayWallThickness_m: .01, ambient_K: 313.15 }
const density = { sourcePressure_Pa: 15202734.919352943, sourceDensity_kg_m3: 745.1482932491854 }
function pages(over: Partial<{ line: unknown, port: unknown, sizing: unknown }> = {}): PzrSprayPages {
  const inventory = '## Controlled-spray material path\n\n' + fence('ld01-pzr-spray-port', over.port ?? port) + '\n' + fence('ld01-pzr-spray-line', over.line ?? line)
  return {
    line: inventory,
    port: inventory,
    sizing: '## Normal circulation and required thermal duty\n\n' + fence('reference-pressurizer-normal-thermal', over.sizing ?? sizing),
    density: '## Attended primary-pressure reduction\n\n' + fence('reference-spray-operating-scale', density),
  }
}

test('derives the valve area the owner prints and splits the line into two half paths', () => {
  const s = compileOperatingPzrSpray(pages())
  expect(s.valve.fullEffectiveArea_m2).toBe(0.0011584536025922127)
  expect(s.line.volume_m3).toBeCloseTo(0.196349541, 9)
  expect(s.line.centroidElevation_m).toBe(10.75)
  expect(s.halves.map(h => [h.face, h.elevationChange_m, h.restriction])).toEqual([
    ['COLD.A->SPRAY', 7.75, 'valve'], ['SPRAY->PZR.SPRAY', 7.75, 'distributor']])
  expect(s.halves[0]!.volume_m3 + s.halves[1]!.volume_m3).toBeCloseTo(s.line.volume_m3, 15)
  expect(s.distributor.formLoss).toBeCloseTo(61.6850275068085, 10)
  expect(s.valve.fullOpenFormLoss).toBeCloseTo(45.96449296572741, 10)
})

test('refuses a line that does not end at the spray entry, disagrees with its sizing or is not strict', () => {
  expect(() => compileOperatingPzrSpray(pages({ line: { ...line, outletElevation_m: 18 } }))).toThrow(/spray entry/)
  expect(() => compileOperatingPzrSpray(pages({ sizing: { ...sizing, sprayLength_m: 20 } }))).toThrow(/sized on/)
  expect(() => compileOperatingPzrSpray(pages({ line: { ...line, inletCheck: 'none' } }))).toThrow()
  expect(() => compileOperatingPzrSpray(pages({ line: { ...line, extra: 1 } }))).toThrow()
  expect(() => compileOperatingPzrSpray(pages({ line: { ...line, inletElevation_m: 20, outletElevation_m: 18.5 } }))).toThrow()
})
