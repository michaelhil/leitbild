/** Offline constitutive and stable-boundary comparisons, not a CORE integrator. */
import {createHash} from 'node:crypto'
const calculation=String.raw`
import sys,json,math,scipy,CoolProp
import CoolProp.CoolProp as C
from scipy.optimize import brentq,least_squares
checks=[]
def check(name,error,bound):
    if not math.isfinite(error) or abs(error)>bound: raise ValueError((name,error,bound))
    checks.append(dict(name=name,error=error,bound=bound))
def sat(p,q):
    return {x:C.PropsSI(y,'P',p,'Q',q,'Water') for x,y in [('T','T'),('u','U'),('h','H'),('rho','D')]}
def water(p,T):
    return {x:C.PropsSI(y,'P',p,'T',T,'Water') for x,y in [('u','U'),('h','H'),('rho','D')]}
def equilibrium(M,U,V):
    p=C.PropsSI('P','D',M/V,'U',U/M,'Water');q=C.PropsSI('Q','D',M/V,'U',U/M,'Water')
    if not 0<=q<=1: raise ValueError(('Expected two-phase comparison endpoint',p,q))
    l=sat(p,0);g=sat(p,1);ml=M*(1-q);mg=M*q
    check('equilibrium volume',ml/l['rho']+mg/g['rho']-V,1e-8)
    check('equilibrium native energy',ml*l['u']+mg*g['u']-U,.01)
    return dict(p=p,T=l['T'],liquid=ml,vapor=mg)

# Actual HEOS endpoint checks: free expansion into initially evacuated space,
# unchanged total U and no external work/heat. Not a plant break trajectory.
p=5e6;l=water(p,sat(p,0)['T']-5);M=1.;U=M*l['u'];V=M/l['rho']
birth=equilibrium(M,U,V*1.10)
g=water(p,sat(p,1)['T']+5);steam=equilibrium(1,g['u']-25000,1/g['rho'])
if birth['vapor']<=0 or steam['liquid']<=0: raise ValueError('Missing phase birth')
p=1e6;V=.01;alpha=.8;l=sat(p,0);g=sat(p,1)
ml=(1-alpha)*V*l['rho'];mg=alpha*V*g['rho'];U=ml*l['u']+mg*g['u']
balanced=equilibrium(ml+mg,U+1000-1000,V)
check('opposed saturated heat causes zero net phase change',balanced['vapor']-mg,1e-9)

# One active boundary, conservative midpoint pressure/enthalpy transfer.
# The opposing phase keeps its OWN energy balance, not a fixed temperature/U.
# Zero momentum/elevation fixture isolates this thermal native-M/U/V join.
def active_case(active,steps):
    p=1e6;V=.01;Ts=sat(p,0)['T'];Tl=Ts if active=='liquid' else Ts-40;Tg=Ts+80 if active=='liquid' else Ts
    l=sat(p,0) if active=='liquid' else water(p,Tl);g=water(p,Tg) if active=='liquid' else sat(p,1)
    ml=.2*V*l['rho'];mg=.8*V*g['rho'];M=ml+mg;Ul=ml*l['u'];Ug=mg*g['u'];Vg=mg/g['rho'];Q=1000 if active=='liquid' else -1000
    U0=Ul+Ug;before=dict(p=p,Tl=Tl,Tg=Tg,ml=ml,mg=mg,Ul=Ul,Ug=Ug)
    residual=0
    for _ in range(steps):
        p0=p;mg0=mg;Ul0=Ul;Ug0=Ug;Vg0=Vg;target=Ul+Ug+Q/steps
        def states(x):
            pp=x[0]*1e6;mm=x[1];tt=x[2];ss=sat(pp,0)['T']
            ll=sat(pp,0) if active=='liquid' else water(pp,ss-tt)
            gg=water(pp,ss+tt) if active=='liquid' else sat(pp,1)
            return pp,mm,ll,gg
        def equations(x):
            pp,mm,ll,gg=states(x);ull=(M-mm)*ll['u'];ugg=mm*gg['u'];vgg=mm/gg['rho'];pm=(pp+p0)/2
            if active=='liquid': r=ugg-Ug0-(mm-mg0)*sat(pm,1)['h']+pm*(vgg-Vg0)
            else: r=ull-Ul0+(mm-mg0)*sat(pm,0)['h']-pm*(vgg-Vg0)
            return [((M-mm)/ll['rho']+vgg-V)/V,(ull+ugg-target)/1e5,r/1e5]
        x0=[p/1e6,mg,Tg-sat(p,0)['T'] if active=='liquid' else sat(p,0)['T']-Tl]
        sol=least_squares(equations,x0,bounds=([.1,1e-12,.001],[16,M-1e-12,300]),xtol=1e-12,ftol=1e-12,gtol=1e-12,max_nfev=100)
        if not sol.success: raise ValueError(('One-active solver failed',sol.message))
        rr=max(abs(x) for x in equations(sol.x));check('one-active native solve',rr,1e-9);residual=max(residual,rr)
        p,mg,l,g=states(sol.x);ml=M-mg;Ul=ml*l['u'];Ug=mg*g['u'];Vg=mg/g['rho'];Ts=sat(p,0)['T']
        Tl=Ts if active=='liquid' else Ts-sol.x[2];Tg=Ts+sol.x[2] if active=='liquid' else Ts
    check('one-active total energy',Ul+Ug-U0-Q,.001)
    if active=='liquid' and (Tg<=sat(p,0)['T']+50 or mg<=before['mg']): raise ValueError('Hot opposing gas reset or evaporation missing')
    if active=='gas' and (Tl>=sat(p,0)['T']-20 or mg>=before['mg']): raise ValueError('Cold opposing liquid reset or condensation missing')
    return dict(active=active,steps=steps,before=before,after=dict(p=p,Tl=Tl,Tg=Tg,ml=ml,mg=mg,Ul=Ul,Ug=Ug),heat=Q,maxScaledResidual=residual)
active=[active_case(a,n) for a in ['liquid','gas'] for n in [1,2,4]]
for a in ['liquid','gas']:
    rows=[r for r in active if r['active']==a]
    for key,bound in [('p',20),('Tg',.01),('Tl',.01),('mg',1e-6)]:
        check('one-active step sensitivity '+a+' '+key,rows[-1]['after'][key]-rows[-2]['after'][key],bound)

# N2 interface root: selected effective properties, no permanent species floor.
# Prescribed conductances isolate interface law, not a full core transport case.
RN=296.8
def interface(p,nitrogenFraction):
    Ts=sat(p,0)['T'];Tl=Ts-10;Tg=Ts+20;pv=p*(1-nitrogenFraction);A=1.;d=.012;hl=1000.;hg=100.
    rv=0 if pv==0 else C.PropsSI('D','P',pv,'T',Tg,'Water');rn=(p-pv)/(RN*Tg);rho=rv+rn;Y=rv/rho
    def flux(Ti):
        pi=C.PropsSI('P','T',Ti,'Q',1,'Water');ri=C.PropsSI('D','T',Ti,'Q',1,'Water');ni=(p-pi)/(RN*Ti);Yi=ri/(ri+ni)
        D=2.5e-5*((Tg+Ti)/2/298.15)**1.75*101325/p
        gamma=A*rho*D/(d/2)*math.log1p((Yi-Y)/(1-Yi))
        ls=C.AbstractState('HEOS','Water');ls.specify_phase(C.iphase_liquid);ls.update(C.PT_INPUTS,p,Ti)
        hli=ls.hmass();hvi=C.PropsSI('H','T',Ti,'Q',1,'Water')
        Ql=A*hl*(Tl-Ti);Qg=A*hg*(Tg-Ti)
        return Ql+Qg-gamma*(hvi-hli),gamma,Ql,Qg,hli,hvi
    Ti=brentq(lambda T:flux(T)[0],max(273.16,Tl-100),Ts-1e-7,xtol=1e-10)
    r,gamma,Ql,Qg,hli,hvi=flux(Ti)
    check('N2 interface energy closure',r,1e-3)
    check('paired interphase enthalpy sources',(-gamma*hli-Ql)+(gamma*hvi-Qg),1e-3)
    if nitrogenFraction==1 and gamma<=0: raise ValueError('No evaporation into initially steam-free nitrogen')
    return dict(p=p,nitrogenPressureFraction=nitrogenFraction,Ti=Ti,Ts=Ts,Gamma=gamma,liquidHeat=Ql,gasHeat=Qg)
n2=[interface(p,f) for p in [.1e6,1e6,16e6] for f in [1,.1,.001,.000001]]
for p in [.1e6,1e6,16e6]:
    rows=[r for r in n2 if r['p']==p]
    if not abs(rows[-1]['Ti']-rows[-1]['Ts'])<abs(rows[-2]['Ti']-rows[-2]['Ts']): raise ValueError('Wrong pure-steam limiting direction')

# N2 dual stability boundary is NOT common-temperature equilibrium: total-p
# liquid saturation and water-partial-p gas dewpoint are distinct constraints.
p=1e6;pv=.8e6;V=.01;Vg=.008;ll=sat(p,0);vv=sat(pv,1)
ml=(V-Vg)*ll['rho'];mv=Vg*vv['rho'];MN=(p-pv)*Vg/(RN*vv['T']);MW=ml+mv
UN=MN*742*(vv['T']-298.15);U=ml*ll['u']+mv*vv['u']+UN
def dual(x):
    pp=x[0]*1e6;pvv=pp*x[1];mvv=x[2];l=sat(pp,0);v=sat(pvv,1);vg=mvv/v['rho']
    return [((MW-mvv)/l['rho']+vg-V)/V,(pvv+MN*RN*v['T']/vg-pp)/1e6,((MW-mvv)*l['u']+mvv*v['u']+MN*742*(v['T']-298.15)-U)/1e5]
sol=least_squares(dual,[1.01,.79,mv*1.01],bounds=([.1,.01,1e-10],[16,.999999,MW-1e-10]),xtol=1e-12,ftol=1e-12,gtol=1e-12)
if not sol.success: raise ValueError(('Dual N2 boundary solver failed',sol.message))
check('dual N2 native balances',max(abs(v) for v in dual(sol.x)),1e-9)
check('dual N2 opposed heat zero net conversion',sol.x[2]-mv,1e-10)
dualResult=dict(p=sol.x[0]*1e6,pv=sol.x[0]*sol.x[1]*1e6,liquidTemperature=ll['T'],gasTemperature=vv['T'],waterMass=MW,nitrogenMass=MN,netConversion=sol.x[2]-mv,meaning='Known constrained endpoint recovered after equal/opposite heat; not an equilibrium chemistry or finite trajectory proof')
print(json.dumps(dict(scope='Offline constitutive/native-boundary comparisons; not a coupled CORE trajectory or empirical validation',dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),phaseBirth=dict(liquidFreeExpansion=birth,steamCooling=steam),saturatedOpposedHeat=balanced,oneActive=active,nitrogenInterfaces=n2,nitrogenDualBoundary=dualResult,checks=checks),sort_keys=True,allow_nan=False))
`
if(import.meta.main){
  const python=process.argv[2];if(!python)throw new Error('Provide isolated research Python')
  const source=await Bun.file(import.meta.path).text();const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const child=Bun.spawn([python,'-c',calculation],{stdout:'pipe',stderr:'pipe'});const [out,err,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(status!==0)throw new Error(err)
  if(await Bun.file(import.meta.path).text()!==source)throw new Error('Source changed during comparison')
  console.log(JSON.stringify({sourceSha256:hash(source),calculationSha256:hash(calculation),...JSON.parse(out)},null,2))
}
