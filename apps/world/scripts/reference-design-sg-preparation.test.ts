import { describe, expect, test } from 'bun:test'
import { parseSgPreparationParent } from './reference-design-sg-preparation'

const fixture = () => ({ accepted: true,
  input: { primarySeed: { sgSizing: { secondaryConductance_W_K: 2e8 } } },
  lastEvaluableState: { primary: { SGWallEnergyAboveZeroC_J: { A: 4.24e10, B: 4.23e10 },
    SGHeat_W: { A: 1.51e9, B: 1.50e9 }, secondaryTemperature_K: 548.7 } },
})

describe('offline SG preparation parent', () => {
  test('retains distinct actual walls and frozen hardware, not new sizing', () => {
    const parent = parseSgPreparationParent(fixture())
    expect(parent.SGWallEnergyAboveZeroC_J.A).toBe(4.24e10)
    expect(parent.SGWallEnergyAboveZeroC_J.B).toBe(4.23e10)
    expect(parent.secondaryConductance_W_K).toBe(2e8)
  })
  test('refuses an unaccepted parent and missing hardware', () => {
    expect(() => parseSgPreparationParent({ ...fixture(), accepted: false })).toThrow()
    expect(() => parseSgPreparationParent({ ...fixture(), input: {} })).toThrow()
  })
  test('refuses nonfinite or missing wall state', () => {
    const parent = fixture()
    parent.lastEvaluableState.primary.SGWallEnergyAboveZeroC_J.B = NaN
    expect(() => parseSgPreparationParent(parent)).toThrow()
    expect(() => parseSgPreparationParent({ ...fixture(), lastEvaluableState: {} })).toThrow()
  })
})
