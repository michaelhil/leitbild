/** Finite constitutive shear/heat test and aperture exit budget, not a CMT receiving-flow solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseApertureBasis } from './reference-design-cmt-inlet'

const positive = z.number().finite().positive()
const shearSchema = z.object({
  velocityCoefficient: positive.max(1), lengthRatio: positive.max(.2), turbulentPrandtl: positive,
  duration_s: positive, steps_s: z.tuple([positive, positive]),
  coolingStart_s: positive, coolingConductance_W_K: positive, calorimeterCapacity_J_K: positive,
  calorimeterInitial_C: z.number().finite(), energyTolerance_J: positive,
  momentumTolerance_kg_m_s: positive, entropyTolerance_J_K: positive,
  temperatureTolerance_K: positive, velocityTolerance_m_s: positive,
}).strict().superRefine((s, c) => {
  if (s.coolingStart_s >= s.duration_s || s.steps_s[0] !== 2 * s.steps_s[1] ||
    s.steps_s.some(dt => [s.duration_s, s.coolingStart_s, .1].some(t => Math.abs(t / dt - Math.round(t / dt)) > 1e-9))) {
    c.addIssue({ code: 'custom', message: 'Duration, cooling event and sample clocks must align with both timesteps' })
  }
})

export function parseShearBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-cmt-shear\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-shear block')
  const input = { ...parseApertureBasis(document), shear: shearSchema.parse(JSON.parse(blocks[0]![1]!)) }
  if (input.coefficient >= input.shear.velocityCoefficient) throw new Error('Nominal contraction must be below unit area')
  return input
}

export const shearCalculation = String.raw`
import json,sys,math,time,platform,iapws
import numpy as np
from iapws.iapws97 import _Region1,_PSat_T
from iapws._iapws import _Viscosity,_ThCond
b=json.load(sys.stdin);s=b['shear'];p=b['pressure_MPa'];checks=0
def require(ok,message):
    global checks
    checks+=1
    if not ok:raise ValueError(message)

def water(T,pressure=p):
    require(math.isfinite(T) and 273.15<=T<=623.15 and .1<pressure<30 and pressure>_PSat_T(T),'Liquid property admission')
    w=_Region1(T,pressure);rho=1/w['v']
    return dict(T=T,rho=rho,h=w['h']*1000,u=w['h']*1000-pressure*1e6/rho,
      s=w['s']*1000,cp=w['cp']*1000,mu=_Viscosity(rho,T),k=_ThCond(rho,T))

def from_h(h,pressure=p):
    T=273.15+h/4500
    for _ in range(12):
        w=water(T,pressure);error=w['h']-h
        if abs(error)<1e-6:return w
        T-=error/w['cp']
    w=water(T,pressure)
    require(abs(w['h']-h)<1e-6,'Returned enthalpy inverse residual')
    return w

D=b['holeDiameter_m'];holeArea=math.pi*D*D/4
# Fixed existing injection owner dimensions/sizing point; initial temperatures are the
# retained aperture bench contrast, not a second editable installed-design authority.
fixture=dict(bodyOuterDiameter_m=.41,referenceFlow_kg_s=25.,initialHot_C=290.,initialCold_C=40.,
  owner='systems/passive-cooling/injection-and-depressurization.md')
pitch=abs(b['ringElevations_m'][0]-b['ringElevations_m'][1])
# Geometric masses only: one azimuthal sector, one ring pitch, one D radial reach.
bodyRadius=fixture['bodyOuterDiameter_m']/2
cellVolume=math.pi*((bodyRadius+D)**2-bodyRadius**2)*pitch/b['holesPerRing']
nominalContraction=b['coefficient']/s['velocityCoefficient']
sourceVolume=nominalContraction*holeArea*D;residentVolume=cellVolume-sourceVolume
require(residentVolume>0,'Positive geometrically sized resident mass')
contactArea=math.pi*math.sqrt(nominalContraction)*D*D
separation=D/2;mixingWidth=D

def exit_patch(dp,donor_C):
    donorPressure=p+max(dp,0)/1e6;receiverPressure=p+min(dp,0)/1e6
    donor=water(donor_C+273.15,donorPressure)
    if dp==0:return dict(head_Pa=dp,mass_kg_s=0.,velocity_m_s=0.,momentumMagnitude_N=0.,kineticPower_W=0.,impliedContraction=None,energyDefect_W=0.)
    speed=s['velocityCoefficient']*math.sqrt(2*abs(dp)/donor['rho'])
    mass=b['coefficient']*holeArea*math.sqrt(2*donor['rho']*abs(dp))
    out=from_h(donor['h']-speed*speed/2,receiverPressure)
    area=mass/(out['rho']*speed);contraction=area/holeArea
    require(0<contraction<=1,'Admissible actual equivalent exit area')
    defect=mass*(out['h']+speed*speed/2-donor['h'])
    require(abs(defect)<1e-5,'Stagnation enthalpy paid once')
    return dict(head_Pa=dp,donor_C=donor_C,mass_kg_s=math.copysign(mass,dp),velocity_m_s=math.copysign(speed,dp),
      momentumMagnitude_N=mass*speed,kineticPower_W=mass*speed*speed/2,impliedContraction=contraction,
      staticEnthalpy_J_kg=out['h'],donorEnthalpy_J_kg=donor['h'],exitDensity_kg_m3=out['rho'],energyDefect_W=defect)

ref=water(fixture['initialHot_C']+273.15);holeCount=len(b['ringElevations_m'])*b['holesPerRing']
nominalHead=fixture['referenceFlow_kg_s']**2/(2*ref['rho']*(holeCount*b['coefficient']*holeArea)**2)
patches=[exit_patch(dp,T) for dp,T in [(nominalHead,fixture['initialHot_C']),(-nominalHead,fixture['initialCold_C']),
  (1,fixture['initialHot_C']),(-1,fixture['initialCold_C']),(0,fixture['initialCold_C'])]]
initialSpeed=patches[0]['velocity_m_s']

def run(dt,lengthFactor=1.,reverse=False):
    started=time.perf_counter();hot=water(fixture['initialHot_C']+273.15);cold=water(fixture['initialCold_C']+273.15)
    masses=np.array([hot['rho']*sourceVolume,cold['rho']*residentVolume])
    u0=np.array([initialSpeed,0.])*(-1 if reverse else 1)
    P=masses*u0;E=masses*np.array([hot['h'],cold['h']])+P*P/(2*masses)
    # State contains total H+resolved KE, not a temperature subsequently repaired.
    y=np.array([P[0],P[1],E[0],E[1],s['calorimeterCapacity_J_K']*(s['calorimeterInitial_C']+273.15)])
    y0=y.copy();rows=[];maxE=0.;maxP=0.;maxWork=0.;minEntropy=math.inf;previousEntropy=None;previousSlip=abs(u0[0]-u0[1])
    def fields(y):
        velocities=y[:2]/masses;kinetic=y[:2]*y[:2]/(2*masses)
        fluids=[from_h((y[2+i]-kinetic[i])/masses[i]) for i in range(2)]
        Tc=y[4]/s['calorimeterCapacity_J_K']
        require(Tc>0 and np.all(np.isfinite(y)),'Finite calorimeter/state')
        return velocities,kinetic,fluids,Tc
    def rates(y,cooling):
        u,K,w,Tc=fields(y);slip=u[0]-u[1]
        # Explicit arithmetic face rho/cp; harmonic molecular transport coefficients.
        rho=(w[0]['rho']+w[1]['rho'])/2;cp=(w[0]['cp']+w[1]['cp'])/2
        mu=2*w[0]['mu']*w[1]['mu']/(w[0]['mu']+w[1]['mu'])
        k=2*w[0]['k']*w[1]['k']/(w[0]['k']+w[1]['k'])
        mut=rho*(s['lengthRatio']*lengthFactor*mixingWidth)**2*abs(slip)/separation
        force=(mu+mut)*contactArea*slip/separation
        heat=(k+mut*cp/s['turbulentPrandtl'])*contactArea*(w[0]['T']-w[1]['T'])/separation
        cool=s['coolingConductance_W_K']*(w[0]['T']-Tc) if cooling else 0.
        # One equal/opposite total-energy flux. Interface velocity fixes mechanical work.
        exchange=force*(u[0]+u[1])/2+heat
        return np.array([-force,force,-exchange-cool,exchange,cool]),dict(force_N=force,heat_W=heat,
          dissipation_W=force*slip,eddyViscosity_Pa_s=mut,cooling_W=cool)
    def record(t,y,cooling):
        nonlocal maxE,maxP,maxWork,minEntropy,previousEntropy,previousSlip
        u,K,w,Tc=fields(y);r,f=rates(y,cooling)
        entropy=sum(masses[i]*w[i]['s'] for i in range(2))+s['calorimeterCapacity_J_K']*math.log(Tc)
        if previousEntropy is not None:minEntropy=min(minEntropy,entropy-previousEntropy)
        previousEntropy=entropy
        maxE=max(maxE,abs(sum(y[2:])-sum(y0[2:])))
        maxP=max(maxP,abs(sum(y[:2])-sum(y0[:2])))
        V=sum(masses[i]/w[i]['rho'] for i in range(2))
        U=sum(masses[i]*w[i]['u'] for i in range(2))+sum(K)+y[4]
        initialU=sum(masses[i]*[hot,cold][i]['u'] for i in range(2))+sum(masses*u0*u0/2)+y0[4]
        maxWork=max(maxWork,abs(U-initialU+p*1e6*(V-sourceVolume-residentVolume)))
        slip=abs(u[0]-u[1]);require(slip<=previousSlip+1e-12,'Unforced slip may not grow');previousSlip=slip
        require(f['dissipation_W']>=-1e-12,'Shear cannot produce mean KE')
        if abs(t/.1-round(t/.1))<1e-8:
            rows.append(dict(t_s=t,source_C=w[0]['T']-273.15,resident_C=w[1]['T']-273.15,calorimeter_C=Tc-273.15,
              velocities_m_s=u.tolist(),volume_m3=V,entropy_J_K=entropy,**f))
    # Exercise the actual closure at zero slip: no mean stress or eddy heat flux,
    # but finite molecular conduction remains. This is not a fallback mixing rate.
    still=y.copy();still[:2]=0.;still[2:4]-=masses*u0*u0/2
    stillRates,stillFlux=rates(still,False)
    require(stillFlux['force_N']==0 and stillFlux['eddyViscosity_Pa_s']==0 and stillFlux['heat_W']>0,'Zero-slip molecular limit')
    record(0.,y,False)
    count=round(s['duration_s']/dt)
    for n in range(count):
        # Event state switches exactly at a step boundary; no stage straddles it.
        cooling=n*dt>=s['coolingStart_s']-1e-12
        a=rates(y,cooling)[0];bb=rates(y+dt*a/2,cooling)[0];c=rates(y+dt*bb/2,cooling)[0];d=rates(y+dt*c,cooling)[0]
        y=y+dt*(a+2*bb+2*c+d)/6
        record((n+1)*dt,y,(n+1)*dt>=s['coolingStart_s']-1e-12)
    require(maxE<s['energyTolerance_J'] and maxWork<s['energyTolerance_J'],'Energy and reconstructed U+pV accounting')
    require(maxP<s['momentumTolerance_kg_m_s'],'Momentum ledger')
    require(minEntropy>=-s['entropyTolerance_J_K'],'Entropy increment')
    require(any(r['heat_W']>0 for r in rows) and any(r['heat_W']<0 for r in rows),'Actual finite hot-to-cool heat flux reversal')
    return dict(dt_s=dt,lengthFactor=lengthFactor,reversedMomentum=reverse,masses_kg=masses.tolist(),trace=rows,
      maxEnergyDefect_J=maxE,maxMomentumDefect_kg_m_s=maxP,maxPressureWorkAccountingDefect_J=maxWork,
      minimumEntropyIncrement_J_K=minEntropy,wall_s=time.perf_counter()-started)

coarse=run(s['steps_s'][0]);fine=run(s['steps_s'][1]);length=run(s['steps_s'][0],.5);reverse=run(s['steps_s'][0],1.,True)
require(len(coarse['trace'])==len(fine['trace'])==len(reverse['trace']),'Common trace lengths')
temperatureError=0.;velocityError=0.;reversalError=0.
for a,bb,c in zip(coarse['trace'],fine['trace'],reverse['trace']):
    require(abs(a['t_s']-bb['t_s'])<1e-12 and abs(a['t_s']-c['t_s'])<1e-12,'Common clocks')
    temperatureError=max(temperatureError,*[abs(a[k]-bb[k]) for k in ['source_C','resident_C','calorimeter_C']])
    velocityError=max(velocityError,*[abs(x-y) for x,y in zip(a['velocities_m_s'],bb['velocities_m_s'])])
    reversalError=max(reversalError,*[abs(x+y) for x,y in zip(a['velocities_m_s'],c['velocities_m_s'])],
      *[abs(a[k]-c[k]) for k in ['source_C','resident_C','calorimeter_C']])
require(temperatureError<s['temperatureTolerance_K'] and velocityError<s['velocityTolerance_m_s'],'Frozen temporal screen')
require(reversalError<1e-9,'Momentum reversal symmetry')
# Independent algebra: total flux at mean u gives positive half of slip work to each side.
F=2.;u1=3.;u2=-1.;uf=(u1+u2)/2
require(F*(u1-uf)==F*(uf-u2)==F*(u1-u2)/2,'Each-side stress work identity')
print(json.dumps(dict(scope='Constitutive finite shear/heat test; no aperture receipt or return flow advanced',
  dependencies=dict(python=platform.python_version(),iapws=iapws.__version__,numpy=np.__version__),fixedOwnerGeometryAndBenchState=fixture,
  geometry=dict(referenceCellVolume_m3=cellVolume,sourceReferenceVolume_m3=sourceVolume,residentReferenceVolume_m3=residentVolume,
    contactArea_m2=contactArea,separation_m=separation,mixingWidth_m=mixingWidth,nominalIncompressibleContraction=nominalContraction),
  exitPatches=patches,cases=[coarse,fine,length,reverse],temperatureDifference_K=temperatureError,velocityDifference_m_s=velocityError,
  reversalSymmetryError=reversalError,checks=checks,constitutiveNumericalScreenPassed=True,
  receivingReturnFlowImplemented=False,physicalMixingTimingQualified=False)))
`

if (import.meta.main) {
  const [owner, python] = process.argv.slice(2)
  if (!owner || !python || process.argv.length !== 4) throw new Error('Usage: cmt-shear.ts owner.md python')
  const input = parseShearBasis(await Bun.file(owner).text())
  const child = Bun.spawn([python, '-c', shearCalculation], {
    stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit',
  })
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('CMT shear constitutive calculation failed')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  console.log(JSON.stringify({ input, inputHash: hash(JSON.stringify(input)), calculationHash: hash(shearCalculation),
    sourceHash: hash(await Bun.file(import.meta.path).text()), ...JSON.parse(output) }, null, 2))
}
