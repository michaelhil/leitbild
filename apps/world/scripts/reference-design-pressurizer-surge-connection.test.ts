import {expect,test} from 'bun:test'
import {surgeConnectionGeometry} from './reference-design-pressurizer-surge-connection'
const g=surgeConnectionGeometry({source:'LD01.HOT.A',receiver:'LD01.PZR',sourceElevation_m:2.5,receiverElevation_m:6.5,
 developedLength_m:16,firstStraight_m:6,bendRadius_m:.45,internalDiameter_m:.3,wallThickness_m:.025,
 steelDensity_kg_m3:7920,roughness_m:.0000015,entryLoss:.5,elbowLoss:.2,exitLoss:1})
test('HOT intersection partitions existing material and closes pressure-force geometry',()=>{
 expect(g.hot.nodeVolume_m3+g.hot.remainingVolume_m3).toBe(15)
 expect(g.hot.sideArea_m2+g.hot.remainingPositiveSideWall_m2-g.hot.negativeSideWall_m2).toBeCloseTo(0,12)
})
test('outer bottom mouth preserves route volume and clears rods and shell',()=>{
 expect(g.bottom.innerEdge_m).toBeGreaterThan(Math.sqrt(.5/Math.PI))
 expect(g.bottom.outerEdge_m).toBeLessThan(Math.sqrt(5/Math.PI))
 expect(g.route.liquidVolume_m3).toBeCloseTo(Math.PI*.3**2/4*16,12)
 expect(g.bottom.reservoirEntryCdA_m2).toBeCloseTo(g.bottom.area_m2/Math.sqrt(1.5),12)
 expect(g.bottom.bareExitArea_m2).toBe(g.bottom.area_m2)
 expect(g.retainedElbowLoss).toBe(.4)
})
