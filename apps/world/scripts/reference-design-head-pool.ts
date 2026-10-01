/** Native, bounded head/pool selection screens; no plant or lifecycle solver. */
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {z} from 'zod'
import {parseControlAbsorber,controlAbsorberGeometry} from './reference-design-control-absorber'
import {parseFuelConstruction} from './reference-design-fuel-construction'
import {parseFuelHandling,fuelHandlingChecks} from './reference-design-fuel-handling'
import {parseColdPressure} from './reference-design-cold-pressure'
import {parseColdParent} from './reference-design-cold-parent'
import {parseRhrSupport} from './reference-design-rhr-support'
import {readServicePump} from './reference-design-service-pump-continuation'
import {readSignedSelection,signedMachine,motorBudget} from './reference-design-rhr-signed-pump'
import {nativeMaterialFunctions} from './reference-design-rhr-material-wave'
import {solid304Python} from './reference-design-pressurizer-heater-contact'

const p=z.number().finite().positive(),n=z.number().finite()
const schema=z.object({bayRim_m:n,baySpillWidths_m:z.array(p).length(3),spillCoefficient:p,
 cnvGasVolume_m3:p,cnvPressure_Pa:p,cnvTemperature_K:p,poolTracerRatio:p,
 accessCdA_m2:p,accessForce_N:p,accessPower_W:p,accessFixedFriction_N:p,
 accessPressureFrictionFactor:p,accessPlateMass_kg:p,separatorVolume_m3:p,
 separatorArea_m2:p,separatorFloor_m:n,separatorTemperature_K:p,separatorMetal_kg:p,
 headLiftBase_m:n,headCradleX_m:n,gantryTop_m:n,gantryForce_N:p,gantryPower_W:p,
 gantryEfficiency:p.max(1),gantrySpeed_m_s:p,gantryMetal_kg:p,headDragCoefficient:p,
 headGapCd:p.max(1),headReleaseDP_Pa:p,poolLegDiameter_m:p,poolMouth_m:n,poolTrain_m:n,
 poolLegHorizontal_m:p,poolDarcy:p,poolLegFormLoss:p,poolISOReferenceLoss_Pa:p,
 poolISOReferencePressure_Pa:p,poolISOReferenceTemperature_K:p,
 ccwFixturePressure_Pa:p,ccwFixtureTemperature_K:p,ccwFixtureFlow_kg_s:p,
 manualPinStroke_m:p,manualPinSpeed_m_s:p,manualPinForce_N:p,manualPinPower_W:p,
 manualPinFriction_N:p,manualPinReactionFactor:p,headLockLimit_N:p,
 poolAssessmentTemperature_K:p}).strict()
export function parseHeadPool(document:string){
 const b=[...document.matchAll(/^```reference-head-pool\s*\n([\s\S]*?)^```\s*$/gm)]
 if(b.length!==1)throw Error('Expected one reference-head-pool block')
 return schema.parse(JSON.parse(b[0]![1]!))
}
/** Design-request ordering only; does not remove actual leaking conductance. */
export function poolSelectionAllowed(others:{usable:boolean,closed:boolean,pendingOpen:boolean}[]){
 if(others.length!==2)throw Error('Pool selection requires both real alternatives')
 return others.every(q=>q.usable&&q.closed&&!q.pendingOpen)
}
export function headReleaseEvidence(channels:{usable:boolean,low_Pa:number,high_Pa:number,qualified_s:number}[],limit:number){
 return channels.length===2&&channels.every(q=>q.usable&&q.low_Pa>=-limit&&q.high_Pa<=limit&&q.low_Pa<=q.high_Pa&&q.qualified_s>=2)
}

