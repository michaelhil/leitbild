/** Offline LD-01 component fixtures. Fixed Python source; strict numeric wiki input. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const finite = z.number().finite()
const positive = finite.positive()
const schema = z.object({
  design: z.literal('LD-01'), gravity_m_s2: positive, containmentPressure_MPaAbs: positive,
  coldPortPressure_MPaAbs: positive, coldPort_C: finite, CMT_C: finite, CMTVolume_m3: positive,
  CMTBalanceRise_m: positive, CMTReferenceFlow_kg_s: positive,
  accGasPressure_MPaAbs: positive, accGasVolume_m3: positive, accWaterVolume_m3: positive, acc_C: finite,
  WSTSurface_m: finite, DVIElevation_m: finite, sumpRim_m: finite, sumpFloor_m: finite, sumpArea_m2: positive,
  recircReferenceFlow_kg_s: positive, recircLoss_Pa: positive, DVIReferenceFlow_kg_s: positive,
  DVILoss_Pa: positive, checkCracking_Pa: positive,
  ADS_CdA_m2: z.tuple([positive,positive,positive,positive]),
  RHRFlow_kg_s: positive, RHRInlet_C: finite, RHROutlet_C: finite, RHRPressure_MPaAbs: positive,
  RHRColdFlow_kg_s: positive, RHRColdInlet_C: finite,
  rotorH_s: positive, rotorBase_MW: positive, rotor_rpm: positive, corePower_MW: positive,
  coreFlowArea_m2: positive, coreDh_m: positive, coreSurface_m2: positive,
  decayFractions: z.tuple([positive,positive,positive,positive,positive,positive]),
  decayTimes_s: z.tuple([positive,positive,positive,positive,positive,positive]),
}).strict().superRefine((b,c) => {
  for(const [ok,message] of [
    [b.decayFractions.reduce((s,x)=>s+x,0)<1,'delayed fraction must be below one'],
    [b.sumpRim_m>b.DVIElevation_m && b.DVIElevation_m>b.sumpFloor_m,'sump geometry invalid'],
    [b.RHRInlet_C>b.RHROutlet_C && b.RHROutlet_C>b.RHRColdInlet_C,'RHR thermal ordering invalid'],
    [b.accWaterVolume_m3>2,'accumulator water must exceed the 2 m³ diagnostic residual'],
  ] as const) if(!ok)c.addIssue({code:'custom',message})
})

export function parseTransientFixtureBasis(document: string) {
  const blocks=[...document.matchAll(/^```reference-transient-fixtures\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw new Error('Expected exactly one reference-transient-fixtures JSON block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

const calculation = String.raw`
import json,sys,platform,math
import numpy as np
import scipy, iapws
from scipy.optimize import brentq, minimize_scalar
from scipy.integrate import solve_ivp
from iapws import IAPWS97 as W
b=json.load(sys.stdin)
g=b['gravity_m_s2']; checks=[]; out={}
def check(name,a,e,rtol=1e-8,atol=1e-10):
    if abs(a-e)>max(atol,abs(e)*rtol):raise ValueError(f'{name}: {a} != {e}')
    checks.append(dict(name=name,actual=float(a),expected=float(e)))
for p,t,h in [(3,300,115.331273),(80,300,184.142828),(.0035,700,3335.68375)]:
    check('IF97 published enthalpy',W(P=p,T=t).h,h)
hot=W(P=b['coldPortPressure_MPaAbs'],T=b['coldPort_C']+273.15)
cold=W(P=b['coldPortPressure_MPaAbs'],T=b['CMT_C']+273.15)
head=g*b['CMTBalanceRise_m']*(cold.rho-hot.rho)
K=20000/b['CMTReferenceFlow_kg_s']**2+2000/b['CMTReferenceFlow_kg_s']**2+b['DVILoss_Pa']/b['DVIReferenceFlow_kg_s']**2
flow=math.sqrt(max(0,head-b['checkCracking_Pa'])/K)
out['CMT']=dict(top_pressure_MPa=b['coldPortPressure_MPaAbs']-hot.rho*g*b['CMTBalanceRise_m']/1e6,
               cold_column_driving_head_Pa=head,recirculation_reference_flow_kg_s=flow,
               cold_inventory_kg=cold.rho*b['CMTVolume_m3'],
               nominal_20m3_reserve_s=cold.rho*20/flow)
R=296.8; cv=742.; gamma=1+R/cv
V0=b['accGasVolume_m3']; p0=b['accGasPressure_MPaAbs']*1e6; T0=b['acc_C']+273.15
Ng=p0*V0/(R*T0); rows=[]
for released in [0,*[b['accWaterVolume_m3']*x/35 for x in [10,20,30]],b['accWaterVolume_m3']-2]:
    V=V0+released; p=p0*(V0/V)**gamma; T=T0*(V0/V)**(gamma-1)
    work=p0*V0/(gamma-1)*(1-(V0/V)**(gamma-1))
    check('adiabatic gas energy',Ng*cv*(T0-T),work)
    rows.append(dict(released_m3=released,pressure_MPa=p/1e6,temperature_K=T,work_MJ=work/1e6))
out['accumulator']=dict(nitrogen_kg=Ng,gamma=gamma,states=rows)
pool=W(P=b['containmentPressure_MPaAbs'],T=298.15)
Krec=b['recircLoss_Pa']/b['recircReferenceFlow_kg_s']**2+b['DVILoss_Pa']/b['DVIReferenceFlow_kg_s']**2
rows=[]
for oppose_m in [0,0.5,1.0]:
    dp=pool.rho*g*(b['sumpRim_m']-b['DVIElevation_m']-oppose_m)-b['checkCracking_Pa']
    m=math.sqrt(max(0,dp)/Krec)
    rows.append(dict(reactor_opposing_water_head_m=oppose_m,one_train_flow_kg_s=m,total_two_train_flow_kg_s=2*m))
out['gravity']=dict(sump_zero_geometric_head_volume_m3=(b['DVIElevation_m']-b['sumpFloor_m'])*b['sumpArea_m2'],
                    WST_zero_flow_max_extra_receiver_pressure_MPa=(pool.rho*g*(b['WSTSurface_m']-b['DVIElevation_m'])-b['checkCracking_Pa'])/1e6,
                    rim_recirc=rows)
def flux(up,pdown):
    if pdown>=up.P:return 0.,up.P
    def f(p):
        s=W(P=p,s=up.s)
        return s.rho*math.sqrt(max(0,2*(up.h-s.h)*1000))
    grid=np.geomspace(pdown,up.P,100)
    vals=[f(float(p)) for p in grid]; j=int(np.argmax(vals))
    lo=float(grid[max(0,j-1)]); hi=float(grid[min(len(grid)-1,j+1)])
    opt=minimize_scalar(lambda p:-f(p),bounds=(lo,hi),method='bounded',options={'xatol':1e-11})
    best=max([(float(vals[j]),float(grid[j])),(f(float(opt.x)),float(opt.x))])
    return best
rows=[]
for pin,kind in [(15.,'saturated_vapor'),(5.,'saturated_vapor'),(1.,'saturated_vapor')]:
    up=W(P=pin,x=1); G,pt=flux(up,b['containmentPressure_MPaAbs']+pool.rho*g*5/1e6)
    rows.append(dict(upstream_MPa=pin,phase=kind,throat_MPa=pt,G_kg_m2_s=G,
                     paired_single_valve_upper_flows_kg_s=[2*a*G for a in b['ADS_CdA_m2']]))
out['ADS_nozzle']=rows
Gr,ptr=flux(W(P=7.,x=1),.101325)
out['SG_relief']=dict(reference_flow_each_kg_s=.6*819.818983,
                      effective_CdA_each_m2=.6*819.818983/Gr,
                      full_lift_flux_kg_m2_s=Gr,throat_MPa=ptr)
f=np.array(b['decayFractions']); tau=np.array(b['decayTimes_s']); P=b['corePower_MW']
histories=[]
for hist in [3600.,1e20]:
    E0=f*P*tau*(-np.expm1(-hist/tau))
    rows=[]
    for t in [0,1,10,100,3600,86400]:
        q=float(np.sum(E0/tau*np.exp(-t/tau)))
        latent=(W(P=.2,x=1).h-W(P=.2,x=0).h)/1000
        rows.append(dict(time_s=t,decay_MW=q,boiloff_kg_s_at_0p2MPa=q/latent))
    histories.append(dict(history_s=hist,rows=rows))
    sol=solve_ivp(lambda t,e:-e/tau,(0,100),E0,rtol=1e-10,atol=1e-10,method='Radau')
    check('decay numerical vs analytic',float(np.sum(sol.y[:,-1]/tau)),float(np.sum(E0/tau*np.exp(-100/tau))),rtol=1e-8)
out['decay']=histories
ri=W(P=b['RHRPressure_MPaAbs'],T=b['RHRInlet_C']+273.15)
ro=W(P=b['RHRPressure_MPaAbs'],T=b['RHROutlet_C']+273.15)
Q=b['RHRFlow_kg_s']*(ri.h-ro.h)*1000
Tc=b['RHRColdInlet_C']+Q/(b['RHRColdFlow_kg_s']*4180)
out['RHR']=dict(one_train_duty_MW=Q/1e6,CCW_outlet_C=Tc,
                hot_mixed_conductance_MW_K=Q/(b['RHROutlet_C']-70)/1e6,
                cold_mixed_conductance_MW_K=Q/(70-Tc)/1e6,
                pump_total_flow_kg_s=b['RHRFlow_kg_s']+15,
                pump_fluid_work_MW=(b['RHRFlow_kg_s']+15)*500000/ri.rho/1e6,
                pump_hydraulic_shaft_power_MW=(b['RHRFlow_kg_s']+15)*500000/ri.rho/.75/1e6,
                pump_total_shaft_power_MW=(b['RHRFlow_kg_s']+15)*500000/ri.rho/.75*1.01/1e6,
                pump_electrical_power_MW=(b['RHRFlow_kg_s']+15)*500000/ri.rho/.75*1.01/.92/1e6)
if not Tc<70<b['RHROutlet_C']:raise ValueError('RHR wall approaches invalid')
omega=b['rotor_rpm']*2*math.pi/60; E=b['rotorH_s']*b['rotorBase_MW']
out['shaft']=dict(inertia_kg_m2=2*E*1e6/omega**2,energy_MJ=E,
                  excess_work_to_110percent_MJ=E*(1.1**2-1),
                  full_1030MW_seconds_to_110percent=E*(1.1**2-1)/1030.662)
ci=W(P=15.2,T=563.15); cm=W(P=15.1,T=578.15); co=W(P=15,T=593.15)
mc=P*1000/(co.h-ci.h); rows=[]
for water,prev in [(cm,ci),(co,cm)]:
    q=mc*(water.h-prev.h)*1000; A=b['coreSurface_m2']/2
    def coeff(Ts):
        film=W(P=water.P,T=(water.T+Ts)/2)
        Re=mc*b['coreDh_m']/(b['coreFlowArea_m2']*film.mu)
        Pr=film.cp*1000*film.mu/film.k
        Nu=.023*Re**.8*Pr**.4
        return Nu*film.k/b['coreDh_m'],Re,Pr
    sat=W(P=water.P,x=0).T
    Ts=brentq(lambda t:A*coeff(t)[0]*(t-water.T)-q,water.T+1e-8,sat-1e-6)
    h,Re,Pr=coeff(Ts)
    check('nominal core convection',A*h*(Ts-water.T),q)
    rows.append(dict(bulk_C=water.T-273.15,surface_C=Ts-273.15,saturation_C=sat-273.15,
                     film_HTC_W_m2_K=h,Re=Re,Pr=Pr,cell_duty_MW=q/1e6,
                     fuel_surface_conductance_MW_K=q/(873.15-Ts)/1e6))
out['core_convection']=rows
heatedLength=b['coreSurface_m2']/(4*b['coreFlowArea_m2']/b['coreDh_m'])
heatedVolume=b['coreFlowArea_m2']*heatedLength
check('selected heated coolant geometry',heatedVolume,18.)
geometry=[('LOWER',28.5,ci),('CORE.1',heatedVolume/2,cm),('CORE.2',heatedVolume/2,co),('UPPER',33.5,co)]
out['heated_channel_inventory']=dict(heated_length_m=heatedLength,heated_volume_m3=heatedVolume,
    components=[dict(name=name,volume_m3=volume,mass_kg=volume*water.rho,
        internal_energy_MJ=volume*water.rho*water.u/1000,residence_s=volume*water.rho/mc) for name,volume,water in geometry],
    heated_residence_s=heatedVolume/2*(cm.rho+co.rho)/mc,
    nominal_inventory_change_from_reallocated_17m3_kg=8.5*(ci.rho-cm.rho))
li=math.log(2)/(6.57*3600); lx=math.log(2)/(9.10*3600); sigma=2.6e6*1e-28; phi=3e17
F=P*1e6/(200e6*1.602176634e-19*35)
NI=.06*F/li; NX=.063*F/(lx+sigma*phi)
def pois(t,y):return [-li*y[0],li*y[0]-lx*y[1]]
sol=solve_ivp(pois,(0,86400),[NI,NX],dense_output=True,rtol=1e-10,atol=1,method='Radau')
out['xenon']=dict(NI_reference_atoms_m3=NI,NX_reference_atoms_m3=NX,
                   shutdown_ratios=[dict(hours=h,ratio=float(sol.sol(h*3600)[1]/NX)) for h in [0,1,6,12,24]])
# Closed water/steam/N2 fixture; nitrogen reference matches all receiving owners.
Tmix=400.; pmix=1.; Vmix=10.; Ml0=5000.
liquid=W(P=pmix,T=Tmix); vapor=W(T=Tmix,x=1)
Vg0=Vmix-Ml0*liquid.v; Mv0=vapor.rho*Vg0
MN0=(pmix-vapor.P)*1e6*Vg0/(R*Tmix); MW0=Ml0+Mv0
U0=Ml0*liquid.u*1000+Mv0*vapor.u*1000+MN0*cv*(Tmix-298.15)
def state_at_T(T):
    vap=W(T=T,x=1)
    def atp(p):
        liq=W(P=p,T=T); Ml=(Vmix-MW0*vap.v)/(liq.v-vap.v)
        Vg=Vmix-Ml*liq.v; Mv=MW0-Ml
        return Ml,Mv,Vg,liq
    def pressure_residual(p):
        Ml,Mv,Vg,liq=atp(p)
        return p-vap.P-MN0*R*T/Vg/1e6
    p=brentq(pressure_residual,vap.P+1e-8,2.)
    Ml,Mv,Vg,liq=atp(p)
    U=Ml*liq.u*1000+Mv*vap.u*1000+MN0*cv*(T-298.15)
    return p,Ml,Mv,Vg,U
Tsol=brentq(lambda T:state_at_T(T)[4]-U0,395.,405.,xtol=1e-10)
psol,Mlsol,Mvsol,Vgsol,Usol=state_at_T(Tsol)
check('mixed nitrogen temperature inversion',Tsol,Tmix)
check('mixed nitrogen pressure inversion',psol,pmix)
check('mixed nitrogen water mass',Mlsol+Mvsol,MW0)
check('mixed nitrogen total energy',Usol,U0)
check('mixed nitrogen common gas volume',Mvsol/W(T=Tsol,x=1).rho,Vgsol)
out['nitrogen_mixture']=dict(temperature_K=Tsol,total_pressure_MPa=psol,water_vapor_partial_MPa=W(T=Tsol,x=1).P,
    nitrogen_mass_kg=MN0,water_mass_kg=MW0,liquid_mass_kg=Mlsol,shared_gas_volume_m3=Vgsol,
    total_energy_MJ=Usol/1e6,poynting_exponent=liquid.v*(pmix-vapor.P)*1e6/(461.5*Tmix))
print(json.dumps(dict(versions=dict(python=platform.python_version(),iapws=iapws.__version__,numpy=np.__version__,scipy=scipy.__version__),checks=checks,results=out),indent=2))
`

if(import.meta.main) {
  const [documentPath,python]=Bun.argv.slice(2)
  if(!documentPath||!python)throw new Error('Usage: reference-design-transients.ts wiki-page python-executable')
  const document=await Bun.file(documentPath).text()
  const basis=parseTransientFixtureBasis(document)
  const input=JSON.stringify(basis)
  const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
  const result=Bun.spawnSync([python,'-c',calculation],{stdin:Buffer.from(input),stdout:'pipe',stderr:'pipe'})
  if(result.exitCode!==0)throw new Error(result.stderr.toString())
  console.log(JSON.stringify({input_sha256:hash(input),calculation_sha256:hash(calculation),...JSON.parse(result.stdout.toString())},null,2))
}
