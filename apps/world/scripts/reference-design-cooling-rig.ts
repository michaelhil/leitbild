/** Offline water/steam pressure-pot and gravity-source coupling experiment, not an LD-01 runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const nonnegative = z.number().finite().nonnegative()
const basisSchema = z.object({
  design: z.literal('LD-01 cooling-source bench'),
  vesselVolume_m3: positive, vesselHeight_m: positive, initialPressure_MPa: positive,
  initialLiquidFraction: positive.max(0.8), steamPort_m: positive, injectionPort_m: positive,
  ambientPressure_MPa: positive, poolTemperature_C: positive.max(90), heater_MW: nonnegative,
  duration_s: positive.max(3600), step_s: positive.max(0.5),
  ADS_CdA_m2: positive, WSTArea_m2: positive, WSTFloor_m: z.number().finite(),
  WSTVolume_m3: positive, sumpArea_m2: positive, sumpFloor_m: z.number().finite(),
  sumpRim_m: z.number().finite(), floorArea_m2: positive,
  sourceLoss_Pa: positive, recircLoss_Pa: positive, sourceReferenceFlow_kg_s: positive,
  DVILoss_Pa: positive, DVIReferenceFlow_kg_s: positive, checkCracking_Pa: positive,
  ACTCapacity_kJ: positive, ACTAvailable_kW: positive, ACTBaseline_kW: positive,
  releasePower_kW: positive, releaseDuration_s: positive, travel_s: positive,
}).strict().superRefine((b,ctx) => {
  const rules: [boolean,string][] = [
    [b.initialPressure_MPa > b.ambientPressure_MPa && b.initialPressure_MPa < 4, 'initial pressure must be above ambient and below 4 MPa'],
    [b.steamPort_m > b.initialLiquidFraction*b.vesselHeight_m && b.steamPort_m < b.vesselHeight_m, 'steam port must initially be above liquid and below vessel roof'],
    [b.injectionPort_m < b.vesselHeight_m, 'injection port must be inside vessel'],
    [b.sumpFloor_m < b.injectionPort_m && b.injectionPort_m < b.sumpRim_m, 'sump must span the injection-port elevation'],
    [b.ACTAvailable_kW >= b.ACTBaseline_kW, 'ACT available power must cover the baseline duty'],
    [b.step_s <= Math.min(b.releaseDuration_s,b.travel_s)/2, 'step must resolve pulse and valve travel'],
    [b.duration_s/b.step_s <= 120000, 'offline calculation exceeds the declared 120000-step experiment bound'],
  ]
  for (const [ok,message] of rules) if (!ok) ctx.addIssue({code:'custom',message})
})

export function parseCoolingRigBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-cooling-rig\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected exactly one reference-cooling-rig JSON block')
  return basisSchema.parse(JSON.parse(blocks[0]![1]!))
}

const calculation = String.raw`
import json,sys,math,platform,time
import numpy as np
import scipy,iapws
from scipy.optimize import brentq,minimize_scalar
from scipy.interpolate import PchipInterpolator
from iapws import IAPWS97 as W
b=json.load(sys.stdin); started=time.monotonic(); g=9.80665
pa=b['ambientPressure_MPa']; V=b['vesselVolume_m3']; A=V/b['vesselHeight_m']
cold=W(P=pa,T=b['poolTemperature_C']+273.15); rho=cold.rho; hc=cold.h*1000
Ksrc=b['sourceLoss_Pa']/b['sourceReferenceFlow_kg_s']**2
Krec=b['recircLoss_Pa']/b['sourceReferenceFlow_kg_s']**2
Kdvi=b['DVILoss_Pa']/b['DVIReferenceFlow_kg_s']**2
crack=b['checkCracking_Pa']

def spill_transfer(ms,mf,h):
    zs=b['sumpFloor_m']+ms/rho/b['sumpArea_m2'];zf=b['sumpRim_m']+mf/rho/b['floorArea_m2']
    if zs<=b['sumpRim_m'] and mf<=0:return 0.
    dh=zs-zf
    # Stop the explicit step at equal surface potential; do not overshoot then undo flow.
    equalization=abs(dh)*rho/(1/b['sumpArea_m2']+1/b['floorArea_m2'])
    amount=min(1.7*4.*abs(dh)**1.5*rho*h,equalization,ms if dh>0 else mf)
    return math.copysign(amount,dh)

test_ms=rho*(b['sumpRim_m']-b['sumpFloor_m']+.5)*b['sumpArea_m2']
spill_test=spill_transfer(test_ms,0.,1000.)
test_zs=b['sumpFloor_m']+(test_ms-spill_test)/rho/b['sumpArea_m2']
test_zf=b['sumpRim_m']+spill_test/rho/b['floorArea_m2']
if test_zs<test_zf-1e-10:raise ValueError('Spill crossed equal surface potential')

def nozzle(p):
    if p<=pa:return 0.
    up=W(P=p,x=1)
    def flux(pd):
        down=W(P=float(pd),s=up.s)
        return down.rho*math.sqrt(max(0,2000*(up.h-down.h)))
    grid=np.geomspace(pa,p,22); vals=[flux(x) for x in grid]; j=int(np.argmax(vals))
    lo=float(grid[max(0,j-1)]); hi=float(grid[min(len(grid)-1,j+1)])
    opt=minimize_scalar(lambda x:-flux(x),bounds=(lo,hi),method='bounded',options={'xatol':1e-9})
    return max(vals[j],flux(opt.x))

def tables(n):
    # Pressure coordinate is log(P). Saturation properties, not state coordinates, are interpolated.
    pg=np.geomspace(pa*0.75,5.,n); lp=np.log(pg); rows=[]
    for p in pg:
        l=W(P=float(p),x=0); v=W(P=float(p),x=1)
        rows.append([l.v,v.v,l.u*1000,v.u*1000,l.h*1000,v.h*1000,l.T])
    props=PchipInterpolator(lp,np.array(rows),axis=0)
    # Dense near atmospheric endpoint where unchoked flow changes rapidly.
    npg=pa+np.geomspace(1e-7,5.-pa,max(100,n//2))
    gn=PchipInterpolator(np.r_[pa,npg],np.r_[0.,[nozzle(float(p)) for p in npg]])
    return props,gn

def solve_case(label,dt,props,gn,failed_ads=False,failed_act=False,wst_fraction=1.,sump_volume=0.,heater=None,act_energy=None,duration=None):
    init_l=W(P=b['initialPressure_MPa'],x=0); init_v=W(P=b['initialPressure_MPa'],x=1)
    vl=V*b['initialLiquidFraction']; M=vl/init_l.v+(V-vl)/init_v.v
    U=vl/init_l.v*init_l.u*1000+(V-vl)/init_v.v*init_v.u*1000
    def vessel_PE(ml,mv,vl):
        z=vl/A
        return g*(ml*z/2+mv*(z+b['vesselHeight_m'])/2)
    def pool_PE(m,floor,area):return m*g*(floor+m/rho/area/2)
    U+=vessel_PE(vl/init_l.v,(V-vl)/init_v.v,vl)
    MW=rho*b['WSTVolume_m3']*wst_fraction; MS=rho*sump_volume; MF=0.
    initialM=M+MW+MS
    initialU=U+(MW+MS)*hc+pool_PE(MW,b['WSTFloor_m'],b['WSTArea_m2'])+pool_PE(MS,b['sumpFloor_m'],b['sumpArea_m2'])
    ventM=ventH=heat=spillHeat=gravityTransfer=0.; consumed=[0.,0.]; remaining=[(b['ACTCapacity_kJ'] if act_energy is None else act_energy)*1000]*2
    distribution_open=[failed_act,False]
    # Physical state per train and one-shot: continuous pulse time, released, travel.
    pulse=np.zeros((2,3)); released=np.zeros((2,3),dtype=bool); pos=np.zeros((2,3))
    t=0.; p=b['initialPressure_MPa']; onset=None; events=[]; trace=[]; injected=[0.,0.]; recirculated=[0.,0.]
    stop='duration'; Q=(b['heater_MW'] if heater is None else heater)*1e6
    duration=b['duration_s'] if duration is None else duration
    max_mass_res=0.; max_energy_res=0.; max_flash_error=0.; max_gas_head_ratio=0.
    def flash(m,u):
        vv=V/m; uu=u/m
        def f(logp):
            vf,vg,uf,ug,*_=props(logp); x=(vv-vf)/(vg-vf)
            return uf+x*(ug-uf)+vessel_PE(m*(1-x),m*x,m*(1-x)*vf)/m-uu
        low=math.log(pa*0.75); high=math.log(5.)
        # For this sparse pressure pot the full bracket stays inside the two-phase dome.
        # Never solve an extrapolated negative-mass mixture and accept an unrelated root.
        for end in [low,high]:
            vf,vg,*_=props(end)
            if not vf<vv<vg:raise ValueError('Flash bracket crosses a phase-domain boundary; use a phase-capable solver')
        r=brentq(f,low,high,xtol=2e-12)
        pr=math.exp(r); vf,vg,uf,ug,hf,hg,T=props(r); x=(vv-vf)/(vg-vf)
        if not 0.<x<1.:raise ValueError(f'{label}: equilibrium mixture domain exited at {t}: x={x}')
        return pr,float(m*(1-x)*vf),float(m*x),float(1/vf),float(hg),float(T),abs(f(r)*m)
    def source_flow(available,z,r,opening,junction):
        if available<=1e-8 or opening<=0.:return 0.
        drive=(pa*1e6+rho*g*(z-b['injectionPort_m'])-junction-crack)
        return math.sqrt(max(0.,drive)*opening**2/r)
    while t<duration-1e-9:
        h=min(dt,duration-t)
        p,vl,mv,rl,hg,T,flasherr=flash(M,U)
        max_flash_error=max(max_flash_error,flasherr)
        level=vl/A
        max_gas_head_ratio=max(max_gas_head_ratio,mv/(V-vl)*g*max(0,b['steamPort_m']-level)/(p*1e6))
        if p<=pa*(1+1e-9):stop='ambient pressure: gas-ingress continuation outside pure-water bench';break
        if level>=b['steamPort_m']:stop='steam takeoff inundated: two-phase discharge not represented';break
        if mv<=1e-4:stop='steam inventory exhausted';break
        receiver=p*1e6+rl*g*max(0.,level-b['injectionPort_m'])
        requests=[b['ACTBaseline_kW']*1000+sum(~released[train])*b['releasePower_kW']*1000 for train in range(2)]
        for tr in range(2):
            if not distribution_open[tr]:
                if requests[tr]>b['ACTAvailable_kW']*1000 or remaining[tr]<=1e-7:
                    distribution_open[tr]=True
                    events.append({'time_s':round(t,6),'event':'ACT distribution latched open','train':tr})
                else:h=min(h,remaining[tr]/requests[tr])
        fw=[]; fs=[]; zw=b['WSTFloor_m']+MW/rho/b['WSTArea_m2']; zs=b['sumpFloor_m']+MS/rho/b['sumpArea_m2']
        for tr in range(2):
            def flows(j):
                w=source_flow(MW,zw,Ksrc,pos[tr,1],j) if zw>b['WSTFloor_m']+.2 else 0.
                s=source_flow(MS,zs,Krec,pos[tr,2],j) if zs>b['sumpFloor_m']+.2 else 0.
                return w,s
            upper=max(receiver,pa*1e6+rho*g*(max(zw,zs)-b['injectionPort_m']))
            if upper>receiver:
                j=brentq(lambda q:q-receiver-Kdvi*sum(flows(q))**2,receiver,upper,xtol=1e-7)
                w,s=flows(j)
            else:w=s=0.
            fw.append(w);fs.append(s)
        if sum(fw)*h>MW or sum(fs)*h>MS:raise ValueError('Source exhausted within timestep; reduce step, do not clamp flow')
        out=b['ADS_CdA_m2']*float(gn(p))*sum(pos[:,0])
        if out*h>mv:raise ValueError('Steam withdrawal exceeds available vapor within step')
        oldPoolPE=pool_PE(MW,b['WSTFloor_m'],b['WSTArea_m2'])+pool_PE(MS,b['sumpFloor_m'],b['sumpArea_m2'])
        def proposed(hh):
            pe=pool_PE(MW-sum(fw)*hh,b['WSTFloor_m'],b['WSTArea_m2'])+pool_PE(MS-sum(fs)*hh,b['sumpFloor_m'],b['sumpArea_m2'])
            m=M+(sum(fw)+sum(fs)-out)*hh
            e=U+((sum(fw)+sum(fs))*hc-out*(hg+g*b['steamPort_m'])+Q)*hh+oldPoolPE-pe
            return flash(m,e)
        next_state=proposed(h)
        if next_state[0]<pa:
            h=brentq(lambda hh:proposed(hh)[0]-pa,0.,h,xtol=1e-10)
        elif next_state[1]/A>=b['steamPort_m']:
            h=brentq(lambda hh:proposed(hh)[1]/A-b['steamPort_m'],0.,h,xtol=1e-10)
        if onset is None and sum(fw)+sum(fs)>0.01:
            onset=t;events.append({'time_s':round(t,6),'event':'gravity delivery begins'})
        if not trace or t-trace[-1]['time_s']>=30.-1e-6:
            trace.append(dict(time_s=round(t,6),pressure_MPa=p,liquidSurface_m=level,temperature_C=T-273.15,
                WST_flow_kg_s=sum(fw),sump_flow_kg_s=sum(fs),steam_out_kg_s=out,WST_kg=MW,sump_kg=MS,
                ACT_remaining_kJ=[x/1000 for x in remaining],valve_positions=pos.tolist()))
        oldPoolPE=pool_PE(MW,b['WSTFloor_m'],b['WSTArea_m2'])+pool_PE(MS,b['sumpFloor_m'],b['sumpArea_m2'])
        newPoolPE=pool_PE(MW-sum(fw)*h,b['WSTFloor_m'],b['WSTArea_m2'])+pool_PE(MS-sum(fs)*h,b['sumpFloor_m'],b['sumpArea_m2'])
        grav=oldPoolPE-newPoolPE; gravityTransfer+=grav
        outletEnergy=hg+g*b['steamPort_m']
        dm=(sum(fw)+sum(fs)-out)*h; du=((sum(fw)+sum(fs))*hc-out*outletEnergy+Q)*h+grav
        M+=dm;U+=du;MW-=sum(fw)*h;MS-=sum(fs)*h
        ventM+=out*h;ventH+=out*outletEnergy*h;heat+=Q*h
        for tr in range(2):injected[tr]+=fw[tr]*h;recirculated[tr]+=fs[tr]*h
        # This bench has no condensing containment: top steam is discharged to the explicit environment.
        # Sump/floor inventory can move through the open spill boundary, but cannot be created by a timer.
        zs=b['sumpFloor_m']+MS/rho/b['sumpArea_m2']; zf=b['sumpRim_m']+MF/rho/b['floorArea_m2']
        if zs>b['sumpRim_m'] or MF>0.:
            before=pool_PE(MS,b['sumpFloor_m'],b['sumpArea_m2'])+pool_PE(MF,b['sumpRim_m'],b['floorArea_m2'])
            spill=spill_transfer(MS,MF,h)
            MS-=spill;MF+=spill
            after=pool_PE(MS,b['sumpFloor_m'],b['sumpArea_m2'])+pool_PE(MF,b['sumpRim_m'],b['floorArea_m2'])
            spillHeat+=before-after
            if before-after < -1e-7:raise ValueError('Spill created gravitational energy')
        massres=M+MW+MS+MF+ventM-initialM
        poolsPE=pool_PE(MW,b['WSTFloor_m'],b['WSTArea_m2'])+pool_PE(MS,b['sumpFloor_m'],b['sumpArea_m2'])+pool_PE(MF,b['sumpRim_m'],b['floorArea_m2'])
        eres=U+(MW+MS+MF)*hc+poolsPE+ventH+spillHeat-heat-initialU
        max_mass_res=max(max_mass_res,abs(massres));max_energy_res=max(max_energy_res,abs(eres))
        for train in range(2):
            energized=not distribution_open[train]
            energy=requests[train]*h if energized else 0.
            remaining[train]-=energy;consumed[train]+=energy
            for valve in range(3):
                if not released[train,valve]:
                    pulse[train,valve]=pulse[train,valve]+h if energized else 0.
                    if pulse[train,valve]>=b['releaseDuration_s']-1e-10:
                        released[train,valve]=True
                        events.append({'time_s':round(t+h,6),'event':'release','train':train,'valve':['ADS','GIV','RECIRC'][valve]})
                elif not(failed_ads and train==0 and valve==0):
                    pos[train,valve]=min(1.,pos[train,valve]+h/b['travel_s'])
        t+=h
    p,vl,mv,rl,hg,T,flasherr=flash(M,U)
    return dict(name=label,step_s=dt,end_s=t,endpoint=stop,gravity_onset_s=onset,final_pressure_MPa=p,
        final_liquidSurface_m=vl/A,WST_delivered_kg=injected,sump_delivered_kg=recirculated,
        steam_discharged_kg=ventM,steam_enthalpy_MJ=ventH/1e6,heater_energy_MJ=heat/1e6,
        pool_gravity_transfer_MJ=gravityTransfer/1e6,spill_thermostat_rejection_J=spillHeat,
        omitted_vapor_hydrostatic_pressure_fraction=max_gas_head_ratio,
        water_mass_residual_kg=max_mass_res,energy_residual_J=max_energy_res,flash_residual_J=max_flash_error,
        ACT_consumed_kJ=[x/1000 for x in consumed],ACT_remaining_kJ=[x/1000 for x in remaining],
        released=released.tolist(),positions=pos.tolist(),distribution_open=distribution_open,events=events,trace=trace)

props,gn=tables(300)
# Independent direct-property samples, not self-comparison with the interpolator.
errors=[]
for p in [.113,.173,.351,.741,1.233,2.713]:
    approx=props(math.log(p));l=W(P=p,x=0);v=W(P=p,x=1)
    errors.append(dict(pressure_MPa=p,liquid_v_relative=abs(approx[0]/l.v-1),
        vapor_v_relative=abs(approx[1]/v.v-1),liquid_u_relative=abs(approx[2]/(l.u*1000)-1),
        vapor_h_relative=abs(approx[5]/(v.h*1000)-1),nozzle_relative=abs(float(gn(p))/nozzle(p)-1)))
cases=[solve_case('healthy',b['step_s'],props,gn),
       solve_case('one ADS stuck closed',b['step_s'],props,gn,failed_ads=True),
       solve_case('ACT A unavailable before release',b['step_s'],props,gn,failed_act=True),
       solve_case('WST quarter inventory',b['step_s'],props,gn,wst_fraction=.25),
       solve_case('prefilled sump only',b['step_s'],props,gn,wst_fraction=0.,sump_volume=1180.),
       solve_case('pulse interrupted by depletion',b['step_s'],props,gn,act_energy=2.),
       solve_case('prefilled sump with 0.5 MW heater',b['step_s'],props,gn,wst_fraction=0.,sump_volume=1180.,heater=.5),
       solve_case('completed pulse then depleted ACT',b['step_s'],props,gn,act_energy=4.,duration=2.)]
fine=solve_case('healthy half-step',b['step_s']/2,props,gn)
fineprops,finegn=tables(600)
property_fine=solve_case('healthy refined property table',b['step_s']/2,fineprops,finegn)
def difference(a,c):
    ta={r['time_s']:r['pressure_MPa'] for r in a['trace']};tc={r['time_s']:r['pressure_MPa'] for r in c['trace']}
    shared=ta.keys()&tc.keys()
    return dict(final_pressure_MPa=abs(a['final_pressure_MPa']-c['final_pressure_MPa']),
        maximum_common_time_pressure_MPa=max(abs(ta[t]-tc[t]) for t in shared),
        injected_kg=abs(sum(a['WST_delivered_kg'])-sum(c['WST_delivered_kg'])),
        onset_s=None if a['gravity_onset_s'] is None or c['gravity_onset_s'] is None else abs(a['gravity_onset_s']-c['gravity_onset_s']))
for r in [*cases,fine,property_fine]:
    if r['water_mass_residual_kg']>1e-5 or r['energy_residual_J']>1.:raise ValueError('Conservation gate failed')
if any(x['nozzle_relative']>.003 or x['vapor_v_relative']>1e-4 for x in errors):raise ValueError('Property interpolation gate failed')
if cases[2]['released'][0]!=[False,False,False]:raise ValueError('Unpowered release occurred')
if cases[1]['positions'][0][0]!=0.:raise ValueError('Failed ADS moved')
if any(any(tr) for tr in cases[5]['released']):raise ValueError('Interrupted pulse incorrectly released valve')
if any(abs(x-2.)>1e-8 for x in cases[5]['ACT_consumed_kJ']):raise ValueError('Interrupted pulse energy was not retained as consumed')
if cases[0]['gravity_onset_s'] is None or cases[6]['gravity_onset_s'] is None:raise ValueError('Selected gravity-onset experiments did not reach their event')
if not all(all(tr) for tr in cases[7]['released']) or any(any(p!=1. for p in tr) for tr in cases[7]['positions']):
    raise ValueError('Stored-energy travel incorrectly required continuing electrical power')
if cases[0]['trace'][0]['ACT_remaining_kJ']!=[b['ACTCapacity_kJ']]*2:raise ValueError('Trace mixes initial state with end-of-step power')
if any(e['time_s']!=b['releaseDuration_s'] for e in cases[0]['events'] if e['event']=='release'):raise ValueError('Release time mismatch')
dt_diff=difference(cases[0],fine); prop_diff=difference(fine,property_fine)
for d in [dt_diff,prop_diff]:
    if d['maximum_common_time_pressure_MPa']>0.0002 or d['injected_kg']>10. or (d['onset_s'] is not None and d['onset_s']>1.):
        raise ValueError(f'Numerical refinement gate failed: {d}')
print(json.dumps(dict(evidenceClass='apparatus truth; not powered operator instrumentation or plant event history',
    python=platform.python_version(),iapws=iapws.__version__,scipy=scipy.__version__,numpy=np.__version__,
    elapsed_s=time.monotonic()-started,property_checks=errors,cases=cases,
    convergence=dict(timestep=difference(cases[0],fine),properties=difference(fine,property_fine),
        refined_healthy={k:v for k,v in property_fine.items() if k not in ['events','trace']})),allow_nan=False))
`

export async function runCoolingRig(document: string, python: string) {
  const basis = parseCoolingRigBasis(document)
  const input = JSON.stringify(basis)
  const child = Bun.spawn([python,'-c',calculation],{stdin:Buffer.from(input),stdout:'pipe',stderr:'pipe'})
  const [stdout,stderr,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if (code !== 0) throw new Error(`Cooling-source rig failed (${code}): ${stderr}`)
  return {...JSON.parse(stdout),basisSha256:createHash('sha256').update(input).digest('hex'),
    calculationSha256:createHash('sha256').update(calculation).digest('hex')}
}

if (import.meta.main) {
  const [document,python] = Bun.argv.slice(2)
  if (!document || !python) throw new Error('Usage: bun reference-design-cooling-rig.ts <wiki-page.md> <python-with-iapws>')
  console.log(JSON.stringify(await runCoolingRig(await Bun.file(document).text(),python),null,2))
}
