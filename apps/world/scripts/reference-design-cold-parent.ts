/** Native static inventory / finite-storage screen. No plant, pressure clamp or time integrator. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import { parseInitializationBasis } from './reference-design-initialization'
import { parseConnectedFuel } from './reference-design-connected-fuel'
import { parsePrimaryMechanics, foldedGeometry } from './reference-design-primary-mechanics'
import { parseSurgeRoute, resolveSurgeRoute } from './reference-design-surge-route'
import { parsePrhrGeometry, auditPrhrGeometry } from './reference-design-prhr-geometry'
import { parsePrhrIsolation, auditPrhrIsolation } from './reference-design-prhr-isolation'
import { parseGeometryBasis, tankGeometry } from './reference-design-cmt-geometry'
import { parseBalancePathBasis, checkBalancePath } from './reference-design-cmt-balance-path'
import { parseColdPressure, coldPzrPreparationPython, coldPressureCalculation } from './reference-design-cold-pressure'
import { coldPreparation, vacuumSelection } from './reference-design-cold-vacuum'
import { parseColdNuclear } from './reference-design-cold-nuclear'
import { parseSourceFeedback } from './reference-design-source-feedback'
import { parseServicePump } from './reference-design-service-pump-continuation'

const positive = z.number().finite().positive()
const schema = z.object({ primaryAbsorberRatio: positive, passiveAbsorberRatio: positive,
  warm_K: positive, ccw_K: positive, site_K: positive, passive_K: positive, room_K: positive,
  qualificationInput_s: positive, comparisonPower_W: positive }).strict()
export function parseColdParent(document: string) {
  const blocks = [...document.matchAll(/^```reference-cold-parent\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one cold-parent comparison input')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function coldSourceIsolationAssessment(accOpen: boolean, balanceOpen: boolean) {
  return { coldAccumulatorIsolated: !accOpen, pressureBalancedCmtCredited: balanceOpen,
    // This is design-alignment bookkeeping, not a flow/protection model or installed permissive.
    chargedSourceColdPreparationAccepted: !accOpen }
}
/** Exact fresh-preparation distinction, not an installed protection evaluator.
 * At t0 an accepted initial setting and denied withdrawal are independent. */
export function freshColdInputAssessment(evidence:'LOW_BOUND'|'UNAVAILABLE'|'UNKNOWN') {
  return { healthyLowBoundSupportsInitialColdAlignment:evidence==='LOW_BOUND',acceptedColdSettingRetained:true,
    qualificationTimer_s:0,ordinaryWithdrawalQualified:false,operationalPowerToColdQualified:false,
    unavailableEvidenceIsLowBound:false }
}

/** Native thermal ledger fixtures. Reviewed literal inventory descriptions are
 * checked before use; they are not an automatic prose-to-model translation.
 * Geometry-resolved primary/passive stores are assembled separately below. */
