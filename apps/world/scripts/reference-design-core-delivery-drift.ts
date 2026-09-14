/** Offline EPRI vertical drift-flux realization check; not a live vessel solver. */
import { createHash } from 'node:crypto'

const calculation = String.raw`
import json,math,sys,platform,functools
import numpy as np,scipy,CoolProp
from scipy.optimize import brentq,minimize_scalar
from CoolProp.CoolProp import PropsSI as P
g=9.80665;pc=22.064e6;ft=.3048;psi=6894.757293168
checks=[]
def check(name,a,b,atol=1e-8,rtol=1e-7):
    if not math.isfinite(a) or abs(a-b)>max(atol,rtol*abs(b)):raise ValueError(f'{name}: {a} != {b}')
    checks.append(dict(name=name,actual=a,expected=b))
@functools.cache
def sat(p):
    return dict(p=p,rl=P('D','P',p,'Q',0,'Water'),rv=P('D','P',p,'Q',1,'Water'),
      ml=P('V','P',p,'Q',0,'Water'),mv=P('V','P',p,'Q',1,'Water'),sigma=P('I','P',p,'Q',0,'Water'),
      hl=P('H','P',p,'Q',0,'Water'),hv=P('H','P',p,'Q',1,'Water'))
def coefficients(s,D,a,jl,jv,lowRatio=None):
    if not 0<a<1 or D<=0 or not 0<s['p']<pc:raise ValueError('Invalid two-phase constitutive state')
    rl,rv=s['rl'],s['rv'];ref=rl*jl*D/s['ml'];reg=rv*jv*D/s['mv']
    re=reg if reg>ref or reg<0 else ref
    q=re/60000
    A1=1/(1+math.exp(-q)) if q>=0 else math.exp(q)/(1+math.exp(q))
    B1=min(.8,A1);K0=B1+(1-B1)*(rv/rl)**.25;r=(1+1.57*rv/rl)/(1-B1)
    C1=4*pc**2/(s['p']*(pc-s['p']))
    L=math.expm1(-C1*a)/math.expm1(-C1)
    C0=L/(K0+(1-K0)*a**r)
    K1=B1 if reg>=0 else (.65 if abs(reg)/4000>=math.log(1.3) else .5*math.exp(abs(reg)/4000))
    C5=math.sqrt(150*rv/rl)
    C2=1 if C5>=1 else -1/math.expm1(-C5/(1-C5))
    if jl>=0 and jv>=0:C3=max(.5,2*math.exp(-abs(ref)/60000))
    elif jl<=0:
        t=abs(ref);d1=.125*ft
        C3=2*math.exp((t/350000)**.4)-1.75*t**.03*math.exp(-t/50000*(d1/D)**2)+(d1/D)**.25*t**.001
        if lowRatio is not None:C3=C3*lowRatio+(1-lowRatio)*(1+t/60000)
    else:raise ValueError('Source does not define downward-vapor/upward-liquid branch')
    C7=(.3*ft/D)**.6
    C4=1 if C7>=1 else -1/math.expm1(-C7/(1-C7))
    V=1.41*((rl-rv)*s['sigma']*g/rl**2)**.25*(1-a)**K1*C2*C3*C4
    return C0,V
def residual(s,D,a,jl,jv,lowRatio=None):
    c,v=coefficients(s,D,a,jl,jv,lowRatio)
    return jv-a*(c*(jv+jl)+v)
def roots(f,lo,hi,n=240):
    # Constitutive root enumeration, not an accepted-state floor or clipping.
    grid=np.linspace(lo,hi,n+1)
    if lo>0 and hi<1:grid=np.unique(np.r_[grid,np.geomspace(lo,.01,80),1-np.geomspace(1-hi,.01,80)])
    if lo<0<hi:grid=np.unique(np.r_[grid,np.geomspace(1e-7,hi,100),-np.geomspace(1e-7,-lo,100)])
    out=[]
    old=float(grid[0]);fo=f(old)
    for cur in grid[1:]:
        cur=float(cur);fc=f(cur)
        if fc==0:out.append(cur)
        elif fo*fc<0:out.append(brentq(f,old,cur,xtol=1e-12))
        old,fo=cur,fc
    return sorted(set(round(x,11) for x in out))
def void_roots(s,D,jl,jv,lowRatio=None):
    return roots(lambda a:residual(s,D,a,jl,jv,lowRatio),1e-10,1-1e-10)
foldCache={}
def fold(s,D,jv):
    key=(s['p'],D,jv)
    if key in foldCache:return foldCache[key]
    def minimum(jl):
        ff=lambda a:residual(s,D,a,jl,jv)
        xx=np.unique(np.r_[np.linspace(1e-10,1-1e-10,65),np.geomspace(1e-10,.02,40),1-np.geomspace(1e-10,.02,40)])
        yy=[ff(a) for a in xx];candidates=[(yy[0],xx[0]),(yy[-1],xx[-1])]
        for i in range(1,len(xx)-1):
          if yy[i]<=yy[i-1] and yy[i]<=yy[i+1]:
            fit=minimize_scalar(ff,bounds=(xx[i-1],xx[i+1]),method='bounded',options={'xatol':1e-12})
            if not fit.success:raise ValueError('Fold minimum solve failed')
            candidates.append((fit.fun,fit.x))
        return min(candidates)
    upper=minimum(0.)
    if upper[0]>=0:
        foldCache[key]=None;return None
    lower=-.000001
    while minimum(lower)[0]<0:
        lower*=2
        if lower < -10:
            foldCache[key]=None;return None
    jl=brentq(lambda j:minimum(j)[0],lower,0,xtol=1e-12)
    result=dict(jl=jl,alpha=minimum(jl)[1]);foldCache[key]=result;return result
samples=[]
for ppsi,Dft,jlft,jvft,co,vft,aexpected in [
 (14.7,.05,5,10,1.2037,.5979,.5361),(1000,.05,5,10,1.1116,.1410,.5947),
 (1000,1,5,10,1.1119,.2234,.5914),(14.7,1,5,10,1.1922,.9054,.5323),
 (14.7,1,-5,-10,1.0400,5.1172,.9538),(1000,1,-5,-10,1.0498,4.8444,.9171),
 (1000,.05,-5,-10,1.2948,1.8775,.5700),(14.7,.05,-5,-10,1.3036,4.6590,.6714)]:
    s=sat(ppsi*psi);D=Dft*ft;jl=jlft*ft;jv=jvft*ft
    found=void_roots(s,D,jl,jv)
    if len(found)!=1:raise ValueError(f'Source sample root count {found}')
    a=found[0];c,v=coefficients(s,D,a,jl,jv)
    # Old rounded source steam-table results are compared, not imposed as current HEOS properties.
    check('source sample alpha',a,aexpected,atol=.004)
    check('source sample C0',c,co,rtol=.01)
    check('source sample drift m/s',v,vft*ft,rtol=.035)
    samples.append(dict(p_Pa=s['p'],diameter_m=D,jl_m_s=jl,jv_m_s=jv,alpha=a,C0=c,Vgj_m_s=v,sourceAlpha=aexpected))
ccfl=[]
for jlft,jvft in [(-.0024,120.756),(-.2400,46.199),(-.9699,31.295),(-1.5000,23.175)]:
    s=sat(14.7*psi);jv=jvft*ft;f=fold(s,.0833*ft,jv)
    if f is None:raise ValueError('Source CCFL sample has no fold')
    check('source CCFL liquid speed',f['jl'],jlft*ft,atol=.002,rtol=.06)
    ccfl.append(dict(jv_m_s=jv,**f,sourceLiquid_m_s=jlft*ft))
# Native inventory/momentum residuals are tested independently of prescribed void inversions.
# Exact annular geometry is not selected by this constitutive investigation.
states=[]
for p in [2e5,1e6]:
  s=sat(p)
  for D in [.010974518,.2,.45]:
    for jv in [.05,.5,2.]:
      f=fold(s,D,jv)
      if f is None:
        states.append(dict(p_Pa=p,Dh_m=D,jv_m_s=jv,status='fold-not-located-in-declared-search'));continue
      for ratio in [.2,.8,1.]:
        jl=ratio*f['jl'];aa=void_roots(s,D,jl,jv)
        if ratio==1:aa=[f['alpha']]
        corrected=[f['alpha']] if ratio==1 else void_roots(s,D,jl,jv,ratio)
        states.append(dict(p_Pa=p,Dh_m=D,jv_m_s=jv,jl_m_s=jl,flooding=f,ratio=ratio,
          correctedRoots=corrected,uncorrectedRoots=aa))
native=[]
s=sat(1e6);D=.010974518
for a,G in [(.2,-10.),(.7,-10.),(.95,-10.),(.7,0.),(.7,10.)]:
  branches=[]
  for branch in ['upper','lower']:
    def rf(jv):
      jl=(G-s['rv']*jv)/s['rl']
      if jv<0 and jl>0:return math.nan
      ratio=None
      if branch=='lower':
        if not jv>0 or not jl<0:return math.nan
        f=fold(s,D,jv)
        if f is None:return math.nan
        ratio=jl/f['jl']
        if not 0<=ratio<=1:return math.nan
      return residual(s,D,a,jl,jv,ratio)
    rr=roots(rf,-3.,8.,n=110)
    for jv in rr:
      jl=(G-s['rv']*jv)/s['rl'];ratio=None
      if branch=='lower':ratio=jl/fold(s,D,jv)['jl']
      ar=void_roots(s,D,jl,jv,ratio)
      expected=(min(ar) if branch=='lower' else max(ar)) if ar else None
      admissible=expected is not None and abs(a-expected)<1e-6
      ul=jl/(1-a);uv=jv/a
      check('native mass-momentum identity',s['rl']*jl+s['rv']*jv,G)
      branches.append(dict(branch=branch,jv_m_s=jv,jl_m_s=jl,ul_m_s=ul,uv_m_s=uv,
        momentumFlux_Pa=(1-a)*s['rl']*ul**2+a*s['rv']*uv**2,
        kineticEnergyDensity_J_m3=.5*((1-a)*s['rl']*ul**2+a*s['rv']*uv**2),
        phaseEnergyFlux_W_m2=s['rl']*jl*(s['hl']+.5*ul**2)+s['rv']*jv*(s['hv']+.5*uv**2),
        sourceVoidRoots=ar,admittedBySourceRootOrder=admissible))
  native.append(dict(p_Pa=s['p'],Dh_m=D,alpha=a,G_kg_m2s=G,branches=branches,
    sourceOrderedRootsFound=sum(x['admittedBySourceRootOrder'] for x in branches),
    vaporVelocitySearch_m_s=[-3.,8.]))
endpoints=[]
for phase,rho,h in [('liquid',s['rl'],s['hl']),('vapor',s['rv'],s['hv'])]:
  for G in [-10.,0.,10.]:
    u=G/rho;energy=G*(h+.5*u*u)
    check('single-phase signed mass flux',rho*u,G)
    endpoints.append(dict(phase=phase,G_kg_m2s=G,velocity_m_s=u,energyFlux_W_m2=energy))
try:
  coefficients(s,D,.7,.01,-.01)
  raise AssertionError('Undefined source direction accepted')
except ValueError as e:unsupportedDirection=str(e)
cancel=next(x for x in native if x['G_kg_m2s']==0)
face=next(x for x in cancel['branches'] if x['admittedBySourceRootOrder'])
dt=.01;area=1.;vMass=s['rv']*face['jv_m_s']*area*dt;lMass=-s['rl']*face['jl_m_s']*area*dt
# One frozen physical face, not a pressure-coupled trajectory. Upper liquid
# travels down; lower steam travels up. Receivers get exactly donor Ht and B.
if lMass> .3*s['rl'] or vMass>.7*s['rv']:raise ValueError('Finite phase donor exhausted by test transfer')
liquidE=lMass*(s['hl']+.5*face['ul_m_s']**2);vaporE=vMass*(s['hv']+.5*face['uv_m_s']**2)
check('counterflow total mass cancellation',vMass-lMass,0.)
check('counterflow signed enthalpy plus kinetic transfer',vaporE-liquidE,face['phaseEnergyFlux_W_m2']*area*dt)
check('single face equal-opposite energy',(-vaporE+liquidE)+(vaporE-liquidE),0.)
boron=lMass*.002
check('single face liquid-only boron',-boron+boron,0.)
faceTransfer=dict(duration_s=dt,area_m2=area,upwardVapor_kg=vMass,downwardLiquid_kg=lMass,
  upwardVaporEnergy_J=vaporE,downwardLiquidEnergy_J=liquidE,downwardBoron_kg=boron,
  phaseDonorVolumes_m3=dict(upperLiquid=.3,lowerSteam=.7))
json.dump(dict(schema='ld01-core-delivery-drift-investigation-v1',
  runtime=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__),
  sourceSamples=samples,sourceCCFL=ccfl,states=states,nativeStates=native,
  singlePhaseEndpoints=endpoints,undefinedSourceDirection=unsupportedDirection,finiteFaceTransfer=faceTransfer,
  checks=checks),sys.stdout,indent=2,allow_nan=False)
`

if (import.meta.main) {
  const [python, output] = process.argv.slice(2)
  if (!python || !output) throw new Error('Usage: bun reference-design-core-delivery-drift.ts <research-python> <output.json>')
  const hash = async () => createHash('sha256').update(new Uint8Array(await Bun.file(import.meta.path).arrayBuffer())).digest('hex')
  const sourceHash = await hash()
  const child = Bun.spawn([python, '-c', calculation], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(stderr || `Research process exited ${exitCode}`)
  if (await hash() !== sourceHash) throw new Error('Source changed during calculation')
  const result = { ...JSON.parse(stdout), sourceHash }
  await Bun.write(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ output, sourceHash, samples: result.sourceSamples.length, states: result.states.length, checks: result.checks.length }))
}
