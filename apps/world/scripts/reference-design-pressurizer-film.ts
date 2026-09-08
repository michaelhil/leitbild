/** Offline small-Jakob film with calorimeter and radial steel references; not a full PZR transient. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parsePressurizerBoundaries } from './reference-design-pressurizer-boundaries'
import { parseSpatialBasis } from './reference-design-pressurizer-spatial'

const schema = z.object({ duration_s: z.number().finite().positive(), axialCells: z.number().int().positive(), radialCells: z.number().int().min(2), timeStep_s: z.number().finite().positive() }).strict()
export function parseFilmBasis(text: string) {
  const blocks = [...text.matchAll(/^```reference-pressurizer-film\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-pressurizer-film block')
  const value = schema.parse(JSON.parse(blocks[0]![1]!))
  if (value.timeStep_s > value.duration_s) throw Error('Step exceeds reference duration')
  if (!Number.isInteger(value.duration_s) || value.duration_s < 10 || Math.abs(1 / value.timeStep_s - Math.round(1 / value.timeStep_s)) > 1e-9)
    throw Error('Reference comparison needs integer duration >= 10 s and steps dividing one second')
  return value
}

export const filmDefinitions = String.raw`
import json,sys,math,platform,scipy,CoolProp
import CoolProp.CoolProp as CP
import numpy as np
from scipy.optimize import brentq
from scipy.linalg import solve_banded
b=json.load(sys.stdin);r=b['source'];cfg=b['film'];p=b['pressure_MPa']*1e6;g=9.80665
Ts=CP.PropsSI('T','P',p,'Q',1,'Water');Tw0=r['wallTemperature_K'];H=r['height_m']-r['statedLevel_m'];C=2*math.pi*r['innerRadius_m']
if not 0<Ts-Tw0<2:raise ValueError('This reduced small-subcooling reference requires 0 < Ts-Tw < 2 K')
Tf=(Ts+Tw0)/2
rho=CP.PropsSI('D','P',p,'T',Tf,'Water');rv=CP.PropsSI('D','P',p,'Q',1,'Water')
mu=CP.PropsSI('V','P',p,'T',Tf,'Water');k=CP.PropsSI('L','P',p,'T',Tf,'Water');cp=CP.PropsSI('C','P',p,'T',Tf,'Water')
hfg=CP.PropsSI('H','P',p,'Q',1,'Water')-CP.PropsSI('H','P',p,'Q',0,'Water')
B=rho*(rho-rv)*g/(3*mu);mw=7920*math.pi*(r['outerRadius_m']**2-r['innerRadius_m']**2)*H
def ew(T):return 6.683*(T-300)+.04906/2*(T*T-300**2)+80.74*(T*math.log(T)-T-300*math.log(300)+300)
def wallE(T):return mw*(ew(T)-ew(Tw0))
def film_cell(previous,incoming,T,dx,dt,wavy):
    def residual(d):
        re=4*B*d**3/mu;F=1+(1.83e-4*re if wavy else 0)
        return (rho*dx*(d-previous)+dt*(B*d**3-incoming))*(d+previous)-2*dt*dx*k*(Ts-T)*F/hfg
    upper=max(previous,1e-9)
    while residual(upper)<0:upper*=2
    d=brentq(residual,0,upper,xtol=1e-16)
    re=4*B*d**3/mu;F=1+(1.83e-4*re if wavy else 0)
    amount=0. if d+previous==0 else 2*dt*dx*k*(Ts-T)*F/(hfg*(d+previous))
    defect=rho*dx*(d-previous)+dt*(B*d**3-incoming)-amount
    return d,amount,defect
def run(n,dt,wavy,fixed,duration):
    dx=H/n;old=np.zeros(n);drain=condensed=heat=0.;Tw=Tw0;peakRe=0.;maxLocal=0.;rows=[];firstWavy=None
    steps=math.ceil(duration/dt);dt=duration/steps
    for step in range(steps):
        def advance(T):
            out=np.zeros(n);incoming=0.;total=0.;local=0.
            for i in range(n):
                d,amount,defect=film_cell(old[i],incoming,T,dx,dt,wavy);out[i]=d
                local=max(local,abs(defect))
                total+=amount*C;incoming=B*d**3
            return out,incoming*C*dt,total,local
        if not fixed:
            Tw=brentq(lambda T:wallE(T)-heat-advance(T)[2]*hfg,Tw,Ts,xtol=1e-10)
        new,dm,dc,local=advance(Tw);old=new;drain+=dm;condensed+=dc;heat+=dc*hfg
        re=4*B*float(max(new))**3/mu;peakRe=max(peakRe,re);maxLocal=max(maxLocal,local*C)
        t=(step+1)*dt
        if firstWavy is None and re>30:firstWavy=t
        if re>=1800:raise ValueError('Film crossed unimplemented turbulent research regime')
        mass=rho*dx*C*float(sum(new));massResidual=mass+drain-condensed
        energyResidual=None if fixed else wallE(Tw)-heat
        if local*C>1e-10 or abs(massResidual)>1e-9 or (not fixed and abs(energyResidual)>.01):raise ValueError('Local or global reduced film ledger failed')
        if step==0 or step==steps-1 or (step+1)%(max(1,steps//10))==0:
            rows.append(dict(time_s=t,filmMass_kg=mass,drainedMass_kg=drain,condensedMass_kg=condensed,
                wallTemperature_K=Tw,latentHeat_J=heat,maxRe=re,massResidual_kg=massResidual,
                reducedThermalEnergyResidual_J=energyResidual))
    return dict(cells=n,step_s=dt,wavySensitivity=wavy,fixedWall=fixed,peakRe=peakRe,firstReAbove30_s=firstWavy,
        maxLocalMassResidual_kg=maxLocal,rows=rows,outletThickness_m=float(old[-1]),outletFlow_kg_s=C*B*old[-1]**3)

# Same selected NIST304 enthalpy/conductivity as the independently checked radial-wall reference.
def steel_k(T):return 9.705+.0176*T-1.60e-6*T*T
def steel_K(T):return 9.705*T+.0176*T*T/2-1.60e-6*T**3/3
def steel_cp(T):return 6.683+.04906*T+80.74*np.log(T)
def steel_de(T,old):
    d=T-old
    return d*(6.683+.04906*(T+old)/2+80.74*(np.log(old)-1))+80.74*T*np.log1p(d/old)
def steel_dK(T,old):return (T-old)*(9.705+.0176*(T+old)/2-1.60e-6*(T*T+T*old+old*old)/3)
def make_wall(nr,dx):
    edges=np.linspace(r['innerRadius_m'],r['outerRadius_m'],nr+1)
    centers=np.sqrt((edges[:-1]**2+edges[1:]**2)/2)
    areas=math.pi*np.diff(edges**2);masses=7920*areas*dx
    conduct=2*math.pi*dx/np.log(np.r_[centers,edges[-1]]/np.r_[edges[0],centers])
    def solve(old,inner,dt,outer=None):
        T=old.copy()
        for iteration in range(12):
            sides=np.r_[inner,T,T[-1] if outer is None else outer]
            q=conduct*steel_dK(sides[:-1],sides[1:])
            if outer is None:q[-1]=0.
            energy=masses*steel_de(T,old)
            residual=energy-dt*(q[:-1]-q[1:])
            if max(abs(residual))<1e-8:return T,q,float(max(abs(residual)))
            kval=steel_k(T);ab=np.zeros((3,nr))
            right=conduct[1:].copy()
            if outer is None:right[-1]=0.
            ab[1]=masses*steel_cp(T)+dt*(conduct[:-1]+right)*kval
            ab[0,1:]=-dt*conduct[1:-1]*kval[1:]
            ab[2,:-1]=-dt*conduct[1:-1]*kval[:-1]
            update=solve_banded((1,1),ab,-residual)
            T+=update
            if np.any(T<300) or np.any(T>650):raise ValueError('Radial steel outside selected material range')
        raise ValueError('Radial steel Newton energy gate failed')
    return solve,masses,areas,centers

def radial_run(n,nr,dt,wavy=False):
    dx=H/n;solve,masses,areas,centers=make_wall(nr,dx)
    wall=np.full((n,nr),Tw0,dtype=float);film=np.zeros(n);drain=condensed=heat=0.;rows=[]
    local_wall=local_film=match_error=0.;peakRe=0.;axial_signed=np.zeros((n,nr));strip_heat=np.zeros(n)
    peak_axial=0.;steps=math.ceil(cfg['duration_s']/dt);dt=cfg['duration_s']/steps
    for count in range(steps):
        oldwall=wall.copy();oldfilm=film.copy();incoming=0.;surfaces=[];step_heat=0.
        for i in range(n):
            def interface(surface):
                thickness,amount,defect=film_cell(oldfilm[i],incoming,surface,dx,dt,wavy)
                T,q,res=solve(oldwall[i],surface,dt)
                return q[0]*dt-amount*C*hfg,(thickness,amount,defect,T,q,res)
            surface=brentq(lambda T:interface(T)[0],float(min(oldwall[i])),Ts,xtol=1e-10)
            mismatch,(thickness,amount,defect,T,q,res)=interface(surface)
            if abs(mismatch)>1e-5 or abs(defect)*C>1e-10:raise ValueError('Film/surface coupling gate failed')
            film[i]=thickness;wall[i]=T;incoming=B*thickness**3;surfaces.append(surface)
            local_wall=max(local_wall,res);local_film=max(local_film,abs(defect)*C);match_error=max(match_error,abs(mismatch))
            dq=amount*C*hfg;heat+=dq;step_heat+=dq;strip_heat[i]+=dq;condensed+=amount*C
        drain+=dt*C*incoming
        # Estimate omitted axial conduction from resolved radial temperatures; it is NOT applied.
        qa=areas*steel_dK(wall[:-1],wall[1:])/dx
        peak_axial=max(peak_axial,float(max(np.abs(qa).sum(axis=1))))
        axial_signed[:-1]-=qa*dt;axial_signed[1:]+=qa*dt
        m=rho*dx*C*float(sum(film));stored=float(np.sum(steel_de(wall,Tw0)*masses))
        mr=m+drain-condensed;er=stored-heat;re=4*B*float(max(film))**3/mu;peakRe=max(peakRe,re)
        if abs(mr)>1e-9 or abs(er)>.01 or re>=1800:raise ValueError('Radial coupled mass/thermal/domain gate failed')
        t=(count+1)*dt
        if count==0 or abs(t-round(t))<1e-8:
            rows.append(dict(time_s=t,filmMass_kg=m,drainedMass_kg=drain,condensedMass_kg=condensed,heat_J=heat,
                innerSurfaceMin_K=min(surfaces),innerSurfaceMax_K=max(surfaces),outerCellMin_K=float(min(wall[:,-1])),
                outerCellMax_K=float(max(wall[:,-1])),stepMeanHeat_W=step_heat/dt,maxRe=re,massResidual_kg=mr,steelEnergyResidual_J=er))
    return dict(axialCells=n,radialCells=nr,step_s=dt,wavySensitivity=wavy,peakRe=peakRe,rows=rows,
        maxLocalSteelResidual_J=local_wall,maxLocalFilmResidual_kg=local_film,maxInterfaceMismatch_J=match_error,
        omittedAxialConduction=dict(peakFace_W=peak_axial,maxNetStripEnergy_J=float(max(abs(axial_signed.sum(axis=1)))),
            maxStripEnergyToFilmHeat=float(max(abs(axial_signed.sum(axis=1))/strip_heat)),notApplied=True))

def wall_checks():
    increment_checks=[]
    for d in [0.,1e-8,-1e-8,.1,-.1,10.,-10.]:
        T=Tw0+d;actual=T-Tw0;de=steel_de(T,Tw0);dk=steel_dK(T,Tw0)
        if d==0:
            if de!=0 or dk!=0:raise ValueError('Zero steel increment failed')
        elif abs(d)<1e-6:
            if abs(de/actual/steel_cp(Tw0)-1)>1e-9 or abs(dk/actual/steel_k(Tw0)-1)>1e-9:raise ValueError('Signed steel derivative limit failed')
        elif abs(de-(ew(T)-ew(Tw0)))>1e-7 or abs(dk-(steel_K(T)-steel_K(Tw0)))>1e-9:raise ValueError('Stable steel primitive identity failed')
        increment_checks.append(dict(delta_K=actual,specificEnergy_J_kg=float(de),conductivityIntegral_W_m=float(dk)))
    dx=H/cfg['axialCells'];solve,masses,areas,centers=make_wall(cfg['radialCells'],dx)
    flat=np.full(cfg['radialCells'],Tw0,dtype=float);held,q,res=solve(flat,Tw0,1.)
    if max(abs(held-flat))>1e-12 or max(abs(q))>1e-12:raise ValueError('Radial zero-drive hold failed')
    inner=Tw0+1.;outer=Tw0
    coeff=steel_dK(inner,outer)/math.log(r['outerRadius_m']/r['innerRadius_m'])
    profile=np.array([brentq(lambda T:steel_dK(T,inner)+coeff*math.log(x/r['innerRadius_m']),outer,inner,xtol=1e-11) for x in centers])
    steady,q,res=solve(profile,inner,1.,outer)
    expected=2*math.pi*dx*coeff
    if max(abs(steady-profile))>1e-9 or max(abs(q-expected))>1e-6:raise ValueError('Independent cylindrical steady profile failed')
    return dict(stripHeight_m=dx,stableIncrementChecks=increment_checks,heldMaximumChange_K=float(max(abs(held-flat))),steadyMaximumChange_K=float(max(abs(steady-profile))),
        analyticSteadyHeat_W=expected,maxHeatDifference_W=float(max(abs(q-expected))))

`
const filmVerification = String.raw`wallChecks=wall_checks()
nr=cfg['radialCells'];n=cfg['axialCells'];dt=cfg['timeStep_s']
radialCases=[radial_run(n,nr,dt),radial_run(n,2*nr,dt),radial_run(2*n,nr,dt),radial_run(n,nr,dt/2),radial_run(2*n,2*nr,dt/2)]
radialComparisons=[]
for label,a,c in [('radial',radialCases[0],radialCases[1]),('axial',radialCases[0],radialCases[2]),('time',radialCases[0],radialCases[3]),('combined',radialCases[0],radialCases[4])]:
    for t in [1.,5.,10.,cfg['duration_s']]:
        x=next(v for v in a['rows'] if abs(v['time_s']-t)<1e-8);y=next(v for v in c['rows'] if abs(v['time_s']-t)<1e-8)
        metrics={k:abs(x[k]-y[k])/max(abs(y[k]),1e-12) for k in ['filmMass_kg','drainedMass_kg','heat_J']}
        temps={k:abs(x[k]-y[k]) for k in ['innerSurfaceMin_K','innerSurfaceMax_K']}
        radialComparisons.append(dict(axis=label,time_s=t,relativeDifferences=metrics,temperatureDifferences_K=temps,
            passes=max(metrics.values())<=.02 and max(temps.values())<=.02))
cases=[run(cfg['axialCells']*m,cfg['timeStep_s']/m,False,False,cfg['duration_s']) for m in [1,2,4]]
cases.append(run(cfg['axialCells']*2,cfg['timeStep_s']/2,True,False,cfg['duration_s']))
separate=[run(cfg['axialCells'],cfg['timeStep_s']/2,False,False,cfg['duration_s']),run(cfg['axialCells']*2,cfg['timeStep_s'],False,False,cfg['duration_s'])]
# Fixed-temperature, zero-drain analytical first step; no physical seed thickness.
dryChecks=[]
for dt in [cfg['timeStep_s'],cfg['timeStep_s']/2,cfg['timeStep_s']/4]:
    exact=math.sqrt(2*dt*k*(Ts-Tw0)/(rho*hfg))
    solved=brentq(lambda d:rho*d*d-2*dt*k*(Ts-Tw0)/hfg,0,2*exact,xtol=1e-16)
    if abs(solved/exact-1)>1e-10:raise ValueError('Dry fixed-temperature first-step asymptote missed')
    dryChecks.append(dict(step_s=dt,thickness_m=solved,exactThickness_m=exact))
# Smooth developed analytical limit is a numerical check, not admitted high-Re physics.
delta=(4*mu*k*(Ts-Tw0)*H/(rho*(rho-rv)*g*hfg))**.25
analytic=dict(outletThickness_m=delta,filmMass_kg=C*rho*H*delta*.8,outletFlow_kg_s=C*B*delta**3,Re=4*B*delta**3/mu)
steady=run(cfg['axialCells']*2,cfg['timeStep_s'],False,True,max(120.,cfg['duration_s']))
for a,bcase in [(cases[1],cases[2]),(cases[0],separate[0]),(cases[0],separate[1])]:
    for key in ['filmMass_kg','drainedMass_kg','latentHeat_J']:
        x,y=a['rows'][-1][key],bcase['rows'][-1][key]
        if abs(x-y)/max(abs(y),1e-12)>.02:raise ValueError('Startup refinement above 2 percent: '+key)
if abs(steady['outletFlow_kg_s']/analytic['outletFlow_kg_s']-1)>.02:raise ValueError('Developed smooth analytical limit missed')
for key,value in [('outletThickness_m',steady['outletThickness_m']),('filmMass_kg',steady['rows'][-1]['filmMass_kg'])]:
    if abs(value/analytic[key]-1)>.02:raise ValueError('Developed smooth storage/thickness limit missed: '+key)
thickness=r['outerRadius_m']-r['innerRadius_m'];ks=9.705+.0176*Tw0-1.60e-6*Tw0**2;cs=6.683+.04906*Tw0+80.74*math.log(Tw0)
print(json.dumps(dict(scope='Small-Jakob constant-pressure startup film with finite calorimeter and radial steel references; reduced film energy, not a full PZR transient',
    dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,CoolPropRevision=CP.get_global_param_string('gitrevision'),scipy=scipy.__version__,numpy=np.__version__),
    properties=dict(pressure_Pa=p,saturationTemperature_K=Ts,filmPropertyTemperature_K=Tf,rho=rho,vaporDensity=rv,viscosity=mu,conductivity=k,hfg=hfg,wallMass_kg=mw),
    omittedTermScales=dict(Jakob=cp*(Ts-Tw0)/hfg,gravityToLatent=g*H/hfg,maxFilmCurvature=delta/r['innerRadius_m']),
    shellParticipationWarning=dict(planeWallFourier=ks*cfg['duration_s']/(7920*cs*thickness**2),
        developedOutletBiot=k/delta*thickness/ks,actualShellTimingQualified=False),
    startup=cases,separateTimeAndSpace=separate,dryFixedTemperatureChecks=dryChecks,developedAnalytical=analytic,developedNumerical=steady,
    radialWall=dict(independentChecks=wallChecks,cases=radialCases,comparisons=radialComparisons,
        numericalScreenPassed=all(v['passes'] for v in radialComparisons),axiallyInsulatedStrips=True,outerAdiabatic=True),
    empiricalRateQualified=False,fullEnergyQualified=False,liveModelInstalled=False),allow_nan=False))
`

export const filmCalculation = filmDefinitions + filmVerification

if (import.meta.main) {
  const [source, owner, python, ...extra] = process.argv.slice(2)
  if (!source || !owner || !python || extra.length) throw Error('Usage: reference-design-pressurizer-film.ts <source-page> <state-owner> <python>')
  const page = await Bun.file(owner).text()
  const input = { source: parsePressurizerBoundaries(await Bun.file(source).text()), pressure_MPa: parseSpatialBasis(page).surfacePressure_MPa, film: parseFilmBasis(page) }
  const child = Bun.spawn([python, '-c', filmCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({ input, inputHash: hash(JSON.stringify(input)), calculationHash: hash(filmCalculation), ...JSON.parse(out) }, null, 2))
}
