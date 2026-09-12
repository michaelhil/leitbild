/** Fixed-native-state opening limit, not a transient or an integrated-leakage measurement. */
import { createHash } from 'node:crypto'
import { deliverySetup } from './reference-design-cmt-delivery.ts'

export const valveLimitCalculation = deliverySetup + String.raw`
rows=[]
for name,pressure in [('forward-pressure',15.19e6),('compatible-rest',15.2e6),('reverse-pressure',15.21e6)]:
    x=initial(pressure);native=decode(x)[0];samples=[]
    for alpha in [0.,.1,.01,.001,.0001,.00001,.000001]:
        # The same native state is used at every opening; no state projection or advancement.
        Y,d,v=rates(x,alpha,True,False)
        check('unchanged held native state',float(max(abs(Y-native))),0.)
        massRate=sum(d[:nc])+sum(d[3*nc:3*nc+np_])+d[-2]
        energyRate=sum(d[2*nc:3*nc])+sum(d[3*nc+2*np_:3*N])+d[-1]
        check('shared interface mass rate kg/s',float(massRate),1e-9)
        check('shared interface energy rate W',float(energyRate),1e-5)
        samples.append(dict(alpha=alpha,sourceFlow_kg_s=v['sourceFlow_kg_s'],
          cmtEnergyRate_W=float(sum(d[2*nc:3*nc])),valveDissipation_W=v['valveDissipation_W'],
          wallDissipation_W=v['wallDissipation_W'],maximumVelocity_m_s=v['maximumVelocity_m_s'],
          massRateLedger_kg_s=float(massRate),energyRateLedger_W=float(energyRate)))
    opened=[s['sourceFlow_kg_s'] for s in samples[1:]]
    rows.append(dict(case=name,receiverPressure_Pa=pressure,samples=samples,
      positiveOpeningFlowSpread_kg_s=max(opened)-min(opened),
      smallestOpeningToClosedFlowJump_kg_s=opened[-1]-samples[0]['sourceFlow_kg_s']))
rejectsLimit=any(r['positiveOpeningFlowSpread_kg_s']==0 and r['smallestOpeningToClosedFlowJump_kg_s']!=0 for r in rows)
print(json.dumps(dict(input=data,cases=rows,verificationGuardsPassed=True,
  repeatedGuardEvaluations=len(checks),uniformInstantaneousClosedLimitAccepted=not rejectsLimit,
  integratedLeakageMeasured=False,transientTimingQualified=False,liveRuntime=False),allow_nan=False))
`

if (import.meta.main) {
  const [retainedReceipt, python] = Bun.argv.slice(2)
  if (!retainedReceipt || !python || Bun.argv.length !== 4) throw Error('Usage: cmt-valve-limit.ts retained-delivery.json python')
  const baseline = await Bun.file(retainedReceipt).json()
  if (!baseline.input?.delivery || !baseline.input?.pipeMesh || typeof baseline.calculationHash !== 'string' || typeof baseline.sourceHash !== 'string') throw Error('Expected retained connected-delivery receipt')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const input = JSON.stringify(baseline.input)
  if (baseline.inputHash !== hash(input)) throw Error('Retained input identity does not match its receipt')
  const identity = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(valveLimitCalculation), inputHash: hash(input),
    retainedSourceHash: baseline.sourceHash, retainedCalculationHash: baseline.calculationHash }
  const child = Bun.spawn([python, '-c', valveLimitCalculation], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'inherit' })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) throw Error('CMT held-state opening discriminator failed')
  console.log(JSON.stringify({ ...identity, ...JSON.parse(out) }, null, 2))
}
