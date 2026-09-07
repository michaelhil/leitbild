/** Offline observation comparisons; never an installed plant instrumentation runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const finite = z.number().finite()
const positive = finite.positive()
const fraction = finite.min(0).max(1)
const schema = z.object({
  design: z.literal('LD-01'), gravity_m_s2: positive,
  rawDPZeroBound_Pa: finite.nonnegative(), rawDPQuantum_Pa: positive,
  flowLag_s: positive, sample_s: positive,
  meters: z.array(z.object({
    name: z.enum(['CMT','ACC','GIV','RECIRC','DVI','PRHR','RHR']),
    referenceFlow_kg_s: positive, meterDrop_Pa: positive,
    totalReferenceDrop_Pa: positive,
  }).strict()).length(7),
  liquidDensity_kg_m3: positive, gasDensity_kg_m3: positive,
  voidFractions: z.array(fraction).min(2).max(20),
  levelPressure_MPaAbs: positive, levelHeight_m: positive,
  levelLiquidHeight_m: finite.nonnegative(), referenceCold_C: finite,
  referenceHot_C: finite, referenceVoidFraction: fraction,
  levelLag_s: positive, levelRawError_Pa: finite.nonnegative(),
  cmtHeight_m: positive, cmtPressure_MPaAbs: positive,
  cmtCold_C: finite, cmtHot_C: finite,
  subcoolingTotalPressure_MPaAbs: positive, subcoolingFluid_C: finite,
  probeCapacity_J_K: positive, probeLiquidUA_W_K: positive, probeGasUA_W_K: positive,
  probeInitial_C: finite, probeHotFluid_C: finite, probeObservation_s: positive,
}).strict().superRefine((b,c) => {
  const requirements: [boolean,string][] = [
    [new Set(b.meters.map(m=>m.name)).size===7,'meter identities must be unique'],
    [b.meters.every(m=>m.meterDrop_Pa<=m.totalReferenceDrop_Pa),'meter loss exceeds parent loss'],
    [b.liquidDensity_kg_m3>b.gasDensity_kg_m3,'density ordering invalid'],
    [b.levelLiquidHeight_m<=b.levelHeight_m,'liquid height outside tap span'],
    [b.referenceHot_C>b.referenceCold_C,'reference thermal exposure must warm'],
    [b.cmtHot_C>b.cmtCold_C,'CMT layer ordering invalid'],
    [b.probeLiquidUA_W_K>b.probeGasUA_W_K,'probe contact conductance ordering invalid'],
    [b.probeHotFluid_C>b.probeInitial_C,'probe fixture must heat'],
    [b.sample_s<=b.flowLag_s && b.sample_s<=b.levelLag_s,'sampling too slow for selected lag fixture'],
  ]
  for(const [ok,message] of requirements) if(!ok)c.addIssue({code:'custom',message})
})

export function parseObservationFixtureBasis(document: string) {
  const blocks=[...document.matchAll(/^```reference-observation-fixtures\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw new Error('Expected exactly one reference-observation-fixtures JSON block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

/** Conditional liquid-calibration evidence from delivered DP only; no phase truth input. */
export function flowEvidence(rawDP_Pa: number, referenceFlow_kg_s: number, referenceDrop_Pa: number, errorBound_Pa: number) {
  if(![rawDP_Pa,referenceFlow_kg_s,referenceDrop_Pa,errorBound_Pa].every(Number.isFinite)
    ||referenceFlow_kg_s<=0||referenceDrop_Pa<=0||errorBound_Pa<0)throw new Error('Invalid flow evidence input')
  const convert=(dp:number)=>Math.sign(dp)*referenceFlow_kg_s*Math.sqrt(Math.abs(dp)/referenceDrop_Pa)
  const lower=convert(rawDP_Pa-errorBound_Pa), upper=convert(rawDP_Pa+errorBound_Pa)
  const direction=lower>0?'forward':upper<0?'reverse':'unresolved'
  const condition=lower>3?'positive_established':upper< -3?'reverse_established'
    :lower>= -2&&upper<=2?'low_established':'indeterminate'
  return {rawDP_Pa,lowerLiquidCalibration_kg_s:lower,upperLiquidCalibration_kg_s:upper,direction,condition}
}

