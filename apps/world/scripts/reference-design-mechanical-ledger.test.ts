import { expect, test } from 'bun:test'

// Engineering algebra checks only: no plant flux, closure, or integrator is installed here.
const kinetic = (mass: number, momentum: number[]) => momentum.reduce((sum, p) => sum + p * p, 0) / (2 * mass)
const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i]!, 0)

test('finite variable-mass kinetic change includes the mass term, including reversal', () => {
  const cases = [
    { m0: 10, m1: 20, v0: [2], v1: [2] },
    { m0: 10, m1: 20, v0: [2], v1: [1] },
    { m0: 7, m1: 3, v0: [2, -3, 1], v1: [-4, 1, 5] },
    { m0: 4, m1: 4, v0: [2], v1: [-2] },
  ]
  for (const { m0, m1, v0, v1 } of cases) {
    const p0 = v0.map(v => m0 * v), p1 = v1.map(v => m1 * v)
    const vMean = v0.map((v, i) => (v + v1[i]!) / 2)
    const dp = p1.map((p, i) => p - p0[i]!)
    const exact = kinetic(m1, p1) - kinetic(m0, p0)
    expect(dot(vMean, dp) - dot(v0, v1) * (m1 - m0) / 2).toBeCloseTo(exact, 12)
    // Reversing the same endpoints must reverse the ledger, not add positive dissipation.
    expect(dot(vMean, dp.map(p => -p)) - dot(v1, v0) * (m0 - m1) / 2).toBeCloseTo(-exact, 12)
  }
})

test('co-moving inflow is not force work alone', () => {
  const velocity = 2, massRate = 10, momentumRate = massRate * velocity
  const kineticRate = velocity * momentumRate - velocity ** 2 * massRate / 2
  expect(kineticRate).toBe(20)
  expect(velocity * momentumRate).toBe(40) // The tempting omitted-mass-term expression is wrong.
})

test('equal opposing material streams carry energy despite zero net momentum', () => {
  const mass = 10, velocity = 2
  const incomingKinetic = kinetic(mass, [mass * velocity]) + kinetic(mass, [-mass * velocity])
  const mixedKinetic = kinetic(2 * mass, [0])
  expect(incomingKinetic).toBe(40)
  expect(mixedKinetic).toBe(0)
  // Ideal closed inelastic mixing converts this difference to U; it cannot disappear.
  expect(incomingKinetic - mixedKinetic).toBe(40)
})
