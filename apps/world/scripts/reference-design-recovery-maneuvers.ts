/** Offline operating-resolution coupons. No plant runtime or operating permission. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { controlledSprayBasis, heldSprayFlow } from './reference-design-controlled-spray-delivery'
import { sprayActuatorBasis } from './reference-design-pressurizer-spray-actuator'

const calculation = String.raw`
import sys,json,math
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import least_squares,brentq
x=json.load(sys.stdin)
R=296.8;cv=742.;g=9.80665;V=x['volume_m3'];A=x['hotwellArea_m2']
def state(T,Vg,mn):
 pv=P('P','T',T,'Q',1,'Water');p=pv+mn*R*T/Vg
 rl=P('D','T',T,'Q',0,'Water') if mn==0 else P('D','T',T,'P',p,'Water')
 ul=P('U','T',T,'Q',0,'Water') if mn==0 else P('U','T',T,'P',p,'Water')
 rv=P('D','T',T,'Q',1,'Water');uv=P('U','T',T,'Q',1,'Water')
 ml=(V-Vg)*rl;mv=Vg*rv;pe=g*ml*(x['floor_m']+(V-Vg)/(2*A))
 return dict(T_K=T,p_Pa=p,water_kg=ml+mv,nitrogen_kg=mn,E_J=ml*ul+mv*uv+mn*cv*(T-298.15)+pe,liquid_m3=V-Vg)
def recover(M,E,mn,start):
 def r(y):
  s=state(y[0],y[1],mn)
  return [(s['water_kg']-M)/1e6,(s['E_J']-E)/1e11]
 result=least_squares(r,start,bounds=([290.,1.],[360.,V-1.]),xtol=1e-13,ftol=1e-13,gtol=1e-13)
 s=state(*result.x,mn)
 if not result.success or abs(s['water_kg']-M)>.001 or abs(s['E_J']-E)>10:raise ValueError('Condenser coupon native recovery failed')
 return s
T0=x['initialTemperature_K'];vg=V-x['initialLiquid_m3'];h=P('H','P',x['steamPressure_Pa'],'Q',1,'Water')+g*x['inletElevation_m']
cases=[]
for name,T,mn in [('clean-reference',T0,0.),('warm-near-interlock',P('T','P',x['nearPressure_Pa'],'Q',1,'Water'),0.),('nitrogen-near-interlock',T0,(x['nearPressure_Pa']-P('P','T',T0,'Q',1,'Water'))*vg/(R*T0))]:
 before=state(T,vg,mn)
 for opening in x['openingFractions']:
  dm=opening*x['ratedFlow_kg_s']*x['exposure_s'];dE=dm*h
  after=recover(before['water_kg']+dm,before['E_J']+dE,mn,[T+.1,vg-.1])
  cases.append(dict(case=name,opening=opening,addedWater_kg=dm,addedEnergy_J=dE,before=before,after=after,interlockExceeded=bool(after['p_Pa']>=x['interlockPressure_Pa'])))
assert all(c['after']['p_Pa']>c['before']['p_Pa'] for c in cases)
assert all(not c['interlockExceeded'] for c in cases if c['case']=='clean-reference')
assert any(c['interlockExceeded'] for c in cases if c['case']!='clean-reference')
closure=[]
for name,T,mn in [('warm-working-guard',P('T','P',x['workingGuard_Pa'],'Q',1,'Water'),0.),('nitrogen-working-guard',T0,(x['workingGuard_Pa']-P('P','T',T0,'Q',1,'Water'))*vg/(R*T0))]:
 before=state(T,vg,mn);dm=x['ratedFlow_kg_s']*x['closureEquivalent_s']*x['closureFlowFactor'];after=recover(before['water_kg']+dm,before['E_J']+dm*h,mn,[T+1.,vg-1.])
 closure.append(dict(case=name,addedWater_kg=dm,addedEnergy_J=dm*h,before=before,after=after,interlockExceeded=bool(after['p_Pa']>=x['interlockPressure_Pa'])))
assert all(not c['interlockExceeded'] for c in closure)
acc=x['accumulator'];rr=P('D','T',298.15,'P',101325,'Water')
densities=[P('D','T',t,'P',p,'Water') for t in [293.15,298.15,303.15,308.15,313.15] for p in [1e5,1e6,3e6,5.04e6]]
qceiling=100*math.sqrt((acc['sourceBottomPressureCeiling_Pa']-acc['receiverPressureFloor_Pa']-2000)/1e6*acc['densityCeiling_kg_m3']/rr)
assert max(densities)<acc['densityCeiling_kg_m3'] and qceiling<acc['flowCeiling_kg_s']
assert acc['flowCeiling_kg_s']*acc['responseAllowance_s']==acc['additionalReserve_kg']
accCases=[]
for name,vl,ps,pd in [('original-reserve',35.,5.04e6,1e6),('low-reserve',3.,5.04e6,1e6),('seated-check',35.,5.04e6,6e6)]:
 rho=P('D','T',298.15,'P',ps,'Water');q=100*math.sqrt(max(0,ps-pd-2000)/1e6*rho/rr)
 margin=(vl-2)*rho-acc['additionalReserve_kg']
 accCases.append(dict(case=name,liquid_m3=vl,liquidDensity_kg_m3=rho,flow_kg_s=q,reserveMargin_kg=margin,reserveAdmitted=margin>0,forwardDelivery=q>0))
assert accCases[0]['reserveAdmitted'] and accCases[0]['forwardDelivery']
assert not accCases[1]['reserveAdmitted'] and not accCases[2]['forwardDelivery']
y=x['portable'];pa=y['pressure_Pa'];tp=y['temperature_K'];gp=y['gravity_m_s2'];rp=P('D','T',tp,'P',pa,'Water')
def surface(volume,area,floor):return floor+volume/area
def hose_head(source_surface,recipient_surface,mouth):
 # Covered recipient supports reciprocal liquid flow; uncovered reverse would require gas, not fictitious water.
 return source_surface-max(mouth,recipient_surface)
def frozen_flow(head):return math.copysign(rp*y['hoseCdA_m2']*math.sqrt(2*gp*abs(head)),head) if head else 0.
ws=surface(y['waterVolume_m3'],y['waterArea_m2'],y['tankFloor_m'])
ss=surface(y['supplyVolume_m3'],y['portableArea_m2'],y['supplyFloor_m'])
supply_head=hose_head(ss,ws,y['supplyMouth_m'])
rs=surface(y['receiverVolume_m3'],y['receiverArea_m2'],y['tankFloor_m'])
# Same-temperature, incompressible hydraulic screen only, independently checked by an event root.
veq=(rs-y['removalFloor_m'])/(1/y['receiverArea_m2']+1/y['portableArea_m2'])
def removal_head(v):return hose_head(surface(y['receiverVolume_m3']-v,y['receiverArea_m2'],y['tankFloor_m']),surface(v,y['portableArea_m2'],y['removalFloor_m']),y['removalMouth_m'])
root=brentq(removal_head,0,y['portableArea_m2']*y['portableHeight_m'])
assert abs(root-veq)<1e-10 and 0<veq<y['portableArea_m2']*4
assert removal_head(veq-1)>0 and removal_head(veq+1)<0
def pool(m,T,area,floor,marker):
 rho=P('D','T',T,'P',pa,'Water');v=m/rho;z=surface(v,area,floor)
 return dict(M=m,T=T,area=area,floor=floor,V=v,z=z,E=m*P('H','T',T,'P',pa,'Water')+gp*m*(floor+v/(2*area)),marker=marker,Ht=P('H','T',T,'P',pa,'Water')+gp*z)
def retained(m,e,area,floor,marker):
 T=brentq(lambda T:pool(m,T,area,floor,marker)['E']-e,273.16,373.0,xtol=1e-11)
 return pool(m,T,area,floor,marker)
def packet(d,r,dm):
 assert 0<dm<d['M']
 de=dm*d['Ht'];dt=dm*d['marker']/d['M']
 da=retained(d['M']-dm,d['E']-de,d['area'],d['floor'],d['marker']-dt)
 ra=retained(r['M']+dm,r['E']+de,r['area'],r['floor'],r['marker']+dt)
 defects={key:da[key]+ra[key]-d[key]-r[key] for key in ['M','E','marker']}
 assert abs(defects['M'])<1e-6 and abs(defects['E'])<1e-12*(abs(d['E'])+abs(r['E'])) and abs(defects['marker'])<1e-9,defects
 return dict(before=[d,r],after=[da,ra],defects=defects)
donor=pool(rp*y['supplyVolume_m3'],tp,y['portableArea_m2'],y['supplyFloor_m'],rp*y['supplyVolume_m3']*y['supplyMarker_ppm']/1e6)
recipient=pool(rp*y['waterVolume_m3'],tp,y['waterArea_m2'],y['tankFloor_m'],rp*y['waterVolume_m3']*y['recipientMarker_ppm']/1e6)
mix=packet(donor,recipient,y['parcel_kg'])
assert mix['after'][1]['marker']>mix['before'][1]['marker'] # Wrong concentrate entering WATER stays wrong.
crest=y['removalFloor_m']+y['portableHeight_m']
def spill(p,c):
 hi=max(p,c);lo=min(p,c);v=y['weirCoefficient']*y['overflowWidth_m']*max(0,hi-max(crest,lo))**1.5
 return math.copysign(v,p-c) if p!=c else 0.
overflow=spill(crest+.01,0);backwater=spill(crest+.01,crest+.10)
assert overflow>0 and backwater<0 and spill(crest,0)==0
overdonor=pool(rp*y['portableArea_m2']*(y['portableHeight_m']+.01),tp,y['portableArea_m2'],y['removalFloor_m'],1.)
collection=pool(rp*.1,tp,y['collectionArea_m2'],y['collectionFloor_m'],0.)
overflow_packet=packet(overdonor,collection,min(y['parcel_kg'],rp*overflow))
sp=x['spray'];b=sp['geometry'];pr=sp['receiverPressure_Pa'];hs=sp['sourceEnthalpy_J_kg']
assert abs(P('H','P',sp['sourcePressure_Pa'],'T',sp['sourceTemperature_K'],'Water')-hs)<.01
assert abs(P('D','P',sp['sourcePressure_Pa'],'T',sp['sourceTemperature_K'],'Water')-sp['sourceDensity_kg_m3'])<1e-5
hf=P('H','P',pr,'Q',0,'Water');hg=P('H','P',pr,'Q',1,'Water')
thermal_per_kg=hf-(hs+g*(b['sourceElevation_m']-b['nozzleElevation_m']))
assert thermal_per_kg>0
line_mass=sp['sourceDensity_kg_m3']*math.pi*b['diameter_m']**2/4*b['length_m']
for c in sp['cases']:
 q=c['flow_kg_s'];c['idealHeatAbsorption_W']=q*thermal_per_kg;c['idealCondensationScale_kg_s']=q*thermal_per_kg/(hg-hf)
 c['heatScaleMinusOpposingHeater_W']=q*thermal_per_kg-sp['opposingHeater_W']
 c['lineInventoryAtHeldDensity_kg']=line_mass;c['inventoryOverFlow_s']=line_mass/q if q>0 else None
 c['healthyOpeningTravel_s']=c['opening']/sp['actuatorRate_per_s']
assert sp['cases'][1]['flow_kg_s']>0 and sp['cases'][1]['heatScaleMinusOpposingHeater_W']<0
assert sp['contrary']['flow_kg_s']==0
print(json.dumps(dict(meaning='Finite steam/open-pool packets, restricted hydraulic algebra and ideal spray heat-capacity scales; no current two-temperature PZR pressure advance or coupled plant transient. Response allowances are not achieved timing.',versions=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__),steamTotalEnthalpy_J_kg=h,cases=cases,closure=closure,accumulator=dict(sampledDensityMax_kg_m3=max(densities),referenceDensity_kg_m3=rr,derivedFlowCeiling_kg_s=qceiling,cases=accCases),spray=sp,portable=dict(initialSupplyHead_m=supply_head,initialSupplyFlow_kg_s=frozen_flow(supply_head),removalEquilibrium_m3=veq,independentEquilibrium_m3=root,beforeEquilibriumFlow_kg_s=frozen_flow(removal_head(veq-1)),afterEquilibriumFlow_kg_s=frozen_flow(removal_head(veq+1)),wrongDonorPacket=mix,overflowFlow_m3_s=overflow,backwaterFlow_m3_s=backwater,overflowPacket=overflow_packet))))
`

if (import.meta.main) {
  const [ownerPath, python, ...extra] = process.argv.slice(2)
  if (!ownerPath || !python || extra.length) throw new Error('Usage: recovery-maneuvers <procedure-decision-basis.md> <research-python>')
  const source = readFileSync(ownerPath, 'utf8')
  const block = source.match(/```reference-recovery-maneuver\s*\n([\s\S]*?)\n```/)
  if (!block) throw new Error('Missing reference-recovery-maneuver inputs')
  const input = JSON.parse(block[1]!)
  const portablePath = resolve(dirname(ownerPath), '../systems/primary-coolant/inventory-and-chemistry.md')
  const portableSource = readFileSync(portablePath, 'utf8')
  const portableBlock = portableSource.match(/```reference-portable-transfer\s*\n([\s\S]*?)\n```/)
  if (!portableBlock) throw new Error('Missing reference-portable-transfer inputs')
  input.portable = JSON.parse(portableBlock[1]!)
  const sprayBlock = source.match(/```reference-spray-operating-scale\s*\n([\s\S]*?)\n```/)
  if (!sprayBlock) throw new Error('Missing reference-spray-operating-scale inputs')
  const spray = JSON.parse(sprayBlock[1]!)
  const held = { density: spray.sourceDensity_kg_m3, viscosity: spray.sourceViscosity_Pa_s, sourcePressure: spray.sourcePressure_Pa, receiverPressure: spray.receiverPressure_Pa, activeTips: controlledSprayBasis.tips }
  input.spray = { ...spray, geometry: controlledSprayBasis, actuatorRate_per_s: sprayActuatorBasis.controlledRate_per_s,
    cases: spray.openings.map((opening: number) => ({opening, ...heldSprayFlow({...held, opening})})),
    contrary: heldSprayFlow({...held, sourcePressure: held.sourcePressure + spray.contraryPressureShift_Pa, opening: 1}) }
  const result = spawnSync(python, ['-c', calculation], { input: JSON.stringify(input), encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'Recovery coupon failed')
  const calculationSources = [import.meta.path, resolve(import.meta.dir, 'reference-design-controlled-spray-delivery.ts'), resolve(import.meta.dir, 'reference-design-pressurizer-spray-actuator.ts'), resolve(import.meta.dir, 'reference-design-surge-route.ts')]
    .map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
  console.log(JSON.stringify({ ownerSha256: createHash('sha256').update(source).digest('hex'), portableOwnerSha256: createHash('sha256').update(portableSource).digest('hex'), calculationSources, ...JSON.parse(result.stdout) }, null, 2))
}
