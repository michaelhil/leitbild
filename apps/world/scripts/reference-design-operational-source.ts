/** Offline source/poison and feedback checks. Not an installed plant or coupled accident calculation. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseSourceFeedback } from './reference-design-source-feedback'
import { parseBankBasis } from './reference-design-bank-motion'
import { bankReferenceCases } from './reference-design-bank-source'
import { operationalFeedbackComparison, readOperationalFeedback } from './reference-design-operational-feedback'

const positive = z.number().finite().positive()
const poisonSchema = z.object({
  iodineHalfLife_h: positive, xenonHalfLife_h: positive,
  iodineYield: positive, xenonYield: positive, xenonAbsorption_barn: positive,
  nominalFlux_m2_s: positive, normalizationVolume_m3: positive,
  recoverableEnergy_MeV: positive, nominalFission_MW: positive,
}).strict()

const calculation = String.raw`
import json,sys,math,platform
import numpy as np,scipy,CoolProp
from scipy.integrate import solve_ivp
from scipy.linalg import expm
from CoolProp.CoolProp import PropsSI
d=json.load(sys.stdin); b=d['feedback']['basis']; r=d['feedback']['reference']
c=d['source']['source']; h=d['source']['decay']; p=d['poison']; checks=[]
def require(name,ok,**values):
    if not ok: raise ValueError(name+': '+str(values))
    checks.append(dict(name=name,**values))
beta=np.array(c['delayedFractions']); lam=np.log(2)/np.array(c['halfLives_s']); L=c['generationTime_s']
f=np.array(h['fractions']); tau=np.array(h['timeConstants_s'])
li=math.log(2)/(3600*p['iodineHalfLife_h']); lx=math.log(2)/(3600*p['xenonHalfLife_h'])
sx=p['xenonAbsorption_barn']*1e-28; phi=p['nominalFlux_m2_s']; burn=sx*phi
F0=p['nominalFission_MW']*1e6/(p['recoverableEnergy_MeV']*1e6*1.602176634e-19*p['normalizationVolume_m3'])
NI0=p['iodineYield']*F0/li; NX0=(p['iodineYield']+p['xenonYield'])*F0/(lx+burn)
yx=p['xenonYield']/(p['iodineYield']+p['xenonYield']); yi=1-yx
require('source/bank identities agree',abs(sum(beta)-b['beta'])<1e-15 and b['bankWorth']==d['bank']['worthPerStroke'] and b['bankReference']==d['bank']['referencePosition'])
# An intentionally separate arithmetic implementation checks the TypeScript response.
for case in d['feedback']['cases']:
    s=case['state']; regions=s['regions']
    mw=sum(x['liquid_kg']+x['steam_kg'] for x in regions)
    ab=sum(x['dissolved_kgEq']+b['residualEffectiveness']*x['retained_kgEq'] for x in regions)
    rho=b['waterWorth']*(mw/r['waterMass_kg']-1)+b['absorberWorth_pcm_ppmEq']*1e-5*(1e6*ab/r['waterMass_kg']-r['absorberDensity_ppmEq'])
    rho+=b['fuelWorth_pcm_K']*1e-5*(s['fuelTemperature_K']-r['fuelTemperature_K'])+b['bankWorth']*(s['bankPosition']-b['bankReference'])+b['xenonWorth']*(s['xenonNumberDensity_m3']/r['xenonNumberDensity_m3']-1)
    require('independent inventory law '+case['name'],abs(rho-case['result']['total'])<1e-14,error=abs(rho-case['result']['total']))

def matrix(rho):
    A=np.zeros((13,13)); A[0,0]=(rho-sum(beta))/L; A[0,1:7]=lam
    A[1:7,0]=beta/L; A[1:7,1:7]=-np.diag(lam)
    A[7:,0]=f; A[7:,7:]=-np.diag(1/tau)
    return A
scale=np.r_[1.,beta/(L*lam),f*tau,NI0,NX0]
def normalized_rhs(y,bank):
    n=y[0]; rho=b['bankWorth']*(bank-b['bankReference'])+b['xenonWorth']*(y[14]-1)
    return np.r_[(rho*n+beta@(y[1:7]-n))/L,lam*(n-y[1:7]),(n-y[7:13])/tau,
        li*(n-y[13]),(lx+burn)*(yx*n+yi*y[13])-(lx+burn*n)*y[14]]
def physical_rhs(y,bank):
    n=y[0]; I=y[13]; X=y[14]
    rho=b['bankWorth']*(bank-b['bankReference'])+b['xenonWorth']*(X/NX0-1)
    return np.r_[matrix(rho)@y[:13],p['iodineYield']*F0*n-li*I,
        p['xenonYield']*F0*n+li*I-(lx+burn*n)*X]
require('all fifteen source and poison states balance at reference',max(abs(normalized_rhs(np.ones(15),b['bankReference'])))<1e-13)
paths=[]
for case in d['bankCases']:
    a=np.ones(15); z=scale.copy(); error=0.; time=0
    for seg in case['segments']:
        end=seg['duration_s']
        def bank(t):return seg['from']+(seg['to']-seg['from'])*t/end
        ts=np.linspace(0,end,max(2,math.ceil(end/.025)+1))
        A=solve_ivp(lambda t,y:normalized_rhs(y,bank(t)),(0,end),a,method='Radau',rtol=1e-10,atol=1e-12,t_eval=ts,max_step=.025)
        Z=solve_ivp(lambda t,y:physical_rhs(y,bank(t)),(0,end),z,method='BDF',rtol=1e-10,atol=1e-12*scale,t_eval=ts,max_step=.0125)
        require(case['name']+' independent solves '+str(time),A.success and Z.success)
        error=max(error,float(np.max(abs(A.y-Z.y/scale[:,None]))))
        require(case['name']+' positive history '+str(time),float(min(np.min(A.y),np.min(Z.y/scale[:,None])))>=0)
        # Copy mid-interval without rebasing any source/poison/energy population.
        left=solve_ivp(lambda t,y:normalized_rhs(y,bank(t)),(0,end/2),a,method='Radau',rtol=1e-10,atol=1e-12,max_step=.025)
        copied=np.array(json.loads(json.dumps(left.y[:,-1].tolist())))
        right=solve_ivp(lambda t,y:normalized_rhs(y,bank(t)),(end/2,end),copied,method='Radau',rtol=1e-10,atol=1e-12,max_step=.025)
        require(case['name']+' retained-history split '+str(time),left.success and right.success and max(abs(right.y[:,-1]-A.y[:,-1]))<1e-8)
        a=A.y[:,-1]; z=Z.y[:,-1]; time+=end
    require(case['name']+' all-state independent agreement',error<1e-6,maxNormalizedError=error)
    paths.append(dict(name=case['name'],time_s=time,fission=float(a[0]),deposition=float((1-sum(f))*a[0]+f@a[7:13]),iodineRatio=float(a[13]),xenonRatio=float(a[14]),maxNormalizedError=error))
by={x['name']:x for x in paths}
require('failed release remains distinct with poison coupled',by['healthy-release']['fission']<by['obstruction']['fission']<by['failed-release']['fission'])
require('inserted bank does not delete stored energy',by['healthy-release']['deposition']>by['healthy-release']['fission'])

prompt=[]
for factor in [.99,1.,1.01,1.1]:
    rho=float(sum(beta))*factor; A=matrix(rho); initial=scale[:13]
    exact=expm(A*.01)@initial/initial
    out=solve_ivp(lambda t,y:(A@(y*initial))/initial,(0,.01),np.ones(13),method='Radau',rtol=1e-11,atol=1e-12)
    error=float(max(abs(out.y[:,-1]-exact)))
    require('finite source through prompt boundary '+str(factor),out.success and np.min(out.y)>0 and error<1e-8,error=error)
    prompt.append(dict(betaMultiple=factor,duration_s=.01,fission=float(exact[0]),maxNormalizedError=error))
# A-stability does not mean positive growing solutions at any step size.
A=matrix(.01); be=np.linalg.solve(np.eye(13)-.1*A,scale[:13])/scale[:13]
require('coarse backward Euler is rejected not clipped',min(be)<0 and min(expm(A*.1)@scale[:13]/scale[:13])>0,backwardEulerMinimum=float(min(be)))

poisons=[]
for n,duration in [(0.,86400.),(.2,21600.),(1.,21600.)]:
    def rhs(t,y):return np.array([li*(n-y[0]),(lx+burn)*(yx*n+yi*y[0])-(lx+burn*n)*y[1]])
    K=np.array([[-li,0.,li*n],[(lx+burn)*yi,-(lx+burn*n),(lx+burn)*yx*n],[0.,0.,0.]])
    exact=(expm(K*duration)@np.ones(3))[:2]
    out=solve_ivp(rhs,(0,duration),np.ones(2),method='Radau',rtol=1e-10,atol=1e-12,dense_output=True)
    require('fixed-source isotope independent exact reference '+str(n),out.success and max(abs(exact-out.y[:,-1]))<1e-8 and np.min(out.y)>=0)
    samples=[dict(time_s=float(t),iodineRatio=float(out.sol(t)[0]),xenonRatio=float(out.sol(t)[1])) for t in np.linspace(0,duration,9)]
    poisons.append(dict(prescribedFissionRatio=n,duration_s=duration,samples=samples))
require('retained iodine creates post-source xenon increase',max(x['xenonRatio'] for x in poisons[0]['samples'])>1)
require('equilibrium isotope reset would lose history',poisons[0]['samples'][2]['xenonRatio']>0 and poisons[0]['samples'][2]['iodineRatio']>0)

# One independently declared liquid property station, not a reconstruction of the spatial primary.
T=578.045902; P=15e6; rho0=PropsSI('D','P',P,'T',T,'IF97::Water')
derivatives=[]
for ppm in [0.,1000.,2000.]:
    slopes=[]
    for step in [.01,.005]:
        ratio=(PropsSI('D','P',P,'T',T+step,'IF97::Water')-PropsSI('D','P',P,'T',T-step,'IF97::Water'))/(2*step*rho0)
        slopes.append((b['waterWorth']*1e5+b['absorberWorth_pcm_ppmEq']*ppm)*ratio)
    require('local composition derivative refinement '+str(ppm),abs(slopes[1]-slopes[0])<1e-5)
    derivatives.append(dict(currentConcentration_ppmEq=ppm,moderatorAndAbsorber_pcm_K=slopes[1]))
require('no silently preserved obsolete moderator tangent',abs(derivatives[1]['moderatorAndAbsorber_pcm_K']-c['moderatorCoefficient_pcm_K'])>1)
require('composition can change effective feedback sign',derivatives[0]['moderatorAndAbsorber_pcm_K']<0<derivatives[2]['moderatorAndAbsorber_pcm_K'])
print(json.dumps(dict(scope='Bounded feedback arithmetic, imposed actual-bank source/poison paths, fixed-source isotope history and one liquid EOS derivative; no coupled core, neutron calibration or shutdown/cooling qualification',checks=checks,paths=paths,promptBoundary=prompt,poisonHistories=poisons,localPropertyStation=dict(pressure_Pa=P,temperature_K=T,waterDensity_kg_m3=rho0,derivatives=derivatives),isotopeReference=dict(iodine_atoms_m3=NI0,xenon_atoms_m3=NX0),packages=dict(python=platform.python_version(),scipy=scipy.__version__,numpy=np.__version__,CoolProp=CoolProp.__version__)),allow_nan=False))
`

if (import.meta.main) {
  const [reactorDirectory, python, output, ...extra] = Bun.argv.slice(2)
  if (!reactorDirectory || !python || !output || extra.length) throw Error('Usage: bun reference-design-operational-source.ts <reactor-wiki-directory> <research-python> <receipt.json>')
  const names = ['kinetics.md', 'heat-and-history.md', 'shutdown-and-fuel-response.md', 'control-and-verification.md']
  const documents = await Promise.all(names.map(name => Bun.file(`${reactorDirectory}/${name}`).text()))
  const blocks = [...documents[2]!.matchAll(/^```reference-iodine-xenon\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one iodine/xenon engineering record')
  const bank = parseBankBasis(documents[3]!)
  const data = {
    feedback: operationalFeedbackComparison(readOperationalFeedback(`${reactorDirectory}/kinetics.md`)),
    source: parseSourceFeedback(documents[0]!, documents[1]!),
    poison: poisonSchema.parse(JSON.parse(blocks[0]![1]!)), bank,
    bankCases: bankReferenceCases(bank).filter(c => ['healthy-release', 'failed-release', 'obstruction'].includes(c.name)),
  }
  const dependencies = [import.meta.path, ...['operational-feedback', 'source-feedback', 'bank-motion', 'bank-source'].map(n => `${import.meta.dir}/reference-design-${n}.ts`)]
  const sources = await Promise.all(dependencies.map(path => Bun.file(path).text()))
  const process = Bun.spawn([python, '-c', calculation], { stdin: new Blob([JSON.stringify(data)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, status] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (status !== 0) throw Error(err)
  const currentDocs = await Promise.all(names.map(name => Bun.file(`${reactorDirectory}/${name}`).text()))
  const currentSources = await Promise.all(dependencies.map(path => Bun.file(path).text()))
  if (JSON.stringify(currentDocs) !== JSON.stringify(documents) || JSON.stringify(currentSources) !== JSON.stringify(sources)) throw Error('Consumed engineering inputs changed during calculation')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  await Bun.write(output, JSON.stringify({ calculationSha256: hash(calculation), inputSha256: hash(JSON.stringify(data)),
    sources: dependencies.map((path, i) => ({ file: path.split('/').pop(), sha256: hash(sources[i]!) })),
    documents: names.map((file, i) => ({ file, sha256: hash(documents[i]!) })), ...JSON.parse(out) }, null, 2) + '\n')
}
