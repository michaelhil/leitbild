/** Offline fresh-fuel radial specification check. No runtime or licensing claim. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { fuelMaterialPython, fuelGeometryPython } from './reference-design-fuel-materials.ts'
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
export function fuelGeometry(b:ReturnType<typeof parseFuelConstruction>){
  const rods=b.assemblies*b.rodsPerAssembly,ro=b.rodOuterDiameter_m/2,ri=ro-b.cladThickness_m,rf=b.pelletDiameter_m/2
  const assemblyArea=(b.latticeSide*b.pitch_m)**2
  const flowArea_m2=b.assemblies*(assemblyArea-b.rodsPerAssembly*Math.PI*ro**2-b.guidesPerAssembly*Math.PI*(b.guideOuterDiameter_m/2)**2)
  const wettedPerimeter_m=b.assemblies*(b.rodsPerAssembly*2*Math.PI*ro+b.guidesPerAssembly*Math.PI*b.guideOuterDiameter_m)
  return {rods,assemblyArea_m2:assemblyArea,heatedArea_m2:rods*2*Math.PI*ro*b.activeLength_m,flowArea_m2,wettedPerimeter_m,
    hydraulicDiameter_m:4*flowArea_m2/wettedPerimeter_m,coreFlowVolume_m3:flowArea_m2*b.activeLength_m,
    fuelMass_kg:b.fuelDensityFraction*b.fuelTheoreticalDensity_kg_m3*Math.PI*rf**2*b.activeLength_m*rods,
    cladMass_kg:b.cladDensity_kg_m3*Math.PI*(ro**2-ri**2)*b.activeLength_m*rods}
}
const boundarySchema=z.object({coolantPressures_MPa:z.tuple([positive,positive,positive]),
  coolantTemperatures_K:z.tuple([positive,positive,positive]),massflow_kg_s:positive,cellHeat_W:z.tuple([positive,positive])}).strict()
export type FuelBoundary=z.infer<typeof boundarySchema>
const materialStateSchema=z.enum(['unrelocated','beginning-of-life'])
export type FuelMaterialState=z.infer<typeof materialStateSchema>
const calculation=String.raw`
import sys,json,math,platform
import numpy as np,scipy,iapws
from scipy.optimize import root,brentq
from scipy.integrate import quad,solve_ivp
from iapws import IAPWS97 as W
d=json.load(sys.stdin); b=d['basis']; geom=d['geometry']; boundary=d['boundary']; materialState=d['materialState']; depositedFraction=d['depositedFraction']; checks=[]; pi=math.pi
def check(name,a,e,atol=1e-7,rtol=1e-9):
    if not math.isfinite(a) or abs(a-e)>max(atol,rtol*abs(e)):raise ValueError(f'{name}: {a} != {e}')
    checks.append(dict(name=name,actual=a,expected=e))
${fuelMaterialPython}
rf0=b['pelletDiameter_m']/2; ro0=b['rodOuterDiameter_m']/2; ri0=ro0-b['cladThickness_m']
N=geom['rods']; L0=b['activeLength_m']/2
g0=ri0-rf0; area=geom['heatedArea_m2']; cellArea=geom['assemblyArea_m2']
relocation=.30*g0 if materialState=='beginning-of-life' else 0.
flow=geom['flowArea_m2']; perimeter=geom['wettedPerimeter_m']; dh=geom['hydraulicDiameter_m']
mf=geom['fuelMass_kg']/2; mc=geom['cladMass_kg']/2
${fuelGeometryPython}
water=[W(P=p,T=t) for p,t in zip(b['coolantPressures_MPa'],b['coolantTemperatures_K'])]
massflow=boundary['massflow_kg_s'] if boundary else b['power_W']/((water[2].h-water[0].h)*1000)
duties=boundary['cellHeat_W'] if boundary else [massflow*(water[j+1].h-water[j].h)*1000 for j in range(2)]
for j in range(2):check('actual coolant heat reciprocity '+str(j),massflow*(water[j+1].h-water[j].h)*1000,duties[j],atol=.05)
# A changed deposition is a prescribed-coolant material comparison, not a new connected heat balance.
duties=[q*depositedFraction for q in duties]
vp=pi*ri0**2*b['plenumLength_m']; gasConstant=b['fillPressure_Pa']*(vp+pi*(ri0**2-rf0**2)*2*L0)/300
tp=b['coolantTemperatures_K'][-1]+10
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
            geo=geometry(ts,pg,j,expanded); rf,ri,ro,length,dr,stress,solidRf=geo
            qp=duties[j]/N/length
            qg,*_=gap(ts,pg,geo,radiation)
            h,*_=convection(tw,j)
            rows += [(h*(tw-water[j+1].T)*2*pi*ro-qp)/qp,
                (ck(ti)-ck(tw)-qp*math.log(ro/ri)/(2*pi))/qp,
                (qg*2*pi*rf-qp)/qp,(fk(tc)-fk(tf)-qp/(4*pi))/qp]
            # CTF Eq435 retains annular gap plus relocated-crack gas, not discarded void.
            inv+=pi*(ri*ri-rf*rf)*length/((tf+ti)/2)
            if relocation:inv+=pi*(rf*rf-solidRf*solidRf)*length/fuelAreaMean(tf,tc)
        rows.append((pg*inv-gasConstant)/gasConstant)
        return rows
    result=root(residual,[590,620,755,1050,606,640,795,1120,4.2],tol=1e-10)
    if not result.success or max(abs(x) for x in residual(result.x))>1e-8:raise ValueError(str(result.message))
    pg=result.x[-1]*1e6; rows=[]
    for j in range(2):
        ts=result.x[4*j:4*j+4]; tw,ti,tf,tc=map(float,ts)
        if not 500<=tf<=tc<=2000 or not 300<=tw<=ti<=1000:raise ValueError('Material temperature domain exceeded')
        geo=geometry(ts,pg,j,expanded); rf,ri,ro,length,dr,stress,solidRf=geo; qp=duties[j]/N/length
        mechanicalGap=ri-(solidRf+.5*relocation)
        if mechanicalGap<=0:raise ValueError('Outside admitted noncontact mechanical state')
        if materialState=='beginning-of-life' and qp>=20000:raise ValueError('BOL relocation reference requires actual LHGR below20kW/m')
        h,re,pr=convection(tw,j)
        if tw>=W(P=b['coolantPressures_MPa'][j+1],x=0).T:raise ValueError('Nominal convection-only check reached saturation')
        qg,qr,jump,khe,hgap=gap(ts,pg,geo,radiation)
        def fuelT(x):return brentq(lambda t:fk(t)-fk(tf)-qp/(4*pi)*(1-x*x),tf-1e-8,tc+1e-8)
        def cladT(x):
            r=math.sqrt(ri*ri+x*(ro*ro-ri*ri))
            return brentq(lambda t:ck(t)-ck(tw)-qp/(2*pi)*math.log(ro/r),tw-1e-8,ti+1e-8)
        meanFuel=quad(lambda x:2*x*fuelT(x),0,1,epsabs=1e-7)[0]
        check('fuel gas mean via conductivity coordinate '+str(j),fuelAreaMean(tf,tc),meanFuel,atol=2e-6)
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
        check('relocation gas-volume partition '+str(j),pi*((ri*ri-rf*rf)+(rf*rf-solidRf*solidRf))*length,pi*(ri*ri-solidRf*solidRf)*length)
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
            thermallyExpandedSolidRadius_m=solidRf,mechanicalGap_um=mechanicalGap*1e6,
            thermalRelocation_um=relocation*1e6,mechanicalRelocation_um=.5*relocation*1e6,
            effectiveCrackGasVolumePerRod_m3=pi*(rf*rf-solidRf*solidRf)*length,
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
    materialState=materialState,depositedPowerFraction=depositedFraction,relocationScope='FRAPCON3.4 Eq2-141 BOL low-linear-rating branch only; hybrid with CTF material/mean-strain/gas models',
    packages=dict(python=platform.python_version(),scipy=scipy.__version__,iapws=iapws.__version__,numpy=np.__version__),
    coldGeometry=dict(rods=N,heatedArea_m2=area,flowArea_m2=flow,wettedPerimeter_m=perimeter,hydraulicDiameter_m=dh,
        coreFlowVolume_m3=flow*2*L0,radialGap_um=g0*1e6,assemblyPitch_m=b['latticeSide']*b['pitch_m'],
        grossBundleArea_m2=cellArea*b['assemblies'],fuelMass_kg=2*mf,cladMass_kg=2*mc),
    nominal=dict(massflow_kg_s=massflow,meanWallFlux_W_m2=b['power_W']*depositedFraction/area,meanLinearDuty_W_m=b['power_W']*depositedFraction/N/(2*L0)),
    hotGeometryComparison=dict(heatedArea_m2=hotArea,flowAreaWithFixedGuideAndPitch_m2=hotFlow,
        convectionUsesColdLattice=True,fullHydraulicExpansionQualified=False),
    base=base,blackbodyUpperBound=black,frozenColdGeometryComparison=cold,radiationOmission=radiation,checks=checks,
    empiricalFuelQualification=False,contactOrRelocationQualified=False,CHFQualification=False),allow_nan=False,indent=2))
`
export async function runFuelConstruction(document:string,python:string,actualBoundary?:FuelBoundary,materialState:FuelMaterialState='unrelocated',depositedFraction=1){
  materialStateSchema.parse(materialState)
  positive.parse(depositedFraction)
  if(depositedFraction!==1&&!actualBoundary)throw Error('Changed deposition requires an explicitly prescribed coolant boundary')
  const authored=parseFuelConstruction(document),boundary=actualBoundary?boundarySchema.parse(actualBoundary):null
  const input=boundary?{...authored,coolantPressures_MPa:boundary.coolantPressures_MPa,coolantTemperatures_K:boundary.coolantTemperatures_K}:authored
  const geometry=fuelGeometry(input)
  const child=Bun.spawn([python,'-c',calculation],{stdin:new Blob([JSON.stringify({basis:input,geometry,boundary,materialState,depositedFraction})]),stdout:'pipe',stderr:'pipe'})
  const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(exit!==0)throw Error(err||`Fuel reference failed: ${exit}`)
  return {inputSha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    geometrySha256:createHash('sha256').update(fuelGeometry.toString()).digest('hex'),
    boundarySha256:createHash('sha256').update(JSON.stringify(boundary)).digest('hex'),
    calculationSha256:createHash('sha256').update(calculation).digest('hex'),actualBoundary:boundary,...JSON.parse(out)}
}
if(import.meta.main){
  const [path,python,...extra]=process.argv.slice(2)
  if(!path||!python||extra.length)throw Error('Usage: bun reference-design-fuel-construction.ts <fuel-construction.md> <isolated-python>')
  console.log(JSON.stringify(await runFuelConstruction(await Bun.file(path).text(),python),null,2))
}
