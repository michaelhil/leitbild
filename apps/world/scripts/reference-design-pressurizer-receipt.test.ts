import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { parseReceiptBasis, receiptStream } from './reference-design-pressurizer-receipt'
import { filmEnergyCalculation } from './reference-design-pressurizer-film-energy'

test('finite receipt declares its own donor and rejects unavailable inventories', () => {
  const input = { donorPressure_MPa: 5.95, upperSuperheat_K: 2, initialDonorToTransferredMass: 2, extentSteps: 8 }
  const wrap = (value: unknown) => '```reference-pressurizer-receipt\n' + JSON.stringify(value) + '\n```'
  expect(parseReceiptBasis(wrap(input))).toEqual(input)
  expect(() => parseReceiptBasis(wrap({ ...input, initialDonorToTransferredMass: 1 }))).toThrow()
  expect(() => parseReceiptBasis(wrap({ ...input, passiveFlow: true }))).toThrow()
  expect(() => parseReceiptBasis(wrap(input) + '\n' + wrap(input))).toThrow()
})

test('receipt uses an accepted matching source and a finite actual final-window flow', () => {
  const input = { fixture: 'parser-only test double' }
  const digest = (s: string) => createHash('sha256').update(s).digest('hex')
  const fixture = { calculationHash: digest(filmEnergyCalculation), inputHash: digest(JSON.stringify(input)), numericalScreenPassed: true,
    cases: [{ rows: [{ time_s: 29, drainedMass_kg: 1, drainEnthalpyAndPotential_J: 10 }, { time_s: 30, drainedMass_kg: 2, drainEnthalpyAndPotential_J: 25 }] }] }
  expect(receiptStream(fixture, input)).toEqual({ transferredMass_kg: 2, specificEnthalpyAndPotential_J_kg: 15, window_s: [29, 30] })
  expect(() => receiptStream({ ...fixture, numericalScreenPassed: false }, input)).toThrow()
  expect(() => receiptStream({ ...fixture, calculationHash: 'old' }, input)).toThrow()
  expect(() => receiptStream(fixture, { fixture: 'different' })).toThrow()
  expect(() => receiptStream({ ...fixture, cases: [{ rows: [fixture.cases[0]!.rows[0], fixture.cases[0]!.rows[0]] }] }, input)).toThrow()
})
