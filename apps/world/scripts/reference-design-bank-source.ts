/** Offline achieved-motion/source comparison. No live runtime, feedback calibration or cooling claim. */
import { createHash } from 'node:crypto'
import { advanceBank, parseBankBasis, type BankBasis, type BankState, type BankSupport } from './reference-design-bank-motion'
import { parseSourceFeedback, sourceFeedbackPython } from './reference-design-source-feedback'

export const bankSourcePython = String.raw`
import sys,json,math,platform
import numpy as np,scipy
from scipy.integrate import solve_ivp
from scipy.linalg import expm
data=json.load(sys.stdin);config=data['config'];basis=data['bank'];checks=[]
${sourceFeedbackPython}
owner=source_owner(config);c=config['source'];h=config['decay']
beta=np.array(c['delayedFractions']);lam=np.log(2)/np.array(c['halfLives_s']);L=c['generationTime_s']
fractions=np.array(h['fractions']);tau=np.array(h['timeConstants_s'])
# This source-only comparison supplies zero feedback differences in a shifted temperature coordinate.
# These zeros are not absolute plant temperatures and are never passed to a property calculation.
zero_delta=dict(fuel_K=0.,moderator_K=0.)
def read(y,pcm):return owner['read'](y,zero_delta,zero_delta,pcm)
def require(name,ok,**values):
    if not ok:raise ValueError(name+': '+str(values))
    checks.append(dict(name=name,**values))
def dimensional_matrix(pcm):
    A=np.zeros((13,13));A[0,0]=(pcm*1e-5-sum(beta))/L;A[0,1:7]=lam
    A[1:7,0]=beta/L;A[1:7,1:7]=-np.diag(lam)
    A[7:,0]=fractions;A[7:,7:]=-np.diag(1/tau)
    return A
scale=np.r_[1.,beta/(L*lam),fractions*tau]
def run(case,independent=False):
    # Dimensional reference uses c_i and E_j/P0, separately assembled rather than the normalized RHS.
    y=scale.copy() if independent else np.ones(13);time=0.;rows=[];minimum=1.
    for segment in case['segments']:
        duration=segment['duration_s'];x0=segment['from'];x1=segment['to']
        def pcm(t):return 1e5*basis['worthPerStroke']*(x0+(x1-x0)*t/duration-basis['referencePosition'])
        def rhs(t,s):return dimensional_matrix(pcm(t))@s if independent else read(s,pcm(t))['rate']
        points=np.linspace(0,duration,max(2,math.ceil(duration/.025)+1))
        old=y.copy()
        result=solve_ivp(rhs,(0,duration),y,method='BDF' if independent else 'Radau',
            rtol=1e-10,atol=1e-11*scale if independent else 1e-11,
            max_step=.005 if independent else .01,t_eval=points)
        require(case['name']+(' independent' if independent else '')+' interval solve',result.success)
        normalized=result.y/scale[:,None] if independent else result.y
        minimum=min(minimum,float(np.min(normalized)))
        if x0==x1:
            exact=expm(dimensional_matrix(pcm(0))*duration)@(old if independent else old*scale)/scale
            error=float(max(abs(normalized[:,-1]-exact)))
            require(case['name']+' constant interval matrix reference '+str(independent),error<1e-8,error=error)
        for j,t in enumerate(points):
            s=normalized[:,j];r=read(s,pcm(float(t)))
            rows.append(dict(time_s=time+float(t),position=x0+(x1-x0)*float(t)/duration,
                reactivity_pcm=pcm(float(t)),fission=r['fission'],deposition=r['deposition'],
                delayed=r['decay'],states=s.tolist()))
        y=result.y[:,-1];time+=duration
    require(case['name']+' source stays nonnegative '+str(independent),minimum>=0,minimum=minimum)
    return rows
cases=[]
for case in data['cases']:
    actual=run(case);reference=run(case,True)
    error=max(float(max(abs(np.array(a['states'])-np.array(b['states'])))) for a,b in zip(actual,reference))
    require(case['name']+' all-history independent agreement',len(actual)==len(reference) and error<1e-6,error=error)
    cases.append(dict(name=case['name'],segments=case['segments'],finalBank=case['finalBank'],
        maxStateError=error,final=actual[-1],samples=[actual[i] for i in sorted(set([0,len(actual)//2,len(actual)-1]))]))
by={c['name']:c for c in cases}
for name in ['healthy-release','release-without-drive','restored-hold-during-travel']:
    r=by[name]['final'];require(name+' reaches mechanical stop, heat remains',r['position']==0 and r['fission']<.1 and r['deposition']>r['fission'] and r['delayed']>0)
for name in ['failed-release','ordinary-drive-loss','nominal-hold']:
    r=by[name]['final'];require(name+' no fictitious trip',abs(r['fission']-1)<1e-9 and r['position']==basis['referencePosition'])
require('obstruction remains distinct from failed release',0<by['obstruction']['final']['position']<basis['referencePosition'] and by['obstruction']['final']['fission']<1)
require('ordinary signed movement changes source, not commanded power',by['ordinary-withdrawal']['final']['fission']>1 and by['ordinary-insertion']['final']['fission']<1)
print(json.dumps(dict(scope='offline bank/source only; temperature differences and poison/boron held; no cooling or rearm qualification',
    checks=checks,cases=cases,packages=dict(python=platform.python_version(),scipy=scipy.__version__,numpy=np.__version__)),allow_nan=False))
`

