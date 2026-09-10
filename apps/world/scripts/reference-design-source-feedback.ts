/** Offline source equations and observations. No live model or additional thermal store. */
import { z } from 'zod'
import { createHash } from 'node:crypto'

const positive = z.number().finite().positive()
const six = (schema: z.ZodNumber) => z.array(schema).length(6)
const sourceSchema = z.object({
  generationTime_s: positive,
  delayedFractions: six(positive), halfLives_s: six(positive),
  fuelCoefficient_pcm_K: z.number().finite().negative(),
  moderatorCoefficient_pcm_K: z.number().finite().negative(),
  reactivityPulse_pcm: positive,
  steps_s: z.array(positive).min(2).refine(v => v.every((x, i) => i === 0 || x < v[i - 1]!), 'Steps must decrease'),
}).strict().refine(v => v.delayedFractions.reduce((a, b) => a + b, 0) < 1, 'Invalid delayed-neutron fraction')
const decaySchema = z.object({ fractions: six(positive), timeConstants_s: six(positive) }).strict()
  .refine(v => v.fractions.reduce((a, b) => a + b, 0) < 1, 'No positive prompt deposition fraction')

function block(doc: string, name: string): unknown {
  const blocks = [...doc.matchAll(new RegExp('^```' + name + '\\s*\\n([\\s\\S]*?)^```\\s*$', 'gm'))]
  if (blocks.length !== 1) throw Error(`Expected one ${name} block`)
  return JSON.parse(blocks[0]![1]!)
}
export function parseSourceFeedback(sourceDoc: string, historyDoc: string) {
  return { source: sourceSchema.parse(block(sourceDoc, 'reference-source-feedback')),
    decay: decaySchema.parse(block(historyDoc, 'reference-decay-energy')) }
}

/** Normalized precursor and delayed-energy states are each one at nominal equilibrium.
 * Their normalization constants are immutable design data, never reconstructed on copy.
 */
export const sourceFeedbackPython = String.raw`
def feedback_observation(segments,r,water,volumes):
    masses=np.array([sum(s['mf']) for s in segments])
    means=np.array([float(s['mf']@r[s['fi']])/sum(s['mf']) for s in segments])
    if min(masses)<=0 or min(volumes)<=0:raise ValueError('Feedback requires positive owned masses and volumes')
    temperature=float(masses@means/sum(masses))
    moderator=float(volumes@water['T'][2:4]/sum(volumes))+273.15
    density=float(sum(water['mass'][2:4])/sum(volumes))
    return dict(fuel_K=temperature,moderator_K=moderator,moderatorDensity_kg_m3=density,
        axialFuel_K=means.tolist())
def source_owner(config):
    c=config['source'];h=config['decay'];beta=np.array(c['delayedFractions']);lam=np.log(2)/np.array(c['halfLives_s'])
    fractions=np.array(h['fractions']);tau=np.array(h['timeConstants_s']);generation=c['generationTime_s']
    def read(s,observation,baseline,imposed_pcm):
        if len(s)!=13 or not np.all(np.isfinite(s)) or min(s)<0:raise ValueError('Invalid source inventory')
        if not all(math.isfinite(v) for v in [imposed_pcm,observation['fuel_K'],observation['moderator_K'],baseline['fuel_K'],baseline['moderator_K']]):raise ValueError('Nonfinite source observation or reference')
        rf=c['fuelCoefficient_pcm_K']*(observation['fuel_K']-baseline['fuel_K'])
        rm=c['moderatorCoefficient_pcm_K']*(observation['moderator_K']-baseline['moderator_K'])
        rho=(imposed_pcm+rf+rm)*1e-5
        if rho>=sum(beta):raise ValueError('Source outside sub-prompt-critical reference')
        rate=np.r_[(rho*s[0]+beta@(s[1:7]-s[0]))/generation,
            lam*(s[0]-s[1:7]),(s[0]-s[7:])/tau]
        prompt=(1-sum(fractions))*s[0];decay=float(fractions@s[7:])
        return dict(rate=rate,fission=float(s[0]),prompt=float(prompt),decay=decay,deposition=float(prompt+decay),
            fuelReactivity_pcm=float(rf),moderatorReactivity_pcm=float(rm),netReactivity_pcm=float(rho*1e5))
    def eliminate(old,n,dt):
        if not math.isfinite(dt) or dt<0:raise ValueError('Invalid source interval')
        return np.r_[n,(old[1:7]+dt*lam*n)/(1+dt*lam),(old[7:]+dt*n/tau)/(1+dt/tau)]
    return dict(read=read,eliminate=eliminate,energyWeights=fractions*tau,lambda_s=lam,beta=beta)
`

