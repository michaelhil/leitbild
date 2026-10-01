/** Bounded oil-circuit design check, not installed equipment or a plant solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { signedLiquidPump } from './reference-design-hydraulics'

const pos = z.number().finite().positive(), ratio = pos.lt(1)
const schema = z.object({ density_kg_m3: pos, heatCapacity_J_kg_K: pos, oilVolume_m3: pos,
  coolerOilVolume_m3: pos, combinedCapacity_J_K: pos, coolerConductance_W_K: pos,
  waterVolume_m3: pos, bearingResistance_Pa_s_m3: pos, laminarPressureFraction: ratio,
  viscosityReference_K: pos, viscositySlope_K_inverse: pos, pumpSpeed_rad_s: pos,
  shapeFraction: ratio, mainFlow_m3_s: pos, standbyFlow_m3_s: pos, hydraulicEfficiency: ratio,
  motorEfficiency: ratio, mainDrag_W: pos, standbyDrag_W: pos, mainInertia_kg_m2: pos,
  standbyInertia_kg_m2: pos, mainMotorBudget_W: pos, standbyMotorBudget_W: pos,
  mainDriveGain_N_m_per_rad_s: pos, standbyDriveGain_N_m_per_rad_s: pos,
  mainTorqueLimit_N_m: pos, standbyTorqueLimit_N_m: pos,
  mainEnergizedLoss_W: pos, standbyEnergizedLoss_W: pos }).strict()
export function parseLubrication(document: string) {
  const blocks = [...document.matchAll(/^```reference-lubrication\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-lubrication block')
  const b = schema.parse(JSON.parse(blocks[0]![1]!))
  if (b.coolerOilVolume_m3 >= b.oilVolume_m3 || b.combinedCapacity_J_K <= b.oilVolume_m3*b.density_kg_m3*b.heatCapacity_J_kg_K)
    throw Error('Oil volume/capacity is not disjoint and positive')
  return b
}
export function lubricationParameters(b: ReturnType<typeof parseLubrication>) {
  const rho = b.density_kg_m3, w = b.pumpSpeed_rad_s, q = b.mainFlow_m3_s
  const drop = b.bearingResistance_Pa_s_m3*q
  const orificeArea = q*Math.sqrt(rho/(2*(1-b.laminarPressureFraction)*drop))
  const laminarResistance = b.laminarPressureFraction*b.bearingResistance_Pa_s_m3
  const pressure = (flow: number) => laminarResistance*flow + rho*flow*flow/(2*orificeArea**2)
  const pump = (flow: number, drag: number) => {
    const dp = pressure(flow), e = dp/(rho*b.hydraulicEfficiency)
    const a = e/((1-b.shapeFraction)*w*w), beta = b.shapeFraction*a*w/flow
    const resistance = (rho*e-dp)/(rho*flow*flow)
    const actual = signedLiquidPump(rho, flow, w, a, beta, resistance)
    return { flow, dp, a, beta, resistance, drag: drag/(w*w),
      torqueReference: actual.torque+drag/w, fluidPowerReference: actual.power }
  }
  const coolerCapacity = b.coolerOilVolume_m3*rho*b.heatCapacity_J_kg_K
  return { orificeArea, laminarResistance, coolerCapacity,
    bulkCapacity: b.combinedCapacity_J_K-coolerCapacity,
    main: pump(q, b.mainDrag_W), standby: pump(b.standbyFlow_m3_s,b.standbyDrag_W) }
}

export const lubricationCalculation = String.raw`
import json,sys,math
import numpy as np
import scipy
from scipy.optimize import brentq
from scipy.integrate import solve_ivp
from CoolProp.CoolProp import PropsSI
d=json.load(sys.stdin);b=d['basis'];a=d['parameters'];checks=[]
rho=b['density_kg_m3'];cp=b['heatCapacity_J_kg_K'];w0=b['pumpSpeed_rad_s'];q0=b['mainFlow_m3_s'];dp0=b['bearingResistance_Pa_s_m3']*q0
def require(name,ok,**v):
 if not ok:raise ValueError((name,v))
 checks.append(dict(name=name,**v))
def pumpq(p,w,pump):
 h=pump['a']*w*w-p/rho
 if h<=0:return 0. # Declared healthy unilateral discharge check, not a flow clamp.
 beta=pump['beta']*w;r=pump['resistance']
 return 2*h/(beta+math.sqrt(beta*beta+4*r*h))
def load(pump,q,w):return rho*q*(pump['a']*w-pump['beta']*abs(q))+pump['drag']*w
def motor(pump,w,K,cap):return min(cap,max(0.,pump['torqueReference']+K*(w0-w)))
def hydraulic(wmain,wstandby,Tmean,fraction=.2,blocked=False):
 mu=math.exp(-b['viscositySlope_K_inverse']*(Tmean-b['viscosityReference_K']))
 def branches(p):return (pumpq(p,wmain,a['main']),pumpq(p,wstandby,a['standby']))
 maxp=max(rho*a['main']['a']*wmain*wmain,rho*a['standby']['a']*wstandby*wstandby)
 if blocked:return maxp,0.,0.
 if maxp==0:return 0.,0.,0.
 def law(p):
  qm,qs=branches(p);q=qm+qs
  return p-fraction*dp0/q0*mu*q-(1-fraction)*dp0/(q0*q0)*q*q
 p=brentq(law,0.,maxp,xtol=1e-7);qm,qs=branches(p)
 return p,qm,qs
def operating(Tmean,main=True,standby=False,fraction=.2,blocked=False):
 def residual(w):
  p,qm,qs=hydraulic(w if main else 0.,w if standby else 0.,Tmean,fraction,blocked)
  pump=a['main'] if main else a['standby'];q=qm if main else qs
  return motor(pump,w,b['mainDriveGain_N_m_per_rad_s'] if main else b['standbyDriveGain_N_m_per_rad_s'],b['mainTorqueLimit_N_m'] if main else b['standbyTorqueLimit_N_m'])-load(pump,q,w)
 w=brentq(residual,0.,w0*2,xtol=1e-11)
 p,qm,qs=hydraulic(w if main else 0.,w if standby else 0.,Tmean,fraction,blocked)
 pump=a['main'] if main else a['standby'];q=qm if main else qs
 shaft=load(pump,q,w)*w;electrical=shaft/b['motorEfficiency']+(b['mainEnergizedLoss_W'] if main else b['standbyEnergizedLoss_W'])
 return dict(speed=w,pressure=p,flow=q,oilPower=shaft,electrical=electrical)
for main in [True,False]:
 out=operating(313.15,main,not main)
 require('actual reference rotor/header intersection',abs(out['speed']-w0)<1e-9 and abs(out['flow']-(q0 if main else b['standbyFlow_m3_s']))<1e-10,**out)
 require('actual reference motor budget',out['electrical']<(b['mainMotorBudget_W'] if main else b['standbyMotorBudget_W']),**out)
blocked=operating(313.15,True,False,blocked=True)
require('blocked return finite shutoff and paid rotor drag',blocked['flow']==0 and 0<blocked['speed']<2*w0 and blocked['oilPower']>0 and blocked['electrical']<b['mainMotorBudget_W'],**blocked)
p,qm,qs=hydraulic(w0,w0,313.15)
require('parallel pumps share actual header rather than imposed flows',qm>0 and qs==0 and abs(p-dp0)<1e-6,pressure=p,mainFlow=qm,standbyFlow=qs)
# A finite native jacket, with supplied CCW boundary, for a steady selection comparison.
Pw=.5e6;Tsup=303.15;mw=100.;hs=PropsSI('Hmass','P',Pw,'T',Tsup,'Water');shaftheat=1030.662217e6*.005
def steady(fraction,hotreturn=False):
 def point(Tmean):
  o=operating(Tmean,fraction=fraction);Q=shaftheat+o['oilPower']
  Tw=PropsSI('T','P',Pw,'Hmass',hs+Q/mw,'Water');Tc=Tw+Q/b['coolerConductance_W_K'];Tb=Tc+Q/(rho*cp*o['flow'])
  return o,Tb,Tc,Tw,Q
 Tmean=brentq(lambda t:(point(t)[1] if hotreturn else .5*(point(t)[1]+point(t)[2]))-t,300.,400.,xtol=1e-9)
 o,Tb,Tc,Tw,Q=point(Tmean)
 return dict(fraction=fraction,hotReturn=hotreturn,mean_K=Tmean,bulk_K=Tb,cooler_K=Tc,water_K=Tw,heat_W=Q,**o)
steadycases=[steady(f) for f in [.2,.5,1.]];selected=steadycases[0]
require('selected actual normal flow and finite jacket steady capacity',selected['bulk_K']<380 and selected['pressure']>.2e6 and 298.15<selected['cooler_K']<338.15,**selected)
# The all-laminar sensitivity is reported, not required to meet unchanged permission.
for s in steadycases:require('same immutable pumps return honest pressure sensitivity',math.isfinite(s['pressure']) and s['flow']>0,**s)
hotcases=[steady(f,True) for f in [.2,.5,1.]]
require('selected fixed feed orifice survives adverse hot return viscosity',hotcases[0]['pressure']>.2e6 and hotcases[0]['bulk_K']<380,**hotcases[0])
require('pure laminar hot return really loses unchanged rolling permission',hotcases[-1]['pressure']<.2e6,**hotcases[-1])
# Actual finite pump rotor and input/oil ledger; thermal states fixed apparatus inputs.
rotorcases=[]
for name,main,T,blocked,start,powered in [('main-start',True,313.15,False,0.,True),('main-cold-start',True,293.15,False,0.,True),('standby-start',False,313.15,False,0.,True),('main-deadhead',True,313.15,True,w0,True),('main-supply-loss',True,313.15,False,w0,False)]:
 pump=a['main'] if main else a['standby'];J=b['mainInertia_kg_m2'] if main else b['standbyInertia_kg_m2'];budget=b['mainMotorBudget_W'] if main else b['standbyMotorBudget_W'];K=b['mainDriveGain_N_m_per_rad_s'] if main else b['standbyDriveGain_N_m_per_rad_s'];cap=b['mainTorqueLimit_N_m'] if main else b['standbyTorqueLimit_N_m'];driveheat=b['mainEnergizedLoss_W'] if main else b['standbyEnergizedLoss_W']
 def rhsrotor(t,y):
  w=y[0];p,qm,qs=hydraulic(w if main else 0.,0. if main else w,T,blocked=blocked);q=qm if main else qs
  tm=motor(pump,w,K,cap) if powered else 0.;po=load(pump,q,w)*w;pm=tm*w;pe=pm/b['motorEfficiency']+driveheat if powered else 0.
  if pe>budget:raise ValueError('Actual drive request exceeds its physical budget')
  return [(tm-load(pump,q,w))/J,pm,po,pe-pm]
 ro=solve_ivp(rhsrotor,(0,10),[start,0,0,0],method='Radau',rtol=1e-9,atol=1e-10,t_eval=np.linspace(0,10,101))
 defect=.5*J*(ro.y[0]**2-start**2)-ro.y[1]+ro.y[2]
 require(name+' finite rotor work and no captured speed',ro.success and max(abs(defect))<1e-4,endSpeed_rad_s=float(ro.y[0,-1]),maxRotorDefect_J=float(max(abs(defect))),oilWork_J=float(ro.y[2,-1]),roomHeat_J=float(ro.y[3,-1]))
 rotorcases.append(dict(name=name,endSpeed_rad_s=float(ro.y[0,-1]),maxRotorDefect_J=float(max(abs(defect)))))
# Zero oil-flow energy is exact: hot bulk is disconnected from the colder cooler.
Tb0=353.15;Tc0=313.15;Tw0=303.15;duration=600.;Cb=a['bulkCapacity'];Cc=a['coolerCapacity'];Mw=PropsSI('Dmass','P',Pw,'T',Tw0,'Water')*b['waterVolume_m3'];Cw=Mw*PropsSI('Cpmass','P',Pw,'T',Tw0,'Water');G=b['coolerConductance_W_K']
# Fixed native tangent capacity apparatus; not a thermodynamic-volume transient.
Teq=(Cc*Tc0+Cw*Tw0)/(Cc+Cw);rate=G*(1/Cc+1/Cw);Tc=Teq+(Tc0-Teq)*math.exp(-rate*duration);Tw=Teq+(Tw0-Teq)*math.exp(-rate*duration)
require('no-flow cooler cannot cool whole hot bulk',abs(Cc*(Tc-Tc0)+Cw*(Tw-Tw0))<1e-5 and Tb0==353.15,coolerEnd_K=Tc,waterEnd_K=Tw,bulkEnd_K=Tb0)
exitTime=(380.-Tb0)*Cb/shaftheat;admittedTime=min(duration,exitTime);bulkEnd=Tb0+shaftheat*admittedTime/Cb
require('continuing shaft heat reaches an honest oil-domain boundary',abs((bulkEnd-Tb0)*Cb-shaftheat*admittedTime)<1e-4 and exitTime<duration,firstDomainExit_s=exitTime,admittedEnd_K=bulkEnd,requestedDuration_s=duration,continuation='Unresolved beyond380K; not clamped cooling or a600s admitted trajectory')
# Lost CCW: all stores retain heat, not an infinite inlet bath.
q=selected['flow'];mcp=rho*cp*q;Q=selected['heat_W']
def rhs(t,y):
 adv=mcp*(y[0]-y[1]);contact=G*(y[1]-y[2])
 return [(Q-adv)/Cb,(adv-contact)/Cc,contact/Cw]
out=solve_ivp(rhs,(0,600),[selected['bulk_K'],selected['cooler_K'],selected['water_K']],method='Radau',rtol=1e-9,atol=1e-10,t_eval=np.linspace(0,600,101))
defects=Cb*(out.y[0]-out.y[0,0])+Cc*(out.y[1]-out.y[1,0])+Cw*(out.y[2]-out.y[2,0])-Q*out.t
require('lost CCW tangent-capacity ledger and retained warming',out.success and max(abs(defects))<1e-3 and out.y[2,-1]>out.y[2,0],maxDefect_J=float(max(abs(defects))),bulkEnd_K=float(out.y[0,-1]),waterEnd_K=float(out.y[2,-1]))
standby=operating(313.15,False,True);standing=2000.;battery=16000*3600
require('standby fits instantaneous group budget while another motion may overload',standing+standby['electrical']<20000 and standing+standby['electrical']+19000>20000,actualCombined_W=standing+standby['electrical'])
endurance=battery/(standing+standby['electrical'])
require('finite unsupported DC source endurance is not perpetual',0<endurance<8*3600,endurance_s=endurance)
# Deliberately retained adverse long-time comparison: closed zero-steam drag-only
# shaft may still rotate when this shared DC stock expires. No guaranteed safe coast.
Jshaft=2*5500e6/w0**2;dragshaft=500000/w0**2;remaining=w0*math.exp(-dragshaft/Jshaft*endurance)
require('oil battery exhaustion is not shaft stopped or safe coast',remaining>3*2*math.pi/60,endurance_s=endurance,remainingShaft_rpm=remaining*60/(2*math.pi))
print(json.dumps(dict(checks=checks,steady=steadycases,hotReturnSensitivity=hotcases,rotorCases=rotorcases,referenceStandby=standby,blocked=blocked,dependencies=dict(scipy=scipy.__version__),scope='Original finite centrifugal oil circuit; supplied native steady jacket and fixed-tangent thermal limiting apparatus, not coupled plant coast/bearing survival')))
`

if (import.meta.main) {
  const [owner, python, output, ...extra] = Bun.argv.slice(2)
  if (!owner || !python || !output || extra.length) throw Error('Usage: lubrication <owner.md> <research-python> <receipt.json>')
  const content = await Bun.file(owner).text(), basis = parseLubrication(content), parameters = lubricationParameters(basis)
  const input = JSON.stringify({basis,parameters})
  const child = Bun.spawn([python,'-c',lubricationCalculation], {stdin:new TextEncoder().encode(input),stdout:'pipe',stderr:'pipe'})
  const [out,err,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if (code !== 0) throw Error(`Oil reference failed: ${err}`)
  if (await Bun.file(owner).text() !== content) throw Error('Oil owner changed during calculation')
  const hash = (s:string) => createHash('sha256').update(s).digest('hex')
  const receipt = {ownerSha256:hash(content),sourceSha256:hash(await Bun.file(import.meta.path).text()),inputSha256:hash(input),calculationSha256:hash(lubricationCalculation),input:JSON.parse(input),result:JSON.parse(out)}
  await Bun.write(output,JSON.stringify(receipt,null,2)+'\n')
  console.log(JSON.stringify({output,checks:receipt.result.checks.length,steady:receipt.result.steady,standby:receipt.result.referenceStandby}))
}
