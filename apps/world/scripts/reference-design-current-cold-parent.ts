/** Current ORIGINAL physical cold inventories only; not a source or plant solver. */
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {z} from 'zod'
import {parseControlAbsorber,controlAbsorberGeometry} from './reference-design-control-absorber'
import {parseTransferAttachment,parseTransferGates,transferAttachmentChecks} from './reference-design-fuel-transfer'
import {parseFuelHandling,fuelHandlingChecks,b4cCaloric} from './reference-design-fuel-handling'
import {parseFuelConstruction} from './reference-design-fuel-construction'
import {coldParentCalculation,coldHydrostaticInventoryPython} from './reference-design-cold-parent'
import {guideParentCalculation} from './reference-design-guide-parent'
import {parseColdPressure} from './reference-design-cold-pressure'
import {parseHeadPool} from './reference-design-head-pool'
import {solid304Python} from './reference-design-pressurizer-heater-contact'
import {parseChemistryLifecycle} from './reference-design-chemistry-lifecycle'
import {parseChargingPressure} from './reference-design-charging-pressure'
import {readServicePump} from './reference-design-service-pump-continuation'

const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
const positive=z.number().finite().positive(),point=z.tuple([z.number().finite(),z.number().finite(),z.number().finite()])
const temperature=positive.min(290).max(1600)
const schema=z.object({primaryAbsorberRatio:z.literal(.002),primaryMetalTemperature_K:temperature,parkedToolTemperature_K:temperature,torqueToolPark_m:point,grapplePark_m:point}).strict()
export function parseCurrentColdParent(document:string){
 const a=[...document.matchAll(/^```reference-current-cold-parent\s*\n([\s\S]*?)^```\s*$/gm)]
 if(a.length!==1)throw Error('Expected one reference-current-cold-parent')
 return schema.parse(JSON.parse(a[0]![1]!))
}
type Area={name:string,lo:number,hi:number,area:number}
export function currentColdGeometry(c:ReturnType<typeof parseControlAbsorber>,a:ReturnType<typeof parseTransferAttachment>,
 f:ReturnType<typeof parseFuelConstruction>,h:ReturnType<typeof parseFuelHandling>,gates:ReturnType<typeof parseTransferGates>,
 head:ReturnType<typeof parseHeadPool>,s:ReturnType<typeof parseCurrentColdParent>){
 const cg=controlAbsorberGeometry(c,f,h),fg=fuelHandlingChecks(h,f),ag=transferAttachmentChecks(a,c,f,h).geometry,
  N=c.clusters,bodyA=cg.rodlets*Math.PI*c.bodyDiameter_m**2/4,stemA=N*Math.PI*c.stemDiameter_m**2/4,
  stubBottom=c.spiderBottom_m+c.spiderHeight_m-a.stubLength_m,
  half=a.keyWidth_m/2,rb=a.hubBore_m/2,
  strip=2*(half*Math.sqrt(rb*rb-half*half)+rb*rb*Math.asin(half/rb)),
  extraSlots=a.keyEnvelopeDiameter_m*a.keyWidth_m-strip,
  hubA=N*(Math.PI*(.02**2-rb**2)-extraSlots),hubV=hubA*(c.spiderBottom_m+c.spiderHeight_m-a.hubLandBottom_m),
  frameV=cg.moving.spider_kg/c.steelDensity_kg_m3-hubV
 // This is ONE declared seated FA-top/spider-seat plane. Reconcile only its
 // differently evaluated floating expression; do not merge real small gaps.
 if(Math.abs(fg.freshGeometry.upper.boreTop_m-c.spiderBottom_m)>4*Number.EPSILON*Math.max(1,Math.abs(c.spiderBottom_m)))
  throw Error('Declared seated FA top and spider-seat plane disagree')
 const faTop_m=c.spiderBottom_m
 if(!(half<rb&&extraSlots>0&&hubA>0&&frameV>0))throw Error('Actual hub/key/frame partition invalid')
 const intruders:Area[]=[
  {name:'1248 actual bodies',lo:c.insertedBodyBottom_m,hi:c.insertedBodyBottom_m+c.bodyLength_m,area:bodyA},
  {name:'redistributed porous spider remainder',lo:c.spiderBottom_m,hi:c.spiderBottom_m+c.spiderHeight_m,area:frameV/c.spiderHeight_m},
  {name:'actual hub land minus bore/key slots',lo:a.hubLandBottom_m,hi:c.spiderBottom_m+c.spiderHeight_m,area:hubA},
  {name:'52 stem plus lower stubs',lo:stubBottom,hi:c.spiderBottom_m+c.spiderHeight_m+c.stemLength_m,area:stemA},
  {name:'two opposed lugs per stem',lo:a.lugBottom_m,hi:a.lugBottom_m+a.lugHeight_m,area:N*2*a.lugWidth_m*(a.lugOuterRadius_m-c.stemDiameter_m/2)},
  {name:'annular shoulders',lo:a.shoulderBottom_m,hi:a.shoulderBottom_m+a.shoulderHeight_m,area:N*Math.PI*((a.shoulderDiameter_m/2)**2-(c.stemDiameter_m/2)**2)},
  // HJT pads lie outside the actual FA external-water support. Their literal
  // material/contact remains owned, but no unowned peripheral water is added
  // and no Core.2 water is removed to emulate that omitted space.
  {name:'two CET pads',lo:2.015-a.padHeight_m/2,hi:2.015+a.padHeight_m/2,area:2*ag.padEach_m3/a.padHeight_m}]
 const gateRows=gates.sills_m.map((lo,i)=>({name:i===0?'WELL':'POOL',lo,hi:gates.top_m,area:gates.width_m*gates.thickness_m,
  mass_kg:gates.width_m*gates.thickness_m*(gates.top_m-lo)*gates.steelDensity_kg_m3}))
 const envelope:Area[]=[
  {name:'head entire slab including primary holes',lo:c.headBottom_m,hi:c.headBottom_m+c.headThickness_m,area:c.headGrossArea_m2},
  {name:'main closed housing outer envelope',lo:c.headBottom_m+c.headThickness_m,hi:c.housingTop_m,area:N*Math.PI*c.housingOD_m**2/4},
  {name:'housing caps outer envelope',lo:c.housingTop_m,hi:c.housingTop_m+c.housingCapHeight_m,area:N*Math.PI*c.housingOD_m**2/4},
  {name:'neck outer envelope',lo:c.housingTop_m+c.housingCapHeight_m,hi:c.neckTop_m+c.neckCapHeight_m,area:N*Math.PI*c.neckOD_m**2/4},
  {name:'external annular jacks',lo:cg.head.jackBottom_m,hi:cg.head.jackTop_m,area:cg.head.jackVolume_m3/(cg.head.jackTop_m-cg.head.jackBottom_m)}]
 const radius=Math.sqrt(c.headGrossArea_m2/Math.PI),shaftTop=s.torqueToolPark_m[2]+a.toolLength_m,
  toolTop=s.grapplePark_m[2]+a.toolHeadHeight_m
 if(s.torqueToolPark_m[2]<=head.bayRim_m||s.grapplePark_m[2]<=head.bayRim_m||shaftTop>head.gantryTop_m||toolTop>head.gantryTop_m||
  Math.hypot(s.torqueToolPark_m[0]-head.headCradleX_m,s.torqueToolPark_m[1])<=radius+a.toolDiameter_m/2||
  Math.hypot(s.grapplePark_m[0]-head.headCradleX_m,s.grapplePark_m[1])<=radius+a.toolHeadWidth_m*Math.SQRT2/2||
  Math.hypot(s.grapplePark_m[0]-s.torqueToolPark_m[0],s.grapplePark_m[1]-s.torqueToolPark_m[1])<=a.toolDiameter_m/2+a.toolHeadWidth_m*Math.SQRT2/2)
  throw Error('Parked apparatus conflicts with cradle, rim, each other or local roof')
 const metal=[
  {name:'body304',mass_kg:cg.moving.bodySteel_kg,T:s.primaryMetalTemperature_K},
  {name:'spiders',mass_kg:cg.moving.spider_kg,T:s.primaryMetalTemperature_K},
  {name:'stems with stub/lugs/shoulders',mass_kg:ag.headCapturedStem_kg,T:s.primaryMetalTemperature_K},
  {name:'head/housing/collars/jacks',mass_kg:cg.head.attachedTotal_kg,T:s.primaryMetalTemperature_K},
  {name:'four pads',mass_kg:4*ag.padEach_kg,T:s.primaryMetalTemperature_K},
  ...gateRows.map(q=>({name:q.name+'.GATE',mass_kg:q.mass_kg,T:head.cnvTemperature_K})),
  {name:'torque shaft',mass_kg:ag.toolMass_kg,T:s.parkedToolTemperature_K},
  {name:'porous FA tool',mass_kg:a.toolHead_kg,T:s.parkedToolTemperature_K},
  {name:'gantry/brake/cradle',mass_kg:head.gantryMetal_kg,T:300},
  {name:'head separator wall',mass_kg:head.separatorMetal_kg,T:head.separatorTemperature_K},
  {name:'access shutter',mass_kg:head.accessPlateMass_kg,T:head.cnvTemperature_K},
  {name:'pool rack skins',mass_kg:h.rackSide**2*fg.rack.oneSleeveSkin_kg,T:head.cnvTemperature_K}]
 const b4c=[{name:'actual bodies',mass_kg:cg.moving.b4c_kg,T:s.primaryMetalTemperature_K},
  {name:'pool rack panels',mass_kg:h.rackSide**2*fg.rack.oneSleeveMatrix_kg,T:head.cnvTemperature_K}].map(q=>({...q,...b4cCaloric(q.T,h.b4cMolarMass_kg_mol)}))
 return {intruders,envelope,gateRows,metal,b4c,faTop_m,bodyArea_m2:bodyA,hubVolume_m3:hubV,frameVolume_m3:frameV,
  expectedAddedPrimarySolid_m3:cg.poses[0]!.totalMovingDisplacement_m3+ag.addedStemPerCluster_m3*N+2*ag.padEach_m3,
  housing:{mainArea:N*Math.PI*c.housingID_m**2/4,neckArea:N*Math.PI*c.neckID_m**2/4,
   collarArea:N*Math.PI*(c.collarOD_m**2-c.collarID_m**2)/4,collarBottoms:c.collarBottoms_m,collarHeight:c.collarHeight_m,
   mainLo:c.headBottom_m,mainHi:c.housingTop_m,neckHi:c.neckTop_m},
  rackDisplacement_m3:fg.rack.totalSleeveDisplacement_m3,grossBayVolumes:fg.grossVolumes,
  tools:{shaftVolume_m3:ag.toolVolume_m3,toolVolume_m3:a.toolHead_kg/c.steelDensity_kg_m3,shaftTop_m:shaftTop,toolTop_m:toolTop},
  spring_J:N*.5*c.gapSpring_N_m*c.gapStroke_m**2}
}

