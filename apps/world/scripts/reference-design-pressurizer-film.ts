/** Offline small-Jakob startup film with finite isothermal calorimeter, not a PZR wall transient. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parsePressurizerBoundaries } from './reference-design-pressurizer-boundaries'
import { parseSpatialBasis } from './reference-design-pressurizer-spatial'

const schema = z.object({ duration_s: z.number().finite().positive(), axialCells: z.number().int().positive(), timeStep_s: z.number().finite().positive() }).strict()
export function parseFilmBasis(text: string) {
  const blocks = [...text.matchAll(/^```reference-pressurizer-film\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-pressurizer-film block')
  const value = schema.parse(JSON.parse(blocks[0]![1]!))
  if (value.timeStep_s > value.duration_s) throw Error('Step exceeds reference duration')
  return value
}

export const filmCalculation = String.raw`
import json,sys,math,platform,scipy,CoolProp
import CoolProp.CoolProp as CP
import numpy as np
from scipy.optimize import brentq
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
def run(n,dt,wavy,fixed,duration):
    dx=H/n;old=np.zeros(n);drain=condensed=heat=0.;Tw=Tw0;peakRe=0.;maxLocal=0.;rows=[];firstWavy=None
    steps=math.ceil(duration/dt);dt=duration/steps
    for step in range(steps):
        def advance(T):
            out=np.zeros(n);incoming=0.;total=0.;local=0.
            for i in range(n):
                previous=old[i]
                def residual(d):
                    re=4*B*d**3/mu;F=1+(1.83e-4*re if wavy else 0)
                    # Integrate 1/d over a locally linear d^2 path: exact dry first-step asymptote.
                    return (rho*dx*(d-previous)+dt*(B*d**3-incoming))*(d+previous)-2*dt*dx*k*(Ts-T)*F/hfg
                upper=max(previous,1e-9)
                while residual(upper)<0:upper*=2
                d=brentq(residual,0,upper,xtol=1e-16);out[i]=d
                re=4*B*d**3/mu;F=1+(1.83e-4*re if wavy else 0)
                amount=0. if d+previous==0 else 2*dt*dx*k*(Ts-T)*F/(hfg*(d+previous))
                local=max(local,abs(rho*dx*(d-previous)+dt*(B*d**3-incoming)-amount))
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
print(json.dumps(dict(scope='Small-Jakob constant-pressure startup film and finite isothermal calorimeter; reduced mass/latent-thermal ledger, not actual shell or PZR thermal response',
    dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,CoolPropRevision=CP.get_global_param_string('gitrevision'),scipy=scipy.__version__,numpy=np.__version__),
    properties=dict(pressure_Pa=p,saturationTemperature_K=Ts,filmPropertyTemperature_K=Tf,rho=rho,vaporDensity=rv,viscosity=mu,conductivity=k,hfg=hfg,wallMass_kg=mw),
    omittedTermScales=dict(Jakob=cp*(Ts-Tw0)/hfg,gravityToLatent=g*H/hfg,maxFilmCurvature=delta/r['innerRadius_m']),
    shellParticipationWarning=dict(planeWallFourier=ks*cfg['duration_s']/(7920*cs*thickness**2),
        developedOutletBiot=k/delta*thickness/ks,actualShellTimingQualified=False),
    startup=cases,separateTimeAndSpace=separate,dryFixedTemperatureChecks=dryChecks,developedAnalytical=analytic,developedNumerical=steady,
    empiricalRateQualified=False,fullEnergyQualified=False,liveModelInstalled=False),allow_nan=False))
`

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
