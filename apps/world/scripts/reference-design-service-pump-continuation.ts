/** Bounded engineering arithmetic for selected FW/CHARGE/RHR forward pump continuation. No live plant. */
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {degradation} from './reference-design-cooling-water-continuation'

export type ServicePumpBasis={id:string;flow_kg_s:number;inletPressure_MPa:number;inletTemperature_C:number;outletPressure_MPa:number;receiverPressure_MPa:number;hydraulicEfficiency:number;npshSpeed_m:number;npshFlow_m:number;existingTrainHoldup_m3:number}
export const servicePumpHead=(referenceRise_Pa:number,densityRatio:number,speed:number,flowRatio:number,factor:number)=>{
  if(![referenceRise_Pa,densityRatio,speed,flowRatio,factor].every(Number.isFinite)||referenceRise_Pa<=0||densityRatio<0||speed<0||speed>1||flowRatio<0||factor<0||factor>1)throw new Error('Outside forward service-pump branch')
  return densityRatio*referenceRise_Pa*(1.25*factor*speed**2-.25*flowRatio**2)
}
export const servicePumpBudget=(input:{flow_kg_s:number;isentropicWork_J_kg:number;speed:number;referenceFluidPower_W:number;efficiency:number;densityRatio:number;liquidFraction:number;metalTemperature_K:number;caseTemperature_K:number;contact_W_K?:number})=>{
  const {flow_kg_s:m,isentropicWork_J_kg:dh,speed:n,referenceFluidPower_W:p0,efficiency:eta,densityRatio:r,liquidFraction:f,metalTemperature_K:tm,caseTemperature_K:tc}=input
  const contact=input.contact_W_K??2000
  if(![m,dh,n,p0,eta,r,f,tm,tc,contact].every(Number.isFinite)||m<0||n<0||n>1||p0<=0||eta<=0||eta>1||r<0||f<0||f>1||tm<=0||tc<=0||contact<0)throw new Error('Invalid pump energy input')
  // dh is from the admitted native water or mixture isentrope; never Q*dp substituted at high pressure.
  if(n===0&&m>0&&dh>0)throw new Error('Stopped pump cannot supply positive-head work')
  const useful=m*Math.max(dh,0),baseLoss=useful*(1/eta-1),churn=.01*p0*n**3*r
  const extra=Math.max(baseLoss,churn)-baseLoss,metalToCase=f*contact*(tm-tc)
  const facePower=useful+baseLoss,caseHeat=f*extra+metalToCase,metalHeat=(1-f)*extra-metalToCase
  const shaftPower=facePower+extra
  return {useful,baseLoss,churn,extra,facePower,caseHeat,metalHeat,metalToCase,shaftPower,dischargeEnthalpyRise_J_kg:m>0&&dh>0?dh/eta:0}
}
export const parseServicePump=(text:string):ServicePumpBasis=>{
  const matches=[...text.matchAll(/```reference-service-pump\s*\n([\s\S]*?)\n```/g)]
  if(matches.length!==1)throw new Error('Expected one service pump reference')
  const b=JSON.parse(matches[0]![1]!) as ServicePumpBasis
  if(typeof b.id!=='string'||![b.flow_kg_s,b.inletPressure_MPa,b.inletTemperature_C,b.outletPressure_MPa,b.receiverPressure_MPa,b.hydraulicEfficiency,b.npshSpeed_m,b.npshFlow_m,b.existingTrainHoldup_m3].every(Number.isFinite)||b.flow_kg_s<=0||b.inletPressure_MPa<=0||b.receiverPressure_MPa<=0||b.outletPressure_MPa<=b.inletPressure_MPa||b.hydraulicEfficiency<=0||b.hydraulicEfficiency>1||b.npshSpeed_m<0||b.npshFlow_m<0||b.existingTrainHoldup_m3<0)throw new Error('Invalid service pump reference')
  return b
}
export const readServicePump=(path:string)=>parseServicePump(readFileSync(path,'utf8'))
const propertyScript=String.raw`
import json,sys
import CoolProp
import scipy
from CoolProp.CoolProp import PropsSI
from scipy.integrate import quad
rows=[]
for b in json.load(sys.stdin):
 p=b['inletPressure_MPa']*1e6; po=b['outletPressure_MPa']*1e6; t=b['inletTemperature_C']+273.15
 rho=PropsSI('D','P',p,'T',t,'Water'); h=PropsSI('H','P',p,'T',t,'Water'); s=PropsSI('S','P',p,'T',t,'Water')
 dh=PropsSI('H','P',po,'S',s,'Water')-h
 integral=quad(lambda pressure:1/PropsSI('D','P',pressure,'S',s,'Water'),p,po,epsabs=1e-6,epsrel=1e-10)[0]
 rows.append({'id':b['id'],'density_kg_m3':rho,'isentropicWork_J_kg':dh,'integratedIsentropicWork_J_kg':integral,'pressureVolumeWork_J_kg':(po-p)/rho})
print(json.dumps({'propertyLibrary':'CoolProp '+CoolProp.__version__,'quadratureLibrary':'SciPy '+scipy.__version__,'rows':rows}))
`
if(import.meta.main){
  const [python,feedOwner,chargeOwner,rhrOwner,receipt,...extra]=process.argv.slice(2)
  if(!python||!feedOwner||!chargeOwner||!rhrOwner||extra.length)throw new Error('Usage: bun reference-design-service-pump-continuation.ts <python-with-CoolProp-and-SciPy> <feed-owner> <charge-owner> <rhr-owner> [receipt.json]')
  const paths=[feedOwner,chargeOwner,rhrOwner]
  const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
  const sources=[...paths,import.meta.path,resolve(import.meta.dir,'reference-design-cooling-water-continuation.ts')].map(path=>({path,sha256:hash(path)}))
  const bases=paths.map(readServicePump)
  if(bases.map(b=>b.id).join(',')!=='FW,CHARGE,RHR')throw new Error('Expected FW, CHARGE and RHR reference identities in owner order')
  const native=spawnSync(python,['-c',propertyScript],{input:JSON.stringify(bases),encoding:'utf8'})
  if(native.status!==0)throw new Error(native.stderr||'Native property calculation failed')
  const properties=JSON.parse(native.stdout) as {propertyLibrary:string;quadratureLibrary:string;rows:{id:string;density_kg_m3:number;isentropicWork_J_kg:number;integratedIsentropicWork_J_kg:number;pressureVolumeWork_J_kg:number}[]}
  const checks:string[]=[]
  const check=(name:string,ok:boolean)=>{if(!ok)throw new Error(name);checks.push(name)}
  const cases=bases.map((basis,i)=>{
    const p=properties.rows[i]!
    if(!p||p.id!==basis.id)throw new Error('Native property reference identity mismatch')
    check(basis.id+' independent integral of isentropic specific volume',Math.abs(p.isentropicWork_J_kg-p.integratedIsentropicWork_J_kg)<1e-5)
    const referenceFluidPower_W=basis.flow_kg_s*p.isentropicWork_J_kg/basis.hydraulicEfficiency
    const input={flow_kg_s:basis.flow_kg_s,isentropicWork_J_kg:p.isentropicWork_J_kg,speed:1,referenceFluidPower_W,efficiency:basis.hydraulicEfficiency,densityRatio:1,liquidFraction:1,metalTemperature_K:basis.inletTemperature_C+273.15,caseTemperature_K:basis.inletTemperature_C+273.15}
    const normal=servicePumpBudget(input),deadhead=servicePumpBudget({...input,flow_kg_s:0}),dry=servicePumpBudget({...input,flow_kg_s:0,densityRatio:.01,liquidFraction:0}),passive=servicePumpBudget({...input,isentropicWork_J_kg:-10,speed:0})
    const casingVolume_m3=.05*basis.flow_kg_s/p.density_kg_m3
    const gasHeadFactor=degradation(10,1,.08),availableRise_Pa=servicePumpHead((basis.outletPressure_MPa-basis.inletPressure_MPa)*1e6,1,1,0,gasHeadFactor),requiredStaticRise_Pa=(basis.receiverPressure_MPa-basis.inletPressure_MPa)*1e6
    const frozenReceiverScreen={scope:'Reference-density upper head, adequate suction,8% retained gas,zero flow,no losses; not a gas compression trajectory',gasHeadFactor,availableRise_Pa,requiredStaticRise_Pa,headCanReachReceiver:availableRise_Pa>requiredStaticRise_Pa}
    check(basis.id+' adverse gas upper-head receiver screen',frozenReceiverScreen.headCanReachReceiver===(basis.id==='RHR'))
    check(basis.id+' exact nominal native work',Math.abs(normal.shaftPower-referenceFluidPower_W)<1e-7&&normal.extra===0)
    for(const [name,row] of Object.entries({normal,deadhead,dry,passive}))check(basis.id+' '+name+' single energy incidence',Math.abs(row.shaftPower-row.facePower-row.caseHeat-row.metalHeat)<1e-8)
    check(basis.id+' deadhead retains water heat',deadhead.facePower===0&&deadhead.caseHeat>0)
    check(basis.id+' dry extra heats metal',dry.caseHeat===0&&dry.metalHeat>0)
    check(basis.id+' stopped passive has no shaft work',passive.shaftPower===0)
    check(basis.id+' casing ownership',casingVolume_m3>0&&(basis.existingTrainHoldup_m3===0||casingVolume_m3<basis.existingTrainHoldup_m3))
    const curve=[0,.25,.5,1,2].flatMap(npshRatio=>[0,.02,.08,.15,1].map(gasFraction=>{
      const required=basis.npshSpeed_m+basis.npshFlow_m
      const factor=degradation(required*npshRatio,required,gasFraction)
      return {npshRatio,gasFraction,factor,head_Pa:servicePumpHead((basis.outletPressure_MPa-basis.inletPressure_MPa)*1e6,1,1,1,factor)}
    }))
    const contact=[1000,2000,4000].map(contact_W_K=>{
      const hot=servicePumpBudget({...input,flow_kg_s:0,speed:0,metalTemperature_K:input.caseTemperature_K+40,contact_W_K})
      check(basis.id+' hot-metal return reciprocal',hot.caseHeat>0&&hot.caseHeat===-hot.metalHeat&&hot.shaftPower===0)
      return {contact_W_K,caseTemperature_K:input.caseTemperature_K,metalTemperature_K:input.caseTemperature_K+40,metalToCase_W:hot.metalToCase}
    })
    return {basis,...p,referenceFluidPower_W,pressureVolumeRelativeError:p.pressureVolumeWork_J_kg/p.isentropicWork_J_kg-1,casingVolume_m3,remainingTrainHoldup_m3:basis.existingTrainHoldup_m3?basis.existingTrainHoldup_m3-casingVolume_m3:null,normal,deadhead,dry,passive,curve,contact,frozenReceiverScreen,referenceShutoffPressure_MPa:basis.inletPressure_MPa+1.25*(basis.outletPressure_MPa-basis.inletPressure_MPa)}
  })
  check('charging shutoff exceeds core comparison band, not water EOS limit',cases.find(c=>c.basis.id==='CHARGE')!.referenceShutoffPressure_MPa>16)
  if(sources.some(source=>hash(source.path)!==source.sha256))throw new Error('Reference source changed during calculation')
  const output={scope:'Native pure-water reference endpoints and frozen constitutive states only; no pressure/phase/venting trajectory or high-pressure noncondensable qualification',sources,propertyLibrary:properties.propertyLibrary,quadratureLibrary:properties.quadratureLibrary,checks,cases}
  if(receipt)await Bun.write(receipt,JSON.stringify(output,null,2)+'\n')
  console.log(JSON.stringify(receipt?{receipt,checks:checks.length,cases:cases.map(c=>({id:c.basis.id,referenceFluidPower_W:c.referenceFluidPower_W,casingVolume_m3:c.casingVolume_m3,deadheadHeat_W:c.deadhead.caseHeat,referenceShutoffPressure_MPa:c.referenceShutoffPressure_MPa}))}:output,null,2))
}
