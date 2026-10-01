/** Bounded observation comparisons, not a connected plant or SI-termination solver. */
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {parseCetBasis,cetGeometry,cetHeat,type CetBasis,type CetEnvironment} from './reference-design-cet'
const positive=z.number().finite().positive()
const schema=z.object({coreBottom_m:z.number().finite(),coreTop_m:z.number().finite(),
 headTop_m:z.number().finite(),coreArea_m2:positive,gravity_m_s2:positive,
 referencePressure_Pa:positive,calibrationTemperature_K:positive,
 dpLag_s:positive,dpQuantum_Pa:positive,dpUncertainty_Pa:positive,
 heaterResistance_ohm:positive,heaterVoltage_V:positive,
 temperatureUncertainty_K:positive,temperatureQuantum_K:positive,
 powerUncertainty_W:positive,powerQuantum_W:positive,minimumTestPower_W:positive,
 maximumTestPower_W:positive}).strict().refine(b=>b.coreTop_m>b.coreBottom_m&&b.headTop_m>b.coreTop_m,'Ordered physical tap spans required')
 .refine(b=>b.maximumTestPower_W>b.minimumTestPower_W,'Ordered heater-test power interval required')
export function parseCoreInventory(document:string){
 const blocks=[...document.matchAll(/^```reference-core-inventory\s*\n([\s\S]*?)^```\s*$/gm)]
 if(blocks.length!==1)throw Error('Expected one reference-core-inventory block')
 return schema.parse(JSON.parse(blocks[0]![1]!))
}
/** Indication only: neither true density nor a phase correction enters this channel. */
export function fixedDensityHeight(dp:number,density:number,gravity:number){
 if(!Number.isFinite(dp)||![density,gravity].every(v=>Number.isFinite(v)&&v>0))throw Error('Invalid DP calibration')
 return dp/(density*gravity)
}
export function heatedProbeHeat(b:CetBasis,body_C:number,environment:CetEnvironment,power_W:number){
 if(!Number.isFinite(power_W)||power_W<0)throw Error('Invalid delivered heater power')
 const q=cetHeat(b,body_C,environment)
 return {...q,probe_W:q.probe_W+power_W,electrical_W:-power_W}
}
function equilibrium(b:CetBasis,e:CetEnvironment,power:number){
 let lo=b.minimumBody_C,hi=b.maximumBody_C
 if(heatedProbeHeat(b,lo,e,power).probe_W<0||heatedProbeHeat(b,hi,e,power).probe_W>0)throw Error('Heated equilibrium outside body domain')
 for(let i=0;i<60;i++){const m=(lo+hi)/2;if(heatedProbeHeat(b,m,e,power).probe_W>0)lo=m;else hi=m}
 return (lo+hi)/2
}
export function heatedComparison(b:CetBasis,power:number,testPowers:readonly number[]=[power]){
 if(!testPowers.length||testPowers.some(p=>!Number.isFinite(p)||p<=0))throw Error('Positive actual test powers required')
 const rows:Array<{filmFactor:number;radiationFactor:number;bath_C:number;clad_C:number;
  liquidExposure:number;reference_C:number;heated_C:number;difference_K:number}>=[]
 for(const filmFactor of [.5,1,2])for(const radiationFactor of [0,.03,.09])for(const bath_C of [40,300])for(const clad_C of [bath_C,700])for(const liquidExposure of [0,.5,1]){
  const actual={...b,liquidFilm_W_m2K:b.liquidFilm_W_m2K*filmFactor,gasFilm_W_m2K:b.gasFilm_W_m2K*filmFactor,effectiveRadiationFactor:radiationFactor}
  const e={liquidExposure,liquid_C:bath_C,gas_C:bath_C,clad:[{areaWeight:1,temperature_C:clad_C}]}
  const reference_C=equilibrium(actual,e,0),heated_C=equilibrium(actual,e,power)
  rows.push({filmFactor,radiationFactor,bath_C,clad_C,liquidExposure,reference_C,heated_C,difference_K:heated_C-reference_C})
 }
 // Different heat-transfer contacts can bias a healthy pair. Keep this
 // contrary distinct from its deliberately common-contact calibration.
 const unequal=[]
 for(const heatedFilmFactor of [.5,1,2])for(const referenceFilmFactor of [.5,1,2]){
  const e={liquidExposure:0,gas_C:40,clad:[{areaWeight:1,temperature_C:700}]}
  const make=(factor:number)=>({...b,gasFilm_W_m2K:b.gasFilm_W_m2K*factor,effectiveRadiationFactor:.09})
  const heated_C=equilibrium(make(heatedFilmFactor),e,power),reference_C=equilibrium(make(referenceFilmFactor),e,0)
  unequal.push({heatedFilmFactor,referenceFilmFactor,heated_C,reference_C,difference_K:heated_C-reference_C})
 }
 const dry={liquidExposure:0,gas_C:40,clad:[{areaWeight:1,temperature_C:700}]}
 const fixedHeated=equilibrium({...b,effectiveRadiationFactor:.09},dry,power)
 let low=.5,high=1
 for(let i=0;i<60;i++){
  const m=(low+high)/2,ref=equilibrium({...b,gasFilm_W_m2K:b.gasFilm_W_m2K*m,effectiveRadiationFactor:.09},dry,0)
  if(fixedHeated-ref<2)low=m;else high=m
 }
 const mimickingReferenceFactor=(low+high)/2
 // In an explicitly held environment, a heater step removes unequal-contact
 // baseline offset without changing either body or the reference channel.
 const stepRows=testPowers.flatMap(testPower_W=>rows.map(q=>{
  const actual={...b,liquidFilm_W_m2K:b.liquidFilm_W_m2K*q.filmFactor,gasFilm_W_m2K:b.gasFilm_W_m2K*q.filmFactor,effectiveRadiationFactor:q.radiationFactor}
  const e={liquidExposure:q.liquidExposure,liquid_C:q.bath_C,gas_C:q.bath_C,clad:[{areaWeight:1,temperature_C:q.clad_C}]}
  const rhs=(T:number)=>heatedProbeHeat(actual,T,e,testPower_W).probe_W/cetGeometry(actual).capacity_J_K
  let T=q.reference_C
  const history=[]
  for(let i=1;i<=1200;i++){
   const h=.1,k1=rhs(T),k2=rhs(T+h*k1/2),k3=rhs(T+h*k2/2),k4=rhs(T+h*k3)
   T+=h*(k1+2*k2+2*k3+k4)/6
   if([100,600,1200].includes(i))history.push({seconds:i*h,increment_K:T-q.reference_C})
  }
  return {...q,testPower_W,history,increment120_K:T-q.reference_C}
 }))
 // Analytic equal-temperature bath, radiation-free, retained-body response.
 // Drying retains both temperatures; no reinitialization to fluid truth.
 const g=cetGeometry(b),wetG=g.area_m2*b.liquidFilm_W_m2K,dryG=g.area_m2*b.gasFilm_W_m2K
 const wetDifference=power/wetG,dryDifference=power/dryG
 const drying=[0,10,60,120,300,600].map(seconds=>({seconds,difference_K:dryDifference+(wetDifference-dryDifference)*Math.exp(-seconds*dryG/g.capacity_J_K)}))
 const rewetting=[0,1,5,10,30].map(seconds=>({seconds,difference_K:wetDifference+(dryDifference-wetDifference)*Math.exp(-seconds*wetG/g.capacity_J_K)}))
 return {scope:'Prescribed phase-contact and thermal baths, not an achieved vessel response',rows,unequal,
  mimickingDryAbsoluteDifference:{referenceFilmFactor:mimickingReferenceFactor,heated_C:fixedHeated,difference_K:2},
  stepRows,drying,rewetting,wetDifference_K:wetDifference,dryDifference_K:dryDifference}
}
export const coreInventoryHydro=String.raw`
import json,sys,math
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.integrate import solve_ivp
from scipy.optimize import brentq
b=json.load(sys.stdin);checks=[];g=b['gravity_m_s2'];A=b['coreArea_m2'];lo=b['coreBottom_m'];hi=b['coreTop_m'];p0=b['referencePressure_Pa']
def check(name,ok,**values):
 if not ok:raise ValueError((name,values))
 checks.append(dict(name=name,**values))
def column(label,gasAt,T=None,record=True):
 # Held isothermal all-liquid or held local saturation contact apparatus.
 # The prescribed distribution is NOT a reached fluid/energy trajectory.
 def rhs(z,y):
  p=float(y[0]);alpha=gasAt(z)
  rho=P('D','P',p,'T',T,'Water') if T is not None else (1-alpha)*P('D','P',p,'Q',0,'Water')+alpha*P('D','P',p,'Q',1,'Water')
  return [-g*rho,A*rho]
 # Split at the known fixture boundary: do not smear its discontinuity.
 y=[p0,0.]
 for za,zb in [(hi,1.),(1.,0.),(0.,lo)]:
  s=solve_ivp(rhs,(za,zb),y,method='DOP853',rtol=1e-11,atol=[1e-5,1e-8],max_step=.1)
  if not s.success:raise ValueError(s.message)
  y=s.y[:,-1]
 dp=float(y[0]-p0);mass=float(-y[1]);rhoCal=P('D','P',p0,'T',b['calibrationTemperature_K'],'Water')
 if abs(dp-g*mass/A)>=1e-6:raise ValueError('Static pressure/mass incidence failed')
 if record:check(label+' static pressure/mass incidence',True,DP_Pa=dp,waterMixture_kg=mass)
 return dict(case=label,DP_Pa=dp,mixtureMass_kg=mass,indicatedHeight_m=dp/(g*rhoCal))
rows=[column('cold full liquid',lambda z:0,b['calibrationTemperature_K']),column('hot full liquid',lambda z:0,450.),column('saturated full liquid',lambda z:0),column('top metre fully gas',lambda z:1 if z>1 else 0)]
target=rows[-1]['DP_Pa']
f=brentq(lambda a:column('matching lower distribution',lambda z:a if z<0 else 0,record=False)['DP_Pa']-target,.01,1.,xtol=1e-12)
same=column('lower gas contact same DP',lambda z:f if z<0 else 0);rows.append(same)
check('same integral cannot determine top contact',abs(same['DP_Pa']-target)<1e-5,DPDifference_Pa=same['DP_Pa']-target,lowerGasFraction=f)
mask=rows[2]['DP_Pa']-target
check('dynamic head can conceal static inventory deficit',mask>10*b['dpUncertainty_Pa'],requiredDynamicHead_Pa=mask)
check('cold fixed calibration is not hot full height',abs(rows[1]['indicatedHeight_m']-(hi-lo))>.1,height_m=rows[1]['indicatedHeight_m'])
print(json.dumps(dict(scope='Prescribed native static water columns and deliberately added dynamic-head ambiguity, not a LOCA',libraries=dict(CoolProp=CoolProp.__version__,SciPy=scipy.__version__),rows=rows,matchingGasFraction=f,maskingDynamicHead_Pa=mask,checks=checks),allow_nan=False))
`
export async function runCoreInventory(owner:string,cetOwner:string,python:string){
 const document=await Bun.file(owner).text(),cetDocument=await Bun.file(cetOwner).text(),basis=parseCoreInventory(document),cet=parseCetBasis(cetDocument)
 const input=JSON.stringify(basis),p=Bun.spawn([python,'-c',coreInventoryHydro],{stdin:new Blob([input]),stdout:'pipe',stderr:'pipe'})
 const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(code)throw Error(err)
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),power=basis.heaterVoltage_V**2/basis.heaterResistance_ohm
 return {scope:'Separate-effects DP and powered-probe selection; no coupled recovery/termination permission',ownerSHA256:hash(document),cetOwnerSHA256:hash(cetDocument),sourceSHA256:hash(await Bun.file(import.meta.path).text()),cetSourceSHA256:hash(await Bun.file(new URL('./reference-design-cet.ts',import.meta.url)).text()),calculationSHA256:hash(coreInventoryHydro),inputSHA256:hash(JSON.stringify({basis,cet})),basis,heaterPower_W:power,hydro:JSON.parse(out),heated:heatedComparison(cet,power,[basis.minimumTestPower_W,power,basis.maximumTestPower_W])}
}
if(import.meta.main){
 const [owner,cetOwner,python,receipt,...rest]=Bun.argv.slice(2)
 if(!owner||!cetOwner||!python||!receipt||rest.length)throw Error('Usage: core-inventory <owner.md> <cet-owner.md> <research-python> <receipt.json>')
 const r=await runCoreInventory(owner,cetOwner,python)
 await Bun.write(receipt,JSON.stringify(r,null,2)+'\n')
 console.log(JSON.stringify({receipt,hydro:r.hydro,heaterPower_W:r.heaterPower_W,wetRange_K:r.heated.rows.filter(q=>q.liquidExposure===1).map(q=>q.difference_K),dryMinimum_K:Math.min(...r.heated.rows.filter(q=>q.liquidExposure===0).map(q=>q.difference_K)),drying:r.heated.drying}))
}
