/** Offline local immersed-cladding boiling selection. No live plant or reflood solver. */
import { createHash } from 'node:crypto'
import { fuelGeometry, parseFuelConstruction } from './reference-design-fuel-construction.ts'
import { fuelMaterialPython } from './reference-design-fuel-materials.ts'
import { poolBoilingPython } from './reference-design-pool-boiling.ts'

export const wetContactPython = String.raw`
import json,sys,math,platform,functools
import CoolProp,scipy,numpy as np
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
from scipy.integrate import solve_ivp
${fuelMaterialPython}
${poolBoilingPython}
d=json.load(sys.stdin);basis=d['basis'];geometry=d['geometry'];b=dict(surfaceFactor=1.)
g=9.80665;sb=5.670374419e-8;D=basis['rodOuterDiameter_m'];dh=geometry['hydraulicDiameter_m']
Lrod=.25;Acell=geometry['flowArea_m2']/geometry['rods']
mc=basis['cladDensity_kg_m3']*math.pi*((D/2)**2-(D/2-basis['cladThickness_m'])**2)*Lrod
checks=[]
def check(name,a,c,atol=1e-7,rtol=1e-9):
    if not math.isfinite(a) or abs(a-c)>max(atol,rtol*abs(c)):raise ValueError(f'{name}: {a} != {c}')
    checks.append(dict(name=name,actual=a,expected=c))
check('CTF 1158 Fahrenheit ceiling in kelvin',(1158-32)*5/9+273.15,898.7055555555555,atol=1e-11)
check('CTF 900 Fahrenheit immersed-zone floor in kelvin',(900-32)*5/9+273.15,755.3722222222221,atol=1e-11)
check('absolute pressure conversion at one standard atmosphere',101325/6894.757293168,14.69594877551422,atol=1e-12)
@functools.cache
def saturation(p):
    if not 2e5<=p<=1e6:raise ValueError('Outside selected 0.2–1 MPa local-pool comparison')
    ts=P('T','P',p,'Q',0,'Water')
    out={n:P(k,'P',p,'Q',q,'Water') for n,k,q in [
      ('rl','D',0),('rv','D',1),('hf','H',0),('hg','H',1),('ul','U',0),('uv','U',1),
      ('kl','L',0),('kv','L',1),('muv','V',1),('cpl','C',0),('cpv','C',1),('sigma','I',0)]}
    return dict(out,p=p,ts=ts,hfg=out['hg']-out['hf'])
@functools.cache
def base(p):
    s=saturation(p)
    qchf=.131*s['hfg']*math.sqrt(s['rv'])*(g*s['sigma']*(s['rl']-s['rv']))**.25
    hliq=7.86*s['kl']/dh
    def wet(t):return max(hliq*(t-s['ts']),pool(p/1e6,t-s['ts']))
    tchf=brentq(lambda t:wet(t)-qchf,s['ts'],1000,xtol=1e-10)
    return dict(Tchf_K=tchf,qCHF_W_m2=qchf,hliquid_W_m2K=hliq)
def thresholds(s,twall):
    ts=s['ts'];rl=s['rl'];rv=s['rv'];hfg=s['hfg']
    tb=ts+.127*rv*hfg/s['kv']*(g*(rl-rv)/(rl+rv))**(2/3)*(s['sigma']/(g*(rl-rv)))**.5*(s['muv']/(g*(rl-rv)))**(1/3)
    eff=math.sqrt(s['kl']*rl*s['cpl']/(kc(twall)*basis['cladDensity_kg_m3']*cpc(twall)))
    henry=tb+.42*(tb-ts)*(eff*hfg/(cpc(twall)*(tb-ts)))**.6
    psi=s['p']/6894.757293168;dp=3203.6-psi
    hn=(705.44-.04722*dp+2.3907e-5*dp**2-5.8193e-9*dp**3-32)*5/9+273.15
    hnContact=hn+(hn-ts)*eff
    # Published CTF Eq470 empirical selector, not a solver clip. The immersed
    # region is liquid-continuous; no volume-fraction disappearance rule is used.
    floor=(900-32)*5/9+273.15;ceiling=(1158-32)*5/9+273.15
    tmin=max(floor,min(ceiling,max(henry,hnContact)))
    return dict(base(s['p']),Tberenson_K=tb,HenryRaw_K=henry,HNRaw_K=hnContact,Tmin_K=tmin)
water=CoolProp.AbstractState('HEOS','Water')
@functools.cache
def film_properties(p,t):
    water.update(CoolProp.PT_INPUTS,p,t)
    return water.rhomass(),water.conductivity(),water.viscosity(),water.cpmass()
def film(s,t,L,emissivity=.7,filmFactor=1.):
    if L<=0:raise ValueError('Film flux undefined at zero physical film length; total heat is zero')
    rv,kv,muv,cpv=film_properties(s['p'],(t+s['ts'])/2)
    h=1.13*(kv**3*rv*(s['rl']-rv)*g*s['hfg']/(muv*(t-s['ts'])*L))**.25
    return dict(convection_W_m2=filmFactor*h*(t-s['ts']),
        radiation_W_m2=emissivity*sb*(t**4-s['ts']**4),filmStefan=cpv*(t-s['ts'])/s['hfg'])
def wall(s,t,L,emissivity=.7,filmFactor=1.,filmLength=.25):
    if not all(math.isfinite(v) for v in [t,L,emissivity,filmFactor,filmLength]) or not 300<=t<=1000 or not 0<=L<=Lrod or not 0<=emissivity<=1 or filmFactor<=0 or filmLength<=0:
        raise ValueError(f'Invalid material, immersed length or explicit sensitivity input: Tw={t}, contactLength={L}, e={emissivity}, factor={filmFactor}, filmLength={filmLength}')
    if L==0:return dict(regime='no-liquid-contact',Q_W=0.,flux_W_m2=None)
    a=math.pi*D*L;th=thresholds(s,t);ts=s['ts']
    if t<=th['Tchf_K']:
        q=max(th['hliquid_W_m2K']*(t-ts),pool(s['p']/1e6,t-ts)) if t>ts else th['hliquid_W_m2K']*(t-ts)
        mode='wet' if t>ts else 'sensible-liquid'
    else:
        fmin=film(s,th['Tmin_K'],filmLength,emissivity,filmFactor);qmin=fmin['convection_W_m2']+fmin['radiation_W_m2']
        if not ts<th['Tchf_K']<th['Tmin_K'] or not 0<qmin<th['qCHF_W_m2']:
            raise ValueError('Unordered boiling endpoints; no clipping or fallback curve')
        if t<th['Tmin_K']:
            weight=((t-th['Tmin_K'])/(th['Tchf_K']-th['Tmin_K']))**2
            q=weight*th['qCHF_W_m2']+(1-weight)*qmin;mode='transition'
        else:
            f=film(s,t,filmLength,emissivity,filmFactor);q=f['convection_W_m2']+f['radiation_W_m2'];mode='film'
    return dict(regime=mode,Q_W=a*q,flux_W_m2=q)
def coupon(p,depth,t0=900.,emissivity=.7,filmFactor=1.,filmLength=.25,drain=0.,step=.2,horizon=120.):
    s=saturation(p);m0=s['rl']*Acell*depth;h0=hc(t0);target=s['ts']+2
    def mass(time,t):return m0+mc*(hc(t)-h0)/s['hfg']-drain*time
    def rhs(time,y):
        L=min(Lrod,max(0.,mass(time,y[0]))/(s['rl']*Acell))
        return [-wall(s,y[0],L,emissivity,filmFactor,filmLength)['Q_W']/(mc*cpc(y[0]))]
    def empty(time,y):return mass(time,y[0])
    def cooled(time,y):return y[0]-target
    def filmEnd(time,y):return y[0]-thresholds(s,y[0])['Tmin_K']
    def wetStart(time,y):return y[0]-base(p)['Tchf_K']
    empty.terminal=True;empty.direction=-1;cooled.terminal=True;cooled.direction=-1
    sol=solve_ivp(rhs,[0,horizon],[t0],method='BDF',rtol=1e-8,atol=1e-9,max_step=step,events=[empty,cooled,filmEnd,wetStart])
    if not sol.success:raise ValueError(sol.message)
    duration=float(sol.t[-1]);tend=float(sol.y[0,-1]);mend=mass(duration,tend)
    status='liquid-exhausted' if len(sol.t_events[0]) else ('cooled-to-Tsat-plus-2K' if len(sol.t_events[1]) else 'horizon')
    if status=='liquid-exhausted':check('actual empty event residual',mend,0,atol=1e-11);mend=0.
    if mend<0:raise ValueError('Accepted negative liquid inventory')
    drained=drain*duration;evap=m0-mend-drained;Vtotal=Acell*max(.3,depth+.05)
    mv0=s['rv']*(Vtotal-m0/s['rl']);mv1=s['rv']*(Vtotal-mend/s['rl'])
    emitted=evap-(mv1-mv0);Q=mc*(h0-hc(tend));outH=emitted*s['hg']+drained*s['hf']
    dU=-Q-(evap+drained)*s['ul']+(mv1-mv0)*s['uv']
    check('finite coupon total internal energy plus exhaust enthalpy',dU+outH,0,atol=1e-6)
    check('finite coupon mass',mend+mv1+emitted+drained,m0+mv0,atol=1e-12)
    check('saturated latent and retained solid energy',Q,evap*s['hfg'],atol=1e-6)
    events=[dict(event=n,time_s=float(time),T_K=float(y[0])) for i,n in [(2,'film-to-transition'),(3,'transition-to-wet')] for time,y in zip(sol.t_events[i],sol.y_events[i])]
    return dict(p_Pa=p,initialDepth_m=depth,initialWall_K=t0,emissivity=emissivity,filmFactor=filmFactor,
      filmLength_m=filmLength,drainRate_kg_s=drain,drainedLiquid_kg=drained,stepCeiling_s=step,
      status=status,duration_s=duration,wallAfter_K=tend,liquidBefore_kg=m0,liquidAfter_kg=mend,
      vaporStoredBefore_kg=mv0,vaporStoredAfter_kg=mv1,netVaporOut_kg=emitted,
      solidHeatRemoved_J=Q,netBoundaryEnthalpyOut_J=outH,energyResidual_J=dU+outH,
      massResidual_kg=mend+mv1+emitted+drained-m0-mv0,events=events,
      nominalPoolEnergyCapacity_J=m0*s['hfg'],solidEnergyAboveTarget_J=mc*(h0-hc(target)))
rows=[]
for p in [2e5,1e6]:
    s=saturation(p);th=thresholds(s,900)
    tjoin=brentq(lambda t:t-thresholds(s,t)['Tmin_K'],s['ts'],1000)
    for L in [.005,.05,.25]:
      f=film(s,th['Tmin_K'],L);qmin=f['convection_W_m2']+f['radiation_W_m2']
      if not s['ts']<th['Tchf_K']<th['Tmin_K']<1000 or not 0<qmin<th['qCHF_W_m2']:raise ValueError(f'Unusable actual endpoint ordering: {p}, {L}, {th}, qmin={qmin}')
      for t in [th['Tchf_K'],tjoin]:
        mid=wall(s,t,L)['Q_W']
        for delta in [-1e-6,1e-6]:check('curve endpoint continuity',wall(s,t+delta,L)['Q_W'],mid,atol=.02)
      rows.append(dict(p_Pa=p,characteristicFilmLength_m=L,wallState_K=900,**th,actualFilmTransition_K=tjoin,qmin_W_m2=qmin,filmAt800=film(s,800,L)))
coupons=[coupon(p,depth) for p in [2e5,1e6] for depth in [.005,.25]]
coupons += [coupon(p,.005,drain=.00001) for p in [2e5,1e6]]
coupons += [coupon(2e5,.25,t0=800)]
coupons += [coupon(2e5,.25,emissivity=e,filmFactor=f) for e,f in [(.3,1),(1,1),(.7,.5),(.7,2)]]
coupons += [coupon(2e5,.25,filmLength=.05),coupon(2e5,.25,step=.1),coupon(2e5,.005,drain=.00001,step=.1)]
for original,refined in [(coupons[1],coupons[-2]),(coupons[4],coupons[-1])]:
    check('halved step ceiling event-time agreement',original['duration_s'],refined['duration_s'],atol=1e-4,rtol=0)
    check('halved step ceiling finite-wall agreement',original['wallAfter_K'],refined['wallAfter_K'],atol=1e-3,rtol=0)
reverse=[]
for p in [2e5,1e6]:
    s=saturation(p);tw=s['ts']-10;Q=wall(s,tw,.05)['Q_W'];dt=.001;ml=s['rl']*Acell*.05
    tw1=brentq(lambda t:mc*(hc(t)-hc(tw))+Q*dt,tw,s['ts'])
    hl1=s['hf']+Q*dt/ml;tl1=P('T','P',p,'H',hl1,'Water');rho1=P('D','P',p,'H',hl1,'Water')
    dH=mc*(hc(tw1)-hc(tw))+ml*(hl1-s['hf'])
    dV=ml/rho1-ml/s['rl'];dU=mc*(hc(tw1)-hc(tw))+ml*(P('U','P',p,'H',hl1,'Water')-s['ul'])
    check('reverse sensible enthalpy reciprocity',dH,0,atol=1e-7)
    check('reverse finite liquid internal energy and boundary work',dU+p*dV,0,atol=1e-6)
    if not tw<tw1<tl1<s['ts']:raise ValueError('Reverse heat does not approach equilibrium')
    reverse.append(dict(p_Pa=p,Q_W=Q,wallBefore_K=tw,wallAfter_K=tw1,liquidAfter_K=tl1,phaseMassSource_kg=0,boronSource_kg=0,energyResidual_J=dH,boundaryWork_J=p*dV))
for p in [2e5,1e6]:
    s=saturation(p)
    check('zero immersed area',wall(s,800,0)['Q_W'],0)
    check('equal temperatures',wall(s,s['ts'],.05)['Q_W'],0)
    for fraction in [1e-2,1e-4,1e-8]:
        for t in [900,800,500]:check('physical area scales once through vanishing contact',wall(s,t,.25*fraction)['Q_W'],fraction*wall(s,t,.25)['Q_W'],atol=1e-10)
    # At zero evaporation but positive liquid withdrawal, pressure maintenance
    # needs real vapor admission. The signed port owns that incoming enthalpy.
    drain=1e-5;vaporIn=drain*s['rv']/s['rl']
    check('pressure-boundary vapor admission mass',-drain+vaporIn+drain-vaporIn,0,atol=1e-16)
    check('pressure-boundary vapor admission energy',-drain*s['ul']+vaporIn*s['uv']+drain*s['hf']-vaporIn*s['hg'],0,atol=1e-9)
if not any(len(c['events'])==2 for c in coupons):raise ValueError('No actual finite-solid passage through both regime transitions')
if not any(c['status']=='liquid-exhausted' and c['wallAfter_K']>saturation(c['p_Pa'])['ts']+2 for c in coupons):raise ValueError('No contrary finite-water exhaustion')
json.dump(dict(geometry=geometry,sleeveMass_kg=mc,sleeveLength_m=Lrod,coolantCellArea_m2=Acell,rows=rows,coupons=coupons,reverse=reverse,checks=checks,
    versions=dict(Python=platform.python_version(),CoolProp=CoolProp.__version__,SciPy=scipy.__version__),
    localImmersedSourceSelected=True,coreDeliveryAndRecoveryQualified=False),sys.stdout,allow_nan=False)
`

