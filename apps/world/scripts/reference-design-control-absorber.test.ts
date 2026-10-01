import {describe,expect,test} from 'bun:test'
import {laminarAnnulus,annulusResistance,parseControlAbsorber,gapReleaseLimit,gripWork,gripCapacity} from './reference-design-control-absorber'

const q={outerRadius_m:.0055,innerRadius_m:.00475,length_m:4.65,viscosity_Pa_s:.000855,gradient_Pa_m:100,bodySpeed_m_s:.008}
describe('actual open annular guide limits',()=>{
 test('exact wall and pressure work equals positive dissipation',()=>{
  for(const G of [-100,0,100])for(const v of [-.008,0,.008]){
   const r=laminarAnnulus({...q,gradient_Pa_m:G,bodySpeed_m_s:v})
   expect(r.dissipation_W).toBeGreaterThanOrEqual(0)
   expect(r.dissipation_W).toBeCloseTo(r.pressureAndWallWork_W,12)
  }
 })
 test('pressure-only and moving-wall-only are distinct open flows',()=>{
  const pressure=laminarAnnulus({...q,bodySpeed_m_s:0}),wall=laminarAnnulus({...q,gradient_Pa_m:0})
  expect(pressure.wallCurrent_m3_s).toBe(0)
  expect(pressure.pressureCurrent_m3_s).toBeGreaterThan(0)
  expect(wall.pressureCurrent_m3_s).toBe(0)
  expect(wall.current_m3_s).toBeGreaterThan(0)
  expect(wall.bodyViscousForce_N).toBeLessThan(0)
  const reverse=laminarAnnulus({...q,gradient_Pa_m:-q.gradient_Pa_m,bodySpeed_m_s:-q.bodySpeed_m_s}),normal=laminarAnnulus(q)
  expect(reverse.current_m3_s).toBe(-normal.current_m3_s)
  expect(reverse.bodyViscousForce_N).toBe(-normal.bodyViscousForce_N)
  expect(reverse.dissipation_W).toBe(normal.dissipation_W)
 })
 test('narrow clearance raises passive wall resistance, not free insertion',()=>{
  const wide=laminarAnnulus({...q,gradient_Pa_m:0}),narrow=laminarAnnulus({...q,innerRadius_m:.0054,gradient_Pa_m:0})
  expect(narrow.conductance_m4_Pa_s).toBeLessThan(wide.conductance_m4_Pa_s)
  expect(narrow.bodyViscousForce_N).toBeLessThan(wide.bodyViscousForce_N)
  expect(()=>laminarAnnulus({...q,innerRadius_m:q.outerRadius_m})).toThrow()
  expect(()=>laminarAnnulus({...q,viscosity_Pa_s:0})).toThrow()
 })
 test('independent radial quadrature confirms exact current and dissipation',()=>{
  const ro=q.outerRadius_m,ri=q.innerRadius_m,log=Math.log(ro/ri),delta=ro*ro-ri*ri,N=2000,dr=(ro-ri)/N
  let flow=0,dissipation=0
  for(let i=0;i<=N;i++){
   const r=ri+i*dr,w=i===0||i===N?1:i%2?4:2,
    velocity=q.bodySpeed_m_s*Math.log(ro/r)/log+q.gradient_Pa_m/(4*q.viscosity_Pa_s)*(ro*ro-r*r-delta*Math.log(ro/r)/log),
    derivative=-q.bodySpeed_m_s/(r*log)+q.gradient_Pa_m/(4*q.viscosity_Pa_s)*(-2*r+delta/(r*log))
   flow+=w*2*Math.PI*r*velocity;dissipation+=w*2*Math.PI*r*q.length_m*q.viscosity_Pa_s*derivative*derivative
  }
  const exact=laminarAnnulus(q)
  expect(flow*dr/3).toBeCloseTo(exact.current_m3_s,14)
  expect(dissipation*dr/3).toBeCloseTo(exact.dissipation_W,12)
 })
 test('turbulent enhancement keeps the same reciprocal force/work sign',()=>{
  for(const current of [-1e-4,0,1e-4])for(const speed of [-2,0,2]){
   const r=annulusResistance({outerRadius_m:q.outerRadius_m,innerRadius_m:q.innerRadius_m,length_m:q.length_m,viscosity_Pa_s:q.viscosity_Pa_s,density_kg_m3:996.556,current_m3_s:current,bodySpeed_m_s:speed,roughness_m:.000002})
   expect(r.enhancement).toBeGreaterThanOrEqual(1)
   expect(r.dissipation_W).toBeGreaterThanOrEqual(0)
   expect(r.work_W).toBeCloseTo(r.dissipation_W,8)
  }
 })
 test('consumed record cannot be absent or ambiguous',()=>{
  expect(()=>parseControlAbsorber('')).toThrow('one')
  expect(()=>parseControlAbsorber('```reference-control-absorber\n{}\n```\n')).toThrow()
 })
 test('gap spring stores one finitejoule, not a new rod release store',()=>{
  const r=gapReleaseLimit({gapArmature_kg:1,gapSpring_N_m:20000,gapDamping_N_s_m:20,gapStroke_m:.01})
  expect(r.initialSpring_J).toBe(1)
  expect(r.dampingHeat_J).toBeGreaterThan(0)
  expect(r.stopHeat_J).toBeGreaterThan(0)
  expect(r.dampingHeat_J+r.stopHeat_J).toBeCloseTo(r.initialSpring_J,14)
  expect(r.gapFirstEntry_s).toBeGreaterThan(0)
 })
 test('reference, body, failed-head coupling and slip pay the same ledger',()=>{
  const cases=[{traction_N:400,referenceSpeed_m_s:.008,bodySpeed_m_s:.008,headSpeed_m_s:0,deliveredPower_W:10},
   {traction_N:400,referenceSpeed_m_s:-.008,bodySpeed_m_s:-.008,headSpeed_m_s:0,deliveredPower_W:10},
   {traction_N:2000,referenceSpeed_m_s:.02,bodySpeed_m_s:0,headSpeed_m_s:.02,deliveredPower_W:0},
   {traction_N:400,referenceSpeed_m_s:.02,bodySpeed_m_s:.02,headSpeed_m_s:.02,deliveredPower_W:0}]
  for(const q of cases){const r=gripWork(q);expect(r.mechanicalDefect_W).toBeCloseTo(0,12);expect(r.totalDefect_W).toBeCloseTo(0,12);expect(r.slipHeat_W).toBeGreaterThanOrEqual(0)}
  expect(gripWork(cases[2]!).slipHeat_W).toBe(40)
  expect(()=>gripWork({...cases[0]!,deliveredPower_W:0})).toThrow('unpaid')
  expect(()=>gripWork({...cases[0]!,bodySpeed_m_s:.02})).toThrow('Nonpassive')
 })
 test('simultaneous actual slip, stick reaction and shared power admit only paid candidates',()=>{
  const q={gap_m:0,gapStroke_m:.01,closedForce_N:2000,requiredStickForce_N:400,bodyHeadRelativeSpeed_m_s:.008,referenceHeadRelativeSpeed_m_s:.008,deliveredPower_W:1000/52,efficiency:.8}
  const healthy=gripCapacity(q);expect(healthy.stick).toBeTrue();expect(healthy.traction_N).toBe(400);expect(healthy.referenceHeadRelativeSpeed_m_s).toBe(.008)
  expect(()=>gripCapacity({...q,requiredStickForce_N:3000})).toThrow('Overloaded stick')
  const paid=gripCapacity({...q,bodyHeadRelativeSpeed_m_s:0,referenceHeadRelativeSpeed_m_s:.007});expect(paid.stick).toBeFalse();expect(paid.traction_N).toBe(2000);expect(paid.motiveWork_W).toBe(14)
  const half=gripCapacity({...q,gap_m:.005,bodyHeadRelativeSpeed_m_s:0});expect(half.capacity_N).toBe(1000);expect(half.stick).toBeFalse()
  const disconnected=gripCapacity({...q,gap_m:.01,requiredStickForce_N:0,deliveredPower_W:0});expect(disconnected.traction_N).toBe(0)
  expect(()=>gripCapacity({...q,deliveredPower_W:0})).toThrow('Unpaid motive')
  expect(()=>gripCapacity({...q,gap_m:.011})).toThrow()
 })
 test('power limits cannot reverse slip with a stale traction sign',()=>{
  const q={gap_m:0,gapStroke_m:.01,closedForce_N:2000,requiredStickForce_N:400,bodyHeadRelativeSpeed_m_s:.007,referenceHeadRelativeSpeed_m_s:.008,deliveredPower_W:1,efficiency:.8}
  expect(()=>gripCapacity(q)).toThrow('Unpaid motive')
  const backdriven=gripCapacity({...q,referenceHeadRelativeSpeed_m_s:.0004})
  expect(backdriven.traction_N).toBe(-2000);expect(backdriven.motiveWork_W).toBe(-.8);expect(backdriven.slipHeat_W).toBeCloseTo(13.2,12)
  const reverse=gripCapacity({...q,bodyHeadRelativeSpeed_m_s:-.007,referenceHeadRelativeSpeed_m_s:-.0004})
  expect(reverse.traction_N).toBe(2000);expect(reverse.slipHeat_W).toBeCloseTo(backdriven.slipHeat_W,12)
  const head=gripCapacity({...q,bodyHeadRelativeSpeed_m_s:-.02,referenceHeadRelativeSpeed_m_s:0,deliveredPower_W:0})
  const ledger=gripWork({traction_N:head.traction_N,referenceSpeed_m_s:.02,bodySpeed_m_s:0,headSpeed_m_s:.02,deliveredPower_W:0})
  expect(ledger.slipHeat_W).toBe(40);expect(ledger.totalDefect_W).toBe(0)
 })
})
