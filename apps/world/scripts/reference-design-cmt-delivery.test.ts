import { expect, test } from 'bun:test'
import { deliveryBasis } from './reference-design-cmt-delivery'

const b = { length_m: 8, bore_m: .2, roughness_m: .000045, valveZoneLength_m: .2, dviBottom_m: 2.5, dviTop_m: 3.5,
  dviPort_m: 3, dviVolume_m3: .5, referenceFlow_kg_s: 25, totalLoss_Pa: 20000, checkCrack_Pa: 1000, opening_s: 2, closing_s: 5 }
const doc = (x: unknown) => '```reference-cmt-delivery\n' + JSON.stringify(x) + '\n```'
test('outlet water and achieved actuator inputs remain explicit, finite and unambiguous', () => {
  expect(deliveryBasis(doc(b))).toEqual(b)
  expect(b.length_m * Math.PI * b.bore_m ** 2 / 4).toBeCloseTo(.25132741228718347, 12)
  for (const x of [{ ...b, length_m: 0 }, { ...b, valveZoneLength_m: 9 }, { ...b, dviPort_m: 4 },
    { ...b, dviVolume_m3: -.5 }, { ...b, closing_s: 0 }, { ...b, hiddenPressure_Pa: 15.2e6 }]) expect(() => deliveryBasis(doc(x))).toThrow()
  expect(() => deliveryBasis('')).toThrow()
  expect(() => deliveryBasis(doc(b) + '\n' + doc(b))).toThrow()
})
