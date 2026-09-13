/** Offline fixed-state momentum discriminator, not finite PRHR thermal startup. */
import {createHash} from 'node:crypto'
import {parsePrhrExchange,prhrExchange,type ExchangeWater,type PrhrExchangeBasis} from './reference-design-prhr-exchange'

export function responseRates(b:PrhrExchangeBasis,c:ExchangeWater,a:ExchangeWater,q:number,main:number) {
  const A=Math.PI*b.diameter_m**2/4,Ac=A*b.initialCoreFraction,Aa=A-Ac
  const uc=q/(c.density_kg_m3*Ac),ua=-q/(a.density_kg_m3*Aa)
  const f=prhrExchange(b,c,a,b.initialCoreFraction,uc,ua,main,c.density_kg_m3)
  const inertance=b.length_m*(1/Ac+1/Aa),buoyantHead=(a.density_kg_m3-c.density_kg_m3)*9.80665*b.rise_m
  const kineticCoefficient=b.length_m*(1/(c.density_kg_m3*Ac)+1/(a.density_kg_m3*Aa))
  const relativeVolume=Ac*Aa/A*(uc-ua)
  return {qdot:(buoyantHead+f.entranceHead_Pa-b.length_m*f.differentialDragGradient_Pa_m)/inertance,
    kinetic_J:.5*kineticCoefficient*q*q,kineticCoefficient,buoyantWork_W:relativeVolume*buoyantHead,
    teeWork_W:f.entranceWork_W,dissipation_W:f.interfacialDissipation_W+f.wallDissipation_W,
    // Equal/opposite mass is not equal/opposite volume at unequal densities.
    // This unclosed common-pressure/constraint work is reported, never added as fictitious heat.
    missingProjectedWork_W:-(f.annulusForce_N+f.coreForce_N)*(Ac*uc+Aa*ua)/A,
    netVolume_m3_s:Ac*uc+Aa*ua,
    grossVolume_m3_s:Math.abs(q)*(1/c.density_kg_m3+1/a.density_kg_m3),
    relativeVolume_m3_s:relativeVolume,water_kg:b.length_m*(c.density_kg_m3*Ac+a.density_kg_m3*Aa)}
}
export function settledExchange(b:PrhrExchangeBasis,c:ExchangeWater,a:ExchangeWater,main:number) {
  let lo=-1000,hi=1000
  if(responseRates(b,c,a,lo,main).qdot<=0||responseRates(b,c,a,hi,main).qdot>=0)throw Error('Fixed-state root lies outside declared ±1000kg/s bracket')
  for(let i=0;i<70;i++){const mid=(lo+hi)/2;if(responseRates(b,c,a,mid,main).qdot>0)lo=mid;else hi=mid}
  return (lo+hi)/2
}
export function responseCase(b:PrhrExchangeBasis,c:ExchangeWater,a:ExchangeWater,dt:number,main=9.847249623) {
  const duration=30,cut=5,rootOn=settledExchange(b,c,a,main),rootOff=settledExchange(b,c,a,0)
  if(Math.abs(cut/dt-Math.round(cut/dt))>1e-10||Math.abs(duration/dt-Math.round(duration/dt))>1e-10)throw Error('Step must resolve prescribed intervention exactly')
  let y=[0,0,0,0,0],atCut=0,grossAtCut=0,maxEnergy=0,maxIdentity=0,maxQ=0
  const history=[] as {t_s:number;q_kg_s:number;grossMass_kg:number;kinetic_J:number}[]
  const rhs=(v:number[],speed:number)=>{const r=responseRates(b,c,a,v[0]!,speed);return [r.qdot,Math.abs(v[0]!),r.buoyantWork_W+r.teeWork_W-r.dissipation_W,r.teeWork_W,r.missingProjectedWork_W]}
  for(let i=0;i<Math.round(duration/dt);i++){
    const speed=i*dt<cut?main:0
    const add=(v:number[],k:number[],s:number)=>v.map((x,j)=>x+s*k[j]!)
    const k1=rhs(y,speed),k2=rhs(add(y,k1,dt/2),speed),k3=rhs(add(y,k2,dt/2),speed),k4=rhs(add(y,k3,dt),speed)
    y=y.map((v,j)=>v+dt*(k1[j]!+2*k2[j]!+2*k3[j]!+k4[j]!)/6)
    const r=responseRates(b,c,a,y[0]!,speed),t=(i+1)*dt
    if(!y.every(Number.isFinite))throw Error('Momentum response failed')
    maxEnergy=Math.max(maxEnergy,Math.abs(r.kinetic_J-y[2]!));maxIdentity=Math.max(maxIdentity,Math.abs(r.kinetic_J-y[2]!-y[4]!));maxQ=Math.max(maxQ,Math.abs(y[0]!))
    if(Math.abs(t-cut)<1e-9){atCut=y[0]!;grossAtCut=y[1]!}
    if((i+1)%Math.round(.1/dt)===0)history.push({t_s:t,q_kg_s:y[0]!,grossMass_kg:y[1]!,kinetic_J:r.kinetic_J})
  }
  const algebraicFirst=Math.abs(rootOn)*cut
  return {dt_s:dt,core_K:c.temperature_K,annulus_K:a.temperature_K,mixingCoefficient:b.mixingCoefficient,
    stationaryOn_kg_s:rootOn,stationaryOff_kg_s:rootOff,atIntervention_kg_s:atCut,
    first5sGrossMass_kg:grossAtCut,instantaneousFirst5sGrossMass_kg:algebraicFirst,
    first5sRelativeGrossOverprediction:algebraicFirst===0?0:(algebraicFirst-grossAtCut)/algebraicFirst,
    maximumUnclosedWorkResidual_J:maxEnergy,maximumDerivedMissingWorkIdentityResidual_J:maxIdentity,maximumAbsFlow_kg_s:maxQ,
    teeMechanicalWork_J:y[3],finalGrossMass_kg:y[1],finalFlow_kg_s:y[0],
    scope:'Frozen-density/temperature scalar momentum discrimination. Maintained thermal/pressure fields; not finite thermal continuation or predicted startup duty.',history}
}

