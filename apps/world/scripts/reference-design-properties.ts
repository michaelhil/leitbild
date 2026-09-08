/** Offline candidate evaluation. No production dependency or property fallback. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

type State = { rho: number; u: number; h: number; cp: number; alpha: number; kappa: number; mu: number; k: number }
type Candidate = { name: string; formulation?: 'IAPWS95'; pt: (p: number, t: number) => State; ph: (p: number, h: number) => { t: number; rho: number }; isLiquid?: (p:number,t:number)=>boolean }
type Reference = { p: number; t: number; region: number; state: State; state95: State }
const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')

// SI state: Pa, K, kg/m3, J/kg, J/(kg K), Pa s. kappa is 1/Pa.
export function liquidStorageJacobian(p: number, t: number, s: State) {
  if (![p,t,...Object.values(s)].every(Number.isFinite) || p<=0 || t<=0 || s.rho<=0 || s.cp<=0 || s.kappa<=0)
    throw Error('Invalid liquid thermodynamic state')
  return { rhoP:s.rho*s.kappa, rhoT:-s.rho*s.alpha,
    uP:(p*s.kappa-t*s.alpha)/s.rho, uT:s.cp-p*s.alpha/s.rho }
}

/** Bounded experiment, not a general phase flash: solve a single-liquid state near a known branch. */
export function invertLiquid(pt: Candidate['pt'], rho: number, u: number, initialP: number, initialT: number) {
  if (![rho,u,initialP,initialT].every(Number.isFinite) || rho<=0 || initialP<=0 || initialT<=0)
    throw Error('Invalid inversion inputs')
  let p=initialP,t=initialT
  const norm=(s:State)=>Math.hypot((s.rho-rho)/rho,(s.u-u)/Math.max(Math.abs(u),1e5))
  for(let iteration=0;iteration<30;iteration++) {
    const s=pt(p,t), error=norm(s)
    if(error<1e-11)return {p,t,iteration,error}
    const j=liquidStorageJacobian(p,t,s), determinant=j.rhoP*j.uT-j.rhoT*j.uP
    if(!Number.isFinite(determinant)||determinant===0)throw Error('Singular liquid storage Jacobian')
    const a=s.rho-rho,b=s.u-u
    const dp=(a*j.uT-b*j.rhoT)/determinant,dt=(j.rhoP*b-j.uP*a)/determinant
    let accepted=false
    for(let scale=1;scale>=1/1024;scale/=2) {
      const nextP=p-scale*dp,nextT=t-scale*dt
      if(nextP<=0||nextT<=0)continue
      try { if(norm(pt(nextP,nextT))<error){p=nextP;t=nextT;accepted=true;break} }
      catch { /* Rejected trial: caller's phase/domain check must not be bypassed. */ }
    }
    if(!accepted)throw Error('Liquid inversion could not find an admissible decreasing step')
  }
  throw Error('Liquid inversion did not converge')
}

const referenceCalculation=String.raw`
import json,platform,iapws
from iapws import IAPWS97 as W, IAPWS95 as W95
def state(w):
 return dict(rho=w.rho,u=w.u*1000,h=w.h*1000,cp=w.cp*1000,alpha=w.alfav,kappa=(w.xkappa if isinstance(w,W) else w.kappa)/1e6,mu=w.mu,k=w.k)
points=[]
for p in [.006,.1,1.,6.8,15.5,20.,22.,25.,50.,100.]:
 for t in [300.,450.,550.,600.,623.14,623.16,650.,700.,900.,1073.15,1100.,1500.,2000.]:
  if t>1073.15 and p>50:continue
  w=W(P=p,T=t)
  points.append(dict(p=p*1e6,t=t,region=w.region,state=state(w),state95=state(W95(P=p,T=t))))
for p,t in [(22.065,647.10),(22.1,647.2),(22.5,650.),(16.53,623.2)]:
 w=W(P=p,T=t);points.append(dict(p=p*1e6,t=t,region=w.region,state=state(w),state95=state(W95(P=p,T=t))))
sat=[]
for p in [.006,.101325,1.,6.8,15.5,20.,22.]:
 for x in [0.,.5,1.]:
  w=W(P=p,x=x);z=W95(P=p,x=x);sat.append(dict(p=p*1e6,x=x,t=w.T,h=w.h*1000,u=w.u*1000,rho=w.rho,
   state95=dict(t=z.T,h=z.h*1000,u=z.u*1000,rho=z.rho)))
print(json.dumps(dict(points=points,saturation=sat,python=platform.python_version(),iapws=iapws.__version__),allow_nan=False))
`