if (import.meta.main) {
  const [fuelPath, python, receiptPath] = process.argv.slice(2)
  if (!fuelPath || !python || !receiptPath) throw new Error('Usage: wet-contact.ts fuel-construction.md python receipt.json')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const names = ['reference-design-wet-contact.ts', 'reference-design-fuel-construction.ts', 'reference-design-fuel-materials.ts', 'reference-design-pool-boiling.ts']
  const identities = async () => Object.fromEntries(await Promise.all(names.map(async n => [n, hash(await Bun.file(new URL(n, import.meta.url)).text())])))
  const sources = await identities(), document = await Bun.file(fuelPath).text()
  const basis = parseFuelConstruction(document), geometry = fuelGeometry(basis)
  const child = Bun.spawn([python, '-c', wetContactPython], { stdin: new Blob([JSON.stringify({basis,geometry})]), stdout:'pipe',stderr:'pipe' })
  const [out,err,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if (code !== 0) throw new Error(err)
  if (JSON.stringify(sources)!==JSON.stringify(await identities()) || document!==await Bun.file(fuelPath).text()) throw new Error('Source changed during calculation')
  const receipt={sourceSha256:sources,fuelDocumentSha256:hash(document),...JSON.parse(out)}
  await Bun.write(receiptPath,JSON.stringify(receipt,null,2)+'\n')
  console.log(JSON.stringify({receiptPath,rows:receipt.rows.length,coupons:receipt.coupons.length,checks:receipt.checks.length}))
}
