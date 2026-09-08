/** Bounded native HEOS connected-primary experiment; not a production solver. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseInitializationBasis } from './reference-design-initialization.ts'
import { runCycle } from './reference-design-cycle.ts'
import { runHydraulics } from './reference-design-hydraulics.ts'

const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex')
const sum=(a:number[])=>a.reduce((x,y)=>x+y,0)
const maxabs=(a:number[])=>Math.max(...a.map(Math.abs))
const zeros=(n:number)=>Array<number>(n).fill(0)
const finite=(a:number[])=>a.every(Number.isFinite)
export class KernelTrialError extends Error {}

/** Pivoting dense elimination for this 42-variable experiment, not a sparse plant API. */
export function solveKernelLinear(matrix:number[][],rhs:number[]) {
  const n=rhs.length
  if(!n||matrix.length!==n||matrix.some(r=>r.length!==n||!finite(r))||!finite(rhs))throw Error('Malformed linear system')
  const a=matrix.map((r,i)=>[...r,rhs[i]!])
  for(let k=0;k<n;k++) {
    let pivot=k
    for(let i=k+1;i<n;i++)if(Math.abs(a[i]![k]!)>Math.abs(a[pivot]![k]!))pivot=i
    if(Math.abs(a[pivot]![k]!)<1e-14)throw Error('Singular scaled kernel Jacobian')
    ;[a[k],a[pivot]]=[a[pivot]!,a[k]!]
    for(let i=k+1;i<n;i++){
      const f=a[i]![k]!/a[k]![k]!
      for(let j=k+1;j<=n;j++)a[i]![j]=a[i]![j]!-f*a[k]![j]!
      a[i]![k]=0
    }
  }
  const x=zeros(n)
  for(let i=n-1;i>=0;i--)x[i]=(a[i]![n]!-sum(a[i]!.slice(i+1,n).map((v,j)=>v*x[i+1+j]!)))/a[i]![i]!
  if(!finite(x))throw Error('Nonfinite linear solution')
  return x
}

export function solveKernelNewton(f:(x:number[])=>number[],guess:number[]) {
  const residual=(x:number[])=>{const values=f(x);if(values.length!==x.length||!finite(values))throw Error('Malformed or nonfinite nonlinear residual');return values}
  let x=[...guess],r=residual(x)
  for(let iteration=0;iteration<16;iteration++){
    if(!finite(r))throw Error('Nonfinite nonlinear residual')
    if(maxabs(r)<2e-10)return{x,residual:maxabs(r),iteration}
    const n=x.length,h=2e-6,j=Array.from({length:n},()=>zeros(n))
    for(let k=0;k<n;k++){
      const xp=[...x],xm=[...x];xp[k]=xp[k]!+h;xm[k]=xm[k]!-h
      const rp=residual(xp),rm=residual(xm)
      for(let i=0;i<n;i++)j[i]![k]=(rp[i]!-rm[i]!)/(2*h)
    }
    const dx=solveKernelLinear(j,r.map(v=>-v)),oldNorm=Math.hypot(...r)
    let accepted=false
    for(let scale=1;scale>=1/1024;scale/=2){
      const trial=x.map((v,i)=>v+scale*dx[i]!)
      try{const nr=residual(trial);if(Math.hypot(...nr)<oldNorm){x=trial;r=nr;accepted=true;break}}
      catch(error){if(!(error instanceof KernelTrialError))throw error;/* Known domain rejection, never a plant event. */}
    }
    if(!accepted)throw Error('Kernel Newton has no decreasing admissible step')
  }
  throw Error('Kernel Newton iteration exhausted; state not accepted')
}