function thermalInventory(selection: z.infer<typeof schema>, documents: Record<string,string>) {
  const { warm_K:w, ccw_K:c, site_K:s, room_K:a, passive_K:p }=selection
  const expectOwner=(owner:string,fragment:string)=>{
    if(!documents[owner]?.includes(fragment))throw Error('Reconcile cold thermal inventory with '+owner+': '+fragment)
  }
  expectOwner('regeneration','HP admission volume of 10 m³')
  expectOwner('regeneration','HP intermediate extraction volume of 20 m³')
  expectOwner('regeneration','reheater process volume 30 m³')
  expectOwner('regeneration','LP intermediate volumes 500 m³ and 1000 m³')
  expectOwner('regeneration','20 m³ heating-side shell')
  expectOwner('regeneration','200 MJ/K wall')
  expectOwner('regeneration','shell volumes of 20, 25, 30 and 40 m³')
  expectOwner('regeneration','wall heat capacities 30, 40, 50 and 70 MJ/K')
  expectOwner('regeneration','Each tube side has 10 m³')
  expectOwner('support','250 m³ mixed supply cell, a 200 m³ return header and a 50 m³ cooler water cell')
  expectOwner('support','100 MJ/K heat-exchanger wall')
  expectOwner('support','100 m³; the generator side holds 50 m³')
  expectOwner('support','20 MJ/K metal store')
  expectOwner('support','a10MJ/K metal store')
  expectOwner('support','each use2MJ/K')
  expectOwner('support','100MJ/K equivalent oil/metal store')
  expectOwner('support','each with200MJ/K')
  expectOwner('support','motor has a100MJ/K')
  expectOwner('support','CCW/SW motor has a2MJ/K')
  expectOwner('support','transformer has a100MJ/K')
  expectOwner('rhr','3 m³ primary mixed store and the 5 m³ CCW HX-side store')
  expectOwner('rhr','50 MJ/K')
  expectOwner('condenser','each 250 m³')
  expectOwner('inventory','initially 12 m³ water at 40°C')
  expectOwner('inventory','initially 16 m³ at 40°C')
  expectOwner('inventory','initially 8 m³ at 40°C')
  expectOwner('inventory','initially 2 m³ at 40°C')
  const liquid: [string,number,number,number][]=[['FW.TANK',120,w,101325],['INV.BLEND',12,w,101325],['INV.WATER',16,w,101325],['INV.CONCENTRATE',8,w,101325],['INV.RECEIVER',2,w,101325],['WST',1200,p,101325],['CW.TUBE.1',250,s,101325],['CW.TUBE.2',250,s,101325],['SW.GEN',50,s,101325]]
  const wet: [string,number,number,number,number][]=[['HP.ADM',10,0,w,101325],['HP.EXT',20,0,w,101325],['SEP',100,10,w,101325],['RH.PROCESS',30,0,w,101325],['LP.1',500,0,w,101325],['LP.2',1000,0,w,101325],['RH.SHELL',20,5,w,101325]]
  const metal: [string,number,number][]=[['RH.WALL',200e6,w],['TG.OIL',100e6,w],['GEN.METAL',100e6,a],['VAC.KO.METAL',1e6,w],['LETDOWN.METAL',2e6,w]]
  for(let i=0;i<4;i++){liquid.push(['H'+(i+1)+'.TUBE',10,w,101325]);wet.push(['H'+(i+1)+'.SHELL',[20,25,30,40][i]!,[20,25,30,40][i]!/4,w,101325]);metal.push(['H'+(i+1)+'.WALL',[30,40,50,70][i]!*1e6,w])}
  for(const loop of ['A','B']){
    for(const [part,v] of [['SUPPLY',250],['RETURN',200],['COOLER',50]] as const)liquid.push(['CCW.MAIN.'+loop+'.'+part,v,c,.5e6])
    liquid.push(['CCW.JACKETS.'+loop,loop==='A'?13:21,c,.5e6],['RHR.CCW.'+loop,5,c,.5e6],['SW.HX.'+loop,100,s,101325])
    wet.push(['CCW.EXPANSION.'+loop,10,5,c,.5e6])
    metal.push(['CCW.WALL.'+loop,100e6,c],['RHR.WALL.'+loop,50e6,w],['RHR.MOTOR.'+loop,2e6,w],['FW.MOTOR.'+loop,10e6,w],['ROOM.'+loop,200e6,a],['CW.MOTOR.'+loop,100e6,a],['CCW.MOTOR.'+loop,2e6,a],['SW.MOTOR.'+loop,2e6,a])
    for(const n of [1,2])metal.push(['RCP.MOTOR.'+loop+n,20e6,c])
  }
  for(const id of ['UNIT','RESERVE'])metal.push([id+'.TRANSFORMER',100e6,a])
  for(const id of ['COND','CHARGE'])metal.push([id+'.MOTOR',2e6,w])
  return {liquid,wet,metal,meaning:'Finite native thermal coordinates and owned capacity integrals, not a thermal trajectory, local geometric PE ledger or instantly available combined sink'}
}

