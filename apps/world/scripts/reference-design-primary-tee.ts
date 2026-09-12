/** Offline reduced combining-tee admission and native stationary branch initialization. Not a time integrator. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { parsePrimaryMechanics } from './reference-design-primary-mechanics'
import { parseSurgeRoute, resolveSurgeRoute, surgeRoutePython } from './reference-design-surge-route'
import { parsePressurizerBasis } from './reference-design-pressurizer'
import { phaseStorageThermodynamics } from './reference-design-pressurizer-phase-storage'
import { regionalHydrostaticsPython } from './reference-design-regional-hydrostatics'
import { primaryTeeLiquidPython } from './reference-design-primary-tee-liquid'

export function parsePrimaryTee(text: string) {
  const blocks=[...text.matchAll(/^```reference-primary-tee\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-primary-tee block')
  return z.object({model:z.literal('oka1996-sharp-combining'),branchAngle_deg:z.literal(90),joiningEdgeRadiusRatio:z.literal(0)}).strict().parse(JSON.parse(blocks[0]![1]!))
}

/** Oka et al. 1996 Eqs12/14, sharp edge r/d=0. f is Qbranch/Qdownstream, NOT mass fraction. */
export function sharpCombiningPolynomials(areaRatio: number) {
  if (!Number.isFinite(areaRatio) || areaRatio < 1 || areaRatio > 18) throw Error('Outside selected area-ratio domain')
  const m = areaRatio
  return { through: [.045 / m, 1.35 + .021 * m + .0032 * m * m, -1.03 + .145 * m - .0102 * m * m],
    branch: [-1 + .08 / m, 2.89 + .73 * m - .13 * m * m, -.95 - 1.66 * m + 1.13 * m * m] }
}
export function sharpCombiningCoefficients(areaRatio: number, volumeFraction: number) {
  if (!Number.isFinite(volumeFraction) || volumeFraction < 0 || volumeFraction > 1) throw Error('Dividing/reversed flow is not selected by the combining correlation')
  const p = sharpCombiningPolynomials(areaRatio), f = volumeFraction
  return { through: p.through[0]! + f * (p.through[1]! + f * p.through[2]!), branch: p.branch[0]! + f * (p.branch[1]! + f * p.branch[2]!) }
}

