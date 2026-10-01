/** Held native stem/head consequence only; no plant or handling runtime. */
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {parseTransferAttachment} from './reference-design-fuel-transfer'
import {parseControlAbsorber} from './reference-design-control-absorber'
import {solid304Python} from './reference-design-pressurizer-heater-contact'

const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
type StemAttachment=Pick<ReturnType<typeof parseTransferAttachment>,'shoulderBottom_m'|'stubLength_m'|'lugWidth_m'|'lugOuterRadius_m'|'lugBottom_m'|'lugHeight_m'|'shoulderDiameter_m'|'shoulderHeight_m'>
type StemControl=Pick<ReturnType<typeof parseControlAbsorber>,'stemDiameter_m'|'collarBottoms_m'|'collarHeight_m'|'spiderBottom_m'|'spiderHeight_m'|'stemLength_m'|'clusters'|'steelDensity_kg_m3'|'headBottom_m'|'housingTop_m'|'neckTop_m'>
export function retainedStemGeometry(a:StemAttachment,c:StemControl){
 if(![...Object.values(a),...Object.values(c).flat()].every(Number.isFinite))throw Error('Nonfinite retained stem input')
 const radius=c.stemDiameter_m/2,collarTop=Math.max(...c.collarBottoms_m)+c.collarHeight_m,
  fall=a.shoulderBottom_m-collarTop,oldBottom=c.spiderBottom_m+c.spiderHeight_m,
  bottom=oldBottom-a.stubLength_m-fall,top=oldBottom+c.stemLength_m-fall,
  pieces=[{name:'shaft and added stub',area_m2:Math.PI*radius**2,lo_m:bottom,hi_m:top},
   {name:'two opposed lugs',area_m2:2*a.lugWidth_m*(a.lugOuterRadius_m-radius),lo_m:a.lugBottom_m-fall,hi_m:a.lugBottom_m+a.lugHeight_m-fall},
   {name:'annular shoulder',area_m2:Math.PI*((a.shoulderDiameter_m/2)**2-radius**2),lo_m:a.shoulderBottom_m-fall,hi_m:a.shoulderBottom_m+a.shoulderHeight_m-fall}],
  volume=c.clusters*pieces.reduce((sum,p)=>sum+p.area_m2*(p.hi_m-p.lo_m),0),
  oldTop=oldBottom+c.stemLength_m,oldArea=c.clusters*Math.PI*radius**2,
  overlap=(lo:number,hi:number,a:number,b:number)=>Math.max(0,Math.min(hi,b)-Math.max(lo,a)),
  solid=(lo:number,hi:number)=>c.clusters*pieces.reduce((sum,p)=>sum+p.area_m2*overlap(lo,hi,p.lo_m,p.hi_m),0),
  waterDelta=(lo:number,hi:number)=>oldArea*overlap(lo,hi,oldBottom,oldTop)-solid(lo,hi)
 if(fall<=0||c.clusters<=0||c.steelDensity_kg_m3<=0||c.stemDiameter_m<=0||a.stubLength_m<=0||a.lugWidth_m<=0||
  !(c.headBottom_m<c.housingTop_m&&c.housingTop_m<c.neckTop_m)||
  pieces.some(p=>p.area_m2<=0||p.hi_m<=p.lo_m)||bottom<=c.spiderBottom_m)throw Error('Invalid actual retained stem geometry')
 return {pieces,fall_m:fall,bottom_m:bottom,top_m:top,volume_m3:volume,mass_kg:volume*c.steelDensity_kg_m3,
  housingMainWaterDelta_m3:waterDelta(c.headBottom_m,c.housingTop_m),
  housingNeckWaterDelta_m3:waterDelta(c.housingTop_m,c.neckTop_m),
  oldShaft:{area_m2:oldArea,lo_m:oldBottom,hi_m:oldTop}}
}

