import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {assertSprayParents,parseSprayTransfer} from './reference-design-pressurizer-spray-transfer'
import {normalDeliveryPython} from './reference-design-pressurizer-normal-delivery'
import {normalThermalPython} from './reference-design-pressurizer-normal-thermal'

const selected={tipRingRadius_m:.4,coneHalfAngle_deg:30,diameterFactor:2,flightHorizon_s:120}
const block=(value:unknown)=>'```reference-pressurizer-spray-transfer\n'+JSON.stringify(value)+'\n```\n'
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')

test('standalone actual-source spray declaration rejects absent, duplicated and unsupported inputs',()=>{
  expect(parseSprayTransfer(block(selected))).toEqual(selected)
  expect(()=>parseSprayTransfer('')).toThrow()
  expect(()=>parseSprayTransfer(block(selected)+block(selected))).toThrow()
  for(const changed of [{tipRingRadius_m:-1},{coneHalfAngle_deg:90},{diameterFactor:0},{flightHorizon_s:0},{imposedLanding_kg_s:.1}])
    expect(()=>parseSprayTransfer(block({...selected,...changed}))).toThrow()
})

test('frozen hydraulic and thermal parents must match actual emitted calculations and exact receipt bytes',()=>{
  const thermal={calculationSha256:hash(normalThermalPython)}
  const bytes=JSON.stringify(thermal)
  const delivery={calculationSha256:hash(normalDeliveryPython),normalReceiptSha256:hash(bytes)}
  expect(()=>assertSprayParents(thermal,delivery,bytes)).not.toThrow()
  expect(()=>assertSprayParents({...thermal,calculationSha256:'old'},delivery,bytes)).toThrow()
  expect(()=>assertSprayParents(thermal,{...delivery,calculationSha256:'old'},bytes)).toThrow()
  expect(()=>assertSprayParents(thermal,delivery,bytes+'\n')).toThrow()
  expect(hash(normalThermalPython)).toBe('95d9fa5262887f80296463f854195f23377d81a18052e7d1dd0706bb49b52d5b')
})

test('cone orientation retains exit kinetic energy and exposes ballistic wall interception',()=>{
  const speed=5.6366,angle=selected.coneHalfAngle_deg*Math.PI/180
  const radial=speed*Math.sin(angle),down=speed*Math.cos(angle)
  expect(radial*radial+down*down).toBeCloseTo(speed*speed,12)
  const ballisticFall=(Math.sqrt(5/Math.PI)-selected.tipRingRadius_m)/Math.tan(angle)
  expect(ballisticFall).toBeGreaterThan(1.4)
  expect(ballisticFall).toBeLessThan(1.6)
  // This geometric warning is not the drag-integrated trajectory or an attained landing.
})

test('temperature-deficit chain rule independently preserves pressure work and signed heat',()=>{
  // Algebra-only fixture; actual EOS/flight qualification is retained separately.
  const rho=606,cp=8408,hp=-.004,TsPrime=5.2e-6,mass=1.33
  for(const pressureRate of [-900,0,900])for(const heat of [-20,0,20]){
    const thetaRate=(TsPrime+(hp-1/rho)/cp)*pressureRate-heat/(mass*cp)
    const enthalpyRate=cp*(TsPrime*pressureRate-thetaRate)+hp*pressureRate
    expect(enthalpyRate).toBeCloseTo(heat/mass+pressureRate/rho,12)
  }
  const logTheta=Math.log(.0000244),delta=1e-8,coefficient=400000
  const actualHeatIncrement=-coefficient*Math.exp(logTheta)*Math.expm1(delta)
  const linearHeatIncrement=-coefficient*Math.exp(logTheta)*delta
  expect(actualHeatIncrement/linearHeatIncrement).toBeCloseTo(1,7)
})
