/** Bounded native RHR work-stage coupons; no running plant, machine-map or trajectory claim. */
import { createHash } from 'node:crypto'
import { nativeMaterialFunctions } from './reference-design-rhr-material-wave'

const calculation = nativeMaterialFunctions + String.raw`
from scipy.optimize import root
# A named comparison bracket includes the declared cold liquid domain. This is
# not a physical cutoff or a silent fallback from the exported native law.
def ph(p,h,ratios):
    if sum(ratios.values())==0:return water(p,h)
    return material(p,brentq(lambda T:material(p,T,ratios)['h']-h,290,700,xtol=1e-9),ratios)
def nc(p,T,ratios):
    total=sum(ratios.values());R=sum(m*species[n][0] for n,m in ratios.items())/total
    cv=sum(m*species[n][1] for n,m in ratios.items())/total
    h=cv*(T-298.15)+R*T;v=R*T/p
    return dict(p=p,T=T,h=h,e=h-p*v,v=v,branch='water-free')
def state(p,T,ratios,waterFree):return nc(p,T,ratios) if waterFree else material(p,T,ratios)
def inverse(p,h,ratios,waterFree):
    if not waterFree:return ph(p,h,ratios)
    total=sum(ratios.values());R=sum(m*species[n][0] for n,m in ratios.items())/total
    cv=sum(m*species[n][1] for n,m in ratios.items())/total
    return nc(p,(h+cv*298.15)/(cv+R),ratios)
def recover(M,U,V,initial,ratios,waterFree):
    def residual(x):
        q=state(math.exp(x[0]),math.exp(x[1]),ratios,waterFree)
        return [M*q['v']/V-1,(M*q['e']-U)/max(abs(U),1.)]
    sol=root(residual,[math.log(initial['p']),math.log(initial['T'])],tol=1e-11)
    if not sol.success:raise ValueError(sol.message)
    check('finite native recovery dimensionless residual',max(abs(z) for z in residual(sol.x)),1e-11)
    q=state(math.exp(sol.x[0]),math.exp(sol.x[1]),ratios,waterFree)
    check('finite native volume recovery',M*q['v']/V-1,1e-10)
    check('finite native internal energy recovery',M*q['e']-U,1e-4)
    return q
rows=[]
wet=prepared(90000.,313.15,.05)
dry={'air':.1,'nitrogen':.1}
cases=[('pure-water',1e6,423.15,{'air':0.,'nitrogen':0.},False,200000.),
       ('pool-wet-NC',90000.,313.15,wet,False,10000.),
       ('pool-dry-water-NC',90000.,450.,dry,False,10000.),
       ('pool-water-free',90000.,313.15,{'air':.5,'nitrogen':.5},True,10000.)]
for name,p,T,ratios,waterFree,dp in cases:
    donor=state(p,T,ratios,waterFree)
    for direction in [-1,1]:
        ps=p+direction*dp
        run=solve_ivp(lambda pp,y:[inverse(pp,float(y[0]),ratios,waterFree)['v']],(p,ps),[donor['h']],rtol=2e-10,atol=1e-5,dense_output=True,max_step=dp/8)
        if not run.success:raise ValueError(run.message)
        hs=float(run.y[0,-1]);stage=inverse(ps,hs,ratios,waterFree);dh=hs-donor['h'];C=dh/(ps-p)
        # LOWER's first-order hydrostatic trace is the tangent h=hd+vd*dp.
        # Compare native work, not the approximate mixture entropy potential.
        tangentExcess=donor['h']+donor['v']*(ps-p)-hs
        check(name+' first-order trace native work admissibility',min(0.,tangentExcess),1e-4)
        if waterFree:
            total=sum(ratios.values());Rnc=sum(m*species[n][0] for n,m in ratios.items())/total
            cvnc=sum(m*species[n][1] for n,m in ratios.items())/total
            donorSound=math.sqrt((1+Rnc/cvnc)*Rnc*donor['T'])
            stageSound=math.sqrt((1+Rnc/cvnc)*Rnc*stage['T'])
        else:
            donorSound=sound(p,donor['h'],ratios)
            stageSound=sound(ps,hs,ratios)
        if not all(math.isfinite(c) and c>0 for c in [donorSound,stageSound]):raise ValueError('Nonhyperbolic native endpoint')
        if waterFree:
            total=sum(ratios.values());Rnc=sum(m*species[n][0] for n,m in ratios.items())/total
            cvnc=sum(m*species[n][1] for n,m in ratios.items())/total
            analyticT=T*(ps/p)**(Rnc/(cvnc+Rnc))
            check('independent water-free ideal-gas adiabat enthalpy',hs-nc(ps,analyticT,ratios)['h'],1e-4)
        # Independent midpoint pressure-work quadrature on the integrated path.
        count=128;step=(ps-p)/count
        work=sum(inverse(p+(j+.5)*step,float(run.sol(p+(j+.5)*step)[0]),ratios,waterFree)['v']*step for j in range(count))
        check(name+' native enthalpy-work ratio',dh/work-1,1e-5)
        if C<=0 or direction*dh<=0:raise ValueError('Wrong signed native work')
        if name=='pure-water':check('unchanged pure-water isentrope',hs-P('H','P',ps,'S',donor['s'],'Water'),1e-4)
        tiny=p*1e-6
        near=solve_ivp(lambda pp,y:[inverse(pp,float(y[0]),ratios,waterFree)['v']],(p,p+direction*tiny),[donor['h']],rtol=2e-10,atol=1e-5)
        if not near.success:raise ValueError(near.message)
        check(name+' zero-step C equals actual donor v',(float(near.y[0,-1])-donor['h'])/(direction*tiny)/donor['v']-1,1e-5)
        # Signed characteristic work incidence: m and pressure increment reverse
        # together, while retained casing density is not substituted for donor v.
        m=direction*.1;omega=100.;dpE=dp
        torque=m*dpE*C/omega;power=abs(m)*dh
        check(name+' signed torque-work incidence',omega*torque-power,1e-7)
        # A prescribed 1 g transaction, not a pressure-driven trajectory. Both
        # independent rigid 10 kg native recipients change their actual PT.
        dm=.001;M=10.;U=M*donor['e'];V=M*donor['v']
        paid=dm*dh
        afterDonor=recover(M-dm,U-dm*donor['h'],V,donor,ratios,waterFree)
        afterReceiver=recover(M+dm,U+dm*hs,V,donor,ratios,waterFree)
        defect=(M-dm)*afterDonor['e']+(M+dm)*afterReceiver['e']-2*U-paid
        check(name+' once-only finite donor receiver work',defect,1e-4)
        rows.append(dict(name=name,direction=direction,ratios=ratios,donor=donor,stage=stage,donorSound=donorSound,stageSound=stageSound,tangentExcess=tangentExcess,work=dh,integratedWork=work,workSlope=C,torque=torque,power=power,packetMass=dm,packetWork=paid,donorAfter=afterDonor,receiverAfter=afterReceiver,energyDefect=defect))
print(json.dumps(dict(scope='Eight frozen native work paths and prescribed 1 g finite native transactions, including 90 kPa wet/dry/water-free pool material; no attained flow, rotor trajectory, map, protective accumulation or endurance',libraries=dict(CoolProp=CoolProp.__version__,SciPy=scipy.__version__),rows=rows,checks=checks)))
`

if (import.meta.main) {
  const [python, ...extra] = process.argv.slice(2)
  if (!python || extra.length) throw new Error('Usage: <research-python-with-CoolProp-and-SciPy>')
  const paths = [import.meta.path, new URL('./reference-design-rhr-material-wave.ts', import.meta.url).pathname]
  const before = await Promise.all(paths.map(path => Bun.file(path).text()))
  const child = Bun.spawn([python, '-c', calculation], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(err || 'Native RHR stage comparison failed')
  for (let i = 0; i < paths.length; i++) if (await Bun.file(paths[i]!).text() !== before[i]) throw new Error('Source changed during comparison')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  console.log(JSON.stringify({ sources: paths.map((path, i) => ({ path, sha256: hash(before[i]!) })), calculationSha256: hash(calculation), ...JSON.parse(out) }, null, 2))
}
