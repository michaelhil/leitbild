/** Fixed-state HP signed-machine decision aid; not a live pump or a plant solver. */
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
import {readServicePump} from './reference-design-service-pump-continuation'
import {motorBudget} from './reference-design-rhr-signed-pump'

export type Selection={crossCoefficient:number;crossSensitivity:number[];rpm:number;leakAreaFraction:number}
export function parseSelection(text:string):Selection{
 const matches=[...text.matchAll(/```reference-service-pump-signed\s*\n([\s\S]*?)\n```/g)]
 if(matches.length!==1)throw new Error('Expected one signed service-pump record')
 const x=JSON.parse(matches[0]![1]!) as Selection
 if(Object.keys(x).sort().join()!=='crossCoefficient,crossSensitivity,leakAreaFraction,rpm'||!Number.isFinite(x.crossCoefficient)||x.crossCoefficient<=0||x.crossCoefficient>=.25||!Array.isArray(x.crossSensitivity)||x.crossSensitivity.length===0||x.crossSensitivity.some(k=>!Number.isFinite(k)||k<0||k>=.25)||!Number.isFinite(x.rpm)||x.rpm<=0||!Number.isFinite(x.leakAreaFraction)||x.leakAreaFraction<=0||x.leakAreaFraction>=1)throw new Error('Invalid signed service-pump selection')
 return x
}
export function pressureExchange(dp0:number,rhoRatio:number,k:number,n:number,q:number,F:number){
 if(![dp0,rhoRatio,k,n,q,F].every(Number.isFinite)||dp0<=0||rhoRatio<=0||k<0||k>=.25||F<0||F>1)throw new Error('Invalid pressure characteristic')
 return dp0*rhoRatio*F*n*(1.25*n-k*Math.abs(q))
}
export function exchangeTorque(dp0:number,rhoRatio:number,k:number,n:number,q:number,F:number,m:number,omega0:number,slope:number){
 pressureExchange(dp0,rhoRatio,k,n,q,F)
 if(![m,omega0,slope].every(Number.isFinite)||omega0<=0||slope<=0)throw new Error('Invalid stage torque state')
 return dp0*rhoRatio*F*m*(1.25*n-k*Math.abs(q))*slope/omega0
}
export function streamLoss(H0:number,rhoRatio:number,F:number,omega:number,omega0:number,q:number){
 if(![H0,rhoRatio,F,omega,omega0,q].every(Number.isFinite)||H0<0||rhoRatio<=0||F<0||F>1||omega0<=0)throw new Error('Invalid rotor-loss state')
 const torque=H0*rhoRatio*F*omega*Math.abs(q)/omega0**2
 return {torque,power:omega*torque}
}
export function backflowBrake(m:number,omega:number,exchange:number){
 if(![m,omega,exchange].every(Number.isFinite))throw new Error('Invalid backflow brake state')
 const torque=m<0&&omega>0?Math.max(0,-2*exchange):0
 return {torque,power:omega*torque}
}

