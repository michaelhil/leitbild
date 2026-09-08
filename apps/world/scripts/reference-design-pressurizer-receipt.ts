/** Finite pressure-supported liquid receipt into a sealed hydrostatic column; no time/valve law. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parsePressurizerBoundaries } from './reference-design-pressurizer-boundaries'
import { parseSpatialBasis } from './reference-design-pressurizer-spatial'
import { parsePhaseStorageBasis, phaseStorageThermodynamics } from './reference-design-pressurizer-phase-storage'
import { parseFilmBasis } from './reference-design-pressurizer-film'
import { filmEnergyCalculation } from './reference-design-pressurizer-film-energy'

const schema = z.object({ donorPressure_MPa: z.number().finite().positive(), upperSuperheat_K: z.number().finite().positive(), initialDonorToTransferredMass: z.number().finite().gt(1), extentSteps: z.number().int().positive() }).strict()
export function parseReceiptBasis(text: string) {
  const blocks = [...text.matchAll(/^```reference-pressurizer-receipt\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-pressurizer-receipt block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export function receiptStream(artifact: any, expectedInput: unknown) {
  if (artifact?.calculationHash !== hash(filmEnergyCalculation) || artifact?.inputHash !== hash(JSON.stringify(expectedInput)) || artifact.numericalScreenPassed !== true) throw Error('Receipt requires the current accepted film-energy evidence')
  const rows = artifact.cases?.at(-1)?.rows
  const a = rows?.at(-2), b = rows?.at(-1)
  const dm = b?.drainedMass_kg - a?.drainedMass_kg
  const totalEnergy = (b?.drainEnthalpyAndPotential_J - a?.drainEnthalpyAndPotential_J) / dm
  if (!(dm > 0) || !(b?.drainedMass_kg > 0) || !Number.isFinite(totalEnergy)) throw Error('Missing finite final-window drain state')
  return { transferredMass_kg: b.drainedMass_kg, specificEnthalpyAndPotential_J_kg: totalEnergy, window_s: [a.time_s, b.time_s] }
}

export const receiptCalculation = phaseStorageThermodynamics + String.raw`
from scipy.optimize import root
b=json.load(sys.stdin);r=b['source'];cfg=b['receipt'];p0=b['spatial']['surfacePressure_MPa'];g=9.80665
A=math.pi*r['innerRadius_m']**2;H=r['height_m'];L=r['statedLevel_m'];volume=A*H
stream=b['stream'];extent=stream['transferredMass_kg'];donorM=cfg['initialDonorToTransferredMass']*extent
donorP=cfg['donorPressure_MPa']*1e6;donorZ=L;donorH=stream['specificEnthalpyAndPotential_J_kg']-g*donorZ
water.update(CP.HmassP_INPUTS,donorH,donorP)
if water.phase()!=CP.iphase_liquid:raise ValueError('Selected donor must be liquid')
donor=dict(pressure_Pa=donorP,temperature_K=water.T(),h_J_kg=water.hmass(),u_J_kg=water.umass(),s_J_kgK=water.smass(),v_m3_kg=1/water.rhomass(),z_m=donorZ,initialMass_kg=donorM)

def run(count,nq,steps,cold):
    gx,gw=np.polynomial.legendre.leggauss(nq)
    def gauss(lo,hi):return lo+(gx+1)*(hi-lo)/2,gw*(hi-lo)/2
    edges=sorted(set([float(x) for x in np.linspace(0,H,count+1)]+[L]+([L/2] if cold else [])))
    lower=[(lo,hi) for lo,hi in zip(edges[:-1],edges[1:]) if hi<=L]
    upper=[(lo,hi) for lo,hi in zip(edges[:-1],edges[1:]) if lo>=L]
    native=[]
    for kind,segments in [('liquid',list(reversed(lower))),('vapor',upper)]:
        pressure=p0
        for lo,hi in segments:
            T=r['fluidTemperature_K']-(b['phase']['coldLowerOffset_K'] if cold and hi<=L/2 else 0.) if kind=='liquid' else W(P=p0,x=1).T+cfg['upperSuperheat_K']
            start,end=(hi,lo) if kind=='liquid' else (lo,hi)
            sol=solve_ivp(lambda z,y:[-W(P=float(y[0]),T=T).rho*g/1e6],[start,end],[pressure],rtol=1e-10,atol=1e-12,dense_output=True)
            if not sol.success:raise ValueError(sol.message)
            zs,weights=gauss(lo,hi);qs=[W(P=float(sol.sol(z)[0]),T=T) for z in zs]
            M=sum(w*q.rho*A for w,q in zip(weights,qs));s=sum(w*q.rho*A*q.s for w,q in zip(weights,qs))/M
            native.append(dict(kind=kind,lo=lo,hi=hi,mass=M,entropy=s));pressure=float(sol.y[0,-1])
    native.sort(key=lambda x:x['lo']);receiver=max(i for i,c in enumerate(native) if c['kind']=='liquid')
    original=[dict(c) for c in native]
    def column(p,mu,sreceiver):
        bands=[dict(c) for c in original];bands[receiver]['mass']+=mu;bands[receiver]['entropy']=sreceiver
        total=sum(c['mass'] for c in bands);bottom=0.;V=U=PE=S=Vl=0.;temps=[];coldTemps=[];phaseValid=True
        for i,c in enumerate(bands):
            ms,weights=gauss(bottom,bottom+c['mass'])
            for m,w in zip(ms,weights):
                q=W(P=p+g*(total-m)/A/1e6,s=c['entropy'])
                phaseValid=phaseValid and ((c['kind']=='liquid' and q.x==0) or (c['kind']=='vapor' and q.x==1))
                V+=w*q.v;U+=w*q.u*1000;PE+=w*g/A*(total-m)*q.v;S+=w*q.s*1000
                if c['kind']=='liquid':Vl+=w*q.v;temps.append(q.T)
                if c['hi']<=L/2:coldTemps.append(q.T)
            bottom+=c['mass']
        upperMass=sum(c['mass'] for c in bands if c['kind']=='vapor')
        return dict(pressureTop_MPa=p,pressureSurface_MPa=p+g*upperMass/A/1e6,volume_m3=V,energy_J=U+PE,internalEnergy_J=U,potentialEnergy_J=PE,
            entropy_J_K=S,liquidLevel_m=Vl/A,liquidTemperatureMin_K=min(temps),liquidTemperatureMax_K=max(temps),
            coldBandTemperatureMin_K=min(coldTemps),coldBandTemperatureMax_K=max(coldTemps),mass_kg=total,receiverEntropy_kJ_kgK=sreceiver,phaseValid=bool(phaseValid))
    s0=original[receiver]['entropy']
    pstart=brentq(lambda p:column(p,0,s0)['volume_m3']-volume,p0-.05,p0+.05,xtol=1e-12)
    initial=column(pstart,0,s0);E0=initial['energy_J'];S0=initial['entropy_J_K'];state=initial;rows=[];maxEnergy=maxVolume=0.
    if not initial['phaseValid']:raise ValueError('Initial reconstructed column left selected single-phase domain')
    donorInitial=donorM*(donor['u_J_kg']+g*donorZ)
    for mu in np.linspace(0,extent,steps+1)[1:]:
        def residual(x):
            c=column(float(x[0]),float(mu),float(x[1]))
            return [(c['volume_m3']-volume)/volume,(c['energy_J']-E0-mu*stream['specificEnthalpyAndPotential_J_kg'])/1e7]
        result=root(residual,[state['pressureTop_MPa'],state['receiverEntropy_kJ_kgK']],options={'xtol':1e-10})
        if not np.all(np.isfinite(result.x)):raise ValueError('Nonfinite proposed receipt state')
        now=column(float(result.x[0]),float(mu),float(result.x[1]));er=now['energy_J']-E0-mu*stream['specificEnthalpyAndPotential_J_kg'];vr=now['volume_m3']-volume
        if not now['phaseValid']:raise ValueError('Accepted receipt left selected single-phase band domain')
        remaining=donorM-mu;work=donorP*mu*donor['v_m3_kg'];donorEnergy=remaining*(donor['u_J_kg']+g*donorZ)
        totalError=now['energy_J']+donorEnergy-E0-donorInitial-work
        produced=now['entropy_J_K']-S0-mu*donor['s_J_kgK']
        # Compare total mechanical head at the moving receiving surface; no transfer-time law is implied.
        availableHead=donorP-now['pressureSurface_MPa']*1e6+g/donor['v_m3_kg']*(donorZ-now['liquidLevel_m'])
        if not all(math.isfinite(x) for x in [er,vr,totalError,produced,remaining,availableHead]):raise ValueError('Nonfinite receipt ledger or available head')
        massError=now['mass_kg']+remaining-initial['mass_kg']-donorM
        if abs(massError)>1e-10:raise ValueError('Finite donor and receiver mass did not close')
        if max(abs(er),abs(totalError))>.05 or abs(vr)>1e-10 or remaining<=0 or availableHead<=0:raise ValueError(dict(reason='Finite receipt conservation/head gate',energy=er,total=totalError,volume=vr,head=availableHead))
        previousProduced=rows[-1]['entropyProduction_J_K'] if rows else 0.
        if produced<previousProduced-1e-7:raise ValueError('Receipt produced negative entropy')
        now.update(transferredMass_kg=float(mu),remainingDonorMass_kg=remaining,donorEnergy_J=donorEnergy,donorPistonWork_J=work,
            receiverEnergyResidual_J=er,totalEnergyResidual_J=totalError,totalMassResidual_kg=massError,volumeResidual_m3=vr,entropyProduction_J_K=produced,availableDonorHead_Pa=availableHead)
        rows.append(now);state=now;maxEnergy=max(maxEnergy,abs(er),abs(totalError));maxVolume=max(maxVolume,abs(vr))
    if cold and state['liquidTemperatureMax_K']-state['liquidTemperatureMin_K']<b['phase']['coldLowerOffset_K']/2:raise ValueError('Lower thermal history erased')
    return dict(sourceBands=count,quadratureOrder=nq,extentSteps=steps,coldLowerHistory=cold,initial=initial,rows=rows,
        maximumEnergyResidual_J=maxEnergy,maximumVolumeResidual_m3=maxVolume,unchangedMaterialEntropies=[c['entropy'] for i,c in enumerate(original) if i!=receiver])
count=r['cellCount'];steps=cfg['extentSteps']
cases=[run(count,4,steps,False),run(count,8,steps,False),run(2*count,8,steps,False),run(count,8,2*steps,False),run(count,8,steps,True)]
comparisons=[]
for label,a,c in [('quadrature',cases[0],cases[1]),('bands',cases[1],cases[2]),('extent',cases[1],cases[3])]:
    x=a['rows'][-1];y=c['rows'][-1]
    # Compare the receipt RESPONSE as well as the absolute states, to expose small-effect errors.
    dp=(x['pressureSurface_MPa']-a['initial']['pressureSurface_MPa'])*1e6
    dq=(y['pressureSurface_MPa']-c['initial']['pressureSurface_MPa'])*1e6
    errors=dict(pressureResponse_Pa=abs(dp-dq),levelResponse_m=abs((x['liquidLevel_m']-a['initial']['liquidLevel_m'])-(y['liquidLevel_m']-c['initial']['liquidLevel_m'])),entropyProduction_J_K=abs(x['entropyProduction_J_K']-y['entropyProduction_J_K']))
    ok=errors['pressureResponse_Pa']<=.1 and errors['levelResponse_m']<=1e-7 and errors['entropyProduction_J_K']<=1e-4
    comparisons.append(dict(axis=label,errors=errors,passes=bool(ok)))
print(json.dumps(dict(scope='Finite pressure-supported donor receipt into fully hydrostatic sealed regional storage; transfer extent, not passive film-rate coupling',
    dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,CoolPropRevision=CP.get_global_param_string('gitrevision'),scipy=scipy.__version__,numpy=np.__version__),
    donor=donor,stream=stream,cases=cases,comparisons=comparisons,numericalScreenPassed=all(x['passes'] for x in comparisons),liveModelInstalled=False),allow_nan=False))
`

if (import.meta.main) {
  const [source, owner, artifactPath, python, ...extra] = process.argv.slice(2)
  if (!source || !owner || !artifactPath || !python || extra.length) throw Error('Usage: pressurizer-receipt.ts source.md owner.md film-energy.json python')
  const page = await Bun.file(owner).text(), sourceBasis = parsePressurizerBoundaries(await Bun.file(source).text()), spatial = parseSpatialBasis(page)
  const origin = await Bun.file(artifactPath).text()
  const stream = receiptStream(JSON.parse(origin), { source: sourceBasis, pressure_MPa: spatial.surfacePressure_MPa, film: parseFilmBasis(page) })
  const input = { source: sourceBasis, spatial, phase: parsePhaseStorageBasis(page), receipt: parseReceiptBasis(page), stream }
  const child = Bun.spawn([python, '-c', receiptCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code) throw Error(err)
  console.log(JSON.stringify({ input, inputHash: hash(JSON.stringify(input)), originHash: hash(origin), calculationHash: hash(receiptCalculation), ...JSON.parse(out) }, null, 2))
}