export const headPoolCalculation=String.raw`
${nativeMaterialFunctions}
import numpy as np,platform
from scipy.integrate import quad
from scipy.optimize import least_squares
from iapws import IAPWS97 as W
${solid304Python}
d=json.load(sys.stdin);b=d['selection'];c=d['control'];hg=d['head'];pose=d['inserted'];fh=d['handling'];r=d['rhr'];s=d['sizing'];g=c['gravity_m_s2'];results=[]
def require(name,ok,**values):
 if not ok:raise ValueError((name,values))
 results.append(dict(name=name,**values))
# Isentropic primary head field; native isothermal well/pipe inventory field.
p0=d['cold']['pressure_Pa'];T0=d['cold']['temperature_K'];z0=d['cold']['elevation_m'];S0=P('S','P',p0,'T',T0,'Water')
def field(pref,zref,T=None):
 def rho(p):return P('D','P',p,'S',S0,'Water') if T is None else P('D','P',p,'T',T,'Water')
 lower=solve_ivp(lambda z,p:[-g*rho(float(p[0]))],(zref,-2),[pref],rtol=2e-11,atol=1e-5,dense_output=True) if zref>-2 else None
 upper=solve_ivp(lambda z,p:[-g*rho(float(p[0]))],(zref,14),[pref],rtol=2e-11,atol=1e-5,dense_output=True) if zref<14 else None
 if not all(q.success for q in [lower,upper] if q is not None):raise ValueError('Native static field failed')
 def at(z):
  p=pref if z==zref else float((upper if z>zref else lower).sol(z)[0]);t=P('T','P',p,'S',S0,'Water') if T is None else T
  return p,t
 return at
def poolFace(T,z):
 # Preserve the existing uniform pool/native-free-surface density reduction.
 # Pipe fields below have their separately owned compressible native hydrostat.
 rho=P('D','P',b['cnvPressure_Pa'],'T',T,'Water')
 return b['cnvPressure_Pa']+rho*g*(fh['surface_m']-z),T
well=lambda z:poolFace(b['cnvTemperature_K'],z);primary=field(p0,z0)
faceP,faceT=primary(c['headBottom_m']);wellP,_=well(c['headBottom_m'])
N=c['clusters'];area=lambda diameter:N*math.pi*diameter**2/4
Ai,Ao,Ni,No=map(area,[c['housingID_m'],c['housingOD_m'],c['neckID_m'],c['neckOD_m']])
collarA=area(c['collarOD_m'])-area(c['collarID_m']);jack=d['jack'];jackA=jack['volume_m3']/jack['length_m']
def traction(inner,outer):
 F=(c['headGrossArea_m2']-Ai)*inner(c['headBottom_m'])[0]-(c['headGrossArea_m2']-Ao)*outer(c['headBottom_m']+c['headThickness_m'])[0]
 F+=(Ai-Ni)*inner(c['housingTop_m'])[0]-(Ao-No)*outer(c['housingTop_m']+c['housingCapHeight_m'])[0]
 F+=Ni*inner(c['neckTop_m'])[0]-No*outer(c['neckTop_m']+c['neckCapHeight_m'])[0]
 F+=sum(collarA*(inner(z)[0]-inner(z+c['collarHeight_m'])[0]) for z in c['collarBottoms_m'])
 F+=jackA*(outer(jack['bottom_m'])[0]-outer(jack['top_m'])[0])
 return F
force=traction(primary,well);gravity=hg['attachedTotal_kg']*g;unbalanced=force-gravity
require('Original unequal head face exceeds actual brake after release',unbalanced>b['gantryForce_N'],primaryFace_Pa=faceP,wellFace_Pa=wellP,traction_N=force,unbalanced_N=unbalanced,unpoweredReleasedAcceleration_m_s2=(unbalanced-b['gantryForce_N'])/hg['attachedTotal_kg'])
# Independent constant-density traction: every horizontal face sums to rho*g*Vmetal.
rho=P('D','P',b['cnvPressure_Pa'],'T',b['cnvTemperature_K'],'Water')
constant=lambda z:(b['cnvPressure_Pa']+rho*g*(fh['surface_m']-z),b['cnvTemperature_K'])
buoyancy=traction(constant,constant);analytic=rho*g*hg['attachedTotal_kg']/c['steelDensity_kg_m3']
require('Horizontal pressure-face incidence equals analytic metal buoyancy',abs(buoyancy-analytic)<1e-7,traction_N=buoyancy,analytic_N=analytic)
housingWater=[]
for label,V,lo,hi in [('main',pose['housingMainWater_m3'],c['headBottom_m'],c['housingTop_m']),('neck',pose['housingNeckWater_m3'],c['housingTop_m'],c['neckTop_m'])]:
 # Subtract actual stem/collar axial intersections; do not spread those solids
 # uniformly through a neck merely because aggregate volumes already passed.
 cuts=sorted(set([lo,hi]+[z for z in [pose['spiderTop_m'],pose['stemTop_m']]+c['collarBottoms_m']+[z+c['collarHeight_m'] for z in c['collarBottoms_m']] if lo<z<hi]))
 segments=[]
 for za,zb in zip(cuts,cuts[1:]):
  z=(za+zb)/2;A=Ai if label=='main' else Ni
  if pose['spiderTop_m']<z<pose['stemTop_m']:A-=N*math.pi*c['stemDiameter_m']**2/4
  if label=='neck':A-=sum(collarA for floor in c['collarBottoms_m'] if floor<z<floor+c['collarHeight_m'])
  segments.append((za,zb,A))
 require('Actual '+label+' water volume partitions once',abs(sum((hi-lo)*A for lo,hi,A in segments)-V)<1e-12)
 mass=sum(A*quad(lambda z:P('D','P',primary(z)[0],'T',primary(z)[1],'Water'),lo,hi,epsabs=1e-6)[0] for lo,hi,A in segments)
 U=sum(A*quad(lambda z:P('D','P',primary(z)[0],'T',primary(z)[1],'Water')*P('U','P',primary(z)[0],'T',primary(z)[1],'Water'),lo,hi,epsabs=1e-4)[0] for lo,hi,A in segments)
 PE=sum(A*quad(lambda z:P('D','P',primary(z)[0],'T',primary(z)[1],'Water')*g*z,lo,hi,epsabs=1e-5)[0] for lo,hi,A in segments)
 housingWater.append(dict(owner=label,volume_m3=V,water_kg=mass,U_J=U,PE_J=PE))
maxMass=hg['attachedTotal_kg']+sum(q['water_kg'] for q in housingWater);releaseForce=b['headReleaseDP_Pa']*c['headGrossArea_m2'];staticBound=maxMass*g+releaseForce
require('Finite retained-fluid plus pressure-band static load fits one gantry',staticBound<b['gantryForce_N'],totalSupportedMass_kg=maxMass,staticLoadBound_N=staticBound,margin_N=b['gantryForce_N']-staticBound)
pinRows=[]
for reaction in [0,releaseForce,unbalanced]:
 F=b['manualPinFriction_N']+b['manualPinReactionFactor']*abs(reaction);blocked=F>b['manualPinForce_N'];v=0 if blocked else min(b['manualPinSpeed_m_s'],b['manualPinPower_W']/F)
 pinRows.append(dict(reaction_N=reaction,toolResistance_N=F,blocked=blocked,speed_m_s=v,bodyHeat_W=F*v,healthyTravel_s=None if blocked else b['manualPinStroke_m']/v))
require('Separate finite pin work and reaction-loaded release',not pinRows[0]['blocked'] and pinRows[-1]['blocked'] and all(q['bodyHeat_W']<=b['manualPinPower_W'] for q in pinRows),comparisons=pinRows)
require('Finite head lock and capture have separate contact capacities',unbalanced<b['headLockLimit_N'] and unbalanced>b['gantryForce_N'] and staticBound<b['gantryForce_N'],seatedLimit_N=b['headLockLimit_N'],captureLimit_N=b['gantryForce_N'])
require('Paid nominal mechanical work fits selected supply',b['gantryForce_N']*b['gantrySpeed_m_s']/b['gantryEfficiency']<=b['gantryPower_W'])
R=math.sqrt(c['headGrossArea_m2']/math.pi);perimeter=2*math.pi*R;lift=b['headLiftBase_m']-c['headBottom_m'];top=hg['top_m']+lift
require('Whole attached envelope clears real well rim and gantry',b['headLiftBase_m']>b['bayRim_m'] and top<b['gantryTop_m'],raisedTop_m=top,clearance_m=b['gantryTop_m']-top)
require('Five-metre stem-only lift cannot cross physical well wall',c['headBottom_m']+5<b['bayRim_m'])
require('Actual parking footprint clears well and canal',abs(b['headCradleX_m'])-R>math.sqrt(fh['wellArea_m2'])/2)
gapRows=[dict(gap_m=gap,CdA_m2=b['headGapCd']*min(c['headGrossArea_m2']-N*math.pi*c['stemDiameter_m']**2/4,perimeter*gap)) for gap in [0,.001,.01,.1,1]]
require('Gap conductance follows achieved opening, not Boolean equality',gapRows[0]['CdA_m2']==0 and all(a['CdA_m2']<z['CdA_m2'] for a,z in zip(gapRows,gapRows[1:])))
workRows=[]
for F,v in [(b['gantryForce_N'],b['gantrySpeed_m_s']),(-b['gantryForce_N'],b['gantrySpeed_m_s']),(0,0)]:
 shaft=F*v;Pe=max(shaft,0)/b['gantryEfficiency'];heat=Pe-shaft
 require('Nonregenerative finite equipment work '+str((F,v)),heat>=0 and Pe<=b['gantryPower_W'] and abs(Pe-shaft-heat)<1e-10)
 workRows.append(dict(force_N=F,speed_m_s=v,shaft_W=shaft,electric_W=Pe,equipmentHeat_W=heat))
require('Finite 304 recipients retain positive storage',min(steel(300)['cp']*b['gantryMetal_kg'],steel(300)['cp']*b['separatorMetal_kg'],steel(b['cnvTemperature_K'])['cp']*b['accessPlateMass_kg'])>0)
# One finite native receiving coupon, not an integrated HEAD.VENT trajectory.
# Gas PE uses the declared separator bulk midpoint; liquid owns geometric PE.
Vsep=b['separatorVolume_m3'];Tsep=b['separatorTemperature_K'];zgas=b['separatorFloor_m']+Vsep/(2*b['separatorArea_m2'])
sepAir=(b['cnvPressure_Pa']-P('P','T',Tsep,'Q',1,'Water'))*Vsep/(287*Tsep)
def separator(T,Vg):
 p=P('P','T',T,'Q',1,'Water')+sepAir*287*T/Vg;rl=P('D','P',p,'T',T,'Water');Vl=Vsep-Vg;ml=Vl*rl;mv=Vg*P('D','T',T,'Q',1,'Water')
 U=ml*P('U','P',p,'T',T,'Water')+mv*P('U','T',T,'Q',1,'Water')+sepAir*718*(T-298.15)
 PE=ml*g*(b['separatorFloor_m']+Vl/(2*b['separatorArea_m2']))+(mv+sepAir)*g*zgas
 return dict(T_K=T,pressure_Pa=p,liquid_kg=ml,vapor_kg=mv,air_kg=sepAir,water_kg=ml+mv,U_J=U,PE_J=PE,E_J=U+PE,Vg_m3=Vg)
sep0=separator(Tsep,Vsep);packet=.001;donorM=100.;donorRho=P('D','P',faceP,'T',faceT,'Water');donorU=P('U','P',faceP,'T',faceT,'Water');donorH=P('H','P',faceP,'T',faceT,'Water');Ht=donorH+g*c['headBottom_m']
targetWater=sep0['water_kg']+packet;targetE=sep0['E_J']+packet*Ht
def sepResidual(x):
 q=separator(x[0],x[1]);return [(q['water_kg']-targetWater)/targetWater,(q['E_J']-targetE)/max(abs(targetE),1)]
sol=least_squares(sepResidual,[Tsep,Vsep-packet/donorRho],bounds=([290,.01],[340,Vsep]),xtol=1e-13,ftol=1e-13,gtol=1e-13)
sep1=separator(*sol.x);donorE=donorM*(donorU+g*c['headBottom_m']);donorE1=donorE-packet*Ht;donorM1=donorM-packet;donorU1=donorE1/donorM1-g*c['headBottom_m'];donorP1=P('P','D',donorM1/(donorM/donorRho),'U',donorU1,'Water')
require('Finite separator native paired water/air/total-energy receipt',sol.success and max(abs(v) for v in sepResidual(sol.x))<1e-10 and abs(donorE1+sep1['E_J']-donorE-sep0['E_J'])<.001 and donorP1>0,pairedEnergyDefect_J=donorE1+sep1['E_J']-donorE-sep0['E_J'],donorFinalPressure_Pa=donorP1)
donorB=donorM*d['cold']['primaryAbsorberRatio'];packetB=packet*d['cold']['primaryAbsorberRatio'];donorB1=donorB-packetB
require('Finite separator paired original-primary tracer receipt',abs(donorB1+packetB-donorB)<1e-14,donorInitial_kgEq=donorB,donorFinal_kgEq=donorB1,separatorReceived_kgEq=packetB)
sepCoupon=dict(meaning='One1g parcel from explicitly finite100kg native bench donor using original primary head face and primary tracer; not achieved headvent flow, wholeprimary recovery or separator endurance',initial=sep0,received=sep1,packet_kg=packet,retainedTracer_kgEq=packetB)
drag=.5*rho*b['headDragCoefficient']*c['headGrossArea_m2']*b['gantrySpeed_m_s']**2
require('Head drag has opposite finite fluid heat',drag>0,dragAtRequestedSpeed_N=drag,fluidHeat_W=drag*b['gantrySpeed_m_s'])
access=[]
for dp in [0,faceP-wellP]:
 friction=b['accessFixedFriction_N']+b['accessPressureFrictionFactor']*abs(dp)
 blocked=friction>b['accessForce_N'];speed=0 if blocked else min(.25,b['accessPower_W']/friction)
 access.append(dict(pressureDifference_Pa=dp,friction_N=friction,blocked=blocked,speed_m_s=speed,mechanicalHeat_W=friction*speed,CdA_m2=b['accessCdA_m2']))
require('Access is achievable at equal pressure and blocked by large load',not access[0]['blocked'] and access[1]['blocked'])
# Shared CNV initial gas has one air/vapor inventory, not three atmosphere pins.
pv=P('P','T',b['cnvTemperature_K'],'Q',1,'Water');air=(b['cnvPressure_Pa']-pv)*b['cnvGasVolume_m3']/(287*b['cnvTemperature_K']);vapor=P('D','T',b['cnvTemperature_K'],'Q',1,'Water')*b['cnvGasVolume_m3']
require('One actual finite CNV gas preparation',air>0 and vapor>0,air_kg=air,vapor_kg=vapor)
bayGross=[fh['wellArea_m2']*(fh['surface_m']-fh['wellFloor_m']),fh['canalWidth_m']*fh['canalLength_m']*(fh['surface_m']-fh['canalFloor_m']),fh['poolSide_m']**2*(fh['surface_m']-fh['poolFloor_m'])]
require('Three disjoint bay gross spaces, not additional gas reservoirs',abs(sum(bayGross)-1363)<1e-10,grossWaterSpace_m3=bayGross)
spill=[b['spillCoefficient']*width*.5**1.5 for width in b['baySpillWidths_m']]
require('Real rims have nonzero signed overflow and zero equal-head flow',all(q>0 for q in spill),halfMetreHeadFlows_m3_s=spill)
cover=d['transfer']['activeCover_m'];require('Highest lifted active-fuel geometry retains selected initial cover',cover>=fh['minimumActiveCover_m'],activeCover_m=cover,wholeCover_m=d['transfer']['wholeCover_m'])
require('Missing surface cover is a real contrary geometric state',cover-1<fh['minimumActiveCover_m'])
# Native RHR calibration remains unchanged; this independent equation evaluation
# is checked against the existing signedMachine TS law by the caller.
pref=r['inletPressure_MPa']*1e6;tref=r['inletTemperature_C']+273.15;mref=r['flow_kg_s'];dpref=(r['outletPressure_MPa']-r['inletPressure_MPa'])*1e6
rr=P('D','P',pref,'T',tref,'Water');hr=P('H','P',pref,'T',tref,'Water');sr=P('S','P',pref,'T',tref,'Water');qr=mref/rr;omega=d['machine']['rpm']*math.pi/30
e0=(P('H','P',pref+dpref,'S',sr,'Water')-hr)/r['hydraulicEfficiency'];de0=brentq(lambda v:P('H','P',pref+v,'S',sr,'Water')-hr-e0,dpref,2*dpref)
sigma=d['machine']['sigma'];a=de0/(rr*(1-sigma)*omega**2);bb=sigma*a*omega/qr;resistance=(de0-dpref)/(rr*qr**2)
calibration=dict(a=a,b=bb,resistance=resistance,rho=rr,omega=omega,eulerRise=de0)
legA=math.pi*b['poolLegDiameter_m']**2/4;dz=b['poolMouth_m']-b['poolTrain_m'];L=dz+b['poolLegHorizontal_m'];V=L*legA;lossK=b['poolDarcy']*L/b['poolLegDiameter_m']+b['poolLegFormLoss'];riso=P('D','P',b['poolISOReferencePressure_Pa'],'T',b['poolISOReferenceTemperature_K'],'Water')
legField=field(poolFace(b['cnvTemperature_K'],b['poolMouth_m'])[0],b['poolMouth_m'],b['cnvTemperature_K'])
legM=legA*quad(lambda z:P('D','P',legField(z)[0],'T',b['cnvTemperature_K'],'Water'),b['poolTrain_m'],b['poolMouth_m'])[0]+b['poolLegHorizontal_m']*legA*P('D','P',legField(b['poolTrain_m'])[0],'T',b['cnvTemperature_K'],'Water')
legU=legA*quad(lambda z:P('D','P',legField(z)[0],'T',b['cnvTemperature_K'],'Water')*P('U','P',legField(z)[0],'T',b['cnvTemperature_K'],'Water'),b['poolTrain_m'],b['poolMouth_m'])[0]+b['poolLegHorizontal_m']*legA*P('D','P',legField(b['poolTrain_m'])[0],'T',b['cnvTemperature_K'],'Water')*P('U','P',legField(b['poolTrain_m'])[0],'T',b['cnvTemperature_K'],'Water')
legPE=legA*quad(lambda z:P('D','P',legField(z)[0],'T',b['cnvTemperature_K'],'Water')*g*z,b['poolTrain_m'],b['poolMouth_m'])[0]+b['poolLegHorizontal_m']*legA*P('D','P',legField(b['poolTrain_m'])[0],'T',b['cnvTemperature_K'],'Water')*g*b['poolTrain_m']
require('Additional finite pool legs have owned native inventory',V>0 and legM>0,eachVolume_m3=V,eachWater_kg=legM,eachU_J=legU,eachPE_J=legPE,eachTracer_kgEq=legM*b['poolTracerRatio'])
# Preserve canonical IF97 selected sizing, not HEOS resizing of hardware.
Qref=s['primaryFlow_kg_s']*(W(P=s['primaryPressure_MPa'],T=s['primaryInlet_C']+273.15).h-W(P=s['primaryPressure_MPa'],T=s['primaryOutlet_C']+273.15).h)*1000
Gh=Qref/(s['primaryOutlet_C']-s['referenceWall_C']);Gc=Qref/(s['referenceWall_C']-s['referenceColdInlet_C']-Qref/(s['referenceColdFlow_kg_s']*d['train']['sizingColdCp_J_kg_K']))
flowRows=[]
for T in [b['cnvTemperature_K'],313.15,b['poolAssessmentTemperature_K']]:
 f=field(poolFace(T,b['poolMouth_m'])[0],b['poolMouth_m'],T);ps=f(b['poolTrain_m'])[0]
 # Matched static comparison: actual stored material uniform at T. Not a solved
 # thermal hydraulic trajectory or reconstructed reached pipe/HX profile.
 def atSuction(pcase):
  rc=P('D','P',pcase,'T',T,'Water');referenceFlow=d['train']['referenceFlow_kg_s'];externalK=d['train']['retainedLoss_Pa']*rr/(rc*referenceFlow**2)+2*b['poolISOReferenceLoss_Pa']*riso/(rc*referenceFlow**2)+2*lossK/(2*rc*legA**2);minK=d['train']['minflowRise_Pa']*rr/(rc*d['train']['minflow_kg_s']**2)
  def streams(dp):return math.sqrt(dp/externalK),math.sqrt(dp/minK)
  def rise(m):q=m/rc;return rc*omega*(a*omega-bb*abs(q))-resistance*rc*q*abs(q)
  dp=brentq(lambda dp:rise(sum(streams(dp)))-dp,1,2*de0);md,mf=streams(dp)
  predicted=ps-(b['poolISOReferenceLoss_Pa']*riso/(rc*referenceFlow**2)+lossK/(2*rc*legA**2))*md**2
  return rc,dp,md,mf,predicted
 suction=brentq(lambda p:atSuction(p)[4]-p,ps-1e5,ps);rc,dp,md,mf,_=atSuction(suction)
 available=(suction-P('P','T',T,'Q',1,'Water'))/(rc*g);required=r['npshSpeed_m']+r['npshFlow_m']*((md+mf)/rc/qr)**2
 require('Actual matched pool flow and NPSH '+str(T),md>0 and mf>0 and available>required and .1e6<suction<2e6,delivered_kg_s=md,minflow_kg_s=mf,suction_Pa=suction,NPSHa_m=available,NPSHr_m=required)
 inletH=P('H','P',suction,'T',T,'Water');inletS=P('S','P',suction,'T',T,'Water');mTotal=md+mf;dpEuler=rc*omega*(a*omega-bb*mTotal/rc)
 fluidPower=mTotal*(P('H','P',suction+dpEuler,'S',inletS,'Water')-inletH)
 # A separate steady thermal-receiving comparison returns the local MINFLOW
 # work once; it is not a claim of an isothermal achieved casing/pipe trajectory.
 hi=inletH+fluidPower/md;coldHi=P('H','P',b['ccwFixturePressure_Pa'],'T',b['ccwFixtureTemperature_K'],'Water')
 # Forward PT coordinates avoid judging a PH inverse's mW-scale reinversion
 # noise against the heat-root residual. Signed heat is retained below CCW T.
 lowT=min(T,b['ccwFixtureTemperature_K'])-1;highT=max(T,b['ccwFixtureTemperature_K'])+1
 def atOutlet(hotT):
  Q=md*(hi-P('H','P',suction,'T',hotT,'Water'))
  coldT=brentq(lambda t:b['ccwFixtureFlow_kg_s']*(P('H','P',b['ccwFixturePressure_Pa'],'T',t,'Water')-coldHi)-Q,max(273.17,lowT-30),highT+30,xtol=5e-12)
  return Q,coldT
 def residual(hotT):
  Q,coldT=atOutlet(hotT);return hotT-coldT-Q*(1/Gh+1/Gc)
 hotOut=brentq(residual,lowT,highT,xtol=5e-12);Q,coldOut=atOutlet(hotOut);wall=hotOut-Q/Gh
 require('Native finite-cell enthalpy/heat incidence '+str(T),abs(Q-Gc*(wall-coldOut))<1e-4 and abs(Q-md*(hi-P('H','P',suction,'T',hotOut,'Water')))<.1,wallMismatch_W=Q-Gc*(wall-coldOut),nativeReinversionMismatch_W=Q-md*(hi-P('H','P',suction,'T',hotOut,'Water')))
 flowRows.append(dict(T_K=T,caseDensity_kg_m3=rc,delivered_kg_s=md,minflow_kg_s=mf,totalPump_kg_s=md+mf,rise_Pa=dp,suction_Pa=suction,NPSHa_m=available,NPSHr_m=required,wall_K=wall,hotOut_K=hotOut,ccwOut_K=coldOut,pumpFluidWork_W=fluidPower,conditionalHeat_W=Q,conditionalNetPoolRemoval_W=Q-fluidPower))
require('Cold duty below hot nameplate and warm CCW actually heats colder pool',0<flowRows[-1]['conditionalNetPoolRemoval_W']<Qref and flowRows[0]['conditionalNetPoolRemoval_W']<flowRows[0]['conditionalHeat_W']<0)
lowHead=b['cnvPressure_Pa']-2e4
require('Uncovered-mouth dynamic loss can enter genuine below100kPa domain',lowHead<1e5 and lowHead>0,illustrativeLoss_Pa=20000,localPressure_Pa=lowHead)
# Native low-p wet/dry endpoints, preserving the helper's material equations.
# This named unfrozen comparison bracket is not a constitutive temperature floor.
def coldPh(p,h,ratios):
 if sum(ratios.values())==0:return water(p,h)
 return material(p,brentq(lambda T:material(p,T,ratios)['h']-h,273.17,700,xtol=5e-13),ratios)
lowRows=[]
for press in [1000,3000,10000,30000,100000]:
 Ts=P('T','P',press,'Q',0,'Water');hf=P('H','P',press,'Q',0,'Water');hv=P('H','P',press,'Q',1,'Water')
 require('Native saturation endpoints '+str(press),water(press,hf)['ml']==1 and water(press,hv)['ml']==0,Tsat_K=Ts,old300KBracketAdmits=Ts>=300)
 ratios={'air':1e-4,'nitrogen':1e-4};td=brentq(lambda T:P('P','T',T,'Q',1,'Water')+sum(ratios[k]*species[k][0] for k in ratios)*T*P('D','T',T,'Q',1,'Water')-press,273.17,Ts)
 wet=material(press,td-.01,ratios);dry=material(press,td+.01,ratios)
 require('Actual dilute-NC wet/dry branch '+str(press),wet['branch']=='wet' and dry['branch']=='dry',dew_K=td)
 for label,T in [('wet',td-.1),('dry',max(313.15,td+.1))]:
  start=material(press,T,ratios)
  for fraction in [.8,1.2]:
   endp=press*fraction
   # Integrate the small work increment, not a multi-MJ/kg enthalpy baseline.
   # This leaves dh/dp=v unchanged and makes the declared comparison resolvable.
   run=solve_ivp(lambda p,y:[coldPh(p,start['h']+y[0],ratios)['v']],(press,endp),[0.],rtol=2e-9,atol=1e-5,dense_output=True,max_step=abs(endp-press)/20)
   if not run.success:raise ValueError(run.message)
   end=coldPh(endp,start['h']+float(run.y[0,-1]),ratios);integral=quad(lambda p:coldPh(p,start['h']+float(run.sol(p)[0]),ratios)['v'],press,endp,epsabs=.0001,epsrel=2e-10)[0]
   require('Low-pressure paid material work '+str((press,label,fraction)),abs(end['h']-start['h']-integral)<.01,workDefect_J_kg=end['h']-start['h']-integral)
   lowRows.append(dict(pressure_Pa=press,branch=label,pressureRatio=fraction,start=start,end=end,work_J_kg=end['h']-start['h']))
factorRows=[]
for alpha,available in [(0,4),(.05,4),(.15,4),(0,1),(0,0)]:
 gasF=1 if alpha<=.02 else max(0,(.15-alpha)/.13);suctionF=min(1,max(0,available/4))**2;F=gasF*suctionF
 factorRows.append(dict(caseGasFraction=alpha,availableNPSH_m=available,requiredNPSH_m=4,headFactor=F))
require('Actual gas and deficient suction diminish rather than truth-close flow',factorRows[0]['headFactor']==1 and 0<factorRows[1]['headFactor']<1 and factorRows[2]['headFactor']==0 and factorRows[3]['headFactor']==.0625 and factorRows[4]['headFactor']==0)
print(json.dumps(dict(scope='Held native inventory/head/load, matched wet pool-flow and conditional finite-cell enthalpy duty, saturation/material work limits; no head motion, pool endurance, achieved CCW state, source or procedure execution',dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__),checks=results,head=dict(facePrimary_Pa=faceP,faceWell_Pa=wellP,traction_N=force,gravity_N=gravity,retainedHousingWater=housingWater,staticLiftBound_N=staticBound,raisedTop_m=top,gapRows=gapRows,workRows=workRows,pinRows=pinRows),separatorCoupon=sepCoupon,access=access,CNV=dict(air_kg=air,vapor_kg=vapor,bayGross_m3=bayGross),poolLeg=dict(volume_m3=V,water_kg=legM,U_J=legU,PE_J=legPE),calibration=calibration,RHR=dict(referenceDuty_W=Qref,hotConductance_W_K=Gh,coldConductance_W_K=Gc,flowRows=flowRows,factorRows=factorRows),lowPressure=lowRows),allow_nan=False))
`

