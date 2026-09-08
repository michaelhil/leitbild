import { expect, test } from 'bun:test'
import { parseSpatialBasis } from './reference-design-pressurizer-spatial'
const page = (x: unknown) => '```reference-pressurizer-spatial\n'+JSON.stringify(x)+'\n```\n'
test('spatial reference accepts explicit choices and rejects invalid or ambiguous inputs', () => {
  const input = { surfacePressure_MPa: 5.9, verificationGasGamma: 1.3, wallDuration_s: 100 }
  expect(parseSpatialBasis(page(input))).toEqual(input)
  expect(() => parseSpatialBasis(page({...input, verificationGasGamma: 1}))).toThrow()
  expect(() => parseSpatialBasis(page({...input, automaticSaturationReset: true}))).toThrow()
  expect(() => parseSpatialBasis(page(input)+page(input))).toThrow()
})
