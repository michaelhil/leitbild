/** Offline PZR material/interface checks, not a vessel integrator or a calibrated gas model. */
import { createHash } from 'node:crypto'

export function noncondensableTotals(air: number, nitrogen: number, temperature: number) {
  if (![air, nitrogen, temperature].every(Number.isFinite) || air < 0 || nitrogen < 0 || temperature <= 0) throw Error('Physical constituent state required')
  const mass = air + nitrogen
  const mR = air * 287 + nitrogen * 296.8
  const mCv = air * 718 + nitrogen * 742
  return { mass, mR, mCv, internalEnergy: mCv * (temperature - 298.15), enthalpy: mCv * (temperature - 298.15) + mR * temperature }
}

const calculation = String.raw`
import json,math,CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq,least_squares
checks=[]
def check(name,error,bound):
 if not math.isfinite(error) or abs(error)>bound:raise ValueError((name,error,bound))
 checks.append(dict(name=name,error=error,bound=bound))
def nc(a,n):return a*287+n*296.8,a*718+n*742
def liquid(p,T):
 return dict(rho=P('D','P',p,'T|liquid',T,'Water'),u=P('U','P',p,'T|liquid',T,'Water'))
def gas(pv,T):
 if pv==0:return dict(rho=0.,u=0.)
 return dict(rho=P('D','P',pv,'T|gas',T,'Water'),u=P('U','P',pv,'T|gas',T,'Water'))

# Reconstruct actual separate phase energies, shared volume and partial pressure.
# The manufactured states check the inverse and species bookkeeping, not dynamics.
inversions=[]
for p in [1e5,1e6,16e6,19e6]:
 for airFraction,ncFraction in [(0.,0.),(0.,.2),(1.,.2),(.4,.2),(.4,1.)]:
  V=.01;vg=.008;pv=p*(1-ncFraction);Ts=P('T','P',p,'Q',0,'Water');tl=Ts-20;tg=Ts+30
  Rnc=airFraction*287+(1-airFraction)*296.8
  mnct=(p-pv)*vg/(Rnc*tg);ma=mnct*airFraction;mn=mnct-ma;mR,mCv=nc(ma,mn)
  l=liquid(p,tl);v=gas(pv,tg);ml=(V-vg)*l['rho'];mv=vg*v['rho'];Ul=ml*l['u'];Ug=mv*v['u']+mCv*(tg-298.15)
  def state(x):
   vg1=x[0]*V;tl1=x[1]*300;tg1=x[2]*300
   pv1=0. if mv==0 else P('P','D|gas',mv/vg1,'T',tg1,'Water')
   p1=pv1+mR*tg1/vg1;l1=liquid(p1,tl1);v1=gas(pv1,tg1)
   return vg1,tl1,tg1,pv1,p1,l1,v1
  def residual(x):
   vv,ll,gg,ppv,pp,ls,vs=state(x)
   return [(ml/ls['rho']+vv-V)/V,(ml*ls['u']-Ul)/max(abs(Ul),1.),(mv*vs['u']+mCv*(gg-298.15)-Ug)/max(abs(Ug),1.)]
  sol=least_squares(residual,[vg/V*.999,tl/300*1.0001,tg/300*.9999],bounds=([.01,.92,.92],[.99,3.,4.]),xtol=1e-12,ftol=1e-12,gtol=1e-12,max_nfev=80)
  if not sol.success:raise ValueError(sol.message)
  vv,ll,gg,ppv,pp,ls,vs=state(sol.x)
  check('native two-temperature residual',max(abs(r) for r in residual(sol.x)),1e-9)
  check('native pressure recovery',(pp-p)/p,1e-8)
  check('liquid history recovery',ll-tl,1e-5)
  check('gas history recovery',gg-tg,1e-5)
  if mv:check('stable gas is not supersaturated',max(0.,P('T','P',ppv,'Q',1,'Water')-gg),1e-6)
  Hv=0. if mv==0 else mv*(vs['u']+ppv/vs['rho'])
  check('gas H equals U plus total gas pV',Hv+mCv*(gg-298.15)+mR*gg-(Ug+pp*vv),.001)
  inversions.append(dict(p=p,pv=pv,air=ma,nitrogen=mn,liquid=ml,steam=mv,liquid_K=ll,gas_K=gg,volume=V,gasVolume=vv))

# Independent evaluation of the existing effective diffusion/thermal law, with
# both NC identities retained. Conductances are fixture inputs, not calibration.
interfaces=[]
for p in [1e5,1e6,16e6,19e6]:
 for airFraction,ncFraction in [(0.,.1),(1.,.1),(.4,.1),(.4,1.),(.4,1e-6)]:
  Ts=P('T','P',p,'Q',0,'Water');Tl=Ts-10;Tg=Ts+20;pv=p*(1-ncFraction)
  Rnc=airFraction*287+(1-airFraction)*296.8;rv=gas(pv,Tg)['rho'];rn=p*ncFraction/(Rnc*Tg);rho=rv+rn
  A=1.;d=.003;hl=1000.;hg=100.
  def flux(logNC):
   # Resolve the small positive NC pressure directly instead of subtracting
   # two nearly equal total/saturation pressures at the pure-water limit.
   pn=p*math.exp(logNC);pi=p-pn;Ti=P('T','P',pi,'Q',1,'Water')
   ri=P('D','P',pi,'Q',1,'Water');ni=pn/(Rnc*Ti)
   Ync_i=ni/(ri+ni);Ync_bulk=rn/rho
   D=2.5e-5*((Tg+Ti)/2/298.15)**1.75*101325/p
   gamma=A*rho*D/(d/2)*math.log(Ync_bulk/Ync_i)
   hli=P('H','P',p,'T|liquid',Ti,'Water');hvi=P('H','T',Ti,'Q',1,'Water')
   Ql=A*hl*(Tl-Ti);Qg=A*hg*(Tg-Ti)
   return Ql+Qg-gamma*(hvi-hli),gamma,Ql,Qg,hli,hvi,Ti
  Tmin=max(273.16,Tl-100);upper=math.log1p(-P('P','T',Tmin,'Q',1,'Water')/p)
  # Comparison search interval only: no persistent physical NC floor.
  x=brentq(lambda x:flux(x)[0],math.log(1e-14),upper,xtol=1e-12)
  r,gm,ql,qg,hl_i,hg_i,Ti=flux(x)
  check('mixed NC interface energy',r,.002)
  check('opposite thermal sources',(-gm*hl_i-ql)+(gm*hg_i-qg),.002)
  if ncFraction==1:check('evaporation into steam-free mixed gas',0 if gm>0 else 1,0)
  if ncFraction==1e-6:check('approaches pure-water interface',Ts-Ti,.02)
  interfaces.append(dict(p=p,airFractionOfNC=airFraction,ncPressureFraction=ncFraction,Ti=Ti,waterSaturation_K=Ts,Gamma=gm))

# Finite gas-only receipt, no shared-liquid state to reset. The incoming ideal
# gas enthalpy includes flow work; retain directed momentum and recover thermal
# energy from total energy after subtracting its retained kinetic energy once.
V=.01;ma=.02;mn=.03;T0=500.;dm=.001;Td=600.;speed=10.;mR,mCv=nc(ma,mn);U0=mCv*(T0-298.15)
hin=742*(Td-298.15)+296.8*Td+.5*speed**2
P1=dm*speed;M1=ma+mn+dm;K1=P1**2/(2*M1);E1=U0+dm*hin
mR1,mCv1=nc(ma,mn+dm);T1=298.15+(E1-K1)/mCv1;p1=mR1*T1/V
check('finite gas native energy',mCv1*(T1-298.15)+K1-E1,1e-9)
if T1<=T0:raise ValueError('Missing incoming thermal response')
print(json.dumps(dict(scope='Offline native material inversion, prescribed-conductance interface and finite gas-only receipt; not a PZR transient or empirical NC calibration',dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),inversions=inversions,interfaces=interfaces,gasReceipt=dict(volume=V,initialT=T0,finalT=T1,finalPressure=p1,air=ma,nitrogen=mn+dm,energy=E1,momentum=P1),checks=checks),sort_keys=True,allow_nan=False))
`

if (import.meta.main) {
  const python = process.argv[2]
  if (!python) throw Error('Provide isolated research Python')
  const source = await Bun.file(import.meta.path).text()
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const child = Bun.spawn([python, '-c', calculation], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status !== 0) throw Error(err)
  if (await Bun.file(import.meta.path).text() !== source) throw Error('Source changed during comparison')
  const result = JSON.stringify({ sourceSha256: hash(source), calculationSha256: hash(calculation), ...JSON.parse(out) }, null, 2)
  if (process.argv[3]) await Bun.write(process.argv[3], result + '\n')
  else console.log(result)
}
