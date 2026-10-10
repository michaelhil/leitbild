import {expect,test} from 'bun:test'
import {compileOperatingPzr,parseOperatingPzr,prepareOperatingPzr} from './reference-design-operating-pzr'
import {prepareOperatingFluid} from './reference-design-operating-fluid'

const selected={commonPressure_Pa:15e6,liquidTemperature_K:600,vaporTemperature_K:630,phaseBoundaryHeight_m:6,
  bands_m:[0,1,3,6,9,12],interfacialLength_m:.003,solidRoughness_m:.000045,absorberMassFraction:.001},
  text='```reference-operating-pzr\n'+JSON.stringify(selected)+'\n```',
  route={source:'LD01.HOT.A',receiver:'LD01.PZR',sourceElevation_m:2.5,receiverElevation_m:6.5,
    developedLength_m:16,firstStraight_m:6,bendRadius_m:.45,internalDiameter_m:.3,wallThickness_m:.025,
    steelDensity_kg_m3:7920,roughness_m:.0000015,entryLoss:.5,elbowLoss:.2,exitLoss:1},
  routeText='```reference-surge-route\n'+JSON.stringify(route)+'\n```',hot={id:'HOT.A',volume_m3:15,mainFlowArea_m2:Math.PI/4,elevation_m:2.5}
test('actual ten-region geometry, disjoint HOT partition and open phase faces',()=>{
  const g=compileOperatingPzr(text,routeText,hot)
  expect(g.regions).toHaveLength(10);expect(g.faces).toHaveLength(13);expect(g.cycleColumns).toHaveLength(4)
  expect(g.totalVolume_m3).toBeCloseTo(59.74867258771282,11)
  expect(g.regions.filter(r=>r.initialPhase==='liquid')).toHaveLength(6)
  expect(g.regions.filter(r=>r.initialPhase==='vapor')).toHaveLength(4)
  expect(g.regions.filter(r=>r.lane==='inner').slice(3).every(r=>r.solidPerimeter_m===0)).toBe(true)
  const ri=Math.sqrt(.5/Math.PI),ro=Math.sqrt(5/Math.PI),ci=2*ri/3,co=(2/3)*(ro**3-ri**3)/(ro**2-ri**2)
  expect(g.regions.filter(r=>r.lane==='inner').every(r=>r.radialCentroid_m===ci)).toBe(true)
  expect(g.regions.filter(r=>r.lane==='outer').every(r=>r.radialCentroid_m===co)).toBe(true)
  for(const face of g.faces){
    expect(face.distance_m).toBeGreaterThan(0)
    expect(face.normal).toEqual(face.direction==='radial'?[1,0]:[0,1])
    expect(face.distance_m).toBeCloseTo(face.direction==='radial'?co-ci:g.regions[face.to]!.elevation_m-g.regions[face.from]!.elevation_m,14)
  }
  expect(g.faces.filter(f=>f.direction==='radial').every(f=>f.contrastContact&&f.bulkPhaseVelocity==='separate')).toBe(true)
  expect(g.faces.find(f=>f.id==='PZR.AXIAL.0.0')!.area_m2).toBe(g.regions[0]!.axialArea_m2)
  expect(g.faces.find(f=>f.id==='PZR.AXIAL.1.0')!.area_m2).toBe(g.regions[2]!.axialArea_m2)
  for(const c of g.cycleColumns){const B=Array(10).fill(0);for(const[f,w]of c.entries()){B[g.faces[f]!.from]-=w;B[g.faces[f]!.to]+=w}expect(B).toEqual(Array(10).fill(0))}
  expect(g.hotPartition.parts).toHaveLength(3)
  expect(g.hotPartition.parts.reduce((s,p)=>s+p.volume_m3,0)).toBe(15)
  expect(g.hotPartition.parts[0]!.volume_m3).toBe(g.hotPartition.parts[2]!.volume_m3)
  expect(g.hotPartition.parts[1]!.volume_m3).toBe(Math.PI/4)
  expect(g.hotPartition.junctionPorts.map(p=>p.normal)).toEqual([[-1,0,0],[1,0,0],[0,1,0]])
  expect(g.hotPartition.reflectingSideAreas_m2.positiveY+g.hotPartition.surgeArea_m2).toBeCloseTo(g.hotPartition.reflectingSideAreas_m2.negativeY,15)
  expect(g.surge.pieces.reduce((a,p)=>a+p.volume_m3,0)).toBeCloseTo(g.surge.route.liquidVolume_m3,14)
  expect(g.surge.pieces.filter(p=>p.elbowLoss>0)).toHaveLength(2)
  expect(g.mouth.region).toBe(1);expect(g.mouth.normal).toEqual([0,0,1])
  expect(g.mouth.withdrawalCdAAtUnitFraction_m2).toBeCloseTo(g.mouth.area_m2/Math.sqrt(1.5),14)
  expect(g.phaseCycles.preparedLiquid).toBe(2);expect(g.phaseCycles.preparedVapor).toBe(1)
  expect(()=>parseOperatingPzr(text+'\n'+text)).toThrow('one')
  expect(()=>parseOperatingPzr(text.replace('15000000','0'))).toThrow()
  expect(()=>parseOperatingPzr(text.replace(',"absorberMassFraction":0.001',''))).toThrow()
  expect(()=>parseOperatingPzr(text.replace('"absorberMassFraction":0.001','"absorberMassFraction":1'))).toThrow()
  expect(()=>parseOperatingPzr(text.replace('"absorberMassFraction":0.001','"absorberMassFraction":-0.001'))).toThrow()
  expect(()=>compileOperatingPzr(text,routeText.replace('6.5','7.5'),hot)).toThrow('datum')
  expect(()=>compileOperatingPzr(text,routeText,{...hot,elevation_m:3})).toThrow('envelope')
})
const wiki=process.env.LD01_WIKI_ROOT,if97=process.env.LD01_IF97_DIRECTORY
if(!!wiki!==!!if97)throw Error('Supply both actual wiki and pinned IF97 directory')
test.skipIf(!wiki||!if97)('actual maintained common-P PZR stocks retain distinct phase temperatures and no NC',async()=>{
  const f=await prepareOperatingFluid(wiki!,if97!,2.9e9),p=await prepareOperatingPzr(wiki!,if97!,f.geometry.regions.find(r=>r.id==='HOT.A')!)
  expect(p.totalVolume_m3).toBeCloseTo(59.74867258771282,11)
  expect(p.totalMass_kg).toBeGreaterThan(20000)
  expect(p.aggregateMassPAtEnergy_kg_Pa).not.toBe(0)
  for(const r of p.regions){
    expect(r.commonPressure_Pa).toBe(15e6);expect(r.mass_kg).toBeGreaterThan(0)
    expect(r.airMass_kg+r.nitrogenMass_kg).toBe(0)
    expect(r.absorberTracer_kgEq).toBe(r.initialPhase==='liquid'?p.selection.absorberMassFraction*r.mass_kg:0)
    expect(r.water.T).toBe(r.initialPhase==='liquid'?600:630)
    expect(r.initialPhase==='liquid'?r.vaporEnergy_J:r.liquidEnergy_J).toBe(0)
    expect(r.liquidEnergy_J+r.vaporEnergy_J).toBeCloseTo(r.mass_kg*r.water.u,4)
  }
},15000)
