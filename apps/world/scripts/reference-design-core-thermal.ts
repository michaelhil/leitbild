/** Offline operational core-package selection. No runtime or connected plant solver. */
import { createHash } from 'node:crypto'
import { fuelGeometry, parseFuelConstruction } from './reference-design-fuel-construction'
import { fuelMaterialPython } from './reference-design-fuel-materials'
import { poolBoilingPython } from './reference-design-pool-boiling'

const calculation=String.raw`
import json,sys,math,functools
import CoolProp,scipy,numpy as np
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq,root
from scipy.integrate import solve_ivp,quad
${fuelMaterialPython}
${poolBoilingPython}
d=json.load(sys.stdin);basis=d['basis'];geom=d['geometry'];b=dict(surfaceFactor=1.)
dh=geom['hydraulicDiameter_m'];g=9.80665;sb=5.670374419e-8
checks=[]
def check(n,a,e=0.,tol=1e-7):
    if not math.isfinite(a) or abs(a-e)>tol:raise ValueError((n,a,e,tol))
    checks.append(dict(name=n,actual=a,expected=e,tolerance=tol))
@functools.cache
def sat(p):
    s={n:P(k,'P',p,'Q',q,'Water') for n,k,q in [('ts','T',0),('rl','D',0),('rv','D',1),('hf','H',0),('hg','H',1),('kl','L',0),('kv','L',1),('muv','V',1),('cpl','C',0),('sigma','I',0)]}
    return dict(s,p=p,hfg=s['hg']-s['hf'])
def liquid(s,t):
    if t>s['ts']+1e-8:raise ValueError('Stable liquid state required')
    if abs(t-s['ts'])<1e-8:return dict(h=s['hf'],mu=P('V','P',s['p'],'Q',0,'Water'),k=s['kl'],cp=s['cpl'])
    return {n:P(k,'P',s['p'],'T',t,'Water') for n,k in [('h','H'),('mu','V'),('k','L'),('cp','C')]}
def pre(s,tl,tw,G):
    l=liquid(s,tl);re=abs(G)*dh/l['mu'];pr=l['cp']*l['mu']/l['k']
    h=max(7.86,.023*re**.8*pr**(.4 if tw>=tl else .3))*l['k']/dh
    fc=h*(tw-tl);phi=38*math.pi/180;F=1-math.exp(-phi**3-.5*phi)
    d0=2*h*s['sigma']*s['ts']/(F*F*s['rv']*s['hfg']*s['kl'])
    tonb=s['ts']+.5*(d0+math.sqrt(d0*d0+4*d0*(s['ts']-tl)))
    if tw<=tonb or tw<=tl:return dict(q=fc,qb=0.,gamma=0.,tonb=tonb,h=h)
    pb=pool(s['p']/1e6,tw-s['ts'])-pool(s['p']/1e6,tonb-s['ts'])
    q=(fc**3+pb**3)**(1/3);qb=q-fc
    pe=abs(G)*dh*s['cpl']/l['k'];det=qb*dh*s['cpl']/(l['k']*.0065*max(70000,pe))
    depart=max(0.,min(1.,(l['h']-(s['hf']-det))/det)) if det>0 else 0.
    pump=s['hfg']/(s['hfg']+(s['hf']-l['h'])*s['rl']/s['rv'])
    return dict(q=q,qb=qb,gamma=depart*pump*qb/s['hfg'],tonb=tonb,h=h)
def tmin(s,tl,tw):
    rl=s['rl'];rv=s['rv'];ts=s['ts'];hfg=s['hfg']
    eff=math.sqrt(s['kl']*rl*s['cpl']/(kc(tw)*basis['cladDensity_kg_m3']*cpc(tw)))
    tb=ts+.127*rv*hfg/s['kv']*(g*(rl-rv)/(rl+rv))**(2/3)*(s['sigma']/(g*(rl-rv)))**.5*(s['muv']/(g*(rl-rv)))**(1/3)
    henry=tb+.42*(tb-tl)*(eff*hfg/(cpc(tw)*(tb-ts)))**.6
    x=3203.6-s['p']/6894.757293168
    hn=(705.44-.04722*x+2.3907e-5*x*x-5.8193e-9*x**3-32)*5/9+273.15
    return max(755.3722222222222,min(898.7055555555555,max(henry,hn+(hn-tl)*eff)))
def film(s,tw,factor=1.):
    tf=(tw+s['ts'])/2
    kv=P('L','P',s['p'],'T',tf,'Water');rv=P('D','P',s['p'],'T',tf,'Water');mu=P('V','P',s['p'],'T',tf,'Water')
    h=1.13*(kv**3*rv*(s['rl']-rv)*g*s['hfg']/(mu*(tw-s['ts'])*.25))**.25
    return factor*h*(tw-s['ts'])+.7*sb*(tw**4-s['ts']**4)
@functools.cache
def turnover(p,tl,G):
    s=sat(p)
    qscale=.131*s['hfg']*math.sqrt(s['rv'])*(g*s['sigma']*(s['rl']-s['rv']))**.25*math.sqrt(s['rl']/(s['rl']+s['rv']))
    temp=brentq(lambda t:pre(s,tl,t,G)['qb']-qscale,s['ts'],1300)
    return temp,pre(s,tl,temp,G),qscale
def wet(s,tl,tw,G,filmFactor=1.):
    initial=pre(s,tl,tw,G)
    if tw<=initial['tonb']:
        return dict(q=initial['q'],gamma=0.,mode='sensible',tonb=initial['tonb'],turnover=None,tmin=None,liquidEnergy=initial['q'],gasEnergy=0.,qScale=None)
    tc,peak,qscale=turnover(s['p'],tl,G);tm=tmin(s,tl,tw)
    qm=film(s,tm,filmFactor)
    if not peak['tonb']<tc<tm or not 0<qm<peak['q']:raise ValueError(('Unordered complete package',s['p'],tl,tw,G,peak['tonb'],tc,tm,qm,peak['q']))
    if tw<=tc:r=pre(s,tl,tw,G);q=r['q'];gamma=r['gamma'];mode='wet'
    elif tw<tm:
        f=((tw-tm)/(tc-tm))**2;q=f*peak['q']+(1-f)*qm
        gamma=f*peak['gamma']+(1-f)*qm/(s['hg']-liquid(s,tl)['h']);mode='transition'
    else:q=film(s,tw,filmFactor);gamma=q/(s['hg']-liquid(s,tl)['h']);mode='film'
    return dict(q=q,gamma=gamma,mode=mode,tonb=peak['tonb'],turnover=tc,tmin=tm,liquidEnergy=q-gamma*s['hg'],gasEnergy=gamma*s['hg'],qScale=qscale)
rows=[]
for p in [1e5,2e5,1e6,5e6,10e6,15e6,16e6]:
    s=sat(p)
    for sub in [0,20,50]:
        tl=s['ts']-sub
        for G in [0,4000,-100]:
            for tw in [tl-5,tl,s['ts']+2,750.,900.,1200.]:
                w=wet(s,tl,tw,G);check('wall source energy',w['liquidEnergy']+w['gasEnergy']-w['q'],tol=1e-7)
                rows.append(dict(p=p,subcooling=sub,G=G,wall=tw,**w))
# Finite source apparatus: one actual 0.25 m rod share, not a core trajectory.
# The external saturated-vapor pressure boundary receives gas sensible heat and
# signed saturated vapor enthalpy. Fuel/clad/guide and liquid inventories finite.
length=.25;ro=basis['rodOuterDiameter_m']/2;ri=ro-basis['cladThickness_m'];rf=basis['pelletDiameter_m']/2
ar=2*math.pi*ro*length;ratio=basis['guidesPerAssembly']/basis['rodsPerAssembly'];rg=basis['guideOuterDiameter_m']/2
ag=ratio*2*math.pi*rg*length;mf=geom['fuelMass_kg']/geom['rods']*length/basis['activeLength_m'];mc=geom['cladMass_kg']/geom['rods']*length/basis['activeLength_m']
mg=ratio*basis['cladDensity_kg_m3']*math.pi*(rg**2-(rg-.0006)**2)*length
volume=geom['flowArea_m2']/geom['rods']*length;s=sat(1e6)
heliumVolume=math.pi*(ri**2-rf**2)*length;heliumCapacity=1.5*2e6*heliumVolume/600.
def gasq(t):
    if abs(t-s['ts'])<1e-9:return 0.
    tf=(t+s['ts'])/2
    if tf<=s['ts']:return 10*P('L','P',s['p'],'Q',1,'Water')/dh*(t-s['ts'])
    return 10*P('L','P',s['p'],'T',tf,'Water')/dh*(t-s['ts'])
def gapheat(tf,tc,factor):
    # Declared frozen cold open geometry and prepared helium accommodation at
    # 600 K are apparatus inputs, not a reconstruction of the normal hot rod.
    tg=(tf+tc)/2;khe=1.314e-3*(1.8*tg)**.668*BTU;pg=2e6*tg/600.;acc=.425-.00023*600
    jump=.3048*2.0358e-5*(khe/BTU)*math.sqrt(tg)/((pg/6894.757293168)*acc/math.sqrt(4.003))
    hg=khe/(ri-rf+1.845*jump)
    # Mean-fuel to surface conduction, finite gap, and half-clad resistance.
    conductance=1/(1/(8*math.pi*kf(tf)*length)+1/(hg*2*math.pi*rf*length)+math.log(ro/ri)/(4*math.pi*kc(tc)*length))
    rad=sb*(tf**4-tc**4)/( (1/.7-1)/(2*math.pi*rf*length)+1/(2*math.pi*rf*length)+(1/.7-1)/(2*math.pi*ri*length))
    return factor*conductance*(tf-tc)+rad
def coupon(alpha0,gapFactor=1.,contactPower=1.):
    ml0=alpha0*volume*s['rl'];ul=P('U','P',s['p'],'Q',0,'Water');uv=P('U','P',s['p'],'Q',1,'Water')
    def energy(y):
        tf,tc,tg,ml,*_=y;return mf*hf(tf)+mc*hc(tc)+heliumCapacity*(tf+tc)/2+mg*hc(tg)+ml*ul+s['rv']*(volume-ml/s['rl'])*uv
    def rhs(t,y):
        tf,tc,tg,ml,vent,gasE=y
        a=max(0.,ml)/(volume*s['rl']);f=a**contactPower
        qw=ar*f*wet(s,s['ts'],tc,0.)['q'];qgw=ag*f*wet(s,s['ts'],tg,0.)['q']
        qgas=(1-f)*(ar*gasq(tc)+ag*gasq(tg))
        qrg=(1-f)*sb*(tc**4-tg**4)/((1/.7-1)/ar+1/ag+(1/.7-1)/ag)
        qfc=gapheat(tf,tc,gapFactor);dm=(qw+qgw)/s['hfg']
        c=heliumCapacity/4
        tempRate=np.linalg.solve([[mf*cpf(tf)+c,c],[c,mc*cpc(tc)+c]],[-qfc,qfc-qw-(1-f)*ar*gasq(tc)-qrg])
        return [*tempRate,(qrg-qgw-(1-f)*ag*gasq(tg))/(mg*cpc(tg)),-dm,dm*(1-s['rv']/s['rl']),qgas]
    def cool(t,y):return y[0]-510
    cool.terminal=True;cool.direction=-1
    initial=[1200.,900.,500.,ml0,0.,0.]
    sol=solve_ivp(rhs,[0,120],initial,method='Radau',events=cool,rtol=2e-8,atol=[1e-7,1e-7,1e-7,1e-11,1e-11,1e-6],max_step=1)
    if not sol.success:raise ValueError(sol.message)
    end=sol.y[:,-1];ledger=energy(end)-energy(initial)+end[4]*s['hg']+end[5]
    check('finite solid/water/reservoir energy',ledger,tol=.02)
    check('finite carrier mass',end[3]+s['rv']*(volume-end[3]/s['rl'])+end[4]-(ml0+s['rv']*(volume-ml0/s['rl'])),tol=1e-9)
    if min(sol.y[3])< -1e-10 or min(sol.y[0])<500 or max(sol.y[0])>2000 or min(sol.y[1:3].flatten())<300 or max(sol.y[1:3].flatten())>1800:raise ValueError('Coupon left owned material range')
    return dict(initialLiquidFraction=alpha0,gapFactor=gapFactor,contactPower=contactPower,time_s=float(sol.t[-1]),fuel_K=float(end[0]),clad_K=float(end[1]),guide_K=float(end[2]),liquid_kg=float(end[3]),initialLiquid_kg=ml0,netVaporOut_kg=float(end[4]),gasBoundaryHeat_J=float(end[5]),energyResidual_J=float(ledger),assessmentTargetReached=len(sol.t_events[0])>0)
coupons=[coupon(a) for a in [.95,.002]]
coupons += [coupon(.95,f,1.) for f in [.5,2.]]
coupons += [coupon(.95,1.,power) for power in [.5,2.]]
# Frozen-property directional force comparison, not a delivered core trajectory.
def drag(a,ul,ug,dFactor=1.):
    if a==0 or a==1:return 0.
    w=ug-ul;rho=(1-a)*s['rl']+a*s['rv'];mu=(1-a)*P('V','P',1e6,'Q',0,'Water')+a*s['muv'];diam=dh*dFactor
    re=rho*abs(w)*diam/mu;cdre=24*(1+.15*re**.687) if re<1000 else .44*re
    return .75*cdre*mu*(1-a)*a*w/diam**2 # N/m3
def rodWall(fraction,rho,mu,u):
    if fraction==0 or u==0:return 0.
    re=rho*abs(u)*dh/mu;darcy=max(64/re,1.691*re**(-.43),.117*re**(-.14))
    return fraction*darcy*rho*u*abs(u)/(2*dh)
mechanics=[]
for a in [.1,.5,.9]:
    for grad in [500.,3000.,7000.,((1-a)*s['rl']+a*s['rv'])*g]:
        def residual(u):
            ul,ug=u;fi=drag(a,ul,ug)
            return [(1-a)*(grad-s['rl']*g)-rodWall(1-a,s['rl'],P('V','P',1e6,'Q',0,'Water'),ul)+fi,a*(grad-s['rv']*g)-rodWall(a,s['rv'],s['muv'],ug)-fi]
        r=root(residual,[0.,1.],tol=1e-10)
        if not r.success and max(abs(x) for x in residual(r.x))>1e-6:raise ValueError(('Directional residual',r.message))
        ul,ug=map(float,r.x);fi=drag(a,ul,ug);diss=fi*(ug-ul)
        check('phase force balance',max(abs(x) for x in residual(r.x)),tol=1e-6)
        if diss<0:raise ValueError('Negative drag dissipation')
        check('phase mechanical work plus gas thermalization',fi*ul-fi*ug+diss,tol=1e-8)
        mechanics.append(dict(gasFraction=a,upwardPressureForce_Pa_m=grad,liquid_m_s=ul,gas_m_s=ug,drag_N_m3=fi,dissipation_W_m3=diss))
for a in [0.,1.]:check('exact absent phase drag',drag(a,-2.,3.),tol=0.)
if not any(r['liquid_m_s']<0<r['gas_m_s'] for r in mechanics):raise ValueError('No opposing-flow state found in prescribed comparison')
# One-sided regime continuity and signed sensible-source checks.
for p in [2e5,1e6,15e6]:
    ss=sat(p);tl=ss['ts']-20;tc,peak,_=turnover(p,tl,4000.)
    for t in [peak['tonb'],tc]:
        lo=wet(ss,tl,t-1e-7,4000.);hi=wet(ss,tl,t+1e-7,4000.)
        check('source boundary heat continuity',hi['q']-lo['q'],tol=5.)
    tm=brentq(lambda t:tmin(ss,tl,t)-t,755.372222222,898.705555556)
    lo=wet(ss,tl,tm-1e-7,4000.);hi=wet(ss,tl,tm+1e-7,4000.)
    check('film boundary heat continuity',hi['q']-lo['q'],tol=5.)
    check('film boundary mass continuity',hi['gamma']-lo['gamma'],tol=1e-4)
out=dict(kind='operational-core-thermal-package',rows=rows,coupons=coupons,mechanics=mechanics,couponGeometry=dict(length_m=length,fuelMass_kg=mf,cladMass_kg=mc,guideMass_kg=mg,flowVolume_m3=volume,heliumVolume_m3=heliumVolume,heliumCapacity_J_K=heliumCapacity),checks=checks,CoolProp=CoolProp.__version__,scipy=scipy.__version__)
print(json.dumps(out))
`

