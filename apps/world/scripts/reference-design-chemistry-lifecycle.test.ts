import {expect,test} from 'bun:test'
import {parseChemistryLifecycle,serialMix,mixingMass,finiteStockBudget,transferDrive,runChemistryLifecycle} from './reference-design-chemistry-lifecycle'

const fixture={pressure_Pa:101325,temperature_K:313.15,gravity_m_s2:9.80665,floor_m:.6,height_m:4,
 WATER:{area_m2:250,initialVolume_m3:800,initial_ppm:0,stopHeight_m:.1,resetHeight_m:.2},
 CONCENTRATE:{area_m2:125,initialVolume_m3:400,initial_ppm:4000,stopHeight_m:.2,resetHeight_m:.3},
 BLEND:{area_m2:5,initialVolume_m3:12,initial_ppm:2000,stopHeight_m:3.6,resetHeight_m:3.56},
 RECEIVER:{area_m2:325,initialVolume_m3:2,initial_ppm:0,stopHeight_m:3.6,resetHeight_m:3.4},
 planningPrimaryMass_kg:500000,reserveTemperature_K:290,reservePressure_Pa:20e6,initialPrimary_ppm:2000,normalPrimary_ppm:1000,restartPrimary_ppm:2000,conditioningVolume_m3:5,comparisonRate_kg_s:2.5,
 transferFlow_kg_s:5,transferRise_Pa:50000,hydraulicEfficiency:.6,motorEfficiency:.9,tracking_s:1,coastdown_s:1,metalCapacity_J_K:100000,caseContact_W_K:2000,roomContact_W_K:100,isotopeFraction:.199,isotope10MolarMass_kg_mol:.010012937,isotope11MolarMass_kg_mol:.01100930536,avogadro_mol:6.02214076e23}
