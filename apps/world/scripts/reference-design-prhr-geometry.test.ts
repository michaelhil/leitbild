import {expect,test} from 'bun:test'
import {auditPrhrGeometry,darcyFriction,parsePrhrGeometry,pipeLoss,type PrhrGeometryBasis} from './reference-design-prhr-geometry'
const basis:PrhrGeometryBasis={tubes:{count:300,id_m:.05,od_m:.06,straightLeg_m:5,bendRadius_m:.25,pitch_m:.1,top_m:12.96,bottom_m:11.04,bendLoss_K:.2,entryExitLoss_K:1.5},header:{id_m:.6,od_m:.64,length_m:30},hotConnector:{id_m:.5,od_m:.54,length_m:13.5},coldConnector:{id_m:.5,od_m:.54,length_m:11},connectorLoss_K:4,roughness_m:.000015,steelDensity_kg_m3:8000,steelCp_J_kgK:500,steelConductivity_W_mK:15,pool:{width_m:32,length_m:6.25,floor_m:8,initialWater_m3:1200,initialGas_m3:60000},hotTerminal_m:2.5,coldTerminal_m:3,calibration:{flow_kg_s:350,density_kg_m3:857.2005075123872,viscosity_Pas:.00012808820555927655,meterDrop_Pa:2000,totalDrop_Pa:20000}}
const doc=(b:unknown)=>'```reference-prhr-geometry\n'+JSON.stringify(b)+'\n```\n'
test('single owner and physical geometry are mandatory',()=>{
  expect(parsePrhrGeometry(doc(basis))).toEqual(basis)
  for(const s of [doc(basis)+doc(basis),doc({...basis,unknown:1}),doc({...basis,tubes:{...basis.tubes,pitch_m:.01}}),doc({...basis,pool:{...basis.pool,width_m:20}}),doc({...basis,hotConnector:{...basis.hotConnector,length_m:1}})])expect(()=>parsePrhrGeometry(s)).toThrow()
  expect(()=>auditPrhrGeometry({...basis,calibration:{...basis.calibration,totalDrop_Pa:2001}})).toThrow()
})
test('one geometry owns wall, water, surface, exposure and pressure budget',()=>{
  const r=auditPrhrGeometry(basis),t=basis.tubes
  expect(r.tubeLength_m).toBeCloseTo(10+1.42+Math.PI*.25,12)
  expect(r.tube.external_m3-r.tube.water_m3).toBeCloseTo(r.tube.steel_m3,12)
  expect(r.headers.external_m3-r.headers.water_m3).toBeCloseTo(r.headers.steel_m3,12)
  expect(r.tube.insideArea_m2).toBeCloseTo(Math.PI*t.id_m*t.count*r.tubeLength_m,10)
  expect(r.pool.firstExposure_m).toBeCloseTo(13.28,12)
  expect(r.pool.initialSurface_m).toBeGreaterThan(14)
  expect(200*(r.pool.initialSurface_m-8)-r.pool.displacement_m3).toBeCloseTo(1200,10)
  expect(r.pool.gasAndPoolEnclosure_m3-1200-r.pool.displacement_m3).toBeCloseTo(60000,9)
  expect(r.calibration.selectedValveDrop_Pa).toBeGreaterThan(0)
  expect(r.calibration.totalDrop_Pa).toBeCloseTo(20000,10)
  expect(r.calibration.headerMaxDrop_Pa).toBeGreaterThan(r.calibration.headerMeanDrop_Pa)
  expect(r.calibration.headerMeanDrop_Pa).toBeGreaterThan(r.calibration.headerMinDrop_Pa)
})
test('friction uses Darcy not the original paper factor; signed dissipation and rest',()=>{
  for(const re of [.01,1,10,100,1000])expect(darcyFriction(re,.00001)).toBeCloseTo(64/re,8)
  expect(darcyFriction(1e5,0)).toBeGreaterThan(.017)
  expect(darcyFriction(1e5,0)).toBeLessThan(.019)
  expect(darcyFriction(1e5,.001)).toBeGreaterThan(darcyFriction(1e5,0))
  for(const m of [0,.001,1,350]){
    const p=pipeLoss(m,857,.000128,.5,10,.000015,2)
    expect(p).toBeGreaterThanOrEqual(0)
    expect(pipeLoss(-m,857,.000128,.5,10,.000015,2)===-p).toBe(true)
  }
  for(const [re,eps] of [[0,0],[NaN,0],[100,-1],[100,1]])expect(()=>darcyFriction(re!,eps!)).toThrow()
})