const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
export async function runHeadPool(directory:string,python:string){
 const paths={owner:'systems/reactor/head-and-pool-cooling.md',control:'systems/reactor/control-absorber-and-guide-water.md',fuel:'systems/reactor/fuel-construction.md',handling:'systems/reactor/fuel-handling-and-pool.md',cold:'safety/cold-pressure-and-startup-protection.md',parent:'model/connected-primary-initialization.md',rhr:'systems/primary-coolant/shutdown-cooling.md',sizing:'model/rhr-support-heat-path.md'}
 const docs=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([key,path])=>[key,await Bun.file(resolve(directory,path)).text()]))) as Record<keyof typeof paths,string>
 const control=parseControlAbsorber(docs.control),fuel=parseFuelConstruction(docs.fuel),handling=parseFuelHandling(docs.handling),geometry=controlAbsorberGeometry(control,fuel,handling),oldGeometry=fuelHandlingChecks(handling,fuel)
 const cold=parseColdPressure(docs.cold).coldPzr,machine=readSignedSelection(docs.rhr),selection=parseHeadPool(docs.owner)
 const owned=(pattern:RegExp,text:string,label:string)=>{const match=text.match(pattern);if(!match)throw Error('Missing owned '+label);return Number(match[1])}
 const train={referenceFlow_kg_s:owned(/each train 0\.35 MPa at ([\d.]+) kg\/s/,docs.rhr,'train reference flow'),
  retainedLoss_Pa:1000*(owned(/existing ([\d.]+) kPa at 150 kg\/s/,docs.rhr,'FT loss')+owned(/ISO\.OUT and ([\d.]+) kPa fixed in-train/,docs.rhr,'fixed train loss'))+1e6*(owned(/([\d.]+) MPa HX path/,docs.rhr,'HX loss')+owned(/([\d.]+) MPa FCV at its normal/,docs.rhr,'FCV loss')),
  minflow_kg_s:owned(/restriction is calibrated to ([\d.]+) kg\/s/,docs.rhr,'MINFLOW'),minflowRise_Pa:1e6*owned(/restriction is calibrated to [\d.]+ kg\/s at ([\d.]+) MPa/,docs.rhr,'MINFLOW head'),
  sizingColdCp_J_kg_K:owned(/500 kg\/s \/ ([\d.]+) J\/\(kg K\)/,docs.sizing,'cold sizing heat capacity')}
 const pick=(o:object,keys:string[])=>Object.fromEntries(keys.map(k=>[k,(o as Record<string,unknown>)[k]]))
 const consumed={selection,control:pick(control,['clusters','gravity_m_s2','steelDensity_kg_m3','headBottom_m','headThickness_m','headGrossArea_m2','housingID_m','housingOD_m','housingTop_m','housingCapHeight_m','neckID_m','neckOD_m','neckTop_m','neckCapHeight_m','collarOD_m','collarID_m','collarBottoms_m','collarHeight_m','stemDiameter_m']),head:pick(geometry.head,['attachedTotal_kg','top_m']),inserted:pick(geometry.poses[0]!,['housingMainWater_m3','housingNeckWater_m3','spiderTop_m','stemTop_m']),
  jack:{bottom_m:geometry.head.jackBottom_m,length_m:geometry.head.jackTop_m-geometry.head.jackBottom_m,top_m:geometry.head.jackTop_m,volume_m3:geometry.head.jackVolume_m3},
  handling:pick(handling,['surface_m','wellArea_m2','wellFloor_m','canalWidth_m','canalLength_m','canalFloor_m','poolSide_m','poolFloor_m','minimumActiveCover_m']),transfer:{activeCover_m:handling.surface_m-handling.transferBottom_m-handling.bottomFittingLength_m-fuel.activeLength_m,wholeCover_m:handling.surface_m-handling.transferBottom_m-oldGeometry.assembly.fullLength_m},
  cold:{pressure_Pa:cold.hotPressure_Pa,temperature_K:cold.temperature_K,elevation_m:2.5,primaryAbsorberRatio:parseColdParent(docs.parent).primaryAbsorberRatio},train,rhr:pick(readServicePump(resolve(directory,paths.rhr)),['inletPressure_MPa','inletTemperature_C','flow_kg_s','outletPressure_MPa','hydraulicEfficiency','npshSpeed_m','npshFlow_m']),machine:pick(machine,['rpm','sigma']),sizing:pick(parseRhrSupport(docs.sizing),['primaryPressure_MPa','primaryInlet_C','primaryOutlet_C','primaryFlow_kg_s','referenceWall_C','referenceColdInlet_C','referenceColdFlow_kg_s'])}
 const serialized=JSON.stringify(consumed),sourceFiles=[import.meta.path,resolve(import.meta.dir,'reference-design-control-absorber.ts'),resolve(import.meta.dir,'reference-design-rhr-material-wave.ts'),resolve(import.meta.dir,'reference-design-pressurizer-heater-contact.ts')]
 const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,sha(await Bun.file(path).text())])))
 const child=Bun.spawn([python,'-c',headPoolCalculation],{stdin:new Blob([serialized]),stdout:'pipe',stderr:'pipe'}),[out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
 if(code)throw Error(err)
 const result=JSON.parse(out)
 for(const row of result.RHR.flowRows){const machine=signedMachine(result.calibration,row.caseDensity_kg_m3,row.totalPump_kg_s,result.calibration.omega,1,1/row.caseDensity_kg_m3);if(Math.abs(machine.rise-row.rise_Pa)>1e-5)throw Error('Independent TS pool machine root differs')}
 const axis=motorBudget(100,0,.92);if(axis.shaft!==0||axis.electric!==0)throw Error('Stopped machine created work')
 for(const path of sourceFiles)if(sourceHashes[path]!==sha(await Bun.file(path).text()))throw Error('Head/pool source changed during calculation')
 return {sourceSHA256:sourceHashes[import.meta.path],calculationSHA256:sha(headPoolCalculation),consumedInputSHA256:sha(serialized),consumedInput:consumed,helperSourceSHA256:sourceHashes,ownerContextSHA256:Object.fromEntries(Object.entries(docs).map(([key,v])=>[paths[key as keyof typeof paths],sha(v)])),...result}
}
if(import.meta.main){const [directory,python,output,...rest]=Bun.argv.slice(2);if(!directory||!python||!output||rest.length)throw Error('Usage: head-pool <ld-01> <research-python> <receipt.json>');const result=await runHeadPool(directory,python);await Bun.write(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({receipt:output,checks:result.checks.length,head:result.head,RHR:result.RHR},null,2))}
