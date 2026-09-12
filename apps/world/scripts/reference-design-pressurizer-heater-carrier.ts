/** Offline normal heater carrier adoption test. No live plant or maintained bath. */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {hydrostaticLiquidPython} from './reference-design-hydrostatic-liquid'
import {primaryTeeLiquidPython} from './reference-design-primary-tee-liquid'
import {normalThermalPython} from './reference-design-pressurizer-normal-thermal'
import {normalPhasePython,parseNormalPhase} from './reference-design-pressurizer-normal-phase'
import {assertDeliveryArea,parseNormalDelivery} from './reference-design-pressurizer-normal-delivery'
import {parsePressurizerBasis} from './reference-design-pressurizer'

export function assertCarrierGeometry(delivery:ReturnType<typeof parseNormalDelivery>,heater:ReturnType<typeof parseNormalPhase>,pzr:ReturnType<typeof parsePressurizerBasis>) {
  assertDeliveryArea(delivery,pzr.area_m2)
  if(delivery.circulationLossCoefficient<1)throw Error('Total carrier loss must include discharge mixing')
  if(heater.heaterLength_m>pzr.liquidVolume_m3/pzr.area_m2)throw Error('Normal bank cannot extend above selected liquid')
}
export function assertCarrierParents(thermal:{calculationSha256?:string},phase:{calculationSha256?:string,thermalReceiptSha256?:string},thermalBytes:string) {
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  if(thermal.calculationSha256!==hash(normalThermalPython)||phase.calculationSha256!==hash(normalPhasePython)||phase.thermalReceiptSha256!==hash(thermalBytes))throw Error('Exact normal/phase parent identities required')
}

