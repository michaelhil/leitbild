/** Offline turning-drive work comparison; not installed LD-01 equipment. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { generatorParameters, parseGenerator } from './reference-design-generator'

const pos = z.number().finite().positive()
const schema = z.object({ ratio: pos, motorInertia_kg_m2: pos, motorDrag_Nm_per_rad_s: pos,
  target_rpm: pos, clutchTorque_Nm: pos, slipScale_rad_s: pos,
  driveGain_Nm_per_rad_s: pos, driveTorqueLimit_Nm: pos, efficiency: pos.lt(1),
  energizedLoss_W: pos, motorBudget_W: pos, bodyCapacity_J_K: pos,
  oilConductance_W_K: pos, stroke_s: pos }).strict()
export function parseTurning(document: string) {
  const blocks = [...document.matchAll(/^```reference-turning\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-turning block')
  const b = schema.parse(JSON.parse(blocks[0]![1]!))
  return b
}
export function turningParameters(b: ReturnType<typeof parseTurning>, shaft: { inertia: number; drag: number }) {
  if (![shaft.inertia,shaft.drag].every(n=>Number.isFinite(n)&&n>0)) throw Error('Invalid retained shaft owner')
  const shaftSpeed = b.target_rpm*Math.PI/30, torque = shaft.drag*shaftSpeed
  if (torque >= b.clutchTorque_Nm) throw Error('Clutch cannot carry selected steady turning drag')
  const motorSpeed = b.ratio*(shaftSpeed+b.slipScale_rad_s*Math.atanh(torque/b.clutchTorque_Nm))
  return { shaftSpeed, motorSpeed, shaftInertia:shaft.inertia,shaftDrag:shaft.drag,
    torqueReference: torque/b.ratio+b.motorDrag_Nm_per_rad_s*motorSpeed }
}
export function turningExchange(b: ReturnType<typeof parseTurning>, motorSpeed: number, shaftSpeed: number, opening: number) {
  if (![motorSpeed,shaftSpeed,opening].every(Number.isFinite) || opening<0 || opening>1) throw Error('Invalid achieved clutch state')
  const slip = motorSpeed/b.ratio-shaftSpeed
  const torque = opening*b.clutchTorque_Nm*Math.tanh(slip/b.slipScale_rad_s)
  return { shaftTorque: torque, motorTorque: -torque/b.ratio, heat_W: torque*slip }
}

export const turningCalculation = String.raw`
import json,sys,math
import numpy as np,scipy
from scipy.integrate import solve_ivp
d=json.load(sys.stdin);b=d['basis'];a=d['parameters'];checks=[]
def require(name,ok,**values):
 if not ok:raise ValueError((name,values))
 checks.append(dict(name=name,**values))
G=b['ratio'];Jm=b['motorInertia_kg_m2'];Js=a['shaftInertia'];dm=b['motorDrag_Nm_per_rad_s'];ds=a['shaftDrag'];C=b['bodyCapacity_J_K'];Go=b['oilConductance_W_K'];To=303.15
def exchange(wm,ws,opening):
 slip=wm/G-ws;tc=opening*b['clutchTorque_Nm']*math.tanh(slip/b['slipScale_rad_s'])
 return tc,tc*slip
for wm in [0.,a['motorSpeed'],2*a['motorSpeed']]:
 for ws in [0.,a['shaftSpeed'],5*math.pi/30,1500*math.pi/30,-math.pi/30]:
  tc,q=exchange(wm,ws,1.)
  require('passive bidirectional clutch work',q>=0 and abs(tc*ws-tc*wm/G+q)<1e-8,motor_rad_s=wm,shaft_rad_s=ws,heat_W=q)
tc,q=exchange(a['motorSpeed'],a['shaftSpeed'],1.)
require('actual steady turning torque',abs(tc-ds*a['shaftSpeed'])<1e-8 and a['torqueReference']<b['driveTorqueLimit_Nm'],motor_rad_s=a['motorSpeed'],shaft_rpm=a['shaftSpeed']*30/math.pi,shaftTorque_Nm=tc,clutchHeat_W=q)
P=a['torqueReference']*a['motorSpeed']/b['efficiency']+b['energizedLoss_W']
require('steady paid motor fits actual feeder',P<b['motorBudget_W'],electric_W=P)
cases=[]
# Shaft turbine/generator torques are absent boundaries in these named apparatus cases.
fixtures=[('start',0.,0.,60.),('release',a['motorSpeed'],a['shaftSpeed'],10.),('loss-failed-release',a['motorSpeed'],a['shaftSpeed'],30.),('shaft-backdrive',a['motorSpeed'],5*math.pi/30,10.),('false-low-speed-engage',a['motorSpeed'],1500*math.pi/30,1.)]
for name,wm0,ws0,duration in fixtures:
 def opening(t):
  if name=='start':return min(1.,t/b['stroke_s'])
  if name=='release':return max(0.,1.-t/b['stroke_s'])
  return 1.
 def rhs(t,y):
  wm,ws,T=y[:3];tc,q=exchange(wm,ws,opening(t))
  powered=name not in ['release','loss-failed-release']
  # Nonregenerative forward drive disables motive torque during actual reverse rotation.
  tm=min(b['driveTorqueLimit_Nm'],max(0.,a['torqueReference']+b['driveGain_Nm_per_rad_s']*(a['motorSpeed']-wm))) if powered and wm>=0 else 0.
  mech=tm*wm;electric=mech/b['efficiency']+(b['energizedLoss_W'] if powered else 0.)
  if electric>b['motorBudget_W']+1e-6:raise ValueError('Fixture exceeds actual feeder; feeder action not implemented in this coupon')
  qm=dm*wm*wm;qs=ds*ws*ws;loss=electric-mech;qo=Go*(T-To)
  return [(tm-tc/G-dm*wm)/Jm,(tc-ds*ws)/Js,(q+qm+loss-qo)/C,electric,qs+qo]
 y0=[wm0,ws0,To,0.,0.]
 out=solve_ivp(rhs,(0,duration),y0,method='Radau',rtol=1e-9,atol=1e-10,max_step=.02,t_eval=np.linspace(0,duration,301))
 require(name+' finite advance',out.success)
 E0=.5*Jm*wm0*wm0+.5*Js*ws0*ws0
 defects=[.5*Jm*y[0]**2+.5*Js*y[1]**2+C*(y[2]-To)-E0-y[3]+y[4] for y in out.y.T]
 require(name+' mechanical body oil electric ledger',max(abs(np.array(defects)))<.1,maxDefect_J=max(abs(np.array(defects))))
 if name=='start':require('start approaches finite selected turning speed',abs(out.y[1,-1]-a['shaftSpeed'])<1e-4)
 if name=='shaft-backdrive':require('backdrive retains finite motor acceleration',max(out.y[0])>a['motorSpeed'])
 if name=='release':require('release removes clutch not shaft energy',out.y[1,-1]>0 and opening(duration)==0)
 if name=='loss-failed-release':require('lost motive with stuck clutch coasts not speed resets',0<out.y[1,-1]<ws0)
 if name=='false-low-speed-engage':require('false indication does not clamp physical shaft',out.y[1,-1]>1490*math.pi/30 and max(out.y[0])>a['motorSpeed'],shaftEnd_rpm=out.y[1,-1]*30/math.pi,motorMax_rpm=max(out.y[0])*30/math.pi)
 cases.append(dict(name=name,duration_s=duration,shaftEnd_rpm=out.y[1,-1]*30/math.pi,motorMax_rpm=max(out.y[0])*30/math.pi,bodyRise_K=out.y[2,-1]-To,electric_J=out.y[3,-1],oilReceipt_J=out.y[4,-1],maxDefect_J=max(abs(np.array(defects)))))
print(json.dumps(dict(libraries=dict(SciPy=scipy.__version__,NumPy=np.__version__),checks=checks,cases=cases)))
`
if (import.meta.main) {
  const [owner,generatorOwner,python,receipt,...rest] = Bun.argv.slice(2)
  if (!owner || !generatorOwner || !python || !receipt || rest.length) throw Error('Usage: turning <owner.md> <generator-owner.md> <research-python> <receipt.json>')
  const text=await Bun.file(owner).text(), generatorText=await Bun.file(generatorOwner).text(), basis=parseTurning(text)
  const machine=generatorParameters(parseGenerator(generatorText))
  const parameters=turningParameters(basis,{inertia:machine.inertia,drag:500000/machine.speed**2})
  const input=JSON.stringify({basis,parameters}), proc=Bun.spawn([python,'-c',turningCalculation],{stdin:new Blob([input]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited])
  if (code) throw Error(err)
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const result={scope:'Finite two-rotor turning/slip/body work; ideal acquired drive speed, supplied oil temperature, no achieved steam rolling or equipment survival',sourceSHA256:hash(await Bun.file(import.meta.path).text()),generatorHelperSHA256:hash(await Bun.file(new URL('./reference-design-generator.ts',import.meta.url)).text()),reviewedOwnerSHA256:hash(text),reviewedGeneratorOwnerSHA256:hash(generatorText),calculationSHA256:hash(turningCalculation),consumedInputSHA256:hash(input),basis,parameters,...JSON.parse(out)}
  await Bun.write(receipt,JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify({receipt,checks:result.checks.length,cases:result.cases,parameters}))
}
