import { expect, test } from 'bun:test'
import { parseGeometryBasis } from './reference-design-cmt-geometry.ts'
import { checkBalancePath, darcyGradient, parseBalancePathBasis } from './reference-design-cmt-balance-path.ts'

const owner = await Bun.file(new URL('../../../../Leitbild-wiki/world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/cmt-receiving-geometry.md', import.meta.url)).text()
const g = parseGeometryBasis(owner), b = parseBalancePathBasis(owner)
const record = (v: unknown) => '```reference-cmt-balance-path\n' + JSON.stringify(v) + '\n```'

test('selected route preserves BAL allocation and adds common neck once', () => {
  const r = checkBalancePath(g, b)
  expect(r.route.mainLength_m).toBeCloseTo(.95 / (Math.PI * .1 ** 2), 12)
  expect(r.route.mainVolume_m3 + r.route.roofVolume_m3 + r.route.feedVolume_m3 + r.route.bodySegments.reduce((s, x) => s + x.volume_m3, 0)).toBeCloseTo(1, 14)
  expect(r.dviNeck.additionalWater_m3).toBeCloseTo(Math.PI * .1 ** 2, 14)
  expect(r.balanceSizing.fictionalRemainder_Pa).toBeGreaterThan(0)
  expect(r.dviNeck.fictionalRemainder_Pa).toBeGreaterThan(0)
  expect(r.nonlinearReceivingQualified).toBe(false)
})

test('opposed ring donors conserve total energy and boron without net-flow collapse', () => {
  const r = checkBalancePath(g, b)
  expect(r.simultaneousExchange.netMass_kg_s).toBe(0)
  expect(r.simultaneousExchange.tankEnergy_W).toBe(2_220_000)
  expect(r.simultaneousExchange.tankBoron_kg_s).toBe(-.002)
  expect(r.signedFaces[0]!.emergingRadialVelocity_m_s).toBeGreaterThan(0)
  expect(r.signedFaces[2]!.emergingRadialVelocity_m_s).toBeLessThan(0)
  expect(r.movingDowncomerParcel.unchangedDonorVelocityAfterWithdrawal_m_s).toBe(3)
  expect(r.movingDowncomerParcel.axialMomentumBeforeAndAfterEntry_kg_m_s).toBe(300)
  expect(r.sharedDVI.commonDrop_Pa).toBeGreaterThan(r.sharedDVI.loneCMTDrop_Pa)
})

test('invalid route, negative loss remainder, unbracketed friction and hidden fields reject', () => {
  expect(() => checkBalancePath(g, { ...b, headerElevation_m: -30 })).toThrow()
  expect(() => checkBalancePath(g, { ...b, balanceReferenceLoss_Pa: 100 })).toThrow()
  expect(() => checkBalancePath(g, { ...b, dviReferenceLoss_Pa: 100 })).toThrow()
  expect(() => parseBalancePathBasis(record({ ...b, extraWater: 1 }))).toThrow()
  expect(() => parseBalancePathBasis(record({ ...b, Cd: 1.5 }))).toThrow()
  expect(() => parseBalancePathBasis(owner + record(b))).toThrow()
  expect(() => darcyGradient(25, 745, .0001, .2, .19)).toThrow()
  expect(() => darcyGradient(NaN, 745, .0001, .2, .000045)).toThrow()
  expect(darcyGradient(0, 745, .0001, .2, .000045)).toBe(0)
  expect(darcyGradient(-25, 745, .0001, .2, .000045)).toBe(-darcyGradient(25, 745, .0001, .2, .000045))
})