export const currentColdParentCalculation=String.raw`
import json,sys,math,platform
import numpy as np,scipy,CoolProp
from scipy.integrate import solve_ivp,quad
from scipy.optimize import brentq
from CoolProp.CoolProp import PropsSI as P
${solid304Python}
d=json.load(sys.stdin);g=d['gravity'];p0=d['anchor']['pressure_Pa'];T0=d['anchor']['temperature_K'];z0=d['anchor']['elevation_m'];checks=[]
def require(name,ok,**v):
 if not ok:raise ValueError((name,v))
 checks.append(dict(name=name,**v))
${coldHydrostaticInventoryPython}
G=d['geometry'];fg=d['fresh'];H=G['housing'];N=d['ratio'];intruders=G['intruders']
def cuts(lo,hi,objects):return sorted(set([lo,hi]+[z for q in objects for z in [q['lo'],q['hi']] if lo<z<hi]))
def areaAt(z,objects):return sum(q['area'] for q in objects if q['lo']<z<q['hi'])
def native(name,lo,hi,base,objects,field=mainField,ratio=None):
 points=cuts(lo,hi,objects);out=[]
 for i,(a,b) in enumerate(zip(points,points[1:])):
  A=base-areaAt((a+b)/2,objects);require(name+' positive actual area '+str(i),A>0)
  out.append(region(name+'.'+str(i),A*(b-a),lambda f,a=a,b=b:a+(b-a)*f,field,N if ratio is None else ratio))
 return out
def summed(records):return {k:sum(q[k] for q in records) for k in ['volume_m3','water_kg','U_J','PE_J','tracer_kg_eq']}
# Material ownership, rather than a global identical moderator coupon.
external=[q for q in intruders if 'pads' in q['name']];bore=[q for q in intruders if q['name']=='1248 actual bodies']
Aext=fg['active']['externalFreeVolume_m3']/4;Abore=fg['active']['boreVolume_m3']/4
cores={}
for name,lo,hi in [('Core.1',-2,0),('Core.2',0,2)]:
 cores[name]=summed(native(name+'.EXTERNAL',lo,hi,Aext,external)+native(name+'.GUIDE',lo,hi,Abore,bore))
lowerBore=native('LOWER.GUIDE',fg['lower']['boreBottom_m'],fg['lower']['boreTop_m'],Abore,bore)
lowerExternal=d['guideLowerExternal']
# Existing mixed LOWER M/U/head are retained as an original preparation choice.
upperObjects=[q for q in intruders if q not in bore]
ua=d['oldUpperVolume_m3']/2;up=d['plenumLength_m'];ut=fg['upper']['boreTop_m'];go=fg['guideOuterArea_m2'];st=fg['sourceArea_m2'];sa=d['sourceThimbleTop_m']
upIntervals=[(2,2+up,ua-go-fg['upper']['sealedRodPlenumDisplacement_m3']/up),(2+up,ut,ua-go-fg['upper']['fittingDisplacement_m3']/(ut-(2+up))),(ut,sa,ua-st),(sa,4,ua)]
upper=[]
for i,(lo,hi,A) in enumerate(upIntervals):upper+=native('UPPER.EXTERNAL.'+str(i),lo,hi,A,upperObjects)
upper+=native('UPPER.GUIDE',2,ut,Abore,bore)
housing=[]
collars=[dict(name='collar',lo=z,hi=z+H['collarHeight'],area=H['collarArea']) for z in H['collarBottoms']]
housing+=native('HOUSING.MAIN',H['mainLo'],H['mainHi'],H['mainArea'],intruders)
housing+=native('HOUSING.NECK',H['mainHi'],H['neckHi'],H['neckArea'],intruders+collars)
changed=summed([*cores.values(),lowerExternal,*lowerBore,*upper,*housing]);prior=d['guideChanged']
displaced=prior['volume_m3']+H['mainArea']*(H['mainHi']-H['mainLo'])+H['neckArea']*(H['neckHi']-H['mainHi'])-H['collarArea']*H['collarHeight']*len(H['collarBottoms'])-changed['volume_m3']
require('once-only current primary material displaces original guide plus housing space',abs(displaced-G['expectedAddedPrimarySolid_m3'])<2e-12,displaced_m3=displaced,expected_m3=G['expectedAddedPrimarySolid_m3'])
require('native current primary tracer follows actual carrier',abs(changed['tracer_kg_eq']-changed['water_kg']*N)<1e-10)
unchanged=d['unchangedPrimary'];whole={k:changed[k]+sum(q[k] for q in unchanged) for k in changed}
require('single datum retained, not a pressure boundary after prep',abs(mainField(z0)[0]-p0)<1e-8)
require('all primary water initial mean temperatures are native outputs',all(math.isfinite(q['meanTemperature_K']) for q in rows))
# Actual original mixed bays use owned surface pressure / density; PE retains
# excluded solid moments, rather than adding head enclosed water to the bay.
b=d['head'];surface=d['surface'];T=b['cnvTemperature_K'];p=b['cnvPressure_Pa'];rho,u=water(p,T);bays=[]
envelope=G['envelope'];gate=G['gateRows'];wellRemoved=sum(q['area']*(q['hi']-q['lo']) for q in envelope)+gate[0]['area']*(gate[0]['hi']-gate[0]['lo'])
wellMoment=sum(q['area']*(q['hi']**2-q['lo']**2)/2 for q in envelope)+gate[0]['area']*(gate[0]['hi']**2-gate[0]['lo']**2)/2
poolRemoved=G['rackDisplacement_m3']+gate[1]['area']*(gate[1]['hi']-gate[1]['lo'])
poolMoment=G['rackDisplacement_m3']*(d['poolFloor']+d['rackBottomClearance']+d['activeLength']/2)+gate[1]['area']*(gate[1]['hi']**2-gate[1]['lo']**2)/2
for name,V,floor,removed,moment in [('WELL',G['grossBayVolumes']['well'],d['wellFloor'],wellRemoved,wellMoment),('CANAL',G['grossBayVolumes']['canal'],d['canalFloor'],0,0),('POOL',G['grossBayVolumes']['pool'],d['poolFloor'],poolRemoved,poolMoment)]:
 volume=V-removed;M=rho*volume;PE=rho*g*(V*(floor+surface)/2-moment)
 require(name+' native water and exclusion are disjoint',volume>0 and abs(volume+removed-V)<1e-10)
 bays.append(dict(owner=name,volume_m3=volume,excluded_m3=removed,water_kg=M,U_J=M*u,PE_J=PE,tracer_kg_eq=M*b['poolTracerRatio'],liquidSurface_m=surface))
# Same owned pool free-surface head reduction; each pipe itself is native and
# isothermal, not a clone of the isolated warm RHR train.
mouth=b['poolMouth_m'];base=p+rho*g*(surface-mouth);legField=hydro(base,mouth,T,zmin=b['poolTrain_m'],zmax=mouth)
pipeA=math.pi*b['poolLegDiameter_m']**2/4
for label in ['SOURCE','RETURN']:
 region('POOL.LEG.'+label+'.VERTICAL',pipeA*(mouth-b['poolTrain_m']),lambda f:mouth+(b['poolTrain_m']-mouth)*f,legField,b['poolTracerRatio'])
 region('POOL.LEG.'+label+'.HORIZONTAL',pipeA*b['poolLegHorizontal_m'],lambda f:b['poolTrain_m'],legField,b['poolTracerRatio'])
legs=[q for q in rows if q['owner'].startswith('POOL.LEG')];legTotals=summed(legs)
require('two finite legs distinct from isolated warm train',abs(legTotals['volume_m3']-2*pipeA*(mouth-b['poolTrain_m']+b['poolLegHorizontal_m']))<1e-12)
require('pool/train initial pressure mismatch retained behind CLOSED selectors',abs(legField(b['poolTrain_m'])[0]-300000)>1000,localPoolPressure_Pa=legField(b['poolTrain_m'])[0],isolatedTrainPressure_Pa=300000)
# One original enclosure volume excludes all occupied fixed/moving bodies.
outmetal=(b['gantryMetal_kg']+b['accessPlateMass_kg'])/d['steelDensity']+G['tools']['shaftVolume_m3']+G['tools']['toolVolume_m3']
closed=b['separatorVolume_m3']+b['separatorMetal_kg']/d['steelDensity']+legTotals['volume_m3']
added=sum(G['grossBayVolumes'].values())+outmetal+closed;enclosure=d['existingEnclosure']+added
gas=enclosure-(d['existingEnclosure']-b['cnvGasVolume_m3'])-sum(q['volume_m3']+q['excluded_m3'] for q in bays)-outmetal-closed
require('one gas space after all actual exclusions',abs(gas-b['cnvGasVolume_m3'])<1e-9,gasVolume_m3=gas,enclosure_m3=enclosure)
pv=P('P','T',T,'Q',1,'Water');mv=pv*gas/(461.5*T);ma=(p-pv)*gas/(287*T);hv=P('H','T',T,'Q',1,'Water');U=mv*(hv-461.5*T)+ma*718*(T-298.15)
cnv=dict(volume_m3=gas,totalPressure_Pa=p,vaporPressure_Pa=pv,air_kg=ma,vapor_kg=mv,nitrogen_kg=0,droplet_kg=0,U_J=U,PE_J=(ma+mv)*g*20,enclosure_m3=enclosure,additionalAvailableSpace_m3=added)
require('CNV owned ideal convention pressure closes',abs((ma*287+mv*461.5)*T/gas-p)<1e-8)
# Separator water vapor uses the selected native saturated convention, NOT
# CNV's ideal vapor mass/caloric reduction. There is no initial liquid.
Ts=b['separatorTemperature_K'];Vs=b['separatorVolume_m3'];pvs=P('P','T',Ts,'Q',1,'Water');msv=Vs*P('D','T',Ts,'Q',1,'Water');msa=(p-pvs)*Vs/(287*Ts)
Us=msv*P('U','T',Ts,'Q',1,'Water')+msa*718*(Ts-298.15);zsep=b['separatorFloor_m']+Vs/(2*b['separatorArea_m2'])
separator=dict(volume_m3=Vs,temperature_K=Ts,totalPressure_Pa=p,vaporPressure_Pa=pvs,vapor_kg=msv,air_kg=msa,liquid_kg=0,nitrogen_kg=0,tracer_kg_eq=0,U_J=Us,PE_J=(msa+msv)*g*zsep)
require('separate native separator inventory and pressure',msv>0 and msa>0 and abs(pvs+msa*287*Ts/Vs-p)<1e-8)
metals=[{**q,'U_J':q['mass_kg']*steel(q['T'])['e'],'capacity_J_K':q['mass_kg']*steel(q['T'])['cp']} for q in G['metal']]
for q in G['b4c']:metals.append({**q,'U_J':q['mass_kg']*q['e_J_kg'],'capacity_J_K':q['mass_kg']*q['cp_J_kg_K']})
require('all added material has finite positive caloric capacity',all(q['capacity_J_K']>0 and math.isfinite(q['U_J']) for q in metals))
require('52 spring stocks once, not body insertion source',G['spring_J']==52)
require('current rest material has no copied source dynamics',d['sourceAuthority']=='UNSELECTED')
# ONE new original material preparation, not restoration or an isotope reseed.
# Geometry and caloric stocks above are unchanged by this independent marker.
stock=d['originalStock'];i=stock['isotope'];molar=i['fraction']*i['mass10']+(1-i['fraction'])*i['mass11'];atoms=i['avogadro']*i['fraction']/molar
primaryStocks=[dict(q) for q in rows if not q['owner'].startswith('POOL.LEG')]+[dict(lowerExternal),*unchanged,*stock['appendages']]
for q in stock['pzr']:
 primaryStocks.append(dict(owner='PZR.'+q['lane']+'.'+str(q['lo_m']),water_kg=q['liquid_kg'],U_J=q['U_J'],PE_J=q['E_J']-q['U_J'],tracer_kg_eq=q['liquid_kg']*N))
ch=stock['charging'];crho,cu=water(ch['pressure_Pa'],ch['temperature_K']);cv=ch['residence_s']*ch['flow_kg_s']/crho
for name in ['CHARGE.SUCTION','CHARGE.DISCHARGE']:
 primaryStocks.append(dict(owner=name,water_kg=cv*crho,volume_m3=cv,U_J=cv*crho*cu,PE_J=cv*crho*g*3,tracer_kg_eq=cv*crho*N))
require('all current primary-facing original stocks own 2000 independently of old receipts',all(abs(q['tracer_kg_eq']-N*q['water_kg'])<1e-10 for q in primaryStocks))
require('source stocks have unique physical rows',len(set(q['owner'] for q in primaryStocks))==len(primaryStocks))
for q in primaryStocks:
 q.update(mobileMarker_kg_eq=q.pop('tracer_kg_eq'),retainedMarker_kg_eq=0)
 q.update(mobileN10=q['mobileMarker_kg_eq']*atoms,retainedN10=0)
originalStocks=dict(meaning='ORIGINAL fresh primary-facing stock only; existing passive/bay and independent chemistry/support stocks retain their own owners; never apply after capture, copy or reached transport',atomsPer_kg_eq=atoms,rows=primaryStocks,
 carrier_kg=sum(q['water_kg'] for q in primaryStocks),mobileMarker_kg_eq=sum(q['mobileMarker_kg_eq'] for q in primaryStocks),mobileN10=sum(q['mobileN10'] for q in primaryStocks),retainedMarker_kg_eq=0,retainedN10=0)
require('original seed extensive sums without source authority',abs(originalStocks['mobileMarker_kg_eq']-originalStocks['carrier_kg']*N)<1e-9 and originalStocks['mobileN10']>0)
print(json.dumps(dict(scope='Current ORIGINAL cold2000 hardware/native/caloric/material preparation only; no source/NI law, attained history, heat/storage duty, motion or lifecycle permission',packages=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__),checks=checks,mainPrimary=whole,cores=cores,lower=summed([lowerExternal,*lowerBore]),upper=summed(upper),housing=summed(housing),nativeRows=rows,bays=bays,poolLegs=legTotals,cnv=cnv,separator=separator,finiteMetal=metals,spring_J=G['spring_J'],originalStocks=originalStocks,sourceAuthority=d['sourceAuthority']),allow_nan=False))
`

