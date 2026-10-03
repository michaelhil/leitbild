import { describe, expect, test } from 'bun:test'

// Independent contract check: rates are native wet-side liquid-mass derivatives.
// It does not substitute pure-water derivatives for an NC mixture flash.
function boundary(dLiquid: number, dGas: number) {
  if (!Number.isFinite(dLiquid) || !Number.isFinite(dGas)) throw new Error('Unavailable native derivative')
  if (dGas <= 0) return { mode: 'gas', liquidShare: 0 }
  if (dLiquid >= 0) return { mode: 'liquid', liquidShare: 1 }
  return { mode: 'tangent', liquidShare: dGas / (dGas - dLiquid) }
}

describe('bottom-point drain zero-liquid contract', () => {
  test('attracting candidates have one conservative tangent mixture', () => {
    const result = boundary(-7, 3)
    expect(result.mode).toBe('tangent')
    expect(result.liquidShare).toBe(0.3)
    expect(result.liquidShare * -7 + (1 - result.liquidShare) * 3).toBeCloseTo(0, 14)
    // Water, air, nitrogen, associated tracer and total enthalpy: one receipt.
    const liquid = [5, 0, 0, 0.01, 2e6]
    const gas = [0.1, 0.3, 0.2, 0, 3e5]
    const receipt = liquid.map((value, i) => result.liquidShare * value + (1 - result.liquidShare) * gas[i]!)
    receipt.forEach((value) => expect(value).toBeGreaterThanOrEqual(0))
    expect(receipt[0]).toBeCloseTo(1.57)
    expect(receipt[4]).toBeCloseTo(810000)
  })

  test('dry, wet, tangent and repelling conventions require no epsilon stock', () => {
    expect(boundary(-2, -1)).toEqual({ mode: 'gas', liquidShare: 0 })
    expect(boundary(2, 1)).toEqual({ mode: 'liquid', liquidShare: 1 })
    expect(boundary(0, 1)).toEqual({ mode: 'liquid', liquidShare: 1 })
    expect(boundary(-1, 0)).toEqual({ mode: 'gas', liquidShare: 0 })
    expect(boundary(0, 0)).toEqual({ mode: 'gas', liquidShare: 0 })
    expect(boundary(2, -1)).toEqual({ mode: 'gas', liquidShare: 0 })
    expect(() => boundary(Number.NaN, 1)).toThrow('Unavailable')
  })
})