if(import.meta.main){
  const [owner,python,output]=process.argv.slice(2)
  if(!owner||!python||!output)throw Error('Usage: bun reference-design-core-thermal.ts fuel-construction.md research-python output.json')
  const source=await Bun.file(import.meta.path).text(), document=await Bun.file(owner).text()
  const consumedPaths=['reference-design-fuel-materials.ts','reference-design-pool-boiling.ts','reference-design-fuel-construction.ts'].map(name=>new URL(name,import.meta.url).pathname)
  const consumed=await Promise.all(consumedPaths.map(async path=>({path,text:await Bun.file(path).text()})))
  const basis=parseFuelConstruction(document),geometry=fuelGeometry(basis)
  const task=Bun.spawn([python,'-c',calculation],{stdin:new Blob([JSON.stringify({basis,geometry})]),stdout:'pipe',stderr:'pipe'})
  const [stdout,stderr,exit]=await Promise.all([new Response(task.stdout).text(),new Response(task.stderr).text(),task.exited])
  if(exit)throw Error(stderr)
  if(source!==await Bun.file(import.meta.path).text()||document!==await Bun.file(owner).text())throw Error('Consumed source changed during calculation')
  for(const entry of consumed)if(entry.text!==await Bun.file(entry.path).text())throw Error('Shared equation changed during calculation')
  const result=JSON.parse(stdout)
  await Bun.write(output,JSON.stringify({sourceSha256:createHash('sha256').update(source).digest('hex'),calculationSha256:createHash('sha256').update(calculation).digest('hex'),constructionSha256:createHash('sha256').update(document).digest('hex'),sharedSources:consumed.map(entry=>({path:entry.path.split('/').pop(),sha256:createHash('sha256').update(entry.text).digest('hex')})),...result},null,2)+'\n')
  console.log(JSON.stringify({output,rows:result.rows.length,checks:result.checks.length}))
}
