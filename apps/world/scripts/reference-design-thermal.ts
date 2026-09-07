/** Offline conservative immersed-column/solid study; never imported by a runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
const positive=z.number().finite().positive()
const schema=z.object({
  design:z.literal('LD-01-thermal-separate-effects'),pressure_MPaAbs:positive.min(.1).max(.2),length_m:positive,
  outsideDiameter_m:positive,wallThickness_m:positive,pitch_m:positive,
  solidDensity_kg_m3:positive,solidCp_J_kgK:positive,solidConductivity_W_mK:positive,
  initialSolid_C:z.number().finite(),initialPoolDepth_m:positive,injection_kg_s:positive,
  steamR_J_kgK:positive,steamCp_J_kgK:positive,wallEmissivity:positive.max(1),
  contactAngle_deg:positive.max(180),duration_s:positive,
  axialCells:z.tuple([z.number().int().positive(),z.number().int().positive(),z.number().int().positive()]),
  radialCells:z.literal(4),steps_s:z.tuple([positive,positive,positive]),
}).strict().superRefine((b,c)=>{
  for(const [ok,message] of [
    [b.pitch_m>b.outsideDiameter_m,'Pitch must exceed tube diameter'],
    [2*b.wallThickness_m<b.outsideDiameter_m,'Tube inside radius must be positive'],
    [b.initialPoolDepth_m<b.length_m,'Initial pool must leave a dry section'],
    [b.steamCp_J_kgK>b.steamR_J_kgK,'Steam cv must be positive'],
    [b.axialCells[0]<b.axialCells[1]&&b.axialCells[1]<b.axialCells[2],'Axial meshes must increase'],
    [b.steps_s[0]>b.steps_s[1]&&b.steps_s[1]>b.steps_s[2],'Time steps must decrease'],
  ] as const)if(!ok)c.addIssue({code:'custom',message})
})
export function parseThermalStudy(document:string) {
  const blocks=[...document.matchAll(/^```reference-thermal-study\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected exactly one reference-thermal-study JSON block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

const calculation=String.raw`
import sys,json,math,platform
import numpy as np
import scipy,iapws
from scipy.optimize import brentq
from scipy.sparse import diags,kron,eye,csc_matrix
from scipy.sparse.linalg import spsolve
from iapws import IAPWS97 as W
b=json.load(sys.stdin); checks=[]
def check(name,actual,expected,atol=1e-8,rtol=1e-8):
    if abs(actual-expected)>max(atol,abs(expected)*rtol):raise ValueError(f'{name}: {actual} vs {expected}')
    checks.append(dict(name=name,actual=float(actual),expected=float(expected)))
p=b['pressure_MPaAbs']; pa=p*1e6; g=9.80665
if not .1<=p<=.2:raise ValueError('Immersed-column comparison selected only for .1–.2 MPa')
f=W(P=p,x=0); v=W(P=p,x=1); Ts=f.T; hf=f.h*1000; hg=v.h*1000; hfg=hg-hf
rho=f.rho; sigma=f.sigma
L=b['length_m']; ro=b['outsideDiameter_m']/2; ri=ro-b['wallThickness_m']
perimeter=2*math.pi*ro; Af=b['pitch_m']**2-math.pi*ro**2; Dh=4*Af/perimeter
rhoS=b['solidDensity_kg_m3']; cpS=b['solidCp_J_kgK']; ks=b['solidConductivity_W_mK']
R=b['steamR_J_kgK']; cp=b['steamCp_J_kgK']; a=hg-cp*Ts
pr=p/22.064; exponent=.9-.3*pr**.15
Fp=1.73*pr**.27+(6.1+.68/(1-pr))*pr**2
FpCTF=1.73*pr**.27+6.1*pr**2+.68*pr**2/(1-pr**2)
phi=math.radians(b['contactAngle_deg']); Fphi=1-math.exp(-phi**3-.5*phi)

# Fixed property interpolation is a declared numerical approximation, checked
# against direct IF97 below; no thermodynamic state or phase boundary is clipped.
propertyT=np.linspace(Ts+.001,b['initialSolid_C']+273.15+100,1201)
propertyValues=np.array([[w.k,w.mu,w.rho,w.cp*1000] for w in [W(P=p,T=float(t)) for t in propertyT]])
def steam_props(T):
    if T<propertyT[0]-1e-8 or T>propertyT[-1]:raise ValueError(f'Steam property temperature out of domain: {T}')
    return [float(np.interp(T,propertyT,propertyValues[:,j])) for j in range(4)]
for T in [Ts+3.14159,Ts+73.125,Ts+211.11,Ts+499.7]:
    w=W(P=p,T=T)
    for key,value,expected in zip(['k','mu','rho','cp'],steam_props(T),[w.k,w.mu,w.rho,w.cp*1000]):
        check('IF97 property interpolation '+key,value,expected,rtol=2e-5)

def q_pool(T):
    if T<=Ts:return 0.
    return (5600*Fp*(T-Ts)/(20000**exponent))**(1/(1-exponent))

def liquid_convection(T,mdot=0.):
    # Saturated liquid side: properties at saturated liquid, not invalid superheated liquid.
    Re=abs(mdot)*Dh/(Af*f.mu); Pr=f.cp*1000*f.mu/f.k
    beta=f.alfav; Gr=g*beta*abs(T-Ts)*Dh**3/(f.mu/f.rho)**2
    lam=7.86; forced=.023*Re**.8*Pr**.4
    natural=.7*(Gr*Pr)**.25
    return max(lam,forced,natural)*f.k/Dh

def pre_chf(T,mdot=0.):
    h=liquid_convection(T,mdot)
    dOnb=2*h*sigma*Ts/(Fphi**2*v.rho*hfg*f.k)
    Tonb=Ts+dOnb
    qfc=h*(T-Ts)
    if T<=Tonb:return qfc,Tonb
    return (qfc**3+(q_pool(T)-q_pool(Tonb))**3)**(1/3),Tonb

qCHF=.131*hfg*math.sqrt(v.rho)*(g*sigma*(f.rho-v.rho))**.25
TCHF=brentq(lambda T:pre_chf(T)[0]-qCHF,Ts+.001,Ts+200)
Tmin=557.85+44.1*p-3.72*p*p
if Tmin<=TCHF:raise ValueError('Invalid boiling-curve temperature ordering')

def film_flux(T,filmLength):
    if T<=Ts:return 0.
    # Bromley vertical vapor-film form, fluid properties at mean film temperature.
    k,mu,rg,_=steam_props(max(Ts+.001,(T+Ts)/2))
    # Exact selected characteristic length is total currently immersed length;
    # no mesh-size or artificial heat-transfer floor is substituted.
    if filmLength<=0:return 0.
    h=1.13*(k**3*rg*(f.rho-rg)*g*hfg/(mu*filmLength*(T-Ts)))**.25
    radiation=b['wallEmissivity']*5.670374419e-8*(T**4-Ts**4)
    return h*(T-Ts)+radiation

def wet_flux(T,filmLength):
    if T<=TCHF:return pre_chf(T)[0],0
    if T>=Tmin:return film_flux(T,filmLength),2
    weight=((T-Tmin)/(TCHF-Tmin))**2
    return weight*qCHF+(1-weight)*film_flux(T,filmLength),1

def vapor_h(Tw,Tg,mdot):
    # Selected CTF DB/laminar laws, augmented by RELAP-7 natural convection.
    # This is not CTF's whole envelope: the 17x17-bundle WH fit is not selected.
    k,mu,rg,cpv=steam_props(max(Ts+.001,(Tw+Tg)/2))
    Re=abs(mdot)*Dh/(Af*mu); Pr=cpv*mu/k
    Ra=g*abs(Tw-Tg)*Dh**3/((Tw+Tg)/2)/(mu/rg)**2*Pr
    Nu=max(10.,.023*Re**.8*Pr**.4,.13*Ra**(1/3))
    return Nu*k/Dh

# Correlation identities/limits are distinct from experimental qualification.
check('Gorenflo reference flux at its inverse wall temperature',
      q_pool(Ts+20000/(5600*Fp)),20000,atol=1e-6)
check('CHF root on pre-CHF curve',pre_chf(TCHF)[0],qCHF,atol=.001)
check('transition begins at CHF',wet_flux(TCHF,L)[0],qCHF,atol=.001)
check('transition ends at film branch',wet_flux(Tmin,L)[0],film_flux(Tmin,L),atol=.001)
check('zero wall superheat',wet_flux(Ts,L)[0],0.)
if vapor_h(Ts+100,Ts,0)<=0:raise ValueError('Zero-flow steam heat transfer disappeared')

def run(N,dt,rate,radial=None,duration=None):
    nr=radial or b['radialCells']; dz=L/N; end=duration or b['duration_s']
    edges=np.linspace(ri,ro,nr+1); rc=np.sqrt((edges[:-1]**2+edges[1:]**2)/2)
    ar=math.pi*(edges[1:]**2-edges[:-1]**2); C=np.tile(rhoS*cpS*ar*dz,N)
    innerG=2*math.pi*ks*dz/np.log(rc[1:]/rc[:-1])
    radialD=np.zeros(nr)
    radialD[:-1]+=innerG; radialD[1:]+=innerG
    radialK=diags([-innerG,radialD,-innerG],[-1,0,1],shape=(nr,nr))
    axdiag=np.full(N,2.); axdiag[0]=axdiag[-1]=1.
    axialK=diags([-np.ones(N-1),axdiag,-np.ones(N-1)],[-1,0,1],shape=(N,N))
    K=kron(eye(N),radialK)+kron(axialK,diags(ks*ar/dz,0))
    base=diags(C/dt,0)+K
    surfaceIndices=np.arange(N)*nr+(nr-1)
    outerHalfG=2*math.pi*ks*dz/math.log(ro/rc[-1])
    innerHalfG=2*math.pi*ks*dz/math.log(rc[0]/ri)
    check(f'exact cylindrical series resistance radial{nr}',
        1/innerHalfG+float(np.sum(1/innerG))+1/outerHalfG,math.log(ro/ri)/(2*math.pi*ks*dz))
    z=(np.arange(N)+.5)*dz; bottoms=np.arange(N)*dz
    sampleZ=np.array([.1,.5,.9])*L
    T=np.full(N*nr,b['initialSolid_C']+273.15); Tg=np.full(N,Ts)
    surface=np.full(N,b['initialSolid_C']+273.15)
    ml=rho*Af*b['initialPoolDepth_m']; depth=ml/(rho*Af)
    gasV=Af*dz*(1-np.clip((depth-bottoms)/dz,0,1)); mg=pa*gasV/(R*Tg)
    actualSteamInlet=np.zeros(N)
    initialH=float(np.dot(C,T-Ts)+ml*hf+np.sum(mg*(a+cp*Tg)))
    initialM=ml+float(np.sum(mg)); injected=vented=overflow=0.; inletH=outletH=0.
    qtime=np.full(3,np.nan); rows=[]; minimumM=ml; maxResidual=0.; maxMassResidual=0.
    minOutlet=1e99
    nstep=round(end/dt)
    for step in range(nstep+1):
        t=step*dt
        wet=np.clip((depth-bottoms)/dz,0,1)
        sampledSurface=np.interp(sampleZ,z,surface)
        firstWet=(sampledSurface<=TCHF)&(sampleZ<depth)&np.isnan(qtime); qtime[firstWet]=t
        residual=float(np.dot(C,T-Ts)+ml*hf+np.sum(mg*(a+cp*Tg))-initialH-inletH+outletH)
        mres=ml+float(np.sum(mg))-initialM-injected+vented+overflow
        maxResidual=max(maxResidual,abs(residual)); maxMassResidual=max(maxMassResidual,abs(mres))
        if step%max(1,round(5/dt))==0 or step==nstep:
            rows.append(dict(t_s=t,poolDepth_m=depth,liquid_kg=ml,steam_kg=float(np.sum(mg)),
                hottestSurface_C=float(np.max(surface)-273.15),exitSteam_C=float(Tg[-1]-273.15),
                sampleElevation_m=sampleZ.tolist(),surface_C=(sampledSurface-273.15).tolist(),
                fluidDensity_kg_m3=np.interp(sampleZ,z,rho*wet+mg/(Af*dz)).tolist(),
                geometricImmersion=np.interp(sampleZ,z,wet).tolist(),
                localSteam_C=[None if zz<depth else float(np.interp(zz,z,Tg)-273.15) for zz in sampleZ],
                bulkPool_C=Ts-273.15,
                wallBoilingRegime=[int(wet_flux(float(temp),depth)[1]) if zz<depth else -1 for zz,temp in zip(sampleZ,sampledSurface)],
                energyResidual_J=residual,massResidual_kg=mres))
        if step==nstep:break
        qw=np.array([wet_flux(float(x),depth)[0] for x in surface])
        hw=np.divide(qw,surface-Ts,out=np.zeros(N),where=abs(surface-Ts)>1e-8)
        # Lag actual local inlet flow, initially zero; no common evaporation rate
        # is passed off as the per-cell transported mass flux.
        hv=np.array([vapor_h(float(x),float(y),float(flow)) for x,y,flow in zip(surface,Tg,actualSteamInlet)])
        Aw=perimeter*dz*wet; Ag=perimeter*dz*(1-wet)
        Hw=hw*Aw; Hg=hv*Ag
        # Eliminate the massless physical outer face through the exact cylindrical
        # half-shell conductance. The shell-center is never labelled wall surface.
        faceFactor=outerHalfG/(outerHalfG+Hw+Hg)
        diag=np.zeros(N*nr); rhs=C/dt*T
        diag[surfaceIndices]=faceFactor*(Hw+Hg)
        rhs[surfaceIndices]+=faceFactor*(Hw*Ts+Hg*Tg)
        Tnew=spsolve(csc_matrix(base+diags(diag,0)),rhs)
        surfaceNew=(outerHalfG*Tnew[surfaceIndices]+Hw*Ts+Hg*Tg)/(outerHalfG+Hw+Hg)
        Qpool=Hw*(surfaceNew-Ts)
        Qgas=Hg*(surfaceNew-Tg)
        evap=float(np.sum(Qpool))*dt/hfg
        if evap < -1e-12:raise ValueError('Saturated-pool cooling/condensation needs separate liquid closure')
        addition=rate*dt
        mlNew=ml+addition-evap
        if mlNew<0:
            # Explicit applicability termination, never invent dry-pool water.
            check(f'pre-depletion energy ledger N{N} dt{dt}',maxResidual,0,atol=1e-5)
            check(f'pre-depletion mass ledger N{N} dt{dt}',maxMassResidual,0,atol=1e-10)
            return dict(N=N,dt_s=dt,injection_kg_s=rate,termination='liquid pool exhausted',
                applicabilityCrossingBracket_s=[t,t+dt],lastAcceptedLiquid_kg=ml,
                rows=rows,maxEnergyResidual_J=maxResidual,maxMassResidual_kg=maxMassResidual)
        over=max(0,mlNew-rho*Af*L); mlNew-=over; newDepth=mlNew/(rho*Af)
        newGasV=Af*dz*(1-np.clip((newDepth-bottoms)/dz,0,1))
        incoming=evap; incomingT=Ts
        newMg=np.empty(N); newTg=np.empty(N)
        for j in range(N):
            actualSteamInlet[j]=incoming/dt
            denom=mg[j]+incoming
            if denom<=0:
                if newGasV[j]>1e-15:raise ValueError('Pressure-supported gas volume has no admitted mass')
                newMg[j]=0.; newTg[j]=Ts; continue
            temperature=(mg[j]*Tg[j]+incoming*incomingT+Qgas[j]*dt/cp)/denom
            mass=pa*newGasV[j]/(R*temperature)
            leaving=denom-mass
            if leaving < -1e-12:raise ValueError('Reverse atmospheric makeup requires explicit inlet branch')
            newMg[j]=mass; newTg[j]=temperature
            incoming=leaving; incomingT=temperature
        injected+=addition; vented+=incoming; overflow+=over
        inletH+=addition*hf; outletH+=incoming*(a+cp*incomingT)+over*hf
        minOutlet=min(minOutlet,incoming/dt)
        T=Tnew; surface=surfaceNew; Tg=newTg; mg=newMg; ml=mlNew; depth=newDepth
        minimumM=min(minimumM,ml)
    check(f'column energy ledger N{N} dt{dt} rate{rate}',maxResidual,0,atol=1e-5)
    check(f'column mass ledger N{N} dt{dt} rate{rate}',maxMassResidual,0,atol=1e-10)
    return dict(N=N,radialCells=nr,dt_s=dt,injection_kg_s=rate,termination='duration reached',
        maxEnergyResidual_J=maxResidual,maxMassResidual_kg=maxMassResidual,initialSolidEnergy_J=float(np.sum(C)*(b['initialSolid_C']+273.15-Ts)),
        initialLiquid_kg=initialM-float(np.sum(pa*gasV/(R*Ts))),injected_kg=injected,vented_kg=vented,overflow_kg=overflow,
        minimumLiquid_kg=minimumM,minimumVent_kg_s=minOutlet,finalSurfaceMax_C=float(np.max(surface)-273.15),
        quenchTime_s=[None if np.isnan(value) else float(value) for value in qtime],rows=rows)

out=dict(properties=dict(Tsat_C=Ts-273.15,liquidDensity_kg_m3=rho,steamDensityIF97_kg_m3=v.rho,
    steamDensityIdeal_kg_m3=pa/(R*Ts),latent_J_kg=hfg,flowArea_m2=Af,hydraulicDiameter_m=Dh,
    poolCHF_W_m2=qCHF,TCHF_C=TCHF-273.15,Tmin_C=Tmin-273.15,
    GorenfloPressureFactor=Fp,CTFPrintedPressureFactor=FpCTF,
    fullColumnHydrostaticSaturationIncrease_K=W(P=p+rho*g*L/1e6,x=0).T-Ts),
    wallCurve=[dict(wall_C=T-273.15,preCHF_W_m2=pre_chf(T)[0],selectedPool_W_m2=wet_flux(T,L)[0],
        regime=wet_flux(T,L)[1],drySteamHTC_W_m2K=vapor_h(T,Ts,0)) for T in [Ts,Ts+5,Ts+10,TCHF,Tmin,Ts+300,Ts+500]],
    axialRuns=[run(N,b['steps_s'][2],b['injection_kg_s']) for N in b['axialCells']],
    timeRuns=[run(b['axialCells'][1],dt,b['injection_kg_s']) for dt in b['steps_s'][:2]],
    radialRuns=[run(b['axialCells'][1],b['steps_s'][2],b['injection_kg_s'],radial=r) for r in [2,8]],
    fineAxialRun=run(b['axialCells'][2]*2,b['steps_s'][2],b['injection_kg_s']),
    supplyRuns=[run(b['axialCells'][1],b['steps_s'][1],r) for r in [b['injection_kg_s']*.1,0]],
    packages=dict(python=platform.python_version(),numpy=np.__version__,scipy=scipy.__version__,iapws=iapws.__version__))
def compare(name,coarse,fine):
    if len(coarse['rows'])!=len(fine['rows']):raise ValueError('Refinement has different physical sample times')
    diffs=dict(hottestSurface_K=0.,exitSteam_K=0.,localSurface_K=0.,poolDepth_m=0.)
    for x,y in zip(coarse['rows'],fine['rows']):
        check('common refinement sample time',x['t_s'],y['t_s'])
        for key,field in [('hottestSurface_K','hottestSurface_C'),('exitSteam_K','exitSteam_C'),('poolDepth_m','poolDepth_m')]:
            diffs[key]=max(diffs[key],abs(x[field]-y[field]))
        diffs['localSurface_K']=max(diffs['localSurface_K'],max(abs(u-v) for u,v in zip(x['surface_C'],y['surface_C'])))
    # Original investigation tolerances, not experimental uncertainty. Bulk and
    # local acceptance are separate, and a failed local criterion remains false.
    bulk=bool(diffs['hottestSurface_K']<=5 and diffs['poolDepth_m']<=.001)
    local=bool(diffs['localSurface_K']<=10 and diffs['exitSteam_K']<=10)
    if not bulk:raise ValueError(f'Bulk trajectory refinement rejected: {name} {diffs}')
    return dict(name=name,maxCommonTimeDifferences=diffs,bulkAccepted=bulk,localTrajectoryAccepted=local)
out['refinement']=[compare('axial40/80',out['axialRuns'][0],out['axialRuns'][1]),
    compare('axial80/160',out['axialRuns'][1],out['axialRuns'][2]),
    compare('axial160/320',out['axialRuns'][2],out['fineAxialRun']),
    compare('time0.04/0.02',out['timeRuns'][0],out['timeRuns'][1]),
    compare('time0.02/0.01',out['timeRuns'][1],out['axialRuns'][1]),
    compare('radial2/4',out['radialRuns'][0],out['axialRuns'][1]),
    compare('radial4/8',out['axialRuns'][1],out['radialRuns'][1])]
out['localCoolingTimingAccepted']=all(x['localTrajectoryAccepted'] for x in out['refinement'])
out['steamApproximation']=dict(saturationDensityRelativeError=abs(pa/(R*Ts)/v.rho-1),
    maxSampledCpRelativeError=max(abs(cp/W(P=p,T=t).cp/1000-1) for t in [Ts+.01,Ts+100,Ts+300,Ts+500]),
    maximumElevationEnergy_J_kg=g*L)
out['checks']=checks
print(json.dumps(out,indent=2,allow_nan=False))
`

if(import.meta.main) {
  const path=process.argv[2]
  const python=process.argv[3]
  if(!path||!python)throw Error('Usage: bun reference-design-thermal.ts <axial-thermal-study.md> <isolated-python>')
  const input=parseThermalStudy(await Bun.file(path).text())
  const child=Bun.spawn([python,'-c',calculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(exit!==0)throw Error(stderr||`Thermal calculation failed: ${exit}`)
  console.log(JSON.stringify({calculationSha256:createHash('sha256').update(calculation).digest('hex'),
    inputSha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),...JSON.parse(stdout)},null,2))
}
