/** Offline upper-port selection and finite ADS chamber check; not an installed trajectory. */
import { createHash } from 'node:crypto'
import { advanceReliefLift } from './reference-design-rhr-local-relief'
import { sprayPhaseAreas } from './reference-design-controlled-spray-phase'

export const upperDischargeBasis = {
  elevation_m: 18.5, radius_m: 0.8, adsBore_m: 0.08, reliefBore_m: 0.15,
  chamberVolume_m3: 0.02, stageCdA_m2: [0.0002, 0.0008, 0.0015],
  reliefOpening_Pa: 15.8e6, reliefReseat_Pa: 15.6e6, reliefStroke_s: 0.05,
} as const

export function upperReliefDemand(pressure: number, previous: boolean) {
  if (!Number.isFinite(pressure) || pressure <= 0) throw Error('Invalid local absolute pressure')
  return pressure >= upperDischargeBasis.reliefOpening_Pa ? true
    : pressure <= upperDischargeBasis.reliefReseat_Pa ? false : previous
}

/** Actual phase fluxes are supplied by the native donor restriction, not inferred from quality. */
export function upperPayload(liquidFlow: number, gasFlow: number, liquidConcentration: number, gasWater: number, gasAir: number, gasNitrogen: number) {
  const values = [liquidFlow, gasFlow, liquidConcentration, gasWater, gasAir, gasNitrogen]
  if (values.some(x => !Number.isFinite(x) || x < 0) || (gasFlow > 0 && Math.abs(gasWater + gasAir + gasNitrogen - 1) > 1e-12)) throw Error('Invalid actual phase payload')
  return { water: liquidFlow + gasFlow * gasWater, air: gasFlow * gasAir,
    nitrogen: gasFlow * gasNitrogen, tracer: liquidFlow * liquidConcentration }
}

export function upperGeometry() {
  const b = upperDischargeBasis
  const adsArea = Math.PI * b.adsBore_m ** 2 / 4, reliefArea = Math.PI * b.reliefBore_m ** 2 / 4
  return { adsArea_m2: adsArea, reliefArea_m2: reliefArea, totalArea_m2: 6 * adsArea + reliefArea,
    chamberTotal_m3: 6 * b.chamberVolume_m3,
    closestCenterDistance_m: 2 * b.radius_m * Math.sin(Math.PI / 12),
    closestRequiredDistance_m: (b.adsBore_m + b.reliefBore_m) / 2 }
}

