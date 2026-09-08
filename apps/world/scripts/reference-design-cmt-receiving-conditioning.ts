/** One retained receipt-step coordinate diagnostic; no changed receiving physics or trajectory. */
import { createHash } from 'node:crypto'
import { parseReceivingBasis, receivingCalculation, receivingDefinitions } from './reference-design-cmt-receiving'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const retainedCalculationHash = '717f689a4ceecb20782dbf3278c90be8846755350c83c80b2cbfcf7c9d3acb73'

export function diagnosticOrigin(value: unknown, owner: string) {
  if (!value || typeof value !== 'object') throw new Error('Expected retained receipt artifact')
  const origin = value as Record<string, any>
  const { case: caseId, ...basis } = origin.input ?? {}
  if (origin.calculationHash !== retainedCalculationHash || hash(receivingCalculation) !== retainedCalculationHash ||
    JSON.stringify(basis) !== JSON.stringify(parseReceivingBasis(owner)) || caseId !== 'eight_fine' ||
    !Array.isArray(origin.cases) || origin.cases.length !== 1) throw new Error('Origin source/input/case mismatch')
  const c = origin.cases[0]
  if (c.name !== 'eight_fine' || c.status !== 'REJECTED' || c.attemptedTime_s !== 9.8 ||
    c.lastAcceptedState?.t_s !== 9.75 || typeof c.reason !== 'string' ||
    !c.reason.startsWith('Receipt local residual: ')) throw new Error('Expected exact retained 9.80 s rejection')
  return { ...basis, diagnostic: { reason: c.reason, state: c.lastAcceptedState } }
}