export const heaterCarrierPython=hydrostaticLiquidPython+String.raw`
import json,sys,time,hashlib,platform
import scipy,CoolProp
from scipy.optimize import brentq
d=json.load(sys.stdin);start=time.perf_counter();b=d['thermal']['cases'][0];cfg=d['pzr'];sel=d['delivery'];heater=d['heater']
g=9.80665;A=sel['upflowArea_m2'];Ar=sel['returnArea_m2'];L=cfg['liquidVolume_m3']/(A+Ar)
z0=b['pressureTapElevation_m']-cfg['volume_m3']/(A+Ar);zt=z0+L;K=sel['circulationLossCoefficient'];D=sel['bubbleDiameter_m']
mainFluid=CP.AbstractState('HEOS','Water')
`+primaryTeeLiquidPython+String.raw`
_base_ph=ph;_base_ps=liquid_ps_si
def ph(p,h):
    if not h<CP.PropsSI('H','P',p,'Q',0,'Water'):raise ValueError('Liquid face target is not below saturation')
    mainFluid.specify_phase(CP.iphase_liquid)
    try:q=_base_ph(p,h)
    finally:mainFluid.unspecify_phase()
    if not q['T']<CP.PropsSI('T','P',p,'Q',0,'Water'):raise ValueError('Recovered liquid face crosses saturation')
    return q
def liquid_ps_si(p,s):
    if not s<CP.PropsSI('S','P',p,'Q',0,'Water'):raise ValueError('Liquid reservoir target is not below saturation')
    _hydrostatic_water.specify_phase(CP.iphase_liquid)
    try:q=_base_ps(p,s)
    finally:_hydrostatic_water.unspecify_phase()
    if not q['T']<CP.PropsSI('T','P',p,'Q',0,'Water'):raise ValueError('Recovered liquid reservoir crosses saturation')
    return q
def saturation(p):
    return dict(hf=CP.PropsSI('H','P',p,'Q',0,'Water'),hg=CP.PropsSI('H','P',p,'Q',1,'Water'),
        rl=CP.PropsSI('D','P',p,'Q',0,'Water'),rg=CP.PropsSI('D','P',p,'Q',1,'Water'),
        T=CP.PropsSI('T','P',p,'Q',0,'Water'),mu=CP.PropsSI('V','P',p,'Q',0,'Water'),sigma=CP.PropsSI('I','P',p,'Q',0,'Water'))

def bounded_return(p,s,knownTop=None):
    # The previously selected exactly saturated upper endpoint is not an invalid liquid-side trial.
    ps=brentq(lambda pp:CP.PropsSI('S','P',pp,'Q',0,'Water')-s,1e6,22e6,xtol=1e-5)
    sat=dict(p=ps,s=CP.PropsSI('S','P',ps,'Q',0,'Water'),T=CP.PropsSI('T','P',ps,'Q',0,'Water'),
        rho=CP.PropsSI('D','P',ps,'Q',0,'Water'),h=CP.PropsSI('H','P',ps,'Q',0,'Water'),u=CP.PropsSI('U','P',ps,'Q',0,'Water'))
    base=liquid_ps_si(p,s);H=base['h']+g*z0
    def at(z):
        target=H-g*z
        if z==zt and knownTop is not None:
            pp=knownTop;qq=dict(p=pp,s=CP.PropsSI('S','P',pp,'Q',0,'Water'),T=CP.PropsSI('T','P',pp,'Q',0,'Water'),
                rho=CP.PropsSI('D','P',pp,'Q',0,'Water'),h=CP.PropsSI('H','P',pp,'Q',0,'Water'),u=CP.PropsSI('U','P',pp,'Q',0,'Water'))
            if abs(qq['h']-target)*qq['rho']>.001 or abs(qq['s']-s)>1e-8:raise ValueError('Known saturated endpoint does not match native hydrostatic input')
            return qq
        if target<sat['h']:raise ValueError('Actual return hydrostatic target crosses saturated-liquid endpoint')
        pp=brentq(lambda pp:(sat if pp==ps else liquid_ps_si(pp,s))['h']-target,ps,p,xtol=1e-5)
        return sat if pp==ps else liquid_ps_si(pp,s)
    gx,gw=np.polynomial.legendre.leggauss(16);zs=z0+(gx+1)*L/2;weights=gw*Ar*L/2;states=[at(float(z)) for z in zs]
    M=sum(w*q['rho'] for w,q in zip(weights,states));U=sum(w*q['rho']*q['u'] for w,q in zip(weights,states))
    PE=sum(w*q['rho']*g*z for w,z,q in zip(weights,zs,states))
    return dict(M=M,U=U,PE=PE,E=U+PE,V=Ar*L,bottom=base,top=at(zt))

def phase_face(p,H,z,m,slipFactor):
    s=saturation(p);G=m/A;target=H-g*z
    if target<s['hf']+.5*(G/s['rl'])**2:
        h=target
        for _ in range(8):
            q=ph(p,h);v=G/q['rho'];error=q['h']+v*v/2-target
            if abs(error)<1e-7:break
            h-=error
        if abs(error)>1e-7:raise ValueError('Liquid total-enthalpy recovery')
        return dict(p=p,H=q['h']+v*v/2+g*z,h=q['h'],T=q['T'],x=0.,alpha=0.,rho=q['rho'],
            vl=v,vg=v,Pi=G*v,U=q['rho']*q['h']-p,K=.5*q['rho']*v*v,
            sl=q['s'],sg=q['s'],hl=q['h'],hg=q['h'],Re=0.,We=0.)
    radius=D/2;volume=4*math.pi*radius**3/3
    v0=brentq(lambda v:6*math.pi*s['mu']*radius*v*(1+.15*(s['rl']*v*D/s['mu'])**.687)-(s['rl']-s['rg'])*volume*g,0.,2.)
    slip=slipFactor*v0
    def mix(x):
        a=G*x/s['rg'];bb=G*(1-x)/s['rl'];term=a+bb+slip
        alpha=2*a/(term+math.sqrt(term*term-4*slip*a)) if x else 0.
        vl=bb/(1-alpha);vg=vl+slip
        hh=(1-x)*(s['hf']+vl*vl/2)+x*(s['hg']+vg*vg/2)
        return hh,alpha,vl,vg
    f0=mix(0.)[0]-target;f1=mix(.2)[0]-target
    if f0*f1>0:raise ValueError(dict(root='two-phase totalH quality',p=p,H=H,z=z,m=m,lo=0.,hi=.2,flo=f0,fhi=f1))
    x=brentq(lambda x:mix(x)[0]-target,0.,.2,xtol=1e-13);hh,alpha,vl,vg=mix(x)
    if not 0<=alpha<.3:raise ValueError('Dilute carrier void domain exceeded')
    rho=(1-alpha)*s['rl']+alpha*s['rg']
    return dict(p=p,H=hh+g*z,h=(1-x)*s['hf']+x*s['hg'],T=s['T'],x=x,alpha=alpha,rho=rho,
        vl=vl,vg=vg,Pi=(1-alpha)*s['rl']*vl*vl+alpha*s['rg']*vg*vg,
        U=(1-alpha)*s['rl']*s['hf']+alpha*s['rg']*s['hg']-p,
        K=.5*((1-alpha)*s['rl']*vl*vl+alpha*s['rg']*vg*vg),
        sl=CP.PropsSI('S','P',p,'Q',0,'Water'),sg=CP.PropsSI('S','P',p,'Q',1,'Water'),hl=s['hf'],hg=s['hg'],
        Re=s['rl']*slip*D/s['mu'],We=s['rl']*slip*slip*D/s['sigma'])

def carrier(name,duty,n=16,cold=0.,slip=1.,supported=True):
    global stage,partial
    partial={}
    stage='initial return reconstruction'
    # Each cold input is a separately identified finite state, never a reset of an advancing run.
    base=ph(b['bottom']['p']*1e6,b['bottom']['h']);seed=liquid_pt_si(base['p'],base['T']-cold)
    r=bounded_return(seed['p'],seed['s'],b['ps']*1e6 if cold==0 else None)
    bottom=r['bottom'];top=r['top'];heat=duty if supported else 0.
    if not 0<=heat<=heater['normalBankCapacity_W']:raise ValueError('Normal bank capacity exceeded')
    if K<1:raise ValueError('Total loss budget cannot pay selected discharge mixing')
    if heat==0:return dict(name=name,supported=supported,heatToFluid_W=0.,newHeatDrivenCirculation_kg_s=0.,
        phaseGeneratedByThisSteadyCut_kg_s=0.,scope='Resting no-heat boundary only; not instantaneous stop of stored heat or prior motion')
    H0=bottom['h']+g*z0;dz=L/n;last=[];momentum=[]
    entrySatP=brentq(lambda pp:CP.PropsSI('S','P',pp,'Q',0,'Water')-bottom['s'],1e6,bottom['p'],xtol=1e-5)
    entrySat=saturation(entrySatP)
    def trajectory(m,retain=False):
        # Isentropic reservoir-to-channel acceleration; remaining loss is nonnegative.
        def nozzle(p):
            q=dict(h=entrySat['hf'],rho=entrySat['rl']) if p==entrySatP else liquid_ps_si(p,bottom['s'])
            return q['h']+.5*(m/(A*q['rho']))**2+g*z0-H0
        flo=nozzle(entrySatP);fhi=nozzle(bottom['p'])
        if flo*fhi>0:raise ValueError(dict(root='liquid isentropic entry totalH',m=m,lo=entrySatP,hi=bottom['p'],flo=flo,fhi=fhi))
        pin=brentq(nozzle,entrySatP,bottom['p'],xtol=1e-5)
        q=phase_face(pin,H0,z0,m,slip);rows=[q];errors=[]
        for i in range(n):
            za=z0+i*dz;zb=za+dz;H=H0+heat/m*min((zb-z0)/heater['heaterLength_m'],1.)
            def residual(p):
                v=phase_face(p,H,zb,m,slip)
                loss=(K-1)/n*.25*(m/A)**2*(1/q['rho']+1/v['rho'])
                return p+v['Pi']-q['p']-q['Pi']+g*dz*(q['rho']+v['rho'])/2+loss
            flo=residual(q['p']-100000);fhi=residual(q['p']+100000)
            if flo*fhi>0:raise ValueError(dict(root='cell momentum',m=m,cell=i,lo=q['p']-100000,hi=q['p']+100000,flo=flo,fhi=fhi))
            pp=brentq(residual,q['p']-100000,q['p']+100000,xtol=1e-5)
            errors.append(residual(pp));q=phase_face(pp,H,zb,m,slip);rows.append(q)
        if retain:return rows,errors
        return q['p']-top['p']
    stage='hydraulic carrier root'
    flo=trajectory(2.);fhi=trajectory(300.)
    if flo*fhi>0:raise ValueError(dict(root='whole carrier head',lo=2.,hi=300.,flo=flo,fhi=fhi))
    m=brentq(trajectory,2.,300.,xtol=1e-8);rows,momentum=trajectory(m,True);out=rows[-1]
    # Constant-area trapezoid storage and phase transit are independent of the face enthalpy ledger.
    def integrate(key):return A*dz*sum((x[key]+y[key])/2 for x,y in zip(rows,rows[1:]))
    M=integrate('rho');U=integrate('U');KE=integrate('K');void=integrate('alpha')
    PE=A*g*dz*sum(((z0+i*dz)*x['rho']+(z0+(i+1)*dz)*y['rho'])/2 for i,(x,y) in enumerate(zip(rows,rows[1:])))
    liquidTime=dz*sum((1/x['vl']+1/y['vl'])/2 for x,y in zip(rows,rows[1:]))
    vaporTime=dz*sum((1/x['vg']+1/y['vg'])/2 for x,y in zip(rows,rows[1:]))
    actualVaporRegionTime=dz*sum((1/x['vg']+1/y['vg'])/2 for x,y in zip(rows,rows[1:]) if x['alpha']>0 and y['alpha']>0)
    mv=m*out['x'];ml=m-mv;returnVelocity=ml/(top['rho']*Ar)
    vaporH=out['hg']+.5*out['vg']**2+g*zt;liquidH=out['hl']+.5*out['vl']**2+g*zt
    returnMdot=ml-m;returnEdot=ml*liquidH-m*H0;upperMdot=mv;upperEdot=mv*vaporH
    balance=returnEdot+upperEdot-heat
    partial=dict(massFlow_kg_s=m,surfaceVaporDelivery_kg_s=mv,returnMassRate_kg_s=returnMdot,
        returnEnergyRate_W=returnEdot,upperEnergyRate_W=upperEdot,wholeCutEnergyResidual_W=balance,
        channelEnergyResidual_W=m*(out['H']-rows[0]['H'])-heat,
        momentumBoundaryResidual_Pa=out['p']-top['p'],maximumVoidFraction=max(x['alpha'] for x in rows),
        upflowVolume_m3=A*L,vaporVoid_m3=void,profiles=rows)
    # Independent native differential recovery: do not confuse U/M with flowing h.
    stage='finite return rate tangent'
    # One-sided native derivatives remain on the liquid side; an outward requested tangent is reported, not flashed.
    def tangent(dp,ds):
        rp=bounded_return(seed['p']+dp,seed['s']);rs=bounded_return(seed['p'],seed['s']-ds)
        J=np.array([[(rp['M']-r['M'])/dp,(r['M']-rs['M'])/ds],[(rp['E']-r['E'])/dp,(r['E']-rs['E'])/ds]])
        rates=np.linalg.solve(J,np.array([returnMdot,returnEdot]))
        Trate=(rp['bottom']['T']-bottom['T'])/dp*rates[0]+(bottom['T']-rs['bottom']['T'])/ds*rates[1]
        # Margin Htop-hf at fixed entropy saturation pressure; negative means no all-liquid fixed-envelope profile.
        def margin(q,entropy):
            pp=brentq(lambda pp:CP.PropsSI('S','P',pp,'Q',0,'Water')-entropy,1e6,22e6,xtol=1e-5)
            return q['bottom']['h']-g*L-CP.PropsSI('H','P',pp,'Q',0,'Water')
        m0=margin(r,seed['s']);mrate=(margin(rp,seed['s'])-m0)/dp*rates[0]+(m0-margin(rs,seed['s']-ds))/ds*rates[1]
        return rates,Trate,mrate,J@rates-np.array([returnMdot,returnEdot])
    tangentFailure=None
    try:
        rates,dTdt,marginRate,nativeResidual=tangent(100.,.001);fineRates,fineT,fineMargin,_=tangent(50.,.0005);dpdt=float(rates[0])
        tangentAvailable=True
    except (ValueError,RuntimeError) as error:
        tangentAvailable=False;tangentFailure=str(error);dTdt=None;dpdt=None;marginRate=None;fineT=None;fineMargin=None;fineRates=[None,None];nativeResidual=[None,None]
    sub=saturation(bottom['p'])['T']-bottom['T'];drift=dTdt*liquidTime if tangentAvailable else None
    sat=saturation(bottom['p']);mu=CP.PropsSI('V','P',bottom['p'],'T|liquid',bottom['T'],'Water')
    k=CP.PropsSI('L','P',bottom['p'],'T|liquid',bottom['T'],'Water');cp=CP.PropsSI('C','P',bottom['p'],'T|liquid',bottom['T'],'Water')
    radius=D/2;vol=4*math.pi*radius**3/3
    vb=brentq(lambda v:6*math.pi*mu*radius*v*(1+.15*(bottom['rho']*v*D/mu)**.687)-(bottom['rho']-sat['rg'])*vol*g,0.,2.)
    Re=bottom['rho']*vb*D/mu;Nu=2+.6*math.sqrt(Re)*(cp*mu/k)**(1/3)
    cond=4*math.pi*radius**2*(Nu*k/D)*sub/(sat['hg']-sat['hf']);clock=sat['rg']*vol/cond
    power=abs(m*(out['H']-rows[0]['H'])-heat);head=abs(out['p']-top['p'])
    returnHead=.5*top['rho']*returnVelocity**2;returnKpower=ml*returnVelocity**2/2
    dragPass=all(x['Re']<=1000 and x['We']<=1 for x in rows)
    relaxation=clock/vaporTime;driftPass=bool(tangentAvailable and sub>0 and abs(drift)<=.1*sub)
    liquidTangentAdmitted=bool(tangentAvailable and (cold>0 or marginRate>=0))
    physical=bool(head<=1 and max(abs(x) for x in momentum)<=1 and power<=10 and abs(balance)<=10)
    return dict(name=name,heatToFluid_W=heat,n=n,coldOffset_K=cold,slipFactor=slip,massFlow_kg_s=m,
        momentumBoundaryResidual_Pa=head,maxCellMomentumResidual_Pa=max(abs(x) for x in momentum),
        channelEnergyResidual_W=power,wholeCutEnergyResidual_W=balance,
        cutAccountingAdmission=physical,dragDomainAdmission=dragPass,
        returnHeadOmissionAdmission=bool(returnHead<=1 and returnKpower<=10),returnDriftAdmission=driftPass,
        returnTangentAvailable=tangentAvailable,returnTangentFailure=tangentFailure,initialReturnTangentStaysLiquid=liquidTangentAdmitted,
        initialRelaxationNecessaryScreen=bool(relaxation<=.1),thermalEquilibriumThroughoutEstablished=False,
        necessaryCarrierScreensPass=bool(physical and dragPass and returnHead<=1 and returnKpower<=10 and driftPass and relaxation<=.1 and liquidTangentAdmitted),
        upflowNative=dict(M_kg=M,U_J=U,K_J=KE,PE_J=PE,total_J=U+KE+PE,volume_m3=A*L,vaporVoid_m3=void),
        returnNative=dict(M_kg=r['M'],U_J=r['U'],PE_J=r['PE'],volume_m3=r['V']),
        surfaceVaporDelivery_kg_s=mv,surfaceLiquidReturn_kg_s=ml,returnMassRate_kg_s=returnMdot,returnEnergyRate_W=returnEdot,
        upperMassRate_kg_s=upperMdot,upperEnergyRate_W=upperEdot,
        meanReturnVelocity_m_s=returnVelocity,omittedReturnHead_Pa=returnHead,omittedReturnKPower_W=returnKpower,
        liquidTraversal_s=liquidTime,fullPathVaporVelocitySurrogate_s=vaporTime,gridInteriorTwoPhaseRegionTraversal_s=actualVaporRegionTime,initialBubbleCondensation_kg_s=cond,
        initialBubbleRelaxation_s=clock,relaxationTraversalRatio=relaxation,initialBottomSubcooling_K=sub,
        nativeReturn_dTdt_K_s=dTdt,nativeReturn_dpdt_Pa_s=dpdt,linearizedReturnDriftOverTraversal_K=drift,
        saturatedEndpointHeadMarginRate_J_kg_s=marginRate,refinedEndpointHeadMarginRate_J_kg_s=fineMargin,
        nativeTangentMassResidual_kg_s=float(nativeResidual[0]) if tangentAvailable else None,nativeTangentEnergyResidual_W=float(nativeResidual[1]) if tangentAvailable else None,
        refinedNativeReturn_dTdt_K_s=fineT,refinedNativeReturn_dpdt_Pa_s=float(fineRates[0]) if tangentAvailable else None,
        maximumVoidFraction=max(x['alpha'] for x in rows),maximumRe=max(x['Re'] for x in rows),maximumWe=max(x['We'] for x in rows),
        profiles=rows,fullNormalEquilibrium=False,
        scope='Boundary-conditioned steady carrier cut with finite-owner rates; not an advanced or maintained native state')
cases=[]
commands=sorted(x['duty_W'] for x in d['phase']['heater'])
specs=[('normal',b['requiredHeater_W'],16,0.,1.,True),('normal refined',b['requiredHeater_W'],32,0.,1.,True),
    ('low acquired request',commands[0],16,0.,1.,True),('high acquired request',commands[2],16,0.,1.,True),
    ('colder return',b['requiredHeater_W'],16,5.,1.,True),('half slip',b['requiredHeater_W'],16,0.,.5,True),
    ('double slip',b['requiredHeater_W'],16,0.,2.,True),('unsupported bank',b['requiredHeater_W'],16,0.,1.,False)]
for args in specs:
    try:cases.append(carrier(*args))
    except (ValueError,RuntimeError) as error:cases.append(dict(name=args[0],completed=False,stage=stage,failure=str(error),completedCut=partial,scope='Numerical/property/domain rejection, not proof no physical circulation'))
refinement=None
if all('massFlow_kg_s' in c for c in cases[:2]):
    a,bb=cases[:2];keys=['massFlow_kg_s','surfaceVaporDelivery_kg_s','liquidTraversal_s']
    differences={key:abs(bb[key]-a[key])/max(abs(bb[key]),1e-12) for key in keys}
    refinement=dict(relativeDifferences=differences,admitted=all(x<=.02 for x in differences.values()))
print(json.dumps(dict(cases=cases,refinement=refinement,geometry=dict(upflow_m3=A*L,return_m3=Ar*L),
    normalCarrierAdopted=False,wholeNormalQualified=False,
    disposition='Retain finite partition and conservative phase fluxes. This fixed-return, quasi-steady equilibrium carrier is not admitted for normal use; incomplete numerical/thermal gates do not disprove circulation.',
    dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__),
    wallSeconds=time.perf_counter()-start),allow_nan=False))
`

