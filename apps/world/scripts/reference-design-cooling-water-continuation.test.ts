import { expect,test } from 'bun:test'
import { compareCoolingWater,degradation,pumpPower,wetFlows } from './reference-design-cooling-water-continuation'
test('source and pump comparisons close without half-flow or free priming shortcuts',()=>{
 const result=compareCoolingWater()
 expect(result.checks.length).toBeGreaterThan(40)
 expect(result.sourceLoss.fine.emptyAt_s).toBeGreaterThan(result.sourceLoss.refillTo5_s)
 expect(result.closedVentReflood.finalGasFraction).toBeGreaterThan(.02)
 expect(result.oneCwPumpLost_m3_s[0]).toBe(0)
})
test('head penalty is one effective reduction and native no-power limit is preserved',()=>{
 expect(degradation(1.5,3,.08)).toBe(.25)
 expect(degradation(0,0,0)).toBe(1)
 expect(pumpPower(0,1,0,1,.8).fluid).toBe(0)
 expect(()=>degradation(1,1,-1)).toThrow()
 expect(()=>degradation(1,1,0,2,.01)).toThrow()
 expect(()=>wetFlows(-1,[1,1,1,1])).toThrow()
})
