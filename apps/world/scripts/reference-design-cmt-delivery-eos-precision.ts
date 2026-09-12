/** Frozen-node forward EOS target refinement; no change to the delivery operator. */
import { createHash } from 'node:crypto'
import { newtonAuditSetup } from './reference-design-cmt-delivery-newton-audit.ts'

export const eosPrecisionCalculation = newtonAuditSetup + String.raw`
def refine(rho,p,T):
    history=[]
    for iteration in range(7):
        water.update(CoolProp.DmassT_INPUTS,float(rho),float(T))
        if water.phase()!=CoolProp.iphase_liquid:raise ValueError('Refinement left liquid domain')
        err=water.p()-p;deriv=water.first_partial_deriv(CoolProp.iP,CoolProp.iT,CoolProp.iDmass)
        if not np.isfinite(deriv) or deriv<=0:raise ValueError('Unsupported pressure-temperature derivative')
        history.append(dict(T_K=float(T),pressureDefect_Pa=float(err),u_J_kg=float(water.umass())))
        if iteration<6:T-=err/deriv
    return history
results=[]
for item in thermo:
    nodeRows=[];pdelta=item['samples'][1]['pressure_Pa']-item['samples'][0]['pressure_Pa']
    originalResponse=refinedResponse=0.;maximumError=0.
    for q in item['samples'][0]['probes']:
        rho,p,T=q['rho'],q['requestedPressure_Pa'],q['T_K'];r0=refine(rho,p,T)
        u1,T1,_=density_props(rho,p+pdelta);r1=refine(rho,p+pdelta,T1)
        water.update(CoolProp.DmassT_INPUTS,rho,T);u0=water.umass()
        originalResponse+=q['weight_m3']*rho*(u1-u0)
        refinedResponse+=q['weight_m3']*rho*(r1[-1]['u_J_kg']-r0[-1]['u_J_kg'])
        maximumError=max(maximumError,abs(r0[-1]['pressureDefect_Pa']),abs(r1[-1]['pressureDefect_Pa']))
        nodeRows.append(dict(z_m=q['z_m'],rho=rho,pressure_Pa=p,original=r0,perturbed=r1))
    worstNode=max(nodeRows,key=lambda q:abs(q['original'][0]['pressureDefect_Pa']))
    neighboring=[refine(worstNode['rho'],worstNode['pressure_Pa'],np.nextafter(worstNode['original'][0]['T_K'],direction)) for direction in [-np.inf,np.inf]]
    seedEnds=[worstNode['original'][-1]['pressureDefect_Pa']]+[seed[-1]['pressureDefect_Pa'] for seed in neighboring]
    seedSpread=max(seedEnds)-min(seedEnds)
    expected=item['pressureOnlyLinearEnergy_J'];oldDefect=abs(originalResponse-expected);newDefect=abs(refinedResponse-expected)
    results.append(dict(cell=item['cell'],pressureIncrement_Pa=pdelta,nodes=nodeRows,neighborSeeds=neighboring,
      originalIntegratedResponse_J=originalResponse,refinedIntegratedResponse_J=refinedResponse,analyticResponse_J=expected,
      originalResponseDefect_J=oldDefect,refinedResponseDefect_J=newDefect,
      improvementFactor=oldDefect/newDefect if newDefect else None,maximumFinalPressureDefect_Pa=maximumError,
      neighborSeedPressureSpread_Pa=float(seedSpread),neighborSeedRepeatabilityAccepted=bool(seedSpread<abs(pdelta)),
      pressureResolutionAccepted=bool(maximumError<abs(pdelta)),tenfoldResponseImprovement=bool(newDefect<=oldDefect/10)))
print(json.dumps(dict(scope='Six fixed forward-EOS Newton temperature corrections on frozen nodes; no delivery change or new trajectory',
 results=results,frozenNodeRefinementAccepted=all(r['pressureResolutionAccepted'] and r['tenfoldResponseImprovement'] and r['neighborSeedRepeatabilityAccepted'] for r in results)),allow_nan=False))
`
if (import.meta.main) {
  const [inputReceipt, stepsReceipt, python, output] = Bun.argv.slice(2)
  if (!inputReceipt || !stepsReceipt || !python || !output || Bun.argv.length !== 6) throw Error('Usage: eos-precision.ts delivery.json steps.json python output.json')
  const old = await Bun.file(inputReceipt).json(), input = JSON.stringify(old.input)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  if (old.inputHash !== hash(input) || (await Bun.file(stepsReceipt).json()).inputHash !== hash(input)) throw Error('Retained parent input mismatch')
  const identity = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(eosPrecisionCalculation), inputHash: hash(input), stepsHash: hash(await Bun.file(stepsReceipt).text()) }
  const child = Bun.spawn([python, '-c', eosPrecisionCalculation, stepsReceipt], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'inherit' })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code) throw Error('Frozen EOS precision discriminator failed')
  await Bun.write(output, JSON.stringify({ ...identity, ...JSON.parse(out) }, null, 2))
  console.log({ output })
}