const calculation=String.raw`
import json,sys,math
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq,minimize_scalar
from scipy.integrate import quad
inp=json.load(sys.stdin);sel=inp['selection'];k=sel['crossCoefficient'];w0=sel['rpm']*math.pi/30
checks=[]
def check(name,ok):
 if not ok:raise ValueError(name)
 checks.append(name)
def native(p,T=None,h=None,s=None):
 key='T' if T is not None else ('H' if h is not None else 'S');v=T if T is not None else (h if h is not None else s)
 return dict(p=p,T=P('T','P',p,key,v,'Water'),h=P('H','P',p,key,v,'Water'),s=P('S','P',p,key,v,'Water'),rho=P('D','P',p,key,v,'Water'))
def nozzle(d,pr,at):
 if pr>=d['p']:return dict(G=0.,throat=d['p'],choked=False)
 def flux(p):
  if p==d['p']:return 0.
  a=at(p);dh=d['h']-a['h']
  if dh < -1e-4:raise ValueError('Negative nozzle kinetic energy beyond property increment resolution')
  return a['rho']*math.sqrt(2*max(0,dh))
 points=[pr+(d['p']-pr)*i/16 for i in range(17)];values=[flux(p) for p in points];candidates=list(points)
 for i in range(1,16):
  if values[i]>=values[i-1] and values[i]>=values[i+1]:candidates.append(minimize_scalar(lambda p:-flux(p),bounds=(points[i-1],points[i+1]),method='bounded',options={'xatol':.001}).x)
 pt=max(candidates,key=flux)
 return dict(G=flux(pt),throat=float(pt),choked=bool(pt>pr+1.),throatTemperature=at(pt)['T'])
def waterNozzle(d,pr):return nozzle(d,pr,lambda p:native(p,s=d['s']))
cal=[];rows=[];capacity=[]
for b in inp['bases']:
 name=b['id'];p0=b['inletPressure_MPa']*1e6;out=b['outletPressure_MPa']*1e6;dp0=out-p0;m0=b['flow_kg_s'];a=native(p0,T=b['inletTemperature_C']+273.15);r0=a['rho'];Q0=m0/r0
 old=(native(out,s=a['s'])['h']-a['h'])/b['hydraulicEfficiency'];ps=p0+(1.25-k)*dp0;stage=native(ps,s=a['s']);CdA=m0/waterNozzle(stage,out)['G'];H0=m0*(old-stage['h']+a['h']);P0=m0*old
 check(name+' positive separately owned rotor dissipation',H0>0)
 check(name+' nominal intermediate material pressure',ps<20e6)
 def characteristic(m,n,rc,F):return dp0*rc/r0*F*n*(1.25*n-k*abs(m)/rc/Q0)
 def factor(m,n,rc,alpha=0):
  need=b['npshSpeed_m']*n*n+b['npshFlow_m']*(m/rc/Q0)**2
  available=(p0-P('P','T',a['T'],'Q',1,'Water'))/(rc*9.80665)
  gas=1 if alpha<=.02 else max(0,(.15-alpha)/.13)
  return min(gas,1 if need==0 else min(1,max(0,available/need))**2)
 def row(label,pd,Td,pr,n,sign):
  d=native(pd,T=Td)
  def evaluate(mag):
   m=sign*mag;F=factor(m,n,r0);de=characteristic(m,n,r0,F);pstar=pd+sign*de
   if pstar<=pr:return None
   z=native(pstar,s=d['s']) if de!=0 else d;noz=waterNozzle(z,pr)
   return F,de,z,noz
  def residual(mag):
   v=evaluate(mag)
   return mag-(CdA*v[3]['G'] if v else 0.)
  hi=m0
  while residual(hi)<0:hi*=2
  mag=brentq(residual,0,hi,xtol=1e-10);F,de,z,noz=evaluate(mag);m=sign*mag;dh=z['h']-d['h'];mixHeat=H0*F*n*n*mag/m0
  C=dh/(sign*de) if de!=0 else 1/d['rho'];te=dp0*F*m*(1.25*n-k*abs(m)/r0/Q0)*C/w0;tb=max(0,-2*te) if m<0 and n>0 else 0.;brakeHeat=n*w0*tb
  heat=mixHeat+brakeHeat;hr=z['h']+heat/mag;received=native(pr,h=hr);tl=H0*F*n*mag/m0/w0;power=mag*dh+heat
  integral=(sign*de)*quad(lambda x:1/native(pd+x*sign*de,s=d['s'])['rho'],0,1,epsabs=1e-10)[0] if de else 0.
  check(name+' '+label+' work identity',abs(dh-integral)<1e-4)
  check(name+' '+label+' torque and receipt',abs((te+tl+tb)*n*w0-power)<1e-6 and abs(mag*(hr-d['h'])-power)<1e-6)
  check(name+' '+label+' entropy and admitted states',received['s']>=d['s']-1e-7 and min(pd,z['p'],pr)>0)
  grid=[math.exp(math.log(pr)+(math.log(z['p'])-math.log(pr))*i/128) for i in range(129)]
  scanned=max(native(pp,s=z['s'])['rho']*math.sqrt(max(0,2*(z['h']-native(pp,s=z['s'])['h']))) for pp in grid)
  check(name+' '+label+' independent log throat scan',scanned<=noz['G']*(1+1e-6))
  if sign<0 and n>0:check(name+' running backflow brakes with actual receiver heat',te+tb+tl>0 and brakeHeat>0)
  return dict(id=name,label=label,m=m,n=n,F=F,caseDensity=r0,donor=d,stage=z,receiver=received,nozzle=noz,pressureExchange=de,work=dh,workSlope=C,integratedWork=integral,heat=heat,mixHeat=mixHeat,brakeHeat=brakeHeat,exchangeTorque=te,heatTorque=tl,brakeTorque=tb,shaftPower=power)
 normal=row('nominal',p0,a['T'],out,1,1);check(name+' unchanged nominal duty',abs(normal['m']-m0)<1e-6 and abs(normal['shaftPower']-P0)<.001);rows.append(normal)
 hotP=15.2e6 if name=='CHARGE' else 7.2e6;hotT=563.15 if name=='CHARGE' else 493.15
 for label,n in [('hot-reverse-half-speed',.5),('hot-reverse-stopped',0),('hot-reverse-negative-speed',-.5)]:rows.append(row(label,hotP,hotT,p0,n,-1))
 rows.append(row('negative-speed-forward',p0,a['T'],p0+.1*dp0,-.5,1))
 # One cold reverse reference; the earlier RHR comparison owns its Qdp rejection.
 rows.append(row('cold-reverse',hotP,313.15,p0,.5,-1))
 if name=='CHARGE':
  for receiver in [101325.,1e6]:
   body=receiver+18e6;delivery=row('relief-opening-'+str(receiver),p0,a['T'],body,1,1);rows.append(delivery)
   coldCapacity=.00005*waterNozzle(delivery['receiver'],receiver)['G'];hotCapacity=.00005*waterNozzle(native(body,T=563.15),receiver)['G']
   check('Selected A3 full-lift frozen charging capacity '+str(receiver),min(coldCapacity,hotCapacity)>delivery['m'])
   capacity.append(dict(receiverPressure=receiver,bodyPressure=body,pumpInflow=delivery['m'],coldRelief=coldCapacity,hotRelief=hotCapacity))
 cal.append(dict(id=name,rho=r0,Q0=Q0,dp0=dp0,m0=m0,P0=P0,H0=H0,CdA=CdA,nominalStagePressure=ps,shutoff=p0+1.25*dp0,omega0=w0,inertia=1.01*P0*(2 if name=='CHARGE' else 5)/w0**2))
# A finite frozen hot stream receipt, not an advancing casing or open-pool transient.
hot=next(r for r in rows if r['id']=='CHARGE' and r['label']=='hot-reverse-half-speed');p=101325.;hf=P('H','P',p,'Q',0,'Water');hg=P('H','P',p,'Q',1,'Water');quality=(hot['receiver']['h']-hf)/(hg-hf)
check('Hot reverse actual BLEND face flashes without deleting water energy',0<quality<1 and abs((1-quality)*hf+quality*hg-hot['receiver']['h'])<1e-7)
receipt=dict(parcelMass=1.,liquid=1-quality,steam=quality,liquidEnthalpy=(1-quality)*hf,gasEnthalpy=quality*hg,totalEnthalpy=hot['receiver']['h'],meaning='One kg frozen stream after case passage; BLEND retains liquid and liquid-origin tracer, atmospheric boundary exports actual gas. Not casing mixing or tank recovery.')
# Explicit fixed-ratio wet-mixture comparison, independent of the earlier pump receipt.
species={'air':(287.,718.),'nitrogen':(296.8,742.)};pd=5e6;T=353.15;alpha=.01;pv=P('P','T',T,'Q',1,'Water');rl=P('D','P',pd,'T',T,'Water');rv=P('D','T',T,'Q',1,'Water');mw=(1-alpha)*rl+alpha*rv
mass={s:.005*(pd-pv)/(R*T)/mw for s,(R,cv) in species.items()}
def mix(p,T):
 pv=P('P','T',T,'Q',1,'Water');vg=sum(mass[s]*species[s][0] for s in mass)*T/(p-pv);mv=vg*P('D','T',T,'Q',1,'Water');ml=1-mv
 if p<=pv or not 0<mv<1:raise ValueError('Mixture coupon left liquid-bearing phase')
 h=ml*P('H','P',p,'T',T,'Water')+mv*P('H','T',T,'Q',1,'Water');s=ml*P('S','P',p,'T',T,'Water')+mv*P('S','T',T,'Q',1,'Water');liquidH=ml*P('H','P',p,'T',T,'Water');gasH=h-liquidH
 for name,m in mass.items():
  R,cv=species[name];pj=m*R*T/vg;hj=m*(cv*(T-298.15)+R*T);h+=hj;gasH+=hj;s+=m*((cv+R)*math.log(T/298.15)-R*math.log(pj/101325))
 total=1+sum(mass.values());return dict(p=p,T=T,h=h/total,s=s/total,rho=total/(ml/P('D','P',p,'T',T,'Water')+vg),ml=ml/total,mv=mv/total,liquidH=liquidH/total,gasH=gasH/total)
d=mix(pd,T)
def match(p,key,target):return mix(p,brentq(lambda t:mix(p,t)[key]-target,273.16,min(T+10,P('T','P',p,'Q',1,'Water')-5),xtol=1e-10))
c=next(c for c in cal if c['id']=='CHARGE');n=.2
def meval(mag):
 available=(101325-P('P','T',313.15,'Q',1,'Water'))/(c['rho']*9.80665);required=n*n+2*(mag/c['m0'])**2;F=min(1,available/required)**2
 de=c['dp0']*F*n*(1.25*n-k*mag/c['m0']);z=match(pd-de,'s',d['s']);noz=nozzle(z,101325.,lambda p:match(p,'s',z['s']));return de,z,noz,F,available,required
mag=brentq(lambda m:m-c['CdA']*meval(m)[2]['G'],0,20);de,z,noz,F,available,required=meval(mag);mixHeat=c['H0']*F*n*n*mag/c['m0'];brakeHeat=2*max(0,-mag*(z['h']-d['h']));heat=mixHeat+brakeHeat;received=match(101325.,'h',z['h']+heat/mag)
check('Mixed reverse liquid-bearing admitted entropy',received['s']>=d['s'] and 0<received['ml']<1 and 1e5<=z['p']<=20e6)
check('Mixed reverse exact species and enthalpy receipt',abs(received['ml']+received['mv']+sum(mass.values())/(1+sum(mass.values()))-1)<1e-12 and abs(received['liquidH']+received['gasH']-z['h']-heat/mag)<1e-5)
integral=-de*quad(lambda x:1/match(pd-x*de,'s',d['s'])['rho'],0,1,epsabs=1e-8)[0];work=z['h']-d['h']
check('Mixed reverse approximate work within inherited 0.1 percent screen',abs(work-integral)<.001*abs(integral))
grid=[math.exp(math.log(101325.)+(math.log(z['p'])-math.log(101325.))*i/128) for i in range(129)]
scan=max(match(pp,'s',z['s'])['rho']*math.sqrt(max(0,2*(z['h']-match(pp,'s',z['s'])['h']))) for pp in grid)
check('Mixed reverse independent log throat scan',scan<=noz['G']*(1+1e-6))
check('Mixed reverse retained cold case factor calculated',F==1 and required<available)
mixed=dict(m=-mag,n=n,F=F,availableNPSH=available,requiredNPSH=required,caseDensity=c['rho'],donor=d,stage=z,receiver=received,nozzle=noz,work=work,integratedWork=integral,heat=heat,mixHeat=mixHeat,brakeHeat=brakeHeat,massPerWater=mass)
# Leakage area is a separate series restriction; the failed-open check adds no loss.
leak=c['CdA']*sel['leakAreaFraction'];donor=native(15.2e6,T=563.15);cap=waterNozzle(donor,101325.)
check('Finite hot check leakage ceiling is choked',cap['choked'] and leak*cap['G']<abs(hot['m']))
leakage=dict(CdA=leak,isolatedUpperFlow=leak*cap['G'],nozzle=cap,meaning='Frozen check-only upper capacity; actual series pump/check flow must be solved together, never min of two separately imposed rates.')
print(json.dumps(dict(libraries=dict(CoolProp=CoolProp.__version__,SciPy=scipy.__version__),calibration=cal,rows=rows,mixed=mixed,receipt=receipt,leakage=leakage,capacity=capacity,checks=checks)))
`
if(import.meta.main){
 const [feed,charge,python,receipt,...extra]=process.argv.slice(2)
 if(!feed||!charge||!python||extra.length)throw new Error('Usage: <feed-owner> <charge-owner> <python> [receipt.json]')
 const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex')
 const sources=[feed,charge,resolve(charge,'../two-phase-and-breaks.md'),import.meta.path,resolve(import.meta.dir,'reference-design-service-pump-continuation.ts'),resolve(import.meta.dir,'reference-design-rhr-signed-pump.ts'),resolve(import.meta.dir,'reference-design-hydraulics.ts')].map(path=>({path,sha256:hash(path)}))
 const selection=parseSelection(readFileSync(feed,'utf8'));const bases=[readServicePump(feed),readServicePump(charge)]
 if(bases.map(b=>b.id).join()!=='FW,CHARGE')throw new Error('Requires named FW and CHARGE calibration')
 const run=spawnSync(python,['-c',calculation],{input:JSON.stringify({selection,bases}),encoding:'utf8'})
 if(run.status!==0)throw new Error(run.stderr||'Native comparison failed')
 const result=JSON.parse(run.stdout);const axes=[]
 const motor=[-1,0,1].map(n=>({n,...motorBudget(100,n*selection.rpm*Math.PI/30,.9)}))
 if(motor.some(x=>x.heat<0||x.electric<0||Math.abs(x.electric-x.shaft-x.heat)>1e-8))throw new Error('Motor budget failed')
 for(const c of result.calibration)for(const r of result.rows.filter((r:{id:string})=>r.id===c.id)){
  const de=pressureExchange(c.dp0,1,selection.crossCoefficient,r.n,r.m/c.m0,r.F);const loss=streamLoss(c.H0,1,r.F,r.n*c.omega0,c.omega0,r.m/c.m0)
  const torque=exchangeTorque(c.dp0,1,selection.crossCoefficient,r.n,r.m/c.m0,r.F,r.m,c.omega0,r.workSlope)
  const brake=backflowBrake(r.m,r.n*c.omega0,torque)
  if(Math.abs(de-r.pressureExchange)>1e-7||Math.abs(loss.power-r.mixHeat)>1e-7||Math.abs(torque-r.exchangeTorque)>1e-7||Math.abs(brake.power-r.brakeHeat)>1e-7)throw new Error('Independent TS characteristic disagreement')
 }
 for(const c of result.calibration)for(const m of [-c.m0,c.m0])for(const k of selection.crossSensitivity){
  const values=[-1e-8,0,1e-8].map(n=>({n,torque:exchangeTorque(c.dp0,1,k,n,m/c.m0,1,m,c.omega0,1/c.rho)}));const acceleration=-values[1]!.torque/c.inertia
  if(k>0&&(acceleration*m<=0||Math.abs(values[0]!.torque-values[2]!.torque)>1e-6*Math.abs(values[1]!.torque)))throw new Error('Wrong starting rotation or discontinuous torque')
  axes.push({id:c.id,m,k,values,acceleration})
 }
 result.checks.push('Both starting rotation directions and two-sided zero-speed torque')
 result.checks.push('Independent TS pressure and rotor-heat comparison','Non-regenerative drive in both speed signs')
 if(sources.some(s=>hash(s.path)!==s.sha256))throw new Error('Sources changed during calculation')
 const output={scope:'Fixed calibration, native and effective mixed reverse faces, choking, axes and receipt; no installed path transient, pressure protection or pump survival qualification',sources,selection,motor,axes,...result}
 if(receipt)await Bun.write(receipt,JSON.stringify(output,null,2)+'\n')
 console.log(JSON.stringify(receipt?{receipt,checks:result.checks.length,calibration:result.calibration,rows:result.rows.map((r:{id:string;label:string;m:number;shaftPower:number})=>({id:r.id,label:r.label,m:r.m,power:r.shaftPower})),mixed:result.mixed,leakage:result.leakage}:output,null,2))
}
