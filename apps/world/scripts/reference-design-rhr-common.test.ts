import { describe, expect, it } from 'bun:test'
import { readCommonRecord, reliefStep } from './reference-design-rhr-common'

// Explicit parser/mechanics fixture; actual wiki consumption is checked by the CLI.
const owner = '```reference-rhr-common\n' + JSON.stringify({
  boreArea_m2: .1, cavityVolume_m3: .05, headerVolume_m3: 2, movingLineVolume_m3: 1.5,
  verticalDrop_m: 4.5, sourceElevation_m: 2.5, headerElevation_m: -2,
  referenceFlow_kg_s: 300, referencePressure_MPa: 1, referenceTemperature_C: 150,
  fixedLoss_Pa: 10000, eachValveLoss_Pa: 20000, equalizeCdA_m2: .01, fillCdA_m2: .00002,
  reliefOpening_MPa: 1.08, reliefReseat_MPa: 1, reliefCdA_m2: .0005, reliefStroke_s: .05,
}) + '\n```'

describe('actual RHR COMMON declaration', () => {
  it('owns one finite geometry and rejects incompatible inputs', () => {
    const r = readCommonRecord(owner)
    expect(r.headerVolume_m3! - r.movingLineVolume_m3!).toBe(.5)
    expect(r.cavityVolume_m3! / r.boreArea_m2!).toBe(.5)
    expect(() => readCommonRecord(owner + owner)).toThrow()
    expect(() => readCommonRecord(owner.replace('"movingLineVolume_m3":1.5', '"movingLineVolume_m3":3'))).toThrow()
  })
  it('retains finite lift through hysteresis and closes over actual travel', () => {
    const r = readCommonRecord(owner)
    let state = reliefStep({ opening: false, lift: 0 }, 1.08, .01, r)
    expect(state.opening).toBe(true)
    expect(state.lift).toBeCloseTo(.2)
    state = reliefStep(state, 1.04, .01, r)
    expect(state.lift).toBeCloseTo(.4)
    state = reliefStep(state, 1, .01, r)
    expect(state.opening).toBe(false)
    expect(state.lift).toBeCloseTo(.2)
    expect(reliefStep(state, .9, 1, r).lift).toBe(0)
    expect(() => reliefStep(state, .9, -1, r)).toThrow()
  })
})
