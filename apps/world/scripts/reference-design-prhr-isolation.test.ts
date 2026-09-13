import {expect,test} from 'bun:test'
import {auditPrhrIsolation,parsePrhrIsolation} from './reference-design-prhr-isolation'
import type {PrhrGeometryBasis} from './reference-design-prhr-geometry'
// Standalone authored geometry, not a replacement for the published owner.
const geometry:PrhrGeometryBasis={tubes:{count:300,id_m:.05,od_m:.06,straightLeg_m:5,bendRadius_m:.25,pitch_m:.1,top_m:12.96,bottom_m:11.04,bendLoss_K:.2,entryExitLoss_K:1.5},header:{id_m:.6,od_m:.64,length_m:30},hotConnector:{id_m:.5,od_m:.54,length_m:13.5},coldConnector:{id_m:.5,od_m:.54,length_m:11},connectorLoss_K:4,roughness_m:.000015,steelDensity_kg_m3:8000,steelCp_J_kgK:500,steelConductivity_W_mK:15,pool:{width_m:32,length_m:6.25,floor_m:8,initialWater_m3:1200,initialGas_m3:60000},hotTerminal_m:2.5,coldTerminal_m:3,calibration:{flow_kg_s:350,density_kg_m3:857.2005075123872,viscosity_Pas:.00012808820555927655,meterDrop_Pa:2000,totalDrop_Pa:20000}}
const isolation={spoolLength_m:.6,discDiameter_m:.499,discThickness_m:.025}
test('carved spool and disc preserve disjoint inventory without creating shell',()=>{
  const a=auditPrhrIsolation(geometry,isolation).geometry
  expect(a.remainingHotConnector_m+a.spoolLength_m).toBe(13.5)
  expect(Math.abs(a.waterAllocationResidual_m3)).toBeLessThan(1e-13)
  expect(a.closedHotConnectedWater_m3).toBeCloseTo(Math.PI*.5**2*.3/4-a.discVolume_m3/2,14)
  expect(a.addedSteel_kg).toBeCloseTo(a.discVolume_m3*8000,12)
  expect(a.minimumIdealRadialClearance_m).toBeGreaterThan(0)
  expect(a.closedEdgeRadialGap_m).toBeCloseTo(.0005,14)
})
test('solid half-cell conductance includes only half the full boundary resistance',()=>{
  const a=auditPrhrIsolation(geometry,isolation).material
  expect(a.discHalfCellConductance_W_K).toBe(2*a.discFlatFaceConductance_W_K)
  expect(a.shellHalfCellConductance_W_K).toBe(2*a.shellEndFaceConductance_W_K)
  expect(a.discThicknessDiffusionScale_s).toBeCloseTo(166.6666666667,7)
  expect(a.discHeatCapacity_J_K).toBeGreaterThan(0)
})
test('rotation sweep and retained source geometry are checked, not just closed fit',()=>{
  expect(()=>auditPrhrIsolation(geometry,{...isolation,discDiameter_m:.5})).toThrow()
  expect(()=>auditPrhrIsolation(geometry,{...isolation,spoolLength_m:.4})).toThrow()
  expect(()=>auditPrhrIsolation(geometry,{...isolation,spoolLength_m:4})).toThrow()
})
test('requires one strict finite physical declaration',()=>{
  const block='```reference-prhr-isolation\n'+JSON.stringify(isolation)+'\n```'
  expect(parsePrhrIsolation(block)).toEqual(isolation)
  expect(()=>parsePrhrIsolation(block+'\n'+block)).toThrow()
  expect(()=>parsePrhrIsolation(block.replace('0.025','0'))).toThrow()
  expect(()=>auditPrhrIsolation(geometry,{...isolation,discThickness_m:NaN})).toThrow()
})
