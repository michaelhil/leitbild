/** Native drain capacity and finite casing thermal coupons, not a startup plant simulator. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { pureWaterNozzleFunctions } from './reference-design-pure-water-nozzle'
const pos = z.number().finite().positive()
const schema = z.object({ hpCapacity_J_K:pos,lpCapacity_J_K:pos,hpContact_W_K:pos,lpContact_W_K:pos,
  roomContact_W_K:pos,drainCdA_m2:pos,drainStroke_s:pos,drainMotion_W:pos,
  warmDifference_K:pos,warmDuration_s:pos,maximumLiquidFraction:pos.lt(1) }).strict()
export function parseTurbinePreparation(document:string) {
  const blocks=[...document.matchAll(/^```reference-turbine-preparation\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-turbine-preparation block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function casingExchange(body:number,fluid:number,room:number,fluidContact:number,roomContact:number) {
  if(![body,fluid,room,fluidContact,roomContact].every(n=>Number.isFinite(n)&&n>0))throw Error('Invalid thermal inputs')
  const fromFluid=fluidContact*(fluid-body),toRoom=roomContact*(body-room)
  return { fluid_W:-fromFluid,body_W:fromFluid-toRoom,room_W:toRoom }
}
export const turbinePreparationCalculation=String.raw`
import json,sys,math,numpy as np,scipy,CoolProp
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
d=json.load(sys.stdin);b=d['basis'];exec(d['nozzleFunctions']);checks=[]
def require(name,ok,**values):
 if not ok:raise ValueError((name,values))
 checks.append(dict(name=name,**values))
capacities=[]
# Actual states here are prescribed pure-water face apparatus, not reached cold/hot plant stores.
for p in [.3e6,4e6,.2e6,.05e6]:
 for quality in [0.,1.]:
  h=P('Hmass','P',p,'Q',quality,'Water');T=P('T','P',p,'Q',quality,'Water')
  flow=b['drainCdA_m2']*waterflux_ph(p,h,12000.)
  require('positive native frozen drain flow',flow>0 and math.isfinite(flow),pressure_Pa=p,quality=quality,capacity_kg_s=flow)
  s=P('Smass','P',p,'Q',quality,'Water');receivedS=P('Smass','P',12000.,'Hmass',h,'Water')
  require('passive drain transfers enthalpy without fictitious shaft work',receivedS>=s-1e-7,pressure_Pa=p,quality=quality,entropyIncrease_J_kg_K=receivedS-s)
  capacities.append(dict(pressure_Pa=p,quality=quality,temperature_K=T,capacity_kg_s=flow,receivedEnthalpy_J_kg=h,receivedQuality=P('Q','P',12000.,'Hmass',h,'Water')))
require('native equal pressures give no drain flow',waterflux_ph(12000.,P('Hmass','P',12000.,'Q',1,'Water'),12000.)==0.)
require('full powered drain work is finite heat not stored spring',b['drainStroke_s']*b['drainMotion_W']==200.)
# COND z=0 point: a covered mouth has the actual hydrostatic receiving pressure.
# Pure-water native isentropic port-map limit, preserving h+gz (not an imposed constant-density head).
surfacePressure=12000.;surfaceT=313.15;hs=P('Hmass','P',surfacePressure,'T',surfaceT,'Water');ss=P('Smass','P',surfacePressure,'T',surfaceT,'Water')
receivers=[]
for height in [0.,3.,5.]:
 hf=hs+9.80665*height
 pf=surfacePressure if height==0 else brentq(lambda pp:P('Hmass','P',pp,'Smass',ss,'Water')-hf,surfacePressure,2e5,xtol=1e-5)
 # Native H(P,S) liquid inversion has ~4e-4 J/kg discontinuous return jitter here.
 # 0.01 J/kg is ~1 mm elevation / 10 Pa water head, below the owned 1 kPa pressure indication.
 faceDefect=P('Hmass','P',pf,'Smass',ss,'Water')-hf
 require('native covered COND mouth retains bounded height work',abs(faceDefect)<.01,cover_m=height,pressure_Pa=pf,faceDefect_J_kg=faceDefect)
 donorP=50000.;donorH=P('Hmass','P',donorP,'Q',0,'Water')
 signed=b['drainCdA_m2']*(waterflux_ph(donorP,donorH,pf) if donorP>pf else -waterflux_ph(pf,hf,donorP))
 require('closed casing drain cannot remove retained liquid',0.*signed==0.,cover_m=height)
 require('healthy check does not invent reversed discharge',max(0.,signed)>=0,cover_m=height,failedOpenSignedFlow_kg_s=signed)
 receivers.append(dict(cover_m=height,pressure_Pa=pf,enthalpy_J_kg=hf,failedOpenSignedFlow_kg_s=signed,healthyForwardFlow_kg_s=max(0.,signed)))
require('high covered COND mouth actually backfills failed-open LP drain',receivers[-1]['failedOpenSignedFlow_kg_s']<0.)
require('gas exposed mouth permits actual low-pressure liquid discharge',receivers[0]['failedOpenSignedFlow_kg_s']>0.)
thermal=[]
# Closed three-store apparatus: no inflow/drain/ROOM ventilation or imposed temperature.
# Each independent fixture uses one actual selected ROOM.B capacity, not four rooms in a plant.
for label,p,V,C,G in [('HP1',.3e6,10.,b['hpCapacity_J_K'],b['hpContact_W_K']),('HP2',4e6,20.,b['hpCapacity_J_K'],b['hpContact_W_K']),('LP1',.2e6,500.,b['lpCapacity_J_K'],b['lpContact_W_K']),('LP2',.05e6,1000.,b['lpCapacity_J_K'],b['lpContact_W_K'])]:
 rho=P('Dmass','P',p,'Q',1,'Water');M=rho*V;U0=M*P('Umass','P',p,'Q',1,'Water');Tw0=P('T','P',p,'Q',1,'Water');Tb0=313.15
 for scale in [.5,1.,2.]:
  endpoints=[]
  for dt in [10.,5.]:
   Tw,Tb,Tr,U=Tw0,Tb0,303.15,U0;Cr=2e8;Gr=b['roomContact_W_K'];E0=U0+C*Tb0+Cr*Tr;worst=0.;roomTransfer=0.
   for step in range(round(3600/dt)):
    gamma=dt*Gr*Cr/(Cr+dt*Gr)
    def body(t):return (C*Tb+dt*scale*G*t+gamma*Tr)/(C+dt*scale*G+gamma)
    def residual(t):return M*P('Umass','T',t,'Dmass',rho,'Water')-U+dt*scale*G*(t-body(t))
    # Passive positive-capacity stores bracket their genuine temperature extrema; no state clipping.
    tw=brentq(residual,min(Tw,Tb,Tr),max(Tw,Tb,Tr),xtol=1e-10);tb=body(tw);tr=(Cr*Tr+dt*Gr*tb)/(Cr+dt*Gr)
    U=M*P('Umass','T',tw,'Dmass',rho,'Water');roomTransfer+=dt*Gr*(tb-tr);Tw,Tb,Tr=tw,tb,tr
    worst=max(worst,abs(U+C*Tb+Cr*Tr-E0))
   pf=P('P','T',Tw,'Dmass',rho,'Water');quality=P('Q','T',Tw,'Dmass',rho,'Water')
   if not 0<=quality<=1:raise ValueError(('Fixture left declared two-phase endpoint',label,scale,quality))
   Vl=M*(1-quality)/P('Dmass','T',Tw,'Q',0,'Water');fraction=Vl/V
   require(label+' conservative fluid body ROOM energy',worst<1.,scale=scale,step_s=dt,maxDefect_J=worst)
   require(label+' finite body is not supplied steam temperature',Tb0<Tb<Tw0,scale=scale,step_s=dt)
   require(label+' actual condensation/depressurization retained',pf<p and Tw<Tw0 and Vl>0,scale=scale,step_s=dt)
   require(label+' actual ROOM receives signed retained heat',Tr>303.15 and abs(Cr*(Tr-303.15)-roomTransfer)<.1,scale=scale,step_s=dt)
   endpoints.append(dict(step_s=dt,body_K=Tb,fluid_K=Tw,room_K=Tr,pressure_Pa=pf,liquidFraction=fraction,liquid_kg=M*(1-quality),maxDefect_J=worst))
  errorT=max(abs(endpoints[0][key]-endpoints[1][key]) for key in ['body_K','fluid_K','room_K'])
  errorV=abs(endpoints[0]['liquidFraction']-endpoints[1]['liquidFraction'])
  require(label+' predeclared one-hour endpoint comparison',errorT<.1 and errorV<.0001,scale=scale,maxTemperatureDifference_K=errorT,liquidFractionDifference=errorV)
  thermal.append(dict(owner=label,scale=scale,duration_s=3600.,volume_m3=V,mass_kg=M,initialPressure_Pa=p,initialFluid_K=Tw0,endpoints=endpoints))
print(json.dumps(dict(libraries=dict(CoolProp=CoolProp.__version__,SciPy=scipy.__version__,NumPy=np.__version__),checks=checks,drainFaces=capacities,receivingMouth=receivers,thermal=thermal)))
`
if(import.meta.main) {
  const [owner,python,receipt,...rest]=Bun.argv.slice(2)
  if(!owner||!python||!receipt||rest.length)throw Error('Usage: turbine-preparation <owner.md> <research-python> <receipt.json>')
  const text=await Bun.file(owner).text(),basis=parseTurbinePreparation(text),input=JSON.stringify({basis,nozzleFunctions:pureWaterNozzleFunctions})
  const proc=Bun.spawn([python,'-c',turbinePreparationCalculation],{stdin:new Blob([input]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);if(code)throw Error(err)
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const result={scope:'Prescribed pure-water drain faces and native receiving-head limit; one-hour closed fluid/casing/ROOM coupons with no source/drain flow or room ventilation; endpoint comparison only, not achieved warming/rolling or equipment survival',sourceSHA256:hash(await Bun.file(import.meta.path).text()),reviewedOwnerSHA256:hash(text),nozzleFunctionsSHA256:hash(pureWaterNozzleFunctions),calculationSHA256:hash(turbinePreparationCalculation),consumedInputSHA256:hash(input),basis,...JSON.parse(out)}
  await Bun.write(receipt,JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify({receipt,checks:result.checks.length,drainFaces:result.drainFaces,thermal:result.thermal}))
}
