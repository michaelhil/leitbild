/** Offline PRHR hydraulic/measurement selection, not an installed plant model. */
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {parseObservationFixtureBasis} from './reference-design-observations'

const positive=z.number().finite().positive()
export function parsePrhrMeterBasis(text:string) {
  const blocks=[...text.matchAll(/^```reference-prhr-meter\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Exactly one PRHR meter basis required')
  return z.object({pressure_MPa:positive,hot_C:z.number().finite(),pool_C:z.number().finite(),
    gravity_m_s2:positive,columnHeight_m:positive,primaryConductance_W_K:positive,poolConductance_W_K:positive,
    forcedDifferential_Pa:z.number().finite(),calibrationDensity_kg_m3:positive}).strict().refine(b=>b.hot_C>b.pool_C,'Hot fixture must exceed pool temperature').parse(JSON.parse(blocks[0]![1]!))
}
export function prhrResistance(dp:number,x:number,rho:number,rhoCal:number,mRef:number,dpMeter:number,dpTotal:number) {
  if(![dp,x,rho,rhoCal,mRef,dpMeter,dpTotal].every(Number.isFinite)||x<0||x>1||rho<=0||rhoCal<=0||mRef<=0||dpMeter<=0||dpTotal<=dpMeter)
    throw Error('Finite physical density, opening and positive remaining resistance required')
  // Algebraically identical to sqrt(dp/[Rm+Rc/x²]), without 1/x² at closure.
  const m=Math.sign(dp)*mRef*x*Math.sqrt(Math.abs(dp)*rho/(rhoCal*(dpMeter*x*x+dpTotal-dpMeter)))
  const meterDP=dpMeter*m*Math.abs(m)/(mRef*mRef)*rhoCal/rho
  return {flow_kg_s:m,meterDP_Pa:meterDP,controlledDP_Pa:dp-meterDP,
    indicatedFlow_kg_s:Math.sign(meterDP)*mRef*Math.sqrt(Math.abs(meterDP)/dpMeter),
    meterDissipation_W:meterDP*m/rho,controlledDissipation_W:(dp-meterDP)*m/rho}
}

export const prhrMeterPython=String.raw`
import json,sys,math,platform
import iapws,scipy
from iapws import IAPWS97
from scipy.optimize import brentq
d=json.load(sys.stdin);b=d['basis'];meter=d['meter']
p=b['pressure_MPa'];Th=b['hot_C'];Tp=b['pool_C'];g=b['gravity_m_s2'];H=b['columnHeight_m']
gp=b['primaryConductance_W_K'];gs=b['poolConductance_W_K'];G=1/(1/gp+1/gs)
mr=meter['referenceFlow_kg_s'];D=meter['totalReferenceDrop_Pa'];Dm=meter['meterDrop_Pa']
hot=IAPWS97(P=p,T=Th+273.15)
def water(T):
    q=IAPWS97(P=p,T=T+273.15)
    if q.x!=0:raise ValueError('Single-phase liquid fixture required')
    return q
water(Th);water(Tp)
def solve(dp,x,new,rhoCal=None):
    def values(T):
        cold=water(T);head=dp+g*H*(cold.rho-hot.rho)
        if head<0:raise ValueError('Forward thermal fixture requires forward head; reversed hydraulics tested separately')
        m=(mr*x*math.sqrt(head*cold.rho/(rhoCal*(Dm*x*x+D-Dm))) if new else x*mr*math.sqrt(head/D))
        Q=G*(T-Tp);res=m*(hot.h-cold.h)*1000-Q
        return cold,head,m,Q,res
    T=brentq(lambda T:values(T)[4],Tp,Th,xtol=1e-11)
    cold,head,m,Q,res=values(T);wall=T-Q/gp
    return dict(outlet_C=T,outletDensity_kg_m3=cold.rho,flow_kg_s=m,wall_C=wall,heatToPool_W=Q,
      availableHead_Pa=head,buoyancyHead_Pa=head-dp,thermalResidual_W=res,
      primaryWallResidual_W=gp*(T-wall)-Q,poolWallResidual_W=gs*(wall-Tp)-Q,
      terminalDifferential_Pa=dp,opening=x)
old=solve(0,1,False);rhoCal=b['calibrationDensity_kg_m3']
if abs(old['outletDensity_kg_m3']-rhoCal)>1e-8:raise ValueError('Published calibration no longer matches its immutable sizing fixture; explicit reidentification required')
cases=[]
for name,dp,x in [('buoyancy',0,1),('forced',b['forcedDifferential_Pa'],1),('partial_buoyancy',0,.5),('partial_forced',b['forcedDifferential_Pa'],.5)]:
    prior=solve(dp,x,False);current=solve(dp,x,True,rhoCal)
    m=current['flow_kg_s'];rho=current['outletDensity_kg_m3'];dpM=Dm*m*abs(m)/mr**2*rhoCal/rho
    current.update(meterDP_Pa=dpM,controlledDP_Pa=current['availableHead_Pa']-dpM,
      indicatedFlow_kg_s=math.copysign(mr*math.sqrt(abs(dpM)/Dm),dpM),
      meterDissipation_W=dpM*m/rho)
    cases.append(dict(name=name,old=prior,selected=current,flowChange_percent=100*(m/prior['flow_kg_s']-1),
      dutyChange_W=current['heatToPool_W']-prior['heatToPool_W']))
print(json.dumps(dict(calibration=dict(pressure_MPa=p,outlet_C=old['outlet_C'],density_kg_m3=rhoCal,
  basis='Immutable original buoyancy hot-point; never recalibrated in a running or copied state'),cases=cases,
  dependencies=dict(python=platform.python_version(),iapws=iapws.__version__,scipy=scipy.__version__),
  scope='Stationary single-phase imposed-boundary PRHR fixtures; no connected network, inertia, boiling or cooling qualification'),allow_nan=False))
`

export async function runPrhrMeter(owner:string,observationOwner:string,python:string) {
  const source=await Bun.file(import.meta.path).text()
  const basis=parsePrhrMeterBasis(await Bun.file(owner).text())
  const observations=parseObservationFixtureBasis(await Bun.file(observationOwner).text())
  const meter=observations.meters.find(m=>m.name==='PRHR')!
  if(meter.totalReferenceDrop_Pa<=meter.meterDrop_Pa)throw Error('Positive non-meter path required')
  const input={basis,meter},hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const child=Bun.spawn([python,'-c',prhrMeterPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(status)throw Error(err)
  if(await Bun.file(import.meta.path).text()!==source)throw Error('Calculation source changed during reference execution')
  const solved=JSON.parse(out),rho=solved.calibration.density_kg_m3
  const signedChecks=[0,.001,.5,1].flatMap(opening=>[-20000,0,20000].flatMap(dp=>[rho,.75*rho].map(localDensity=>({opening,availableHead_Pa:dp,localDensity_kg_m3:localDensity,
    ...prhrResistance(dp,opening,localDensity,rho,meter.referenceFlow_kg_s,meter.meterDrop_Pa,meter.totalReferenceDrop_Pa)}))))
  return {sourceSha256:hash(source),calculationSha256:hash(prhrMeterPython),inputSha256:hash(JSON.stringify(input)),input,...solved,signedChecks}
}
if(import.meta.main){const [owner,observationOwner,python,...rest]=process.argv.slice(2);if(!owner||!observationOwner||!python||rest.length)throw Error('Usage: prhr-meter <PRHR owner> <observation owner> <python>');console.log(JSON.stringify(await runPrhrMeter(owner,observationOwner,python),null,2))}
