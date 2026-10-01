import {describe,expect,test} from 'bun:test'
import {nuclearObservationGeometry,parseNuclearObservation,runNuclearObservation} from './reference-design-nuclear-observation'
const record={wall_m:.0005,endcap_m:.0005,diaphragm_m:.0002,diaphragmCentres_m:[-1.025,-.975,.948,1.052],carrierCentre_m:1,carrierLength_m:.1,carrierOD_m:.004,carrierWall_m:.0002,b10Areal_kg_m2:.1,ringWidth_m:.001,capsuleOD_m:.003,capsuleLength_m:.005,capsuleWall_m:.0002,barAngle_rad:1,barWidth_m:.0005,leadOD_m:.0001,leadRadius_m:.002325,leadAngles_rad:[Math.PI/3,Math.PI],sleeveOD_m:.0003,bareContactLength_m:.0001,glassDensity_kg_m3:2500,glassCp_J_kg_K:500,glassK_W_m_K:1,emitterDensity_kg_m3:15000,emitterCp_J_kg_K:100,emission_neutrons_s_g:2.314e12,capsuleDecayUpper_W:.1,terminal_kg:.001,terminalToRoom_W_K:1,heliumOriginal_Pa:200000,original_K:300,R_J_mol_K:8.31446261815324,heliumMolarMass_kg_mol:.004002602,contactFactors:[.5,1,2],responseRange_K:[290,900]}
const doc='```reference-nuclear-observation-apparatus\n'+JSON.stringify(record)+'\n```\n',b=parseNuclearObservation(doc)
const h={sourceThimbleDiameter_m:.006,sourceThimbleBottom_m:-3.5,sourceThimbleTop_m:2.5,sourceCapsule_m:-1,b4cDensity_kg_m3:2500,b10AtomFraction:.199,b10MolarMass_kg_mol:.010012937,b4cMolarMass_kg_mol:.055255},source={birthEmission_neutrons_s:4e9}
describe('one finite nuclear converter',()=>{
 test('strict numerical owner and geometry incidence',()=>{
  expect(()=>parseNuclearObservation(doc+doc)).toThrow();expect(()=>parseNuclearObservation(doc.replace('"wall_m":0.0005','"wall_m":0.0005,"unowned":1'))).toThrow()
  expect(()=>nuclearObservationGeometry({...b,leadRadius_m:.0024},h,source)).toThrow('sleeves fit')
  expect(()=>nuclearObservationGeometry({...b,leadRadius_m:.0023},h,source)).toThrow('naked wire')
  expect(()=>nuclearObservationGeometry({...b,barAngle_rad:2.2},h,source)).toThrow('support fit')
  expect(()=>nuclearObservationGeometry({...b,diaphragmCentres_m:[-1.025,-.975,.9495,1.052]},h,source)).toThrow('film fits')
 })
 test('one closed envelope and five passive cells, not five converters',()=>{
  const r=nuclearObservationGeometry(b,h,source),gas=r.stocks.filter(x=>x.material==='He')
  expect(r.geometry.volumeDefect_m3).toBeCloseTo(0,16);expect(r.stocks.filter(x=>x.id==='CONVERTER')).toHaveLength(1)
  expect(gas).toHaveLength(6);expect(gas.every(x=>x.energy_J!>0&&x.capacity_J_K!>0)).toBe(true)
  expect(r.geometry.b10Mass_kg).toBeCloseTo(.00012566370614359174,15)
  expect(r.geometry.filmOuterRadius_m).toBeLessThan(.0025);expect(r.geometry.sourcePowerComparison_W).toBeLessThan(b.capsuleDecayUpper_W)
  expect(r.geometry.bareContactArea_m2).toBeCloseTo(Math.PI*.0001*.0001,16)
  expect(r.stocks.filter(x=>x.material==='glass').length).toBeGreaterThan(0)
 })
 test('lead segments retain the physical length once through stepped termination',()=>{
  const r=nuclearObservationGeometry(b,h,source),leads=r.stocks.filter(x=>x.id.startsWith('LEAD.'))
  const v=leads.reduce((s,x)=>s+x.volume_m3,0),area=Math.PI*(b.leadOD_m/2)**2
  expect(v/area).toBeCloseTo((1.051+3.5)+(1.0521+3.5),12)
  expect(r.leadSegments.every(x=>x.hi_m>x.lo_m)).toBe(true)
  expect(r.leadSegments.reduce((s,x)=>s+x.sleeveLength_m+x.bareMetalLength_m,0)).toBeCloseTo(.0064,12)
  expect(r.leadSegments.reduce((s,x)=>s+x.bareMetalLength_m,0)).toBeCloseTo(.0002,12)
  expect(r.leadSegments.every(x=>Math.abs((x.hi_m-x.lo_m)-(x.gasExposedLength_m+x.sleeveLength_m+x.bareMetalLength_m))<1e-14)).toBe(true)
  expect(r.stocks.find(x=>x.id==='DIAPHRAGM.3')!.volume_m3).toBeLessThan(Math.PI*.0025**2*b.diaphragm_m)
  expect(r.stocks.filter(x=>x.id==='LEAD.0')).toHaveLength(0)
  const terminal=r.stocks.find(x=>x.id==='TERMINAL')!,wall0=r.stocks.find(x=>x.id==='WALL.0')!
  expect(terminal.mass_kg).toBeCloseTo(.001,15)
  expect(terminal.volume_m3+wall0.volume_m3).toBeCloseTo(r.geometry.terminalBand.shellArea_m2*2.475,15)
  expect(r.geometry.terminalBand.hi_m).toBeLessThan(-1.025)
 })
 const wiki=process.env.LEITBILD_REFERENCE_WIKI,python=process.env.LEITBILD_REFERENCE_PYTHON
 if(Boolean(wiki)!==Boolean(python))throw Error('Native NI check requires both LEITBILD_REFERENCE_WIKI and LEITBILD_REFERENCE_PYTHON')
 test.skipIf(!wiki||!python)('actual named material laws and positive contact sensitivity',async()=>{
  const r=await runNuclearObservation(wiki!,python!)
  expect(r.checks.length).toBe(68);expect(r.stocks.every(x=>Number.isFinite(x.capacity_J_K)&&x.capacity_J_K!>0)).toBe(true)
  expect(r.caloric.map(x=>x.temperature_K)).toEqual([290,300,900])
  for(const row of r.caloric){
   expect(row.heliumConductivity_W_m_K).toBeGreaterThan(0)
   expect(row.contactSensitivity.map(x=>x.factor)).toEqual([.5,1,2])
   const [half,nominal,double]=row.contactSensitivity
   expect(Object.values(nominal!.contacts).every(x=>Number.isFinite(x)&&x>0)).toBe(true)
   expect(half!.contacts.rings_W_K).toBe(nominal!.contacts.rings_W_K!/2)
   expect(double!.contacts.rings_W_K).toBe(nominal!.contacts.rings_W_K!*2)
  }
  expect(Object.keys(r.sourceHashes)).toHaveLength(5);expect(r.inputSha256).toHaveLength(64)
 },30000)
})