export const coldParentCalculation = String.raw`
import json,sys,math,platform
import numpy as np,scipy,CoolProp
from scipy.integrate import solve_ivp,quad
from scipy.optimize import brentq
from CoolProp.CoolProp import PropsSI as P
d=json.load(sys.stdin);b=d['pressure'];sel=d['selection'];g=9.80665;checks=[]
def require(name,condition,**v):
 if not condition:raise ValueError(name+': '+str(v))
 checks.append(dict(name=name,**v))
${coldPzrPreparationPython}
pzr=preparation;anchor=b['coldPzr'];T0=anchor['temperature_K'];p0=anchor['hotPressure_Pa'];z0=2.5
s0=P('S','P',p0,'T',T0,'Water')
def water(p,T):return np.array([P('D','P',p,'T',T,'Water'),P('U','P',p,'T',T,'Water')])
def hydro(pref,zref,T=None,zmin=-4,zmax=18.5):
 entropy=s0 if T is None else None
 def density(p):return P('D','P',p,'S',entropy,'Water') if T is None else P('D','P',p,'T',T,'Water')
 low=solve_ivp(lambda z,p:[-g*density(float(p[0]))],(zref,zmin),[pref],rtol=1e-11,atol=1e-5,dense_output=True) if zmin<zref else None
 high=solve_ivp(lambda z,p:[-g*density(float(p[0]))],(zref,zmax),[pref],rtol=1e-11,atol=1e-5,dense_output=True) if zmax>zref else None
 require('native hydrostatic seed',all(x.success for x in [low,high] if x is not None))
 def read(z):
  if not zmin<=z<=zmax:raise ValueError('Hydrostatic seed requested outside actual prepared route')
  p=pref if z==zref else float((high if z>zref else low).sol(z)[0]);t=P('T','P',p,'S',entropy,'Water') if T is None else T
  return p,t
 return read
mainField=hydro(p0,z0);rows=[]
def region(name,V,zfun,field,ratio):
 def at(f):
  z=zfun(f);p,t=field(z);rho,u=water(p,t);return np.array([rho,rho*u,rho*g*z,t,p])
 values=np.array([quad(lambda f:at(f)[i],0,1,epsabs=1e-5,epsrel=2e-10)[0] for i in range(5)])
 row=dict(owner=name,volume_m3=V,water_kg=V*values[0],U_J=V*values[1],PE_J=V*values[2],
  meanTemperature_K=values[3],meanPressure_Pa=values[4],tracer_kg_eq=V*values[0]*ratio,initialMomentum=0)
 require('native finite store '+name,V>0 and row['water_kg']>0 and row['meanPressure_Pa']>P('P','T',row['meanTemperature_K'],'Q',0,'Water'))
 rows.append(row);return row
V=d['base']['volumes_m3'];m=d['mechanics'];core=d['core'];A=core['geometry']['flowArea_m2'];L=core['activeLength_m'];ratio=sel['primaryAbsorberRatio']
region('MAIN.DOWNCOMER',V[0],lambda f:m['downcomerBottom_m']+f*(m['downcomerTop_m']-m['downcomerBottom_m']),mainField,ratio)
# Current LOWER is a mixed mean-density head owner, not the retired exact-profile reservoir.
pl,tl=mainField(-2);pc=brentq(lambda p:p-water(p,tl)[0]*g-pl,pl,pl+2e4);rl,ul=water(pc,tl)
lower=dict(owner='MAIN.LOWER',volume_m3=V[1],water_kg=V[1]*rl,U_J=V[1]*rl*ul,PE_J=V[1]*rl*g*(-3),meanTemperature_K=tl,meanPressure_Pa=pc,tracer_kg_eq=V[1]*rl*ratio,initialMomentum=0)
rows.append(lower);require('current mixed LOWER port matches',abs(pc-rl*g-pl)<1e-5)
for half in range(2):region('MAIN.CORE.'+str(half+1),A*L/2,lambda f,h=half:-L/2+(h+f)*L/2,mainField,ratio)
region('MAIN.UPPER',V[4],lambda f:2+2*f,mainField,ratio)
sg=d['folded'];R=sg['radius_m'];up=sg['riseLength_m'];arc=sg['crownLength_m'];length=m['sgDevelopedLength_m']
def sgz(f):
 x=f*length
 if x<=up:return 2.5+x
 if x<=up+arc:return 12-R+R*math.sin((x-up)/R)
 return 12-R-(x-up-arc)
for loop in ['A','B']:
 region('MAIN.HOT.'+loop,V[5 if loop=='A' else 6],lambda f:2.5,mainField,ratio)
 region('MAIN.SG.'+loop,V[7 if loop=='A' else 8],sgz,mainField,ratio)
 for pump in [1,2]:region('MAIN.RCP.'+loop+str(pump),m['pumpPassageVolume_m3'],lambda f:3,mainField,ratio)
 region('MAIN.COLD.'+loop,m['coldHeaderVolume_m3'],lambda f:3-m['coldHeaderHeight_m']/2+f*m['coldHeaderHeight_m'],mainField,ratio)
mainRows=rows.copy();mainVolume=sum(r['volume_m3'] for r in mainRows)
require('main physical volume replaces two effective core cells',abs(mainVolume-(sum(V)-V[2]-V[3]+A*L))<1e-10)
require('main cold passages replace aggregate once',2*m['pumpPassageVolume_m3']+m['coldHeaderVolume_m3']==V[9]==V[10])
for loop in ['A','B']:region('DVI+NECK.'+loop,.5+math.pi*.2**2/4,lambda f:3,mainField,ratio)
route=d['surge'];rz=route['sourceElevation_m'];radius=route['bendRadius_m']
def surgez(f):
 x=f*route['developedLength_m']
 if x<=route['risingStart_m']:return rz
 if x<=route['verticalStart_m']:return rz+radius*(1-math.cos((x-route['risingStart_m'])/radius))
 return rz+radius+x-route['verticalStart_m']
# PZR owner selects centroid pressure seeds on its finite 300 K line fields.
coldLiquid=hydro(p0,z0,T0)
region('SURGE',route['liquidVolume_m3'],surgez,coldLiquid,ratio)
for name in ['SPRAY.CONTROL','SPRAY.MANUAL']:region(name,math.pi*.1**2/4*25,lambda f:3+15.5*f,coldLiquid,ratio)
pr=d['prhr'];audit=d['prhrAudit'];iso=d['isolation'];t=pr['tubes'];coldBank=hydro(mainField(3)[0],3,sel['passive_K'])
prhrStart=len(rows);area=math.pi*pr['hotConnector']['id_m']**2/4
region('PRHR.HOT_SEAT',iso['geometry']['closedHotConnectedWater_m3'],lambda f:2.5,mainField,ratio)
region('PRHR.BANK_SEAT',iso['geometry']['closedHotConnectedWater_m3'],lambda f:2.5,coldBank,ratio)
region('PRHR.RISER',area*iso['geometry']['remainingHotConnector_m'],lambda f:2.5+f*(t['top_m']-2.5),coldBank,ratio)
for label,z in [('UPPER',t['top_m']),('LOWER',t['bottom_m'])]:region('PRHR.HEADER.'+label,audit['headers']['water_m3']/2,lambda f,z=z:z,coldBank,ratio)
ta=math.pi*t['id_m']**2/4*t['count'];r=t['bendRadius_m'];drop=t['top_m']-t['bottom_m']-2*r
for name,vol,fun in [('TOP',ta*t['straightLeg_m'],lambda f:t['top_m']),('TOP_BEND',ta*math.pi*r/2,lambda f:t['top_m']-r*(1-math.cos(f*math.pi/2))),('VERTICAL',ta*drop,lambda f:t['top_m']-r-f*drop),('BOTTOM_BEND',ta*math.pi*r/2,lambda f:t['bottom_m']+r*(1-math.sin(f*math.pi/2))),('BOTTOM',ta*t['straightLeg_m'],lambda f:t['bottom_m'])]:region('PRHR.TUBE.'+name,vol,fun,coldBank,ratio)
region('PRHR.RETURN',audit['coldConnector']['water_m3'],lambda f:3+f*(t['bottom_m']-3),coldBank,ratio)
require('PRHR disc displacement counted once',abs(sum(r['volume_m3'] for r in rows[prhrStart:])-iso['geometry']['revisedPrimaryWater_m3'])<1e-10)
connectedRows=rows.copy()
for loop in ['A','B']:
 cmtField=hydro(mainField(3)[0],3,sel['warm_K'])
 for q in d['cmtQuadrature']:region('CMT.'+loop+'.'+str(q['z']),q['volume'],lambda f,z=q['z']:z,cmtField,sel['passiveAbsorberRatio'])
 bal=d['balance'];gb=d['cmt'];start=len(rows)
 # Existing main horizontal/riser, roof, feed and body are disjoint water.
 region('CMT.BAL.MAIN.'+loop,bal['mainVolume_m3'],lambda f:3+max(0.,f*bal['mainLength_m']-bal['headerHorizontal_m']),cmtField,sel['passiveAbsorberRatio'])
 region('CMT.BAL.ROOF.'+loop,bal['roofVolume_m3'],lambda f:gb['top_m'],cmtField,sel['passiveAbsorberRatio'])
 region('CMT.BAL.FEED.'+loop,bal['feedVolume_m3'],lambda f:gb['top_m']-f*bal['feedLength_m'],cmtField,sel['passiveAbsorberRatio'])
 for i,part in enumerate(bal['bodySegments']):region('CMT.BAL.BODY.'+loop+'.'+str(i),part['volume_m3'],lambda f,part=part:part['bottom_m']+f*(part['top_m']-part['bottom_m']),cmtField,sel['passiveAbsorberRatio'])
 require('BAL group volume disjoint '+loop,abs(sum(r['volume_m3'] for r in rows[start:])-gb['balanceWater_m3'])<1e-11)
 # Separate isolated train preparation; no HOT pressure imposed behind its real valves.
 region('RHR.TRAIN.'+loop,4,lambda f:-2,hydro(.3e6,-2,sel['warm_K']),ratio)
region('RHR.CAVITY',.05,lambda f:2.5,hydro(.3e6,2.5,sel['warm_K']),ratio)
region('RHR.LINE',1.5,lambda f:2.5-15*f if f<.3 else -2,hydro(.3e6,-2,sel['warm_K']),ratio)
region('RHR.HEADER',.5,lambda f:-2,hydro(.3e6,-2,sel['warm_K']),ratio)
coreRows=[r for r in mainRows if r['owner'].startswith('MAIN.CORE')];coreM=sum(r['water_kg'] for r in coreRows);coreB=sum(r['tracer_kg_eq'] for r in coreRows)
ref=d['nuclearReference'];nuc=d['nuclear'];u=coreM/ref['waterMass_kg'];C=1e6*coreB/coreM
rho=nuc['waterWorth']*(u-1)+nuc['absorberWorth_pcm_ppmEq']*1e-5*(C*u-nuc['absorberReference_ppmEq'])+nuc['dopplerWorth_pcm_sqrtK']*1e-5*(math.sqrt(T0)-ref['Dref_sqrtK'])-nuc['bankWorth']*nuc['bankReference']-nuc['xenonWorth']-d['samariumWorth']
require('actual native core mass/tracer inserted subcritical',rho<-.02,coreWater_kg=coreM,coreTracer_kg_eq=coreB,reactivity_pcm=rho*1e5)
sourceRate=nuc['source']['birthEmission_neutrons_s']*nuc['source']['couplingIntensity_per_neutron']*2**(-nuc['source']['ageAtPreparation_year']/nuc['source']['halfLife_year'])
sourceHeatUpper_W=d['kinetics']['source']['generationTime_s']*sourceRate/.02*3e9
dc=d['dc'];electrical_W=(3*3000+2*dc['continuousDuty_W'])/dc['converterEfficiency'];electrical_W=electrical_W*1.01+20000
require('stopped aligned source electrical comparison allowance',sourceHeatUpper_W+electrical_W<sel['comparisonPower_W'],sourceHeatUpper_W=sourceHeatUpper_W,electricalInput_W=electrical_W)
# Native whole-volume capacity counterfactual, NOT the discrete parent or a pressure transient.
# Connected water includes the SG-connected blind PRHR bank; isolated CMT/ACC/RHR stay separate.
waterM=sum(r['water_kg'] for r in connectedRows)+sum(r['liquid_kg']+r['steam_kg'] for r in pzr['regions'])
airM=sum(r['air_kg'] for r in pzr['regions']);volume=sum(r['volume_m3'] for r in connectedRows)+pzr['volume_m3']
def expansion(T):
 pv=P('P','T',T,'Q',1,'Water');rv=P('D','T',T,'Q',1,'Water');uv=P('U','T',T,'Q',1,'Water')
 def state(p):
  rl,ul=water(p,T);vg=(volume-waterM/rl)/(1-rv/rl);ma=(p-pv)*vg/(287*T)
  return vg,ma,(waterM-rv*vg)*ul+rv*vg*uv+airM*718*(T-298.15)
 p=brentq(lambda p:state(p)[1]-airM,max(pv+1,1e4),3.9e6);vg,_,U=state(p)
 return dict(T_K=T,p_Pa=p,gasVolume_m3=vg,water_kg=waterM,air_kg=airM,U_J=U)
warm=expansion(sel['warm_K']);energy=sel['comparisonPower_W']*sel['qualificationInput_s']
boostedT=brentq(lambda T:expansion(T)['U_J']-warm['U_J']-energy,sel['warm_K'],sel['warm_K']+1)
boosted=expansion(boostedT)
require('native warm gross expansion screen below cold envelope',boosted['gasVolume_m3']>0 and boosted['p_Pa']+g*1001*22.5<4e6,fullHeightHeadAllowance_Pa=g*1001*22.5,**boosted)
require('finite added comparison energy retained',abs(boosted['U_J']-warm['U_J']-energy)<1,increment_J=energy)
accN=5e6*15/(296.8*sel['passive_K']);accField=hydro(5e6,6.5,sel['passive_K'])
acc=region('ACC.A water',35,lambda f:3+3.5*f,accField,sel['passiveAbsorberRatio'])
region('ACC.B water',35,lambda f:3+3.5*f,accField,sel['passiveAbsorberRatio'])
intakeField=hydro(101325,5,sel['site_K'],0,5)
region('SITE.INTAKE',d['lowPressure']['bayVolume_m3'],lambda f:5*f,intakeField,0)
thermal=[]
def thermalLiquid(name,V,T,p):
 r,u=water(p,T);thermal.append(dict(owner=name,kind='native liquid thermal coordinate',volume_m3=V,T_K=T,p_Pa=p,water_kg=V*r,U_J=V*r*u))
def thermalWet(name,V,Vl,T,p):
 pv=P('P','T',T,'Q',1,'Water');rv=P('D','T',T,'Q',1,'Water');uv=P('U','T',T,'Q',1,'Water');vg=V-Vl;ma=(p-pv)*vg/(287*T);rl,ul=water(p,T)
 require('thermal native partial pressure '+name,0<=Vl<=V and p>pv)
 thermal.append(dict(owner=name,kind='native wet air/water thermal coordinate',volume_m3=V,liquidVolume_m3=Vl,T_K=T,p_Pa=p,water_kg=Vl*rl+vg*rv,air_kg=ma,nitrogen_kg=0,U_J=Vl*rl*ul+vg*rv*uv+ma*718*(T-298.15)))
for x in d['thermal']['liquid']:thermalLiquid(*x)
for x in d['thermal']['wet']:thermalWet(*x)
for stage in [1,2,3]:
 for loop in ['A','B']:thermalWet('ADS'+str(stage)+'.CHAMBER.'+loop,.02,0,T0,pzr['actualOuterTopTrace_Pa'])
for name,C,T in d['thermal']['metal']:thermal.append(dict(owner=name,kind='owned constant-capacity thermal store',C_J_K=C,T_K=T,EaboveZeroC_J=C*(T-273.15)))
for machine in d['service']:
 r=P('D','P',machine['inletPressure_MPa']*1e6,'T',machine['inletTemperature_C']+273.15,'Water');v=.05*machine['flow_kg_s']/r;count=2 if machine['id']=='FW' else 1
 for i in range(count):thermalLiquid(machine['id']+'.CASE.'+str(i+1),v,sel['warm_K'],101325)
 if machine['id']=='CHARGE':thermalLiquid('CHARGE.DISCHARGE.BODY',v,sel['warm_K'],101325)
 require('service finite case ownership '+machine['id'],v>0,volume_m3=v,count=count)
for name,Q,T,source in d['lowPressure']['cases']:thermalLiquid(name,.05*Q,T,intakeField(0)[0] if source=='SITE' else .5e6)
condVolume=.05*d['lowPressure']['condensateReference_kg_s']/P('D','T',sel['warm_K'],'Q',0,'Water')
thermalLiquid('COND.CASE',condVolume,sel['warm_K'],hydro(101325,0,sel['warm_K'],-5,0)(-5)[0])
prep=d['secondary'];T=prep['temperature_K'];p=prep['pressure_Pa']
for loop in ['A','B']:thermalWet('SG.'+loop,prep['SG']['volume_m3'],prep['SG']['volume_m3']-prep['SG']['gasVolume_m3'],T,p)
thermalWet('COND',prep['COND']['volume_m3'],prep['COND']['volume_m3']-prep['COND']['gasVolume_m3'],T,p)
thermalWet('MSHEADER',prep['MSHEADER']['volume_m3'],0,T,p)
thermalWet('VAC.KO',prep['knockoutVolume_m3'],0,T,p)
thermalWet('VAC.CASE',d['vacuum']['caseVolume_m3'],0,T,p)
for name,C in [('SG.A.METAL',prep['SG']['metalCapacity_J_K']),('SG.B.METAL',prep['SG']['metalCapacity_J_K']),('COND.WALLS',prep['COND']['metalCapacity_J_K']),('VAC.BODY',d['vacuum']['bodyCapacity_J_K'])]:thermal.append(dict(owner=name,kind='owned capacity integral',C_J_K=C,T_K=T,EaboveZeroC_J=C*(T-273.15)))
require('warm receivers retain heat at zero circulation',max(x['T_K'] for x in thermal)==sel['warm_K'] and sum(x.get('EaboveZeroC_J',0) for x in thermal)>0)
require('CCW main versus additional water counted once',sum(x['volume_m3'] for x in thermal if x['owner'].startswith('CCW.MAIN'))==1000)
adverse=dict(coldAccDrive_Pa=accField(3)[0]-mainField(3)[0]-2000,accumulatorIsolationOpenAdmitted=False,
 lowerNuclearDomainAdmitted=bool(min(sel['site_K'],sel['passive_K'])>=nuc['fuelRange_K'][0]),missingSourceEvidenceWithdrawalAdmitted=False,
 continuingStorageQualified=False,blockedColdReliefProtectionQualified=False)
require('charged ACC check is not cold isolation',adverse['coldAccDrive_Pa']>0)
require('lower nuclear applicability failure retained',not adverse['lowerNuclearDomainAdmitted'])
initialInputs=dict(physicalIntensity=0,sourceEvidence='healthy LOW bound, not AVAILABLE',sourceUpperBound=1e-10,newTimers_s=0,
 preparedColdAlignment=True,ordinaryWithdrawalQualified=False,operationalPowerToColdQualified=False,
 pzrLevel_m=pzr['quantizedIndication_m'],sgLevel_m=(prep['SG']['volume_m3']-prep['SG']['gasVolume_m3'])/12,
 pressureResetFiveSecondHistoryQualified=False,meaning='t0 native/acquisition inputs and authored setting; not an installed protection execution or five seconds of advancing history')
require('native fresh acquisition inputs support LOW not withdrawal',initialInputs['sourceUpperBound']<.01 and 3.5<=initialInputs['pzrLevel_m']<=9.5 and 5.25<=initialInputs['sgLevel_m']<=8.25)
print(json.dumps(dict(scope='Native static cold preparation and gross uniform-temperature finite-capacity counterfactual; no achieved history, dynamic heat removal or protective pressure bound',
 packages=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__),checks=checks,mainVolume_m3=mainVolume,
 primaryRows=connectedRows,otherNativeRows=rows[len(connectedRows):],coldPzr=pzr,initialAcquisitionInputs=initialInputs,core=dict(water_kg=coreM,tracer_kg_eq=coreB,waterRatio=u,reactivity_pcm=rho*1e5),
 expansion=dict(warm=warm,finiteEnergy=boosted,addedEnergy_J=energy,volume_m3=volume),isolatedAcc=dict(eachNitrogen_kg=accN,eachWater_kg=acc['water_kg'],eachWater_U_J=acc['U_J'],eachNitrogen_U_J=accN*742*(sel['passive_K']-298.15),gasTemperature_K=sel['passive_K'],gasPressure_Pa=5e6),
 pzrTracer_kg_eq=[dict(lane=r['lane'],lo_m=r['lo_m'],liquidTracer_kg_eq=r['liquid_kg']*ratio) for r in pzr['regions']],
 thermalInventory=thermal,thermalLedgerMeaning=d['thermal']['meaning'],sourceHeatUpper_W=sourceHeatUpper_W,sourceHeatBoundCondition='Fixed inserted source with retained reactivity <= -0.02; not an evolving-plant heat bound',electricalInput_W=electrical_W,adverse=adverse)))
`

