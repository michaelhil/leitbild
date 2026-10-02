import {expect,test} from 'bun:test'
import {join} from 'node:path'
import {evidenceUsable,parallelCooling,parseLetdownCoolingBranch,runLetdownCoolingBranch} from './reference-design-letdown-cooling-branch'
test('fixed pumps share a real parallel load, with motive/coast/gravity contrasts',()=>{
 const old=parallelCooling(300000,47.878938608,0,[1,1]),normal=parallelCooling(300000,47.878938608,.1,[1,1])
 expect(old.condenser_m3_s).toBeCloseTo(47.878938608,9)
 expect(normal.condenser_m3_s).toBeLessThan(old.condenser_m3_s)
 expect(normal.side_m3_s).toBeGreaterThan(0)
 expect(Math.abs(normal.junctionDefect_m3_s)).toBeLessThan(1e-10)
 expect(parallelCooling(300000,47.878938608,.1,[0,1]).side_m3_s).toBeLessThan(normal.side_m3_s)
 expect(parallelCooling(300000,47.878938608,.1,[0,0]).side_m3_s).toBe(0)
 expect(parallelCooling(300000,47.878938608,.1,[0,0],9806.65).side_m3_s).toBeGreaterThan(0)
 expect(parallelCooling(300000,47.878938608,.1,[.5,.5]).side_m3_s).toBeGreaterThan(0)
 expect(()=>parallelCooling(300000,47,1,[NaN,1])).toThrow()
})
test('alarm age follows the product owner, not a universal clock',()=>{
 expect(evidenceUsable(3,60.2,true)).toBe(true)
 expect(evidenceUsable(60.21,60.2,true)).toBe(false)
 expect(evidenceUsable(.11,.10,true)).toBe(false)
 expect(evidenceUsable(.51,.5,true)).toBe(false)
 expect(evidenceUsable(0,60.2,false)).toBe(false)
 expect(evidenceUsable(1,2,true)).toBe(true)
 expect(()=>evidenceUsable(-1,2,true)).toThrow()
})
test('strict branch record rejects absent/duplicated or unknown inputs',()=>{
 expect(()=>parseLetdownCoolingBranch('')).toThrow()
 expect(()=>parseLetdownCoolingBranch('```reference-letdown-cooling-branch\n{}\n```')).toThrow()
})
const wiki=process.env.LEITBILD_REFERENCE_WIKI,python=process.env.LEITBILD_REFERENCE_PYTHON
if(Boolean(wiki)!==Boolean(python))throw Error('Native branch check requires both LEITBILD_REFERENCE_WIKI and LEITBILD_REFERENCE_PYTHON')
test.skipIf(!wiki||!python)('actual native face/root, finite wall and reversed donor close',()=>{
 const r=runLetdownCoolingBranch(join(wiki!,'world/packs/process-plant/reference-designs/ld-01/systems/steam-power/condenser-and-cooling.md'),python!)
 expect(r.checks.length).toBe(18)
 expect(r.effectiveCdA_m2).toBeGreaterThan(0)
 expect(r.rows[0].side_kg_s).toBeLessThan(100)
 expect(r.rows[0].condenser_kg_s).toBeGreaterThan(0)
 expect(r.reverse.flow_kg_s).toBeLessThan(0)
 expect(r.thermal.wallNoColdFlow_K_s).toBeGreaterThan(0)
 expect(r.ledger.every((q:{pairedEnergyDefect_W:number})=>Math.abs(q.pairedEnergyDefect_W)<1e-6)).toBe(true)
},30000)
