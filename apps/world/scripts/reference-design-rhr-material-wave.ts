/** Offline caloric-EOS material-path selection; not an installed valve or plant solver. */
import { createHash } from 'node:crypto'

const calculation = String.raw`
import json,sys,math,CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
from scipy.integrate import solve_ivp
checks=[]
species={'air':(287.,718.),'nitrogen':(296.8,742.)}
def check(name,value,bound):
    if not math.isfinite(value) or abs(value)>bound:raise ValueError((name,value,bound))
    checks.append(dict(name=name,value=value,bound=bound))
def water(p,h):
    v=1/P('D','P',p,'H',h,'Water');hf=P('H','P',p,'Q',0,'Water');hg=P('H','P',p,'Q',1,'Water')
    ml=1. if h<=hf else (0. if h>=hg else (hg-h)/(hg-hf))
    return dict(p=p,h=h,v=v,e=h-p*v,T=P('T','P',p,'H',h,'Water'),s=P('S','P',p,'H',h,'Water'),ml=ml,branch='native-water')
def material(p,T,ratios):
    # Ratios are kg NC per kg water; no distinct retained material state.
    total=1+sum(ratios.values());Ar=sum(ratios[n]*species[n][0] for n in ratios)
    if Ar==0:return water(p,P('H','P',p,'T',T,'Water'))
    ps=P('P','T',T,'Q',1,'Water') if T<647.096 else math.inf
    if T<647.096 and p>ps:
        rv=P('D','T',T,'Q',1,'Water');vg=Ar*T/(p-ps);mv=rv*vg
    else:mv=math.inf
    if mv<=1:
        ml=1-mv;pv=ps;vL=1/P('D','P',p,'T',T,'Water')
        hl=P('H','P',p,'T',T,'Water');sl=P('S','P',p,'T',T,'Water')
        hv=P('H','T',T,'Q',1,'Water');sv=P('S','T',T,'Q',1,'Water')
        volume=ml*vL+vg;branch='wet'
    else:
        # Density/T native vapor avoids the PT inverse's saturation exclusion band.
        upper=P('D','T',T,'Q',1,'Water') if T<647.096 else P('D','P',p,'T',T,'Water')
        def pressure(rv):return ps if T<647.096 and rv==upper else P('P','D',rv,'T',T,'Water')
        rv=brentq(lambda rv:pressure(rv)+Ar*T*rv-p,1e-10,upper,xtol=1e-11)
        pv=pressure(rv);vg=1/rv;volume=vg;ml=0.;mv=1.;hl=sl=0.;branch='dry'
        if T<647.096 and rv==upper:hv=P('H','T',T,'Q',1,'Water');sv=P('S','T',T,'Q',1,'Water')
        else:hv=P('H','D',rv,'T',T,'Water');sv=P('S','D',rv,'T',T,'Water')
    H=ml*hl+mv*hv;S=ml*sl+mv*sv
    for n,m in ratios.items():
        if m==0:continue
        R,cv=species[n];pn=m*R*T/vg
        H+=m*(cv*(T-298.15)+R*T);S+=m*((cv+R)*math.log(T/298.15)-R*math.log(pn/101325))
    h=H/total;v=volume/total
    return dict(p=p,T=T,h=h,e=h-p*v,v=v,s=S/total,ml=ml/total,branch=branch,pv=pv)
def ph(p,h,ratios):
    if sum(ratios.values())==0:return water(p,h)
    # This finite bracket belongs to the named comparisons, not a material cutoff.
    T=brentq(lambda T:material(p,T,ratios)['h']-h,300,700,xtol=1e-9)
    return material(p,T,ratios)
def sound(p,h,ratios,step=1e-5,side=0):
    q=ph(p,h,ratios);v=q['v'];dp=p*step
    if side==0:
        derivative=(ph(p+dp,h+v*dp,ratios)['v']-ph(p-dp,h-v*dp,ratios)['v'])/(2*dp)
    else:
        derivative=(ph(p+side*dp,h+side*v*dp,ratios)['v']-v)/(side*dp)
    c2=-v*v/derivative
    if not c2>0:raise ValueError(('Nonhyperbolic caloric state',q,derivative))
    return math.sqrt(c2)
def prepared(p,T,alpha):
    pv=P('P','T',T,'Q',1,'Water');mw=(1-alpha)*P('D','P',p,'T',T,'Water')+alpha*P('D','T',T,'Q',1,'Water')
    return {n:alpha*.5*(p-pv)/(R*T)/mw for n,(R,cv) in species.items()}
ordinary=prepared(15.2e6,563.15,.01)
rhoSteam=P('D','P',7.6e6,'T',623.15,'Water')
dry={n:3.8e6/(R*623.15)/rhoSteam for n,(R,cv) in species.items()}
rows=[]
for name,p,T,ratios in [('ordinary-wet',15.2e6,563.15,ordinary),('dry-gas',15.2e6,623.15,dry),('pure-water',15.2e6,563.15,{'air':0.,'nitrogen':0.})]:
    start=material(p,T,ratios);endp=.8*p
    def rhs(x,y):return [ph(x,y[0],ratios)['v']]
    sol=solve_ivp(rhs,(p,endp),[start['h']],rtol=2e-10,atol=1e-5,dense_output=True,max_step=(p-endp)/8)
    if not sol.success:raise ValueError(sol.message)
    end=ph(endp,float(sol.y[0,-1]),ratios);c=sound(p,start['h'],ratios);fine=sound(p,start['h'],ratios,5e-6)
    check(name+' sound derivative refinement',c/fine-1,1e-4)
    if sum(ratios.values())>0:
        dp=p*1e-5;dt=T*1e-5
        pp=material(p+dp,T,ratios);pm=material(p-dp,T,ratios);tp=material(p,T+dt,ratios);tm=material(p,T-dt,ratios)
        vp=(pp['v']-pm['v'])/(2*dp);ep=(pp['e']-pm['e'])/(2*dp);vt=(tp['v']-tm['v'])/(2*dt);et=(tp['e']-tm['e'])/(2*dt)
        tprime=-(ep+p*vp)/(et+p*vt);ct=math.sqrt(-start['v']**2/(vp+vt*tprime))
        check(name+' independent pT acoustic derivative',ct/c-1,1e-4)
    # Independent midpoint quadrature of v along the selected integrated path.
    count=128;dp=(endp-p)/count;work=sum(ph(p+(j+.5)*dp,float(sol.sol(p+(j+.5)*dp)[0]),ratios)['v']*dp for j in range(count))
    check(name+' adiabat enthalpy-work ratio',(end['h']-start['h'])/work-1,1e-5)
    shockp=1.05*p
    shockh=brentq(lambda h:h-start['h']-.5*(shockp-p)*(start['v']+ph(shockp,h,ratios)['v']),start['h'],start['h']+2*(shockp-p)*start['v']+1,xtol=1e-7)
    shock=ph(shockp,shockh,ratios);J=math.sqrt((shockp-p)/(start['v']-shock['v']));shockSpeed=J*start['v'];postVelocity=J*(start['v']-shock['v']);postSound=sound(shockp,shockh,ratios)
    if not c<shockSpeed<postVelocity+postSound:raise ValueError((name,'Compression Lax condition failed'))
    check(name+' shock totalH jump',shock['h']+.5*(shockSpeed-postVelocity)**2-start['h']-.5*shockSpeed**2,1e-5)
    rows.append(dict(name=name,ratios=ratios,start=start,end=end,c=c,refinedSound=fine,work=work,surrogateEntropyDrift=end['s']-start['s'],shock=shock,shockSurrogateEntropyJump=shock['s']-start['s'],shockSpeed=shockSpeed,postVelocity=postVelocity,postSound=postSound))
    print(json.dumps(dict(completed=name)),file=sys.stderr,flush=True)
# Pure native water crosses saturation on exactly its native isentrope.
p0=15.2e6;T0=563.15;s0=P('S','P',p0,'T',T0,'Water');h0=P('H','P',p0,'T',T0,'Water')
ps=brentq(lambda p:P('S','P',p,'Q',0,'Water')-s0,1e6,15e6)
hf=P('H','P',ps,'Q',0,'Water');pure={'air':0.,'nitrogen':0.}
left=sound(ps,hf,pure,1e-6,-1);right=sound(ps,hf,pure,1e-6,1)
native=P('A','P',ps,'Q',0,'Water');check('saturated liquid one-sided sound',right/native-1,1e-4)
# Explicitly stop/restart at native phase admission, carrying the same h.
cross=[];crossH=h0
for pa,pb in [(p0,ps),(ps,ps*.5)]:
    run=solve_ivp(lambda p,y:[water(p,y[0])['v']],(pa,pb),[crossH],rtol=1e-11,atol=1e-6,max_step=(pa-pb)/16)
    if not run.success:raise ValueError(run.message)
    crossH=float(run.y[0,-1]);nativeH=P('H','P',pb,'S',s0,'Water')
    check('integrated native water phase crossing enthalpy',crossH-nativeH,.02)
    cross.append(dict(pressure=pb,integratedEnthalpy=crossH,nativeEnthalpy=nativeH,entropyDrift=water(pb,crossH)['s']-s0))
wetStates=[]
for p in [ps*1.001,ps,ps*.999,ps*.5]:
    h=P('H','P',p,'S',s0,'Water');q=water(p,h);q['sound']=sound(p,h,pure) if p!=ps else None;wetStates.append(q)
# Mixture dew endpoint continuous h/v, but derivative is explicitly one-sided.
pd=2e6;ratios={'air':.01,'nitrogen':.01}
td=brentq(lambda T:P('P','T',T,'Q',1,'Water')+sum(ratios[n]*species[n][0] for n in ratios)*T*P('D','T',T,'Q',1,'Water')-pd,350,485)
before=material(pd,td-1e-5,ratios);after=material(pd,td+1e-5,ratios)
at=material(pd,td,ratios);rv=P('D','T',td,'Q',1,'Water');vg=1/rv;total=1+sum(ratios.values())
endpointH=(P('H','T',td,'Q',1,'Water')+sum(m*(species[n][1]*(td-298.15)+species[n][0]*td) for n,m in ratios.items()))/total
check('wet dry identical zero-liquid endpoint enthalpy',at['h']-endpointH,1e-4)
check('wet dry identical zero-liquid endpoint volume',at['v']-vg/total,1e-10)
dewMinus=sound(pd,endpointH,ratios,1e-6,-1);dewPlus=sound(pd,endpointH,ratios,1e-6,1)
beforeHalf=material(pd,td-5e-6,ratios);afterHalf=material(pd,td+5e-6,ratios)
check('wet dry approach difference scales with interval',(afterHalf['h']-beforeHalf['h'])/(after['h']-before['h'])-.5,1e-4)
if before['branch']!='wet' or after['branch']!='dry':raise ValueError('Dew crossing did not change native branch')
for ratio in [1e-6,1e-8]:
    q=material(p0,T0,{'air':ratio,'nitrogen':ratio});check('zeroNC caloric limit '+str(ratio),(q['h']-h0)/h0,ratio*100)
gamma=1+296.8/742.;pureN=math.sqrt(gamma*296.8*400);pn=1e6;hn=742*(400-298.15)+296.8*400;vn=296.8*400/pn;dpn=pn*1e-5
def nv(p,h):return 296.8*(h+742*298.15)/((742+296.8)*p)
numN=math.sqrt(-vn*vn/((nv(pn+dpn,hn+vn*dpn)-nv(pn-dpn,hn-vn*dpn))/(2*dpn)))
check('ideal nitrogen same energy-path derivative',numN/pureN-1,1e-7)
print(json.dumps(dict(scope='Conservative caloric-EOS adiabats and acoustic selection; no whole RHR face or transient. Owner hashes record reviewed context, not parsed numerical inputs.',dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),rows=rows,pureWaterPhaseBoundary=dict(pressure=ps,enthalpy=hf,wetSound=left,liquidSound=right,nativeLiquidSound=native,states=wetStates,integratedCrossing=cross),mixedDewBoundary=dict(pressure=pd,temperature=td,wet=before,dry=after,matchedEndpoint=at,oneSidedSoundMinus=dewMinus,oneSidedSoundPlus=dewPlus,firstDiagnostic=dict(temperatureHalfInterval=1e-5,enthalpyDifference=after['h']-before['h'],rejectedCriterion_J_kg=1,meaning='Rejected continuity diagnostic: finite latent phase change over temperature interval, not endpoint discontinuity')),idealNitrogen=dict(R=296.8,cv=742.,temperature=400,analyticSound=pureN,nativeEnergyDerivativeSound=numN),checks=checks),sort_keys=True,allow_nan=False))
`

if (import.meta.main) {
  const [materialOwner, rhrOwner, python] = process.argv.slice(2)
  if (!materialOwner || !rhrOwner || !python) throw new Error('Usage: <material-owner> <RHR-owner> <research-python>')
  const paths = [materialOwner, rhrOwner, import.meta.path]
  const before = await Promise.all(paths.map(path => Bun.file(path).text()))
  const child = Bun.spawn([python, '-c', calculation], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status !== 0) throw new Error(err)
  for (let i = 0; i < paths.length; i++) if (await Bun.file(paths[i]!).text() !== before[i]) throw new Error('Consumed source changed')
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  console.log(JSON.stringify({ sources: paths.map((path, i) => ({ path, sha256: hash(before[i]!) })), calculationSha256: hash(calculation), ...JSON.parse(out) }, null, 2))
}