export const primaryTeePython = phaseStorageThermodynamics + String.raw`
import time
from scipy.optimize import root
d=json.load(sys.stdin);r=d['route'];cfg=d['pzr'];nom=d['nominal']['result'];geo=d['geometry']
exec(d['routeDefinitions']);start=time.perf_counter();g=9.80665
A=cfg['area_m2'];Vessel=cfg['volume_m3'];zH=r['sourceElevation_m'];zP=r['receiverElevation_m'];Ap=r['area_m2']
` + regionalHydrostaticsPython + String.raw`
mainFluid=CP.AbstractState('HEOS','Water');Ah=math.pi*geo['hotInsideDiameter_m']**2/4
m1=nom['coreFlow_kg_s']/2;L=15/Ah;location=nom['hotTap']['axialFraction']*L
poly=d['coefficients'];totalK=d['nominal']['budgets']['hot'];teeK=poly['through'][0];remainingK=totalK-teeK
if remainingK<0:raise ValueError('Physical opening exceeds the existing HOT loss budget')
` + primaryTeeLiquidPython + String.raw`upper=next(q for q in nom['mixing'] if q['owner']=='UPPER');ub=ph(upper['p'],upper['h']);H0=ub['h']+g*upper['reference_m']
def inlet_residual(x):
    q=face(x[0]*1e7,x[1]*1e6,m1,Ah)
    return [(q['s']-ub['s'])/1000,(q['H']-H0)/1e6]
sol=root(inlet_residual,[nom['hotTap']['p_Pa']/1e7,H0/1e6],tol=1e-10)
if max(abs(np.array(inlet_residual(sol.x))))>1e-10:raise ValueError('Current UPPER-to-HOT nozzle did not recover')
initial=sol.x*np.array([1e7,1e6])
def segment(y,length,k):
    def rhs(s,x):
        q=ph(*x);v=m1/(q['rho']*Ah)
        matrix=[[1-v*v*q['rp'],-v*v*q['rh']],[-v*v/q['rho']*q['rp'],1-v*v/q['rho']*q['rh']]]
        return np.linalg.solve(matrix,[-k/L*q['rho']*v*v/2,0.])
    q=solve_ivp(rhs,[0,length],y,method='DOP853',rtol=2e-11,atol=[1e-4,1e-7])
    if not q.success:raise ValueError(q.message)
    return q.y[:,-1]
before=face(*segment(initial,location,remainingK),m1,Ah)
def zero_residual(x):
    q=face(x[0]*1e7,x[1]*1e6,m1,Ah)
    return [(before['p']+before['dynamic']-q['p']-q['dynamic']-teeK*q['dynamic'])/1e5,(q['H']-before['H'])/1e6]
sol=root(zero_residual,[before['p']/1e7,before['h']/1e6],tol=1e-10)
after=face(*(sol.x*np.array([1e7,1e6])),m1,Ah);zeroR=np.array(zero_residual(sol.x))*[1e5,1e6]
if abs(zeroR[0])>1 or abs(zeroR[1])>1e-5:raise ValueError('Zero-flow fitting did not close')
end=face(*segment([after['p'],after['h']],L-location,remainingK),m1,Ah)
oldEnd=next(q for q in nom['faces'] if q['owner']=='HOT.A/B')
endpoint=dict(pressureDifference_Pa=end['p']-oldEnd['p_Pa'],totalEnthalpyDifference_J_kg=end['H']-oldEnd['totalEnthalpy_J_kg'],
    temperatureDifference_K=end['T']-oldEnd['T_K'],entropyRise_J_kgK=after['s']-before['s'],
    withinExistingPressureGate=bool(abs(end['p']-oldEnd['p_Pa'])<1),notAnAsymmetricFullPrimaryResolve=True)
# These are reduced far-field connection traces placed at the selected tee location, not local wall-pressure measurements.
pBranch=after['p']+(1+poly['branch'][0])*after['dynamic']
TBranch=after['T'];branch0=ph(pBranch,CP.PropsSI('Hmass','P',pBranch,'T',TBranch,'Water'))
lineNom=line(pBranch/1e6,branch0['s']/1000);pBottom=lineNom['outlet']['p']
def lower_at(ps):
    mass=(pBottom-ps)*1e6*A/g;s=w(ps,x=0).s
    return region(ps,s,mass,False,datum=zP),s
ps=brentq(lambda p:lower_at(p)[0]['V']-cfg['liquidVolume_m3'],pBottom-.05,pBottom-.02,xtol=1e-12)
low,sL=lower_at(ps);VU=Vessel-low['V']
def upper_at(m):
    pt=ps-g*m/A/1e6;s=w(pt,x=1).s
    return region(ps,s,m,True,datum=zP+low['V']/A),s
MU=brentq(lambda m:upper_at(m)[0]['V']-VU,w(ps,x=1).rho*VU*.8,w(ps,x=1).rho*VU*1.2,xtol=1e-8)
up,sU=upper_at(MU);bottom=liquid(low['pBottom'],s=sL)
phaseInitial=dict(line={k:lineNom[k] for k in ['M','U','PE','E']},lower=low,upper=up,
    pressureSurface_Pa=ps*1e6,pressureBottom_Pa=pBottom*1e6,pressureTee_Pa=pBranch,
    lineTemperatureAtPzr_K=lineNom['outlet']['T'],poolTemperatureAtBottom_K=bottom['T'],
    thermalDiscontinuityAtPzr_K=bottom['T']-lineNom['outlet']['T'],
    upperInterfaceSuperheat_K=w(ps,s=sU).T-w(ps,x=1).T,
    volumeResidual_m3=low['V']+up['V']-Vessel,mechanicalHeadResidual_Pa=lineNom['hydroError_Pa'],
    noNormalThermalBalanceSolved=True,noNativeInventoriesReused=True)
initialQuadrature=[]
for order in [16,32]:
    pipeQ=line(pBranch/1e6,branch0['s']/1000,order)
    lowQ=region(ps,sL,low['M'],False,order,zP)
    upQ=region(ps,sU,up['M'],True,order,zP+low['V']/A)
    initialQuadrature.append(dict(order=order,lineMassDifference_kg=pipeQ['M']-lineNom['M'],
        energyDifferences_J=[pipeQ['E']-lineNom['E'],lowQ['E']-low['E'],upQ['E']-up['E']],
        volumeDifference_m3=lowQ['V']+upQ['V']-low['V']-up['V']))
donors=[('initial line',branch0['h']+g*zH),('hot PZR challenge',bottom['h']+g*zP),
    ('cold challenge',CP.PropsSI('Hmass','P',pBranch,'T',553.15,'Water')+g*zH)]
rows=[]
for name,Hbranch in donors:
    for fraction in [0.,.001,.01]:
        m2=m1*fraction/(1-fraction);m3=m1+m2
        for multiplier in [.5,1.,2.]:
            def evaluate(x):
                p3,h3,p2,h2=x*np.array([1e7,1e6,1e7,1e6]);a=face(p3,h3,m3,Ah);b=face(p2,h2,m2,Ap)
                f=(m2/b['rho'])/(m3/a['rho'])
                if not 0<=f<=1:raise ValueError('Outside combining volumetric-fraction domain')
                z13=multiplier*sum(v*f**i for i,v in enumerate(poly['through']))
                z23=multiplier*sum(v*f**i for i,v in enumerate(poly['branch']))
                res=np.array([before['p']+before['dynamic']-a['p']-a['dynamic']-z13*a['dynamic'],
                    b['p']+b['dynamic']-a['p']-a['dynamic']-z23*a['dynamic'],
                    (m1*before['H']+m2*Hbranch)/m3-a['H'],Hbranch-b['H']])
                return res,a,b,f,z13,z23
            Hout=(m1*before['H']+m2*Hbranch)/m3
            guess=np.array([after['p']/1e7,(Hout-g*zH-after['v']**2/2)/1e6,
                pBranch/1e7,(Hbranch-g*zH)/1e6])
            item=dict(donor=name,downstreamMassFraction=fraction,coefficientMultiplier=multiplier,imposedMainMassFlow_kg_s=m1,
                imposedBranchMassFlow_kg_s=m2,prescribedFlowNotDeliveryTrajectory=True)
            try:
                result=root(lambda x:evaluate(x)[0]/[1e5,1e5,1e6,1e6],guess,tol=1e-10)
                residual,a,b,f,z13,z23=evaluate(result.x)
                entropy=a['s']-(m1*before['s']+m2*b['s'])/m3
                # Effective-port pressure laws supply momentum exchange with a stationary wall.
                # Main enters +x, branch enters +y, main exits +x. No wall work or extra heat.
                reaction=[m3*a['v']-m1*before['v']-(before['p']-a['p'])*Ah,-m2*b['v']-b['p']*Ap]
                v1=m1/before['rho'];v2=m2/b['rho'];v3=m3/a['rho']
                mechanicalPower=v1*(before['p']+before['dynamic'])+v2*(b['p']+b['dynamic'])-v3*(a['p']+a['dynamic'])
                headChangePower=(v1*z13+v2*z23)*a['dynamic']
                item.update(solverSuccess=bool(result.success),solverMessage=str(result.message),residual=residual.tolist(),
                    accepted=bool(max(abs(residual[:2]))<=1 and max(abs(residual[2:]))<=1e-5 and entropy>=-1e-7),
                    volumetricFraction=f,volumeMixingDifference_m3_s=m3/a['rho']-m1/before['rho']-m2/b['rho'],
                    throughCoefficient=z13,branchCoefficient=z23,downstream=a,branch=b,
                    branchVsInitialAvailablePressure_Pa=b['p']-pBranch,entropyGeneration_J_kgK=entropy,
                    stationaryWallReactionOnFluid_N=reaction,
                    mechanicalFluxDifference_W=mechanicalPower,weightedPathHeadChange_W=headChangePower,
                    pressureVolumeMixingTerm_W=(v1+v2-v3)*(a['p']+a['dynamic']),
                    mechanicalAccountingResidual_W=mechanicalPower-headChangePower-(v1+v2-v3)*(a['p']+a['dynamic']),
                    branchMainDensityRatio=b['rho']/before['rho'],downstreamReynolds=m3*geo['hotInsideDiameter_m']/(Ah*a['mu']))
            except (ValueError,RuntimeError) as error:item.update(accepted=False,failure=str(error))
            rows.append(item)
print(json.dumps(dict(scope='Extrapolated combining-law admission and stationary native branch initialization; no time advancement or full asymmetric solve',
    inputNominalIdentity={k:d['nominal'][k] for k in ['sourceSha256','calculationSha256','inputSha256']},
    lossAllocation=dict(originalTotalK=totalK,zeroFlowTeeK=teeK,remainingDistributedK=remainingK),
    zeroFlow=dict(before=before,after=after,branchStaticPressure_Pa=pBranch,residual=zeroR.tolist()),
    endpoint=endpoint,phaseInitial=phaseInitial,initialQuadrature=initialQuadrature,cases=rows,
    dividingFlow='UNSELECTED: combining correlations must not be extrapolated through reversed side flow',
    dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__,numpy=np.__version__),
    wallSeconds=time.perf_counter()-start),allow_nan=False))
`

