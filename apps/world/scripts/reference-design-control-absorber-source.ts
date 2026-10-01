/** Cold native displaced-water/effective-source join. No reached movement. */
import {createHash} from 'node:crypto'
import {parseControlAbsorber,controlAbsorberGeometry,absorberForceScreen,gapReleaseLimit} from './reference-design-control-absorber'
import {parseFuelConstruction} from './reference-design-fuel-construction'
import {parseFuelHandling} from './reference-design-fuel-handling'
import {coldNuclearOwnerRecords} from './reference-design-cold-nuclear'
import {parseGuideSourceInput,guideSourceCalculation} from './reference-design-guide-source'
import {coldHydrostaticInventoryPython} from './reference-design-cold-parent'

const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
export const bodyWaterCalculation=String.raw`
import json,sys,math
import numpy as np
from scipy.integrate import solve_ivp,quad
from scipy.optimize import brentq
from CoolProp.CoolProp import PropsSI as P
d=json.load(sys.stdin);g=9.80665;checks=[];p0=d['anchor']['pressure_Pa'];T0=d['anchor']['temperature_K'];z0=d['anchor']['elevation_m'];a=d['body'];r=d['reference'];b=d['basis'];m=d['pm'];parent=d['parent'];ratio=parent['activeGuideMobileTracer_kgEq']/parent['activeGuideWater_kg']
def require(name,ok,**v):
 if not ok:raise ValueError((name,v))
 checks.append(dict(name=name,**v))
${coldHydrostaticInventoryPython}
area=d['rodlets']*math.pi*a['bodyDiameter_m']**2/4
def removed(y):
 lo=max(-2.,a['insertedBodyBottom_m']+y);hi=min(2.,a['insertedBodyBottom_m']+a['bodyLength_m']+y)
 return 0. if hi<=lo else area*quad(lambda z:water(*mainField(z))[0],lo,hi,epsabs=1e-8,epsrel=1e-11)[0]
M0=parent['activeExternalWater_kg']+parent['activeGuideWater_kg'];B0=parent['activeExternalMobileTracer_kgEq']+parent['activeGuideMobileTracer_kgEq'];Mref=r['waterMass_kg'];Dref=r['Dref_sqrtK']
def rho(y,T=300.,k=None,A=None,W=None,X=0.,Sm=0.,dilute=False):
 k=b['waterWorth'] if k is None else k;A=b['dopplerWorth_pcm_sqrtK'] if A is None else A;W=m['samariumWorth'] if W is None else W
 water=(M0-removed(y))/Mref;tracer=0. if dilute else 1e6*(B0-removed(y)*ratio+parent['activeRetainedTracer_kgEq'])/Mref
 bank=1.-max(0.,min(2.,a['insertedActiveBottom_m']+a['activeLength_m']+y)-max(-2.,a['insertedActiveBottom_m']+y))/a['activeLength_m']
 return k*(water-1)+b['absorberWorth_pcm_ppmEq']*1e-5*(tracer-b['absorberReference_ppmEq'])+A*1e-5*(math.sqrt(T)-Dref)+b['bankWorth']*(bank-b['bankReference'])+b['xenonWorth']*(X-1)+W*(Sm-1)
require('exact native inserted removal matches shared axial-profile partition',abs(removed(0)-parent['activeGuideWater_kg']*area*4/d['oldBoreVolume_m3'])<1e-7)
require('small NI approach retains full body displacement physically',abs(removed(.08)-removed(0))<1e-7)
families=[]
for k in b['waterWorthChallenges']:
 for A in b['dopplerSensitivity_pcm_sqrtK']:
  for W in m['samariumWorthChallenges']:
   inserted=rho(0,T=290,k=k,A=A,W=W)
   dry=-k+b['absorberWorth_pcm_ppmEq']*1e-5*(-b['absorberReference_ppmEq'])+A*1e-5*(math.sqrt(290)-Dref)+b['bankWorth']*(1-b['bankReference'])-b['xenonWorth']-W
   families.append(dict(waterWorth=k,doppler=A,samarium=W,inserted290_pcm=inserted*1e5,dry290_pcm=dry*1e5,admitted=bool(inserted<0 and dry<0)))
require('all nominal family insertion and dry corners remain admitted',all(q['admitted'] for q in families if q['waterWorth']==b['waterWorth']))
require('dry.12 and inserted.20 failures remain rather than coefficient retune',all(not q['admitted'] for q in families if q['waterWorth'] in [.12,.20]))
require('inserted physical body does not guarantee zero-tracer shutdown',rho(0,T=290,dilute=True)>0,reactivity_pcm=rho(0,T=290,dilute=True)*1e5)
critical=brentq(lambda y:rho(y),0.,a['normalTravel_m'],xtol=1e-12)
require('actual conditional critical pose consumes changed water and bank',0<critical<a['normalTravel_m'])
constantWaterEstimate=-rho(0)/b['bankWorth']
require('critical pose is not constant-water linear estimate',abs(critical/a['normalTravel_m']-constantWaterEstimate)>1e-6,actualFraction=critical/a['normalTravel_m'],constantWaterEstimate=constantWaterEstimate)
poses=[dict(travel_m=y,removedWater_kg=removed(y),remainingCoreWater_kg=M0-removed(y),removedTracer_kg_eq=removed(y)*ratio,fresh300Reactivity_pcm=rho(y)*1e5) for y in [0.,.08,.25,critical,a['normalTravel_m'],a['parkTravel_m']]]
for p in poses:require('positive actual remaining water at'+str(p['travel_m']),p['remainingCoreWater_kg']>0)
revised={**parent,'activeGuideWater_kg':parent['activeGuideWater_kg']-removed(0),'activeGuideMobileTracer_kgEq':parent['activeGuideMobileTracer_kgEq']-removed(0)*ratio}
forceStates=[dict(temperature_K=t,pressure_Pa=p,density_kg_m3=P('D','T',t,'P',p,'Water'),viscosity_Pa_s=P('V','T',t,'P',p,'Water')) for t,p in d['forcePropertyFixtures']]
print(json.dumps(dict(checks=checks,revisedFreshSourceInput=revised,removedInsertedWater_kg=removed(0),removedInsertedTracer_kg_eq=removed(0)*ratio,nominalInserted300_pcm=rho(0)*1e5,conditionalCriticalTravel_m=critical,conditionalCriticalFraction=critical/a['normalTravel_m'],families=families,poses=poses,forcePropertyStates=forceStates,scope='Original fresh native300K complete-core body preparation and conditional held hydraulic field, not achieved fluid displacement, hot-parent equilibrium, drop or startup')))
`

