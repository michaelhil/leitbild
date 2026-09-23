/** Bounded fixed-region carrier selection. No spatial pressure solver or plant trajectory. */
import {createHash} from 'node:crypto'
import {heaterBankBasis as bank,heaterBankGeometry} from './reference-design-pressurizer-heater-banks'

export function pressurizerCarrierGeometry(){
 const levels=[0,1,3,6,9,12],ri=Math.sqrt(bank.upflowArea_m2/Math.PI),ro=Math.sqrt(bank.vesselArea_m2/Math.PI)
 return levels.slice(0,-1).flatMap((bottom,i)=>{
  const top=levels[i+1]!,length=top-bottom,lo=heaterBankGeometry(bottom),hi=heaterBankGeometry(top)
  const solid=hi.submergedSolid_m3-lo.submergedSolid_m3
  const count=(bottom<1?bank.normal.count:0)+(bottom<3?bank.backup.count:0)
  return [{lane:'inner',bottom_m:bottom,top_m:top,volume_m3:.5*length-solid,solidVolume_m3:solid,
   solidPerimeter_m:count*Math.PI*.02,lateralArea_m2:2*Math.PI*ri*length},
  {lane:'outer',bottom_m:bottom,top_m:top,volume_m3:4.5*length,solidVolume_m3:0,
   solidPerimeter_m:2*Math.PI*ro,lateralArea_m2:2*Math.PI*ri*length}]
 })
}

