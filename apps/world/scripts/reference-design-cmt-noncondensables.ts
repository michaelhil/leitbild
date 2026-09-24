/** Bounded constitutive/species/probe checks. No tank, line or instrument runtime. */
import { createHash } from 'node:crypto'
import { cetGeometry, type CetBasis } from './reference-design-cet'

export const cmtProbeBasis: CetBasis = {
  diameter_m: .003, length_m: .03, density_kg_m3: 8000, heatCapacity_J_kgK: 500,
  conductivity_W_mK: 15, leadDiameter_m: .0002, leadLength_m: .1,
  liquidFilm_W_m2K: 1000, gasFilm_W_m2K: 30, effectiveRadiationFactor: 0,
  minimumBody_C: 20, maximumBody_C: 800,
}

export function cmtProbeHeat(body: number, exposure: number, liquid?: number, gas?: number) {
  if (!Number.isFinite(body) || body < 20 || body > 800 || !Number.isFinite(exposure) || exposure < 0 || exposure > 1) throw Error('Invalid probe state')
  if (exposure > 0 && !Number.isFinite(liquid)) throw Error('Actual liquid temperature required')
  if (exposure < 1 && !Number.isFinite(gas)) throw Error('Actual gas temperature required')
  const a = cetGeometry(cmtProbeBasis).area_m2
  const ql = exposure === 0 ? 0 : a * exposure * 1000 * (liquid! - body)
  const qg = exposure === 1 ? 0 : a * (1 - exposure) * 30 * (gas! - body)
  return { body_W: ql + qg, liquid_W: -ql, gas_W: -qg }
}

