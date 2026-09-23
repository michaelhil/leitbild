/** Offline weak-wave/property and mixed-material face check; no plant advancement. */
import { createHash } from 'node:crypto'

const calculation = String.raw`
import json,sys,math,CoolProp,scipy
import numpy as np
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq,least_squares,minimize_scalar
from scipy.integrate import quad,solve_ivp
baseline=json.loads(sys.argv[1]);checks=[]
def check(name,value,bound):
    if not math.isfinite(value) or abs(value)>bound:raise ValueError((name,value,bound))
    checks.append(dict(name=name,value=value,bound=bound))
def pt(p,T):
    return dict(p=p,T=T,h=P('H','P',p,'T',T,'Water'),rho=P('D','P',p,'T',T,'Water'),s=P('S','P',p,'T',T,'Water'),c=P('A','P',p,'T',T,'Water'))
def ph(p,h):
    # Stable forward PT evaluation is canonical; the PH inverse supplies no outputs.
    ts=P('T','P',p,'Q',0,'Water');hf=P('H','P',p,'Q',0,'Water');hg=P('H','P',p,'Q',1,'Water')
    if hf<=h<=hg:
        x=(h-hf)/(hg-hf)
        return dict(p=p,h=h,T=ts,rho=P('D','P',p,'Q',x,'Water'),s=P('S','P',p,'Q',x,'Water'),quality=x)
    liquid=h<hf;key='T|liquid' if liquid else 'T|gas'
    # Root brackets cover these named fixtures, not a physical plant temperature cutoff.
    lower,upper=(273.16,ts) if liquid else (ts,1000.)
    T=brentq(lambda T:P('H','P',p,key,T,'Water')-h,lower,upper,xtol=1e-12)
    return dict(p=p,h=h,T=T,rho=P('D','P',p,key,T,'Water'),s=P('S','P',p,key,T,'Water'),c=P('A','P',p,key,T,'Water'),quality=-1)
def ps(p,s):
    ts=P('T','P',p,'Q',0,'Water');sf=P('S','P',p,'Q',0,'Water');sg=P('S','P',p,'Q',1,'Water')
    if sf<=s<=sg:
        x=(s-sf)/(sg-sf);return ph(p,P('H','P',p,'Q',x,'Water'))
    liquid=s<sf;key='T|liquid' if liquid else 'T|gas';lo,hi=(273.16,ts) if liquid else (ts,1000.)
    T=brentq(lambda T:P('S','P',p,key,T,'Water')-s,lo,hi,xtol=1e-12)
    return ph(p,P('H','P',p,key,T,'Water'))
def wave(i,p,side):
    if p==i['p']:return {**i,'u':i.get('u',0.),'kind':'exact zero','speed':i.get('u',0.)+side*i['c'],'headSpeed':i.get('u',0.)+side*i['c']}
    dp=p-i['p'];v0=1/i['rho'];u0=i.get('u',0.)
    if dp>0:
        def residual(dh):return dh-.5*dp*(v0+1/ph(p,i['h']+dh)['rho'])
        dh=brentq(residual,0,2*dp*v0+1,xtol=1e-12)
        q=ph(p,i['h']+dh);dv=v0-1/q['rho']
        if dv<=0:raise ValueError(('Noncompressive shock',dp,dv))
        q.update(u=u0+side*math.sqrt(dp*dv),kind='shock',speed=u0+side*math.sqrt(dp/dv)*v0,hugoniotResidual=residual(dh))
        q['headSpeed']=q['speed']
    else:
        q=ps(p,i['s'])
        def integrand(x):
            st=ps(x,i['s'])
            if 'c' not in st:raise ValueError('This weak-wave comparison requires single-phase outgoing material')
            return 1/(st['rho']*st['c'])
        du=quad(integrand,i['p'],p,epsabs=1e-11,epsrel=1e-10)[0]
        q.update(u=u0+side*du,kind='rarefaction',speed=u0+side*du+side*q['c'],headSpeed=u0+side*i['c'])
    return q
def reflecting(i,normal):
    local={**i,'u':normal*i['velocity'][1]};u=local['u'];p=local['p']
    if u==0:return {**local,'kind':'exact zero','u':0.,'entropyJump':0.,'pressureChange':0.}
    span=2*local['rho']*local['c']*abs(u)
    lo,hi=(p,p+span) if u>0 else (p-span,p)
    pw=brentq(lambda pw:wave(local,pw,-1)['u'],lo,hi,xtol=1e-7)
    q=wave(local,pw,-1);q['entropyJump']=q['s']-local['s'];q['pressureChange']=pw-p
    check('reflecting normal velocity',q['u'],1e-7)
    if q['entropyJump'] < -1e-7:raise ValueError(('Native entropy decrease',u,q['entropyJump']))
    if max(q['speed'],q['headSpeed'])>=0:raise ValueError('Reflection is not outgoing')
    return q
weak=[]
for case in baseline['cases']:
    for inc in case.get('finiteIncrements',[]):
        i=inc['node'];canonical=ph(i['p'],i['h']);canonical.update(velocity=i['velocity'])
        check(case['name']+' accepted entropy coordinate agreement',canonical['s']-i['s'],1e-7)
        check(case['name']+' accepted density coordinate agreement',(canonical['rho']-i['rho'])/i['rho'],1e-10)
        faces=[reflecting(canonical,n) for n in [-1,1]]
        # Gate against the original accepted entropy too; canonicalization cannot erase a real decrease.
        for face in faces:
            if face['s']<i['s']-1e-7:raise ValueError('Original accepted-state entropy gate fails')
        weak.append(dict(name=case['name'],dt=inc['dt_s'],accepted=i,canonical=canonical,faces=faces,oldPHentropyOffset=P('S','P',i['p'],'H',i['h'],'Water')-i['s']))
finite=pt(15.2e6,563.15);finite['velocity']=[10.,1.]
finiteFaces=[reflecting(finite,n) for n in [-1,1]]
for face,normal in zip(finiteFaces,[-1,1]):
    original=next(q for q in baseline['finiteWallCheck']['faces'] if q['normal'][1]==normal)
    check('original finite wall pressure comparison',face['p']-original['pressure_Pa'],.01)
print('weak-state reflection completed',file=sys.stderr,flush=True)

# One actual mixed face: the existing equilibrium water + ideal NC caloric model.
# Ratios are kg NC/kg water; no added persistent phase or interface state.
species={'air':(287.,718.),'nitrogen':(296.8,742.)}
def prepared(p,T,alpha):
    pv=P('P','T',T,'Q',1,'Water');mw=(1-alpha)*P('D','P',p,'T',T,'Water')+alpha*P('D','T',T,'Q',1,'Water')
    return {n:alpha*.5*(p-pv)/(R*T)/mw for n,(R,cv) in species.items()}
ratios=prepared(15.2e6,563.15,.01);total=1+sum(ratios.values());Ar=sum(ratios[n]*species[n][0] for n in ratios)
def mixed(p,T):
    pv=P('P','T',T,'Q',1,'Water');vg=Ar*T/(p-pv) if p>pv else math.inf;mv=P('D','T',T,'Q',1,'Water')*vg
    if not 0<mv<1:raise ValueError(('Outside this named wet-mixture comparison',p,T,mv))
    liquid=pt(p,T);hv=P('H','T',T,'Q',1,'Water');sv=P('S','T',T,'Q',1,'Water')
    H=(1-mv)*liquid['h']+mv*hv;S=(1-mv)*liquid['s']+mv*sv
    for n,m in ratios.items():
        R,cv=species[n];pn=m*R*T/vg
        H+=m*(cv*(T-298.15)+R*T);S+=m*((cv+R)*math.log(T/298.15)-R*math.log(pn/101325))
    v=((1-mv)/liquid['rho']+vg)/total;h=H/total
    return dict(p=p,T=T,h=h,rho=1/v,v=v,e=h-p*v,s=S/total,ml=(1-mv)/total)
def differential(p,T):
    q=mixed(p,T);dp=p*1e-5;dt=T*1e-5
    pp=mixed(p+dp,T);pm=mixed(p-dp,T);tp=mixed(p,T+dt);tm=mixed(p,T-dt)
    hp=(pp['h']-pm['h'])/(2*dp);ht=(tp['h']-tm['h'])/(2*dt)
    vp=(pp['v']-pm['v'])/(2*dp);vt=(tp['v']-tm['v'])/(2*dt)
    td=(q['v']-hp)/ht;vd=vp+vt*td
    if vd>=0:raise ValueError('Nonhyperbolic mixed state')
    return td,math.sqrt(-q['v']**2/vd)
def mixed_ph(p,h,referenceT):
    # Newton is only an inverse of the same stable forward mixture state, not a new material law.
    T=referenceT
    for _ in range(12):
        q=mixed(p,T);r=q['h']-h
        if abs(r)<1e-7:return q
        dt=T*1e-5;ht=(mixed(p,T+dt)['h']-mixed(p,T-dt)['h'])/(2*dt);T-=r/ht
    raise ValueError('Mixed forward enthalpy recovery failed')
def run_mixed(tolerance):
    start=mixed(15.2e6,563.15);_,c0=differential(start['p'],start['T'])
    def rhs(p,y):
        q=mixed(p,y[0]);td,c=differential(p,y[0]);return [td,q['v']/c]
    lower=8e6;upper=15.3e6
    down=solve_ivp(rhs,(start['p'],lower),[start['T'],0.],rtol=tolerance,atol=[1e-9,1e-10],dense_output=True,max_step=5e5)
    up=solve_ivp(rhs,(start['p'],upper),[start['T'],0.],rtol=tolerance,atol=[1e-9,1e-10],dense_output=True,max_step=1e5)
    if not down.success or not up.success:raise ValueError('Mixed native path integration failed')
    def path(p):
        if not lower<=p<=upper:raise ValueError('Named comparison path bracket exceeded')
        y=(down if p<=start['p'] else up).sol(p);q=mixed(p,float(y[0]));q['I']=float(y[1]);return q
    A=.1;CdA=.0443815955075653;cold=pt(.3e6,313.15);cold['u']=0.
    def evaluate(x):
        pL,pR=np.asarray(x)*1e6;donor=path(pL);donor['u']=-donor['I'];H=donor['h']+.5*donor['u']**2
        receiver=wave(cold,pR,1);incoming=mixed_ph(pR,H-.5*receiver['u']**2,donor['T'])
        incoming['u']=receiver['u'];pstag=brentq(lambda p:path(p)['h']-H,pL,upper,xtol=1e-6)
        def flux(p):
            q=path(p);work=H-q['h']
            if work < -1e-5:raise ValueError(('Negative native nozzle work',work))
            # Only roundoff in zero stagnation work is admitted; negative work beyond
            # 1e-5 J/kg rejects the state, and there is no positive head/flow floor.
            return q['rho']*math.sqrt(2*max(0.,work))
        opt=minimize_scalar(lambda p:-flux(p),bounds=(pR,pstag),method='bounded')
        if not opt.success:raise ValueError('Native nozzle maximum failed')
        G,critical=max([(flux(pR),pR),(flux(opt.x),opt.x),(0.,pstag)])
        return dict(donor=donor,receiverWave=receiver,incoming=incoming,H=H,mL=A*donor['rho']*donor['u'],mR=A*incoming['rho']*incoming['u'],nozzleMass=CdA*G,criticalPressure=critical,stagnationPressure=pstag)
    def residual(x):
        q=evaluate(x);return [(q['mL']-q['mR'])/1000,(q['mL']-q['nozzleMass'])/1000]
    sol=least_squares(residual,[10.,9.95],bounds=([8.1,8.01],[15.19,15.18]),xtol=1e-12,gtol=1e-12,ftol=1e-12,diff_step=1e-5,max_nfev=40)
    if not sol.success:raise ValueError(sol.message)
    q=evaluate(sol.x);d=q['donor'];r=q['receiverWave'];inc=q['incoming'];_,cd=differential(d['p'],d['T']);_,ci=differential(inc['p'],inc['T'])
    check('mixed native mass match',q['mL']-q['mR'],1e-5);check('mixed native nozzle match',q['mL']-q['nozzleMass'],1e-5)
    check('mixed native incoming totalH',inc['h']+.5*inc['u']**2-q['H'],1e-5)
    if not max(-c0,d['u']-cd)<0<min(r['speed'],r['headSpeed']):raise ValueError('Mixed face waves not outgoing')
    if not 0<inc['u']<ci:raise ValueError('Mixed incoming not positive subsonic')
    if r['s']<cold['s']-1e-7:raise ValueError('Cold pure-water shock entropy fails')
    if not cold['u']+cold['c']<r['speed']<r['u']+r['c']:raise ValueError('Cold receiving shock Lax condition fails')
    q['momentumReaction']=A*(d['p']-inc['p'])+q['mL']*(d['u']-inc['u'])
    q['speciesFlux']={n:q['mL']*m/total for n,m in ratios.items()};q['waterFlux']=q['mL']/total
    check('native species sum',q['waterFlux']+sum(q['speciesFlux'].values())-q['mL'],1e-10)
    # Independently integrate native volume, not the path's stored wave integral, to audit its caloric work.
    work=quad(lambda p:path(p)['v'],start['p'],d['p'],epsabs=1e-6,epsrel=1e-9)[0]
    check('mixed native caloric path work',d['h']-start['h']-work,.005)
    q.update(tolerance=tolerance,ratio=ratios,initial=start,donorSound=cd,incomingSound=ci,surrogateDonorEntropyDrift=d['s']-start['s'],surrogateValveEntropyJump=inc['s']-d['s'],nativePathWork=work,evaluations=sol.nfev,pathPressureBracket=[lower,upper],phaseScope='liquid-bearing equilibrium mixture throughout admitted path and incoming trace; no dry/phase-crossing outgoing fan',coldShockLaxMargins=[r['speed']-cold['c'],r['u']+r['c']-r['speed']])
    return q
mixedCoarse=run_mixed(2e-9);print('mixed face completed',file=sys.stderr,flush=True)
mixedFine=run_mixed(5e-10)
check('mixed integration mass comparison',mixedCoarse['mL']/mixedFine['mL']-1,1e-5)
check('mixed integration pressure comparison',mixedCoarse['incoming']['p']/mixedFine['incoming']['p']-1,1e-5)
print(json.dumps(dict(scope='Bounded native weak reflection and one liquid-bearing air/N2 valve face. No installed junction trajectory, dry mixture, general phase fan or exact mixture entropy claim.',dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__,numpy=np.__version__),weak=weak,finiteFaces=finiteFaces,mixed=mixedCoarse,mixedRefined=mixedFine,checks=checks),sort_keys=True,allow_nan=False))
`

if (import.meta.main) {
  const [directionalReceipt, python] = process.argv.slice(2)
  if (!directionalReceipt || !python) throw new Error('Usage: <original directional receipt> <research python>')
  const paths = [directionalReceipt, import.meta.path]
  const before = await Promise.all(paths.map(path => Bun.file(path).text()))
  const child = Bun.spawn([python, '-c', calculation, before[0]!], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status !== 0) throw new Error(err)
  for (let i = 0; i < paths.length; i++) if (await Bun.file(paths[i]!).text() !== before[i]) throw new Error('Source changed during calculation')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  console.log(JSON.stringify({ sources: paths.map((path, i) => ({ path, sha256: hash(before[i]!) })), calculationSha256: hash(calculation), ...JSON.parse(out) }, null, 2))
}
