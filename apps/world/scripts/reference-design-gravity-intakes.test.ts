import { expect, test } from 'bun:test'
import { effectiveOpening, intakePhase, parseGravityIntakes, terminalCheck } from './reference-design-gravity-intakes'
const fixture: ReturnType<typeof parseGravityIntakes> = { diameter_m: 0.2, terminal_m: 3, reviewSubmergence_m: 0.2, referenceTemperature_K: 298.15,
  referencePressure_Pa: 101325, referenceFlow_kg_s: 60, checkCrack_Pa: 1000, wstInitialSurface_m: 14.148275,
  branches: [{ name: 'GIV', length_m: 8, intake_m: 8.2, variableDrop_Pa: 45000, meterDrop_Pa: 5000 },
    { name: 'RECIRC', length_m: 6, intake_m: -1.8, variableDrop_Pa: 18000, meterDrop_Pa: 2000 }] }
const document = (value: unknown) => '```reference-gravity-intakes\n' + JSON.stringify(value) + '\n```'
test('current authored input is strict and geometrically possible', () => {
  expect(parseGravityIntakes(document(fixture))).toEqual(fixture)
  expect(parseGravityIntakes(document({ ...fixture, branches: [...fixture.branches].reverse() })).branches[0]?.name).toBe('RECIRC')
  expect(() => parseGravityIntakes(document({ ...fixture, invented: 2 }))).toThrow()
  expect(() => parseGravityIntakes(document({ ...fixture, branches: [{ ...fixture.branches[0], length_m: 1 }, fixture.branches[1]] }))).toThrow()
})
test('physical plane crossing, no review-band gas or zero-flow switch', () => {
  expect(intakePhase(8.3, 8.2)).toBe('liquid')
  expect(intakePhase(8.20000001, 8.2)).toBe('liquid')
  expect(intakePhase(8.2, 8.2)).toBe('gas')
  expect(intakePhase(8.1, 8.2)).toBe('gas')
  expect(effectiveOpening(0.5, 0.4)).toBe(0.2)
  expect(effectiveOpening(0, 1)).toBe(0)
  expect(() => effectiveOpening(1, -0.1)).toThrow()
})
test('one terminal check determines its own blocked-side meter pressure', () => {
  expect(terminalCheck(2e5, 3e5, false, 1000)).toEqual({ seated: true, sign: 0, meterDownstreamPressure_Pa: 2e5 })
  expect(terminalCheck(201000, 2e5, false, 1000).seated).toBe(true)
  expect(terminalCheck(201001, 2e5, false, 1000).meterDownstreamPressure_Pa).toBe(201000)
  expect(terminalCheck(2e5, 3e5, true, 1000).sign).toBe(-1)
  expect(terminalCheck(2e5, 2e5, true, 1000).sign).toBe(0)
})
