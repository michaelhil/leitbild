/** Offline physical-port/phase-admission discriminator; no hydraulic trajectory or live plant. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { parseConnectedFuel } from './reference-design-connected-fuel'
import { primaryReferencePython, resolveInitializationInput } from './reference-design-initialization'
import { parseSurgeBasis } from './reference-design-surge'

const states = z.array(z.number().finite()).length(11)
const receipt = z.object({ results: z.array(z.object({ result: z.object({ runs: z.array(z.object({
  samples: z.array(z.object({ p_MPa: states, T_C: states })).min(1),
})).min(1) }) })).min(1), failures: z.array(z.object({
  name: z.enum(['healthy-release', 'obstruction']), lastAcceptedTime_s: z.number().positive(), lastAcceptedPressure_MPa: states,
  lastAcceptedTemperature_C: states,
})).length(2) })

export const primaryPressurizerPortCalculation = String.raw`
import json,sys,math,platform
import numpy as np
import scipy,iapws
from scipy.integrate import solve_ivp,quad
from scipy.optimize import brentq,root
from iapws import IAPWS97
from iapws.iapws97 import _Region1,_Region2,_TSat_P
d=json.load(sys.stdin)
primary={'d':d['primary']};exec(d['primaryDefinitions'],primary)
xnom,res=primary['solve'](primary['steady'],primary['xseed'],'actual primary nominal')
nom=primary['evaluate'](xnom);hotIndex=primary['names'].index('HOT.A');pH=float(nom['p'][hotIndex]);TH=float(nom['T'][hotIndex])+273.15
volumes=primary['V'];zs=primary['z'];hotV=float(volumes[hotIndex]);g=primary['g']
cfg=d['surge']['pzr'];A=cfg['area_m2'];height=cfg['volume_m3']/A;L0=cfg['liquidVolume_m3']/A;z0=cfg['bottomElevation_m']
if z0!=float(zs[hotIndex]):raise ValueError('HOT.A and PZR bottom do not share the selected physical datum')
failures={f['name']:f for f in d['bank']['failures']}
if set(failures)!={'healthy-release','obstruction'}:raise ValueError('Expected the two named bank-release cases')
old=d['bank']['results'][0]['result']['runs'][0]['samples'][0]
replay=dict(pressure_MPa=float(max(abs(nom['p']-old['p_MPa']))),temperature_K=float(max(abs(nom['T']-old['T_C']))))
if replay['pressure_MPa']>1e-7 or replay['temperature_K']>1e-6:raise ValueError('Bank receipt does not match fresh physical-core initialization')

def prop(region,T,p):
    q=region(T,p);rho=1/q['v'];h=q['h']*1000
    return rho,h,h-p*1e6/rho

def phase(p,T,lo,hi,region,datum=z0):
    # A physical hydrostatic column, isothermal within this admission-test phase.
    # Region continuation outside saturation is diagnostic algebra ONLY.
    def rhs(z,y):
        rho,h,u=prop(region,T,y[0])
        return [-rho*g/1e6,rho*A,rho*A*u,rho*A*g*(z+datum)]
    sol=solve_ivp(rhs,[lo,hi],[p,0.,0.,0.],rtol=2e-11,atol=[1e-12,1e-9,.00001,.00001],dense_output=True)
    if not sol.success:raise ValueError(sol.message)
    q=sol.y[:,-1];direction=1 if hi>lo else -1
    return dict(M=direction*q[1],U=direction*q[2],PE=direction*q[3],pEnd=q[0],profile=sol.sol,T=T,lo=lo,hi=hi,region=region)

def vessel(x,datum=z0):
    p,Tl,Tv,L=x[:4]
    if not 14<=p<=16 or not 0<L<height or not 540<Tl<623 or not 540<Tv<650:raise ValueError('Outside this local phase-admission test')
    l=phase(p,Tl,L,0.,_Region1,datum);v=phase(p,Tv,L,height,_Region2,datum)
    return l,v

def initial(p):return np.array([p,_TSat_P(p),_TSat_P(p),L0,pH,TH])
p0=brentq(lambda p:vessel(initial(p))[0]['pEnd']-pH,14.,16.,xtol=1e-12)
x0=initial(p0);l0,v0=vessel(x0)

def hot(x,datum=z0):
    p,T=x[4:];rho,h,u=prop(_Region1,T,p)
    return dict(M=hotV*rho,U=hotV*rho*u,PE=hotV*rho*g*datum,h=h)

def energy(a):return a['U']+a['PE']
hot0=hot(x0)

def branch(x):
    l,v=vessel(x);ts=_TSat_P(x[0])
    # Isothermal hydrostatic liquid/vapor have their minimum stable-phase
    # margin at the shared surface. No metastable root is an accepted state.
    return dict(liquidSubcooling_K=float(ts-x[1]),vaporSuperheat_K=float(x[2]-ts),
        hotSubcooling_K=float(_TSat_P(x[4])-x[5]))

def transaction(dm,base=x0,label='balanced nominal'):
    before=base.copy()
    l0,v0=vessel(base);hot0=hot(base)
    def balances(x):
        l,v=vessel(x);h=hot(x);mid=(x+base)/2
        lm,_=vessel(mid)
        donor=hot(mid)['h'] if dm>0 else prop(_Region1,mid[1],lm['pEnd'])[1]
        transferred=dm*(donor+g*z0);work=mid[0]*1e6*A*(x[3]-base[3])
        return np.array([l['M']-l0['M']-dm,energy(l)-energy(l0)-transferred+work,
            v['M']-v0['M'],energy(v)-energy(v0)-work,
            h['M']-hot0['M']+dm,energy(h)-energy(hot0)+transferred])
    scales=np.array([1.,1e6,1.,1e6,1.,1e6]);coordinates=np.array([15.,600.,600.,6.,15.,600.])
    sol=root(lambda y:balances(y*coordinates)/scales,base/coordinates,tol=1e-11)
    x=sol.x*coordinates;r=balances(x)
    if max(abs(r[::2]))>1e-7 or max(abs(r[1::2]))>.1:raise ValueError('Finite physical-port residual failed: '+str(r))
    margins=branch(x);admitted=all(value>=0 for value in margins.values())
    owners=(*vessel(x),hot(x));native=sum(energy(a) for a in owners)-sum(energy(a) for a in (l0,v0,hot0))
    # Independent U evaluation uses the wrapper's u, not h-pv. This is a
    # same-EOS accounting check, not an independent property formulation.
    independent=None
    if admitted:
        def physicalEnergy(a,datum=z0):
            lo,hi=sorted([a['lo'],a['hi']])
            def integrand(z):
                w=IAPWS97(P=float(a['profile'](z)[0]),T=a['T'])
                return A*w.rho*(w.u*1000+g*(z+datum))
            return quad(integrand,lo,hi,epsabs=.00001,epsrel=1e-11)[0]
        def independentHot(y):
            w=IAPWS97(P=y[4],T=y[5]);return hotV*w.rho*(w.u*1000+g*z0)
        independent=sum(physicalEnergy(a) for a in owners[:2])+independentHot(x)-sum(physicalEnergy(a) for a in (l0,v0))-independentHot(base)
        if abs(independent)>.1:raise ValueError('Independent finite-owner energy ledger failed')
    # Datum translation must alter total E by precisely g*offset*total M.
    shifted=(*vessel(x,z0+100),hot(x,z0+100));baseShift=(*vessel(base,z0+100),hot(base,z0+100))
    datumResidual=sum(energy(a) for a in shifted)-sum(energy(a) for a in baseShift)-native
    if abs(native)>.1 or abs(datumResidual)>.1:raise ValueError('Closed connection or datum ledger failed')
    if not np.array_equal(base,before):raise ValueError('Port test mutated its initial owner')
    return dict(initialCondition=label,prescribedTransferIntoPZR_kg=dm,admitted=admitted,branchMargins=margins,
        initialHotMinusBottomPressure_Pa=float((base[4]-l0['pEnd'])*1e6),
        trialHotMinusBottomPressure_Pa=float((x[4]-owners[0]['pEnd'])*1e6),hydraulicFlowQualified=False,
        surfacePressureChange_Pa=float((x[0]-base[0])*1e6),hotPressureChange_Pa=float((x[4]-base[4])*1e6),
        liquidLevelChange_mm=float((x[3]-base[3])*1000),liquidTemperatureChange_K=float(x[1]-base[1]),
        vaporTemperatureChange_K=float(x[2]-base[2]),hotTemperatureChange_K=float(x[5]-base[5]),
        massResidual_kg=float(max(abs(r[::2]))),energyResidual_J=float(max(abs(r[1::2]))),
        totalNativeEnergyResidual_J=float(native),independentEnergyResidual_J=independent,
        datumTranslationResidual_J=float(datumResidual),trialState=x.tolist(),
        phaseAdmittedCandidateTransfer_kg=dm if admitted else 0.,originalStateUnchanged=bool(np.array_equal(base,before)))

def liquidInventories(p,T):
    rho,h,u=primary['properties'](np.asarray(p),np.asarray(T))
    return volumes*rho,volumes*rho*u

demands=[]
surge=d['surge']['surge'];lineV=math.pi*surge['lineDiameter_m']**2/4*surge['lineLength_m']
lineM=lineV*prop(_Region1,TH,pH)[0];donorH=prop(_Region1,x0[1],l0['pEnd'])[1]
for name in ['healthy-release','obstruction']:
    f=failures[name]
    p=np.array(f['lastAcceptedPressure_MPa']);T=np.array(f['lastAcceptedTemperature_C'])
    restored=p+(pH-p[hotIndex]) # preserve this pressure-difference shape, not a solved hydraulic state
    m,u=liquidInventories(p,T);mr,ur=liquidInventories(restored,T);dm=float(sum(mr-m));du=float(sum(ur-u));dpe=float(sum((mr-m)*g*zs))
    inputE=dm*(donorH+g*z0)
    demands.append(dict(case=name,lastAcceptedTime_s=f['lastAcceptedTime_s'],pressureOffset_Pa=float((pH-p[hotIndex])*1e6),
        fixedTemperatureRestorationMass_kg=dm,internalEnergyChange_J=du,potentialEnergyChange_J=dpe,
        nominalPZRDonorEnthalpy_J_kg=donorH,donorMaterialEnergy_J=inputE,
        targetEnergyMinusDonorEnergy_J=du+dpe-inputE,
        nominalPZRLiquidVolumeEquivalent_m3=dm/prop(_Region1,x0[1],l0['pEnd'])[0],
        fractionOfNominalPZRLiquid=dm/l0['M'],oldApparatusLineInventoryTurnovers=dm/lineM,
        diagnosticMassOverElapsed_kg_s=dm/f['lastAcceptedTime_s'],
        oldCandidateFrictionAtDiagnosticRate_Pa=surge['referenceLoss_Pa']*(dm/f['lastAcceptedTime_s']/surge['referenceFlow_kg_s'])**2,
        isTrajectory=False,isRequiredActualFlow=False))

cases=[transaction(dm) for dm in [-1.,-.1,.1,1.]]
contracted=x0.copy();contracted[4]=failures['healthy-release']['lastAcceptedPressure_MPa'][hotIndex];contracted[5]=failures['healthy-release']['lastAcceptedTemperature_C'][hotIndex]+273.15
cases.extend(transaction(dm,contracted,'accepted contracted HOT.A; nominal PZR') for dm in [-1.,-.1])
if [c['admitted'] for c in cases]!=[False,False,True,True,False,False]:raise ValueError('Selected frozen-phase admission outcome changed; review the physics, do not relabel')
print(json.dumps(dict(scope='Actual HOT.A finite physical-port and frozen-phase admission; no installed-line trajectory',
    packages=dict(python=platform.python_version(),scipy=scipy.__version__,iapws=iapws.__version__),
    primaryNominalReplay=replay,initial=dict(hotPressure_MPa=pH,hotTemperature_C=TH-273.15,hotVolume_m3=hotV,
        oldInitialPressureMismatch_Pa=(pH-cfg['hotPortPressure_MPa'])*1e6,
        surfacePressure_MPa=p0,saturationTemperature_C=x0[1]-273.15,liquidMass_kg=l0['M'],vaporMass_kg=v0['M'],
        vesselInternalEnergy_J=l0['U']+v0['U'],vesselPotentialEnergy_J=l0['PE']+v0['PE'],
        finiteHotMass_kg=hot0['M'],oldApparatusVolume_m3=lineV,oldApparatusMassAtActualHotState_kg=lineM),
    staticDemand=demands,signedTransactions=cases,installedRouteSelected=False,pressureSupportQualified=False,
    liveRuntime=False),allow_nan=False))
`

if (import.meta.main) {
  const [wiki, bankPath, python] = Bun.argv.slice(2)
  if (!wiki || !bankPath || !python) throw Error('Usage: reference-design-primary-pressurizer-port.ts <LD-01-directory> <frozen-bank-receipt.json> <research-python>')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const identity = { sourceSha256: hash(await Bun.file(import.meta.path).text()), calculationSha256: hash(primaryPressurizerPortCalculation) }
  const paths = ['model/connected-primary-initialization.md', 'model/primary-hydraulic-basis.md',
    'systems/steam-power/cycle-basis.md', 'systems/reactor/fuel-construction.md',
    'model/pressurizer-surge-study.md', 'systems/primary-coolant/pressure-and-inventory.md']
  const docs = await Promise.all(paths.map(path => Bun.file(join(wiki, path)).text()))
  const bankText = await Bun.file(bankPath).text()
  const data = { primary: await resolveInitializationInput(docs[0]!, docs[1]!, docs[2]!, python, parseConnectedFuel(docs[0]!, docs[3]!)),
    primaryDefinitions: primaryReferencePython, surge: parseSurgeBasis(docs[4]!, docs[5]!), bank: receipt.parse(JSON.parse(bankText)) }
  const child = Bun.spawn([python, '-c', primaryPressurizerPortCalculation], { stdin: new Blob([JSON.stringify(data)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  console.log(JSON.stringify({ ...identity,
    inputSha256: hash(JSON.stringify(data)), bankReceiptSha256: hash(bankText), ...JSON.parse(out) }, null, 2))
}
