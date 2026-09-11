/** Offline achieved-bank/reciprocal-thermal experiment. No live model or protection implementation. */
import { createHash } from 'node:crypto'
import { bankReferenceCases, bankSourcePython } from './reference-design-bank-source'
import { parseBankBasis } from './reference-design-bank-motion'
import { fuelCircuitCorePython, resolveFuelCircuitInput } from './reference-design-fuel-circuit'

export const bankThermalPython=fuelCircuitCorePython+String.raw`
results=[];failures=[]
for case in d['cases']:
    before=len(checks);progress=dict(phase='reciprocal')
    try:
        result=experiment(16,[.025,.0125],False,False,case,progress)
        a,c=result['runs'];pairs=list(zip(a['samples'],c['samples']))
        require('same accepted observation times '+case['name'],len(a['samples'])==len(c['samples']) and all(abs(x['t_s']-y['t_s'])<1e-10 for x,y in pairs))
        diff={key:max(float(np.max(abs(np.array(x[key])-np.array(y[key])))) for x,y in pairs) for key in ['sourceStates','p_MPa','T_C','flow_kg_s','wall_C','rpm','wallHeat_W']}
        diff['radial_K']=max(abs(xr[k]-yr[k]) for x,y in pairs for xr,yr in zip(x['radial'],y['radial']) for k in xr)
        diff['reactivity_pcm']=max(abs(x['source']['netReactivity_pcm']-y['source']['netReactivity_pcm']) for x,y in pairs)
        screens=dict(sourceHistory=diff['sourceStates']<1e-5,reactivity=diff['reactivity_pcm']<.01,
            pressure=diff['p_MPa']<.001,water=diff['T_C']<.01,flow=diff['flow_kg_s']<5,
            wall=diff['wall_C']<.01,shaft=diff['rpm']<.1,radial=diff['radial_K']<.05)
        outcome=dict(name=case['name'],path=case['segments'],result=result,temporalDifference=diff,
            screens=screens,accepted=all(screens.values()) and all(row.get('passed',True) for row in checks[before:]))
        results.append(outcome)
        if case['name']=='ordinary-withdrawal':
            progress['phase']='frozen-feedback'
            contrast=experiment(16,[.0125],False,True,case,progress)
            pairs=list(zip(c['samples'],contrast['runs'][0]['samples']))
            outcome['frozenFeedback']=dict(result=contrast,
                maximumFissionDifference=max(abs(x['source']['fission']-y['source']['fission']) for x,y in pairs),
                maximumWallHeatDifference_W=max(float(np.max(abs(np.array(x['wallHeat_W'])-np.array(y['wallHeat_W'])))) for x,y in pairs))
            reference=next(row for row in d['sourceReference']['cases'] if row['name']==case['name'])['final']
            final=contrast['runs'][0]['samples'][-1]
            require('same isolated-source endpoint',abs(reference['time_s']-final['t_s'])<1e-10)
            error=float(max(abs(np.array(final['sourceStates'])-reference['states'])))
            outcome['frozenFeedback'].update(independentFinalSourceError=error,sourceScreenPassed=error<1e-5)
    except (ValueError,RuntimeError) as error:
        # Explicit rejected case; never substitute a shorter successful run.
        failures.append(dict(name=case['name'],error=str(error),**progress))
print(json.dumps(dict(scope='offline actual bank motion with reciprocal radial/primary/source; boron and poison fixed; no protection or instrument qualification',
    results=results,failures=failures,checks=checks,cost_s=time.perf_counter()-start,
    packages=dict(python=platform.python_version(),numpy=np.__version__,scipy=scipy.__version__,iapws=iapws.__version__),
    liveRuntime=False,fullMechanicalEnergy=False),allow_nan=False))
`

if(import.meta.main){
  const files=Bun.argv.slice(2)
  if(files.length!==11&&files.length!==12)throw Error('Usage: bun reference-design-bank-thermal.ts <initialization.md> <hydraulic.md> <cycle.md> <fuel.md> <transient.md> <BOL.json> <python> <kinetics.md> <heat-history.md> <control.md> <isolated-bank-source.json> [case-name]')
  const docs=await Promise.all(files.slice(0,6).map(p=>Bun.file(p).text()))
  const source={kinetics:await Bun.file(files[7]!).text(),history:await Bun.file(files[8]!).text()}
  const bank=parseBankBasis(await Bun.file(files[9]!).text())
  const cases=bankReferenceCases(bank).filter(c=>files[11]?c.name===files[11]:['ordinary-withdrawal','ordinary-insertion','ordinary-drive-loss','healthy-release','obstruction'].includes(c.name))
  if(cases.length===0)throw Error('Unknown bank reference case')
  const referenceText=await Bun.file(files[10]!).text()
  const sourceReference=JSON.parse(referenceText)
  const data={...await resolveFuelCircuitInput(docs[0]!,docs[1]!,docs[2]!,docs[3]!,docs[4]!,docs[5]!,files[6]!,source),bank,cases,sourceReference}
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const mechanicsSha256=hash(await Bun.file(new URL('./reference-design-bank-motion.ts',import.meta.url)).text())
  if(sourceReference.mechanicsSha256!==mechanicsSha256 || sourceReference.calculationSha256!==hash(bankSourcePython)
    || sourceReference.inputSha256!==hash(JSON.stringify({bank,config:data.source,cases:bankReferenceCases(bank)})))
    throw Error('Isolated bank/source evidence does not match these mechanics, equations and inputs')
  const input=JSON.stringify(data)
  const child=Bun.spawn([files[6]!,'-c',bankThermalPython],{stdin:new Blob([input]),stdout:'pipe',stderr:'pipe'})
  const [out,err,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(status!==0)throw Error(err)
  console.log(JSON.stringify({mechanicsSha256,calculationSha256:hash(bankThermalPython),inputSha256:hash(input),
    bolArtifactSha256:hash(docs[5]!),sourceReferenceSha256:hash(referenceText),...JSON.parse(out)},null,2))
}