export async function runNativeKernel(initializationDocument:string,hydraulicDocument:string,cycleDocument:string,directory:string,python:string){
  const basis=parseInitializationBasis(initializationDocument)
  const sourceHash=hash(await Bun.file(import.meta.path).bytes())
  // These fixed existing calculations provide physical coefficients, not state targets.
  const [cycle,hydraulic]=await Promise.all([runCycle(cycleDocument,python),runHydraulics(hydraulicDocument,cycleDocument,python)])
  const wasm=await Bun.file(join(directory,'coolprop.wasm')).bytes()
  const loader=await Bun.file(join(directory,'coolprop.js')).bytes()
  const cool=await(await import(pathToFileURL(join(directory,'coolprop.js')).href)).default()
  const state=cool.factory('HEOS','Water')
  try {
  let propertyCalls=0,residualCalls=0
  const pt=(p:number,T:number)=>{
    if(!Number.isFinite(p)||!Number.isFinite(T)||p<14e6||p>16.5e6||T<548.15||T>601.15)throw new KernelTrialError('Outside sealed-primary liquid investigation band')
    try{state.update(cool.input_pairs.PT_INPUTS,p,T)}catch(error){throw new KernelTrialError('HEOS rejected PT trial: '+String(error))}
    propertyCalls++
    const phase=state.keyed_output(cool.parameters.iPhase)
    if(phase!==cool.phases.iphase_liquid.value&&phase!==cool.phases.iphase_supercritical_liquid.value)throw new KernelTrialError('Kernel requires actual single liquid phase')
    const result={rho:state.rhomass(),h:state.hmass(),u:state.umass()}
    if(!finite(Object.values(result))||result.rho<=0)throw Error('Invalid EOS result')
    return result
  }
  const c=cycle,s=c.points,hb=hydraulic.basis,cb=c.basis,g=hb.gravity_m_s2
  const names=['DOWNCOMER','LOWER','CORE.1','CORE.2','UPPER','HOT.A','HOT.B','SG.A.PRIMARY','SG.B.PRIMARY','COLD.A','COLD.B']
  const pressureZ=[3,-2,0,2,2,2.5,2.5,3,3,3,3]
  const energyZ=[0,-3,-1,1,3,2.5,2.5,7.5,7.5,3,3]
  const ends=[[0,1],[1,2],[2,3],[3,4],[4,5],[4,6],[5,7],[6,8],[7,9],[7,9],[8,10],[8,10],[9,0],[10,0]] as const
  const M0=c.flows.primary_kg_s,m0=M0/4,ml0=M0/2,Pcore=c.powers_MW.core*1e6
  const refs=[M0,M0,M0,M0,ml0,ml0,ml0,ml0,m0,m0,m0,m0,ml0,ml0]
  const Qcore=[c.powers_MW.core_cell1*1e6,c.powers_MW.core_cell2*1e6]
  const k=hydraulic.resistance_Pa_per_kg_s_squared
  const K=[k.cold_to_core,k.core_lower,k.core_upper,0,k.hot,k.hot,k.SG,k.SG,k.pump_outlet,k.pump_outlet,k.pump_outlet,k.pump_outlet,0,0]
  const Cwall=basis.metalCapacity_MJ_K*1e6,omega0=hb.pumpRpm*2*Math.PI/60
  const Pfluid0=c.powers_MW.RCP_fluid*1e6/4,rho0=s.RCP_suction.rho_kg_m3,q0=m0/rho0,e0=Pfluid0/m0
  const a=e0/((1-hb.pumpShapeFraction)*omega0**2),blade=hb.pumpShapeFraction*a*omega0/q0
  const R=(rho0*e0-(cb.RCPDischargePressure_MPaAbs-s.RCP_suction.p_MPaAbs)*1e6)/(rho0*q0*q0)
  const drag0=cb.RCPDragFraction*Pfluid0,J=(Pfluid0+drag0)*basis.inertiaDecay_s/omega0**2,torque0=(Pfluid0+drag0)/omega0
  const Tsink=s.main_steam.T_C,Tsg0=s.RCP_suction.T_C,Tmetal0=(Tsink+Tsg0)/2
  const G=c.powers_MW.SG_total*1e6/2/(Tsg0-Tmetal0)
  const pseed=[15.2,15.2,15.1,15,15,14.95,14.95,14.7,14.7,15.2,15.2]
  const hseed=[s.core_inlet.h_kJ_kg,s.core_inlet.h_kJ_kg,s.core_mid.h_kJ_kg,...Array(4).fill(s.core_outlet.h_kJ_kg),s.RCP_suction.h_kJ_kg,s.RCP_suction.h_kJ_kg,s.core_inlet.h_kJ_kg,s.core_inlet.h_kJ_kg]
  const Tseed=hseed.map((h,i)=>{state.update(cool.input_pairs.HmassP_INPUTS,h*1000,pseed[i]!*1e6);return state.T()-273.15})
  // Keep the calibration density normalization on its originally declared IF97 basis.
  // Full source coefficients below are retained with their source hashes.
  const densityCalculation='import json,sys\nfrom iapws import IAPWS97\nx=json.load(sys.stdin)\nprint(json.dumps([IAPWS97(P=p,h=h).rho for p,h in zip(x["p"],x["h"])]))'
  const densityProcess=Bun.spawn([python,'-c',densityCalculation],{stdin:Buffer.from(JSON.stringify({p:pseed,h:hseed})),stdout:'pipe',stderr:'pipe'})
  const [densityText,densityError,densityStatus]=await Promise.all([new Response(densityProcess.stdout).text(),new Response(densityProcess.stderr).text(),densityProcess.exited])
  if(densityStatus!==0)throw Error(densityError)
  const calibrationRho=JSON.parse(densityText) as number[]
  if(calibrationRho.length!==11||!finite(calibrationRho)||calibrationRho.some(v=>v<=0))throw Error('Invalid frozen density normalization')
  const rhoref=ends.map(([i])=>calibrationRho[i]!)
  const seed=[...pseed.map(p=>p/15),...Tseed.map(T=>T/300),...Array(14).fill(1),Tmetal0/300,Tmetal0/300,...Array(4).fill(1)]
  function evaluate(x:number[],factor=1,request=1){
    if(x.length!==42||!finite(x))throw Error('Malformed kernel state')
    const p=x.slice(0,11).map(v=>v*15),T=x.slice(11,22).map(v=>v*300),m=x.slice(22,36).map((v,i)=>v*refs[i]!)
    const Tw=x.slice(36,38).map(v=>v*300),omega=x.slice(38).map(v=>v*omega0),props=p.map((v,i)=>pt(v*1e6,T[i]!+273.15))
    const mass=props.map((q,i)=>q.rho*basis.volumes_m3[i]!),energy=props.map((q,i)=>mass[i]!*(q.u+g*energyZ[i]!))
    const dM=zeros(11),dU=zeros(11),hyd:number[]=[],electrical:number[]=[],ambient:number[]=[],domega:number[]=[]
    for(let edge=0;edge<14;edge++){
      const [i,j]=ends[edge]!,flow=m[edge]!,up=flow>=0?i:j,ru=props[up]!.rho
      let head=ru*g*(pressureZ[j]!-pressureZ[i]!),pumpHead=0,power=0
      if(edge<=2)head=(props[i]!.rho+props[j]!.rho)/2*g*(pressureZ[j]!-pressureZ[i]!)
      if(edge===6||edge===7)head=g*(props[i]!.rho*(hb.SGturn_m-pressureZ[i]!)+props[j]!.rho*(pressureZ[j]!-hb.SGturn_m))
      if(edge>=8&&edge<=11){
        const n=edge-8,q=flow/ru,w=omega[n]!,tf=ru*q*(a*w-blade*q),td=drag0/omega0**2*w
        if(w<0)throw new KernelTrialError('Reverse rotor outside admission')
        power=w*tf;pumpHead=ru*w*(a*w-blade*q)-R*ru*q*Math.abs(q)
        const tm=Math.max(0,Math.min(1.5*torque0,tf+td+J*(omega0*(n===0?request:1)-w)/basis.motorTracking_s))
        const pe=tm*w/cb.RCPMotorEfficiency;electrical.push(pe);ambient.push(pe-tm*w+td*w);domega.push((tm-tf-td)/J)
      }
      hyd.push((p[i]!-p[j]!)*1e6+pumpHead-head-K[edge]!*flow*Math.abs(flow)*rhoref[edge]!/ru)
      const flux=flow*(props[up]!.h+g*energyZ[up]!)
      dM[i]=dM[i]!-flow;dM[j]=dM[j]!+flow;dU[i]=dU[i]!-flux;dU[j]=dU[j]!+flux
      dU[flow>=0?j:i]=dU[flow>=0?j:i]!+power
    }
    dU[2]=dU[2]!+Qcore[0]!*factor;dU[3]=dU[3]!+Qcore[1]!*factor
    const Qp=Tw.map((v,i)=>G*(T[7+i]!-v)),Qs=Tw.map(v=>G*(v-Tsink)),dw=Qp.map((v,i)=>(v-Qs[i]!)/Cwall)
    for(let i=0;i<2;i++)dU[7+i]=dU[7+i]!-Qp[i]!
    return{p,T,m,Tw,omega,mass,energy,dM,dU,hyd,dw,domega,Qs,
      stored:sum(energy)+Cwall*sum(Tw)+.5*J*sum(omega.map(v=>v*v)),power:Pcore*factor+sum(electrical)-sum(ambient)-sum(Qs)}
  }
  type Evaluated=ReturnType<typeof evaluate>
  const steady=(x:number[])=>{residualCalls++;const e=evaluate(x),mr=e.dM.map(v=>v/M0);mr[0]=(e.p[1]!-cb.coreInletPressure_MPaAbs)/.6;return[...mr,...e.dU.map(v=>v/Pcore),...e.hyd.map(v=>v/600000),...e.dw.map(v=>v*Cwall/Pcore),...e.domega.map(v=>v*J/torque0)]}
  const begin=performance.now(),solution=solveKernelNewton(steady,seed),initial=evaluate(solution.x)
  const alternate=seed.map((v,i)=>v+(i<22?.001:0)),other=solveKernelNewton(steady,alternate)
  if(maxabs(other.x.map((v,i)=>v-solution.x[i]!))>1e-7)throw Error('Independent initialization did not agree')
  if(maxabs(initial.dM)>1e-4||maxabs(initial.dU)>10||maxabs(initial.hyd)>1)throw Error('Dimensional steady residual failed')
  const initializationCost_s=(performance.now()-begin)/1000
  const compact=(t:number,e:Evaluated)=>({t_s:t,p_MPa:e.p,T_C:e.T,flow_kg_s:e.m,wall_C:e.Tw,rpm:e.omega.map(w=>w*60/(2*Math.PI))})
  function integrate(name:string,dt:number,end:number,mode:'hold'|'heat'|'shaft'){
    const start=performance.now(),before={propertyCalls,residualCalls};let x=[...solution.x],current=initial,ledger=0,rotorNumerical=0,maxMass=0,maxEnergy=0,maxResidual=0
    const samples=[compact(0,current)]
    for(let n=0;n<Math.round(end/dt);n++){
      const t=(n+1)*dt,active=n*dt<basis.sourcePulse_s-1e-9,factor=mode==='heat'&&active?1+basis.sourcePulseFraction:1,request=mode==='shaft'&&active?.999:1,old=current
      const residual=(trial:number[])=>{residualCalls++;const e=evaluate(trial,factor,request);return[
        ...e.mass.map((v,i)=>((v-old.mass[i]!)/dt-e.dM[i]!)/M0),...e.energy.map((v,i)=>((v-old.energy[i]!)/dt-e.dU[i]!)/Pcore),
        ...e.hyd.map(v=>v/600000),...e.Tw.map((v,i)=>((v-old.Tw[i]!)/dt-e.dw[i]!)*Cwall/Pcore),...e.omega.map((v,i)=>((v-old.omega[i]!)/dt-e.domega[i]!)*J/torque0)]}
      const solved=solveKernelNewton(residual,x);x=solved.x;current=evaluate(x,factor,request)
      ledger+=current.power*dt;rotorNumerical+=.5*J*sum(current.omega.map((w,i)=>(w-old.omega[i]!)**2))
      maxMass=Math.max(maxMass,Math.abs(sum(current.mass)-sum(initial.mass)))
      maxEnergy=Math.max(maxEnergy,Math.abs(current.stored-initial.stored-ledger+rotorNumerical));maxResidual=Math.max(maxResidual,solved.residual)
      if(Math.abs(t*10-Math.round(t*10))<1e-8||n===Math.round(end/dt)-1)samples.push(compact(t,current))
    }
    if(maxMass>.001||maxEnergy>10000)throw Error('Kernel conservation gate failed')
    const pressureDrift=maxabs(current.p.map((v,i)=>v-initial.p[i]!)),temperatureDrift=maxabs(current.T.map((v,i)=>v-initial.T[i]!))
    if(mode==='hold'&&(pressureDrift>1e-5||temperatureDrift>1e-4))throw Error('Held state drift failed')
    return{name,dt,samples,maxMass_kg:maxMass,maxEnergy_J:maxEnergy,maxResidual,rotorNumerical_J:rotorNumerical,pressureDrift_MPa:pressureDrift,temperatureDrift_K:temperatureDrift,
      cost:{wall_s:(performance.now()-start)/1000,propertyCalls:propertyCalls-before.propertyCalls,residualCalls:residualCalls-before.residualCalls}}
  }
  const hold=integrate('hold',basis.holdStep_s,basis.hold_s,'hold')
  const heat=basis.steps_s.map(dt=>integrate('heat',dt,basis.perturbation_s,'heat')),shaft=basis.steps_s.map(dt=>integrate('shaft',dt,basis.perturbation_s,'shaft'))
  const refinement=[heat,shaft].flatMap(runs=>runs.slice(1).map((fine,index)=>{
    const coarse=runs[index]!,lookup=new Map(fine.samples.map(s=>[Math.round(s.t_s*10),s])),differences={p_MPa:0,T_C:0,flow_kg_s:0,wall_C:0,rpm:0}
    for(const s of coarse.samples){const f=lookup.get(Math.round(s.t_s*10));if(!f)throw Error('Missing common physical time');for(const key of Object.keys(differences) as Array<keyof typeof differences>)differences[key]=Math.max(differences[key],maxabs(s[key].map((v,i)=>v-f[key][i]!)))}
    const accepted=differences.p_MPa<.001&&differences.T_C<.01&&differences.flow_kg_s<5&&differences.wall_C<.01&&differences.rpm<.1
    if(index===1&&!accepted)throw Error('Finest kernel refinement failed')
    return{case:coarse.name,coarseStep:coarse.dt,fineStep:fine.dt,differences,accepted}
  }))
  return{scope:'Native HEOS sealed-primary experiment, not installed runtime',basis,energyConvention:'M(u+gz) storage; m(h+gz) shared donor flux; no fluid kinetic energy; BE rotor defect reported',pressureZ,energyZ,names,
    provenance:{sourceHash,inputHash:hash(JSON.stringify(basis)),wasmHash:hash(wasm),loaderHash:hash(loader),densityCalibrationHash:hash(densityCalculation),cycleInput:cycle.inputSha256,cycleCalculation:cycle.calculationSha256,hydraulicInput:hydraulic.inputSha256,hydraulicCalculation:hydraulic.calculationSha256},
    nominal:compact(0,initial),primaryMass_kg:sum(initial.mass),calibration:{refs,K,rhoref,a,blade,R,J,G,Tsink},hold,heat,shaft,refinement,initializationCost_s,totalCost_s:(performance.now()-begin)/1000,propertyCalls,residualCalls}
  } finally { state.delete() }
}

if(import.meta.main){
  const [init,hyd,cycle,dir,python]=Bun.argv.slice(2)
  if(!init||!hyd||!cycle||!dir||!python)throw Error('Usage: kernel.ts <initialization.md> <hydraulic.md> <cycle.md> <isolated-coolprop-dir> <isolated-python>')
  console.log(JSON.stringify(await runNativeKernel(await Bun.file(init).text(),await Bun.file(hyd).text(),await Bun.file(cycle).text(),dir,python),null,2))
}