const document=(x:unknown)=>'```reference-chemistry-lifecycle\n'+JSON.stringify(x)+'\n```\n'
test('one exact finite stock record, no refill or concentration command',()=>{
 expect(parseChemistryLifecycle(document(fixture))).toEqual(fixture)
 expect(()=>parseChemistryLifecycle('')).toThrow('one')
 expect(()=>parseChemistryLifecycle(document(fixture)+document(fixture))).toThrow('one')
 expect(()=>parseChemistryLifecycle(document({...fixture,infiniteRefill:true}))).toThrow()
 expect(()=>parseChemistryLifecycle(document({...fixture,CONCENTRATE:{...fixture.CONCENTRATE,initial_ppm:2000}}))).toThrow('mission')
 expect(()=>parseChemistryLifecycle(document({...fixture,conditioningVolume_m3:6}))).toThrow('mission')
 expect(()=>parseChemistryLifecycle(document({...fixture,WATER:{...fixture.WATER,initialVolume_m3:1001}}))).toThrow('range')
})
test('serial mass coordinate retains both carriers, including equal and nearly equal masses',()=>{
 expect(serialMix(100,100,2000,2000,0,100).primary).toBeCloseTo(4000/Math.E,10)
 expect(serialMix(100,100,2000,2000,0,100).blend).toBeCloseTo(2000/Math.E,10)
 expect(serialMix(100,100*(1+1e-9),2000,2000,0,100).primary).toBeCloseTo(4000/Math.E,5)
 expect(serialMix(100,100*(1-1e-9),2000,2000,0,100).primary).toBeCloseTo(4000/Math.E,5)
 expect(serialMix(1,2,2000,2000,0,1e6)).toEqual({primary:0,blend:0})
 expect(serialMix(100,20,2000,1000,0,0)).toEqual({primary:2000,blend:1000})
 expect(()=>serialMix(0,20,2000,1000,0,1)).toThrow()
 expect(()=>mixingMass(100,20,1000,1000,2000,2000)).toThrow('finite')
 const x=mixingMass(100,20,2000,2000,0,1000)
 expect(serialMix(100,20,2000,2000,0,x).primary).toBeCloseTo(1000,10)
 const later=mixingMass(100,20,2000,4000,0,1000)
 expect(serialMix(100,20,2000,4000,0,1).primary).toBeGreaterThan(2000)
 expect(serialMix(100,20,2000,4000,0,later).primary).toBeCloseTo(1000,10)
})
test('current native-density comparison includes retained-BLEND restart, not infinite cycles',()=>{
 const s=parseChemistryLifecycle(document(fixture)),r=finiteStockBudget(s,992.216352873)
 expect(r.admissible).toBe(true)
 expect(r.conditionedBlend_ppm).toBeGreaterThan(1000)
 expect(r.waterRemaining_m3).toBeGreaterThan(25)
 expect(r.concentrateRemaining_m3).toBeGreaterThan(25)
 expect(r.receiverVolume_m3).toBeLessThan(1170)
 expect(r.restartDilutionMass_kg).toBeGreaterThan(r.dilutionMass_kg)
 expect(finiteStockBudget({...s,WATER:{...s.WATER,initialVolume_m3:400}},992.216352873).admissible).toBe(false)
 expect(finiteStockBudget({...s,WATER:{...s.WATER,initialVolume_m3:16}},992.216352873).admissible).toBe(false)
 expect(finiteStockBudget({...s,CONCENTRATE:{...s.CONCENTRATE,initialVolume_m3:8}},992.216352873).admissible).toBe(false)
 expect(finiteStockBudget({...s,RECEIVER:{...s.RECEIVER,area_m2:5}},992.216352873).admissible).toBe(false)
 expect(()=>finiteStockBudget({...s,conditioningVolume_m3:0},992.216352873)).toThrow('crossing')
 expect(()=>finiteStockBudget(s,NaN)).toThrow('density')
})
const wiki=process.env.LEITBILD_REFERENCE_WIKI,python=process.env.LEITBILD_REFERENCE_PYTHON,current=process.env.LEITBILD_REFERENCE_CURRENT_PARENT_RECEIPT,cold=process.env.LEITBILD_REFERENCE_COLD_PARENT_RECEIPT
test('source torque and electrical caps retain finite negative-speed brake heat and lost supply',()=>{
 const s=parseChemistryLifecycle(document(fixture)),m={referenceFluidPower_W:420,omega0:300,inertia_kg_m2:.005}
 for(const omega of [-600,-300,0,300,600]){const r=transferDrive(s,m,omega,300,100,true);expect(r.electric).toBeLessThanOrEqual(r.electricCap+1e-9);expect(r.heat).toBeGreaterThanOrEqual(0);expect(r.torque).toBeLessThanOrEqual(1.5*1.01*420/300)}
 const reverse=transferDrive(s,m,-300,300,100,true);expect(reverse.electric).toBe(0);expect(reverse.heat).toBe(-reverse.shaft)
 expect(transferDrive(s,m,300,300,100,false).torque).toBe(0)
 expect(()=>transferDrive(s,m,300,301,100,true)).toThrow('drive')
})
if([wiki,python,current,cold].some(Boolean)&&![wiki,python,current,cold].every(Boolean))throw Error('Chemistry native test requires all four wiki/Python/current/cold paths')
test.skipIf(!wiki)('native full inventory, finite stock/energy and held signed five kg/s path',async()=>{
 const r=await runChemistryLifecycle(wiki!,current!,cold!,python!)
 expect(r.checks.length).toBeGreaterThan(20)
 expect(r.planning.nativeFullLiquidMass_kg).toBeLessThan(500000)
 expect(r.mission.receiverLiquidUpper_m3).toBeLessThan(1170)
 expect(r.mission.conditionedBlend_ppm).toBeGreaterThan(1000)
 expect(r.mission.comparisonElapsed_s/86400).toBeGreaterThan(4)
 expect(r.mission.comparisonElapsed_s/86400).toBeLessThan(5)
 expect(r.mission.restartPeak_ppm).toBeGreaterThan(2000)
 expect(r.mission.afterRestartBlend_ppm).toBeLessThan(.001)
 expect(r.flow.find((q:any)=>q.label==='maximum-lift').m).toBeGreaterThan(2.5)
 expect(r.flow.find((q:any)=>q.label==='limited-speed').m).toBeLessThan(2.5)
 expect(r.machineContrary.reverse.paired.energyDefect_J).toBeCloseTo(0,8)
 expect(r.machineContrary.dry.churnBody_W).toBeGreaterThan(0)
 expect(r.stocks.RECEIVER.volumeBin_m3).toBe(3.25)
 expect(r.stocks.WATER.volumeBin_m3).toBe(2.5)
 expect(r.adverse.unconditionedRemakeInitiallyDilutes).toBe(true)
},30000)
