/** Offline selected low-pressure CW/SW pump and source comparisons. Not a plant runtime. */
import { createHash } from 'node:crypto'

const valid = (value:number,name:string) => {if(!Number.isFinite(value))throw new Error(`Nonfinite ${name}`);return value}
export const degradation = (available:number, required:number, gas:number, exponent=2, gasStop=.15) => {
  if(valid(required,'required')<0 || valid(gas,'gas')<0 || gas>1 || valid(exponent,'exponent')<=0 || valid(gasStop,'gasStop')<=.02 || gasStop>1)throw new Error('Invalid pump reduction input')
  valid(available,'available')
  const suction=required===0?1:Math.min(1,Math.max(0,available/required))**exponent
  const retainedGas=gas<=.02?1:gas>=gasStop?0:(gasStop-gas)/(gasStop-.02)
  return Math.min(suction,retainedGas)
}
export const pumpPower = (q:number, dp:number, speed:number, nominalFluid:number, efficiency:number, gasDensityRatio=1) => {
  if([q,dp,speed,nominalFluid,efficiency,gasDensityRatio].some(v=>!Number.isFinite(v))||q<0||speed<0||speed>1||nominalFluid<=0||efficiency<=0||efficiency>1||gasDensityRatio<0)throw new Error('Invalid power input')
  const useful=Math.max(q*dp,0)
  const dissipative=Math.max(useful*(1/efficiency-1),.01*nominalFluid*speed**3*gasDensityRatio)
  return {useful,dissipative,fluid:useful+dissipative}
}
const root=(fn:(x:number)=>number,lo:number,hi:number)=>{
  if(fn(lo)>0||fn(hi)<0)throw new Error('Unbracketed monotone hydraulic root')
  for(let i=0;i<70;i++){const mid=(lo+hi)/2;if(fn(mid)>0)hi=mid;else lo=mid}return(lo+hi)/2
}
const cw0=47.878938608,site0=cw0+5,rho=1000,g=9.80665,dp0=300000
export const wetFlows = (level:number,speeds:readonly[number,number,number,number]) => {
  if(!Number.isFinite(level)||level<0||level>6||speeds.some(n=>!Number.isFinite(n)||n<0||n>1))throw new Error('Outside cold-liquid comparison')
  // All-liquid, adequate NPSH comparison. Gas/void continuation is tested separately, not assumed absent in a real empty bay.
  const staticHead=rho*g*(level-5)
  const qi=(head:number,n:number)=>cw0/2*Math.sqrt(Math.max(0,(1.25*n*n+(staticHead-head)/dp0)/.25))
  const total=root(q=>q-qi(dp0*(q/cw0)**2,speeds[0])-qi(dp0*(q/cw0)**2,speeds[1]),0,3*cw0)
  const head=dp0*(total/cw0)**2
  const sw=(q0:number,n:number)=>q0*Math.sqrt(Math.max(0,(1.25*n*n+staticHead/dp0)/1.25))
  return [qi(head,speeds[0]),qi(head,speeds[1]),sw(2,speeds[2]),sw(3,speeds[3])]
}

