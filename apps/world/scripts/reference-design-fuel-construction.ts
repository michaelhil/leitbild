/** Offline fresh-fuel radial specification check. No runtime or licensing claim. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
const positive=z.number().finite().positive()
const schema=z.object({design:z.literal('LD-01-fresh-fuel-reference'),assemblies:z.number().int().positive(),
  latticeSide:z.number().int().positive(),rodsPerAssembly:z.number().int().positive(),guidesPerAssembly:z.number().int().positive(),
  pitch_m:positive,rodOuterDiameter_m:positive,cladThickness_m:positive,pelletDiameter_m:positive,guideOuterDiameter_m:positive,
  activeLength_m:positive,plenumLength_m:positive,fillPressure_Pa:positive,referenceTemperature_K:z.literal(300),
  fuelDensityFraction:z.literal(.95),fuelTheoreticalDensity_kg_m3:positive,cladDensity_kg_m3:positive,power_W:positive,
  coolantPressures_MPa:z.tuple([positive,positive,positive]),coolantTemperatures_K:z.tuple([positive,positive,positive]),
}).strict().superRefine((b,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:'custom',message})
  if(b.rodsPerAssembly+b.guidesPerAssembly!==b.latticeSide**2)fail('Every lattice position must be owned')
  if(b.rodOuterDiameter_m>=b.pitch_m||b.guideOuterDiameter_m>=b.pitch_m)fail('Overlapping lattice cylinders')
  if(b.rodOuterDiameter_m-2*b.cladThickness_m<=b.pelletDiameter_m)fail('Fresh reference requires a positive open gap')
  if(!(b.coolantTemperatures_K[0]<b.coolantTemperatures_K[1]&&b.coolantTemperatures_K[1]<b.coolantTemperatures_K[2]))fail('Nominal coolant temperatures must increase')
})
export function parseFuelConstruction(document:string){
  const blocks=[...document.matchAll(/^```reference-fuel-construction\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-fuel-construction JSON block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
const calculation=String.raw`
import sys,json,math,platform
import numpy as np,scipy,iapws
from scipy.optimize import root,brentq
from scipy.integrate import quad,solve_ivp
from iapws import IAPWS97 as W
b=json.load(sys.stdin); checks=[]; pi=math.pi
def check(name,a,e,atol=1e-7,rtol=1e-9):
    if not math.isfinite(a) or abs(a-e)>max(atol,rtol*abs(e)):raise ValueError(f'{name}: {a} != {e}')
    checks.append(dict(name=name,actual=a,expected=e))
BTU=1055.05585262/3600/.3048*1.8
rf0=b['pelletDiameter_m']/2; ro0=b['rodOuterDiameter_m']/2; ri0=ro0-b['cladThickness_m']
N=b['assemblies']*b['rodsPerAssembly']; L0=b['activeLength_m']/2
g0=ri0-rf0; area=N*2*pi*ro0*2*L0
cellArea=(b['latticeSide']*b['pitch_m'])**2
flow=b['assemblies']*(cellArea-b['rodsPerAssembly']*pi*ro0**2-b['guidesPerAssembly']*pi*(b['guideOuterDiameter_m']/2)**2)
perimeter=b['assemblies']*(b['rodsPerAssembly']*2*pi*ro0+b['guidesPerAssembly']*pi*b['guideOuterDiameter_m'])
dh=4*flow/perimeter
mf=b['fuelDensityFraction']*b['fuelTheoreticalDensity_kg_m3']*pi*rf0**2*L0*N
mc=b['cladDensity_kg_m3']*pi*(ro0**2-ri0**2)*L0*N
def kf(t):
    tc=t-273.15
    return BTU*(max(2335/(464+tc),1.1038)+.007027*math.exp(.001867*tc))
def fk(t):
    switch=2335/1.1038-464+273.15
    phonon=2335*math.log(464+min(t,switch)-273.15)+1.1038*max(0,t-switch)
    return BTU*(phonon+.007027/.001867*math.exp(.001867*(t-273.15)))
def kc(t):return 7.51+.0209*t-1.45e-5*t*t+7.67e-9*t**3
def ck(t):return 7.51*t+.0209*t*t/2-1.45e-5*t**3/3+7.67e-9*t**4/4
def cpf(t):
    z=535.285/t
    return 296.7*z*z*math.exp(z)/math.expm1(z)**2+.0243*t+8.745e7*1.577e5/(8.3143*t*t)*math.exp(-1.577e5/(8.3143*t))
def hf(t):return 296.7*535.285/math.expm1(535.285/t)+.0243*t*t/2+8.745e7*math.exp(-1.577e5/(8.3143*t))
cpTs=[300,400,640,1090]; cpVals=[281,302,331,375]
def cpc(t):return float(np.interp(t,cpTs,cpVals))
def hc(t):
    return sum(quad(cpc,a,min(t,z),epsabs=1e-7)[0] for a,z in zip(cpTs,cpTs[1:]) if t>a)
def fuelstrain(t):return 1e-5*t-.003+.04*math.exp(-6.9e-20/(1.38e-23*t))
def geometry(ts,pg,j,expanded=True):
    tw,ti,tf,tc=ts; tm=(tw+ti)/2; rbar=(ri0+ro0)/2
    E=1.088e11-5.475e7*tm; G=4.04e10-2.168e7*tm; nu=E/(2*G)-1
    po=b['coolantPressures_MPa'][j+1]*1e6
    hoop=(ri0*pg-ro0*po)/(ro0-ri0)
    axial=(ri0**2*pg-ro0**2*po)/(ro0**2-ri0**2)
    er=(hoop-nu*axial)/E; ez=(axial-nu*hoop)/E
    if not expanded:return rf0,ri0,ro0,L0,0.,0.
    dr=er*rbar
    ri=ri0*(1+6.72e-6*(tm-300))+dr; ro=ro0*(1+6.72e-6*(tm-300))+dr
    rf=rf0*(1+fuelstrain((tf+tc)/2)-fuelstrain(300))
    length=L0*(1+4.44e-6*(tm-300)+ez)
    return rf,ri,ro,length,dr,hoop
water=[W(P=p,T=t) for p,t in zip(b['coolantPressures_MPa'],b['coolantTemperatures_K'])]
massflow=b['power_W']/((water[2].h-water[0].h)*1000)
duties=[massflow*(water[j+1].h-water[j].h)*1000 for j in range(2)]
vp=pi*ri0**2*b['plenumLength_m']; gasConstant=b['fillPressure_Pa']*(vp+pi*(ri0**2-rf0**2)*2*L0)/300
tp=b['coolantTemperatures_K'][-1]+10
def gap(ts,pg,geo,radiation):
    tw,ti,tf,tc=ts; rf,ri,ro,length,dr,stress=geo
    tg=(tf+ti)/2; khe=1.314e-3*(1.8*tg)**.668*BTU
    accommodation=.425-2.3e-4*tg
    if accommodation<=0 or ri<=rf:raise ValueError('Outside open-gap/accommodation branch')
    jump=.3048*2.0358e-5*(khe/BTU)*math.sqrt(tg)/((pg/6894.757293168)*accommodation/math.sqrt(4.003))
    h=khe/(ri-rf+1.845*jump)
    qr=radiation*5.670374419e-8*(tf**4-ti**4)
    return h*(tf-ti)+qr,qr,jump,khe,h
def convection(tw,j):
    t=water[j+1].T; p=b['coolantPressures_MPa'][j+1]
    w=W(P=p,T=(t+tw)/2)
    re=massflow/flow*dh/w.mu; pr=w.cp*1000*w.mu/w.k
    if re<10000 or not .6<pr<160:raise ValueError('Outside turbulent convection check')
    return .023*re**.8*pr**.4*w.k/dh,re,pr
def solve(radiation=0.,expanded=True):
    def residual(v):
        pg=v[-1]*1e6; rows=[]; inv=vp/tp
        for j in range(2):
            ts=v[4*j:4*j+4]; tw,ti,tf,tc=ts
            geo=geometry(ts,pg,j,expanded); rf,ri,ro,length,dr,stress=geo
            qp=duties[j]/N/length
            qg,*_=gap(ts,pg,geo,radiation)
            h,*_=convection(tw,j)
            rows += [(h*(tw-water[j+1].T)*2*pi*ro-qp)/qp,
                (ck(ti)-ck(tw)-qp*math.log(ro/ri)/(2*pi))/qp,
                (qg*2*pi*rf-qp)/qp,(fk(tc)-fk(tf)-qp/(4*pi))/qp]
            inv+=pi*(ri*ri-rf*rf)*length/((tf+ti)/2)
        rows.append((pg*inv-gasConstant)/gasConstant)
        return rows
    result=root(residual,[590,620,755,1050,606,640,795,1120,4.2],tol=1e-10)
    if not result.success or max(abs(x) for x in residual(result.x))>1e-8:raise ValueError(str(result.message))
    pg=result.x[-1]*1e6; rows=[]
    for j in range(2):
        ts=result.x[4*j:4*j+4]; tw,ti,tf,tc=map(float,ts)
        if not 500<=tf<=tc<=2000 or not 300<=tw<=ti<=1000:raise ValueError('Material temperature domain exceeded')
        geo=geometry(ts,pg,j,expanded); rf,ri,ro,length,dr,stress=geo; qp=duties[j]/N/length
        h,re,pr=convection(tw,j)
        if tw>=W(P=b['coolantPressures_MPa'][j+1],x=0).T:raise ValueError('Nominal convection-only check reached saturation')
        qg,qr,jump,khe,hgap=gap(ts,pg,geo,radiation)
        def fuelT(x):return brentq(lambda t:fk(t)-fk(tf)-qp/(4*pi)*(1-x*x),tf-1e-8,tc+1e-8)
        def cladT(x):
            r=math.sqrt(ri*ri+x*(ro*ro-ri*ri))
            return brentq(lambda t:ck(t)-ck(tw)-qp/(2*pi)*math.log(ro/r),tw-1e-8,ti+1e-8)
        meanFuel=quad(lambda x:2*x*fuelT(x),0,1,epsabs=1e-7)[0]
        ef=mf*quad(lambda x:2*x*(hf(fuelT(x))-hf(300)),0,1,epsabs=1e-5)[0]
        ec=mc*quad(lambda x:hc(cladT(x)),0,1,epsabs=1e-5)[0]
        cf=mf*quad(lambda x:2*x*cpf(fuelT(x)),0,1,epsabs=1e-7)[0]
        cc=mc*quad(lambda x:cpc(cladT(x)),0,1,epsabs=1e-7)[0]
        # Independent ODE against conductivity primitives; x=r/rf avoids r=0 singularity.
        ode=solve_ivp(lambda x,t:[-qp*x/(2*pi*kf(float(t[0])))],(0,1),[tc],rtol=1e-10,atol=1e-9,dense_output=True)
        check('fuel ODE surface '+str(j),float(ode.y[0,-1]),tf,atol=1e-6)
        for x in [.2,.5,.8]:check('fuel ODE profile '+str(j)+' '+str(x),float(ode.sol(x)[0]),fuelT(x),atol=2e-6)
        odeC=solve_ivp(lambda r,t:[-qp/(2*pi*r*kc(float(t[0])))],(ri,ro),[ti],rtol=1e-10,atol=1e-9)
        check('clad ODE surface '+str(j),float(odeC.y[0,-1]),tw,atol=1e-6)
        check('gap interface heat '+str(j),qg*2*pi*rf,qp,atol=1e-5)
        check('coolant interface heat '+str(j),h*(tw-water[j+1].T)*2*pi*ro,qp,atol=1e-5)
        check('clad fixed mass '+str(j),mc/(pi*(ro*ro-ri*ri)*length*N)*pi*(ro*ro-ri*ri)*length*N,mc)
        # Midpoint shell energy refinement is separate from adaptive primitive quadrature.
        shell=[]
        for n in [32,128]:
            value=mf*sum((hf(fuelT(math.sqrt((i+.5)/n)))-hf(300))/n for i in range(n))
            shell.append(dict(shells=n,energy_J=value,error_J=value-ef))
        if abs(shell[-1]['error_J'])>=abs(shell[0]['error_J']):raise ValueError('No radial storage refinement')
        check('128-shell stored energy',shell[-1]['energy_J'],ef,rtol=2e-6)
        rows.append(dict(cell=j+1,power_W=duties[j],linePower_W_m=qp,wallFlux_W_m2=qp/(2*pi*ro),
            Tw_K=tw,TcladInner_K=ti,TfuelSurface_K=tf,TfuelCenter_K=tc,TfuelAreaMean_K=meanFuel,
            fuelRadius_m=rf,cladInnerRadius_m=ri,cladOuterRadius_m=ro,activeLength_m=length,
            radialGap_um=(ri-rf)*1e6,cladElasticDisplacement_um=dr*1e6,hoopStress_MPa=stress/1e6,
            gapJump_um=jump*1e6,heliumConductivity_W_mK=khe,gapConductance_W_m2K=hgap,
            radiationFraction=qr/qg,hFC_W_m2K=h,Re=re,Pr=pr,
            fuelMass_kg=mf,cladMass_kg=mc,fuelSensibleEnergy_J=ef,cladSensibleEnergy_J=ec,
            fuelUniformTemperatureShiftCapacity_J_K=cf,cladUniformTemperatureShiftCapacity_J_K=cc,
            energyRefinement=shell))
    return dict(heliumPressure_Pa=float(pg),rows=rows)
base=solve(); black=solve(1.); cold=solve(0.,False)
for t in [600.,900.,1500.,1980.]:
    dt=.01
    check('fuel k primitive '+str(t),(fk(t+dt)-fk(t-dt))/(2*dt),kf(t),atol=1e-7)
    check('fuel caloric primitive '+str(t),(hf(t+dt)-hf(t-dt))/(2*dt),cpf(t),atol=1e-6)
for t in [350.,550.,800.]:
    dt=.01
    check('clad caloric primitive '+str(t),(hc(t+dt)-hc(t-dt))/(2*dt),cpc(t),atol=1e-6)
radiation=[]
for a,c in zip(base['rows'],black['rows']):
    dc=c['TfuelCenter_K']-a['TfuelCenter_K']; dg=(c['TfuelSurface_K']-c['TcladInner_K'])-(a['TfuelSurface_K']-a['TcladInner_K'])
    radiation.append(dict(cell=a['cell'],blackbodyDutyFraction=c['radiationFraction'],centerlineChange_K=dc,gapDropChange_K=dg,
        omissionGatePassed=c['radiationFraction']<.02 and abs(dc)<5 and abs(dg)<5))
if not all(r['omissionGatePassed'] for r in radiation):raise ValueError('Zero-radiation reference is not admitted by the predeclared bound')
hotArea=sum(N*2*pi*r['cladOuterRadius_m']*r['activeLength_m'] for r in base['rows'])
hotFlow=[b['assemblies']*(cellArea-b['rodsPerAssembly']*pi*r['cladOuterRadius_m']**2-b['guidesPerAssembly']*pi*(b['guideOuterDiameter_m']/2)**2) for r in base['rows']]
print(json.dumps(dict(scope='fresh open-gap radial material/geometry reference; not irradiated fuel, CHF or live runtime',
    packages=dict(python=platform.python_version(),scipy=scipy.__version__,iapws=iapws.__version__,numpy=np.__version__),
    coldGeometry=dict(rods=N,heatedArea_m2=area,flowArea_m2=flow,wettedPerimeter_m=perimeter,hydraulicDiameter_m=dh,
        coreFlowVolume_m3=flow*2*L0,radialGap_um=g0*1e6,assemblyPitch_m=b['latticeSide']*b['pitch_m'],
        grossBundleArea_m2=cellArea*b['assemblies'],fuelMass_kg=2*mf,cladMass_kg=2*mc),
    nominal=dict(massflow_kg_s=massflow,meanWallFlux_W_m2=b['power_W']/area,meanLinearDuty_W_m=b['power_W']/N/(2*L0)),
    hotGeometryComparison=dict(heatedArea_m2=hotArea,flowAreaWithFixedGuideAndPitch_m2=hotFlow,
        convectionUsesColdLattice=True,fullHydraulicExpansionQualified=False),
    base=base,blackbodyUpperBound=black,frozenColdGeometryComparison=cold,radiationOmission=radiation,checks=checks,
    empiricalFuelQualification=False,contactOrRelocationQualified=False,CHFQualification=False),allow_nan=False,indent=2))
`
if(import.meta.main){
  const [path,python,...extra]=process.argv.slice(2)
  if(!path||!python||extra.length)throw Error('Usage: bun reference-design-fuel-construction.ts <fuel-construction.md> <isolated-python>')
  const input=parseFuelConstruction(await Bun.file(path).text())
  const child=Bun.spawn([python,'-c',calculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(exit!==0)throw Error(err||`Fuel reference failed: ${exit}`)
  console.log(JSON.stringify({inputSha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    calculationSha256:createHash('sha256').update(calculation).digest('hex'),...JSON.parse(out)},null,2))
}
