import { expect, test } from 'bun:test'
import { auditPressurizerBoundaries, integrateSignedSchedule, parsePressurizerBoundaries } from './reference-design-pressurizer-boundaries.ts'

const input: ReturnType<typeof parsePressurizerBoundaries> = {
  sourceSha256: 'ee74a7b5315bed710d4a89dfe43347613b8fb85349640de253aa4c4d8c981369',
  height_m: 8.8, innerRadius_m: .06985, outerRadius_m: .08415,
  cellCount: 30, cellLength_m: .2933333, cellVolume_m3: .00449618,
  liquidCellEquivalents: 11.25, statedLevel_m: 3.3,
  fluidTemperature_K: 547.64, wallTemperature_K: 547, ambientTemperature_K: 298,
  outerHeatTransfer_W_m2K: 3.44,
  surgeMassFlow_kg_s: [[0, 0], [119, 0], [120, .3666], [220, .3666], [221, -.215], [406, -.215], [407, 0]],
  heaterPower_W: [[0, 4000], [99, 4000], [100, 0]],
}

test('recovered source geometry and heat/mass budgets are calculated independently', () => {
  const a = auditPressurizerBoundaries(input)
  expect(a.initialLevelFromDeck_m).toBeCloseTo(3.3, 5)
  expect(Math.abs(a.relativeVolumeRoundingDifference)).toBeLessThan(1e-6)
  expect(a.shellThickness_m).toBeCloseTo(.0143, 9)
  expect(a.initialLateralShellLoss_W).toBeGreaterThan(3900)
  expect(a.initialLateralShellLoss_W).toBeLessThan(4000)
  expect(a.heaterEnergy_J.net).toBe(398000)
  expect(a.surgeMass_kg.net).toBeCloseTo(-2.9634, 9)
  expect(a.surgeMass_kg.incoming).toBeGreaterThan(36.84)
  expect(a.surgeMass_kg.outgoing).toBeGreaterThan(39.88)
})

test('zero-crossing split retains both gross directions and linear integral', () => {
  expect(integrateSignedSchedule([[0, 2], [3, -1]])).toEqual({ incoming: 2, outgoing: .5, net: 1.5, from_s: 0, through_s: 3 })
  expect(integrateSignedSchedule([[0, -2], [3, 1]]).net).toBe(-1.5)
  expect(integrateSignedSchedule([[2, 0], [5, 0]]).net).toBe(0)
  expect(() => integrateSignedSchedule([[0, 1], [0, 2]])).toThrow()
  expect(() => integrateSignedSchedule([[0, 1], [Infinity, 2]])).toThrow()
})

test('strict fixture, explicit times, finite geometry; altered assumptions change audit', () => {
  const doc = '```reference-pressurizer-boundaries\n' + JSON.stringify(input) + '\n```'
  expect(parsePressurizerBoundaries(doc)).toEqual(input)
  expect(() => parsePressurizerBoundaries(doc + '\n' + doc)).toThrow()
  expect(() => auditPressurizerBoundaries({ ...input, pressureValidated: true })).toThrow()
  expect(() => auditPressurizerBoundaries({ ...input, outerRadius_m: .06 })).toThrow()
  expect(() => auditPressurizerBoundaries({ ...input, liquidCellEquivalents: 31 })).toThrow()
  expect(() => auditPressurizerBoundaries({ ...input, heaterPower_W: [[0, -1], [2, 0]] })).toThrow()
  const altered = auditPressurizerBoundaries({ ...input, cellVolume_m3: .005 })
  expect(altered.relativeVolumeRoundingDifference).toBeGreaterThan(.1)
  expect(altered.inputHash).not.toBe(auditPressurizerBoundaries(input).inputHash)
})