export async function runHeaterCarrier(wiki:string,python:string,thermalPath:string,phasePath:string) {
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const source=await Bun.file(import.meta.path).text(),thermalBytes=await Bun.file(thermalPath).text(),phaseBytes=await Bun.file(phasePath).text()
  const thermal=JSON.parse(thermalBytes),phase=JSON.parse(phaseBytes)
  assertCarrierParents(thermal,phase,thermalBytes)
  const page=await Bun.file(join(wiki,'systems/primary-coolant/pressurizer-thermal-state.md')).text()
  const pzr=parsePressurizerBasis(await Bun.file(join(wiki,'systems/primary-coolant/pressure-and-inventory.md')).text())
  const delivery=parseNormalDelivery(page),heater=parseNormalPhase(page);assertCarrierGeometry(delivery,heater,pzr)
  const input={thermal,phase,pzr,delivery,heater},identity={sourceSha256:hash(source),calculationSha256:hash(heaterCarrierPython),inputSha256:hash(JSON.stringify(input)),thermalReceiptSha256:hash(thermalBytes),phaseReceiptSha256:hash(phaseBytes)}
  const child=Bun.spawn([python,'-c',heaterCarrierPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  return code?{...identity,completed:false,failure:err}:{...identity,completed:true,...JSON.parse(out)}
}
if(import.meta.main){const [wiki,python,thermal,phase,...rest]=process.argv.slice(2);if(!wiki||!python||!thermal||!phase||rest.length)throw Error('Usage: heater-carrier <LD01 folder> <python> <normal thermal receipt> <normal phase receipt>');console.log(JSON.stringify(await runHeaterCarrier(wiki,python,thermal,phase),null,2))}
