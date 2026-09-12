/** Offline steady spatial handoff. No plant runtime or new material equations. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { fuelGeometry, parseFuelConstruction } from './reference-design-fuel-construction'
import { fuelGeometryPython, fuelMaterialPython } from './reference-design-fuel-materials'

const finite = z.number().finite(), positive = finite.positive()
const point = z.object({half:z.union([z.literal(0),z.literal(1)]),referenceLength_m:positive,
  heat_W:positive,p_Pa:positive,T_K:positive,rho_kg_m3:positive,z_m:finite})
const digest=z.string().regex(/^[a-f0-9]{64}$/)
const receipt = z.object({accepted:z.literal(true),sourceSha256:digest,
  calculationSha256:digest,inputSha256:digest,
  coreGeometry:z.record(z.string(),finite),coreActiveLength_m:positive,
  result:z.object({coreFlow_kg_s:positive,sourceHalfHeat_W:z.tuple([positive,positive]),
    coreFaces:z.array(z.object({T_K:positive})).length(3),
    coreThermalQuadrature:z.object({'2':z.array(point).nonempty(),'4':z.array(point).nonempty(),'8':z.array(point).nonempty()})})})

export function parseDistributedFuelInput(document:string,artifact:unknown) {
  const basis=parseFuelConstruction(document),primary=receipt.parse(artifact),geometry=fuelGeometry(basis)
  if(primary.coreActiveLength_m!==basis.activeLength_m||JSON.stringify(Object.entries(primary.coreGeometry).sort())!==JSON.stringify(Object.entries(geometry).sort()))
    throw Error('Primary channel and radial fuel construction geometry differ')
  if(Math.abs(primary.result.sourceHalfHeat_W[0]+primary.result.sourceHalfHeat_W[1]-basis.power_W)>.05)
    throw Error('Source-fixed nominal handoff requires the same owned total heat')
  for(const points of Object.values(primary.result.coreThermalQuadrature)) {
    for(const half of [0,1] as const) {
      const subset=points.filter(p=>p.half===half)
      if(Math.abs(subset.reduce((a,p)=>a+p.referenceLength_m,0)-basis.activeLength_m/2)>1e-10)
        throw Error('Axial quadrature loses or duplicates reference length')
      if(Math.abs(subset.reduce((a,p)=>a+p.heat_W,0)-primary.result.sourceHalfHeat_W[half])>.05)
        throw Error('Axial quadrature does not conserve owned half-core heat')
    }
    if(points.some((p,i)=>p.z_m< -basis.activeLength_m/2||p.z_m>basis.activeLength_m/2||i>0&&p.z_m<=points[i-1]!.z_m))
      throw Error('Axial points must follow the actual ordered heated channel')
  }
  return {basis,geometry,primary}
}

export const distributedFuelPython=String.raw`
import sys,json,math,time,platform
import numpy as np,scipy,iapws
from scipy.optimize import root,brentq
from scipy.integrate import quad
from iapws import IAPWS97 as W
d=json.load(sys.stdin);b=d['basis'];geom=d['geometry'];primary=d['primary']['result'];pi=math.pi
started=time.perf_counter();checks=[];N=geom['rods'];Ltotal=b['activeLength_m']
${fuelMaterialPython}
rf0=b['pelletDiameter_m']/2;ro0=b['rodOuterDiameter_m']/2;ri0=ro0-b['cladThickness_m'];relocation=.3*(ri0-rf0)
L0=0.
${fuelGeometryPython}
vp=pi*ri0**2*b['plenumLength_m'];tp=primary['coreFaces'][-1]['T_K']+10
nR=b['fillPressure_Pa']*(vp+pi*(ri0**2-rf0**2)*Ltotal)/300
massflow=primary['coreFlow_kg_s'];flux=massflow/geom['flowArea_m2'];dh=geom['hydraulicDiameter_m']
def local(point,pg,radiation):
    global L0
    L0=point['referenceLength_m'];tb=point['T_K'];p=point['p_Pa']/1e6;power=point['heat_W']
    def calc(v):
        tw,ti,tf,tc=v;geo=geometry(v,pg,0,externalPressure_MPa=p)
        rf,ri,ro,length,dr,stress,solidRf=geo;qp=power/N/length
        fluid=W(P=p,T=(tb+tw)/2);re=flux*dh/fluid.mu;pr=fluid.cp*1000*fluid.mu/fluid.k
        if re<10000 or not .6<pr<160:raise ValueError('Outside selected liquid convection range')
        h=.023*re**.8*pr**.4*fluid.k/dh;qg,qr,*_=gap(v,pg,geo,radiation)
        residual=np.array([(h*(tw-tb)*2*pi*ro-qp)/qp,
            (ck(ti)-ck(tw)-qp*math.log(ro/ri)/(2*pi))/qp,
            (qg*2*pi*rf-qp)/qp,(fk(tc)-fk(tf)-qp/(4*pi))/qp])
        return residual,geo,qp,h,re,pr,qr/qg
    solved=root(lambda v:calc(v)[0],[tb+12,tb+30,tb+125,tb+410],tol=1e-10)
    rr,geo,qp,h,re,pr,radiationFraction=calc(solved.x);tw,ti,tf,tc=map(float,solved.x)
    if not np.all(np.isfinite(solved.x)) or max(abs(rr))>1e-8:raise ValueError('Local radial equations did not close')
    rf,ri,ro,length,dr,stress,solidRf=geo
    mechanicalGap=ri-(solidRf+.5*relocation)
    if not 500<=tf<=tc<=2000 or not 300<=tw<=ti<=1000:raise ValueError('Local material range exceeded')
    if mechanicalGap<=0 or qp>=20000:raise ValueError('Local open-gap/BOL linear-rating branch exceeded')
    if tw>=W(P=p,x=0).T:raise ValueError('Local convection-only surface reached saturation')
    gasIntegral=pi*(ri*ri-rf*rf)*length/((tf+ti)/2)+pi*(rf*rf-solidRf*solidRf)*length/fuelAreaMean(tf,tc)
    return dict(v=[tw,ti,tf,tc],geo=list(geo),qp=qp,gasIntegral=gasIntegral,localResidual=float(max(abs(rr))),
        achievedWallPower_W=N*length*2*pi*ro*h*(tw-tb),Re=re,Pr=pr,radiationFraction=radiationFraction,
        mechanicalGap_m=mechanicalGap)
def solve(points,radiation):
    def gasBalance(pg):
        return pg*(vp/tp+sum(local(p,pg,radiation)['gasIntegral'] for p in points))/nR-1
    # Positive gas inventory; fixed physical bracket, no state clipping/automatic expansion.
    pg=brentq(gasBalance,2e6,8e6,xtol=1e-4,rtol=1e-12)
    rows=[]
    for p in points:
        r=local(p,pg,radiation);tw,ti,tf,tc=r['v'];rf,ri,ro,length,*_=r['geo'];qp=r['qp']
        def fuelT(x):return brentq(lambda t:fk(t)-fk(tf)-qp/(4*pi)*(1-x*x),tf-1e-8,tc+1e-8)
        def cladT(x):return brentq(lambda t:ck(t)-ck(tw)-qp/(2*pi)*math.log(ro/math.sqrt(ri*ri+x*(ro*ro-ri*ri))),tw-1e-8,ti+1e-8)
        mf=geom['fuelMass_kg']*p['referenceLength_m']/Ltotal;mc=geom['cladMass_kg']*p['referenceLength_m']/Ltotal
        ef=mf*quad(lambda x:2*x*(hf(fuelT(x))-hf(300)),0,1,epsabs=1e-5)[0]
        ec=mc*quad(lambda x:hc(cladT(x)),0,1,epsabs=1e-5)[0]
        mean=quad(lambda x:2*x*fuelT(x),0,1,epsabs=1e-7)[0]
        rows.append(dict(**p,Twall_K=tw,TcladInner_K=ti,TfuelSurface_K=tf,TfuelCenter_K=tc,
            fuelMass_kg=mf,cladMass_kg=mc,fuelMean_K=mean,fuelSensibleEnergy_J=ef,cladSensibleEnergy_J=ec,
            hotLength_m=length,radialGap_m=ri-rf,mechanicalGap_m=r['mechanicalGap_m'],
            wallHeatResidual_W=r['achievedWallPower_W']-p['heat_W'],localResidual=r['localResidual'],
            linePower_W_m=qp,radiationFraction=r['radiationFraction'],Re=r['Re'],Pr=r['Pr']))
    ef=sum(r['fuelSensibleEnergy_J'] for r in rows);ec=sum(r['cladSensibleEnergy_J'] for r in rows)
    return dict(heliumPressure_Pa=pg,gasBalance=gasBalance(pg),points=len(points),rows=rows,
        fuelSensibleEnergy_J=ef,cladSensibleEnergy_J=ec,solidEnergy_J=ef+ec,
        fuelMassMean_K=sum(r['fuelMass_kg']*r['fuelMean_K'] for r in rows)/geom['fuelMass_kg'],
        moderatorVolumeMean_K=sum(p['referenceLength_m']*p['T_K'] for p in points)/Ltotal,
        moderatorVolumeMeanDensity_kg_m3=sum(p['referenceLength_m']*p['rho_kg_m3'] for p in points)/Ltotal,
        wallHeatResidual_W=sum(r['wallHeatResidual_W'] for r in rows),
        maximumLocalHeatResidual_W=max(abs(r['wallHeatResidual_W']) for r in rows),
        maximumFuelTemperature_K=max(r['TfuelCenter_K'] for r in rows),
        minimumMechanicalGap_m=min(r['mechanicalGap_m'] for r in rows))
cases={n:solve(points,0.) for n,points in primary['coreThermalQuadrature'].items()}
fine=cases['8'];black=solve(primary['coreThermalQuadrature']['8'],1.)
differences=[]
for n in ['2','4']:
    v=cases[n]
    differences.append(dict(order=int(n),solidEnergyRelative=abs(v['solidEnergy_J']/fine['solidEnergy_J']-1),
        fuelMean_K=abs(v['fuelMassMean_K']-fine['fuelMassMean_K']),moderatorMean_K=abs(v['moderatorVolumeMean_K']-fine['moderatorVolumeMean_K']),
        heliumPressureRelative=abs(v['heliumPressure_Pa']/fine['heliumPressure_Pa']-1)))
radiation=dict(maximumFraction=max(r['radiationFraction'] for r in black['rows']),
    maximumCenterChange_K=max(abs(a['TfuelCenter_K']-c['TfuelCenter_K']) for a,c in zip(fine['rows'],black['rows'])),
    maximumGapDropChange_K=max(abs((a['TfuelSurface_K']-a['TcladInner_K'])-(c['TfuelSurface_K']-c['TcladInner_K'])) for a,c in zip(fine['rows'],black['rows'])))
# Numerical spatial projection screens, not physical model accuracy or transient acceptance.
projection=all(r['solidEnergyRelative']<1e-5 and r['fuelMean_K']<.01 and r['moderatorMean_K']<.01 and r['heliumPressureRelative']<1e-5 for r in differences)
radOK=radiation['maximumFraction']<.02 and radiation['maximumCenterChange_K']<5 and radiation['maximumGapDropChange_K']<5
accepted=projection and radOK and all(r['maximumLocalHeatResidual_W']<1 and abs(r['wallHeatResidual_W'])<10 and abs(r['gasBalance'])<1e-9 for r in cases.values())
print(json.dumps(dict(accepted=bool(accepted),scope='Steady source-fixed physical-channel radial handoff; no PZR, transient, hot-channel or whole-plant baseline qualification',
    cases=cases,projectionDifferences=differences,radiationOmission=radiation,projectionAccepted=projection,radiationAccepted=radOK,
    packages=dict(python=platform.python_version(),scipy=scipy.__version__,numpy=np.__version__,iapws=iapws.__version__),
    wallSeconds=time.perf_counter()-started),allow_nan=False))
`

export async function runDistributedFuel(document:string,artifact:unknown,python:string) {
  const input=parseDistributedFuelInput(document,artifact),hash=(v:string)=>createHash('sha256').update(v).digest('hex')
  const source=await Bun.file(import.meta.path).text(),child=Bun.spawn([python,'-c',distributedFuelPython],{
    stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(await Bun.file(import.meta.path).text()!==source)throw Error('Calculation source changed while executing')
  if(code!==0)throw Error(err||'Distributed radial reference failed')
  return {sourceSha256:hash(source),calculationSha256:hash(distributedFuelPython),inputSha256:hash(JSON.stringify(input)),
    primaryArtifactSha256:hash(JSON.stringify(artifact)),...JSON.parse(out)}
}
if(import.meta.main) {
  const [doc,artifact,python,...extra]=Bun.argv.slice(2)
  if(!doc||!artifact||!python||extra.length)throw Error('Usage: distributed-fuel.ts <fuel.md> <primary-profile.json> <research-python>')
  console.log(JSON.stringify(await runDistributedFuel(await Bun.file(doc).text(),await Bun.file(artifact).json(),python),null,2))
}
