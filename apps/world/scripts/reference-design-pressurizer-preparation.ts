/** Fresh offline PZR preparation. No advancement, controller or plant initializer. */
import { createHash } from 'node:crypto'
import { heaterBankBasis, heaterBankGeometry, heaterUpflowSection } from './reference-design-pressurizer-heater-banks'
import { acquirePressure, pressureDemand } from './reference-design-pressurizer-control'

export const preparationBasis = {
  topSeedPressure_Pa: 15e6, liquid_K: 600, steam_K: 630, metal_K: 600,
  absorberRatio: .001, bands_m: [0, 1, 3, 6, 9, 12], shellThickness_m: .15,
  commissionedSetpoint_Pa: 14864186.8055,
  // Fresh resting fills use these frozen asymmetric-parent STATIC source states.
  hotSource: { pressure_Pa: 14927136.86624869, temperature_K: 592.4157218542899 },
  coldSource: { pressure_Pa: 15202734.496391071, temperature_K: 563.4524774105149 },
} as const

export function preparationGeometry() {
  const b = heaterBankBasis, bands = preparationBasis.bands_m
  return bands.slice(0, -1).flatMap((lo, i) => {
    const hi = bands[i + 1]!, midpoint = (lo + hi) / 2
    return (['inner', 'outer'] as const).map(lane => ({ lane, lo_m: lo, hi_m: hi,
      centroid_m: b.bottom_m + midpoint,
      volume_m3: (hi - lo) * (lane === 'inner' ? heaterUpflowSection(midpoint) : b.vesselArea_m2 - b.upflowArea_m2),
      phase: hi <= 6 ? 'liquid' : 'steam', temperature_K: hi <= 6 ? preparationBasis.liquid_K : preparationBasis.steam_K }))
  })
}

export function initialPressureCommand(pressure_Pa: number) {
  const acquired = acquirePressure(pressure_Pa)
  if (acquired === null) throw Error('Prepared pressure outside acquisition span')
  return { acquired_Pa: acquired, ...pressureDemand({ pressure_Pa: acquired, sampledAt_s: 0, quality: 'usable' },
    0, preparationBasis.commissionedSetpoint_Pa, 3e6, 1e5) }
}

