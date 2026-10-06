import {describe,expect,test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {capsuleBirthSupport,compileFuelHistoryInputs,nativeFuelHistoryFixture,parseFuelHistoryLaws} from './reference-design-fuel-history'
import {compileFuelInputs,parseConfigurationFuel} from './reference-design-source-fuel'

const block=(name:string,value:unknown)=>'```'+name+'\n'+JSON.stringify(value)+'\n```\n',
 births={spectrum:'normalized-fuel-chi' as const,spontaneousNeutronsPerEvent:2.5,emission_neutrons_s_g:{U235:.000299,U238:.0136},
  installedRecoverablePowerAtAgeZero_W:.1,installedNeutronExport_MeV:2,installedSupport:'uniform-capsule-envelope' as const},
 poison={captureGroups:[7] as [7],XeBarn:2600000,SmBarn:41000,yieldI:.06,yieldXe:.003,yieldPm:.01,halfLifeHours:{I:6.57,Xe:9.10,Pm:53.1}},
 document=block('reference-external-births',births)+block('reference-configuration-added-material',{poison}),
 regions=[{id:'a',compartment:'ACTIVE' as const,volume_m3:4,envelopeLength_m:1,box:{x0:-1,x1:1,y0:-1,y1:1},z0_m:-1,z1_m:0},
  {id:'b',compartment:'ACTIVE' as const,volume_m3:4,envelopeLength_m:1,box:{x0:-1,x1:1,y0:-1,y1:1},z0_m:0,z1_m:1}]

describe('owned fuel-history inputs',()=>{
 test('one consumed explicit spectrum, finite donor and existing poison authority',()=>{
  const r=parseFuelHistoryLaws(document)
  expect(r.births).toEqual(births);expect(r.poison).toEqual(poison)
  expect(()=>parseFuelHistoryLaws(document+block('reference-external-births',births))).toThrow()
  expect(()=>parseFuelHistoryLaws(document.replace('normalized-fuel-chi','group-1-default'))).toThrow()
  expect(()=>parseFuelHistoryLaws(document.replace('"captureGroups":[7]','"captureGroups":[5,6,7]'))).toThrow()
  expect(()=>parseFuelHistoryLaws(document.replace('"spontaneousNeutronsPerEvent":2.5','"spontaneousNeutronsPerEvent":0'))).toThrow()
 })
 test('finite emitting envelope crossing an axial boundary conserves whole births',()=>{
  const r=capsuleBirthSupport(regions,.1,.02,0)
  expect(r).toHaveLength(2);for(const q of r)expect(q.fraction).toBeCloseTo(.5,13)
  const transverse=regions.flatMap(q=>[-1,0].map(x=>({...q,id:q.id+x,box:{...q.box,x0:x,x1:x+1}}))),
   split=capsuleBirthSupport(transverse,.1,.02,0)
  expect(split).toHaveLength(4);for(const q of split)expect(q.fraction).toBeCloseTo(.25,13)
  expect(split.reduce((s,q)=>s+q.fraction,0)).toBeCloseTo(1,13)
 })
 test('cropping, duplicate coverage and unrepresented radial support do not get renormalized',()=>{
  expect(()=>capsuleBirthSupport(regions.slice(0,1),.1,.02,0)).toThrow('Incomplete')
  expect(()=>capsuleBirthSupport([...regions,regions[0]!],.1,.02,0)).toThrow('duplicated')
  expect(()=>capsuleBirthSupport(regions.map(q=>({...q,diskRadius_m:.05})),.1,.02,0)).toThrow('disk')
  expect(()=>capsuleBirthSupport(regions,0,.02,0)).toThrow()
 })
})

const wiki=process.env.LEITBILD_REFERENCE_WIKI,evidence=process.env.LEITBILD_REFERENCE_SOURCE_EVIDENCE
describe.skipIf(!wiki||!evidence)('actual ORIGINAL fuel-history assembly input',()=>{
 test('386 physical histories, finite source and exact existing fuel incidence',()=>{
  const read=(p:string)=>readFileSync(join(wiki!,p),'utf8'),
   p=JSON.parse(readFileSync(join(evidence!,'operating-source-fixed-partition.json'),'utf8')),
   m=JSON.parse(readFileSync(join(evidence!,'operating-source-cold-material-incidence.json'),'utf8')),
   docs=['systems/reactor/configuration-source-and-history.md','systems/reactor/heat-and-history.md',
    'systems/reactor/cold-source-and-startup.md','systems/reactor/fuel-handling-and-pool.md',
    'systems/instrumentation/nuclear-observation-apparatus.md'].map(read),r=compileFuelHistoryInputs(p,m,docs)
  expect(r.segments).toHaveLength(386);expect(r.counts.fuelHistoryCoordinates).toBe(13124)
  expect(r.counts.totalCoordinates).toBe(50623)
  expect(r.support.reduce((s,q)=>s+q.fraction,0)).toBeCloseTo(1,12)
  expect(r.support.every(q=>q.fraction>0&&q.region>=0&&q.region<r.fuel.regionVolumes.length)).toBe(true)
  const intrinsic=r.segments.reduce((s,q)=>s+q.sf235_neutrons_per_second+q.sf238_neutrons_per_second,0)
  expect(intrinsic).toBeGreaterThan(1e6);expect(intrinsic).toBeLessThan(2e6)
  expect(r.cf.initial_neutrons_per_second).toBe(4e9)
  expect(r.cf.decay_rate*r.cf.initial_energy_j).toBeCloseTo(.1,14)
  expect(r.cf.initial_neutrons_per_second*r.cf.birth_export_j_per_neutron).toBeLessThan(.1)
  expect(r.heat.groups.filter(g=>g.feed==='fission')).toHaveLength(23)
  expect(r.heat.groups.filter(g=>g.feed==='fertileCapture')).toHaveLength(2)
  expect(nativeFuelHistoryFixture(r).trim().split(/\s+/).every(q=>Number.isFinite(Number(q)))).toBe(true)
  expect(r.completeReactorOperator).toBe(false);expect(r.advancedSeconds).toBe(0)
  // Compilation retains the existing fuel model; it does not clone six-group C.
  const original=compileFuelInputs(p,m,parseConfigurationFuel(docs[0]!),r.heat.promptFissionEnergy_J)
  expect(r.fuel.identities).toEqual(original.identities)
 })
})
