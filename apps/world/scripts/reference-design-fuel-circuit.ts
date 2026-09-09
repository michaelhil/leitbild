/** Offline radial-solid / sealed-primary handoff. No live Plant Model. */
import { createHash } from 'node:crypto'
import { parseConnectedFuel } from './reference-design-connected-fuel.ts'
import { primaryReferencePython, resolveInitializationInput } from './reference-design-initialization.ts'
import { radialReferencePython, resolveFuelTransientInput } from './reference-design-fuel-transient.ts'

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
export const fuelCircuitCalculation=String.raw`
import sys,json,math,time,platform
import numpy as np,scipy,iapws
from scipy.optimize import brentq
d=json.load(sys.stdin)
# Explicit code-owned definitions in separate namespaces, not text slicing or
# wiki expressions. Each existing apparatus retains its own original driver.
primary={'d':d['primary']};exec(${JSON.stringify(primaryReferencePython)},primary)
fuel={'d':d['fuel']};exec(${JSON.stringify(radialReferencePython)},fuel)
ev=primary['evaluate'];solve=primary['solve'];b=primary['b'];N=fuel['N']
P=primary['Pcore'];M0=primary['M0'];Cwall=primary['Cwall'];J=primary['J'];torque=primary['torque0']
x0,_=solve(primary['steady'],primary['xseed'],'physical core initialization');e0=ev(x0)
checks=[]
def require(name,condition,**values):
    if not condition:raise ValueError(name+': '+str(values))
    checks.append(dict(name=name,**values))
def boundary(e):
    if min(e['m'][1:4])<=0:raise ValueError('Radial handoff requires positive core flow')
    return dict(p_MPa=e['p'][2:4],T_K=e['T'][2:4]+273.15,flow_kg_s=e['m'][1:3])
nominalBoundary=boundary(e0)
reference=d['fuel']['reference']['actualBoundary']
require('same physical operating point as retained BOL',
    max(abs(nominalBoundary['p_MPa']-reference['coolantPressures_MPa'][1:]))<1e-7 and
    max(abs(nominalBoundary['T_K']-reference['coolantTemperatures_K'][1:]))<1e-6 and
    abs(e0['m'][1]-reference['massflow_kg_s'])<1e-4)
require('cold lattice water volume has one circuit owner',
    max(abs(primary['V'][2:4]-d['fuel']['geometry']['coreFlowVolume_m3']/2))<1e-10)
start=time.perf_counter()
def experiment(n,steps,hold=True,frozen=False):
    radial=fuel['make'](n,True); balance=radial['balances'];nodeEnergy=radial['nodeEnergy'];mechanical=radial['mechanical']
    r0,_=solve(lambda r:balance(r,1.,nominalBoundary)[0]/1000,radial['initial'],'discrete radial initialization')
    size=len(r0)
    require('no second coolant states '+str(n),size==2*(n+n//4+2),solidStates=size)
    def read(y,factor):
        x=y[:42];r=y[42:]*1000
        # The zero-source evaluator supplies CURRENT pressure, temperature and
        # flow. Exactly one subsequent wall heat is added to each water cell.
        hydraulic=ev(x,wallHeat=[0.,0.]);current=nominalBoundary if frozen else boundary(hydraulic)
        rates,caps,_,heats,_,_=balance(r,factor,current)
        e=ev(x,wallHeat=np.array(heats)*N)
        return e,rates,nodeEnergy(r),r,current,np.array(heats)*N
    y0=np.r_[x0,r0/1000];initial=read(y0,1.);water0=initial[0];solid0=sum(initial[2])*N
    require('radial steady paired wall heat '+str(n),max(abs(initial[5]-primary['Qcore']))<10,
        maximumWallHeatError_W=float(max(abs(initial[5]-primary['Qcore']))))
    require('radial caloric primitive totals '+str(n),abs(sum(nodeEnergy(r0))-radial['energy'](r0))<1e-8)
    def projection(t,record):
        e,_,en,r,cur,heat=record
        nodes=[dict(center_K=float(r[s['fi']][0]),surface_K=float(r[s['fi']][-1]),wall_K=float(r[s['ci']][-1]),
            mean_K=float(s['fw']@r[s['fi']])) for s in radial['segments']]
        return dict(t_s=t,p_MPa=e['p'].tolist(),T_C=e['T'].tolist(),flow_kg_s=e['m'].tolist(),
            wall_C=e['Tw'].tolist(),rpm=(e['omega']*60/(2*math.pi)).tolist(),radial=nodes,
            wallHeat_W=heat.tolist(),solidEnergyChange_J=float(sum(en)*N-solid0))
    def run(dt,pulse):
        print('fuel/circuit reference '+str((n,dt,pulse,frozen)),file=sys.stderr,flush=True)
        y=y0.copy();record=initial;ledger=rotorLoss=0.;maxMass=maxEnergy=maxRaw=maxSolid=0.;solidLedger=0.
        maxPE=0.;maxOmission=0.;absWork=absGas=absElastic=netWork=0.;maxSampleOmission=0.
        priorMechanical=mechanical(r0,initial[4]);initialMechanical=priorMechanical
        samples=[projection(0.,record)];end=b['perturbation_s'] if pulse else b['hold_s'];endSteps=round(end/dt)
        peakSolid=0.;maxSourceContinuity=0.
        displacement=dict(maximumTotalRodVolumeChange_m3=0.,maximumLocalFluidVolumeFraction=0.,
            maximumMassDisplacement_kg=0.,maximumUniformPressureSensitivity_Pa=0.,maximumRecoveredMassResidual_kg=0.)
        for step in range(endSteps):
            t0=step*dt;t=(step+1)*dt;factor=1+b['sourcePulseFraction'] if pulse and t0<b['sourcePulse_s']-1e-10 else 1.
            old=record
            if step==0 or abs(t0-b['sourcePulse_s'])<1e-9:
                changed=read(y,factor)
                jump=float(max(abs(changed[5]-old[5])));maxSourceContinuity=max(maxSourceContinuity,jump)
                require('source event leaves state and wall heat continuous '+str((n,dt,pulse,t0)),jump<1e-6,
                    wallHeatJump_W=jump)
            def residual(trial):
                e,rates,en,_,_,_=read(trial,factor);prev=old[0]
                return np.r_[((e['mass']-prev['mass'])/dt-e['dM'])/M0,
                    ((e['energy']-prev['energy'])/dt-e['dU'])/P,e['hyd']/600000,
                    ((e['Tw']-prev['Tw'])/dt-e['dw'])*Cwall/P,
                    ((e['omega']-prev['omega'])/dt-e['domega'])*J/torque,
                    ((en-old[2])/dt-rates)/1000]
            y,res=solve(residual,y,'coupled handoff '+str((n,dt,pulse,t)))
            record=read(y,factor);e,rates,en,r,cur,heats=record
            # Shared wall heat cancels; source goes only into retained fuel.
            external=P*factor+sum(e['electrical'])-sum(e['ambient'])-sum(e['Qs'])
            ledger+=external*dt;solidLedger+=(P*factor-sum(heats))*dt
            rotorLoss+=.5*J*sum((e['omega']-old[0]['omega'])**2)
            stored=e['totalStored']+sum(en)*N-water0['totalStored']-solid0
            solidChange=sum(en)*N-solid0;peakSolid=max(peakSolid,abs(solidChange))
            maxMass=max(maxMass,abs(sum(e['mass'])-sum(water0['mass'])))
            maxEnergy=max(maxEnergy,abs(stored-ledger+rotorLoss));maxRaw=max(maxRaw,abs(stored-ledger))
            maxSolid=max(maxSolid,abs(solidChange-solidLedger))
            maxPE=max(maxPE,primary['g']*12*sum(abs(e['mass']-water0['mass'])))
            mech=mechanical(r,cur);po=(cur['p_MPa']+old[4]['p_MPa'])*.5*1e6
            work=po*(mech['outer']-priorMechanical['outer'])*N
            netWork+=sum(work);absWork+=sum(abs(work))
            absGas+=abs(mech['gasEnergy']-priorMechanical['gasEnergy'])*N
            absElastic+=abs(mech['elastic']-priorMechanical['elastic'])*N
            accumulated=absWork+absGas+absElastic;maxOmission=max(maxOmission,accumulated)
            if abs(solidChange)>1.:
                netTerms=abs(netWork)+abs(mech['gasEnergy']-initialMechanical['gasEnergy'])*N+abs(mech['elastic']-initialMechanical['elastic'])*N
                maxSampleOmission=max(maxSampleOmission,netTerms/abs(solidChange))
            priorMechanical=mech
            if abs(t*10-round(t*10))<1e-8 or step==endSteps-1:
                # Independent static sensitivity, NEVER added to the trajectory:
                # hold current fluid T and instantaneous rod geometry, reduce
                # water volume by actual rod displacement, restore total M by
                # one common pressure offset. No implied moving-volume solver.
                deltaV=(mech['outer']-initialMechanical['outer'])*N
                volumes=primary['V'].copy();volumes[2:4]-=deltaV
                if min(volumes)<=0:raise ValueError('Rod displacement exhausted a coolant volume')
                massTarget=sum(e['mass'])
                def displacedMass(dp):return sum(primary['properties'](e['p']+dp,e['T'])[0]*volumes)-massTarget
                pressureOffset=brentq(displacedMass,-.1,.1,xtol=1e-12)
                displacement['maximumTotalRodVolumeChange_m3']=max(displacement['maximumTotalRodVolumeChange_m3'],abs(float(sum(deltaV))))
                displacement['maximumLocalFluidVolumeFraction']=max(displacement['maximumLocalFluidVolumeFraction'],float(max(abs(deltaV/primary['V'][2:4]))))
                displacement['maximumMassDisplacement_kg']=max(displacement['maximumMassDisplacement_kg'],abs(float(sum(e['rho'][2:4]*deltaV))))
                displacement['maximumUniformPressureSensitivity_Pa']=max(displacement['maximumUniformPressureSensitivity_Pa'],abs(pressureOffset)*1e6)
                displacement['maximumRecoveredMassResidual_kg']=max(displacement['maximumRecoveredMassResidual_kg'],abs(float(displacedMass(pressureOffset))))
                sample=projection(t,record);sample['rodDisplacementPressureSensitivity_Pa']=pressureOffset*1e6
                samples.append(sample)
        require('native mass and retained energy '+str((n,dt,pulse,frozen)),maxMass<.001 and maxEnergy<10000 and maxRaw<10000 and maxSolid<10000,
            mass_kg=float(maxMass),energy_J=float(maxEnergy),rawEnergy_J=float(maxRaw),solid_J=float(maxSolid))
        require('displaced-water static mass inversion '+str((n,dt,pulse,frozen)),
            displacement['maximumRecoveredMassResidual_kg']<1e-5,**displacement)
        if not pulse:
            require('joined hold '+str(n),max(max(abs(np.array(s['p_MPa'])-water0['p'])) for s in samples)<1e-5 and
                max(max(abs(np.array(s['T_C'])-water0['T'])) for s in samples)<1e-4 and
                max(abs(record[3]-r0))<1e-6)
        pulseEnergy=P*b['sourcePulseFraction']*b['sourcePulse_s']
        if pulse:
            require('rescreen gas elastic and external work '+str((n,dt,frozen)),
                maxOmission/pulseEnergy<.001 and maxOmission/peakSolid<.001 and maxSampleOmission<.001,
                omission_J=float(maxOmission),toPulse=float(maxOmission/pulseEnergy),toPeakSolid=float(maxOmission/peakSolid),toSample=float(maxSampleOmission))
        return dict(step_s=dt,pulse=pulse,samples=samples,maximumMassError_kg=float(maxMass),maximumEnergyResidual_J=float(maxEnergy),
            maximumUncorrectedEnergyResidual_J=float(maxRaw),maximumSolidEnergyResidual_J=float(maxSolid),
            rotorNumericalDissipation_J=float(rotorLoss),omittedStoredPEChangeBound_J=float(maxPE),
            accumulatedAbsoluteGasElasticWorkOmission_J=float(maxOmission),maximumOmissionToSampleSolidRatio=float(maxSampleOmission),
            sourceEventWallHeatJump_W=float(maxSourceContinuity),coldLatticeVolumeSensitivity=displacement)
    runs=[run(dt,True) for dt in steps]
    originalEnergy=sum(row['fuelSensibleEnergy_J']+row['cladSensibleEnergy_J'] for row in d['fuel']['reference']['base']['rows'])
    return dict(intervals=n,frozenRadialBoundary=frozen,initialSolidProjectionDifference_J=float(solid0-originalEnergy),
        hold=run(b['holdStep_s'],False) if hold else None,runs=runs)
results=[experiment(n,b['steps_s'] if n==16 else [b['steps_s'][-1]]) for n in [8,16,32]]
frozen=experiment(16,[b['steps_s'][-1]],False,True)
def compare(a,c):
    lookup={round(s['t_s'],8):s for s in c['samples']};diff={k:0. for k in ['p_MPa','T_C','flow_kg_s','wall_C','rpm','radial_K','wallHeat_W']}
    for s in a['samples']:
        other=lookup[round(s['t_s'],8)]
        for key in ['p_MPa','T_C','flow_kg_s','wall_C','rpm','wallHeat_W']:diff[key]=max(diff[key],float(max(abs(np.array(s[key])-other[key]))))
        diff['radial_K']=max(diff['radial_K'],max(abs(x[k]-z[k]) for x,z in zip(s['radial'],other['radial']) for k in x))
    return diff
timeDifferences=[compare(a,c) for a,c in zip(results[1]['runs'][:-1],results[1]['runs'][1:])]
spaceDifferences=[compare(a['runs'][-1],c['runs'][-1]) for a,c in zip(results[:-1],results[1:])]
fine=timeDifferences[-1]
require('coupled temporal refinement',fine['p_MPa']<.001 and fine['T_C']<.01 and fine['flow_kg_s']<5 and fine['wall_C']<.01 and fine['rpm']<.1 and fine['radial_K']<.05,**fine)
require('coupled radial refinement',spaceDifferences[-1]['radial_K']<1.,**spaceDifferences[-1])
feedback=compare(results[1]['runs'][-1],frozen['runs'][0])
excursion={key:max(float(max(abs(np.array(s[key])-results[1]['runs'][-1]['samples'][0][key]))) for s in results[1]['runs'][-1]['samples']) for key in ['p_MPa','T_C','flow_kg_s','wallHeat_W']}
require('unclamped pressure response',excursion['p_MPa']>1e-5,excursion_MPa=excursion['p_MPa'])
print(json.dumps(dict(scope='offline quasistatic BOL radial heat coupled to sealed single-phase eleven-cell physical-core primary; h-only circuit mechanical approximation retained',
    packages=dict(python=platform.python_version(),numpy=np.__version__,scipy=scipy.__version__,iapws=iapws.__version__),
    results=results,frozenBoundaryComparison=frozen,temporalDifferences=timeDifferences,spatialDifferences=spaceDifferences,
    feedbackDifference=feedback,observedExcursion=excursion,checks=checks,cost_s=time.perf_counter()-start,
    liveRuntime=False,physicalFuelValidation=False,fullMechanicalEnergy=False),allow_nan=False))
`
export async function runFuelCircuit(initDoc:string,hydroDoc:string,cycleDoc:string,fuelDoc:string,transientDoc:string,bolJson:string,python:string){
  const physicalCore=parseConnectedFuel(initDoc,fuelDoc)
  const primary=await resolveInitializationInput(initDoc,hydroDoc,cycleDoc,python,physicalCore)
  const fuel=resolveFuelTransientInput(fuelDoc,transientDoc,bolJson,'quasistatic')
  const data={primary,fuel}
  const sourceSha256=hash(await Bun.file(import.meta.path).bytes())
  const child=Bun.spawn([python,'-c',fuelCircuitCalculation],{stdin:new Blob([JSON.stringify(data)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(status!==0)throw Error(err||'Fuel circuit reference failed')
  return {sourceSha256,calculationSha256:hash(fuelCircuitCalculation),inputSha256:hash(JSON.stringify(data)),
    bolArtifactSha256:hash(bolJson),...JSON.parse(out)}
}
if(import.meta.main){
  const files=Bun.argv.slice(2)
  if(files.length!==7)throw Error('Usage: bun reference-design-fuel-circuit.ts <initialization.md> <hydraulic.md> <cycle.md> <fuel.md> <transient.md> <BOL.json> <python>')
  const docs=await Promise.all(files.slice(0,6).map(path=>Bun.file(path).text()))
  console.log(JSON.stringify(await runFuelCircuit(docs[0]!,docs[1]!,docs[2]!,docs[3]!,docs[4]!,docs[5]!,files[6]!),null,2))
}