const calculation = String.raw`
import json,sys,math,CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.integrate import solve_ivp,quad
d=json.load(sys.stdin);b=d['basis'];g=9.80665;checks=[]
def check(name,error,bound):
 if not math.isfinite(error) or abs(error)>bound:raise ValueError((name,error,bound))
 checks.append(dict(name=name,error=error,bound=bound))
def rho(p,T):return P('D','P',p,'T',T,'Water')
def seed(z0,z1,p0,T):
 s=solve_ivp(lambda z,p:[-rho(float(p[0]),T)*g],(z0,z1),[p0],rtol=1e-11,atol=1e-5,dense_output=True)
 if not s.success:raise ValueError(s.message)
 return s
upper=seed(18.5,12.5,b['topSeedPressure_Pa'],b['steam_K'])
lower=seed(12.5,6.5,float(upper.y[0,-1]),b['liquid_K'])
def pressure(z):return float((lower if z<12.5 else upper).sol(z)[0])
regions=[]
for a in d['geometry']:
 p=pressure(a['centroid_m']);T=a['temperature_K'];V=a['volume_m3'];r=rho(p,T)
 u=P('U','P',p,'T',T,'Water');M=r*V;U=M*u;PE=M*g*a['centroid_m'];E=U+PE
 Ts=P('T','P',p,'Q',0,'Water')
 check('stable '+a['phase'],max(0.,T-Ts) if a['phase']=='liquid' else max(0.,Ts-T),0.)
 tr=P('T','D',M/V,'U',(E-PE)/M,'Water');pr=P('P','D',M/V,'U',(E-PE)/M,'Water')
 check('native region temperature recovery',tr-T,1e-5)
 check('native region pressure recovery',pr-p,.02)
 area=V/(a['hi_m']-a['lo_m'])
 integratedM=quad(lambda z:rho(pressure(z),T)*area,6.5+a['lo_m'],6.5+a['hi_m'],epsabs=1e-7)[0]
 regions.append(dict(**a,p_Pa=p,mass_kg=M,U_J=U,PE_J=PE,E_J=E,Pr=0.,Pz=0.,air_kg=0.,nitrogen_kg=0.,
   dissolvedTracer_kgEq=M*b['absorberRatio'] if a['phase']=='liquid' else 0.,retainedTracer_kgEq=0.,absentPhase=None,
   seedIntegratedMass_kg=integratedM,projectionMassDifference_kg=M-integratedM))
def totals(rows):return {key:sum(r[key] for r in rows) for key in ['mass_kg','U_J','PE_J','E_J']}
check('free volume and both bank displacement',sum(a['volume_m3'] for a in regions)+d['banks']['totalSolid_m3']-60,1e-12)
bottom=regions[1]['p_Pa'];top=regions[-1]['p_Pa'];dp=bottom-top
rl=P('D','P',15e6,'Q',0,'Water');rg=P('D','P',15e6,'Q',1,'Water')
lt=(dp-rg*g*12)/((rl-rg)*g)
check('fresh LT in return-to-service band',max(3.5-lt,lt-9.5,0),0)

# Uniform independently filled lines are deliberately NOT hydrostatic or flowing.
# The route mean elevations count PE; open connections are not held afterward.
# Exact geometric first moment of the existing two .45m quarter-bends/16m route.
surgeMean=3.000896016010998
lineInputs=[dict(name='surge',length=16.,diameter=.3,wall=.025,zmean=surgeMean,source=b['hotSource']),
 dict(name='controlled spray',length=25.,diameter=.1,wall=.01,zmean=10.75,source=b['coldSource']),
 dict(name='manual bypass',length=25.,diameter=.1,wall=.01,zmean=10.75,source=b['coldSource'])]
def metalEnergy(T):return 4184*(.1122*(T-300)+1.611e-5*(T*T-300*300))
lines=[]
for a in lineInputs:
 p=a['source']['pressure_Pa'];T=a['source']['temperature_K'];V=math.pi*a['diameter']**2/4*a['length']
 M=rho(p,T)*V;U=M*P('U','P',p,'T',T,'Water');PE=M*g*a['zmean']
 steel=math.pi*((a['diameter']/2+a['wall'])**2-(a['diameter']/2)**2)*a['length']*7920
 check('line stable liquid',max(0.,T-P('T','P',p,'Q',0,'Water')),0.)
 lines.append(dict(**a,volume_m3=V,mass_kg=M,U_J=U,PE_J=PE,E_J=U+PE,momentum=0.,
  dissolvedTracer_kgEq=M*b['absorberRatio'],steel_kg=steel,steel_K=T,steelCaloricEnergy_J=steel*metalEnergy(T)))
radius=math.sqrt(5/math.pi)
metals=[dict(name='normal rods',mass_kg=d['banks']['banks']['normal']['steelMass_kg']),
 dict(name='backup rods',mass_kg=d['banks']['banks']['backup']['steelMass_kg']),
 dict(name='shell',mass_kg=math.pi*((radius+.15)**2-radius**2)*12*7920),
 dict(name='bottom head',mass_kg=5*.15*7920),dict(name='top head',mass_kg=5*.15*7920)]
for a in metals:a.update(temperature_K=b['metal_K'],caloricEnergy_J=a['mass_kg']*metalEnergy(b['metal_K']))
# Six separately closed ADS inter-valve chambers: declared fresh steam service fill.
chamberV=.02;chamberM=rho(top,b['steam_K'])*chamberV
chamberU=chamberM*P('U','P',top,'T',b['steam_K'],'Water');chamberPE=chamberM*g*18.5
chambers=dict(count=6,eachVolume_m3=chamberV,eachMass_kg=chamberM,eachU_J=chamberU,eachPE_J=chamberPE,eachE_J=chamberU+chamberPE,pressure_Pa=top,temperature_K=b['steam_K'])
aggregate=totals(regions+lines)
for key in aggregate:aggregate[key]+=6*chambers['each'+{'mass_kg':'Mass_kg','U_J':'U_J','PE_J':'PE_J','E_J':'E_J'}[key]]
check('native fluid ledger',aggregate['E_J']-aggregate['U_J']-aggregate['PE_J'],1e-4)
print(json.dumps(dict(scope='Fresh independently prepared nonsteady PZR/line/chamber inventories; not an imported operating point or transient',dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),regions=regions,vesselTotals=totals(regions),lines=lines,metals=metals,chambers=chambers,fluidTotals=aggregate,metalCaloricTotal_J=sum(a['caloricEnergy_J'] for a in metals)+sum(a['steelCaloricEnergy_J'] for a in lines),observations=dict(topTrace_Pa=top,bottomTrace_Pa=bottom,DP_Pa=dp,LTunquantized_m=lt,topSeedDifference_Pa=top-b['topSeedPressure_Pa'],bottomSeedDifference_Pa=bottom-pressure(6.5)),projectionMassDifference_kg=sum(r['projectionMassDifference_kg'] for r in regions),checks=checks),sort_keys=True,allow_nan=False))
`

if (import.meta.main) {
  const [python, owner, output, ...extra] = Bun.argv.slice(2)
  if (!python || !owner || !output || extra.length) throw Error('Usage: preparation.ts <research-python> <thermal-owner.md> <receipt.json>')
  const paths = [import.meta.path, new URL('./reference-design-pressurizer-heater-banks.ts', import.meta.url).pathname,
    new URL('./reference-design-pressurizer-control.ts', import.meta.url).pathname, owner]
  const before = await Promise.all(paths.map(path => Bun.file(path).text()))
  const inputs = { basis: preparationBasis, geometry: preparationGeometry(), banks: heaterBankGeometry(6) }
  const child = Bun.spawn([python, '-c', calculation], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  child.stdin.write(JSON.stringify(inputs))
  child.stdin.end()
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code) throw Error(err)
  const result = JSON.parse(out)
  result.initialPressureCommand = initialPressureCommand(result.observations.topTrace_Pa)
  for (let i = 0; i < paths.length; i++) if (before[i] !== await Bun.file(paths[i]!).text()) throw Error('Source/context changed during calculation')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const receipt = { sourceSha256: hash(before[0]!), calculationSha256: hash(calculation), inputs,
    dependencySha256: before.slice(1, 3).map(hash), ownerContextSha256: hash(before[3]!), ...result }
  await Bun.write(output, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ output, checks: result.checks.length, source: receipt.sourceSha256, calculation: receipt.calculationSha256,
    observations: result.observations, fluidTotals: result.fluidTotals, initialPressureCommand: result.initialPressureCommand }))
}
