/** Bounded cold preparation / vacuum-machine coupon. No installed plant or startup solver. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { nativeMaterialFunctions } from './reference-design-rhr-material-wave'

export const vacuumSelection = { displacement_m3_s: 5, workEfficiency: .65, motorEfficiency: .95,
  motorRating_W: 500000, nominalSpeed_rad_s: 1500 * Math.PI / 30, drag_W: 5000,
  caseVolume_m3: .05, floodJamVolume_m3: .005, bodyCapacity_J_K: 1e7,
  inletCdA_m2: .5, outletCdA_m2: .05, overloadDelay_s: 2 } as const
export const coldPreparation = { temperature_K: 313.15, pressure_Pa: 101325,
  SG: { volume_m3: 120, gasVolume_m3: 48, metalCapacity_J_K: 150e6 },
  COND: { volume_m3: 6000, gasVolume_m3: 5000, metalCapacity_J_K: 1000e6 },
  MSHEADER: { volume_m3: 120 }, knockoutVolume_m3: 2, admittedPressure_Pa: 12000, airLoad_kg_s: .5 } as const

export function gasDisplacement(speedRatio: number) {
  if (!Number.isFinite(speedRatio) || speedRatio < 0) throw new Error('Invalid actual machine speed')
  return vacuumSelection.displacement_m3_s * speedRatio
}
export function inletConductance(opening: number, floatOpen: boolean) {
  if (!Number.isFinite(opening) || opening < 0 || opening > 1) throw new Error('Invalid achieved inlet opening')
  return vacuumSelection.inletCdA_m2 * opening * Number(floatOpen)
}
export function floodedMachine(liquidVolume: number) {
  if (!Number.isFinite(liquidVolume) || liquidVolume < 0 || liquidVolume > vacuumSelection.caseVolume_m3) throw new Error('Invalid retained case liquid volume')
  return liquidVolume >= vacuumSelection.floodJamVolume_m3
}

const comparison = String.raw`
import json,sys
data=json.load(sys.stdin)
sel=data['selection'];prep=data['preparation'];T0=prep['temperature_K'];patm=prep['pressure_Pa']
# Reuse the reviewed native material functions, including dh/dp=v, not the old entropy proxy.
exec(data['materialFunctions'])
from scipy.integrate import quad
from scipy.optimize import least_squares
import CoolProp,scipy
results=[]; checks=[]
def admit(name,condition):
 if not condition:raise ValueError(name)
 checks.append(name)
def wet(T,Vg,V,ma,mn,gravity=False):
 ps=P('P','T',T,'Q',1,'Water');p=ps+(ma*287+mn*296.8)*T/Vg
 rl=P('D','P',p,'T',T,'Water') if ma+mn else P('D','T',T,'Q',0,'Water')
 ul=P('U','P',p,'T',T,'Water') if ma+mn else P('U','T',T,'Q',0,'Water')
 ml=(V-Vg)*rl;mv=Vg*P('D','T',T,'Q',1,'Water')
 u=ml*ul+mv*P('U','T',T,'Q',1,'Water')+(ma*718+mn*742)*(T-298.15)
 pe=9.80665*ml*(-5+(V-Vg)/400) if gravity else 0
 return dict(T=T,p=p,water=ml+mv,liquid=ml,vapor=mv,air=ma,nitrogen=mn,Vg=Vg,U=u,E=u+pe,PE=pe)
for name,gravity in [('SG',False),('COND',True)]:
 V=prep[name]['volume_m3'];Vg=prep[name]['gasVolume_m3']
 T=T0;ps=P('P','T',T,'Q',1,'Water');ma=(patm-ps)*Vg/(287*T)
 a=wet(T,Vg,V,ma,0.,gravity)
 def residual(x):
  b=wet(x[0],x[1],V,ma,0.,gravity)
  return [(b['water']-a['water'])/a['water'],(b['E']-a['E'])/abs(a['E'])]
 sol=least_squares(residual,[T+.2,Vg*.999],bounds=([300.,.001],[340.,V-.001]),xtol=1e-13,ftol=1e-13,gtol=1e-13)
 admit(name+' native state recovery',sol.success and max(abs(v) for v in residual(sol.x))<1e-10)
 admit(name+' actual partial pressures',abs(a['p']-patm)<1e-8 and a['air']>0)
 results.append(dict(id=name,state=a,metalEnergyAboveZeroC_J=prep[name]['metalCapacity_J_K']*(T-273.15)))
# Existing finite MSHEADER, cold gas only. No fictitious condensed film or hot seed.
for name,V in [('MSHEADER',prep['MSHEADER']['volume_m3']),('VAC.KNOCKOUT',prep['knockoutVolume_m3']),('VAC.CASE',sel['caseVolume_m3'])]:
 T=T0;ps=P('P','T',T,'Q',1,'Water');ma=(patm-ps)*V/(287*T)
 gas=wet(T,V,V,ma,0.)
 admit(name+' has one shared gas volume and no liquid',gas['liquid']==0 and gas['water']>0 and abs(gas['p']-patm)<1e-8)
 results.append(dict(id=name,state=gas))
# Fixed-state compressor faces: native gas compression, actual efficiency and atmospheric export.
faces=[]
for pn in [93940.,30000.,5000.,1000.]:
 T=T0;pv=P('P','T',T,'Q',1,'Water');p=pv+pn
 rv=P('D','T',T,'Q',1,'Water');ratios={'air':pn/(287*T*rv),'nitrogen':0.}
 start=material(p,T,ratios);h0=start['h'];endp=patm
 if p<endp:
  # The wider bracket is a named gas-face comparison, not a new material-domain limit.
  def face(p,h):
   t=brentq(lambda t:material(p,t,ratios)['h']-h,300.,1600.,xtol=1e-9)
   return material(p,t,ratios)
  sol=solve_ivp(lambda p,y:[face(p,y[0])['v']],(p,endp),[h0],rtol=2e-9,atol=1e-5,dense_output=True)
  admit('gas compression integration',sol.success)
  reversible=sol.y[0,-1]-h0
  integral,error=quad(lambda p:face(p,float(sol.sol(p)[0]))['v'],p,endp,epsabs=.001)
  admit('native work identity',abs(reversible-integral)<.01)
  hout=h0+reversible/sel['workEfficiency'];out=face(endp,hout)
 else:reversible=0.;hout=h0;out=start
 rho=1/start['v'];shaft=sel['displacement_m3_s']*rho*(hout-h0)+sel['drag_W'];electric=shaft/sel['motorEfficiency']
 admit('gas stable face',start['ml']<1e-8 and out['ml']==0.)
 admit('motor rating admits frozen face',electric<sel['motorRating_W'])
 parcel=.01;exported=parcel*hout;shaftReceipt=parcel*(hout-h0)
 admit('single energy receipt',abs(exported-parcel*h0-shaftReceipt)<1e-8)
 faces.append(dict(inlet=start,outlet=out,reversibleWork_J_kg=reversible,shaft_W=shaft,electric_W=electric,
  parcel=dict(mass=parcel,water=parcel/(1+sum(ratios.values())),air=parcel*ratios['air']/(1+sum(ratios.values())),exportEnergy_J=exported,shaftReceipt_J=shaftReceipt)))
# Isothermal capacity screen only: its imposed heat exchange is disclosed, not a CW trajectory.
T=T0;ps=P('P','T',T,'Q',1,'Water');pna=patm-ps;threshold=prep['admittedPressure_Pa'];q=sel['displacement_m3_s']
drawdown=-prep['COND']['gasVolume_m3']/q*math.log((threshold-ps)/pna)
failedPumpPressure=ps+pna
leak=prep['airLoad_kg_s'] # prescribed air load; not a solved leak-area fixture
limit=ps+leak*287*T/q
admit('no extraction no recovered vacuum',failedPumpPressure>threshold)
admit('excess continuous air load defeats admission',limit>threshold)
admit('positive finite drawdown requirement',drawdown>0 and math.isfinite(drawdown))
warmPressure=P('P','T',333.15,'Q',1,'Water')
admit('current warm wet receiver alone denies admission',warmPressure>threshold)
# Pure NC analytic path checks the zero-water endpoint without calling native water.
R=287.;cv=718.;p0=10000.;Tout=T*(101325/p0)**(R/(cv+R));work=(cv+R)*(Tout-T)
integral=quad(lambda p:R*T*(p/p0)**(R/(cv+R))/p,p0,101325)[0]
admit('pure NC work identity',abs(work-integral)<1e-7)
# Zero NC uses genuine native water, beginning on its saturated gas side.
p0=ps;h0=P('H','T',T,'Q',1,'Water');s0=P('S','T',T,'Q',1,'Water')
pure=solve_ivp(lambda p,y:[water(p,y[0])['v']],(p0,patm),[h0],rtol=2e-9,atol=1e-5)
native=P('H','P',patm,'S',s0,'Water')
admit('zero NC native vapor work identity',pure.success and abs(pure.y[0,-1]-native)<.01)
# Flood-jam continuation coupon: no mass deletion; paid locked-rotor input becomes body heat.
lockedInput=sel['motorRating_W'];delay=sel['overloadDelay_s'];heat=lockedInput*delay
admit('finite jam heat receiver',heat/sel['bodyCapacity_J_K']==.1)
print(json.dumps(dict(libraries=dict(CoolProp=CoolProp.__version__,SciPy=scipy.__version__),
 preparations=results,faces=faces,capacityScreen=dict(isothermalTimeTo12kPa_s=drawdown,
 failedPumpPressure_Pa=failedPumpPressure,airLoad_kg_s=leak,airLoadEquilibriumPressure_Pa=limit,current60CWaterPartialPressure_Pa=warmPressure,
 meaning='Prescribed 40 C donor, fixed 5000 m3 gas occupancy and full speed; not achieved startup/cooling timing'),
 pureNC=dict(Tout=Tout,work=work),pureWaterVapor=dict(startPressure_Pa=p0,adiabaticWork_J_kg=pure.y[0,-1]-h0),jam=dict(input_W=lockedInput,delay_s=delay,bodyHeat_J=heat,bodyRise_K=heat/sel['bodyCapacity_J_K']),checks=checks)))
`

if (import.meta.main) {
  const [python, sgOwner, condenserOwner, receipt, ...extra] = process.argv.slice(2)
  if (!python || !sgOwner || !condenserOwner || !receipt || extra.length) throw new Error('Usage: cold-vacuum <research-python> <SG-owner> <COND-owner> <receipt.json>')
  const materialPath = resolve(import.meta.dir, 'reference-design-rhr-material-wave.ts')
  const calculation = comparison
  const input = { materialFunctions: nativeMaterialFunctions, selection: vacuumSelection, preparation: coldPreparation }
  const inputText = JSON.stringify(input)
  const result = spawnSync(python, ['-c', calculation], { input: inputText, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Cold/vacuum comparison failed')
  const hashSources = (paths: string[]) => paths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
  const output = { scope: 'Authored native cold preparation and frozen vacuum-machine/capacity/failure coupons; no parsed plant preparation or installed startup',
    reviewedContextSources: hashSources([sgOwner, condenserOwner]), calculationSources: hashSources([materialPath, import.meta.path]),
    consumedInputSHA256: createHash('sha256').update(inputText).digest('hex'), selection: vacuumSelection, preparation: coldPreparation, ...JSON.parse(result.stdout) }
  writeFileSync(receipt, JSON.stringify(output, null, 2) + '\n')
  console.log(JSON.stringify({ receipt, checks: output.checks.length, preparations: output.preparations, faces: output.faces.map((f: any) => ({ p: f.inlet.p, electric_W: f.electric_W, outletT_K: f.outlet.T })), capacityScreen: output.capacityScreen }))
}
