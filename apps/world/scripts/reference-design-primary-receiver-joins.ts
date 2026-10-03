/** Bounded PREBUILD geometry/material coupons, never a running plant or vent trajectory. */
import { createHash } from 'node:crypto'
import { nativeMaterialFunctions } from './reference-design-rhr-material-wave'

export function freeMoment(grossVolume: number, grossMoment: number, occupied: { volume: number; center: number }[]) {
  const volume = grossVolume - occupied.reduce((sum, part) => sum + part.volume, 0)
  const moment = grossMoment - occupied.reduce((sum, part) => sum + part.volume * part.center, 0)
  if (!(volume > 0)) throw new Error('No available plenum volume')
  return { volume, moment, center: moment / volume }
}

export function ventReceiver(hasLiquid: boolean, surface: number, pressure: number, density: number) {
  const covered = hasLiquid && surface > -2
  return { donor: covered ? 'SUMP' : 'CNV', pressure: pressure + (covered ? density * 9.80665 * (surface + 2) : 0) }
}

const calculation = nativeMaterialFunctions + String.raw`
from scipy.optimize import root
g=9.80665
# Comparison geometry: one 0.085 m3 immersed body, not a complete assembly map.
Vb=.085;V=33.5-Vb;zbody=2.5;zc=(100.5-Vb*zbody)/V
def recover(Mw,Ma,Mn,U,V,p,T):
    Mt=Mw+Ma+Mn
    if Mw==0:
        cap=Ma*718+Mn*742
        T=298.15+U/cap;p=(Ma*287+Mn*296.8)*T/V
        return dict(p=p,T=T,e=U/Mt,h=(U+p*V)/Mt,v=V/Mt,ml=0.,pv=0.,branch='water-free')
    ratios={'air':Ma/Mw,'nitrogen':Mn/Mw}
    def residual(x):
        q=material(math.exp(x[0]),math.exp(x[1]),ratios)
        return [Mt*q['v']/V-1,(Mt*q['e']-U)/max(abs(U),1)]
    sol=root(residual,[math.log(p),math.log(T)],tol=1e-10)
    if not sol.success:raise ValueError(sol.message)
    check('native recovery residual',max(abs(x) for x in residual(sol.x)),1e-9)
    return material(math.exp(sol.x[0]),math.exp(sol.x[1]),ratios)
def initial(name,p,T,ratios):
    q=material(p,T,ratios);Mt=V/q['v'];Mw=Mt/(1+sum(ratios.values()))
    return dict(name=name,q=q,Mw=Mw,Ma=Mw*ratios['air'],Mn=Mw*ratios['nitrogen'],U=Mt*q['e'])
air=prepared(1e6,423.15,.1);air={'air':air['air']*2,'nitrogen':0.}
nc=prepared(1e6,423.15,.1)
cases=[initial('liquid',1e6,423.15,{'air':0.,'nitrogen':0.}),
       initial('wet-air',1e6,423.15,air),initial('wet-air-nitrogen',1e6,423.15,nc),
       initial('dry-steam-air-nitrogen',1e6,500.,{'air':1.,'nitrogen':1.}),
       initial('nitrogen-only-NC',1e6,423.15,{'air':0.,'nitrogen':2*nc['nitrogen']})]
rows=[]
for a in cases:
    q=a['q'];Mt=a['Mw']+a['Ma']+a['Mn'];E=a['U']+Mt*g*zc
    r=recover(a['Mw'],a['Ma'],a['Mn'],E-Mt*g*zc,V,q['p'],q['T'])
    check(a['name']+' retained native temperature',r['T']-q['T'],1e-6)
    check(a['name']+' retained native pressure',r['p']/q['p']-1,1e-8)
    ratios={'air':a['Ma']/a['Mw'],'nitrogen':a['Mn']/a['Mw']}
    ports=[]
    for z in [2.,2.5,4.]:
        pf=q['p']-Mt/V*g*(z-zc);hf=q['h']-g*(z-zc)
        f=ph(pf,hf,ratios)
        check('one UPPER port total enthalpy',hf+g*z-q['h']-g*zc,1e-9)
        run=solve_ivp(lambda p,y:[ph(p,float(y[0]),ratios)['v']],(q['p'],pf),[q['h']],rtol=1e-10,atol=1e-6,max_step=abs(pf-q['p'])/8)
        if not run.success:raise ValueError(run.message)
        excess=hf-float(run.y[0,-1]);check('UPPER native tangent excess',min(0.,excess),1e-4)
        ports.append(dict(z=z,p=pf,h=hf,T=f['T'],branch=f['branch'],tangentExcess=excess))
    # Steam occupies the SAME Vg as each NC species, not added independent volumes.
    if a['Ma']+a['Mn']>0:
        ml=Mt*q['ml'];vg=V-(ml/P('D','P',q['p'],'T',q['T'],'Water') if ml>0 else 0)
        pa=a['Ma']*287*q['T']/vg;pn=a['Mn']*296.8*q['T']/vg
        check('shared gas-volume partial pressures',(q['pv']+pa+pn)/q['p']-1,1e-8)
    # Translating a fully submerged solid changes free-water PE, not U.
    dz=.3;zc2=(100.5-Vb*(zbody+dz))/V;W=Mt/V*g*Vb*dz
    check('buoyancy and native displaced PE',Mt*g*(zc2-zc)+W,1e-8)
    check('no spurious translation heat',(E-W)-Mt*g*zc2-a['U'],1e-4)
    check('100m datum invariance',(E+Mt*g*100)-Mt*g*(zc+100)-a['U'],1e-4)
    rows.append(dict(name=a['name'],bulk=q,ports=ports,buoyancyWork=W))
# Actual donor changes with sign; two equal-volume unequal native states exchange a prescribed
# 1g homogeneous packet. This checks native receipt, not achieved hydraulics.
transactions=[]
for sign in [-1,1]:
    donor=cases[1 if sign>0 else 3];receiver=cases[3 if sign>0 else 1]
    dm=.001;Mt=sum(donor[k] for k in ['Mw','Ma','Mn']);Ht=donor['q']['h']+g*zc
    outcomes=[]
    for obj,inc in [(donor,-1),(receiver,1)]:
        masses={k:obj[k]+inc*dm*donor[k]/Mt for k in ['Mw','Ma','Mn']}
        oldMt=sum(obj[k] for k in masses);newMt=sum(masses.values())
        E=obj['U']+oldMt*g*zc+inc*dm*Ht;U=E-newMt*g*zc
        q=recover(masses['Mw'],masses['Ma'],masses['Mn'],U,V,obj['q']['p'],obj['q']['T'])
        outcomes.append(dict(masses=masses,E=newMt*(q['e']+g*zc),q=q))
    for k in ['Mw','Ma','Mn']:
        check('signed actual donor '+k,sum(o['masses'][k] for o in outcomes)-donor[k]-receiver[k],1e-9)
    oldE=sum(o['U']+sum(o[k] for k in ['Mw','Ma','Mn'])*g*zc for o in [donor,receiver])
    check('signed native receipt total energy',sum(o['E'] for o in outcomes)-oldE,.02)
    transactions.append(dict(sign=sign,donor=donor['name'],receiver=receiver['name'],packet=dm,outcomes=outcomes))
# Water-free air endpoint arithmetic, not execution of the PRHR contact evaluator.
# It is a noncondensing gas even with MN=0; no water EOS lookup.
Ma=1.;Mn=0.;T=400.;U=Ma*718*(T-298.15);gas=recover(0,Ma,Mn,U,1.,1e5,T)
check('dry air temperature',gas['T']-T,1e-12)
check('dry air pressure',gas['p']-Ma*287*T,1e-8)
condensation=0. if gas['pv']==0 else math.nan
check('dry-air no steam condensation demand',condensation,0.)
print(json.dumps(dict(scope='Five frozen native plenum materials, actual-height traces, two prescribed 1g receipts and analytic displaced-body/dry-air endpoints; not a transient, actual assembly map or cooling success',libraries=dict(CoolProp=CoolProp.__version__,SciPy=scipy.__version__),geometry=dict(V=V,zc=zc,Vbody=Vb),rows=rows,transactions=transactions,dryAir=gas,checks=checks)))
`

if (import.meta.main) {
  const [python, ...extra] = process.argv.slice(2)
  if (!python || extra.length) throw new Error('Usage: <research-python-with-CoolProp-and-SciPy>')
  const paths = [import.meta.path, new URL('./reference-design-rhr-material-wave.ts', import.meta.url).pathname]
  const before = await Promise.all(paths.map(path => Bun.file(path).text()))
  const child = Bun.spawn([python, '-c', calculation], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(err || 'Primary receiver coupon failed')
  for (let i = 0; i < paths.length; i++) if (await Bun.file(paths[i]!).text() !== before[i]) throw new Error('Source changed during comparison')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  console.log(JSON.stringify({ sources: paths.map((path, i) => ({ path, sha256: hash(before[i]!) })), calculationSha256: hash(calculation), ...JSON.parse(out) }, null, 2))
}