export async function runCurrentColdParent(directory:string,coldReceipt:string,guideReceipt:string,python:string){
 const paths={parent:'model/connected-primary-initialization.md',control:'systems/reactor/control-absorber-and-guide-water.md',attachment:'systems/reactor/fuel-transfer-grapple.md',
  fuel:'systems/reactor/fuel-construction.md',handling:'systems/reactor/fuel-handling-and-pool.md',head:'systems/reactor/head-and-pool-cooling.md',pressure:'safety/cold-pressure-and-startup-protection.md',cnv:'systems/passive-cooling/reservoir-and-containment.md',chemistry:'systems/primary-coolant/inventory-and-chemistry.md'}
 const docs=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([key,path])=>[key,await Bun.file(resolve(directory,path)).text()]))) as Record<keyof typeof paths,string>
 const coldText=await Bun.file(coldReceipt).text(),guideText=await Bun.file(guideReceipt).text(),cold=JSON.parse(coldText),guide=JSON.parse(guideText)
 if(cold.calculationSHA256!==sha(coldParentCalculation)||guide.calculationSHA256!==sha(guideParentCalculation)||guide.priorParentReceiptSHA256!==sha(coldText))throw Error('Require exact original native cold/guide receipt lineage')
 const c=parseControlAbsorber(docs.control),a=parseTransferAttachment(docs.attachment),f=parseFuelConstruction(docs.fuel),h=parseFuelHandling(docs.handling),head=parseHeadPool(docs.head),s=parseCurrentColdParent(docs.parent),pressure=parseColdPressure(docs.pressure),chemistry=parseChemistryLifecycle(docs.chemistry),charge=parseChargingPressure(docs.chemistry),chargePump=readServicePump(resolve(directory,paths.chemistry)),
  allGeometry=currentColdGeometry(c,a,f,h,parseTransferGates(docs.attachment),head,s),allFresh=fuelHandlingChecks(h,f).freshGeometry
 if(chemistry.initialPrimary_ppm*1e-6!==s.primaryAbsorberRatio||chemistry.BLEND.initial_ppm*1e-6!==s.primaryAbsorberRatio||chargePump.id!=='CHARGE')throw Error('Original cold stock/charging-owner disagreement')
 const pick=<T extends Record<string,unknown>>(q:T,keys:(keyof T)[])=>Object.fromEntries(keys.map(k=>[k,q[k]]))
 const geometry={...pick(allGeometry,['intruders','envelope','metal','b4c','expectedAddedPrimarySolid_m3','housing','rackDisplacement_m3','grossBayVolumes','spring_J']),
  gateRows:allGeometry.gateRows.map(q=>pick(q,['lo','hi','area'])),tools:pick(allGeometry.tools,['shaftVolume_m3','toolVolume_m3'])}
 const fresh={...pick(allFresh,['guideOuterArea_m2','sourceArea_m2']),active:pick(allFresh.active,['externalFreeVolume_m3','boreVolume_m3']),
  lower:pick(allFresh.lower,['boreBottom_m','boreTop_m']),upper:{...pick(allFresh.upper,['boreTop_m','sealedRodPlenumDisplacement_m3','fittingDisplacement_m3']),boreTop_m:allGeometry.faTop_m}}
 const original=(q:{water_kg:number,tracer_kg_eq:number})=>({...q,tracer_kg_eq:q.water_kg*s.primaryAbsorberRatio}),unchanged=cold.primaryRows.filter((q:{owner:string})=>q.owner.startsWith('MAIN.')&&!['MAIN.CORE.1','MAIN.CORE.2','MAIN.LOWER','MAIN.UPPER'].includes(q.owner)).map(original),guideChanged=[guide.active,guide.lowerExternal,...guide.guideRows.filter((q:{owner:string})=>q.owner==='LOWER.GUIDE'),guide.upperExternal,...guide.guideRows.filter((q:{owner:string})=>q.owner==='UPPER.GUIDE')]
 const sum=(key:string)=>guideChanged.reduce((v,q)=>v+q[key],0)
 const enclosureMatch=docs.cnv.match(/modeled enclosure is \*\*([\d.]+) m³\*\*/)
 if(!enclosureMatch)throw Error('Reconcile existing available CNV enclosure')
 const consumed={geometry,fresh,anchor:{pressure_Pa:pressure.coldPzr.hotPressure_Pa,temperature_K:pressure.coldPzr.temperature_K,elevation_m:2.5},
  gravity:c.gravity_m_s2,ratio:s.primaryAbsorberRatio,guideLowerExternal:original(guide.lowerExternal),guideChanged:{volume_m3:sum('volume_m3')},
  unchangedPrimary:unchanged,oldUpperVolume_m3:guide.consumedInput.oldUpperVolume_m3,plenumLength_m:f.plenumLength_m,sourceThimbleTop_m:h.sourceThimbleTop_m,
  head:Object.fromEntries(['cnvTemperature_K','cnvPressure_Pa','cnvGasVolume_m3','poolTracerRatio','poolMouth_m','poolTrain_m','poolLegDiameter_m','poolLegHorizontal_m','gantryMetal_kg','accessPlateMass_kg','separatorVolume_m3','separatorMetal_kg','separatorTemperature_K','separatorFloor_m','separatorArea_m2'].map(k=>[k,head[k as keyof typeof head]])),
  surface:h.surface_m,wellFloor:h.wellFloor_m,canalFloor:h.canalFloor_m,poolFloor:h.poolFloor_m,rackBottomClearance:h.bottomFittingLength_m,activeLength:f.activeLength_m,
  steelDensity:c.steelDensity_kg_m3,existingEnclosure:Number(enclosureMatch[1]),sourceAuthority:'UNSELECTED',
  originalStock:{appendages:[...cold.primaryRows.filter((q:{owner:string})=>!q.owner.startsWith('MAIN.')),...cold.otherNativeRows.filter((q:{owner:string})=>q.owner.startsWith('RHR.'))].map(original),pzr:cold.coldPzr.regions.map((q:Record<string,unknown>)=>pick(q,['lane','lo_m','liquid_kg','U_J','E_J'])),
   isotope:{fraction:chemistry.isotopeFraction,mass10:chemistry.isotope10MolarMass_kg_mol,mass11:chemistry.isotope11MolarMass_kg_mol,avogadro:chemistry.avogadro_mol},
   charging:{pressure_Pa:chemistry.pressure_Pa,temperature_K:chemistry.temperature_K,residence_s:charge.bodyResidence_s,flow_kg_s:chargePump.flow_kg_s}}}
 const sources=['reference-design-current-cold-parent.ts','reference-design-cold-parent.ts','reference-design-guide-parent.ts','reference-design-control-absorber.ts','reference-design-fuel-transfer.ts','reference-design-fuel-handling.ts','reference-design-fuel-construction.ts','reference-design-cold-pressure.ts','reference-design-head-pool.ts','reference-design-pressurizer-heater-contact.ts','reference-design-chemistry-lifecycle.ts','reference-design-charging-pressure.ts','reference-design-service-pump-continuation.ts']
 const hashes=async()=>Object.fromEntries(await Promise.all(sources.map(async q=>[q,sha(await Bun.file(resolve(import.meta.dir,q)).text())])))
 const before=await hashes(),serial=JSON.stringify(consumed),proc=Bun.spawn([python,'-c',currentColdParentCalculation],{stdin:new Blob([serial]),stdout:'pipe',stderr:'pipe'}),[out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited])
 if(code)throw Error(err)
 if(JSON.stringify(before)!==JSON.stringify(await hashes()))throw Error('Current preparation calculation source changed during run')
 return {sourceSHA256:before[sources[0]!],calculationSHA256:sha(currentColdParentCalculation),consumedInputSHA256:sha(serial),consumedInput:consumed,dependencySourcesSHA256:before,
  historicalReceiptsSHA256:{cold:sha(coldText),guide:sha(guideText)},ownerContextSHA256:Object.fromEntries(Object.entries(paths).map(([k,p])=>[p,sha(docs[k as keyof typeof docs])])),...JSON.parse(out)}
}
if(import.meta.main){const [wiki,cold,guide,python,receipt,...extra]=Bun.argv.slice(2);if(!wiki||!cold||!guide||!python||!receipt||extra.length)throw Error('Usage: current-cold-parent <LD01> <cold.json> <guide.json> <python> <receipt.json>');const r=await runCurrentColdParent(wiki,cold,guide,python);await Bun.write(receipt,JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify({receipt,checks:r.checks.length,mainPrimary:r.mainPrimary,cores:r.cores,housing:r.housing,cnv:r.cnv},null,2))}