/** Independent numerical/algebraic checks, not a second production implementation. */
export const sourceVerificationPython = String.raw`
import sys,json,math,platform
import numpy as np,scipy
from scipy.linalg import expm
from scipy.integrate import solve_ivp
config=json.load(sys.stdin)
${sourceFeedbackPython}
owner=source_owner(config);c=config['source'];h=config['decay'];checks=[]
def require(name,condition,**values):
    if not condition:raise ValueError(name+': '+str(values))
    checks.append(dict(name=name,**values))
base=dict(fuel_K=900.,moderator_K=580.)
def read(s,obs=base,pcm=0.):return owner['read'](s,obs,base,pcm)
steady=np.ones(13)
require('nominal history balance',max(abs(read(steady)['rate']))==0 and abs(read(steady)['deposition']-1)<1e-14)
nonuniform=np.linspace(.9,1.1,13)
for dt in [.001,.025,.1,1.]:
    eliminated=owner['eliminate'](nonuniform,.97,dt)
    residual=eliminated-nonuniform-dt*read(eliminated)['rate']
    require('linear inventory elimination exact BE '+str(dt),max(abs(residual[1:]))<1e-14)
for pcm in [-config['source']['reactivityPulse_pcm'],config['source']['reactivityPulse_pcm']]:
    # Matrix independently formed from the unnormalized precursor equations.
    beta=np.array(c['delayedFractions']);lam=np.log(2)/np.array(c['halfLives_s']);L=c['generationTime_s']
    matrix=np.zeros((7,7));matrix[0,0]=(pcm*1e-5-sum(beta))/L;matrix[0,1:]=lam
    matrix[1:,0]=beta/L;matrix[1:,1:]=-np.diag(lam)
    initial=np.r_[1.,beta/(L*lam)];scale=initial.copy()
    exact=expm(matrix*5.)@initial/scale
    reference=solve_ivp(lambda t,s:read(np.r_[s,np.ones(6)],pcm=pcm)['rate'][:7],(0,5),np.ones(7),method='Radau',rtol=1e-11,atol=1e-12)
    error=float(max(abs(exact-reference.y[:,-1])))
    require('independent signed precursor matrix '+str(pcm),reference.success and error<1e-8,error=error)
    require('signed source response '+str(pcm),(exact[0]-1)*pcm>0 and min(exact)>0)
    discrete=[]
    for dt in [.1,.05,.025]:
        step=np.linalg.inv(np.eye(7)-dt*matrix);current=initial.copy()
        for i in range(round(5/dt)):current=step@current
        discrete.append(float(max(abs(current/scale-exact))))
    require('implicit precursor refinement '+str(pcm),discrete[2]<discrete[1]<discrete[0],errors=discrete)
fractions=np.array(h['fractions']);tau=np.array(h['timeConstants_s'])
for power in [0.,.7,1.2]:
    elapsed=13.;states=power+(1-power)*np.exp(-elapsed/tau)
    release=fractions*(power*elapsed+(1-power)*tau*(-np.expm1(-elapsed/tau)))
    delta=fractions*tau*(states-1)
    require('analytic delayed energy '+str(power),max(abs(delta-(fractions*power*elapsed-release)))<1e-11)
fresh=steady.copy();fresh[7:]=0
require('equal current fission different retained history',read(fresh)['fission']==read(steady)['fission'] and read(fresh)['deposition']<read(steady)['deposition'])
warm=dict(fuel_K=base['fuel_K']+2,moderator_K=base['moderator_K']+3)
a=read(steady,warm)
shift={k:v-273.15 for k,v in warm.items()};zero={k:v-273.15 for k,v in base.items()}
require('temperature difference units invariant',abs(a['netReactivity_pcm']-owner['read'](steady,shift,zero,0.)['netReactivity_pcm'])<1e-10)
require('isolated feedback signs',read(steady,{**base,'fuel_K':901})['fuelReactivity_pcm']<0 and read(steady,{**base,'moderator_K':581})['moderatorReactivity_pcm']<0)
retained=json.loads(json.dumps(dict(states=(steady*.99).tolist(),baseline=base)))
before=read(steady*.99,warm);after=owner['read'](np.array(retained['states']),warm,retained['baseline'],0.)
require('copy retains source inventory and design baseline',max(abs(before['rate']-after['rate']))==0)
wrong=owner['read'](np.array(retained['states']),warm,warm,0.)
require('rebasing a warm copy is observably wrong',wrong['netReactivity_pcm']!=after['netReactivity_pcm'])
for bad in [np.r_[-1.,np.ones(12)],np.r_[float('nan'),np.ones(12)],np.ones(12)]:
    rejected=False
    try:read(bad)
    except ValueError:rejected=True
    require('invalid source state rejection '+str(len(checks)),rejected)
rejected=False
try:read(steady,pcm=sum(c['delayedFractions'])*1e5+1)
except ValueError:rejected=True
require('prompt critical branch rejected',rejected)
for field in ['fuel_K','moderator_K']:
    rejected=False
    try:read(steady,{**base,field:float('nan')})
    except ValueError:rejected=True
    require('nonfinite observation rejected '+field,rejected)
water=dict(T=np.array([0.,0.,300.,320.]),mass=np.array([0.,0.,7.,6.]))
segments=[dict(mf=np.array([1.,3.]),fi=slice(0,2)),dict(mf=np.array([2.,2.]),fi=slice(2,4))]
temperatures=np.array([600.,1000.,700.,1100.]);original=temperatures.copy()
obs=feedback_observation(segments,temperatures,water,np.array([1.,1.]))
require('owned mass not arithmetic node averaging',abs(obs['fuel_K']-900)<1e-12 and obs['fuel_K']!=float(np.mean(temperatures)))
require('moderator geometric weighting and density separate',obs['moderator_K']==583.15 and obs['moderatorDensity_kg_m3']==6.5)
split=[dict(mf=np.array([.5,.5,1.,2.]),fi=slice(0,4)),segments[1]|dict(fi=slice(4,6))]
same=feedback_observation(split,np.array([600.,600.,1000.,1000.,700.,1100.]),water,np.array([1.,1.]))
require('identical material split invariant',same==obs and np.array_equal(temperatures,original))
print(json.dumps(dict(scope='offline algebra and independent stiff source reference; coefficients unqualified',checks=checks,
    packages=dict(python=platform.python_version(),numpy=np.__version__,scipy=scipy.__version__)),allow_nan=False))
`
if (import.meta.main) {
  const [source, history, python, ...extra] = Bun.argv.slice(2)
  if (!source || !history || !python || extra.length) throw Error('Usage: bun reference-design-source-feedback.ts <kinetics.md> <heat-history.md> <python>')
  const data = parseSourceFeedback(await Bun.file(source).text(), await Bun.file(history).text())
  const process = Bun.spawn([python, '-c', sourceVerificationPython], { stdin: new Blob([JSON.stringify(data)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, status] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (status !== 0) throw Error(err)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({ calculationSha256: hash(sourceVerificationPython), inputSha256: hash(JSON.stringify(data)), ...JSON.parse(out) }, null, 2))
}