export const observationCalculation = String.raw`
import json,sys,math,platform
import iapws
from iapws import IAPWS97 as W
b=json.load(sys.stdin); g=b['gravity_m_s2']; checks=[]
def check(name,a,e,tol=1e-9):
    if abs(a-e)>tol*max(1,abs(e)):raise ValueError(f'{name}: {a} != {e}')
    checks.append(dict(name=name,actual=a,expected=e))
def liquid(p,t):
    w=W(P=p,T=t+273.15)
    if w.phase not in ('Liquid','Compressible liquid'):raise ValueError('liquid fixture outside liquid region')
    return w
E=b['rawDPZeroBound_Pa']+b['rawDPQuantum_Pa']/2
flow=[]
for m in b['meters']:
    m0=m['referenceFlow_kg_s']; d0=m['meterDrop_Pa']
    def dp(v):return d0*v*abs(v)/m0**2
    def indicated(d):return math.copysign(m0*math.sqrt(abs(d)/d0),d) if d else 0.
    for v in [-m0,-3.,0.,3.,m0]:check('signed liquid calibration',indicated(dp(v)),v)
    # Interval is conditional on the liquid calibration, not a gas correction.
    low_dp=dp(2)-E; clear_dp=dp(3)+E
    low_possible=low_dp>=0
    flow.append(dict(name=m['name'],reference_flow_kg_s=m0,meter_drop_Pa=d0,
       remaining_parent_drop_Pa=m['totalReferenceDrop_Pa']-d0,
       raw_error_bound_Pa=E,zero_possible_indicated_abs_kg_s=indicated(E),
       indicated_3kg_s_raw_Pa=dp(3),
       conservative_low_2kg_s_DP_upper_Pa=low_dp,
       low_2kg_s_qualifiable_at_zero_DP=low_possible,
       conservative_clear_3kg_s_DP_lower_Pa=clear_dp,
       required_indicated_for_3kg_s_lower_bound=indicated(clear_dp),
       zero_flow_extremes=[dict(raw_DP_Pa=d,indicated_kg_s=indicated(d)) for d in [-E,E]]))
bias=[]
for a in b['voidFractions']:
    rho=(1-a)*b['liquidDensity_kg_m3']+a*b['gasDensity_kg_m3']
    mass_liquid_fraction=(1-a)*b['liquidDensity_kg_m3']/rho
    ratio=math.sqrt(b['liquidDensity_kg_m3']/rho)
    bias.append(dict(void_fraction=a,mixture_density_kg_m3=rho,
       indicated_over_total_mass=ratio,liquid_mass_fraction=mass_liquid_fraction,
       indicated_over_liquid_mass=ratio/mass_liquid_fraction if mass_liquid_fraction else None,
       illustrative_total_mass_kg_s=10.,
       illustrative_liquid_mass_kg_s=10.*mass_liquid_fraction,
       illustrative_liquid_calibrated_indication_kg_s=10.*ratio,
       electronic_quality='AVAILABLE'))
p=b['levelPressure_MPaAbs']; H=b['levelHeight_m']; L=b['levelLiquidHeight_m']
lf=W(P=p,x=0); vg=W(P=p,x=1)
rc=liquid(p,b['referenceCold_C']).rho; rh=liquid(p,b['referenceHot_C']).rho
def raw_level(column_mass_area,reference_density):return g*(column_mass_area-reference_density*H)
def level(d):return (d/g-(vg.rho-rc)*H)/(lf.rho-vg.rho)
column=lf.rho*L+vg.rho*(H-L)
d0=raw_level(column,rc)
check('nominal DP level calibration',level(d0),L)
level_rows=[]
for name,ref in [('cold_reference',rc),('heated_reference',rh),
                 ('prescribed_reference_void',rh*(1-b['referenceVoidFraction'])+vg.rho*b['referenceVoidFraction'])]:
    d=raw_level(column,ref)
    calculated=level(d)
    level_rows.append(dict(case=name,actual_liquid_height_m=L,reference_density_kg_m3=ref,
       raw_DP_Pa=d,calibrated_unbounded_height_m=calculated,
       reported_height_m=min(H,max(0.,calculated)),
       range='ABOVE_RANGE' if calculated>H else 'BELOW_RANGE' if calculated<0 else 'IN_RANGE',
       electronic_quality='AVAILABLE'))
    check('reference head bias',level(d)-L,(rc-ref)*H/(lf.rho-vg.rho))
# Four CMT strata, each constant cross-section: cold and hot *fully liquid* states.
# Both carry exactly H metres of liquid volume; calibration need not show full.
ch=b['cmtHeight_m']; pc=b['cmtPressure_MPaAbs']
cold=liquid(pc,b['cmtCold_C']).rho; hot=liquid(pc,b['cmtHot_C']).rho
cmt=[]
for hot_layers in range(5):
    column=ch/4*((4-hot_layers)*cold+hot_layers*hot)
    d=g*(column-cold*ch)
    cmt.append(dict(hot_layers=hot_layers,actual_liquid_depth_m=ch,
                   raw_DP_Pa=d,indicated_cold_water_equivalent_m=ch+d/(g*cold)))
check('cold CMT full indication',cmt[0]['indicated_cold_water_equivalent_m'],ch)
# The acquisition kernel filters raw pressure. Loss of power freezes state, not an invented zero.
tau=b['flowLag_s']; dt=b['sample_s']; target=100.; y=0.
def acquire(previous,target,powered):
    if not powered:return previous,None,'UNAVAILABLE'
    state=target+(previous-target)*math.exp(-dt/tau)
    quant=b['rawDPQuantum_Pa']
    reported=math.floor(state/quant+.5)*quant
    return state,reported,'AVAILABLE'
for i in range(10):y,reported,quality=acquire(y,target,True)
check('raw pressure lag vs analytic',y,target*(1-math.exp(-10*dt/tau)))
held=y
for i in range(10):y,reported,quality=acquire(y,0.,False)
if reported is not None or quality!='UNAVAILABLE':raise ValueError('unpowered observation leaked value')
check('unpowered retained state',y,held)
restored,reported,quality=acquire(y,0.,True)
if not 0.<restored<held:raise ValueError('restoration must reacquire retained lag toward changed process')
# Saturation estimate consumes total PT. Nitrogen partial pressure is research evidence only.
pt=b['subcoolingTotalPressure_MPaAbs']; t=b['subcoolingFluid_C']
ps=W(T=t+273.15,x=1).P
if ps>=pt:raise ValueError('nitrogen mixture requires positive nitrogen partial pressure')
sub=dict(measured_total_pressure_MPa=pt,measured_temperature_C=t,
         water_only_indicated_subcooling_C=W(P=pt,x=0).T-273.15-t,
         engineering_water_vapor_partial_pressure_MPa=ps,
         engineering_nitrogen_partial_pressure_MPa=pt-ps,electronic_quality='AVAILABLE')
# Finite thermal probe: prescribed contact boundary, NOT a generated reflood environment.
C=b['probeCapacity_J_K']; T0=b['probeInitial_C']; Tf=b['probeHotFluid_C']; time=b['probeObservation_s']
probe=[]
for name,ua in [('liquid_contact',b['probeLiquidUA_W_K']),('gas_contact',b['probeGasUA_W_K'])]:
    T=Tf+(T0-Tf)*math.exp(-ua*time/C)
    Eprobe=C*(T-T0)
    integral=ua*(Tf-T0)*(C/ua)*(1-math.exp(-ua*time/C))
    check('probe heat integral',Eprobe,integral)
    probe.append(dict(contact=name,UA_W_K=ua,time_constant_s=C/ua,
                      time_s=time,fluid_temperature_C=Tf,probe_temperature_C=T,absorbed_J=Eprobe))
print(json.dumps(dict(versions=dict(python=platform.python_version(),iapws=iapws.__version__),checks=checks,
    results=dict(flow=flow,homogeneous_flow_bias=bias,DP_level=level_rows,CMT_thermal_layers=cmt,
      level_error_height_m=b['levelRawError_Pa']/(g*(lf.rho-vg.rho)),
      acquisition=dict(before_loss_raw_Pa=held,power_loss_quality='UNAVAILABLE',physical_DP_after_loss_Pa=0.,
                       after_reacquisition_raw_Pa=restored,after_reacquisition_reported_Pa=reported),
      apparent_subcooling=sub,thermal_probe=probe)),indent=2,allow_nan=False))
`

if(import.meta.main) {
  const [documentPath,python,...rest]=Bun.argv.slice(2)
  if(!documentPath||!python||rest.length)throw new Error('Usage: reference-design-observations.ts wiki-page python-executable')
  const input=JSON.stringify(parseObservationFixtureBasis(await Bun.file(documentPath).text()))
  const result=Bun.spawnSync([python,'-c',observationCalculation],{stdin:Buffer.from(input),stdout:'pipe',stderr:'pipe'})
  if(result.exitCode!==0)throw new Error(result.stderr.toString())
  const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
  const output=JSON.parse(result.stdout.toString())
  for(const row of output.results.flow) {
    row.deliveredEvidenceCases=[-2*row.raw_error_bound_Pa,-row.raw_error_bound_Pa,0,row.raw_error_bound_Pa,
      2*row.raw_error_bound_Pa,row.conservative_clear_3kg_s_DP_lower_Pa+.5].map(raw=>
      flowEvidence(raw,row.reference_flow_kg_s,row.meter_drop_Pa,row.raw_error_bound_Pa))
  }
  console.log(JSON.stringify({input_sha256:hash(input),calculation_sha256:hash(observationCalculation),
    evidence_calculation_sha256:hash(flowEvidence.toString()),...output},null,2))
}