export const compareCoolingWater = () => {
  const checks:string[]=[]
  const check=(name:string,ok:boolean)=>{if(!ok)throw new Error(name);checks.push(name)}
  const normal=wetFlows(5,[1,1,1,1]),one=wetFlows(5,[0,1,1,1])
  check('normal fixed hardware flow',Math.abs(normal.reduce((a,b)=>a+b,0)-site0)<1e-9)
  check('one CW pump lost does not simply halve CW flow',one[0]===0&&Math.abs(one[1]!/cw0-Math.sqrt(.625))<1e-10)
  check('stopped pumps can pass forward gravity flow',wetFlows(6,[0,0,0,0]).every(q=>q>0))
  const curve=[]
  for(const availableRatio of [0,.25,.5,1,2])for(const gas of [0,.02,.08,.15,.3,1]){
    const factor=degradation(3*availableRatio,3,gas)
    check('bounded authored head reduction',factor>=0&&factor<=1)
    curve.push({availableRatio,gas,factor})
  }
  check('normal and gas-bound limits',degradation(5,3,0)===1&&degradation(5,3,1)===0)
  const sensitivity=[1,2].flatMap(exponent=>[.10,.15,.30].map(gasStop=>({exponent,gasStop,factor:degradation(1.5,3,.08,exponent,gasStop)})))
  const power= pumpPower(cw0/2,dp0,1,(cw0/2)*dp0/.85,.85)
  check('no nominal heat retuning',Math.abs(power.fluid-(cw0/2)*dp0/.85)<1e-7)
  const deadhead=pumpPower(0,dp0*1.25,1,(cw0/2)*dp0/.85,.85)
  check('running deadhead retains positive heat with zero useful delivery',deadhead.useful===0&&deadhead.dissipative>0)
  check('zero speed no invented power',pumpPower(0,0,0,(cw0/2)*dp0/.85,.85).fluid===0)
  const passive=pumpPower(1,-50000,0,(cw0/2)*dp0/.85,.85)
  check('passive negative head is not shaft generation',passive.fluid===0)
  // Pressure-loss heat is owned by the native face balance, not pumpPower's added shaft work.
  const passiveNativeDissipation_W=50000
  // 20 C saturation pressure rounded from the native water EOS. Even at zero depth the atmospheric pressure head remains.
  const minimumSiteNpsha_m=(101325-2339.318)/ (rho*g)
  const maximumFixtureNpshr_m=1+2*Math.max(...normal.map((q,i)=>q/[cw0/2,cw0/2,2,3][i]!))**2
  check('cold open-bay NPSH remains adequate to empty event',minimumSiteNpsha_m>maximumFixtureNpshr_m)
  // Saturated hotwell contrast: no atmospheric-minus-vapor head. Frozen40 C liquid and native surface elevation.
  const hotRho=992.1751153412985, hotDp=101325-7384.9381
  const hotwell=(depth:number)=>{
    const residual=(q:number)=>hotDp*(1.25*degradation(depth,1+2*q*q,0)-.25*q*q)-hotDp+hotRho*g*(depth-5)
    if(residual(0)<=0)return {depth_m:depth,relativeFlow:0,npsha_m:depth,npshr_m:1,headFactor:degradation(depth,1,0)}
    const q=root(x=>-residual(x),0,3)
    return {depth_m:depth,relativeFlow:q,npsha_m:depth,npshr_m:1+2*q*q,headFactor:degradation(depth,1+2*q*q,0)}
  }
  const hotwellCases=[5,4,3,2,1,.5,0].map(hotwell)
  check('hotwell normal calibration preserved',Math.abs(hotwellCases[0]!.relativeFlow-1)<1e-12)
  check('hotwell depleted head cannot invent delivery',hotwellCases[3]!.relativeFlow===0&&hotwellCases[3]!.depth_m>0)
  // Integrate only the cold wet-bay comparison to its actual empty inventory event. No post-empty gas behavior is claimed.
  const drain=(dt:number,capacity=0)=>{
    let V=1000,t=0,delivered=0
    while(V>0){const q=wetFlows(V/200,[1,1,1,1]).reduce((a,b)=>a+b,0);const h=Math.min(dt,V/(q-capacity));V-=(q-capacity)*h;delivered+=q*h;t+=h;if(t>100)throw new Error('Unexpected bay depletion time')}
    return {emptyAt_s:t,delivered_m3:delivered,supplied_m3:capacity*t}
  }
  const coarse=drain(.02),fine=drain(.01)
  check('finite source-loss water accounting',Math.abs(fine.delivered_m3-1000)<1e-8)
  check('empty-event time resolution',Math.abs(fine.emptyAt_s-coarse.emptyAt_s)<.01)
  const halfSupply=drain(.01,site0/2)
  check('limited source adds real water rather than clipping withdrawals',halfSupply.emptyAt_s>fine.emptyAt_s&&Math.abs(halfSupply.delivered_m3-halfSupply.supplied_m3-1000)<1e-8)
  const onePumpFloatLevel=root(h=>wetFlows(h,[0,1,1,1]).reduce((a,b)=>a+b,0)-site0*(6-h),5,6)
  check('mechanical float balances lower consumption without overflow',onePumpFloatLevel>5&&onePumpFloatLevel<6)
  // Pumps stopped/no delivery: actual capacity-limited refill to the normal5m mark; no gas/shaft/state reset.
  const refillTo5_s=1000/site0
  const gamma=1+287/718,Vc=.05*cw0/2,Vg0=.15*Vc,p0=101325,p1=p0+rho*g*5,T0=293.15
  const Mg=p0*Vg0/(287*T0),Vg1=Vg0*(p0/p1)**(1/gamma),T1=T0*(Vg0/Vg1)**(gamma-1)
  const dU=Mg*718*(T1-T0),work=(p1*Vg1-p0*Vg0)/(gamma-1)
  check('closed vent retains gas on flooding',Vg1>0&&Math.abs(p1*Vg1/(287*T1)-Mg)<1e-12)
  check('reflooding compression work retained',dU>0&&Math.abs(dU-work)<1e-8)
  check('reflooding alone does not restore all-liquid state',Vg1/Vc>.02)
  const ventMassToTwoPercent=Mg-p1*(.02*Vc)/(287*T1)
  check('actual gas removal needed to regain selected low-gas range',ventMassToTwoPercent>0)
  return {scope:'separate cold all-liquid hydraulic/source-loss fixtures, saturated-hotwell intersections, head-factor sweeps and retained-air compression; not a coupled gas/thermal recovery trajectory',fixtureInputs:{cwReference_m3_s:cw0,siteReference_m3_s:site0,referenceDensity_kg_m3:rho,gravity_m_s2:g,referenceHead_Pa:dp0,siteSaturationPressure20C_Pa:2339.318,hotwellDensity40C_kg_m3:hotRho,hotwellSaturationPressure40C_Pa:7384.9381,bayArea_m2:200,initialBayVolume_m3:1000,airR_J_kg_K:287,airCv_J_kg_K:718,casingResidenceScale_s:.05,gasDegradationStart:.02,gasDegradationZero:.15,suctionExponent:2,propertyScope:'rounded HEOS water endpoint inputs, fixed-property comparison only; no EOS package invoked by this helper'},checks,normal_m3_s:normal,oneCwPumpLost_m3_s:one,headCurve:curve,sensitivity,normalPower_W:power,deadheadPower_W:deadhead,passiveNegativeHead:{shaftPower_W:passive.fluid,nativeFaceDissipation_W:passiveNativeDissipation_W},hotwellCases,sourceLoss:{minimumSiteNpsha_m,maximumFixtureNpshr_m,coarse,fine,halfSupply,onePumpFloatLevel_m:onePumpFloatLevel,refillTo5_s},closedVentReflood:{casingVolume_m3:Vc,gasMass_kg:Mg,initialGasFraction:.15,finalGasFraction:Vg1/Vc,compressionWork_J:work,gasEnergyRise_J:dU,ventMassToTwoPercent_kg:ventMassToTwoPercent}}
}

if(import.meta.main){
  const owners=Bun.argv.slice(2)
  if(owners.length!==2)throw new Error('Supply condenser and support owner paths')
  const files=await Promise.all([import.meta.path,...owners].map(async path=>({path,text:await Bun.file(path).text()})))
  const result=compareCoolingWater()
  for(const file of files)if(await Bun.file(file.path).text()!==file.text)throw new Error('Source changed during comparison')
  console.log(JSON.stringify({liveModelInstalled:false,sources:files.map(f=>({path:f.path,sha256:createHash('sha256').update(f.text).digest('hex')})),...result},null,2))
}
