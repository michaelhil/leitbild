import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {assertSprayParents,parseSprayTransfer,sprayTransferDefinitions} from './reference-design-pressurizer-spray-transfer'
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
  expect(hash(normalThermalPython)).toBe('b9292492c2a592b365bbb02ec126b68d92e56c9e5617ec7a35c07b491d6eea20')
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

test('actual source wrapper refuses unresolved hydraulics while coupled admission retains its defect',async()=>{
  // Execute the actual wrapper and admission expressions, not research EOS/ODE code.
  // The constitutive witness below is test-only; physical flight is independently replayed.
  const script=String.raw`
import ast,json,sys
tree=ast.parse(sys.stdin.read())
wrapper=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='flight')
evaluation=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='evaluate_flight')
returned=next(n.value for n in reversed(evaluation.body) if isinstance(n,ast.Return))
keys={'admitted','transferAdmission','sourceHydraulicAdmission','sourcePressureResidual_Pa'}
returned.keywords=[k for k in returned.keywords if k.arg in keys]
returned.args=[]
witness=ast.parse('def evaluate_flight(source,*args):\n admitted=True\n return None').body[0]
witness.body[-1]=ast.Return(returned)
module=ast.fix_missing_locations(ast.Module(body=[wrapper,witness],type_ignores=[]))
namespace={};exec(compile(module,'actual-spray-admission','exec'),namespace)
source=dict(name='fixture',mapPressureDomainAdmitted=True,hydraulicAdmission=False,energyAccountingAdmission=True,pressureResidual_Pa=17.5)
try:namespace['flight'](source);refused=False
except ValueError:refused=True
trial=namespace['evaluate_flight'](source)
source.update(hydraulicAdmission=True,pressureResidual_Pa=0.)
direct=namespace['evaluate_flight'](source);normal=namespace['flight'](source)
source['energyAccountingAdmission']=False
try:namespace['flight'](source);energyRefused=False
except ValueError:energyRefused=True
print(json.dumps(dict(refused=refused,trial=trial,direct=direct,normal=normal,energyRefused=energyRefused)))
`
  const p=Bun.spawn(['python3','-c',script],{stdin:'pipe',stdout:'pipe',stderr:'pipe'})
  p.stdin.write(sprayTransferDefinitions);p.stdin.end()
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited])
  if(code)throw Error(err)
  const result=JSON.parse(out)
  expect(result.refused).toBe(true)
  expect(result.energyRefused).toBe(true)
  expect(result.trial).toEqual({admitted:false,transferAdmission:true,sourceHydraulicAdmission:false,sourcePressureResidual_Pa:17.5})
  expect(result.normal).toEqual(result.direct)
  expect(result.normal.admitted).toBe(true)
})