export async function evaluatePropertyCandidates(directory: string, python: string) {
  const child=Bun.spawn([python,'-c',referenceCalculation],{stdout:'pipe',stderr:'pipe'})
  const [text,error,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(status!==0)throw Error(error)
  const reference=JSON.parse(text) as {points:Reference[];saturation:{p:number;x:number;t:number;h:number;u:number;rho:number;state95:{t:number;h:number;u:number;rho:number}}[];python:string;iapws:string}
  const start=performance.now()
  const seuRoot=join(directory,'node_modules/seuif97')
  const seu=await import(pathToFileURL(join(seuRoot,'pkg/seuif97.js')).href)
  const wasm=await Bun.file(join(seuRoot,'pkg/seuif97_bg.wasm')).bytes()
  await seu.default({module_or_path:wasm})
  const coldLoadMs=performance.now()-start
  const neutRoot=join(directory,'node_modules/@neutrium/thermo.eos.iapws97')
  const neut=await import(pathToFileURL(join(neutRoot,'dist/index.js')).href)
  const eos=new neut.IAPWS97_EoS()
  const coolStart=performance.now()
  const cool=await (await import(pathToFileURL(join(directory,'coolprop.js')).href)).default()
  const coolColdLoadMs=performance.now()-coolStart
  const liquidPhase=(phase:number)=>phase===cool.phases.iphase_liquid.value||phase===cool.phases.iphase_supercritical_liquid.value
  const coolCandidate=(fluid:string):Candidate=>({name:'CoolProp '+fluid,...(fluid.startsWith('HEOS')?{formulation:'IAPWS95' as const}:{}),
    pt:(p,t)=>{const get=(key:string)=>cool.PropsSI(key,'P',p,'T',t,fluid);return{rho:get('D'),u:get('U'),h:get('H'),cp:get('C'),
      alpha:get('isobaric_expansion_coefficient'),kappa:get('isothermal_compressibility'),mu:get('V'),k:get('L')}},
    ph:(p,h)=>({t:cool.PropsSI('T','P',p,'H',h,fluid),rho:cool.PropsSI('D','P',p,'H',h,fluid)}),
    isLiquid:(p,t)=>liquidPhase(cool.PropsSI('Phase','P',p,'T',t,fluid))})
  const reusable=cool.factory('HEOS','Water')
  const reusableCandidate:Candidate={name:'CoolProp HEOS reusable state',formulation:'IAPWS95',
    pt:(p,t)=>{reusable.update(cool.input_pairs.PT_INPUTS,p,t);return{rho:reusable.rhomass(),u:reusable.umass(),h:reusable.hmass(),cp:reusable.cpmass(),
      alpha:reusable.isobaric_expansion_coefficient(),kappa:reusable.isothermal_compressibility(),mu:reusable.viscosity(),k:reusable.conductivity()}},
    ph:(p,h)=>{reusable.update(cool.input_pairs.HmassP_INPUTS,h,p);return{t:reusable.T(),rho:reusable.rhomass()}},
    isLiquid:(p,t)=>{reusable.update(cool.input_pairs.PT_INPUTS,p,t);return liquidPhase(reusable.keyed_output(cool.parameters.iPhase))}}
  const candidates:Candidate[]=[
    {name:'seuif97',pt:(p,t)=>({rho:seu.pt(p/1e6,t-273.15,2),u:seu.pt(p/1e6,t-273.15,7)*1000,
      h:seu.pt(p/1e6,t-273.15,4)*1000,cp:seu.pt(p/1e6,t-273.15,8)*1000,
      alpha:seu.pt(p/1e6,t-273.15,17),kappa:seu.pt(p/1e6,t-273.15,18)/1e6,
      mu:seu.pt(p/1e6,t-273.15,24),k:seu.pt(p/1e6,t-273.15,26)}),
      ph:(p,h)=>({t:seu.ph(p/1e6,h/1000,1)+273.15,rho:seu.ph(p/1e6,h/1000,2)}),isLiquid:(p,t)=>seu.pt(p/1e6,t-273.15,16)===1},
    {name:'neutrium',pt:(p,t)=>{const s=eos.solve({p,t});return{rho:s.rho,u:s.u*1000,h:s.h*1000,cp:s.cp*1000,
      alpha:NaN,kappa:NaN,mu:s.mu/1000,k:s.k}},
      ph:(p,h)=>{const s=eos.solve({p,h:h/1000});return{t:s.t,rho:s.rho}}},
    coolCandidate('IF97::Water'),coolCandidate('HEOS::Water'),reusableCandidate,
  ]
  const results=candidates.map(candidate=>{
    const regions:Record<string,Record<string,{relative:number;p:number;t:number}>>={}
    const failures:{p:number;t:number;operation:string;error:string}[]=[]
    const roundtrip:{p:number;t:number;deltaT:number;relativeRho:number}[]=[]
    const derivatives:{p:number;t:number;errors:Record<string,number>}[]=[]
    const inversions:unknown[]=[]
    const update=(region:string,key:string,value:number,p:number,t:number)=>{
      const row=regions[region]??={}
      if(!row[key]||value>row[key].relative)row[key]={relative:value,p,t}
    }
    for(const point of reference.points) {
      const {p,t,region}=point
      const s=candidate.formulation==='IAPWS95'?point.state95:point.state
      try {
        const actual=candidate.pt(p,t)
        for(const key of ['rho','u','h','cp','mu','k'] as const) {
          if(!Number.isFinite(actual[key])||actual[key]<=0)throw Error('Invalid/sentinel '+key+': '+actual[key])
          update(String(region),key,Math.abs(actual[key]/s[key]-1),p,t)
        }
        update(String(region),'firstLaw',Math.abs(actual.h-actual.u-p/actual.rho)/Math.max(Math.abs(actual.h),1),p,t)
        if(candidate.isLiquid && Number.isFinite(actual.kappa) && region===1 && t<600 && p>=1e6 && p<100e6) {
          const j=liquidStorageJacobian(p,t,actual),dp=p*1e-5,dt=.001
          const sp=candidate.pt(p+dp,t),sm=candidate.pt(p-dp,t),tp=candidate.pt(p,t+dt),tm=candidate.pt(p,t-dt)
          const fd={rhoP:(sp.rho-sm.rho)/(2*dp),rhoT:(tp.rho-tm.rho)/(2*dt),uP:(sp.u-sm.u)/(2*dp),uT:(tp.u-tm.u)/(2*dt)}
          const errors=Object.fromEntries(Object.keys(j).map(k=>[k,Math.abs(j[k as keyof typeof j]/fd[k as keyof typeof fd]-1)]))
          derivatives.push({p,t,errors})
          const liquidPT=(pp:number,tt:number)=>{if(pp<1e6||pp>=100e6||tt<273.15||tt>=600||!candidate.isLiquid!(pp,tt))throw Error('Outside evaluated liquid branch');return candidate.pt(pp,tt)}
          inversions.push({targetP:p,targetT:t,...invertLiquid(liquidPT,s.rho,s.u,p*1.01,t+.2)})
        }
      } catch(e){failures.push({p,t,operation:'PT/derivative/inversion',error:String(e)})}
      try {const back=candidate.ph(p,s.h);if(!Number.isFinite(back.t)||!Number.isFinite(back.rho)||back.t<273||back.rho<=0)throw Error('Invalid inverse result');roundtrip.push({p,t,deltaT:back.t-t,relativeRho:back.rho/s.rho-1})}
      catch(e){failures.push({p,t,operation:'PH',error:String(e)})}
    }
    const sample=reference.points.filter(x=>x.region===1||x.region===2)
    let checksum=0
    for(let i=0;i<1000;i++){const q=sample[i%sample.length]!;checksum+=candidate.pt(q.p,q.t).h}
    const timings=[]
    for(let repeat=0;repeat<5;repeat++) {
      const begin=performance.now()
      for(let i=0;i<1000;i++){const q=sample[i%sample.length]!;checksum+=candidate.pt(q.p,q.t).h}
      timings.push((performance.now()-begin)/1000*1000)
    }
    return {name:candidate.name,referenceFormulation:candidate.formulation??'IF97',regions,failures,roundtrip,derivatives,inversions,completeStateMicros:timings,checksum}
  })
  const saturation=reference.saturation.map(q=>{
    const rho=seu.px(q.p/1e6,q.x,2),v=seu.px(q.p/1e6,q.x,3),h=seu.px(q.p/1e6,q.x,4)*1000,u=seu.px(q.p/1e6,q.x,7)*1000
    return {...q,relativeRho:rho/q.rho-1,relativeH:h/q.h-1,relativeU:u/q.u-1,deltaT:seu.px(q.p/1e6,q.x,1)+273.15-q.t,
      relativeRhoFromSpecificVolume:1/(v*q.rho)-1,volumeFirstLawRelative:Math.abs(h-u-q.p*v)/Math.max(Math.abs(h),1),
      firstLawRelative:Math.abs(h-u-q.p/rho)/Math.max(Math.abs(h),1)}
  })
  // Direct-package failure behavior is evidence; it is not accepted as a production error protocol.
  const invalid=[[-1,300],[1,NaN],[200,300],[1,3000]].map(([p,t])=>({p,t:String(t),returned:seu.pt(p,t,4)}))
  const conservativeFlash=[...reference.points.map(q=>({p:q.p,t:q.t,...q.state95})),...reference.saturation.map(q=>({p:q.p,...q.state95}))].map(q=>{
    const begin=performance.now()
    try{reusable.update(cool.input_pairs.DmassUmass_INPUTS,q.rho,q.u);return{p:q.p,t:q.t,
      relativeP:reusable.p()/q.p-1,deltaT:reusable.T()-q.t,micros:(performance.now()-begin)*1000}}
    catch(error){return{p:q.p,t:q.t,error:String(error)}}
  })
  const coolSaturation=reference.saturation.map(q=>{
    reusable.update(cool.input_pairs.PQ_INPUTS,q.p,q.x)
    return{p:q.p,x:q.x,relativeRho:reusable.rhomass()/q.state95.rho-1,relativeH:reusable.hmass()/q.state95.h-1,
      firstLawRelative:Math.abs(reusable.hmass()-reusable.umass()-q.p/reusable.rhomass())/Math.abs(reusable.hmass())}
  })
  const other=cool.factory('HEOS','Water')
  reusable.update(cool.input_pairs.PT_INPUTS,15.5e6,573.15)
  const before=reusable.hmass()
  other.update(cool.input_pairs.PT_INPUTS,.1e6,450)
  const isolation={unchanged:before===reusable.hmass(),firstH:before,otherH:other.hmass()}
  const rejectedUpdates=[[-1,300],[15.5e6,NaN],[15.5e6,0]].map(([p,t])=>{
    let rejected=false,message=''
    try{reusable.update(cool.input_pairs.PT_INPUTS,p,t)}catch(error){rejected=true;message=typeof error==='number'?cool.getExceptionMessage(error):String(error)}
    // Never inspect/accept whatever a failed update left behind.
    reusable.update(cool.input_pairs.PT_INPUTS,15.5e6,573.15)
    return{p,t:String(t),rejected,message,recovered:reusable.hmass()===before}
  })
  // IAPWS R6-95(2018), Table 7, p.15. Published rounded verification values,
  // attributed to the International Association for the Properties of Water and Steam.
  const published95=[
    [300,996.556,.0992418352,4.13018112,1501.51914,.393062643],
    [300,1005.308,20.0022515,4.06798347,1534.92501,.387405401],
    [300,1188.202,700.004704,3.46135580,2443.57992,.132609616],
    [500,.435,.0999679423,1.50817541,548.314253,7.94488271],
    [500,4.532,.999938125,1.66991025,535.739001,6.82502725],
    [500,838.025,10.0003858,3.22106219,1271.28441,2.56690919],
    [500,1084.564,700.000405,3.07437693,2412.00877,2.03237509],
    [647,358,22.0384756,6.18315728,252.145078,4.32092307],
    [900,.241,.100062559,1.75890657,724.027147,9.16653194],
    [900,52.615,20.0000690,1.93510526,698.445674,6.59070225],
    [900,870.769,700.000006,2.66422350,2019.33608,4.17223802],
  ].map(([t,rho,p,cv,w,s])=>{
    reusable.update(cool.input_pairs.DmassT_INPUTS,rho,t)
    const errors={p:reusable.p()/(p!*1e6)-1,cv:reusable.cvmass()/(cv!*1000)-1,w:reusable.speed_sound()/w!-1,s:reusable.smass()/(s!*1000)-1}
    return{t,rho,errors,withinScreen:Object.entries(errors).every(([key,value])=>Number.isFinite(value)&&Math.abs(value)<(key==='p'&&t===300&&rho===996.556?1e-6:1e-8))}
  })
  // Table 8 at the same source: T, saturation p(MPa), liquid/vapor rho, h(kJ/kg), s(kJ/kg K).
  const publishedSaturation95=[
    [275,.000698451167,999.887406,.00550664919,7.75972202,2504.28995,.0283094670,9.10660121],
    [450,.932203564,890.341250,4.81200360,749.161585,2774.41078,2.10865845,6.60921221],
    [625,16.9082693,567.090385,118.290280,1686.26976,2550.71625,3.80194683,5.18506121],
  ].flatMap(([t,p,rf,rg,hf,hg,sf,sg])=>[0,1].map(x=>{
    reusable.update(cool.input_pairs.QT_INPUTS,x,t)
    const errors={p:reusable.p()/(p!*1e6)-1,rho:reusable.rhomass()/(x?rg!:rf!)-1,h:reusable.hmass()/((x?hg!:hf!)*1000)-1,s:reusable.smass()/((x?sg!:sf!)*1000)-1}
    return{t,x,errors,withinScreen:Object.values(errors).every(v=>Number.isFinite(v)&&Math.abs(v)<1e-8)}
  }))
  // One rigid, pure-water m3: prescribed boundary heat, not a plant boiling closure.
  // Cross a phase boundary, cool back, then restore into another numerical object.
  reusable.update(cool.input_pairs.PQ_INPUTS,.101325e6,.5)
  const density0=reusable.rhomass(),u0=reusable.umass(),temperature0=reusable.T()
  const phaseCycle=[]
  let maximumEnergyResidualJ=0
  for(let second=0;second<=200;second++) {
    const heatJ=20000*Math.min(second,200-second),u=u0+heatJ/density0
    reusable.update(cool.input_pairs.DmassUmass_INPUTS,density0,u)
    const errorJ=density0*(reusable.umass()-u)
    maximumEnergyResidualJ=Math.max(maximumEnergyResidualJ,Math.abs(errorJ))
    const phaseCode=reusable.keyed_output(cool.parameters.iPhase)
    const phase=Object.keys(cool.phases).find(key=>cool.phases[key]?.value===phaseCode)
    if(![reusable.p(),reusable.T(),errorJ].every(Number.isFinite)||!phase||phase==='iphase_unknown')throw Error('Invalid phase-cycle state')
    if(second%10===0)phaseCycle.push({second,p:reusable.p(),t:reusable.T(),phase,
      vaporMassFraction:phaseCode===cool.phases.iphase_twophase.value?reusable.Q():null,energyResidualJ:errorJ})
    if(second===100) {
      other.update(cool.input_pairs.DmassUmass_INPUTS,density0,u)
      if(![other.T(),other.p()].every(Number.isFinite)||Math.abs(other.T()-reusable.T())>1e-7||Math.abs(other.p()-reusable.p())>1e-3)throw Error('Conservative thermodynamic copy differs')
    }
  }
  const phaseCycleChecks={maximumEnergyResidualJ,returnedDeltaT:reusable.T()-temperature0,
    crossedPhase:phaseCycle.some(q=>q.phase==='iphase_gas'||q.phase==='iphase_supercritical_gas'),
    returnedPressureErrorPa:reusable.p()-.101325e6,copyComparedAtSecond:100}
  if(!phaseCycleChecks.crossedPhase||maximumEnergyResidualJ>1||Math.abs(phaseCycleChecks.returnedDeltaT)>1e-6||Math.abs(phaseCycleChecks.returnedPressureErrorPa)>1)
    throw Error('Conservative water phase cycle failed its declared 1 J / 1 microkelvin / 1 Pa screens')
  other.delete()
  reusable.delete()
  return {bun:Bun.version,platform:process.platform,architecture:process.arch,reference:{python:reference.python,iapws:reference.iapws,
    sourceSha256:hash(referenceCalculation),valuesSha256:hash(text),points:reference.points.length},
    packages:{seuif97:await Bun.file(join(seuRoot,'package.json')).json(),neutrium:await Bun.file(join(neutRoot,'package.json')).json()},
    wasm:{bytes:wasm.length,sha256:hash(wasm),coldLoadMs},
    coolprop:{version:cool.get_global_param_string('version'),revision:cool.get_global_param_string('gitrevision'),
      wasmBytes:await Bun.file(join(directory,'coolprop.wasm')).size,wasmSha256:hash(await Bun.file(join(directory,'coolprop.wasm')).bytes()),coldLoadMs:coolColdLoadMs},
    results,saturation,invalid,conservativeFlash,coolSaturation,isolation,rejectedUpdates,published95,publishedSaturation95,phaseCycle,phaseCycleChecks}
}

if(import.meta.main) {
  const [directory,python]=Bun.argv.slice(2)
  if(!directory||!python)throw Error('Usage: reference-design-properties.ts <isolated-candidate-directory> <isolated-python>')
  console.log(JSON.stringify(await evaluatePropertyCandidates(directory,python),null,2))
}
