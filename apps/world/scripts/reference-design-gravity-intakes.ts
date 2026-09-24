/** Offline gravity-intake/head-memory selection. No installed plant or branch trajectory. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { hydrostaticLiquidPython } from './reference-design-hydrostatic-liquid'

const positive = z.number().finite().positive()
const schema = z.object({ diameter_m: positive, terminal_m: z.number().finite(), reviewSubmergence_m: positive,
  referenceTemperature_K: positive, referencePressure_Pa: positive, referenceFlow_kg_s: positive, checkCrack_Pa: positive, wstInitialSurface_m: z.number().finite(),
  branches: z.array(z.object({ name: z.enum(['GIV', 'RECIRC']), length_m: positive, intake_m: z.number().finite(),
    variableDrop_Pa: positive, meterDrop_Pa: positive }).strict()).length(2),
}).strict().superRefine((b, ctx) => {
  for (const name of ['GIV', 'RECIRC']) if (b.branches.filter(x => x.name === name).length !== 1) ctx.addIssue({ code: 'custom', message: 'One branch of each type required' })
  if (b.branches.some(x => x.length_m < Math.abs(x.intake_m - b.terminal_m))) ctx.addIssue({ code: 'custom', message: 'Route shorter than elevation change' })
})
export function parseGravityIntakes(text: string) {
  const blocks = [...text.matchAll(/^```reference-gravity-intakes\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one current gravity-intake record')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function intakePhase(surface: number, mouth: number) {
  if (![surface, mouth].every(Number.isFinite)) throw Error('Invalid surface/mouth')
  return surface > mouth ? 'liquid' : 'gas'
}
export function effectiveOpening(achieved: number, screen: number) {
  if (![achieved, screen].every(x => Number.isFinite(x) && x >= 0 && x <= 1)) throw Error('Invalid achieved opening/screen')
  return achieved * screen
}
export function terminalCheck(columnPressure: number, dviPressure: number, failedOpen: boolean, crack: number) {
  if (![columnPressure, dviPressure, crack].every(Number.isFinite) || Math.min(columnPressure, dviPressure) <= 0 || crack < 0) throw Error('Invalid check state')
  if (failedOpen) return { seated: false, sign: Math.sign(columnPressure - dviPressure), meterDownstreamPressure_Pa: dviPressure }
  return columnPressure <= dviPressure + crack
    ? { seated: true, sign: 0, meterDownstreamPressure_Pa: columnPressure }
    : { seated: false, sign: 1, meterDownstreamPressure_Pa: dviPressure + crack }
}

const calculation = hydrostaticLiquidPython + String.raw`
import json,sys,CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq,minimize_scalar
b=json.loads(sys.argv[1]);g=9.80665;checks=[];A=math.pi*b['diameter_m']**2/4
def check(name,value,bound):
 if not math.isfinite(value) or abs(value)>bound:raise ValueError((name,value,bound))
 checks.append(dict(name=name,value=value,bound=bound))
def water(p,h):
 return dict(p=p,h=h,s=P('S','P',p,'H',h,'Water'),rho=P('D','P',p,'H',h,'Water'),u=P('U','P',p,'H',h,'Water'),T=P('T','P',p,'H',h,'Water'),kind='water')
R=.8*287+.2*296.8;cv=.8*718+.2*742;cp=cv+R
def gas(p,h):
 T=(h+cv*298.15)/cp
 if T<=0:raise ValueError('Nonpositive gas temperature')
 return dict(p=p,h=h,T=T,rho=p/(R*T),u=cv*(T-298.15),s=cp*math.log(T/298.15)-R*math.log(p/101325.),kind='ideal-NC-limit')
def at_pressure(q,p):return water(p,q['h']) if q['kind']=='water' else gas(p,q['h'])
def nozzle(q,pback,area):
 if area==0 or pback>=q['p']:return dict(m=0.,criticalPressure_Pa=q['p'],choked=False)
 def trial(p):
  if q['kind']=='water':h=P('H','P',p,'S',q['s'],'Water');rho=P('D','P',p,'S',q['s'],'Water')
  else:
   T=q['T']*(p/q['p'])**(R/cp);h=cp*T-cv*298.15;rho=p/(R*T)
  work=q['h']-h
  if work < -1e-6:raise ValueError('Negative native nozzle work')
  return rho*math.sqrt(2*max(work,0.))
 opt=minimize_scalar(lambda p:-trial(p),bounds=(pback,q['p']),method='bounded',options={'xatol':.001})
 if not opt.success:raise ValueError('Capacity maximization failed')
 G,p=max([(trial(pback),pback),(-opt.fun,opt.x),(0.,q['p'])])
 return dict(m=area*G,criticalPressure_Pa=p,choked=bool(p>pback+.1))
def native_entropy_gate(q,p):
 out=at_pressure(q,p);change=out['s']-q['s']
 if change < -1e-7:raise ValueError(('Negative dissipation',change))
 return change
reference=[]
for branch in b['branches']:
 record=dict(name=branch['name'])
 for part in ['variable','meter']:
  dp=branch[part+'Drop_Pa'];up=b['referencePressure_Pa']+dp
  q=water(up,P('H','P',up,'T',b['referenceTemperature_K'],'Water'))
  area=b['referenceFlow_kg_s']/nozzle(q,b['referencePressure_Pa'],1.)['m']
  if not 0<area<A:raise ValueError('Effective throat exceeds physical mouth')
  record[part+'CdA_m2']=area
  check(branch['name']+' '+part+' native calibration',nozzle(q,b['referencePressure_Pa'],area)['m']-b['referenceFlow_kg_s'],1e-10)
  record[part+'EntropyRise_J_kgK']=native_entropy_gate(q,b['referencePressure_Pa'])
 reference.append(record)
# Freeze the failed massless-column alternative with its original ordinary material states.
p=101325.;T=298.15;surface=14.148275;zi=8.2;zt=3.;Thot=383.15
rho=P('D','P',p,'T',T,'Water');hs=P('H','P',p,'T',T,'Water')
pport=p+rho*g*(surface-zi);hport=hs+g*(surface-zi);s=P('S','P',pport,'H',hport,'Water')
pF=P('P','H',hport+g*(zi-zt),'S',s,'Water')
def reverse_threshold(pd):
 hd=P('H','P',pd,'T',Thot,'Water');sd=P('S','P',pd,'T',Thot,'Water')
 return P('H','P',pport,'S',sd,'Water')-hd+g*(zi-zt)
pR=brentq(reverse_threshold,180000.,230000.);mid=.5*(pF+pR)
if not pR<mid<pF:raise ValueError('Named rejection no longer reproduced')
rejected=dict(inputs=dict(poolPressure_Pa=p,poolTemperature_K=T,poolSurface_m=surface,intake_m=zi,terminal_m=zt,hotTemperature_K=Thot),
 intakePressure_Pa=pport,coldForwardThreshold_Pa=pF,hotReverseThreshold_Pa=pR,overlap_Pa=pF-pR,midpoint_Pa=mid,hotTemperature_K=Thot)
# The same real GIV geometry now has one retained head, not one new fill per guessed sign.
branch=next(x for x in b['branches'] if x['name']=='GIV');givRef=next(x for x in reference if x['name']=='GIV')
p=b['referencePressure_Pa'];T=b['referenceTemperature_K'];zi=branch['intake_m'];zt=b['terminal_m'];surface=b['wstInitialSurface_m']
rho=P('D','P',p,'T',T,'Water');hs=P('H','P',p,'T',T,'Water');pport=p+rho*g*(surface-zi);hport=hs+g*(surface-zi)
s=P('S','P',pport,'H',hport,'Water');pCurrent=P('P','H',hport+g*(zi-zt),'S',s,'Water')
volume=A*branch['length_m'];bottom=min(zi,zt);top=max(zi,zt)
column=make_liquid_reservoir(volume/(top-bottom),bottom,top,zi)
cold=column['forward'](pport,s);hotSeed=liquid_pt_si(pport,Thot);hot=column['forward'](pport,hotSeed['s'])
check('cold native head reproduces its physical endpoint',cold['at'](zt)['p']-pCurrent,.002)
currentMid=.5*(cold['at'](zt)['p']+hot['at'](zt)['p'])
if not cold['at'](zt)['p']>currentMid>hot['at'](zt)['p']:raise ValueError('Retained fill does not determine contrary head')
# Source ISO shut: terminal failed check admits hot DVI water into the retained cold column.
# Both finite native owners change once; the source is not a held infinite reservoir.
dvi=make_liquid_reservoir(.5,zt-.5,zt+.5,zt)
seed=liquid_pt_si(4e5,Thot);donor=dvi['forward'](seed['p'],seed['s']);Hd=donor['at'](zt)['h']+g*zt
q=water(donor['at'](zt)['p'],donor['at'](zt)['h']);flow=nozzle(q,cold['at'](zt)['p'],givRef['meterCdA_m2'])
dm=.001;dt=dm/flow['m'];nextColumn=column['recover'](cold['M']+dm,cold['E']+dm*Hd,(pport,s))
nextDvi=dvi['recover'](donor['M']-dm,donor['E']-dm*Hd,(seed['p'],seed['s']))
check('two finite owner native mass',nextColumn['M']+nextDvi['M']-cold['M']-donor['M'],2e-6)
check('two finite owner native total energy',nextColumn['E']+nextDvi['E']-cold['E']-donor['E'],.02)
# Passive tracer is an equivalent amount, not additional native carrier mass/energy.
Bc=.002*cold['M'];Bd=.001*donor['M'];payload=.001*dm
check('finite donor tracer payload retained',((Bc+payload)+(Bd-payload))-(Bc+Bd),1e-12)
# Change only the elevation reference of the same finite transaction, not its physics.
datumShift=100.;shiftedColumnTarget=cold['E']+g*datumShift*cold['M']+dm*(Hd+g*datumShift)
check('coordinate-shifted column target',shiftedColumnTarget-g*datumShift*(cold['M']+dm)-(cold['E']+dm*Hd),1e-7)
if not cold['at'](zt)['p']<nextColumn['at'](zt)['p']<nextDvi['at'](zt)['p']:raise ValueError('Admission no longer has available pressure')
if not abs(nextColumn['at'](zi)['T']-cold['at'](zi)['T'])<.01:raise ValueError('Incoming donor reset the retained thermal fill')
# Terminal meter actual raw static DP and seat, independent of source ISO position.
meter=[]
for name,up,pd,healthy in [('liquid-forward',water(151325.,P('H','P',151325.,'T',T,'Water')),101325.,True),
 ('gas-forward',gas(3e5,cp*353.15-cv*298.15),101325.,True),
 ('flashing-forward',water(1e6,P('H','P',1e6,'Q',0,'Water')),101325.,True)]:
 bp=pd+b['checkCrack_Pa'] if healthy else pd
 f=nozzle(up,bp,givRef['meterCdA_m2']);ds=native_entropy_gate(up,bp)
 receiver=at_pressure(up,pd)
 meter.append(dict(name=name,donor=up,flow=f,rawDP_Pa=up['p']-bp,unboundedLiquidConversion_kg_s=b['referenceFlow_kg_s']*math.sqrt((up['p']-bp)/branch['meterDrop_Pa']),
  rawSpanMagnitude_Pa=20000.,rawOverrange=abs(up['p']-bp)>20000.,acquisitionScope='Pre-acquisition conversion only; no healthy display claim outside raw span',
  downstream=receiver,entropyRise_J_kgK=ds))
 if f['m']<=0:raise ValueError('Nonzero admitted pressure has no flow')
check('exact open zero-head limit',nozzle(q,q['p'],givRef['meterCdA_m2'])['m'],0.)
check('closed source restriction',nozzle(q,101325.,0.)['m'],0.)
# Dry-air preparation at source elevation; analytic hydrostatic/caloric profile, not free priming.
rb=next(x for x in b['branches'] if x['name']=='RECIRC');V=A*rb['length_m'];Rair=287.;cvair=718.;cpair=Rair+cvair
gx,gw=np.polynomial.legendre.leggauss(16);low=min(rb['intake_m'],zt);high=max(rb['intake_m'],zt)
M=E=0.
for x,w in zip(gx,gw):
 z=low+(x+1)*(high-low)/2;temp=T-g*(z-rb['intake_m'])/cpair
 pressure=p*(temp/T)**(cpair/Rair);r=pressure/(Rair*temp);dV=w*V/2
 M+=r*dV;E+=r*dV*(cvair*(temp-298.15)+g*z)
def serializable(q):return {k:v for k,v in q.items() if k!='at'}
print(json.dumps(dict(scope='One rejected massless direction rule; native retained-liquid head and one reciprocal finite receipt; isolated meter material limits and dry-air preparation, not a branch trajectory',
 dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),reference=reference,rejectedMassless=rejected,
 column=dict(volume_m3=volume,cold=serializable(cold),hot=serializable(hot),terminalColdPressure_Pa=cold['at'](zt)['p'],terminalHotPressure_Pa=hot['at'](zt)['p']),
 finiteReceipt=dict(mass_kg=dm,dt_s=dt,flow_kg_s=flow['m'],rawReverseDP_Pa=cold['at'](zt)['p']-donor['at'](zt)['p'],initialColumn=serializable(cold),finalColumn=serializable(nextColumn),
  initialDvi=serializable(donor),finalDvi=serializable(nextDvi),initialColumnMouthTemperature_K=cold['at'](zi)['T'],columnMouthTemperature_K=nextColumn['at'](zi)['T'],
  rawReverseOverrange=abs(cold['at'](zt)['p']-donor['at'](zt)['p'])>20000.,
  tracer=dict(initialColumn_kgEq=Bc,initialDvi_kgEq=Bd,payload_kgEq=payload,finalColumn_kgEq=Bc+payload,finalDvi_kgEq=Bd-payload,finalColumnConcentration=(Bc+payload)/nextColumn['M']),
  datumShift_m=datumShift,datumScope='Algebraic energy-coordinate invariance, not a second trajectory'),
 meters=meter,dryRecircPreparation=dict(volume_m3=V,mass_kg=M,totalEnergy_J=E,composition='dry air, not a copy of saturated CNV'),checks=checks),allow_nan=False))
`

if (import.meta.main) {
  const [ownerPath, python, output, ...extra] = process.argv.slice(2)
  if (!ownerPath || !python || !output || extra.length) throw Error('Usage: gravity-intakes owner.md research-python receipt.json')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const paths = [import.meta.path, new URL('./reference-design-hydrostatic-liquid.ts', import.meta.url).pathname, ownerPath]
  const before = await Promise.all(paths.map(p => Bun.file(p).text()))
  const basis = parseGravityIntakes(before[2]!)
  const child = Bun.spawn([python, '-c', calculation, JSON.stringify(basis)], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  const numeric = JSON.parse(out)
  const after = await Promise.all(paths.map(p => Bun.file(p).text()))
  if (before.some((s, i) => s !== after[i])) throw Error('Consumed source/owner changed')
  const endpointChecks = [
    { name: 'seated healthy terminal has zero meter DP', passed: terminalCheck(2e5, 3e5, false, 1000).meterDownstreamPressure_Pa === 2e5 },
    { name: 'failed check permits actual reverse', passed: terminalCheck(2e5, 3e5, true, 1000).sign === -1 },
    { name: 'covered/exposed mouth', passed: intakePhase(8.200001, 8.2) === 'liquid' && intakePhase(8.2, 8.2) === 'gas' },
  ]
  if (endpointChecks.some(c => !c.passed)) throw Error('Endpoint selection failed')
  await Bun.write(output, JSON.stringify({ sourceSha256: hash(before[0]!), hydrostaticSourceSha256: hash(before[1]!), ownerSha256: hash(before[2]!),
    calculationSha256: hash(calculation), basis, numeric, endpointChecks, checkCount: numeric.checks.length + endpointChecks.length }, null, 2) + '\n')
  console.log(JSON.stringify({ output, checks: numeric.checks.length + endpointChecks.length }))
}
