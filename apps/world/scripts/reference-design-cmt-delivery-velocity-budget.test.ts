import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { velocityOverlapCalculation } from './reference-design-cmt-delivery-velocity-budget.ts'
import { requireVelocityOverlap } from './reference-design-cmt-delivery-velocity-pilot.ts'

test('pilot admission requires this calculation, input and a positive static verdict', () => {
  const gate = { inputHash: 'owned-input', calculationHash: createHash('sha256').update(velocityOverlapCalculation).digest('hex'), overlapAccepted: true }
  expect(() => requireVelocityOverlap(gate, 'owned-input')).not.toThrow()
  for (const bad of [null, undefined, {}, { ...gate, inputHash: 'different' }, { ...gate, calculationHash: 'old-calculation' },
    { ...gate, overlapAccepted: false }, { ...gate, overlapAccepted: 'true' }]) {
    expect(() => requireVelocityOverlap(bad, 'owned-input')).toThrow()
  }
})
