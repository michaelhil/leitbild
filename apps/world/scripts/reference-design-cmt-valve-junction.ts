/** Offline equal-bore, weak-wave liquid valve boundary. Not a transient or exact Riemann solver. */
import { createHash } from 'node:crypto'
import { deliverySetup } from './reference-design-cmt-delivery.ts'
import { stationaryValvePython } from './reference-design-cmt-valve-law.ts'


export const valveJunctionCalculation = deliverySetup + stationaryValvePython + String.raw`
rows=[];alphas=[0.,1.,.1,.01,.001,.0001,.00001,.000001]
for name,pressure in [('original-forward',15.19e6),('compatible-rest',15.2e6),('original-reverse',15.21e6)]:
    x=initial(pressure);native,cv,pv,r=decode(x)
    L=valve_port(pv[1][-1,1]);R=valve_port(cv[1][0,0])
    values=[dict(alpha=a,**stationary_valve(L,R,a)) for a in alphas]
    if name!='compatible-rest':
        flows=[abs(v['massFlow_kg_s']) for v in values[1:]]
        if not all(a>b for a,b in zip(flows,flows[1:])):raise ValueError('Valve closure did not reduce transmitted flow')
        check('valve limiting flow/alpha ratio relative',abs(flows[-1]/alphas[-1]/(flows[-2]/alphas[-2])-1),.01)
    rows.append(dict(case=name,left=L,right=R,samples=values))
def fixture(p,T,v):
    q=liquid_pt_si(p,T);return dict(**valve_hp(q['p'],q['h']),v=v)
for name,L,R in [('hot-left-donor',fixture(15.21e6,563.15,0),fixture(15.2e6,313.15,0)),
  ('hot-right-donor',fixture(15.2e6,313.15,0),fixture(15.21e6,563.15,0)),
  ('stationary-thermal-contact',fixture(15.2e6,563.15,0),fixture(15.2e6,313.15,0)),
  ('inertia-opposes-static-pressure',fixture(15.201e6,313.15,-.01),fixture(15.2e6,313.15,-.01))]:
    values=[dict(alpha=a,**stationary_valve(L,R,a)) for a in [0.,1.,.01,.000001]]
    if name=='inertia-opposes-static-pressure' and values[1]['donor']!='right':raise ValueError('Static pressure incorrectly chose moving donor')
    if name=='stationary-thermal-contact' and any(v['massFlow_kg_s']!=0 or v['energyFlow_W']!=0 or v['donor'] is not None for v in values):raise ValueError('Stationary thermal contact transferred material or selected a donor')
    rows.append(dict(case=name,left=L,right=R,samples=values))
for left,right in zip(rows[3]['samples'],rows[4]['samples']):
    check('mirrored hot donor mass kg/s',left['massFlow_kg_s']+right['massFlow_kg_s'],1e-9)
    check('mirrored hot donor energy W',left['energyFlow_W']+right['energyFlow_W'],1e-5)
for alpha in [1.,.5]:
    up=fixture(15.2e6,313.15,0.);m=25.;up['v']=m/(A*up['rho']);H=up['h']+up['v']**2/2
    pd=up['p']-Kvalve*ref['rho']/up['rho']*(m/alpha)**2
    hd=brentq(lambda h:h+.5*(m/(A*valve_hp(pd,h)['rho']))**2-H,H-up['v']**2-1,H,xtol=1e-7)
    down=valve_hp(pd,hd);down['v']=m/(A*down['rho'])
    value=stationary_valve(up,down,alpha)
    check('steady reference mass kg/s',value['massFlow_kg_s']-m,1e-6)
    rows.append(dict(case='steady-reference',left=up,right=down,samples=[dict(alpha=alpha,**value)]))
allValues=[v for row in rows for v in row['samples']]
check('tested weak-wave Mach',max(v['maximumMach'] for v in allValues),.001)
check('tested pressure perturbation fraction',max(v['maximumRelativePressureChange'] for v in allValues),.01)
print(json.dumps(dict(input=data,cases=rows,checks=checks,stationaryBoundaryChecksPassed=True,
  installedTransientQualified=False,timeIntegrationTested=False,pressureIntegrityQualified=False,liveRuntime=False),allow_nan=False))
`

if (import.meta.main) {
  const [retainedReceipt, python] = Bun.argv.slice(2)
  if (!retainedReceipt || !python || Bun.argv.length !== 4) throw Error('Usage: cmt-valve-junction.ts retained-delivery.json python')
  const baseline = await Bun.file(retainedReceipt).json()
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  if (!baseline.input?.delivery || !baseline.input?.pipeMesh || typeof baseline.calculationHash !== 'string') throw Error('Expected retained delivery receipt')
  const input = JSON.stringify(baseline.input)
  if (baseline.inputHash !== hash(input)) throw Error('Retained input identity mismatch')
  const identity = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(valveJunctionCalculation), inputHash: hash(input), retainedCalculationHash: baseline.calculationHash }
  const child = Bun.spawn([python, '-c', valveJunctionCalculation], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'inherit' })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) throw Error('Stationary valve boundary rejected')
  console.log(JSON.stringify({ ...identity, ...JSON.parse(out) }, null, 2))
}
