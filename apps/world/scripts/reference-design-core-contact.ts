/** Offline LOWER thermal-receiver selection and rejected CORE-equilibrium counterexample. */
import { createHash } from 'node:crypto';

export function admittedPacket(requestedKg: number, availableKg: number) {
  if (![requestedKg, availableKg].every(Number.isFinite) || requestedKg < 0 || availableKg < 0) throw new Error('Invalid finite material budget');
  return { deliveredKg: Math.min(requestedKg, availableKg), unmetKg: Math.max(0, requestedKg - availableKg) };
}

const calculation = String.raw`
import json,sys,math,scipy
import CoolProp.CoolProp as C
from scipy.optimize import least_squares,brentq
g=9.80665
checks=[]
def check(name,value,bound):
    if not math.isfinite(value) or abs(value)>bound: raise ValueError((name,value,bound))
    checks.append(dict(name=name,error=value,bound=bound))
def water(p,T):
    s=C.AbstractState('HEOS','Water');s.update(C.PT_INPUTS,p,T)
    return dict(p=s.p(),rho=s.rhomass(),u=s.umass(),h=s.hmass())
def saturation(p,q):
    return dict(rho=C.PropsSI('D','P',p,'Q',q,'Water'),u=C.PropsSI('U','P',p,'Q',q,'Water'),h=C.PropsSI('H','P',p,'Q',q,'Water'))
def recover(M,U,V):
    p=C.PropsSI('P','D',M/V,'U',U/M,'Water'); T=C.PropsSI('T','D',M/V,'U',U/M,'Water')
    phase=C.PhaseSI('D',M/V,'U',U/M,'Water')
    if phase=='twophase':
        q=C.PropsSI('Q','D',M/V,'U',U/M,'Water'); ml=M*(1-q); mv=M*q
        rhoL=saturation(p,0)['rho']; rhoV=saturation(p,1)['rho']
        alpha=mv/rhoV/V
        check('water recovered volume',ml/rhoL+mv/rhoV-V,1e-9)
        check('water recovered energy',ml*saturation(p,0)['u']+mv*saturation(p,1)['u']-U,.01)
    elif phase in ['liquid','supercritical_liquid']:
        ml=M;mv=0;alpha=0
    elif phase in ['gas','supercritical_gas']:
        ml=0;mv=M;alpha=1
    else: raise ValueError(('Unadmitted fixture phase',phase))
    return dict(p=p,T=T,phase=phase,liquidMass=ml,vaporMass=mv,alpha=alpha)
def initial(p,V,alpha):
    l=saturation(p,0); v=saturation(p,1)
    ml=(1-alpha)*V*l['rho']; mv=alpha*V*v['rho']
    return ml+mv, ml*l['u']+mv*v['u'], ml

# Finite cold pressure-fed piston reservoir is a declared test boundary, not an ACC/CMT trajectory.
# Source stays at p,T only through explicitly recorded piston work. The receiver pressure is never held.
def receive(p,budget):
    available=budget['available'];requested=budget['requested'];delivered=budget['deliveredKg']
    V=28.5; z=-3; alpha=.8
    M,U,ml=initial(p,V,alpha); B=.002*ml
    donor=water(1.2e6,313.15); speed=3.0
    native0=U+M*g*z
    H=donor['h']+speed**2/2+g*z
    native1=native0+delivered*H
    M1=M+delivered; U1=native1-M1*g*z
    after=recover(M1,U1,V); B1=B+.002*delivered
    sourceU0=available*donor['u']; sourceU1=(available-delivered)*donor['u']
    pistonWork=delivered*donor['p']/donor['rho']
    jetWork=delivered*speed**2/2
    # Source piston and kinetic preparation are external work; gravitational term has one shared datum.
    error=(U1-U)+(sourceU1-sourceU0)-pistonWork-jetWork
    check('finite source/receiver first law',error,1e-4)
    check('water mass',M1+(available-delivered)-M-available,2e-12)
    check('boron mass',B1+.002*(available-delivered)-B-.002*available,2e-14)
    check('inlet kinetic thermalization',U1-U-delivered*donor['h']-jetWork,1e-4)
    if not 0<after['p']<1.2e6: raise ValueError('Endpoint not below source pressure')
    if delivered>0 and after['liquidMass']<ml+delivered: raise ValueError('Cold fixture did not condense incoming steam as expected')
    return dict(p0=p,volume=V,alpha0=alpha,requested=requested,available=available,delivered=delivered,unmet=requested-delivered,
                sourceRemaining=available-delivered,sourcePressure=donor['p'],sourceTemperature=313.15,
                before=dict(M=M,U=U,liquidMass=ml,boronMass=B),after=after,finalM=M1,finalU=U1,
                boronMass=B1,boronPpm=1e6*B1/after['liquidMass'],pistonWork=pistonWork,jetPreparationWork=jetWork,
                inletImpulse=delivered*speed,stationaryBodyImpulse=-delivered*speed,firstLawError=error)

# Finite opposed phase inputs collapse their momentum only at this mixed plenum; nowhere upstream.
def opposedReceipt():
    p=1e6;V=28.5;M,U,ml=initial(p,V,.8)
    cold=water(1.2e6,313.15); hot=water(1.2e6,600)
    mL=10.;mV=1.;vL=-3.;vV=30.
    gain=mL*(cold['h']+vL*vL/2)+mV*(hot['h']+vV*vV/2)
    after=recover(M+mL+mV,U+gain,V)
    kinetic=mL*vL*vL/2+mV*vV*vV/2
    check('opposed incoming momenta',mL*vL+mV*vV,1e-12)
    check('opposed KE is not cancelled',kinetic-495,1e-12)
    return dict(receiptLiquid=mL,receiptSteam=mV,signedInletMomentum=mL*vL+mV*vV,thermalizedKinetic=kinetic,after=after)

# Core counterexample: simultaneous cold liquid and hot steam, pressure-equilibrated but thermally separate.
def rejectedCoreFlash():
    p=1e6;V=9.359063;alpha=.9;Tl=430.;Tg=600.
    l=water(p,Tl);v=water(p,Tg)
    ml=(1-alpha)*V*l['rho'];mv=alpha*V*v['rho'];M=ml+mv;U=ml*l['u']+mv*v['u']
    after=recover(M,U,V)
    if after['phase']!='twophase' or after['T']>=Tg-100: raise ValueError('Counterexample did not expose thermal-equilibrium information loss')
    return dict(V=V,p=p,alpha=alpha,Tliquid=Tl,Tsteam=Tg,liquidMass=ml,steamMass=mv,after=after,
                removedSteamSuperheat=Tg-after['T'],solidTemperatureUnchanged=900,
                meaning='Whole local CORE fluid flash erases hot-gas/retained-liquid disequilibrium; do not use as a CET environment closure.')

# Published equilibrium-mixture contract: ideal nitrogen in gas space, HEOS water, common T.
# This tests one constructive LOWER mixture inversion, not finite-rate condensation or gas binding.
RN=296.8;cvN=742.;Tref=298.15
def mixtureState(T,Vg,MN,V):
    ps=C.PropsSI('P','T',T,'Q',1,'Water');p=ps+MN*RN*T/Vg
    l=water(p,T);v=saturation(ps,1)
    ml=(V-Vg)*l['rho'];mv=Vg*v['rho']
    return dict(T=T,p=p,Vg=Vg,M=ml+mv,U=ml*l['u']+mv*v['u']+MN*cvN*(T-Tref),liquidMass=ml,vaporMass=mv,
                nitrogenMass=MN,fugacityScale=(p-ps)/(l['rho']*461.52*T))
def mixtureCheck():
    V=28.5;MN=8.; prepared=mixtureState(450,14.25,MN,V)
    def res(x):
        s=mixtureState(x[0],x[1],MN,V)
        return [(s['M']-prepared['M'])/prepared['M'],(s['U']-prepared['U'])/prepared['U']]
    fit=least_squares(res,[440,13],bounds=([400,5],[470,25]),xtol=1e-13,ftol=1e-13,gtol=1e-13)
    if not fit.success: raise ValueError(('Mixture inversion did not converge',fit.message))
    recovered=mixtureState(*fit.x,MN,V)
    check('mixture native water mass',recovered['M']-prepared['M'],1e-6)
    check('mixture native energy',recovered['U']-prepared['U'],.1)
    check('mixture temperature recovery',recovered['T']-prepared['T'],1e-6)
    if not 0<recovered['fugacityScale']<.02 or recovered['p']>2e6: raise ValueError('Mixture fixture outside inherited gas-entry band')
    return dict(prepared=prepared,recovered=recovered,solverSuccess=bool(fit.success))

# Selected lumped donor trace: first-order mixture-density head, one total enthalpy,
# real face flash. This is not the earlier exact isentropic hydrostatic profile.
def waterPorts():
    def ph(p,h):
        a=C.AbstractState('HEOS','Water');a.update(C.HmassP_INPUTS,h,p)
        if a.phase()!=C.iphase_twophase:
            for _ in range(8):
                residual=a.hmass()-h
                if abs(residual)<1e-6: break
                a.update(C.PT_INPUTS,p,a.T()-residual/a.cpmass())
        check('port EOS enthalpy recovery',a.hmass()-h,1e-5)
        liquidFraction=1-a.Q() if a.phase()==C.iphase_twophase else (1 if a.phase() in [C.iphase_liquid,C.iphase_supercritical_liquid] else 0)
        return dict(T=a.T(),s=a.smass(),phase=int(a.phase()),liquidFraction=liquidFraction)
    states=[]
    for p in [2e5,1e6]:
        M,U,_=initial(p,28.5,.8);states.append(dict(name='mixed',p=p,rho=M/28.5,u=U/M))
    states += [dict(name='normal-liquid',**water(15e6,560)),dict(name='exposed-steam',**water(1e6,600))]
    rows=[]
    for a in states:
        p=a['p'];rho=a['rho'];h=a['u']+p/rho;bulk=ph(p,h);s=bulk['s'];b=.002*bulk['liquidFraction']
        for dz in [-1.,0.,1.]:
            pf=p-rho*g*dz;hf=h-g*dz
            if pf<=0: raise ValueError('Nonpositive port pressure')
            recovered=ph(pf,hf);T=recovered['T'];sf=recovered['s']
            entropy=sf-s
            if entropy < -1e-8: raise ValueError(('Nonadmissible first-order port entropy',a['name'],dz,entropy))
            lf=recovered['liquidFraction']
            if b>0 and (lf==0 or b/lf>.01): raise ValueError('Unselected concentrated/dry absorber port')
            concentration=b/lf if lf>0 else 0
            check('port absorber remains with face liquid',lf*concentration-b,1e-14)
            check('port total enthalpy and gravitational datum',hf+g*dz-h,1e-9)
            if dz==0: check('zero-height port entropy',entropy,1e-8)
            rows.append(dict(state=a['name'],p=p,deltaZ=dz,pFace=pf,hFace=hf,Tface=T,
                             phase=recovered['phase'],entropyGain=entropy,liquidFraction=lf,liquidBoronPpm=1e6*concentration))
    return rows

def nitrogenPorts():
    original=mixtureState(450,14.25,8,28.5);M=original['M'];rN=8/M
    rho=(M+8)/28.5;p=original['p'];h=(original['U']+p*28.5)/(M+8)
    def face(pf,T):
        ps=C.PropsSI('P','T',T,'Q',1,'Water');pn=pf-ps
        if pn<=0: raise ValueError('Nitrogen-bearing liquid fixture requires positive partial pressure')
        vg=rN*RN*T/pn;mv=vg*C.PropsSI('D','T',T,'Q',1,'Water');ml=1-mv
        if ml<=0: raise ValueError('Face left liquid-bearing fixture domain')
        l=water(pf,T);v=saturation(ps,1)
        hm=(ml*l['h']+mv*v['h']+rN*(cvN*(T-Tref)+RN*T))/(1+rN)
        sm=(ml*C.PropsSI('S','P',pf,'T',T,'Water')+mv*C.PropsSI('S','P',ps,'Q',1,'Water')
            +rN*((cvN+RN)*math.log(T/Tref)-RN*math.log(pn/101325)))/(1+rN)
        return dict(T=T,p=pf,waterVaporFraction=mv,liquidWaterFraction=ml,h=hm,nitrogenToWater=rN,entropy=sm)
    s0=face(p,450)['entropy']
    rows=[]
    for dz in [-1.,0.,1.]:
        pf=p-rho*g*dz;hf=h-g*dz
        # Local bracket is solely this prepared-state diagnostic, not an operating bound.
        T=brentq(lambda T:face(pf,T)['h']-hf,449,451,xtol=1e-11)
        a=face(pf,T)
        if a['entropy']-s0 < -1e-8: raise ValueError('Nonadmissible nitrogen port entropy')
        b=.002*original['liquidMass']/M;concentration=b/a['liquidWaterFraction']
        if concentration>.01: raise ValueError('Unselected concentrated nitrogen-bearing port')
        check('nitrogen port composition/enthalpy',a['h']-hf,1e-5)
        check('nitrogen port total enthalpy',hf+g*dz-h,1e-9)
        check('nitrogen port absorber remains in liquid',a['liquidWaterFraction']*concentration-b,1e-14)
        rows.append(dict(deltaZ=dz,entropyGain=a['entropy']-s0,liquidBoronPpm=1e6*concentration,**a))
    return rows

packets=[receive(p,budget) for p in [2e5,1e6] for budget in json.loads(sys.argv[1])]
out=dict(kind='LOWER-native-thermal-receiver-selection',CoolProp=C.get_global_param_string('version'),scipy=scipy.__version__,
         geometryOwner='world/packs/process-plant/reference-designs/ld-01/systems/reactor/core-coolant-delivery.md#physical-path-and-retained-inventories',
         fixtureVolumes_m3=dict(LOWER=28.5,CORE_half=9.359063),packets=packets,
         opposed=opposedReceipt(),rejectedCoreFlash=rejectedCoreFlash(),nitrogen=mixtureCheck(),
         waterPorts=waterPorts(),nitrogenPorts=nitrogenPorts(),checks=checks)
print(json.dumps(out))
`;

if (import.meta.main) {
  const [python, output] = process.argv.slice(2);
  if (!python || !output) throw new Error('Usage: bun reference-design-core-contact.ts research-python output.json');
  const source = await Bun.file(import.meta.path).text();
  const budgets = [0, 10, 150].map(available => ({ available, requested: 100, ...admittedPacket(100, available) }));
  const p = Bun.spawn([python, '-c', calculation, JSON.stringify(budgets)], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (exit !== 0) throw new Error(stderr);
  if (source !== await Bun.file(import.meta.path).text()) throw new Error('Source changed during calculation');
  const result = JSON.parse(stdout);
  await Bun.write(output, `${JSON.stringify({ sourceSha256: createHash('sha256').update(source).digest('hex'), calculationSha256: createHash('sha256').update(calculation).digest('hex'), ...result }, null, 2)}\n`);
  console.log(JSON.stringify({ output, packets: result.packets.length, checks: result.checks.length }));
}
