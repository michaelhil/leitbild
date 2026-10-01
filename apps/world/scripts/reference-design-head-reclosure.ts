/** Bounded original cold perimeter assessment; no plant, pressure solver or installed signal. */
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {z} from 'zod'
import {parseControlAbsorber} from './reference-design-control-absorber'

const positive=z.number().finite().positive()
const schema=z.object({minimumDP_Pa:positive,targetDP_Pa:positive,maximumDP_Pa:positive,
 window_s:positive,maximumWaterRate_kg_s:positive,maximumWaterTransfer_kg:positive,
 maximumChargeRequest_kg_s:positive,maximumHotPressure_Pa:positive,maximumWaterTemperature_K:positive,
 headDatum_m:z.number().finite(),dischargeCoefficient:positive.max(1),seatLandLength_m:positive,comparisonDefectLength_m:positive,
 comparisonTemperature_K:positive,comparisonWellTemperature_K:positive,comparisonWellPressure_Pa:positive,
 comparisonPrimaryTracerRatio:z.number().finite().nonnegative(),comparisonWellTracerRatio:z.number().finite().nonnegative(),
 comparisonPacket_kg:positive,comparisonCouponMass_kg:positive}).strict()
export type HeadReclosure=z.infer<typeof schema>
export function parseHeadReclosure(document:string):HeadReclosure{
 const blocks=[...document.matchAll(/^```reference-head-reclosure\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected exactly one reference-head-reclosure block')
 const b=schema.parse(JSON.parse(blocks[0]![1]!))
 if(!(b.minimumDP_Pa<b.targetDP_Pa&&b.targetDP_Pa<b.maximumDP_Pa)||b.maximumWaterTransfer_kg<b.maximumWaterRate_kg_s*b.window_s||b.comparisonPacket_kg>=b.comparisonCouponMass_kg)throw Error('Inconsistent cold perimeter objective')
 return b
}
export function perimeterAperture(area:number,mouth:number,gap:number,length:number,height:number){
 if(![area,mouth,gap,length,height].every(Number.isFinite)||area<=0||mouth<=0||mouth>area||gap<0||length<0||height<0)throw Error('Invalid actual perimeter aperture')
 const perimeter=2*Math.sqrt(Math.PI*area)
 if(length>perimeter)throw Error('Defect longer than actual perimeter')
 return Math.min(mouth,perimeter*gap+length*Math.max(height-gap,0))
}
/** Explicit incompressible comparison only; native land/nozzle series is authoritative. */
export function liquidSeatRate(q:{dp_Pa:number,density_kg_m3:number,viscosity_Pa_s:number,
 width_m:number,height_m:number,land_m:number,Cd:number}){
 if(!Object.values(q).every(Number.isFinite)||q.density_kg_m3<=0||q.viscosity_Pa_s<=0||q.width_m<0||q.height_m<0||q.land_m<=0||q.Cd<=0||q.Cd>1)throw Error('Invalid actual cold liquid seat state')
 if(q.width_m===0||q.height_m===0||q.dp_Pa===0)return {volumeRate_m3_s:0,massRate_kg_s:0,viscousDrop_Pa:0,entryDrop_Pa:0,dissipation_W:0}
 const R=12*q.viscosity_Pa_s*q.land_m/(q.width_m*q.height_m**3),K=q.density_kg_m3/(2*(q.Cd*q.width_m*q.height_m)**2)
 if(!Number.isFinite(R)||!Number.isFinite(K))throw Error('Seat resistance not numerically resolvable; no physical zero or minimum height inferred')
 const Q=Math.sign(q.dp_Pa)*2*Math.abs(q.dp_Pa)/(R+Math.hypot(R,2*Math.sqrt(K)*Math.sqrt(Math.abs(q.dp_Pa)))),
  viscous=R*Q,entry=K*Q*Math.abs(Q)
 if(![Q,q.density_kg_m3*Q,viscous,entry,q.dp_Pa*Q].every(Number.isFinite)||Q===0)throw Error('Seat rate/work not numerically resolvable; no physical zero inferred')
 return {volumeRate_m3_s:Q,massRate_kg_s:q.density_kg_m3*Q,viscousDrop_Pa:viscous,entryDrop_Pa:entry,dissipation_W:q.dp_Pa*Q}
}
/** Explicit assessed quantities only: not an automatic plant permissive or fault detector. */
export function coldPerimeterAssessment(b:HeadReclosure,q:{dp:{usable:boolean,low_Pa:number,high_Pa:number}[],
 nativeDPRange_Pa:[number,number],window_s:number,waterRateBound_kg_s:number,absoluteWater_kg:number,ncTransfer_kg:number,
 hotPressure_Pa:number,waterTemperature_K:number,liquidFaces:boolean,numericalRateUncertainty_kg_s:number,
 pathsClosed:boolean,pendingOpposingIntent:boolean,supportAndDutyEstablished:boolean}){
 const numbers=[...q.nativeDPRange_Pa,q.window_s,q.waterRateBound_kg_s,q.absoluteWater_kg,q.ncTransfer_kg,q.hotPressure_Pa,q.waterTemperature_K,q.numericalRateUncertainty_kg_s,...q.dp.flatMap(p=>[p.low_Pa,p.high_Pa])]
 if(!numbers.every(Number.isFinite)||[q.window_s,q.waterRateBound_kg_s,q.absoluteWater_kg,q.ncTransfer_kg,q.numericalRateUncertainty_kg_s].some(x=>x<0)||q.hotPressure_Pa<=0||q.waterTemperature_K<=0)throw Error('Invalid assessed perimeter quantities')
 const reasons:string[]=[]
 if(q.dp.length!==2||!q.dp.every(p=>p.usable&&p.low_Pa<=p.high_Pa&&p.low_Pa>=b.minimumDP_Pa&&p.high_Pa<=b.maximumDP_Pa))reasons.push('Acquired opposing-face intervals unavailable or outside the objective')
 if(q.nativeDPRange_Pa.length!==2||q.nativeDPRange_Pa[0]>q.nativeDPRange_Pa[1]||q.nativeDPRange_Pa[0]<b.minimumDP_Pa||q.nativeDPRange_Pa[1]>b.maximumDP_Pa)reasons.push('Actual native face pressure bounds do not support the whole test band')
 if(q.window_s<b.window_s)reasons.push('Complete advancing assessment window not established')
 if(!q.liquidFaces||q.ncTransfer_kg!==0)reasons.push('Liquid-only face/transport conclusion not established')
 if(q.waterRateBound_kg_s+q.numericalRateUncertainty_kg_s>b.maximumWaterRate_kg_s||q.absoluteWater_kg+q.numericalRateUncertainty_kg_s*b.window_s>b.maximumWaterTransfer_kg)reasons.push('Perimeter transfer exceeds the objective or its resolved allowance')
 if(q.hotPressure_Pa>b.maximumHotPressure_Pa||q.waterTemperature_K>b.maximumWaterTemperature_K)reasons.push('Cold task pressure/temperature objective exceeded')
 if(!q.pathsClosed||q.pendingOpposingIntent||!q.supportAndDutyEstablished)reasons.push('Actual path/intent/support and continuing duty assessment incomplete')
 return {objectiveEstablished:reasons.length===0,reasons}
}

export const headReclosureCalculation=String.raw`
import json,sys,math,platform,CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq,minimize_scalar
from scipy.integrate import quad
d=json.load(sys.stdin);b=d['selection'];checks=[]
def require(name,ok,**values):
 if not ok:raise ValueError((name,values))
 checks.append(dict(name=name,**values))
def liquid(p,T):
 rho=P('D','P',p,'T',T,'Water');h=P('H','P',p,'T',T,'Water');u=P('U','P',p,'T',T,'Water');s=P('S','P',p,'T',T,'Water')
 require('Native comparison face actually liquid',T<P('T','P',p,'Q',0,'Water'),pressure_Pa=p,temperature_K=T)
 return dict(p=p,T=T,rho=rho,h=h,u=u,s=s,mu=P('V','P',p,'T',T,'Water'))
def rate(q,dp,height,cd,land):
 if height==0 or dp==0:return dict(m=0.,Q=0.,viscous=0.,entry=0.,Re=0.)
 R=12*q['mu']*land/(L*height**3);K=q['rho']/(2*(cd*L*height)**2)
 Q=math.copysign(2*abs(dp)/(R+math.sqrt(R*R+4*K*abs(dp))),dp)
 m=q['rho']*Q;viscous=R*Q;entry=K*Q*abs(Q)
 require('Selected sector signed pressure/work identity',abs(viscous+entry-dp)<1e-8 and dp*Q>=0,pressureResidual_Pa=viscous+entry-dp,dissipation_W=dp*Q)
 return dict(m=m,Q=Q,viscous=viscous,entry=entry,Re=2*abs(m)/(L*q['mu']))
def capacity(pi,h,back):
 if pi==back:return 0.
 if pi<back:raise ValueError('Native nozzle donor lower than receiver')
 s=P('S','P',pi,'H',h,'Water')
 def flux(p):
  if p==pi:return 0.
  # Same native isentrope in a stable enthalpy-increment coordinate. This
  # avoids subtracting ~100kJ/kg to recover a very small low-drive increment.
  dh=quad(lambda x:1/P('D','P',x,'S',s,'Water'),p,pi,epsabs=1e-10,epsrel=1e-10)[0]
  if not dh>0:raise ValueError('Native isentropic work not positive')
  return P('D','P',p,'S',s,'Water')*math.sqrt(2*dh)
 grid=sorted(set([back]+[back+(pi-back)*j/8 for j in range(1,8)]+[pi]));values=[flux(p) for p in grid]
 candidates=[values[0],values[-1]]
 brackets=[(grid[0],grid[1]),(grid[-2],grid[-1])]+[(grid[j-1],grid[j+1]) for j in range(1,len(grid)-1) if values[j]>=values[j-1] and values[j]>=values[j+1]]
 for lo,hi in brackets:
  fit=minimize_scalar(lambda p:-flux(p),bounds=(lo,hi),method='bounded',options={'xatol':1e-6})
  if not fit.success:raise ValueError('Native throat search failed')
  candidates.append(-fit.fun)
 return max(candidates)
def nativeRate(q,dp,width,height,cd,land):
 if width==0 or height==0 or dp==0:return dict(m=0.,pi=q['p'],viscous=0.,entry=0.,Re=0.,residual_Pa=0.)
 back=q['p']-abs(dp)
 if back<=0:raise ValueError('Actual receiving pressure outside property domain')
 R=12*q['mu']*land/(q['rho']*width*height**3)
 def flow(x):
  pi=back+abs(dp)*x
  return cd*width*height*capacity(pi,q['h'],back)
 if land==0:x=1.
 else:x=brentq(lambda x:abs(dp)*(1-x)-R*flow(x),0,1,xtol=1e-13)
 pi=back+abs(dp)*x;m=flow(x);residual=abs(dp)*(1-x)-R*m
 require('Native land/nozzle series pressure incidence',abs(residual)<1e-5,pressureResidual_Pa=residual)
 require('Stationary viscous land retains h and does not reduce native entropy',P('S','P',pi,'H',q['h'],'Water')>=q['s']-1e-8)
 return dict(m=math.copysign(m,dp),pi=pi,viscous=R*m,entry=pi-back,Re=2*m/(width*q['mu']),residual_Pa=residual)
wellP=b['comparisonWellPressure_Pa'];T=b['comparisonTemperature_K'];Tw=b['comparisonWellTemperature_K'];L=b['comparisonDefectLength_m']
states=[liquid(wellP+dp,T) for dp in [b['minimumDP_Pa'],b['targetDP_Pa'],b['maximumDP_Pa']]]
boundary=brentq(lambda h:rate(states[-1],b['maximumDP_Pa'],h,b['dischargeCoefficient'],b['seatLandLength_m'])['m']-b['maximumWaterRate_kg_s'],1e-9,1e-3,xtol=1e-15)
rows=[]
for scale in [0.,.99,1.01]:
 for cd in [.3,b['dischargeCoefficient'],1.]:
  for dp,q in zip([b['minimumDP_Pa'],b['targetDP_Pa'],b['maximumDP_Pa']],states):
   r=rate(q,dp,boundary*scale,cd,b['seatLandLength_m']);rows.append(dict(heightScale=scale,Cd=cd,dp_Pa=dp,height_m=boundary*scale,incompressibleRate_kg_s=r['m'],heldWindowWater_kg=r['m']*b['window_s'],Re=r['Re'],viscousDrop_Pa=r['viscous'],entryDrop_Pa=r['entry']))
nativeRows=[]
for scale in [0.,.99,1.01]:
 for dp,q in zip([b['minimumDP_Pa'],b['targetDP_Pa'],b['maximumDP_Pa']],states):
  r=nativeRate(q,dp,L,boundary*scale,b['dischargeCoefficient'],b['seatLandLength_m']);limit=rate(q,dp,boundary*scale,b['dischargeCoefficient'],b['seatLandLength_m'])['m']
  require('Cold native series approaches independently evaluated quadratic',abs(r['m']-limit)<b['maximumWaterRate_kg_s']*1e-4,difference_kg_s=r['m']-limit)
  nativeRows.append(dict(heightScale=scale,dp_Pa=dp,height_m=boundary*scale,rate_kg_s=r['m'],intermediatePressure_Pa=r['pi'],viscousDrop_Pa=r['viscous'],entryDrop_Pa=r['entry']))
require('Native near-pass/near-fail challenge the unchanged objective',max(q['rate_kg_s'] for q in nativeRows if q['heightScale']==.99)<b['maximumWaterRate_kg_s']<max(q['rate_kg_s'] for q in nativeRows if q['heightScale']==1.01))
require('Slender laminar boundary is admitted not guessed from an orifice',boundary/b['seatLandLength_m']<.01 and max(q['Re'] for q in rows)<100,heightToLand=boundary/b['seatLandLength_m'],maximumRe=max(q['Re'] for q in rows))
sensitivity=[]
for land in [.5*b['seatLandLength_m'],b['seatLandLength_m'],2*b['seatLandLength_m']]:
 for temperature in [Tw,T,b['maximumWaterTemperature_K']]:
  q=liquid(wellP+b['maximumDP_Pa'],temperature);r=rate(q,b['maximumDP_Pa'],boundary,b['dischargeCoefficient'],land)
  sensitivity.append(dict(land_m=land,temperature_K=temperature,rate_kg_s=r['m'],Re=r['Re']))
require('Native land/temperature sensitivity can change conclusion',min(q['rate_kg_s'] for q in sensitivity)<b['maximumWaterRate_kg_s']<max(q['rate_kg_s'] for q in sensitivity))
orificeHeight=b['maximumWaterRate_kg_s']/(b['dischargeCoefficient']*L*math.sqrt(2*states[-1]['rho']*b['maximumDP_Pa']))
orificeActual=rate(states[-1],b['maximumDP_Pa'],orificeHeight,b['dischargeCoefficient'],b['seatLandLength_m'])['m']
require('Inviscid microgap shortcut is physically rejected',orificeActual<b['maximumWaterRate_kg_s']/100,orificeHeight_m=orificeHeight,actualFiniteLandRate_kg_s=orificeActual)
require('Zero driven pressure is not seal evidence',rate(liquid(wellP,T),0,boundary,b['dischargeCoefficient'],b['seatLandLength_m'])['m']==0)
require('Native exact zero-drive and zero-height precede inversion',nativeRate(states[0],0,L,boundary,b['dischargeCoefficient'],b['seatLandLength_m'])['m']==0 and nativeRate(states[0],b['minimumDP_Pa'],L,0,b['dischargeCoefficient'],b['seatLandLength_m'])['m']==0)
rhoDifference=abs(P('D','P',wellP,'H',states[-1]['h'],'Water')/states[-1]['rho']-1)
require('Actual cold liquid density variation small in scoped resistance',rhoDifference<1e-4,relativeDensityChange=rhoDifference)
limits=[]
for label,dp,height,land in [('low-drive',1.,boundary,b['seatLandLength_m']),('zero-land',b['targetDP_Pa'],boundary,0.),('large-gap',b['targetDP_Pa'],.01,b['seatLandLength_m'])]:
 q=liquid(wellP+dp,T);r=nativeRate(q,dp,L,height,b['dischargeCoefficient'],land);unresisted=b['dischargeCoefficient']*L*height*capacity(q['p'],q['h'],wellP)
 require('Native limiting rate remains finite positive and no bigger than curtain',0<r['m']<=unresisted*(1+1e-10))
 if label=='large-gap':require('Large liquid gap correction below scoped 0.1 percent comparison',abs(r['m']/unresisted-1)<1e-3,relativeCorrection=r['m']/unresisted-1,viscousDrop_Pa=r['viscous'])
 if label=='zero-land':require('Exact absent-land native curtain limit',r['m']==unresisted)
 limits.append(dict(name=label,dp_Pa=dp,height_m=height,land_m=land,native=r,curtain_kg_s=unresisted))
packets=[]
for direction in [1,-1]:
 donor=liquid(wellP+b['targetDP_Pa'],T if direction==1 else Tw);receiver=liquid(wellP,Tw if direction==1 else T)
 ratios=[b['comparisonPrimaryTracerRatio'],b['comparisonWellTracerRatio']] if direction==1 else [b['comparisonWellTracerRatio'],b['comparisonPrimaryTracerRatio']]
 M=b['comparisonCouponMass_kg'];m=b['comparisonPacket_kg'];g=9.80665;z=b['headDatum_m'];Vd=M/donor['rho'];Vr=M/receiver['rho']
 Ht=donor['h']+g*z
 # Rigid finite water stores: transported jet energy is already in total H;
 # downstream complete dissipation must not be paid a second time.
 Ud=M*donor['u']-m*donor['h'];Ur=M*receiver['u']+m*donor['h']
 md=M-m;mr=M+m;Bd=M*ratios[0]-m*ratios[0];Br=M*ratios[1]+m*ratios[0]
 pd=P('P','D',md/Vd,'U',Ud/md,'Water');pr=P('P','D',mr/Vr,'U',Ur/mr,'Water')
 E0=M*(donor['u']+g*z)+M*(receiver['u']+g*z);E1=Ud+Ur+(md+mr)*g*z
 require('Finite signed packet mass/energy/tracer pair',abs(md+mr-2*M)<1e-12 and abs(E1-E0)<1e-8 and abs(Bd+Br-M*sum(ratios))<1e-14,direction=direction,energyDefect_J=E1-E0,tracerDefect_kgEq=Bd+Br-M*sum(ratios))
 require('Actual donor/receiver state advances rather than reset',pd<donor['p'] and pr>receiver['p'] and pd>pr)
 r=nativeRate(donor,direction*b['targetDP_Pa'],L,boundary,b['dischargeCoefficient'],b['seatLandLength_m'])
 require('Actual signed reverse resistance retains donor and positive dissipation',r['m']*direction>0 and r['viscous']>0)
 packets.append(dict(direction=direction,donor=donor,receiver=receiver,packetWater_kg=m,packetTracer_kgEq=m*ratios[0],packetTotalEnergy_J=m*Ht,donorAfterPressure_Pa=pd,receiverAfterPressure_Pa=pr,retainedDonorTracer_kgEq=Bd,retainedReceiverTracer_kgEq=Br))
require('Reverse donor carries actual well rather than primary tracer',packets[1]['packetTracer_kgEq']==b['comparisonPacket_kg']*b['comparisonWellTracerRatio'])
requestWindow=b['maximumChargeRequest_kg_s']*b['window_s']
require('Requested addition can mask a failing leak without qualifying pressure',requestWindow>b['maximumWaterTransfer_kg'],requestedWindowWater_kg=requestWindow)
print(json.dumps(dict(scope='Declared cold liquid native land/nozzle series, explicit incompressible limits and two finite packet coupons only; no reached charging, evolving primary, whole-window acquisition or seal/startup qualification',dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__),checks=checks,nativeRateComparisons=nativeRows,incompressibleComparisons=rows,nativeLimits=limits,nominalQuadraticBoundaryHeight_m=boundary,landTemperatureSensitivity=sensitivity,finitePackets=packets),allow_nan=False))
`

const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
export async function runHeadReclosure(directory:string,python:string){
 const paths=['systems/reactor/head-reclosure-and-pressure-assessment.md','systems/reactor/control-absorber-and-guide-water.md'],docs=await Promise.all(paths.map(p=>Bun.file(resolve(directory,p)).text())),
  selection=parseHeadReclosure(docs[0]!),control=parseControlAbsorber(docs[1]!),
  aperture=perimeterAperture(control.headGrossArea_m2,control.headGrossArea_m2,0,selection.comparisonDefectLength_m,1e-6),
  {maximumHotPressure_Pa,...nativeSelection}=selection,
  input={selection:nativeSelection},bytes=JSON.stringify(input),source=await Bun.file(import.meta.path).text(),
  process=Bun.spawn([python,'-c',headReclosureCalculation],{stdin:new Blob([bytes]),stdout:'pipe',stderr:'pipe'}),
  [out,err,code]=await Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited])
 if(code)throw Error(err)
 if(sha(source)!==sha(await Bun.file(import.meta.path).text())||!(await Promise.all(paths.map(async(p,i)=>sha(await Bun.file(resolve(directory,p)).text())===sha(docs[i]!)))).every(Boolean))throw Error('Reclosure source/context changed during calculation')
 const result=JSON.parse(out),premises={dp:[{usable:true,low_Pa:selection.targetDP_Pa-100,high_Pa:selection.targetDP_Pa+100},{usable:true,low_Pa:selection.targetDP_Pa-100,high_Pa:selection.targetDP_Pa+100}],
  nativeDPRange_Pa:[selection.targetDP_Pa,selection.targetDP_Pa] as [number,number],window_s:selection.window_s,waterRateBound_kg_s:.9*selection.maximumWaterRate_kg_s,absoluteWater_kg:.9*selection.maximumWaterTransfer_kg,ncTransfer_kg:0,
  hotPressure_Pa:maximumHotPressure_Pa,waterTemperature_K:selection.comparisonTemperature_K,liquidFaces:true,numericalRateUncertainty_kg_s:0,pathsClosed:true,pendingOpposingIntent:false,supportAndDutyEstablished:true},
  counterexamples=[{name:'Explicit conditional cold objective',input:premises},
   {name:'Flat pressure maintained by balanced charging hides excess loss',input:{...premises,waterRateBound_kg_s:2*selection.maximumWaterRate_kg_s,absoluteWater_kg:2*selection.maximumWaterTransfer_kg}},
   {name:'Unresolved gas face',input:{...premises,liquidFaces:false}},
   {name:'Fresh displayed DP conflicts with actual native face',input:{...premises,nativeDPRange_Pa:[0,0] as [number,number]}},
   {name:'Present native DP recovered after earlier window escape',input:{...premises,nativeDPRange_Pa:[selection.minimumDP_Pa-1,selection.targetDP_Pa] as [number,number]}},
   {name:'Unavailable acquired channel',input:{...premises,dp:premises.dp.map(q=>({...q,usable:false}))}},
   {name:'Pending real opposing OPEN intent',input:{...premises,pendingOpposingIntent:true}},
   {name:'Lost continuing receiver or support duty',input:{...premises,supportAndDutyEstablished:false}},
   {name:'Unresolved finite numerical allowance',input:{...premises,numericalRateUncertainty_kg_s:selection.maximumWaterRate_kg_s}}],
  assessmentCases=counterexamples.map(q=>({...q,result:coldPerimeterAssessment(selection,q.input)}))
 if(!assessmentCases.every((q,i)=>q.result.objectiveEstablished===(i===0)))throw Error('Cold assessment counterexample did not retain its intended contrary')
 const assessmentInput={selection,counterexamples},apertureInput={headGrossArea_m2:control.headGrossArea_m2,mouth_m2:control.headGrossArea_m2,gap_m:0,defectWidth_m:selection.comparisonDefectLength_m,height_m:1e-6},
  receipt={sourceSHA256:sha(source),calculationSHA256:sha(headReclosureCalculation),consumedInputSHA256:sha(bytes),consumedInput:input,
  apertureInputSHA256:sha(JSON.stringify(apertureInput)),apertureInput,apertureArea_m2:aperture,
  assessmentInputSHA256:sha(JSON.stringify(assessmentInput)),assessmentInput,assessmentCases,
  ownerContextSHA256:Object.fromEntries(paths.map((p,i)=>[p,sha(docs[i]!)])),...result}
 return receipt
}
if(import.meta.main){
 const [directory,python,output,...rest]=Bun.argv.slice(2)
 if(!directory||!python||!output||rest.length)throw Error('Usage: head-reclosure <ld-01> <research-python> <receipt.json>')
 const receipt=await runHeadReclosure(directory,python),result=receipt
 await Bun.write(output,JSON.stringify(receipt,null,2)+'\n')
 console.log(JSON.stringify({output,checks:result.checks.length,height_m:result.nominalQuadraticBoundaryHeight_m,finitePackets:result.finitePackets}))
}