export const carrierPython=String.raw`
import json,sys,math
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
d=json.load(sys.stdin);g=9.80665;checks=[]
def check(name,x,y=0.,tol=1e-8):
 if not math.isfinite(x) or abs(x-y)>tol:raise ValueError((name,x,y,tol))
 checks.append(dict(name=name,actual=x,expected=y,tolerance=tol))
def require(name,x):check(name,1. if x else 0.,1.,0.)
def phase(p,T,kind):
 ts=P('T','P',p,'Q',0,'Water');q=0 if kind=='liquid' else 1
 def prop(key):return P(key,'P',p,'Q',q,'Water') if T==ts else P(key,'P',p,'T|'+kind,T,'Water')
 return dict(T=T,**{n:prop(key) for n,key in [('rho','D'),('h','H'),('u','U'),('mu','V'),('k','L'),('cp','C')]})
def coeff(q,slip,scale):
 Re=q['rho']*slip*scale/q['mu'];Pr=q['cp']*q['mu']/q['k']
 return q['k']/scale*(2+.6*math.sqrt(Re)*Pr**(1/3))
def exchange(p,l,v,ul,uv,area,scale=.003):
 if area==0:return dict(gamma=0.,liquidEnergy=0.,vaporEnergy=0.,Ql=0.,Qv=0.)
 ts=P('T','P',p,'Q',0,'Water');hl=P('H','P',p,'Q',0,'Water');hv=P('H','P',p,'Q',1,'Water')
 slip=math.dist(ul,uv);Ql=area*coeff(l,slip,scale)*(l['T']-ts);Qv=area*coeff(v,slip,scale)*(v['T']-ts)
 gamma=(Ql+Qv)/(hv-hl)
 return dict(gamma=gamma,liquidEnergy=-gamma*hl-Ql,vaporEnergy=gamma*hv-Qv,Ql=Ql,Qv=Qv)
def drag(alpha,l,v,ul,uv,V,scale=.003):
 if alpha==0 or alpha==1:return dict(force=[0.,0.],liquidWork=0.,gasWork=0.,gasDissipation=0.)
 w=[b-a for a,b in zip(ul,uv)];speed=math.hypot(*w);rho=(1-alpha)*l['rho']+alpha*v['rho'];mu=(1-alpha)*l['mu']+alpha*v['mu']
 Re=rho*speed*scale/mu;cdre=24*(1+.15*Re**.687) if Re<1000 else .44*Re
 F=[.75*cdre*mu*V*alpha*(1-alpha)*x/scale**2 for x in w]
 work=sum(f*u for f,u in zip(F,ul));diss=sum(f*u for f,u in zip(F,w))
 return dict(force=F,liquidWork=work,gasWork=-work,gasDissipation=diss)
def wall_force(q,u,area,perimeter,length,fraction):
 if perimeter==0 or fraction==0:return [0.,0.]
 speed=math.hypot(*u);dh=4*area/perimeter
 if speed==0:return [0.,0.]
 Re=q['rho']*speed*dh/q['mu']
 if Re<=2300:f=64/Re
 else:
  ft=brentq(lambda f:1/math.sqrt(f)+2*math.log10(45e-6/(3.7*dh)+2.51/(Re*math.sqrt(f))),.005,.2)
  f=ft if Re>=4000 else (4000-Re)/1700*(64/Re)+(Re-2300)/1700*ft
 return [-fraction*perimeter*length*f/8*q['rho']*speed*x for x in u]
rows=[]
for p in [1e6,15e6]:
 ts=P('T','P',p,'Q',0,'Water');l=phase(p,ts-20,'liquid');v=phase(p,ts+20,'gas')
 for alpha in [0.,.05,.5,.95,1.]:
  for sign in [-1.,0.,1.]:
   ul=[.1*sign,-.2*sign];uv=[-.2*sign,.8*sign];V=.01;area=6*V*alpha*(1-alpha)/.003
   ex=exchange(p,l if alpha<1 else None,v if alpha>0 else None,ul,uv,area)
   dr=drag(alpha,l if alpha<1 else None,v if alpha>0 else None,ul,uv,V)
   check('bulk thermal source cancellation',ex['liquidEnergy']+ex['vaporEnergy'],tol=1e-7)
   check('drag total-energy cancellation',dr['liquidWork']+dr['gasWork'])
   require('drag opposes vector slip',dr['gasDissipation']>=0)
   rows.append(dict(p_Pa=p,alphaGas=alpha,liquidVelocity_m_s=ul,gasVelocity_m_s=uv,area_m2=area,exchange=ex,drag=dr))
faces=[]
for p in [1e6,15e6]:
 ts=P('T','P',p,'Q',0,'Water')
 for orientation in [-1,1]:
  for temperatures in [(-20.,0.),(0.,20.),(0.,0.)]:
   l=phase(p,ts+temperatures[0],'liquid');v=phase(p,ts+temperatures[1],'gas')
   for factor in [0.,1.,2.]:
    # Neighbor contrast1: pure liquid versus pure gas. Orientation reverses ownership, not heat signs.
    ex=exchange(p,l,v,[0.,-.2],[0.,.4],factor)
    check('face Stefan thermal source cancellation',ex['liquidEnergy']+ex['vaporEnergy'],tol=1e-7)
    if temperatures==(-20.,0.):require('face condensation uses present gas donor',ex['gamma']<=0)
    if temperatures==(0.,20.):require('face evaporation uses present liquid donor',ex['gamma']>=0)
    faces.append(dict(p_Pa=p,liquidSide='left' if orientation==1 else 'right',gasSide='right' if orientation==1 else 'left',factor=factor,**ex))
# Actual inner-lane neighbors across the backup rod top. The solid end area
# is not a fluid aperture; its thermal contact remains omitted by the bank owner.
lower=d['geometry'][2];upper=d['geometry'][4]
faceA=min(lower['volume_m3']/(lower['top_m']-lower['bottom_m']),upper['volume_m3']/(upper['top_m']-upper['bottom_m']))
areaContributions=[]
for al,ar in [(1.,0.),(.8,.2)]:
 bulkArea=6*(lower['volume_m3']*al*(1-al)+upper['volume_m3']*ar*(1-ar))/.003
 supplement=faceA*abs(al-ar)
 for factor in [0.,1.,2.]:areaContributions.append(dict(leftLiquidFraction=al,rightLiquidFraction=ar,bulkArea_m2=bulkArea,faceArea_m2=supplement,faceFactor=factor,totalEffectiveArea_m2=bulkArea+factor*supplement))
require('pure neighboring phases have nonzero nominal contact',areaContributions[1]['totalEffectiveArea_m2']>0)
# Finite paired material transfer at one actual common-pressure/elevation face.
# Same-phase transfer preserves native density; source exhaustion and empty receiving
# phase are exact events. The recipient's existing other phase stays unchanged.
p=1e6;ts=P('T','P',p,'Q',0,'Water');l=phase(p,ts-20,'liquid');v=phase(p,ts+40,'gas');z=8.
def state(m,q,velocity):
 if m==0:return dict(M=0.,P=[0.,0.],E=0.,V=0.)
 return dict(M=m,P=[m*x for x in velocity],E=m*(q['u']+sum(x*x for x in velocity)/2+g*z),V=m/q['rho'])
initial=state(.01,l,[.3,-.4]);other=state(.002,v,[0.,.1]);empty=state(0,None,None)
packetE=initial['M']*(l['h']+.5*(.3**2+.4**2)+g*z)
# Donor loses flowing H; pressure traction performs the reciprocal volume work.
donorAfter=dict(M=0.,P=[0.,0.],E=initial['E']-packetE+p*initial['V'],V=0.)
receiver=state(.01,l,[.3,-.4]);receiverE=packetE-p*receiver['V']
check('exhausted donor energy routes exactly',donorAfter['E'],tol=1e-9)
check('empty phase receives native U K PE',receiverE,receiver['E'],1e-9)
check('paired finite mass',donorAfter['M']+receiver['M'],initial['M'])
check('paired finite energy',donorAfter['E']+receiverE+other['E'],initial['E']+other['E'],1e-8)
for i in range(2):check('paired finite momentum',donorAfter['P'][i]+receiver['P'][i],initial['P'][i])
check('existing opposing gas not reset',other['E'],state(.002,v,[0.,.1])['E'])
# Reverse transfer uses new actual donor; no stale phase on the now-empty side.
reverseE=receiver['M']*(l['h']+.5*(.3**2+.4**2)+g*z)
check('reverse returns native energy',reverseE-p*receiver['V'],initial['E'],1e-9)
transfer=dict(scope='Finite same-phase common-face parcel, phase exhaustion/refill and reciprocal pressure work; no pressure-driven rate or rigid-cell trajectory',before=initial,after=donorAfter,recipient=receiver,retainedOpposingGas=other,flowingEnergy_J=packetE,pressureVolumeWork_J=p*initial['V'])
wall=[]
for region in d['geometry']:
 L=region['top_m']-region['bottom_m'];A=region['volume_m3']/L
 for u in [[0.,0.],[.2,-.5],[-.2,.5]]:
  F=wall_force(l,u,A,region['solidPerimeter_m'],L,.5)
  require('solid drag passive',sum(f*x for f,x in zip(F,u))<=1e-12)
  wall.append(dict(lane=region['lane'],bottom_m=region['bottom_m'],velocity=u,force_N=F))
# Pure-water fixed-density DP calibration. Actual future signal uses static taps,
# not this density integral. Equal outer fields do not establish equal inner wetness.
pr=15e6;rl=P('D','P',pr,'Q',0,'Water');rv=P('D','P',pr,'Q',1,'Water')
def height(dp):return (dp-rv*g*12)/((rl-rv)*g)
dp=[]
for h in [0.,3.,3.5,6.,12.]:
 raw=g*(rl*h+rv*(12-h));check('fixed reference DP calibration',height(raw),h)
 dp.append(dict(referenceHeight_m=h,differential_Pa=raw,indicated_m=height(raw)))
same=dict(scope='Two distinct prepared nonsteady states with identical outer static tap pressures, not hydrostatic equilibrium of both lanes',
 differential_Pa=dp[3]['differential_Pa'],indicated_m=6.,innerLiquidFractions=[1.,.1],relativeHeaterWetAreas=[1.,.1])
sensitivity=[]
for scale in [.0015,.003,.006]:
 ex=exchange(1e6,l,v,[0.,0.],[0.,.5],6*.01*.5*.5/scale,scale)
 dr=drag(.5,l,v,[0.,0.],[0.,.5],.01,scale)
 sensitivity.append(dict(scale_m=scale,**ex,drag_N=dr['force'][1]))
check('gross fluid geometry',sum(r['volume_m3'] for r in d['geometry']),60-.25132741228718347,1e-10)
print(json.dumps(dict(scope='Fixed-region constitutive and finite-face engineering evidence only; spatial phase-pressure mechanics, hydrostatic initialization and coupled carrier response are not executed',
 properties=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),bulk=rows,faces=faces,areaContributions=areaContributions,finiteTransfer=transfer,wall=wall,
 DPcalibration=dict(pressure_Pa=pr,liquidDensity_kg_m3=rl,vaporDensity_kg_m3=rv,rows=dp,sameSignalDifferentCoverage=same),scaleSensitivity=sensitivity,checks=checks),allow_nan=False))
`

export async function runCarrier(python:string){
 const hash=(x:string)=>createHash('sha256').update(x).digest('hex'),source=await Bun.file(import.meta.path).text()
 const path=new URL('reference-design-pressurizer-heater-banks.ts',import.meta.url),dependency=await Bun.file(path).text()
 const input={geometry:pressurizerCarrierGeometry(),effectiveDiameter_m:.003}
 const child=Bun.spawn([python,'-c',carrierPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
 if(code!==0)throw Error(err)
 if(source!==await Bun.file(import.meta.path).text()||dependency!==await Bun.file(path).text())throw Error('Source changed during calculation')
 return {sourceSha256:hash(source),geometrySourceSha256:hash(dependency),calculationSha256:hash(carrierPython),inputSha256:hash(JSON.stringify(input)),input,...JSON.parse(out)}
}
if(import.meta.main){
 const [python,output,...extra]=process.argv.slice(2)
 if(!python||!output||extra.length)throw Error('Usage: pressurizer-carrier <research-python> <receipt.json>')
 const result=await runCarrier(python)
 await Bun.write(output,JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify({output,sourceSha256:result.sourceSha256,calculationSha256:result.calculationSha256,checks:result.checks.length}))
}