const calculation = String.raw`
import json,sys,math,CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import minimize_scalar
b=json.loads(sys.argv[1]);g=9.80665;checks=[]
def check(name,value,bound):
 if not math.isfinite(value) or abs(value)>bound:raise ValueError((name,value,bound))
 checks.append(dict(name=name,value=value,bound=bound))
def state(p,h):
 return dict(p=p,h=h,s=P('S','P',p,'H',h,'Water'),rho=P('D','P',p,'H',h,'Water'),u=P('U','P',p,'H',h,'Water'))
def flux(q,back):
 if back>=q['p']:return dict(G=0.,throat=q['p'])
 def trial(p):
  h=P('H','P',p,'S',q['s'],'Water');dh=q['h']-h
  if dh < -1e-6:raise ValueError('Negative nozzle work')
  return P('D','P',p,'S',q['s'],'Water')*math.sqrt(2*max(0.,dh))
 opt=minimize_scalar(lambda p:-trial(p),bounds=(back,q['p']),method='bounded',options={'xatol':.01})
 if not opt.success:raise ValueError('Nozzle search failed')
 candidates=[(trial(back),back),(-opt.fun,opt.x),(0.,q['p'])];G,pt=max(candidates)
 return dict(G=G,throat=pt)
p=b['reliefOpening_Pa'];liquid=state(p,P('H','P',p,'Q',0,'Water'));gas=state(p,P('H','P',p,'Q',1,'Water'))
fl=flux(liquid,101325.);fg=flux(gas,101325.);CdA=100/fg['G'];Arel=math.pi*b['reliefBore_m']**2/4
if not 0<CdA<Arel:raise ValueError('Selected relief bore cannot represent reference CdA')
check('reference steam capacity',CdA*fg['G']-100,1e-10)
phases=[]
for alpha in [0.,.5,1.]:
 ml=alpha*CdA*fl['G'];mg=(1-alpha)*CdA*fg['G']
 phases.append(dict(liquidVolumeFraction=alpha,liquid_kg_s=ml,vapor_kg_s=mg,total_kg_s=ml+mg,
  carriedH_W=ml*liquid['h']+mg*gas['h'],tracerEquivalent_s=ml*.001))
check('dry donor has no liquid',phases[0]['liquid_kg_s'],0.)
check('flooded donor has no gas',phases[2]['vapor_kg_s'],0.)
check('open equal pressure has no flow',flux(gas,p)['G'],0.)
# A real finite existing chamber: independent held boundary rates are not min(CdA1,CdA2).
V=b['chamberVolume_m3'];z=b['elevation_m'];q=state(1e6,P('H','P',1e6,'Q',.2,'Water'))
M=q['rho']*V;E=M*(q['u']+g*z);B=.001*M*.8
qin=.0002*flux(gas,q['p'])['G'];qout=.0002*flux(q,.3e6)['G'];dt=1e-5
Hin=gas['h']+g*z;Hout=q['h']+g*z;outB=.001*.8*qout
Mnew=M+dt*(qin-qout);Enew=E+dt*(qin*Hin-qout*Hout);Bnew=B-dt*outB
unew=Enew/Mnew-g*z;rho=Mnew/V
recovered=dict(p=P('P','D',rho,'U',unew,'Water'),T=P('T','D',rho,'U',unew,'Water'),quality=P('Q','D',rho,'U',unew,'Water'))
check('chamber independent mass incidence',Mnew-M-dt*(qin-qout),1e-12)
check('chamber energy incidence',Enew-E-dt*(qin*Hin-qout*Hout),1e-8)
check('chamber finite tracer incidence',Bnew-B+dt*outB,1e-15)
if Mnew<=0 or Bnew<0 or recovered['p']<=0:raise ValueError('Unrealizable finite chamber')
# A submerged receiver becomes the actual reverse donor; gravity is not a hidden check.
pCNV=.3e6;T=313.15;surface=14.;tap=9.;rhoW=P('D','P',pCNV,'T',T,'Water')
pW=pCNV+rhoW*g*(surface-tap);hW=P('H','P',pCNV,'T',T,'Water')+g*(surface-tap)
Htop=hW+g*(tap-z)
check('reverse WST total enthalpy at upper datum',Htop+g*z-hW-g*tap,1e-10)
reverse=flux(state(.3e6,P('H','P',.3e6,'T',423.15,'Water')),.2e6)
if reverse['G']<=0:raise ValueError('Open reverse gas path incorrectly blocked')
# Held-density first-law fixture at the fully submerged authored WST geometry.
# Not an advancing thermal/EOS pool calculation; the displaced bank is symmetric about z=12m.
rhoPool=P('D','P',101325.,'T',298.15,'Water');hPool=P('H','P',101325.,'T',298.15,'Water')
uPool=hPool-101325./rhoPool;Vpool=1200.;Vhardware=29.654930;Ah=200.;floor=8.;hardwareZ=12.
def pool_state(volume,datum):
 height=floor+(volume+Vhardware)/Ah
 moment=Ah*(height**2-floor**2)/2-Vhardware*hardwareZ
 mass=rhoPool*volume;PE=rhoPool*g*(moment+datum*volume)
 return dict(M=mass,V=volume,height=height,PE=PE,U=mass*uPool,E=mass*uPool+PE)
poolCases=[]
for datum in [0.,100.]:
 a=pool_state(Vpool,datum);geometryAfter=pool_state(Vpool+1/rhoPool,datum)
 Ht=hPool+g*(18.5+datum);work=101325./rhoPool
 Eafter=a['E']+Ht-work;Uafter=Eafter-geometryAfter['PE']
 extra=Uafter-geometryAfter['M']*uPool
 expected=g*(18.5-(a['height']+geometryAfter['height'])/2)
 check('pool gravity conversion datum '+str(datum),extra-expected,5e-5)
 check('pool and pressure-support reciprocal energy '+str(datum),Eafter-a['E']+work-Ht,5e-5)
 poolCases.append(dict(datumShift_m=datum,initial=a,finalGeometry=geometryAfter,receivedMass_kg=1.,sourceHt_J_kg=Ht,pressureWork_J=work,extraInternalEnergy_J=extra))
check('elevation reference cannot create pool heat',poolCases[0]['extraInternalEnergy_J']-poolCases[1]['extraInternalEnergy_J'],5e-5)
print(json.dumps(dict(scope='Native pure-water held restriction and finite chamber; mixed-species payload algebra is separate; no coupled PZR/ADS/CNV trajectory',dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),
 relief=dict(CdA_m2=CdA,physicalArea_m2=Arel,steam=fg,liquid=fl),phases=phases,
 chamber=dict(initialMass_kg=M,initialEnergy_J=E,inlet_kg_s=qin,outlet_kg_s=qout,dt_s=dt,finalMass_kg=Mnew,finalEnergy_J=Enew,finalTracer=Bnew,recovered=recovered),
 reverse=dict(gasFlux=reverse,WSTPressureAt9m_Pa=pW,WSTTopEquivalentH_J_kg=Htop),poolEnergy=poolCases,checks=checks),allow_nan=False))
`

if (import.meta.main) {
  const [python, output] = process.argv.slice(2)
  if (!python || !output) throw Error('Usage: bun reference-design-pzr-upper-discharge.ts <research-python> <receipt.json>')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const paths = [import.meta.path, new URL('./reference-design-rhr-local-relief.ts', import.meta.url).pathname,
    new URL('./reference-design-controlled-spray-phase.ts', import.meta.url).pathname]
  const sources = await Promise.all(paths.map(p => Bun.file(p).text()))
  const child = Bun.spawn([python, '-c', calculation, JSON.stringify(upperDischargeBasis)], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(stderr)
  const result = JSON.parse(stdout)
  for (let i = 0; i < paths.length; i++) if (hash(await Bun.file(paths[i]!).text()) !== hash(sources[i]!)) throw Error('Source changed during calculation')
  const receipt = { sourceSha256: hash(sources[0]!), dependencySha256: sources.slice(1).map(hash), calculationSha256: hash(calculation),
    basis: upperDischargeBasis, geometry: upperGeometry(),
    phaseAreaEndpoints: [0, .5, 1].map(a => sprayPhaseAreas(.0015, a)),
    mixedPayload: upperPayload(2, 3, .001, .7, .2, .1),
    mechanics: { partialOpening: advanceReliefLift(0, true, .02, .05), retainedBand: upperReliefDemand(15.7e6, true), reverseClosing: advanceReliefLift(.4, false, .01, .05) }, ...result }
  await Bun.write(output, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ output, checks: result.checks.length, sourceSha256: receipt.sourceSha256, calculationSha256: receipt.calculationSha256 }))
}
