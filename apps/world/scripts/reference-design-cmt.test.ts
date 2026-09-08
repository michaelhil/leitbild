import { describe,expect,test } from 'bun:test'
import { cmtTracerDiagnostic,parseCmtBasis } from './reference-design-cmt.ts'

const basis:ReturnType<typeof parseCmtBasis>={design:'LD-01',duration_s:60,output_s:.25,initialPressure_MPa:15.2,primaryVolume_m3:220,
  hot_C:290,cold_C:40,layers:4,interlayerConductance_W_K:1000,relativeTolerance:1e-9,maximumStep_s:.25}
const document=(value:unknown)=>'```reference-cmt-fixture\n'+JSON.stringify(value)+'\n```'
describe('CMT apparatus numeric input',()=>{
  test('accepts the declared bounded numeric fixture',()=>expect(parseCmtBasis(document(basis))).toEqual(basis))
  test('requires one unique source block',()=>{
    expect(()=>parseCmtBasis('')).toThrow()
    expect(()=>parseCmtBasis(document(basis)+'\n'+document(basis))).toThrow()
  })
  test('rejects unknown executable or physical fields',()=>expect(()=>parseCmtBasis(document({...basis,code:'run()'}))).toThrow())
  test('rejects invalid temperature ordering and output timing',()=>{
    expect(()=>parseCmtBasis(document({...basis,cold_C:300}))).toThrow()
    expect(()=>parseCmtBasis(document({...basis,output_s:61}))).toThrow()
  })
  test('rejects nonphysical numerical settings',()=>{
    expect(()=>parseCmtBasis(document({...basis,relativeTolerance:.1}))).toThrow()
    expect(()=>parseCmtBasis(document({...basis,primaryVolume_m3:0}))).toThrow()
  })
})

describe('independent semidiscrete tracer diagnostic',()=>{
  const base={height_m:6,area_m2:10,velocity_m_s:.2/60,duration_s:60,probeDepth_m:.75}
  test('one-cell solution matches the analytic mixed-volume step response',()=>{
    const r=cmtTracerDiagnostic({...base,cells:1})
    expect(r.semidiscreteUpwindCellAverages[0]).toBeCloseTo(1-Math.exp(-.2/6),14)
  })
  test('conserves tracer including independently integrated outlet flow',()=>{
    for(const cells of [4,8,16]){
      const r=cmtTracerDiagnostic({...base,cells})
      expect(Math.abs(r.conservationResidual_m3)).toBeLessThan(1e-11)
      expect(r.cellAverageL1Difference_m3).toBeGreaterThan(0)
    }
  })
  test('separates exact cell average from a point measurement',()=>{
    const r=cmtTracerDiagnostic({...base,cells:4})
    expect(r.probe.exactPointValue).toBe(0)
    expect(r.probe.exactNeighborCellAverages[0]).toBeCloseTo(.2/1.5,14)
    expect(r.probe.deeperCellReconstructedValue).toBeGreaterThan(0)
  })
  test('shows both neighbors at the installed probe mesh interface',()=>{
    const r=cmtTracerDiagnostic({...base,cells:8})
    expect(r.probe.atCellBoundary).toBe(true)
    expect(r.probe.neighboringCells).toEqual([0,1])
    expect(r.probe.exactNeighborCellAverages[1]).toBe(0)
  })
  test('rejects a different numerical envelope rather than returning an unconverged tail',()=>{
    expect(()=>cmtTracerDiagnostic({...base,cells:256,velocity_m_s:10})).toThrow()
  })
})
