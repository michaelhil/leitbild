/** Offline effective PRHR phase/exposure contact selection; not an installed plant solver. */
import {createHash} from 'node:crypto'
import {parsePrhrGeometry,auditPrhrGeometry} from './reference-design-prhr-geometry'
import {poolBoilingPython} from './reference-design-pool-boiling'
import {nativePoolContactPython} from './reference-design-native-pool-contact'

export type ContactBasis={gasSensible_W_m2K:number;condensationVelocity_m_s:number;effectiveEmissivity:number;bankFactor:number}
export function parsePrhrContact(text:string):ContactBasis {
 const blocks=[...text.matchAll(/^```reference-prhr-phase-contact\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Exactly one PRHR contact basis required')
 const b=JSON.parse(blocks[0]![1]!)
 if(Object.keys(b).sort().join(',')!=='bankFactor,condensationVelocity_m_s,effectiveEmissivity,gasSensible_W_m2K'||!Object.values(b).every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0)||b.effectiveEmissivity>1||b.bankFactor>1)throw Error('Invalid PRHR contact basis')
 return b
}
/** Actual horizontal cylinder circumference, not circular submerged volume. */
export function prhrImmersedCircumference(level:number,center:number,radius:number):number {
 if(![level,center,radius].every(Number.isFinite)||radius<=0)throw Error('Physical circle required')
 const y=(level-center)/radius
 return y<=-1?0:y>=1?1:.5+Math.asin(y)/Math.PI
}
export function prhrContactPartition(area:number,liquidExposure:number,liquidFlux:number,gasFlux:number){
 if(![area,liquidExposure,liquidFlux,gasFlux].every(Number.isFinite)||area<0||liquidExposure<0||liquidExposure>1)throw Error('Invalid contact area or exposure')
 return {liquid_W:area*liquidExposure*liquidFlux,gas_W:area*(1-liquidExposure)*gasFlux}
}
export function prhrLiquidMixingAvailability(a:number,b:number){
 if(![a,b].every(Number.isFinite)||Math.min(a,b)<0||Math.max(a,b)>1)throw Error('Liquid volume fractions required')
 return a*b
}
/** Condensation demand: externally real material transfer, internally ONLY a thermal constitutive term. */
export function prhrCondensationDemand(b:ContactBasis,rhoV:number,rhoSatAtWall:number,hV:number,hLiquidAtWall:number){
 if(![rhoV,rhoSatAtWall,hV,hLiquidAtWall].every(Number.isFinite)||rhoV<0||rhoSatAtWall<0)throw Error('Invalid vapor contact')
 const mass=rhoV===0?0:b.condensationVelocity_m_s*Math.max(0,rhoV-rhoSatAtWall)
 if(mass>0&&hV<=hLiquidAtWall)throw Error('Condensing donor must carry greater enthalpy')
 return {equivalentCondensationDemand_kg_m2s:mass,heatToSteel_W_m2:mass*(hV-hLiquidAtWall)}
}

export const prhrPhaseContactPython=String.raw`
import sys,json,math,functools
import CoolProp,scipy
import numpy as np
from scipy.integrate import solve_ivp,quad
from scipy.optimize import brentq
from CoolProp.CoolProp import PropsSI as P
from CoolProp import AbstractState,DmassUmass_INPUTS
d=json.load(sys.stdin);geo=d['geometry'];c=d['contact'];g=9.80665;sb=5.670374419e-8;b={'surfaceFactor':1.}
${poolBoilingPython}
checks=[]
def check(name,a,e,atol=1e-6,rtol=1e-9):
 if not math.isfinite(a) or abs(a-e)>max(atol,rtol*abs(e)):raise ValueError((name,a,e))
 checks.append(dict(name=name,actual=a,expected=e))
${nativePoolContactPython}def condensation(pwater,Tgas,Twall,rhoV,hV,pTotal,factor=1):
 # NO saturation lookup with absent steam or with a wall above its dew point.
 if rhoV==0 or pwater==0:return 0.,0.
 dew=P('T','P',pwater,'Q',0,'Water')
 if Twall>=dew:return 0.,0.
 rs=P('D','T',Twall,'Q',1,'Water');hl=P('H','P',pTotal,'T',Twall,'Water')
 m=factor*c['condensationVelocity_m_s']*max(0.,rhoV-rs)
 return m,m*(hV-hl)
def circular_cut(r,u):
 if u<=-r:return 0.,0.,0.
 if u>=r:return math.pi*r*r,0.,2*math.pi*r
 theta=math.acos(abs(u)/r);si=math.sin(theta)
 small=r*r*(theta**3*(2/3-2*theta**2/15+4*theta**4/315) if theta<1e-3 else theta-si*math.cos(theta))
 return (small if u<0 else math.pi*r*r-small),-2*(r*si)**3/3,(2*r*theta if u<0 else 2*r*(math.pi-theta))
def immersed_bank(H):
 t=geo['tubes'];r=t['od_m']/2;R=t['bendRadius_m'];zt=t['top_m'];zb=t['bottom_m'];L=t['straightLeg_m']
 def upper(level,volume):
  if level>=zt+r:return math.pi**2*R*r*r/2 if volume else math.pi**2*R*r
  if level<=zt-R:return 0.
  def value(theta):
   co=math.cos(theta);u=(level-(zt-R+R*co))/co if co>1e-14 else (1e99 if level>=zt-R else -1e99)
   a,m,circ=circular_cut(r,u)
   return R*a+m if volume else R*circ-(2*r*math.sqrt(r*r-u*u) if abs(u)<r else 0)
  points=[math.acos(x) for radius in [R-r,R+r] if 0<(x:=(level-zt+R)/radius)<1]
  return quad(value,0,math.pi/2,points=points,epsabs=1e-10,epsrel=1e-9)[0]
 A=V=0.
 for z in [zt,zb]:
  a,_,circ=circular_cut(r,H-z);A+=L*circ;V+=L*a
 length=max(0.,min(zt-R,H)-(zb+R));A+=2*math.pi*r*length;V+=math.pi*r*r*length
 Afull=math.pi**2*R*r;Vfull=math.pi**2*R*r*r/2
 A+=upper(H,False)+Afull-upper(zt+zb-H,False)
 V+=upper(H,True)+Vfull-upper(zt+zb-H,True)
 A*=t['count'];V*=t['count']
 tubeA=A
 for z in [zt,zb]:
  a,_,circ=circular_cut(geo['header']['od_m']/2,H-z)
  A+=geo['header']['length_m']*circ;V+=geo['header']['length_m']*a
 return A,V,tubeA
fullArea=d['audit']['tube']['outsideArea_m2']+d['audit']['headers']['outsideArea_m2'];fullV=d['audit']['pool']['displacement_m3']
check('full geometric area',immersed_bank(15)[0],fullArea)
check('full geometric volume',immersed_bank(15)[1],fullV)
check('zero geometric area',immersed_bank(10)[0],0)
check('half geometric area',immersed_bank((geo['tubes']['top_m']+geo['tubes']['bottom_m'])/2)[0],fullArea/2)
geometryRows=[]
for H in [d['audit']['pool']['initialSurface_m'],13.28,13.,12.,11.,10.72,10.]:
 A,V,At=immersed_bank(H);water=geo['pool']['width_m']*geo['pool']['length_m']*(H-geo['pool']['floor_m'])-V
 geometryRows.append(dict(surface_m=H,immersedArea_m2=A,exposedArea_m2=fullArea-A,immersedTubeArea_m2=At,displacedVolumeBelowSurface_m3=V,waterVolume_m3=water))
rows=[]
check('strong forced film equal-temperature bypass',contacted(15e6,298.15,298.15,.05,100000)[0],0)
check('strong forced film below saturation bypass',contacted(15e6,298.15,500.,.05,100000)[0],100000*(500.-298.15))
near=sat(15e6)['T']+.01
if near>wet_state(15e6,298.15,near,.05,100000)[1]:raise ValueError('Intended above-saturation pre-ONB test is not pre-ONB')
check('strong forced film above saturation pre-ONB bypass',contacted(15e6,298.15,near,.05,100000)[0],100000*(near-298.15))
for p in [101325.,3e5,6e5,5e6,15e6,16e6]:
 s=sat(p)
 for D in [geo['tubes']['od_m'],geo['header']['od_m'],geo['tubes']['id_m']]:
  T=min(363.15,s['T']);tc,tm,qc,qm=endpoints(p,T,D)
  for join in [tc,tm]:
   qa=contacted(p,T,join-1e-6,D)[0];qb=contacted(p,T,join+1e-6,D)[0]
   check('boiling curve join',qa,qb,atol=1.,rtol=1e-5)
  check('equal temperature',contacted(p,T,T,D)[0],0)
  if contacted(p,T,T-1,D)[0]>=0:raise ValueError('Reversed contact heats wrong owner')
  rows.append(dict(pressure_Pa=p,pool_K=T,diameter_m=D,TCHF_K=tc,Tmin_K=tm,qCHF_W_m2=qc,qmin_W_m2=qm,
   fluxAt900K_W_m2=contacted(p,T,900,D)[0]))
for p in [5e5,5e6,15e6,16e6]:
 T=sat(p)['T'];D=geo['tubes']['id_m'];tc,tm,qc,qm=endpoints(p,T,D)
 check('saturated equal-temperature internal film',internal_stagnant_h(p,T,T,D)*(T-T),0)
 rows.append(dict(pressure_Pa=p,pool_K=T,diameter_m=D,TCHF_K=tc,Tmin_K=tm,qCHF_W_m2=qc,qmin_W_m2=qm,scope='saturated-primary effective boiling endpoints; no forced DNB claim'))
gasRows=[]
for fraction in [0.,.01,.1,.5,1.]:
 total=5e5;pv=total*fraction;Tg=450.;Tw=350.
 rv=P('D','P',pv,'T',Tg,'Water') if pv else 0.;hv=P('H','P',pv,'T',Tg,'Water') if pv else 0.
 md,qc=condensation(pv,Tg,Tw,rv,hv,total)
 gasRows.append(dict(steamPartialPressureFraction=fraction,totalPressure_Pa=total,steamPartialPressure_Pa=pv,bulkGas_K=Tg,steel_K=Tw,steamDensity_kg_m3=rv,condensationDemand_kg_m2s=md,condensationHeatToSteel_W_m2=qc,gasSensibleHeatToSteel_W_m2=c['gasSensible_W_m2K']*(Tg-Tw)))
# The selected effective coefficient, not an imposed mass-flow floor: signed/zero dry sensible and radiation.
for Tw,Tg,Ts in [(500.,300.,300.),(300.,500.,500.),(400.,400.,400.)]:
 qg=c['gasSensible_W_m2K']*(Tw-Tg);qr=c['effectiveEmissivity']*sb*(Tw**4-Ts**4)
 check('dry receiver energy reciprocity',-qg-qr+qg+qr,0)
 if qg*(1/Tg-1/Tw)<0 or qr*(1/Ts-1/Tw)<0:raise ValueError('Dry heat violates reservoir entropy sign')
# Internal thermal-only coupon: actual finite primary M/V/U and steel energy; no net-flow forcing.
D=geo['tubes']['id_m'];OD=geo['tubes']['od_m'];L=.25;A=math.pi*D*L;V=math.pi*D*D*L/4
C=math.pi*(OD*OD-D*D)/4*L*geo['steelDensity_kg_m3']*geo['steelCp_J_kgK']
coupons=[]
for p0 in [5e5,5e6]:
 s=sat(p0);alpha0=.5;M=V*((1-alpha0)*s['rl']+alpha0*s['rv']);U0=V*((1-alpha0)*s['rl']*s['ul']+alpha0*s['rv']*s['uv']);Tw0=s['T']-40
 for factor in [.5,1.,2.]:
  fluid=AbstractState('HEOS','Water')
  def evaluate(y):
   fluid.update(DmassUmass_INPUTS,M/V,(U0+y[0])/M);T=fluid.T();p=fluid.p();qmass=fluid.Q();Tw=Tw0+y[1]/C
   if qmass>=0:
    ss=sat(p);alpha=qmass*M/(ss['rv']*V)
    mcond,qcond=condensation(p,T,Tw,ss['rv'],ss['hv'],p,factor)
    hl=internal_stagnant_h(p,T,Tw,D)
   else:
    if T>=sat(p)['T']:raise ValueError('Dense cooling coupon reached an unselected single-phase gas fixture')
    alpha=0.;mcond=qcond=0.;hl=internal_stagnant_h(p,T,Tw,D)
   liquid=(1-alpha)*hl*(T-Tw);gas=alpha*(factor*c['gasSensible_W_m2K']*(T-Tw)+qcond)
   return A*(liquid+gas),T,p,Tw,alpha
  def rhs(t,y):
   Q,*_=evaluate(y);return [-Q,Q]
  runs=[solve_ivp(rhs,[0,5],[0.,0.],method='Radau',rtol=r,atol=1e-7,dense_output=True) for r in [1e-8,1e-10]]
  if not all(r.success for r in runs):raise ValueError('Finite thermal coupon failed')
  sample=np.linspace(0,5,31);err=max(abs(sum(runs[1].sol(t))) for t in sample)
  diff=float(np.max(np.abs(runs[0].sol(sample)-runs[1].sol(sample))))
  check('finite coupon energy',err,0,atol=1e-6);check('coupon tolerance pair',diff,0,atol=.01)
  Q,T,p,Tw,alpha=evaluate(runs[1].y[:,-1]);ss=sat(p)
  coupons.append(dict(initialPressure_Pa=p0,factor=factor,waterMass_kg=M,waterVolume_m3=V,steelCapacity_J_K=C,duration_s=5,steelReceived_J=float(runs[1].y[1,-1]),finalWater_K=T,finalSteel_K=Tw,finalPressure_Pa=p,finalVaporVolumeFraction=alpha,initialVaporMass_kg=alpha0*s['rv']*V,finalVaporMass_kg=alpha*ss['rv']*V,energyResidual_J=err,toleranceDifference_J=diff))
check('no steam bypass',sum(condensation(0,400,300,0,0,1e5)),0)
check('above dewpoint no condensation',sum(condensation(1e5,400,450,1,3e6,2e5)),0)
# Pressure-supported local exterior fixture: actual tube steel, finite pool/vapor/shell/collector.
# Drain/refill are explicitly metered test interventions, not a plant time-trigger or predicted drain.
sp=sat(101325.);hl=sp['hl'];hv=sp['hv'];hfg=hv-hl;T0=sp['T'];area=math.pi*OD*L;plan=.02;Csh=2500e6
def level_for_mass(m):
 if m<=0:return 0.
 return brentq(lambda h:plan*h-L*circular_cut(OD/2,h-OD/2)[0]-m/sp['rl'],0,1,xtol=1e-12)
def external_rates(y):
 ml,Ew,mv,Hv,Esh,mc,Hc=y;Tw=900+Ew/C;Tg=P('T','P',101325.,'H',Hv/mv,'Water');Tsh=298.15+Esh/Csh
 H=level_for_mass(ml);f=circular_cut(OD/2,H-OD/2)[2]/(math.pi*OD)
 qwet=area*f*c['bankFactor']*contacted(101325.,T0,Tw,OD)[0] if ml>0 else 0.
 if qwet<0:raise ValueError('This hot-wall fixture does not prescribe reverse saturated pool mass supply')
 qgas=area*(1-f)*c['gasSensible_W_m2K']*(Tw-Tg);qrad=area*(1-f)*c['effectiveEmissivity']*sb*(Tw**4-Tsh**4)
 evaporation=qwet/hfg
 return np.array([-evaporation,-qwet-qgas-qrad,evaporation,evaporation*hv+qgas,qrad,0.,0.]),dict(wall_K=Tw,gas_K=Tg,liquidMass_kg=ml,immersedFraction=f,poolHeat_W=qwet,gasHeat_W=qgas,shellHeat_W=qrad)
y0=np.array([1.,0.,.01,.01*hv,0.,0.,0.]);initialH=y0[0]*hl+y0[3]
external=[]
for rtol in [1e-8,1e-10]:
 y=y0.copy();states=[];maxErr=0.;v0=1/sp['rl']+.01/sp['rv']
 for name,duration in [('wet',1.),('dry',5.),('reimmersed',1.)]:
  if name=='dry':
   wallBefore=y[1];y[5]+=y[0];y[6]+=y[0]*hl;y[0]=0.;check('drain retains steel energy',y[1],wallBefore)
  if name=='reimmersed':
   wallBefore=y[1];y[0]+=y[5];y[5]=0.;y[6]=0.;check('refill retains steel energy',y[1],wallBefore)
  before=external_rates(y)[1]
  sol=solve_ivp(lambda t,y:external_rates(y)[0],[0,duration],y,method='Radau',rtol=rtol,atol=[1e-12,1e-7,1e-12,1e-7,1e-7,1e-12,1e-7],dense_output=True)
  if not sol.success:raise ValueError('External contact fixture failed')
  for time in np.linspace(0,duration,21):
   a=sol.sol(time);err=abs(a[0]*hl+sum(a[[1,3,4,6]])-initialH);maxErr=max(maxErr,err)
   check('finite exterior mass',a[0]+a[2]+a[5],1.01,atol=1e-10)
  y=sol.y[:,-1];after=external_rates(y)[1];states.append(dict(stage=name,duration_s=duration,before=before,after=after))
 pressureWork=101325*(y[0]/sp['rl']+y[2]/P('D','P',101325,'H',y[3]/y[2],'Water')+y[5]/sp['rl']-v0)
 check('finite exterior enthalpy plus steel/shell ledger',maxErr,0,atol=1e-5)
 external.append(dict(tolerance=rtol,stages=states,finalStates=y.tolist(),totalEnergyLedgerResidual_J=maxErr,pressureBoundaryWork_J=pressureWork,scope='Constant-pressure finite laboratory receiver; internal-energy change is minus reported pressure work, not a fixed-CNV trajectory'))
check('exterior tolerance pair maximum state difference',float(np.max(np.abs(np.array(external[0]['finalStates'])-np.array(external[1]['finalStates'])))),0,atol=.01)
print(json.dumps(dict(numericalChecksPassed=True,versions={'CoolProp':CoolProp.__version__,'scipy':scipy.__version__,'numpy':np.__version__},checks=checks,immersionGeometry=geometryRows,boilingEndpoints=rows,steamDilutionContact=gasRows,finiteInternalCoupons=coupons,finiteExteriorContact=external,
 scope='Effective contact selection, ordered boiling branches, and isolated finite primary/steel energy/phase coupons; not installed startup, pressure-network or30min cooling qualification.'),allow_nan=False))
`
if(import.meta.main){
 const [owner,python,output,...rest]=process.argv.slice(2)
 if(!owner||!python||!output||rest.length)throw Error('Usage: prhr-phase-contact <owner.md> <python> <receipt.json>')
 const names=['reference-design-prhr-geometry.ts','reference-design-pool-boiling.ts','reference-design-native-pool-contact.ts']
 const source=await Bun.file(import.meta.path).text(),ownerText=await Bun.file(owner).text(),bytes=Object.fromEntries(await Promise.all(names.map(async n=>[n,await Bun.file(new URL(n,import.meta.url)).text()])))
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),geometry=parsePrhrGeometry(ownerText),contact=parsePrhrContact(ownerText),input={geometry,contact,audit:auditPrhrGeometry(geometry)}
 const proc=Bun.spawn([python,'-c',prhrPhaseContactPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
 const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);if(code)throw Error(err)
 if(await Bun.file(import.meta.path).text()!==source||await Bun.file(owner).text()!==ownerText)throw Error('Source/input changed during calculation')
 for(const n of names)if(await Bun.file(new URL(n,import.meta.url)).text()!==bytes[n])throw Error('Dependency changed during calculation')
 const result={sourceSha256:hash(source),calculationSha256:hash(prhrPhaseContactPython),inputSha256:hash(JSON.stringify(input)),dependencies:Object.fromEntries(names.map(n=>[n,hash(bytes[n]!)])),contact,...JSON.parse(out)}
 await Bun.write(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2))
}