const calculation = String.raw`
import json,math,CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
checks=[]
def check(name,x,bound):
 if not math.isfinite(x) or abs(x)>bound:raise ValueError((name,x,bound))
 checks.append(dict(name=name,error=x,bound=bound))
def gas(p,Ts,ncf,air):
 ps=p*(1-ncf);R=air*287+(1-air)*296.8
 rv=0 if ps==0 else P('D','P',ps,'T|gas',Ts,'Water')
 rn=p*ncf/(R*Ts);rho=rv+rn;yn=rn/rho
 cpv=0 if rv==0 else P('C','P',ps,'T|gas',Ts,'Water')
 muv=0 if rv==0 else P('V','P',ps,'T|gas',Ts,'Water')
 kv=0 if rv==0 else P('L','P',ps,'T|gas',Ts,'Water')
 cp=(1-yn)*cpv+yn*(air*1005+(1-air)*1038.8)
 mu=(1-yn)*muv+yn*(air*1.846e-5+(1-air)*1.76e-5)*(Ts/300)**.7
 k=(1-yn)*kv+yn*(air*.0262+(1-air)*.0258)*(Ts/300)**.7
 return dict(rho=rho,cp=cp,mu=mu,k=k,ync=yn,R=R)
def conductance(p,Tl,Tg,alpha,ncf,air,slip=1.,factor=1.):
 if alpha in [0,1]:return dict(A=0.,Hl=0.,Hg=0.,drag=0.,d=0.,areaOverLength=0.)
 ts=P('T','P',p,'Q',0,'Water');sigma=P('surface_tension','P',p,'Q',0,'Water')
 dr=P('D','P',p,'Q',0,'Water')-P('D','P',p,'Q',1,'Water');La=math.sqrt(sigma/(9.80665*dr))
 Dh=math.sqrt(16/math.pi);d=min(max(2*La*factor,1e-4),.9*Dh);D=min(Dh,50*La)
 l={k:P(o,'P',p,'T|liquid',Tl,'Water') for k,o in [('rho','D'),('mu','V'),('k','L'),('cp','C')]};g=gas(p,Tg,ncf,air)
 delta=l['rho']-g['rho']
 if delta<=0:raise ValueError('Positive phase density contrast required')
 ar=min(alpha,.5);adb=6*ar/d if ar<=.3 else 6*.3/d*(1-ar)/.7
 alb=0 if ar<=.3 else (4.5 if Dh<50*La else 16)/D*(ar-.3)/.7
 w=0 if alpha<=.5 else min((alpha-.5)/.25,1);scale=1 if alpha<=.5 else 2*(1-alpha)
 ub=math.sqrt(2)*(sigma*9.80665*delta/l['rho']**2)**.25*(1-alpha)**1.39
 r=D/Dh;uc0=math.sqrt(2)/2*math.sqrt(9.80665*delta*D/l['rho'])
 uc=uc0 if r<.125 else 1.13*uc0*math.exp(-r) if r<.6 else .496*uc0/math.sqrt(r)
 ud=.6*sigma**.316*(9.80665*delta)**.228/(g['rho']**.456*g['mu']**.0879)*alpha**1.4
 A=Hl=Hg=drag=areaOverLength=0.;speed=abs(slip)
 for name,a,diam,ut,c in [('bubble',(1-w)*scale*adb,d,ub,l),('cap',(1-w)*scale*alb,D,uc,l),('drop',w*6*(1-alpha)/d,d,ud,g)]:
  if a==0:continue
  Re=c['rho']*speed*diam/c['mu'];Reh=l['rho']*min(speed,ut)*diam/l['mu'];Prl=l['cp']*l['mu']/l['k']
  hl=2*math.pi**2*l['k']/diam if name=='drop' else l['k']/diam*(2+.6*math.sqrt(Reh)*Prl**(1/3))
  Reg=g['rho']*speed*diam/g['mu'];Prg=g['cp']*g['mu']/g['k'];hg=g['k']/diam*(2+.6*math.sqrt(Reg)*Prg**(1/3))
  visc=3*a*c['mu']/diam*(1+.15*Re**.687)*speed if Re<=1000 else .5*c['rho']*.44*a/4*speed**2
  distorted=a*delta*9.80665*diam/(6*ut**2)*speed**2
  A+=a;Hl+=a*hl;Hg+=a*hg;drag+=max(visc,distorted);areaOverLength+=a/(diam/2)
 return dict(A=A,Hl=Hl,Hg=Hg,drag=drag,d=d,areaOverLength=areaOverLength)

rows=[];diffusionSensitivity=[]
for p in [1e5,5e6,15.202734919352943e6]:
 ts=P('T','P',p,'Q',0,'Water')
 for ncf,air,label in [(0.,0.,'pure'),(1e-6,.4,'near-pure'),(.2,.4,'mixed'),(1.,.4,'steam-free')]:
  for alpha in [.1,.4,.9]:
   for dtl,dtg in [(-20.,20.),(-2.,100.)]:
    Tl=ts+dtl;Tg=ts+dtg;c=conductance(p,Tl,Tg,alpha,ncf,air);g=gas(p,Tg,ncf,air)
    def flux(logn,diffusionFactor=1.):
     pn=p*math.exp(logn);pi=p-pn;ti=P('T','P',pi,'Q',1,'Water')
     rv=P('D','P',pi,'Q',1,'Water');rn=pn/(g['R']*ti);yni=rn/(rv+rn)
     D=diffusionFactor*2.5e-5*((Tg+ti)/2/298.15)**1.75*101325/p
     gm=c['areaOverLength']*g['rho']*D*math.log(g['ync']/yni)
     hli=P('H','P',p,'T|liquid',ti,'Water');hvi=P('H','T',ti,'Q',1,'Water')
     ql=c['Hl']*(Tl-ti);qg=c['Hg']*(Tg-ti)
     return ql+qg-gm*(hvi-hli),gm,ti,ql,qg,hli,hvi
    if ncf==0:
     ti=ts;hli=P('H','P',p,'Q',0,'Water');hvi=P('H','P',p,'Q',1,'Water');ql=c['Hl']*(Tl-ti);qg=c['Hg']*(Tg-ti);gm=(ql+qg)/(hvi-hli)
    else:
     low=max(273.16,Tl-80);upper=math.log1p(-P('P','T',low,'Q',1,'Water')/p)
     root=brentq(lambda x:flux(x)[0],math.log(1e-14),upper,xtol=1e-12)
     residual,gm,ti,ql,qg,hli,hvi=flux(root)
     check('interface root relative balance',residual/max(abs(ql)+abs(qg),1),1e-8)
    check('paired thermal source relative balance',(-gm*hli-ql+gm*hvi-qg)/max(abs(ql)+abs(qg),1),1e-8)
    if label=='steam-free':check('steam-free evaporation sign',0 if gm>0 else 1,0)
    if label=='near-pure':check('near-pure temperature limit',ts-ti,.03)
    rows.append(dict(p=p,composition=label,alpha=alpha,Tl=Tl,Tg=Tg,Ti=ti,Gamma=gm,**c))
    if p==5e6 and label=='mixed' and alpha==.9 and dtl==-20:
     for factor in [.5,1,2]:
      r=brentq(lambda x:flux(x,factor)[0],math.log(1e-14),upper,xtol=1e-12)
      residual,gamma_i,ti_i,*_=flux(r,factor)
      check('diffusion sensitivity residual',residual/max(abs(ql)+abs(qg),1),1e-8)
      diffusionSensitivity.append(dict(factor=factor,Ti=ti_i,Gamma=gamma_i))
# Geometry blending and absence: invalid absent-state inputs must not be queried.
for alpha in [0,1]:check('absent contact bypass',conductance(float('nan'),0,0,alpha,1,.4)['A'],0)
p=5e6;ts=P('T','P',p,'Q',0,'Water');limits=[]
for a in [.3,.5,.75]:
 l=conductance(p,ts-20,ts+20,a-1e-9,.2,.4);r=conductance(p,ts-20,ts+20,a+1e-9,.2,.4)
 for k in ['A','Hl','Hg','drag']:check('alpha blend '+k,(l[k]-r[k])/max(abs(l[k]),1),1e-6)
for factor in [.5,1,2]:
 c=conductance(p,ts-20,ts+20,.9,.2,.4,factor=factor)
 limits.append(dict(sizeFactor=factor,**c))
# Exact cap species/enthalpy accounting, both directions, absent species.
cap=[]
for Y in [(1,0,0),(.7,.1,.2),(0,.4,.6)]:
 for j in [-.01,0,.01]:
  if Y[0]==0 and j<0:continue # no finite steam donor for condensation
  J=[j*(1-Y[0]),-j*Y[1],-j*Y[2]];h=[2.7e6,4e5,4.1e5]
  net=[j*y+d for y,d in zip(Y,J)]
  check('cap NC impermeability',max(abs(net[1]),abs(net[2])),1e-15)
  check('cap steam-only enthalpy',j*sum(y*x for y,x in zip(Y,h))+sum(d*x for d,x in zip(J,h))-j*h[0],1e-10)
  check('cap total diffusive mass',sum(J),1e-15)
  cap.append(dict(Y=Y,j=j,diffusion=J,net=net))
# Pure-water recoil limit and mixture density: same mechanical law, not a cap solution.
pi=5e6;ti=P('T','P',pi,'Q',1,'Water');rv=P('D','P',pi,'Q',1,'Water');rl=P('D','P',pi,'Q',0,'Water')
recoil=[]
for pn in [0,1e5]:
 rg=rv+pn/(293*ti);j=.01;dp=j*j*(1/rg-1/rl)
 if pn==0:check('pure-cap recoil limit',dp-j*j*(1/rv-1/rl),0)
 recoil.append(dict(steamPartialPressure=pi,totalGasPressure=pi+pn,gasDensity=rg,recoilPressure=dp))
# Dry mixed-NC two-face capacity: analytic native energy adiabat, unchanged meter area.
R=.4*287+.6*296.8;cv=.4*718+.6*742;cp=cv+R;gamma=cp/cv
pu=1e6;pd=.99e6;Tu=500.;A=math.pi*.2**2/4;ae=.01162074;rho=pu/(R*Tu)
def capacity(m):
 vu=m/(rho*A);T0=Tu+vu*vu/(2*cp);p0=pu*(T0/Tu)**(gamma/(gamma-1));pc=p0*(2/(gamma+1))**(gamma/(gamma-1));pt=max(pd,pc)
 T=Tu*(pt/pu)**((gamma-1)/gamma);return ae*pt/(R*T)*math.sqrt(vu*vu+2*cp*(Tu-T))
m=brentq(lambda m:m-capacity(m),1e-12,20);vu=m/(rho*A);H0=cp*Tu-cv*298.15+vu*vu/2
Td=brentq(lambda T:cp*T-cv*298.15+.5*(m*R*T/(pd*A))**2-H0,450,550)
vd=m*R*Td/(pd*A);entropy=cp*math.log(Td/Tu)-R*math.log(pd/pu)
check('two-face shared total enthalpy',cp*Td-cv*298.15+vd*vd/2-H0,1e-7)
check('subsonic donor and receiver',max(0,vu/math.sqrt(gamma*R*Tu)-1,vd/math.sqrt(gamma*R*Td)-1),0)
check('nonnegative ideal NC recovery entropy',min(0,entropy),1e-10)
print(json.dumps(dict(scope='Local CMT NC source/property/limit and ideal-NC meter checks; no finite CMT or source-succession trajectory',dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),contacts=rows,sizeSensitivity=limits,diffusionSensitivity=diffusionSensitivity,capAccounting=cap,recoilAccounting=recoil,dryDevice=dict(massRate=m,donorT=Tu,receiverT=Td,entropyIncrease=entropy),checks=checks),sort_keys=True,allow_nan=False))
`

if (import.meta.main) {
  const [python, output] = process.argv.slice(2)
  if (!python) throw Error('Provide isolated research Python and optional receipt path')
  const paths = [import.meta.path, new URL('./reference-design-cet.ts', import.meta.url).pathname]
  const sources = await Promise.all(paths.map(p => Bun.file(p).text()))
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const child = Bun.spawn([python, '-c', calculation], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status !== 0) throw Error(err)
  for (let i = 0; i < paths.length; i++) if (await Bun.file(paths[i]!).text() !== sources[i]) throw Error('Consumed source changed')
  const probe = { geometry: cetGeometry(cmtProbeBasis), mixedHeat: cmtProbeHeat(150, .1, 100, 300),
    halfDoubleFilmTimes: [.5, 1, 2].map(f => ({ factor: f, ...cetGeometry({ ...cmtProbeBasis, liquidFilm_W_m2K: 1000 * f, gasFilm_W_m2K: 30 * f }) })) }
  const receipt = JSON.stringify({ sourceSha256: hash(sources[0]!), calculationSha256: hash(calculation), sharedProbeSha256: hash(sources[1]!), probe, ...JSON.parse(out) }, null, 2) + '\n'
  if (output) await Bun.write(output, receipt)
  else console.log(receipt)
}
