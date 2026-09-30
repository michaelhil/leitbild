/** Finite ambient-material prerequisite, not plant cooldown or a handling runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseFuelConstruction } from './reference-design-fuel-construction'
import { coldFuelMaterialPython, fuelMaterialPython } from './reference-design-fuel-materials'
import { solid304Python } from './reference-design-pressurizer-heater-contact'

const positive=z.number().finite().positive()
const schema=z.object({ minimum_K:z.literal(290), initialSolid_K:z.literal(300),
  receiver_K:z.literal(293.15), assessment_K:z.literal(295), pressure_Pa:z.literal(100000),
  length_m:positive, steel_kg:positive, steelArea_m2:positive, film_W_m2_K:positive,
  water_kg:positive, insufficientWater_kg:positive, duration_s:positive, step_s:positive }).strict()
export function parseAmbientMaterials(document:string){
  const blocks=[...document.matchAll(/^```reference-ambient-materials\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-ambient-materials block')
  const b=schema.parse(JSON.parse(blocks[0]![1]!))
  if(b.insufficientWater_kg>=b.water_kg)throw Error('Contrary recipient must be smaller')
  if(b.step_s>b.duration_s/20)throw Error('Fewer than20 requested reference intervals')
  return b
}
export const ambientMaterialCalculation=String.raw`
import json,sys,math
import numpy as np,scipy,CoolProp
from scipy.integrate import quad,solve_ivp
from scipy.optimize import brentq
from CoolProp.CoolProp import PropsSI as P
${fuelMaterialPython}
${coldFuelMaterialPython}
${solid304Python}
d=json.load(sys.stdin);b=d['basis'];f=d['fuel'];checks=[]
def require(name,ok,**values):
 if not ok:raise ValueError((name,values))
 checks.append(dict(name=name,**values))
lo=b['minimum_K'];eps=1e-4
grid=np.linspace(lo,300,101)
require('positive ambient properties',all(min(kf(t),cpf(t),kc(t),cpc(t),steel(t)['cp'],steel(t)['k'])>0 for t in grid),samples=len(grid))
for t in [lo,296.,298.15,299.9999,300.,350.,500.,1000.]:
 for name,e,cp in [('fuel',hf,cpf),('cladding',hc,cpc),('304',lambda q:steel(q)['e'],lambda q:steel(q)['cp'])]:
  recovered=brentq(lambda q:e(q)-e(t),lo,1600,xtol=1e-10)
  require(name+' native-energy inversion '+str(t),abs(recovered-t)<1e-8)
  if t>lo+eps:require(name+' caloric derivative '+str(t),abs((e(t+eps)-e(t-eps))/(2*eps)-cp(t))<2e-5)
require('cladding continuous300K join',abs(hc(300))==0 and abs(cpc(300-1e-8)-cpc(300+1e-8))<1e-8)
require('negative subdatum energies are retained',hf(lo)-hf(300)<0 and hc(lo)<0 and steel(lo)['e']<0)
require('unchanged admitted hot properties',all(kf(t)==hot_kf(t) and fk(t)==hot_fk(t) for t in [500.,600.,1000.,1600.,2000.]) and all(cpc(t)==table_cpc(t) and hc(t)==table_hc(t) for t in [300.,400.,1090.,1200.,1800.]))
for fn in [kf,fk,cpc,hc,steel]:
 try:fn(lo-.01)
 except ValueError:pass
 else:raise ValueError('Unadmitted freezing-side state accepted')
# Distinct existing recommendations, not measurements validating our extrapolation.
def anl_cp(t):
 th=516.12;z=th/t;k=8.6144e-5;ea=1.9105
 return (78.215*z*z*math.exp(z)/math.expm1(z)**2+2*.0038609*t+3.4250e8*k*math.exp(-ea/(k*t))*(1+ea/(k*t)))/.2703
fuel_cp_difference=max(abs(cpf(t)/anl_cp(t)-1) for t in grid)
require('UO2 independent equation challenge including declared extrapolation',fuel_cp_difference<.03,maxRelativeDifference=fuel_cp_difference)
steel_cp_difference=max(abs(steel(t)['cp']/(6.683+.04906*t+80.74*math.log(t))-1) for t in grid)
steel_k_difference=max(abs(steel(t)['k']/(9.705+.0176*t-1.60e-6*t*t)-1) for t in grid)
require('304 alternative discrepancy retained',steel_cp_difference<.08 and steel_k_difference<.15,maxCpRelativeDifference=steel_cp_difference,maxKRelativeDifference=steel_k_difference)
require('lowclad continuation alternative sensible difference',abs(hc(lo)-281*(lo-300))<11,difference_J_kg=hc(lo)-281*(lo-300))
require('independent fuel caloric integral',abs(quad(cpf,lo,300,epsabs=1e-9)[0]-(hf(300)-hf(lo)))<1e-7)
rf=f['pelletDiameter_m']/2;ro=f['rodOuterDiameter_m']/2;ri=ro-f['cladThickness_m'];L=b['length_m']
mf=math.pi*rf*rf*L*f['fuelDensityFraction']*f['fuelTheoreticalDensity_kg_m3']
mc=math.pi*(ro*ro-ri*ri)*L*f['cladDensity_kg_m3'];ms=b['steel_kg']
vhe=math.pi*(ri*ri-rf*rf)*L+math.pi*ri*ri*f['plenumLength_m']*L/f['activeLength_m']
nr=f['fillPressure_Pa']*vhe/f['referenceTemperature_K'];che=1.5*nr
p=b['pressure_Pa'];accommodation=.425-2.3e-4*b['initialSolid_K']
def water(t,key='H'):return P(key,'P',p,'T',t,'Water')
def resistances(tf,tc,tg,factor):
 khe=BTU*1.314e-3*(1.8*tg)**.668;pg=nr*tg/vhe
 jump=.3048*2.0358e-5*(khe/BTU)*math.sqrt(tg)/((pg/6894.757293168)*accommodation/math.sqrt(4.003))
 rfmean=1/(8*math.pi*L*factor*kf(tf));rgap=(ri-rf+1.845*jump)/(2*math.pi*rf*L*khe);rcinner=math.log(ro/ri)/(4*math.pi*L*kc(tc))
 return rfmean+rgap/2,rgap/2+rcinner
def heat(y,factor):
 tf,tc,ts,tw,tg=y;rfh,rhc=resistances(tf,tc,tg,factor)
 return (tf-tg)/rfh,(tg-tc)/rhc,(tc-tw)/(math.log(ro/ri)/(4*math.pi*L*kc(tc))+1/(2*math.pi*ro*L*b['film_W_m2_K'])),b['steelArea_m2']*b['film_W_m2_K']*(ts-tw)
def energy(y,mw,flat=False):
 tf,tc,ts,tw,tg=y;ec=281*(tc-300) if flat and tc<300 else hc(tc)
 return mf*(hf(tf)-hf(300))+mc*ec+ms*steel(ts)['e']+che*tg+mw*water(tw)
require('equal-temperature zero-transfer limit',heat([lo]*5,1)==(0,0,0,0))
tgsteady=brentq(lambda tg:heat([300.,b['receiver_K'],300.,b['receiver_K'],tg],1)[0]-heat([300.,b['receiver_K'],300.,b['receiver_K'],tg],1)[1],b['receiver_K'],300.)
rfh,rhc=resistances(300.,b['receiver_K'],tgsteady,1);qfg,qgc,_,_=heat([300.,b['receiver_K'],300.,b['receiver_K'],tgsteady],1)
require('finite-He steady series resistance at fixed properties',abs(qfg-qgc)<1e-8 and abs(qfg-(300-b['receiver_K'])/(rfh+rhc))<1e-8,gasTemperature_K=tgsteady,heat_W=qfg,gasRelaxation_s=che/(1/rfh+1/rhc))
# Independent structural rejection of the former eliminated gas storage.
a=che/4;cf=mf*cpf(b['receiver_K']);cc=mc*cpc(b['receiver_K']);qin=-heat([b['receiver_K']]*3+[300.,b['receiver_K']],1)[2]
old_initial_fuel_rate=-a*qin/((cf+a)*(cc+a)-a*a)
require('former shared-storage sign defect explicitly rejected',old_initial_fuel_rate<0,oldInitialFuelDerivative_K_s=old_initial_fuel_rate)
cases=[]
receiver=b['receiver_K']
fixtures=[('adequate',b['water_kg'],[300.,300.,300.,receiver],1.,False),('insufficient',b['insufficientWater_kg'],[300.,300.,300.,receiver],1.,False),('reverse-heating',b['water_kg'],[receiver,receiver,receiver,300.],1.,False),('equal',b['water_kg'],[receiver]*4,1.,False),('conductivity-.9',b['water_kg'],[300.,300.,300.,receiver],.9,False),('conductivity-1.1',b['water_kg'],[300.,300.,300.,receiver],1.1,False),('flat-lowclad',b['water_kg'],[300.,300.,300.,receiver],1.,True)]
for name,mw,y0,factor,flat in fixtures:
 y0=y0+[(y0[0]+y0[1])/2]
 e0=energy(y0,mw,flat);low=min(y0);high=max(y0)
 equilibrium=brentq(lambda t:energy([t]*5,mw,flat)-e0,low,high,xtol=1e-10) if low<high else low
 if name=='adequate':require('adequate recipient predeclared assessment',equilibrium<b['assessment_K'],equilibrium_K=equilibrium)
 if name=='insufficient':require('insufficient recipient fails predeclared assessment',equilibrium>b['assessment_K'],equilibrium_K=equilibrium)
 def rhs(t,y):
  if min(y)<lo-1e-8 or y[0]>2000 or y[1]>1800 or y[2]>1600 or y[3]>=373.15:raise ValueError('Actual finite ambient coupon material/liquid domain exit; no clipped state')
  tf,tc,ts,tw,tg=y;qfg,qgc,qcw,qsw=heat(y,factor)
  cpclad=281 if flat and tc<300 else cpc(tc)
  return np.array([-qfg/(mf*cpf(tf)),(qgc-qcw)/(mc*cpclad),-qsw/(ms*steel(ts)['cp']),(qcw+qsw)/(mw*water(tw,'C')),(qfg-qgc)/che])
 samples=np.unique(np.concatenate(([0.,1e-5,5e-5,1e-4,2e-4,.001,.01,.1,1.],np.linspace(0,b['duration_s'],51))));outputs=[]
 for method,step in [('Radau',b['step_s']),('BDF',b['step_s']/2)]:
  # Default initial Euler probing overshot the tiny contrary recipient; a small
  # fixed first step resolves its ~0.2s thermal response without altering laws.
  out=solve_ivp(rhs,(0,b['duration_s']),y0,method=method,rtol=1e-9,atol=1e-10,t_eval=samples,max_step=step,first_step=min(step,1e-4))
  require(name+' '+method+' finite advance',out.success)
  defect=max(abs(energy(out.y[:,i],mw,flat)-e0) for i in range(len(samples)))
  require(name+' '+method+' sampled native-energy-plus-pressure-work',defect<.0001,maxDefect_J=defect,samples=len(samples))
  departure=max(0.,low-float(np.min(out.y)),float(np.max(out.y))-high)
  require(name+' '+method+' passive finite-node sampled temperature bound',departure<1e-7,maximumDeparture_K=departure)
  outputs.append(out)
 A,Z=outputs;difference=float(np.max(abs(A.y-Z.y)))
 require(name+' temporal crosscheck',difference<2e-5,maxTemperatureDifference_K=difference)
 final=A.y[:,-1];require(name+' independent equilibrium root',max(abs(final-equilibrium))<.002,equilibrium_K=equilibrium)
 if name=='adequate':require('actual fuelcladsteel cross former300K floor',max(final[:3])<b['assessment_K'])
 if name=='insufficient':require('contrary target not achieved',min(final[:3])>b['assessment_K'])
 work=p*mw*(1/water(final[3],'D')-1/water(y0[3],'D'))
 native_change=energy(final,mw,flat)-energy(y0,mw,flat)-work
 require(name+' explicit exterior work',abs(native_change+work)<.0001,nativeEnergyChange_J=native_change,exteriorPressureWork_J=work)
 cases.append(dict(name=name,water_kg=mw,equilibrium_K=equilibrium,final_K=final.tolist(),work_J=work,minimumFuel_K=float(np.min(A.y[0])),maximumFuel_K=float(np.max(A.y[0])),samples=[dict(time_s=float(samples[i]),temperatures_K=A.y[:,i].tolist()) for i in [0,1,3,5,10,len(samples)-1]]))
print(json.dumps(dict(checks=checks,rejectedAlias=dict(initialFuelDerivative_K_s=old_initial_fuel_rate),propertyEndpoints=dict(temperature_K=lo,fuelK_W_m_K=kf(lo),fuelCp_J_kg_K=cpf(lo),fuelSensible_J_kg=hf(lo)-hf(300),cladK_W_m_K=kc(lo),cladCp_J_kg_K=cpc(lo),cladSensible_J_kg=hc(lo),steel=steel(lo)),apparatus=dict(fuel_kg=mf,clad_kg=mc,steel_kg=ms,heliumCapacity_J_K=che),cases=cases,dependencies=dict(scipy=scipy.__version__,coolprop=CoolProp.__version__))))
`

const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
if(import.meta.main){
 const [reactorDirectory,python,output]=process.argv.slice(2)
 if(!reactorDirectory||!python||!output)throw Error('Usage: ambient-materials <reactor-directory> <python> <receipt>')
 const root=reactorDirectory.replace(/\/$/,'')
 const paths=[`${root}/fuel-construction.md`,`${root}/heat-and-history.md`,`${root}/../primary-coolant/heater-equipment.md`,new URL('./reference-design-fuel-materials.ts',import.meta.url).pathname,new URL('./reference-design-pressurizer-heater-contact.ts',import.meta.url).pathname,new URL('./reference-design-fuel-construction.ts',import.meta.url).pathname]
 const originals=await Promise.all(paths.map(path=>Bun.file(path).text()))
 const input={basis:parseAmbientMaterials(originals[1]!),fuel:parseFuelConstruction(originals[0]!)}
 const encoded=JSON.stringify(input)
 const child=Bun.spawn([python,'-c',ambientMaterialCalculation],{stdin:new TextEncoder().encode(encoded),stdout:'pipe',stderr:'pipe'})
 const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
 if(exit!==0)throw Error(`Ambient-material calculation failed: ${stderr}`)
 for(let i=0;i<paths.length;i++)if(await Bun.file(paths[i]!).text()!==originals[i])throw Error('Consumed input changed during calculation')
 const result=JSON.parse(stdout)
 const receipt={calculationSha256:sha(ambientMaterialCalculation),inputSha256:sha(encoded),consumed:paths.map((path,i)=>({path,sha256:sha(originals[i]!)})),input,result}
 await Bun.write(output,JSON.stringify(receipt,null,2)+'\n')
 console.log(JSON.stringify({checks:result.checks.length,receipt:output,calculationSha256:receipt.calculationSha256,inputSha256:receipt.inputSha256}))
}