export async function runPrimaryTee(wiki: string, python: string) {
  const sourceText=await Bun.file(import.meta.path).text()
  const { runPrimaryOperatingPoint } = await import('./reference-design-primary-operating-point')
  const nominal = await runPrimaryOperatingPoint(wiki, python, 'nominal')
  if (!nominal.accepted) throw Error('Current physical operating point not admitted')
  const geometry = parsePrimaryMechanics(await Bun.file(join(wiki,'systems/primary-coolant/mechanical-energy-and-geometry.md')).text())
  const route = resolveSurgeRoute(parseSurgeRoute(await Bun.file(join(wiki,'systems/primary-coolant/surge-route.md')).text()))
  const pressurePage=await Bun.file(join(wiki,'systems/primary-coolant/pressure-and-inventory.md')).text()
  const pzr = parsePressurizerBasis(pressurePage), selection=parsePrimaryTee(pressurePage)
  const input = { nominal,geometry,route,pzr,selection,routeDefinitions:surgeRoutePython,
    coefficients:sharpCombiningPolynomials((geometry.hotInsideDiameter_m/route.internalDiameter_m)**2) }
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const identity={sourceSha256:hash(sourceText),calculationSha256:hash(primaryTeePython),inputSha256:hash(JSON.stringify({...input,nominal:{...nominal,wallSeconds:0}}))}
  const p=Bun.spawn([python,'-c',primaryTeePython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited])
  if(code!==0)return {...identity,accepted:false,failure:err}
  return {...identity,...JSON.parse(out)}
}
if(import.meta.main){
  const [wiki,python,...extra]=Bun.argv.slice(2)
  if(!wiki||!python||extra.length)throw Error('Usage: primary-tee.ts <LD-01-directory> <research-python>')
  console.log(JSON.stringify(await runPrimaryTee(wiki,python),null,2))
}
