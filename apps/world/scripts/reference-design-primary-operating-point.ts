/** Offline conservative steady primary: new geometry/physical faces, no time integrator or live plant. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { parseConnectedFuel, parseConnectedFuelSelection } from './reference-design-connected-fuel'
import { resolveInitializationInput } from './reference-design-initialization'
import { foldedGeometry, parsePrimaryMechanics } from './reference-design-primary-mechanics'
import { hydrostaticLiquidPython } from './reference-design-hydrostatic-liquid'

export function allocateMixingBudget(totalK: number, mixingK: number) {
  if (![totalK, mixingK].every(v => Number.isFinite(v) && v >= 0) || totalK < mixingK)
    throw Error('Total irreversible budget cannot contain its physical discharge mixing')
  return totalK - mixingK
}
export function parseOperatingPointSelection(text: string) {
  const blocks=[...text.matchAll(/^```reference-primary-operating-point\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-primary-operating-point block')
  return z.object({surgeTakeoffFraction:z.number().finite().min(0).max(1),
    lowerReferencePressure_MPaAbs:z.number().finite().positive()}).strict().parse(JSON.parse(blocks[0]![1]!))
}

export const primaryOperatingPointPython = hydrostaticLiquidPython + String.raw`
import json,sys,time,platform,scipy,CoolProp
from scipy.integrate import solve_ivp
from scipy.optimize import root
d=json.load(sys.stdin);b=d['primary'];geo=d['geometry'];fold=d['fold'];case=d['case']
c=b['cycle'];hy=b['hydraulics'];core=b['physicalCore'];g=hy['basis']['gravity_m_s2']
start=time.perf_counter();calls=dict(properties=0,forwardProperty=0,ode=0,shooting=0,nozzle=0)
maxRawEnthalpyError=0.;maxCorrectedEnthalpyError=0.
nozzleErrors=dict(entropy_J_kgK=0.,totalEnthalpy_J_kg=0.);nozzleStatuses={};auditActive=False;balanceChecks=[]
quadratureNodes,quadratureWeights=np.polynomial.legendre.leggauss(16)
fluid=CP.AbstractState('HEOS','Water');pAnchor=d['selection']['lowerReferencePressure_MPaAbs']*1e6
Mref=c['flows']['primary_kg_s'];Q=np.array([c['powers_MW']['core_cell1'],c['powers_MW']['core_cell2']])*1e6*case['heatFactor']
Qtotal=float(sum(Q));omega=hy['basis']['pumpRpm']*2*math.pi/60
rhoRef=c['points']['RCP_suction']['rho_kg_m3'];qRef=Mref/4/rhoRef
eRef=c['powers_MW']['RCP_fluid']*1e6/Mref;sigma=hy['basis']['pumpShapeFraction']
pumpA=eRef/((1-sigma)*omega**2);pumpB=sigma*pumpA*omega/qRef
pumpR=(rhoRef*eRef-hy['nominal_pump_head_Pa'])/(rhoRef*qRef*qRef)
if pumpR<0:raise ValueError('Negative pump internal dissipation')
Tsink=c['points']['main_steam']['T_C']+273.15
TsgRef=c['points']['RCP_suction']['T_C']+273.15;TwRef=(Tsink+TsgRef)/2
G=c['powers_MW']['SG_total']*1e6/2/(TsgRef-TwRef)
Ac=core['geometry']['flowArea_m2'];Ad=20/6;Ah=math.pi*geo['hotInsideDiameter_m']**2/4
As=25/geo['sgDevelopedLength_m'];Ap=math.pi*geo['pumpPassageInsideDiameter_m']**2/4
budgets=d['lossBudgets'];losses=d['residualLosses']
if min(budgets.values())<=0 or budgets['dc']<1 or budgets['pump']<1 or core['outletLoss']!=1:
    raise ValueError('Selected total budget cannot own its actual abrupt-discharge mixing')
rtol=case['rtol'];atol=np.array([.001,1e-5,1e-6,.01,.001,.001])
def ph(p,h):
    global maxRawEnthalpyError,maxCorrectedEnthalpyError
    calls['properties']+=1
    if not all(math.isfinite(v) for v in [p,h]) or p<=0:raise ValueError('Nonfinite physical face')
    fluid.update(CP.HmassP_INPUTS,h,p)
    if fluid.phase()!=CP.iphase_liquid:raise ValueError('Steady path left the stable liquid branch')
    maxRawEnthalpyError=max(maxRawEnthalpyError,abs(fluid.hmass()-h));T=fluid.T()
    for _ in range(8):
        fluid.update(CP.PT_INPUTS,p,T);calls['forwardProperty']+=1
        if fluid.phase()!=CP.iphase_liquid:raise ValueError('Enthalpy refinement left stable liquid')
        error=fluid.hmass()-h
        if abs(error)<=1e-7:break
        T-=error/fluid.cpmass()
    maxCorrectedEnthalpyError=max(maxCorrectedEnthalpyError,abs(error))
    if abs(error)>1e-7:raise ValueError('Forward enthalpy recovery exceeds 1e-7 J/kg')
    return dict(p=p,h=fluid.hmass(),rho=fluid.rhomass(),T=fluid.T(),u=fluid.umass(),s=fluid.smass(),mu=fluid.viscosity(),
        rp=fluid.first_partial_deriv(CP.iDmass,CP.iP,CP.iHmass),rh=fluid.first_partial_deriv(CP.iDmass,CP.iHmass,CP.iP))
def snapshot(y,m,A,z):
    q=ph(float(y[0]),float(y[1]));v=m/(q['rho']*A)
    return dict(p_Pa=q['p'],h_J_kg=q['h'],T_K=q['T'],rho_kg_m3=q['rho'],s_J_kgK=q['s'],
        velocity_m_s=v,z_m=z,totalEnthalpy_J_kg=q['h']+v*v/2+g*z)
def nozzle(y,m,Aold,zold,Anew,znew):
    calls['nozzle']+=1;q=ph(*y);vold=0 if Aold is None else m/(q['rho']*Aold)
    total=q['h']+vold*vold/2+g*zold;vnew=m/(q['rho']*Anew)
    guess=np.array([q['p']-q['rho']*(g*(znew-zold)+(vnew*vnew-vold*vold)/2),total-g*znew-vnew*vnew/2])
    def residual(x):
        w=ph(x[0]*1e7,x[1]*1e6);v=m/(w['rho']*Anew)
        return np.array([(w['s']-q['s'])/1000,(w['h']+v*v/2+g*znew-total)/1e6])
    sol=root(residual,guess/np.array([1e7,1e6]),options=dict(xtol=1e-10))
    rr=residual(sol.x)
    status=str(sol.status)+': '+str(sol.message);nozzleStatuses[status]=nozzleStatuses.get(status,0)+1
    if max(abs(rr))>1e-10:raise ValueError(dict(reason='Physical nozzle did not close',residual=rr.tolist()))
    nozzleErrors['entropy_J_kgK']=max(nozzleErrors['entropy_J_kgK'],abs(rr[0])*1000)
    nozzleErrors['totalEnthalpy_J_kg']=max(nozzleErrors['totalEnthalpy_J_kg'],abs(rr[1])*1e6)
    return sol.x*np.array([1e7,1e6])
def integrate(y,m,A,length,z,dz,heat=lambda s,q:0.,K=lambda s,q:0.,shaft=0.,mechanical=0.,store=True,label='form loss'):
    def rhs(s,x):
        calls['ode']+=1;q=ph(float(x[0]),float(x[1]));rho=q['rho'];v=m/(rho*A)
        drag=K(s,q)*rho*v*v/2;Hprime=heat(s,q)/m+shaft/length
        a=np.array([[1-v*v*q['rp'],-v*v*q['rh']],[-v*v/rho*q['rp'],1-v*v/rho*q['rh']]])
        dp,dh=np.linalg.solve(a,[rho*mechanical/length-rho*g*dz(s)-drag,Hprime-g*dz(s)])
        return [dp,dh,rho*A if store else 0.,rho*A*q['u'] if store else 0.,
            rho*A*v*v/2 if store else 0.,rho*A*g*z(s) if store else 0.]
    sol=solve_ivp(rhs,[0,length],np.r_[y,[0.,0.,0.,0.]],method='DOP853',rtol=rtol,atol=atol,dense_output=True)
    if not sol.success:raise ValueError(sol.message)
    if auditActive:
        integratedHeat=entropyHeat=0.
        for node,weight in zip(quadratureNodes,quadratureWeights):
            s=(node+1)*length/2;q=ph(*sol.sol(s)[:2]);w=weight*length/2
            dq=heat(s,q)*w;integratedHeat+=dq;entropyHeat+=dq/(m*q['T'])
        first=snapshot(y,m,A,z(0));last=snapshot(sol.y[:2,-1],m,A,z(length))
        powerError=m*(last['totalEnthalpy_J_kg']-first['totalEnthalpy_J_kg'])-integratedHeat-m*shaft
        sgen=last['s_J_kgK']-first['s_J_kgK']-entropyHeat
        balanceChecks.append(dict(owner=label,massflow_kg_s=m,length_m=length,heat_W=integratedHeat,
            shaft_W=m*shaft,streamEnergyResidual_W=powerError,entropyGeneration_J_kgK=sgen))
        if abs(powerError)>10 or sgen < -1e-6:raise ValueError('Independent channel energy/entropy check failed')
    return sol
def jump(y,m,A,z,k):
    return integrate(y,m,A,1,lambda s:z,lambda s:0,K=lambda s,q:k(q),store=False).y[:2,-1]
def mixed(y,m,A,z,shape):
    incoming=ph(*y);v=m/(incoming['rho']*A);h=incoming['h']+v*v/2
    bulk=ph(y[0],h)
    if bulk['s']<incoming['s']-1e-7:raise ValueError('Abrupt mixing reduced entropy')
    return np.array([bulk['p'],bulk['h']]),dict(entropyRise_J_kgK=bulk['s']-incoming['s'],
        incomingKinetic_J_kg=v*v/2,shape=shape,reference_m=z)
def path(x,record=False):
    global auditActive,balanceChecks
    auditActive=record;balanceChecks=[]
    calls['shooting']+=1;m=x[0]*Mref;h0=x[1]*1e6;Tw=x[2]*300
    if m<=0 or not Tsink<Tw:raise ValueError('Candidate requires positive flow and SG approach')
    y=np.array([pAnchor,h0]);origin=ph(*y);owners=[];faces=[];mixing=[];coreEnds=[];hotTap=None
    def keep(name,sol,massflow,area,zfun,mult=1):
        if record:
            end=sol.y[:2,-1];native=sol.y[2:,-1]
            owners.append(dict(owner=name,multiplicity=mult,V_m3=area*sol.t[-1],M_kg=float(native[0]),U_J=float(native[1]),K_J=float(native[2]),PE_J=float(native[3])))
            faces.append(dict(owner=name,**snapshot(end,massflow,area,zfun(sol.t[-1]))))
    y=nozzle(y,m,None,-2,Ac,-2);y=jump(y,m,Ac,-2,lambda q:core['inletLoss'])
    coreEnds.append(snapshot(y,m,Ac,-2))
    positions=[0.]+d['gridPositions_m']+[core['activeLength_m']/2,core['activeLength_m']]
    positions=sorted(set(positions));coreAccum=np.zeros(4)
    for left,right in zip(positions[:-1],positions[1:]):
        half=0 if left<core['activeLength_m']/2 else 1;length=right-left
        def krod(s,q):
            Re=abs(m/Ac)*core['geometry']['hydraulicDiameter_m']/q['mu']
            f=max(64/Re,1.691*Re**(-.43),.117*Re**(-.14))
            return f/core['geometry']['hydraulicDiameter_m']
        sol=integrate(y,m,Ac,length,lambda s:s+left-2,lambda s:1,
            heat=lambda s,q:Q[half]/(core['activeLength_m']/2),K=krod,label='CORE.'+str(half+1))
        y=sol.y[:2,-1];coreAccum+=sol.y[2:,-1]
        if right in d['gridPositions_m']:
            y=jump(y,m,Ac,right-2,lambda q:min(20.,196*(abs(m/Ac)*core['geometry']['hydraulicDiameter_m']/q['mu'])**(-.333))*core['gridLossFactor']*core['blockageFraction']**2)
        if right in [core['activeLength_m']/2,core['activeLength_m']]:
            coreEnds.append(snapshot(y,m,Ac,right-2))
            if record:owners.append(dict(owner='CORE.'+str(half+1),multiplicity=1,V_m3=Ac*core['activeLength_m']/2,M_kg=float(coreAccum[0]),U_J=float(coreAccum[1]),K_J=float(coreAccum[2]),PE_J=float(coreAccum[3])))
            coreAccum[:]=0
    y,info=mixed(y,m,Ac,2,dict(area=16.75,bottom=2,top=4));mixing.append(dict(owner='UPPER',**info,p=y[0],h=y[1],multiplicity=1))
    y=nozzle(y,m/2,None,2,Ah,2.5);L=15/Ah
    sol=integrate(y,m/2,Ah,L,lambda s:2.5,lambda s:0,K=lambda s,q:losses['hot']/L,label='HOT.A/B')
    takeoff=L*d['selection']['surgeTakeoffFraction']
    hotTap=dict(axialDistance_m=takeoff,axialFraction=d['selection']['surgeTakeoffFraction'],**snapshot(sol.sol(takeoff)[:2],m/2,Ah,2.5))
    keep('HOT.A/B',sol,m/2,Ah,lambda s:2.5,2);y=sol.y[:2,-1]
    y=nozzle(y,m/2,Ah,2.5,As,2.5)
    ru=fold['riseLength_m'];ra=fold['radius_m'];arc=fold['crownLength_m'];Ls=geo['sgDevelopedLength_m']
    def zsg(s):
        if s<=ru:return 2.5+s
        if s<=ru+arc:return 12-ra+ra*math.sin((s-ru)/ra)
        return 12-ra-(s-ru-arc)
    def dzsg(s):return 1. if s<ru else math.cos((s-ru)/ra) if s<ru+arc else -1.
    sgStart=snapshot(y,m/2,As,2.5);sgNative=np.zeros(4);sgApproach=[]
    for left,right in [(0,ru),(ru,ru+arc),(ru+arc,Ls)]:
        sol=integrate(y,m/2,As,right-left,lambda s:zsg(s+left),lambda s:dzsg(s+left),
            heat=lambda s,q:-G/Ls*(q['T']-Tw),K=lambda s,q:losses['sg']/Ls,label='SG.A/B.PRIMARY')
        for j in range(sol.y.shape[1]):sgApproach.append(ph(sol.y[0,j],sol.y[1,j])['T']-Tw)
        y=sol.y[:2,-1];sgNative+=sol.y[2:,-1]
    sgEnd=snapshot(y,m/2,As,3);Qsg=m/2*(sgStart['totalEnthalpy_J_kg']-sgEnd['totalEnthalpy_J_kg'])
    if min(sgApproach)<=0:raise ValueError('SG fluid/wall approach reversed')
    if record:
        owners.append(dict(owner='SG.A/B.PRIMARY',multiplicity=2,V_m3=As*Ls,M_kg=float(sgNative[0]),U_J=float(sgNative[1]),K_J=float(sgNative[2]),PE_J=float(sgNative[3])))
        faces.append(dict(owner='SG.A/B.PRIMARY',**sgEnd))
    y=nozzle(y,m/4,As/2,3,Ap,3);suction=ph(*y);q=m/4/suction['rho'];e=pumpA*omega**2-pumpB*omega*q;mech=e-pumpR*q*q
    if e<=0 or mech<=0 or abs(q/qRef)>1.5:raise ValueError('Outside admitted positive motoring/flow comparison')
    Lp=geo['pumpPassageVolume_m3']/Ap
    sol=integrate(y,m/4,Ap,Lp,lambda s:3,lambda s:0,K=lambda s,q:losses['pump']/Lp,shaft=e,mechanical=mech,label='P.A1/A2/B1/B2.PASSAGE')
    keep('P.A1/A2/B1/B2.PASSAGE',sol,m/4,Ap,lambda s:3,4);y=sol.y[:2,-1]
    y,info=mixed(y,m/4,Ap,3,dict(area=geo['coldHeaderVolume_m3']/geo['coldHeaderHeight_m'],bottom=3-geo['coldHeaderHeight_m']/2,top=3+geo['coldHeaderHeight_m']/2))
    mixing.append(dict(owner='COLD.A/B',**info,p=y[0],h=y[1],multiplicity=2))
    y=nozzle(y,m,None,3,Ad,3)
    sol=integrate(y,m,Ad,6,lambda s:3-s,lambda s:-1,K=lambda s,q:losses['dc']/6,label='DOWNCOMER')
    keep('DOWNCOMER',sol,m,Ad,lambda s:3-s);y=sol.y[:2,-1]
    y,info=mixed(y,m,Ad,-3,dict(area=14.25,bottom=-4,top=-2));mixing.append(dict(owner='LOWER',**info,p=y[0],h=y[1],multiplicity=1))
    # Native lower hydrostatic owner supplies the real upper core-inlet reference plane.
    lower=make_liquid_reservoir(14.25,-4,-2,-3,g)['forward'](y[0],ph(*y)['s']);returned=lower['at'](-2)
    residual=np.array([(returned['p']-pAnchor)/1e6,(returned['h']-h0)*m/Qtotal,(Qsg-G*(Tw-Tsink))/Qtotal])
    if not record:return residual
    for item in mixing:
        shape=item['shape'];bulk=ph(item['p'],item['h'])
        rr=make_liquid_reservoir(shape['area'],shape['bottom'],shape['top'],item['reference_m'],g)['forward'](item['p'],bulk['s'])
        owners.append(dict(owner=item['owner'],multiplicity=item['multiplicity'],M_kg=rr['M'],U_J=rr['U'],K_J=0.,PE_J=rr['PE'],V_m3=rr['V'],initialHeadResidual_Pa=rr['initialHeadResidual_Pa']))
    totals={key:sum(o[key]*o['multiplicity'] for o in owners) for key in ['V_m3','M_kg','U_J','K_J','PE_J']}
    if abs(totals['V_m3']-sum(b['basis']['volumes_m3']))>1e-9:raise ValueError('Main water geometry duplicated or lost')
    drag=c['basis']['RCPDragFraction']*eRef*Mref
    motorShaft=m*e+drag;motorLimit=1.5*(eRef*Mref+drag)
    if motorShaft>motorLimit:raise ValueError('Selected supported motor torque capacity exceeded')
    QsgIndependent=-sum(v['heat_W'] for v in balanceChecks if v['owner']=='SG.A/B.PRIMARY')
    independentPowerError=Qtotal+m*e-2*QsgIndependent
    if abs(independentPowerError)>10:raise ValueError('Independent full-loop heat/shaft quadrature balance failed')
    inertia=(eRef*Mref/4+drag/4)*b['basis']['inertiaDecay_s']/omega**2
    return dict(residual=residual.tolist(),coreFlow_kg_s=m,coreFaces=coreEnds,hotTap=hotTap,faces=faces,owners=owners,totals=totals,
        sourceHeat_W=Qtotal,sourceHalfHeat_W=Q.tolist(),perSGHeat_W=Qsg,wallTemperature_K=Tw,secondaryTemperature_K=Tsink,
        minimumSGFluidWallApproach_K=min(sgApproach),wallSecondaryApproach_K=Tw-Tsink,
        shaftToFluid_W=m*e,pumpSpecificWork_J_kg=e,pumpInternalDissipation_W=m*pumpR*q*q,
        supportedMotorShaft_W=motorShaft,supportedMotorLimit_W=motorLimit,motorLimitFraction=motorShaft/motorLimit,
        electricalInput_W=motorShaft/c['basis']['RCPMotorEfficiency'],mechanicalDrag_W=drag,
        rotorEnergy_J=4*.5*inertia*omega**2,perSGWallEnergyAboveZeroC_J=b['basis']['metalCapacity_MJ_K']*1e6*(Tw-273.15),
        independentSGHeat_W=QsgIndependent,independentExternalEnergyResidual_W=independentPowerError,channelBalances=balanceChecks,
        pressureResidual_Pa=returned['p']-pAnchor,loopEnergyResidual_W=(returned['h']-h0)*m,
        SGWallResidual_W=Qsg-G*(Tw-Tsink),externalEnergyResidual_W=Qtotal+m*e-2*Qsg,
        mixing=mixing,nominalOnly=True)

guess=np.array(case['guess']);solution=root(path,guess,options=dict(xtol=1e-9))
result=path(solution.x,True)
passed=bool(abs(result['pressureResidual_Pa'])<1 and abs(result['loopEnergyResidual_W'])<10 and abs(result['SGWallResidual_W'])<10 and abs(result['externalEnergyResidual_W'])<10)
print(json.dumps(dict(case=case,solution=solution.x.tolist(),solverSuccess=bool(solution.success),solverStatus=str(solution.message),accepted=passed,
    budgets=budgets,residualLosses=losses,SGConductance_W_K=G,result=result,calls=calls,
    rawEnthalpyInverseMaxError_J_kg=maxRawEnthalpyError,correctedEnthalpyMaxError_J_kg=maxCorrectedEnthalpyError,
    nozzleResidualMaxima=nozzleErrors,nozzleSolverStatuses=nozzleStatuses,
    scope='Symmetric steady full primary with imposed physical thermal duty, external secondary/electrical boundaries; no source dynamics or PZR response',
    dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__,numpy=np.__version__),
    wallSeconds=time.perf_counter()-start),allow_nan=False))
`

export async function runPrimaryOperatingPoint(wiki: string, python: string, caseName: string) {
  const names = ['nominal','alternate','refined','higher-duty']
  if (!names.includes(caseName)) throw Error('Unknown frozen operating-point case')
  const paths = ['model/connected-primary-initialization.md','model/primary-hydraulic-basis.md',
    'systems/steam-power/cycle-basis.md','systems/reactor/fuel-construction.md','systems/primary-coolant/mechanical-energy-and-geometry.md']
  const docs = await Promise.all(paths.map(p => Bun.file(join(wiki,p)).text()))
  const primary = await resolveInitializationInput(docs[0]!,docs[1]!,docs[2]!,python,parseConnectedFuel(docs[0]!,docs[3]!))
  const geometry = parsePrimaryMechanics(docs[4]!), grids = parseConnectedFuelSelection(docs[0]!).gridPositions_m
  const flow=primary.cycle.flows.primary_kg_s,points=primary.cycle.points
  const K=(name:string,m:number,rho:number,area:number)=>primary.hydraulics.friction_Pa[name]/(m*m/(2*rho*area*area))
  const lossBudgets={dc:K('cold_to_core',flow,points.core_inlet.rho_kg_m3,20/6),
    hot:K('hot',flow/2,points.core_outlet.rho_kg_m3,Math.PI*geometry.hotInsideDiameter_m**2/4),
    sg:K('SG',flow/2,points.RCP_suction.rho_kg_m3,25/geometry.sgDevelopedLength_m),
    pump:K('pump_outlet',flow/4,points.RCP_suction.rho_kg_m3,Math.PI*geometry.pumpPassageInsideDiameter_m**2/4)}
  const residualLosses={dc:allocateMixingBudget(lossBudgets.dc,1),hot:allocateMixingBudget(lossBudgets.hot,0),
    sg:allocateMixingBudget(lossBudgets.sg,0),pump:allocateMixingBudget(lossBudgets.pump,1)}
  const input = {primary,geometry,lossBudgets,residualLosses,selection:parseOperatingPointSelection(docs[4]!),gridPositions_m:grids,
    fold:foldedGeometry(geometry.sgDevelopedLength_m,primary.hydraulics.basis.hotPort_m,primary.hydraulics.basis.SGturn_m,primary.hydraulics.basis.coldPort_m),
    case:{name:caseName,heatFactor:caseName==='higher-duty'?1.01:1,rtol:caseName==='refined'?2e-11:2e-10,
      guess:caseName==='alternate'?[.9,1.27,1.86]:[1.05,1.30,1.86]}}
  const hash = (s:string) => createHash('sha256').update(s).digest('hex')
  const identity = {sourceSha256:hash(await Bun.file(import.meta.path).text()),calculationSha256:hash(primaryOperatingPointPython),inputSha256:hash(JSON.stringify(input))}
  const process = Bun.spawn([python,'-c',primaryOperatingPointPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code] = await Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited])
  if(code!==0) return {...identity,case:input.case,accepted:false,failure:err}
  return {...identity,...JSON.parse(out)}
}
if(import.meta.main){
  const [wiki,python,caseName,...extra]=Bun.argv.slice(2)
  if(!wiki||!python||!caseName||extra.length)throw Error('Usage: primary-operating-point.ts <LD-01-directory> <research-python> <case>')
  console.log(JSON.stringify(await runPrimaryOperatingPoint(wiki,python,caseName),null,2))
}
