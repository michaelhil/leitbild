/** Finite chemistry stock/mixing and frozen transfer-machine comparisons; no plant trajectory. */
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {z} from 'zod'
import {parseSelection,pressureExchange,exchangeTorque,streamLoss,backflowBrake} from './reference-design-service-pump-signed'
import {motorBudget} from './reference-design-rhr-signed-pump'
import {readServicePump} from './reference-design-service-pump-continuation'

const finite=z.number().finite(),positive=finite.positive(),nonnegative=finite.nonnegative()
const tank=z.object({area_m2:positive,initialVolume_m3:nonnegative,initial_ppm:nonnegative,stopHeight_m:nonnegative,resetHeight_m:nonnegative}).strict()
const schema=z.object({pressure_Pa:positive,temperature_K:positive,gravity_m_s2:positive,floor_m:finite,height_m:positive,
 WATER:tank,CONCENTRATE:tank,BLEND:tank,RECEIVER:tank,planningPrimaryMass_kg:positive,reserveTemperature_K:positive,reservePressure_Pa:positive,
 initialPrimary_ppm:positive,normalPrimary_ppm:positive,restartPrimary_ppm:positive,conditioningVolume_m3:positive,comparisonRate_kg_s:positive,
 transferFlow_kg_s:positive,transferRise_Pa:positive,hydraulicEfficiency:positive.max(1),motorEfficiency:positive.max(1),
 tracking_s:positive,coastdown_s:positive,metalCapacity_J_K:positive,caseContact_W_K:nonnegative,roomContact_W_K:nonnegative,
 isotopeFraction:positive.max(1),isotope10MolarMass_kg_mol:positive,isotope11MolarMass_kg_mol:positive,avogadro_mol:positive}).strict()
