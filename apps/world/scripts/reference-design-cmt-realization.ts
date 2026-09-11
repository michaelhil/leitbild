/** Offline same-operator numerical-interface decision; no production solver or physical closure. */
import { createHash } from 'node:crypto'
import { wellBalancedSetup } from './reference-design-cmt-well-balanced.ts'

export const realizationCalculation = wellBalancedSetup + String.raw`
def derivative_groups(mesh):
    cells,S,_=prepared(mesh);n=len(cells);eye=np.eye(n,dtype=bool);adjacent=eye.copy()
    for f in mesh['faces']:adjacent[f['left'],f['right']]=adjacent[f['right'],f['left']]=True
    # Recovery: native mass through the actual geometric slope stencil; local P/E only.
    # A common face and the current source depend on recovered neighboring/current cells.
    recovery=np.c_[(S!=0)|eye,eye,eye]
    support=np.tile((adjacent.astype(int)@recovery.astype(int))>0,(3,1))
    groups=[];occupied=[]
    for j in range(3*n):
        rows=support[:,j]
        for k,used in enumerate(occupied):
            if not np.any(used&rows):break
        else:k=len(groups);groups.append([]);occupied.append(np.zeros(3*n,dtype=bool))
        groups[k].append((j,np.flatnonzero(rows)));occupied[k]|=rows
    for group in groups:
        if np.max(sum((support[:,j].astype(int) for j,rows in group)))>1:raise ValueError('Derivative color has overlapping row supports')
    return support,groups

def derivative_check(o,y,support,groups,label):
    n=o['n'];h=1e-8*np.r_[y[:n],y[:n],abs(y[2*n:])];rhs=lambda t,d:operator(o,y+d)[0]
    start=time.perf_counter();dense=central_jacobian(rhs,0,np.zeros(3*n),h);denseWall=time.perf_counter()-start
    start=time.perf_counter();colored=central_jacobian(rhs,0,np.zeros(3*n),h,groups);coloredWall=time.perf_counter()-start
    # Normalize by native perturbation and row response; compare every entry, including alleged zeros.
    response=dense*h;scale=np.maximum(np.max(abs(response),axis=1),1.)
    difference=float(np.max(abs((colored-dense)*h)/scale[:,None]))
    outside=float(np.max(abs(response[~support]),initial=0.))
    check(label+' full dense/grouped Jacobian relative',difference,1e-10)
    check(label+' off-structure perturbation response',outside,1e-10)
    return dict(label=label,fullMatrixRelativeDifference=difference,offStructureResponse=outside,
        denseRhsEvaluations=6*n,coloredRhsEvaluations=2*len(groups),denseWall_s=denseWall,coloredWall_s=coloredWall)

def comparison(o,a,b,label):
    ah=a['history'];bh=b['history']
    if [h['t_s'] for h in ah]!=[h['t_s'] for h in bh]:raise ValueError('Different comparison times')
    p=float(np.max(abs(np.array([h['pressureChange_Pa'] for h in ah])-np.array([h['pressureChange_Pa'] for h in bh]))))
    v=float(np.max(abs(np.array([h['velocity_m_s'] for h in ah])-np.array([h['velocity_m_s'] for h in bh]))))
    # Numerical-reference screening only: 1 Pa is 1% of the prior 100 Pa test excitation;
    # 1 micrometre/s resolves about 0.7% of this experiment's previous peak velocity.
    check(label+' sampled full-crossing pressure Pa',p,1.)
    check(label+' sampled full-crossing velocity m/s',v,1e-6)
    return dict(maximumSampledPressureDifference_Pa=p,maximumSampledVelocityDifference_m_s=v)

baseline=data['baseline'];mesh=data['meshes'][0];o=compile_column(mesh);n=o['n'];support,groups=derivative_groups(mesh)
initial=o['initialize']('nonpolynomial');heated=initial.copy();heated[2*n:]+=10000*(band_weights(o,7,8)-band_weights(o,9,10))
derivativeChecks=[derivative_check(o,initial,support,groups,'rest'),derivative_check(o,heated,support,groups,'heat')]
pc,tr,U,PE=o['recover'](initial);face=int(np.flatnonzero(o['z']==8.)[0])
for sign in [1,-1]:
    donor,receiver=(face-1,face) if sign>0 else (face,face-1);r,v,p,u,c=tr[donor,1 if sign>0 else 0]
    y=initial.copy();dm=.005;de=dm*(u+p/r+g*o['z'][face]);y[donor]-=dm;y[receiver]+=dm;y[2*n+donor]-=de;y[2*n+receiver]+=de
    derivativeChecks.append(derivative_check(o,y,support,groups,'material '+str(sign)))
derivativeChecks.append(derivative_check(o,np.array(baseline['finalNativeState']),support,groups,'withheld evolved state'))
print('Derivative equivalence passed: '+str(len(groups))+' colors for '+str(3*n)+' columns',file=sys.stderr,flush=True)
duration=baseline['duration_s'];runs=[]
for tight in ([False,True] if data['includeTighter'] else [False]):
    print('Full crossing grouped Radau tight='+str(tight),file=sys.stderr,flush=True)
    result=implicit(o,heated,duration,tight,groups);runs.append(result)
    native=np.array(result['finalNativeState'])-heated
    result['finalMaterializedMassResidual_kg']=float(abs(sum(native[:n])))
    result['finalMaterializedEnergyResidual_J']=float(abs(sum(native[2*n:])))
    check('grouped final materialized native mass kg',result['finalMaterializedMassResidual_kg'],1e-6)
    check('grouped final materialized native total energy J',result['finalMaterializedEnergyResidual_J'],.1)
againstBaseline=comparison(o,baseline,runs[0],'retained dense baseline/grouped')
temporal=comparison(o,runs[0],runs[1],'base/tighter grouped') if len(runs)==2 else None
if runs[0]['actualRhsCallsIncludingJacobian']>=baseline['actualRhsCallsIncludingJacobian']:raise ValueError('Grouped interface did not reduce measured RHS work')
print(json.dumps(dict(scope='Same CMT column physical operator; structural central-Jacobian grouping only',
    versions=dict(CoolProp=CoolProp.__version__,numpy=np.__version__,scipy=scipy.__version__),
    derivativeChecks=derivativeChecks,groups=[[j for j,rows in group] for group in groups],structuralNonzeroEntries=int(sum(support.ravel())),
    runs=runs,againstRetainedBaseline=againstBaseline,fullCrossingTemporalComparison=temporal,checks=checks,
    baselineActualRhsCalls=baseline['actualRhsCallsIncludingJacobian'],baselineWall_s=baseline['wall_s'],
    caseSelection='base-and-tighter' if data['includeTighter'] else 'base-only',
    numericalInterfaceAccepted=True,restrictedTemporalScreenPassed=True if temporal is not None else None,spatialConvergenceQualified=False,nonlinearCmtQualified=False,
    operatorEvaluationDiagnostics=diagnostics),allow_nan=False))
`

if (import.meta.main) {
  const [baselineFile, python, cases] = process.argv.slice(2)
  if (!baselineFile || !python || !['base', 'full'].includes(cases!) || process.argv.length !== 5) throw new Error('Usage: reference-design-cmt-realization.ts retained-column-evidence.json python base|full')
  const baselineText = await Bun.file(baselineFile).text(), baseline = JSON.parse(baselineText)
  if (!baseline.restrictedOperatorChecksPassed || baseline.results[0].cells !== 18) throw new Error('Expected accepted 18-cell column reference')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  if (hash(JSON.stringify(baseline.input)) !== baseline.inputHash) throw new Error('Retained physical input hash mismatch')
  const input = { ...baseline.input, baseline: baseline.results[0].implicitHeat, includeTighter: cases === 'full' }
  const identity = { physicalInputHash: baseline.inputHash, baselineEvidenceHash: hash(baselineText), baselineCalculationHash: baseline.calculationHash,
    sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(realizationCalculation) }
  const child = Bun.spawn([python, '-c', realizationCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit' })
  const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('CMT numerical realization decision failed')
  console.log(JSON.stringify({ ...identity, ...JSON.parse(stdout) }, null, 2))
}
