import { describe, expect, test } from 'bun:test'
import { assessPressurizerObservations, parsePressurizerObservations } from './reference-design-pressurizer-observations.ts'

const input = {
  sourceSha256: '2c4bf98527fbd50659f88c9c0452682f3cff19a9eeeb5fd35d38c5a040e5b5c3',
  initialPressure_psia: 101, initialLevel_in: 13.9, finalLevel_in: 34,
  finalLevelReadingAllowance_in: 1, inletTemperature_F: 75,
  feedEndTime_s: [84, 88], observationTime_s: [118, 122],
  thermocouples: [
    { channel: 2, height_in: 4, figure: 'A.5', pdfPage: 103, temperature_F: [95, 115] },
    { channel: 9, height_in: 25, figure: 'A.12', pdfPage: 110, temperature_F: [325, 335] },
  ],
}
const document = (value: unknown) => '```reference-pressurizer-observations\n' + JSON.stringify(value) + '\n```'
describe('original pressurizer observation admission', () => {
  test('common-time submerged readings reject a single liquid temperature, not qualify a replacement', () => {
    const result = assessPressurizerObservations(parsePressurizerObservations(document(input)))
    expect(result.minimumSeparation_F).toBe(210)
    expect(result.minimumSeparation_K).toBeCloseTo(116.6666667, 6)
    expect(result.commonLiquidTemperatureExcludedByReadingBands).toBe(true)
    expect(result.initialPressure_Pa).toBeCloseTo(696370.486609968, 5)
    expect(result.finalLevel_m).toBeCloseTo(.8636, 8)
    expect(result.inletTemperature_C).toBeCloseTo(23.8888889, 6)
    expect(result.replacementTransientModelQualified).toBe(false)
    expect(result.totalInstrumentUncertaintyEstablished).toBe(false)
  })
  test('overlapping reading bands do not reject; decision is not hardcoded', () => {
    const revised = structuredClone(input)
    revised.thermocouples[1]!.temperature_F = [110, 120]
    expect(assessPressurizerObservations(revised).commonLiquidTemperatureExcludedByReadingBands).toBe(false)
  })
  test('cannot silently compare vapor or observations before final-level classification', () => {
    expect(() => assessPressurizerObservations({ ...input, observationTime_s: [80, 82] })).toThrow()
    expect(() => assessPressurizerObservations({ ...input, finalLevel_in: 25 })).toThrow()
    expect(() => assessPressurizerObservations({ ...input, thermocouples: [input.thermocouples[0], input.thermocouples[0]] })).toThrow()
  })
  test('strict finite source input and single numeric owner', () => {
    expect(() => parsePressurizerObservations(document(input) + document(input))).toThrow()
    expect(() => parsePressurizerObservations(document({ ...input, inventedHeatRate: 100 }))).toThrow()
    expect(() => assessPressurizerObservations({ ...input, feedEndTime_s: [88, 84] })).toThrow()
    expect(() => assessPressurizerObservations({ ...input, initialLevel_in: Infinity })).toThrow()
  })
})