export const retainedStemHeadCalculation=String.raw`
import json,sys,math,platform
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.integrate import quad,solve_ivp
${solid304Python}
d=json.load(sys.stdin);head=d['head'];c=d['control'];a=d['attachment'];geom=d['geometry'];b=head['selection'];g=c['gravity_m_s2'];N=c['clusters'];checks=[]
def require(name,ok,**values):
 if not ok:raise ValueError((name,values))
 checks.append(dict(name=name,**values))
p0=head['cold']['pressure_Pa'];T0=head['cold']['temperature_K'];z0=head['cold']['elevation_m'];S0=P('S','P',p0,'T',T0,'Water')
lower=solve_ivp(lambda z,p:[-g*P('D','P',float(p[0]),'S',S0,'Water')],(z0,geom['bottom_m']),[p0],rtol=2e-11,atol=1e-5,dense_output=True)
upper=solve_ivp(lambda z,p:[-g*P('D','P',float(p[0]),'S',S0,'Water')],(z0,c['neckTop_m']),[p0],rtol=2e-11,atol=1e-5,dense_output=True)
require('held original native field admitted',lower.success and upper.success)
def field(z):
 p=p0 if z==z0 else float((upper if z>z0 else lower).sol(z)[0]);return p,P('T','P',p,'S',S0,'Water')
pieces=geom['pieces']
compositeIncrement=N*sum(p['area_m2']*(field(p['lo_m'])[0]-field(p['hi_m'])[0]) for p in pieces)
nativeBuoyancy=N*g*sum(p['area_m2']*quad(lambda z:P('D','P',field(z)[0],'T',field(z)[1],'Water'),p['lo_m'],p['hi_m'],epsabs=1e-8)[0] for p in pieces)
require('composite added face terms recover native buoyancy once',abs(compositeIncrement-nativeBuoyancy)<1e-7,tractionIncrement_N=compositeIncrement,volumeIntegral_N=nativeBuoyancy)
# Actual shoulder/collar contact is dry mechanical incidence, not two wetted
# faces. Removing their equal/opposite pressure terms changes individual body
# forces but cancels in the assembled head. Do not label the hypothetical fully
# wetted stem's buoyancy as its actual individual pressure traction.
contactLo=max(c['collarID_m']/2,c['stemDiameter_m']/2);contactHi=min(c['collarOD_m']/2,a['shoulderDiameter_m']/2)
contactArea=N*math.pi*(contactHi**2-contactLo**2)
contactZ=max(c['collarBottoms_m'])+c['collarHeight_m']
require('actual captured shoulder/collar contact has finite coincident overlap',contactHi>contactLo and abs(contactZ-(a['shoulderBottom_m']-geom['fall_m']))<1e-12,area_m2=contactArea)
contactPressure=contactArea*field(contactZ)[0]
stemWetForce=compositeIncrement-contactPressure;headWetCorrection=contactPressure
require('excluded contact terms cancel only in assembled traction',abs(stemWetForce+headWetCorrection-compositeIncrement)<1e-9)
old=head['inserted'];oldStem=geom['oldShaft'];collarArea=N*math.pi*(c['collarOD_m']**2-c['collarID_m']**2)/4
def actualArea(z,label):
 A=N*math.pi*(c['housingID_m'] if label=='main' else c['neckID_m'])**2/4
 if label=='neck':A-=sum(collarArea for lo in c['collarBottoms_m'] if lo<z<lo+c['collarHeight_m'])
 A-=N*sum(p['area_m2'] for p in pieces if p['lo_m']<z<p['hi_m'])
 return A
water=[]
for label,lo,hi,oldV in [('main',c['headBottom_m'],c['housingTop_m'],old['housingMainWater_m3']),('neck',c['housingTop_m'],c['neckTop_m'],old['housingNeckWater_m3'])]:
 cuts=sorted(set([lo,hi]+[z for p in pieces for z in [p['lo_m'],p['hi_m']] if lo<z<hi]+[z for q in c['collarBottoms_m'] for z in [q,q+c['collarHeight_m']] if lo<z<hi]))
 segments=[(l,h,actualArea((l+h)/2,label)) for l,h in zip(cuts,cuts[1:])]
 require(label+' actual free areas positive',all(A>0 for l,h,A in segments))
 V=sum(A*(h-l) for l,h,A in segments)
 delta=geom['housingMainWaterDelta_m3' if label=='main' else 'housingNeckWaterDelta_m3']
 require(label+' new water partition matches disjoint metal',abs(V-oldV-delta)<1e-12,volume_m3=V,change_m3=delta)
 M=sum(A*quad(lambda z:P('D','P',field(z)[0],'T',field(z)[1],'Water'),l,h,epsabs=1e-7)[0] for l,h,A in segments)
 U=sum(A*quad(lambda z:P('D','P',field(z)[0],'T',field(z)[1],'Water')*P('U','P',field(z)[0],'T',field(z)[1],'Water'),l,h,epsabs=1e-4)[0] for l,h,A in segments)
 PE=sum(A*quad(lambda z:P('D','P',field(z)[0],'T',field(z)[1],'Water')*g*z,l,h,epsabs=1e-7)[0] for l,h,A in segments)
 water.append(dict(owner=label,volume_m3=V,water_kg=M,U_J=U,PE_J=PE,tracer_kgEq=M*head['cold']['primaryAbsorberRatio']))
metalMass=head['head']['attachedTotal_kg']+geom['mass_kg'];metalGravity=metalMass*g
stemPE=N*c['steelDensity_kg_m3']*g*sum(p['area_m2']*(p['hi_m']**2-p['lo_m']**2)/2 for p in pieces)
# Uniform 300K is the authored cold comparison energy, not a newly imposed
# thermal history or an assertion of reached material equilibrium.
stemU=geom['mass_kg']*steel(T0)['e'];stemC=geom['mass_kg']*steel(T0)['cp']
oldTraction=d['oldHeadTraction_N'];traction=oldTraction+headWetCorrection+stemWetForce
reaction=traction-metalGravity;acceleration=(reaction-b['gantryForce_N'])/metalMass
require('unequal original face still defeats released healthy brake',acceleration>0,initialAcceleration_m_s2=acceleration)
static=(metalMass+sum(w['water_kg'] for w in water))*g+b['headReleaseDP_Pa']*c['headGrossArea_m2']
require('conservative finite fluid/static sizing remains below one gantry',static<b['gantryForce_N'],bound_N=static,margin_N=b['gantryForce_N']-static)
governorSpeed=b['gantrySpeed_m_s']*(1-static/b['gantryForce_N'])
require('loaded unloaded-scale is not a promised speed',0<governorSpeed<b['gantrySpeed_m_s'],conditionalSpeed_m_s=governorSpeed)
# Exactly the same disjoint stem volume moves through native water/gas; no
# native housing water is added to rigid-body inertia or transported as cargo.
fall=geom['fall_m'];gravityDrop=geom['mass_kg']*g*fall
require('finite precontact fall has real gravity stock',gravityDrop>0,gravityDrop_J=gravityDrop)
volume=geom['volume_m3'];nominalMass=d['oldHeadWater_kg']
require('housing water stays separately native',sum(w['water_kg'] for w in water)>0 and metalMass==head['head']['attachedTotal_kg']+geom['mass_kg'])
print(json.dumps(dict(scope='Held original native field, captured-stem metal/pressure faces, disjoint housing water and static force/work consequence only; no achieved disconnect/drop/head lift, fresh primary preparation, source or procedure permission',
 dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__),checks=checks,
 retainedStem=dict(mass_kg=geom['mass_kg'],volume_m3=volume,actualWetTraction_N=stemWetForce,compositeTractionIncrement_N=compositeIncrement,
  collarWetCorrection_N=headWetCorrection,contactArea_m2=contactArea,U_J=stemU,PE_J=stemPE,capacity_J_K=stemC,gravityDrop_J=gravityDrop),
 assembledHead=dict(rigidMetal_kg=metalMass,gravity_N=metalGravity,traction_N=traction,retainedHousingWater=water,staticBound_N=static,conditionalGovernorSpeed_m_s=governorSpeed,releasedBrakeAcceleration_m_s2=acceleration,
 waterChange_kg=sum(w['water_kg'] for w in water)-nominalMass)),allow_nan=False))
`

