/** Offline reference engineering calculation, not a World runtime or wiki evaluator.
 * Python/iapws is intentionally an isolated research dependency, never installed
 * on the server. Authored numeric input is data; no wiki text is executed.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const basisSchema = z.object({
  design: z.literal('LD-01'),
  reactorHeat_MW: positive,
  primaryPressure_MPaAbs: positive,
  coreInlet_C: positive,
  coreOutlet_C: positive,
  steamGenerators: z.number().int().positive(),
  secondaryPressure_MPaAbs: positive,
  feedInlet_C: positive,
  feedSourcePressure_MPaAbs: positive,
  feedSource_C: positive,
  feedPumpDischarge_MPaAbs: positive,
  feedPumpHydraulicEfficiency: positive.max(1),
  feedPumpMotorEfficiency: positive.max(1),
  secondaryVolume_m3: positive,
  secondaryLiquidVolume_m3: positive,
  submergedVaporVolume_m3: positive,
  equivalentLevelArea_m2: positive,
  wallCapacity_MJ_K: positive,
}).strict().superRefine((v, ctx) => {
  for (const [ok, message] of [
    [v.coreOutlet_C > v.coreInlet_C, 'core outlet must be hotter than inlet'],
    [v.secondaryLiquidVolume_m3 + v.submergedVaporVolume_m3 < v.secondaryVolume_m3, 'equivalent indicated region must leave a steam space'],
    [v.feedPumpDischarge_MPaAbs > v.secondaryPressure_MPaAbs, 'pump discharge must exceed SG pressure'],
    [v.feedPumpDischarge_MPaAbs > v.feedSourcePressure_MPaAbs, 'pump pressure rise must be positive'],
  ] as const) if (!ok) ctx.addIssue({ code: 'custom', message })
})

export const parseBalanceBasis = (document: string) => {
  const blocks = [...document.matchAll(/^```reference-balance\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected exactly one reference-balance JSON block')
  return basisSchema.parse(JSON.parse(blocks[0]![1]!))
}

// Published IAPWS test points, not output captured from this calculation.
// The calculation uses the package's forward equations for the comparison.
const calculation = String.raw`
import sys, json, math, platform
import iapws
from iapws import IAPWS97 as W
b=json.load(sys.stdin)
checks=[]
def check(label, actual, expected, rel=1e-8, absolute=1e-12):
    error=abs(actual-expected)
    if error > max(absolute, abs(expected)*rel):
        raise ValueError(f'{label}: {actual} != {expected}')
    checks.append(dict(check=label, actual=actual, expected=expected, absoluteError=error))
for p,t,h,v in [(3,300,115.331273,.00100215168),(80,300,184.142828,.000971180894),(3,500,975.542239,.00120241800)]:
    w=W(P=p,T=t)
    check(f'IF97 table5 h({p},{t})',w.h,h)
    check(f'IF97 table5 v({p},{t})',w.v,v)
for p,t,h in [(.0035,300,2549.91145),(.0035,700,3335.68375),(30,700,2631.49474)]:
    check(f'IF97 table15 h({p},{t})',W(P=p,T=t).h,h)
for t,p in [(300,.00353658941),(500,2.63889776),(600,12.3443146)]:
    check(f'IF97 table35 p({t})',W(T=t,x=0).P,p)
pc=b['primaryPressure_MPaAbs']; ps=b['secondaryPressure_MPaAbs']
cold=W(P=pc,T=b['coreInlet_C']+273.15)
hot=W(P=pc,T=b['coreOutlet_C']+273.15)
feed=W(P=ps,T=b['feedInlet_C']+273.15)
liq=W(P=ps,x=0); steam=W(P=ps,x=1)
source=W(P=b['feedSourcePressure_MPaAbs'],T=b['feedSource_C']+273.15)
if cold.region!=1 or hot.region!=1 or feed.region!=1 or source.region!=1:
    raise ValueError('Selected liquid points must be stable IF97 region1')
if not hot.T > cold.T > steam.T > feed.T:
    raise ValueError('Reference heat-transfer temperature ordering is invalid')
heat=b['reactorHeat_MW']*1000
n=b['steamGenerators']; q=heat/n
primary=heat/(hot.h-cold.h)
flow=q/(steam.h-feed.h)
dt_hot=hot.T-steam.T; dt_cold=cold.T-steam.T
lmtd=(dt_hot-dt_cold)/math.log(dt_hot/dt_cold)
wallT=(cold.T+steam.T)/2
gp=q/(cold.T-wallT); gs=q/(wallT-steam.T)
ml=liq.rho*b['secondaryLiquidVolume_m3']
mv=steam.rho*(b['secondaryVolume_m3']-b['secondaryLiquidVolume_m3'])
U=ml*liq.u+mv*steam.u
iso_pump=W(P=b['feedPumpDischarge_MPaAbs'],s=source.s)
pump_delta_h=(iso_pump.h-source.h)/b['feedPumpHydraulicEfficiency']
pump_h=source.h+pump_delta_h
pumpout=W(P=b['feedPumpDischarge_MPaAbs'],h=pump_h)
pumpFluid_kW=flow*pump_delta_h
pumpElectric_kW=pumpFluid_kW/b['feedPumpMotorEfficiency']
conditioning_kW=flow*(feed.h-pump_h)
if conditioning_kW < 0: raise ValueError('Reference conditioner is not a heat input')
check('Primary nominal heat balance kW',primary*(hot.h-cold.h),heat,rel=1e-12)
check('Secondary nominal heat balance kW',flow*(steam.h-feed.h),q,rel=1e-12)
check('Feed pump + conditioner + SG energy kW',flow*(steam.h-source.h),pumpFluid_kW+conditioning_kW+q,rel=1e-12)
check('Secondary geometric closure m3',ml/liq.rho+mv/steam.rho,b['secondaryVolume_m3'],rel=1e-12)
points={}
for name,w in [('core_inlet',cold),('core_outlet',hot),('SG_feed_inlet',feed),('SG_saturated_liquid',liq),('SG_saturated_steam',steam),('feed_source',source),('pump_discharge',pumpout)]:
    points[name]=dict(p_MPaAbs=w.P,T_C=w.T-273.15,h_kJ_kg=w.h,u_kJ_kg=w.u,rho_kg_m3=w.rho)
out=dict(
    dependencies=dict(python=platform.python_version(),iapws=iapws.__version__),
    points=points,
    derived=dict(primaryFlow_kg_s=primary,primaryLoopFlow_kg_s=primary/n,
        SGSteamFlow_kg_s=flow,totalSteamFlow_kg_s=flow*n,
        SGSensibleDuty_MW=flow*(liq.h-feed.h)/1000,
        SGLatentDuty_MW=flow*(steam.h-liq.h)/1000,
        saturation_C=steam.T-273.15,coldEndApproach_K=dt_cold,
        isothermalSecondaryLMTD_K=lmtd,isothermalSecondaryUA_MW_K=q/lmtd/1000,
        mixedCellWall_C=wallT-273.15,mixedCellGp_MW_K=gp/1000,mixedCellGs_MW_K=gs/1000,
        wallTimeConstant_s=b['wallCapacity_MJ_K']/(gp/1000+gs/1000),
        secondaryLiquidMass_kg=ml,secondaryVaporMass_kg=mv,secondaryMass_kg=ml+mv,
        secondaryEnergy_MJ=U/1000,secondaryMassQuality=mv/(ml+mv),
        submergedVaporFraction=b['submergedVaporVolume_m3']/(b['secondaryVolume_m3']-b['secondaryLiquidVolume_m3']),
        collapsedLevel_m=b['secondaryLiquidVolume_m3']/b['equivalentLevelArea_m2'],
        apparentLevel_m=(b['secondaryLiquidVolume_m3']+b['submergedVaporVolume_m3'])/b['equivalentLevelArea_m2'],
        feedPumpFluidPowerEach_MW=pumpFluid_kW/1000,
        feedPumpElectricPowerEach_MW=pumpElectric_kW/1000,
        feedConditioningTotal_MW=conditioning_kW*n/1000,
        wholeSecondaryInput_MW=(pumpFluid_kW+conditioning_kW+q)*n/1000),
    checks=checks)
print(json.dumps(out,allow_nan=False))
`

export const runBalance = async (document: string, python: string) => {
  const basis = parseBalanceBasis(document)
  const input = JSON.stringify(basis)
  const process = Bun.spawn([python, '-c', calculation], {
    stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe',
  })
  const [output, error, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ])
  if (code !== 0) throw new Error(`Reference calculation failed: ${error}`)
  return {
    inputSha256: createHash('sha256').update(input).digest('hex'),
    calculationSha256: createHash('sha256').update(calculation).digest('hex'),
    basis, ...JSON.parse(output),
  }
}

if (import.meta.main) {
  const [document, python] = Bun.argv.slice(2)
  if (!document || !python) throw new Error('Usage: bun reference-design-balance.ts <basis.md> <isolated-python>')
  console.log(JSON.stringify(await runBalance(await Bun.file(document).text(), python), null, 2))
}