if(import.meta.main){
  const [owner,python,...rest]=process.argv.slice(2)
  if(!owner||!python||rest.length)throw Error('Usage: prhr-response <owner.md> <python-with-iapws>')
  const source=await Bun.file(import.meta.path).text(),exchangeSource=await Bun.file(new URL('./reference-design-prhr-exchange.ts',import.meta.url)).text()
  const b=parsePrhrExchange(await Bun.file(owner).text())
  const propertyCode="import json,iapws; from iapws import IAPWS97; print(json.dumps([dict(temperature_K=T+273.15,density_kg_m3=(w:=IAPWS97(P=15,T=T+273.15)).rho,viscosity_Pas=w.mu,conductivity_W_mK=w.k,cp_J_kgK=w.cp*1000) for T in [25,150,289.9,290]]))"
  const child=Bun.spawn([python,'-c',propertyCode],{stdout:'pipe',stderr:'inherit'})
  const [text,status]=await Promise.all([new Response(child.stdout).text(),child.exited]);if(status!==0)throw Error('Water property acquisition failed')
  const water=JSON.parse(text) as ExchangeWater[],pairs=[[3,0],[3,1],[3,2],[3,3],[0,3]]
  const results=[]
  for(const [c,a]of pairs)for(const mixingCoefficient of [0,.01,.04]){
    const input={...b,mixingCoefficient},coarse=responseCase(input,water[c!]!,water[a!]!,.01),fine=responseCase(input,water[c!]!,water[a!]!,.005)
    const flowDifference=Math.max(...coarse.history.map((v,i)=>Math.abs(v.q_kg_s-fine.history[i]!.q_kg_s)))
    const grossDifference=Math.max(...coarse.history.map((v,i)=>Math.abs(v.grossMass_kg-fine.history[i]!.grossMass_kg)))
    results.push({flowDifference_kg_s:flowDifference,grossDifference_kg:grossDifference,
      numericalScreenPassed:flowDifference<=1e-4&&grossDifference<=1e-3&&fine.maximumDerivedMissingWorkIdentityResidual_J<=1e-3,coarse,fine})
  }
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({sourceSha256:hash(source),exchangeSourceSha256:hash(exchangeSource),propertyCodeSha256:hash(propertyCode),input:b,water,
    question:'Can instantaneous zero-net gross exchange replace finite relative momentum throughout the declared startup/SG-loss window?',
    decisionScreen:'First5s gross comparison10% is descriptive only: missing native work rejects the unequal-density transient shortcut before thermal use. Equal-temperature mechanics cannot select thermal startup.',
    disposition:'Rejected as a finite thermal startup realization: unequal-density mass-pair constraint omits common pressure/constraint work. No work correction applied; finite source/receiver not implemented.',
    results,numericalChecksPassed:results.every(r=>r.numericalScreenPassed)},null,2))
}
