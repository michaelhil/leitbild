/** Offline CMT LT hardware/native-state comparison; not instrumentation or a plant runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { hydrostaticLiquidPython } from './reference-design-hydrostatic-liquid.ts'
import { parseGeometryBasis, tankGeometry } from './reference-design-cmt-geometry.ts'

const positive = z.number().finite().positive()
const schema = z.object({ upperTap_m: z.number().finite(), lowerTap_m: z.number().finite(),
  bore_m: positive, outside_m: positive, topLength_m: positive, topFall_m: positive,
  bottomLength_m: positive, highLength_m: positive, chamberVolume_m3: positive,
  chamberSteel_kg: positive, steelDensity_kg_m3: positive, steelHeatCapacity_J_kgK: positive,
  steelConductivity_W_mK: positive, outsideCoefficient_W_m2K: positive,
  initialTemperature_K: positive, initialBoronMassFraction: z.number().min(0).max(0.002),
  comparisonPressure_Pa: positive, hotComparison_K: positive, isolatedRise_K: positive,
}).strict().refine(b => b.upperTap_m > b.lowerTap_m && b.outside_m > b.bore_m &&
  b.topFall_m < b.upperTap_m - b.lowerTap_m && b.topFall_m < b.topLength_m &&
  b.hotComparison_K > b.initialTemperature_K, 'Invalid physical routing or comparison')
export function parseCmtLevelLeg(text: string) {
  const blocks = [...text.matchAll(/^```reference-cmt-level-leg\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one CMT level-leg record')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function levelLegGeometry(b: z.infer<typeof schema>) {
  b = schema.parse(b)
  const area = Math.PI * b.bore_m ** 2 / 4, height = b.upperTap_m - b.lowerTap_m
  const lowLength_m = b.topLength_m + height - b.topFall_m + b.bottomLength_m
  const totalLength_m = lowLength_m + b.highLength_m
  const steel_kg = Math.PI * (b.outside_m ** 2 - b.bore_m ** 2) / 4 * totalLength_m * b.steelDensity_kg_m3 + 2 * b.chamberSteel_kg
  return { height_m: height, lowLength_m, totalLength_m, area_m2: area,
    lowVolume_m3: area * lowLength_m + b.chamberVolume_m3,
    highVolume_m3: area * b.highLength_m + b.chamberVolume_m3,
    totalWaterVolume_m3: area * totalLength_m + 2 * b.chamberVolume_m3,
    steel_kg, steelHeatCapacity_J_K: steel_kg * b.steelHeatCapacity_J_kgK,
    exposedTubeArea_m2: Math.PI * b.outside_m * totalLength_m,
    radialSteelResistance_K_W: Math.log(b.outside_m / b.bore_m) / (2 * Math.PI * b.steelConductivity_W_mK * totalLength_m),
  }
}
export const levelLegPython = hydrostaticLiquidPython + String.raw`
import json,sys,platform,CoolProp
from scipy.optimize import brentq
from scipy.integrate import quad
d=json.load(sys.stdin);b=d['basis'];geo=d['geometry'];g=9.80665
z0=b['lowerTap_m'];z1=b['upperTap_m'];A=geo['area_m2'];checks=[]
def check(name,error,limit):
    if not math.isfinite(error) or abs(error)>limit:raise ValueError(dict(check=name,error=error,limit=limit))
    checks.append(dict(check=name,error=error,limit=limit))
master=make_liquid_reservoir(A,z0,z1,z1)
def state(p,T,order=8):
    seed=liquid_pt_si(p,T);s=seed['s'];m=master['forward'](p,s)
    # Integrate actual sloped top tubing and vertical tubing; horizontal tail and chamber own finite water.
    segs=[(z0,z1-b['topFall_m'],A),(z1-b['topFall_m'],z1,A*b['topLength_m']/b['topFall_m'])]
    M=U=PE=0.
    for bottom,top,area in segs:
        at=m['at'](top);q=make_liquid_reservoir(area,bottom,top,top,order=order)['forward'](at['p'],s)
        M+=q['M'];U+=q['U'];PE+=q['PE']
    bottom=m['at'](z0);v=A*b['bottomLength_m']+b['chamberVolume_m3'];dm=v*bottom['rho']
    M+=dm;U+=dm*bottom['u'];PE+=dm*g*z0
    return dict(M=M,U=U,PE=PE,E=U+PE,p=p,s=s,T=T,bottomPressure_Pa=bottom['p'],topH=seed['h']+g*z1)
p=b['comparisonPressure_Pa'];Tc=b['initialTemperature_K'];Th=b['hotComparison_K']
cold=state(p,Tc);hot=state(p,Th);fine=state(p,Th,16)
check('spatial mass refinement kg',fine['M']-hot['M'],1e-9)
check('spatial energy refinement J',fine['E']-hot['E'],1e-4)
rhoCal=liquid_pt_si(p,Tc)['rho'];headCold=cold['bottomPressure_Pa']-p;headHot=hot['bottomPressure_Pa']-p
bias=(headCold-headHot)/(g*rhoCal)
liquid_pt_si(p,Tc);conductivity=_hydrostatic_water.conductivity()
hi=3.66*conductivity/b['bore_m'];L=geo['totalLength_m']
thermal=dict(liquidConductivity_W_mK=conductivity,insideCoefficient_W_m2K=hi,
    insideResistance_K_W=1/(hi*math.pi*b['bore_m']*L),
    outsideResistance_K_W=1/(b['outsideCoefficient_W_m2K']*math.pi*b['outside_m']*L),
    steelResistance_K_W=geo['radialSteelResistance_K_W'])
thermal['insideToOutsideResistanceRatio']=thermal['insideResistance_K_W']/thermal['outsideResistance_K_W']
# Quasistatic heated open branch: outward mass increments carry current top total enthalpy.
# Integration by parts avoids differencing near-identical native masses: -int H dM=-[HM]+int M dH.
def enthalpy_derivative(T):
    liquid_pt_si(p,T);return _hydrostatic_water.cpmass()
enthalpyMassIntegral=quad(lambda T:state(p,T)['M']*enthalpy_derivative(T),Tc,Th,epsabs=.001,epsrel=1e-9)[0]
exportEnergy=-(hot['topH']*hot['M']-cold['topH']*cold['M'])+enthalpyMassIntegral
heat=hot['E']-cold['E']+exportEnergy
# Independent trapezoidal mass-step ledger, same declared quasistatic path.
N=128;ts=np.linspace(Tc,Th,N+1);qs=[state(p,float(T)) for T in ts]
exportDiscrete=sum(-.5*(a['topH']+c['topH'])*(c['M']-a['M']) for a,c in zip(qs[:-1],qs[1:]))
check('independent exported energy quadrature J',exportDiscrete-exportEnergy,.2)
if not(cold['M']>hot['M'] and exportEnergy>0 and heat>0 and bias>0):raise ValueError('Open heating direction failed')
# Isolated rigid branch retains initial mass. Heating raises pressure instead of losing density/mass for free.
Tclosed=Tc+b['isolatedRise_K']
pClosed=brentq(lambda pp:state(pp,Tclosed)['M']-cold['M'],p,22e6,xtol=.001)
closed=state(pClosed,Tclosed)
check('isolated mass kg',closed['M']-cold['M'],1e-9)
if pClosed<=p:raise ValueError('Isolated thermal pressure response lost')
rows=[dict(cold=cold,heatedOpen=hot,heatedIsolated=closed,
    expelledMass_kg=cold['M']-hot['M'],expelledBoron_kg=(cold['M']-hot['M'])*b['initialBoronMassFraction'],
    exportedTotalEnthalpy_J=exportEnergy,heatToFluid_J=heat,indicationBias_m=bias,
    referenceHeadCold_Pa=headCold,referenceHeadHot_Pa=headHot,
    physicalColdEquivalentAtStage1_m=2-bias,physicalColdEquivalentAtStage4_m=1-bias)]
json.dump(dict(results=rows,thermal=thermal,checks=checks,versions=dict(Python=platform.python_version(),CoolProp=CoolProp.__version__),
    scope='Prescribed upper-pressure quasistatic all-liquid LP warming, fixed cold HP, native endpoint and heat/export ledgers; not connected accident timing or pressure integrity'),sys.stdout,indent=2,allow_nan=False)
`
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
if (import.meta.main) {
  const [owner, geometryOwner, python, output, ...extra] = process.argv.slice(2)
  if (!owner || !geometryOwner || !python || !output || extra.length) throw Error('Usage: cmt-level-leg owner.md geometry.md python output.json')
  const basis = parseCmtLevelLeg(await Bun.file(owner).text()), geometry = levelLegGeometry(basis)
  const tank = parseGeometryBasis(await Bun.file(geometryOwner).text()), physical = tankGeometry(tank)
  if (Math.abs(tank.upperTap_m - basis.upperTap_m) > 1e-9 || Math.abs(physical.mouth - basis.lowerTap_m) > 1e-9)
    throw Error('Instrument taps disagree with actual tank geometry')
  const input = { basis, geometry, tank }, source = await Bun.file(import.meta.path).text()
  const dependencyHashes = Object.fromEntries(await Promise.all(['reference-design-cmt-geometry.ts', 'reference-design-hydrostatic-liquid.ts']
    .map(async name => [name, hash(await Bun.file(new URL(name, import.meta.url)).text())])))
  const child = Bun.spawn([python, '-c', levelLegPython], { stdin: new Response(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code) throw Error(err)
  if (source !== await Bun.file(import.meta.path).text()) throw Error('Source changed during comparison')
  await Bun.write(output, JSON.stringify({ sourceHash: hash(source), dependencyHashes, calculationHash: hash(levelLegPython), inputHash: hash(JSON.stringify(input)),
    input, ...JSON.parse(out) }, null, 2) + '\n')
}