/** Declared offline support histories; not a protection/measurement implementation. */
export function bankReferenceCases(bank: BankBasis) {
  const initial: BankState = { position: bank.referencePosition, mode: 'HOLD', requestedPosition: bank.referencePosition, released: false }
  const held: BankSupport = { holdingVoltage: true, ordinaryDrive: true, releaseAvailable: true, insertionStop: 0 }
  const lost = { ...held, holdingVoltage: false }
  const specifications = [
    { name: 'nominal-hold', state: initial, periods: [{ dt: 5, support: held }] },
    { name: 'healthy-release', state: initial, periods: [{ dt: 1, support: held }, { dt: 4, support: lost }] },
    { name: 'release-without-drive', state: initial, periods: [{ dt: 1, support: held }, { dt: 4, support: { ...lost, ordinaryDrive: false } }] },
    { name: 'failed-release', state: initial, periods: [{ dt: 1, support: held }, { dt: 4, support: { ...lost, releaseAvailable: false } }] },
    { name: 'obstruction', state: initial, periods: [{ dt: 1, support: held }, { dt: 4, support: { ...lost, insertionStop: .3 } }] },
    { name: 'restored-hold-during-travel', state: initial, periods: [{ dt: 1, support: held }, { dt: .5, support: lost }, { dt: 3.5, support: held }] },
    ...(['ordinary-withdrawal', 'ordinary-insertion', 'ordinary-drive-loss'] as const).map(name => ({ name,
      state: { ...initial, mode: 'MANUAL' as const, requestedPosition: bank.referencePosition + (name === 'ordinary-insertion' ? -1 : 1) * bank.ordinaryRate_s },
      periods: [{ dt: 5, support: { ...held, ordinaryDrive: name !== 'ordinary-drive-loss' } }] })),
  ]
  return specifications.map(c => {
    let state = c.state
    const segments = []
    for (const p of c.periods) { const advanced = advanceBank(bank, state, p.support, p.dt); state = advanced.state; segments.push(...advanced.segments) }
    return { name: c.name, segments, finalBank: state }
  })
}

if (import.meta.main) {
  const [controlDoc, sourceDoc, historyDoc, python, ...extra] = Bun.argv.slice(2)
  if (!controlDoc || !sourceDoc || !historyDoc || !python || extra.length)
    throw Error('Usage: bun reference-design-bank-source.ts <control.md> <kinetics.md> <heat-history.md> <python>')
  const bank = parseBankBasis(await Bun.file(controlDoc).text())
  const config = parseSourceFeedback(await Bun.file(sourceDoc).text(), await Bun.file(historyDoc).text())
  const cases = bankReferenceCases(bank)
  const input = JSON.stringify({ bank, config, cases })
  const mechanics = await Bun.file(new URL('./reference-design-bank-motion.ts', import.meta.url)).text()
  const child = Bun.spawn([python, '-c', bankSourcePython], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (status !== 0) throw Error(err)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({ mechanicsSha256: hash(mechanics), calculationSha256: hash(bankSourcePython), inputSha256: hash(input), ...JSON.parse(out) }, null, 2))
}