if(import.meta.main){
 const [directory,headPath,python,output,...rest]=Bun.argv.slice(2)
 if(!directory||!headPath||!python||!output||rest.length)throw Error('Usage: retained-stems <ld-01> <accepted-original-head.json> <research-python> <receipt.json>')
 const paths=['systems/reactor/fuel-transfer-grapple.md','systems/reactor/control-absorber-and-guide-water.md'],
  docs=await Promise.all(paths.map(path=>Bun.file(resolve(directory,path)).text())),
  attachment=parseTransferAttachment(docs[0]!),control=parseControlAbsorber(docs[1]!),geometry=retainedStemGeometry(attachment,control),
  bytes=await Bun.file(headPath).text(),head=JSON.parse(bytes)
 if(sha(JSON.stringify(head.consumedInput))!==head.consumedInputSHA256||!Array.isArray(head.head?.retainedHousingWater)||!Number.isFinite(head.head.traction_N))throw Error('Invalid consumed original head receipt')
 // The old comparison owns all of these enclosure fields. Reject changed
 // geometry rather than silently combining its old traction with a new head.
 for(const [key,value] of Object.entries(head.consumedInput.control))if(JSON.stringify(value)!==JSON.stringify(control[key as keyof typeof control]))throw Error('Changed original head context: '+key)
 const {shoulderBottom_m,stubLength_m,lugWidth_m,lugOuterRadius_m,lugBottom_m,lugHeight_m,shoulderDiameter_m,shoulderHeight_m}=attachment,
  consumedAttachment={shoulderBottom_m,stubLength_m,lugWidth_m,lugOuterRadius_m,lugBottom_m,lugHeight_m,shoulderDiameter_m,shoulderHeight_m},
  consumedControl={...head.consumedInput.control,spiderBottom_m:control.spiderBottom_m,spiderHeight_m:control.spiderHeight_m,stemLength_m:control.stemLength_m},
  input={head:head.consumedInput,attachment:consumedAttachment,control:consumedControl,geometry,oldHeadTraction_N:head.head.traction_N,
  oldHeadWater_kg:head.head.retainedHousingWater.reduce((sum:number,w:{water_kg:number})=>sum+w.water_kg,0)},text=JSON.stringify(input),
  sourceSHA256=sha(await Bun.file(import.meta.path).text()),
  child=Bun.spawn([python,'-c',retainedStemHeadCalculation],{stdin:new Blob([text]),stdout:'pipe',stderr:'pipe'}),
  [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
 if(code)throw Error(err)
 if(sourceSHA256!==sha(await Bun.file(import.meta.path).text()))throw Error('Retained-stem source changed during calculation')
 const result=JSON.parse(out),receipt={sourceSHA256,calculationSHA256:sha(retainedStemHeadCalculation),
  consumedInputSHA256:sha(text),consumedInput:input,fixtureReceiptSHA256:sha(bytes),
  ownerContextSHA256:Object.fromEntries(paths.map((path,i)=>[path,sha(docs[i]!)])),...result}
 await Bun.write(output,JSON.stringify(receipt,null,2)+'\n')
 console.log(JSON.stringify({output,checks:result.checks.length,retainedStem:result.retainedStem,assembledHead:result.assembledHead}))
}
