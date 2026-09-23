/** Offline upper-pickup contact selection; not entrainment calibration or a cycle solver. */
import {createHash} from 'node:crypto'
import {gasConstants} from './reference-design-service-pump-mixture'

export const upperPickupBasis={
 sg:{volume_m3:120,contactArea_m2:7.5,bottom_m:2.5,sill_m:17,crown_m:18,pressure_Pa:6e6,receiver_Pa:5.98e6},
 sep:{volume_m3:100,contactArea_m2:5,bottom_m:0,sill_m:4,crown_m:4.5,pressure_Pa:.8e6,receiver_Pa:.79e6},
} as const
export const upperPickupFraction=(liquidVolume:number,b:{volume_m3:number;contactArea_m2:number;bottom_m:number;sill_m:number;crown_m:number})=>{
 if(!Number.isFinite(liquidVolume)||liquidVolume<0||liquidVolume>b.volume_m3||b.crown_m<=b.sill_m)throw Error('Invalid pickup geometry/state')
 return Math.max(0,Math.min(1,(b.bottom_m+liquidVolume/b.contactArea_m2-b.sill_m)/(b.crown_m-b.sill_m)))
}
export const upperPickupPython=String.raw`
import json,sys,math
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import minimize_scalar,least_squares
d=json.load(sys.stdin);species=d['species'];checks=[]
def check(name,value,target=0,tolerance=1e-8):
 if not math.isfinite(value) or abs(value-target)>tolerance:raise ValueError((name,value,target,tolerance))
 checks.append(dict(name=name,value=value,target=target,tolerance=tolerance))
def fraction(Vl,b):return max(0,min(1,(b['bottom_m']+Vl/b['contactArea_m2']-b['sill_m'])/(b['crown_m']-b['sill_m'])))
def nozzle(p,pr,phase):
 h=P('H','P',p,'Q',phase,'Water');s=P('S','P',p,'Q',phase,'Water')
 def flux(pt):
  if pt==p:return 0.
  ht=P('H','P',pt,'S',s,'Water');rho=P('D','P',pt,'S',s,'Water');dh=h-ht
  if dh<0:raise ValueError('Negative available nozzle energy')
  return rho*math.sqrt(2*dh)
 grid=[pr+(p-pr)*j/32 for j in range(33)];candidates=grid[:]
 for lo,hi in zip(grid[:-1],grid[1:]):candidates.append(minimize_scalar(lambda pt:-flux(pt),bounds=(lo,hi),method='bounded',options={'xatol':.001}).x)
 throat=max(candidates,key=flux)
 return dict(G_kg_m2s=flux(throat),throat_Pa=throat,enthalpy_J_kg=h,entropy_J_kgK=s,donorDensity_kg_m3=P('D','P',p,'Q',phase,'Water'))
rows=[]
for name,b in d['basis'].items():
 liquid=nozzle(b['pressure_Pa'],b['receiver_Pa'],0);gas=nozzle(b['pressure_Pa'],b['receiver_Pa'],1)
 def rates(f,opening=1):
  ml=opening*f*liquid['G_kg_m2s'];mg=opening*(1-f)*gas['G_kg_m2s']
  return dict(liquid_kg_s_per_m2=ml,gas_kg_s_per_m2=mg,total_kg_s_per_m2=ml+mg,energy_W_per_m2=ml*liquid['enthalpy_J_kg']+mg*gas['enthalpy_J_kg'])
 entries=[]
 for f in [0,1e-8,.5,1-1e-8,1]:
  Vl=b['contactArea_m2']*(b['sill_m']-b['bottom_m']+f*(b['crown_m']-b['sill_m']))
  check(name+' contact fraction',fraction(Vl,b),f,1e-12)
  r=rates(f);check(name+' paired phase flow',r['total_kg_s_per_m2'],r['liquid_kg_s_per_m2']+r['gas_kg_s_per_m2'])
  entries.append(dict(f=f,liquidVolume_m3=Vl,**r))
 for f,end in [(1e-8,0),(1-1e-8,1)]:
  r=rates(f);e=rates(end)
  for key in ['total_kg_s_per_m2','energy_W_per_m2']:
   scale=max(rates(0)[key],rates(1)[key]);check(name+' near-endpoint '+key,(r[key]-e[key])/scale,0,1.01e-8)
 for value in rates(.5,0).values():check(name+' closed actual aperture',value)
 top=b['bottom_m']+b['volume_m3']/b['contactArea_m2']
 rows.append(dict(name=name,liquidNozzle=liquid,gasNozzle=gas,areaMeaning='per 1 m2 effective CdA; contact span is not a throat dimension',entries=entries,fullyCoveredRetainedGasVolume_m3=b['volume_m3']-b['contactArea_m2']*(b['crown_m']-b['bottom_m']),omittedHeadMaximumScale_Pa=liquid['donorDensity_kg_m3']*9.80665*(top-b['sill_m'])))
# Independent realization of the named secondary common-T native M/U equations.
# No nozzle model is calibrated by the following prescribed finite parcel.
def wet(T,Vg,ma,mn,V):
 pv=P('P','T',T,'Q',1,'Water');p=pv+(ma*species['air']['R']+mn*species['nitrogen']['R'])*T/Vg
 def lp(key):return P(key,'P',p,'T',T,'Water') if ma+mn else P(key,'T',T,'Q',0,'Water')
 ml=(V-Vg)*lp('D');mv=Vg*P('D','T',T,'Q',1,'Water');hl=lp('H');hv=P('H','T',T,'Q',1,'Water')
 energy=ml*lp('U')+mv*P('U','T',T,'Q',1,'Water');gasE=mv*hv
 for n,m in [('air',ma),('nitrogen',mn)]:
  energy+=m*species[n]['cv']*(T-298.15);gasE+=m*(species[n]['cv']*(T-298.15)+species[n]['R']*T)
 return dict(T=T,p=p,V=V,Vg=Vg,water=ml+mv,liquid=ml,steam=mv,air=ma,nitrogen=mn,U=energy,hLiquid=hl,hGas=gasE/(mv+ma+mn),hBulk=(ml*hl+gasE)/(ml+mv+ma+mn))
def prepare(pv,pnc,V,Vl):
 T=P('T','P',pv,'Q',1,'Water');Vg=V-Vl
 return wet(T,Vg,pnc*.5*Vg/(species['air']['R']*T),pnc*.5*Vg/(species['nitrogen']['R']*T),V)
def recover(s,M,U,ma,mn):
 def residual(x):
  a=wet(x[0],x[1],ma,mn,s['V']);return [(a['water']-M)/M,(a['U']-U)/U]
 fit=least_squares(residual,[s['T']+.01,s['Vg']*.999],bounds=([s['T']-5,.00001*s['V']],[s['T']+5,.99999*s['V']]),xtol=1e-13,ftol=1e-13,gtol=1e-13)
 if not fit.success:raise ValueError(('Native receiver recovery failed',fit.message))
 a=wet(*fit.x,ma,mn,s['V']);check('native water recovery',a['water'],M,1e-6);check('native energy recovery',a['U'],U,.1);return a
def separated(s,ml,mg):
 totalgas=s['steam']+s['air']+s['nitrogen']
 return dict(water=ml+mg*s['steam']/totalgas,air=mg*s['air']/totalgas,nitrogen=mg*s['nitrogen']/totalgas,U=ml*s['hLiquid']+mg*s['hGas'])
def homogeneous(s,dm):
 total=s['water']+s['air']+s['nitrogen']
 return dict(water=dm*s['water']/total,air=dm*s['air']/total,nitrogen=dm*s['nitrogen']/total,U=dm*s['hBulk'])
def transfer(a,b,q):
 out=recover(a,a['water']-q['water'],a['U']-q['U'],a['air']-q['air'],a['nitrogen']-q['nitrogen'])
 inc=recover(b,b['water']+q['water'],b['U']+q['U'],b['air']+q['air'],b['nitrogen']+q['nitrogen'])
 for key in ['water','air','nitrogen','U']:check('paired '+key,out[key]+inc[key],a[key]+b[key],.2 if key=='U' else 2e-6)
 return dict(donorBefore=a,receiverBefore=b,parcel=q,donorAfter=out,receiverAfter=inc)
sg=prepare(6e6,1e4,120,112.5);header=prepare(5.9e6,2e3,120,.5)
check('forward fixture donor pressure exceeds receiver',float(sg['p']>header['p']),1)
forward=transfer(sg,header,separated(sg,.5,.5))
fullLiquid=separated(sg,1,0)
check('fully covered outlet does not purge air',fullLiquid['air']);check('fully covered outlet does not purge nitrogen',fullLiquid['nitrogen'])
check('covered outlet is liquid enthalpy',fullLiquid['U'],sg['hLiquid'])
# Independent backfeed preparation, not reversal of the forward fixture's
# pressure gradient and not a claim that the prior finite parcel caused it.
reverseHeader=prepare(6.1e6,2e3,120,.5)
check('reverse fixture donor pressure exceeds receiver',float(reverseHeader['p']>sg['p']),1)
reverse=transfer(reverseHeader,sg,homogeneous(reverseHeader,1))
for receiving_f in [0,.5,1]:
 q=homogeneous(reverseHeader,1)
 for key in q:check('reverse donor independent of receiving coverage',q[key],reverse['parcel'][key])
if not reverseHeader['hLiquid']<reverse['parcel']['U']<reverseHeader['hGas']:raise ValueError('Wet header must export actual homogeneous material')
print(json.dumps(dict(scope='Contact-only geometric pickup, pure-water phase-nozzle comparisons and prescribed finite NC parcels; no mist/froth, installed SEP sizing, hydrostatic timing or whole-cycle qualification',basis=d,phaseNozzles=rows,finiteForward=forward,finiteReverse=reverse,fullyCoveredParcel=fullLiquid,checks=checks,versions=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__)),sort_keys=True,allow_nan=False))
`
if(import.meta.main){
 const [python,output,...extra]=process.argv.slice(2)
 if(!python||!output||extra.length)throw Error('Usage: upper-pickup <research-python> <receipt.json>')
 const dependency=new URL('./reference-design-service-pump-mixture.ts',import.meta.url),source=await Bun.file(import.meta.path).text(),dep=await Bun.file(dependency).text()
 const input={basis:upperPickupBasis,species:gasConstants},hash=(s:string)=>createHash('sha256').update(s).digest('hex')
 const proc=Bun.spawn([python,'-c',upperPickupPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
 const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);if(code)throw Error(err)
 if(source!==await Bun.file(import.meta.path).text()||dep!==await Bun.file(dependency).text())throw Error('Source changed during calculation')
 const result={sourceSha256:hash(source),calculationSha256:hash(upperPickupPython),inputSha256:hash(JSON.stringify(input)),gasConstantsSourceSha256:hash(dep),...JSON.parse(out)}
 for(const r of result.phaseNozzles)for(const e of r.entries)if(Math.abs(upperPickupFraction(e.liquidVolume_m3,upperPickupBasis[r.name as keyof typeof upperPickupBasis])-e.f)>1e-12)throw Error('Independent coverage mismatch')
 await Bun.write(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({output,checks:result.checks.length,sourceSha256:result.sourceSha256}))
}