export function parseChemistryLifecycle(text:string){
 const records=[...text.matchAll(/^```reference-chemistry-lifecycle\s*\n([\s\S]*?)^```\s*$/gm)]
 if(records.length!==1)throw Error('Expected one reference-chemistry-lifecycle')
 const s=schema.parse(JSON.parse(records[0]![1]!))
 for(const name of ['WATER','CONCENTRATE','BLEND','RECEIVER'] as const){const t=s[name];if(t.initialVolume_m3>t.area_m2*s.height_m||t.stopHeight_m>s.height_m||t.resetHeight_m>s.height_m)throw Error('Tank physical range')}
 if(s.WATER.initial_ppm!==0||s.CONCENTRATE.initial_ppm<=s.restartPrimary_ppm||s.initialPrimary_ppm<=s.normalPrimary_ppm||s.BLEND.initialVolume_m3+s.conditioningVolume_m3>=s.BLEND.area_m2*s.BLEND.stopHeight_m||s.comparisonRate_kg_s>s.transferFlow_kg_s)throw Error('Inadmissible finite mission inputs')
 return s
}
/** Exact two finite, perfectly mixed carriers in delivered-mass coordinate. Not spatial primary mixing. */
export function serialMix(primaryMass:number,blendMass:number,primary:number,blend:number,source:number,mass:number){
 if(![primaryMass,blendMass,primary,blend,source,mass].every(Number.isFinite)||primaryMass<=0||blendMass<=0||mass<0||Math.min(primary,blend,source)<0)throw Error('Invalid carrier mixing inputs')
 const ep=Math.exp(-mass/primaryMass),eb=Math.exp(-mass/blendMass),d=blendMass-primaryMass
 const exponent=(mass/primaryMass)*(d/blendMass)
 const difference=d>0?eb*(-Math.expm1(-exponent)):ep*Math.expm1(exponent)
 const cross=d===0?(mass/primaryMass)*ep:blendMass/d*difference
 const cp=source+(primary-source)*ep+(blend-source)*cross,cb=source+(blend-source)*eb
 if(!Number.isFinite(cp)||!Number.isFinite(cb))throw Error('Unresolved mixing arithmetic')
 return {primary:cp,blend:cb}
}
export function mixingMass(primaryMass:number,blendMass:number,primary:number,blend:number,source:number,target:number){
 // A target beyond BOTH retained initial concentrations has one later crossing,
 // even when the initial BLEND donor first moves the primary the wrong way.
 if(!Number.isFinite(target)||target<0||target===source||!((target>Math.max(primary,blend)&&source>target)||(target<Math.min(primary,blend)&&source<target)))throw Error('Target not admitted on finite exchange crossing')
 let lo=0,hi=primaryMass
 while((serialMix(primaryMass,blendMass,primary,blend,source,hi).primary-target)*(primary-target)>0){hi*=2;if(!Number.isFinite(hi))throw Error('Unresolved exchange amount')}
 for(let i=0;i<100;i++){const mid=(lo+hi)/2;if((serialMix(primaryMass,blendMass,primary,blend,source,mid).primary-target)*(primary-target)>0)lo=mid;else hi=mid}
 return (lo+hi)/2
}
export function finiteStockBudget(s:ReturnType<typeof parseChemistryLifecycle>,rho:number){
 if(!Number.isFinite(rho)||rho<=0)throw Error('Invalid native stock density')
 if(s.conditioningVolume_m3<=0)throw Error('Mission requires actual isolated BLEND conditioning before remake crossing')
 const M=s.planningPrimaryMass_kg,Mb=s.BLEND.initialVolume_m3*rho,xd=mixingMass(M,Mb,s.initialPrimary_ppm,s.BLEND.initial_ppm,0,s.normalPrimary_ppm),
  bd=serialMix(M,Mb,s.initialPrimary_ppm,s.BLEND.initial_ppm,0,xd).blend,cond=s.conditioningVolume_m3*rho,
  bc=(bd*Mb+s.CONCENTRATE.initial_ppm*cond)/(Mb+cond),xr=mixingMass(M,Mb+cond,s.normalPrimary_ppm,bc,s.CONCENTRATE.initial_ppm,s.restartPrimary_ppm),
  br=serialMix(M,Mb+cond,s.normalPrimary_ppm,bc,s.CONCENTRATE.initial_ppm,xr).blend,
  xd2=mixingMass(M,Mb+cond,s.restartPrimary_ppm,br,0,s.normalPrimary_ppm),
  water=s.WATER.initialVolume_m3-(xd+xd2)/rho,concentrate=s.CONCENTRATE.initialVolume_m3-(xr+cond)/rho,receiver=s.RECEIVER.initialVolume_m3+(xd+xr+xd2)/rho
 return {dilutionMass_kg:xd,remakeMass_kg:xr,restartDilutionMass_kg:xd2,conditionedBlend_ppm:bc,waterRemaining_m3:water,concentrateRemaining_m3:concentrate,receiverVolume_m3:receiver,
  admissible:water>s.WATER.area_m2*s.WATER.stopHeight_m&&concentrate>s.CONCENTRATE.area_m2*s.CONCENTRATE.stopHeight_m&&receiver<s.RECEIVER.area_m2*s.RECEIVER.stopHeight_m}
}
export function transferDrive(s:ReturnType<typeof parseChemistryLifecycle>,machine:{referenceFluidPower_W:number,omega0:number,inertia_kg_m2:number},omega:number,request:number,load:number,available:boolean){
 const {referenceFluidPower_W:P0,omega0:w,inertia_kg_m2:J}=machine
 if(![P0,w,J,omega,request,load].every(Number.isFinite)||P0<=0||w<=0||J<=0||request<0||request>w)throw Error('Invalid source drive state')
 const torqueCap=1.5*1.01*P0/w,electricCap=1.5*1.01*P0/s.motorEfficiency
 let torque=available?Math.min(torqueCap,Math.max(0,load+J*(request-omega)/s.tracking_s)):0
 if(omega>0)torque=Math.min(torque,s.motorEfficiency*electricCap/omega)
 return {torque,electricCap,...motorBudget(torque,omega,s.motorEfficiency)}
}
export const chemistryLifecycleCalculation=String.raw`
import json,sys,math,platform
import CoolProp,scipy,numpy as np
from CoolProp.CoolProp import PropsSI as P
from scipy.linalg import expm
from scipy.optimize import brentq
d=json.load(sys.stdin);s=d['selection'];k=d['signed']['crossCoefficient'];checks=[]
def check(name,ok,**v):
 if not ok:raise ValueError((name,v))
 checks.append(dict(name=name,**v))
p=s['pressure_Pa'];T=s['temperature_K'];g=s['gravity_m_s2'];rho=P('D','P',p,'T',T,'Water');u=P('U','P',p,'T',T,'Water');h=P('H','P',p,'T',T,'Water')
N=s['isotopeFraction'];molar=N*s['isotope10MolarMass_kg_mol']+(1-N)*s['isotope11MolarMass_kg_mol'];atoms=s['avogadro_mol']*N/molar
stocks={}
for name in ['WATER','CONCENTRATE','BLEND','RECEIVER']:
 a=s[name];V=a['initialVolume_m3'];M=rho*V;depth=V/a['area_m2'];B=M*a['initial_ppm']*1e-6
 stocks[name]=dict(volume_m3=V,carrier_kg=M,U_J=M*u,PE_J=g*M*(s['floor_m']+depth/2),openEnergy_J=M*h+g*M*(s['floor_m']+depth/2),marker_kg_eq=B,N10=B*atoms,depth_m=depth,volumeBin_m3=.01*a['area_m2'])
 check(name+' native finite stock/caloric depth',M>=0 and math.isfinite(M*u) and depth<=s['height_m'])
charge=d['charging'];chargeRho=P('D','P',charge['inletPressure_MPa']*1e6,'T',charge['inletTemperature_C']+273.15,'Water')
geometry=d['geometry'];geometry.append(dict(owner='normal charging finite case plus discharge body',volume_m3=2*.05*charge['flow_kg_s']/chargeRho,water_kg=2*.05*charge['flow_kg_s']))
V=sum(q['volume_m3'] for q in geometry)+d['withdrawalDisplacementReserve_m3'];rmax=P('D','P',s['reservePressure_Pa'],'T',s['reserveTemperature_K'],'Water');Mmax=V*rmax
check('enumerated full-liquid native geometry is below planning mass, not runtime clamp',Mmax<s['planningPrimaryMass_kg'],volume_m3=V,density_kg_m3=rmax,fullLiquidCarrier_kg=Mmax)
Mp=s['planningPrimaryMass_kg'];Mb=stocks['BLEND']['carrier_kg'];c0=s['initialPrimary_ppm']*1e-6;ct=s['normalPrimary_ppm']*1e-6
def mix(Mb,cp,cb,cs,x):
 A=np.array([[-1/Mp,1/Mp,0],[0,-1/Mb,1/Mb],[0,0,0]])
 return expm(A*x)@np.array([cp,cb,cs])
xd=brentq(lambda x:mix(Mb,c0,stocks['BLEND']['marker_kg_eq']/Mb,0,x)[0]-ct,0,2*Mp,xtol=1e-7)
pd,bd,_=mix(Mb,c0,stocks['BLEND']['marker_kg_eq']/Mb,0,xd)
conditioning=rho*s['conditioningVolume_m3'];cc=s['CONCENTRATE']['initial_ppm']*1e-6;Mb2=Mb+conditioning;bc=(bd*Mb+conditioning*cc)/Mb2
check('real isolated BLEND receipt reverses initial wrong-sign remake',bd<ct and bc>ct and s['BLEND']['initialVolume_m3']+s['conditioningVolume_m3']<s['BLEND']['area_m2']*s['BLEND']['stopHeight_m'],retainedAfterDilution=bd,conditioned=bc)
xr=brentq(lambda x:mix(Mb2,pd,bc,cc,x)[0]-s['restartPrimary_ppm']*1e-6,0,2*Mp,xtol=1e-7)
pr,br,_=mix(Mb2,pd,bc,cc,xr)
# Retain the actual stronger BLEND. The second dilution initially raises primary
# concentration; locate its maximum and the later target crossing, not a preflush.
xpeak=brentq(lambda x:mix(Mb2,pr,br,0,x)[1]-mix(Mb2,pr,br,0,x)[0],0,Mp,xtol=1e-7)
peak,_,_=mix(Mb2,pr,br,0,xpeak)
xd2=brentq(lambda x:mix(Mb2,pr,br,0,x)[0]-ct,xpeak,2*Mp,xtol=1e-7)
pf,bf,_=mix(Mb2,pr,br,0,xd2)
check('retained stronger BLEND initially borates then crosses restart normal target',peak>pr and abs(pf-ct)<1e-12,peak_ppm=peak*1e6,peakDelivered_kg=xpeak)
total=xd+xr+xd2;receiverM=stocks['RECEIVER']['carrier_kg']+total;receiverB=Mp*c0+stocks['BLEND']['marker_kg_eq']+cc*(conditioning+xr)-Mp*pf-Mb2*bf
waterLeft=stocks['WATER']['carrier_kg']-xd-xd2;concentrateLeft=stocks['CONCENTRATE']['carrier_kg']-conditioning-xr
check('zero source retains acquired low reserve',waterLeft/rho>s['WATER']['area_m2']*s['WATER']['stopHeight_m'],remaining_m3=waterLeft/rho)
check('concentrate retains acquired low reserve',concentrateLeft/rho>s['CONCENTRATE']['area_m2']*s['CONCENTRATE']['stopHeight_m'],remaining_m3=concentrateLeft/rho)
Tsat=P('T','P',p,'Q',0,'Water');rhosat=P('D','P',p,'Q',0,'Water');receiverUpper=receiverM/rhosat
check('admitted atmospheric unfrozen liquid density above saturation lower bound',all(P('D','P',p,'T',float(tt),'Water')>=rhosat for tt in np.linspace(s['reserveTemperature_K'],Tsat-.001,33)))
check('finite receiver retains high-stop headroom even if every receipt is retained hot liquid',receiverUpper<s['RECEIVER']['area_m2']*s['RECEIVER']['stopHeight_m'],liquidUpperVolume_m3=receiverUpper,saturatedLiquidDensity_kg_m3=rhosat)
initialM=Mp+sum(x['carrier_kg'] for x in stocks.values());finalM=Mp+Mb2+receiverM+waterLeft+concentrateLeft
initialB=Mp*c0+sum(x['marker_kg_eq'] for x in stocks.values());finalB=Mp*pf+Mb2*bf+receiverB+cc*concentrateLeft
check('three stage carrier and marker conservation',abs(initialM-finalM)<1e-7 and abs(initialB-finalB)<1e-9,carrierDefect_kg=initialM-finalM,markerDefect_kg_eq=initialB-finalB)
check('capture-free N10 comparison uses same once-only transported seed',abs((initialB-finalB)*atoms)<1e-9*max(1,initialB*atoms))
adverse=dict(oldZeroSourceFails=bool(xd>16*rho),oneCycle400SourceCannotRestart=bool(xd+xd2>400*rho),old2000SourceCannotReach2000=bool(2000<=s['restartPrimary_ppm']),exhaustedZeroChangesTarget=bool(mix(Mb,c0,c0,0,16*rho)[0]>ct),unconditionedRemakeInitiallyDilutes=bool(bd<ct))
check('declared exhausted/wrong-source/conditioning contrasts retained',all(adverse.values()))
# Narrow pure-liquid cold reference machine and actual finite-height forward paths.
# Full wet/dry/reverse continuation remains the canonical signed-service owner.
m0=s['transferFlow_kg_s'];dp=s['transferRise_Pa'];eta=s['hydraulicEfficiency'];w0=d['signed']['rpm']*math.pi/30;sd=P('S','P',p,'T',T,'Water')
def state(pp,entropy=sd):return dict(p=pp,h=P('H','P',pp,'S',entropy,'Water'),rho=P('D','P',pp,'S',entropy,'Water'),s=entropy)
def G(a,pr):
 if pr>=a['p']:return 0.
 b=state(pr,a['s']);dh=a['h']-b['h']
 if dh < -1e-5:raise ValueError('Negative native liquid kinetic work')
 return b['rho']*math.sqrt(2*max(0,dh))
a=state(p);stage0=state(p+(1.25-k)*dp);out0=state(p+dp);P0=m0*(out0['h']-a['h'])/eta;H0=P0-m0*(stage0['h']-a['h']);Ci=m0/G(stage0,p+dp)
heatedH=stage0['h']+H0/m0;Se=P('S','P',p+dp,'H',heatedH,'Water');Ce=m0/G(dict(p=p+dp,h=heatedH,s=Se),p)
J=1.01*P0*s['coastdown_s']/w0**2
check('unchanged nominal pressure/efficiency positive internal loss',H0>0 and Ci>0 and Ce>0 and J>0)
flow=[]
def nativeHead(depth):
 if depth==0:return p
 return brentq(lambda pp:state(pp)['h']-a['h']-g*depth,p,p+rho*g*depth*1.001,xtol=1e-7)
for label,hs,hb,n in [('equal-reference',0,0,1),('maximum-lift',.1,3.6,1),('lower-source',.1,2.4,1),('limited-speed',.1,3.6,.5)]:
 ps=nativeHead(hs);prr=nativeHead(hb);donor=state(ps);rc=P('D','P',ps,'H',donor['h'],'Water')
 def evaluate(m):
  q=m/rc/(m0/rho);need=n*n+2*q*q;available=(ps-P('P','T',T,'Q',1,'Water'))/(rc*g);F=1 if need==0 else min(1,max(0,available/need))**2
  de=dp*(rc/rho)*F*n*(1.25*n-k*abs(q));pst=ps+de
  if pst<=prr:return 0.,None
  st=state(pst);heat=H0*(rc/rho)*F*n*n*abs(q)
  hh=st['h']+(heat/m if m>0 else H0*F*n*n/m0)
  def rates(pu):
   ext=dict(p=pu,h=hh,s=P('S','P',pu,'H',hh,'Water'))
   return Ci*G(st,pu),Ce*G(ext,prr)
  pu=brentq(lambda z:rates(z)[0]-rates(z)[1],prr,pst,xtol=1e-7);fi,fe=rates(pu)
  return fi,dict(m=m,n=n,F=F,suctionPressure_Pa=ps,deliveryPressure_Pa=prr,intermediatePressure_Pa=pu,availableNPSH_m=available,requiredNPSH_m=need,shaftPower_W=m*(st['h']-donor['h'])+heat,flowDefect_kg_s=fi-fe,sourceHeadEnthalpyDefect_J_kg=donor['h']-a['h']-g*hs,receiverHeadEnthalpyDefect_J_kg=state(prr)['h']-a['h']-g*hb,constantDensitySourcePressureDifference_Pa=p+rho*g*hs-ps,constantDensityReceiverPressureDifference_Pa=p+rho*g*hb-prr)
 cap0,_=evaluate(0)
 if cap0==0:flow.append(dict(label=label,m=0,meaning='actual head unavailable at this held speed'));continue
 mf=brentq(lambda m:m-evaluate(m)[0],1e-8,2*m0,xtol=1e-8);_,row=evaluate(mf);row['label']=label;flow.append(row)
 check(label+' native held series flow/pressure',abs(row['flowDefect_kg_s'])<1e-6 and row['requiredNPSH_m']<row['availableNPSH_m'])
check('maximum lift admits comparison rate as conditional capacity only',next(q['m'] for q in flow if q['label']=='maximum-lift')>s['comparisonRate_kg_s'])
check('low speed does not inherit nominal delivery',next(q['m'] for q in flow if q['label']=='limited-speed')<s['comparisonRate_kg_s'])
# Separate instantaneous failed-check reverse and retained dry/deadhead budgets.
# These do not stand in for advancing case/metal/supply fault trajectories.
pd=200000.;hd=P('H','P',pd,'T',T,'Water');ss=P('S','P',pd,'T',T,'Water');m=-m0/2;n=.5;q=m/m0
de=dp*n*(1.25*n-k*abs(q));ps=pd-de;hs=P('H','P',ps,'S',ss,'Water');dh=hs-hd;exchange=abs(m)*dh;mixHeat=H0*n*n*abs(q);brake=max(0,-2*exchange);paid=exchange+mixHeat+brake;hr=hs+(mixHeat+brake)/abs(m)
check('native reverse actual donor pays exchange and braking once',paid>0 and abs(abs(m)*(hr-hd)-paid)<1e-8 and P('S','P',p,'H',hr,'Water')>=ss)
packet=.1;B=packet*.002;paired=dict(carrierDefect_kg=-packet+packet,markerDefect_kg_eq=-B+B,energyDefect_J=-packet*hd+packet*hr-packet/abs(m)*paid,N10Defect=-B*atoms+B*atoms)
check('reverse paired donor marker/N10/total-enthalpy ledger',abs(paired['energyDefect_J'])<1e-9 and paired['carrierDefect_kg']==0 and paired['markerDefect_kg_eq']==0 and paired['N10Defect']==0)
gasrho=p/(287*T);dryDrag=.01*P0;dryChurn=.01*P0*gasrho/rho;deadheadHeat=.01*P0
check('dry/gas and deadhead retain positive body/case heating without useful stage',dryDrag>0 and dryChurn>0 and deadheadHeat>0)
machineContrary=dict(reverse=dict(m=m,n=n,donorPressure_Pa=pd,stagePressure_Pa=ps,work_J_kg=dh,mixHeat_W=mixHeat,brakeHeat_W=brake,paidFluid_W=paid,paired=paired),dry=dict(exchangeFactor=0,dragBody_W=dryDrag,churnBody_W=dryChurn),deadhead=dict(liquidCaseChurn_W=deadheadHeat),meaning='Native reverse fixed face and instantaneous positive retained loss budgets; no case purge, overload survival or coast/endurance trajectory')
headWork=(total+conditioning)*P0/m0;motorIdeal=headWork/s['motorEfficiency'];time=(total+conditioning)/s['comparisonRate_kg_s']
machine=dict(rho=rho,CdA_internal_m2=Ci,CdA_external_m2=Ce,referenceFluidPower_W=P0,rotorMixPower_W=H0,inertia_kg_m2=J,caseVolume_m3=.05*m0/rho,omega0=w0,
 nominalElectricWithDrag_W=1.01*P0/s['motorEfficiency'],maximumElectric_W=1.5*1.01*P0/s['motorEfficiency'],maximumTorque_Nm=1.5*1.01*P0/w0,bodyInitialU_J=s['metalCapacity_J_K']*(T-300),bodyCapacity_J_K=s['metalCapacity_J_K'])
mission=dict(dilutionMass_kg=xd,conditioningMass_kg=conditioning,remakeMass_kg=xr,restartDilutionMass_kg=xd2,restartPeak_ppm=peak*1e6,restartPeakDelivered_kg=xpeak,receiverCarrier_kg=receiverM,receiver40CComparisonVolume_m3=receiverM/rho,receiverLiquidUpper_m3=receiverUpper,
 waterRemaining_m3=waterLeft/rho,concentrateRemaining_m3=concentrateLeft/rho,afterDilutionBlend_ppm=bd*1e6,conditionedBlend_ppm=bc*1e6,afterRemakeBlend_ppm=br*1e6,receiverMarker_kg_eq=receiverB,
 afterRestartBlend_ppm=bf*1e6,comparisonElapsed_s=time,nominalSourceMachineWork_J=headWork,nominalSourceMotorElectric_J=motorIdeal,
 meaning='Conditional mass-duty budget; no imposed equal rates, thermostat, capture-free neutron authorization or achieved daylong support. Gross receipt mass bounds liquid volume with atmospheric saturated-liquid density; boiling export reduces carrier. Cases are excluded from serial comparison and retain their separate finite histories.')
print(json.dumps(dict(scope='Native finite stocks/geometry reserve, exact serial mixing budget, held cold liquid pump capacities only; no pressure/thermal/control trajectory or source admission',
 packages=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__),checks=checks,stocks=stocks,geometry=geometry,
 planning=dict(volume_m3=V,nativeFullLiquidMass_kg=Mmax,comparisonPrimaryMass_kg=Mp),mission=mission,adverse=adverse,machine=machine,machineContrary=machineContrary,flow=flow),allow_nan=False))
`
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
export async function runChemistryLifecycle(wiki:string,currentPath:string,coldPath:string,python:string){
 const owner=resolve(wiki,'systems/primary-coolant/inventory-and-chemistry.md'),feed=resolve(wiki,'systems/feedwater/equipment.md'),doc=await Bun.file(owner).text(),s=parseChemistryLifecycle(doc),signed=parseSelection(await Bun.file(feed).text())
 const cur=await Bun.file(currentPath).json(),cold=await Bun.file(coldPath).json()
 const positiveRow=(q:any)=>{if(!q||!Number.isFinite(q.volume_m3)||q.volume_m3<0||!Number.isFinite(q.water_kg)||q.water_kg<0)throw Error('Invalid retained native geometry');return {owner:q.owner,volume_m3:q.volume_m3,water_kg:q.water_kg}}
 const geometry=[positiveRow({...cur.mainPrimary,owner:'current main + housing'}),...cold.primaryRows.filter((q:any)=>!q.owner.startsWith('MAIN.')).map(positiveRow),...cold.otherNativeRows.filter((q:any)=>q.owner.startsWith('CMT.')||q.owner.startsWith('RHR.')).map(positiveRow),{owner:'full PZR free volume (replace, not add original liquid)',volume_m3:cold.coldPzr.volume_m3,water_kg:cold.coldPzr.regions.reduce((x:number,q:any)=>x+q.liquid_kg+q.steam_kg,0)}]
 if(cur.sourceAuthority!=='UNSELECTED'||!Number.isFinite(cur.consumedInput.geometry.expectedAddedPrimarySolid_m3))throw Error('Wrong retained parent scope')
 const charge=readServicePump(owner);if(charge.id!=='CHARGE')throw Error('Expected owned charging reference')
 const input={selection:s,signed,charging:{flow_kg_s:charge.flow_kg_s,inletPressure_MPa:charge.inletPressure_MPa,inletTemperature_C:charge.inletTemperature_C},geometry,withdrawalDisplacementReserve_m3:cur.consumedInput.geometry.expectedAddedPrimarySolid_m3},inputSHA=sha(JSON.stringify(input))
 const paths=[owner,feed,currentPath,coldPath,import.meta.path,resolve(import.meta.dir,'reference-design-service-pump-signed.ts'),resolve(import.meta.dir,'reference-design-rhr-signed-pump.ts'),resolve(import.meta.dir,'reference-design-service-pump-continuation.ts')],sources=await Promise.all(paths.map(async path=>({path,sha256:sha(await Bun.file(path).text())})))
 const run=Bun.spawn([python,'-c',chemistryLifecycleCalculation],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});run.stdin.write(JSON.stringify(input));run.stdin.end()
 const [out,err,exit]=await Promise.all([new Response(run.stdout).text(),new Response(run.stderr).text(),run.exited]);if(exit!==0)throw Error(err||'Native chemistry comparison failed')
 const r=JSON.parse(out),budget=finiteStockBudget(s,r.machine.rho),xd=budget.dilutionMass_kg,xr=budget.remakeMass_kg,xd2=budget.restartDilutionMass_kg
 if(Math.abs(xd-r.mission.dilutionMass_kg)>1e-5||Math.abs(xr-r.mission.remakeMass_kg)>1e-5||Math.abs(xd2-r.mission.restartDilutionMass_kg)>1e-5)throw Error('Independent analytic versus matrix exponential mismatch')
 const c=r.machine,w=c.omega0,axes=[]
 for(const n of [-1,0,1])for(const m of [-s.transferFlow_kg_s,0,s.transferFlow_kg_s]){const q=m/s.transferFlow_kg_s,de=pressureExchange(s.transferRise_Pa,1,signed.crossCoefficient,n,q,1),te=exchangeTorque(s.transferRise_Pa,1,signed.crossCoefficient,n,q,1,m,w,1/c.rho),loss=streamLoss(c.rotorMixPower_W,1,1,n*w,w,q),brake=backflowBrake(m,n*w,te),power=(te+loss.torque+brake.torque)*n*w;
  if(!Number.isFinite(power)||loss.power<0||brake.power<0)throw Error('Signed work arithmetic');axes.push({n,m,exchange_Pa:de,exchangePower_W:te*n*w,mixPower_W:loss.power,brakePower_W:brake.power,total_W:power})}
 const motors=[-2*w,-w,0,w,2*w].map(omega=>({omega,...transferDrive(s,c,omega,w,1.01*c.referenceFluidPower_W/w,true)}));if(motors.some(q=>q.heat<0||q.electric<0||q.electric>q.electricCap+1e-9||Math.abs(q.electric-q.shaft-q.heat)>1e-9))throw Error('Nonregenerative capped motor incidence')
 for(const q of sources)if(sha(await Bun.file(q.path).text())!==q.sha256)throw Error('Inputs changed during calculation')
 r.checks.push({name:'independent analytic versus matrix exponential serial mixture',dilutionDifference_kg:xd-r.mission.dilutionMass_kg,remakeDifference_kg:xr-r.mission.remakeMass_kg,restartDilutionDifference_kg:xd2-r.mission.restartDilutionMass_kg},{name:'signed axes retain paid exchange/mixing/braking and nonregenerative motor'})
 return {sourceSHA256:sha(await Bun.file(import.meta.path).text()),calculationSHA256:sha(chemistryLifecycleCalculation),consumedInputSHA256:inputSHA,consumedInput:input,sources,axes,motors,...r}
}
if(import.meta.main){const [wiki,current,cold,python,receipt,...extra]=Bun.argv.slice(2);if(!wiki||!current||!cold||!python||!receipt||extra.length)throw Error('Usage: <LD01> <current-parent.json> <cold-parent.json> <python> <receipt.json>');const r=await runChemistryLifecycle(wiki,current,cold,python);await Bun.write(receipt,JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify({receipt,checks:r.checks.length,planning:r.planning,mission:r.mission,machine:r.machine,flow:r.flow},null,2))}