export const conditioningTail = String.raw`
import ast,platform,scipy,iapws
d=b['diagnostic'];retained=ast.literal_eval(d['reason'].split('Receipt local residual: ',1)[1])
old=d['state'];mm=np.array(old['masses_kg']);ss=np.array(old['entropies_J_kgK'])
N=len(mm);dt=.05;tol=1e-12;headScale=100.;checks=0
def require(ok,message):
    global checks
    checks+=1
    if not ok:raise ValueError(message)
require(N==8 and len(retained['old'])==len(retained['trial'])==2*N+4,'Retained state dimensions')
require(all(np.all(np.isfinite(retained[k])) for k in ['old','trial','residual']),'Finite retained vectors')
# Intercept only this test's root dependency to capture the actual receiving residual.
# Neither the baseline source nor its equations are rewritten or copied into this file.
scipy_root=root;captured={}
def capture(fun,x0,**kwargs):
    captured.update(fun=fun,x0=x0.copy(),options=kwargs.copy())
    sol=scipy_root(fun,x0,**kwargs);captured['solution']=sol
    return sol
root=capture;started=time.perf_counter()
try:
    receipt(mm,ss,old['tank'],old['plenum'],old['calorimeter_K'],dt,True,tol)
    original=dict(status='ACCEPTED')
except ValueError as error:
    original=dict(status='REJECTED',reason=str(error))
finally:root=scipy_root
original['wall_s']=time.perf_counter()-started
require('fun' in captured and 'solution' in captured,'Actual receipt solver callback captured')
fun=captured['fun'];x0=captured['x0'];sol=captured['solution']
require(np.array_equal(x0,np.array(retained['old'])),'Exact original initial vector')
original.update(nfev=int(sol.nfev),message=str(sol.message),solverSuccess=bool(sol.success),
  residual=fun(sol.x).tolist(),trial=sol.x.tolist())
require(original['status']=='REJECTED' and original['reason'].startswith('Receipt local residual: '),
  'Original rejection is the retained local-residual failure')
require(sol.nfev==retained['nfev'] and str(sol.message)==retained['message'] and
  np.array_equal(sol.x,np.array(retained['trial'])) and
  np.array_equal(fun(sol.x),np.array(retained['residual'])),'Exact rerun solver/trial/residual reproduction')
baselineDifference=float(max(abs(fun(np.array(retained['trial']))-np.array(retained['residual']))))
require(baselineDifference<1e-12,'Actual residual reproduces retained trial vector')

def to_head(x):
    y=x.copy();y[-3]=(x[-3]-x[-4])*1e7/headScale
    return y
def to_absolute(y):
    x=y.copy();x[-3]=y[-4]+y[-3]*headScale/1e7
    return x
def transformed(y):return fun(to_absolute(y))

audits=[]
for label,x in [('old',np.array(retained['old'])),('trial',np.array(retained['trial']))]:
    y=to_head(x);rr=fun(x);back=to_absolute(y)
    equality=float(max(abs(transformed(y)-rr)))
    require(np.array_equal(back,x) and equality==0.,'Exact physical-state/coordinate residual equality')
    modes=[]
    # Fixed diagnostic probes, not a search for a solver epsilon or a new acceptance tolerance.
    for mode,steps in [('common',[.001,.01,.1,1.]),('head',[.0001,.001,.01,.1])]:
        values=[]
        for step in steps:
            a=x.copy();c=x.copy()
            if mode=='common':a[-4:-2]+=step/1e7;c[-4:-2]-=step/1e7
            else:a[-3]+=step/1e7;c[-3]-=step/1e7
            ra=fun(a);rc=fun(c);derivative=(ra-rc)/(2*step)
            values.append(dict(perturbation_Pa=step,derivativeScaledResidual_per_Pa=derivative.tolist(),
              maximumNonlinearEvenDifference=float(max(abs((ra+rc)/2-rr)))))
        modes.append(dict(mode=mode,probes=values))
    eps=math.sqrt(np.finfo(float).eps)
    audits.append(dict(label=label,tankPressure_Pa=float(x[-4]*1e7),plenumPressure_Pa=float(x[-3]*1e7),
      differentialHead_Pa=float((x[-3]-x[-4])*1e7),roundTripResidualDifference=equality,
      defaultAbsolutePlenumPerturbation_Pa=float(eps*abs(x[-3])*1e7),
      defaultDifferentialPerturbation_Pa=float(eps*abs(y[-3])*headScale),responses=modes))

started=time.perf_counter();headSol=scipy_root(transformed,to_head(x0),options={'xtol':tol})
xx=to_absolute(headSol.x);rr=fun(xx)
require(np.all(np.isfinite(xx)) and np.all(np.isfinite(rr)),'Finite transformed result')
accepted=bool(max(abs(rr))<=1e-7)
headResult=dict(status='ACCEPTED' if accepted else 'REJECTED',solverSuccess=bool(headSol.success),
  message=str(headSol.message),nfev=int(headSol.nfev),residual=rr.tolist(),trial=xx.tolist(),
  maximumLocalMassResidual_kg=float(max(abs(np.r_[rr[:N],rr[-3]]))),
  maximumLocalEnergyResidual_J=float(max(abs(np.r_[rr[N:2*N],rr[-2:]]))*1e5),
  volumeResidual_m3=float(rr[2*N]),wall_s=time.perf_counter()-started)
# Inspect the actual receipt state BEFORE any rapid-neutralization stage. This is
# neither a completed split step nor a replacement for the original trajectory gate.
cc=column(xx[-4]*1e7,xx[:N]*1000,xx[N:2*N]*1000)
pl=vessel(xx[-3]*1e7,xx[-2]*500,'plenum');tc=xx[-1]*500
C=r['calorimeterCapacity_J_K'];previous=old['tank'];previousPlenum=old['plenum']
ledger=dict(massDifference_kg=cc['M']+pl['mass']-previous['M']-previousPlenum['mass'],
  energyDifference_J=cc['E']+pl['energy']+C*tc-previous['E']-previousPlenum['energy']-C*old['calorimeter_K'],
  entropyIncrement_J_K=cc['S']+pl['entropy']+C*math.log(tc)-previous['S']-previousPlenum['entropy']-C*math.log(old['calorimeter_K']),
  tankPressure_Pa=cc['p'],plenumPressure_Pa=pl['p'],plenumTemperature_C=pl['T']-273.15,
  beforeRapidAdjustment=True)
headResult['receiptStateLedger']=ledger
print(json.dumps(dict(scope='Exact retained receipt step only; rapid-adjustment physical timing remains rejected',
  dependencies=dict(python=platform.python_version(),numpy=np.__version__,scipy=scipy.__version__,iapws=iapws.__version__),
  diagnosticSettings=dict(dt_s=dt,iterationTolerance=tol,commonPressureScale_Pa=1e7,differentialHeadScale_Pa=headScale,
    unchangedLocalScaledResidualLimit=1e-7),retainedTrialResidualDifference=baselineDifference,
  original=original,coordinateAudit=audits,headCoordinates=headResult,checks=checks,
  completedTrajectory=False,physicalRedistributionQualified=False)))
`

if (import.meta.main) {
  const [owner, originPath, python] = process.argv.slice(2)
  if (!owner || !originPath || !python || process.argv.length !== 5)
    throw new Error('Usage: cmt-receiving-conditioning.ts owner.md retained-fine.json python')
  const originText = await Bun.file(originPath).text()
  const input = diagnosticOrigin(JSON.parse(originText), await Bun.file(owner).text())
  const payload = receivingDefinitions + conditioningTail
  const child = Bun.spawn([python, '-c', payload], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit' })
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('Retained receiving-step diagnostic failed')
  console.log(JSON.stringify({ originHash: hash(originText), originCalculationHash: retainedCalculationHash,
    inputHash: hash(JSON.stringify(input)), calculationHash: hash(payload), sourceHash: hash(await Bun.file(import.meta.path).text()),
    ...JSON.parse(output) }, null, 2))
}