if(import.meta.main){
 const [directory,parentPath,referencePath,python,output,...extra]=Bun.argv.slice(2)
 if(!directory||!parentPath||!referencePath||!python||!output||extra.length)throw Error('Usage: control-absorber-source <reactor> <guide-parent.json> <accepted-reference.json> <research-python> <receipt.json>')
 const names=['control-absorber-and-guide-water.md','fuel-construction.md','fuel-handling-and-pool.md','cold-source-and-startup.md','kinetics.md','heat-and-history.md','shutdown-and-fuel-response.md','control-and-verification.md'],docs=await Promise.all(names.map(n=>Bun.file(`${directory}/${n}`).text())),owners=Object.fromEntries(names.map((n,i)=>[n,docs[i]!]))
 const control=parseControlAbsorber(owners[names[0]!]!),fuel=parseFuelConstruction(owners[names[1]!]!),handling=parseFuelHandling(owners[names[2]!]!),geometry=controlAbsorberGeometry(control,fuel,handling)
 const parentText=await Bun.file(parentPath).text(),parent=JSON.parse(parentText),referenceText=await Bun.file(referencePath).text(),reference=JSON.parse(referenceText).reference,basis=coldNuclearOwnerRecords(owners)
 const nativeInput={body:control,rodlets:geometry.rodlets,anchor:parent.consumedInput.anchor,parent:parseGuideSourceInput(parent.sourceInput),oldBoreVolume_m3:parent.consumedInput.geometry.active.boreVolume_m3,reference,basis:basis.basis,pm:basis.pm,forcePropertyFixtures:[[300,300000],[578.045902,15000000]]}
 if(nativeInput.parent.capsule.identity!==basis.basis.source.identity||nativeInput.parent.capsule.age_year!==basis.basis.source.ageAtPreparation_year)throw Error('Source identity/age mismatch')
 if(basis.bank.worthPerStroke!==basis.basis.bankWorth||basis.bank.referencePosition!==basis.basis.bankReference)throw Error('Equivalent bank reference mismatch')
 const execute=async(code:string,input:unknown)=>{
  const proc=Bun.spawn([python,'-c',code],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,exit]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);if(exit)throw Error(err);return JSON.parse(out)
 }
 const native=await execute(bodyWaterCalculation,nativeInput),sourceInput={...basis,reference,guide:parseGuideSourceInput(native.revisedFreshSourceInput)},source=await execute(guideSourceCalculation,sourceInput)
 const forces:Array<ReturnType<typeof absorberForceScreen>&{temperature_K:number,pressure_Pa:number}>=native.forcePropertyStates.map((q:{temperature_K:number,pressure_Pa:number,density_kg_m3:number,viscosity_Pa_s:number})=>({...q,...absorberForceScreen(control,handling,geometry,q.density_kg_m3,q.viscosity_Pa_s)}))
 if(!forces.every(q=>q.cases.every(r=>r.ordinaryRequiredElectrical_W<control.deliveredMotiveLimit_W&&r.ordinaryRequiredForce_N<control.clusters*control.forceLimitPerCluster_N)))throw Error('Selected ordinary force/duty lacks feasibility in declared fixtures')
 if(!forces.every(q=>q.cases.some(r=>r.boundary==='constrained-piston-current'&&r.terminalBelow2m_s!==null)))throw Error('Required contrary failed to discriminate fixed2m/s assumption')
 const result={scope:'Fresh original physical-body/source preparation and held-boundary source feasibility. The source checker constant-water critical estimate is only a diagnostic; use native conditionalCriticalFraction for the geometric field. Prescribed small NI/body movement is not installed drive/drop qualification.',sourceSHA256:sha(await Bun.file(import.meta.path).text()),calculationSHA256:sha(bodyWaterCalculation),sourceCalculationSHA256:sha(guideSourceCalculation),inputSHA256:sha(JSON.stringify({nativeInput,sourceInput})),nativeInput,sourceInput,guideParentReceiptSHA256:sha(parentText),acceptedReferenceReceiptSHA256:sha(referenceText),geometryCalculationSHA256:sha(await Bun.file(new URL('./reference-design-control-absorber.ts',import.meta.url)).text()),ownerContext:Object.fromEntries(names.map((n,i)=>[n,sha(docs[i]!)])),native,source,forces,gapRelease:gapReleaseLimit(control)}
 await Bun.write(output,JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify({receipt:output,nativeChecks:native.checks.length,sourceChecks:source.checks.length,removedWater_kg:native.removedInsertedWater_kg,nominalInserted300_pcm:native.nominalInserted300_pcm,conditionalCriticalFraction:native.conditionalCriticalFraction,NI:source.conditionalWorstNI},null,2))
}