async function run(wiki: string, nuclearReceipt: string, python: string) {
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const sourceText=await Bun.file(import.meta.path).text(),sourceSHA256=hash(sourceText)
  const paths = { parent:'model/connected-primary-initialization.md', mechanics:'systems/primary-coolant/mechanical-energy-and-geometry.md',
    fuel:'systems/reactor/fuel-construction.md', surge:'systems/primary-coolant/surge-route.md', prhr:'systems/passive-cooling/residual-heat-exchanger.md',
    cmt:'systems/passive-cooling/cmt-receiving-geometry.md', pressure:'safety/cold-pressure-and-startup-protection.md',
    nuclear:'systems/reactor/cold-source-and-startup.md', kinetics:'systems/reactor/kinetics.md', history:'systems/reactor/heat-and-history.md',
    poisons:'systems/reactor/shutdown-and-fuel-response.md',dc:'systems/electrical/dc-storage.md',
    support:'systems/support-services/thermal-water-and-air.md',regeneration:'systems/steam-power/turbine-and-regeneration-dynamics.md',
    rhr:'systems/primary-coolant/shutdown-cooling.md',inventory:'systems/primary-coolant/inventory-and-chemistry.md',
    feed:'systems/feedwater/equipment.md',condenser:'systems/steam-power/condenser-and-cooling.md' }
  const docs = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([k,p])=>[k,await Bun.file(resolve(wiki,p)).text()]))) as Record<keyof typeof paths,string>
  const core=parseConnectedFuel(docs.parent,docs.fuel),mechanics=parsePrimaryMechanics(docs.mechanics),prhr=parsePrhrGeometry(docs.prhr)
  const cmt=parseGeometryBasis(docs.cmt),tank=tankGeometry(cmt),cmtQuadrature=[]
  for(let i=0;i<64;i++){const lo=tank.mouth+(cmt.top_m-tank.mouth)*i/64,hi=tank.mouth+(cmt.top_m-tank.mouth)*(i+1)/64;cmtQuadrature.push({z:(lo+hi)/2,volume:tank.volume(lo,hi)})}
  const oneBlock=(doc:string,name:string)=>{const a=[...doc.matchAll(new RegExp('^```'+name+'\\s*\\n([\\s\\S]*?)^```\\s*$','gm'))];if(a.length!==1)throw Error('Expected '+name);return JSON.parse(a[0]![1]!)}
  const priorText=await Bun.file(nuclearReceipt).text(),prior=JSON.parse(priorText)
  if(!prior.reference||!prior.checks.some((q:{name:string})=>q.name==='nominal cold inserted and dry screens'))throw Error('Require reviewed cold-nuclear reference receipt')
  if(!Number.isFinite(prior.reference.fuelMass_kg)||Math.abs(prior.reference.fuelMass_kg-core.geometry.fuelMass_kg)>1e-9)throw Error('Cold source reference must retain the same constructed fuel identity/mass')
  const selection=parseColdParent(docs.parent)
  const ownedNumber=(regex:RegExp)=>{const match=docs.condenser.match(regex);if(!match)throw Error('Reconcile condenser cold inventory '+regex);return Number(match[1])}
  const cwQ=ownedNumber(/combined reference flow ([\d.]+) m³\/s/),condM=ownedNumber(/m0=([\d.]+) kg\/s/)
  const lowPressure={bayVolume_m3:ownedNumber(/Initial water is \*\*([\d.]+) m³ at 20°C/),condensateReference_kg_s:condM,
    // Native site casing pressure is obtained below from the actual 5 m bay head.
    cases:[['CW.CASE.1',cwQ/2,selection.site_K,'SITE'],['CW.CASE.2',cwQ/2,selection.site_K,'SITE'],
      ['SW.CASE.A',2,selection.site_K,'SITE'],['SW.CASE.B',3,selection.site_K,'SITE'],
      ['CCW.CASE.A',.6,selection.ccw_K,'CCW'],['CCW.CASE.B',.6,selection.ccw_K,'CCW']]}
  const input={selection,base:parseInitializationBasis(docs.parent),core,mechanics,
    folded:foldedGeometry(mechanics.sgDevelopedLength_m,2.5,12,3),surge:resolveSurgeRoute(parseSurgeRoute(docs.surge)),
    prhr,prhrAudit:auditPrhrGeometry(prhr),isolation:auditPrhrIsolation(prhr,parsePrhrIsolation(docs.prhr)),cmt,cmtQuadrature,
    balance:checkBalancePath(cmt,parseBalancePathBasis(docs.cmt)).route,
    pressure:parseColdPressure(docs.pressure),nuclear:parseColdNuclear(docs.nuclear),nuclearReference:prior.reference,
    kinetics:parseSourceFeedback(docs.kinetics,docs.history),samariumWorth:oneBlock(docs.poisons,'reference-promethium-samarium').samariumWorth,
    dc:oneBlock(docs.dc,'reference-dc-actuation'),secondary:coldPreparation,vacuum:vacuumSelection,
    service:[parseServicePump(docs.feed),parseServicePump(docs.inventory)],thermal:thermalInventory(selection,docs),lowPressure}
  // The calculation receives only physical fields actually used, not unrelated
  // challenge grids, hot-reference arrays or old relief transient inputs.
  const pick=(x:Record<string,any>,keys:string[])=>Object.fromEntries(keys.map(k=>[k,x[k]]))
  const consumed={...input,base:{volumes_m3:input.base.volumes_m3},core:{activeLength_m:core.activeLength_m,geometry:{flowArea_m2:core.geometry.flowArea_m2}},
    mechanics:pick(mechanics,['downcomerBottom_m','downcomerTop_m','sgDevelopedLength_m','pumpPassageVolume_m3','coldHeaderVolume_m3','coldHeaderHeight_m']),
    folded:pick(input.folded,['radius_m','riseLength_m','crownLength_m']),
    surge:pick(input.surge,['sourceElevation_m','bendRadius_m','developedLength_m','risingStart_m','verticalStart_m','liquidVolume_m3']),
    prhr:{tubes:pick(prhr.tubes,['id_m','count','top_m','bottom_m','bendRadius_m','straightLeg_m']),hotConnector:{id_m:prhr.hotConnector.id_m}},
    prhrAudit:{headers:{water_m3:input.prhrAudit.headers.water_m3},coldConnector:{water_m3:input.prhrAudit.coldConnector.water_m3}},
    isolation:{geometry:pick(input.isolation.geometry,['closedHotConnectedWater_m3','remainingHotConnector_m','revisedPrimaryWater_m3'])},
    cmt:pick(cmt,['top_m','balanceWater_m3']),balance:pick(input.balance,['mainVolume_m3','mainLength_m','headerHorizontal_m','roofVolume_m3','feedVolume_m3','feedLength_m','bodySegments']),
    pressure:{coldPzr:input.pressure.coldPzr},nuclear:pick(input.nuclear,['fuelRange_K','waterWorth','absorberWorth_pcm_ppmEq','absorberReference_ppmEq','dopplerWorth_pcm_sqrtK','bankWorth','bankReference','xenonWorth','source']),
    nuclearReference:pick(input.nuclearReference,['waterMass_kg','Dref_sqrtK']),kinetics:{source:{generationTime_s:input.kinetics.source.generationTime_s}},
    dc:pick(input.dc,['continuousDuty_W','converterEfficiency']),
    secondary:pick(coldPreparation,['temperature_K','pressure_Pa','SG','COND','MSHEADER','knockoutVolume_m3']),vacuum:pick(vacuumSelection,['caseVolume_m3','bodyCapacity_J_K']),
    service:input.service.map(x=>pick(x,['id','inletPressure_MPa','inletTemperature_C','flow_kg_s']))}
  consumed.nuclear.source=pick(input.nuclear.source,['birthEmission_neutrons_s','couplingIntensity_per_neutron','ageAtPreparation_year','halfLife_year'])
  const serialized=JSON.stringify(consumed),proc=Bun.spawn([python,'-c',coldParentCalculation],{stdin:new Blob([serialized]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);if(code)throw Error(err)
  if(hash(await Bun.file(import.meta.path).text())!==sourceSHA256)throw Error('Cold-parent source changed during calculation')
  return {sourceSHA256,calculationSHA256:hash(coldParentCalculation),consumedInputSHA256:hash(serialized),
    consumedInput:consumed,ownerContextSHA256:Object.fromEntries(Object.entries(docs).map(([k,v])=>[paths[k as keyof typeof paths],hash(v)])),
    consumedNuclearReferenceSHA256:hash(priorText),unchangedReliefCalculationSHA256:hash(coldPressureCalculation),...JSON.parse(out)}
}
if(import.meta.main){const [wiki,prior,python,receipt,...rest]=Bun.argv.slice(2);if(!wiki||!prior||!python||rest.length)throw Error('Usage: cold-parent <ld-01> <cold-nuclear-receipt.json> <research-python> [receipt.json]');const out=await run(wiki,prior,python);if(receipt)await Bun.write(receipt,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(receipt?{receipt,checks:out.checks.length,core:out.core,expansion:out.expansion,adverse:out.adverse,thermalStores:out.thermalInventory.length}:out,null,2))}
