import {expect,test} from 'bun:test'
import {occupiedGeometry,parseMovingPhase,phaseThermalSources,rodContact} from './reference-design-pressurizer-moving-phase'

const selection:ReturnType<typeof parseMovingPhase>={contact_W_m2K:2000,contactAngle_deg:38,detachmentFraction:1,bubbleDiameter_m:.0005,vaporInterface_W_m2K:1000,freeSurfaceLayer_m:.01,maximumVoidFraction:.05,comparisonRequests_W:[35000,65000],occupiedHeight_m:6,rodBottom_m:6.5}
const block=(data:unknown)=>'```reference-pressurizer-moving-phase\n'+JSON.stringify(data)+'\n```\n'
test('one finite physical selection, no duplicate or unbounded heat fraction',()=>{
  expect(parseMovingPhase(block(selection))).toEqual(selection)
  expect(()=>parseMovingPhase(block(selection)+block(selection))).toThrow()
  expect(()=>parseMovingPhase(block({...selection,detachmentFraction:1.01}))).toThrow()
  expect(()=>parseMovingPhase(block({...selection,bubbleDiameter_m:0}))).toThrow()
  expect(()=>parseMovingPhase(block({...selection,unknown:1}))).toThrow()
})
test('signed Stefan sources transfer energy once, including exact rest',()=>{
  for(const [ql,qv] of [[-200,0],[0,100],[0,0]]) {
    const result=phaseThermalSources(ql!,qv!,1.6e6,2.6e6)
    expect(result.liquid+result.vapor).toBeCloseTo(0,8)
    expect(Math.sign(result.gamma)).toBe(Math.sign(ql!+qv!))
  }
  expect(()=>phaseThermalSources(1,1,2,1)).toThrow()
})
test('occupied height is not liquid-only volume; upper retained liquid displaces gas once',()=>{
  const solid=32*Math.PI*.01**2;const v=occupiedGeometry(5,.5,6,12,.002,.003,solid,0)
  expect(v.upflow+v.return).toBe(30)
  expect(v.bulkLiquid).toBe(29.998-solid)
  expect(v.upflowFluid).toBe(3-solid)
  expect(v.bulkLiquid+v.dispersedVapor+v.aboveLiquid+v.upperVapor+v.submergedSolid).toBeCloseTo(60,12)
  expect(()=>occupiedGeometry(5,.5,6,12,3,.003,solid,0)).toThrow()
  expect(()=>occupiedGeometry(5,.5,6,12,.002,30,solid,0)).toThrow()
  expect(()=>occupiedGeometry(5,.5,6,12,.002,.003,3,0)).toThrow()
  const rods=rodContact(32,.02,1,6.5,7)
  const partial=occupiedGeometry(5,.5,.5,12,.002,.003,rods.submergedVolume,rods.exposedVolume)
  expect(rods.submergedVolume+rods.exposedVolume).toBeCloseTo(solid,14)
  expect(rods.wetArea).toBeCloseTo(32*Math.PI*.02*.5,14)
  expect(rods.surfaceSolidArea).toBeCloseTo(solid,14)
  expect(partial.bulkLiquid+partial.dispersedVapor+partial.aboveLiquid+partial.upperVapor+partial.submergedSolid+partial.exposedSolid).toBeCloseTo(60,12)
})
