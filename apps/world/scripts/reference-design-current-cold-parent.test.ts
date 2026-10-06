import {expect,test} from 'bun:test'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {parseCurrentColdParent,currentColdParentCalculation,runCurrentColdParent,currentColdGeometry} from './reference-design-current-cold-parent'
import {coldHydrostaticInventoryPython,coldParentCalculation} from './reference-design-cold-parent'
import {parseControlAbsorber} from './reference-design-control-absorber'
import {parseTransferAttachment,parseTransferGates} from './reference-design-fuel-transfer'
import {parseFuelConstruction} from './reference-design-fuel-construction'
import {parseFuelHandling} from './reference-design-fuel-handling'
import {parseHeadPool} from './reference-design-head-pool'

const fixture:ReturnType<typeof parseCurrentColdParent>={primaryAbsorberRatio:.002,primaryMetalTemperature_K:300,parkedToolTemperature_K:298.15,torqueToolPark_m:[-7,3,16.1],grapplePark_m:[-7,3.5,16.1]},
 document=(q:unknown)=>'```reference-current-cold-parent\n'+JSON.stringify(q)+'\n```\n'
test('current original selection is exact, finite and distinct from restored history',()=>{
 expect(parseCurrentColdParent(document(fixture))).toEqual(fixture)
 expect(()=>parseCurrentColdParent('')).toThrow('one')
 expect(()=>parseCurrentColdParent(document(fixture)+document(fixture))).toThrow('one')
 expect(()=>parseCurrentColdParent(document({...fixture,sourceReactivity:0}))).toThrow()
 expect(()=>parseCurrentColdParent(document({...fixture,primaryAbsorberRatio:.001}))).toThrow()
 expect(()=>parseCurrentColdParent(document({...fixture,primaryMetalTemperature_K:280}))).toThrow()
 expect(()=>parseCurrentColdParent(document({...fixture,torqueToolPark_m:[-7,3]}))).toThrow()
})
test('uses named unchanged hydrostat and does not rewrite old parent equations',()=>{
 expect(currentColdParentCalculation.includes(coldHydrostaticInventoryPython)).toBe(true)
 expect(createHash('sha256').update(coldParentCalculation).digest('hex')).toBe('1d5ff8e2d88db23660aca73845b046b37531fcb4f35616fc821c053d7ac67374')
 expect(currentColdParentCalculation.includes("d['sourceAuthority']=='UNSELECTED'")).toBe(true)
})
const wiki=process.env.LEITBILD_REFERENCE_WIKI,python=process.env.LEITBILD_REFERENCE_PYTHON,
 cold=process.env.LEITBILD_REFERENCE_COLD_PARENT_RECEIPT,guide=process.env.LEITBILD_REFERENCE_GUIDE_PARENT_RECEIPT
if([wiki,python,cold,guide].some(Boolean)&&![wiki,python,cold,guide].every(Boolean))throw Error('Current cold-parent native test needs all four explicit wiki/Python/cold/guide receipt paths')
test.skipIf(!wiki)('current actual inserted inventories, material stocks and one enclosure',async()=>{
 const r=await runCurrentColdParent(wiki!,cold!,guide!,python!)
 expect(r.sourceAuthority).toBe('UNSELECTED')
 expect(r.checks.length).toBeGreaterThan(60)
 // Revised ORIGINAL geometry removes the old misplaced HJT carve. Historical
 // HEOS mass receipts are not the new IF97 preparation's acceptance reference.
 expect(r.mainPrimary.volume_m3).toBeCloseTo(231.29618889377284,10)
 expect(r.mainPrimary.water_kg).toBeGreaterThan(0)
 expect(r.cores['Core.1'].water_kg+r.cores['Core.2'].water_kg).toBeGreaterThan(0)
 expect(r.cores['Core.2'].volume_m3).toBeCloseTo(r.cores['Core.1'].volume_m3,12)
 expect(r.housing.volume_m3).toBeCloseTo(10.751547842356258,11)
 expect(r.housing.tracer_kg_eq).toBeCloseTo(r.housing.water_kg*.002,12)
 expect(r.mainPrimary.tracer_kg_eq).toBeCloseTo(r.mainPrimary.water_kg*.002,9)
 expect(r.originalStocks.rows.every((q:{water_kg:number,mobileMarker_kg_eq:number,mobileN10:number,retainedN10:number})=>Math.abs(q.mobileMarker_kg_eq-q.water_kg*.002)<1e-10&&q.mobileN10===q.mobileMarker_kg_eq*r.originalStocks.atomsPer_kg_eq&&q.retainedN10===0)).toBe(true)
 expect(r.originalStocks.rows.filter((q:{owner:string})=>q.owner.startsWith('CHARGE.')).length).toBe(2)
 expect(r.originalStocks.rows.filter((q:{owner:string})=>q.owner.startsWith('PZR.')).length).toBe(10)
 expect(r.originalStocks.rows.some((q:{owner:string})=>q.owner.startsWith('CMT.')||q.owner.startsWith('ACC.')||q.owner==='WST'||q.owner==='INV.WATER')).toBe(false)
 expect(r.cnv.volume_m3).toBe(60000)
 expect(r.cnv.totalPressure_Pa).toBe(101325)
 expect(r.cnv.nitrogen_kg).toBe(0)
 expect(r.cnv.droplet_kg).toBe(0)
 expect(r.spring_J).toBe(52)
 expect(r.bays.every((q:{volume_m3:number,excluded_m3:number})=>q.volume_m3>0&&q.excluded_m3>=0)).toBe(true)
 expect(r.finiteMetal.every((q:{capacity_J_K:number,U_J:number})=>q.capacity_J_K>0&&Number.isFinite(q.U_J))).toBe(true)
 const read=async(q:string)=>Bun.file(resolve(wiki!,q)).text(),c=parseControlAbsorber(await read('systems/reactor/control-absorber-and-guide-water.md')),
  adoc=await read('systems/reactor/fuel-transfer-grapple.md'),a=parseTransferAttachment(adoc),f=parseFuelConstruction(await read('systems/reactor/fuel-construction.md')),
  h=parseFuelHandling(await read('systems/reactor/fuel-handling-and-pool.md')),b=parseHeadPool(await read('systems/reactor/head-and-pool-cooling.md')),s=parseCurrentColdParent(await read('model/connected-primary-initialization.md'))
 expect(()=>currentColdGeometry(c,a,f,h,parseTransferGates(adoc),b,{...s,torqueToolPark_m:[-7,0,16.1]})).toThrow('conflicts')
 expect(()=>currentColdGeometry(c,a,f,h,parseTransferGates(adoc),b,{...s,torqueToolPark_m:[-7,3,20]})).toThrow('conflicts')
 expect(()=>currentColdGeometry(c,a,f,h,parseTransferGates(adoc),b,{...s,grapplePark_m:s.torqueToolPark_m})).toThrow('conflicts')
},30000)
